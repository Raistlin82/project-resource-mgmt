import {
  CONTRACT_STATUS_TO_DEAL_STAGE,
  WebhookJsonOutboxCrmAdapter,
  type CrmOutboxEntry,
  type CrmSyncInput,
} from './crm-outbox.adapter';
import type { Contract, Customer, Order } from '../../app/services/api.service';

/**
 * Unit tests for the WebhookJsonOutbox CRM adapter. Pure mapping logic, no
 * I/O, fully deterministic (preparedAt is injected by the caller).
 *
 * Test-runner conventions match src/db/repository.spec.ts: vitest globals
 * (`describe`/`it`/`expect`) provided via tsconfig.spec.json
 * (`"types": ["vitest/globals"]`); no per-file imports of the runner.
 */

const PREPARED_AT = '2026-06-10T12:00:00.000Z';

function customer(id: string, name: string, extra: Partial<Customer> = {}): Customer {
  return { id, name, ...extra };
}

function contract(id: string, customerId: string, extra: Partial<Contract> = {}): Contract {
  return {
    id,
    customerId,
    name: `Contract ${id}`,
    type: 'T&M',
    totalValue: 100_000,
    currency: 'EUR',
    status: 'Active',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    ...extra,
  };
}

function order(id: string, contractId: string, extra: Partial<Order> = {}): Order {
  return {
    id,
    contractId,
    type: 'Customer',
    amount: 10_000,
    currency: 'EUR',
    status: 'Open',
    orderDate: '2026-02-01',
    ...extra,
  };
}

function input(partial: Partial<CrmSyncInput> = {}): CrmSyncInput {
  return { customers: [], contracts: [], orders: [], preparedAt: PREPARED_AT, ...partial };
}

