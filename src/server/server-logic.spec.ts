/**
 * Focused unit tests for the pure server helpers (no Express, no DB).
 *
 * Covers:
 *   - `maxIdSeq`: retained compatibility parsing for legacy numeric/prefixed ids
 *     (new entities use process-independent UUIDs).
 *   - the time-entry transition guard (`isAllowedTimeEntryTransition`, exported
 *     from staffing.util) the POST/PUT handlers enforce.
 *   - the POST /time-entries create-path invariant: the initial status is FORCED
 *     to 'Draft' regardless of the request body (mirrored here, not via HTTP).
 */
import { maxIdSeq } from './id-seq.util';
import { isAllowedTimeEntryTransition } from '../app/services/staffing.util';
import type { TimeEntry } from '../app/services/api.service';

describe('maxIdSeq', () => {
  it('returns the max suffix for purely-numeric ids', () => {
    expect(maxIdSeq(['1', '7', '3'])).toBe(7);
    expect(maxIdSeq(['1001', '1000', '1002'])).toBe(1002);
  });

  it('parses the numeric suffix of prefixed ids (TE / AL / AR)', () => {
    expect(maxIdSeq(['TE1', 'TE42', 'TE7'])).toBe(42);
    expect(maxIdSeq(['AL1005'])).toBe(1005);
    expect(maxIdSeq(['AR3', 'AR99'])).toBe(99);
    // Multi-letter prefixes (e.g. the CRM outbox 'OB…') are stripped too.
    expect(maxIdSeq(['OB12'])).toBe(12);
  });

  it('takes the max across mixed numeric and prefixed ids', () => {
    expect(maxIdSeq(['5', 'TE1003', 'AR12', 'AL900', '7'])).toBe(1003);
    // A bare-numeric id can still be the max even amid prefixed ones.
    expect(maxIdSeq(['TE10', '2048', 'AL20'])).toBe(2048);
  });

  it('ignores ids whose remainder after the prefix is not all digits', () => {
    // 'sap-rm://...' style, UUID-ish, and prefix-only ids contribute nothing.
    expect(maxIdSeq(['INV-2026-0001', 'abc', 'TE'])).toBe(0);
    // Mixed: only the clean ones count.
    expect(maxIdSeq(['TE5', 'TE5x', 'foo-9'])).toBe(5);
  });

  it('returns 0 for an empty set', () => {
    expect(maxIdSeq([])).toBe(0);
  });
});

describe('time-entry transition guard (isAllowedTimeEntryTransition)', () => {
  it('allows the legitimate lifecycle moves', () => {
    expect(isAllowedTimeEntryTransition('Draft', 'Submitted')).toBe(true);
    expect(isAllowedTimeEntryTransition('Submitted', 'Approved')).toBe(true);
    expect(isAllowedTimeEntryTransition('Submitted', 'Rejected')).toBe(true);
    expect(isAllowedTimeEntryTransition('Submitted', 'Draft')).toBe(true);
    expect(isAllowedTimeEntryTransition('Rejected', 'Draft')).toBe(true);
  });

  it('rejects skipping straight to Approved from Draft', () => {
    expect(isAllowedTimeEntryTransition('Draft', 'Approved')).toBe(false);
  });

  it('rejects reverting an Approved entry (terminal on the PUT path)', () => {
    expect(isAllowedTimeEntryTransition('Approved', 'Draft')).toBe(false);
    expect(isAllowedTimeEntryTransition('Approved', 'Submitted')).toBe(false);
  });

  it('always allows a no-op (same-status) transition', () => {
    for (const s of ['Draft', 'Submitted', 'Approved', 'Rejected'] as const) {
      expect(isAllowedTimeEntryTransition(s, s)).toBe(true);
    }
  });
});

describe('POST /time-entries create-path forces status Draft', () => {
  // Mirror of the handler's spread-then-pin construction (status forced AFTER
  // the spread, with 'status'/'approvedBy'/'approvedAt' already excluded from the
  // create allow-list). This is the invariant that stops a client from seeding an
  // already-'Approved' entry that would bypass the transition whitelist + SoD.
  const CREATE_ALLOW_LIST = ['assignmentId', 'requestId', 'resourceId', 'projectId', 'date', 'hours', 'notes'] as const;

  function pick(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (body[k] !== undefined) out[k] = body[k];
    }
    return out;
  }

  function buildCreated(body: Record<string, unknown>): TimeEntry {
    const picked = pick(body, CREATE_ALLOW_LIST);
    return {
      id: 'TE9999',
      ...picked,
      status: 'Draft',
      projectId: (picked['projectId'] as string) || '',
    } as TimeEntry;
  }

  it('forces Draft even when the body asks for Approved', () => {
    const created = buildCreated({
      resourceId: '1',
      hours: 8,
      status: 'Approved',
      approvedBy: '1',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(created.status).toBe('Draft');
  });

  it('drops client-supplied approvedBy/approvedAt at create time', () => {
    const created = buildCreated({
      resourceId: '1',
      hours: 8,
      approvedBy: 'attacker',
      approvedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(created.approvedBy).toBeUndefined();
    expect(created.approvedAt).toBeUndefined();
  });

  it('still keeps allow-listed fields', () => {
    const created = buildCreated({ resourceId: '7', hours: 4, notes: 'work' });
    expect(created.resourceId).toBe('7');
    expect(created.hours).toBe(4);
    expect(created.notes).toBe('work');
  });
});
