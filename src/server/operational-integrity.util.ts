import type { Assignment, Order, ResourceRequest } from '../app/services/api.service';
import { exceedsDailyCapacity, sumHoursByDate } from '../app/services/calendar.util';

export interface AssignmentDependants {
  /**
   * The ONLY dependant that can block a retarget. Day rows, month rows and
   * approvals are re-baselined by `PUT /assignments/:id` (and, for day rows, are
   * re-validated against the new resource by
   * {@link retargetDailyCapacityError} below), so they are deliberately not
   * fields here: an optional flag that the function ignores reads as "considered
   * and allowed", which is how the hole this file used to certify got written.
   */
  hasTimeEntries?: boolean;
}

export interface EmploymentWindow {
  hireDate?: string | null;
  terminationDate?: string | null;
}

export const CLIENT_REQUEST_STATUSES = ['Not Published', 'Published', 'Open', 'Withdrawn'] as const;
const ALL_REQUEST_STATUSES = [...CLIENT_REQUEST_STATUSES, 'Fulfilled'] as const;

function owns(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Fields of an ORDER LINE that define the invoice already issued under the parent
 * order's `invoiceNumber`. `projectId` is one of them: the FatturaPA artifact and
 * `invoicedRevenueForProject` both attribute the line's money by project, so
 * re-imputing a line moves issued revenue between projects.
 */
const ORDER_LINE_ISSUED_DEFINING_FIELDS = ['orderId', 'projectId', 'amount'] as const;

/** True once an order carries a server-assigned invoice number. */
function isIssuedOrder(order: Pick<Order, 'invoiceNumber'>): boolean {
  return order.invoiceNumber !== undefined && order.invoiceNumber !== null;
}

/**
 * Guard for `PUT /order-lines/:id`, the sibling of `issuedOrderFieldLockError`
 * and `invoicedBillingItemDeleteError` one table over.
 *
 * The order HEADER and the billing condition were both locked once an invoice had
 * been issued; the LINES were not. `portfolioTotalsInBase` and
 * `invoicedRevenueForProject` compute invoiced revenue from order LINES, and
 * `normalizeLines` in the FatturaPA adapter prefers the lines over the header
 * amount — so `PUT /order-lines/L9 {"amount": 1}` on a line of an order already
 * carrying INV-2026-0007 returned 200 and left the portfolio reporting 1 EUR of
 * invoiced revenue for a document the customer holds at 120000, with the e-invoice
 * export emitting `<PrezzoTotale>1.00` under the issued `<Numero>`.
 *
 * Re-sending an unchanged value stays allowed (the edit form re-PUTs every field);
 * only a value that actually DIFFERS is refused, which is what keeps ordinary
 * full-object updates of a line on an Open order working.
 */
export function issuedOrderLineWriteError(
  order: Pick<Order, 'invoiceNumber' | 'status'>,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): string | null {
  if (!isIssuedOrder(order)) return null;
  const changed = ORDER_LINE_ISSUED_DEFINING_FIELDS.filter(
    field => owns(patch, field) && patch[field] !== current[field],
  );
  if (changed.length === 0) return null;
  return `${changed.join(', ')} cannot be changed on a line of order ${order.invoiceNumber}, which has been `
    + 'issued to the customer; issue a credit note instead';
}

/**
 * Guard for `DELETE /order-lines/:id` and for `POST /order-lines` against an
 * already-issued order.
 *
 * Deleting the line takes the whole amount out of invoiced revenue while the
 * header keeps its legal invoice number, and the e-invoice silently falls back to
 * the header amount. ADDING a line breaks the Σ-lines == order.amount invariant
 * `assertGeneratedLineTotal` establishes when the invoice is generated.
 */
export function issuedOrderLineStructureError(
  order: Pick<Order, 'invoiceNumber' | 'status'>,
  operation: 'add' | 'remove',
): string | null {
  if (!isIssuedOrder(order)) return null;
  const verb = operation === 'add' ? 'added to' : 'removed from';
  return `a line cannot be ${verb} order ${order.invoiceNumber}, which has been issued to the customer; `
    + 'issue a credit note instead';
}

/**
 * The 409 body for a DELETE blocked by rows that still reference the parent.
 *
 * The in-memory adapter has NO cascade and no FK, so a bare `remove()` answered
 * 204 and left the children pointing at an id nothing resolves — while the exact
 * same request under Postgres answered 409 from the FK. Naming the blocking
 * collections (and their counts) is what makes the refusal actionable instead of
 * "something, somewhere, still uses this".
 *
 * Returns null when nothing blocks, so a childless parent still deletes — the
 * assertion that keeps this from being a guard that always refuses.
 */
export function referencedChildMessage(
  parent: string,
  children: readonly { collection: string; count: number }[],
): string | null {
  const blocking = children.filter(child => child.count > 0);
  if (blocking.length === 0) return null;
  const detail = blocking.map(child => `${child.count} ${child.collection}`).join(', ');
  return `Cannot delete this ${parent}: ${detail} still reference it`;
}

/** The only two states a milestone may hold. */
export const MILESTONE_STATUSES = ['Pending', 'Achieved'] as const;

/**
 * `status` sits in MILESTONE_FIELDS and was never checked against this enum, so
 * `PUT /milestones/:id {"status":"Bogus"}` persisted verbatim and rendered as a
 * chip with none of the three status classes applied.
 */
export function milestoneStatusError(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value === 'string' && (MILESTONE_STATUSES as readonly string[]).includes(value)) return null;
  return `status must be one of: ${MILESTONE_STATUSES.join(', ')}`;
}

