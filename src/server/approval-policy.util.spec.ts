import { describe, expect, it } from 'vitest';
import {
  CLIENT_CREATABLE_APPROVAL_KINDS,
  clientCreatableApprovalKindError,
  crossStepSoDError,
  milestoneApprovalPatch,
} from './approval-policy.util';

describe('crossStepSoDError', () => {
  it('refuses the actor who already decided an earlier step', () => {
    // THE DEFECT. buildApprovalSteps escalates an item above 50000 to a
    // sequential ['delivery-executive','finance'] chain so that TWO people sign
    // off, but roleMatch is true for `admin` on every step, and the only SoD rule
    // compared the decider against the REQUESTER. So one admin decided step 0,
    // the chain advanced, and the same admin decided step 1.
    const steps = [
      { status: 'Approved', decidedBy: 'admin@acme' },
      { status: 'Pending' },
    ];
    const err = crossStepSoDError(steps, 'admin@acme');
    expect(err).not.toBeNull();
    expect(err).toContain('second approver');
  });

  it('admits a DIFFERENT actor on the later step', () => {
    // ASSERTION OF ABSENCE #1. A guard that refused every decision on a chain
    // with any decided step would pass the test above and make every high-value
    // item permanently undecidable. This is the half that catches it.
    const steps = [
      { status: 'Approved', decidedBy: 'julie@acme' },
      { status: 'Pending' },
    ];
    expect(crossStepSoDError(steps, 'marco@acme')).toBeNull();
  });

  it('admits the first decision on a fresh chain', () => {
    expect(crossStepSoDError([{ status: 'Pending' }, { status: 'Pending' }], 'julie@acme')).toBeNull();
  });

  it('does not exempt an admin', () => {
    // The exemption would restore the hole: `admin` is precisely the role whose
    // roleMatch is true on every step, so it is the actor that could walk the
    // whole chain alone.
    const steps = [{ status: 'Approved', decidedBy: 'admin' }, { status: 'Pending' }];
    expect(crossStepSoDError(steps, 'admin')).not.toBeNull();
  });

  it('ignores an unresolved decider rather than refusing', () => {
    // ASSERTION OF ABSENCE #2. `undefined === undefined` is true, so a naive
    // `steps.some(s => s.decidedBy === decider)` would refuse EVERY decision on a
    // chain holding an undecided step as soon as the decider could not be
    // resolved. The undefined guard is load-bearing, and this pins it.
    const steps = [{ status: 'Pending' }, { status: 'Pending' }];
    expect(crossStepSoDError(steps, undefined)).toBeNull();
  });

  it('still refuses a repeat decider on a three-step chain', () => {
    const steps = [
      { status: 'Approved', decidedBy: 'a' },
      { status: 'Approved', decidedBy: 'b' },
      { status: 'Pending' },
    ];
    expect(crossStepSoDError(steps, 'a')).not.toBeNull();
    expect(crossStepSoDError(steps, 'b')).not.toBeNull();
    expect(crossStepSoDError(steps, 'c')).toBeNull();
  });
});

describe('clientCreatableApprovalKindError', () => {
  it('refuses a client-created Allocation approval', () => {
    // A forged kind:'Allocation' with a BARE assignment id as refId is treated by
    // applyAllocationDecision as a legacy gap-A approval and applied to the
    // assignment AND every non-Draft month row under it — one decision flipping
    // every month, bypassing the per-month manager approval.
    const err = clientCreatableApprovalKindError('Allocation');
    expect(err).not.toBeNull();
    expect(err).toContain('allocation workflow');
  });

  it('admits every kind a client legitimately opens', () => {
    // ASSERTION OF ABSENCE. The five other kinds must keep working; a guard that
    // refused any unrecognised kind here would break them and still pass above.
    for (const kind of ['TimeEntry', 'Expense', 'Milestone', 'ChangeRequest', 'Invoice']) {
      expect(clientCreatableApprovalKindError(kind)).toBeNull();
    }
  });

  it('keeps the exported allow-list and the guard in agreement', () => {
    // The two must never drift: the list documents the policy, the guard enforces
    // it. Asserting them against each other is what stops one being edited alone.
    expect(CLIENT_CREATABLE_APPROVAL_KINDS).not.toContain('Allocation');
    for (const kind of CLIENT_CREATABLE_APPROVAL_KINDS) {
      expect(clientCreatableApprovalKindError(kind)).toBeNull();
    }
  });
});

describe('milestoneApprovalPatch', () => {
  const AT = '2026-08-05T10:00:00.000Z';

  it('pins the approver on the edge into Achieved', () => {
    // THE DEFECT: approvedBy/approvedAt were in the milestone pick() allow-list,
    // so the body chose them — on the very PUT that makes a fixed-price billing
    // condition billable.
    expect(milestoneApprovalPatch('Pending', 'Achieved', 'julie@acme', AT))
      .toEqual({ approvedBy: 'julie@acme', approvedAt: AT });
  });

  it('does not rewrite the approver on an idempotent re-PUT', () => {
    // ASSERTION OF ABSENCE #1. Pinning on "status is Achieved" rather than on the
    // EDGE into it passes the test above and silently reattributes the original
    // approval to whoever last touched the row.
    expect(milestoneApprovalPatch('Achieved', 'Achieved', 'someone-else', AT)).toEqual({});
  });

  it('clears a stale approval when a milestone is walked back to Pending', () => {
    // toStrictEqual, NOT toEqual: Vitest treats a key explicitly set to undefined
    // as equal to a missing key, so `toEqual({approvedBy: undefined, ...})` is also
    // satisfied by `{}` — i.e. by a function that clears nothing. The CLEARING is
    // the whole point (the patch is spread onto the merged row, and only a present
    // key overwrites the stored approver), so the keys must actually be there.
    const patch = milestoneApprovalPatch('Achieved', 'Pending', 'julie@acme', AT);
    expect(patch).toStrictEqual({ approvedBy: undefined, approvedAt: undefined });
    expect(Object.keys(patch).sort()).toEqual(['approvedAt', 'approvedBy']);
  });

  it('touches nothing on an edge that involves no approval at all', () => {
    // ASSERTION OF ABSENCE #2. A patch returning the clearing pair
    // unconditionally would pass the clearing test and wipe approvals on
    // unrelated updates of a Pending milestone.
    expect(milestoneApprovalPatch('Pending', 'Pending', 'julie@acme', AT)).toEqual({});
  });
});
