import {
  AbsenceInterval, IdleMonth, IDLE_WORKING_DAYS_B_MAX, IDLE_WORKING_DAYS_C_MAX,
  LONGEST_WORKING_MONTH_DAYS, absenceDaysFor, availableWorkingDays, idleWorkingDaysAt, monthAvailability,
} from './absence.util';
import { workingDaysInMonth } from './calendar.util';
import { employedWorkingDays } from './capacity.util';

const NO_HOL = new Set<string>();

/**
 * 2026-05 has 21 working days: the 1st (a Friday) plus four full Mon-Fri weeks
 * (4-8, 11-15, 18-22, 25-29). Every window below is written against that
 * calendar, and asserted against `workingDaysInMonth` rather than a literal, so a
 * calendar change shows up here instead of silently re-scoping the fixtures.
 */
const MAY = '2026-05';
const MAY_DAYS = workingDaysInMonth(MAY, NO_HOL);

/** UTC-only by construction: every input and output below is an ISO string, and
 *  nothing in this file constructs a `Date`. A run under any TZ gives the same
 *  numbers — the repo has already paid for tests that were only true under UTC. */
describe('absenceDaysFor', () => {
  it('covers the closed interval — both endpoints included, neither neighbour', () => {
    const got = absenceDaysFor('r1', [{ resourceId: 'r1', startDate: '2026-05-11', endDate: '2026-05-15' }], MAY_DAYS);
    expect([...got]).toEqual(['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15']);
    expect(got.has('2026-05-11')).toBe(true);
    expect(got.has('2026-05-15')).toBe(true);
    // ABSENCE TWIN: an off-by-one at either bound is the whole defect class here,
    // and a half-open interval would drop the 15th while still passing the list above.
    expect(got.has('2026-05-08')).toBe(false);
    expect(got.has('2026-05-18')).toBe(false);
  });

  it('reads only the requested resource’s rows', () => {
    const row: AbsenceInterval = { resourceId: 'other', startDate: '2026-05-11', endDate: '2026-05-15' };
    expect(absenceDaysFor('r1', [row], MAY_DAYS).size).toBe(0);
    // PRESENCE TWIN: the very same row, read for its own resource, does subtract —
    // so the emptiness above is the filter working, not the interval failing to match.
    expect(absenceDaysFor('other', [row], MAY_DAYS).size).toBe(5);
  });

  it('never subtracts the same day twice when two absences overlap', () => {
    const a: AbsenceInterval = { resourceId: 'r1', startDate: '2026-05-11', endDate: '2026-05-15' };
    const b: AbsenceInterval = { resourceId: 'r1', startDate: '2026-05-13', endDate: '2026-05-19' };
    const union = absenceDaysFor('r1', [a, b], MAY_DAYS);
    // 11,12,13,14,15,18,19 — the weekend of 16-17 is not a working day at all.
    expect(union.size).toBe(7);
    const sumOfParts = absenceDaysFor('r1', [a], MAY_DAYS).size + absenceDaysFor('r1', [b], MAY_DAYS).size;
    expect(sumOfParts).toBe(10);
    // THE reason the return type is a Set: overlapping rows are refused on write
    // (spec §6.4) but not impossible on imported data, and double subtraction
    // drives a pro-rated target NEGATIVE.
    expect(union.size).toBeLessThan(sumOfParts);
  });

  it('adds up two adjacent, non-overlapping absences', () => {
    const got = absenceDaysFor('r1', [
      { resourceId: 'r1', startDate: '2026-05-11', endDate: '2026-05-12' },
      { resourceId: 'r1', startDate: '2026-05-13', endDate: '2026-05-14' },
    ], MAY_DAYS);
    // ABSENCE TWIN of the overlap case: de-duplication must not merge distinct days.
    expect(got.size).toBe(4);
  });

  it('handles a one-day absence (startDate === endDate)', () => {
    const got = absenceDaysFor('r1', [{ resourceId: 'r1', startDate: '2026-05-13', endDate: '2026-05-13' }], MAY_DAYS);
    expect([...got]).toEqual(['2026-05-13']);
  });

  it('subtracts nothing for an absence that falls entirely on non-working days', () => {
    // 2026-05-09/10 is a weekend: it was never available, so there is nothing to lose.
    expect(absenceDaysFor('r1', [{ resourceId: 'r1', startDate: '2026-05-09', endDate: '2026-05-10' }], MAY_DAYS).size).toBe(0);
    // PRESENCE TWIN: extending the same absence by one day to the Monday subtracts
    // exactly that one day — so the zero above is the day filter, not a dead branch.
    expect([...absenceDaysFor('r1', [{ resourceId: 'r1', startDate: '2026-05-09', endDate: '2026-05-11' }], MAY_DAYS)])
      .toEqual(['2026-05-11']);
  });

  it('clips an absence that straddles the month boundary to the days it was asked about', () => {
    const got = absenceDaysFor('r1', [{ resourceId: 'r1', startDate: '2026-04-27', endDate: '2026-05-05' }], MAY_DAYS);
    expect([...got]).toEqual(['2026-05-01', '2026-05-04', '2026-05-05']);
    // ABSENCE TWIN: April's days are not in the candidate list, so they cannot leak
    // into May's count no matter how far back the row reaches.
    expect([...got].every(d => d.startsWith('2026-05'))).toBe(true);
  });

  it('covers nothing when the interval is inverted, rather than throwing', () => {
    expect(absenceDaysFor('r1', [{ resourceId: 'r1', startDate: '2026-05-15', endDate: '2026-05-11' }], MAY_DAYS).size).toBe(0);
  });

  it('returns an empty Set — not undefined — when there are no absences at all', () => {
    const got = absenceDaysFor('r1', [], MAY_DAYS);
    expect(got.size).toBe(0);
    expect(got.has('2026-05-11')).toBe(false);
  });
});

