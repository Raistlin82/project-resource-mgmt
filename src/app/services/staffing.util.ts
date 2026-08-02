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

/**
 * B3: NOTHING is client-settable — `assignments.status` is derived from the
 * month rows (allocation-month.util `deriveAssignmentStatus`). The lifecycle is
 * driven exclusively by the per-month endpoints. No handler consults this
 * constant any more (POST/PUT /assignments in src/server.ts reject any client
 * `status` outright, via an inline literal check, not this list) — kept
 * exported and empty so the gap-A test suite below, which documents the
 * retired pre-B3 contract, still has something to assert against.
 */
export const ALLOCATION_CLIENT_SETTABLE: readonly AllocationStatus[] = [];

// Gap-A transition table: like ALLOCATION_CLIENT_SETTABLE above, this has no
// server caller since B3 — the client-settable lifecycle it modeled was
// retired along with it. Kept for its own pre-B3 test suite only. The system
// transitions Requested -> Allocated and Requested -> Rejected were always
// applied DIRECTLY by the decision hook, never routed through this guard, so
// they are intentionally absent here.
const ALLOCATION_TRANSITIONS: Readonly<Record<AllocationStatus, readonly AllocationStatus[]>> = {
  Draft: ['Requested'],
  Requested: ['Draft'],
  Allocated: ['Requested'],
  Rejected: ['Requested'],
};

export function isAllowedAllocationTransition(from: AllocationStatus, to: AllocationStatus): boolean {
  if (from === to) return true;
  return ALLOCATION_TRANSITIONS[from].includes(to);
}

/** Build the single approval step for an allocation: the resource's manager (resource-id), fallback role only. */
export function allocationApproverStep(managerId: string | undefined): ApprovalStep {
  return managerId
    ? { role: 'resource-manager', status: 'Pending', approverId: managerId }
    : { role: 'resource-manager', status: 'Pending' };
}

/**
 * @deprecated B3 — superseded by `monthlyAggregateHours` (allocation-month.util),
 * which weighs each day by the status of ITS month. Kept for the gap-A unit
 * tests that document the pre-B3 rollup; no runtime caller remains.
 */
export function assignmentAggregateHours(rows: Pick<Assignment, 'assignedHours' | 'status'>[]): { confirmed: number; planned: number } {
  let confirmed = 0, planned = 0;
  for (const a of rows) {
    const h = Number.isFinite(a.assignedHours) ? a.assignedHours : 0;
    if (a.status === 'Allocated') { confirmed += h; planned += h; }
    else if (a.status === 'Requested') { planned += h; }
  }
  return { confirmed, planned };
}

/** Map an approval decision to the resulting assignment status. */
export function decisionToAssignmentStatus(decision: 'Approved' | 'Rejected'): AllocationStatus {
  return decision === 'Approved' ? 'Allocated' : 'Rejected';
}
