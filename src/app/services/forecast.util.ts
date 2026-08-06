import { Resource, ResourceRequest, Assignment, AssignmentDay, AssignmentMonth, Holiday } from './api.service';
import { countsTowardDeliveryCapacity, kindOf } from './resource-kind.util';
import { DayHours, MonthStatus, monthRowId, monthlyAggregateHours } from './allocation-month.util';
import { employedWorkingDays, monthsInRange, semaphoreBand } from './capacity.util';
import { workingDaysInMonth } from './calendar.util';

/**
 * Capacity / demand forecasting — a pure, framework-free module.
 *
 * Heuristics (kept deliberately simple and documented):
 *  - The horizon is a contiguous run of fixed-length periods (weekly by default,
 *    optionally monthly) starting at `startISO`. Each period is [start, end).
 *  - SUPPLY for a period = Σ resource.capacity (weekly hours) over resources that
 *    count toward DELIVERY capacity (C1: `internal` + `subco`, excluding `dummy`
 *    — a dummy is a placeholder for a hole to be filled, not capacity the
 *    organisation can staff work with today; a subco IS deliverable capacity,
 *    just not internal — see `countsTowardDeliveryCapacity`), each **pro-rated to
 *    the working days of that period they were actually employed for**
 *    (`employedWorkingDays`, the same helper `rollupMonthly`/`benchRollup` use).
 *    Supply is therefore PER-PERIOD, not a constant: a leaver stops contributing
 *    the day they go and a future hire starts contributing the day she arrives.
 *    For a monthly horizon the weekly capacity is scaled up by WEEKS_PER_MONTH so
 *    supply and demand share the same per-period unit.
 *  - COMMITTED DEMAND = each assignment's CONFIRMED hours — aggregated from its
 *    day rows weighted by the status of the MONTH each day falls in
 *    (`monthlyAggregateHours`, the server's single definition of confirmed) —
 *    spread evenly across the booking window taken from the linked request's
 *    startDate/endDate. When the request (or its dates) is missing, the whole
 *    booking lands in the first period of the horizon ("current period") so it
 *    is never silently dropped.
 *  - PIPELINE DEMAND = requiredEffort of open / unfulfilled requests (those not
 *    yet fully staffed), spread evenly across the request's own window, with the
 *    same first-period fallback. Only the still-unstaffed remainder is counted.
 *  - DEMAND = committed + pipeline; UTILIZATION% = demand / supply × 100, or
 *    **null when the period has no supply at all** — see `utilizationPct`.
 *  - GAP = supply − demand (positive ⇒ spare capacity, negative ⇒ shortfall).
 *
 * Every public function tolerates malformed numbers (NaN / Infinity / missing)
 * via Number.isFinite guards and never throws on bad input.
 */

/** All raw data needed to build a capacity forecast. */
export interface ForecastData {
  resources: Resource[];
  requests: ResourceRequest[];
  assignments: Assignment[];
  assignmentDays: AssignmentDay[];
  assignmentMonths: AssignmentMonth[];
  holidays: Holiday[];
  hoursPerDay: number;
}

export type ForecastGranularity = 'weekly' | 'monthly';

/** One period row of the rolling forecast. */
export interface CapacityPeriod {
  /** Inclusive ISO date (YYYY-MM-DD) of the period start. */
  period: string;
  /** Σ resource capacity available in the period (hours). */
  supply: number;
  /** Booked assignment hours falling in the period. */
  committed: number;
  /** Unstaffed open-request hours falling in the period. */
  pipeline: number;
  /** committed + pipeline. */
  demand: number;
  /**
   * demand / supply × 100, or **null when the period has no supply**.
   *
   * `null` means "no answer", NOT 0%. Once supply became period-dependent (a
   * leaver stops contributing, a future hire has not arrived yet) a period can
   * legitimately have no capacity to measure against, and a 0 there is a lie in
   * the dangerous direction: `forecastUtilizationBand` would paint it as spare
   * capacity, the KPI average would drag the whole horizon down, and the CSV
   * cell would be indistinguishable from a genuinely idle week. Every consumer
   * must render it as unavailable instead — withheld is not zero.
   */
  utilizationPct: number | null;
  /** supply − demand (negative ⇒ over capacity). */
  gap: number;
}

