import { HttpInterceptorFn } from '@angular/common/http';
import { inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { OAuthService } from 'angular-oauth2-oidc';

/**
 * Attaches the Keycloak-issued bearer token to same-origin `/api` requests.
 *
 * Browser-only: on the server (SSR) the user is anonymous and there is no
 * token, so this is a no-op. It is also a no-op when Keycloak is unreachable
 * (demo/loopback fallback) — `getAccessToken()` simply returns an empty string
 * and no Authorization header is added.
 */
export const authTokenInterceptor: HttpInterceptorFn = (req, next) => {
  const platformId = inject(PLATFORM_ID);
  if (!isPlatformBrowser(platformId)) {
    return next(req);
  }

  // Only target our own API. Accept both relative ("/api/...") and absolute
  // same-origin URLs; never leak the token to third-party hosts.
  if (!isSameOriginApiRequest(req.url)) {
    return next(req);
  }

  const oauth = inject(OAuthService);
  const token = oauth.getAccessToken();
  if (!token) {
    return next(req);
  }

  return next(
    req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }),
  );
};

function isSameOriginApiRequest(url: string): boolean {
  // Relative URL beginning with the API prefix.
  if (url.startsWith('/api/') || url === '/api') {
    return true;
  }
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api');
  } catch {
    return false;
  }
}
