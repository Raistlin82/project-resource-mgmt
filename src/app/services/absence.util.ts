/**
 * Resource absences (Block H, design spec §4). PURE, SSR-safe, UTC: ISO
 * 'YYYY-MM-DD' strings compared lexicographically, no `Date.now()`, no argless
 * `new Date()`, no dependency on the host time zone — the same contract
 * `calendar.util.ts` states at its head, and for the same reason (a test that
 * only passes under `TZ=UTC` proves nothing).
 *
 * A NEW FILE ON PURPOSE (spec §4.1): `bench.util.ts` and `capacity.util.ts` are
 * touched by parallel branches, so the new arithmetic lands here and the merge
 * surface shrinks to two call sites instead of a block.
 *
 * It imports ONLY `calendar.util.ts`, never `capacity.util.ts`. That is a
 * deliberate one-way edge: `capacity.util.ts` imports THIS file, so calling
 * `employedWorkingDays` from here would close an import cycle. It also would not
 * pay for itself — both callers (`rollupMonthly`, `benchRollup`) already hold the
 * employed-day list on the line above, so {@link availableWorkingDays} takes it
 * as an argument rather than recomputing `workingDaysInMonth` a second time.
 */

import { workingDaysInMonth } from './calendar.util';

/**
 * The shape this layer needs from a `ResourceAbsence` row: WHO and WHEN, never
 * WHY. `reasonCode` is deliberately absent from the type, not merely unread —
 * spec §3.4's privacy constraint ("the arithmetic never branches on
 * `reasonCode`") is only worth anything if it is impossible to violate by
 * accident, and a type that cannot carry the field makes the redacted
 * projection numerically complete by construction.
 *
 * Both dates are INCLUSIVE; a one-day absence has `startDate === endDate`.
 */
export interface AbsenceInterval {
  resourceId: string;
  startDate: string;
  endDate: string;
}

/**
 * The subset of `days` this resource is absent on.
 *
 * A `Set`, NOT an array: two overlapping absences (refused on write by §6.4, but
 * not impossible on imported data) must never subtract the same day twice. With
 * an array, `employedDays.length - absentDays.length` would go negative and a
 * pro-rated target would come out larger than the month.
 *
 * `days` is the caller's candidate list — normally a month's employed working
 * days — so weekends, holidays and non-employed days are excluded before this
 * function ever sees them: an absence over a bank holiday subtracts nothing,
 * because that day was never available to begin with.
 *
 * An inverted row (`endDate < startDate`) covers nothing rather than throwing:
 * the closed-interval test simply never matches. Same degrade-to-empty posture
 * `calendar.util.ts` takes on malformed input.
 */
export function absenceDaysFor(
  resourceId: string,
  absences: readonly AbsenceInterval[],
  days: readonly string[],
): ReadonlySet<string> {
  const out = new Set<string>();
  const mine = absences.filter(a => a.resourceId === resourceId);
  if (mine.length === 0) return out;
  for (const d of days) {
    if (mine.some(a => a.startDate <= d && d <= a.endDate)) out.add(d);
  }
  return out;
}

/**
 * `employedDays` minus the days this resource is absent on — the working days
 * she was employed AND actually staffable.
 *
 * A SIBLING of `employedWorkingDays`, never an override (spec §4.1). That helper
 * answers "was she employed", which an absence does not change, and it is shared
 * with `forecast.util.ts`, `bench.util.ts` and the server's write gate
 * (`bookingOutsideEmploymentError`) — one of which decides whether a booking is
 * ACCEPTED. Injecting absence into it would silently redefine "employed" in four
 * places, one of them a write path.
 *
 * Takes the employed-day list rather than the resource + month + holidays: see
 * the file header (no import cycle, no second `workingDaysInMonth` walk). Order
 * is preserved, so the result is still ascending.
 */
export function availableWorkingDays(
  resourceId: string,
  absences: readonly AbsenceInterval[],
  employedDays: readonly string[],
): string[] {
  const absent = absenceDaysFor(resourceId, absences, employedDays);
  if (absent.size === 0) return [...employedDays];
  return employedDays.filter(d => !absent.has(d));
}

/** How much of one resource-month the person could be staffed on (spec §4.1). */
export type MonthAvailability = 'available' | 'partly-absent' | 'fully-absent' | 'not-employed';

