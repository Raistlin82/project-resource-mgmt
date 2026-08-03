/**
 * Pure resource-kind rules (C1).
 *
 * Delivery Control knows three kinds of resource. Two of them represent
 * capacity that does not exist yet — see
 * docs/superpowers/specs/2026-08-02-c1-dummy-subco-multi-fte-design.md:
 *   - 'dummy' — a placeholder for a person not yet identified, preconfigured
 *     by practice, level and day rate;
 *   - 'subco' — an external collaborator, belonging to a vendor.
 * Everything that branches on the kind lives here so the server and the UI
 * cannot drift: the multi-FTE ceiling, the daily hours cap, and whether the
 * resource counts toward the internal capacity KPIs.
 *
 * Side-effect free and SSR-safe.
 */
export type ResourceKind = 'internal' | 'dummy' | 'subco';

export const RESOURCE_KINDS: readonly ResourceKind[] = ['internal', 'dummy', 'subco'];

/**
 * Human-readable label per kind — the one spelling used everywhere a kind is shown
 * to a user (the resource form's kind `<select>`, the resources list's kind filter,
 * and the kind badge), so the three UI surfaces can never spell a kind differently.
 */
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  internal: 'Internal',
  dummy: 'Dummy (placeholder)',
  subco: 'Subcontractor',
};

/**
 * Ceiling of the manual's multi-FTE planning (1,5 · 2 · … · 30 FTE). A code
 * constant, not customizing: it bounds a validation rule, not a preference.
 */
export const MULTI_FTE_MAX = 30;

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Read a resource's kind defensively. A row written before this feature (or a
 * value that somehow escaped validation) reads as 'internal' — the safe
 * default, since it is the STRICTER one: a 1-FTE cap and inclusion in the KPIs.
 */
export function kindOf(resource: { kind?: string } | undefined): ResourceKind {
  const raw = resource?.kind;
  return isResourceKind(raw) ? raw : 'internal';
}

/** True iff this kind may be planned beyond 1 FTE (manual §3.2.3, §3.2.5). */
export function isMultiFteEligible(kind: ResourceKind): boolean {
  return kind !== 'internal';
}

/**
 * The maximum hours/day this kind may carry across ALL its assignments.
 *
 * A non-usable `contractHoursPerDay` (0, NaN, negative) is returned unchanged:
 * the allocation handler already treats those as "no usable cap" and falls back
 * to the configured hours/day, and multiplying a broken value would hide it.
 */
export function dailyCapFor(kind: ResourceKind, contractHoursPerDay: number): number {
  if (!Number.isFinite(contractHoursPerDay) || contractHoursPerDay <= 0) return contractHoursPerDay;
  return isMultiFteEligible(kind) ? contractHoursPerDay * MULTI_FTE_MAX : contractHoursPerDay;
}

/**
 * True iff this kind is a real person whose saturation is worth measuring.
 * Dummy and subco are excluded from the internal capacity totals and from the
 * semaphore — the manual is explicit that subcontractors "non rientrano nei KPI
 * di allocazione delle risorse interne" (§4.1.2), and a placeholder has no
 * capacity to saturate at all.
 */
export function countsTowardInternalCapacity(kind: ResourceKind): boolean {
  return kind === 'internal';
}

/**
 * True iff this kind is capacity the organisation can actually staff work with.
 *
 * Deliberately NOT the same question as `countsTowardInternalCapacity`, and the
 * two must stay independent rather than be derived from one another:
 *   - `countsTowardInternalCapacity` measures the SATURATION OF EMPLOYEES — it
 *     answers "is this a person whose utilization % means something", which is
 *     why subco is excluded (manual §4.1.2: subcontractors don't count toward
 *     the internal-allocation KPIs).
 *   - `countsTowardDeliveryCapacity` measures what the organisation can actually
 *     DELIVER — a subco is a real, biddable body the org can staff onto work,
 *     so it belongs in supply/bench/over-allocation math even though it is not
 *     "internal". A dummy is neither: it is a placeholder for a person not yet
 *     identified, i.e. a hole to be filled, not capacity that exists today.
 *
 * Net effect: true for 'internal' and 'subco', false for 'dummy'.
 */
export function countsTowardDeliveryCapacity(kind: ResourceKind): boolean {
  return kind !== 'dummy';
}
