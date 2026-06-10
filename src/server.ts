import { AngularNodeAppEngine, isMainModule, writeResponseToNodeResponse, createNodeRequestHandler } from '@angular/ssr/node';
import express, { Request, Response, NextFunction, Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { getRepositories, type FxRateRow } from './db/repositories';
import { initPersistence } from './db/bootstrap';
import type { Entity, Repository } from './db/repository';
import type { AuditLog, Resource, ResourceRequest, Assignment, TimeEntry, Contract, Order, OrderLine, BillingPlanItem, ApprovalRequest, SkillCatalog, ProficiencySet, Skill, ProjectRole, ResourceOrganization, Project } from './app/services/api.service';
import { utilizationContribution, requestStatusFor, isAllowedTimeEntryTransition } from './app/services/staffing.util';
import { convertToBase, computeProjectFinancials, recognitionJournal, type FinanceData } from './app/services/finance.util';
import type { FxRate } from './app/services/api.service';
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

/**
 * Process-wide repositories (Postgres when DATABASE_URL is set, else in-memory).
 * Declared early so it is in scope for the audit middleware and the boot
 * sequence below.
 */
const repos = getRepositories();

/**
 * AUDIT INTEGRITY: the audit log is APPEND-ONLY — entries are created in
 * insertion order and are never edited or deleted. The READ endpoint
 * (`GET /audit-logs`) sorts newest-first and applies a bounded default page
 * size (so the response and per-request work stay O(page), not O(whole log)).
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
  ['projects', repos.projects], ['project-partners', repos.projectPartners], ['project-documents', repos.projectDocuments],
  ['work-packages', repos.workPackages], ['milestones', repos.milestones], ['project-financials', repos.projectFinancials],
  ['project-cost-centers', repos.projectCostCenters], ['project-tasks', repos.projectTasks], ['project-issues', repos.projectIssues],
  ['change-requests', repos.changeRequests], ['cost-centers', repos.costCenters], ['customers', repos.customers],
  ['contracts', repos.contracts], ['orders', repos.orders], ['order-lines', repos.orderLines],
  ['billing-plan-items', repos.billingPlanItems], ['approval-requests', repos.approvalRequests],
]);

/** Find the current entity targeted by a `/collection/:id` request path. */
async function findAuditEntity(path: string): Promise<Entity | undefined> {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
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
const ROLE_PRIORITY: readonly UserRole[] = ['employee', 'sales', 'pm', 'resource-manager', 'finance', 'delivery-executive', 'admin'];
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
 *    - No token      -> keep the existing loopback-trusted demo-header fallback.
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
  // (catalogs, config, projects, etc. — non-sensitive reference reads).
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
    // Time entries incl. approval. Self-approval is additionally blocked in the PUT handler (SoD).
    { test: p => p.startsWith('/time-entries'), roles: ['employee', 'pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
    { test: p => ['/assignments', '/requests'].some(prefix => p.startsWith(prefix)), roles: ['pm', 'resource-manager', 'delivery-executive', 'admin'] },
    { test: p => ['/projects', '/work-packages', '/milestones', '/project-tasks', '/project-issues', '/change-requests'].some(prefix => p.startsWith(prefix)), roles: ['pm', 'delivery-executive', 'admin'] },
    { test: p => ['/skill-catalogs', '/proficiency-sets', '/skills', '/project-roles', '/resource-organizations', '/languages'].some(prefix => p.startsWith(prefix)), roles: ['admin', 'delivery-executive'] },
    { test: p => p.startsWith('/approval-requests'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
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
 *   - /resources, /users     -> expose confidential margin data (costRate/billRate)
 *                               and the user->role directory: management/finance/pm.
 *   - /time-entries          -> the whole org's timesheets: any authenticated role.
 */
const READ_RULES: { test: (path: string) => boolean; roles: UserRole[] }[] = [
  { test: p => p.startsWith('/audit-logs'), roles: ['admin', 'delivery-executive'] },
  { test: p => ['/customers', '/contracts', '/orders', '/order-lines', '/billing-plan-items'].some(prefix => p.startsWith(prefix)), roles: ['sales', 'finance', 'delivery-executive', 'admin'] },
  // costRate/billRate live on resources and the user directory carries role
  // mappings — both need-to-know. Mirror the resource WRITE sensitivity, plus pm
  // and finance who legitimately read staffing/margin.
  { test: p => p === '/resources' || p.startsWith('/resources/') || p.startsWith('/users'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // Timesheets for the whole org: require an authenticated principal (any role),
  // never served to an unauthenticated ('unknown') caller.
  { test: p => p.startsWith('/time-entries'), roles: ['employee', 'pm', 'resource-manager', 'delivery-executive', 'finance', 'sales', 'admin'] },
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
) {
  router.get(`/${path}`, async (_req, res) => { res.json(await repo.list()); });
  router.post(`/${path}`, async (req, res) => {
    const data = pick(req.body, allowed);
    const bad = findInvalidNumericField(data, numericFields);
    if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
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
        const auditActorRole = trustedRole(req);
        const auditActorId = req.verifiedUserId ?? (trustHeaders ? req.header('X-User-Id') : undefined) ?? 'unknown';
        const entry: AuditEntry = {
          id: `AL${newId()}`,
          at: new Date().toISOString(),
          actorId: auditActorId,
          actorRole: auditActorRole,
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

const RESOURCE_FIELDS = ['name', 'role', 'skills', 'projectRoles', 'externalExperience', 'profilePicture', 'resume', 'capacity', 'managerId', 'organization', 'location', 'costRate', 'billRate'] as const;

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
 * B-UTILIZATION: recompute a resource's utilization FROM THE SOURCE OF TRUTH
 * (the sum of its assigned hours across all assignments) rather than mutating a
 * stored counter by deltas. Incremental ±contribution with a per-step
 * round+clamp[0,100] is lossy: a 100%→add→remove cycle permanently loses the
 * over-100 magnitude, an over-removal clamped at 0 destroys magnitude, and
 * Math.round on every step accumulates drift — so the stored number diverges
 * from reality and saturates irreversibly. We round/clamp only the final derived
 * value here. MUST be called inside `withLock('res:<id>')` so the read of all
 * assignments + the single write are serialized against concurrent changes.
 */
async function recomputeResourceUtilization(resourceId: string): Promise<void> {
  const resource = await repos.resources.get(resourceId);
  if (!resource) return;
  const assignments = await repos.assignments.list();
  let totalHours = 0;
  for (const a of assignments) {
    if (a.resourceId !== resourceId) continue;
    totalHours += Number.isFinite(a.assignedHours) ? a.assignedHours : 0;
  }
  await repos.resources.update(resourceId, { utilization: clampUtil(utilizationContribution(totalHours, resource.capacity)) });
}

apiRouter.get('/resources', async (_req, res) => { res.json(await repos.resources.list()); });
apiRouter.get('/users', async (_req, res) => { res.json(await repos.users.list()); });
apiRouter.get('/resources/:id', async (req, res) => {
  const resource = await repos.resources.get(req.params.id);
  return resource ? res.json(resource) : res.status(404).json({ error: 'Not found' });
});
apiRouter.put('/resources/:id', async (req, res) => {
  const existing = await repos.resources.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<Resource>(req.body, RESOURCE_FIELDS);
  // B-DATA: capacity is a divisor in utilization math; never allow 0/negative/NaN.
  if (body.capacity !== undefined && !(isNonNegNumber(body.capacity) && body.capacity > 0)) {
    res.status(400).json({ error: 'capacity must be a positive number' });
    return;
  }
  const updated = await repos.resources.update(req.params.id, body);
  res.json(updated);
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
  const body = pick<Assignment>(req.body, ['requestId', 'resourceId', 'assignedHours', 'status']);
  if (!isNonNegNumber(body.assignedHours)) {
    { res.status(400).json({ error: 'assignedHours must be a non-negative number' }); return; }
  }
  // B-DATA: an assignment must reference an existing request and resource.
  if (!(await existsRepo(repos.requests, body.requestId))) { res.status(400).json({ error: 'requestId must reference an existing request' }); return; }
  if (!(await existsRepo(repos.resources, body.resourceId))) { res.status(400).json({ error: 'resourceId must reference an existing resource' }); return; }
  const newAssig = { id: newId(), ...body } as Assignment;
  const created = await repos.assignments.create(newAssig);

  // B-CONCURRENCY + B-UTILIZATION: serialize per-resource and recompute
  // utilization from the full set of assignments (never a lossy running delta).
  await withLock(`res:${created.resourceId}`, () => recomputeResourceUtilization(created.resourceId));

  await withLock(`req:${created.requestId}`, async () => {
    const request = await repos.requests.get(created.requestId);
    if (request) {
      const staffedEffort = (request.staffedEffort ?? 0) + created.assignedHours;
      await repos.requests.update(request.id, { staffedEffort, status: requestStatusFor(request, staffedEffort) });
    }
  });
  res.json(created);
});
apiRouter.put('/assignments/:id', async (req, res) => {
  const oldAssig = await repos.assignments.get(req.params.id);
  if (oldAssig === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<Assignment>(req.body, ['requestId', 'resourceId', 'assignedHours', 'status']);
  if (body.assignedHours !== undefined && !isNonNegNumber(body.assignedHours)) {
    { res.status(400).json({ error: 'assignedHours must be a non-negative number' }); return; }
  }
  // B-DATA: when the FK targets change, the new targets must exist.
  if (body.resourceId !== undefined && body.resourceId !== oldAssig.resourceId && !(await existsRepo(repos.resources, body.resourceId))) {
    res.status(400).json({ error: 'resourceId must reference an existing resource' });
    return;
  }
  if (body.requestId !== undefined && body.requestId !== oldAssig.requestId && !(await existsRepo(repos.requests, body.requestId))) {
    res.status(400).json({ error: 'requestId must reference an existing request' });
    return;
  }
  const newAssig = { ...oldAssig, ...body };
  await repos.assignments.update(req.params.id, body);

  const resourceChanged = newAssig.resourceId !== oldAssig.resourceId;
  const requestChanged = newAssig.requestId !== oldAssig.requestId;

  // B-UTILIZATION: recompute utilization from the full set of assignments for
  // every affected resource (the source of truth), so FK retargeting and hours
  // changes are reflected exactly with no lossy running delta. When the resource
  // changes, BOTH the old and new resource are recomputed. Each recompute is
  // serialized per resource key (B-CONCURRENCY).
  if (resourceChanged) {
    await withLock(`res:${oldAssig.resourceId}`, () => recomputeResourceUtilization(oldAssig.resourceId));
    await withLock(`res:${newAssig.resourceId}`, () => recomputeResourceUtilization(newAssig.resourceId));
  } else {
    await withLock(`res:${newAssig.resourceId}`, () => recomputeResourceUtilization(newAssig.resourceId));
  }

  if (requestChanged) {
    // Fully back out the assignment's old hours from the OLD request...
    await withLock(`req:${oldAssig.requestId}`, async () => {
      const oldReq = await repos.requests.get(oldAssig.requestId);
      if (oldReq) {
        const staffedEffort = (oldReq.staffedEffort ?? 0) - oldAssig.assignedHours;
        await repos.requests.update(oldReq.id, { staffedEffort, status: requestStatusFor(oldReq, staffedEffort) });
      }
    });
    // ...and add the assignment's full hours to the NEW request.
    await withLock(`req:${newAssig.requestId}`, async () => {
      const newReq = await repos.requests.get(newAssig.requestId);
      if (newReq) {
        const staffedEffort = (newReq.staffedEffort ?? 0) + newAssig.assignedHours;
        await repos.requests.update(newReq.id, { staffedEffort, status: requestStatusFor(newReq, staffedEffort) });
      }
    });
  } else {
    await withLock(`req:${newAssig.requestId}`, async () => {
      const request = await repos.requests.get(newAssig.requestId);
      if (request) {
        const staffedEffort = (request.staffedEffort ?? 0) + (newAssig.assignedHours - oldAssig.assignedHours);
        await repos.requests.update(request.id, { staffedEffort, status: requestStatusFor(request, staffedEffort) });
      }
    });
  }
  res.json(newAssig);
});
apiRouter.delete('/assignments/:id', async (req, res) => {
  const oldAssig = await repos.assignments.get(req.params.id);
  if (oldAssig === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  await repos.assignments.remove(req.params.id);

  // B-CONCURRENCY + B-UTILIZATION: serialize per-resource and recompute
  // utilization from the remaining assignments (an over-removal can no longer
  // clamp the stored counter to 0 and destroy magnitude).
  await withLock(`res:${oldAssig.resourceId}`, () => recomputeResourceUtilization(oldAssig.resourceId));

  await withLock(`req:${oldAssig.requestId}`, async () => {
    const request = await repos.requests.get(oldAssig.requestId);
    if (request) {
      const staffedEffort = (request.staffedEffort ?? 0) - oldAssig.assignedHours;
      await repos.requests.update(request.id, { staffedEffort, status: requestStatusFor(request, staffedEffort) });
    }
  });
  res.status(204).send();
});

apiRouter.get('/time-entries', async (_req, res) => { res.json(await repos.timeEntries.list()); });
apiRouter.post('/time-entries', async (req, res) => {
  const body = pick<TimeEntry>(req.body, ['assignmentId', 'requestId', 'resourceId', 'projectId', 'date', 'hours', 'status', 'notes']);
  if (!isNonNegNumber(body.hours)) {
    res.status(400).json({ error: 'hours must be a non-negative number' });
    return;
  }
  const reqRef = await repos.requests.get(body.requestId ?? '');
  const item = {
    id: `TE${newId()}`,
    status: 'Draft',
    ...body,
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
  const item = { id: newId(), costCenters: [], ...pick(req.body, ['name', 'description', 'costCenters', 'serviceOrganizationId']) } as ResourceOrganization;
  res.json(await repos.resourceOrganizations.create(item));
});
apiRouter.put('/resource-organizations/:id', async (req, res) => {
  const existing = await repos.resourceOrganizations.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await repos.resourceOrganizations.update(req.params.id, pick(req.body, ['name', 'description', 'costCenters', 'serviceOrganizationId']));
  res.json(updated);
});
apiRouter.delete('/resource-organizations/:id', async (req, res) => { await repos.resourceOrganizations.remove(req.params.id); res.status(204).send(); });

const PROJECT_FIELDS = ['name', 'location', 'startDate', 'endDate', 'status', 'description', 'ownerId', 'contractId'] as const;
apiRouter.get('/projects', async (_req, res) => { res.json(await repos.projects.list()); });
apiRouter.post('/projects', async (req, res) => {
  const item = { id: newId(), ...pick(req.body, PROJECT_FIELDS) } as Project;
  res.json(await repos.projects.create(item));
});
apiRouter.put('/projects/:id', async (req, res) => {
  const existing = await repos.projects.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const updated = await repos.projects.update(req.params.id, pick(req.body, PROJECT_FIELDS));
  res.json(updated);
});
apiRouter.delete('/projects/:id', async (req, res) => { await repos.projects.remove(req.params.id); res.status(204).send(); });

// --- B1: project sub-resources (real endpoints, seeded on REAL ids 1/2) -----

crud(apiRouter, 'project-partners', repos.projectPartners, ['projectId', 'company', 'role', 'contact', 'status']);

crud(apiRouter, 'project-documents', repos.projectDocuments, ['projectId', 'name', 'type', 'size', 'uploadedAt', 'author', 'authorInitials']);

crud(apiRouter, 'work-packages', repos.workPackages, ['projectId', 'name', 'startDate', 'endDate', 'status', 'progress', 'assignee']);

interface MilestoneEntry { id: string; projectId: string; name: string; date: string; status: 'Pending' | 'Achieved'; approvedBy?: string; approvedAt?: string }
const MILESTONE_FIELDS = ['projectId', 'name', 'date', 'status', 'approvedBy', 'approvedAt'] as const;
apiRouter.get('/milestones', async (_req, res) => { res.json(await repos.milestones.list()); });
apiRouter.post('/milestones', async (req, res) => {
  const item = { id: newId(), ...pick<MilestoneEntry>(req.body, MILESTONE_FIELDS) } as MilestoneEntry;
  res.json(await repos.milestones.create(item));
});
apiRouter.put('/milestones/:id', async (req, res) => {
  const existing = await repos.milestones.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const previousStatus = existing.status;
  const body = pick<MilestoneEntry>(req.body, MILESTONE_FIELDS);
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

crud(apiRouter, 'project-financials', repos.projectFinancials, ['projectId', 'category', 'budget', 'actual'], ['budget', 'actual']);

crud(apiRouter, 'project-cost-centers', repos.projectCostCenters, ['projectId', 'name', 'manager', 'allocated', 'actual'], ['allocated', 'actual']);

crud(apiRouter, 'project-tasks', repos.projectTasks, ['projectId', 'name', 'assignee', 'assigneeType', 'partnerId', 'dueDate', 'status', 'priority']);

crud(apiRouter, 'project-issues', repos.projectIssues, ['projectId', 'title', 'type', 'severity', 'status', 'reportedBy', 'owner', 'dueDate', 'impact', 'actionPlan', 'escalated']);

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
  decidedBy?: string;
  decidedAt?: string;
}
// impactBudget/impactScheduleDays are intentionally allowed to be negative
// (a CR can reduce scope/budget), so they are NOT validated as non-negative.
const CHANGE_REQUEST_FIELDS = ['projectId', 'title', 'description', 'requestedBy', 'owner', 'status', 'impactScope', 'impactBudget', 'impactScheduleDays', 'priority', 'createdAt'] as const;
apiRouter.get('/change-requests', async (_req, res) => { res.json(await repos.changeRequests.list()); });
apiRouter.post('/change-requests', async (req, res) => {
  const item = { id: newId(), createdAt: new Date().toISOString(), ...pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_FIELDS) } as ChangeRequestEntry;
  res.json(await repos.changeRequests.create(item));
});
apiRouter.put('/change-requests/:id', async (req, res) => {
  const existing = await repos.changeRequests.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_FIELDS);
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
    const decider = actorId(req);
    if (decider === existing.requestedBy || decider === existing.owner) {
      res.status(403).json({ error: 'Segregation of duties: the requester/owner cannot approve their own change request' });
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
crud(apiRouter, 'cost-centers', repos.costCenters, ['name', 'manager', 'allocated', 'actual'], ['allocated', 'actual']);

// --- Commercial domain (ADR-0001): Customers, Contracts, Orders, OrderLines ---

crud(apiRouter, 'customers', repos.customers, ['name', 'industry', 'country']);

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
  const [entries, resources] = await Promise.all([repos.timeEntries.list(), repos.resources.list()]);
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

type ApprovalKind = 'TimeEntry' | 'Expense' | 'Milestone' | 'ChangeRequest' | 'Invoice';
type ApprovalStatus = 'Pending' | 'Approved' | 'Rejected';
interface ApprovalStep { role: string; status: ApprovalStatus; decidedBy?: string; decidedAt?: string }
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

const APPROVAL_KINDS: readonly ApprovalKind[] = ['TimeEntry', 'Expense', 'Milestone', 'ChangeRequest', 'Invoice'];
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

const APPROVAL_REQUEST_FIELDS = ['kind', 'refId', 'projectId', 'amount', 'requestedBy', 'note'] as const;

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
    requestedBy: typeof body.requestedBy === 'string' && body.requestedBy.length > 0 ? body.requestedBy : actorId(req),
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
apiRouter.put('/approval-requests/:id/decision', async (req, res) => {
  // Validate the decision up front (cheap, no shared state).
  const body = pick<{ decision: string }>(req.body, ['decision']);
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

  // B-CONCURRENCY: serialize the read-decide-write so two concurrent decisions
  // on the same multi-step request can't both read the same currentStep and
  // double-advance / clobber each other's decision. Re-read INSIDE the lock so
  // the decision is applied to the freshest state (mirrors the invoice-seq
  // critical section).
  const result = await withLock(`approval:${req.params.id}`, async (): Promise<{ status: number; body: unknown }> => {
    const ar = await repos.approvalRequests.get(req.params.id) as ApprovalRequestEntry | undefined;
    if (ar === undefined) return { status: 404, body: { error: 'Not found' } };
    if (ar.status !== 'Pending') return { status: 400, body: { error: `approval request already ${ar.status}` } };
    // SoD: the requester may never approve/reject their own item. Meaningful now
    // that `by` is the trusted principal rather than a forgeable body field.
    if (by === ar.requestedBy) {
      return { status: 403, body: { error: 'Segregation of duties: the requester cannot decide their own approval request' } };
    }
    const step = ar.steps[ar.currentStep];
    if (!step) return { status: 400, body: { error: 'No pending step to decide' } };
    // STEP-ROLE ENFORCEMENT: only an actor holding the role the routing assigned
    // to the CURRENT step may decide it (admin may decide any step). Without this
    // the coarse roleGate lets e.g. a pm decide a step routed to finance/
    // delivery-executive, defeating the built (incl. high-value 2-step) chain.
    if (decidingRole !== step.role && decidingRole !== 'admin') {
      return { status: 403, body: { error: `Role ${decidingRole} cannot decide a step assigned to ${step.role}` } };
    }
    const decidedAt = new Date().toISOString();
    step.decidedBy = by;
    step.decidedAt = decidedAt;
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
    return { status: 200, body: updated ?? ar };
  });
  res.status(result.status).json(result.body);
});

/** Default + maximum page size for the (unbounded) audit log read. */
const AUDIT_LOG_DEFAULT_LIMIT = 200;
const AUDIT_LOG_MAX_LIMIT = 1000;
apiRouter.get('/audit-logs', async (req, res) => {
  // AUDIT READ: never stream the entire ever-growing log. Sort newest-first
  // (by `at`, stable) and return a bounded page. `limit`/`offset` query params
  // allow pagination; both are clamped so a client cannot request the whole log.
  const all = (await repos.auditLogs.list()) as unknown as AuditEntry[];
  const sorted = [...all].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const rawLimit = Number(req.query['limit']);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, AUDIT_LOG_MAX_LIMIT) : AUDIT_LOG_DEFAULT_LIMIT;
  const rawOffset = Number(req.query['offset']);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  res.json(sorted.slice(offset, offset + limit));
});
apiRouter.get('/storage-status', (_req, res) => res.json({
  provider: process.env['DATABASE_URL'] ? 'postgresql' : 'memory',
  persistent: Boolean(process.env['DATABASE_URL']),
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
 *  - `idSeq` is set to the largest PURELY-NUMERIC id (matching /^\d+$/) seen
 *    across every repository. newId() only ever emits numeric ids, so prefixed
 *    ids ('TE1', 'CT1', 'AL…', 'AR…', …) are deliberately ignored — they are not
 *    produced by newId and must not move the counter.
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
    repos.resourceOrganizations, repos.projects, repos.projectPartners, repos.projectDocuments,
    repos.workPackages, repos.milestones, repos.projectFinancials, repos.projectCostCenters,
    repos.projectTasks, repos.projectIssues, repos.changeRequests, repos.costCenters,
    repos.customers, repos.contracts, repos.orders, repos.orderLines, repos.billingPlanItems,
    repos.fxRates, repos.approvalRequests, repos.auditLogs,
  ];

  // idSeq -> max purely-numeric id across all repositories.
  let maxNumericId = idSeq;
  const lists = await Promise.all(allRepos.map(r => r.list()));
  for (const rows of lists) {
    for (const row of rows) {
      if (/^\d+$/.test(row.id)) {
        const n = Number(row.id);
        if (Number.isInteger(n) && n > maxNumericId) maxNumericId = n;
      }
    }
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
