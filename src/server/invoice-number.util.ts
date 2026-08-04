import type { Order } from '../app/services/api.service';
import type { Repository } from '../db/repository';

export interface InvoiceNumberContext {
  orders: Pick<Repository<Order>, 'list'>;
}

export type InvoiceNumberTransactionRunner<C> = <R>(
  lockKey: string,
  operation: (context: C) => Promise<R>,
) => Promise<R>;

/** Four-digit invoice year from the server-owned invoice/issued date. */
export function invoiceYearFromDate(invoiceDate: string): string {
  const match = /^(\d{4})-/.exec(invoiceDate);
  if (!match) throw new Error('invoiceDate must start with a four-digit year');
  return match[1];
}

/** Next legal number for one year, derived from rows visible in the transaction. */
export function nextInvoiceNumberForYear(orders: readonly Order[], year: string): string {
  const pattern = new RegExp(`^INV-${year}-(\\d+)$`);
  let max = 0;
  for (const order of orders) {
    const match = order.invoiceNumber ? pattern.exec(order.invoiceNumber) : null;
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value > max) max = value;
  }
  return `INV-${year}-${String(max + 1).padStart(4, '0')}`;
}

/**
 * Coordinates invoice-number allocation with the write that consumes the number.
 * The transaction runner is supplied by the persistence composition root so the
 * same algorithm can use a PostgreSQL transaction in production and the shared
 * in-memory repositories in development.
 */
export class InvoiceNumberCoordinator<C extends InvoiceNumberContext> {
  /** Process-local serialization for the in-memory adapter and same-worker calls. */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly runTransaction: InvoiceNumberTransactionRunner<C>) {}

  async run<R>(
    invoiceDate: string,
    operation: (context: C, invoiceNumber: string) => Promise<R>,
  ): Promise<R> {
    const year = invoiceYearFromDate(invoiceDate);
    const lockKey = `invoice-number:${year}`;
    return this.withProcessLock(lockKey, () => this.runTransaction(lockKey, async context => {
      const invoiceNumber = nextInvoiceNumberForYear(await context.orders.list(), year);
      return operation(context, invoiceNumber);
    }));
  }

  /**
   * Serialize one year's read-max-write section inside this process. PostgreSQL
   * workers additionally serialize through the transaction runner's advisory
   * lock; development shares this coordinator with the in-memory repositories.
   */
  private async withProcessLock<R>(key: string, operation: () => Promise<R>): Promise<R> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
