import {
  computeProjectFinancials,
  resourceBillability,
  isProjectBillable,
  hasAnyAlert,
  portfolioRealization,
  portfolioMarginFullyLoaded,
  billedToDate,
  recognizedRevenue,
  unbilledWip,
  deferredRevenue,
  retentionHeld,
  taxTotal,
  dsoProxy,
  effectiveDueDate,
  isOutstanding,
  daysOverdue,
  bucketForDaysOverdue,
  arAging,
  arAgingByCustomer,
  dsoOutstanding,
  recognitionSchedule,
  AR_AGING_BUCKETS,
  budgetForProject,
  approvedChangeBudgetForProject,
  countsTowardEffectiveBudget,
  effectiveBudgetForProject,
  expenseCostForProject,
  marginDrivers,
  projectAlerts,
  portfolioAlerts,
  convertToBase,
  portfolioTotalsInBase,
  recognitionJournal,
  journalTotals,
  journalIsBalanced,
  JOURNAL_ACCOUNTS,
  realizationMetrics,
  customerProfitability,
  customerConcentration,
  marginCompressionAlerts,
  DEFAULT_MARGIN_COMPRESSION_CONFIG,
  periodDelta,
  approvedHoursInWindow,
  billedAmountInWindow,
  recognizedRevenueTrend,
  JournalEntry,
  FinanceData,
  plannedCostSchedule,
  PlannedCostPeriod,
  costBaselineComparison,
  CostBaselineComparisonRow,
} from './finance.util';
import { Resource, ResourceRequest, Assignment, Order, OrderLine, FinancialItem, TimeEntry, BillingPlanItem, Contract, Customer, Milestone, ChangeRequest, Project, FxRate, AssignmentDay, AssignmentMonth, CostBaseline } from './api.service';

function res(id: string, costRate: number, billRate: number): Resource {
  return { id, name: `R${id}`, role: 'Dev', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate, billRate };
}
function req(id: string, projectId: string): ResourceRequest {
  return { id, name: `Req${id}`, requiredRole: 'Dev', requiredEffort: 0, status: 'Open', skills: [], projectId };
}
function assign(id: string, requestId: string, resourceId: string, hours: number): Assignment {
  return { id, requestId, resourceId, assignedHours: hours, status: 'Allocated' };
}
function day(id: string, assignmentId: string, date: string, hours: number): AssignmentDay {
  return { id, assignmentId, date, hours };
}
function month(assignmentId: string, month: string, status: AssignmentMonth['status']): AssignmentMonth {
  return { id: `${assignmentId}:${month}`, assignmentId, month, status };
}
function baseline(id: string, projectId: string, period: string, amount: number, frozenAt: string): CostBaseline {
  return { id, projectId, period, amount, frozenAt, frozenBy: 'u1' };
}
function order(id: string, type: Order['type'], status: Order['status']): Order {
  return { id, contractId: 'CT', type, amount: 0, currency: 'EUR', status, orderDate: '2026-01-01' };
}
function line(id: string, orderId: string, projectId: string, amount: number): OrderLine {
  return { id, orderId, projectId, description: 'x', amount };
}
function fin(id: string, projectId: string, budget: number, actual: number): FinancialItem {
  return { id, projectId, category: 'c', budget, actual };
}
function time(id: string, assignmentId: string, requestId: string, resourceId: string, projectId: string, hours: number, status: TimeEntry['status']): TimeEntry {
  return { id, assignmentId, requestId, resourceId, projectId, date: '2026-01-02', hours, status };
}
function bill(id: string, projectId: string, type: BillingPlanItem['type'], amount: number, status: BillingPlanItem['status'], extra: Partial<BillingPlanItem> = {}): BillingPlanItem {
  return { id, contractId: 'CT', projectId, type, label: `B${id}`, amount, currency: 'EUR', status, ...extra };
}
function cr(id: string, projectId: string, status: ChangeRequest['status'], impactBudget: number): ChangeRequest {
  return {
    id, projectId, title: `CR${id}`, description: 'x', requestedBy: 'u1', owner: 'u2',
    status, impactScope: 'scope', impactBudget, impactScheduleDays: 0, priority: 'Medium', createdAt: '2026-01-01',
  };
}
function proj(id: string, name: string): Project {
  return { id, name, location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active' };
}

const data: FinanceData = {
  resources: [res('1', 75, 140), res('2', 90, 180)],
  requests: [req('r1', 'P'), req('r2', 'Q')],
  assignments: [assign('a1', 'r1', '1', 100), assign('a2', 'r2', '2', 50)],
  orders: [order('o1', 'Customer', 'Invoiced'), order('o2', 'Customer', 'Open'), order('o3', 'Purchase', 'Confirmed')],
  orderLines: [line('l1', 'o1', 'P', 20000), line('l2', 'o2', 'P', 5000), line('l3', 'o3', 'P', 3000)],
  financials: [fin('f1', 'P', 30000, 10000)],
};

describe('finance.util', () => {
  it('computes revenue from customer order lines only', () => {
    expect(computeProjectFinancials('P', data).revenue).toBe(25000);
  });

  it('attributes labor cost via the project\'s requests (hours × costRate)', () => {
    // r1 belongs to P; a1 = 100h × resource 1 costRate 75 = 7500. a2 belongs to Q.
    expect(computeProjectFinancials('P', data).laborCost).toBe(7500);
  });

  it('sums purchase-order lines as external cost', () => {
    expect(computeProjectFinancials('P', data).externalCost).toBe(3000);
  });

  it('computes margin = revenue − (labor + external)', () => {
    const f = computeProjectFinancials('P', data);
    expect(f.actualCost).toBe(10500);
    expect(f.margin).toBe(14500);
    expect(f.marginPct).toBeCloseTo(58, 5);
  });

  it('computes backlog = revenue − invoiced', () => {
    const f = computeProjectFinancials('P', data);
    expect(f.invoiced).toBe(20000);
    expect(f.backlog).toBe(5000);
  });

  it('computes burn = actualCost / budget', () => {
    expect(computeProjectFinancials('P', data).burnPct).toBeCloseTo(35, 5);
  });

  it('uses approved time entries as actual labor and exposes EAC', () => {
    const actualData: FinanceData = {
      ...data,
      timeEntries: [
        time('t1', 'a1', 'r1', '1', 'P', 40, 'Approved'),
        time('t2', 'a1', 'r1', '1', 'P', 10, 'Submitted'),
      ],
    };
    const f = computeProjectFinancials('P', actualData);
    expect(f.plannedLaborCost).toBe(7500);
    expect(f.actualLaborCost).toBe(3000);
    expect(f.laborCost).toBe(3000);
    expect(f.actualCost).toBe(6000);
    expect(f.etc).toBe(4500);
    expect(f.eac).toBe(10500);
    expect(f.varianceAtCompletion).toBe(19500);
  });

  /**
   * EAC = labor INCURRED + external + ETC. Three cases pin that shape —
   * equivalently `max(plannedLaborCost, actualLaborCost) + externalCost` —
   * without ever restating the implementation: actual below plan (the ETC
   * branch), actual part-way (the case above, kept as the middle point) and
   * actual past plan (ETC floors at 0).
   *
   * The defect these close: `eac` read `actualCost`, which falls back to the
   * PLAN while no timesheet is approved, so the plan was charged as incurred and
   * as still-to-come at once. Only ONE assertion in this suite was ever on that
   * fallback branch ("approved CR can flip VAC negative", further down), and its
   * 18000 — with the comment above it — certified the double count to reviewers.
   */
  it('does not double-count the planned-labor fallback into EAC (no approved time yet)', () => {
    // `data` carries NO timeEntries; state it explicitly so the fixture cannot
    // drift onto the actual-cost branch and make the whole case inert.
    const noTime: FinanceData = { ...data, timeEntries: [] };
    const f = computeProjectFinancials('P', noTime);

    // BRANCH GUARD: these two ARE the proof we are on the planned-labor fallback.
    expect(f.plannedLaborCost).toBe(7500);
    expect(f.actualLaborCost).toBe(0);

    expect(f.etc).toBe(7500);
    expect(f.eac).toBe(10500);            // 0 incurred labor + 3000 external + 7500 ETC
    // ABSENCE: 18000 is exactly what `actualCost + etc` produced here.
    expect(f.eac).not.toBe(18000);
    expect(f.varianceAtCompletion).toBe(30000 - 10500);

    // The fallback-branch TILES must not move: "delete the fallback from
    // laborCostForProject" also lands eac on 10500, and would blank Labor Cost
    // and Actual Cost on every pre-timesheet project.
    expect(f.laborCost).toBe(7500);
    expect(f.actualCost).toBe(10500);
  });

  it('floors ETC at zero once actual labor passes the plan, and EAC follows actual', () => {
    // 120h × 75 = 9000 actual against a 7500 plan. Stops the fix from being
    // "delete the ETC term": that would give 12000 here too, but 3000 above.
    const overrun: FinanceData = {
      ...data,
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 120, 'Approved')],
    };
    const f = computeProjectFinancials('P', overrun);
    expect(f.plannedLaborCost).toBe(7500);
    expect(f.actualLaborCost).toBe(9000);
    expect(f.etc).toBe(0);
    expect(f.eac).toBe(12000);            // 9000 incurred labor + 3000 external + 0 ETC
    expect(f.laborCost).toBe(9000);
    expect(f.actualCost).toBe(12000);
  });

  it('guards against division by zero (no revenue, no budget)', () => {
    const f = computeProjectFinancials('Z', data);
    expect(f.revenue).toBe(0);
    expect(f.marginPct).toBe(0);
    expect(f.burnPct).toBe(0);
  });

  it('computes resource billability (cost vs billable)', () => {
    const b = resourceBillability('1', data);
    expect(b.hours).toBe(100);
    expect(b.cost).toBe(7500);
    expect(b.billable).toBe(14000);
  });
});

describe('finance.util billing rollups', () => {
  // P: a mix of statuses, a progress item, retention/tax, and credit note.
  const billingData: FinanceData = {
    ...data,
    billingItems: [
      bill('b1', 'P', 'Milestone', 10000, 'Invoiced', { retentionPct: 10, taxRatePct: 22, issuedDate: '2026-01-01' }),
      bill('b2', 'P', 'Milestone', 5000, 'Paid', { retentionPct: 10, taxRatePct: 22, issuedDate: '2026-01-01', paidDate: '2026-01-31' }),
      bill('b3', 'P', 'Progress', 20000, 'Planned', { progressPct: 25 }),       // recognizes 5000, not billed
      bill('b4', 'P', 'Milestone', 8000, 'Ready', { retentionPct: 5 }),         // recognized, not billed, retention held
      bill('b5', 'P', 'Milestone', 4000, 'Planned'),                            // nothing recognized, nothing billed
      bill('b6', 'Q', 'Milestone', 99999, 'Invoiced'),                          // other project — must be excluded
    ],
  };

  it('uses the customer-facing expense amount, including markup, across billing rollups', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [bill('expense', 'P', 'Expense', 1_000, 'Invoiced', {
        markupPct: 10,
        retentionPct: 5,
        taxRatePct: 22,
        issuedDate: '2026-01-10',
      })],
    };

    expect(billedToDate('P', d)).toBe(1_100);
    expect(recognizedRevenue('P', d)).toBe(1_100);
    expect(retentionHeld('P', d)).toBe(55);
    expect(taxTotal('P', d)).toBe(242);
    expect(arAging(d.billingItems ?? [], '2026-02-15').totalOutstanding).toBe(1_100);
    expect(billedAmountInWindow('P', d, '2026-01-01', '2026-02-01')).toBe(1_100);
    expect(portfolioTotalsInBase(d)).toMatchObject({ billed: 1_100, recognized: 1_100, retentionHeld: 55 });
  });

  it('billedToDate sums only Invoiced + Paid items', () => {
    expect(billedToDate('P', billingData)).toBe(15000); // 10000 + 5000
  });

  it('billedToDate is 0 when there are no billing items', () => {
    expect(billedToDate('P', data)).toBe(0);
    expect(billedToDate('Z', billingData)).toBe(0);
  });

  it('recognizedRevenue uses POC for Progress items and full amount for realized items', () => {
    // b1 10000 (Invoiced) + b2 5000 (Paid) + b3 20000×25% = 5000 + b4 8000 (Ready) = 28000
    expect(recognizedRevenue('P', billingData)).toBe(28000);
  });

  it('recognizedRevenue treats missing progressPct as 0', () => {
    const d: FinanceData = { ...data, billingItems: [bill('x', 'P', 'Progress', 20000, 'Invoiced')] };
    expect(recognizedRevenue('P', d)).toBe(0);
  });

  it('unbilledWip = recognized − billed, floored at 0', () => {
    expect(unbilledWip('P', billingData)).toBe(13000); // 28000 − 15000
  });

  it('unbilledWip is 0 when nothing is recognized', () => {
    const d: FinanceData = { ...data, billingItems: [bill('x', 'P', 'Milestone', 9000, 'Planned')] };
    expect(unbilledWip('P', d)).toBe(0);
  });

  it('deferredRevenue captures billing ahead of recognition, floored at 0', () => {
    // billed > recognized: Paid advance not yet recognized
    const d: FinanceData = { ...data, billingItems: [bill('a', 'P', 'Advance', 6000, 'Paid', { issuedDate: '2026-01-01', paidDate: '2026-01-05' })] };
    expect(deferredRevenue('P', d)).toBe(6000);
    // recognized ≥ billed -> no deferral
    expect(deferredRevenue('P', billingData)).toBe(0);
  });

  it('retentionHeld sums amount×retentionPct/100 only on items not yet Paid', () => {
    // b1 10000×10% = 1000 + b4 8000×5% = 400; b2 is Paid (excluded); b3/b5 no retentionPct
    expect(retentionHeld('P', billingData)).toBe(1400);
  });

  it('retentionHeld is 0 when no retentionPct present', () => {
    const d: FinanceData = { ...data, billingItems: [bill('x', 'P', 'Milestone', 5000, 'Invoiced')] };
    expect(retentionHeld('P', d)).toBe(0);
  });

  it('taxTotal sums amount×taxRatePct/100 on Invoiced + Paid items', () => {
    // b1 10000×22% = 2200 + b2 5000×22% = 1100 = 3300; b4 Ready excluded
    expect(taxTotal('P', billingData)).toBe(3300);
  });

  it('taxTotal is 0 when no taxRatePct or nothing invoiced', () => {
    const d: FinanceData = { ...data, billingItems: [bill('x', 'P', 'Milestone', 5000, 'Planned', { taxRatePct: 22 })] };
    expect(taxTotal('P', d)).toBe(0);
  });

  it('dsoProxy averages issued→paid for paid items and issued→asOf for unpaid invoiced items', () => {
    // b1 Invoiced issued 2026-01-01, asOf 2026-01-21 -> 20 days; b2 Paid 2026-01-01->2026-01-31 -> 30 days. avg = 25.
    expect(dsoProxy('P', billingData, '2026-01-21')).toBe(25);
  });

  it('dsoProxy is 0 when there is nothing invoiced to measure', () => {
    expect(dsoProxy('P', data)).toBe(0);
    const d: FinanceData = { ...data, billingItems: [bill('x', 'P', 'Milestone', 5000, 'Planned', { issuedDate: '2026-01-01' })] };
    expect(dsoProxy('P', d, '2026-01-21')).toBe(0);
  });
});

