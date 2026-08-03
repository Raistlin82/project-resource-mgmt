import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApprovalModalComponent } from './approval-modal.component';
import { AllocationApprovalRow, ApiService, Resource, SubstitutionResult, UserRole } from '../services/api.service';
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

interface SetupOptions {
  rows?: AllocationApprovalRow[];
  months?: string[];
  multi?: boolean;
  decideResults?: { assignmentMonthId: string; status: string; error?: string }[];
  /** Effective role of the signed-in principal (mirrors AuthService.role()). */
  role?: UserRole;
  /** The principal's RESOURCE id (mirrors AuthService.userId()). */
  userId?: string;
  /** Resources `getResources()` resolves with — the Substitute picker's candidate pool. */
  resources?: Resource[];
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
  substituteResult = {
    targetResourceId: 'r9', targetResourceName: 'Nora Fenn',
    outcomes: [{ month: '2026-09', transferredHours: 8, remainingHours: 0, targetAssignmentMonthId: 'X1:2026-09', status: 'Requested' }],
  },
}: SetupOptions = {}) {
  const decideAllocationMonths = vi.fn(() => of({ results: decideResults }));
  const getResources = vi.fn(() => of(resources));
  const substituteDummyMonth = vi.fn(() => of(substituteResult));
  const apiStub = { decideAllocationMonths, getResources, substituteDummyMonth } as unknown as ApiService;
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
  return { fixture, decideAllocationMonths, getResources, substituteDummyMonth, notifyStub };
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

  it('offers every resource to a resource-manager (the role every allocation step is routed to)', () => {
    const { fixture } = setup({ role: 'resource-manager', userId: 'not-the-manager' });
    expect([...fixture.componentInstance.checked()]).toEqual(['A1:2026-09']);
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

describe('ApprovalModalComponent — multi-resource mode', () => {
  it('advances to the next month and stays open after Approve & Continue', () => {
    const { fixture } = setup({ rows: [ROW, ROW_2], months: ['2026-09', '2026-10'], multi: true });
    let closedEmitted = 0;
    fixture.componentInstance.closed.subscribe(() => closedEmitted++);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedMonth()).toBe('2026-10');
    expect(closedEmitted).toBe(0);
  });

  it('closes after deciding the last month', () => {
    const { fixture } = setup({ rows: [ROW, ROW_2], months: ['2026-09'], multi: true });
    let closedEmitted = 0;
    fixture.componentInstance.closed.subscribe(() => closedEmitted++);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!.click();
    fixture.detectChanges();

    expect(closedEmitted).toBe(1);
  });

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
    const { fixture } = setup({ rows: [ROW_DUMMY] }); // r1 (the dummy) is org 'Digital'
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
});
