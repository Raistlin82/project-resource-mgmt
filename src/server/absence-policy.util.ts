/**
 * Block H — the SERVER-side rules for resource absences and engagement
 * classification (design spec §6, §7).
 *
 * Everything here is PURE and importable. `src/server.ts` instantiates the
 * Angular SSR engine at module scope, so Vitest cannot import it at all: any
 * rule that lives only inside a handler there is, by construction, untestable.
 * That is the repo convention, and for this block it is load-bearing twice over
 * — both ORDER-SENSITIVE authorization tables below are exported as single
 * arrays precisely so the order can be asserted rather than read.
 *
 * PRIVACY INVARIANT (spec §3.4): nothing in this file branches on
 * `reasonCode`. The derivation feed is {@link redactAbsence}'s four fields, and
 * the compiler enforces that a stored row cannot be served on that path.
 */

import type {
  AbsenceReasonCode,
  ProjectType,
  RedactedAbsence,
  ResourceAbsence,
  UserRole,
} from '../app/services/api.service';
import { isStrictIsoDate } from './operational-integrity.util';
import type { MutationRule } from './route-policy.util';

/**
 * TYPE-ONLY imports from `api.service`, like every other server-side module —
 * so these two enum mirrors are declared here rather than imported as runtime
 * values. A bare `readonly AbsenceReasonCode[]` literal would catch a typo but
 * NOT a MISSING member, which is the direction that matters: a seventh reason
 * added to the client contract would silently be rejected by the API with a
 * message listing six. `Record<Union, true>` fails to compile in BOTH
 * directions — unknown key and missing key — so the mirror cannot drift.
 */
const ABSENCE_REASON_CODE_KEYS: Record<AbsenceReasonCode, true> = {
  Maternity: true, ParentalLeave: true, Vacation: true, Sickness: true, Indisposition: true, Other: true,
};
export const ABSENCE_REASON_CODE_VALUES =
  Object.keys(ABSENCE_REASON_CODE_KEYS) as readonly AbsenceReasonCode[];

const PROJECT_TYPE_KEYS: Record<ProjectType, true> = { Delivery: true, Basket: true };
export const PROJECT_TYPE_VALUES = Object.keys(PROJECT_TYPE_KEYS) as readonly ProjectType[];

function isAbsenceReasonCode(value: unknown): value is AbsenceReasonCode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(ABSENCE_REASON_CODE_KEYS, value);
}

function isProjectType(value: unknown): value is ProjectType {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(PROJECT_TYPE_KEYS, value);
}

// ---------------------------------------------------------------------------
// Audiences (spec §7)
// ---------------------------------------------------------------------------

/**
 * Who may learn that a person is unavailable — the `/capacity`, `/bench` and
 * `/absences/calendar` audience. ONE exported constant used by all three rules
 * in `src/server.ts`, not three literals that agree today: the redacted
 * calendar exists to serve exactly the planners those rollups already serve,
 * and a copy of the list is a copy that can drift on the next edit.
 *
 * Deliberately excludes `employee` (an org-wide roster of who is away is
 * sensitive) and `sales` (no staffing need-to-know).
 */
export const AVAILABILITY_READ_ROLES: readonly UserRole[] = [
  'pm', 'resource-manager', 'delivery-executive', 'finance', 'admin',
];

/**
 * Who may read the REASON (spec §7.3, GDPR art. 9 special-category data) for
 * ANY person.
 *
 * `delivery-executive` is here by an explicit product decision of 2026-08-07
 * (spec §10, Q5): it already reads `GET /audit-logs`, where the append-only
 * middleware's diff of an absence row necessarily carries `reasonCode`, and the
 * alternative was to invent per-field redaction inside that middleware. The
 * access to special-category data is therefore widened DELIBERATELY, from
 * `admin` to `admin` + `delivery-executive`. Recorded here and in
 * `docs/roles-and-permissions.md` so a later review finds the reason and not a
 * hole.
 */
export const ABSENCE_REASON_AUDIENCE: readonly UserRole[] = [
  'resource-manager', 'delivery-executive', 'admin',
];

/**
 * The READ_RULE for `GET /absences`. A READ_RULE is per-PATH, never per-row, so
 * `employee` has to be admitted by the rule for the handler to be reached at
 * all — and the handler then narrows an `employee` to their OWN rows
 * ({@link absenceReadScope}). Admitting the role and filtering the rows is the
 * only shape that expresses "may see their own leave, nobody else's".
 */
