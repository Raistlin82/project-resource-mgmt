import { describe, expect, it } from 'vitest';
import type { Assignment, Order, ResourceRequest } from '../app/services/api.service';
import {
  MONEY_DEFINING_AUDIT_SEGMENTS,
  assignmentRetargetError,
  assignmentServerOwnedFieldError,
  auditRegistryGaps,
  auditTargetRef,
  bookingOutsideEmploymentError,
  buildMilestoneCreate,
  buildProjectWrite,
  contractHoursPerDayError,
  employmentWindowError,
  isNotNullViolation,
  issuedOrderLineStructureError,
  issuedOrderLineWriteError,
  milestoneStatusError,
  percentFieldError,
  referencedChildMessage,
  referentialViolationMessage,
  requiredFieldError,
  resourceRequestUpdateError,
  retargetDailyCapacityError,
  signedNumberFieldError,
} from './operational-integrity.util';

const assignment: Assignment = {
  id: 'A1', requestId: 'REQ1', resourceId: 'RES1', assignedHours: 8, status: 'Draft',
};

const request: ResourceRequest = {
  id: 'REQ1',
  name: 'Backend engineer',
  requiredRole: 'Developer',
  requiredEffort: 80,
  staffedEffort: 40,
  staffedEffortPlanned: 56,
  status: 'Published',
  skills: ['Java'],
  startDate: '2026-08-01',
  endDate: '2026-08-31',
};

describe('assignment write integrity', () => {
  it('rejects client-owned assignedHours on create/update', () => {
    expect(assignmentServerOwnedFieldError({ assignedHours: 0 }))
      .toBe('assignedHours is derived from assignmentDays and cannot be set on an assignment');
    expect(assignmentServerOwnedFieldError({ assignedHours: 12 }))
      .toBe('assignedHours is derived from assignmentDays and cannot be set on an assignment');
    expect(assignmentServerOwnedFieldError({ requestId: 'REQ1' })).toBeNull();
  });

  it.each([
    ['time entries alone', { hasTimeEntries: true }],
    ['time entries alongside plan rows', { hasDays: true, hasMonths: true, hasTimeEntries: true, hasApprovals: true }],
  ])('blocks a resource/request retarget when %s are linked', (_label, links) => {
    expect(assignmentRetargetError(assignment, { resourceId: 'RES2' }, links)).toContain('logged time entries');
    expect(assignmentRetargetError(assignment, { requestId: 'REQ2' }, links)).toContain('logged time entries');
  });

  /**
   * Month rows and approvals do NOT block a retarget: `PUT /assignments/:id`
   * re-baselines them (withdraw the old approval, raise a new one for the new
   * resource's manager, hand substituted hours back), which
   * scripts/smoke-api.mjs asserts in the B3 and C2 retarget sections. Only logged
   * actuals make the move itself illegal.
   *
   * THIS TEST USED TO CERTIFY A HOLE. It asserted `{ hasDays: true }` -> allowed,
   * which read as "day rows were considered and are safe to move". They are not
   * safe unconditionally: they travel wholesale to the new person and have to fit
   * that person's daily cap and employment window. That check is
   * retargetDailyCapacityError + bookingOutsideEmploymentError, exercised below
   * and wired into the handler under the same double res: lock — so what this
   * function allows is only the FK change, never the booking.
   */
  it('allows the FK change itself when no actual has been logged', () => {
    expect(assignmentRetargetError(assignment, { resourceId: 'RES2' }, {})).toBeNull();
    expect(assignmentRetargetError(assignment, { requestId: 'REQ2' }, {})).toBeNull();
    expect(assignmentRetargetError(assignment, { resourceId: 'RES2' }, { hasTimeEntries: false })).toBeNull();
  });

  it('is a no-op when neither FK actually changes', () => {
    expect(assignmentRetargetError(assignment, { resourceId: 'RES1', requestId: 'REQ1' }, {
      hasTimeEntries: true,
    })).toBeNull();
  });
});