describe('availableWorkingDays (a SIBLING of employedWorkingDays, never an override)', () => {
  it('removes exactly the absent days and keeps the list ascending', () => {
    const out = availableWorkingDays('r1', [{ resourceId: 'r1', startDate: '2026-05-11', endDate: '2026-05-15' }], MAY_DAYS);
    expect(out).toStrictEqual(MAY_DAYS.filter(d => d < '2026-05-11' || d > '2026-05-15'));
    expect(out.length).toBe(MAY_DAYS.length - 5);
    expect(out).not.toContain('2026-05-13');
  });

  it('returns the employed list unchanged when nothing applies', () => {
    // ABSENCE TWIN of everything above: a filter that always narrowed would pass
    // every case in this describe and quietly delete capacity for the whole org.
    expect(availableWorkingDays('r1', [], MAY_DAYS)).toStrictEqual(MAY_DAYS);
    expect(availableWorkingDays('r1', [{ resourceId: 'someone-else', startDate: '2026-05-01', endDate: '2026-05-31' }], MAY_DAYS))
      .toStrictEqual(MAY_DAYS);
  });

  it('is empty when the whole month is covered', () => {
    expect(availableWorkingDays('r1', [{ resourceId: 'r1', startDate: '2026-05-01', endDate: '2026-05-31' }], MAY_DAYS)).toStrictEqual([]);
  });

  it('crosses employment boundaries without ever subtracting a day she did not have', () => {
    // 2026-05-18 is a Monday, so a hire that day leaves 18-22 and 25-29: ten days.
    const employed = employedWorkingDays({ hireDate: '2026-05-18' }, MAY, NO_HOL);
    expect(employed.length).toBe(10);

    // An absence entirely BEFORE the hire date removes nothing: those days were
    // never employed, so counting them would make the target larger than the month.
    expect(availableWorkingDays('r1', [{ resourceId: 'r1', startDate: '2026-05-04', endDate: '2026-05-08' }], employed))
      .toStrictEqual(employed);

    // PRESENCE TWIN: an absence that overlaps the employed window removes only the
    // overlap — two days here (18th and 19th), not the six the row spans.
    const overlapping = availableWorkingDays('r1', [{ resourceId: 'r1', startDate: '2026-05-04', endDate: '2026-05-19' }], employed);
    expect(overlapping.length).toBe(employed.length - 2);
    expect(overlapping[0]).toBe('2026-05-20');
  });
});

describe('monthAvailability', () => {
  const three = ['2026-05-11', '2026-05-12', '2026-05-13'];
  it('available when nothing was lost', () => expect(monthAvailability(three, three)).toBe('available'));
  it('partly-absent when some of it was', () => expect(monthAvailability(three, three.slice(0, 2))).toBe('partly-absent'));
  it('fully-absent when all of it was', () => expect(monthAvailability(three, [])).toBe('fully-absent'));
  it('not-employed outranks fully-absent when there was no employed day to lose', () => {
    // The branch ORDER is the definition: somebody who was not our employee that
    // month is not on leave, and `bench.util` must not paint her ABSENT.
    expect(monthAvailability([], [])).toBe('not-employed');
    expect(monthAvailability([], [])).not.toBe('fully-absent');
  });
});

