import { planGiveBack, planSubstitution, planSubstitutionBooking } from './substitution.util';

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
      const plan = planGiveBack({ [D1]: 8 }, {}, { [D1]: 8 }, 'Rejected', { [D1]: 8 }, DUMMY_CAP);
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
      const plan = planGiveBack({ [D2]: 8 }, {}, { [D1]: 8, [D2]: 8 }, 'Rejected', { [D1]: 8 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D2]: 8 });
      expect(plan.targetHours).toEqual({ [D2]: 0 });
      expect(plan.giveBack[D1]).toBeUndefined();
      expect(plan.targetHours[D1]).toBeUndefined();
      expect(plan.giveBackHours).toBe(8);
    });

    it('leaves her own hours on a day the substitution only PARTLY filled', () => {
      // She held 3h of her own on D1 (the recorded baseline) and could absorb 5 more,
      // so the transfer moved 5: the rejection returns those 5 and leaves her the 3
      // that were always hers.
      const plan = planGiveBack({ [D1]: 5 }, { [D1]: 3 }, { [D1]: 8 }, 'Rejected', { [D1]: 3 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 5 });
      expect(plan.targetHours).toEqual({ [D1]: 3 });
    });

    it('makes the dummy whole even when the approver trimmed before rejecting', () => {
      // 8h moved, trimmed to 5, then rejected: the dummy gets its 8 back (they were
      // its hours, and a rejection undoes the substitution wholesale) and her row goes.
      const plan = planGiveBack({ [D1]: 8 }, {}, { [D1]: 5 }, 'Rejected', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 8 });
      expect(plan.targetHours).toEqual({ [D1]: 0 });
    });

    it('returns every day of a multi-day transfer independently', () => {
      const plan = planGiveBack({ [D1]: 4, [D2]: 6 }, {}, { [D1]: 4, [D2]: 9 }, 'Rejected', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 4, [D2]: 6 });
      expect(plan.targetHours).toEqual({ [D1]: 0, [D2]: 3 });
      expect(plan.giveBackHours).toBe(10);
    });
  });

  describe('approval', () => {
    it('gives back only what the approver trimmed and leaves her the remainder', () => {
      const plan = planGiveBack({ [D1]: 8 }, {}, { [D1]: 5 }, 'Approved', { [D1]: 8 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 3 });
      expect(plan.targetHours).toEqual({}); // her rows are the approved allocation
      expect(plan.giveBackHours).toBe(3);
    });

    it('gives back the WHOLE transfer when the month was zeroed before approval', () => {
      // Zero-then-approve is how the source tool expresses a refusal. Nothing may
      // vanish: she holds nothing, so the whole map goes back to the days it came from.
      const plan = planGiveBack({ [D1]: 8, [D2]: 4 }, {}, {}, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 8, [D2]: 4 });
      expect(plan.giveBackHours).toBe(12);
      expect(plan.targetHours).toEqual({});
    });

    it('gives back nothing when the approver left every hour in place', () => {
      const plan = planGiveBack({ [D1]: 8 }, {}, { [D1]: 8 }, 'Approved', { [D1]: 8 }, DUMMY_CAP);
      expect(plan.giveBack).toEqual({});
      expect(plan.giveBackHours).toBe(0);
    });

    it('gives back nothing on a day the approver ADDED hours to', () => {
      // The extra is a NEW allocation, not part of the substitution.
      const plan = planGiveBack({ [D1]: 8 }, {}, { [D1]: 12 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({});
      expect(plan.giveBackHours).toBe(0);
    });

    it('is decided PER DAY: a trimmed day returns while an inflated day does not', () => {
      const plan = planGiveBack({ [D1]: 8, [D2]: 8 }, {}, { [D1]: 12, [D2]: 3 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D2]: 5 });
      expect(plan.giveBackHours).toBe(5);
    });
  });

  describe('the dummy-s own ceiling', () => {
    it('never pushes a day past the dummy-s daily cap, and reports the shortfall', () => {
      // Cap 8, the dummy already holds 6 that day: only 2 of the 4 fit.
      const plan = planGiveBack({ [D1]: 4 }, {}, { [D1]: 4 }, 'Rejected', { [D1]: 6 }, 8);
      expect(plan.giveBack).toEqual({ [D1]: 2 });
      expect(plan.shortfallHours).toBe(2);
      // Conservation: she loses exactly the 2 that landed, not the 4 that were asked.
      expect(plan.targetHours).toEqual({ [D1]: 2 });
    });

    it('gives back nothing on a day the dummy is already at its cap', () => {
      const plan = planGiveBack({ [D1]: 4 }, {}, { [D1]: 4 }, 'Rejected', { [D1]: 8 }, 8);
      expect(plan.giveBack).toEqual({});
      expect(plan.targetHours).toEqual({}); // untouched: nothing was returned
      expect(plan.shortfallHours).toBe(4);
    });

    it('hands everything back when the cap is not usable (inverse of planSubstitution)', () => {
      // 0 / NaN / negative: refusing here would DESTROY booked demand rather than
      // decline to create it.
      for (const cap of [0, Number.NaN, -8]) {
        const plan = planGiveBack({ [D1]: 8 }, {}, { [D1]: 8 }, 'Rejected', {}, cap);
        expect(plan.giveBack).toEqual({ [D1]: 8 });
        expect(plan.shortfallHours).toBe(0);
      }
    });
  });

  it('ignores non-finite or non-positive entries rather than poisoning the totals', () => {
    const plan = planGiveBack({ [D1]: Number.NaN, [D2]: 8, '2026-04-09': 0 }, {},
      { [D2]: Number.NaN },
      'Rejected', {}, DUMMY_CAP);
    expect(plan.giveBack).toEqual({ [D2]: 8 });
    expect(plan.targetHours).toEqual({ [D2]: 0 });
    expect(plan.giveBackHours).toBe(8);
  });

  // THE SHAPE THAT DESTROYED BOOKED HOURS. Every case above has a date that is
  // either all loan or all hers; here ONE date carries both, on the same assignment
  // — the `demotedExistingWork` case. `targetHeldByDate` is the TOTAL, so without the
  // recorded baseline the arithmetic charges her own hours against the loan.
  //
  // Fixture throughout: 3h of her own on D1 (the baseline), 5h lent on top (held 8).
  describe('a date mixing her own hours with the loan', () => {
    const BASELINE = { [D1]: 3 };
    const MOVED = { [D1]: 5 };

    it('approval, untrimmed: she kept the whole loan, so nothing goes back', () => {
      const plan = planGiveBack(MOVED, BASELINE, { [D1]: 8 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({});
      expect(plan.giveBackHours).toBe(0);
    });

    it('approval, trimmed to exactly her baseline: the WHOLE loan goes back', () => {
      // Trimming 8 -> 3 removes the loan and nothing else. Charging all 3 held hours
      // against the 5 on loan returned only 2 and destroyed 3h of booked demand.
      const plan = planGiveBack(MOVED, BASELINE, { [D1]: 3 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 5 });
      expect(plan.giveBackHours).toBe(5);
      expect(plan.targetHours).toEqual({}); // an approval never touches her rows
    });

    it('approval, trimmed to 5 (her 3 + 2 of the loan): the other 3 go back', () => {
      const plan = planGiveBack(MOVED, BASELINE, { [D1]: 5 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 3 });
      expect(plan.giveBackHours).toBe(3);
    });

    it('approval, trimmed BELOW her baseline: still only the loan goes back', () => {
      // She cut into her own work too (1h left). That is her allocation to give up,
      // not the placeholder's to reclaim: the dummy gets its 5 and no more.
      const plan = planGiveBack(MOVED, BASELINE, { [D1]: 1 }, 'Approved', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 5 });
    });

    it('rejection after a trim: the dummy is whole and her OWN hours survive', () => {
      // Trimmed 8 -> 5, then rejected. The dummy is made whole with the full map
      // (§5.6), but she may only lose the 2 still on loan — subtracting all 5 deleted
      // the 3h that were always hers.
      const plan = planGiveBack(MOVED, BASELINE, { [D1]: 5 }, 'Rejected', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 5 });
      expect(plan.targetHours).toEqual({ [D1]: 3 });
    });

    it('rejection with the loan already trimmed away: she loses nothing', () => {
      const plan = planGiveBack(MOVED, BASELINE, { [D1]: 3 }, 'Rejected', {}, DUMMY_CAP);
      expect(plan.giveBack).toEqual({ [D1]: 5 });
      expect(plan.targetHours).toEqual({ [D1]: 3 });
    });

    it('rejection clamped by the dummy-s ceiling: she loses only what landed', () => {
      // Cap 8, the dummy already holds 6 that day: 2 of the 5 fit, 3 short. She gives
      // up those 2 (still on loan, held 8 - baseline 3 = 5 remaining) and keeps 6.
      const plan = planGiveBack(MOVED, BASELINE, { [D1]: 8 }, 'Rejected', { [D1]: 6 }, 8);
      expect(plan.giveBack).toEqual({ [D1]: 2 });
      expect(plan.shortfallHours).toBe(3);
      expect(plan.targetHours).toEqual({ [D1]: 6 });
    });

    it('an absent baseline map degrades to "all of it was on loan"', () => {
      // A link written before the baseline column existed. Identical to the old
      // behaviour — the only reading available without the record.
      expect(planGiveBack(MOVED, {}, { [D1]: 3 }, 'Approved', {}, DUMMY_CAP).giveBack)
        .toEqual({ [D1]: 2 });
    });
  });

  it('handles an empty map (a month with no substitution left to undo)', () => {
    expect(planGiveBack({}, {}, { [D1]: 8 }, 'Rejected', {}, DUMMY_CAP))
      .toEqual({ giveBack: {}, targetHours: {}, giveBackHours: 0, shortfallHours: 0 });
  });

  it('keeps two decimals exact — the per-day figures never drift', () => {
    const plan = planGiveBack({ [D1]: 2.67, [D2]: 5.33 }, {}, {}, 'Approved', {}, DUMMY_CAP);
    expect(plan.giveBack).toEqual({ [D1]: 2.67, [D2]: 5.33 });
    expect(plan.giveBackHours).toBe(8);
  });
});

