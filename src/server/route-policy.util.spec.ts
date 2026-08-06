import type { Assignment, ResourceRequest, UserRole } from '../app/services/api.service';
import { hasAnyAllowedRole } from './authz-policy.util';
import {
  COMMERCIAL_MUTATION_RULES,
  canAccessGlobalTimeEntry,
  canSubmitOwnTime,
  changeRequestDeleteError,
  changeRequestMutationError,
  deriveTimeEntryLinks,
  hasGlobalTimeEntryCollectionAccess,
  isBillingMoneyActionPath,
  pinnedChangeRequestCreateFields,
  type TimeEntryPolicyContext,
} from './route-policy.util';

const target = { resourceId: 'worker-1', projectId: 'project-1' };

/**
 * roleGate's own resolution, replayed over the SAME exported array the server
 * spreads into its rule table: first match wins, then `hasAnyAllowedRole` over the
 * whole verified role set. Asserting through this (rather than on the constants)
 * is what makes the ORDER load-bearing in the test too — put the coarse rule
 * first and these expectations fail.
 */
function mayMutate(path: string, roles: readonly UserRole[]): boolean {
  const rule = COMMERCIAL_MUTATION_RULES.find(candidate => candidate.test(path));
  return rule === undefined || hasAnyAllowedRole(roles, rule.roles);
}

describe('commercial mutation rules', () => {
  it('refuses sales the two money-emitting billing actions and the batch form', () => {
    // THE DEFECT. Both actions inherited the coarse `/billing-plan-items` prefix
    // rule, which admits sales — the role that negotiated the price. One bearer
    // could issue the invoice (server-assigned invoiceNumber + customer order +
    // line) and then settle it, with no second party and no finance approval.
    for (const path of [
      '/billing-plan-items/BP3/generate-invoice',
      '/billing-plan-items/BP3/mark-paid',
      '/billing-plan-items/generate-invoices',
    ]) {
      expect(isBillingMoneyActionPath(path)).toBe(true);
      expect(mayMutate(path, ['sales'])).toBe(false);
      // NON-VACUITY: the finance-grade control. Without it a rule that refused
      // everyone would pass every assertion above while breaking invoicing.
      expect(mayMutate(path, ['finance'])).toBe(true);
      expect(mayMutate(path, ['delivery-executive'])).toBe(true);
      expect(mayMutate(path, ['admin'])).toBe(true);
    }
  });

  it('leaves sales its ordinary commercial CRUD, billing conditions included', () => {
    // ASSERTION OF ABSENCE. The narrow rule must not swallow the prefix: sales owns
    // the commercial chain and the billing PLAN whose prices it negotiates. A
    // regex anchored loosely (or a rule matching the bare prefix) would take all of
    // this away and still pass the test above.
    for (const path of ['/billing-plan-items', '/billing-plan-items/BP3', '/customers', '/orders/O1', '/negotiated-rates']) {
      expect(isBillingMoneyActionPath(path)).toBe(false);
      expect(mayMutate(path, ['sales'])).toBe(true);
    }
    // …and the prefix rule still refuses the roles it always refused.
    expect(mayMutate('/customers', ['pm'])).toBe(false);
    expect(mayMutate('/billing-plan-items/BP3', ['employee'])).toBe(false);
  });

  it('depends on the normalised path, like every other rule in the table', () => {
    // roleGate lower-cases the path before consulting any rule (Express routes
    // case-insensitively). Pinning that dependency here documents why the regex may
    // be lowercase-only: were the rule ever consulted with a raw path, the mixed-case
    // spelling would walk past it onto the coarse rule and sales would be admitted.
    expect(isBillingMoneyActionPath('/Billing-Plan-Items/BP3/generate-invoice')).toBe(false);
  });
});

