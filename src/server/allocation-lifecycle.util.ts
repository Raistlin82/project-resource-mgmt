import type { ApprovalRequest, AssignmentMonth } from '../app/services/api.service';
import type { Repository } from '../db/repository';

type MonthRepository = Pick<Repository<AssignmentMonth>, 'get' | 'update'>;
type ApprovalRepository = Pick<Repository<ApprovalRequest>, 'list' | 'get' | 'create' | 'update' | 'remove'>;

/** The smallest persistence surface needed by the monthly approval lifecycle. */
export interface AllocationLifecycleStore {
  assignmentMonths: MonthRepository;
  approvalRequests: ApprovalRepository;
}

/** A business conflict that HTTP handlers can map without leaking driver errors. */
export class AllocationLifecycleError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'AllocationLifecycleError';
  }
}

/** Result shape shared with the server's approval decision engine. */
export interface ApprovalDecisionOutcome {
  status: number;
  body: unknown;
  allocation?: { refId: string; decided: 'Approved' | 'Rejected' };
}

export interface AllocationMonthDecisionCommit {
  before: AssignmentMonth;
  after: AssignmentMonth;
  approval: ApprovalRequest;
  decided: 'Approved' | 'Rejected';
}

export interface AllocationMonthDecisionResult {
  outcome: ApprovalDecisionOutcome;
  commit?: AllocationMonthDecisionCommit;
}

type Transaction<TStore> = (
  monthId: string,
  operation: (store: TStore) => Promise<unknown>,
) => Promise<unknown>;

/**
 * Per-month command executor.
 *
 * The process-local queue removes Express `await` interleavings; the injected
 * transaction adds the persistence boundary (and, in production, the database
 * advisory lock). Every lifecycle caller uses the same month id, so submit,
 * edit/supersede and decide have one total order.
 */
export class AllocationLifecycleExecutor<TStore> {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly transaction: Transaction<TStore>) {}

  run<R>(monthId: string, operation: (store: TStore) => Promise<R>): Promise<R> {
    const previous = this.tails.get(monthId) ?? Promise.resolve();
    const run = previous.then(
      () => this.transaction(monthId, operation),
      () => this.transaction(monthId, operation),
    ) as Promise<R>;
    const tail = run.then(() => undefined, () => undefined);
    this.tails.set(monthId, tail);
    void tail.then(() => {
      if (this.tails.get(monthId) === tail) this.tails.delete(monthId);
    });
    return run;
  }
}

interface NewApprovalInput {
  autoApprove: boolean;
  plannerNote?: string;
  createApproval(): Promise<ApprovalRequest>;
}

function clearOptionalString(): undefined {
  // Repository.update uses an explicit null as the write-side "clear" token;
  // both adapters normalize it back to undefined on reads.
  return null as unknown as undefined;
}

function conflict(message: string): ApprovalMonthDecisionFailure {
  return { outcome: { status: 409, body: { error: message } } };
}

type ApprovalMonthDecisionFailure = AllocationMonthDecisionResult & { commit?: undefined };

async function withdrawPending(
  store: AllocationLifecycleStore,
  approvalId: string | undefined,
  reason: string,
): Promise<ApprovalRequest | undefined> {
  if (!approvalId) return undefined;
  const current = await store.approvalRequests.get(approvalId);
  if (!current || current.status !== 'Pending') return undefined;
  const updated = await store.approvalRequests.update(approvalId, {
    status: 'Rejected',
    note: reason,
  });
  if (!updated) throw new AllocationLifecycleError('approval disappeared while being superseded');
  return current;
}

async function restoreApproval(
  store: AllocationLifecycleStore,
  snapshot: ApprovalRequest | undefined,
): Promise<void> {
  if (!snapshot) return;
  try { await store.approvalRequests.update(snapshot.id, snapshot); } catch { /* preserve the primary failure */ }
}

async function removeCreatedApproval(
  store: AllocationLifecycleStore,
  created: ApprovalRequest | undefined,
): Promise<void> {
  if (!created) return;
  try { await store.approvalRequests.remove(created.id); } catch { /* preserve the primary failure */ }
}

function validateNewApproval(approval: ApprovalRequest, monthId: string): void {
  if (approval.kind !== 'Allocation' || approval.refId !== monthId || approval.status !== 'Pending') {
    throw new AllocationLifecycleError('new approval does not govern the requested month');
  }
}

/** Draft|Rejected -> Requested (or Allocated for the accountable manager). */
export async function submitAllocationMonth(
  store: AllocationLifecycleStore,
  monthId: string,
  input: NewApprovalInput,
): Promise<AssignmentMonth> {
  const row = await store.assignmentMonths.get(monthId);
  if (!row) throw new AllocationLifecycleError('no allocation for this month', 404);
  if (row.status !== 'Draft' && row.status !== 'Rejected') {
    throw new AllocationLifecycleError(`illegal month transition ${row.status} -> Requested`, 400);
  }

  let withdrawn: ApprovalRequest | undefined;
  let created: ApprovalRequest | undefined;
  try {
    withdrawn = await withdrawPending(store, row.approvalId, 'superseded');
    if (!input.autoApprove) {
      created = await input.createApproval();
      validateNewApproval(created, monthId);
    }
    const updated = await store.assignmentMonths.update(monthId, {
      status: input.autoApprove ? 'Allocated' : 'Requested',
      approvalId: input.autoApprove ? clearOptionalString() : created?.id,
      ...(input.plannerNote !== undefined ? { plannerNote: input.plannerNote } : {}),
    });
    if (!updated) throw new AllocationLifecycleError('month disappeared while being submitted', 404);
    return updated;
  } catch (error) {
    await removeCreatedApproval(store, created);
    await restoreApproval(store, withdrawn);
    throw error;
  }
}

