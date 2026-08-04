import { Injectable, signal, computed, inject, afterNextRender, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { OAuthService, AuthConfig } from 'angular-oauth2-oidc';
import { filter } from 'rxjs/operators';
import { Router } from '@angular/router';
import { UserRole } from './api.service';
import { capabilitiesForRoles, resourceIdFromOidcClaims } from './access-policy.util';
import { AuthRuntimeMetadata, resolveAuthRuntimeConfig, safeOAuthReturnPath } from './auth-runtime.util';

/**
 * Single source of truth for the current user's identity, backed by Keycloak
 * via OpenID Connect (Authorization Code Flow + PKCE).
 *
 * Design notes:
 * - The PUBLIC API ({@link userId}, {@link role}, {@link isManager},
 *   {@link canManageCommercial}, {@link canApproveFinancials},
 *   {@link canApproveDelivery}, {@link hasAnyRole}) is unchanged so existing
 *   consumers (interceptors, route guards, components) keep working. These are
 *   synchronous signal reads — safe to call inside interceptors and per-request.
 *   IMPORTANT: read them REACTIVELY (inside a computed / rxResource params /
 *   getter), NEVER snapshot at field-init: until {@link authReady} flips true the
 *   OAuth bootstrap hasn't settled, so userId()/role() return the anonymous
 *   defaults — a captured value freezes the wrong identity for the component's
 *   life (e.g. loading another user's data on a deep-link/reload).
 * - SSR-safe: on the server the user is anonymous and OAuth is never touched.
 * - Demo/loopback fallback: if discovery or login fails (e.g. Keycloak is
 *   unreachable) the service silently stays anonymous and never throws on
 *   bootstrap.
 */

/**
 * Highest-privilege-wins ordering. The first matching role in this list (when
 * scanning the user's realm roles) becomes the effective {@link role}.
 */
const ROLE_PRIORITY: readonly UserRole[] = [
  'admin',
  'delivery-executive',
  'finance',
  'sales',
  'resource-manager',
  'pm',
  'employee',
];

/**
 * Decode the payload of a JWT (base64url middle segment) into a plain claims
 * object, WITHOUT verifying the signature — verification is the server's job;
 * here we only read identity claims the access token already carries.
 *
 * Returns `null` for an empty/malformed token, when no global `atob` exists
 * (SSR), or when the payload is not a JSON object. Never throws; never widens
 * to `any`.
 */
function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token || typeof atob !== 'function') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url -> base64, then decode and parse.
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64);
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly oauth = inject(OAuthService);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly isBrowser = isPlatformBrowser(this.platformId);

  /** Raw OIDC claims for the signed-in user; null while anonymous. */
  private readonly _claims = signal<Record<string, unknown> | null>(null);

  /**
   * Becomes true once the OAuth bootstrap has SETTLED — i.e. after
   * loadDiscoveryDocumentAndTryLogin() resolves (token restored / confirmed
   * absent) or fails (Keycloak unreachable → anonymous). Data loads that hit
   * principal-gated endpoints must key off this so they fire only AFTER any
   * post-login token has been restored into storage; otherwise the request
   * races the bootstrap and goes out with no Authorization header (401).
   *
   * Stays false on the server (afterNextRender never runs), which is correct:
   * SSR has no token, so gated loads should resolve to their empty default
   * rather than fire and fail.
   */
  private readonly _authReady = signal(false);
  readonly authReady = this._authReady.asReadonly();

  /**
   * Stable resource id for the signed-in OIDC principal. Empty means the
   * identity is not linked to a resource; it must never default to a colleague.
   */
  readonly userId = computed<string>(() => {
    return resourceIdFromOidcClaims(this._claims()) ?? '';
  });

  readonly hasResourceIdentity = computed(() => this.userId() !== '');

  /** Every recognized application role carried by the verified principal. */
  readonly roles = computed<readonly UserRole[]>(() => {
    const claims = this._claims();
    if (!claims) return ['employee'];
    const recognized = this.realmRoles(claims)
      .filter((role): role is UserRole => ROLE_PRIORITY.includes(role as UserRole));
    return recognized.length ? [...new Set(recognized)] : ['employee'];
  });

  /** Primary role is display-only; authorization uses the additive role set. */
  readonly role = computed<UserRole>(() => {
    return this.highestRole(this.roles());
  });

  private readonly capabilities = computed(() => capabilitiesForRoles(this.roles()));

  readonly isManager = computed(() => this.capabilities().canManageResources);
  readonly canReadStaffing = computed(() => this.capabilities().canReadStaffing);
  readonly canManageStaffing = computed(() => this.capabilities().canManageStaffing);
  readonly canManageResources = computed(() => this.capabilities().canManageResources);
  readonly canReadCommercial = computed(() => this.capabilities().canReadCommercial);
  readonly canManageCommercial = computed(() => this.capabilities().canManageCommercial);
  readonly canReadFinancials = computed(() => this.capabilities().canReadFinancials);
  readonly canManageProjects = computed(() => this.capabilities().canManageProjects);
  readonly canManageConfiguration = computed(() => this.capabilities().canManageConfiguration);
  readonly canViewPortfolioDashboard = computed(() => this.capabilities().canViewPortfolioDashboard);
  readonly canSubmitOwnTime = computed(() => this.capabilities().canSubmitOwnTime && this.hasResourceIdentity());
  readonly canApproveFinancials = computed(() => this.capabilities().canReadFinancials);
  readonly canApproveDelivery = computed(() => this.hasAnyRole(['pm', 'delivery-executive', 'admin']));

  /** Whether a user is currently signed in (always false on the server). */
  readonly isAuthenticated = computed(() => this._claims() !== null);

  /** Human-readable display name for the auth control; empty when anonymous. */
  readonly displayName = computed<string>(() => {
    const claims = this._claims();
    if (!claims) return '';
    return this.stringClaim(claims, 'name') || this.preferredUsername(claims);
  });

  constructor() {
    // Bootstrap OAuth AFTER construction, in the browser only. Calling init()
    // synchronously here fired the discovery HTTP request mid-construction; that
    // request flows through errorInterceptor, which inject()s AuthService — a
    // self-reference while this very instance is still being built (NG0200) — and
    // left hydration unstable (NG0506). afterNextRender runs once, post-render,
    // and is a no-op on the server, so neither the cycle nor an SSR call occurs.
    afterNextRender(() => this.init());
  }

  hasAnyRole(roles: UserRole[]): boolean {
    return this.roles().some(role => roles.includes(role));
  }

  /** Start the Keycloak login (Authorization Code Flow + PKCE). */
  login(): void {
    if (this.isBrowser) {
      this.oauth.initCodeFlow(this.currentAppPath());
    }
  }

  /** Sign out at Keycloak and clear local tokens. */
  logout(): void {
    if (this.isBrowser) {
      this.oauth.logOut();
    }
  }

  /**
   * Demo-only identity override (legacy). Retained so non-OIDC callers keep
   * compiling; ignored once a real Keycloak session is established.
   */
  setUser(id: string, role: UserRole = 'employee'): void {
    const mappedResourceId = resourceIdFromOidcClaims({ preferred_username: id })
      ?? (/^\d+$/.test(id) ? id : undefined);
    this._claims.set({
      preferred_username: id,
      ...(mappedResourceId ? { resource_id: mappedResourceId } : {}),
      realm_access: { roles: [role] },
    });
  }

  // --- bootstrap -----------------------------------------------------------

  private async init(): Promise<void> {
    const runtime = await this.fetchRuntimeMetadata();
    const authConfig = resolveAuthRuntimeConfig(runtime);
    const config: AuthConfig = {
      issuer: authConfig.issuer,
      clientId: authConfig.clientId,
      redirectUri: window.location.origin + '/',
      responseType: 'code',
      scope: 'openid profile email',
      requireHttps: false,
      showDebugInformation: false,
    };
    this.oauth.configure(config);

    // Refresh claims whenever a token is (re)received.
    this.oauth.events
      .pipe(filter(e => e.type === 'token_received' || e.type === 'token_refreshed'))
      .subscribe(() => this.syncClaims());

    // Does the SERVER run in header-trust (local/dev) mode? Decided by the
    // backend, never the client, so the dev-only behaviours below cannot be
    // forced on in production.
    const demoMode = runtime.demoMode === true;

    try {
      await this.oauth.loadDiscoveryDocumentAndTryLogin();
      this.syncClaims();
      if (this.isAuthenticated()) {
        this.oauth.setupAutomaticSilentRefresh();
        const returnPath = safeOAuthReturnPath(this.oauth.state);
        if (returnPath && returnPath !== this.currentAppPath()) {
          await this.router.navigateByUrl(returnPath, { replaceUrl: true });
        }
      } else if (!demoMode) {
        // PRODUCTION: authentication is mandatory. Never show the app
        // anonymously — redirect straight to the Keycloak login. The browser
        // navigates away, so nothing below runs.
        this.oauth.initCodeFlow(this.currentAppPath());
        return;
      }
      // DEV + not signed in: anonymous browsing is allowed (the Sign in control
      // stays available). The demo-admin fallback only kicks in when Keycloak is
      // unreachable (the catch below).
    } catch {
      // Keycloak unreachable.
      if (demoMode) {
        // DEV: bootstrap a demo ADMIN so the in-memory app is fully usable
        // without a running IdP.
        this.applyDemoAdmin();
      } else {
        // PRODUCTION: cannot authenticate; remain anonymous (route guards block
        // protected screens and the Sign in control is shown).
        this._claims.set(null);
      }
    } finally {
      // Token (if any) is restored and claims synced; releasing authReady lets
      // principal-gated data loads fire with a valid Authorization header.
      this._authReady.set(true);
    }
  }

  /** Load public deployment metadata and whether local demo auth is enabled. */
  private async fetchRuntimeMetadata(): Promise<AuthRuntimeMetadata & { demoMode?: boolean }> {
    try {
      const res = await fetch('/api/storage-status');
      if (res.ok) {
        return (await res.json()) as AuthRuntimeMetadata & { demoMode?: boolean };
      }
    } catch {
      // Ignore: secure defaults keep demo mode disabled and use local OIDC wiring.
    }
    return {};
  }

  private currentAppPath(): string {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  /** Local/dev demo identity: full-access admin, no IdP required. */
  private applyDemoAdmin(): void {
    this._claims.set({
      preferred_username: 'admin',
      resource_id: '1',
      name: 'Demo Admin',
      realm_access: { roles: ['admin'] },
    });
  }

  private syncClaims(): void {
    if (!this.oauth.hasValidAccessToken()) {
      this._claims.set(null);
      return;
    }
    // Keycloak's built-in `roles` scope emits `realm_access.roles` in the
    // ACCESS token only (id.token.claim=false), while `profile`/`email` populate
    // the ID token (preferred_username, name, ...). Merge BOTH so role() reads
    // realm roles (access token) and userId()/displayName() read profile claims
    // (ID token). The access token wins for `realm_access`.
    const idClaims = this.oauth.getIdentityClaims() as Record<string, unknown> | null;
    const accessClaims = decodeJwtPayload(this.oauth.getAccessToken());
    if (!idClaims && !accessClaims) {
      this._claims.set(null);
      return;
    }
    const merged: Record<string, unknown> = { ...(idClaims ?? {}), ...(accessClaims ?? {}) };
    this._claims.set(merged);
  }

  // --- claim parsing (no `any` leaks out of these helpers) -----------------

  private stringClaim(claims: Record<string, unknown>, key: string): string {
    const value = claims[key];
    return typeof value === 'string' ? value : '';
  }

  private preferredUsername(claims: Record<string, unknown>): string {
    return this.stringClaim(claims, 'preferred_username') || this.stringClaim(claims, 'sub');
  }

  /** Extract realm_access.roles defensively from untyped claims. */
  private realmRoles(claims: Record<string, unknown>): string[] {
    const realmAccess = claims['realm_access'];
    if (!realmAccess || typeof realmAccess !== 'object') return [];
    const roles = (realmAccess as Record<string, unknown>)['roles'];
    if (!Array.isArray(roles)) return [];
    return roles.filter((r): r is string => typeof r === 'string');
  }

  private highestRole(roles: readonly string[]): UserRole {
    const set = new Set(roles);
    for (const candidate of ROLE_PRIORITY) {
      if (set.has(candidate)) return candidate;
    }
    return 'employee';
  }
}
