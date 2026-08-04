import type { UserRole } from '../app/services/api.service';

export type PrimaryRole = UserRole | 'unknown';

/**
 * Priority is only for the single role shown in audit/display contexts. Route
 * authorization always evaluates the complete verified role set instead.
 */
const ROLE_PRIORITY: readonly UserRole[] = [
  'employee', 'pm', 'resource-manager', 'sales', 'finance', 'delivery-executive', 'admin',
];
const APPLICATION_ROLES = new Set<string>(ROLE_PRIORITY);

/** Keep all recognised roles from verified OIDC claims, in claim order. */
export function applicationRoles(rawRoles: readonly string[]): UserRole[] {
  const result: UserRole[] = [];
  const seen = new Set<UserRole>();
  for (const rawRole of rawRoles) {
    if (!APPLICATION_ROLES.has(rawRole)) continue;
    const role = rawRole as UserRole;
    if (seen.has(role)) continue;
    seen.add(role);
    result.push(role);
  }
  return result;
}

/** Select one role for display/audit without discarding authorization roles. */
export function primaryRole(roles: readonly UserRole[]): PrimaryRole {
  let selected: PrimaryRole = 'unknown';
  let selectedRank = -1;
  for (const role of roles) {
    const rank = ROLE_PRIORITY.indexOf(role);
    if (rank > selectedRank) {
      selected = role;
      selectedRank = rank;
    }
  }
  return selected;
}

/** Capability check: any verified application role may grant the route. */
export function hasAnyAllowedRole(
  roles: readonly UserRole[],
  allowedRoles: readonly UserRole[],
): boolean {
  const allowed = new Set<UserRole>(allowedRoles);
  return roles.some(role => allowed.has(role));
}

// `storage-status` is the SPA's pre-auth OIDC bootstrap configuration. `/health`
// is reserved for deployment probes. Prefix matching is deliberately forbidden.
const PUBLIC_READ_PATHS = new Set(['/health', '/storage-status']);

export function isPublicReadPath(path: string): boolean {
  return PUBLIC_READ_PATHS.has(path);
}

export interface ReadAuthorizationInput {
  isPublic: boolean;
  authenticated: boolean;
  roles: readonly UserRole[];
  /** Omit for an authenticated endpoint open to every application role. */
  allowedRoles?: readonly UserRole[];
}

export type ReadAuthorizationDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403 };

/**
 * GET policy is deny-by-default: only an exact public path may be anonymous.
 * Every other path needs a trusted principal plus at least one application role;
 * a route-specific rule can narrow that set further.
 */
export function authorizeRead(input: ReadAuthorizationInput): ReadAuthorizationDecision {
  if (input.isPublic) return { allowed: true };
  if (!input.authenticated) return { allowed: false, status: 401 };
  if (input.roles.length === 0) return { allowed: false, status: 403 };
  if (input.allowedRoles && !hasAnyAllowedRole(input.roles, input.allowedRoles)) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true };
}
