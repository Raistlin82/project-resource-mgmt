import type { Assignment, ResourceRequest } from '../app/services/api.service';

export interface AssignmentDependants {
  hasDays?: boolean;
  hasMonths?: boolean;
  hasTimeEntries?: boolean;
  hasApprovals?: boolean;
}

export interface EmploymentWindow {
  hireDate?: string | null;
  terminationDate?: string | null;
}

export const CLIENT_REQUEST_STATUSES = ['Not Published', 'Published', 'Open', 'Withdrawn'] as const;
const ALL_REQUEST_STATUSES = [...CLIENT_REQUEST_STATUSES, 'Fulfilled'] as const;

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Strict calendar ISO date, not Date.parse's permissive rollover/parser. */
export function isStrictIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Reject direct writes to the assignment fields owned by day/month rollups. */
export function assignmentServerOwnedFieldError(body: object): string | null {
  if (owns(body, 'assignedHours')) {
    return 'assignedHours is derived from assignmentDays and cannot be set on an assignment';
  }
  if (owns(body, 'status')) {
    return 'status is derived from the per-month allocation and cannot be set on an assignment';
  }
  return null;
}

/**
 * Retargeting an assignment's requestId/resourceId is refused only when the move
 * would orphan LOGGED ACTUALS.
 *
 * SCOPE NARROWED DELIBERATELY (reconciliation, 2026-08-04). This guard was
 * written on the premise, stated in its original docstring, that moving a
 * populated assignment "requires a future explicit workflow capable of
 * migrating/reconciling every linked record atomically". That workflow is not in
 * the future: `PUT /assignments/:id` already implements retarget propagation —
 * it withdraws the old approval, raises a new one against the NEW resource's
 * manager, and hands substituted hours back — and ~12 checks in
 * scripts/smoke-api.mjs (B3 retarget, C2 substituted/given-back retarget) assert
 * exactly that. Refusing on days/months/approvals therefore disabled shipped,
 * tested behaviour rather than protecting anything.
 *
 * `timeEntries` IS still refused: an approved or submitted actual belongs to the
 * person who worked it, nothing in the propagation path re-attributes one, and
 * moving the assignment under it would silently credit somebody else's hours.
 */
export function assignmentRetargetError(
  existing: Pick<Assignment, 'requestId' | 'resourceId'>,
  patch: Partial<Pick<Assignment, 'requestId' | 'resourceId'>>,
  dependants: AssignmentDependants,
): string | null {
  const changesRequest = patch.requestId !== undefined && patch.requestId !== existing.requestId;
  const changesResource = patch.resourceId !== undefined && patch.resourceId !== existing.resourceId;
  if (!changesRequest && !changesResource) return null;
  if (!dependants.hasTimeEntries) return null;

  return 'assignment has logged time entries; retargeting it would re-attribute '
    + 'somebody else\'s actual hours';
}

/** Optional value: null means inherit the organization setting. */
export function contractHoursPerDayError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'contractHoursPerDay must be a positive finite number';
  }
  return null;
}

/** Validate the resource's own employment interval. */
export function employmentWindowError(window: EmploymentWindow, requireHireDate = false): string | null {
  const hire = window.hireDate;
  const termination = window.terminationDate;
  if (requireHireDate && !isStrictIsoDate(hire)) {
    return 'hireDate is required and must match YYYY-MM-DD';
  }
  if (hire !== undefined && hire !== null && hire !== '' && !isStrictIsoDate(hire)) {
    return 'hireDate must match YYYY-MM-DD';
  }
  if (termination !== undefined && termination !== null && termination !== '' && !isStrictIsoDate(termination)) {
    return 'terminationDate must match YYYY-MM-DD';
  }
  if (isStrictIsoDate(hire) && isStrictIsoDate(termination) && termination < hire) {
    return 'terminationDate must be on or after hireDate';
  }
  return null;
}

