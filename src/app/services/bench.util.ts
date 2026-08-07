/**
 * Bench / Unchargeable and availability (design spec, Block F; extended by Block
 * H §4.3-§4.4). PURE: no I/O, no clock — `today` is always a caller-supplied
 * value, never read here. UTC throughout: every date is an ISO 'YYYY-MM-DD'
 * string compared lexicographically, so no host time zone can move an answer.
 *
 * Mirrors `finance.util.ts`'s A/R aging shape (`AR_AGING_BUCKETS` /
 * `bucketForDaysOverdue` / `arAging`, `src/app/services/finance.util.ts:370-462`):
 * an ordered tuple of literal buckets, a pure classifier, an aggregator. The
 * difference that matters: aging here has TWO distinct questions — how long a
 * resource has ALREADY been idle (B/C/D, retrospective) and whether it is ABOUT
 * to become idle next month (forward-looking) — and the two are mutually
 * exclusive by construction, never merged into one bucket set (spec §5).
 *
 * H adds a FOURTH state, `'ABSENT'`, and the idle aging it feeds is counted in
 * WORKING DAYS (`idleWorkingDaysAt`, `absence.util.ts`) rather than in whole
 * BENCH months — product decision Q1, spec §10. This file keeps the bucket
 * LABELS (B/C/D, the language RPT users recognise) and the classifier; the
 * thresholds themselves live next to the day arithmetic that derives them.
 */

import {
  IDLE_WORKING_DAYS_B_MAX, IDLE_WORKING_DAYS_C_MAX, type IdleMonth,
  availableWorkingDays, idleWorkingDaysAt, monthAvailability,
} from './absence.util';
import { RollupInput, employedWorkingDays, standardMonthlyHours, hoursByResourceMonth } from './capacity.util';
import { countsTowardDeliveryCapacity, kindOf } from './resource-kind.util';

/**
 * FOUR values, and `'ABSENT'` is a STATE rather than a flag beside one (spec
 * §4.3). That choice is the design, not a shortcut: every existing consumer
 * filters either on `state === 'BENCH'` (the /dashboard tiles, /bench's own
 * counters, /forecast's list) or on `state !== 'ALLOCATED'`
 * ({@link notFullyAllocatedAt}). A fourth value fixes the first group BY ITSELF
 * — a person on leave stops being counted as bench, which is the headline
 * correction — and leaves the second group visibly wrong until each is fixed by
 * hand, which is the point: `!== 'ALLOCATED'` now admits `'ABSENT'`, i.e. it
 * would list somebody on parental leave among the reallocatable. A boolean flag
 * beside a 3-valued state would have left BOTH groups silently unchanged: four
 * green, wrong surfaces, which is the exact signature of block C1.
 */
export type BenchState = 'BENCH' | 'PARTIAL' | 'ALLOCATED' | 'ABSENT';

/**
 * Classifies a single resource-month on RAW (unrounded) hours — never on a
 * percentage already rounded for display. A resource with 0.4h booked out of
 * ~160 standard hours rounds to "0.00%" on screen but is NOT bench: it has a
 * real, if tiny, booking (spec §3).
 *
 * UNCHANGED BY H as a function, and it never returns `'ABSENT'`: the caller
 * decides that from {@link monthAvailability} and does not call this at all on a
 * fully-absent month. That guard matters — `benchStateFor(0, 0)` answers
 * `'BENCH'`, the one false answer the old function can still give (spec §4.4),
 * and a fully-absent MID-MONTH JOINER would not even hit the `0` target: her
 * absent days deduct less than the whole standard month, so the wrong answer
 * would be a confident `'BENCH'` against a positive target. Branching on
 * availability FIRST is therefore not belt-and-braces, it is the only correct
 * order.
 *
 * What H changes is the `targetHours` the caller passes: the standard month LESS
 * this person's absent working days (see {@link benchRollup}).
 */
export function benchStateFor(plannedHours: number, targetHours: number): BenchState {
  if (plannedHours === 0) return 'BENCH';
  if (plannedHours < targetHours) return 'PARTIAL';
  return 'ALLOCATED';
}

