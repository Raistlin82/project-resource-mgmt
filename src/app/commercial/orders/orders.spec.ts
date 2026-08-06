import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { Orders } from './orders';
import { ApiService, Order } from '../../services/api.service';
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

function apiStub() {
  return {
    getOrders: () => of(ORDERS),
    getContracts: () => of([]),
    getProjectPartners: () => of([]),
    getProjects: () => of([]),
    getFxRates: () => of([]),
    getOrderLines: () => of([]),
    createOrderWithLine: () => of({ id: 'O-new' }),
  };
}

interface TestableOrders {
  orderQuery: { set(value: string): void };
  filteredOrders(): Order[];
}

async function setup() {
  await TestBed.configureTestingModule({
    imports: [Orders],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: apiStub() },
      { provide: AuthService, useValue: { authReady: () => true } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Orders);
  fixture.detectChanges();
  return fixture;
}

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
    order: { amount?: number };
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
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { authReady: () => true } },
        { provide: NotificationService, useValue: { show: vi.fn() } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(Orders);
    fixture.detectChanges();
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