/** A resource booked beyond a utilization threshold. */
export interface OverAllocationEntry {
  resourceId: string;
  name: string;
  role: string;
  utilization: number;
  capacity: number;
  /** Hours booked beyond capacity = max(0, booked − capacity). */
  overByHours: number;
}

/** Demand vs covered supply for a single required skill. */
export interface SkillGapEntry {
  skill: string;
  /** Number of open requests demanding the skill. */
  demandCount: number;
  /** Unstaffed effort (hours) across those requests. */
  demandHours: number;
  /** Resources that possess the skill (any level). */
  supplyCount: number;
  /** True when demand exists but no resource covers the skill. */
  shortage: boolean;
}

const MS_PER_DAY = 86_400_000;
const DAYS_PER_WEEK = 7;
/** Average weeks in a calendar month — used only to scale weekly→monthly units. */
const WEEKS_PER_MONTH = 52 / 12;

const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + finite(b), 0);

function strictIsoDay(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(ms).toISOString().slice(0, 10);
  return roundTrip === iso ? ms : null;
}

/** A what-if demand must have both valid bounds in chronological order. */
export function isCompleteForecastWindow(startIso: string, endIso: string): boolean {
  const start = strictIsoDay(startIso);
  const end = strictIsoDay(endIso);
  return start !== null && end !== null && end >= start;
}

/**
 * Paint band for a utilisation figure on the Capacity Control screens.
 *
 *  - `unknown` — no utilisation exists (no supply in the period): render "n/a"
 *    with NO tone. Never a colour, because every colour would be a claim.
 *  - `spare`   — below the healthy band. A CAUTION, not health: unsold capacity
 *    is the bench bill. This is the half that was inverted — /forecast painted
 *    <85% green while /what-if called the same move bad, so one 45% average was
 *    simultaneously healthy on one screen and a crisis on the other.
 *  - `healthy` — inside the semaphore's healthy band (85–105%).
 *  - `over`    — above it.
 */
export type UtilizationBand = 'unknown' | 'spare' | 'healthy' | 'over';

/**
 * The ONE utilisation paint rule shared by /forecast and /what-if, delegating to
 * the repo's existing `semaphoreBand`/`SEMAPHORE_THRESHOLDS` (capacity.util.ts)
 * rather than re-deriving a second ladder — a second ladder is exactly how the
 * two screens came to disagree. `idle` and `under` collapse into one caution
 * tone here because this surface only has three colours to spend.
 *
 * NOT to be conflated with {@link utilizationChangeTone} below: that answers a
 * different question (did this scenario move TOWARD or AWAY FROM the healthy
 * band) and its 80/100 bounds are a delta reference, not a paint rule. Aligning
 * the two sets of bounds would move what-if's delta colours and is a separate,
 * deliberate decision.
 */
export function forecastUtilizationBand(utilizationPct: number | null): UtilizationBand {
  // Non-finite is treated as "no answer" too: semaphoreBand(NaN) falls through
  // to 'over', so a poisoned number would otherwise paint a confident red.
  if (utilizationPct === null || !Number.isFinite(utilizationPct)) return 'unknown';
  const band = semaphoreBand(utilizationPct);
  if (band === 'idle' || band === 'under') return 'spare';
  return band === 'healthy' ? 'healthy' : 'over';
}

export type UtilizationChangeTone = 'good' | 'bad' | 'neutral';

/** Compare utilization by distance from the healthy 80–100% operating band. */
export function utilizationChangeTone(
  basePct: number,
  scenarioPct: number,
  healthyMin = 80,
  healthyMax = 100,
): UtilizationChangeTone {
  const distance = (value: number) => {
    const pct = finite(value);
    if (pct < healthyMin) return healthyMin - pct;
    if (pct > healthyMax) return pct - healthyMax;
    return 0;
  };
  const baseDistance = distance(basePct);
  const scenarioDistance = distance(scenarioPct);
  if (scenarioDistance < baseDistance) return 'good';
  if (scenarioDistance > baseDistance) return 'bad';
  return 'neutral';
}

