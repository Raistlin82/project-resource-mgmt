import type {
  Assignment,
  ChangeRequest,
  ResourceRequest,
  UserRole,
} from '../app/services/api.service';

export type TrustedRole = UserRole | 'unknown';
export type GlobalTimeEntryAction = 'read' | 'write' | 'decide';

export interface TimeEntryPolicyContext {
  /**
   * The WHOLE verified role set, never a collapsed primary role.
   *
   * This field used to be `role: TrustedRole`, filled from `primaryRole()` —
   * which is a DISPLAY concern (`ROLE_PRIORITY` picks the highest-ranked role so
   * the UI has one label to show). roleGate authorizes on the SET
   * (`hasAnyAllowedRole`), so the object-level policy disagreed with the gate
   * that had just admitted the request: a PM whose Keycloak roles are
   * `['pm','sales']` collapsed to 'sales' and lost every write and decision on
   * their OWN projects — 403 "Role sales cannot write global time entries" on a
   * correction only they own. A `['resource-manager','sales']` people manager
   * lost the timesheet decision path for their own reports the same way.
   *
   * Renaming the field (and changing its type to an array) is deliberate: it
   * makes passing a single role a COMPILE ERROR at every call site, the same
   * discipline `canSubmitOwnTime` already enforces. Not reproducible under
   * AUTH_TRUST_HEADERS, which parses exactly one `X-User-Role` — which is why
   * no existing check caught it.
   */
  roles: readonly TrustedRole[];
  actorResourceId?: string;
  managedResourceIds?: ReadonlySet<string>;
  ownedProjectIds?: ReadonlySet<string>;
}

export interface TimeEntryPolicyTarget {
  resourceId: string;
  projectId: string;
}

/**
 * The two `/billing-plan-items` sub-actions that EMIT MONEY, plus the batch form
 * of the first one.
 *
 * They used to inherit the coarse `/billing-plan-items` prefix rule, which admits
 * `sales` — the role that negotiated the price. One `sales` bearer could therefore
 * take a condition to cash alone: `POST :id/generate-invoice` assigns the next
 * sequential invoiceNumber and writes the customer order + invoice line, then
 * `POST :id/mark-paid` settles both. Two calls, one actor, no second party, no
 * `Invoice` approval request, and revenue recognised on a document nobody in
 * finance ever saw. `/generate-invoices` does it for up to 100 conditions at once.
 *
 * Matched on the NORMALISED path (roleGate lower-cases it before consulting any
 * rule), because Express routes case-insensitively: an un-normalised
 * `/Billing-Plan-Items/BP3/generate-invoice` would walk straight past this rule
 * and land back on the coarse one.
 */
export const BILLING_MONEY_ACTION_ROLES: readonly UserRole[] = ['finance', 'delivery-executive', 'admin'];
const BILLING_MONEY_ACTION_PATH = /^\/billing-plan-items\/(generate-invoices|[^/]+\/(generate-invoice|mark-paid))$/;

/** True for the invoice-issuing / payment-settling billing actions. */
export function isBillingMoneyActionPath(path: string): boolean {
  return BILLING_MONEY_ACTION_PATH.test(path);
}

/** One entry of roleGate's mutation-rule table: first match wins. */
export interface MutationRule {
  test: (path: string) => boolean;
  roles: readonly UserRole[];
}

const COMMERCIAL_PREFIXES = [
  '/customers', '/contracts', '/orders', '/order-lines', '/billing-plan-items', '/negotiated-rates',
];

/**
 * The commercial slice of roleGate's mutation table, ORDER-SENSITIVE and exported
 * as one array so the order cannot be lost at the call site: `rules.find` returns
 * the FIRST match, so the narrow money-action rule has to precede the coarse
 * prefix rule or it is dead code that still reads as a guard.
 *
 * `sales` keeps ordinary commercial CRUD — including the billing PLAN itself, whose
 * prices it negotiates. What it loses is issuing the invoice and settling it.
 */
export const COMMERCIAL_MUTATION_RULES: readonly MutationRule[] = [
  { test: isBillingMoneyActionPath, roles: BILLING_MONEY_ACTION_ROLES },
  {
    test: path => COMMERCIAL_PREFIXES.some(prefix => path.startsWith(prefix)),
    roles: ['sales', 'finance', 'delivery-executive', 'admin'],
  },
];

/**
 * Roles allowed to book time on their OWN assignment via `/self/time-entries`.
 *
 * Deliberately typed on the whole verified role SET, not a single role. The
 * handler used to collapse the principal to its highest-priority role
 * (`ROLE_PRIORITY`), which is a DISPLAY concern: a presales consultant whose
 * Keycloak roles are `['employee','sales']` resolves to primary 'sales', so every
 * submit of their own timesheet answered 403 while the same principal's reads
 * (which use the full set) returned their bookings. roleGate authorizes on the
 * set — `hasAnyAllowedRole` — so the object-level check has to as well, or the
 * two disagree. Not reproducible under AUTH_TRUST_HEADERS (one X-User-Role per
 * request), which is why no existing check caught it.
 */
