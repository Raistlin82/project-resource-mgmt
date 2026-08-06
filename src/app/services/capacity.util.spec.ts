import {
  employedWorkingDays,
  standardMonthlyHours, fteOf, semaphoreBand, monthsInRange, isActiveInMonth, rollupMonthly,
  hoursByResourceMonth,
} from './capacity.util';
import { workingDaysInMonth } from './calendar.util';

const NO_HOL = new Set<string>();

describe('fteOf', () => {
  it('divides by standard hours', () => expect(fteOf(88, 176)).toBeCloseTo(0.5));
  it('guards zero denominator', () => expect(fteOf(10, 0)).toBe(0));
});

describe('standardMonthlyHours', () => {
  it('aliases monthlyTargetHours = working days × hoursPerDay', () =>
    expect(standardMonthlyHours('2026-05', 8, NO_HOL)).toBe(workingDaysInMonth('2026-05', NO_HOL).length * 8));

  it('passes `holidays` through: one holiday on a working day removes one day of target', () => {
    // The `holidays` argument used to be inert in this whole file — every case
    // passed NO_HOL — so replacing the pass-through with `new Set()` stayed green
    // while every FTE denominator on /capacity and /bench silently ignored public
    // holidays (December 2026 would target 184h instead of 176h, so a person
    // booked the full 176h read 95.65% instead of 100.00%).
    // 2026-05-01 is a Friday, so 2026-05-04 is a MONDAY — a real working day,
    // which is what makes the holiday subtract anything at all.
    const HOL = new Set(['2026-05-04']);
    const noHol = standardMonthlyHours('2026-05', 8, NO_HOL);
    // Derived from the OTHER input, never recomputed from the implementation's formula.
    expect(standardMonthlyHours('2026-05', 8, HOL)).toBe(noHol - 8);
    // ABSENCE TWIN: equality with the no-holiday figure is exactly what a dropped
    // `holidays` argument produces, so that is the outcome to exclude by name.
    expect(standardMonthlyHours('2026-05', 8, HOL)).not.toBe(noHol);
  });

  it('ignores a holiday that falls on a weekend (there is no working day to remove)', () => {
    // The other direction, and the one that keeps the case above from being
    // satisfied by a blanket "subtract 8 per listed holiday": 2026-05-03 is a
    // Sunday, already excluded, so the target must not move at all.
    expect(standardMonthlyHours('2026-05', 8, new Set(['2026-05-03'])))
      .toBe(standardMonthlyHours('2026-05', 8, NO_HOL));
  });
});

describe('semaphoreBand (lower-bound-inclusive: [0,50) idle, [50,85) under, [85,105] healthy, (105,∞) over)', () => {
  it('below 50 → idle', () => expect(semaphoreBand(49.9)).toBe('idle'));
  it('exactly 50 → under', () => expect(semaphoreBand(50)).toBe('under'));
  it('exactly 85 → healthy', () => expect(semaphoreBand(85)).toBe('healthy'));
  it('exactly 105 → healthy', () => expect(semaphoreBand(105)).toBe('healthy'));
  it('just over 105 → over', () => expect(semaphoreBand(105.0001)).toBe('over'));
});

describe('monthsInRange', () => {
  it('inclusive, ascending, crosses year', () => {
    expect(monthsInRange('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01']);
  });
  it('single month', () => expect(monthsInRange('2026-05', '2026-05')).toEqual(['2026-05']));
});

describe('hoursByResourceMonth (extracted so bench.util can reuse the exact same per-cell arithmetic, spec §4)', () => {
  it('splits confirmed vs planned per resource/month, ignoring a day whose month row is missing', () => {
    const out = hoursByResourceMonth({
      assignments: [{ id: 'a1', resourceId: 'r1' }, { id: 'a2', resourceId: 'r1' }],
      assignmentMonths: [{ assignmentId: 'a1', month: '2026-05', status: 'Allocated' }, { assignmentId: 'a2', month: '2026-05', status: 'Requested' }],
      assignmentDays: [
        { assignmentId: 'a1', date: '2026-05-04', hours: 100 },
        { assignmentId: 'a2', date: '2026-05-05', hours: 40 },
        { assignmentId: 'a2', date: '2026-06-01', hours: 999 }, // no 'a2:2026-06' month row -> ignored
      ],
    });
    const cell = out.get('r1')!.get('2026-05')!;
    expect(cell.confirmed).toBe(100);
    expect(cell.planned).toBe(140);
    expect(out.get('r1')!.has('2026-06')).toBe(false);
  });
  it('ignores non-finite hours (NaN would poison the sum)', () => {
    const out = hoursByResourceMonth({
      assignments: [{ id: 'a1', resourceId: 'r1' }],
      assignmentMonths: [{ assignmentId: 'a1', month: '2026-05', status: 'Requested' }],
      assignmentDays: [{ assignmentId: 'a1', date: '2026-05-04', hours: Number.NaN }],
    });
    expect(out.get('r1')?.get('2026-05')?.planned ?? 0).toBe(0);
  });
});