/**
 * Version an edited Requested/Allocated month.
 *
 * `approvalId` is the revision token: an edit closes the old pending request
 * and links a fresh one. A decision for the old id therefore fails its CAS
 * instead of approving hours that were never reviewed.
 */
export async function reviseAllocationMonthAfterEdit(
  store: AllocationLifecycleStore,
  monthId: string,
  input: Omit<NewApprovalInput, 'plannerNote'> & { reason?: string },
): Promise<AssignmentMonth> {
  const row = await store.assignmentMonths.get(monthId);
  if (!row) throw new AllocationLifecycleError('no allocation for this month', 404);
  if (row.status !== 'Requested' && row.status !== 'Allocated') return row;

  let withdrawn: ApprovalRequest | undefined;
  let created: ApprovalRequest | undefined;
  try {
    withdrawn = await withdrawPending(
      store,
      row.approvalId,
      input.reason ?? 'superseded by allocation edit',
    );
    if (!input.autoApprove) {
      created = await input.createApproval();
      validateNewApproval(created, monthId);
    }
    const updated = await store.assignmentMonths.update(monthId, {
      status: input.autoApprove ? 'Allocated' : 'Requested',
      approvalId: input.autoApprove ? clearOptionalString() : created?.id,
      // A new revision has no approver note yet. Leaving the old note displayed
      // would make a pending revision look already decided.
      approverNote: clearOptionalString(),
    });
    if (!updated) throw new AllocationLifecycleError('month disappeared while being revised', 404);
    return updated;
  } catch (error) {
    await removeCreatedApproval(store, created);
    await restoreApproval(store, withdrawn);
    throw error;
  }
}

/**
 * Decide only the approval that still governs the Requested month.
 *
 * The caller's decision callback owns authorization and the approval-engine
 * mutation. This function owns the approvalId CAS and the paired month write.
 * If the second write fails in the in-memory adapter, the approval snapshot is
 * restored; PostgreSQL additionally rolls both writes back in one transaction.
 */
export async function decideCurrentAllocationMonth(
  store: AllocationLifecycleStore,
  monthId: string,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  note: string | undefined,
  decideApproval: () => Promise<ApprovalDecisionOutcome>,
): Promise<AllocationMonthDecisionResult> {
  const row = await store.assignmentMonths.get(monthId);
  if (!row) return { outcome: { status: 404, body: { error: 'Not found' } } };

  // WHICH REFUSAL, AND WHY THE ORDER IS WHAT IT IS. Two different situations both
  // end with "this decision cannot be applied", and reporting one as the other
  // misleads whoever reads the message:
  //
  //   * The row has ROTATED to a newer approval (`row.approvalId !== approvalId`).
  //     An edit revised the month and withdrew this approval as superseded. The
  //     revision token is the discriminator, so it is checked FIRST — the
  //     withdrawn approval's own status must not be reported as "already
  //     decided", because no approver decided it. -> 409 revision conflict.
  //   * This approval still governs the row but is no longer Pending: a plain
  //     replay of the same decision. -> 400 "approval request already <status>",
  //     which names the real cause instead of blaming a revision that did not
  //     change.
  if (row.approvalId !== approvalId) {
    return conflict('approval no longer governs the current month revision');
  }

  const approvalBefore = await store.approvalRequests.get(approvalId);
  if (!approvalBefore) return { outcome: { status: 404, body: { error: 'Not found' } } };
  if (approvalBefore.kind !== 'Allocation' || approvalBefore.refId !== monthId) {
    return conflict('approval does not govern this month');
  }
  if (approvalBefore.status !== 'Pending') {
    return { outcome: { status: 400, body: { error: `approval request already ${approvalBefore.status}` } } };
  }
  if (row.status !== 'Requested') {
    return conflict('approval no longer governs the current month revision');
  }

  try {
    const outcome = await decideApproval();
    if (outcome.status !== 200) return { outcome };
    if (!outcome.allocation
      || outcome.allocation.refId !== monthId
      || outcome.allocation.decided !== decision) {
      throw new AllocationLifecycleError('approval engine returned a mismatched allocation decision', 500);
    }
    const after = await store.assignmentMonths.update(monthId, {
      status: decision === 'Approved' ? 'Allocated' : 'Rejected',
      approverNote: (note ?? null) as unknown as undefined,
    });
    if (!after) throw new AllocationLifecycleError('month disappeared while applying its decision', 404);
    return {
      outcome,
      commit: { before: row, after, approval: approvalBefore, decided: decision },
    };
  } catch (error) {
    await restoreApproval(store, approvalBefore);
    throw error;
  }
}
