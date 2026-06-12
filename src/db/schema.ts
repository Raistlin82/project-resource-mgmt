/**
 * Drizzle ORM schema for the project resource management domain.
 *
 * SOURCE OF TRUTH: the TS interfaces in
 * `../app/services/api.service.ts` (client contract) and the in-memory stores
 * + seed arrays in `../../server.ts`. Drizzle table property names mirror the
 * EXACT camelCase TS field names; SQL column names are the snake_case form,
 * passed as the column-name argument.
 *
 * Conventions:
 *  - Every entity uses a string primary key. Most are `id: text('id')`; the two
 *    natural-key entities (`languages` keyed by `code`, `fxRates` keyed by
 *    `currency`) have no `id` in the source interfaces, so their natural key is
 *    the primary key — matching the actual seed data.
 *  - Money amounts and FX/exchange rates use `doublePrecision` (floating point,
 *    matching the JS `number` runtime representation in the mock).
 *  - Date-like values are stored as ISO strings in the mock, so they are
 *    `text()` here to avoid lossy timestamp conversion.
 *  - Nested arrays/objects use `jsonb()` typed via `.$type<...>()`.
 *  - Enum-like string unions use `.$type<Union>()` (no `any`).
 *  - Foreign keys are declared with `references(() => other.id)` where a
 *    relationship clearly exists; ambiguous links carry the column WITHOUT a
 *    hard FK and a `// TODO` note.
 */

import {
  pgTable,
  text,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

import type {
  UserRole,
  BillingType,
  ApprovalKind,
  ApprovalStatus,
  ApprovalStep,
} from '../app/services/api.service';

// ---------------------------------------------------------------------------
// Local helper types for jsonb payloads (mirrors of the nested shapes used by
// the TS interfaces — kept minimal so this file stays self-contained).
// ---------------------------------------------------------------------------

/** `Resource.skills` — named skill with a numeric proficiency level. */
interface ResourceSkill { name: string; level: number }

/** `Resource.externalExperience` — prior engagements outside the org. */
interface ExternalExperience {
  projectName: string;
  company: string;
  role: string;
  startDate: string;
  endDate: string;
  comment?: string;
}

/** `ProficiencySet.levels` — ordered proficiency rungs. */
interface ProficiencyLevel {
  id: string;
  level: number;
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Core resources & people
// ---------------------------------------------------------------------------

export const resources = pgTable(
  'resources',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    // nested object arrays / string arrays
    skills: jsonb('skills').$type<ResourceSkill[]>().notNull(),
    projectRoles: jsonb('project_roles').$type<string[]>().notNull(),
    externalExperience: jsonb('external_experience')
      .$type<ExternalExperience[]>()
      .notNull(),
    profilePicture: text('profile_picture'),
    resume: text('resume'),
    utilization: doublePrecision('utilization').notNull(),
    capacity: doublePrecision('capacity').notNull(),
    // self-reference: a resource's manager is another resource.
    managerId: text('manager_id'),
    organization: text('organization'),
    location: text('location'),
    costRate: doublePrecision('cost_rate'),
    billRate: doublePrecision('bill_rate'),
  },
  (t) => [
    index('resources_manager_id_idx').on(t.managerId),
  ],
);

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    name: text('name').notNull(),
    role: text('role').$type<UserRole>().notNull(),
  },
  (t) => [
    index('users_resource_id_idx').on(t.resourceId),
  ],
);

// ---------------------------------------------------------------------------
// Demand & staffing
// ---------------------------------------------------------------------------

export const requests = pgTable(
  'requests',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    requiredRole: text('required_role').notNull(),
    requiredEffort: doublePrecision('required_effort').notNull(),
    staffedEffort: doublePrecision('staffed_effort'),
    status: text('status').notNull(),
    skills: jsonb('skills').$type<string[]>().notNull(),
    description: text('description'),
    startDate: text('start_date'),
    endDate: text('end_date'),
    // requester is a user/resource; relationship is ambiguous (user vs resource).
    requesterId: text('requester_id'), // TODO: FK once requester entity is settled
    projectId: text('project_id').references(() => projects.id),
  },
  (t) => [
    index('requests_project_id_idx').on(t.projectId),
  ],
);

