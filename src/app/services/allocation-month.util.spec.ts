import {
  deriveAssignmentStatus,
  isAllowedMonthTransition,
  monthRowId,
  monthlyAggregateHours,
  parseMonthRowId,
  type MonthStatus,
} from './allocation-month.util';

describe('monthRowId / parseMonthRowId', () => {
  it('builds the composite id', () => {
    expect(monthRowId('A12', '2026-09')).toBe('A12:2026-09');
  });

  it('round-trips a composite id', () => {
    expect(parseMonthRowId('A12:2026-09')).toEqual({ assignmentId: 'A12', month: '2026-09' });
  });

  it('returns undefined for a legacy (non-composite) refId', () => {
    expect(parseMonthRowId('A12')).toBeUndefined();
  });

  it('rejects a composite id whose month is not YYYY-MM', () => {
    expect(parseMonthRowId('A12:2026-13')).toBeUndefined();
    expect(parseMonthRowId('A12:not-a-month')).toBeUndefined();
  });
});

describe('isAllowedMonthTransition', () => {
  it('allows the planner submit path', () => {
    expect(isAllowedMonthTransition('Draft', 'Requested')).toBe(true);
    expect(isAllowedMonthTransition('Rejected', 'Requested')).toBe(true);
  });

  it('allows the decision outcomes from Requested', () => {
    expect(isAllowedMonthTransition('Requested', 'Allocated')).toBe(true);
    expect(isAllowedMonthTransition('Requested', 'Rejected')).toBe(true);
  });

  it('allows forced re-approval of an approved month', () => {
    expect(isAllowedMonthTransition('Allocated', 'Requested')).toBe(true);
  });

  it('rejects skipping the approval step', () => {
    expect(isAllowedMonthTransition('Draft', 'Allocated')).toBe(false);
    expect(isAllowedMonthTransition('Rejected', 'Allocated')).toBe(false);
  });

  it('treats a no-op transition as allowed', () => {
    expect(isAllowedMonthTransition('Allocated', 'Allocated')).toBe(true);
  });
});

describe('deriveAssignmentStatus', () => {
  it('is Draft when there are no month rows', () => {
    expect(deriveAssignmentStatus([])).toBe('Draft');
  });

  it('prefers Requested over every other state', () => {
    expect(deriveAssignmentStatus(['Allocated', 'Requested', 'Rejected'])).toBe('Requested');
  });

  it('prefers Rejected over Allocated when nothing is pending', () => {
    expect(deriveAssignmentStatus(['Allocated', 'Rejected', 'Draft'])).toBe('Rejected');
  });

  it('is Allocated when every non-draft month is approved', () => {
    expect(deriveAssignmentStatus(['Allocated', 'Draft'])).toBe('Allocated');
  });

  it('is Draft when all months are drafts', () => {
    expect(deriveAssignmentStatus(['Draft', 'Draft'])).toBe('Draft');
  });
});

describe('monthlyAggregateHours', () => {
  const days = [
    { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
    { assignmentId: 'A1', date: '2026-09-02', hours: 4 },
    { assignmentId: 'A1', date: '2026-10-01', hours: 6 },
    { assignmentId: 'A2', date: '2026-09-03', hours: 5 },
  ];

  it('weighs each day by the status of ITS month', () => {
    const status = new Map<string, MonthStatus>([
      ['A1:2026-09', 'Allocated'],
      ['A1:2026-10', 'Requested'],
      ['A2:2026-09', 'Draft'],
    ]);
    // confirmed = Allocated months only (8 + 4); planned = Requested + Allocated (8 + 4 + 6).
    expect(monthlyAggregateHours(days, status)).toEqual({ confirmed: 12, planned: 18 });
  });

  it('ignores days whose month row is missing or Rejected', () => {
    const status = new Map<string, MonthStatus>([['A1:2026-09', 'Rejected']]);
    expect(monthlyAggregateHours(days, status)).toEqual({ confirmed: 0, planned: 0 });
  });

  it('treats non-finite hours as zero', () => {
    const status = new Map<string, MonthStatus>([['A1:2026-09', 'Allocated']]);
    const rows = [{ assignmentId: 'A1', date: '2026-09-01', hours: Number.NaN }];
    expect(monthlyAggregateHours(rows, status)).toEqual({ confirmed: 0, planned: 0 });
  });
});
