import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, Subject } from 'rxjs';
import { ApprovalModalComponent } from './approval-modal.component';
import {
  AllocationApprovalRow,
  AllocationDecisionItem,
  AllocationDecisionResult,
  ApiService,
  Resource,
  ResourceOrganization,
  SubstitutionResult,
  UserRole,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/** One resource, two projects in the same month: one pending, one already approved.
 *  `managerId` + `approvalId` are part of the decidability contract (a pending
 *  month with no approval, or a resource this actor does not manage, is not
 *  decidable), so every fixture carries them exactly as the feed does. */
const ROW: AllocationApprovalRow = {
  resourceId: 'r1', resourceName: 'Ada', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 120 },
  items: [
    { assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, plannerNote: 'kickoff', approvalId: 'AR1' },
    { assignmentMonthId: 'A2:2026-09', assignmentId: 'A2', month: '2026-09', status: 'Allocated', requestId: '2', projectName: 'Gemini', hours: 40 },
  ],
};

/** One resource, TWO pending projects in the same month — needed to exercise a
 *  mixed decided/error batch response (ROW above has only one decidable item). */
const ROW_TWO_PENDING: AllocationApprovalRow = {
  resourceId: 'r1', resourceName: 'Ada', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 120 },
  items: [
    { assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, approvalId: 'AR1' },
    { assignmentMonthId: 'A3:2026-09', assignmentId: 'A3', month: '2026-09', status: 'Requested', requestId: '3', projectName: 'Mercury', hours: 40, approvalId: 'AR3' },
  ],
};

/** A second resource with its own pending item — used for multi-resource setup. */
const ROW_2: AllocationApprovalRow = {
  resourceId: 'r2', resourceName: 'Bob', managerId: 'm2', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 80 },
  items: [
    { assignmentMonthId: 'B1:2026-09', assignmentId: 'B1', month: '2026-09', status: 'Requested', requestId: '4', projectName: 'Zeus', hours: 80, approvalId: 'AR4' },
  ],
};

/**
 * C2 candidate pool: 'r1' is the DUMMY itself (kind 'dummy', organization
 * 'Digital' — the row.resourceId ROW/ROW_DUMMY carry), 'r9'/'r10' are real,
 * available people ('r9' in the same 'Digital' org as the dummy, 'r10' in a
 * different org — exercises the organization pre-filter), and 'r11' is an
 * internal resource terminated in the past, which must never be offered.
 */
const RESOURCES: Resource[] = [
  { id: 'r1', name: 'Dummy Ada', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 0, kind: 'dummy', organization: 'Digital' },
  { id: 'r9', name: 'Nora Fenn', role: 'Backend Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 0, kind: 'internal', organization: 'Digital' },
  { id: 'r10', name: 'Sam Cole', role: 'QA Engineer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 0, kind: 'internal', organization: 'Cloud' },
  { id: 'r11', name: 'Terminated Tom', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 0, kind: 'internal', organization: 'Digital', terminationDate: '2020-01-01' },
];

/**
 * Fixtures for the two catalogue-race cases below. The principal ('mgr',
 * 'resource-manager') is authorized THROUGH the catalogue reads, never by the
 * feed row's own `managerId` — none of these rows carries one — so
 * `canDecideFor` really does dereference `resources()` and `orgNodes()` and the
 * modal really does recompute when either lands. That is the whole point: with
 * an admin principal `canDecideFor` short-circuits on the role and neither read
 * is ever touched, so the same test would pass vacuously.
 */
const RACE_CATALOGUE: Resource[] = (
  [
    // The signed-in manager themself: the org CHART walk resolves managers
    // through this list, so an id absent from it authorizes nobody.
    { id: 'mgr', name: 'Manager Mo' },
    // 'p1' reports to 'mgr' directly -> its lines are decidable in BOTH windows,
    // before and after either read lands.
    { id: 'p1', name: 'Ada', managerId: 'mgr' },
    // 'p2' hangs off a node somebody ELSE manages: decidable only while the tree
    // (or the resource list that names its organization) is still missing —
    // `roleFallback` — and refused the moment it arrives. That FLIP is the
    // DOM-visible proof the emission was flushed.
    { id: 'p2', name: 'Bob', organization: 'Cap' },
  ] as Partial<Resource>[]
).map(r => ({
  role: 'Developer', skills: [], projectRoles: [], externalExperience: [],
  utilization: 0, capacity: 40, kind: 'internal' as const, ...r,
})) as Resource[];

const RACE_TREE: ResourceOrganization[] = [
  { id: 'n1', name: 'Cap', description: '', costCenters: [], level: 'capability', managerId: 'other' },
];

/** Two decidable lines on a resource 'mgr' manages. `A1` is the one the approver
 *  un-checks; `A2` is the untouched line that must STAY checked. */
const ROW_RACE_A: AllocationApprovalRow = {
  resourceId: 'p1', resourceName: 'Ada', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 120 },
  items: [
    { assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, approvalId: 'AR1' },
    { assignmentMonthId: 'A2:2026-09', assignmentId: 'A2', month: '2026-09', status: 'Requested', requestId: '2', projectName: 'Gemini', hours: 40, approvalId: 'AR2' },
  ],
};

/** The line whose decidability FLIPS when the pending read lands. No
 *  `organization` on the ROW itself — the resource list is what carries it, so
 *  the flip is driven by the read under test and not by the feed. */
const ROW_RACE_B: AllocationApprovalRow = {
  resourceId: 'p2', resourceName: 'Bob', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 80 },
  items: [
    { assignmentMonthId: 'B1:2026-09', assignmentId: 'B1', month: '2026-09', status: 'Requested', requestId: '3', projectName: 'Zeus', hours: 80, approvalId: 'AR3' },
  ],
};

/** One resource booked in TWO consecutive months — the shape the double-click
 *  case needs, since it must show that the SECOND month is still decidable. */
const ROW_TWO_MONTHS: AllocationApprovalRow = {
  resourceId: 'r1', resourceName: 'Ada', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176, '2026-10': 176 }, totalHours: { '2026-09': 80, '2026-10': 80 },
  items: [
    { assignmentMonthId: 'M1:2026-09', assignmentId: 'M1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, approvalId: 'AR1' },
    { assignmentMonthId: 'M1:2026-10', assignmentId: 'M1', month: '2026-10', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, approvalId: 'AR2' },
  ],
};

/**
 * THE SWEEP FIXTURE (RPT §4.2 "Allocazione multipla"). TWO resources, each with
 * a pending, decidable project in September AND in November — the minimum shape
 * in which the multi-resource sweep proves anything at all: with one resource,
 * or with one month, "advance to the next month that has work" and "advance
 * blindly to the next month" are the same move and no assertion can tell them
 * apart.
 *
 * OCTOBER, in between, is the month with nothing to decide — and it is barren in
 * each of the ways a cheaper availability rule gets wrong:
 *   - Ada's October line exists and is already 'Allocated' (so "the month has
 *     lines" is not availability), and
 *   - Bob's October line IS 'Requested' but carries NO `approvalId` — the
 *     stranded pre-B3 shape nothing can decide (so "some line is pending" is
 *     not availability either).
 * Only the full `decidable()` predicate skips October, which is exactly what
 * makes "lands on November" falsifiable.
 */
const SWEEP_MONTHS = ['2026-09', '2026-10', '2026-11'];

const SWEEP_ADA: AllocationApprovalRow = {
  resourceId: 'r1', resourceName: 'Ada', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176, '2026-10': 176, '2026-11': 176 },
  totalHours: { '2026-09': 80, '2026-10': 80, '2026-11': 80 },
  items: [
    { assignmentMonthId: 'S1:2026-09', assignmentId: 'S1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, approvalId: 'AR1' },
    // Already decided — nothing for the sweep to stop for.
    { assignmentMonthId: 'S1:2026-10', assignmentId: 'S1', month: '2026-10', status: 'Allocated', requestId: '1', projectName: 'Apollo', hours: 80 },
    { assignmentMonthId: 'S1:2026-11', assignmentId: 'S1', month: '2026-11', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, approvalId: 'AR2' },
  ],
};