export const assignments = pgTable(
  'assignments',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    assignedHours: doublePrecision('assigned_hours').notNull(),
    status: text('status').notNull(),
    // Resource Schedule (Approach B): explicit booking window + allocation.
    // All three are NULLABLE and backward-compatible — the schedule util falls
    // back to the linked request's dates when an assignment carries none of its
    // own, and allocation defaults to 100% when unset.
    startDate: text('start_date'),
    endDate: text('end_date'),
    allocationPct: doublePrecision('allocation_pct'),
  },
  (t) => [
    index('assignments_request_id_idx').on(t.requestId),
    index('assignments_resource_id_idx').on(t.resourceId),
  ],
);

export const timeEntries = pgTable(
  'time_entries',
  {
    id: text('id').primaryKey(),
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => assignments.id),
    requestId: text('request_id')
      .notNull()
      .references(() => requests.id),
    resourceId: text('resource_id')
      .notNull()
      .references(() => resources.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    date: text('date').notNull(),
    hours: doublePrecision('hours').notNull(),
    status: text('status')
      .$type<'Draft' | 'Submitted' | 'Approved' | 'Rejected'>()
      .notNull(),
    notes: text('notes'),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
  },
  (t) => [
    index('time_entries_project_id_idx').on(t.projectId),
    index('time_entries_resource_id_idx').on(t.resourceId),
    index('time_entries_assignment_id_idx').on(t.assignmentId),
    index('time_entries_request_id_idx').on(t.requestId),
  ],
);

// ---------------------------------------------------------------------------
// Configuration / master data
// ---------------------------------------------------------------------------

// NOTE: `Language` has no `id` in the source interface; its natural key is
// `code`. We honor the source of truth and key the table on `code`.
export const languages = pgTable('languages', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull(),
});

export const skillCatalogs = pgTable('skill_catalogs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  // array of skill ids
  skills: jsonb('skills').$type<string[]>().notNull(),
});

export const proficiencySets = pgTable('proficiency_sets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  // nested ProficiencyLevel[]
  levels: jsonb('levels').$type<ProficiencyLevel[]>().notNull(),
});

export const skills = pgTable(
  'skills',
  {
    id: text('id').primaryKey(),
    conceptUri: text('concept_uri').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    // array of catalog ids
    catalogs: jsonb('catalogs').$type<string[]>().notNull(),
    proficiencySetId: text('proficiency_set_id').references(
      () => proficiencySets.id,
    ),
    restricted: boolean('restricted').notNull(),
  },
  (t) => [
    index('skills_proficiency_set_id_idx').on(
      t.proficiencySetId,
    ),
  ],
);

export const projectRoles = pgTable('project_roles', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  restricted: boolean('restricted').notNull(),
});

// ServiceOrganization: present in the client interface + server seed. Not in
// the explicit entity list of the task, but resourceOrganizations references
// it, so we declare it to support the FK below.
export const serviceOrganizations = pgTable('service_organizations', {
  id: text('id').primaryKey(),
  code: text('code').notNull(),
  description: text('description').notNull(),
  // array of cost-center codes (free-form strings, not costCenters.id)
  costCenters: jsonb('cost_centers').$type<string[]>().notNull(),
});

export const resourceOrganizations = pgTable(
  'resource_organizations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    // array of cost-center codes (free-form strings, not costCenters.id)
    costCenters: jsonb('cost_centers').$type<string[]>().notNull(),
    serviceOrganizationId: text('service_organization_id').references(
      () => serviceOrganizations.id,
    ),
  },
  (t) => [
    index('resource_organizations_service_organization_id_idx').on(
      t.serviceOrganizationId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Projects & project sub-resources
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    location: text('location').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    status: text('status').notNull(),
    description: text('description'),
    // owner is a user/resource — ambiguous which; leave soft.
    ownerId: text('owner_id'), // TODO: FK once owner entity (user vs resource) is settled
    contractId: text('contract_id').references(() => contracts.id),
  },
  (t) => [
    index('projects_contract_id_idx').on(t.contractId),
  ],
);

// `Partner` interface -> projectPartners table.
export const projectPartners = pgTable(
  'project_partners',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    company: text('company').notNull(),
    role: text('role').notNull(),
    contact: text('contact').notNull(),
    status: text('status').notNull(),
  },
  (t) => [
    index('project_partners_project_id_idx').on(t.projectId),
  ],
);

export const projectDocuments = pgTable(
  'project_documents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    type: text('type').notNull(),
    size: text('size').notNull(),
    uploadedAt: text('uploaded_at').notNull(),
    author: text('author').notNull(),
    authorInitials: text('author_initials').notNull(),
  },
  (t) => [
    index('project_documents_project_id_idx').on(t.projectId),
  ],
);