/**
 * How much of a resource-month is NOT allocated, as a percentage and in days —
 * the RPT "% di disallocazione" figure (comparison matrix row 50).
 *
 * THE DENOMINATOR IS THE RESOURCE'S OWN TARGET, not the company standard month:
 * `availableWorkingDayCount × ownHoursPerDay`, i.e. the same product
 * `rollupMonthly` pro-rates capacity by (`capacity.util.ts`, the `capacityFte`
 * line). A part-timer on 4h/day and a mid-month joiner each have their own
 * target, so neither is reported as half-idle for working every hour they are
 * contracted for. This is DELIBERATELY a different denominator from
 * {@link benchStateFor}'s, which classifies BENCH/PARTIAL/ALLOCATED against the
 * STANDARD month — so a fully-booked part-timer can legitimately read
 * `state: 'PARTIAL'` with `unallocatedPct: 0`. The two fields answer two
 * different questions ("is there room in the standard month" vs "is this person
 * idle against their own contract"); the divergence is pinned by a test rather
 * than left to be rediscovered as a bug.
 *
 * H NARROWS THE DAY COUNT FROM EMPLOYED TO AVAILABLE, and that is a deliberate
 * change of meaning rather than a mechanical one. `unallocatedDays` is read as
 * "days a planner could still fill", and an absent day cannot be filled — the
 * server refuses a NEW booking on one (spec §6.4). Counting it would repeat, on
 * this field, exactly the leaver defect `capacity.util.ts` documents at its
 * `capacityFte` line: advertising capacity the API would decline. Concretely, a
 * person employed 22 days and absent 5 with nothing booked reads 17 idle days,
 * not 22; a person absent for the WHOLE month reads no answer at all (target 0 →
 * `undefined`, below), which is right — she was not staffable, so the share of
 * her staffable time is unanswerable rather than 100%. With no absence rows
 * `availableWorkingDays` returns the employed list verbatim, so every pre-H
 * figure is reproduced to the digit.
 *
 * `undefined`, never a number, when the own target is 0 — a percentage of no
 * capacity is UNANSWERABLE, not 0%. Reporting 0 there would say "fully
 * allocated" about someone who has no contracted hours at all, which is the
 * error direction that hides people.
 *
 * Truncated to [0, 100]: an OVER-allocated month is 0% unallocated, never
 * negative (there is no state above ALLOCATED either — see
 * {@link benchStateFor}; `'ABSENT'` is not "more than allocated", it is a
 * different question).
 */
export function unallocatedShare(
  plannedHours: number, ownHoursPerDay: number, availableWorkingDayCount: number,
): { unallocatedPct: number; unallocatedDays: number } | undefined {
  const targetHours = availableWorkingDayCount * ownHoursPerDay;
  // `!(x > 0)` rather than `x <= 0` so NaN lands here too; a non-finite booking is
  // likewise unanswerable, and must never reach a template as "NaN%".
  if (!(targetHours > 0) || !Number.isFinite(plannedHours)) return undefined;
  // targetHours > 0 implies ownHoursPerDay > 0, so the days division is safe.
  const idleHours = Math.min(targetHours, Math.max(0, targetHours - plannedHours));
  return { unallocatedPct: (idleHours / targetHours) * 100, unallocatedDays: idleHours / ownHoursPerDay };
}

/** Retrospective aging buckets (spec §5.1) — ordered, like `AR_AGING_BUCKETS`. */
export const UNALLOCATED_AGING_BUCKETS = ['B', 'C', 'D'] as const;
export type UnallocatedAgingBucket = (typeof UNALLOCATED_AGING_BUCKETS)[number];