const SWEEP_BOB: AllocationApprovalRow = {
  resourceId: 'r2', resourceName: 'Bob', managerId: 'm2', kind: 'internal', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176, '2026-10': 176, '2026-11': 176 },
  totalHours: { '2026-09': 40, '2026-10': 40, '2026-11': 40 },
  items: [
    { assignmentMonthId: 'T1:2026-09', assignmentId: 'T1', month: '2026-09', status: 'Requested', requestId: '4', projectName: 'Zeus', hours: 40, approvalId: 'AR3' },
    // Pending, but with NO approval: undecidable, so October stays barren.
    { assignmentMonthId: 'T1:2026-10', assignmentId: 'T1', month: '2026-10', status: 'Requested', requestId: '4', projectName: 'Zeus', hours: 40 },
    { assignmentMonthId: 'T1:2026-11', assignmentId: 'T1', month: '2026-11', status: 'Requested', requestId: '4', projectName: 'Zeus', hours: 40, approvalId: 'AR4' },
  ],
};

/** What the server answers for a whole-month sweep batch, per month. */
const SWEEP_RESULTS = (month: string) => [
  { assignmentMonthId: `S1:${month}`, status: 'Approved' },
  { assignmentMonthId: `T1:${month}`, status: 'Approved' },
];

interface SetupOptions {
  rows?: AllocationApprovalRow[];
  months?: string[];
  multi?: boolean;
  decideResults?: { assignmentMonthId: string; status: string; error?: string }[];
  /**
   * Override the OBSERVABLE `decideAllocationMonths()` returns. Defaults to a
   * synchronous `of({ results })`, which answers INSIDE the click handler and
   * so cannot show anything about an in-flight decision. Pass a Subject to hold
   * the batch open across a second click.
   */
  decideSource?: Observable<{ results: AllocationDecisionResult[] }>;
  /** Effective role of the signed-in principal (mirrors AuthService.role()). */
  role?: UserRole;
  /** The principal's RESOURCE id (mirrors AuthService.userId()). */
  userId?: string;
  /** Resources `getResources()` resolves with — the Substitute picker's candidate
   *  pool AND (D) the org-chart axis `canDecideFor` scopes on. */
  resources?: Resource[];
  /** D — the org tree `getResourceOrganizations()` resolves with: the second
   *  scope axis. Empty by default, which means "no node has a manager". */
  orgs?: ResourceOrganization[];
  /**
   * Override the OBSERVABLE `getResourceOrganizations()` returns, independent
   * of `orgs`. Defaults to a synchronous `of(orgs)`, which is what makes the
   * two rxResources (`resources`, `orgNodes`) settle together in every
   * ordinary test — a shape the real `/resource-organizations` and
   * `/resources` calls do NOT share, since they are two independent HTTP
   * requests. Pass a controllable source (e.g. a `Subject`) to pin behaviour
   * that depends on the tree arriving AFTER the resource list.
   */
  orgsSource?: Observable<ResourceOrganization[]>;
  /**
   * Same seam as `orgsSource`, for the OTHER catalogue leg. `/resources` and
   * `/resource-organizations` are two independent requests; either one can be
   * the last to land, so both windows need pinning.
   */
  resourcesSource?: Observable<Resource[]>;
  /** Result `substituteDummyMonth()` resolves with. */
  substituteResult?: SubstitutionResult;
}

function setup({
  rows = [ROW],
  months = ['2026-09'],
  multi = false,
  decideResults = [{ assignmentMonthId: 'A1:2026-09', status: 'Approved' }],
  // Default principal: an admin, which the server lets decide any step — so the
  // pre-existing cases below keep exercising the decision flow, not the gate.
  role = 'admin',
  userId = 'm1',
  resources = RESOURCES,
  orgs = [],
  orgsSource,
  resourcesSource,
  decideSource,
  substituteResult = {
    targetResourceId: 'r9', targetResourceName: 'Nora Fenn',
    outcomes: [{ month: '2026-09', transferredHours: 8, remainingHours: 0, targetAssignmentMonthId: 'X1:2026-09', status: 'Requested' }],
  },
}: SetupOptions = {}) {
  /** Every batch payload the component sent, in order — what the double-click
   *  case asserts on (the call COUNT and the ids, never the DOM). */
  const decideCalls: AllocationDecisionItem[][] = [];
  const decideAllocationMonths = vi.fn((items: AllocationDecisionItem[]) => {
    decideCalls.push(items);
    return decideSource ?? of({ results: decideResults });
  });
  const getResources = vi.fn(() => resourcesSource ?? of(resources));
  const getResourceOrganizations = vi.fn(() => orgsSource ?? of(orgs));
  const substituteDummyMonth = vi.fn(() => of(substituteResult));
  const apiStub = { decideAllocationMonths, getResources, getResourceOrganizations, substituteDummyMonth } as unknown as ApiService;
  const notifyStub = { success: vi.fn(), error: vi.fn() } as unknown as NotificationService;
  const authStub = {
    authReady: signal(true), isAuthenticated: signal(true),
    role: signal(role), userId: signal(userId),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ApprovalModalComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });
  const fixture = TestBed.createComponent(ApprovalModalComponent);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('months', months);
  fixture.componentRef.setInput('multi', multi);
  fixture.detectChanges();
  return { fixture, decideAllocationMonths, decideCalls, getResources, substituteDummyMonth, notifyStub };
}

describe('ApprovalModalComponent', () => {
  it('lists one line per project of the selected month', () => {
    const { fixture } = setup();
    const lines = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="project-line"]');
    expect(lines.length).toBe(2);
    expect(lines[0].textContent).toContain('Apollo');
  });

  it('pre-checks only the pending months', () => {
    const { fixture } = setup();
    expect([...fixture.componentInstance.checked()]).toEqual(['A1:2026-09']);
  });

  it('sends exactly the checked months to the batch decision', () => {
    const { fixture, decideAllocationMonths } = setup();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.click();

    expect(decideAllocationMonths).toHaveBeenCalledWith([
      { assignmentMonthId: 'A1:2026-09', decision: 'Approved', note: undefined },
    ]);
  });

  it('sends Rejected with the approver note', () => {
    const { fixture, decideAllocationMonths } = setup();
    fixture.componentInstance.setApproverNote('A1:2026-09', 'no capacity');
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="reject-month"]')!.click();

    expect(decideAllocationMonths).toHaveBeenCalledWith([
      { assignmentMonthId: 'A1:2026-09', decision: 'Rejected', note: 'no capacity' },
    ]);
  });

  it('disables the actions when nothing is checked', () => {
    const { fixture } = setup({ rows: [{ ...ROW, items: [ROW.items[1]] }] });
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-month"]')!;
    expect(button.disabled).toBe(true);
  });

  it('deep-links a line to its allocation calendar for the selected month', () => {
    const { fixture } = setup();
    const emitted: { assignmentId: string; resourceName: string; month: string }[] = [];
    fixture.componentInstance.openCalendar.subscribe(e => emitted.push(e));

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="open-calendar"]')!.click();

    expect(emitted).toEqual([{ assignmentId: 'A1', resourceName: 'Ada', month: '2026-09' }]);
  });
});

describe('ApprovalModalComponent — decidability (final-review finding)', () => {
  /** A 'Requested' month with NO approvalId — the shape a pre-B3 database's
   *  backfill leaves behind. Nothing can decide it, so it must not be offered. */
  const ROW_STRANDED: AllocationApprovalRow = {
    ...ROW,
    items: [{ assignmentMonthId: 'A9:2026-09', assignmentId: 'A9', month: '2026-09', status: 'Requested', requestId: '9', projectName: 'Orphan', hours: 8 }],
  };

  it('does not offer a pending month that carries no approval', () => {
    const { fixture } = setup({ rows: [ROW_STRANDED] });
    const host = fixture.nativeElement as HTMLElement;

    expect([...fixture.componentInstance.checked()]).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Orphan"]')!.disabled).toBe(true);
    expect(host.querySelector('[data-test="line-blocked"]')!.textContent).toContain('No pending approval');
    expect(host.querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.disabled).toBe(true);
  });

  it('does not offer another manager\'s resource to a delivery-executive', () => {
    // 'delivery-executive' matches no allocation step's role, so the server only
    // lets them decide resources they personally manage.
    const { fixture } = setup({ role: 'delivery-executive', userId: 'someone-else' });
    const host = fixture.nativeElement as HTMLElement;

    expect([...fixture.componentInstance.checked()]).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(true);
    expect(host.querySelector('[data-test="line-blocked"]')!.textContent).toContain("Only Ada's manager");
  });

  it('offers the resource\'s own manager the pending line', () => {
    const { fixture } = setup({ role: 'delivery-executive', userId: 'm1' });
    expect([...fixture.componentInstance.checked()]).toEqual(['A1:2026-09']);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="line-blocked"]')).toBeNull();
  });

});