export const workPackages = pgTable(
  'work_packages',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    status: text('status')
      .$type<'Planned' | 'In Progress' | 'Completed'>()
      .notNull(),
    progress: doublePrecision('progress').notNull(),
    assignee: text('assignee').notNull(),
  },
  (t) => [
    index('work_packages_project_id_idx').on(t.projectId),
  ],
);

export const milestones = pgTable(
  'milestones',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    date: text('date').notNull(),
    status: text('status').$type<'Pending' | 'Achieved'>().notNull(),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
  },
  (t) => [
    index('milestones_project_id_idx').on(t.projectId),
  ],
);

// `FinancialItem` interface -> projectFinancials table.
export const projectFinancials = pgTable(
  'project_financials',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    category: text('category').notNull(),
    budget: doublePrecision('budget').notNull(),
    actual: doublePrecision('actual').notNull(),
  },
  (t) => [
    index('project_financials_project_id_idx').on(t.projectId),
  ],
);

export const projectCostCenters = pgTable(
  'project_cost_centers',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    manager: text('manager').notNull(),
    allocated: doublePrecision('allocated').notNull(),
    actual: doublePrecision('actual').notNull(),
  },
  (t) => [
    index('project_cost_centers_project_id_idx').on(t.projectId),
  ],
);

// `Task` interface -> projectTasks table.
export const projectTasks = pgTable(
  'project_tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    assignee: text('assignee').notNull(),
    assigneeType: text('assignee_type').$type<'Internal' | 'Subcontractor'>(),
    partnerId: text('partner_id').references(() => projectPartners.id),
    dueDate: text('due_date').notNull(),
    status: text('status').notNull(),
    priority: text('priority').notNull(),
  },
  (t) => [
    index('project_tasks_project_id_idx').on(t.projectId),
    index('project_tasks_partner_id_idx').on(t.partnerId),
  ],
);

// `Issue` interface -> projectIssues table.
export const projectIssues = pgTable(
  'project_issues',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    type: text('type').notNull(),
    severity: text('severity').notNull(),
    status: text('status').notNull(),
    reportedBy: text('reported_by').notNull(),
    owner: text('owner'),
    dueDate: text('due_date'),
    impact: text('impact'),
    actionPlan: text('action_plan'),
    escalated: boolean('escalated'),
  },
  (t) => [
    index('project_issues_project_id_idx').on(t.projectId),
  ],
);

export const changeRequests = pgTable(
  'change_requests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    requestedBy: text('requested_by').notNull(),
    owner: text('owner').notNull(),
    status: text('status')
      .$type<'Draft' | 'Submitted' | 'Approved' | 'Rejected' | 'Implemented'>()
      .notNull(),
    impactScope: text('impact_scope').notNull(),
    impactBudget: doublePrecision('impact_budget').notNull(),
    impactScheduleDays: integer('impact_schedule_days').notNull(),
    priority: text('priority')
      .$type<'Low' | 'Medium' | 'High' | 'Critical'>()
      .notNull(),
    createdAt: text('created_at').notNull(),
    // SERVER-PINNED creator: the immutable SoD basis for self-approval (set once
    // on POST from the verified actor; never client-rewritable). Nullable so rows
    // created before this column existed remain valid.
    createdBy: text('created_by'),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
  },
  (t) => [
    index('change_requests_project_id_idx').on(t.projectId),
  ],
);

// Top-level (non-project) cost centers.
export const costCenters = pgTable('cost_centers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  manager: text('manager').notNull(),
  allocated: doublePrecision('allocated').notNull(),
  actual: doublePrecision('actual').notNull(),
});

// ---------------------------------------------------------------------------
// Commercial domain (ADR-0001)
// ---------------------------------------------------------------------------

export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  industry: text('industry'),
  country: text('country'),
});

