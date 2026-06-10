import { inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CanMatchFn, Router, UrlTree } from '@angular/router';
import { AuthService } from '../services/auth.service';

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
 */
export function roleGuard(check: (auth: AuthService) => boolean, redirect = '/'): CanMatchFn {
  return (): boolean | UrlTree => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;
    const auth = inject(AuthService);
    const router = inject(Router);
    return check(auth) ? true : router.parseUrl(redirect);
  };
}

/** Allows matching only for identities that can manage commercial entities. */
export const commercialGuard: CanMatchFn = roleGuard(auth => auth.canManageCommercial());

/** Allows matching only for identities that can approve financials. */
export const financeGuard: CanMatchFn = roleGuard(auth => auth.canApproveFinancials());