/**
 * Server-owned initial state for `POST /milestones`.
 *
 * REACHING 'Achieved' IS WHAT RELEASES MONEY: the milestone PUT flips every linked
 * fixed-price billing condition still in 'Planned' to 'Ready' (i.e. invoiceable),
 * and the trigger keys on the CURRENT status while `milestoneApprovalPatch` keys on
 * the TRANSITION. So a milestone created already 'Achieved' has no `approvedBy`,
 * and the next unrelated PUT (a rename) fires the money trigger with no approver
 * on record — and the UI offers no control to attribute one, because the Approve
 * button only renders for a 'Pending' milestone.
 *
 * The create form already sends 'Pending' (project-plans.ts), so pinning it here
 * breaks no shipped client: the exposure was API-only.
 */
export function buildMilestoneCreate<T extends Record<string, unknown>>(
  body: T,
): T & { status: 'Pending' } {
  return { ...body, status: 'Pending' };
}

/**
 * Drop blank FOREIGN KEYS so they reach the adapter as absent, not as ''.
 *
 * A nullable FK sent as the empty string is the sharpest dev↔prod parity break in
 * the app: the in-memory adapter stores `''` and answers 200, while Postgres
 * raises 23503 (no row has id '') and the error middleware answers 409 "Cannot
 * delete: the record is still referenced by other records" — for a CREATE. The
 * Projects form ("no contract" is a legitimate choice) and every Internal task
 * (`partnerId:''`) are unsavable in production while testing green under
 * `ng serve`.
 *
 * The key is REMOVED rather than set to `undefined`: `{...body}` with an own
 * `undefined` key still hands the column to the in-memory adapter, and the audit
 * diff then reports a key that was never written.
 */
export function stripBlankForeignKeys<T extends object>(
  body: T,
  fields: readonly string[],
): T {
  const out = { ...body } as Record<string, unknown>;
  for (const field of fields) {
    if (!owns(out, field)) continue;
    const value = out[field];
    if (value === '' || value === null) delete out[field];
  }
  return out as T;
}

/** The nullable FKs a project body may legitimately leave blank. */
export const PROJECT_BLANK_FOREIGN_KEYS = ['contractId'] as const;

