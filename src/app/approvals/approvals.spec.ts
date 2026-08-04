import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { Approvals } from './approvals';
import {
  ApiService,
  ApprovalRequest,
  Assignment,
  Project,
  Resource,
  ResourceOrganization,
  User,
  UserRole,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * D — the APPROVALS INBOX's authorization mirror. Every case here exercises
 * `scopeAllows`: before D this page offered an enabled Approve button to ANY
 * `resource-manager` for ANY pending allocation, because an Allocation step is
 * routed to that role — and the server now 403s the out-of-scope ones. The
 * fixtures are shaped so each case isolates ONE branch of the server's rule.
 *
 * ORG CHART (`managerId`):  rr -> mid -> top   (rr's manager is mid, mid's is top)
 * ORG TREE:                 Cap (managerId 'cap') > Prac > Comp
 *                           'deep' is attached to Comp — TWO levels below Cap and
 *                           with NO org-chart link to 'cap' at all, so the tree
 *                           axis is the only thing that can authorize 'cap' there.
 * 'lonely' has no manager and sits on no node -> roleFallback.
 */
const ORG_NODES: ResourceOrganization[] = [
  { id: 'n1', name: 'Cap', description: '', costCenters: [], level: 'capability', managerId: 'cap' },
  { id: 'n2', name: 'Prac', description: '', costCenters: [], level: 'practice', parentId: 'n1' },
  { id: 'n3', name: 'Comp', description: '', costCenters: [], level: 'competence', parentId: 'n2' },
];

function resource(id: string, extra: Partial<Resource> = {}): Resource {
  return {
    id, name: `Res ${id}`, role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 0, capacity: 40, ...extra,
  };
}

const RESOURCES: Resource[] = [
  resource('top'),
  resource('mid', { managerId: 'top' }),
  resource('rr', { managerId: 'mid' }),
  resource('cap'),
  resource('deep', { organization: 'Comp' }),
  resource('lonely'),
  resource('stranger'),
];

/** One assignment per target resource, so a month-row refId resolves to it. */
const ASSIGNMENTS: Assignment[] = [
  { id: 'A_RR', requestId: 'q1', resourceId: 'rr', assignedHours: 40, status: 'Requested' },
  { id: 'A_DEEP', requestId: 'q1', resourceId: 'deep', assignedHours: 40, status: 'Requested' },
  { id: 'A_LONELY', requestId: 'q1', resourceId: 'lonely', assignedHours: 40, status: 'Requested' },
];

const PROJECTS: Project[] = [];
const USERS: User[] = [];

/** An Allocation approval on `assignmentId`'s September month row. `approverId`
 *  is left ABSENT by default so the named-approver path cannot mask the scope
 *  answer — that path is an independent OR and has its own case below. */
function allocation(id: string, assignmentId: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id, kind: 'Allocation', refId: `${assignmentId}:2026-09`, requestedBy: 'planner',
    status: 'Pending', steps: [{ role: 'resource-manager', status: 'Pending' }], currentStep: 0,
    createdAt: '2026-08-01T00:00:00.000Z', ...over,
  };
}

interface SetupOptions {
  approvals?: ApprovalRequest[];
  role?: UserRole;
  userId?: string;
  resources?: Resource[];
  orgNodes?: ResourceOrganization[];
  assignments?: Assignment[];
}

/** Builds the component and FLUSHES it: the forkJoin resolves asynchronously and
 *  an unflushed component has no rows at all, so every assertion below would
 *  pass or fail vacuously. Same flush shape as
 *  allocation-approvals.component.spec.ts / resources.component.spec.ts. */
async function setup({
  approvals = [],
  role = 'resource-manager',
  userId = 'mid',
  resources = RESOURCES,
  orgNodes = ORG_NODES,
  assignments = ASSIGNMENTS,
}: SetupOptions = {}) {
  const apiStub = {
    getApprovalRequests: vi.fn(() => of(approvals)),
    getProjects: vi.fn(() => of(PROJECTS)),
    getResources: vi.fn(() => of(resources)),
    getUsers: vi.fn(() => of(USERS)),
    getAssignments: vi.fn(() => of(assignments)),
    getResourceOrganizations: vi.fn(() => of(orgNodes)),
    decideApprovalRequest: vi.fn(() => of({})),
  } as unknown as ApiService;
  const authStub = {
    authReady: signal(true), isAuthenticated: signal(true),
    role: signal(role), userId: signal(userId),
  } as unknown as AuthService;
  const notifyStub = { show: vi.fn(), error: vi.fn(), success: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    imports: [Approvals],
    providers: [
      // The Allocation row renders a RouterLink to /allocation-approvals.
      provideRouter([]),
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });
  const fixture = TestBed.createComponent(Approvals);
  const component = fixture.componentInstance;
  component.filter.set('all'); // read every row, not just the inbox-filtered ones
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component, apiStub };
}

describe('Approvals inbox — D allocation scope mirror', () => {
  it('offers the decision to a manager of a DIRECT report', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_RR')], userId: 'mid' });
    expect(component.rows()).toHaveLength(1);
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('offers the decision to a manager of a report OF A REPORT', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_RR')], userId: 'top' });
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('offers the decision to a capability manager for a resource two levels beneath, with no org-chart link', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_DEEP')], userId: 'cap' });
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('REFUSES a resource-manager who is neither — the button this page used to enable', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_RR')], userId: 'stranger' });
    const row = component.rows()[0];
    expect(row.canDecide).toBe(false);
    expect(row.approvable).toBe(false);
    // And it says WHY, instead of claiming the item awaits the very role the actor holds.
    expect(component.approveTitle(row)).toContain('do not manage this resource');
    expect(component.rejectTitle(row)).toContain('do not manage this resource');
  });

  it('keeps a resource with no manager anywhere decidable by any resource-manager (roleFallback)', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_LONELY')], userId: 'stranger' });
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('leaves admin unscoped', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_RR')], role: 'admin', userId: 'stranger' });
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('leaves the named-approver path intact for a delivery-executive pinned on the step', async () => {
    const approvals = [allocation('AR1', 'A_RR', { steps: [{ role: 'resource-manager', status: 'Pending', approverId: 'de' }] })];
    const { component } = await setup({ approvals, role: 'delivery-executive', userId: 'de' });
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('does not scope a NON-allocation kind — a resource-manager still decides a time entry', async () => {
    const timeEntry: ApprovalRequest = {
      id: 'AR2', kind: 'TimeEntry', refId: 'TE1', requestedBy: 'planner', status: 'Pending',
      steps: [{ role: 'resource-manager', status: 'Pending' }], currentStep: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    const { component } = await setup({ approvals: [timeEntry], userId: 'stranger' });
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('falls through permissively when the assignment cannot be resolved (the server does the same)', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_GONE')], userId: 'stranger' });
    expect(component.rows()[0].canDecide).toBe(true);
  });

  it('still refuses a requester deciding their own item, in scope or not', async () => {
    const approvals = [allocation('AR1', 'A_RR', { requestedBy: 'mid' })];
    const { component } = await setup({ approvals, userId: 'mid' });
    const row = component.rows()[0];
    expect(row.selfRequested).toBe(true);
    expect(row.canDecide).toBe(false);
    expect(component.approveTitle(row)).toContain('Segregation of duties');
  });

  it('drops an out-of-scope allocation from the inbox count', async () => {
    const { component } = await setup({ approvals: [allocation('AR1', 'A_RR')], userId: 'stranger' });
    expect(component.mineCount()).toBe(0);
  });
});
