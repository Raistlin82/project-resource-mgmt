import { describe, expect, it } from 'vitest';
import type { Assignment, ResourceRequest } from '../app/services/api.service';
import {
  assignmentRetargetError,
  assignmentServerOwnedFieldError,
  bookingOutsideEmploymentError,
  contractHoursPerDayError,
  employmentWindowError,
  resourceRequestUpdateError,
  retargetDailyCapacityError,
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