/**
 * The ONE construction step for a `/projects` write, so the blank-FK
 * normalisation cannot be bypassed: a spec over a free-standing normaliser stays
 * green while the handler ignores it, which is exactly the blind-green shape this
 * project keeps producing.
 */
export function buildProjectWrite<T extends object>(body: T): T {
  return stripBlankForeignKeys(body, PROJECT_BLANK_FOREIGN_KEYS);
}

/**
 * Reject an explicit JSON `null` (and, on create, an omitted value) for a column
 * the schema declares NOT NULL.
 *
 * `crud()` forwarded whatever `pick()` copied, so `PUT /customers/C1 {"name":null}`
 * returned 200 and the in-memory row LOST the key — every contract of that
 * customer then rendered a blank Customer cell, unrecoverably — while the same
 * request under Postgres raised an unmapped 23502 and a 500. Same request, two
 * behaviours, plus silent destruction of commercial master data.
 *
 * On create the ABSENT case has to be refused too: `POST /customers {}` stored a
 * nameless customer in memory and raised the SAME unmapped 23502 on Postgres, so a
 * null-only check leaves half the parity break open.
 */
export function requiredFieldError(
  body: Record<string, unknown>,
  required: readonly string[],
  verb: 'create' | 'update',
): string | null {
  for (const field of required) {
    const present = owns(body, field);
    if (verb === 'create' && (!present || body[field] === undefined)) {
      return `${field} is required`;
    }
    if (present && body[field] === null) {
      return `${field} cannot be null`;
    }
  }
  return null;
}

/**
 * Bounded percentage: a progress/completion field on a notNull double column.
 *
 * `crud('work-packages')` passed `numericFields = []`, so `progress` — rendered as
 * a percentage and used to drive a bar width — accepted -40, 5000, 'abc' and
 * arrays. The non-negative numeric check alone still admits 5000.
 */
export function percentFieldError(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    if (!owns(body, field) || body[field] === undefined) continue;
    const value = body[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      return `${field} must be a number between 0 and 100`;
    }
  }
  return null;
}

