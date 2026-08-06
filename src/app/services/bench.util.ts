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

import { RollupInput, employedWorkingDays, standardMonthlyHours, hoursByResourceMonth } from './capacity.util';
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

/**
 * How much of a resource-month is NOT allocated, as a percentage and in days —
 * the RPT "% di disallocazione" figure (comparison matrix row 50).
 *
 * THE DENOMINATOR IS THE RESOURCE'S OWN TARGET, not the company standard month:
 * `employedWorkingDayCount × ownHoursPerDay`, i.e. the same product
 * `rollupMonthly` pro-rates capacity by (`capacity.util.ts`, the `capacityFte`
 * line). A part-timer on 4h/day and a mid-month joiner each have their own
 * target, so neither is reported as half-idle for working every hour they are
 * contracted for. This is DELIBERATELY a different denominator from
 * {@link benchStateFor}'s, which classifies BENCH/PARTIAL/ALLOCATED against the
 * STANDARD month — so a fully-booked part-timer can legitimately read
 * `state: 'PARTIAL'` with `unallocatedPct: 0`. The two fields answer two
 * different questions ("is there room in the standard month" vs "is this person
 * idle against their own contract"); the divergence is pinned by a test rather
 * than left to be rediscovered as a bug.
 *
 * `undefined`, never a number, when the own target is 0 — a percentage of no
 * capacity is UNANSWERABLE, not 0%. Reporting 0 there would say "fully
 * allocated" about someone who has no contracted hours at all, which is the
 * error direction that hides people.
 *
 * Truncated to [0, 100]: an OVER-allocated month is 0% unallocated, never
 * negative (there is no fourth state above ALLOCATED either — see
 * {@link benchStateFor}).
 */