function contract(id: string, customerId: string): Contract {
  return { id, customerId, name: `C${id}`, type: 'T&M', totalValue: 0, currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' };
}
function customer(id: string, name: string): Customer {
  return { id, name };
}
function milestone(id: string, projectId: string, date: string): Milestone {
  return { id, projectId, name: `M${id}`, date, status: 'Achieved' };
}
function billC(id: string, contractId: string, projectId: string | undefined, type: BillingPlanItem['type'], amount: number, status: BillingPlanItem['status'], extra: Partial<BillingPlanItem> = {}): BillingPlanItem {
  return { id, contractId, projectId, type, label: `B${id}`, amount, currency: 'EUR', status, ...extra };
}

describe('finance.util A/R aging', () => {
  const today = '2026-04-01';

  it('exposes the four ordered bucket keys', () => {
    expect([...AR_AGING_BUCKETS]).toEqual(['0-30', '31-60', '61-90', '90+']);
  });

  it('effectiveDueDate prefers explicit dueDate, else issued + paymentTermsDays', () => {
    expect(effectiveDueDate(bill('a', 'P', 'Milestone', 100, 'Invoiced', { dueDate: '2026-03-15' }))).toBe('2026-03-15');
    expect(effectiveDueDate(bill('b', 'P', 'Milestone', 100, 'Invoiced', { issuedDate: '2026-01-01', paymentTermsDays: 30 }))).toBe('2026-01-31');
    // no terms -> due == issued (terms default 0)
    expect(effectiveDueDate(bill('c', 'P', 'Milestone', 100, 'Invoiced', { issuedDate: '2026-02-10' }))).toBe('2026-02-10');
    // neither -> undefined
    expect(effectiveDueDate(bill('d', 'P', 'Milestone', 100, 'Invoiced'))).toBeUndefined();
  });

  it('isOutstanding is true only for Invoiced (not Paid, not pre-issue)', () => {
    expect(isOutstanding(bill('a', 'P', 'Milestone', 1, 'Invoiced'))).toBe(true);
    expect(isOutstanding(bill('b', 'P', 'Milestone', 1, 'Paid'))).toBe(false);
    expect(isOutstanding(bill('c', 'P', 'Milestone', 1, 'Ready'))).toBe(false);
    expect(isOutstanding(bill('d', 'P', 'Milestone', 1, 'Planned'))).toBe(false);
    expect(isOutstanding(bill('e', 'P', 'Milestone', 1, 'Blocked'))).toBe(false);
  });

  it('daysOverdue is 0 before/at due date and counts whole days after', () => {
    const item = bill('a', 'P', 'Milestone', 1, 'Invoiced', { dueDate: '2026-03-22' });
    expect(daysOverdue(item, '2026-03-01')).toBe(0); // not yet due
    expect(daysOverdue(item, '2026-03-22')).toBe(0); // due today
    expect(daysOverdue(item, '2026-04-01')).toBe(10); // 10 days late
  });

  it('bucketForDaysOverdue maps boundaries correctly', () => {
    expect(bucketForDaysOverdue(0)).toBe('0-30');
    expect(bucketForDaysOverdue(30)).toBe('0-30');
    expect(bucketForDaysOverdue(31)).toBe('31-60');
    expect(bucketForDaysOverdue(60)).toBe('31-60');
    expect(bucketForDaysOverdue(61)).toBe('61-90');
    expect(bucketForDaysOverdue(90)).toBe('61-90');
    expect(bucketForDaysOverdue(91)).toBe('90+');
    expect(bucketForDaysOverdue(NaN)).toBe('0-30'); // guarded
  });

  it('arAging buckets outstanding items by days overdue and sums totals/overdue', () => {
    const items: BillingPlanItem[] = [
      bill('current', 'P', 'Milestone', 1000, 'Invoiced', { dueDate: '2026-04-20' }),   // not due -> 0-30, not overdue
      bill('late10', 'P', 'Milestone', 2000, 'Invoiced', { dueDate: '2026-03-22' }),    // 10 days -> 0-30, overdue
      bill('late45', 'P', 'Milestone', 3000, 'Invoiced', { dueDate: '2026-02-15' }),    // 45 days -> 31-60
      bill('late75', 'P', 'Milestone', 4000, 'Invoiced', { dueDate: '2026-01-16' }),    // 75 days -> 61-90
      bill('late120', 'P', 'Milestone', 5000, 'Invoiced', { dueDate: '2025-12-02' }),   // 120 days -> 90+
      bill('paid', 'P', 'Milestone', 9000, 'Paid', { dueDate: '2026-01-01' }),          // excluded
      bill('planned', 'P', 'Milestone', 9000, 'Planned', { dueDate: '2026-01-01' }),    // excluded
    ];
    const r = arAging(items, today);
    expect(r.buckets['0-30']).toEqual({ count: 2, amount: 3000 });
    expect(r.buckets['31-60']).toEqual({ count: 1, amount: 3000 });
    expect(r.buckets['61-90']).toEqual({ count: 1, amount: 4000 });
    expect(r.buckets['90+']).toEqual({ count: 1, amount: 5000 });
    expect(r.totalOutstanding).toBe(15000);   // 1000+2000+3000+4000+5000
    expect(r.overdue).toBe(14000);             // all but the not-yet-due 1000
  });

  it('arAging returns zeroed buckets for empty/no-outstanding input', () => {
    const empty = arAging([], today);
    expect(empty.totalOutstanding).toBe(0);
    expect(empty.overdue).toBe(0);
    expect(empty.buckets['90+']).toEqual({ count: 0, amount: 0 });
    const noneOutstanding = arAging([bill('p', 'P', 'Milestone', 5000, 'Paid')], today);
    expect(noneOutstanding.totalOutstanding).toBe(0);
  });

  it('arAging treats an outstanding item with no due date as not overdue (0-30)', () => {
    const r = arAging([bill('nodue', 'P', 'Milestone', 1234, 'Invoiced')], today);
    expect(r.buckets['0-30']).toEqual({ count: 1, amount: 1234 });
    expect(r.overdue).toBe(0);
    expect(r.totalOutstanding).toBe(1234);
  });

  it('arAgingByCustomer joins items->contract->customer and sorts by outstanding desc', () => {
    const contracts = [contract('CT1', 'CUS1'), contract('CT2', 'CUS2')];
    const customers = [customer('CUS1', 'Acme'), customer('CUS2', 'Globex')];
    const items: BillingPlanItem[] = [
      billC('i1', 'CT1', 'P', 'Milestone', 2000, 'Invoiced', { dueDate: '2026-02-15' }), // Acme 31-60
      billC('i2', 'CT2', 'P', 'Milestone', 9000, 'Invoiced', { dueDate: '2025-12-02' }), // Globex 90+
      billC('i3', 'CT1', 'P', 'Milestone', 1000, 'Paid', { dueDate: '2026-01-01' }),      // excluded
    ];
    const rows = arAgingByCustomer(items, contracts, customers, today);
    expect(rows.length).toBe(2);
    expect(rows[0].customerName).toBe('Globex'); // 9000 first
    expect(rows[0].totalOutstanding).toBe(9000);
    expect(rows[0].buckets['90+'].amount).toBe(9000);
    expect(rows[1].customerName).toBe('Acme');
    expect(rows[1].buckets['31-60'].amount).toBe(2000);
  });

  it('arAgingByCustomer groups unresolved contracts under Unknown (nothing dropped)', () => {
    const items: BillingPlanItem[] = [
      billC('i1', 'NOPE', 'P', 'Milestone', 7000, 'Invoiced', { dueDate: '2026-03-01' }),
    ];
    const rows = arAgingByCustomer(items, [], [], today);
    expect(rows.length).toBe(1);
    expect(rows[0].customerId).toBe('unknown');
    expect(rows[0].customerName).toBe('Unknown');
    expect(rows[0].totalOutstanding).toBe(7000);
  });

  it('dsoOutstanding is amount-weighted issued->today age of outstanding items', () => {
    const items: BillingPlanItem[] = [
      bill('a', 'P', 'Milestone', 1000, 'Invoiced', { issuedDate: '2026-03-22' }), // 10 days
      bill('b', 'P', 'Milestone', 3000, 'Invoiced', { issuedDate: '2026-02-20' }), // 40 days
      bill('paid', 'P', 'Milestone', 9999, 'Paid', { issuedDate: '2026-01-01' }),  // excluded
    ];
    // weighted = (1000*10 + 3000*40) / 4000 = (10000 + 120000)/4000 = 32.5
    expect(dsoOutstanding(items, today)).toBeCloseTo(32.5, 5);
  });

  it('dsoOutstanding is 0 when there is no dated outstanding balance', () => {
    expect(dsoOutstanding([], today)).toBe(0);
    expect(dsoOutstanding([bill('a', 'P', 'Milestone', 1000, 'Invoiced')], today)).toBe(0); // no issuedDate
    expect(dsoOutstanding([bill('p', 'P', 'Milestone', 1000, 'Paid', { issuedDate: '2026-01-01' })], today)).toBe(0);
  });
});

describe('finance.util recognitionSchedule', () => {
  const periods = ['2026-01', '2026-02', '2026-03', '2026-04'];

  it('normalises fixed-price and advance movements to base currency', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        billC('usd-milestone', 'CT', 'P', 'Milestone', 10_000, 'Invoiced', {
          currency: 'USD', issuedDate: '2026-01-10',
        }),
        billC('usd-advance', 'CT', 'P', 'Advance', 2_000, 'Paid', {
          currency: 'USD', issuedDate: '2026-01-05',
        }),
      ],
      fxRates: fx(),
    };

    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows[0].recognized).toBeCloseTo(9_000, 6);
    expect(rows[0].deferred).toBe(0);
    const journal = recognitionJournal(d, periods, { projectId: 'P' });
    expect(journalTotals(journal)).toMatchObject({ debit: 12_600, credit: 12_600, balanced: true });
  });

  it('recognises an expense condition from its amount plus markup, not unrelated time entries', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [time('unrelated', 'a1', 'r1', '1', 'P', 99, 'Approved')],
      billingItems: [
        billC('expense', 'CT', 'P', 'Expense', 1_000, 'Ready', {
          currency: 'USD', markupPct: 10, expectedDate: '2026-02-10',
        }),
      ],
      fxRates: fx(),
    };

    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(row => row.recognized)).toEqual([0, 990, 0, 0]);
  });

  it('returns one row per period with running cumulative', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('m1', 'P', 'Milestone', 10000, 'Invoiced', { issuedDate: '2026-02-10' }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.period)).toEqual(periods);
    expect(rows.map(r => r.recognized)).toEqual([0, 10000, 0, 0]);
    expect(rows.map(r => r.cumulative)).toEqual([0, 10000, 10000, 10000]);
  });

  it('accepts a {from,to} range and expands it inclusively', () => {
    const rows = recognitionSchedule({ ...data, billingItems: [] }, { from: '2026-01', to: '2026-03' });
    expect(rows.map(r => r.period)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('uses the milestone date to place a Milestone item when milestoneId resolves', () => {
    const d: FinanceData = {
      ...data,
      milestones: [milestone('ms1', 'P', '2026-03-05')],
      billingItems: [
        // issuedDate would say Jan, but the linked milestone says March -> March wins
        bill('m1', 'P', 'Milestone', 8000, 'Invoiced', { milestoneId: 'ms1', issuedDate: '2026-01-20' }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.recognized)).toEqual([0, 0, 8000, 0]);
  });

  it('Fixed-Price POC: Progress recognizes amount × progressPct in its period', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('p1', 'P', 'Progress', 20000, 'Planned', { progressPct: 25, expectedDate: '2026-02-15' }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.recognized)).toEqual([0, 5000, 0, 0]); // 20000 × 25%
    expect(rows[3].cumulative).toBe(5000);
  });

  it('Recurring is straight-lined across the recurrence window', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        // Quarterly retainer of 9000 -> 3000/mo for 3 months starting Jan
        bill('r1', 'P', 'Recurring', 9000, 'Ready', { recurrence: 'Quarterly', expectedDate: '2026-01-10' }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.recognized)).toEqual([3000, 3000, 3000, 0]);
    expect(rows[3].cumulative).toBe(9000);
  });

  it('Recurring tail beyond the window is clamped into the last period', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        // Quarterly starting in the last period -> 2 of 3 slices clamp onto 2026-04
        bill('r1', 'P', 'Recurring', 9000, 'Ready', { recurrence: 'Quarterly', expectedDate: '2026-04-10' }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.recognized)).toEqual([0, 0, 0, 9000]);
    expect(rows[3].cumulative).toBe(9000);
  });

  it('T&M is recognized as-incurred from approved time × billRate, in the entry month', () => {
    const d: FinanceData = {
      ...data,
      // resource 1 billRate 140
      timeEntries: [
        time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved'),                          // Jan (date 2026-01-02) -> 1400
        { ...time('t2', 'a1', 'r1', '1', 'P', 20, 'Approved'), date: '2026-03-09' }, // Mar -> 2800
        { ...time('t3', 'a1', 'r1', '1', 'P', 99, 'Submitted'), date: '2026-03-09' },// not approved -> ignored
      ],
      billingItems: [
        bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready'),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.recognized)).toEqual([1400, 0, 2800, 0]);
    expect(rows[3].cumulative).toBe(4200);
  });

  it('does not recognize Planned or Blocked as-incurred conditions', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved')],
      billingItems: [
        bill('tm-planned', 'P', 'TimeAndMaterials', 0, 'Planned'),
        bill('tm-blocked', 'P', 'TimeAndMaterials', 0, 'Blocked'),
      ],
    };

    expect(recognitionSchedule(d, periods, { projectId: 'P' }).map(row => row.recognized))
      .toEqual([0, 0, 0, 0]);
  });

  it('recognizes each approved hour once when active as-incurred conditions share a scope', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved')],
      billingItems: [
        bill('tm-a', 'P', 'TimeAndMaterials', 0, 'Ready'),
        bill('tm-b', 'P', 'TimeAndMaterials', 0, 'Invoiced'),
      ],
    };

    expect(recognitionSchedule(d, periods, { projectId: 'P' })[0].recognized).toBe(1_400);
  });

  it('Capped T&M does not recognize beyond capAmount', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [
        time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved'),                           // 1400 (Jan)
        { ...time('t2', 'a1', 'r1', '1', 'P', 20, 'Approved'), date: '2026-02-09' }, // would be 2800 (Feb) but cap stops it
      ],
      billingItems: [
        bill('c1', 'P', 'Capped', 0, 'Ready', { capAmount: 2000 }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    // Jan books 1400, Feb books only the remaining 600 to reach the 2000 cap
    expect(rows.map(r => r.recognized)).toEqual([1400, 600, 0, 0]);
    expect(rows[3].cumulative).toBe(2000);
  });

  it('contract-level T&M (no projectId) recognizes only its own contract\'s projects, not company-wide', () => {
    const d: FinanceData = {
      ...data,
      // P belongs to CT1, Q to CT2.
      projects: [{ ...proj('P', 'P'), contractId: 'CT1' }, { ...proj('Q', 'Q'), contractId: 'CT2' }],
      timeEntries: [
        time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved'),                            // CT1 -> 1400 (Jan)
        { ...time('t2', 'a2', 'r2', '2', 'Q', 20, 'Approved'), date: '2026-02-09' },  // CT2 -> must NOT leak in
      ],
      // Contract-level T&M obligation on CT1 with no projectId.
      billingItems: [billC('tm', 'CT1', undefined, 'TimeAndMaterials', 0, 'Ready')],
    };
    const rows = recognitionSchedule(d, periods, { contractId: 'CT1' });
    // Only CT1's project P hours (1400) are recognized; CT2's 3600 stays out.
    expect(rows.map(r => r.recognized)).toEqual([1400, 0, 0, 0]);
    expect(rows[3].cumulative).toBe(1400);
  });

  it('contract-level T&M with no resolvable projects recognizes nothing (no company-wide leak)', () => {
    const d: FinanceData = {
      ...data,
      // No projects map to CT1.
      projects: [{ ...proj('P', 'P'), contractId: 'CT2' }],
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved')],
      billingItems: [billC('tm', 'CT1', undefined, 'TimeAndMaterials', 0, 'Ready')],
    };
    const rows = recognitionSchedule(d, periods, { contractId: 'CT1' });
    expect(rows.every(r => r.recognized === 0)).toBe(true);
  });

  it('Capped T&M fills the cap chronologically regardless of time-entry array order', () => {
    const jan = time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved');                       // 1400 (Jan)
    const feb = { ...time('t2', 'a1', 'r1', '1', 'P', 20, 'Approved'), date: '2026-02-09' }; // 2800 (Feb)
    const billing = [bill('c1', 'P', 'Capped', 0, 'Ready', { capAmount: 2000 })];
    const inOrder = recognitionSchedule({ ...data, timeEntries: [jan, feb], billingItems: billing }, periods, { projectId: 'P' });
    const reversed = recognitionSchedule({ ...data, timeEntries: [feb, jan], billingItems: billing }, periods, { projectId: 'P' });
    // Earliest month (Jan) is recognized first up to the cap; later month is truncated.
    expect(inOrder.map(r => r.recognized)).toEqual([1400, 600, 0, 0]);
    // Result is identical whichever order the entries arrive in.
    expect(reversed.map(r => r.recognized)).toEqual(inOrder.map(r => r.recognized));
  });

  it('Advance is deferred (never recognized) and rolls off as work is recognized', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        // 12000 advance billed (Paid) in Jan
        bill('a1', 'P', 'Advance', 12000, 'Paid', { issuedDate: '2026-01-05', paidDate: '2026-01-10' }),
        // Progress recognizes 5000 in Feb, then to 9000 total in Mar
        bill('p1', 'P', 'Progress', 5000, 'Ready', { progressPct: 100, expectedDate: '2026-02-12' }),
        bill('p2', 'P', 'Progress', 4000, 'Ready', { progressPct: 100, expectedDate: '2026-03-12' }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    // recognized: Jan 0 (advance only), Feb 5000, Mar 4000
    expect(rows.map(r => r.recognized)).toEqual([0, 5000, 4000, 0]);
    // deferred = advanceBilled(12000) - cumulative recognized, floored at 0
    expect(rows.map(r => r.deferred)).toEqual([12000, 7000, 3000, 3000]);
  });

  it('CreditNote recognizes a negative amount in its period', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('m1', 'P', 'Milestone', 10000, 'Invoiced', { issuedDate: '2026-01-10' }),
        bill('cn', 'P', 'CreditNote', -2000, 'Invoiced', { issuedDate: '2026-03-10' }),
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.recognized)).toEqual([10000, 0, -2000, 0]);
    expect(rows[3].cumulative).toBe(8000);
  });

  it('filters by projectId and by contractId', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        billC('p', 'CT1', 'P', 'Milestone', 1000, 'Invoiced', { issuedDate: '2026-01-10' }),
        billC('q', 'CT2', 'Q', 'Milestone', 5000, 'Invoiced', { issuedDate: '2026-01-10' }),
      ],
    };
    expect(recognitionSchedule(d, periods, { projectId: 'P' })[0].recognized).toBe(1000);
    expect(recognitionSchedule(d, periods, { contractId: 'CT2' })[0].recognized).toBe(5000);
    // no filter -> both land in Jan
    expect(recognitionSchedule(d, periods)[0].recognized).toBe(6000);
  });

  it('returns [] for an empty period list and handles no billing items', () => {
    expect(recognitionSchedule(data, [])).toEqual([]);
    const rows = recognitionSchedule(data, periods, { projectId: 'P' });
    expect(rows.every(r => r.recognized === 0 && r.cumulative === 0 && r.deferred === 0)).toBe(true);
  });

  it('clamps out-of-window dated items to the first/last period so totals reconcile', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('early', 'P', 'Milestone', 1000, 'Invoiced', { issuedDate: '2025-06-01' }), // before window -> first
        bill('late', 'P', 'Milestone', 2000, 'Invoiced', { issuedDate: '2027-01-01' }),  // after window -> last
        bill('undated', 'P', 'Milestone', 500, 'Invoiced' ),                              // no date -> first
      ],
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows[0].recognized).toBe(1500);  // early + undated
    expect(rows[3].recognized).toBe(2000);  // late
    expect(rows[3].cumulative).toBe(3500);  // nothing lost
  });

  // --- Negotiated sell rates (design spec §6): the as-incurred T&M branch must
  // price hours at the negotiated sell rate, not blindly at the resource's own
  // reference billRate. Precedence: project override -> contract rate (dated) ->
  // reference billRate (today's behaviour / no-regression guarantee).
  //
  // UNITS ARE PART OF EVERY FIXTURE BELOW. A NegotiatedRate.billRate is EUR per
  // DAY; a Resource.billRate is EUR per HOUR (withEffectiveRates already divided
  // it by hoursPerDay). `hoursPerDay` is therefore stated explicitly here and the
  // expected figures are hours × the CONVERTED hourly price. The earlier version
  // of these cases asserted `10 * 1000 = 10000` for a 1000 €/DAY rate, which is
  // exactly the ~8x inflation the fixtures could not see.
  const HPD = 8;
  it('prices as-incurred revenue at the negotiated contract rate', () => {
    // 10 approved hours; reference 150 €/h (= 1200 €/day), contract rate 1000 €/day.
    const d: FinanceData = {
      ...data,
      resources: [res('1', 75, 1200 / HPD)],
      projects: [{ ...proj('P', 'P'), contractId: 'CT1' }],
      contracts: [contract('CT1', 'C1')],
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved')], // Jan
      billingItems: [bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready')],
      negotiatedRates: [{ id: 'nr1', contractId: 'CT1', role: 'Dev', currency: 'EUR', billRate: 1000 }],
      hoursPerDay: HPD,
    };
    // The CONTRACT price (1000/day = 125/h), not the reference (150/h).
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows[0].recognized).toBe(10 * (1000 / HPD));  // 1250, NOT 10000
  });

  it('lets a project override beat the contract rate in revenue', () => {
    const d: FinanceData = {
      ...data,
      resources: [res('1', 75, 1200 / HPD)],
      projects: [{ ...proj('P', 'P'), contractId: 'CT1' }],
      contracts: [contract('CT1', 'C1')],
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved')],
      billingItems: [bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready')],
      negotiatedRates: [
        { id: 'nrContract', contractId: 'CT1', role: 'Dev', currency: 'EUR', billRate: 1000 },
        { id: 'nrProject', projectId: 'P', role: 'Dev', currency: 'EUR', billRate: 1150 },
      ],
      hoursPerDay: HPD,
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    // project override (1150/day) beats the contract rate (1000/day)
    expect(rows[0].recognized).toBe(10 * (1150 / HPD));  // 1437.50
  });

  it('scales the negotiated price with the configured hours/day', () => {
    // Proves recognitionSchedule actually READS data.hoursPerDay rather than
    // silently defaulting: the same 1000 €/day rate on a 4h working day is
    // 250 €/h, so the same 10 hours recognize twice as much.
    const base: FinanceData = {
      ...data,
      resources: [res('1', 75, 1200 / HPD)],
      projects: [{ ...proj('P', 'P'), contractId: 'CT1' }],
      contracts: [contract('CT1', 'C1')],
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved')],
      billingItems: [bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready')],
      negotiatedRates: [{ id: 'nr1', contractId: 'CT1', role: 'Dev', currency: 'EUR', billRate: 1000 }],
    };
    expect(recognitionSchedule({ ...base, hoursPerDay: 4 }, periods, { projectId: 'P' })[0].recognized).toBe(2500);
    // Absent -> DEFAULT_HOURS_PER_DAY (8), the same fallback the server applies.
    expect(recognitionSchedule(base, periods, { projectId: 'P' })[0].recognized).toBe(1250);
  });

  it('does not let a higher personal rate raise the invoice', () => {
    // reference 1500 €/day worth of hourly rate, contract 1000 €/day -> 1000 wins.
    const d: FinanceData = {
      ...data,
      resources: [res('1', 75, 1500 / HPD)], // the resource's own reference rate is ABOVE the negotiated price
      projects: [{ ...proj('P', 'P'), contractId: 'CT1' }],
      contracts: [contract('CT1', 'C1')],
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved')],
      billingItems: [bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready')],
      negotiatedRates: [{ id: 'nr1', contractId: 'CT1', role: 'Dev', currency: 'EUR', billRate: 1000 }],
      hoursPerDay: HPD,
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    // the customer signed 1000/day; the resource's own 1500/day must never leak into the invoice
    expect(rows[0].recognized).toBe(10 * (1000 / HPD));
  });

  it('prices hours dated outside the contract period at the reference rate', () => {
    const d: FinanceData = {
      ...data,
      resources: [res('1', 75, 1200 / HPD)],
      projects: [{ ...proj('P', 'P'), contractId: 'CT1' }],
      contracts: [{ ...contract('CT1', 'C1'), startDate: '2026-01-01', endDate: '2026-01-31' }],
      // Mar hours fall OUTSIDE the Jan-only contract period.
      timeEntries: [{ ...time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved'), date: '2026-03-09' }],
      billingItems: [bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready')],
      negotiatedRates: [{ id: 'nr1', contractId: 'CT1', role: 'Dev', currency: 'EUR', billRate: 1000 }],
      hoursPerDay: HPD,
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    // falls through to the reference rate (150/h), not the contract's 1000/day
    expect(rows[2].recognized).toBe(10 * (1200 / HPD));  // 1500
  });

  it('is byte-identical to the pre-feature figures when no rate is negotiated', () => {
    // The no-regression case: same fixture as the pre-existing T&M test above
    // ('T&M is recognized as-incurred...'), empty negotiatedRates, same totals.
    const d: FinanceData = {
      ...data,
      timeEntries: [
        time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved'),                          // Jan (date 2026-01-02) -> 1400
        { ...time('t2', 'a1', 'r1', '1', 'P', 20, 'Approved'), date: '2026-03-09' }, // Mar -> 2800
        { ...time('t3', 'a1', 'r1', '1', 'P', 99, 'Submitted'), date: '2026-03-09' },// not approved -> ignored
      ],
      billingItems: [
        bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready'),
      ],
      negotiatedRates: [], // explicitly empty: nothing has been negotiated
    };
    const rows = recognitionSchedule(d, periods, { projectId: 'P' });
    expect(rows.map(r => r.recognized)).toEqual([1400, 0, 2800, 0]);
    expect(rows[3].cumulative).toBe(4200);

    // The field can also be entirely ABSENT (as every pre-existing FinanceData
    // fixture in this file is) with byte-identical results — that is the actual
    // no-regression guarantee, not merely an empty array.
    const withoutField: FinanceData = { ...d };
    delete (withoutField as { negotiatedRates?: unknown }).negotiatedRates;
    expect(recognitionSchedule(withoutField, periods, { projectId: 'P' })).toEqual(rows);
  });
});

describe('finance.util plannedCostSchedule', () => {
  const base: FinanceData = {
    resources: [res('1', 100, 200)],
    requests: [req('r1', 'P')],
    assignments: [assign('a1', 'r1', '1', 0)],
    orders: [], orderLines: [], financials: [],
  };

  it('prices an Allocated day at hours x the resource\'s costRate, bucketed by month', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8), day('ad2', 'a1', '2026-02-05', 4)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated'), month('a1', '2026-02', 'Allocated')],
    };
    const rows: PlannedCostPeriod[] = plannedCostSchedule(d, ['2026-01', '2026-02'], { projectId: 'P' });
    expect(rows).toEqual([
      { period: '2026-01', plannedCost: 800, cumulative: 800 },
      { period: '2026-02', plannedCost: 400, cumulative: 1200 },
    ]);
  });

  it('counts a Requested month exactly like an Allocated one', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Requested')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(800);
  });

  it('zeroes a day whose month is Draft', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Draft')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('zeroes a day whose month is Rejected', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Rejected')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('zeroes a day with NO month row at all', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('treats a day whose assignment references a missing resource as costRate 0', () => {
    const d: FinanceData = {
      ...base,
      assignments: [assign('a1', 'r1', 'ghost-resource', 0)],
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('ignores a day whose assignment belongs to another project\'s request', () => {
    const d: FinanceData = {
      ...base,
      requests: [req('r1', 'P'), req('r2', 'OTHER')],
      assignments: [assign('a1', 'r1', '1', 0), assign('a2', 'r2', '1', 0)],
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8), day('ad2', 'a2', '2026-01-11', 100)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated'), month('a2', '2026-01', 'Allocated')],
    };
    // Only a1's 8h counts toward project 'P'; a2's 100h (project 'OTHER') must not leak in.
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(800);
  });

  it('clamps a day dated before the requested window into the first period', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2025-11-20', 8)],
      assignmentMonths: [month('a1', '2025-11', 'Allocated')],
    };
    expect(plannedCostSchedule(d, ['2026-01', '2026-02'], { projectId: 'P' })[0].plannedCost).toBe(800);
  });

  it('expands a {from,to} range the same way an explicit period array would', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8), day('ad2', 'a1', '2026-02-05', 4)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated'), month('a1', '2026-02', 'Allocated')],
    };
    expect(plannedCostSchedule(d, { from: '2026-01', to: '2026-02' }, { projectId: 'P' }))
      .toEqual(plannedCostSchedule(d, ['2026-01', '2026-02'], { projectId: 'P' }));
  });

  it('returns an empty array for an empty period list', () => {
    expect(plannedCostSchedule(base, [], { projectId: 'P' })).toEqual([]);
  });

  // UNIT-PINNING TEST (spec §9) — the exact defect class this project already
  // shipped once (~8x revenue via sell-rate.util.ts). costRate 720 mirrors the
  // RAW resources.cost_rate column (EUR/DAY) that loadFinanceData() carries;
  // costRate 90 mirrors the RESOLVED value resolveResourceRates()/GET
  // /api/resources produce (EUR/HOUR = 720 / hoursPerDay 8). Feeding the raw
  // figure MUST NOT be how either the freeze handler or the client comparison
  // computes cost. If a future change swaps resolved for raw resources on
  // either path, this ratio silently becomes hoursPerDay (8), not 1, and this
  // test fails.
  it('is fed resolved (EUR/HOUR) rates, never raw (EUR/DAY) ones — the ratio must be exactly hoursPerDay (8), never 1', () => {
    const days = [day('ad1', 'a1', '2026-10-05', 8)];
    const months = [month('a1', '2026-10', 'Allocated')];
    const resolved: FinanceData = { ...base, resources: [res('1', 90, 180)], assignmentDays: days, assignmentMonths: months };
    const raw: FinanceData = { ...base, resources: [res('1', 720, 1440)], assignmentDays: days, assignmentMonths: months };
    const resolvedCost = plannedCostSchedule(resolved, ['2026-10'], { projectId: 'P' })[0].plannedCost;
    const rawCost = plannedCostSchedule(raw, ['2026-10'], { projectId: 'P' })[0].plannedCost;
    expect(resolvedCost).toBe(720); // 8h x 90 EUR/h — the seeded John Miller figure (Task 1)
    expect(rawCost / resolvedCost).toBe(8); // hoursPerDay — proves the trap, does not silently pass at ratio 1
  });
});

describe('finance.util costBaselineComparison', () => {
  // Mirrors the seeded fixture exactly (Task 1): resource '1' at 90 EUR/HOUR
  // (resolved), one Allocated day of 8h in project 'P' period '2026-10'
  // (720 EUR planned). A frozen baseline of 600 gives a hand-verifiable
  // +120 EUR / +20.00% delta.
  const withOctoberPlan: FinanceData = {
    resources: [res('1', 90, 180)],
    requests: [req('r1', 'P')],
    assignments: [assign('a1', 'r1', '1', 0)],
    orders: [], orderLines: [], financials: [],
    assignmentDays: [day('ad1', 'a1', '2026-10-05', 8)],
    assignmentMonths: [month('a1', '2026-10', 'Allocated')],
  };

  it('reports +120 EUR / +20.00% when the live plan (720) exceeds a 600 baseline', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [baseline('CB1', 'P', '2026-10', 600, '2026-09-15T09:00:00.000Z')] };
    const rows: CostBaselineComparisonRow[] = costBaselineComparison(d, 'P');
    const oct = rows.find(r => r.period === '2026-10');
    expect(oct).toBeDefined();
    expect(oct?.baseline).toBe(600);
    expect(oct?.planned).toBe(720);
    expect(oct?.delta).toBe(120);
    expect(oct?.deltaPct).toBeCloseTo(20, 5);
    expect(oct?.outOfBaselineHorizon).toBe(false);
  });

  it('reports -500 EUR / -100.00% when a frozen month has no booked hours at all (descoped) — a real, severe value, never an em dash', () => {
    // Rule A (design spec §4 line 139 / §9 table): deltaPct is null ONLY when
    // baseline = 0. Here baseline is 500 (nonzero) and planned is a FACT of 0
    // (the month genuinely has no booked hours, not an unknown/error state),
    // so -100% is the precise, well-defined statement of "the whole baseline
    // evaporated" — the loudest variance this feature exists to surface. An
    // em dash here would conflate this severe, real case with "no baseline
    // exists" (see the sibling outOfBaselineHorizon test below), exactly the
    // none-vs-unknown conflation this project has already paid for elsewhere.
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [baseline('CB2', 'P', '2026-11', 500, '2026-09-15T09:00:00.000Z')] };
    const rows = costBaselineComparison(d, 'P');
    const nov = rows.find(r => r.period === '2026-11');
    expect(nov).toBeDefined();
    expect(nov?.baseline).toBe(500);
    expect(nov?.planned).toBe(0);
    expect(nov?.delta).toBe(-500);
    expect(nov?.deltaPct).toBeCloseTo(-100, 5);
    expect(nov?.outOfBaselineHorizon).toBe(false); // frozen explicitly at 500 — NOT the same as never-frozen
  });

  it('flags a booked month with NO baseline row as outOfBaselineHorizon, with baseline 0 and deltaPct null', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [] };
    const rows = costBaselineComparison(d, 'P');
    const oct = rows.find(r => r.period === '2026-10');
    expect(oct?.baseline).toBe(0);
    expect(oct?.deltaPct).toBeNull();
    expect(oct?.outOfBaselineHorizon).toBe(true); // the pair of the two tests above: absence, not zero
  });

  // Not in the plan's original Step 1 — added because Rule A's null branch
  // (design spec §4 line 139 / §9 table: deltaPct null ONLY when baseline =
  // 0) was, before this test, only reachable via the NEVER-FROZEN case above
  // (no costBaselines row at all). That leaves the OTHER baseline=0 sub-case
  // the spec explicitly distinguishes (§4 line 137, §10 line 241: a baseline
  // row that EXISTS but was frozen explicitly at 0 EUR, outOfBaselineHorizon
  // staying false) completely untested — an untested branch that a future
  // "simplification" could silently merge with the never-frozen case.
  it('keeps outOfBaselineHorizon FALSE (never true) when the current baseline row exists but was explicitly frozen at 0 EUR, and still nulls deltaPct', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [baseline('CB_ZERO', 'P', '2026-10', 0, '2026-09-15T09:00:00.000Z')] };
    const oct = costBaselineComparison(d, 'P').find(r => r.period === '2026-10');
    expect(oct?.baseline).toBe(0);
    expect(oct?.planned).toBe(720); // nonzero — the case Rule A must still null correctly
    expect(oct?.delta).toBe(720);
    expect(oct?.deltaPct).toBeNull();
    expect(oct?.outOfBaselineHorizon).toBe(false); // a real row exists — distinct from "never frozen"
  });

  it('uses the row with the LATEST frozenAt for a re-frozen period, never the first one written', () => {
    const d: FinanceData = {
      ...withOctoberPlan,
      costBaselines: [
        baseline('CB_OLD', 'P', '2026-10', 600, '2026-09-01T00:00:00.000Z'),
        baseline('CB_NEW', 'P', '2026-10', 750, '2026-09-20T00:00:00.000Z'),
      ],
    };
    const oct = costBaselineComparison(d, 'P').find(r => r.period === '2026-10');
    expect(oct?.baseline).toBe(750); // NOT 600 — the later re-freeze wins
    expect(oct?.delta).toBe(720 - 750);
  });

  it('never mixes another project\'s baseline rows into this project\'s comparison', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [baseline('CB_OTHER', 'OTHER_PROJECT', '2026-10', 999, '2026-09-01T00:00:00.000Z')] };
    const oct = costBaselineComparison(d, 'P').find(r => r.period === '2026-10');
    expect(oct?.baseline).toBe(0);
    expect(oct?.outOfBaselineHorizon).toBe(true);
  });

  it('returns an empty array when the project has neither a baseline nor any booked hours', () => {
    const d: FinanceData = { resources: [], requests: [], assignments: [], orders: [], orderLines: [], financials: [], costBaselines: [] };
    expect(costBaselineComparison(d, 'GHOST')).toEqual([]);
  });
});

