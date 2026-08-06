import { describe, expect, it } from 'vitest';
import {
  AMOUNT_DERIVED_APPROVAL_KINDS,
  APPROVAL_HIGH_VALUE_THRESHOLD,
  buildApprovalSteps,
  CLIENT_CREATABLE_APPROVAL_KINDS,
  clientCreatableApprovalKindError,
  crossStepSoDError,
  escalatesToTwoSignatures,
  isAmountDerivedApprovalKind,
  milestoneApprovalPatch,
  resolveApprovalRoutingAmount,
  type ApprovalAmountSources,
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

// --- H2: the escalation amount is DERIVED from refId, never declared ---------

/**
 * A source set standing in for the repositories. Every case below states the
 * fixture's amount EXPLICITLY and asserts it against the threshold, because "a
 * fixture that never enters the branch" is how this project's blind green gates
 * have been built before: a 120000 order that quietly became 1200 would make the
 * escalation test pass for the wrong reason.
 */
function sourcesFor(rows: {
  orders?: Record<string, { amount?: number }>;
  changeRequests?: Record<string, { impactBudget?: number }>;
  milestones?: readonly string[];
  billingConditions?: Record<string, readonly { amount?: number }[]>;
}): ApprovalAmountSources {
  return {
    order: async id => rows.orders?.[id],
    changeRequest: async id => rows.changeRequests?.[id],
    milestone: async id => (rows.milestones ?? []).includes(id) ? { id } : undefined,
    billingConditionsForMilestone: async id => rows.billingConditions?.[id] ?? [],
  };
}

const HIGH = 120000;
const LOW = 12000;

describe('resolveApprovalRoutingAmount', () => {
  it('the fixtures actually straddle the threshold', () => {
    // The fixture assertion the rest of this file leans on. Without it every
    // "escalates"/"does not escalate" case below could be passing because the two
    // numbers sit on the same side of 50000.
    expect(APPROVAL_HIGH_VALUE_THRESHOLD).toBe(50000);
    expect(HIGH).toBeGreaterThan(APPROVAL_HIGH_VALUE_THRESHOLD);
    expect(LOW).toBeLessThan(APPROVAL_HIGH_VALUE_THRESHOLD);
  });

  it("derives an Invoice's amount from the linked order, not from the body", async () => {
    // THE DEFECT (H2). `POST /approval-requests` allow-listed `amount` and passed
    // it to buildApprovalSteps without ever reading `refId`, so a requester
    // declared 1 on a 120000 invoice and got the single-approver chain. There is
    // no body here at all: the amount can only come from the order.
    const sources = sourcesFor({ orders: { O3: { amount: HIGH } } });
    expect(await resolveApprovalRoutingAmount('Invoice', 'O3', sources))
      .toEqual({ outcome: 'derived', amount: HIGH });
  });

  it("derives a ChangeRequest's amount from impactBudget", async () => {
    const sources = sourcesFor({ changeRequests: { CR1: { impactBudget: LOW } } });
    expect(await resolveApprovalRoutingAmount('ChangeRequest', 'CR1', sources))
      .toEqual({ outcome: 'derived', amount: LOW });
  });

  it('keeps the SIGN of a scope-reducing change request', async () => {
    // The recorded amount is the figure as it stands on the CR (a reduction is
    // negative and says so); it is `escalatesToTwoSignatures` that reads the
    // MAGNITUDE. Asserting the sign survives here is what stops a "fix" that
    // absolutises at derivation time and silently rewrites the document's figure.
    const sources = sourcesFor({ changeRequests: { CR9: { impactBudget: -HIGH } } });
    expect(await resolveApprovalRoutingAmount('ChangeRequest', 'CR9', sources))
      .toEqual({ outcome: 'derived', amount: -HIGH });
  });

  it('sums the billing conditions a Milestone triggers', async () => {
    const sources = sourcesFor({
      milestones: ['M2'],
      billingConditions: { M2: [{ amount: 150000 }, { amount: -5000 }] },
    });
    expect(await resolveApprovalRoutingAmount('Milestone', 'M2', sources))
      .toEqual({ outcome: 'derived', amount: 145000 });
  });

  it('derives 0 for a Milestone that triggers no billing condition', async () => {
    // ASSERTION OF ABSENCE. A resolver that treated "no rows" as unresolvable
    // would 400 every milestone approval that releases no money — most of them —
    // and would still pass the summing case above.
    const sources = sourcesFor({ milestones: ['M1'], billingConditions: {} });
    expect(await resolveApprovalRoutingAmount('Milestone', 'M1', sources))
      .toEqual({ outcome: 'derived', amount: 0 });
  });

  it('reports NO amount for TimeEntry and Expense rather than falling back to the body', async () => {
    // The hole the product owner explicitly refused to leave open. These two kinds
    // have no natural amount (a time entry's object is HOURS; there is no Expense
    // entity in the model at all), so they must resolve to 'no-amount' — a variant
    // carrying no number — and never to a client-declared one. `refId` is
    // deliberately unresolvable here AND the source set is empty, so a resolver
    // that consulted anything at all would have to fail rather than pass.
    const sources = sourcesFor({});
    expect(await resolveApprovalRoutingAmount('TimeEntry', 'TE3', sources)).toEqual({ outcome: 'no-amount' });
    expect(await resolveApprovalRoutingAmount('Expense', 'anything-at-all', sources)).toEqual({ outcome: 'no-amount' });
  });

  it('refuses a derivable kind whose refId does not resolve', async () => {
    // An unresolvable reference is a BAD REQUEST, not a reason to trust the body.
    const empty = sourcesFor({});
    const invoice = await resolveApprovalRoutingAmount('Invoice', 'NOPE', empty);
    const cr = await resolveApprovalRoutingAmount('ChangeRequest', 'NOPE', empty);
    const milestone = await resolveApprovalRoutingAmount('Milestone', 'NOPE', empty);
    expect(invoice.outcome).toBe('unresolved');
    expect(cr.outcome).toBe('unresolved');
    expect(milestone.outcome).toBe('unresolved');
    // The message must name what failed to resolve, or the 400 is unactionable.
    for (const res of [invoice, cr, milestone]) {
      expect(res.outcome === 'unresolved' ? res.error : '').toContain('NOPE');
    }
  });

  it('still resolves the same refId once the row exists', async () => {
    // ASSERTION OF ABSENCE for the refusal above. A resolver that refused EVERY
    // reference would pass all three refusal cases and make approvals
    // uncreatable; this is the half that must still be ALLOWED.
    const sources = sourcesFor({
      orders: { NOPE: { amount: LOW } },
      changeRequests: { NOPE: { impactBudget: LOW } },
      milestones: ['NOPE'],
    });
    expect(await resolveApprovalRoutingAmount('Invoice', 'NOPE', sources)).toEqual({ outcome: 'derived', amount: LOW });
    expect(await resolveApprovalRoutingAmount('ChangeRequest', 'NOPE', sources)).toEqual({ outcome: 'derived', amount: LOW });
    expect(await resolveApprovalRoutingAmount('Milestone', 'NOPE', sources)).toEqual({ outcome: 'derived', amount: 0 });
  });

  it('refuses a resolved row whose amount is not a finite number', async () => {
    // Defaulting a missing/NaN amount to 0 would route a corrupt 120000 order
    // single-step — the same hole reached by a different path.
    const nan = await resolveApprovalRoutingAmount('Invoice', 'O9', sourcesFor({ orders: { O9: { amount: Number.NaN } } }));
    expect(nan.outcome).toBe('unresolved');
    const missing = await resolveApprovalRoutingAmount('ChangeRequest', 'CR9', sourcesFor({ changeRequests: { CR9: {} } }));
    expect(missing.outcome).toBe('unresolved');
    const badCondition = await resolveApprovalRoutingAmount('Milestone', 'M2', sourcesFor({
      milestones: ['M2'],
      billingConditions: { M2: [{ amount: HIGH }, { amount: undefined }] },
    }));
    expect(badCondition.outcome).toBe('unresolved');
  });

  it('keeps the derivable-kind list and the guard in agreement', () => {
    // The list documents the policy, the guard enforces it; asserting them against
    // each other is what stops one being edited alone. TimeEntry/Expense must stay
    // OUT, and Allocation is not client-creatable at all.
    for (const kind of AMOUNT_DERIVED_APPROVAL_KINDS) {
      expect(isAmountDerivedApprovalKind(kind)).toBe(true);
    }
    for (const kind of ['TimeEntry', 'Expense', 'Allocation']) {
      expect(AMOUNT_DERIVED_APPROVAL_KINDS).not.toContain(kind);
      expect(isAmountDerivedApprovalKind(kind)).toBe(false);
    }
  });
});

describe('escalatesToTwoSignatures', () => {
  it('escalates above the threshold and not at it', () => {
    expect(escalatesToTwoSignatures({ outcome: 'derived', amount: APPROVAL_HIGH_VALUE_THRESHOLD + 0.01 })).toBe(true);
    // The boundary, unchanged from before H2: STRICTLY greater escalates.
    expect(escalatesToTwoSignatures({ outcome: 'derived', amount: APPROVAL_HIGH_VALUE_THRESHOLD })).toBe(false);
    expect(escalatesToTwoSignatures({ outcome: 'derived', amount: LOW })).toBe(false);
  });

  it('escalates a large NEGATIVE amount, reading the magnitude', () => {
    // THE DECISION: a -120000 change request removes 120k of scope from a project
    // and is as consequential as adding it, so the threshold reads |amount|.
    // Comparing the signed value is the same hole with a minus sign.
    expect(escalatesToTwoSignatures({ outcome: 'derived', amount: -HIGH })).toBe(true);
    // ...and a SMALL negative still does not escalate, so this is a magnitude rule
    // and not "any negative escalates".
    expect(escalatesToTwoSignatures({ outcome: 'derived', amount: -LOW })).toBe(false);
  });

  it('never escalates when there is no amount', () => {
    expect(escalatesToTwoSignatures({ outcome: 'no-amount' })).toBe(false);
  });
});

describe('buildApprovalSteps', () => {
  it('builds the TWO-signature chain for a derived high-value amount', async () => {
    // THE UNIT DETECTOR for H2: a body declaring 1 cannot even be expressed here
    // (the only input is a resolution the SERVER produced), and a 120000 order
    // yields delivery-executive THEN finance, in that order.
    const resolved = await resolveApprovalRoutingAmount('Invoice', 'O3', sourcesFor({ orders: { O3: { amount: HIGH } } }));
    expect(resolved).toEqual({ outcome: 'derived', amount: HIGH });
    expect(buildApprovalSteps('Invoice', { outcome: 'derived', amount: HIGH })).toEqual([
      { role: 'delivery-executive', status: 'Pending' },
      { role: 'finance', status: 'Pending' },
    ]);
  });

  it('builds ONE step for a genuinely small item', async () => {
    // ASSERTION OF ABSENCE #1. A rule that always escalated would pass the case
    // above on its own. A 12000 invoice keeps its single `finance` approver.
    const resolved = await resolveApprovalRoutingAmount('Invoice', 'O4', sourcesFor({ orders: { O4: { amount: LOW } } }));
    expect(resolved).toEqual({ outcome: 'derived', amount: LOW });
    const steps = buildApprovalSteps('Invoice', { outcome: 'derived', amount: LOW });
    expect(steps).toEqual([{ role: 'finance', status: 'Pending' }]);
    expect(steps).toHaveLength(1);
  });

  it('routes a TimeEntry by kind however large the item its refId names', async () => {
    // ASSERTION OF ABSENCE #2. The non-derivable kinds must reach their by-kind
    // chain, and the resolution they get carries no number to escalate on — so
    // this is also the proof that no client value can leak into routing.
    const resolved = await resolveApprovalRoutingAmount('TimeEntry', 'TE3', sourcesFor({ orders: { TE3: { amount: HIGH } } }));
    expect(resolved).toEqual({ outcome: 'no-amount' });
    expect(buildApprovalSteps('TimeEntry', { outcome: 'no-amount' }))
      .toEqual([{ role: 'resource-manager', status: 'Pending' }]);
  });

  it('escalates a -120000 change request and keeps a -12000 one single-step', async () => {
    const big = await resolveApprovalRoutingAmount('ChangeRequest', 'CR9', sourcesFor({ changeRequests: { CR9: { impactBudget: -HIGH } } }));
    expect(big).toEqual({ outcome: 'derived', amount: -HIGH });
    expect(buildApprovalSteps('ChangeRequest', { outcome: 'derived', amount: -HIGH }).map(s => s.role))
      .toEqual(['delivery-executive', 'finance']);
    const small = await resolveApprovalRoutingAmount('ChangeRequest', 'CR8', sourcesFor({ changeRequests: { CR8: { impactBudget: -LOW } } }));
    expect(small).toEqual({ outcome: 'derived', amount: -LOW });
    expect(buildApprovalSteps('ChangeRequest', { outcome: 'derived', amount: -LOW }).map(s => s.role))
      .toEqual(['delivery-executive']);
  });

  it('keeps every step Pending and unattributed', () => {
    // A fresh chain must carry no decider: the SoD rules above key on `decidedBy`,
    // so a pre-populated step would defeat them.
    const steps = buildApprovalSteps('Invoice', { outcome: 'derived', amount: HIGH });
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.status).toBe('Pending');
      expect((step as { decidedBy?: string }).decidedBy).toBeUndefined();
    }
  });
});
