import { describe, expect, it } from 'vitest';
import type { Order } from '../app/services/api.service';
import { InMemoryRepository } from '../db/repository';
import {
  InvoiceNumberCoordinator,
  type InvoiceNumberContext,
  type InvoiceNumberTransactionRunner,
} from './invoice-number.util';

function order(id: string, invoiceNumber?: string): Order {
  return {
    id,
    contractId: 'CT1',
    type: 'Customer',
    amount: 100,
    currency: 'EUR',
    status: 'Invoiced',
    orderDate: '2026-01-01',
    invoiceNumber,
  };
}

function harness(seed: readonly Order[] = []) {
  const orders = new InMemoryRepository<Order>(seed);
  const context: InvoiceNumberContext = { orders };
  const runner: InvoiceNumberTransactionRunner<InvoiceNumberContext> = async (_lockKey, operation) => operation(context);
  const coordinator = new InvoiceNumberCoordinator(runner);
  const allocate = (invoiceDate: string, id: string) => coordinator.run(
    invoiceDate,
    async (_repositories, invoiceNumber) => {
      await orders.create(order(id, invoiceNumber));
      return invoiceNumber;
    },
  );
  return { allocate, orders };
}

/** Simulates the transaction-scoped advisory lock shared by distinct workers. */
function sharedLockRunner<C>(context: C): InvoiceNumberTransactionRunner<C> {
  const tails = new Map<string, Promise<void>>();
  return async (lockKey, operation) => {
    const previous = tails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    tails.set(lockKey, tail);
    await previous;
    try {
      return await operation(context);
    } finally {
      release();
      if (tails.get(lockKey) === tail) tails.delete(lockKey);
    }
  };
}

describe('InvoiceNumberCoordinator', () => {
  it('serializes two concurrent allocations against the same shared store', async () => {
    const { allocate } = harness([order('seed', 'INV-2026-0001')]);

    const numbers = await Promise.all([
      allocate('2026-08-04', 'A'),
      allocate('2026-08-04', 'B'),
    ]);

    expect(numbers).toEqual(['INV-2026-0002', 'INV-2026-0003']);
    expect(new Set(numbers).size).toBe(2);
  });

  it('coordinates two allocator instances through the shared per-year transaction lock', async () => {
    const orders = new InMemoryRepository<Order>([order('seed', 'INV-2026-0001')]);
    const runner = sharedLockRunner<InvoiceNumberContext>({ orders });
    const workerA = new InvoiceNumberCoordinator(runner);
    const workerB = new InvoiceNumberCoordinator(runner);
    const allocate = (worker: InvoiceNumberCoordinator<InvoiceNumberContext>, id: string) => worker.run(
      '2026-08-04',
      async (_context, invoiceNumber) => {
        // Yield inside the read-max-write boundary to make overlap deterministic
        // if the shared transaction lock is removed.
        await Promise.resolve();
        await orders.create(order(id, invoiceNumber));
        return invoiceNumber;
      },
    );

    const numbers = await Promise.all([
      allocate(workerA, 'A'),
      allocate(workerB, 'B'),
    ]);

    expect(numbers).toEqual(['INV-2026-0002', 'INV-2026-0003']);
    expect(new Set(numbers).size).toBe(2);
  });

  it('derives an independent sequence from the invoice date year', async () => {
    const { allocate } = harness([
      order('old-1', 'INV-2026-0099'),
      order('new-1', 'INV-2027-0004'),
    ]);

    await expect(allocate('2026-12-31', 'A')).resolves.toBe('INV-2026-0100');
    await expect(allocate('2027-01-01', 'B')).resolves.toBe('INV-2027-0005');
  });

  it('does not burn a number after an in-memory write is compensated', async () => {
    const orders = new InMemoryRepository<Order>([order('seed', 'INV-2026-0001')]);
    const context: InvoiceNumberContext = { orders };
    const runner: InvoiceNumberTransactionRunner<InvoiceNumberContext> = async (_lockKey, operation) => operation(context);
    const coordinator = new InvoiceNumberCoordinator(runner);

    await expect(coordinator.run('2026-08-04', async (_repositories, invoiceNumber) => {
      await orders.create(order('failed-attempt', invoiceNumber));
      await orders.remove('failed-attempt');
      throw new Error('write failed');
    })).rejects.toThrow('write failed');

    await expect(coordinator.run('2026-08-04', async (_repositories, invoiceNumber) => {
      await orders.create(order('retry', invoiceNumber));
      return invoiceNumber;
    })).resolves.toBe('INV-2026-0002');
  });
});
