import { Injector, PLATFORM_ID, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, GuardResult } from '@angular/router';
import { isObservable, firstValueFrom, Observable } from 'rxjs';
import { roleGuard, capacityGuard, CAPACITY_ROLES, allocationApprovalsGuard, ALLOCATION_APPROVAL_ROLES } from './role.guard';
import { AuthService } from '../services/auth.service';
import { UserRole } from '../services/api.service';

/**
 * Minimal AuthService stand-in: a settable `authReady` signal plus a settable
 * capability flag. This lets us reproduce the hydration race — the guard must
 * NOT decide while `authReady` is false, and must evaluate the predicate only
 * once it flips true (which is when real OIDC claims are present).
 */
class FakeAuth {
  readonly _ready = signal(false);
  readonly authReady = this._ready.asReadonly();
  allowed = false;
  capability(): boolean {
    return this.allowed;
  }
}

/**
 * AuthService stand-in with a real {@link hasAnyRole} over a fixed role, so a
 * concrete guard (e.g. {@link capacityGuard}) can be evaluated per-role exactly
 * as it would against the live service.
 */
class RoleAuth {
  readonly _ready = signal(false);
  readonly authReady = this._ready.asReadonly();
  constructor(private readonly role: UserRole) {}
  hasAnyRole(roles: UserRole[]): boolean {
    return roles.includes(this.role);
  }
}

function configure(platform: 'browser' | 'server', auth: FakeAuth): Injector {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: PLATFORM_ID, useValue: platform },
      { provide: AuthService, useValue: auth },
    ],
  });
  return TestBed.inject(Injector);
}

describe('roleGuard', () => {
  it('allows the match synchronously on the server (lets the page render for SSR)', () => {
    const auth = new FakeAuth();
    const injector = configure('server', auth);
    const guard = roleGuard(a => (a as unknown as FakeAuth).capability());

    const result = runInInjectionContext(injector, () => guard({} as never, []));
    // Server short-circuits to a plain boolean `true` — no async, no redirect.
    expect(result).toBe(true);
  });

  it('in the browser, WAITS for authReady before allowing an authorized user (no premature redirect)', async () => {
    const auth = new FakeAuth();
    auth.allowed = true; // authorized once claims hydrate
    const injector = configure('browser', auth);
    const guard = roleGuard(a => (a as unknown as FakeAuth).capability());

    const result = runInInjectionContext(injector, () => guard({} as never, []));
    // Must be async: a sync decision here would run against the anonymous
    // default role and wrongly redirect on hard-refresh / deep-link.
    expect(isObservable(result)).toBe(true);

    // Simulate the OAuth bootstrap settling with the user authorized.
    auth._ready.set(true);
    const value = await firstValueFrom(result as Observable<GuardResult>);
    expect(value).toBe(true);
  });

  it('in the browser, redirects an UNauthorized user once authReady settles', async () => {
    const auth = new FakeAuth();
    auth.allowed = false; // not authorized even after claims load
    const injector = configure('browser', auth);
    const router = TestBed.inject(Router);
    const guard = roleGuard(a => (a as unknown as FakeAuth).capability(), '/');

    const result = runInInjectionContext(injector, () => guard({} as never, []));
    expect(isObservable(result)).toBe(true);

    auth._ready.set(true);
    const value = await firstValueFrom(result as Observable<GuardResult>);
    expect(value).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(value as UrlTree)).toBe(router.serializeUrl(router.parseUrl('/')));
  });

  it('evaluates the predicate AFTER authReady (sees the resolved role, not the anonymous default)', async () => {
    const auth = new FakeAuth();
    auth.allowed = false; // anonymous default: predicate would currently be false
    const injector = configure('browser', auth);
    const guard = roleGuard(a => (a as unknown as FakeAuth).capability());

    const result = runInInjectionContext(injector, () => guard({} as never, []));

    // Claims hydrate and grant the capability right as bootstrap settles.
    auth.allowed = true;
    auth._ready.set(true);

    const value = await firstValueFrom(result as Observable<GuardResult>);
    // Proves the check ran against the post-hydration state, not the initial one.
    expect(value).toBe(true);
  });
});

describe('capacityGuard role parity', () => {
  // The staffing-grade roles the /capacity dashboard is restricted to. The nav
  // entry in app.ts gates on this SAME exported CAPACITY_ROLES const, so pinning
  // it here catches a drift on EITHER side (guard or nav).
  const ALLOWED: UserRole[] = ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'];
  const DENIED: UserRole[] = ['employee', 'sales'];

  it('CAPACITY_ROLES is exactly the staffing-grade set (shared by capacityGuard AND the /capacity nav gate)', () => {
    expect([...CAPACITY_ROLES].sort()).toEqual([...ALLOWED].sort());
  });

  /** Evaluate capacityGuard in the browser for a single role, after authReady settles. */
  async function decide(role: UserRole): Promise<GuardResult> {
    const auth = new RoleAuth(role);
    const injector = configure('browser', auth as unknown as FakeAuth);
    const result = runInInjectionContext(injector, () => capacityGuard({} as never, []));
    auth._ready.set(true);
    return firstValueFrom(result as Observable<GuardResult>);
  }

  for (const role of ALLOWED) {
    it(`allows ${role}`, async () => {
      expect(await decide(role)).toBe(true);
    });
  }

  for (const role of DENIED) {
    it(`denies ${role} (redirects home)`, async () => {
      expect(await decide(role)).toBeInstanceOf(UrlTree);
    });
  }
});

describe('allocationApprovalsGuard role parity', () => {
  // The approver-grade roles the /allocation-approvals page is restricted to
  // (B3). The nav entry in app.ts gates on this SAME exported
  // ALLOCATION_APPROVAL_ROLES const, so pinning it here catches a drift on
  // EITHER side (guard or nav) — in particular, that 'pm' (a staffing role
  // allowed into /capacity) is correctly EXCLUDED here.
  const ALLOWED: UserRole[] = ['resource-manager', 'delivery-executive', 'admin'];
  const DENIED: UserRole[] = ['employee', 'pm', 'finance', 'sales'];

  it('ALLOCATION_APPROVAL_ROLES is exactly the approver-grade set (shared by allocationApprovalsGuard AND the nav gate)', () => {
    expect([...ALLOCATION_APPROVAL_ROLES].sort()).toEqual([...ALLOWED].sort());
  });

  /** Evaluate allocationApprovalsGuard in the browser for a single role, after authReady settles. */
  async function decideAllocationApprovals(role: UserRole): Promise<GuardResult> {
    const auth = new RoleAuth(role);
    const injector = configure('browser', auth as unknown as FakeAuth);
    const result = runInInjectionContext(injector, () => allocationApprovalsGuard({} as never, []));
    auth._ready.set(true);
    return firstValueFrom(result as Observable<GuardResult>);
  }

  for (const role of ALLOWED) {
    it(`allows ${role}`, async () => {
      expect(await decideAllocationApprovals(role)).toBe(true);
    });
  }

  for (const role of DENIED) {
    it(`denies ${role} (redirects home)`, async () => {
      expect(await decideAllocationApprovals(role)).toBeInstanceOf(UrlTree);
    });
  }
});
