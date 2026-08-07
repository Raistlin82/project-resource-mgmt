import { describe, it, expect } from 'vitest';
import {
  benchStateFor, bucketForIdleWorkingDays, freeingUpNextMonth, availabilityDateFor,
  unallocatedShare,
  type BenchState,
} from './bench.util';
import { IDLE_WORKING_DAYS_B_MAX, IDLE_WORKING_DAYS_C_MAX, idleWorkingDaysAt, type IdleMonth } from './absence.util';

describe('unallocatedShare (RPT comparison row 50 — the complement of allocation, on the resource’s OWN target)', () => {
  // 20 employed working days × 8h = a 160h own target throughout, so every
  // expectation below is arithmetic on ONE number the test states itself.
  const DAYS = 20;
  const HPD = 8;

  it('nothing booked -> 100% unallocated, and every employed day unallocated', () =>
    expect(unallocatedShare(0, HPD, DAYS)).toStrictEqual({ unallocatedPct: 100, unallocatedDays: 20 }));
  it('booked exactly to target -> 0%, 0 days', () =>
    expect(unallocatedShare(160, HPD, DAYS)).toStrictEqual({ unallocatedPct: 0, unallocatedDays: 0 }));

  // 40 of 160 booked. DELIBERATELY not the midpoint: at 50% a complement
  // inversion — returning the ALLOCATED share instead of the unallocated one —
  // produces the identical number and the test cannot see it. Here allocation is
  // 25% and disallocation 75%, so the two are distinguishable.
  it('partially booked -> the COMPLEMENT of the allocated share, not the allocated share itself', () => {
    expect(unallocatedShare(40, HPD, DAYS)).toStrictEqual({ unallocatedPct: 75, unallocatedDays: 15 });
    // The absence twin, spelled out: 25 is what the inverted implementation returns.
    expect(unallocatedShare(40, HPD, DAYS)?.unallocatedPct).not.toBe(25);
  });

  it('OVER-allocated -> 0%, never a negative percentage or negative days (spec: truncated to [0, 100])', () => {
    expect(unallocatedShare(200, HPD, DAYS)).toStrictEqual({ unallocatedPct: 0, unallocatedDays: 0 });
    const pct = unallocatedShare(200, HPD, DAYS)!.unallocatedPct;
    expect(pct).toBeGreaterThanOrEqual(0);
  });

  it('the upper truncation holds too: a negative booking cannot push the share past 100%', () => {
    // Not a value the API should ever store, which is the point — the clamp is
    // what stops a corrupt row from rendering "137.5% unallocated" as a fact.
    expect(unallocatedShare(-60, HPD, DAYS)).toStrictEqual({ unallocatedPct: 100, unallocatedDays: 20 });
  });

  // THE PART-TIME / MID-MONTH CASE, which is the whole reason the denominator is
  // not the standard month: each of these would be wrong if the target were a
  // fixed 22-day / full-time month.
  it('a PART-TIMER fully booked on her own contract is 0% unallocated, not half-idle', () => {
    // 4h/day × 20 days = an 80h own target, fully booked.
    expect(unallocatedShare(80, 4, DAYS)).toStrictEqual({ unallocatedPct: 0, unallocatedDays: 0 });
    // ABSENCE TWIN: 50% is exactly what a full-time (8h/day) denominator yields
    // for the same booking — the figure that would tell a planner to go and fill
    // half a week that does not exist.
    expect(unallocatedShare(80, 4, DAYS)?.unallocatedPct).not.toBe(50);
  });
  it('a MID-MONTH joiner is measured against the days she was employed, not the whole month', () => {
    // 10 employed days × 8h = 80h own target, 60h booked -> 20h idle = 25%, 2.5 days.
    expect(unallocatedShare(60, HPD, 10)).toStrictEqual({ unallocatedPct: 25, unallocatedDays: 2.5 });
    // ABSENCE TWIN: against a full 21-day May (168h) the same booking reads ~64%.
    expect(unallocatedShare(60, HPD, 10)!.unallocatedPct).not.toBeCloseTo(((168 - 60) / 168) * 100, 5);
  });

  it('produces fractional days when the idle hours are not a whole number of days (raw, unrounded)', () =>
    // 126h idle of a 168h target -> 15.75 days. The 2-decimal cap is a RENDERING
    // step; this layer must not pre-round or the FTE-style figures lose precision.
    expect(unallocatedShare(42, HPD, 21)).toStrictEqual({ unallocatedPct: 75, unallocatedDays: 15.75 }));

  // The "unanswerable" branch. Absence here is a VALUE, and it is the reason the
  // BenchCell fields are optional rather than required.
  it('an own target of 0 -> undefined, NOT 0% (a share of no capacity is unanswerable, and 0% would read as "fully allocated")', () => {
    expect(unallocatedShare(0, 0, DAYS)).toBeUndefined();   // no contracted hours per day
    expect(unallocatedShare(0, HPD, 0)).toBeUndefined();    // employed on no working day
    expect(unallocatedShare(0, -8, DAYS)).toBeUndefined();  // nonsense contract, still no answer
  });
  it('a non-finite input on EITHER side -> undefined, so no template can ever render "NaN%"', () => {
    expect(unallocatedShare(0, Number.NaN, DAYS)).toBeUndefined();
    expect(unallocatedShare(0, HPD, Number.NaN)).toBeUndefined();
    // The booking side too — the guard `hoursByResourceMonth` already applies to
    // its inputs, restated here so this function is safe on its own terms.
    expect(unallocatedShare(Number.NaN, HPD, DAYS)).toBeUndefined();
    expect(unallocatedShare(Number.POSITIVE_INFINITY, HPD, DAYS)).toBeUndefined();
  });
});

describe('benchStateFor (design spec §3 — decided on RAW hours, never the rounded %)', () => {
  it('exactly 0 planned -> BENCH', () => expect(benchStateFor(0, 160)).toBe('BENCH'));
  it('just above 0 planned -> PARTIAL, NOT bench (0.4h rounds to 0.00% but is a real booking)', () =>
    expect(benchStateFor(0.4, 176)).toBe('PARTIAL'));
  it('just below target -> PARTIAL', () => expect(benchStateFor(159.99, 160)).toBe('PARTIAL'));
  it('exactly at target -> ALLOCATED', () => expect(benchStateFor(160, 160)).toBe('ALLOCATED'));
  it('above target (over-allocated) -> ALLOCATED, never a state above it', () => expect(benchStateFor(200, 160)).toBe('ALLOCATED'));

  /**
   * H: this function is UNCHANGED and, crucially, cannot produce the fourth state
   * — `'ABSENT'` is decided from availability by the caller. The case below is the
   * one false answer it can still give, which is why `benchRollup` must branch on
   * availability BEFORE reaching it (spec §4.4). Pinned here so the guard has a
   * reason a reader can see, not only a comment.
   */
  it('a 0/0 month answers BENCH — the false answer the CALLER must not let it be asked (spec §4.4)', () => {
    expect(benchStateFor(0, 0)).toBe('BENCH');
    expect(benchStateFor(0, 0)).not.toBe('ABSENT');
  });
  it('never returns ABSENT for any hour/target combination — availability is not an hours question', () => {
    for (const [planned, target] of [[0, 0], [0, 168], [40, 168], [168, 168], [200, 168], [40, 0]]) {
      expect(benchStateFor(planned, target)).not.toBe('ABSENT');
    }
  });
});

/**
 * H replaced the month count with a WORKING-DAY count (product decision Q1). The
 * walk itself is `idleWorkingDaysAt` and is unit-tested in `absence.util.spec.ts`;
 * what belongs here is the LABELLING — and the boundaries, because B/C/D are what
 * a user reads.
 */
describe('bucketForIdleWorkingDays (B/C/D from consecutive idle WORKING DAYS, spec §10 Q1)', () => {
  it('the thresholds this suite asserts against are the derived ones, not 21/42 retyped', () => {
    // A guard on the FIXTURE: if the derivation in absence.util ever moves, the
    // boundary cases below move with it instead of silently asserting the wrong side.
    expect(IDLE_WORKING_DAYS_B_MAX).toBe(23);
    expect(IDLE_WORKING_DAYS_C_MAX).toBe(46);
  });

  it('1 day -> B (one day idle is the shallowest real bucket, never C)', () => {
    expect(bucketForIdleWorkingDays(1)).toBe('B');
    expect(bucketForIdleWorkingDays(1)).not.toBe('C');
  });
  // The three boundary PAIRS. Each asserts the day ON the boundary and the day
  // AFTER it, so an off-by-one in either comparison is red — a `<` instead of
  // `<=` moves 23 to C and 46 to D, which is a whole bucket of people
  // reclassified.
  it('B is INCLUSIVE at 23, and 24 is already C', () => {
    expect(bucketForIdleWorkingDays(IDLE_WORKING_DAYS_B_MAX)).toBe('B');
    expect(bucketForIdleWorkingDays(IDLE_WORKING_DAYS_B_MAX + 1)).toBe('C');
  });
  it('C is INCLUSIVE at 46, and 47 is already D', () => {
    expect(bucketForIdleWorkingDays(IDLE_WORKING_DAYS_C_MAX)).toBe('C');
    expect(bucketForIdleWorkingDays(IDLE_WORKING_DAYS_C_MAX + 1)).toBe('D');
  });
  it('far past the top boundary -> still D (there is no fifth bucket)', () =>
    expect(bucketForIdleWorkingDays(500)).toBe('D'));
  it('0 days degrades to B rather than throwing (unreachable from a BENCH cell, which always contributes >= 1 day)', () =>
    expect(bucketForIdleWorkingDays(0)).toBe('B'));

  /**
   * THE REQUIREMENT the unit change has to keep, stated as a test.
   *
   * This case previously asserted the OPPOSITE — that one 22-working-day month
   * reads C "where the month count said B" — and presented that as the unit
   * change working. It was the defect: against a ceiling of 21, one full month of
   * idleness read B in a 21-day month and C in a 22- or 23-day one, so the bucket
   * depended on WHICH month somebody was idle in. The manual says B is "idle less
   * than one month" and does not qualify it by calendar. Fixed by taking the
   * LONGEST possible month (23) as the ceiling instead of the floored mean.
   *
   * The composition is tested here because it is what `benchRollup` does, and it
   * is where a mismatched unit — days handed to a month classifier, or the
   * reverse — would show up.
   */
  it('composes with idleWorkingDaysAt: ONE full idle month is B, whichever month it is', () => {
    // Every length a real month can take, including the long ones that used to
    // escape into C.
    for (const availableDays of [20, 21, 22, 23]) {
      const months: IdleMonth[] = [{ employed: true, staffed: false, availableDays }];
      expect(idleWorkingDaysAt(months, 0)).toBe(availableDays);
      expect(bucketForIdleWorkingDays(idleWorkingDaysAt(months, 0)), `${availableDays}d`).toBe('B');
    }
    // ABSENCE TWIN: the bucket is not simply always B — two full months is C.
    const two: IdleMonth[] = [
      { employed: true, staffed: false, availableDays: 22 },
      { employed: true, staffed: false, availableDays: 23 },
    ];
    expect(idleWorkingDaysAt(two, 1)).toBe(45);
    expect(bucketForIdleWorkingDays(idleWorkingDaysAt(two, 1))).toBe('C');
  });
  it('composes the other way too: a SHORT idle stretch inside one month stays B (so the unit change is not "everything is C")', () => {
    // A joiner employed for 9 working days, idle on all of them.
    const months: IdleMonth[] = [{ employed: true, staffed: false, availableDays: 9 }];
    expect(bucketForIdleWorkingDays(idleWorkingDaysAt(months, 0))).toBe('B');
  });
});

