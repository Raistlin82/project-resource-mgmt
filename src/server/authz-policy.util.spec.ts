import {
  applicationRoles,
  authorizeRead,
  hasAnyAllowedRole,
  isPublicReadPath,
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
