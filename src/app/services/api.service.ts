import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { API_BASE_URL } from './api-config';
import type { CapacityCell, CapacityRow, CapacityTotals } from './capacity.util';
import type { ResourceKind } from './resource-kind.util';
import type { OrgLevel } from './org-scope.util';
import type { NegotiatedRate } from './sell-rate.util';

export type { CapacityCell, CapacityRow, CapacityTotals, ResourceKind };
// Negotiated sell rate (design spec §3): the wire shape IS Task 1's pure-layer
// interface — re-exported rather than redeclared so the two never drift.
export type { NegotiatedRate } from './sell-rate.util';

export interface Resource {
  id: string;
  name: string;
  role: string;
  skills: { name: string; level: number }[];
  projectRoles: string[];
  externalExperience: { projectName: string; company: string; role: string; startDate: string; endDate: string; comment?: string }[];
  profilePicture?: string;
  resume?: string;
  utilization: number;
  capacity: number;
  managerId?: string;
  organization?: string;
  location?: string;
  /**
   * EFFECTIVE cost rate in **€/HOUR** (effective day rate ÷ hours-per-day),
   * resolved by the server on read. This is the value all margin math consumes
   * (cost = hours × costRate); treat it as read-only. Phase E + hybrid day model.
   */
  costRate?: number;
  /** EFFECTIVE bill rate in **€/HOUR** (effective day rate ÷ hours-per-day). */
  billRate?: number;
  /**
   * Per-resource MANUAL OVERRIDE of the role's rate card, in **€/DAY**. `null`/
   * `undefined` = inherit the card default. The form binds the Cost-rate (€/day)
   * input here; the server maps it onto the resources.cost_rate column. Phase E.
   */
  costRateOverride?: number | null;
  /** Per-resource manual override of the bill rate, in **€/DAY** (null = inherit). */
  billRateOverride?: number | null;
  /** EFFECTIVE cost rate in **€/DAY** (override ?? card), resolved on read — for display/entry. */
  costRateDay?: number;
  /** EFFECTIVE bill rate in **€/DAY** (override ?? card), resolved on read. */
  billRateDay?: number;
  /**
   * PLANNED utilization for the current period including allocations still
   * pending approval, as opposed to `utilization` (confirmed/allocated only).
   * Resolved by the server on read. Allocation approval workflow.
   */
  utilizationPlanned?: number;
  /**
   * Date the resource was hired (data di assunzione), ISO 'YYYY-MM-DD'.
   * REQUIRED at create time (the server rejects a missing/invalid value), but
   * declared optional here for back-compat with pre-existing seeds/rows that
   * predate the field.
   */
  hireDate?: string;
  /**
   * Date the resource's contract was terminated (data di cessazione), ISO
   * 'YYYY-MM-DD'. Optional. A resource is considered TERMINATED when this is set
   * to a date on or before today, and ACTIVE otherwise. Logical deletion only —
   * resources are never hard-deleted; clearing this (null/empty) reactivates.
   */
  terminationDate?: string;
  /**
   * Contracted hours/day for this resource, used to derive daily targets from
   * the weekly/period capacity. `undefined` falls back to the org-wide
   * `Setting` keyed `hoursPerDay`. Time-phased allocation (B1).
   */
  contractHoursPerDay?: number;
  /**
   * Resource kind (C1). 'internal' is a real person; 'dummy' is a placeholder
   * for a person not yet identified; 'subco' is an external collaborator
   * belonging to a vendor. Optional on the wire for backward compatibility —
   * read it through `kindOf()`, which defaults an absent value to 'internal'.
   */
  kind?: ResourceKind;
  /** Vendor a 'subco' resource belongs to (FK to the vendors catalog). Required for subco, absent otherwise. */
  vendorId?: string;
}

export interface ResourceRequest {
  id: string;
  name: string;
  requiredRole: string;
  requiredEffort: number;
  staffedEffort?: number;
  /**
   * PLANNED staffed effort including allocations still pending approval, as
   * opposed to `staffedEffort` (confirmed/allocated only). Allocation approval
   * workflow.
   */
  staffedEffortPlanned?: number;
  status: string;
  skills: string[];
  description?: string;
  startDate?: string;
  endDate?: string;
  requesterId?: string;
  projectId?: string;
}

export interface Assignment {
  id: string;
  requestId: string;
  resourceId: string;
  assignedHours: number;
  status: 'Draft' | 'Requested' | 'Allocated' | 'Rejected';
  /** ISO booking start (YYYY-MM-DD). Falls back to the linked request's startDate when absent. */
  startDate?: string;
  /** ISO booking end (YYYY-MM-DD). Falls back to the linked request's endDate when absent. */
  endDate?: string;
  /** Percentage of the resource's weekly capacity this booking consumes. Defaults to 100. */
  allocationPct?: number;
  /** Id of the ApprovalRequest governing this assignment's Requested -> Allocated transition, if any. */
  approvalId?: string;
}

/**
 * Time-phased allocation (B1): the per-day breakdown of an assignment's
 * assignedHours, letting effort be distributed unevenly across the booking
 * window (e.g. around holidays/part-time days) instead of a flat daily rate.
 */
export interface AssignmentDay {
  id: string;
  assignmentId: string;
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  hours: number;
}

/**
 * Per-month lifecycle state of an assignment (B3). The approval unit is the
 * (assignment, month) pair — RPT approves month by month across projects — so
 * this row, not `Assignment.status`, is authoritative. `Assignment.status` is a
 * derived rollup of these (see allocation-month.util `deriveAssignmentStatus`).
 * A row exists even for a month with 0 hours: zeroing an approved month is
 * itself a proposal the People Manager must approve.
 */
export interface AssignmentMonth {
  /** Composite `<assignmentId>:<YYYY-MM>`. */
  id: string;
  assignmentId: string;
  /** 'YYYY-MM'. */
  month: string;
  status: 'Draft' | 'Requested' | 'Allocated' | 'Rejected';
  /** Id of the ApprovalRequest currently governing THIS month, if any. */
  approvalId?: string;
  /** Note written by the planner (PM) for the approver. */
  plannerNote?: string;
  /** Note written by the approver (People Manager) on the decision. */
  approverNote?: string;
  /**
   * C2 — the dummy month this month's hours came from, while a substitution is
   * pending. Transient: written when the hours are transferred, cleared when the
   * decision resolves (a rejection returns them all, an approval returns only
   * what the approver trimmed). A month without it is an ordinary month.
   */
  replacedFromAssignmentMonthId?: string;
  /**
   * C2 — WHICH days that substitution moved, and how many hours from each
   * (`{ 'YYYY-MM-DD': hours }`, days that moved nothing absent).
   *
   * NOT derivable at decision time, and a per-day map rather than a total on
   * purpose: the approver may trim or zero the month before approving, so the
   * original figures are no longer readable anywhere, and the give-back must be
   * decided DAY BY DAY (`moved[date] - min(moved[date], stillHeld[date])`). A
   * single total would have to be spread over the days she happens to hold at
   * decision time, which silently moves her own unrelated work onto the dummy —
   * see `planGiveBack`. Written and cleared together with the back-link above.
   */
  replacedDays?: Record<string, number>;
  /**
   * C2 — what she ALREADY held on each of those dates, on this assignment,
   * immediately before the transfer (`{ 'YYYY-MM-DD': hours }`, same dates as
   * `replacedDays`).
   *
   * The give-back needs the day's hours split into "hers" and "on loan", and a date
   * can legitimately carry both (a substitution onto a month she already had hours
   * in DEMOTES it — `demotedExistingWork`). That split is NOT reconstructable from
   * what she happens to hold at decision time, so the transfer records it: without
   * it, trimming a shared day charges her own hours against the loan and destroys
   * booked demand. Written and cleared together with the two fields above.
   */
  replacedBaselineDays?: Record<string, number>;
}

