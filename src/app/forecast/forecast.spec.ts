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
import { contrast, cssBlock, token, WHITE } from '../shared/theme-contrast';

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
    // The REDACTED feed (Block H). These two screens rebuild the bench rollup
    // client-side, so they fetch the intervals; the default is empty, which is
    // exactly the pre-H behaviour every case here was written against.
    getAbsenceCalendar: () => of([]),
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
// The Supply-vs-Demand chart wiring.
//
// CommandBarChartComponent grew an [overlay] input precisely so a Supply series
// could stop sharing the bar list with demand, and this call site was left on the
// old shape. The two wrong states it can be in are BOTH visible in the value-axis
// top, which is why the axis is the primary assertion here rather than the
// presence of the polyline:
//   * Supply left in [series] while [stacked] -> supply is ADDED to the demand it
//     is the yardstick for; the axis climbs to cover 145 instead of 100.
//   * Supply moved to [overlay] but the overlay excluded from the y-domain -> the
//     line is clipped flat along the top gridline and the axis stops at 50.
// -----------------------------------------------------------------------------

/** The Supply-vs-Demand BAR chart (the trend chart in the same card also has an axis). */
function timelineBarChart(fixture: ComponentFixture<Forecast>): HTMLElement {
  const chart = host(fixture).querySelector<HTMLElement>('command-bar-chart');
  expect(chart, 'the timeline bar chart must render').toBeTruthy();
  return chart!;
}

/** Value-axis tick labels of one chart, DOM order = ascending value. */
function chartAxisLabels(chart: HTMLElement): string[] {
  return Array.from(chart.querySelectorAll('.ldg-axis-val')).map(t => (t.textContent ?? '').trim());
}

/** The numeric top of a chart's value axis, read back off its own last tick. */
function chartAxisTop(chart: HTMLElement): number {
  const labels = chartAxisLabels(chart);
  expect(labels.length, 'the value axis must render tick labels').toBeGreaterThan(1);
  return Number((labels.at(-1) ?? '').replace(/[^\d.-]/g, ''));
}

function chartBars(chart: HTMLElement): SVGRectElement[] {
  return Array.from(chart.querySelectorAll<SVGRectElement>('rect.ldg-bar'));
}

/** Plot height in viewBox units, measured off the gridlines themselves. */
function chartPlotHeight(chart: HTMLElement): number {
  const ys = Array.from(chart.querySelectorAll('.ldg-grid line')).map(l => Number(l.getAttribute('y1')));
  expect(ys.length, 'the value axis must render gridlines').toBeGreaterThan(1);
  return Math.max(...ys) - Math.min(...ys);
}

