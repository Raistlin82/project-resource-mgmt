import { describe, expect, it } from 'vitest';
import type { ApprovalRequest, AssignmentMonth } from '../app/services/api.service';
import { InMemoryRepository } from '../db/repository';
import {
  AllocationLifecycleExecutor,
  decideCurrentAllocationMonth,
  reviseAllocationMonthAfterEdit,
  submitAllocationMonth,
  type AllocationLifecycleStore,
  type ApprovalDecisionOutcome,
} from './allocation-lifecycle.util';

const MONTH_ID = 'A1:2026-08';

function month(status: AssignmentMonth['status'], approvalId?: string): AssignmentMonth {
  return { id: MONTH_ID, assignmentId: 'A1', month: '2026-08', status, approvalId };
}

function approval(id: string): ApprovalRequest {
  return {
    id,
    kind: 'Allocation',
    refId: MONTH_ID,
    requestedBy: 'planner',
    status: 'Pending',
    steps: [{ role: 'resource-manager', status: 'Pending', approverId: 'manager' }],
    currentStep: 0,
    createdAt: '2026-08-04T10:00:00.000Z',
  };
}

function storeWith(row: AssignmentMonth, approvals: ApprovalRequest[] = []): AllocationLifecycleStore {
  return {
    assignmentMonths: new InMemoryRepository([row]),
    approvalRequests: new InMemoryRepository(approvals),
  };
}

function executorFor(store: AllocationLifecycleStore): AllocationLifecycleExecutor<AllocationLifecycleStore> {
  return new AllocationLifecycleExecutor(async (_monthId, operation) => operation(store));
}

function approvalFactory(store: AllocationLifecycleStore, id: string): () => Promise<ApprovalRequest> {
  return () => store.approvalRequests.create(approval(id));
}

async function approve(
  store: AllocationLifecycleStore,
  approvalId: string,
): Promise<ApprovalDecisionOutcome> {
  const current = await store.approvalRequests.get(approvalId);
  if (!current || current.status !== 'Pending') {
    return { status: 400, body: { error: 'not pending' } };
  }
  const decided: ApprovalRequest = {
    ...current,
    status: 'Approved',
    currentStep: 1,
    steps: current.steps.map((step, index) => index === 0
      ? { ...step, status: 'Approved', decidedBy: 'manager' }
      : step),
  };
  const updated = await store.approvalRequests.update(approvalId, decided);
  return {
    status: 200,
    body: updated,
    allocation: { refId: current.refId, decided: 'Approved' },
  };
}