describe('LONGEST_WORKING_MONTH_DAYS / the idle-aging thresholds', () => {
  it('is 23, and is genuinely derived from the calendar', () => {
    expect(LONGEST_WORKING_MONTH_DAYS).toBe(23);
    // Measured here over 2028-2031 — a DIFFERENT four-year window from the module's
    // 2024-2027, so this is a second measurement rather than a copy of the formula.
    // The MAXIMUM is stable at 23 for any such window (a 31-day month starting on a
    // Monday), which is the property that makes the constant window-insensitive.
    let longest = 0;
    for (let y = 2028; y <= 2031; y++) {
      for (let m = 1; m <= 12; m++) {
        longest = Math.max(longest, workingDaysInMonth(`${y}-${String(m).padStart(2, '0')}`, NO_HOL).length);
      }
    }
    expect(longest).toBe(LONGEST_WORKING_MONTH_DAYS);
  });

  it('is the LONGEST month, not the average one', () => {
    // ABSENCE TWIN of the case above, and the assertion this file did not have.
    // The constant used to be the mean floored (21). Nothing here was wrong about
    // 21 as a number — what was wrong is that 21 cannot be a ceiling for "one
    // month", because a real month runs 20 to 23 working days.
    const mean = (() => {
      let days = 0, months = 0;
      for (let y = 2028; y <= 2031; y++) {
        for (let m = 1; m <= 12; m++) {
          days += workingDaysInMonth(`${y}-${String(m).padStart(2, '0')}`, NO_HOL).length;
          months++;
        }
      }
      return days / months;
    })();
    expect(Math.floor(mean)).toBe(21);
    expect(LONGEST_WORKING_MONTH_DAYS).toBeGreaterThan(Math.floor(mean));
  });

  /**
   * THE REQUIREMENT, stated as a test instead of as prose — and the one that was
   * missing. The RPT labels mean "B = idle less than one month, C = one to two,
   * D = over two". Against a ceiling of 21 that was FALSE for most of the year:
   * one full month of idleness read B in May and August 2026 (21 working days) and
   * C in April, June, July and September (22-23). The bucket depended on which
   * month somebody happened to be idle in.
   *
   * Every month of the derivation window, both ends of both boundaries. A mean-
   * based ceiling fails this on the first 22-day month it reaches.
   */
  it('one full month of idleness is B, and two full months are C, for EVERY month', () => {
    const offenders: string[] = [];
    for (let y = 2024; y <= 2027; y++) {
      for (let m = 1; m <= 12; m++) {
        const month = `${y}-${String(m).padStart(2, '0')}`;
        const oneMonth = workingDaysInMonth(month, NO_HOL).length;
        if (oneMonth > IDLE_WORKING_DAYS_B_MAX) offenders.push(`${month} (${oneMonth}d) escapes B`);
        if (oneMonth * 2 > IDLE_WORKING_DAYS_C_MAX) offenders.push(`${month} x2 (${oneMonth * 2}d) escapes C`);
      }
    }
    expect(offenders, 'a full month of idleness must never escape its bucket').toStrictEqual([]);
  });

  it('anchors B and C to one and two working months', () => {
    expect(IDLE_WORKING_DAYS_B_MAX).toBe(LONGEST_WORKING_MONTH_DAYS);
    expect(IDLE_WORKING_DAYS_C_MAX).toBe(LONGEST_WORKING_MONTH_DAYS * 2);
    // Literals as well as the relation: a `* 2` typo'd to `* 1` satisfies the two
    // assertions above only if the relation is the only thing checked.
    expect(IDLE_WORKING_DAYS_B_MAX).toBe(23);
    expect(IDLE_WORKING_DAYS_C_MAX).toBe(46);
  });
});

/**
 * The Q1 decision (spec §10, 2026-08-07) lives or dies here: an absent day is not
 * an idle day, because the person was not staffable on it — so it neither
 * increments the count nor breaks the run. `absenceStreakPolicy`'s
 * transparent/break dilemma does not exist at this granularity, and each case
 * below names the wrong answer it would have produced.
 */
