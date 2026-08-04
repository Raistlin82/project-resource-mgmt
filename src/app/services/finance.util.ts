import { Assignment, Resource, ResourceRequest, Order, OrderLine, FinancialItem, TimeEntry, BillingPlanItem, Contract, Customer, Milestone, ChangeRequest, Project, FxRate, NegotiatedRate, BASE_CURRENCY } from './api.service';
import { sellRateFor } from './sell-rate.util';

/** All raw data needed to compute financial rollups. */
export interface FinanceData {
  requests: ResourceRequest[];
  assignments: Assignment[];
  resources: Resource[];
  orders: Order[];
  orderLines: OrderLine[];
  financials: FinancialItem[];
  timeEntries?: TimeEntry[];
  billingItems?: BillingPlanItem[];
  contracts?: Contract[];
  customers?: Customer[];
  milestones?: Milestone[];
  /** Approved change requests adjust the effective project budget (see effectiveBudgetForProject). */
  changeRequests?: ChangeRequest[];
  /** Optional project master data; used only to label portfolio-level alert rows. */
  projects?: Project[];
  /**
   * Optional negotiated sell rates (design spec §4/§6). Consumed ONLY by the
   * as-incurred (TimeAndMaterials/Capped/Expense) branch of recognitionSchedule,
   * via sellRateFor, alongside `projects`/`contracts` for the project-override /
   * contract-period precedence. Absent or empty behaves exactly as before this
   * feature existed (falls through to each resource's reference billRate) — that
   * is the no-regression guarantee, not an incidental default.
   */
  negotiatedRates?: NegotiatedRate[];
  /**
   * Optional FX rate table (base-currency value of 1 unit of each currency).
   * When supplied, monetary amounts that carry a currency (order lines via their
   * order currency, billing items via their own currency) are normalised to
   * BASE_CURRENCY before being summed, so rollups that span currencies are
   * comparable. When ABSENT, every amount is summed as-is (no conversion) and
   * all helpers reduce exactly to their single-currency behaviour. See
   * convertToBase for the conversion semantics.
   */
  fxRates?: FxRate[];
}

export interface ProjectFinancials {
  revenue: number;       // committed customer-order revenue imputed to the project
  invoiced: number;      // revenue from Invoiced/Paid customer orders
  backlog: number;       // revenue not yet invoiced
  plannedLaborCost: number; // Σ booked assignment hours × resource costRate
  actualLaborCost: number;  // Σ approved time-entry hours × resource costRate
  laborCost: number;     // actual labor when available, otherwise planned fallback
  externalCost: number;  // Σ purchase-order lines imputed to the project
  actualCost: number;    // laborCost + externalCost
  budget: number;        // effective budget: Σ financial-plan budget + Σ approved CR impactBudget
  margin: number;        // revenue − actualCost
  marginPct: number;     // margin / revenue (0 when no revenue)
  burnPct: number;       // actualCost / effective budget (0 when no budget)
  etc: number;           // estimated cost to complete
  eac: number;           // estimate at completion (actualCost + ETC; CR-independent)
  varianceAtCompletion: number; // effective budget − EAC
}

const finite = (v: number) => Number.isFinite(v) ? v : 0;
const sum = (xs: number[]) => xs.reduce((a, b) => a + finite(b), 0);

// --- Currency conversion (multi-currency rollups) ----------------------------
//
// All monetary rollups normalise to a single reporting/base currency
// (BASE_CURRENCY = 'EUR'). An FxRate carries `rateToBase`: the base-currency
// value of 1 unit of that currency (so the base currency itself has
// rateToBase = 1). To express an amount given in `currency` in terms of `base`:
//
//     amountInBase = amount * (rateToBase[currency] / rateToBase[base])
//
// Conversion is deliberately CONSERVATIVE and total:
//   • A missing/zero/non-finite rate is treated as 1 (a no-op), so an unknown
//     currency contributes its raw amount rather than being dropped or turned
//     into NaN. The same item never silently disappears from a rollup.
//   • A non-finite amount contributes 0.
// When the rate table is empty/undefined the result therefore equals the input
// amount — which is what keeps per-project / per-item rollups byte-for-byte
// identical to the pre-FX behaviour.

/** Look up the base-currency value of 1 unit of `currency`; 1 when unknown/invalid. */
function rateToBaseOf(currency: string | undefined, rates: readonly FxRate[] | undefined): number {
  if (!currency || !rates) return 1;
  const found = rates.find(r => r.currency === currency);
  const rate = found?.rateToBase;
  return Number.isFinite(rate) && (rate as number) > 0 ? (rate as number) : 1;
}

/**
 * Convert `amount` (expressed in `currency`) into `base` using `rates`.
 *
 * Semantics: amount × (rateToBase(currency) / rateToBase(base)). The base
 * currency defaults to BASE_CURRENCY ('EUR'). A missing or invalid rate is
 * treated as 1 (no-op) so the function never returns NaN and never drops the
 * amount; a non-finite amount contributes 0. With no `rates` supplied this is
 * an identity on `amount`, preserving single-currency behaviour exactly.
 */
export function convertToBase(
  amount: number,
  currency: string | undefined,
  rates: readonly FxRate[] | undefined,
  base: string = BASE_CURRENCY,
): number {
  const value = finite(amount);
  const from = rateToBaseOf(currency, rates);
  const to = rateToBaseOf(base, rates);
  // `to` is guaranteed > 0 (rateToBaseOf never returns 0), so this is finite.
  return finite(value * (from / to));
}

export function plannedLaborCostForProject(projectId: string, d: FinanceData): number {
  const reqIds = new Set(d.requests.filter(r => r.projectId === projectId).map(r => r.id));
  return sum(
    d.assignments
      .filter(a => reqIds.has(a.requestId))
      .map(a => a.assignedHours * (d.resources.find(r => r.id === a.resourceId)?.costRate ?? 0)),
  );
}

export function actualLaborCostForProject(projectId: string, d: FinanceData): number {
  const approved = (d.timeEntries ?? []).filter(t => t.projectId === projectId && t.status === 'Approved');
  return sum(approved.map(t => t.hours * (d.resources.find(r => r.id === t.resourceId)?.costRate ?? 0)));
}

export function laborCostForProject(projectId: string, d: FinanceData): number {
  const actual = actualLaborCostForProject(projectId, d);
  return actual > 0 ? actual : plannedLaborCostForProject(projectId, d);
}

/**
 * Σ of order-line amounts imputed to a project, restricted to orders of the
 * given type/status. Each line's amount is denominated in its parent ORDER's
 * currency (lines carry no currency of their own); when d.fxRates is present
 * the amount is converted to base before summing, otherwise it is summed as-is
 * (single-currency / pre-FX behaviour). Lines whose order is missing contribute
 * their raw amount (unknown currency => no-op conversion).
 */
function lineSum(projectId: string, d: FinanceData, orderType: Order['type'], statuses?: Order['status'][]): number {
  const orderCurrency = new Map(d.orders.map(o => [o.id, o.currency]));
  const orderIds = new Set(
    d.orders
      .filter(o => o.type === orderType && (!statuses || statuses.includes(o.status)))
      .map(o => o.id),
  );
  return sum(
    d.orderLines
      .filter(l => l.projectId === projectId && orderIds.has(l.orderId))
      .map(l => convertToBase(l.amount, orderCurrency.get(l.orderId), d.fxRates)),
  );
}

export function customerRevenueForProject(projectId: string, d: FinanceData): number {
  return lineSum(projectId, d, 'Customer');
}

export function invoicedRevenueForProject(projectId: string, d: FinanceData): number {
  return lineSum(projectId, d, 'Customer', ['Invoiced', 'Paid']);
}

export function externalCostForProject(projectId: string, d: FinanceData): number {
  return lineSum(projectId, d, 'Purchase');
}

export function budgetForProject(projectId: string, d: FinanceData): number {
  return sum(d.financials.filter(f => f.projectId === projectId).map(f => f.budget));
}

/** Σ impactBudget of APPROVED change requests for a project (0 when none / changeRequests absent). */
export function approvedChangeBudgetForProject(projectId: string, d: FinanceData): number {
  return sum(
    (d.changeRequests ?? [])
      .filter(c => c.projectId === projectId && c.status === 'Approved')
      .map(c => c.impactBudget),
  );
}

/**
 * Effective (CR-adjusted) budget: the base financial-plan budget plus the sum of
 * approved change-request budget impacts for the project. Identical to the base
 * budget when no change requests are supplied or none are approved.
 */
export function effectiveBudgetForProject(projectId: string, d: FinanceData): number {
  return budgetForProject(projectId, d) + approvedChangeBudgetForProject(projectId, d);
}