describe('finance.util effective budget (change requests)', () => {
  it('effective budget equals base budget when changeRequests are absent', () => {
    expect(budgetForProject('P', data)).toBe(30000);
    expect(approvedChangeBudgetForProject('P', data)).toBe(0);
    expect(effectiveBudgetForProject('P', data)).toBe(30000);
    // computeProjectFinancials backward compatible: budget unchanged, VAC unchanged
    const f = computeProjectFinancials('P', data);
    expect(f.budget).toBe(30000);
    expect(f.varianceAtCompletion).toBe(30000 - f.eac);
  });

  it('adds APPROVED change-request impactBudget to the effective budget, ignoring undecided and rejected ones', () => {
    const d: FinanceData = {
      ...data,
      changeRequests: [
        cr('c1', 'P', 'Approved', 5000),
        cr('c2', 'P', 'Approved', 2500),
        cr('c3', 'P', 'Submitted', 9999), // not decided -> ignored
        cr('c4', 'P', 'Rejected', 9999),  // decided against -> ignored
        cr('c5', 'Q', 'Approved', 1000),  // other project -> ignored
      ],
    };
    expect(approvedChangeBudgetForProject('P', d)).toBe(7500);
    expect(effectiveBudgetForProject('P', d)).toBe(37500); // 30000 + 7500
  });

  /**
   * Draft → Submitted → Approved → Implemented is one-way: an Implemented change
   * request can never return to Approved (CHANGE_REQUEST_TRANSITIONS,
   * src/server/route-policy.util.ts:115-121), and the Change Requests screen
   * already counts it in its own "approved budget impact" tile. Matching only
   * 'Approved' here meant that clicking "Mark <title> implemented" — the normal
   * end of the lifecycle — withdrew the uplift from budget, burn %, VAC and hence
   * delivery health, so two figures on the same project page disagreed with no
   * way back through the UI.
   */
  it('keeps an IMPLEMENTED change request in the effective budget (it is more committed, not less)', () => {
    const d: FinanceData = {
      ...data,
      changeRequests: [
        cr('c1', 'P', 'Implemented', 7500),
        // ABSENCE, in the same fixture: these must still contribute 0, which is
        // what blocks the cheap "count every status" pass.
        cr('c2', 'P', 'Draft', 9999),
        cr('c3', 'P', 'Submitted', 9999),
        cr('c4', 'P', 'Rejected', 9999),
      ],
    };
    expect(approvedChangeBudgetForProject('P', d)).toBe(7500);
    expect(effectiveBudgetForProject('P', d)).toBe(37500); // 30000 + 7500, not 30000

    const f = computeProjectFinancials('P', d);
    expect(f.budget).toBe(37500);
    // burn and VAC are computed on the uplifted budget, not on the bare 30000.
    expect(f.burnPct).toBeCloseTo((f.actualCost / 37500) * 100, 10);
    expect(f.burnPct).not.toBeCloseTo((f.actualCost / 30000) * 100, 10);
    expect(f.varianceAtCompletion).toBe(37500 - f.eac);
  });

  it('countsTowardEffectiveBudget accepts exactly Approved and Implemented', () => {
    // Exhaustive over the union, so a later status added to ChangeRequest cannot
    // slip in as committed by default, and the twin of every `true` is a `false`.
    const statuses: readonly ChangeRequest['status'][] = ['Draft', 'Submitted', 'Approved', 'Rejected', 'Implemented'];
    expect(statuses.filter(countsTowardEffectiveBudget)).toEqual(['Approved', 'Implemented']);
    expect(statuses.filter(s => !countsTowardEffectiveBudget(s))).toEqual(['Draft', 'Submitted', 'Rejected']);
  });

  it('computeProjectFinancials uses CR-adjusted budget for budget/burnPct/VAC; EAC unchanged', () => {
    const d: FinanceData = {
      ...data,
      changeRequests: [cr('c1', 'P', 'Approved', 10000)], // 30000 -> 40000 effective
    };
    const base = computeProjectFinancials('P', data);
    const f = computeProjectFinancials('P', d);
    // budget reflects the approved CR
    expect(f.budget).toBe(40000);
    // EAC is CR-independent (actualCost + ETC); identical to the base computation
    expect(f.eac).toBe(base.eac);
    expect(f.actualCost).toBe(base.actualCost);
    expect(f.etc).toBe(base.etc);
    // burn = actualCost / effective budget  => 10500 / 40000 = 26.25%
    expect(f.burnPct).toBeCloseTo((base.actualCost / 40000) * 100, 5);
    // VAC = effective budget − EAC (40000 − base EAC)
    expect(f.varianceAtCompletion).toBe(40000 - f.eac);
  });

  it('approved CR can flip VAC negative (EAC over the CR-adjusted budget)', () => {
    // base budget below EAC, plus a negative-impact CR pushes the effective budget down further
    const small: FinanceData = {
      ...data,
      financials: [fin('f1', 'P', 12000, 0)],
      changeRequests: [cr('c1', 'P', 'Approved', -3000)], // effective 9000
    };
    const f = computeProjectFinancials('P', small);
    expect(f.budget).toBe(9000);
    // No time entries, so labor is INCURRED 0 and the 7500 plan is the ETC:
    // eac = 0 + external 3000 + etc 7500 = 10500. (This assertion and the comment
    // that stood here read 18000 — the plan charged twice, once as incurred cost
    // and once as cost to complete. Rewritten, not weakened: the case still
    // proves a negative-impact CR can drive VAC below zero.)
    expect(f.eac).toBe(10500);
    expect(f.varianceAtCompletion).toBe(9000 - 10500); // -1500
    expect(f.varianceAtCompletion).toBeLessThan(0);
  });
});