/**
 * B/C/D from CONSECUTIVE IDLE WORKING DAYS (product decision Q1, spec §10) —
 * what `bucketForMonthsIdle` used to answer from a count of whole BENCH months.
 * The count itself comes from `idleWorkingDaysAt` (`absence.util.ts`), which is
 * where the absence rule lives; this function is only the labelling, and it is
 * here because B/C/D are this file's vocabulary.
 *
 * The boundaries are INCLUSIVE at the top and tile the line with no gap and no
 * overlap: B is `[1, IDLE_WORKING_DAYS_B_MAX]`, C is `[B_MAX+1,
 * IDLE_WORKING_DAYS_C_MAX]`, D is `[C_MAX+1, ∞)`.
 *
 * SYMBOLIC ON PURPOSE, no literals. This comment previously spelled out `[1, 21]`
 * / `[22, 42]` / `[43, ∞)` and went stale the moment the derivation changed from
 * the floored MEAN of a month to the LONGEST month — the live values are 23 and
 * 46, so every number here was wrong while reading authoritative. The same drift
 * hit the twin comment in `absence.util.ts`. Quoting a derived constant in prose
 * defeats the point of deriving it; `UNCHARGEABLE_CATEGORY_LABELS`
 * (`rpt-xlsx.util.ts`) interpolates them into user-facing text for exactly this
 * reason and is the model to follow.
 *
 * THE REQUIREMENT the boundaries have to keep: ONE FULL MONTH of idleness is B
 * whichever month it is, and two full months are C. A real month runs 20 to 23
 * working days, so a ceiling below 23 made the bucket depend on WHICH month
 * somebody happened to be idle in — which is the arbitrariness moving to days was
 * meant to remove. `absence.util.spec.ts` asserts it over every month of the
 * derivation window rather than leaving it here in prose, because prose does not
 * go red.
 *
 * `0` cannot arise from a BENCH cell (a BENCH month is not fully absent, so it
 * contributes at least one available day), but it degrades to 'B' rather than
 * throwing — the same posture the rest of this file takes on impossible input.
 */
export function bucketForIdleWorkingDays(idleWorkingDays: number): UnallocatedAgingBucket {
  if (idleWorkingDays <= IDLE_WORKING_DAYS_B_MAX) return 'B';
  if (idleWorkingDays <= IDLE_WORKING_DAYS_C_MAX) return 'C';
  return 'D';
}

/**
 * Forward-looking "freeing up next month" signal (spec §5.2). Mutually
 * exclusive with an aging bucket by construction: this requires
 * `stateThis !== 'BENCH'`, aging buckets require `stateThis === 'BENCH'`.
 *
 * `activeNext` is deliberate: a resource that TERMINATES between this month
 * and the next is not marked "freeing up" — that is an offboarding event, not
 * a reallocation to plan for (out of scope — spec §12).
 *
 * UNCHANGED BY H, and both directions of the fourth state fall out of the
 * existing tests rather than needing a branch (spec §5.1 B5), which is why they
 * are ASSERTED in both directions instead of deduced:
 *  - going ON leave next month is NOT "freeing up" — `stateNext === 'ABSENT'`
 *    fails the `=== 'BENCH'` test, and a person who cannot be booked is not
 *    capacity coming free;
 *  - RETURNING from leave into a bench month IS — `stateThis === 'ABSENT'`
 *    satisfies `!== 'BENCH'`, and that person genuinely does need staffing next
 *    month. Wanted, not tolerated.
 */
export function freeingUpNextMonth(
  activeThis: boolean, stateThis: BenchState,
  activeNext: boolean, stateNext: BenchState | undefined,
): boolean {
  return activeThis && stateThis !== 'BENCH' && activeNext && stateNext === 'BENCH';
}

export type AvailabilityDate =
  | { kind: 'date'; date: string }
  | { kind: 'beyond-horizon'; horizonEndMonth: string };

/**
 * The 6-month availability date (spec §7) — NEVER absent, so a bench table
 * cell can never be misread as "no data" instead of "not free soon". Uses
 * ONLY the shown `cells`, in order — deliberately never the look-ahead month
 * fetched for `freeingUpNextMonth` (spec §7's explicit non-unification: the
 * two fields have different data scopes on purpose).
 *
 * H REQUIRES ABSENT MONTHS TO BE SKIPPED (spec §5.1 B6: "the most user-visible
 * falsehood — a table declaring somebody on maternity leave available today").
 *
 * Testing `=== 'BENCH'` in both branches is necessary and WAS NOT SUFFICIENT, and
 * the gap shipped: the first branch asked about `cells[0]`, which is the first
 * month of the DISPLAY WINDOW — anchored on the oldest Open planning period, four
 * months before today with the shipped seed — not about today. Marco Belli is
 * BENCH in April and on parental leave for the whole of August, so with today in
 * August the page answered "Available: 7 August 2026" for a man on leave. The
 * exact falsehood B6 names, produced by a predicate that reads correct.
 *
 * Every pre-existing case here passed `today` inside `cells[0]`'s own month — the
 * one shape where asking about `cells[0]` and asking about today are the same
 * question. That is why the tests were green.
 *
 * The window is also searched FORWARD FROM TODAY, not from its start: a BENCH
 * month that has already passed is not an availability date, and returning it
 * would answer with a date in the past.
 *
 * THE INVERSION REMAINS A HAZARD: rewriting either predicate to
 * `!== 'ALLOCATED'` — the shape {@link notFullyAllocatedAt} uses one screen over
 * — starts answering "available today" for everyone on leave. A month on leave
 * still yields an answer, never an empty field: the first genuinely bench month
 * after it, or `beyond-horizon`.
 */
