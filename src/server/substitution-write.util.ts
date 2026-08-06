/**
 * C2 — THE DAY-ROW I/O OF A SUBSTITUTION, made all-or-nothing.
 *
 * The arithmetic of a substitution is pure and already unit-tested
 * (`planSubstitution` / `planGiveBack` in src/app/services/substitution.util.ts).
 * What was NOT tested — because it lived inline in `src/server.ts`, which Vitest
 * cannot import (that module instantiates the Angular SSR engine at load time) —
 * is the WRITE half: two repository calls per date, one adding hours to one side
 * and one taking them off the other.
 *
 * Those two calls were untransacted. A failure between them left the same hours
 * booked TWICE:
 *
 *   - `transferDummyMonth` added to the target, then reduced/removed the dummy's
 *     row. A rejection on date #5 of 20 left dates 1-4 moved, date #5 present on
 *     BOTH assignments, and dates 6-20 still on the dummy. `recomputeAssignedHours`
 *     ran only after the loop, so neither side's `assignedHours` matched its rows
 *     either. Every aggregate recomputes from `assignmentDays`, so the target's
 *     utilization counted hours they never received and /schedule and /capacity
 *     showed the same 8h twice. Retrying did not heal it and MISDESCRIBED it:
 *     `planSubstitution` computes `room = cap - booked`, which the phantom copy
 *     had already consumed, so the retry moved nothing and reported "the target
 *     has no capacity left in this month" — the operator told the target is full
 *     by a copy of the dummy's own hours.
 *
 *   - `returnHoursToDummy` credited the dummy in one loop and debited the target
 *     in a second. A failure between the loops left 320h of booked demand where
 *     160 existed, and its `finally` cleared the substitution link regardless, so
 *     no later decision, retarget or delete could ever run the give-back again:
 *     the double-booking was PERMANENT and UNREPEATABLE.
 *
 * `withRepositoriesTransaction` gives real atomicity on PostgreSQL, but it is a
 * PASS-THROUGH on the in-memory adapter (src/db/repositories.ts) — which is dev,
 * demo and every test. So each function here also journals what it wrote and
 * COMPENSATES it in reverse on failure, the same shape `generateBillingInvoice`
 * uses (src/server/commercial-write.util.ts): the compensating writes are
 * best-effort (a failure inside them must never mask the error that caused the
 * rollback), because on PostgreSQL the transaction rollback is the real guarantee
 * and the compensation is what makes the in-memory adapter behave identically.
 */

import type { AssignmentDay, AssignmentMonth } from '../app/services/api.service';
import type { Repository } from '../db/repository';
import type { GiveBackPlan, SubstitutionPlan } from '../app/services/substitution.util';

/** The day-row repository surface both writers need. */
export type AssignmentDayStore = Pick<Repository<AssignmentDay>, 'get' | 'create' | 'update' | 'remove'>;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * One journalled day-row write, with everything needed to put the row back
 * exactly as it was. `existed: false` means the row must be REMOVED to undo,
 * not reset to 0 — a 0-hour row is not the same thing as an absent one
 * (`sumHoursByDate` skips absent dates, and the allocation endpoint removes a
 * row that reaches zero rather than storing a zero).
 */
interface DayRowJournalEntry {
  id: string;
  assignmentId: string;
  date: string;
  existed: boolean;
  previousHours: number;
}

/**
 * Put one journalled row back. Best-effort: see the module doc comment.
 *
 * A row the forward pass REMOVED cannot be restored with `update()` — the
 * adapters return `undefined` for a missing id and write nothing, so an
 * update-only undo silently loses exactly the hours the transfer took off the
 * dummy. Re-checked against the CURRENT row rather than assumed from
 * `entry.existed`, because that flag records what was there BEFORE the write,
 * not what is there now.
 */
async function undoDayRow(store: AssignmentDayStore, entry: DayRowJournalEntry): Promise<void> {
  try {
    if (!entry.existed) {
      await store.remove(entry.id);
      return;
    }
    const current = await store.get(entry.id);
    if (current) await store.update(entry.id, { hours: entry.previousHours });
    else {
      await store.create({
        id: entry.id,
        assignmentId: entry.assignmentId,
        date: entry.date,
        hours: entry.previousHours,
      } as AssignmentDay);
    }
  } catch {
    /* preserve the original failure */
  }
}