describe('freeingUpNextMonth (mutually exclusive with a BENCH state this month, by construction)', () => {
  it('allocated this month, bench next month -> true (the ordinary signal)', () =>
    expect(freeingUpNextMonth(true, 'ALLOCATED', true, 'BENCH')).toBe(true));
  it('partial this month, bench next month -> STILL true (partial is not-yet-bench)', () =>
    expect(freeingUpNextMonth(true, 'PARTIAL', true, 'BENCH')).toBe(true));
  it('already bench this month -> false (nothing is "freeing up")', () =>
    expect(freeingUpNextMonth(true, 'BENCH', true, 'BENCH')).toBe(false));
  it('inactive next month (resource terminates) -> false, this is offboarding not reallocation (spec §5.2)', () =>
    expect(freeingUpNextMonth(true, 'ALLOCATED', false, undefined)).toBe(false));
  // The two tests below close a gap the four tests above leave open: in the
  // "inactive next month" test, stateNext is undefined, so the `stateNext ===
  // 'BENCH'` comparison alone already forces the result to false — that test
  // would still pass even if the `activeNext` guard were deleted entirely, and
  // likewise no existing test pins the `activeThis` guard in isolation. Each
  // test below pairs the guard-under-test with a CONTRADICTORY value for every
  // other input (state already BENCH-next, the other active-flag true) so the
  // only thing that can produce `false` is the guard itself.
  it('activeThis false blocks the signal even though state/activeNext alone would say true '
    + '(isolates the activeThis guard — deleting it from the implementation flips this to true)', () =>
    expect(freeingUpNextMonth(false, 'ALLOCATED', true, 'BENCH')).toBe(false));
  it('activeNext false blocks the signal even though stateNext is BENCH '
    + '(isolates the activeNext guard, independently of the state check — deleting it flips this to true)', () =>
    expect(freeingUpNextMonth(true, 'ALLOCATED', false, 'BENCH')).toBe(false));
  // Every `activeNext: true` case above pairs it with `stateNext: 'BENCH'` —
  // none of the six tests above independently prove the `stateNext ===
  // 'BENCH'` conjunct is doing anything: deleting it and collapsing the
  // function to `activeThis && stateThis !== 'BENCH' && activeNext` leaves
  // all six green. The two tests below plug that gap: activeNext is
  // genuinely true, but stateNext is a real, defined BenchState other than
  // 'BENCH' — the only way either can produce `false` is the state check.
  it('activeNext true but stateNext PARTIAL (not BENCH) -> false '
    + '(isolates the stateNext===BENCH conjunct with a genuine defined non-BENCH state, unlike the activeNext=false/stateNext=undefined '
    + 'case above — deleting the conjunct flips this to true)', () =>
    expect(freeingUpNextMonth(true, 'ALLOCATED', true, 'PARTIAL')).toBe(false));
  it('activeNext true but stateNext ALLOCATED (not BENCH) -> false (same isolation, the other non-BENCH state)', () =>
    expect(freeingUpNextMonth(true, 'ALLOCATED', true, 'ALLOCATED')).toBe(false));

  // H (spec §5.1 B5): BOTH directions of the fourth state, asserted rather than
  // deduced from the `=== 'BENCH'` / `!== 'BENCH'` tests. They point opposite ways
  // and both are wanted, so a future "simplification" that treats ABSENT like
  // BENCH on either side has to break one of them.
  it('going ON leave next month is NOT "freeing up" — a person who cannot be booked is not capacity coming free', () => {
    expect(freeingUpNextMonth(true, 'ALLOCATED', true, 'ABSENT')).toBe(false);
    // ABSENCE TWIN: with a BENCH next month the very same call reads true, so this
    // false is the ABSENT state and not some other guard firing.
    expect(freeingUpNextMonth(true, 'ALLOCATED', true, 'BENCH')).toBe(true);
  });
  it('RETURNING from leave into a bench month IS "freeing up" — wanted, not tolerated', () => {
    expect(freeingUpNextMonth(true, 'ABSENT', true, 'BENCH')).toBe(true);
    // ...and returning into an ALLOCATED month is not, so the signal is about the
    // month AFTER, not about having been away.
    expect(freeingUpNextMonth(true, 'ABSENT', true, 'ALLOCATED')).toBe(false);
  });
});

describe('availabilityDateFor (design spec §7 — three branches, in order)', () => {
  const state = (s: BenchState) => s;

  /**
   * THE SHAPE EVERY OTHER CASE IN THIS BLOCK MISSED, and the reason B6 shipped
   * broken while reading correct.
   *
   * The display window is anchored on the oldest Open planning period, so
   * `cells[0]` is routinely months BEFORE today. Every pre-existing case here
   * passes a `today` inside `cells[0]`'s own month — the single shape where
   * "is cells[0] bench?" and "is TODAY bench?" are the same question. These
   * cases separate them.
   */
  describe('today is NOT the first month of the window', () => {
    /** Marco Belli's shipped seed row: bench in spring, on leave Jun-Aug. */
    const marco = [
      { month: '2026-04', state: state('BENCH') },
      { month: '2026-05', state: state('BENCH') },
      { month: '2026-06', state: state('ABSENT') },
      { month: '2026-07', state: state('ABSENT') },
      { month: '2026-08', state: state('ABSENT') },
      { month: '2026-09', state: state('BENCH') },
    ];

    it('a person ON LEAVE TODAY is not "available today" because an EARLIER month was bench', () => {
      // Before the fix this answered { date: '2026-08-07' } — B6 verbatim, on a
      // man whose August is entirely parental leave.
      expect(availabilityDateFor(marco, '2026-08-07'))
        .toStrictEqual({ kind: 'date', date: '2026-09-01' });
    });

    it('ABSENCE TWIN: the same row, with today in a month that IS bench, still answers today', () => {
      // Without this, returning "the first bench month after today" ALWAYS would
      // pass the case above while breaking the ordinary answer.
      expect(availabilityDateFor(marco, '2026-05-12'))
        .toStrictEqual({ kind: 'date', date: '2026-05-12' });
    });

    it('never answers with a date in the PAST, even when the only bench month has gone', () => {
      const past = [
        { month: '2026-04', state: state('BENCH') },
        { month: '2026-05', state: state('ALLOCATED') },
        { month: '2026-06', state: state('ALLOCATED') },
      ];
      expect(availabilityDateFor(past, '2026-06-10'))
        .toStrictEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-06' });
    });

    it('a window entirely on leave from today onward is beyond-horizon, never an empty field', () => {
      const allLeave = [
        { month: '2026-04', state: state('BENCH') },
        { month: '2026-05', state: state('ABSENT') },
        { month: '2026-06', state: state('ABSENT') },
      ];
      expect(availabilityDateFor(allLeave, '2026-05-04'))
        .toStrictEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-06' });
    });
  });
  it('bench THIS month -> today, not the 1st of the month', () => {
    const cells = [{ month: '2026-04', state: state('BENCH') }, { month: '2026-05', state: state('ALLOCATED') }];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'date', date: '2026-04-17' });
  });
  it('bench a LATER shown month -> the 1st of the FIRST such month', () => {
    const cells = [
      { month: '2026-04', state: state('PARTIAL') },
      { month: '2026-05', state: state('BENCH') },
      { month: '2026-06', state: state('BENCH') },
    ];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'date', date: '2026-05-01' });
  });
  it('never bench in the shown window -> beyond-horizon on the LAST shown month', () => {
    const cells = [
      { month: '2026-04', state: state('ALLOCATED') },
      { month: '2026-05', state: state('ALLOCATED') },
    ];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-05' });
  });

  /**
   * H (spec §5.1 B6) — "the most user-visible falsehood: a table declaring
   * somebody on maternity leave available today". Both branches already test
   * `=== 'BENCH'`, so no line changed; these cases are what turn that from a
   * coincidence into a guarantee. The hazard they guard is the INVERSION: rewriting
   * either predicate to `!== 'ALLOCATED'` — the shape `notFullyAllocatedAt` uses —
   * starts answering "available today" for everyone on leave, and would leave every
   * other case in this describe green.
   */
  it('ABSENT in the first shown month -> NOT today; the date is the first genuinely bench month after it', () => {
    const cells = [
      { month: '2026-04', state: state('ABSENT') },
      { month: '2026-05', state: state('BENCH') },
    ];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'date', date: '2026-05-01' });
    // ABSENCE TWIN, and the exact figure a `!== 'ALLOCATED'` predicate returns:
    // "free from 17 April" about a person who is away for all of April.
    expect(availabilityDateFor(cells, '2026-04-17')).not.toEqual({ kind: 'date', date: '2026-04-17' });
    // PAIRED PRESENCE: flip that first cell to BENCH and today IS the answer, so
    // the skip above is the ABSENT state and not this function refusing month one.
    expect(availabilityDateFor([{ month: '2026-04', state: state('BENCH') }], '2026-04-17'))
      .toEqual({ kind: 'date', date: '2026-04-17' });
  });
  it('a LATER ABSENT month is skipped too, in favour of the next bench one', () => {
    const cells = [
      { month: '2026-04', state: state('ALLOCATED') },
      { month: '2026-05', state: state('ABSENT') },
      { month: '2026-06', state: state('BENCH') },
    ];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'date', date: '2026-06-01' });
    expect(availabilityDateFor(cells, '2026-04-17')).not.toEqual({ kind: 'date', date: '2026-05-01' });
  });
  it('ABSENT for the WHOLE window still yields an answer (beyond-horizon), never an empty field — block F rule §7', () => {
    const cells = [
      { month: '2026-04', state: state('ABSENT') },
      { month: '2026-05', state: state('ABSENT') },
      { month: '2026-06', state: state('ABSENT') },
    ];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-06' });
  });
});

import { resources, assignments, assignmentDays, assignmentMonths, holidays, resourceAbsences } from '../../db/seed';
import { benchRollup, hiringDemandByMonth, EMPTY_BENCH_ROLLUP, notFullyAllocatedAt, unallocatedHistoryFor, type BenchRollupInput } from './bench.util';
import type { AbsenceInterval } from './absence.util';
import { hoursByResourceMonth, rollupMonthly, standardMonthlyHours } from './capacity.util';

const HOURS_PER_DAY = 8;
/**
 * The seed's real holiday table, used by the seed-integration describe below
 * because that is what /bench actually renders for the shipped seed. It is NOT
 * holiday COVERAGE: every entry falls outside FETCH_MONTHS (see the tripwire in
 * the "threads `holidays`" describe), so this set cannot make the argument red at
 * any hop. Those hops have their own fixtures further down.
 */
const HOLIDAY_SET = new Set(holidays.map(h => h.id));
const FETCH_MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const DISPLAY_MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const TODAY = '2026-04-17';

/**
 * The seed's absence rows, REDACTED to what the arithmetic is allowed to see
 * (spec §3.4: `AbsenceInterval` cannot carry `reasonCode`, so the projection is
 * numerically complete by construction). Threading these is what `/bench/monthly`
 * does once T6 lands; every describe below states WHICH set it runs with, because
 * `[]` reproduces the pre-H numbers exactly and a suite that never says which one
 * it used is a suite that cannot show the field is read.
 */
const SEED_ABSENCES: readonly AbsenceInterval[] =
  resourceAbsences.map(a => ({ resourceId: a.resourceId, startDate: a.startDate, endDate: a.endDate }));

function rollup(absences: readonly AbsenceInterval[]) {
  const input: BenchRollupInput = {
    resources, assignments, assignmentDays, assignmentMonths,
    months: FETCH_MONTHS, displayMonths: DISPLAY_MONTHS,
    hoursPerDay: HOURS_PER_DAY, holidays: HOLIDAY_SET, absences,
  };
  return benchRollup(input, TODAY);
}

describe('EMPTY_BENCH_ROLLUP', () => {
  it('is the all-empty default a rxResource should show before authReady() settles', () => {
    expect(EMPTY_BENCH_ROLLUP).toEqual({ months: [], internalRows: [], subcoRows: [], hiringDemand: [] });
  });
});