export function availabilityDateFor(
  cells: readonly { month: string; state: BenchState }[],
  today: string,
): AvailabilityDate {
  const currentMonth = today.slice(0, 7);
  // Forward from today, never from the start of the window.
  const ahead = cells.filter(c => c.month >= currentMonth);
  if (ahead[0]?.month === currentMonth && ahead[0].state === 'BENCH') return { kind: 'date', date: today };
  const firstBench = ahead.find(c => c.state === 'BENCH');
  if (firstBench) return { kind: 'date', date: `${firstBench.month}-01` };
  return { kind: 'beyond-horizon', horizonEndMonth: cells[cells.length - 1]?.month ?? '' };
}

export interface HiringDemandRow { month: string; role: string; hours: number; }

/**
 * Hiring demand from DUMMY placeholders only (spec §6) — subco rows go to
 * bench (§4), never here. `hours` is RAW, unrounded; the FTE conversion is a
 * rendering-only step (§6/§10), never computed here.
 *
 * Aggregates through a nested `Map<month, Map<role, hours>>` rather than a
 * joined `${month}:${role}` string key: a role name is free text from the
 * `/project-roles` catalog (only `code`, not `name`, is character-restricted —
 * see `manage-project-roles.component.ts`), so it can legally contain a colon
 * or any other character. A joined-then-split key would silently merge or
 * mis-parse such a role; keeping month and role as separate map levels avoids
 * the parse entirely, so no role content can corrupt the aggregation.
 */
export function hiringDemandByMonth(
  resources: readonly { id: string; role: string; kind?: string }[],
  hoursByResMonth: ReturnType<typeof hoursByResourceMonth>,
  months: readonly string[],
): HiringDemandRow[] {
  const totalsByMonth = new Map<string, Map<string, number>>();
  for (const r of resources) {
    if (kindOf(r) !== 'dummy') continue;
    const byMonth = hoursByResMonth.get(r.id);
    if (!byMonth) continue;
    for (const m of months) {
      const cell = byMonth.get(m);
      if (!cell || cell.planned <= 0) continue;
      let byRole = totalsByMonth.get(m); if (!byRole) { byRole = new Map(); totalsByMonth.set(m, byRole); }
      byRole.set(r.role, (byRole.get(r.role) ?? 0) + cell.planned);
    }
  }
  const rows: HiringDemandRow[] = [];
  for (const [month, byRole] of totalsByMonth) {
    for (const [role, hours] of byRole) rows.push({ month, role, hours });
  }
  return rows.sort((a, b) => (a.month === b.month ? a.role.localeCompare(b.role) : a.month.localeCompare(b.month)));
}

