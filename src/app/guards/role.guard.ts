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
 * return an Observable that WAITS for `authReady` before requiring BOTH an
 * authenticated identity and the route-specific capability. The explicit
 * identity check is intentional defence in depth: a permissive/default
 * capability must never admit an anonymous browser session. `CanMatchFn`
 * natively accepts an `Observable<GuardResult>`.
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
      map(() => (auth.isAuthenticated() && check(auth) ? true : router.parseUrl(redirect))),
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

/**
 * Approver-grade roles allowed to open the per-month allocation approvals page
 * (B3), mirroring the server's '/allocation-approvals' READ_RULE. Single source
 * of truth shared by {@link allocationApprovalsGuard} and the nav entry in app.ts.
 */
export const ALLOCATION_APPROVAL_ROLES: readonly UserRole[] = ['resource-manager', 'delivery-executive', 'admin'];

/** Allows matching only for {@link ALLOCATION_APPROVAL_ROLES}. */
export const allocationApprovalsGuard: CanMatchFn = roleGuard(auth => auth.hasAnyRole([...ALLOCATION_APPROVAL_ROLES]));

// ---------------------------------------------------------------------------
// Block H — absences and engagement classification (design spec §7).
//
// THESE THREE LISTS MIRROR SERVER CONSTANTS, and the mirroring is CHECKED, not
// hoped for: `role.guard.spec.ts` imports the originals from
// `src/server/absence-policy.util.ts` and compares them element for element.
// They are re-declared here rather than imported because `role.guard.ts` ships
// in the browser bundle and that server module drags in the whole
// operational-integrity graph; a guard is UX, and it must not cost the user a
// kilobyte of write-path validators. A guard that DIVERGES from the server is
// the defect this arrangement exists to catch — too strict and a permitted
// role is redirected home, too loose and the user reaches a page that then
// answers 403.
// ---------------------------------------------------------------------------

/**
 * Roles the server admits to `GET /absences`, the level that carries the REASON
 * (GDPR art. 9 special-category data) — mirrors `ABSENCE_REASON_READ_ROLES`.
 *
 * `employee` is in the set on purpose: a READ_RULE is per-PATH, so the server
 * has to admit the role and then narrow an employee to their OWN rows inside
 * the handler. The screen must therefore treat an empty list from an employee
 * as "you have none", never as "the organization has none".
 *
 * `pm`, `finance` and `sales` are absent, and their absence is the point: a
 * planner learns that somebody is away from `/bench` and `/capacity`, never why.
 */
export const ABSENCE_REASON_READ_ROLES: readonly UserRole[] =
  ['resource-manager', 'delivery-executive', 'admin', 'employee'];

/** Allows matching only for {@link ABSENCE_REASON_READ_ROLES}. */
export const absenceRegisterGuard: CanMatchFn =
  roleGuard(auth => auth.hasAnyRole([...ABSENCE_REASON_READ_ROLES]));

/**
 * Roles the server admits to `POST`/`PUT`/`DELETE /absences` — mirrors
 * `ABSENCE_WRITE_ROLES`. A STRICT SUBSET of the read set above, which is why
 * the register's write controls are gated separately from its route: a
 * `delivery-executive` may read the reason (product decision Q5) and may not
 * record one, and the screen has to say so before the click rather than let
 * the server answer 403 after it.
 *
 * Not a route guard: no route is restricted to it. Exported for the write
 * controls inside the register and for the parity test.
 */
export const ABSENCE_WRITE_ROLES: readonly UserRole[] = ['resource-manager', 'admin'];

/**
 * Roles the server admits to `PUT /projects/:id/classification` — mirrors
 * `PROJECT_CLASSIFICATION_ROLES`. `pm` is excluded although it may mutate
 * `/projects`: whoever is measured on an engagement's margin must not be able
 * to declare that the engagement has no margin.
 */
export const PROJECT_CLASSIFICATION_ROLES: readonly UserRole[] =
  ['delivery-executive', 'finance', 'admin'];

/** Allows matching only for {@link PROJECT_CLASSIFICATION_ROLES}. */
export const projectClassificationGuard: CanMatchFn =
  roleGuard(auth => auth.hasAnyRole([...PROJECT_CLASSIFICATION_ROLES]));