export function unallocatedShare(
  plannedHours: number, ownHoursPerDay: number, employedWorkingDayCount: number,
): { unallocatedPct: number; unallocatedDays: number } | undefined {
  const targetHours = employedWorkingDayCount * ownHoursPerDay;
  // `!(x > 0)` rather than `x <= 0` so NaN lands here too; a non-finite booking is
  // likewise unanswerable, and must never reach a template as "NaN%".
  if (!(targetHours > 0) || !Number.isFinite(plannedHours)) return undefined;
  // targetHours > 0 implies ownHoursPerDay > 0, so the days division is safe.
  const idleHours = Math.min(targetHours, Math.max(0, targetHours - plannedHours));
  return { unallocatedPct: (idleHours / targetHours) * 100, unallocatedDays: idleHours / ownHoursPerDay };
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
  /**
   * How much of this month the resource is NOT allocated for — RPT's
   * disallocation figure (comparison matrix row 50), which the 3-valued `state`
   * cannot express (it cannot tell someone idle at 10% from someone idle at 90%).
   *
   * OPTIONAL, and the absence is a VALUE, not an omission: both fields are absent
   * exactly when the resource's own monthly target is 0, because a share of no
   * capacity is unanswerable rather than 0 (see {@link unallocatedShare}). Same
   * kind of semantic absence `agingBucket` already has on this type. A renderer
   * must therefore distinguish "no answer" from "0%" — showing 0% for an absent
   * value claims someone is fully allocated when nothing is known.
   *
   * Raw and unrounded, like every other figure crossing this boundary; the 2-decimal
   * cap is a rendering step.
   */
  unallocatedPct?: number;
  /** Days not allocated in the month, same absence rule as {@link BenchCell.unallocatedPct}. */
  unallocatedDays?: number;
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
    // The resource's OWN monthly target, per month: employed working days ×
    // their own contracted hours. Kept alongside `stateOf` (whose target is the
    // company standard month) because `unallocatedShare` needs the pro-rated
    // one — see its doc comment for why the two denominators differ on purpose.
    const ownTargetOf = new Map<string, { days: number; hoursPerDay: number }>();
    for (const m of months) {
      // Employment is measured in DAYS, not months — the same `employedWorkingDays`
      // gate `rollupMonthly` uses, and the same granularity the server enforces a
      // booking at (`bookingOutsideEmploymentError`). This used to be the coarse
      // `isActiveInMonth`, which compares `hireDate` with the month's START: someone
      // hired on the 15th was "not active" for the whole month, so /bench DROPPED
      // her row while /capacity — already on the day-granular gate — kept it. Two
      // screens over one endpoint's data disagreeing about whether a person exists
      // this month is the defect; there is no bench-specific reason to answer the
      // employment question differently from the capacity grid.
      const employedDays = employedWorkingDays(r, m, holidays);
      const active = employedDays.length > 0;
      activeOf.set(m, active);
      if (!active) continue;
      const cell = hoursByResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      stateOf.set(m, benchStateFor(cell.planned, targetByMonth.get(m)!));
      ownTargetOf.set(m, { days: employedDays.length, hoursPerDay: r.contractHoursPerDay ?? hoursPerDay });
    }

    if (!displayMonths.some(m => activeOf.get(m))) continue; // never active in a SHOWN month -> no row

    const benchFlags = months.map(m => (activeOf.get(m) ?? false) && stateOf.get(m) === 'BENCH');

    const monthly: Record<string, BenchCell> = {};
    for (const m of displayMonths) {
      if (!activeOf.get(m)) continue;
      const state = stateOf.get(m)!;
      const cell: BenchCell = { state, upcomingUnallocated: false };
      if (state === 'BENCH') cell.agingBucket = bucketForMonthsIdle(monthsIdleAt(benchFlags, monthIndex.get(m)!));
      const own = ownTargetOf.get(m)!;
      const share = unallocatedShare(hoursByResMonth.get(r.id)?.get(m)?.planned ?? 0, own.hoursPerDay, own.days);
      // Left ABSENT, never zeroed, when the own target is 0 — see BenchCell.
      if (share) { cell.unallocatedPct = share.unallocatedPct; cell.unallocatedDays = share.unallocatedDays; }
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

/** One month of {@link UnallocatedHistory} — see it for why `upcomingUnallocated` is absent. */
export interface UnallocatedHistoryCell {
  month: string;
  state: BenchState;
  agingBucket?: UnallocatedAgingBucket;
  /** Same "absent means unanswerable" rule as {@link BenchCell.unallocatedPct}. */
  unallocatedPct?: number;
  unallocatedDays?: number;
}

/**
 * Per-resource monthly disallocation history — RPT's expandable row (comparison
 * matrix row 51: `2025-03 · disallocato 21 gg · 100%`).
 *
 * `cells` is OLDEST-FIRST, matching `displayMonths` and every other month list in
 * the app (the bench grid, the capacity grid), and carries ONLY the months the
 * resource was genuinely employed in: a month they were not employed is an ABSENT
 * entry, never a 0%/0-day row, because "we did not employ them" and "we employed
 * them and left them idle" are opposite facts.
 *
 * `cells: []` is a legitimate answer (a dummy placeholder, which the bench rollup
 * excludes by design, or anyone employed in none of the window's months) and means
 * NOT TRACKED — never "allocated the whole time". Same rule the availability strip
 * already renders explicitly.
 *
 * `upcomingUnallocated` is deliberately NOT carried: it is a forward-looking claim
 * about the month AFTER the one it sits on, which is meaningless in a retrospective
 * list and, on the last cell, would describe a month the history does not show.
 */
export interface UnallocatedHistory {
  resourceId: string;
  resourceName: string;
  cells: UnallocatedHistoryCell[];
}

/**
 * The history's cells for ONE resource, derived by running {@link benchRollup}
 * over `input` narrowed to that resource.
 *
 * Reusing `benchRollup` rather than re-deriving the percentage is the point: the
 * history's most recent month and the /bench grid's current-month column are then
 * the SAME computation, so they cannot drift into disagreeing about how idle
 * somebody is. It also inherits the aging buckets and the employment-day gate for
 * free. Narrowing `resources` first keeps the cost proportional to one row instead
 * of the whole org (`hiringDemand` collapses to empty, since a single internal or
 * subco resource contributes none).
 */
export function unallocatedHistoryFor(
  input: BenchRollupInput, resourceId: string, today: string,
): UnallocatedHistoryCell[] {
  const only = input.resources.filter(r => r.id === resourceId);
  if (only.length === 0) return [];
  const roll = benchRollup({ ...input, resources: only }, today);
  const row = [...roll.internalRows, ...roll.subcoRows][0];
  if (row === undefined) return [];
  const cells: UnallocatedHistoryCell[] = [];
  for (const month of input.displayMonths) {
    const cell = row.monthly[month];
    if (cell === undefined) continue; // not employed that month: absent, not zeroed
    // Optional keys are OMITTED rather than set to `undefined`, so this object has
    // the same shape in-process as it does after the JSON round-trip the client
    // actually receives (`JSON.stringify` drops undefined-valued keys). Setting
    // them explicitly would make a `toStrictEqual` test pass against a shape no
    // browser ever sees.
    const out: UnallocatedHistoryCell = { month, state: cell.state };
    if (cell.agingBucket !== undefined) out.agingBucket = cell.agingBucket;
    if (cell.unallocatedPct !== undefined) out.unallocatedPct = cell.unallocatedPct;
    if (cell.unallocatedDays !== undefined) out.unallocatedDays = cell.unallocatedDays;
    cells.push(out);
  }
  return cells;
}

/**
 * Single-month "not fully allocated" snapshot for `/forecast`'s rolling weekly
 * horizon and `/what-if`'s in-memory sandbox — DECOUPLED from `/bench`'s own
 * 6-month display window (spec §9's `/forecast` row: "ripuntato su
 * bench.util.ts... filtrato su monthly[from].state !== 'ALLOCATED'"). Builds
 * the minimal 4-month fetch window (2 look-back + `month` itself + 1
 * look-ahead) `benchRollup` needs for a correct aging bucket / forward signal
 * on that one month, and returns every internal+subco row that is BENCH or
 * PARTIAL there.
 *
 * Typed on `BenchRollupInput` (role required), NOT the plain `RollupInput` —
 * this function delegates to `benchRollup`, which genuinely needs `role` on
 * every resource (it feeds `hiringDemandByMonth`). A synthetic placeholder
 * role would be inert only by accident of what THIS function currently reads
 * (`internalRows`/`subcoRows`, never `hiringDemand`); the moment it or a
 * caller touches hiring demand, a fake role becomes silently wrong data with
 * nothing red to catch it. The honest type says the input requires role,
 * because the delegate does.
 */
export function notFullyAllocatedAt(
  input: Omit<BenchRollupInput, 'months' | 'displayMonths'>,
  month: string,
  today: string,
): BenchRow[] {
  const idx = (m: string) => { const [y, mm] = m.split('-').map(Number); return y * 12 + (mm - 1); };
  const toMonth = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const c = idx(month);
  const months = [c - 2, c - 1, c, c + 1].map(toMonth);
  const roll = benchRollup({ ...input, months, displayMonths: [month] }, today);
  return [...roll.internalRows, ...roll.subcoRows].filter(r => r.monthly[month]?.state !== 'ALLOCATED');
}
