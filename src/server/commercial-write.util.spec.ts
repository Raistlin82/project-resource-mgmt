import { describe, expect, it } from 'vitest';
import type { BillingPlanItem, Order, OrderLine, Project } from '../app/services/api.service';
import { InMemoryRepository } from '../db/repository';
import {
  billingPlanInvoicedFieldLockError,
  invoicedBillingItemDeleteError,
  issuedOrderDeleteError,
  issuedOrderFieldLockError,
  billingPlanCreateStatusError,
  billingPlanStatusTransitionError,
  createOrderWithLine,
  generateBillingInvoice,
  markBillingInvoicePaid,
  type OrderWithLineWriteDependencies,
} from './commercial-write.util';

class FailFirstBillingUpdateRepository extends InMemoryRepository<BillingPlanItem> {
  private shouldFail = true;

  override update(id: string, patch: Partial<BillingPlanItem>): Promise<BillingPlanItem | undefined> {
    if (this.shouldFail) {
      this.shouldFail = false;
      return Promise.reject(new Error('simulated billing update outage'));
    }
    return super.update(id, patch);
  }
}

class FailFirstOrderLineCreateRepository extends InMemoryRepository<OrderLine> {
  private shouldFail = true;

  override create(entity: OrderLine): Promise<OrderLine> {
    if (this.shouldFail) {
      this.shouldFail = false;
      return Promise.reject(new Error('simulated order-line outage'));
    }
    return super.create(entity);
  }
}

