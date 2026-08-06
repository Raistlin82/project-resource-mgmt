// LEGACY (B1): the weekly allocation-pct sweep here is superseded by the time-phased
// per-day allocation model (assignmentDays + calendar.util). Retained for the existing
// read-only Schedule timeline; prefer the per-day model for new allocation work.
/**
 * Pure, SSR-safe resource-schedule model + conflict detection.
 *
 * Approach B (bookable assignments): each assignment carries an explicit
 * booking window (startDate/endDate) and an allocationPct of the resource's
 * weekly capacity. This module resolves those bookings against time and runs a
 * sweep-line per resource to flag over-allocation — at any instant where the
 * summed allocationPct of concurrent active bookings exceeds 100%, every
 * booking active at that instant is flagged conflicting and the peak
 * over-allocation window is recorded.
 *
 * SSR safety: deterministic and side-effect-free. No Date.now / no DOM. Every
 * date is supplied via the input data and parsed with Date.parse (UTC epoch
 * ms), so geometry/results are stable across server and browser. Pixel layout
 * stays in the view; this module is purely logical/date-based.
 */
import type { Resource, ResourceRequest, Assignment } from './api.service';

/**
 * A booking window resolved to UTC epoch-ms bounds.
 *
 * `endDate` is an INCLUSIVE calendar day everywhere in this app (a booking dated
 * 01→30 September is worked ON the 30th), while the sweep below reasons over
 * half-open [start, end) intervals. The two are reconciled here, once: `end` is
 * the instant AFTER the last booked day, and `endInclusive` is the resolved
 * end as supplied, kept so the view still gets the dates the user typed.
 */
interface BookingWindow {
  /** First instant of the booking (inclusive). */
  start: number;
  /** Exclusive end = last booked day + 1 day. What the sweep compares against. */
  end: number;
  /** The resolved INCLUSIVE end, echoed back onto the booking for the view. */
  endInclusive: number;
}

/**
 * A single resolved booking on a resource lane. Dates are echoed back as the
 * ISO strings that were resolved (assignment's own dates, or the request's as a
 * fallback). `conflict` is set by the sweep when this booking is part of an
 * over-allocated instant.
 */
export interface ScheduleBooking {
  /** The assignment this booking was resolved from. */
  assignmentId: string;
  resourceId: string;
  /** The resource request the assignment is linked to. */
  requestId: string;
  /** Human label for the bar: request name / project, used by the view. */
  label: string;
  /** Resolved ISO booking start (YYYY-MM-DD or full ISO), inclusive. */
  startDate: string;
  /**
   * Resolved ISO booking end (YYYY-MM-DD or full ISO), INCLUSIVE: the last day
   * the resource is booked. The sweep internally works on [start, end+1day) —
   * see {@link BookingWindow} — but the dates echoed here are the ones that were
   * resolved, so the view's bar geometry and tooltips are unchanged by that.
   */
  endDate: string;
  /** Percentage of weekly capacity this booking consumes (defaults to 100 when unset). */
  allocationPct: number;
  /** True when this booking is active at an over-allocated (>100%) instant. */
  conflict: boolean;
}

/**
 * A recorded over-allocation for one resource: the peak summed allocation and
 * the contiguous window over which it occurred, plus the bookings involved.
 */
export interface ScheduleConflict {
  resourceId: string;
  /** Highest summed allocationPct reached anywhere in the window (> 100). */
  peakPct: number;
  /** ISO start of the offending (peak) window, inclusive. */
  windowStart: string;
  /** ISO end of the offending (peak) window, EXCLUSIVE (the day after the last over-allocated day). */
  windowEnd: string;
  /** Assignment ids of every booking active during the peak window. */
  bookingIds: string[];
}

/** One resource row in the timeline with its ordered bookings and roll-ups. */
export interface ResourceLane {
  resourceId: string;
  resourceName: string;
  role: string;
  /** Weekly capacity (hours) carried through from the resource for the view. */
  capacity: number;
  /** Bookings ordered by resolved start (then end), each flagged for conflict. */
  bookings: ScheduleBooking[];
  /** Peak summed allocationPct observed across this resource's timeline. */
  peakAllocationPct: number;
  /** True iff any instant exceeded 100% (i.e. conflicts is non-empty). */
  hasConflict: boolean;
}