/**
 * Classifies the month from the two day counts. The ORDER of the branches is the
 * definition: "not employed at all" outranks "absent", because someone who was
 * not our employee that month is not on leave — she is simply not in the data.
 * `bench.util.ts` maps `'fully-absent'` to the fourth `BenchState` (§4.3); the
 * other three keep the three states they already had.
 *
 * `>=` rather than `===` on the last test so a caller who passes a day list
 * wider than the employed one lands on `'available'` instead of the impossible
 * "more available than employed" state.
 */
export function monthAvailability(
  employedDays: readonly string[],
  availableDays: readonly string[],
): MonthAvailability {
  if (employedDays.length === 0) return 'not-employed';
  if (availableDays.length === 0) return 'fully-absent';
  if (availableDays.length >= employedDays.length) return 'available';
  return 'partly-absent';
}

/** The 48 months (four years, one of them a leap year) the constant below averages. */
const DERIVATION_FIRST_YEAR = 2024;
const DERIVATION_YEARS = 4;
const NO_HOLIDAYS: ReadonlySet<string> = new Set<string>();

/**
 * A typical working month, in WORKING DAYS — the unit the idle-aging thresholds
 * are anchored to.
 *
 * DERIVED, not asserted: it averages `workingDaysInMonth` — the very function
 * `employedWorkingDays` filters, so the constant counts a month exactly the way
 * the rest of the system does — over four consecutive years, which covers one
 * leap year and every weekday alignment a year can start on — which is what makes
 * the MAXIMUM stable at 23 for any such window (checked over 2020-2040: min 20,
 * max 23). The spec pins it against a DIFFERENT window than this one, so a typo
 * in the years above shows up red.
 *
 * HOLIDAY-FREE on purpose. Holidays are per-tenant data that an administrator
 * can edit; folding them in would move a bucket boundary, and the same idle
 * history would silently reclassify from C to D because somebody added a public
 * holiday. The threshold is a policy constant, not a per-tenant measurement.
 *
 * THE MAXIMUM, not the mean — and this is the correction that matters.
 *
 * The mean over such a window is ~21.7, so flooring gave 21. But the requirement
 * the RPT labels state is "B = idle less than ONE MONTH", and a single full month
 * is 20, 21, 22 or 23 working days depending on which month it is. Against a
 * ceiling of 21, one full month of idleness landed in B for May and August 2026
 * (21 days) and in C for April, June, July and September (22-23). The bucket then
 * depended on WHICH MONTH somebody happened to be idle in — precisely the
 * arbitrariness that moving to days was meant to remove, relocated rather than
 * removed. It was visible on the seed: Marco's April read C where the month-based
 * code read B.
 *
 * Taking the longest possible month makes one full month ALWAYS B and two full
 * months ALWAYS C (2 × 23 = 46 is the most two months can be), so the labels mean
 * what the manual says regardless of the calendar. The cost is that an idle span
 * of 22-23 days assembled across a month boundary also reads B; that is the
 * honest side of the trade, and "idle about a month" is a fair description of it.
 *
 * Cost: 48 × ~30 iterations once at module load, all pure string arithmetic.
 */
export const LONGEST_WORKING_MONTH_DAYS: number = (() => {
  let longest = 0;
  for (let y = DERIVATION_FIRST_YEAR; y < DERIVATION_FIRST_YEAR + DERIVATION_YEARS; y++) {
    for (let m = 1; m <= 12; m++) {
      const n = workingDaysInMonth(`${y}-${String(m).padStart(2, '0')}`, NO_HOLIDAYS).length;
      if (n > longest) longest = n;
    }
  }
  return longest;
})();

/**
 * Idle-aging thresholds in WORKING DAYS, replacing the month counts the RPT
 * labels A/B/C/D were first written against (product decision Q1, spec §10:
 * "giorni lavorativi esatti", 2026-08-07).
 *
 * The labels stay — they are the language RPT users recognise — but the unit
 * underneath is the working day, because the month was the wrong unit: it forced
 * a choice between inflating C/D with holidays and deflating them, and BOTH
 * answers were wrong. Counting days dissolves the question (see
 * {@link idleWorkingDaysAt}).
 *
 * Boundaries are INCLUSIVE at the top, so the three buckets tile the line with
 * no gap and no overlap: B is `[1, 23]`, C is `[24, 46]`, D is `[47, ∞)` — read
 * off the constants below, never retyped, because this comment already went stale
 * once. It said `[1, 21]` / `[22, 42]` and offered "a single 22-working-day month
 * now reads C" as the example, both of which were true only of the FLOORED-MEAN
 * ceiling that this file no longer uses: 22 reads B. The prose survived the fix
 * to the numbers and the tests, and a reader following it would have drawn the
 * wrong boundary — which is why the xlsx report interpolates these constants into
 * its category labels instead of typing month phrases.
 *
 * The spec's own "C 21-42" is ambiguous about the endpoint; inclusive-at-top is
 * the reading, and a full working month belongs to B whichever month it is.
 *
 * `bench.util.ts` owns the bucket union and the classifier that reads these
 * (they are its labels); this file owns the numbers, so the classifier never has
 * to re-derive them.
 */
