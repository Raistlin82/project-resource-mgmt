import { monthOf, monthlyTargetHours } from './calendar.util';

export type SemaphoreBand = 'idle' | 'under' | 'healthy' | 'over';
export const SEMAPHORE_THRESHOLDS = { idle: 50, under: 85, healthy: 105 } as const;
const EPS = 1e-9;

export interface CapacityCell {
  confirmedHours: number; plannedHours: number; targetHours: number;
  fteConfirmed: number; ftePlanned: number; band: SemaphoreBand;
}
export interface CapacityRow { resourceId: string; resourceName: string; monthly: Record<string, CapacityCell>; }
export interface CapacityTotals { demandFteConfirmed: number; demandFtePlanned: number; capacityFte: number; resourceCount: number; }
export interface CapacityRollup { months: string[]; rows: CapacityRow[]; totals: Record<string, CapacityTotals>; }

interface RollupResource { id: string; name: string; contractHoursPerDay?: number; hireDate?: string; terminationDate?: string; }
interface RollupAssignment { id: string; resourceId: string; status: string; }
interface RollupDay { assignmentId: string; date: string; hours: number; }
export interface RollupInput {
  resources: RollupResource[]; assignments: RollupAssignment[]; assignmentDays: RollupDay[];
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
export function isActiveInMonth(r: { hireDate?: string; terminationDate?: string }, month: string): boolean {
  const monthStart = `${month}-01`;
  if (r.hireDate && r.hireDate > monthStart) return false;
  if (r.terminationDate && r.terminationDate < monthStart) return false;
  return true;
}

export function rollupMonthly(input: RollupInput): CapacityRollup {
  const { resources, assignments, assignmentDays, months, hoursPerDay, holidays } = input;
  const asgById = new Map(assignments.map(a => [a.id, a]));
  const byResMonth = new Map<string, Map<string, { confirmed: number; planned: number }>>();
  for (const d of assignmentDays) {
    const a = asgById.get(d.assignmentId); if (!a) continue;
    // Defensive: a non-finite hours value would poison the running sums with NaN,
    // and semaphoreBand(NaN) falls through to 'over' — skip the row (cf. sumHoursByDate).
    if (!Number.isFinite(d.hours)) continue;
    const m = monthOf(d.date);
    let rm = byResMonth.get(a.resourceId); if (!rm) { rm = new Map(); byResMonth.set(a.resourceId, rm); }
    let c = rm.get(m); if (!c) { c = { confirmed: 0, planned: 0 }; rm.set(m, c); }
    if (PLANNED.has(a.status)) c.planned += d.hours;
    if (CONFIRMED.has(a.status)) c.confirmed += d.hours;
  }
  const targetByMonth = new Map(months.map(m => [m, standardMonthlyHours(m, hoursPerDay, holidays)]));
  const totals: Record<string, CapacityTotals> = {};
  for (const m of months) totals[m] = { demandFteConfirmed: 0, demandFtePlanned: 0, capacityFte: 0, resourceCount: 0 };
  const rows: CapacityRow[] = [];
  for (const r of resources) {
    const monthly: Record<string, CapacityCell> = {}; let hasAny = false;
    for (const m of months) {
      if (!isActiveInMonth(r, m)) continue;
      const target = targetByMonth.get(m)!;
      const src = byResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      const fteConfirmed = fteOf(src.confirmed, target);
      const ftePlanned = fteOf(src.planned, target);
      monthly[m] = { confirmedHours: src.confirmed, plannedHours: src.planned, targetHours: target,
        fteConfirmed, ftePlanned, band: semaphoreBand(ftePlanned * 100) };
      const t = totals[m];
      t.demandFteConfirmed += fteConfirmed;
      t.demandFtePlanned += ftePlanned;
      t.capacityFte += fteOf(monthlyTargetHours(r.contractHoursPerDay ?? hoursPerDay, m, holidays), target);
      t.resourceCount += 1;
      hasAny = true;
    }
    if (hasAny) rows.push({ resourceId: r.id, resourceName: r.name, monthly });
  }
  return { months, rows, totals };
}