export interface BenchCell {
  state: BenchState;
  /**
   * Present ONLY when `state === 'BENCH'` — so never on an `'ABSENT'` cell (spec
   * §5.1 B8). Idleness is a delivery problem to age; being on leave is not one,
   * and stamping a bucket on it would put the person back into the very ladder
   * the fourth state removes her from.
   */
  agingBucket?: UnallocatedAgingBucket;
  upcomingUnallocated: boolean;
  /**
   * How much of this month the resource is NOT allocated for — RPT's
   * disallocation figure (comparison matrix row 50), which the 3-valued `state`
   * cannot express (it cannot tell someone idle at 10% from someone idle at 90%).
   *
   * OPTIONAL, and the absence is a VALUE, not an omission: both fields are absent
   * exactly when the resource's own monthly target is 0, because a share of no
   * capacity is unanswerable rather than 0 (see {@link unallocatedShare}). Same
   * kind of semantic absence `agingBucket` already has on this type. A renderer
   * must therefore distinguish "no answer" from "0%" — showing 0% for an absent
   * value claims someone is fully allocated when nothing is known.
   *
   * H adds a second, more common way for the target to be 0: a month the person
   * was absent for ENTIRELY. So an `'ABSENT'` cell carries neither field, and
   * that is the honest shape — "how much of her staffable month is unfilled" has
   * no answer when none of it was staffable. A partly-absent month DOES carry
   * both, counted over the days she was actually there.
   *
   * Raw and unrounded, like every other figure crossing this boundary; the 2-decimal
   * cap is a rendering step.
   */
  unallocatedPct?: number;
  /** Days not allocated in the month, same absence rule as {@link BenchCell.unallocatedPct}. */
  unallocatedDays?: number;
}
export interface BenchRow {
  resourceId: string; resourceName: string; kind: 'internal' | 'subco';
  monthly: Record<string, BenchCell>;
  availabilityDate: AvailabilityDate;
}
export interface BenchRollup {
  months: string[];
  internalRows: BenchRow[];
  subcoRows: BenchRow[];
  hiringDemand: HiringDemandRow[];
}
/**
 * H VERDICT (spec §5.1 B9): `BenchRollup` gains NO field, so this literal stays
 * as it is. B9 warns that an added field would leave a stale empty default that
 * still type-checks — a divergence no typed test can see. The absence count Q3
 * requires next to /bench's percentages needs no new field: four states make
 * `rows.filter(state === 'ABSENT').length` derivable by any consumer, and adding
 * a redundant total would create two numbers that can disagree.
 */
export const EMPTY_BENCH_ROLLUP: BenchRollup = { months: [], internalRows: [], subcoRows: [], hiringDemand: [] };

export interface BenchRollupInput extends RollupInput {
  // Narrows `RollupInput['resources']` (which has no `role` — `rollupMonthly`
  // never needs one) to add the field `hiringDemandByMonth` requires. Kept
  // local to this interface rather than added to `RollupResource` itself:
  // widening the shared type would force `role` onto every `rollupMonthly`
  // fixture across the codebase, most of which omit it.
  resources: (RollupInput['resources'][number] & { role: string })[];
  /** The 6 months to return as rows — see the server's window construction (Task 6). */
  displayMonths: string[];
  // `absences` is INHERITED from `RollupInput`, not redeclared here (spec §5.1
  // B10 asks for the field; T3 had already put it on the parent so /capacity and
  // /bench cannot be handed different absence sets). It is OPTIONAL with an empty
  // default, and that is a DECLARED TRAP: omitting it reproduces the pre-H
  // arithmetic to the digit, so every fixture in this file's spec stays green
  // while exercising not one new line. Only a DIFFERENTIAL test — the same
  // fixture with and without rows, asserted to disagree on state, on the aging
  // bucket, on `availabilityDate` and on `notFullyAllocatedAt` — can show the
  // field is read at all. Those tests are in the spec; do not delete them on the
  // grounds that the value assertions beside them already pass.
}

/**
 * Composes the whole Block F view: BENCH/PARTIAL/ALLOCATED + aging + the
 * forward-looking signal + availability, split into `internalRows`/`subcoRows`
 * by `countsTowardDeliveryCapacity` (NOT `countsTowardInternalCapacity` —
 * spec §4's whole point: a subco belongs in bench, a dummy never does), plus
 * `hiringDemand` from the dummy rows this split excludes.
 *
 * `input.months` is the WIDER fetch window (2 look-back + 6 shown + 1
 * look-ahead, spec §8); `input.displayMonths` is the 6 shown months. A
 * resource gets a row only if active in at least one DISPLAY month — a
 * DELIBERATE narrowing from `rollupMonthly`'s own `hasAny` gate (which
 * considers every fetched month): a resource whose only booking falls in the
 * look-back window (spec §11 fixture 6) must NOT surface a row here.
 *
 * THE ROW GATE STAYS ON *EMPLOYED*, NEVER ON AVAILABLE (spec §5.1 B11). Someone
 * absent for all six shown months keeps her row and reads `'ABSENT'` six times.
 * Narrowing the gate would delete her instead, which puts her back among the
 * "missing data" the fourth state exists to distinguish her from — and a person
 * who has silently vanished from the grid is worse than one wrongly counted as
 * bench, because nothing on screen says anything is wrong.
 */