describe('versioned monthly allocation approval lifecycle', () => {
  it('serializes two submits so exactly one approval is created and none is orphaned', async () => {
    const store = storeWith(month('Draft'));
    const executor = executorFor(store);
    let next = 0;
    const submit = () => executor.run(MONTH_ID, repositories => submitAllocationMonth(repositories, MONTH_ID, {
      autoApprove: false,
      createApproval: async () => {
        // Yield once so the old un-serialized read/create/write sequence
        // deterministically lets both requests observe Draft.
        await Promise.resolve();
        return repositories.approvalRequests.create(approval(`AR${++next}`));
      },
    }));

    const settled = await Promise.allSettled([submit(), submit()]);

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
    const approvals = await store.approvalRequests.list();
    expect(approvals).toHaveLength(1);
    expect(await store.assignmentMonths.get(MONTH_ID)).toMatchObject({
      status: 'Requested',
      approvalId: approvals[0].id,
    });
  });

  it('makes edit win over a stale decision by rotating the approval id as the revision token', async () => {
    const store = storeWith(month('Requested', 'AR1'), [approval('AR1')]);
    const executor = executorFor(store);

    const [, staleDecision] = await Promise.all([
      executor.run(MONTH_ID, repositories => reviseAllocationMonthAfterEdit(repositories, MONTH_ID, {
        autoApprove: false,
        createApproval: approvalFactory(repositories, 'AR2'),
      })),
      executor.run(MONTH_ID, repositories => decideCurrentAllocationMonth(
        repositories,
        MONTH_ID,
        'AR1',
        'Approved',
        undefined,
        () => approve(repositories, 'AR1'),
      )),
    ]);

    expect(staleDecision.outcome.status).toBe(409);
    expect(await store.approvalRequests.get('AR1')).toMatchObject({ status: 'Rejected' });
    expect(await store.approvalRequests.get('AR2')).toMatchObject({ status: 'Pending' });
    expect(await store.assignmentMonths.get(MONTH_ID)).toMatchObject({
      status: 'Requested',
      approvalId: 'AR2',
    });
  });

  it('makes decision win over a concurrent edit only by forcing the edit into a new Requested revision', async () => {
    const store = storeWith(month('Requested', 'AR1'), [approval('AR1')]);
    const executor = executorFor(store);

    const [decision] = await Promise.all([
      executor.run(MONTH_ID, repositories => decideCurrentAllocationMonth(
        repositories,
        MONTH_ID,
        'AR1',
        'Approved',
        undefined,
        () => approve(repositories, 'AR1'),
      )),
      executor.run(MONTH_ID, repositories => reviseAllocationMonthAfterEdit(repositories, MONTH_ID, {
        autoApprove: false,
        createApproval: approvalFactory(repositories, 'AR2'),
      })),
    ]);

    expect(decision.outcome.status).toBe(200);
    expect(await store.approvalRequests.get('AR1')).toMatchObject({ status: 'Approved' });
    expect(await store.approvalRequests.get('AR2')).toMatchObject({ status: 'Pending' });
    expect(await store.assignmentMonths.get(MONTH_ID)).toMatchObject({
      status: 'Requested',
      approvalId: 'AR2',
    });
  });

  it('serializes a superseding withdrawal against decision so one terminal outcome wins', async () => {
    const store = storeWith(month('Requested', 'AR1'), [approval('AR1')]);
    const executor = executorFor(store);

    await Promise.all([
      executor.run(MONTH_ID, repositories => reviseAllocationMonthAfterEdit(repositories, MONTH_ID, {
        autoApprove: false,
        createApproval: approvalFactory(repositories, 'AR2'),
      })),
      executor.run(MONTH_ID, repositories => decideCurrentAllocationMonth(
        repositories,
        MONTH_ID,
        'AR1',
        'Rejected',
        'too late',
        () => approve(repositories, 'AR1'),
      )),
    ]);

    expect(await store.approvalRequests.get('AR1')).toMatchObject({ status: 'Rejected' });
    expect(await store.assignmentMonths.get(MONTH_ID)).toMatchObject({
      status: 'Requested',
      approvalId: 'AR2',
    });
  });

  it('rolls the approval back when the month write fails, then allows one clean retry', async () => {
    class FailFirstDecisionMonthRepository extends InMemoryRepository<AssignmentMonth> {
      private fail = true;

      override update(id: string, patch: Partial<AssignmentMonth>): Promise<AssignmentMonth | undefined> {
        if (this.fail && patch.status === 'Allocated') {
          this.fail = false;
          return Promise.reject(new Error('simulated failure between approval and month'));
        }
        return super.update(id, patch);
      }
    }

    const store: AllocationLifecycleStore = {
      assignmentMonths: new FailFirstDecisionMonthRepository([month('Requested', 'AR1')]),
      approvalRequests: new InMemoryRepository([approval('AR1')]),
    };
    const executor = executorFor(store);
    const decide = () => executor.run(MONTH_ID, repositories => decideCurrentAllocationMonth(
      repositories,
      MONTH_ID,
      'AR1',
      'Approved',
      undefined,
      () => approve(repositories, 'AR1'),
    ));

    await expect(decide()).rejects.toThrow('simulated failure between approval and month');
    expect(await store.approvalRequests.get('AR1')).toMatchObject({ status: 'Pending', currentStep: 0 });
    expect(await store.assignmentMonths.get(MONTH_ID)).toMatchObject({ status: 'Requested', approvalId: 'AR1' });

    const retried = await decide();
    expect(retried.outcome.status).toBe(200);
    expect(await store.approvalRequests.get('AR1')).toMatchObject({ status: 'Approved' });
    expect(await store.assignmentMonths.get(MONTH_ID)).toMatchObject({ status: 'Allocated', approvalId: 'AR1' });
  });
});
