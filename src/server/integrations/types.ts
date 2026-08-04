/**
 * Shared types for the integration layer (SERVER-ONLY).
 *
 * DESIGN PRINCIPLE: every integration KIND has a typed adapter interface and
 * exactly ONE concrete implementation that produces a LOCAL ARTIFACT
 * (string/XML/CSV/JSON). Adapters are implemented and testable but NOT
 * connected to any external system: no network calls, no credentials, no
 * vendor SDKs. Each adapter self-describes via {@link IntegrationDescriptor}
 * with `connected: false` and `mode: 'local-artifact'`.
 *
 * This module is the single source of truth for the cross-adapter contracts
 * ({@link ExportArtifact}, {@link IntegrationDescriptor}) and for the four
 * per-kind adapter interfaces ({@link ErpExportAdapter},
 * {@link EInvoiceAdapter}, {@link CrmSyncAdapter}, {@link BiFeedAdapter}).
 * The concrete adapter modules import from here and re-export the types they
 * surface to their specs, so there is exactly one definition of each shape.
 */

import type { JournalEntry } from '../../app/services/finance.util';
import type { Contract, Customer, Order, OrderLine, Project } from '../../app/services/api.service';

// ---------------------------------------------------------------------------
// Cross-adapter contracts
// ---------------------------------------------------------------------------

/** The four supported integration kinds. */
export type IntegrationKind = 'erp' | 'einvoice' | 'crm' | 'bi';

/** Self-description every integration adapter must expose. */
export interface IntegrationDescriptor {
  /** Integration kind this adapter implements. */
  kind: IntegrationKind;
  /** Stable machine key of the concrete implementation (unique per kind). */
  key: string;
  /** Human-readable implementation name. */
  name: string;
  /** What the adapter produces and what it deliberately does NOT do. */
  description: string;
  /** Always false: local-artifact adapters never contact an external system. */
  connected: false;
  /** Discriminator: output is a local, inspectable artifact only. */
  mode: 'local-artifact';
}

/** A locally-built export file: name + MIME type + full textual content. */
export interface ExportArtifact {
  filename: string;
  mimeType: string;
  content: string;
}

// ---------------------------------------------------------------------------
// ERP / accounting GL export (kind: 'erp')
// ---------------------------------------------------------------------------

/** Output formats supported by the GL export. */
export type ErpExportFormat = 'csv' | 'json';

/** Options for {@link ErpExportAdapter.buildJournalExport}. Defaults to CSV. */
export interface ErpExportOptions {
  format?: ErpExportFormat;
}

/** Adapter interface for the ERP/accounting integration kind. */
export interface ErpExportAdapter {
  describe(): IntegrationDescriptor;
  buildJournalExport(entries: readonly JournalEntry[], opts?: ErpExportOptions): ExportArtifact;
}

// ---------------------------------------------------------------------------
// E-invoicing / FatturaPA (kind: 'einvoice')
// ---------------------------------------------------------------------------

/** Issuer (CedentePrestatore) master data. Local type — not a domain entity. */
export interface SupplierInfo {
  name: string;
  /** Italian VAT number (partita IVA), digits only preferred. */
  vatNumber: string;
  address: string;
  city: string;
  zip: string;
  /** ISO 3166-1 alpha-2, e.g. 'IT'. */
  country: string;
  /** SDI recipient code; defaults to '0000000' (PEC / unknown) when absent. */
  codiceDestinatario?: string;
}

/** Plain-data input for one e-invoice build. */
export interface EInvoiceBuildInput {
  order: Order;
  customer: Customer;
  /** ISO-2 code resolved from the country catalog when Customer stores a display name. */
  customerCountryCode?: string;
  contract?: Contract;
  lines: OrderLine[];
  supplier: SupplierInfo;
}

/** Typed adapter interface for the e-invoice integration kind. */
export interface EInvoiceAdapter {
  describe(): IntegrationDescriptor;
  buildInvoiceXml(input: EInvoiceBuildInput): ExportArtifact;
}

// ---------------------------------------------------------------------------
// CRM sync outbox (kind: 'crm')
// ---------------------------------------------------------------------------

/** CRM account record mapped from a {@link Customer}. */
export interface CrmAccount {
  externalId: string;
  name: string;
  industry?: string;
  country?: string;
}

/** CRM pipeline stage derived from {@link Contract.status}. */
export type CrmDealStage = 'Negotiation' | 'Won' | 'Closed';

/** Condensed view of an {@link Order} nested under its deal. */
export interface CrmOrderSummary {
  id: string;
  type: Order['type'];
  amount: number;
  status: Order['status'];
}

/** CRM deal mapped from a {@link Contract} joined with its {@link Order}s. */
export interface CrmDeal {
  externalId: string;
  /** FK join: `contract.customerId` → the account's `externalId`. */
  accountExternalId: string;
  name: string;
  value: number;
  currency: string;
  stage: CrmDealStage;
  /** FK join: all orders whose `contractId` equals this contract's id. */
  orders: CrmOrderSummary[];
}

/** The body a CRM webhook would receive. */
export interface CrmSyncPayload {
  accounts: CrmAccount[];
  deals: CrmDeal[];
}

/**
 * Outbox wrapper around the prepared payload. `status` is always 'Prepared' —
 * there is no 'Sent' in this implementation because nothing is ever sent.
 */
export interface CrmOutboxEntry {
  /** Assigned by the persistence layer, never by the adapter. */
  id?: string;
  /** ISO timestamp supplied by the caller (keeps the adapter pure). */
  preparedAt: string;
  status: 'Prepared';
  target: 'webhook';
  payload: CrmSyncPayload;
}

/** Plain-data input for one sync-payload build. */
export interface CrmSyncInput {
  customers: Customer[];
  contracts: Contract[];
  orders: Order[];
  /** Current timestamp as an ISO string, supplied at request time. */
  preparedAt: string;
}

/** Typed adapter interface for the CRM integration kind. */
export interface CrmSyncAdapter {
  describe(): IntegrationDescriptor;
  buildSyncPayload(input: CrmSyncInput): CrmOutboxEntry;
}

// ---------------------------------------------------------------------------
// BI connector feed (kind: 'bi')
// ---------------------------------------------------------------------------

/**
 * Flat per-project financial snapshot. The CALLER computes these values via
 * finance.util `computeProjectFinancials` and maps `varianceAtCompletion` to
 * `vac`; the BI adapter only formats.
 */
export interface ProjectFinancialsRow {
  projectId: string;
  projectName: string;
  status: string;
  revenue: number;
  actualCost: number;
  margin: number;
  marginPct: number;
  budget: number;
  eac: number;
  vac: number;
}

/** Plain-data input for one BI feed build. */
export interface BiFeedInput {
  /** Snapshot timestamp (ISO 8601 string), supplied by the caller. */
  generatedAt: string;
  projects: Project[];
  financials: ProjectFinancialsRow[];
}

/** BI tools ingest primitives only — no nested objects or arrays. */
export type BiFeedCellValue = string | number | boolean | null;
export type BiFeedRow = Record<string, BiFeedCellValue>;

/** The JSON document serialized into the BI artifact content. */
export interface BiFeedDocument {
  generatedAt: string;
  rowCount: number;
  rows: BiFeedRow[];
}

/** Typed adapter interface for the BI integration kind. */
export interface BiFeedAdapter {
  describe(): IntegrationDescriptor;
  buildFeed(input: BiFeedInput): ExportArtifact;
}
