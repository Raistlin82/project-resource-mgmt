/**
 * Pure staffing/timesheet decision helpers shared by the mock server's
 * assignment + time-entry handlers (src/server.ts).
 *
 * These functions hold the business rules that were previously inlined in the
 * Express handlers and were the site of two logic bugs:
 *   - request status / staffedEffort recompute on assignment FK retargeting, and
 *   - the time-entry status-transition whitelist (with self-approval guard).
 * Extracting them keeps the rules side-effect-free and unit-testable while the
 * server imports the very same functions it is tested against.
 */
import type { ResourceRequest, TimeEntry, ApprovalStep, Assignment } from './api.service';

/**
 * Utilization percentage contributed by `hours` of work against a resource's
 * `capacity`. Returns 0 when capacity is not a usable divisor (<= 0 / non-finite),
 * mirroring the server's "skip recompute when capacity is unusable" guard, so the
 * caller can always add/subtract the result safely. Not clamped/rounded — the
 * caller applies clampUtil to the resulting absolute utilization.
 */
export function utilizationContribution(hours: number, capacity: number): number {
  if (!Number.isFinite(capacity) || capacity <= 0) return 0;
  const h = Number.isFinite(hours) ? hours : 0;
  return (h / capacity) * 100;
}

/**
 * Derive a resource request's status from a freshly-computed `staffedEffort`.
 *
 * - At/over the required effort the request is 'Fulfilled' (server-derived).
 * - Otherwise, a request that was 'Fulfilled' but has dropped back below the
 *   requirement reverts to 'Open'.
 * - Any other (client-controlled) status is preserved unchanged.
 *
 * 'Fulfilled' is never client-settable, so it is only ever produced here.
 */
export function requestStatusFor(request: Pick<ResourceRequest, 'status' | 'requiredEffort'>, staffedEffort: number): ResourceRequest['status'] {
  if (staffedEffort >= request.requiredEffort) return 'Fulfilled';
  if (request.status === 'Fulfilled') return 'Open';
  return request.status;
}

/**
 * Allowed time-entry status transitions (timesheet lifecycle).
 *
 * Draft <-> Submitted, Submitted -> Approved/Rejected, and Rejected -> Draft
 * (reopen for correction). 'Approved' is terminal from the direct PUT path —
 * reverting an approved entry is reserved for the dedicated approval engine.
 */
export const TIME_ENTRY_TRANSITIONS: Readonly<Record<TimeEntry['status'], readonly TimeEntry['status'][]>> = {
  Draft: ['Submitted'],
  Submitted: ['Draft', 'Approved', 'Rejected'],
  Rejected: ['Draft'],
  Approved: [],
};

/**
 * True iff a time entry may move from `from` to `to`. A no-op transition
 * (`from === to`) is always allowed so non-status edits never trip the guard.
 */
export function isAllowedTimeEntryTransition(from: TimeEntry['status'], to: TimeEntry['status']): boolean {
  if (from === to) return true;
  return TIME_ENTRY_TRANSITIONS[from].includes(to);
}

export type AllocationStatus = Assignment['status'];

// B3 REMOVALS. `ALLOCATION_CLIENT_SETTABLE`, `isAllowedAllocationTransition`
// (with its ALLOCATION_TRANSITIONS table) and `assignmentAggregateHours` lived
// here until B3 made `assignments.status` a DERIVED rollup of the month rows.
// They had no runtime caller left, and their specs asserted a contract the
// server no longer implements — a client-settable assignment lifecycle and an
// assignment-level hour rollup — so they were deleted rather than left as
// documentation of a retired design. Their replacements all live in
// allocation-month.util: `deriveAssignmentStatus` and `monthlyAggregateHours`.

/**
 * Build the single approval step for an allocation: the resource's manager
 * (resource-id), fallback role only.
 *
 * `approverId` is pinned from the ORG-CHART axis alone (`Resource.managerId`) and
 * that is DELIBERATE — do not "complete" it by also pinning a node manager. A
 * step carries ONE `approverId`, while the org tree can put several managers above
 * a resource (competence, practice, capability), so any pin would have to pick a
 * winner and would silently exclude the others. The org-tree axis is honoured
 * where it belongs: in `decideOneApproval`, which admits any ACCOUNTABLE manager
 * of the target on its own merits (design spec §3.4 rule 2). The pin is therefore
 * a routing hint for the common case, not the boundary.
 */
export function allocationApproverStep(managerId: string | undefined): ApprovalStep {
  return managerId
    ? { role: 'resource-manager', status: 'Pending', approverId: managerId }
    : { role: 'resource-manager', status: 'Pending' };
}

/** Map an approval decision to the resulting assignment status. */
export function decisionToAssignmentStatus(decision: 'Approved' | 'Rejected'): AllocationStatus {
  return decision === 'Approved' ? 'Allocated' : 'Rejected';
}
