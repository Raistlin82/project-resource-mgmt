import { monthOf, monthlyTargetHours, workingDaysInMonth } from './calendar.util';
import { countsTowardInternalCapacity, kindOf } from './resource-kind.util';

export type SemaphoreBand = 'idle' | 'under' | 'healthy' | 'over';
export const SEMAPHORE_THRESHOLDS = { idle: 50, under: 85, healthy: 105 } as const;
const EPS = 1e-9;

export interface CapacityCell {
  confirmedHours: number; plannedHours: number; targetHours: number;
  fteConfirmed: number; ftePlanned: number; band: SemaphoreBand;
}
export interface CapacityRow { resourceId: string; resourceName: string; monthly: Record<string, CapacityCell>; }
export interface CapacityTotals {
  demandFteConfirmed: number; demandFtePlanned: number; capacityFte: number; resourceCount: number;
  /** C1: planned FTE booked on dummy/subco — capacity that does not exist yet. */
  demandFteUncovered: number;
}
export interface CapacityRollup {
  months: string[];
  rows: CapacityRow[];
  /** C1: dummy and subco rows. Same monthly cells, but no capacity and no band. */
  demandRows: CapacityRow[];
  totals: Record<string, CapacityTotals>;
}

interface RollupResource { id: string; name: string; kind?: string; contractHoursPerDay?: number; hireDate?: string; terminationDate?: string; }
interface RollupAssignment { id: string; resourceId: string; }
interface RollupMonth { assignmentId: string; month: string; status: string; }
interface RollupDay { assignmentId: string; date: string; hours: number; }
export interface RollupInput {
  resources: RollupResource[]; assignments: RollupAssignment[]; assignmentDays: RollupDay[];
  /** B3: per-month lifecycle state — the classifier for confirmed/planned. */
  assignmentMonths: RollupMonth[];
  months: string[]; hoursPerDay: number; holidays: ReadonlySet<string>;
}

const CONFIRMED = new Set(['Allocated']);
const PLANNED = new Set(['Requested', 'Allocated']);

export function standardMonthlyHours(month: string, hoursPerDay: number, holidays: ReadonlySet<string>): number {
  return monthlyTargetHours(hoursPerDay, month, holidays);
}
export function fteOf(hours: number, standardHours: number): number {
  return standardHours > 0 ? hours / standardHours : 0;
}
export function semaphoreBand(pct: number): SemaphoreBand {
  const { idle, under, healthy } = SEMAPHORE_THRESHOLDS;
  if (pct < idle) return 'idle';
  if (pct < under) return 'under';
  if (pct <= healthy + EPS) return 'healthy';
  return 'over';
}
export function monthsInRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
/**
 * COARSE, month-granularity employment test: hired on or before the month's START
 * and not terminated before it.
 *
 * It is WRONG AT BOTH ENDS, which is why `rollupMonthly` now uses
 * {@link employedWorkingDays} instead. Kept because `bench.util.ts` still calls it;
 * substituting it there is that file's own change (it would move /bench headcounts,
 * which the bench specs pin).
 */
export function isActiveInMonth(r: { hireDate?: string; terminationDate?: string }, month: string): boolean {
  const monthStart = `${month}-01`;
  if (r.hireDate && r.hireDate > monthStart) return false;
  if (r.terminationDate && r.terminationDate < monthStart) return false;
  return true;
}

/**
 * The month's working days on which this person was actually employed: the month's
 * working-day list intersected with the closed interval [hireDate, terminationDate].
 * Empty exactly when they were employed on none of them.
 *
 * DAY granularity is not a refinement here — it is the only granularity that can
 * agree with the rest of the system. The server accepts or refuses a booked day
 * against employment ONE DAY AT A TIME (`bookingOutsideEmploymentError` in
 * src/server/operational-integrity.util.ts). Measuring capacity by the month made
 * this screen disagree with the API at both ends:
 *
 *  - JOINER: `isActiveInMonth` compares `hireDate` with the month's START, so
 *    someone hired on the 17th was "not active" for the whole month and
 *    `rollupMonthly` skipped the cell entirely — taking her ALREADY-BOOKED hours
 *    with it. The grid showed no row, the planned-FTE totals under-reported, and
 *    the CSV wrote nothing for a person with real demand the server had accepted.
 *  - LEAVER: the whole month was kept AND credited a FULL month of capacity, so
 *    someone who left on the 15th still contributed one whole FTE of supply. The
 *    screen then advertised free capacity that the API refuses to book.
 */
export function employedWorkingDays(
  r: { hireDate?: string; terminationDate?: string },
  month: string,
  holidays: ReadonlySet<string>,
): string[] {
  return workingDaysInMonth(month, holidays).filter(
    d => (r.hireDate === undefined || d >= r.hireDate) && (r.terminationDate === undefined || d <= r.terminationDate),
  );
}

/**
 * Per-resource, per-month {confirmed, planned} hours, aggregated from
 * assignmentDays weighted by each day's OWN month-row status (B3) — the exact
 * arithmetic `rollupMonthly` has always used, extracted so `bench.util.ts`'s
 * `benchRollup` can reuse it verbatim instead of re-deriving it (design spec §4).
 */
