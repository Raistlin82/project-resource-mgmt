import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideZonelessChangeDetection } from '@angular/core';
import { NEVER, of } from 'rxjs';
import { Customers } from './customers';
import { ApiService, Customer } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

// Mirrors the ACTUAL seed rows (src/db/seed.ts) so this test would fail if the
// real /customers data ever diverged from what these assertions assume.
const CUSTOMERS: Customer[] = [
  { id: 'C1', name: 'Globex Corp', industry: 'Manufacturing', country: 'Germany' },
  { id: 'C2', name: 'Initech', industry: 'Financial Services', country: 'United Kingdom' },
];

function apiStub(customers: Customer[] = CUSTOMERS, pending = false) {
  return {
    // NEVER keeps the resource in flight, which is the state under test.
    getCustomers: () => (pending ? NEVER : of(customers)),
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

async function setup(opts: { authReady?: boolean; customers?: Customer[]; pending?: boolean } = {}) {
  await TestBed.configureTestingModule({
    imports: [Customers],
    providers: [
        // ?q= seeding reads ActivatedRoute; /search rows render RouterLink.
        provideRouter([]),
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: apiStub(opts.customers, opts.pending) },
      { provide: AuthService, useValue: { authReady: () => opts.authReady ?? true } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(Customers);
  fixture.detectChanges();
  return fixture;
}

/** The list-state's loading region. Scoped to the wrapper's own contract
 *  (role=status + aria-busy) rather than to a shimmer class, so it cannot be
 *  satisfied by any other decorative element on the page. */
function skeleton(host: HTMLElement): Element | null {
  return host.querySelector('[role="status"][aria-busy="true"]');
}

/**
 * Settle a RESOLVED read into the DOM.
 *
 * The pre-authReady case MUST be flushed too, and that is the whole subtlety of
 * this detector: `params()` false makes the stream `of([])`, which RESOLVES.
 * Without the flush the resource is still in its initial pending state, so the
 * skeleton is on screen for a reason that has nothing to do with the gate under
 * test — and the spec passes with the gate removed. (Observed: it did. Only the
 * NEVER case below may skip this, because whenStable() never settles while a
 * resource is genuinely in flight.)
 */
async function flush(fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
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

/**
 * The pre-authReady window. `customersRes` resolves its pre-auth default (`[]`)
 * SYNCHRONOUSLY while authReady() is false, so `isLoading()` is false for the
 * whole OIDC bootstrap — and for the SSR document. Bound bare, the wrapper
 * rendered "No customers yet" as a statement of fact about a read not yet made.
 *
 * Both directions are asserted, and the pairing is what makes this non-vacuous:
 * a fix that pins the skeleton on forever passes the first case and fails the
 * mirror, and a fix that deletes the empty state fails the mirror too.
 */
describe('Customers read-state gate', () => {
  it('does not claim "No customers yet" before authReady, even though the API has rows', async () => {
    const fixture = await setup({ authReady: false });
    // Flushed on purpose — see flush(). The pre-auth stream RESOLVES, and it is
    // that resolved-empty state, not a pending one, that this asserts about.
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;
    const component = fixture.componentInstance as unknown as {
      customers(): Customer[];
      customersRes: { isLoading(): boolean };
    };

    // POSITIVE CONTROLS. Together they pin the exact state under test: the read
    // resolved to the pre-auth default AND the resource no longer reports
    // loading. Without the second one the skeleton could be on screen simply
    // because nothing had flushed yet — which is how this spec first went blind.
    expect(component.customers()).toEqual([]);
    expect(component.customersRes.isLoading()).toBe(false);

    expect(host.textContent).not.toContain('No customers yet');
    expect(host.textContent).not.toContain('Get started by adding your first customer.');
    expect(skeleton(host)).not.toBeNull();
  });

  it('does not claim it while the read is genuinely in flight either', async () => {
    const fixture = await setup({ authReady: true, pending: true });
    // NOT flush(): whenStable() never settles while a resource is in flight —
    // that pending state is exactly this case.
    fixture.detectChanges();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    expect(
      (fixture.componentInstance as unknown as { customersRes: { isLoading(): boolean } }).customersRes.isLoading(),
    ).toBe(true);
    expect(host.textContent).not.toContain('No customers yet');
    expect(skeleton(host)).not.toBeNull();
  });

  // THE MIRROR. A resolved read that really is empty MUST say so, with no
  // skeleton left behind — this is the half a permanent skeleton fails.
  it('does say "No customers yet" once a resolved read is empty, and drops the skeleton', async () => {
    const fixture = await setup({ authReady: true, customers: [] });
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(skeleton(host)).toBeNull();
    expect(host.textContent).toContain('No customers yet');
    expect(host.textContent).toContain('Get started by adding your first customer.');
  });

  // And a resolved NON-empty read shows rows and neither of the other two states.
  it('shows the rows when the read resolves with data', async () => {
    const fixture = await setup({ authReady: true });
    await flush(fixture);
    const host = fixture.nativeElement as HTMLElement;

    expect(skeleton(host)).toBeNull();
    expect(host.textContent).not.toContain('No customers yet');
    expect(host.textContent).toContain('Globex Corp');
  });
});
