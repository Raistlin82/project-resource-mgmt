import { localIsoDate, todayLocalIso, todayLocalUtcMs, trailingMonths } from './local-date.util';

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

/**
 * B12 — the two derivations the schedule anchor and the dashboard trailing
 * windows are now built on. Both are pinned against a real timezone AND a faked
 * clock, because that is the only way to make the failure mode reachable: under
 * TZ=UTC the broken and the fixed code agree on every input.
 *
 * `process.env['TZ']` is honoured at runtime by Node (verified in this runner),
 * and is restored after each case so a later file in the same worker inherits
 * the machine's own zone.
 */
describe('local civil date → UTC arithmetic bridge (P2-21)', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => { process.env['TZ'] = originalTz; });

  /** Read back a UTC-ms value as a UTC calendar date, so the assertion compares
   *  whole date strings rather than epoch numbers nobody can review. */
  const utcDateOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it('resolves midnight of the local day, not of the UTC day (positive offset)', () => {
    process.env['TZ'] = 'Europe/Rome'; // UTC+2 in August
    // 00:30 on the 4th in Rome. Date.now()'s UTC date here is the 3rd.
    const ms = todayLocalUtcMs(() => new Date('2026-08-03T22:30:00.000Z'));
    expect(utcDateOf(ms)).toBe('2026-08-04');
    // Exactly midnight, so the day/week math it feeds starts on a boundary.
    expect(ms).toBe(Date.UTC(2026, 7, 4));
  });

  it('resolves midnight of the local day, not of the UTC day (negative offset)', () => {
    process.env['TZ'] = 'America/New_York'; // UTC-4 in August
    // 22:30 on the 3rd in New York. Date.now()'s UTC date here is the 4th.
    const ms = todayLocalUtcMs(() => new Date('2026-08-04T02:30:00.000Z'));
    expect(utcDateOf(ms)).toBe('2026-08-03');
    expect(ms).toBe(Date.UTC(2026, 7, 3));
  });

  it('walks a trailing window back from the given month, normalising the year underflow', () => {
    expect(trailingMonths(3, '2026-08')).toEqual(['2026-06', '2026-07', '2026-08']);
    // The underflow case the UTC arithmetic exists for.
    expect(trailingMonths(6, '2026-02')).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
    // Ascending and inclusive of the anchor: a window built the other way round
    // ('2026-08' first) satisfies neither of the two above.
    expect(trailingMonths(1, '2026-12')).toEqual(['2026-12']);
  });
});