export function computeProjectFinancials(projectId: string, d: FinanceData): ProjectFinancials {
  const revenue = customerRevenueForProject(projectId, d);
  const invoiced = invoicedRevenueForProject(projectId, d);
  const plannedLaborCost = plannedLaborCostForProject(projectId, d);
  const actualLaborCost = actualLaborCostForProject(projectId, d);
  const laborCost = laborCostForProject(projectId, d);
  const externalCost = externalCostForProject(projectId, d);
  const actualCost = laborCost + externalCost;
  // CR-adjusted budget drives budget/burn/VAC; EAC is independent (actualCost + ETC).
  const budget = effectiveBudgetForProject(projectId, d);
  const margin = revenue - actualCost;
  const etc = Math.max(0, plannedLaborCost - actualLaborCost);
  const eac = actualCost + etc;
  return {
    revenue,
    invoiced,
    backlog: revenue - invoiced,
    plannedLaborCost,
    actualLaborCost,
    laborCost,
    externalCost,
    actualCost,
    budget,
    margin,
    marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
    burnPct: budget > 0 ? (actualCost / budget) * 100 : 0,
    etc,
    eac,
    varianceAtCompletion: budget - eac,
  };
}

/**
 * Company-wide billability: billable value (hours × billRate) vs cost (hours × costRate).
 *
 * DELIBERATELY stays on the resource's reference `billRate`, never on a
 * negotiated sell rate: this figure has no project (it rolls up a resource's
 * assignments across every project it's on) and answers "what is our time
 * worth", not "what do we invoice a customer" — the negotiated price is a
 * property of a (contract-or-project, role) pair, not of the person. Do not
 * "fix" this to use sellRateFor; that would be conflating two different
 * questions, not correcting an inconsistency.
 */
export function resourceBillability(resourceId: string, d: FinanceData): { cost: number; billable: number; hours: number } {
  const res = d.resources.find(r => r.id === resourceId);
  const costRate = res?.costRate ?? 0;
  const billRate = res?.billRate ?? 0;
  const hours = sum(d.assignments.filter(a => a.resourceId === resourceId).map(a => a.assignedHours));
  return { hours, cost: hours * costRate, billable: hours * billRate };
}

// --- Billing-plan rollups (revenue recognition, A/R hygiene) -----------------

/** Statuses on a BillingPlanItem that represent money actually billed to the customer. */
const BILLED_STATUSES: ReadonlySet<BillingPlanItem['status']> = new Set<BillingPlanItem['status']>(['Invoiced', 'Paid']);

/** Items belonging to a project (optionally filtered). Items with no projectId are ignored for project rollups. */
function billingItemsForProject(projectId: string, d: FinanceData): BillingPlanItem[] {
  return (d.billingItems ?? []).filter(i => i.projectId === projectId);
}

