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
 *   - the shared POST /self/time-entries payload policy invoked by the handler.
 */
import { maxIdSeq } from './id-seq.util';
import { isAllowedTimeEntryTransition } from '../app/services/staffing.util';
import type { TimeEntry } from '../app/services/api.service';
import { validateTimeEntry } from '../app/services/time-entry-validation.util';

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

describe('POST /self/time-entries payload policy', () => {
  const base = {
    assignment: { startDate: '2026-08-01', endDate: '2026-08-31' },
    request: { startDate: '2026-08-05', endDate: '2026-09-30' },
    date: '2026-08-08',
    hours: 2,
    today: '2026-08-08',
    dailyCap: 8,
    existingEntries: [{ id: 'TE1', date: '2026-08-08', hours: 6, status: 'Submitted' as const }],
  };

  it('accepts an in-window payload at the cap and rejects direct future/over-cap variants', () => {
    expect(validateTimeEntry(base).valid).toBe(true);
    expect(validateTimeEntry({ ...base, date: '2026-08-09' }).message).toContain('later than today');
    expect(validateTimeEntry({ ...base, hours: 2.01 }).message).toContain('daily limit');
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

// ---------------------------------------------------------------------------
// BLOCK H — the SERVER's own composition of the absence feed (design spec §6.5).
//
// `src/server.ts` cannot be imported (it builds the Angular SSR engine at module
// scope), so what is asserted here is the composition the three computed-read
// handlers perform, replayed line-for-line over the SHIPPED SEED: list the rows,
// map them through `redactAbsence`, hand the result to the rollup. The live
// wiring itself is a smoke check (`scripts/smoke-api.mjs`) — this suite pins the
// two claims the wiring rests on, which no HTTP check can show as sharply.
// ---------------------------------------------------------------------------

import { resourceAbsences, resources, assignments, assignmentDays, assignmentMonths, holidays } from '../db/seed';
import { benchRollup, type BenchRollupInput } from '../app/services/bench.util';
import { rollupMonthly } from '../app/services/capacity.util';
import { auditTargetRef } from './operational-integrity.util';
import { redactAbsence } from './absence-policy.util';

describe('the absence feed as the server composes it', () => {
  // The /bench/monthly window arithmetic, for the seed's first Open period.
  const FETCH = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const DISPLAY = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const HOLIDAYS = new Set(holidays.map(h => h.id));
  const TODAY = '2026-04-17';

  const bench = (absences: BenchRollupInput['absences']) => benchRollup({
    resources, assignments, assignmentDays, assignmentMonths,
    months: FETCH, displayMonths: DISPLAY, hoursPerDay: 8, holidays: HOLIDAYS, absences,
  }, TODAY);
  const marcoCells = (absences: BenchRollupInput['absences']) => {
    const row = bench(absences).internalRows.find(r => r.resourceId === '8');
    return DISPLAY.map(month => row?.monthly[month]?.state);
  };

  /**
   * CLAIM 1, and the whole privacy design rests on it: the redacted projection is
   * NUMERICALLY COMPLETE (spec §3.4). If it were not, the handler would have to
   * choose between correct numbers and a leak — so this is asserted, not believed.
   */
  it('gives the SAME rollup redacted as it does with the stored rows', () => {
    const redacted = resourceAbsences.map(redactAbsence);
    expect(bench(redacted)).toStrictEqual(bench(resourceAbsences));
    // ...and the same for the capacity rollup, the other threading point.
    const capacityInput = {
      resources, assignments, assignmentDays, assignmentMonths,
      months: DISPLAY, hoursPerDay: 8, holidays: HOLIDAYS,
    };
    expect(rollupMonthly({ ...capacityInput, absences: redacted }))
      .toStrictEqual(rollupMonthly({ ...capacityInput, absences: resourceAbsences }));
  });

  /**
   * CLAIM 2 — the NON-VACUITY of claim 1, and the anti-blind-gate check for the
   * three wiring lines. Without this, a `redactAbsence` that returned nothing
   * useful (or a handler that forgot the argument) would satisfy claim 1
   * perfectly: `[]` reproduces the pre-H numbers exactly.
   */
  it('and a DIFFERENT rollup from the one that omits absences entirely', () => {
    expect(bench(resourceAbsences.map(redactAbsence))).not.toStrictEqual(bench([]));
  });

  /**
   * The headline correction, with the paired absence-of-effect beside it: Marco
   * ('8') is the seed's pure-bench case, and his parental leave 2026-06-01..08-31
   * must take exactly THREE months out of the bench — not the row, and not April
   * or May.
   */
  it('turns Marco\'s three leave months ABSENT and leaves the others alone', () => {
    expect(marcoCells(resourceAbsences.map(redactAbsence)))
      .toStrictEqual(['BENCH', 'BENCH', 'ABSENT', 'ABSENT', 'ABSENT', 'BENCH']);
    // The before-picture, so the assertion above is a CHANGE and not a coincidence.
    expect(marcoCells([])).toStrictEqual(['BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH', 'BENCH']);
  });

  /**
   * The leak assertion over the WHOLE response body, not one field — the way a
   * leak is actually found. Mirrored in the smoke suite against the live route.
   */
  it('serves no reason and no note anywhere in the aggregate response', () => {
    const body = JSON.stringify(bench(resourceAbsences.map(redactAbsence)));
    expect(body).not.toContain('reasonCode');
    expect(body).not.toContain('ParentalLeave');
    expect(body).not.toContain('recordedBy');
    // NON-VACUITY: the seed really does carry those values, so their absence
    // above is redaction and not an empty rollup.
    expect(resourceAbsences.some(a => a.reasonCode === 'ParentalLeave')).toBe(true);
  });

  /**
   * The audit registry key. `/absences/:id` has to resolve to the segment the
   * server registers (`'absences'`, mapped to `repos.resourceAbsences`), or the
   * middleware records `changedKeys: []` with no before/after — an entry that
   * says something happened but not what, which is the exact failure the
   * money-defining registry entries were added to close.
   */
  it('resolves the audit target for an absence mutation', () => {
    expect(auditTargetRef('/absences/AB2')).toStrictEqual({ segment: 'absences', id: 'AB2' });
    // Case: Express routes case-insensitively, the registry is lowercase-keyed,
    // and ids are case-SENSITIVE — both halves at once.
    expect(auditTargetRef('/Absences/AB2')).toStrictEqual({ segment: 'absences', id: 'AB2' });
    // The collection root carries no id, so it resolves to nothing (a POST has no
    // before-image to snapshot).
    expect(auditTargetRef('/absences')).toBeUndefined();
  });
});