describe('retarget per-day capacity recheck', () => {
  const cap = 8;

  it('refuses the exact sequence that books a resource over cap through the retarget door', () => {
    // A1 holds 8h on 2026-09-01 and moves to Bob, who already holds 8h that day
    // via A2. The same 16h booked through PUT /assignments/:id/allocation is a
    // 400; going through the retarget door must not be a 200. Drop the recheck
    // and this returns null.
    const moving = [{ date: '2026-09-01', hours: 8 }];
    const bobsExisting = [{ date: '2026-09-01', hours: 8 }];
    expect(retargetDailyCapacityError(moving, bobsExisting, cap))
      .toBe("retarget would exceed the new resource's daily capacity on 2026-09-01");
  });

  it('refuses a dummy-sized booking landing on a one-FTE person', () => {
    // A dummy's ceiling is base x MULTI_FTE_MAX (240h/day at 8h base), so 100h on
    // one day is legal there and 12.5x cap on an internal person.
    expect(retargetDailyCapacityError([{ date: '2026-09-01', hours: 100 }], [], cap))
      .toContain('2026-09-01');
  });

  it('reports the EARLIEST offending day, so the message is stable', () => {
    const moving = [{ date: '2026-09-03', hours: 9 }, { date: '2026-09-02', hours: 9 }];
    expect(retargetDailyCapacityError(moving, [], cap)).toContain('2026-09-02');
  });

  it('allows a retarget that fits, including exactly at the cap', () => {
    expect(retargetDailyCapacityError([{ date: '2026-09-01', hours: 4 }], [{ date: '2026-09-01', hours: 4 }], cap)).toBeNull();
    expect(retargetDailyCapacityError([{ date: '2026-09-01', hours: 8 }], [], cap)).toBeNull();
    // Float noise must not manufacture a breach (exceedsDailyCapacity epsilon).
    expect(retargetDailyCapacityError([{ date: '2026-09-01', hours: 7.5 }], [{ date: '2026-09-01', hours: 0.5 }], cap)).toBeNull();
  });

  it('ignores the target\'s pre-existing over-allocation on UNAFFECTED days', () => {
    // Otherwise an unrelated retarget is blocked by a day it does not touch.
    const moving = [{ date: '2026-09-01', hours: 4 }];
    const existing = [{ date: '2026-09-05', hours: 99 }];
    expect(retargetDailyCapacityError(moving, existing, cap)).toBeNull();
  });

  it('is a no-op when the assignment carries no day rows', () => {
    expect(retargetDailyCapacityError([], [{ date: '2026-09-01', hours: 99 }], cap)).toBeNull();
  });
});

describe('resource employment and daily contract integrity', () => {
  it('accepts an inherited or positive finite contract day and rejects unusable values', () => {
    expect(contractHoursPerDayError(undefined)).toBeNull();
    expect(contractHoursPerDayError(null)).toBeNull();
    expect(contractHoursPerDayError(7.5)).toBeNull();
    expect(contractHoursPerDayError(0)).toContain('positive');
    expect(contractHoursPerDayError(-1)).toContain('positive');
    expect(contractHoursPerDayError(Number.NaN)).toContain('positive');
    expect(contractHoursPerDayError('8')).toContain('positive');
  });

  it('validates strict employment dates and their order', () => {
    expect(employmentWindowError({ hireDate: '2026-01-01' }, true)).toBeNull();
    expect(employmentWindowError({}, true)).toContain('hireDate is required');
    expect(employmentWindowError({ hireDate: '01/01/2026' }, true)).toContain('YYYY-MM-DD');
    expect(employmentWindowError({ hireDate: '2026-02-30' }, true)).toContain('YYYY-MM-DD');
    expect(employmentWindowError({ hireDate: '2026-02-01', terminationDate: '2026-01-31' }, true))
      .toContain('on or after hireDate');
  });

  it('allows inclusive boundary bookings and rejects dates outside employment', () => {
    const window = { hireDate: '2026-01-10', terminationDate: '2026-02-20' };
    expect(bookingOutsideEmploymentError(['2026-01-10', '2026-02-20'], window)).toBeNull();
    expect(bookingOutsideEmploymentError(['2026-01-09'], window)).toContain('before hireDate');
    expect(bookingOutsideEmploymentError(['2026-02-21'], window)).toContain('after terminationDate');
    expect(bookingOutsideEmploymentError(['2026-02-30'], window)).toContain('YYYY-MM-DD');
  });
});

