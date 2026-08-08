import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computed, signal } from '@angular/core';
import { DeferBlockState, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { DashboardComponent } from './dashboard.component';
import { ABSENCE_REASON_CODES, ApiService, UserRole, type BenchCell, type BenchRollup, type Issue, type ResourceRequest } from '../services/api.service';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';
import { todayLocalIso } from '../services/local-date.util';
import { AuthService } from '../services/auth.service';

/**
 * Set (or clear) the process time zone. `process.env['TZ']` is honoured by V8 for
 * every subsequent Date operation, so this genuinely relocates the runner's local
 * calendar — the only way to make a local-vs-UTC disagreement deterministic instead
 * of a property of whatever machine happens to run the suite.
 */
function setTz(tz: string | undefined): void {
  if (tz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = tz;
}

/** 'YYYY-MM' `delta` months from `month`, normalising the year. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const zeroBased = y * 12 + (m - 1) + delta;
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

const DASHBOARD_METHODS = [
  'getFxRates',
  'getResources',
  'getRequests',
  'getProjects',
  'getAssignments',
  'getOrders',
  'getOrderLines',
  'getProjectFinancials',
  'getTimeEntries',
  'getBillingPlanItems',
  'getProjectIssues',
  'getChangeRequests',
  'getContracts',
  'getNegotiatedRates',
  // Was missing since c716eea (the P0-04 reconcile merge that added
  // `hoursPerDay` to dataRes's forkJoin without updating this stub list).
  // Object-literal properties evaluate left-to-right, so the forkJoin's
  // `hoursPerDay: this.api.getHoursPerDay().pipe(...)` property (second to
  // last) threw synchronously ("not a function") the instant it was
  // evaluated for ANY portfolio-reader role, before forkJoin() itself was
  // ever reached. Every render() call for 'finance'/'delivery-executive'/
  // 'admin' therefore landed dataRes in an 'error' state and rendered the
  // "Couldn't load the command center" panel — never the KPI tile grid.
  // "loads the complete portfolio dataset only for a portfolio reader" below
  // still passed throughout, because it only asserts the methods evaluated
  // BEFORE the throw were called; it never asserted anything about the
  // actually-rendered (error) page. Fixing the stub here restores the real
  // success path — this DASHBOARD_METHODS list is also this test's exact
  // documentation of forkJoin evaluation order.
  'getHoursPerDay',
  // "In Bench" tile (Block F, Task 9) — appended AFTER getHoursPerDay in the
  // component's forkJoin, matching the same evaluation-order convention.
  'getBenchMonthly',
  // Baseline vs Planned portfolio tile (block E, Task 7) — appended AFTER
  // getBenchMonthly, matching this file's own established convention of
  // adding new forkJoin legs at the end rather than mid-block, to avoid a
  // merge collision on this exact array (see the getHoursPerDay/getBenchMonthly
  // comments above for the historical incident this convention now avoids).
  'getAssignmentDays',
  'getAssignmentMonths',
  'getCostBaselines',
] as const;

function makeApiStub(): Record<(typeof DASHBOARD_METHODS)[number], ReturnType<typeof vi.fn>> {
  const stub = Object.fromEntries(DASHBOARD_METHODS.map(name => [name, vi.fn(() => of([]))])) as
    Record<(typeof DASHBOARD_METHODS)[number], ReturnType<typeof vi.fn>>;
  // getHoursPerDay's real shape is { value: number }, consumed via
  // `.pipe(map(r => r.value))` — NOT a bare array like every other leg here.
  stub.getHoursPerDay = vi.fn(() => of({ value: 8 }));
  // getBenchMonthly's real shape is a BenchRollup object, not a bare array.
  stub.getBenchMonthly = vi.fn(() => of(EMPTY_BENCH_ROLLUP));
  return stub;
}

function makeAuthStub(role: UserRole) {
  const canView = ['finance', 'delivery-executive', 'admin'].includes(role);
  return {
    authReady: signal(true),
    role: signal(role),
    canViewPortfolioDashboard: computed(() => canView),
    canManageStaffing: computed(() => ['pm', 'resource-manager', 'delivery-executive', 'admin'].includes(role)),
    canReadCommercial: computed(() => ['sales', 'finance', 'delivery-executive', 'admin'].includes(role)),
  };
}

// `apiOverrides` lets a caller replace individual stub methods (e.g.
// getBenchMonthly) BEFORE the component's forkJoin first subscribes —
// setting a mock's return value AFTER render() has already resolved has no
// effect, since rxResource's stream already fired with whatever the mock
// returned at subscribe time.
async function render(role: UserRole, apiOverrides?: Partial<Record<(typeof DASHBOARD_METHODS)[number], ReturnType<typeof vi.fn>>>) {
  const api = makeApiStub();
  if (apiOverrides) Object.assign(api, apiOverrides);
  TestBed.configureTestingModule({
    imports: [DashboardComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
    ],
  });
  const fixture = TestBed.createComponent(DashboardComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api };
}

describe('Dashboard capability-aware loading', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders a self-service workspace without firing portfolio endpoints for employee', async () => {
    const { fixture, api } = await render('employee');
    for (const method of DASHBOARD_METHODS) {
      expect(api[method], method).not.toHaveBeenCalled();
    }
    expect(fixture.nativeElement.textContent).toContain('My workspace');
    expect(fixture.nativeElement.textContent).not.toContain('Portfolio Financials');
  });

  it('does not treat sales commercial access as authorization for finance dashboard data', async () => {
    const { api } = await render('sales');
    for (const method of DASHBOARD_METHODS) {
      expect(api[method], method).not.toHaveBeenCalled();
    }
  });

  it('loads the complete portfolio dataset only for a portfolio reader', async () => {
    const { api } = await render('finance');
    for (const method of DASHBOARD_METHODS) {
      expect(api[method], method).toHaveBeenCalledOnce();
    }
  });
});

/**
 * Self-contained BenchRollup fixture for the "In Bench" tile — deliberately
 * NOT derived from src/db/seed.ts. This is a unit test of the tile's own
 * counting logic (dashboard.component.ts's `internalBenchCount`/
 * `subcoBenchCount`), isolated from the real seed via a mocked
 * `getBenchMonthly()`, exactly like bench.component.spec.ts and
 * utilization.component.spec.ts mock the same endpoint for their own unit
 * tests. It intentionally mixes in an internal PARTIAL row and an internal
 * ALLOCATED row (neither of which should count as bench) and a subco PARTIAL
 * row (which must not inflate the subco count either) — both counts must
 * stay exactly 2 and 1 despite the extra non-bench rows sharing the same
 * `monthly` map shape, and only a filter that reads the real `state` value
 * agrees.
 *
 * The cells are keyed on the CURRENT month and the window deliberately opens four
 * months earlier — the shape the server actually sends, since it anchors the bench
 * window on the oldest OPEN planning period. This fixture used to key everything on
 * `months[0]`, which is what let the tile read a four-month-old column as the
 * present tense with the whole suite green.
 */
function makeBenchFixture(): BenchRollup {
  const month = todayLocalIso().slice(0, 7);
  const bench = { state: 'BENCH' as const, upcomingUnallocated: false };
  const partial = { state: 'PARTIAL' as const, upcomingUnallocated: false };
  const allocated = { state: 'ALLOCATED' as const, upcomingUnallocated: false };
  return {
    months: [shiftMonth(month, -4), shiftMonth(month, -3), shiftMonth(month, -2), shiftMonth(month, -1), month],
    internalRows: [
      { resourceId: 'int-1', resourceName: 'Internal Bench One', kind: 'internal', monthly: { [month]: bench }, availabilityDate: { kind: 'date', date: month + '-01' } },
      { resourceId: 'int-2', resourceName: 'Internal Bench Two', kind: 'internal', monthly: { [month]: bench }, availabilityDate: { kind: 'date', date: month + '-01' } },
      { resourceId: 'int-3', resourceName: 'Internal Partial', kind: 'internal', monthly: { [month]: partial }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
      { resourceId: 'int-4', resourceName: 'Internal Allocated', kind: 'internal', monthly: { [month]: allocated }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' } },
    ],
    subcoRows: [
      { resourceId: 'sub-1', resourceName: 'Subco Bench One', kind: 'subco', monthly: { [month]: bench }, availabilityDate: { kind: 'date', date: month + '-01' } },
      { resourceId: 'sub-2', resourceName: 'Subco Partial', kind: 'subco', monthly: { [month]: partial }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
    ],
    hiringDemand: [],
  };
}

describe('Dashboard "In Bench" tile (Block F, Task 9)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows separate internal and subco bench counts, never a combined total', async () => {
    const { fixture } = await render('finance', {
      getBenchMonthly: vi.fn(() => of(makeBenchFixture())),
    });

    const host = fixture.nativeElement as HTMLElement;
    // Scoped to the bench tile alone: the dashboard renders four sibling
    // `.command-card-muted` tiles sharing the exact same class (Open Resource
    // Requests, Overbooked Resources, Active Projects, Delivery Health) — an
    // unscoped query over the whole fixture would pass even if the wrong
    // tile's numbers leaked in, which is exactly the failure mode this
    // block's reviews keep catching on shared-class siblings.
    const tile = host.querySelector('[data-test="bench-tile"]');
    expect(tile).not.toBeNull();
    const tileText = tile!.textContent ?? '';

    // Separate assertions per count — a single test asserting "shows 2 and 1"
    // as one combined string would still pass if the two numbers were
    // swapped (1 internal / 2 subco), which is a real, distinct defect this
    // must catch on its own.
    expect(tileText).toContain('2');
    expect(tileText).toContain('int.');
    expect(tileText).toContain('1');
    expect(tileText).toContain('subco');

    // The never-summed guarantee (design spec decision 4): 2 internal + 1
    // subco must never render as a combined "3" anywhere in the tile.
    expect(tileText).not.toContain('3');

    // Assert the underlying computed signals directly too, not just the
    // rendered string (a rendered '2' could coincidentally come from
    // somewhere else in the tile's markup, e.g. a stray count elsewhere).
    const comp = fixture.componentInstance;
    expect(comp.internalBenchCount()).toBe(2);
    expect(comp.subcoBenchCount()).toBe(1);
  });

  it('renders zero for both counts when the bench rollup has no BENCH rows for the current month', async () => {
    // Explicit override (rather than relying on makeApiStub's own default)
    // so this test still documents its input even if that default changes.
    const { fixture } = await render('finance', {
      getBenchMonthly: vi.fn(() => of(EMPTY_BENCH_ROLLUP)),
    });

    const comp = fixture.componentInstance;
    expect(comp.internalBenchCount()).toBe(0);
    expect(comp.subcoBenchCount()).toBe(0);
  });
});

/**
 * The tile's anchor month, under a clock pinned to an instant where UTC and the local
 * civil date DISAGREE, in a window that does not start at the current month.
 *
 * Three wrong implementations all survive a TZ-blind version of this test, and this
 * project has recorded that failure nine times: `months[0]` (what shipped — the
 * server anchors the window on the oldest Open planning period, four months back with
 * the seed), `new Date().toISOString().slice(0, 7)` (names September while the local
 * calendar says 1 October), and an anchor that always answers '' (which satisfies
 * every "must be absent" assertion on its own).
 *
 * TZ is forced, not sniffed: on a UTC runner nothing can make local and UTC disagree,
 * and a test that silently skips its own point is a green gate.
 */
describe('Dashboard "In Bench" tile — the anchor month is TODAY, in the LOCAL calendar', () => {
  const ORIGINAL_TZ = process.env['TZ'];
  /** UTC+14, no DST ever: 2026-09-30T23:00Z is 2026-10-01T13:00 local. */
  const LOCAL_MONTH = '2026-10';
  const UTC_MONTH = '2026-09';
  const bench = { state: 'BENCH' as const, upcomingUnallocated: false };
  const allocated = { state: 'ALLOCATED' as const, upcomingUnallocated: false };

  beforeAll(() => {
    setTz('Pacific/Kiritimati');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 23, 0)));
  });
  afterAll(() => {
    vi.useRealTimers();
    setTz(ORIGINAL_TZ);
    TestBed.resetTestingModule();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('has a fixture whose local and UTC months genuinely differ (the precondition, not an assumption)', () => {
    expect(todayLocalIso().slice(0, 7)).toBe(LOCAL_MONTH);
    expect(new Date().toISOString().slice(0, 7)).toBe(UTC_MONTH);
  });

  it('counts the LOCAL current month, not months[0] and not the UTC month (the case that must still be ALLOWED)', async () => {
    const rollup: BenchRollup = {
      months: ['2026-08', UTC_MONTH, LOCAL_MONTH],
      internalRows: [{
        resourceId: 'int-1', resourceName: 'Anchor Person', kind: 'internal',
        monthly: { '2026-08': allocated, [UTC_MONTH]: allocated, [LOCAL_MONTH]: bench },
        availabilityDate: { kind: 'date', date: '2026-10-01' },
      }],
      subcoRows: [{
        resourceId: 'sub-1', resourceName: 'Anchor Subco', kind: 'subco',
        monthly: { '2026-08': allocated, [UTC_MONTH]: allocated, [LOCAL_MONTH]: bench },
        availabilityDate: { kind: 'date', date: '2026-10-01' },
      }],
      hiringDemand: [],
    };
    const { fixture } = await render('finance', { getBenchMonthly: vi.fn(() => of(rollup)) });
    const comp = fixture.componentInstance;
    // RED three ways: months[0] and the UTC month both read ALLOCATED, and an
    // always-empty anchor reads nothing.
    expect(comp.internalBenchCount()).toBe(1);
    expect(comp.subcoBenchCount()).toBe(1);
    const tile = (fixture.nativeElement as HTMLElement).querySelector('[data-test="bench-tile"]');
    expect(tile!.querySelector('[data-test="bench-tile-month"]')!.textContent).toContain('Oct 26');
  });

  it('counts nothing — and says the window has no present tense — when the window stops short of today', async () => {
    const rollup: BenchRollup = {
      months: ['2026-07', '2026-08', UTC_MONTH],
      internalRows: [{
        resourceId: 'int-1', resourceName: 'Stale Judgement Person', kind: 'internal',
        monthly: { '2026-07': bench, [UTC_MONTH]: bench },
        availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: UTC_MONTH },
      }],
      subcoRows: [],
      hiringDemand: [],
    };
    const { fixture } = await render('finance', { getBenchMonthly: vi.fn(() => of(rollup)) });
    const comp = fixture.componentInstance;
    expect(comp.internalBenchCount()).toBe(0);
    // THE ABSENCE TWIN: today this reads 1, from a July cell presented as now.
    const tile = (fixture.nativeElement as HTMLElement).querySelector('[data-test="bench-tile"]')!;
    expect(tile.textContent).toContain('0');
    // ...and a bare "0 / 0" must not be allowed to pass for "nobody is benched":
    // only the `includes()` form can tell those apart.
    expect(tile.querySelector('[data-test="bench-tile-month"]')!.textContent)
      .toContain('Current month not in window');
  });
});

describe('Dashboard — Baseline vs Planned portfolio tile (design spec, block E)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the portfolio Baseline vs Planned delta for a finance reader', async () => {
    // Mirrors Task 1's own seeded fixture exactly (720 planned, 600 frozen ->
    // +120 EUR / +20.00%), so this figure is hand-verifiable the same way as
    // the Project 360 card (Task 6) and Task 1's seed comment.
    const { fixture } = await render('finance', {
      getProjects: vi.fn(() => of([
        { id: 'P1', name: 'Project One', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' },
      ])),
      getRequests: vi.fn(() => of([{ id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled', skills: [], projectId: 'P1' }])),
      getAssignments: vi.fn(() => of([{ id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' }])),
      getResources: vi.fn(() => of([{ id: 'R1', name: 'Res', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 90, billRate: 180 }])),
      getAssignmentDays: vi.fn(() => of([{ id: 'A1:2026-10-05', assignmentId: 'A1', date: '2026-10-05', hours: 8 }])),
      getAssignmentMonths: vi.fn(() => of([{ id: 'A1:2026-10', assignmentId: 'A1', month: '2026-10', status: 'Allocated' }])),
      getCostBaselines: vi.fn(() => of([{ id: 'CB1', projectId: 'P1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T00:00:00.000Z', frozenBy: 'u4' }])),
    });

    // Planned (720) - baseline (600) = +120 EUR portfolio-wide, the same
    // hand-verified figure as the seed fixture (Task 1) and the Project 360
    // card (Task 6).
    expect(fixture.nativeElement.textContent).toContain('Baseline vs Planned');
    // Scoped to the tile itself (this dashboard has several sibling
    // .command-kpi tiles sharing the same class, e.g. VAC/Portfolio EAC —
    // an unscoped page-wide query is exactly the failure mode this project's
    // reviews keep catching on shared-class siblings) AND checked for the
    // EXACT sign: Angular's CurrencyPipe renders a negative amount as
    // "-€120", which a bare `.toContain('€120')` would still match — that
    // substring check cannot tell +120 from -120 apart, so a sign-flip
    // mutation would pass silently. Assert the precise rendered string
    // instead of a loose substring.
    const host = fixture.nativeElement as HTMLElement;
    const tile = host.querySelector('[data-test="baseline-tile"]');
    expect(tile).not.toBeNull();
    const tileText = tile!.textContent ?? '';
    expect(tileText).toContain('€120');
    expect(tileText).not.toContain('-€120');
  });

  // COORDINATOR-CAUGHT DEFECT: totalBaselineDelta/totalBaselineAmount must
  // restrict to periods with a current baseline row, never sum across
  // costBaselineComparison's full period union — which also includes every
  // out-of-horizon month (booked hours, baseline 0). Summing planned cost
  // across never-frozen months into the numerator, against a denominator
  // that only ever contains the frozen periods, compares two different
  // populations: on the real seed this produced a numerator around 235k EUR
  // against a ~1,100 EUR denominator — a five-digit percentage. The single-
  // month fixture above never exercises this (one period means "sum
  // everything" and "sum only frozen periods" coincide).
  it('restricts the portfolio total to periods with a current baseline row, never summing a never-frozen month into the ratio', async () => {
    const { fixture } = await render('finance', {
      getProjects: vi.fn(() => of([
        { id: 'P1', name: 'Project One', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' },
      ])),
      getRequests: vi.fn(() => of([{ id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled', skills: [], projectId: 'P1' }])),
      getAssignments: vi.fn(() => of([{ id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' }])),
      getResources: vi.fn(() => of([{ id: 'R1', name: 'Res', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 100, billRate: 200 }])),
      // January: booked, NO baseline row at all (never frozen) -> out of
      // horizon, baseline 0, planned 1000 (10h x 100 EUR/h). February: booked
      // AND frozen at 400 -> planned 500 (5h x 100), delta 100.
      getAssignmentDays: vi.fn(() => of([
        { id: 'A1:2026-01-05', assignmentId: 'A1', date: '2026-01-05', hours: 10 },
        { id: 'A1:2026-02-05', assignmentId: 'A1', date: '2026-02-05', hours: 5 },
      ])),
      getAssignmentMonths: vi.fn(() => of([
        { id: 'A1:2026-01', assignmentId: 'A1', month: '2026-01', status: 'Allocated' },
        { id: 'A1:2026-02', assignmentId: 'A1', month: '2026-02', status: 'Allocated' },
      ])),
      getCostBaselines: vi.fn(() => of([{ id: 'CB_FEB', projectId: 'P1', period: '2026-02', amount: 400, frozenAt: '2026-01-15T00:00:00.000Z', frozenBy: 'u4' }])),
    });

    const host = fixture.nativeElement as HTMLElement;
    const tile = host.querySelector('[data-test="baseline-tile"]');
    expect(tile).not.toBeNull();
    const tileText = tile!.textContent ?? '';
    // Restricted (correct): only February counts (has a frozen row).
    // baseline 400, planned 500, delta 100, deltaPct 25.00%.
    // UNRESTRICTED (the defect this pins): delta 1100 (Jan's 1000 + Feb's
    // 100), deltaPct 275% against the same 400 EUR denominator.
    expect(tileText).toContain('€100');
    expect(tileText).not.toContain('€1,100');
    expect(tileText).toContain('25.00%');
    expect(tileText).not.toContain('275');
  });

  it('is absent for a pm — portfolio dashboard stays finance/delivery-executive/admin only, unchanged by this block', async () => {
    const { fixture } = await render('pm');
    expect(fixture.nativeElement.textContent).not.toContain('Baseline vs Planned');
  });
});

// -----------------------------------------------------------------------------
// BLOCK H — Q2 (fully-loaded portfolio margin) and U7/U8 (a fourth bench state).
//
// jsdom DOES NOT LAY OUT: nothing here can prove a tile is legible or unclipped.
// Every assertion below is structural — a label, a note, a computed count.
// -----------------------------------------------------------------------------

/**
 * The same four project shapes /reporting's spec uses, for the same reason: a
 * billable control, a non-billable NON-basket, a Basket, and a row carrying NO
 * `billable` field (which must read as billable). Rates are 100/200 EUR per hour
 * so every figure is a product of two numbers written here.
 *
 *   PB  revenue 100000  cost 300h x 100 = 30000   billable
 *   PN  revenue      0  cost 100h x 100 = 10000   NON-billable (Delivery)
 *   PK  revenue      0  cost  40h x 100 =  4000   NON-billable (Basket)
 *   PL  revenue  20000  cost  50h x 100 =  5000   billable by DEFAULT
 *
 *   fully loaded = 120000 - 35000 - 14000 = 71000  (59.17%)
 *
 * The point of running it HERE as well: this tile's pre-H arithmetic was an
 * unfiltered sum over every project, so the headline must come out at the SAME
 * 71000 either way. That equality is the thing to confirm, not to assume — it is
 * the whole reason the label had to change when the number did not.
 */
const H_PROJECTS = [
  { id: 'PB', name: 'Billable Delivery', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', billable: true, type: 'Delivery' },
  { id: 'PN', name: 'Internal Platform', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', billable: false, type: 'Delivery' },
  { id: 'PK', name: 'BASKET Engineering', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', billable: false, type: 'Basket' },
  { id: 'PL', name: 'Legacy Row', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' },
];

const H_PROJECTS_UNFLAGGED = H_PROJECTS.map(p => {
  const copy: Partial<typeof p> = { ...p };
  delete copy.billable;
  delete copy.type;
  return copy;
});

function hMoneyOverrides(projects: unknown[]) {
  return {
    getProjects: vi.fn(() => of(projects)),
    getResources: vi.fn(() => of([
      { id: 'R1', name: 'Rita One', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 80, capacity: 40, kind: 'internal', costRate: 100, billRate: 200 },
      { id: 'R2', name: 'Ravi Two', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 60, capacity: 40, kind: 'internal', costRate: 100, billRate: 200 },
    ])),
    getTimeEntries: vi.fn(() => of([
      { id: 'T1', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PB', date: '2026-05-04', hours: 300, status: 'Approved' },
      { id: 'T2', assignmentId: 'a', requestId: 'r', resourceId: 'R2', projectId: 'PN', date: '2026-05-04', hours: 100, status: 'Approved' },
      { id: 'T3', assignmentId: 'a', requestId: 'r', resourceId: 'R2', projectId: 'PK', date: '2026-05-04', hours: 40, status: 'Approved' },
      { id: 'T4', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PL', date: '2026-05-04', hours: 50, status: 'Approved' },
    ])),
    getOrders: vi.fn(() => of([{ id: 'O1', contractId: 'CT', type: 'Customer', amount: 120000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-01-01' }])),
    getOrderLines: vi.fn(() => of([
      { id: 'L-PB', orderId: 'O1', projectId: 'PB', description: 'x', amount: 100000 },
      { id: 'L-PL', orderId: 'O1', projectId: 'PL', description: 'x', amount: 20000 },
    ])),
  } as unknown as Partial<Record<(typeof DASHBOARD_METHODS)[number], ReturnType<typeof vi.fn>>>;
}

function marginTile(fixture: { nativeElement: unknown }): HTMLElement {
  const tile = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-test="portfolio-margin-tile"]');
  expect(tile, 'the portfolio margin tile must exist').not.toBeNull();
  return tile!;
}

describe('Dashboard — the portfolio margin tile is FULLY LOADED and says so (Q2; structure only, jsdom does not lay out)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names "fully loaded" in the LABEL and reconciles the figure with a project delivery margin', async () => {
    const { fixture } = await render('finance', hMoneyOverrides(H_PROJECTS));
    const tile = marginTile(fixture);

    const label = tile.querySelector('.command-kpi-label')?.textContent ?? '';
    expect(label.toLowerCase()).toContain('fully loaded');

    // The figures, hand-derived above.
    const text = tile.textContent ?? '';
    expect(text).toContain('59.2%');
    expect(text).toContain('€71,000');
    expect(text).toContain('€120,000');

    const note = tile.querySelector('[data-test="fully-loaded-note"]')?.textContent ?? '';
    expect(note).toContain('€14,000');
    expect(note).toContain('2 engagements');
    expect(note.toLowerCase()).toContain('not comparable');
  });

  it('CONFIRMS Q2 — the headline does NOT move with the flags; only the split and the note do', async () => {
    // The answer worth confirming rather than hiding: this tile already summed
    // every project, so fully-loading it changes no digit. That is precisely why
    // the LABEL is the fix — a number whose meaning changed and whose value did
    // not is one nobody will notice on their own.
    const { fixture: flagged } = await render('finance', hMoneyOverrides(H_PROJECTS));
    // Snapshotted BEFORE the TestBed reset: these are signals, and re-reading one
    // after its injector is destroyed answers from the empty default — which
    // would silently turn the comparison below into "0 equals 0".
    const flaggedMargin = flagged.componentInstance.totalMargin();
    const flaggedRevenue = flagged.componentInstance.totalRevenue();
    const flaggedPct = flagged.componentInstance.portfolioMarginPct();
    const flaggedNote = marginTile(flagged).querySelector('[data-test="fully-loaded-note"]')?.textContent ?? '';
    const flaggedSplit = flagged.componentInstance['portfolioMargin']().nonBillableCost;

    TestBed.resetTestingModule();

    const { fixture: plain } = await render('finance', hMoneyOverrides(H_PROJECTS_UNFLAGGED));
    const without = plain.componentInstance;

    expect(flaggedMargin).toBe(71000);
    expect(flaggedPct).toBeCloseTo(59.1667, 3);
    expect(without.totalMargin()).toBe(flaggedMargin);
    expect(without.totalRevenue()).toBe(flaggedRevenue);
    expect(without.portfolioMarginPct()).toBeCloseTo(flaggedPct, 9);

    // …and what DOES move, so this is not a test that would pass against a tile
    // wired to a constant.
    expect(flaggedSplit).toBe(14000);
    expect(without['portfolioMargin']().nonBillableCost).toBe(0);
    expect(without['portfolioMargin']().nonBillableProjectIds).toStrictEqual([]);

    const plainNote = marginTile(plain).querySelector('[data-test="fully-loaded-note"]')?.textContent ?? '';
    expect(plainNote.toLowerCase()).toContain('no non-billable engagement');
    expect(plainNote).not.toBe(flaggedNote);
  });

  it('treats the row with NO billable field as billable, never as an unflagged basket', async () => {
    const { fixture } = await render('finance', hMoneyOverrides(H_PROJECTS));
    const ids = fixture.componentInstance['portfolioMargin']().nonBillableProjectIds;
    expect(ids).not.toContain('PL');
    expect(ids).toStrictEqual(['PK', 'PN']);
  });

  it('carries the cost of an engagement that has approved time but NO project master row', async () => {
    // The universe widened from `data().projects` to `attributableProjectIds`,
    // and this is the case that separates them. It is also the ONLY thing on this
    // screen that can catch a revert to the old open-coded sum: that sum happened
    // to equal the fully-loaded figure on every project the master data knows
    // about, so with a tidy fixture the revert is arithmetically invisible here.
    // A total whose purpose is to carry every euro must not lose one to a missing
    // row.
    const base = hMoneyOverrides(H_PROJECTS);
    const { fixture } = await render('finance', {
      ...base,
      getTimeEntries: vi.fn(() => of([
        { id: 'T1', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PB', date: '2026-05-04', hours: 300, status: 'Approved' },
        { id: 'T2', assignmentId: 'a', requestId: 'r', resourceId: 'R2', projectId: 'PN', date: '2026-05-04', hours: 100, status: 'Approved' },
        { id: 'T3', assignmentId: 'a', requestId: 'r', resourceId: 'R2', projectId: 'PK', date: '2026-05-04', hours: 40, status: 'Approved' },
        { id: 'T4', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PL', date: '2026-05-04', hours: 50, status: 'Approved' },
        // The ghost: 20h x 100 = 2000 of real cost on an id no `projects` row covers.
        { id: 'T5', assignmentId: 'a', requestId: 'r', resourceId: 'R2', projectId: 'PG', date: '2026-05-04', hours: 20, status: 'Approved' },
      ])),
    });

    const c = fixture.componentInstance;
    // 71000 - 2000. The pre-H sum over `data().projects` answers 71000 and loses
    // the ghost's cost entirely.
    expect(c.totalMargin()).toBe(69000);
    // An unresolvable id is BILLABLE by the same `?? true` rule as everywhere
    // else, so its cost lands in deliveryCost, not in the non-billable bucket.
    expect(c['portfolioMargin']().deliveryCost).toBe(37000);
    expect(c['portfolioMargin']().nonBillableProjectIds).toStrictEqual(['PK', 'PN']);
  });
});

describe('Dashboard "In Bench" tile — an ABSENT row leaves the counts (U7/U8; structure only, jsdom does not lay out)', () => {
  afterEach(() => TestBed.resetTestingModule());

  const bench = { state: 'BENCH' as const, upcomingUnallocated: false };
  const absent = { state: 'ABSENT' as const, upcomingUnallocated: false };

  /**
   * Two internals and two subcos, with ONE cell per kind as the variable. Calling
   * this twice — 'BENCH' then 'ABSENT' — is the differential: the fixtures are one
   * state value apart per kind, and the tile must disagree on both counts.
   *
   * The subco half is not symmetry for its own sake: a subcontractor can be off
   * sick, and if the fourth state were only threaded through the internal rows
   * `subcoBenchCount` would stay false AND green (spec §8.3, fixture S4).
   */
  function rollup(variable: BenchCell): BenchRollup {
    const month = todayLocalIso().slice(0, 7);
    return {
      months: [month],
      internalRows: [
        { resourceId: 'int-1', resourceName: 'Steady Internal', kind: 'internal', monthly: { [month]: bench }, availabilityDate: { kind: 'date', date: month + '-01' } },
        { resourceId: 'int-2', resourceName: 'Variable Internal', kind: 'internal', monthly: { [month]: variable }, availabilityDate: { kind: 'date', date: month + '-01' } },
      ],
      subcoRows: [
        { resourceId: 'sub-1', resourceName: 'Steady Subco', kind: 'subco', monthly: { [month]: bench }, availabilityDate: { kind: 'date', date: month + '-01' } },
        { resourceId: 'sub-2', resourceName: 'Variable Subco', kind: 'subco', monthly: { [month]: variable }, availabilityDate: { kind: 'date', date: month + '-01' } },
      ],
      hiringDemand: [],
    };
  }

  it('DIFFERENTIAL — the same four rows, one state apart, give different bench counts for BOTH kinds', async () => {
    const { fixture: benched } = await render('finance', { getBenchMonthly: vi.fn(() => of(rollup(bench))) });
    const before = { int: benched.componentInstance.internalBenchCount(), sub: benched.componentInstance.subcoBenchCount() };

    TestBed.resetTestingModule();

    const { fixture: away } = await render('finance', { getBenchMonthly: vi.fn(() => of(rollup(absent))) });
    const after = away.componentInstance;

    // PRESENCE: a BENCH row is counted.
    expect(before).toStrictEqual({ int: 2, sub: 2 });
    // ABSENCE: the very same row, flipped to ABSENT, is not — the headline
    // correction, asserted rather than deduced from "the fourth state does it".
    expect(after.internalBenchCount()).toBe(1);
    expect(after.subcoBenchCount()).toBe(1);
    // …and the person did not vanish: she moved to the away counts.
    expect(after.internalAbsentCount()).toBe(1);
    expect(after.subcoAbsentCount()).toBe(1);
  });

  it('says who left the counts, without saying why, and says nothing when nobody did', async () => {
    const { fixture: away } = await render('finance', { getBenchMonthly: vi.fn(() => of(rollup(absent))) });
    const tile = (away.nativeElement as HTMLElement).querySelector('[data-test="bench-tile"]')!;
    const line = tile.querySelector('[data-test="bench-tile-away"]')?.textContent ?? '';
    expect(line).toContain('1 int.');
    expect(line).toContain('1 subco');
    expect(line).toContain('away on leave');

    // PRIVACY over the whole page: an absence reason is special-category data and
    // never reaches this screen — /bench/monthly carries none to render.
    const page = (away.nativeElement as HTMLElement).textContent ?? '';
    for (const reason of ABSENCE_REASON_CODES) expect(page).not.toContain(reason);
    // Vacuity control: the scan ran against a page that DID render the marking.
    expect(page).toContain('away on leave');

    TestBed.resetTestingModule();

    // THE ABSENCE TWIN: the line is data-driven, not a permanent footnote.
    const { fixture: benched } = await render('finance', { getBenchMonthly: vi.fn(() => of(rollup(bench))) });
    expect((benched.nativeElement as HTMLElement).querySelector('[data-test="bench-tile-away"]')).toBeNull();
  });
});

describe('Dashboard — the Risk & Escalation "Issues" chip tracks the queue', () => {
  afterEach(() => TestBed.resetTestingModule());

  function issue(over: Partial<Issue> = {}): Issue {
    return {
      id: 'I1', projectId: 'P1', title: 'Integration blocked', type: 'Risk',
      severity: 'Critical', status: 'Open', reportedBy: 'u1', ...over,
    };
  }

  /**
   * The Risk & Escalation card lives inside `@defer (hydrate on viewport)`, and a
   * defer block never plays through on its own in TestBed — only its placeholder
   * skeleton renders. Drive the blocks to Complete explicitly, or every assertion
   * below would be made against a skeleton and pass for the wrong reason (the
   * chip helper's own not-null check is what surfaces that).
   */
  async function renderRiskQueue(issues: Issue[]) {
    const { fixture } = await render('finance', { getProjectIssues: vi.fn(() => of(issues)) });
    for (const block of await fixture.getDeferBlocks()) await block.render(DeferBlockState.Complete);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  const chip = (fixture: { nativeElement: unknown }): HTMLElement => {
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('a[href="/project-issues"]');
    expect(el, 'the Risk & Escalation header chip must exist').not.toBeNull();
    return el!;
  };

  /*
   * BOTH data states are asserted on the SAME element inside ONE test. The chip
   * used to carry `red` in its static class list, so the green all-clear branch
   * was dead by cascade order (styles.css declares .command-status.red AFTER
   * .green) and a clean queue rendered in the same alarm tone as forty open
   * criticals. Asserting only the populated case is a class-string tautology;
   * asserting only the empty case would pass against a chip that is never red.
   */
  it('is green with an empty queue and red with an unresolved Critical — never both, never neither', async () => {
    const clear = chip(await renderRiskQueue([]));
    expect(clear.classList.contains('red')).toBe(false);
    expect(clear.classList.contains('green')).toBe(true);
    // The card body already said "No critical escalations currently open." while
    // the header shouted red — assert the two halves now agree.
    expect((clear.closest('.command-card') as HTMLElement).textContent)
      .toContain('No critical escalations currently open.');

    TestBed.resetTestingModule();

    const alarmed = chip(await renderRiskQueue([issue()]));
    expect(alarmed.classList.contains('red')).toBe(true);
    expect(alarmed.classList.contains('green')).toBe(false);
  });

  it('stays green for an issue that is Resolved or below High, matching criticalRisks()', async () => {
    // The chip must follow the SAME predicate as the queue beneath it: a resolved
    // Critical and an open Low are both all-clear. Without this row, a chip that
    // simply went "red when any issue exists" would pass the test above.
    const fixture = await renderRiskQueue([
      issue({ id: 'I-done', severity: 'Critical', status: 'Resolved' }),
      issue({ id: 'I-low', severity: 'Low', status: 'Open' }),
    ]);
    expect(fixture.componentInstance.criticalRisks()).toBe(0);
    const el = chip(fixture);
    expect(el.classList.contains('red')).toBe(false);
    expect(el.classList.contains('green')).toBe(true);
  });

  it('goes red for an escalated issue of any severity — the third clause of criticalRisks()', async () => {
    const fixture = await renderRiskQueue([issue({ severity: 'Low', escalated: true })]);
    expect(fixture.componentInstance.criticalRisks()).toBe(1);
    const el = chip(fixture);
    expect(el.classList.contains('red')).toBe(true);
    expect(el.classList.contains('green')).toBe(false);
  });
});

describe('Dashboard — the 11-endpoint load window announces itself', () => {
  afterEach(() => TestBed.resetTestingModule());

  /**
   * One leg that never emits keeps the forkJoin — and so isLoading() — pending.
   * That also means the app is never stable, so this cannot go through the shared
   * `render()` helper: its `await fixture.whenStable()` would hang on the very
   * pending task the test is about. Render synchronously instead.
   */
  function renderInFlight() {
    const api = { ...makeApiStub(), getResources: vi.fn(() => NEVER) };
    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: makeAuthStub('finance') },
      ],
    });
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('exposes a polite busy live region naming the load while the portfolio read is in flight', () => {
    const fixture = renderInFlight();
    const page = fixture.nativeElement as HTMLElement;

    // Scoped by its own text: the ListState wrappers elsewhere on this page own
    // their own [role=status] skeleton regions, so a bare querySelector could be
    // satisfied by one of those and prove nothing about this container.
    const regions = Array.from(page.querySelectorAll('[role="status"][aria-live="polite"][aria-busy="true"]'));
    const region = regions.find(r => (r.textContent ?? '').includes('Loading delivery command center'));
    expect(region, 'the portfolio load region must be a named polite live region').toBeDefined();

    // Assertion of ABSENCE: aria-label on a role-less div names nothing, so it
    // must not survive as the text source — otherwise this could go green by
    // adding a role while leaving the nameless-generic shape in place.
    expect(page.querySelector('div[aria-label^="Loading"]:not([role])')).toBeNull();
  });

  it('does not leave a busy live region behind once the portfolio has resolved', async () => {
    // The pair: the two data states must DIFFER on this element, so a region
    // hard-coded into the template cannot satisfy both halves.
    const { fixture } = await render('finance');
    const page = fixture.nativeElement as HTMLElement;
    expect(page.textContent ?? '').not.toContain('Loading delivery command center');
    // …and the tiles it stood in for did render, so this is not green merely
    // because the page produced nothing.
    expect(page.textContent ?? '').toContain('Portfolio Financials');
  });
});

// -----------------------------------------------------------------------------
// Token arithmetic for the red FIGURE colour. The ratio is COMPUTED
// (OKLCH -> linear sRGB -> WCAG relative luminance), never restated as a token
// name: asserting the name would be green against today's failing 4.47:1, a trap
// this project has already paid for.
// -----------------------------------------------------------------------------

const GLOBAL_CSS = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const DASHBOARD_SRC = readFileSync(resolve(process.cwd(), 'src/app/dashboard/dashboard.component.ts'), 'utf8');

/** The declarations of one flat CSS rule (this stylesheet has no nested braces). */
function cssBlock(css: string, selector: string): string {
  const needle = `${selector} {`;
  const at = css.indexOf(needle);
  expect(at, `CSS selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(at + needle.length, css.indexOf('}', at));
}

interface Oklch { l: number; c: number; h: number }

function token(block: string, name: string): Oklch {
  const m = new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`).exec(block);
  expect(m, `token not found: ${name}`).not.toBeNull();
  const [l, c, h] = m![1].trim().split(/\s+/).map(Number);
  return { l, c, h: h ?? 0 };
}

/** OKLCH -> OKLab -> linear sRGB (Ottosson) -> WCAG relative luminance Y. */
function luminance({ l, c, h }: Oklch): number {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const bb = c * Math.sin(rad);
  const lc = (l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  // Linear sRGB IS the gamma-decoded channel WCAG defines luminance over, so the
  // clamped values feed the 0.2126/0.7152/0.0722 sum directly.
  const r = clamp(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc);
  const g = clamp(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc);
  const b = clamp(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(x: Oklch, y: Oklch): number {
  const a = luminance(x);
  const b = luminance(y);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

describe('Negative money/hours read at AA in dark theme (computed ratio, not a token name)', () => {
  const dark = cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]');
  const aliases = cssBlock(GLOBAL_CSS, ':root');

  /** Sanity-check the conversion itself against two values with known ratios. */
  it('computes WCAG ratios the arithmetic can be trusted on', () => {
    // Pure white on pure black is exactly 21:1 by definition; identical colours
    // are exactly 1:1. Without this row, every ratio below could be wrong in the
    // same direction and the suite would still look green.
    expect(contrast({ l: 1, c: 0, h: 0 }, { l: 0, c: 0, h: 0 })).toBeCloseTo(21, 2);
    expect(contrast({ l: 0.62, c: 0.2, h: 25 }, { l: 0.62, c: 0.2, h: 25 })).toBeCloseTo(1, 6);
  });

  it('resolves --cc-red-text to a shade that clears 4.5:1 where the raw fill tone does not', () => {
    const critical = token(dark, '--color-critical');
    const criticalText = token(dark, '--color-critical-text');
    const surface = token(dark, '--color-surface');
    const surfaceMuted = token(dark, '--color-surface-muted');

    // Why the alias had to exist: the fill tone is BELOW AA as text on both the
    // plain and the zebra row. This half is the assertion of absence — it proves
    // the -text shade does real work rather than being a second name for one
    // colour, which is what an equality on token NAMES would have allowed.
    expect(contrast(critical, surface)).toBeLessThan(4.5);
    expect(contrast(critical, surfaceMuted)).toBeLessThan(4.5);

    // …and the shade the alias points at clears AA on both.
    expect(contrast(criticalText, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(criticalText, surfaceMuted)).toBeGreaterThanOrEqual(4.5);

    // Ties the ratio to the token the app actually writes: without this the
    // arithmetic could be green while --cc-red-text aliased something else.
    expect(aliases).toMatch(/--cc-red-text:\s*var\(--color-critical-text\)/);
  });

  it('gives the red figure the same treatment as the green one beside it', () => {
    const surface = token(dark, '--color-surface');
    // The reported defect was the DISPARITY: a positive VAC at ~10.8:1 next to a
    // negative VAC at 4.47:1 in the same column. Both must now clear AA.
    expect(contrast(token(dark, '--color-positive-text'), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(dark, '--color-critical-text'), surface)).toBeGreaterThanOrEqual(4.5);
  });

  /*
   * Source scan, scoped to the two files this batch owns. The register lists
   * three further TEXT sites — forecast.ts:170 and :247, and what-if.ts:344 —
   * which belong to another batch's files; add them to SCANNED when they land.
   */
  const SCANNED: readonly (readonly [string, string])[] = [
    ['src/styles.css', GLOBAL_CSS],
    ['src/app/dashboard/dashboard.component.ts', DASHBOARD_SRC],
  ];

  /**
   * Every WHOLE LINE that puts a token in a foreground position: a `color:`
   * declaration (never `border-top-color:` — that one must keep the fill tone),
   * a `[style.color]` binding, or a `text-[var(--tok)]` utility class.
   */
  function colorLines(tok: string): string[] {
    const patterns = [
      new RegExp(`^.*(^|[^-\\w])color:\\s*var\\(${tok}\\).*$`, 'gm'),
      new RegExp(`^.*\\[style\\.color\\][^\\n]*var\\(${tok}\\).*$`, 'gm'),
      new RegExp(`^.*text-\\[var\\(${tok}\\)\\].*$`, 'gm'),
    ];
    return SCANNED.flatMap(([, src]) => patterns.flatMap(re => src.match(re) ?? []));
  }

  /** WCAG large text: >=24px, or >=18.66px bold. text-xl is 20px, text-3xl 30px. */
  const isLargeText = (line: string) =>
    /text-3xl/.test(line) || (/text-xl/.test(line) && /font-(semi)?bold/.test(line));

  it('uses the raw --cc-red as a foreground ONLY where the large-text 3:1 threshold applies', () => {
    const uses = colorLines('--cc-red');

    // Not `toEqual([])`: two sites keep the fill tone on purpose (the 30px
    // overbooked count and the 20px semibold utilization figure), where WCAG's
    // large-text threshold is 3:1. So the contract is per-site, and the
    // small-text sites — the figures a finance user reads to spot an overrun —
    // must all be gone.
    expect(uses.filter(line => !isLargeText(line))).toEqual([]);

    // The exemption is PROVEN, not assumed: the fill tone must actually clear
    // 3:1 on both the plain and the zebra row, or those two sites would be a
    // silent failure hiding behind an allow-list.
    const critical = token(dark, '--color-critical');
    expect(contrast(critical, token(dark, '--color-surface'))).toBeGreaterThanOrEqual(3);
    expect(contrast(critical, token(dark, '--color-surface-muted'))).toBeGreaterThanOrEqual(3);

    // Vacuity control: the identical scan must FIND the -text tokens that are
    // declared, proving it really reads these declarations, template bindings and
    // utility classes rather than matching nothing at all.
    expect(colorLines('--cc-red-text').length).toBeGreaterThan(0);
    expect(colorLines('--cc-green-text').length).toBeGreaterThan(0);
    // …and that isLargeText is not simply true for everything: the sites this
    // batch switched are small text and must be classified as such.
    expect(colorLines('--cc-red-text').filter(isLargeText)).toEqual([]);

    // The KPI border keeps the fill tone deliberately (a non-text 3:1 target),
    // so the scan must not have been made green by deleting --cc-red outright.
    expect(GLOBAL_CSS).toMatch(/border-top-color:\s*var\(--cc-red\)/);
  });
});

/**
 * B12 / P2-21 — the trailing windows behind the "vs prior period" chip and the
 * recognised-revenue chart close on the USER's current month.
 *
 * The clock is faked (Date only, so the runner's own timers and microtasks —
 * which `render()` awaits — keep working) and the timezone is pinned, because
 * neither half alone can see this: under TZ=UTC the UTC month and the local
 * month always agree, and without a fixed instant the assertion would have to be
 * computed from the same expression under test.
 *
 * 2026-08-31T23:30:00Z is 90 minutes before UTC's month end and 90 minutes AFTER
 * Rome's, which is the whole window in which the two disagree.
 */
describe('Dashboard trailing windows use the local civil month (P2-21)', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => {
    vi.useRealTimers();
    process.env['TZ'] = originalTz;
    TestBed.resetTestingModule();
  });

  function pin(tz: string, instant: string): void {
    process.env['TZ'] = tz;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
  }

  it('ends the window on the month the user is already in (positive offset)', async () => {
    pin('Europe/Rome', '2026-08-31T23:30:00.000Z'); // 01:30 on 1 September in Rome
    const { fixture } = await render('finance');

    // The pre-fix code read getUTCMonth() — still August — and showed a window
    // one month stale, with the chip comparing two equally stale windows.
    expect(fixture.componentInstance.trendPeriods).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(fixture.componentInstance.chartPeriods).toEqual(
      ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  });

  it('does not advance the window before the user reaches the month (negative offset)', async () => {
    pin('America/New_York', '2026-09-01T02:30:00.000Z'); // 22:30 on 31 August in New York
    const { fixture } = await render('finance');

    // The mirror error: UTC has rolled into September, the user has not.
    expect(fixture.componentInstance.trendPeriods).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(fixture.componentInstance.chartPeriods).toEqual(
      ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
  });
});

// -----------------------------------------------------------------------------
// The no-revenue margin-% sentinel must never render as "0%".
//
// finance.util computes every margin percentage as `revenue > 0 ? … : 0`. That
// 0 is a SENTINEL for "undefined", and printing it asserts break-even on an
// engagement that lost money. Non-billable engagements (H) earn no revenue BY
// CONSTRUCTION, so this is their normal state — which is what made a
// previously-unreachable rendering branch reachable on this screen.
//
// Both directions are asserted for every site. A test that only checked for the
// dash would pass against a component that renders a dash unconditionally, and
// a test that only checked the percentage would pass against the defect itself.
// `H_PROJECTS` gives both populations in ONE render: PB/PL carry revenue, PN/PK
// carry cost and none.
// -----------------------------------------------------------------------------

/**
 * Render with the control board actually PRESENT. The board lives inside
 * `@defer (hydrate on viewport)`, which never plays through on its own in
 * TestBed — without this, every row lookup below would find nothing and the
 * suite would report the absence of a defect it had not looked for.
 */
async function renderBoard(overrides: Partial<Record<(typeof DASHBOARD_METHODS)[number], ReturnType<typeof vi.fn>>>) {
  const { fixture } = await render('finance', overrides);
  for (const block of await fixture.getDeferBlocks()) await block.render(DeferBlockState.Complete);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

describe('Dashboard — actionable staffing demand is shared with Staffing and Reporting', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('counts and queues Published residual demand, while excluding full or non-workable requests', async () => {
    const requests: ResourceRequest[] = [
      { id: 'published-gap', name: 'Published design gap', requiredRole: 'Designer', requiredEffort: 15, staffedEffort: 8, status: 'Published', skills: [] },
      { id: 'open-gap', name: 'Open engineering gap', requiredRole: 'Developer', requiredEffort: 20, staffedEffort: 5, status: 'Open', skills: [] },
      { id: 'published-full', name: 'Published but full', requiredRole: 'PM', requiredEffort: 10, staffedEffort: 10, status: 'Published', skills: [] },
      { id: 'open-over', name: 'Open but overstaffed', requiredRole: 'PM', requiredEffort: 10, staffedEffort: 12, status: 'Open', skills: [] },
      { id: 'draft-gap', name: 'Draft gap', requiredRole: 'PM', requiredEffort: 30, staffedEffort: 0, status: 'Not Published', skills: [] },
    ];
    const fixture = await renderBoard({ getRequests: vi.fn(() => of(requests)) });
    const component = fixture.componentInstance;

    expect(component.openRequests()).toBe(2);
    expect(component.demandQueue().map(request => request.id)).toStrictEqual(['open-gap', 'published-gap']);

    const host = fixture.nativeElement as HTMLElement;
    const kpi = [...host.querySelectorAll<HTMLElement>('.command-card-muted')]
      .find(card => card.querySelector('.command-kpi-label')?.textContent?.includes('Open Resource Requests'));
    expect(kpi, 'the open-request KPI must render').toBeDefined();
    expect(kpi!.textContent).toContain('2');

    const demandHeading = [...host.querySelectorAll('h2')].find(h => h.textContent?.includes('Demand Queue'));
    const queue = demandHeading?.closest('section');
    expect(queue, 'the deferred demand queue must render').not.toBeNull();
    expect(queue!.textContent).toContain('Published design gap');
    expect(queue!.textContent).toContain('Open engineering gap');
    expect(queue!.textContent).not.toContain('Published but full');
    expect(queue!.textContent).not.toContain('Draft gap');
  });
});

/** The control-board row whose first cell names `project`, with its margin-% cell. */
function marginCellFor(fixture: { nativeElement: unknown }, project: string): HTMLElement {
  const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr'));
  const row = rows.find(r => (r.querySelector('td')?.textContent ?? '').includes(project));
  expect(row, `a control-board row for ${project} must exist`).toBeTruthy();
  const cell = row!.querySelector<HTMLElement>('[data-test="project-margin-pct"]');
  expect(cell, `${project}'s row must carry a margin-% cell`).not.toBeNull();
  return cell!;
}

describe('Dashboard — a margin % is rendered only where revenue makes it measurable', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('prints the real percentage for the engagements that DO carry revenue', async () => {
    const fixture = await renderBoard(hMoneyOverrides(H_PROJECTS));

    // PB: revenue 100000, cost 300h x 100 = 30000 -> margin 70000 -> 70.0%
    expect(marginCellFor(fixture, 'Billable Delivery').textContent).toContain('70%');
    // PL: revenue 20000, cost 50h x 100 = 5000 -> margin 15000 -> 75.0%
    expect(marginCellFor(fixture, 'Legacy Row').textContent).toContain('75%');
  });

  it('prints an em dash — never "0%" — for the engagements that carry NONE', async () => {
    const fixture = await renderBoard(hMoneyOverrides(H_PROJECTS));

    for (const name of ['Internal Platform', 'BASKET Engineering']) {
      const text = marginCellFor(fixture, name).textContent ?? '';
      expect(text, `${name} has no revenue, so its margin % is undefined`).toContain('—');
      // The claim that matters. Before the fix this cell read "0.0%", beside a
      // negative margin, on a project that had lost every euro of its cost.
      expect(text, `${name} must not assert a percentage`).not.toContain('%');
    }
  });

  it('drops the margin METER with the figure — a bar at the 0 mark is the same claim', async () => {
    const fixture = await renderBoard(hMoneyOverrides(H_PROJECTS));

    const withRevenue = marginCellFor(fixture, 'Billable Delivery').parentElement!;
    const without = marginCellFor(fixture, 'BASKET Engineering').parentElement!;
    expect(withRevenue.querySelector('.command-meter'), 'a measured row keeps its meter').not.toBeNull();
    expect(without.querySelector('.command-meter'), 'an unmeasurable row must not draw one').toBeNull();
  });

  it('renders the PORTFOLIO tile percentage and its gauge while the portfolio earns revenue', async () => {
    const { fixture } = await render('finance', hMoneyOverrides(H_PROJECTS));
    const tile = marginTile(fixture);

    expect(fixture.componentInstance['hasPortfolioMarginPct']()).toBe(true);
    expect(tile.querySelector('[data-test="portfolio-margin-pct"]')?.textContent).toContain('59.2%');
    expect(tile.querySelector('command-donut-chart'), 'the gauge measures a real ratio here').not.toBeNull();
  });

  it('em-dashes the PORTFOLIO tile, drops its gauge and suppresses its tone when NOTHING earns revenue', async () => {
    // A portfolio of only non-billable work: real cost, no customer revenue.
    // `fullyLoadedMarginPct` is then the sentinel 0 — and "warning" fires on
    // [0,15), so before the fix this painted an amber tile off a number that
    // was never measured.
    const noRevenue = { ...hMoneyOverrides(H_PROJECTS), getOrderLines: vi.fn(() => of([])), getOrders: vi.fn(() => of([])) };
    const { fixture } = await render('finance', noRevenue);
    const tile = marginTile(fixture);

    expect(fixture.componentInstance.totalRevenue()).toBe(0);
    expect(fixture.componentInstance['hasPortfolioMarginPct']()).toBe(false);

    const pct = tile.querySelector('[data-test="portfolio-margin-pct"]')?.textContent ?? '';
    expect(pct).toContain('—');
    expect(pct).not.toContain('%');
    expect(tile.querySelector('command-donut-chart'), 'a ring measuring nothing must not be drawn').toBeNull();
    expect(tile.classList.contains('warning'), 'the sentinel must not tint the tile').toBe(false);
    expect(tile.classList.contains('danger')).toBe(false);

    // The margin AMOUNT is real and must survive: -49000 of cost carried.
    expect(fixture.componentInstance.totalMargin()).toBe(-49000);
    expect(tile.textContent).toContain('€49,000');
  });
});