/**
 * D (design spec §3.4) — the modal must mirror the SCOPED server rule, not the
 * pre-D "any resource-manager decides anything" fallback it used to mirror.
 *
 * Fixtures: 's1' is the target and has NO `managerId` at all — neither on its
 * resource row nor on the feed row — so nothing here can pass through the
 * named-approver shortcut and every assertion below really does exercise the
 * ORG TREE axis. It is attached to the 'Platform' practice, whose parent
 * capability 'Engineering' is managed by 's9'. 's2' is the org-CHART case: it
 * reports to 's3', who reports to 's9'. 's0' sits under 'Cloud', a capability
 * with no manager, and has no manager of its own — the `roleFallback` case.
 *
 * Every test FLUSHES first: both lists resolve asynchronously, and an unflushed
 * fixture would see an empty tree, which is legitimately permissive (see
 * `canDecideFor`) — so a refusal asserted without flushing would be asserting
 * nothing.
 */
describe('ApprovalModalComponent — scoped decision (D §3.4)', () => {
  const base = {
    role: 'Developer', skills: [], projectRoles: [], externalExperience: [],
    utilization: 0, capacity: 40, kind: 'internal' as const,
  };
  const SCOPE_RESOURCES: Resource[] = [
    { ...base, id: 's1', name: 'Scoped Sam', organization: 'Platform' },
    { ...base, id: 's2', name: 'Chained Chris', organization: 'Cloud', managerId: 's3' },
    { ...base, id: 's3', name: 'Middle Mo', organization: 'Cloud', managerId: 's9' },
    { ...base, id: 's9', name: 'Node Manager Nia', organization: 'Engineering' },
    { ...base, id: 'sX', name: 'Stranger Stan', organization: 'Cloud' },
    { ...base, id: 's0', name: 'Unmanaged Uma', organization: 'Cloud' },
    // Review round 4: a node manager who has LEFT, and the report stranded under
    // their node. Nothing revisits a stored managerId when a terminationDate is
    // set, so this shape is reachable in ordinary data.
    { ...base, id: 's7', name: 'Departed Dana', organization: 'Legacy', terminationDate: '2020-01-01' },
    { ...base, id: 's6', name: 'Stranded Sid', organization: 'Legacy' },
  ];
  const SCOPE_ORGS: ResourceOrganization[] = [
    { id: 'o1', name: 'Engineering', description: '', costCenters: [], level: 'capability', managerId: 's9' },
    { id: 'o2', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: 'o1' },
    { id: 'o3', name: 'Cloud', description: '', costCenters: [], level: 'capability' },
    { id: 'o4', name: 'Legacy', description: '', costCenters: [], level: 'capability', managerId: 's7' },
  ];

  /** A feed row for `resourceId` with ONE pending, decidable-shaped item and NO
   *  `managerId`, so only the scope rule can admit anyone. */
  const rowFor = (resourceId: string, resourceName: string): AllocationApprovalRow => ({
    resourceId, resourceName, kind: 'internal', contractHoursPerDay: 8,
    targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 8 },
    items: [{
      assignmentMonthId: 'S1:2026-09', assignmentId: 'S1', month: '2026-09', status: 'Requested',
      requestId: '1', projectName: 'Apollo', hours: 8, approvalId: 'AR9',
    }],
  });

  const scopeSetup = (role: UserRole, userId: string, resourceId = 's1', resourceName = 'Scoped Sam') =>
    setup({ rows: [rowFor(resourceId, resourceName)], resources: SCOPE_RESOURCES, orgs: SCOPE_ORGS, role, userId });

  it("offers the line to a resource-manager who manages a node ABOVE the resource's own", async () => {
    const { fixture } = scopeSetup('resource-manager', 's9');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(false);
    expect(host.querySelector('[data-test="line-blocked"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.disabled).toBe(false);
  });

  it('offers the line to a resource-manager who is a TRANSITIVE manager in the org chart', async () => {
    const { fixture } = scopeSetup('resource-manager', 's9', 's2', 'Chained Chris');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(false);
    expect(host.querySelector('[data-test="line-blocked"]')).toBeNull();
  });

  it('does NOT offer the line to a resource-manager outside the scope (the pre-D fallback)', async () => {
    const { fixture } = scopeSetup('resource-manager', 'sX');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(true);
    expect(host.querySelector('[data-test="line-blocked"]')!.textContent).toContain("Only Scoped Sam's manager");
    expect(host.querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.disabled).toBe(true);
    expect([...fixture.componentInstance.checked()]).toEqual([]);
  });

  it('offers the line to an admin regardless of scope', async () => {
    const { fixture } = scopeSetup('admin', 'sX');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(false);
    expect(host.querySelector('[data-test="line-blocked"]')).toBeNull();
  });

  it('keeps the line open to ANY resource-manager when the resource has no manager anywhere', async () => {
    // The C2 case: a placeholder with no `managerId` under a node with no
    // manager. Refusing here would strand every substitution.
    const { fixture } = scopeSetup('resource-manager', 'sX', 's0', 'Unmanaged Uma');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(false);
    expect(host.querySelector('[data-test="line-blocked"]')).toBeNull();
  });

  it("offers the line to a Capability Leader whose global role is routed to NO allocation step", async () => {
    // REVIEW ROUND 4 (critical #1). 's9' manages the node above the target and
    // is NOT the row's named approver (the row carries no managerId at all).
    // Their global role is 'delivery-executive', which no allocation step is
    // routed to — so before the fix this rendered a DISABLED checkbox reading
    // "Only Scoped Sam's manager can decide this month" TO ITS MANAGER, and only
    // an admin could clear the month. Being accountable is an allow of its own.
    const { fixture } = scopeSetup('delivery-executive', 's9');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(false);
    expect(host.querySelector('[data-test="line-blocked"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.disabled).toBe(false);
  });

  it('falls back to any resource-manager when the only accountable manager has been terminated', async () => {
    // REVIEW ROUND 4 (critical #1, second trigger). 's6' sits under 'Legacy',
    // whose manager 's7' left in 2020. Structurally 's7' is still an approver,
    // which used to keep `roleFallback` false and make the whole subtree
    // admin-only. An approver who cannot act must not suppress the fallback.
    const { fixture } = scopeSetup('resource-manager', 'sX', 's6', 'Stranded Sid');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(false);
    expect(host.querySelector('[data-test="line-blocked"]')).toBeNull();
  });

  it('does NOT fall back while that node manager is still active', async () => {
    // The contrast that keeps the rule honest: same shape, active manager
    // ('Engineering'/'s9'), and the stranger stays refused.
    const { fixture } = scopeSetup('resource-manager', 'sX');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.disabled).toBe(true);
  });
});

/**
 * B7 / P2-22 — the footer copy is the user's only statement of what a decision
 * will affect, so every assertion below reads the RENDERED label with `toBe` on
 * the trimmed text: `toContain('Approve')` is true of every state this batch
 * distinguishes, and so is `toContain('selected')` once the fix exists.
 *
 * ROW_TWO_PENDING is the fixture that makes these falsifiable: it has TWO
 * decidable lines, so "the whole month" and "part of the month" are different
 * batches. Against ROW (one decidable line) every label below would read
 * identically whether the code consults `checked()` or `rows()`.
 */
describe('ApprovalModalComponent — scope-truthful copy (P2-22)', () => {
  const textOf = (host: HTMLElement, test: string) =>
    host.querySelector(`[data-test="${test}"]`)!.textContent!.trim();

  it('counts the batch in both action labels once the selection narrows below the month, and restores the month copy on the way back', () => {
    const { fixture } = setup({ rows: [ROW_TWO_PENDING] });
    const host = fixture.nativeElement as HTMLElement;

    // Both pending lines start checked, so the batch really IS the whole month.
    expect(fixture.componentInstance.checked().size).toBe(2);
    expect(textOf(host, 'approve-label')).toBe('Approve month');
    expect(textOf(host, 'reject-label')).toBe('Reject month');

    host.querySelector<HTMLInputElement>('[aria-label="Select Mercury"]')!.click();
    fixture.detectChanges();

    expect(textOf(host, 'approve-label')).toBe('Approve selected (1)');
    expect(textOf(host, 'reject-label')).toBe('Reject selected (1)');

    // The round trip: re-checking the line makes the batch the month again, so a
    // label hardcoded to the narrowed copy cannot pass either.
    host.querySelector<HTMLInputElement>('[aria-label="Select Mercury"]')!.click();
    fixture.detectChanges();

    expect(textOf(host, 'approve-label')).toBe('Approve month');
    expect(textOf(host, 'reject-label')).toBe('Reject month');
  });

  it('counts the multi-resource batch without dropping its "& Continue" promise', () => {
    // SWEEP_ADA contributes one decidable September line (Apollo), SWEEP_BOB one
    // (Zeus) — and November still holds work for both, which is what entitles
    // the label to promise a continuation at all (see the sweep suite below).
    const { fixture } = setup({ rows: [SWEEP_ADA, SWEEP_BOB], months: SWEEP_MONTHS, multi: true });
    const host = fixture.nativeElement as HTMLElement;
    expect(textOf(host, 'approve-label')).toBe('Approve & Continue');

    host.querySelector<HTMLInputElement>('[aria-label="Select Zeus"]')!.click();
    fixture.detectChanges();

    expect(textOf(host, 'approve-label')).toBe('Approve selected (1) & Continue');
    expect(host.querySelector('[data-test="approve-month"]')).toBeNull(); // still the multi action
  });

  it('summarises the scope in the footer and re-states it when the selection changes', () => {
    const { fixture } = setup({ rows: [ROW_TWO_PENDING] });
    const host = fixture.nativeElement as HTMLElement;
    expect(textOf(host, 'scope-summary')).toBe('2 of 2 projects selected in September 2026.');

    host.querySelector<HTMLInputElement>('[aria-label="Select Mercury"]')!.click();
    fixture.detectChanges();

    expect(textOf(host, 'scope-summary')).toBe('1 of 2 projects selected in September 2026.');
  });

  it('claims no batch at all when the actor can decide none of the month', () => {
    // Same shape as the decidability suite's refusal case: a pending line this
    // actor is not the manager of. Nothing is checkable, so the summary must not
    // read as "0 of 1 selected" (an invitation) and the label must not count.
    const { fixture } = setup({ role: 'delivery-executive', userId: 'someone-else' });
    const host = fixture.nativeElement as HTMLElement;

    expect(textOf(host, 'scope-summary')).toBe('Nothing here can be decided by you in September 2026.');
    expect(textOf(host, 'approve-label')).toBe('Approve month');
    expect(host.querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.disabled).toBe(true);
  });

  it('heads the panel with the month under review rather than promising to approve it', () => {
    const { fixture } = setup({ rows: [ROW_TWO_PENDING] });
    const host = fixture.nativeElement as HTMLElement;
    const title = () => host.querySelector('#approvalModalTitle')!.textContent!.trim();
    expect(title()).toBe('Month approval — Ada');

    host.querySelector<HTMLInputElement>('[aria-label="Select Mercury"]')!.click();
    fixture.detectChanges();

    // Deliberately unchanged: the heading states no scope, so narrowing the
    // batch cannot make it wrong (the footer carries the count instead).
    expect(title()).toBe('Month approval — Ada');
  });

  it('lets the project row, its project name and the footer wrap — STRUCTURE ONLY: jsdom performs no layout, so the 390px overflow this fixes is not observable in this suite', () => {
    const { fixture } = setup({ rows: [ROW_TWO_PENDING] });
    const host = fixture.nativeElement as HTMLElement;

    const row = host.querySelector('[data-test="project-line"] [data-test="line-row"]')!;
    expect(row.classList.contains('flex-wrap')).toBe(true);
    // Without min-w-0 a flex-1 item refuses to shrink below its content, so the
    // row stays wider than the card however it wraps.
    expect(row.querySelector('[data-test="line-project"]')!.classList.contains('min-w-0')).toBe(true);
    expect(host.querySelector('[data-test="modal-footer"]')!.classList.contains('flex-wrap')).toBe(true);
  });
});

describe('ApprovalModalComponent — mixed and failed decisions (carried-forward finding)', () => {
  it('surfaces the single error verbatim and still emits decided on a mixed decided/error response', () => {
    const { fixture, notifyStub } = setup({
      rows: [ROW_TWO_PENDING],
      decideResults: [
        { assignmentMonthId: 'A1:2026-09', status: 'Approved' },
        { assignmentMonthId: 'A3:2026-09', status: 'Error', error: 'Locked period' },
      ],
    });
    let decidedEmitted = 0;
    fixture.componentInstance.decided.subscribe(() => decidedEmitted++);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.click();

    expect(notifyStub.error).toHaveBeenCalledWith('Locked period');
    expect(notifyStub.success).not.toHaveBeenCalled();
    expect(decidedEmitted).toBe(1);
  });

  it('summarises HOW MANY failed alongside the first message when several error', () => {
    const { fixture, notifyStub } = setup({
      rows: [ROW_TWO_PENDING],
      decideResults: [
        { assignmentMonthId: 'A1:2026-09', status: 'Error', error: 'Locked period' },
        { assignmentMonthId: 'A3:2026-09', status: 'Error', error: 'Another failure' },
      ],
    });
    let decidedEmitted = 0;
    fixture.componentInstance.decided.subscribe(() => decidedEmitted++);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.click();

    expect(notifyStub.error).toHaveBeenCalledWith('2 of 2 months could not be decided. First error: Locked period');
    expect(notifyStub.success).not.toHaveBeenCalled();
    expect(decidedEmitted).toBe(1);
  });
});

describe('ApprovalModalComponent — closes on nothing left to decide (carried-forward finding)', () => {
  it('shows a success toast and closes after deciding the only pending item in single mode', () => {
    const { fixture, notifyStub } = setup(); // default ROW: one pending item (A1), one already-Allocated (A2)
    let closedEmitted = 0;
    fixture.componentInstance.closed.subscribe(() => closedEmitted++);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.click();

    expect(notifyStub.success).toHaveBeenCalled();
    expect(notifyStub.error).not.toHaveBeenCalled();
    expect(closedEmitted).toBe(1);
  });

  it('stays open when other pending items remain after the decision', () => {
    const { fixture } = setup({ rows: [ROW_TWO_PENDING] }); // two pending items, only checked ones decided
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLInputElement>('[aria-label="Select Mercury"]')!.click(); // uncheck A3, leaving it pending
    fixture.detectChanges();
    let closedEmitted = 0;
    fixture.componentInstance.closed.subscribe(() => closedEmitted++);

    host.querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.click();

    expect(closedEmitted).toBe(0);
  });
});

/**
 * Mode PLUMBING only — which action and which body layout each mode renders.
 * Where the sweep goes after a decision, and what it does when it runs out of
 * months, is pinned by the sweep suite further down (it supersedes the two
 * advance/close cases that used to live here: both of their fixtures had no
 * later month holding work, so neither could tell a month-skipping advance from
 * a blind one, and the terminal case asserted the auto-close the sweep no longer
 * performs).
 */
describe('ApprovalModalComponent — multi-resource mode', () => {
  it('renders the single-month action when multi is false', () => {
    const { fixture } = setup({ rows: [ROW], months: ['2026-09'], multi: false });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="approve-continue"]')).toBeNull();
    expect(host.querySelector('[data-test="approve-month"]')).not.toBeNull();
  });

  it('renders one collapsible section per resource, headed by the resource name', () => {
    const { fixture } = setup({ rows: [ROW, ROW_2], months: ['2026-09'], multi: true });
    const sections = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="resource-section"]');
    expect(sections.length).toBe(2);
    expect(sections[0].textContent).toContain('Ada');
    expect(sections[1].textContent).toContain('Bob');
  });
});