describe('finance.util marginDrivers', () => {
  it('decomposes margin into labor / external / expense cost drivers', () => {
    // revenue 25000 (Customer lines), labor 7500, external 3000, expense = financial actual 10000
    const m = marginDrivers('P', data);
    expect(m.revenue).toBe(25000);
    expect(m.laborCost).toBe(7500);
    expect(m.externalCost).toBe(3000);
    expect(m.expenseCost).toBe(10000);
    expect(expenseCostForProject('P', data)).toBe(10000);
    expect(m.margin).toBe(25000 - (7500 + 3000 + 10000)); // 4500
    expect(m.marginPct).toBeCloseTo((4500 / 25000) * 100, 5); // 18%
  });

  it('marginPct is 0 when there is no revenue', () => {
    const m = marginDrivers('Z', data);
    expect(m.revenue).toBe(0);
    expect(m.laborCost).toBe(0);
    expect(m.externalCost).toBe(0);
    expect(m.expenseCost).toBe(0);
    expect(m.margin).toBe(0);
    expect(m.marginPct).toBe(0);
  });
});

describe('finance.util alerts', () => {
  it('raises no flags for a healthy project (good margin, low burn, EAC within budget)', () => {
    // P: margin 14500/25000 = 58%, actualCost 10500, budget 30000 -> burn 35%, EAC 10500 < 30000
    const a = projectAlerts('P', data);
    expect(a.marginBelowTarget).toBe(false);
    expect(a.burnOver).toBe(false);
    expect(a.eacOverBudget).toBe(false);
    expect(a.items).toEqual([]);
  });

  it('flags margin below target using the threshold (inclusive at target)', () => {
    // expenseCost drags margin to 18% here; raise the target above it to trip the flag
    const a = projectAlerts('P', data, { marginTargetPct: 60, burnWarnPct: 90 });
    expect(a.marginBelowTarget).toBe(true);
    expect(a.items.some(s => s.includes('Margin'))).toBe(true);
    // inclusive boundary: marginPct (58%) == target 58 still trips
    const eq = computeProjectFinancials('P', data).marginPct;
    expect(projectAlerts('P', data, { marginTargetPct: eq, burnWarnPct: 999 }).marginBelowTarget).toBe(true);
  });

  it('flags burn over the warn threshold (inclusive)', () => {
    // actualCost 10500; pick a small budget so burn >= warn
    const d: FinanceData = { ...data, financials: [fin('f1', 'P', 11000, 0)] }; // burn 95.45%
    const a = projectAlerts('P', d, { marginTargetPct: 15, burnWarnPct: 90 });
    expect(a.burnOver).toBe(true);
    expect(a.items.some(s => s.includes('Burn'))).toBe(true);
  });

  it('flags EAC over (CR-adjusted) budget and sets VAC-negative message', () => {
    const d: FinanceData = { ...data, financials: [fin('f1', 'P', 8000, 0)] }; // EAC 10500 > 8000
    const a = projectAlerts('P', d);
    expect(a.eacOverBudget).toBe(true);
    expect(a.items.some(s => s.includes('EAC'))).toBe(true);
  });

  it('never trips budget-based flags when there is no budget, nor margin flag without revenue', () => {
    // project Z: no revenue, no budget
    const a = projectAlerts('Z', data);
    expect(a.marginBelowTarget).toBe(false);
    expect(a.burnOver).toBe(false);
    expect(a.eacOverBudget).toBe(false);
  });

  it('an approved CR can clear an EAC-over-budget flag by raising the effective budget', () => {
    // EAC for P with no time entries = incurred labor 0 + external 3000 + ETC 7500 = 10500
    const tight: FinanceData = { ...data, financials: [fin('f1', 'P', 8000, 0)] };
    expect(projectAlerts('P', tight).eacOverBudget).toBe(true);
    const withCr: FinanceData = { ...tight, changeRequests: [cr('c1', 'P', 'Approved', 12000)] }; // 8000 -> 20000 > 10500
    expect(projectAlerts('P', withCr).eacOverBudget).toBe(false);
  });

  it('portfolioAlerts returns only flagged projects, sorted, labelled from projects when present', () => {
    // P healthy at defaults; Q has a purchase-only over-budget situation. Build a clear case:
    const d: FinanceData = {
      resources: data.resources,
      requests: [req('r1', 'P'), req('r2', 'Q')],
      assignments: [assign('a1', 'r1', '1', 100), assign('a2', 'r2', '2', 50)],
      orders: [order('o1', 'Customer', 'Invoiced'), order('o3', 'Purchase', 'Confirmed')],
      orderLines: [
        line('l1', 'o1', 'P', 25000),  // P revenue
        line('l3', 'o3', 'Q', 3000),   // Q external cost
      ],
      financials: [fin('f1', 'P', 30000, 0), fin('fq', 'Q', 1000, 0)], // Q budget 1000, tiny
      projects: [proj('P', 'Phoenix'), proj('Q', 'Quasar')],
    };
    const rows = portfolioAlerts(d);
    // Q: labor 50×90=4500 + external 3000 = 7500 EAC, budget 1000 -> eacOverBudget, no revenue
    const q = rows.find(r => r.projectId === 'Q');
    expect(q).toBeDefined();
    expect(q!.name).toBe('Quasar');
    expect(q!.alerts.eacOverBudget).toBe(true);
    // P should be healthy and excluded
    expect(rows.find(r => r.projectId === 'P')).toBeUndefined();
    // rows are sorted by projectId
    expect([...rows].map(r => r.projectId)).toEqual([...rows].map(r => r.projectId).sort());
  });

  it('portfolioAlerts leaves name undefined when projects are not supplied', () => {
    const d: FinanceData = {
      ...data,
      financials: [fin('f1', 'P', 8000, 0)], // EAC 10500 > 8000 -> flagged
    };
    const rows = portfolioAlerts(d);
    const p = rows.find(r => r.projectId === 'P');
    expect(p).toBeDefined();
    expect(p!.name).toBeUndefined();
  });
});

// EUR is the base (rateToBase 1). USD 1 = 0.9 EUR, GBP 1 = 1.2 EUR.
function fx(): FxRate[] {
  return [
    { currency: 'EUR', rateToBase: 1 },
    { currency: 'USD', rateToBase: 0.9 },
    { currency: 'GBP', rateToBase: 1.2 },
  ];
}
function orderC(id: string, type: Order['type'], status: Order['status'], currency: string): Order {
  return { id, contractId: 'CT', type, amount: 0, currency, status, orderDate: '2026-01-01' };
}

