import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { NEVER, of, Subject, throwError } from 'rxjs';
import { Contracts } from './contracts';
import { ApiService, Contract, Customer, FxRate } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

// Mirrors the ACTUAL seed rows (src/db/seed.ts) so this test would fail if the
// real /contracts data ever diverged from what these assertions assume.
const CONTRACTS: Contract[] = [
  { id: 'CT1', customerId: 'C1', name: 'Globex Digital Transformation', type: 'Fixed Price', totalValue: 500000, currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' },
  { id: 'CT2', customerId: 'C2', name: 'Initech T&M Framework', type: 'T&M', totalValue: 300000, currency: 'USD', status: 'Active', startDate: '2026-03-01', endDate: '2027-02-28' },
];

const CUSTOMERS: Customer[] = [
  { id: 'C1', name: 'Globex Corp', industry: 'Manufacturing', country: 'Germany' },
];

const FX_RATES: FxRate[] = [{ currency: 'EUR', rateToBase: 1 }];

function apiStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getContracts: vi.fn(() => of(CONTRACTS)),
    getCustomers: vi.fn(() => of(CUSTOMERS)),
    getFxRates: vi.fn(() => of(FX_RATES)),
    createContract: vi.fn(() => of(CONTRACTS[0])),
    ...overrides,
  };
}

interface TestableContracts {
  contractQuery: { set(value: string): void };
  filteredContracts(): Contract[];
}

async function settle(fixture: { detectChanges(): void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let index = 0; index < microtasks; index++) await Promise.resolve();
  fixture.detectChanges();
}

async function setup(apiOverrides: Partial<Record<string, unknown>> = {}, authReady = true) {
  const api = apiStub(apiOverrides);
  const notifications = { show: vi.fn() };
  await TestBed.configureTestingModule({
    imports: [Contracts],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { authReady: () => authReady } },
      { provide: NotificationService, useValue: notifications },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Contracts);
  await settle(fixture);
  return { fixture, api, notifications };
}

describe('Contracts filter (design spec §8 -- first-ever adoption)', () => {
  it('filters to exactly contract CT1 when searching "Globex"', async () => {
    const { fixture } = await setup();
    const component = fixture.componentInstance as unknown as TestableContracts;
    component.contractQuery.set('Globex');
    fixture.detectChanges();
    expect(component.filteredContracts().map(c => c.id)).toEqual(['CT1']);
  });

  it('a nonsense term resolves to zero rows, not an error', async () => {
    const { fixture } = await setup();
    const component = fixture.componentInstance as unknown as TestableContracts;
    component.contractQuery.set('zzznonsense123');
    fixture.detectChanges();
    expect(component.filteredContracts()).toEqual([]);
  });

  it('an empty query returns both seed contracts, not zero', async () => {
    const { fixture } = await setup();
    const component = fixture.componentInstance as unknown as TestableContracts;
    component.contractQuery.set('');
    fixture.detectChanges();
    expect(component.filteredContracts().length).toBe(2);
  });
});

function fillValidContract(component: Contracts): void {
  component.contractForm.setValue({
    customerId: 'C1',
    name: 'New delivery agreement',
    type: 'T&M',
    totalValue: 120000,
    currency: 'EUR',
    status: 'Draft',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
  });
}

describe('Contracts list states', () => {
  it('shows loading without flashing source-empty or filtered-empty content', async () => {
    const { fixture } = await setup({ getContracts: vi.fn(() => NEVER) });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[role="status"]')?.textContent).toContain('Loading contracts');
    expect(host.querySelector('[data-test="contracts-source-empty"]')).toBeNull();
    expect(host.querySelector('[data-test="contracts-filtered-empty"]')).toBeNull();
    expect(host.querySelector('table')).toBeNull();
  });

  it('shows a retryable read error instead of an empty list', async () => {
    const getContracts = vi.fn(() => throwError(() => new Error('offline')));
    const { fixture } = await setup({ getContracts });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.textContent).toContain("Couldn't load contracts");
    expect(host.querySelector('[data-test="contracts-source-empty"]')).toBeNull();
    const retry = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Retry'));
    expect(retry).toBeTruthy();
    retry!.click();
    await settle(fixture);
    expect(getContracts).toHaveBeenCalledTimes(2);
  });

  it('shows a creation CTA only after a successful source-empty read', async () => {
    const { fixture } = await setup({ getContracts: vi.fn(() => of([])) });
    const host = fixture.nativeElement as HTMLElement;
    const empty = host.querySelector<HTMLElement>('[data-test="contracts-source-empty"]');

    expect(empty?.textContent).toContain('No contracts yet');
    expect(host.querySelector('[data-test="contracts-filtered-empty"]')).toBeNull();
    (empty?.querySelector('button') as HTMLButtonElement).click();
    await settle(fixture);
    expect(host.querySelector('#contractModalTitle')?.textContent).toContain('New Contract');
  });

  it('uses a filtered-empty state with a working Clear filters recovery action', async () => {
    const { fixture } = await setup();
    const component = fixture.componentInstance as unknown as TestableContracts;
    component.contractQuery.set('does-not-exist');
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const empty = host.querySelector<HTMLElement>('[data-test="contracts-filtered-empty"]');

    expect(empty?.textContent).toContain('No contracts match your search');
    expect(host.querySelector('[data-test="contracts-source-empty"]')).toBeNull();
    (empty?.querySelector('button') as HTMLButtonElement).click();
    await settle(fixture);
    expect(component.filteredContracts()).toHaveLength(2);
    expect(host.querySelector('[data-test="contracts-filtered-empty"]')).toBeNull();
  });
});