/** Whole-number day delta between two ISO date strings (floored, never negative). 0 when either is unparseable. */
function daysBetween(fromIso: string | undefined, toIso: string | undefined): number {
  if (!fromIso || !toIso) return 0;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

/**
 * Σ amount of billing items already Invoiced or Paid for a project. Each item's
 * amount is in its own currency; converted to base when d.fxRates is present
 * (no-op otherwise, so single-currency rollups are unchanged).
 */
export function billedToDate(projectId: string, d: FinanceData): number {
  return sum(
    billingItemsForProject(projectId, d)
      .filter(i => BILLED_STATUSES.has(i.status))
      .map(i => convertToBase(i.amount, i.currency, d.fxRates)),
  );
}

/**
 * Customer revenue recognized to date for a project, via percentage-of-completion / EAC.
 * Progress items recognize amount × progressPct/100. Advance (down payment) recognizes nothing
 * on its own — it is billed ahead of delivery and surfaces as deferred revenue. Every other type
 * recognizes its full amount once realized (Ready/Invoiced/Paid); Planned/Blocked recognize nothing.
 */
export function recognizedRevenue(projectId: string, d: FinanceData): number {
  return sum(
    billingItemsForProject(projectId, d).map(i => {
      // Each item's recognized amount is in its own currency; convert to base
      // (no-op when d.fxRates is absent) so mixed-currency projects reconcile.
      if (i.type === 'Progress') {
        const pct = Number.isFinite(i.progressPct) ? (i.progressPct as number) : 0;
        return convertToBase(i.amount * (pct / 100), i.currency, d.fxRates);
      }
      if (i.type === 'Advance') return 0;
      return BILLED_STATUSES.has(i.status) || i.status === 'Ready'
        ? convertToBase(i.amount, i.currency, d.fxRates)
        : 0;
    }),
  );
}

/** Unbilled / work-in-progress: revenue recognized (POC/EAC) but not yet billed. Floored at 0. */
export function unbilledWip(projectId: string, d: FinanceData): number {
  return Math.max(0, finite(recognizedRevenue(projectId, d)) - finite(billedToDate(projectId, d)));
}

/** Deferred revenue: amounts billed (Invoiced/Paid) in advance of what has been recognized. Floored at 0. */
export function deferredRevenue(projectId: string, d: FinanceData): number {
  return Math.max(0, finite(billedToDate(projectId, d)) - finite(recognizedRevenue(projectId, d)));
}

/** Σ retention (amount × retentionPct/100) held back on items not yet Paid (converted to base when d.fxRates is present). */
export function retentionHeld(projectId: string, d: FinanceData): number {
  return sum(
    billingItemsForProject(projectId, d)
      .filter(i => i.status !== 'Paid')
      .map(i => {
        const pct = Number.isFinite(i.retentionPct) ? (i.retentionPct as number) : 0;
        return convertToBase(i.amount * (pct / 100), i.currency, d.fxRates);
      }),
  );
}

/** Σ tax (amount × taxRatePct/100) on items that have been Invoiced or Paid (converted to base when d.fxRates is present). */
export function taxTotal(projectId: string, d: FinanceData): number {
  return sum(
    billingItemsForProject(projectId, d)
      .filter(i => BILLED_STATUSES.has(i.status))
      .map(i => {
        const pct = Number.isFinite(i.taxRatePct) ? (i.taxRatePct as number) : 0;
        return convertToBase(i.amount * (pct / 100), i.currency, d.fxRates);
      }),
  );
}

/**
 * Simple DSO (days sales outstanding) proxy for a project, as of `asOfIso` (defaults to now).
 * For each invoiced item: if Paid, days from issued→paid; otherwise days from issued→asOf.
 * Items never issued, or not Invoiced/Paid, are excluded. Returns 0 when there is nothing to measure.
 */
export function dsoProxy(projectId: string, d: FinanceData, asOfIso?: string): number {
  const asOf = asOfIso ?? new Date().toISOString();
  const days = billingItemsForProject(projectId, d)
    .filter(i => BILLED_STATUSES.has(i.status) && !!i.issuedDate)
    .map(i => (i.status === 'Paid' ? daysBetween(i.issuedDate, i.paidDate) : daysBetween(i.issuedDate, asOf)));
  if (days.length === 0) return 0;
  return finite(sum(days) / days.length);
}

// --- A/R aging ---------------------------------------------------------------
//
// An item is OUTSTANDING when it has been issued to the customer but not yet
// collected — i.e. status === 'Invoiced' (Paid items are already collected,
// everything earlier than Invoiced has not been billed). Outstanding items are
// bucketed by how many days they are overdue relative to their due date.

/** A/R aging bucket keys, ordered oldest-debt-last. */
export const AR_AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type ArAgingBucket = (typeof AR_AGING_BUCKETS)[number];

/** Add a whole number of days to an ISO date, returning a YYYY-MM-DD string. Empty string when unparseable. */
function addDaysIso(iso: string | undefined, days: number): string {
  if (!iso) return '';
  const base = Date.parse(iso);
  if (!Number.isFinite(base)) return '';
  const shifted = base + finite(days) * 86_400_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * Effective due date for a billing item: the explicit `dueDate` when present,
 * otherwise `issuedDate` + `paymentTermsDays` (terms default to 0). Returns
 * undefined when no due date can be derived (no dueDate and no issuedDate).
 */
export function effectiveDueDate(item: BillingPlanItem): string | undefined {
  if (item.dueDate) return item.dueDate;
  if (!item.issuedDate) return undefined;
  const terms = Number.isFinite(item.paymentTermsDays) ? (item.paymentTermsDays as number) : 0;
  return addDaysIso(item.issuedDate, terms) || undefined;
}

/** True when an item is outstanding (issued to the customer, not yet collected). */
export function isOutstanding(item: BillingPlanItem): boolean {
  return item.status === 'Invoiced';
}

/** Whole days an item is overdue as of `today` (0 when not yet due or no due date). */
export function daysOverdue(item: BillingPlanItem, today: string): number {
  return daysBetween(effectiveDueDate(item), today);
}

/** Map a days-overdue count onto an aging bucket. */
export function bucketForDaysOverdue(days: number): ArAgingBucket {
  const d = finite(days);
  if (d <= 30) return '0-30';
  if (d <= 60) return '31-60';
  if (d <= 90) return '61-90';
  return '90+';
}

export interface ArAgingBucketTotal {
  count: number;
  amount: number;
}

export interface ArAgingResult {
  /** Per-bucket count + outstanding amount. Every bucket key is always present. */
  buckets: Record<ArAgingBucket, ArAgingBucketTotal>;
  /** Σ amount of all outstanding (Invoiced) items. */
  totalOutstanding: number;
  /** Σ amount of outstanding items that are at least 1 day past due. */
  overdue: number;
}

function emptyBuckets(): Record<ArAgingBucket, ArAgingBucketTotal> {
  return {
    '0-30': { count: 0, amount: 0 },
    '31-60': { count: 0, amount: 0 },
    '61-90': { count: 0, amount: 0 },
    '90+': { count: 0, amount: 0 },
  };
}

/**
 * Age a set of billing items as of `today`. Only outstanding (Invoiced) items
 * are considered; each is placed in a bucket by days overdue from its due date.
 * `totalOutstanding` is the full outstanding balance; `overdue` is the portion
 * past due (days overdue > 0, i.e. everything outside the leading not-yet-due
 * part of the 0-30 bucket).
 *
 * Bucketed amounts are denominated in each item's own currency. Pass `rates` to
 * normalise every amount to base before bucketing so a cross-currency book is
 * comparable; omit it and amounts are summed as-is (single-currency behaviour).
 */
export function arAging(items: readonly BillingPlanItem[], today: string, rates?: readonly FxRate[]): ArAgingResult {
  const buckets = emptyBuckets();
  let totalOutstanding = 0;
  let overdue = 0;
  for (const item of items) {
    if (!isOutstanding(item)) continue;
    const amount = convertToBase(item.amount, item.currency, rates);
    const days = daysOverdue(item, today);
    const bucket = buckets[bucketForDaysOverdue(days)];
    bucket.count += 1;
    bucket.amount += amount;
    totalOutstanding += amount;
    if (days > 0) overdue += amount;
  }
  return { buckets, totalOutstanding, overdue };
}

export interface ArAgingCustomerRow extends ArAgingResult {
  customerId: string;
  customerName: string;
}

/**
 * A/R aging grouped by customer. Billing items are joined to their contract
 * (via `contractId`) and then to the customer (via `Contract.customerId`).
 * Items whose contract or customer cannot be resolved are grouped under a
 * synthetic 'unknown' customer so no outstanding balance is silently dropped.
 * Rows are returned sorted by descending outstanding balance.
 *
 * Pass `rates` to normalise per-item amounts to base before aging/sorting so
 * customers billed in different currencies sort on a like-for-like balance;
 * omit it for single-currency (pre-FX) behaviour.
 */
export function arAgingByCustomer(
  items: readonly BillingPlanItem[],
  contracts: readonly Contract[],
  customers: readonly Customer[],
  today: string,
  rates?: readonly FxRate[],
): ArAgingCustomerRow[] {
  const contractToCustomer = new Map(contracts.map(c => [c.id, c.customerId]));
  const customerName = new Map(customers.map(c => [c.id, c.name]));

  const byCustomer = new Map<string, BillingPlanItem[]>();
  for (const item of items) {
    if (!isOutstanding(item)) continue;
    const customerId = contractToCustomer.get(item.contractId) ?? 'unknown';
    const list = byCustomer.get(customerId);
    if (list) list.push(item);
    else byCustomer.set(customerId, [item]);
  }

  return [...byCustomer.entries()]
    .map(([customerId, group]) => ({
      customerId,
      customerName: customerName.get(customerId) ?? (customerId === 'unknown' ? 'Unknown' : customerId),
      ...arAging(group, today, rates),
    }))
    .sort((a, b) => b.totalOutstanding - a.totalOutstanding);
}

/**
 * Refined DSO over a set of outstanding billing items as of `today`:
 * amount-weighted average age (issued→today) of the outstanding balance.
 * Larger invoices and older invoices pull the number up, which tracks the
 * collection-risk intuition better than the unweighted issued→asOf proxy.
 * Returns 0 when there is no outstanding, dated balance.
 *
 * Pass `rates` to weight by base-normalised amounts (so larger invoices in any
 * currency are compared like-for-like); omit it for single-currency behaviour.
 * The result is a duration in days and is unaffected by a uniform currency
 * rescaling — it only matters when the book mixes currencies.
 */
export function dsoOutstanding(items: readonly BillingPlanItem[], today: string, rates?: readonly FxRate[]): number {
  let weighted = 0;
  let total = 0;
  for (const item of items) {
    if (!isOutstanding(item) || !item.issuedDate) continue;
    const amount = convertToBase(item.amount, item.currency, rates);
    weighted += amount * daysBetween(item.issuedDate, today);
    total += amount;
  }
  return total > 0 ? finite(weighted / total) : 0;
}

// --- Dated revenue recognition (ASC 606 / IFRS 15, simplified) ---------------
//
// Recognition is spread across calendar months (YYYY-MM) per the performance
// obligation pattern, deterministically and without reference to "now":
//   • Fixed Price (Milestone / Progress)  -> percentage-of-completion (POC)
//   • Recurring                            -> straight-line over the periods
//   • TimeAndMaterials / Capped / Expense  -> as-incurred (approved time × billRate)
//   • Advance                              -> deferred; recognized as work progresses
//   • CreditNote                           -> recognized (negative) in its period
// Output rows cover exactly the requested `periods`; amounts that fall outside
// the window are clamped to the first/last period so cumulative + deferred stay
// reconcilable end-to-end.

export interface RecognitionPeriod {
  period: string;      // YYYY-MM
  recognized: number;  // revenue recognized in this period
  cumulative: number;  // running Σ recognized through this period
  deferred: number;    // Σ billed-as-Advance to date − cumulative recognized (floored at 0)
}

/** YYYY-MM for an ISO date, or '' when unparseable. */
function periodOf(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 7);
}

/** Generate the inclusive list of YYYY-MM periods between two YYYY-MM bounds. */
function periodRange(fromYm: string, toYm: string): string[] {
  const parse = (ym: string): [number, number] | null => {
    const [y, m] = ym.split('-').map(Number);
    return Number.isFinite(y) && Number.isFinite(m) ? [y, m] : null;
  };
  const a = parse(fromYm);
  const b = parse(toYm);
  if (!a || !b) return [];
  const out: string[] = [];
  let [y, m] = a;
  const [ey, em] = b;
  // guard against inverted/huge ranges
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 1200) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    guard += 1;
  }
  return out;
}

/**
 * Clamp a period to one that ACTUALLY EXISTS in `periods`. For a contiguous
 * monthly window this is the plain [first,last] clamp; for a NON-contiguous
 * explicit list it additionally snaps an in-range-but-absent period DOWN to the
 * nearest earlier listed period, so its amount is never silently dropped by the
 * by-period index lookup (it lands in the closest prior recognised bucket).
 */
function clampPeriod(p: string, periods: string[]): string {
  if (periods.length === 0) return '';
  const first = periods[0];
  const last = periods[periods.length - 1];
  if (!p || p < first) return first;
  if (p > last) return last;
  // In range: if p is itself a listed period, keep it; otherwise snap to the
  // nearest earlier listed period (periods is ascending).
  let snapped = first;
  for (const candidate of periods) {
    if (candidate === p) return p;
    if (candidate <= p) snapped = candidate;
    else break;
  }
  return snapped;
}

/** Recognized amount for a single item under its obligation pattern (period-agnostic total). */
function itemRecognizedTotal(item: BillingPlanItem): number {
  switch (item.type) {
    case 'Progress': {
      const pct = Number.isFinite(item.progressPct) ? (item.progressPct as number) : 0;
      return finite(item.amount) * (pct / 100);
    }
    case 'Advance':
      // recognized via work progress, never on its own line
      return 0;
    default:
      return BILLED_STATUSES.has(item.status) || item.status === 'Ready' ? finite(item.amount) : 0;
  }
}

/**
 * The single period in which a non-recurring item's recognition lands. Prefers
 * the most decision-relevant available date: issued → paid → milestone date →
 * expected → due. Recurring items are handled separately (straight-line).
 */
