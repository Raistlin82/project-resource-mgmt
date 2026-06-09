import {
  computeProjectFinancials,
  resourceBillability,
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
  effectiveBudgetForProject,
  expenseCostForProject,
  marginDrivers,
  projectAlerts,
  portfolioAlerts,
  convertToBase,
  portfolioTotalsInBase,
  FinanceData,
} from './finance.util';
import { Resource, ResourceRequest, Assignment, Order, OrderLine, FinancialItem, TimeEntry, BillingPlanItem, Contract, Customer, Milestone, ChangeRequest, Project, FxRate } from './api.service';

function res(id: string, costRate: number, billRate: number): Resource {
  return { id, name: `R${id}`, role: 'Dev', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate, billRate };
}
function req(id: string, projectId: string): ResourceRequest {
  return { id, name: `Req${id}`, requiredRole: 'Dev', requiredEffort: 0, status: 'Open', skills: [], projectId };
}
function assign(id: string, requestId: string, resourceId: string, hours: number): Assignment {
  return { id, requestId, resourceId, assignedHours: hours, status: 'hard-booked' };
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

  it('adds only APPROVED change-request impactBudget to the effective budget', () => {
    const d: FinanceData = {
      ...data,
      changeRequests: [
        cr('c1', 'P', 'Approved', 5000),
        cr('c2', 'P', 'Approved', 2500),
        cr('c3', 'P', 'Submitted', 9999), // not approved -> ignored
        cr('c4', 'P', 'Rejected', 9999),  // not approved -> ignored
        cr('c5', 'Q', 'Approved', 1000),  // other project -> ignored
      ],
    };
    expect(approvedChangeBudgetForProject('P', d)).toBe(7500);
    expect(effectiveBudgetForProject('P', d)).toBe(37500); // 30000 + 7500
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
    // labor 7500 (planned fallback, no time entries) + external 3000 = actualCost 10500; etc 7500; eac 18000
    expect(f.eac).toBe(18000);
    expect(f.varianceAtCompletion).toBe(9000 - 18000); // -9000
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
    // EAC for P with no time entries = actualCost 10500 + ETC 7500 = 18000
    const tight: FinanceData = { ...data, financials: [fin('f1', 'P', 8000, 0)] };
    expect(projectAlerts('P', tight).eacOverBudget).toBe(true);
    const withCr: FinanceData = { ...tight, changeRequests: [cr('c1', 'P', 'Approved', 12000)] }; // 8000 -> 20000 > 18000
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