export function benchRollup(input: BenchRollupInput, today: string): BenchRollup {
  const { resources, months, displayMonths, hoursPerDay, holidays, absences = [] } = input;
  const hoursByResMonth = hoursByResourceMonth(input);
  const targetByMonth = new Map(months.map(m => [m, standardMonthlyHours(m, hoursPerDay, holidays)]));
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  const internalRows: BenchRow[] = [];
  const subcoRows: BenchRow[] = [];

  for (const r of resources) {
    const kind = kindOf(r);
    if (!countsTowardDeliveryCapacity(kind)) continue; // dummy: never in bench (spec §4)

    const activeOf = new Map<string, boolean>();
    const stateOf = new Map<string, BenchState>();
    // The facts `idleWorkingDaysAt` walks backward over, one entry per FETCHED
    // month, so an aging count can reach into the look-back window. Built from
    // primitives rather than from the derived `state` on purpose: `staffed` is
    // `planned > 0`, which differs from `state !== 'BENCH'` on exactly the
    // fully-absent months where stale bookings can survive (§6.4 accepts an
    // absence recorded over already-booked days), and the whole Q1 rule depends
    // on those months contributing nothing WITHOUT breaking the run.
    const idleMonths: IdleMonth[] = [];
    // The resource's OWN monthly target, per month: AVAILABLE working days ×
    // their own contracted hours. Kept alongside `stateOf` (whose target is the
    // standard month less absent days) because `unallocatedShare` needs the
    // pro-rated one — see its doc comment for why the two denominators differ.
    const ownTargetOf = new Map<string, { availableDays: number; hoursPerDay: number }>();
    for (const m of months) {
      // Employment is measured in DAYS, not months — the same `employedWorkingDays`
      // gate `rollupMonthly` uses, and the same granularity the server enforces a
      // booking at (`bookingOutsideEmploymentError`). This used to be the coarse
      // a month-granular gate, which compares `hireDate` with the month's START: someone
      // hired on the 15th was "not active" for the whole month, so /bench DROPPED
      // her row while /capacity — already on the day-granular gate — kept it. Two
      // screens over one endpoint's data disagreeing about whether a person exists
      // this month is the defect; there is no bench-specific reason to answer the
      // employment question differently from the capacity grid.
      //
      // H does NOT touch this call. `employedWorkingDays` answers "was she
      // employed", which an absence does not change, and it is shared with the
      // server's write gate — injecting absence would make it REFUSE legitimate
      // bookings. `availableWorkingDays` is its sibling (spec §4.1), never an
      // override.
      const employedDays = employedWorkingDays(r, m, holidays);
      const active = employedDays.length > 0;
      activeOf.set(m, active);
      const cell = hoursByResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      if (!active) { idleMonths.push({ employed: false, staffed: false, availableDays: 0 }); continue; }
      const availableDays = availableWorkingDays(r.id, absences, employedDays);
      idleMonths.push({ employed: true, staffed: cell.planned > 0, availableDays: availableDays.length });
      if (monthAvailability(employedDays, availableDays) === 'fully-absent') {
        // The FOURTH STATE, and the only place it is assigned (spec §4.3). Note
        // this branch comes BEFORE `benchStateFor` is reached at all — see that
        // function for why the order, not a zero target, is what makes it safe.
        stateOf.set(m, 'ABSENT');
      } else {
        // The pro-rated target: the standard month LESS her absent working days,
        // deducted at the COMPANY rate. Byte-identical to the old
        // `standardMonthlyHours(...)` when there are no absences, and identical to
        // the denominator `rollupMonthly` gives its own cell — so /bench's
        // PARTIAL/ALLOCATED boundary and /capacity's semaphore keep answering
        // from ONE number. Deliberately NOT the spec §4.4 sketch
        // `availableDays × contractHoursPerDay`: that would be a THIRD
        // convention, and it would move every part-timer's and every mid-month
        // joiner's state with no absence in sight, breaking the invariant that
        // `absences: []` reproduces today exactly. The part-timer divergence
        // between this state and `unallocatedPct` is deliberate and pinned by a
        // test — see `unallocatedShare`.
        const absentDays = employedDays.length - availableDays.length;
        stateOf.set(m, benchStateFor(cell.planned, targetByMonth.get(m)! - absentDays * hoursPerDay));
      }
      ownTargetOf.set(m, { availableDays: availableDays.length, hoursPerDay: r.contractHoursPerDay ?? hoursPerDay });
    }

    if (!displayMonths.some(m => activeOf.get(m))) continue; // never active in a SHOWN month -> no row

    const monthly: Record<string, BenchCell> = {};
    for (const m of displayMonths) {
      if (!activeOf.get(m)) continue;
      const state = stateOf.get(m)!;
      const cell: BenchCell = { state, upcomingUnallocated: false };
      if (state === 'BENCH') cell.agingBucket = bucketForIdleWorkingDays(idleWorkingDaysAt(idleMonths, monthIndex.get(m)!));
      const own = ownTargetOf.get(m)!;
      const share = unallocatedShare(hoursByResMonth.get(r.id)?.get(m)?.planned ?? 0, own.hoursPerDay, own.availableDays);
      // Left ABSENT, never zeroed, when the own target is 0 — see BenchCell. A
      // fully-absent month lands here with 0 available days, so its share keys are
      // absent for the same reason and by the same code path.
      if (share) { cell.unallocatedPct = share.unallocatedPct; cell.unallocatedDays = share.unallocatedDays; }
      monthly[m] = cell;
    }
    for (const m of displayMonths) {
      const cell = monthly[m];
      if (!cell) continue;
      const idx = monthIndex.get(m)!;
      const nextMonth = months[idx + 1];
      const activeNext = nextMonth !== undefined && (activeOf.get(nextMonth) ?? false);
      const stateNext = nextMonth !== undefined ? stateOf.get(nextMonth) : undefined;
      cell.upcomingUnallocated = freeingUpNextMonth(activeOf.get(m) ?? false, cell.state, activeNext, stateNext);
    }

    const cellsInOrder = displayMonths.filter(m => monthly[m] !== undefined).map(m => ({ month: m, state: monthly[m].state }));
    const row: BenchRow = {
      resourceId: r.id, resourceName: r.name, kind: kind as 'internal' | 'subco',
      monthly, availabilityDate: availabilityDateFor(cellsInOrder, today),
    };
    if (kind === 'internal') internalRows.push(row); else subcoRows.push(row);
  }

  return { months: displayMonths, internalRows, subcoRows, hiringDemand: hiringDemandByMonth(resources, hoursByResMonth, displayMonths) };
}

