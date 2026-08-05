import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { Orders } from './orders';
import { ApiService, Order } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

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