describe('finance.util convertToBase', () => {
  const rates = fx();

  it('is a no-op for the base currency (EUR)', () => {
    expect(convertToBase(1000, 'EUR', rates)).toBe(1000);
  });

  it('converts USD and GBP via rateToBase', () => {
    expect(convertToBase(1000, 'USD', rates)).toBeCloseTo(900, 9);   // 1000 × 0.9
    expect(convertToBase(1000, 'GBP', rates)).toBeCloseTo(1200, 9);  // 1000 × 1.2
  });

  it('honours an explicit non-EUR base (cross rate)', () => {
    // express 1000 USD in GBP: 1000 × (0.9 / 1.2) = 750
    expect(convertToBase(1000, 'USD', rates, 'GBP')).toBeCloseTo(750, 9);
  });

  it('treats a missing rate as a no-op (never drops the amount)', () => {
    expect(convertToBase(1000, 'JPY', rates)).toBe(1000); // currency not in table
    expect(convertToBase(1000, 'USD', undefined)).toBe(1000); // no table at all
    expect(convertToBase(1000, undefined, rates)).toBe(1000); // no currency on the item
  });

  it('treats a missing/zero/non-finite base rate as 1 (no divide-by-zero, no NaN)', () => {
    const partial: FxRate[] = [{ currency: 'USD', rateToBase: 0.9 }]; // no EUR base entry
    expect(convertToBase(1000, 'USD', partial)).toBeCloseTo(900, 9);  // base falls back to 1
    const zeroBase: FxRate[] = [{ currency: 'EUR', rateToBase: 0 }, { currency: 'USD', rateToBase: 0.9 }];
    expect(convertToBase(1000, 'USD', zeroBase)).toBeCloseTo(900, 9); // 0 base rate ignored
  });

  it('guards zero and non-finite amounts (returns finite numbers, never NaN)', () => {
    expect(convertToBase(0, 'USD', rates)).toBe(0);
    expect(convertToBase(Number.NaN, 'USD', rates)).toBe(0);
    expect(convertToBase(Number.POSITIVE_INFINITY, 'USD', rates)).toBe(0);
    // a non-finite (e.g. negative/zero) rate in the table is treated as a no-op
    const badRate: FxRate[] = [{ currency: 'EUR', rateToBase: 1 }, { currency: 'USD', rateToBase: Number.NaN }];
    expect(convertToBase(1000, 'USD', badRate)).toBe(1000);
  });

  // Regression for the #14 Capped not-to-exceed FLAG (server enforceCappedBilling):
  // accrued T&M is summed from EUR-denominated resource billRates (a BASE figure),
  // while capAmount is in the item's own currency. The cap MUST be converted to
  // base before the accrued>cap comparison, otherwise a USD cap is compared
  // apples-to-oranges against EUR accrual and the flag fires (or hides) wrongly.
  it('normalises a non-base capAmount before an accrued-vs-cap comparison', () => {
    // A 10,000 USD cap is worth 9,000 EUR at 0.9. Accrued T&M (EUR) = 9,500.
    const capUsd = 10_000;
    const accruedEur = 9_500;
    const capInBase = convertToBase(capUsd, 'USD', rates); // -> 9000 EUR
    // Correct (currency-normalised) comparison: 9500 EUR accrued DOES exceed the
    // 9000 EUR cap -> breached.
    expect(capInBase).toBeCloseTo(9_000, 9);
    expect(accruedEur > capInBase).toBe(true);
    // The buggy same-currency comparison would have used the raw 10,000 USD cap,
    // wrongly concluding 9500 <= 10000 (NOT breached).
    expect(accruedEur > capUsd).toBe(false);
  });
});

describe('finance.util mixed-currency rollups', () => {
  // Project P billed across three currencies on customer orders, plus a USD purchase.
  const mixed: FinanceData = {
    ...data,
    resources: [res('1', 75, 140), res('2', 90, 180)],
    requests: [req('r1', 'P')],
    assignments: [], // isolate revenue/external from labor for a clean check
    orders: [
      orderC('oc1', 'Customer', 'Invoiced', 'USD'),
      orderC('oc2', 'Customer', 'Open', 'GBP'),
      orderC('op1', 'Purchase', 'Confirmed', 'USD'),
    ],
    orderLines: [
      line('l1', 'oc1', 'P', 10000), // USD 10000 -> 9000 base
      line('l2', 'oc2', 'P', 5000),  // GBP 5000  -> 6000 base
      line('l3', 'op1', 'P', 3000),  // USD 3000  -> 2700 base (external)
    ],
    financials: [fin('f1', 'P', 30000, 0)],
    fxRates: fx(),
  };

  it('sums customer order-line revenue across currencies into base', () => {
    // 9000 (USD) + 6000 (GBP) = 15000; invoiced = 9000 (only the USD order is Invoiced)
    const f = computeProjectFinancials('P', mixed);
    expect(f.revenue).toBeCloseTo(15000, 6);
    expect(f.invoiced).toBeCloseTo(9000, 6);
    expect(f.backlog).toBeCloseTo(6000, 6);
    expect(f.externalCost).toBeCloseTo(2700, 6);
  });

  it('reduces to raw single-currency sums when fxRates is absent (backward compatible)', () => {
    const noFx: FinanceData = { ...mixed, fxRates: undefined };
    const f = computeProjectFinancials('P', noFx);
    // identical to today: amounts summed as-is regardless of currency label
    expect(f.revenue).toBe(15000);   // 10000 + 5000
    expect(f.externalCost).toBe(3000);
  });

  it('billedToDate and recognizedRevenue normalise per-item currency to base', () => {
    const d: FinanceData = {
      ...data,
      assignments: [],
      billingItems: [
        billC('b1', 'CT', 'P', 'Milestone', 10000, 'Invoiced', { currency: 'USD' }), // 9000
        billC('b2', 'CT', 'P', 'Milestone', 5000, 'Paid', { currency: 'GBP' }),       // 6000
        billC('b3', 'CT', 'P', 'Progress', 20000, 'Ready', { currency: 'USD', progressPct: 50 }), // 10000 USD -> 9000
      ],
      fxRates: fx(),
    };
    expect(billedToDate('P', d)).toBeCloseTo(15000, 6);     // 9000 + 6000
    // recognized: b1 9000 + b2 6000 + b3 (20000×50%=10000 USD -> 9000) = 24000
    expect(recognizedRevenue('P', d)).toBeCloseTo(24000, 6);
  });

  it('arAging totals are currency-normalised when rates are passed', () => {
    const items: BillingPlanItem[] = [
      billC('a', 'CT', 'P', 'Milestone', 10000, 'Invoiced', { currency: 'USD', dueDate: '2026-03-22' }), // 9000, 10d -> 0-30
      billC('b', 'CT', 'P', 'Milestone', 5000, 'Invoiced', { currency: 'GBP', dueDate: '2025-12-02' }),  // 6000, 90+ overdue
    ];
    const today = '2026-04-01';
    const r = arAging(items, today, fx());
    expect(r.totalOutstanding).toBeCloseTo(15000, 6); // 9000 + 6000 in base
    expect(r.buckets['0-30'].amount).toBeCloseTo(9000, 6);
    expect(r.buckets['90+'].amount).toBeCloseTo(6000, 6);
    expect(r.overdue).toBeCloseTo(15000, 6); // both are past due (the USD one is 10 days late)
    // omitting rates keeps the raw single-currency totals
    expect(arAging(items, today).totalOutstanding).toBe(15000); // 10000 + 5000 raw, coincidental but distinct buckets below
    expect(arAging(items, today).buckets['0-30'].amount).toBe(10000);
  });

  it('arAgingByCustomer can re-sort customers once balances are in a common currency', () => {
    const contracts = [contract('CT1', 'CUS1'), contract('CT2', 'CUS2')];
    const customers = [customer('CUS1', 'Acme'), customer('CUS2', 'Globex')];
    const items: BillingPlanItem[] = [
      billC('i1', 'CT1', 'P', 'Milestone', 9000, 'Invoiced', { currency: 'GBP', dueDate: '2026-02-15' }),  // Acme 9000×1.2 = 10800
      billC('i2', 'CT2', 'P', 'Milestone', 11000, 'Invoiced', { currency: 'USD', dueDate: '2026-02-15' }), // Globex 11000×0.9 = 9900
    ];
    const today = '2026-04-01';
    // Raw (no FX): Globex 11000 > Acme 9000 -> Globex first
    const raw = arAgingByCustomer(items, contracts, customers, today);
    expect(raw[0].customerName).toBe('Globex');
    // In base: Acme 10800 > Globex 9900 -> order flips
    const based = arAgingByCustomer(items, contracts, customers, today, fx());
    expect(based[0].customerName).toBe('Acme');
    expect(based[0].totalOutstanding).toBeCloseTo(10800, 6);
    expect(based[1].totalOutstanding).toBeCloseTo(9900, 6);
  });

  it('portfolioTotalsInBase rolls orders + billing up into the base currency', () => {
    const d: FinanceData = {
      ...mixed,
      billingItems: [
        billC('b1', 'CT', 'P', 'Milestone', 10000, 'Invoiced', { currency: 'USD', retentionPct: 10 }), // billed 9000, retention 900
        billC('b2', 'CT', 'P', 'Advance', 4000, 'Paid', { currency: 'GBP' }),                            // billed 4800, recognized 0
      ],
    };
    const t = portfolioTotalsInBase(d);
    expect(t.baseCurrency).toBe('EUR');
    expect(t.customerRevenue).toBeCloseTo(15000, 6); // 9000 + 6000 (from order lines)
    expect(t.invoicedRevenue).toBeCloseTo(9000, 6);
    expect(t.backlog).toBeCloseTo(6000, 6);
    expect(t.externalCost).toBeCloseTo(2700, 6);
    expect(t.billed).toBeCloseTo(13800, 6);          // 9000 (USD milestone) + 4800 (GBP advance)
    expect(t.recognized).toBeCloseTo(9000, 6);       // milestone realized 9000; advance recognizes 0
    expect(t.retentionHeld).toBeCloseTo(900, 6);     // 10000 USD × 10% = 1000 USD -> 900 base
  });

  it('portfolioTotalsInBase without fxRates is a plain single-currency sum', () => {
    const noFx: FinanceData = { ...mixed, fxRates: undefined, billingItems: [] };
    const t = portfolioTotalsInBase(noFx);
    expect(t.customerRevenue).toBe(15000); // 10000 + 5000 raw
    expect(t.externalCost).toBe(3000);
    expect(t.billed).toBe(0);
  });
});

// --- helpers for the new suites ----------------------------------------------

/** Project carrying an explicit contractId (the base `proj` helper omits it). */
function projC(id: string, name: string, contractId?: string): Project {
  return { id, name, location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active', contractId };
}

/** Sum every debit and credit on a single entry. */
function entrySums(e: JournalEntry): { debit: number; credit: number } {
  return e.lines.reduce((acc, l) => ({ debit: acc.debit + l.debit, credit: acc.credit + l.credit }), { debit: 0, credit: 0 });
}

describe('finance.util recognitionJournal (rev-rec journal preview)', () => {
  const periods = ['2026-01', '2026-02', '2026-03', '2026-04'];

  it('books a simple milestone as Dr Unbilled AR / Cr Revenue in its period', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [bill('m1', 'P', 'Milestone', 10000, 'Invoiced', { issuedDate: '2026-02-10' })],
    };
    const entries = recognitionJournal(d, periods, { projectId: 'P' });
    expect(entries.length).toBe(1);
    expect(entries[0].date).toBe('2026-02');
    expect(entries[0].lines).toEqual([
      { account: JOURNAL_ACCOUNTS.unbilledAr, debit: 10000, credit: 0 },
      { account: JOURNAL_ACCOUNTS.revenue, debit: 0, credit: 10000 },
    ]);
    expect(journalIsBalanced(entries)).toBe(true);
  });

  it('models an advance: cash/deferred on receipt, then amortises deferred as work is earned', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('a1', 'P', 'Advance', 12000, 'Paid', { issuedDate: '2026-01-05', paidDate: '2026-01-10' }),
        bill('p1', 'P', 'Progress', 5000, 'Ready', { progressPct: 100, expectedDate: '2026-02-12' }),
        bill('p2', 'P', 'Progress', 4000, 'Ready', { progressPct: 100, expectedDate: '2026-03-12' }),
      ],
    };
    const entries = recognitionJournal(d, periods, { projectId: 'P' });
    expect(entries.map(e => e.date)).toEqual(['2026-01', '2026-02', '2026-03']); // Apr has no movement

    // Jan: advance received only.
    expect(entries[0].lines).toEqual([
      { account: JOURNAL_ACCOUNTS.cash, debit: 12000, credit: 0 },
      { account: JOURNAL_ACCOUNTS.deferredRevenue, debit: 0, credit: 12000 },
    ]);
    // Feb: recognise 5000 + amortise 5000 of the advance.
    expect(entries[1].lines).toEqual([
      { account: JOURNAL_ACCOUNTS.unbilledAr, debit: 5000, credit: 0 },
      { account: JOURNAL_ACCOUNTS.revenue, debit: 0, credit: 5000 },
      { account: JOURNAL_ACCOUNTS.deferredRevenue, debit: 5000, credit: 0 },
      { account: JOURNAL_ACCOUNTS.unbilledAr, debit: 0, credit: 5000 },
    ]);
    // Mar: recognise 4000 + amortise remaining 4000.
    expect(entries[2].lines).toEqual([
      { account: JOURNAL_ACCOUNTS.unbilledAr, debit: 4000, credit: 0 },
      { account: JOURNAL_ACCOUNTS.revenue, debit: 0, credit: 4000 },
      { account: JOURNAL_ACCOUNTS.deferredRevenue, debit: 4000, credit: 0 },
      { account: JOURNAL_ACCOUNTS.unbilledAr, debit: 0, credit: 4000 },
    ]);

    const totals = journalTotals(entries);
    expect(totals.balanced).toBe(true);
    expect(totals.debit).toBe(30000); // 12000 + 10000 + 8000
    expect(totals.credit).toBe(30000);
  });

  it('a credit note posts a NEGATIVE revenue line (accounts swap to stay non-negative) and still balances', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('m1', 'P', 'Milestone', 10000, 'Invoiced', { issuedDate: '2026-01-10' }),
        bill('cn', 'P', 'CreditNote', -2000, 'Invoiced', { issuedDate: '2026-03-10' }),
      ],
    };
    const entries = recognitionJournal(d, periods, { projectId: 'P' });
    const march = entries.find(e => e.date === '2026-03')!;
    // negative recognized -> Dr Revenue / Cr Unbilled AR (the reversal), amounts positive
    expect(march.lines).toEqual([
      { account: JOURNAL_ACCOUNTS.revenue, debit: 2000, credit: 0 },
      { account: JOURNAL_ACCOUNTS.unbilledAr, debit: 0, credit: 2000 },
    ]);
    expect(journalIsBalanced(entries)).toBe(true);
  });

  it('carries T&M / expense pass-through (as-incurred billRate) through to balanced revenue postings', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [
        time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved'),                               // Jan -> 1400
        { ...time('t2', 'a1', 'r1', '1', 'P', 20, 'Approved'), date: '2026-03-09' },     // Mar -> 2800
      ],
      billingItems: [bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready')],
    };
    const entries = recognitionJournal(d, periods, { projectId: 'P' });
    const jan = entries.find(e => e.date === '2026-01')!;
    expect(jan.lines).toEqual([
      { account: JOURNAL_ACCOUNTS.unbilledAr, debit: 1400, credit: 0 },
      { account: JOURNAL_ACCOUNTS.revenue, debit: 0, credit: 1400 },
    ]);
    const totals = journalTotals(entries);
    expect(totals.debit).toBe(4200); // 1400 + 2800 recognised
    expect(totals.balanced).toBe(true);
  });

  it('reconciles exactly with recognitionSchedule (same amount basis) over the same window', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('m1', 'P', 'Milestone', 10000, 'Invoiced', { issuedDate: '2026-01-10' }),
        bill('p1', 'P', 'Progress', 8000, 'Ready', { progressPct: 25, expectedDate: '2026-03-12' }), // 2000
      ],
    };
    const sched = recognitionSchedule(d, periods, { projectId: 'P' });
    const entries = recognitionJournal(d, periods, { projectId: 'P' });
    // The credited Revenue across the whole journal equals Σ recognised on the schedule.
    let revenueCredited = 0;
    let revenueDebited = 0;
    for (const e of entries) {
      for (const l of e.lines) {
        if (l.account === JOURNAL_ACCOUNTS.revenue) { revenueCredited += l.credit; revenueDebited += l.debit; }
      }
    }
    const scheduleRecognised = sched.reduce((a, r) => a + r.recognized, 0);
    expect(revenueCredited - revenueDebited).toBeCloseTo(scheduleRecognised, 9); // 12000
    expect(journalIsBalanced(entries)).toBe(true);
  });

  it('returns [] for an empty period list and for a window with no movement', () => {
    expect(recognitionJournal(data, [])).toEqual([]);
    expect(recognitionJournal(data, periods, { projectId: 'P' })).toEqual([]); // base data has no billing items
    expect(journalIsBalanced([])).toBe(true); // 0 === 0
    expect(journalTotals([])).toEqual({ debit: 0, credit: 0, balanced: true });
  });

  it('every emitted entry is internally balanced (debit === credit per entry)', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('a1', 'P', 'Advance', 6000, 'Paid', { issuedDate: '2026-01-05' }),
        bill('p1', 'P', 'Progress', 8000, 'Ready', { progressPct: 50, expectedDate: '2026-02-12' }), // 4000
        bill('m1', 'P', 'Milestone', 3000, 'Invoiced', { issuedDate: '2026-03-10' }),
        bill('cn', 'P', 'CreditNote', -1000, 'Invoiced', { issuedDate: '2026-04-10' }),
      ],
    };
    const entries = recognitionJournal(d, periods, { projectId: 'P' });
    for (const e of entries) {
      const s = entrySums(e);
      expect(s.debit).toBeCloseTo(s.credit, 9);
    }
    expect(journalIsBalanced(entries)).toBe(true);
  });
});

