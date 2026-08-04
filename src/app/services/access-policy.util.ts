import type { UserRole } from './api.service';

export interface RoleCapabilities {
  readonly canReadStaffing: boolean;
  readonly canManageStaffing: boolean;
  readonly canManageResources: boolean;
  readonly canReadCommercial: boolean;
  readonly canManageCommercial: boolean;
  readonly canReadFinancials: boolean;
  readonly canManageProjects: boolean;
  readonly canManageConfiguration: boolean;
  readonly canViewPortfolioDashboard: boolean;
  readonly canSubmitOwnTime: boolean;
}

type OidcIdentityClaims = Record<string, unknown> | null | undefined;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

/**
 * Resolve the OIDC principal into the resource-id namespace used by staffing.
 * There is deliberately no arbitrary default: an unmapped identity must fail
 * closed instead of silently becoming another employee.
 */
export function resourceIdFromOidcClaims(claims: OidcIdentityClaims): string | undefined {
  if (!claims) return undefined;
  const explicit = nonEmptyString(claims['resource_id']) ?? nonEmptyString(claims['resourceId']);
  return explicit;
}

const CAPABILITIES: Readonly<Record<UserRole, RoleCapabilities>> = Object.freeze({
  employee: Object.freeze({
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
  }),
  pm: Object.freeze({
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
  }),
  'resource-manager': Object.freeze({
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
  }),
  'delivery-executive': Object.freeze({
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
  }),
  finance: Object.freeze({
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
  }),
  sales: Object.freeze({
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
  }),
  admin: Object.freeze({
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
  }),
});

/** Single client policy table mirroring server READ/WRITE role sets. */
export function capabilitiesForRole(role: UserRole): RoleCapabilities {
  return CAPABILITIES[role];
}

/** Union every granted role; roles are additive rather than rank-ordered. */
export function capabilitiesForRoles(roles: readonly UserRole[]): RoleCapabilities {
  const effectiveRoles: readonly UserRole[] = roles.length ? roles : ['employee'];
  const granted = effectiveRoles.map(role => CAPABILITIES[role]);
  return {
    canReadStaffing: granted.some(c => c.canReadStaffing),
    canManageStaffing: granted.some(c => c.canManageStaffing),
    canManageResources: granted.some(c => c.canManageResources),
    canReadCommercial: granted.some(c => c.canReadCommercial),
    canManageCommercial: granted.some(c => c.canManageCommercial),
    canReadFinancials: granted.some(c => c.canReadFinancials),
    canManageProjects: granted.some(c => c.canManageProjects),
    canManageConfiguration: granted.some(c => c.canManageConfiguration),
    canViewPortfolioDashboard: granted.some(c => c.canViewPortfolioDashboard),
    canSubmitOwnTime: granted.some(c => c.canSubmitOwnTime),
  };
}