/** Parse an ISO date to epoch ms, or null when unparseable. */
function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** YYYY-MM-DD for an epoch-ms instant (UTC), stable across time zones. */
function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Days in a period for the chosen granularity (weeks are exact; months use a 30-day proxy). */
function periodLengthDays(granularity: ForecastGranularity): number {
  return granularity === 'monthly' ? 30 : DAYS_PER_WEEK;
}

/**
 * The days inside a window (BOTH bounds inclusive) that `monthDays` reports for
 * the calendar months the window touches.
 *
 * A forecast period is a rolling 7- (or 30-) day run from the horizon start, so it
 * is NOT a calendar month and can straddle two of them — hence the per-month walk.
 * `monthDays` is one of exactly two landed helpers, never a re-derived interval
 * test: `workingDaysInMonth` (the window's own working days) or
 * `employedWorkingDays` bound to one person (the subset of those she was employed
 * for). Calling them means /forecast measures employment against the very calendar
 * /capacity and /bench measure it against.
 */
function windowDays(
  firstIso: string,
  lastIso: string,
  monthDays: (month: string) => readonly string[],
): string[] {
  const out: string[] = [];
  for (const month of monthsInRange(firstIso.slice(0, 7), lastIso.slice(0, 7))) {
    for (const d of monthDays(month)) if (d >= firstIso && d <= lastIso) out.push(d);
  }
  return out;
}

/**
 * Fraction of [bookStart, bookEnd] that overlaps [periodStart, periodEnd).
 * A zero-length (or inverted) booking window contributes its whole weight to the
 * period that contains its start instant. Returns a value in [0, 1].
 */
function overlapFraction(
  bookStart: number,
  bookEnd: number,
  periodStart: number,
  periodEnd: number,
): number {
  // Degenerate / inverted window: treat as a point at bookStart.
  if (!(bookEnd > bookStart)) {
    return bookStart >= periodStart && bookStart < periodEnd ? 1 : 0;
  }
  const lo = Math.max(bookStart, periodStart);
  const hi = Math.min(bookEnd, periodEnd);
  if (hi <= lo) return 0;
  const span = bookEnd - bookStart;
  return span > 0 ? (hi - lo) / span : 0;
}

interface Window {
  start: number;
  end: number;
}

/**
 * Resolve a demand window from optional ISO dates, falling back to the first
 * period of the horizon when either bound is missing/invalid. The fallback
 * window is a single point at `horizonStart`, which lands fully in period 0.
 */
function resolveWindow(
  startIso: string | undefined,
  endIso: string | undefined,
  horizonStart: number,
): Window {
  const start = parseMs(startIso);
  const end = parseMs(endIso);
  if (start === null || end === null) return { start: horizonStart, end: horizonStart };
  return { start, end };
}

/** Total hours still needing staffing on a request = max(0, requiredEffort − staffedEffort). */
function unstaffedEffort(r: ResourceRequest): number {
  return Math.max(0, finite(r.requiredEffort) - finite(r.staffedEffort));
}

/** Open / unfulfilled requests: not Closed/Fulfilled/Cancelled and with remaining effort. */
function isOpenRequest(r: ResourceRequest): boolean {
  const status = (r.status ?? '').toLowerCase();
  const closed = status === 'fulfilled' || status === 'closed' || status === 'cancelled' || status === 'staffed';
  return !closed && unstaffedEffort(r) > 0;
}