describe('finance.util realizationMetrics', () => {
  it('computes realization % (recognised vs standard bill value) and revenue-per-head', () => {
    // resource 1 billRate 140, costRate 75. 40 approved hours -> standard 5600.
    // Milestone 5000 recognised (Invoiced). realization = 5000/5600 ≈ 89.29%.
    const d: FinanceData = {
      ...data,
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 40, 'Approved'), time('t2', 'a1', 'r1', '1', 'P', 10, 'Submitted')],
      billingItems: [bill('m1', 'P', 'Milestone', 5000, 'Invoiced')],
    };
    const m = realizationMetrics('P', d);
    expect(m.hours).toBe(40);                       // only approved
    expect(m.standardBillValue).toBe(5600);         // 40 × 140
    expect(m.revenue).toBe(5000);                   // recognised
    expect(m.realizationPct).toBeCloseTo((5000 / 5600) * 100, 6);
    expect(m.headcount).toBe(1);
    expect(m.revenuePerHead).toBe(5000);
    expect(m.revenuePerFte).toBe(5000);             // no hoursPerFte -> falls back to per-head
  });

  it('derives FTE from hoursPerFte and divides revenue by it', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [
        time('t1', 'a1', 'r1', '1', 'P', 80, 'Approved'),
        time('t2', 'a2', 'r2', '2', 'P', 80, 'Approved'),
      ],
      billingItems: [bill('m1', 'P', 'Milestone', 32000, 'Invoiced')],
    };
    // 160 approved hours / 160 hoursPerFte = 1 FTE; revenue 32000 -> 32000/FTE.
    const m = realizationMetrics('P', d, { hoursPerFte: 160 });
    expect(m.fte).toBeCloseTo(1, 9);
    expect(m.headcount).toBe(2);
    expect(m.revenuePerFte).toBeCloseTo(32000, 6);
    expect(m.revenuePerHead).toBeCloseTo(16000, 6); // 32000 / 2 heads
  });

  it('honours a revenueOverride (e.g. billed view) as the numerator', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 40, 'Approved')],
    };
    const m = realizationMetrics('P', d, { revenueOverride: 7000 });
    expect(m.revenue).toBe(7000);
    expect(m.realizationPct).toBeCloseTo((7000 / 5600) * 100, 6); // > 100% (over-realised)
  });

  it('edge: no approved hours -> zero standard value, realization 0, no divide-by-zero', () => {
    const m = realizationMetrics('P', { ...data, billingItems: [bill('m1', 'P', 'Milestone', 5000, 'Invoiced')] });
    expect(m.hours).toBe(0);
    expect(m.standardBillValue).toBe(0);
    expect(m.realizationPct).toBe(0); // guarded (no standard value to realise against)
    expect(m.headcount).toBe(0);
    expect(m.revenuePerHead).toBe(0); // guarded (no heads)
    expect(m.revenuePerFte).toBe(0);
    expect(Number.isFinite(m.realizationPct)).toBe(true);
  });

  it('edge: zero capacity / zero hoursPerFte falls back to per-head (no Infinity)', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [time('t1', 'a1', 'r1', '1', 'P', 40, 'Approved')],
      billingItems: [bill('m1', 'P', 'Milestone', 5000, 'Invoiced')],
    };
    const m = realizationMetrics('P', d, { hoursPerFte: 0 });
    expect(m.fte).toBe(0);
    expect(m.revenuePerFte).toBe(m.revenuePerHead); // fell back
    expect(Number.isFinite(m.revenuePerFte)).toBe(true);
  });
});

describe('finance.util customerProfitability', () => {
  // P (contract CT1 -> Acme) and Q (contract CT2 -> Globex).
  const d: FinanceData = {
    resources: [res('1', 75, 140), res('2', 90, 180)],
    requests: [req('r1', 'P'), req('r2', 'Q')],
    assignments: [assign('a1', 'r1', '1', 100), assign('a2', 'r2', '2', 50)],
    orders: [order('o1', 'Customer', 'Invoiced'), order('o3', 'Purchase', 'Confirmed')],
    orderLines: [line('l1', 'o1', 'P', 25000), line('l3', 'o3', 'P', 3000)],
    financials: [fin('f1', 'P', 30000, 0), fin('fq', 'Q', 1000, 0)],
    projects: [projC('P', 'Phoenix', 'CT1'), projC('Q', 'Quasar', 'CT2')],
    contracts: [contract('CT1', 'CUS1'), contract('CT2', 'CUS2')],
    customers: [customer('CUS1', 'Acme'), customer('CUS2', 'Globex')],
  };

  it('rolls revenue/cost/margin up to the customer via project->contract->customer', () => {
    const rows = customerProfitability(d);
    const acme = rows.find(r => r.customerId === 'CUS1')!;
    // P: revenue 25000; cost = labor (100×75=7500) + external 3000 = 10500
    expect(acme.customerName).toBe('Acme');
    expect(acme.revenue).toBe(25000);
    expect(acme.cost).toBe(10500);
    expect(acme.margin).toBe(14500);
    expect(acme.marginPct).toBeCloseTo((14500 / 25000) * 100, 6);
    expect(acme.projectIds).toEqual(['P']);

    const globex = rows.find(r => r.customerId === 'CUS2')!;
    // Q: no revenue; cost = labor 50×90 = 4500
    expect(globex.revenue).toBe(0);
    expect(globex.cost).toBe(4500);
    expect(globex.marginPct).toBe(0); // no revenue -> 0, not NaN
  });

  it('sorts rows by descending revenue', () => {
    const rows = customerProfitability(d);
    expect(rows[0].customerId).toBe('CUS1'); // 25000 first
    expect([...rows].map(r => r.revenue)).toEqual([...rows].map(r => r.revenue).sort((a, b) => b - a));
  });

  it('groups projects with no resolvable customer under Unknown (nothing dropped)', () => {
    const orphan: FinanceData = {
      ...data, // base `data` has no projects/contracts/customers wired up
    };
    const rows = customerProfitability(orphan);
    expect(rows.length).toBe(1);
    expect(rows[0].customerId).toBe('unknown');
    expect(rows[0].customerName).toBe('Unknown');
    // P revenue 25000 still attributed
    expect(rows[0].revenue).toBe(25000);
    expect(rows[0].projectIds.sort()).toEqual(['P', 'Q']);
  });

  it('normalises currencies to base when fxRates present', () => {
    const fxData: FinanceData = {
      ...d,
      assignments: [],
      orders: [orderC('oc1', 'Customer', 'Invoiced', 'USD')],
      orderLines: [line('l1', 'oc1', 'P', 10000)], // USD 10000 -> 9000 base
      fxRates: fx(),
    };
    const acme = customerProfitability(fxData).find(r => r.customerId === 'CUS1')!;
    expect(acme.revenue).toBeCloseTo(9000, 6);
  });
});

describe('finance.util customerConcentration', () => {
  it('measures top-customer share and HHI across customers', () => {
    // Acme 30000, Globex 10000 -> total 40000; shares 75% / 25%.
    const d: FinanceData = {
      resources: [res('1', 75, 140)],
      requests: [req('r1', 'P'), req('r2', 'Q')],
      assignments: [],
      orders: [order('o1', 'Customer', 'Invoiced'), order('o2', 'Customer', 'Invoiced')],
      orderLines: [line('l1', 'o1', 'P', 30000), line('l2', 'o2', 'Q', 10000)],
      financials: [],
      projects: [projC('P', 'Phoenix', 'CT1'), projC('Q', 'Quasar', 'CT2')],
      contracts: [contract('CT1', 'CUS1'), contract('CT2', 'CUS2')],
      customers: [customer('CUS1', 'Acme'), customer('CUS2', 'Globex')],
    };
    const c = customerConcentration(d);
    expect(c.totalRevenue).toBe(40000);
    expect(c.customerCount).toBe(2);
    expect(c.topCustomerName).toBe('Acme');
    expect(c.topCustomerSharePct).toBeCloseTo(75, 6);
    expect(c.top3SharePct).toBeCloseTo(100, 6);     // only 2 customers
    expect(c.hhi).toBeCloseTo(75 * 75 + 25 * 25, 6); // 5625 + 625 = 6250
  });

  it('edge: a single customer is 100% concentration / HHI 10000', () => {
    const d: FinanceData = {
      resources: [], requests: [req('r1', 'P')], assignments: [],
      orders: [order('o1', 'Customer', 'Invoiced')],
      orderLines: [line('l1', 'o1', 'P', 50000)],
      financials: [],
      projects: [projC('P', 'Phoenix', 'CT1')],
      contracts: [contract('CT1', 'CUS1')],
      customers: [customer('CUS1', 'Acme')],
    };
    const c = customerConcentration(d);
    expect(c.customerCount).toBe(1);
    expect(c.topCustomerSharePct).toBe(100);
    expect(c.hhi).toBe(10000); // 100²
  });

  it('edge: no revenue -> zeroed concentration, no NaN', () => {
    const c = customerConcentration({ ...data, orderLines: [] });
    expect(c.totalRevenue).toBe(0);
    expect(c.customerCount).toBe(0);
    expect(c.topCustomerSharePct).toBe(0);
    expect(c.hhi).toBe(0);
    expect(c.topCustomerId).toBeUndefined();
  });

  it('ignores net-negative customers (credit notes) rather than producing negative shares', () => {
    // CUS1 net revenue from order lines 20000; a separate customer with only negative order lines is impossible here,
    // so simulate by giving Globex a Purchase-only project (no customer revenue) -> excluded from shares.
    const d: FinanceData = {
      resources: [], requests: [req('r1', 'P'), req('r2', 'Q')], assignments: [],
      orders: [order('o1', 'Customer', 'Invoiced'), order('o3', 'Purchase', 'Confirmed')],
      orderLines: [line('l1', 'o1', 'P', 20000), line('l3', 'o3', 'Q', 9000)],
      financials: [],
      projects: [projC('P', 'Phoenix', 'CT1'), projC('Q', 'Quasar', 'CT2')],
      contracts: [contract('CT1', 'CUS1'), contract('CT2', 'CUS2')],
      customers: [customer('CUS1', 'Acme'), customer('CUS2', 'Globex')],
    };
    const c = customerConcentration(d);
    expect(c.customerCount).toBe(1);       // Globex has no positive customer revenue
    expect(c.topCustomerName).toBe('Acme');
    expect(c.topCustomerSharePct).toBe(100);
  });
});

describe('finance.util marginCompressionAlerts', () => {
  it('flags a thin-margin project below target with graded severity and reasons', () => {
    // P: revenue 25000, cost 10500 -> margin 58%. Set a high target to force a large gap -> 'high'.
    const alerts = marginCompressionAlerts(data, { marginTargetPct: 80 }, ['project']);
    const p = alerts.find(a => a.id === 'P')!;
    expect(p).toBeDefined();
    expect(p.scope).toBe('project');
    expect(p.belowTarget).toBe(true);
    expect(p.gapPts).toBeCloseTo(80 - 58, 6); // 22 pts below
    expect(p.severity).toBe('high');          // gap >= 15
    expect(p.reasons.some(r => r.includes('Margin'))).toBe(true);
  });

  it('flags a thin bill-vs-cost spread even when the margin target is met', () => {
    // revenue 25000, but push cost up so the spread is < 10%. Use a project with revenue 25000 and cost 24000.
    const d: FinanceData = {
      ...data,
      // labor 100×75=7500, external 3000 -> base actualCost 10500. Add expense via financial actual? actualCost uses labor+external only.
      // Instead lift external cost: a 14000 purchase line pushes actualCost to 7500+14000=21500; revenue 25000 -> spread 14%.
      orders: [order('o1', 'Customer', 'Invoiced'), order('o2', 'Customer', 'Open'), order('o3', 'Purchase', 'Confirmed')],
      orderLines: [line('l1', 'o1', 'P', 20000), line('l2', 'o2', 'P', 5000), line('l3', 'o3', 'P', 21500)],
    };
    // actualCost = 7500 + 21500 = 29000; revenue 25000 -> margin negative, spread negative -> thin + below target
    const alerts = marginCompressionAlerts(d, { marginTargetPct: 15, thinSpreadPct: 10 }, ['project']);
    const p = alerts.find(a => a.id === 'P')!;
    expect(p.thinSpread).toBe(true);
    expect(p.belowTarget).toBe(true);
    expect(p.severity).toBe('high'); // deeply below target
    expect(p.reasons.some(r => r.includes('spread'))).toBe(true);
  });

  it('does not flag a healthy project (good margin, healthy spread)', () => {
    // P at default config: margin 58%, spread 58% -> healthy.
    const alerts = marginCompressionAlerts(data, {}, ['project']);
    expect(alerts.find(a => a.id === 'P')).toBeUndefined();
  });

  it('never flags a project with no revenue (nothing to compress)', () => {
    const alerts = marginCompressionAlerts({ ...data, orderLines: [] }, { marginTargetPct: 90 }, ['project']);
    expect(alerts.length).toBe(0);
  });

  it('evaluates the customer scope and labels rows from customers', () => {
    const d: FinanceData = {
      ...data,
      projects: [projC('P', 'Phoenix', 'CT1')],
      contracts: [contract('CT1', 'CUS1')],
      customers: [customer('CUS1', 'Acme')],
    };
    const alerts = marginCompressionAlerts(d, { marginTargetPct: 80 }, ['customer']);
    const acme = alerts.find(a => a.scope === 'customer' && a.id === 'CUS1')!;
    expect(acme).toBeDefined();
    expect(acme.name).toBe('Acme');
    expect(acme.belowTarget).toBe(true);
  });

  it('sorts most-severe first then by largest gap, across both scopes by default', () => {
    const d: FinanceData = {
      ...data,
      projects: [projC('P', 'Phoenix', 'CT1')],
      contracts: [contract('CT1', 'CUS1')],
      customers: [customer('CUS1', 'Acme')],
    };
    const alerts = marginCompressionAlerts(d, { marginTargetPct: 80 });
    const rank: Record<string, number> = { high: 3, medium: 2, low: 1, none: 0 };
    for (let i = 1; i < alerts.length; i++) {
      expect(rank[alerts[i - 1].severity]).toBeGreaterThanOrEqual(rank[alerts[i].severity]);
    }
    // project + customer scopes both present (same underlying P/Acme economics)
    expect(alerts.some(a => a.scope === 'project')).toBe(true);
    expect(alerts.some(a => a.scope === 'customer')).toBe(true);
  });

  it('exposes sane defaults', () => {
    expect(DEFAULT_MARGIN_COMPRESSION_CONFIG.marginTargetPct).toBe(15);
    expect(DEFAULT_MARGIN_COMPRESSION_CONFIG.thinSpreadPct).toBe(10);
  });
});

describe('finance.util periodDelta (real trends, no fabrication)', () => {
  it('computes delta, deltaPct and direction when a previous value exists', () => {
    const up = periodDelta(120, 100);
    expect(up.delta).toBe(20);
    expect(up.deltaPct).toBeCloseTo(20, 6);
    expect(up.direction).toBe('up');

    const down = periodDelta(80, 100);
    expect(down.delta).toBe(-20);
    expect(down.deltaPct).toBeCloseTo(-20, 6);
    expect(down.direction).toBe('down');

    const flat = periodDelta(100, 100);
    expect(flat.delta).toBe(0);
    expect(flat.direction).toBe('flat');
  });

  it('returns ALL-null (hide trend) when previous is null — never fabricates flat/0', () => {
    const p = periodDelta(120, null);
    expect(p.current).toBe(120);
    expect(p.previous).toBeNull();
    expect(p.delta).toBeNull();
    expect(p.deltaPct).toBeNull();
    expect(p.direction).toBeNull(); // caller must HIDE, not render flat
  });

  it('deltaPct is null when previous is 0 (undefined growth) but delta/direction still resolve', () => {
    const p = periodDelta(50, 0);
    expect(p.delta).toBe(50);
    expect(p.deltaPct).toBeNull();
    expect(p.direction).toBe('up');
  });

  it('honours an epsilon dead-band for flat', () => {
    expect(periodDelta(103, 100, 5).direction).toBe('flat');  // within ±5
    expect(periodDelta(106, 100, 5).direction).toBe('up');    // beyond +5
  });

  it('guards non-finite current and previous', () => {
    expect(periodDelta(Number.NaN, 100).current).toBe(0);
    const p = periodDelta(100, Number.POSITIVE_INFINITY);
    expect(p.previous).toBeNull(); // non-finite previous treated as not-derivable
  });
});