/**
 * RPT §4.2 — the multi-resource MONTH SWEEP behind "Approve & Continue": the
 * panel stays open and walks itself forward, so N resources' pending months are
 * cleared without ever reopening the modal or touching the month selector.
 *
 * Every case below is a PAIR, because each half alone is passed by a broken
 * implementation:
 *   - "advances to November" alone is passed by a blind `idx + 1` if the fixture
 *     has no barren month in between (hence October, barren in two different
 *     ways — see SWEEP_MONTHS), and
 *   - "does not advance past the last month with work" alone is passed by an
 *     implementation that never advances at all.
 * The month the sweep lands on is asserted together with the state of that
 * month's footer: an advance onto a month whose actions are dead is the dead end
 * this rule exists to prevent, and "we moved" on its own cannot see it.
 */
describe('ApprovalModalComponent — multi-resource month sweep (RPT §4.2)', () => {
  const textOf = (host: HTMLElement, test: string) =>
    host.querySelector(`[data-test="${test}"]`)!.textContent!.trim();
  const approveContinue = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!;

  /**
   * Change the month the way the approver does — set the value, dispatch
   * 'change'. The component binds `(change)` plus a per-option `[selected]`
   * (never `[value]`/`ngModel` on the <select>), so this is the only path that
   * matches production; writing `selectedMonth` directly would bypass
   * `onMonthChange` and with it the notice-withdrawal below.
   */
  function selectMonth(fixture: { nativeElement: unknown; detectChanges: () => void }, month: string): void {
    const select = (fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('[aria-label="Open months"]')!;
    select.value = month;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
  }

  function sweepSetup(month = '2026-09') {
    const result = setup({
      rows: [SWEEP_ADA, SWEEP_BOB], months: SWEEP_MONTHS, multi: true,
      decideResults: SWEEP_RESULTS(month),
    });
    let closedEmitted = 0;
    result.fixture.componentInstance.closed.subscribe(() => closedEmitted++);
    return { ...result, host: result.fixture.nativeElement as HTMLElement, closedCount: () => closedEmitted };
  }

  it('skips a month with nothing decidable and lands on the next month that still has work — with that month live', () => {
    const { fixture, host, closedCount } = sweepSetup();
    const component = fixture.componentInstance;

    // September opens as the whole month across BOTH resources.
    expect([...component.checked()].sort()).toStrictEqual(['S1:2026-09', 'T1:2026-09']);

    approveContinue(host).click();
    fixture.detectChanges();

    // October is passed over: Ada's line there is already Allocated, Bob's is
    // pending with no approval. A blind `idx + 1` stops on it.
    expect(component.selectedMonth()).toBe('2026-11');
    expect(closedCount()).toBe(0);
    // ...and the landing month is LIVE — both resources' November lines are
    // checked and the primary action is enabled, which is the whole reason the
    // barren month is skipped rather than presented.
    expect([...component.checked()].sort()).toStrictEqual(['S1:2026-11', 'T1:2026-11']);
    expect(approveContinue(host).disabled).toBe(false);
    expect(host.querySelector('[data-test="sweep-complete"]')).toBeNull();
  });

  it('sends the LANDING month\'s own rows on the next decision, for both resources', () => {
    // The advance is only worth anything if the month it lands on is the month
    // the next batch decides: an advance that moved the label but not the
    // payload would re-send September twice.
    const { fixture, host, decideCalls } = sweepSetup();

    approveContinue(host).click();
    fixture.detectChanges();
    approveContinue(host).click();

    expect(decideCalls.length).toBe(2);
    expect(decideCalls[0].map(i => i.assignmentMonthId).sort()).toStrictEqual(['S1:2026-09', 'T1:2026-09']);
    expect(decideCalls[1].map(i => i.assignmentMonthId).sort()).toStrictEqual(['S1:2026-11', 'T1:2026-11']);
  });

  it('ABSENCE TWIN: on the last month with work it does NOT move and does NOT close — it declares itself finished (DOM presence only: jsdom lays out nothing, so "visible" here means present and named in the accessibility tree)', () => {
    const { fixture, host, closedCount } = sweepSetup('2026-11');
    selectMonth(fixture, '2026-11');

    // The label stops promising a continuation BEFORE the click — nothing after
    // November holds work, so "& Continue" would be an overpromise.
    expect(textOf(host, 'approve-label')).toBe('Approve month');
    expect(host.querySelector('[data-test="sweep-complete"]')).toBeNull();

    approveContinue(host).click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedMonth()).toBe('2026-11'); // no walk off the end
    expect(closedCount()).toBe(0);                                     // and no silent close
    const notice = host.querySelector('[data-test="sweep-complete"]')!;
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('November 2026');
    expect(notice.textContent).toContain('no later month');
    // STRUCTURE, not appearance (jsdom resolves no layout and no scroll): the
    // notice is a sibling of the scrolling region, not a child of it. Inside it,
    // a panel the approver had scrolled down would announce the end of the sweep
    // above the fold.
    expect(notice.closest('.overflow-y-auto')).toBeNull();
    expect(host.querySelector('[data-test="sweep-complete-band"]')!.classList.contains('shrink-0')).toBe(true);
  });

  it('promises "& Continue" only while a later month still holds work', () => {
    const { fixture, host } = sweepSetup();

    expect(textOf(host, 'approve-label')).toBe('Approve & Continue');
    // Standing ON the barren month, the promise still holds: November is further
    // along and the sweep would reach it.
    selectMonth(fixture, '2026-10');
    expect(textOf(host, 'approve-label')).toBe('Approve & Continue');
    selectMonth(fixture, '2026-11');
    expect(textOf(host, 'approve-label')).toBe('Approve month');
  });

  it('withdraws the completion notice once the approver picks a month by hand', () => {
    // The notice claims "nothing after the month we stopped on". Navigating back
    // to a live month makes that claim describe somewhere the approver no longer
    // is, so it must not survive the move.
    const { fixture, host } = sweepSetup('2026-11');
    selectMonth(fixture, '2026-11');
    approveContinue(host).click();
    fixture.detectChanges();
    expect(host.querySelector('[data-test="sweep-complete"]')).not.toBeNull();

    selectMonth(fixture, '2026-09');

    expect(fixture.componentInstance.selectedMonth()).toBe('2026-09');
    expect(host.querySelector('[data-test="sweep-complete"]')).toBeNull();
    expect(textOf(host, 'approve-label')).toBe('Approve & Continue');
  });

  it('keeps a wholly REFUSED last month on screen and retryable instead of signing off on it', () => {
    // The batch completes with every item errored — a 200 with Error results.
    // The old auto-close made this indistinguishable from a clean sweep: the
    // panel vanished, the host dropped the checkbox selection, and the toast was
    // the only trace. The notice speaks only about LATER months, so it can stand
    // beside a month whose lines are still pending and still checked.
    const { fixture, notifyStub } = setup({
      rows: [SWEEP_ADA, SWEEP_BOB], months: SWEEP_MONTHS, multi: true,
      decideResults: [
        { assignmentMonthId: 'S1:2026-11', status: 'Error', error: 'Locked period' },
        { assignmentMonthId: 'T1:2026-11', status: 'Error', error: 'Locked period' },
      ],
    });
    const host = fixture.nativeElement as HTMLElement;
    let closedEmitted = 0;
    fixture.componentInstance.closed.subscribe(() => closedEmitted++);
    selectMonth(fixture, '2026-11');

    approveContinue(host).click();
    fixture.detectChanges();

    expect(notifyStub.error).toHaveBeenCalledWith('2 of 2 months could not be decided. First error: Locked period');
    expect(closedEmitted).toBe(0);
    expect([...fixture.componentInstance.checked()].sort()).toStrictEqual(['S1:2026-11', 'T1:2026-11']);
    expect(approveContinue(host).disabled).toBe(false);
    expect(host.querySelector('[data-test="sweep-complete"]')).not.toBeNull();
  });
});

