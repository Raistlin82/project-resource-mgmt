import {
  scoreCandidate,
  rankCandidates,
  requestSkillGap,
  missingSkillsFor,
  MATCH_WEIGHTS,
  MAX_PROFICIENCY_LEVEL,
} from './match.util';
import { Resource, ResourceRequest } from './api.service';

function res(id: string, overrides: Partial<Resource> = {}): Resource {
  return {
    id,
    name: `R${id}`,
    role: 'Developer',
    skills: [],
    projectRoles: [],
    externalExperience: [],
    utilization: 0,
    capacity: 40,
    ...overrides,
  };
}

function req(overrides: Partial<ResourceRequest> = {}): ResourceRequest {
  return {
    id: 'req1',
    name: 'Request 1',
    requiredRole: 'Developer',
    requiredEffort: 100,
    status: 'Open',
    skills: [],
    ...overrides,
  };
}

const TOTAL_WEIGHT = 100;

describe('match.util scoreCandidate', () => {
  it('weights sum to 100', () => {
    const sum =
      MATCH_WEIGHTS.skillCoverage +
      MATCH_WEIGHTS.proficiency +
      MATCH_WEIGHTS.roleFit +
      MATCH_WEIGHTS.availability +
      MATCH_WEIGHTS.marginFit;
    expect(sum).toBe(TOTAL_WEIGHT);
  });

  it('scores a perfect match at 100 (full skills at max level, exact role, idle, healthy margin)', () => {
    const resource = res('1', {
      role: 'Developer',
      skills: [
        { name: 'TypeScript', level: MAX_PROFICIENCY_LEVEL },
        { name: 'Angular', level: MAX_PROFICIENCY_LEVEL },
      ],
      utilization: 0,
      costRate: 0, // (bill - cost) / bill = 1 -> full marginFit
      billRate: 100,
    });
    const request = req({ requiredRole: 'Developer', skills: ['TypeScript', 'Angular'] });

    const r = scoreCandidate(resource, request);

    expect(r.resourceId).toBe('1');
    expect(r.score).toBe(100);
    expect(r.missingSkills).toEqual([]);
    expect(r.breakdown).toEqual({
      skillCoverage: MATCH_WEIGHTS.skillCoverage,
      proficiency: MATCH_WEIGHTS.proficiency,
      roleFit: MATCH_WEIGHTS.roleFit,
      availability: MATCH_WEIGHTS.availability,
      marginFit: MATCH_WEIGHTS.marginFit,
    });
  });

  it('breakdown values always sum to the total score', () => {
    const resource = res('1', {
      role: 'Architect',
      projectRoles: ['Developer'],
      skills: [{ name: 'TypeScript', level: 3 }],
      utilization: 40,
      costRate: 60,
      billRate: 120,
    });
    const request = req({ requiredRole: 'Developer', skills: ['TypeScript', 'Go'] });

    const r = scoreCandidate(resource, request);
    const b = r.breakdown;
    const sum = b.skillCoverage + b.proficiency + b.roleFit + b.availability + b.marginFit;
    expect(Math.round(sum * 100) / 100).toBe(r.score);
  });

  it('partial match: half the skills, half proficiency, projectRole-only role credit', () => {
    const resource = res('2', {
      role: 'QA Engineer',
      projectRoles: ['Developer'], // not the primary role -> partial role credit (0.6 default)
      skills: [{ name: 'TypeScript', level: MAX_PROFICIENCY_LEVEL }], // matched at max level
      utilization: 0,
      // no rates -> marginFit 0
    });
    const request = req({ requiredRole: 'Developer', skills: ['TypeScript', 'Angular'] });

    const r = scoreCandidate(resource, request);

    // 1 of 2 skills -> 50% coverage = 20
    expect(r.breakdown.skillCoverage).toBeCloseTo(MATCH_WEIGHTS.skillCoverage * 0.5, 5);
    // matched skill is at max level -> full proficiency on the matched set = 15
    expect(r.breakdown.proficiency).toBeCloseTo(MATCH_WEIGHTS.proficiency, 5);
    // projectRole match -> 0.6 * 15 = 9
    expect(r.breakdown.roleFit).toBeCloseTo(MATCH_WEIGHTS.roleFit * 0.6, 5);
    // idle -> full availability = 20
    expect(r.breakdown.availability).toBeCloseTo(MATCH_WEIGHTS.availability, 5);
    // no rates -> 0 margin
    expect(r.breakdown.marginFit).toBe(0);
    expect(r.missingSkills).toEqual(['Angular']);
  });

  it('reports missing skills (case-insensitive match, request casing preserved)', () => {
    const resource = res('3', {
      skills: [{ name: 'typescript', level: 4 }], // lowercase still matches "TypeScript"
    });
    const request = req({ skills: ['TypeScript', 'Kubernetes', 'AWS'] });

    const r = scoreCandidate(resource, request);
    expect(r.missingSkills).toEqual(['Kubernetes', 'AWS']);
    expect(missingSkillsFor(resource, request)).toEqual(['Kubernetes', 'AWS']);
    // 1 of 3 skills covered (breakdown is rounded to 2 decimals -> tolerate 2dp)
    expect(r.breakdown.skillCoverage).toBeCloseTo(MATCH_WEIGHTS.skillCoverage / 3, 2);
  });

  it('an overbooked candidate gets zero availability and is clamped (never negative)', () => {
    const resource = res('4', {
      role: 'Developer',
      skills: [{ name: 'TypeScript', level: MAX_PROFICIENCY_LEVEL }],
      utilization: 130, // > 100 -> clamp -> 0 headroom
      costRate: 50,
      billRate: 100,
    });
    const request = req({ requiredRole: 'Developer', skills: ['TypeScript'] });

    const r = scoreCandidate(resource, request);
    expect(r.breakdown.availability).toBe(0);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('availability scales linearly with headroom (75% utilized -> quarter of the weight)', () => {
    const resource = res('5', { utilization: 75 });
    const request = req({ requiredRole: '', skills: [] });
    const r = scoreCandidate(resource, request);
    expect(r.breakdown.availability).toBeCloseTo(MATCH_WEIGHTS.availability * 0.25, 5);
  });

  it('proficiency reflects the average level on matched skills only', () => {
    const resource = res('6', {
      role: 'Developer',
      skills: [
        { name: 'A', level: MAX_PROFICIENCY_LEVEL }, // matched, full
        { name: 'B', level: 1 }, // matched, low
        { name: 'C', level: MAX_PROFICIENCY_LEVEL }, // NOT required -> ignored
      ],
    });
    const request = req({ requiredRole: 'Developer', skills: ['A', 'B'] });
    const r = scoreCandidate(resource, request);
    // avg level on matched = (5 + 1) / 2 = 3 -> ratio 3/5 = 0.6
    expect(r.breakdown.proficiency).toBeCloseTo(MATCH_WEIGHTS.proficiency * 0.6, 5);
    // both required skills present -> full coverage
    expect(r.breakdown.skillCoverage).toBe(MATCH_WEIGHTS.skillCoverage);
  });
});

describe('match.util divide-by-zero and edge guards', () => {
  it('a request with no skills awards full coverage + proficiency (nothing to miss)', () => {
    const resource = res('1', { role: 'Developer', utilization: 0, skills: [] });
    const request = req({ requiredRole: 'Developer', skills: [] });
    const r = scoreCandidate(resource, request);
    expect(r.breakdown.skillCoverage).toBe(MATCH_WEIGHTS.skillCoverage);
    expect(r.breakdown.proficiency).toBe(MATCH_WEIGHTS.proficiency);
    expect(r.missingSkills).toEqual([]);
  });

  it('marginFit is 0 when billRate is missing or non-positive (no divide-by-zero)', () => {
    const noBill = scoreCandidate(res('1', { costRate: 50 }), req());
    expect(noBill.breakdown.marginFit).toBe(0);

    const zeroBill = scoreCandidate(res('2', { costRate: 50, billRate: 0 }), req());
    expect(zeroBill.breakdown.marginFit).toBe(0);
  });

  it('negative margin (cost > bill) clamps marginFit to 0, not negative', () => {
    const r = scoreCandidate(res('1', { costRate: 200, billRate: 100 }), req());
    expect(r.breakdown.marginFit).toBe(0);
  });

  it('non-finite utilization is treated as the worst case (0 headroom)', () => {
    const r = scoreCandidate(res('1', { utilization: Number.NaN }), req());
    expect(r.breakdown.availability).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });

  it('blank required role imposes no role constraint (full roleFit)', () => {
    const r = scoreCandidate(res('1', { role: 'Anything' }), req({ requiredRole: '   ' }));
    expect(r.breakdown.roleFit).toBe(MATCH_WEIGHTS.roleFit);
  });

  it('de-duplicates repeated required skills in coverage and missing lists', () => {
    const resource = res('1', { skills: [{ name: 'TypeScript', level: 5 }] });
    const request = req({ skills: ['TypeScript', 'typescript', 'AWS', 'AWS'] });
    const r = scoreCandidate(resource, request);
    // distinct required = {typescript, aws}; 1 of 2 covered
    expect(r.breakdown.skillCoverage).toBeCloseTo(MATCH_WEIGHTS.skillCoverage * 0.5, 5);
    expect(r.missingSkills).toEqual(['AWS']);
  });
});

describe('match.util rankCandidates', () => {
  it('ranks candidates by descending score', () => {
    const request = req({ requiredRole: 'Developer', skills: ['TypeScript', 'Angular'] });

    const perfect = res('perfect', {
      role: 'Developer',
      skills: [
        { name: 'TypeScript', level: 5 },
        { name: 'Angular', level: 5 },
      ],
      utilization: 0,
      costRate: 0,
      billRate: 100,
    });
    const partial = res('partial', {
      role: 'Developer',
      skills: [{ name: 'TypeScript', level: 3 }],
      utilization: 50,
      costRate: 80,
      billRate: 100,
    });
    const weak = res('weak', {
      role: 'Designer',
      skills: [],
      utilization: 95,
    });

    const ranked = rankCandidates([weak, partial, perfect], request);

    expect(ranked.map(c => c.resourceId)).toEqual(['perfect', 'partial', 'weak']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
  });

  it('breaks ties deterministically: fewer missing skills, then resource id ascending', () => {
    const request = req({ requiredRole: 'Developer', skills: ['TypeScript'] });
    // Two identical-scoring idle developers with the same skill -> tie on score & missing.
    const make = (id: string) =>
      res(id, {
        role: 'Developer',
        skills: [{ name: 'TypeScript', level: 3 }],
        utilization: 0,
      });
    const ranked = rankCandidates([make('zeta'), make('alpha'), make('mu')], request);
    expect(ranked.map(c => c.resourceId)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('does not mutate the input array', () => {
    const request = req({ skills: [] });
    const input = [res('b', { utilization: 90 }), res('a', { utilization: 10 })];
    const before = input.map(r => r.id);
    rankCandidates(input, request);
    expect(input.map(r => r.id)).toEqual(before);
  });

  it('returns an empty list for an empty candidate pool', () => {
    expect(rankCandidates([], req())).toEqual([]);
  });
});

describe('match.util requestSkillGap', () => {
  it('returns required skills that NO candidate can cover', () => {
    const request = req({ skills: ['TypeScript', 'Angular', 'Rust', 'Go'] });
    const pool: Resource[] = [
      res('1', { skills: [{ name: 'TypeScript', level: 4 }] }),
      res('2', { skills: [{ name: 'angular', level: 3 }, { name: 'Go', level: 2 }] }),
    ];
    // TypeScript, Angular, Go are covered; Rust is not.
    expect(requestSkillGap(pool, request)).toEqual(['Rust']);
  });

  it('returns no gaps when the pool covers every required skill', () => {
    const request = req({ skills: ['A', 'B'] });
    const pool: Resource[] = [
      res('1', { skills: [{ name: 'A', level: 1 }] }),
      res('2', { skills: [{ name: 'B', level: 1 }] }),
    ];
    expect(requestSkillGap(pool, request)).toEqual([]);
  });

  it('returns every required skill when the pool is empty', () => {
    const request = req({ skills: ['A', 'B'] });
    expect(requestSkillGap([], request)).toEqual(['A', 'B']);
  });

  it('de-duplicates the gap list and preserves request casing/order', () => {
    const request = req({ skills: ['Rust', 'rust', 'Go'] });
    const pool: Resource[] = [res('1', { skills: [{ name: 'Python', level: 1 }] })];
    expect(requestSkillGap(pool, request)).toEqual(['Rust', 'Go']);
  });
});
