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

/**
 * The supported integration kinds.
 *
 * The first four are OUTBOUND: they turn data we hold into an artifact someone
 * else would consume. The last three are the ones RPT's own landscape needs and
 * are shaped differently on purpose:
 *
 *   inbound  — a payload arrives FROM an upstream master (Zucchetti, PCP,
 *              InforLN, People Portal, Skill Matrix) and we say what it WOULD
 *              change here. Nothing is written.
 *   demand   — a hiring / subcontractor requisition raised from a dummy, and
 *              the RES number that comes back and makes the dummy specific.
 *   email    — a notification that WOULD be sent to a named recipient.
 *
 * All seven are `connected: false`. Read that literally: no network, no
 * credentials, no vendor SDK, and — for `inbound` — no write either. The value
 * of building them anyway is that the MAPPING and the RULES are specified,
 * tested and reviewable now, so connecting one later is a transport change
 * rather than a design exercise.
 */
export type IntegrationKind = 'erp' | 'einvoice' | 'crm' | 'bi' | 'inbound' | 'demand' | 'email';

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

// ---------------------------------------------------------------------------
// Inbound master-data sources (kind: 'inbound') — RPT gap register, row 56
// ---------------------------------------------------------------------------
//
// RPT is fed by five upstream systems. We hold the same masters locally, so the
// question a seam has to answer is not "can we parse their file" but "what
// would this file DO to our data". That is what `previewImport` returns, and
// why it returns it instead of applying it.

/** The upstream systems RPT names, plus what each one owns. */
export type SourceSystemKey =
  | 'zucchetti'      // resource master + company organisation
  | 'skill-matrix'   // skills and proficiency per resource
  | 'pcp'            // project/commessa master + cost forecast
  | 'infor-ln'       // project/commessa master (ERP side)
  | 'people-portal'  // skills declared by the person
  | 'servicenow';    // hiring / subcontractor demand

/** Which local collection a feed lands in. Drives the preview's diff. */
export type InboundFeedTarget = 'resources' | 'projects' | 'skills';

/** Self-description of one upstream source and the feed it owns. */
export interface SourceSystemDescriptor {
  key: SourceSystemKey;
  name: string;
  /** What this system is the master OF, in one line. */
  owns: string;
  /** The local collection its records map onto. */
  target: InboundFeedTarget;
  /**
   * True when a normaliser exists for this system's payload shape. A source can
   * be DECLARED without being mappable yet — saying so is the honest state, and
   * far better than a normaliser that quietly invents a mapping.
   */
  mappable: boolean;
  /** Always false. Nothing is fetched, and nothing is written. */
  connected: false;
}

/** One upstream record, normalised onto our field names. */
export interface NormalisedRecord {
  /** Our id when the record resolves to a row we already hold. */
  id?: string;
  /** The upstream system's own key for this record, kept for traceability. */
  externalRef: string;
  /** Field values, already renamed onto our vocabulary. */
  fields: Record<string, string | number | boolean | null>;
}

/** What a record WOULD do, had the feed been applied. */
export type InboundEffect = 'create' | 'update' | 'unchanged' | 'rejected';

/** One record's verdict, with the reason when it is a rejection or an update. */
export interface InboundPreviewRow {
  externalRef: string;
  effect: InboundEffect;
  /** Our id for an update/unchanged row; absent for a create or a rejection. */
  id?: string;
  /** For 'update': the fields that would move, old -> new. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  /** For 'rejected': why, in a sentence a person can act on. */
  reason?: string;
}

/** The whole answer to "what would this feed do". */
export interface InboundPreview {
  system: SourceSystemKey;
  target: InboundFeedTarget;
  /** Always false — this is the shape of the guarantee, not a flag to flip. */
  applied: false;
  counts: Record<InboundEffect, number>;
  rows: InboundPreviewRow[];
}

/** Adapter interface for the inbound master-data kind. */
export interface InboundSourceAdapter {
  describe(): IntegrationDescriptor;
  /** The declared landscape: every system, whether or not it is mappable. */
  sources(): SourceSystemDescriptor[];
  /**
   * Normalise `payload` in `system`'s own shape onto our field names.
   * Throws for a system with no normaliser — `sources()` says which.
   */
  normalise(system: SourceSystemKey, payload: readonly Record<string, unknown>[]): NormalisedRecord[];
  /** What the normalised records WOULD change, against the rows we hold. */
  previewImport(
    system: SourceSystemKey,
    records: readonly NormalisedRecord[],
    current: readonly Record<string, unknown>[],
  ): InboundPreview;
}

// ---------------------------------------------------------------------------
// Hiring / subcontractor demand (kind: 'demand') — row 29
// ---------------------------------------------------------------------------

/** The dummy a demand is raised for. A subset, so a spec needs three fields. */
export interface DemandSubject {
  id: string;
  name: string;
  /** The placeholder code, e.g. `ZZ - Dummy - SAP - Associate PMO`. */
  code?: string;
  role?: string;
  organization?: string;
  kind?: 'internal' | 'dummy' | 'subco';
}

/** The requisition payload a demand portal would receive. */
export interface DemandRequest {
  externalRef: string;
  subjectId: string;
  /** The placeholder code at the time the demand was raised. */
  placeholderCode: string;
  role: string;
  practice: string;
  /** 'hiring' for an internal req, 'subcontract' for vendor capacity. */
  channel: 'hiring' | 'subcontract';
  /** ISO string supplied by the caller — the adapter never reads a clock. */
  raisedAt: string;
  status: 'Prepared';
}

/** The answer a demand portal sends back: a requisition number. */
export interface DemandFulfilment {
  /** The RES number, e.g. `RES0005555`. */
  resCode: string;
  /** The code the dummy should now carry, RES prefixed onto its description. */
  specificCode: string;
}

/** Adapter interface for the hiring-demand kind. */
export interface DemandAdapter {
  describe(): IntegrationDescriptor;
  /** Build the requisition a portal WOULD receive. Never transmitted. */
  buildDemand(subject: DemandSubject, raisedAt: string): DemandRequest;
  /**
   * Apply a RES number to a placeholder, turning a GENERIC dummy into a
   * SPECIFIC one. Pure: returns the new code, writes nothing.
   */
  applyResCode(subject: DemandSubject, resCode: string): DemandFulfilment;
}

// ---------------------------------------------------------------------------
// Notification outbox (kind: 'email') — row 43
// ---------------------------------------------------------------------------

/** What happened that is worth telling somebody about. */
export type NotificationEvent =
  | 'dummy-created'
  | 'subco-created'
  | 'basket-engagement-created'
  | 'approval-awaiting';

/** One message, fully rendered, addressed, and never sent. */
export interface OutboundMessage {
  /** Assigned by the persistence layer, never by the adapter. */
  id?: string;
  event: NotificationEvent;
  /** Recipient addresses, resolved by the CALLER from roles to people. */
  to: string[];
  subject: string;
  body: string;
  /** ISO string supplied by the caller. */
  preparedAt: string;
  /** Always 'Prepared'. There is no 'Sent' because nothing is sent. */
  status: 'Prepared';
}

/** The facts a message is rendered from. Plain data, no entities. */
export interface NotificationInput {
  event: NotificationEvent;
  to: string[];
  preparedAt: string;
  /** What the message is about: a resource name, a project name, an approval. */
  subjectName: string;
  /** Optional extra line — a code, a practice, an amount. */
  detail?: string;
}

/** Adapter interface for the notification kind. */
export interface NotificationAdapter {
  describe(): IntegrationDescriptor;
  buildMessage(input: NotificationInput): OutboundMessage;
}
