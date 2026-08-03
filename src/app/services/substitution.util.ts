/**
 * Pure substitution arithmetic (C2).
 *
 * A dummy can be planned beyond 1 FTE (C1); a person cannot — the daily
 * capacity gate (B1) stops them at their contracted hours. So handing a dummy's
 * work to someone is never a bulk move: each day transfers only what that
 * person can still absorb, and the rest stays on the dummy for the next
 * substitution. Partial substitution therefore falls out of the capacity
 * constraint instead of needing a quota field — which is exactly how the RPT
 * manual describes it (§4.2.1: "le ore che vengono decurtate restano da
 * sostituire nel dummy con una eventuale risorsa aggiuntiva").
 *
 * Side-effect free and SSR-safe: no clock, no I/O.
 */
import { lastDayOfMonth } from './calendar.util';

/** Hours are rounded to 2 decimals, as everywhere else money-and-hours are stored. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface SubstitutionPlan {
  /** Hours to move to the target, per ISO date. Days transferring 0 are absent. */
  transfer: Record<string, number>;
  /** Hours that stay on the dummy, per ISO date. Days keeping 0 are absent. */
  remaining: Record<string, number>;
  transferredHours: number;
  remainingHours: number;
}

/**
 * Split a dummy month's per-day hours between what `target` can absorb and what
 * stays behind.
 *
 * `targetDailyCap` is the person's own ceiling (1 FTE — `dailyCapFor('internal', …)`),
 * and `targetBookedByDate` is what they ALREADY hold that day across every
 * assignment, so the room left is `cap - booked`, never negative. A cap that is
 * not usable (0, NaN, negative) transfers nothing: the same convention the
 * allocation gate uses, and refusing to guess is safer than moving hours onto a
 * resource whose limit we do not know.
 */
export function planSubstitution(
  dummyHoursByDate: Readonly<Record<string, number>>,
  targetBookedByDate: Readonly<Record<string, number>>,
  targetDailyCap: number,
): SubstitutionPlan {
  const capUsable = Number.isFinite(targetDailyCap) && targetDailyCap > 0;
  const transfer: Record<string, number> = {};
  const remaining: Record<string, number> = {};
  let transferredHours = 0;
  let remainingHours = 0;

  for (const [date, rawHours] of Object.entries(dummyHoursByDate)) {
    const hours = Number.isFinite(rawHours) ? rawHours : 0;
    if (hours <= 0) continue;

    const booked = Number.isFinite(targetBookedByDate[date]) ? targetBookedByDate[date] : 0;
    const room = capUsable ? Math.max(0, round2(targetDailyCap - booked)) : 0;
    const moved = round2(Math.min(hours, room));
    const left = round2(hours - moved);

    if (moved > 0) { transfer[date] = moved; transferredHours += moved; }
    if (left > 0) { remaining[date] = left; remainingHours += left; }
  }

  return { transfer, remaining, transferredHours: round2(transferredHours), remainingHours: round2(remainingHours) };
}

export interface SubstitutionBooking {
  /** First day of the earliest substituted month. */
  startDate: string;
  /** Last day of the latest substituted month. */
  endDate: string;
  /** Share of the target's capacity over that window, 0..100. */
  allocationPct: number;
}

/**
 * The booking window + `allocationPct` for an assignment a substitution CREATED.
 *
 * `schedule.util` (the legacy weekly-pct timeline) reads an assignment's own
 * `startDate`/`endDate` and falls back to the linked REQUEST's window when either
 * is missing, and defaults an absent `allocationPct` to **100**. Every assignment
 * created through the UI sends an explicit pct; a substitution-created one used to
 * send neither, so a few hours transferred into one month rendered as a FULL-TIME
 * booking spanning the whole request — and `sweepResource` then flagged that
 * booking and the person's real one as conflicting for the entire request window.
 *
 * So the window is the substituted month(s), and the percentage is the transferred
 * hours over the target's capacity across that window — `hours / target`, the same
 * monthly basis `capacity.util` computes FTE on. `capacityByMonth` must cover every
 * month the window SPANS (not just the ones that received hours): the pct is a
 * single constant over the whole window, so its denominator has to be the whole
 * window's capacity or a two-month span with one busy month reads twice as loaded
 * as it is.
 *
 * Returns `undefined` when nothing was transferred — there is no booking to
 * describe, and the caller must leave the assignment's window alone.
 *
 * Side-effect free and SSR-safe: no clock, no I/O.
 */