/** A finite number (positive OR negative — a change request may reduce scope). */
export function signedNumberFieldError(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    if (!owns(body, field) || body[field] === undefined) continue;
    const value = body[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${field} must be a finite number`;
    }
  }
  return null;
}

/**
 * Narrow guard for a PostgreSQL not-null-violation (SQLSTATE 23502), walking the
 * `.cause` chain for the same reason `isFkViolation` does: drizzle-orm rethrows a
 * `DrizzleQueryError` that never copies `.code` onto the outer error, so a flat
 * `err.code` check never matches on this stack.
 */
export function isNotNullViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let i = 0; i < 5 && typeof current === 'object' && current !== null; i++) {
    if ('code' in current && (current as { code?: unknown }).code === '23502') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The 409 body for a foreign-key violation, worded for the verb that raised it.
 *
 * The mapper answered "Cannot delete: the record is still referenced by other
 * records" for EVERY 23503 — including a CREATE whose reference does not exist,
 * where the message is not merely unhelpful but describes the opposite situation
 * (nothing was being deleted, and nothing references the new row).
 */
export function referentialViolationMessage(method: string): string {
  return method === 'DELETE'
    ? 'Cannot delete: the record is still referenced by other records'
    : 'A referenced record does not exist';
}

/**
 * Resolve `/collection/:id` (and the two irregular shapes) into the audit
 * registry's lookup key.
 *
 * Three reasons this is not a one-liner:
 *  - the COLLECTION segment is matched case-insensitively, because Express routes
 *    case-insensitively and the registry is lowercase-keyed;
 *  - the ID segment is NOT: ids are case-sensitive (UUIDs, and the TE/AL/AR/OB
 *    prefixes), so lower-casing it would miss every row;
 *  - `/fx-rates/:currency` is the exception. The handler upper-cases
 *    `req.params.currency` before writing, but the audit middleware resolves
 *    against the RAW path, so `PUT /api/fx-rates/usd` found no row and the FX rate
 *    that multiplies every converted amount in the portfolio was recorded with
 *    `changedKeys: []` and no before/after — an entry that says something happened
 *    but not what.
 *  - `/settings/hours-per-day` is a singleton whose row id is `hoursPerDay`; it
 *    rescales every effective rate, so it belongs in the trail too.
 */
export interface AuditTargetRef {
  /** Registry key (always lowercase). */
  segment: string;
  /** Row id, exactly as the repository stores it. */
  id: string;
}

export function auditTargetRef(path: string): AuditTargetRef | undefined {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const segment = segments[0].toLowerCase();
  if (segment === 'assignments' && segments[2]?.toLowerCase() === 'months' && segments.length >= 4) {
    return { segment: 'assignment-months', id: `${segments[1]}:${segments[3]}` };
  }
  if (segment === 'settings') {
    // The one setting with a route; its row id is camelCase, not the URL slug.
    return segments[1].toLowerCase() === 'hours-per-day'
      ? { segment: 'settings', id: 'hoursPerDay' }
      : undefined;
  }
  if (segment === 'fx-rates') return { segment, id: segments[1].toUpperCase() };
  return { segment, id: segments[1] };
}

/**
 * Money-defining master data whose mutations MUST be diffable in the append-only
 * trail. Each of these multiplies or defines amounts across the whole portfolio,
 * so "who changed it, from what, to what" is the question the trail exists to
 * answer — and for all three it answered `changedKeys: []`, `before: undefined`.
 *
 * Checked against the live registry at startup (see src/server.ts), so removing a
 * registry entry fails loudly instead of silently blinding the trail again.
 */
export const MONEY_DEFINING_AUDIT_SEGMENTS: readonly string[] = [
  'rate-cards', 'negotiated-rates', 'fx-rates', 'settings',
];

/** Money-defining segments missing from the audit registry, in declaration order. */
export function auditRegistryGaps(registered: Iterable<string>): string[] {
  const present = new Set(registered);
  return MONEY_DEFINING_AUDIT_SEGMENTS.filter(segment => !present.has(segment));
}

/** Strict calendar ISO date, not Date.parse's permissive rollover/parser. */
export function isStrictIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Reject direct writes to the assignment fields owned by day/month rollups. */
export function assignmentServerOwnedFieldError(body: object): string | null {
  if (owns(body, 'assignedHours')) {
    return 'assignedHours is derived from assignmentDays and cannot be set on an assignment';
  }
  if (owns(body, 'status')) {
    return 'status is derived from the per-month allocation and cannot be set on an assignment';
  }
  return null;
}

/**
 * Retargeting an assignment's requestId/resourceId is refused only when the move
 * would orphan LOGGED ACTUALS.
 *
 * SCOPE NARROWED DELIBERATELY (reconciliation, 2026-08-04). This guard was
 * written on the premise, stated in its original docstring, that moving a
 * populated assignment "requires a future explicit workflow capable of
 * migrating/reconciling every linked record atomically". That workflow is not in
 * the future: `PUT /assignments/:id` already implements retarget propagation —
 * it withdraws the old approval, raises a new one against the NEW resource's
 * manager, and hands substituted hours back — and ~12 checks in
 * scripts/smoke-api.mjs (B3 retarget, C2 substituted/given-back retarget) assert
 * exactly that. Refusing on days/months/approvals therefore disabled shipped,
 * tested behaviour rather than protecting anything.
 *
 * `timeEntries` IS still refused: an approved or submitted actual belongs to the
 * person who worked it, nothing in the propagation path re-attributes one, and
 * moving the assignment under it would silently credit somebody else's hours.
 */
export function assignmentRetargetError(
  existing: Pick<Assignment, 'requestId' | 'resourceId'>,
  patch: Partial<Pick<Assignment, 'requestId' | 'resourceId'>>,
  dependants: AssignmentDependants,
): string | null {
  const changesRequest = patch.requestId !== undefined && patch.requestId !== existing.requestId;
  const changesResource = patch.resourceId !== undefined && patch.resourceId !== existing.resourceId;
  if (!changesRequest && !changesResource) return null;
  if (!dependants.hasTimeEntries) return null;

  return 'assignment has logged time entries; retargeting it would re-attribute '
    + 'somebody else\'s actual hours';
}

/**
 * A retarget MOVES day rows to another person, so the receiving person's daily
 * ceiling has to hold for the combined booking.
 *
 * `AssignmentDay` carries only `assignmentId`, so every day row travels wholesale
 * when the assignment's `resourceId` changes — and nothing else re-validates
 * them. Two invariants that `PUT /assignments/:id/allocation` enforces would
 * otherwise be bypassed by going through the retarget door instead:
 *
 *   1. PUT /A1/allocation {'2026-09-01': 8}  (A1 -> Alice, cap 8) -> 200
 *   2. PUT /A2/allocation {'2026-09-01': 8}  (A2 -> Bob,   cap 8) -> 200
 *   3. PUT /A1 {resourceId: 'bob'}                                -> 200
 *
 * leaving Bob with 16h on one day, double his cap, where the same hours booked
 * through the allocation endpoint are a 400. Worse from a dummy (cap = base x
 * MULTI_FTE_MAX) onto an internal person. And it is then INVISIBLE:
 * `recomputeResourceUtilization` clamps through `clampUtil` to [0,100], so 200%
 * stores as 100 — indistinguishable from fully booked, with no endpoint that
 * repairs it. `PUT /resources/:id` refuses the identical end state when it is
 * reached from the other direction (narrowing a kind below existing bookings),
 * which is what makes this a defect rather than a preference.
 *
 * Pure so it can be tested: the caller supplies the moving rows, the rows the
 * receiving resource already holds (its OTHER assignments), and the resolved cap.
 */
export function retargetDailyCapacityError(
  movingDays: readonly { date: string; hours: number }[],
  existingDaysOnTarget: readonly { date: string; hours: number }[],
  dailyCap: number,
): string | null {
  if (movingDays.length === 0) return null;
  const movingDates = new Set(movingDays.map(day => day.date));
  const combined = sumHoursByDate([
    ...movingDays,
    // Only the affected dates matter: a pre-existing over-allocation of the
    // target on some OTHER day must not block an unrelated retarget.
    ...existingDaysOnTarget.filter(day => movingDates.has(day.date)),
  ]);
  const offender = [...movingDates].sort().find(date => exceedsDailyCapacity(combined[date] ?? 0, dailyCap));
  if (offender === undefined) return null;
  return `retarget would exceed the new resource's daily capacity on ${offender}`;
}

/** Optional value: null means inherit the organization setting. */
export function contractHoursPerDayError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 'contractHoursPerDay must be a positive finite number';
  }
  return null;
}