describe('planSubstitutionBooking', () => {
  // April 2026 has 22 working days; at 8h/day that is a 176h month.
  const APRIL = 176;
  const MAY = 168; // 21 working days

  it('bounds the booking by the substituted month, not by the request', () => {
    const booking = planSubstitutionBooking({ '2026-04': 8 }, { '2026-04': APRIL });
    expect(booking?.startDate).toBe('2026-04-01');
    expect(booking?.endDate).toBe('2026-04-30');
  });

  it('derives the pct from the transferred hours, NOT the 100% default', () => {
    // The regression: 40h in one month used to read as a full-time booking spanning
    // the whole request, so `sweepResource` flagged it and her real booking as
    // conflicting for every month of that request.
    const booking = planSubstitutionBooking({ '2026-04': 40 }, { '2026-04': APRIL });
    expect(booking?.allocationPct).toBe(22.73); // 40 / 176
    expect(booking?.allocationPct).toBeLessThan(100);
  });

  it('reads 100% only when the month really is fully absorbed', () => {
    expect(planSubstitutionBooking({ '2026-04': APRIL }, { '2026-04': APRIL })?.allocationPct).toBe(100);
  });

  it('never exceeds 100% even if the hours somehow do', () => {
    expect(planSubstitutionBooking({ '2026-04': APRIL * 2 }, { '2026-04': APRIL })?.allocationPct).toBe(100);
  });

  it('spans every substituted month and averages over the whole window', () => {
    const booking = planSubstitutionBooking(
      { '2026-04': 40, '2026-05': 80 }, { '2026-04': APRIL, '2026-05': MAY });
    expect(booking?.startDate).toBe('2026-04-01');
    expect(booking?.endDate).toBe('2026-05-31');
    // 120h over a 344h window — the pct is ONE constant across the window, so its
    // denominator is the window's capacity, not just the busy month's.
    expect(booking?.allocationPct).toBe(34.88);
  });

  it('gets the last day right for a short month', () => {
    expect(planSubstitutionBooking({ '2026-02': 8 }, { '2026-02': 160 })?.endDate).toBe('2026-02-28');
  });

  it('ignores months that transferred nothing when placing the window', () => {
    const booking = planSubstitutionBooking(
      { '2026-04': 0, '2026-05': 8, '2026-06': Number.NaN }, { '2026-05': MAY });
    expect(booking?.startDate).toBe('2026-05-01');
    expect(booking?.endDate).toBe('2026-05-31');
  });

  it('describes no booking at all when nothing was transferred', () => {
    expect(planSubstitutionBooking({}, { '2026-04': APRIL })).toBeUndefined();
    expect(planSubstitutionBooking({ '2026-04': 0 }, { '2026-04': APRIL })).toBeUndefined();
  });

  it('falls back to the conservative 100% when the window has no measurable capacity', () => {
    // Same default `schedule.util` applies to a missing pct: a capacity we cannot
    // measure must not silently hide an over-allocation.
    expect(planSubstitutionBooking({ '2026-04': 8 }, {})?.allocationPct).toBe(100);
    expect(planSubstitutionBooking({ '2026-04': 8 }, { '2026-04': 0 })?.allocationPct).toBe(100);
  });
});