describe('WebhookJsonOutboxCrmAdapter', () => {
  const adapter = new WebhookJsonOutboxCrmAdapter();

  describe('describe()', () => {
    it('self-describes as a disconnected local-artifact CRM adapter', () => {
      const descriptor = adapter.describe();
      expect(descriptor.kind).toBe('crm');
      expect(descriptor.key).toBe('crm-webhook-json-outbox');
      expect(descriptor.name).toBe('WebhookJsonOutbox');
      expect(descriptor.description.length).toBeGreaterThan(0);
      expect(descriptor.connected).toBe(false);
      expect(descriptor.mode).toBe('local-artifact');
    });
  });

  describe('outbox envelope', () => {
    it('wraps the payload with status Prepared, target webhook and the caller-supplied preparedAt', () => {
      const entry = adapter.buildSyncPayload(input());
      expect(entry.status).toBe('Prepared');
      expect(entry.target).toBe('webhook');
      expect(entry.preparedAt).toBe(PREPARED_AT);
    });

    it('passes preparedAt through verbatim (no clock access)', () => {
      const other = '1999-12-31T23:59:59.999Z';
      expect(adapter.buildSyncPayload(input({ preparedAt: other })).preparedAt).toBe(other);
    });

    it('leaves id unset — assignment belongs to the persistence layer', () => {
      const entry = adapter.buildSyncPayload(input());
      expect(entry.id).toBeUndefined();
      // The key must be absent (not present-but-undefined) for stable JSON round-trips.
      expect(Object.keys(entry)).not.toContain('id');
    });
  });

  describe('empty input', () => {
    it('produces empty accounts and deals arrays', () => {
      const entry = adapter.buildSyncPayload(input());
      expect(entry.payload.accounts).toEqual([]);
      expect(entry.payload.deals).toEqual([]);
    });
  });

  describe('account mapping', () => {
    it('maps every customer to exactly one account with externalId/name/industry/country', () => {
      const entry = adapter.buildSyncPayload(
        input({
          customers: [
            customer('c1', 'Acme SpA', { industry: 'Manufacturing', country: 'IT' }),
            customer('c2', 'Globex GmbH', { industry: 'Energy', country: 'DE' }),
          ],
        }),
      );
      expect(entry.payload.accounts).toHaveLength(2);
      expect(entry.payload.accounts[0]).toEqual({
        externalId: 'c1',
        name: 'Acme SpA',
        industry: 'Manufacturing',
        country: 'IT',
      });
      expect(entry.payload.accounts[1]).toEqual({
        externalId: 'c2',
        name: 'Globex GmbH',
        industry: 'Energy',
        country: 'DE',
      });
    });

    it('omits optional industry/country keys when absent on the customer', () => {
      const entry = adapter.buildSyncPayload(input({ customers: [customer('c1', 'Acme SpA')] }));
      const account = entry.payload.accounts[0];
      expect(account).toEqual({ externalId: 'c1', name: 'Acme SpA' });
      expect(Object.keys(account)).toEqual(['externalId', 'name']);
    });

    it('preserves input order of customers', () => {
      const entry = adapter.buildSyncPayload(
        input({ customers: [customer('z', 'Zeta'), customer('a', 'Alpha')] }),
      );
      expect(entry.payload.accounts.map((a) => a.externalId)).toEqual(['z', 'a']);
    });
  });

  describe('deal mapping and FK joins', () => {
    it('maps every contract to exactly one deal, joined to its account via customerId', () => {
      const entry = adapter.buildSyncPayload(
        input({
          customers: [customer('c1', 'Acme SpA')],
          contracts: [
            contract('k1', 'c1', { name: 'Framework 2026', totalValue: 250_000, currency: 'EUR' }),
            contract('k2', 'c1', { name: 'Support Renewal', totalValue: 40_000, currency: 'USD' }),
          ],
        }),
      );
      expect(entry.payload.deals).toHaveLength(2);
      const [d1, d2] = entry.payload.deals;
      expect(d1.externalId).toBe('k1');
      expect(d1.accountExternalId).toBe('c1');
      expect(d1.name).toBe('Framework 2026');
      expect(d1.value).toBe(250_000);
      expect(d1.currency).toBe('EUR');
      expect(d2.externalId).toBe('k2');
      expect(d2.accountExternalId).toBe('c1');
      expect(d2.currency).toBe('USD');
    });

    it('nests each order under the deal matching its contractId (order -> contract join)', () => {
      const entry = adapter.buildSyncPayload(
        input({
          customers: [customer('c1', 'Acme SpA')],
          contracts: [contract('k1', 'c1'), contract('k2', 'c1')],
          orders: [
            order('o1', 'k1', { amount: 5_000, status: 'Invoiced' }),
            order('o2', 'k2', { amount: 7_500, type: 'Purchase' }),
            order('o3', 'k1', { amount: 1_250, status: 'Paid' }),
          ],
        }),
      );
      const [d1, d2] = entry.payload.deals;
      expect(d1.orders).toEqual([
        { id: 'o1', type: 'Customer', amount: 5_000, status: 'Invoiced' },
        { id: 'o3', type: 'Customer', amount: 1_250, status: 'Paid' },
      ]);
      expect(d2.orders).toEqual([{ id: 'o2', type: 'Purchase', amount: 7_500, status: 'Open' }]);
    });

    it('gives a contract with no orders an empty orders array', () => {
      const entry = adapter.buildSyncPayload(
        input({ customers: [customer('c1', 'Acme SpA')], contracts: [contract('k1', 'c1')] }),
      );
      expect(entry.payload.deals[0].orders).toEqual([]);
    });

    it('drops orders whose contractId matches no contract (no orphan deals invented)', () => {
      const entry = adapter.buildSyncPayload(
        input({
          customers: [customer('c1', 'Acme SpA')],
          contracts: [contract('k1', 'c1')],
          orders: [order('o1', 'k1'), order('o-orphan', 'k-missing')],
        }),
      );
      expect(entry.payload.deals).toHaveLength(1);
      expect(entry.payload.deals[0].orders.map((o) => o.id)).toEqual(['o1']);
    });

    it('still maps a contract whose customerId has no matching customer (FK carried as-is)', () => {
      const entry = adapter.buildSyncPayload(input({ contracts: [contract('k1', 'c-missing')] }));
      expect(entry.payload.accounts).toEqual([]);
      expect(entry.payload.deals).toHaveLength(1);
      expect(entry.payload.deals[0].accountExternalId).toBe('c-missing');
    });
  });

  describe('stage mapping', () => {
    it('derives the deal stage from contract.status for every status', () => {
      const entry = adapter.buildSyncPayload(
        input({
          contracts: [
            contract('k1', 'c1', { status: 'Draft' }),
            contract('k2', 'c1', { status: 'Active' }),
            contract('k3', 'c1', { status: 'Closed' }),
          ],
        }),
      );
      expect(entry.payload.deals.map((d) => d.stage)).toEqual(['Negotiation', 'Won', 'Closed']);
    });

    it('the exported mapping covers exactly the Contract statuses', () => {
      expect(CONTRACT_STATUS_TO_DEAL_STAGE).toEqual({
        Draft: 'Negotiation',
        Active: 'Won',
        Closed: 'Closed',
      });
    });
  });

  describe('serialisability and purity', () => {
    function fullInput(): CrmSyncInput {
      return input({
        customers: [
          customer('c1', 'Acme SpA', { industry: 'Manufacturing', country: 'IT' }),
          customer('c2', 'Globex GmbH'),
        ],
        contracts: [contract('k1', 'c1', { status: 'Draft' }), contract('k2', 'c2')],
        orders: [order('o1', 'k1'), order('o2', 'k2', { status: 'Paid' })],
      });
    }

    it('the entry survives a JSON round-trip deep-equal', () => {
      const entry = adapter.buildSyncPayload(fullInput());
      const roundTripped = JSON.parse(JSON.stringify(entry)) as CrmOutboxEntry;
      expect(roundTripped).toEqual(entry);
    });

    it('does not mutate its input', () => {
      const original = fullInput();
      const snapshot = JSON.parse(JSON.stringify(original)) as CrmSyncInput;
      adapter.buildSyncPayload(original);
      expect(original).toEqual(snapshot);
    });

    it('is deterministic: identical input produces identical output', () => {
      expect(adapter.buildSyncPayload(fullInput())).toEqual(adapter.buildSyncPayload(fullInput()));
    });
  });
});