/**
 * CONFIRMED hours per assignment id, aggregated from the assignment's own day
 * rows weighted by the status of the MONTH each day falls in — i.e. through
 * `monthlyAggregateHours`, the same pure rule the server and the capacity
 * dashboard use, so the client never invents a second definition of "confirmed".
 *
 * This replaced an all-or-nothing filter on `Assignment.status` +
 * `assignedHours`. `Assignment.status` is a DERIVED rollup
 * (`deriveAssignmentStatus`, precedence Requested > Rejected > Allocated >
 * Draft), so one September month still awaiting a decision made the whole
 * assignment read 'Requested' and erased its already-APPROVED August hours from
 * committed demand: 160 board-approved hours contributing exactly 0.00 to the
 * forecast, the Committed bar and the CSV. The inverse was equally wrong —
 * [Allocated 100h, Draft 100h] rolls up to 'Allocated' and counted all 200h.
 *
 * Two documented consequences of going through the month rows, both asserted in
 * the spec: a month row with a non-confirmed status contributes nothing, and an
 * assignment with NO month row at all contributes nothing (B1 self-healing rule
 * — legacy day rows stay out of the aggregates until their first calendar edit).
 */
function confirmedHoursByAssignment(data: ForecastData): Map<string, number> {
  const statusByRowId = new Map<string, MonthStatus>(
    data.assignmentMonths.map(m => [monthRowId(m.assignmentId, m.month), m.status]),
  );
  const daysByAssignment = new Map<string, DayHours[]>();
  for (const d of data.assignmentDays) {
    const list = daysByAssignment.get(d.assignmentId);
    if (list) list.push(d);
    else daysByAssignment.set(d.assignmentId, [d]);
  }
  const confirmed = new Map<string, number>();
  for (const [assignmentId, days] of daysByAssignment) {
    confirmed.set(assignmentId, monthlyAggregateHours(days, statusByRowId).confirmed);
  }
  return confirmed;
}

/**
 * Build a rolling capacity forecast: `periods` rows of fixed length starting at
 * `startISO`. Supply, committed demand, pipeline demand, utilization and gap are
 * computed per period. Returns an empty array for non-positive `periods` or an
 * unparseable `startISO`.
 */
