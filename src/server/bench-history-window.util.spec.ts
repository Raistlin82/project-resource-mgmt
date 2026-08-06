import { describe, it, expect } from 'vitest';
import {
  parseHistoryMonths, benchHistoryWindow,
  BENCH_HISTORY_DEFAULT_MONTHS, BENCH_HISTORY_MAX_MONTHS,
} from './bench-history-window.util';

describe('parseHistoryMonths', () => {
  it('absent -> the default, not an error and not 0', () => {
    expect(parseHistoryMonths(undefined)).toStrictEqual({ ok: true, months: BENCH_HISTORY_DEFAULT_MONTHS });
  });
  it('an empty string (a bare `?months=`) -> the default too, not a 400', () => {
    expect(parseHistoryMonths('')).toStrictEqual({ ok: true, months: BENCH_HISTORY_DEFAULT_MONTHS });
  });
  it('a valid count is returned as a NUMBER, not the raw string', () => {
    expect(parseHistoryMonths('6')).toStrictEqual({ ok: true, months: 6 });
  });

  // Both bounds, and the values just inside them: a `<` / `<=` slip at either end
  // is the whole failure mode of a range check, and only the pairs catch it.
  it('accepts exactly 1 and exactly the max (the inclusive bounds)', () => {
    expect(parseHistoryMonths('1')).toStrictEqual({ ok: true, months: 1 });
    expect(parseHistoryMonths(String(BENCH_HISTORY_MAX_MONTHS))).toStrictEqual({ ok: true, months: BENCH_HISTORY_MAX_MONTHS });
  });
  it('refuses 0 and one past the max — and does NOT clamp them to a valid count', () => {
    const zero = parseHistoryMonths('0');
    expect(zero.ok).toBe(false);
    const past = parseHistoryMonths(String(BENCH_HISTORY_MAX_MONTHS + 1));
    expect(past.ok).toBe(false);
    // THE ABSENCE TWIN: clamping is the tempting implementation and it passes any
    // test that only checks the RESULT is usable. These pin that no `months` value
    // comes back at all, so a silent clamp cannot satisfy them.
    expect(zero).not.toHaveProperty('months');
    expect(past).not.toHaveProperty('months');
    expect(past.ok === false && past.error).toContain(String(BENCH_HISTORY_MAX_MONTHS));
  });

  it('refuses non-integer and loosely-coercible forms that Number() would accept', () => {
    // Each of these is truthy-coercible by Number() ('12abc' is not, and is here
    // as the ordinary garbage case). Without the /^\d+$/ gate, '1e1' would silently
    // become 10 months and ' 12 ' 12 — a count the caller never typed.
    for (const raw of ['12abc', 'abc', '1e1', ' 12 ', '12.0', '+12', '-3', '1_2']) {
      expect(parseHistoryMonths(raw).ok, `expected ${JSON.stringify(raw)} to be refused`).toBe(false);
    }
  });
});

describe('benchHistoryWindow', () => {
  it('returns `monthCount` months ENDING at the anchor, oldest-first — the anchor is the LAST entry, never the first', () => {
    const { displayMonths } = benchHistoryWindow('2026-08', 6);
    expect(displayMonths).toStrictEqual(['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    // A forward window (the shape `/bench/monthly` builds) would put the anchor
    // first; this is the assertion that tells the two apart.
    expect(displayMonths[displayMonths.length - 1]).toBe('2026-08');
    expect(displayMonths[0]).not.toBe('2026-08');
  });

  it('crosses the year boundary backward without producing a month 0 or 13', () => {
    const { displayMonths } = benchHistoryWindow('2026-02', 4);
    expect(displayMonths).toStrictEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('a 1-month window is exactly the anchor', () => {
    expect(benchHistoryWindow('2026-08', 1).displayMonths).toStrictEqual(['2026-08']);
  });

  it('the FETCH window adds 2 months of look-back and 1 of look-ahead around the displayed months', () => {
    const { months, displayMonths } = benchHistoryWindow('2026-08', 6);
    expect(months).toStrictEqual([
      '2026-01', '2026-02',                                                   // look-back (not displayed)
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',       // displayed
      '2026-09',                                                              // look-ahead (not displayed)
    ]);
    expect(months.length).toBe(displayMonths.length + 3);
    // THE ABSENCE TWIN for the look-back: the two extra months must NOT leak into
    // what the endpoint returns. A window that fetched and displayed the same range
    // would give the oldest displayed month a truthful-looking but wrong bucket B.
    expect(displayMonths).not.toContain('2026-02');
    expect(displayMonths).not.toContain('2026-09');
  });

  it('the look-back still crosses the year boundary correctly (the fetch window, not just the display one)', () => {
    expect(benchHistoryWindow('2026-01', 1).months).toStrictEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});
