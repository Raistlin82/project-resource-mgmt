/**
 * Negotiated SELL rates (design spec §4). PURE: no I/O, no clock, no Angular.
 *
 * THE SELL PRICE IS NOT A PROPERTY OF THE PERSON. The same profile can be sold
 * at 1200/day to one customer and 1000/day to another, so it cannot live on the
 * resource — it belongs to the (contract-or-project, role) pair. Cost is a
 * different question and is NOT touched by this layer.
 *
 * PRECEDENCE, first match wins:
 *   1. a rate on THIS PROJECT for this role;
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

/** ISO date-string comparison is safe here: both sides are 'YYYY-MM-DD'. */
function withinPeriod(date: string, contract: SellRateContract): boolean {
  if (date < contract.startDate) return false;
  return contract.endDate === undefined || date <= contract.endDate;
}

function usable(rate: NegotiatedRate): boolean {
  return (rate.currency ?? SELL_RATE_BASE_CURRENCY) === SELL_RATE_BASE_CURRENCY
    && typeof rate.billRate === 'number' && Number.isFinite(rate.billRate) && rate.billRate >= 0;
}

export function sellRateFor(args: {
  projectId: string | undefined;
  role: string | undefined;
  /** ISO 'YYYY-MM-DD' of the hours being priced. A VALUE — this layer never reads a clock. */
  date: string;
  referenceBillRate: number | undefined;
  rates: readonly NegotiatedRate[];
  projects: readonly SellRateProject[];
  contracts: readonly SellRateContract[];
}): number | undefined {
  const { projectId, role, date, referenceBillRate, rates, projects, contracts } = args;
  if (projectId === undefined || role === undefined) return referenceBillRate;

  // 1. project override — no date limit of its own; it is scoped by the project.
  const onProject = rates.find(r => r.projectId === projectId && r.role === role && usable(r));
  if (onProject !== undefined) return onProject.billRate;

  // 2. contract rate, only for hours dated inside the contract's own period.
  const contractId = projects.find(p => p.id === projectId)?.contractId;
  if (contractId !== undefined) {
    const contract = contracts.find(c => c.id === contractId);
    if (contract !== undefined && withinPeriod(date, contract)) {
      const onContract = rates.find(r => r.contractId === contractId && r.role === role && usable(r));
      if (onContract !== undefined) return onContract.billRate;
    }
  }

  // 3. today's behaviour.
  return referenceBillRate;
}