/** Undo a whole journal, most recent write first. */
async function undoDayRows(store: AssignmentDayStore, journal: readonly DayRowJournalEntry[]): Promise<void> {
  for (let i = journal.length - 1; i >= 0; i -= 1) await undoDayRow(store, journal[i]);
}

/**
 * Record the pre-write state of a day row, then write `hours` onto it.
 * Returns the journal entry so the caller can undo it.
 */
async function writeDayRow(
  store: AssignmentDayStore,
  assignmentId: string,
  date: string,
  hours: number,
): Promise<DayRowJournalEntry> {
  const id = `${assignmentId}:${date}`;
  const existing = await store.get(id);
  const entry: DayRowJournalEntry = {
    id,
    assignmentId,
    date,
    existed: existing !== undefined,
    previousHours: Number.isFinite(existing?.hours) ? existing!.hours : 0,
  };
  if (existing) await store.update(id, { hours });
  else await store.create({ id, assignmentId, date, hours } as AssignmentDay);
  return entry;
}

/**
 * Record the pre-write state of a day row, then REMOVE it (the rule the
 * allocation endpoint applies to a day that reaches zero).
 */
async function clearDayRow(
  store: AssignmentDayStore,
  assignmentId: string,
  date: string,
): Promise<DayRowJournalEntry> {
  const id = `${assignmentId}:${date}`;
  const existing = await store.get(id);
  const entry: DayRowJournalEntry = {
    id,
    assignmentId,
    date,
    existed: existing !== undefined,
    previousHours: Number.isFinite(existing?.hours) ? existing!.hours : 0,
  };
  await store.remove(id);
  return entry;
}

export interface AppliedSubstitution {
  /**
   * What the target ALREADY held on each transferred date, on the target
   * assignment, before this transfer — captured at the moment of the write
   * because it is the only moment it is knowable. Persisted as
   * `replacedBaselineDays` so the give-back can tell the loan apart from the
   * target's own work.
   */
  baseline: Record<string, number>;
}

/**
 * Move one month's planned hours from the dummy assignment to the target
 * assignment, per date, ALL OR NOTHING.
 *
 * Per date: add `plan.transfer[date]` to the target's row (merging with whatever
 * it already holds on THIS assignment), then set the dummy's row to
 * `plan.remaining[date]` — removing it when that reaches zero.
 *
 * On any failure every row this call touched is restored to its pre-call value
 * and the error is rethrown, so the caller's month outcome reports a failure
 * over a state in which NO hours moved. That is what makes the retry correct:
 * the target's day is free again, so `planSubstitution` sees the real room
 * instead of a phantom copy of the dummy's own hours.
 */
export async function applySubstitutionDays(
  store: AssignmentDayStore,
  plan: Pick<SubstitutionPlan, 'transfer' | 'remaining'>,
  dummyAssignmentId: string,
  targetAssignmentId: string,
): Promise<AppliedSubstitution> {
  const journal: DayRowJournalEntry[] = [];
  const baseline: Record<string, number> = {};
  try {
    for (const [date, hours] of Object.entries(plan.transfer)) {
      const targetEntry = await writeDayRow(
        store,
        targetAssignmentId,
        date,
        // Merged, not overwritten: a substitution onto a month the target already
        // has hours in DEMOTES it, it does not replace it.
        round2((await heldHours(store, targetAssignmentId, date)) + hours),
      );
      journal.push(targetEntry);
      // Recorded for EVERY transferred date, zeros included, so `replacedDays`
      // and `replacedBaselineDays` always cover the same dates.
      baseline[date] = targetEntry.previousHours;

      const left = plan.remaining[date] ?? 0;
      journal.push(left > 0
        ? await writeDayRow(store, dummyAssignmentId, date, left)
        : await clearDayRow(store, dummyAssignmentId, date));
    }
    return { baseline };
  } catch (error) {
    await undoDayRows(store, journal);
    throw error;
  }
}

/** What one assignment holds on one date right now (0 when the row is absent). */
async function heldHours(store: AssignmentDayStore, assignmentId: string, date: string): Promise<number> {
  const existing = await store.get(`${assignmentId}:${date}`);
  return Number.isFinite(existing?.hours) ? existing!.hours : 0;
}

