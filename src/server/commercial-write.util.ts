import type { BillingPlanItem, Milestone, Order, OrderLine, Project } from '../app/services/api.service';
import { customerFacingBillingAmount } from '../app/services/billing-validation.util';
import type { Repository } from '../db/repository';

/** A domain error whose status can be mapped directly by the HTTP handlers. */
export class CommercialWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CommercialWriteError';
  }
}

/**
 * Statuses that mean "an invoice exists" and are therefore owned by a server
 * operation that also writes the linked customer order — never by a plain PUT.
 */
const SERVER_OWNED_BILLING_STATUSES: readonly BillingPlanItem['status'][] = ['Invoiced', 'Paid'];

/**
 * Guard for `PUT /billing-plan-items/:id`. Returns an error message when the
 * client is trying to *reach* Invoiced or Paid through a plain field update.
 *
 * Without it, a client can set `status:'Paid'` on a 'Planned' item with no
 * `orderId` and no invoice: `BILLED_STATUSES` (finance.util.ts) then counts that
 * row as billed, so the Paid and Unbilled KPIs move on a payment that never
 * happened. Both transitions have an endpoint that writes both records —
 * `POST :id/generate-invoice` and `POST :id/mark-paid`.
 *
 * Re-sending the status the item ALREADY has is allowed: full-object updates of
 * an Invoiced/Paid row (the edit form re-PUTs every field) must keep working, and
 * a no-op transition changes nothing.
 */
export function billingPlanStatusTransitionError(
  currentStatus: BillingPlanItem['status'],
  requestedStatus: BillingPlanItem['status'] | undefined,
): string | null {
  if (requestedStatus === undefined) return null;
  if (requestedStatus === currentStatus) return null;
  if (!SERVER_OWNED_BILLING_STATUSES.includes(requestedStatus)) return null;
  const endpoint = requestedStatus === 'Paid' ? 'mark-paid' : 'generate-invoice';
  return `status '${requestedStatus}' is set by POST /billing-plan-items/:id/${endpoint}, which also updates the linked customer order; it cannot be set directly`;
}

export interface BillingInvoiceResult {
  billingItem: BillingPlanItem;
  order: Order;
  line: OrderLine;
  /** True when this request returned the already-committed result. */
  replayed: boolean;
}

export interface BillingInvoiceWriteDependencies {
  billingPlanItems: Pick<Repository<BillingPlanItem>, 'get' | 'update'>;
  orders: Pick<Repository<Order>, 'get' | 'remove'>;
  orderLines: Pick<Repository<OrderLine>, 'get' | 'list' | 'create' | 'remove'>;
  projects: Pick<Repository<Project>, 'get' | 'list'>;
  /** Milestone lookup lets a milestone condition resolve a missing projectId. */
  milestones?: Pick<Repository<Milestone>, 'get'>;
  /** Creates the order and applies any server-owned invoice numbering. */
  createInvoicedOrder(order: Order): Promise<Order>;
}

/**
 * The billing-item id is the natural idempotency key for invoice generation.
 * encodeURIComponent is reversible, so unlike lossy punctuation stripping it
 * cannot map two distinct billing ids to the same order id.
 */
export function billingInvoiceOrderId(billingItemId: string): string {
  return `BILLING-INVOICE:${encodeURIComponent(billingItemId)}`;
}

/** Stable companion id: one generated project-imputation line per billing item. */
export function billingInvoiceLineId(billingItemId: string): string {
  return `BILLING-INVOICE-LINE:${encodeURIComponent(billingItemId)}`;
}