function recognitionPeriodFor(item: BillingPlanItem, d: FinanceData): string {
  if (item.type === 'Milestone' && item.milestoneId) {
    const ms = (d.milestones ?? []).find(m => m.id === item.milestoneId);
    const p = periodOf(ms?.date);
    if (p) return p;
  }
  return (
    periodOf(item.issuedDate) ||
    periodOf(item.paidDate) ||
    periodOf(item.expectedDate) ||
    periodOf(item.dueDate)
  );
}

/** Number of months a recurrence spans. */
function recurrenceMonths(rec: BillingPlanItem['recurrence']): number {
  switch (rec) {
    case 'Quarterly': return 3;
    case 'Annual': return 12;
    default: return 1; // Monthly / undefined
  }
}

interface ScheduleOpts {
  /** Filter billing items to a single project. */
  projectId?: string;
  /** Filter billing items to a single contract. */
  contractId?: string;
}

/**
 * Build a dated revenue-recognition schedule across the supplied `periods`
 * (an explicit list of YYYY-MM, or a [from,to] pair which is expanded).
 *
 * Per-pattern placement:
 *   • Recurring: straight-line — amount split evenly across the recurrence
 *     window starting at its anchor period, with each slice clamped into range.
 *   • TimeAndMaterials / Capped / Expense: as-incurred — approved time entries
 *     (hours × resource billRate) booked in the entry's month, Capped to capAmount.
 *   • Everything else (Milestone, Progress, CreditNote, ...): the item's
 *     recognized total lands in its single recognition period.
 *   • Advance: never recognized directly; it inflates deferred revenue until
 *     cumulative recognition catches up.
 */
export function recognitionSchedule(
  data: FinanceData,
  periods: readonly string[] | { from: string; to: string },
  opts: ScheduleOpts = {},
): RecognitionPeriod[] {
  const periodList = Array.isArray(periods)
    ? [...periods]
    : periodRange((periods as { from: string; to: string }).from, (periods as { from: string; to: string }).to);
  if (periodList.length === 0) return [];

  const index = new Map(periodList.map((p, i) => [p, i]));
  const recognizedByPeriod = new Array<number>(periodList.length).fill(0);

  const matches = (i: BillingPlanItem) =>
    (opts.projectId === undefined || i.projectId === opts.projectId) &&
    (opts.contractId === undefined || i.contractId === opts.contractId);

  const items = (data.billingItems ?? []).filter(matches);

  const addAt = (period: string, amount: number) => {
    const i = index.get(clampPeriod(period, periodList));
    if (i !== undefined) recognizedByPeriod[i] += finite(amount);
  };

  // Track advances billed-to-date per period for deferral roll-forward.
  const advanceBilledByPeriod = new Array<number>(periodList.length).fill(0);

  for (const item of items) {
    if (item.type === 'Advance') {
      if (BILLED_STATUSES.has(item.status)) {
        const p = clampPeriod(recognitionPeriodFor(item, data), periodList);
        const i = index.get(p);
        if (i !== undefined) advanceBilledByPeriod[i] += finite(item.amount);
      }
      continue; // not recognized directly
    }

    if (item.type === 'Recurring') {
      const total = itemRecognizedTotal(item);
      if (total === 0) continue;
      const months = recurrenceMonths(item.recurrence);
      const slice = total / months;
      const anchor = clampPeriod(recognitionPeriodFor(item, data), periodList);
      const anchorIdx = index.get(anchor) ?? 0;
      for (let k = 0; k < months; k++) {
        const idx = Math.min(anchorIdx + k, periodList.length - 1); // clamp tail into window
        recognizedByPeriod[idx] += slice;
      }
      continue;
    }

    if (item.type === 'TimeAndMaterials' || item.type === 'Capped' || item.type === 'Expense') {
      // As-incurred: approved time entries for the obligation × billRate. Scope to
      // the item's project when set; otherwise to every project on the item's
      // contract — never company-wide (an undated/cross-contract leak would let one
      // contract-level item recognize hours logged on unrelated contracts). A
      // contract with no resolvable projects recognizes nothing.
      const projectIds = item.projectId
        ? new Set([item.projectId])
        : new Set((data.projects ?? []).filter(p => p.contractId === item.contractId).map(p => p.id));
      const entries = (data.timeEntries ?? [])
        .filter(t => t.status === 'Approved' && projectIds.has(t.projectId))
        // Fill the cap chronologically (earliest hours first) so the dated schedule
        // is independent of time-entry array order.
        .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
      let booked = 0;
      const cap = Number.isFinite(item.capAmount) ? (item.capAmount as number) : Infinity;
      for (const t of entries) {
        // Price this entry at the negotiated SELL rate (design spec §4/§6): a
        // project override on t.projectId, else the project's contract rate
        // (only for hours dated inside that contract's period), else the
        // resource's own reference billRate — today's resolution, and the
        // no-regression guarantee when negotiatedRates is absent/empty.
        const resource = data.resources.find(r => r.id === t.resourceId);
        const rate = sellRateFor({
          projectId: t.projectId,
          role: resource?.role,
          date: t.date,
          referenceBillRate: resource?.billRate,
          rates: data.negotiatedRates ?? [],
          projects: data.projects ?? [],
          contracts: data.contracts ?? [],
        }) ?? 0;
        let value = finite(t.hours) * rate;
        if (booked + value > cap) value = Math.max(0, cap - booked);
        if (value <= 0) continue;
        booked += value;
        addAt(periodOf(t.date), value);
      }
      continue;
    }

    // Milestone / Progress / CreditNote / fallback: single-period recognition.
    const total = itemRecognizedTotal(item);
    if (total !== 0) addAt(recognitionPeriodFor(item, data), total);
  }

  // Roll forward cumulative recognition + deferred (advances billed but unearned).
  const rows: RecognitionPeriod[] = [];
  let cumulative = 0;
  let advanceBilledCum = 0;
  for (let i = 0; i < periodList.length; i++) {
    cumulative += recognizedByPeriod[i];
    advanceBilledCum += advanceBilledByPeriod[i];
    rows.push({
      period: periodList[i],
      recognized: finite(recognizedByPeriod[i]),
      cumulative: finite(cumulative),
      deferred: Math.max(0, finite(advanceBilledCum) - finite(cumulative)),
    });
  }
  return rows;
}

// --- Margin drivers ----------------------------------------------------------
//
// Decomposes project margin into its three cost drivers so a P&L view can show
// where the money goes. Cost dimensions are mutually exclusive:
//   • laborCost    — people cost (actual approved time, else planned bookings)
//   • externalCost — purchase-order lines imputed to the project
//   • expenseCost  — other actual spend tracked on the financial plan
// Margin is revenue minus the three drivers; marginPct is margin / revenue.

/** Σ actual spend recorded on the project's financial-plan items (non-labor, non-PO expenses). */
export function expenseCostForProject(projectId: string, d: FinanceData): number {
  return sum(d.financials.filter(f => f.projectId === projectId).map(f => f.actual));
}

export interface MarginDrivers {
  revenue: number;
  laborCost: number;
  externalCost: number;
  expenseCost: number;
  margin: number;     // revenue − (labor + external + expense)
  marginPct: number;  // margin / revenue (0 when no revenue)
}

/** Break a project's margin into revenue and its labor / external / expense cost drivers. */
export function marginDrivers(projectId: string, d: FinanceData): MarginDrivers {
  const revenue = finite(customerRevenueForProject(projectId, d));
  const laborCost = finite(laborCostForProject(projectId, d));
  const externalCost = finite(externalCostForProject(projectId, d));
  const expenseCost = finite(expenseCostForProject(projectId, d));
  const margin = revenue - (laborCost + externalCost + expenseCost);
  return {
    revenue,
    laborCost,
    externalCost,
    expenseCost,
    margin,
    marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
  };
}

// --- Project / portfolio alerts ----------------------------------------------
//
// Threshold-based health flags driven off computeProjectFinancials. A project
// is flagged when margin falls below target, when burn exceeds the warn level,
// or when EAC overruns the (CR-adjusted) budget. `items` carries human-readable
// reasons for whatever flags fired.

