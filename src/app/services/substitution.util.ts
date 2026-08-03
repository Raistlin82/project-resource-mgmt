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