describe('hiringDemandByMonth (design spec §6 — dummy-only, raw hours summed per role/month)', () => {
  const fixtureResources = [
    { id: 'd1', role: 'Developer', kind: 'dummy' },
    { id: 'd2', role: 'Developer', kind: 'dummy' },
    { id: 'd3', role: 'Consultant', kind: 'dummy' },
    { id: 'i1', role: 'Developer', kind: 'internal' },
    { id: 's1', role: 'Developer', kind: 'subco' },
  ];
  const fixtureHours = new Map([
    ['d1', new Map([['2026-05', { confirmed: 0, planned: 100 }]])],
    ['d2', new Map([['2026-05', { confirmed: 0, planned: 50 }]])],
    ['d3', new Map([['2026-05', { confirmed: 0, planned: 20 }]])],
    // Deliberately huge, so a wrong predicate that let these through would be obvious.
    ['i1', new Map([['2026-05', { confirmed: 0, planned: 999 }]])],
    ['s1', new Map([['2026-05', { confirmed: 0, planned: 999 }]])],
  ]);

  it('sums planned hours across dummies sharing a role in the same month, excluding internal/subco', () => {
    const rows = hiringDemandByMonth(fixtureResources, fixtureHours, ['2026-05']);
    const dev = rows.find(r => r.month === '2026-05' && r.role === 'Developer')!;
    expect(dev.hours).toBe(150); // d1(100) + d2(50) only — NOT i1's or s1's 999
    const total = rows.reduce((sum, r) => sum + r.hours, 0);
    expect(total).toBe(170); // 150 Developer + 20 Consultant; the two 999s never enter
  });
  it('a dummy with zero planned hours in a month contributes no row for that month (guards cell.planned <= 0)', () => {
    const map = new Map([['d1', new Map([['2026-06', { confirmed: 0, planned: 0 }]])]]);
    const rows = hiringDemandByMonth([{ id: 'd1', role: 'Developer', kind: 'dummy' }], map, ['2026-06']);
    expect(rows).toEqual([]);
  });
  it('a month outside the requested `months` list is never summed, even if the dummy has hours there', () => {
    const rows = hiringDemandByMonth(fixtureResources, fixtureHours, ['2026-06']); // fixtureHours only has 2026-05
    expect(rows).toEqual([]);
  });
  // The `/project-roles` catalog restricts `code`'s characters
  // (manage-project-roles.component.ts:93) but NOT `name`'s — only
  // `Validators.required` applies to the role name, both client-side and on
  // POST/PUT /project-roles (a bare `pick()`, server.ts:4025-4033). A role
  // named e.g. "Senior: Developer" is legal today. A `${month}:${role}`
  // joined-then-split key would misparse it: splitting on every colon turns
  // "2026-05:Senior: Developer" into three parts, so destructuring `[month,
  // role]` silently truncates the role to "Senior" and merges its hours with
  // an unrelated "Senior" role. This fixture pins that the aggregation keeps
  // the two roles distinct regardless of what characters either contains.
  it('a role name containing a colon is never truncated or merged with an unrelated role (would fail under a joined "${month}:${role}" key split on ":")', () => {
    const colonResources = [
      { id: 'd1', role: 'Senior: Developer', kind: 'dummy' },
      { id: 'd2', role: 'Senior', kind: 'dummy' },
    ];
    const colonHours = new Map([
      ['d1', new Map([['2026-05', { confirmed: 0, planned: 40 }]])],
      ['d2', new Map([['2026-05', { confirmed: 0, planned: 10 }]])],
    ]);
    const rows = hiringDemandByMonth(colonResources, colonHours, ['2026-05']);
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.role === 'Senior: Developer')?.hours).toBe(40);
    expect(rows.find(r => r.role === 'Senior')?.hours).toBe(10);
  });
});