/** `getResources()` (an rxResource, like the host page's own feed) resolves
 *  asynchronously even over a synchronous `of(...)` stream — mirrors the
 *  `flush` helper in allocation-approvals.component.spec.ts. Every Substitute
 *  test needs the candidate list settled BEFORE opening the panel, since
 *  `openSubstitute` reads it synchronously to pre-set the organization filter. */
async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ApprovalModalComponent — Substitute (C2)', () => {
  /** Same resource/items as ROW, but the row itself is the dummy placeholder
   *  (resourceId 'r1' matches RESOURCES' dummy entry, organization 'Digital'). */
  const ROW_DUMMY: AllocationApprovalRow = { ...ROW, kind: 'dummy' };

  it('offers Substitute only on a dummy line', () => {
    const { fixture } = setup({ rows: [ROW_DUMMY] });
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substitute"]')).not.toBeNull();
  });

  it('does not offer Substitute on an internal line', () => {
    const { fixture } = setup({ rows: [ROW] }); // ROW.kind === 'internal'
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substitute"]')).toBeNull();
  });

  it('sends the chosen person and the remaining-months flag', async () => {
    const { fixture, substituteDummyMonth } = setup({ rows: [ROW_DUMMY] });
    await flush(fixture);

    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.componentInstance.chooseTarget('r9');
    fixture.componentInstance.applyToRemaining.set(true);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="substitute-confirm"]')!.click();

    expect(substituteDummyMonth).toHaveBeenCalledWith(ROW.items[0].assignmentMonthId, 'r9', true);
  });

  it('shows what moved and what stayed', async () => {
    const { fixture } = setup({
      rows: [ROW_DUMMY],
      substituteResult: {
        targetResourceId: 'r9', targetResourceName: 'Nora Fenn',
        outcomes: [{ month: '2026-09', transferredHours: 8, remainingHours: 8 }],
      },
    });
    await flush(fixture);

    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.componentInstance.chooseTarget('r9');
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="substitute-confirm"]')!.click();
    fixture.detectChanges();

    const outcome = (fixture.nativeElement as HTMLElement).querySelector('[data-test="substitute-outcome"]')!;
    // Both numbers rendered in distinct, separately-queryable places — hours
    // moved and hours still owed by the dummy are not the same claim.
    expect(outcome.querySelector('[data-test="outcome-transferred"]')!.textContent).toContain('8');
    expect(outcome.querySelector('[data-test="outcome-remaining"]')!.textContent).toContain('8');
  });

  it('does not read a skipped, zero-transfer outcome as a success', async () => {
    const { fixture } = setup({
      rows: [ROW_DUMMY],
      substituteResult: {
        targetResourceId: 'r9', targetResourceName: 'Nora Fenn',
        outcomes: [{ month: '2026-09', transferredHours: 0, remainingHours: 8, skipped: 'the target had no capacity left that month' }],
      },
    });
    await flush(fixture);

    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.componentInstance.chooseTarget('r9');
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="substitute-confirm"]')!.click();
    fixture.detectChanges();

    const outcome = (fixture.nativeElement as HTMLElement).querySelector('[data-test="substitute-outcome"]')!;
    expect(outcome.textContent).toContain('no capacity left');
    expect(outcome.querySelector('[data-test="outcome-transferred"]')).toBeNull();
    // Never styled the same as a successful transfer.
    expect(outcome.querySelector('.green')).toBeNull();
  });

  it('does not read an empty outcomes array as a success', async () => {
    // The endpoint always returns 200, even for a request that moved NOTHING
    // at all (e.g. every month it touched was already fully covered). No
    // `[data-test="substitute-outcome"]` rows exist to inspect in this case,
    // so the component must say so explicitly rather than rendering nothing
    // (which would read as "there was nothing to report", not "this failed").
    const { fixture } = setup({
      rows: [ROW_DUMMY],
      substituteResult: { targetResourceId: 'r9', targetResourceName: 'Nora Fenn', outcomes: [] },
    });
    await flush(fixture);

    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.componentInstance.chooseTarget('r9');
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="substitute-confirm"]')!.click();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const panel = host.querySelector('[data-test="substitute-panel"]')!;
    expect(panel.querySelector('[data-test="substitute-outcome"]')).toBeNull();
    expect(panel.textContent).toContain('Nothing was transferred');
    // Never styled/labelled as a success — scoped to the substitute panel
    // itself, since an unrelated line elsewhere in the SAME modal (ROW's own
    // second, already-'Allocated' item) legitimately renders a '.green'
    // status chip of its own.
    expect(panel.querySelector('.green')).toBeNull();
  });

  it('filters candidates to internal, non-terminated resources', async () => {
    const { fixture } = setup({ rows: [ROW_DUMMY] });
    await flush(fixture);

    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    // Clear the organization pre-filter (default 'Digital', the dummy's own
    // org — see the dedicated pre-set/clearable test below): this test is
    // about the kind/termination filter, not the organization one.
    const orgSelect = host.querySelector<HTMLSelectElement>('[data-test="substitute-org-filter"]')!;
    orgSelect.value = '';
    orgSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const names = Array.from(host.querySelectorAll('[data-test="substitute-candidate"]'))
      .map(el => el.textContent ?? '');
    expect(names.some(t => t.includes('Nora Fenn'))).toBe(true);
    expect(names.some(t => t.includes('Sam Cole'))).toBe(true);
    expect(names.some(t => t.includes('Dummy Ada'))).toBe(false); // kind 'dummy'
    expect(names.some(t => t.includes('Terminated Tom'))).toBe(false); // terminationDate in the past
  });

  it("pre-sets the organization filter to the dummy's organization, and it stays clearable", async () => {
    // Task 2: the org filter now matches through the DERIVED dimensions
    // (`dimensionsOf`), not a raw string comparison, so a name absent from the
    // tree matches nothing at all (design spec §4). This test's org filter stays
    // set (unlike the sibling test above, which clears it first), so — unlike
    // before Task 2 — it now needs a tree that actually contains 'Digital'/'Cloud'
    // as flat capability nodes, or Nora's exact-org match would wrongly fail too.
    const orgs: ResourceOrganization[] = [
      { id: 'o1', name: 'Digital', description: '', costCenters: [], level: 'capability' },
      { id: 'o2', name: 'Cloud', description: '', costCenters: [], level: 'capability' },
    ];
    const { fixture } = setup({ rows: [ROW_DUMMY], orgs }); // r1 (the dummy) is org 'Digital'
    await flush(fixture);

    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const namesOf = () => Array.from(host.querySelectorAll('[data-test="substitute-candidate"]')).map(el => el.textContent ?? '');
    expect(namesOf().some(t => t.includes('Nora Fenn'))).toBe(true); // Digital
    expect(namesOf().some(t => t.includes('Sam Cole'))).toBe(false); // Cloud — filtered out by the pre-set org

    const orgSelect = host.querySelector<HTMLSelectElement>('[data-test="substitute-org-filter"]')!;
    expect(orgSelect.value).toBe('Digital');
    orgSelect.value = '';
    orgSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(namesOf().some(t => t.includes('Sam Cole'))).toBe(true); // clearing the filter reveals it
  });

  it('resets applyToRemaining when Substitute is opened on a DIFFERENT line', async () => {
    // Regression: openSubstitute() reset chosenTargetId/substitutionResult/
    // personFilter/orgFilter but originally left applyToRemaining untouched.
    // A People Manager processing several dummy lines in one modal session —
    // exactly C2's workflow — would check "Apply to all remaining months" for
    // one dummy line, decide or cancel, then open Substitute on a DIFFERENT
    // line and find the checkbox silently pre-checked, applying a transfer
    // across months the operator never opted into for THAT line.
    //
    // Driven through the RENDERED checkbox, not just the signal: the one bug
    // this feature actually shipped (the org `<select>`'s `[value]` binding —
    // see the earlier test's comment) was precisely a correct signal with a
    // DOM that never followed it, so asserting on the signal alone would not
    // have caught that class of bug here either.
    const ROW_DUMMY_TWO_PENDING: AllocationApprovalRow = { ...ROW_TWO_PENDING, kind: 'dummy' };
    const { fixture } = setup({ rows: [ROW_DUMMY_TWO_PENDING] });
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    // Line A (Apollo/A1): pick a candidate so the checkbox actually renders
    // (it's gated by `@if (chosenTarget(); as person)`), then CHECK it via a
    // real click on the rendered element.
    fixture.componentInstance.openSubstitute(ROW_TWO_PENDING.items[0]);
    fixture.componentInstance.chooseTarget('r9');
    fixture.detectChanges();
    const checkboxA = host.querySelector<HTMLInputElement>('[data-test="substitute-apply-remaining"]')!;
    expect(checkboxA.checked).toBe(false); // sanity: starts unchecked
    checkboxA.click();
    fixture.detectChanges();
    expect(checkboxA.checked).toBe(true);
    expect(fixture.componentInstance.applyToRemaining()).toBe(true);

    // Line B (Mercury/A3) — a DIFFERENT line, same modal session. Pick a
    // candidate again so the checkbox re-renders, then read ITS live state.
    fixture.componentInstance.openSubstitute(ROW_TWO_PENDING.items[1]);
    fixture.componentInstance.chooseTarget('r9');
    fixture.detectChanges();

    const checkboxB = host.querySelector<HTMLInputElement>('[data-test="substitute-apply-remaining"]')!;
    expect(checkboxB.checked).toBe(false);
    expect(fixture.componentInstance.applyToRemaining()).toBe(false);
  });

  it('offers a candidate nested below the pre-filtered organization', async () => {
    // 'Digital' is a capability; 'Digital Backend' a competence beneath it.
    const orgs: ResourceOrganization[] = [
      { id: 'g1', name: 'Digital', description: '', costCenters: [], level: 'capability' as const },
      { id: 'g2', name: 'Digital Platform', description: '', costCenters: [], level: 'practice' as const, parentId: 'g1' },
      { id: 'g3', name: 'Digital Backend', description: '', costCenters: [], level: 'competence' as const, parentId: 'g2' },
    ];
    // Nora sits TWO levels below the dummy's own organization. A filter comparing
    // `r.organization === 'Digital'` would drop her, so this fixture is what makes
    // the test meaningful — a candidate attached directly to 'Digital' would pass
    // against the old code too.
    //
    // FIXTURE FIX (the brief's own snippet did not survive contact — see the
    // report): with only Dummy Ada (kind 'dummy', excluded from eligibleTargets)
    // sitting at 'Digital' and Nora at 'Digital Backend', NO eligible candidate
    // has organization === 'Digital', so `candidateOrganizations()` never
    // contains 'Digital' and `defaultOrgFor` falls back to '' (no candidate
    // qualifies for the pre-set org — see its own doc comment). An empty
    // `orgFilter` skips the org check entirely (`if (org) {...}`), so Nora would
    // show up REGARDLESS of whether the comparison is exact-name or
    // derived-dimension — this test would pass against the OLD code too,
    // proving nothing. Adding an eligible candidate directly on 'Digital' makes
    // 'Digital' a real pre-selectable option, so the filter actually engages.
    const resources = [
      { ...RESOURCES[0] },                                                          // Dummy Ada, organization 'Digital' (dummy, ineligible)
      { ...RESOURCES[1], id: 'r9a', name: 'Cap Cara', organization: 'Digital' },     // eligible, directly on 'Digital'
      { ...RESOURCES[1], id: 'r9b', name: 'Nora Fenn', organization: 'Digital Backend' }, // nested, two levels down
    ] as Resource[];
    const { fixture } = setup({ rows: [ROW_DUMMY], orgs, resources });
    await flush(fixture);
    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    // Sanity: the pre-filter really did lock onto the dummy's own organization.
    expect(host.querySelector<HTMLSelectElement>('[data-test="substitute-org-filter"]')!.value).toBe('Digital');
    expect(host.textContent).toContain('Nora Fenn');
  });

  it('does not reject every candidate while the org tree is still resolving (review round 1)', async () => {
    // REGRESSION found in review: `resources()` and `orgNodes()` are two
    // INDEPENDENT rxResources — nothing serializes them — and the Substitute
    // button is gated only on `line.row.kind === 'dummy'`, while
    // `defaultOrgFor` reads only `resources()`. So the picker can open with a
    // NON-EMPTY `orgFilter` (the dummy's own org) while `/resource-organizations`
    // is still in flight. In that window `dimensionsOf(r, [])` returns `{}` for
    // EVERY candidate, which would fail everyone shut — the worst false
    // negative this screen can show ("No matching resources", i.e. "nobody can
    // cover this") — where the pre-Task-2 exact-match code would have shown the
    // exact-name matches, since it never depended on the tree at all.
    //
    // The org stream is a controllable Subject here specifically so it does
    // NOT resolve together with `getResources()` (a plain synchronous `of(...)`
    // everywhere else in this file) — that synchrony is exactly what hid this
    // regression from every other test.
    const orgsSubject = new Subject<ResourceOrganization[]>();
    const resources = [
      { ...RESOURCES[0] },                                                       // Dummy Ada, organization 'Digital' (dummy, ineligible)
      { ...RESOURCES[1], id: 'r9a', name: 'Cap Cara', organization: 'Digital' },  // eligible, directly on 'Digital'
    ] as Resource[];
    const { fixture } = setup({ rows: [ROW_DUMMY], resources, orgsSource: orgsSubject });

    // Only `resources()` settles here — `orgNodesRes` is deliberately left
    // pending (the Subject has not emitted). Cannot use the shared `flush()`
    // helper (`whenStable()`) for this: with the org stream genuinely still
    // open, the app never reports stable, and `whenStable()` hangs to the
    // suite's timeout — confirmed empirically. A couple of plain microtask
    // ticks are enough to let the SYNCHRONOUS `of(resources)` resolve.
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    fixture.componentInstance.openSubstitute(ROW.items[0]);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    // Sanity: the pre-filter DID lock onto 'Digital' (defaultOrgFor only needs
    // resources(), which has already resolved) — so the org predicate is truly
    // exercised, not skipped because the filter itself is empty.
    expect(host.querySelector<HTMLSelectElement>('[data-test="substitute-org-filter"]')!.value).toBe('Digital');
    // The tree has not arrived yet: Cap Cara must still be offered.
    expect(host.textContent).toContain('Cap Cara');

    // Now the tree arrives.
    orgsSubject.next([{ id: 'g1', name: 'Digital', description: '', costCenters: [], level: 'capability' }]);
    orgsSubject.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Still offered — now a real, tree-backed exact match, not a skipped check.
    expect(host.textContent).toContain('Cap Cara');
  });
});

