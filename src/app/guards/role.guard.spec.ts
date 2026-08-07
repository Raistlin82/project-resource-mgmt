import { Injector, PLATFORM_ID, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree, CanMatchFn, GuardResult } from '@angular/router';
import { isObservable, firstValueFrom, Observable } from 'rxjs';
import {
  roleGuard,
  capacityGuard,
  CAPACITY_ROLES,
  allocationApprovalsGuard,
  ALLOCATION_APPROVAL_ROLES,
  absenceRegisterGuard,
  ABSENCE_REASON_READ_ROLES,
  ABSENCE_WRITE_ROLES,
  projectClassificationGuard,
  PROJECT_CLASSIFICATION_ROLES,
} from './role.guard';
import { AuthService } from '../services/auth.service';
import { UserRole } from '../services/api.service';
import { hasAnyAllowedRole } from '../../server/authz-policy.util';
import {
  ABSENCE_MUTATION_RULES,
  ABSENCE_READ_RULES,
  ABSENCE_REASON_READ_ROLES as SERVER_ABSENCE_REASON_READ_ROLES,
  ABSENCE_WRITE_ROLES as SERVER_ABSENCE_WRITE_ROLES,
  PROJECT_CLASSIFICATION_ROLES as SERVER_PROJECT_CLASSIFICATION_ROLES,
  PROJECT_MUTATION_RULES,
} from '../../server/absence-policy.util';

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

// ---------------------------------------------------------------------------
// Block H — the two write screens (T8).
//
// A route guard in this app is UX, never security: the server JWKS-verifies and
// re-authorizes every /api call regardless of which route rendered. What a guard
// CAN get wrong is agreement with the server, and it can get it wrong in two
// directions that look nothing alike on screen:
//   - too STRICT -> a permitted role is bounced home from a page it may use;
//   - too LOOSE  -> a nav link leads somewhere that answers 403 on first read,
//                   which is the "reachable route, empty page" defect.
// Both directions are asserted per role, AND the verdict is compared against the
// server's OWN rule tables rather than against a second hand-typed list.
// `role.guard.ts` re-declares these sets instead of importing them (the server
// module would drag its write-path validators into the browser bundle); the
// tests below are what make that re-declaration safe.
// ---------------------------------------------------------------------------

const ALL_ROLES: UserRole[] = ['employee', 'pm', 'resource-manager', 'delivery-executive', 'finance', 'sales', 'admin'];

/**
 * roleGate's own resolution, replayed over the SAME exported arrays the server
 * spreads into READ_RULES / the mutation table: FIRST match wins, then
 * `hasAnyAllowedRole` over the role set. Identical to the helper in
 * `src/server/absence-policy.util.spec.ts`, deliberately — comparing against a
 * re-implementation of the rule would compare two guesses.
 */
function serverAdmits(
  rules: readonly { test: (p: string) => boolean; roles: readonly UserRole[] }[],
  path: string,
  role: UserRole,
): boolean {
  const rule = rules.find(candidate => candidate.test(path));
  return rule === undefined || hasAnyAllowedRole([role], rule.roles);
}

/**
 * Evaluate a concrete CanMatchFn in the browser for one role, post-authReady.
 *
 * Resets the TestBed first: the per-role parity tests below sweep all seven
 * roles inside ONE `it`, and a second `configureTestingModule` on an already
 * instantiated module throws. Resetting here rather than in each caller keeps
 * the sweep — which is what makes the comparison against the server table a
 * single, readable object — possible at all.
 */
async function decideWith(guard: CanMatchFn, role: UserRole): Promise<GuardResult> {
  TestBed.resetTestingModule();
  const auth = new RoleAuth(role);
  const injector = configure('browser', auth as unknown as FakeAuth);
  const result = runInInjectionContext(injector, () => guard({} as never, []));
  auth._ready.set(true);
  return firstValueFrom(result as Observable<GuardResult>);
}

describe('absenceRegisterGuard role parity', () => {
  // `employee` is ALLOWED on purpose: a READ_RULE is per-path, so the server
  // admits the role and narrows an employee to their OWN rows in the handler.
  // Excluding them from the route would make that narrowing unreachable UI.
  const ALLOWED: UserRole[] = ['resource-manager', 'delivery-executive', 'admin', 'employee'];
  const DENIED: UserRole[] = ['pm', 'finance', 'sales'];

  it('ABSENCE_REASON_READ_ROLES is exactly the reason audience (shared by the guard AND the /absences nav gate)', () => {
    expect([...ABSENCE_REASON_READ_ROLES].sort()).toStrictEqual([...ALLOWED].sort());
  });

  for (const role of ALLOWED) {
    it(`allows ${role}`, async () => {
      expect(await decideWith(absenceRegisterGuard, role)).toBe(true);
    });
  }

  for (const role of DENIED) {
    it(`denies ${role} (redirects home)`, async () => {
      expect(await decideWith(absenceRegisterGuard, role)).toBeInstanceOf(UrlTree);
    });
  }
});