export const ABSENCE_REASON_READ_ROLES: readonly UserRole[] = [
  ...ABSENCE_REASON_AUDIENCE, 'employee',
];

/**
 * Who may RECORD an absence (spec §7.1). Q5 moved `delivery-executive` into the
 * reason audience for READS only — the write set is unchanged, because Q5 was
 * about who may learn the reason, not about who owns the HR fact.
 *
 * `pm` is excluded deliberately: declaring a colleague absent removes them from
 * bench and from staffing availability, i.e. moves a metric the PM is measured
 * on. `employee` is excluded because there is no leave-REQUEST workflow — a
 * self-service create would let anyone take themselves off the bench.
 */
export const ABSENCE_WRITE_ROLES: readonly UserRole[] = ['resource-manager', 'admin'];

/**
 * Who may re-classify an engagement (spec §7.2) — RPT's WFM / Delivery
 * Excellence, plus finance because the flag switches off a revenue expectation
 * and its margin alerts.
 *
 * `pm` is excluded although it may mutate `/projects`: whoever is measured on
 * an engagement's margin must not be able to declare that the engagement has no
 * margin. Same argument, verbatim, as the `/cost-baselines` rule.
 */
export const PROJECT_CLASSIFICATION_ROLES: readonly UserRole[] = [
  'delivery-executive', 'finance', 'admin',
];

/** Does this principal see every absence row, or only their own? */
export function absenceReadScope(roles: readonly UserRole[]): 'all' | 'own' {
  return roles.some(role => ABSENCE_REASON_AUDIENCE.includes(role)) ? 'all' : 'own';
}

// ---------------------------------------------------------------------------
// Order-sensitive rule tables
// ---------------------------------------------------------------------------

/** True for the redacted availability feed, and ONLY for it. */
export function isAbsenceCalendarPath(path: string): boolean {
  return path === '/absences/calendar';
}

/**
 * The absence slice of READ_RULES, ORDER-SENSITIVE and exported as ONE array so
 * the order cannot be lost at the call site.
 *
 * `READ_RULES.find` returns the FIRST match. Put `/absences` first and
 * `/absences/calendar` inherits the reason audience — at which point the
 * redacted projection protects nothing while still reading like it does, and
 * every planner loses the feed as well. Note that the middleware tests
 * `normalizeApiPath(req.path)`, so `GET /api/Absences/Calendar` is normalised
 * before it gets here (the defect already paid for on `GET /api/Audit-Logs`).
 */
export const ABSENCE_READ_RULES: readonly MutationRule[] = [
  { test: isAbsenceCalendarPath, roles: AVAILABILITY_READ_ROLES },
  {
    test: path => path === '/absences' || path.startsWith('/absences/'),
    roles: ABSENCE_REASON_READ_ROLES,
  },
];

/** The absence slice of the mutation table. Recording is HR-owned (spec §7.1). */
export const ABSENCE_MUTATION_RULES: readonly MutationRule[] = [
  {
    test: path => path === '/absences' || path.startsWith('/absences/'),
    roles: ABSENCE_WRITE_ROLES,
  },
];

const PROJECT_CLASSIFICATION_PATH = /^\/projects\/[^/]+\/classification$/;

/** True for `PUT /projects/:id/classification`, and only for it. */
export function isProjectClassificationPath(path: string): boolean {
  return PROJECT_CLASSIFICATION_PATH.test(path);
}

const PROJECT_SLICE_PREFIXES = [
  '/projects', '/project-partners', '/project-documents', '/work-packages',
  '/milestones', '/project-tasks', '/project-issues', '/change-requests',
];

/**
 * The project slice of the mutation table, ORDER-SENSITIVE and exported as ONE
 * array for the same reason as `COMMERCIAL_MUTATION_RULES`: the narrow
 * classification rule (finance-grade) MUST precede the coarse `/projects`
 * prefix rule, which admits `pm`. Reversed, the coarse rule intercepts
 * `/projects/3/classification`, a PM can declare an engagement non-billable,
 * and the narrow rule becomes dead code that still reads as a guard.
 */
