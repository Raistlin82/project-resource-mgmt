/**
 * Pure per-month allocation helpers (B3).
 *
 * The approval lifecycle lives on the (assignment, month) pair — see
 * docs/superpowers/specs/2026-08-02-b3-monthly-approval-design.md. This layer
 * holds the rules that must be identical on the server (src/server.ts) and in
 * the UI: the composite row id, the transition table, the assignment-level
 * status rollup, and the status-weighted hour aggregation that feeds
 * utilization / staffed effort / the capacity dashboard.
 *
 * Side-effect free and SSR-safe: no clock access, ISO strings only.
 */
import { monthOf } from './calendar.util';

export type MonthStatus = 'Draft' | 'Requested' | 'Allocated' | 'Rejected';

/** One day's hours, as stored by `assignmentDays` (B1). */
export interface DayHours {
  assignmentId: string;
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  hours: number;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Composite key of a month row: `<assignmentId>:<YYYY-MM>` (never newId()). */
export function monthRowId(assignmentId: string, month: string): string {
  return `${assignmentId}:${month}`;
}

/**
 * Split a month-row id back into its parts. Returns undefined when `id` is not
 * the composite form — which is how the decision hook tells a B3 month row from
 * a LEGACY gap-A approval whose refId is a bare assignment id.
 */
export function parseMonthRowId(id: string): { assignmentId: string; month: string } | undefined {
  const idx = id.lastIndexOf(':');
  if (idx <= 0) return undefined;
  const assignmentId = id.slice(0, idx);
  const month = id.slice(idx + 1);
  if (!MONTH_RE.test(month)) return undefined;
  return { assignmentId, month };
}

// REMOVED: `isAllowedMonthTransition` / MONTH_TRANSITIONS. The table had no
// runtime caller, and the only place it could naturally live — the decision
// hook's month-status write in `applyAllocationDecision` — must NEVER refuse a
// transition: an approval that reports Approved while the governed month stays
// Requested is precisely the divergence that hook exists to prevent, so a guard
// there could only turn a committed decision into silent corruption. The two
// callers that DO gate a transition already do so inline and for reasons the
// table cannot express: `POST .../months/:month/submit` restricts the source to
// Draft/Rejected (the table's Allocated -> Requested edge belongs to a different
// caller, the allocation PUT's forced re-approval), and the legacy bare-refId
// branch of `applyAllocationDecision` legitimately performs Allocated ->
// Rejected, an edge the table forbade. Keeping a table that describes neither
// the legal nor the enforced set would only invite a future author to wire in
// the wrong guard. The rollup rule it shipped alongside — `deriveAssignmentStatus`
// — is the part that is real, and stays.

/**
 * Roll month statuses up into the assignment's DERIVED status. Precedence
 * Requested > Rejected > Allocated > Draft: anything awaiting a decision
 * dominates (it is the actionable state), then anything refused, then approved
 * work; no rows at all reads as Draft.
 */
const STATUS_PRECEDENCE: readonly MonthStatus[] = ['Requested', 'Rejected', 'Allocated', 'Draft'];

export function deriveAssignmentStatus(statuses: readonly MonthStatus[]): MonthStatus {
  for (const candidate of STATUS_PRECEDENCE) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'Draft';
}

/**
 * Sum day hours weighted by the status of the MONTH each day falls in:
 * confirmed = 'Allocated' months, planned = 'Requested' + 'Allocated'.
 *
 * Days whose month row is absent contribute 0 — legacy assignments with day
 * rows but no month row (a Postgres DB populated before B1/B3) stay out of the
 * aggregates until their first calendar edit, continuing B1's self-healing
 * decision.
 */
export function monthlyAggregateHours(
  days: readonly DayHours[],
  statusByRowId: ReadonlyMap<string, MonthStatus>,
): { confirmed: number; planned: number } {
  let confirmed = 0, planned = 0;
  for (const d of days) {
    const status = statusByRowId.get(monthRowId(d.assignmentId, monthOf(d.date)));
    if (status === undefined) continue;
    const h = Number.isFinite(d.hours) ? d.hours : 0;
    if (status === 'Allocated') { confirmed += h; planned += h; }
    else if (status === 'Requested') { planned += h; }
  }
  return { confirmed, planned };
}