describe('idleWorkingDaysAt', () => {
  const idle = (availableDays: number): IdleMonth => ({ employed: true, staffed: false, availableDays });
  const busy = (availableDays: number): IdleMonth => ({ employed: true, staffed: true, availableDays });
  const fullyAbsent: IdleMonth = { employed: true, staffed: false, availableDays: 0 };
  const notEmployed: IdleMonth = { employed: false, staffed: false, availableDays: 0 };

  it('sums the available days of consecutive idle months', () => {
    expect(idleWorkingDaysAt([idle(20), idle(21), idle(22)], 2)).toBe(63);
    expect(idleWorkingDaysAt([idle(20), idle(21), idle(22)], 0)).toBe(20);
  });

  it('stops at a staffed month', () => {
    expect(idleWorkingDaysAt([idle(20), busy(21), idle(22)], 2)).toBe(22);
    // PRESENCE TWIN: the same run without the staffed month counts everything, so
    // the 22 above is the break firing rather than the earlier months being unread.
    expect(idleWorkingDaysAt([idle(20), idle(21), idle(22)], 2)).toBe(63);
  });

  it('treats a fully absent month as zero days — it neither breaks the run nor pads it', () => {
    const absentMonthWorkingDays = 21;
    const run = [idle(20), fullyAbsent, idle(22)];
    expect(idleWorkingDaysAt(run, 2)).toBe(42);
    // ABSENCE TWIN A — the 'break' answer §4.2 offered: only the trailing month.
    expect(idleWorkingDaysAt(run, 2)).not.toBe(22);
    // ABSENCE TWIN B — the 'inflate' answer: the leave month counted as idle.
    expect(idleWorkingDaysAt(run, 2)).not.toBe(20 + absentMonthWorkingDays + 22);
  });

  it('counts only the days she was actually there for in a PARTLY absent month', () => {
    const monthWorkingDays = 21;
    const absentDays = 5;
    expect(idleWorkingDaysAt([idle(monthWorkingDays - absentDays)], 0)).toBe(16);
    // ABSENCE TWIN: crediting the whole month is exactly what ignoring absences does.
    expect(idleWorkingDaysAt([idle(monthWorkingDays - absentDays)], 0)).not.toBe(monthWorkingDays);
  });

  it('carries a long idle run straight through a month of leave (the Q1 scenario)', () => {
    // Idle since the start of the window, one whole month taken as leave, still idle.
    const run = [idle(21), idle(20), idle(22), fullyAbsent, idle(21)];
    expect(idleWorkingDaysAt(run, 4)).toBe(84);
    // She stays in the top bucket: 84 days is well past two working months...
    expect(idleWorkingDaysAt(run, 4)).toBeGreaterThan(IDLE_WORKING_DAYS_C_MAX);
    // ...whereas 'break' would have restarted her at 21 days, i.e. back in B —
    // "risolve un'inflazione di C/D creando una deflazione" (spec §4.2).
    expect(idleWorkingDaysAt(run, 4)).toBeGreaterThan(IDLE_WORKING_DAYS_B_MAX);
  });

  it('does not let a stale booking on a fully absent month break the run', () => {
    // §6.4 accepts an absence recorded over already-booked days, so these rows exist.
    // The zero-days test runs BEFORE the staffed test precisely for this case.
    const staleBooked: IdleMonth = { employed: true, staffed: true, availableDays: 0 };
    expect(idleWorkingDaysAt([idle(20), staleBooked, idle(22)], 2)).toBe(42);
    // PRESENCE TWIN: the same staffed month WITH days available does break, so this
    // is not "staffed is ignored".
    expect(idleWorkingDaysAt([idle(20), busy(21), idle(22)], 2)).toBe(22);
  });

  it('stops at a month she was not employed in — not every zero-day month is transparent', () => {
    expect(idleWorkingDaysAt([idle(20), notEmployed, idle(22)], 2)).toBe(22);
    // ABSENCE TWIN: the fully-absent month has the same zero day count and does NOT
    // stop, which is the distinction this rule exists to make.
    expect(idleWorkingDaysAt([idle(20), fullyAbsent, idle(22)], 2)).toBe(42);
  });

  it('degrades a bad index to a number instead of crashing', () => {
    expect(idleWorkingDaysAt([idle(20)], -1)).toBe(0);
    expect(idleWorkingDaysAt([idle(20)], 5)).toBe(20);
    expect(idleWorkingDaysAt([], 0)).toBe(0);
  });

  it('survives a non-finite or negative day count without poisoning the total', () => {
    const poisoned: IdleMonth = { employed: true, staffed: false, availableDays: Number.NaN };
    const negative: IdleMonth = { employed: true, staffed: false, availableDays: -5 };
    for (const bad of [poisoned, negative]) {
      const got = idleWorkingDaysAt([idle(20), bad, idle(22)], 2);
      expect(Number.isFinite(got)).toBe(true);
      expect(got).toBe(42);
    }
  });
});
