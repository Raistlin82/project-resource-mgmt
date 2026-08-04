import { describe, expect, it } from 'vitest';
import type { BillingPlanItem, Order, OrderLine, Project } from '../app/services/api.service';
import { InMemoryRepository } from '../db/repository';
import {
  createOrderWithLine,
  generateBillingInvoice,
  markBillingInvoicePaid,
  type BillingInvoiceWriteDependencies,
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
