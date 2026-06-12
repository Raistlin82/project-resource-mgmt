import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { NotificationService } from '../services/notification.service';
import { AuthService } from '../services/auth.service';

/**
 * Surfaces failed HTTP requests as global error notifications, then rethrows so
 * callers can still react.
 *
 * Exception: a 401 (Unauthorized) on our own same-origin `/api` requests is NOT
 * toasted. During OIDC bootstrap and for anonymous users these same-origin `/api`
 * GETs transiently 401 as the auth state settles; they are auth-state transitions,
 * not user-actionable errors (rxResources already fall back to empty defaults).
 * The error is still rethrown so callers/resources observe it. Genuine failures —
 * other 4xx, any 5xx, and any failure on non-`/api` requests — are still toasted.
 *
 * It also stamps the demo identity headers (`X-User-Id` / `X-User-Role`) — but
 * ONLY on our own same-origin `/api` calls. Cross-origin requests (notably the
 * Keycloak OIDC discovery/token endpoints) must NOT carry these headers: they
 * would trigger a CORS preflight that Keycloak rejects, breaking login. Scoping
 * the AuthService injection to `/api` requests also avoids an
 * AuthService <-> interceptor bootstrap cycle (the OIDC discovery request, fired
 * while AuthService initialises, no longer re-enters AuthService here).
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notifications = inject(NotificationService);

  const ownApiRequest = isOwnApiRequest(req.url);

  const auth = ownApiRequest ? inject(AuthService) : null;

  let outgoing = req;
  if (ownApiRequest && auth) {
    outgoing = req.clone({
      setHeaders: {
        'X-User-Id': auth.userId(),
        'X-User-Role': auth.role(),
      },
    });
  }

  return next(outgoing).pipe(
    catchError((error: HttpErrorResponse) => {
      // Cross-origin connection failure (status 0) — e.g. the Keycloak OIDC
      // discovery/token endpoints when the identity provider is unreachable. Not
      // user-actionable (the app falls back to its demo/anonymous state), so it
      // must not raise a raw "...: 0 undefined" error toast.
      if (!ownApiRequest && error.status === 0) {
        return throwError(() => error);
      }
      // Auth-state transitions on our own /api are expected and self-healing: a
      // 401 (OIDC bootstrap / anonymous), or a 403 while NOT authenticated (an
      // anonymous user hitting a role-gated read). rxResources fall back to empty
      // defaults — don't toast. A 403 for an AUTHENTICATED user is a genuine
      // "not allowed" and is still toasted below.
      if (ownApiRequest && (error.status === 401 || (error.status === 403 && !auth?.isAuthenticated()))) {
        return throwError(() => error);
      }

      const serverMessage =
        error.error && typeof error.error === 'object' ? error.error.error : null;
      const message =
        serverMessage || error.message || `Request failed (${error.status})`;
      notifications.error(message);
      return throwError(() => error);
    }),
  );
};

/**
 * Whether a request targets our own API. Accepts relative `/api/...` URLs
 * (browser + SSR) and absolute same-origin `/api/...` URLs in the browser. On
 * the server (no `window`) any `/api` path is treated as ours, since SSR only
 * ever calls its own backend. Cross-origin URLs (e.g. Keycloak on :8081) are
 * never matched, so identity headers never leak off-origin.
 */
function isOwnApiRequest(url: string): boolean {
  if (url.startsWith('/api/') || url === '/api') {
    return true;
  }
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
    const parsed = new URL(url, origin ?? 'http://localhost');
    return origin
      ? parsed.origin === origin && parsed.pathname.startsWith('/api')
      : parsed.pathname.startsWith('/api');
  } catch {
    return false;
  }
}
