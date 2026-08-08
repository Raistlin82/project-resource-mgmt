import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { Reporting } from './reporting';
import { ABSENCE_REASON_CODES, ApiService, BillingPlanItem, Contract, NegotiatedRate, Project, Resource, TimeEntry, type BenchCell, type BenchRollup } from '../services/api.service';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';
import { todayLocalIso } from '../services/local-date.util';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { XlsxSheet } from '../services/export.util';

/** Cast an Angular fixture host to a typed element so `.querySelector<T>` compiles. */
function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * C1 regression pin: dummy and subco are capacity that does NOT exist yet, so
 * they must stay out of the portfolio's internal-capacity KPIs (spec §4.3/§4.4).
 *
 * Three internals averaging 80% plus three non-internals at 0% — exactly the
 * shape of the seeded demo set. Averaging all six gives 40%, half the truth,
 * and charting all six grows three flat-zero bars named after placeholders.
 */
const RESOURCES: Resource[] = [
  { id: '1', name: 'Julie Armstrong', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 90, capacity: 40, kind: 'internal' },
  { id: '2', name: 'John Miller', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 90, capacity: 40, kind: 'internal' },
  // No `kind` at all — a legacy row must read as internal (defensive kindOf).
  { id: '3', name: 'Alice Smith', role: 'Designer', skills: [], projectRoles: [], externalExperience: [], utilization: 60, capacity: 40 },
  { id: '4', name: 'Dummy — Senior Developer', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'dummy' },
  { id: '5', name: 'Dummy — Associate PMO', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'dummy' },
  { id: '6', name: 'Subco — Mediolanum Senior Developer', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'subco', vendorId: 'V4' },
];

