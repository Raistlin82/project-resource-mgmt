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

// --- Escalation routing: the amount is DERIVED, never declared ---------------

/**
 * Amount above which an approval escalates from its single by-kind approver to
 * the sequential two-signature `['delivery-executive', 'finance']` chain.
 */
export const APPROVAL_HIGH_VALUE_THRESHOLD = 50000;

/**
 * Kinds whose escalation amount is DERIVED from `refId`, and the field it comes
 * from — declared as data so the guard, the resolver and the docs cannot drift:
 *
 *   - `Invoice`       -> the linked order's `amount` (`refId` IS an order id;
 *                        see the AR2 seed: refId 'O3', amount 120000 = O3.amount).
 *   - `ChangeRequest` -> the CR's `impactBudget` (signed: a CR may reduce scope).
 *   - `Milestone`     -> the sum of the `amount`s of the billing conditions the
 *                        milestone triggers (`billingPlanItems.milestoneId`).
 *
 * `TimeEntry` and `Expense` are ABSENT on purpose, and their absence is the
 * point rather than an omission — see `resolveApprovalRoutingAmount`.
 */
export const AMOUNT_DERIVED_APPROVAL_KINDS: readonly string[] = ['Invoice', 'ChangeRequest', 'Milestone'];

/** True for a kind whose escalation amount is derived from `refId`. */
export function isAmountDerivedApprovalKind(kind: string): boolean {
  return AMOUNT_DERIVED_APPROVAL_KINDS.includes(kind);
}

/**
 * The rows the derivation reads, narrowed to the single field each contributes.
 * A port rather than a repository import: the rule is what this module owns and
 * must be able to test, the row-fetching is `src/server.ts`'s three-line adapter.
 */
export interface ApprovalAmountSources {
  order(id: string): Promise<{ amount?: number } | undefined>;
  changeRequest(id: string): Promise<{ impactBudget?: number } | undefined>;
  milestone(id: string): Promise<{ id: string } | undefined>;
  /** The billing conditions this milestone triggers (possibly none). */
  billingConditionsForMilestone(milestoneId: string): Promise<readonly { amount?: number }[]>;
}

/**
 * An amount a chain may legitimately be routed on: either derived from the
 * referenced document, or absent because the kind genuinely has none.
 *
 * There is deliberately NO variant carrying a client-supplied number, and
 * `buildApprovalSteps` accepts only this type: the declared `amount` is not
 * merely ignored by the current handler, it is UNREPRESENTABLE as a routing
 * input, so the hole cannot be reopened by a later edit that "passes the amount
 * through". `amount` is signed — the sign belongs to the referenced document —
 * and the threshold reads its magnitude (see `escalatesToTwoSignatures`).
 */
export type ResolvedApprovalAmount =
  | { outcome: 'derived'; amount: number }
  | { outcome: 'no-amount' };

/** `ResolvedApprovalAmount`, plus the refusal a caller must turn into a 400. */
export type ApprovalAmountResolution =
  | ResolvedApprovalAmount
  | { outcome: 'unresolved'; error: string };

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * DERIVE the escalation amount for a new approval request from its `refId`.
 *
 * THE DEFECT this replaces: `POST /approval-requests` put `amount` in the
 * `pick()` allow-list and handed the client's number straight to
 * `buildApprovalSteps`, which never reconciled it with `refId`. So the requester
 * chose their own approval chain — declare `amount: 1` on a €120k invoice and it
 * routed to the single `finance` approver instead of the two-signature
 * delivery-executive -> finance chain the €50k control exists to force. The
 * amount that decides a two-signature control cannot come from the party the
 * control constrains.
 *
 * `TimeEntry` and `Expense` return 'no-amount', NOT the declared value:
 *   - a time entry's governance object is HOURS; a monetary figure for it would
 *     have to be invented from a rate card the request does not reference, and
 *     an invented number routing a €-threshold control is worse than none;
 *   - there is no Expense entity in the model at all (`src/db/schema.ts` has no
 *     expenses table — 'Expense' exists only as a BillingType), so `refId` has
 *     nothing to resolve against.
 * Both therefore always route through their by-kind chain (`resource-manager`).
 * Falling back to the body for these two would have left the whole hole open
 * behind a narrower door.
 *
 * A derivable kind whose `refId` does not resolve is a BAD REQUEST: an
 * unresolvable reference is never a reason to trust the body instead. The same
 * applies when the referenced row exists but its amount field is not a finite
 * number — defaulting that to 0 would route a corrupt €120k order single-step.
 */