export function planSubstitutionBooking(
  hoursByMonth: Readonly<Record<string, number>>,
  capacityByMonth: Readonly<Record<string, number>>,
): SubstitutionBooking | undefined {
  const months = Object.entries(hoursByMonth)
    .filter(([, h]) => Number.isFinite(h) && h > 0)
    .map(([m]) => m)
    .sort();
  if (months.length === 0) return undefined;

  const totalHours = months.reduce((s, m) => s + hoursByMonth[m], 0);
  let totalCapacity = 0;
  for (const [, cap] of Object.entries(capacityByMonth)) {
    if (Number.isFinite(cap) && cap > 0) totalCapacity += cap;
  }
  // A window with no measurable capacity falls back to the SAME conservative
  // reading `schedule.util` applies to a missing pct (100), rather than reporting
  // zero: a capacity we cannot measure must not silently hide an over-allocation.
  const pct = totalCapacity > 0
    ? Math.min(100, Math.max(0, round2((totalHours / totalCapacity) * 100)))
    : 100;

  return { startDate: `${months[0]}-01`, endDate: lastDayOfMonth(months[months.length - 1]), allocationPct: pct };
}

export interface GiveBackPlan {
  /** Hours to hand back to the dummy, per ISO date. Dates returning 0 are absent. */
  giveBack: Record<string, number>;
  /**
   * The target's REPLACEMENT hours, per ISO date, for the dates she loses hours
   * on — `0` means "delete that day row". Only ever populated on a rejection: on
   * an approval what she still holds IS the approved allocation, so this map is
   * empty and her rows must not be touched. A date absent from it keeps whatever
   * it holds.
   */
  targetHours: Record<string, number>;
  giveBackHours: number;
  /**
   * Hours that could NOT be handed back because the dummy's own daily ceiling is
   * already full on that date. Never silently dropped: the caller logs it.
   */
  shortfallHours: number;
}

/**
 * Split a decided substitution back into "goes back to the dummy" and "stays
 * with the target", from the PER-DAY maps the transfer recorded
 * (`assignmentMonths.replacedDays` + `replacedBaselineDays`).
 *
 * ### Why TWO maps, and what `replacedBaselineDays` is for
 *
 * A person's month legitimately mixes hours of her own with hours on loan FROM
 * THE SAME DATE ON THE SAME ASSIGNMENT — a substitution onto a month she already
 * had hours in DEMOTES it, it does not replace it (the endpoint reports that as
 * `demotedExistingWork`). `targetHeldByDate[date]` is therefore the TOTAL on that
 * date, and after the fact it is **not decomposable** into "her own" and "on
 * loan". Charging all of it against the loan destroys booked hours:
 *
 *   3h of her own on X + 5h lent (held 8). The approver trims X back to 3 —
 *   removing exactly the loan — and approves. `moved - min(moved, held)` returns
 *   5 - min(5, 3) = **2**, so 3h of the placeholder's booked demand simply cease
 *   to exist: no shortfall, no warning, no audit. The mirror case on a rejection
 *   subtracts the full 5 from her 5 and deletes the 3h that were always hers.
 *
 * The split cannot be reconstructed later, so the TRANSFER records it:
 * `replacedBaselineDays[date]` is what she already held on that date on that
 * assignment IMMEDIATELY BEFORE the transfer. Both maps cover the same dates, are
 * written in the same patch and are cleared in the same patch — they cannot drift.
 * Everything below is then derived from ONE quantity:
 *
 *   `loanRemaining = max(0, held - baseline)` — how much of the loan is still
 *   standing on her row. Hours below the baseline are hers and are untouchable.
 *
 * ### The two branches
 *   - **Rejected** — she never took the work, so `replacedDays[date]` goes back
 *     for every date IN THE MAP, even when the approver trimmed first: those hours
 *     were the dummy's and a rejection undoes the substitution wholesale (§5.6).
 *     Her side, however, only ever drops by `min(returned, loanRemaining)`, so her
 *     own baseline hours can never be deleted along with the loan. A date the
 *     substitution never touched is not in the map, so it is never touched here —
 *     her work on other days is untouchable BY CONSTRUCTION.
 *   - **Approved** — per date, `min(moved, loanRemaining)` is what she actually
 *     kept of the loan and stays hers; the rest of that date's transfer goes back.
 *     The cap is STRUCTURAL, not a separate check: a date where she kept the whole
 *     loan (or added hours of her own on top) returns nothing, because the extra is
 *     a new allocation, not part of the substitution.
 *
 * `dummyBookedByDate` is what the DUMMY RESOURCE already holds that date across
 * ALL its assignments (the same aggregation the daily-capacity write gate uses),
 * and `dummyDailyCap` is its own multi-FTE ceiling, so the give-back can never
 * push a date past it.
 *
 * A cap that is not usable (0, NaN, negative) hands back EVERYTHING —
 * deliberately the INVERSE of `planSubstitution`'s convention. Refusing to move
 * hours onto a resource whose limit we don't know is the safe side when BOOKING
 * new work; here the hours were already the dummy's, so refusing would destroy
 * booked demand instead of restoring it.
 *
 * Side-effect free and SSR-safe: no clock, no I/O.
 */