/** Validate the resource's own employment interval. */
export function employmentWindowError(window: EmploymentWindow, requireHireDate = false): string | null {
  const hire = window.hireDate;
  const termination = window.terminationDate;
  if (requireHireDate && !isStrictIsoDate(hire)) {
    return 'hireDate is required and must match YYYY-MM-DD';
  }
  if (hire !== undefined && hire !== null && hire !== '' && !isStrictIsoDate(hire)) {
    return 'hireDate must match YYYY-MM-DD';
  }
  if (termination !== undefined && termination !== null && termination !== '' && !isStrictIsoDate(termination)) {
    return 'terminationDate must match YYYY-MM-DD';
  }
  if (isStrictIsoDate(hire) && isStrictIsoDate(termination) && termination < hire) {
    return 'terminationDate must be on or after hireDate';
  }
  return null;
}

/** Validate exact booking/day dates against inclusive employment boundaries. */
export function bookingOutsideEmploymentError(
  dates: readonly string[],
  window: EmploymentWindow,
): string | null {
  const ordered = [...new Set(dates)].sort();
  for (const date of ordered) {
    if (!isStrictIsoDate(date)) return `booking date ${date} must match YYYY-MM-DD`;
    if (isStrictIsoDate(window.hireDate) && date < window.hireDate) {
      return `booking date ${date} is before hireDate ${window.hireDate}`;
    }
    if (isStrictIsoDate(window.terminationDate) && date > window.terminationDate) {
      return `booking date ${date} is after terminationDate ${window.terminationDate}`;
    }
  }
  return null;
}

