import { describe, it, expect } from 'vitest';
import {
  benchStateFor, monthsIdleAt, bucketForMonthsIdle, freeingUpNextMonth, availabilityDateFor,
  type BenchState,
} from './bench.util';

describe('benchStateFor (design spec §3 — decided on RAW hours, never the rounded %)', () => {
  it('exactly 0 planned -> BENCH', () => expect(benchStateFor(0, 160)).toBe('BENCH'));
  it('just above 0 planned -> PARTIAL, NOT bench (0.4h rounds to 0.00% but is a real booking)', () =>
    expect(benchStateFor(0.4, 176)).toBe('PARTIAL'));
  it('just below target -> PARTIAL', () => expect(benchStateFor(159.99, 160)).toBe('PARTIAL'));
  it('exactly at target -> ALLOCATED', () => expect(benchStateFor(160, 160)).toBe('ALLOCATED'));
  it('above target (over-allocated) -> ALLOCATED, no fourth state', () => expect(benchStateFor(200, 160)).toBe('ALLOCATED'));
});

describe('monthsIdleAt (walks backward from index while benchFlags holds, capped at 3)', () => {
  it('not bench at index -> 0', () => expect(monthsIdleAt([false], 0)).toBe(0));
  it('bench for 1 consecutive month -> 1', () => expect(monthsIdleAt([false, true], 1)).toBe(1));
  it('bench for 2 consecutive months -> 2', () => expect(monthsIdleAt([false, true, true], 2)).toBe(2));
  it('bench for 3 consecutive months -> capped at 3', () => expect(monthsIdleAt([false, true, true, true], 3)).toBe(3));
  it('bench for 4 consecutive months -> STILL capped at 3, not 4', () =>
    expect(monthsIdleAt([true, true, true, true], 3)).toBe(3));
  // The five tests above never force index 0 of `benchFlags` to actually be
  // inspected: the "capped" cases hit n>=3 and break one iteration before i
  // reaches 0, and the short cases never have enough true flags to get there
  // either. Mutating the loop's lower bound from `i >= 0` to `i > 0` leaves
  // all five green. This case is the minimal one where reaching the cap of 3
  // REQUIRES the loop body to run at i === 0 (idle since the earliest
  // fetched month, index 0 of the 9-month window's look-back — see spec §8):
  // only 3 flags exist (indices 0, 1, 2), all true, walking back from index 2.
  it('bench for 3 consecutive months counting all the way back to index 0 -> 3 '
    + '(the earliest-fetched-month case; requires the loop to actually inspect benchFlags[0], not stop at index 1 — '
    + 'an `i > 0` boundary bug would report 2, a one-month-off aging misclassification)', () =>
    expect(monthsIdleAt([true, true, true], 2)).toBe(3));
});

describe('bucketForMonthsIdle', () => {
  it('1 -> B', () => expect(bucketForMonthsIdle(1)).toBe('B'));
  it('2 -> C', () => expect(bucketForMonthsIdle(2)).toBe('C'));
  it('3 (capped) -> D', () => expect(bucketForMonthsIdle(3)).toBe('D'));
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
});

describe('availabilityDateFor (design spec §7 — three branches, in order)', () => {
  const state = (s: BenchState) => s;
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
});

import { resources, assignments, assignmentDays, assignmentMonths, holidays } from '../../db/seed';
import { benchRollup, hiringDemandByMonth, EMPTY_BENCH_ROLLUP, type BenchRollupInput } from './bench.util';
import { hoursByResourceMonth } from './capacity.util';

const HOURS_PER_DAY = 8;
const HOLIDAY_SET = new Set(holidays.map(h => h.id));
const FETCH_MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const DISPLAY_MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const TODAY = '2026-04-17';

function rollup() {
  const input: BenchRollupInput = {
    resources, assignments, assignmentDays, assignmentMonths,
    months: FETCH_MONTHS, displayMonths: DISPLAY_MONTHS,
    hoursPerDay: HOURS_PER_DAY, holidays: HOLIDAY_SET,
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

describe('benchRollup — seed integration (design spec §11 fixture table)', () => {
  const out = rollup();

  it('resource 6 (subco): PARTIAL in April, then B/C/D/D/D May-Sep', () => {
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
    expect(row.monthly['2026-05']).toMatchObject({ state: 'BENCH', agingBucket: 'B' });
    expect(row.monthly['2026-06']).toMatchObject({ state: 'BENCH', agingBucket: 'C' });
    expect(row.monthly['2026-07']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-08']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-09']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
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

  it('resource 8 (hired exactly on the anchor month): April is bucket B, not D — the look-back truncation', () => {
    const row = out.internalRows.find(r => r.resourceId === '8')!;
    expect(row.monthly['2026-04']).toMatchObject({ state: 'BENCH', agingBucket: 'B' });
    expect(row.monthly['2026-05']).toMatchObject({ state: 'BENCH', agingBucket: 'C' });
    expect(row.monthly['2026-06']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-09']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
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
