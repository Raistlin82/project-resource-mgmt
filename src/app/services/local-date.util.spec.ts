import { localIsoDate, todayLocalIso } from './local-date.util';

describe('local date utilities', () => {
  it('formats the calendar date without converting through UTC', () => {
    const lateLocalTime = new Date(2026, 7, 4, 23, 45, 0);

    expect(localIsoDate(lateLocalTime)).toBe('2026-08-04');
  });

  it('uses the provided clock for deterministic date defaults', () => {
    expect(todayLocalIso(() => new Date(2026, 0, 9, 8, 30, 0))).toBe('2026-01-09');
  });
});
