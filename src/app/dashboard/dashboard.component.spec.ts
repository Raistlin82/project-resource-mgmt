import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { DashboardComponent } from './dashboard.component';
import { ApiService, UserRole, type BenchRollup } from '../services/api.service';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';
import { AuthService } from '../services/auth.service';

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
 */
function makeBenchFixture(): BenchRollup {
  const month = '2026-04';
  const bench = { state: 'BENCH' as const, upcomingUnallocated: false };
  const partial = { state: 'PARTIAL' as const, upcomingUnallocated: false };
  const allocated = { state: 'ALLOCATED' as const, upcomingUnallocated: false };
  return {
    months: [month],
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

  it('is absent for a pm — portfolio dashboard stays finance/delivery-executive/admin only, unchanged by this block', async () => {
    const { fixture } = await render('pm');
    expect(fixture.nativeElement.textContent).not.toContain('Baseline vs Planned');
  });
});
