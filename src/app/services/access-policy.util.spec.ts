import { capabilitiesForRole, capabilitiesForRoles, resourceIdFromOidcClaims, type RoleCapabilities } from './access-policy.util';
import type { UserRole } from './api.service';

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

/**
 * This file is the ONLY gate over the real capability table, and it used to
 * assert with `toMatchObject`. That matcher can only say "at least these are
 * granted": flipping `employee.canManageCommercial` to true in
 * access-policy.util.ts left every assertion here GREEN, while shipping an
 * employee shell where `commercialGuard` CanMatch-allows /customers,
 * /contracts, /orders and /billing and the Commercial nav group renders — four
 * routes whose reads the server then 403s. `pm.canManageConfiguration` and
 * `sales.canManageProjects` had the same hole: no assertion named them at all.
 *
 * So every row below is spelled out in FULL with `toStrictEqual`. Exhaustive
 * equality IS the assertion of absence here — it is the only form that can say
 * "and nothing else is granted", which is exactly what `toMatchObject` cannot
 * express. The expectations are hand-written literals on purpose: deriving them
 * from CAPABILITIES would make this a tautology that no over-grant can fail.
 * Changing the shipped policy must therefore be a deliberate edit in two files.
 */
const EXPECTED_CAPABILITIES: Readonly<Record<UserRole, RoleCapabilities>> = {
  employee: {
    canReadStaffing: false,
    canManageStaffing: false,
    canManageResources: false,
    canReadCommercial: false,
    canManageCommercial: false,
    canReadFinancials: false,
    canManageProjects: false,
    canManageConfiguration: false,
    canViewPortfolioDashboard: false,
    canSubmitOwnTime: true,
  },
  pm: {
    canReadStaffing: true,
    canManageStaffing: true,
    canManageResources: false,
    canReadCommercial: false,
    canManageCommercial: false,
    canReadFinancials: false,
    canManageProjects: true,
    canManageConfiguration: false,
    canViewPortfolioDashboard: false,
    canSubmitOwnTime: true,
  },
  'resource-manager': {
    canReadStaffing: true,
    canManageStaffing: true,
    canManageResources: true,
    canReadCommercial: false,
    canManageCommercial: false,
    canReadFinancials: false,
    canManageProjects: false,
    canManageConfiguration: false,
    canViewPortfolioDashboard: false,
    canSubmitOwnTime: true,
  },
  'delivery-executive': {
    canReadStaffing: true,
    canManageStaffing: true,
    canManageResources: true,
    canReadCommercial: true,
    canManageCommercial: true,
    canReadFinancials: true,
    canManageProjects: true,
    canManageConfiguration: true,
    canViewPortfolioDashboard: true,
    canSubmitOwnTime: true,
  },
  finance: {
    canReadStaffing: true,
    canManageStaffing: false,
    canManageResources: false,
    canReadCommercial: true,
    canManageCommercial: true,
    canReadFinancials: true,
    canManageProjects: false,
    canManageConfiguration: false,
    canViewPortfolioDashboard: true,
    canSubmitOwnTime: true,
  },
  sales: {
    canReadStaffing: false,
    canManageStaffing: false,
    canManageResources: false,
    canReadCommercial: true,
    canManageCommercial: true,
    canReadFinancials: false,
    canManageProjects: false,
    canManageConfiguration: false,
    canViewPortfolioDashboard: false,
    canSubmitOwnTime: false,
  },
  admin: {
    canReadStaffing: true,
    canManageStaffing: true,
    canManageResources: true,
    canReadCommercial: true,
    canManageCommercial: true,
    canReadFinancials: true,
    canManageProjects: true,
    canManageConfiguration: true,
    canViewPortfolioDashboard: true,
    canSubmitOwnTime: true,
  },
};

const ALL_ROLES = Object.keys(EXPECTED_CAPABILITIES) as UserRole[];
const CAPABILITY_KEYS = Object.keys(EXPECTED_CAPABILITIES.employee).sort();

