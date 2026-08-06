import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { OAuthService } from 'angular-oauth2-oidc';
import { authTokenInterceptor } from './auth-token.interceptor';

/**
 * This interceptor is half of the app's request-security seam and had NO spec.
 * The property that matters is not "a bearer is attached" — it is WHERE it is
 * attached and, far more importantly, where it is NOT: the Keycloak discovery
 * and token endpoints are cross-origin third-party hosts, and handing them our
 * access token would leak the credential off-origin. `isSameOriginApiRequest()`
 * is the only thing standing between the two, and nothing asserted it.
 *
 * Every "header present" case below therefore has its "header absent" twin. A
 * guard that refuses EVERYTHING satisfies the no-leak assertions on its own, so
 * the positive cases are what keep it honest in the other direction.
 */
const KEYCLOAK_DISCOVERY = 'https://keycloak.example:8081/realms/delivery-control/.well-known/openid-configuration';

/** The jsdom origin, read rather than hard-coded: it differs between runners,
 *  and a wrong literal would silently make every same-origin case cross-origin
 *  (and so trivially satisfy the no-leak half). */
function origin(): string {
  return window.location.origin;
}

function setup(opts: { token?: string; platform?: string } = {}) {
  const { token = 'kc-access-token', platform = 'browser' } = opts;
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([authTokenInterceptor])),
      provideHttpClientTesting(),
      { provide: PLATFORM_ID, useValue: platform },
      { provide: OAuthService, useValue: { getAccessToken: () => token } },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

/** Fires `url`, returns the Authorization header the backend actually saw. */
function authHeaderFor(url: string, opts: { token?: string; platform?: string } = {}): string | null {
  const { http, httpMock } = setup(opts);
  http.get(url).subscribe({ next: () => undefined, error: () => undefined });
  const req = httpMock.expectOne(url);
  const header = req.request.headers.get('Authorization');
  req.flush({});
  httpMock.verify();
  return header;
}

describe('authTokenInterceptor — bearer scoping', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('attaches the bearer to a relative /api request', () => {
    expect(authHeaderFor('/api/resources')).toBe('Bearer kc-access-token');
  });

  it('attaches the bearer to an ABSOLUTE same-origin /api request', () => {
    expect(authHeaderFor(`${origin()}/api/resources`)).toBe('Bearer kc-access-token');
  });

  // THE LOAD-BEARING ABSENCE: the credential must never reach the identity
  // provider's own endpoints, which are the one cross-origin host this app
  // talks to on every bootstrap.
  it('never sends the bearer to the Keycloak discovery endpoint', () => {
    expect(authHeaderFor(KEYCLOAK_DISCOVERY)).toBeNull();
  });

  it('never sends the bearer to a same-origin path outside /api', () => {
    // A same-origin asset/SSR route is not our API; scoping on origin alone
    // would leak the token into every page and image request.
    expect(authHeaderFor(`${origin()}/assets/logo.svg`)).toBeNull();
  });

  it('never sends the bearer to a cross-origin path that merely ends in /api', () => {
    // Origin is checked, not just the pathname — a third-party host that
    // happens to expose /api must not receive our token.
    expect(authHeaderFor('https://evil.example/api/resources')).toBeNull();
  });

  it('sends no Authorization header at all when there is no token, and does NOT block the request', () => {
    // The demo/loopback fallback: getAccessToken() returns ''. The request must
    // still go out unauthenticated rather than be dropped, or the whole app
    // stops working whenever Keycloak is unreachable.
    expect(authHeaderFor('/api/resources', { token: '' })).toBeNull();
  });

  it('is a no-op during SSR, where there is no signed-in principal', () => {
    expect(authHeaderFor('/api/resources', { platform: 'server' })).toBeNull();
  });

  it('leaves the rest of the request untouched — only the one header is added', () => {
    const { http, httpMock } = setup();
    http.post('/api/resources', { name: 'Julie' }, { headers: { 'X-Trace': 'abc' } })
      .subscribe({ next: () => undefined, error: () => undefined });
    const req = httpMock.expectOne('/api/resources');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toStrictEqual({ name: 'Julie' });
    expect(req.request.headers.get('X-Trace')).toBe('abc');
    expect(req.request.headers.get('Authorization')).toBe('Bearer kc-access-token');
    req.flush({});
    httpMock.verify();
  });
});
