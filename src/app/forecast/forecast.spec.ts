import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { Forecast } from './forecast';
import { ApiService, Resource, ResourceRequest, Assignment, AssignmentDay, AssignmentMonth } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { todayLocalIso } from '../services/local-date.util';
import { CapacityPeriod } from '../services/forecast.util';

/**
 * `/forecast`'s bench section is now `notFullyAllocatedAt` (bench.util.ts), fed
 * by THIS month's raw day/month data — not the retired `benchList`/`Resource.
 * utilization` heuristic. The fixture below is built against "today"'s actual
 * calendar month (via the same `todayLocalIso()` the component itself calls,
 * un-mockable at the call site) so it stays correct on any run date:
 *   - 'full'    booked 999h this month (>> any standard monthly hours) -> ALLOCATED, excluded
 *   - 'idle'    no booking at all -> BENCH
 *   - 'idle2'   no booking at all -> BENCH (a SECOND idle resource, deliberately —
 *               with exactly one idle + one partial, swapping the idle/partial
 *               filter in `benchIdleCount`/`benchPartialCount` would still produce
 *               "1 idle, 1 partial" and no test would notice; 2-vs-1 makes the
 *               two counts asymmetric so a swapped filter is visibly wrong)
 *   - 'partial' booked 10h this month (> 0, well under standard) -> PARTIAL
 */
const CURRENT_MONTH = todayLocalIso().slice(0, 7);

