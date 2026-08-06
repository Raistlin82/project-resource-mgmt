/**
 * Candidate faceting for the staffing screen (RPT alignment, manual §3.2.1–§3.2.5).
 *
 * Pure: no I/O, no clock, no Angular. The screen owns the signals and the
 * option lists; this file owns the PREDICATE, so all facets AND together in
 * exactly one place. Two properties follow from that and are the reason the
 * whole composition lives here rather than being spread over the template:
 *
 *  - Every facet is an INTERSECTION. A stray `||` between two of them turns
 *    "Java developers in Engineering" into "anyone with Java plus everyone in
 *    Engineering", which reads plausible on a small pool and is wrong.
 *  - Ranking is untouched. This narrows the SET of candidates; `match.util.ts`
 *    still decides their ORDER (the scoring RPT has no equivalent of). Nothing
 *    here sorts.
 *
 * NOT modelled, deliberately absent, and therefore not implemented here:
 *  - **Professional level** (RPT's "livello professionale"). There is no such
 *    column on `resources`, no catalog for it and no field on `Resource` —
 *    verified across `src/db/schema.ts`, `src/db/seed.ts` and
 *    `api.service.ts`. Seniority appears only INSIDE free text
 *    (`'Dummy — Senior Developer'`) and inside project-role names
 *    (`'Senior Developer'`), which is the JOB ROLE axis RPT filters
 *    separately. A facet over either would be a facet over a naming
 *    convention, so this file offers none.
 *  - **First name / last name as separate facets.** `Resource.name` is a
 *    single column; splitting it on whitespace would make "surname" a lie for
 *    every placeholder row ('Dummy — Associate PMO') and for anyone with a
 *    two-word surname. The free-text `query` already substring-matches the
 *    whole name.
 *  - **Resource code.** Owned by another change adding a readable `code`
 *    column; nothing here invents one.
 */
import type { Resource, ResourceOrganization, Skill } from './api.service';
import { dimensionsOf } from './org-scope.util';
import { kindOf, type ResourceKind } from './resource-kind.util';

/**
 * Every facet value, in the shape the controls hold them.
 *
 * `''` / `null` means "this facet is not filtering" for every field, so
 * "no facet active" is one uniform check and cannot be spelled two ways.
 * Numeric facets are `number | null` (not `''`) because the caller parses the
 * input once, at the edge, instead of every predicate re-parsing a string.
 */
export interface CandidateFacetValues {
  /** Free text over name / role / skill names — the pre-existing search box. */
  query: string;
  capability: string;
  practice: string;
  competence: string;
  managerId: string;
  /** RPT "anagrafica": internal / dummy / subco. */
  kind: '' | ResourceKind;
  /** RPT "società": the vendor a subco belongs to. */
  vendorId: string;
  /** RPT "job role": a project-role name held by the resource. */
  jobRole: string;
  /** RPT "skill matrix": a skill name in the resource's own skill list. */
  skill: string;
  /** Minimum proficiency for `skill`. Meaningless on its own — see `matchesSkillFacet`. */
  minSkillLevel: number | null;
  /** RPT "skill capability": a skill-catalog id; matches via the catalog's member skills. */
  skillCatalogId: string;
  /** RPT "tariffa": inclusive bounds on the EFFECTIVE cost rate in €/DAY (`costRateDay`). */
  costRateDayMin: number | null;
  costRateDayMax: number | null;
}

export const EMPTY_CANDIDATE_FACETS: CandidateFacetValues = {
  query: '',
  capability: '',
  practice: '',
  competence: '',
  managerId: '',
  kind: '',
  vendorId: '',
  jobRole: '',
  skill: '',
  minSkillLevel: null,
  skillCatalogId: '',
  costRateDayMin: null,
  costRateDayMax: null,
};

/**
 * The facets that live behind the collapsed "Advanced filters" disclosure, so
 * the screen can say how many are active WITHOUT the user expanding it. A
 * filter the user cannot see is a filter the user cannot explain, which is the
 * whole risk of grouping 13 controls into a panel.
 */
export const ADVANCED_FACET_KEYS = [
  'kind',
  'vendorId',
  'jobRole',
  'skill',
  'minSkillLevel',
  'skillCatalogId',
  'costRateDayMin',
  'costRateDayMax',
] as const satisfies readonly (keyof CandidateFacetValues)[];

/** How many advanced facets are actually narrowing the list right now. */
export function advancedFacetCount(facets: CandidateFacetValues): number {
  return ADVANCED_FACET_KEYS.filter(key => {
    const value = facets[key];
    return value !== '' && value !== null && value !== undefined;
  }).length;
}

/** True when NO facet at all (advanced or not, text included) is narrowing the list. */
export function hasAnyFacet(facets: CandidateFacetValues): boolean {
  return facets.query.trim() !== ''
    || facets.capability !== '' || facets.practice !== '' || facets.competence !== ''
    || facets.managerId !== ''
    || advancedFacetCount(facets) > 0;
}

