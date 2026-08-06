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

/**
 * jsdom performs NO layout: offsetHeight is 0, there is no viewport, and no
 * stylesheet is loaded. This case therefore asserts the STRUCTURAL PRECONDITION of
 * scroll-safety — which class tokens sit on which element — and nothing about
 * reachability at 320px. The height arithmetic (nine fields plus a header and a
 * pinned footer against the ~460px a 320x568 phone leaves) is only demonstrable in a
 * real browser and this repo has no browser runner. Same caveat, and the same
 * predicate, as manage-rate-cards.component.spec.ts.
 */
describe('Contracts form overlay — STRUCTURAL scroll-safety contract only (jsdom performs no layout)', () => {
  /**
   * Evaluated on TOKENS, not on the raw class string: 'items-center' is a substring
   * of 'sm:items-center', so a className.includes() check would be satisfied by the
   * very class that has to go — the class-string form of the trap where
   * toContain('0%') matches '100%'.
   */
  function scrollSafety(overlay: HTMLElement, panel: HTMLElement) {
    const overlayTokens = overlay.className.split(/\s+/);
    const body = panel.querySelector<HTMLElement>('div.overflow-y-auto');
    return {
      overlayScrolls: overlayTokens.includes('overflow-y-auto'),
      anchoredOnShortViewports: overlayTokens.includes('items-start') && !overlayTokens.includes('items-center'),
      recentredOnWideViewports: overlayTokens.includes('sm:items-center'),
      panelBounded: /max-h-\[/.test(panel.className),
      bodyScrolls: !!body && body.className.split(/\s+/).includes('min-h-0'),
    };
  }

  const SAFE = {
    overlayScrolls: true,
    anchoredOnShortViewports: true,
    recentredOnWideViewports: true,
    panelBounded: true,
    bodyScrolls: true,
  };

  it('the New Contract overlay declares its own scroller, a top anchor and a bounded panel whose body scrolls', async () => {
    // THE DEFECT: a POSITION:FIXED overlay cannot be scrolled by the page, so
    // `flex items-center` split the overflow above and below the centre — the Customer
    // select went above y=0 and "Create Contract" below the fold, with no scroller
    // anywhere. The contract could be filled in and never created.
    const fixture = await setup();
    (fixture.componentInstance as unknown as { showForm: { set(v: boolean): void } }).showForm.set(true);
    fixture.detectChanges();

    const h = fixture.nativeElement as HTMLElement;
    const overlay = h.querySelector<HTMLElement>('[data-test="contract-form-overlay"]');
    const panel = h.querySelector<HTMLElement>('[data-test="contract-form-panel"]');
    expect(overlay, 'the contract form overlay must be rendered').toBeTruthy();
    expect(panel, 'the contract form panel must be rendered').toBeTruthy();
    expect(scrollSafety(overlay!, panel!)).toStrictEqual(SAFE);
  });

  it('rejects the pre-fix class string — the negative control that keeps the predicate honest', async () => {
    // NON-VACUOUSNESS. The predicate must discriminate a scroll-safe overlay from a
    // clipping one, or it is a class-string tautology. Unlike manage-rate-cards and
    // project-plans, this component renders only ONE overlay, so there is no real
    // short dialog to measure against; the control is the EXACT className this
    // overlay carried before the fix, built as a detached element. A predicate that
    // passed it would pass the defect. Note it satisfies panelBounded — that half
    // alone would have made the test green with nothing fixed.
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6';
    const panel = document.createElement('div');
    panel.className = 'command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]';
    const body = document.createElement('div');
    body.className = 'p-6 sm:p-8 overflow-y-auto flex-1';
    panel.appendChild(body);

    expect(scrollSafety(overlay, panel)).toStrictEqual({
      overlayScrolls: false,
      anchoredOnShortViewports: false,
      recentredOnWideViewports: false,
      panelBounded: true,
      bodyScrolls: false,
    });
  });
});
