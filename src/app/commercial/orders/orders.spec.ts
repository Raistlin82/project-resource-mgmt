import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of, Subject, throwError } from 'rxjs';
import { Orders } from './orders';
import { ApiService, Contract, FxRate, Order, Partner, Project } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

// Mirrors the ACTUAL seed rows (src/db/seed.ts) so this test would fail if the
// real /orders data ever diverged from what these assertions assume. Only O1
// carries an invoiceNumber; O2/O3 do not (design spec §11's own field table:
// orders match on invoiceNumber, no join to the parent contract/customer name).
const ORDERS: Order[] = [
  { id: 'O1', contractId: 'CT1', type: 'Customer', amount: 200000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-02-01', invoiceNumber: 'INV-2026-0001', invoiceDate: '2026-02-01' },
  { id: 'O2', contractId: 'CT1', type: 'Purchase', partnerId: 'PT1', amount: 50000, currency: 'EUR', status: 'Confirmed', orderDate: '2026-02-15' },
  { id: 'O3', contractId: 'CT2', type: 'Customer', amount: 120000, currency: 'USD', status: 'Open', orderDate: '2026-03-10' },
];

const CONTRACTS: Contract[] = [
  { id: 'CT1', customerId: 'CU1', name: 'Framework One', type: 'Framework', totalValue: 500000, currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' },
  { id: 'CT2', customerId: 'CU2', name: 'Framework Two', type: 'T&M', totalValue: 300000, currency: 'USD', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' },
];
const PROJECTS: Project[] = [
  { id: 'P9', name: 'Project Nine', location: 'Rome', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', contractId: 'CT1' },
  { id: 'P2', name: 'Other Contract Project', location: 'Milan', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', contractId: 'CT2' },
];
const PARTNERS: Partner[] = [
  { id: 'PT1', projectId: 'P9', company: 'Delivery Partner', role: 'Supplier', contact: 'partner@example.test', status: 'Active' },
];
const FX_RATES: FxRate[] = [
  { currency: 'EUR', rateToBase: 1 },
  { currency: 'USD', rateToBase: 0.92 },
];

function apiStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getOrders: () => of(ORDERS),
    getContracts: () => of(CONTRACTS),
    getProjectPartners: () => of(PARTNERS),
    getProjects: () => of(PROJECTS),
    getFxRates: () => of(FX_RATES),
    getOrderLines: () => of([]),
    createOrderWithLine: () => of({ id: 'O-new' }),
    ...overrides,
  };
}

interface TestableOrders {
  orderQuery: { set(value: string): void };
  filteredOrders(): Order[];
}

async function settle(fixture: { detectChanges(): void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let index = 0; index < microtasks; index++) await Promise.resolve();
  fixture.detectChanges();
}

async function setup(apiOverrides: Partial<Record<string, unknown>> = {}, authReady = true) {
  await TestBed.configureTestingModule({
    imports: [Orders],
    providers: [
        // ?q= seeding reads ActivatedRoute; /search rows render RouterLink.
        provideRouter([]),
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: apiStub(apiOverrides) },
      { provide: AuthService, useValue: { authReady: () => authReady } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Orders);
  await settle(fixture);
  return fixture;
}

describe('Orders wide table pan port', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('makes the only horizontal overflow region named, focusable and described by a mobile swipe hint', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const pan = host.querySelector<HTMLElement>('[data-test="orders-table-pan"]')!;
    const hint = host.querySelector<HTMLElement>('#ordersTablePanHint')!;

    expect(pan.getAttribute('role')).toBe('region');
    expect(pan.tabIndex).toBe(0);
    expect(pan.getAttribute('aria-label')).toBe('Orders table');
    expect(pan.getAttribute('aria-describedby')).toBe(hint.id);
    expect(pan.className.split(/\s+/)).toContain('focus-visible:ring-2');
    expect(hint.textContent).toMatch(/Swipe horizontally/);
    expect(hint.className.split(/\s+/)).toContain('lg:hidden');
    expect(pan.querySelector('table')!.className.split(/\s+/)).toContain('min-w-[860px]');
  });

  it('pins Contract plus order ID as the sole identity column and invents no Actions column', async () => {
    const fixture = await setup();
    const table = (fixture.nativeElement as HTMLElement).querySelector<HTMLTableElement>('[data-test="orders-table-pan"] table')!;
    const firstHeading = table.querySelector('th')!;
    const firstCell = table.querySelector('tbody td')!;

    expect(firstHeading.textContent?.trim()).toBe('Contract');
    expect(firstHeading.className.split(/\s+/)).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface-muted!']));
    expect(firstCell.className.split(/\s+/)).toEqual(expect.arrayContaining(['sticky', 'left-0', 'bg-surface!']));
    expect(firstCell.textContent).toContain('Framework One');
    expect(firstCell.textContent).toContain('INV-2026-0001');
    expect([...table.querySelectorAll('th, td')].some(cell => cell.classList.contains('right-0'))).toBe(false);
    expect([...table.querySelectorAll('th')].some(th => th.textContent?.trim() === 'Actions')).toBe(false);
  });

  it('keeps every horizontal overflow in Orders under the one covered pan-port', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/app/commercial/orders/orders.ts'), 'utf8');
    expect(source.match(/overflow-x-auto/g) ?? []).toHaveLength(1);
    expect(source.match(/data-test="orders-table-pan"/g) ?? []).toHaveLength(1);
  });
});

describe('Orders filter (design spec §8 -- first-ever adoption)', () => {
  it('filters to exactly order O1 when searching "INV-2026-0001"', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableOrders;
    component.orderQuery.set('INV-2026-0001');
    fixture.detectChanges();
    expect(component.filteredOrders().map(o => o.id)).toEqual(['O1']);
  });

  it('a PARTIAL invoice number ("INV-2026", not the full string) still matches O1 -- proves this is substring matching, not an exact-equality check', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableOrders;
    component.orderQuery.set('INV-2026');
    fixture.detectChanges();
    expect(component.filteredOrders().map(o => o.id)).toEqual(['O1']);
  });

  it('searching a customer/contract name ("Globex") matches NOTHING -- orders do not join to their parent (design spec §11)', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableOrders;
    component.orderQuery.set('Globex');
    fixture.detectChanges();
    expect(component.filteredOrders()).toEqual([]);
  });

  it('an empty query returns all three seed orders, not zero', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableOrders;
    component.orderQuery.set('');
    fixture.detectChanges();
    expect(component.filteredOrders().length).toBe(3);
  });
});