export interface AlertThresholds {
  /** Margin % at or below which marginBelowTarget fires. */
  marginTargetPct: number;
  /** Burn % at or above which burnOver fires. */
  burnWarnPct: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = { marginTargetPct: 15, burnWarnPct: 90 };

export interface ProjectAlerts {
  marginBelowTarget: boolean;
  burnOver: boolean;
  eacOverBudget: boolean;
  items: string[];
}

/** True when any flag on the result is raised. */
export function hasAnyAlert(a: ProjectAlerts): boolean {
  return a.marginBelowTarget || a.burnOver || a.eacOverBudget;
}

/**
 * Evaluate health thresholds for a single project.
 *   • marginBelowTarget: there is revenue and marginPct ≤ marginTargetPct
 *   • burnOver:          there is a budget and burnPct ≥ burnWarnPct
 *   • eacOverBudget:     there is a budget and EAC > effective budget
 *     (equivalently varianceAtCompletion < 0)
 * Projects with no revenue never trip the margin flag, and projects with no
 * budget never trip the burn / EAC flags — there is nothing to measure against.
 */
export function projectAlerts(
  projectId: string,
  d: FinanceData,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): ProjectAlerts {
  const f = computeProjectFinancials(projectId, d);
  const marginBelowTarget = f.revenue > 0 && f.marginPct <= thresholds.marginTargetPct;
  const burnOver = f.budget > 0 && f.burnPct >= thresholds.burnWarnPct;
  const eacOverBudget = f.budget > 0 && f.eac > f.budget;

  const items: string[] = [];
  if (marginBelowTarget) {
    items.push(`Margin ${f.marginPct.toFixed(1)}% is at or below target ${thresholds.marginTargetPct}%`);
  }
  if (burnOver) {
    items.push(`Burn ${f.burnPct.toFixed(1)}% is at or above warning ${thresholds.burnWarnPct}%`);
  }
  if (eacOverBudget) {
    items.push(`EAC ${f.eac.toFixed(0)} exceeds budget ${f.budget.toFixed(0)} (VAC ${f.varianceAtCompletion.toFixed(0)})`);
  }
  return { marginBelowTarget, burnOver, eacOverBudget, items };
}

export interface PortfolioAlertRow {
  projectId: string;
  name?: string;
  alerts: ProjectAlerts;
}

/**
 * Run projectAlerts across every project referenced by the finance data and
 * return only those with at least one flag raised. The project universe is the
 * union of project ids seen in financial plans, order lines, requests, billing
 * items and change requests, so a project shows up even if it only has, say, an
 * over-budget purchase order. Rows are labelled from `d.projects` when present.
 */
export function portfolioAlerts(
  d: FinanceData,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): PortfolioAlertRow[] {
  const projectIds = new Set<string>();
  for (const f of d.financials) projectIds.add(f.projectId);
  for (const l of d.orderLines) projectIds.add(l.projectId);
  for (const r of d.requests) { if (r.projectId) projectIds.add(r.projectId); }
  for (const i of d.billingItems ?? []) { if (i.projectId) projectIds.add(i.projectId); }
  for (const c of d.changeRequests ?? []) projectIds.add(c.projectId);

  const name = new Map((d.projects ?? []).map(p => [p.id, p.name]));

  return [...projectIds]
    .sort()
    .map(projectId => ({ projectId, name: name.get(projectId), alerts: projectAlerts(projectId, d, thresholds) }))
    .filter(row => hasAnyAlert(row.alerts));
}

// --- Portfolio totals in base currency ---------------------------------------
//
// Convenience aggregate for a multi-currency portfolio: every monetary input is
// normalised to BASE_CURRENCY before summing, so the figures are directly
// comparable across contracts/orders denominated in different currencies.
// Order-line amounts are converted through their parent ORDER's currency;
// billing-item amounts through the item's own currency. With no fxRates present
// these are plain (single-currency) sums.

export interface PortfolioTotals {
  /** Reporting currency these totals are expressed in (BASE_CURRENCY). */
  baseCurrency: string;
  /** Σ customer order-line revenue (all statuses), in base. */
  customerRevenue: number;
  /** Σ customer order-line revenue on Invoiced/Paid orders, in base. */
  invoicedRevenue: number;
  /** customerRevenue − invoicedRevenue (revenue not yet invoiced), in base. */
  backlog: number;
  /** Σ purchase order-line amounts (external/subcontract cost), in base. */
  externalCost: number;
  /** Σ billing-item amounts Invoiced/Paid, in base. */
  billed: number;
  /** Σ recognized revenue (POC/realized) across billing items, in base. */
  recognized: number;
  /** Σ retention held (items not yet Paid), in base. */
  retentionHeld: number;
}

/**
 * Roll the whole portfolio up into BASE_CURRENCY in a single pass over orders +
 * billing items. Project attribution is irrelevant here — these are company-wide
 * totals — so amounts are taken straight from the source rows and converted via
 * convertToBase (no-op when d.fxRates is absent, i.e. identical to summing the
 * raw amounts). `recognized` reuses the same per-item recognition rule as
 * recognizedRevenue (Progress → POC; Advance → 0; otherwise full when realized).
 */
export function portfolioTotalsInBase(d: FinanceData): PortfolioTotals {
  const orderById = new Map(d.orders.map(o => [o.id, o] as const));

  let customerRevenue = 0;
  let invoicedRevenue = 0;
  let externalCost = 0;
  for (const line of d.orderLines) {
    const order = orderById.get(line.orderId);
    if (!order) continue; // orphan line: no order => no currency/type context
    const amountInBase = convertToBase(line.amount, order.currency, d.fxRates);
    if (order.type === 'Customer') {
      customerRevenue += amountInBase;
      if (order.status === 'Invoiced' || order.status === 'Paid') invoicedRevenue += amountInBase;
    } else if (order.type === 'Purchase') {
      externalCost += amountInBase;
    }
  }

  let billed = 0;
  let recognized = 0;
  let retention = 0;
  for (const i of d.billingItems ?? []) {
    if (BILLED_STATUSES.has(i.status)) billed += convertToBase(i.amount, i.currency, d.fxRates);

    if (i.type === 'Progress') {
      const pct = Number.isFinite(i.progressPct) ? (i.progressPct as number) : 0;
      recognized += convertToBase(i.amount * (pct / 100), i.currency, d.fxRates);
    } else if (i.type !== 'Advance' && (BILLED_STATUSES.has(i.status) || i.status === 'Ready')) {
      recognized += convertToBase(i.amount, i.currency, d.fxRates);
    }

    if (i.status !== 'Paid') {
      const pct = Number.isFinite(i.retentionPct) ? (i.retentionPct as number) : 0;
      retention += convertToBase(i.amount * (pct / 100), i.currency, d.fxRates);
    }
  }

  return {
    baseCurrency: BASE_CURRENCY,
    customerRevenue: finite(customerRevenue),
    invoicedRevenue: finite(invoicedRevenue),
    backlog: finite(customerRevenue - invoicedRevenue),
    externalCost: finite(externalCost),
    billed: finite(billed),
    recognized: finite(recognized),
    retentionHeld: finite(retention),
  };
}

// --- Revenue-recognition JOURNAL preview (#10) -------------------------------
//
// Turns the dated recognitionSchedule into a double-entry journal so a finance
// reviewer can see the postings BEFORE they are booked. The schedule already
// resolves the period in which revenue is earned per obligation pattern (POC,
// straight-line, as-incurred, …); this layer expresses each period's movement
// as balanced Dr/Cr lines. The accounting model (simplified, ASC 606 / IFRS 15
// shaped) is:
//
//   • Revenue earned in a period         -> Dr Unbilled AR   / Cr Revenue
//     (POC / Milestone / Recurring slice / T&M-as-incurred / Expense pass-through;
//      a CreditNote earns negative revenue, i.e. Dr Revenue / Cr Unbilled AR — it
//      is the same line with a negative `recognized`, so signs flip naturally.)
//   • Advance (down payment) billed/paid -> Dr Cash          / Cr Deferred Revenue
//   • As revenue is earned against a held -> Dr Deferred Rev. / Cr Unbilled AR
//     advance, the prepayment is amortised   (capped at the deferred balance and
//     at the revenue earned this period, so deferred never goes negative)
//
// Because every JournalLine pair within an entry is equal-and-opposite, the
// whole preview is balanced by construction: Σ debit === Σ credit. Expense
// pass-through "with markup" is carried by the schedule's as-incurred billRate
// (billRate already embeds margin over costRate), so the recognised revenue here
// reconciles exactly with recognitionSchedule / recognizedRevenue.

/** Canonical ledger account names used by the rev-rec journal preview. */
export const JOURNAL_ACCOUNTS = {
  unbilledAr: 'Unbilled AR',
  revenue: 'Revenue',
  cash: 'Cash/AR',
  deferredRevenue: 'Deferred Revenue',
} as const;

export interface JournalLine {
  account: string;
  /** Debit amount (>= 0). Exactly one of debit/credit is non-zero on a line. */
  debit: number;
  /** Credit amount (>= 0). */
  credit: number;
}

export interface JournalEntry {
  /** Period the posting lands in (YYYY-MM, from the recognition schedule). */
  date: string;
  memo: string;
  lines: JournalLine[];
}

/**
 * Emit a debit and an equal credit as two lines. A NEGATIVE amount (e.g. a
 * CreditNote's negative revenue) is normalised by swapping the accounts so both
 * line amounts stay non-negative while preserving the economic direction.
 */
function balancedPair(debitAccount: string, creditAccount: string, amount: number): JournalLine[] {
  const a = finite(amount);
  if (a >= 0) {
    return [
      { account: debitAccount, debit: a, credit: 0 },
      { account: creditAccount, debit: 0, credit: a },
    ];
  }
  const abs = -a;
  return [
    { account: creditAccount, debit: abs, credit: 0 },
    { account: debitAccount, debit: 0, credit: abs },
  ];
}

/**
 * Per-period advance amounts billed (Invoiced/Paid) within the schedule window,
 * using the SAME placement rule as recognitionSchedule (recognitionPeriodFor,
 * clamped into range) and the SAME raw-amount basis (the schedule itself is
 * currency-naive — it sums item amounts as-is — so the journal stays exactly
 * reconciled with it). Returned aligned to `periodList`.
 */
function advanceBilledByPeriod(data: FinanceData, periodList: readonly string[], opts: ScheduleOpts): number[] {
  const out = new Array<number>(periodList.length).fill(0);
  const index = new Map(periodList.map((p, i) => [p, i]));
  const items = (data.billingItems ?? []).filter(
    i =>
      i.type === 'Advance' &&
      BILLED_STATUSES.has(i.status) &&
      (opts.projectId === undefined || i.projectId === opts.projectId) &&
      (opts.contractId === undefined || i.contractId === opts.contractId),
  );
  for (const item of items) {
    const p = clampPeriod(recognitionPeriodFor(item, data), [...periodList]);
    const i = index.get(p);
    if (i !== undefined) out[i] += finite(item.amount);
  }
  return out;
}

/**
 * Build a balanced double-entry journal PREVIEW for the rev-rec schedule over
 * `periods` (an explicit YYYY-MM list, or a {from,to} pair). One entry per
 * period that has movement; periods with no recognition and no advance activity
 * are omitted. Amounts use the SAME basis as recognitionSchedule — which sums
 * billing-item amounts as-is — so the per-period revenue here reconciles exactly
 * with recognitionSchedule run over the same window/filters. (Per the source's
 * design, the dated schedule is currency-naive; FX normalisation lives in the
 * snapshot rollups such as recognizedRevenue / portfolioTotalsInBase.)
 *
 * Guarantee: Σ of all debits === Σ of all credits (see journalIsBalanced).
 */
export function recognitionJournal(
  data: FinanceData,
  periods: readonly string[] | { from: string; to: string },
  opts: ScheduleOpts = {},
): JournalEntry[] {
  const rows = recognitionSchedule(data, periods, opts);
  if (rows.length === 0) return [];
  const advances = advanceBilledByPeriod(data, rows.map(r => r.period), opts);

  const entries: JournalEntry[] = [];
  let deferredBalance = 0; // unearned advance carried forward

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const recognized = finite(row.recognized);
    const advanceBilled = finite(advances[i]);
    const lines: JournalLine[] = [];

    // 1) Advance billed this period: cash in, deferred (unearned) revenue up.
    if (advanceBilled !== 0) {
      lines.push(...balancedPair(JOURNAL_ACCOUNTS.cash, JOURNAL_ACCOUNTS.deferredRevenue, advanceBilled));
      deferredBalance += advanceBilled;
    }

    // 2) Revenue earned this period: unbilled AR up, revenue up (signs flip for
    //    a credit note via balancedPair).
    if (recognized !== 0) {
      lines.push(...balancedPair(JOURNAL_ACCOUNTS.unbilledAr, JOURNAL_ACCOUNTS.revenue, recognized));
    }

    // 3) Amortise held advance against revenue earned this period (only positive
    //    recognition draws down a prepayment; capped so deferred never < 0).
    if (recognized > 0 && deferredBalance > 0) {
      const amortised = Math.min(recognized, deferredBalance);
      lines.push(...balancedPair(JOURNAL_ACCOUNTS.deferredRevenue, JOURNAL_ACCOUNTS.unbilledAr, amortised));
      deferredBalance -= amortised;
    }

    if (lines.length > 0) {
      entries.push({
        date: row.period,
        memo: `Revenue recognition ${row.period}`,
        lines,
      });
    }
  }
  return entries;
}

