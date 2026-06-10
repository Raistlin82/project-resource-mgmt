import { Resource, ResourceRequest } from './api.service';

/**
 * Deterministic resource-match scorer for staffing a ResourceRequest.
 *
 * Given a candidate Resource and a ResourceRequest, produces a 0-100 score plus a
 * per-dimension breakdown. No randomness, no side effects, no `any`. Every dimension
 * is normalised to its own weight, so the breakdown values sum to `score`.
 *
 * WEIGHTS (documented and exported as MATCH_WEIGHTS):
 *   - skillCoverage   ~40  fraction of request.skills that the resource has (by name)
 *   - proficiency     ~15  average proficiency level on the MATCHED skills (level/MAX_LEVEL)
 *   - roleFit         ~15  resource.role / resource.projectRoles vs request.requiredRole
 *   - availability    ~20  headroom = clamp(100 - utilization) as a 0..1 fraction
 *   - marginFit       ~10  (billRate - costRate) / billRate, clamped to 0..1
 * Total = 100.
 *
 * Divide-by-zero is guarded everywhere:
 *   - a request with no skills scores full skillCoverage + proficiency (nothing to miss)
 *   - utilization is clamped to [0, 100] before computing headroom
 *   - marginFit is 0 when billRate is missing/<=0 (cannot compute a meaningful spread)
 */

/** Proficiency levels are modelled on a 1..5 scale; level/MAX_LEVEL gives the 0..1 ratio. */
export const MAX_PROFICIENCY_LEVEL = 5;

/** Per-dimension weights. They sum to 100; each breakdown value is in [0, weight]. */
export const MATCH_WEIGHTS = {
  skillCoverage: 40,
  proficiency: 15,
  roleFit: 15,
  availability: 20,
  marginFit: 10,
} as const;

export type MatchDimension = keyof typeof MATCH_WEIGHTS;

export interface MatchBreakdown {
  /** request.skills the resource covers, as a share of weight (0..40). */
  skillCoverage: number;
  /** Average proficiency on matched skills, as a share of weight (0..15). */
  proficiency: number;
  /** Role alignment (exact role 1.0, projectRole 0.6, none 0), as a share of weight (0..15). */
  roleFit: number;
  /** Utilization headroom, as a share of weight (0..20). */
  availability: number;
  /** Bill-vs-cost margin spread, as a share of weight (0..10). */
  marginFit: number;
}

export interface CandidateScore {
  resourceId: string;
  resource: Resource;
  /** Sum of all breakdown values, rounded to 2 decimals, clamped to [0, 100]. */
  score: number;
  breakdown: MatchBreakdown;
  /** Skills required by the request that this resource does NOT have (original casing from request). */
  missingSkills: string[];
}

/** Optional tuning knobs. roleFit credit for a non-primary projectRole match (default 0.6). */
export interface MatchContext {
  /** 0..1 fraction of roleFit weight granted when the role appears only in projectRoles. Default 0.6. */
  projectRoleCredit?: number;
}

const DEFAULT_PROJECT_ROLE_CREDIT = 0.6;

/** Clamp to [min, max]; returns min for non-finite input so scoring never produces NaN. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Round to 2 decimal places (deterministic, avoids float noise in the output). */
function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/** Case-insensitive, whitespace-trimmed normalisation used for all name/role comparisons. */
function norm(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Skills the resource is missing for this request, preserving the request's original casing.
 * Matching is case-insensitive and trim-insensitive. Duplicate request skills are de-duplicated.
 */
export function missingSkillsFor(resource: Resource, request: ResourceRequest): string[] {
  const have = new Set(resource.skills.map(s => norm(s.name)));
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const required of request.skills) {
    const key = norm(required);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!have.has(key)) missing.push(required);
  }
  return missing;
}

/** Distinct, normalised request skills (drops blank/duplicate entries). */
function distinctRequiredSkills(request: ResourceRequest): string[] {
  const seen = new Set<string>();
  for (const s of request.skills) {
    const key = norm(s);
    if (key) seen.add(key);
  }
  return [...seen];
}

/**
 * Score a single candidate (0-100) against a request with a per-dimension breakdown.
 * Pure and deterministic. See MATCH_WEIGHTS for the weighting rationale.
 */