/** Validate exact booking/day dates against inclusive employment boundaries. */
export function bookingOutsideEmploymentError(
  dates: readonly string[],
  window: EmploymentWindow,
): string | null {
  const ordered = [...new Set(dates)].sort();
  for (const date of ordered) {
    if (!isStrictIsoDate(date)) return `booking date ${date} must match YYYY-MM-DD`;
    if (isStrictIsoDate(window.hireDate) && date < window.hireDate) {
      return `booking date ${date} is before hireDate ${window.hireDate}`;
    }
    if (isStrictIsoDate(window.terminationDate) && date > window.terminationDate) {
      return `booking date ${date} is after terminationDate ${window.terminationDate}`;
    }
  }
  return null;
}

/** Validate a partial assignment window against a resource's employment. */
export function bookingWindowOutsideEmploymentError(
  booking: { startDate?: string; endDate?: string },
  window: EmploymentWindow,
): string | null {
  return bookingOutsideEmploymentError(
    [booking.startDate, booking.endDate].filter((date): date is string => date !== undefined),
    window,
  );
}

/**
 * Validate the complete ResourceRequest produced by merging a partial PUT.
 * `Fulfilled` is accepted only when it was already server-owned; a client patch
 * may choose only the publish/withdraw lifecycle statuses.
 */
export function resourceRequestUpdateError(
  existing: ResourceRequest,
  patch: Partial<ResourceRequest>,
): string | null {
  if (owns(patch, 'status')
      && patch.status !== undefined
      && !(CLIENT_REQUEST_STATUSES as readonly string[]).includes(patch.status)) {
    return `status must be one of: ${CLIENT_REQUEST_STATUSES.join(', ')}`;
  }
  const merged = { ...existing, ...patch };
  if (typeof merged.name !== 'string' || merged.name.trim() === '') return 'name is required';
  if (typeof merged.requiredRole !== 'string' || merged.requiredRole.trim() === '') return 'requiredRole is required';
  if (typeof merged.requiredEffort !== 'number' || !Number.isFinite(merged.requiredEffort) || merged.requiredEffort <= 0) {
    return 'requiredEffort must be a positive finite number';
  }
  if (!Array.isArray(merged.skills)) return 'skills must be an array';
  if (merged.skills.some(skill => typeof skill !== 'string' || skill.trim() === '')) {
    return 'skills must contain non-empty catalog names';
  }
  if (typeof merged.status !== 'string' || !(ALL_REQUEST_STATUSES as readonly string[]).includes(merged.status)) {
    return `stored status must be one of: ${ALL_REQUEST_STATUSES.join(', ')}`;
  }
  if (merged.staffedEffort !== undefined
      && (typeof merged.staffedEffort !== 'number' || !Number.isFinite(merged.staffedEffort) || merged.staffedEffort < 0)) {
    return 'staffedEffort must be a non-negative finite server-derived number';
  }
  if (merged.staffedEffortPlanned !== undefined
      && (typeof merged.staffedEffortPlanned !== 'number'
        || !Number.isFinite(merged.staffedEffortPlanned)
        || merged.staffedEffortPlanned < 0)) {
    return 'staffedEffortPlanned must be a non-negative finite server-derived number';
  }
  if (merged.staffedEffort !== undefined
      && merged.staffedEffortPlanned !== undefined
      && merged.staffedEffortPlanned < merged.staffedEffort) {
    return 'staffedEffortPlanned cannot be below staffedEffort';
  }
  if (merged.startDate !== undefined && !isStrictIsoDate(merged.startDate)) {
    return 'startDate must match YYYY-MM-DD';
  }
  if (merged.endDate !== undefined && !isStrictIsoDate(merged.endDate)) {
    return 'endDate must match YYYY-MM-DD';
  }
  if (merged.startDate !== undefined && merged.endDate !== undefined && merged.endDate < merged.startDate) {
    return 'endDate must be on or after startDate';
  }
  return null;
}
