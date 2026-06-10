/**
 * CRM sync adapter — "WebhookJsonOutbox".
 *
 * Builds the exact JSON payload a CRM webhook WOULD receive and wraps it as an
 * outbox entry with status 'Prepared'. Nothing is ever sent: no network calls,
 * no credentials, no SDKs (`connected: false`, `mode: 'local-artifact'`). The
 * HTTP layer is expected to persist/return the entry; a future "connected"
 * implementation would drain the outbox.
 *
 * Purity contract: `buildSyncPayload` is a pure function of its input — it
 * never reads clocks (the caller supplies `preparedAt` as an ISO string),
 * never generates ids (`CrmOutboxEntry.id` is left for the persistence layer)
 * and never mutates its input. This keeps the spec fully deterministic.
 *
 * Shared types: the integration contracts (`IntegrationDescriptor`, the Crm*
 * payload shapes, `CrmSyncAdapter`) are consolidated in `./types` and
 * re-exported here so existing importers (incl. the spec) keep working.
 */
import type { Contract } from '../../app/services/api.service';
import type {
  CrmAccount,
  CrmDeal,
  CrmDealStage,
  CrmOrderSummary,
  CrmOutboxEntry,
  CrmSyncAdapter,
  CrmSyncInput,
  IntegrationDescriptor,
} from './types';

export type {
  CrmAccount,
  CrmDeal,
  CrmDealStage,
  CrmOrderSummary,
  CrmOutboxEntry,
  CrmSyncAdapter,
  CrmSyncInput,
  CrmSyncPayload,
  IntegrationDescriptor,
} from './types';

/**
 * How a contract's lifecycle status maps onto a CRM deal stage.
 * Exported so the spec (and any UI legend) can assert the mapping directly.
 */
export const CONTRACT_STATUS_TO_DEAL_STAGE: Readonly<Record<Contract['status'], CrmDealStage>> = {
  Draft: 'Negotiation',
  Active: 'Won',
  Closed: 'Closed',
};

/**
 * The single concrete CRM adapter: maps commercial entities to a CRM-shaped
 * JSON document and parks it in a 'Prepared' outbox entry.
 */
export class WebhookJsonOutboxCrmAdapter implements CrmSyncAdapter {
  describe(): IntegrationDescriptor {
    return {
      kind: 'crm',
      key: 'crm-webhook-json-outbox',
      name: 'WebhookJsonOutbox',
      description:
        'Builds the JSON payload a CRM webhook would receive (accounts from customers, ' +
        'deals from contracts joined with their orders) and stores it as a Prepared ' +
        'outbox entry. Local artifact only — nothing is ever transmitted.',
      connected: false,
      mode: 'local-artifact',
    };
  }

  buildSyncPayload(input: CrmSyncInput): CrmOutboxEntry {
    // Pre-bucket orders by contract id: one pass over orders, O(1) join below.
    const ordersByContract = new Map<string, CrmOrderSummary[]>();
    for (const order of input.orders) {
      const summary: CrmOrderSummary = {
        id: order.id,
        type: order.type,
        amount: order.amount,
        status: order.status,
      };
      const bucket = ordersByContract.get(order.contractId);
      if (bucket) {
        bucket.push(summary);
      } else {
        ordersByContract.set(order.contractId, [summary]);
      }
    }

    // Optional fields are spread conditionally so absent values produce absent
    // keys (not `undefined`), keeping the entry JSON-round-trip stable.
    const accounts: CrmAccount[] = input.customers.map((customer) => ({
      externalId: customer.id,
      name: customer.name,
      ...(customer.industry !== undefined ? { industry: customer.industry } : {}),
      ...(customer.country !== undefined ? { country: customer.country } : {}),
    }));

    const deals: CrmDeal[] = input.contracts.map((contract) => ({
      externalId: contract.id,
      accountExternalId: contract.customerId,
      name: contract.name,
      value: contract.totalValue,
      currency: contract.currency,
      stage: CONTRACT_STATUS_TO_DEAL_STAGE[contract.status],
      orders: ordersByContract.get(contract.id) ?? [],
    }));

    // `id` is intentionally omitted (not set to undefined): the persistence
    // layer assigns it, and omitting keeps JSON round-trips deep-equal.
    return {
      preparedAt: input.preparedAt,
      status: 'Prepared',
      target: 'webhook',
      payload: { accounts, deals },
    };
  }
}