/** One month of {@link UnallocatedHistory} — see it for why `upcomingUnallocated` is absent. */
export interface UnallocatedHistoryCell {
  month: string;
  state: BenchState;
  agingBucket?: UnallocatedAgingBucket;
  /** Same "absent means unanswerable" rule as {@link BenchCell.unallocatedPct}. */
  unallocatedPct?: number;
  unallocatedDays?: number;
}

/**
 * Per-resource monthly disallocation history — RPT's expandable row (comparison
 * matrix row 51: `2025-03 · disallocato 21 gg · 100%`).
 *
 * `cells` is OLDEST-FIRST, matching `displayMonths` and every other month list in
 * the app (the bench grid, the capacity grid), and carries ONLY the months the
 * resource was genuinely employed in: a month they were not employed is an ABSENT
 * entry, never a 0%/0-day row, because "we did not employ them" and "we employed
 * them and left them idle" are opposite facts.
 *
 * `cells: []` is a legitimate answer (a dummy placeholder, which the bench rollup
 * excludes by design, or anyone employed in none of the window's months) and means
 * NOT TRACKED — never "allocated the whole time". Same rule the availability strip
 * already renders explicitly.
 *
 * A month spent entirely on leave is `{ month, state: 'ABSENT' }` and NOTHING else:
 * no bucket, no percentage, no day count. That is the third distinct shape this
 * list can hold, and the three must stay distinguishable — absent ENTRY ("we did
 * not employ her"), `'ABSENT'` state ("we did, and she could not work"), and a real
 * percentage ("we did, and this much went unfilled").
 *
 * `upcomingUnallocated` is deliberately NOT carried: it is a forward-looking claim
 * about the month AFTER the one it sits on, which is meaningless in a retrospective
 * list and, on the last cell, would describe a month the history does not show.
 */
export interface UnallocatedHistory {
  resourceId: string;
  resourceName: string;
  cells: UnallocatedHistoryCell[];
}