/** Σ debit and Σ credit across a journal, plus whether they balance (within ε). */
export function journalTotals(entries: readonly JournalEntry[]): { debit: number; credit: number; balanced: boolean } {
  let debit = 0;
  let credit = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      debit += finite(l.debit);
      credit += finite(l.credit);
    }
  }
  return { debit: finite(debit), credit: finite(credit), balanced: Math.abs(debit - credit) < 1e-6 };
}

/** True when Σ debit === Σ credit across the whole journal (within floating-point ε). */
export function journalIsBalanced(entries: readonly JournalEntry[]): boolean {
  return journalTotals(entries).balanced;
}

// --- Realization & productivity ----------------------------------------------
//
// Realization measures how much of the standard ("rack rate") bill value of
// delivered effort is actually turning into revenue — the classic services lever
// where discounts, write-offs, fixed-price overruns and unbilled WIP erode the
// theoretical value of hours worked. Revenue-per-FTE is a headline productivity
// metric (revenue divided by people, however "people" is measured).
//
//   standardBillValue = Σ approved hours × resource billRate   (the rate card)
//   realizationPct    = recognised (earned) revenue / standardBillValue × 100
//   revenuePerFte     = revenue / FTE  (FTE = headcount, or capacity-derived)

export interface RealizationMetrics {
  /** Revenue used as the numerator (recognised revenue for the project). */
  revenue: number;
  /** Σ approved time-entry hours for the project. */
  hours: number;
  /** Σ approved hours × resource billRate (rate-card value of the effort). */
  standardBillValue: number;
  /** revenue / standardBillValue × 100 (0 when there is no standard value). */
  realizationPct: number;
  /** Distinct resources that logged approved time on the project. */
  headcount: number;
  /**
   * Full-time-equivalents implied by approved hours over `hoursPerFte`
   * (0 when hoursPerFte <= 0). Lets revenue-per-FTE use a delivery-effort FTE
   * rather than a raw headcount when a period basis is supplied.
   */
  fte: number;
  /** revenue / headcount (0 when no headcount). */
  revenuePerHead: number;
  /** revenue / fte (falls back to revenue/headcount when no hours basis given). */
  revenuePerFte: number;
}

/**
 * Realization and productivity for a project. `revenue` defaults to recognised
 * revenue (POC/realised) — the value actually earned — which is the right
 * numerator for "how much of the rate-card did we realise". Pass a different
 * basis (e.g. billedToDate) via `revenueOverride` if a cash/billed view is
 * wanted. `hoursPerFte` (e.g. 160/month, 1800/year) converts approved hours into
 * an FTE denominator; omit it and revenue-per-FTE falls back to revenue-per-head.
 */
export function realizationMetrics(
  projectId: string,
  d: FinanceData,
  opts: { hoursPerFte?: number; revenueOverride?: number } = {},
): RealizationMetrics {
  const approved = (d.timeEntries ?? []).filter(t => t.projectId === projectId && t.status === 'Approved');
  const hours = sum(approved.map(t => finite(t.hours)));
  const standardBillValue = sum(
    approved.map(t => finite(t.hours) * (d.resources.find(r => r.id === t.resourceId)?.billRate ?? 0)),
  );
  const headcount = new Set(approved.map(t => t.resourceId)).size;
  const revenue = finite(opts.revenueOverride ?? recognizedRevenue(projectId, d));

  const hoursPerFte = finite(opts.hoursPerFte ?? 0);
  const fte = hoursPerFte > 0 ? hours / hoursPerFte : 0;

  const revenuePerHead = headcount > 0 ? revenue / headcount : 0;
  const revenuePerFte = fte > 0 ? revenue / fte : revenuePerHead;

  return {
    revenue,
    hours,
    standardBillValue: finite(standardBillValue),
    realizationPct: standardBillValue > 0 ? finite((revenue / standardBillValue) * 100) : 0,
    headcount,
    fte: finite(fte),
    revenuePerHead: finite(revenuePerHead),
    revenuePerFte: finite(revenuePerFte),
  };
}

// --- Customer profitability & concentration ----------------------------------
//
// Rolls project-level financials up to the CUSTOMER by walking
// project -> contract -> customer (Project.contractId -> Contract.customerId).
// Projects whose customer cannot be resolved are grouped under a synthetic
// 'unknown' customer so no revenue/cost is dropped. Concentration then measures
// how lopsided the customer revenue base is (single-customer dependency risk).