/**
 * Envelope returned by `GET /assignments/:id/allocation` (B1): the assignment's
 * per-day rows within [from,to] plus the effective daily contract cap. `from`/`to`
 * default server-side to the assignment's spanned months and are omitted when the
 * assignment has no day rows yet.
 */
export interface AssignmentAllocation {
  assignmentId: string;
  from?: string;
  to?: string;
  contractHoursPerDay: number;
  /**
   * The resource's kind (C1), normalized (`kindOf`) server-side. Lets the
   * calendar decide whether to offer the multi-FTE selector and widen the
   * per-day capacity hint (`dailyCapFor`). Optional on the wire for backward
   * compatibility with pre-C1 clients/fixtures — read it through `kindOf()`,
   * which defaults an absent value to 'internal'.
   */
  resourceKind?: ResourceKind;
  /** Per-month lifecycle rows for the requested span (B3). */
  months?: AssignmentMonth[];
  days: AssignmentDay[];
}

/**
 * Response of `PUT /assignments/:id/allocation` (B1): the fresh assignment (whose
 * `status` is a DERIVED rollup of its months, B3 — editing an 'Allocated' month
 * forces THAT month back to 'Requested' for re-approval, which may or may not
 * change the rollup depending on the assignment's other months) plus the
 * just-replaced month and its persisted day rows.
 */
export interface AssignmentAllocationResult extends Assignment {
  month: string;
  contractHoursPerDay: number;
  days: AssignmentDay[];
}

/**
 * One (assignment, month) row within a resource's `AllocationApprovalRow.items`
 * (B3): the project it belongs to, its lifecycle state, hours and notes.
 */
export interface AllocationApprovalItem {
  assignmentMonthId: string;
  assignmentId: string;
  month: string;
  status: AssignmentMonth['status'];
  projectId?: string;
  projectName?: string;
  requestId: string;
  hours: number;
  plannerNote?: string;
  approverNote?: string;
  approvalId?: string;
}

/**
 * One resource's row in the People Manager approval feed (B3): its per-month
 * target/total hours across the requested window, plus every (assignment,
 * month) item across all its projects.
 */
export interface AllocationApprovalRow {
  resourceId: string;
  resourceName: string;
  managerId?: string;
  /**
   * C1: the resource's kind, normalized (`kindOf`) server-side — never absent.
   * A dummy/subco row has no capacity to saturate (manual §4.3), so the UI
   * must skip the saturation band/percentage for any kind other than
   * 'internal' and show the hours plainly instead.
   */
  kind: ResourceKind;
  contractHoursPerDay: number;
  targetHours: Record<string, number>;
  totalHours: Record<string, number>;
  items: AllocationApprovalItem[];
  /**
   * D (Task 8): the resource's `organization` (resource-org NAME), carried
   * straight from `Resource.organization` so the client can derive the
   * capability/practice/competence dimensions via `dimensionsOf` without a
   * second catalogue fetch — the handler already loads the resource list to
   * build this row. Absent when the resource has no organization.
   */
  organization?: string;
  /**
   * D (Task 8, round 3): the display name of `managerId`'s resource, resolved
   * server-side from the SAME `resourceById` map the handler already builds
   * for this row — no extra I/O. Lets the People Manager filter's option list
   * show a real name rather than a bare id: the feed lists a manager's
   * REPORTS, not the manager themselves, so the manager typically has no row
   * of their own here to resolve a name from client-side. Absent only when
   * `managerId` is absent, or points at a resource record that has genuinely
   * vanished (should not happen in normal operation).
   */
  managerName?: string;
}

/** Envelope returned by `GET /allocation-approvals` (B3): the People Manager's
 *  approval feed — resources x months x projects with per-month state. */
export interface AllocationApprovalFeed {
  months: string[];
  rows: AllocationApprovalRow[];
}

/** One decision in a `decideAllocationMonths` batch call (B3). */
export interface AllocationDecisionItem {
  assignmentMonthId: string;
  decision: 'Approved' | 'Rejected';
  note?: string;
}

/** One result entry in a `decideAllocationMonths` batch response (B3). */
export interface AllocationDecisionResult {
  assignmentMonthId: string;
  status: string;
  error?: string;
}

/**
 * C2 — the outcome of transferring ONE dummy month to a real person, via
 * `POST /assignment-months/:id/substitute`. Transferring 0 hours is a
 * legitimate outcome (the target had no room left that month), not an error —
 * `skipped` carries a human-readable reason for it (or for a month whose
 * planning period was not Open, under `applyToRemainingMonths`).
 */
export interface SubstitutionMonthOutcome {
  month: string;
  transferredHours: number;
  remainingHours: number;
  /** Composite `<assignmentId>:<month>` of the target's month row, absent when nothing transferred. */
  targetAssignmentMonthId?: string;
  status?: AssignmentMonth['status'];
  skipped?: string;
  /** True when the transfer demoted work the target already had approved that month. */
  demotedExistingWork?: boolean;
}

/** Response of `POST /assignment-months/:id/substitute` (C2): one outcome per
 *  month transferred — a single entry unless `applyToRemainingMonths` was set. */
export interface SubstitutionResult {
  targetResourceId: string;
  targetResourceName: string;
  outcomes: SubstitutionMonthOutcome[];
}

/**
 * Envelope returned by `GET /capacity/monthly` (B2): a monthly FTE
 * capacity/demand rollup across resources. `months` are the requested
 * ('YYYY-MM') buckets; `rows` carry each internal resource's per-month cells;
 * `totals` aggregates confirmed/planned demand and capacity FTE per month.
 * `demandRows` (C1) carries dummy/subco rows — same monthly cells, but they
 * contribute no capacity or headcount, only `totals[month].demandFteUncovered`.
 */
export interface CapacityMonthly {
  months: string[];
  rows: CapacityRow[];
  demandRows: CapacityRow[];
  totals: Record<string, CapacityTotals>;
}

export type UserRole = 'employee' | 'pm' | 'resource-manager' | 'delivery-executive' | 'finance' | 'sales' | 'admin';

export interface User {
  id: string;
  resourceId: string;
  name: string;
  role: UserRole;
}

export interface Language {
  code: string;
  name: string;
  isDefault: boolean;
}

