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

import { RollupInput, isActiveInMonth, standardMonthlyHours, hoursByResourceMonth } from './capacity.util';
import { countsTowardDeliveryCapacity, kindOf } from './resource-kind.util';

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

export interface HiringDemandRow { month: string; role: string; hours: number; }

/**
 * Hiring demand from DUMMY placeholders only (spec §6) — subco rows go to
 * bench (§4), never here. `hours` is RAW, unrounded; the FTE conversion is a
 * rendering-only step (§6/§10), never computed here.
 *
 * Aggregates through a nested `Map<month, Map<role, hours>>` rather than a
 * joined `${month}:${role}` string key: a role name is free text from the
 * `/project-roles` catalog (only `code`, not `name`, is character-restricted —
 * see `manage-project-roles.component.ts`), so it can legally contain a colon
 * or any other character. A joined-then-split key would silently merge or
 * mis-parse such a role; keeping month and role as separate map levels avoids
 * the parse entirely, so no role content can corrupt the aggregation.
 */
export function hiringDemandByMonth(
  resources: readonly { id: string; role: string; kind?: string }[],
  hoursByResMonth: ReturnType<typeof hoursByResourceMonth>,
  months: readonly string[],
): HiringDemandRow[] {
  const totalsByMonth = new Map<string, Map<string, number>>();
  for (const r of resources) {
    if (kindOf(r) !== 'dummy') continue;
    const byMonth = hoursByResMonth.get(r.id);
    if (!byMonth) continue;
    for (const m of months) {
      const cell = byMonth.get(m);
      if (!cell || cell.planned <= 0) continue;
      let byRole = totalsByMonth.get(m); if (!byRole) { byRole = new Map(); totalsByMonth.set(m, byRole); }
      byRole.set(r.role, (byRole.get(r.role) ?? 0) + cell.planned);
    }
  }
  const rows: HiringDemandRow[] = [];
  for (const [month, byRole] of totalsByMonth) {
    for (const [role, hours] of byRole) rows.push({ month, role, hours });
  }
  return rows.sort((a, b) => (a.month === b.month ? a.role.localeCompare(b.role) : a.month.localeCompare(b.month)));
}

export interface BenchCell {
  state: BenchState;
  agingBucket?: UnallocatedAgingBucket;
  upcomingUnallocated: boolean;
}
export interface BenchRow {
  resourceId: string; resourceName: string; kind: 'internal' | 'subco';
  monthly: Record<string, BenchCell>;
  availabilityDate: AvailabilityDate;
}
export interface BenchRollup {
  months: string[];
  internalRows: BenchRow[];
  subcoRows: BenchRow[];
  hiringDemand: HiringDemandRow[];
}
export const EMPTY_BENCH_ROLLUP: BenchRollup = { months: [], internalRows: [], subcoRows: [], hiringDemand: [] };

export interface BenchRollupInput extends RollupInput {
  // Narrows `RollupInput['resources']` (which has no `role` — `rollupMonthly`
  // never needs one) to add the field `hiringDemandByMonth` requires. Kept
  // local to this interface rather than added to `RollupResource` itself:
  // widening the shared type would force `role` onto every `rollupMonthly`
  // fixture across the codebase, most of which omit it.
  resources: (RollupInput['resources'][number] & { role: string })[];
  /** The 6 months to return as rows — see the server's window construction (Task 6). */
  displayMonths: string[];
}

/**
 * Composes the whole Block F view: BENCH/PARTIAL/ALLOCATED + aging + the
 * forward-looking signal + availability, split into `internalRows`/`subcoRows`
 * by `countsTowardDeliveryCapacity` (NOT `countsTowardInternalCapacity` —
 * spec §4's whole point: a subco belongs in bench, a dummy never does), plus
 * `hiringDemand` from the dummy rows this split excludes.
 *
 * `input.months` is the WIDER fetch window (2 look-back + 6 shown + 1
 * look-ahead, spec §8); `input.displayMonths` is the 6 shown months. A
 * resource gets a row only if active in at least one DISPLAY month — a
 * DELIBERATE narrowing from `rollupMonthly`'s own `hasAny` gate (which
 * considers every fetched month): a resource whose only booking falls in the
 * look-back window (spec §11 fixture 6) must NOT surface a row here.
 */
export function benchRollup(input: BenchRollupInput, today: string): BenchRollup {
  const { resources, months, displayMonths, hoursPerDay, holidays } = input;
  const hoursByResMonth = hoursByResourceMonth(input);
  const targetByMonth = new Map(months.map(m => [m, standardMonthlyHours(m, hoursPerDay, holidays)]));
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  const internalRows: BenchRow[] = [];
  const subcoRows: BenchRow[] = [];

  for (const r of resources) {
    const kind = kindOf(r);
    if (!countsTowardDeliveryCapacity(kind)) continue; // dummy: never in bench (spec §4)

    const activeOf = new Map<string, boolean>();
    const stateOf = new Map<string, BenchState>();
    for (const m of months) {
      const active = isActiveInMonth(r, m);
      activeOf.set(m, active);
      if (!active) continue;
      const cell = hoursByResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      stateOf.set(m, benchStateFor(cell.planned, targetByMonth.get(m)!));
    }

    if (!displayMonths.some(m => activeOf.get(m))) continue; // never active in a SHOWN month -> no row

    const benchFlags = months.map(m => (activeOf.get(m) ?? false) && stateOf.get(m) === 'BENCH');

    const monthly: Record<string, BenchCell> = {};
    for (const m of displayMonths) {
      if (!activeOf.get(m)) continue;
      const state = stateOf.get(m)!;
      const cell: BenchCell = { state, upcomingUnallocated: false };
      if (state === 'BENCH') cell.agingBucket = bucketForMonthsIdle(monthsIdleAt(benchFlags, monthIndex.get(m)!));
      monthly[m] = cell;
    }
    for (const m of displayMonths) {
      const cell = monthly[m];
      if (!cell) continue;
      const idx = monthIndex.get(m)!;
      const nextMonth = months[idx + 1];
      const activeNext = nextMonth !== undefined && (activeOf.get(nextMonth) ?? false);
      const stateNext = nextMonth !== undefined ? stateOf.get(nextMonth) : undefined;
      cell.upcomingUnallocated = freeingUpNextMonth(activeOf.get(m) ?? false, cell.state, activeNext, stateNext);
    }

    const cellsInOrder = displayMonths.filter(m => monthly[m] !== undefined).map(m => ({ month: m, state: monthly[m].state }));
    const row: BenchRow = {
      resourceId: r.id, resourceName: r.name, kind: kind as 'internal' | 'subco',
      monthly, availabilityDate: availabilityDateFor(cellsInOrder, today),
    };
    if (kind === 'internal') internalRows.push(row); else subcoRows.push(row);
  }

  return { months: displayMonths, internalRows, subcoRows, hiringDemand: hiringDemandByMonth(resources, hoursByResMonth, displayMonths) };
}
