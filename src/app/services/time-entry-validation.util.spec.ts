import type { Assignment, ResourceRequest, TimeEntry } from './api.service';
import {
  isValidIsoCalendarDate,
  timeEntryDateBounds,
  validateTimeEntry,
} from './time-entry-validation.util';

const ASSIGNMENT: Assignment = {
  id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 40, status: 'Allocated',
  startDate: '2026-08-01', endDate: '2026-08-31',
};
const REQUEST: ResourceRequest = {
  id: 'REQ1', name: 'Apollo', requiredRole: 'Developer', requiredEffort: 40,
  status: 'Fulfilled', skills: [], startDate: '2026-08-05', endDate: '2026-09-30',
};

function entry(overrides: Partial<TimeEntry>): TimeEntry {
  return {
    id: 'TE1', assignmentId: 'A1', requestId: 'REQ1', resourceId: 'R1', projectId: 'P1',
    date: '2026-08-08', hours: 1, status: 'Submitted', ...overrides,
  };
}

function validate(overrides: Partial<Parameters<typeof validateTimeEntry>[0]> = {}) {
  return validateTimeEntry({
    assignment: ASSIGNMENT,
    request: REQUEST,
    date: '2026-08-08',
    hours: 2,
    today: '2026-08-08',
    dailyCap: 8,
    existingEntries: [],
    ...overrides,
  });
}

describe('time-entry date bounds', () => {
  it('intersects assignment/request windows and caps their end at local today', () => {
    expect(timeEntryDateBounds(ASSIGNMENT, REQUEST, '2026-08-08')).toEqual({
      minDate: '2026-08-05',
      maxDate: '2026-08-08',
      emptyIntersection: false,
    });
  });

  it('uses today as the only upper bound when neither model exposes a window', () => {
    expect(timeEntryDateBounds({}, undefined, '2026-08-08')).toEqual({
      minDate: undefined,
      maxDate: '2026-08-08',
      emptyIntersection: false,
    });
  });

  it('detects an empty assignment/request intersection', () => {
    expect(timeEntryDateBounds(
      { startDate: '2026-08-10' },
      { endDate: '2026-08-09' },
      '2026-08-20',
    ).emptyIntersection).toBe(true);
  });

  it('rejects impossible calendar dates, not just malformed syntax', () => {
    expect(isValidIsoCalendarDate('2026-02-28')).toBe(true);
    expect(isValidIsoCalendarDate('2026-02-29')).toBe(false);
    expect(isValidIsoCalendarDate('2026-13-01')).toBe(false);
  });
});

describe('time-entry validation policy', () => {
  it('accepts the inclusive intersection boundaries and exactly the daily cap', () => {
    const result = validate({
      date: '2026-08-05',
      hours: 2,
      existingEntries: [entry({ date: '2026-08-05', hours: 6 })],
    });
    expect(result.valid).toBe(true);
    expect(result.remainingHours).toBe(2);
  });

  it('rejects dates before the intersection, after today, and after a model end', () => {
    expect(validate({ date: '2026-08-04' }).dateError).toContain('on or after 2026-08-05');
    expect(validate({ date: '2026-08-09' }).dateError).toContain('later than today');
    expect(validate({
      today: '2026-10-01',
      date: '2026-09-01',
    }).dateError).toContain('on or before 2026-08-31');
  });

  it('requires finite, strictly positive hours', () => {
    for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '8']) {
      expect(validate({ hours }).hoursError).toContain('finite hours greater than zero');
    }
  });

  it('counts all non-rejected entries for the resource/date and rejects an over-cap total', () => {
    const result = validate({
      hours: 3,
      existingEntries: [
        entry({ id: 'TE1', hours: 4, status: 'Approved' }),
        entry({ id: 'TE2', hours: 2, status: 'Submitted' }),
        entry({ id: 'TE3', hours: 99, status: 'Rejected' }),
        entry({ id: 'TE4', date: '2026-08-07', hours: 8, status: 'Approved' }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.existingHours).toBe(6);
    expect(result.remainingHours).toBe(2);
    expect(result.hoursError).toContain('enter at most 2h');
    expect(result.hoursError).toContain('8h daily limit');
  });

  it('can exclude the row being edited from the daily sum', () => {
    const current = entry({ id: 'current', hours: 6 });
    expect(validate({ hours: 6, existingEntries: [current], excludeEntryId: 'current' }).valid).toBe(true);
    expect(validate({ hours: 6, existingEntries: [current] }).valid).toBe(false);
  });
});
