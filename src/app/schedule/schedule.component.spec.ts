import { currentWeekAnchorMs } from './schedule.component';

/**
 * B12 / P2-21 — the timeline's "this week" anchor.
 *
 * This file currently covers ONLY that rule: it needs no TestBed, since the
 * anchor is an exported pure function with an injectable clock. The component
 * itself still has no spec (B11 owns writing one — keyboard reassign, the drag
 * threshold and the ARIA rows); add those describes here rather than starting a
 * second file.
 *
 * Both cases pin a real timezone, because the defect is unreachable without one:
 * under TZ=UTC `mondayUtcMs(Date.now())` and `mondayUtcMs(todayLocalUtcMs())`
 * agree on every instant, so an unpinned test certifies nothing. The pin is
 * restored afterwards so a later file in the same worker sees the machine's zone.
 *
 * 2026-08-03 is a Monday, which is what makes these two instants — 90 minutes
 * apart in real time — land on DIFFERENT WEEKS rather than adjacent days.
 */
describe('Schedule week anchor (P2-21)', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => { process.env['TZ'] = originalTz; });

  /** The anchor read back as a UTC date string: what week the grid opens on. */
  const anchorDate = (iso: string) => new Date(currentWeekAnchorMs(() => new Date(iso))).toISOString().slice(0, 10);

  it('opens on the Monday of the user\'s local week, not of the UTC week (positive offset)', () => {
    process.env['TZ'] = 'Europe/Rome'; // UTC+2 in August
    // 00:30 on Monday 3 August in Rome. In UTC it is still Sunday the 2nd, so
    // the pre-fix anchor was Monday 27 JULY — the grid opened a whole week
    // behind, with today off the right-hand edge of the visible horizon.
    expect(anchorDate('2026-08-02T23:30:00.000Z')).toBe('2026-08-03');
  });

  it('opens on the Monday of the user\'s local week, not of the UTC week (negative offset)', () => {
    process.env['TZ'] = 'America/New_York'; // UTC-4 in August
    // 22:30 on Sunday 2 August in New York. In UTC it is already Monday the 3rd,
    // so the pre-fix anchor jumped the grid a week AHEAD of the user's own week.
    expect(anchorDate('2026-08-03T02:30:00.000Z')).toBe('2026-07-27');
  });

  it('is midnight UTC, so the week-column arithmetic starts on a day boundary', () => {
    process.env['TZ'] = 'Europe/Rome';
    expect(currentWeekAnchorMs(() => new Date('2026-08-05T13:00:00.000Z'))).toBe(Date.UTC(2026, 7, 3));
  });
});
