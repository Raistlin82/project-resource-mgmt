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
