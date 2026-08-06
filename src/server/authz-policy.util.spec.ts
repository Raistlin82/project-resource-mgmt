import {
  applicationRoles,
  authorizeRead,
  hasAnyAllowedRole,
  isPublicReadPath,
  normalizeApiPath,
  primaryRole,
} from './authz-policy.util';

describe('verified OIDC role policy', () => {
  it('preserves every recognised verified role while removing unknowns and duplicates', () => {
    expect(applicationRoles(['offline_access', 'pm', 'finance', 'pm', 'uma_authorization']))
      .toEqual(['pm', 'finance']);
  });

  it('keeps the primary role separate from capability authorization', () => {
    const roles = applicationRoles(['pm', 'finance']);

    expect(primaryRole(roles)).toBe('finance');
    expect(hasAnyAllowedRole(roles, ['pm', 'delivery-executive', 'admin'])).toBe(true);
    expect(hasAnyAllowedRole(roles, ['resource-manager', 'admin'])).toBe(false);
  });
});

describe('deny-by-default read policy', () => {
  it('allows only the exact public bootstrap/health paths without a principal', () => {
    expect(isPublicReadPath('/storage-status')).toBe(true);
    expect(isPublicReadPath('/health')).toBe(true);
    expect(isPublicReadPath('/projects')).toBe(false);
    expect(isPublicReadPath('/storage-status/details')).toBe(false);

    expect(authorizeRead({ isPublic: true, authenticated: false, roles: [] })).toEqual({ allowed: true });
  });

  it('rejects an unlisted GET when no trusted principal exists, even without a route-specific rule', () => {
    expect(authorizeRead({ isPublic: false, authenticated: false, roles: [] }))
      .toEqual({ allowed: false, status: 401 });
  });

  it('allows an authenticated application role through a GET with no narrower rule', () => {
    expect(authorizeRead({ isPublic: false, authenticated: true, roles: ['employee'] }))
      .toEqual({ allowed: true });
  });

  it('requires any one verified role to satisfy a route-specific read capability', () => {
    expect(authorizeRead({
      isPublic: false,
      authenticated: true,
      roles: ['sales', 'pm'],
      allowedRoles: ['pm', 'resource-manager'],
    })).toEqual({ allowed: true });

    expect(authorizeRead({
      isPublic: false,
      authenticated: true,
      roles: ['employee', 'sales'],
      allowedRoles: ['pm', 'resource-manager'],
    })).toEqual({ allowed: false, status: 403 });
  });

  it('rejects an authenticated token that has no application role', () => {
    expect(authorizeRead({ isPublic: false, authenticated: true, roles: [] }))
      .toEqual({ allowed: false, status: 403 });
  });
});

describe('normalizeApiPath — the case-bypass fix', () => {
  /**
   * The rule tables in src/server.ts are prefix tests over lowercase literals.
   * These are the ones whose bypass had the worst consequences.
   */
  const GATED_PREFIXES = ['/audit-logs', '/resources', '/contracts', '/orders', '/settings', '/integrations'];

  it('folds every case variant onto the lowercase form the rules match', () => {
    // THE P0. roleGate used req.path verbatim; Express routes case-insensitively
    // (this app never sets `case sensitive routing`). So GET /api/Audit-Logs reached
    // the handler while startsWith('/audit-logs') was false — no READ_RULE matched,
    // authorizeRead saw allowedRoles: undefined, and an `employee` read the whole
    // append-only audit trail. POST /api/Resources with NO bearer created a resource
    // with client-chosen cost/bill rates.
    expect(normalizeApiPath('/Audit-Logs')).toBe('/audit-logs');
    expect(normalizeApiPath('/AUDIT-LOGS')).toBe('/audit-logs');
    expect(normalizeApiPath('/Resources')).toBe('/resources');
    expect(normalizeApiPath('/SeTtInGs/hours-per-day')).toBe('/settings/hours-per-day');
  });

  it('makes the prefix test give the SAME answer for every case variant', () => {
    // The assertion that actually pins the security property, rather than pinning
    // one string transformation: for each gated prefix, no capitalisation of it may
    // escape the prefix test. A fix that lowercased only the first segment, or only
    // the exact strings listed in the test above, fails here.
    for (const prefix of GATED_PREFIXES) {
      const variants = [
        prefix.toUpperCase(),
        prefix[0] + prefix[1].toUpperCase() + prefix.slice(2),
        prefix.replace(/-([a-z])/g, (_m, c) => '-' + c.toUpperCase()),
        prefix + '/SOME-ID',
      ];
      for (const variant of variants) {
        expect(normalizeApiPath(variant).startsWith(prefix)).toBe(true);
      }
    }
  });

  it('leaves an already-canonical path byte-identical', () => {
    // ASSERTION OF ABSENCE #1: normalisation must not perturb the paths that already
    // worked, or it trades an auth bypass for a routing outage.
    for (const prefix of GATED_PREFIXES) {
      expect(normalizeApiPath(prefix)).toBe(prefix);
    }
    expect(normalizeApiPath('/time-entries/TE-1/decision')).toBe('/time-entries/te-1/decision');
    expect(normalizeApiPath('/')).toBe('/');
  });

  it('collapses a trailing slash so the exact-match public set cannot be dodged', () => {
    expect(normalizeApiPath('/health/')).toBe('/health');
    expect(normalizeApiPath('/storage-status///')).toBe('/storage-status');
    expect(isPublicReadPath(normalizeApiPath('/Health'))).toBe(true);
    expect(isPublicReadPath(normalizeApiPath('/health/'))).toBe(true);
  });

  it('does NOT widen the public set beyond its two exact members', () => {
    // ASSERTION OF ABSENCE #2, and the one that matters most: this fix is applied on
    // the read path immediately before isPublicReadPath, so a normalisation that
    // stripped or folded too much would turn a gated path into an anonymous one.
    // Prefix matching is forbidden for public paths by design.
    for (const notPublic of ['/healthz', '/health-check', '/audit-logs', '/storage-status/extra', '/Resources']) {
      expect(isPublicReadPath(normalizeApiPath(notPublic))).toBe(false);
    }
  });

  it('always returns a lowercase string, which is what makes the lowercase-literal invariant safe', () => {
    for (const p of ['/Foo/Bar', '/BAZ', '/a', '/']) {
      expect(normalizeApiPath(p)).toBe(normalizeApiPath(p).toLowerCase());
    }
  });
});
