import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { ProjectDetailsComponent } from './project-details';
import { ApiService, AssignmentDay, AssignmentMonth, CostBaseline, Project, Resource, ResourceRequest, Assignment } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

async function tick(fixture: ComponentFixture<unknown>, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

const PROJECT: Project = { id: 'P1', name: 'Project One', location: 'Berlin', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' };
const RESOURCE: Resource = { id: 'R1', name: 'Res One', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 90, billRate: 180 };
const REQUEST: ResourceRequest = { id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled', skills: [], projectId: 'P1' };
const ASSIGNMENT: Assignment = { id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' };
const DAYS: AssignmentDay[] = [{ id: 'A1:2026-10-05', assignmentId: 'A1', date: '2026-10-05', hours: 8 }];
const MONTHS: AssignmentMonth[] = [{ id: 'A1:2026-10', assignmentId: 'A1', month: '2026-10', status: 'Allocated' }];
const BASELINE: CostBaseline[] = [{ id: 'CB1', projectId: 'P1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T00:00:00.000Z', frozenBy: 'u4' }];

function makeApiStub(overrides: Partial<Record<string, unknown>> = {}) {
  const empty = () => of([]);
  // Every method is a vi.fn() spy — not just the default fixtures but any
  // override too — so `expect(api.getAssignmentDays).not.toHaveBeenCalled()`
  // (the presence/absence pair this card's RBAC gating exists to prove) has
  // something real to assert on regardless of which branch supplied the fn.
  const base: Record<string, () => unknown> = {
    getProjects: () => of([PROJECT]),
    getOrders: empty, getOrderLines: empty, getProjectFinancials: empty, getTimeEntries: empty,
    getProjectIssues: empty, getChangeRequests: empty,
    getRequests: () => of([REQUEST]),
    getAssignments: () => of([ASSIGNMENT]),
    getResources: () => of([RESOURCE]),
    getAssignmentDays: () => of(DAYS),
    getAssignmentMonths: () => of(MONTHS),
    getCostBaselines: () => of(BASELINE),
    freezeCostBaseline: () => of(BASELINE),
    ...overrides,
  };
  const spied: Record<string, unknown> = {};
  for (const [key, fn] of Object.entries(base)) spied[key] = vi.fn(fn);
  return spied as unknown as ApiService;
}

function makeAuthStub(role: 'employee' | 'sales' | 'pm' | 'finance') {
  const canReadStaffing = ['pm', 'finance'].includes(role);
  const canApproveFinancials = role === 'finance';
  return {
    authReady: () => true,
    canReadStaffing: () => canReadStaffing,
    canApproveFinancials: () => canApproveFinancials,
    canManageCommercial: () => false,
  } as unknown as AuthService;
}

async function render(role: 'employee' | 'sales' | 'pm' | 'finance', apiOverrides: Partial<Record<string, unknown>> = {}) {
  const api = makeApiStub(apiOverrides);
  TestBed.configureTestingModule({
    imports: [ProjectDetailsComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(ProjectDetailsComponent);
  fixture.componentRef.setInput('id', 'P1');
  await tick(fixture);
  return { fixture, api };
}

describe('ProjectDetailsComponent — Baseline vs Planned card (design spec, block E)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is ABSENT for employee — no fetch fires, no "Baseline vs Planned" text renders', async () => {
    const { fixture, api } = await render('employee');
    expect(host(fixture).textContent).not.toContain('Baseline vs Planned');
    expect(api.getAssignmentDays).not.toHaveBeenCalled();
    expect(api.getAssignmentMonths).not.toHaveBeenCalled();
    expect(api.getCostBaselines).not.toHaveBeenCalled();
  });

  it('is ABSENT for sales — the pair of the presence assertion below', async () => {
    const { fixture } = await render('sales');
    expect(host(fixture).textContent).not.toContain('Baseline vs Planned');
  });

  it('is PRESENT for pm and renders the hand-verified +120 EUR / +20.00% October row', async () => {
    const { fixture } = await render('pm');
    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Baseline vs Planned');
    expect(text).toContain('2026-10');
    expect(text).toMatch(/\+?20\.00%/);
  });

  it('renders "—" for a period whose baseline is 0 (never frozen), not a fabricated percentage', async () => {
    const { fixture } = await render('pm', { getCostBaselines: () => of([]) });
    expect(host(fixture).textContent).toContain('—');
  });

  it('shows "No baseline frozen for this project yet." only when the project genuinely has NEITHER a baseline NOR any booked hours — distinct from the "—" case above, which has booked hours and no baseline', async () => {
    const { fixture } = await render('pm', {
      getCostBaselines: () => of([]),
      getAssignmentDays: () => of([]),
      getAssignmentMonths: () => of([]),
    });
    expect(host(fixture).textContent).toContain('No baseline frozen for this project yet.');
  });

  it('does NOT show the empty-state message once a baseline exists — the pair of the test above', async () => {
    const { fixture } = await render('pm');
    expect(host(fixture).textContent).not.toContain('No baseline frozen for this project yet.');
  });

  it('shows a Couldn\'t-load / Retry panel when a dependency errors, never a number', async () => {
    const { fixture } = await render('pm', { getCostBaselines: () => throwError(() => new Error('boom')) });
    const text = host(fixture).textContent ?? '';
    expect(text).toContain("Couldn't load cost baseline");
    expect(text).not.toContain('20.00%');
  });

  it('shows a loading skeleton while a dependency is still pending', async () => {
    const pending = new Subject<CostBaseline[]>();
    const { fixture } = await render('pm', { getCostBaselines: () => pending.asObservable() });
    expect(fixture.nativeElement.querySelectorAll('.command-skeleton').length).toBeGreaterThan(0);
    pending.next(BASELINE);
    pending.complete();
    await tick(fixture);
  });

  it('shows the Freeze baseline button only for finance, never for pm', async () => {
    const { fixture: financeFixture } = await render('finance');
    expect(host(financeFixture).textContent).toContain('Freeze baseline');
    // TestBed refuses a second configureTestingModule() once a component has
    // been instantiated — reset explicitly before the second render() call
    // (afterEach only fires BETWEEN `it()` blocks, not inside one).
    TestBed.resetTestingModule();
    const { fixture: pmFixture } = await render('pm');
    expect(host(pmFixture).textContent).not.toContain('Freeze baseline');
  });
});