/**
 * REGISTER (P2/logic, approval-modal.component.ts:438) — the approver's
 * un-check must SURVIVE the modal's own catalogue reads landing.
 *
 * The modal fires `/resources` and `/resource-organizations` itself and the
 * check-set default is derived from `decidable()`, which reads both. While
 * either is in flight the approver can un-check a line; when the read lands the
 * default was rebuilt and the un-checked line came BACK, so `decide()` posted a
 * month the approver had deliberately excluded. There is no undo on this screen.
 *
 * Each case pins FOUR things, and the pairing is what makes it non-vacuous:
 *   - the un-checked line stays OUT (the defect; red before the fix);
 *   - an untouched, still-decidable line stays IN (so "clear the set" cannot pass);
 *   - a line the arriving read reveals as NOT decidable leaves the set (so
 *     "freeze the set forever" cannot pass either);
 *   - that same line's checkbox flips to disabled — the DOM-visible proof the
 *     emission was actually flushed, without which every assertion above would
 *     hold trivially on a test that never emitted.
 */
describe('ApprovalModalComponent — the approver\'s un-check survives the catalogue reads (register :438)', () => {
  /** `/resources` resolves synchronously; only the pending leg is left open, so
   *  `whenStable()` cannot be used (it never settles — see the Substitute
   *  round-1 test). A couple of microtasks let the synchronous `of(...)` land. */
  async function settleResolvedLeg(fixture: { detectChanges: () => void }): Promise<void> {
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
  }

  it('keeps a line un-checked when the ORG TREE lands afterwards', async () => {
    const orgsSubject = new Subject<ResourceOrganization[]>();
    const { fixture } = setup({
      rows: [ROW_RACE_A, ROW_RACE_B], months: ['2026-09'], multi: true,
      role: 'resource-manager', userId: 'mgr',
      resources: RACE_CATALOGUE, orgsSource: orgsSubject,
    });
    await settleResolvedLeg(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const component = fixture.componentInstance;

    // Pre-condition: all three lines are pre-checked, and Bob's line is still
    // offered — the tree that will refuse it has not arrived.
    expect([...component.checked()].sort()).toEqual(['A1:2026-09', 'A2:2026-09', 'B1:2026-09']);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Zeus"]')!.disabled).toBe(false);

    // The approver un-checks Apollo, through the rendered checkbox.
    host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.click();
    fixture.detectChanges();
    expect(component.checked().has('A1:2026-09')).toBe(false);

    orgsSubject.next(RACE_TREE);
    orgsSubject.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The tree really did land: Bob's line is now refused.
    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Zeus"]')!.disabled).toBe(true);
    // The edit survived...
    expect(component.checked().has('A1:2026-09')).toBe(false);
    // ...the untouched line is still checked (the set was not simply cleared)...
    expect(component.checked().has('A2:2026-09')).toBe(true);
    // ...and the newly-refused line left it (the set was not simply frozen).
    expect(component.checked().has('B1:2026-09')).toBe(false);
  });

  it('keeps a line un-checked when the RESOURCE LIST lands afterwards', async () => {
    const resourcesSubject = new Subject<Resource[]>();
    const { fixture } = setup({
      rows: [ROW_RACE_A, ROW_RACE_B], months: ['2026-09'], multi: true,
      role: 'resource-manager', userId: 'mgr',
      orgs: RACE_TREE, resourcesSource: resourcesSubject,
    });
    await settleResolvedLeg(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const component = fixture.componentInstance;

    // Bob's line is offered because nothing yet says which organization he is
    // in — the feed row deliberately does not carry one.
    expect([...component.checked()].sort()).toEqual(['A1:2026-09', 'A2:2026-09', 'B1:2026-09']);
    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Zeus"]')!.disabled).toBe(false);

    host.querySelector<HTMLInputElement>('[aria-label="Select Apollo"]')!.click();
    fixture.detectChanges();
    expect(component.checked().has('A1:2026-09')).toBe(false);

    resourcesSubject.next(RACE_CATALOGUE);
    resourcesSubject.complete();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.querySelector<HTMLInputElement>('[aria-label="Select Zeus"]')!.disabled).toBe(true);
    expect(component.checked().has('A1:2026-09')).toBe(false);
    expect(component.checked().has('A2:2026-09')).toBe(true);
    expect(component.checked().has('B1:2026-09')).toBe(false);
  });
});

/**
 * REGISTER (P2/logic, approval-modal.component.ts:632, register P2-17) — a
 * double-click on "Approve & Continue" must decide ONE month.
 *
 * Nothing disabled the button between the two click events, so both handlers
 * ran: two identical batch calls went out, and the second response advanced the
 * modal a SECOND time — 2026-10 was never presented for a decision and the
 * modal closed as if every month had been walked.
 *
 * Asserted on the api spy (call count + payload), never on the DOM: the button's
 * [disabled] binding is the affordance, but change detection does not run
 * between two clicks in the same task, so only the guard inside `decide()` can
 * be what actually holds.
 */
describe('ApprovalModalComponent — one decision per click (register P2-17)', () => {
  it('sends ONE batch for a double-click, then lets the NEXT month be decided', () => {
    const decide$ = new Subject<{ results: AllocationDecisionResult[] }>();
    const { fixture, decideAllocationMonths, decideCalls } = setup({
      rows: [ROW_TWO_MONTHS], months: ['2026-09', '2026-10'], multi: true, decideSource: decide$,
    });
    const host = fixture.nativeElement as HTMLElement;

    const button = host.querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!;
    button.click();
    button.click();

    expect(decideAllocationMonths).toHaveBeenCalledTimes(1);
    expect(decideCalls[0]).toEqual([{ assignmentMonthId: 'M1:2026-09', decision: 'Approved', note: undefined }]);

    // The batch answers. Exactly ONE advance, so September's decision leaves
    // October — not November — on screen.
    decide$.next({ results: [{ assignmentMonthId: 'M1:2026-09', status: 'Approved' }] });
    fixture.detectChanges();
    expect(fixture.componentInstance.selectedMonth()).toBe('2026-10');

    // ABSENCE TWIN: the guard is per-call, not a one-shot latch — October must
    // still be decidable, and it must be OCTOBER's month row that goes out.
    host.querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!.click();
    expect(decideAllocationMonths).toHaveBeenCalledTimes(2);
    expect(decideCalls[1]).toEqual([{ assignmentMonthId: 'M1:2026-10', decision: 'Approved', note: undefined }]);
  });

  /**
   * Only TWO decision buttons are ever in the DOM at once — the footer renders
   * `approve-continue` in multi mode and `approve-month` in single mode, never
   * both — so the two cases below cover the three [disabled] expressions
   * between them rather than one case claiming all three.
   */
  it('disables the multi-mode decision actions while a decision is in flight, and restores them after', () => {
    const decide$ = new Subject<{ results: AllocationDecisionResult[] }>();
    const { fixture } = setup({
      rows: [ROW_TWO_MONTHS], months: ['2026-09', '2026-10'], multi: true, decideSource: decide$,
    });
    const host = fixture.nativeElement as HTMLElement;
    const actions = () => ({
      approve: host.querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!.disabled,
      reject: host.querySelector<HTMLButtonElement>('[data-test="reject-month"]')!.disabled,
      // Dismissing must survive the guard: a batch decision cannot be
      // cancelled, so a Close that went dead mid-flight would trap the
      // approver in the panel until the response landed.
      closeStaysLive: !host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled,
    });

    expect(actions()).toStrictEqual({ approve: false, reject: false, closeStaysLive: true });

    host.querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!.click();
    fixture.detectChanges();
    expect(actions()).toStrictEqual({ approve: true, reject: true, closeStaysLive: true });

    // ...and they come back once the batch answers, so the in-flight guard can
    // never strand the approver on a dead footer.
    decide$.next({ results: [{ assignmentMonthId: 'M1:2026-09', status: 'Approved' }] });
    fixture.detectChanges();
    expect(actions()).toStrictEqual({ approve: false, reject: false, closeStaysLive: true });
  });

  it('guards the SINGLE-mode approve-month button too, and re-enables it when the batch ERRORS', () => {
    const decide$ = new Subject<{ results: AllocationDecisionResult[] }>();
    const { fixture, decideAllocationMonths } = setup({ decideSource: decide$ });
    const host = fixture.nativeElement as HTMLElement;
    const approve = () => host.querySelector<HTMLButtonElement>('[data-test="approve-month"]')!;

    expect(approve().disabled).toBe(false);
    approve().click();
    approve().click();
    fixture.detectChanges();
    expect(decideAllocationMonths).toHaveBeenCalledTimes(1);
    expect(approve().disabled).toBe(true);

    // ABSENCE TWIN for the ERROR leg, which the success cases cannot reach: a
    // 5xx/network failure is toasted by the global interceptor and the modal
    // stays open, so the guard MUST be released or the only remaining action is
    // to close and lose the note drafts. Red without the error callback.
    decide$.error(new Error('offline'));
    fixture.detectChanges();
    expect(approve().disabled).toBe(false);
    approve().click();
    expect(decideAllocationMonths).toHaveBeenCalledTimes(2);
  });
});
