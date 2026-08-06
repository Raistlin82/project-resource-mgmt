import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NEVER, of, throwError } from 'rxjs';
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
  /** false reproduces the pre-OIDC-bootstrap window (and the SSR document). */
  authReady?: boolean;
  /** Leave the six-leg forkJoin in flight (no leg ever emits). */
  pending?: boolean;
  /** Fail the /approval-requests leg, as an expired bearer does. */
  failing?: boolean;
  /** Skip the flush, for the states where whenStable() never settles. */
  noFlush?: boolean;
  /** Leave the filter on 'mine' (the real default) instead of 'all'. */
  keepFilter?: boolean;
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
  authReady = true,
  pending = false,
  failing = false,
  noFlush = false,
  keepFilter = false,
}: SetupOptions = {}) {
  // A leg that never emits keeps forkJoin — and therefore the resource — loading.
  const leg = <T>(value: T) => (pending ? NEVER : of(value));
  const apiStub = {
    getApprovalRequests: vi.fn(() =>
      failing ? throwError(() => new Error('401 Unauthorized')) : leg(approvals)),
    getProjects: vi.fn(() => leg(PROJECTS)),
    getResources: vi.fn(() => leg(resources)),
    getUsers: vi.fn(() => leg(USERS)),
    getAssignments: vi.fn(() => leg(assignments)),
    getResourceOrganizations: vi.fn(() => leg(orgNodes)),
    decideApprovalRequest: vi.fn(() => of({})),
  } as unknown as ApiService;
  const authStub = {
    authReady: signal(authReady), isAuthenticated: signal(true),
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
  if (!keepFilter) component.filter.set('all'); // read every row, not just the inbox-filtered ones
  if (noFlush) {
    // whenStable() never settles while a resource is in flight, so the pending
    // and error cases drive change detection directly instead.
    fixture.detectChanges();
    fixture.detectChanges();
  } else {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  return { fixture, component, apiStub };
}

/** The list-state's loading region — its own contract (role=status +
 *  aria-busy), not a shimmer class, so no other element can satisfy it. */
function skeleton(host: HTMLElement): Element | null {
  return host.querySelector('[role="status"][aria-busy="true"]');
}

/** The rendered text of the My-inbox badge (the count chip inside the segment). */
function badgeText(host: HTMLElement): string {
  return host.querySelector('[data-test="filter-mine"] .command-status')!.textContent!.trim();
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

/**
 * The pre-authReady window on the inbox. `res` resolves its pre-auth default
 * (EMPTY_DATA) SYNCHRONOUSLY while authReady() is false, so `isLoading()` was
 * false for the whole OIDC bootstrap — and for the SSR document. Bound bare, the
 * page told a PM with three pending allocations "Your inbox is clear." over a
 * badge reading 0.
 *
 * Every case below is paired with its opposite, and the pairing is the point:
 * a fix that pins the skeleton (or the em dash) on forever passes the first half
 * and fails the mirror, and a fix that deletes the empty state or the badge
 * fails the mirror too.
 */
describe('Approvals inbox — read-state gate on the empty copy and the count badge', () => {
  /** Three allocations on the same in-scope assignment => three approvable rows. */
  const THREE = [
    allocation('AR1', 'A_RR'),
    allocation('AR2', 'A_RR'),
    allocation('AR3', 'A_RR'),
  ];

  it('does not claim the inbox is clear before authReady, and does not print a count for a read not yet made', async () => {
    // Flushed on purpose: the pre-auth stream RESOLVES, and it is that
    // resolved-empty state — not a pending one — that this asserts about.
    // Without the flush the skeleton would be on screen because nothing had
    // settled yet, and the spec would pass with the gate removed.
    const { fixture, component } = await setup({ approvals: THREE, userId: 'mid', authReady: false, keepFilter: true });
    const host = fixture.nativeElement as HTMLElement;

    // POSITIVE CONTROLS pinning the exact state under test: the read resolved to
    // the pre-auth default AND the resource no longer reports loading. Without
    // the second, the skeleton could be showing merely because nothing flushed.
    expect(component.rows()).toEqual([]);
    expect(component['res'].isLoading()).toBe(false);

    expect(host.textContent).not.toContain('Your inbox is clear.');
    expect(host.textContent).not.toContain('Nothing is waiting on your sign-off right now.');
    expect(skeleton(host)).not.toBeNull();
    // NOT toContain('0'): that also matches '10'. No digit at all is the claim.
    expect(badgeText(host)).not.toMatch(/\d/);
    expect(badgeText(host)).toContain('Inbox count not loaded yet');
  });

  it('does not claim it while the six-leg read is genuinely in flight either', async () => {
    const { fixture, component } = await setup({ approvals: THREE, userId: 'mid', pending: true, noFlush: true, keepFilter: true });
    const host = fixture.nativeElement as HTMLElement;

    expect(component['res'].isLoading()).toBe(true);
    expect(host.textContent).not.toContain('Your inbox is clear.');
    expect(skeleton(host)).not.toBeNull();
    expect(badgeText(host)).not.toMatch(/\d/);
  });

  // THE MIRROR for the copy AND for the badge's zero. A resolved read that is
  // genuinely empty must say so and must print 0 — this is the half that a
  // permanent skeleton, or a badge pinned to the em dash, cannot pass.
  it('does say the inbox is clear once a resolved read is empty, and prints a real 0', async () => {
    const { fixture } = await setup({ approvals: [], userId: 'mid', keepFilter: true });
    const host = fixture.nativeElement as HTMLElement;

    expect(skeleton(host)).toBeNull();
    expect(host.textContent).toContain('Your inbox is clear.');
    expect(host.textContent).toContain('Nothing is waiting on your sign-off right now.');
    expect(badgeText(host)).toBe('0');
  });

  // And the non-empty mirror, so the badge is proven to carry a real count.
  it('prints the true count once the read resolves with items awaiting this actor', async () => {
    const { fixture } = await setup({ approvals: THREE, userId: 'mid', keepFilter: true });
    const host = fixture.nativeElement as HTMLElement;

    expect(skeleton(host)).toBeNull();
    expect(host.textContent).not.toContain('Your inbox is clear.');
    expect(badgeText(host)).toBe('3');
  });

  it('shows the error panel and Retry instead of aborting change detection when the read fails', async () => {
    // mineCount() -> allRows() -> res.value() THROWS in the error state, and the
    // badge that reads it renders ABOVE the wrapper — so an unguarded throw there
    // aborted the pass and made this very panel unreachable code.
    const { fixture, component } = await setup({ approvals: THREE, userId: 'mid', failing: true, noFlush: true, keepFilter: true });
    const host = fixture.nativeElement as HTMLElement;

    expect(() => fixture.detectChanges()).not.toThrow();
    // The positive control: the test cannot pass by the read quietly succeeding.
    expect(component['res'].status()).toBe('error');
    expect(host.textContent).toContain("Couldn't load approvals");
    const retry = [...host.querySelectorAll('button')].find(b => b.textContent!.includes('Retry'));
    expect(retry).toBeDefined();
    // A failed read is not an empty inbox: no clear-inbox copy, and no count.
    expect(host.textContent).not.toContain('Your inbox is clear.');
    expect(badgeText(host)).not.toMatch(/\d/);
  });
});

/**
 * UX register P2-09 — the My inbox / All pending segmented control announced
 * its selection to nobody: the pressed segment was marked by background,
 * shadow and ink classes only, so a screen-reader user heard two identical
 * buttons and could not tell which view they were looking at.
 *
 * Asserted as the PAIR, in both directions. `getAttribute('aria-pressed')` is
 * truthy even when it returns the string 'false', so a single presence check
 * would pass on a control that hard-codes one value on both buttons; requiring
 * ['true','false'] and then ['false','true'] cannot.
 */
describe('Approvals inbox — the segmented filter exposes its selection (P2-09)', () => {
  it('marks the selected segment aria-pressed=true and the other false, both ways round', async () => {
    const { fixture, component } = await setup({ approvals: [allocation('AR1', 'A_RR')], userId: 'mid' });
    const host = fixture.nativeElement as HTMLElement;
    const pressed = () =>
      Array.from(host.querySelectorAll('[data-test^="filter-"]')).map(b => b.getAttribute('aria-pressed'));

    // `setup` leaves the filter on 'all' so the scope cases can read every row.
    component.filter.set('mine');
    fixture.detectChanges();
    expect(pressed()).toEqual(['true', 'false']);

    // Driven through the rendered control, not the signal: the state has to
    // follow the button the user actually pressed.
    host.querySelector<HTMLButtonElement>('[data-test="filter-all"]')!.click();
    fixture.detectChanges();
    expect(component.filter()).toBe('all');
    expect(pressed()).toEqual(['false', 'true']);
  });
});

/**
 * UX register P3-01 — the decision note's placeholder read "Nota (opzionale)" in an
 * app whose every other string is English. On THIS control it was worse than a
 * translation slip: the input already carried an English `aria-label`, so one field
 * announced "Approval note for AR1" to a screen reader while the sighted user read
 * Italian — two labels for one input, disagreeing.
 *
 * Asserted with toBe, deliberately: 'Nota' CONTAINS 'Not', so `toContain('Note')`
 * passes on the defect itself.
 */
describe('Approvals inbox — the decision note is labelled in one language (P3-01)', () => {
  /** The note input on a row this actor may decide. */
  function noteInput(host: HTMLElement): HTMLInputElement {
    const input = host.querySelector<HTMLInputElement>('td input[type="text"]');
    expect(input, 'no decision-note input rendered — the fixture never reached a decidable row').not.toBeNull();
    return input!;
  }

  it('gives the note an English placeholder that agrees with its aria-label', async () => {
    // 'mid' is rr's manager, so the Allocation row is decidable and the note renders —
    // the same fixture the scope cases above use.
    const { fixture } = await setup({ approvals: [allocation('AR1', 'A_RR')], userId: 'mid' });
    const input = noteInput(fixture.nativeElement as HTMLElement);

    expect(input.getAttribute('placeholder')).toBe('Note (optional)');
    // The two labels on this one input must not disagree: the aria-label was already
    // English, which is what made the Italian placeholder a contradiction rather than
    // just an untranslated string.
    expect(input.getAttribute('aria-label')).toBe('Approval note for A_RR:2026-09');
  });

  it('leaves no Italian copy anywhere on the screen', async () => {
    // The ABSENCE half, and the reason the assertion above is not the whole claim: a
    // fix that only edited the placeholder while another Italian string survived
    // elsewhere on the row would pass it. Scoped to whole words so 'Nota' cannot hide
    // inside an English word and an English word cannot trip the scan.
    const { fixture } = await setup({ approvals: [allocation('AR1', 'A_RR')], userId: 'mid' });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.innerHTML).not.toMatch(/\b(Nota|opzionale|obbligatorio|Annulla|Conferma)\b/i);
    // …and the row really is there, so the scan above is not passing on an empty page.
    expect(noteInput(host)).not.toBeNull();
  });
});