describe('commercial compound writes', () => {
  it('rolls back a generated order and line when billing update fails, then retries idempotently', async () => {
    const billingPlanItems = new FailFirstBillingUpdateRepository([{
      id: 'BP-READY',
      contractId: 'CT1',
      projectId: 'P1',
      type: 'Milestone',
      label: 'Acceptance',
      amount: 10_000,
      currency: 'EUR',
      status: 'Ready',
    }]);
    const orders = new InMemoryRepository<Order>();
    const orderLines = new InMemoryRepository<OrderLine>();
    const projects = new InMemoryRepository<Project>([{
      id: 'P1', name: 'Project one', location: 'Rome', startDate: '2026-01-01',
      endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
    }]);
    let createAttempts = 0;
    const dependencies = {
      billingPlanItems,
      orders,
      orderLines,
      projects,
      createInvoicedOrder: async (order: Order) => {
        createAttempts += 1;
        return orders.create({
          ...order,
          invoiceNumber: `INV-2026-${String(createAttempts).padStart(4, '0')}`,
          invoiceDate: '2026-08-04',
        });
      },
    };

    await expect(generateBillingInvoice(dependencies, 'BP-READY', '2026-08-04T10:00:00.000Z'))
      .rejects.toThrow('simulated billing update outage');
    expect(await orders.list()).toEqual([]);
    expect(await orderLines.list()).toEqual([]);
    expect(await billingPlanItems.get('BP-READY')).toMatchObject({ status: 'Ready' });
    expect((await billingPlanItems.get('BP-READY'))?.orderId).toBeUndefined();

    const retried = await generateBillingInvoice(dependencies, 'BP-READY', '2026-08-04T10:00:00.000Z');
    const replayed = await generateBillingInvoice(dependencies, 'BP-READY', '2026-08-04T10:00:00.000Z');

    expect(retried.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.order.id).toBe(retried.order.id);
    expect(replayed).toMatchObject({
      line: {
        id: 'BILLING-INVOICE-LINE:BP-READY',
        orderId: retried.order.id,
        projectId: 'P1',
        description: 'Acceptance',
        amount: 10_000,
      },
    });
    expect((await orders.list()).map(order => order.id)).toEqual([retried.order.id]);
    expect((await orderLines.list()).map(line => line.id)).toEqual(['BILLING-INVOICE-LINE:BP-READY']);
    expect(await billingPlanItems.get('BP-READY')).toMatchObject({
      status: 'Invoiced',
      orderId: retried.order.id,
      issuedDate: '2026-08-04T10:00:00.000Z',
    });
    expect(createAttempts).toBe(2);
  });

  it('compensates the order when generated line creation fails, then retries once', async () => {
    const billingPlanItems = new InMemoryRepository<BillingPlanItem>([{
      id: 'BP-LINE-FAIL', contractId: 'CT1', projectId: 'P1', type: 'Milestone',
      label: 'Go live', amount: 8_000, currency: 'EUR', status: 'Ready',
    }]);
    const orders = new InMemoryRepository<Order>();
    const orderLines = new FailFirstOrderLineCreateRepository();
    const projects = new InMemoryRepository<Project>([{
      id: 'P1', name: 'Project one', location: 'Rome', startDate: '2026-01-01',
      endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
    }]);
    const dependencies = {
      billingPlanItems,
      orders,
      orderLines,
      projects,
      createInvoicedOrder: (order: Order) => orders.create(order),
    };

    await expect(generateBillingInvoice(dependencies, 'BP-LINE-FAIL', '2026-08-04'))
      .rejects.toThrow('simulated order-line outage');
    expect(await orders.list()).toEqual([]);
    expect(await orderLines.list()).toEqual([]);
    expect(await billingPlanItems.get('BP-LINE-FAIL')).toMatchObject({ status: 'Ready' });

    const retried = await generateBillingInvoice(dependencies, 'BP-LINE-FAIL', '2026-08-04');
    const replayed = await generateBillingInvoice(dependencies, 'BP-LINE-FAIL', '2026-08-04');
    expect(retried.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(await orders.list()).toHaveLength(1);
    expect(await orderLines.list()).toHaveLength(1);
  });

  it.each([
    { type: 'Expense' as const, amount: 100, markupPct: 15, expected: 115 },
    { type: 'CreditNote' as const, amount: -80, markupPct: undefined, expected: -80 },
  ])('uses the domain invoice amount for $type', async ({ type, amount, markupPct, expected }) => {
    const billingPlanItems = new InMemoryRepository<BillingPlanItem>([{
      id: `BP-${type}`, contractId: 'CT1', projectId: 'P1', type,
      label: `${type} item`, amount, markupPct, currency: 'EUR', status: 'Ready',
    }]);
    const orders = new InMemoryRepository<Order>();
    const orderLines = new InMemoryRepository<OrderLine>();
    const projects = new InMemoryRepository<Project>([{
      id: 'P1', name: 'Project one', location: 'Rome', startDate: '2026-01-01',
      endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
    }]);

    const dependencies = {
      billingPlanItems,
      orders,
      orderLines,
      projects,
      createInvoicedOrder: (order: Order) => orders.create(order),
    };
    const result = await generateBillingInvoice(dependencies, `BP-${type}`, '2026-08-04');

    expect(result.order.amount).toBe(expected);
    expect(result).toMatchObject({ line: { amount: expected } });
  });

  it.each([
    { issuedDate: '2026-01-31T23:30:00.000Z', terms: 1, dueDate: '2026-02-01' },
    { issuedDate: '2026-12-20', terms: 15, dueDate: '2027-01-04' },
  ])('persists calendar due date $dueDate across date boundaries', async ({ issuedDate, terms, dueDate }) => {
    const billingPlanItems = new InMemoryRepository<BillingPlanItem>([{
      id: `BP-DUE-${terms}`, contractId: 'CT1', projectId: 'P1', type: 'TimeAndMaterials',
      label: 'Professional services', amount: 100, paymentTermsDays: terms,
      currency: 'EUR', status: 'Ready',
    }]);
    const orders = new InMemoryRepository<Order>();
    const orderLines = new InMemoryRepository<OrderLine>();
    const projects = new InMemoryRepository<Project>([{
      id: 'P1', name: 'Project one', location: 'Rome', startDate: '2026-01-01',
      endDate: '2027-12-31', status: 'Active', contractId: 'CT1',
    }]);
    const dependencies = {
      billingPlanItems,
      orders,
      orderLines,
      projects,
      createInvoicedOrder: (order: Order) => orders.create(order),
    };

    const result = await generateBillingInvoice(dependencies, `BP-DUE-${terms}`, issuedDate);

    expect(result.billingItem.dueDate).toBe(dueDate);
  });

  it('infers the only project on a contract when projectId is absent', async () => {
    const billingPlanItems = new InMemoryRepository<BillingPlanItem>([{
      id: 'BP-INFER', contractId: 'CT1', type: 'Recurring', recurrence: 'Monthly',
      label: 'Monthly service', amount: 500, currency: 'EUR', status: 'Ready',
    }]);
    const orders = new InMemoryRepository<Order>();
    const orderLines = new InMemoryRepository<OrderLine>();
    const projects = new InMemoryRepository<Project>([{
      id: 'P1', name: 'Only project', location: 'Rome', startDate: '2026-01-01',
      endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
    }]);
    const dependencies = {
      billingPlanItems,
      orders,
      orderLines,
      projects,
      createInvoicedOrder: (order: Order) => orders.create(order),
    };

    const result = await generateBillingInvoice(dependencies, 'BP-INFER', '2026-08-04');

    expect(result).toMatchObject({
      billingItem: { projectId: 'P1' },
      line: { projectId: 'P1' },
    });
  });

  it.each([
    {
      name: 'missing project attribution',
      item: { id: 'BP-NO-PROJECT', contractId: 'CT1', type: 'Milestone' as const, label: 'No project', amount: 100, currency: 'EUR', status: 'Ready' as const },
      projects: [] as Project[],
      error: 'projectId',
    },
    {
      name: 'project from another contract',
      item: { id: 'BP-WRONG-CONTRACT', contractId: 'CT1', projectId: 'P2', type: 'Milestone' as const, label: 'Wrong contract', amount: 100, currency: 'EUR', status: 'Ready' as const },
      projects: [{ id: 'P2', name: 'Other', location: 'Rome', startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active', contractId: 'CT2' } satisfies Project],
      error: 'same contract',
    },
  ])('rejects $name before creating invoice artifacts', async ({ item, projects: projectRows, error }) => {
    const billingPlanItems = new InMemoryRepository<BillingPlanItem>([item]);
    const orders = new InMemoryRepository<Order>();
    const orderLines = new InMemoryRepository<OrderLine>();

    const dependencies = {
      billingPlanItems,
      orders,
      orderLines,
      projects: new InMemoryRepository<Project>(projectRows),
      createInvoicedOrder: (order: Order) => orders.create(order),
    };
    await expect(generateBillingInvoice(dependencies, item.id, '2026-08-04')).rejects.toThrow(error);
    expect(await orders.list()).toEqual([]);
    expect(await orderLines.list()).toEqual([]);
  });

  it('rolls back an order when its project line fails, then replays one successful retry', async () => {
    const orders = new InMemoryRepository<Order>();
    const orderLines = new FailFirstOrderLineCreateRepository();
    let orderCreateAttempts = 0;
    const dependencies: OrderWithLineWriteDependencies = {
      orders,
      orderLines,
      // P1 must exist on CT1: createOrderWithLine validates the line's project
      // against the order's contract BEFORE it writes anything, so an empty
      // projects repo would fail attribution instead of reaching the rollback
      // path this test is about.
      projects: new InMemoryRepository<Project>([{
        id: 'P1', name: 'Alpha', location: 'Rome', startDate: '2026-01-01',
        endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
      }]),
      createOrder: async order => {
        orderCreateAttempts += 1;
        return orders.create(order);
      },
    };
    const request = {
      idempotencyKey: '6cb178f4-33f4-4798-8b9b-f63d47f109f5',
      order: {
        contractId: 'CT1',
        type: 'Customer' as const,
        amount: 4_000,
        currency: 'EUR',
        status: 'Open' as const,
        orderDate: '2026-08-04',
      },
      line: {
        projectId: 'P1',
        description: 'Implementation',
        amount: 4_000,
      },
    };

    await expect(createOrderWithLine(dependencies, request)).rejects.toThrow('simulated order-line outage');
    expect(await orders.list()).toEqual([]);
    expect(await orderLines.list()).toEqual([]);

    const retried = await createOrderWithLine(dependencies, request);
    const replayed = await createOrderWithLine(dependencies, request);

    expect(retried.replayed).toBe(false);
    expect(replayed.replayed).toBe(true);
    expect(replayed.order.id).toBe(retried.order.id);
    expect(replayed.line.id).toBe(retried.line.id);
    expect((await orders.list()).map(order => order.id)).toEqual([retried.order.id]);
    expect((await orderLines.list()).map(line => line.id)).toEqual([retried.line.id]);
    expect(orderCreateAttempts).toBe(2);
  });

  it('rejects a compound order line whose project belongs to another contract', async () => {
    const orders = new InMemoryRepository<Order>();
    const orderLines = new InMemoryRepository<OrderLine>();
    const projects = new InMemoryRepository<Project>([{
      id: 'P-OTHER', name: 'Other contract project', location: 'Rome',
      startDate: '2026-01-01', endDate: '2026-12-31', status: 'Active', contractId: 'CT2',
    }]);
    const dependencies = {
      orders,
      orderLines,
      projects,
      createOrder: (order: Order) => orders.create(order),
    };
    const request = {
      idempotencyKey: 'contract-mismatch-1',
      order: {
        contractId: 'CT1', type: 'Customer' as const, amount: 4_000,
        currency: 'EUR', status: 'Open' as const, orderDate: '2026-08-04',
      },
      line: { projectId: 'P-OTHER', description: 'Wrong project', amount: 4_000 },
    };

    await expect(createOrderWithLine(dependencies, request)).rejects.toThrow('same contract');
    expect(await orders.list()).toEqual([]);
    expect(await orderLines.list()).toEqual([]);
  });

  it('marks a billing item and linked order Paid atomically and replays the command', async () => {
    const billingPlanItems = new InMemoryRepository<BillingPlanItem>([{
      id: 'BP-PAID', contractId: 'CT1', projectId: 'P1', type: 'Milestone',
      label: 'Acceptance', amount: 10_000, currency: 'EUR', status: 'Invoiced',
      orderId: 'ORD-1', issuedDate: '2026-08-04', dueDate: '2026-09-03',
    }]);
    const orders = new InMemoryRepository<Order>([{
      id: 'ORD-1', contractId: 'CT1', type: 'Customer', amount: 10_000,
      currency: 'EUR', status: 'Invoiced', orderDate: '2026-08-04',
      invoiceNumber: 'INV-2026-0001', invoiceDate: '2026-08-04',
    }]);

    const paid = await markBillingInvoicePaid({ billingPlanItems, orders }, 'BP-PAID', '2026-09-01T10:00:00.000Z');
    const replayed = await markBillingInvoicePaid({ billingPlanItems, orders }, 'BP-PAID', '2026-09-02T10:00:00.000Z');

    expect(paid.replayed).toBe(false);
    expect(paid.billingItem).toMatchObject({ status: 'Paid', paidDate: '2026-09-01T10:00:00.000Z' });
    expect(paid.order.status).toBe('Paid');
    expect(replayed.replayed).toBe(true);
    expect(replayed.billingItem.paidDate).toBe('2026-09-01T10:00:00.000Z');
    expect((await billingPlanItems.get('BP-PAID'))?.status).toBe('Paid');
    expect((await orders.get('ORD-1'))?.status).toBe('Paid');
  });

  it('restores the linked order when the in-memory billing Paid update fails', async () => {
    const billingPlanItems = new FailFirstBillingUpdateRepository([{
      id: 'BP-PAY-FAIL', contractId: 'CT1', projectId: 'P1', type: 'Milestone',
      label: 'Acceptance', amount: 10_000, currency: 'EUR', status: 'Invoiced',
      orderId: 'ORD-FAIL', issuedDate: '2026-08-04',
    }]);
    const orders = new InMemoryRepository<Order>([{
      id: 'ORD-FAIL', contractId: 'CT1', type: 'Customer', amount: 10_000,
      currency: 'EUR', status: 'Invoiced', orderDate: '2026-08-04',
    }]);

    await expect(markBillingInvoicePaid(
      { billingPlanItems, orders },
      'BP-PAY-FAIL',
      '2026-09-01T10:00:00.000Z',
    )).rejects.toThrow('simulated billing update outage');
    expect((await billingPlanItems.get('BP-PAY-FAIL'))?.status).toBe('Invoiced');
    expect((await orders.get('ORD-FAIL'))?.status).toBe('Invoiced');

    await expect(markBillingInvoicePaid(
      { billingPlanItems, orders },
      'BP-PAY-FAIL',
      '2026-09-01T10:00:00.000Z',
    )).resolves.toMatchObject({ billingItem: { status: 'Paid' }, order: { status: 'Paid' } });
  });

  it('rejects mark-paid when the linked order belongs to another contract', async () => {
    const billingPlanItems = new InMemoryRepository<BillingPlanItem>([{
      id: 'BP-PAY-MISMATCH', contractId: 'CT1', projectId: 'P1', type: 'Milestone',
      label: 'Acceptance', amount: 10_000, currency: 'EUR', status: 'Invoiced',
      orderId: 'ORD-OTHER', issuedDate: '2026-08-04',
    }]);
    const orders = new InMemoryRepository<Order>([{
      id: 'ORD-OTHER', contractId: 'CT2', type: 'Customer', amount: 10_000,
      currency: 'EUR', status: 'Invoiced', orderDate: '2026-08-04',
    }]);

    await expect(markBillingInvoicePaid(
      { billingPlanItems, orders },
      'BP-PAY-MISMATCH',
      '2026-09-01T10:00:00.000Z',
    )).rejects.toThrow('same contract');
    expect((await billingPlanItems.get('BP-PAY-MISMATCH'))?.status).toBe('Invoiced');
    expect((await orders.get('ORD-OTHER'))?.status).toBe('Invoiced');
  });
});

describe('billingPlanStatusTransitionError', () => {
  it('refuses to reach Invoiced or Paid through a plain field update', () => {
    // Before this guard a client could PUT status:'Paid' onto a Planned item
    // with no orderId; BILLED_STATUSES then counted it as billed, moving the
    // Paid and Unbilled KPIs on a payment that never happened.
    expect(billingPlanStatusTransitionError('Planned', 'Paid'))
      .toContain('/mark-paid');
    expect(billingPlanStatusTransitionError('Ready', 'Invoiced'))
      .toContain('/generate-invoice');
    expect(billingPlanStatusTransitionError('Invoiced', 'Paid'))
      .toContain('/mark-paid');
  });

  it('allows every transition the server does not own', () => {
    expect(billingPlanStatusTransitionError('Planned', 'Ready')).toBeNull();
    expect(billingPlanStatusTransitionError('Ready', 'Blocked')).toBeNull();
    expect(billingPlanStatusTransitionError('Invoiced', 'Blocked')).toBeNull();
    // No status in the patch at all: an ordinary field update.
    expect(billingPlanStatusTransitionError('Invoiced', undefined)).toBeNull();
  });

  it('allows re-sending the status the item already has', () => {
    // The edit form re-PUTs every field, so an Invoiced row must stay editable.
    expect(billingPlanStatusTransitionError('Invoiced', 'Invoiced')).toBeNull();
    expect(billingPlanStatusTransitionError('Paid', 'Paid')).toBeNull();
  });
});

describe('billingPlanInvoicedFieldLockError', () => {
  /** An Invoiced condition, as `generateBillingInvoice` leaves it. */
  const invoiced = {
    id: 'BP1', contractId: 'C1', projectId: 'P1', type: 'Fixed', label: 'Phase 1',
    amount: 50000, markupPct: 0, currency: 'EUR', status: 'Invoiced' as const,
    orderId: 'BILLING-INVOICE:BP1', issuedDate: '2026-07-01', paymentTermsDays: 30,
  } as unknown as Pick<BillingPlanItem, 'status'> & Record<string, unknown>;

  it('refuses a changed amount on an already-invoiced condition', () => {
    // THE DEFECT. `billingPlanStatusTransitionError` returns null when the patch
    // carries no status (see 'allows every transition the server does not own'
    // above, which pins exactly that), so this PUT used to succeed: the row moved
    // to 999999 while the linked order kept 50000 under its issued invoiceNumber.
    const err = billingPlanInvoicedFieldLockError(invoiced, { amount: 999999 });
    expect(err).not.toBeNull();
    expect(err).toContain('amount');
    expect(err).toContain('Invoiced');
  });

  it('names every changed field, not just the first', () => {
    const err = billingPlanInvoicedFieldLockError(invoiced, { amount: 1, currency: 'USD', markupPct: 12 });
    expect(err).toContain('amount');
    expect(err).toContain('currency');
    expect(err).toContain('markupPct');
  });

  it('LEAVES THE LABEL EDITABLE on an invoiced condition', () => {
    // ASSERTION OF ABSENCE #4, and a real over-reach this caught. An early version of
    // BILLING_INVOICE_DEFINING_FIELDS included 'label' because it reaches the emitted
    // order line's description. That made a benign rename of an Invoiced row 409, and
    // scripts/smoke-api.mjs asserts exactly that rename still returns 200 — the edit
    // form re-PUTs every field. The guard refuses what changes the MONEY, not the
    // wording.
    expect(billingPlanInvoicedFieldLockError(invoiced, { status: 'Invoiced', label: 'Renamed condition' })).toBeNull();
  });

  it('refuses relinking or re-dating an issued condition', () => {
    expect(billingPlanInvoicedFieldLockError(invoiced, { orderId: 'ORD-OTHER' })).not.toBeNull();
    expect(billingPlanInvoicedFieldLockError(invoiced, { issuedDate: '2026-01-01' })).not.toBeNull();
    expect(billingPlanInvoicedFieldLockError(invoiced, { contractId: 'C2' })).not.toBeNull();
  });

  it('allows a full re-PUT that changes none of the locked values', () => {
    // ASSERTION OF ABSENCE #1. The edit form re-sends every field, and the
    // module's stated contract is that full-object updates of an Invoiced row keep
    // working. A guard keyed on "the field is PRESENT" rather than "its value
    // DIFFERS" passes every test above and bricks the form — this is the half
    // that catches it.
    expect(billingPlanInvoicedFieldLockError(invoiced, {
      contractId: 'C1', projectId: 'P1', type: 'Fixed', label: 'Phase 1',
      amount: 50000, markupPct: 0, currency: 'EUR', orderId: 'BILLING-INVOICE:BP1',
      issuedDate: '2026-07-01', paymentTermsDays: 30, status: 'Invoiced',
    })).toBeNull();
  });

  it('leaves notes writable on an invoiced condition', () => {
    // ASSERTION OF ABSENCE #2. `enforceCappedBilling` writes the
    // [CAP-EXCEEDED] marker into `notes` on EVERY billing PUT, including an
    // Invoiced one. Locking `notes` would make the server reject its own
    // automation, so the lock list must exclude it.
    expect(billingPlanInvoicedFieldLockError(invoiced, { notes: '[CAP-EXCEEDED] over cap' })).toBeNull();
  });

  it('does not fire for a condition the server does not own yet', () => {
    // ASSERTION OF ABSENCE #3. Planned/Ready/Blocked rows are ordinary editable
    // data; a guard that fired on them would freeze the whole billing plan.
    for (const status of ['Planned', 'Ready', 'Blocked'] as const) {
      expect(billingPlanInvoicedFieldLockError({ ...invoiced, status }, { amount: 999999 })).toBeNull();
    }
  });

  it('covers Paid as well as Invoiced', () => {
    expect(billingPlanInvoicedFieldLockError({ ...invoiced, status: 'Paid' }, { amount: 2 })).not.toBeNull();
  });
});

describe('issuedOrderDeleteError', () => {
  it('refuses to delete an order that carries an invoice number', () => {
    // THE DEFECT. Invoice numbers are assigned as max(existing) + 1, so they are
    // derived from the rows that still exist. DELETE /orders/:id had no read and no
    // status check, so deleting the order holding the highest number released that
    // legal number: the next invoice went out under a number a customer already had.
    const err = issuedOrderDeleteError({ invoiceNumber: 'INV-2026-0007', status: 'Invoiced' });
    expect(err).not.toBeNull();
    expect(err).toContain('INV-2026-0007');
    expect(err).toContain('credit note');
  });

  it('allows deleting an order that was never issued', () => {
    // ASSERTION OF ABSENCE. A blanket refusal passes the test above and makes every
    // un-issued order permanent. The discriminator is the invoice number, not the
    // status: an order can sit in Open or Confirmed with no document behind it.
    expect(issuedOrderDeleteError({ invoiceNumber: undefined, status: 'Open' })).toBeNull();
    expect(issuedOrderDeleteError({ invoiceNumber: undefined, status: 'Confirmed' })).toBeNull();
  });

  it('treats a null invoice number as not issued', () => {
    // The Postgres adapter emits null for a nullable column and nullsToUndefined
    // runs on the return path — but a row reaching this guard through another route
    // may still carry null, and `null === undefined` is false. Without the explicit
    // null branch an un-issued order would be undeletable under one adapter only:
    // exactly the dev/prod parity class CLAUDE.md warns about.
    expect(issuedOrderDeleteError({ invoiceNumber: null as unknown as undefined, status: 'Open' })).toBeNull();
  });
});

describe('invoicedBillingItemDeleteError', () => {
  it('refuses to delete a condition an invoice was issued against', () => {
    // Without this, billingPlanInvoicedFieldLockError has a second door: instead of
    // rewriting the billed amount, delete the row — which also orphans the linked
    // customer order and drops the amount out of every derived finance figure.
    expect(invoicedBillingItemDeleteError({ status: 'Invoiced' })).toContain('credit note');
    expect(invoicedBillingItemDeleteError({ status: 'Paid' })).toContain('credit note');
  });

  it('allows deleting a condition that was never invoiced', () => {
    // ASSERTION OF ABSENCE: the planning states stay fully editable and removable.
    for (const status of ['Planned', 'Ready', 'Blocked'] as const) {
      expect(invoicedBillingItemDeleteError({ status })).toBeNull();
    }
  });

  it('locks exactly the statuses the field lock locks', () => {
    // The delete guard and the field lock must cover the same set, or one of them
    // is the weaker door. Asserting them against each other is what pins that.
    for (const status of ['Planned', 'Ready', 'Blocked', 'Invoiced', 'Paid'] as const) {
      const fieldLocked = billingPlanInvoicedFieldLockError(
        { status, amount: 1 } as never, { amount: 2 },
      ) !== null;
      const deleteLocked = invoicedBillingItemDeleteError({ status }) !== null;
      expect(deleteLocked).toBe(fieldLocked);
    }
  });
});

describe('issuedOrderFieldLockError', () => {
  /** A Customer order as the invoice-numbering path leaves it. */
  const issued = {
    id: 'O1', contractId: 'CT1', type: 'Customer', amount: 200000, currency: 'EUR',
    status: 'Invoiced' as const, orderDate: '2026-02-01', invoiceNumber: 'INV-2026-0001',
  } as unknown as Parameters<typeof issuedOrderFieldLockError>[0];

  it('refuses to rewrite the money of an issued order', () => {
    // THE DEFECT, verified against the running server before the fix: a single
    // PUT {amount:1, currency:'USD', status:'Open'} returned 200 while the row kept
    // INV-2026-0001. `currency` reaches <Divisa> in the FatturaPA artifact under an
    // already-issued <Numero>.
    expect(issuedOrderFieldLockError(issued, { amount: 1 })).toContain('INV-2026-0001');
    expect(issuedOrderFieldLockError(issued, { currency: 'USD' })).toContain('credit note');
    expect(issuedOrderFieldLockError(issued, { contractId: 'CT9' })).not.toBeNull();
    expect(issuedOrderFieldLockError(issued, { orderDate: '2020-01-01' })).not.toBeNull();
  });

  it('refuses to walk an issued order back out of Invoiced/Paid', () => {
    // This is the half with the widest blast radius: the e-invoice export refuses any
    // order that is not Invoiced/Paid, so the document for a number the customer
    // already holds can no longer be produced — and portfolioTotalsInBase moves that
    // revenue out of invoiced and back into backlog.
    expect(issuedOrderFieldLockError(issued, { status: 'Open' })).toContain('cannot return to');
    expect(issuedOrderFieldLockError(issued, { status: 'Confirmed' })).not.toBeNull();
  });

  it('allows the legitimate Invoiced -> Paid move', () => {
    // ASSERTION OF ABSENCE #1: a guard that froze the status entirely would pass
    // every test above and make it impossible to ever record payment.
    expect(issuedOrderFieldLockError(issued, { status: 'Paid' })).toBeNull();
  });

  it('allows a full re-PUT that changes nothing', () => {
    // ASSERTION OF ABSENCE #2: same contract as the billing-item lock — only a
    // DIFFERENT value is refused, so an ordinary full-object update keeps working.
    expect(issuedOrderFieldLockError(issued, {
      contractId: 'CT1', type: 'Customer', amount: 200000, currency: 'EUR',
      status: 'Invoiced', orderDate: '2026-02-01',
    })).toBeNull();
  });

  it('does not constrain an order that was never issued', () => {
    // ASSERTION OF ABSENCE #3: the discriminator is the invoice number, not the
    // status. A blanket refusal would freeze every draft order in the system.
    const draft = { ...issued, invoiceNumber: undefined, status: 'Open' } as typeof issued;
    expect(issuedOrderFieldLockError(draft, { amount: 1, currency: 'USD', status: 'Confirmed' })).toBeNull();
    const nulled = { ...issued, invoiceNumber: null, status: 'Open' } as unknown as typeof issued;
    expect(issuedOrderFieldLockError(nulled, { amount: 1 })).toBeNull();
  });
});

describe('billingPlanCreateStatusError', () => {
  it('refuses a new condition minted directly into a terminal status', () => {
    // THE DEFECT, verified on the running server: POST with status:'Paid' and
    // amount 250000 returned 200. BILLED_STATUSES then counts it as billed and
    // collected — phantom revenue with no invoice, no order and no payment.
    expect(billingPlanCreateStatusError('Paid')).toContain('mark-paid');
    expect(billingPlanCreateStatusError('Invoiced')).toContain('generate-invoice');
  });

  it('allows every status a condition may legitimately start in', () => {
    // ASSERTION OF ABSENCE: the planning statuses are the normal create path, and an
    // omitted status must pass (the handler defaults it downstream).
    for (const status of ['Planned', 'Ready', 'Blocked'] as const) {
      expect(billingPlanCreateStatusError(status)).toBeNull();
    }
    expect(billingPlanCreateStatusError(undefined)).toBeNull();
  });

  it('locks exactly the statuses the PUT transition guard locks', () => {
    // The create and update guards must agree, or one verb is the weaker door —
    // which is precisely how this hole existed while the PUT was protected.
    for (const status of ['Planned', 'Ready', 'Blocked', 'Invoiced', 'Paid'] as const) {
      const createLocked = billingPlanCreateStatusError(status) !== null;
      const putLocked = billingPlanStatusTransitionError('Planned', status) !== null;
      expect(createLocked).toBe(putLocked);
    }
  });
});