const RESOURCES: Resource[] = [
  { id: 'full', name: 'Fully Booked', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: 'idle', name: 'Idle Person', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: 'idle2', name: 'Also Idle', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: 'partial', name: 'Partly Booked', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
];
const ASSIGNMENTS: Assignment[] = [
  { id: 'a-full', requestId: 'r-full', resourceId: 'full', assignedHours: 999, status: 'Allocated' },
  { id: 'a-partial', requestId: 'r-partial', resourceId: 'partial', assignedHours: 10, status: 'Allocated' },
];
const ASSIGNMENT_DAYS: AssignmentDay[] = [
  { id: 'd-full', assignmentId: 'a-full', date: `${CURRENT_MONTH}-03`, hours: 999 },
  { id: 'd-partial', assignmentId: 'a-partial', date: `${CURRENT_MONTH}-03`, hours: 10 },
];
const ASSIGNMENT_MONTHS: AssignmentMonth[] = [
  { id: `a-full:${CURRENT_MONTH}`, assignmentId: 'a-full', month: CURRENT_MONTH, status: 'Allocated' },
  { id: `a-partial:${CURRENT_MONTH}`, assignmentId: 'a-partial', month: CURRENT_MONTH, status: 'Allocated' },
];

function apiStub(overrides: Partial<ApiService> = {}): ApiService {
  return {
    getResources: () => of(RESOURCES),
    getRequests: () => of([]),
    getAssignments: () => of(ASSIGNMENTS),
    getAssignmentDays: () => of(ASSIGNMENT_DAYS),
    getAssignmentMonths: () => of(ASSIGNMENT_MONTHS),
    getHolidays: () => of([]),
    getHoursPerDay: () => of({ value: 8 }),
    ...overrides,
  } as unknown as ApiService;
}

/**
 * TODAY, taken from the same `todayLocalIso()` the component calls (the horizon
 * anchor is not injectable here). Every window below is expressed as an OFFSET
 * from it, so no expectation depends on the run date or on the CI time zone —
 * the date-dependent-green trap this project has already paid for.
 */
const TODAY = todayLocalIso();

/** Shift an ISO day by whole days, treating it as a UTC instant (TZ-stable). */
function isoPlusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

async function setup(overrides: Partial<ApiService> = {}, ready = true) {
  TestBed.configureTestingModule({
    imports: [Forecast],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: apiStub(overrides) },
      { provide: AuthService, useValue: { authReady: signal(ready) } },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(Forecast);
  return fixture;
}

async function flush(fixture: ComponentFixture<Forecast>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function host(fixture: ComponentFixture<Forecast>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

describe('Forecast — bench retargeted onto bench.util (retired benchList/BenchEntry)', () => {
  it('excludes the fully-booked resource, includes the idle and partial ones, and splits idle vs partial correctly', async () => {
    const fixture = await setup();
    await flush(fixture);

    const c = fixture.componentInstance;
    // Presence: idle + partial both surface.
    expect(c.bench().some(r => r.resourceId === 'idle')).toBe(true);
    expect(c.bench().some(r => r.resourceId === 'partial')).toBe(true);
    // Absence: the ALLOCATED resource must NOT appear — this is the whole point
    // of switching off `Resource.utilization` (a scalar that can't tell "booked
    // this month" from "booked at all") onto the monthly bench.util classifier.
    expect(c.bench().some(r => r.resourceId === 'full')).toBe(false);

    expect(c.benchCount()).toBe(3);
    // 2 idle vs 1 partial — DELIBERATELY asymmetric (see the fixture comment):
    // a filter swapped between the two buckets changes both numbers, so this
    // pair can't both stay green under that mutation the way a symmetric
    // 1-vs-1 fixture would.
    expect(c.benchIdleCount()).toBe(2);
    expect(c.benchPartialCount()).toBe(1);

    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Idle Person');
    expect(text).toContain('Also Idle');
    expect(text).toContain('Partly Booked');
    expect(text).not.toContain('Fully Booked');
  });

  it('fetches through the four new raw endpoints (assignment-days, assignment-months, holidays, hours-per-day) the bench figure depends on', async () => {
    const getAssignmentDays = vi.fn(() => of(ASSIGNMENT_DAYS));
    const getAssignmentMonths = vi.fn(() => of(ASSIGNMENT_MONTHS));
    const getHolidays = vi.fn(() => of([]));
    const getHoursPerDay = vi.fn(() => of({ value: 8 }));
    const fixture = await setup({ getAssignmentDays, getAssignmentMonths, getHolidays, getHoursPerDay });
    await flush(fixture);

    expect(getAssignmentDays).toHaveBeenCalled();
    expect(getAssignmentMonths).toHaveBeenCalled();
    expect(getHolidays).toHaveBeenCalled();
    expect(getHoursPerDay).toHaveBeenCalled();
  });

  it('renders the retired BenchEntry shape nowhere: no Role/Util %/Available column, only Kind/Status', async () => {
    const fixture = await setup();
    await flush(fixture);

    // Scoped to the Bench card specifically — an earlier version of this test
    // queried '.command-card th' unscoped, which also collects the untouched
    // Skill Gap table's own <th>Status</th> (forecast.ts's Skill Gap section).
    // Both tables render a "Status" header, so an unscoped query passes even
    // if the Bench table's own Status column is deleted outright: the
    // assertion would still be satisfied by Skill Gap's. Scoping to the card
    // whose <h2> reads "Bench" makes the check actually about Bench.
    const benchSection = Array.from(host(fixture).querySelectorAll('.command-card'))
      .find(card => card.querySelector('h2')?.textContent?.trim() === 'Bench');
    expect(benchSection).toBeTruthy();
    const headers = Array.from(benchSection!.querySelectorAll('th')).map(th => th.textContent?.trim());
    expect(headers).toEqual(['Resource', 'Kind', 'Status']);
    // Paired absence: the retired BenchEntry-shaped columns must be gone from
    // THIS table (redundant with the exact toEqual above, kept explicit).
    expect(headers).not.toContain('Available');
    expect(headers).not.toContain('Role');
  });
});

describe('Forecast — failed read renders as an error state, never a confident empty/zero', () => {
  it('shows a retry affordance instead of the empty-state copy when the read fails', async () => {
    const fixture = await setup({ getResources: () => throwError(() => new Error('boom')) as unknown as Observable<Resource[]> });
    await flush(fixture);

    // The shared ListStateComponent (app-list-state) renders its error panel
    // with role="alert" — the accessible signal a screen-reader announces,
    // which the previous hand-rolled card did not carry.
    const alert = host(fixture).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't load forecast data");
    // Absence: the ordinary "no forecast data yet" empty copy must NOT also render —
    // an error must never be presented as a benign "nothing here" state.
    expect(host(fixture).textContent).not.toContain('No forecast data yet');
    expect(alert?.querySelector('button')).toBeTruthy();
  });

  it('the retry button actually calls reload — a dead button would leave a user stuck on a failed read forever', async () => {
    const getResources = vi.fn(() => throwError(() => new Error('boom')) as unknown as Observable<Resource[]>);
    const fixture = await setup({ getResources });
    await flush(fixture);
    const callsBeforeRetry = getResources.mock.calls.length;

    const retryButton = host(fixture).querySelector('[role="alert"] button') as HTMLButtonElement;
    retryButton.click();
    await flush(fixture);

    expect(getResources.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });
});

describe('Forecast — authReady gating', () => {
  it('does not fetch and shows no bench rows until auth settles', async () => {
    const getResources = vi.fn(() => of(RESOURCES));
    const fixture = await setup({ getResources }, false);
    await flush(fixture);

    expect(getResources).not.toHaveBeenCalled();
    expect(fixture.componentInstance.bench()).toEqual([]);
  });
});

// =============================================================================
// Helpers for the capacity-side suites below (bands, CSV rounding, employment).
// =============================================================================

/** The `.command-kpi` tile whose label reads `label`. */
function kpiTile(fixture: ComponentFixture<Forecast>, label: string): HTMLElement {
  const tile = Array.from(host(fixture).querySelectorAll<HTMLElement>('.command-kpi')).find(
    el => el.querySelector('.command-kpi-label')?.textContent?.trim() === label,
  );
  expect(tile, `KPI tile not found: ${label}`).toBeTruthy();
  return tile!;
}

function kpiValue(tile: HTMLElement): string {
  return tile.querySelector('.command-kpi-value')?.textContent?.trim() ?? '';
}

/** The Util % pills of the Supply vs Demand Timeline table, in row order. */
function utilPills(fixture: ComponentFixture<Forecast>): HTMLElement[] {
  const section = Array.from(host(fixture).querySelectorAll('.command-card')).find(
    card => card.querySelector('h2')?.textContent?.trim() === 'Supply vs Demand Timeline',
  );
  expect(section, 'timeline section not found').toBeTruthy();
  return Array.from(section!.querySelectorAll<HTMLElement>('tbody tr td:nth-child(4) .command-status'));
}

/**
 * A forecast whose only demand is ONE open request spanning the entire 8-week
 * horizon, so every period carries exactly `effort / 8` hours and the average
 * utilisation is an exact, run-date-independent figure: `effort / 8 / capacity`.
 */
function evenDemandStub(capacity: number, effort: number, overrides: Partial<ApiService> = {}): Partial<ApiService> {
  const resources: Resource[] = [
    { id: 'r1', name: 'Solo Dev', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity, kind: 'internal' },
  ];
  const requests: ResourceRequest[] = [
    { id: 'req1', name: 'Steady demand', requiredRole: 'Developer', requiredEffort: effort, status: 'Open', skills: [], startDate: TODAY, endDate: isoPlusDays(TODAY, 56) },
  ];
  return {
    getResources: () => of(resources),
    getRequests: () => of(requests),
    getAssignments: () => of([]),
    getAssignmentDays: () => of([]),
    getAssignmentMonths: () => of([]),
    ...overrides,
  } as Partial<ApiService>;
}

/**
 * /forecast and /what-if used to encode two different opinions of a healthy
 * week: below 85% was GREEN here (and scored 'bad' on /what-if), so one 45%
 * average was a healthy state on one screen and a crisis on the other, while a
 * fully-sold 90% was amber here and healthy there.
 */
describe('Forecast — the utilisation band agrees with the repo semaphore, not a second ladder', () => {
  it('does not paint a 45% average with the healthy tone', async () => {
    // 360h over 8 weeks = 45h/week against 100h/week of supply.
    const fixture = await setup(evenDemandStub(100, 360));
    await flush(fixture);

    const tile = kpiTile(fixture, 'Avg Utilization');
    expect(kpiValue(tile)).toBe('45%');
    // The assertion of ABSENCE: 45% is unsold capacity, and green here is what
    // told a delivery executive the trough was fine.
    expect(tile.classList.contains('green')).toBe(false);
    // ...and it is not toneless either — below-healthy is a caution.
    expect(tile.classList.contains('warning')).toBe(true);
    // Every per-week pill inherits the same band, so the table cannot disagree
    // with the KPI above it.
    const pills = utilPills(fixture);
    expect(pills.length).toBe(8);
    expect(pills.every(p => p.classList.contains('amber'))).toBe(true);
    expect(pills.some(p => p.classList.contains('green'))).toBe(false);
  });

  it('still paints a fully-sold 90% average as healthy — the paired positive', async () => {
    // 720h over 8 weeks = 90h/week against 100h/week of supply.
    const fixture = await setup(evenDemandStub(100, 720));
    await flush(fixture);

    const tile = kpiTile(fixture, 'Avg Utilization');
    expect(kpiValue(tile)).toBe('90%');
    // Presence at the other end of the band: neither "delete green" nor "paint
    // everything amber" can satisfy this together with the 45% case above.
    expect(tile.classList.contains('green')).toBe(true);
    expect(tile.classList.contains('warning')).toBe(false);
    expect(tile.classList.contains('danger')).toBe(false);
    expect(utilPills(fixture).every(p => p.classList.contains('green'))).toBe(true);
  });
});

/**
 * Withheld is not zero. Once supply became per-period (employment-gated), a
 * period can legitimately have no capacity — and a 0% there would be painted as
 * spare capacity, folded into the average, and written to the CSV as if it were
 * a genuinely idle week.
 */
describe('Forecast — a period with no capacity renders as unavailable, never as 0%', () => {
  /** One resource who joins long after the 8-week horizon ends. */
  function futureHireStub(): Partial<ApiService> {
    const resources: Resource[] = [
      { id: 'later', name: 'Not Yet Joined', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', hireDate: isoPlusDays(TODAY, 365) },
    ];
    const requests: ResourceRequest[] = [
      { id: 'req1', name: 'Real demand', requiredRole: 'Developer', requiredEffort: 80, status: 'Open', skills: [], startDate: TODAY, endDate: isoPlusDays(TODAY, 56) },
    ];
    return {
      getResources: () => of(resources),
      getRequests: () => of(requests),
      getAssignments: () => of([]),
      getAssignmentDays: () => of([]),
      getAssignmentMonths: () => of([]),
    } as Partial<ApiService>;
  }

  it('renders "n/a" with no tone on the KPI, the table pill and the CSV — not a green 0%', async () => {
    const fixture = await setup(futureHireStub());
    await flush(fixture);

    const tile = kpiTile(fixture, 'Avg Utilization');
    expect(kpiValue(tile)).toBe('n/a');
    // Absence of the fabricated figure AND of every tone: an unmeasurable
    // average must make no claim at all.
    expect(kpiValue(tile)).not.toBe('0%');
    expect(tile.classList.contains('green')).toBe(false);
    expect(tile.classList.contains('warning')).toBe(false);
    expect(tile.classList.contains('danger')).toBe(false);
    expect(tile.textContent).toContain('No capacity in the horizon to measure against');

    const pills = utilPills(fixture);
    expect(pills.length).toBe(8);
    expect(pills.every(p => p.textContent?.trim() === 'n/a')).toBe(true);
    // NOT a substring check: '0%' is a substring of '100%', the exact trap this
    // repo has already been bitten by.
    expect(pills.some(p => p.textContent?.trim() === '0%')).toBe(false);
    expect(pills.some(p => p.classList.contains('green') || p.classList.contains('amber') || p.classList.contains('red'))).toBe(false);

    // The export says the same thing as the screen.
    const csvRows = fixture.componentInstance['buildTimelineCsv']().split('\r\n').slice(1);
    expect(csvRows.length).toBe(8);
    expect(csvRows.every(line => line.split(',')[5] === 'n/a')).toBe(true);

    // The trend chart cannot plot a null, so it is omitted and says which weeks
    // are missing rather than drawing a flat zero line.
    expect(host(fixture).querySelector('command-trend-chart')).toBeNull();
    expect(host(fixture).textContent).toContain('No utilization for 8 weeks');
  });

  it('still reports a real 0% when the capacity exists and nothing is booked — the paired positive', async () => {
    // Same shape, but the resource is employed: 0% here is a measurement, not a
    // gap, so "render n/a whenever it is 0" would fail this half.
    const fixture = await setup(evenDemandStub(100, 0));
    await flush(fixture);

    const tile = kpiTile(fixture, 'Avg Utilization');
    expect(kpiValue(tile)).toBe('0%');
    expect(kpiValue(tile)).not.toBe('n/a');
    expect(utilPills(fixture).every(p => p.textContent?.trim() === '0%')).toBe(true);
    expect(host(fixture).querySelector('command-trend-chart')).not.toBeNull();
  });

  it('drops the unmeasurable weeks from the trend chart instead of plotting them as zero', async () => {
    // A leaver whose last day is TODAY: every period whose start falls in the
    // current month still has her capacity, every later-month period has none.
    // The split point depends on the run date, so the assertions below are about
    // the INVARIANT (some measured, some not, axes index-aligned) rather than a
    // fixed count — an 8-week horizon from today always crosses a month boundary.
    const fixture = await setup(evenDemandStub(100, 400, {
      getResources: () => of([
        { id: 'leaver', name: 'Leaving Today', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 100, kind: 'internal', terminationDate: TODAY },
      ] as Resource[]),
    }));
    await flush(fixture);

    const c = fixture.componentInstance;
    const measured = c.measuredWeekLabels();
    const unmeasured = c.unmeasuredWeekLabels();
    // Precondition: the fixture really is MIXED. Without this the test would be
    // satisfied by an all-measured horizon and prove nothing about the coercion.
    expect(measured.length).toBeGreaterThan(0);
    expect(unmeasured.length).toBeGreaterThan(0);
    expect(measured.length + unmeasured.length).toBe(8);

    // TrendSeries takes plain numbers, so the axes must drop the same weeks
    // together. A series padded with 0 for the unmeasurable weeks would be
    // longer than its own category axis — silently mislabelling every point.
    const series = c.utilizationSeries();
    expect(series[0].values.length).toBe(measured.length);
    expect(series[1].values.length).toBe(measured.length);
    // Absence of the fabricated point: no plotted value may come from a period
    // that has no utilisation.
    const plottedFromNull = c.periodRows()
      .filter(r => r.utilizationPct === null)
      .filter(r => measured.includes(r.label));
    expect(plottedFromNull).toEqual([]);

    // The chart still renders (there ARE measurable weeks) and the omission is
    // stated rather than hidden.
    expect(host(fixture).querySelector('command-trend-chart')).not.toBeNull();
    expect(host(fixture).textContent).toContain(`No utilization for ${unmeasured.length} week`);
    // ...and the table still lists all 8 weeks, the unmeasurable ones as n/a.
    const pills = utilPills(fixture);
    expect(pills.length).toBe(8);
    expect(pills.filter(p => p.textContent?.trim() === 'n/a').length).toBe(unmeasured.length);
  });
});

/**
 * The bench headcount is unbillable capacity. /forecast painted it with the
 * static `green` class — so bench 0 and bench 14 rendered byte-identically
 * healthy — while /bench showed the same metric in the critical tone.
 */
describe('Forecast — the bench headcount is not painted as health', () => {
  it('does not carry the healthy tone while people are on the bench', async () => {
    // Default fixture: 2 idle + 1 partial (see the fixture comment at the top).
    const fixture = await setup();
    await flush(fixture);

    const tile = kpiTile(fixture, 'On Bench');
    expect(kpiValue(tile)).toBe('3');
    // ABSENCE — this is the assertion a regression flips, since the class used
    // to be static and unconditional.
    expect(tile.classList.contains('green')).toBe(false);
    expect(tile.classList.contains('danger')).toBe(true);

    // The Bench card's own chip must say the same thing as the KPI.
    const chip = Array.from(host(fixture).querySelectorAll('.command-card'))
      .find(card => card.querySelector('h2')?.textContent?.trim() === 'Bench')!
      .querySelector<HTMLElement>('.command-card-header .command-status')!;
    expect(chip.textContent?.trim()).toBe('3');
    expect(chip.classList.contains('green')).toBe(false);
    expect(chip.classList.contains('red')).toBe(true);
  });

  it('carries the healthy tone only for an EMPTY bench — same element, opposite state', async () => {
    // Only the fully-booked resource, so nobody is under-allocated. The two
    // halves differ on one element present in both, so a stub that rendered no
    // tile at all would fail both.
    const fixture = await setup({
      getResources: () => of(RESOURCES.filter(r => r.id === 'full')),
    });
    await flush(fixture);

    const tile = kpiTile(fixture, 'On Bench');
    expect(kpiValue(tile)).toBe('0');
    expect(tile.classList.contains('green')).toBe(true);
    expect(tile.classList.contains('danger')).toBe(false);
    expect(tile.classList.contains('warning')).toBe(false);
  });

  it('carries the caution tone when the bench is only partially allocated, never idle', async () => {
    const fixture = await setup({
      getResources: () => of(RESOURCES.filter(r => r.id === 'full' || r.id === 'partial')),
    });
    await flush(fixture);

    const tile = kpiTile(fixture, 'On Bench');
    expect(kpiValue(tile)).toBe('1');
    expect(tile.classList.contains('warning')).toBe(true);
    // Mutually exclusive by construction: .command-kpi.green is declared after
    // .danger/.warning in styles.css, so an overlap would let the cascade decide.
    expect(tile.classList.contains('green')).toBe(false);
    expect(tile.classList.contains('danger')).toBe(false);
  });
});

/**
 * The capacity-timeline CSV wrote raw `overlapFraction` products — Committed
 * 83.48936835522201, Gap 196.510631644778 — in five of its seven columns, while
 * the screen showed 83 and 197.
 */
describe('Forecast — the timeline CSV obeys the 2-decimal rule', () => {
  /** Exactly the figures from the finding, so the fixture provably needs rounding. */
  const RAW: CapacityPeriod = {
    period: '2026-08-06',
    supply: 320,
    committed: 83.48936835522201,
    pipeline: 0,
    demand: 123.48936835522201,
    utilizationPct: 38.59042761100688,
    gap: -196.510631644778,
  };

  it('rounds every hour column to 2 decimals and leaves the negative Gap summable', async () => {
    const fixture = await setup();
    await flush(fixture);

    // The fixture is proven to EXERCISE rounding rather than being pre-clean —
    // without this, the test would pass on an already-integral period.
    expect(String(RAW.committed)).toMatch(/\.\d{3,}/);
    expect(String(RAW.gap)).toMatch(/\.\d{3,}/);

    const csv = fixture.componentInstance['buildTimelineCsv']([RAW]);
    const row = csv.split('\r\n')[1];
    expect(row).toBe('2026-08-06,320,83.49,0,123.49,38.59,-196.51');

    // Absence #1: no cell anywhere may carry 3+ decimals. A presence check alone
    // would also pass if a column were dropped or emitted empty.
    expect(csv).not.toMatch(/,-?\d+\.\d{3,}(,|$)/m);
    // Absence #2: the negative Gap must NOT be quote-prefixed into a text label.
    // This is what ties the rounding to the CSV-injection guard — a `.toFixed(2)`
    // rounding hands escapeCsv a string, and the moment its numeric-cell
    // exemption changes, `=SUM` over the over-capacity weeks silently skips them.
    expect(csv).not.toContain("'-196.51");
  });

  it('rounds the figures the component itself produces, not only the ones handed to the helper', async () => {
    // 100 confirmed hours over a 13-day request window: period 0 takes 7/13 of
    // them = 53.846153846..., the finding's own repeating fraction.
    const resources: Resource[] = [
      { id: 'r1', name: 'Solo Dev', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
    ];
    const fixture = await setup({
      getResources: () => of(resources),
      getRequests: () => of([
        { id: 'req1', name: 'Short window', requiredRole: 'Developer', requiredEffort: 0, status: 'Open', skills: [], startDate: TODAY, endDate: isoPlusDays(TODAY, 13) },
      ] as ResourceRequest[]),
      getAssignments: () => of([{ id: 'a1', requestId: 'req1', resourceId: 'r1', assignedHours: 100, status: 'Allocated' }] as Assignment[]),
      getAssignmentDays: () => of([{ id: 'd1', assignmentId: 'a1', date: `${CURRENT_MONTH}-03`, hours: 100 }] as AssignmentDay[]),
      getAssignmentMonths: () => of([{ id: `a1:${CURRENT_MONTH}`, assignmentId: 'a1', month: CURRENT_MONTH, status: 'Allocated' }] as AssignmentMonth[]),
    });
    await flush(fixture);

    const periods = fixture.componentInstance['periods']();
    // Precondition: the live figure really is a 14-decimal float.
    expect(String(periods[0].committed)).toMatch(/\.\d{3,}/);

    const csv = fixture.componentInstance['buildTimelineCsv']();
    expect(csv).toContain(',53.85,');
    expect(csv).not.toMatch(/,-?\d+\.\d{3,}(,|$)/m);
  });

  it('rounds the skill-gap CSV demand hours too — the second raw-float column on the same screen', async () => {
    const fixture = await setup();
    await flush(fixture);

    const csv = fixture.componentInstance['buildSkillGapCsv']([
      { skill: 'Java', demandCount: 3, demandHours: 40.400000000000006, supplyCount: 0, shortage: true },
    ]);
    expect(csv.split('\r\n')[1]).toBe('Java,40.4,0,true');
    expect(csv).not.toMatch(/,-?\d+\.\d{3,}(,|$)/m);
  });
});

/**
 * Supply and skill coverage must count only people who actually work here. The
 * KPI advertised a departed colleague's 40h/week of capacity that the API
 * refuses to book, while the Bench table on the same page already excluded her.
 */
describe('Forecast — employment gates supply and skill coverage', () => {
  function withLeaverStub(): Partial<ApiService> {
    const resources: Resource[] = [
      { id: 'here', name: 'Still Here', role: 'Developer', skills: [{ name: 'Angular', level: 3 }], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
      { id: 'gone', name: 'Long Gone', role: 'Developer', skills: [{ name: 'Java', level: 4 }], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', terminationDate: isoPlusDays(TODAY, -140) },
    ];
    const requests: ResourceRequest[] = [
      { id: 'req1', name: 'Needs both', requiredRole: 'Developer', requiredEffort: 80, status: 'Open', skills: ['Java', 'Angular'], startDate: TODAY, endDate: isoPlusDays(TODAY, 56) },
    ];
    return {
      getResources: () => of(resources),
      getRequests: () => of(requests),
      getAssignments: () => of([]),
      getAssignmentDays: () => of([]),
      getAssignmentMonths: () => of([]),
    } as Partial<ApiService>;
  }

  it('leaves a departed colleague out of Total Supply and out of skill coverage', async () => {
    const fixture = await setup(withLeaverStub());
    await flush(fixture);

    // 40, not 80: only the employed resource's capacity is deliverable.
    expect(kpiValue(kpiTile(fixture, 'Total Supply'))).toBe('40');
    expect(kpiValue(kpiTile(fixture, 'Total Supply'))).not.toBe('80');

    const skillSection = Array.from(host(fixture).querySelectorAll('.command-card')).find(
      card => card.querySelector('h2')?.textContent?.trim() === 'Skill Gap',
    )!;
    const rowFor = (skill: string) =>
      Array.from(skillSection.querySelectorAll('tbody tr')).find(
        tr => tr.querySelector('td')?.textContent?.trim() === skill,
      )!;

    // PRESENCE of the shortage the inflated count suppressed: the only Java
    // holder has left, so this reads "No coverage", not "Covered".
    const java = rowFor('Java');
    expect(java.querySelectorAll('td')[3].textContent?.trim()).toBe('0');
    expect(java.querySelector('.command-status')?.textContent?.trim()).toBe('No coverage');
    // PRESENCE twin: an employed holder still counts, so this fix cannot be
    // "stop counting skills" — and it proves /forecast threads a month at all.
    const angular = rowFor('Angular');
    expect(angular.querySelectorAll('td')[3].textContent?.trim()).toBe('1');
    expect(angular.querySelector('.command-status')?.textContent?.trim()).toBe('Covered');
  });
});

// -----------------------------------------------------------------------------
// Source-text + token arithmetic. jsdom performs NO layout and resolves no
// custom properties, so the honest form of a contrast claim is (a) a static
// assertion over this component's own source and (b) the OKLCH→WCAG ratio
// computed numerically from styles.css. Asserting the token NAME alone would be
// green against today's failing 3.40:1.
// -----------------------------------------------------------------------------

const COMPONENT_SRC = readFileSync(resolve(process.cwd(), 'src/app/forecast/forecast.ts'), 'utf8');
const GLOBAL_CSS = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** The declarations of one flat CSS rule (this stylesheet has no nested braces). */
function cssBlock(css: string, selector: string): string {
  const needle = `${selector} {`;
  const at = css.indexOf(needle);
  expect(at, `CSS selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at + needle.length, css.indexOf('}', at));
}

function token(block: string, name: string): Oklch {
  const m = new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`).exec(block);
  expect(m, `token not found: ${name}`).not.toBeNull();
  const [l, c, h] = m![1].trim().split(/\s+/).map(Number);
  return { l, c, h: h ?? 0 };
}

/** WCAG relative luminance: OKLCH → OKLab → linear sRGB (Ottosson) → Y. */
function luminance({ l, c, h }: Oklch): number {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const bb = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const b = clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(x: Oklch, y: Oklch): number {
  const [hi, lo] = [luminance(x), luminance(y)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe('Forecast — the pressed horizon label is legible in dark theme', () => {
  const DARK = cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]');
  const WHITE: Oklch = { l: 1, c: 0, h: 0 };

  it('replaces the hard-coded white with the ink-inverse token, which actually moves the ratio', async () => {
    const accentDark = token(DARK, '--color-accent');
    const inkInverseDark = token(DARK, '--color-ink-inverse');

    // The ratios, not the token name: this is what proves the swap is a fix and
    // not a rename. There is no `dark:` variant in this design system, so the
    // only lever is which token the class resolves to.
    expect(contrast(WHITE, accentDark)).toBeLessThan(4.5);
    expect(contrast(inkInverseDark, accentDark)).toBeGreaterThanOrEqual(4.5);

    // Absence over this file's own source: no element may put text-white on a
    // bg-accent/bg-critical surface. Scoped to forecast.ts — the repo-wide scan
    // covers 14 further sites in files this change does not own.
    //
    // Comments are stripped FIRST, because a comment cannot render — and the
    // comment explaining this very fix names both `text-white` and `bg-accent`,
    // so an unstripped scan reports the documentation as the defect.
    const offenders = COMPONENT_SRC.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(line => /text-white/.test(line) && /bg-accent|bg-critical/.test(line));
    expect(offenders).toEqual([]);
    // Non-vacuous: the same scan finds the replacement, so it is provably
    // reading the line the assertion above is about.
    expect(COMPONENT_SRC).toMatch(/bg-accent text-ink-inverse/);

    // And the class really reaches the pressed button in a rendered view.
    const fixture = await setup();
    await flush(fixture);
    const pressed = Array.from(host(fixture).querySelectorAll<HTMLElement>('button')).find(
      b => b.getAttribute('aria-pressed') === 'true',
    )!;
    expect(pressed.classList.contains('text-ink-inverse')).toBe(true);
    expect(pressed.classList.contains('text-white')).toBe(false);
  });
});