export function capacityForecast(
  data: ForecastData,
  startISO: string,
  periods: number,
  granularity: ForecastGranularity = 'weekly',
): CapacityPeriod[] {
  const n = Math.floor(finite(periods));
  const horizonStart = parseMs(startISO);
  if (n <= 0 || horizonStart === null) return [];

  const lenDays = periodLengthDays(granularity);
  const lenMs = lenDays * MS_PER_DAY;
  // Weekly supply scaled to the period unit (×1 weekly, ×~4.33 monthly).
  // C1: only resources that count toward DELIVERY capacity contribute —
  // a dummy has no capacity to deliver with yet; a subco does.
  const supplyScale = granularity === 'monthly' ? WEEKS_PER_MONTH : 1;
  const deliveryResources = data.resources.filter(r => countsTowardDeliveryCapacity(kindOf(r)));
  // The same calendar `rollupMonthly`/`benchRollup` use, and the reason
  // `ForecastData.holidays` exists: it used to be fetched and then never read here.
  const holidaySet: ReadonlySet<string> = new Set(data.holidays.map(h => h.id));

  const requestById = new Map<string, ResourceRequest>();
  for (const r of data.requests) requestById.set(r.id, r);

  // Pre-resolve committed bookings: the assignment's CONFIRMED hours (from its
  // month rows — see confirmedHoursByAssignment), time-phased over the linked
  // REQUEST's window (resolveWindow below reads req.startDate/endDate, not the
  // assignment's own dates). That is P1-16's remaining half — recorded in the
  // reconciliation report's §10, not silently — so this comment must not read as
  // "the assignment's window".
  const confirmedByAssignment = confirmedHoursByAssignment(data);
  const committedBookings = data.assignments.map(a => {
    const req = requestById.get(a.requestId);
    const win = resolveWindow(req?.startDate, req?.endDate, horizonStart);
    return { hours: finite(confirmedByAssignment.get(a.id)), win };
  });

  // Pre-resolve pipeline bookings (unstaffed effort of open requests + their window).
  const pipelineBookings = data.requests.filter(isOpenRequest).map(r => {
    const win = resolveWindow(r.startDate, r.endDate, horizonStart);
    return { hours: unstaffedEffort(r), win };
  });

  const rows: CapacityPeriod[] = [];
  for (let i = 0; i < n; i++) {
    const pStart = horizonStart + i * lenMs;
    const pEnd = pStart + lenMs;

    // Supply is resolved INSIDE the loop, PRO-RATED to the working days of this
    // period each person was actually employed for. Employment is measured in
    // DAYS, not months, because that is the only granularity that can agree with
    // the API: the server accepts or refuses a booked day against employment ONE
    // DAY AT A TIME (`bookingOutsideEmploymentError`), and /capacity and /bench
    // already measure it that way through this same `employedWorkingDays`.
    //
    // Both ends were wrong under the previous month-granular presence test, and a
    // week is the sharpest place to see it:
    //  - JOINER: `isActiveInMonth` compared `hireDate` with the month's START, so
    //    someone hired on the 17th contributed NOTHING for any week of her hire
    //    month — including the weeks she works, whose hours /allocation-calendar
    //    happily books. Merely admitting the month instead would have flipped that
    //    into the opposite lie: a full 40h/week of supply for the weeks that ended
    //    BEFORE she arrived.
    //  - LEAVER: the whole month counted in full, so someone who went on the 15th
    //    still advertised 40h/week for the weeks after they left.
    // Pro-rating answers both with one rule, and it is the rule `rollupMonthly`
    // already settled on (capacity.util.ts:178-183) — not a second convention.
    const pFirstIso = toIsoDate(pStart);
    const pLastIso = toIsoDate(pEnd - MS_PER_DAY);
    const periodWorkingDays = windowDays(pFirstIso, pLastIso, m => workingDaysInMonth(m, holidaySet));
    const supply = sum(
      deliveryResources.map(r => {
        const employed = windowDays(pFirstIso, pLastIso, m => employedWorkingDays(r, m, holidaySet));
        // `employed` is a subset of `periodWorkingDays` (same months, same window
        // filter, and employedWorkingDays filters workingDaysInMonth), so a
        // non-empty `employed` guarantees a non-zero denominator here. A person
        // employed for every working day of the period keeps EXACTLY her capacity:
        // the ratio is 1, integer over identical integer, so a full-time team's
        // supply is untouched to the last bit — and holidays cancel out of both
        // sides, as they do in `rollupMonthly`'s FTE.
        if (employed.length === 0) return 0;
        return finite(r.capacity) * supplyScale * (employed.length / periodWorkingDays.length);
      }),
    );

    const committed = sum(
      committedBookings.map(b => b.hours * overlapFraction(b.win.start, b.win.end, pStart, pEnd)),
    );
    const pipeline = sum(
      pipelineBookings.map(b => b.hours * overlapFraction(b.win.start, b.win.end, pStart, pEnd)),
    );
    const demand = committed + pipeline;
    // null, NOT 0: no capacity in the period means there is nothing to measure
    // against, and a 0 here reads as "idle" — the healthy-looking answer. See
    // `CapacityPeriod.utilizationPct`.
    const utilizationPct = supply > 0 ? (demand / supply) * 100 : null;

    rows.push({
      period: toIsoDate(pStart),
      supply,
      committed,
      pipeline,
      demand,
      utilizationPct,
      gap: supply - demand,
    });
  }
  return rows;
}

/**
 * Total CONFIRMED hours per resource across all their assignments — the same
 * month-row aggregation `capacityForecast` uses, deliberately not a second
 * definition. Feeds `overAllocated`'s "Over by" column, which carried the
 * identical all-or-nothing bug: one un-approved month zeroed the whole
 * assignment's contribution, so a resource 200h over capacity reported 0h over.
 */
function bookedHoursByResource(data: ForecastData): Map<string, number> {
  const confirmedByAssignment = confirmedHoursByAssignment(data);
  const booked = new Map<string, number>();
  for (const a of data.assignments) {
    booked.set(a.resourceId, finite(booked.get(a.resourceId)) + finite(confirmedByAssignment.get(a.id)));
  }
  return booked;
}

// `benchList`/`BenchEntry` (utilization-scalar heuristic) retired here — Block F
// design spec §9 decision 2. See `notFullyAllocatedAt` (bench.util.ts) and
// this file's consumers (forecast.ts, what-if.ts) for the replacement.