/** The month-row surface the give-back needs to settle the substitution link. */
export type SubstitutionLinkStore = Pick<Repository<AssignmentMonth>, 'update'>;

export interface GiveBackWriteDependencies {
  assignmentDays: AssignmentDayStore;
  assignmentMonths: SubstitutionLinkStore;
  /** Rewrite one assignment's `assignedHours` from its remaining day rows. */
  recomputeAssignedHours: (assignmentId: string) => Promise<void>;
}

/**
 * Hand a substituted month's hours back to the dummy they came from and CLOSE
 * THE SUBSTITUTION LINK, ALL OR NOTHING.
 *
 * The link clear is part of this function, not of the caller, because the two
 * must be atomic and previously were not: the caller cleared it in an
 * unconditional `finally`, so a give-back that failed half way through was both
 * permanent (the hours stayed double-booked) AND unrepeatable (the month no
 * longer looked like a pending substitution, so no later decision, retarget or
 * delete would try again).
 *
 * On failure every row is restored AND THE LINK IS LEFT OPEN, so the next
 * decision/retarget/delete retries the whole give-back. The caller's own
 * idempotence check — re-reading the link inside its locks — is what stops a
 * SUCCESSFUL give-back from being applied twice.
 *
 * Both maps empty is a legitimate no-op (the dummy is at its daily ceiling on
 * every date, or the plan conserved everything): the link is still closed, and
 * neither `recomputeAssignedHours` runs — rewriting `assignedHours` from day
 * rows on an untouched assignment would zero a LEGACY assignment that carries a
 * total with no day rows at all.
 */
export async function applyGiveBackDays(
  dependencies: GiveBackWriteDependencies,
  plan: Pick<GiveBackPlan, 'giveBack' | 'targetHours'>,
  targetAssignmentId: string,
  dummyAssignmentId: string,
  monthRowId: string,
): Promise<void> {
  const store = dependencies.assignmentDays;
  const journal: DayRowJournalEntry[] = [];
  try {
    for (const [date, hours] of Object.entries(plan.giveBack)) {
      // Merge onto the dummy's own assignment day, RECREATING it when it is
      // gone: the transfer removes a row that reached zero, so the day the dummy
      // gave everything from no longer exists.
      journal.push(await writeDayRow(
        store,
        dummyAssignmentId,
        date,
        round2((await heldHours(store, dummyAssignmentId, date)) + hours),
      ));
    }

    // The target's side. Empty on an approval — what they still hold IS the
    // approved allocation. On a rejection this carries only the dates the
    // transfer touched, each already reduced by exactly what the dummy received
    // (0 meaning "delete the row").
    for (const [date, left] of Object.entries(plan.targetHours)) {
      journal.push(left > 0
        ? await writeDayRow(store, targetAssignmentId, date, left)
        : await clearDayRow(store, targetAssignmentId, date));
    }

    if (Object.keys(plan.giveBack).length > 0) {
      await dependencies.recomputeAssignedHours(dummyAssignmentId);
    }
    if (Object.keys(plan.targetHours).length > 0) {
      await dependencies.recomputeAssignedHours(targetAssignmentId);
    }

    await closeSubstitutionLink(dependencies.assignmentMonths, monthRowId);
  } catch (error) {
    await undoDayRows(store, journal);
    throw error;
  }
}

/**
 * Clear all THREE substitution columns together.
 *
 * `replacedDays` and `replacedBaselineDays` are two halves of one record and a
 * surviving baseline would misdescribe the next substitution's loan. Explicit
 * `null`s: that is the documented "clear to absent" patch value on BOTH
 * adapters. Cast just these values so a typo in a neighbouring field is still
 * type-checked.
 *
 * Exported because the caller has two documented paths that write no day rows
 * at all — a dummy month/assignment/resource that no longer exists, and a
 * give-back the dummy's own employment window or daily ceiling refuses — and
 * those must still settle the link.
 */
export async function closeSubstitutionLink(
  store: SubstitutionLinkStore,
  monthRowId: string,
): Promise<void> {
  await store.update(monthRowId, {
    replacedFromAssignmentMonthId: null as unknown as undefined,
    replacedDays: null as unknown as undefined,
    replacedBaselineDays: null as unknown as undefined,
  } as Partial<AssignmentMonth>);
}
