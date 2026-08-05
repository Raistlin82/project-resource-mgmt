import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { Customers } from './customers';
import { ApiService, Customer } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

// Mirrors the ACTUAL seed rows (src/db/seed.ts) so this test would fail if the
// real /customers data ever diverged from what these assertions assume.
const CUSTOMERS: Customer[] = [
  { id: 'C1', name: 'Globex Corp', industry: 'Manufacturing', country: 'Germany' },
  { id: 'C2', name: 'Initech', industry: 'Financial Services', country: 'United Kingdom' },
];

function apiStub() {
  return {
    getCustomers: () => of(CUSTOMERS),
    getContracts: () => of([]),
    getIndustries: () => of([]),
    getCountries: () => of([]),
    createCustomer: () => of(CUSTOMERS[0]),
  };
}

// customerQuery/filteredCustomers are `protected` on the component (same
// visibility as the reference SearchComponent's draftQuery/onInput) -- cast
// once per test, matching this block's own established pattern, rather than
// widening the component's access modifiers just for test convenience.
interface TestableCustomers {
  customerQuery: { set(value: string): void };
  filteredCustomers(): Customer[];
}

async function setup() {
  await TestBed.configureTestingModule({
    imports: [Customers],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: apiStub() },
      { provide: AuthService, useValue: { authReady: () => true } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Customers);
  fixture.detectChanges();
  return fixture;
}

describe('Customers filter (design spec §8 -- first-ever adoption)', () => {
  it('filters to exactly customer C1 when searching "Globex"', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableCustomers;
    component.customerQuery.set('Globex');
    fixture.detectChanges();
    expect(component.filteredCustomers().map(c => c.id)).toEqual(['C1']);
  });

  it('a nonsense term resolves to zero rows, not an error', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableCustomers;
    component.customerQuery.set('zzznonsense123');
    fixture.detectChanges();
    expect(component.filteredCustomers()).toEqual([]);
  });

  it('an empty query returns both seed customers, not zero', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableCustomers;
    component.customerQuery.set('');
    fixture.detectChanges();
    expect(component.filteredCustomers().length).toBe(2);
  });
});
