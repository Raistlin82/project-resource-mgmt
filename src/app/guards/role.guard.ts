import { inject, PLATFORM_ID } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { isPlatformBrowser } from '@angular/common';
import { CanMatchFn, GuardResult, Router } from '@angular/router';
import { Observable } from 'rxjs';
import { filter, map, take } from 'rxjs/operators';
import { AuthService } from '../services/auth.service';
import { UserRole } from '../services/api.service';

/**
 * Functional `CanMatchFn` factory that gates a route on a role/capability check.
 *
 * The `check` predicate receives {@link AuthService} and decides whether the
 * route may match. On failure the user is redirected to `redirect` (a `UrlTree`,
 * which `CanMatch` accepts as a valid {@link GuardResult}). Using `CanMatch`
 * (instead of `CanActivate`) keeps the lazy chunk from even loading when the
 * route is not authorized.
 *
 * SSR-aware: identity is unknowable on the server ({@link AuthService} only
 * populates claims client-side via `afterNextRender`), so a capability check
 * there would always fail and the returned `UrlTree` would surface as an HTTP
 * 302 — breaking refresh/deep-link/bookmark of guarded routes for everyone.
 * We therefore allow the match on the server (letting the page render) and let
 * this same guard re-run authoritatively in the browser after hydration. Data
 * stays protected because the server JWKS-verifies the Bearer on every `/api`
 * call regardless of which route rendered.
 *
 * Browser hydration timing: the OAuth bootstrap is async — claims are only
 * populated after `loadDiscoveryDocumentAndTryLogin()` resolves (see
 * {@link AuthService.authReady}). A synchronous check at hydration would run
 * against the anonymous default role and wrongly redirect an authorized user
 * who hard-refreshed / deep-linked / bookmarked a guarded route. We therefore
 * return an Observable that WAITS for `authReady` before evaluating `check`,
 * so the predicate sees the real (post-login) role. `CanMatchFn` natively
 * accepts an `Observable<GuardResult>`.
 */
export function roleGuard(check: (auth: AuthService) => boolean, redirect = '/'): CanMatchFn {
  return (): GuardResult | Observable<GuardResult> => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;
    const auth = inject(AuthService);
    const router = inject(Router);
    // Defer the decision until the OAuth bootstrap has settled, then evaluate
    // the predicate against the resolved identity. authReady is monotonic
    // (false -> true, once), so this emits exactly one GuardResult and completes.
    return toObservable(auth.authReady).pipe(
      filter(ready => ready),
      take(1),
      map(() => (check(auth) ? true : router.parseUrl(redirect))),
    );
  };
}

/** Allows matching only for identities that can manage commercial entities. */
export const commercialGuard: CanMatchFn = roleGuard(auth => auth.canManageCommercial());

/** Allows matching only for identities that can approve financials. */
export const financeGuard: CanMatchFn = roleGuard(auth => auth.canApproveFinancials());

/**
 * Staffing-grade roles allowed to read the monthly FTE capacity dashboard (B2),
 * mirroring the server's `/capacity/monthly` RBAC. Exported as the SINGLE source
 * of truth so both {@link capacityGuard} (route gate) and the `/capacity` nav
 * entry's visibility (in `app.ts`) reference the same set and can never drift.
 */
export const CAPACITY_ROLES: readonly UserRole[] = ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'];

/**
 * Allows matching only for the {@link CAPACITY_ROLES} staffing-grade roles that
 * may read the monthly FTE capacity dashboard (B2).
 */
export const capacityGuard: CanMatchFn = roleGuard(auth => auth.hasAnyRole([...CAPACITY_ROLES]));