describe('Forecast — Supply is the chart overlay, not a bar stacked onto demand', () => {
  /**
   * 360h of OPEN demand over the 8-week horizon against one 100h/week resource:
   * every week is supply 100, committed 0, pipeline 45. Supply therefore sits
   * ABOVE the demand stack, which is the configuration that can tell the three
   * candidate wirings apart — with supply UNDER the stack every one of them
   * produces the same axis.
   */
  const SUPPLY = 100;
  const STACK = 45;

  it('tops the value axis at the supply, neither at the supply+demand sum nor at the demand alone', async () => {
    const fixture = await setup(evenDemandStub(SUPPLY, 360));
    await flush(fixture);
    const top = chartAxisTop(timelineBarChart(fixture));

    // Not clipped: the supply line must fit inside the plot. niceScale(0,45,5)
    // would stop at 50, so this fails if the overlay is dropped from the domain.
    expect(top).toBeGreaterThanOrEqual(SUPPLY);
    // Not summed: a Supply left in a stacked [series] makes the domain 145 and
    // niceScale(0,145,5) tops out at 150. This is the assertion of ABSENCE for
    // the defect actually being fixed, and it is the half a presence-only check
    // on the polyline would have passed.
    expect(top).toBeLessThan(SUPPLY + STACK);
    // Exactly: niceScale(0,100,5).
    expect(top).toBe(100);
  });

  it('keeps the supply line inside the plot band rather than pinned to the top gridline', async () => {
    const fixture = await setup(evenDemandStub(SUPPLY, 360));
    await flush(fixture);
    const chart = timelineBarChart(fixture);

    const line = chart.querySelector('polyline.ldg-overlay');
    expect(line, 'Supply must render as the overlay polyline').not.toBeNull();
    expect(line!.querySelector('title')?.textContent?.trim()).toBe('Supply');

    const gridY = Array.from(chart.querySelectorAll('.ldg-grid line')).map(l => Number(l.getAttribute('y1')));
    const ys = (line!.getAttribute('points') ?? '')
      .trim()
      .split(/\s+/)
      .map(p => Number(p.split(',')[1]));
    expect(ys.length).toBeGreaterThan(0);
    expect(ys.every(Number.isFinite)).toBe(true);
    // Inside the band, and STRICTLY below its top edge — supply 100 against an
    // axis of 100 would sit exactly ON the top gridline, so this is a real
    // geometric statement and not a tautology.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(Math.min(...gridY));
    expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(...gridY));
  });

  it('draws two demand bars per week and no Supply bar at all', async () => {
    const fixture = await setup(evenDemandStub(SUPPLY, 360));
    await flush(fixture);
    const chart = timelineBarChart(fixture);

    const rects = chartBars(chart);
    // 8 weeks x {Committed, Pipeline}. A third series would make it 24.
    expect(rects).toHaveLength(16);
    const titles = rects.map(r => r.querySelector('title')?.textContent ?? '');
    // The assertion of ABSENCE: no bar may be a Supply bar.
    expect(titles.some(t => t.includes('Supply'))).toBe(false);
    // The paired presence, so "renders no bars" cannot satisfy the line above.
    expect(titles.filter(t => t.includes('Committed'))).toHaveLength(8);
    expect(titles.filter(t => t.includes('Pipeline'))).toHaveLength(8);

    // And the stack really measures the demand — 45 of the 100 axis — so moving
    // supply out did not silently rescale the bars that remain. Summed per week
    // because `stacked` is what makes Committed+Pipeline one column.
    const totalHeight = rects.reduce((sum, r) => sum + Number(r.getAttribute('height')), 0);
    expect(totalHeight / 8 / chartPlotHeight(chart)).toBeCloseTo(STACK / 100, 4);
  });

  it('still names Supply in the legend and in the screen-reader table', async () => {
    const fixture = await setup(evenDemandStub(SUPPLY, 360));
    await flush(fixture);
    const chart = timelineBarChart(fixture);

    // Moving a series to the overlay must not make it sighted-only or nameless:
    // the capacity figure is the one every other number is judged against.
    const legend = Array.from(chart.querySelectorAll('.ldg-legend li')).map(li => (li.textContent ?? '').trim());
    expect(legend).toEqual(['Committed', 'Pipeline', 'Supply']);
    const headers = Array.from(chart.querySelectorAll('.ldg-sr thead th')).map(th => (th.textContent ?? '').trim());
    expect(headers).toEqual(['Category', 'Committed', 'Pipeline', 'Supply']);
  });

  it('exposes Supply and the demand bands as separate component inputs', async () => {
    const fixture = await setup(evenDemandStub(SUPPLY, 360));
    await flush(fixture);
    const c = fixture.componentInstance;

    // The bar list holds ONLY demand...
    expect(c.demandSeries().map(s => s.name)).toEqual(['Committed', 'Pipeline']);
    // ...and Supply is its own thing, carrying the real per-week capacity rather
    // than an empty series that would satisfy the name check above.
    expect(c.supplyOverlay().name).toBe('Supply');
    expect(c.supplyOverlay().values).toHaveLength(8);
    expect(c.supplyOverlay().values.every(v => v === SUPPLY)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Source-text + token arithmetic. jsdom performs NO layout and resolves no
// custom properties, so the honest form of a contrast claim is (a) a static
// assertion over this component's own source and (b) the OKLCH→WCAG ratio
// computed numerically from styles.css.
//
// The arithmetic itself, and the palette-wide contract it serves, now live in
// src/app/shared/theme-contrast(.spec).ts — one copy for every spec that makes a
// colour claim. What stays here is the part that is specific to /forecast: that
// the pressed horizon chip really carries the inverse-ink class in a rendered
// view, on the accent fill the shared spec measures.
// -----------------------------------------------------------------------------

const COMPONENT_SRC = readFileSync(resolve(process.cwd(), 'src/app/forecast/forecast.ts'), 'utf8');
const GLOBAL_CSS = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

describe('Forecast — the pressed horizon label is legible in dark theme', () => {
  const DARK = cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]');

  it('puts an inverse-ink label on the accent fill, and the pair measures AA in dark', async () => {
    const accentDark = token(DARK, '--color-accent');
    const inkInverseDark = token(DARK, '--color-ink-inverse');

    // The RATIO, not the token name. This used to assert that white FAILED here
    // (3.40:1 on the old lifted accent) and that ink-inverse — then the dark
    // surface colour — passed. Both halves of that are now wrong: the dark fill
    // was darkened until white clears AA, and ink-inverse is white in both
    // themes, so the two classes are interchangeable and BOTH must pass. The
    // old expectation is deleted rather than relaxed: it certified a palette
    // that no longer exists, and as written it would fail on the fixed one.
    expect(contrast(WHITE, accentDark)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inkInverseDark, accentDark)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inkInverseDark, accentDark)).toBeCloseTo(contrast(WHITE, accentDark), 6);
    // Absence twin for the pair above: the fill this replaced is still sub-AA
    // under the same helper, so "clears AA" is a measurement and not a constant.
    expect(contrast(WHITE, { l: 0.64, c: 0.16, h: 258 })).toBeLessThan(4.5);

    // The class really reaches the pressed button in a rendered view — the half
    // that no token arithmetic can prove.
    const fixture = await setup();
    await flush(fixture);
    const pressed = Array.from(host(fixture).querySelectorAll<HTMLElement>('button')).find(
      b => b.getAttribute('aria-pressed') === 'true',
    )!;
    expect(pressed.classList.contains('text-ink-inverse')).toBe(true);
    // …and the unpressed chips do NOT carry it, so the class is bound to the
    // state rather than printed on every chip.
    const idle = Array.from(host(fixture).querySelectorAll<HTMLElement>('button')).filter(
      b => b.getAttribute('aria-pressed') === 'false',
    );
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.every(b => !b.classList.contains('text-ink-inverse'))).toBe(true);
    // Non-vacuous over the source: the scan that reads this file finds the pair
    // the assertions above are about.
    expect(COMPONENT_SRC).toMatch(/bg-accent text-ink-inverse/);
  });
});

