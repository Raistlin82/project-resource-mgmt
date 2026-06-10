/**
 * Integration adapter registry (SERVER-ONLY).
 *
 * One adapter per integration KIND, selected by env var with the single
 * existing implementation as the default:
 *
 *   kind       env var                       default key
 *   ---------  ----------------------------  -----------------------
 *   erp        INTEGRATION_ERP_ADAPTER       generic-ledger-export
 *   einvoice   INTEGRATION_EINVOICE_ADAPTER  fatturapa
 *   crm        INTEGRATION_CRM_ADAPTER       crm-webhook-json-outbox
 *   bi         INTEGRATION_BI_ADAPTER        json-feed
 *
 * An env var naming an UNKNOWN key falls back to the default (with a console
 * warning) rather than failing the boot — there is exactly one implementation
 * per kind today, so any other value is a misconfiguration.
 *
 * The registry is memoized: every caller shares the same adapter instances
 * for the lifetime of the process (adapters are stateless pure builders, so
 * sharing is safe).
 */

import { GenericLedgerExportAdapter } from './erp-ledger.adapter';
import { FatturaPaAdapter } from './fatturapa.adapter';
import { WebhookJsonOutboxCrmAdapter } from './crm-outbox.adapter';
import { JsonFeedBiAdapter } from './bi-feed.adapter';
import type {
  BiFeedAdapter,
  CrmSyncAdapter,
  EInvoiceAdapter,
  ErpExportAdapter,
  IntegrationDescriptor,
} from './types';

/** The active adapter per integration kind. */
export interface Integrations {
  erp: ErpExportAdapter;
  einvoice: EInvoiceAdapter;
  crm: CrmSyncAdapter;
  bi: BiFeedAdapter;
}

/** Available implementations per kind, keyed by their descriptor `key`. */
const ERP_IMPLS: Readonly<Record<string, () => ErpExportAdapter>> = {
  'generic-ledger-export': () => new GenericLedgerExportAdapter(),
};
const EINVOICE_IMPLS: Readonly<Record<string, () => EInvoiceAdapter>> = {
  'fatturapa': () => new FatturaPaAdapter(),
};
const CRM_IMPLS: Readonly<Record<string, () => CrmSyncAdapter>> = {
  'crm-webhook-json-outbox': () => new WebhookJsonOutboxCrmAdapter(),
};
const BI_IMPLS: Readonly<Record<string, () => BiFeedAdapter>> = {
  'json-feed': () => new JsonFeedBiAdapter(),
};

/**
 * Resolve one kind's adapter: the implementation named by `envVar` when known,
 * otherwise the default key (warning on an unknown explicit selection).
 */
function select<T>(
  impls: Readonly<Record<string, () => T>>,
  envVar: string,
  defaultKey: string,
): T {
  const requested = (process.env[envVar] ?? '').trim();
  if (requested !== '' && requested !== defaultKey && impls[requested] === undefined) {
    console.warn(
      `[integrations] ${envVar}='${requested}' is not a known adapter key; ` +
        `falling back to '${defaultKey}'. Known keys: ${Object.keys(impls).join(', ')}.`,
    );
  }
  const factory = impls[requested] ?? impls[defaultKey];
  return factory();
}

let cached: Integrations | undefined;

/** Build (once) and return the process-wide active adapters, one per kind. */
export function getIntegrations(): Integrations {
  if (!cached) {
    cached = {
      erp: select(ERP_IMPLS, 'INTEGRATION_ERP_ADAPTER', 'generic-ledger-export'),
      einvoice: select(EINVOICE_IMPLS, 'INTEGRATION_EINVOICE_ADAPTER', 'fatturapa'),
      crm: select(CRM_IMPLS, 'INTEGRATION_CRM_ADAPTER', 'crm-webhook-json-outbox'),
      bi: select(BI_IMPLS, 'INTEGRATION_BI_ADAPTER', 'json-feed'),
    };
  }
  return cached;
}

/** Self-descriptions of the four ACTIVE adapters (one per kind). */
export function listDescriptors(): IntegrationDescriptor[] {
  const integrations = getIntegrations();
  return [
    integrations.erp.describe(),
    integrations.einvoice.describe(),
    integrations.crm.describe(),
    integrations.bi.describe(),
  ];
}
