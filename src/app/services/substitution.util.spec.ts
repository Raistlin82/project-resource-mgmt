import { planGiveBack, planSubstitution } from './substitution.util';

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

describe('planGiveBack', () => {
  // A dummy's ceiling is multi-FTE (30x its 8h base). Wide enough never to bind
  // except in the clamp cases below, which pass a deliberately small cap.
  const DUMMY_CAP = 240;
  const D1 = '2026-04-07';
  const D2 = '2026-04-08';

  describe('rejection', () => {
    it('gives back exactly what each day moved and empties those days', () => {
      const plan = planGiveBack({ [D1]: 8 }, { [D1]: 8 }, 'Rejected', { [D1]: 8 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 8 });
      expect(plan.targetHours).toEqual({ [D1]: 0 }); // 0 == delete the row
      expect(plan.giveBackHours).toBe(8);
      expect(plan.shortfallHours).toBe(0);
    });

    it('NEVER touches a day the substitution did not move (regression: proportional split)', () => {
      // The shape that the proportional-split implementation corrupted: she already
      // had 8h of her OWN work on D1 (so the transfer moved nothing there, she was
      // at her cap) and the substitution moved 8h onto D2. A budget spread across
      // what she HOLDS would have taken 4h of her own D1 work and booked it onto a
      // dummy day that never gave up an hour.
      const plan = planGiveBack({ [D2]: 8 }, { [D1]: 8, [D2]: 8 }, 'Rejected', { [D1]: 8 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D2]: 8 });
      expect(plan.targetHours).toEqual({ [D2]: 0 });
      expect(plan.giveBack[D1]).toBeUndefined();
      expect(plan.targetHours[D1]).toBeUndefined();
      expect(plan.giveBackHours).toBe(8);
    });

    it('leaves her own hours on a day the substitution only PARTLY filled', () => {
      // She held 3h of her own on D1 and could absorb 5 more, so the transfer moved
      // 5: the rejection returns those 5 and leaves her the 3 that were always hers.
      const plan = planGiveBack({ [D1]: 5 }, { [D1]: 8 }, 'Rejected', { [D1]: 3 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 5 });
      expect(plan.targetHours).toEqual({ [D1]: 3 });
    });

    it('makes the dummy whole even when the approver trimmed before rejecting', () => {
      // 8h moved, trimmed to 5, then rejected: the dummy gets its 8 back (they were
      // its hours, and a rejection undoes the substitution wholesale) and her row goes.
      const plan = planGiveBack({ [D1]: 8 }, { [D1]: 5 }, 'Rejected', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 8 });
      expect(plan.targetHours).toEqual({ [D1]: 0 });
    });

    it('returns every day of a multi-day transfer independently', () => {
      const plan = planGiveBack({ [D1]: 4, [D2]: 6 }, { [D1]: 4, [D2]: 9 }, 'Rejected', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 4, [D2]: 6 });
      expect(plan.targetHours).toEqual({ [D1]: 0, [D2]: 3 });
      expect(plan.giveBackHours).toBe(10);
    });
  });

  describe('approval', () => {
    it('gives back only what the approver trimmed and leaves her the remainder', () => {
      const plan = planGiveBack({ [D1]: 8 }, { [D1]: 5 }, 'Approved', { [D1]: 8 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 3 });
      expect(plan.targetHours).toEqual({}); // her rows are the approved allocation
      expect(plan.giveBackHours).toBe(3);
    });

    it('gives back the WHOLE transfer when the month was zeroed before approval', () => {
      // Zero-then-approve is how the source tool expresses a refusal. Nothing may
      // vanish: she holds nothing, so the whole map goes back to the days it came from.
      const plan = planGiveBack({ [D1]: 8, [D2]: 4 }, {}, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 8, [D2]: 4 });
      expect(plan.giveBackHours).toBe(12);
      expect(plan.targetHours).toEqual({});
    });

    it('gives back nothing when the approver left every hour in place', () => {
      const plan = planGiveBack({ [D1]: 8 }, { [D1]: 8 }, 'Approved', { [D1]: 8 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({});
      expect(plan.giveBackHours).toBe(0);
    });

    it('gives back nothing on a day the approver ADDED hours to', () => {
      // The extra is a NEW allocation, not part of the substitution.
      const plan = planGiveBack({ [D1]: 8 }, { [D1]: 12 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({});
      expect(plan.giveBackHours).toBe(0);
    });

    it('is decided PER DAY: a trimmed day returns while an inflated day does not', () => {
      const plan = planGiveBack({ [D1]: 8, [D2]: 8 }, { [D1]: 12, [D2]: 3 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D2]: 5 });
      expect(plan.giveBackHours).toBe(5);
    });
  });

  describe('the dummy-s own ceiling', () => {
    it('never pushes a day past the dummy-s daily cap, and reports the shortfall', () => {
      // Cap 8, the dummy already holds 6 that day: only 2 of the 4 fit.
      const plan = planGiveBack({ [D1]: 4 }, { [D1]: 4 }, 'Rejected', { [D1]: 6 }, 8);
      expect(plan.giveBack).toEqual({ [D1]: 2 });
      expect(plan.shortfallHours).toBe(2);
      // Conservation: she loses exactly the 2 that landed, not the 4 that were asked.
      expect(plan.targetHours).toEqual({ [D1]: 2 });
    });

    it('gives back nothing on a day the dummy is already at its cap', () => {
      const plan = planGiveBack({ [D1]: 4 }, { [D1]: 4 }, 'Rejected', { [D1]: 8 }, 8);
      expect(plan.giveBack).toEqual({});
      expect(plan.targetHours).toEqual({}); // untouched: nothing was returned
      expect(plan.shortfallHours).toBe(4);
    });

    it('hands everything back when the cap is not usable (inverse of planSubstitution)', () => {
      // 0 / NaN / negative: refusing here would DESTROY booked demand rather than
      // decline to create it.
      for (const cap of [0, Number.NaN, -8]) {
        const plan = planGiveBack({ [D1]: 8 }, { [D1]: 8 }, 'Rejected', {}, cap);
        expect(plan.giveBack).toEqual({ [D1]: 8 });
        expect(plan.shortfallHours).toBe(0);
      }
    });
  });

  it('ignores non-finite or non-positive entries rather than poisoning the totals', () => {
    const plan = planGiveBack(
      { [D1]: Number.NaN, [D2]: 8, '2026-04-09': 0 },
      { [D2]: Number.NaN },
      'Rejected', {}, DUMMY_CAP);
    expect(plan.giveBack).toEqual({ [D2]: 8 });
    expect(plan.targetHours).toEqual({ [D2]: 0 });
    expect(plan.giveBackHours).toBe(8);
  });

  it('handles an empty map (a month with no substitution left to undo)', () => {
    expect(planGiveBack({}, { [D1]: 8 }, 'Rejected', {}, DUMMY_CAP))
      .toEqual({ giveBack: {}, targetHours: {}, giveBackHours: 0, shortfallHours: 0 });
  });

  it('keeps two decimals exact — the per-day figures never drift', () => {
    const plan = planGiveBack({ [D1]: 2.67, [D2]: 5.33 }, {}, 'Approved', {}, DUMMY_CAP);
    expect(plan.giveBack).toEqual({ [D1]: 2.67, [D2]: 5.33 });
    expect(plan.giveBackHours).toBe(8);
  });
});
