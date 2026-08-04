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
    const rate: NegotiatedRate = { id: 'nr1', contractId: 'CT2', role: 'Developer', currency: 'EUR', billRate: 1000 };
    // Reference billRate (1500) is ABOVE the negotiated rate (1000) — a personal
    // override must never beat a negotiated price (design spec §4/§6).
    const resource: Resource = { id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 80, capacity: 40, billRate: 1500 };
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

    // 10h x negotiated 1000 = 10000, compact-formatted "€10K" by the trend chart's
    // own `eurCompact` formatter. 10h x the reference 1500 would render "€15K" —
    // asserted on the RENDERED DOM (not a signal), scoped to the chart's own card
    // so it cannot be satisfied by an unrelated tile elsewhere on the page.
    const text = recognisedRevenueTrendCard(fixture).textContent ?? '';
    expect(text).toContain('€10K');
    expect(text).not.toContain('€15K');
  });
});