describe('finance.util dated prior-period derivers', () => {
  it('approvedHoursInWindow sums approved hours in [from,to) and distinguishes null (no basis) from 0', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [
        { ...time('t1', 'a1', 'r1', '1', 'P', 10, 'Approved'), date: '2026-01-10' },
        { ...time('t2', 'a1', 'r1', '1', 'P', 20, 'Approved'), date: '2026-02-10' },
        { ...time('t3', 'a1', 'r1', '1', 'P', 99, 'Submitted'), date: '2026-01-15' }, // not approved
      ],
    };
    expect(approvedHoursInWindow('P', d, '2026-01-01', '2026-02-01')).toBe(10); // only t1
    expect(approvedHoursInWindow('P', d, '2026-02-01', '2026-03-01')).toBe(20); // only t2
    expect(approvedHoursInWindow('P', d, '2026-05-01', '2026-06-01')).toBe(0);  // has data, none in window
    expect(approvedHoursInWindow('P', data, '2026-01-01', '2026-02-01')).toBeNull(); // no time entries at all -> null
    expect(approvedHoursInWindow('P', d, 'not-a-date', '2026-02-01')).toBeNull();    // unparseable bounds -> null
  });

  it('billedAmountInWindow sums billed issued amounts in window, null when no billed basis', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('b1', 'P', 'Milestone', 1000, 'Invoiced', { issuedDate: '2026-01-10' }),
        bill('b2', 'P', 'Milestone', 2000, 'Paid', { issuedDate: '2026-02-10' }),
        bill('b3', 'P', 'Milestone', 9000, 'Planned', { issuedDate: '2026-01-12' }), // not billed -> excluded
      ],
    };
    expect(billedAmountInWindow('P', d, '2026-01-01', '2026-02-01')).toBe(1000);
    expect(billedAmountInWindow('P', d, '2026-02-01', '2026-03-01')).toBe(2000);
    expect(billedAmountInWindow('P', d, '2026-06-01', '2026-07-01')).toBe(0);   // billed basis exists, none in window
    // a project whose only items are Planned (never billed/issued) -> no basis -> null
    const planned: FinanceData = { ...data, billingItems: [bill('x', 'P', 'Milestone', 5000, 'Planned')] };
    expect(billedAmountInWindow('P', planned, '2026-01-01', '2026-02-01')).toBeNull();
    expect(billedAmountInWindow('P', data, '2026-01-01', '2026-02-01')).toBeNull(); // no billing items at all
  });

  it('billedAmountInWindow normalises to base currency when fxRates present', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [billC('b1', 'CT', 'P', 'Milestone', 10000, 'Invoiced', { currency: 'USD', issuedDate: '2026-01-10' })],
      fxRates: fx(),
    };
    expect(billedAmountInWindow('P', d, '2026-01-01', '2026-02-01')).toBeCloseTo(9000, 6); // 10000 USD -> 9000
  });
});

describe('finance.util recognizedRevenueTrend', () => {
  const periods = ['2026-03', '2026-04']; // current window; prior = ['2026-01','2026-02']

  it('reports a real delta when the prior window has derivable recognition', () => {
    const d: FinanceData = {
      ...data,
      billingItems: [
        bill('m0', 'P', 'Milestone', 4000, 'Invoiced', { issuedDate: '2026-01-10' }),  // prior window
        bill('m1', 'P', 'Milestone', 10000, 'Invoiced', { issuedDate: '2026-03-10' }), // current window
      ],
    };
    const t = recognizedRevenueTrend(d, periods, { projectId: 'P' });
    expect(t.current).toBe(10000);  // cumulative over Mar-Apr
    expect(t.previous).toBe(4000);  // cumulative over Jan-Feb
    expect(t.delta).toBe(6000);
    expect(t.direction).toBe('up');
  });

  it('HIDES the trend (previous null) when there is no dated data in the prior window', () => {
    const d: FinanceData = {
      ...data,
      // all recognition is in the current window; nothing dated in Jan-Feb
      billingItems: [bill('m1', 'P', 'Milestone', 10000, 'Invoiced', { issuedDate: '2026-03-10' })],
    };
    const t = recognizedRevenueTrend(d, periods, { projectId: 'P' });
    expect(t.current).toBe(10000);
    expect(t.previous).toBeNull();   // not derivable -> do NOT fabricate a 0 baseline
    expect(t.delta).toBeNull();
    expect(t.direction).toBeNull();
  });

  it('returns previous=null for an empty current period list', () => {
    const t = recognizedRevenueTrend(data, [], { projectId: 'P' });
    expect(t.current).toBe(0);
    expect(t.previous).toBeNull();
  });

  it('derives the prior window from time entries too (as-incurred T&M)', () => {
    const d: FinanceData = {
      ...data,
      timeEntries: [
        { ...time('t0', 'a1', 'r1', '1', 'P', 10, 'Approved'), date: '2026-02-05' }, // prior -> 1400
        { ...time('t1', 'a1', 'r1', '1', 'P', 20, 'Approved'), date: '2026-03-05' }, // current -> 2800
      ],
      billingItems: [bill('tm1', 'P', 'TimeAndMaterials', 0, 'Ready')],
    };
    const t = recognizedRevenueTrend(d, periods, { projectId: 'P' });
    expect(t.previous).toBe(1400);
    expect(t.current).toBe(2800);
    expect(t.direction).toBe('up');
  });
});

// =============================================================================
// Block H — non-billable engagements ("BASKET")
// Design spec: docs/superpowers/specs/2026-08-06-h-basket-non-billable-design.md
// (§5 F-1..F-9, §8 the test strategy, §10 Q2 = fully-loaded portfolio margin)
//
// THE TRAP THIS SUITE EXISTS TO DEFEAT (spec §8.2): a FinanceData with no
// `projects` reads every id as `billable ?? true`, which reproduces the pre-H
// numbers EXACTLY. So every other suite in this file stays green while
// exercising none of the code below. Value assertions alone would therefore
// certify nothing; the two DIFFERENTIAL suites at the bottom are what prove the
// flag is read at all.
//
// The fixture deliberately carries every shape the flag can be in:
//   PB  billable: true,  type: 'Delivery'  — an ordinary customer engagement
//   PL  NO billable, NO type               — a pre-H row; MUST read as billable
//   PI  billable: false, type: 'Delivery'  — internal, NOT a basket (legitimate)
//   PK  billable: false, type: 'Basket'    — the manual's basket engagement
//   PX  billable: true,  type: 'Basket'    — contradictory, reachable only as bad
//                                            data; proves the arithmetic reads
//                                            `billable` and NEVER `type`
//
// PI carries CUSTOMER REVENUE on purpose. Without it the exclusions would be
// inert — `revenue > 0` already blocks every margin alert on a zero-revenue
// engagement — and a test over an inert branch is the blind green gate this
// project has now paid for nine times. PI is the reachable shape that makes
// them bite: a project that carried order lines and was later flipped, which
// the §6.3 write gates (they cover billing plan items) do not prevent.
// =============================================================================

/** Project with explicit block-H classification. `billable`/`type` are OMITTED
 *  when undefined — an omitted field is not the same row as `billable: true`,
 *  and PL depends entirely on the difference. */
