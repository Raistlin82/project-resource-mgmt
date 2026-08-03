import {
  MULTI_FTE_MAX,
  RESOURCE_KINDS,
  countsTowardDeliveryCapacity,
  countsTowardInternalCapacity,
  dailyCapFor,
  isMultiFteEligible,
  isResourceKind,
  kindOf,
} from './resource-kind.util';

describe('RESOURCE_KINDS / isResourceKind', () => {
  it('lists exactly the three kinds', () => {
    expect([...RESOURCE_KINDS]).toEqual(['internal', 'dummy', 'subco']);
  });

  it('accepts only the three kinds', () => {
    expect(isResourceKind('internal')).toBe(true);
    expect(isResourceKind('dummy')).toBe(true);
    expect(isResourceKind('subco')).toBe(true);
    expect(isResourceKind('Internal')).toBe(false);
    expect(isResourceKind('')).toBe(false);
    expect(isResourceKind(undefined)).toBe(false);
    expect(isResourceKind(2)).toBe(false);
  });
});

describe('kindOf', () => {
  it('reads the stored kind', () => {
    expect(kindOf({ kind: 'subco' })).toBe('subco');
  });

  it('falls back to internal for an absent, empty or unknown kind', () => {
    expect(kindOf({})).toBe('internal');
    expect(kindOf(undefined)).toBe('internal');
    expect(kindOf({ kind: 'contractor' })).toBe('internal');
  });
});

describe('isMultiFteEligible', () => {
  it('is true only for dummy and subco', () => {
    expect(isMultiFteEligible('dummy')).toBe(true);
    expect(isMultiFteEligible('subco')).toBe(true);
    expect(isMultiFteEligible('internal')).toBe(false);
  });
});

describe('dailyCapFor', () => {
  it('caps an internal resource at its contracted hours', () => {
    expect(dailyCapFor('internal', 8)).toBe(8);
    expect(dailyCapFor('internal', 4)).toBe(4);
  });

  it('widens the cap to MULTI_FTE_MAX times for dummy and subco', () => {
    expect(dailyCapFor('dummy', 8)).toBe(8 * MULTI_FTE_MAX);
    expect(dailyCapFor('subco', 4)).toBe(4 * MULTI_FTE_MAX);
  });

  it('returns a non-usable cap unchanged so the caller keeps its own fallback', () => {
    // The allocation handler treats 0/NaN/negative as "no usable cap" and falls
    // back to settings.hoursPerDay; multiplying those would hide the problem.
    expect(dailyCapFor('dummy', 0)).toBe(0);
    expect(dailyCapFor('dummy', Number.NaN)).toBeNaN();
    expect(dailyCapFor('dummy', -3)).toBe(-3);
  });
});

describe('countsTowardInternalCapacity', () => {
  it('is true only for internal resources', () => {
    expect(countsTowardInternalCapacity('internal')).toBe(true);
    expect(countsTowardInternalCapacity('dummy')).toBe(false);
    expect(countsTowardInternalCapacity('subco')).toBe(false);
  });
});

describe('countsTowardDeliveryCapacity', () => {
  it('is true for internal and subco, false for dummy', () => {
    expect(countsTowardDeliveryCapacity('internal')).toBe(true);
    expect(countsTowardDeliveryCapacity('subco')).toBe(true);
    expect(countsTowardDeliveryCapacity('dummy')).toBe(false);
  });

  it('differs from countsTowardInternalCapacity precisely on subco', () => {
    // The two predicates are independent concepts, not aliases of each other:
    // subco is excluded from internal-capacity KPIs but IS deliverable capacity.
    for (const kind of RESOURCE_KINDS) {
      if (kind === 'subco') {
        expect(countsTowardDeliveryCapacity(kind)).not.toBe(countsTowardInternalCapacity(kind));
      } else {
        expect(countsTowardDeliveryCapacity(kind)).toBe(countsTowardInternalCapacity(kind));
      }
    }
  });
});