/** Validate a partial assignment window against a resource's employment. */
export function bookingWindowOutsideEmploymentError(
  booking: { startDate?: string; endDate?: string },
  window: EmploymentWindow,
): string | null {
  return bookingOutsideEmploymentError(
    [booking.startDate, booking.endDate].filter((date): date is string => date !== undefined),
    window,
  );
}

/**
 * Validate the complete ResourceRequest produced by merging a partial PUT.
 * `Fulfilled` is accepted only when it was already server-owned; a client patch
 * may choose only the publish/withdraw lifecycle statuses.
 */
export function resourceRequestUpdateError(
  existing: ResourceRequest,
  patch: Partial<ResourceRequest>,
): string | null {
  if (owns(patch, 'status')
      && patch.status !== undefined
      && !(CLIENT_REQUEST_STATUSES as readonly string[]).includes(patch.status)) {
    return `status must be one of: ${CLIENT_REQUEST_STATUSES.join(', ')}`;
  }
  const merged = { ...existing, ...patch };
  if (typeof merged.name !== 'string' || merged.name.trim() === '') return 'name is required';
  if (typeof merged.requiredRole !== 'string' || merged.requiredRole.trim() === '') return 'requiredRole is required';
  if (typeof merged.requiredEffort !== 'number' || !Number.isFinite(merged.requiredEffort) || merged.requiredEffort <= 0) {
    return 'requiredEffort must be a positive finite number';
  }
  if (!Array.isArray(merged.skills)) return 'skills must be an array';
  if (merged.skills.some(skill => typeof skill !== 'string' || skill.trim() === '')) {
    return 'skills must contain non-empty catalog names';
  }
  if (typeof merged.status !== 'string' || !(ALL_REQUEST_STATUSES as readonly string[]).includes(merged.status)) {
    return `stored status must be one of: ${ALL_REQUEST_STATUSES.join(', ')}`;
  }
  if (merged.staffedEffort !== undefined
      && (typeof merged.staffedEffort !== 'number' || !Number.isFinite(merged.staffedEffort) || merged.staffedEffort < 0)) {
    return 'staffedEffort must be a non-negative finite server-derived number';
  }
  if (merged.staffedEffortPlanned !== undefined
      && (typeof merged.staffedEffortPlanned !== 'number'
        || !Number.isFinite(merged.staffedEffortPlanned)
        || merged.staffedEffortPlanned < 0)) {
    return 'staffedEffortPlanned must be a non-negative finite server-derived number';
  }
  if (merged.staffedEffort !== undefined
      && merged.staffedEffortPlanned !== undefined
      && merged.staffedEffortPlanned < merged.staffedEffort) {
    return 'staffedEffortPlanned cannot be below staffedEffort';
  }
  if (merged.startDate !== undefined && !isStrictIsoDate(merged.startDate)) {
    return 'startDate must match YYYY-MM-DD';
  }
  if (merged.endDate !== undefined && !isStrictIsoDate(merged.endDate)) {
    return 'endDate must match YYYY-MM-DD';
  }
  if (merged.startDate !== undefined && merged.endDate !== undefined && merged.endDate < merged.startDate) {
    return 'endDate must be on or after startDate';
  }
  return null;
}

