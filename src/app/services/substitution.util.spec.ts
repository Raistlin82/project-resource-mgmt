import { planSubstitution } from './substitution.util';

describe('planSubstitution', () => {
  it('transfers everything when the target is free', () => {
    const plan = planSubstitution({ '2026-09-01': 8, '2026-09-02': 8 }, {}, 8);
    expect(plan.transfer).toEqual({ '2026-09-01': 8, '2026-09-02': 8 });
    expect(plan.remaining).toEqual({});
    expect(plan.transferredHours).toBe(16);
    expect(plan.remainingHours).toBe(0);
  });

  it('caps each day at the target-s remaining capacity and leaves the rest', () => {
    // A 2.5-FTE dummy day (20h) against an 8h person who is free: 8 move, 12 stay.
    const plan = planSubstitution({ '2026-09-01': 20 }, {}, 8);
    expect(plan.transfer).toEqual({ '2026-09-01': 8 });
    expect(plan.remaining).toEqual({ '2026-09-01': 12 });
    expect(plan.transferredHours).toBe(8);
    expect(plan.remainingHours).toBe(12);
  });

  it('accounts for what the target has already booked that day', () => {
    const plan = planSubstitution({ '2026-09-01': 8 }, { '2026-09-01': 6 }, 8);
    expect(plan.transfer).toEqual({ '2026-09-01': 2 });
    expect(plan.remaining).toEqual({ '2026-09-01': 6 });
  });

  it('transfers nothing on a day the target is already full', () => {
    const plan = planSubstitution({ '2026-09-01': 8 }, { '2026-09-01': 8 }, 8);
    expect(plan.transfer).toEqual({});
    expect(plan.remaining).toEqual({ '2026-09-01': 8 });
    expect(plan.transferredHours).toBe(0);
  });

  it('treats an over-booked target as having no room, never negative room', () => {
    const plan = planSubstitution({ '2026-09-01': 4 }, { '2026-09-01': 12 }, 8);
    expect(plan.transfer).toEqual({});
    expect(plan.remaining).toEqual({ '2026-09-01': 4 });
  });

  it('handles an empty dummy month', () => {
    expect(planSubstitution({}, { '2026-09-01': 4 }, 8)).toEqual({
      transfer: {}, remaining: {}, transferredHours: 0, remainingHours: 0,
    });
  });

  it('ignores non-finite hours rather than poisoning the totals', () => {
    const plan = planSubstitution({ '2026-09-01': Number.NaN, '2026-09-02': 8 }, {}, 8);
    expect(plan.transfer).toEqual({ '2026-09-02': 8 });
    expect(plan.transferredHours).toBe(8);
  });

  it('transfers nothing when the cap is not usable', () => {
    // 0 / NaN / negative all mean "no usable cap" elsewhere in the codebase.
    expect(planSubstitution({ '2026-09-01': 8 }, {}, 0).transfer).toEqual({});
    expect(planSubstitution({ '2026-09-01': 8 }, {}, Number.NaN).transfer).toEqual({});
    expect(planSubstitution({ '2026-09-01': 8 }, {}, -8).transfer).toEqual({});
  });

  it('rounds to two decimals so repeated splits do not drift', () => {
    const plan = planSubstitution({ '2026-09-01': 10 }, { '2026-09-01': 2.005 }, 8);
    expect(plan.transfer['2026-09-01']).toBe(6);
    expect(plan.remaining['2026-09-01']).toBe(4);
  });
});
