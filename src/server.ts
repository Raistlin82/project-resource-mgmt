import { AngularNodeAppEngine, isMainModule, writeResponseToNodeResponse, createNodeRequestHandler } from '@angular/ssr/node';
import express, { Request, Response, NextFunction, Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { desc } from 'drizzle-orm';
import { getRepositories, type FxRateRow } from './db/repositories';
import { db } from './db/client';
import { auditLogs as auditLogsTable } from './db/schema';
import { initPersistence } from './db/bootstrap';
import type { Entity, Repository } from './db/repository';
import type { AuditLog, Resource, ResourceRequest, Assignment, AssignmentDay, AssignmentMonth, TimeEntry, Contract, Order, OrderLine, BillingPlanItem, ApprovalRequest, SkillCatalog, ProficiencySet, Skill, ProjectRole, ResourceOrganization, Country, Project, ProjectCostCenter, AllocationApprovalRow, AllocationApprovalItem, SubstitutionMonthOutcome, SubstitutionResult } from './app/services/api.service';
import { utilizationContribution, requestStatusFor, isAllowedTimeEntryTransition, decisionToAssignmentStatus, allocationApproverStep } from './app/services/staffing.util';
import { deriveAssignmentStatus, monthRowId, parseMonthRowId, monthlyAggregateHours, type MonthStatus } from './app/services/allocation-month.util';
import { monthOf, isWorkingDay, sumHoursByDate, exceedsDailyCapacity, monthlyTargetHours } from './app/services/calendar.util';
import { planSubstitution, planGiveBack, planSubstitutionBooking, type SubstitutionPlan } from './app/services/substitution.util';
import { rollupMonthly, monthsInRange } from './app/services/capacity.util';
import { convertToBase, computeProjectFinancials, recognitionJournal, type FinanceData } from './app/services/finance.util';
import type { FxRate, RateCard } from './app/services/api.service';
import { isResourceKind, RESOURCE_KINDS, kindOf, dailyCapFor } from './app/services/resource-kind.util';
import { ORG_LEVELS, wouldCycleInOrgTree, wouldCycleInOrgChart, scopeOf, scopedApproversOf, type OrgLevel } from './app/services/org-scope.util';
import { maxIdSeq } from './server/id-seq.util';
import { getIntegrations, listDescriptors } from './server/integrations/registry';
import { UnbalancedJournalError } from './server/integrations/erp-ledger.adapter';
import { EInvoiceValidationError } from './server/integrations/fatturapa.adapter';
import type { CrmOutboxEntry, ExportArtifact, ProjectFinancialsRow, SupplierInfo } from './server/integrations/types';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();
/**
 * S6 (rate-limit correctness): make `req.ip` the REAL client IP, not the
 * proxy's socket address. The security model assumes a reverse proxy / TLS
 * terminator in front of us; with `trust proxy` unset every external client
 * collapses into ONE rate-limit bucket (a single client can then starve all
 * others). Configure the EXACT number of trusted proxy hops via TRUST_PROXY so
 * Express derives the client IP from the trusted tail of X-Forwarded-For only.
 * Default 0 (off) — the safe no-proxy default: when there is no proxy in front,
 * XFF is fully attacker-controlled and must NOT be trusted. Set TRUST_PROXY to
 * the number of hops you control in production (typically 1).
 */
const trustProxyHops = Number(process.env['TRUST_PROXY'] ?? 0);
app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : false);
const allowedHosts = (process.env['NG_ALLOWED_HOSTS'] || 'localhost,127.0.0.1')
  .split(',')
  .map(host => host.trim())
  .filter(Boolean);
const angularApp = new AngularNodeAppEngine({ allowedHosts });

// S6: cap request body size to mitigate DoS via large payloads.
app.use(express.json({ limit: '1mb' }));

// --- Security helpers -------------------------------------------------------

/** S1 (mass-assignment): copy ONLY allow-listed fields from an untrusted body. */
function pick<T extends object>(body: unknown, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  if (body && typeof body === 'object') {
    const src = body as Record<string, unknown>;
    for (const k of keys) {
      if (src[k] !== undefined) out[k] = src[k];
    }
  }
  return out as Partial<T>;
}

/** S2: validate a value is a finite, non-negative number. */
function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Resource Schedule: a value is an ISO-parseable date string (Date.parse). */
function isIsoDateString(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

/**
 * Resource Schedule: validate the optional booking fields on an assignment body.
 * Returns an error message when invalid, or null when valid/absent. Light and
 * backward-compatible — when all three are omitted this passes unchanged:
 *   - startDate/endDate, if provided, must be ISO-parseable.
 *   - when BOTH are provided, end must be >= start.
 *   - allocationPct, if provided, must be a finite number in [0, 100].
 */
function validateAssignmentSchedule(body: Partial<Assignment>): string | null {
  if (body.startDate !== undefined && !isIsoDateString(body.startDate)) {
    return 'startDate must be an ISO date string';
  }
  if (body.endDate !== undefined && !isIsoDateString(body.endDate)) {
    return 'endDate must be an ISO date string';
  }
  if (
    body.startDate !== undefined &&
    body.endDate !== undefined &&
    Date.parse(body.endDate) < Date.parse(body.startDate)
  ) {
    return 'endDate must be on or after startDate';
  }
  if (
    body.allocationPct !== undefined &&
    !(typeof body.allocationPct === 'number' && Number.isFinite(body.allocationPct) && body.allocationPct >= 0 && body.allocationPct <= 100)
  ) {
    return 'allocationPct must be a number between 0 and 100';
  }
  return null;
}

/**
 * Phase G — server-side date backstop. Each named field, WHEN PRESENT (non-empty),
 * must be an ISO-parseable date string; optional/omitted/'' fields pass unchanged.
 * `order` enforces `to >= from` when BOTH are present. The native <input type="date">
 * already emits ISO 'YYYY-MM-DD', so valid UI submissions are unaffected — this
 * rejects only malformed dates from direct API / integration callers.
 */
function validateDateFields(
  body: Record<string, unknown>,
  fields: readonly string[],
  order?: { from: string; to: string },
): string | null {
  for (const f of fields) {
    const v = body[f];
    if (v === undefined || v === null || v === '') continue;
    if (!isIsoDateString(v)) return `${f} must be an ISO date string (YYYY-MM-DD)`;
  }
  if (order) {
    const a = body[order.from];
    const b = body[order.to];
    if (a && b && isIsoDateString(a) && isIsoDateString(b) && Date.parse(b as string) < Date.parse(a as string)) {
      return `${order.to} must be on or after ${order.from}`;
    }
  }
  return null;
}

/** B10: keep utilization within [0, 100] and avoid float drift. */
function clampUtil(v: number): number {
  return Math.round(Math.max(0, Math.min(100, v)));
}

/**
 * B-CONCURRENCY: serialized critical section (per-process async mutex).
 *
 * Express handlers run concurrently and every repository call is awaited, so a
 * read-modify-write over a shared aggregate (a request's `staffedEffort`, a
 * resource's `utilization`, the invoice sequence) can interleave between its
 * `get()` and its `update()` — two concurrent writers both read the pre-state
 * and one increment is silently lost. There is no atomic-increment / FOR UPDATE
 * primitive on the `Repository<T>` boundary (it must serve both the in-memory
 * dev adapter and the Postgres adapter), so we serialize the whole
 * read-modify-write per logical key: each key holds a tail Promise and new work
 * chains onto it, guaranteeing strictly sequential execution per key while
 * different keys still run in parallel. Sufficient for the single-process Node
 * server; a multi-process deployment would additionally need a DB-level lock.
 */
const criticalSections = new Map<string, Promise<unknown>>();
function withLock<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const prev = criticalSections.get(key) ?? Promise.resolve();
  // Run `fn` only after any in-flight work on this key settles (success OR
  // failure), so one rejected section never wedges the key.
  const run = prev.then(fn, fn);
  // The stored tail must never reject (an unhandled rejection here would crash
  // the process and the next waiter would inherit it); swallow settlement state.
  criticalSections.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * S6: minimal in-memory fixed-window rate limiter (no external dependency).
 * `keyOf` selects the bucket key (defaults to the real client IP — correct only
 * once `trust proxy` is configured for the deployment); pass a constant to build
 * a single GLOBAL bucket that caps total throughput across all clients.
 */
function rateLimit(maxPerWindow: number, windowMs: number, keyOf: (req: Request) => string = req => req.ip || 'unknown') {
  const hits = new Map<string, { count: number; reset: number }>();
  let lastSweep = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    const now = Date.now();
    // S6 (memory growth): lazily evict expired entries so the map cannot grow
    // unbounded as new client IPs appear. Full sweep at most once per window;
    // the current key's stale entry is also cleared inline below.
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) {
        if (v.reset < now) hits.delete(k);
      }
      lastSweep = now;
    }
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      next();
      return;
    }
    if (entry.count >= maxPerWindow) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    entry.count++;
    next();
  };
}

let idSeq = 1000;
const newId = () => `${++idSeq}`;

// Re-export the pure id-suffix scanner (imported above) so it is also reachable
// from this module. It is defined in its own side-effect-free module so it can be
// unit-tested without importing this SSR server (which instantiates the Angular
// app engine at load). seedSequences uses the local binding directly.
export { maxIdSeq };

/**
 * Process-wide repositories (Postgres when DATABASE_URL is set, else in-memory).
 * Declared early so it is in scope for the audit middleware and the boot
 * sequence below.
 */
const repos = getRepositories();

/**
 * AUDIT INTEGRITY: the audit log is APPEND-ONLY — entries are created in
 * insertion order and are never edited or deleted. The READ endpoint
 * (`GET /audit-logs`) returns a bounded, newest-first page: on the Pg adapter the
 * ordering, LIMIT and OFFSET are pushed into SQL (backed by audit_logs_at_idx),
 * so the database read is bounded rather than a full SELECT *; the in-memory
 * adapter sorts newest-first and slices the same page.
 * For PUT/DELETE mutations we additionally capture which keys changed plus
 * before/after snapshots of just those keys.
 */
interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorRole: UserRole | 'unknown';
  method: string;
  path: string;
  statusCode: number;
  changedKeys?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}
/**
 * Registry mapping a collection segment (e.g. 'orders') to the READ side of its
 * repository, used by the audit middleware to snapshot an entity before/after a
 * mutation. Only `get()` is needed here. Resolved against `repos` (declared
 * above), so it always targets the live persistence adapter.
 */
interface AuditReadable { get(id: string): Promise<Entity | undefined> }
const auditRepoBySegment = new Map<string, AuditReadable>([
  ['resources', repos.resources], ['requests', repos.requests], ['assignments', repos.assignments],
  ['time-entries', repos.timeEntries], ['skill-catalogs', repos.skillCatalogs], ['proficiency-sets', repos.proficiencySets],
  ['skills', repos.skills], ['project-roles', repos.projectRoles], ['resource-organizations', repos.resourceOrganizations],
  ['countries', repos.countries], ['cities', repos.cities], ['industries', repos.industries],
  ['cost-categories', repos.costCategories], ['partner-roles', repos.partnerRoles], ['vendors', repos.vendors],
  ['projects', repos.projects], ['project-partners', repos.projectPartners], ['project-documents', repos.projectDocuments],
  ['work-packages', repos.workPackages], ['milestones', repos.milestones], ['project-financials', repos.projectFinancials],
  ['project-cost-centers', repos.projectCostCenters], ['project-tasks', repos.projectTasks], ['project-issues', repos.projectIssues],
  ['change-requests', repos.changeRequests], ['cost-centers', repos.costCenters], ['customers', repos.customers],
  ['contracts', repos.contracts], ['orders', repos.orders], ['order-lines', repos.orderLines],
  ['billing-plan-items', repos.billingPlanItems], ['approval-requests', repos.approvalRequests],
  // Time-phased allocation (B1). `assignment-days` has no REST path of its own
  // (mutated only via the /allocation endpoint, Task 6) — registering it here is
  // harmless (findAuditEntity is only ever consulted for paths the router
  // actually mounts) but keeps the map exhaustive over the Repositories surface.
  ['holidays', repos.holidays], ['planning-periods', repos.planningPeriods],
  ['assignment-days', repos.assignmentDays], ['assignment-months', repos.assignmentMonths],
]);

/**
 * Find the current entity targeted by a `/collection/:id` request path.
 *
 * Special-cases B3's nested per-month sub-resource shape
 * `/assignments/:id/months/:month/...` (the `note` PUT — `submit` is a POST,
 * which the audit middleware never before/after-snapshots): that handler
 * never touches the parent assignment, so resolving `segments[1]` against
 * `repos.assignments` (the generic path below) would diff an unchanged
 * assignment against itself and silently produce an empty `changedKeys`,
 * masking the actual mutation. Resolve against the assignmentMonths row
 * (composite id) instead.
 */
async function findAuditEntity(path: string): Promise<Entity | undefined> {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  if (segments[0] === 'assignments' && segments[2] === 'months' && segments.length >= 4) {
    return repos.assignmentMonths.get(monthRowId(segments[1], segments[3]));
  }
  const repo = auditRepoBySegment.get(segments[0]);
  return repo ? repo.get(segments[1]) : undefined;
}

/** Shallow clone of a plain entity for an immutable audit snapshot. */
function cloneEntity(entity: { id: string } | undefined): Record<string, unknown> | undefined {
  return entity ? JSON.parse(JSON.stringify(entity)) as Record<string, unknown> : undefined;
}

/** Diff before/after snapshots into the list of keys whose values changed. */
function diffChangedKeys(before?: Record<string, unknown>, after?: Record<string, unknown>): string[] {
  const keys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const changed: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k])) changed.push(k);
  }
  return changed;
}

type UserRole = 'employee' | 'pm' | 'resource-manager' | 'delivery-executive' | 'finance' | 'sales' | 'admin';

/**
 * Request-scoped, SERVER-VERIFIED principal.
 *
 * Populated by the async auth middleware ONLY when a valid `Authorization:
 * Bearer <token>` is presented (verified against Keycloak's JWKS). When set,
 * these win over the spoofable `X-User-*` demo headers everywhere downstream
 * (roleGate + audit actor derivation). Module augmentation keeps this strongly
 * typed without resorting to `any`.
 */
declare module 'express-serve-static-core' {
  interface Request {
    verifiedUserId?: string;
    verifiedRole?: UserRole | 'unknown';
  }
}

/**
 * Highest-privilege ordering for UserRole. When a Keycloak token carries
 * multiple realm roles we collapse them to the single most-privileged one,
 * mirroring the client. Higher index == more privilege.
 */
const ROLE_PRIORITY: readonly UserRole[] = ['employee', 'pm', 'resource-manager', 'sales', 'finance', 'delivery-executive', 'admin'];
const ALL_ROLES = new Set<string>(ROLE_PRIORITY);

/** Collapse a list of realm roles to the single highest-privilege UserRole. */
function highestRole(roles: readonly string[]): UserRole | 'unknown' {
  let best: UserRole | 'unknown' = 'unknown';
  let bestRank = -1;
  for (const r of roles) {
    if (!ALL_ROLES.has(r)) continue;
    const rank = ROLE_PRIORITY.indexOf(r as UserRole);
    if (rank > bestRank) { bestRank = rank; best = r as UserRole; }
  }
  return best;
}

// --- Keycloak / OIDC backend verification -----------------------------------

const OIDC_ISSUER = process.env['OIDC_ISSUER'] || 'http://localhost:8081/realms/psa';
/**
 * Expected token audience (`aud`) for THIS API — the resource/client id Keycloak
 * stamps on access tokens minted for us. When set, `jwtVerify` both requires the
 * `aud` claim and rejects tokens issued for a different audience, preventing a
 * token minted for another client in the same realm from being replayed here
 * (confused-deputy / cross-audience escalation). When unset, audience is not
 * checked (preserves the local-dev default and existing tests).
 */
const OIDC_AUDIENCE = process.env['OIDC_AUDIENCE'];
/**
 * Remote JWKS for the Keycloak realm. `createRemoteJWKSet` lazily fetches and
 * caches the signing keys (with cooldown + rotation handling) so each request
 * does not hit the network. Kept module-scoped so the cache is shared.
 */
const JWKS = createRemoteJWKSet(new URL(`${OIDC_ISSUER}/protocol/openid-connect/certs`));

/** Shape of the Keycloak claims we read; everything else on the token is ignored. */
interface KeycloakClaims extends JWTPayload {
  preferred_username?: string;
  realm_access?: { roles?: string[] };
}

/** Extract the bearer token from an Authorization header, or null if absent/malformed. */
function bearerToken(req: Request): string | null {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verify an incoming `Authorization: Bearer <token>` against the Keycloak realm
 * JWKS and issuer. Returns the verified principal, or null when there is NO
 * token. THROWS only on an INVALID token (so the caller can answer 401);
 * absence of a token is not an error (the demo header fallback still applies).
 *
 * Role is derived from realm_access.roles via the highest-privilege mapping;
 * userId prefers preferred_username, falling back to sub.
 */
async function verifyBearer(req: Request): Promise<{ userId: string; role: UserRole | 'unknown' } | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { payload } = await jwtVerify(token, JWKS, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE });
  const claims = payload as KeycloakClaims;
  const roles = Array.isArray(claims.realm_access?.roles) ? claims.realm_access.roles : [];
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const userId = (typeof claims.preferred_username === 'string' && claims.preferred_username) || sub || 'unknown';
  return { userId, role: highestRole(roles) };
}

const actorId = (req: Request) => req.verifiedUserId || String(req.header('X-User-Id') || 'system');
const actorRole = (req: Request): UserRole | 'unknown' =>
  req.verifiedRole ?? (String(req.header('X-User-Role') || 'unknown') as UserRole | 'unknown');

/**
 * TRUSTED actor id for the append-only audit trail — shared by the audit
 * middleware and any handler that writes its own explicit audit entry (e.g.
 * the allocation-decision hook). Same trust gate as `trustedRole`: a verified
 * JWT id always wins; the demo `X-User-Id` header is honored only when header
 * trust is explicitly opted in (`AUTH_TRUST_HEADERS=true`); otherwise 'unknown'.
 * Deliberately NOT the same as `actorId(req)` (which falls back to the raw
 * header regardless of `trustHeaders`, and to 'system' rather than 'unknown') —
 * see "AUDIT ATTRIBUTION INTEGRITY" on the audit middleware below.
 */
const auditActorId = (req: Request): string =>
  req.verifiedUserId ?? (trustHeaders ? (req.header('X-User-Id') || undefined) : undefined) ?? 'unknown';

/**
 * Resolve the request's actor to a RESOURCE id (the namespace time entries /
 * assignments key on), or undefined when it can't be mapped.
 *
 * `actorId(req)` is a User identity — under real OIDC it is the Keycloak
 * `preferred_username` or `sub`, while resources are keyed by their own ids
 * ('1','2',...). Comparing those two namespaces directly is always false, so a
 * SoD check like `actorId === existing.resourceId` is dead under JWT auth. We
 * map via the User directory: match the actor against a user's id OR name, and
 * return that user's `resourceId`. (In trusted-header demo mode the interceptor
 * already sends the mapped resourceId as X-User-Id, which also matches by id.)
 */
async function actorResourceId(req: Request): Promise<string | undefined> {
  const id = actorId(req);
  const user = (await repos.users.list()).find(u => u.id === id || u.name === id);
  return user?.resourceId ?? (id || undefined);
}

/**
 * !!! SECURITY (HIGH) — DEMO-ONLY IDENTITY !!!
 *
 * Authentication/authorization here is derived from the CLIENT-SUPPLIED
 * `X-User-Id` / `X-User-Role` request headers. These headers are trivially
 * spoofable: any caller can set `X-User-Role: admin` and bypass `roleGate`.
 *
 * This mechanism exists ONLY so the demo works on a developer's machine.
 * In production it MUST be replaced by a server-verified principal derived
 * from a signed session or validated JWT (i.e. identity the client cannot
 * forge). DO NOT ship header-based identity to any untrusted network.
 *
 * As a defence-in-depth guard, header trust requires an EXPLICIT opt-in via
 * AUTH_TRUST_HEADERS=true (dev-only). It is NEVER inferred from the bind host:
 * binding to 127.0.0.1 behind a reverse proxy is the normal production
 * topology, so the bind host says nothing about whether the connecting peer is
 * trusted. When headers are NOT trusted, every actor is treated as role
 * 'unknown', so privileged mutations are denied (403).
 */
const bindHost = (process.env['HOST'] || 'localhost').trim();
// DEV-ONLY opt-in. Do NOT enable in any environment reachable by untrusted
// clients (incl. behind a TLS-terminating reverse proxy on a loopback bind).
const trustHeaders = process.env['AUTH_TRUST_HEADERS'] === 'true';

/**
 * Server-trusted role for the request. A VERIFIED JWT role (set by the async
 * auth middleware) is always trusted. Otherwise this falls back to the demo
 * header role only when header trust is explicitly opted in, else 'unknown'.
 */
const trustedRole = (req: Request): UserRole | 'unknown' => {
  if (req.verifiedRole !== undefined) return req.verifiedRole;
  return trustHeaders ? actorRole(req) : 'unknown';
};

const canMutate = (role: UserRole | 'unknown', allowed: UserRole[]) => allowed.includes(role as UserRole);

/**
 * AUTH + AUTHORIZATION middleware (async).
 *
 * 1. Verify any `Authorization: Bearer <token>` against Keycloak's JWKS+issuer.
 *    - Valid token  -> stash the verified principal on the request; it wins over
 *      the demo X-User-* headers for both roleGate and audit actor derivation.
 *    - Invalid token -> respond 401 (do NOT silently fall back to headers).
 *    - No token      -> fall back to the demo X-User-* headers ONLY when header
 *      trust is explicitly opted in via AUTH_TRUST_HEADERS=true; otherwise the
 *      actor is treated as 'unknown' (privileged mutations denied).
 * 2. Apply the role gating to mutating (POST/PUT/DELETE) requests.
 *
 * Async because JWT verification is async; on unexpected errors we delegate to
 * Express via next(err). Handlers still return void.
 */