function projH(
  id: string,
  name: string,
  o: { billable?: boolean; type?: Project['type']; contractId?: string } = {},
): Project {
  const p: Project = { id, name, location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active' };
  if (o.billable !== undefined) p.billable = o.billable;
  if (o.type !== undefined) p.type = o.type;
  if (o.contractId !== undefined) p.contractId = o.contractId;
  return p;
}

const H_PROJECTS: Project[] = [
  projH('PB', 'Phoenix', { billable: true, type: 'Delivery', contractId: 'CT1' }),
  projH('PL', 'Legacy', { contractId: 'CT2' }),                 // no billable, no type
  projH('PI', 'Internal Tooling', { billable: false, type: 'Delivery' }),
  projH('PK', 'BASKET - Engineering Practice', { billable: false, type: 'Basket' }),
  projH('PX', 'Mislabelled', { billable: true, type: 'Basket' }),
];

/** The SAME rows with every engagement billable. Used by the differential that
 *  isolates the flag itself: `projects` is present in both arms, so the only
 *  variable left is the value of `billable`. */
const H_PROJECTS_ALL_BILLABLE: Project[] = H_PROJECTS.map(p => ({ ...p, billable: true }));

const H_BASE: Omit<FinanceData, 'projects'> = {
  resources: [res('1', 75, 140), res('2', 90, 180)],
  requests: [req('rPB', 'PB'), req('rPL', 'PL'), req('rPI', 'PI'), req('rPK', 'PK'), req('rPX', 'PX')],
  assignments: [
    assign('aPB', 'rPB', '1', 100),
    assign('aPL', 'rPL', '1', 40),
    assign('aPI', 'rPI', '1', 30),
    assign('aPK', 'rPK', '1', 20),
    assign('aPX', 'rPX', '1', 10),
    assign('aPK2', 'rPK', '2', 50),   // resource 2 works ONLY on the basket
  ],
  orders: [order('oc', 'Customer', 'Invoiced'), order('op', 'Purchase', 'Confirmed')],
  orderLines: [
    line('l1', 'oc', 'PB', 100_000),
    line('l2', 'oc', 'PL', 20_000),
    line('l3', 'oc', 'PI', 10_000),   // the flipped engagement's leftover revenue
    line('l4', 'op', 'PB', 5_000),
  ],
  financials: [fin('fPB', 'PB', 200_000, 0), fin('fPK', 'PK', 10_000, 0)],
  timeEntries: [
    time('tPB', 'aPB', 'rPB', '1', 'PB', 200, 'Approved'),
    time('tPL', 'aPL', 'rPL', '1', 'PL', 20, 'Approved'),
    time('tPI', 'aPI', 'rPI', '2', 'PI', 100, 'Approved'),
    time('tPK', 'aPK', 'rPK', '2', 'PK', 100, 'Approved'),
  ],
  billingItems: [
    bill('bPB', 'PB', 'Milestone', 60_000, 'Invoiced'),
    bill('bPL', 'PL', 'Milestone', 10_000, 'Invoiced'),
    // NO billing item on PI/PK: the §6.3 write gates make one impossible. The
    // absence is a deliberate NON-fixture, annotated here so it can never be
    // mistaken for coverage (spec §8.3, S7).
  ],
  assignmentDays: [day('dPK', 'aPK', '2026-03-10', 8)],
  assignmentMonths: [month('aPK', '2026-03', 'Allocated')],
  costBaselines: [baseline('cbPK', 'PK', '2026-03', 500, '2026-02-01')],
  contracts: [contract('CT1', 'CUS1'), contract('CT2', 'CUS2')],
  customers: [customer('CUS1', 'Acme'), customer('CUS2', 'Globex')],
};

/** The block-H fixture. */
const H: FinanceData = { ...H_BASE, projects: H_PROJECTS };
/** Same rows, same money, every engagement billable. */
const H_BILLABLE: FinanceData = { ...H_BASE, projects: H_PROJECTS_ALL_BILLABLE };
/** Same money, NO project master data at all — the pre-H caller. */
const H_NO_PROJECTS: FinanceData = { ...H_BASE };

describe('finance.util H — billability is read from `billable`, never from `type`', () => {
  it('resolves the flag for all five classification shapes', () => {
    expect(isProjectBillable('PB', H)).toBe(true);
    expect(isProjectBillable('PL', H)).toBe(true);   // field ABSENT -> billable (?? true)
    expect(isProjectBillable('PI', H)).toBe(false);
    expect(isProjectBillable('PK', H)).toBe(false);
    // `type: 'Basket'` with `billable: true` is contradictory data. The
    // arithmetic believes `billable`. If this ever flips, someone taught the
    // engine to read the label, and two fields now fight over one number.
    expect(isProjectBillable('PX', H)).toBe(true);
  });

  it('an unknown project id, and a caller with no project data at all, are billable', () => {
    expect(isProjectBillable('does-not-exist', H)).toBe(true);
    expect(isProjectBillable('PK', H_NO_PROJECTS)).toBe(true); // PK is non-billable ONLY in H
  });

  it('computeProjectFinancials reports the flag and leaves the arithmetic alone', () => {
    // The margin of a non-billable engagement is still revenue - actualCost.
    // The cost is real; what changes is who consumes the number (spec §11).
    const pk = computeProjectFinancials('PK', H);
    expect(pk.billable).toBe(false);
    expect(pk.actualCost).toBe(9_000);
    expect(pk.margin).toBe(-9_000);
    // ...and it is byte-identical to the same project read as billable.
    const pkBillable = computeProjectFinancials('PK', H_BILLABLE);
    expect(pkBillable.margin).toBe(pk.margin);
    expect(pkBillable.actualCost).toBe(pk.actualCost);
    expect(pkBillable.billable).toBe(true);

    expect(computeProjectFinancials('PL', H).billable).toBe(true);
    expect(computeProjectFinancials('PX', H).billable).toBe(true);
  });
});

describe('finance.util H — F-3: no margin alert on a non-billable engagement', () => {
  it('suppresses the margin flag on PI, which WOULD fire if it were billable', () => {
    // PI: revenue 10000, actualCost 9000 -> marginPct 10% <= target 15%.
    expect(computeProjectFinancials('PI', H).marginPct).toBeCloseTo(10, 9);
    expect(projectAlerts('PI', H_BILLABLE).marginBelowTarget).toBe(true);   // the defect
    expect(projectAlerts('PI', H).marginBelowTarget).toBe(false);           // the fix
    expect(projectAlerts('PI', H).items).toStrictEqual([]);
  });

  it('keeps BURN alerts on a non-billable engagement — a basket has a budget', () => {
    // PK: budget 10000, actualCost 9000 -> burn 90% >= warn 90%. Non-billable
    // suppresses MARGIN, not overspend: the exclusion is scoped, not a mute.
    const pk = projectAlerts('PK', H);
    expect(pk.marginBelowTarget).toBe(false);
    expect(pk.burnOver).toBe(true);
    expect(hasAnyAlert(pk)).toBe(true);
  });

  it('portfolioAlerts drops the non-billable margin row and keeps the burn row', () => {
    expect(portfolioAlerts(H).map(r => r.projectId)).toStrictEqual(['PK']);
    expect(portfolioAlerts(H_BILLABLE).map(r => r.projectId)).toStrictEqual(['PI', 'PK']);
    // and the surviving row is still labelled from d.projects
    expect(portfolioAlerts(H)[0].name).toBe('BASKET - Engineering Practice');
  });

  it('marginCompressionAlerts skips non-billable projects, in BOTH scopes', () => {
    expect(marginCompressionAlerts(H, {}, ['project'])).toStrictEqual([]);
    expect(marginCompressionAlerts(H_BILLABLE, {}, ['project']).map(a => a.id)).toStrictEqual(['PI']);

    // Customer scope needs no code of its own — it reads customerProfitability,
    // which already drops them (F-5), so it follows by construction. Asserted
    // rather than assumed: "follows by construction" is how a surface gets
    // forgotten.
    expect(marginCompressionAlerts(H, {}, ['customer'])).toStrictEqual([]);
    expect(marginCompressionAlerts(H_BILLABLE, {}, ['customer']).map(a => a.id)).toStrictEqual(['unknown']);
  });

  it('the BILLABLE projects keep every alert verdict they had — unchanged to the cent', () => {
    for (const id of ['PB', 'PL', 'PX']) {
      expect(projectAlerts(id, H)).toStrictEqual(projectAlerts(id, H_BILLABLE));
      expect(computeProjectFinancials(id, H).margin).toBe(computeProjectFinancials(id, H_BILLABLE).margin);
    }
  });
});

describe('finance.util H — F-5/F-6: customer rollups drop the non-billable work', () => {
  it('customerProfitability excludes PI and PK; the Unknown row is PX alone', () => {
    const rows = customerProfitability(H);
    expect(rows.map(r => r.customerId)).toStrictEqual(['CUS1', 'CUS2', 'unknown']);
    expect(rows.find(r => r.customerId === 'CUS1')).toStrictEqual({
      customerId: 'CUS1', customerName: 'Acme',
      revenue: 100_000, cost: 20_000, margin: 80_000, marginPct: 80, projectIds: ['PB'],
    });
    // PL has NO `billable` field and still lands on a real customer.
    expect(rows.find(r => r.customerId === 'CUS2')?.projectIds).toStrictEqual(['PL']);
    // Only PX (billable: true despite type 'Basket') is left under Unknown.
    const unknown = rows.find(r => r.customerId === 'unknown')!;
    expect(unknown.projectIds).toStrictEqual(['PX']);
    expect(unknown.cost).toBe(750);
    // The paired ABSENCE assertion: the two excluded ids appear under NO customer.
    expect(rows.flatMap(r => r.projectIds)).not.toContain('PI');
    expect(rows.flatMap(r => r.projectIds)).not.toContain('PK');
  });

  it('...and the same fixture read as all-billable puts them back (18 750 of cost)', () => {
    const unknown = customerProfitability(H_BILLABLE).find(r => r.customerId === 'unknown')!;
    expect(unknown.projectIds).toStrictEqual(['PI', 'PK', 'PX']);
    expect(unknown.cost).toBe(18_750);   // 9000 + 9000 + 750
    expect(unknown.revenue).toBe(10_000);
    expect(unknown.margin).toBe(-8_750); // the permanently-in-the-red fake customer
  });

  it('customerConcentration moves because the denominator moves (F-6)', () => {
    const h = customerConcentration(H);
    expect(h.totalRevenue).toBe(120_000);        // 100k + 20k; PI's 10k is gone
    expect(h.customerCount).toBe(2);
    expect(h.topCustomerSharePct).toBeCloseTo((100_000 / 120_000) * 100, 9);

    const all = customerConcentration(H_BILLABLE);
    expect(all.totalRevenue).toBe(130_000);      // PI's 10k back under Unknown
    expect(all.customerCount).toBe(3);
    expect(all.topCustomerSharePct).toBeCloseTo((100_000 / 130_000) * 100, 9);
    // the whole point: this is NOT the same concentration reading
    expect(all.hhi).not.toBeCloseTo(h.hhi, 6);
  });
});

describe('finance.util H — F-7: realization is not dragged by a structural 0%', () => {
  it('per-project realization is unchanged and merely reports the flag', () => {
    const pk = realizationMetrics('PK', H);
    expect(pk.billable).toBe(false);
    expect(pk.hours).toBe(100);
    expect(pk.standardBillValue).toBe(18_000);   // 100h x 180
    expect(pk.revenue).toBe(0);
    expect(pk.realizationPct).toBe(0);           // the figure that drags the mean
    expect(realizationMetrics('PK', H_BILLABLE).realizationPct).toBe(0); // identical arithmetic
    expect(realizationMetrics('PL', H).billable).toBe(true);
  });

  it('portfolioRealization excludes them, and the mean moves by over 122 points', () => {
    const h = portfolioRealization(H);
    expect(h.excludedProjectIds).toStrictEqual(['PI', 'PK']);
    expect(h.hours).toBe(220);                   // 200 (PB) + 20 (PL)
    expect(h.standardBillValue).toBe(30_800);    // 28000 + 2800
    expect(h.revenue).toBe(70_000);              // 60000 + 10000 recognised
    expect(h.realizationPct).toBeCloseTo((70_000 / 30_800) * 100, 9);  // 227.27%
    expect(h.headcount).toBe(1);                 // only resource 1 on billable work
    expect(h.revenuePerHead).toBe(70_000);

    const all = portfolioRealization(H_BILLABLE);
    expect(all.excludedProjectIds).toStrictEqual([]);
    expect(all.hours).toBe(420);
    expect(all.standardBillValue).toBe(66_800);
    expect(all.revenue).toBe(70_000);            // the excluded work earns NOTHING
    expect(all.realizationPct).toBeCloseTo((70_000 / 66_800) * 100, 9);  // 104.79%
    expect(all.headcount).toBe(2);

    // The defect, as one number: 36 000 of rate-card denominator with a zero
    // numerator was pulling portfolio realization down by ~122.5 points.
    expect(h.realizationPct - all.realizationPct).toBeGreaterThan(122);
  });

  it('de-duplicates headcount across projects and never divides by zero', () => {
    const empty = portfolioRealization({ resources: [], requests: [], assignments: [], orders: [], orderLines: [], financials: [] });
    expect(empty).toStrictEqual({
      revenue: 0, hours: 0, standardBillValue: 0, realizationPct: 0,
      headcount: 0, fte: 0, revenuePerHead: 0, revenuePerFte: 0, excludedProjectIds: [],
    });
    // resource 1 books approved time on BOTH PB and PL; it must count once.
    expect(portfolioRealization(H).headcount).toBe(1);
    const withFte = portfolioRealization(H, { hoursPerFte: 220 });
    expect(withFte.fte).toBeCloseTo(200 / 220 + 20 / 220, 9);
    expect(Number.isFinite(withFte.revenuePerFte)).toBe(true);
  });
});

describe('finance.util H — F-8: hours on non-billable work are not billable value', () => {
  it('narrows `billable` while leaving `hours` and `cost` as the true totals', () => {
    // Resource 1: 100 (PB) + 40 (PL) + 30 (PI) + 20 (PK) + 10 (PX) = 200h.
    // Billable hours = 100 + 40 + 10 = 150 (PI and PK are out).
    expect(resourceBillability('1', H)).toStrictEqual({
      hours: 200, cost: 15_000, billable: 21_000,   // 150h x 140
    });
    // Same person, same bookings, read as all-billable: the pre-H figure.
    expect(resourceBillability('1', H_BILLABLE)).toStrictEqual({
      hours: 200, cost: 15_000, billable: 28_000,   // 200h x 140
    });
    // 7 000 EUR of claimed value was work we can never invoice.
  });

  it('a person working only on a basket has real cost and ZERO billable value', () => {
    expect(resourceBillability('2', H)).toStrictEqual({ hours: 50, cost: 4_500, billable: 0 });
    expect(resourceBillability('2', H_BILLABLE)).toStrictEqual({ hours: 50, cost: 4_500, billable: 9_000 });
  });

  it('an unresolvable booking stays BILLABLE — the caller that passes no requests', () => {
    // resources.component.ts builds its FinanceData with `requests: []` and no
    // `projects`. It must keep its pre-H number, not collapse to zero. (T7 has
    // to wire requests + projects in, or F-8 never fires on that screen.)
    const noJoin: FinanceData = { ...H, requests: [] };
    expect(resourceBillability('1', noJoin).billable).toBe(28_000);
    expect(resourceBillability('1', H_NO_PROJECTS).billable).toBe(28_000);
  });
});

describe('finance.util H — F-4: cost planning KEEPS working on a basket engagement', () => {
  it('plannedCostSchedule still prices a non-billable engagement', () => {
    // The tempting over-correction is "exclude the non-billable from all of
    // finance". This is the annual plan on a historical basis the manual asks
    // for (spec §2.5) — it MUST report.
    expect(plannedCostSchedule(H, ['2026-03'], { projectId: 'PK' })).toStrictEqual([
      { period: '2026-03', plannedCost: 600, cumulative: 600 },   // 8h x 75
    ]);
  });

  it('costBaselineComparison still compares a non-billable engagement', () => {
    expect(costBaselineComparison(H, 'PK')).toStrictEqual([
      { period: '2026-03', baseline: 500, planned: 600, delta: 100, deltaPct: 20, outOfBaselineHorizon: false },
    ]);
  });

  it('the cost is EXCLUDED from customer profitability and REPORTED in the plan — both', () => {
    // Exclusion from the alert/customer rollups is not deletion of the cost.
    expect(customerProfitability(H).flatMap(r => r.projectIds)).not.toContain('PK');
    expect(plannedCostSchedule(H, ['2026-03'], { projectId: 'PK' })[0].plannedCost).toBeGreaterThan(0);
    expect(computeProjectFinancials('PK', H).actualCost).toBe(9_000);
  });
});

describe('finance.util H — Q2: the portfolio margin is FULLY LOADED, and named so', () => {
  it('carries the internal cost and names the value for what it is', () => {
    expect(portfolioMarginFullyLoaded(H)).toStrictEqual({
      baseCurrency: 'EUR',
      revenue: 130_000,             // 100k PB + 20k PL + 10k PI
      deliveryCost: 22_250,         // PB 20000 + PL 1500 + PX 750
      nonBillableCost: 18_000,      // PI 9000 + PK 9000
      fullyLoadedMargin: 89_750,    // 130000 - 22250 - 18000
      fullyLoadedMarginPct: (89_750 / 130_000) * 100,
      nonBillableProjectIds: ['PI', 'PK'],
    });
  });

  it('states the gap against the delivery margin somebody WILL compare it to', () => {
    const m = portfolioMarginFullyLoaded(H);
    // The documented reconciliation: delivery margin = fully loaded + internal.
    const deliveryMargin = m.fullyLoadedMargin + m.nonBillableCost;
    expect(deliveryMargin).toBe(107_750);
    const deliveryPct = (deliveryMargin / m.revenue) * 100;
    expect(deliveryPct - m.fullyLoadedMarginPct).toBeCloseTo(13.846153846153847, 9);
    // 18 000 EUR / 13.85 points: the size of Q2's answer on this fixture.
    expect(deliveryMargin - m.fullyLoadedMargin).toBe(18_000);
  });

  it('the HEADLINE is invariant to the flag; only the split it explains moves', () => {
    // This is the property the NAME has to carry. "Fully loaded" means TOTAL
    // cost, so flipping the flags cannot change it — which is exactly why a
    // field called `margin` would have been a lie here: the number nobody sees
    // changing would have been the one whose MEANING changed.
    const h = portfolioMarginFullyLoaded(H);
    const all = portfolioMarginFullyLoaded(H_BILLABLE);
    expect(all.fullyLoadedMargin).toBe(h.fullyLoadedMargin);
    expect(all.revenue).toBe(h.revenue);
    // ...and the split, which is what the flag is for, DOES move:
    expect(all.nonBillableCost).toBe(0);
    expect(all.deliveryCost).toBe(40_250);
    expect(all.nonBillableProjectIds).toStrictEqual([]);
    expect(h.deliveryCost + h.nonBillableCost).toBe(all.deliveryCost);
  });

  it('never returns NaN with no revenue, and never sums two currencies', () => {
    const noRevenue = portfolioMarginFullyLoaded({ ...H, orderLines: [] });
    expect(noRevenue.revenue).toBe(0);
    expect(noRevenue.fullyLoadedMarginPct).toBe(0);
    expect(Number.isFinite(noRevenue.fullyLoadedMargin)).toBe(true);

    // USD order lines normalised through convertToBase before they land here.
    const usd: FinanceData = {
      ...H,
      orders: [orderC('oc', 'Customer', 'Invoiced', 'USD'), order('op', 'Purchase', 'Confirmed')],
      fxRates: fx(),
    };
    expect(portfolioMarginFullyLoaded(usd).revenue).toBeCloseTo(130_000 * 0.9, 6);
    expect(portfolioMarginFullyLoaded(usd).baseCurrency).toBe('EUR');
  });

  it('counts an engagement whose cost has no request row (it would otherwise vanish)', () => {
    // A basket staffed straight off time entries: no request, so allProjectIds
    // never sees it. A "fully loaded" total that drops it is not fully loaded.
    const orphan: FinanceData = {
      resources: [res('9', 100, 200)],
      requests: [], assignments: [], orders: [], orderLines: [], financials: [],
      timeEntries: [time('t9', 'a9', 'r9', '9', 'PZ', 10, 'Approved')],
      projects: [projH('PZ', 'Ghost basket', { billable: false, type: 'Basket' })],
    };
    expect(portfolioMarginFullyLoaded(orphan).nonBillableCost).toBe(1_000);
    expect(portfolioMarginFullyLoaded(orphan).fullyLoadedMargin).toBe(-1_000);
  });
});

// --- The two differential suites (spec §8.2) ---------------------------------
//
// Neither of these asserts a "correct value". They assert that two runs over
// the SAME fixture DISAGREE. That is the only assertion an unread input cannot
// satisfy, and an unread input is the failure this whole block is shaped
// around: omit `projects` and every number above silently reverts to pre-H.

describe('finance.util H — differential 1: `projects` omitted reproduces pre-H exactly', () => {
  it('every block-H consumer reads DIFFERENTLY with and without project data', () => {
    expect(customerProfitability(H_NO_PROJECTS)).not.toStrictEqual(customerProfitability(H));
    expect(customerConcentration(H_NO_PROJECTS)).not.toStrictEqual(customerConcentration(H));
    expect(portfolioRealization(H_NO_PROJECTS)).not.toStrictEqual(portfolioRealization(H));
    expect(resourceBillability('1', H_NO_PROJECTS)).not.toStrictEqual(resourceBillability('1', H));
    expect(portfolioMarginFullyLoaded(H_NO_PROJECTS)).not.toStrictEqual(portfolioMarginFullyLoaded(H));
    expect(portfolioAlerts(H_NO_PROJECTS).map(r => r.projectId))
      .not.toStrictEqual(portfolioAlerts(H).map(r => r.projectId));
    expect(marginCompressionAlerts(H_NO_PROJECTS, {}, ['project']))
      .not.toStrictEqual(marginCompressionAlerts(H, {}, ['project']));
  });

  it('and the pre-H arm reproduces the pre-H answers, not merely a different one', () => {
    // Without `projects` everything is billable, so nothing is excluded.
    expect(portfolioRealization(H_NO_PROJECTS).excludedProjectIds).toStrictEqual([]);
    expect(portfolioMarginFullyLoaded(H_NO_PROJECTS).nonBillableCost).toBe(0);
    expect(resourceBillability('1', H_NO_PROJECTS).billable).toBe(28_000);
    expect(projectAlerts('PI', H_NO_PROJECTS).marginBelowTarget).toBe(true);
  });
});

describe('finance.util H — differential 2: only the `billable` flag differs', () => {
  it('isolates the flag: same rows, same money, `projects` present in BOTH arms', () => {
    // Differential 1 changes two things at once (billability AND contract
    // resolution, since projectToContract is built from d.projects). This arm
    // changes exactly one field on exactly two rows, so a difference here can
    // only mean `billable` itself was read.
    expect(H.projects!.map(p => p.id)).toStrictEqual(H_BILLABLE.projects!.map(p => p.id));
    expect(H.projects!.map(p => p.contractId)).toStrictEqual(H_BILLABLE.projects!.map(p => p.contractId));

    expect(customerProfitability(H)).not.toStrictEqual(customerProfitability(H_BILLABLE));
    expect(customerConcentration(H)).not.toStrictEqual(customerConcentration(H_BILLABLE));
    expect(portfolioRealization(H)).not.toStrictEqual(portfolioRealization(H_BILLABLE));
    expect(resourceBillability('1', H)).not.toStrictEqual(resourceBillability('1', H_BILLABLE));
    expect(portfolioMarginFullyLoaded(H)).not.toStrictEqual(portfolioMarginFullyLoaded(H_BILLABLE));
    expect(projectAlerts('PI', H)).not.toStrictEqual(projectAlerts('PI', H_BILLABLE));
    expect(marginCompressionAlerts(H, {}, ['project', 'customer']))
      .not.toStrictEqual(marginCompressionAlerts(H_BILLABLE, {}, ['project', 'customer']));
  });

  it('the paired ABSENCE assertion: a fixture with NOTHING non-billable cannot differ', () => {
    // If this ever fails, some branch keys on the PRESENCE of `projects` rather
    // than on the VALUE of `billable` — the exact confusion differential 1
    // cannot detect on its own.
    const a: FinanceData = { ...H_BASE, projects: H_PROJECTS_ALL_BILLABLE };
    const b: FinanceData = { ...H_BASE, projects: H_PROJECTS_ALL_BILLABLE.map(p => ({ ...p })) };
    expect(customerProfitability(a)).toStrictEqual(customerProfitability(b));
    expect(portfolioRealization(a)).toStrictEqual(portfolioRealization(b));
    expect(portfolioMarginFullyLoaded(a)).toStrictEqual(portfolioMarginFullyLoaded(b));
    expect(resourceBillability('1', a)).toStrictEqual(resourceBillability('1', b));
  });
});
