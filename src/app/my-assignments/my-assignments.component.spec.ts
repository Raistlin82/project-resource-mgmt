import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { MyAssignmentsComponent } from './my-assignments.component';
import {
  ApiService,
  Assignment,
  Resource,
  ResourceRequest,
  TimeEntry,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

const ASSIGNMENT: Assignment = {
  id: 'A1',
  requestId: 'REQ1',
  resourceId: 'R1',
  assignedHours: 40,
  status: 'Allocated',
};

const REQUEST: ResourceRequest = {
  id: 'REQ1',
  name: 'Apollo',
  requiredRole: 'Developer',
  requiredEffort: 40,
  staffedEffort: 40,
  status: 'Fulfilled',
  skills: [],
  projectId: 'P1',
};

const PROFILE: Resource = {
  id: 'R1',
  name: 'Ada',
  role: 'Developer',
  skills: [],
  projectRoles: [],
  externalExperience: [],
  utilization: 100,
  capacity: 40,
};

const SUBMITTED_ENTRY: TimeEntry = {
  id: 'TE1',
  assignmentId: 'A1',
  requestId: 'REQ1',
  resourceId: 'R1',
  projectId: 'P1',
  date: '2026-09-01',
  hours: 8,
  status: 'Submitted',
};

function setup(overrides: {
  createMyTimeEntry?: ReturnType<typeof vi.fn>;
  requests?: ResourceRequest[];
  canSubmitOwnTime?: boolean;
} = {}) {
  const createMyTimeEntry = overrides.createMyTimeEntry ?? vi.fn(() => of(SUBMITTED_ENTRY));
  const api = {
    getMyAssignments: vi.fn(() => of([ASSIGNMENT])),
    getMyRequests: vi.fn(() => of(overrides.requests ?? [REQUEST])),
    getMyProfile: vi.fn(() => of(PROFILE)),
    getMyTimeEntries: vi.fn(() => of([])),
    createMyTimeEntry,
  } as unknown as ApiService;
  const auth = {
    authReady: signal(true),
    hasResourceIdentity: signal(true),
    canSubmitOwnTime: signal(overrides.canSubmitOwnTime ?? true),
  } as unknown as AuthService;
  const notifications = {
    show: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  } as unknown as NotificationService;

  TestBed.configureTestingModule({
    imports: [MyAssignmentsComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: auth },
      { provide: NotificationService, useValue: notifications },
    ],
  });
  const fixture = TestBed.createComponent(MyAssignmentsComponent);
  return { fixture, createMyTimeEntry, notifications };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('MyAssignmentsComponent time entry submission', () => {
  it('uses the atomic self-service endpoint without spoofable identity or status fields', async () => {
    const { fixture, createMyTimeEntry, notifications } = setup();
    await flush(fixture);

    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('2026-09-01');
    fixture.componentInstance.timeEntryHours.set(8);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);

    // EXPECTATION UPDATED (not relaxed): the payload now also carries the
    // idempotencyKey the server derives the entry id from, so a retry after a
    // lost response returns the same entry instead of logging the hours twice.
    expect(createMyTimeEntry).toHaveBeenCalledWith({
      assignmentId: 'A1',
      date: '2026-09-01',
      hours: 8,
      notes: '',
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(createMyTimeEntry).toHaveBeenCalledWith(expect.not.objectContaining({
      status: expect.anything(),
      resourceId: expect.anything(),
      requestId: expect.anything(),
      projectId: expect.anything(),
    }));
    expect(notifications.show).toHaveBeenCalledWith('Time entry submitted for approval.', 'success');
  });

  it('keeps the idempotency key stable across a retry and rotates it for the next entry', async () => {
    // The key is the whole point of the server change: same key -> the server
    // returns the SAME row. Reuse it for a different entry and the hours would be
    // silently swallowed, so it must rotate once the form closes. Both halves
    // fail if `??=` becomes `=`, or if cancelTimeEntry() stops clearing it.
    const { fixture, createMyTimeEntry } = setup({
      createMyTimeEntry: vi.fn(() => throwError(() => new Error('network'))),
    });
    await flush(fixture);

    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('2026-09-01');
    fixture.componentInstance.timeEntryHours.set(8);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);   // the user retries

    const firstKey = createMyTimeEntry.mock.calls[0][0].idempotencyKey;
    const retryKey = createMyTimeEntry.mock.calls[1][0].idempotencyKey;
    expect(createMyTimeEntry).toHaveBeenCalledTimes(2);
    expect(retryKey).toBe(firstKey);

    // Form closed: the next submission is a different entry.
    fixture.componentInstance['cancelTimeEntry']();
    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('2026-09-02');
    fixture.componentInstance.timeEntryHours.set(4);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);

    expect(createMyTimeEntry.mock.calls[2][0].idempotencyKey).not.toBe(firstKey);
  });

  it('blocks duplicate creates while a time entry is being saved', async () => {
    const createResult = new Subject<TimeEntry>();
    const createMyTimeEntry = vi.fn(() => createResult.asObservable());
    const { fixture } = setup({ createMyTimeEntry });
    await flush(fixture);

    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);

    expect(createMyTimeEntry).toHaveBeenCalledTimes(1);
  });

  it('disables submission and explains invalid date or hours', async () => {
    const { fixture, createMyTimeEntry } = setup();
    await flush(fixture);
    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('');
    fixture.componentInstance.timeEntryHours.set(0);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const submit = host.querySelector('[data-test="submit-time-entry"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(host.textContent).toContain('Enter a valid date and hours greater than zero.');
    expect(createMyTimeEntry).not.toHaveBeenCalled();
  });

  /**
   * REWRITTEN: these two tests could not fail. Both asserted
   * `[aria-label="Edit Hours"]` is null — a selector that exists NOWHERE in
   * src/ except those two lines, so the expectation was unfalsifiable. One also
   * asserted the text 'Allocation Calendar', which renders unconditionally
   * (my-assignments.component.ts:259). And both flipped `canManageStaffing`,
   * which THIS COMPONENT NEVER READS (its 4 occurrences were all in the spec) —
   * so the input the tests varied to justify their titles had no effect at all.
   *
   * What actually varies is canSubmitOwnTime, which gates the "Log actual time"
   * button. Asserted as a PAIR, so absence is proven against a positive control
   * rather than against a typo.
   */
  it('offers the log-time action only when the access policy allows own-time submission', async () => {
    const denied = setup({ canSubmitOwnTime: false });
    await flush(denied.fixture);
    const deniedHost = denied.fixture.nativeElement as HTMLElement;
    expect(deniedHost.querySelector('[aria-label="Log actual time"]')).toBeNull();
    // ...and the form cannot be opened by other means either.
    denied.fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    denied.fixture.detectChanges();
    expect(deniedHost.querySelector('[data-test="submit-time-entry"]')).toBeNull();

    TestBed.resetTestingModule();

    const allowed = setup({ canSubmitOwnTime: true });
    await flush(allowed.fixture);
    const allowedHost = allowed.fixture.nativeElement as HTMLElement;
    expect(allowedHost.querySelector('[aria-label="Log actual time"]')).not.toBeNull();
  });

  it('renders assignedHours as text with no editable control, and says where hours are edited', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    // assignedHours left the client-writable surface (P1-20): the number is
    // rendered, and there is no input, select or textarea bound to it anywhere on
    // the row. Add one back and this fails.
    expect(host.textContent).toContain('40h');
    const editableOutsideTheTimeEntryForm = [...host.querySelectorAll('input, select, textarea')]
      .filter(el => el.closest('form') === null);
    expect(editableOutsideTheTimeEntryForm).toEqual([]);
    expect(host.textContent).toContain('Planned hours are edited per day in the Allocation Calendar.');
  });
});
