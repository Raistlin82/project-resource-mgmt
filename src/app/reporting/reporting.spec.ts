import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { Reporting } from './reporting';
import { ApiService, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

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

async function setup(resources: Resource[] = RESOURCES) {
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