export async function resolveApprovalRoutingAmount(
  kind: string,
  refId: string,
  sources: ApprovalAmountSources,
): Promise<ApprovalAmountResolution> {
  if (!isAmountDerivedApprovalKind(kind)) return { outcome: 'no-amount' };
  if (kind === 'Invoice') {
    const order = await sources.order(refId);
    if (order === undefined) {
      return { outcome: 'unresolved', error: `refId must reference an existing order for kind 'Invoice': no order '${refId}'` };
    }
    const amount = finiteOrUndefined(order.amount);
    if (amount === undefined) {
      return { outcome: 'unresolved', error: `order '${refId}' has no usable amount, so the approval chain cannot be derived` };
    }
    return { outcome: 'derived', amount };
  }
  if (kind === 'ChangeRequest') {
    const cr = await sources.changeRequest(refId);
    if (cr === undefined) {
      return { outcome: 'unresolved', error: `refId must reference an existing change request for kind 'ChangeRequest': no change request '${refId}'` };
    }
    const amount = finiteOrUndefined(cr.impactBudget);
    if (amount === undefined) {
      return { outcome: 'unresolved', error: `change request '${refId}' has no usable impactBudget, so the approval chain cannot be derived` };
    }
    return { outcome: 'derived', amount };
  }
  const milestone = await sources.milestone(refId);
  if (milestone === undefined) {
    return { outcome: 'unresolved', error: `refId must reference an existing milestone for kind 'Milestone': no milestone '${refId}'` };
  }
  const conditions = await sources.billingConditionsForMilestone(refId);
  let total = 0;
  for (const condition of conditions) {
    const amount = finiteOrUndefined(condition.amount);
    if (amount === undefined) {
      return { outcome: 'unresolved', error: `a billing condition of milestone '${refId}' has no usable amount, so the approval chain cannot be derived` };
    }
    total += amount;
  }
  // No billing condition = this milestone releases no money: a real derived 0,
  // which routes by kind. NOT 'no-amount' — the difference is that 0 is a fact
  // about the milestone, and recording it says the derivation ran.
  return { outcome: 'derived', amount: total };
}

/**
 * Does this amount cross the two-signature threshold?
 *
 * Reads the MAGNITUDE. A change request of -120000 reduces scope by €120k, which
 * is exactly as consequential as adding €120k — it removes budget from a project
 * and, once approved, from its effective budget. Comparing the signed value
 * would have routed every large REDUCTION single-step, which is the same hole
 * with a minus sign. Strictly greater than the threshold, so an item exactly AT
 * €50 000 keeps its single approver (the pre-existing boundary, unchanged).
 */
export function escalatesToTwoSignatures(resolved: ResolvedApprovalAmount): boolean {
  if (resolved.outcome === 'no-amount') return false;
  return Math.abs(resolved.amount) > APPROVAL_HIGH_VALUE_THRESHOLD;
}

/** A freshly built, undecided chain step. Mirrors `ApprovalStep` in src/server.ts. */
export interface PendingStep { role: string; status: 'Pending' }

/** The two roles, in order, that a high-value item must collect signatures from. */
export const HIGH_VALUE_APPROVAL_CHAIN: readonly string[] = ['delivery-executive', 'finance'];

/** Single-approver routing by kind (used when no high-value escalation applies). */
export function approverRolesByKind(kind: string): readonly string[] {
  switch (kind) {
    case 'TimeEntry':
    case 'Expense':
      return ['resource-manager'];
    case 'Milestone':
    case 'ChangeRequest':
      return ['delivery-executive'];
    case 'Invoice':
      return ['finance'];
    default:
      return ['delivery-executive'];
  }
}

/**
 * RULES evaluator: build the ordered approver chain for an approval request.
 * Amount-threshold routing takes precedence — a high-value item routes to
 * delivery-executive then finance (sequential). Otherwise a single approver is
 * chosen by kind.
 *
 * Takes a `ResolvedApprovalAmount`, never a bare number, so the only amount that
 * can reach this rule is one the SERVER derived (or the explicit absence of
 * one). See `resolveApprovalRoutingAmount`.
 */
export function buildApprovalSteps(kind: string, resolved: ResolvedApprovalAmount): PendingStep[] {
  const roles = escalatesToTwoSignatures(resolved) ? HIGH_VALUE_APPROVAL_CHAIN : approverRolesByKind(kind);
  return roles.map(role => ({ role, status: 'Pending' as const }));
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