export const SELF_TIME_SUBMIT_ROLES: readonly UserRole[] = [
  'employee', 'pm', 'resource-manager', 'delivery-executive', 'finance', 'admin',
];

/** True iff ANY held application role may submit own time. */
export function canSubmitOwnTime(roles: readonly UserRole[]): boolean {
  return roles.some(role => SELF_TIME_SUBMIT_ROLES.includes(role));
}

const GLOBAL_TIME_ENTRY_READ_ROLES = new Set<TrustedRole>([
  'pm', 'resource-manager', 'sales', 'finance', 'delivery-executive', 'admin',
]);
const GLOBAL_TIME_ENTRY_WRITE_ROLES = new Set<TrustedRole>([
  'pm', 'resource-manager', 'finance', 'delivery-executive', 'admin',
]);
const GLOBAL_TIME_ENTRY_DECISION_ROLES = new Set<TrustedRole>([
  'resource-manager', 'finance', 'delivery-executive', 'admin',
]);

/**
 * Roles whose time-entry reach is ORGANIZATION-WIDE for the actions they are
 * admitted to at all. `sales` belongs here and must STAY here: it is org-wide
 * READ by design (READ_RULES admits it to GET /time-entries) and appears in no
 * other action set, so the per-action gate is what keeps it read-only. Narrowing
 * it would break the documented sales read.
 */
const ORG_WIDE_TIME_ENTRY_ROLES = new Set<TrustedRole>([
  'admin', 'delivery-executive', 'finance', 'sales',
]);

/** Does ONE role admit `action` at the collection level? */
function roleAdmitsTimeEntryAction(role: TrustedRole, action: GlobalTimeEntryAction): boolean {
  if (action === 'read') return GLOBAL_TIME_ENTRY_READ_ROLES.has(role);
  if (action === 'write') return GLOBAL_TIME_ENTRY_WRITE_ROLES.has(role);
  return GLOBAL_TIME_ENTRY_DECISION_ROLES.has(role);
}

/**
 * Employees deliberately have no access here: their boundary is
 * `/self/time-entries`. Evaluated over the WHOLE role set — see
 * `TimeEntryPolicyContext.roles` for what the collapsed form cost.
 */
export function hasGlobalTimeEntryCollectionAccess(
  roles: readonly TrustedRole[],
  action: GlobalTimeEntryAction,
): boolean {
  return roles.some(role => roleAdmitsTimeEntryAction(role, action));
}

/**
 * Object-level time-entry policy.
 *
 * PM scope is the set of projects they own; resource-manager scope is the union
 * of their reporting line and managed organization subtrees. Finance,
 * delivery-executive and admin are organization-wide; sales is read-only.
 * Decisions additionally fail closed unless the actor can be resolved into the
 * same resource namespace as the entry owner, because otherwise SoD cannot be
 * proven.
 *
 * A PER-ROLE UNION, not "org-wide if any held role is org-wide": the two are
 * different, and the difference is an over-grant. A `['pm','sales']` principal
 * writing a time entry passes the collection gate through 'pm', and 'sales' is in
 * the org-wide set — so a set-wide org test would hand that PM WRITE access to
 * every project in the company. Each held role is therefore asked the whole
 * question (does it admit this action, and does its own scope cover this target),
 * and the answers are OR'd. The PM keeps pm scope for writes and gains sales'
 * org-wide READ, which is exactly the documented semantics.
 */
export function canAccessGlobalTimeEntry(
  context: TimeEntryPolicyContext,
  target: TimeEntryPolicyTarget,
  action: GlobalTimeEntryAction,
): boolean {
  if (!hasGlobalTimeEntryCollectionAccess(context.roles, action)) return false;
  if (action === 'decide') {
    if (!context.actorResourceId || context.actorResourceId === target.resourceId) return false;
  }

  const grants = (role: TrustedRole): boolean => {
    if (!roleAdmitsTimeEntryAction(role, action)) return false;
    if (ORG_WIDE_TIME_ENTRY_ROLES.has(role)) return true;
    if (context.actorResourceId === undefined) return false;
    if (role === 'pm') return context.ownedProjectIds?.has(target.projectId) ?? false;
    if (role === 'resource-manager') return context.managedResourceIds?.has(target.resourceId) ?? false;
    return false;
  };
  return context.roles.some(grants);
}

/**
 * Does the actor hold the role an approval STEP was routed to?
 *
 * The engine compared `primaryRole(roles)` to `step.role`, so a finance
 * controller whose Keycloak account also carries 'delivery-executive' — a normal
 * grant for a CFO on the delivery board — collapsed to 'delivery-executive'
 * (priority 5 beats finance's 4) and was refused the finance step routed to
 * them: "Actor cannot decide a step assigned to finance", worded as though they
 * did not hold the role they hold. A high-value invoice then had no approver at
 * all, since `crossStepSoDError` also bars the admin who cleared the earlier
 * step. Symmetrically a `['resource-manager','finance']` people manager could
 * never decide a TimeEntry step routed to 'resource-manager'.
 *
 * `admin` matches every step, as it did before — SoD is enforced separately and
 * binds every role, including admin.
 */
