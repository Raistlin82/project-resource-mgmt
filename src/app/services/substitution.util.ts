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
 * with the target", from the PER-DAY map of what the substitution actually moved
 * (`assignmentMonths.replacedDays`).
 *
 * Working from the recorded map — rather than from a total plus a proportional
 * guess — is what makes this exact:
 *   - **Rejected** — she never took the work, so `replacedDays[date]` goes back
 *     for every date IN THE MAP, and her row for that date drops by exactly that
 *     much. A date the substitution never touched is never touched here, so her
 *     own work on other days of the same month is untouchable BY CONSTRUCTION.
 *     When she holds LESS than the map says (the approver trimmed and then the
 *     month was rejected), the dummy is still made whole: those hours were the
 *     dummy's, and a rejection undoes the substitution wholesale.
 *   - **Approved** — per date, `min(moved, held)` is still attributable to the
 *     substitution and stays hers; the rest of that date's transfer goes back.
 *     The cap is therefore STRUCTURAL, not a separate check: a date where she
 *     kept everything (or added hours of her own) returns nothing, because the
 *     extra is a new allocation, not part of the substitution.
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
    // Rejected: the whole transfer. Approved: only the part that is no longer on
    // her month — `moved - min(moved, held)`, which is 0 when she kept it all.
    const wanted = decided === 'Rejected' ? moved : round2(moved - Math.min(moved, held));
    if (wanted <= 0) continue;

    const room = capped ? Math.max(0, round2(dummyDailyCap - (Number.isFinite(dummyBookedByDate[date]) ? dummyBookedByDate[date] : 0))) : wanted;
    const back = round2(Math.min(wanted, room));
    if (back < wanted) shortfallHours = round2(shortfallHours + (wanted - back));
    if (back <= 0) continue;

    giveBack[date] = back;
    giveBackHours = round2(giveBackHours + back);
    // Conservation: she loses EXACTLY what the dummy receives, never the
    // unclamped figure — an hour must never be destroyed to satisfy a ceiling.
    if (decided === 'Rejected') targetHours[date] = Math.max(0, round2(held - back));
  }

  return { giveBack, targetHours, giveBackHours, shortfallHours };
}
