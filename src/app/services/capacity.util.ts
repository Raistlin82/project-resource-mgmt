import { AbsenceInterval, availableWorkingDays } from './absence.util';
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
  /**
   * H: absences, which shrink the days a person can be staffed on. OPTIONAL, and
   * that is a DECLARED TRAP (spec §5.2 C1, §8.2): omitting it — or passing `[]` —
   * reproduces the pre-H arithmetic exactly, so every fixture in the codebase
   * stays green while exercising not one new line. The only thing that proves
   * this field is read is a DIFFERENTIAL test: the same fixture with and without
   * rows, asserted to disagree. One lives in this file's spec; do not delete it
   * on the grounds that the value assertions next to it already pass.
   */
  absences?: readonly AbsenceInterval[];
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
 *  - JOINER: a month-granular gate compares `hireDate` with the month's START, so
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

/**
 * TWO DENOMINATORS, ON PURPOSE (H, spec §4.4/§5.2). Once absences exist, "how
 * loaded is this person" and "how much supply does the org have" stop having the
 * same answer, and collapsing them would make one of the two false:
 *
 *  - The CELL (`targetHours`, `fteConfirmed`, `ftePlanned`, `band`) divides by the
 *    STAFFABLE slice of the standard month — the standard month less this
 *    person's absent working days. Somebody present 5 days of 22 and booked solid
 *    on all five reads ~100%, not ~23% (spec §1.2). That is the metric H exists
 *    to fix.
 *  - The TOTALS (`demandFteConfirmed`, `demandFtePlanned`, `demandFteUncovered`,
 *    `capacityFte`) keep dividing by the WHOLE standard month, so they stay
 *    comparable across people and months. Booked hours do not change when an
 *    absence is recorded, so org demand must not move either; feeding the totals
 *    the pro-rated figure would have that same person contribute a full 1.0 FTE
 *    of demand for 40 booked hours.
 *
 * The visible consequence, stated rather than discovered: with an absence in the
 * window, `Σ cell.ftePlanned ≠ totals.demandFtePlanned`. Without one they are
 * identical, which is exactly why only a differential test can see this working.
 *
 * The pro-ration deducts absent days at the COMPANY rate (`hoursPerDay`), not at
 * the resource's own `contractHoursPerDay`, so the cell target stays "the standard
 * month scaled by the fraction of it she was staffable". Using her own rate would
 * change every part-timer's and every mid-month joiner's percentage even with no
 * absences at all — a silent re-definition of the demand denominator that H did
 * not ask for, and one `bench.util.ts` documents as a deliberate divergence.
 */
export function rollupMonthly(input: RollupInput): CapacityRollup {
  const { resources, assignments, assignmentDays, assignmentMonths, months, hoursPerDay, holidays, absences = [] } = input;
  const byResMonth = hoursByResourceMonth({ assignments, assignmentDays, assignmentMonths });
  const standardByMonth = new Map(months.map(m => [m, standardMonthlyHours(m, hoursPerDay, holidays)]));
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
      // H: the days she was employed AND not absent. A month she is absent for
      // ENTIRELY is not skipped — it keeps a cell, with a zero target and zero
      // capacity (spec §5.2 C9): "we did not employ her" and "we employed her and
      // she could not work" are opposite facts, and only the first drops a row.
      const availableDays = availableWorkingDays(r.id, absences, employedDays);
      const standard = standardByMonth.get(m)!;
      // Non-negative by construction: `availableWorkingDays` returns a subset, and
      // `absenceDaysFor` returns a Set, so two overlapping absences cannot subtract
      // the same day twice and push the target above the standard month.
      const target = standard - (employedDays.length - availableDays.length) * hoursPerDay;
      const src = byResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      const fteConfirmed = fteOf(src.confirmed, target);
      const ftePlanned = fteOf(src.planned, target);
      const t = totals[m];
      if (isInternal) {
        monthly[m] = { confirmedHours: src.confirmed, plannedHours: src.planned, targetHours: target,
          fteConfirmed, ftePlanned, band: semaphoreBand(ftePlanned * 100) };
        // Totals divide by the WHOLE standard month, never by the pro-rated cell
        // target — see this function's header for why the two must diverge.
        t.demandFteConfirmed += fteOf(src.confirmed, standard);
        t.demandFtePlanned += fteOf(src.planned, standard);
        // Capacity is PRO-RATED to the days actually AVAILABLE. It used to be
        // `monthlyTargetHours(...)` — the whole month — so a leaver who went on the
        // 15th supplied a full FTE the API would refuse to book against.
        // `monthlyTargetHours` is `workingDays × contractHoursPerDay`, so the
        // pro-rated form is the same product over the employed subset. H narrows
        // that subset once more, from employed to available, and the answer to
        // "zero capacity, or full capacity left unused?" is ZERO (spec §5.2 C6):
        // capacity the API would refuse to book is not capacity, which is the same
        // argument the leaver comment above makes.
        t.capacityFte += fteOf(availableDays.length * (r.contractHoursPerDay ?? hoursPerDay), standard);
        // NOT narrowed by absence: an absent person is still headcount, because she
        // is still employed. `capacityFte` falls and `resourceCount` does not — the
        // gap between them is what makes "how many people" readable next to "how
        // much capacity" (spec §5.2 C7).
        t.resourceCount += 1;
      } else {
        // Inert placeholder band: demand rows share the CapacityCell type but
        // are never tinted by the UI (Task 6 renders them without a band).
        monthly[m] = { confirmedHours: src.confirmed, plannedHours: src.planned, targetHours: target,
          fteConfirmed, ftePlanned, band: 'idle' };
        // Standard month, like the other three totals: uncovered demand is measured
        // in the same comparable FTE, and a subco's sick week must not inflate it
        // (spec §5.2 C10). A subco CAN be absent — only dummies cannot.
        t.demandFteUncovered += fteOf(src.planned, standard);
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