export function stepRoleMatch(decidingRoles: readonly UserRole[], stepRole: string): boolean {
  return decidingRoles.some(role => role === stepRole || role === 'admin');
}

/**
 * Roles that are never narrowed by allocation SCOPE (§3.3). Set-based for the
 * same reason as `stepRoleMatch`: holding a global role must not depend on it
 * happening to outrank every other role the principal carries.
 */
export function hasGlobalApprovalRole(decidingRoles: readonly UserRole[]): boolean {
  return decidingRoles.some(role => role === 'admin' || role === 'delivery-executive');
}

export interface DerivedTimeEntryLinks {
  assignmentId: string;
  requestId: string;
  resourceId: string;
  projectId: string;
}

/** Derive all denormalized time-entry references from one coherent assignment chain. */
export function deriveTimeEntryLinks(
  assignment: Assignment,
  request: ResourceRequest,
): DerivedTimeEntryLinks | undefined {
  if (request.id !== assignment.requestId || !request.projectId) return undefined;
  return {
    assignmentId: assignment.id,
    requestId: request.id,
    resourceId: assignment.resourceId,
    projectId: request.projectId,
  };
}

export interface ChangeRequestPolicyError {
  status: 403 | 409;
  error: string;
}

export interface ChangeRequestMutationContext {
  currentStatus: ChangeRequest['status'];
  requestedStatus?: ChangeRequest['status'];
  role: TrustedRole;
  actorId: string;
  creatorId: string;
  changesDomainFields: boolean;
}

const CHANGE_REQUEST_TRANSITIONS: Readonly<Record<ChangeRequest['status'], readonly ChangeRequest['status'][]>> = {
  Draft: ['Submitted'],
  Submitted: ['Draft', 'Approved', 'Rejected'],
  Approved: ['Implemented'],
  Rejected: [],
  Implemented: [],
};
const CHANGE_REQUEST_TERMINAL_TARGETS = new Set<ChangeRequest['status']>([
  'Approved', 'Rejected', 'Implemented',
]);

/** Server-owned fields for a newly-created change request. */
export function pinnedChangeRequestCreateFields(actorId: string): {
  status: 'Draft'; requestedBy: string; createdBy: string;
} {
  return { status: 'Draft', requestedBy: actorId, createdBy: actorId };
}

/**
 * State-machine and SoD backstop for change-request PUTs.
 * Business fields are editable only while Draft; terminal transitions require
 * delivery-executive/admin and a decider different from the pinned creator.
 */
export function changeRequestMutationError(
  context: ChangeRequestMutationContext,
): ChangeRequestPolicyError | null {
  if (context.changesDomainFields && context.currentStatus !== 'Draft') {
    return { status: 409, error: `Change request ${context.currentStatus} is locked; return it to Draft through the workflow before editing` };
  }

  const next = context.requestedStatus;
  if (next === undefined || next === context.currentStatus) return null;
  if (!CHANGE_REQUEST_TRANSITIONS[context.currentStatus].includes(next)) {
    return { status: 409, error: `Illegal change-request transition: ${context.currentStatus} -> ${next}` };
  }

  if (CHANGE_REQUEST_TERMINAL_TARGETS.has(next)) {
    if (context.role !== 'delivery-executive' && context.role !== 'admin') {
      return { status: 403, error: 'Only delivery-executive or admin may perform a terminal change-request transition' };
    }
    if (context.actorId === context.creatorId) {
      return { status: 403, error: 'Segregation of duties: the change request creator cannot decide their own change request' };
    }
  }
  return null;
}

/**
 * State backstop for change-request DELETEs — the counterpart of
 * `changeRequestMutationError`, which guarded the PUT alone.
 *
 * DELETE had no read, no 404 and no state check: `repos.changeRequests.remove(id)`
 * then 204. So every rule above could be bypassed by DELETING the row instead of
 * transitioning it. A pm who could not move an Approved CR (terminal transitions
 * need delivery-executive/admin, and SoD forbids the creator deciding) could
 * simply erase the delivery-executive's Approved decision — and with it the
 * change request's contribution to the project's effective budget — leaving only
 * an audit entry to explain a figure that silently dropped.
 *
 * Draft stays deletable: it is the author's own un-submitted working copy and
 * carries no decision. Everything from Submitted onward has entered the workflow
 * and must be walked back through it, not deleted.
 */
export function changeRequestDeleteError(
  currentStatus: ChangeRequest['status'],
): ChangeRequestPolicyError | null {
  if (currentStatus === 'Draft') return null;
  return {
    status: 409,
    error: `Change request ${currentStatus} cannot be deleted: it carries a workflow decision. `
      + 'Return it to Draft through the workflow first, or leave the record in place',
  };
}
