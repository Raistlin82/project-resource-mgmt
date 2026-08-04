import type { Assignment, Resource, ResourceRequest } from '../app/services/api.service';

export type SelfProfile = Omit<
  Resource,
  'costRate' | 'billRate' | 'costRateOverride' | 'billRateOverride' | 'costRateDay' | 'billRateDay'
>;

/** Strip organization-sensitive rate data from the employee-facing profile. */
export function toSelfProfile(resource: Resource): SelfProfile {
  const {
    costRate: _costRate,
    billRate: _billRate,
    costRateOverride: _costRateOverride,
    billRateOverride: _billRateOverride,
    costRateDay: _costRateDay,
    billRateDay: _billRateDay,
    ...self
  } = resource;
  return self;
}

/** Only fields owned by the employee profile workflow may cross /self/profile. */
export function pickSelfProfilePatch(body: unknown): Partial<Resource> {
  if (!body || typeof body !== 'object') return {};
  const source = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const field of ['skills', 'projectRoles', 'externalExperience', 'profilePicture', 'resume'] as const) {
    if (source[field] !== undefined) patch[field] = source[field];
  }
  return patch as Partial<Resource>;
}

export function selfAssignments(assignments: readonly Assignment[], resourceId: string): Assignment[] {
  return assignments.filter(assignment => assignment.resourceId === resourceId);
}

export function selfRequests(
  requests: readonly ResourceRequest[],
  assignments: readonly Assignment[],
  resourceId: string,
): ResourceRequest[] {
  const linkedRequestIds = new Set(selfAssignments(assignments, resourceId).map(assignment => assignment.requestId));
  return requests.filter(request => linkedRequestIds.has(request.id));
}

export function isOwnAssignment(
  assignments: readonly Assignment[],
  assignmentId: string,
  resourceId: string,
): boolean {
  return assignments.some(assignment => assignment.id === assignmentId && assignment.resourceId === resourceId);
}