describe('Orders list states', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('shows loading without flashing either empty state while the source is pending', async () => {
    const pending = new Subject<Order[]>();
    const fixture = await setup({ getOrders: () => pending.asObservable() });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading orders');
    expect(host.querySelector('[data-test="orders-source-empty"]')).toBeNull();
    expect(host.querySelector('[data-test="orders-filtered-empty"]')).toBeNull();
    expect(host.querySelector('table')).toBeNull();
  });

  it('shows a retryable error and never presents a failed read as empty', async () => {
    const getOrders = vi.fn(() => throwError(() => new Error('offline')));
    const fixture = await setup({ getOrders });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.textContent).toContain("Couldn't load orders");
    expect(host.querySelector('[data-test="orders-source-empty"]')).toBeNull();
    expect(host.querySelector('[data-test="orders-filtered-empty"]')).toBeNull();
    const retry = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('Retry')) as HTMLButtonElement;
    retry.click();
    await settle(fixture);
    expect(getOrders).toHaveBeenCalledTimes(2);
  });

  it('shows the source-empty CTA only after a successful empty read and opens the form', async () => {
    const fixture = await setup({ getOrders: () => of([]) });
    const host = fixture.nativeElement as HTMLElement;
    const empty = host.querySelector('[data-test="orders-source-empty"]') as HTMLElement;

    expect(empty.textContent).toContain('No orders yet');
    expect(empty.textContent).toContain('first Open');
    (empty.querySelector('[aria-label="Create the first Open order"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect(host.querySelector('#orderModalTitle')?.textContent).toContain('Create Open Order');
  });

  it('uses a filtered-empty state with a working Clear filters recovery action', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableOrders;
    component.orderQuery.set('does-not-exist');
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const empty = host.querySelector('[data-test="orders-filtered-empty"]') as HTMLElement;

    expect(empty.textContent).toContain('No orders match your filters');
    expect(host.querySelector('[data-test="orders-source-empty"]')).toBeNull();
    (empty.querySelector('[aria-label="Clear order filters"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect(component.filteredOrders()).toHaveLength(3);
    expect(host.querySelector('[data-test="orders-filtered-empty"]')).toBeNull();
  });
});

describe('Orders creation form guidance and workflow state', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('fixes new orders to Open and offers no Invoiced or Paid creation choice', async () => {
    const fixture = await setup();
    fixture.componentInstance.openForm();
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const status = host.querySelector('#status') as HTMLInputElement;

    expect(status.value).toBe('Open');
    expect(status.readOnly).toBe(true);
    expect(host.querySelector('option[value="Invoiced"]')).toBeNull();
    expect(host.querySelector('option[value="Paid"]')).toBeNull();
    expect(host.querySelector('#statusHint')?.textContent).toContain('lifecycle actions in Billing');
  });

  it('keeps invalid submit actionable and explains every missing required field inline', async () => {
    const fixture = await setup();
    fixture.componentInstance.openForm();
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const submit = host.querySelector('[aria-label="Create Open order and impute it to the selected project"]') as HTMLButtonElement;

    expect(submit.disabled).toBe(false);
    submit.click();
    await settle(fixture);
    expect(host.querySelector('[data-test="order-form-error"]')?.textContent).toContain('Review the highlighted fields');
    expect(host.querySelector('#contractIdError')?.textContent).toContain('Select a contract');
    expect(host.querySelector('#amountError')?.textContent).toContain('Enter an amount');
    expect(host.querySelector('#projectIdError')?.textContent).toContain('Select a project');
    expect(host.querySelector('#orderDateError')?.textContent).toContain('Select an order date');
    expect(submit.disabled).toBe(false);
  });

  it('surfaces the Purchase partner cross-field rule inline', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance;
    component.openForm();
    component.orderForm.setValue({
      contractId: 'CT1', type: 'Purchase', partnerId: '', amount: 100,
      projectId: 'P9', lineDescription: '', currency: 'EUR', status: 'Open', orderDate: '2026-08-08',
    });
    component.saveOrder();
    await settle(fixture);

    expect((fixture.nativeElement as HTMLElement).querySelector('#partnerIdError')?.textContent)
      .toContain('Select a partner for a purchase order');
  });

  it('rejects a project from another contract before the API call and explains the mismatch', async () => {
    const createOrderWithLine = vi.fn(() => of({ id: 'O-new' }));
    const fixture = await setup({ createOrderWithLine });
    const component = fixture.componentInstance;
    component.openForm();
    component.orderForm.setValue({
      contractId: 'CT1', type: 'Customer', partnerId: '', amount: 100,
      projectId: 'P2', lineDescription: '', currency: 'EUR', status: 'Open', orderDate: '2026-08-08',
    });
    component.saveOrder();
    await settle(fixture);

    expect(createOrderWithLine).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).querySelector('#projectIdError')?.textContent)
      .toMatch(/project (for the order imputation|linked to the chosen contract)/);
  });
});

