import type { BillingPlanItem, BillingType } from './api.service';

const BILLING_TYPES: readonly BillingType[] = [
  'Milestone', 'Recurring', 'TimeAndMaterials', 'Capped',
  'Advance', 'Progress', 'Expense', 'CreditNote',
];
const BILLING_STATUSES: readonly BillingPlanItem['status'][] = ['Planned', 'Ready', 'Invoiced', 'Paid', 'Blocked'];
const RECURRENCES: readonly NonNullable<BillingPlanItem['recurrence']>[] = ['Monthly', 'Quarterly', 'Annual'];

function percentageError(name: string, value: unknown): string | null {
  if (value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? null
    : `${name} must be between 0 and 100`;
}

/** Amount exposed to the customer by a generated commercial invoice. */
export function customerFacingBillingAmount(
  item: Pick<BillingPlanItem, 'type' | 'amount' | 'markupPct'>,
): number {
  if (item.type !== 'Expense') return item.amount;
  const markedUp = item.amount * (1 + (item.markupPct ?? 0) / 100);
  return Math.round((markedUp + Number.EPSILON) * 100) / 100;
}

/** Shared client/server semantic validation for a fully merged billing item. */
export function billingPlanValidationError(item: Partial<BillingPlanItem>): string | null {
  if (!item.type || !BILLING_TYPES.includes(item.type)) return 'type is invalid';
  if (!item.contractId) return 'contractId is required';
  if (!item.label?.trim()) return 'label is required';
  if (!item.currency) return 'currency is required';
  if (!item.status || !BILLING_STATUSES.includes(item.status)) return 'status is invalid';

  if (typeof item.amount !== 'number' || !Number.isFinite(item.amount)) return 'amount must be a finite number';
  if (item.type === 'CreditNote') {
    if (item.amount >= 0) return 'CreditNote amount must be negative';
  } else if (item.amount < 0) {
    return 'amount must be a non-negative number (negative allowed only for CreditNote)';
  }

  for (const [name, value] of [
    ['taxRatePct', item.taxRatePct],
    ['retentionPct', item.retentionPct],
    ['markupPct', item.markupPct],
    ['progressPct', item.progressPct],
  ] as const) {
    const error = percentageError(name, value);
    if (error) return error;
  }

  if (item.paymentTermsDays !== undefined
    && (!Number.isInteger(item.paymentTermsDays) || item.paymentTermsDays < 0)) {
    return 'paymentTermsDays must be a non-negative integer';
  }
  if (item.capAmount !== undefined
    && (typeof item.capAmount !== 'number' || !Number.isFinite(item.capAmount) || item.capAmount < 0)) {
    return 'capAmount must be a non-negative number';
  }
  if (item.recurrence !== undefined && !RECURRENCES.includes(item.recurrence)) return 'recurrence is invalid';

  switch (item.type) {
    case 'Milestone':
      return item.milestoneId ? null : 'milestoneId is required for Milestone billing';
    case 'Recurring':
      return item.recurrence ? null : 'recurrence is required for Recurring billing';
    case 'Capped':
      return item.capAmount !== undefined ? null : 'capAmount is required for Capped billing';
    case 'Progress':
      return item.progressPct !== undefined ? null : 'progressPct is required for Progress billing';
    default:
      return null;
  }
}