/** The full schedule model: one lane per resource plus the flat conflict list. */
export interface ScheduleModel {
  lanes: ResourceLane[];
  conflicts: ScheduleConflict[];
}

const DAYS_PER_WEEK = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = DAYS_PER_WEEK * MS_PER_DAY;
const DEFAULT_ALLOCATION_PCT = 100;

/** Parse an ISO date to UTC epoch ms, or null when missing/unparseable. */
function parseMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Finite number or fallback (guards NaN/Infinity from inputs). */
function finite(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/**
 * Whole calendar weeks spanned by [startISO, endISO]. Returns the inclusive
 * count of week-columns the window touches (minimum 1 for any valid window),
 * or 0 when either bound is missing/unparseable or the window is inverted.
 * Pure date math — the view multiplies this by a pixel width for geometry.
 */
export function weeksBetween(startISO: string | undefined, endISO: string | undefined): number {
  const start = parseMs(startISO);
  const end = parseMs(endISO);
  if (start === null || end === null) return 0;
  if (end < start) return 0;
  return Math.max(1, Math.ceil((end - start) / MS_PER_WEEK));
}

/**
 * Resolve a booking window from an assignment, falling back to the linked
 * request's dates when the assignment has none of its own. Returns null when no
 * usable window can be resolved (the caller then skips the assignment).
 *
 * A window is "usable" only when both bounds parse and end >= start. The
 * assignment's own dates take precedence as a pair; if either is missing the
 * request's dates are tried as a pair. end === start is permitted — it is a
 * SAME-DAY booking, which still occupies a whole day of the resource, so it
 * resolves to the one-day-long interval [start, start + 1 day) and not to the
 * empty interval a naive half-open reading would give it.
 */
function resolveWindow(assignment: Assignment, request: ResourceRequest | undefined): BookingWindow | null {
  const aStart = parseMs(assignment.startDate);
  const aEnd = parseMs(assignment.endDate);
  if (aStart !== null && aEnd !== null && aEnd >= aStart) {
    return { start: aStart, end: aEnd + MS_PER_DAY, endInclusive: aEnd };
  }
  const rStart = parseMs(request?.startDate);
  const rEnd = parseMs(request?.endDate);
  if (rStart !== null && rEnd !== null && rEnd >= rStart) {
    return { start: rStart, end: rEnd + MS_PER_DAY, endInclusive: rEnd };
  }
  return null;
}

/** YYYY-MM-DD for a UTC epoch-ms instant; stable across time zones. */
function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Internal: a booking carried alongside its parsed window for the sweep. */
interface ResolvedBooking {
  booking: ScheduleBooking;
  window: BookingWindow;
}

/**
 * Sweep-line over a single resource's bookings. Boundaries are the distinct
 * start/end instants; between consecutive boundaries the set of active bookings
 * is constant. A booking is active over the half-open interval [start, end),
 * where `end` is already the day AFTER its inclusive endDate ({@link
 * BookingWindow}) — so two bookings that merely TOUCH on the calendar (one ends
 * 30 Sep, the next starts 30 Sep) are both active on that day and DO overlap,
 * while genuinely adjacent bookings (one ends 29 Sep, the next starts 30 Sep) do
 * not. Where the summed allocationPct of the active set exceeds 100%, every
 * active booking is flagged and a conflict window is recorded; contiguous
 * over-allocated segments are merged and reported at their peak.
 */
function sweepResource(resourceId: string, resolved: ResolvedBooking[]): { peakPct: number; conflicts: ScheduleConflict[] } {
  // Distinct, sorted boundary instants.
  const boundarySet = new Set<number>();
  for (const r of resolved) {
    boundarySet.add(r.window.start);
    boundarySet.add(r.window.end);
  }
  const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

  const conflicts: ScheduleConflict[] = [];
  let peakPct = 0;

  // Open conflict segment being accumulated across contiguous boundaries.
  let segStart: number | null = null;
  let segEnd = 0;
  let segPeak = 0;
  let segIds = new Set<string>();

  const closeSegment = () => {
    if (segStart !== null) {
      conflicts.push({
        resourceId,
        peakPct: segPeak,
        windowStart: toIsoDate(segStart),
        windowEnd: toIsoDate(segEnd),
        bookingIds: Array.from(segIds),
      });
    }
    segStart = null;
    segPeak = 0;
    segIds = new Set<string>();
  };

  // Each [boundaries[i], boundaries[i+1]) is a constant-active interval.
  for (let i = 0; i < boundaries.length - 1; i++) {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    if (hi <= lo) continue; // zero-length gap between coincident boundaries

    // Active set: bookings whose half-open window covers this interval.
    const active = resolved.filter((r) => r.window.start <= lo && r.window.end > lo);
    const sum = active.reduce((acc, r) => acc + r.booking.allocationPct, 0);
    if (sum > peakPct) peakPct = sum;

    if (sum > 100) {
      for (const r of active) r.booking.conflict = true;
      if (segStart === null) segStart = lo;
      segEnd = hi;
      if (sum > segPeak) segPeak = sum;
      for (const r of active) segIds.add(r.booking.assignmentId);
    } else {
      // A non-over-allocated interval breaks any open contiguous segment.
      closeSegment();
    }
  }
  closeSegment();

  return { peakPct, conflicts };
}

/**
 * Build the read-only schedule model from resources, assignments and requests.
 *
 * For each assignment the booking window is resolved (assignment dates, else
 * the linked request's dates); allocation defaults to 100; label is the
 * request name (falling back to the request id, then the assignment id).
 * Assignments with no resolvable window are skipped. Bookings are grouped by
 * resource, ordered by resolved start (then end), and a sweep-line per resource
 * flags over-allocation conflicts. Resources are emitted in the order supplied;
 * a resource with no bookings still yields an (empty) lane so the view renders
 * a complete roster.
 */
export function buildSchedule(
  resources: Resource[],
  assignments: Assignment[],
  requests: ResourceRequest[],
): ScheduleModel {
  const requestById = new Map<string, ResourceRequest>();
  for (const r of requests) requestById.set(r.id, r);

  // Resolve every assignment into a (booking, window) pair, grouped by resource.
  const byResource = new Map<string, ResolvedBooking[]>();
  for (const a of assignments) {
    const request = requestById.get(a.requestId);
    const window = resolveWindow(a, request);
    if (window === null) continue; // unresolvable window -> skip

    const booking: ScheduleBooking = {
      assignmentId: a.id,
      resourceId: a.resourceId,
      requestId: a.requestId,
      label: request?.name ?? a.requestId ?? a.id,
      startDate: toIsoDate(window.start),
      // The INCLUSIVE end, not window.end: the +1 day the sweep needs must not
      // leak into the view, or every bar grows a day and the tooltip reads an
      // end one day late.
      endDate: toIsoDate(window.endInclusive),
      allocationPct: finite(a.allocationPct, DEFAULT_ALLOCATION_PCT),
      conflict: false,
    };
    const list = byResource.get(a.resourceId);
    if (list) list.push({ booking, window });
    else byResource.set(a.resourceId, [{ booking, window }]);
  }

  const lanes: ResourceLane[] = [];
  const conflicts: ScheduleConflict[] = [];

  for (const resource of resources) {
    const resolved = byResource.get(resource.id) ?? [];
    // Stable ordering for the view: by resolved start, then end.
    resolved.sort((a, b) => a.window.start - b.window.start || a.window.end - b.window.end);

    const { peakPct, conflicts: laneConflicts } = sweepResource(resource.id, resolved);
    conflicts.push(...laneConflicts);

    lanes.push({
      resourceId: resource.id,
      resourceName: resource.name,
      role: resource.role,
      capacity: finite(resource.capacity, 0),
      bookings: resolved.map((r) => r.booking),
      peakAllocationPct: peakPct,
      hasConflict: laneConflicts.length > 0,
    });
  }

  return { lanes, conflicts };
}
