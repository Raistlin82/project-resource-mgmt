import { describe, it, expect } from 'vitest';
import {
  ADVANCED_FACET_KEYS,
  EMPTY_CANDIDATE_FACETS,
  advancedFacetCount,
  filterCandidates,
  hasAnyFacet,
  matchesRateBand,
  type CandidateFacetValues,
  type CandidateFilterContext,
} from './candidate-filter.util';
import type { Resource, ResourceOrganization, Skill } from './api.service';

/**
 * ONE fixture that carries, for EVERY facet, at least one row that matches and
 * at least one that does not. That is the whole point: a facet whose fixture
 * has no non-matching row is a facet whose predicate is never exercised, and a
 * `return true` in its place would keep the suite green (the recurring
 * "blind green gate" defect of this project).
 *
 * Org tree: Engineering (capability) > Platform (practice) > Backend (competence),
 * plus Consulting, a capability with no children.
 */
const ORG_NODES: ResourceOrganization[] = [
  { id: 'o1', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
  { id: 'o2', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
  { id: 'o3', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: 'o1' },
  { id: 'o4', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: 'o3' },
];

/** Java + JavaScript belong to catalog 'c1'; Figma belongs to 'c2'. */
const SKILLS: Skill[] = [
  { id: 's1', conceptUri: 'u/1', name: 'Java', description: '', catalogs: ['c1'], proficiencySetId: 'p1', restricted: false },
  { id: 's2', conceptUri: 'u/2', name: 'JavaScript', description: '', catalogs: ['c1'], proficiencySetId: 'p1', restricted: false },
  { id: 's3', conceptUri: 'u/3', name: 'Figma', description: '', catalogs: ['c2'], proficiencySetId: 'p1', restricted: false },
];

const CTX: CandidateFilterContext = { orgNodes: ORG_NODES, skills: SKILLS };

function resource(over: Partial<Resource> & { id: string; name: string }): Resource {
  return {
    role: 'Developer', skills: [], projectRoles: [], externalExperience: [],
    utilization: 0, capacity: 40, kind: 'internal',
    ...over,
  };
}

/** Internal, Engineering>Platform>Backend, Java 3, day rate 600. */
const JULIE = resource({
  id: '1', name: 'Julie Armstrong', role: 'Developer', organization: 'Backend', managerId: 'm1',
  skills: [{ name: 'Java', level: 3 }], projectRoles: ['Senior Developer'], costRateDay: 600,
});
/** Internal, Consulting, no Java, no day rate at all (no override, no card). */
const JOHN = resource({
  id: '2', name: 'John Miller', role: 'Consultant', organization: 'Consulting', managerId: 'm2',
  skills: [{ name: 'Project Management', level: 2 }], projectRoles: ['Business Consultant'],
});
/** Placeholder (dummy): never has a vendor, holds Figma at level 1 only. */
const DUMMY = resource({
  id: '4', name: 'Dummy — UX', role: 'Designer', kind: 'dummy', organization: 'Consulting',
  skills: [{ name: 'Figma', level: 1 }], projectRoles: ['UX Designer'], costRateDay: 300,
});
/** Subcontractor with a vendor, Java at level 1 (below Julie's). */
const SUBCO = resource({
  id: '6', name: 'Subco — Mediolanum Dev', role: 'Developer', kind: 'subco', vendorId: 'V4',
  organization: 'Backend', skills: [{ name: 'Java', level: 1 }], projectRoles: ['Senior Developer'],
  costRateDay: 1200,
});

const POOL: Resource[] = [JULIE, JOHN, DUMMY, SUBCO];

function ids(facets: Partial<CandidateFacetValues>, pool: readonly Resource[] = POOL): string[] {
  return filterCandidates(pool, { ...EMPTY_CANDIDATE_FACETS, ...facets }, CTX).map(r => r.id);
}

describe('filterCandidates — no facet active', () => {
  it('returns the whole pool, in input order', () => {
    expect(ids({})).toStrictEqual(['1', '2', '4', '6']);
  });

  it('preserves input order rather than sorting — the ranking owns order', () => {
    // A sort slipped in here (e.g. by name) would reorder these two.
    expect(ids({}, [SUBCO, JULIE])).toStrictEqual(['6', '1']);
  });
});

describe('anagrafica (kind) facet', () => {
  it('keeps only internals — and the dummy and the subco are ABSENT', () => {
    const kept = ids({ kind: 'internal' });
    expect(kept).toStrictEqual(['1', '2']);
    expect(kept).not.toContain('4');
    expect(kept).not.toContain('6');
  });

  it('keeps only dummies — the two internals and the subco are ABSENT', () => {
    const kept = ids({ kind: 'dummy' });
    expect(kept).toStrictEqual(['4']);
    expect(kept).not.toContain('1');
    expect(kept).not.toContain('6');
  });

  it('keeps only subcontractors — everyone else is ABSENT', () => {
    const kept = ids({ kind: 'subco' });
    expect(kept).toStrictEqual(['6']);
    expect(kept).not.toContain('1');
    expect(kept).not.toContain('4');
  });

  it('treats a row with NO kind field as internal, the same default kindOf() applies everywhere', () => {
    const legacy = resource({ id: '99', name: 'Legacy Row', kind: undefined });
    expect(ids({ kind: 'internal' }, [legacy])).toStrictEqual(['99']);
    expect(ids({ kind: 'subco' }, [legacy])).toStrictEqual([]);
  });
});

describe('società (vendor) facet', () => {
  it('keeps the subco of that vendor and EXCLUDES everyone without a vendor', () => {
    const kept = ids({ vendorId: 'V4' });
    expect(kept).toStrictEqual(['6']);
    // Absence half: a vendor filter must not fall through for rows that have
    // no vendorId at all, which is every internal and every dummy.
    expect(kept).not.toContain('1');
    expect(kept).not.toContain('4');
  });

  it('returns nobody for a vendor no resource belongs to', () => {
    expect(ids({ vendorId: 'V1' })).toStrictEqual([]);
  });
});

describe('job role facet', () => {
  it('matches a role held in the projectRoles LIST', () => {
    const kept = ids({ jobRole: 'Senior Developer' });
    expect(kept).toStrictEqual(['1', '6']);
    expect(kept).not.toContain('2');
  });

  it('matches the PRIMARY role too — both branches are real, both are covered', () => {
    // John's primary role is 'Consultant' while his projectRoles holds
    // 'Business Consultant'. Matching only the array would drop him.
    const kept = ids({ jobRole: 'Consultant' });
    expect(kept).toStrictEqual(['2']);
    expect(kept).not.toContain('1');
  });

  it('returns nobody for a catalog role nobody holds', () => {
    expect(ids({ jobRole: 'Project Manager' })).toStrictEqual([]);
  });
});

describe('skill matrix facet (skill + minimum proficiency)', () => {
  it('keeps holders of the skill and EXCLUDES non-holders', () => {
    const kept = ids({ skill: 'Java' });
    expect(kept).toStrictEqual(['1', '6']);
    expect(kept).not.toContain('2');
    expect(kept).not.toContain('4');
  });

  it('the minimum level narrows further — the level-1 holder becomes ABSENT', () => {
    const kept = ids({ skill: 'Java', minSkillLevel: 3 });
    expect(kept).toStrictEqual(['1']);
    // The load-bearing absence: SUBCO holds Java, but at level 1.
    expect(kept).not.toContain('6');
  });

  it('applies the level to the SELECTED skill, never to some other skill', () => {
    // Julie holds Java at 3 but no Figma at all: asking for Figma >= 1 must not
    // match her merely because she holds SOMETHING at level >= 1.
    const kept = ids({ skill: 'Figma', minSkillLevel: 1 });
    expect(kept).toStrictEqual(['4']);
    expect(kept).not.toContain('1');
  });

  it('a level with no skill selected does not filter on its own', () => {
    expect(ids({ minSkillLevel: 4 })).toStrictEqual(['1', '2', '4', '6']);
  });
});

describe('skill capability (catalog) facet', () => {
  it('keeps resources holding any skill of that catalog and EXCLUDES the rest', () => {
    const kept = ids({ skillCatalogId: 'c1' });   // c1 = Java + JavaScript
    expect(kept).toStrictEqual(['1', '6']);
    expect(kept).not.toContain('2');   // Project Management is in no catalog
    expect(kept).not.toContain('4');   // Figma is in c2
  });

  it('a different catalog selects a different, disjoint set', () => {
    const kept = ids({ skillCatalogId: 'c2' });   // c2 = Figma
    expect(kept).toStrictEqual(['4']);
    expect(kept).not.toContain('1');
  });

  it('returns nobody when the catalog has no member skills', () => {
    expect(ids({ skillCatalogId: 'c-empty' })).toStrictEqual([]);
  });
});

describe('tariffa (cost €/day) facet', () => {
  it('keeps rates inside the band and EXCLUDES the ones outside it', () => {
    const kept = ids({ costRateDayMin: 500, costRateDayMax: 900 });
    expect(kept).toStrictEqual(['1']);          // 600
    expect(kept).not.toContain('4');            // 300, below the floor
    expect(kept).not.toContain('6');            // 1200, above the ceiling
  });

  it('an open-ended floor and an open-ended ceiling each work alone', () => {
    expect(ids({ costRateDayMin: 600 })).toStrictEqual(['1', '6']);
    expect(ids({ costRateDayMax: 600 })).toStrictEqual(['1', '4']);
  });

  it('is inclusive on both bounds', () => {
    expect(matchesRateBand(JULIE, 600, 600)).toBe(true);
  });

  it('EXCLUDES a resource whose rate is unresolved, rather than letting it through', () => {
    // John has neither an override nor a matching rate card, so costRateDay is
    // absent. Treating "unknown" as "inside" would let a €0-100 band return a
    // €2000/day contractor.
    expect(JOHN.costRateDay).toBeUndefined();
    expect(ids({ costRateDayMin: 0 })).not.toContain('2');
    expect(ids({ costRateDayMax: 10_000 })).not.toContain('2');
    // ...and with no band at all he is back, so the exclusion is the BAND's
    // doing and not a row quietly dropped from the pool.
    expect(ids({})).toContain('2');
  });
});

describe('org dimensions and free text still compose', () => {
  it('derives capability by walking up, so a competence attachment still matches', () => {
    const kept = ids({ capability: 'Engineering' });
    expect(kept).toStrictEqual(['1', '6']);   // both sit on Backend
    expect(kept).not.toContain('2');
  });

  it('filters by practice and by competence', () => {
    expect(ids({ practice: 'Platform' })).toStrictEqual(['1', '6']);
    expect(ids({ competence: 'Backend' })).toStrictEqual(['1', '6']);
  });

  it('filters by people manager', () => {
    const kept = ids({ managerId: 'm1' });
    expect(kept).toStrictEqual(['1']);
    expect(kept).not.toContain('2');
  });

  it('free text matches name, role and skill name', () => {
    expect(ids({ query: 'julie' })).toStrictEqual(['1']);
    expect(ids({ query: 'consultant' })).toStrictEqual(['2']);
    expect(ids({ query: 'figma' })).toStrictEqual(['4']);
  });
});

describe('facets AND together', () => {
  it('is the intersection, not the union', () => {
    // kind=subco alone -> ['6']; skill=Java minLevel 3 alone -> ['1'].
    // An OR would return both; the correct AND returns neither.
    expect(ids({ kind: 'subco' })).toStrictEqual(['6']);
    expect(ids({ skill: 'Java', minSkillLevel: 3 })).toStrictEqual(['1']);
    expect(ids({ kind: 'subco', skill: 'Java', minSkillLevel: 3 })).toStrictEqual([]);
  });

  it('narrows monotonically as facets are added', () => {
    expect(ids({ capability: 'Engineering' })).toStrictEqual(['1', '6']);
    expect(ids({ capability: 'Engineering', kind: 'subco' })).toStrictEqual(['6']);
    expect(ids({ capability: 'Engineering', kind: 'subco', costRateDayMax: 900 })).toStrictEqual([]);
  });
});

describe('advancedFacetCount / hasAnyFacet', () => {
  it('counts nothing when no advanced facet is set', () => {
    expect(advancedFacetCount(EMPTY_CANDIDATE_FACETS)).toBe(0);
    // ...including when a NON-advanced facet is set: the badge must not claim
    // a hidden filter that is actually visible above the disclosure.
    expect(advancedFacetCount({ ...EMPTY_CANDIDATE_FACETS, query: 'julie', capability: 'Engineering' })).toBe(0);
  });

  it('counts each active advanced facet exactly once', () => {
    expect(advancedFacetCount({ ...EMPTY_CANDIDATE_FACETS, kind: 'subco' })).toBe(1);
    expect(advancedFacetCount({
      ...EMPTY_CANDIDATE_FACETS, kind: 'subco', vendorId: 'V4', skill: 'Java', minSkillLevel: 3,
    })).toBe(4);
  });

  it('counts a zero rate bound as active — 0 is a real floor, not an empty field', () => {
    expect(advancedFacetCount({ ...EMPTY_CANDIDATE_FACETS, costRateDayMin: 0 })).toBe(1);
  });

  it('covers every advanced facet key, so a new facet cannot be forgotten by the badge', () => {
    expect([...ADVANCED_FACET_KEYS]).toStrictEqual([
      'kind', 'vendorId', 'jobRole', 'skill', 'minSkillLevel', 'skillCatalogId',
      'costRateDayMin', 'costRateDayMax',
    ]);
  });

  it('hasAnyFacet sees the visible facets too, not only the advanced ones', () => {
    expect(hasAnyFacet(EMPTY_CANDIDATE_FACETS)).toBe(false);
    expect(hasAnyFacet({ ...EMPTY_CANDIDATE_FACETS, query: '   ' })).toBe(false);
    expect(hasAnyFacet({ ...EMPTY_CANDIDATE_FACETS, query: 'julie' })).toBe(true);
    expect(hasAnyFacet({ ...EMPTY_CANDIDATE_FACETS, competence: 'Backend' })).toBe(true);
    expect(hasAnyFacet({ ...EMPTY_CANDIDATE_FACETS, kind: 'dummy' })).toBe(true);
  });
});