export interface SkillCatalog {
  id: string;
  name: string;
  description: string;
  skills: string[];
}

export interface ProficiencyLevel {
  id: string;
  level: number;
  name: string;
  description: string;
}

export interface ProficiencySet {
  id: string;
  name: string;
  description: string;
  levels: ProficiencyLevel[];
}

export interface Skill {
  id: string;
  conceptUri: string;
  name: string;
  description: string;
  catalogs: string[];
  proficiencySetId?: string;
  restricted: boolean;
}

export interface ProjectRole {
  id: string;
  code: string;
  name: string;
  description: string;
  restricted: boolean;
}

export interface ServiceOrganization {
  id: string;
  code: string;
  description: string;
  costCenters: string[];
}

/**
 * A node of the organizational tree (D). Capability > Practice > Competence.
 *
 * TWO REFERENCES UPWARD, deliberately orthogonal (design spec §2.3):
 *   - `parentId`              -> the DELIVERY hierarchy. Drives manager scope,
 *                                derived dimensions and filters.
 *   - `serviceOrganizationId` -> FINANCIAL belonging. Drives cost centres and
 *                                rate-card selection. NOT part of the tree; it
 *                                is never walked for scope.
 *
 * `managerId` IS the manual's Capability Leader / Practice Manager / Competence
 * Manager — the node's level says which. No new RBAC role exists for them.
 */
export interface ResourceOrganization {
  id: string;
  name: string;
  description: string;
  costCenters: string[];
  serviceOrganizationId?: string;
  /** The node above this one in the DELIVERY tree. Absent on a capability (root). */
  parentId?: string;
  /** Declared level. A capability has no parent; a practice's parent is a capability; a competence's parent is a practice. */
  level: OrgLevel;
  /** The resource who manages this node — soft reference, like `Resource.managerId`. */
  managerId?: string;
}

// --- Customizing catalogs (Phase F1 — additive reference data) ---
// These are simple keyed catalogs that F2 will bind consumer fields to (Resource
// location/organization, Customer industry/country, financial-plan category,
// project-partner role/company). Added here additively; no existing consumer is
// rewired yet.

/** A country, keyed by its ISO 3166-1 alpha-2 code (the id IS the code). */
export interface Country {
  /** ISO-2 code (e.g. 'IT'); doubles as the primary key. */
  code: string;
  name: string;
}

/** A city/comune belonging to a {@link Country} (FK by country code). */
export interface City {
  id: string;
  name: string;
  /** FK -> Country.code. */
  countryCode: string;
}

/** A customer industry sector (e.g. 'Technology'). */
export interface Industry {
  id: string;
  name: string;
}

/** A financial-plan cost category (e.g. 'Labor', 'Travel & Expenses'). */
export interface CostCategory {
  id: string;
  name: string;
}

/** A project-partner relationship role (e.g. 'Subcontractor', 'Reseller'). */
export interface PartnerRole {
  id: string;
  name: string;
}

/** A partner/supplier company in the vendor catalog. */
export interface Vendor {
  id: string;
  name: string;
  vatId?: string;
  country?: string;
}

/**
 * A Rate Card (Phase E): the DEFAULT cost/bill rate for a role, optionally
 * scoped to an organization. It is the single source of truth for a resource's
 * rate — a resource's effective rate is its per-resource override (if any) else
 * the matching card here. Keyed by `role` (project-role NAME) + optional
 * `organization` (resource-org NAME; empty = all orgs) + `currency` (base/EUR).
 * Rates are in **€/DAY** (hybrid model); the server converts to €/hour via the
 * `hoursPerDay` setting before margin math.
 */
export interface RateCard {
  id: string;
  role: string;
  organization?: string;
  currency: string;
  costRate: number;
  billRate: number;
}

/** A global key-value setting (id IS the key, e.g. 'hoursPerDay'). */
export interface Setting {
  id: string;
  value: string;
}

/**
 * A non-working day (id IS the ISO date, e.g. '2026-12-25'). Time-phased
 * allocation (B1) — excluded from working-day calculations.
 */
export interface Holiday {
  id: string;
  name: string;
}

/**
 * Open/closed state of a calendar month (id IS the 'YYYY-MM' month). Time-
 * phased allocation (B1) — a Closed period rejects new/edited daily bookings.
 */
export interface PlanningPeriod {
  id: string;
  status: 'Open' | 'Closed';
}

export interface Project {
  id: string;
  name: string;
  location: string;
  startDate: string;
  endDate: string;
  status: string;
  description?: string;
  ownerId?: string;
  contractId?: string;
}

// --- Project sub-resources (shared types; import these, do not redefine locally) ---

export interface Partner {
  id: string;
  projectId: string;
  company: string;
  role: string;
  contact: string;
  status: string;
}

export interface ProjectDocument {
  id: string;
  projectId: string;
  name: string;
  type: string;
  size: string;
  uploadedAt: string;
  author: string;
  authorInitials: string;
}

export interface WorkPackage {
  id: string;
  projectId: string;
  name: string;
  startDate: string;
  endDate: string;
  status: 'Planned' | 'In Progress' | 'Completed';
  progress: number;
  assignee: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  date: string;
  status: 'Pending' | 'Achieved';
  approvedBy?: string;
  approvedAt?: string;
}

export interface FinancialItem {
  id: string;
  projectId: string;
  category: string;
  budget: number;
  actual: number;
}

export interface ProjectCostCenter {
  id: string;
  projectId: string;
  name: string;
  manager: string;
  allocated: number;
  actual: number;
}

export interface Task {
  id: string;
  projectId: string;
  name: string;
  assignee: string;
  assigneeType?: 'Internal' | 'Subcontractor';
  partnerId?: string;
  dueDate: string;
  status: string;
  priority: string;
}

export interface Issue {
  id: string;
  projectId: string;
  title: string;
  type: string;
  severity: string;
  status: string;
  reportedBy: string;
  owner?: string;
  dueDate?: string;
  impact?: string;
  actionPlan?: string;
  escalated?: boolean;
}

export interface CostCenter {
  id: string;
  name: string;
  manager: string;
  allocated: number;
  actual: number;
}

// --- Commercial domain (ADR-0001) ---

export interface Customer {
  id: string;
  name: string;
  industry?: string;
  country?: string;
}

export interface Contract {
  id: string;
  customerId: string;
  name: string;
  type: 'T&M' | 'Fixed Price' | 'Framework';
  totalValue: number;
  currency: string;
  status: 'Draft' | 'Active' | 'Closed';
  startDate: string;
  endDate: string;
}

export interface Order {
  id: string;
  contractId: string;
  type: 'Customer' | 'Purchase';
  partnerId?: string;
  amount: number;
  currency: string;
  status: 'Open' | 'Confirmed' | 'Invoiced' | 'Paid';
  orderDate: string;
  // SERVER-SET (never accepted from client): a sequential, compliant invoice
  // number (e.g. 'INV-2026-0001') and its date, assigned when an order first
  // transitions to status 'Invoiced'.
  invoiceNumber?: string;
  invoiceDate?: string;
}