describe('fully merged resource-request PUT validation', () => {
  it('catches an invalid date order created by a partial patch', () => {
    expect(resourceRequestUpdateError(request, { endDate: '2026-07-31' }))
      .toBe('endDate must be on or after startDate');
  });

  it('keeps required fields and effort invariants valid after merge', () => {
    expect(resourceRequestUpdateError(request, { requiredEffort: 0 })).toContain('positive');
    expect(resourceRequestUpdateError(request, { name: '' })).toContain('name is required');
    expect(resourceRequestUpdateError(request, { requiredRole: '' })).toContain('requiredRole is required');
    expect(resourceRequestUpdateError(request, { skills: null as unknown as string[] })).toContain('skills must be an array');
  });

  it('rejects client attempts to write derived/unknown status and invalid stored aggregates', () => {
    expect(resourceRequestUpdateError(request, { status: 'Fulfilled' })).toContain('status must be one of');
    expect(resourceRequestUpdateError({ ...request, staffedEffort: -1 }, {})).toContain('staffedEffort');
    expect(resourceRequestUpdateError({ ...request, staffedEffort: 60, staffedEffortPlanned: 40 }, {}))
      .toContain('staffedEffortPlanned');
  });

  it('accepts a valid partial update against a valid complete record', () => {
    expect(resourceRequestUpdateError(request, { description: 'Updated' })).toBeNull();
    expect(resourceRequestUpdateError(request, { status: 'Withdrawn' })).toBeNull();
    expect(resourceRequestUpdateError(request, { requiredEffort: 100, endDate: '2026-09-30' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wave 5 — the issued-document, not-null and referential guards.
// ---------------------------------------------------------------------------

const issuedOrder = {
  id: 'O9', contractId: 'CT1', type: 'Customer', partnerId: '', amount: 120000,
  currency: 'EUR', status: 'Invoiced', orderDate: '2026-08-05', invoiceNumber: 'INV-2026-0007',
} as unknown as Order;
const openOrder = { ...issuedOrder, id: 'O10', status: 'Open', invoiceNumber: undefined } as Order;
const issuedLine = { id: 'L9', orderId: 'O9', projectId: 'P1', description: 'Phase 1', amount: 120000 };

describe('issued order-line locks', () => {
  it('refuses a rewrite of the money, the imputation or the parent of an issued line', () => {
    // THE DEFECT. The order HEADER and the billing condition were locked once an
    // invoice had been issued; the LINES were not, and invoicedRevenue (portfolio and
    // per-project) plus the FatturaPA <PrezzoTotale> are computed FROM THE LINES. So
    // `PUT /order-lines/L9 {"amount":1}` returned 200 and the portfolio reported 1 EUR
    // for a document the customer holds at 120000.
    expect(issuedOrderLineWriteError(issuedOrder, issuedLine, { amount: 5000 }))
      .toContain('cannot be changed');
    expect(issuedOrderLineWriteError(issuedOrder, issuedLine, { amount: 5000 }))
      .toContain('INV-2026-0007');
    expect(issuedOrderLineWriteError(issuedOrder, issuedLine, { projectId: 'P2' })).not.toBeNull();
    expect(issuedOrderLineWriteError(issuedOrder, issuedLine, { orderId: 'O10' })).not.toBeNull();
  });

  it('still allows ordinary editing, and a no-op re-PUT of an issued line', () => {
    // TWO ASSERTIONS OF ABSENCE. Without them a blanket `return 409` passes every
    // expectation above while breaking the edit form, which re-PUTs every field.
    expect(issuedOrderLineWriteError(openOrder, issuedLine, { amount: 5000 })).toBeNull();
    expect(issuedOrderLineWriteError(issuedOrder, issuedLine, { amount: 120000, projectId: 'P1' })).toBeNull();
    // A patch that names none of the locked fields is not a money change.
    expect(issuedOrderLineWriteError(issuedOrder, issuedLine, { description: 'Phase 1 (rev B)' })).toBeNull();
  });

  it('refuses adding a line to, or removing one from, an issued order', () => {
    // Deleting the line takes the whole amount out of invoicedRevenue while the header
    // keeps its legal number; adding one breaks assertGeneratedLineTotal's
    // sum-of-lines == order.amount invariant.
    expect(issuedOrderLineStructureError(issuedOrder, 'remove')).toContain('removed from');
    expect(issuedOrderLineStructureError(issuedOrder, 'add')).toContain('added to');
    // ABSENCE TWIN: an order with no invoice number is freely composable — otherwise
    // no order could ever be given its first line.
    expect(issuedOrderLineStructureError(openOrder, 'remove')).toBeNull();
    expect(issuedOrderLineStructureError(openOrder, 'add')).toBeNull();
  });
});

describe('milestone create/status integrity', () => {
  it('pins a new milestone to Pending whatever the body asked for', () => {
    // THE DEFECT. Reaching 'Achieved' is what flips every linked fixed-price billing
    // condition to 'Ready' (billable). The trigger keys on the CURRENT status while
    // milestoneApprovalPatch keys on the TRANSITION, so a milestone POSTed already
    // 'Achieved' had no approvedBy and the next unrelated PUT released the money with
    // no approver on record — and the card offers no control to attribute one.
    expect(buildMilestoneCreate({ projectId: '1', name: 'm', date: '2026-09-01', status: 'Achieved' }).status)
      .toBe('Pending');
  });

  it('preserves every other field it was given', () => {
    // ASSERTION OF ABSENCE: a builder that returned a bare {status:'Pending'} would
    // satisfy the case above and silently drop the projectId, name and date.
    const built = buildMilestoneCreate({ projectId: '1', name: 'Go live', date: '2026-09-01' });
    expect(built).toStrictEqual({ projectId: '1', name: 'Go live', date: '2026-09-01', status: 'Pending' });
    expect(Object.keys(built).sort()).toEqual(['date', 'name', 'projectId', 'status']);
  });

  it('rejects a status outside the enum on either verb, and passes the two real ones', () => {
    expect(milestoneStatusError('Bogus')).toContain('Pending, Achieved');
    expect(milestoneStatusError('achieved')).not.toBeNull();
    expect(milestoneStatusError(null)).not.toBeNull();
    // ABSENCE TWIN: both legal states, and an omitted status (a partial PUT), pass —
    // a guard that refused everything would pass the three assertions above.
    expect(milestoneStatusError('Pending')).toBeNull();
    expect(milestoneStatusError('Achieved')).toBeNull();
    expect(milestoneStatusError(undefined)).toBeNull();
  });
});

describe('blank foreign keys', () => {
  it('drops a blank contractId so the column is ABSENT, not an empty string', () => {
    // THE DEFECT. "Project with no contract" is a legitimate choice the form offers,
    // and it sends contractId:''. Postgres raises 23503 (no contracts row has id '')
    // and the mapper answered 409 "Cannot delete: the record is still referenced by
    // other records" — for a CREATE. In memory the identical request returned 200 and
    // stored ''. The key must be GONE, not undefined: an own undefined key still
    // reaches the adapter and shows up in the audit diff.
    const built = buildProjectWrite({ name: 'Internal tooling', ownerId: 'R1', contractId: '' });
    expect('contractId' in built).toBe(false);
    expect(Object.keys(built).sort()).toEqual(['name', 'ownerId']);
    expect(buildProjectWrite({ contractId: null as unknown as string })).toStrictEqual({});
  });

  it('leaves a real contractId untouched', () => {
    // ASSERTION OF ABSENCE: a normaliser that blanked the FK unconditionally would
    // pass the case above and quietly detach every project from its contract.
    expect(buildProjectWrite({ name: 'Alpha', contractId: 'CT1' }))
      .toStrictEqual({ name: 'Alpha', contractId: 'CT1' });
  });
});

describe('not-null parity guards', () => {
  it('refuses an explicit null on a notNull column, on either verb', () => {
    // THE DEFECT. `PUT /customers/C1 {"name":null}` was a 200 and the in-memory row
    // LOST the key — every contract of that customer then rendered a blank Customer
    // cell, unrecoverably — while the same request under Postgres raised an unmapped
    // 23502 and a 500.
    expect(requiredFieldError({ name: null }, ['name'], 'update')).toBe('name cannot be null');
    expect(requiredFieldError({ name: null }, ['name'], 'create')).toBe('name cannot be null');
  });

  it('refuses an ABSENT required field on create but not on update', () => {
    // `POST /customers {}` stored a nameless customer in memory and raised the same
    // unmapped 23502 on Postgres, so a null-only check leaves half the parity break
    // open. A PUT that simply does not mention the column is an ordinary partial edit.
    expect(requiredFieldError({}, ['name'], 'create')).toBe('name is required');
    expect(requiredFieldError({ industry: 'Banking' }, ['name'], 'update')).toBeNull();
  });

  it('lets an ordinary write through', () => {
    // ASSERTION OF ABSENCE. A guard that always refused would pass every expectation
    // above while making the collection read-only — the shape the register warns about.
    expect(requiredFieldError({ name: 'Renamed' }, ['name'], 'update')).toBeNull();
    expect(requiredFieldError({ name: 'Acme', industry: 'Banking' }, ['name'], 'create')).toBeNull();
    // An empty string is a value, not a null: refusing it here would reject every
    // optional-but-present text field the forms send as ''.
    expect(requiredFieldError({ name: '' }, ['name'], 'update')).toBeNull();
  });

  it('maps the Postgres not-null SQLSTATE through drizzle\'s wrapper', () => {
    expect(isNotNullViolation({ code: '23502' })).toBe(true);
    expect(isNotNullViolation({ cause: { cause: { code: '23502' } } })).toBe(true);
    // ABSENCE TWIN: an FK violation must NOT be reported as a missing field, and an
    // ordinary error must not be swallowed as one.
    expect(isNotNullViolation({ code: '23503' })).toBe(false);
    expect(isNotNullViolation(new Error('boom'))).toBe(false);
  });

  it('words the referential 409 for the verb that raised it', () => {
    expect(referentialViolationMessage('DELETE')).toContain('still referenced');
    // RED before: every 23503 got the delete wording, including a CREATE whose
    // reference does not exist — where it describes the opposite situation.
    expect(referentialViolationMessage('POST')).toBe('A referenced record does not exist');
    expect(referentialViolationMessage('PUT')).toBe('A referenced record does not exist');
  });
});

describe('bounded numeric fields', () => {
  it('rejects an out-of-range or non-numeric percentage', () => {
    // `crud('work-packages')` passed numericFields = [], so `progress` — a percentage
    // on a notNull double column that drives a bar's width — accepted all of these.
    expect(percentFieldError({ progress: -40 }, ['progress'])).toContain('between 0 and 100');
    expect(percentFieldError({ progress: 5000 }, ['progress'])).not.toBeNull();
    expect(percentFieldError({ progress: 'abc' }, ['progress'])).not.toBeNull();
    expect(percentFieldError({ progress: [50] }, ['progress'])).not.toBeNull();
    expect(percentFieldError({ progress: Number.NaN }, ['progress'])).not.toBeNull();
  });

  it('accepts the whole legal range and an omitted value', () => {
    // ABSENCE TWIN: the bounds are inclusive, and a PUT that does not touch progress
    // must not be refused — otherwise no work package could ever be edited.
    expect(percentFieldError({ progress: 0 }, ['progress'])).toBeNull();
    expect(percentFieldError({ progress: 100 }, ['progress'])).toBeNull();
    expect(percentFieldError({ progress: 62.5 }, ['progress'])).toBeNull();
    expect(percentFieldError({}, ['progress'])).toBeNull();
  });

  it('requires change-request impacts to be finite numbers, sign included', () => {
    expect(signedNumberFieldError({ impactBudget: '5000' }, ['impactBudget'])).toContain('finite number');
    expect(signedNumberFieldError({ impactScheduleDays: null }, ['impactScheduleDays'])).not.toBeNull();
    expect(signedNumberFieldError({ impactBudget: Number.POSITIVE_INFINITY }, ['impactBudget'])).not.toBeNull();
    // ABSENCE TWIN: a change request may REDUCE scope, so a negative figure is legal —
    // a non-negative check here would break the documented behaviour.
    expect(signedNumberFieldError({ impactBudget: -12000 }, ['impactBudget'])).toBeNull();
    expect(signedNumberFieldError({ impactBudget: 0, impactScheduleDays: 14 }, ['impactBudget', 'impactScheduleDays']))
      .toBeNull();
  });
});

describe('referential delete guards', () => {
  it('names every collection that still references the parent', () => {
    const message = referencedChildMessage('contract', [
      { collection: 'order(s)', count: 1 },
      { collection: 'billing condition(s)', count: 3 },
      { collection: 'project(s)', count: 0 },
    ]);
    expect(message).toContain('1 order(s)');
    expect(message).toContain('3 billing condition(s)');
    // Only the BLOCKING collections are named — a zero count is not a reason.
    expect(message).not.toContain('project(s)');
  });

  it('still deletes a parent nothing references', () => {
    // ASSERTION OF ABSENCE. A guard that always refused would pass the case above and
    // strand every childless contract in the list forever.
    expect(referencedChildMessage('contract', [
      { collection: 'order(s)', count: 0 },
      { collection: 'billing condition(s)', count: 0 },
    ])).toBeNull();
    expect(referencedChildMessage('contract', [])).toBeNull();
  });
});

describe('audit target resolution', () => {
  it('upper-cases the fx-rates natural key so a lowercase path still resolves', () => {
    // THE DEFECT. The handler upper-cases req.params.currency before writing, but the
    // audit middleware resolves against the RAW path — so `PUT /api/fx-rates/usd`
    // found no row and the rate that multiplies every converted amount in the
    // portfolio was recorded with changedKeys:[] and no before/after.
    expect(auditTargetRef('/fx-rates/usd')).toStrictEqual({ segment: 'fx-rates', id: 'USD' });
    expect(auditTargetRef('/fx-rates/USD')).toStrictEqual({ segment: 'fx-rates', id: 'USD' });
  });

  it('resolves the hours-per-day singleton onto its camelCase row id', () => {
    // hours-per-day "rescales every effective rate" (the handler says so) and had no
    // resolvable entity at all, so its mutations were audited blind.
    expect(auditTargetRef('/settings/hours-per-day')).toStrictEqual({ segment: 'settings', id: 'hoursPerDay' });
    expect(auditTargetRef('/settings/unknown-setting')).toBeUndefined();
  });

  it('never lower-cases an entity id, and keeps the nested month shape', () => {
    // ASSERTION OF ABSENCE, and the reason only the collection segment is folded:
    // ids here are case-sensitive (UUIDs and the TE/AL/AR/OB prefixes), so
    // lower-casing them would miss every row it is meant to snapshot.
    expect(auditTargetRef('/Resources/AbC-123')).toStrictEqual({ segment: 'resources', id: 'AbC-123' });
    expect(auditTargetRef('/rate-cards/RC1')).toStrictEqual({ segment: 'rate-cards', id: 'RC1' });
    expect(auditTargetRef('/assignments/A1/months/2026-09/note'))
      .toStrictEqual({ segment: 'assignment-months', id: 'A1:2026-09' });
    expect(auditTargetRef('/resources')).toBeUndefined();
    expect(auditTargetRef('/')).toBeUndefined();
  });

  it('reports a money-defining collection missing from the audit registry', () => {
    // The registry is a Map built in src/server.ts, which no spec can import (it
    // instantiates the SSR engine). This is the wiring guarantee instead: the server
    // calls auditRegistryGaps over the live Map's keys at startup and throws on a gap,
    // so removing an entry fails loudly rather than silently blinding the trail again.
    expect(auditRegistryGaps(['resources', 'orders'])).toEqual([...MONEY_DEFINING_AUDIT_SEGMENTS]);
    expect(auditRegistryGaps(['rate-cards', 'negotiated-rates', 'settings'])).toEqual(['fx-rates']);
    // ABSENCE TWIN: a complete registry reports NO gap — without this the function
    // could return every segment unconditionally and still pass the two cases above.
    expect(auditRegistryGaps([...MONEY_DEFINING_AUDIT_SEGMENTS, 'resources'])).toEqual([]);
  });
});
