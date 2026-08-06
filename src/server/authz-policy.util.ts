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

/**
 * Canonical form of an `/api` sub-path for AUTHORIZATION purposes.
 *
 * WHY THIS EXISTS — it closes a total auth bypass.
 *
 * `roleGate` used `req.path` verbatim and compared it against rule tables whose
 * literals are all lowercase (`p.startsWith('/audit-logs')`, `'/resources'`, …).
 * `req.path` preserves whatever case the client sent, but EXPRESS ROUTES
 * CASE-INSENSITIVELY unless `case sensitive routing` is enabled — and this app
 * never enables it. So `GET /api/Audit-Logs` reached the handler while
 * `startsWith('/audit-logs')` was false: no READ_RULE matched, `authorizeRead`
 * saw `allowedRoles: undefined`, and an `employee` read the append-only audit
 * trail that is reserved to admin/delivery-executive. On the mutation side it was
 * worse: no rule matched `/Resources`, so `POST /api/Resources` with NO
 * Authorization header at all created a resource row with client-chosen
 * cost/bill rates. Reproduced against this repo's own express 5.2.1.
 *
 * Normalising HERE rather than relying on `app.set('case sensitive routing')` is
 * deliberate: the gate is the security boundary and must not depend on a router
 * setting that a later refactor could drop while every test still passes.
 *
 * Two vectors were probed and are deliberately NOT handled, because handling
 * them would add risk without closing anything:
 *   - percent-encoding: `GET /api/%41udit-logs` 404s — the router does not match
 *     it either, so gate and router miss together. Adding `decodeURIComponent`
 *     would introduce a double-decoding hazard to fix a non-issue.
 *   - dot segments: `/api/./audit-logs` arrives already collapsed, and a form the
 *     router would not match is a form no rule needs to match.
 *
 * INVARIANT: every literal in `READ_RULES` and in the mutation `rules` table must
 * be lowercase. This function's output is always lowercase, so an uppercase
 * literal there would silently never match.
 */
export function normalizeApiPath(rawPath: string): string {
  const lower = rawPath.toLowerCase();
  if (lower.length <= 1) return lower;
  const trimmed = lower.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

// `storage-status` is the SPA's pre-auth OIDC bootstrap configuration. `/health`
// is reserved for deployment probes. Prefix matching is deliberately forbidden.
const PUBLIC_READ_PATHS = new Set(['/health', '/storage-status']);

/** Expects an already-normalised path (see `normalizeApiPath`). */
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