describe('isActiveInMonth (hireDate ≤ monthStart AND (no term OR term ≥ monthStart))', () => {
  it('hired before, not terminated → active', () =>
    expect(isActiveInMonth({ hireDate: '2020-01-01' }, '2026-05')).toBe(true));
  it('hired after month start → inactive', () =>
    expect(isActiveInMonth({ hireDate: '2026-06-15' }, '2026-05')).toBe(false));
  it('terminated before month start → inactive', () =>
    expect(isActiveInMonth({ terminationDate: '2026-04-30' }, '2026-05')).toBe(false));
  it('terminated on/after month start → active', () =>
    expect(isActiveInMonth({ terminationDate: '2026-05-01' }, '2026-05')).toBe(true));
});

describe('rollupMonthly', () => {
  const months = ['2026-05'];
  const hoursPerDay = 8;
  const resources = [
    { id: 'r1', name: 'Full', contractHoursPerDay: 8 },
    { id: 'r2', name: 'Part', contractHoursPerDay: 4 },
  ];
  const assignments = [
    { id: 'a1', resourceId: 'r1' },
    { id: 'a2', resourceId: 'r1' },
    { id: 'a3', resourceId: 'r2' },
  ];
  const assignmentMonths = [
    { assignmentId: 'a1', month: '2026-05', status: 'Allocated' },
    { assignmentId: 'a2', month: '2026-05', status: 'Requested' },
    { assignmentId: 'a3', month: '2026-05', status: 'Allocated' },
  ];
  // a2's 80h is load-bearing: it puts PLANNED and CONFIRMED in DIFFERENT bands.
  // 2026-05 has 21 working days × 8h = 168h standard, so planned 180h = 107.14%
  // ('over') while confirmed 100h = 59.52% ('under'). With the previous 40h both
  // landed in 'under', and the band assertion below could not tell which input the
  // implementation had used.
  const assignmentDays = [
    { assignmentId: 'a1', date: '2026-05-04', hours: 100 },
    { assignmentId: 'a2', date: '2026-05-05', hours: 80 },
    { assignmentId: 'a3', date: '2026-05-04', hours: 84 },
  ];

  const out = rollupMonthly({ resources, assignments, assignmentDays, assignmentMonths, months, hoursPerDay, holidays: NO_HOL });

  it('splits confirmed vs planned per resource/month', () => {
    const r1 = out.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'];
    expect(r1.confirmedHours).toBe(100);
    expect(r1.plannedHours).toBe(180);
  });
  it('bands on PLANNED FTE, not confirmed', () => {
    const r1 = out.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'];
    // LITERAL bands. The previous version derived its expectation with
    // `semaphoreBand((140 / std) * 100)` — the source's own formula over the same
    // input — so `band: semaphoreBand(fteConfirmed * 100)` returned exactly the
    // expected value and this gate could never fail. Planned 180h/168h = 107%
    // ('over'); confirmed 100h/168h = 60% ('under').
    expect(r1.band).toBe('over');
    // ABSENCE TWIN: 'under' is precisely the band a confirmed-derived computation
    // yields for this cell, which is the mis-band that shipped green — a resource
    // at 1.07 planned FTE tinted healthy while the text still read 107%.
    expect(r1.band).not.toBe('under');
    // And the fixture really does discriminate: the confirmed figure bands elsewhere.
    expect(semaphoreBand(r1.fteConfirmed * 100)).toBe('under');
  });
  it('part-time capacity is 0.5 FTE; full is 1.0', () => {
    // Derived from contractHoursPerDay, not from assignmentDays hours, so raising
    // a2 to 80h above does not move either figure.
    expect(out.totals['2026-05'].capacityFte).toBeCloseTo(1.5);
    expect(out.totals['2026-05'].resourceCount).toBe(2);
  });
  it('threads `holidays` into every cell’s targetHours (the FTE denominator)', () => {
    // The SECOND holiday hop. `standardMonthlyHours` could keep its pass-through
    // while `rollupMonthly` built targetByMonth with an empty set, and the
    // standardMonthlyHours assertion above would stay green — so that hop needs its
    // own case. Same fixture, two holiday sets; 2026-05-04 is a Monday.
    const withHol = rollupMonthly({
      resources, assignments, assignmentDays, assignmentMonths, months, hoursPerDay,
      holidays: new Set(['2026-05-04']),
    });
    const noHolTarget = out.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'].targetHours;
    const withHolTarget = withHol.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'].targetHours;
    expect(withHolTarget).toBe(noHolTarget - 8);
    // ABSENCE TWIN: an ignored holiday set produces exactly the no-holiday target.
    expect(withHolTarget).not.toBe(noHolTarget);
  });
  it('idle active resource still appears with a 0% cell', () => {
    const out2 = rollupMonthly({ resources: [{ id: 'r9', name: 'Idle', contractHoursPerDay: 8 }],
      assignments: [], assignmentDays: [], assignmentMonths: [], months, hoursPerDay, holidays: NO_HOL });
    expect(out2.rows[0].monthly['2026-05'].band).toBe('idle');
  });
  it('ignores non-finite hours rows (NaN would poison the sum and mis-band the cell as over)', () => {
    const out3 = rollupMonthly({
      resources: [{ id: 'r9', name: 'Poisoned', contractHoursPerDay: 8 }],
      assignments: [{ id: 'aX', resourceId: 'r9' }],
      assignmentMonths: [{ assignmentId: 'aX', month: '2026-05', status: 'Requested' }],
      assignmentDays: [{ assignmentId: 'aX', date: '2026-05-04', hours: Number.NaN }],
      months, hoursPerDay, holidays: NO_HOL,
    });
    const cell = out3.rows[0].monthly['2026-05'];
    expect(cell.plannedHours).toBe(0);
    expect(Number.isFinite(cell.ftePlanned)).toBe(true);
    expect(cell.band).toBe('idle');
    expect(cell.band).not.toBe('over');
  });
  it('classifies each month by ITS OWN status, not the assignment status', () => {
    const rollup = rollupMonthly({
      resources: [{ id: 'R1', name: 'Ada' }],
      assignments: [{ id: 'A1', resourceId: 'R1' }],
      assignmentMonths: [
        { assignmentId: 'A1', month: '2026-09', status: 'Allocated' },
        { assignmentId: 'A1', month: '2026-10', status: 'Requested' },
      ],
      assignmentDays: [
        { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
        { assignmentId: 'A1', date: '2026-10-01', hours: 8 },
      ],
      months: ['2026-09', '2026-10'],
      hoursPerDay: 8,
      holidays: new Set<string>(),
    });
    const row = rollup.rows[0];
    expect(row.monthly['2026-09'].confirmedHours).toBe(8);
    expect(row.monthly['2026-10'].confirmedHours).toBe(0);
    expect(row.monthly['2026-10'].plannedHours).toBe(8);
  });

  it('keeps dummy and subco out of the internal rows, totals and headcount', () => {
    const rollup = rollupMonthly({
      resources: [
        { id: 'R1', name: 'Ada', kind: 'internal' },
        { id: 'R2', name: 'Dummy SAP', kind: 'dummy' },
        { id: 'R3', name: 'Subco Dev', kind: 'subco' },
      ],
      assignments: [
        { id: 'A1', resourceId: 'R1' },
        { id: 'A2', resourceId: 'R2' },
        { id: 'A3', resourceId: 'R3' },
      ],
      assignmentMonths: [
        { assignmentId: 'A1', month: '2026-09', status: 'Allocated' },
        { assignmentId: 'A2', month: '2026-09', status: 'Allocated' },
        { assignmentId: 'A3', month: '2026-09', status: 'Allocated' },
      ],
      assignmentDays: [
        { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
        { assignmentId: 'A2', date: '2026-09-01', hours: 16 },
        { assignmentId: 'A3', date: '2026-09-01', hours: 8 },
      ],
      months: ['2026-09'],
      hoursPerDay: 8,
      holidays: new Set<string>(),
    });

    expect(rollup.rows.map(r => r.resourceId)).toEqual(['R1']);
    expect(rollup.demandRows.map(r => r.resourceId)).toEqual(['R2', 'R3']);
    // One internal head, so one FTE of capacity — the dummy and the subco add none.
    expect(rollup.totals['2026-09'].resourceCount).toBe(1);
    expect(rollup.totals['2026-09'].capacityFte).toBeCloseTo(1, 5);
  });

  it('reports uncovered demand separately from internal demand', () => {
    const rollup = rollupMonthly({
      resources: [
        { id: 'R1', name: 'Ada', kind: 'internal' },
        { id: 'R2', name: 'Dummy SAP', kind: 'dummy' },
      ],
      assignments: [{ id: 'A1', resourceId: 'R1' }, { id: 'A2', resourceId: 'R2' }],
      assignmentMonths: [
        { assignmentId: 'A1', month: '2026-09', status: 'Allocated' },
        { assignmentId: 'A2', month: '2026-09', status: 'Requested' },
      ],
      assignmentDays: [
        { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
        { assignmentId: 'A2', date: '2026-09-01', hours: 16 },
      ],
      months: ['2026-09'],
      hoursPerDay: 8,
      holidays: new Set<string>(),
    });

    const t = rollup.totals['2026-09'];
    const standard = standardMonthlyHours('2026-09', 8, new Set<string>());
    // The internal figure counts only Ada; the uncovered figure only the dummy,
    // and it follows the same planned (Requested + Allocated) rule.
    expect(t.demandFtePlanned).toBeCloseTo(8 / standard, 5);
    expect(t.demandFteUncovered).toBeCloseTo(16 / standard, 5);
  });

  it('treats a resource with no kind as internal', () => {
    const rollup = rollupMonthly({
      resources: [{ id: 'R1', name: 'Legacy row' }],
      assignments: [{ id: 'A1', resourceId: 'R1' }],
      assignmentMonths: [{ assignmentId: 'A1', month: '2026-09', status: 'Allocated' }],
      assignmentDays: [{ assignmentId: 'A1', date: '2026-09-01', hours: 8 }],
      months: ['2026-09'], hoursPerDay: 8, holidays: new Set<string>(),
    });
    expect(rollup.rows.map(r => r.resourceId)).toEqual(['R1']);
    expect(rollup.demandRows).toEqual([]);
  });
});

/**
 * Employment is enforced by the server ONE DAY AT A TIME
 * (`bookingOutsideEmploymentError`), so measuring it by the month made /capacity
 * disagree with the API at both ends. None of the pre-existing cases in this file
 * placed a hire or termination date INSIDE a month, which is why the defect shipped:
 * the whole suite stayed green when the arithmetic was replaced.
 */
describe('employedWorkingDays / mid-month employment in rollupMonthly', () => {
  const MONTH = '2026-05';
  const ALL_DAYS = workingDaysInMonth(MONTH, NO_HOL);
  const base = {
    assignments: [{ id: 'a1', resourceId: 'joiner' }],
    assignmentMonths: [{ assignmentId: 'a1', month: MONTH, status: 'Allocated' }],
    months: [MONTH],
    hoursPerDay: 8,
    holidays: NO_HOL,
  };

  it('counts only the working days actually employed', () => {
    // 2026-05-18 is a Monday; a hire that day excludes every earlier working day.
    const employed = employedWorkingDays({ hireDate: '2026-05-18' }, MONTH, NO_HOL);
    expect(employed.length).toBeGreaterThan(0);
    expect(employed.length).toBeLessThan(ALL_DAYS.length);
    expect(employed[0]).toBe('2026-05-18');
    expect(employed.every(d => d >= '2026-05-18')).toBe(true);
  });

  it('is the FULL working-day list when employment spans the whole month', () => {
    // ABSENCE TWIN #1: a filter that always narrowed would pass the case above and
    // silently halve the capacity of every ordinary full-month employee.
    expect(employedWorkingDays({}, MONTH, NO_HOL)).toEqual(ALL_DAYS);
    expect(employedWorkingDays({ hireDate: '2020-01-01' }, MONTH, NO_HOL)).toEqual(ALL_DAYS);
    expect(employedWorkingDays({ hireDate: '2020-01-01', terminationDate: '2030-01-01' }, MONTH, NO_HOL)).toEqual(ALL_DAYS);
  });

  it('is empty when the person was employed on no working day of the month', () => {
    expect(employedWorkingDays({ hireDate: '2026-07-01' }, MONTH, NO_HOL)).toEqual([]);
    expect(employedWorkingDays({ terminationDate: '2026-03-31' }, MONTH, NO_HOL)).toEqual([]);
  });

  it('includes the hire and termination days themselves (closed interval)', () => {
    // Off-by-one at either bound is the whole defect class; pin both boundaries.
    expect(employedWorkingDays({ hireDate: '2026-05-18' }, MONTH, NO_HOL)).toContain('2026-05-18');
    expect(employedWorkingDays({ terminationDate: '2026-05-15' }, MONTH, NO_HOL)).toContain('2026-05-15');
  });

  it('KEEPS a mid-month joiner’s row and her already-booked hours', () => {
    // THE JOINER DEFECT: isActiveInMonth compared hireDate with the month START, so
    // rollupMonthly did `continue` and the row vanished — together with hours the
    // server had already accepted. RED before the fix: rows is empty.
    const out = rollupMonthly({
      ...base,
      resources: [{ id: 'joiner', name: 'Mid-month Joiner', contractHoursPerDay: 8, hireDate: '2026-05-18' }],
      assignmentDays: [{ assignmentId: 'a1', date: '2026-05-20', hours: 8 }],
    });
    const row = out.rows.find(r => r.resourceId === 'joiner');
    expect(row, 'a mid-month joiner must still have a row').toBeTruthy();
    expect(row!.monthly[MONTH].confirmedHours).toBe(8);
    expect(out.totals[MONTH].resourceCount).toBe(1);
    expect(out.totals[MONTH].demandFteConfirmed).toBeGreaterThan(0);
  });

  it('pro-rates a joiner’s capacity to the days employed, not a whole month', () => {
    const employed = employedWorkingDays({ hireDate: '2026-05-18' }, MONTH, NO_HOL);
    const out = rollupMonthly({
      ...base,
      resources: [{ id: 'joiner', name: 'Mid-month Joiner', contractHoursPerDay: 8, hireDate: '2026-05-18' }],
      assignmentDays: [],
    });
    // The ratio, not a magic number: employed working days over the month's own.
    expect(out.totals[MONTH].capacityFte).toBeCloseTo(employed.length / ALL_DAYS.length, 10);
    expect(out.totals[MONTH].capacityFte).toBeLessThan(1);
  });

  it('pro-rates a mid-month LEAVER instead of crediting a full FTE of supply', () => {
    // THE LEAVER DEFECT: the whole month was kept AND credited in full, so the screen
    // advertised capacity the API refuses to book. RED before the fix: exactly 1.
    const employed = employedWorkingDays({ terminationDate: '2026-05-15' }, MONTH, NO_HOL);
    const out = rollupMonthly({
      ...base,
      assignments: [{ id: 'a1', resourceId: 'leaver' }],
      resources: [{ id: 'leaver', name: 'Mid-month Leaver', contractHoursPerDay: 8, terminationDate: '2026-05-15' }],
      assignmentDays: [],
    });
    expect(out.totals[MONTH].capacityFte).toBeCloseTo(employed.length / ALL_DAYS.length, 10);
    expect(out.totals[MONTH].capacityFte).not.toBeCloseTo(1, 6);
  });

  it('still credits a FULL FTE to a full-month employee', () => {
    // ABSENCE TWIN #2, and the one that matters most: a pro-rating that applied to
    // everyone would pass both cases above while halving the whole org's supply.
    const out = rollupMonthly({
      ...base,
      assignments: [{ id: 'a1', resourceId: 'steady' }],
      resources: [{ id: 'steady', name: 'Steady', contractHoursPerDay: 8, hireDate: '2020-01-01' }],
      assignmentDays: [],
    });
    expect(out.totals[MONTH].capacityFte).toBeCloseTo(1, 10);
  });

  it('drops the cell only when NO working day is employed', () => {
    const out = rollupMonthly({
      ...base,
      assignments: [{ id: 'a1', resourceId: 'future' }],
      resources: [{ id: 'future', name: 'Future Hire', contractHoursPerDay: 8, hireDate: '2026-07-01' }],
      assignmentDays: [],
    });
    expect(out.rows.find(r => r.resourceId === 'future')).toBeUndefined();
    expect(out.totals[MONTH].resourceCount).toBe(0);
    expect(out.totals[MONTH].capacityFte).toBe(0);
  });

  it('honours holidays, which the pre-existing cases never exercised', () => {
    // The THIRD holiday hop, and the one this helper owns: the standardMonthlyHours
    // and rollupMonthly/targetHours cases above pin the FTE denominator, this one
    // pins the employed-day count. All three passed NO_HOL originally, so dropping
    // `holidays` at any hop stayed green.
    const withHoliday = new Set(['2026-05-20']);
    const employed = employedWorkingDays({ hireDate: '2026-05-18' }, MONTH, withHoliday);
    expect(employed).not.toContain('2026-05-20');
    expect(employed.length).toBe(employedWorkingDays({ hireDate: '2026-05-18' }, MONTH, NO_HOL).length - 1);
  });
});
