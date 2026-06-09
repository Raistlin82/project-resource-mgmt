import { inject } from '@angular/core';
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
 * SSR-safe: it only touches injected services (no `window`/DOM), and
 * {@link AuthService} already falls back to safe defaults on the server.
 */
export function roleGuard(check: (auth: AuthService) => boolean, redirect = '/'): CanMatchFn {
  return (): boolean | UrlTree => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return check(auth) ? true : router.parseUrl(redirect);
  };
}

/** Allows matching only for identities that can manage commercial entities. */
export const commercialGuard: CanMatchFn = roleGuard(auth => auth.canManageCommercial());

/** Allows matching only for identities that can approve financials. */
export const financeGuard: CanMatchFn = roleGuard(auth => auth.canApproveFinancials());