/**
 * The history's cells for ONE resource, derived by running {@link benchRollup}
 * over `input` narrowed to that resource.
 *
 * Reusing `benchRollup` rather than re-deriving the percentage is the point: the
 * history's most recent month and the /bench grid's current-month column are then
 * the SAME computation, so they cannot drift into disagreeing about how idle
 * somebody is. It also inherits the aging buckets and the employment-day gate for
 * free. Narrowing `resources` first keeps the cost proportional to one row instead
 * of the whole org (`hiringDemand` collapses to empty, since a single internal or
 * subco resource contributes none).
 */
export function unallocatedHistoryFor(
  input: BenchRollupInput, resourceId: string, today: string,
): UnallocatedHistoryCell[] {
  const only = input.resources.filter(r => r.id === resourceId);
  if (only.length === 0) return [];
  const roll = benchRollup({ ...input, resources: only }, today);
  const row = [...roll.internalRows, ...roll.subcoRows][0];
  if (row === undefined) return [];
  const cells: UnallocatedHistoryCell[] = [];
  for (const month of input.displayMonths) {
    const cell = row.monthly[month];
    if (cell === undefined) continue; // not employed that month: absent, not zeroed
    // Optional keys are OMITTED rather than set to `undefined`, so this object has
    // the same shape in-process as it does after the JSON round-trip the client
    // actually receives (`JSON.stringify` drops undefined-valued keys). Setting
    // them explicitly would make a `toStrictEqual` test pass against a shape no
    // browser ever sees.
    const out: UnallocatedHistoryCell = { month, state: cell.state };
    if (cell.agingBucket !== undefined) out.agingBucket = cell.agingBucket;
    if (cell.unallocatedPct !== undefined) out.unallocatedPct = cell.unallocatedPct;
    if (cell.unallocatedDays !== undefined) out.unallocatedDays = cell.unallocatedDays;
    cells.push(out);
  }
  return cells;
}

/**
 * Single-month "not fully allocated" snapshot for `/forecast`'s rolling weekly
 * horizon and `/what-if`'s in-memory sandbox — DECOUPLED from `/bench`'s own
 * 6-month display window (spec §9's `/forecast` row: "ripuntato su
 * bench.util.ts... filtrato su monthly[from].state !== 'ALLOCATED'"). Builds
 * the minimal 4-month fetch window (2 look-back + `month` itself + 1
 * look-ahead) `benchRollup` needs for a correct aging bucket / forward signal
 * on that one month, and returns every internal+subco row that is BENCH or
 * PARTIAL there.
 *
 * Typed on `BenchRollupInput` (role required), NOT the plain `RollupInput` —
 * this function delegates to `benchRollup`, which genuinely needs `role` on
 * every resource (it feeds `hiringDemandByMonth`). A synthetic placeholder
 * role would be inert only by accident of what THIS function currently reads
 * (`internalRows`/`subcoRows`, never `hiringDemand`); the moment it or a
 * caller touches hiring demand, a fake role becomes silently wrong data with
 * nothing red to catch it. The honest type says the input requires role,
 * because the delegate does.
 *
 * THE `'ABSENT'` EXCLUSION IS THE WHOLE REASON THE FOURTH STATE IS A STATE (spec
 * §5.1 B12). This predicate is `!== 'ALLOCATED'`, so a fourth value joins it for
 * free — and the result would be a panel headed "available for reallocation"
 * listing people on parental leave. It is the one filter in the codebase that a
 * new state makes WORSE rather than better, which is exactly why the design
 * chose a state over a boolean flag: the flag would have left this line green,
 * unchanged and wrong. Correcting it here fixes all three call sites downstream
 * (`forecast.ts`, and `what-if.ts`'s two scenario counters) at once, none of
 * which this task owns.
 */
export function notFullyAllocatedAt(
  input: Omit<BenchRollupInput, 'months' | 'displayMonths'>,
  month: string,
  today: string,
): BenchRow[] {
  const idx = (m: string) => { const [y, mm] = m.split('-').map(Number); return y * 12 + (mm - 1); };
  const toMonth = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const c = idx(month);
  const months = [c - 2, c - 1, c, c + 1].map(toMonth);
  const roll = benchRollup({ ...input, months, displayMonths: [month] }, today);
  return [...roll.internalRows, ...roll.subcoRows].filter(r => {
    const state = r.monthly[month]?.state;
    return state !== 'ALLOCATED' && state !== 'ABSENT';
  });
}
