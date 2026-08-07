import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { WhatIf } from './what-if';
import { ApiService, Resource, ResourceRequest } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { todayLocalIso } from '../services/local-date.util';

/**
 * A single ALLOCATED resource this month, booked well beyond any standard
 * monthly hours — so the BASE scenario starts with bench count 0. This lets
 * `hire()`'s effect on the SCENARIO be unambiguous: any bench row that shows
 * up afterward can only be the newly-hired, unbooked resource.
 *
 * `todayLocalIso()` — NOT `new Date().toISOString()` — matching what-if.ts's
 * own `currentMonth` (local time). In a timezone ahead of UTC (this repo's
 * commits are +0200), a UTC-derived month tag can name a different month than
 * the component computes near the end of the UTC day, a date-dependent flake.
 */
const CURRENT_MONTH = todayLocalIso().slice(0, 7);
const RESOURCES: Resource[] = [
  { id: 'booked', name: 'Fully Booked', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
];

function apiStub(overrides: Partial<ApiService> = {}): ApiService {
  return {
    getResources: () => of(RESOURCES),
    getRequests: () => of([]),
    getAssignments: () => of([{ id: 'a1', requestId: 'r1', resourceId: 'booked', assignedHours: 999, status: 'Allocated' }]),
    getAssignmentDays: () => of([{ id: 'd1', assignmentId: 'a1', date: `${CURRENT_MONTH}-03`, hours: 999 }]),
    getAssignmentMonths: () => of([{ id: `a1:${CURRENT_MONTH}`, assignmentId: 'a1', month: CURRENT_MONTH, status: 'Allocated' }]),
    getHolidays: () => of([]),
    getHoursPerDay: () => of({ value: 8 }),
    // The REDACTED feed (Block H). These two screens rebuild the bench rollup
    // client-side, so they fetch the intervals; the default is empty, which is
    // exactly the pre-H behaviour every case here was written against.
    getAbsenceCalendar: () => of([]),
    getProjects: () => of([]),
    ...overrides,
  } as unknown as ApiService;
}

async function setup(overrides: Partial<ApiService> = {}, ready = true) {
  TestBed.configureTestingModule({
    imports: [WhatIf],
    providers: [
      { provide: ApiService, useValue: apiStub(overrides) },
      { provide: AuthService, useValue: { authReady: signal(ready) } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(WhatIf);
  return fixture;
}

async function flush(fixture: ComponentFixture<WhatIf>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function host(fixture: ComponentFixture<WhatIf>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function onBenchKpi(fixture: ComponentFixture<WhatIf>) {
  return fixture.componentInstance.kpis().find(k => k.label === 'On Bench')!;
}

describe('WhatIf — bench retargeted onto bench.util, and the sandbox must actually simulate', () => {
  it('base and scenario start equal (bench 0): the single ALLOCATED resource is excluded on both sides', async () => {
    const fixture = await setup();
    await flush(fixture);

    const bench = onBenchKpi(fixture);
    expect(bench.base).toBe(0);
    expect(bench.scenario).toBe(0);
  });

  it('hire() with no bookings makes the SCENARIO bench count grow while BASE stays untouched — the actual simulation guarantee', async () => {
    const fixture = await setup();
    await flush(fixture);
    const c = fixture.componentInstance;

    const before = onBenchKpi(fixture);
    expect(before.scenario).toBe(0);

    c.hireForm.setValue({ role: 'Developer', count: 2, capacity: 40, skill: '' });
    c.hire();
    fixture.detectChanges();

    const after = onBenchKpi(fixture);
    // Presence: the scenario actually moved.
    expect(after.scenario).toBe(2);
    // Absence: the BASE is immutable — a shared-reference bug would have
    // leaked the same 2 into base too.
    expect(after.base).toBe(0);
    expect(after.delta).toBe(2);
  });

  it('a "Win deal" (pipeline demand, not a hire) leaves the scenario bench count unchanged — isolates hire() as the ONLY lever bench reacts to here', async () => {
    const fixture = await setup();
    await flush(fixture);
    const c = fixture.componentInstance;

    c.dealForm.setValue({
      requiredRole: 'Developer', requiredEffort: 100, skills: '',
      startDate: '2026-09-01', endDate: '2026-09-30',
    });
    c.winDeal();
    fixture.detectChanges();

    const bench = onBenchKpi(fixture);
    expect(bench.scenario).toBe(0);
    expect(bench.base).toBe(0);
  });

  it('resetScenario() discards the hire and the scenario bench count returns to matching base', async () => {
    const fixture = await setup();
    await flush(fixture);
    const c = fixture.componentInstance;

    c.hireForm.setValue({ role: 'Developer', count: 1, capacity: 40, skill: '' });
    c.hire();
    fixture.detectChanges();
    expect(onBenchKpi(fixture).scenario).toBe(1);

    c.resetScenario();
    fixture.detectChanges();
    expect(onBenchKpi(fixture).scenario).toBe(0);
  });

  it('fetches through the four new raw endpoints the bench figure depends on', async () => {
    const getAssignmentDays = vi.fn(() => of([{ id: 'd1', assignmentId: 'a1', date: `${CURRENT_MONTH}-03`, hours: 999 }]));
    const getAssignmentMonths = vi.fn(() => of([{ id: `a1:${CURRENT_MONTH}`, assignmentId: 'a1', month: CURRENT_MONTH, status: 'Allocated' as const }]));
    const getHolidays = vi.fn(() => of([]));
    const getHoursPerDay = vi.fn(() => of({ value: 8 }));
    const fixture = await setup({ getAssignmentDays, getAssignmentMonths, getHolidays, getHoursPerDay });
    await flush(fixture);

    expect(getAssignmentDays).toHaveBeenCalled();
    expect(getAssignmentMonths).toHaveBeenCalled();
    expect(getHolidays).toHaveBeenCalled();
    expect(getHoursPerDay).toHaveBeenCalled();
  });
});

describe('WhatIf — failed read renders as an error state, never a confident empty/zero', () => {
  it('shows a retry affordance instead of the empty-state copy when the read fails', async () => {
    const fixture = await setup({ getResources: () => throwError(() => new Error('boom')) as unknown as Observable<Resource[]> });
    await flush(fixture);

    // The shared ListStateComponent (app-list-state) renders its error panel
    // with role="alert" — the accessible signal the previous hand-rolled card
    // (no role, no icon) did not carry.
    const alert = host(fixture).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't load what-if data");
    expect(host(fixture).textContent).not.toContain('No capacity data yet');
    expect(alert?.querySelector('button')).toBeTruthy();
  });

  it('the retry button actually calls reload', async () => {
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

describe('WhatIf — authReady gating', () => {
  it('does not fetch until auth settles', async () => {
    const getResources = vi.fn(() => of(RESOURCES));
    const fixture = await setup({ getResources }, false);
    await flush(fixture);

    expect(getResources).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Utilisation band + "no capacity" handling.
//
// /what-if and /forecast used to hand-roll ONE ladder EACH (<85 green, 85-100
// amber, >100 red here), so the sandbox's own per-week pills contradicted the
// tone its Avg Utilization card gave the same figure, and both contradicted
// /forecast. Both screens now go through `forecastUtilizationBand`.
//
// Windows are expressed as offsets from `todayLocalIso()` — the same clock the
// component reads and which cannot be injected here — so nothing depends on the
// run date or the CI time zone.
// =============================================================================

const TODAY = todayLocalIso();
/** The fixed comparison horizon of this screen, in weeks (what-if.ts HORIZON_WEEKS). */
const HORIZON_WEEKS = 12;

function isoPlusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One resource and one open request spanning the whole 12-week horizon, so every
 * period carries exactly `effort / 12` hours and utilisation is an exact figure.
 */
function evenDemand(capacity: number, effort: number, employment: Partial<Resource> = {}): Partial<ApiService> {
  const resources: Resource[] = [
    { id: 'r1', name: 'Solo Dev', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity, kind: 'internal', ...employment },
  ];
  const requests: ResourceRequest[] = [
    { id: 'req1', name: 'Steady demand', requiredRole: 'Developer', requiredEffort: effort, status: 'Open', skills: [], startDate: TODAY, endDate: isoPlusDays(TODAY, HORIZON_WEEKS * 7) },
  ];
  return {
    getResources: () => of(resources),
    getRequests: () => of(requests),
    getAssignments: () => of([]),
    getAssignmentDays: () => of([]),
    getAssignmentMonths: () => of([]),
  } as Partial<ApiService>;
}

function kpiTile(fixture: ComponentFixture<WhatIf>, label: string): HTMLElement {
  const tile = Array.from(host(fixture).querySelectorAll<HTMLElement>('.command-kpi')).find(
    el => el.querySelector('.command-kpi-label')?.textContent?.trim() === label,
  );
  expect(tile, `KPI tile not found: ${label}`).toBeTruthy();
  return tile!;
}

/** The Util % pills of the Scenario Capacity Timeline, in row order. */
function utilPills(fixture: ComponentFixture<WhatIf>): HTMLElement[] {
  const section = Array.from(host(fixture).querySelectorAll('.command-card')).find(
    card => card.querySelector('h2')?.textContent?.trim() === 'Scenario Capacity Timeline',
  );
  expect(section, 'scenario timeline not found').toBeTruthy();
  return Array.from(section!.querySelectorAll<HTMLElement>('tbody tr td:nth-child(4) .command-status'));
}

describe('WhatIf — the scenario timeline paints utilisation with the SAME band as /forecast', () => {
  it('does not paint a 45% week with the healthy tone', async () => {
    // 540h over 12 weeks = 45h/week against 100h/week of supply.
    const fixture = await setup(evenDemand(100, 540));
    await flush(fixture);

    const pills = utilPills(fixture);
    expect(pills.length).toBe(HORIZON_WEEKS);
    expect(pills.every(p => p.textContent?.trim() === '45%')).toBe(true);
    // ABSENCE: green here is what let the sandbox call a 45% week healthy in the
    // table while its own Avg Utilization card scored the move as bad.
    expect(pills.some(p => p.classList.contains('green'))).toBe(false);
    expect(pills.every(p => p.classList.contains('amber'))).toBe(true);
  });

  it('still paints a fully-sold 90% week as healthy — the paired positive', async () => {
    // 1080h over 12 weeks = 90h/week against 100h/week of supply.
    const fixture = await setup(evenDemand(100, 1080));
    await flush(fixture);

    const pills = utilPills(fixture);
    expect(pills.every(p => p.textContent?.trim() === '90%')).toBe(true);
    // 90% used to render amber here (the old >=85 "tight" rung), so neither
    // "delete green" nor "paint everything amber" satisfies both halves.
    expect(pills.every(p => p.classList.contains('green'))).toBe(true);
    expect(pills.some(p => p.classList.contains('amber'))).toBe(false);
  });
});

describe('WhatIf — an unmeasurable average renders as n/a, never as 0%', () => {
  it('shows n/a with no tone for base, scenario and delta when no period has capacity', async () => {
    // The only resource joins long after the horizon ends: there is no supply to
    // measure against in any of the 12 weeks.
    const fixture = await setup(evenDemand(100, 540, { hireDate: isoPlusDays(TODAY, 365) }));
    await flush(fixture);

    const k = fixture.componentInstance.kpis().find(x => x.label === 'Avg Utilization')!;
    expect(k.base).toBeNull();
    expect(k.scenario).toBeNull();
    // A signed delta out of two unknowns would be pure invention.
    expect(k.delta).toBeNull();

    const tile = kpiTile(fixture, 'Avg Utilization');
    expect(tile.querySelector('.command-kpi-value')?.textContent?.trim()).toBe('n/a');
    expect(tile.querySelector('.command-kpi-value')?.textContent?.trim()).not.toBe('0%');
    // No tone: colouring a comparison that was never possible is the same defect
    // as the header badge that used to affirm parity it could not know.
    expect(tile.classList.contains('green')).toBe(false);
    expect(tile.classList.contains('danger')).toBe(false);

    const pills = utilPills(fixture);
    expect(pills.length).toBe(HORIZON_WEEKS);
    // Exact text, not toContain: '0%' is a substring of '100%'.
    expect(pills.every(p => p.textContent?.trim() === 'n/a')).toBe(true);
    expect(pills.some(p => p.textContent?.trim() === '0%')).toBe(false);
  });

  it('still reports a real 0% when the capacity exists and nothing is booked — the paired positive', async () => {
    const fixture = await setup(evenDemand(100, 0));
    await flush(fixture);

    const k = fixture.componentInstance.kpis().find(x => x.label === 'Avg Utilization')!;
    expect(k.scenario).toBe(0);
    expect(kpiTile(fixture, 'Avg Utilization').querySelector('.command-kpi-value')?.textContent?.trim()).toBe('0%');
    expect(utilPills(fixture).every(p => p.textContent?.trim() === '0%')).toBe(true);
  });
});

/**
 * CRITICAL (round 1 review): the header's scenario badge/Reset button sit
 * OUTSIDE the body's loading/error gate, so they used to render unconditionally.
 * With `baseData()` falling back to an empty stand-in on a failed read,
 * `dirty()` compared 0-vs-0 and read false, showing a green "Matches baseline"
 * badge directly above the "Couldn't load" retry card — parity AFFIRMED as fact
 * when parity is actually UNKNOWN (no baseline ever loaded). Fixed by gating the
 * header on `dataState()`, the same tri-state the body uses.
 */
describe('WhatIf — the header badge/Reset must never claim parity it cannot know (CRITICAL fix)', () => {
  function headerText(fixture: ComponentFixture<WhatIf>): string {
    return (fixture.nativeElement as HTMLElement).querySelector('header')?.textContent ?? '';
  }
  function resetButton(fixture: ComponentFixture<WhatIf>): HTMLButtonElement {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('header button'))
      .find(b => b.textContent?.includes('Reset scenario')) as HTMLButtonElement;
  }

  it('on a failed read, shows "Unavailable" — NOT the green "Matches baseline" badge — and disables Reset', async () => {
    const fixture = await setup({ getResources: () => throwError(() => new Error('boom')) as unknown as Observable<Resource[]> });
    await flush(fixture);

    const text = headerText(fixture);
    // Presence: the honest "we don't know" signal.
    expect(text).toContain('Unavailable');
    // Absence: the exact false claim the CRITICAL finding named — this is the
    // assertion a regression of the bug would flip.
    expect(text).not.toContain('Matches baseline');
    expect(resetButton(fixture).disabled).toBe(true);
  });

  it('before authReady settles, the header does not claim "Matches baseline" either — !authReady() must count as loading, not ready-and-empty', async () => {
    const fixture = await setup({}, false);
    await flush(fixture);

    const text = headerText(fixture);
    expect(text).not.toContain('Matches baseline');
    expect(resetButton(fixture).disabled).toBe(true);
  });

  it('once data resolves normally, the header DOES show "Matches baseline" — the paired positive proving the gate does not just hide the badge forever', async () => {
    const fixture = await setup();
    await flush(fixture);

    const text = headerText(fixture);
    expect(text).toContain('Matches baseline');
    expect(text).not.toContain('Unavailable');
  });
});

// -----------------------------------------------------------------------------
// The Scenario Capacity chart wiring — the SECOND site of the same sweep.
//
// /forecast pins the identical contract; this block exists so the sweep is proven
// at more than one call site rather than proven once and assumed twice. It matters
// especially here: the levers on this screen exist to ADD supply, so a Supply left
// in a stacked [series] would make every hire raise the demand column it is
// supposed to be measured against — the scenario would look worse the more people
// it hired.
// -----------------------------------------------------------------------------

/** The Scenario Capacity BAR chart (the demand trend chart also has a value axis). */
function scenarioBarChart(fixture: ComponentFixture<WhatIf>): HTMLElement {
  const chart = host(fixture).querySelector<HTMLElement>('command-bar-chart');
  expect(chart, 'the scenario bar chart must render').toBeTruthy();
  return chart!;
}

/** The numeric top of a chart's value axis, read back off its own last tick. */
function chartAxisTop(chart: HTMLElement): number {
  const labels = Array.from(chart.querySelectorAll('.ldg-axis-val')).map(t => (t.textContent ?? '').trim());
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

describe('WhatIf — Supply is the chart overlay, not a bar stacked onto demand', () => {
  /** 540h of OPEN demand over 12 weeks vs one 100h/week resource: supply 100, pipeline 45. */
  const SUPPLY = 100;
  const STACK = 45;

  it('tops the value axis at the supply, neither at the supply+demand sum nor at the demand alone', async () => {
    const fixture = await setup(evenDemand(SUPPLY, 540));
    await flush(fixture);
    const top = chartAxisTop(scenarioBarChart(fixture));

    // Not clipped (a domain of 45 alone would stop at 50)...
    expect(top).toBeGreaterThanOrEqual(SUPPLY);
    // ...and not summed: a stacked Supply makes the domain 145, so niceScale tops
    // out at 150. This is the assertion of ABSENCE for the defect being fixed, and
    // the half that a presence-only check on the polyline would have passed.
    expect(top).toBeLessThan(SUPPLY + STACK);
    expect(top).toBe(100);
  });

  it('draws two demand bars per week and no Supply bar at all', async () => {
    const fixture = await setup(evenDemand(SUPPLY, 540));
    await flush(fixture);
    const chart = scenarioBarChart(fixture);

    const rects = chartBars(chart);
    // 12 weeks x {Committed, Pipeline}; a third series would make it 36.
    expect(rects).toHaveLength(HORIZON_WEEKS * 2);
    const titles = rects.map(r => r.querySelector('title')?.textContent ?? '');
    expect(titles.some(t => t.includes('Supply'))).toBe(false);
    // Paired presence, so "renders no bars" cannot satisfy the absence above.
    expect(titles.filter(t => t.includes('Committed'))).toHaveLength(HORIZON_WEEKS);
    expect(titles.filter(t => t.includes('Pipeline'))).toHaveLength(HORIZON_WEEKS);

    // The stack still measures its own 45 against the 100 axis.
    const totalHeight = rects.reduce((sum, r) => sum + Number(r.getAttribute('height')), 0);
    expect(totalHeight / HORIZON_WEEKS / chartPlotHeight(chart)).toBeCloseTo(STACK / 100, 4);
  });

  it('renders Supply as a named overlay line inside the plot band', async () => {
    const fixture = await setup(evenDemand(SUPPLY, 540));
    await flush(fixture);
    const chart = scenarioBarChart(fixture);

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
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(Math.min(...gridY));
    expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(...gridY));

    // Not sighted-only: the overlay keeps its legend key and a11y column.
    const legend = Array.from(chart.querySelectorAll('.ldg-legend li')).map(li => (li.textContent ?? '').trim());
    expect(legend).toEqual(['Committed', 'Pipeline', 'Supply']);
    const headers = Array.from(chart.querySelectorAll('.ldg-sr thead th')).map(th => (th.textContent ?? '').trim());
    expect(headers).toEqual(['Category', 'Committed', 'Pipeline', 'Supply']);
  });

  it('a HIRE lifts the supply overlay and leaves the demand bands untouched', async () => {
    // The lever this screen exists for. Hiring must move the SUPPLY line and
    // nothing else: the demand stack it is compared against has to stay put, or
    // the sandbox reports its own remedy as extra demand.
    const fixture = await setup(evenDemand(SUPPLY, 540));
    await flush(fixture);
    const c = fixture.componentInstance;

    const before = c.scenarioSupplyOverlay().values[0];
    const demandBefore = c.scenarioDemandSeries().map(s => s.values[0]);

    c.hireForm.setValue({ role: 'Developer', count: 1, capacity: 40, skill: '' });
    c.hire();
    fixture.detectChanges();

    // Presence: supply grew.
    expect(c.scenarioSupplyOverlay().values[0]).toBeGreaterThan(before);
    // Absence: the demand bands did NOT — which is exactly what a stacked Supply
    // would have broken, since the hire would have been added to the column.
    expect(c.scenarioDemandSeries().map(s => s.values[0])).toEqual(demandBefore);
    // And Supply is still no bar after the recompute.
    expect(c.scenarioDemandSeries().map(s => s.name)).toEqual(['Committed', 'Pipeline']);
  });
});

/**
 * BLOCK H — the absence feed reaches BOTH legs, or it reaches neither.
 *
 * `toRollupInput()` is one shared helper precisely so the baseline and the
 * scenario cannot diverge; these cases are what make that structural claim
 * observable. Wiring one leg and asserting only that one is how this defect
 * survives, so both numbers are read from the SAME KPI on the SAME fixture.
 *
 * The stub's default is `[]`, which reproduces the pre-H answer exactly — which
 * is also why every other case in this file stayed green when the wiring landed,
 * and why only a DIFFERENTIAL can show it is live.
 */
describe('WhatIf — the redacted absence feed reaches both legs (Block H)', () => {
  /** Two mounts in one case need an explicit reset: TestBed refuses to be
   *  reconfigured once instantiated, and a differential is two mounts by nature. */
  const remount = async (overrides: Partial<ApiService>) => {
    TestBed.resetTestingModule();
    const fixture = await setup(overrides);
    await flush(fixture); // the rxResource is unresolved until this runs, and an
                          // unflushed mount reads 0 for everything — which a
                          // differential would report as "no difference".
    return onBenchKpi(fixture);
  };

  /** A second resource with no bookings at all: on bench by construction. */
  const IDLE: Resource = {
    id: 'idle', name: 'Nobody Booked Me', role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 0, capacity: 40, kind: 'internal',
  };
  const withIdle = () => of([...RESOURCES, IDLE]);
  /**
   * Covers the whole current month, so `idle` reads ABSENT rather than BENCH.
   *
   * The end date is computed, not typed: a hard-coded `-28` leaves the 29th to
   * 31st uncovered, which makes the month PARTLY absent — the state stays BENCH,
   * the person stays in the count, and the differential silently measures
   * nothing. That is what the first version of this fixture did.
   */
  const monthEnd = new Date(Date.UTC(Number(CURRENT_MONTH.slice(0, 4)), Number(CURRENT_MONTH.slice(5, 7)), 0))
    .toISOString().slice(0, 10);
  const wholeMonth = [{ id: 'ab1', resourceId: 'idle', startDate: `${CURRENT_MONTH}-01`, endDate: monthEnd }];

  it('DIFFERENTIAL: an absence covering the month removes that person from BOTH bench counts', async () => {
    const without = await remount({ getResources: withIdle });
    const withAbs = await remount({ getResources: withIdle, getAbsenceCalendar: () => of(wholeMonth) });

    // FIXTURE GUARD: without the absence she IS on bench, or the case below is
    // satisfied for lack of anybody to remove. Narrows the nullable KPI too.
    expect(without.base, 'the idle resource must be on bench to begin with').toBeGreaterThan(0);
    expect(without.scenario).not.toBeNull();
    const baseBefore = without.base as number;
    const scenBefore = without.scenario as number;

    expect(withAbs.base, 'baseline leg').toBe(baseBefore - 1);
    expect(withAbs.scenario, 'scenario leg').toBe(scenBefore - 1);
  });

  it('ABSENCE TWIN: an absence on SOMEBODY ELSE moves neither leg', async () => {
    // Without this, a feed that simply drops one row from every count passes the
    // case above. The interval is identical; only the resourceId differs.
    const other = [{ id: 'ab2', resourceId: 'not-a-resource', startDate: `${CURRENT_MONTH}-01`, endDate: monthEnd }];
    const without = await remount({ getResources: withIdle });
    const withAbs = await remount({ getResources: withIdle, getAbsenceCalendar: () => of(other) });
    expect({ base: withAbs.base, scenario: withAbs.scenario })
      .toStrictEqual({ base: without.base, scenario: without.scenario });
  });

  it('reads the REDACTED feed, never the reason-carrying one', async () => {
    // A privacy assertion, not a wiring one: /absences serves special-category
    // data to a narrower audience than this screen has.
    const getAbsenceCalendar = vi.fn(() => of([]));
    const getAbsences = vi.fn(() => of([]));
    TestBed.resetTestingModule();
    await flush(await setup({ getResources: withIdle, getAbsenceCalendar, getAbsences }));
    expect(getAbsenceCalendar).toHaveBeenCalled();
    expect(getAbsences, 'this screen must never ask for absence reasons').not.toHaveBeenCalled();
  });
});