/**
 * Over-allocated resources: utilization at or above `thresholdPct` (default 110%,
 * i.e. the "over 100/110%" band). Reports hours booked beyond capacity, sorted by
 * most over first.
 *
 * C1: a dummy never appears here — a placeholder has no real allocation to be
 * "over" on — while a subco does, since it IS deliverable capacity that can be
 * over-booked just like an internal resource (`countsTowardDeliveryCapacity`).
 */
export function overAllocated(data: ForecastData, thresholdPct = 110): OverAllocationEntry[] {
  const threshold = finite(thresholdPct);
  const booked = bookedHoursByResource(data);
  return data.resources
    .filter(r => countsTowardDeliveryCapacity(kindOf(r)) && finite(r.utilization) >= threshold)
    .map(r => {
      const capacity = finite(r.capacity);
      const overByHours = Math.max(0, finite(booked.get(r.id)) - capacity);
      return {
        resourceId: r.id,
        name: r.name,
        role: r.role,
        utilization: finite(r.utilization),
        capacity,
        overByHours,
      };
    })
    .sort((a, b) => b.utilization - a.utilization);
}

/**
 * Per-required-skill demand vs covered supply. For every distinct skill named on
 * an open request, counts how many open requests need it, the unstaffed hours
 * behind that demand, and how many resources possess the skill (at any level).
 * `shortage` is true when there is demand but zero covering resources. Sorted
 * shortages first, then by demand hours.
 *
 * `asOfMonth` ('YYYY-MM') is REQUIRED, not optional: coverage is only real for
 * people who are actually employed then. A departed colleague's skills used to
 * count as capability, which inflated `supplyCount` and flipped both badges the
 * wrong way — 'Thin' became 'Covered', and where the leaver was the ONLY holder
 * of a skill `shortage` flipped from true to false, suppressing exactly the
 * hire/subcontract signal this table exists to raise. Making the parameter
 * mandatory is the point: an omitted month would silently restore that hole.
 */
export function skillGap(data: ForecastData, asOfMonth: string): SkillGapEntry[] {
  const openRequests = data.requests.filter(isOpenRequest);

  // Supply: employed resources possessing each skill (case-insensitive match).
  // Employment is measured in DAYS here too (`employedWorkingDays`), so somebody
  // hired on the 17th covers her skill in her hire month — she can be booked on
  // every one of those days. The month-granular test used to answer "no", which
  // reported a shortage the org had just hired against. This is a COUNT of people,
  // not a sum of hours, so there is nothing to pro-rate: the question is only
  // whether the person can work at all in the month.
  const holidaySet: ReadonlySet<string> = new Set(data.holidays.map(h => h.id));
  const covering = data.resources.filter(
    r => countsTowardDeliveryCapacity(kindOf(r)) && employedWorkingDays(r, asOfMonth, holidaySet).length > 0,
  );
  const supplyBySkill = new Map<string, number>();
  for (const res of covering) {
    for (const s of res.skills ?? []) {
      const key = (s?.name ?? '').toLowerCase();
      if (!key) continue;
      supplyBySkill.set(key, finite(supplyBySkill.get(key)) + 1);
    }
  }

  // Demand: aggregate count + unstaffed hours per skill from open requests.
  const demand = new Map<string, { label: string; count: number; hours: number }>();
  for (const r of openRequests) {
    const effort = unstaffedEffort(r);
    for (const raw of r.skills ?? []) {
      const label = (raw ?? '').trim();
      const key = label.toLowerCase();
      if (!key) continue;
      const cur = demand.get(key) ?? { label, count: 0, hours: 0 };
      cur.count += 1;
      cur.hours += effort;
      demand.set(key, cur);
    }
  }

  const entries: SkillGapEntry[] = [];
  for (const [key, d] of demand) {
    const supplyCount = finite(supplyBySkill.get(key));
    entries.push({
      skill: d.label,
      demandCount: d.count,
      demandHours: d.hours,
      supplyCount,
      shortage: supplyCount === 0,
    });
  }

  return entries.sort((a, b) => {
    if (a.shortage !== b.shortage) return a.shortage ? -1 : 1;
    return b.demandHours - a.demandHours;
  });
}