export const PROJECT_MUTATION_RULES: readonly MutationRule[] = [
  { test: isProjectClassificationPath, roles: PROJECT_CLASSIFICATION_ROLES },
  {
    test: path => PROJECT_SLICE_PREFIXES.some(prefix => path.startsWith(prefix)),
    roles: ['pm', 'delivery-executive', 'admin'],
  },
];

// ---------------------------------------------------------------------------
// Absence write validation
// ---------------------------------------------------------------------------

/**
 * The `pick()` allow-list for an absence write. `recordedBy`/`recordedAt` are
 * ABSENT on purpose — that absence is what makes them unforgeable on create AND
 * unchangeable by the PUT, which shares this list, exactly like
 * `createdBy`/`requestedBy` elsewhere. The SoD rule (spec §7.4) compares the
 * subject against the VERIFIED actor, so a client-settable `recordedBy` would
 * not merely mis-attribute the row, it would make that comparison meaningless.
 */
export const ABSENCE_FIELDS = ['resourceId', 'startDate', 'endDate', 'reasonCode', 'note'] as const;

/** The shape of an absence interval this layer reasons about: WHO and WHEN. */
export interface AbsenceRange {
  resourceId: string;
  startDate: string;
  endDate: string;
}

/**
 * Validate the picked body of a CREATE. Every field is required: an absence
 * with no end date is not a partial record, it is an unbounded one.
 */
export function absenceCreateError(body: Partial<Record<string, unknown>>): string | null {
  if (typeof body['resourceId'] !== 'string' || body['resourceId'] === '') {
    return 'resourceId is required';
  }
  return absenceFieldError(body, true);
}

/** Validate the picked body of a PATCH — only supplied fields are checked. */
export function absencePatchError(body: Partial<Record<string, unknown>>): string | null {
  if (Object.prototype.hasOwnProperty.call(body, 'resourceId')
      && (typeof body['resourceId'] !== 'string' || body['resourceId'] === '')) {
    return 'resourceId must reference an existing resource';
  }
  return absenceFieldError(body, false);
}

function absenceFieldError(body: Partial<Record<string, unknown>>, required: boolean): string | null {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);
  for (const field of ['startDate', 'endDate'] as const) {
    if (!has(field)) {
      if (required) return `${field} is required and must match YYYY-MM-DD`;
      continue;
    }
    if (!isStrictIsoDate(body[field])) return `${field} must match YYYY-MM-DD`;
  }
  if (required || (has('reasonCode'))) {
    if (!isAbsenceReasonCode(body['reasonCode'])) {
      return `reasonCode must be one of: ${ABSENCE_REASON_CODE_VALUES.join(', ')}`;
    }
  }
  if (has('note') && body['note'] !== null && typeof body['note'] !== 'string') {
    return 'note must be a string';
  }
  return null;
}

/**
 * `endDate >= startDate` on the MERGED row, so a PATCH that moves only one end
 * is checked against the stored other end rather than passing unexamined.
 */
export function absenceRangeError(range: Pick<AbsenceRange, 'startDate' | 'endDate'>): string | null {
  if (range.endDate < range.startDate) {
    return `endDate ${range.endDate} must be on or after startDate ${range.startDate}`;
  }
  return null;
}

/**
 * No two absences of the same resource may overlap (spec §6.1) — 409.
 *
 * Closed intervals overlap iff `a.start <= b.end && b.start <= a.end`. The
 * message names the DATES of the blocking row and never its reason: a 409 body
 * is the cheapest possible leak of special-category data, and it would leak to
 * exactly the audience the block just finished restricting.
 */
export function absenceOverlapError(
  candidate: AbsenceRange & { id?: string },
  existing: readonly (AbsenceRange & { id: string })[],
): string | null {
  const clash = existing.find(row =>
    row.resourceId === candidate.resourceId
    && row.id !== candidate.id
    && row.startDate <= candidate.endDate
    && candidate.startDate <= row.endDate);
  if (!clash) return null;
  return `absence ${candidate.startDate}..${candidate.endDate} overlaps an existing absence `
    + `${clash.startDate}..${clash.endDate} for this resource`;
}

/**
 * An absence must fall inside the resource's employment window (spec §6.1).
 *
 * Same rule as `bookingOutsideEmploymentError`, deliberately NOT that function:
 * its message says "booking date", and an absence is not a booking. A 400 that
 * mis-names what the caller sent is a support ticket. Both boundaries are
 * INCLUSIVE, matching the employment convention used everywhere else.
 */
