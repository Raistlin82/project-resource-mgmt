import { describe, expect, it } from 'vitest';
import type { BillingPlanItem } from './api.service';
import { billingPlanValidationError } from './billing-validation.util';

const base = (overrides: Partial<BillingPlanItem> = {}): Partial<BillingPlanItem> => ({
  contractId: 'CT1',
  type: 'TimeAndMaterials',
  label: 'Consulting',
  amount: 1_000,
  currency: 'EUR',
  status: 'Planned',
  taxRatePct: 22,
  retentionPct: 0,
  paymentTermsDays: 30,
  ...overrides,
});

describe('billingPlanValidationError', () => {
  it('requires the field that belongs to each conditional billing type', () => {
    expect(billingPlanValidationError(base({ type: 'Milestone' }))).toBe('milestoneId is required for Milestone billing');
    expect(billingPlanValidationError(base({ type: 'Capped' }))).toBe('capAmount is required for Capped billing');
    expect(billingPlanValidationError(base({ type: 'Progress' }))).toBe('progressPct is required for Progress billing');
    expect(billingPlanValidationError(base({ type: 'Recurring', recurrence: undefined }))).toBe('recurrence is required for Recurring billing');
  });

  it('bounds every percentage field to 0-100', () => {
    expect(billingPlanValidationError(base({ taxRatePct: 101 }))).toBe('taxRatePct must be between 0 and 100');
    expect(billingPlanValidationError(base({ retentionPct: -1 }))).toBe('retentionPct must be between 0 and 100');
    expect(billingPlanValidationError(base({ type: 'Expense', markupPct: 150 }))).toBe('markupPct must be between 0 and 100');
    expect(billingPlanValidationError(base({ type: 'Progress', progressPct: 101 }))).toBe('progressPct must be between 0 and 100');
  });

  it('requires payment terms to be whole non-negative days', () => {
    expect(billingPlanValidationError(base({ paymentTermsDays: 1.5 }))).toBe('paymentTermsDays must be a non-negative integer');
    expect(billingPlanValidationError(base({ paymentTermsDays: -1 }))).toBe('paymentTermsDays must be a non-negative integer');
  });

  it('requires credit notes to carry a strictly negative persisted amount', () => {
    expect(billingPlanValidationError(base({ type: 'CreditNote', amount: 10 }))).toBe('CreditNote amount must be negative');
    expect(billingPlanValidationError(base({ type: 'CreditNote', amount: -10 }))).toBeNull();
  });

  it('accepts complete valid conditional records', () => {
    expect(billingPlanValidationError(base({ type: 'Milestone', milestoneId: 'M1' }))).toBeNull();
    expect(billingPlanValidationError(base({ type: 'Capped', capAmount: 1_500 }))).toBeNull();
    expect(billingPlanValidationError(base({ type: 'Progress', progressPct: 75 }))).toBeNull();
    expect(billingPlanValidationError(base({ type: 'Recurring', recurrence: 'Quarterly' }))).toBeNull();
  });
});