/** Catalog rows the predicate needs to resolve an id/name facet against a resource. */
export interface CandidateFilterContext {
  /** The org tree — capability/practice/competence are DERIVED by walking it. */
  orgNodes: readonly ResourceOrganization[];
  /**
   * The `/skills` catalog. Needed only by the skill-capability facet, which
   * maps a catalog to its member skill NAMES (a resource stores skill names,
   * a catalog membership is by id).
   */
  skills: readonly Skill[];
}

/** The free-text box: name / role / skill name, case-insensitive substring. */
export function matchesQuery(resource: Resource, rawQuery: string): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (query === '') return true;
  return (
    resource.name.toLowerCase().includes(query) ||
    resource.role.toLowerCase().includes(query) ||
    resource.skills.some(s => s.name.toLowerCase().includes(query))
  );
}

/**
 * RPT "job role". Matches the resource's job-role LIST and its primary role,
 * because both are drawn from the same `/project-roles` catalog by name (the
 * server keys rate cards off `Resource.role`, `withEffectiveRates`) — filtering
 * only the array would silently miss John Miller, whose primary role is
 * 'Consultant' while his `projectRoles` holds 'Business Consultant'.
 */
export function matchesJobRole(resource: Resource, jobRole: string): boolean {
  if (jobRole === '') return true;
  return resource.role === jobRole || resource.projectRoles.includes(jobRole);
}

/**
 * RPT "skill matrix". `minSkillLevel` qualifies the SAME skill rather than
 * standing on its own: a resource must hold `skill` AT that proficiency or
 * above, never "holds Java" plus "holds something at level 4".
 */
export function matchesSkillFacet(resource: Resource, skill: string, minLevel: number | null): boolean {
  if (skill === '') return true;
  return resource.skills.some(s => s.name === skill && (minLevel === null || s.level >= minLevel));
}

/**
 * RPT "skill capability": the resource holds at least one skill belonging to
 * the given catalog.
 *
 * Membership is read from `Skill.catalogs` — the direction the skills
 * configuration screen actually edits (`manage-skills.component.ts`'s
 * multi-select). `SkillCatalog.skills` mirrors it, but that screen only
 * DISPLAYS a count and never writes it, so the mirror is not consulted here:
 * one source, no second path that can quietly disagree.
 */
export function matchesSkillCatalog(
  resource: Resource,
  catalogId: string,
  skills: readonly Skill[],
): boolean {
  if (catalogId === '') return true;
  const namesInCatalog = new Set(
    skills.filter(s => s.catalogs.includes(catalogId)).map(s => s.name),
  );
  return resource.skills.some(s => namesInCatalog.has(s.name));
}

/**
 * RPT "tariffa", on the effective cost rate in €/DAY (`costRateDay`, resolved
 * server-side as override ?? rate card).
 *
 * A resource whose rate is UNRESOLVED (no override and no matching rate card,
 * so the field is absent) does not match any bound. Treating an unknown rate as
 * "inside the band" would let a band of €0–100/day return a €2000/day
 * contractor, which makes the facet worse than not having it; the honest
 * answer is that the record cannot be shown to satisfy the constraint.
 */
export function matchesRateBand(
  resource: Resource,
  min: number | null,
  max: number | null,
): boolean {
  if (min === null && max === null) return true;
  const rate = resource.costRateDay;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return false;
  if (min !== null && rate < min) return false;
  if (max !== null && rate > max) return false;
  return true;
}

/**
 * One resource against every facet — the AND-composition itself.
 *
 * Cheap predicates first (equality on a scalar), catalog-resolving ones last,
 * so the common "one facet active" case never builds a skill-name set.
 */
export function matchesCandidateFacets(
  resource: Resource,
  facets: CandidateFacetValues,
  ctx: CandidateFilterContext,
): boolean {
  if (facets.kind !== '' && kindOf(resource) !== facets.kind) return false;
  if (facets.vendorId !== '' && resource.vendorId !== facets.vendorId) return false;
  if (facets.managerId !== '' && resource.managerId !== facets.managerId) return false;

  if (facets.capability !== '' || facets.practice !== '' || facets.competence !== '') {
    const dims = dimensionsOf(resource, ctx.orgNodes);
    if (facets.capability !== '' && dims.capability !== facets.capability) return false;
    if (facets.practice !== '' && dims.practice !== facets.practice) return false;
    if (facets.competence !== '' && dims.competence !== facets.competence) return false;
  }

  if (!matchesJobRole(resource, facets.jobRole)) return false;
  if (!matchesSkillFacet(resource, facets.skill, facets.minSkillLevel)) return false;
  if (!matchesRateBand(resource, facets.costRateDayMin, facets.costRateDayMax)) return false;
  if (!matchesSkillCatalog(resource, facets.skillCatalogId, ctx.skills)) return false;
  return matchesQuery(resource, facets.query);
}

/**
 * The filtered candidate set, in the INPUT's order. Order is deliberately
 * preserved rather than sorted: with a request selected, `rankCandidates`
 * (match.util.ts) sorts what comes out of here by fitness score, and a sort in
 * this layer would either fight it or, worse, replace it with something
 * alphabetical.
 */
export function filterCandidates(
  resources: readonly Resource[],
  facets: CandidateFacetValues,
  ctx: CandidateFilterContext,
): Resource[] {
  return resources.filter(r => matchesCandidateFacets(r, facets, ctx));
}
