import type { ResourceRequest } from './api.service';

/** The minimum request shape needed to decide whether staffing can still act. */
export type StaffingDemandRequest = Pick<
  ResourceRequest,
  'status' | 'requiredEffort' | 'staffedEffort'
>;

function finiteNonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Confirmed effort still missing from a request.
 *
 * `staffedEffort` is the confirmed/allocated figure defined by ResourceRequest;
 * pending allocation is intentionally not relabelled as staffed capacity here.
 */
export function residualStaffingEffort(request: StaffingDemandRequest): number {
  return Math.max(
    0,
    finiteNonNegative(request.requiredEffort) - finiteNonNegative(request.staffedEffort),
  );
}

/**
 * One canonical definition of actionable demand for every portfolio surface:
 * the request is published to staffing (`Open` or `Published`) and still has
 * confirmed effort left to cover.
 */
export function isWorkableUncoveredRequest(request: StaffingDemandRequest): boolean {
  const status = request.status.trim().toLowerCase();
  return (status === 'open' || status === 'published')
    && residualStaffingEffort(request) > 0;
}