export interface OrderLine {
  id: string;
  orderId: string;
  projectId: string;
  description: string;
  amount: number;
}

export interface CreateOrderWithLineRequest {
  /** Stable for retries of one form submission; a new form uses a new key. */
  idempotencyKey: string;
  order: Partial<Order>;
  line: Omit<Partial<OrderLine>, 'orderId'>;
}

export interface OrderWithLineResult {
  order: Order;
  line: OrderLine;
  replayed: boolean;
}

export type BillingType =
  | 'Milestone'          // SAL — fixed-price, triggered by a project Milestone
  | 'Recurring'          // retainer billed on a fixed cadence
  | 'TimeAndMaterials'   // as-incurred: approved hours x billRate
  | 'Capped'             // T&M not-to-exceed (cap)
  | 'Advance'            // down payment taken up front
  | 'Progress'           // percentage of completion (POC)
  | 'Expense'            // pass-through / re-invoiced expenses
  | 'CreditNote';        // nota di credito (negative)

export interface BillingPlanItem {
  id: string;
  contractId: string;
  projectId?: string;
  type: BillingType;
  label: string;
  milestoneId?: string;                                  // Milestone
  recurrence?: 'Monthly' | 'Quarterly' | 'Annual';       // Recurring
  expectedDate?: string;
  amount: number;                                        // base; negative ONLY for CreditNote
  capAmount?: number;                                    // Capped
  progressPct?: number;                                  // Progress (0-100)
  markupPct?: number;                                    // Expense markup
  retentionPct?: number;                                 // ritenuta a garanzia
  taxRatePct?: number;                                   // IVA
  paymentTermsDays?: number;                             // net terms
  currency: string;
  status: 'Planned' | 'Ready' | 'Invoiced' | 'Paid' | 'Blocked';
  issuedDate?: string;
  dueDate?: string;
  paidDate?: string;
  orderId?: string;                                      // generated invoice/order
  notes?: string;
}

export interface BillingInvoiceResult {
  billingItem: BillingPlanItem;
  order: Order;
  replayed: boolean;
}

/**
 * Payment moves the billing condition AND its linked customer order. `replayed`
 * is true when both were already Paid, so a lost response is safe to retry.
 */
export interface BillingPaymentResult {
  billingItem: BillingPlanItem;
  order: Order;
  replayed: boolean;
}

export interface BillingInvoiceBatchResult {
  results: BillingInvoiceResult[];
  failures: { id: string; status: number; error: string }[];
}

export interface TimeEntry {
  id: string;
  assignmentId: string;
  requestId: string;
  resourceId: string;
  projectId: string;
  date: string;
  hours: number;
  status: 'Draft' | 'Submitted' | 'Approved' | 'Rejected';
  notes?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface ChangeRequest {
  id: string;
  projectId: string;
  title: string;
  description: string;
  requestedBy: string;
  owner: string;
  status: 'Draft' | 'Submitted' | 'Approved' | 'Rejected' | 'Implemented';
  impactScope: string;
  impactBudget: number;
  impactScheduleDays: number;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

// --- Approval workflow engine ---

export type ApprovalKind = 'TimeEntry' | 'Expense' | 'Milestone' | 'ChangeRequest' | 'Invoice' | 'Allocation';
export type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected';

export interface ApprovalStep {
  role: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  /** Resource-id of the specific approver (People Manager) authorised to decide this step, in addition to `role`. */
  approverId?: string;
  /** Approver's note recorded on decision (the requester's note lives on `ApprovalRequest.note`). */
  note?: string;
}

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  refId: string;
  projectId?: string;
  amount?: number;
  requestedBy: string;
  status: ApprovalStatus;
  steps: ApprovalStep[];
  currentStep: number;
  createdAt: string;
  slaDueAt?: string;
  note?: string;
}

export interface AuditLog {
  id: string;
  at: string;
  actorId: string;
  actorRole: UserRole | 'unknown';
  method: string;
  path: string;
  statusCode: number;
  // AUDIT INTEGRITY: append-only entries capture which keys changed on a
  // PUT/DELETE mutation, with before/after snapshots of just those keys.
  changedKeys?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

// --- Multi-currency foundation ---

/** The reporting/base currency all monetary rollups normalise to. */
export const BASE_CURRENCY = 'EUR';

/**
 * Exchange rate for a single currency, expressed as the base-currency value of
 * 1 unit of `currency`. The base currency (EUR) therefore has rateToBase = 1.
 * To convert an amount into the base currency: amount * rateToBase.
 */
export interface FxRate {
  currency: string;
  rateToBase: number;
}

// --- Integrations (local-artifact adapters: implemented, NOT connected) ---

/** The four supported integration kinds. */
export type IntegrationKind = 'erp' | 'einvoice' | 'crm' | 'bi';

/** Server-side adapter self-description (mirror of the server contract). */
export interface IntegrationDescriptor {
  kind: IntegrationKind;
  key: string;
  name: string;
  description: string;
  /** Always false today: local-artifact adapters never contact external systems. */
  connected: boolean;
  mode: 'local-artifact';
}

/** GET /integrations response: active descriptors + per-kind active key. */
export interface IntegrationsInfo {
  adapters: IntegrationDescriptor[];
  active: Record<IntegrationKind, string>;
}

/** CRM account record inside a prepared sync payload. */
export interface CrmOutboxAccount {
  externalId: string;
  name: string;
  industry?: string;
  country?: string;
}

/** Condensed order nested under a CRM deal. */
export interface CrmOutboxOrder {
  id: string;
  type: string;
  amount: number;
  status: string;
}

/** CRM deal record inside a prepared sync payload. */
export interface CrmOutboxDeal {
  externalId: string;
  accountExternalId: string;
  name: string;
  value: number;
  currency: string;
  stage: string;
  orders: CrmOutboxOrder[];
}

/**
 * One prepared (never sent) CRM sync payload. The server keeps these in an
 * intentionally ephemeral in-memory outbox (demo state, cleared on restart).
 */
export interface CrmOutboxEntry {
  id?: string;
  preparedAt: string;
  status: string;
  target: string;
  payload: { accounts: CrmOutboxAccount[]; deals: CrmOutboxDeal[] };
}

/** A single cell of the BI feed (primitives only). */
export type BiFeedCell = string | number | boolean | null;

/** GET /integrations/bi/feed response: flat per-project financial rows. */
export interface BiFeedPreview {
  generatedAt: string;
  rowCount: number;
  rows: Record<string, BiFeedCell>[];
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private baseUrl = inject(API_BASE_URL);

  getResources(): Observable<Resource[]> {
    return this.http.get<Resource[]>(`${this.baseUrl}/resources`);
  }

  getUsers(): Observable<User[]> {
    return this.http.get<User[]>(`${this.baseUrl}/users`);
  }

  getResource(id: string): Observable<Resource> {
    return this.http.get<Resource>(`${this.baseUrl}/resources/${id}`);
  }

