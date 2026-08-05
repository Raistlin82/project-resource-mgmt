/**
 * Bench / Unchargeable and availability (design spec, Block F). PURE: no I/O,
 * no clock — `today` is always a caller-supplied value, never read here.
 *
 * Mirrors `finance.util.ts`'s A/R aging shape (`AR_AGING_BUCKETS` /
 * `bucketForDaysOverdue` / `arAging`, `src/app/services/finance.util.ts:370-462`):
 * an ordered tuple of literal buckets, a pure classifier, an aggregator. The
 * difference that matters: aging here has TWO distinct questions — how long a
 * resource has ALREADY been idle (B/C/D, retrospective) and whether it is ABOUT
 * to become idle next month (forward-looking) — and the two are mutually
 * exclusive by construction, never merged into one bucket set (spec §5).
 */

export type BenchState = 'BENCH' | 'PARTIAL' | 'ALLOCATED';

/**
 * Classifies a single resource-month on RAW (unrounded) hours — never on a
 * percentage already rounded for display. A resource with 0.4h booked out of
 * ~160 standard hours rounds to "0.00%" on screen but is NOT bench: it has a
 * real, if tiny, booking (spec §3).
 */
export function benchStateFor(plannedHours: number, targetHours: number): BenchState {
  if (plannedHours === 0) return 'BENCH';
  if (plannedHours < targetHours) return 'PARTIAL';
  return 'ALLOCATED';
}

/** Retrospective aging buckets (spec §5.1) — ordered, like `AR_AGING_BUCKETS`. */
export const UNALLOCATED_AGING_BUCKETS = ['B', 'C', 'D'] as const;
export type UnallocatedAgingBucket = (typeof UNALLOCATED_AGING_BUCKETS)[number];

/**
 * How many consecutive months (walking backward from `index`, capped at 3 —
 * the cap is `bucketForMonthsIdle`'s own top bucket 'D', so counting further
 * back would never change the answer) `benchFlags` has held true, INCLUDING
 * `index` itself. `benchFlags[i]` must already read false for any month the
 * resource was not active in (design spec §5.1) — that guard lives in the
 * caller (`benchRollup`), not here.
 */
export function monthsIdleAt(benchFlags: readonly boolean[], index: number): number {
  let n = 0;
  for (let i = index; i >= 0 && benchFlags[i]; i--) { n++; if (n >= 3) break; }
  return n;
}

/** `monthsIdleAt`'s count is only ever called for a month where state === 'BENCH', so `monthsIdle` is always >= 1 in practice. */
export function bucketForMonthsIdle(monthsIdle: number): UnallocatedAgingBucket {
  if (monthsIdle <= 1) return 'B';
  if (monthsIdle === 2) return 'C';
  return 'D';
}

/**
 * Forward-looking "freeing up next month" signal (spec §5.2). Mutually
 * exclusive with an aging bucket by construction: this requires
 * `stateThis !== 'BENCH'`, aging buckets require `stateThis === 'BENCH'`.
 *
 * `activeNext` is deliberate: a resource that TERMINATES between this month
 * and the next is not marked "freeing up" — that is an offboarding event, not
 * a reallocation to plan for (out of scope — spec §12).
 */
export function freeingUpNextMonth(
  activeThis: boolean, stateThis: BenchState,
  activeNext: boolean, stateNext: BenchState | undefined,
): boolean {
  return activeThis && stateThis !== 'BENCH' && activeNext && stateNext === 'BENCH';
}

export type AvailabilityDate =
  | { kind: 'date'; date: string }
  | { kind: 'beyond-horizon'; horizonEndMonth: string };

/**
 * The 6-month availability date (spec §7) — NEVER absent, so a bench table
 * cell can never be misread as "no data" instead of "not free soon". Uses
 * ONLY the shown `cells`, in order — deliberately never the look-ahead month
 * fetched for `freeingUpNextMonth` (spec §7's explicit non-unification: the
 * two fields have different data scopes on purpose).
 */
export function availabilityDateFor(
  cells: readonly { month: string; state: BenchState }[],
  today: string,
): AvailabilityDate {
  if (cells[0]?.state === 'BENCH') return { kind: 'date', date: today };
  const firstBench = cells.find(c => c.state === 'BENCH');
  if (firstBench) return { kind: 'date', date: `${firstBench.month}-01` };
  return { kind: 'beyond-horizon', horizonEndMonth: cells[cells.length - 1]?.month ?? '' };
}