/**
 * SERVER-DERIVED UPLOAD PROVENANCE for `/project-documents`.
 *
 * `author`, `authorInitials` and `uploadedAt` sat in the `pick()` allow-list, so
 * they were pinned only by the client: a pm could POST
 * `{author:'Marco Bianchi', authorInitials:'MB', uploadedAt:'2020-01-01'}` and the
 * Documents tab rendered the MB avatar and Marco's name as the person who filed
 * that document, on a date the actor chose. Nothing in the record contradicts it —
 * only the separate append-only audit entry holds the real actor, and that log is
 * admin/delivery-executive-readable only, so EVERY project-level reader sees an
 * attribution that is false.
 *
 * `resolvedName` is the principal's display name from the users directory (the same
 * resolution `actorResourceId` performs); it falls back to the raw actor id, which
 * is unlovely but true — an unresolvable principal must not be labelled as somebody
 * else. Initials come from the name here rather than from the body, so the avatar
 * can never disagree with the name beside it.
 */
export function documentProvenance(
  resolvedName: string,
  uploadedAtIso: string,
): { author: string; authorInitials: string; uploadedAt: string } {
  return {
    author: resolvedName,
    authorInitials: initialsOf(resolvedName),
    uploadedAt: uploadedAtIso,
  };
}

/** First letters of the first two words, upper-cased; '?' for an empty name. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map(part => part[0]!.toUpperCase()).join('');
}

// --- The org-tree critical section ------------------------------------------

/**
 * THE ORG-TREE LOCK KEY, and the two writes that must share it.
 *
 * Every `/resource-organizations` MUTATION is a read-validate-write over the
 * WHOLE tree, so all three are serialized on one global key (node edits are rare,
 * human-scale admin operations, and the invariant spans several nodes, so a
 * per-node lock would have to be taken over an unbounded set anyway).
 *
 * WHAT THE KEY DID NOT COVER, and this section now does: the RESOURCE SIDE of the
 * binding it guards. Resources bind to a node BY NAME (design spec §2.4), so the
 * delete guard is a name check over `resources.list()` — and the resource write
 * that creates such a name sat outside the section entirely. Interleaved:
 * `DELETE /resource-organizations/ORG9` lists resources, finds nobody bound to
 * "Cloud Practice", and removes the node; concurrently
 * `PUT /resources/42 {"organization":"Cloud Practice"}` — which passed
 * `validateResourceCatalogRefs` moments earlier, while the node still existed —
 * commits under `res:42`. Both answer 200, and resource 42 now carries an
 * organization name no node has. `dimensionsOf` resolves no capability/practice
 * for her, so she vanishes from every org-scoped filter and from reporting, and
 * `pickRateCard` (walked via `withEffectiveRates`) finds no node to walk and falls
 * back to the generic card — her effective cost/bill rate, and therefore every
 * margin, planned-cost and baseline figure derived from it, changes with no error
 * anywhere. The rename guard lost the same race the same way.
 *
 * The KEY lives here, with the writes, rather than at the call site: a lock is
 * only as good as the agreement between the sections that take it, and a key
 * defined next to one of two participants is a key the other can drift away from.
 *
 * LOCK ORDER, stated explicitly because the serializer is NOT re-entrant. The
 * total order is `org-chart` -> `org-tree` -> `res:<id>`:
 *   - `org-chart` is acquired at exactly the two `/resources` write handlers,
 *     each at the top of its handler.
 *   - `org-tree` is acquired at the three `/resource-organizations` handlers
 *     (outermost and only lock there — nothing inside acquires anything) and, via
 *     this section, inside the `/resources` handlers, ABOVE their `res:<id>`
 *     write and never below it.
 *   - `res:<id>` is innermost.
 * No path holds `org-tree` while acquiring `org-chart`, and none holds `res:`
 * while acquiring `org-tree`, so the order stays total and acyclic. Note in
 * particular that the approval engine's org reads take NO lock: acquiring
 * `org-chart` or `org-tree` from inside an `approval:` section would create an
 * `approval:` -> `org-*` order no other call site uses, which is exactly how a
 * deadlock gets introduced.
 */