  /** Onboard a new employee (creazione). `hireDate` is required server-side. */
  createResource(data: Partial<Resource>): Observable<Resource> {
    return this.http.post<Resource>(`${this.baseUrl}/resources`, data);
  }

  /**
   * Edit (modifica) or terminate/reactivate (cessazione logica) a resource.
   * Terminate = set `terminationDate`; reactivate = send `terminationDate: null`.
   */
  updateResource(id: string, data: Partial<Resource>): Observable<Resource> {
    return this.http.put<Resource>(`${this.baseUrl}/resources/${id}`, data);
  }

  // --- Authenticated self-service (server derives the resource from OIDC) ---

  getMyProfile(): Observable<Resource> {
    return this.http.get<Resource>(`${this.baseUrl}/self/profile`);
  }

  updateMyProfile(data: Partial<Resource>): Observable<Resource> {
    return this.http.put<Resource>(`${this.baseUrl}/self/profile`, data);
  }

  getMyAssignments(): Observable<Assignment[]> {
    return this.http.get<Assignment[]>(`${this.baseUrl}/self/assignments`);
  }

  getMyRequests(): Observable<ResourceRequest[]> {
    return this.http.get<ResourceRequest[]>(`${this.baseUrl}/self/requests`);
  }

  getMyTimeEntries(): Observable<TimeEntry[]> {
    return this.http.get<TimeEntry[]>(`${this.baseUrl}/self/time-entries`);
  }

  /** Create and submit an own time entry; ownership is derived server-side. */
  createMyTimeEntry(entry: Partial<TimeEntry>): Observable<TimeEntry> {
    return this.http.post<TimeEntry>(`${this.baseUrl}/self/time-entries`, entry);
  }

  getRequests(): Observable<ResourceRequest[]> {
    return this.http.get<ResourceRequest[]>(`${this.baseUrl}/requests`);
  }

  createRequest(request: Partial<ResourceRequest>): Observable<ResourceRequest> {
    return this.http.post<ResourceRequest>(`${this.baseUrl}/requests`, request);
  }

  updateRequest(id: string, request: Partial<ResourceRequest>): Observable<ResourceRequest> {
    return this.http.put<ResourceRequest>(`${this.baseUrl}/requests/${id}`, request);
  }

  deleteRequest(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/requests/${id}`);
  }

  getAssignments(): Observable<Assignment[]> {
    return this.http.get<Assignment[]>(`${this.baseUrl}/assignments`);
  }

  createAssignment(assignment: Partial<Assignment>): Observable<Assignment> {
    return this.http.post<Assignment>(`${this.baseUrl}/assignments`, assignment);
  }

  updateAssignment(id: string, assignment: Partial<Assignment>): Observable<Assignment> {
    return this.http.put<Assignment>(`${this.baseUrl}/assignments/${id}`, assignment);
  }

  deleteAssignment(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/assignments/${id}`);
  }

  // --- Time-phased allocation (B1) ---

  /**
   * Read an assignment's per-day allocation. `from`/`to` ('YYYY-MM') bound the
   * returned months; omit them to let the server default to the assignment's
   * spanned months.
   */
  getAssignmentAllocation(id: string, from?: string, to?: string): Observable<AssignmentAllocation> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http.get<AssignmentAllocation>(`${this.baseUrl}/assignments/${id}/allocation`, { params });
  }

  /**
   * Replace ONE month's per-day hours (keys are 'YYYY-MM-DD' -> hours). The server
   * enforces open-month, working-day and per-day capacity, and may demote the
   * assignment to 'Requested' for re-approval — reflected in the returned status.
   */
  saveAssignmentAllocation(id: string, month: string, dailyHours: Record<string, number>): Observable<AssignmentAllocationResult> {
    return this.http.put<AssignmentAllocationResult>(`${this.baseUrl}/assignments/${id}/allocation`, { month, dailyHours });
  }

  /** Open/Closed state of each calendar month (B1). */
  getPlanningPeriods(): Observable<PlanningPeriod[]> { return this.http.get<PlanningPeriod[]>(`${this.baseUrl}/planning-periods`); }

  /** Non-working days excluded from working-day math (B1). */
  getHolidays(): Observable<Holiday[]> { return this.http.get<Holiday[]>(`${this.baseUrl}/holidays`); }

  // --- Per-month approval (B3) ---

