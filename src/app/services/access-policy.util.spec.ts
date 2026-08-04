import { capabilitiesForRole, capabilitiesForRoles, resourceIdFromOidcClaims } from './access-policy.util';

describe('OIDC resource identity mapping', () => {
  it('uses the explicit resource_id claim as the authoritative mapping', () => {
    expect(resourceIdFromOidcClaims({
      sub: '8bb8e8a7-opaque-subject',
      preferred_username: 'renamed-user',
      resource_id: '42',
    })).toBe('42');
  });

  it('never infers a resource identity from a mutable username', () => {
    expect(resourceIdFromOidcClaims({ preferred_username: 'julie' })).toBeUndefined();
    expect(resourceIdFromOidcClaims({ preferred_username: 'JOHN' })).toBeUndefined();
    expect(resourceIdFromOidcClaims({ preferred_username: 'admin' })).toBeUndefined();
  });

  it('does not fall back to another resource for an unmapped subject or username', () => {
    expect(resourceIdFromOidcClaims({ preferred_username: 'new.employee', sub: 'opaque-sub' })).toBeUndefined();
    expect(resourceIdFromOidcClaims({})).toBeUndefined();
    expect(resourceIdFromOidcClaims(null)).toBeUndefined();
  });
});

describe('role capability policy', () => {
  it('keeps employee access self-scoped', () => {
    expect(capabilitiesForRole('employee')).toMatchObject({
      canReadStaffing: false,
      canManageStaffing: false,
      canReadCommercial: false,
      canReadFinancials: false,
      canManageProjects: false,
      canManageConfiguration: false,
      canViewPortfolioDashboard: false,
      canSubmitOwnTime: true,
    });
  });

  it('lets PMs manage staffing and projects without granting commercial reads', () => {
    expect(capabilitiesForRole('pm')).toMatchObject({
      canReadStaffing: true,
      canManageStaffing: true,
      canReadCommercial: false,
      canReadFinancials: false,
      canManageProjects: true,
      canViewPortfolioDashboard: false,
    });
  });

  it('keeps finance read-capable but mutation-limited', () => {
    expect(capabilitiesForRole('finance')).toMatchObject({
      canReadStaffing: true,
      canManageStaffing: false,
      canReadCommercial: true,
      canReadFinancials: true,
      canManageProjects: false,
      canManageConfiguration: false,
      canViewPortfolioDashboard: true,
    });
  });

  it('does not mistake commercial access for portfolio-finance access', () => {
    expect(capabilitiesForRole('sales')).toMatchObject({
      canReadStaffing: false,
      canReadCommercial: true,
      canReadFinancials: false,
      canViewPortfolioDashboard: false,
      canSubmitOwnTime: false,
    });
  });

  it('grants the full touched-flow capability set only to delivery/admin roles', () => {
    for (const role of ['delivery-executive', 'admin'] as const) {
      expect(capabilitiesForRole(role)).toMatchObject({
        canReadStaffing: true,
        canManageStaffing: true,
        canReadCommercial: true,
        canReadFinancials: true,
        canManageProjects: true,
        canManageConfiguration: true,
        canViewPortfolioDashboard: true,
      });
    }
  });

  it('unions orthogonal capabilities for principals with multiple roles', () => {
    expect(capabilitiesForRoles(['resource-manager', 'sales'])).toMatchObject({
      canReadStaffing: true,
      canManageResources: true,
      canReadCommercial: true,
      canManageCommercial: true,
    });

    expect(capabilitiesForRoles(['pm', 'finance'])).toMatchObject({
      canManageProjects: true,
      canReadFinancials: true,
      canViewPortfolioDashboard: true,
    });
  });
});
