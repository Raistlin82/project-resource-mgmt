import { Resource, ResourceRequest, Assignment } from './api.service';

/**
 * Capacity / demand forecasting — a pure, framework-free module.
 *
 * Heuristics (kept deliberately simple and documented):
 *  - The horizon is a contiguous run of fixed-length periods (weekly by default,
 *    optionally monthly) starting at `startISO`. Each period is [start, end).
 *  - SUPPLY for a period = Σ resource.capacity (weekly hours). For a monthly
 *    horizon the weekly capacity is scaled up by WEEKS_PER_MONTH so supply and
 *    demand share the same per-period unit.
 *  - COMMITTED DEMAND = booked assignment hours, spread evenly across the booking
 *    window taken from the linked request's startDate/endDate. When the request
 *    (or its dates) is missing, the whole booking lands in the first period of
 *    the horizon ("current period") so it is never silently dropped.
 *  - PIPELINE DEMAND = requiredEffort of open / unfulfilled requests (those not
 *    yet fully staffed), spread evenly across the request's own window, with the
 *    same first-period fallback. Only the still-unstaffed remainder is counted.
 *  - DEMAND = committed + pipeline; UTILIZATION% = demand / supply × 100
 *    (0 when supply is 0 — explicit zero-capacity guard).
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
  /** demand / supply × 100; 0 when supply is 0. */
  utilizationPct: number;
  /** supply − demand (negative ⇒ over capacity). */
  gap: number;
}

/** A resource that is under-allocated, with its spare hours. */
export interface BenchEntry {
  resourceId: string;
  name: string;
  role: string;
  utilization: number;
  capacity: number;
  /** Spare hours this period = max(0, capacity − booked hours). */
  availableHours: number;
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
  const supplyScale = granularity === 'monthly' ? WEEKS_PER_MONTH : 1;
  const supply = sum(data.resources.map(r => finite(r.capacity))) * supplyScale;

  const requestById = new Map<string, ResourceRequest>();
  for (const r of data.requests) requestById.set(r.id, r);

  // Pre-resolve committed bookings (assignment hours + its window).
  const committedBookings = data.assignments.map(a => {
    const req = requestById.get(a.requestId);
    const win = resolveWindow(req?.startDate, req?.endDate, horizonStart);
    return { hours: finite(a.assignedHours), win };
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

    const committed = sum(
      committedBookings.map(b => b.hours * overlapFraction(b.win.start, b.win.end, pStart, pEnd)),
    );
    const pipeline = sum(
      pipelineBookings.map(b => b.hours * overlapFraction(b.win.start, b.win.end, pStart, pEnd)),
    );
    const demand = committed + pipeline;
    const utilizationPct = supply > 0 ? (demand / supply) * 100 : 0;

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

/** Total booked (assignment) hours for a resource across all assignments. */
function bookedHoursByResource(data: ForecastData): Map<string, number> {
  const booked = new Map<string, number>();
  for (const a of data.assignments) {
    booked.set(a.resourceId, finite(booked.get(a.resourceId)) + finite(a.assignedHours));
  }
  return booked;
}

/**
 * Under-allocated ("bench") resources: utilization strictly below `thresholdPct`
 * (default 80%). Reports spare hours = max(0, capacity − booked hours), sorted by
 * most available first. Zero-capacity resources are excluded (no real capacity).
 */
export function benchList(data: ForecastData, thresholdPct = 80): BenchEntry[] {
  const threshold = finite(thresholdPct);
  const booked = bookedHoursByResource(data);
  return data.resources
    .filter(r => finite(r.capacity) > 0 && finite(r.utilization) < threshold)
    .map(r => {
      const capacity = finite(r.capacity);
      const availableHours = Math.max(0, capacity - finite(booked.get(r.id)));
      return {
        resourceId: r.id,
        name: r.name,
        role: r.role,
        utilization: finite(r.utilization),
        capacity,
        availableHours,
      };
    })
    .sort((a, b) => b.availableHours - a.availableHours);
}

/**
 * Over-allocated resources: utilization at or above `thresholdPct` (default 110%,
 * i.e. the "over 100/110%" band). Reports hours booked beyond capacity, sorted by
 * most over first.
 */
export function overAllocated(data: ForecastData, thresholdPct = 110): OverAllocationEntry[] {
  const threshold = finite(thresholdPct);
  const booked = bookedHoursByResource(data);
  return data.resources
    .filter(r => finite(r.utilization) >= threshold)
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
 */
export function skillGap(data: ForecastData): SkillGapEntry[] {
  const openRequests = data.requests.filter(isOpenRequest);

  // Supply: resources possessing each skill (case-insensitive match).
  const supplyBySkill = new Map<string, number>();
  for (const res of data.resources) {
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
