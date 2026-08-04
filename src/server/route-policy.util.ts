import type {
  Assignment,
  ChangeRequest,
  ResourceRequest,
  UserRole,
} from '../app/services/api.service';

export type TrustedRole = UserRole | 'unknown';
export type GlobalTimeEntryAction = 'read' | 'write' | 'decide';

export interface TimeEntryPolicyContext {
  role: TrustedRole;
  actorResourceId?: string;
  managedResourceIds?: ReadonlySet<string>;
  ownedProjectIds?: ReadonlySet<string>;
}

export interface TimeEntryPolicyTarget {
  resourceId: string;
  projectId: string;
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

/** Employees deliberately have no access here: their boundary is `/self/time-entries`. */
export function hasGlobalTimeEntryCollectionAccess(
  role: TrustedRole,
  action: GlobalTimeEntryAction,
): boolean {
  if (action === 'read') return GLOBAL_TIME_ENTRY_READ_ROLES.has(role);
  if (action === 'write') return GLOBAL_TIME_ENTRY_WRITE_ROLES.has(role);
  return GLOBAL_TIME_ENTRY_DECISION_ROLES.has(role);
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
 */
export function canAccessGlobalTimeEntry(
  context: TimeEntryPolicyContext,
  target: TimeEntryPolicyTarget,
  action: GlobalTimeEntryAction,
): boolean {
  if (!hasGlobalTimeEntryCollectionAccess(context.role, action)) return false;
  if (action === 'decide') {
    if (!context.actorResourceId || context.actorResourceId === target.resourceId) return false;
  }

  switch (context.role) {
    case 'admin':
    case 'delivery-executive':
    case 'finance':
    case 'sales':
      return true;
    case 'pm':
      return context.actorResourceId !== undefined
        && (context.ownedProjectIds?.has(target.projectId) ?? false);
    case 'resource-manager':
      return context.actorResourceId !== undefined
        && (context.managedResourceIds?.has(target.resourceId) ?? false);
    default:
      return false;
  }
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