async function roleGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = await verifyBearer(req);
    if (principal) {
      req.verifiedUserId = principal.userId;
      req.verifiedRole = principal.role;
    }
  } catch {
    // A Bearer token was present but failed verification (bad signature,
    // wrong issuer, expired, ...). Reject rather than degrade to header trust.
    res.status(401).json({ error: 'Invalid or expired bearer token' });
    return;
  }

  const path = req.path;
  const role = trustedRole(req);

  // READ-SIDE AUTHORIZATION: GETs were previously served to anyone, leaking
  // sensitive data (the integrity/audit trail and the commercial/financial
  // collections). Require a recognised principal for those collections and
  // apply per-collection read RBAC. All other GETs stay open as before
  // (catalogs, projects, etc. — non-sensitive reference reads).
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const readRule = READ_RULES.find(r => r.test(path));
    if (readRule && !canMutate(role, readRule.roles)) {
      // 'unknown' means no verified JWT and no trusted header -> unauthenticated.
      res.status(role === 'unknown' ? 401 : 403).json({ error: `Role ${role} cannot read ${path}` });
      return;
    }
    next();
    return;
  }

  const rules: { test: (path: string) => boolean; roles: UserRole[] }[] = [
    { test: p => ['/customers', '/contracts', '/orders', '/order-lines', '/billing-plan-items'].some(prefix => p.startsWith(prefix)), roles: ['sales', 'finance', 'delivery-executive', 'admin'] },
    { test: p => ['/project-financials', '/project-cost-centers', '/cost-centers'].some(prefix => p.startsWith(prefix)), roles: ['finance', 'delivery-executive', 'admin'] },
    // Sensitive financial rates (costRate/billRate) live on resources; restrict who may rewrite them.
    { test: p => p.startsWith('/resources'), roles: ['resource-manager', 'delivery-executive', 'admin'] },
    // Rate cards (Phase E) define the DEFAULT cost/bill rates — sensitive financial
    // config. Mutations restricted to the finance-grade roles that own rates.
    { test: p => p.startsWith('/rate-cards'), roles: ['admin', 'delivery-executive', 'finance'] },
    // Global settings (hours-per-day) rescale every effective rate — finance-grade only.
    { test: p => p.startsWith('/settings'), roles: ['admin', 'delivery-executive', 'finance'] },
    // Time entries incl. approval. Self-approval is additionally blocked in the PUT handler (SoD).
    { test: p => p.startsWith('/time-entries'), roles: ['employee', 'pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
    { test: p => ['/assignments', '/requests'].some(prefix => p.startsWith(prefix)), roles: ['pm', 'resource-manager', 'delivery-executive', 'admin'] },
    { test: p => ['/projects', '/project-partners', '/project-documents', '/work-packages', '/milestones', '/project-tasks', '/project-issues', '/change-requests'].some(prefix => p.startsWith(prefix)), roles: ['pm', 'delivery-executive', 'admin'] },
    { test: p => ['/skill-catalogs', '/proficiency-sets', '/skills', '/project-roles', '/resource-organizations', '/languages'].some(prefix => p.startsWith(prefix)), roles: ['admin', 'delivery-executive'] },
    // Customizing catalogs (Phase F1): location/industry/cost-category/partner-role/
    // vendor master data — mutations restricted to admin/delivery-executive (reads
    // stay open like the other config catalogs). Holidays (B1) joins this group.
    { test: p => ['/countries', '/cities', '/industries', '/cost-categories', '/partner-roles', '/vendors', '/holidays'].some(prefix => p.startsWith(prefix)), roles: ['admin', 'delivery-executive'] },
    // Planning periods (B1) open/close a calendar month for time-phased booking —
    // admin-only mutation (stricter than the config-catalog rule above). Reads
    // stay open like the other config catalogs (no READ_RULE below), so the
    // Task-8 calendar (pm/resource-manager) can render open/closed months.
    { test: p => p.startsWith('/planning-periods'), roles: ['admin'] },
    { test: p => p.startsWith('/approval-requests'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
    // B3 batch month decisions run the SAME engine as /approval-requests, so the
    // coarse gate matches; the fine filter is the per-step approverId check.
    { test: p => p.startsWith('/allocation-approvals'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
    // C2: substituting a dummy is an approver action — the same roles that decide allocations.
    { test: p => p.startsWith('/assignment-months'), roles: ['resource-manager', 'delivery-executive', 'admin'] },
    // Integration actions (prepare CRM sync payloads, ...) mirror the read gate.
    { test: p => p.startsWith('/integrations'), roles: ['finance', 'delivery-executive', 'admin'] },
  ];

  const rule = rules.find(r => r.test(path));
  if (rule && !canMutate(role, rule.roles)) {
    res.status(403).json({ error: `Role ${role} cannot modify ${path}` });
    return;
  }
  next();
}

/**
 * READ-side RBAC rules. Only the genuinely sensitive collections are gated; the
 * rest of the GET surface stays open to any caller as before. A request whose
 * `trustedRole` is 'unknown' (no verified JWT and no trusted header) fails these
 * and is rejected with 401.
 *   - /audit-logs            -> the integrity/audit trail: admin/delivery-executive only.
 *   - commercial collections -> contracts/orders/billing/etc.: sales/finance/delivery-executive/admin.
 *   - financial-plan reads   -> project financials/cost centers: finance/delivery-executive/admin.
 *   - /resources, /users     -> expose confidential margin data (costRate/billRate)
 *                               and the user->role directory: management/finance/pm.
 *   - /approval-requests     -> governance queue: approver/finance-grade roles only.
 *   - /time-entries          -> the whole org's timesheets: any authenticated role.
 */
const READ_RULES: { test: (path: string) => boolean; roles: UserRole[] }[] = [
  { test: p => p.startsWith('/audit-logs'), roles: ['admin', 'delivery-executive'] },
  { test: p => ['/customers', '/contracts', '/orders', '/order-lines', '/billing-plan-items'].some(prefix => p.startsWith(prefix)), roles: ['sales', 'finance', 'delivery-executive', 'admin'] },
  // Internal budget/cost-center plans expose financial planning data and must
  // match their finance-grade mutation rule. Commercial users can still read
  // billing-plan items through the commercial rule above.
  { test: p => ['/project-financials', '/project-cost-centers', '/cost-centers'].some(prefix => p === prefix || p.startsWith(prefix + '/')), roles: ['finance', 'delivery-executive', 'admin'] },
  // costRate/billRate live on resources and the user directory carries role
  // mappings — both need-to-know. Mirror the resource WRITE sensitivity, plus pm
  // and finance who legitimately read staffing/margin.
  { test: p => p === '/resources' || p.startsWith('/resources/') || p.startsWith('/users'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // Rate cards expose cost rates (margin data): gate reads like /resources so the
  // resource form's "inherited default" placeholder can load for the staffing roles.
  { test: p => p === '/rate-cards' || p.startsWith('/rate-cards/'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // Staffing demand + bookings feed both the read-only schedule (resourcing
  // roles) and portfolio reporting (finance). Keep writes stricter via the
  // mutation rule; this is read-only access for finance.
  { test: p => ['/assignments', '/requests'].some(prefix => p === prefix || p.startsWith(prefix + '/')), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // Monthly FTE capacity/demand rollup (B2): a read-only computed view derived
  // from assignments/resources — same need-to-know as the staffing reads above.
  { test: p => p.startsWith('/capacity'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // B3 approval feed: the People Manager's month-by-month queue — approver-grade
  // roles only (stricter than /capacity, which is a read-only rollup).
  { test: p => p.startsWith('/allocation-approvals'), roles: ['resource-manager', 'delivery-executive', 'admin'] },
  // Timesheets for the whole org: require an authenticated principal (any role),
  // never served to an unauthenticated ('unknown') caller.
  { test: p => p.startsWith('/time-entries'), roles: ['employee', 'pm', 'resource-manager', 'delivery-executive', 'finance', 'sales', 'admin'] },
  // Approval requests contain requester, amount, SLA, and routed approver chain;
  // require the same coarse roles admitted to create/route/decide them.
  { test: p => p.startsWith('/approval-requests'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // Integration artifacts expose commercial/financial rollups (GL journal,
  // e-invoices, CRM payloads, BI financials): finance-grade readers only.
  { test: p => p.startsWith('/integrations'), roles: ['finance', 'delivery-executive', 'admin'] },
];

/**
 * Validate that any present, allow-listed numeric field is a non-negative
 * number. Returns the offending field name, or null if all are valid.
 * Used to stop negative/NaN monetary values entering the store.
 */
function findInvalidNumericField(
  body: Partial<Record<string, unknown>>,
  numericFields: readonly string[],
): string | null {
  for (const field of numericFields) {
    if (body[field] !== undefined && !isNonNegNumber(body[field])) return field;
  }
  return null;
}

/**
 * Generic hardened CRUD for a simple keyed-collection resource, now backed by a
 * `Repository<T>` (async). Mounts the SAME 4 endpoints with the SAME behaviour as
 * the prior array-backed helper — only the data access changed:
 *   - GET    `/${path}`     -> repo.list()
 *   - POST   `/${path}`     -> validate numerics, pick allow-list, repo.create()
 *                              (id server-assigned via newId(); 200 json item)
 *   - PUT    `/${path}/:id` -> 404 if missing, validate numerics, repo.update()
 *   - DELETE `/${path}/:id` -> repo.remove(); 404 when the id was absent,
 *                              else 204 (parity with the bespoke handlers)
 */
function crud<T extends { id: string }>(
  router: Router,
  path: string,
  repo: Repository<T>,
  allowed: readonly string[],
  numericFields: readonly string[] = [],
  // REFERENCE-DATA INTEGRITY hook: an optional async validator run on the picked
  // body for POST/PUT. Returns a 400-suitable error message (string) to reject, or
  // null to pass. Used to enforce FK/person-reference rules that the generic numeric
  // check cannot express (Phase D: person fields must reference the resources catalog).
  // `ctx.id` is the record's own id on PUT (undefined on POST) — lets a validator
  // exclude the record being edited from a uniqueness check (Phase E rate cards).
  validate?: (data: Record<string, unknown>, ctx?: { id?: string }) => Promise<string | null>,
) {
  router.get(`/${path}`, async (_req, res) => { res.json(await repo.list()); });
  router.post(`/${path}`, async (req, res) => {
    const data = pick(req.body, allowed);
    const bad = findInvalidNumericField(data, numericFields);
    if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
    if (validate) {
      const err = await validate(data as Record<string, unknown>);
      if (err) { res.status(400).json({ error: err }); return; }
    }
    const item = { id: newId(), ...data } as T;
    const created = await repo.create(item);
    res.json(created);
  });
  router.put(`/${path}/:id`, async (req, res) => {
    const existing = await repo.get(req.params.id);
    if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
    const data = pick(req.body, allowed);
    const bad = findInvalidNumericField(data, numericFields);
    if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
    if (validate) {
      const err = await validate(data as Record<string, unknown>, { id: req.params.id });
      if (err) { res.status(400).json({ error: err }); return; }
    }
    const updated = await repo.update(req.params.id, data as Partial<T>);
    res.json(updated);
  });
  router.delete(`/${path}/:id`, async (req, res) => {
    // AUDIT CORRECTNESS: honor remove()'s boolean so a DELETE of a non-existent
    // id 404s (parity with the bespoke handlers) instead of returning 204 and
    // recording a phantom DELETE audit entry (before/after both undefined).
    const removed = await repo.remove(req.params.id);
    if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
    res.status(204).send();
  });
}

// --- API Routes -------------------------------------------------------------
const apiRouter = express.Router();
// S6: two-tier limiting so one client cannot exhaust the whole budget and lock
// everyone else out. The per-client limiter keys on req.ip (the REAL client IP
// once TRUST_PROXY is configured for the deployment's proxy hop count); the
// global limiter caps total throughput regardless of source.
apiRouter.use(rateLimit(300, 60_000)); // 300 req/min per client (keyed on req.ip)
apiRouter.use(rateLimit(3000, 60_000, () => 'global')); // 3000 req/min overall
apiRouter.use(roleGate);
apiRouter.use((req, res, next) => {
  // AUDIT INTEGRITY: snapshot the targeted entity BEFORE the handler runs so a
  // PUT/DELETE can record a before/after diff. POST has no prior state. The
  // before-snapshot read is async (repository-backed), so the middleware body
  // runs in an async IIFE and only calls next() once the snapshot is taken.
  void (async () => {
    const before = ['PUT', 'DELETE'].includes(req.method) ? cloneEntity(await findAuditEntity(req.path)) : undefined;
    res.on('finish', () => {
      if (!['POST', 'PUT', 'DELETE'].includes(req.method) || res.statusCode >= 400) return;
      // The after-snapshot read + persistence are async; audit is best-effort,
      // so failures here never affect the already-sent response.
      void (async () => {
        const after = req.method === 'PUT' ? cloneEntity(await findAuditEntity(req.path)) : undefined;
        // AUDIT ATTRIBUTION INTEGRITY: record only TRUSTED identity. actorRole/
        // actorId must use the same trust gate as authorization (trustedRole),
        // never the raw spoofable X-User-* headers — otherwise an unauthenticated
        // caller could forge the recorded actor (e.g. role 'admin') in the
        // append-only forensics log even when header trust is disabled.
        const entry: AuditEntry = {
          id: `AL${newId()}`,
          at: new Date().toISOString(),
          actorId: auditActorId(req),
          actorRole: trustedRole(req),
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
        };
        if (req.method === 'PUT' || req.method === 'DELETE') {
          entry.before = before;
          entry.after = after;
          entry.changedKeys = diffChangedKeys(before, after);
        }
        // APPEND-ONLY: persist via the repository; entries are never edited.
        await repos.auditLogs.create(entry as unknown as AuditLog);
      })().catch(() => { /* audit is best-effort */ });
    });
    next();
  })().catch(() => next());
});

// --- Core resources (custom logic, hardened) --------------------------------

// NOTE (Phase E): costRate/billRate are NOT picked from the body — on read they
// are the RESOLVED effective rate (override ?? rate card). The per-resource
// OVERRIDE is written via costRateOverride/billRateOverride, which the handlers
// map onto the cost_rate/bill_rate columns (see applyRateOverrides).
const RESOURCE_FIELDS = ['name', 'role', 'skills', 'projectRoles', 'externalExperience', 'profilePicture', 'resume', 'capacity', 'managerId', 'organization', 'location', 'hireDate', 'terminationDate', 'kind', 'vendorId'] as const;

/**
 * Repository-backed equivalent of the array `exists()` helper: a value is a
 * valid FK iff it is a non-empty string AND a row with that id exists in the
 * target repository. Preserves the original string-guard semantics (a
 * non-string / empty id is never a valid reference) while reading through the
 * (seeded) persistence adapter, so it is correct regardless of conversion order.
 */
const existsRepo = async <T extends Entity>(repo: Repository<T>, id: unknown): Promise<boolean> =>
  typeof id === 'string' && id.length > 0 && (await repo.get(id)) !== undefined;

/**
 * REFERENCE-DATA INTEGRITY (Phase A): role fields are FKs to the /project-roles
 * config catalog by NAME (the stored value; backward-compatible with match-scoring
 * which compares role strings). Loads the current set of catalog role names.
 */
async function projectRoleNames(): Promise<Set<string>> {
  const roles = await repos.projectRoles.list();
  return new Set(roles.map(r => r.name));
}

/**
 * REFERENCE-DATA INTEGRITY (Phase B): `currency` is a config-value FK to the
 * /fx-rates catalog (the configured currency set, e.g. EUR/USD/GBP) by code.
 * Loads the current set of configured currency codes (uppercased to match the
 * stored rows). The base currency (EUR) is always a member.
 */
async function knownCurrencies(): Promise<Set<string>> {
  const rows = await repos.fxRates.list();
  return new Set(rows.map(r => String(r.currency).toUpperCase()));
}

/** True iff `code` is a configured currency (membership in the fx-rates set). */
async function isKnownCurrency(code: unknown): Promise<boolean> {
  if (typeof code !== 'string' || code.length === 0) return false;
  return (await knownCurrencies()).has(code.toUpperCase());
}

/**
 * Validate the `currency` field on a contract/order/billing body against the
 * fx-rates configured currency set. Returns a 400-suitable error message, or
 * null when valid. An omitted/undefined/empty currency passes (optional paths
 * — e.g. a PUT that doesn't touch currency — are not blocked); only a SUPPLIED
 * value is checked, and must be a configured code.
 */
async function validateCurrency(body: { currency?: unknown }): Promise<string | null> {
  const { currency } = body;
  if (currency === undefined || currency === null || currency === '') return null;
  if (!(await isKnownCurrency(currency))) {
    return `currency must be a configured currency (one of ${[...(await knownCurrencies())].sort().join(', ')})`;
  }
  return null;
}

/**
 * Validate the role references on a resource/request body against the project-roles
 * catalog (by name). Returns a 400-suitable error message, or null when valid.
 *   - `role` / `requiredRole`: when present (non-empty), must be a catalog name.
 *   - `projectRoles[]`: every entry must be a catalog name.
 * Omitted/undefined fields pass (so optional fields don't break create/edit), but a
 * supplied empty `projectRoles: []` is fine (no entries to check). Case-sensitive
 * match to the stored names, matching the in-app SELECT options.
 */
async function validateRoleRefs(
  body: { role?: unknown; requiredRole?: unknown; projectRoles?: unknown },
): Promise<string | null> {
  const names = await projectRoleNames();
  const roleVal = body.role ?? body.requiredRole;
  const roleField = body.role !== undefined ? 'role' : 'requiredRole';
  if (roleVal !== undefined && roleVal !== null && roleVal !== '') {
    if (typeof roleVal !== 'string' || !names.has(roleVal)) {
      return `${roleField} must reference an existing project role (catalog name)`;
    }
  }
  if (body.projectRoles !== undefined) {
    if (!Array.isArray(body.projectRoles)) {
      return 'projectRoles must be an array of project role names';
    }
    for (const pr of body.projectRoles) {
      if (typeof pr !== 'string' || !names.has(pr)) {
        return `projectRoles entry "${String(pr)}" must reference an existing project role (catalog name)`;
      }
    }
  }
  return null;
}

/**
 * REFERENCE-DATA INTEGRITY (Phase C): skill references are FKs to the /skills
 * catalog by NAME (the stored value on requests and resources). Loads the current
 * set of catalog skill names. Mirrors `projectRoleNames`.
 */
async function skillNames(): Promise<Set<string>> {
  const skills = await repos.skills.list();
  return new Set(skills.map(s => s.name));
}

/**
 * REFERENCE-DATA INTEGRITY (Phase C): a skill LEVEL is a config-value FK to the
 * proficiency-set levels (the configured proficiency scale), keyed by the level
 * NUMBER. Loads the set of valid level numbers across all proficiency sets so a
 * level coming from any configured set is accepted. Empty when no set defines
 * levels (in which case level validation is skipped to avoid blocking).
 */
async function proficiencyLevelNumbers(): Promise<Set<number>> {
  const sets = await repos.proficiencySets.list();
  const levels = new Set<number>();
  for (const set of sets) {
    for (const lvl of set.levels ?? []) {
      if (typeof lvl.level === 'number' && Number.isFinite(lvl.level)) levels.add(lvl.level);
    }
  }
  return levels;
}

/**
 * Validate the `skills` field on a resource/request body against the /skills
 * catalog (by name) and, for resources, the proficiency-set levels (by number).
 * Returns a 400-suitable error message naming the offending value, or null when
 * valid. Two shapes are accepted because the two entities store skills differently:
 *   - REQUEST  `skills: string[]`                  -> every entry must be a catalog name.
 *   - RESOURCE `skills: {name, level}[]`           -> every name must be a catalog
 *     name AND every level must be a configured proficiency level number.
 * Omitted/undefined `skills` passes (so partial edits never break), and an empty
 * array is fine (no entries to check). Case-sensitive match to the stored names,
 * matching the in-app SELECT options. Level checking is skipped when no proficiency
 * set defines any levels.
 */
async function validateSkillRefs(
  body: { skills?: unknown },
  shape: 'names' | 'objects',
): Promise<string | null> {
  if (body.skills === undefined) return null;
  if (!Array.isArray(body.skills)) {
    return 'skills must be an array';
  }
  const names = await skillNames();
  if (shape === 'names') {
    for (const s of body.skills) {
      if (typeof s !== 'string' || !names.has(s)) {
        return `skills entry "${String(s)}" must reference an existing skill (catalog name)`;
      }
    }
    return null;
  }
  // shape === 'objects' (resource skills): {name, level}
  const levels = await proficiencyLevelNumbers();
  for (const s of body.skills) {
    if (!s || typeof s !== 'object') {
      return 'each skill must be an object with a name and level';
    }
    const { name, level } = s as { name?: unknown; level?: unknown };
    if (typeof name !== 'string' || !names.has(name)) {
      return `skill "${String(name)}" must reference an existing skill (catalog name)`;
    }
    // Only enforce level membership when the proficiency scale defines levels.
    if (levels.size > 0 && !(typeof level === 'number' && levels.has(level))) {
      return `skill "${name}" level ${String(level)} must be a valid proficiency level (one of ${[...levels].sort((a, b) => a - b).join(', ')})`;
    }
  }
  return null;
}

/**
 * REFERENCE-DATA INTEGRITY (Phase D): person reference fields are FKs to the
 * /resources (people) catalog by NAME (the stored value; back-compatible with the
 * current display + match logic, and what the seeds use). Loads the current set of
 * resource names. Mirrors `projectRoleNames` / `skillNames`.
 */
async function resourceNames(): Promise<Set<string>> {
  const rows = await repos.resources.list();
  return new Set(rows.map(r => r.name));
}

/** The 'Unassigned' sentinel — the explicit empty state for an optional person field. */
const UNASSIGNED_PERSON = 'Unassigned';

/**
 * Validate the person-NAME reference fields on a body against the /resources catalog.
 * Each named field, when present (non-empty), must be a current resource name — or the
 * 'Unassigned' sentinel when `allowUnassigned` lists it (the explicit empty state for an
 * optional person field, e.g. a task assignee). Returns a 400-suitable error message
 * naming the offending field/value, or null when all supplied fields are valid.
 *
 * Omitted/undefined/empty('') fields PASS so partial edits and genuinely-optional
 * person fields are never blocked. Case-sensitive match to the stored names, matching
 * the in-app SELECT options. Loads the catalog once and checks every field against it.
 */
async function validatePersonRefs(
  body: Record<string, unknown>,
  fields: readonly string[],
  allowUnassigned: readonly string[] = [],
): Promise<string | null> {
  // Skip the catalog read entirely when no candidate field is even present.
  const present = fields.filter(f => body[f] !== undefined && body[f] !== null && body[f] !== '');
  if (present.length === 0) return null;
  const names = await resourceNames();
  const unassignedOk = new Set(allowUnassigned);
  for (const field of present) {
    const value = body[field];
    if (unassignedOk.has(field) && value === UNASSIGNED_PERSON) continue;
    if (typeof value !== 'string' || !names.has(value)) {
      return `${field} must reference an existing resource (person catalog name)`;
    }
  }
  return null;
}

// --- REFERENCE-DATA INTEGRITY (Phase F2): customizing-catalog FK validators -----
// Each consumer field below is a config-value FK to one of the F1 catalogs, stored
// by NAME (cities/industries/cost-categories/partner-roles/vendors/resource-orgs) or
// by CODE (countries). Every validator only checks a SUPPLIED non-empty value, so an
// omitted/empty field (optional path / partial edit) is never blocked; a supplied
// value must be a current catalog member. A small extra constant 'allow' set lets the
// caller permit sentinels (e.g. the 'Remote' location) without seeding a catalog row.

/** Load the set of catalog values produced by `select` from the repository rows. */
async function catalogValues<T extends Entity>(repo: Repository<T>, select: (row: T) => string): Promise<Set<string>> {
  const rows = await repo.list();
  return new Set(rows.map(select));
}

/** City names (the stored value on location fields). */
async function cityNames(): Promise<Set<string>> { return catalogValues(repos.cities, c => c.name); }
/** Country NAMES (the stored value on customer.country). */
async function countryNames(): Promise<Set<string>> { return catalogValues(repos.countries, c => c.name); }
/** Country CODES (the stored value on vendor.country — the natural key). */
async function countryCodes(): Promise<Set<string>> { return catalogValues(repos.countries, c => String((c as { code?: string }).code ?? c.id)); }
/** Industry names. */
async function industryNames(): Promise<Set<string>> { return catalogValues(repos.industries, i => i.name); }
/** Cost-category names. */
async function costCategoryNames(): Promise<Set<string>> { return catalogValues(repos.costCategories, c => c.name); }
/** Partner-role names. */
async function partnerRoleNames(): Promise<Set<string>> { return catalogValues(repos.partnerRoles, r => r.name); }
/** Vendor company names. */
async function vendorNames(): Promise<Set<string>> { return catalogValues(repos.vendors, v => v.name); }
/** Resource-organization names (the stored value on resource.organization). */
async function resourceOrganizationNames(): Promise<Set<string>> { return catalogValues(repos.resourceOrganizations, o => o.name); }
/** Cost-center ids (the configuration cost-centers catalog). */
async function costCenterIds(): Promise<Set<string>> { return catalogValues(repos.costCenters, c => c.id); }

/**
 * Validate a single supplied catalog-value FK field. Returns a 400-suitable error
 * message, or null when valid (or when the value is omitted/empty, or is in `allow`).
 */
async function validateCatalogValue(
  value: unknown,
  field: string,
  loadValues: () => Promise<Set<string>>,
  label: string,
  allow: readonly string[] = [],
): Promise<string | null> {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && allow.includes(value)) return null;
  const values = await loadValues();
  if (typeof value !== 'string' || !values.has(value)) {
    return `${field} must reference an existing ${label}`;
  }
  return null;
}

/** Allowed location sentinel (matches seed.REMOTE_LOCATION). */
const REMOTE_LOCATION = 'Remote';

/**
 * Validate a resource body's F2 catalog references: `location` -> cities (name) or
 * the 'Remote' sentinel, and `organization` -> resource-organizations (name). Both
 * are optional; only supplied non-empty values are checked.
 */
async function validateResourceCatalogRefs(body: { location?: unknown; organization?: unknown }): Promise<string | null> {
  const locErr = await validateCatalogValue(body.location, 'location', cityNames, 'city (location catalog name) or "Remote"', [REMOTE_LOCATION]);
  if (locErr) return locErr;
  return validateCatalogValue(body.organization, 'organization', resourceOrganizationNames, 'resource organization (catalog name)');
}

/**
 * Validate a resource-organization body's F2 references: `costCenters[]` -> the
 * configuration cost-centers catalog (by id), and `serviceOrganizationId` -> the
 * service-organizations catalog (by id). Both optional; only supplied values checked.
 */
async function validateResourceOrgRefs(body: { costCenters?: unknown; serviceOrganizationId?: unknown }): Promise<string | null> {
  // REVIEW ROUND 3 NOTE: the `!== null` below only skips THIS function's
  // array-shape/reference check when `costCenters` is null — it does NOT mean
  // `null` is an accepted value for `costCenters`. `costCenters` is a
  // `notNull()` column and `validateOrgTreeNode`'s REQUIRED_ORG_FIELDS loop
  // unconditionally rejects an explicit `null` for it (both POST and PUT call
  // that validator in the same request), so `null` never actually reaches
  // `update()`/`create()`. This clause is left as-is functionally — changing
  // it is unnecessary now that rejection happens elsewhere — but do not read
  // it as evidence `costCenters: null` is a supported value.
  if (body.costCenters !== undefined && body.costCenters !== null) {
    if (!Array.isArray(body.costCenters)) return 'costCenters must be an array of cost-center ids';
    if (body.costCenters.length > 0) {
      const ids = await costCenterIds();
      for (const cc of body.costCenters) {
        if (typeof cc !== 'string' || !ids.has(cc)) {
          return `costCenters entry "${String(cc)}" must reference an existing cost center (catalog id)`;
        }
      }
    }
  }
  if (body.serviceOrganizationId !== undefined && body.serviceOrganizationId !== null && body.serviceOrganizationId !== '') {
    if (!(await existsRepo(repos.serviceOrganizations, body.serviceOrganizationId))) {
      return 'serviceOrganizationId must reference an existing service organization';
    }
  }
  return null;
}

/**
 * REVIEW ROUND 3 — every `notNull()` column on `resource_organizations`
 * (`src/db/schema.ts`), declared ONCE so the required-field null-rejection in
 * `validateOrgTreeNode` below covers the class, not a hand-picked subset.
 * Round 2 fixed exactly `level` and `name`, having missed that `description`
 * and `costCenters` are equally `notNull` and sit in the SAME `pick()`
 * allow-lists, open to the identical primitive — the next `notNull` column
 * added to this catalog is covered the day it is added here, not the next
 * time someone finds a fifth case of the same bug.
 */
const REQUIRED_ORG_FIELDS = ['name', 'description', 'costCenters', 'level'] as const;

/**
 * D — org-tree integrity for a `/resource-organizations` body (design spec §2.1,
 * §2.4). Returns a 400-suitable message, or null when the body is acceptable.
 *
 * `ctx.id` is the record's own id on PUT (absent on POST): the name-uniqueness
 * check must exclude the record being edited, or renaming nothing would 400.
 *
 * Cycles are refused here, in WRITE. The read side is separately cycle-safe
 * (org-scope.util carries a visited set on every traversal) — both are needed:
 * this stops new cycles, that survives ones already in the data.
 */
async function validateOrgTreeNode(
  body: Partial<ResourceOrganization>,
  ctx?: { id?: string },
): Promise<string | null> {
  const all = await repos.resourceOrganizations.list();
  const nodes = all.map(n => ({ id: n.id, name: n.name, level: n.level, parentId: n.parentId, managerId: n.managerId }));
  const existing = ctx?.id === undefined ? undefined : all.find(n => n.id === ctx.id);

  // REVIEW ROUND 2/3 (critical) — every REQUIRED_ORG_FIELDS column is
  // `notNull()`, and `pick()` copies an explicit JSON `null` straight through
  // (it only filters `undefined`). A naive `body.level ?? existing?.level`
  // (and the equivalent for `name`) cannot tell "the client didn't touch this
  // field" from "the client sent null": `??` treats both as nullish and falls
  // back to the EXISTING value for every check below, so validation sees a
  // perfectly consistent row and passes — while the body's own field STILL
  // carries a literal `null` into the object handed to the repo. In-memory
  // `update()` then DELETES the key outright (repository.ts's
  // explicit-null-clears rule); Postgres issues `SET <col> = NULL` and raises
  // an unmapped NOT NULL violation (SQLSTATE 23502) as an opaque 500 — the two
  // adapters silently disagree (200 vs 500), and either way the row is
  // corrupted. Worse on POST: a `null` for a field with no `existing` fallback
  // resolves to `undefined` (skipping any check keyed on it, e.g. `name`'s
  // uniqueness check below), and the trailing `...body` spread in the POST
  // handler means an explicit `{costCenters: null}` OVERRIDES that handler's
  // own `costCenters: []` default — `create()` does no null-stripping at all,
  // so a literal `null` lands straight in the persisted row. And the `name`
  // corruption specifically can be CHAINED to defeat the delete guard: mask a
  // childless-but-referenced node's name to `undefined`, then `DELETE` — the
  // guard's `resources.some(r => r.organization === node.name)` no longer
  // matches the resource that used to reference it by its real name.
  //
  // This is a DIFFERENT rule from the nullable `parentId`/`managerId`, where
  // `''`/`null` legitimately mean "clear to absent" — every REQUIRED_ORG_FIELDS
  // column has no "absent" state to clear TO, so an explicit `null` for any of
  // them is simply invalid input, rejected in one loop before anything below
  // (the `??` fallbacks, `validateResourceOrgRefs`'s costCenters shape check,
  // the POST handler's spread) ever sees it.
  for (const field of REQUIRED_ORG_FIELDS) {
    if (body[field] === null) return `${field} is required and cannot be cleared`;
  }

  const level = (body.level ?? existing?.level) as OrgLevel | undefined;
  if (level !== undefined && !ORG_LEVELS.includes(level)) {
    return `level must be one of ${ORG_LEVELS.join(', ')}`;
  }
  // An empty string clears the parent (the clear-to-absent seam), so treat it as absent.
  const rawParent = body.parentId === undefined ? existing?.parentId : body.parentId;
  const parentId = rawParent === '' || rawParent === null ? undefined : rawParent;

  if (level === 'capability' && parentId !== undefined) return 'a capability is a root and cannot have a parent';
  if (level !== undefined && level !== 'capability') {
    if (parentId === undefined) return `a ${level} must have a parent`;
    const parent = all.find(n => n.id === parentId);
    if (parent === undefined) return 'parentId must reference an existing resource organization';
    const wanted = ORG_LEVELS[ORG_LEVELS.indexOf(level) - 1];
    if (parent.level !== wanted) return `the parent of a ${level} must be a ${wanted}`;
  }
  // DEFENCE IN DEPTH, not dead code: with the level rules above enforced (a
  // capability has no parent, a practice's parent must be a capability, a
  // competence's parent must be a practice), a cycle is structurally
  // UNREACHABLE through this API — closing one would require a capability to
  // sit beneath something, which the `level === 'capability'` guard above
  // already refuses first. There is deliberately no smoke check driving this
  // branch through the live API for that reason (see the note at check 6 in
  // scripts/smoke-api.mjs); `wouldCycleInOrgTree` itself is unit-tested
  // directly in org-scope.util.spec.ts. This guard earns its place anyway:
  // rows predating D (this feature) have no meaningful level — an admin can
  // hold, or later import, data whose levels are already inconsistent with
  // the parent chain, a state the level guard above was never designed to
  // catch (it only reasons about the level being written NOW). For such a
  // row, the level guard would not fire first, and this is the only thing
  // standing between an inconsistent write and a real cycle.
  if (ctx?.id !== undefined && wouldCycleInOrgTree(ctx.id, parentId, nodes)) {
    return 'parentId would close a cycle in the organizational tree';
  }
  const name = body.name ?? existing?.name;
  if (name !== undefined && all.some(n => n.name === name && n.id !== ctx?.id)) {
    return 'name must be unique across the whole organizational tree';
  }
  if (body.managerId !== undefined && body.managerId !== '') {
    const manager = await repos.resources.get(body.managerId);
    if (manager === undefined) return 'managerId must reference an existing resource';
  }
  return null;
}

/**
 * B-UTILIZATION: recompute a resource's utilization FROM THE SOURCE OF TRUTH
 * (the status-filtered sum of its assigned hours across all assignments) rather
 * than mutating a stored counter by deltas. `utilization` is the confirmed
 * aggregate (Allocated MONTHS only); `utilizationPlanned` is the planned
 * aggregate (Requested + Allocated months) — the two use different status
 * subsets via `monthlyAggregateHours` (B3: weighed per-day by the status of the
 * day's OWN month row, not the assignment's derived rollup), not one shared
 * total. Incremental ±contribution with a per-step round+clamp[0,100] is lossy:
 * a 100%→add→remove cycle permanently loses the over-100 magnitude, an
 * over-removal clamped at 0 destroys magnitude, and Math.round on every step
 * accumulates drift — so the stored number diverges from reality and saturates
 * irreversibly. We round/clamp only the final derived value here. MUST be
 * called inside `withLock('res:<id>')` so the read of all assignments + the
 * single write are serialized against concurrent changes.
 *
 * Writes a dual aggregate: `utilization` (confirmed — Allocated months only)
 * and `utilizationPlanned` (planned — Requested + Allocated months), via the
 * pure `monthlyAggregateHours` split.
 *
 * The `utilization_planned` column exists in Pg (migration `0008_big_speed.sql`),
 * so `utilizationPlanned` is persisted identically by both the in-memory and Pg
 * adapters.
 */
async function recomputeResourceUtilization(resourceId: string): Promise<void> {
  const resource = await repos.resources.get(resourceId);
  if (!resource) return;
  const rows = (await repos.assignments.list()).filter(a => a.resourceId === resourceId);
  const statusByRowId = await monthStatusByRowId();
  const assignmentIds = new Set(rows.map(a => a.id));
  const days = (await repos.assignmentDays.list()).filter(d => assignmentIds.has(d.assignmentId));
  const { confirmed, planned } = monthlyAggregateHours(days, statusByRowId);
  await repos.resources.update(resourceId, {
    utilization: clampUtil(utilizationContribution(confirmed, resource.capacity)),
    utilizationPlanned: clampUtil(utilizationContribution(planned, resource.capacity)),
  });
}

/**
 * Recompute a request's staffed-effort aggregates (+derived status) from the
 * FULL set of its assignments — the same "recompute from source of truth,
 * never a lossy running delta" discipline as `recomputeResourceUtilization`.
 * MUST be called inside `withLock('req:<id>')` so the read-all + single write
 * is serialized against concurrent assignment changes.
 *
 * Writes a dual aggregate: `staffedEffort` (confirmed — Allocated months only,
 * the basis `requestStatusFor` uses to derive Fulfilled/Open) and
 * `staffedEffortPlanned` (planned — Requested + Allocated months), via the
 * pure `monthlyAggregateHours` split (B3: per-day, weighed by the status of
 * the day's OWN month row).
 *
 * The `staffed_effort_planned` column exists in Pg (migration `0008_big_speed.sql`),
 * so `staffedEffortPlanned` is persisted identically by both the in-memory and Pg
 * adapters — same shape as the `utilizationPlanned` note above.
 */
async function recomputeRequestStaffing(requestId: string): Promise<void> {
  const request = await repos.requests.get(requestId);
  if (!request) return;
  const rows = (await repos.assignments.list()).filter(a => a.requestId === requestId);
  const statusByRowId = await monthStatusByRowId();
  const assignmentIds = new Set(rows.map(a => a.id));
  const days = (await repos.assignmentDays.list()).filter(d => assignmentIds.has(d.assignmentId));
  const { confirmed, planned } = monthlyAggregateHours(days, statusByRowId);
  await repos.requests.update(request.id, {
    staffedEffort: confirmed,
    staffedEffortPlanned: planned,
    status: requestStatusFor(request, confirmed),
  });
}

// ---------------------------------------------------------------------------
// ALLOCATION APPROVAL side-effects — open / withdraw the single-step approval
// that governs an assignment's Requested -> Allocated transition.
//
// CONCURRENCY: both are async reads/writes through the approvalRequests repo and
// touch NO res:/req: aggregate, so callers invoke them OUTSIDE any res:/req:
// lock (never nested inside a recompute critical section).
// ---------------------------------------------------------------------------

/** Snapshot of every month row's status, keyed by composite row id. Consumed by
 *  the status-weighted aggregates (`recomputeResourceUtilization`,
 *  `recomputeRequestStaffing`) via `monthlyAggregateHours`. */
async function monthStatusByRowId(): Promise<Map<string, MonthStatus>> {
  const rows = await repos.assignmentMonths.list();
  return new Map(rows.map(r => [r.id, r.status as MonthStatus]));
}

/**
 * Get (or lazily create as 'Draft') the month row for an assignment. The row is
 * created on the FIRST allocation write to that month, so a month with hours
 * always has a lifecycle state to carry.
 *
 * CONCURRENCY: get-then-create is a read-modify-write over a SHARED row, so it
 * runs inside `withLock('month:<rowId>')` — Express handlers interleave freely
 * across every `await`, and two concurrent first-writes to the same new month
 * used to both miss the `get` and both `create`: an unmapped `23505`
 * (unique_violation) 500 on Postgres, and a genuine DUPLICATE row in memory
 * (the in-memory adapter's `create` just pushes, it has no key constraint), after
 * which the approval feed emitted two items with the same `assignmentMonthId`.
 * The lock key is the ROW id, so different months never serialize against each
 * other. `month:` locks are only ever taken here and are never nested inside (or
 * around) a `res:`/`req:` section, so they cannot participate in a lock cycle.
 *
 * Belt-and-braces for a MULTI-PROCESS Postgres deployment (where the in-process
 * lock spans one process only): a failed `create` is re-`get` before rethrowing,
 * so losing the insert race still returns the winner's row instead of a 500.
 */
async function ensureAssignmentMonth(assignmentId: string, month: string): Promise<AssignmentMonth> {
  const id = monthRowId(assignmentId, month);
  return withLock(`month:${id}`, async () => {
    const existing = await repos.assignmentMonths.get(id);
    if (existing) return existing;
    try {
      return await repos.assignmentMonths.create({ id, assignmentId, month, status: 'Draft' } as AssignmentMonth);
    } catch (err) {
      const raced = await repos.assignmentMonths.get(id);
      if (raced) return raced;
      throw err;
    }
  });
}

/**
 * Recompute and persist `assignments.status` from its month rows. The column is
 * DERIVED (B3): no handler may write it from a client body — see the rollup rule
 * in allocation-month.util.
 */
async function refreshDerivedAssignmentStatus(assignmentId: string): Promise<void> {
  const rows = (await repos.assignmentMonths.list()).filter(r => r.assignmentId === assignmentId);
  const derived = deriveAssignmentStatus(rows.map(r => r.status as MonthStatus));
  await repos.assignments.update(assignmentId, { status: derived });
}

/** Open a single-step (resource-manager) approval for `assig` and return its id.
 *  `refId` defaults to the assignment id (legacy gap-A shape); B3 passes the
 *  month-row id so the decision governs ONE month. */
async function createAllocationApproval(req: Request, assig: Assignment, refId: string = assig.id): Promise<string> {
  const createdAt = new Date().toISOString();
  const request = await repos.requests.get(assig.requestId);
  const resource = await repos.resources.get(assig.resourceId);
  const ar: ApprovalRequestEntry = {
    id: `AR${newId()}`, kind: 'Allocation', refId, projectId: request?.projectId,
    requestedBy: actorId(req), status: 'Pending',
    steps: [allocationApproverStep(resource?.managerId)], currentStep: 0,
    createdAt, slaDueAt: slaDueFrom(createdAt),
  };
  const created = await repos.approvalRequests.create(ar as ApprovalRequest);
  return created.id;
}

/** Withdraw a still-Pending allocation approval (no-op when absent or already decided). */
async function withdrawAllocationApproval(approvalId: string | undefined, reason: string): Promise<void> {
  if (!approvalId) return;
  const ar = await repos.approvalRequests.get(approvalId);
  if (ar && ar.status === 'Pending') {
    await repos.approvalRequests.update(ar.id, { status: 'Rejected', note: reason } as Partial<ApprovalRequest>);
  }
}

/**
 * True iff the actor proposing an allocation IS the resource's own manager — the
 * self-managed AUTO-APPROVAL shortcut. Compared in resource-id space
 * (`resource.managerId` vs the actor's `actorResourceId`), mirroring the decision
 * endpoint's per-manager enforcement. Shared by the POST and PUT handlers.
 */
async function autoApprovesAllocation(req: Request, resourceId: string): Promise<boolean> {
  const resource = await repos.resources.get(resourceId);
  const proposerResourceId = await actorResourceId(req);
  return resource?.managerId !== undefined && resource.managerId === proposerResourceId;
}

// ---------------------------------------------------------------------------
// RATE CARDS (Phase E) — effective-rate resolution.
//
// A resource's stored cost_rate/bill_rate column is the OPTIONAL per-resource
// OVERRIDE. The EFFECTIVE rate that margin math consumes (finance.util, billing,
// match, the GL/e-invoice accrual) = override ?? the matching rate card. We
// resolve on READ so there is no snapshot to drift: editing a card updates every
// resource that hasn't overridden. Lookup: same role + base currency (EUR),
// preferring an org-specific card over the generic (no-org) one.
// ---------------------------------------------------------------------------
const RATE_BASE_CURRENCY = 'EUR';
const DEFAULT_HOURS_PER_DAY = 8;
/** The configured working hours/day (settings.hoursPerDay), default 8 if unset/invalid. */
async function getHoursPerDay(): Promise<number> {
  const row = await repos.settings.get('hoursPerDay');
  const n = row ? Number((row as { value?: unknown }).value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOURS_PER_DAY;
}
/**
 * C1: the 1-FTE-equivalent cap BEFORE the kind multiplier (`dailyCapFor`) is
 * applied — the stored `contractHoursPerDay` when it's a usable value
 * (finite, > 0), else the configured hours/day. Shared by the allocation
 * daily-capacity gate and the resources kind-change guard so the two
 * resolutions can never drift apart.
 */
async function resolveBaseCap(resource: { contractHoursPerDay?: number }): Promise<number> {
  const raw = resource.contractHoursPerDay;
  return (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) ? raw : await getHoursPerDay();
}
function pickRateCard(cards: RateCard[], role: string | undefined, organization: string | undefined): RateCard | undefined {
  if (!role) return undefined;
  const forRole = cards.filter(c => c.role === role && (c.currency ?? RATE_BASE_CURRENCY) === RATE_BASE_CURRENCY);
  return forRole.find(c => c.organization && c.organization === organization)
      ?? forRole.find(c => !c.organization);
}
/**
 * Resolve a resource's rates (hybrid day model). Rate cards + the per-resource
 * override (the cost_rate/bill_rate columns) are in €/DAY. This exposes:
 *   - costRateOverride/billRateOverride — the raw €/day override (for the form),
 *   - costRateDay/billRateDay           — the effective €/day (override ?? card),
 *   - costRate/billRate                 — the effective €/HOUR (= €/day ÷ hpd),
 *     which all margin math (finance.util, billing, match, accrual) consumes.
 */
function withEffectiveRates(r: Resource, cards: RateCard[], hpd: number): Resource {
  const card = pickRateCard(cards, r.role, r.organization);
  const costOverrideDay = r.costRate ?? null;
  const billOverrideDay = r.billRate ?? null;
  const costDay = costOverrideDay ?? card?.costRate;
  const billDay = billOverrideDay ?? card?.billRate;
  return {
    ...r,
    costRateOverride: costOverrideDay,
    billRateOverride: billOverrideDay,
    costRateDay: costDay,
    billRateDay: billDay,
    costRate: costDay != null ? costDay / hpd : undefined,
    billRate: billDay != null ? billDay / hpd : undefined,
  };
}
/** Resolve effective rates over a resource list (one shared rate-card + hpd fetch). */
async function resolveResourceRates(rows: Resource[]): Promise<Resource[]> {
  const cards = (await repos.rateCards.list()) as unknown as RateCard[];
  const hpd = await getHoursPerDay();
  return rows.map(r => withEffectiveRates(r, cards, hpd));
}
/**
 * Map the form's costRateOverride/billRateOverride onto the persisted cost_rate/
 * bill_rate columns. '' / null / undefined = clear the override (inherit the
 * card). Returns a 400-suitable error string for a non-numeric/negative override,
 * else null. Only fields PRESENT in the request body are touched, so partial PUTs
 * (e.g. a terminationDate-only edit) never disturb the stored rate.
 */
function applyRateOverrides(body: Partial<Resource>, reqBody: unknown): string | null {
  const src = (reqBody ?? {}) as Record<string, unknown>;
  for (const [field, col] of [['costRateOverride', 'costRate'], ['billRateOverride', 'billRate']] as const) {
    if (!(field in src)) continue;
    const v = src[field];
    if (v === null || v === undefined || v === '') { (body as Record<string, unknown>)[col] = null; continue; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `${field} must be a non-negative number, or empty to inherit the role's rate card`;
    (body as Record<string, unknown>)[col] = n;
  }
  return null;
}

/**
 * Validate the C1 kind/vendor pair. Returns a 400-suitable message, or null.
 * A subco MUST belong to a vendor; nobody else may carry one — an internal
 * person with a supplier attached is an incoherent record, not a harmless
 * extra field.
 */
async function validateResourceKind(kind: unknown, vendorId: unknown): Promise<string | null> {
  if (kind !== undefined && !isResourceKind(kind)) {
    return `kind must be one of ${RESOURCE_KINDS.join(', ')}`;
  }
  const effective = isResourceKind(kind) ? kind : 'internal';
  if (effective === 'subco') {
    if (typeof vendorId !== 'string' || vendorId === '') return 'a subco resource requires a vendorId';
    if (!(await existsRepo(repos.vendors, vendorId))) return 'vendorId must reference an existing vendor';
  } else if (vendorId !== undefined && vendorId !== null && vendorId !== '') {
    return `only a subco resource may carry a vendorId (kind is ${effective})`;
  }
  return null;
}

apiRouter.get('/resources', async (_req, res) => { res.json(await resolveResourceRates(await repos.resources.list())); });
apiRouter.get('/users', async (_req, res) => { res.json(await repos.users.list()); });
apiRouter.get('/resources/:id', async (req, res) => {
  const resource = await repos.resources.get(req.params.id);
  if (!resource) { res.status(404).json({ error: 'Not found' }); return; }
  const [resolved] = await resolveResourceRates([resource]);
  res.json(resolved);
});
// RESOURCE LIFECYCLE (creazione): onboard a new employee. RBAC is already gated to
// resource-manager/delivery-executive/admin by the existing /resources mutation
// rule in roleGate. capacity must be a positive number (it is the divisor in the
// utilization math) and hireDate (data di assunzione) is REQUIRED + ISO-parseable.
// utilization starts at 0 (derived server-side from assignments), id is server-set.
apiRouter.post('/resources', async (req, res) => {
  const body = pick<Resource>(req.body, RESOURCE_FIELDS);
  // D — hoisted so the cycle guard below can check a client-supplied
  // managerId against THIS resource's own about-to-be-assigned id, before it
  // exists anywhere else. Harmless to generate ahead of validation: newId()
  // only advances a counter (no persistence side effect), so a rejected POST
  // just leaves a gap in the sequence like any other validation failure
  // already does.
  const id = newId();
  // Phase E: map costRateOverride/billRateOverride onto the cost_rate/bill_rate
  // columns ('' / absent = inherit the role's rate card on read).
  const rateErr = applyRateOverrides(body, req.body);
  if (rateErr) { res.status(400).json({ error: rateErr }); return; }
  if (!(isNonNegNumber(body.capacity) && body.capacity > 0)) {
    res.status(400).json({ error: 'capacity must be a positive number' });
    return;
  }
  if (!isIsoDateString(body.hireDate)) {
    res.status(400).json({ error: 'hireDate is required and must be an ISO date string' });
    return;
  }
  if (body.terminationDate !== undefined && body.terminationDate !== null && body.terminationDate !== '') {
    if (!isIsoDateString(body.terminationDate)) {
      res.status(400).json({ error: 'terminationDate must be an ISO date string' });
      return;
    }
    if (Date.parse(body.terminationDate) < Date.parse(body.hireDate)) {
      res.status(400).json({ error: 'terminationDate must be on or after hireDate' });
      return;
    }
  }
  // REFERENCE-DATA INTEGRITY: role / projectRoles[] must reference the catalog.
  const roleErr = await validateRoleRefs(body);
  if (roleErr) { res.status(400).json({ error: roleErr }); return; }
  // REFERENCE-DATA INTEGRITY (Phase C): skills[].name must be a catalog skill and
  // skills[].level must be a configured proficiency level.
  const skillErr = await validateSkillRefs(body, 'objects');
  if (skillErr) { res.status(400).json({ error: skillErr }); return; }
  // REFERENCE-DATA INTEGRITY (Phase F2): location -> cities/Remote, organization ->
  // resource-organizations. Optional; only supplied values are checked.
  const catalogErr = await validateResourceCatalogRefs(body);
  if (catalogErr) { res.status(400).json({ error: catalogErr }); return; }
  // D — the tail of this handler (kind/vendorId validation + defaulting, item
  // construction, and the actual `create()`) is IDENTICAL whether or not
  // `managerId` is being set. Factored into a closure so it can run either
  // directly (no manager is being set — the common case, no extra locking
  // cost) or nested inside the 'org-chart' lock below (one IS being set) —
  // same pattern as the PUT handler's `finishPut`.
  const finishPost = async (): Promise<{ status?: number; error?: string; created?: Resource }> => {
    // C1: kind must be one of the known values, and only a subco may carry a
    // vendorId (and must carry one). Pin the default so downstream reads never
    // see kind absent.
    const kindErr = await validateResourceKind(body.kind, body.vendorId);
    if (kindErr) return { status: 400, error: kindErr };
    if (body.kind === undefined) body.kind = 'internal';
    // A non-subco '' or null vendorId already passed validation
    // (validateResourceKind treats both like absent) but must never be PERSISTED
    // verbatim — normalize to undefined so the field is genuinely absent. Use
    // undefined (not null) here: the in-memory adapter's create() has no
    // null-stripping step (that only exists on update()), so a literal null
    // would leak into every later read of this row, unlike Postgres where the
    // column is NULL and nullsToUndefined() hands it back absent — undefined is
    // the one value both adapters agree means "don't set this column" on create.
    // `pick()` copies an explicit null straight through, so it has to be caught
    // here alongside '': this normalization IS the adapter parity.
    if (body.vendorId === '' || body.vendorId === null) body.vendorId = undefined;
    // D (review round 1) — the SAME normalization for managerId, and NOT an
    // edge case: the resources form's `save()`
    // (src/app/resources/resources.component.ts ~line 709) sends
    // `managerId: raw.managerId ?? ''` on EVERY create, so an ordinary
    // "onboard someone with no People Manager" is the common path, not a rare
    // one. Left unnormalized, '' would persist as a literal empty string
    // (same in-memory create()-has-no-null-stripping reasoning as vendorId
    // above) — and `reportsClosure`/`scopedApproversOf`
    // (src/app/services/org-scope.util.ts) both gate on `managerId ===
    // undefined`, so a stored '' silently slips past them, seeding a phantom
    // key in the closure map instead of being ignored. `undefined`, not
    // `null`, for the identical adapter-parity reason as vendorId.
    if (body.managerId === '' || body.managerId === null) body.managerId = undefined;
    const item = {
      skills: [], projectRoles: [], externalExperience: [],
      ...body,
      id, // D — hoisted above (see comment there); NOT a fresh newId() call.
      utilization: 0,
    } as Resource;
    return { created: await repos.resources.create(item) };
  };
  // D (review round 1, CRITICAL) — see the matching comment at the PUT
  // handler's `org-chart` lock for the full rationale (two concurrent writers
  // racing the SAME read-check-write can each pass a check that reasons from
  // a stale snapshot). The scenario here is narrower than PUT-vs-PUT — a
  // brand-new resource still cannot be named by any OTHER concurrent writer
  // (its id doesn't exist until `create()` runs, inside this very lock), so
  // the only thing a race could still slip past is two POSTs mutually
  // guessing each other's about-to-be-assigned id — but the lock is taken
  // unconditionally here anyway, for the same reason the ruling gave for
  // PUT: it is a single global key, reassignments (including onboarding with
  // a manager) are rare/human-scale, and reasoning about ONE consistent rule
  // ("any mutation of the manager chain is serialized under 'org-chart'") is
  // worth more than reasoning about which handler's race is "narrow enough"
  // to skip it. Only paid when a manager is actually being set — a POST
  // with no managerId never touches this lock at all.
  const result = body.managerId !== undefined
    ? await withLock('org-chart', async (): Promise<{ status?: number; error?: string; created?: Resource }> => {
        const effectiveManagerId = (body.managerId === '' || body.managerId === null) ? undefined : body.managerId;
        const all = await repos.resources.list();
        if (wouldCycleInOrgChart(id, effectiveManagerId, all)) {
          return { status: 400, error: 'managerId would close a cycle in the org chart' };
        }
        return finishPost();
      })
    : await finishPost();
  if (result.error !== undefined) { res.status(result.status ?? 400).json({ error: result.error }); return; }
  // Resolve effective rates so the create response matches the GET shape (Phase E).
  const [resolved] = await resolveResourceRates([result.created as Resource]);
  res.status(201).json(resolved);
});
apiRouter.put('/resources/:id', async (req, res) => {
  // Preflight snapshot: it answers the 404 and supplies the stored hireDate for
  // the terminationDate ordering rule. It is deliberately NOT the basis of the
  // kind/vendorId merge or the daily-cap guard below — those re-read the row
  // inside the res: lock, because they are a read-modify-write and this read is
  // not (see the TOCTOU note there).
  const preflight = await repos.resources.get(req.params.id);
  if (preflight === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<Resource>(req.body, RESOURCE_FIELDS);
  // Phase E: map any supplied costRateOverride/billRateOverride onto the columns
  // ('' clears the override → inherit; absent leaves the stored rate untouched).
  const rateErr = applyRateOverrides(body, req.body);
  if (rateErr) { res.status(400).json({ error: rateErr }); return; }
  // B-DATA: capacity is a divisor in utilization math; never allow 0/negative/NaN.
  if (body.capacity !== undefined && !(isNonNegNumber(body.capacity) && body.capacity > 0)) {
    res.status(400).json({ error: 'capacity must be a positive number' });
    return;
  }
  // RESOURCE LIFECYCLE (cessazione/modifica): terminationDate is the logical-
  // deletion marker. Clearing it (null/'') reactivates and is always allowed.
  // When set, it must be ISO-parseable and on or after the effective hireDate
  // (the incoming one if hireDate is also being changed, else the stored one).
  if (body.terminationDate !== undefined && body.terminationDate !== null && body.terminationDate !== '') {
    if (!isIsoDateString(body.terminationDate)) {
      res.status(400).json({ error: 'terminationDate must be an ISO date string' });
      return;
    }
    const effectiveHire = body.hireDate ?? preflight.hireDate;
    if (isIsoDateString(effectiveHire) && Date.parse(body.terminationDate) < Date.parse(effectiveHire)) {
      res.status(400).json({ error: 'terminationDate must be on or after hireDate' });
      return;
    }
  }
  // REFERENCE-DATA INTEGRITY: validate any supplied role / projectRoles[] against
  // the catalog. Omitted fields pass, so partial edits (e.g. a terminationDate-only
  // PUT) are never blocked.
  const roleErr = await validateRoleRefs(body);
  if (roleErr) { res.status(400).json({ error: roleErr }); return; }
  // REFERENCE-DATA INTEGRITY (Phase C): validate any supplied skills[] against the
  // catalog (name) + proficiency-set levels (level). Omitted passes.
  const skillErr = await validateSkillRefs(body, 'objects');
  if (skillErr) { res.status(400).json({ error: skillErr }); return; }
  // REFERENCE-DATA INTEGRITY (Phase F2): validate any supplied location/organization.
  const catalogErr = await validateResourceCatalogRefs(body);
  if (catalogErr) { res.status(400).json({ error: catalogErr }); return; }
  // D — a cycle in the org chart would make every scope computation for these
  // people meaningless (org-scope.util's scopeOf/reportsClosure), and
  // `managerId` is a free field of the resource form — one careless edit away
  // from closing one. The read side is separately cycle-safe (every
  // traversal there carries its own visited set), so this guard exists only
  // to stop NEW cycles from being written, not to protect reads from ones
  // that already exist (seeded resource '1' already self-manages — see
  // src/db/seed.ts — and reads of it are unaffected either way).
  //
  // THREE managerId INPUTS, three different meanings — pick() forwards an
  // explicit JSON null unchanged (it only filters `undefined`), so all three
  // must be told apart, same lesson as the D task 3 name/level guard:
  //   - absent -> leave the manager untouched, no cycle check runs.
  //   - ''     -> the established clear-to-absent sentinel (the UI has no way
  //               to author a literal null). Normalized to a real `null`
  //               below so it clears identically on both adapters
  //               (src/db/repository.ts: an explicit null in an update patch
  //               clears a nullable column, undefined leaves it untouched) —
  //               the same translation already done for vendorId a few lines
  //               below and the org-tree node's own managerId (PUT
  //               /resource-organizations/:id, further down this file).
  //   - null   -> managerId is a NULLABLE column (no notNull guard, unlike
  //               task 3's name/level), so — unlike those fields — a literal
  //               null here is already a legitimate "clear to absent" with no
  //               help needed. Treated exactly like '' for this check: neither
  //               can ever close a cycle (a cleared manager has no manager to
  //               loop back through).
  //
  // D (review round 1, CRITICAL) — see the `org-chart` lock acquisition below
  // for why the read-check-write cannot be split from the write anymore: two
  // concurrent PUTs (A -> B and B -> A) each reading the pre-race chain would
  // both pass this check and commit under DIFFERENT `res:<id>` keys (`res:A`,
  // `res:B`, which never contend), writing the exact cycle this guard exists
  // to refuse. The tail of this handler (kind/vendorId validation, the daily-
  // cap TOCTOU, and the actual write) is IDENTICAL whether or not `managerId`
  // is being touched — factored into `finishPut` so it can run either
  // directly (no manager change — the common case, no extra locking cost) or
  // nested inside `org-chart` below (one IS being attempted).
  const finishPut = (): Promise<{ status?: number; error?: string; updated?: Resource }> => withLock(`res:${req.params.id}`, async () => {
    // C1: validate the MERGED kind/vendorId state, not the body in isolation —
    // a partial PUT that changes only one of the two fields must still produce
    // a coherent pair (e.g. a kind-only PUT to 'subco' is rejected when the
    // stored row has no vendor, and a vendorId-only PUT is rejected when the
    // stored kind isn't 'subco'). When the effective kind is no longer 'subco'
    // and the caller did not touch vendorId, the stale stored vendor is cleared
    // with an explicit null (which means "clear to absent" on both adapters)
    // rather than rejected or silently carried forward — a PUT that moves a
    // resource away from being a subco must not leave an orphaned vendor behind.
    // An empty-string vendorId is a clear request, exactly like an explicit
    // null (same '' === clear convention as applyRateOverrides above) — never
    // persist a literal ''. Normalize before computing the merge so it's
    // treated as "supplied" (a real clear), not silently dropped back to the
    // stale stored value the way `'' ?? current.vendorId` would.
    //
    // Then: narrowing a kind (dummy/subco -> internal) shrinks the daily ceiling
    // by MULTI_FTE_MAX. Refuse if that would strand existing bookings above the
    // new cap rather than silently leaving invalid allocations behind. baseCap is
    // resolved exactly like the allocation handler's gate (resolveBaseCap: stored
    // contractHoursPerDay, guarded against 0/NaN/negative, else getHoursPerDay()).
    //
    // TOCTOU: ALL of it — the read of the stored row, the merge, both caps, the
    // assignment-day re-check and the write — happens inside ONE res: lock, the
    // same discipline the allocation handler's own res: critical section (below)
    // uses. Two concurrent PUTs that each read the pre-state would otherwise
    // reason from the same snapshot and could persist exactly the incoherent
    // kind/vendor pair (or the over-cap narrowing) this block exists to prevent;
    // a concurrent PUT .../allocation could equally book hours in between.
    const current = await repos.resources.get(req.params.id);
    if (current === undefined) return { status: 404, error: 'Not found' };
    if (body.vendorId === '') body.vendorId = null as unknown as undefined;
    const mergedKind = body.kind ?? current.kind;
    const vendorSupplied = body.vendorId !== undefined;
    let mergedVendorId: string | null | undefined = vendorSupplied ? body.vendorId : current.vendorId;
    if (!vendorSupplied && mergedKind !== 'subco' && current.vendorId !== undefined) {
      body.vendorId = null as unknown as undefined;
      mergedVendorId = null;
    }
    const kindErr = await validateResourceKind(mergedKind, mergedVendorId);
    if (kindErr) return { status: 400, error: kindErr };

    const baseCap = await resolveBaseCap(current);
    const currentCap = dailyCapFor(kindOf(current), baseCap);
    const newCap = dailyCapFor(kindOf({ kind: mergedKind }), baseCap);
    if (newCap < currentCap) {
      const ids = new Set((await repos.assignments.list()).filter(a => a.resourceId === current.id).map(a => a.id));
      const byDate = sumHoursByDate((await repos.assignmentDays.list()).filter(d => ids.has(d.assignmentId)));
      const offender = Object.keys(byDate).sort().find(day => exceedsDailyCapacity(byDate[day], newCap));
      if (offender !== undefined) {
        return { status: 400, error: `changing kind to ${mergedKind} would exceed the daily capacity on ${offender}` };
      }
    }
    return { updated: await repos.resources.update(req.params.id, body) };
  });
  // D (review round 1, CRITICAL) — a SINGLE global lock key, not a per-pair
  // `withLock` (the pattern used elsewhere in this file for exactly-two-known-
  // resources operations, e.g. the retarget handler below): three or more
  // concurrent PUTs can compose an arbitrarily long cycle (A -> B, B -> C,
  // C -> A), and no pair of per-target locks serializes that — only a single
  // key that EVERY manager-chain mutation contends on does. Cheap in
  // practice: manager reassignments are rare, human-scale operations (a
  // reorg, an onboarding), so serializing all of them costs nothing real.
  //
  // LOCK ORDER, stated explicitly because `withLock` is not re-entrant and
  // this handler already takes `res:<id>` inside `finishPut`: `org-chart` is
  // acquired OUTERMOST here, `res:<id>` nested inside it (via `finishPut()`
  // called from within this callback) — never the reverse. No `res:` lock is
  // held at the point `org-chart` is acquired (this call site is the entire
  // body of the handler from the top; nothing above it takes a lock). As long
  // as no code path anywhere in this file acquires `org-chart` from INSIDE a
  // `res:` section, this ordering is globally deadlock-free — confirmed by
  // inspection: `org-chart` is acquired at exactly two call sites in this
  // file (here and the POST handler above), both at the top level of their
  // handler, neither nested inside any other `withLock` callback.
  //
  // Freshly re-reads the resource list INSIDE this lock (not the stale one a
  // caller might have read earlier) — that fresh read is what makes the fix
  // correct: whichever request's critical section runs first commits its
  // write before the next one's `list()` call executes, so the second
  // request's check always reasons about the FIRST request's already-applied
  // change, closing the race the finding described. See the task report for
  // why this is asserted correct by construction rather than by a timing-
  // based test (the smoke suite is a single sequential client and cannot
  // express real concurrency; `withLock` itself is a private, non-exported
  // closure in this file with no existing unit coverage at any other call
  // site either).
  const locked = body.managerId !== undefined
    ? await withLock('org-chart', async (): Promise<{ status?: number; error?: string; updated?: Resource }> => {
        if (body.managerId === '') body.managerId = null as unknown as undefined;
        const effectiveManagerId = body.managerId === null ? undefined : body.managerId;
        const all = await repos.resources.list();
        if (wouldCycleInOrgChart(req.params.id, effectiveManagerId, all)) {
          return { status: 400, error: 'managerId would close a cycle in the org chart' };
        }
        return finishPut();
      })
    : await finishPut();
  if (locked.error !== undefined) { res.status(locked.status ?? 400).json({ error: locked.error }); return; }
  const [resolved] = await resolveResourceRates([locked.updated as Resource]);
  res.json(resolved);
});

const REQUEST_FIELDS = ['name', 'requiredRole', 'requiredEffort', 'skills', 'description', 'startDate', 'endDate', 'status', 'requesterId', 'projectId'] as const;

apiRouter.get('/requests', async (_req, res) => { res.json(await repos.requests.list()); });
apiRouter.post('/requests', async (req, res) => {
  const body = pick<ResourceRequest>(req.body, REQUEST_FIELDS);
  // B-STAFFING: requiredEffort is REQUIRED and must be positive. The Fulfilled
  // status is server-derived as `staffedEffort >= requiredEffort`; an absent
  // (undefined) requiredEffort makes that comparison always false so the request
  // can NEVER be Fulfilled, and a 0 makes it Fulfilled with zero staffing. Reject
  // both, mirroring the resource `capacity` guard.
  if (!(isNonNegNumber(body.requiredEffort) && body.requiredEffort > 0)) {
    res.status(400).json({ error: 'requiredEffort must be a positive number' });
    return;
  }
  // REFERENCE-DATA INTEGRITY: requiredRole must reference the project-roles catalog
  // by name (the value match-scoring compares against).
  const roleErr = await validateRoleRefs(body);
  if (roleErr) { res.status(400).json({ error: roleErr }); return; }
  // REFERENCE-DATA INTEGRITY (Phase C): every skills[] entry must be a catalog skill name.
  const skillErr = await validateSkillRefs(body, 'names');
  if (skillErr) { res.status(400).json({ error: skillErr }); return; }
  // Phase G: startDate/endDate must be ISO (they feed schedule conflict detection).
  const dateErr = validateDateFields(body as Record<string, unknown>, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' });
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const newReq = { id: newId(), staffedEffort: 0, ...body, status: 'Not Published' } as ResourceRequest;
  const created = await repos.requests.create(newReq);
  res.json(created);
});
// B-DATA: client-settable request statuses are limited to the publish/withdraw
// lifecycle. 'Fulfilled' is server-derived from assignment staffing and must
// never be supplied by the client.
const CLIENT_REQUEST_STATUSES = ['Not Published', 'Published', 'Open', 'Withdrawn'] as const;
apiRouter.put('/requests/:id', async (req, res) => {
  const existing = await repos.requests.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ResourceRequest>(req.body, REQUEST_FIELDS);
  if (body.requiredEffort !== undefined && !isNonNegNumber(body.requiredEffort)) {
    { res.status(400).json({ error: 'requiredEffort must be a non-negative number' }); return; }
  }
  if (body.status !== undefined && !(CLIENT_REQUEST_STATUSES as readonly string[]).includes(body.status)) {
    res.status(400).json({ error: `status must be one of: ${CLIENT_REQUEST_STATUSES.join(', ')}` });
    return;
  }
  // REFERENCE-DATA INTEGRITY: validate any supplied requiredRole against the catalog.
  const roleErr = await validateRoleRefs(body);
  if (roleErr) { res.status(400).json({ error: roleErr }); return; }
  // REFERENCE-DATA INTEGRITY (Phase C): validate any supplied skills[] against the catalog.
  const skillErr = await validateSkillRefs(body, 'names');
  if (skillErr) { res.status(400).json({ error: skillErr }); return; }
  // Phase G: validate any supplied start/end date (ISO + end >= start).
  const dateErr = validateDateFields(body as Record<string, unknown>, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' });
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const updated = await repos.requests.update(req.params.id, body);
  res.json(updated);
});
apiRouter.delete('/requests/:id', async (req, res) => {
  const removed = await repos.requests.remove(req.params.id);
  if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(204).send();
});

apiRouter.get('/assignments', async (_req, res) => { res.json(await repos.assignments.list()); });
apiRouter.post('/assignments', async (req, res) => {
  // B3: the lifecycle lives on the month rows; a client may not seed a status.
  if ((req.body as { status?: unknown } | undefined)?.status !== undefined) {
    res.status(400).json({ error: 'status is derived from the per-month allocation and cannot be set on an assignment' });
    return;
  }
  const body = pick<Assignment>(req.body, ['requestId', 'resourceId', 'assignedHours', 'startDate', 'endDate', 'allocationPct']);
  if (!isNonNegNumber(body.assignedHours)) {
    { res.status(400).json({ error: 'assignedHours must be a non-negative number' }); return; }
  }
  // Resource Schedule: validate the optional booking window + allocation (no-op when omitted).
  const scheduleErr = validateAssignmentSchedule(body);
  if (scheduleErr) { res.status(400).json({ error: scheduleErr }); return; }
  // B-DATA: an assignment must reference an existing request and resource.
  if (!(await existsRepo(repos.requests, body.requestId))) { res.status(400).json({ error: 'requestId must reference an existing request' }); return; }
  if (!(await existsRepo(repos.resources, body.resourceId))) { res.status(400).json({ error: 'resourceId must reference an existing resource' }); return; }

  // B3: assignment status is DERIVED from its month rows (deriveAssignmentStatus)
  // — never set directly here. A brand-new assignment has no month rows yet, so
  // it starts 'Draft' (the same value deriveAssignmentStatus([]) returns). The
  // lifecycle (submit for approval, self-managed auto-approve, etc.) is now
  // driven exclusively by the per-month endpoints (PUT .../allocation,
  // POST .../months/:month/submit) once hours are booked into a month.
  const created = await repos.assignments.create({ id: newId(), ...body, status: 'Draft' } as Assignment);

  // B-CONCURRENCY + B-UTILIZATION: recompute BOTH aggregates from the full set of
  // assignments (never a lossy running delta). Sequential per-key locks.
  await withLock(`res:${created.resourceId}`, () => recomputeResourceUtilization(created.resourceId));
  await withLock(`req:${created.requestId}`, () => recomputeRequestStaffing(created.requestId));
  res.json(await repos.assignments.get(created.id));
});
apiRouter.put('/assignments/:id', async (req, res) => {
  const oldAssig = await repos.assignments.get(req.params.id);
  if (oldAssig === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  // B3: the lifecycle lives on the month rows; a client may not seed a status.
  if ((req.body as { status?: unknown } | undefined)?.status !== undefined) {
    res.status(400).json({ error: 'status is derived from the per-month allocation and cannot be set on an assignment' });
    return;
  }
  const body = pick<Assignment>(req.body, ['requestId', 'resourceId', 'assignedHours', 'startDate', 'endDate', 'allocationPct']);
  if (body.assignedHours !== undefined && !isNonNegNumber(body.assignedHours)) {
    { res.status(400).json({ error: 'assignedHours must be a non-negative number' }); return; }
  }
  // Resource Schedule: validate the booking window + allocation against the MERGED
  // state, so a partial update (e.g. only endDate) is still checked end >= start.
  const scheduleErr = validateAssignmentSchedule({
    startDate: body.startDate ?? oldAssig.startDate,
    endDate: body.endDate ?? oldAssig.endDate,
    allocationPct: body.allocationPct ?? oldAssig.allocationPct,
  });
  if (scheduleErr) { res.status(400).json({ error: scheduleErr }); return; }
  // B-DATA: when the FK targets change, the new targets must exist.
  if (body.resourceId !== undefined && body.resourceId !== oldAssig.resourceId && !(await existsRepo(repos.resources, body.resourceId))) {
    res.status(400).json({ error: 'resourceId must reference an existing resource' });
    return;
  }
  if (body.requestId !== undefined && body.requestId !== oldAssig.requestId && !(await existsRepo(repos.requests, body.requestId))) {
    res.status(400).json({ error: 'requestId must reference an existing request' });
    return;
  }

  // B3: status is DERIVED from the month rows — this PUT never writes `status`
  // or `approvalId` on the assignment itself (both are now owned by the
  // per-month endpoints and their approval side-effects). Persist the
  // FK/hours/schedule patch first.
  await repos.assignments.update(req.params.id, body);

  // RETARGET PROPAGATION (B3): a resource retarget invalidates the governance
  // of every month row carrying a LIVE commitment — a 'Requested' row's
  // pending approval names the OLD resource's manager as approver, and an
  // 'Allocated' row is a commitment the OLD resource made. Re-baseline each
  // one against the NEW resource, mirroring what a fresh submit would do:
  // withdraw any pending approval, then either auto-approve (self-managed)
  // straight back to 'Allocated' with no approval, or open a fresh
  // 'Requested' approval routed to the NEW resource's manager. 'Draft' rows
  // are untouched — they carry no approval and nothing has been promised
  // about them. 'Rejected' rows are ALSO untouched, deliberately, and for a
  // different reason: a rejection is a closed conversation, not a live
  // commitment, and sweeping it in here would silently
  // resubmit (or, on the self-managed branch, auto-approve) a month no
  // planner ever asked to reopen; any stale approvalId it carries is left
  // exactly as is, never withdrawn. Also deliberately absent: a
  // planning-period (open/closed) gate — unlike a voluntary submit, a
  // retarget corrects WHO does already-planned work, not how many hours are
  // booked, so a closed month must not block fixing the assignee. Pass the
  // MERGED assignment (old fields + this body's new resourceId/requestId),
  // never the stale `oldAssig`, to `createAllocationApproval` — it resolves
  // the routing manager and the request's project FROM the assignment object
  // it's given, so a stale resourceId would route the fresh approval to the
  // OLD resource's manager, reproducing the exact bug this closes. The
  // self-managed check is hoisted out of the loop: the answer (is the
  // proposer the NEW resource's manager?) cannot change between month rows of
  // the same retarget. This is approval-repo I/O + month-row writes only,
  // done OUTSIDE any res:/req: lock and never nested inside an aggregate
  // critical section (mirrors every other approval side-effect in this
  // file); the aggregate recomputes below stay LAST so they read the
  // post-retarget statuses.
  if (body.resourceId !== undefined && body.resourceId !== oldAssig.resourceId) {
    const mergedAssig = { ...oldAssig, ...body, id: oldAssig.id } as Assignment;
    const selfManaged = await autoApprovesAllocation(req, body.resourceId);
    const monthRows = (await repos.assignmentMonths.list())
      .filter(m => m.assignmentId === oldAssig.id && (m.status === 'Allocated' || m.status === 'Requested'));
    for (const row of monthRows) {
      await withdrawAllocationApproval(row.approvalId, 'resource retargeted');
      if (selfManaged) {
        // `null`, not `undefined`: clears approvalId to absent on both
        // adapters (Task 4's seam fix) — see the submit handler above for the
        // full rationale on this cast.
        await repos.assignmentMonths.update(row.id, { status: 'Allocated', approvalId: null as unknown as undefined });
        // C2 — THE SELF-MANAGED BRANCH IS AN IMPLICIT APPROVAL, so it owes the
        // same give-back an explicit one does. The month lands 'Allocated' with
        // NO approval, which means no decision will ever follow to close a
        // substitution this row is still carrying: without this, the back-link
        // dangles forever (the calendar keeps claiming "taken over from a
        // placeholder" on a month that is not pending anything) and, worse, any
        // hours the new assignee does NOT cover stay quietly off the dummy —
        // booked demand destroyed with no record. Clearing the two columns alone
        // would fix the cosmetic half and keep the silent loss, so reuse
        // `returnHoursToDummy` (which closes the link itself, in its own
        // `finally`) rather than reimplementing the per-day arithmetic.
        //
        // 'Approved', not 'Rejected': the retarget confirms the work, it does not
        // refuse it. Per day that means `moved - min(moved, held)` goes home — the
        // part the assignee no longer covers because the month was trimmed — and
        // `planGiveBack` leaves her own rows untouched (`targetHours` is empty on
        // an approval, since what she holds IS the allocation).
        //
        // `mergedAssig`, NOT `oldAssig`: the day rows travel with the assignment,
        // so the `res:` lock must name the NEW resource. Both `res:` locks are
        // acquired inside `returnHoursToDummy`, in lexicographic id order; this
        // loop holds NO lock of its own (see the block comment above — approval
        // I/O and month-row writes only), so the non-re-entrant `withLock` has
        // nothing to nest inside and cannot wedge a `res:` key.
        //
        // BEST-EFFORT and logged, exactly as in `applyAllocationDecision`: the
        // retarget above has already committed, so a give-back failure must never
        // turn it into a 500 — but it must never vanish silently either.
        if (row.replacedFromAssignmentMonthId !== undefined) {
          try {
            await returnHoursToDummy(req, row, mergedAssig, 'Approved');
          } catch (err) {
            console.error(`PUT /assignments/${oldAssig.id}: substitution give-back failed for month ${row.id} on retarget:`, err);
          }
        }
      } else {
        const approvalId = await createAllocationApproval(req, mergedAssig, row.id);
        await repos.assignmentMonths.update(row.id, { status: 'Requested', approvalId } as Partial<AssignmentMonth>);
      }
    }
  }

  await refreshDerivedAssignmentStatus(req.params.id);

  const newResourceId = body.resourceId ?? oldAssig.resourceId;
  const newRequestId = body.requestId ?? oldAssig.requestId;
  const resourceChanged = newResourceId !== oldAssig.resourceId;
  const requestChanged = newRequestId !== oldAssig.requestId;

  // B-UTILIZATION + B-STAFFING: recompute BOTH aggregates from the full set of
  // assignments (the source of truth) for every affected resource/request — no
  // lossy running delta. On an FK retarget BOTH old and new are recomputed.
  // Sequential per-key locks, never nested; res: before req: (fixed lock order).
  if (resourceChanged) {
    await withLock(`res:${oldAssig.resourceId}`, () => recomputeResourceUtilization(oldAssig.resourceId));
    await withLock(`res:${newResourceId}`, () => recomputeResourceUtilization(newResourceId));
  } else {
    await withLock(`res:${newResourceId}`, () => recomputeResourceUtilization(newResourceId));
  }
  if (requestChanged) {
    await withLock(`req:${oldAssig.requestId}`, () => recomputeRequestStaffing(oldAssig.requestId));
    await withLock(`req:${newRequestId}`, () => recomputeRequestStaffing(newRequestId));
  } else {
    await withLock(`req:${newRequestId}`, () => recomputeRequestStaffing(newRequestId));
  }
  res.json(await repos.assignments.get(req.params.id));
});
apiRouter.delete('/assignments/:id', async (req, res) => {
  const oldAssig = await repos.assignments.get(req.params.id);
  if (oldAssig === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  // Supersede any pending approval BEFORE removing the assignment (outside the
  // res:/req: locks) so a deleted assignment never leaves an orphaned approval.
  await withdrawAllocationApproval(oldAssig.approvalId, 'assignment deleted');

  // C2 — SEND A PENDING SUBSTITUTION'S HOURS HOME BEFORE THIS DELETE DESTROYS
  // THEM. Those hours were taken off a DUMMY and are only on loan to this
  // assignment until its month is decided; the delete means no decision will ever
  // come and the assignee covers nothing, which is a REJECTION in every respect
  // that matters — so every recorded hour goes back, per day, not just the part a
  // trim released. Before C2 a delete could only ever destroy hours booked on the
  // assignment being deleted; without this it silently destroys another
  // resource's booked demand, and the request's staffed effort drops with no
  // record anywhere of where the hours went.
  //
  // The INVERSE case is already handled and stays that way: deleting the DUMMY's
  // assignment removes the linked month row, and the give-back on the person's
  // eventual decision finds it gone and logs a no-op — which is exactly why
  // `replacedFromAssignmentMonthId` is a soft reference and not a self-FK.
  //
  // ORDERING is load-bearing: this runs BEFORE the day rows and month rows below
  // are removed, so `planGiveBack` reads what is genuinely still held and the
  // link-clearing write lands on a row that still exists. Lock discipline matches
  // the retarget branch — `returnHoursToDummy` takes both `res:` locks itself, in
  // lexicographic id order, and this handler holds none until the aggregate
  // recomputes at the very end. Best-effort per month and logged: the delete must
  // still proceed (a wedged assignment nobody can remove would be worse), but a
  // failed give-back must leave a trace.
  const linkedMonths = (await repos.assignmentMonths.list())
    .filter(m => m.assignmentId === oldAssig.id && m.replacedFromAssignmentMonthId !== undefined);
  for (const row of linkedMonths) {
    try {
      await returnHoursToDummy(req, row, oldAssig, 'Rejected');
    } catch (err) {
      console.error(`DELETE /assignments/${oldAssig.id}: substitution give-back failed for month ${row.id}:`, err);
    }
  }

  // B1 (dev↔prod parity): assignment_days → assignments is ON DELETE no action,
  // so drop THIS assignment's per-day rows FIRST — otherwise Postgres rejects the
  // parent delete with an FK violation (→ 409) and the in-memory adapter would
  // orphan the rows. Cleaned up in the handler (not via a DB cascade) so both
  // adapters behave identically.
  const daysToRemove = (await repos.assignmentDays.list()).filter(d => d.assignmentId === req.params.id);
  for (const d of daysToRemove) await repos.assignmentDays.remove(d.id);
  // B3: withdraw each month's pending approval and drop the month rows before
  // the parent delete (assignment_months -> assignments is ON DELETE no action,
  // so Postgres would otherwise reject the parent delete with an FK violation).
  const monthRows = (await repos.assignmentMonths.list()).filter(m => m.assignmentId === oldAssig.id);
  for (const m of monthRows) {
    await withdrawAllocationApproval(m.approvalId, 'assignment deleted');
    await repos.assignmentMonths.remove(m.id);
  }
  await repos.assignments.remove(req.params.id);

  // B-CONCURRENCY + B-UTILIZATION + B-STAFFING: recompute BOTH aggregates from the
  // remaining assignments (never a lossy running delta). Sequential per-key locks.
  await withLock(`res:${oldAssig.resourceId}`, () => recomputeResourceUtilization(oldAssig.resourceId));
  await withLock(`req:${oldAssig.requestId}`, () => recomputeRequestStaffing(oldAssig.requestId));
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// TIME-PHASED ALLOCATION (B1, Task 5) — bulk per-month day editing for a single
// assignment. RBAC is already covered by the existing '/assignments' mutation
// rule + READ_RULE (roleGate matches on the '/assignments/' prefix), so no new
// rule is needed. The path pattern '/assignments/:id/allocation' does not
// collide with '/assignments/:id' ( :id never matches across a '/' ).
// ---------------------------------------------------------------------------

/**
 * Rewrite `assignments.assignedHours` from the FULL set of its remaining day
 * rows — the per-day breakdown is the source of truth once any month has been
 * edited through the day-level endpoints (a legacy assignment carrying an
 * assignedHours total but no day rows is intentionally reduced to the sum of
 * its days once touched here — not a bug). Extracted from the allocation PUT
 * below (it used to inline this sum) so the substitution transfer (C2, next to
 * this section) can recompute BOTH the dummy's and the target's totals through
 * the one function rather than a second hand-written sum.
 */
async function recomputeAssignedHours(assignmentId: string): Promise<void> {
  const remaining = (await repos.assignmentDays.list()).filter(d => d.assignmentId === assignmentId);
  const total = remaining.reduce((s, d) => s + (Number.isFinite(d.hours) ? d.hours : 0), 0);
  await repos.assignments.update(assignmentId, { assignedHours: Math.round(total * 100) / 100 });
}

// READ: the assignment's per-day rows whose month is in [from,to], plus the
// effective contract hours/day. Range defaults to the assignment's spanned months.
apiRouter.get('/assignments/:id/allocation', async (req, res) => {
  const assig = await repos.assignments.get(req.params.id);
  if (assig === undefined) { res.status(404).json({ error: 'Not found' }); return; }

  const allDays = (await repos.assignmentDays.list()).filter(d => d.assignmentId === assig.id);
  const spanned = allDays.map(d => monthOf(d.date)).sort();

  const monthParam = (name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === 'string' && /^\d{4}-\d{2}$/.test(v) ? v : undefined;
  };
  const from = monthParam('from') ?? spanned[0];
  const to = monthParam('to') ?? spanned[spanned.length - 1];

  const days = (from !== undefined && to !== undefined)
    ? allDays.filter(d => { const m = monthOf(d.date); return m >= from && m <= to; })
             .sort((a, b) => a.date.localeCompare(b.date))
    : [];

  const resource = await repos.resources.get(assig.resourceId);
  // resolveBaseCap, not `?? getHoursPerDay()`: a stored contractHoursPerDay of
  // 0 / NaN / negative is not a usable cap, and this value is load-bearing on
  // the client — it seeds the calendar's dailyCap(), the per-day over-capacity
  // hint and the FTE fill. Reporting a broken base here would make the screen
  // disagree with the write gate, which resolves the very same way.
  const contractHoursPerDay = await resolveBaseCap(resource ?? {});
  // C1: the calendar cannot decide whether to offer the multi-FTE selector (or
  // widen its per-day capacity hint) without knowing the resource's kind.
  const resourceKind = kindOf(resource);

  const months = (await repos.assignmentMonths.list())
    .filter(m => m.assignmentId === assig.id && (from === undefined || m.month >= from) && (to === undefined || m.month <= to))
    .sort((a, b) => a.month.localeCompare(b.month));
  res.json({ assignmentId: assig.id, from, to, contractHoursPerDay, resourceKind, months, days });
});

// WRITE: replace ONE month's per-day hours in a single call. Gates: open-month,
// working-day, daily-capacity. Then (ordering is load-bearing, gap-A discipline):
//   1. withLock('res:<id>'): TOCTOU capacity re-check → replace the month's day
//      rows → write assignedHours = Σ of ALL remaining day rows.
//   2. OUTSIDE any res:/req: lock: forced re-approval, SCOPED TO THE EDITED MONTH
//      (approval-repo I/O + the month row's status write) — never nested in an
//      aggregate lock. Trigger = the edited month's OWN prior status was
//      'Allocated' (its days changed by definition), NOT a delta; sibling months
//      are untouched. `assignments.status` is then recomputed as a DERIVED
//      rollup of all its months (B3) — never written directly here.
//   3. FINAL: recompute the status-aware resource/request aggregates AFTER the
//      status change, so confirmed/planned totals reflect the new status.
apiRouter.put('/assignments/:id/allocation', async (req, res) => {
  const assig = await repos.assignments.get(req.params.id);
  if (assig === undefined) { res.status(404).json({ error: 'Not found' }); return; }

  const body = pick<{ month: string; dailyHours: Record<string, number> }>(req.body, ['month', 'dailyHours']);
  const month = body.month;
  // Range-checked YYYY-MM (month 01–12): a bare \d{2} would admit '2026-13'/'2026-00'.
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'month must match YYYY-MM' }); return;
  }
  const daily = body.dailyHours;
  if (daily === undefined || typeof daily !== 'object' || daily === null || Array.isArray(daily)) {
    res.status(400).json({ error: 'dailyHours must be an object of YYYY-MM-DD -> hours' }); return;
  }
  // Every entry: an ISO day key, a finite hours value >= 0, and its month MUST
  // equal `month` (a cross-month key would silently escape the per-month replace).
  for (const [day, value] of Object.entries(daily as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { res.status(400).json({ error: `invalid date key ${day}` }); return; }
    // Syntax alone is not enough: '2026-05-32'/'2026-05-00' are Invalid Dates
    // (would slip past the working-day gate as NaN), and '2026-04-31' silently
    // ROLLS OVER to May 1 (aliasing the real row → daily-capacity bypass). A
    // round-trip through Date rejects both: reconstruct the ISO day and require
    // it to equal the key verbatim.
    const dt = new Date(day + 'T00:00:00Z');
    if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== day) {
      res.status(400).json({ error: `invalid calendar date ${day}` }); return;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      res.status(400).json({ error: `hours for ${day} must be a finite number >= 0` }); return;
    }
    if (monthOf(day) !== month) { res.status(400).json({ error: `date ${day} is not in month ${month}` }); return; }
  }

  // Open-month gate: only a planning period explicitly 'Open' accepts edits.
  const period = await repos.planningPeriods.get(month);
  if (period?.status !== 'Open') { res.status(403).json({ error: 'month is not open for planning' }); return; }

  const resource = await repos.resources.get(assig.resourceId);
  if (resource === undefined) { res.status(400).json({ error: 'assignment references a missing resource' }); return; }

  // Working-day gate: any day carrying hours must be a weekday and not a holiday.
  const holidaysSet = new Set((await repos.holidays.list()).map(h => h.id));
  for (const [day, value] of Object.entries(daily)) {
    if (value > 0 && !isWorkingDay(day, holidaysSet)) { res.status(400).json({ error: `${day} is not a working day` }); return; }
  }

  // Daily-capacity gate. assignmentDays carry assignmentId (not resourceId), so
  // gather this resource's OTHER assignment ids, sum their day-hours on the
  // affected dates, and check other+new against the effective per-day cap.
  // resolveBaseCap guards the cap exactly like getHoursPerDay does: a stored
  // contractHoursPerDay of 0 / NaN / negative is NOT a usable cap (0 would
  // reject every booking with hours; NaN would silently disable the check —
  // `total > NaN + 1e-9` is always false), so it falls back to the configured
  // hours/day.
  const baseCap = await resolveBaseCap(resource);
  // C1: dummy and subco represent capacity that a single person does not cover,
  // so their daily ceiling is MULTI_FTE_MAX times the one-FTE base. Internal
  // resources keep the 1-FTE cap (manual §3.2.3).
  const cap = dailyCapFor(kindOf(resource), baseCap);
  const requestedDates = new Set(Object.keys(daily));
  const capExceeded = (day: string): string => `daily capacity exceeded on ${day}`;
  const capacityOffender = async (): Promise<string | undefined> => {
    const otherIds = new Set(
      (await repos.assignments.list()).filter(a => a.resourceId === resource.id && a.id !== assig.id).map(a => a.id));
    const otherByDate = sumHoursByDate(
      (await repos.assignmentDays.list()).filter(d => otherIds.has(d.assignmentId) && requestedDates.has(d.date)));
    for (const day of requestedDates) {
      // Booking 0 hours can never over-allocate — skip it, so a pre-existing
      // over-allocation by OTHER assignments on that day doesn't 400 a no-op entry.
      if (!(daily[day] > 0)) continue;
      if (exceedsDailyCapacity((otherByDate[day] ?? 0) + daily[day], cap)) return day;
    }
    return undefined;
  };
  const preOffender = await capacityOffender();
  if (preOffender !== undefined) { res.status(400).json({ error: capExceeded(preOffender) }); return; }

  // The lifecycle state of the month being written, read BEFORE the replace.
  const monthRow = await ensureAssignmentMonth(assig.id, month);
  const priorMonthStatus = monthRow.status as MonthStatus;
  // STEP 1 — inside res: lock: TOCTOU re-check, then replace the month's day rows
  // and rewrite assignedHours from the full remaining day set (source of truth).
  const replaced = await withLock(`res:${resource.id}`, async (): Promise<{ offender?: string }> => {
    const offender = await capacityOffender();
    if (offender !== undefined) return { offender };

    const existing = (await repos.assignmentDays.list())
      .filter(d => d.assignmentId === assig.id && monthOf(d.date) === month);
    for (const d of existing) await repos.assignmentDays.remove(d.id);
    // Composite id `${assignmentId}:${date}` (same scheme as the seed —
    // assignmentDays is intentionally excluded from seedSequences, so NEVER newId()).
    for (const day of requestedDates) {
      const hours = daily[day];
      if (hours > 0) {
        await repos.assignmentDays.create({ id: `${assig.id}:${day}`, assignmentId: assig.id, date: day, hours } as AssignmentDay);
      }
    }
    // The per-day breakdown is now the source of truth for assignedHours (see
    // recomputeAssignedHours above).
    await recomputeAssignedHours(assig.id);
    return {};
  });
  if (replaced.offender !== undefined) { res.status(400).json({ error: capExceeded(replaced.offender) }); return; }

  // STEP 2 — OUTSIDE any res:/req: lock: forced re-approval, scoped to THIS month.
  // Trigger is the month's PRIOR status 'Allocated' (its days changed by
  // definition), not an assignedHours delta. Self-managed → stays Allocated with
  // no approval; otherwise supersede this month's approval and open a fresh one.
  // A still-'Requested' month keeps its pending approval (the approver re-reads
  // the days); Draft/Rejected have no approval effect. Months OTHER than the one
  // written are untouched — that is the whole point of B3.
  //
  // SERIALIZED on `month:<rowId>`. read `approvalId` -> withdraw -> create ->
  // write is a read-modify-write over one shared row, and re-reading alone only
  // NARROWS the window: two near-simultaneous day-edits of the same Allocated
  // month can still both read the same id, both open a fresh approval, and leave
  // the loser's orphaned and Pending. The lock is the same `month:` namespace
  // `ensureAssignmentMonth` uses, taken here sequentially (that call has long
  // since returned), never nested.
  //
  // This does NOT break the handler's documented ordering: the rule is that
  // STEP 2 runs outside any `res:`/`req:` lock — it must never hold an aggregate
  // lock across approval I/O — and `month:` is a different namespace keyed on a
  // single row. `month:` locks are taken in exactly two places (here and
  // `ensureAssignmentMonth`), neither of which is nested inside a `res:`/`req:`/
  // `approval:` section, so no lock cycle is reachable.
  await withLock(`month:${monthRow.id}`, async () => {
    if (priorMonthStatus !== 'Allocated' || await autoApprovesAllocation(req, resource.id)) return;
    // RE-READ the row here rather than reusing the `monthRow` snapshot taken
    // before STEP 1's lock: `approvalId` is shared mutable state, and STEP 1
    // spans several awaits during which a CONCURRENT edit of the same month may
    // already have superseded the approval and written a new id. Withdrawing
    // the STALE id would cancel an approval that no longer governs anything
    // while leaving the CURRENT one Pending and orphaned — a manager could
    // still decide it, applying a decision to days nobody approved. `status` is
    // deliberately NOT re-read: `priorMonthStatus` is this writer's own
    // observation that the month WAS approved when its days changed, which is
    // what the forced re-approval is a consequence of.
    const currentRow = await repos.assignmentMonths.get(monthRow.id);
    await withdrawAllocationApproval(currentRow?.approvalId, 'superseded');
    const approvalId = await createAllocationApproval(req, assig, monthRow.id);
    await repos.assignmentMonths.update(monthRow.id, { status: 'Requested', approvalId });
  });
  // The assignment's own status is a rollup of its months — recompute it last.
  await refreshDerivedAssignmentStatus(assig.id);

  // STEP 3 — FINAL (after the status change): recompute the status-aware aggregates
  // so confirmed/planned utilization + staffed-effort reflect the new status. Best-
  // effort, mirroring the gap-A decision hook: the day replacement + status write are
  // already committed above, so a recompute failure must not 500 an otherwise-
  // successful allocation — the aggregates self-heal on the next mutation of this
  // resource/request.
  try {
    await withLock(`res:${resource.id}`, () => recomputeResourceUtilization(resource.id));
    await withLock(`req:${assig.requestId}`, () => recomputeRequestStaffing(assig.requestId));
  } catch { /* recompute is best-effort; the allocation + status already committed */ }

  const fresh = await repos.assignments.get(assig.id);
  const days = (await repos.assignmentDays.list())
    .filter(d => d.assignmentId === assig.id && monthOf(d.date) === month)
    .sort((a, b) => a.date.localeCompare(b.date));
  res.json({ ...fresh, month, contractHoursPerDay: cap, days });
});

// ---------------------------------------------------------------------------
// C2 — DUMMY SUBSTITUTION (one month). A dummy can be planned beyond 1 FTE
// (C1); a person cannot — the daily capacity gate above stops them at their
// contracted hours. Handing a dummy's booked hours to a real person therefore
// moves only what that person can absorb each day and leaves the rest on the
// dummy for a follow-up substitution (`planSubstitution`, Task 1) — partial
// substitution falls out of the capacity constraint, no quota field needed.
// ---------------------------------------------------------------------------

/**
 * C2 — give an assignment the SUBSTITUTION ITSELF CREATED a booking window and an
 * `allocationPct`, derived from its own day rows.
 *
 * Review finding: the substitution was the ONLY writer that created an assignment
 * without either. `schedule.util` defaults a missing `allocationPct` to 100 and
 * falls back to the linked REQUEST's dates, so 40 transferred hours in one month on
 * a six-month request rendered as a 100% booking spanning all six — and
 * `sweepResource` then flagged that booking AND the person's real one as
 * conflicting for the whole window. The arithmetic is in `planSubstitutionBooking`
 * (pure, unit-tested); this is the I/O around it.
 *
 * Called ONLY for assignments this substitution created (the caller tracks them):
 * an assignment a planner created carries their own explicit window and pct, and
 * this must never overwrite it. Re-derived from ALL the assignment's day rows on
 * every transfer, so `applyToRemainingMonths` widens the window month by month
 * instead of leaving it pinned to the first.
 */
async function syncSubstitutionBooking(assignmentId: string, dailyCap: number): Promise<void> {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const hoursByMonth: Record<string, number> = {};
  for (const d of await repos.assignmentDays.list()) {
    if (d.assignmentId !== assignmentId || !Number.isFinite(d.hours) || d.hours <= 0) continue;
    const m = monthOf(d.date);
    hoursByMonth[m] = round2((hoursByMonth[m] ?? 0) + d.hours);
  }
  const months = Object.keys(hoursByMonth).sort();
  if (months.length === 0) return;

  // Capacity over every month the window SPANS, not just the ones carrying hours:
  // the pct is one constant across the whole window (see `planSubstitutionBooking`).
  const holidays = new Set((await repos.holidays.list()).map(h => h.id));
  const capacityByMonth: Record<string, number> = {};
  for (const m of monthsInRange(months[0], months[months.length - 1])) {
    capacityByMonth[m] = monthlyTargetHours(dailyCap, m, holidays);
  }

  const booking = planSubstitutionBooking(hoursByMonth, capacityByMonth);
  if (booking !== undefined) await repos.assignments.update(assignmentId, booking);
}

/**
 * Move ONE dummy month's hours to `target`, as far as that person can absorb
 * them. Returns what moved and what stayed; transferring zero is a legitimate
 * outcome (the target is full that month), not an error — it tells the caller
 * another person is needed.
 *
 * CONCURRENCY: touches TWO resources, so it takes both `res:` locks — in
 * LEXICOGRAPHIC ORDER OF THE RESOURCE IDS, never "dummy first". Two crossing
 * substitutions would otherwise take them in opposite orders and deadlock. The
 * approval I/O and the month status write stay OUTSIDE both locks, as the rest
 * of this file requires, but they are NOT unserialized: they run under
 * `month:<target row id>` (see below), and the aggregate recompute runs last,
 * best-effort (in the route handler, after this function returns).
 */
async function transferDummyMonth(
  req: Request,
  dummyRow: AssignmentMonth,
  dummyAssig: Assignment,
  target: Resource,
  targetBaseCap: number,
  /** Assignments THIS request created, so a later month of the same batch can widen
   *  the window it set (see `syncSubstitutionBooking`). Never contains an assignment
   *  a planner created. */
  createdAssignmentIds: Set<string>,
): Promise<SubstitutionMonthOutcome> {
  const month = dummyRow.month;

  // The person's own ceiling: always 1 FTE — dailyCapFor is kind-aware and the
  // target is validated `internal` by the caller.
  const cap = dailyCapFor(kindOf(target), targetBaseCap);

  const [firstId, secondId] = [dummyAssig.resourceId, target.id].sort();
  const { plan, targetAssig: lockedTargetAssig, baseline } = await withLock(`res:${firstId}`, () => withLock(`res:${secondId}`, async (): Promise<{ plan: SubstitutionPlan; targetAssig?: Assignment; baseline: Record<string, number> }> => {
    // The target's assignment on the SAME request — resolved (never yet
    // CREATED) here, INSIDE both locks. Review finding (Task 3, Important #1):
    // reading the assignment list and finding-or-creating this row BEFORE the
    // lock let two concurrent substitutions targeting the same brand-new
    // person both miss the `find`, both `create` a row for the same
    // (resourceId, requestId) pair, and then each compute `targetBooked` from
    // its own now-stale snapshot — invisible to the other's writes, so both
    // could independently fill the person's day past their daily cap despite
    // the locks. Both `res:` locks are held from here on, so this read (and
    // the eventual create, below) is now inside the exact critical section
    // that must serialize it.
    const assignments = await repos.assignments.list();
    const existingTargetAssig = assignments.find(a => a.resourceId === target.id && a.requestId === dummyAssig.requestId);

    const allDays = await repos.assignmentDays.list();
    const dummyDays = allDays.filter(d => d.assignmentId === dummyAssig.id && monthOf(d.date) === month);
    const dummyByDate = sumHoursByDate(dummyDays);

    // What the target already holds on those days, across ALL their
    // assignments (a not-yet-created candidate assignment contributes no
    // rows of its own, so it needn't be in this set).
    const targetIds = new Set(assignments.filter(a => a.resourceId === target.id).map(a => a.id));
    if (existingTargetAssig) targetIds.add(existingTargetAssig.id);
    const targetBooked = sumHoursByDate(allDays.filter(d => targetIds.has(d.assignmentId) && dummyByDate[d.date] !== undefined));

    const p = planSubstitution(dummyByDate, targetBooked, cap);

    if (Object.keys(p.transfer).length === 0) {
      // Nothing to write: don't create a phantom 'Draft' assignment for the
      // target (review finding, Minor #2) and don't recompute anything —
      // the target's day rows (and a legacy assignedHours total with no day
      // rows at all, if that's what this assignment is) are left untouched.
      return { plan: p, targetAssig: existingTargetAssig, baseline: {} };
    }

    // Created ONLY NOW that something is actually moving onto it. 'Draft':
    // status is derived, never client-set (C1/B3).
    const targetAssig = existingTargetAssig ?? await repos.assignments.create({
      id: newId(), requestId: dummyAssig.requestId, resourceId: target.id,
      assignedHours: 0, status: 'Draft',
    } as Assignment);
    if (existingTargetAssig === undefined) createdAssignmentIds.add(targetAssig.id);

    // THE PRE-TRANSFER BASELINE, per date: what she already held on that date on
    // THIS assignment. Captured HERE — at the moment of the write, inside both
    // locks — because it is the only moment it is knowable. After the transfer her
    // day row carries her own hours and the loan fused into one number, and the
    // give-back cannot tell them apart: charging the whole of it against the loan
    // destroys booked hours on a trim (see `planGiveBack`). Recorded for EVERY date
    // in the map, zeros included, so the two maps always cover the same dates.
    const baseline: Record<string, number> = {};

    for (const [date, hours] of Object.entries(p.transfer)) {
      // Add to the target (merging with anything already booked that day on THIS
      // assignment), then reduce the dummy — a day that reaches zero is removed,
      // the same rule the allocation endpoint applies.
      const targetDayId = `${targetAssig.id}:${date}`;
      const existing = await repos.assignmentDays.get(targetDayId);
      const held = Number.isFinite(existing?.hours) ? existing!.hours : 0;
      baseline[date] = held;
      const merged = Math.round((held + hours) * 100) / 100;
      if (existing) await repos.assignmentDays.update(targetDayId, { hours: merged });
      else await repos.assignmentDays.create({ id: targetDayId, assignmentId: targetAssig.id, date, hours: merged } as AssignmentDay);

      const dummyDayId = `${dummyAssig.id}:${date}`;
      const left = p.remaining[date] ?? 0;
      if (left > 0) await repos.assignmentDays.update(dummyDayId, { hours: left });
      else await repos.assignmentDays.remove(dummyDayId);
    }

    // The window + pct for an assignment THIS substitution created — after the day
    // rows are written, so it reads the complete picture, and inside the locks that
    // serialize those rows. Skipped for a planner-created assignment: its own
    // booking window is not ours to overwrite.
    if (createdAssignmentIds.has(targetAssig.id)) await syncSubstitutionBooking(targetAssig.id, cap);

    // recomputeAssignedHours is called only now that `p.transfer` is known
    // non-empty (review finding, Important #2): calling it unconditionally
    // rewrote BOTH assignments' assignedHours to the sum of their (unchanged)
    // day rows even on a zero-transfer attempt — silently zeroing a LEGACY
    // assignment that carries an assignedHours total with no day rows at all
    // (the exact case recomputeAssignedHours's own doc comment calls out).
    await recomputeAssignedHours(dummyAssig.id);
    await recomputeAssignedHours(targetAssig.id);
    return { plan: p, targetAssig, baseline };
  }));

  if (plan.transferredHours === 0) {
    // Distinguish "nothing to move" from "no room to move it into": a dummy
    // month with no bookable hours (no day rows, or all zero/negative) leaves
    // BOTH transferredHours and remainingHours at 0; a saturated target still
    // has remainingHours > 0 (review finding, Minor #1).
    const reason = plan.remainingHours === 0
      ? 'the dummy has no hours booked in this month'
      : 'the target has no capacity left in this month';
    return { month, transferredHours: 0, remainingHours: plan.remainingHours, skipped: reason };
  }

  // transferredHours > 0 guarantees the locked section resolved (found or
  // created) the target's assignment — see the `if (Object.keys(p.transfer)…)`
  // early return above, the only path that leaves it undefined.
  const targetAssig = lockedTargetAssig!;

  // OUTSIDE both locks: the month row, its approval and the notes.
  const targetRow = await ensureAssignmentMonth(targetAssig.id, month);
  const selfManaged = await autoApprovesAllocation(req, target.id);
  const dummyName = (await repos.resources.get(dummyAssig.resourceId))?.name ?? 'a placeholder';

  // SERIALIZED on `month:<rowId>`, matching the allocation PUT's STEP 2 exactly.
  // read `approvalId` -> withdraw -> create -> write is a read-modify-write over one
  // SHARED row: two substitutions of two different dummy months onto the SAME person
  // (normal when one request needs several people) both read the same approvalId,
  // both withdraw it, both open a fresh approval and both write their own — leaving
  // one Pending and ORPHANED, decidable later against a month row that has moved on.
  // The same race runs against a concurrent `PUT /assignments/:id/allocation` on this
  // month, which DOES take this lock, so without it the lock bought nothing here.
  //
  // NOT NESTED, and that is load-bearing: `withLock` is not re-entrant, and
  // `ensureAssignmentMonth` above takes `month:<the same id>` — acquiring it again
  // from inside would wedge the key forever. That call has returned, and both `res:`
  // locks were released when the section above resolved, so this is taken
  // sequentially, from no other critical section. `month:` is still only ever taken
  // in these three places, none of them inside a `res:`/`req:`/`approval:` section,
  // so no lock cycle is reachable.
  const wasAllocated = await withLock(`month:${targetRow.id}`, async (): Promise<boolean> => {
    // RE-READ rather than reuse the `ensureAssignmentMonth` snapshot: `approvalId`,
    // `status` and `plannerNote` are shared mutable state and several awaits have
    // passed. Withdrawing a STALE approvalId cancels an approval that no longer
    // governs anything and leaves the current one Pending and orphaned.
    const current = await repos.assignmentMonths.get(targetRow.id) ?? targetRow;
    const priorStatus = current.status;
    await withdrawAllocationApproval(current.approvalId, 'superseded by substitution');

    const note = `Takes over from ${dummyName} — ${month}`;
    const plannerNote = current.plannerNote ? `${current.plannerNote}\n${note}` : note;

    if (selfManaged) {
      // No decision will follow, so there is nothing to give back later: close the
      // link immediately rather than leaving it dangling forever.
      await repos.assignmentMonths.update(targetRow.id, {
        status: 'Allocated', approvalId: null as unknown as undefined,
        replacedFromAssignmentMonthId: null as unknown as undefined,
        replacedDays: null as unknown as undefined,
        replacedBaselineDays: null as unknown as undefined, plannerNote,
      } as Partial<AssignmentMonth>);
    } else {
      const approvalId = await createAllocationApproval(req, targetAssig, targetRow.id);
      // `plan.transfer` — the PER-DAY map of what moved, not just its total: the
      // give-back at decision time is decided day by day (`returnHoursToDummy`).
      // `baseline` is its other half: what she ALREADY held on those dates, without
      // which a trim on a shared date cannot be told from a trim of the loan.
      await repos.assignmentMonths.update(targetRow.id, {
        status: 'Requested', approvalId,
        replacedFromAssignmentMonthId: dummyRow.id, replacedDays: plan.transfer,
        replacedBaselineDays: baseline, plannerNote,
      } as Partial<AssignmentMonth>);
    }
    // The row this substitution may have demoted — observed under the lock, on the
    // state the write above actually replaced.
    return priorStatus === 'Allocated';
  });

  // The dummy's own month records who took what.
  const dummyNote = `${target.name} took ${plan.transferredHours}h for ${month}`;
  await repos.assignmentMonths.update(dummyRow.id, {
    plannerNote: dummyRow.plannerNote ? `${dummyRow.plannerNote}\n${dummyNote}` : dummyNote,
  });

  await refreshDerivedAssignmentStatus(dummyAssig.id);
  await refreshDerivedAssignmentStatus(targetAssig.id);

  const fresh = await repos.assignmentMonths.get(targetRow.id);
  // demotedExistingWork is only meaningful for the non-self-managed branch: a
  // self-managed substitution always lands 'Allocated' (no re-approval cycle),
  // so nothing was actually demoted even if the row happened to be Allocated
  // before. Reported only when true, matching `skipped`'s "present iff it
  // applies" convention — see the "one consequence to surface" note above
  // `transferDummyMonth` in the C2 task brief.
  const demotedExistingWork = wasAllocated && !selfManaged;
  return {
    month, transferredHours: plan.transferredHours, remainingHours: plan.remainingHours,
    targetAssignmentMonthId: targetRow.id, status: fresh?.status,
    ...(demotedExistingWork ? { demotedExistingWork: true } : {}),
  };
}

/** Best-effort current sum of the dummy's day-row hours in `month` — used to
 * report an honest `remainingHours` after a transfer attempt throws. Reflects
 * whatever state genuinely exists right now (some day rows may already have
 * moved before the failure), not a guess about how far the interrupted
 * attempt got. */
async function dummyMonthHours(assignmentId: string, month: string): Promise<number> {
  const total = (await repos.assignmentDays.list())
    .filter(d => d.assignmentId === assignmentId && monthOf(d.date) === month)
    .reduce((s, d) => s + (Number.isFinite(d.hours) ? d.hours : 0), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Converts a thrown error from one month's `transferDummyMonth` attempt into
 * a SKIPPED outcome instead of letting it propagate. Load-bearing under
 * `applyToRemainingMonths`: without this, a failure on month 2 of 5 would
 * throw the whole request, discarding the 1 outcome already collected in
 * memory even though ITS mutations (day rows moved, an approval possibly
 * opened) already committed and are not undone by the throw. Applied to the
 * primary month too — same failure mode, smaller blast radius (one month
 * instead of N), and costs nothing extra now that this helper exists.
 *
 * The raw error is logged server-side (it may carry internal repo/DB detail)
 * but never echoed to the client — this endpoint is RBAC-gated to
 * resource-manager/delivery-executive/admin, not a debug console, so the
 * wire message stays generic, same discipline as the rest of this file's
 * `pick()`/mass-assignment boundary.
 */
async function failedMonthOutcome(err: unknown, assignmentId: string, month: string): Promise<SubstitutionMonthOutcome> {
  console.error(`substitute: transfer failed for assignment ${assignmentId}, month ${month}:`, err);
  const remainingHours = await dummyMonthHours(assignmentId, month).catch(() => 0);
  return {
    month, transferredHours: 0, remainingHours,
    skipped: 'the transfer for this month failed unexpectedly — check its current allocation directly',
  };
}

// C2 — hand a dummy's month to a real person. `:id` is the DUMMY's month row.
apiRouter.post('/assignment-months/:id/substitute', async (req, res) => {
  const dummyRow = await repos.assignmentMonths.get(req.params.id);
  if (dummyRow === undefined) { res.status(404).json({ error: 'Not found' }); return; }

  const body = pick<{ targetResourceId: string; applyToRemainingMonths?: boolean }>(req.body, ['targetResourceId', 'applyToRemainingMonths']);
  if (typeof body.targetResourceId !== 'string' || body.targetResourceId === '') {
    res.status(400).json({ error: 'targetResourceId is required' }); return;
  }

  const dummyAssig = await repos.assignments.get(dummyRow.assignmentId);
  if (dummyAssig === undefined) { res.status(400).json({ error: 'the month row references a missing assignment' }); return; }
  const dummyResource = await repos.resources.get(dummyAssig.resourceId);
  if (kindOf(dummyResource) !== 'dummy') {
    res.status(400).json({ error: 'only a dummy month can be substituted' }); return;
  }

  const target = await repos.resources.get(body.targetResourceId);
  if (target === undefined) { res.status(400).json({ error: 'targetResourceId must reference an existing resource' }); return; }
  if (kindOf(target) !== 'internal') { res.status(400).json({ error: 'a dummy can only be replaced by an internal resource' }); return; }
  if (target.terminationDate) { res.status(400).json({ error: 'the target resource is terminated' }); return; }
  if (target.id === dummyAssig.resourceId) { res.status(400).json({ error: 'a resource cannot replace itself' }); return; }

  const period = await repos.planningPeriods.get(dummyRow.month);
  if (period?.status !== 'Open') { res.status(403).json({ error: 'month is not open for planning' }); return; }

  const targetBaseCap = await resolveBaseCap(target);
  const outcomes: SubstitutionMonthOutcome[] = [];
  // Shared across every month of this request so a later month can widen the booking
  // window the first one set on an assignment IT created (`syncSubstitutionBooking`).
  const createdAssignmentIds = new Set<string>();
  try {
    outcomes.push(await transferDummyMonth(req, dummyRow, dummyAssig, target, targetBaseCap, createdAssignmentIds));
  } catch (err) {
    outcomes.push(await failedMonthOutcome(err, dummyAssig.id, dummyRow.month));
  }

  // C2/Task 4 — "apply to all remaining months": a dummy typically spans
  // several months, and repeating this search-and-confirm for each one is
  // exactly what this flag removes. Only month rows STRICTLY AFTER the
  // primary one that still carry hours are attempted — a month already at
  // zero (fully substituted already, or never booked) gets no outcome entry
  // at all, matching `transferDummyMonth`'s own "nothing to move" carve-out
  // one level up. A month whose planning period is not Open is skipped WITH
  // A REASON rather than aborting the loop — one closed month must never
  // stop the months after it from transferring.
  if (body.applyToRemainingMonths === true) {
    const laterRows = (await repos.assignmentMonths.list())
      .filter(m => m.assignmentId === dummyAssig.id && m.month > dummyRow.month)
      .sort((a, b) => a.month.localeCompare(b.month));

    // Snapshot ONCE before the loop: each month's day rows are keyed by date,
    // so an earlier iteration's transfer (which only touches ITS OWN month's
    // dates) can never change what a later iteration reads here.
    const allDays = await repos.assignmentDays.list();

    for (const row of laterRows) {
      const hoursThisMonth = allDays
        .filter(d => d.assignmentId === dummyAssig.id && monthOf(d.date) === row.month)
        .reduce((s, d) => s + (Number.isFinite(d.hours) ? d.hours : 0), 0);
      if (!(hoursThisMonth > 0)) continue;

      const rowPeriod = await repos.planningPeriods.get(row.month);
      if (rowPeriod?.status !== 'Open') {
        outcomes.push({
          month: row.month, transferredHours: 0,
          remainingHours: Math.round(hoursThisMonth * 100) / 100,
          skipped: 'the month is not open for planning',
        });
        continue;
      }

      try {
        outcomes.push(await transferDummyMonth(req, row, dummyAssig, target, targetBaseCap, createdAssignmentIds));
      } catch (err) {
        outcomes.push(await failedMonthOutcome(err, dummyAssig.id, row.month));
      }
    }
  }

  // Aggregates last, best-effort, ONCE for the whole batch — the transfers
  // have already committed and every month shares the same dummy resource,
  // target resource and request.
  try {
    await withLock(`res:${dummyAssig.resourceId}`, () => recomputeResourceUtilization(dummyAssig.resourceId));
    await withLock(`res:${target.id}`, () => recomputeResourceUtilization(target.id));
    await withLock(`req:${dummyAssig.requestId}`, () => recomputeRequestStaffing(dummyAssig.requestId));
  } catch { /* aggregates self-heal on the next mutation */ }

  res.json({ targetResourceId: target.id, targetResourceName: target.name, outcomes } as SubstitutionResult);
});

/**
 * C2 — THE INVERSE OF `transferDummyMonth`: give a substituted month's hours
 * back to the dummy they came from, when the decision on that month lands.
 *
 * A substitution is IMMEDIATE (the hours leave the dummy at once, so demand is
 * never double-counted while the approval is pending) but REVERSIBLE: the
 * person's month keeps a soft link to the dummy month it came from. The
 * decision closes that link:
 *   - Rejected — she never took the work, so each day in `replacedDays` gives
 *     back exactly what it moved, and her row for that day drops by exactly that
 *     much.
 *   - Approved — per day, `min(moved, stillHeld)` remains attributable to the
 *     substitution and stays hers; the rest of that day's transfer goes back.
 *     Correcting a month before approving it is a first-class approver power (C1
 *     spec, decision 2), which is why the figures must come from the recorded map
 *     and not from the month itself.
 *
 * ALL of that arithmetic lives in `planGiveBack` (pure, unit-tested); this
 * function is the I/O around it. What it must NOT do is derive the per-day split
 * from what she happens to hold at decision time: her month legitimately mixes
 * transferred hours with her own work (a substitution onto a month she already
 * had hours in DEMOTES it, it does not replace it), and spreading a single total
 * over those days strips her own work and credits it to dummy days that never
 * gave up an hour. `replacedDays` exists precisely so that never happens.
 *
 * Both `replacedFromAssignmentMonthId` and `replacedDays` are cleared with
 * explicit `null`s (the documented "clear to absent" patch value on BOTH
 * adapters) on EVERY path — the no-ops, AND a transfer that throws half way, via
 * a `finally`. A decided month must never be mistaken for a pending
 * substitution, or a retry/second decision could return the same hours twice.
 *
 * CONCURRENCY: touches TWO resources, so it takes both `res:` locks in
 * LEXICOGRAPHIC ORDER OF THE RESOURCE IDS and does its day-row reads inside
 * them — the same rule, for the same deadlock reason, as `transferDummyMonth`.
 * The month-row patch, the derived-state refresh and the aggregate recompute all
 * stay OUTSIDE both locks (the recompute takes the dummy's `res:` lock itself,
 * sequentially, never nested), and the placeholder-month reopen below takes
 * `month:<dummy row id>` — also sequentially, after both `res:` locks resolved.
 *
 * IDEMPOTENT: `row` is the caller's SNAPSHOT, so the link is re-read from the
 * repository INSIDE the locks and an already-unlinked month returns nothing (see
 * `moveBack`). With three callers — the decision hook, the self-managed retarget
 * and the assignment delete — two of them can race on one month, and acting on a
 * snapshot another caller has already settled would hand the dummy the same hours
 * twice.
 *
 * A dummy month — or its assignment, or its resource — that no longer exists
 * makes this a LOGGED NO-OP, not an error: the back-link is deliberately a soft
 * reference (Task 2) precisely because the dummy row may legitimately be deleted
 * while the month that came from it lives on.
 */
async function returnHoursToDummy(
  req: Request,
  row: AssignmentMonth,
  assig: Assignment,
  decided: 'Approved' | 'Rejected',
): Promise<void> {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const linkId = row.replacedFromAssignmentMonthId;
  if (linkId === undefined) return; // the caller guards; belt and braces.
  const month = row.month;

  // Closed on EVERY path below, including the no-ops (see the doc comment). All
  // THREE substitution columns go together — `replacedDays` and
  // `replacedBaselineDays` are two halves of one record and a surviving baseline
  // would misdescribe the next substitution's loan. Cast just these values so a typo
  // in a neighbouring field is still type-checked.
  const closeLink = async (): Promise<void> => {
    await repos.assignmentMonths.update(row.id, {
      replacedFromAssignmentMonthId: null as unknown as undefined,
      replacedDays: null as unknown as undefined,
      replacedBaselineDays: null as unknown as undefined,
    } as Partial<AssignmentMonth>);
  };

  const dummyRow = await repos.assignmentMonths.get(linkId);
  const dummyAssig = dummyRow ? await repos.assignments.get(dummyRow.assignmentId) : undefined;
  const dummyResource = dummyAssig ? await repos.resources.get(dummyAssig.resourceId) : undefined;
  if (dummyRow === undefined || dummyAssig === undefined || dummyResource === undefined) {
    console.warn(`give-back: month ${row.id} came from ${linkId}, which no longer exists — closing the link without returning hours`);
    await closeLink();
    return;
  }

  // The DUMMY's own daily ceiling (multi-FTE: it stands for capacity a single
  // person does not cover). Resolved before the locks — it reads the resource
  // row and the settings, never shared mutable state.
  const dummyCap = dailyCapFor(kindOf(dummyResource), await resolveBaseCap(dummyResource));

  const moveBack = async (): Promise<{ giveBackHours: number; shortfallHours: number }> => {
    // IDEMPOTENCE UNDER CONCURRENCY — re-read the month row and bail out if the
    // link is already gone. This MUST happen here, inside both `res:` locks, and
    // never before acquiring them: the lock is the only thing that makes the
    // answer authoritative for the duration of the write below.
    //
    // The caller hands us a SNAPSHOT of the row. That was safe while the decision
    // hook was the only caller — two decisions on the same approval serialize on
    // `approval:<id>`, so no second give-back could interleave. It is NOT safe now
    // that a retarget and a delete can also end a substitution: the decision hook
    // reads its row, then does the approval write and the audit entry, and only
    // then calls us — a window in which a concurrent delete or retarget can give
    // the same hours back and close the link. Acting on the stale snapshot would
    // credit the dummy a SECOND time. The error inflates demand rather than
    // destroying it, so the direction is safe, but the hours are simply wrong.
    //
    // `closeLink()` in the outer `finally` still runs, unchanged: patching an
    // already-cleared row with the same explicit `null`s is a harmless no-op on
    // both adapters.
    const fresh = await repos.assignmentMonths.get(row.id);
    if (fresh === undefined || fresh.replacedFromAssignmentMonthId === undefined) {
      // Not silent: this is a real interleaving, not a bug, but "the hours were
      // already returned by someone else" is exactly the kind of thing that must
      // be reconstructable afterwards.
      console.warn(`give-back: month ${row.id} was already unlinked by a concurrent caller — returning nothing`);
      return { giveBackHours: 0, shortfallHours: 0 };
    }
    // The FRESH map, not the caller's: having re-read the row under the lock, that
    // read is the authoritative one. Identical to the snapshot in every ordinary
    // case; when a second substitution overwrote the columns in between, it is the
    // map that describes what is actually on loan right now.
    const replacedDays = fresh.replacedDays ?? {};
    // Its other half, read from the same authoritative row: what she already held on
    // those dates before the transfer. An absent map (a link written before this
    // column existed) degrades to "all of it was on loan" — the pre-fix behaviour,
    // which is only wrong on a date that mixed her own hours with the loan.
    const replacedBaselineDays = fresh.replacedBaselineDays ?? {};

    const allDays = await repos.assignmentDays.list();
    const heldByDate = sumHoursByDate(allDays.filter(d => d.assignmentId === assig.id && monthOf(d.date) === month));

    // What the DUMMY RESOURCE already holds each day across ALL its assignments,
    // not just this one: `dailyCapFor` is a ceiling on the resource, which is how
    // the allocation write gate and `transferDummyMonth`'s target side both
    // aggregate it. Filtering to one assignment would understate the load and let
    // a give-back push the resource's day past its own ceiling.
    const dummyAssignmentIds = new Set(
      (await repos.assignments.list()).filter(a => a.resourceId === dummyAssig.resourceId).map(a => a.id));
    const dummyBooked = sumHoursByDate(
      allDays.filter(d => dummyAssignmentIds.has(d.assignmentId) && monthOf(d.date) === month));

    const plan = planGiveBack(replacedDays, replacedBaselineDays, heldByDate, decided, dummyBooked, dummyCap);
    if (plan.giveBackHours === 0) return plan;

    for (const [date, hours] of Object.entries(plan.giveBack)) {
      // Merge onto the dummy's OWN assignment day (the ceiling is per resource,
      // the row is per assignment), RECREATING it when it is gone — the transfer
      // removes a day row that reaches zero, so the day the dummy gave everything
      // from no longer exists.
      const dummyDayId = `${dummyAssig.id}:${date}`;
      const existing = await repos.assignmentDays.get(dummyDayId);
      const merged = round2((existing?.hours ?? 0) + hours);
      if (existing) await repos.assignmentDays.update(dummyDayId, { hours: merged });
      else await repos.assignmentDays.create({ id: dummyDayId, assignmentId: dummyAssig.id, date, hours: merged } as AssignmentDay);
    }

    // Her side. Empty on an approval — what she still holds IS the approved
    // allocation and deducting it again would destroy hours she was just granted.
    // On a rejection this carries ONLY the days the transfer touched, each already
    // reduced by exactly what the dummy received (0 meaning "delete the row").
    for (const [date, left] of Object.entries(plan.targetHours)) {
      if (left > 0) await repos.assignmentDays.update(`${assig.id}:${date}`, { hours: left });
      else await repos.assignmentDays.remove(`${assig.id}:${date}`);
    }

    // The per-day rows are the source of truth for assignedHours on both sides.
    await recomputeAssignedHours(dummyAssig.id);
    if (Object.keys(plan.targetHours).length > 0) await recomputeAssignedHours(assig.id);
    return plan;
  };

  // Both `res:` locks, in LEXICOGRAPHIC ORDER OF THE RESOURCE IDS — two crossing
  // give-backs would otherwise take them in opposite orders and deadlock.
  // `withLock` is NOT re-entrant (the inner section chains onto a tail promise
  // that contains itself), so ONE lock is taken when both sides are the same
  // resource. Unreachable today — the substitution endpoint refuses a target that
  // is the dummy itself — but this function is called from three places (the
  // decision hook, the self-managed retarget and the assignment delete), none of
  // which re-checks that, and the failure mode is not an error: it is a
  // permanently wedged `res:` key that silently hangs every later critical
  // section for that resource.
  const [firstId, secondId] = [assig.resourceId, dummyAssig.resourceId].sort();
  let outcome = { giveBackHours: 0, shortfallHours: 0 };
  try {
    outcome = firstId === secondId
      ? await withLock(`res:${firstId}`, moveBack)
      : await withLock(`res:${firstId}`, () => withLock(`res:${secondId}`, moveBack));
  } finally {
    // UNCONDITIONALLY, and OUTSIDE both locks: the link must not survive the
    // decision even when the transfer above threw part-way through. A month left
    // linked after a half-completed give-back still looks like a pending
    // substitution, and the next decision (or a retry) would return the same
    // hours a second time. Its own failure is logged rather than thrown, so it can
    // never mask the error that brought us into the `finally`.
    await closeLink().catch(err =>
      console.error(`give-back: could not clear the substitution link on ${row.id}:`, err));
  }

  if (outcome.shortfallHours > 0) {
    // Not silent: the dummy's own daily ceiling was full, so these hours could not
    // go home. They were NOT taken off her month either (`planGiveBack` conserves),
    // so nothing is lost — but somebody has to know the reversal was partial.
    console.warn(`give-back: ${outcome.shortfallHours}h of month ${row.id} could not return to ${linkId} — the dummy is at its daily ceiling on those days`);
  }
  if (outcome.giveBackHours === 0) return;

  // C2 — REOPEN A TERMINAL PLACEHOLDER MONTH, or the restored demand is invisible
  // where it matters most. `capacity.util` classifies each day row by ITS MONTH
  // ROW's status: `PLANNED = {Requested, Allocated}`, `CONFIRMED = {Allocated}`.
  // 'Rejected' is in NEITHER, so hours handed back onto a rejected placeholder month
  // contribute ZERO to `/capacity/monthly`, to `demandFteUncovered` and to the B2
  // semaphore. They exist in storage and on the calendar; the uncovered gap this
  // whole feature exists to surface does not appear on the dashboard.
  //
  // Reachable exactly as the review described: the placeholder's own month is
  // submitted, the substitution drains half of it, the approver rejects what is left
  // of the placeholder, and only then is the person's month rejected — sending hours
  // home to a row that no longer counts.
  //
  // Rejected -> Requested WITH A FRESH APPROVAL, which is the transition `submit`
  // itself already permits and the shape `transferDummyMonth` gives the target side.
  // The alternatives were both worse: 'Requested' with no approval is decidable by
  // nobody AND re-submittable by nobody (submit only accepts Draft|Rejected), so the
  // row would wedge; 'Allocated' would silently auto-approve demand a human had just
  // rejected. For a DUMMY row the two are dashboard-equivalent anyway — demand rows
  // contribute `ftePlanned` to `demandFteUncovered`, and PLANNED covers both.
  //
  // 'Draft' is deliberately NOT promoted: a Draft month contributed nothing to the
  // bands BEFORE the substitution either, so leaving it is exactly "the same band it
  // occupied before", and promoting it would submit for approval a month no planner
  // ever submitted (the same reasoning that keeps the retarget loop off Draft rows).
  //
  // Serialized on `month:<dummy row id>` for the read-`approvalId`/withdraw/create/
  // write reason as everywhere else, and taken from NO other critical section: both
  // `res:` locks resolved above, `closeLink()` ran in the `finally`, and all three
  // callers (the decision hook — which runs after the `approval:` lock is released —
  // the retarget loop and the delete handler) hold no lock here. Before the derived
  // status refresh below, which rolls the month statuses up into the assignment.
  try {
    await withLock(`month:${dummyRow.id}`, async () => {
      const current = await repos.assignmentMonths.get(dummyRow.id);
      if (current === undefined || current.status !== 'Rejected') return;
      // A decided approval makes this a no-op; it only bites on a stale Pending id.
      await withdrawAllocationApproval(current.approvalId, 'superseded by returned substitution hours');
      const approvalId = await createAllocationApproval(req, dummyAssig, dummyRow.id);
      await repos.assignmentMonths.update(dummyRow.id, { status: 'Requested', approvalId } as Partial<AssignmentMonth>);
    });
  } catch (err) {
    // Best-effort, like every other side effect here: the hours are already back on
    // the day rows, so a failure to reopen must not throw away the give-back.
    console.error(`give-back: could not reopen the placeholder month ${dummyRow.id} after restoring hours:`, err);
  }

  // Only the DUMMY's derived state is refreshed here: the person's rollup and
  // aggregates are the decision hook's own job (it runs them straight after this
  // returns, and the batch endpoint defers them to the end of the batch), and both
  // assignments sit on the SAME request by construction — the substitution creates
  // the target assignment on the dummy's request — so the hook's `req:` recompute
  // already covers the dummy's side of it.
  await refreshDerivedAssignmentStatus(dummyAssig.id);
  await withLock(`res:${dummyAssig.resourceId}`, () => recomputeResourceUtilization(dummyAssig.resourceId));
}

/**
 * Shared preamble for the per-month endpoints: resolve the assignment and
 * validate the :month path parameter. Returns undefined after having written
 * the error response.
 */
async function resolveMonthTarget(req: Request, res: Response): Promise<{ assig: Assignment; month: string } | undefined> {
  // Bracket access + typeof guard (not dot access): Express 5's ParamsDictionary
  // types a param as `string | string[]` via its index signature, same reason
  // the /capacity/monthly and allocation GET handlers guard req.query this way.
  const id = req.params['id'];
  const assig = typeof id === 'string' ? await repos.assignments.get(id) : undefined;
  if (assig === undefined) { res.status(404).json({ error: 'Not found' }); return undefined; }
  const month = req.params['month'];
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: 'month must match YYYY-MM' }); return undefined;
  }
  return { assig, month };
}

// SUBMIT one month for approval ("Invia mese in approvazione"). Draft|Rejected
// -> Requested with a fresh single-step manager approval, or straight to
// Allocated when the proposer IS the resource's manager (the gap-A self-managed
// shortcut, unchanged). Requires an OPEN planning period: proposing work in a
// closed month is a planning error, not a governance one.
apiRouter.post('/assignments/:id/months/:month/submit', async (req, res) => {
  const target = await resolveMonthTarget(req, res);
  if (target === undefined) return;
  const { assig, month } = target;

  const period = await repos.planningPeriods.get(month);
  if (period?.status !== 'Open') { res.status(403).json({ error: 'month is not open for planning' }); return; }

  const row = await repos.assignmentMonths.get(monthRowId(assig.id, month));
  if (row === undefined) { res.status(404).json({ error: 'no allocation for this month' }); return; }
  // ONLY Draft/Rejected may be voluntarily submitted. A generic month-transition
  // table is the wrong check here: its Allocated -> Requested edge belongs to a
  // DIFFERENT caller (the allocation PUT's day-edit forced-reapproval path), not
  // to an explicit planner submit — an already-Requested OR already-Allocated
  // month must be refused. Enforced inline for exactly that reason.
  if (row.status !== 'Draft' && row.status !== 'Rejected') {
    res.status(400).json({ error: `illegal month transition ${row.status} -> Requested` });
    return;
  }

  const body = pick<{ plannerNote?: string }>(req.body, ['plannerNote']);
  const plannerNote = typeof body.plannerNote === 'string' ? body.plannerNote : undefined;

  // Self-managed: approver and requester would be the same principal (SoD would
  // block the decision anyway), so the month is approved on the spot.
  await withdrawAllocationApproval(row.approvalId, 'superseded');
  if (await autoApprovesAllocation(req, assig.resourceId)) {
    await repos.assignmentMonths.update(row.id, {
      status: 'Allocated',
      // `null`, not `undefined`: both `PgRepository.update()` and (now)
      // `InMemoryRepository.update()` treat an explicit `null` patch value as
      // "clear this field" (Drizzle sets the column NULL; the in-memory store
      // drops the key) — see src/db/repository.ts's documented seam. Plain
      // `undefined` means "leave untouched" on both adapters, so it would NOT
      // clear a stale approvalId. `AssignmentMonth.approvalId` is typed
      // `string | undefined` (never `null` — every READ path normalizes a
      // cleared column back to `undefined`), so `null` only ever appears
      // transiently in this one WRITE-side value. Cast just this value (not
      // the whole patch literal) so a typo in `status`/`plannerNote` is still
      // caught by the type checker.
      approvalId: null as unknown as undefined,
      ...(plannerNote !== undefined ? { plannerNote } : {}),
    });
  } else {
    const approvalId = await createAllocationApproval(req, assig, row.id);
    await repos.assignmentMonths.update(row.id, {
      status: 'Requested', approvalId, ...(plannerNote !== undefined ? { plannerNote } : {}),
    } as Partial<AssignmentMonth>);
  }

  await refreshDerivedAssignmentStatus(assig.id);
  // Status-aware aggregates follow the month's new state. Best-effort, same
  // discipline as the allocation endpoint: the transition is already committed.
  try {
    await withLock(`res:${assig.resourceId}`, () => recomputeResourceUtilization(assig.resourceId));
    await withLock(`req:${assig.requestId}`, () => recomputeRequestStaffing(assig.requestId));
  } catch { /* aggregates self-heal on the next mutation */ }

  res.json(await repos.assignmentMonths.get(row.id));
});

// PLANNER NOTE on a month ("campo note" in RPT §3.5): saved only once the month
// exists, i.e. after the allocation has been drafted.
apiRouter.put('/assignments/:id/months/:month/note', async (req, res) => {
  const target = await resolveMonthTarget(req, res);
  if (target === undefined) return;
  const { assig, month } = target;

  const body = pick<{ plannerNote?: string }>(req.body, ['plannerNote']);
  if (typeof body.plannerNote !== 'string') { res.status(400).json({ error: 'plannerNote must be a string' }); return; }

  const row = await repos.assignmentMonths.get(monthRowId(assig.id, month));
  if (row === undefined) { res.status(404).json({ error: 'no allocation for this month' }); return; }
  await repos.assignmentMonths.update(row.id, { plannerNote: body.plannerNote });
  res.json(await repos.assignmentMonths.get(row.id));
});

// ---------------------------------------------------------------------------
// COMPUTED READ (B2): monthly FTE capacity vs. demand rollup across resources.
// Gated to staffing roles by the '/capacity' READ_RULE — roleGate is GLOBAL
// middleware, so this handler is already authorized; do NOT re-gate per-handler.
// Read-only: no mutation, no withLock. This handler owns the ONE permitted
// "current date" default (the pure util in capacity.util never reads a clock).
// ---------------------------------------------------------------------------
apiRouter.get('/capacity/monthly', async (req, res) => {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const qParam = (name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === 'string' ? v : undefined;
  };
  // month <-> absolute-index helpers so span math is correct across year bounds.
  const monthToIdx = (mo: string): number => { const [y, m] = mo.split('-').map(Number); return y * 12 + (m - 1); };
  const idxToMonth = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

  const fromRaw = qParam('from');
  const toRaw = qParam('to');
  if (fromRaw !== undefined && !MONTH_RE.test(fromRaw)) { res.status(400).json({ error: 'from must be a YYYY-MM month' }); return; }
  if (toRaw !== undefined && !MONTH_RE.test(toRaw)) { res.status(400).json({ error: 'to must be a YYYY-MM month' }); return; }

  // Each side defaults independently: absent `from` -> first Open planning period
  // (asc), else the current month; absent `to` -> from + 5 months (6-month window).
  let from = fromRaw;
  if (from === undefined) {
    const openIds = (await repos.planningPeriods.list()).filter(p => p.status === 'Open').map(p => p.id).sort();
    from = openIds[0] ?? new Date().toISOString().slice(0, 7);
  }
  const to = toRaw ?? idxToMonth(monthToIdx(from) + 5);

  if (from > to) { res.status(400).json({ error: 'from must be <= to' }); return; }
  if (monthToIdx(to) - monthToIdx(from) + 1 > 24) { res.status(400).json({ error: 'range must span at most 24 months' }); return; }
  const months = monthsInRange(from, to);

  const [resources, assignments, assignmentDays, assignmentMonthRows, holidays, hoursPerDay] = await Promise.all([
    repos.resources.list(),
    repos.assignments.list(),
    repos.assignmentDays.list(),
    repos.assignmentMonths.list(),
    repos.holidays.list(),
    getHoursPerDay(),
  ]);
  const holSet = new Set(holidays.map(h => h.id));
  const assignmentMonths = assignmentMonthRows.map(m => ({ assignmentId: m.assignmentId, month: m.month, status: m.status }));

  res.json(rollupMonthly({ resources, assignments, assignmentDays, assignmentMonths, months, hoursPerDay, holidays: holSet }));
});

/**
 * B3 — People Manager approval feed: resources × months × projects with the
 * per-month lifecycle state, hours, target and notes. Read-only; gated by the
 * '/allocation-approvals' READ_RULE (roleGate is GLOBAL middleware — do NOT
 * re-gate per handler).
 */
apiRouter.get('/allocation-approvals', async (req, res) => {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const qParam = (name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === 'string' ? v : undefined;
  };
  // month <-> absolute-index helpers so span math is correct across year
  // bounds — same shape as /capacity/monthly's local helpers.
  const monthToIdx = (mo: string): number => { const [y, m] = mo.split('-').map(Number); return y * 12 + (m - 1); };
  const idxToMonth = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

  const fromRaw = qParam('from');
  const toRaw = qParam('to');
  if (fromRaw !== undefined && !MONTH_RE.test(fromRaw)) { res.status(400).json({ error: 'from must be a YYYY-MM month' }); return; }
  if (toRaw !== undefined && !MONTH_RE.test(toRaw)) { res.status(400).json({ error: 'to must be a YYYY-MM month' }); return; }
  const statusFilter = qParam('status') ?? 'all';
  if (!['all', 'Requested', 'Allocated'].includes(statusFilter)) {
    res.status(400).json({ error: "status must be 'all', 'Requested' or 'Allocated'" }); return;
  }

  // Each side defaults INDEPENDENTLY, so a caller-supplied bound is never
  // silently discarded or inverted:
  //  - NEITHER supplied -> the whole window defaults to the span of Open
  //    planning periods (RPT's "Mesi aperti") — no bound was given, so there
  //    is nothing to honour.
  //  - Exactly ONE supplied -> the OTHER side defaults to a fixed 6-month
  //    window anchored on the supplied bound (same shape as
  //    /capacity/monthly's own `to = from + 5` default), never touching open
  //    periods — that lookup is only meaningful when NEITHER bound is given.
  let from = fromRaw;
  let to = toRaw;
  if (fromRaw === undefined && toRaw === undefined) {
    const openMonths = (await repos.planningPeriods.list()).filter(p => p.status === 'Open').map(p => p.id).sort();
    from = openMonths[0];
    to = openMonths[openMonths.length - 1];
  } else {
    if (toRaw === undefined && fromRaw !== undefined) to = idxToMonth(monthToIdx(fromRaw) + 5);
    if (fromRaw === undefined && toRaw !== undefined) from = idxToMonth(monthToIdx(toRaw) - 5);
  }
  if (from === undefined || to === undefined) { res.json({ months: [], rows: [] }); return; }
  if (from > to) { res.status(400).json({ error: 'from must be <= to' }); return; }
  if (monthToIdx(to) - monthToIdx(from) + 1 > 24) { res.status(400).json({ error: 'range must span at most 24 months' }); return; }
  const months = monthsInRange(from, to);

  const [resources, assignments, monthRows, days, requests, projects, holidayRows, orgNodes] = await Promise.all([
    repos.resources.list(), repos.assignments.list(), repos.assignmentMonths.list(),
    repos.assignmentDays.list(), repos.requests.list(), repos.projects.list(), repos.holidays.list(),
    repos.resourceOrganizations.list(),
  ]);
  const holidays = new Set(holidayRows.map(h => h.id));

  // D (design spec §3.3) — a manager sees their own scope. This rule MUST mirror
  // `decideOneApproval`: a row the actor cannot decide would render as a dead
  // button, and a row they CAN decide must never be hidden — hence the
  // no-manager-anywhere rows stay visible to every resource-manager.
  const feedRole = trustedRole(req);
  const feedActorResourceId = await actorResourceId(req);
  const feedGlobalRole = feedRole === 'admin' || feedRole === 'delivery-executive';
  const visibleResourceIds = feedGlobalRole
    ? undefined
    : feedActorResourceId === undefined
      // DEFENSIVE, CURRENTLY UNREACHABLE: `actorResourceId` resolves via
      // `actorId(req)` (`id = req.verifiedUserId || String(req.header('X-User-Id')
      // || 'system')`), which can never be falsy — `verifyBearer` yields
      // 'unknown' rather than '', and the unauthenticated fallback is the
      // literal 'system' — so `actorResourceId`'s own `?? (id || undefined)`
      // always yields the (truthy) id, never `undefined`. This branch is
      // therefore dead today. It is kept, rather than deleted, and made
      // RESTRICTIVE (an empty scope — the roleFallback-only rows below, not an
      // unrestricted feed) so that if `actorId`/`actorResourceId` ever change to
      // make it reachable, the feed cannot silently diverge from
      // `decideOneApproval`'s OWN treatment of an unresolved `deciderResourceId`:
      // there, `scopeMatch` reduces to `roleFallback` alone, never to "anything
      // goes". An empty `Set` (not `undefined`) is what makes the loop below
      // apply exactly that: only no-manager-anywhere rows survive.
      ? new Set<string>()
      : scopeOf(feedActorResourceId, resources, orgNodes);
  // PERFORMANCE: `scopedApproversOf` is O(resources.length) per call (it
  // rebuilds a resources-by-id Map internally) and is evaluated once per
  // VISIBLE-CHECK below, not once per resource — a resource with N month-rows
  // in the window would otherwise re-derive the identical answer N times, an
  // O(rows × resources) cost where O(rows + resources) is available. Memoized
  // per resource id so each resource pays for the computation at most once
  // per request, regardless of how many month-rows it has in range.
  const roleFallbackCache = new Map<string, boolean>();
  const isRoleFallback = (resource: Resource): boolean => {
    let cached = roleFallbackCache.get(resource.id);
    if (cached === undefined) {
      cached = scopedApproversOf(resource, resources, orgNodes).roleFallback;
      roleFallbackCache.set(resource.id, cached);
    }
    return cached;
  };
  const hoursPerDay = await getHoursPerDay();
  const assignmentById = new Map(assignments.map(a => [a.id, a]));
  const resourceById = new Map(resources.map(r => [r.id, r]));
  const requestById = new Map(requests.map(r => [r.id, r]));
  const projectById = new Map(projects.map(p => [p.id, p]));

  // Hours per (assignment, month), summed from the day rows.
  const hoursByRow = new Map<string, number>();
  for (const d of days) {
    const key = monthRowId(d.assignmentId, monthOf(d.date));
    hoursByRow.set(key, (hoursByRow.get(key) ?? 0) + (Number.isFinite(d.hours) ? d.hours : 0));
  }

  // PASS 1 — totals, UNCONDITIONAL on statusFilter: a resource's per-month
  // total must reflect every one of its month rows in range (Draft/Requested/
  // Allocated/Rejected alike), never just the ones the current filtered view
  // happens to list. Computed separately from PASS 2 below so a `status=`
  // filter can never corrupt this number.
  const totalsByResource = new Map<string, Record<string, number>>();
  for (const m of monthRows) {
    if (m.month < from || m.month > to) continue;
    const assig = assignmentById.get(m.assignmentId);
    if (assig === undefined) continue;
    const resource = resourceById.get(assig.resourceId);
    if (resource === undefined) continue;
    let totals = totalsByResource.get(resource.id);
    if (totals === undefined) {
      totals = Object.fromEntries(months.map(mo => [mo, 0]));
      totalsByResource.set(resource.id, totals);
    }
    const hours = hoursByRow.get(m.id) ?? 0;
    totals[m.month] = (totals[m.month] ?? 0) + hours;
  }

  // PASS 2 — the rows/items actually returned. `statusFilter` selects which
  // items are listed (and therefore which resources appear at all), but each
  // row's `totalHours` is seeded from the unconditional PASS 1 totals above,
  // not accumulated from the filtered items here.
  const rowsByResource = new Map<string, AllocationApprovalRow>();
  for (const m of monthRows) {
    if (m.month < from || m.month > to) continue;
    if (statusFilter !== 'all' && m.status !== statusFilter) continue;
    const assig = assignmentById.get(m.assignmentId);
    if (assig === undefined) continue;
    const resource = resourceById.get(assig.resourceId);
    if (resource === undefined) continue;
    if (
      visibleResourceIds !== undefined
      && !visibleResourceIds.has(resource.id)
      && !isRoleFallback(resource)
    ) continue;

    let row = rowsByResource.get(resource.id);
    if (row === undefined) {
      const cap = (typeof resource.contractHoursPerDay === 'number' && Number.isFinite(resource.contractHoursPerDay) && resource.contractHoursPerDay > 0)
        ? resource.contractHoursPerDay : hoursPerDay;
      row = {
        resourceId: resource.id, resourceName: resource.name, managerId: resource.managerId,
        // C1: normalized so the UI can gate the saturation band/percentage off
        // for dummy/subco rows (manual §4.3 — they have no capacity to
        // saturate) without guessing at an absent/unrecognized value itself.
        kind: kindOf(resource),
        contractHoursPerDay: cap,
        targetHours: Object.fromEntries(months.map(mo => [mo, monthlyTargetHours(cap, mo, holidays)])),
        totalHours: { ...(totalsByResource.get(resource.id) ?? Object.fromEntries(months.map(mo => [mo, 0]))) },
        items: [],
      };
      rowsByResource.set(resource.id, row);
    }
    const request = requestById.get(assig.requestId);
    const project = request?.projectId ? projectById.get(request.projectId) : undefined;
    const hours = hoursByRow.get(m.id) ?? 0;
    row.items.push({
      assignmentMonthId: m.id, assignmentId: m.assignmentId, month: m.month, status: m.status,
      projectId: project?.id, projectName: project?.name, requestId: assig.requestId, hours,
      plannerNote: m.plannerNote, approverNote: m.approverNote, approvalId: m.approvalId,
    } satisfies AllocationApprovalItem);
  }

  const rows = [...rowsByResource.values()].sort((a, b) => a.resourceName.localeCompare(b.resourceName));
  for (const row of rows) row.items.sort((a, b) => a.month.localeCompare(b.month) || a.assignmentId.localeCompare(b.assignmentId));
  res.json({ months, rows });
});

apiRouter.get('/time-entries', async (_req, res) => { res.json(await repos.timeEntries.list()); });
apiRouter.post('/time-entries', async (req, res) => {
  // B-TIME-ENTRY (status bypass): 'status'/'approvedBy'/'approvedAt' are NOT in
  // the create allow-list, so a client cannot seed an already-'Approved' entry
  // that would bypass the PUT transition whitelist + SoD and inflate the billing
  // cap accrual (accrued T&M sums APPROVED entries). The initial status is forced
  // to 'Draft' AFTER the spread (parity with POST /requests pinning its status),
  // so it can never be overridden by the body.
  const body = pick<TimeEntry>(req.body, ['assignmentId', 'requestId', 'resourceId', 'projectId', 'date', 'hours', 'notes']);
  if (!isNonNegNumber(body.hours)) {
    res.status(400).json({ error: 'hours must be a non-negative number' });
    return;
  }
  const reqRef = await repos.requests.get(body.requestId ?? '');
  const item = {
    id: `TE${newId()}`,
    ...body,
    status: 'Draft',
    projectId: body.projectId || reqRef?.projectId || '',
  } as TimeEntry;
  const created = await repos.timeEntries.create(item);
  res.json(created);
});
apiRouter.put('/time-entries/:id', async (req, res) => {
  const existing = await repos.timeEntries.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  // B-TIME-ENTRY SoD: `resourceId` (the entry's OWNER) is NOT reassignable after
  // creation. Allowing it on PUT let an owner re-own their entry to a dummy id in
  // a Draft PUT and then approve it (the self-approval guard keyed on the
  // now-stale owner), so it is deliberately excluded from the allow-list.
  const body = pick<TimeEntry>(req.body, ['assignmentId', 'requestId', 'projectId', 'date', 'hours', 'status', 'notes', 'approvedBy', 'approvedAt']);
  if (body.hours !== undefined && !isNonNegNumber(body.hours)) {
    res.status(400).json({ error: 'hours must be a non-negative number' });
    return;
  }
  // B-TIME-ENTRY: enforce the allowed status-transition whitelist. A status that
  // is present must be a permitted move from the current status (a no-op
  // transition is allowed); any other move (e.g. Approved->Draft, or jumping
  // straight to Approved from Draft) is rejected.
  if (body.status !== undefined && !isAllowedTimeEntryTransition(existing.status, body.status)) {
    res.status(400).json({ error: `Illegal time-entry transition: ${existing.status} -> ${body.status}` });
    return;
  }
  if (body.status === 'Approved' && existing.status !== 'Approved') {
    // SEGREGATION OF DUTIES: the approver is the TRUSTED actor (never a
    // client-supplied approvedBy) and must differ from the entry's owner
    // (its resourceId) so a resource cannot approve their own time and inflate
    // accrued T&M. The actor is a USER identity, so resolve it to the user's
    // RESOURCE id before comparing — comparing the raw username/sub against a
    // resourceId is always false under real JWT auth and silently disables SoD.
    const approverResourceId = await actorResourceId(req);
    if (approverResourceId !== undefined && approverResourceId === existing.resourceId) {
      res.status(403).json({ error: 'Segregation of duties: a resource cannot approve their own time entry' });
      return;
    }
    body.approvedBy = actorId(req);
    body.approvedAt = new Date().toISOString();
  }
  const updated = await repos.timeEntries.update(req.params.id, body);
  res.json(updated);
});
apiRouter.delete('/time-entries/:id', async (req, res) => {
  await repos.timeEntries.remove(req.params.id);
  res.status(204).send();
});

// --- Configuration ----------------------------------------------------------

apiRouter.get('/languages', async (_req, res) => {
  // The natural-key adapter carries a synthetic `id` mirroring `code`; project
  // each row to the exact legacy client shape ({ code, name, isDefault }).
  const all = await repos.languages.list();
  res.json(all.map(l => ({ code: l.code, name: l.name, isDefault: l.isDefault })));
});
apiRouter.post('/languages/default', async (req, res) => {
  const code = pick<{ code: string }>(req.body, ['code']).code;
  const all = await repos.languages.list();
  // B-DATA: only an existing language code may become the default.
  if (typeof code !== 'string' || !all.some(l => l.code === code)) {
    res.status(400).json({ error: 'code must reference an existing language' });
    return;
  }
  // Set isDefault so exactly the chosen code is the default. The synthetic `id`
  // mirrors `code`, so each row is addressed by its code.
  for (const l of all) {
    const shouldDefault = l.code === code;
    if (l.isDefault !== shouldDefault) await repos.languages.update(l.id, { isDefault: shouldDefault });
  }
  res.status(204).send();
});

apiRouter.get('/skill-catalogs', async (_req, res) => { res.json(await repos.skillCatalogs.list()); });
apiRouter.post('/skill-catalogs', async (req, res) => {
  const item = { id: newId(), skills: [], ...pick(req.body, ['name', 'description', 'skills']) } as SkillCatalog;
  res.json(await repos.skillCatalogs.create(item));
});
apiRouter.put('/skill-catalogs/:id', async (req, res) => {
  const existing = await repos.skillCatalogs.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await repos.skillCatalogs.update(req.params.id, pick(req.body, ['name', 'description', 'skills']));
  res.json(updated);
});
apiRouter.delete('/skill-catalogs/:id', async (req, res) => { await repos.skillCatalogs.remove(req.params.id); res.status(204).send(); });

apiRouter.get('/proficiency-sets', async (_req, res) => { res.json(await repos.proficiencySets.list()); });
apiRouter.post('/proficiency-sets', async (req, res) => {
  const item = { id: newId(), levels: [], ...pick(req.body, ['name', 'description', 'levels']) } as ProficiencySet;
  res.json(await repos.proficiencySets.create(item));
});
apiRouter.delete('/proficiency-sets/:id', async (req, res) => { await repos.proficiencySets.remove(req.params.id); res.status(204).send(); });

apiRouter.get('/skills', async (_req, res) => { res.json(await repos.skills.list()); });
apiRouter.post('/skills', async (req, res) => {
  const item = { id: newId(), conceptUri: `sap-rm://skill/${newId()}`, catalogs: [], restricted: false, ...pick(req.body, ['name', 'description', 'catalogs', 'proficiencySetId', 'restricted']) } as Skill;
  res.json(await repos.skills.create(item));
});
apiRouter.put('/skills/:id', async (req, res) => {
  const existing = await repos.skills.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await repos.skills.update(req.params.id, pick(req.body, ['name', 'description', 'catalogs', 'proficiencySetId', 'restricted']));
  res.json(updated);
});
apiRouter.delete('/skills/:id', async (req, res) => { await repos.skills.remove(req.params.id); res.status(204).send(); });

apiRouter.get('/project-roles', async (_req, res) => { res.json(await repos.projectRoles.list()); });
apiRouter.post('/project-roles', async (req, res) => {
  const item = { id: newId(), restricted: false, ...pick(req.body, ['code', 'name', 'description', 'restricted']) } as ProjectRole;
  res.json(await repos.projectRoles.create(item));
});
apiRouter.put('/project-roles/:id', async (req, res) => {
  const existing = await repos.projectRoles.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await repos.projectRoles.update(req.params.id, pick(req.body, ['code', 'name', 'description', 'restricted']));
  res.json(updated);
});

apiRouter.get('/service-organizations', async (_req, res) => { res.json(await repos.serviceOrganizations.list()); });

apiRouter.get('/resource-organizations', async (_req, res) => { res.json(await repos.resourceOrganizations.list()); });
apiRouter.post('/resource-organizations', async (req, res) => {
  const body = pick<ResourceOrganization>(req.body, [
    'name', 'description', 'costCenters', 'serviceOrganizationId',
    // D — the delivery tree. A field missing here is dropped SILENTLY.
    'parentId', 'level', 'managerId',
  ]);
  // REFERENCE-DATA INTEGRITY (Phase F2): costCenters[] -> cost-centers catalog (id),
  // serviceOrganizationId -> service-organizations (id). Optional; supplied values checked.
  const refErr = await validateResourceOrgRefs(body as Record<string, unknown>);
  if (refErr) { res.status(400).json({ error: refErr }); return; }
  // D — org-tree integrity (levels, parent/child, cycles, unique name). Run
  // AFTER the F2 reference check, on the same allow-listed body; no ctx.id on
  // create.
  const treeErr = await validateOrgTreeNode(body);
  if (treeErr) { res.status(400).json({ error: treeErr }); return; }
  // D — `level` IS now in the pick() allow-list above, so an explicit value
  // overrides this default; an omitted one still lands as 'capability',
  // mirroring the schema default, so the two adapters agree. In-memory stores
  // exactly what it is handed (no column default to fall back on), so leaving
  // this out would make an in-memory-created row silently disagree with a
  // Postgres one. `level` MUST stay before `...body` — reversing the order
  // would make every explicit `level` silently ignored.
  const item = { id: newId(), costCenters: [], level: 'capability', ...body } as ResourceOrganization;
  res.json(await repos.resourceOrganizations.create(item));
});
apiRouter.put('/resource-organizations/:id', async (req, res) => {
  const existing = await repos.resourceOrganizations.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ResourceOrganization>(req.body, [
    'name', 'description', 'costCenters', 'serviceOrganizationId',
    // D — the delivery tree. A field missing here is dropped SILENTLY.
    'parentId', 'level', 'managerId',
  ]);
  const refErr = await validateResourceOrgRefs(body as Record<string, unknown>);
  if (refErr) { res.status(400).json({ error: refErr }); return; }
  // D — org-tree integrity, excluding this record's own id from the
  // name-uniqueness check and enabling the cycle check (PUT only).
  const treeErr = await validateOrgTreeNode(body, { id: req.params.id });
  if (treeErr) { res.status(400).json({ error: treeErr }); return; }
  // REVIEW ROUND 2 (important) — a rename must not silently ORPHAN every
  // resource still bound to the OLD name. Resources attach to a node by NAME
  // (spec §2.4) — that is precisely WHY tree-wide name uniqueness exists in
  // validateOrgTreeNode above — so renaming the node they point at walks
  // straight past that binding: `dimensionsOf`/`pickRateCard` would stop
  // resolving for every one of them, silently, the moment this PUT commits.
  // 409, not a 400: this is a conflict with other live data, exactly like the
  // DELETE guard below, which this mirrors — a rename is refused under the
  // exact same condition a delete would be. A no-op rename (body.name equals
  // the existing name — see check 5) is deliberately excluded: nothing is
  // actually changing, so nothing can be orphaned.
  //
  // NOT cascaded onto the resources: rewriting `Resource.organization` on
  // every affected row is a side effect into ANOTHER collection with its own
  // audit implications (the append-only audit middleware would need to
  // attribute those writes to something), and that is a decision for its own
  // task, not a silent side-effect bundled into this one. Recorded here, not
  // left implicit, so the next reader knows cascade-on-rename was considered
  // and deliberately deferred, not overlooked.
  if (body.name !== undefined && body.name !== existing.name) {
    const resources = await repos.resources.list();
    const affected = resources.filter(r => r.organization === existing.name);
    if (affected.length > 0) {
      res.status(409).json({
        error: `Cannot rename: ${affected.length} resource(s) still reference the name "${existing.name}"`,
      });
      return;
    }
  }
  // D — CLEAR-TO-ABSENT SEAM (src/db/repository.ts): both adapters treat an
  // explicit `null` in an update patch as "clear this field" and `undefined`
  // as "leave untouched" — but a client clears an optional reference by
  // sending '', not null (the UI has no way to author a literal `null`). Left
  // as-is, '' would persist as a literal empty string on BOTH adapters (never
  // becoming absent), instead of reading back as a root/manager-less node.
  // Translate the '' sentinel to `null` here so parentId AND managerId each
  // clear identically on both adapters. managerId matters beyond symmetry:
  // Task 7's manager <select> has no way to author a literal `null`, so its
  // empty option — the only way to detach a Capability Leader from a node —
  // relies on exactly this translation to do anything at all.
  if (body.parentId === '') (body as Record<string, unknown>)['parentId'] = null;
  if (body.managerId === '') (body as Record<string, unknown>)['managerId'] = null;
  const updated = await repos.resourceOrganizations.update(req.params.id, body);
  res.json(updated);
});
apiRouter.delete('/resource-organizations/:id', async (req, res) => {
  const node = await repos.resourceOrganizations.get(req.params.id);
  if (node === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const all = await repos.resourceOrganizations.list();
  if (all.some(n => n.parentId === req.params.id)) {
    res.status(409).json({ error: 'Cannot delete an organization that has children' }); return;
  }
  // Resources bind to a node by NAME (design spec §2.4), so this is a name check.
  const resources = await repos.resources.list();
  if (resources.some(r => r.organization === node.name)) {
    res.status(409).json({ error: 'Cannot delete an organization that resources still reference' }); return;
  }
  await repos.resourceOrganizations.remove(req.params.id);
  res.status(204).send();
});

// --- Customizing catalogs (Phase F1 — additive reference data) --------------
// Reads stay open (like the other config catalogs); mutations are gated to
// admin/delivery-executive by the RBAC rule above. No existing consumer is
// rewired here — F2 binds these.

// COUNTRIES — natural-key catalog (the ISO-2 `code` is the PK, supplied by the
// client, NOT server-assigned), so it cannot use the id-based `crud()` helper.
// The code is normalized to upper-case and validated as two ASCII letters; create
// rejects a duplicate code.
const isIso2Code = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z]{2}$/.test(v);
apiRouter.get('/countries', async (_req, res) => { res.json(await repos.countries.list()); });
apiRouter.post('/countries', async (req, res) => {
  const body = pick<Country>(req.body, ['code', 'name']);
  if (!isIso2Code(body.code)) { res.status(400).json({ error: 'code must be a 2-letter ISO country code' }); return; }
  if (typeof body.name !== 'string' || body.name.length === 0) { res.status(400).json({ error: 'name is required' }); return; }
  const code = body.code.toUpperCase();
  if (await repos.countries.get(code)) { res.status(400).json({ error: `country ${code} already exists` }); return; }
  // The natural-key repo mirrors `id` from `code`; pass both for a clean insert.
  res.json(await repos.countries.create({ id: code, code, name: body.name }));
});
apiRouter.put('/countries/:code', async (req, res) => {
  const existing = await repos.countries.get(req.params.code);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  // Only the name is editable; the code is the immutable natural key.
  const updated = await repos.countries.update(req.params.code, pick(req.body, ['name']));
  res.json(updated);
});
apiRouter.delete('/countries/:code', async (req, res) => {
  const removed = await repos.countries.remove(req.params.code);
  if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(204).send();
});

// CITIES — id-keyed catalog; `countryCode` is a REQUIRED FK to /countries.
crud(apiRouter, 'cities', repos.cities, ['name', 'countryCode'], [], async data => {
  if (data['countryCode'] === undefined) return 'countryCode is required';
  if (!(await existsRepo(repos.countries, data['countryCode']))) {
    return 'countryCode must reference an existing country';
  }
  return null;
});

// Simple {id, name} catalogs.
crud(apiRouter, 'industries', repos.industries, ['name']);
crud(apiRouter, 'cost-categories', repos.costCategories, ['name']);
crud(apiRouter, 'partner-roles', repos.partnerRoles, ['name']);

// VENDORS — partner/supplier companies. REFERENCE-DATA INTEGRITY (Phase F2):
// `country` (when supplied) must be a valid ISO-2 country code from the countries
// catalog (the natural key). Optional; an omitted/empty country passes.
crud(apiRouter, 'vendors', repos.vendors, ['name', 'vatId', 'country'], [], data =>
  validateCatalogValue(data['country'], 'country', countryCodes, 'country (ISO-2 code)'));

// RATE CARDS (Phase E) — role-based default cost/bill rates customizing.
// REFERENCE-DATA INTEGRITY: `role` -> project-roles (name, required), optional
// `organization` -> resource-organizations (name), `currency` -> fx-rates
// (required), `costRate`/`billRate` required non-negative numbers. Reads + writes
// are sensitive (expose rates) and RBAC-gated like /resources (roleGate + READ_RULES).
crud(apiRouter, 'rate-cards', repos.rateCards, ['role', 'organization', 'currency', 'costRate', 'billRate'], ['costRate', 'billRate'],
  async (data, ctx) => {
    if (!data['role']) return 'role is required (project-role catalog name)';
    const roleErr = await validateCatalogValue(data['role'], 'role', projectRoleNames, 'project role (catalog name)');
    if (roleErr) return roleErr;
    if (data['organization'] !== undefined && data['organization'] !== null && data['organization'] !== '') {
      const orgErr = await validateCatalogValue(data['organization'], 'organization', resourceOrganizationNames, 'resource organization (catalog name)');
      if (orgErr) return orgErr;
    }
    if (!data['currency']) return 'currency is required';
    const curErr = await validateCurrency({ currency: data['currency'] });
    if (curErr) return curErr;
    if (!Number.isFinite(Number(data['costRate'])) || !Number.isFinite(Number(data['billRate']))) {
      return 'costRate and billRate are required numbers';
    }
    // UNIQUENESS: at most one card per (role, organization, currency). A null/
    // undefined/'' organization is the single "All organizations" key, so two
    // generic cards for the same role+currency also collide. Excludes the record
    // being edited (ctx.id) so a no-op PUT to an existing card is allowed.
    const orgKey = (v: unknown) => (typeof v === 'string' ? v : '');
    const role = data['role'];
    const org = orgKey(data['organization']);
    const currency = data['currency'];
    const existing = await repos.rateCards.list();
    const dup = existing.find(c => c.id !== ctx?.id && c.role === role && orgKey(c.organization) === org && c.currency === currency);
    if (dup) {
      return `A rate card already exists for "${role}" / ${org || 'All organizations'} in ${currency}. Edit that card instead of adding a duplicate.`;
    }
    return null;
  });

// HYBRID DAY MODEL — working hours-per-day that converts the €/day rate cards into
// the €/hour the margin math consumes. Read is open (the resolver + forms need it);
// writes are gated to finance-grade roles (it rescales every effective rate).
apiRouter.get('/settings/hours-per-day', async (_req, res) => {
  res.json({ value: await getHoursPerDay() });
});
apiRouter.put('/settings/hours-per-day', async (req, res) => {
  const n = Number((req.body ?? {}).value);
  if (!Number.isFinite(n) || n <= 0 || n > 24) {
    res.status(400).json({ error: 'value must be a number in (0, 24] — working hours per day' });
    return;
  }
  const existing = await repos.settings.get('hoursPerDay');
  if (existing) await repos.settings.update('hoursPerDay', { value: String(n) });
  else await repos.settings.create({ id: 'hoursPerDay', value: String(n) });
  res.json({ value: n });
});

// HOLIDAYS — natural-key catalog (id IS the ISO date, e.g. '2026-12-25'); the
// working-day gate (assignment day-replace, above) reads this. Not a `crud()`
// collection because crud() hard-assigns `id: newId()`, which would clobber the
// natural key. Upsert via get -> update-or-create, mirroring /settings above.
// Reads stay open (like the other config catalogs); writes are gated to
// admin/delivery-executive by the RBAC rule below.
apiRouter.get('/holidays', async (_req, res) => { res.json(await repos.holidays.list()); });
apiRouter.put('/holidays/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id)) { res.status(400).json({ error: 'id must be an ISO date (YYYY-MM-DD)' }); return; }
  const body = pick<{ name: string }>(req.body, ['name']);
  if (typeof body.name !== 'string' || body.name.length === 0) { res.status(400).json({ error: 'name is required' }); return; }
  const existing = await repos.holidays.get(id);
  const updated = existing
    ? await repos.holidays.update(id, { name: body.name })
    : await repos.holidays.create({ id, name: body.name });
  res.json(updated);
});
apiRouter.delete('/holidays/:id', async (req, res) => {
  const removed = await repos.holidays.remove(req.params.id);
  if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(204).send();
});

// PLANNING PERIODS — natural-key catalog (id IS the 'YYYY-MM' month); a Closed
// period rejects new/edited daily bookings (working-day gate above). No DELETE
// — a month is opened/closed, never deleted. Reads stay open (the Task-8
// calendar, used by pm/resource-manager, must read this to render open/closed
// months); writes are admin-only (a NEW mutation rule below, distinct from the
// broader config-catalog rule).
const isPlanningPeriodStatus = (v: unknown): v is 'Open' | 'Closed' => v === 'Open' || v === 'Closed';
apiRouter.get('/planning-periods', async (_req, res) => { res.json(await repos.planningPeriods.list()); });
apiRouter.put('/planning-periods/:id', async (req, res) => {
  const id = req.params.id;
  // Range-checked YYYY-MM (month 01–12): a bare \d{2} would admit '2026-13'/'2026-00'.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(id)) { res.status(400).json({ error: 'id must be a month (YYYY-MM)' }); return; }
  const body = pick<{ status: string }>(req.body, ['status']);
  if (!isPlanningPeriodStatus(body.status)) { res.status(400).json({ error: "status must be 'Open' or 'Closed'" }); return; }
  const existing = await repos.planningPeriods.get(id);
  const updated = existing
    ? await repos.planningPeriods.update(id, { status: body.status })
    : await repos.planningPeriods.create({ id, status: body.status });
  res.json(updated);
});

const PROJECT_FIELDS = ['name', 'location', 'startDate', 'endDate', 'status', 'description', 'ownerId', 'contractId'] as const;
apiRouter.get('/projects', async (_req, res) => { res.json(await repos.projects.list()); });
apiRouter.post('/projects', async (req, res) => {
  const body = pick<Project>(req.body, PROJECT_FIELDS);
  // REFERENCE-DATA INTEGRITY (Phase D): `ownerId` is a person reference to the
  // resources catalog by ID (the Owner SELECT stores the resource id). It is required
  // on create and must reference an existing resource.
  if (!(await existsRepo(repos.resources, body.ownerId))) {
    res.status(400).json({ error: 'ownerId must reference an existing resource' });
    return;
  }
  // REFERENCE-DATA INTEGRITY (Phase F2): `location` -> cities catalog (name) or the
  // 'Remote' sentinel. Optional; only a supplied non-empty value is checked.
  const locErr = await validateCatalogValue(body.location, 'location', cityNames, 'city (location catalog name) or "Remote"', [REMOTE_LOCATION]);
  if (locErr) { res.status(400).json({ error: locErr }); return; }
  // Phase G: startDate/endDate must be ISO (end >= start) — they drive timelines.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' });
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const item = { id: newId(), ...body } as Project;
  res.json(await repos.projects.create(item));
});
apiRouter.put('/projects/:id', async (req, res) => {
  const existing = await repos.projects.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<Project>(req.body, PROJECT_FIELDS);
  // REFERENCE-DATA INTEGRITY (Phase D): validate `ownerId` only when supplied, so a
  // partial edit that omits it is never blocked; a supplied value must be a resource id.
  if (body.ownerId !== undefined && body.ownerId !== null && body.ownerId !== '' && !(await existsRepo(repos.resources, body.ownerId))) {
    res.status(400).json({ error: 'ownerId must reference an existing resource' });
    return;
  }
  // REFERENCE-DATA INTEGRITY (Phase F2): validate any supplied `location`.
  const locErr = await validateCatalogValue(body.location, 'location', cityNames, 'city (location catalog name) or "Remote"', [REMOTE_LOCATION]);
  if (locErr) { res.status(400).json({ error: locErr }); return; }
  // Phase G: validate any supplied start/end date (ISO + end >= start).
  const dateErr = validateDateFields(body as Record<string, unknown>, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' });
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const updated = await repos.projects.update(req.params.id, body);
  res.json(updated);
});
apiRouter.delete('/projects/:id', async (req, res) => { await repos.projects.remove(req.params.id); res.status(204).send(); });

// --- B1: project sub-resources (real endpoints, seeded on REAL ids 1/2) -----

// REFERENCE-DATA INTEGRITY (Phase F2): `company` -> vendors catalog (name), `role`
// -> partner-roles catalog (name). `contact` stays FREE (external person). Both FKs
// optional at the validator level; the UI enforces required.
crud(apiRouter, 'project-partners', repos.projectPartners, ['projectId', 'company', 'role', 'contact', 'status'], [], async data => {
  const companyErr = await validateCatalogValue(data['company'], 'company', vendorNames, 'vendor (company catalog name)');
  if (companyErr) return companyErr;
  return validateCatalogValue(data['role'], 'role', partnerRoleNames, 'partner role (catalog name)');
});

crud(apiRouter, 'project-documents', repos.projectDocuments, ['projectId', 'name', 'type', 'size', 'uploadedAt', 'author', 'authorInitials']);

// PHASE D — work-package `assignee` is a person reference ('Unassigned' allowed).
// Phase G — start/end must be ISO (end >= start) when supplied.
crud(apiRouter, 'work-packages', repos.workPackages, ['projectId', 'name', 'startDate', 'endDate', 'status', 'progress', 'assignee'], [],
  async data => validateDateFields(data, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' })
    ?? await validatePersonRefs(data, ['assignee'], ['assignee']));

interface MilestoneEntry { id: string; projectId: string; name: string; date: string; status: 'Pending' | 'Achieved'; approvedBy?: string; approvedAt?: string }
const MILESTONE_FIELDS = ['projectId', 'name', 'date', 'status', 'approvedBy', 'approvedAt'] as const;
apiRouter.get('/milestones', async (_req, res) => { res.json(await repos.milestones.list()); });
apiRouter.post('/milestones', async (req, res) => {
  const body = pick<MilestoneEntry>(req.body, MILESTONE_FIELDS);
  // Phase G: the milestone `date` must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['date']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const item = { id: newId(), ...body } as MilestoneEntry;
  res.json(await repos.milestones.create(item));
});
apiRouter.put('/milestones/:id', async (req, res) => {
  const existing = await repos.milestones.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const previousStatus = existing.status;
  const body = pick<MilestoneEntry>(req.body, MILESTONE_FIELDS);
  // Phase G: validate the milestone `date` when supplied (ISO).
  const dateErr = validateDateFields(body as Record<string, unknown>, ['date']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const updated = await repos.milestones.update(req.params.id, body) as MilestoneEntry;
  // MILESTONE TRIGGER (SAL): when a milestone first transitions to 'Achieved',
  // make its fixed-price billing item billable by flipping every linked
  // BillingPlanItem still in 'Planned' to 'Ready'.
  // B-CONCURRENCY: serialize per billing item against the billing-plan-item PUT
  // (which writes the whole merged item) so this targeted status flip and a
  // concurrent PUT can't clobber each other. Re-read INSIDE the lock and re-check
  // the 'Planned' precondition against the freshest state.
  if (updated.status === 'Achieved' && previousStatus !== 'Achieved') {
    for (const bp of await repos.billingPlanItems.list()) {
      if (bp.milestoneId !== updated.id) continue;
      await withLock(`billing:${bp.id}`, async () => {
        const fresh = await repos.billingPlanItems.get(bp.id);
        if (fresh && fresh.status === 'Planned') await repos.billingPlanItems.update(bp.id, { status: 'Ready' });
      });
    }
  }
  res.json(updated);
});
apiRouter.delete('/milestones/:id', async (req, res) => {
  await repos.milestones.remove(req.params.id);
  res.status(204).send();
});

// REFERENCE-DATA INTEGRITY (Phase F2): `category` -> cost-categories catalog (name).
crud(apiRouter, 'project-financials', repos.projectFinancials, ['projectId', 'category', 'budget', 'actual'], ['budget', 'actual'], data =>
  validateCatalogValue(data['category'], 'category', costCategoryNames, 'cost category (catalog name)'));

// PROJECT COST CENTERS — bespoke handlers (the generic crud server-assigns the id;
// here the project cost-center IS one of the configuration cost-centers, so the id is
// CLIENT-SUPPLIED on create and must reference the cost-centers catalog). The `name`
// is DERIVED from the chosen catalog cost center (no longer hand-typed). `manager`
// stays a person reference (Phase D, optional). PUT cannot change the id (immutable key).
const PROJECT_COST_CENTER_FIELDS = ['projectId', 'name', 'manager', 'allocated', 'actual'] as const;
apiRouter.get('/project-cost-centers', async (_req, res) => { res.json(await repos.projectCostCenters.list()); });
apiRouter.post('/project-cost-centers', async (req, res) => {
  const id = req.body?.id;
  if (typeof id !== 'string' || id.length === 0) { res.status(400).json({ error: 'id is required and must reference a cost center (catalog id)' }); return; }
  const catalogCc = await repos.costCenters.get(id);
  if (!catalogCc) { res.status(400).json({ error: 'id must reference an existing cost center (catalog id)' }); return; }
  if (await repos.projectCostCenters.get(id)) { res.status(400).json({ error: `project cost center ${id} already exists` }); return; }
  const body = pick<ProjectCostCenter>(req.body, PROJECT_COST_CENTER_FIELDS);
  const bad = findInvalidNumericField(body, ['allocated', 'actual']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const personErr = await validatePersonRefs(body as Record<string, unknown>, ['manager']);
  if (personErr) { res.status(400).json({ error: personErr }); return; }
  // DERIVE the name from the chosen catalog cost center (never trust a hand-typed one).
  const item = { actual: 0, ...body, id, name: catalogCc.name } as ProjectCostCenter;
  res.json(await repos.projectCostCenters.create(item));
});
apiRouter.put('/project-cost-centers/:id', async (req, res) => {
  const existing = await repos.projectCostCenters.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ProjectCostCenter>(req.body, PROJECT_COST_CENTER_FIELDS);
  const bad = findInvalidNumericField(body, ['allocated', 'actual']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const personErr = await validatePersonRefs(body as Record<string, unknown>, ['manager']);
  if (personErr) { res.status(400).json({ error: personErr }); return; }
  const updated = await repos.projectCostCenters.update(req.params.id, body as Partial<ProjectCostCenter>);
  res.json(updated);
});
apiRouter.delete('/project-cost-centers/:id', async (req, res) => {
  const removed = await repos.projectCostCenters.remove(req.params.id);
  if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(204).send();
});

// PHASE D — task `assignee` is a person reference ('Unassigned' allowed).
// Phase G — `dueDate` must be ISO when supplied.
crud(apiRouter, 'project-tasks', repos.projectTasks, ['projectId', 'name', 'assignee', 'assigneeType', 'partnerId', 'dueDate', 'status', 'priority'], [],
  async data => validateDateFields(data, ['dueDate']) ?? await validatePersonRefs(data, ['assignee'], ['assignee']));

// PHASE D — issue `reportedBy` and `owner` are person references (optional).
// Phase G — `dueDate` must be ISO when supplied.
crud(apiRouter, 'project-issues', repos.projectIssues, ['projectId', 'title', 'type', 'severity', 'status', 'reportedBy', 'owner', 'dueDate', 'impact', 'actionPlan', 'escalated'], [],
  async data => validateDateFields(data, ['dueDate']) ?? await validatePersonRefs(data, ['reportedBy', 'owner']));

interface ChangeRequestEntry {
  id: string;
  projectId: string;
  title: string;
  description: string;
  requestedBy: string;
  owner: string;
  status: 'Draft' | 'Submitted' | 'Approved' | 'Rejected' | 'Implemented';
  impactScope: string;
  impactBudget: number;
  impactScheduleDays: number;
  priority: 'Low' | 'Medium' | 'High' | 'Critical';
  createdAt: string;
  // SERVER-PINNED creator (set once on POST from the verified actor; NOT in the
  // allow-list, so it can never be rewritten by a client). The self-approval
  // guard keys on this instead of the editable `requestedBy`/`owner` fields.
  createdBy?: string;
  decidedBy?: string;
  decidedAt?: string;
}
// impactBudget/impactScheduleDays are intentionally allowed to be negative
// (a CR can reduce scope/budget), so they are NOT validated as non-negative.
const CHANGE_REQUEST_FIELDS = ['projectId', 'title', 'description', 'requestedBy', 'owner', 'status', 'impactScope', 'impactBudget', 'impactScheduleDays', 'priority', 'createdAt'] as const;
apiRouter.get('/change-requests', async (_req, res) => { res.json(await repos.changeRequests.list()); });
apiRouter.post('/change-requests', async (req, res) => {
  const body = pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_FIELDS);
  // REFERENCE-DATA INTEGRITY (Phase D): the CR `owner` is a person reference to the
  // resources catalog (requestedBy/decidedBy are server-pinned actor ids, not names).
  const personErr = await validatePersonRefs(body as unknown as Record<string, unknown>, ['owner']);
  if (personErr) { res.status(400).json({ error: personErr }); return; }
  // `createdBy` is pinned to the verified actor AFTER the spread so the body
  // cannot supply/override it (it is also absent from CHANGE_REQUEST_FIELDS). It
  // is the immutable SoD basis the approval guard below trusts.
  const item = { id: newId(), createdAt: new Date().toISOString(), ...body, createdBy: actorId(req) } as ChangeRequestEntry;
  res.json(await repos.changeRequests.create(item));
});
apiRouter.put('/change-requests/:id', async (req, res) => {
  const stored = await repos.changeRequests.get(req.params.id);
  if (stored === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  // The api.service `ChangeRequest` interface predates the server-only
  // `createdBy` SoD field; the persisted row carries it (schema + create pin), so
  // read it through the richer server-side `ChangeRequestEntry` view.
  const existing = stored as unknown as ChangeRequestEntry;
  const body = pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_FIELDS);
  // REFERENCE-DATA INTEGRITY (Phase D): validate any supplied `owner` against the
  // resources catalog. Omitted/empty owner passes (partial edits are not blocked).
  const personErr = await validatePersonRefs(body as unknown as Record<string, unknown>, ['owner']);
  if (personErr) { res.status(400).json({ error: personErr }); return; }
  const merged = { ...existing, ...body } as ChangeRequestEntry;
  // CR APPROVAL — SEGREGATION OF DUTIES + AUTHORIZATION. Approved CRs feed
  // effectiveBudgetForProject (finance.util), so unilateral self-approval lets a
  // requester inflate their own project budget and mask an over-budget state.
  // Mirror the approval-engine / time-entry SoD: on the transition INTO
  // 'Approved', (1) only delivery-executive/admin may approve, and (2) the
  // approver may be neither the CR's requester nor its owner.
  const approving = merged.status === 'Approved' && existing.status !== 'Approved';
  if (approving) {
    const role = trustedRole(req);
    if (role !== 'delivery-executive' && role !== 'admin') {
      res.status(403).json({ error: 'Only delivery-executive or admin may approve a change request' });
      return;
    }
    // SoD basis is the SERVER-PINNED creator (`createdBy`), NOT the editable
    // `requestedBy`/`owner` (a requester could otherwise rewrite those in a Draft
    // PUT to a dummy id and then self-approve). Fall back to the legacy fields
    // only for CRs created before `createdBy` existed, so legitimate flows for
    // older rows keep their guard.
    const decider = actorId(req);
    const creator = existing.createdBy;
    const selfApproving = creator !== undefined
      ? decider === creator
      : decider === existing.requestedBy || decider === existing.owner;
    if (selfApproving) {
      res.status(403).json({ error: 'Segregation of duties: the change request creator cannot approve their own change request' });
      return;
    }
  }
  // CR DECISION: when a CR reaches a terminal decision, stamp who/when (server
  // side, from the verified actor) if not already recorded. decidedBy/decidedAt
  // are not client-settable fields, so they cannot be forged via the body.
  if ((merged.status === 'Approved' || merged.status === 'Rejected') && !merged.decidedAt) {
    merged.decidedAt = new Date().toISOString();
    merged.decidedBy = actorId(req);
  }
  const updated = await repos.changeRequests.update(req.params.id, merged);
  res.json(updated);
});
apiRouter.delete('/change-requests/:id', async (req, res) => {
  await repos.changeRequests.remove(req.params.id);
  res.status(204).send();
});

// Configuration-level cost centers (B16)
// PHASE D — `manager` is a person reference (optional).
crud(apiRouter, 'cost-centers', repos.costCenters, ['name', 'manager', 'allocated', 'actual'], ['allocated', 'actual'],
  data => validatePersonRefs(data, ['manager']));

// --- Commercial domain (ADR-0001): Customers, Contracts, Orders, OrderLines ---

// REFERENCE-DATA INTEGRITY (Phase F2): `industry` -> industries catalog (name),
// `country` -> countries catalog (country NAME, matching the seeded display). Both
// optional; only supplied non-empty values are checked.
crud(apiRouter, 'customers', repos.customers, ['name', 'industry', 'country'], [], async data => {
  const indErr = await validateCatalogValue(data['industry'], 'industry', industryNames, 'industry (catalog name)');
  if (indErr) return indErr;
  return validateCatalogValue(data['country'], 'country', countryNames, 'country (catalog name)');
});

interface ContractEntry { id: string; customerId: string; name: string; type: string; totalValue: number; currency: string; status: string; startDate: string; endDate: string }

interface OrderEntry { id: string; contractId: string; type: string; partnerId: string; amount: number; currency: string; status: string; orderDate: string; invoiceNumber?: string; invoiceDate?: string }

// INVOICE NUMBERING: sequential server-side counter for compliant invoice
// numbers (INV-<year>-<zero-padded seq>). The seeded invoiced order O1 already
// holds INV-2026-0001, so the next issued invoice is 0002.
const INVOICE_YEAR = 2026;
let invoiceSeq = 1;
function nextInvoiceNumber(): string {
  return `INV-${INVOICE_YEAR}-${String(++invoiceSeq).padStart(4, '0')}`;
}
/** SERVER-SET: assign a sequential invoice number + date when an order first
 *  becomes 'Invoiced' and none is set yet. Mutates the order in place. */
function applyInvoiceNumbering(order: OrderEntry): void {
  if (order.status === 'Invoiced' && !order.invoiceNumber) {
    order.invoiceNumber = nextInvoiceNumber();
    order.invoiceDate = new Date().toISOString().slice(0, 10);
  }
}

interface OrderLineEntry { id: string; orderId: string; projectId: string; description: string; amount: number }

// --- Commercial referential integrity: explicit handlers (crud() cannot express FK rules) ---

const CONTRACT_FIELDS = ['customerId', 'name', 'type', 'totalValue', 'currency', 'status', 'startDate', 'endDate'] as const;

apiRouter.get('/contracts', async (_req, res) => { res.json(await repos.contracts.list()); });
apiRouter.post('/contracts', async (req, res) => {
  const body = pick<ContractEntry>(req.body, CONTRACT_FIELDS);
  if (!(await existsRepo(repos.customers, body.customerId))) { res.status(400).json({ error: 'customerId must reference an existing customer' }); return; }
  const bad = findInvalidNumericField(body, ['totalValue']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const curErr = await validateCurrency(body);
  if (curErr) { res.status(400).json({ error: curErr }); return; }
  // Phase G: startDate/endDate must be ISO (end >= start) when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' });
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const item = { id: newId(), ...body } as ContractEntry;
  const created = await repos.contracts.create(item as unknown as Contract);
  res.json(created);
});
apiRouter.put('/contracts/:id', async (req, res) => {
  const existing = await repos.contracts.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ContractEntry>(req.body, CONTRACT_FIELDS);
  if (body.customerId !== undefined && !(await existsRepo(repos.customers, body.customerId))) { res.status(400).json({ error: 'customerId must reference an existing customer' }); return; }
  const bad = findInvalidNumericField(body, ['totalValue']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const curErr = await validateCurrency(body);
  if (curErr) { res.status(400).json({ error: curErr }); return; }
  // Phase G: validate any supplied start/end date (ISO + end >= start).
  const dateErr = validateDateFields(body as Record<string, unknown>, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' });
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const updated = await repos.contracts.update(req.params.id, body as Partial<Contract>);
  res.json(updated);
});
apiRouter.delete('/contracts/:id', async (req, res) => {
  await repos.contracts.remove(req.params.id);
  res.status(204).send();
});

const ORDER_FIELDS = ['contractId', 'type', 'partnerId', 'amount', 'currency', 'status', 'orderDate'] as const;

/** Validate an order's contract FK and the Purchase/Customer partner rules. Returns an error string or null. */
async function validateOrder(body: Partial<OrderEntry>, current?: OrderEntry): Promise<string | null> {
  const type = body.type ?? current?.type;
  const partnerId = body.partnerId ?? current?.partnerId ?? '';
  if (body.contractId !== undefined || !current) {
    if (!(await existsRepo(repos.contracts, body.contractId ?? current?.contractId))) return 'contractId must reference an existing contract';
  }
  const curErr = await validateCurrency(body);
  if (curErr) return curErr;
  if (type === 'Purchase') {
    if (!(await existsRepo(repos.projectPartners, partnerId))) return 'Purchase orders require an existing partnerId';
  } else if (type === 'Customer') {
    if (partnerId !== '') return 'Customer orders must not set a partnerId';
  }
  return null;
}

apiRouter.get('/orders', async (_req, res) => { res.json(await repos.orders.list()); });
apiRouter.post('/orders', async (req, res) => {
  const body = pick<OrderEntry>(req.body, ORDER_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const fkError = await validateOrder(body);
  if (fkError) { res.status(400).json({ error: fkError }); return; }
  // Phase G: orderDate must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['orderDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const item = { id: newId(), partnerId: '', ...body } as OrderEntry;
  // INVOICE NUMBERING: an order created directly as 'Invoiced' gets a number now.
  // Serialize on the shared invoice-sequence so the ++invoiceSeq increment is
  // atomic relative to concurrent order writes (no burned/duplicated sequence).
  const created = await withLock('invoice-seq', async () => {
    applyInvoiceNumbering(item);
    return repos.orders.create(item as unknown as Order);
  });
  res.json(created);
});
apiRouter.put('/orders/:id', async (req, res) => {
  const existing = await repos.orders.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<OrderEntry>(req.body, ORDER_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const fkError = await validateOrder(body, existing as unknown as OrderEntry);
  if (fkError) { res.status(400).json({ error: fkError }); return; }
  // Phase G: orderDate must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['orderDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  // INVOICE NUMBERING: assign a sequential number/date on transition to
  // 'Invoiced'. invoiceNumber/invoiceDate are not in ORDER_FIELDS, so the
  // client can never set them; they are strictly server-assigned.
  // B-CONCURRENCY: serialize the assign-and-persist for THIS order on the shared
  // invoice-sequence key and re-read the order inside the lock, so two
  // concurrent PUTs transitioning the same order to 'Invoiced' assign exactly
  // one number (the second sees the number already set) — no gap in the
  // strictly-sequential INV-YEAR-#### series and no double-advanced counter.
  const updated = await withLock('invoice-seq', async () => {
    const current = (await repos.orders.get(req.params.id)) as OrderEntry | undefined;
    const merged = { ...(current ?? (existing as unknown as OrderEntry)), ...body };
    applyInvoiceNumbering(merged);
    return repos.orders.update(req.params.id, merged as Partial<Order>);
  });
  res.json(updated);
});
apiRouter.delete('/orders/:id', async (req, res) => {
  await repos.orders.remove(req.params.id);
  res.status(204).send();
});

const ORDER_LINE_FIELDS = ['orderId', 'projectId', 'description', 'amount'] as const;
apiRouter.get('/order-lines', async (_req, res) => { res.json(await repos.orderLines.list()); });
apiRouter.post('/order-lines', async (req, res) => {
  const body = pick<OrderLineEntry>(req.body, ORDER_LINE_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  if (!(await existsRepo(repos.orders, body.orderId))) { res.status(400).json({ error: 'orderId must reference an existing order' }); return; }
  if (!(await existsRepo(repos.projects, body.projectId))) { res.status(400).json({ error: 'projectId must reference an existing project' }); return; }
  const item = { id: newId(), ...body } as OrderLineEntry;
  const created = await repos.orderLines.create(item as unknown as OrderLine);
  res.json(created);
});
apiRouter.put('/order-lines/:id', async (req, res) => {
  const existing = await repos.orderLines.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<OrderLineEntry>(req.body, ORDER_LINE_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  if (body.orderId !== undefined && !(await existsRepo(repos.orders, body.orderId))) { res.status(400).json({ error: 'orderId must reference an existing order' }); return; }
  if (body.projectId !== undefined && !(await existsRepo(repos.projects, body.projectId))) { res.status(400).json({ error: 'projectId must reference an existing project' }); return; }
  const updated = await repos.orderLines.update(req.params.id, body as Partial<OrderLine>);
  res.json(updated);
});
apiRouter.delete('/order-lines/:id', async (req, res) => {
  await repos.orderLines.remove(req.params.id);
  res.status(204).send();
});

type BillingType =
  | 'Milestone'
  | 'Recurring'
  | 'TimeAndMaterials'
  | 'Capped'
  | 'Advance'
  | 'Progress'
  | 'Expense'
  | 'CreditNote';

interface BillingPlanEntry {
  id: string;
  contractId: string;
  projectId?: string;
  type: BillingType;
  label: string;
  milestoneId?: string;
  recurrence?: 'Monthly' | 'Quarterly' | 'Annual';
  expectedDate?: string;
  amount: number;
  capAmount?: number;
  progressPct?: number;
  markupPct?: number;
  retentionPct?: number;
  taxRatePct?: number;
  paymentTermsDays?: number;
  currency: string;
  status: 'Planned' | 'Ready' | 'Invoiced' | 'Paid' | 'Blocked';
  issuedDate?: string;
  dueDate?: string;
  paidDate?: string;
  orderId?: string;
  notes?: string;
}

const BILLING_PLAN_FIELDS = ['contractId', 'projectId', 'type', 'label', 'milestoneId', 'recurrence', 'expectedDate', 'amount', 'capAmount', 'progressPct', 'markupPct', 'retentionPct', 'taxRatePct', 'paymentTermsDays', 'currency', 'status', 'issuedDate', 'dueDate', 'paidDate', 'orderId', 'notes'] as const;
const BILLING_PLAN_NUMERIC_FIELDS = ['amount', 'capAmount', 'progressPct', 'markupPct', 'retentionPct', 'taxRatePct', 'paymentTermsDays'] as const;

/**
 * Validate billing-plan numeric fields. `amount` may be negative ONLY when the
 * item is a CreditNote (nota di credito); every other numeric field, and a
 * non-CreditNote amount, must be a finite non-negative number. Returns the
 * offending field name, or null when all present fields are valid.
 */
function findInvalidBillingNumericField(body: Partial<BillingPlanEntry>, type: BillingType | undefined): string | null {
  if (body.amount !== undefined) {
    const amountOk = type === 'CreditNote'
      ? typeof body.amount === 'number' && Number.isFinite(body.amount)
      : isNonNegNumber(body.amount);
    if (!amountOk) return 'amount';
  }
  for (const field of BILLING_PLAN_NUMERIC_FIELDS) {
    if (field === 'amount') continue;
    if (body[field] !== undefined && !isNonNegNumber(body[field])) return field;
  }
  return null;
}

// --- #14 BILLING AUTOMATION -------------------------------------------------
//
// Two repo-backed automations layered on top of the existing billing-plan-item
// validation/RBAC/audit (handlers stay async). Both are deliberately PRAGMATIC:
// they enforce only what the persisted data model already supports and invent
// no new fields. `notes` (an existing field) is reused to surface a cap-breach
// flag; there is no `accruedAmount` column, so accrual is DERIVED on the fly.

/** A "capped not-to-exceed" item is type 'Capped' OR any item carrying a capAmount. */
function isCappedNature(item: Pick<BillingPlanEntry, 'type' | 'capAmount'>): boolean {
  return item.type === 'Capped' || Number.isFinite(item.capAmount);
}

/** Marker prepended to `notes` when accrued T&M has breached the cap (idempotent). */
const CAP_EXCEEDED_FLAG = '[CAP-EXCEEDED]';

/**
 * Accrued T&M for a project, DERIVED as Σ(approved time-entry hours × resource
 * billRate) — the same as-incurred rule the finance util's recognitionSchedule
 * uses. Resource billRates are denominated in the base currency (EUR), so the
 * returned accrual is a BASE-currency figure; the caller converts a per-item cap
 * into base before comparing. Returns undefined when accrual is not derivable
 * (no projectId), so the caller can skip the accrued<=cap check rather than
 * treat "no data" as zero accrual.
 */
async function accruedTAndM(item: Pick<BillingPlanEntry, 'projectId'>): Promise<number | undefined> {
  if (!item.projectId) return undefined;
  const [entries, rawResources] = await Promise.all([repos.timeEntries.list(), repos.resources.list()]);
  // Phase E: use EFFECTIVE bill rates (override ?? rate card), not the raw column.
  const resources = await resolveResourceRates(rawResources);
  const billRateById = new Map(resources.map(r => [r.id, r.billRate ?? 0]));
  let accrued = 0;
  for (const t of entries) {
    if (t.status !== 'Approved' || t.projectId !== item.projectId) continue;
    const rate = billRateById.get(t.resourceId) ?? 0;
    const hours = Number.isFinite(t.hours) ? t.hours : 0;
    accrued += hours * rate;
  }
  return accrued;
}

/**
 * Count the cap-bearing billing items on a project. The accrued-vs-cap FLAG is
 * only meaningful when a project has EXACTLY ONE cap-bearing item: accrual is
 * derived from the project's whole approved time (time entries link to a project,
 * not to a specific billing item), so with multiple caps the same hours would be
 * counted against every cap and the flag would fire too eagerly. We therefore
 * scope the flag to the single-cap case (the amount>cap hard reject is unaffected
 * and always applies). `excludeId` skips the item under update so a re-PUT of the
 * only capped item still counts as one.
 */
async function cappedItemCountForProject(projectId: string, excludeId?: string): Promise<number> {
  const all = (await repos.billingPlanItems.list()) as unknown as BillingPlanEntry[];
  return all.filter(bp => bp.projectId === projectId && bp.id !== excludeId && isCappedNature(bp)).length;
}

/**
 * CAPPED not-to-exceed enforcement for a fully-merged billing item.
 *
 * 1) Hard reject (returns an error string) when the item is capped and its
 *    `amount` exceeds `capAmount` — the create/update must not persist an
 *    overcap amount.
 * 2) When accrued T&M is derivable AND the project has exactly one cap-bearing
 *    item (see cappedItemCountForProject), enforce accrued <= cap: if accrued has
 *    breached the cap, flag the item by prepending CAP_EXCEEDED_FLAG to `notes`
 *    (idempotent — only added once) so the breach is visible without inventing a
 *    field. This is a FLAG, not a reject, because accrual comes from time entries
 *    rather than the request body. Accrued (base currency, from EUR-denominated
 *    resource rates) is compared against the cap CONVERTED to base via the FX
 *    table, so a non-base-currency cap is no longer apples-to-oranges.
 *
 * Returns `{ error }` to reject, or `{ patch }` (possibly empty) to apply on top
 * of the caller's merged item before persisting.
 */
async function enforceCappedBilling(
  merged: BillingPlanEntry,
): Promise<{ error: string } | { patch: Partial<BillingPlanEntry> }> {
  if (!isCappedNature(merged) || !Number.isFinite(merged.capAmount)) return { patch: {} };
  const cap = merged.capAmount as number;
  // (1) amount must never exceed the cap (raw, same-currency comparison: both
  //     `amount` and `capAmount` are in the item's own currency).
  if (Number.isFinite(merged.amount) && merged.amount > cap) {
    return { error: `amount ${merged.amount} exceeds capAmount ${cap} (not-to-exceed)` };
  }
  const hasFlag = (merged.notes ?? '').includes(CAP_EXCEEDED_FLAG);
  // (2) accrued T&M must stay within the cap; flag (don't reject) when it breaks.
  // Only attribute project accrual to THIS cap when it is the project's sole cap
  // (otherwise the same hours would breach every cap). With multiple caps we skip
  // the flag entirely (and clear any stale flag below).
  const soleCap = merged.projectId ? (await cappedItemCountForProject(merged.projectId, merged.id)) === 0 : false;
  const accrued = soleCap ? await accruedTAndM(merged) : undefined;
  if (accrued !== undefined) {
    // Normalise the cap to base currency to match the base-denominated accrual.
    const fxRows = (await repos.fxRates.list()) as unknown as FxRate[];
    const capInBase = convertToBase(cap, merged.currency, fxRows);
    if (accrued > capInBase) {
      if (hasFlag) return { patch: {} }; // already flagged -> idempotent no-op
      const suffix = merged.notes ? ` ${merged.notes}` : '';
      return { patch: { notes: `${CAP_EXCEEDED_FLAG} accrued ${Math.round(accrued)} > cap ${Math.round(capInBase)} (${BASE_CURRENCY})${suffix}` } };
    }
  }
  // Accrued back within the cap (or flag no longer applicable): clear a
  // previously-set flag so it doesn't stick.
  if (hasFlag) {
    const cleaned = (merged.notes ?? '').replace(CAP_EXCEEDED_FLAG, '').replace(/\s+/g, ' ').trim();
    return { patch: { notes: cleaned || undefined } };
  }
  return { patch: {} };
}

/**
 * PROGRESS / POC auto-advance: when a Progress item's progressPct reaches 100%,
 * advance a still-'Planned' item to 'Ready' — mirroring the milestone→'Ready'
 * trigger above. Idempotent: only a 'Planned' item is advanced, and only when the
 * incoming progressPct actually CHANGED (so re-PUTting 100% never churns status,
 * and a manual Blocked/Invoiced state is never overwritten). Returns the status
 * patch to apply, or an empty patch when nothing should change.
 */
function progressAutoAdvance(
  merged: BillingPlanEntry,
  incomingProgressPct: number | undefined,
  previousProgressPct: number | undefined,
): Partial<BillingPlanEntry> {
  if (merged.type !== 'Progress') return {};
  const changed = incomingProgressPct !== undefined && incomingProgressPct !== previousProgressPct;
  if (!changed) return {};
  if (incomingProgressPct >= 100 && merged.status === 'Planned') return { status: 'Ready' };
  return {};
}

apiRouter.get('/billing-plan-items', async (_req, res) => { res.json(await repos.billingPlanItems.list()); });
apiRouter.post('/billing-plan-items', async (req, res) => {
  const body = pick<BillingPlanEntry>(req.body, BILLING_PLAN_FIELDS);
  const bad = findInvalidBillingNumericField(body, body.type);
  if (bad) {
    const rule = bad === 'amount' ? 'amount must be a non-negative number (negative allowed only for CreditNote)' : `${bad} must be a non-negative number`;
    res.status(400).json({ error: rule });
    return;
  }
  const curErr = await validateCurrency(body);
  if (curErr) { res.status(400).json({ error: curErr }); return; }
  // Phase G: every billing date (expected/issued/due/paid) must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['expectedDate', 'issuedDate', 'dueDate', 'paidDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const item = { id: newId(), ...body } as BillingPlanEntry;
  // #14 CAPPED not-to-exceed: reject an overcap amount on create; otherwise apply
  // any cap-breach flag the accrued-T&M check produced before persisting.
  const capResult = await enforceCappedBilling(item);
  if ('error' in capResult) { res.status(400).json({ error: capResult.error }); return; }
  Object.assign(item, capResult.patch);
  const created = await repos.billingPlanItems.create(item as unknown as BillingPlanItem);
  res.json(created);
});
apiRouter.put('/billing-plan-items/:id', async (req, res) => {
  // Cheap, shared-state-free validation up front (existence is re-checked under
  // the lock against the freshest state below).
  const existing = await repos.billingPlanItems.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<BillingPlanEntry>(req.body, BILLING_PLAN_FIELDS);
  // Resolve the effective type for the negative-amount rule: an incoming type
  // overrides, otherwise fall back to the stored item's type.
  const effectiveType = body.type ?? (existing as unknown as BillingPlanEntry).type;
  const bad = findInvalidBillingNumericField(body, effectiveType);
  if (bad) {
    const rule = bad === 'amount' ? 'amount must be a non-negative number (negative allowed only for CreditNote)' : `${bad} must be a non-negative number`;
    res.status(400).json({ error: rule });
    return;
  }
  const curErr = await validateCurrency(body);
  if (curErr) { res.status(400).json({ error: curErr }); return; }
  // Phase G: validate any supplied billing date (expected/issued/due/paid) as ISO.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['expectedDate', 'issuedDate', 'dueDate', 'paidDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }

  // B-CONCURRENCY: serialize the read-merge-write per billing item against the
  // milestone→'Ready' trigger (which also writes this item) AND other concurrent
  // PUTs, so the full-object write below can't clobber a status another path
  // just set. Re-read the item INSIDE the lock so we merge onto the freshest
  // state rather than the snapshot read before the lock.
  const result = await withLock(`billing:${req.params.id}`, async (): Promise<{ status: number; body: unknown }> => {
    const fresh = await repos.billingPlanItems.get(req.params.id);
    if (fresh === undefined) return { status: 404, body: { error: 'Not found' } };
    const prev = fresh as unknown as BillingPlanEntry;
    // Merge the incoming patch onto the stored item so automations see the
    // effective post-update state (effectiveType already resolved above).
    const merged = { ...prev, ...body, type: effectiveType } as BillingPlanEntry;

    // #14 PROGRESS auto-advance: when progressPct CHANGES and reaches 100%, advance
    // a still-'Planned' Progress item to 'Ready' (same trigger pattern as the
    // milestone→'Ready' flip). Idempotent — fold the status into the merged item
    // first so the cap check below also sees the advanced status.
    Object.assign(merged, progressAutoAdvance(merged, body.progressPct, prev.progressPct));

    // #14 CAPPED not-to-exceed: reject an overcap amount; otherwise apply any
    // accrued-T&M cap-breach flag (or clear a stale one) onto the merged item.
    const capResult = await enforceCappedBilling(merged);
    if ('error' in capResult) return { status: 400, body: { error: capResult.error } };
    Object.assign(merged, capResult.patch);

    // Persist the full merged item so the automation-derived status/notes are
    // written alongside the client patch in a single update.
    const updated = await repos.billingPlanItems.update(req.params.id, merged as Partial<BillingPlanItem>);
    return { status: 200, body: updated };
  });
  res.status(result.status).json(result.body);
});
apiRouter.delete('/billing-plan-items/:id', async (req, res) => {
  await repos.billingPlanItems.remove(req.params.id);
  res.status(204).send();
});

// --- Multi-currency foundation ----------------------------------------------

/**
 * FX rates expressed as the base-currency (EUR) value of 1 unit of `currency`.
 * EUR is the base, so its rateToBase is 1. Rollups that span currencies must
 * convert each amount via `amount * rateToBase` before summing.
 */
interface FxRateEntry { currency: string; rateToBase: number }
const BASE_CURRENCY = 'EUR';

// Read is open to everyone (a GET, so roleGate already lets it through). Writes
// are optional and admin-only: an upsert keyed by currency that re-pegs or adds
// a rate. The base currency's peg is fixed at 1 and cannot be changed.
apiRouter.get('/fx-rates', async (_req, res) => {
  // The natural-key adapter carries a synthetic `id` mirroring `currency`;
  // project each row to the exact legacy client shape ({ currency, rateToBase }).
  const all = await repos.fxRates.list();
  res.json(all.map(r => ({ currency: r.currency, rateToBase: r.rateToBase })));
});
apiRouter.put('/fx-rates/:currency', async (req, res) => {
  // ADMIN-ONLY: roleGate's generic rules don't cover '/fx-rates', so enforce here.
  if (trustedRole(req) !== 'admin') {
    res.status(403).json({ error: 'Only admin may modify FX rates' });
    return;
  }
  const currency = String(req.params.currency).toUpperCase();
  if (currency === BASE_CURRENCY) {
    res.status(400).json({ error: `${BASE_CURRENCY} is the base currency; its rate is fixed at 1` });
    return;
  }
  const body = pick<FxRateEntry>(req.body, ['rateToBase']);
  // A rate must be a finite, strictly positive number (it is a multiplier/divisor).
  if (!(isNonNegNumber(body.rateToBase) && body.rateToBase > 0)) {
    res.status(400).json({ error: 'rateToBase must be a positive number' });
    return;
  }
  // UPSERT keyed by currency: the natural-key adapter addresses rows by the
  // `currency` column (its synthetic `id` mirrors `currency`). update() returns
  // undefined when the row is absent, so add it via create() in that case.
  const existing = await repos.fxRates.get(currency);
  const row = existing === undefined
    ? await repos.fxRates.create({ id: currency, currency, rateToBase: body.rateToBase } as FxRateRow)
    : await repos.fxRates.update(currency, { rateToBase: body.rateToBase } as Partial<FxRateRow>);
  // Echo the exact legacy shape ({ currency, rateToBase }); drop the synthetic id.
  if (row) {
    res.json({ currency: row.currency, rateToBase: row.rateToBase });
  } else {
    res.json(undefined);
  }
});

// --- Approval workflow engine -----------------------------------------------

type ApprovalKind = 'TimeEntry' | 'Expense' | 'Milestone' | 'ChangeRequest' | 'Invoice' | 'Allocation';
type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected';
interface ApprovalStep { role: string; status: ApprovalStatus; decidedBy?: string; decidedAt?: string; approverId?: string; note?: string }
interface ApprovalRequestEntry {
  id: string;
  kind: ApprovalKind;
  refId: string;
  projectId?: string;
  amount?: number;
  requestedBy: string;
  status: ApprovalStatus;
  steps: ApprovalStep[];
  currentStep: number;
  createdAt: string;
  slaDueAt?: string;
  note?: string;
}

const APPROVAL_KINDS: readonly ApprovalKind[] = ['TimeEntry', 'Expense', 'Milestone', 'ChangeRequest', 'Invoice', 'Allocation'];
/** Amount above which an approval is escalated to a two-step delivery+finance chain. */
const APPROVAL_HIGH_VALUE_THRESHOLD = 50000;
/** SLA target measured in whole days from creation. */
const APPROVAL_SLA_DAYS = 3;

/**
 * RULES evaluator: build the ordered approver chain for an approval request.
 * Amount-threshold routing takes precedence — a high-value item (> 50k) always
 * routes to delivery-executive then finance (sequential). Otherwise a single
 * approver is chosen by kind.
 */
function buildApprovalSteps(kind: ApprovalKind, amount: number | undefined): ApprovalStep[] {
  const roles: string[] =
    typeof amount === 'number' && amount > APPROVAL_HIGH_VALUE_THRESHOLD
      ? ['delivery-executive', 'finance']
      : approverRolesByKind(kind);
  return roles.map(role => ({ role, status: 'Pending' }));
}

/** Single-approver routing by kind (used when no high-value escalation applies). */
function approverRolesByKind(kind: ApprovalKind): string[] {
  switch (kind) {
    case 'TimeEntry':
    case 'Expense':
      return ['resource-manager'];
    case 'Milestone':
    case 'ChangeRequest':
      return ['delivery-executive'];
    case 'Invoice':
      return ['finance'];
    default:
      return ['delivery-executive'];
  }
}

function slaDueFrom(createdAtIso: string): string {
  return new Date(new Date(createdAtIso).getTime() + APPROVAL_SLA_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// `requestedBy` is intentionally NOT client-settable: it is the SoD basis the
// decision endpoint compares the trusted decider against, so it is pinned to the
// verified actor at creation rather than copied from the (forgeable) body.
const APPROVAL_REQUEST_FIELDS = ['kind', 'refId', 'projectId', 'amount', 'note'] as const;

apiRouter.get('/approval-requests', async (_req, res) => { res.json(await repos.approvalRequests.list()); });
apiRouter.post('/approval-requests', async (req, res) => {
  const body = pick<ApprovalRequestEntry>(req.body, APPROVAL_REQUEST_FIELDS);
  if (typeof body.kind !== 'string' || !APPROVAL_KINDS.includes(body.kind as ApprovalKind)) {
    res.status(400).json({ error: `kind must be one of: ${APPROVAL_KINDS.join(', ')}` });
    return;
  }
  if (typeof body.refId !== 'string' || body.refId.length === 0) {
    res.status(400).json({ error: 'refId is required' });
    return;
  }
  if (body.amount !== undefined && !isNonNegNumber(body.amount)) {
    res.status(400).json({ error: 'amount must be a non-negative number' });
    return;
  }
  const createdAt = new Date().toISOString();
  const item: ApprovalRequestEntry = {
    id: `AR${newId()}`,
    kind: body.kind as ApprovalKind,
    refId: body.refId,
    projectId: body.projectId,
    amount: body.amount,
    // SoD basis: pinned to the SERVER-VERIFIED actor, never a client-supplied
    // value (excluded from the create allow-list), so the requester cannot forge
    // a different identity and defeat the self-approval guard at /decision.
    requestedBy: actorId(req),
    status: 'Pending',
    steps: buildApprovalSteps(body.kind as ApprovalKind, body.amount),
    currentStep: 0,
    createdAt,
    slaDueAt: slaDueFrom(createdAt),
    note: body.note,
  };
  const created = await repos.approvalRequests.create(item as ApprovalRequest);
  res.json(created);
});
/**
 * Build the explicit audit entry for the SYSTEM-DRIVEN assignment status
 * transition the allocation-decision hook applies. The decision endpoint's own
 * audit-middleware entry targets `/approval-requests/:id/decision` — it never
 * observes the assignment mutation this hook performs directly through the
 * repository (bypassing the `PUT /assignments/:id` route), so without an
 * explicit entry that transition would be invisible in the append-only trail.
 * Mirrors the middleware's shape (`AuditEntry`, same id prefix, same
 * before/after/changedKeys convention) and its TRUSTED-actor attribution
 * (`auditActorId`/`trustedRole`, never the raw spoofable `X-User-*` headers)
 * — see the "AUDIT ATTRIBUTION INTEGRITY" note on the middleware above.
 *
 * SCOPE (B3): this builder is for the LEGACY bare-refId approval only, where the
 * governed entity genuinely IS the assignment. A B3 decision governs a MONTH
 * ROW and is recorded by `monthTransitionAudit` below — the two must not be
 * conflated: `before`/`after` here are Assignment snapshots differing only in
 * `status`, which cannot express what a month decision changed.
 */
function allocationTransitionAudit(req: Request, assig: Assignment, newStatus: Assignment['status'], path: string): AuditLog {
  const afterAssig: Assignment = { ...assig, status: newStatus };
  const before = cloneEntity(assig);
  const after = cloneEntity(afterAssig);
  const entry: AuditEntry = {
    id: `AL${newId()}`,
    at: new Date().toISOString(),
    actorId: auditActorId(req),
    actorRole: trustedRole(req),
    method: 'PUT',
    path,
    statusCode: 200,
    before,
    after,
    changedKeys: diffChangedKeys(before, after),
  };
  return entry as unknown as AuditLog;
}

/**
 * Build the explicit audit entry for a MONTH ROW's decided transition (B3).
 *
 * The entity governed by an allocation decision is the (assignment, month) pair,
 * so the trail must record THAT row's own before/after — its `status`,
 * `approvalId` and `approverNote` — not the assignment's. Auditing the
 * assignment instead loses the decision entirely whenever the derived rollup
 * does not move: two sibling months decided Approved and Rejected in one batch
 * both roll up to the same assignment status, so both entries would show
 * `changedKeys: []` and neither would say what was decided.
 *
 * NO SECOND ENTRY is written for the assignment's derived-status change, and
 * that omission is deliberate: the rollup is a COMPUTED CONSEQUENCE of the month
 * decision (`deriveAssignmentStatus` over the month rows), not an independent
 * governance act. This entry is the record of what was decided; the assignment's
 * status can always be re-derived from the month rows it summarises.
 *
 * Same shape, id prefix and TRUSTED-actor attribution as the builder above
 * (`auditActorId`/`trustedRole`, never the raw spoofable `X-User-*` headers) —
 * see the "AUDIT ATTRIBUTION INTEGRITY" note on the middleware. `method` stays
 * 'PUT' like the sibling builder: these are synthetic entries for a state
 * transition applied straight through the repository, so it describes the
 * mutation, not the HTTP verb that triggered it (which may be the batch POST).
 */
function monthTransitionAudit(req: Request, rowBefore: AssignmentMonth, rowAfter: AssignmentMonth): AuditLog {
  const before = cloneEntity(rowBefore);
  const after = cloneEntity(rowAfter);
  const entry: AuditEntry = {
    id: `AL${newId()}`,
    at: new Date().toISOString(),
    actorId: auditActorId(req),
    actorRole: trustedRole(req),
    method: 'PUT',
    path: `/assignment-months/${rowBefore.id}`,
    statusCode: 200,
    before,
    after,
    changedKeys: diffChangedKeys(before, after),
  };
  return entry as unknown as AuditLog;
}

/** The SERVER-VERIFIED principal driving a decision. Never client-supplied: a
 *  client-controlled `by` would defeat the SoD check and forge the recorded
 *  approver. Resolved once by the caller and passed down unchanged. */
interface DeciderContext { by: string; decidingRole: string; deciderResourceId: string | undefined }
/** What `decideOneApproval` gives back: the HTTP shape the single-request
 *  endpoint returns verbatim, plus the surfaced allocation outcome the
 *  post-decision hook consumes once the approval lock has been released. */
interface DecisionOutcome { status: number; body: unknown; allocation?: { refId: string; decided: 'Approved' | 'Rejected' } }

/**
 * D — the resource an ALLOCATION approval is about, or undefined for any other
 * kind. Undefined means "not scoped": the caller falls through to the role rule.
 *
 * `kind` is the CAPITALIZED `'Allocation'` (see `ApprovalKind` /
 * `createAllocationApproval`) — a lowercase compare would silently never match
 * and would quietly restore the pre-D "any resource-manager" rule while
 * looking like it enforced a scope.
 *
 * `refId` is resolved with `parseMonthRowId`, the SAME splitter
 * `applyAllocationDecision` uses: a B3 approval's refId is the composite month
 * row `<assignmentId>:<YYYY-MM>`, a gap-A one is a bare assignment id, and the
 * assignment is what carries `resourceId` in both cases. Not a naive
 * `split(':')` — that helper anchors on the LAST colon and validates the month,
 * so an id that merely contains a colon can never be mistaken for a month row.
 *
 * Reads only, so it takes NO lock: it runs inside the caller's
 * `approval:<id>` section, and acquiring the `org-chart` lock (or any other)
 * from in there would invent a lock order no other call site uses — see the
 * ordering note on the `/resources` PUT handler.
 */
async function allocationTargetResourceId(ar: ApprovalRequestEntry): Promise<string | undefined> {
  if (ar.kind !== 'Allocation') return undefined;
  const assignmentId = parseMonthRowId(ar.refId)?.assignmentId ?? ar.refId;
  const assignment = await repos.assignments.get(assignmentId);
  return assignment?.resourceId;
}

/**
 * Decide ONE approval request. Extracted from the /decision handler so the B3
 * batch endpoint and the single-request endpoint share ONE implementation of
 * SoD + per-manager step enforcement — duplicating those rules is exactly how a
 * governance hole gets introduced. This is the security boundary for EVERY
 * approval kind (TimeEntry, Invoice, ChangeRequest, ..., Allocation), not just
 * allocations: the body below was MOVED here unchanged, never rewritten.
 *
 * B-CONCURRENCY: serializes the read-decide-write under `approval:<id>`, and
 * re-reads INSIDE the lock so the decision applies to the freshest state.
 */
async function decideOneApproval(
  req: Request,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  note: string | undefined,
  ctx: DeciderContext,
): Promise<DecisionOutcome> {
  const { by, decidingRole, deciderResourceId } = ctx;
  return withLock(`approval:${approvalId}`, async (): Promise<DecisionOutcome> => {
    const ar = await repos.approvalRequests.get(approvalId) as ApprovalRequestEntry | undefined;
    if (ar === undefined) return { status: 404, body: { error: 'Not found' } };
    if (ar.status !== 'Pending') return { status: 400, body: { error: `approval request already ${ar.status}` } };
    // SoD: the requester may never approve/reject their own item. Meaningful now
    // that `by` is the trusted principal rather than a forgeable body field.
    if (by === ar.requestedBy) {
      return { status: 403, body: { error: 'Segregation of duties: the requester cannot decide their own approval request' } };
    }
    const step = ar.steps[ar.currentStep];
    if (!step) return { status: 400, body: { error: 'No pending step to decide' } };
    // STEP ENFORCEMENT — D (design spec §3.4). Supersedes the gap-A role
    // fallback: an actor holding the step's role no longer decides for ANYONE.
    // An actor may decide when ANY of these holds:
    //   1. they are the step's named approver (`step.approverId`, a RESOURCE id
    //      — that is how `allocationApproverStep` routes an allocation);
    //   2. they hold the step's role AND the target resource is in their scope;
    //   3. they hold the step's role AND the target has no manager ANYWHERE
    //      (`scopedApproversOf(...).roleFallback`) — the last resort;
    //   4. their role is 'admin'.
    //
    // HISTORY, so nobody re-tightens or re-loosens this by accident: gap-A §4.3
    // deliberately let ANY resource-manager decide ("un altro resource-manager,
    // diverso dal proponente, può approvare"), so that a manager was not a
    // single point of failure for their own team's bookings — and the comment
    // that stood here said so, ending with "do not tighten the code without
    // reopening the spec decision". THAT DECISION WAS REOPENED AND CHANGED WITH
    // THE USER: D replaces the flat fallback with a real scope — the transitive
    // org chart UNION the org subtrees the actor manages — and keeps a fallback
    // ONLY for a resource with no manager anywhere, which is the case of a
    // placeholder (dummy) today and is what keeps C2's substitutions decidable.
    // The previous wording is therefore obsolete, not a constraint: D's design
    // spec §3.4 is the rule, and §3.5 declares the breaking change (whoever
    // approves resources they do not manage stops being able to).
    //
    // Scope binds ALLOCATION steps only: every other kind routes by role and has
    // no target resource, so `allocationTargetResourceId` returns undefined and
    // the rule falls through to the pre-D behaviour. It also falls through when
    // the target cannot be resolved (a deleted assignment/resource) — refusing
    // there would strand a live approval nobody could decide.
    //
    // `admin` and `delivery-executive` are GLOBAL roles (§3.3) and are never
    // narrowed by scope. Note what that does NOT mean for an allocation: a
    // delivery-executive still fails `roleMatch` on a step routed to
    // 'resource-manager', so they keep exactly the coarse access they have
    // today — the named-approver path only. `globalRole` exempts them from
    // scope, it does not grant them a step their role was never routed to.
    //
    // Segregation of duties is enforced separately, ABOVE, and binds every role.
    // `canDecideFor` in the approvals modal mirrors this rule.
    //
    // LOCKING: the two list reads below take NO lock. They are reads, and this
    // runs inside `withLock('approval:<id>')` — acquiring `org-chart` here would
    // create an `approval:` -> `org-chart` order that no other call site uses
    // (see the lock-order note on `PUT /resources/:id`) and is exactly how a
    // deadlock gets introduced.
    const roleMatch = decidingRole === step.role || decidingRole === 'admin';
    const managerMatch = step.approverId !== undefined && deciderResourceId === step.approverId;
    const globalRole = decidingRole === 'admin' || decidingRole === 'delivery-executive';
    let scopeMatch = roleMatch;
    const targetResourceId = await allocationTargetResourceId(ar);
    if (roleMatch && !globalRole && targetResourceId !== undefined) {
      const target = await repos.resources.get(targetResourceId);
      if (target !== undefined) {
        const [resources, nodes] = await Promise.all([repos.resources.list(), repos.resourceOrganizations.list()]);
        const { managerIds, roleFallback } = scopedApproversOf(target, resources, nodes);
        scopeMatch = roleFallback || (deciderResourceId !== undefined && managerIds.has(deciderResourceId));
      }
    }
    if (!scopeMatch && !managerMatch) {
      // TWO DISTINCT REFUSALS, worded apart on purpose. Reaching here with
      // `roleMatch` true can only be the SCOPE branch above (`scopeMatch` starts
      // as `roleMatch` and nothing else lowers it), and for that actor the
      // role/step wording would be a lie: they DO hold the step's role, and were
      // refused because the resource is not theirs to decide. A 403 that
      // misdescribes its own reason costs the next person an afternoon.
      //
      // Neither message names the target resource, its managers or its org node.
      // The actor has just failed an authorization check on this very resource,
      // so telling them who WOULD have been competent would leak org structure
      // to exactly the wrong person. The competent approver is discoverable
      // through the feed, which is scoped in its own right.
      if (roleMatch) {
        return { status: 403, body: { error: 'Actor does not manage this resource and cannot decide its allocation' } };
      }
      return { status: 403, body: { error: `Actor cannot decide a step assigned to ${step.approverId ?? step.role}` } };
    }
    const decidedAt = new Date().toISOString();
    step.decidedBy = by;
    step.decidedAt = decidedAt;
    // Record the APPROVER's note on the decided step — never overwrite `ar.note`,
    // which is the requester's note captured at creation.
    if (typeof note === 'string') step.note = note;
    if (decision === 'Rejected') {
      // A rejection at any step fails the whole chain and steps back currentStep.
      step.status = 'Rejected';
      ar.status = 'Rejected';
      ar.currentStep = Math.max(0, ar.currentStep - 1);
    } else {
      step.status = 'Approved';
      // Advance; when the chain is exhausted the overall request is Approved.
      ar.currentStep = ar.currentStep + 1;
      if (ar.currentStep >= ar.steps.length) ar.status = 'Approved';
    }
    const updated = await repos.approvalRequests.update(ar.id, ar as ApprovalRequest);
    return {
      status: 200,
      body: updated ?? ar,
      // ALLOCATION HOOK: Allocation requests are single-step, so a terminal
      // Approved/Rejected decision here is the FINAL outcome for the whole
      // request — surface it so the caller can translate it into the governed
      // assignment's status once this lock has been released (see below).
      allocation: ar.kind === 'Allocation' && (ar.status === 'Approved' || ar.status === 'Rejected')
        ? { refId: ar.refId, decided: ar.status as 'Approved' | 'Rejected' }
        : undefined,
    };
  });
}

/**
 * Apply an Allocation decision to the governed entity. `refId` carries the
 * shape: a composite `<assignmentId>:<YYYY-MM>` targets ONE month row (B3);
 * a bare assignment id is a LEGACY gap-A approval opened before B3 and still
 * pending — applied to the assignment AND to every non-Draft month row a
 * migrated database backfilled under it, so nothing in flight is orphaned (see
 * the branch's own comment for why the assignment write alone was a no-op).
 *
 * Called AFTER the `approval:<id>` lock has been released, under the fixed
 * res -> req lock order used by every other assignment mutation, so this can
 * never deadlock against a concurrent POST/PUT/DELETE on /assignments.
 *
 * `deferAggregates` lets the BATCH endpoint skip the per-item follow-up work and
 * do it once per distinct entity at the end (spec §4.4): approving twelve months
 * of one resource must not recompute her utilization twelve times, nor re-derive
 * the same assignment's status twelve times (each rollup is a full
 * `assignmentMonths` scan). What is deferred is everything ASSIGNMENT-or-wider:
 * the status rollup, its explicit audit entry, and the aggregate recompute. The
 * MONTH-row write is never deferred — it is the decision itself. The returned
 * ids are what the caller then dedupes; it must run the rollups BEFORE the
 * recomputes, since `recomputeResourceUtilization` weighs assignments by the
 * status the rollup produces.
 */
async function applyAllocationDecision(
  req: Request,
  refId: string,
  decided: 'Approved' | 'Rejected',
  note: string | undefined,
  deferAggregates = false,
): Promise<{ resourceId: string; requestId: string; assignmentId: string } | undefined> {
  const parsed = parseMonthRowId(refId);
  const newStatus = decisionToAssignmentStatus(decided);

  const recompute = async (resourceId: string, requestId: string): Promise<void> => {
    if (deferAggregates) return;
    await withLock(`res:${resourceId}`, () => recomputeResourceUtilization(resourceId));
    await withLock(`req:${requestId}`, () => recomputeRequestStaffing(requestId));
  };

  if (parsed === undefined) {
    const assig = await repos.assignments.get(refId);
    if (!assig) return undefined;
    // The transition MUST succeed (or surface as a 500) — see the month branch.
    await repos.assignments.update(assig.id, { status: newStatus });

    // LEGACY + B3 RECONCILIATION. A pre-B3 database migrated into B3 has month
    // rows created by `backfillAssignmentMonths`, which COPIES the assignment's
    // status onto each of them and gives them no `approvalId`. Writing only
    // `assignments.status` here left those rows exactly where they were, and
    // that is the state everything downstream actually reads:
    //   - `monthlyAggregateHours` weighs each day by the status of ITS month
    //     row, so confirmed/planned hours never moved;
    //   - the very next `refreshDerivedAssignmentStatus` (any month endpoint on
    //     this assignment) re-derived the column straight back from those
    //     unchanged rows, silently undoing the decision.
    // Nothing else could rescue them either: `submit` only accepts
    // Draft/Rejected and the allocation PUT's forced re-approval only fires from
    // 'Allocated', so a backfilled 'Requested' row with no approval was
    // unreachable.
    //
    // SCOPE — `approvalId === undefined` is the load-bearing half of this guard,
    // not a nicety. It is exactly the shape described above (the backfill never
    // attaches one), and it is what keeps this legacy sweep off months that have
    // a governance story of their OWN. One assignment can hold both: a stranded
    // month from the migration AND a later month the planner has since submitted
    // through the normal B3 flow, which carries a live, still-Pending
    // per-month approval. Moving that second row here would decouple it from its
    // approval forever — the approval stays Pending while the row already shows a
    // terminal status, so the month drops out of the 'Requested' feed (invisible
    // to whoever must decide it) and the aggregates count it as decided until the
    // real decision lands and flips it back. The same guard is what stops an
    // already-decided 'Rejected' month (a closed conversation, and one that kept
    // the approvalId of the request that closed it) from being flipped back to
    // 'Allocated'.
    //
    // 'Draft' is excluded for the separate reason that it was never submitted, so
    // no decision governs it — a Draft row also has no approvalId, so both halves
    // of the guard are needed. Then re-derive the column so the stored status and
    // the status-weighted aggregates agree.
    const monthRows = (await repos.assignmentMonths.list()).filter(m => m.assignmentId === assig.id);
    for (const row of monthRows) {
      if (row.approvalId !== undefined) continue;
      if (row.status === 'Draft' || row.status === newStatus) continue;
      // Not best-effort: this write IS the decision for that month, same rule as
      // the B3 branch below.
      const rowAfter = await repos.assignmentMonths.update(row.id, { status: newStatus });
      // AUDIT per moved month row, the SAME shape the B3 branch and the batch
      // write. A legacy decision now moves N rows at once, which is precisely
      // the case `monthTransitionAudit` exists for: the assignment-level entry
      // records only the rollup and cannot say which months moved. Best-effort,
      // as everywhere else — the month write has already committed.
      try {
        if (rowAfter) await repos.auditLogs.create(monthTransitionAudit(req, row, rowAfter));
      } catch { /* audit is best-effort; the month transition already committed */ }
    }
    // Re-derive ONLY when the assignment actually has month rows. With none at
    // all (a truly pre-B1 assignment: no day rows, so the backfill created
    // nothing) `deriveAssignmentStatus([])` is 'Draft', which would DOWNGRADE
    // the decision that was just applied — there the direct write above is the
    // whole effect, exactly as before B3. Deferred in batch mode like the month
    // branch, though the batch never reaches here (it resolves a month row
    // first, so its refIds are always composite).
    if (monthRows.length > 0 && !deferAggregates) await refreshDerivedAssignmentStatus(assig.id);
    try {
      // Read INSIDE the best-effort block: it exists only to label the audit
      // entry below, so it must never be the thing that 500s a decision that has
      // already committed.
      const settled = await repos.assignments.get(assig.id);
      // Aggregate recompute + the explicit audit entry are best-effort, same
      // discipline as the audit middleware ("audit is best-effort... failures
      // here never affect the already-sent response"): the decision AND the
      // transition have already committed by this point, so a recompute/audit
      // failure must not turn an otherwise-successful decision into a 500.
      await recompute(assig.resourceId, assig.requestId);
      // The assignment entry records the status the column ACTUALLY settled on
      // (the derived rollup when month rows exist), never the decision's raw
      // outcome — an audit trail that claims a value the row does not hold is
      // worse than none.
      await repos.auditLogs.create(
        allocationTransitionAudit(req, assig, settled?.status ?? newStatus, `/assignments/${assig.id}`));
    } catch { /* recompute/audit are best-effort; the decision already committed */ }
    return { resourceId: assig.resourceId, requestId: assig.requestId, assignmentId: assig.id };
  }

  const row = await repos.assignmentMonths.get(refId);
  if (!row) return undefined;
  const assig = await repos.assignments.get(row.assignmentId);
  if (!assig) return undefined;

  // The month transition MUST succeed (or surface as a 500): an approval that
  // reports Approved while the governed month stays Requested is the exact
  // divergence this hook exists to prevent. The approver's note is mirrored onto
  // the row (it also lives on the decided step, as in gap A) so the calendar can
  // show it without resolving the approval request.
  //
  // A decision carrying NO note CLEARS the field rather than leaving it: this is
  // the only writer of `approverNote`, and a month can be decided more than once
  // (approve with "ok" -> planner edits the days -> forced re-approval -> the
  // next approver rejects silently). Without the clear, the row would render
  // 'Rejected' still carrying the previous approver's "ok". `null` is the
  // documented "clear to absent" patch value on BOTH adapters (Drizzle sets the
  // column NULL, the in-memory store drops the key) — `undefined` would mean
  // "leave untouched". Cast just this value so a typo in `status` is still
  // type-checked; every READ path normalizes the cleared column back to absent.
  const rowAfter = await repos.assignmentMonths.update(row.id, {
    status: newStatus, approverNote: (note ?? null) as unknown as undefined,
  } as Partial<AssignmentMonth>);

  // AUDIT — written HERE, on both the single-request and the batch path, so the
  // two record the same decision identically. It captures the MONTH ROW's own
  // before/after, which depends on nothing but this write: unlike the rollup and
  // the aggregates it is neither expensive nor idempotent, so it is never
  // deferred or deduplicated. Best-effort, as everywhere else — the decision has
  // already committed. `rowAfter` is the repository's own post-state (both
  // adapters normalize a cleared column back to absent), never a locally
  // reconstructed guess.
  try {
    if (rowAfter) await repos.auditLogs.create(monthTransitionAudit(req, row, rowAfter));
  } catch { /* audit is best-effort; the decision already committed */ }

  // C2 — SUBSTITUTION GIVE-BACK. A month that arrived by substitution carries a
  // link to the dummy month it came from; the decision closes that link and
  // hands back the hours the person did not end up taking (all of them on a
  // rejection, only the trimmed difference on an approval — see
  // `returnHoursToDummy`). Placed HERE, after the month's own status write and
  // its audit entry and BEFORE the `deferAggregates` return, so the single
  // decision and the batch behave identically.
  //
  // BEST-EFFORT and LAST, exactly like the recompute below: the decision and the
  // month transition have already committed, so a give-back failure must never
  // turn a landed decision into a 500. Logged rather than swallowed silently —
  // this branch moves hours, and a bug here would otherwise leave no trace.
  if (row.replacedFromAssignmentMonthId !== undefined) {
    try {
      await returnHoursToDummy(req, row, assig, decided);
    } catch (err) {
      console.error(`applyAllocationDecision: give-back failed for month ${row.id}:`, err);
    }
  }

  if (deferAggregates) {
    // The rollup and the recompute are the caller's job — they are
    // assignment-or-wider, expensive and idempotent, so the batch runs them once
    // per entity instead of once per month.
    return { resourceId: assig.resourceId, requestId: assig.requestId, assignmentId: assig.id };
  }
  await refreshDerivedAssignmentStatus(assig.id);
  try {
    await recompute(assig.resourceId, assig.requestId);
  } catch { /* recompute is best-effort; the decision already committed */ }
  return { resourceId: assig.resourceId, requestId: assig.requestId, assignmentId: assig.id };
}

apiRouter.put('/approval-requests/:id/decision', async (req, res) => {
  // Validate the decision up front (cheap, no shared state).
  const body = pick<{ decision: string; note?: string }>(req.body, ['decision', 'note']);
  if (body.decision !== 'Approved' && body.decision !== 'Rejected') {
    res.status(400).json({ error: "decision must be 'Approved' or 'Rejected'" });
    return;
  }
  // SEGREGATION OF DUTIES / AUTHORIZATION: the deciding actor is the SERVER-
  // VERIFIED principal, NEVER a client-supplied `by`. A client-controlled `by`
  // would let the requester forge a different decider and defeat the SoD check
  // below, and forge who is recorded as the approver. Require a recognised
  // principal (a JWT role, or a trusted demo header) — an unauthenticated
  // caller ('unknown') can never drive the financial approval chain.
  const decidingRole = trustedRole(req);
  if (decidingRole === 'unknown') {
    res.status(401).json({ error: 'A verified principal is required to decide an approval request' });
    return;
  }
  const by = actorId(req);
  const decision = body.decision;
  // MANAGER DECISION PATH: a step may carry an explicit `approverId` (a
  // resource-manager identified by RESOURCE id — see `allocationApproverStep`).
  // Resolve the deciding actor's own resource-id so it can be compared against
  // `step.approverId` below. Computed OUTSIDE withLock — it's an async read
  // through the users directory and touches no shared mutable state, so it
  // needn't be serialized with the critical section (mirrors `by`/`decidingRole`
  // above, also computed before the lock).
  const deciderResourceId = await actorResourceId(req);

  const result = await decideOneApproval(req, req.params.id, decision, body.note, { by, decidingRole, deciderResourceId });

  // POST-DECISION EFFECT (Allocation): applied AFTER the `approval:<id>` lock
  // has been released — never nested inside it. Executes at most once per
  // decision: `ar.status` starts 'Pending' and `decideOneApproval` only ever
  // sets it to 'Approved'/'Rejected' once (a retried decision 400s on the
  // `ar.status !== 'Pending'` guard, so `result.allocation` is undefined then).
  // Same note the step recorded; no deferral — a single decision has exactly
  // one resource/request to recompute.
  if (result.status === 200 && result.allocation) {
    await applyAllocationDecision(req, result.allocation.refId, result.allocation.decided, body.note);
  }
  res.status(result.status).json(result.body);
});

/** Hard cap on one batch: a People Manager approving a month across projects
 *  for a multi-resource selection stays far below this. */
const DECIDE_BATCH_MAX = 200;

/**
 * B3 — "Approva Mese" / "Approva e Prosegui": decide N month rows in one call.
 * Each item is independent: a row already decided, missing, carrying no pending
 * approval, or refused by SoD / step enforcement yields an Error result and
 * never fails its neighbours. Aggregate recompute is deduplicated per
 * resource/request at the END of the batch rather than per item.
 */
apiRouter.post('/allocation-approvals/decide', async (req, res) => {
  // Identity resolution mirrors the single-request endpoint EXACTLY — the
  // deciding principal is server-verified, never a client-supplied `by`.
  const decidingRole = trustedRole(req);
  if (decidingRole === 'unknown') {
    res.status(401).json({ error: 'A verified principal is required to decide an approval request' });
    return;
  }
  const body = pick<{ items?: unknown }>(req.body, ['items']);
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items must be a non-empty array' }); return;
  }
  if (items.length > DECIDE_BATCH_MAX) {
    res.status(400).json({ error: `items must contain at most ${DECIDE_BATCH_MAX} entries` }); return;
  }

  const ctx: DeciderContext = { by: actorId(req), decidingRole, deciderResourceId: await actorResourceId(req) };
  const results: { assignmentMonthId: string; status: string; error?: string }[] = [];
  // EXPENSIVE + IDEMPOTENT work is deduplicated per distinct entity and run
  // AFTER the loop (spec §4.4): the status rollup per assignment, then the
  // aggregates per resource/request.
  // The AUDIT is deliberately NOT deduplicated and NOT deferred: it is
  // per-decision by nature, so `applyAllocationDecision` writes one entry per
  // decided MONTH ROW inline, identically on both endpoints.
  const touchedAssignments = new Set<string>();
  const touchedResources = new Set<string>();
  const touchedRequests = new Set<string>();

  try {
    for (const raw of items) {
      // Declared OUTSIDE the per-item try so the catch can still name the item
      // it failed on (a `null` entry throws on the very first property read).
      let id = '';
      // PER-ITEM CONTAINMENT: `applyAllocationDecision` deliberately leaves the
      // month-row write outside its best-effort catch so a failure surfaces as a
      // 500 — correct for the single-request endpoint, wrong here. Without this
      // catch, one throwing item would unwind the loop: its predecessors would
      // stay committed (approvals flipped, month rows moved) with NO response
      // body naming them, its successors would be silently skipped, and a retry
      // would report "already Approved" for work the caller never saw succeed.
      // The documented contract is per-item independence, so a thrown item
      // becomes an Error result like any refused one.
      try {
        const item = (raw ?? {}) as { assignmentMonthId?: unknown; decision?: unknown; note?: unknown };
        id = typeof item.assignmentMonthId === 'string' ? item.assignmentMonthId : '';
        const decision = item.decision === 'Approved' || item.decision === 'Rejected' ? item.decision : undefined;
        const note = typeof item.note === 'string' ? item.note : undefined;
        if (!id || decision === undefined) {
          results.push({ assignmentMonthId: id, status: 'Error', error: "each item needs assignmentMonthId and decision 'Approved'|'Rejected'" });
          continue;
        }
        const row = await repos.assignmentMonths.get(id);
        if (row === undefined) { results.push({ assignmentMonthId: id, status: 'Error', error: 'Not found' }); continue; }
        if (row.approvalId === undefined) { results.push({ assignmentMonthId: id, status: 'Error', error: 'month has no pending approval' }); continue; }

        const outcome = await decideOneApproval(req, row.approvalId, decision, note, ctx);
        if (outcome.status !== 200) {
          const message = (outcome.body as { error?: string } | undefined)?.error ?? `decision failed (${outcome.status})`;
          results.push({ assignmentMonthId: id, status: 'Error', error: message });
          continue;
        }
        if (outcome.allocation) {
          const touched = await applyAllocationDecision(req, outcome.allocation.refId, outcome.allocation.decided, note, true);
          if (touched) {
            touchedAssignments.add(touched.assignmentId);
            touchedResources.add(touched.resourceId);
            touchedRequests.add(touched.requestId);
          }
        }
        results.push({ assignmentMonthId: id, status: decision });
      } catch (err) {
        // The RESPONSE stays generic — never leak driver internals to the caller,
        // same discipline as the FK-violation mapper below. But this loop
        // deliberately turns a crash into an ordinary-looking Error result, so
        // without a log a genuine bug would be indistinguishable from a business
        // refusal and would leave no trace anywhere.
        console.error(`POST /allocation-approvals/decide: item ${id || '(unnamed)'} threw`, err);
        results.push({ assignmentMonthId: id, status: 'Error', error: 'unexpected error while deciding this item' });
      }
    }
  } finally {
    // Runs even if the loop itself unwinds, so committed decisions are never
    // left with stale derived state. Every `try` sits INSIDE its loop, not
    // around it: one bad entity must not take out the entities that follow it in
    // iteration order. All of it is best-effort — the decisions have committed,
    // and their audit entries are already written by the loop above.

    // (1) ROLLUPS, once per ASSIGNMENT: each one is a full assignmentMonths
    // scan, so twelve decided months of one assignment must not trigger twelve.
    for (const assignmentId of touchedAssignments) {
      try {
        await refreshDerivedAssignmentStatus(assignmentId);
      } catch { /* this assignment's rollup self-heals on its next mutation */ }
    }

    // (2) AGGREGATES, once per resource/request. AFTER the rollups: the
    // assignment status those produce is exactly what
    // `recomputeResourceUtilization` weighs its hours by, so recomputing first
    // would bake in the pre-decision statuses. Fixed res -> req lock order,
    // never both held at once.
    for (const resourceId of touchedResources) {
      try {
        await withLock(`res:${resourceId}`, () => recomputeResourceUtilization(resourceId));
      } catch { /* this resource's utilization self-heals on its next mutation */ }
    }
    for (const requestId of touchedRequests) {
      try {
        await withLock(`req:${requestId}`, () => recomputeRequestStaffing(requestId));
      } catch { /* this request's staffing self-heals on its next mutation */ }
    }
  }

  res.json({ results });
});

/** Default + maximum page size for the (paged) audit log read. */
const AUDIT_LOG_DEFAULT_LIMIT = 200;
const AUDIT_LOG_MAX_LIMIT = 1000;
apiRouter.get('/audit-logs', async (req, res) => {
  // AUDIT READ: never stream the entire ever-growing log. Return a bounded page
  // ordered newest-first by `at`. `limit`/`offset` query params drive pagination;
  // both are clamped so a client cannot request the whole log.
  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, AUDIT_LOG_MAX_LIMIT) : AUDIT_LOG_DEFAULT_LIMIT;
  const rawOffset = Number(req.query['offset']);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  if (db) {
    // Pg path: push the ordering + paging into SQL (ORDER BY at DESC LIMIT
    // OFFSET, backed by audit_logs_at_idx) so the DB read is bounded — never a
    // full SELECT * materialised in the process.
    const page = await db
      .select()
      .from(auditLogsTable)
      .orderBy(desc(auditLogsTable.at))
      .limit(limit)
      .offset(offset);
    res.json(page);
    return;
  }
  // In-memory path: sort newest-first by `at` (stable) and slice the page.
  const all = (await repos.auditLogs.list()) as unknown as AuditEntry[];
  const sorted = [...all].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  res.json(sorted.slice(offset, offset + limit));
});
apiRouter.get('/storage-status', (_req, res) => res.json({
  provider: process.env['DATABASE_URL'] ? 'postgresql' : 'memory',
  persistent: Boolean(process.env['DATABASE_URL']),
  // Header-trust is on ONLY in local/dev. When true, the SPA may bootstrap a demo
  // admin identity (without a running Keycloak) so the in-memory app is fully
  // usable for testing. In production this is false → the SPA stays anonymous and
  // the server still ignores any client-set role header.
  demoMode: trustHeaders,
}));

// --- Integrations (local-artifact adapters: implemented, NOT connected) ------
//
// Every adapter is a pure builder producing a downloadable artifact from the
// repository data. No network calls, no credentials, no vendor SDKs — the
// descriptors advertise `connected: false` / `mode: 'local-artifact'`.
// RBAC: '/integrations' is gated (reads AND mutations) to
// finance/delivery-executive/admin via READ_RULES + the mutation rules above.

/** Assemble the full FinanceData snapshot from the repositories. */
async function loadFinanceData(): Promise<FinanceData> {
  const [
    requests, assignments, resources, orders, orderLines, financials,
    timeEntries, billingItems, contracts, customers, milestones,
    changeRequests, projects, fxRates,
  ] = await Promise.all([
    repos.requests.list(), repos.assignments.list(), repos.resources.list(),
    repos.orders.list(), repos.orderLines.list(), repos.projectFinancials.list(),
    repos.timeEntries.list(), repos.billingPlanItems.list(), repos.contracts.list(),
    repos.customers.list(), repos.milestones.list(), repos.changeRequests.list(),
    repos.projects.list(), repos.fxRates.list(),
  ]);
  return {
    requests, assignments, resources, orders, orderLines, financials,
    timeEntries, billingItems, contracts, customers, milestones,
    changeRequests, projects, fxRates,
  };
}

/** Send a locally-built ExportArtifact as a file-download response. */
function sendArtifact(res: Response, artifact: ExportArtifact): void {
  // DEFENSE-IN-DEPTH (header injection): adapter filenames are interpolated
  // into a response header. Today every adapter builds its filename from
  // server-generated values, but never trust that at the seam — strip anything
  // outside a conservative filesystem-safe set so CR/LF/quotes can never reach
  // Content-Disposition.
  const safeFilename = artifact.filename.replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Type', artifact.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  res.send(artifact.content);
}

/**
 * Fallback rev-rec window for the GL journal export when the data set carries
 * no dated activity at all: full-year 2026, monthly (covers the seed data).
 */
const ERP_JOURNAL_WINDOW_FALLBACK: { from: string; to: string } = { from: '2026-01', to: '2026-12' };

/** Months accepted on the journal-export from/to query params. */
const JOURNAL_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * COMPLETENESS: a GL export must cover ALL dated activity, not a hardcoded
 * year — otherwise entries silently vanish from an accounting artifact. Derive
 * the window from the data's own min/max months (time entries + billing item
 * dates), falling back to the seed-era default only when nothing is dated.
 */
function deriveJournalWindow(data: Awaited<ReturnType<typeof loadFinanceData>>): { from: string; to: string } {
  const months: string[] = [];
  const push = (value: string | undefined): void => {
    if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) months.push(value.slice(0, 7));
  };
  for (const t of data.timeEntries ?? []) push(t.date);
  for (const b of data.billingItems ?? []) {
    push(b.expectedDate);
    push(b.issuedDate);
    push(b.paidDate);
  }
  if (months.length === 0) return ERP_JOURNAL_WINDOW_FALLBACK;
  months.sort();
  return { from: months[0], to: months[months.length - 1] };
}

/** Supplier (CedentePrestatore) master data from env, with sane demo defaults. */
function supplierFromEnv(): SupplierInfo {
  return {
    name: process.env['INTEGRATION_SUPPLIER_NAME'] || 'Delivery Control Demo S.r.l.',
    vatNumber: process.env['INTEGRATION_SUPPLIER_VAT'] || '01234567890',
    address: process.env['INTEGRATION_SUPPLIER_ADDRESS'] || 'Via Roma 1',
    city: process.env['INTEGRATION_SUPPLIER_CITY'] || 'Milano',
    zip: process.env['INTEGRATION_SUPPLIER_ZIP'] || '20100',
    country: process.env['INTEGRATION_SUPPLIER_COUNTRY'] || 'IT',
    codiceDestinatario: process.env['INTEGRATION_SUPPLIER_SDI'] || '0000000',
  };
}

// Descriptors of the active adapters plus the per-kind active key.
apiRouter.get('/integrations', async (_req, res) => {
  const integrations = getIntegrations();
  res.json({
    adapters: listDescriptors(),
    active: {
      erp: integrations.erp.describe().key,
      einvoice: integrations.einvoice.describe().key,
      crm: integrations.crm.describe().key,
      bi: integrations.bi.describe().key,
    },
  });
});

// ERP: balanced double-entry GL journal of the rev-rec schedule (CSV or JSON).
// Window: derived from the data's dated activity; overridable with validated
// from/to query params (YYYY-MM).
apiRouter.get('/integrations/erp/journal-export', async (req, res) => {
  const format = req.query['format'] === 'json' ? 'json' : 'csv';
  const data = await loadFinanceData();
  const derived = deriveJournalWindow(data);
  const fromQ = req.query['from'];
  const toQ = req.query['to'];
  const from = typeof fromQ === 'string' && JOURNAL_MONTH_RE.test(fromQ) ? fromQ : derived.from;
  const to = typeof toQ === 'string' && JOURNAL_MONTH_RE.test(toQ) ? toQ : derived.to;
  if (from > to) {
    res.status(400).json({ error: 'from must be <= to (YYYY-MM)' });
    return;
  }
  const journal = recognitionJournal(data, { from, to });
  try {
    const artifact = getIntegrations().erp.buildJournalExport(journal, { format });
    sendArtifact(res, artifact);
  } catch (err) {
    // The balance invariant (Σ debit === Σ credit) failed: never ship an
    // unbalanced batch to an ERP. recognitionJournal is balanced by
    // construction, so this is a defensive guard, not an expected path.
    if (err instanceof UnbalancedJournalError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// E-invoice: simplified FatturaPA (FPR12) XML for one INVOICED order.
apiRouter.get('/integrations/einvoice/orders/:id', async (req, res) => {
  const order = await repos.orders.get(req.params.id);
  if (order === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const contract = await repos.contracts.get(order.contractId);
  const customer = contract ? await repos.customers.get(contract.customerId) : undefined;
  if (customer === undefined) {
    res.status(404).json({ error: 'No customer found for the order (broken contract/customer chain)' });
    return;
  }
  const lines = (await repos.orderLines.list()).filter(l => l.orderId === order.id);
  try {
    const artifact = getIntegrations().einvoice.buildInvoiceXml({
      order, customer, contract, lines, supplier: supplierFromEnv(),
    });
    sendArtifact(res, artifact);
  } catch (err) {
    // Validation failures (e.g. the order has no invoiceNumber yet) are client
    // errors: only invoiced orders can be exported as FatturaPA.
    if (err instanceof EInvoiceValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/**
 * CRM outbox — INTENTIONALLY EPHEMERAL demo state. Prepared sync payloads are
 * kept in this module-scoped in-memory array only (never persisted, never
 * transmitted: the CRM adapter is a local-artifact builder). Newest first,
 * capped at CRM_OUTBOX_MAX entries; a restart clears it by design.
 */
const CRM_OUTBOX_MAX = 50;
const crmOutbox: CrmOutboxEntry[] = [];

apiRouter.get('/integrations/crm/outbox', async (_req, res) => { res.json(crmOutbox); });
apiRouter.post('/integrations/crm/outbox', async (_req, res) => {
  const [customers, contracts, orders] = await Promise.all([
    repos.customers.list(), repos.contracts.list(), repos.orders.list(),
  ]);
  const entry = getIntegrations().crm.buildSyncPayload({
    customers, contracts, orders, preparedAt: new Date().toISOString(),
  });
  // The adapter is pure and never assigns ids; the persistence layer (this
  // ephemeral outbox) does, via the shared newId() sequence.
  entry.id = `OB${newId()}`;
  crmOutbox.unshift(entry);
  if (crmOutbox.length > CRM_OUTBOX_MAX) crmOutbox.length = CRM_OUTBOX_MAX;
  res.json(entry);
});

// BI: flat per-project financial feed (JSON rows of primitives).
apiRouter.get('/integrations/bi/feed', async (_req, res) => {
  const data = await loadFinanceData();
  const projects = data.projects ?? [];
  const financials: ProjectFinancialsRow[] = projects.map(project => {
    const f = computeProjectFinancials(project.id, data);
    return {
      projectId: project.id,
      projectName: project.name,
      status: project.status,
      revenue: f.revenue,
      actualCost: f.actualCost,
      margin: f.margin,
      marginPct: f.marginPct,
      budget: f.budget,
      eac: f.eac,
      vac: f.varianceAtCompletion,
    };
  });
  const artifact = getIntegrations().bi.buildFeed({
    generatedAt: new Date().toISOString(),
    projects,
    financials,
  });
  // The feed is consumed inline (preview/ingestion), not as a download.
  res.setHeader('Content-Type', artifact.mimeType);
  res.send(artifact.content);
});

/**
 * Make id generation safe across restarts by advancing the in-memory sequences
 * past anything already persisted:
 *
 *  - `idSeq` is set to the largest numeric SUFFIX seen across every repository —
 *    BOTH purely-numeric ids and PREFIXED ids ('TE…', 'AL…', 'AR…', 'OB…'). The
 *    suffix is `newId()`'s output, so it must move the counter even when wrapped
 *    in a prefix: otherwise a restart re-issues an already-used suffix and the
 *    prefixed PK ('TE'+suffix, …) collides (a violation the best-effort audit
 *    insert silently swallows). See `maxIdSeq`.
 *  - `invoiceSeq` is set to the largest INV-<INVOICE_YEAR>-NNNN across orders, so
 *    a restart can never re-issue an invoice number that is already in use.
 *
 * Runs after initPersistence() so it reads the migrated/seeded state.
 */
async function seedSequences(): Promise<void> {
  // Read side only: every Repository<T extends Entity> exposes list(): Promise<T[]>,
  // and T[] is assignable to Entity[], so this typed array needs no `any`.
  const allRepos: readonly { list(): Promise<Entity[]> }[] = [
    repos.resources, repos.users, repos.requests, repos.assignments, repos.timeEntries,
    repos.languages, repos.skillCatalogs, repos.proficiencySets, repos.skills, repos.projectRoles,
    repos.resourceOrganizations, repos.countries, repos.cities, repos.industries,
    repos.costCategories, repos.partnerRoles, repos.vendors,
    repos.projects, repos.projectPartners, repos.projectDocuments,
    repos.workPackages, repos.milestones, repos.projectFinancials, repos.projectCostCenters,
    repos.projectTasks, repos.projectIssues, repos.changeRequests, repos.costCenters,
    repos.customers, repos.contracts, repos.orders, repos.orderLines, repos.billingPlanItems,
    repos.fxRates, repos.approvalRequests, repos.auditLogs,
  ];

  // idSeq -> max numeric SUFFIX across all repositories (numeric AND prefixed ids).
  // newId()'s output is embedded in prefixed ids (TE…/AL…/AR…/OB…), so the
  // counter must advance past those suffixes too or a restart re-issues a used
  // suffix and the prefixed PK collides. See maxIdSeq.
  const lists = await Promise.all(allRepos.map(r => r.list()));
  let maxNumericId = idSeq;
  for (const rows of lists) {
    const fromRows = maxIdSeq(rows.map(row => row.id));
    if (fromRows > maxNumericId) maxNumericId = fromRows;
  }
  idSeq = maxNumericId;

  // invoiceSeq -> max INV-<INVOICE_YEAR>-NNNN across orders.
  const prefix = `INV-${INVOICE_YEAR}-`;
  let maxSeq = invoiceSeq;
  for (const order of await repos.orders.list()) {
    if (typeof order.invoiceNumber === 'string' && order.invoiceNumber.startsWith(prefix)) {
      const n = Number(order.invoiceNumber.slice(prefix.length));
      if (Number.isInteger(n) && n > maxSeq) maxSeq = n;
    }
  }
  invoiceSeq = maxSeq;
}

await initPersistence();
await seedSequences();

/**
 * Narrow guard for a PostgreSQL foreign-key-violation error. The `pg` driver
 * surfaces the SQLSTATE in a string `code` property (`'23503'` ==
 * foreign_key_violation) on the thrown error — present on both the JS
 * `DatabaseError` and the native binding — so we match on `code` rather than a
 * constructor. Read via `unknown`/`in` so no `any` leaks in.
 */
function isFkViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err
    && (err as { code?: unknown }).code === '23503';
}

/**
 * HARDENING: clean JSON 404 for any unmatched /api/* request.
 *
 * Registered LAST on the apiRouter (after every real route), so it only fires
 * when nothing else matched. Without it, an unknown verb/path under /api (e.g.
 * `POST /api/nonexistent`) fell through this router to the Angular SSR catch-all
 * below, which crashed rendering with a 500 ("Response body ... locked"). This
 * keeps the response scoped to /api — real SSR page routes (which never reach
 * this router) are untouched — and returns a predictable, parseable error shape.
 */
apiRouter.use((req, res) => {
  res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` });
});

/**
 * API error mapper (Express 5 forwards rejected async-handler promises here).
 *
 * ADAPTER PARITY: deleting an FK-referenced row raises a foreign-key violation
 * on the Postgres adapter (the InMemory adapter would orphan instead). Without
 * this, that rejection reaches Express's default handler as an opaque 500.
 * Map it to 409 Conflict — a clean, adapter-independent "row is still
 * referenced" status — instead of leaking a 500. All other errors fall through
 * to the default handler unchanged.
 */
apiRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) { next(err); return; }
  if (isFkViolation(err)) {
    res.status(409).json({ error: 'Cannot delete: the record is still referenced by other records' });
    return;
  }
  next(err);
});

app.use('/api', apiRouter);
// ------------------

app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  const port = process.env['PORT'] || 3000;
  app.listen(Number(port), bindHost, () => {
    console.log(`Node Express server listening on http://${bindHost}:${port}`);
    if (!trustHeaders) {
      console.warn('AUTH: header-based identity is NOT trusted on this bind; privileged mutations require a verified principal (denied 403 until then).');
    }
  });
}

export const reqHandler = createNodeRequestHandler(app);