export const IDLE_WORKING_DAYS_B_MAX = LONGEST_WORKING_MONTH_DAYS;
export const IDLE_WORKING_DAYS_C_MAX = LONGEST_WORKING_MONTH_DAYS * 2;

/**
 * One month's worth of facts for {@link idleWorkingDaysAt}. Three primitives
 * rather than an enum, because the "an absent day counts zero" rule is then
 * STRUCTURAL — it falls out of `availableDays` being produced by
 * {@link availableWorkingDays} — instead of a policy branch someone could flip.
 */
export interface IdleMonth {
  /** Employed on at least one working day (`employedWorkingDays(...).length > 0`). */
  employed: boolean;
  /** Any hours booked this month — i.e. `planned > 0`, equivalently `state !== 'BENCH'`. */
  staffed: boolean;
  /** Working days employed AND not absent: `availableWorkingDays(...).length`. */
  availableDays: number;
}

/**
 * Consecutive IDLE WORKING DAYS ending at `months[index]`, walking backward.
 *
 * This replaces `absenceStreakPolicy` as designed in spec §4.2, and the reason is
 * that the question §4.2 was built to answer no longer exists. §4.2 asked whether
 * an absent MONTH breaks the idle streak or is transparent; the user rejected the
 * unit (Q1, §10). At day granularity there is nothing to decide: an absent day is
 * simply not an idle day, because the person was not staffable on it. It neither
 * increments the count nor interrupts it.
 *
 * The four rules, in the order they are applied — the order IS the semantics:
 *
 *  1. NOT EMPLOYED → the walk STOPS. Employment is the precondition of idleness:
 *     a gap in employment is not a continuation of it, and a rehire starts a new
 *     history. This also preserves today's behaviour exactly — `benchRollup`
 *     builds `benchFlags` as `active && state === 'BENCH'`, so a non-active month
 *     already reads `false` and already halts the backward walk.
 *  2. ZERO AVAILABLE DAYS while employed (a fully-absent month) → contributes
 *     nothing and the walk CONTINUES. This is the whole of the Q1 decision. It
 *     is tested BEFORE `staffed` on purpose: a month the person could not work at
 *     all must not break the run even when stale bookings survive on it (§6.4
 *     accepts an absence recorded over already-booked days, so those rows exist).
 *  3. STAFFED → the walk STOPS. Same break today's `monthsIdleAt` has, expressed
 *     on hours instead of on the derived state.
 *  4. Otherwise → add that month's available days. A partly-absent month
 *     contributes only the days she was actually there for, which is the day-level
 *     statement of "an absent day contributes zero".
 *
 * Counting DAYS rather than HOURS handles part-time by itself and deliberately:
 * somebody on 4h/day who is not staffed is just as idle that day as a full-timer,
 * so no hourly weighting appears anywhere in this function's inputs.
 *
 * NOT CAPPED, unlike `monthsIdleAt`'s cap of 3. The answer is bounded by the run
 * the caller supplies (`benchRollup`'s fetch window is 2 look-back + 6 shown + 1
 * look-ahead, so the earliest shown month can still reach ~63 working days back —
 * comfortably past the D threshold). A capped count would be wrong the moment
 * anything rendered the number itself rather than only its bucket.
 *
 * A negative `index` yields 0 and an over-long one is clamped to the last month,
 * so a caller's off-by-one degrades to a number rather than a crash; a
 * non-finite `availableDays` contributes
 * 0 without breaking the run, so one poisoned row cannot turn the count into NaN
 * (the same defensive posture `hoursByResourceMonth` and `unallocatedShare` take).
 */
export function idleWorkingDaysAt(months: readonly IdleMonth[], index: number): number {
  let days = 0;
  for (let i = Math.min(index, months.length - 1); i >= 0; i--) {
    const m = months[i];
    if (m === undefined || !m.employed) break;
    const available = Number.isFinite(m.availableDays) ? Math.max(0, m.availableDays) : 0;
    if (available === 0) continue;
    if (m.staffed) break;
    days += available;
  }
  return days;
}
