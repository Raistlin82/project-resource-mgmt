import type { Assignment, ResourceRequest } from '../app/services/api.service';
import {
  canAccessGlobalTimeEntry,
  changeRequestDeleteError,
  changeRequestMutationError,
  deriveTimeEntryLinks,
  hasGlobalTimeEntryCollectionAccess,
  pinnedChangeRequestCreateFields,
  type TimeEntryPolicyContext,
} from './route-policy.util';

const target = { resourceId: 'worker-1', projectId: 'project-1' };

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
