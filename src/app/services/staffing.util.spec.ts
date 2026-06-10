import {
  utilizationContribution,
  requestStatusFor,
  isAllowedTimeEntryTransition,
  TIME_ENTRY_TRANSITIONS,
} from './staffing.util';
import { ResourceRequest } from './api.service';

function req(status: ResourceRequest['status'], requiredEffort: number): ResourceRequest {
  return { id: 'R1', name: 'Req', requiredRole: 'Dev', requiredEffort, status, skills: [] };
}

describe('staffing.util utilizationContribution', () => {
  it('computes hours/capacity*100', () => {
    expect(utilizationContribution(20, 40)).toBe(50);
    expect(utilizationContribution(40, 40)).toBe(100);
  });

  it('returns 0 for an unusable capacity (0, negative, non-finite) instead of NaN/Infinity', () => {
    expect(utilizationContribution(20, 0)).toBe(0);
    expect(utilizationContribution(20, -5)).toBe(0);
    expect(utilizationContribution(20, Number.NaN)).toBe(0);
  });

  it('treats a non-finite hours value as 0', () => {
    expect(utilizationContribution(Number.NaN, 40)).toBe(0);
  });
});

describe('staffing.util requestStatusFor', () => {
  it('derives Fulfilled when staffedEffort meets or exceeds requiredEffort', () => {
    expect(requestStatusFor(req('Open', 100), 100)).toBe('Fulfilled');
    expect(requestStatusFor(req('Open', 100), 150)).toBe('Fulfilled');
  });

  it('reverts a Fulfilled request to Open once staffing drops below the requirement', () => {
    expect(requestStatusFor(req('Fulfilled', 100), 80)).toBe('Open');
  });

  it('preserves a client-controlled status when below the requirement', () => {
    expect(requestStatusFor(req('Published', 100), 50)).toBe('Published');
    expect(requestStatusFor(req('Withdrawn', 100), 0)).toBe('Withdrawn');
  });
});

// B-STAFFING-RECALC regression: reassigning an assignment to a different
// resource/request must fully reverse the OLD target and fully credit the NEW
// target, not apply only the hours delta to a single side. These tests compose
// the same helpers the PUT handler uses to prove the corrected arithmetic.
describe('staffing.util reassignment recalc (PUT) arithmetic', () => {
  it('fully moves utilization from the old resource to the new resource', () => {
    const oldHours = 20;
    const newHours = 20;
    const oldCap = 40; // old resource was at 50% from this assignment
    const newCap = 40;
    const oldResUtilBefore = 50; // entirely from this assignment
    const newResUtilBefore = 0;

    // Old resource: subtract its FULL contribution -> back to 0.
    const oldResUtilAfter = oldResUtilBefore - utilizationContribution(oldHours, oldCap);
    // New resource: add the FULL contribution -> 50.
    const newResUtilAfter = newResUtilBefore + utilizationContribution(newHours, newCap);

    expect(oldResUtilAfter).toBe(0);
    expect(newResUtilAfter).toBe(50);
  });

  it('fully moves staffedEffort and re-derives status on both old and new requests', () => {
    const hours = 100;
    // OLD request was exactly Fulfilled by this single assignment.
    const oldReq = req('Fulfilled', 100);
    const oldStaffedBefore = 100;
    const oldStaffedAfter = oldStaffedBefore - hours; // 0
    expect(requestStatusFor(oldReq, oldStaffedAfter)).toBe('Open'); // reverts

    // NEW request gets the FULL hours and becomes Fulfilled.
    const newReq = req('Open', 100);
    const newStaffedBefore = 0;
    const newStaffedAfter = newStaffedBefore + hours; // 100
    expect(requestStatusFor(newReq, newStaffedAfter)).toBe('Fulfilled');
  });
});

describe('staffing.util time-entry transition whitelist', () => {
  it('allows the timesheet lifecycle moves', () => {
    expect(isAllowedTimeEntryTransition('Draft', 'Submitted')).toBe(true);
    expect(isAllowedTimeEntryTransition('Submitted', 'Draft')).toBe(true);
    expect(isAllowedTimeEntryTransition('Submitted', 'Approved')).toBe(true);
    expect(isAllowedTimeEntryTransition('Submitted', 'Rejected')).toBe(true);
    expect(isAllowedTimeEntryTransition('Rejected', 'Draft')).toBe(true);
  });

  it('allows a no-op transition so non-status edits are not blocked', () => {
    expect(isAllowedTimeEntryTransition('Approved', 'Approved')).toBe(true);
    expect(isAllowedTimeEntryTransition('Draft', 'Draft')).toBe(true);
  });

  it('rejects illegal moves, including skipping straight to Approved and reverting an Approved entry', () => {
    expect(isAllowedTimeEntryTransition('Draft', 'Approved')).toBe(false);
    expect(isAllowedTimeEntryTransition('Draft', 'Rejected')).toBe(false);
    expect(isAllowedTimeEntryTransition('Approved', 'Draft')).toBe(false);
    expect(isAllowedTimeEntryTransition('Approved', 'Rejected')).toBe(false);
    expect(isAllowedTimeEntryTransition('Rejected', 'Approved')).toBe(false);
  });

  it('treats Approved as terminal in the transition map', () => {
    expect(TIME_ENTRY_TRANSITIONS.Approved).toHaveLength(0);
  });
});