export const ORG_TREE_LOCK = 'org-tree';

/** The serializer both writes share. Structurally a `CriticalSectionRunner`. */
export type OrgTreeSerializer = <R>(key: string, fn: () => Promise<R>) => Promise<R>;

export interface OrgTreeNodeRow { id: string; name: string; parentId?: string }
export interface OrgBoundResourceRow { id: string; organization?: string }

export interface OrgTreeStore {
  resources: { list: () => Promise<OrgBoundResourceRow[]> };
  resourceOrganizations: {
    get: (id: string) => Promise<OrgTreeNodeRow | undefined>;
    list: () => Promise<OrgTreeNodeRow[]>;
    remove: (id: string) => Promise<boolean>;
  };
}

export interface OrgTreeWriteRefusal { status: 400 | 404 | 409; error: string }

/**
 * `DELETE /resource-organizations/:id`, inside the org-tree section: refuse a node
 * with children, refuse a node any resource still names, then remove it. Returns
 * null when the node was removed.
 */
export async function deleteOrgNodeWrite(
  runner: OrgTreeSerializer,
  store: OrgTreeStore,
  nodeId: string,
): Promise<OrgTreeWriteRefusal | null> {
  return runner(ORG_TREE_LOCK, async (): Promise<OrgTreeWriteRefusal | null> => {
    const node = await store.resourceOrganizations.get(nodeId);
    if (node === undefined) return { status: 404, error: 'Not found' };
    const all = await store.resourceOrganizations.list();
    if (all.some(candidate => candidate.parentId === nodeId)) {
      return { status: 409, error: 'Cannot delete an organization that has children' };
    }
    // Resources bind to a node by NAME (design spec §2.4), so this is a name check.
    // Read INSIDE the section — and the resource write that could create such a
    // name is now inside it too, which is the whole point.
    const resources = await store.resources.list();
    if (resources.some(resource => resource.organization === node.name)) {
      return { status: 409, error: 'Cannot delete an organization that resources still reference' };
    }
    await store.resourceOrganizations.remove(nodeId);
    return null;
  });
}

/**
 * Bind a resource to an organization node, inside the SAME org-tree section the
 * delete and rename guards hold.
 *
 * The name is re-validated against the live node list HERE, not by the caller's
 * earlier preflight: only a check that runs inside this section, immediately in
 * front of the write, can still be true when the write lands.
 *
 * `write` is the caller's own resource write (it takes `res:<id>` itself, which is
 * why this section must be acquired above it — see the lock order above). It runs
 * only when the name resolves, so a refused binding writes nothing at all.
 */
export async function writeResourceOrganizationBinding<R>(
  runner: OrgTreeSerializer,
  store: Pick<OrgTreeStore, 'resourceOrganizations'>,
  organizationName: unknown,
  write: () => Promise<R>,
): Promise<{ refusal: OrgTreeWriteRefusal } | { written: R }> {
  return runner(ORG_TREE_LOCK, async (): Promise<{ refusal: OrgTreeWriteRefusal } | { written: R }> => {
    // Absent / cleared bindings have nothing to resolve; the caller's allow-list
    // has already decided whether the field is being written at all.
    if (organizationName !== undefined && organizationName !== null && organizationName !== '') {
      const names = new Set((await store.resourceOrganizations.list()).map(node => node.name));
      if (typeof organizationName !== 'string' || !names.has(organizationName)) {
        // Byte-identical to `validateCatalogValue`'s message for this field, so the
        // refusal a client sees does not change with where the check runs.
        return {
          refusal: {
            status: 400,
            error: 'organization must reference an existing resource organization (catalog name)',
          },
        };
      }
    }
    return { written: await write() };
  });
}