describe('Contracts creation lifecycle', () => {
  it('keeps invalid submit actionable, links inline errors and focuses the first invalid field', async () => {
    const createContract = vi.fn(() => of(CONTRACTS[0]));
    const { fixture } = await setup({ createContract });
    fixture.componentInstance.openForm();
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const submit = host.querySelector<HTMLButtonElement>('button[form="contractCreateForm"]')!;

    expect(submit.disabled).toBe(false);
    expect(host.querySelectorAll('[required][aria-required="true"]')).toHaveLength(8);
    submit.click();
    await settle(fixture);

    expect(createContract).not.toHaveBeenCalled();
    expect(host.querySelector('[data-test="contract-form-error"]')?.textContent).toContain('Review the highlighted fields');
    expect(host.querySelector('#contractCustomerError')?.textContent).toContain('Select a customer');
    expect(host.querySelector('#contractNameError')?.textContent).toContain('Enter a contract name');
    expect(host.querySelector('#contractTotalValueError')?.textContent).toContain('Enter a total value');
    expect(host.querySelector('#contractStartDateError')?.textContent).toContain('Select a start date');
    expect(host.querySelector('#contractEndDateError')?.textContent).toContain('Select an end date');
    expect(host.querySelector('#contractCustomer')?.getAttribute('aria-describedby')).toBe('contractCustomerError');
    expect(document.activeElement?.id).toBe('contractCustomer');
  });

  it('explains and focuses an end date that precedes the start date', async () => {
    const createContract = vi.fn(() => of(CONTRACTS[0]));
    const { fixture } = await setup({ createContract });
    const component = fixture.componentInstance;
    component.openForm();
    await settle(fixture);
    fillValidContract(component);
    component.contractForm.controls.endDate.setValue('2026-07-31');
    component.save();
    await settle(fixture);

    const host = fixture.nativeElement as HTMLElement;
    expect(createContract).not.toHaveBeenCalled();
    expect(host.querySelector('#contractEndDateError')?.textContent).toContain('on or after the start date');
    expect(document.activeElement?.id).toBe('contractEndDate');
  });

  it('asks before discarding a dirty form via Cancel, Escape or backdrop', async () => {
    const { fixture } = await setup();
    const component = fixture.componentInstance;
    component.openForm();
    component.contractForm.controls.name.setValue('Unsaved agreement');
    component.contractForm.markAsDirty();
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;

    const cancel = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.trim() === 'Cancel')!;
    cancel.click();
    await settle(fixture);
    expect(component.showForm()).toBe(true);
    expect(host.textContent).toContain('Discard unsaved contract?');

    Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Continue editing'))!.click();
    await settle(fixture);
    host.querySelector<HTMLElement>('[data-test="contract-form-overlay"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(fixture);
    expect(host.textContent).toContain('Discard unsaved contract?');

    Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Continue editing'))!.click();
    await settle(fixture);
    host.querySelector<HTMLElement>('[data-test="contract-form-overlay"]')!.click();
    await settle(fixture);
    expect(host.textContent).toContain('Discard unsaved contract?');

    Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Discard changes'))!.click();
    await settle(fixture);
    expect(component.showForm()).toBe(false);
  });

  it('blocks duplicate submit and every dismiss path while creation is pending', async () => {
    const pending = new Subject<Contract>();
    const createContract = vi.fn(() => pending.asObservable());
    const { fixture } = await setup({ createContract });
    const component = fixture.componentInstance;
    component.openForm();
    fillValidContract(component);
    component.contractForm.markAsDirty();

    component.save();
    component.save();
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(createContract).toHaveBeenCalledOnce();
    expect(component.saving()).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('button[form="contractCreateForm"]')?.disabled).toBe(true);

    component.closeForm();
    host.querySelector<HTMLElement>('[data-test="contract-form-overlay"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    host.querySelector<HTMLElement>('[data-test="contract-form-overlay"]')!.click();
    await settle(fixture);
    expect(component.showForm()).toBe(true);
    expect(component.confirmingDiscard()).toBe(false);

    pending.next(CONTRACTS[0]);
    pending.complete();
    await settle(fixture);
    expect(component.showForm()).toBe(false);
    expect(component.saving()).toBe(false);
  });

  it('keeps the draft and useful API error inline, reloads, then allows retry', async () => {
    let attempt = 0;
    const createContract = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? throwError(() => ({ error: { error: 'Customer is inactive.' } }))
        : of(CONTRACTS[0]);
    });
    const getContracts = vi.fn(() => of(CONTRACTS));
    const { fixture } = await setup({ createContract, getContracts });
    const component = fixture.componentInstance;
    component.openForm();
    fillValidContract(component);
    component.contractForm.markAsDirty();
    const readsBefore = getContracts.mock.calls.length;

    component.save();
    await settle(fixture);
    const host = fixture.nativeElement as HTMLElement;
    expect(component.showForm()).toBe(true);
    expect(component.contractForm.controls.name.value).toBe('New delivery agreement');
    expect(host.querySelector('[data-test="contract-form-error"]')?.textContent).toContain('Customer is inactive.');
    expect(host.querySelector('[data-test="contract-form-error"]')?.textContent).toContain('entries are still here');
    expect(getContracts.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(host.querySelector<HTMLButtonElement>('button[form="contractCreateForm"]')?.disabled).toBe(false);

    component.save();
    await settle(fixture);
    expect(createContract).toHaveBeenCalledTimes(2);
    expect(component.showForm()).toBe(false);
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
    const { fixture } = await setup();
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