describe('benchRollup — seed integration (design spec §11 fixture table, WITH the seed’s absence rows)', () => {
  const out = rollup(SEED_ABSENCES);

  it('resource 6 (subco): PARTIAL in April, then bench May-Jul, ABSENT in August, bench again in September', () => {
    const row = out.subcoRows.find(r => r.resourceId === '6')!;
    expect(row).toBeDefined();
    expect(row.monthly['2026-04'].state).toBe('PARTIAL');
    expect(row.monthly['2026-04'].agingBucket).toBeUndefined();
    expect(row.monthly['2026-04'].upcomingUnallocated).toBe(true); // May is BENCH
    // Paired absence: April's `upcomingUnallocated` is asserted true above;
    // May itself is ALREADY BENCH, so `freeingUpNextMonth` must read false
    // here (mutually exclusive with an aging bucket by construction, spec
    // §5.1/§5.2) — without this, a hard-coded `true` at the call site would
    // leave every assertion in this test green.
    expect(row.monthly['2026-05'].upcomingUnallocated).toBe(false);
    // The ladder is counted in idle WORKING DAYS now (product decision Q1), not in
    // whole BENCH months — but the LABELS still have to mean what the manual says,
    // so one full month is B and two are C whichever months they are. May (21 days,
    // its own first idle month) is B; June (21+22=43) is C, inside the two-month
    // ceiling of 46. Against the earlier floored-mean ceiling of 42 the same 43 days
    // read D, i.e. the calendar decided the label.
    expect(row.monthly['2026-05']).toMatchObject({ state: 'BENCH', agingBucket: 'B' });
    expect(row.monthly['2026-06']).toMatchObject({ state: 'BENCH', agingBucket: 'C' });
    expect(row.monthly['2026-07']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    // S4 — THE SUBCO CASE. August is covered end to end by absence AB1, so the
    // fourth state applies to subcontractors too: without this, /dashboard's
    // `subcoBenchCount` tile would stay false and green.
    expect(row.monthly['2026-08'].state).toBe('ABSENT');
    // ...and an ABSENT cell carries NO aging bucket and NO share (spec §5.1 B8):
    // being away is not a delivery idleness to age.
    expect(row.monthly['2026-08'].agingBucket).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(row.monthly['2026-08'], 'unallocatedPct')).toBe(false);
    // B5, in the seed rather than only in the unit tests: she RETURNS from leave
    // into a bench September, which genuinely is capacity to plan for.
    expect(row.monthly['2026-08'].upcomingUnallocated).toBe(true);
    expect(row.monthly['2026-09']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    // PAIRED ABSENCE-OF-CHANGE: the absence moved ONE month, not the row. Her
    // availability date is still the first bench month, untouched by August.
    expect(row.availabilityDate).toEqual({ kind: 'date', date: '2026-05-01' });
  });
  it('resource 6 is in subcoRows ONLY — the case that matters most (spec §11, commit 2cb462b regression class)', () => {
    expect(out.internalRows.some(r => r.resourceId === '6')).toBe(false);
  });

  it('resource 4 (dummy): drives hiringDemand for every one of the 6 months, role Developer, hours > 0', () => {
    for (const m of DISPLAY_MONTHS) {
      const row = out.hiringDemand.find(h => h.month === m && h.role === 'Developer');
      expect(row).toBeDefined();
      expect(row!.hours).toBeGreaterThan(0);
    }
  });
  // The test above alone has a blind spot: resource 7 (Priya, ALSO role
  // 'Developer', but kind 'internal', ALLOCATED every displayed month) would
  // satisfy "role Developer, hours > 0 in every month" all by itself even if
  // the dummy/kind filter in hiringDemandByMonth were flipped to admit
  // internal resources instead of dummy ones — found by mutation-testing this
  // exact swap (kindOf(r) !== 'dummy' -> kindOf(r) !== 'internal'), which left
  // the test above green. This test isolates resource 4's OWN contribution by
  // comparing hiringDemand's Developer-role total against a total computed
  // independently from `hoursByResourceMonth` restricted to resource '4' only
  // (the sole dummy with role Developer in this seed) — a mutation that
  // substitutes ANY other Developer-role resource's hours breaks the equality.
  it('the Developer-role hiringDemand total is driven EXACTLY by resource 4 alone, not by any internal Developer (isolates the dummy-kind filter from the "resource 4" test above)', () => {
    const hoursByResMonth = hoursByResourceMonth({ assignments, assignmentDays, assignmentMonths });
    for (const m of DISPLAY_MONTHS) {
      const expected = hoursByResMonth.get('4')?.get(m)?.planned ?? 0;
      expect(expected).toBeGreaterThan(0); // sanity: the independent computation itself is non-trivial
      const row = out.hiringDemand.find(h => h.month === m && h.role === 'Developer');
      expect(row!.hours).toBe(expected);
    }
  });
  it('resource 4 (dummy) NEVER appears in internalRows or subcoRows despite real booked hours', () => {
    expect(out.internalRows.some(r => r.resourceId === '4')).toBe(false);
    expect(out.subcoRows.some(r => r.resourceId === '4')).toBe(false);
  });

  it('resource 5 (dummy, untouched) contributes NO row to hiringDemand — meaningful because resource 4 (also a dummy) DOES', () => {
    // Not the "bench is empty" trap: with resource 4 already proven above to
    // populate hiringDemand for all 6 months, this suite's hiringDemand list is
    // provably non-empty by construction — so 5's absence here is a genuine
    // negative, not a pass for lack of data anywhere in this test.
    const resource5Role = resources.find(r => r.id === '5')!.role;
    const contributedByFive = out.hiringDemand.filter(h => h.role === resource5Role && DISPLAY_MONTHS.includes(h.month));
    expect(contributedByFive.length).toBe(0);
  });

  it('resource 7 (new internal): ALLOCATED every shown month, beyond-horizon availability, upcomingUnallocated ONLY via the look-ahead month', () => {
    const row = out.internalRows.find(r => r.resourceId === '7')!;
    expect(row).toBeDefined();
    expect(row.resourceName).toBe('Priya Kapoor'); // guards against a swapped field (e.g. id used where name belongs)
    for (const m of DISPLAY_MONTHS) expect(row.monthly[m].state).toBe('ALLOCATED');
    expect(row.availabilityDate).toEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-09' });
    expect(row.monthly['2026-09'].upcomingUnallocated).toBe(true);
    // Paired absence: September's flag above is true ONLY because of the
    // look-ahead month (October). August's next month (September) is still
    // ALLOCATED, so the signal must read false here — without this, a
    // hard-coded `true` at the call site would leave the test above green too.
    expect(row.monthly['2026-08'].upcomingUnallocated).toBe(false);
  });

  /**
   * S1 — THE HEADLINE CORRECTION (spec §8.3). Marco is the seed's pure bench case
   * (hired on the anchor month, never booked), so before H every one of April-
   * September counted him as idle delivery capacity. Parental leave AB2 covers
   * every working day of June, July and August.
   */
  it('resource 8 (the pure bench case, on parental leave Jun-Aug): three months LEAVE the bench, and May does not', () => {
    const row = out.internalRows.find(r => r.resourceId === '8')!;
    // THE MOVED BUCKETS: April is 22 idle working days — one calendar month, but
    // already past the 21-day B ceiling, so C. The look-back truncation still
    // holds and is the reason it is not D: February and March are before his hire.
    // One full month of idleness is B whichever month it is — April 2026 has 22
    // working days, and against the earlier ceiling of 21 it read C purely because
    // of the calendar.
    expect(row.monthly['2026-04']).toMatchObject({ state: 'BENCH', agingBucket: 'B' });
    expect(row.monthly['2026-04'].agingBucket).not.toBe('C');
    expect(row.monthly['2026-05']).toMatchObject({ state: 'BENCH', agingBucket: 'C' }); // 22 + 21 = 43
    expect(row.monthly['2026-06'].state).toBe('ABSENT');
    expect(row.monthly['2026-07'].state).toBe('ABSENT');
    expect(row.monthly['2026-08'].state).toBe('ABSENT');
    // PAIRED ABSENCE (spec §8.1, first row): MAY is still BENCH. The absence
    // changed THREE months, not the row — a fix that emptied the whole row would
    // satisfy every ABSENT assertion above and fail here.
    expect(row.monthly['2026-05'].state).toBe('BENCH');
    // Q1's decision, visible on the seed: September resumes the ladder at D
    // because the three absent months contributed ZERO idle days without breaking
    // the run (22 + 0 + 0 + 0 + 21 + 22 = 65). A policy that BROKE the streak
    // would read C here off September's own 22 days — a different label, not a
    // different shade of the same one.
    expect(row.monthly['2026-09']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-09'].agingBucket).not.toBe('C');
    // B5 again: he returns from leave into a bench September.
    expect(row.monthly['2026-08'].upcomingUnallocated).toBe(true);
  });

  it('resource 9 (terminated 2026-03-15) is absent from internalRows for ALL 6 shown months, despite real booked hours in the look-back', () => {
    expect(out.internalRows.some(r => r.resourceId === '9')).toBe(false);
  });

  it('sanity check (free, no new fixture needed): Julie/John/Alice are already BENCH in April 2026', () => {
    for (const id of ['1', '2', '3']) {
      const row = out.internalRows.find(r => r.resourceId === id)!;
      expect(row).toBeDefined();
      expect(row.monthly['2026-04'].state).toBe('BENCH');
    }
  });
});

// Neither seed fixture exercises a resource active for only PART of the
// display window: resource 8 is hired exactly on the anchor month (active
// every displayed month), and resource 9 is inactive for the whole window
// (caught by the outer `displayMonths.some(...)` guard before `monthly` is
// even built). A hire landing mid-quarter — an ordinary production case, not
// a contrived one — exercises the per-month `if (!activeOf.get(m)) continue;`
// guard (bench.util.ts) that must leave SOME display-month keys genuinely
// ABSENT from `monthly` rather than present with a placeholder/undefined
// state. Built as a standalone fixture here (not a new seed row) precisely so
// Task 1's verified seed is never perturbed.
describe('benchRollup — resource active for only part of the display window (hired mid-quarter)', () => {
  const midWindowResources = [
    { id: 'x1', name: 'Mid-Quarter Hire', role: 'Developer', kind: 'internal', hireDate: '2026-06-15' },
  ];
  const input: BenchRollupInput = {
    resources: midWindowResources,
    assignments: [], assignmentDays: [], assignmentMonths: [],
    months: FETCH_MONTHS, displayMonths: DISPLAY_MONTHS,
    hoursPerDay: HOURS_PER_DAY, holidays: HOLIDAY_SET,
  };
  const out = benchRollup(input, TODAY);
  const row = out.internalRows.find(r => r.resourceId === 'x1')!;

  it('is active from the HIRE MONTH onward, not from the month after it: the months before are genuinely ABSENT keys, not zeroed cells', () => {
    expect(row).toBeDefined();
    // hireDate 2026-06-15. THE MOVED NUMBER: '2026-06' used to be ABSENT here,
    // because the old gate (`isActiveInMonth`) compared hireDate with the month's
    // START — so /bench dropped the hire month outright while /capacity, already on
    // the day-granular gate, kept it. June 2026 has 12 working days on or after the
    // 15th, so she IS employed in June and the cell belongs to her.
    expect(row.monthly['2026-06']).toBeDefined();
    expect(Object.keys(row.monthly)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09']);
    // ABSENCE TWIN, and the reason `return true` cannot pass: April and May contain
    // NO working day she was employed on, so those keys must still be missing.
    expect(row.monthly['2026-04']).toBeUndefined();
    expect(row.monthly['2026-05']).toBeUndefined();
  });
  it('the present months classify correctly once active: BENCH throughout (no bookings), aging B/C/D counted from the HIRE month forward, never from the inactive months before it', () => {
    // THE MOVED NUMBERS: the aging ladder starts one month earlier now, because the
    // hire month is no longer discarded. B/C/D used to sit on Jul/Aug/Sep.
    expect(row.monthly['2026-06']).toMatchObject({ state: 'BENCH', agingBucket: 'B' });
    expect(row.monthly['2026-07']).toMatchObject({ state: 'BENCH', agingBucket: 'C' });
    expect(row.monthly['2026-08']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-09']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    // The look-back truncation still holds: June is bucket B, NOT D — the months
    // before the hire must not read as "idle since forever".
    expect(row.monthly['2026-06'].agingBucket).not.toBe('D');
  });
});

/**
 * /bench and /capacity are two renderings of the SAME employment fact, and they
 * used to answer it with two different predicates: `benchRollup` asked the coarse
 * `isActiveInMonth` (hireDate vs the month's START) while `rollupMonthly` asked
 * `employedWorkingDays` (the month's working days actually employed). A hire
 * landing on the 15th therefore HAD a /capacity cell carrying her booked hours and
 * NO /bench row at all — the same person, present on one screen and absent on the
 * other, over one endpoint's data.
 *
 * These cases pin the agreement itself rather than either screen's numbers, so the
 * two cannot drift apart again without something going red.
 */
describe('benchRollup agrees with rollupMonthly about WHICH months a person is employed in', () => {
  const MONTHS = ['2026-05', '2026-06', '2026-07'];
  const NO_HOL = new Set<string>();
  interface Employment { hireDate?: string; terminationDate?: string }
  interface Day { assignmentId: string; date: string; hours: number }

  function benchOf(employment: Employment, assignmentDays: Day[] = []) {
    const input: BenchRollupInput = {
      resources: [{ id: 'j', name: 'Joiner', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, ...employment }],
      assignments: [{ id: 'a1', resourceId: 'j' }],
      assignmentMonths: MONTHS.map(m => ({ assignmentId: 'a1', month: m, status: 'Allocated' })),
      assignmentDays,
      months: MONTHS, displayMonths: MONTHS, hoursPerDay: 8, holidays: NO_HOL,
    };
    return benchRollup(input, '2026-06-20');
  }

  /** The months `benchRollup` gave this resource a cell for. */
  function benchMonths(employment: Employment, assignmentDays: Day[] = []): string[] {
    const roll = benchOf(employment, assignmentDays);
    const row = [...roll.internalRows, ...roll.subcoRows].find(r => r.resourceId === 'j');
    return row ? Object.keys(row.monthly) : [];
  }

  /** The months `rollupMonthly` (the /capacity grid) gave the same resource a cell for. */
  function capacityMonths(employment: Employment, assignmentDays: Day[] = []): string[] {
    const roll = rollupMonthly({
      resources: [{ id: 'j', name: 'Joiner', contractHoursPerDay: 8, ...employment }],
      assignments: [{ id: 'a1', resourceId: 'j' }],
      assignmentMonths: MONTHS.map(m => ({ assignmentId: 'a1', month: m, status: 'Allocated' })),
      assignmentDays,
      months: MONTHS, hoursPerDay: 8, holidays: NO_HOL,
    });
    const row = roll.rows.find(r => r.resourceId === 'j');
    return row ? Object.keys(row.monthly) : [];
  }

  it('keeps a mid-month joiner’s HIRE MONTH on /bench, exactly as /capacity already did — and her booked hours decide the state', () => {
    // 2026-06-16 is a Tuesday; 8h booked on it, so June is a real, if tiny, booking.
    const hire: Employment = { hireDate: '2026-06-16' };
    const days: Day[] = [{ assignmentId: 'a1', date: '2026-06-16', hours: 8 }];
    expect(capacityMonths(hire, days)).toEqual(['2026-06', '2026-07']); // guard: the reference screen
    expect(benchMonths(hire, days)).toEqual(['2026-06', '2026-07']);
    expect(benchMonths(hire, days)).toEqual(capacityMonths(hire, days));
    // The row must exist AND the hire month must not be misread as idle: 8h of 176
    // is PARTIAL, never BENCH — a dropped row could not say either.
    const cell = benchOf(hire, days).internalRows[0].monthly['2026-06'];
    expect(cell.state).toBe('PARTIAL');
    expect(cell.state).not.toBe('BENCH');
  });

  it('still EXCLUDES the months on either side of employment, on both screens (so the fix is not "always active")', () => {
    // ABSENCE TWIN #1 — a hire after the window: no month at all, on either screen.
    expect(benchMonths({ hireDate: '2026-09-01' })).toEqual([]);
    expect(capacityMonths({ hireDate: '2026-09-01' })).toEqual([]);
    // ABSENCE TWIN #2 — terminated before the window: likewise none.
    expect(benchMonths({ terminationDate: '2026-04-30' })).toEqual([]);
    expect(capacityMonths({ terminationDate: '2026-04-30' })).toEqual([]);
    // ABSENCE TWIN #3 — a mid-window LEAVER keeps the termination month and loses
    // the ones after it, identically on both screens.
    expect(benchMonths({ terminationDate: '2026-06-16' })).toEqual(['2026-05', '2026-06']);
    expect(capacityMonths({ terminationDate: '2026-06-16' })).toEqual(['2026-05', '2026-06']);
  });
});

/**
 * THE `holidays` ARGUMENT WAS INERT IN THIS WHOLE FILE. `HOLIDAY_SET` is built from
 * the seed, whose only two holidays are 2026-01-01 and 2026-12-25 — both outside
 * FETCH_MONTHS — so every case above passes a set that can never remove a working
 * day from a month under test. Deleting `holidays` from either hop in
 * `benchRollup` left this file, capacity.util.spec.ts and bench.component.spec.ts
 * all GREEN while every /bench state and FTE figure silently ignored public
 * holidays.
 *
 * `benchRollup` threads `holidays` through TWO independent hops, so there is one
 * case per hop and each is red ONLY for its own hop — the shape
 * capacity.util.spec.ts landed for the same defect:
 *
 *   hop 1  `standardMonthlyHours(m, hoursPerDay, holidays)` → targetByMonth →
 *          `benchStateFor(planned, target)`: the PARTIAL/ALLOCATED boundary.
 *   hop 2  `employedWorkingDays(r, m, holidays)`: whether the person counts as
 *          employed in the month at all.
 *
 * Plus a WEEKEND-holiday twin, so no case can be satisfied by a blanket "subtract
 * 8 hours per listed holiday" that ignores which day it falls on.
 *
 * May 2026 arithmetic, all verified: 2026-05-01 is a Friday, so the month has 21
 * working days (168h at 8h/day); 2026-05-04 is a MONDAY (a real working day) and
 * 2026-05-03 a SUNDAY (already excluded); 2026-05-29 is the LAST working day of
 * the month (the 30th is a Saturday).
 */
describe('benchRollup threads `holidays` through BOTH of its hops (the seed set above is inert)', () => {
  const MONTH = '2026-05';
  const WORKDAY_HOLIDAY = new Set([`${MONTH}-04`]);   // Monday
  const WEEKEND_HOLIDAY = new Set([`${MONTH}-03`]);   // Sunday
  const NO_HOL = new Set<string>();

  it('the seed HOLIDAY_SET used above really is inert for the fetch window (a tripwire, not a claim about /bench)', () => {
    // If a seeded holiday ever lands inside FETCH_MONTHS this goes red — and the
    // §11 fixture expectations above, which are stated against a holiday-free
    // window, have to be revisited rather than silently shifted.
    expect([...HOLIDAY_SET].some(d => FETCH_MONTHS.includes(d.slice(0, 7)))).toBe(false);
    // And the month the hop cases below use is genuinely holiday-free in the seed,
    // so their 168h baseline is the seed's own arithmetic too.
    expect(HOLIDAY_SET.has(`${MONTH}-04`)).toBe(false);
  });

  function stateWith(holidaySet: ReadonlySet<string>, plannedHours: number) {
    const input: BenchRollupInput = {
      resources: [{ id: 'r', name: 'Booked', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 }],
      assignments: [{ id: 'a1', resourceId: 'r' }],
      assignmentMonths: [{ assignmentId: 'a1', month: MONTH, status: 'Allocated' }],
      assignmentDays: [{ assignmentId: 'a1', date: `${MONTH}-05`, hours: plannedHours }],
      months: [MONTH], displayMonths: [MONTH], hoursPerDay: 8, holidays: holidaySet,
    };
    return benchRollup(input, `${MONTH}-10`).internalRows[0].monthly[MONTH].state;
  }

  it('HOP 1 — a working-day holiday lowers the month target, so the same booked hours read ALLOCATED instead of PARTIAL', () => {
    // 160h booked. Derived from the OTHER input, never from the implementation's
    // own formula: 168h without the holiday, 160h with it.
    const noHolTarget = standardMonthlyHours(MONTH, 8, NO_HOL);
    const withHolTarget = standardMonthlyHours(MONTH, 8, WORKDAY_HOLIDAY);
    expect(noHolTarget).toBe(168);
    expect(withHolTarget).toBe(160);

    expect(stateWith(WORKDAY_HOLIDAY, 160)).toBe('ALLOCATED');
    // ABSENCE TWIN: PARTIAL is exactly what a dropped `holidays` at this hop
    // produces — a person who is fully booked for every day the company is open,
    // presented as having spare capacity.
    expect(stateWith(WORKDAY_HOLIDAY, 160)).not.toBe('PARTIAL');
    expect(stateWith(NO_HOL, 160)).toBe('PARTIAL'); // the no-holiday control
  });

  it('HOP 1, weekend twin — a holiday falling on a Sunday moves nothing (no working day to remove)', () => {
    // The direction that stops HOP 1 from being satisfied by "subtract 8 per
    // listed holiday" regardless of the day it lands on.
    expect(standardMonthlyHours(MONTH, 8, WEEKEND_HOLIDAY)).toBe(standardMonthlyHours(MONTH, 8, NO_HOL));
    expect(stateWith(WEEKEND_HOLIDAY, 160)).toBe('PARTIAL');
    expect(stateWith(WEEKEND_HOLIDAY, 160)).not.toBe('ALLOCATED');
  });

  function rowsWith(holidaySet: ReadonlySet<string>) {
    const input: BenchRollupInput = {
      // Hired on the month's LAST working day, so her whole employment inside the
      // month is that single day — and a holiday on it leaves her employed on none.
      resources: [{ id: 'late', name: 'Last-Day Hire', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: `${MONTH}-29` }],
      assignments: [], assignmentMonths: [], assignmentDays: [],
      months: [MONTH], displayMonths: [MONTH], hoursPerDay: 8, holidays: holidaySet,
    };
    return benchRollup(input, `${MONTH}-10`).internalRows.map(r => r.resourceId);
  }

  it('HOP 2 — a holiday on the only working day a person was employed removes the row (employedWorkingDays sees the same calendar)', () => {
    // The server refuses a booking on a holiday, so a row asserting the person is
    // "on bench" for a month she could not have worked at all is a phantom.
    expect(rowsWith(new Set([`${MONTH}-29`]))).toEqual([]);
    // ABSENCE TWIN: without the holiday she IS employed that day and must keep her
    // row — so the fix cannot be "drop anyone hired late in the month".
    expect(rowsWith(NO_HOL)).toEqual(['late']);
    // And this hop is independent of hop 1: a holiday elsewhere in the month lowers
    // the target but leaves her own employed day intact.
    expect(rowsWith(WORKDAY_HOLIDAY)).toEqual(['late']);
  });
});

/**
 * `benchRollup` must actually PUT the share on the cell, with the pro-rated
 * denominator — the hop between `unallocatedShare` (unit-tested above on numbers it
 * is handed) and the wire shape a screen renders.
 *
 * The fixture deliberately spans all four outcomes at once, because a suite where
 * every resource is idle (or every resource is booked) proves nothing about a
 * percentage: one FULLY allocated (0%), one partial at a NON-trivial share that is
 * not its own complement (75%, so an inversion reads 25% and goes red), one
 * completely idle (100%), and one with no answer at all (absent, not 0).
 *
 * May 2026 arithmetic, matching the holiday describe above: 21 working days, so
 * 168h at 8h/day and no seeded holiday in the month.
 */
describe('benchRollup puts the unallocated share on every cell, against the RESOURCE’s own target', () => {
  const MONTH = '2026-05';
  const NO_HOL = new Set<string>();
  const WORKDAY = `${MONTH}-05`; // a Tuesday

  const input: BenchRollupInput = {
    resources: [
      { id: 'full', name: 'Fully Booked', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      { id: 'part', name: 'Quarter Booked', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      { id: 'idle', name: 'Never Booked', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      // Part-timer, fully booked on HER OWN contract: 4h × 21 days = 84h.
      { id: 'halftime', name: 'Half Time', role: 'Developer', kind: 'internal', contractHoursPerDay: 4 },
      // No contracted hours at all -> no own target -> no answer.
      { id: 'nocontract', name: 'No Contract Hours', role: 'Developer', kind: 'internal', contractHoursPerDay: 0 },
    ],
    assignments: [
      { id: 'aFull', resourceId: 'full' },
      { id: 'aPart', resourceId: 'part' },
      { id: 'aHalf', resourceId: 'halftime' },
    ],
    assignmentMonths: [
      { assignmentId: 'aFull', month: MONTH, status: 'Allocated' },
      { assignmentId: 'aPart', month: MONTH, status: 'Allocated' },
      { assignmentId: 'aHalf', month: MONTH, status: 'Allocated' },
    ],
    assignmentDays: [
      { assignmentId: 'aFull', date: WORKDAY, hours: 168 },  // exactly the 168h month
      { assignmentId: 'aPart', date: WORKDAY, hours: 42 },   // a quarter of it -> 75% unallocated
      { assignmentId: 'aHalf', date: WORKDAY, hours: 84 },   // exactly HER 84h month
    ],
    months: [MONTH], displayMonths: [MONTH], hoursPerDay: 8, holidays: NO_HOL,
  };
  const rows = new Map(benchRollup(input, `${MONTH}-10`).internalRows.map(r => [r.resourceId, r]));
  const cell = (id: string) => rows.get(id)!.monthly[MONTH];

  it('the fixture itself spans a real range, so no assertion below can pass for lack of data', () => {
    // Guard on the FIXTURE, not the implementation: 168h is the month, and the
    // five rows really are all present.
    expect(standardMonthlyHours(MONTH, 8, NO_HOL)).toBe(168);
    expect([...rows.keys()].sort()).toStrictEqual(['full', 'halftime', 'idle', 'nocontract', 'part']);
  });

  it('a fully-booked resource is 0% unallocated with 0 days', () => {
    expect(cell('full').unallocatedPct).toBe(0);
    expect(cell('full').unallocatedDays).toBe(0);
    expect(cell('full').state).toBe('ALLOCATED');
  });

  it('a quarter-booked resource is 75% unallocated (NOT the 25% an inverted complement gives), 15.75 days', () => {
    expect(cell('part').unallocatedPct).toBe(75);
    expect(cell('part').unallocatedDays).toBe(15.75);
    expect(cell('part').unallocatedPct).not.toBe(25);
    expect(cell('part').state).toBe('PARTIAL');
  });

  it('a never-booked resource is 100% unallocated across all 21 working days', () => {
    expect(cell('idle').unallocatedPct).toBe(100);
    expect(cell('idle').unallocatedDays).toBe(21);
    expect(cell('idle').state).toBe('BENCH');
  });

  /**
   * THE DIVERGENCE, pinned rather than left to be rediscovered as a bug: `state`
   * is decided against the company STANDARD month while the share is decided
   * against the resource's OWN target, so a fully-booked part-timer is legitimately
   * 'PARTIAL' at 0% unallocated. Whoever changes either denominator has to come
   * here and decide on purpose.
   */
  it('a fully-booked PART-TIMER: 0% unallocated even though her state is PARTIAL against the standard month', () => {
    expect(cell('halftime').unallocatedPct).toBe(0);
    expect(cell('halftime').unallocatedDays).toBe(0);
    expect(cell('halftime').state).toBe('PARTIAL');
    // ABSENCE TWIN: 50% is what the standard-month denominator produces here — the
    // figure that sends a planner looking for half a week she is not contracted for.
    expect(cell('halftime').unallocatedPct).not.toBe(50);
  });

  it('a resource with no contracted hours gets NO share keys at all — absent, never 0', () => {
    // The row and the state still exist: this is "no answer to the share question",
    // not "no data about the person".
    expect(cell('nocontract').state).toBe('BENCH');
    expect(cell('nocontract').unallocatedPct).toBeUndefined();
    expect(cell('nocontract').unallocatedDays).toBeUndefined();
    // ...and the keys are genuinely ABSENT, not present-and-undefined, so the shape
    // matches what survives the JSON round-trip to the browser.
    expect(Object.prototype.hasOwnProperty.call(cell('nocontract'), 'unallocatedPct')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cell('nocontract'), 'unallocatedDays')).toBe(false);
    // PAIRED PRESENCE: the same assertion is false for a resource that HAS an
    // answer, so "absent" is not simply how this rollup treats every row.
    expect(Object.prototype.hasOwnProperty.call(cell('idle'), 'unallocatedPct')).toBe(true);
  });

  it('a working-day holiday lowers the OWN target too, so the same booking reads as less unallocated', () => {
    // The share's denominator threads `holidays` through `employedWorkingDays`, a
    // third hop past the two the describe above pins. 2026-05-04 is a Monday: 20
    // working days instead of 21, so 'part' has a 160h target and 42h booked ->
    // 118h idle = 73.75%, against 75% with the full calendar.
    const withHoliday = benchRollup({ ...input, holidays: new Set([`${MONTH}-04`]) }, `${MONTH}-10`);
    const partCell = withHoliday.internalRows.find(r => r.resourceId === 'part')!.monthly[MONTH];
    expect(partCell.unallocatedPct).toBeCloseTo(73.75, 10);
    // ABSENCE TWIN: 75% is exactly what a dropped holiday set produces here.
    expect(partCell.unallocatedPct).not.toBe(75);
    expect(withHoliday.internalRows.find(r => r.resourceId === 'idle')!.monthly[MONTH].unallocatedDays).toBe(20);
  });
});

/**
 * The per-resource history (RPT comparison row 51) — an ORDERED, backward-looking
 * list for one row, derived by running `benchRollup` over that resource alone.
 *
 * `h1` is hired 2026-04-01, so March is genuinely outside her employment: that is
 * the absence case, and it must stay an ABSENT entry rather than a 0-day row.
 */
describe('unallocatedHistoryFor', () => {
  const DISPLAY = ['2026-03', '2026-04', '2026-05'];
  const FETCH = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const NO_HOL = new Set<string>();

  const input: BenchRollupInput = {
    resources: [
      { id: 'h1', name: 'History Person', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: '2026-04-01' },
      // A second, BUSIER resource whose months must never leak into h1's history.
      { id: 'other', name: 'Other Person', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      // A dummy placeholder: excluded from the bench rollup by design, so its
      // history is empty rather than an error.
      { id: 'dummy1', name: 'Open Position', role: 'Developer', kind: 'dummy', contractHoursPerDay: 8 },
    ],
    assignments: [{ id: 'aH', resourceId: 'h1' }, { id: 'aO', resourceId: 'other' }, { id: 'aD', resourceId: 'dummy1' }],
    assignmentMonths: FETCH.flatMap(month => [
      { assignmentId: 'aH', month, status: 'Allocated' },
      { assignmentId: 'aO', month, status: 'Allocated' },
      { assignmentId: 'aD', month, status: 'Allocated' },
    ]),
    assignmentDays: [
      // h1: nothing in April (100% idle), 42h of 168 in May (75% idle).
      { assignmentId: 'aH', date: '2026-05-05', hours: 42 },
      // other: booked solid every month, so any leak shows up as a 0% month.
      ...FETCH.map(m => ({ assignmentId: 'aO', date: `${m}-05`, hours: 999 })),
      { assignmentId: 'aD', date: '2026-04-07', hours: 80 },
    ],
    months: FETCH, displayMonths: DISPLAY, hoursPerDay: 8, holidays: NO_HOL,
  };

  it('returns the employed months OLDEST-FIRST with the share and the aging bucket, and NOTHING for the month before the hire', () => {
    // April 2026 = 22 working days -> a 176h target, none booked: 100%, 22 days.
    // May 2026 = 21 working days -> 168h, 42h booked: 75%, 15.75 days.
    // `toStrictEqual` on the WHOLE array is the load-bearing choice here: it pins
    // the order, pins that March is absent rather than zeroed, pins that the May
    // cell carries NO `agingBucket` key, and pins that `upcomingUnallocated` is
    // not carried at all — even though the underlying BenchCell has it set (June
    // is bench for her, so May's forward flag is genuinely true upstream).
    // THE MOVED BUCKET (H, Q1): April's 22 idle WORKING DAYS are one day past the
    // B ceiling of 21, so C where the month count said B.
    expect(unallocatedHistoryFor(input, 'h1', '2026-05-10')).toStrictEqual([
      { month: '2026-04', state: 'BENCH', agingBucket: 'B', unallocatedPct: 100, unallocatedDays: 22 },
      { month: '2026-05', state: 'PARTIAL', unallocatedPct: 75, unallocatedDays: 15.75 },
    ]);
  });

  it('the upstream cell really does carry `upcomingUnallocated` — so the assertion above proves the history DROPS it, rather than there being nothing to drop', () => {
    const roll = benchRollup(input, '2026-05-10');
    expect(roll.internalRows.find(r => r.resourceId === 'h1')!.monthly['2026-05'].upcomingUnallocated).toBe(true);
  });

  it('an unknown resource id -> an empty history, not a throw and not another resource’s months', () => {
    expect(unallocatedHistoryFor(input, 'nobody', '2026-05-10')).toStrictEqual([]);
  });

  it('a DUMMY placeholder -> an empty history (excluded from the rollup by design), never a fabricated "fully allocated" run', () => {
    // Paired against the presence case above: h1 provably yields two cells from the
    // very same input, so this emptiness is a genuine negative.
    expect(unallocatedHistoryFor(input, 'dummy1', '2026-05-10')).toStrictEqual([]);
    expect(unallocatedHistoryFor(input, 'h1', '2026-05-10').length).toBe(2);
  });

  it('never mixes in another resource’s months: the busy resource has its OWN history, all 0%', () => {
    const other = unallocatedHistoryFor(input, 'other', '2026-05-10');
    expect(other.map(c => c.month)).toStrictEqual(DISPLAY);       // employed throughout, so all three
    expect(other.every(c => c.unallocatedPct === 0)).toBe(true);  // booked solid
    // ...and h1's own history is unchanged by that resource's existence.
    expect(unallocatedHistoryFor(input, 'h1', '2026-05-10').map(c => c.month)).toStrictEqual(['2026-04', '2026-05']);
  });

  it('honours the requested display window: a single-month window returns exactly that month', () => {
    const narrow = unallocatedHistoryFor({ ...input, displayMonths: ['2026-05'] }, 'h1', '2026-05-10');
    expect(narrow.map(c => c.month)).toStrictEqual(['2026-05']);
  });
});

describe('notFullyAllocatedAt (the /forecast + /what-if single-month wrapper around benchRollup)', () => {
  const BASE = {
    resources: [
      { id: 'full', name: 'Full', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      { id: 'idle', name: 'Idle', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      { id: 'away', name: 'Away', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
    ],
    assignments: [{ id: 'a1', resourceId: 'full' }],
    assignmentDays: [{ assignmentId: 'a1', date: '2026-05-04', hours: 168 }],
    assignmentMonths: [{ assignmentId: 'a1', month: '2026-05', status: 'Allocated' }],
    hoursPerDay: 8,
    holidays: new Set<string>(),
  };

  it('excludes an ALLOCATED resource and includes a BENCH one, at the given month', () => {
    const out = notFullyAllocatedAt(BASE, '2026-05', '2026-05-10');
    expect(out.some(r => r.resourceId === 'full')).toBe(false);
    expect(out.some(r => r.resourceId === 'idle')).toBe(true);
  });

  /**
   * H (spec §5.1 B12) — THE ONE FILTER A FOURTH STATE MAKES WORSE. The predicate
   * is `!== 'ALLOCATED'`, so `'ABSENT'` joins it for free and this panel, headed
   * "available for reallocation", would list people on parental leave. The
   * exclusion is asserted TOGETHER with its presence twin on the SAME fixture,
   * because a function that returned `[]` for everything would satisfy the
   * exclusion alone.
   */
  it('excludes an ABSENT resource while still including a BENCH one — same fixture, one call', () => {
    const away: readonly AbsenceInterval[] = [{ resourceId: 'away', startDate: '2026-05-01', endDate: '2026-05-31' }];
    const out = notFullyAllocatedAt({ ...BASE, absences: away }, '2026-05', '2026-05-10');
    const ids = out.map(r => r.resourceId).sort();
    // ABSENCE and PRESENCE in one assertion: 'away' gone, 'idle' still there,
    // 'full' still excluded for the reason it always was.
    expect(ids).toStrictEqual(['idle']);
  });
  it('DIFFERENTIAL: the same person is listed with `absences: []` and gone with the absence row', () => {
    const away: readonly AbsenceInterval[] = [{ resourceId: 'away', startDate: '2026-05-01', endDate: '2026-05-31' }];
    const without = notFullyAllocatedAt({ ...BASE, absences: [] }, '2026-05', '2026-05-10').map(r => r.resourceId).sort();
    const with_ = notFullyAllocatedAt({ ...BASE, absences: away }, '2026-05', '2026-05-10').map(r => r.resourceId).sort();
    expect(without).toStrictEqual(['away', 'idle']);
    expect(with_).toStrictEqual(['idle']);
    expect(with_).not.toStrictEqual(without);
  });
  it('a PARTLY-absent person stays listed — she is genuinely reallocatable for the days she is there', () => {
    // Five working days of May off; still 16 available and nothing booked.
    const partly: readonly AbsenceInterval[] = [{ resourceId: 'away', startDate: '2026-05-11', endDate: '2026-05-15' }];
    const out = notFullyAllocatedAt({ ...BASE, absences: partly }, '2026-05', '2026-05-10');
    expect(out.map(r => r.resourceId).sort()).toStrictEqual(['away', 'idle']);
  });
});

// ---------------------------------------------------------------------------
// BLOCK H / T4 — the fourth state, end to end.
//
// `absences` is OPTIONAL with an empty default, so every fixture above is still
// green while exercising not one new line: the ONLY thing that can show the field
// is read is a DIFFERENTIAL — the same input twice, asserted to disagree. The
// four differentials the design names are all here, on the shipped seed:
// the STATE, the AGING BUCKET, `availabilityDate`, and `notFullyAllocatedAt`.
// ---------------------------------------------------------------------------

describe('benchRollup — H differential on the SHIPPED SEED (`absences: []` vs the seed’s rows)', () => {
  const before = rollup([]);            // the pre-H arithmetic, exactly
  const after = rollup(SEED_ABSENCES);  // what /bench renders once T6 threads them

  const rowOf = (roll: ReturnType<typeof rollup>, id: string) =>
    [...roll.internalRows, ...roll.subcoRows].find(r => r.resourceId === id)!;

  /**
   * S10 (spec §8.3) — THE SEED-LEVEL ASSERTION. Every other case in this file
   * builds its own inline fixture, so deleting `seed.resourceAbsences` would leave
   * them all green and the feature invisible on first boot. This is the one case
   * that goes red for that.
   */
  it('the seed really ships absence rows, and at least one produces an ABSENT cell in the DEFAULT /bench window', () => {
    expect(SEED_ABSENCES.length).toBeGreaterThan(0);
    const absentCells = [...after.internalRows, ...after.subcoRows]
      .flatMap(r => DISPLAY_MONTHS.map(m => ({ id: r.resourceId, month: m, state: r.monthly[m]?.state })))
      .filter(c => c.state === 'ABSENT');
    expect(absentCells.length).toBeGreaterThan(0);
    // ...on BOTH sides of the internal/subco split, because the two feed different
    // tiles (`internalBenchCount` and `subcoBenchCount`) and one of them staying
    // false would be invisible.
    expect(after.internalRows.some(r => DISPLAY_MONTHS.some(m => r.monthly[m]?.state === 'ABSENT'))).toBe(true);
    expect(after.subcoRows.some(r => DISPLAY_MONTHS.some(m => r.monthly[m]?.state === 'ABSENT'))).toBe(true);
    // PAIRED ABSENCE: with no rows threaded there is not one ABSENT cell anywhere,
    // so the cells above come from the DATA and not from the code inventing them.
    expect([...before.internalRows, ...before.subcoRows]
      .some(r => DISPLAY_MONTHS.some(m => r.monthly[m]?.state === 'ABSENT'))).toBe(false);
  });

  it('DIFFERENTIAL 1 — the STATE: Marco’s Jun/Jul/Aug go BENCH -> ABSENT, and his May stays BENCH in both', () => {
    const b = rowOf(before, '8');
    const a = rowOf(after, '8');
    expect(['2026-06', '2026-07', '2026-08'].map(m => b.monthly[m].state)).toStrictEqual(['BENCH', 'BENCH', 'BENCH']);
    expect(['2026-06', '2026-07', '2026-08'].map(m => a.monthly[m].state)).toStrictEqual(['ABSENT', 'ABSENT', 'ABSENT']);
    // The absence-of-change twin, on the same two rollups: the months outside the
    // interval are byte-identical.
    for (const m of ['2026-04', '2026-05', '2026-09']) {
      expect(a.monthly[m]).toStrictEqual(b.monthly[m]);
    }
  });

  it('DIFFERENTIAL 2 — the AGING BUCKET: an ABSENT month loses its bucket AND its unallocated share', () => {
    const b = rowOf(before, '8').monthly['2026-07'];
    const a = rowOf(after, '8').monthly['2026-07'];
    // Before: a full month of "idle" with 23 disallocated days billed to nobody.
    expect(b).toMatchObject({ state: 'BENCH', agingBucket: 'D', unallocatedPct: 100, unallocatedDays: 23 });
    // After: no bucket, and no share at all — "how much of her staffable month is
    // unfilled" has no answer when none of it was staffable. Keys ABSENT, not 0.
    expect(a).toStrictEqual({ state: 'ABSENT', upcomingUnallocated: false });
    expect(Object.prototype.hasOwnProperty.call(a, 'unallocatedDays')).toBe(false);
  });

  it('DIFFERENTIAL 3 — the subco side moves too, and ONLY in the month its own absence covers', () => {
    const b = rowOf(before, '6');
    const a = rowOf(after, '6');
    expect(b.monthly['2026-08']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(a.monthly['2026-08'].state).toBe('ABSENT');
    // June and July are the internal-only months (AB2 vs AB1 sit in different
    // months on purpose), so the two tiles are distinguishable rather than one
    // pass/fail: resource 6 is unchanged there.
    for (const m of ['2026-06', '2026-07']) expect(a.monthly[m]).toStrictEqual(b.monthly[m]);
  });

  it('DIFFERENTIAL 4 — notFullyAllocatedAt: the reallocatable list shrinks by exactly the people on leave', () => {
    const base = {
      resources, assignments, assignmentDays, assignmentMonths,
      hoursPerDay: HOURS_PER_DAY, holidays: HOLIDAY_SET,
    };
    const ids = (absences: readonly AbsenceInterval[], month: string) =>
      notFullyAllocatedAt({ ...base, absences }, month, TODAY).map(r => r.resourceId).sort();

    // JUNE: Marco (internal, on leave) drops out; the subco is still BENCH and
    // stays — the presence twin that stops "returns nothing" from passing.
    expect(ids([], '2026-06')).toStrictEqual(['1', '13', '2', '3', '6', '8']);
    expect(ids(SEED_ABSENCES, '2026-06')).toStrictEqual(['1', '13', '2', '3', '6']);
    // AUGUST: both absences bite, so BOTH drop out — and four people remain.
    expect(ids([], '2026-08')).toStrictEqual(['1', '13', '2', '3', '6', '8']);
    expect(ids(SEED_ABSENCES, '2026-08')).toStrictEqual(['1', '13', '2', '3']);
    // SEPTEMBER: no absence covers it, so the list is identical in both runs —
    // the correction is scoped to the intervals, not to the people.
    expect(ids(SEED_ABSENCES, '2026-09')).toStrictEqual(ids([], '2026-09'));
  });

  it('the rows and the people who have no absence row are untouched, to the digit', () => {
    // Julie/John/Alice/Priya/Nora/Sofia have no interval inside the shown window
    // (Sofia's May absence is partial and she is over-booked, so even her cell
    // cannot move) — the regression control without which "we corrected the
    // metric" proves nothing.
    for (const id of ['1', '2', '3', '7', '13', '14']) {
      expect(rowOf(after, id)).toStrictEqual(rowOf(before, id));
    }
    // And nobody appears or disappears: same row sets, same order.
    expect(after.internalRows.map(r => r.resourceId)).toStrictEqual(before.internalRows.map(r => r.resourceId));
    expect(after.subcoRows.map(r => r.resourceId)).toStrictEqual(before.subcoRows.map(r => r.resourceId));
    expect(after.hiringDemand).toStrictEqual(before.hiringDemand); // B7: a dummy has no absences
  });
});

/**
 * THE PRO-RATED TARGET (spec §4.4), on a fixture built so each of the three
 * plausible answers is a DIFFERENT number. May 2026 has 21 working days = 168h at
 * 8h/day; the absence covers 2026-05-11..15, five real working days (the 11th is a
 * Monday), leaving 16 available and a 128h target.
 *
 * The seed cannot carry this case: Sofia is the seed's partly-absent person and she
 * is over-booked, so her state and her share are the same with and without the
 * absence. That is worth knowing — and it is asserted in the differential suite
 * above — but it exercises none of the arithmetic below, which is exactly the shape
 * of a blind gate.
 */
describe('benchRollup — the pro-rated target on a PARTLY-absent month', () => {
  const MONTH = '2026-05';
  const NO_HOL = new Set<string>();
  const WORKDAY = `${MONTH}-05`; // a Tuesday, outside the absence interval
  const FIVE_DAYS_OFF = (id: string): AbsenceInterval =>
    ({ resourceId: id, startDate: `${MONTH}-11`, endDate: `${MONTH}-15` });

  const input: BenchRollupInput = {
    resources: [
      // 130h booked: below the whole month (168h), at or above the staffable slice (128h).
      { id: 'flip', name: 'Flips To Allocated', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      // 100h booked: below BOTH targets, so only the SHARE can move.
      { id: 'stays', name: 'Stays Partial', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      // Part-timer booked to her own available month: 16 days x 4h = 64h.
      { id: 'halftime', name: 'Half Time', role: 'Developer', kind: 'internal', contractHoursPerDay: 4 },
      // Nothing booked: BENCH either way, so only the DAY COUNT can move.
      { id: 'idlepart', name: 'Idle And Partly Away', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
    ],
    assignments: [
      { id: 'aFlip', resourceId: 'flip' }, { id: 'aStays', resourceId: 'stays' }, { id: 'aHalf', resourceId: 'halftime' },
    ],
    assignmentMonths: [
      { assignmentId: 'aFlip', month: MONTH, status: 'Allocated' },
      { assignmentId: 'aStays', month: MONTH, status: 'Allocated' },
      { assignmentId: 'aHalf', month: MONTH, status: 'Allocated' },
    ],
    assignmentDays: [
      { assignmentId: 'aFlip', date: WORKDAY, hours: 130 },
      { assignmentId: 'aStays', date: WORKDAY, hours: 100 },
      { assignmentId: 'aHalf', date: WORKDAY, hours: 64 },
    ],
    months: [MONTH], displayMonths: [MONTH], hoursPerDay: 8, holidays: NO_HOL,
  };
  const ABSENT_FIVE: readonly AbsenceInterval[] =
    ['flip', 'stays', 'halftime', 'idlepart'].map(FIVE_DAYS_OFF);

  const cellsOf = (absences: readonly AbsenceInterval[]) =>
    new Map(benchRollup({ ...input, absences }, `${MONTH}-06`).internalRows.map(r => [r.resourceId, r.monthly[MONTH]]));
  const before = cellsOf([]);
  const after = cellsOf(ABSENT_FIVE);

  it('the fixture’s own arithmetic: 21 working days, 168h, and the five absent days really are working days', () => {
    // Guards on the FIXTURE, not the implementation, so no assertion below can pass
    // for lack of days to remove.
    expect(standardMonthlyHours(MONTH, 8, NO_HOL)).toBe(168);
    expect([...before.keys()].sort()).toStrictEqual(['flip', 'halftime', 'idlepart', 'stays']);
    // 21 available days become 16: proved through the day count this rollup reports
    // for the resource with nothing booked (100% of her target is idle either way).
    expect(before.get('idlepart')!.unallocatedDays).toBe(21);
    expect(after.get('idlepart')!.unallocatedDays).toBe(16);
  });

  it('THE HEADLINE: booked solid for the days she is there reads ALLOCATED, not PARTIAL (§1.2)', () => {
    expect(before.get('flip')!.state).toBe('PARTIAL');
    expect(after.get('flip')!.state).toBe('ALLOCATED');
    // ...and the share follows: 22.62% of a whole month unfilled becomes 0%.
    expect(before.get('flip')!.unallocatedPct).toBeCloseTo((38 / 168) * 100, 10);
    expect(after.get('flip')!.unallocatedPct).toBe(0);
    expect(after.get('flip')!.unallocatedDays).toBe(0);
  });

  it('a genuinely under-booked person stays PARTIAL, but her IDLE DAYS drop to the ones she was actually there for', () => {
    expect(before.get('stays')!.state).toBe('PARTIAL');
    expect(after.get('stays')!.state).toBe('PARTIAL');   // the state must NOT move here
    expect(before.get('stays')!.unallocatedPct).toBeCloseTo((68 / 168) * 100, 10); // 40.48%
    expect(after.get('stays')!.unallocatedPct).toBe(21.875);                        // 28h of 128h
    expect(before.get('stays')!.unallocatedDays).toBe(8.5);
    expect(after.get('stays')!.unallocatedDays).toBe(3.5);
    // ABSENCE TWIN: 8.5 is what counting EMPLOYED days gives, i.e. five days a
    // planner is told to fill on somebody who is on holiday.
    expect(after.get('stays')!.unallocatedDays).not.toBe(8.5);
  });

  it('a BENCH month stays BENCH and keeps 100%, but over FEWER days — absent days are not idle days', () => {
    expect(after.get('idlepart')!.state).toBe('BENCH');
    expect(after.get('idlepart')!.unallocatedPct).toBe(100);
    expect(after.get('idlepart')!.unallocatedDays).toBe(16);
    expect(after.get('idlepart')!.unallocatedDays).not.toBe(21);
  });

  /**
   * The part-timer divergence, now UNDER AN ABSENCE. The state's target deducts
   * absent days at the COMPANY rate (T3's convention, shared with
   * `rollupMonthly`), the share's at HER OWN — so a part-timer booked to her exact
   * available month is 0% unallocated while still reading PARTIAL against the
   * standard month. Whoever changes either denominator has to come here and decide.
   */
  it('a fully-booked PART-TIMER with an absence: 0% unallocated, state still PARTIAL', () => {
    expect(before.get('halftime')!.state).toBe('PARTIAL');
    expect(before.get('halftime')!.unallocatedPct).toBeCloseTo((20 / 84) * 100, 10); // 23.81%
    expect(after.get('halftime')!.state).toBe('PARTIAL');
    expect(after.get('halftime')!.unallocatedPct).toBe(0);
    expect(after.get('halftime')!.unallocatedDays).toBe(0);
  });

  /**
   * The state's denominator is the SAME number `rollupMonthly` gives its own cell,
   * which is why the two screens cannot disagree about one person-month. Pinned by
   * reading /capacity's `targetHours` directly rather than by restating 128.
   */
  it('/bench’s pro-rated target IS /capacity’s cell target — one number, two screens', () => {
    const cap = rollupMonthly({
      resources: input.resources, assignments: input.assignments,
      assignmentDays: input.assignmentDays, assignmentMonths: input.assignmentMonths,
      months: [MONTH], hoursPerDay: 8, holidays: NO_HOL, absences: ABSENT_FIVE,
    });
    const capCell = cap.rows.find(r => r.resourceId === 'flip')!.monthly[MONTH];
    expect(capCell.targetHours).toBe(128);
    // /bench says ALLOCATED for 130h; /capacity says past 100% of the SAME target.
    expect(after.get('flip')!.state).toBe('ALLOCATED');
    expect(capCell.ftePlanned).toBeCloseTo(130 / 128, 10);
    expect(capCell.ftePlanned).toBeGreaterThan(1);
    // 101.56% is inside the `healthy` band (its ceiling is 105), so this is NOT the
    // `over` case — stated because "the state flipped to ALLOCATED" and "the
    // semaphore turned red" are different claims and only the first is true here.
    expect(capCell.band).toBe('healthy');
    // ABSENCE TWIN: without the rows both screens fall back to the whole month, and
    // both read under-allocated — the pre-H pair, still consistent with each other.
    const capNoAbs = rollupMonthly({
      resources: input.resources, assignments: input.assignments,
      assignmentDays: input.assignmentDays, assignmentMonths: input.assignmentMonths,
      months: [MONTH], hoursPerDay: 8, holidays: NO_HOL,
    });
    const capCellNoAbs = capNoAbs.rows.find(r => r.resourceId === 'flip')!.monthly[MONTH];
    expect(capCellNoAbs.targetHours).toBe(168);
    expect(capCellNoAbs.band).toBe('under');   // 77.38%
    expect(before.get('flip')!.state).toBe('PARTIAL');
  });

  /**
   * `'ABSENT'` is assigned ONLY on `fully-absent` (spec §4.3). Somebody there five
   * days of twenty-two with nothing booked IS bench for those five days, and hiding
   * her is the opposite of the correction this block ships.
   */
  it('a partly-absent month is NEVER ABSENT — all four cells keep the three original states', () => {
    for (const id of ['flip', 'stays', 'halftime', 'idlepart']) {
      expect(after.get(id)!.state).not.toBe('ABSENT');
    }
    expect([...after.values()].map(c => c.state).sort())
      .toStrictEqual(['ALLOCATED', 'BENCH', 'PARTIAL', 'PARTIAL']);
  });
});

/**
 * THE FULLY-ABSENT GUARDS. Cases the seed cannot produce, each of them the exact
 * input that makes some OTHER plausible ordering wrong.
 */
describe('benchRollup — fully-absent months (the guard `benchStateFor` cannot provide)', () => {
  const NO_HOL = new Set<string>();
  const MONTHS = ['2026-04', '2026-05', '2026-06'];

  /**
   * A MID-MONTH JOINER absent for every day she was employed. This is the case that
   * makes "the pro-rated target is 0, so `benchStateFor(0,0)` is unreachable" FALSE:
   * her five absent days deduct 40h from a 168h month, so the target is a confident
   * 128h and `benchStateFor(0, 128)` answers `'BENCH'`. Only branching on
   * availability FIRST gets this right.
   */
  it('a joiner employed for 5 days and absent on all 5 is ABSENT, not BENCH — the pro-rated target is POSITIVE here', () => {
    const input: BenchRollupInput = {
      resources: [{ id: 'j', name: 'Late Joiner Away', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: '2026-05-25' }],
      assignments: [], assignmentMonths: [], assignmentDays: [],
      months: ['2026-05'], displayMonths: ['2026-05'], hoursPerDay: 8, holidays: NO_HOL,
      absences: [{ resourceId: 'j', startDate: '2026-05-25', endDate: '2026-05-31' }],
    };
    const row = benchRollup(input, '2026-05-26').internalRows.find(r => r.resourceId === 'j')!;
    // B11: the ROW SURVIVES. Employment, not availability, is the row gate — a
    // person who silently vanished from the grid is worse than one miscounted.
    expect(row).toBeDefined();
    expect(row.monthly['2026-05'].state).toBe('ABSENT');
    // ABSENCE TWIN, with the number that makes it bite: the whole-month target is
    // 168h and her five employed days deduct 40, so a state computed from hours
    // would face `benchStateFor(0, 128)` and answer BENCH with full confidence.
    expect(standardMonthlyHours('2026-05', 8, NO_HOL) - 5 * 8).toBe(128);
    expect(row.monthly['2026-05'].state).not.toBe('BENCH');
    // PAIRED PRESENCE: drop the absence and she is BENCH for those five days, so
    // the ABSENT above is the absence row and not the late hire.
    const present = benchRollup({ ...input, absences: [] }, '2026-05-26').internalRows[0];
    expect(present.monthly['2026-05']).toMatchObject({ state: 'BENCH', unallocatedDays: 5 });
  });

  it('a person absent for EVERY shown month keeps her row, six ABSENT cells and an answerable availability date (B11)', () => {
    const input: BenchRollupInput = {
      resources: [{ id: 'gone', name: 'Away All Window', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 }],
      assignments: [], assignmentMonths: [], assignmentDays: [],
      months: MONTHS, displayMonths: MONTHS, hoursPerDay: 8, holidays: NO_HOL,
      absences: [{ resourceId: 'gone', startDate: '2026-04-01', endDate: '2026-06-30' }],
    };
    const roll = benchRollup(input, '2026-04-17');
    const row = roll.internalRows.find(r => r.resourceId === 'gone');
    expect(row).toBeDefined();
    expect(MONTHS.map(m => row!.monthly[m].state)).toStrictEqual(['ABSENT', 'ABSENT', 'ABSENT']);
    expect(row!.availabilityDate).toStrictEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-06' });
    // ABSENCE TWIN: without the row she is bench from today, so "beyond horizon" is
    // the leave and not an empty rollup.
    expect(benchRollup({ ...input, absences: [] }, '2026-04-17').internalRows[0].availabilityDate)
      .toStrictEqual({ kind: 'date', date: '2026-04-17' });
  });

  /**
   * STALE BOOKINGS ON A FULLY-ABSENT MONTH. §6.4 accepts an absence recorded over
   * days that are already booked (and reports the conflict), so these rows exist in
   * production. Two things must hold: the month is ABSENT despite the hours, and it
   * still contributes nothing to the idle run WITHOUT breaking it — which is why
   * `idleWorkingDaysAt` tests "zero available days" BEFORE "staffed".
   */
  it('40h still booked on a fully-absent month: the cell is ABSENT, and the idle run walks straight through it', () => {
    const FETCH = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
    const input: BenchRollupInput = {
      resources: [{ id: 's', name: 'Stale Booking', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: '2026-04-01' }],
      assignments: [{ id: 'a1', resourceId: 's' }],
      assignmentMonths: [{ assignmentId: 'a1', month: '2026-05', status: 'Allocated' }],
      assignmentDays: [{ assignmentId: 'a1', date: '2026-05-12', hours: 40 }],
      months: FETCH, displayMonths: ['2026-04', '2026-05', '2026-06'], hoursPerDay: 8, holidays: NO_HOL,
      absences: [{ resourceId: 's', startDate: '2026-05-01', endDate: '2026-05-31' }],
    };
    const row = benchRollup(input, '2026-06-10').internalRows.find(r => r.resourceId === 's')!;
    expect(row.monthly['2026-05'].state).toBe('ABSENT');
    // ABSENCE TWIN: 40h of a 168h month is PARTIAL, which is what an hours-first
    // classifier returns — a person on leave presented as half-booked.
    expect(row.monthly['2026-05'].state).not.toBe('PARTIAL');
    // Q1 THROUGH A STALE-BOOKED MONTH: June is April's 22 idle days plus its own 22
    // = 44, past the 42-day C ceiling. If the booking broke the run, June would
    // count only its own 22 days and read C — a different label, not a rounding.
    expect(row.monthly['2026-04']).toMatchObject({ state: 'BENCH', agingBucket: 'B' }); // 22, one full month
    expect(row.monthly['2026-06']).toMatchObject({ state: 'BENCH', agingBucket: 'C' }); // 22 + 0 + 22 = 44
    // ABSENCE TWIN: 'B' is what June would read if the absent month had RESTARTED
    // the run (its own 22 days alone), so this is what pins "walks straight through".
    expect(row.monthly['2026-06'].agingBucket).not.toBe('B');
  });

  /**
   * Q1 at the finest grain the decision has: ONE absent working day removes ONE idle
   * day, which is enough to move a bucket boundary. April 2026 has 22 working days —
   * one past the B ceiling of 21 — so the absence pulls the label DOWN from C to B.
   * Nothing else in this file crosses a boundary on the strength of a single day.
   */
  /**
   * A single absent working day is enough to move the LABEL, which is what makes
   * "an absent day contributes zero idle days" observable rather than internal.
   *
   * The fixture has to straddle a boundary to show that, and this one is built to.
   * Hired 2026-04-28 gives April exactly three working days (28-30); with May's 21
   * the run reaches 24, one past B's ceiling of 23. Remove one May working day and
   * it is 23 — B. The earlier version of this case used a whole April against a
   * ceiling of 21, which stopped straddling anything the moment that ceiling was
   * corrected to the longest real month: its premise disappeared, not just its
   * numbers, so it is rebuilt rather than renumbered.
   */
  it('ONE absent working day moves the aging bucket C -> B, because an absent day contributes zero idle days', () => {
    const input: BenchRollupInput = {
      resources: [{ id: 'one', name: 'One Day Off', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: '2026-04-28' }],
      assignments: [], assignmentMonths: [], assignmentDays: [],
      months: ['2026-04', '2026-05'], displayMonths: ['2026-04', '2026-05'], hoursPerDay: 8, holidays: NO_HOL,
    };
    const mayCell = (absences: readonly AbsenceInterval[]) =>
      benchRollup({ ...input, absences }, '2026-05-15').internalRows[0].monthly['2026-05'];
    // FIXTURE GUARD: without exactly three April working days the run is not 24 and
    // this test straddles nothing — the failure mode the rebuild exists to avoid.
    expect(benchRollup(input, '2026-05-15').internalRows[0].monthly['2026-04'].unallocatedDays).toBe(3);

    // 2026-05-05 is a Tuesday, so it really is a working day to remove.
    const oneDay: readonly AbsenceInterval[] = [{ resourceId: 'one', startDate: '2026-05-05', endDate: '2026-05-05' }];
    expect(mayCell([])).toMatchObject({ state: 'BENCH', agingBucket: 'C', unallocatedDays: 21 });      // 3 + 21 = 24
    expect(mayCell(oneDay)).toMatchObject({ state: 'BENCH', agingBucket: 'B', unallocatedDays: 20 });  // 3 + 20 = 23
    // Still BENCH, and still 100% — only the DAYS moved, which is the point.
    expect(mayCell(oneDay).unallocatedPct).toBe(100);
  });

  it('a WEEKEND-only absence moves nothing: those days were never available to begin with', () => {
    const input: BenchRollupInput = {
      resources: [{ id: 'w', name: 'Weekend Off', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: '2026-04-01' }],
      assignments: [], assignmentMonths: [], assignmentDays: [],
      months: ['2026-04'], displayMonths: ['2026-04'], hoursPerDay: 8, holidays: NO_HOL,
    };
    // 2026-04-04 and 04-05 are a Saturday and a Sunday.
    const weekend: readonly AbsenceInterval[] = [{ resourceId: 'w', startDate: '2026-04-04', endDate: '2026-04-05' }];
    const with_ = benchRollup({ ...input, absences: weekend }, '2026-04-17').internalRows[0].monthly['2026-04'];
    const without = benchRollup({ ...input, absences: [] }, '2026-04-17').internalRows[0].monthly['2026-04'];
    expect(with_).toStrictEqual(without);
    // ...and this fixture CAN move: the same two-day absence on working days does.
    const weekdays: readonly AbsenceInterval[] = [{ resourceId: 'w', startDate: '2026-04-06', endDate: '2026-04-07' }];
    expect(benchRollup({ ...input, absences: weekdays }, '2026-04-17').internalRows[0].monthly['2026-04'].unallocatedDays)
      .toBe(20);
  });

  it('an absence belonging to ANOTHER resource never touches this one (the id filter, through the rollup)', () => {
    const input: BenchRollupInput = {
      resources: [
        { id: 'mine', name: 'Mine', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: '2026-04-01' },
        { id: 'theirs', name: 'Theirs', role: 'Developer', kind: 'internal', contractHoursPerDay: 8, hireDate: '2026-04-01' },
      ],
      assignments: [], assignmentMonths: [], assignmentDays: [],
      months: ['2026-04'], displayMonths: ['2026-04'], hoursPerDay: 8, holidays: NO_HOL,
      absences: [{ resourceId: 'theirs', startDate: '2026-04-01', endDate: '2026-04-30' }],
    };
    const rows = new Map(benchRollup(input, '2026-04-17').internalRows.map(r => [r.resourceId, r]));
    expect(rows.get('theirs')!.monthly['2026-04'].state).toBe('ABSENT');
    // The presence twin: the untouched resource keeps her full 22 idle days.
    expect(rows.get('mine')!.monthly['2026-04']).toMatchObject({ state: 'BENCH', unallocatedDays: 22 });
  });
});

/**
 * `availabilityDate` end to end (spec §5.1 B6). The unit tests above feed
 * `availabilityDateFor` a cell list directly; these go through `benchRollup`, which
 * is where the ABSENT cells are produced in the first place — the two hops a defect
 * can hide between.
 */
describe('benchRollup — availabilityDate DIFFERENTIAL over an absence', () => {
  const NO_HOL = new Set<string>();
  const MONTHS = ['2026-04', '2026-05', '2026-06'];
  const TODAY_ = '2026-04-17';

  const input: BenchRollupInput = {
    resources: [
      // Bench all three months, away for all of April.
      { id: 'nowaway', name: 'Away Right Now', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
      // Allocated in April (176h = 22 x 8), bench in May and June, away for all of May.
      { id: 'lateaway', name: 'Away Next Month', role: 'Developer', kind: 'internal', contractHoursPerDay: 8 },
    ],
    assignments: [{ id: 'aL', resourceId: 'lateaway' }],
    assignmentMonths: [{ assignmentId: 'aL', month: '2026-04', status: 'Allocated' }],
    assignmentDays: [{ assignmentId: 'aL', date: '2026-04-07', hours: 176 }],
    months: MONTHS, displayMonths: MONTHS, hoursPerDay: 8, holidays: NO_HOL,
  };
  const ABSENCES: readonly AbsenceInterval[] = [
    { resourceId: 'nowaway', startDate: '2026-04-01', endDate: '2026-04-30' },
    { resourceId: 'lateaway', startDate: '2026-05-01', endDate: '2026-05-31' },
  ];
  const dateOf = (absences: readonly AbsenceInterval[], id: string) =>
    benchRollup({ ...input, absences }, TODAY_).internalRows.find(r => r.resourceId === id)!.availabilityDate;

  it('THE MOST VISIBLE FALSEHOOD: "available today" for someone away all month becomes the month she is back', () => {
    expect(dateOf([], 'nowaway')).toStrictEqual({ kind: 'date', date: '2026-04-17' });
    expect(dateOf(ABSENCES, 'nowaway')).toStrictEqual({ kind: 'date', date: '2026-05-01' });
  });

  it('a LATER absent month is skipped as well: the date moves from May to June', () => {
    expect(dateOf([], 'lateaway')).toStrictEqual({ kind: 'date', date: '2026-05-01' });
    expect(dateOf(ABSENCES, 'lateaway')).toStrictEqual({ kind: 'date', date: '2026-06-01' });
  });

  /**
   * The April cell of the person going on leave in May moves in exactly ONE field,
   * and it is B5 doing its job through the rollup rather than through the unit test:
   * `upcomingUnallocated` was true because May read BENCH, and must go false because
   * May now reads ABSENT. Somebody about to go on parental leave is not capacity
   * freeing up next month — that flag is what /forecast plans staffing off.
   */
  it('the April cell of the person leaving in May loses `upcomingUnallocated`, and moves in NOTHING else', () => {
    const withAbs = benchRollup({ ...input, absences: ABSENCES }, TODAY_).internalRows;
    const noAbs = benchRollup({ ...input, absences: [] }, TODAY_).internalRows;
    const cell = (rows: typeof withAbs, id: string, m: string) => rows.find(r => r.resourceId === id)!.monthly[m];
    expect(cell(noAbs, 'lateaway', '2026-04')).toStrictEqual(
      { state: 'ALLOCATED', upcomingUnallocated: true, unallocatedPct: 0, unallocatedDays: 0 });
    expect(cell(withAbs, 'lateaway', '2026-04')).toStrictEqual(
      { state: 'ALLOCATED', upcomingUnallocated: false, unallocatedPct: 0, unallocatedDays: 0 });
  });
});
