/**
 * Negotiated SELL rates (design spec §4). PURE: no I/O, no clock, no Angular.
 *
 * THE SELL PRICE IS NOT A PROPERTY OF THE PERSON. The same profile can be sold
 * at 1200/day to one customer and 1000/day to another, so it cannot live on the
 * resource — it belongs to the (contract-or-project, role) pair. Cost is a
 * different question and is NOT touched by this layer.
 *
 * UNITS — THE ONE THING THIS FILE MUST NOT GET WRONG. A stored
 * `NegotiatedRate.billRate` is EUR per **DAY** (same unit and type as
 * `rate_cards`, see `src/db/schema.ts`), but `referenceBillRate` arrives as EUR
 * per **HOUR**: it comes from `Resource.billRate`, which `withEffectiveRates`
 * (`src/server.ts`) has already divided by the configured hours/day. The only
 * consumer of this function multiplies the result by RAW HOURS, so
 * `sellRateFor` RETURNS EUR PER HOUR ON EVERY PATH: the negotiated day rate is
 * divided by `hoursPerDay` here, and the reference rate is passed through
 * untouched because it is already hourly. Do NOT "simplify" that division away
 * and do not return the stored value raw — a shipped build did exactly that and
 * priced 8 hours at a 1150 €/day override as 9,200 € instead of 1,150 €.
 *
 * PRECEDENCE, first match wins:
 *   1. a rate on THIS PROJECT for this role — but ONLY if the project has no
 *      contract at all, or its contract exists and the hours' date falls
 *      INSIDE that contract's period. An override has no period of its own —
 *      it borrows its project's contract period — because if the contract has
 *      expired, nothing may be invoiced on that project, override or not.
 *      Do not "simplify" this back to an unconditional override: that lets
 *      hours be billed outside the contract, which is exactly what the
 *      validity model exists to prevent;
 *   2. a rate on the project's CONTRACT for this role, but only for hours DATED
 *      INSIDE that contract's period (§4.1 — the contract already carries its own
 *      validity, so none was invented);
 *   3. `referenceBillRate` — today's resolution (personal override -> rate card).
 *
 * Level 3 is the no-regression guarantee: an empty table behaves exactly like the
 * system before this feature.
 *
 * A PERSONAL OVERRIDE NEVER BEATS A NEGOTIATED PRICE. If the customer signed
 * 1000, 1000 is billed even when that person's own rate is higher: the override
 * is a company default, not a sell price. Do not "fix" this by reordering.
 */
export interface NegotiatedRate {
  id: string;
  contractId?: string;
  projectId?: string;
  role: string;
  currency: string;
  billRate: number;
}
export interface SellRateProject { id: string; contractId?: string }
export interface SellRateContract { id: string; startDate: string; endDate?: string }

export const SELL_RATE_BASE_CURRENCY = 'EUR';

/**
 * Fallback working hours/day used ONLY when a caller cannot supply a usable one.
 * Mirrors `getHoursPerDay()`'s own fallback in `src/server.ts` (the `hoursPerDay`
 * setting, 8 when unset/invalid) so a missing setting prices identically on both
 * sides of the wire. This is a CONSTANT, not a lookup: the pure layer still
 * reads no setting and no clock.
 */
export const DEFAULT_HOURS_PER_DAY = 8;

/**
 * A usable €/day -> €/hour divisor: the supplied value when it is finite and
 * strictly positive, else `DEFAULT_HOURS_PER_DAY`. Exported so every caller
 * clamps the configured setting the SAME way instead of each inventing a guard
 * (0 or NaN would otherwise turn a sell price into Infinity or NaN).
 */
export function hoursPerDayOrDefault(hoursPerDay: number | undefined): number {
  return typeof hoursPerDay === 'number' && Number.isFinite(hoursPerDay) && hoursPerDay > 0
    ? hoursPerDay
    : DEFAULT_HOURS_PER_DAY;
}

/** ISO date-string comparison is safe here: both sides are 'YYYY-MM-DD'. */
function withinPeriod(date: string, contract: SellRateContract): boolean {
  if (date < contract.startDate) return false;
  return contract.endDate === undefined || date <= contract.endDate;
}

function usable(rate: NegotiatedRate): boolean {
  return (rate.currency ?? SELL_RATE_BASE_CURRENCY) === SELL_RATE_BASE_CURRENCY
    && typeof rate.billRate === 'number' && Number.isFinite(rate.billRate) && rate.billRate >= 0;
}

/**
 * @returns the sell rate in **EUR PER HOUR** — on every path, including the
 * `referenceBillRate` fallback (which is already hourly) and the two negotiated
 * levels (whose stored €/DAY value is divided by `hoursPerDay` here). `undefined`
 * only when nothing resolved and no reference rate was supplied. The caller
 * multiplies this by raw hours; see the UNITS note on the file's class comment.
 */
export function sellRateFor(args: {
  projectId: string | undefined;
  role: string | undefined;
  /** ISO 'YYYY-MM-DD' of the hours being priced. A VALUE — this layer never reads a clock. */
  date: string;
  /** The resource's effective rate in EUR per HOUR (already divided by hours/day). */
  referenceBillRate: number | undefined;
  /**
   * Working hours in ONE day (`settings.hoursPerDay`) — the €/DAY -> €/HOUR
   * divisor for a negotiated rate. A VALUE, like `date`: this layer never reads
   * a setting. Non-finite / non-positive values fall back to
   * `DEFAULT_HOURS_PER_DAY` via `hoursPerDayOrDefault`.
   */
  hoursPerDay: number;
  rates: readonly NegotiatedRate[];
  projects: readonly SellRateProject[];
  contracts: readonly SellRateContract[];
}): number | undefined {
  const { projectId, role, date, referenceBillRate, hoursPerDay, rates, projects, contracts } = args;
  if (projectId === undefined || role === undefined) return referenceBillRate;
  /** €/day -> €/hour, so both negotiated levels return the reference path's unit. */
  const perHour = (dayRate: number): number => dayRate / hoursPerDayOrDefault(hoursPerDay);

  const contractId = projects.find(p => p.id === projectId)?.contractId;
  const contract = contractId !== undefined ? contracts.find(c => c.id === contractId) : undefined;
  // No contract at all -> nothing to bound the override. A contract that
  // exists -> the override borrows ITS period; an unknown/expired contract
  // means the override does not apply either (see the class comment).
  const projectPeriodOk = contractId === undefined || (contract !== undefined && withinPeriod(date, contract));

  // 1. project override — bounded by the project's own contract period, if any.
  if (projectPeriodOk) {
    const onProject = rates.find(r => r.projectId === projectId && r.role === role && usable(r));
    if (onProject !== undefined) return perHour(onProject.billRate);
  }

  // 2. contract rate, only for hours dated inside the contract's own period.
  if (contract !== undefined && withinPeriod(date, contract)) {
    const onContract = rates.find(r => r.contractId === contractId && r.role === role && usable(r));
    if (onContract !== undefined) return perHour(onContract.billRate);
  }

  // 3. today's behaviour — ALREADY €/hour, so it is returned unconverted. This
  // asymmetry is the point: one unit out, two units in.
  return referenceBillRate;
}