export function planGiveBack(
  replacedDays: Readonly<Record<string, number>>,
  /** What she ALREADY held on each of those dates, on that assignment, before the
   *  transfer. Absent/0 means the whole of `held` is loan-origin. */
  replacedBaselineDays: Readonly<Record<string, number>>,
  targetHeldByDate: Readonly<Record<string, number>>,
  decided: 'Approved' | 'Rejected',
  dummyBookedByDate: Readonly<Record<string, number>>,
  dummyDailyCap: number,
): GiveBackPlan {
  const capped = Number.isFinite(dummyDailyCap) && dummyDailyCap > 0;
  const giveBack: Record<string, number> = {};
  const targetHours: Record<string, number> = {};
  let giveBackHours = 0;
  let shortfallHours = 0;

  for (const [date, rawMoved] of Object.entries(replacedDays)) {
    const moved = Number.isFinite(rawMoved) ? rawMoved : 0;
    if (moved <= 0) continue;

    const rawHeld = targetHeldByDate[date];
    const held = Number.isFinite(rawHeld) && rawHeld > 0 ? rawHeld : 0;
    const rawBaseline = replacedBaselineDays[date];
    const baseline = Number.isFinite(rawBaseline) && rawBaseline > 0 ? rawBaseline : 0;
    // The part of the loan STILL STANDING on her row. Everything at or below the
    // baseline was hers before the transfer and is not the substitution's to move.
    const loanRemaining = Math.max(0, round2(held - baseline));

    // Rejected: the whole transfer. Approved: only the part of the loan she no
    // longer holds — 0 when she kept it all.
    const wanted = decided === 'Rejected' ? moved : round2(moved - Math.min(moved, loanRemaining));
    if (wanted <= 0) continue;

    const room = capped ? Math.max(0, round2(dummyDailyCap - (Number.isFinite(dummyBookedByDate[date]) ? dummyBookedByDate[date] : 0))) : wanted;
    const back = round2(Math.min(wanted, room));
    if (back < wanted) shortfallHours = round2(shortfallHours + (wanted - back));
    if (back <= 0) continue;

    giveBack[date] = back;
    giveBackHours = round2(giveBackHours + back);
    // Conservation, bounded BELOW by her baseline: she gives up what the dummy
    // actually receives (never the unclamped figure — an hour must not be destroyed
    // to satisfy a ceiling) but never more of that date than is still on loan.
    if (decided === 'Rejected') {
      const lose = round2(Math.min(back, loanRemaining));
      targetHours[date] = Math.max(0, round2(held - lose));
    }
  }

  return { giveBack, targetHours, giveBackHours, shortfallHours };
}