describe('canSubmitOwnTime', () => {
  it('admits a multi-role principal whose primary role is not a time-submitting one', () => {
    // THE DEFECT. The handler collapsed the principal to its highest-priority role,
    // which is a DISPLAY concern: a presales consultant with realm roles
    // ['employee','sales'] resolves to primary 'sales', so every POST of their own
    // timesheet answered 403 while GET /self/assignments (full set) returned their
    // bookings. Not reproducible under AUTH_TRUST_HEADERS, which sends one role.
    expect(canSubmitOwnTime(['employee', 'sales'])).toBe(true);
    expect(canSubmitOwnTime(['sales', 'pm'])).toBe(true);
  });

  it('still refuses a principal with no time-submitting role at all', () => {
    // ASSERTION OF ABSENCE, twice: without these a helper that returned true
    // unconditionally would satisfy the case above — the blind green gate this
    // register names as the project's signature defect.
    expect(canSubmitOwnTime(['sales'])).toBe(false);
    expect(canSubmitOwnTime([])).toBe(false);
  });
});

function context(overrides: Partial<TimeEntryPolicyContext> = {}): TimeEntryPolicyContext {
  return {
    role: 'resource-manager',
    actorResourceId: 'manager-1',
    managedResourceIds: new Set(['worker-1']),
    ownedProjectIds: new Set(),
    ...overrides,
  };
}

describe('global time-entry policy', () => {
  it('forces employees through the /self boundary for every global action', () => {
    const employee = context({ role: 'employee', actorResourceId: 'worker-1' });

    expect(hasGlobalTimeEntryCollectionAccess('employee', 'read')).toBe(false);
    expect(hasGlobalTimeEntryCollectionAccess('employee', 'write')).toBe(false);
    expect(canAccessGlobalTimeEntry(employee, target, 'read')).toBe(false);
    expect(canAccessGlobalTimeEntry(employee, target, 'write')).toBe(false);
    expect(canAccessGlobalTimeEntry(employee, target, 'decide')).toBe(false);
  });

  it('keeps sales read-only and limits PM/resource-manager access to their scope', () => {
    expect(canAccessGlobalTimeEntry(context({ role: 'sales' }), target, 'read')).toBe(true);
    expect(canAccessGlobalTimeEntry(context({ role: 'sales' }), target, 'write')).toBe(false);

    expect(canAccessGlobalTimeEntry(context({
      role: 'pm',
      actorResourceId: 'pm-1',
      ownedProjectIds: new Set(['project-1']),
    }), target, 'write')).toBe(true);
    expect(canAccessGlobalTimeEntry(context({
      role: 'pm',
      actorResourceId: 'pm-1',
      ownedProjectIds: new Set(['other-project']),
    }), target, 'write')).toBe(false);

    expect(canAccessGlobalTimeEntry(context(), target, 'write')).toBe(true);
    expect(canAccessGlobalTimeEntry(context({ managedResourceIds: new Set(['worker-2']) }), target, 'write')).toBe(false);
  });

  it('allows decisions only to approver roles, in scope, and never by the owner', () => {
    expect(canAccessGlobalTimeEntry(context(), target, 'decide')).toBe(true);
    expect(canAccessGlobalTimeEntry(context({ actorResourceId: 'worker-1' }), target, 'decide')).toBe(false);
    expect(canAccessGlobalTimeEntry(context({ role: 'pm', ownedProjectIds: new Set(['project-1']) }), target, 'decide')).toBe(false);
    expect(canAccessGlobalTimeEntry(context({ role: 'finance', actorResourceId: 'finance-1' }), target, 'decide')).toBe(true);
    // If the decider cannot be mapped into the resource namespace, SoD cannot be
    // proven and the decision must fail closed.
    expect(canAccessGlobalTimeEntry(context({ role: 'finance', actorResourceId: undefined }), target, 'decide')).toBe(false);
  });

  it('derives every ownership/FK field from the assignment chain', () => {
    const assignment = {
      id: 'A1', requestId: 'R1', resourceId: 'worker-1', assignedHours: 8, status: 'Draft',
    } as Assignment;
    const request = {
      id: 'R1', projectId: 'project-1', name: 'Request', requiredRole: 'Developer',
      requiredEffort: 8, status: 'Open', skills: [],
    } as ResourceRequest;

    expect(deriveTimeEntryLinks(assignment, request)).toEqual({
      assignmentId: 'A1', requestId: 'R1', resourceId: 'worker-1', projectId: 'project-1',
    });
    expect(deriveTimeEntryLinks(assignment, { ...request, id: 'other' })).toBeUndefined();
    expect(deriveTimeEntryLinks(assignment, { ...request, projectId: undefined })).toBeUndefined();
  });
});

