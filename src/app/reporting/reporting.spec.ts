import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { Reporting } from './reporting';
import { ApiService, BillingPlanItem, Contract, NegotiatedRate, Project, Resource, TimeEntry } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

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

async function setup(resources: Resource[] = RESOURCES, overrides: Partial<ApiService> = {}) {
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
    // The EUR/day -> EUR/hour divisor for a negotiated rate. 8 is the seeded and
    // default working day, so the figures below read as "one 8h day per day rate".
    getHoursPerDay: () => of({ value: 8 }),
    ...overrides,
  } as unknown as ApiService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;
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
  it('renders the hand-verified +120 EUR / +20.00% baseline delta for a project with a frozen October baseline', async () => {
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

    // Rendered DOM, scoped to the Margin & Variance table's own row (not a
    // whole-page textContent scan, which this large page's many other
    // percentage cells could coincidentally satisfy).
    const rows = Array.from(host(fixture).querySelectorAll('table.command-data-table tbody tr'));
    const projectRow = rows.find(tr => tr.textContent?.includes('Project One'));
    expect(projectRow, 'the Project One table row must exist').toBeDefined();
    const rowText = projectRow!.textContent ?? '';
    expect(rowText).toContain('+20.00%');
    expect(rowText).toContain('€120');
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
});
