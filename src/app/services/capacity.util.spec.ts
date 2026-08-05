import {
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
  const assignmentDays = [
    { assignmentId: 'a1', date: '2026-05-04', hours: 100 },
    { assignmentId: 'a2', date: '2026-05-05', hours: 40 },
    { assignmentId: 'a3', date: '2026-05-04', hours: 84 },
  ];

  const out = rollupMonthly({ resources, assignments, assignmentDays, assignmentMonths, months, hoursPerDay, holidays: NO_HOL });

  it('splits confirmed vs planned per resource/month', () => {
    const r1 = out.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'];
    expect(r1.confirmedHours).toBe(100);
    expect(r1.plannedHours).toBe(140);
  });
  it('band uses planned FTE', () => {
    const r1 = out.rows.find(r => r.resourceId === 'r1')!.monthly['2026-05'];
    // ftePlanned = 140 / standardMonthlyHours('2026-05',8) → compute expected band from the real working-day count
    const std = standardMonthlyHours('2026-05', 8, NO_HOL);
    const expectedBand = semaphoreBand((140 / std) * 100);
    expect(r1.band).toBe(expectedBand);
  });
  it('part-time capacity is 0.5 FTE; full is 1.0', () => {
    expect(out.totals['2026-05'].capacityFte).toBeCloseTo(1.5);
    expect(out.totals['2026-05'].resourceCount).toBe(2);
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