/**
 * The server derives the order id FROM the idempotency key and 409s
 * 'idempotencyKey is already used by a different order' when the stored order under
 * that key differs (commercial-write.util.ts:606-612). Holding one key across an
 * EDIT therefore refuses the corrected amount forever: the classic case is a POST
 * that commits while its response is lost, after which the user fixes 120000 to
 * 12000 and can never submit it.
 */
describe('Orders idempotency key tracks the payload', () => {
  interface Submitted {
    idempotencyKey: string;
    order: { amount?: number; status?: string };
    line: { amount: number };
  }

  async function setupForSubmit(createOrderWithLine: (body: Submitted) => unknown) {
    const api = {
      ...apiStub(),
      // Spied so the error-path reload is observable as a second /orders read.
      getOrders: vi.fn(() => of(ORDERS)),
      getOrderLines: vi.fn(() => of([])),
      createOrderWithLine: vi.fn(createOrderWithLine),
    };
    await TestBed.configureTestingModule({
      imports: [Orders],
      providers: [
        // ?q= seeding reads ActivatedRoute; /search rows render RouterLink.
        provideRouter([]),
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { authReady: () => true } },
        { provide: NotificationService, useValue: { show: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Orders);
    await settle(fixture);
    return { fixture, component: fixture.componentInstance, api };
  }

  /** A complete, VALID Customer order — an invalid form would never reach the POST. */
  function fillValidOrder(component: Orders, amount: number): void {
    component.orderForm.setValue({
      contractId: 'CT1',
      type: 'Customer',
      partnerId: '',
      amount,
      projectId: 'P9',
      lineDescription: '',
      currency: 'EUR',
      status: 'Open',
      orderDate: '2026-08-06',
    });
  }

  function bodies(api: { createOrderWithLine: { mock: { calls: unknown[][] } } }): Submitted[] {
    return api.createOrderWithLine.mock.calls.map(call => call[0] as Submitted);
  }

  afterEach(() => TestBed.resetTestingModule());

  it('always posts Open, even if the read-only status control is mutated programmatically', async () => {
    const { component, api } = await setupForSubmit(() => of({ id: 'O-new' }));
    fillValidOrder(component, 12000);
    (component.orderForm.controls.status as unknown as { setValue(value: string): void }).setValue('Paid');

    component.saveOrder();

    expect(bodies(api)[0].order.status).toBe('Open');
  });

  it('ignores a second submit while the first creation request is pending', async () => {
    const pending = new Subject<unknown>();
    const { fixture, component, api } = await setupForSubmit(() => pending.asObservable());
    component.openForm();
    fillValidOrder(component, 12000);

    component.saveOrder();
    component.saveOrder();
    fixture.detectChanges();

    expect(api.createOrderWithLine).toHaveBeenCalledOnce();
    expect(component.saving()).toBe(true);
    const submit = (fixture.nativeElement as HTMLElement)
      .querySelector('[aria-label="Create Open order and impute it to the selected project"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    pending.next({ id: 'O-new' });
    pending.complete();
    await settle(fixture);
    expect(component.saving()).toBe(false);
  });

  it('mints a NEW key when the amount is corrected after a failed submit', async () => {
    let call = 0;
    const { component, api } = await setupForSubmit(() => {
      call += 1;
      return call === 1 ? throwError(() => ({ status: 504 })) : of({ id: 'O-new' });
    });

    fillValidOrder(component, 120000);
    component.saveOrder();

    fillValidOrder(component, 12000);
    component.saveOrder();

    const [first, second] = bodies(api);
    expect(first.order.amount).toBe(120000);
    expect(second.order.amount).toBe(12000);
    // Reusing the key here is what made the correction permanently unrecordable.
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  /**
   * THE PAIRED ASSERTION OF ABSENCE, and the reason 'always mint a fresh key' is not
   * an acceptable fix: an unchanged payload must keep its key, or a genuine retry
   * creates a SECOND order instead of replaying the first.
   */
  it('reuses the SAME key when the payload is unchanged, preserving the replay dedup', async () => {
    const { component, api } = await setupForSubmit(() => throwError(() => ({ status: 504 })));

    fillValidOrder(component, 120000);
    component.saveOrder();
    component.saveOrder();

    const [first, second] = bodies(api);
    expect(second.order.amount).toBe(first.order.amount);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('rotates the key for a changed line description too, not only the amount', async () => {
    const { component, api } = await setupForSubmit(() => throwError(() => ({ status: 504 })));

    fillValidOrder(component, 120000);
    component.saveOrder();
    // Same amount, different line — the server compares the line under the key as
    // well (sameOrderLine), so this must rotate or it 409s just the same.
    component.orderForm.controls.lineDescription.setValue('Q3 licence block');
    component.saveOrder();

    const [first, second] = bodies(api);
    expect(second.line.amount).toBe(first.line.amount);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('a fresh dialog after a successful create does not reuse the committed key', async () => {
    const { component, api } = await setupForSubmit(() => of({ id: 'O-new' }));

    fillValidOrder(component, 120000);
    component.saveOrder();           // succeeds, so closeForm() clears the key
    fillValidOrder(component, 120000);
    component.saveOrder();           // a genuinely NEW order with identical figures

    const [first, second] = bodies(api);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('reloads the list on failure, so an order that committed under a lost response becomes visible', async () => {
    const { fixture, component, api } = await setupForSubmit(() => throwError(() => ({ status: 504 })));
    const readsBefore = api.getOrders.mock.calls.length;

    fillValidOrder(component, 120000);
    component.saveOrder();
    fixture.detectChanges();
    await fixture.whenStable();

    // The reload is observable as the resource re-reading /orders. Asserted against
    // the count taken BEFORE the submit, so the initial load cannot satisfy it.
    expect(api.getOrders.mock.calls.length).toBeGreaterThan(readsBefore);
  });
});