export function scoreCandidate(
  resource: Resource,
  request: ResourceRequest,
  context: MatchContext = {},
): CandidateScore {
  const projectRoleCredit = clamp(context.projectRoleCredit ?? DEFAULT_PROJECT_ROLE_CREDIT, 0, 1);

  const required = distinctRequiredSkills(request);
  const have = new Map(resource.skills.map(s => [norm(s.name), s.level] as const));

  // --- Skill coverage (~40) + proficiency on matched skills (~15) ---
  // A request with no skills can't be under-covered: award full coverage + proficiency.
  let matchedCount = 0;
  let proficiencySum = 0;
  for (const skill of required) {
    if (have.has(skill)) {
      matchedCount++;
      const level = have.get(skill);
      proficiencySum += clamp(Number.isFinite(level) ? (level as number) : 0, 0, MAX_PROFICIENCY_LEVEL);
    }
  }
  const coverageRatio = required.length === 0 ? 1 : matchedCount / required.length;
  const proficiencyRatio =
    required.length === 0
      ? 1
      : matchedCount === 0
        ? 0
        : proficiencySum / (matchedCount * MAX_PROFICIENCY_LEVEL);

  const skillCoverage = coverageRatio * MATCH_WEIGHTS.skillCoverage;
  const proficiency = proficiencyRatio * MATCH_WEIGHTS.proficiency;

  // --- Role fit (~15): exact role match is full credit; a projectRole match is partial. ---
  const wantedRole = norm(request.requiredRole);
  let roleRatio = 0;
  if (wantedRole) {
    if (norm(resource.role) === wantedRole) {
      roleRatio = 1;
    } else if (resource.projectRoles.some(r => norm(r) === wantedRole)) {
      roleRatio = projectRoleCredit;
    }
  } else {
    // No role required -> no role constraint to satisfy; treat as full fit.
    roleRatio = 1;
  }
  const roleFit = roleRatio * MATCH_WEIGHTS.roleFit;

  // --- Availability (~20): headroom = clamp(100 - utilization) as 0..1. Overbooked -> 0. ---
  // A non-finite utilization is unknown capacity, not idle capacity: treat it as fully booked
  // (worst case) so a garbage value can never inflate the score.
  const utilization = Number.isFinite(resource.utilization)
    ? clamp(resource.utilization, 0, 100)
    : 100;
  const headroomRatio = (100 - utilization) / 100;
  const availability = headroomRatio * MATCH_WEIGHTS.availability;

  // --- Margin fit (~10): (bill - cost) / bill, clamped to 0..1. No billRate -> 0. ---
  const billRate = Number.isFinite(resource.billRate) ? (resource.billRate as number) : 0;
  const costRate = Number.isFinite(resource.costRate) ? (resource.costRate as number) : 0;
  const marginRatio = billRate > 0 ? clamp((billRate - costRate) / billRate, 0, 1) : 0;
  const marginFit = marginRatio * MATCH_WEIGHTS.marginFit;

  const breakdown: MatchBreakdown = {
    skillCoverage: round2(skillCoverage),
    proficiency: round2(proficiency),
    roleFit: round2(roleFit),
    availability: round2(availability),
    marginFit: round2(marginFit),
  };

  const total = clamp(
    skillCoverage + proficiency + roleFit + availability + marginFit,
    0,
    100,
  );

  return {
    resourceId: resource.id,
    resource,
    score: round2(total),
    breakdown,
    missingSkills: missingSkillsFor(resource, request),
  };
}

/**
 * Score and rank candidates for a request, highest score first.
 * Deterministic tie-break: higher score, then fewer missing skills, then resource id ascending,
 * so equal inputs always produce the same ordering.
 */
export function rankCandidates(
  resources: readonly Resource[],
  request: ResourceRequest,
  context: MatchContext = {},
): CandidateScore[] {
  return resources
    .map(r => scoreCandidate(r, request, context))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.missingSkills.length !== b.missingSkills.length) {
        return a.missingSkills.length - b.missingSkills.length;
      }
      return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
    });
}

/**
 * Skills required by the request that NO candidate in the pool can cover.
 * These are true gaps for the request (hire / upskill / subcontract), regardless of ranking.
 * Matching is case-insensitive; the result preserves the request's original casing and order.
 */
export function requestSkillGap(
  resources: readonly Resource[],
  request: ResourceRequest,
): string[] {
  const covered = new Set<string>();
  for (const r of resources) {
    for (const s of r.skills) {
      covered.add(norm(s.name));
    }
  }
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const required of request.skills) {
    const key = norm(required);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!covered.has(key)) gaps.push(required);
  }
  return gaps;
}
