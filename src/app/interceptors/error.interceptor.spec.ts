import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { errorInterceptor } from './error.interceptor';
import { NotificationService } from '../services/notification.service';
import { AuthService } from '../services/auth.service';

/**
 * The other half of the request-security seam, and it had NO spec either.
 *
 * Three separate decisions live in this one file and none of them was asserted:
 *
 *  1. WHICH failures are suppressed. The rule is narrow on purpose — a 401 on
 *     our own /api, or a 403 while NOT authenticated — because those are
 *     self-healing auth-state transitions during OIDC bootstrap. Collapsing the
 *     parenthesised clause to `status === 401 || status === 403` (which the
 *     comment above it practically invites) makes EVERY genuine permission
 *     denial for a signed-in user vanish: a pm clicking Approve on a colleague's
 *     change request gets a silent no-op and re-clicks forever, because
 *     change-requests.ts subscribes without an error handler and relies entirely
 *     on this toast. The authenticated-403 case below is the one that fails under
 *     that collapse; all three suppressed cases pass under it, which is exactly
 *     why a partial spec here would be a blind green gate.
 *  2. WHERE the demo identity headers go. Cross-origin (Keycloak) requests must
 *     not carry them or the preflight breaks login.
 *  3. The status-0 rule is scoped to CROSS-ORIGIN failures, not to status 0 in
 *     general, and to status 0, not to cross-origin in general. Both twins are
 *     below; either one alone leaves half the branch unpinned.
 *
 * Every failure is rethrown in all cases — asserted per case, since a
 * suppression that swallowed the error instead of rethrowing would leave every
 * rxResource stuck in 'loading' forever.
 */
const KEYCLOAK_TOKEN_URL = 'https://keycloak.example:8081/realms/delivery-control/protocol/openid-connect/token';

interface Harness {
  http: HttpClient;
  httpMock: HttpTestingController;
  errorToasts: string[];
}

function setup(opts: { authenticated?: boolean } = {}): Harness {
  const { authenticated = true } = opts;
  const errorToasts: string[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([errorInterceptor])),
      provideHttpClientTesting(),
      { provide: NotificationService, useValue: { error: (m: string) => errorToasts.push(m), show: () => undefined, success: () => undefined } },
      {
        provide: AuthService,
        useValue: {
          userId: () => 'R-7',
          role: () => 'pm',
          isAuthenticated: () => authenticated,
        },
      },
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    httpMock: TestBed.inject(HttpTestingController),
    errorToasts,
  };
}

interface Outcome {
  errorToasts: string[];
  /** The error the CALLER observed — proves the interceptor rethrew, and proves
   *  the branch under test was entered with the status the test claims. */
  observed: HttpErrorResponse | undefined;
}

/** Fires `url` and fails it with `status`, returning what the user and the
 *  caller each got. */
function failWith(
  url: string,
  status: number,
  opts: { authenticated?: boolean; body?: unknown } = {},
): Outcome {
  const { http, httpMock, errorToasts } = setup({ authenticated: opts.authenticated });
  let observed: HttpErrorResponse | undefined;
  http.get(url).subscribe({ next: () => undefined, error: (e: HttpErrorResponse) => { observed = e; } });
  const req = httpMock.expectOne(url);
  if (status === 0) {
    // A connection failure, not an HTTP status — the shape the Keycloak
    // endpoints produce when the identity provider is unreachable.
    req.error(new ProgressEvent('error'));
  } else {
    req.flush(opts.body ?? { error: `refused (${status})` }, { status, statusText: 'Refused' });
  }
  httpMock.verify();
  return { errorToasts, observed };
}