describe('change-request policy', () => {
  it('pins every new request to Draft and to the trusted creator', () => {
    expect(pinnedChangeRequestCreateFields('alice')).toEqual({
      status: 'Draft', requestedBy: 'alice', createdBy: 'alice',
    });
  });

  it('allows the ordinary Draft -> Submitted workflow', () => {
    expect(changeRequestMutationError({
      currentStatus: 'Draft', requestedStatus: 'Submitted', role: 'pm',
      actorId: 'alice', creatorId: 'alice', changesDomainFields: false,
    })).toBeNull();
  });

  it('rejects direct or illegal terminal transitions even for privileged roles', () => {
    expect(changeRequestMutationError({
      currentStatus: 'Draft', requestedStatus: 'Approved', role: 'admin',
      actorId: 'admin', creatorId: 'alice', changesDomainFields: false,
    })?.status).toBe(409);
  });

  it('requires delivery-executive/admin and segregation of duties for terminal transitions', () => {
    expect(changeRequestMutationError({
      currentStatus: 'Submitted', requestedStatus: 'Approved', role: 'pm',
      actorId: 'bob', creatorId: 'alice', changesDomainFields: false,
    })?.status).toBe(403);
    expect(changeRequestMutationError({
      currentStatus: 'Submitted', requestedStatus: 'Rejected', role: 'delivery-executive',
      actorId: 'alice', creatorId: 'alice', changesDomainFields: false,
    })?.status).toBe(403);
    expect(changeRequestMutationError({
      currentStatus: 'Submitted', requestedStatus: 'Approved', role: 'delivery-executive',
      actorId: 'bob', creatorId: 'alice', changesDomainFields: false,
    })).toBeNull();
    expect(changeRequestMutationError({
      currentStatus: 'Approved', requestedStatus: 'Implemented', role: 'admin',
      actorId: 'admin', creatorId: 'alice', changesDomainFields: false,
    })).toBeNull();
  });

  it('prevents editing business fields once a request has left Draft', () => {
    expect(changeRequestMutationError({
      currentStatus: 'Submitted', role: 'delivery-executive',
      actorId: 'bob', creatorId: 'alice', changesDomainFields: true,
    })?.status).toBe(409);
    expect(changeRequestMutationError({
      currentStatus: 'Approved', role: 'admin',
      actorId: 'admin', creatorId: 'alice', changesDomainFields: true,
    })?.status).toBe(409);
  });
});

describe('changeRequestDeleteError', () => {
  it('refuses to delete a change request that carries a decision', () => {
    // THE DEFECT. DELETE /change-requests/:id had no read, no 404 and no state
    // check, so every rule in changeRequestMutationError was bypassable by
    // deleting the row instead of transitioning it: a pm forbidden from moving an
    // Approved CR could erase the delivery-executive's Approved decision, and with
    // it the CR's contribution to the project's effective budget.
    for (const status of ['Submitted', 'Approved', 'Rejected', 'Implemented'] as const) {
      const err = changeRequestDeleteError(status);
      expect(err?.status).toBe(409);
      expect(err?.error).toContain(status);
    }
  });

  it('still allows deleting a Draft', () => {
    // ASSERTION OF ABSENCE. A blanket refusal passes the test above and strands
    // every abandoned draft in the list forever. A Draft is the author's own
    // un-submitted working copy and carries no decision.
    expect(changeRequestDeleteError('Draft')).toBeNull();
  });

  it('agrees with the PUT policy about which states are locked', () => {
    // The two guards must not drift: any status the PUT locks against domain
    // edits must also be undeletable, or the lock has a second door.
    for (const status of ['Submitted', 'Approved', 'Rejected', 'Implemented'] as const) {
      const putLocked = changeRequestMutationError({
        currentStatus: status, role: 'admin', actorId: 'admin',
        creatorId: 'alice', changesDomainFields: true,
      });
      expect(putLocked?.status).toBe(409);
      expect(changeRequestDeleteError(status)?.status).toBe(409);
    }
  });
});
