import { monthOf, isWorkingDay, workingDaysInMonth, monthlyTargetHours, distributeHoursOverWindow } from './calendar.util';

describe('monthOf', () => {
  it('extracts YYYY-MM', () => expect(monthOf('2026-03-14')).toBe('2026-03'));
});

describe('isWorkingDay', () => {
  const hol = new Set(['2026-03-17']);
  it('weekday not holiday → true', () => expect(isWorkingDay('2026-03-16', hol)).toBe(true)); // Mon
  it('weekend → false', () => expect(isWorkingDay('2026-03-14', hol)).toBe(false)); // Sat
  it('holiday → false', () => expect(isWorkingDay('2026-03-17', hol)).toBe(false));
});

describe('workingDaysInMonth', () => {
  it('lists weekdays minus holidays, ascending', () => {
    const days = workingDaysInMonth('2026-03', new Set(['2026-03-17']));
    expect(days[0]).toBe('2026-03-02'); // Mar 1 2026 is Sun
    expect(days).not.toContain('2026-03-17');
    expect(days).not.toContain('2026-03-14'); // Sat
    expect(days.every(d => d.startsWith('2026-03'))).toBe(true);
  });
});

describe('monthlyTargetHours', () => {
  it('working days × contract hours/day', () => {
    const t = monthlyTargetHours(8, '2026-03', new Set(['2026-03-17']));
    expect(t).toBe(workingDaysInMonth('2026-03', new Set(['2026-03-17'])).length * 8);
  });
});

describe('distributeHoursOverWindow', () => {
  it('spreads total hours evenly across working days, preserving total', () => {
    const map = distributeHoursOverWindow(160, '2026-03-01', '2026-03-31', new Set());
    const sum = Object.values(map).reduce((a, b) => a + b, 0);
    expect(Math.round(sum)).toBe(160);
    expect(Object.keys(map).every(d => isWorkingDay(d, new Set()))).toBe(true);
  });
  it('no working days → empty map', () => {
    expect(distributeHoursOverWindow(40, '2026-03-14', '2026-03-15', new Set())).toEqual({}); // Sat+Sun
  });
  it('total ≤ 0 → empty map even with working days present', () => {
    expect(distributeHoursOverWindow(0, '2026-03-02', '2026-03-02', new Set())).toEqual({}); // Mon
  });
});
