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
  assignments?: Assignment[];
  requests?: ResourceRequest[];
  canSubmitOwnTime?: boolean;
  /** Leave the four-leg forkJoin in flight (no leg ever emits). */
  pending?: boolean;
  /** Fail the /self/profile leg, as an expired bearer does. */
  failing?: boolean;
  /** false reproduces the pre-OIDC-bootstrap window (and the SSR document). */
  authReady?: boolean;
} = {}) {
  const createMyTimeEntry = overrides.createMyTimeEntry ?? vi.fn(() => of(SUBMITTED_ENTRY));
  // A leg that never emits keeps forkJoin — and therefore the resource — loading.
  const never = <T>() => new Subject<T>().asObservable();
  const leg = <T>(value: T) => (overrides.pending ? never<T>() : of(value));
  const api = {
    getMyAssignments: vi.fn(() => leg(overrides.assignments ?? [ASSIGNMENT])),
    getMyRequests: vi.fn(() => leg(overrides.requests ?? [REQUEST])),
    getMyProfile: vi.fn(() => overrides.failing
      ? throwError(() => new Error('401 Unauthorized'))
      : leg(PROFILE)),
    getMyTimeEntries: vi.fn(() => leg<TimeEntry[]>([])),
    createMyTimeEntry,
  } as unknown as ApiService;
  const auth = {
    authReady: signal(overrides.authReady ?? true),
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
  return { fixture, api, createMyTimeEntry, notifications };
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

  it('reuses the idempotency key when only the NOTES change after a failure', async () => {
    // ROUND 3, THE DUPLICATE P1-21 EXISTS TO PREVENT. The server's dedup is
    // entirely KEYED (repos.timeEntries.get(entryId)); its four-field comparison
    // only guards against reusing one key for a different row. So a NEW key with
    // the same assignment/date/hours creates a SECOND entry with nothing to stop
    // it. With `notes` in the fingerprint: submit, response lost after the server
    // committed, the error message invites "review the details", the user fixes a
    // typo in the notes only -> new key -> a second time entry with identical date
    // and hours. Hours double-booked on a billable record.
    //
    // Put `notes` back into timeEntryFingerprint() and this test fails.
    const { fixture, createMyTimeEntry } = setup({
      createMyTimeEntry: vi.fn(() => throwError(() => new Error('lost response'))),
    });
    await flush(fixture);

    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('2026-09-01');
    fixture.componentInstance.timeEntryHours.set(8);
    fixture.componentInstance.timeEntryNotes.set('Backend wrok');
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);

    // The user reviews the details and fixes the typo — in the notes ONLY.
    fixture.componentInstance.timeEntryNotes.set('Backend work');
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);

    const first = createMyTimeEntry.mock.calls[0][0];
    const second = createMyTimeEntry.mock.calls[1][0];
    expect(second.notes).toBe('Backend work');
    expect(second.hours).toBe(8);
    expect(second.date).toBe('2026-09-01');
    // SAME key: the server replays the row it already has instead of logging the
    // 8 hours twice. The notes edit is dropped, which is the trade.
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('rotates the idempotency key when the HOURS change after a failure', async () => {
    // ROUND 2. The error text says "review the details and try again". With a key
    // bound to the FORM SESSION rather than to the payload, correcting the hours
    // and retrying resent the SAME key with DIFFERENT hours — which the server
    // answers 409, correctly and forever. The advice was a dead end.
    const { fixture, createMyTimeEntry } = setup({
      createMyTimeEntry: vi.fn(() => throwError(() => new Error('network'))),
    });
    await flush(fixture);

    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('2026-09-01');
    fixture.componentInstance.timeEntryHours.set(8);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);

    // The user corrects the hours the message told them to review.
    fixture.componentInstance.timeEntryHours.set(6);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);

    const first = createMyTimeEntry.mock.calls[0][0];
    const second = createMyTimeEntry.mock.calls[1][0];
    expect(second.hours).toBe(6);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('reloads after a failed submission so an already-recorded entry becomes visible', async () => {
    // A response can be lost AFTER the server committed. Without the reload the
    // user is told to retry a submission that already succeeded, and the entry
    // that exists is nowhere on screen.
    const { fixture, api } = setup({
      createMyTimeEntry: vi.fn(() => throwError(() => new Error('lost response'))),
    });
    await flush(fixture);
    const before = (api.getMyTimeEntries as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('2026-09-01');
    fixture.componentInstance.timeEntryHours.set(8);
    fixture.componentInstance['saveTimeEntry'](ASSIGNMENT);
    await flush(fixture);

    expect((api.getMyTimeEntries as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThan(before);
    expect(fixture.componentInstance['timeEntrySubmissionError']()).toContain('already there');
  });

  it('keeps the idempotency key stable across a retry of the SAME payload, and rotates it for the next entry', async () => {
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

/** The three KPI tile values, in template order, or [] when no tile is rendered. */
function kpiValues(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.command-kpi-value')].map(el => el.textContent!.trim());
}

/** The one skeleton region ListState renders while loading, scoped to this page. */
function skeleton(host: HTMLElement): Element | null {
  return host.querySelector('[role="status"][aria-live="polite"][aria-busy="true"]');
}

const FIVE_ASSIGNMENTS: Assignment[] = [1, 2, 3, 4, 5].map(n => ({
  id: `A${n}`,
  requestId: 'REQ1',
  resourceId: 'R1',
  assignedHours: 64,   // 5 x 64 = 320h
  status: 'Allocated',
}));

describe('MyAssignmentsComponent read-state boundary', () => {
  it('renders no KPI tiles while the four-leg read is in flight, and the real figures once it resolves', async () => {
    // The tiles used to sit ABOVE the ListState wrapper, so a person with five
    // live bookings was told "Active Assignments 0", "0h" and a 0% utilization
    // tile for the whole multi-round-trip window. Absence first...
    const pending = setup({ pending: true, assignments: FIVE_ASSIGNMENTS });
    // NOT flush(): whenStable() never settles while a resource is in flight —
    // that pending state is exactly the state under test.
    pending.fixture.detectChanges();
    pending.fixture.detectChanges();
    const pendingHost = pending.fixture.nativeElement as HTMLElement;

    expect(pending.fixture.componentInstance['dataRes'].isLoading()).toBe(true);
    expect(kpiValues(pendingHost)).toEqual([]);
    expect(pendingHost.textContent).not.toContain('Active Assignments');
    expect(pendingHost.textContent).not.toContain('Total Assigned Hours');
    expect(skeleton(pendingHost)).not.toBeNull();

    TestBed.resetTestingModule();

    // ...and the presence twin, which is what stops "delete the tiles" passing:
    // the resolved page MUST state the five bookings and the 320 hours.
    const resolved = setup({ assignments: FIVE_ASSIGNMENTS });
    await flush(resolved.fixture);
    const resolvedHost = resolved.fixture.nativeElement as HTMLElement;

    expect(resolvedHost.textContent).toContain('Active Assignments');
    expect(skeleton(resolvedHost)).toBeNull();
    const values = kpiValues(resolvedHost);
    expect(values.length).toBe(3);
    expect(values[0]).toBe('5');
    expect(values[1]).toBe('320h');
    // values[2] (Current Utilization) is DELIBERATELY not pinned: it divides
    // lifetime assigned hours by a fixed four-weeks-of-weekly-capacity constant
    // (my-assignments.component.ts currentUtilization()), which is a separate,
    // still-open arithmetic defect. Asserting the number it produces today would
    // certify it. The tile's presence is asserted through values.length.
  });

  it('shows the error panel and Retry instead of aborting change detection when a leg fails', async () => {
    // dataRes.value() THROWS in the error state and every accessor above the old
    // wrapper read it, so the first such binding aborted the pass and made this
    // very panel unreachable code: header, three zero tiles, nothing else, forever.
    const { fixture } = setup({ failing: true, assignments: FIVE_ASSIGNMENTS });
    expect(() => fixture.detectChanges()).not.toThrow();
    await fixture.whenStable();
    expect(() => fixture.detectChanges()).not.toThrow();

    const host = fixture.nativeElement as HTMLElement;
    // The positive control: the test cannot go green by the read having quietly
    // succeeded — which is how a spec of this shape usually goes blind.
    expect(fixture.componentInstance['dataRes'].status()).toBe('error');
    expect(host.textContent).toContain("Couldn't load assignments");
    const retry = [...host.querySelectorAll('button')].find(b => b.textContent!.includes('Retry'));
    expect(retry).toBeDefined();
    // A failed read is not "no bookings": no zeros, and no empty-state copy.
    expect(kpiValues(host)).toEqual([]);
    expect(host.textContent).not.toContain('No assignments found for this period.');
    expect(host.textContent).not.toContain("You don't have any active assignments.");
  });

  it('does not claim the period is empty before authReady, and does say so once a resolved read is empty', async () => {
    // params() is false until the OIDC bootstrap settles and the stream answers
    // with of(<empty>) — a RESOLVED empty. isLoading() alone was therefore false
    // for that whole window (and for the SSR document), so the page asserted
    // "No assignments found for this period." over data that exists.
    const early = setup({ authReady: false, assignments: FIVE_ASSIGNMENTS });
    await flush(early.fixture);
    const earlyHost = early.fixture.nativeElement as HTMLElement;

    expect(earlyHost.textContent).not.toContain('No assignments found for this period.');
    expect(earlyHost.textContent).not.toContain("You don't have any active assignments.");
    expect(kpiValues(earlyHost)).toEqual([]);
    expect(skeleton(earlyHost)).not.toBeNull();

    TestBed.resetTestingModule();

    // The mirror, and the reason a permanent skeleton cannot pass: authReady with
    // a genuinely empty result MUST say so, and MUST NOT show a skeleton.
    const empty = setup({ authReady: true, assignments: [] });
    await flush(empty.fixture);
    const emptyHost = empty.fixture.nativeElement as HTMLElement;

    expect(skeleton(emptyHost)).toBeNull();
    expect(emptyHost.textContent).toContain('No assignments found for this period.');
    expect(emptyHost.textContent).toContain("You don't have any active assignments.");
  });
});

describe('MyAssignmentsComponent monthly view responsive contract', () => {
  it('collapses the month grid below sm instead of floring 7 columns (jsdom proves the class contract only, not the 320px overlap)', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    // The weekly table is the PAIRED GREEN for the same predicate: it carries a
    // width floor today, which is what proves the predicate separates an element
    // with a responsive escape from one without, rather than being a tautology.
    const weekTokens = host.querySelector('table')!.className.split(/\s+/);
    expect(weekTokens.some(t => t.startsWith('min-w-['))).toBe(true);

    fixture.componentInstance.setViewMode('month');
    await flush(fixture);
    expect(host.querySelector('table')).toBeNull();

    const gridTokens = host.querySelector('[data-test="month-grid"]')!.className.split(/\s+/);
    expect(gridTokens).toContain('grid-cols-1');
    expect(gridTokens).toContain('sm:grid-cols-7');
    // The absence half, token-wise on purpose: a substring test would be
    // satisfied by "sm:grid-cols-7" and could never see the unconditional floor.
    expect(gridTokens).not.toContain('grid-cols-7');
    // jsdom computes no grid tracks, so the ~17px content box and the header
    // overflowing into the neighbouring day are NOT provable here; that needs a
    // real engine at 320px. What is proven is the collapse contract.
  });

  it('labels each collapsed day with its weekday and no longer repeats the month-day beside the day number', async () => {
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.setViewMode('month');
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const headers = [...host.querySelectorAll('[data-test="month-day-header"]')];
    expect(headers.length).toBeGreaterThanOrEqual(28);
    const text = headers[0].textContent!.trim().replace(/\s+/g, ' ');
    // Presence: the weekday (the fact the hidden column header used to carry)
    // followed by the day number — Angular strips the inter-element whitespace,
    // hence the optional separator. Clock- and timezone-independent: WHICH weekday
    // is not asserted, only that one is there next to the day of the month.
    expect(text).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.?\s?\d{1,2}$/i);
    // Absence: the "08-06" restatement whose ~50px min-content overflowed the
    // 33px track is gone from every cell, not just the first.
    for (const header of headers) {
      expect(header.textContent).not.toMatch(/\d{2}-\d{2}/);
    }
  });
});

describe('MyAssignmentsComponent time-entry validation announcement', () => {
  it('keeps the validation live region mounted so the message is a text change, not an insertion', async () => {
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    // Valid pre-filled entry: the region must already EXIST, and be silent.
    const region = host.querySelector('[data-test="time-entry-message"]');
    expect(region).not.toBeNull();
    expect(region!.textContent!.trim()).toBe('');
    expect(region!.getAttribute('aria-live')).toBe('polite');

    fixture.componentInstance.timeEntryDate.set('');
    fixture.detectChanges();

    // SAME NODE. A region created in the same change-detection pass as its text
    // is never announced, so node identity — not the text — is the contract, and
    // it is what the previous @if shape could not satisfy at any text value.
    expect(host.querySelector('[data-test="time-entry-message"]')).toBe(region);
    expect(region!.textContent).toContain('Enter a valid date and hours greater than zero.');
  });

  it('marks only the offending control invalid, points it at the message, and clears the mark when valid', async () => {
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance['startTimeEntry'](ASSIGNMENT);
    fixture.componentInstance.timeEntryDate.set('2026-09-01');
    fixture.componentInstance.timeEntryHours.set(8);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const date = () => host.querySelector('#timeEntryDate')!;
    const hours = () => host.querySelector('#timeEntryHours')!;

    // The case that must still be ALLOWED — without it a rule that always
    // reports "invalid" would pass every assertion below.
    expect(date().getAttribute('aria-invalid')).toBe('false');
    expect(hours().getAttribute('aria-invalid')).toBe('false');
    expect((host.querySelector('[data-test="submit-time-entry"]') as HTMLButtonElement).disabled).toBe(false);

    fixture.componentInstance.timeEntryHours.set(0);
    fixture.detectChanges();

    expect(hours().getAttribute('aria-invalid')).toBe('true');
    expect(hours().getAttribute('aria-describedby')).toBe('timeEntryMessage');
    expect(host.querySelector('#timeEntryMessage')).not.toBeNull();
    // The date is still valid and must not be blamed for the hours.
    expect(date().getAttribute('aria-invalid')).toBe('false');
  });
});