/** Calendar-date arithmetic in UTC, independent from server locale and DST. */
export function billingInvoiceDueDate(issuedDate: string, paymentTermsDays = 0): string {
  const calendarDate = /^\d{4}-\d{2}-\d{2}/.exec(issuedDate)?.[0];
  if (!calendarDate || !Number.isInteger(paymentTermsDays) || paymentTermsDays < 0) {
    throw new CommercialWriteError('issuedDate and paymentTermsDays cannot produce a due date', 400);
  }
  const date = new Date(`${calendarDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new CommercialWriteError('issuedDate cannot produce a due date', 400);
  }
  date.setUTCDate(date.getUTCDate() + paymentTermsDays);
  return date.toISOString().slice(0, 10);
}

function invoiceOrderFor(item: BillingPlanItem, orderId: string, issuedDate: string): Order {
  return {
    id: orderId,
    contractId: item.contractId,
    type: 'Customer',
    amount: customerFacingBillingAmount(item),
    currency: item.currency,
    status: 'Invoiced',
    orderDate: issuedDate,
  };
}

function invoiceLineFor(item: BillingPlanItem, orderId: string, projectId: string): OrderLine {
  return {
    id: billingInvoiceLineId(item.id),
    orderId,
    projectId,
    description: item.label.trim(),
    amount: customerFacingBillingAmount(item),
  };
}

function sameGeneratedInvoice(actual: Order, expected: Order): boolean {
  return actual.id === expected.id
    && actual.contractId === expected.contractId
    && actual.type === 'Customer'
    && actual.amount === expected.amount
    && actual.currency === expected.currency
    && (actual.status === 'Invoiced' || actual.status === 'Paid');
}

function sameGeneratedInvoiceLine(actual: OrderLine, expected: OrderLine): boolean {
  return actual.id === expected.id
    && actual.orderId === expected.orderId
    && actual.projectId === expected.projectId
    && actual.description === expected.description
    && actual.amount === expected.amount;
}

async function resolveBillingProject(
  dependencies: BillingInvoiceWriteDependencies,
  item: BillingPlanItem,
): Promise<Project> {
  let projectId = item.projectId;
  if (!projectId && item.milestoneId && dependencies.milestones) {
    projectId = (await dependencies.milestones.get(item.milestoneId))?.projectId;
  }
  if (!projectId) {
    const candidates = (await dependencies.projects.list())
      .filter(project => project.contractId === item.contractId);
    if (candidates.length !== 1) {
      throw new CommercialWriteError(
        'projectId is required when the billing condition cannot be attributed to exactly one contract project',
        409,
      );
    }
    projectId = candidates[0].id;
  }

  const project = await dependencies.projects.get(projectId);
  if (!project) throw new CommercialWriteError('projectId must reference an existing project', 409);
  if (project.contractId !== item.contractId) {
    throw new CommercialWriteError(
      'Billing project and generated order must belong to the same contract',
      409,
    );
  }
  return project;
}

async function assertGeneratedLineTotal(
  dependencies: BillingInvoiceWriteDependencies,
  order: Order,
): Promise<void> {
  const lines = (await dependencies.orderLines.list()).filter(line => line.orderId === order.id);
  const total = lines.reduce((sum, line) => sum + line.amount, 0);
  if (lines.length !== 1 || Math.abs(total - order.amount) > 0.000_001) {
    throw new CommercialWriteError('Generated invoice lines must sum to the order amount', 409);
  }
}

/**
 * Commit invoice generation as one recoverable operation.
 *
 * The handler serializes calls per billing item. This function additionally:
 *  - uses a deterministic order id, so a retry can find/heal a prior partial;
 *  - returns an already-linked invoice without duplicating its order/line;
 *  - compensates newly-created line then order if any later write fails. If
 *    compensation is interrupted, deterministic ids let a retry heal the same
 *    artifacts rather than create duplicates.
 */
export async function generateBillingInvoice(
  dependencies: BillingInvoiceWriteDependencies,
  billingItemId: string,
  issuedDate: string,
): Promise<BillingInvoiceResult> {
  const item = await dependencies.billingPlanItems.get(billingItemId);
  if (!item) throw new CommercialWriteError('Billing plan item not found', 404);

  const project = await resolveBillingProject(dependencies, item);
  const orderId = item.orderId ?? billingInvoiceOrderId(item.id);
  const candidate = invoiceOrderFor(item, orderId, issuedDate);
  const lineCandidate = invoiceLineFor(item, orderId, project.id);
  let order = await dependencies.orders.get(orderId);
  let line = await dependencies.orderLines.get(lineCandidate.id);

  if (item.orderId && (item.status === 'Invoiced' || item.status === 'Paid')) {
    if (!order) {
      throw new CommercialWriteError('Billing plan item references a missing order', 409);
    }
    if (!sameGeneratedInvoice(order, candidate)) {
      throw new CommercialWriteError('Linked order does not match the generated invoice', 409);
    }
    if (line && !sameGeneratedInvoiceLine(line, lineCandidate)) {
      throw new CommercialWriteError('Generated invoice line conflicts with its billing condition', 409);
    }
    if (!line) line = await dependencies.orderLines.create(lineCandidate);
    await assertGeneratedLineTotal(dependencies, order);

    const lifecyclePatch: Partial<BillingPlanItem> = {};
    if (!item.projectId) lifecyclePatch.projectId = project.id;
    if (!item.dueDate) {
      lifecyclePatch.dueDate = billingInvoiceDueDate(
        item.issuedDate ?? order.orderDate,
        item.paymentTermsDays ?? 0,
      );
    }
    const billingItem = Object.keys(lifecyclePatch).length
      ? await dependencies.billingPlanItems.update(item.id, lifecyclePatch) ?? item
      : item;
    return { billingItem, order, line, replayed: true };
  }

  if (item.status !== 'Ready') {
    throw new CommercialWriteError(`Billing plan item must be Ready (current status: ${item.status})`, 409);
  }

  let createdHere = false;
  let createdLineHere = false;

  if (order && !sameGeneratedInvoice(order, candidate)) {
    throw new CommercialWriteError('Idempotency order id is already used by a different order', 409);
  }
  if (line && !sameGeneratedInvoiceLine(line, lineCandidate)) {
    throw new CommercialWriteError('Idempotency line id is already used by a different order line', 409);
  }

  try {
    if (!order) {
      order = await dependencies.createInvoicedOrder(candidate);
      createdHere = true;
    }
    if (!line) {
      line = await dependencies.orderLines.create(lineCandidate);
      createdLineHere = true;
    }
    await assertGeneratedLineTotal(dependencies, order);
    const updated = await dependencies.billingPlanItems.update(item.id, {
      status: 'Invoiced',
      orderId: order.id,
      issuedDate,
      dueDate: item.dueDate ?? billingInvoiceDueDate(issuedDate, item.paymentTermsDays ?? 0),
      projectId: project.id,
    });
    if (!updated) throw new CommercialWriteError('Billing plan item disappeared during invoice generation', 404);
    return { billingItem: updated, order, line, replayed: false };
  } catch (error) {
    if (createdLineHere && line) {
      try { await dependencies.orderLines.remove(line.id); } catch { /* preserve the original failure */ }
    }
    if (createdHere && order) {
      try { await dependencies.orders.remove(order.id); } catch { /* preserve the original failure */ }
    }
    throw error;
  }
}

export interface BillingPaymentResult {
  billingItem: BillingPlanItem;
  order: Order;
  /** True when both linked records were already paid. */
  replayed: boolean;
}

export interface BillingPaymentWriteDependencies {
  billingPlanItems: Pick<Repository<BillingPlanItem>, 'get' | 'update'>;
  orders: Pick<Repository<Order>, 'get' | 'update'>;
}

/** Command seam for the atomic billing-item + linked-order Paid transition. */
export async function markBillingInvoicePaid(
  dependencies: BillingPaymentWriteDependencies,
  billingItemId: string,
  paidDate: string,
): Promise<BillingPaymentResult> {
  const item = await dependencies.billingPlanItems.get(billingItemId);
  if (!item) throw new CommercialWriteError('Billing plan item not found', 404);
  if (item.status !== 'Invoiced' && item.status !== 'Paid') {
    throw new CommercialWriteError(`Billing plan item must be Invoiced before payment (current status: ${item.status})`, 409);
  }
  if (!item.orderId) throw new CommercialWriteError('Billing plan item has no linked order', 409);

  const order = await dependencies.orders.get(item.orderId);
  if (!order) throw new CommercialWriteError('Billing plan item references a missing order', 409);
  if (order.contractId !== item.contractId) {
    throw new CommercialWriteError('Billing item and linked order must belong to the same contract', 409);
  }
  if (order.type !== 'Customer' || (order.status !== 'Invoiced' && order.status !== 'Paid')) {
    throw new CommercialWriteError(`Linked order must be an Invoiced customer order (current status: ${order.status})`, 409);
  }

  const alreadyPaid = item.status === 'Paid' && order.status === 'Paid' && Boolean(item.paidDate);
  if (alreadyPaid) return { billingItem: item, order, replayed: true };

  let updatedOrder = order;
  let changedOrder = false;
  if (order.status !== 'Paid') {
    const changed = await dependencies.orders.update(order.id, { status: 'Paid' });
    if (!changed) throw new CommercialWriteError('Linked order disappeared while marking payment', 404);
    updatedOrder = changed;
    changedOrder = true;
  }

  try {
    let updatedItem = item;
    if (item.status !== 'Paid' || !item.paidDate) {
      const changed = await dependencies.billingPlanItems.update(item.id, {
        status: 'Paid',
        paidDate: item.paidDate ?? paidDate,
      });
      if (!changed) throw new CommercialWriteError('Billing plan item disappeared while marking payment', 404);
      updatedItem = changed;
    }
    return { billingItem: updatedItem, order: updatedOrder, replayed: false };
  } catch (error) {
    if (changedOrder) {
      try { await dependencies.orders.update(order.id, { status: order.status }); } catch { /* preserve original failure */ }
    }
    throw error;
  }
}

export type NewOrder = Omit<Order, 'id' | 'invoiceNumber' | 'invoiceDate'>;
export type NewOrderLine = Omit<OrderLine, 'id' | 'orderId'>;

export interface OrderWithLineRequest {
  idempotencyKey: string;
  order: NewOrder;
  line: NewOrderLine;
}

export interface OrderWithLineResult {
  order: Order;
  line: OrderLine;
  replayed: boolean;
}

export interface OrderWithLineWriteDependencies {
  orders: Pick<Repository<Order>, 'get' | 'remove'>;
  orderLines: Pick<Repository<OrderLine>, 'get' | 'create'>;
  projects: Pick<Repository<Project>, 'get'>;
  /** Creates the order and applies server-owned fields when applicable. */
  createOrder(order: Order): Promise<Order>;
}

/** Referential invariant shared by compound and standalone OrderLine routes. */
export async function projectContractAttributionError(
  projects: Pick<Repository<Project>, 'get'>,
  projectId: string,
  contractId: string,
): Promise<string | null> {
  const project = await projects.get(projectId);
  if (!project) return 'projectId must reference an existing project';
  return project.contractId === contractId
    ? null
    : 'Order line project and order must belong to the same contract';
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function isValidCommercialIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

function orderIdsForRequest(idempotencyKey: string): { orderId: string; lineId: string } {
  return {
    orderId: `ORDER-REQUEST:${idempotencyKey}`,
    lineId: `ORDER-LINE-REQUEST:${idempotencyKey}`,
  };
}

function sameOrder(actual: Order, expected: Order): boolean {
  return actual.id === expected.id
    && actual.contractId === expected.contractId
    && actual.type === expected.type
    && (actual.partnerId ?? '') === (expected.partnerId ?? '')
    && actual.amount === expected.amount
    && actual.currency === expected.currency
    && actual.status === expected.status
    && actual.orderDate === expected.orderDate;
}

function sameOrderLine(actual: OrderLine, expected: OrderLine): boolean {
  return actual.id === expected.id
    && actual.orderId === expected.orderId
    && actual.projectId === expected.projectId
    && actual.description === expected.description
    && actual.amount === expected.amount;
}

/** Create an order and its project-imputation line as one retry-safe operation. */
export async function createOrderWithLine(
  dependencies: OrderWithLineWriteDependencies,
  request: OrderWithLineRequest,
): Promise<OrderWithLineResult> {
  if (!isValidCommercialIdempotencyKey(request.idempotencyKey)) {
    throw new CommercialWriteError('idempotencyKey must be 8-128 safe ASCII characters', 400);
  }
  const attributionError = await projectContractAttributionError(
    dependencies.projects,
    request.line.projectId,
    request.order.contractId,
  );
  if (attributionError) throw new CommercialWriteError(attributionError, 409);
  if (request.line.amount !== request.order.amount) {
    throw new CommercialWriteError('The compound order line must equal the order amount', 409);
  }

  const { orderId, lineId } = orderIdsForRequest(request.idempotencyKey);
  const orderCandidate: Order = { id: orderId, ...request.order };
  const lineCandidate: OrderLine = { id: lineId, orderId, ...request.line };
  let order = await dependencies.orders.get(orderId);
  const existingLine = await dependencies.orderLines.get(lineId);

  if (order && !sameOrder(order, orderCandidate)) {
    throw new CommercialWriteError('idempotencyKey is already used by a different order', 409);
  }
  if (existingLine && !sameOrderLine(existingLine, lineCandidate)) {
    throw new CommercialWriteError('idempotencyKey is already used by a different order line', 409);
  }
  if (order && existingLine) return { order, line: existingLine, replayed: true };

  let createdOrderHere = false;
  if (!order) {
    order = await dependencies.createOrder(orderCandidate);
    createdOrderHere = true;
  }

  if (existingLine) {
    return { order, line: existingLine, replayed: true };
  }

  try {
    const line = await dependencies.orderLines.create(lineCandidate);
    return { order, line, replayed: false };
  } catch (error) {
    if (createdOrderHere) {
      // Same compensation/recovery guarantee as billing generation: if removal
      // fails, the deterministic ids let the retry finish the existing pair.
      try { await dependencies.orders.remove(order.id); } catch { /* preserve original failure */ }
    }
    throw error;
  }
}