export function absenceOutsideEmploymentError(
  range: Pick<AbsenceRange, 'startDate' | 'endDate'>,
  window: { hireDate?: string | null; terminationDate?: string | null },
): string | null {
  if (isStrictIsoDate(window.hireDate) && range.startDate < window.hireDate) {
    return `absence start ${range.startDate} is before hireDate ${window.hireDate}`;
  }
  if (isStrictIsoDate(window.terminationDate) && range.endDate > window.terminationDate) {
    return `absence end ${range.endDate} is after terminationDate ${window.terminationDate}`;
  }
  return null;
}

/**
 * SEGREGATION OF DUTIES (spec §7.4) — the actor who records an absence may not
 * be its subject. Same shape as approver ≠ requester.
 *
 * Declared consequence, not one to be discovered later: a `resource-manager`
 * cannot record their OWN absence; it takes a colleague or an admin.
 */
export function absenceSelfRecordError(
  actorResourceId: string | undefined,
  subjectResourceId: string,
): string | null {
  if (actorResourceId !== undefined && actorResourceId === subjectResourceId) {
    return 'the actor recording an absence cannot be its subject (segregation of duties)';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * The redacted projection served by `GET /absences/calendar`.
 *
 * A PROJECTION BUILT HERE, never a `delete` on the stored row: a `delete`
 * leaves the field reachable the day the row's shape changes, and it leaves the
 * VALUE in memory on an object that some later edit might hand back whole.
 * Because `RedactedAbsence` carries `reasonCode?: never`, returning the
 * argument instead of this literal does not compile — the guarantee is checked,
 * not asserted.
 */
export function redactAbsence(row: AbsenceRange & { id: string }): RedactedAbsence {
  return { id: row.id, resourceId: row.resourceId, startDate: row.startDate, endDate: row.endDate };
}

/**
 * Absences intersecting the inclusive month range `[from, to]` ('YYYY-MM').
 * Month-granular on purpose: the callers are monthly rollups, and an absence
 * that touches a month at all affects that month's cell.
 */
export function absencesInMonthRange<T extends Pick<AbsenceRange, 'startDate' | 'endDate'>>(
  absences: readonly T[],
  from: string,
  to: string,
): T[] {
  return absences.filter(a => a.startDate.slice(0, 7) <= to && a.endDate.slice(0, 7) >= from);
}

// ---------------------------------------------------------------------------
// The booking gate, and its deliberate asymmetry (spec §6.4)
// ---------------------------------------------------------------------------

/**
 * A NEW BOOKING on a day already covered by an absence is REFUSED (400).
 *
 * The message names the date and the resource and NEVER the reason: the
 * refusal reaches `pm`, who is outside the reason audience, so a message like
 * "on maternity leave" would hand the whole privacy design back through an
 * error string.
 *
 * `absences` may be the whole table; rows for other resources are ignored.
 */
export function bookingOnAbsenceError(
  dates: readonly string[],
  resource: { id: string; name?: string },
  absences: readonly AbsenceRange[],
): string | null {
  const mine = absences.filter(a => a.resourceId === resource.id);
  if (mine.length === 0) return null;
  const ordered = [...new Set(dates)].sort();
  for (const date of ordered) {
    if (mine.some(a => a.startDate <= date && date <= a.endDate)) {
      const who = resource.name ?? resource.id;
      return `booking date ${date} falls in a recorded absence for ${who}`;
    }
  }
  return null;
}

/** One already-booked day that a newly recorded absence collides with. */
export interface AbsenceBookingConflict {
  date: string;
  hours: number;
}

/**
 * The OTHER direction, and it does NOT refuse — a NEW ABSENCE over days that
 * are already booked is ACCEPTED and reports the collision (spec §6.4).
 *
 * The asymmetry is deliberate and must not be "made consistent": an absence is
 * a fact that has already happened in the world, and refusing to record it
 * leaves the system asserting that somebody is present who is not. A booking,
 * by contrast, has not happened yet. The safe direction depends on which of the
 * two is already true.
 *
 * Returns the conflicting days ascending so the planner knows exactly what to
 * un-book. Hours are rounded to 2 decimals, the repo-wide display rule.
 */
export function bookedDaysInAbsence(
  range: Pick<AbsenceRange, 'startDate' | 'endDate'>,
  resourceDays: readonly { date: string; hours: number }[],
): AbsenceBookingConflict[] {
  return resourceDays
    .filter(day => day.hours > 0 && range.startDate <= day.date && day.date <= range.endDate)
    .map(day => ({ date: day.date, hours: Math.round(day.hours * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Engagement classification (spec §6.2) and the two zero-euro-invoice gates (§6.3)
// ---------------------------------------------------------------------------

export interface ProjectClassification {
  billable: boolean;
  type: ProjectType;
}

/**
 * Parse and validate the body of `PUT /projects/:id/classification`.
 *
 * Enforces the schema invariant `type === 'Basket'` ⇒ `billable === false`. The
 * converse stays FREE: a non-billable `Delivery` project is a legitimate
 * internal engagement that is not a practice basket.
 */
export function parseProjectClassification(
  body: unknown,
): { error: string } | { value: ProjectClassification } {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof raw['billable'] !== 'boolean') return { error: 'billable must be a boolean' };
  if (!isProjectType(raw['type'])) {
    return { error: `type must be one of: ${PROJECT_TYPE_VALUES.join(', ')}` };
  }
  const value: ProjectClassification = { billable: raw['billable'], type: raw['type'] };
  if (value.type === 'Basket' && value.billable) {
    return { error: "a Basket engagement must be non-billable (billable: false)" };
  }
  return { value };
}

/** The two classification fields, deliberately NOT in `PROJECT_FIELDS`. */
export const PROJECT_CLASSIFICATION_FIELDS = ['billable', 'type'] as const;

/**
 * `POST /projects` / `PUT /projects/:id` REFUSE (403) a raw body carrying
 * `billable` or `type`, instead of letting `pick()` drop them in silence.
 *
 * `pick()` is silent by design — that is right for a stray field. It is wrong
 * here: a wizard that "works" and quietly produces a BILLABLE project is worse
 * than a wizard that errors, because the failure surfaces months later as a
 * margin alert nobody can explain. This one needs noise.
 *
 * No "unchanged value is fine" carve-out (the shape `billingPlanInvoicedFieldLockError`
 * uses), because none is needed: the project form posts a field-scoped reactive
 * form value, never the object it read back from `GET /projects`, so no existing
 * client round-trips these two keys.
 */
export function projectClassificationFieldError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  for (const field of PROJECT_CLASSIFICATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, field) && raw[field] !== undefined) {
      return `${field} is set by PUT /projects/:id/classification and cannot be sent here`;
    }
  }
  return null;
}

/** A project is billable unless it explicitly says otherwise (safe default). */
export function isBillableProject(project: { billable?: boolean } | undefined): boolean {
  return (project?.billable ?? true) === true;
}

/**
 * GATE 1 of 2 (spec §6.3) — a billing plan item may not name a NON-BILLABLE
 * engagement (400). Without it the plan would emit a zero-euro invoice against
 * an engagement that has no customer.
 */
export function nonBillableBillingItemError(
  project: { id: string; name?: string; billable?: boolean } | undefined,
): string | null {
  if (project === undefined || isBillableProject(project)) return null;
  return `projectId ${project.id} is a non-billable engagement and cannot carry a billing plan item`;
}

/**
 * GATE 2 of 2 (spec §6.3) — flipping an engagement to non-billable is REFUSED
 * (409) while billing plan items still name it.
 *
 * BOTH gates are required or the invariant is only half enforced: with gate 1
 * alone, the sequence "create billable → create billing item → flip to
 * non-billable" walks straight around it and produces exactly the zero-euro
 * invoice the requirement forbids. The message names HOW MANY items block the
 * flip, so the fix is actionable rather than a wall.
 */
export function nonBillableFlipError(
  next: ProjectClassification,
  blockingItemCount: number,
): string | null {
  if (next.billable || blockingItemCount === 0) return null;
  return `cannot classify this engagement as non-billable: ${blockingItemCount} billing plan `
    + `item(s) still reference it`;
}

/**
 * The subset of `ResourceAbsence` the server pins from the verified actor. Kept
 * as a function so the two write paths cannot disagree about it.
 */
export function pinnedAbsenceFields(actorUserId: string, nowIso: string): Pick<ResourceAbsence, 'recordedBy' | 'recordedAt'> {
  return { recordedBy: actorUserId, recordedAt: nowIso };
}
