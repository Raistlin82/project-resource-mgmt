import { localIsoDate, todayLocalIso } from './local-date.util';

/**
 * P2-21. The bug this util replaced was `date.toISOString().slice(0, 10)`, which
 * slips a day whenever the local calendar date and the UTC date disagree.
 *
 * THE OLD TESTS COULD NOT SEE IT. `new Date(2026, 7, 4, 23, 45)` is 21:45Z in
 * Europe/Rome and 23:45Z in a UTC CI container, so the buggy implementation
 * returned the SAME '2026-08-04' in both — a local 23:45 only crosses UTC
 * midnight at NEGATIVE offsets. So the assertions passed in every environment the
 * suite actually runs in, including the one CI uses.
 *
 * Fixing it by pinning a timezone would only move the blind spot. Instead the
 * discriminating cases below supply a Date whose LOCAL fields and UTC date
 * disagree by construction, which is the real condition — and therefore holds
 * under any ambient TZ, offset 0 included.
 */
describe('local date utilities', () => {
  /** A Date stand-in: local calendar fields, plus a deliberately different UTC day. */
  function dateWith(
    local: { year: number; month: number; day: number },
    utcIso: string,
  ): Date {
    return {
      getFullYear: () => local.year,
      getMonth: () => local.month,
      getDate: () => local.day,
      toISOString: () => utcIso,
    } as unknown as Date;
  }

  it('reads the local calendar fields, not the UTC date (western offset)', () => {
    // 2026-08-04 21:45 in UTC-7 is 2026-08-05T04:45Z. toISOString().slice(0,10)
    // returns '2026-08-05' — tomorrow — in EVERY timezone the test runs in.
    expect(localIsoDate(dateWith({ year: 2026, month: 7, day: 4 }, '2026-08-05T04:45:00.000Z')))
      .toBe('2026-08-04');
  });

  it('reads the local calendar fields, not the UTC date (eastern offset)', () => {
    // The mirror case, which a western-only pin would miss: 2026-08-04 00:30 in
    // UTC+2 is 2026-08-03T22:30Z, so the buggy slice returns YESTERDAY.
    expect(localIsoDate(dateWith({ year: 2026, month: 7, day: 4 }, '2026-08-03T22:30:00.000Z')))
      .toBe('2026-08-04');
  });

  it('never consults the UTC serialization at all', () => {
    // The strongest form of the same statement, and fully TZ-independent: if the
    // implementation reaches for toISOString the test throws rather than
    // comparing two strings that happen to match at offset 0.
    const tripwire = {
      getFullYear: () => 2026,
      getMonth: () => 0,
      getDate: () => 31,
      toISOString: () => {
        throw new Error('localIsoDate must not go through UTC');
      },
    } as unknown as Date;

    expect(localIsoDate(tripwire)).toBe('2026-01-31');
  });

  it('zero-pads single-digit months and days', () => {
    expect(localIsoDate(new Date(2026, 0, 9, 8, 30, 0))).toBe('2026-01-09');
    expect(localIsoDate(new Date(2026, 8, 1, 12, 0, 0))).toBe('2026-09-01');
  });

  it('uses the provided clock for deterministic date defaults', () => {
    expect(todayLocalIso(() => new Date(2026, 0, 9, 8, 30, 0))).toBe('2026-01-09');
  });
});
