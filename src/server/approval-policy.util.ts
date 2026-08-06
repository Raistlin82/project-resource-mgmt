/**
 * Pure governance rules for the approval workflow engine.
 *
 * These live outside `src/server.ts` for the same reason every other policy
 * module does: that file cannot be imported by Vitest (it instantiates the
 * Angular SSR engine at load time), so a rule expressed inline there is a rule
 * with no test. Segregation of duties is the security boundary for every
 * approval kind, so it is exactly the wrong thing to leave untestable.
 */

/** The step shape these rules read. Mirrors `ApprovalStep` in src/server.ts. */
export interface DecidedStep {
  status: string;
  decidedBy?: string;
}

/**
 * SoD, second rule: NO ACTOR MAY DECIDE TWO STEPS OF THE SAME CHAIN.
 *
 * The engine already refuses a decider who is the requester
 * (`by === ar.requestedBy`). That is the only SoD rule it had, and it does not
 * constrain a MULTI-STEP chain: `buildApprovalSteps` escalates any item above
 * APPROVAL_HIGH_VALUE_THRESHOLD to a sequential
 * ['delivery-executive', 'finance'] chain precisely so that two different people
 * sign off, but the step check admits an actor whose role matches the step — and
 * `roleMatch` is true for `admin` on EVERY step. So one admin decided step 0,
 * the chain advanced to step 1, and the same admin decided that too: a €120k
 * invoice cleared by a single person through a control designed to require two.
 *
 * The chain records `decidedBy` on each decided step, so the rule is simply that
 * the incoming decider must not appear among the already-decided steps. Only
 * steps before `currentStep` can carry a decider (later ones are still Pending),
 * but scanning the whole array is equivalent and robust to a chain that was
 * stepped back by a rejection.
 *
 * Deliberately NOT exempting `admin`: an exemption would restore the exact hole
 * this closes. A deployment with a single privileged human cannot clear a
 * high-value item alone — that is the control working, not a defect.
 */
export function crossStepSoDError(
  steps: readonly DecidedStep[],
  decider: string | undefined,
): string | null {
  if (decider === undefined) return null;
  const already = steps.some(step => step.decidedBy === decider);
  if (!already) return null;
  return 'Segregation of duties: an actor who already decided an earlier step of this approval chain '
    + 'cannot decide a later one; a second approver is required';
}

/**
 * Kinds a client may open through `POST /approval-requests`.
 *
 * 'Allocation' is absent on purpose. Allocation approvals are opened ONLY by the
 * server's own month lifecycle (`createAllocationApprovalEntry`), which pins the
 * `refId` to a composite `<assignmentId>:<YYYY-MM>` month row so the decision
 * applies to exactly one governed month. `POST /approval-requests` validated
 * `refId` as "a non-empty string" and nothing more, so a client could open
 * `kind:'Allocation'` with a BARE assignment id — which
 * `applyAllocationDecision` then treats as a legacy gap-A approval and applies
 * to the assignment AND to every non-Draft month row beneath it. One forged
 * request, decided once, flipped every month of an assignment and bypassed the
 * per-month manager approval entirely.
 */
export const CLIENT_CREATABLE_APPROVAL_KINDS: readonly string[] = [
  'TimeEntry', 'Expense', 'Milestone', 'ChangeRequest', 'Invoice',
];

/**
 * Guard for `POST /approval-requests`: refuse a kind whose requests only the
 * server may open. Returns null for every kind a client legitimately creates,
 * and for an unknown kind (the caller's own enum check owns that message).
 */
export function clientCreatableApprovalKindError(kind: string): string | null {
  if (kind !== 'Allocation') return null;
  return 'Allocation approvals are opened by the allocation workflow, not created directly; '
    + 'submit the month for approval instead';
}

/**
 * Server-pinned approval fields for a milestone reaching 'Achieved'.
 *
 * `approvedBy` and `approvedAt` used to sit in the milestone `pick()` allow-list,
 * so any actor permitted to write a milestone could name SOMEONE ELSE as the
 * approver and back-date the approval — while the same PUT's transition to
 * 'Achieved' flips every linked fixed-price billing condition to 'Ready', i.e.
 * makes it billable. The approval record on a document that releases money must
 * come from the verified principal, never from the body.
 *
 * Returns the patch to fold onto the merged milestone: the pinned pair on the
 * edge INTO 'Achieved', nothing on any other edge (so an idempotent re-PUT of an
 * already-Achieved milestone does not rewrite the original approver), and a
 * clearing pair when a milestone is walked back to 'Pending' (a stale approval
 * record on a pending milestone would misattribute a decision that no longer
 * stands).
 */
export function milestoneApprovalPatch(
  previousStatus: string,
  nextStatus: string,
  actorId: string,
  decidedAtIso: string,
): { approvedBy?: string; approvedAt?: string } {
  if (nextStatus === 'Achieved') {
    if (previousStatus === 'Achieved') return {};
    return { approvedBy: actorId, approvedAt: decidedAtIso };
  }
  if (previousStatus === 'Achieved') return { approvedBy: undefined, approvedAt: undefined };
  return {};
}