// `authReady` defaults to true (every pre-existing test wants a settled
// principal); pass false to hold the gated multi-endpoint read in flight, which
// is the first clause dataLoading() keys on (reporting.ts:985) and the real
// deep-link state before the OIDC bootstrap settles.
async function setup(resources: Resource[] = RESOURCES, overrides: Partial<ApiService> = {}, authReady = true) {
  const empty = () => of([]);
  const apiStub = {
    getResources: vi.fn(() => of(resources)),
    getAssignments: empty,
    getRequests: empty,
    getProjects: empty,
    getOrders: empty,
    getOrderLines: empty,
    getProjectFinancials: empty,
    getTimeEntries: empty,
    getProjectIssues: empty,
    getChangeRequests: empty,
    getMilestones: empty,
    getBillingPlanItems: empty,
    getContracts: empty,
    getCustomers: empty,
    getFxRates: empty,
    getNegotiatedRates: empty,
    // Baseline vs Planned columns (design spec, block E, Task 8).
    getAssignmentDays: empty,
    getAssignmentMonths: empty,
    getCostBaselines: empty,
    // H (Q4) — appended AFTER getCostBaselines, matching the component
    // forkJoin's own end-of-block convention. Its real shape is a BenchRollup
    // OBJECT, not a bare array: `empty` here would put `[]` where `.months` is
    // read and every absence mark would evaluate against undefined.
    getBenchMonthly: () => of(EMPTY_BENCH_ROLLUP),
    // The EUR/day -> EUR/hour divisor for a negotiated rate. 8 is the seeded and
    // default working day, so the figures below read as "one 8h day per day rate".
    getHoursPerDay: () => of({ value: 8 }),
    ...overrides,
  } as unknown as ApiService;
  const authStub = { authReady: signal(authReady), isAuthenticated: signal(true) } as unknown as AuthService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    imports: [Reporting],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  // The template carries `@defer` blocks, whose metadata resolves asynchronously.
  await TestBed.compileComponents();
  return TestBed.createComponent(Reporting);
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function utilizationKpi(fixture: { componentInstance: Reporting }): string {
  const kpi = fixture.componentInstance.kpis().find(k => k.label === 'Avg Resource Utilization');
  expect(kpi, 'the Avg Resource Utilization tile must exist').toBeDefined();
  return kpi!.value;
}

/**
 * The "Recognised Revenue Trend" card, located by its own heading rather than
 * a global textContent scan — so an assertion against it can never be
 * satisfied by an unrelated tile that happens to render a similar-looking
 * figure elsewhere on this large page.
 */
function recognisedRevenueTrendCard(fixture: { nativeElement: unknown }): HTMLElement {
  const heading = Array.from(host(fixture).querySelectorAll('h3')).find(h => h.textContent?.includes('Recognised Revenue Trend'));
  expect(heading, 'the Recognised Revenue Trend heading must exist').toBeDefined();
  const card = heading!.closest('.command-card');
  expect(card, 'the Recognised Revenue Trend card must exist').toBeDefined();
  return card as HTMLElement;
}

/**
 * The Margin & Variance drill-down's own `<table>`, located via its heading
 * rather than a bare `table.command-data-table` selector — this page has
 * several other tables sharing that class (Customer Profitability, etc.),
 * so an unscoped query could resolve a header cell or row from the wrong
 * table entirely.
 */
function marginVarianceTable(fixture: { nativeElement: unknown }): HTMLElement {
  const heading = Array.from(host(fixture).querySelectorAll('h3')).find(h => h.textContent?.includes('Project Margin & Variance'));
  expect(heading, 'the Project Margin & Variance heading must exist').toBeDefined();
  const card = heading!.closest('.command-card');
  expect(card, 'the Project Margin & Variance card must exist').toBeDefined();
  const table = card!.querySelector('table.command-data-table');
  expect(table, 'the Project Margin & Variance table must exist').toBeDefined();
  return table as HTMLElement;
}

/**
 * Resolves a column's position from the table's OWN header text, never a
 * fixed numeric index — so a test built on this helper degrades correctly:
 * removing a column fails at the specific `expect` that names it (the
 * header lookup itself, or the cell it points at), rather than silently
 * shifting every later column's assertion onto the wrong cell.
 */
function columnIndex(table: HTMLElement, label: string): number {
  const headers = Array.from(table.querySelectorAll('thead th'));
  const idx = headers.findIndex(h => h.textContent?.trim() === label);
  expect(idx, `the "${label}" column header must exist`).toBeGreaterThanOrEqual(0);
  return idx;
}

describe('Reporting — internal-capacity KPIs (C1)', () => {
  it('averages utilization over internal resources only, ignoring dummy and subco', async () => {
    const fixture = await setup();
    await flush(fixture);
    // (90 + 90 + 60) / 3 = 80. Over all six rows it would be 40.
    expect(utilizationKpi(fixture)).toBe('80%');
  });

  it('charts one utilization bar per internal resource, none for dummy or subco', async () => {
    const fixture = await setup();
    await flush(fixture);
    const c = fixture.componentInstance;
    expect(c.utilizationChartCategories()).toEqual(['Julie', 'John', 'Alice']);
    expect(c.utilizationChartSeries()[0].values).toEqual([90, 90, 60]);
  });

  it('reports 0% rather than NaN when every resource is a placeholder', async () => {
    const fixture = await setup(RESOURCES.filter(r => r.kind === 'dummy' || r.kind === 'subco'));
    await flush(fixture);
    expect(utilizationKpi(fixture)).toBe('0%');
    expect(fixture.componentInstance.utilizationChartCategories()).toEqual([]);
  });
});

describe('Reporting — negotiated sell rates reach the rendered T&M figure (Task 4, round 2)', () => {
  it('renders the Recognised Revenue Trend at the negotiated rate, not the resource\'s own (higher) reference billRate', async () => {
    // Anchored on the real current month so it always lands inside the trailing
    // 12-month window recentPeriods(12) computes from `new Date()` — no fixture
    // date ever goes stale.
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const project: Project = { id: 'P2', name: 'Project Beta', location: 'Remote', startDate: '2020-01-01', endDate: '2030-12-31', status: 'Active', contractId: 'CT2' };
    const contract: Contract = { id: 'CT2', customerId: 'C1', name: 'T&M Framework', type: 'T&M', totalValue: 0, currency: 'USD', status: 'Active', startDate: '2020-01-01', endDate: '2030-12-31' };
    // UNITS (the C1 fix): a NegotiatedRate.billRate is EUR per DAY, while a
    // Resource.billRate as /api/resources serves it is EUR per HOUR. So this
    // fixture is a negotiated 800 €/day (= 100 €/h at the default 8h day)
    // against a personal override of 200 €/h (= 1600 €/day).
    const rate: NegotiatedRate = { id: 'nr1', contractId: 'CT2', role: 'Developer', currency: 'EUR', billRate: 800 };
    // The reference rate is ABOVE the negotiated one — a personal override must
    // never beat a negotiated price (design spec §4/§6).
    const resource: Resource = { id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 80, capacity: 40, billRate: 200 };
    const entry: TimeEntry = { id: 'TE1', assignmentId: 'a1', requestId: 'r1', resourceId: 'R1', projectId: 'P2', date, hours: 10, status: 'Approved' };
    const item: BillingPlanItem = { id: 'BP1', contractId: 'CT2', projectId: 'P2', type: 'TimeAndMaterials', label: 'T&M', amount: 0, currency: 'EUR', status: 'Ready' };

    const fixture = await setup([resource], {
      getProjects: () => of([project]),
      getContracts: () => of([contract]),
      getNegotiatedRates: () => of([rate]),
      getTimeEntries: () => of([entry]),
      getBillingPlanItems: () => of([item]),
    });
    await flush(fixture);

    // 10h x the negotiated 800 €/day resolved to 100 €/HOUR = 1000, compact-
    // formatted "€1K" by the trend chart's own `eurCompact` formatter. 10h x the
    // reference 200 €/h would render "€2K", and the pre-fix bug (the €/day figure
    // multiplied by raw hours) would have rendered "€8K" — asserted on the
    // RENDERED DOM (not a signal), scoped to the chart's own card so it cannot be
    // satisfied by an unrelated tile elsewhere on the page.
    const text = recognisedRevenueTrendCard(fixture).textContent ?? '';
    expect(text).toContain('€1K');
    expect(text).not.toContain('€2K');
    expect(text).not.toContain('€8K');
  });
});

describe('Reporting — Baseline vs Planned columns (design spec, block E)', () => {
  it('renders all four required columns (Baseline / Planned / Delta / Delta %) with the hand-verified October figures, scoped to one project row', async () => {
    const project: Project = { id: 'P1', name: 'Project One', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' };
    const resource: Resource = { id: 'R1', name: 'Res', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 90, billRate: 180 };
    const request = { id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled' as const, skills: [], projectId: 'P1' };
    const assignment = { id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' as const };
    // Revenue is required for marginRows() to include the project at all
    // (it filters to projects carrying revenue or cost) — an order line gives
    // it non-zero cost-driver revenue independent of the baseline figures.
    const order = { id: 'O1', contractId: 'CT1', type: 'Customer' as const, amount: 1000, currency: 'EUR', status: 'Invoiced' as const, orderDate: '2026-01-01' };
    const line = { id: 'L1', orderId: 'O1', projectId: 'P1', description: 'x', amount: 1000 };

    const fixture = await setup([resource], {
      getProjects: () => of([project]),
      getRequests: () => of([request]),
      getAssignments: () => of([assignment]),
      getOrders: () => of([order]),
      getOrderLines: () => of([line]),
      getAssignmentDays: () => of([{ id: 'A1:2026-10-05', assignmentId: 'A1', date: '2026-10-05', hours: 8 }]),
      getAssignmentMonths: () => of([{ id: 'A1:2026-10', assignmentId: 'A1', month: '2026-10', status: 'Allocated' as const }]),
      getCostBaselines: () => of([{ id: 'CB1', projectId: 'P1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T00:00:00.000Z', frozenBy: 'u4' }]),
    });
    await flush(fixture);

    // Direct signal check first — a rendered string could coincidentally match
    // even if the underlying row's fields were wrong.
    const row = fixture.componentInstance.marginRows().find(r => r.id === 'P1');
    expect(row, 'the P1 margin row must exist').toBeDefined();
    expect(row?.pcpBaseline).toBe(600);
    expect(row?.pcpPlanned).toBe(720);
    expect(row?.pcpDelta).toBe(120);
    expect(row?.pcpDeltaPct).toBeCloseTo(20, 5);

    // Rendered DOM. Spec §7 names FOUR columns for this table — Baseline /
    // Planned / Delta € / Delta % — so this checks all four, each resolved
    // by its own header text (not a fixed cell index) and scoped to this
    // one project's row within the Margin & Variance table specifically
    // (not a whole-page or whole-row textContent scan: this page has many
    // percentage- and currency-bearing cells, and a bare substring check
    // like `.toContain('€120')` would also match the negative `"-€120"`, so
    // each figure is checked for its exact sign too).
    const table = marginVarianceTable(fixture);
    const baselineCol = columnIndex(table, 'Baseline');
    const plannedCol = columnIndex(table, 'Planned');
    const deltaCol = columnIndex(table, 'Delta');
    const deltaPctCol = columnIndex(table, 'Delta %');

    const rows = Array.from(table.querySelectorAll('tbody tr'));
    const projectRow = rows.find(tr => tr.textContent?.includes('Project One'));
    expect(projectRow, 'the Project One table row must exist').toBeDefined();
    const cells = Array.from(projectRow!.querySelectorAll('td'));

    expect(cells[baselineCol].textContent).toContain('€600');
    expect(cells[plannedCol].textContent).toContain('€720');
    expect(cells[deltaCol].textContent).toContain('€120');
    expect(cells[deltaCol].textContent).not.toContain('-€120');
    expect(cells[deltaPctCol].textContent).toContain('+20.00%');
    expect(cells[deltaPctCol].textContent).not.toContain('-20.00%');
  });

  it('renders "—" (never a fabricated percentage) in the PCP Delta % column when a project has no frozen baseline at all', async () => {
    const project: Project = { id: 'P2', name: 'Project Unfrozen', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' };
    const order = { id: 'O2', contractId: 'CT2', type: 'Customer' as const, amount: 500, currency: 'EUR', status: 'Invoiced' as const, orderDate: '2026-01-01' };
    const line = { id: 'L2', orderId: 'O2', projectId: 'P2', description: 'x', amount: 500 };

    const fixture = await setup([], {
      getProjects: () => of([project]),
      getOrders: () => of([order]),
      getOrderLines: () => of([line]),
      // getAssignmentDays/getAssignmentMonths/getCostBaselines all default to
      // empty via setup()'s apiStub — this project has neither booked hours
      // nor any cost_baselines row, the genuinely-empty case (Task 6's own
      // hasComparisonRows fix) where costBaselineComparison legitimately
      // returns [] and every pcp* total is 0/null, never a fabricated number.
    });
    await flush(fixture);

    const row = fixture.componentInstance.marginRows().find(r => r.id === 'P2');
    expect(row, 'the P2 margin row must exist').toBeDefined();
    expect(row?.pcpBaseline).toBe(0);
    expect(row?.pcpDeltaPct).toBeNull();

    const rows = Array.from(host(fixture).querySelectorAll('table.command-data-table tbody tr'));
    const projectRow = rows.find(tr => tr.textContent?.includes('Project Unfrozen'));
    expect(projectRow, 'the Project Unfrozen table row must exist').toBeDefined();
    expect(projectRow!.textContent ?? '').toContain('—');
  });

  // COORDINATOR-CAUGHT DEFECT: pcpBaseline/pcpPlanned/pcpDelta must restrict
  // to periods with a current baseline row, never sum across
  // costBaselineComparison's full period union — which also includes every
  // out-of-horizon month (booked hours, baseline 0). The single-month
  // fixture above never exercises this: with only one period total, "sum
  // everything" and "sum only frozen periods" coincide, which is exactly
  // how the same bug shipped unnoticed in this file, project-details.ts and
  // dashboard.component.ts alike.
  it('restricts pcpBaseline/pcpPlanned/pcpDelta to periods with a current baseline row, never summing a never-frozen month into the ratio', async () => {
    const project: Project = { id: 'P3', name: 'Project Mixed', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' };
    const resource: Resource = { id: 'R3', name: 'Res Three', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 100, billRate: 200 };
    const request = { id: 'REQ3', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled' as const, skills: [], projectId: 'P3' };
    const assignment = { id: 'A3', requestId: 'REQ3', resourceId: 'R3', assignedHours: 8, status: 'Allocated' as const };
    const order = { id: 'O3', contractId: 'CT3', type: 'Customer' as const, amount: 1000, currency: 'EUR', status: 'Invoiced' as const, orderDate: '2026-01-01' };
    const line = { id: 'L3', orderId: 'O3', projectId: 'P3', description: 'x', amount: 1000 };

    const fixture = await setup([resource], {
      getProjects: () => of([project]),
      getRequests: () => of([request]),
      getAssignments: () => of([assignment]),
      getOrders: () => of([order]),
      getOrderLines: () => of([line]),
      // January: booked, NO baseline row at all (never frozen) -> out of
      // horizon, baseline 0, planned 1000 (10h x 100 EUR/h). February:
      // booked AND frozen at 400 -> planned 500 (5h x 100), delta 100.
      getAssignmentDays: () => of([
        { id: 'A3:2026-01-05', assignmentId: 'A3', date: '2026-01-05', hours: 10 },
        { id: 'A3:2026-02-05', assignmentId: 'A3', date: '2026-02-05', hours: 5 },
      ]),
      getAssignmentMonths: () => of([
        { id: 'A3:2026-01', assignmentId: 'A3', month: '2026-01', status: 'Allocated' as const },
        { id: 'A3:2026-02', assignmentId: 'A3', month: '2026-02', status: 'Allocated' as const },
      ]),
      getCostBaselines: () => of([{ id: 'CB_FEB', projectId: 'P3', period: '2026-02', amount: 400, frozenAt: '2026-01-15T00:00:00.000Z', frozenBy: 'u4' }]),
    });
    await flush(fixture);

    const row = fixture.componentInstance.marginRows().find(r => r.id === 'P3');
    expect(row, 'the P3 margin row must exist').toBeDefined();
    // Restricted (correct): only February counts (has a frozen row).
    // baseline 400, planned 500, delta 100, deltaPct 25.00%.
    // UNRESTRICTED (the defect this pins): baseline still 400 (January
    // contributes 0 either way), planned 1500 (Jan's 1000 + Feb's 500),
    // delta 1100, deltaPct 275%.
    expect(row?.pcpBaseline).toBe(400);
    expect(row?.pcpPlanned).toBe(500);
    expect(row?.pcpDelta).toBe(100);
    expect(row?.pcpDeltaPct).toBeCloseTo(25, 5);
  });
});

describe('Reporting — the multi-endpoint load window announces itself', () => {
  /**
   * A screen reader deep-linking /reporting heard NOTHING for the whole gated
   * load window: `aria-label` on a role-less generic div names nothing (ARIA
   * prohibits an accessible name there), so the label was dropped, and aria-busy
   * carries no announcement outside a live region. The report then filled in
   * silently — indistinguishable from an empty or broken page.
   */
  it('exposes a polite busy live region naming the load while the gated read is in flight', async () => {
    // authReady false: dataLoading() is true on its FIRST clause, which is the
    // real deep-link state (the OIDC bootstrap has not settled yet).
    const fixture = await setup(RESOURCES, {}, false);
    await flush(fixture);
    const page = host(fixture);

    // Scoped by its own text, not by document order: the ListState wrappers
    // further down this page render their OWN [role=status] skeleton regions
    // ("Loading utilization", …), so a bare querySelector could be satisfied by
    // one of those and would prove nothing about this container.
    const regions = Array.from(page.querySelectorAll('[role="status"][aria-live="polite"][aria-busy="true"]'));
    const region = regions.find(r => (r.textContent ?? '').includes('Loading portfolio analytics'));
    expect(region, 'the KPI/financials load region must be a named polite live region').toBeDefined();

    // Assertion of ABSENCE: the discarded aria-label must not survive as the
    // text source, or this could go green by adding a role while leaving the
    // nameless-generic shape in place.
    expect(page.querySelector('div[aria-label^="Loading"]:not([role])')).toBeNull();
  });

  it('does not leave a busy live region behind once the report has resolved', async () => {
    const fixture = await setup();
    await flush(fixture);
    const page = host(fixture);

    // The pair with the test above: the two auth states must DIFFER on this
    // element. A region hard-coded into the template would satisfy the positive
    // assertion above and fail here — that is what stops it being a tautology.
    const stillBusy = Array.from(page.querySelectorAll('[aria-busy="true"]'))
      .filter(r => (r.textContent ?? '').includes('Loading portfolio analytics'));
    expect(stillBusy).toEqual([]);
    // …and the KPI tiles the region stood in for are on screen now, so "no
    // loading text" cannot be satisfied by a page that rendered nothing at all.
    expect(page.textContent ?? '').toContain('Portfolio Financials');
  });
});

/**
 * THE ERROR PATH. This screen documents an access notice and ten ListState Retry
 * panels for exactly this case, and not one of them could render: `value()`
 * THROWS on an errored rxResource, ~40 computeds dereferenced
 * `dataRes.value()`/`fxRes.value()` unguarded, and the first binding to reach one
 * aborted the whole change-detection pass. A finance user whose bearer expired
 * got the header and then nothing at all.
 */
describe('Reporting — a failed gated read still renders its own error surfaces', () => {
  /** One failing leg is enough — the gated read is a fail-fast forkJoin. */
  const failing = { getProjects: () => throwError(() => new Error('403')) } as unknown as Partial<ApiService>;

  it('renders the access notice and a Retry affordance instead of aborting the render', async () => {
    const fixture = await setup(RESOURCES, failing);
    await flush(fixture);
    const page = host(fixture);

    // The notice the component's own comment promises for a 401/403.
    expect(page.textContent ?? '').toContain('Your role does not have access to the financial reporting data');

    // …and the way back. Scoped to the ListState error panels (role="alert"), not
    // any button on the page, so this cannot be satisfied by unrelated markup.
    const retries = Array.from(page.querySelectorAll('[role="alert"] button'))
      .filter(b => (b.textContent ?? '').includes('Retry'));
    expect(retries.length, 'the ListState error panels must offer Retry').toBeGreaterThan(0);
  });

  it('renders no figure derived from the empty envelope it falls back to', async () => {
    // ASSERTION OF ABSENCE, and the whole reason the envelope is not the
    // forbidden "a failed read means no data" accessor: every region fed by it
    // must be OFF SCREEN while the error surfaces are the things on screen.
    // "Top Customer Share" belongs to the Concentration KPI cards — the block
    // that was missed when the money regions were gated — and "Portfolio
    // Financials" to the strip above it.
    const fixture = await setup(RESOURCES, failing);
    await flush(fixture);
    const text = host(fixture).textContent ?? '';

    expect(text).not.toContain('Top Customer Share');
    expect(text).not.toContain('Portfolio Financials');

    // The catch-all: every money figure on this page is written by a CurrencyPipe
    // in 'symbol' form, so a single € anywhere is a figure that came out of the
    // empty envelope. (Static "EUR (base)" unit labels sit next to card headings
    // and legitimately survive — they name a currency, they do not state an
    // amount.) This is the assertion that would catch the NEXT ungated reader,
    // not just the one this fix closes.
    expect(text).not.toContain('€');
  });

  /**
   * WHAT THE TEMPLATE GATE CANNOT COVER, and the reason the guard lives at the
   * dereference rather than in the markup. Verified by neutralising the envelope
   * short-circuit: with only the ListState gate in place the two tests above stay
   * GREEN (nothing errored is instantiated, so nothing throws) and only this one
   * turns red. Every accessor here is reached WITHOUT the view — a direct signal
   * read, and a workbook builder the spec above calls the same way — which is
   * exactly the shape of the next reader someone adds outside a gate.
   */
  it('answers from the empty envelope, never throwing, when read outside the view', async () => {
    const fixture = await setup(RESOURCES, failing);
    await flush(fixture);
    const c = fixture.componentInstance;

    // dataRes side: the RPT builders read the plan straight off the envelope.
    expect(() => c['buildPlanningSheet']()).not.toThrow();
    expect(c['buildPlanningSheet']().rows).toEqual([]);
    expect(c['buildAllocationSheets']().every(s => s.rows.length === 0)).toBe(true);

    // …and the figures, which must be a declared zero rather than an exception.
    expect(c.marginRows()).toEqual([]);
    expect(c.totalRevenue()).toBe(0);
  });

  it('answers from the empty FX table, never throwing, when only FX fails', async () => {
    // The fxRes twin of the test above: arDso()/arTotalOutstanding() reach
    // fxEnvelope() through arResult(), so a guard on dataRes alone leaves this
    // throwing. Neutralise `fxEnvelope`'s short-circuit and only this goes red.
    const fixture = await setup(RESOURCES, { getFxRates: () => throwError(() => new Error('403')) } as unknown as Partial<ApiService>);
    await flush(fixture);
    const c = fixture.componentInstance;

    expect(() => c.arDso()).not.toThrow();
    expect(c.arTotalOutstanding()).toBe(0);
    expect(c.arByCustomer()).toEqual([]);
  });

  it('brings the Concentration cards back once the read succeeds', async () => {
    // THE PAIR with the absence assertions above, and what stops them being a
    // tautology: this fix moved that block behind a ListState, and a wrapper that
    // never renders its content would satisfy every "not.toContain" above while
    // deleting a panel from the page. The two states must DIFFER on this element.
    const fixture = await setup();
    await flush(fixture);
    expect(host(fixture).textContent ?? '').toContain('Top Customer Share');
  });

  it('keeps rendering all of it when only the FX table fails', async () => {
    // fxRes is the second gated resource and is dereferenced from the same
    // financeData() computed, so it carries the identical exposure. Pinning it
    // separately stops a fix that guards only dataRes from reading as complete.
    const fixture = await setup(RESOURCES, { getFxRates: () => throwError(() => new Error('403')) } as unknown as Partial<ApiService>);
    await flush(fixture);
    const page = host(fixture);

    const retries = Array.from(page.querySelectorAll('[role="alert"] button'))
      .filter(b => (b.textContent ?? '').includes('Retry'));
    expect(retries.length, 'an FX failure must reach the same Retry panels').toBeGreaterThan(0);
    expect(page.textContent ?? '').not.toContain('Top Customer Share');
  });
});

/**
 * RPT .xlsx reports (docs/rpt-comparison.md rows 24 + 44). The sheet-shaping rules are
 * pinned in `src/app/services/rpt-xlsx.util.spec.ts`; what is pinned HERE is the
 * WIRING — that this screen hands the builders its own loaded plan, so the workbook
 * carries the figures the page carries and not an empty envelope.
 */
describe('Reporting — RPT xlsx exports', () => {
  const PLANNED_RESOURCES: Resource[] = [
    { id: '1', name: 'Julie Armstrong', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 90, capacity: 40, kind: 'internal', organization: 'Delivery / Cloud', costRate: 50 },
  ];

  const PROJECTS: Project[] = [
    { id: 'P1', name: 'Alpha Migration', location: 'Milan', startDate: '2026-01-01', endDate: '2026-06-30', status: 'In Execution' },
    { id: 'P2', name: 'Beta Rollout', location: 'Rome', startDate: '2026-01-01', endDate: '2026-03-31', status: 'In Planning' },
  ];

  /**
   * ONE resource on TWO commesse in the SAME month — the shape that separates
   * `Allocazione - Dettaglio` (2 rows) from `Allocazione - Testata` (1 summed row),
   * and the only fixture shape in which a Testata that merely copies Dettaglio fails.
   */
  const planned = {
    getProjects: () => of(PROJECTS),
    getRequests: () => of([
      { id: 'Q1', name: 'Q1', requiredRole: 'Developer', requiredEffort: 40, status: 'Open', skills: [], projectId: 'P1' },
      { id: 'Q2', name: 'Q2', requiredRole: 'Developer', requiredEffort: 40, status: 'Open', skills: [], projectId: 'P2' },
    ]),
    getAssignments: () => of([
      { id: 'A1', requestId: 'Q1', resourceId: '1', assignedHours: 8, status: 'Allocated' },
      { id: 'A2', requestId: 'Q2', resourceId: '1', assignedHours: 2, status: 'Allocated' },
    ]),
    getAssignmentDays: () => of([
      { id: 'D1', assignmentId: 'A1', date: '2026-01-15', hours: 8 },
      { id: 'D2', assignmentId: 'A2', date: '2026-01-20', hours: 2 },
    ]),
    getAssignmentMonths: () => of([
      { id: 'A1:2026-01', assignmentId: 'A1', month: '2026-01', status: 'Allocated' },
      { id: 'A2:2026-01', assignmentId: 'A2', month: '2026-01', status: 'Allocated' },
    ]),
  } as unknown as Partial<ApiService>;

  /** Column position from the sheet's own header, never a fixed index. */
  function columnOf(sheet: XlsxSheet, header: string): number {
    const i = sheet.header.indexOf(header);
    expect(i, `the "${header}" column must exist in ${sheet.name}`).toBeGreaterThanOrEqual(0);
    return i;
  }

  it('offers both RPT workbook buttons in the header', async () => {
    const fixture = await setup(PLANNED_RESOURCES, planned);
    await flush(fixture);
    const page = host(fixture);
    const planning = page.querySelector<HTMLButtonElement>('[data-test="export-planning-xlsx"]');
    const allocation = page.querySelector<HTMLButtonElement>('[data-test="export-allocation-xlsx"]');
    expect(planning?.textContent ?? '').toContain('Pianificazione');
    expect(allocation?.textContent ?? '').toContain('Allocazione');
    expect(planning?.disabled).toBe(false);
    expect(allocation?.disabled).toBe(false);
  });

  it('builds the Pianificazione sheet from the plan this screen loaded', async () => {
    const fixture = await setup(PLANNED_RESOURCES, planned);
    await flush(fixture);
    const sheet = fixture.componentInstance['buildPlanningSheet']();
    expect(sheet.name).toBe('Pianificazione');
    const nameCol = columnOf(sheet, 'Commessa');
    expect(sheet.rows.map(r => r[nameCol])).toEqual(['Alpha Migration', 'Beta Rollout']);
    const jan = columnOf(sheet, 'Jan 26 Cost (EUR)');
    expect(sheet.rows[0][jan]).toBe(400); // 8h x 50 EUR/h on Alpha
    expect(sheet.rows[1][jan]).toBe(100); // 2h x 50 EUR/h on Beta
  });

  it('builds the two Allocazione sheets, Testata summing what Dettaglio splits', async () => {
    const fixture = await setup(PLANNED_RESOURCES, planned);
    await flush(fixture);
    const [detail, head] = fixture.componentInstance['buildAllocationSheets']();
    expect([detail.name, head.name]).toEqual(['Allocazione - Dettaglio', 'Allocazione - Testata']);
    expect(detail.rows).toHaveLength(2);
    expect(head.rows).toHaveLength(1);
    expect(detail.rows.map(r => r[columnOf(detail, 'Jan 26 Cost (EUR)')])).toEqual([400, 100]);
    expect(head.rows[0][columnOf(head, 'Jan 26 Cost (EUR)')]).toBe(500);
  });

  it('builds declared-EMPTY workbooks when there is no plan at all', async () => {
    // ASSERTION OF ABSENCE: with the default (all-empty) stubs the builders must
    // produce their sheets with no rows and no month columns — never rows, and never a
    // month axis, conjured out of nothing.
    const fixture = await setup();
    await flush(fixture);
    const planning = fixture.componentInstance['buildPlanningSheet']();
    const [detail, head] = fixture.componentInstance['buildAllocationSheets']();
    expect(planning.rows).toEqual([]);
    expect(detail.rows).toEqual([]);
    expect(head.rows).toEqual([]);
    expect(detail.header).not.toContain('Jan 26 Hours');
  });

  /**
   * Both buttons carry `[disabled]="dataError()"` and both handlers return early on
   * it, because a workbook built from an errored envelope is a file of confident
   * zeros — worse than no file, since it looks authoritative once it is off the
   * screen. The guard was unassertable until the envelope guard landed (the render
   * aborted before the first expectation); it is asserted on BOTH surfaces here,
   * since either one alone leaves a way to export the zeros — the attribute stops
   * the click, the handler stops a caller that never went through the DOM.
   */
  it('disables both workbook buttons, and writes no workbook, on a failed read', async () => {
    const fixture = await setup(PLANNED_RESOURCES, { ...planned, getProjects: () => throwError(() => new Error('403')) } as unknown as Partial<ApiService>);
    await flush(fixture);
    const page = host(fixture);

    expect(page.querySelector<HTMLButtonElement>('[data-test="export-planning-xlsx"]')?.disabled).toBe(true);
    expect(page.querySelector<HTMLButtonElement>('[data-test="export-allocation-xlsx"]')?.disabled).toBe(true);

    // The handlers' own early return: a resolved export announces itself through
    // NotificationService, so an empty call log is the proof nothing was written.
    const notify = TestBed.inject(NotificationService);
    await fixture.componentInstance.exportPlanningXlsx();
    await fixture.componentInstance.exportAllocationXlsx();
    expect(notify.show).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// BLOCK H — non-billable engagements (Q2) and absence marking (Q4).
//
// jsdom DOES NOT LAY OUT. Nothing below can prove a bar is legible, that a tile
// is not clipped, or that a tone is distinguishable to the eye; every assertion
// here is structural (a label, a category string, a per-datum colour token, a
// computed figure). The visual half belongs to the browser pass in spec §8.4.
// -----------------------------------------------------------------------------

/**
 * The four project shapes the block turns on, and the ONE fixture the money
 * tests below share. All four are required and none is decorative:
 *
 *   PB  billable: true                     — the control that must not move
 *   PN  billable: false, type 'Delivery'   — internal, NOT a basket (the legitimate
 *                                            converse of the Basket invariant)
 *   PK  billable: false, type 'Basket'     — the manual's dedicated engagement
 *   PL  NO billable FIELD AT ALL           — must read as BILLABLE (?? true)
 *
 * Without PL a mutation that inverted the default would keep every other
 * assertion green; without PN, "excluded" and "is a Basket" could not be told
 * apart. Money is hand-verifiable: every rate is 100/200 EUR per hour, so every
 * figure below is a product of two numbers written on this page.
 *
 *   PB  revenue 100000  cost 300h x 100 = 30000   margin  70000   billable
 *   PN  revenue      0  cost 100h x 100 = 10000   margin -10000   NON-billable
 *   PK  revenue      0  cost  40h x 100 =  4000   margin  -4000   NON-billable
 *   PL  revenue  20000  cost  50h x 100 =  5000   margin  15000   billable (default)
 *
 *   fully loaded = 120000 - (30000 + 5000) - (10000 + 4000) = 71000  (59.17%)
 *   the OLD /reporting sum (revenue-bearing projects only) = 70000 + 15000 = 85000
 *
 * So one fixture measures both halves of Q2: the tile on THIS page moves by
 * 14000, and the dashboard's — an unfiltered sum all along — does not.
 */
const H_RESOURCES: Resource[] = [
  { id: 'R1', name: 'Rita One', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 80, capacity: 40, kind: 'internal', costRate: 100, billRate: 200 },
  { id: 'R2', name: 'Ravi Two', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 60, capacity: 40, kind: 'internal', costRate: 100, billRate: 200 },
];

const H_PROJECTS: Project[] = [
  { id: 'PB', name: 'Billable Delivery', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', billable: true, type: 'Delivery' },
  { id: 'PN', name: 'Internal Platform', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', billable: false, type: 'Delivery' },
  { id: 'PK', name: 'BASKET Engineering', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', billable: false, type: 'Basket' },
  { id: 'PL', name: 'Legacy Row', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' },
];

/** The SAME four projects with the flags stripped — every one reads billable. */
const H_PROJECTS_UNFLAGGED: Project[] = H_PROJECTS.map(p => {
  const copy: Project = { ...p };
  delete copy.billable;
  delete copy.type;
  return copy;
});

const H_TIME: TimeEntry[] = [
  { id: 'T1', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PB', date: '2026-05-04', hours: 300, status: 'Approved' },
  { id: 'T2', assignmentId: 'a', requestId: 'r', resourceId: 'R2', projectId: 'PN', date: '2026-05-04', hours: 100, status: 'Approved' },
  { id: 'T3', assignmentId: 'a', requestId: 'r', resourceId: 'R2', projectId: 'PK', date: '2026-05-04', hours: 40, status: 'Approved' },
  { id: 'T4', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PL', date: '2026-05-04', hours: 50, status: 'Approved' },
];

/**
 * Billing items exist ONLY on the billable engagements, which is not a
 * convenience: the server refuses one on a non-billable project (spec §6.3), so
 * a fixture that put one there would pin a state the system forbids. They give
 * recognizedRevenue something to return, so the realization differential moves a
 * MONEY figure and not only an hours count.
 */
const H_BILLING: BillingPlanItem[] = [
  { id: 'BP-PB', contractId: 'CT', projectId: 'PB', type: 'Milestone', label: 'M1', amount: 18000, currency: 'EUR', status: 'Ready' },
  { id: 'BP-PL', contractId: 'CT', projectId: 'PL', type: 'Milestone', label: 'M1', amount: 6000, currency: 'EUR', status: 'Ready' },
];

const H_ORDERS = [
  { id: 'O1', contractId: 'CT', type: 'Customer' as const, amount: 120000, currency: 'EUR', status: 'Invoiced' as const, orderDate: '2026-01-01' },
];
const H_ORDER_LINES = [
  { id: 'L-PB', orderId: 'O1', projectId: 'PB', description: 'x', amount: 100000 },
  { id: 'L-PL', orderId: 'O1', projectId: 'PL', description: 'x', amount: 20000 },
];

function hOverrides(projects: Project[], extra: Record<string, unknown> = {}): Partial<ApiService> {
  return {
    getProjects: () => of(projects),
    getTimeEntries: () => of(H_TIME),
    getBillingPlanItems: () => of(H_BILLING),
    getOrders: () => of(H_ORDERS),
    getOrderLines: () => of(H_ORDER_LINES),
    ...extra,
  } as unknown as Partial<ApiService>;
}

/** The Portfolio Financials tile whose label must carry "fully loaded". */
function marginTile(fixture: { nativeElement: unknown }): HTMLElement {
  const tile = host(fixture).querySelector<HTMLElement>('[data-test="fully-loaded-margin-tile"]');
  expect(tile, 'the fully-loaded margin tile must exist').not.toBeNull();
  return tile!;
}

describe('Reporting — the portfolio margin tile is FULLY LOADED and says so (Q2; structure only, jsdom does not lay out)', () => {
  it('carries the cost of non-billable work, which the pre-H sum on THIS page dropped', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(fixture);
    const c = fixture.componentInstance;

    // The numbers, hand-derived at the top of this block.
    expect(c.totalRevenue()).toBe(120000);
    expect(c.totalMargin()).toBe(71000);
    expect(c.portfolioMarginPct()).toBeCloseTo(59.1667, 3);

    // THE MOVE, stated as a number rather than "it changed": /reporting summed
    // projectMargins(), which filters revenue > 0 and therefore dropped every
    // non-billable engagement — the exact opposite of fully loaded. The tile is
    // 14000 EUR below that sum, and the per-project list it came from is
    // deliberately UNCHANGED (spec §11), so both figures stay derivable here.
    const revenueBearingSum = c.projectMargins().reduce((s, p) => s + p.margin, 0);
    expect(revenueBearingSum).toBe(85000);
    expect(c.totalMargin()).toBe(revenueBearingSum - 14000);
  });

  it('names "fully loaded" in the LABEL, and says the figure is not a project delivery margin', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(fixture);

    // The LABEL, not the caption: the caption is what somebody comparing two
    // euro figures on two screens does not read.
    const label = marginTile(fixture).querySelector('.command-kpi-label')?.textContent ?? '';
    expect(label.toLowerCase()).toContain('fully loaded');

    const note = marginTile(fixture).querySelector('[data-test="fully-loaded-note"]')?.textContent ?? '';
    expect(note).toContain('€14,000');
    expect(note).toContain('2 engagements');
    expect(note.toLowerCase()).toContain('not comparable');
  });

  it('says the OPPOSITE when nothing non-billable is in the base — the note is not wallpaper', async () => {
    // THE ABSENCE TWIN. Without this, a hard-coded "not comparable with a project
    // margin" string would satisfy the test above forever, including on a
    // portfolio where the caveat is false.
    const fixture = await setup(H_RESOURCES, hOverrides(H_PROJECTS_UNFLAGGED));
    await flush(fixture);

    const note = marginTile(fixture).querySelector('[data-test="fully-loaded-note"]')?.textContent ?? '';
    expect(note.toLowerCase()).toContain('no non-billable engagement');
    expect(note.toLowerCase()).not.toContain('not comparable');
    // …and the label still says fully loaded, because the QUESTION the tile
    // answers does not depend on today's data.
    expect((marginTile(fixture).querySelector('.command-kpi-label')?.textContent ?? '').toLowerCase())
      .toContain('fully loaded');
  });

  it('DIFFERENTIAL — the same fixture with and without the flags: the total is identical, the split is not', async () => {
    // The §8.2 trap in this screen's own terms. FinanceData.projects omitted (or
    // carrying no flags) reads as all-billable, which reproduces the pre-H
    // behaviour exactly — so a value-only test stays green while the flags are
    // never read. Two renders of the SAME money: one answer that must NOT move,
    // and one that must.
    const flagged = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(flagged);
    const withFlags = flagged.componentInstance['portfolioMargin']();

    TestBed.resetTestingModule();

    const unflagged = await setup(H_RESOURCES, hOverrides(H_PROJECTS_UNFLAGGED));
    await flush(unflagged);
    const without = unflagged.componentInstance['portfolioMargin']();

    // Q2's own answer, CONFIRMED rather than assumed: the headline does not move.
    // The cost was always inside the total; what H adds is knowing which part of
    // it has no customer behind it — which is exactly why the label had to change
    // even though the figure did not.
    expect(without.fullyLoadedMargin).toBe(withFlags.fullyLoadedMargin);
    expect(without.revenue).toBe(withFlags.revenue);

    // …and the split, which is the whole of the change.
    expect(withFlags.nonBillableCost).toBe(14000);
    expect(without.nonBillableCost).toBe(0);
    expect(withFlags.deliveryCost).toBe(35000);
    expect(without.deliveryCost).toBe(49000);
    expect(withFlags.nonBillableProjectIds).toStrictEqual(['PK', 'PN']);
    expect(without.nonBillableProjectIds).toStrictEqual([]);
  });

  it('treats a project row with NO billable field as billable, never as an unflagged basket', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(fixture);
    const ids = fixture.componentInstance['portfolioMargin']().nonBillableProjectIds;
    // PL carries neither flag. The safe default keeps margin alerts ON for it;
    // inverting that default is a silent, portfolio-wide suppression, so it is
    // pinned in both directions on one fixture.
    expect(ids).not.toContain('PL');
    expect(ids).toStrictEqual(['PK', 'PN']);
  });
});

describe('Reporting — realization excludes non-billable engagements (F-7; structure only, jsdom does not lay out)', () => {
  it('DIFFERENTIAL — the same fixture with and without the flags disagrees on realization, hours, headcount and the excluded list', async () => {
    const flagged = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(flagged);
    const withFlags = flagged.componentInstance.realization();

    TestBed.resetTestingModule();

    const unflagged = await setup(H_RESOURCES, hOverrides(H_PROJECTS_UNFLAGGED));
    await flush(unflagged);
    const without = unflagged.componentInstance.realization();

    // Billable only: 350 approved hours x 200 = 70000 of rate-card value behind
    // 24000 of recognised revenue => 34.29%.
    expect(withFlags.hours).toBe(350);
    expect(withFlags.standardBillValue).toBe(70000);
    expect(withFlags.realizationPct).toBeCloseTo(34.2857, 3);
    expect(withFlags.headcount).toBe(1);
    expect(withFlags.excludedProjectIds).toStrictEqual(['PK', 'PN']);

    // Pre-H: the 140 hours on PN and PK carried 28000 of rate-card value against
    // no customer at all, dragging the ratio down by ~10 points.
    expect(without.hours).toBe(490);
    expect(without.standardBillValue).toBe(98000);
    expect(without.realizationPct).toBeCloseTo(24.4898, 3);
    expect(without.headcount).toBe(2);
    expect(without.excludedProjectIds).toStrictEqual([]);

    // The revenue numerator is the SAME in both — a non-billable engagement has
    // none to remove — which is what makes the ratio's move attributable to the
    // denominator rather than to a revenue figure quietly changing too.
    expect(withFlags.revenue).toBe(without.revenue);
    expect(withFlags.revenue).toBe(24000);
  });

  it('says how many engagements the strip leaves out, and says the opposite when it leaves out none', async () => {
    const flagged = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(flagged);
    const scoped = host(flagged).querySelector('[data-test="realization-scope"]')?.textContent ?? '';
    expect(scoped).toContain('billable engagements only');
    expect(scoped).toContain('2 non-billable excluded');

    TestBed.resetTestingModule();

    // THE ABSENCE TWIN: the subtitle must be able to say there is nothing to
    // exclude, or "billable engagements only" is a permanent decoration.
    const unflagged = await setup(H_RESOURCES, hOverrides(H_PROJECTS_UNFLAGGED));
    await flush(unflagged);
    const clean = host(unflagged).querySelector('[data-test="realization-scope"]')?.textContent ?? '';
    expect(clean).toContain('all engagements are billable');
    expect(clean).not.toContain('non-billable excluded');
  });
});

// -----------------------------------------------------------------------------
// Q4 — someone away for the whole month is MARKED on the utilization chart, not
// dropped from it. Three internals whose profile utilizations differ, so the
// mean has a value worth moving:
//
//   Rita  80%   away all month  -> marked, and OUT of the average denominator
//   Ravi  60%   present         -> unmarked (the paired absence assertion)
//   Rosa  40%   present         -> unmarked
//
//   mean with Rita counted  = (80 + 60 + 40) / 3 = 60%
//   mean with Rita excluded = (60 + 40) / 2      = 50%
//
// Rita is deliberately the HIGHEST reading, not a zero: the scalar `utilization`
// is a whole-of-time profile value H leaves alone (spec §11), so an away person
// can carry a large number, and an implementation that "marks the zero bars"
// would mark the wrong people while every 0%-fixture stayed green.
// -----------------------------------------------------------------------------

const AWAY_RESOURCES: Resource[] = [
  { id: 'R1', name: 'Rita One', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 80, capacity: 40, kind: 'internal' },
  { id: 'R2', name: 'Ravi Two', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 60, capacity: 40, kind: 'internal' },
  { id: 'R3', name: 'Rosa Three', role: 'Designer', skills: [], projectRoles: [], externalExperience: [], utilization: 40, capacity: 40, kind: 'internal' },
];

const THIS_MONTH = todayLocalIso().slice(0, 7);

function cell(state: BenchCell['state']): BenchCell {
  return { state, upcomingUnallocated: false };
}

/**
 * A rollup whose window CONTAINS the current month, with R1's state as the only
 * variable. Calling it twice — once 'ABSENT', once 'BENCH' — is the differential:
 * one input byte apart, and the screen must disagree.
 */
function awayRollup(r1: BenchCell['state']): BenchRollup {
  return {
    months: [THIS_MONTH],
    internalRows: [
      { resourceId: 'R1', resourceName: 'Rita One', kind: 'internal', monthly: { [THIS_MONTH]: cell(r1) }, availabilityDate: { kind: 'date', date: THIS_MONTH + '-01' } },
      { resourceId: 'R2', resourceName: 'Ravi Two', kind: 'internal', monthly: { [THIS_MONTH]: cell('ALLOCATED') }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: THIS_MONTH } },
      { resourceId: 'R3', resourceName: 'Rosa Three', kind: 'internal', monthly: { [THIS_MONTH]: cell('PARTIAL') }, availabilityDate: { kind: 'date', date: THIS_MONTH + '-01' } },
    ],
    subcoRows: [],
    hiringDemand: [],
  };
}

function awaySetup(rollup: BenchRollup) {
  return setup(AWAY_RESOURCES, { getBenchMonthly: () => of(rollup) } as unknown as Partial<ApiService>);
}

describe('Reporting — Q4 marks an away person instead of dropping them (structure only, jsdom does not lay out)', () => {
  it('DIFFERENTIAL — the same three people, one bench cell apart, disagree on the axis, the tone and the mean', async () => {
    const marked = await awaySetup(awayRollup('ABSENT'));
    await flush(marked);
    // Snapshotted BEFORE the TestBed reset: these are signals, and re-reading one
    // after its injector is destroyed answers from the empty default — which
    // would have made the second half of this test compare two blanks.
    const markedCats = marked.componentInstance.utilizationChartCategories();
    const markedSeries = marked.componentInstance.utilizationChartSeries()[0];
    const markedColors = markedSeries.colors;
    const markedValues = markedSeries.values;
    const markedMean = utilizationKpi(marked);

    TestBed.resetTestingModule();

    const plain = await awaySetup(awayRollup('BENCH'));
    await flush(plain);
    const noAbsence = plain.componentInstance;

    // PRESENCE: Rita is named as away on the axis, toned `info`, and gone from
    // the denominator.
    expect(markedCats).toStrictEqual(['Rita (away)', 'Ravi', 'Rosa']);
    expect(markedColors).toStrictEqual(['var(--color-info)', undefined, undefined]);
    expect(markedMean).toBe('50%');

    // ABSENCE, on the same fixture: with the one cell flipped to BENCH, nobody is
    // marked and the mean is back over all three. Everybody still on the chart in
    // both — Q4 chose marking over exclusion, so the bar count must not move.
    expect(noAbsence.utilizationChartCategories()).toStrictEqual(['Rita', 'Ravi', 'Rosa']);
    expect(noAbsence.utilizationChartSeries()[0].colors).toStrictEqual([undefined, undefined, undefined]);
    expect(utilizationKpi(plain)).toBe('60%');
    expect(noAbsence.utilizationChartCategories().length).toBe(markedCats.length);

    // The values are UNTOUCHED in both. H does not rewrite the scalar (spec §11);
    // marking it is the whole of the change, and 80 surviving here is what proves
    // the mark is not "the bar that reads zero".
    expect(markedValues).toStrictEqual([80, 60, 40]);
    expect(noAbsence.utilizationChartSeries()[0].values).toStrictEqual([80, 60, 40]);
  });

  it('renders the away annotation with the canonical glyph, tone and wording — and names no cause', async () => {
    const fixture = await awaySetup(awayRollup('ABSENT'));
    await flush(fixture);
    const legend = host(fixture).querySelector('[data-test="utilization-away-legend"]');
    expect(legend, 'the away annotation must exist when somebody is away').not.toBeNull();

    const chip = legend!.querySelector('li');
    // The canonical treatment, verbatim from availability-strip.component.ts, so
    // the four surfaces of this block read alike. Tokens, not a `dark:` variant:
    // this design system re-points the same tokens under [data-theme="dark"].
    expect(chip!.className).toContain('bg-info-tint');
    expect(chip!.className).toContain('text-info-text');
    expect(chip!.className).toContain('ring-info');
    expect(chip!.textContent).toContain('L');
    expect(chip!.getAttribute('aria-label')).toContain('Away (on leave) — not staffable');
    expect(legend!.textContent).toContain('Rita (away)');

    // PRIVACY, asserted over the WHOLE rendered page rather than one node: an
    // absence reason is special-category data and this screen's audience is not
    // its audience. Scanning the whole body is how a leak from a NEW reader gets
    // caught, not just from the one this test was written for.
    const page = host(fixture).textContent ?? '';
    for (const reason of ABSENCE_REASON_CODES) expect(page).not.toContain(reason);
    // Vacuity control: the scan must be running against a page that DID render
    // the marking, or "no reason on screen" is satisfied by an empty page.
    expect(page).toContain('Rita (away)');
  });

  it('draws no annotation, and drops nobody from the mean, when nobody is away', async () => {
    // The annotation's own absence twin — a legend hard-coded into the template
    // would satisfy the test above and be wrong every other day of the year.
    const fixture = await awaySetup(awayRollup('BENCH'));
    await flush(fixture);
    expect(host(fixture).querySelector('[data-test="utilization-away-legend"]')).toBeNull();
    expect(host(fixture).querySelector('[data-test="kpi-note"]')).toBeNull();
  });

  it('says how many the average dropped, in the tile and in the exported CSV', async () => {
    const fixture = await awaySetup(awayRollup('ABSENT'));
    await flush(fixture);

    // U6: a mean whose denominator silently changed is a number nobody can
    // reproduce, so the tile carries what it left out.
    const note = host(fixture).querySelector('[data-test="kpi-note"]')?.textContent ?? '';
    expect(note).toContain('Excludes 1 away on leave all month');

    // …and the file, which is where the figure goes once it leaves the screen.
    // The CSV is built through its own method rather than the Blob path so the
    // BYTES can be asserted: an export is the classic escape route for a field
    // that should never leave, and the only test worth having reads them.
    const csv = fixture.componentInstance['buildSummaryCsv']() as string;
    expect(csv.split('\n')[0]).toBe('KPI,Value,Trend,Note');
    expect(csv).toContain('Excludes 1 away on leave all month');
    expect(csv).toContain('50%');
    for (const reason of ABSENCE_REASON_CODES) expect(csv).not.toContain(reason);
  });

  it('refuses to imply "nobody is away" when the fetched window has no present tense', async () => {
    // The bare-"0 / 0" defect, in this screen's dialect: with the window stopping
    // short of today there is nothing to mark, and an unmarked chart must not be
    // readable as an all-clear. Same remedy as the bench tile's month subtitle.
    const past = shiftIso(THIS_MONTH, -3);
    const rollup: BenchRollup = {
      months: [past],
      internalRows: [
        { resourceId: 'R1', resourceName: 'Rita One', kind: 'internal', monthly: { [past]: cell('ABSENT') }, availabilityDate: { kind: 'date', date: past + '-01' } },
      ],
      subcoRows: [],
      hiringDemand: [],
    };
    const fixture = await awaySetup(rollup);
    await flush(fixture);

    const scope = host(fixture).querySelector('[data-test="utilization-absence-scope"]')?.textContent ?? '';
    expect(scope).toContain('does not reach the current month');
    // …and the stale ABSENT cell three months back changed nothing on screen:
    // the window is respected in this direction too.
    expect(fixture.componentInstance.utilizationChartCategories()).toStrictEqual(['Rita', 'Ravi', 'Rosa']);
    expect(utilizationKpi(fixture)).toBe('60%');
  });

  it('states plainly that nobody is away when the window does cover today and nobody is', async () => {
    const fixture = await awaySetup(awayRollup('BENCH'));
    await flush(fixture);
    const scope = host(fixture).querySelector('[data-test="utilization-absence-scope"]')?.textContent ?? '';
    expect(scope).toContain('Nobody internal is away');
    expect(scope).not.toContain('does not reach the current month');
  });

  it('declares the treatment in the chart caption (U5), and the caption names no cause', async () => {
    const fixture = await awaySetup(awayRollup('ABSENT'));
    await flush(fixture);
    // The caption reaches the DOM through the chart's screen-reader figcaption,
    // so this reads the rendered text rather than the input binding.
    const caption = host(fixture).querySelector('figcaption caption')?.textContent ?? '';
    expect(caption).toContain('(away)');
    expect(caption).toContain('leaves the average');
    expect(caption.toLowerCase()).toContain('the reason for the leave is never shown');
  });
});

/** 'YYYY-MM' shifted by `delta` months, normalising the year. */
function shiftIso(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const zeroBased = y * 12 + (m - 1) + delta;
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

// -----------------------------------------------------------------------------
// The no-revenue margin-% sentinel must never render as "0%" on /reporting.
//
// finance.util computes every margin percentage as `revenue > 0 ? … : 0`. That
// 0 stands for "undefined". Printing it asserts break-even on an engagement, or
// a customer, that may have lost money.
//
// Which of this page's five margin-% render sites can actually reach it is the
// interesting part, and each is tested at the site that can:
//
//   • the P&L drill-down row  — YES. `marginRows()` admits a project on
//     `revenue > 0 || anyCost > 0`, which is exactly a non-billable engagement.
//   • the customer table row  — YES, but NOT via a basket: `customerProfitability`
//     excludes non-billable engagements outright (§5, F-5). It is reachable the
//     ordinary way — a signed customer whose delivery started before the order
//     landed.
//   • the customer TOTAL     — YES, when no customer has billed yet.
//   • the fully-loaded tile  — YES, for a portfolio of only internal work.
//   • the margin CHART list  — NO. It reads `projectMargins()`, which filters
//     `revenue > 0`; a guard there would be dead code. Asserted as such below.
//   • the compression alert  — NO. `evaluateCompression` returns null on
//     `revenue <= 0` AND skips non-billable ids. Asserted as such below.
// -----------------------------------------------------------------------------

/** A billable customer (C2/CT2/PC) with delivery cost and NO order line yet. */
const NO_REVENUE_CUSTOMER = {
  customers: [
    { id: 'C1', name: 'Paying Customer' },
    { id: 'C2', name: 'Pre-Revenue Customer' },
  ],
  contracts: [
    { id: 'CT', customerId: 'C1', name: 'Signed', type: 'T&M' as const, totalValue: 120000, currency: 'EUR', status: 'Active' as const, startDate: '2026-01-01', endDate: '2026-12-31' },
    { id: 'CT2', customerId: 'C2', name: 'Signed, unbilled', type: 'T&M' as const, totalValue: 50000, currency: 'EUR', status: 'Active' as const, startDate: '2026-01-01', endDate: '2026-12-31' },
  ],
  /** PB and PL keep their revenue via CT; PC carries 20h x 100 = 2000 of cost only. */
  projects: [
    ...H_PROJECTS.map(p => (p.id === 'PB' || p.id === 'PL' ? { ...p, contractId: 'CT' } : p)),
    { id: 'PC', name: 'Delivery Before Order', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', billable: true, type: 'Delivery', contractId: 'CT2' } as Project,
  ],
  time: [...H_TIME, { id: 'T5', assignmentId: 'a', requestId: 'r', resourceId: 'R1', projectId: 'PC', date: '2026-05-04', hours: 20, status: 'Approved' } as TimeEntry],
  /**
   * PC needs a REQUEST to appear in the customer table at all, and the reason is
   * worth knowing: `customerProfitability` walks `allProjectIds()`, which
   * collects ids from financials, order lines, requests, billing items and
   * change requests — but NOT from time entries or the project master. (Its
   * sibling `attributableProjectIds()`, which the fully-loaded portfolio tile
   * uses, DOES add both.) So a project whose only activity is booked labour is
   * invisible to the customer rollup, with or without this fix. That asymmetry
   * is pre-existing and deliberately left alone here — correcting it would move
   * customer money figures, which is not this change's business. The request
   * also makes the fixture more truthful: staffing was requested and filled,
   * the customer order simply has not landed yet.
   */
  requests: [
    { id: 'REQ-PC', name: 'Delivery squad', requiredRole: 'Developer', requiredEffort: 20, status: 'Fulfilled', skills: [], projectId: 'PC' },
  ],
};

/** The cell carrying `test` inside the table row whose FIRST cell names `label`. */
function cellInRow(fixture: { nativeElement: unknown }, label: string, test: string): HTMLElement {
  const rows = Array.from(host(fixture).querySelectorAll('tbody tr'));
  const row = rows.find(r => (r.querySelector('td')?.textContent ?? '').includes(label));
  expect(row, `a row for ${label} must exist`).toBeTruthy();
  const cell = row!.querySelector<HTMLElement>(`[data-test="${test}"]`);
  expect(cell, `${label}'s row must carry a ${test} cell`).not.toBeNull();
  return cell!;
}

describe('Reporting — a margin % is rendered only where revenue makes it measurable', () => {
  it('P&L drill-down: real percentages for the revenue-bearing rows', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(fixture);
    // PB: revenue 100000, cost 30000 -> 70.0%.  PL: 20000 / 5000 -> 75.0%.
    expect(cellInRow(fixture, 'Billable Delivery', 'margin-row-pct').textContent).toContain('70%');
    expect(cellInRow(fixture, 'Legacy Row', 'margin-row-pct').textContent).toContain('75%');
  });

  it('P&L drill-down: an em dash — never "0%" — for the rows carrying only cost', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(fixture);
    for (const name of ['Internal Platform', 'BASKET Engineering']) {
      const text = cellInRow(fixture, name, 'margin-row-pct').textContent ?? '';
      expect(text, `${name} earns nothing, so its margin % is undefined`).toContain('—');
      expect(text, `${name} must not assert a percentage`).not.toContain('%');
    }
  });

  it('customer table: the paying customer keeps a percentage, the pre-revenue one gets a dash', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(NO_REVENUE_CUSTOMER.projects, {
      getCustomers: () => of(NO_REVENUE_CUSTOMER.customers),
      getContracts: () => of(NO_REVENUE_CUSTOMER.contracts),
      getTimeEntries: () => of(NO_REVENUE_CUSTOMER.time),
      getRequests: () => of(NO_REVENUE_CUSTOMER.requests),
    }));
    await flush(fixture);

    // C1: revenue 120000, cost 35000 -> margin 85000 -> 70.8%.
    const paying = cellInRow(fixture, 'Paying Customer', 'customer-margin-pct').textContent ?? '';
    expect(paying).toContain('70.8%');

    // C2: revenue 0, cost 2000. Delivery started before the order landed —
    // ordinary, and NOT a basket (customerProfitability excludes those).
    const preRevenue = cellInRow(fixture, 'Pre-Revenue Customer', 'customer-margin-pct').textContent ?? '';
    expect(preRevenue).toContain('—');
    expect(preRevenue).not.toContain('%');
  });

  it('customer TOTAL: a percentage while anyone has billed, a dash when nobody has', async () => {
    const billed = await setup(H_RESOURCES, hOverrides(NO_REVENUE_CUSTOMER.projects, {
      getCustomers: () => of(NO_REVENUE_CUSTOMER.customers),
      getContracts: () => of(NO_REVENUE_CUSTOMER.contracts),
      getTimeEntries: () => of(NO_REVENUE_CUSTOMER.time),
      getRequests: () => of(NO_REVENUE_CUSTOMER.requests),
    }));
    await flush(billed);
    const withRevenue = host(billed).querySelector('[data-test="customer-total-margin-pct"]')?.textContent ?? '';
    expect(withRevenue).toContain('%');
    expect(withRevenue).not.toContain('—');

    TestBed.resetTestingModule();

    const unbilled = await setup(H_RESOURCES, hOverrides(NO_REVENUE_CUSTOMER.projects, {
      getCustomers: () => of(NO_REVENUE_CUSTOMER.customers),
      getContracts: () => of(NO_REVENUE_CUSTOMER.contracts),
      getTimeEntries: () => of(NO_REVENUE_CUSTOMER.time),
      getRequests: () => of(NO_REVENUE_CUSTOMER.requests),
      getOrders: () => of([]),
      getOrderLines: () => of([]),
    }));
    await flush(unbilled);
    const withoutRevenue = host(unbilled).querySelector('[data-test="customer-total-margin-pct"]')?.textContent ?? '';
    expect(withoutRevenue).toContain('—');
    expect(withoutRevenue).not.toContain('%');
  });

  it('fully-loaded tile: 59.2% with revenue, a dash without, and the AMOUNT survives both', async () => {
    const earning = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(earning);
    expect(host(earning).querySelector('[data-test="portfolio-margin-pct"]')?.textContent).toContain('59.2%');

    TestBed.resetTestingModule();

    // Same cost base, no customer orders at all.
    const internalOnly = await setup(H_RESOURCES, hOverrides(H_PROJECTS, {
      getOrders: () => of([]),
      getOrderLines: () => of([]),
    }));
    await flush(internalOnly);
    const pct = host(internalOnly).querySelector('[data-test="portfolio-margin-pct"]')?.textContent ?? '';
    expect(pct).toContain('—');
    expect(pct).not.toContain('%');
    // -49000 of carried cost is a real figure and must still be on screen.
    expect(internalOnly.componentInstance.totalMargin()).toBe(-49000);
  });

  /** The value under `header` on the CSV line whose first field is `label`. */
  function csvCell(csv: string, label: string, header: string): string {
    const [head, ...lines] = csv.split('\r\n');
    const col = head.split(',').indexOf(header);
    expect(col, `the "${header}" column must exist`).toBeGreaterThanOrEqual(0);
    const line = lines.find(l => l.split(',')[0].replace(/^"|"$/g, '') === label);
    expect(line, `a CSV line for ${label} must exist`).toBeTruthy();
    return line!.split(',')[col].replace(/^"|"$/g, '');
  }

  it('EXPORTS carry the same dash — a "0.0" in a file outlives every caveat on the screen', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(NO_REVENUE_CUSTOMER.projects, {
      getCustomers: () => of(NO_REVENUE_CUSTOMER.customers),
      getContracts: () => of(NO_REVENUE_CUSTOMER.contracts),
      getTimeEntries: () => of(NO_REVENUE_CUSTOMER.time),
      getRequests: () => of(NO_REVENUE_CUSTOMER.requests),
    }));
    await flush(fixture);
    const c = fixture.componentInstance;

    const margins = c['buildMarginVarianceCsv']();
    expect(csvCell(margins, 'Billable Delivery', 'Margin %'), 'a measured row still exports its number').toBe('70.0');
    expect(csvCell(margins, 'BASKET Engineering', 'Margin %')).toBe('—');
    expect(csvCell(margins, 'Internal Platform', 'Margin %')).toBe('—');
    // The AMOUNT is real and must still export as a number in both cases.
    expect(csvCell(margins, 'BASKET Engineering', 'Margin (EUR base)')).toBe('-4000.00');

    const customers = c['buildCustomerProfitabilityCsv']();
    expect(csvCell(customers, 'Paying Customer', 'Margin %')).toBe('70.8');
    expect(csvCell(customers, 'Pre-Revenue Customer', 'Margin %')).toBe('—');
    expect(csvCell(customers, 'Pre-Revenue Customer', 'Cost (EUR base)')).toBe('2000.00');
  });

  it('CONFIRMS the two sites left alone are genuinely unreachable, so their guards would be dead code', async () => {
    const fixture = await setup(H_RESOURCES, hOverrides(H_PROJECTS));
    await flush(fixture);
    const c = fixture.componentInstance;

    // The margin chart/list: `projectMargins()` filters `revenue > 0`, so the
    // two zero-revenue engagements never enter it in the first place.
    const charted = c['marginBars']().map((p: { name: string; revenue: number }) => p.name);
    expect(charted).toContain('Billable Delivery');
    expect(charted).not.toContain('Internal Platform');
    expect(charted).not.toContain('BASKET Engineering');
    for (const bar of c['marginBars']()) expect(bar.revenue).toBeGreaterThan(0);

    // The compression alerts: null on `revenue <= 0`, and non-billable ids are
    // skipped before that. Every alert therefore carries measurable revenue.
    for (const alert of c['compressionAlerts']()) expect(alert.revenue).toBeGreaterThan(0);
  });
});