  /** Read the People Manager approval feed. Omitted bounds default to the open planning periods. */
  getAllocationApprovals(from?: string, to?: string, status?: 'all' | 'Requested' | 'Allocated'): Observable<AllocationApprovalFeed> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    if (status) params = params.set('status', status);
    return this.http.get<AllocationApprovalFeed>(`${this.baseUrl}/allocation-approvals`, { params });
  }

  /** Send ONE month of an assignment for approval ("Invia mese in approvazione"). */
  submitAssignmentMonth(assignmentId: string, month: string, plannerNote?: string): Observable<AssignmentMonth> {
    return this.http.post<AssignmentMonth>(`${this.baseUrl}/assignments/${assignmentId}/months/${month}/submit`, { plannerNote });
  }

  /** Save the planner's note on a month row. */
  setAssignmentMonthNote(assignmentId: string, month: string, plannerNote: string): Observable<AssignmentMonth> {
    return this.http.put<AssignmentMonth>(`${this.baseUrl}/assignments/${assignmentId}/months/${month}/note`, { plannerNote });
  }

  /** Decide N month rows in one call ("Approva Mese" / "Approva e Prosegui"). */
  decideAllocationMonths(items: AllocationDecisionItem[]): Observable<{ results: AllocationDecisionResult[] }> {
    return this.http.post<{ results: AllocationDecisionResult[] }>(`${this.baseUrl}/allocation-approvals/decide`, { items });
  }

  /**
   * C2 — hand a dummy's month to a real person, capped by what they can absorb
   * each day. `assignmentMonthId` is the DUMMY's month row. `applyToRemainingMonths`
   * repeats the transfer across the dummy's later months in the same request/chain.
   */
  substituteDummyMonth(assignmentMonthId: string, targetResourceId: string, applyToRemainingMonths?: boolean): Observable<SubstitutionResult> {
    return this.http.post<SubstitutionResult>(`${this.baseUrl}/assignment-months/${assignmentMonthId}/substitute`, { targetResourceId, applyToRemainingMonths });
  }

  // --- Monthly FTE capacity (B2) ---

  /**
   * Monthly FTE capacity/demand rollup across resources. `from`/`to`
   * ('YYYY-MM') bound the returned months; omit them to let the server pick
   * its default window.
   */
  getCapacityMonthly(from?: string, to?: string): Observable<CapacityMonthly> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    return this.http.get<CapacityMonthly>(`${this.baseUrl}/capacity/monthly`, { params });
  }

  // --- Configuration APIs ---

  getLanguages(): Observable<Language[]> {
    return this.http.get<Language[]>(`${this.baseUrl}/languages`);
  }

  setDefaultLanguage(code: string): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/languages/default`, { code });
  }

  getSkillCatalogs(): Observable<SkillCatalog[]> {
    return this.http.get<SkillCatalog[]>(`${this.baseUrl}/skill-catalogs`);
  }

  createSkillCatalog(catalog: Partial<SkillCatalog>): Observable<SkillCatalog> {
    return this.http.post<SkillCatalog>(`${this.baseUrl}/skill-catalogs`, catalog);
  }

  updateSkillCatalog(id: string, catalog: Partial<SkillCatalog>): Observable<SkillCatalog> {
    return this.http.put<SkillCatalog>(`${this.baseUrl}/skill-catalogs/${id}`, catalog);
  }

  deleteSkillCatalog(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/skill-catalogs/${id}`);
  }

  getProficiencySets(): Observable<ProficiencySet[]> {
    return this.http.get<ProficiencySet[]>(`${this.baseUrl}/proficiency-sets`);
  }

  createProficiencySet(set: Partial<ProficiencySet>): Observable<ProficiencySet> {
    return this.http.post<ProficiencySet>(`${this.baseUrl}/proficiency-sets`, set);
  }

  deleteProficiencySet(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/proficiency-sets/${id}`);
  }

  getSkills(): Observable<Skill[]> {
    return this.http.get<Skill[]>(`${this.baseUrl}/skills`);
  }

  createSkill(skill: Partial<Skill>): Observable<Skill> {
    return this.http.post<Skill>(`${this.baseUrl}/skills`, skill);
  }

  updateSkill(id: string, skill: Partial<Skill>): Observable<Skill> {
    return this.http.put<Skill>(`${this.baseUrl}/skills/${id}`, skill);
  }

  deleteSkill(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/skills/${id}`);
  }

  getProjectRoles(): Observable<ProjectRole[]> {
    return this.http.get<ProjectRole[]>(`${this.baseUrl}/project-roles`);
  }

  createProjectRole(role: Partial<ProjectRole>): Observable<ProjectRole> {
    return this.http.post<ProjectRole>(`${this.baseUrl}/project-roles`, role);
  }

  updateProjectRole(id: string, role: Partial<ProjectRole>): Observable<ProjectRole> {
    return this.http.put<ProjectRole>(`${this.baseUrl}/project-roles/${id}`, role);
  }

  getServiceOrganizations(): Observable<ServiceOrganization[]> {
    return this.http.get<ServiceOrganization[]>(`${this.baseUrl}/service-organizations`);
  }

  getResourceOrganizations(): Observable<ResourceOrganization[]> {
    return this.http.get<ResourceOrganization[]>(`${this.baseUrl}/resource-organizations`);
  }

  createResourceOrganization(org: Partial<ResourceOrganization>): Observable<ResourceOrganization> {
    return this.http.post<ResourceOrganization>(`${this.baseUrl}/resource-organizations`, org);
  }

  updateResourceOrganization(id: string, org: Partial<ResourceOrganization>): Observable<ResourceOrganization> {
    return this.http.put<ResourceOrganization>(`${this.baseUrl}/resource-organizations/${id}`, org);
  }

  deleteResourceOrganization(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/resource-organizations/${id}`);
  }

  // --- Customizing catalogs (Phase F1 — additive reference data) ---

  getCountries(): Observable<Country[]> { return this.http.get<Country[]>(`${this.baseUrl}/countries`); }
  createCountry(c: Partial<Country>): Observable<Country> { return this.http.post<Country>(`${this.baseUrl}/countries`, c); }
  updateCountry(code: string, c: Partial<Country>): Observable<Country> { return this.http.put<Country>(`${this.baseUrl}/countries/${code}`, c); }
  deleteCountry(code: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/countries/${code}`); }

  getCities(): Observable<City[]> { return this.http.get<City[]>(`${this.baseUrl}/cities`); }
  createCity(c: Partial<City>): Observable<City> { return this.http.post<City>(`${this.baseUrl}/cities`, c); }
  updateCity(id: string, c: Partial<City>): Observable<City> { return this.http.put<City>(`${this.baseUrl}/cities/${id}`, c); }
  deleteCity(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/cities/${id}`); }

  getIndustries(): Observable<Industry[]> { return this.http.get<Industry[]>(`${this.baseUrl}/industries`); }
  createIndustry(i: Partial<Industry>): Observable<Industry> { return this.http.post<Industry>(`${this.baseUrl}/industries`, i); }
  updateIndustry(id: string, i: Partial<Industry>): Observable<Industry> { return this.http.put<Industry>(`${this.baseUrl}/industries/${id}`, i); }
  deleteIndustry(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/industries/${id}`); }

  getCostCategories(): Observable<CostCategory[]> { return this.http.get<CostCategory[]>(`${this.baseUrl}/cost-categories`); }
  createCostCategory(c: Partial<CostCategory>): Observable<CostCategory> { return this.http.post<CostCategory>(`${this.baseUrl}/cost-categories`, c); }
  updateCostCategory(id: string, c: Partial<CostCategory>): Observable<CostCategory> { return this.http.put<CostCategory>(`${this.baseUrl}/cost-categories/${id}`, c); }
  deleteCostCategory(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/cost-categories/${id}`); }

  getPartnerRoles(): Observable<PartnerRole[]> { return this.http.get<PartnerRole[]>(`${this.baseUrl}/partner-roles`); }
  createPartnerRole(r: Partial<PartnerRole>): Observable<PartnerRole> { return this.http.post<PartnerRole>(`${this.baseUrl}/partner-roles`, r); }
  updatePartnerRole(id: string, r: Partial<PartnerRole>): Observable<PartnerRole> { return this.http.put<PartnerRole>(`${this.baseUrl}/partner-roles/${id}`, r); }
  deletePartnerRole(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/partner-roles/${id}`); }

  getVendors(): Observable<Vendor[]> { return this.http.get<Vendor[]>(`${this.baseUrl}/vendors`); }
  createVendor(v: Partial<Vendor>): Observable<Vendor> { return this.http.post<Vendor>(`${this.baseUrl}/vendors`, v); }
  updateVendor(id: string, v: Partial<Vendor>): Observable<Vendor> { return this.http.put<Vendor>(`${this.baseUrl}/vendors/${id}`, v); }
  deleteVendor(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/vendors/${id}`); }

  // RATE CARDS (Phase E) — role-based default rates customizing. Reads are
  // sensitive (expose cost rates) so the server gates them like /resources.
  getRateCards(): Observable<RateCard[]> { return this.http.get<RateCard[]>(`${this.baseUrl}/rate-cards`); }
  createRateCard(r: Partial<RateCard>): Observable<RateCard> { return this.http.post<RateCard>(`${this.baseUrl}/rate-cards`, r); }
  updateRateCard(id: string, r: Partial<RateCard>): Observable<RateCard> { return this.http.put<RateCard>(`${this.baseUrl}/rate-cards/${id}`, r); }
  deleteRateCard(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/rate-cards/${id}`); }

  // NEGOTIATED SELL RATES (design spec) — the price negotiated per contract,
  // with an optional per-project override. Reads are commercial-sensitive, same
  // gate as /contracts and /rate-cards.
  getNegotiatedRates(): Observable<NegotiatedRate[]> { return this.http.get<NegotiatedRate[]>(`${this.baseUrl}/negotiated-rates`); }
  createNegotiatedRate(rate: Partial<NegotiatedRate>): Observable<NegotiatedRate> { return this.http.post<NegotiatedRate>(`${this.baseUrl}/negotiated-rates`, rate); }
  updateNegotiatedRate(id: string, rate: Partial<NegotiatedRate>): Observable<NegotiatedRate> { return this.http.put<NegotiatedRate>(`${this.baseUrl}/negotiated-rates/${id}`, rate); }
  deleteNegotiatedRate(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/negotiated-rates/${id}`); }

  // Hybrid day-rate model: hours-per-day converts €/day rate cards into the €/hour
  // the margin math consumes. Read open; write gated to finance-grade roles.
  getHoursPerDay(): Observable<{ value: number }> { return this.http.get<{ value: number }>(`${this.baseUrl}/settings/hours-per-day`); }
  setHoursPerDay(value: number): Observable<{ value: number }> { return this.http.put<{ value: number }>(`${this.baseUrl}/settings/hours-per-day`, { value }); }

  getProjects(): Observable<Project[]> {
    return this.http.get<Project[]>(`${this.baseUrl}/projects`);
  }

  createProject(project: Partial<Project>): Observable<Project> {
    return this.http.post<Project>(`${this.baseUrl}/projects`, project);
  }

  updateProject(id: string, project: Partial<Project>): Observable<Project> {
    return this.http.put<Project>(`${this.baseUrl}/projects/${id}`, project);
  }

  deleteProject(id: string): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/projects/${id}`);
  }

  // --- Project sub-resources (B1: real persistence) ---

  getProjectPartners(): Observable<Partner[]> { return this.http.get<Partner[]>(`${this.baseUrl}/project-partners`); }
  createProjectPartner(p: Partial<Partner>): Observable<Partner> { return this.http.post<Partner>(`${this.baseUrl}/project-partners`, p); }
  updateProjectPartner(id: string, p: Partial<Partner>): Observable<Partner> { return this.http.put<Partner>(`${this.baseUrl}/project-partners/${id}`, p); }
  deleteProjectPartner(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-partners/${id}`); }

  getProjectDocuments(): Observable<ProjectDocument[]> { return this.http.get<ProjectDocument[]>(`${this.baseUrl}/project-documents`); }
  createProjectDocument(d: Partial<ProjectDocument>): Observable<ProjectDocument> { return this.http.post<ProjectDocument>(`${this.baseUrl}/project-documents`, d); }
  deleteProjectDocument(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-documents/${id}`); }

  getWorkPackages(): Observable<WorkPackage[]> { return this.http.get<WorkPackage[]>(`${this.baseUrl}/work-packages`); }
  createWorkPackage(w: Partial<WorkPackage>): Observable<WorkPackage> { return this.http.post<WorkPackage>(`${this.baseUrl}/work-packages`, w); }
  updateWorkPackage(id: string, w: Partial<WorkPackage>): Observable<WorkPackage> { return this.http.put<WorkPackage>(`${this.baseUrl}/work-packages/${id}`, w); }

  getMilestones(): Observable<Milestone[]> { return this.http.get<Milestone[]>(`${this.baseUrl}/milestones`); }
  createMilestone(m: Partial<Milestone>): Observable<Milestone> { return this.http.post<Milestone>(`${this.baseUrl}/milestones`, m); }
  updateMilestone(id: string, m: Partial<Milestone>): Observable<Milestone> { return this.http.put<Milestone>(`${this.baseUrl}/milestones/${id}`, m); }

  getProjectFinancials(): Observable<FinancialItem[]> { return this.http.get<FinancialItem[]>(`${this.baseUrl}/project-financials`); }
  createProjectFinancial(f: Partial<FinancialItem>): Observable<FinancialItem> { return this.http.post<FinancialItem>(`${this.baseUrl}/project-financials`, f); }
  updateProjectFinancial(id: string, f: Partial<FinancialItem>): Observable<FinancialItem> { return this.http.put<FinancialItem>(`${this.baseUrl}/project-financials/${id}`, f); }
  deleteProjectFinancial(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-financials/${id}`); }

  getProjectCostCenters(): Observable<ProjectCostCenter[]> { return this.http.get<ProjectCostCenter[]>(`${this.baseUrl}/project-cost-centers`); }
  createProjectCostCenter(c: Partial<ProjectCostCenter>): Observable<ProjectCostCenter> { return this.http.post<ProjectCostCenter>(`${this.baseUrl}/project-cost-centers`, c); }
  updateProjectCostCenter(id: string, c: Partial<ProjectCostCenter>): Observable<ProjectCostCenter> { return this.http.put<ProjectCostCenter>(`${this.baseUrl}/project-cost-centers/${id}`, c); }
  deleteProjectCostCenter(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/project-cost-centers/${id}`); }

  getProjectTasks(): Observable<Task[]> { return this.http.get<Task[]>(`${this.baseUrl}/project-tasks`); }
  createProjectTask(t: Partial<Task>): Observable<Task> { return this.http.post<Task>(`${this.baseUrl}/project-tasks`, t); }
  updateProjectTask(id: string, t: Partial<Task>): Observable<Task> { return this.http.put<Task>(`${this.baseUrl}/project-tasks/${id}`, t); }

  getProjectIssues(): Observable<Issue[]> { return this.http.get<Issue[]>(`${this.baseUrl}/project-issues`); }
  createProjectIssue(i: Partial<Issue>): Observable<Issue> { return this.http.post<Issue>(`${this.baseUrl}/project-issues`, i); }
  updateProjectIssue(id: string, i: Partial<Issue>): Observable<Issue> { return this.http.put<Issue>(`${this.baseUrl}/project-issues/${id}`, i); }

  getChangeRequests(): Observable<ChangeRequest[]> { return this.http.get<ChangeRequest[]>(`${this.baseUrl}/change-requests`); }
  createChangeRequest(c: Partial<ChangeRequest>): Observable<ChangeRequest> { return this.http.post<ChangeRequest>(`${this.baseUrl}/change-requests`, c); }
  updateChangeRequest(id: string, c: Partial<ChangeRequest>): Observable<ChangeRequest> { return this.http.put<ChangeRequest>(`${this.baseUrl}/change-requests/${id}`, c); }
  deleteChangeRequest(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/change-requests/${id}`); }

  getCostCenters(): Observable<CostCenter[]> { return this.http.get<CostCenter[]>(`${this.baseUrl}/cost-centers`); }
  createCostCenter(c: Partial<CostCenter>): Observable<CostCenter> { return this.http.post<CostCenter>(`${this.baseUrl}/cost-centers`, c); }
  updateCostCenter(id: string, c: Partial<CostCenter>): Observable<CostCenter> { return this.http.put<CostCenter>(`${this.baseUrl}/cost-centers/${id}`, c); }
  deleteCostCenter(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/cost-centers/${id}`); }

  // --- Commercial domain (ADR-0001) ---

  getCustomers(): Observable<Customer[]> { return this.http.get<Customer[]>(`${this.baseUrl}/customers`); }
  createCustomer(c: Partial<Customer>): Observable<Customer> { return this.http.post<Customer>(`${this.baseUrl}/customers`, c); }
  updateCustomer(id: string, c: Partial<Customer>): Observable<Customer> { return this.http.put<Customer>(`${this.baseUrl}/customers/${id}`, c); }
  deleteCustomer(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/customers/${id}`); }

  getContracts(): Observable<Contract[]> { return this.http.get<Contract[]>(`${this.baseUrl}/contracts`); }
  createContract(c: Partial<Contract>): Observable<Contract> { return this.http.post<Contract>(`${this.baseUrl}/contracts`, c); }
  updateContract(id: string, c: Partial<Contract>): Observable<Contract> { return this.http.put<Contract>(`${this.baseUrl}/contracts/${id}`, c); }
  deleteContract(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/contracts/${id}`); }

  getOrders(): Observable<Order[]> { return this.http.get<Order[]>(`${this.baseUrl}/orders`); }
  createOrder(o: Partial<Order>): Observable<Order> { return this.http.post<Order>(`${this.baseUrl}/orders`, o); }
  createOrderWithLine(request: CreateOrderWithLineRequest): Observable<OrderWithLineResult> {
    return this.http.post<OrderWithLineResult>(`${this.baseUrl}/orders/with-line`, request);
  }
  updateOrder(id: string, o: Partial<Order>): Observable<Order> { return this.http.put<Order>(`${this.baseUrl}/orders/${id}`, o); }
  deleteOrder(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/orders/${id}`); }

  getOrderLines(): Observable<OrderLine[]> { return this.http.get<OrderLine[]>(`${this.baseUrl}/order-lines`); }
  createOrderLine(l: Partial<OrderLine>): Observable<OrderLine> { return this.http.post<OrderLine>(`${this.baseUrl}/order-lines`, l); }
  updateOrderLine(id: string, l: Partial<OrderLine>): Observable<OrderLine> { return this.http.put<OrderLine>(`${this.baseUrl}/order-lines/${id}`, l); }
  deleteOrderLine(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/order-lines/${id}`); }

  getBillingPlanItems(): Observable<BillingPlanItem[]> { return this.http.get<BillingPlanItem[]>(`${this.baseUrl}/billing-plan-items`); }
  createBillingPlanItem(i: Partial<BillingPlanItem>): Observable<BillingPlanItem> { return this.http.post<BillingPlanItem>(`${this.baseUrl}/billing-plan-items`, i); }
  generateBillingInvoice(id: string, issuedDate: string): Observable<BillingInvoiceResult> {
    return this.http.post<BillingInvoiceResult>(`${this.baseUrl}/billing-plan-items/${id}/generate-invoice`, { issuedDate });
  }
  generateBillingInvoices(ids: string[], issuedDate: string): Observable<BillingInvoiceBatchResult> {
    return this.http.post<BillingInvoiceBatchResult>(`${this.baseUrl}/billing-plan-items/generate-invoices`, { ids, issuedDate });
  }
  /**
   * Marks a condition paid THROUGH THE SERVER OPERATION that also moves the
   * linked customer order to Paid. A plain PUT of `status:'Paid'` left the order
   * 'Invoiced' forever, so Orders showed a paid invoice as outstanding — and the
   * server now refuses that PUT.
   */
  markBillingInvoicePaid(id: string, paidDate: string): Observable<BillingPaymentResult> {
    return this.http.post<BillingPaymentResult>(`${this.baseUrl}/billing-plan-items/${id}/mark-paid`, { paidDate });
  }
  updateBillingPlanItem(id: string, i: Partial<BillingPlanItem>): Observable<BillingPlanItem> { return this.http.put<BillingPlanItem>(`${this.baseUrl}/billing-plan-items/${id}`, i); }
  deleteBillingPlanItem(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/billing-plan-items/${id}`); }

  getTimeEntries(): Observable<TimeEntry[]> { return this.http.get<TimeEntry[]>(`${this.baseUrl}/time-entries`); }
  createTimeEntry(t: Partial<TimeEntry>): Observable<TimeEntry> { return this.http.post<TimeEntry>(`${this.baseUrl}/time-entries`, t); }
  updateTimeEntry(id: string, t: Partial<TimeEntry>): Observable<TimeEntry> { return this.http.put<TimeEntry>(`${this.baseUrl}/time-entries/${id}`, t); }
  deleteTimeEntry(id: string): Observable<void> { return this.http.delete<void>(`${this.baseUrl}/time-entries/${id}`); }

  // --- Approval workflow engine ---

  getApprovalRequests(): Observable<ApprovalRequest[]> { return this.http.get<ApprovalRequest[]>(`${this.baseUrl}/approval-requests`); }
  createApprovalRequest(a: Partial<ApprovalRequest>): Observable<ApprovalRequest> { return this.http.post<ApprovalRequest>(`${this.baseUrl}/approval-requests`, a); }
  decideApprovalRequest(id: string, decision: 'Approved' | 'Rejected', note?: string): Observable<ApprovalRequest> {
    // The deciding principal is derived server-side from the trusted actor (never a
    // client-supplied `by`), so the body is just { decision, note }. `note` is the
    // approver's note, recorded on the decided step (omitted when empty).
    return this.http.put<ApprovalRequest>(`${this.baseUrl}/approval-requests/${id}/decision`, { decision, ...(note ? { note } : {}) });
  }

  getAuditLogs(): Observable<AuditLog[]> { return this.http.get<AuditLog[]>(`${this.baseUrl}/audit-logs`); }

  // --- Multi-currency foundation ---

  getFxRates(): Observable<FxRate[]> { return this.http.get<FxRate[]>(`${this.baseUrl}/fx-rates`); }

  // --- Integrations (local-artifact adapters: implemented, NOT connected) ---

  getIntegrations(): Observable<IntegrationsInfo> { return this.http.get<IntegrationsInfo>(`${this.baseUrl}/integrations`); }

  getCrmOutbox(): Observable<CrmOutboxEntry[]> { return this.http.get<CrmOutboxEntry[]>(`${this.baseUrl}/integrations/crm/outbox`); }

  prepareCrmSync(): Observable<CrmOutboxEntry> { return this.http.post<CrmOutboxEntry>(`${this.baseUrl}/integrations/crm/outbox`, {}); }

  getBiFeedPreview(): Observable<BiFeedPreview> { return this.http.get<BiFeedPreview>(`${this.baseUrl}/integrations/bi/feed`); }

  /** URL of the ERP GL-journal export download (the page fetch-blobs it). */
  erpJournalExportUrl(format: 'csv' | 'json'): string {
    return `${this.baseUrl}/integrations/erp/journal-export?format=${format}`;
  }

  /** URL of the FatturaPA XML download for an invoiced order (fetch-blob). */
  einvoiceXmlUrl(orderId: string): string {
    return `${this.baseUrl}/integrations/einvoice/orders/${encodeURIComponent(orderId)}`;
  }
}