describe('projectClassificationGuard role parity', () => {
  // `pm` is DENIED although it may mutate /projects: whoever is measured on an
  // engagement's margin must not be able to declare that it has no margin. That
  // exclusion is the whole reason this guard is not the coarse project one.
  const ALLOWED: UserRole[] = ['delivery-executive', 'finance', 'admin'];
  const DENIED: UserRole[] = ['employee', 'pm', 'resource-manager', 'sales'];

  it('PROJECT_CLASSIFICATION_ROLES is exactly the finance-grade set (shared by the guard AND the nav gate)', () => {
    expect([...PROJECT_CLASSIFICATION_ROLES].sort()).toStrictEqual([...ALLOWED].sort());
  });

  for (const role of ALLOWED) {
    it(`allows ${role}`, async () => {
      expect(await decideWith(projectClassificationGuard, role)).toBe(true);
    });
  }

  for (const role of DENIED) {
    it(`denies ${role} (redirects home)`, async () => {
      expect(await decideWith(projectClassificationGuard, role)).toBeInstanceOf(UrlTree);
    });
  }
});

describe('block H guards agree with the SERVER, role by role', () => {
  it('the three client role sets are element-for-element the server constants', () => {
    // Sorted copies, because the ORDER of a role list carries no meaning
    // (hasAnyAllowedRole is a membership test) while the MEMBERSHIP is the
    // contract. toStrictEqual, so an extra undefined or a sparse hole fails.
    expect([...ABSENCE_REASON_READ_ROLES].sort())
      .toStrictEqual([...SERVER_ABSENCE_REASON_READ_ROLES].sort());
    expect([...ABSENCE_WRITE_ROLES].sort())
      .toStrictEqual([...SERVER_ABSENCE_WRITE_ROLES].sort());
    expect([...PROJECT_CLASSIFICATION_ROLES].sort())
      .toStrictEqual([...SERVER_PROJECT_CLASSIFICATION_ROLES].sort());
  });

  it('absenceRegisterGuard matches GET /absences for every one of the seven roles', async () => {
    // Through the server's REAL rule table, at the REAL path, resolved the way
    // roleGate resolves it — not against the constant the guard was copied from.
    // A comparison against the copy would agree with itself.
    const verdicts: Record<string, { guard: boolean; server: boolean }> = {};
    for (const role of ALL_ROLES) {
      verdicts[role] = {
        guard: (await decideWith(absenceRegisterGuard, role)) === true,
        server: serverAdmits(ABSENCE_READ_RULES, '/absences', role),
      };
    }
    expect(verdicts).toStrictEqual({
      employee: { guard: true, server: true },
      pm: { guard: false, server: false },
      'resource-manager': { guard: true, server: true },
      'delivery-executive': { guard: true, server: true },
      finance: { guard: false, server: false },
      sales: { guard: false, server: false },
      admin: { guard: true, server: true },
    });
  });

  it('projectClassificationGuard matches PUT /projects/:id/classification for every one of the seven roles', async () => {
    const verdicts: Record<string, { guard: boolean; server: boolean }> = {};
    for (const role of ALL_ROLES) {
      verdicts[role] = {
        guard: (await decideWith(projectClassificationGuard, role)) === true,
        server: serverAdmits(PROJECT_MUTATION_RULES, '/projects/3/classification', role),
      };
    }
    expect(verdicts).toStrictEqual({
      employee: { guard: false, server: false },
      pm: { guard: false, server: false },
      'resource-manager': { guard: false, server: false },
      'delivery-executive': { guard: true, server: true },
      finance: { guard: true, server: true },
      sales: { guard: false, server: false },
      admin: { guard: true, server: true },
    });
  });

  it('the register admits READERS the server refuses as WRITERS — which is why the write controls are gated separately', () => {
    // NON-VACUOUSNESS for the two-gate design. If read and write happened to
    // coincide, the in-screen P2-18 role hint would be unreachable and every
    // assertion about it vacuous. They do not coincide, and here is the pair
    // that proves it: delivery-executive and employee read and cannot write.
    const readsButCannotWrite = ALL_ROLES.filter(role =>
      serverAdmits(ABSENCE_READ_RULES, '/absences', role)
      && !serverAdmits(ABSENCE_MUTATION_RULES, '/absences', role));
    expect(readsButCannotWrite.sort()).toStrictEqual(['delivery-executive', 'employee']);
  });
});