describe('errorInterceptor — which failures reach the user', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('TOASTS a 403 for an authenticated user: a genuine permission denial', () => {
    // The pm-clicks-Approve case. This is the assertion the 401||403 collapse
    // fails, and the only one in this file that it fails.
    const { errorToasts, observed } = failWith(
      '/api/change-requests/CR1',
      403,
      { authenticated: true, body: { error: 'Role pm cannot modify /change-requests/CR1' } },
    );
    expect(errorToasts).toStrictEqual(['Role pm cannot modify /change-requests/CR1']);
    // The server's own reason must be what the user reads, not a generic
    // "Http failure response for ..." string.
    expect(observed?.status).toBe(403);
  });

  it('stays silent on a 403 while NOT authenticated: an anonymous read during bootstrap', () => {
    const { errorToasts, observed } = failWith('/api/change-requests/CR1', 403, { authenticated: false });
    expect(errorToasts).toStrictEqual([]);
    // Suppressed, NOT swallowed: the caller still sees the failure, so an
    // rxResource resolves to its error state instead of hanging in 'loading'.
    expect(observed).toBeInstanceOf(HttpErrorResponse);
    expect(observed?.status).toBe(403);
  });

  // One TestBed per case: `setup()` configures the module, so two calls in one
  // test throw "already instantiated" rather than asserting anything.
  it.each([true, false])('stays silent on a 401 with isAuthenticated()=%s', authenticated => {
    const { errorToasts, observed } = failWith('/api/resources', 401, { authenticated });
    expect(errorToasts).toStrictEqual([]);
    expect(observed?.status).toBe(401);
  });

  it('MUST STILL toast a same-origin 500 — the suppression is not "quiet on /api"', () => {
    // The mirror case: without this, an interceptor that toasted nothing at all
    // would pass every silence assertion above.
    const { errorToasts, observed } = failWith('/api/resources', 500, { body: { error: 'boom' } });
    expect(errorToasts).toStrictEqual(['boom']);
    expect(observed?.status).toBe(500);
  });

  it('MUST STILL toast a 400 for an authenticated user', () => {
    const { errorToasts } = failWith('/api/orders', 400, { body: { error: 'project cost center CC-100 already exists' } });
    expect(errorToasts).toStrictEqual(['project cost center CC-100 already exists']);
  });

  it('falls back to a readable message when the body carries no server reason', () => {
    const { errorToasts } = failWith('/api/resources', 500, { body: 'plain text failure' });
    expect(errorToasts).toHaveLength(1);
    // Not a bare "undefined" or "null" on screen.
    expect(errorToasts[0]).not.toBe('undefined');
    expect(errorToasts[0]).toBeTruthy();
  });
});

describe('errorInterceptor — the cross-origin status-0 rule, both halves', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('stays silent when a CROSS-ORIGIN request fails to connect (Keycloak unreachable)', () => {
    // Otherwise the app raises a raw "...: 0 undefined" toast on every load when
    // the identity provider is down, while the app itself works fine in its
    // demo/anonymous fallback.
    const { errorToasts, observed } = failWith(KEYCLOAK_TOKEN_URL, 0);
    expect(errorToasts).toStrictEqual([]);
    expect(observed?.status).toBe(0);
  });

  it('MUST STILL toast a CROSS-ORIGIN failure that is not a connection failure', () => {
    // Scopes the rule to status 0. A rule keyed on "cross-origin" alone would
    // silence a genuinely broken identity provider response.
    const { errorToasts, observed } = failWith(KEYCLOAK_TOKEN_URL, 500);
    expect(errorToasts).toHaveLength(1);
    expect(observed?.status).toBe(500);
  });

  it('MUST STILL toast a SAME-ORIGIN connection failure — our own API being unreachable is news', () => {
    // Scopes the rule to cross-origin. A rule keyed on "status 0" alone would
    // hide the app's own backend going away.
    const { errorToasts, observed } = failWith('/api/resources', 0);
    expect(errorToasts).toHaveLength(1);
    expect(observed?.status).toBe(0);
  });
});

describe('errorInterceptor — demo identity header scoping', () => {
  afterEach(() => TestBed.resetTestingModule());

  /** Fires `url` successfully and reports the identity headers the backend saw. */
  function identityHeadersFor(url: string): { id: string | null; role: string | null } {
    const { http, httpMock } = setup();
    http.get(url).subscribe({ next: () => undefined, error: () => undefined });
    const req = httpMock.expectOne(url);
    const headers = {
      id: req.request.headers.get('X-User-Id'),
      role: req.request.headers.get('X-User-Role'),
    };
    req.flush({});
    httpMock.verify();
    return headers;
  }

  it('stamps the demo identity on a relative /api request', () => {
    expect(identityHeadersFor('/api/resources')).toStrictEqual({ id: 'R-7', role: 'pm' });
  });

  it('stamps it on an ABSOLUTE same-origin /api request too', () => {
    expect(identityHeadersFor(`${window.location.origin}/api/resources`)).toStrictEqual({ id: 'R-7', role: 'pm' });
  });

  // THE LOAD-BEARING ABSENCE: these headers on a cross-origin request trigger a
  // CORS preflight Keycloak rejects, which breaks login outright.
  it('never stamps it on a cross-origin Keycloak request', () => {
    expect(identityHeadersFor(KEYCLOAK_TOKEN_URL)).toStrictEqual({ id: null, role: null });
  });

  it('never stamps it on a same-origin path outside /api', () => {
    expect(identityHeadersFor(`${window.location.origin}/assets/logo.svg`)).toStrictEqual({ id: null, role: null });
  });
});