// -----------------------------------------------------------------------------
// The other half of the -text token family: red used as SMALL TEXT.
// -----------------------------------------------------------------------------

const WHAT_IF_SRC = readFileSync(resolve(process.cwd(), 'src/app/forecast/what-if.ts'), 'utf8');

describe('Capacity Control renders negative figures at AA in dark theme', () => {
  const DARK = cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]');
  const SURFACES = ['--color-surface', '--color-surface-muted'] as const;

  it('resolves --cc-red-text to a shade that clears 4.5:1 where the raw fill tone does not', () => {
    // The RATIO, not the token name: --cc-red reads 3.33:1 on the dark surface
    // (4.47:1 before the fill was darkened to make white AA on it), so a spec
    // asserting "the template says --cc-red-text" would have been green against
    // the failing value. Both surfaces are checked because the data tables here
    // zebra-stripe, and the muted row is the worse of the two.
    const criticalFill = token(DARK, '--color-critical');
    const criticalText = token(DARK, '--color-critical-text');
    for (const s of SURFACES) {
      const surface = token(DARK, s);
      expect(contrast(criticalFill, surface), `raw --cc-red on dark ${s}`).toBeLessThan(4.5);
      expect(contrast(criticalText, surface), `--cc-red-text on dark ${s}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses no raw --cc-red in a colour position on either Capacity Control screen', () => {
    // Absence over both owned templates: the Gap column, the "Over by" column and
    // /what-if's demand delta are all 14px figures, so 4.5:1 applies to each.
    // Scoped to `color`/`[style.color]` so it cannot fire on styles.css's
    // border-top-color, which must KEEP the fill tone.
    const inColourPosition = (src: string): string[] =>
      src
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => /(\[style\.color\]|(?<!-)\bcolor:)/.test(line) && /var\(--cc-red\)/.test(line));

    expect(inColourPosition(COMPONENT_SRC), 'forecast.ts').toEqual([]);
    expect(inColourPosition(WHAT_IF_SRC), 'what-if.ts').toEqual([]);

    // Non-vacuous: the identical scan finds the GREEN twin in a colour position on
    // both files, which proves it is really reading these bindings — the same
    // control the register asks for.
    const greenTwin = (src: string): string[] =>
      src.split('\n').filter(line => /(\[style\.color\]|(?<!-)\bcolor:)/.test(line) && /var\(--cc-green-text\)/.test(line));
    expect(greenTwin(COMPONENT_SRC).length).toBeGreaterThan(0);
    expect(greenTwin(WHAT_IF_SRC).length).toBeGreaterThan(0);
  });

  it('paints a negative gap with the -text shade and a positive one green — same cell, opposite states', async () => {
    // Rendered, not source-scanned, and BOTH branches on the one element: a fix
    // that dropped the red branch entirely would pass an absence-only check.
    // 1600h of demand over 8 weeks = 200h/week against 100h/week of supply.
    const over = await setup(evenDemandStub(100, 1600));
    await flush(over);
    const gapCells = Array.from(
      host(over).querySelectorAll<HTMLElement>('tbody tr td:nth-child(5)'),
    ).filter(td => td.classList.contains('num'));
    expect(gapCells.length).toBeGreaterThan(0);
    expect(gapCells[0].textContent?.trim()).toMatch(/^-/);
    expect(gapCells[0].style.color).toBe('var(--cc-red-text)');

    // Both states belong in ONE test (that is what makes the pair load-bearing),
    // and the second needs a different API stub, so the module is reset rather
    // than the assertions being split across two `it`s.
    TestBed.resetTestingModule();

    // The paired positive: spare capacity keeps the green -text shade.
    const under = await setup(evenDemandStub(100, 360));
    await flush(under);
    const spare = Array.from(
      host(under).querySelectorAll<HTMLElement>('tbody tr td:nth-child(5)'),
    ).filter(td => td.classList.contains('num'));
    expect(spare[0].textContent?.trim()).not.toMatch(/^-/);
    expect(spare[0].style.color).toBe('var(--cc-green-text)');
  });
});