export interface CustomerProfitabilityRow {
  customerId: string;
  customerName: string;
  revenue: number;
  cost: number;       // actualCost (labor + external) across the customer's projects
  margin: number;     // revenue − cost
  marginPct: number;  // margin / revenue × 100 (0 when no revenue)
  projectIds: string[];
}

/** Resolve the universe of project ids referenced anywhere in the finance data. */
function allProjectIds(d: FinanceData): string[] {
  const ids = new Set<string>();
  for (const f of d.financials) ids.add(f.projectId);
  for (const l of d.orderLines) ids.add(l.projectId);
  for (const r of d.requests) { if (r.projectId) ids.add(r.projectId); }
  for (const i of d.billingItems ?? []) { if (i.projectId) ids.add(i.projectId); }
  for (const c of d.changeRequests ?? []) ids.add(c.projectId);
  return [...ids];
}

/**
 * Per-customer revenue / cost / margin across every project attributable to the
 * customer. Revenue and cost reuse computeProjectFinancials (so FX, POC, planned
 * vs actual labor all behave identically). Projects with no resolvable customer
 * land under 'unknown'. Rows are sorted by descending revenue.
 */
export function customerProfitability(d: FinanceData): CustomerProfitabilityRow[] {
  const projectToContract = new Map((d.projects ?? []).map(p => [p.id, p.contractId]));
  const contractToCustomer = new Map((d.contracts ?? []).map(c => [c.id, c.customerId]));
  const customerName = new Map((d.customers ?? []).map(c => [c.id, c.name]));

  const acc = new Map<string, { revenue: number; cost: number; projectIds: string[] }>();
  for (const projectId of allProjectIds(d)) {
    const contractId = projectToContract.get(projectId);
    const customerId = (contractId && contractToCustomer.get(contractId)) || 'unknown';
    const f = computeProjectFinancials(projectId, d);
    const entry = acc.get(customerId) ?? { revenue: 0, cost: 0, projectIds: [] };
    entry.revenue += finite(f.revenue);
    entry.cost += finite(f.actualCost);
    entry.projectIds.push(projectId);
    acc.set(customerId, entry);
  }

  return [...acc.entries()]
    .map(([customerId, e]) => {
      const margin = e.revenue - e.cost;
      return {
        customerId,
        customerName: customerName.get(customerId) ?? (customerId === 'unknown' ? 'Unknown' : customerId),
        revenue: finite(e.revenue),
        cost: finite(e.cost),
        margin: finite(margin),
        marginPct: e.revenue > 0 ? finite((margin / e.revenue) * 100) : 0,
        projectIds: e.projectIds.sort(),
      };
    })
    .sort((a, b) => b.revenue - a.revenue);
}

export interface CustomerConcentration {
  /** Σ revenue across all customers (base currency when fxRates present). */
  totalRevenue: number;
  /** Number of customers with non-zero revenue. */
  customerCount: number;
  /** Customer id with the largest revenue (undefined when nothing to measure). */
  topCustomerId?: string;
  topCustomerName?: string;
  /** Largest customer's revenue share of the total, 0-100 (0 when no revenue). */
  topCustomerSharePct: number;
  /** Combined share of the top-3 customers, 0-100. */
  top3SharePct: number;
  /**
   * Herfindahl-Hirschman Index of revenue shares, on a 0-10000 scale (Σ share²
   * with shares in percent). 10000 = a single customer (100%²); lower = more
   * diversified. 0 when there is no revenue.
   */
  hhi: number;
}

/**
 * Revenue-concentration risk across customers. Shares are computed on POSITIVE
 * customer revenue only (a customer net-negative from credit notes contributes 0
 * to concentration rather than a nonsensical negative share). With a single
 * paying customer the top share and HHI are both maxed (100% / 10000).
 */
export function customerConcentration(d: FinanceData): CustomerConcentration {
  const rows = customerProfitability(d)
    .map(r => ({ ...r, revenue: Math.max(0, finite(r.revenue)) }))
    .filter(r => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);

  const totalRevenue = sum(rows.map(r => r.revenue));
  if (totalRevenue <= 0 || rows.length === 0) {
    return { totalRevenue: 0, customerCount: 0, topCustomerSharePct: 0, top3SharePct: 0, hhi: 0 };
  }

  const shares = rows.map(r => (r.revenue / totalRevenue) * 100);
  const hhi = sum(shares.map(s => s * s));
  const top3SharePct = sum(shares.slice(0, 3));

  return {
    totalRevenue: finite(totalRevenue),
    customerCount: rows.length,
    topCustomerId: rows[0].customerId,
    topCustomerName: rows[0].customerName,
    topCustomerSharePct: finite(shares[0]),
    top3SharePct: finite(top3SharePct),
    hhi: finite(hhi),
  };
}

// --- Margin-compression alerts -----------------------------------------------
//
// Flags projects (and customers) whose profitability is thin or eroding. Two
// independent triggers, each graded:
//   • marginPct at/below a target  -> the further below, the more severe
//   • bill-vs-cost spread thin     -> (revenue − cost) / revenue, i.e. the same
//     gross-margin ratio; a project barely clearing cost is fragile even if it
//     technically meets a low target.
// Severity escalates with how far below target the margin sits.

export type AlertSeverity = 'none' | 'low' | 'medium' | 'high';

export interface MarginCompressionConfig {
  /** Margin % at or below which a project is flagged (default 15%). */
  marginTargetPct: number;
  /** Gross spread % below which the bill-vs-cost spread is "thin" (default 10%). */
  thinSpreadPct: number;
  /** Margin gap (target − actual, in pts) at/above which severity is 'high' (default 15). */
  highGapPts: number;
  /** Margin gap at/above which severity is 'medium' (default 7). */
  mediumGapPts: number;
}

export const DEFAULT_MARGIN_COMPRESSION_CONFIG: MarginCompressionConfig = {
  marginTargetPct: 15,
  thinSpreadPct: 10,
  highGapPts: 15,
  mediumGapPts: 7,
};

export interface MarginCompressionAlert {
  scope: 'project' | 'customer';
  id: string;
  name?: string;
  revenue: number;
  cost: number;
  marginPct: number;
  /** target − marginPct in points; positive means below target. */
  gapPts: number;
  belowTarget: boolean;
  thinSpread: boolean;
  severity: AlertSeverity;
  reasons: string[];
}

/** Grade severity from how many points margin sits below target (and thin-spread). */
function gradeSeverity(gapPts: number, thinSpread: boolean, cfg: MarginCompressionConfig): AlertSeverity {
  if (gapPts >= cfg.highGapPts) return 'high';
  if (gapPts >= cfg.mediumGapPts) return 'medium';
  if (gapPts > 0 || thinSpread) return 'low';
  return 'none';
}

function evaluateCompression(
  scope: 'project' | 'customer',
  id: string,
  name: string | undefined,
  revenue: number,
  cost: number,
  marginPct: number,
  cfg: MarginCompressionConfig,
): MarginCompressionAlert | null {
  // No revenue => nothing to compress (consistent with projectAlerts).
  if (revenue <= 0) return null;
  const spreadPct = ((revenue - cost) / revenue) * 100;
  const gapPts = cfg.marginTargetPct - marginPct;
  const belowTarget = marginPct <= cfg.marginTargetPct;
  const thinSpread = spreadPct < cfg.thinSpreadPct;
  if (!belowTarget && !thinSpread) return null;

  const reasons: string[] = [];
  if (belowTarget) reasons.push(`Margin ${marginPct.toFixed(1)}% is at or below target ${cfg.marginTargetPct}%`);
  if (thinSpread) reasons.push(`Bill-vs-cost spread ${spreadPct.toFixed(1)}% is thin (< ${cfg.thinSpreadPct}%)`);

  return {
    scope,
    id,
    name,
    revenue: finite(revenue),
    cost: finite(cost),
    marginPct: finite(marginPct),
    gapPts: finite(gapPts),
    belowTarget,
    thinSpread,
    severity: gradeSeverity(gapPts, thinSpread, cfg),
    reasons,
  };
}

/**
 * Scan projects and/or customers for margin compression. By default both scopes
 * are evaluated; pass `scopes` to restrict. Project rows are labelled from
 * d.projects, customer rows from d.customers. Results are sorted most-severe
 * first (high→low), then by largest margin gap, so the worst offenders surface.
 */