export const contracts = pgTable(
  'contracts',
  {
    id: text('id').primaryKey(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    name: text('name').notNull(),
    type: text('type').$type<'T&M' | 'Fixed Price' | 'Framework'>().notNull(),
    totalValue: doublePrecision('total_value').notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<'Draft' | 'Active' | 'Closed'>().notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
  },
  (t) => [
    index('contracts_customer_id_idx').on(t.customerId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    contractId: text('contract_id')
      .notNull()
      .references(() => contracts.id),
    type: text('type').$type<'Customer' | 'Purchase'>().notNull(),
    // a Purchase order may reference a supplying partner.
    partnerId: text('partner_id').references(() => projectPartners.id),
    amount: doublePrecision('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status')
      .$type<'Open' | 'Confirmed' | 'Invoiced' | 'Paid'>()
      .notNull(),
    orderDate: text('order_date').notNull(),
    // SERVER-SET fields.
    invoiceNumber: text('invoice_number'),
    invoiceDate: text('invoice_date'),
  },
  (t) => [
    index('orders_contract_id_idx').on(t.contractId),
    index('orders_partner_id_idx').on(t.partnerId),
  ],
);

export const orderLines = pgTable(
  'order_lines',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    description: text('description').notNull(),
    amount: doublePrecision('amount').notNull(),
  },
  (t) => [
    index('order_lines_order_id_idx').on(t.orderId),
    index('order_lines_project_id_idx').on(t.projectId),
  ],
);

export const billingPlanItems = pgTable(
  'billing_plan_items',
  {
    id: text('id').primaryKey(),
    contractId: text('contract_id')
      .notNull()
      .references(() => contracts.id),
    projectId: text('project_id').references(() => projects.id),
    type: text('type').$type<BillingType>().notNull(),
    label: text('label').notNull(),
    milestoneId: text('milestone_id').references(() => milestones.id),
    recurrence: text('recurrence').$type<'Monthly' | 'Quarterly' | 'Annual'>(),
    expectedDate: text('expected_date'),
    amount: doublePrecision('amount').notNull(),
    capAmount: doublePrecision('cap_amount'),
    progressPct: doublePrecision('progress_pct'),
    markupPct: doublePrecision('markup_pct'),
    retentionPct: doublePrecision('retention_pct'),
    taxRatePct: doublePrecision('tax_rate_pct'),
    paymentTermsDays: integer('payment_terms_days'),
    currency: text('currency').notNull(),
    status: text('status')
      .$type<'Planned' | 'Ready' | 'Invoiced' | 'Paid' | 'Blocked'>()
      .notNull(),
    issuedDate: text('issued_date'),
    dueDate: text('due_date'),
    paidDate: text('paid_date'),
    // generated invoice/order
    orderId: text('order_id').references(() => orders.id),
    notes: text('notes'),
  },
  (t) => [
    index('billing_plan_items_contract_id_idx').on(t.contractId),
    index('billing_plan_items_project_id_idx').on(t.projectId),
    index('billing_plan_items_milestone_id_idx').on(
      t.milestoneId,
    ),
    index('billing_plan_items_order_id_idx').on(t.orderId),
  ],
);

// ---------------------------------------------------------------------------
// Multi-currency foundation
// ---------------------------------------------------------------------------

// NOTE: `FxRate` has no `id` in the source interface; its natural key is
// `currency`. We honor the source of truth and key the table on `currency`.
export const fxRates = pgTable('fx_rates', {
  currency: text('currency').primaryKey(),
  rateToBase: doublePrecision('rate_to_base').notNull(),
});

// ---------------------------------------------------------------------------
// Approval workflow engine
// ---------------------------------------------------------------------------

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<ApprovalKind>().notNull(),
    // polymorphic reference into the entity named by `kind`; intentionally soft.
    refId: text('ref_id').notNull(), // TODO: polymorphic FK (target depends on `kind`)
    projectId: text('project_id').references(() => projects.id),
    amount: doublePrecision('amount'),
    requestedBy: text('requested_by').notNull(),
    status: text('status').$type<ApprovalStatus>().notNull(),
    // nested ApprovalStep[]
    steps: jsonb('steps').$type<ApprovalStep[]>().notNull(),
    currentStep: integer('current_step').notNull(),
    createdAt: text('created_at').notNull(),
    slaDueAt: text('sla_due_at'),
    note: text('note'),
  },
  (t) => [
    index('approval_requests_project_id_idx').on(t.projectId),
    index('approval_requests_ref_id_idx').on(t.refId),
  ],
);

// ---------------------------------------------------------------------------
// Audit log (append-only)
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    actorId: text('actor_id').notNull(),
    actorRole: text('actor_role').$type<UserRole | 'unknown'>().notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    // append-only before/after snapshots of just the changed keys.
    changedKeys: jsonb('changed_keys').$type<string[]>(),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
  },
  (t) => [
    // The audit-log read is paged newest-first by `at` (ORDER BY at DESC LIMIT
    // OFFSET); this index keeps that bounded query from a full scan/sort.
    index('audit_logs_at_idx').on(t.at),
  ],
);
