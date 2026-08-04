import type { Assignment, Resource, ResourceRequest } from '../app/services/api.service';

/** Rate fields an employee must never receive about themselves. */
const SENSITIVE_RATE_FIELDS = [
  'costRate', 'billRate', 'costRateOverride', 'billRateOverride', 'costRateDay', 'billRateDay',
] as const;

export type SelfProfile = Omit<Resource, (typeof SENSITIVE_RATE_FIELDS)[number]>;

/**
 * Strip organization-sensitive rate data from the employee-facing profile.
 * Filtered from ONE list rather than a discarded destructure, so the omitted keys
 * and the `SelfProfile` type can never drift apart.
 */
export function toSelfProfile(resource: Resource): SelfProfile {
  const omitted: readonly string[] = SENSITIVE_RATE_FIELDS;
  return Object.fromEntries(
    Object.entries(resource).filter(([key]) => !omitted.includes(key)),
  ) as SelfProfile;
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
