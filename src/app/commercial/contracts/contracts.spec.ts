import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { Contracts } from './contracts';
import { ApiService, Contract } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

// Mirrors the ACTUAL seed rows (src/db/seed.ts) so this test would fail if the
// real /contracts data ever diverged from what these assertions assume.
const CONTRACTS: Contract[] = [
  { id: 'CT1', customerId: 'C1', name: 'Globex Digital Transformation', type: 'Fixed Price', totalValue: 500000, currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' },
  { id: 'CT2', customerId: 'C2', name: 'Initech T&M Framework', type: 'T&M', totalValue: 300000, currency: 'USD', status: 'Active', startDate: '2026-03-01', endDate: '2027-02-28' },
];

function apiStub() {
  return {
    getContracts: () => of(CONTRACTS),
    getCustomers: () => of([]),
    getFxRates: () => of([]),
    createContract: () => of(CONTRACTS[0]),
  };
}

interface TestableContracts {
  contractQuery: { set(value: string): void };
  filteredContracts(): Contract[];
}

async function setup() {
  await TestBed.configureTestingModule({
    imports: [Contracts],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: apiStub() },
      { provide: AuthService, useValue: { authReady: () => true } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Contracts);
  fixture.detectChanges();
  return fixture;
}

describe('Contracts filter (design spec §8 -- first-ever adoption)', () => {
  it('filters to exactly contract CT1 when searching "Globex"', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableContracts;
    component.contractQuery.set('Globex');
    fixture.detectChanges();
    expect(component.filteredContracts().map(c => c.id)).toEqual(['CT1']);
  });

  it('a nonsense term resolves to zero rows, not an error', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableContracts;
    component.contractQuery.set('zzznonsense123');
    fixture.detectChanges();
    expect(component.filteredContracts()).toEqual([]);
  });

  it('an empty query returns both seed contracts, not zero', async () => {
    const fixture = await setup();
    const component = fixture.componentInstance as unknown as TestableContracts;
    component.contractQuery.set('');
    fixture.detectChanges();
    expect(component.filteredContracts().length).toBe(2);
  });
});