export function hoursByResourceMonth(
  input: Pick<RollupInput, 'assignments' | 'assignmentDays' | 'assignmentMonths'>,
): Map<string, Map<string, { confirmed: number; planned: number }>> {
  const { assignments, assignmentDays, assignmentMonths } = input;
  const asgById = new Map(assignments.map(a => [a.id, a]));
  const statusByRowId = new Map(assignmentMonths.map(m => [`${m.assignmentId}:${m.month}`, m.status]));
  const byResMonth = new Map<string, Map<string, { confirmed: number; planned: number }>>();
  for (const d of assignmentDays) {
    const a = asgById.get(d.assignmentId); if (!a) continue;
    // Defensive: a non-finite hours value would poison the running sums with NaN,
    // and semaphoreBand(NaN) falls through to 'over' — skip the row (cf. sumHoursByDate).
    if (!Number.isFinite(d.hours)) continue;
    const m = monthOf(d.date);
    // B3: classify by THIS day's month-row status, not the assignment's derived
    // rollup — a day whose month row is missing contributes to neither total
    // (same rule as the pure `monthlyAggregateHours`).
    const status = statusByRowId.get(`${d.assignmentId}:${m}`);
    if (status === undefined) continue;
    let rm = byResMonth.get(a.resourceId); if (!rm) { rm = new Map(); byResMonth.set(a.resourceId, rm); }
    let c = rm.get(m); if (!c) { c = { confirmed: 0, planned: 0 }; rm.set(m, c); }
    if (PLANNED.has(status)) c.planned += d.hours;
    if (CONFIRMED.has(status)) c.confirmed += d.hours;
  }
  return byResMonth;
}

export function rollupMonthly(input: RollupInput): CapacityRollup {
  const { resources, assignments, assignmentDays, assignmentMonths, months, hoursPerDay, holidays } = input;
  const byResMonth = hoursByResourceMonth({ assignments, assignmentDays, assignmentMonths });
  const targetByMonth = new Map(months.map(m => [m, standardMonthlyHours(m, hoursPerDay, holidays)]));
  const totals: Record<string, CapacityTotals> = {};
  for (const m of months) {
    totals[m] = { demandFteConfirmed: 0, demandFtePlanned: 0, capacityFte: 0, resourceCount: 0, demandFteUncovered: 0 };
  }
  const rows: CapacityRow[] = [];
  const demandRows: CapacityRow[] = [];
  for (const r of resources) {
    // C1: dummy/subco represent capacity that does not exist yet — the manual
    // excludes them from the internal KPIs (headcount, capacityFte, the
    // confirmed/planned demand totals and the semaphore). They still get a
    // row with the same monthly cells so the dashboard can show what is
    // booked against them, just under `demandFteUncovered` instead.
    const isInternal = countsTowardInternalCapacity(kindOf(r));
    const monthly: Record<string, CapacityCell> = {}; let hasAny = false;
    for (const m of months) {
      // Employment is measured in DAYS, not months (see employedWorkingDays): the
      // cell is dropped only when the person was employed on NO working day of the
      // month, so a mid-month joiner keeps her row and her already-booked hours.
      const employedDays = employedWorkingDays(r, m, holidays);
      if (employedDays.length === 0) continue;
      const target = targetByMonth.get(m)!;
      const src = byResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      const fteConfirmed = fteOf(src.confirmed, target);
      const ftePlanned = fteOf(src.planned, target);
      const t = totals[m];
      if (isInternal) {
        monthly[m] = { confirmedHours: src.confirmed, plannedHours: src.planned, targetHours: target,
          fteConfirmed, ftePlanned, band: semaphoreBand(ftePlanned * 100) };
        t.demandFteConfirmed += fteConfirmed;
        t.demandFtePlanned += ftePlanned;
        // Capacity is PRO-RATED to the days actually employed. It used to be
        // `monthlyTargetHours(...)` — the whole month — so a leaver who went on the
        // 15th supplied a full FTE the API would refuse to book against.
        // `monthlyTargetHours` is `workingDays × contractHoursPerDay`, so the
        // pro-rated form is the same product over the employed subset.
        t.capacityFte += fteOf(employedDays.length * (r.contractHoursPerDay ?? hoursPerDay), target);
        t.resourceCount += 1;
      } else {
        // Inert placeholder band: demand rows share the CapacityCell type but
        // are never tinted by the UI (Task 6 renders them without a band).
        monthly[m] = { confirmedHours: src.confirmed, plannedHours: src.planned, targetHours: target,
          fteConfirmed, ftePlanned, band: 'idle' };
        t.demandFteUncovered += ftePlanned;
      }
      hasAny = true;
    }
    if (hasAny) {
      const row: CapacityRow = { resourceId: r.id, resourceName: r.name, monthly };
      if (isInternal) rows.push(row); else demandRows.push(row);
    }
  }
  return { months, rows, demandRows, totals };
}