export function marginCompressionAlerts(
  d: FinanceData,
  config: Partial<MarginCompressionConfig> = {},
  scopes: readonly ('project' | 'customer')[] = ['project', 'customer'],
): MarginCompressionAlert[] {
  const cfg: MarginCompressionConfig = { ...DEFAULT_MARGIN_COMPRESSION_CONFIG, ...config };
  const projectName = new Map((d.projects ?? []).map(p => [p.id, p.name]));
  const out: MarginCompressionAlert[] = [];

  if (scopes.includes('project')) {
    for (const projectId of allProjectIds(d).sort()) {
      const f = computeProjectFinancials(projectId, d);
      const alert = evaluateCompression('project', projectId, projectName.get(projectId), f.revenue, f.actualCost, f.marginPct, cfg);
      if (alert) out.push(alert);
    }
  }

  if (scopes.includes('customer')) {
    for (const row of customerProfitability(d)) {
      const alert = evaluateCompression('customer', row.customerId, row.customerName, row.revenue, row.cost, row.marginPct, cfg);
      if (alert) out.push(alert);
    }
  }

  const rank: Record<AlertSeverity, number> = { high: 3, medium: 2, low: 1, none: 0 };
  return out.sort((a, b) => rank[b.severity] - rank[a.severity] || b.gapPts - a.gapPts);
}

// --- Real period deltas (#15 support) ----------------------------------------
//
// Trend helpers that NEVER fabricate a prior value. periodDelta computes the
// change between a current and a previous reading; when the previous value is
// genuinely unknown (null) it returns a delta of null and trend 'flat' is NOT
// implied — callers should HIDE the trend indicator entirely. The companion
// derivers compute a prior-period figure only from dated source rows; when the
// requested prior window has no data to compute from, they return null so the
// distinction between "no change" (0) and "no prior data" (null) is preserved.

export type TrendDirection = 'up' | 'down' | 'flat';

export interface PeriodDelta {
  current: number;
  /** Previous reading, or null when not derivable. */
  previous: number | null;
  /** current − previous, or null when previous is null. */
  delta: number | null;
  /** Percentage change vs previous, or null when previous is null/0. */
  deltaPct: number | null;
  /** Direction of change, or null when previous is null (caller should hide). */
  direction: TrendDirection | null;
}

/**
 * Compare a current reading against a previous one WITHOUT inventing data. When
 * `previous` is null (no prior period available) every derived field is null and
 * `direction` is null — the caller must render "no trend" rather than a flat or
 * fabricated arrow. `epsilon` (default 0) is the dead-band within which a change
 * counts as 'flat'. deltaPct is null when previous is 0 (undefined growth).
 */
export function periodDelta(current: number, previous: number | null, epsilon = 0): PeriodDelta {
  const cur = finite(current);
  if (previous === null || previous === undefined || !Number.isFinite(previous)) {
    return { current: cur, previous: null, delta: null, deltaPct: null, direction: null };
  }
  const prev = previous;
  const delta = cur - prev;
  const eps = Math.abs(finite(epsilon));
  const direction: TrendDirection = delta > eps ? 'up' : delta < -eps ? 'down' : 'flat';
  return {
    current: cur,
    previous: prev,
    delta: finite(delta),
    deltaPct: prev !== 0 ? finite((delta / Math.abs(prev)) * 100) : null,
    direction,
  };
}

/**
 * Σ approved time-entry hours for a project in the half-open ISO window
 * [fromIso, toIso). Returns null when no time-entry data exists at all for the
 * project (so a caller can tell "genuinely zero" from "we have no basis"); 0
 * when there is data but none falls in the window.
 */
export function approvedHoursInWindow(
  projectId: string,
  d: FinanceData,
  fromIso: string,
  toIso: string,
): number | null {
  const all = (d.timeEntries ?? []).filter(t => t.projectId === projectId && t.status === 'Approved');
  if (all.length === 0) return null; // no basis to derive a prior value
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  let hours = 0;
  for (const t of all) {
    const at = Date.parse(t.date);
    if (Number.isFinite(at) && at >= from && at < to) hours += finite(t.hours);
  }
  return finite(hours);
}

/**
 * Σ billing-item amount billed (Invoiced/Paid) for a project whose issuedDate
 * falls in the half-open window [fromIso, toIso), in base currency when
 * d.fxRates is present. Returns null when the project has NO issued, billed
 * items at all (no basis); 0 when there are issued items but none in the window.
 * Items without an issuedDate are excluded from windowing but still count toward
 * "has a basis" only if billed — an unbilled plan gives null.
 */
export function billedAmountInWindow(
  projectId: string,
  d: FinanceData,
  fromIso: string,
  toIso: string,
): number | null {
  const billedIssued = (d.billingItems ?? []).filter(
    i => i.projectId === projectId && BILLED_STATUSES.has(i.status) && !!i.issuedDate,
  );
  if (billedIssued.length === 0) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  let amount = 0;
  for (const i of billedIssued) {
    const at = Date.parse(i.issuedDate as string);
    if (Number.isFinite(at) && at >= from && at < to) amount += convertToBase(i.amount, i.currency, d.fxRates);
  }
  return finite(amount);
}

/**
 * Recognised-revenue trend for two adjacent windows derived from dated
 * time/billing inputs. The current reading is the revenue recognised WITHIN
 * `currentPeriods`; the previous reading is the revenue recognised within the
 * immediately preceding block of equal length. Both are obtained by running
 * recognitionSchedule over the COMBINED span and summing each sub-window's
 * `recognized` — running it over a sub-window alone would clamp earlier items
 * into the first period and inflate it, so the combined pass is what keeps each
 * period's figure true to its own dates.
 *
 * Returns a PeriodDelta whose `previous`/`delta`/`direction` are null when the
 * prior window cannot be derived (no periods before `currentPeriods`, or no
 * dated source data in that earlier span). This is intentionally conservative:
 * we never invent a trend; a 0 baseline is reported only when the prior window
 * is genuinely measurable, otherwise the caller should HIDE the trend.
 */
export function recognizedRevenueTrend(
  d: FinanceData,
  currentPeriods: readonly string[],
  opts: ScheduleOpts = {},
): PeriodDelta {
  if (currentPeriods.length === 0) return periodDelta(0, null);

  const current = [...currentPeriods].sort();
  const prior = priorPeriods(current);

  // No prior window at all -> only the current reading is known.
  if (prior.length === 0) {
    const span = recognitionSchedule(d, current, opts);
    return periodDelta(sumRecognizedIn(span, current), null);
  }

  // Single combined pass so each period reflects its own dates (no clamping bias).
  const combined = recognitionSchedule(d, [...prior, ...current], opts);
  const currentValue = sumRecognizedIn(combined, current);

  // Only treat the prior window as measurable if dated source data could land in
  // it; otherwise hide the trend (don't fake a 0 baseline).
  if (!hasDatedDataInPeriods(d, prior, opts)) return periodDelta(currentValue, null);

  const previousValue = sumRecognizedIn(combined, prior);
  return periodDelta(currentValue, previousValue);
}

/** Σ of `recognized` for the schedule rows whose period is in `window`. */
function sumRecognizedIn(rows: readonly RecognitionPeriod[], window: readonly string[]): number {
  const set = new Set(window);
  return finite(rows.filter(r => set.has(r.period)).reduce((a, r) => a + finite(r.recognized), 0));
}

/** The block of YYYY-MM periods of equal length immediately preceding `periods`. */
function priorPeriods(periods: readonly string[]): string[] {
  if (periods.length === 0) return [];
  const first = periods[0];
  const [y, m] = first.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  // Walk back one month per period in the window, starting from the first.
  const out: string[] = [];
  let yy = y;
  let mm = m;
  let remaining = periods.length;
  while (remaining-- > 0) {
    mm -= 1;
    if (mm < 1) { mm = 12; yy -= 1; }
    out.unshift(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  return out;
}

/** True when any dated billing item or time entry (matching opts) lands in `periods`. */
function hasDatedDataInPeriods(d: FinanceData, periods: readonly string[], opts: ScheduleOpts): boolean {
  const set = new Set(periods);
  const matchItem = (i: BillingPlanItem) =>
    (opts.projectId === undefined || i.projectId === opts.projectId) &&
    (opts.contractId === undefined || i.contractId === opts.contractId);
  for (const i of d.billingItems ?? []) {
    if (!matchItem(i)) continue;
    const p = recognitionPeriodFor(i, d);
    if (p && set.has(p)) return true;
  }
  // T&M/Expense recognition is driven by time entries; check those too.
  for (const t of d.timeEntries ?? []) {
    if (t.status !== 'Approved') continue;
    if (opts.projectId !== undefined && t.projectId !== opts.projectId) continue;
    if (set.has(periodOf(t.date))) return true;
  }
  return false;
}