describe('role capability policy', () => {
  it('covers every role the app can hold — an unlisted role is an unasserted role', () => {
    // If UserRole gains an 8th member, the table above must gain a row or this
    // whole suite silently stops covering it.
    expect(ALL_ROLES).toHaveLength(7);
    expect([...ALL_ROLES].sort()).toStrictEqual(
      ['admin', 'delivery-executive', 'employee', 'finance', 'pm', 'resource-manager', 'sales'],
    );
    expect(CAPABILITY_KEYS).toHaveLength(10);
  });

  it.each(ALL_ROLES)('grants %s exactly the listed capabilities and nothing beyond them', role => {
    const actual = capabilitiesForRole(role);
    // toStrictEqual over the FULL row: an over-grant on any key — named or not —
    // fails here. This is the check `toMatchObject` could never make.
    expect(actual).toStrictEqual(EXPECTED_CAPABILITIES[role]);
    // ...and the key set itself, so a capability added to the interface without
    // being added to the table above cannot slip through unasserted.
    expect(Object.keys(actual).sort()).toStrictEqual(CAPABILITY_KEYS);
  });

  // Belt and braces on the three specific over-grants the audit named: each of
  // these is a route group that would open in the shell if the bit flipped.
  it('never lets an employee reach the Commercial or Resources route groups', () => {
    expect(capabilitiesForRole('employee').canManageCommercial).toBe(false);
    expect(capabilitiesForRole('employee').canManageResources).toBe(false);
  });

  it('never lets a pm reach configuration, nor sales reach project management', () => {
    expect(capabilitiesForRole('pm').canManageConfiguration).toBe(false);
    expect(capabilitiesForRole('sales').canManageProjects).toBe(false);
  });

  // The gate must OPEN as well as refuse: a table of all-false rows would pass
  // every negative above.
  it('still grants the full set to delivery-executive and admin', () => {
    for (const role of ['delivery-executive', 'admin'] as const) {
      const caps = capabilitiesForRole(role);
      expect(Object.values(caps).every(Boolean)).toBe(true);
    }
    expect(capabilitiesForRole('finance').canReadFinancials).toBe(true);
    expect(capabilitiesForRole('sales').canManageCommercial).toBe(true);
  });

  // A semantic invariant, not a transcription: a role that may WRITE a domain
  // must be able to READ it, or the shell offers an editor over a blank screen.
  // The `employee.canManageCommercial` mutation violates this one too.
  it.each(ALL_ROLES)('never gives %s a write capability without the matching read', role => {
    const caps = capabilitiesForRole(role);
    if (caps.canManageCommercial) expect(caps.canReadCommercial).toBe(true);
    if (caps.canManageStaffing) expect(caps.canReadStaffing).toBe(true);
    if (caps.canManageResources) expect(caps.canReadStaffing).toBe(true);
  });
});

describe('capabilitiesForRoles (roles are additive, not rank-ordered)', () => {
  it.each(ALL_ROLES)('a single role %s unions to exactly that row, nothing more', role => {
    expect(capabilitiesForRoles([role])).toStrictEqual(EXPECTED_CAPABILITIES[role]);
  });

  it('unions orthogonal capabilities without inventing one neither role holds', () => {
    // resource-manager brings staffing/resources, sales brings commercial.
    // NEITHER brings financials, projects, configuration or the portfolio
    // dashboard — spelling the full row out is what pins that.
    expect(capabilitiesForRoles(['resource-manager', 'sales'])).toStrictEqual({
      canReadStaffing: true,
      canManageStaffing: true,
      canManageResources: true,
      canReadCommercial: true,
      canManageCommercial: true,
      canReadFinancials: false,
      canManageProjects: false,
      canManageConfiguration: false,
      canViewPortfolioDashboard: false,
      canSubmitOwnTime: true,
    });

    expect(capabilitiesForRoles(['pm', 'finance'])).toStrictEqual({
      canReadStaffing: true,
      canManageStaffing: true,
      canManageResources: false,
      canReadCommercial: true,
      canManageCommercial: true,
      canReadFinancials: true,
      canManageProjects: true,
      canManageConfiguration: false,
      canViewPortfolioDashboard: true,
      canSubmitOwnTime: true,
    });
  });

  it('treats a principal with NO roles as an employee, never as an admin', () => {
    expect(capabilitiesForRoles([])).toStrictEqual(EXPECTED_CAPABILITIES.employee);
  });
});
