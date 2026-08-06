import { AngularNodeAppEngine, isMainModule, writeResponseToNodeResponse, createNodeRequestHandler } from '@angular/ssr/node';
import express, { Request, Response, NextFunction, Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { desc } from 'drizzle-orm';
import { getRepositories, withRepositoriesTransaction, type FxRateRow, type Repositories } from './db/repositories';
import { db, persistenceConfig } from './db/client';
import { auditLogs as auditLogsTable } from './db/schema';
import { initPersistence } from './db/bootstrap';
import type { Entity, Repository } from './db/repository';
import type { AuditLog, Resource, ResourceRequest, Assignment, AssignmentDay, AssignmentMonth, TimeEntry, Contract, Order, OrderLine, BillingPlanItem, ApprovalRequest, SkillCatalog, ProficiencySet, Skill, ProjectRole, ResourceOrganization, Country, Project, ProjectCostCenter, AllocationApprovalRow, AllocationApprovalItem, SubstitutionMonthOutcome, SubstitutionResult, NegotiatedRate, CostBaseline, UserRole } from './app/services/api.service';
import { utilizationContribution, requestStatusFor, isAllowedTimeEntryTransition, decisionToAssignmentStatus, allocationApproverStep } from './app/services/staffing.util';
import { deriveAssignmentStatus, monthRowId, parseMonthRowId, monthlyAggregateHours, type MonthStatus } from './app/services/allocation-month.util';
import { monthOf, isWorkingDay, sumHoursByDate, exceedsDailyCapacity, monthlyTargetHours } from './app/services/calendar.util';
import { planSubstitution, planGiveBack, planSubstitutionBooking, type SubstitutionPlan } from './app/services/substitution.util';
import { rollupMonthly, monthsInRange } from './app/services/capacity.util';
import { benchRollup } from './app/services/bench.util';
import { searchPage, clampSearchPage } from './app/services/search.util';
import { convertToBase, computeProjectFinancials, recognitionJournal, plannedCostSchedule, type FinanceData } from './app/services/finance.util';
import { negotiatedRateCurrencyError, sellRateFor } from './app/services/sell-rate.util';
import { pickRateCard } from './app/services/rate-card.util';
import { billingPlanValidationError, customerFacingBillingAmount } from './app/services/billing-validation.util';
import type { FxRate, RateCard } from './app/services/api.service';
import { isResourceKind, RESOURCE_KINDS, kindOf, dailyCapFor } from './app/services/resource-kind.util';
import { ORG_LEVELS, wouldCycleInOrgTree, wouldCycleInOrgChart, scopeOf, accountableApproversOf, nodeManagersAbove, isTerminatedAsOf, type OrgLevel, type OrgNode } from './app/services/org-scope.util';
import { maxIdSeq } from './server/id-seq.util';
import { isUuidV4, newEntityId } from './server/entity-id.util';
import { isFkViolation } from './server/fk-violation.util';
import { createCriticalSectionRunner } from './server/critical-section.util';
import {
  buildApprovalSteps,
  clientCreatableApprovalKindError,
  crossStepSoDError,
  milestoneApprovalPatch,
  resolveApprovalRoutingAmount,
  type ApprovalAmountSources,
} from './server/approval-policy.util';
import {
  applicationRoles,
  authorizeRead,
  hasAnyAllowedRole,
  isPublicReadPath,
  normalizeApiPath,
  primaryRole,
} from './server/authz-policy.util';
import { resourceIdFromOidcClaims } from './app/services/access-policy.util';
import { isOwnAssignment, pickSelfProfilePatch, selfAssignments, selfRequests, toSelfProfile } from './server/self-service.util';
import {
  COMMERCIAL_MUTATION_RULES,
  canAccessGlobalTimeEntry,
  canSubmitOwnTime,
  deriveTimeEntryLinks,
  hasGlobalApprovalRole,
  hasGlobalTimeEntryCollectionAccess,
  pinnedChangeRequestCreateFields,
  stepRoleMatch,
  changeRequestMutationError,
  changeRequestDeleteError,
  type GlobalTimeEntryAction,
  type TimeEntryPolicyContext,
} from './server/route-policy.util';
import {
  CommercialWriteError,
  createOrderWithLine as createOrderWithLineWrite,
  generateBillingInvoice as generateBillingInvoiceWrite,
  markBillingInvoicePaid as markBillingInvoicePaidWrite,
  billingPlanStatusTransitionError,
  billingPlanInvoicedFieldLockError,
  invoicedBillingItemDeleteError,
  issuedOrderDeleteError,
  issuedOrderFieldLockError,
  billingPlanCreateStatusError,
  isValidCommercialIdempotencyKey,
  type BillingInvoiceResult,
  type BillingPaymentResult,
  type OrderWithLineRequest,
} from './server/commercial-write.util';
import {
  applyGiveBackDays,
  applySubstitutionDays,
  closeSubstitutionLink,
} from './server/substitution-write.util';
import { InvoiceNumberCoordinator, type InvoiceNumberTransactionRunner } from './server/invoice-number.util';
import {
  AllocationLifecycleError,
  AllocationLifecycleExecutor,
  decideCurrentAllocationMonth,
  reviseAllocationMonthAfterEdit,
  submitAllocationMonth,
  type AllocationMonthDecisionCommit,
} from './server/allocation-lifecycle.util';
import {
  assignmentDeleteBlockError,
  assignmentRetargetError,
  assignmentServerOwnedFieldError,
  auditRegistryGaps,
  auditTargetRef,
  bookingOutsideEmploymentError,
  bookingWindowOutsideEmploymentError,
  buildMilestoneCreate,
  buildProjectWrite,
  buildRequestCreate,
  changeRequestPriorityError,
  contractHoursPerDayError,
  deleteOrgNodeWrite,
  documentProvenance,
  employmentWindowError,
  isNotNullViolation,
  issuedOrderLineStructureError,
  issuedOrderLineWriteError,
  milestoneStatusError,
  percentFieldError,
  referencedChildMessage,
  referentialViolationMessage,
  requestDeleteBlockError,
  requiredFieldError,
  resourceRequestUpdateError,
  retargetDailyCapacityError,
  signedIntegerFieldError,
  signedNumberFieldError,
  stripBlankForeignKeys,
  writeResourceOrganizationBinding,
  ORG_TREE_LOCK,
} from './server/operational-integrity.util';
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
 * Today as ISO 'YYYY-MM-DD'. THE server-side clock read for the org-scope layer
 * (`isTerminatedAsOf`/`accountableApproversOf` are pure and take the value as a
 * parameter, so the clock stays here). Mirrors the components' own `todayIso()`.
 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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
 * read-modify-write over a shared aggregate (a request's `staffedEffort` or a
 * resource's `utilization`) can interleave between its
 * `get()` and its `update()` — two concurrent writers both read the pre-state
 * and one increment is silently lost. There is no atomic-increment / FOR UPDATE
 * primitive on the `Repository<T>` boundary (it must serve both the in-memory
 * dev adapter and the Postgres adapter), so we serialize the whole
 * read-modify-write per logical key: each key holds a tail Promise and new work
 * chains onto it, guaranteeing strictly sequential execution per key while
 * different keys still run in parallel. Sufficient for the single-process Node
 * server; a multi-process deployment would additionally need a DB-level lock.
 */
// The implementation lives in `./server/critical-section.util` so it can be
// unit-tested (this module cannot be imported by Vitest — it instantiates the
// Angular SSR engine at load time). The registry there EVICTS a key once its own
// work has settled: keys are per-entity (`res:<id>`, `approval:<id>`, …) over a
// UUID id space, so the previous never-evicted Map grew for the lifetime of the
// process.
const withLock = createCriticalSectionRunner();

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

// UUIDs are generated independently by every worker/host; existing numeric and
// prefixed ids remain valid because every repository primary key is text.
const newId = newEntityId;

// Re-export the pure id-suffix scanner (imported above) so it is also reachable
// from this module. It is defined in its own side-effect-free module so it can be
// unit-tested without importing this SSR server (which instantiates the Angular
// app engine at load). Kept as a compatibility export for legacy-id tooling.
export { maxIdSeq };

/**
 * Process-wide repositories selected by the validated persistence configuration.
 * Declared early so it is in scope for the audit middleware and the boot
 * sequence below.
 */
const repos = getRepositories();

/**
 * Invoice numbers are allocated inside the same repository transaction that
 * persists the consuming order. The coordinator supplies the process-local
 * serialization needed by the in-memory adapter; PostgreSQL additionally takes
 * a transaction-scoped advisory lock per invoice year, shared by every worker.
 */
const invoiceNumberTransactionRunner: InvoiceNumberTransactionRunner<Repositories> =
  (lockKey, operation) => withRepositoriesTransaction(
    transactionRepos => operation(transactionRepos),
    { advisoryLockKeys: [lockKey] },
  );
const invoiceNumbers = new InvoiceNumberCoordinator(invoiceNumberTransactionRunner);

/**
 * One total order per assignment-month in this process, plus a PostgreSQL
 * transaction-scoped advisory lock for deployments with multiple workers.
 * The transaction makes approval + governed-month writes commit together.
 */
const allocationLifecycle = new AllocationLifecycleExecutor<Repositories>(
  (monthId, operation) => withRepositoriesTransaction(
    transactionRepos => operation(transactionRepos),
    { advisoryLockKeys: [`allocation-month:${monthId}`] },
  ),
);

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
  // MONEY-DEFINING MASTER DATA. Absent from this map, every mutation of the three
  // numbers that multiply the whole portfolio — an FX rate, a rate card's
  // cost/bill rate, and the hours-per-day that rescales every effective rate —
  // was recorded as `{changedKeys: [], before: undefined, after: undefined}`: the
  // trail knew a PUT happened and nothing about what it did, so a disputed
  // revaluation could not be reconstructed from it.
  ['rate-cards', repos.rateCards], ['negotiated-rates', repos.negotiatedRates],
  ['fx-rates', repos.fxRates], ['settings', repos.settings],
]);
// Fail loudly at boot rather than silently blinding the trail again: the map above
// is the ONLY thing standing between a money-defining mutation and an empty diff.
const auditGaps = auditRegistryGaps(auditRepoBySegment.keys());
if (auditGaps.length > 0) {
  throw new Error(`audit registry is missing money-defining collections: ${auditGaps.join(', ')}`);
}

/**
 * Find the current entity targeted by a `/collection/:id` request path.
 *
 * The path→(collection, id) resolution — including B3's nested per-month
 * sub-resource shape, the `/settings/hours-per-day` singleton and the
 * case-insensitive `/fx-rates/:currency` natural key — lives in
 * `auditTargetRef`, so it is unit-testable; this function is only the repository
 * lookup around it.
 */
async function findAuditEntity(path: string): Promise<Entity | undefined> {
  const ref = auditTargetRef(path);
  if (ref === undefined) return undefined;
  const repo = auditRepoBySegment.get(ref.segment);
  return repo ? repo.get(ref.id) : undefined;
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
    verifiedResourceId?: string;
    /** Complete filtered OIDC role set used for capability authorization. */
    verifiedRoles?: readonly UserRole[];
    /** Single primary role retained only for display, branching and audit labels. */
    verifiedRole?: UserRole | 'unknown';
  }
}

// --- Keycloak / OIDC backend verification -----------------------------------

const OIDC_ISSUER = process.env['OIDC_ISSUER'] || 'http://localhost:8081/realms/psa';
/** Public browser-facing issuer may differ from the API container's issuer/JWKS host. */
const OIDC_PUBLIC_ISSUER = process.env['OIDC_PUBLIC_ISSUER'] || OIDC_ISSUER;
const OIDC_CLIENT_ID = process.env['OIDC_CLIENT_ID'] || 'psa-web';
/**
 * Expected token audience (`aud`) for THIS API — the resource/client id Keycloak
 * stamps on access tokens minted for us. When set, `jwtVerify` both requires the
 * `aud` claim and rejects tokens issued for a different audience, preventing a
 * token minted for another client in the same realm from being replayed here
 * (confused-deputy / cross-audience escalation). When unset, audience is not
 * checked (preserves the local-dev default and existing tests).
 */
const OIDC_AUDIENCE = process.env['OIDC_AUDIENCE'];
const OIDC_JWKS_URI = process.env['OIDC_JWKS_URI'] || `${OIDC_ISSUER}/protocol/openid-connect/certs`;
/**
 * Remote JWKS for the Keycloak realm. `createRemoteJWKSet` lazily fetches and
 * caches the signing keys (with cooldown + rotation handling) so each request
 * does not hit the network. Kept module-scoped so the cache is shared.
 */
const JWKS = createRemoteJWKSet(new URL(OIDC_JWKS_URI));

/** Shape of the Keycloak claims we read; everything else on the token is ignored. */
interface KeycloakClaims extends JWTPayload {
  preferred_username?: string;
  resource_id?: string;
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
 * All recognised roles are retained for authorization. A separate primary role
 * is derived only for display/audit and legacy role-specific branching; userId
 * prefers preferred_username, falling back to sub.
 */
async function verifyBearer(req: Request): Promise<{
  userId: string;
  resourceId?: string;
  roles: UserRole[];
  primaryRole: UserRole | 'unknown';
} | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { payload } = await jwtVerify(token, JWKS, { issuer: OIDC_ISSUER, audience: OIDC_AUDIENCE });
  const claims = payload as KeycloakClaims;
  const roles = applicationRoles(Array.isArray(claims.realm_access?.roles) ? claims.realm_access.roles : []);
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  const userId = (typeof claims.preferred_username === 'string' && claims.preferred_username) || sub || 'unknown';
  return {
    userId,
    resourceId: resourceIdFromOidcClaims(claims as Record<string, unknown>),
    roles,
    primaryRole: primaryRole(roles),
  };
}

const actorId = (req: Request) => req.verifiedUserId || String(req.header('X-User-Id') || 'system');
const actorRole = (req: Request): UserRole | 'unknown' =>
  req.verifiedRole ?? primaryRole(applicationRoles([String(req.header('X-User-Role') || '')]));

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
  if (req.verifiedResourceId) return req.verifiedResourceId;
  const id = actorId(req);
  const user = (await repos.users.list()).find(u => u.id === id || u.name === id);
  return user?.resourceId;
}

/**
 * Resolve the request's actor to a DISPLAY NAME through the same users directory
 * `actorResourceId` walks. Used where a server-owned record has to name the person
 * (project-document provenance), so the name in the record is the verified
 * principal's rather than one the body chose.
 *
 * Falls back to the raw actor id: unlovely, but true. Labelling an unresolvable
 * principal with anything friendlier would be inventing an attribution, which is
 * the very defect this closes.
 */
async function actorDisplayName(req: Request): Promise<string> {
  const id = actorId(req);
  const user = (await repos.users.list()).find(u => u.id === id || u.name === id);
  return user?.name ?? id;
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

/** Complete trusted role set used by route-capability checks. */
const trustedRoles = (req: Request): readonly UserRole[] => {
  // Presence matters: a verified token with zero recognised roles must not fall
  // back to spoofable demo headers.
  if (req.verifiedRoles !== undefined) return req.verifiedRoles;
  if (req.verifiedRole !== undefined && req.verifiedRole !== 'unknown') return [req.verifiedRole];
  return trustHeaders ? applicationRoles([String(req.header('X-User-Role') || '')]) : [];
};

/** True for a verified JWT, or for an explicitly-enabled valid demo principal. */
const hasTrustedPrincipal = (req: Request): boolean =>
  req.verifiedRoles !== undefined || (trustHeaders && trustedRoles(req).length > 0);

// `canMutate(trustedRole(req), […])` — a single-role membership test — used to live
// here. It is gone deliberately: its last caller (POST /self/time-entries) was the
// one place still authorizing on the DISPLAY role instead of the verified role set,
// which locked a ['employee','sales'] principal out of their own timesheet. Every
// remaining authorization site goes through `hasAnyAllowedRole(trustedRoles(req), …)`,
// so the primary-vs-set confusion has no helper left to reintroduce it with.

/**
 * Resolve a verified/trusted actor to an existing resource for /self routes.
 * Unknown or unlinked principals fail closed; callers never supply the target id.
 */
async function requireSelfResourceId(req: Request, res: Response): Promise<string | undefined> {
  if (!hasTrustedPrincipal(req)) {
    res.status(401).json({ error: 'Authentication is required' });
    return undefined;
  }
  if (trustedRoles(req).length === 0) {
    res.status(403).json({ error: 'The signed-in identity has no application role' });
    return undefined;
  }
  const resourceId = await actorResourceId(req);
  if (!resourceId) {
    res.status(403).json({ error: 'The signed-in identity is not linked to a resource' });
    return undefined;
  }
  if (!(await repos.resources.get(resourceId))) {
    res.status(404).json({ error: 'The linked resource no longer exists' });
    return undefined;
  }
  return resourceId;
}

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
 * 2. For reads, allow anonymous access only to the exact public bootstrap paths;
 *    every other path requires an application role, then any narrower READ_RULE.
 * 3. Apply capability gating to mutating (POST/PUT/DELETE) requests.
 *
 * Async because JWT verification is async; on unexpected errors we delegate to
 * Express via next(err). Handlers still return void.
 */
async function roleGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const principal = await verifyBearer(req);
    if (principal) {
      req.verifiedUserId = principal.userId;
      req.verifiedResourceId = principal.resourceId;
      req.verifiedRoles = principal.roles;
      req.verifiedRole = principal.primaryRole;
    }
  } catch {
    // A Bearer token was present but failed verification (bad signature,
    // wrong issuer, expired, ...). Reject rather than degrade to header trust.
    res.status(401).json({ error: 'Invalid or expired bearer token' });
    return;
  }

  // NORMALISED, never `req.path` raw. Express routes case-insensitively (this app
  // does not enable `case sensitive routing`), while every literal in READ_RULES
  // and in the mutation `rules` table below is lowercase — so `GET /api/Audit-Logs`
  // used to reach the handler with NO rule matching it, handing the audit trail to
  // an `employee`, and `POST /api/Resources` with no bearer at all created a
  // resource with client-chosen rates. See `normalizeApiPath`.
  const path = normalizeApiPath(req.path);
  const role = trustedRole(req);
  const roles = trustedRoles(req);

  // READ-SIDE AUTHORIZATION is deny-by-default. Only the exact public bootstrap
  // paths bypass authentication; every other GET requires a trusted application
  // principal. READ_RULES may further narrow access to one or more capabilities.
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const readRule = READ_RULES.find(r => r.test(path));
    const decision = authorizeRead({
      isPublic: isPublicReadPath(path),
      authenticated: hasTrustedPrincipal(req),
      roles,
      allowedRoles: readRule?.roles,
    });
    if (!decision.allowed) {
      res.status(decision.status).json({ error: `Role ${role} cannot read ${path}` });
      return;
    }
    next();
    return;
  }

  const rules: { test: (path: string) => boolean; roles: readonly UserRole[] }[] = [
    // The commercial slice comes from ONE exported, order-sensitive array: the
    // narrow money-action rule (issue an invoice / settle it — finance-grade)
    // precedes the coarse commercial prefix rule that admits `sales`. Inlining the
    // two here again is how the narrow rule would end up after the coarse one and
    // become dead code that still reads as a guard.
    ...COMMERCIAL_MUTATION_RULES,
    { test: p => ['/project-financials', '/project-cost-centers', '/cost-centers'].some(prefix => p.startsWith(prefix)), roles: ['finance', 'delivery-executive', 'admin'] },
    // Cost baselines (design spec, block E, §5): freeze/re-freeze restricted to
    // finance-grade roles. pm/resource-manager can read it (READ_RULES below)
    // but must not be able to rewrite the metric they are measured against.
    { test: p => p.startsWith('/cost-baselines'), roles: ['finance', 'delivery-executive', 'admin'] },
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
    // need only a principal: no READ_RULE narrows them). Holidays (B1) joins this group.
    { test: p => ['/countries', '/cities', '/industries', '/cost-categories', '/partner-roles', '/vendors', '/holidays'].some(prefix => p.startsWith(prefix)), roles: ['admin', 'delivery-executive'] },
    // Planning periods (B1) open/close a calendar month for time-phased booking —
    // admin-only mutation (stricter than the config-catalog rule above). Reads need
    // only a principal (no READ_RULE below), so the Task-8 calendar
    // (pm/resource-manager) can render open/closed months.
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
  if (rule && !hasAnyAllowedRole(roles, rule.roles)) {
    res.status(403).json({ error: `Role ${role} cannot modify ${path}` });
    return;
  }
  next();
}

/**
 * READ-side capability rules. The middleware already requires a trusted
 * application principal for every non-public GET. A matching rule narrows that
 * authenticated baseline; no match means "any application role", never public.
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
  { test: p => ['/customers', '/contracts', '/orders', '/order-lines', '/billing-plan-items', '/negotiated-rates'].some(prefix => p.startsWith(prefix)), roles: ['sales', 'finance', 'delivery-executive', 'admin'] },
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
  // Extended (not duplicated) for Block F's '/bench/monthly': same audience,
  // deliberately excluding 'employee' (an org-wide idle-staff roster is
  // sensitive) and 'sales' (no staffing need-to-know) — design spec §8.
  { test: p => p.startsWith('/capacity') || p.startsWith('/bench'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // Cost baselines (design spec, block E, §5): read is DISJOINT from freeze —
  // pm/resource-manager can read the variance to act on it early, but cannot
  // freeze or re-freeze (§3.4: whoever is measured on the variance must not be
  // able to rewrite the metric). Mirrors the /capacity read set exactly.
  { test: p => p.startsWith('/cost-baselines'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  // Shared by Block F and block E: same need-to-know as '/capacity' and the
  // staffing reads above — these two collections feed exactly the same
  // pre-aggregated rollups those endpoints already serve to this audience,
  // just unaggregated for client-side (What-If sandbox) composition.
  { test: p => p.startsWith('/assignment-days') || p.startsWith('/assignment-months'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
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
  // Block G: optional fields this collection's GET should text-match on.
  // Default [] -- every OTHER crud() caller (cities, industries,
  // cost-categories, partner-roles, vendors, rate-cards, project-partners,
  // project-documents, work-packages, project-financials, project-tasks,
  // project-issues, cost-centers) passes nothing here and is byte-for-byte
  // unaffected: `q` is simply never read for their GET route.
  searchable: readonly (keyof T)[] = [],
  // ADAPTER PARITY: the columns schema.ts declares notNull. Required on create,
  // and never nullable on update — see `requiredFieldError`. Left empty for a
  // collection until its notNull set is transcribed, which keeps every existing
  // caller byte-identical.
  required: readonly string[] = [],
  // Nullable FKs whose blank ('' / null) form must reach the adapter as ABSENT.
  // `''` is a 23503 on Postgres and a stored empty string in memory.
  blankForeignKeys: readonly string[] = [],
  // SERVER-PINNED fields for a CREATE: columns whose value is derived from the
  // verified principal or the clock, never from the body. Folded in AFTER the
  // allow-list pick (so a client value cannot survive) and BEFORE the required
  // check (so they still satisfy their notNull columns). Deliberately not applied
  // on UPDATE: keeping them out of `allowed` is what makes them unchangeable
  // there, and re-pinning on every PUT would rewrite the original provenance.
  pinnedOnCreate?: (req: Request) => Promise<Record<string, unknown>>,
  // REFERENTIAL INTEGRITY for the DELETE, which the generic handler cannot express:
  // returns a 409 message when the row is still referenced, undefined to allow.
  // The bespoke deletes (/resource-organizations, /contracts, /milestones) all carry
  // such a check; a crud() collection had no way to declare one, so its rows were a
  // 204 in dev and a 23503 -> 409 under Postgres — the same request, two outcomes.
  deleteGuard?: (id: string) => Promise<string | undefined>,
) {
  router.get(`/${path}`, async (req, res) => {
    const all = await repo.list();
    if (searchable.length === 0) { res.json(all); return; } // unchanged for every non-searchable caller
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
    res.json(q === undefined ? all : searchPage(all, searchable, q, clampSearchPage(req.query)));
  });
  router.post(`/${path}`, async (req, res) => {
    // Blank nullable FKs are dropped BEFORE the required check, so a required
    // column sent as '' is reported as missing rather than reaching the adapter.
    const data = stripBlankForeignKeys(pick(req.body, allowed) as Record<string, unknown>, blankForeignKeys);
    // AFTER the pick, so the pinned values overwrite nothing a client could have
    // sent (those keys are not in `allowed` at all), and before the required check.
    if (pinnedOnCreate) Object.assign(data, await pinnedOnCreate(req));
    const missing = requiredFieldError(data, required, 'create');
    if (missing) { res.status(400).json({ error: missing }); return; }
    const bad = findInvalidNumericField(data, numericFields);
    if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
    if (validate) {
      const err = await validate(data);
      if (err) { res.status(400).json({ error: err }); return; }
    }
    const item = { id: newId(), ...data } as T;
    const created = await repo.create(item);
    res.json(created);
  });
  router.put(`/${path}/:id`, async (req, res) => {
    const existing = await repo.get(req.params.id);
    if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
    const data = stripBlankForeignKeys(pick(req.body, allowed) as Record<string, unknown>, blankForeignKeys);
    const nulled = requiredFieldError(data, required, 'update');
    if (nulled) { res.status(400).json({ error: nulled }); return; }
    const bad = findInvalidNumericField(data, numericFields);
    if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
    if (validate) {
      const err = await validate(data, { id: req.params.id });
      if (err) { res.status(400).json({ error: err }); return; }
    }
    const updated = await repo.update(req.params.id, data as Partial<T>);
    res.json(updated);
  });
  router.delete(`/${path}/:id`, async (req, res) => {
    // The 404 comes first, so a missing id is never reported as "still referenced".
    if (deleteGuard) {
      if ((await repo.get(req.params.id)) === undefined) {
        res.status(404).json({ error: 'Not found' }); return;
      }
      const refusal = await deleteGuard(req.params.id);
      if (refusal !== undefined) { res.status(409).json({ error: refusal }); return; }
    }
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
const RESOURCE_FIELDS = [
  'name', 'role', 'skills', 'projectRoles', 'externalExperience', 'profilePicture',
  'resume', 'capacity', 'contractHoursPerDay', 'managerId', 'organization',
  'location', 'hireDate', 'terminationDate', 'kind', 'vendorId',
] as const;

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
 * REFERENTIAL INTEGRITY for the project sub-resource collections mounted with
 * `crud()`. Six of them (project-partners, project-documents, work-packages,
 * project-financials, project-tasks, project-issues) declare `project_id` notNull
 * REFERENCES projects.id and never checked it: `projectId:'NOPE'` was a 200 plus an
 * unreachable row in memory, and under Postgres a 23503 the middleware reported as
 * "Cannot delete: the record is still referenced by other records" — for a CREATE.
 * An ABSENT projectId is passed through here (the PUT path must not be forced to
 * re-send it); `required` refuses it on create.
 */
async function validateProjectReference(projectId: unknown): Promise<string | null> {
  if (projectId === undefined) return null;
  if (!(await existsRepo(repos.projects, projectId))) return 'projectId must reference an existing project';
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
 * Run a `/resources` write inside the ORG-TREE section whenever it names an
 * organization, re-checking the name there so a concurrent node delete or rename
 * cannot land between the check and the write (see `ORG_TREE_LOCK` in
 * src/server/operational-integrity.util.ts for the exhibit and the lock order).
 *
 * Writes that do not touch `organization` never take the lock at all: their
 * binding cannot become dangling, so serializing them would be pure contention on
 * a global key. Shared by POST and PUT so the two can never diverge.
 */
async function bindOrganizationThen<R extends { status?: number; error?: string }>(
  organization: unknown,
  write: () => Promise<R>,
): Promise<R> {
  if (organization === undefined) return write();
  const outcome = await writeResourceOrganizationBinding(
    withLock,
    repos,
    organization,
    write,
  );
  if ('refusal' in outcome) return { status: outcome.refusal.status, error: outcome.refusal.error } as R;
  return outcome.written;
}

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
  // REVIEW ROUND 1 (Task 7 coordinator feedback, critical) — every check above
  // only ever looks at THIS record against ITS OWN parent; nothing looked the
  // other way, at EXISTING CHILDREN that point at this record as THEIRS. Left
  // unguarded: Platform (a practice, child Backend a competence) could have
  // its own level changed to 'capability' — Platform's own parent is cleared
  // correctly above, but Backend is left a competence whose parent is now a
  // capability, a state the level guard never re-validates because it only
  // ever runs against the record being edited, never against Backend. Every
  // resource at/under Backend then silently loses its practice dimension in
  // dimensionsOf() (reporting, rate-card resolution), with no error anywhere.
  // Only fires on an ACTUAL level change — comparing the RESOLVED `level`
  // against the record's own EXISTING level, not merely `body.level` being
  // present, because the UI's save() resends the unchanged level on every
  // edit (Task 7's orgForm always carries a `level` control).
  if (ctx?.id !== undefined && level !== undefined && existing !== undefined && level !== existing.level) {
    const children = all.filter(n => n.parentId === ctx.id);
    for (const child of children) {
      const wantedForChild = ORG_LEVELS[ORG_LEVELS.indexOf(child.level) - 1];
      if (wantedForChild !== level) {
        return `cannot change level to ${level}: existing ${child.level} child "${child.name}" requires a ${wantedForChild} parent`;
      }
    }
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
// CONCURRENCY: month-scoped callers run these writes through
// `allocationLifecycle`; legacy bare-assignment callers remain independent.
// Neither helper acquires its own lock, so the caller owns the complete command
// boundary and can include the governed day/month writes atomically.
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
 * runs through `allocationLifecycle` — Express handlers interleave freely
 * across every `await`, and two concurrent first-writes to the same new month
 * used to both miss the `get` and both `create`: an unmapped `23505`
 * (unique_violation) 500 on Postgres, and a genuine DUPLICATE row in memory
 * (the in-memory adapter's `create` just pushes, it has no key constraint), after
 * which the approval feed emitted two items with the same `assignmentMonthId`.
 * other. The executor also takes the same transaction-scoped advisory lock used
 * by submit/edit/decide, covering multi-worker PostgreSQL deployments.
 *
 * Belt-and-braces for a MULTI-PROCESS Postgres deployment (where the in-process
 * lock spans one process only): a failed `create` is re-`get` before rethrowing,
 * so losing the insert race still returns the winner's row instead of a 500.
 */
async function ensureAssignmentMonth(assignmentId: string, month: string): Promise<AssignmentMonth> {
  const id = monthRowId(assignmentId, month);
  return allocationLifecycle.run(id, async transactionRepos => {
    const existing = await transactionRepos.assignmentMonths.get(id);
    if (existing) return existing;
    try {
      return await transactionRepos.assignmentMonths.create({ id, assignmentId, month, status: 'Draft' } as AssignmentMonth);
    } catch (err) {
      const raced = await transactionRepos.assignmentMonths.get(id);
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
async function createAllocationApprovalEntry(
  req: Request,
  assig: Assignment,
  refId: string = assig.id,
  repositorySet: Repositories = repos,
): Promise<ApprovalRequest> {
  const createdAt = new Date().toISOString();
  const request = await repositorySet.requests.get(assig.requestId);
  const resource = await repositorySet.resources.get(assig.resourceId);
  const ar: ApprovalRequestEntry = {
    id: `AR${newId()}`, kind: 'Allocation', refId, projectId: request?.projectId,
    requestedBy: actorId(req), status: 'Pending',
    steps: [allocationApproverStep(resource?.managerId)], currentStep: 0,
    createdAt, slaDueAt: slaDueFrom(createdAt),
  };
  return repositorySet.approvalRequests.create(ar as ApprovalRequest);
}

async function createAllocationApproval(
  req: Request,
  assig: Assignment,
  refId: string = assig.id,
  repositorySet: Repositories = repos,
): Promise<string> {
  return (await createAllocationApprovalEntry(req, assig, refId, repositorySet)).id;
}

/** Withdraw a still-Pending allocation approval (no-op when absent or already decided). */
async function withdrawAllocationApproval(
  approvalId: string | undefined,
  reason: string,
  repositorySet: Repositories = repos,
): Promise<void> {
  if (!approvalId) return;
  const ar = await repositorySet.approvalRequests.get(approvalId);
  if (ar && ar.status === 'Pending') {
    await repositorySet.approvalRequests.update(ar.id, { status: 'Rejected', note: reason } as Partial<ApprovalRequest>);
  }
}

/**
 * True iff the actor proposing an allocation is one of the resource's
 * ACCOUNTABLE MANAGERS — the self-managed AUTO-APPROVAL shortcut. Compared in
 * resource-id space (the actor's `actorResourceId`), mirroring the decision
 * endpoint's own enforcement. Shared by the POST/PUT/submit/substitute handlers.
 *
 * WHY IT EXISTS: segregation of duties (in `decideOneApproval`) forbids the
 * requester from deciding their own approval. So when the person who may decide
 * an allocation is also the person proposing it, opening a real approval creates
 * a DEADLOCK: they cannot decide it (SoD), and nobody else is competent (scope).
 * This shortcut is what keeps "plan your own team, then confirm it" workable —
 * the approval is implicit, recorded by the month landing 'Allocated' with no
 * approvalId.
 *
 * D (review round 4, critical #2) — the shortcut used to compare ONLY against
 * `resource.managerId`, i.e. the ORG-CHART axis. D widened the APPROVER set to
 * the org-tree axis (a node's `managerId` — the manual's Capability Leader /
 * Practice Manager / Competence Manager) but not this shortcut, so the mainline
 * Practice Manager workflow deadlocked exactly as described above: plan your
 * practice's placeholders, submit, and then nobody but an admin can clear the
 * month. The org-tree axis now grants the SAME shortcut the org chart already
 * did.
 *
 * SCOPE OF THE WIDENING. The DEFECT being fixed is the DEADLOCK, so the widening
 * reaches exactly as far as a deadlock can, and no further. Two consequences,
 * both of them narrowings I had to be talked down to — recorded so the next
 * reader can see which rule is intended rather than inferring it from a test
 * that cannot tell the two apart:
 *
 *  - the ORG-CHART case is preserved BIT-FOR-BIT and answered FIRST (a direct
 *    `managerId` match short-circuits before any extra I/O, and is unaffected by
 *    both the termination filter and the sole-approver test below, exactly as
 *    today);
 *
 *  - the TRANSITIVE chart chain is NOT included, even though `decideOneApproval`
 *    admits it. A grand-manager's own proposal has never auto-approved and must
 *    not start: it cannot deadlock, because the DIRECT manager can still decide
 *    it. Including it would silently stop editing an 'Allocated' month from
 *    forcing re-approval whenever a senior manager made the edit — a live smoke
 *    check (`checkTimePhasedAllocation`, assignment 4 edited by resource '1',
 *    Alice's grand-manager) pins exactly that, and it caught this when the first
 *    cut of this fix over-reached;
 *
 *  - THE SAME REASONING ONE STEP FURTHER (review round 4, follow-up), and the
 *    sentence above is the argument: a node manager only faces a deadlock when
 *    they are the ONLY accountable approver. Where the resource ALSO has a direct
 *    people manager `M`, submitting used to open an approval that
 *    `allocationApproverStep` pinned to `M`, and `M` decided it — no SoD
 *    conflict, no scope refusal, nothing admin-only. Auto-approving there does
 *    not resolve a deadlock; it DELETES A WORKING HUMAN REVIEW STEP, and `M`
 *    never sees the month. Worst shape: a `pm` who manages a node would grant
 *    themselves unreviewed approval across their whole subtree, having been
 *    unable to decide an allocation at all before this wave. So the tree branch
 *    additionally requires the accountable set MINUS the proposer to be empty.
 *
 * The rule this leaves: auto-approve iff the proposer is the resource's DIRECT
 * people manager, or is an accountable manager with nobody else accountable
 * alongside them. Exactly the cases where a real approval would strand.
 */
async function autoApprovesAllocation(req: Request, resourceId: string): Promise<boolean> {
  const resource = await repos.resources.get(resourceId);
  if (resource === undefined) return false;
  const proposerResourceId = await actorResourceId(req);
  if (proposerResourceId === undefined) return false;
  // ORG CHART — unchanged behaviour, unchanged cost.
  if (resource.managerId !== undefined && resource.managerId === proposerResourceId) return true;
  // ORG TREE — the axis D added.
  const nodes = await repos.resourceOrganizations.list();
  const nodeManagers = nodeManagersAbove(resource, nodes);
  // Nobody is their own approver, so being the manager of your OWN node cannot
  // be an implicit self-approval either (`scopedApproversOf` removes the target
  // from its own set for the same reason).
  nodeManagers.delete(resource.id);
  if (!nodeManagers.has(proposerResourceId)) return false;
  const today = todayIso();
  // ALIGNMENT WITH THE DECISION: `accountableApproversOf` drops a terminated
  // manager, so one cannot decide explicitly — they must not receive an IMPLICIT
  // approval here either. An id that resolves to no resource fails open, the
  // same way it does in the approver set. MUST stay ABOVE the sole-approver test
  // below: a terminated sole node manager is absent from the accountable set, so
  // that test would find it empty and wave them through.
  const proposer = await repos.resources.get(proposerResourceId);
  if (proposer !== undefined && isTerminatedAsOf(proposer, today)) return false;
  // ...AND ONLY IF THERE IS NOBODY ELSE. See the SOLE-APPROVER note above: this
  // is the whole difference between resolving the deadlock and quietly deleting
  // a working human review step.
  const resources = await repos.resources.list();
  const { managerIds } = accountableApproversOf(resource, resources, nodes, today);
  managerIds.delete(proposerResourceId);
  return managerIds.size === 0;
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
const DEFAULT_HOURS_PER_DAY = 8;
/** The configured working hours/day (settings.hoursPerDay), default 8 if unset/invalid. */
async function getHoursPerDay(repositorySet: Repositories = repos): Promise<number> {
  const row = await repositorySet.settings.get('hoursPerDay');
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
async function resolveBaseCap(
  resource: { contractHoursPerDay?: number },
  repositorySet: Repositories = repos,
): Promise<number> {
  const raw = resource.contractHoursPerDay;
  return (typeof raw === 'number' && Number.isFinite(raw) && raw > 0)
    ? raw
    : await getHoursPerDay(repositorySet);
}
/**
 * Resolve a resource's rates (hybrid day model). Rate cards + the per-resource
 * override (the cost_rate/bill_rate columns) are in €/DAY. This exposes:
 *   - costRateOverride/billRateOverride — the raw €/day override (for the form),
 *   - costRateDay/billRateDay           — the effective €/day (override ?? card),
 *   - costRate/billRate                 — the effective €/HOUR (= €/day ÷ hpd),
 *     which all margin math (finance.util, billing, match, accrual) consumes.
 * `pickRateCard` now walks the org tree's ancestor chain (rate-card.util.ts,
 * design spec §2) — node, then nearest ancestor, then the generic card.
 */
function withEffectiveRates(r: Resource, cards: RateCard[], hpd: number, nodes: readonly OrgNode[]): Resource {
  const card = pickRateCard(cards, r.role, r.organization, nodes);
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
/** Resolve effective rates over a resource list (one shared rate-card + org-tree + hpd fetch). */
async function resolveResourceRates(rows: Resource[]): Promise<Resource[]> {
  const [cards, nodes] = await Promise.all([
    repos.rateCards.list() as unknown as Promise<RateCard[]>,
    repos.resourceOrganizations.list(),
  ]);
  const hpd = await getHoursPerDay();
  return rows.map(r => withEffectiveRates(r, cards, hpd, nodes));
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

apiRouter.get('/resources', async (req, res) => {
  const all = await repos.resources.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  const page = q === undefined ? all : searchPage(all, ['name', 'role', 'organization', 'location'], q, clampSearchPage(req.query));
  res.json(await resolveResourceRates(page));
});
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
  // exists anywhere else. UUID generation has no persistence side effect, so
  // generating before validation is harmless when a POST is rejected.
  const id = newId();
  // Phase E: map costRateOverride/billRateOverride onto the cost_rate/bill_rate
  // columns ('' / absent = inherit the role's rate card on read).
  const rateErr = applyRateOverrides(body, req.body);
  if (rateErr) { res.status(400).json({ error: rateErr }); return; }
  if (!(isNonNegNumber(body.capacity) && body.capacity > 0)) {
    res.status(400).json({ error: 'capacity must be a positive number' });
    return;
  }
  const contractDayErr = contractHoursPerDayError(body.contractHoursPerDay);
  if (contractDayErr) { res.status(400).json({ error: contractDayErr }); return; }
  const employmentErr = employmentWindowError(body, true);
  if (employmentErr) { res.status(400).json({ error: employmentErr }); return; }
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
    if (body.contractHoursPerDay === null) body.contractHoursPerDay = undefined;
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
  // ORG-TREE BINDING: when this create names an organization, the name check and
  // the write share the org-tree section, so a concurrent node delete/rename
  // cannot land between them (see `ORG_TREE_LOCK`). Nested INSIDE 'org-chart' and
  // OUTSIDE any `res:` lock, which is the documented total order.
  const finishPostBound = (): Promise<{ status?: number; error?: string; created?: Resource }> =>
    bindOrganizationThen(body.organization, finishPost);
  const result = body.managerId !== undefined
    ? await withLock('org-chart', async (): Promise<{ status?: number; error?: string; created?: Resource }> => {
        const effectiveManagerId = (body.managerId === '' || body.managerId === null) ? undefined : body.managerId;
        const all = await repos.resources.list();
        if (wouldCycleInOrgChart(id, effectiveManagerId, all)) {
          return { status: 400, error: 'managerId would close a cycle in the org chart' };
        }
        return finishPostBound();
      })
    : await finishPostBound();
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
  const contractDayErr = contractHoursPerDayError(body.contractHoursPerDay);
  if (contractDayErr) { res.status(400).json({ error: contractDayErr }); return; }
  const hireWasSupplied = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'hireDate');
  const effectiveEmployment = {
    hireDate: body.hireDate !== undefined ? body.hireDate : preflight.hireDate,
    terminationDate: body.terminationDate !== undefined ? body.terminationDate : preflight.terminationDate,
  };
  const employmentErr = employmentWindowError(effectiveEmployment, hireWasSupplied);
  if (employmentErr) { res.status(400).json({ error: employmentErr }); return; }
  if (body.terminationDate === '') body.terminationDate = null as unknown as undefined;
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

    const mergedResource = { ...current, ...body } as Resource;
    const mergedEmploymentErr = employmentWindowError(mergedResource, true);
    if (mergedEmploymentErr) return { status: 400, error: mergedEmploymentErr };
    const currentBaseCap = await resolveBaseCap(current);
    const newBaseCap = await resolveBaseCap(mergedResource);
    const currentCap = dailyCapFor(kindOf(current), currentBaseCap);
    const newCap = dailyCapFor(kindOf({ kind: mergedKind }), newBaseCap);
    const resourceAssignments = (await repos.assignments.list()).filter(a => a.resourceId === current.id);
    const requestsById = new Map((await repos.requests.list()).map(request => [request.id, request]));
    for (const assignment of resourceAssignments) {
      const linkedRequest = requestsById.get(assignment.requestId);
      const lifecycleWindowErr = bookingWindowOutsideEmploymentError({
        startDate: assignment.startDate ?? linkedRequest?.startDate,
        endDate: assignment.endDate ?? linkedRequest?.endDate,
      }, mergedResource);
      if (lifecycleWindowErr) {
        return { status: 400, error: `resource lifecycle would invalidate assignment ${assignment.id}: ${lifecycleWindowErr}` };
      }
    }
    const ids = new Set(resourceAssignments.map(a => a.id));
    const resourceDays = (await repos.assignmentDays.list()).filter(d => ids.has(d.assignmentId));
    const lifecycleBookingErr = bookingOutsideEmploymentError(resourceDays.map(day => day.date), mergedResource);
    if (lifecycleBookingErr) {
      return { status: 400, error: `resource lifecycle would invalidate an existing ${lifecycleBookingErr}` };
    }
    if (newCap < currentCap) {
      const byDate = sumHoursByDate(resourceDays);
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
  // The ORG TREE has its own, DISTINCT key (`ORG_TREE_LOCK`, see the
  // `/resource-organizations` handlers) for the same reason and with the same
  // discipline. The two never nest in either direction: nothing inside an
  // `org-chart` section touches `/resource-organizations` (the only read of
  // that catalog on this path, `validateResourceCatalogRefs`, runs BEFORE the
  // lock is taken), and nothing inside an `org-tree` section takes any lock at
  // all. No path can hold one while acquiring the other, so they cannot
  // deadlock regardless of which is notionally "first".
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
  // Same org-tree binding section as POST /resources — the rename guard at
  // PUT /resource-organizations/:id lost this race in exactly the same way.
  const finishPutBound = (): Promise<{ status?: number; error?: string; updated?: Resource }> =>
    bindOrganizationThen(body.organization, finishPut);
  const locked = body.managerId !== undefined
    ? await withLock('org-chart', async (): Promise<{ status?: number; error?: string; updated?: Resource }> => {
        if (body.managerId === '') body.managerId = null as unknown as undefined;
        const effectiveManagerId = body.managerId === null ? undefined : body.managerId;
        const all = await repos.resources.list();
        if (wouldCycleInOrgChart(req.params.id, effectiveManagerId, all)) {
          return { status: 400, error: 'managerId would close a cycle in the org chart' };
        }
        return finishPutBound();
      })
    : await finishPutBound();
  if (locked.error !== undefined) { res.status(locked.status ?? 400).json({ error: locked.error }); return; }
  const [resolved] = await resolveResourceRates([locked.updated as Resource]);
  res.json(resolved);
});

// --- Authenticated employee self-service ----------------------------------

apiRouter.get('/self/profile', async (req, res) => {
  const resourceId = await requireSelfResourceId(req, res);
  if (!resourceId) return;
  const resource = await repos.resources.get(resourceId);
  if (!resource) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(toSelfProfile(resource));
});

apiRouter.put('/self/profile', async (req, res) => {
  const resourceId = await requireSelfResourceId(req, res);
  if (!resourceId) return;
  const body = pickSelfProfilePatch(req.body);
  const roleError = await validateRoleRefs(body);
  if (roleError) { res.status(400).json({ error: roleError }); return; }
  const skillError = await validateSkillRefs(body, 'objects');
  if (skillError) { res.status(400).json({ error: skillError }); return; }
  const updated = await repos.resources.update(resourceId, body);
  if (!updated) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(toSelfProfile(updated));
});

apiRouter.get('/self/assignments', async (req, res) => {
  const resourceId = await requireSelfResourceId(req, res);
  if (!resourceId) return;
  res.json(selfAssignments(await repos.assignments.list(), resourceId));
});

apiRouter.get('/self/requests', async (req, res) => {
  const resourceId = await requireSelfResourceId(req, res);
  if (!resourceId) return;
  const [requests, assignments] = await Promise.all([repos.requests.list(), repos.assignments.list()]);
  res.json(selfRequests(requests, assignments, resourceId));
});

apiRouter.get('/self/time-entries', async (req, res) => {
  const resourceId = await requireSelfResourceId(req, res);
  if (!resourceId) return;
  res.json((await repos.timeEntries.list()).filter(entry => entry.resourceId === resourceId));
});

apiRouter.post('/self/time-entries', async (req, res) => {
  const resourceId = await requireSelfResourceId(req, res);
  if (!resourceId) return;
  // AUTHORIZE ON THE WHOLE VERIFIED ROLE SET, exactly as roleGate does. Collapsing
  // to the highest-priority role is a DISPLAY choice: a presales consultant whose
  // Keycloak roles are ['employee','sales'] resolves to primary 'sales', and every
  // submit of their OWN timesheet answered 403 while their reads (full set) returned
  // their bookings. `trustedRole` is kept for the message only.
  if (!canSubmitOwnTime(trustedRoles(req))) {
    res.status(403).json({ error: `Role ${trustedRole(req)} cannot submit time` });
    return;
  }

  const body = pick<TimeEntry>(req.body, ['assignmentId', 'date', 'hours', 'notes']);
  if (!body.assignmentId || !body.date || !(isNonNegNumber(body.hours) && body.hours > 0)) {
    res.status(400).json({ error: 'assignmentId, date and positive hours are required' });
    return;
  }
  if (!isIsoDateString(body.date)) {
    res.status(400).json({ error: 'date must be an ISO date string' });
    return;
  }
  // IDEMPOTENCY (P1-21). The key is the id's uuid segment, so a replayed request
  // targets the SAME row instead of inserting a second one, and the stored id
  // keeps the exact `TE<uuid-v4>` shape every other time entry has. Optional:
  // without a key the endpoint stays create-only (any older client keeps
  // working), which is why the client always sends one.
  const rawKey = (req.body as Record<string, unknown> | undefined)?.['idempotencyKey'];
  if (rawKey !== undefined && !isUuidV4(rawKey)) {
    res.status(400).json({ error: 'idempotencyKey must be a v4 UUID' });
    return;
  }
  const entryId = `TE${typeof rawKey === 'string' ? rawKey : newId()}`;

  const assignment = await repos.assignments.get(body.assignmentId);
  if (!assignment || !isOwnAssignment([assignment], body.assignmentId, resourceId)) {
    res.status(403).json({ error: 'The assignment does not belong to the signed-in resource' });
    return;
  }
  const request = await repos.requests.get(assignment.requestId);
  if (!request?.projectId) {
    res.status(400).json({ error: 'The assignment request is not linked to a project' });
    return;
  }

  // ONE WRITE, not create-then-transition. The previous shape was two repo calls
  // with no transaction and no compensation: if the second failed, a 'Draft'
  // orphan was left AND the retry created a SECOND entry — the duplicate P1-21
  // asked to prevent. A single create with the server-pinned status reaches the
  // same end state (a Submitted entry) and has no partial state to leave behind.
  // `status` is not in the pick() list above, so it can never be client-supplied.
  const submit = async (): Promise<{ status: number; body: unknown }> => {
    const existing = await repos.timeEntries.get(entryId);
    if (existing) {
      // REPLAY, not a conflict — as long as it is the same entry. A key reused
      // for a different entry is a client bug, and silently returning the old
      // row would hide a lost submission.
      const sameEntry = existing.resourceId === resourceId
        && existing.assignmentId === assignment.id
        && existing.date === body.date
        && existing.hours === body.hours;
      if (!sameEntry) {
        return { status: 409, body: { error: 'idempotencyKey already identifies a different time entry' } };
      }
      return { status: 200, body: existing };
    }
    const created = await repos.timeEntries.create({
      id: entryId,
      assignmentId: assignment.id,
      requestId: request.id,
      resourceId,
      projectId: request.projectId,
      date: body.date,
      hours: body.hours,
      notes: body.notes,
      status: 'Submitted',
    } as TimeEntry);
    return { status: 201, body: created };
  };
  // Serialize the get-then-create against a concurrent double submit of the SAME
  // key (a double click, or a retry racing the original): without it both callers
  // read "absent" and both create.
  const result = await withLock(`self-time-entry:${entryId}`, submit);
  res.status(result.status).json(result.body);
});

const REQUEST_FIELDS = ['name', 'requiredRole', 'requiredEffort', 'skills', 'description', 'startDate', 'endDate', 'status', 'requesterId', 'projectId'] as const;

apiRouter.get('/requests', async (req, res) => {
  const all = await repos.requests.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  res.json(q === undefined ? all : searchPage(all, ['name', 'description'], q, clampSearchPage(req.query)));
});
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
  // `skills` is a notNull jsonb column and this was the one create handler that did
  // not seed its array (every sibling does — see `buildRequestCreate`), so a POST
  // without it stored a row with no key in dev and 23502'd on Postgres.
  const newReq = { id: newId(), ...buildRequestCreate(body) } as ResourceRequest;
  const created = await repos.requests.create(newReq);
  res.json(created);
});
apiRouter.put('/requests/:id', async (req, res) => {
  const existing = await repos.requests.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ResourceRequest>(req.body, REQUEST_FIELDS);
  // Validate the COMPLETE post-update record, not only the supplied fragment:
  // partial date edits, required fields and server-derived effort/status values
  // must remain coherent together.
  const mergedErr = resourceRequestUpdateError(existing, body);
  if (mergedErr) { res.status(400).json({ error: mergedErr }); return; }
  // REFERENCE-DATA INTEGRITY: validate any supplied requiredRole against the catalog.
  const roleErr = await validateRoleRefs(body);
  if (roleErr) { res.status(400).json({ error: roleErr }); return; }
  // REFERENCE-DATA INTEGRITY (Phase C): validate any supplied skills[] against the catalog.
  const skillErr = await validateSkillRefs(body, 'names');
  if (skillErr) { res.status(400).json({ error: skillErr }); return; }
  // A required-effort edit can invalidate a previously derived Fulfilled state.
  // Re-derive when the client did not explicitly choose a publish/withdraw state.
  if (body.requiredEffort !== undefined && body.status === undefined) {
    const merged = { ...existing, ...body };
    body.status = requestStatusFor(merged, merged.staffedEffort ?? 0);
  }
  const updated = await repos.requests.update(req.params.id, body);
  res.json(updated);
});
apiRouter.delete('/requests/:id', async (req, res) => {
  // READ FIRST, so a missing id is a 404 and never reported as "still referenced" —
  // the shape DELETE /contracts and DELETE /vendors already use.
  const existing = await repos.requests.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  // REFERENTIAL INTEGRITY: assignments and time entries both carry a notNull
  // request_id FK. Deleting through them left the children pointing at nothing, and
  // an orphaned assignment's Submitted time entries can never be approved again (the
  // approval path resolves the request) — real worked hours that are never billed.
  const [assignments, timeEntries] = await Promise.all([repos.assignments.list(), repos.timeEntries.list()]);
  const blocking = requestDeleteBlockError(req.params.id, { assignments, timeEntries });
  if (blocking) { res.status(409).json({ error: blocking }); return; }
  const removed = await repos.requests.remove(req.params.id);
  if (!removed) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(204).send();
});

// Shared by Block F (bench.util's client-side composition, since the What-If
// sandbox mutates resources/requests only in memory and can never round-trip
// through the server) and block E (same underlying data, independently
// required by its own spec). Root-level, hyphenated, matching this file's own
// convention for a compound-concept collection (order-lines, billing-plan-items,
// change-requests, approval-requests, time-entries) — NOT nested under
// '/assignments', which has no precedent anywhere in this file for a second
// collection's list. `/assignment-months` itself is already a root path here
// (the C2 substitute action, POST /assignment-months/:id/substitute below).
apiRouter.get('/assignment-days', async (_req, res) => { res.json(await repos.assignmentDays.list()); });
apiRouter.get('/assignment-months', async (_req, res) => { res.json(await repos.assignmentMonths.list()); });

apiRouter.get('/assignments', async (_req, res) => { res.json(await repos.assignments.list()); });
apiRouter.post('/assignments', async (req, res) => {
  const ownedFieldErr = assignmentServerOwnedFieldError((req.body ?? {}) as object);
  if (ownedFieldErr) { res.status(400).json({ error: ownedFieldErr }); return; }
  const body = pick<Assignment>(req.body, ['requestId', 'resourceId', 'startDate', 'endDate', 'allocationPct']);
  // Resource Schedule: validate the optional booking window + allocation (no-op when omitted).
  const scheduleErr = validateAssignmentSchedule(body);
  if (scheduleErr) { res.status(400).json({ error: scheduleErr }); return; }
  // B-DATA: an assignment must reference an existing request and resource.
  const [targetRequest, targetResource] = await Promise.all([
    typeof body.requestId === 'string' ? repos.requests.get(body.requestId) : Promise.resolve(undefined),
    typeof body.resourceId === 'string' ? repos.resources.get(body.resourceId) : Promise.resolve(undefined),
  ]);
  if (!targetRequest) { res.status(400).json({ error: 'requestId must reference an existing request' }); return; }
  if (!targetResource) { res.status(400).json({ error: 'resourceId must reference an existing resource' }); return; }
  const employmentBookingErr = bookingWindowOutsideEmploymentError({
    startDate: body.startDate ?? targetRequest.startDate,
    endDate: body.endDate ?? targetRequest.endDate,
  }, targetResource);
  if (employmentBookingErr) { res.status(400).json({ error: employmentBookingErr }); return; }

  // B3: assignment status is DERIVED from its month rows (deriveAssignmentStatus)
  // — never set directly here. A brand-new assignment has no month rows yet, so
  // it starts 'Draft' (the same value deriveAssignmentStatus([]) returns). The
  // lifecycle (submit for approval, self-managed auto-approve, etc.) is now
  // driven exclusively by the per-month endpoints (PUT .../allocation,
  // POST .../months/:month/submit) once hours are booked into a month.
  const created = await repos.assignments.create({
    id: newId(),
    ...body,
    assignedHours: 0,
    status: 'Draft',
  } as Assignment);

  // B-CONCURRENCY + B-UTILIZATION: recompute BOTH aggregates from the full set of
  // assignments (never a lossy running delta). Sequential per-key locks.
  await withLock(`res:${created.resourceId}`, () => recomputeResourceUtilization(created.resourceId));
  await withLock(`req:${created.requestId}`, () => recomputeRequestStaffing(created.requestId));
  res.json(await repos.assignments.get(created.id));
});
apiRouter.put('/assignments/:id', async (req, res) => {
  const oldAssig = await repos.assignments.get(req.params.id);
  if (oldAssig === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const ownedFieldErr = assignmentServerOwnedFieldError((req.body ?? {}) as object);
  if (ownedFieldErr) { res.status(400).json({ error: ownedFieldErr }); return; }
  const body = pick<Assignment>(req.body, ['requestId', 'resourceId', 'startDate', 'endDate', 'allocationPct']);
  const targetResourceId = body.resourceId ?? oldAssig.resourceId;
  // Serialize the authoritative dependency check and write against BOTH the old
  // and prospective resources. Allocation writes and resource-lifecycle edits
  // use the same res:* locks, so none can create a day (or narrow employment)
  // between this check and the assignment update. Lock ids are always sorted.
  const mutateAssignment = async (): Promise<{ status?: number; error?: string; before?: Assignment; updated?: Assignment }> => {
    const current = await repos.assignments.get(req.params.id);
    if (!current) return { status: 404, error: 'Not found' };
    if (current.resourceId !== oldAssig.resourceId || current.requestId !== oldAssig.requestId) {
      return { status: 409, error: 'assignment target changed concurrently; reload before retrying' };
    }

    const effectiveRequestId = body.requestId ?? current.requestId;
    const effectiveResourceId = body.resourceId ?? current.resourceId;
    const [targetRequest, targetResource] = await Promise.all([
      repos.requests.get(effectiveRequestId),
      repos.resources.get(effectiveResourceId),
    ]);
    if (!targetRequest) return { status: 400, error: 'requestId must reference an existing request' };
    if (!targetResource) return { status: 400, error: 'resourceId must reference an existing resource' };

    const scheduleErr = validateAssignmentSchedule({
      startDate: body.startDate ?? current.startDate,
      endDate: body.endDate ?? current.endDate,
      allocationPct: body.allocationPct ?? current.allocationPct,
    });
    if (scheduleErr) return { status: 400, error: scheduleErr };

    const changesTarget = effectiveRequestId !== current.requestId || effectiveResourceId !== current.resourceId;
    if (changesTarget) {
      const timeEntries = await repos.timeEntries.list();
      const retargetErr = assignmentRetargetError(current, body, {
        hasTimeEntries: timeEntries.some(entry => entry.assignmentId === current.id),
      });
      if (retargetErr) return { status: 409, error: retargetErr };
    }

    // PER-DAY RECHECK ON THE RECEIVING RESOURCE. Day rows carry only
    // assignmentId, so they travel wholesale on a resourceId change and nothing
    // else re-validates them: without this, a retarget is a door around both
    // per-day invariants that PUT /assignments/:id/allocation enforces (daily
    // capacity, per-day employment), and clampUtil then hides the result at 100%.
    // See retargetDailyCapacityError's doc comment for the three-step sequence.
    // TOCTOU is free here: the double res: lock over BOTH the old and the new
    // resource is already held around this whole function, and allocation writes
    // and resource-lifecycle edits take the same res: locks, so no day row can
    // appear and no employment window can narrow between this check and the write.
    if (effectiveResourceId !== current.resourceId) {
      const movingDays = (await repos.assignmentDays.list()).filter(day => day.assignmentId === current.id);
      if (movingDays.length > 0) {
        const employmentErr = bookingOutsideEmploymentError(movingDays.map(day => day.date), targetResource);
        if (employmentErr) {
          return { status: 400, error: `retarget would invalidate an existing ${employmentErr}` };
        }
        const targetAssignmentIds = new Set((await repos.assignments.list())
          .filter(a => a.resourceId === effectiveResourceId && a.id !== current.id)
          .map(a => a.id));
        const existingDaysOnTarget = (await repos.assignmentDays.list())
          .filter(day => targetAssignmentIds.has(day.assignmentId));
        const capacityErr = retargetDailyCapacityError(
          movingDays,
          existingDaysOnTarget,
          dailyCapFor(kindOf(targetResource), await resolveBaseCap(targetResource)),
        );
        if (capacityErr) return { status: 400, error: capacityErr };
      }
    }

    const employmentBookingErr = bookingWindowOutsideEmploymentError({
      startDate: body.startDate ?? current.startDate ?? targetRequest.startDate,
      endDate: body.endDate ?? current.endDate ?? targetRequest.endDate,
    }, targetResource);
    if (employmentBookingErr) return { status: 400, error: employmentBookingErr };

    return { before: current, updated: await repos.assignments.update(req.params.id, body) };
  };
  const [firstResourceId, secondResourceId] = [oldAssig.resourceId, targetResourceId].sort();
  const mutation = firstResourceId === secondResourceId
    ? await withLock(`res:${firstResourceId}`, mutateAssignment)
    : await withLock(`res:${firstResourceId}`, () => withLock(`res:${secondResourceId}`, mutateAssignment));
  if (mutation.error) { res.status(mutation.status ?? 400).json({ error: mutation.error }); return; }
  const authoritativeOld = mutation.before as Assignment;

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
  // proposer an accountable manager of the NEW resource — its direct people
  // manager, or the manager of a node above it?) depends only on that resource
  // and the org tree, neither of which this loop touches, so it cannot change
  // between month rows of the same retarget. This is approval-repo I/O +
  // month-row writes only,
  // done OUTSIDE any res:/req: lock and never nested inside an aggregate
  // critical section (mirrors every other approval side-effect in this
  // file); the aggregate recomputes below stay LAST so they read the
  // post-retarget statuses.
  if (body.resourceId !== undefined && body.resourceId !== authoritativeOld.resourceId) {
    const mergedAssig = { ...authoritativeOld, ...body, id: authoritativeOld.id } as Assignment;
    const selfManaged = await autoApprovesAllocation(req, body.resourceId);
    const monthRows = (await repos.assignmentMonths.list())
      .filter(m => m.assignmentId === authoritativeOld.id && (m.status === 'Allocated' || m.status === 'Requested'));
    for (const row of monthRows) {
      const revised = await allocationLifecycle.run(row.id, async transactionRepos => {
        const current = await transactionRepos.assignmentMonths.get(row.id);
        if (!current || (current.status !== 'Allocated' && current.status !== 'Requested')) return undefined;
        const after = await reviseAllocationMonthAfterEdit(transactionRepos, row.id, {
          autoApprove: selfManaged,
          reason: 'resource retargeted',
          createApproval: () => createAllocationApprovalEntry(req, mergedAssig, row.id, transactionRepos),
        });
        return { before: current, after };
      });
      if (!revised) continue;
      const before = revised.before;
      // GOVERNANCE TRAIL: an 'Allocated' month walked back to 'Requested' means work
      // that WAS approved is no longer approved, and on the self-managed branch a
      // month is re-approved under a different assignee. Neither moved the parent
      // assignment, so neither appeared in the trail at all.
      await appendMonthTransitionAudit(req, before, revised.after);
      if (selfManaged) {
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
        if (before.replacedFromAssignmentMonthId !== undefined) {
          try {
            await returnHoursToDummy(req, before, mergedAssig, 'Approved');
          } catch (err) {
            console.error(`PUT /assignments/${authoritativeOld.id}: substitution give-back failed for month ${row.id} on retarget:`, err);
          }
        }
      }
    }
  }

  await refreshDerivedAssignmentStatus(req.params.id);

  const newResourceId = body.resourceId ?? authoritativeOld.resourceId;
  const newRequestId = body.requestId ?? authoritativeOld.requestId;
  const resourceChanged = newResourceId !== authoritativeOld.resourceId;
  const requestChanged = newRequestId !== authoritativeOld.requestId;

  // B-UTILIZATION + B-STAFFING: recompute BOTH aggregates from the full set of
  // assignments (the source of truth) for every affected resource/request — no
  // lossy running delta. On an FK retarget BOTH old and new are recomputed.
  // Sequential per-key locks, never nested; res: before req: (fixed lock order).
  if (resourceChanged) {
    await withLock(`res:${authoritativeOld.resourceId}`, () => recomputeResourceUtilization(authoritativeOld.resourceId));
    await withLock(`res:${newResourceId}`, () => recomputeResourceUtilization(newResourceId));
  } else {
    await withLock(`res:${newResourceId}`, () => recomputeResourceUtilization(newResourceId));
  }
  if (requestChanged) {
    await withLock(`req:${authoritativeOld.requestId}`, () => recomputeRequestStaffing(authoritativeOld.requestId));
    await withLock(`req:${newRequestId}`, () => recomputeRequestStaffing(newRequestId));
  } else {
    await withLock(`req:${newRequestId}`, () => recomputeRequestStaffing(newRequestId));
  }
  res.json(await repos.assignments.get(req.params.id));
});
apiRouter.delete('/assignments/:id', async (req, res) => {
  const oldAssig = await repos.assignments.get(req.params.id);
  if (oldAssig === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  // REFERENTIAL INTEGRITY, checked BEFORE any of the destructive work below: this
  // handler clears the day rows and the month rows (both `no action` FKs) but never
  // `time_entries.assignment_id`, which is equally notNull — so the same request
  // orphaned the logged actuals in memory and 409'd under Postgres. The guard sits
  // above the approval withdrawal and the give-back so a refusal writes nothing.
  const blockingEntries = assignmentDeleteBlockError(req.params.id, await repos.timeEntries.list());
  if (blockingEntries) { res.status(409).json({ error: blockingEntries }); return; }
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
    await allocationLifecycle.run(m.id, async transactionRepos => {
      const current = await transactionRepos.assignmentMonths.get(m.id);
      if (!current) return;
      await withdrawAllocationApproval(current.approvalId, 'assignment deleted', transactionRepos);
      await transactionRepos.assignmentMonths.remove(m.id);
    });
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
async function recomputeAssignedHours(
  assignmentId: string,
  repositorySet: Repositories = repos,
): Promise<void> {
  const remaining = (await repositorySet.assignmentDays.list()).filter(d => d.assignmentId === assignmentId);
  const total = remaining.reduce((s, d) => s + (Number.isFinite(d.hours) ? d.hours : 0), 0);
  await repositorySet.assignments.update(assignmentId, { assignedHours: Math.round(total * 100) / 100 });
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
// working-day, daily-capacity. Then:
//   1. under the resource TOCTOU lock and the month lifecycle transaction,
//      replace day rows, derive assignedHours and rotate the approvalId revision
//      for Requested/Allocated months as one atomic command;
//   2. recompute `assignments.status` as a DERIVED rollup of all its months;
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
  const positiveDates = Object.entries(daily).filter(([, hours]) => hours > 0).map(([day]) => day);
  const employmentBookingErr = bookingOutsideEmploymentError(positiveDates, resource);
  if (employmentBookingErr) { res.status(400).json({ error: employmentBookingErr }); return; }

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
  let cap = dailyCapFor(kindOf(resource), baseCap);
  const requestedDates = new Set(Object.keys(daily));
  const capExceeded = (day: string): string => `daily capacity exceeded on ${day}`;
  const capacityOffender = async (repositorySet: Repositories = repos): Promise<string | undefined> => {
    const otherIds = new Set(
      (await repositorySet.assignments.list()).filter(a => a.resourceId === resource.id && a.id !== assig.id).map(a => a.id));
    const otherByDate = sumHoursByDate(
      (await repositorySet.assignmentDays.list()).filter(d => otherIds.has(d.assignmentId) && requestedDates.has(d.date)));
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

  const allocationMonthId = monthRowId(assig.id, month);
  const selfManaged = await autoApprovesAllocation(req, resource.id);

  // The day replacement and approval revision are one month command and one DB
  // transaction. A concurrent decision therefore lands wholly before the edit
  // (and the edit opens a fresh revision) or wholly after it (and its old
  // approvalId fails the CAS); it can never approve the new hours under the old
  // request. The resource lock retains the capacity TOCTOU guard.
  // GOVERNANCE TRAIL for the month row itself (see the note below the lifecycle
  // call). Captured inside the transaction, written after it commits.
  let monthBefore: AssignmentMonth | undefined;
  let monthAfter: AssignmentMonth | undefined;
  const replaced = await withLock(`res:${resource.id}`, () => allocationLifecycle.run(
    allocationMonthId,
    async (transactionRepos): Promise<{ offender?: string; error?: string; status?: number }> => {
      const currentAssignment = await transactionRepos.assignments.get(assig.id);
      if (!currentAssignment
          || currentAssignment.resourceId !== assig.resourceId
          || currentAssignment.requestId !== assig.requestId) {
        return { status: 409, error: 'assignment target changed while its allocation was being edited' };
      }
      const currentResource = await transactionRepos.resources.get(resource.id);
      if (!currentResource) return { status: 409, error: 'assignment resource disappeared while allocating' };
      const currentEmploymentErr = bookingOutsideEmploymentError(positiveDates, currentResource);
      if (currentEmploymentErr) return { status: 400, error: currentEmploymentErr };
      cap = dailyCapFor(
        kindOf(currentResource),
        await resolveBaseCap(currentResource, transactionRepos),
      );
      const offender = await capacityOffender(transactionRepos);
      if (offender !== undefined) return { offender };

      if (!(await transactionRepos.assignmentMonths.get(allocationMonthId))) {
        await transactionRepos.assignmentMonths.create({
          id: allocationMonthId,
          assignmentId: assig.id,
          month,
          status: 'Draft',
        } as AssignmentMonth);
      }

      const existing = (await transactionRepos.assignmentDays.list())
        .filter(d => d.assignmentId === assig.id && monthOf(d.date) === month);
      for (const d of existing) await transactionRepos.assignmentDays.remove(d.id);
      for (const day of requestedDates) {
        const hours = daily[day];
        if (hours > 0) {
          await transactionRepos.assignmentDays.create({
            id: `${assig.id}:${day}`, assignmentId: assig.id, date: day, hours,
          } as AssignmentDay);
        }
      }
      await recomputeAssignedHours(assig.id, transactionRepos);
      monthBefore = await transactionRepos.assignmentMonths.get(allocationMonthId);
      monthAfter = await reviseAllocationMonthAfterEdit(transactionRepos, allocationMonthId, {
        autoApprove: selfManaged,
        createApproval: () => createAllocationApprovalEntry(req, assig, allocationMonthId, transactionRepos),
      });
      return {};
    },
  ));
  if (replaced.error !== undefined) { res.status(replaced.status ?? 400).json({ error: replaced.error }); return; }
  if (replaced.offender !== undefined) { res.status(400).json({ error: capExceeded(replaced.offender) }); return; }
  // GOVERNANCE TRAIL. `autoApprovesAllocation` makes this endpoint an IMPLICIT
  // SELF-APPROVAL for a manager editing their own report's month: the pending
  // approval is withdrawn and the row is rewritten `status:'Allocated', approvalId
  // cleared` with no approval request left to decide. The audit middleware only ever
  // saw the ASSIGNMENT, whose assignedHours and derived status are unchanged when
  // hours merely move between days — so the trail's sole record of the operation was
  // `{path:'/assignments/A1/allocation', changedKeys: []}`: an entry that
  // affirmatively asserts nothing changed, on the one act an audit trail exists to
  // catch. Written only when the month row actually MOVED, so an unchanged row does
  // not add a second empty-diff entry alongside the middleware's.
  await appendMonthTransitionAudit(req, monthBefore, monthAfter);
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
async function syncSubstitutionBooking(
  assignmentId: string,
  dailyCap: number,
  // Takes the SAME `repositorySet` seam as `recomputeAssignedHours`, so the
  // window/pct write commits inside the substitution's transaction with the day
  // rows it is derived from. Reading the day rows through the process-wide
  // `repos` while the rows were being written through a transaction would derive
  // the booking from the PRE-transfer picture.
  repositorySet: Repositories = repos,
): Promise<void> {
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const hoursByMonth: Record<string, number> = {};
  for (const d of await repositorySet.assignmentDays.list()) {
    if (d.assignmentId !== assignmentId || !Number.isFinite(d.hours) || d.hours <= 0) continue;
    const m = monthOf(d.date);
    hoursByMonth[m] = round2((hoursByMonth[m] ?? 0) + d.hours);
  }
  const months = Object.keys(hoursByMonth).sort();
  if (months.length === 0) return;

  // Capacity over every month the window SPANS, not just the ones carrying hours:
  // the pct is one constant across the whole window (see `planSubstitutionBooking`).
  const holidays = new Set((await repositorySet.holidays.list()).map(h => h.id));
  const capacityByMonth: Record<string, number> = {};
  for (const m of monthsInRange(months[0], months[months.length - 1])) {
    capacityByMonth[m] = monthlyTargetHours(dailyCap, m, holidays);
  }

  const booking = planSubstitutionBooking(hoursByMonth, capacityByMonth);
  if (booking !== undefined) await repositorySet.assignments.update(assignmentId, booking);
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
  let cap = dailyCapFor(kindOf(target), targetBaseCap);

  const [firstId, secondId] = [dummyAssig.resourceId, target.id].sort();
  // ONE TRANSACTION FOR THE WHOLE WRITE SECTION, inside both `res:` locks (the
  // locks stay outside, exactly as PUT /assignments/:id/allocation does).
  //
  // The two writes per date — add to the target, then reduce/remove the dummy —
  // were untransacted, so a failure between them left the same hours booked on
  // BOTH assignments; and `recomputeAssignedHours` ran only after the loop, so
  // neither side's total matched its rows. Every aggregate recomputes from
  // `assignmentDays`, so the phantom copy inflated the target's utilization and
  // showed the same hours twice on /schedule and /capacity — and the retry then
  // reported "the target has no capacity left in this month", blaming the target
  // for a copy of the dummy's own hours. `applySubstitutionDays` journals and
  // compensates for the in-memory adapter, where
  // `withRepositoriesTransaction` is a pass-through.
  //
  // `createdAssignmentIds` is deliberately mutated only AFTER the transaction
  // commits: a rolled-back target assignment must not leave its id behind, or a
  // later month of the same batch would treat a planner's assignment as one this
  // substitution created and overwrite its booking window.
  const {
    plan, targetAssig: lockedTargetAssig, baseline, blocked, createdTargetAssignmentId,
  } = await withLock(`res:${firstId}`, () => withLock(`res:${secondId}`, () => withRepositoriesTransaction(async (transactionRepos): Promise<{ plan: SubstitutionPlan; targetAssig?: Assignment; baseline: Record<string, number>; blocked?: string; createdTargetAssignmentId?: string }> => {
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
    const assignments = await transactionRepos.assignments.list();
    const existingTargetAssig = assignments.find(a => a.resourceId === target.id && a.requestId === dummyAssig.requestId);

    const allDays = await transactionRepos.assignmentDays.list();
    const dummyDays = allDays.filter(d => d.assignmentId === dummyAssig.id && monthOf(d.date) === month);
    const dummyByDate = sumHoursByDate(dummyDays);
    const currentTarget = await transactionRepos.resources.get(target.id);
    if (!currentTarget) {
      return {
        plan: planSubstitution(dummyByDate, {}, 0),
        targetAssig: existingTargetAssig,
        baseline: {},
        blocked: 'the target resource no longer exists',
      };
    }
    const employmentErr = bookingOutsideEmploymentError(Object.keys(dummyByDate), currentTarget);
    if (employmentErr) {
      return {
        plan: planSubstitution(dummyByDate, {}, 0),
        targetAssig: existingTargetAssig,
        baseline: {},
        blocked: employmentErr,
      };
    }
    cap = dailyCapFor(kindOf(currentTarget), await resolveBaseCap(currentTarget, transactionRepos));

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
    const targetAssig = existingTargetAssig ?? await transactionRepos.assignments.create({
      id: newId(), requestId: dummyAssig.requestId, resourceId: target.id,
      assignedHours: 0, status: 'Draft',
    } as Assignment);
    const createdHere = existingTargetAssig === undefined;

    // THE PRE-TRANSFER BASELINE, per date: what she already held on that date on
    // THIS assignment. Captured by `applySubstitutionDays` at the moment of the
    // write, inside both locks and inside this transaction, because that is the
    // only moment it is knowable. After the transfer her day row carries her own
    // hours and the loan fused into one number, and the give-back cannot tell
    // them apart: charging the whole of it against the loan destroys booked hours
    // on a trim (see `planGiveBack`). Recorded for EVERY date in the map, zeros
    // included, so the two maps always cover the same dates.
    const { baseline } = await applySubstitutionDays(
      transactionRepos.assignmentDays,
      p,
      dummyAssig.id,
      targetAssig.id,
    );

    // The window + pct for an assignment THIS substitution created — after the day
    // rows are written, so it reads the complete picture, and inside the locks that
    // serialize those rows. Skipped for a planner-created assignment: its own
    // booking window is not ours to overwrite. `createdHere` rather than the
    // caller's Set, which is only updated once this transaction has committed.
    if (createdHere || createdAssignmentIds.has(targetAssig.id)) {
      await syncSubstitutionBooking(targetAssig.id, cap, transactionRepos);
    }

    // recomputeAssignedHours is called only now that `p.transfer` is known
    // non-empty (review finding, Important #2): calling it unconditionally
    // rewrote BOTH assignments' assignedHours to the sum of their (unchanged)
    // day rows even on a zero-transfer attempt — silently zeroing a LEGACY
    // assignment that carries an assignedHours total with no day rows at all
    // (the exact case recomputeAssignedHours's own doc comment calls out).
    // Inside the transaction, so the totals can never survive a rolled-back
    // transfer and misstate rows that were put back.
    await recomputeAssignedHours(dummyAssig.id, transactionRepos);
    await recomputeAssignedHours(targetAssig.id, transactionRepos);
    return {
      plan: p,
      targetAssig,
      baseline,
      createdTargetAssignmentId: createdHere ? targetAssig.id : undefined,
    };
  })));
  // Only now that the transaction has committed does the caller learn this
  // substitution owns the target's assignment (see the note above the lock).
  if (createdTargetAssignmentId !== undefined) createdAssignmentIds.add(createdTargetAssignmentId);

  if (blocked !== undefined) {
    return { month, transferredHours: 0, remainingHours: plan.remainingHours, skipped: blocked };
  }

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

  // SERIALIZED through the same allocation-lifecycle executor as edit/submit/decide.
  // read `approvalId` -> withdraw -> create -> write is a read-modify-write over one
  // SHARED row: two substitutions of two different dummy months onto the SAME person
  // (normal when one request needs several people) both read the same approvalId,
  // both withdraw it, both open a fresh approval and both write their own — leaving
  // one Pending and ORPHANED, decidable later against a month row that has moved on.
  // The same race runs against a concurrent `PUT /assignments/:id/allocation` on this
  // month, so the same approvalId CAS/version ordering applies here too. The
  // resource locks and the earlier ensure command have both completed before
  // this transaction starts; decision give-back takes resource locks only after
  // its own lifecycle command commits, so no lock cycle is reachable.
  const wasAllocated = await allocationLifecycle.run(targetRow.id, async (transactionRepos): Promise<boolean> => {
    // RE-READ rather than reuse the `ensureAssignmentMonth` snapshot: `approvalId`,
    // `status` and `plannerNote` are shared mutable state and several awaits have
    // passed. Withdrawing a STALE approvalId cancels an approval that no longer
    // governs anything and leaves the current one Pending and orphaned.
    const current = await transactionRepos.assignmentMonths.get(targetRow.id) ?? targetRow;
    const priorStatus = current.status;
    await withdrawAllocationApproval(current.approvalId, 'superseded by substitution', transactionRepos);

    const note = `Takes over from ${dummyName} — ${month}`;
    const plannerNote = current.plannerNote ? `${current.plannerNote}\n${note}` : note;

    if (selfManaged) {
      // No decision will follow, so there is nothing to give back later: close the
      // link immediately rather than leaving it dangling forever.
      await transactionRepos.assignmentMonths.update(targetRow.id, {
        status: 'Allocated', approvalId: null as unknown as undefined,
        replacedFromAssignmentMonthId: null as unknown as undefined,
        replacedDays: null as unknown as undefined,
        replacedBaselineDays: null as unknown as undefined, plannerNote,
      } as Partial<AssignmentMonth>);
    } else {
      const approvalId = await createAllocationApproval(req, targetAssig, targetRow.id, transactionRepos);
      // `plan.transfer` — the PER-DAY map of what moved, not just its total: the
      // give-back at decision time is decided day by day (`returnHoursToDummy`).
      // `baseline` is its other half: what she ALREADY held on those dates, without
      // which a trim on a shared date cannot be told from a trim of the loan.
      await transactionRepos.assignmentMonths.update(targetRow.id, {
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
 * All three substitution columns are cleared with explicit `null`s (the
 * documented "clear to absent" patch value on BOTH adapters) on every path that
 * COMPLETES — the no-ops included. A decided month must never be mistaken for a
 * pending substitution, or a retry/second decision could return the same hours
 * twice; the fresh-read guard in `moveBack` is what makes that safe.
 *
 * A give-back that THROWS is the one case that leaves the link intact, on
 * purpose. It used to be cleared in an unconditional `finally`, which made a
 * half-completed reversal both permanent (the hours stayed booked on both sides)
 * and unrepeatable (nothing would ever run the give-back again). The day writes,
 * the recomputes and the clear now commit together inside one
 * `withRepositoriesTransaction` (`applyGiveBackDays`), so the month is either
 * fully settled or fully retryable.
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

  // Closed on the SUCCESS path and on the WRITE-NOTHING no-ops below — never in a
  // `finally`. It used to be unconditional, which is what made a half-completed
  // give-back permanent AND unrepeatable: the month stopped looking like a pending
  // substitution, so no later decision, retarget or delete would run the reversal
  // again. On the path that DOES write day rows, the clear is issued by
  // `applyGiveBackDays` inside the same transaction as those writes, because the
  // two must commit together.
  const closeLink = (): Promise<void> => closeSubstitutionLink(repos.assignmentMonths, row.id);

  const dummyRow = await repos.assignmentMonths.get(linkId);
  const dummyAssig = dummyRow ? await repos.assignments.get(dummyRow.assignmentId) : undefined;
  const dummyResource = dummyAssig ? await repos.resources.get(dummyAssig.resourceId) : undefined;
  if (dummyRow === undefined || dummyAssig === undefined || dummyResource === undefined) {
    console.warn(`give-back: month ${row.id} came from ${linkId}, which no longer exists — closing the link without returning hours`);
    await closeLink();
    return;
  }

  // The DUMMY's own daily ceiling (multi-FTE: it stands for capacity a single
  // person does not cover). Refreshed inside both locks before planning so a
  // concurrent contract-hours/lifecycle edit cannot make the write stale.
  let dummyCap = dailyCapFor(kindOf(dummyResource), await resolveBaseCap(dummyResource));

  const moveBack = async (): Promise<{ giveBackHours: number; shortfallHours: number; settled: boolean }> => {
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
    // Nothing left to clear on this path: the concurrent caller already closed the
    // link, so `settled: true` reports it settled without a second write.
    const fresh = await repos.assignmentMonths.get(row.id);
    if (fresh === undefined || fresh.replacedFromAssignmentMonthId === undefined) {
      // Not silent: this is a real interleaving, not a bug, but "the hours were
      // already returned by someone else" is exactly the kind of thing that must
      // be reconstructable afterwards.
      console.warn(`give-back: month ${row.id} was already unlinked by a concurrent caller — returning nothing`);
      return { giveBackHours: 0, shortfallHours: 0, settled: true };
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

    const currentDummyResource = await repos.resources.get(dummyAssig.resourceId);
    const blockedHours = round2(Object.values(replacedDays).reduce((sum, hours) => sum + hours, 0));
    if (!currentDummyResource) {
      // WROTE NOTHING, so the caller settles the link itself (`settled: false`):
      // a retry could not do better, and leaving the month linked would make a
      // decided month look like a pending substitution forever.
      console.warn(`give-back: dummy resource ${dummyAssig.resourceId} disappeared while settling month ${row.id} — returning no hours`);
      return { giveBackHours: 0, shortfallHours: blockedHours, settled: false };
    }
    const employmentErr = bookingOutsideEmploymentError(Object.keys(replacedDays), currentDummyResource);
    if (employmentErr) {
      // Fail closed: never recreate assignmentDays outside employment. The
      // unresolved amount stays on the target side and is surfaced below as a
      // shortfall instead of silently materialising an invalid dummy booking.
      console.warn(`give-back: month ${row.id} cannot return to ${linkId}: ${employmentErr}`);
      return { giveBackHours: 0, shortfallHours: blockedHours, settled: false };
    }
    dummyCap = dailyCapFor(kindOf(currentDummyResource), await resolveBaseCap(currentDummyResource));

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

    // ONE TRANSACTION for the dummy credit, the target debit, both
    // `recomputeAssignedHours` calls AND the link clear — they were three
    // untransacted stages plus an unconditional `finally`, so a failure between
    // the loops left 320h of booked demand where 160 existed and then made that
    // state permanent by closing the link. `applyGiveBackDays` compensates the
    // day rows and LEAVES THE LINK OPEN on failure (the in-memory adapter, where
    // `withRepositoriesTransaction` is a pass-through), so the next decision,
    // retarget or delete retries the whole reversal. The `res:` locks stay
    // outside, as everywhere else in this file.
    await withRepositoriesTransaction(transactionRepos => applyGiveBackDays(
      {
        assignmentDays: transactionRepos.assignmentDays,
        assignmentMonths: transactionRepos.assignmentMonths,
        recomputeAssignedHours: assignmentId => recomputeAssignedHours(assignmentId, transactionRepos),
      },
      plan,
      assig.id,
      dummyAssig.id,
      row.id,
    ));
    return { ...plan, settled: true };
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
  // NO `finally`. A give-back that THREW must leave the link intact, so the next
  // decision/retarget/delete retries it — the fresh-read guard inside `moveBack`
  // already makes a successful repeat a no-op, which is what makes retrying safe.
  // Clearing it unconditionally is what turned a partial reversal into a permanent
  // one: the hours stayed double-booked and nothing could ever run the give-back
  // again. The error propagates unchanged, as it did before.
  const outcome = firstId === secondId
    ? await withLock(`res:${firstId}`, moveBack)
    : await withLock(`res:${firstId}`, () => withLock(`res:${secondId}`, moveBack));
  if (!outcome.settled) {
    // The two paths that wrote NO day rows (a vanished dummy resource, or a
    // give-back its employment window refuses) still have to settle the link, and
    // do it outside both locks. `applyGiveBackDays` owns the clear on every path
    // that did write, because there it has to commit with those writes.
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
    await allocationLifecycle.run(dummyRow.id, async transactionRepos => {
      const current = await transactionRepos.assignmentMonths.get(dummyRow.id);
      if (current === undefined || current.status !== 'Rejected') return;
      // A decided approval makes this a no-op; it only bites on a stale Pending id.
      await withdrawAllocationApproval(
        current.approvalId,
        'superseded by returned substitution hours',
        transactionRepos,
      );
      const approvalId = await createAllocationApproval(req, dummyAssig, dummyRow.id, transactionRepos);
      await transactionRepos.assignmentMonths.update(
        dummyRow.id,
        { status: 'Requested', approvalId } as Partial<AssignmentMonth>,
      );
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
  const body = pick<{ plannerNote?: string }>(req.body, ['plannerNote']);
  const plannerNote = typeof body.plannerNote === 'string' ? body.plannerNote : undefined;

  // Self-managed: approver and requester would be the same principal (SoD would
  // block the decision anyway), so the month is approved on the spot. Covers the
  // direct people manager AND a manager of a node above the resource — the
  // Practice Manager planning their own practice's placeholders is the mainline
  // workflow, not an edge case (see `autoApprovesAllocation`).
  const selfManaged = await autoApprovesAllocation(req, assig.resourceId);
  try {
    await allocationLifecycle.run(row.id, transactionRepos => submitAllocationMonth(
      transactionRepos,
      row.id,
      {
        autoApprove: selfManaged,
        plannerNote,
        createApproval: () => createAllocationApprovalEntry(req, assig, row.id, transactionRepos),
      },
    ));
  } catch (error) {
    if (error instanceof AllocationLifecycleError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
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

// ---------------------------------------------------------------------------
// COMPUTED READ (Block F): monthly BENCH/PARTIAL/ALLOCATED rollup + hiring
// demand across internal/subco resources. Gated by the '/capacity' READ_RULE,
// extended below to also match '/bench' (design spec §8) — roleGate is GLOBAL
// middleware, so this handler is already authorized; do NOT re-gate per-handler.
// Read-only: no mutation, no audit entry, no withLock.
// ---------------------------------------------------------------------------
apiRouter.get('/bench/monthly', async (req, res) => {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const qParam = (name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === 'string' ? v : undefined;
  };
  const monthToIdx = (mo: string): number => { const [y, m] = mo.split('-').map(Number); return y * 12 + (m - 1); };
  const idxToMonth = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

  const fromRaw = qParam('from');
  if (fromRaw !== undefined && !MONTH_RE.test(fromRaw)) { res.status(400).json({ error: 'from must be a YYYY-MM month' }); return; }

  let from = fromRaw;
  if (from === undefined) {
    const openIds = (await repos.planningPeriods.list()).filter(p => p.status === 'Open').map(p => p.id).sort();
    from = openIds[0] ?? new Date().toISOString().slice(0, 7);
  }
  // Fixed 6-month display window — NOT configurable by the caller (design spec §8).
  const to = idxToMonth(monthToIdx(from) + 5);
  const fetchFrom = idxToMonth(monthToIdx(from) - 2);
  const fetchTo = idxToMonth(monthToIdx(to) + 1);
  const months = monthsInRange(fetchFrom, fetchTo);   // 9 months: 2 look-back + 6 shown + 1 look-ahead
  const displayMonths = monthsInRange(from, to);        // the 6 shown months

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
  const today = new Date().toISOString().slice(0, 10);

  res.json(benchRollup({ resources, assignments, assignmentDays, assignmentMonths, months, displayMonths, hoursPerDay, holidays: holSet }, today));
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
      // REACHABLE, AND RESTRICTIVE ON PURPOSE. (This comment used to claim the
      // branch was dead, arguing from an `?? (id || undefined)` fallback inside
      // `actorResourceId` that no longer exists: that function now ends at
      // `return user?.resourceId`, so any principal with no matching row in the
      // user directory — a verified token whose `resource_id` claim is absent, or
      // a demo header naming nobody — lands here with `undefined`.)
      //
      // An empty scope, never an unrestricted feed. This mirrors
      // `decideOneApproval`'s OWN treatment of an unresolved `deciderResourceId`,
      // where `scopeMatch` reduces to `roleFallback` alone and never to "anything
      // goes"; an empty `Set` (not `undefined`) is what makes the loop below
      // apply exactly that, so only no-manager-anywhere rows survive. Diverging
      // here would show rows the decide endpoint then refuses.
      ? new Set<string>()
      : scopeOf(feedActorResourceId, resources, orgNodes);
  // PERFORMANCE: `accountableApproversOf` is O(resources.length) per call (it
  // rebuilds a resources-by-id Map internally) and is evaluated once per
  // VISIBLE-CHECK below, not once per resource — a resource with N month-rows
  // in the window would otherwise re-derive the identical answer N times, an
  // O(rows × resources) cost where O(rows + resources) is available. Memoized
  // per resource id so each resource pays for the computation at most once
  // per request, regardless of how many month-rows it has in range.
  //
  // `accountableApproversOf`, not `scopedApproversOf`, for the SAME reason the
  // decision uses it (review round 4, critical #1): a manager who has left
  // suppresses the fallback structurally but cannot act. The feed and the
  // decision must agree on that or a row that any competent approver may now
  // decide would be hidden from all of them.
  const feedToday = todayIso();
  const roleFallbackCache = new Map<string, boolean>();
  const isRoleFallback = (resource: Resource): boolean => {
    let cached = roleFallbackCache.get(resource.id);
    if (cached === undefined) {
      cached = accountableApproversOf(resource, resources, orgNodes, feedToday).roleFallback;
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
        // D (Task 8): carried straight through so the client can derive the
        // capability/practice/competence dimensions without a second
        // getResources() catalogue fetch — `resource` is already in hand here.
        organization: resource.organization,
        // D (Task 8, round 3): resolved from the SAME resourceById map built
        // above for this very handler — no extra I/O — so the People Manager
        // filter's option list can show a real name instead of a bare id (the
        // feed lists a manager's REPORTS, so the manager rarely has a row of
        // their own to resolve a name from client-side).
        managerName: resource.managerId !== undefined ? resourceById.get(resource.managerId)?.name : undefined,
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

/**
 * Build the object-level policy context for the global time-entry boundary.
 * Employees never reach it (their boundary is `/self/time-entries`). PM scope is
 * project ownership; resource-manager scope reuses the canonical org chart/tree
 * union. Organization-wide roles are still represented by the same context — the
 * pure policy decides that they do not need either scoped set.
 */
async function globalTimeEntryPolicyContext(req: Request): Promise<TimeEntryPolicyContext> {
  // THE WHOLE VERIFIED SET, as roleGate authorizes: it had just admitted this
  // request on the set, and the object-level policy then judged the collapsed
  // primary role and refused it (see `TimeEntryPolicyContext.roles`).
  const resourceId = await actorResourceId(req);
  const [resources, orgNodes, projects] = await Promise.all([
    repos.resources.list(), repos.resourceOrganizations.list(), repos.projects.list(),
  ]);
  return {
    roles: trustedRoles(req),
    actorResourceId: resourceId,
    managedResourceIds: resourceId ? scopeOf(resourceId, resources, orgNodes) : new Set<string>(),
    ownedProjectIds: new Set(
      resourceId ? projects.filter(project => project.ownerId === resourceId).map(project => project.id) : [],
    ),
  };
}

function sendGlobalTimeEntryDenied(
  res: Response,
  req: Request,
  action: GlobalTimeEntryAction,
): void {
  // The DISPLAY role is still what the message names — one label reads better
  // than a set — but it no longer decides anything.
  res.status(403).json({ error: `Role ${trustedRole(req)} cannot ${action} global time entries; use the permitted scoped workflow` });
}

apiRouter.get('/time-entries', async (req, res) => {
  const policy = await globalTimeEntryPolicyContext(req);
  if (!hasGlobalTimeEntryCollectionAccess(policy.roles, 'read')) {
    sendGlobalTimeEntryDenied(res, req, 'read');
    return;
  }
  // A SCOPED-ONLY principal with no resource link has no scope to read within.
  // Asked of the set: a ['pm','sales'] actor is NOT scope-only — 'sales' carries
  // org-wide read in its own right — so refusing them here would take away a read
  // the rules grant.
  const scopedOnly = policy.roles.every(role => role === 'pm' || role === 'resource-manager');
  if (policy.roles.length > 0 && scopedOnly && !policy.actorResourceId) {
    res.status(403).json({ error: 'The signed-in identity is not linked to a resource scope' });
    return;
  }
  const entries = await repos.timeEntries.list();
  res.json(entries.filter(entry => canAccessGlobalTimeEntry(policy, entry, 'read')));
});
apiRouter.post('/time-entries', async (req, res) => {
  const policy = await globalTimeEntryPolicyContext(req);
  if (!hasGlobalTimeEntryCollectionAccess(policy.roles, 'write')) {
    sendGlobalTimeEntryDenied(res, req, 'write');
    return;
  }
  // B-TIME-ENTRY (status bypass): 'status'/'approvedBy'/'approvedAt' are NOT in
  // the create allow-list, so a client cannot seed an already-'Approved' entry
  // that would bypass the PUT transition whitelist + SoD and inflate the billing
  // cap accrual (accrued T&M sums APPROVED entries). The initial status is forced
  // to 'Draft' AFTER the spread (parity with POST /requests pinning its status),
  // so it can never be overridden by the body.
  // Ownership and every denormalized FK are derived below from assignmentId. A
  // caller can never choose resourceId/requestId/projectId independently.
  const body = pick<TimeEntry>(req.body, ['assignmentId', 'date', 'hours', 'notes']);
  if (typeof body.assignmentId !== 'string' || body.assignmentId.length === 0) {
    res.status(400).json({ error: 'assignmentId is required' });
    return;
  }
  if (!isNonNegNumber(body.hours)) {
    res.status(400).json({ error: 'hours must be a non-negative number' });
    return;
  }
  if (!isIsoDateString(body.date)) {
    res.status(400).json({ error: 'date must be an ISO date string' });
    return;
  }
  const assignment = await repos.assignments.get(body.assignmentId);
  const reqRef = assignment ? await repos.requests.get(assignment.requestId) : undefined;
  const links = assignment && reqRef ? deriveTimeEntryLinks(assignment, reqRef) : undefined;
  if (!links) {
    res.status(400).json({ error: 'assignmentId must resolve to an assignment with a project-linked request' });
    return;
  }
  if (!canAccessGlobalTimeEntry(policy, links, 'write')) {
    sendGlobalTimeEntryDenied(res, req, 'write');
    return;
  }
  const item = {
    id: `TE${newId()}`,
    date: body.date,
    hours: body.hours,
    notes: body.notes,
    ...links,
    status: 'Draft',
  } as TimeEntry;
  const created = await repos.timeEntries.create(item);
  res.json(created);
});
apiRouter.put('/time-entries/:id', async (req, res) => {
  const existing = await repos.timeEntries.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const policy = await globalTimeEntryPolicyContext(req);
  if (!hasGlobalTimeEntryCollectionAccess(policy.roles, 'write')) {
    sendGlobalTimeEntryDenied(res, req, 'write');
    return;
  }
  if (!canAccessGlobalTimeEntry(policy, existing, 'write')) {
    sendGlobalTimeEntryDenied(res, req, 'write');
    return;
  }
  // Clients cannot rewrite ownership/FKs directly. `assignmentId` is the only
  // accepted link; the coherent request/resource/project chain is derived below,
  // and both the previous and resulting owner/project must pass object scope.
  const body = pick<TimeEntry>(req.body, ['assignmentId', 'date', 'hours', 'status', 'notes']);
  if (body.hours !== undefined && !isNonNegNumber(body.hours)) {
    res.status(400).json({ error: 'hours must be a non-negative number' });
    return;
  }
  if (body.date !== undefined && !isIsoDateString(body.date)) {
    res.status(400).json({ error: 'date must be an ISO date string' });
    return;
  }

  // B-CONCURRENCY: the immutability guard, the transition whitelist and the write
  // must see ONE state. They used to run against the pre-handler snapshot with no
  // lock at all, so two concurrent PUTs on the same entry — one approving it, one
  // rewriting its hours — both read 'Submitted', both passed, and the hours write
  // landed AFTER the approval: an Approved entry with rewritten hours, which is
  // exactly what "Approved time entries are immutable" exists to prevent, and it
  // feeds accrued T&M. Re-read INSIDE the section and decide from `fresh`.
  //
  // `res` is never touched inside the lock (a denial is returned as a marker and
  // sent after it is released), so the critical section holds no HTTP state.
  const result = await withLock(`time-entry:${req.params.id}`, async (): Promise<
    { denied: GlobalTimeEntryAction } | { status: number; body: unknown }
  > => {
    const fresh = await repos.timeEntries.get(req.params.id);
    if (fresh === undefined) return { status: 404, body: { error: 'Not found' } };
    // There is no explicit reopen/correction workflow. Treat the accounting input
    // as immutable once approved rather than allowing a status-omitting PUT to
    // rewrite hours/FKs while retaining the approval.
    if (fresh.status === 'Approved') {
      return { status: 409, body: { error: 'Approved time entries are immutable; an explicit correction workflow is required' } };
    }
    // B-TIME-ENTRY: enforce the allowed status-transition whitelist. A status that
    // is present must be a permitted move from the current status (a no-op
    // transition is allowed); any other move (e.g. Approved->Draft, or jumping
    // straight to Approved from Draft) is rejected.
    if (body.status !== undefined && !isAllowedTimeEntryTransition(fresh.status, body.status)) {
      return { status: 400, body: { error: `Illegal time-entry transition: ${fresh.status} -> ${body.status}` } };
    }
    const deciding = (body.status === 'Approved' || body.status === 'Rejected') && body.status !== fresh.status;
    if (deciding && Object.keys(body).some(key => key !== 'status')) {
      return { status: 409, body: { error: 'A time-entry decision cannot modify hours, assignment, date, or notes in the same request' } };
    }

    const assignmentId = body.assignmentId ?? fresh.assignmentId;
    const assignment = await repos.assignments.get(assignmentId);
    const request = assignment ? await repos.requests.get(assignment.requestId) : undefined;
    const links = assignment && request ? deriveTimeEntryLinks(assignment, request) : undefined;
    if (!links) {
      return { status: 400, body: { error: 'assignmentId must resolve to an assignment with a project-linked request' } };
    }
    const policyAction: GlobalTimeEntryAction = deciding ? 'decide' : 'write';
    if (!canAccessGlobalTimeEntry(policy, fresh, policyAction)
        || !canAccessGlobalTimeEntry(policy, links, policyAction)) {
      return { denied: policyAction };
    }

    const patch: Partial<TimeEntry> = { ...body, ...links };
    if (body.status === 'Approved') {
      // SEGREGATION OF DUTIES: the approver is the TRUSTED actor (never a
      // client-supplied approvedBy) and must differ from the entry's owner
      // (its resourceId) so a resource cannot approve their own time and inflate
      // accrued T&M. The actor is a USER identity, so resolve it to the user's
      // RESOURCE id before comparing — comparing the raw username/sub against a
      // resourceId is always false under real JWT auth and silently disables SoD.
      patch.approvedBy = actorId(req);
      patch.approvedAt = new Date().toISOString();
    }
    return { status: 200, body: await repos.timeEntries.update(req.params.id, patch) };
  });
  if ('denied' in result) {
    sendGlobalTimeEntryDenied(res, req, result.denied);
    return;
  }
  res.status(result.status).json(result.body);
});
apiRouter.delete('/time-entries/:id', async (req, res) => {
  const existing = await repos.timeEntries.get(req.params.id);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const policy = await globalTimeEntryPolicyContext(req);
  if (!hasGlobalTimeEntryCollectionAccess(policy.roles, 'write')
      || !canAccessGlobalTimeEntry(policy, existing, 'write')) {
    sendGlobalTimeEntryDenied(res, req, 'write');
    return;
  }
  if (existing.status === 'Approved') {
    res.status(409).json({ error: 'Approved time entries are immutable; an explicit correction workflow is required' });
    return;
  }
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

/**
 * D (review round 4, important #4) — THE ORG-TREE LOCK KEY.
 *
 * Every `/resource-organizations` MUTATION (POST, PUT, DELETE) is a
 * read-validate-write over the WHOLE tree: `validateOrgTreeNode` lists all
 * nodes, reasons about this record against its parent AND against its existing
 * children, then writes. Unserialized, two concurrent writers each reason from
 * their own pre-write snapshot and both pass. The exhibit: interleave
 * `PUT X {parentId: A}` (X a practice, A a capability — legal) with
 * `PUT A {level:'practice', parentId: Z}`; if A's child-invalidation guard reads
 * the node list before X's write commits, it sees A childless and allows the
 * demotion, leaving a practice whose parent is a practice. `dimensionsOf` then
 * overwrites `out['practice']` with the outer node, so every resource under X
 * reports the WRONG practice in all three D filter screens and in reporting —
 * silently, with no error anywhere. Node edits are rare, human-scale admin
 * operations, so a single global key costs nothing measurable and is far easier
 * to reason about than a per-node scheme (the invariant spans several nodes, so
 * a per-node lock would have to be taken over an unbounded set anyway).
 *
 * THE KEY AND ITS TWO WRITES NOW LIVE TOGETHER in
 * src/server/operational-integrity.util.ts, because the section no longer covers
 * only this collection: the RESOURCE side of the name binding it guards
 * (`POST`/`PUT /resources` with an `organization`) joins it via
 * `bindOrganizationThen`, which closes the race in which a node was deleted or
 * renamed between a resource's name check and its write. That file states the
 * full lock order — `org-chart` -> `org-tree` -> `res:<id>` — and why it stays
 * acyclic; read it before adding any acquisition inside this section, which still
 * takes no other lock of its own.
 */
apiRouter.post('/resource-organizations', async (req, res) => {
  const body = pick<ResourceOrganization>(req.body, [
    'name', 'description', 'costCenters', 'serviceOrganizationId',
    // D — the delivery tree. A field missing here is dropped SILENTLY.
    'parentId', 'level', 'managerId',
  ]);
  // D (review round 4, important #3) — THE '' SENTINEL, ON CREATE TOO. The PUT
  // handler below translates '' -> null ("clear this field"); this handler used
  // to spread `body` straight into `create()`, which strips nothing, while
  // `validateOrgTreeNode` skips the reference check for '' — so a POST carrying
  // `managerId: ''` persisted a LITERAL empty string, which then entered
  // `scopedApproversOf`'s manager set (it guarded only `!== undefined`) and
  // reproduced the critical-#1 lockout through a second door; `parentId: ''`
  // likewise persisted and made the node fall out of the customizing tree's
  // main walk. The client was working around this by omitting the keys
  // entirely on create — the UI as sole guardian, which the Global Constraints
  // forbid.
  //
  // `undefined`, NOT `null`, on this path — the opposite of PUT, deliberately:
  // there is nothing to CLEAR on a create, and `create()` has no
  // null-stripping step on either adapter (that only exists on `update()`), so
  // a literal `null` would leak into every later read of an in-memory row while
  // Postgres stored a proper NULL — the two adapters would silently disagree.
  // `undefined` is the one value both read back as genuinely absent. Same rule,
  // same reasoning, as `vendorId`/`managerId` on `POST /resources`. Runs BEFORE
  // validation so every check below sees the normalized shape (both were
  // already treated as absent there, so no check changes meaning).
  if (body.parentId === '' || body.parentId === null) body.parentId = undefined;
  if (body.managerId === '' || body.managerId === null) body.managerId = undefined;
  const result = await withLock(ORG_TREE_LOCK, async (): Promise<{ status?: number; error?: string; created?: ResourceOrganization }> => {
    // REFERENCE-DATA INTEGRITY (Phase F2): costCenters[] -> cost-centers catalog (id),
    // serviceOrganizationId -> service-organizations (id). Optional; supplied values checked.
    const refErr = await validateResourceOrgRefs(body as Record<string, unknown>);
    if (refErr) return { status: 400, error: refErr };
    // D — org-tree integrity (levels, parent/child, cycles, unique name). Run
    // AFTER the F2 reference check, on the same allow-listed body; no ctx.id on
    // create.
    const treeErr = await validateOrgTreeNode(body);
    if (treeErr) return { status: 400, error: treeErr };
    // D — `level` IS now in the pick() allow-list above, so an explicit value
    // overrides this default; an omitted one still lands as 'capability',
    // mirroring the schema default, so the two adapters agree. In-memory stores
    // exactly what it is handed (no column default to fall back on), so leaving
    // this out would make an in-memory-created row silently disagree with a
    // Postgres one. `level` MUST stay before `...body` — reversing the order
    // would make every explicit `level` silently ignored.
    const item = { id: newId(), costCenters: [], level: 'capability', ...body } as ResourceOrganization;
    return { created: await repos.resourceOrganizations.create(item) };
  });
  if (result.error !== undefined) { res.status(result.status ?? 400).json({ error: result.error }); return; }
  res.json(result.created);
});
apiRouter.put('/resource-organizations/:id', async (req, res) => {
  const body = pick<ResourceOrganization>(req.body, [
    'name', 'description', 'costCenters', 'serviceOrganizationId',
    // D — the delivery tree. A field missing here is dropped SILENTLY.
    'parentId', 'level', 'managerId',
  ]);
  // The 404 read is INSIDE the lock together with the validation and the write:
  // that is the whole point of the section (see ORG_TREE_LOCK above) — a
  // snapshot taken before the lock is exactly the stale snapshot the guard used
  // to reason from.
  const result = await withLock(ORG_TREE_LOCK, async (): Promise<{ status?: number; error?: string; updated?: ResourceOrganization }> => {
    const existing = await repos.resourceOrganizations.get(req.params.id);
    if (existing === undefined) return { status: 404, error: 'Not found' };
    const refErr = await validateResourceOrgRefs(body as Record<string, unknown>);
    if (refErr) return { status: 400, error: refErr };
    // D — org-tree integrity, excluding this record's own id from the
    // name-uniqueness check and enabling the cycle check (PUT only).
    const treeErr = await validateOrgTreeNode(body, { id: req.params.id });
    if (treeErr) return { status: 400, error: treeErr };
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
        return {
          status: 409,
          error: `Cannot rename: ${affected.length} resource(s) still reference the name "${existing.name}"`,
        };
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
    // relies on exactly this translation to do anything at all. The CREATE path
    // does the same job with `undefined` — see the note on POST above for why
    // the two sentinels differ.
    if (body.parentId === '') (body as Record<string, unknown>)['parentId'] = null;
    if (body.managerId === '') (body as Record<string, unknown>)['managerId'] = null;
    return { updated: await repos.resourceOrganizations.update(req.params.id, body) };
  });
  if (result.error !== undefined) { res.status(result.status ?? 400).json({ error: result.error }); return; }
  res.json(result.updated);
});
apiRouter.delete('/resource-organizations/:id', async (req, res) => {
  // Serialized on the same key as POST/PUT (see ORG_TREE_LOCK): the child and
  // the still-referenced guards below are a read-check-write over the whole
  // tree, so a concurrent PUT reparenting a node UNDER this one could otherwise
  // commit between the check and the removal.
  // The guards and the removal live in `deleteOrgNodeWrite`, beside the lock key
  // and beside the resource-binding write that now shares the section: a lock is
  // only as good as the agreement between the sections that take it.
  const refusal = await deleteOrgNodeWrite(withLock, repos, req.params.id);
  if (refusal !== null) { res.status(refusal.status).json({ error: refusal.error }); return; }
  res.status(204).send();
});

// --- Customizing catalogs (Phase F1 — additive reference data) --------------
// Reads need only a principal (no READ_RULE narrows them); mutations are gated to
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

// NOT-NULL PARITY (the `required` argument on every crud() below): the column
// sets are transcribed from src/db/schema.ts. Without them an explicit JSON
// `null` reached the adapter, and the SAME request behaved two ways — 200 plus a
// row that silently LOST the column in memory, an unmapped 23502 → 500 under
// Postgres. On create an omitted value is refused for the same reason.

// CITIES — id-keyed catalog; `countryCode` is a REQUIRED FK to /countries.
crud(apiRouter, 'cities', repos.cities, ['name', 'countryCode'], [], async data => {
  if (data['countryCode'] === undefined) return 'countryCode is required';
  if (!(await existsRepo(repos.countries, data['countryCode']))) {
    return 'countryCode must reference an existing country';
  }
  return null;
}, [], ['name', 'countryCode']);

// Simple {id, name} catalogs.
crud(apiRouter, 'industries', repos.industries, ['name'], [], undefined, [], ['name']);
crud(apiRouter, 'cost-categories', repos.costCategories, ['name'], [], undefined, [], ['name']);
crud(apiRouter, 'partner-roles', repos.partnerRoles, ['name'], [], undefined, [], ['name']);

// VENDORS — partner/supplier companies. REFERENCE-DATA INTEGRITY (Phase F2):
// `country` (when supplied) must be a valid ISO-2 country code from the countries
// catalog (the natural key). Optional; an omitted/empty country passes.
// DELETE is refused while any resource still points at the vendor. Without it the
// same request behaved two ways: 204 in dev (DATABASE_URL unset), where the three
// subco resources bound to "Acme Consulting" were left rendering a raw UUID in the
// vendor field — and because `vendorId` is a REQUIRED control exactly when
// `kind === 'subco'`, none of them could be saved again until someone re-picked a
// vendor — against 409 under Postgres, where `resources.vendor_id` references
// `vendors.id`. An ID reference, unlike the org-node binding one table over, which
// is by NAME.
crud(apiRouter, 'vendors', repos.vendors, ['name', 'vatId', 'country'], [], data =>
  validateCatalogValue(data['country'], 'country', countryCodes, 'country (ISO-2 code)'), [], ['name'], [], undefined,
  async vendorId => {
    const referencing = (await repos.resources.list()).filter(resource => resource.vendorId === vendorId);
    if (referencing.length === 0) return undefined;
    return `Cannot delete: ${referencing.length} resource(s) still reference this vendor`;
  });


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
  }, [], ['role', 'currency', 'costRate', 'billRate']);

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
// Reads need only a principal (no READ_RULE narrows them); writes are gated to
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
// — a month is opened/closed, never deleted. Reads need only a principal (the Task-8
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

/**
 * A project's `contractId` is OPTIONAL (an internal project has none), so only a
 * value that survived `buildProjectWrite`'s blank-stripping is checked — and it is
 * checked here rather than left to the FK, so a wrong id is a 400 naming the field
 * instead of a 409 describing a delete.
 */
async function validateProjectContract(body: Partial<Project>): Promise<string | null> {
  if (body.contractId === undefined) return null;
  if (!(await existsRepo(repos.contracts, body.contractId))) {
    return 'contractId must reference an existing contract';
  }
  return null;
}
apiRouter.get('/projects', async (req, res) => {
  const all = await repos.projects.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  res.json(q === undefined ? all : searchPage(all, ['name', 'location'], q, clampSearchPage(req.query)));
});
apiRouter.post('/projects', async (req, res) => {
  // BLANK NULLABLE FK: the form leaves the Contract select on its empty default for
  // a project with no contract — a legitimate choice — and sends `contractId:''`.
  // Postgres raises 23503 (no contracts row has id '') and the error mapper answered
  // 409 "Cannot delete: the record is still referenced by other records" for a
  // CREATE, so the whole feature tested green under `ng serve` and could not save a
  // single contract-less project in production. `buildProjectWrite` is the ONLY path
  // to repos.projects.create() here, which is what makes the normalisation provable.
  const body = buildProjectWrite(pick<Project>(req.body, PROJECT_FIELDS));
  // REFERENCE-DATA INTEGRITY (Phase D): `ownerId` is a person reference to the
  // resources catalog by ID (the Owner SELECT stores the resource id). It is required
  // on create and must reference an existing resource.
  if (!(await existsRepo(repos.resources, body.ownerId))) {
    res.status(400).json({ error: 'ownerId must reference an existing resource' });
    return;
  }
  // A non-empty contractId is checked HERE so a bad id is a clean 400 rather than a
  // DB-layer 409 — mirroring ownerId above.
  const contractErr = await validateProjectContract(body);
  if (contractErr) { res.status(400).json({ error: contractErr }); return; }
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
  // Same blank-FK normalisation as POST: clearing an existing project's contract
  // through the form 409'd on Postgres for exactly the same reason.
  const body = buildProjectWrite(pick<Project>(req.body, PROJECT_FIELDS));
  // REFERENCE-DATA INTEGRITY (Phase D): validate `ownerId` only when supplied, so a
  // partial edit that omits it is never blocked; a supplied value must be a resource id.
  if (body.ownerId !== undefined && body.ownerId !== null && body.ownerId !== '' && !(await existsRepo(repos.resources, body.ownerId))) {
    res.status(400).json({ error: 'ownerId must reference an existing resource' });
    return;
  }
  const contractErr = await validateProjectContract(body);
  if (contractErr) { res.status(400).json({ error: contractErr }); return; }
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
  const projectErr = await validateProjectReference(data['projectId']);
  if (projectErr) return projectErr;
  const companyErr = await validateCatalogValue(data['company'], 'company', vendorNames, 'vendor (company catalog name)');
  if (companyErr) return companyErr;
  return validateCatalogValue(data['role'], 'role', partnerRoleNames, 'partner role (catalog name)');
}, [], ['projectId', 'company', 'role', 'contact', 'status']);

// PROVENANCE IS SERVER-OWNED. `uploadedAt`, `author` and `authorInitials` are
// deliberately ABSENT from the allow-list — that is what makes them unforgeable on
// create AND unchangeable by the PUT, which shares the same list. They are still
// notNull columns, so `documentProvenance` supplies them (see its doc comment for
// the forged-attribution exhibit). `uploadedAt` becomes a real ISO date: the client
// used to send the literal string 'Just now', which is a lie the moment a day
// passes, and the seed rows carry equally frozen '2 days ago'.
crud(apiRouter, 'project-documents', repos.projectDocuments,
  ['projectId', 'name', 'type', 'size'], [],
  async data => validateProjectReference(data['projectId']), [],
  ['projectId', 'name', 'type', 'size', 'uploadedAt', 'author', 'authorInitials'], [],
  async req => documentProvenance(await actorDisplayName(req), todayIso()));

// PHASE D — work-package `assignee` is a person reference ('Unassigned' allowed).
// Phase G — start/end must be ISO (end >= start) when supplied.
// `progress` is a PERCENTAGE on a notNull double column and had no numeric check at
// all (numericFields was []), so -40, 5000, 'abc' and arrays all landed on it and
// drove a progress bar's width. Bounded to [0,100] here, not merely non-negative.
crud(apiRouter, 'work-packages', repos.workPackages, ['projectId', 'name', 'startDate', 'endDate', 'status', 'progress', 'assignee'], ['progress'],
  async data => percentFieldError(data, ['progress'])
    ?? await validateProjectReference(data['projectId'])
    ?? validateDateFields(data, ['startDate', 'endDate'], { from: 'startDate', to: 'endDate' })
    ?? await validatePersonRefs(data, ['assignee'], ['assignee']),
  [], ['projectId', 'name', 'startDate', 'endDate', 'status', 'progress', 'assignee']);

interface MilestoneEntry { id: string; projectId: string; name: string; date: string; status: 'Pending' | 'Achieved'; approvedBy?: string; approvedAt?: string }
// `approvedBy` / `approvedAt` are deliberately ABSENT from this allow-list: they
// are the approval record on a document that RELEASES MONEY (reaching 'Achieved'
// flips every linked fixed-price billing condition to 'Ready', i.e. billable), so
// they are pinned to the verified principal by `milestoneApprovalPatch` on the
// transition itself. While they sat here, any actor allowed to write a milestone
// could name someone else as the approver and back-date the approval.
const MILESTONE_FIELDS = ['projectId', 'name', 'date', 'status'] as const;
apiRouter.get('/milestones', async (_req, res) => { res.json(await repos.milestones.list()); });
apiRouter.post('/milestones', async (req, res) => {
  const body = pick<MilestoneEntry>(req.body, MILESTONE_FIELDS);
  // Phase G: the milestone `date` must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['date']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  // REFERENTIAL INTEGRITY: project_id is notNull REFERENCES projects.id, and this
  // handler never checked it — `projectId:'NOPE'` was a 200 in memory and an
  // unmapped 23503 under Postgres.
  if (!(await existsRepo(repos.projects, body.projectId))) {
    res.status(400).json({ error: 'projectId must reference an existing project' });
    return;
  }
  const statusErr = milestoneStatusError(body.status);
  if (statusErr) { res.status(400).json({ error: statusErr }); return; }
  // 'Achieved' IS A MONEY EVENT, so it is server-owned and reachable only through
  // the PUT transition that pins `approvedBy` — see `buildMilestoneCreate`.
  const item = { id: newId(), ...buildMilestoneCreate(body as Record<string, unknown>) } as unknown as MilestoneEntry;
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
  if (body.projectId !== undefined && !(await existsRepo(repos.projects, body.projectId))) {
    res.status(400).json({ error: 'projectId must reference an existing project' });
    return;
  }
  // Any string used to land on the column, rendering as a chip with none of the
  // three status classes and matching no consumer's status test.
  const statusErr = milestoneStatusError(body.status);
  if (statusErr) { res.status(400).json({ error: statusErr }); return; }
  // SERVER-PINNED APPROVAL RECORD, never the body's (see MILESTONE_FIELDS).
  const approvalPatch = milestoneApprovalPatch(
    previousStatus,
    (body.status ?? previousStatus) as string,
    actorId(req),
    new Date().toISOString(),
  );
  const updated = await repos.milestones.update(req.params.id, { ...body, ...approvalPatch }) as MilestoneEntry;
  // MILESTONE TRIGGER (SAL): a milestone in 'Achieved' makes its fixed-price
  // billing item billable — every linked BillingPlanItem still in 'Planned' is
  // flipped to 'Ready'.
  // B-CONCURRENCY: serialize per billing item against the billing-plan-item PUT
  // (which writes the whole merged item) so this targeted status flip and a
  // concurrent PUT can't clobber each other. Re-read INSIDE the lock and re-check
  // the 'Planned' precondition against the freshest state.
  //
  // IDEMPOTENT BY CURRENT STATE, not by transition. This used to require
  // `previousStatus !== 'Achieved'`, so the flip happened on exactly one request:
  // if that response was lost, or the process died part-way through the loop, the
  // client's retry found the milestone ALREADY 'Achieved', skipped the trigger,
  // and left the condition stranded in 'Planned' with no product path to invoice
  // it. Firing on the current state is safe because the per-item re-read inside
  // the lock only touches an item still in 'Planned' — for Ready/Blocked/Invoiced/
  // Paid it is a no-op.
  if (updated.status === 'Achieved') {
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
  // No read, no 404, no child guard: a DELETE of an id that never existed answered
  // 204 and appended a phantom audit entry (before/after both undefined), and
  // deleting a milestone that a billing condition points at orphaned
  // `billingPlanItems.milestoneId` — under Postgres the same request 409s, the
  // parity break CLAUDE.md calls load-bearing.
  const existing = await repos.milestones.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const linked = (await repos.billingPlanItems.list()).filter(item => item.milestoneId === req.params.id);
  if (linked.length > 0) {
    res.status(409).json({ error: `Cannot delete: ${linked.length} billing condition(s) are triggered by this milestone` });
    return;
  }
  await repos.milestones.remove(req.params.id);
  res.status(204).send();
});

// REFERENCE-DATA INTEGRITY (Phase F2): `category` -> cost-categories catalog (name).
crud(apiRouter, 'project-financials', repos.projectFinancials, ['projectId', 'category', 'budget', 'actual'], ['budget', 'actual'],
  async data => await validateProjectReference(data['projectId'])
    ?? await validateCatalogValue(data['category'], 'category', costCategoryNames, 'cost category (catalog name)'),
  [], ['projectId', 'category', 'budget', 'actual']);

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
// `partnerId` is a NULLABLE FK the form sends as '' for every Internal task, which
// is a 23503 under Postgres (no project_partners row has id '') reported as a
// nonsensical "Cannot delete…" 409 — so every ordinary internal task was unsavable
// in production while returning 200 in dev. Blanked here, and a NON-empty value is
// now checked against the catalog instead of being handed straight to the column.
crud(apiRouter, 'project-tasks', repos.projectTasks, ['projectId', 'name', 'assignee', 'assigneeType', 'partnerId', 'dueDate', 'status', 'priority'], [],
  async data => await validateProjectReference(data['projectId'])
    ?? (data['partnerId'] !== undefined && !(await existsRepo(repos.projectPartners, data['partnerId']))
      ? 'partnerId must reference an existing project partner'
      : null)
    ?? validateDateFields(data, ['dueDate'])
    ?? await validatePersonRefs(data, ['assignee'], ['assignee']),
  [], ['projectId', 'name', 'assignee', 'dueDate', 'status', 'priority'], ['partnerId']);

// PHASE D — issue `reportedBy` and `owner` are person references (optional).
// Phase G — `dueDate` must be ISO when supplied.
crud(apiRouter, 'project-issues', repos.projectIssues, ['projectId', 'title', 'type', 'severity', 'status', 'reportedBy', 'owner', 'dueDate', 'impact', 'actionPlan', 'escalated'], [],
  async data => await validateProjectReference(data['projectId'])
    ?? validateDateFields(data, ['dueDate'])
    ?? await validatePersonRefs(data, ['reportedBy', 'owner']),
  [], ['projectId', 'title', 'type', 'severity', 'status', 'reportedBy']);

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
  // guard keys on this actor identity; display/person fields are not its basis.
  createdBy?: string;
  decidedBy?: string;
  decidedAt?: string;
}
// impactBudget/impactScheduleDays are intentionally allowed to be negative
// (a CR can reduce scope/budget), so they are NOT validated as non-negative.
// requestedBy/createdAt/createdBy are immutable server-owned provenance. `status`
// is accepted only on PUT, where the state-machine below validates it.
const CHANGE_REQUEST_MUTABLE_FIELDS = [
  'projectId', 'title', 'description', 'owner', 'impactScope',
  'impactBudget', 'impactScheduleDays', 'priority',
] as const;
const CHANGE_REQUEST_PUT_FIELDS = [...CHANGE_REQUEST_MUTABLE_FIELDS, 'status'] as const;
/**
 * The typed-field rules BOTH change-request verbs must apply, declared once so they
 * cannot diverge: `impactBudget` is a signed double, `impactScheduleDays` a signed
 * INTEGER (schema.ts:726 — the finite check alone still admits 1.5), and `priority`
 * is a four-value union the allow-list used to forward unchecked.
 */
function changeRequestFieldError(body: Record<string, unknown>): string | null {
  return signedNumberFieldError(body, ['impactBudget'])
    ?? signedIntegerFieldError(body, ['impactScheduleDays'])
    ?? changeRequestPriorityError(body['priority']);
}
apiRouter.get('/change-requests', async (_req, res) => { res.json(await repos.changeRequests.list()); });
apiRouter.post('/change-requests', async (req, res) => {
  const body = pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_MUTABLE_FIELDS);
  // REFERENCE-DATA INTEGRITY (Phase D): the CR `owner` is a person reference to the
  // resources catalog (requestedBy/decidedBy are server-pinned actor ids, not names).
  const personErr = await validatePersonRefs(body as unknown as Record<string, unknown>, ['owner']);
  if (personErr) { res.status(400).json({ error: personErr }); return; }
  // Both impact figures are notNull columns that no check ever touched, so '5000' as
  // a STRING, null or an array landed on them — and an approved uplift is added
  // straight into the project's effective budget, where a string concatenates instead
  // of summing. Signed (a CR may reduce scope), but finite and numeric — and
  // `impactScheduleDays` is an integer() column, so it takes the stricter guard.
  const numberErr = changeRequestFieldError(body as unknown as Record<string, unknown>);
  if (numberErr) { res.status(400).json({ error: numberErr }); return; }
  const projectErr = await validateProjectReference((body as unknown as Record<string, unknown>)['projectId']);
  if (projectErr) { res.status(400).json({ error: projectErr }); return; }
  // Provenance and initial state are pinned AFTER the untrusted body. A caller
  // cannot create an already-Approved request or forge the SoD creator/requester.
  const creator = actorId(req);
  const item = {
    id: newId(),
    ...body,
    ...pinnedChangeRequestCreateFields(creator),
    createdAt: new Date().toISOString(),
  } as ChangeRequestEntry;
  res.json(await repos.changeRequests.create(item));
});
apiRouter.put('/change-requests/:id', async (req, res) => {
  const body = pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_PUT_FIELDS);
  // REFERENCE-DATA INTEGRITY (Phase D): validate any supplied `owner` against the
  // resources catalog. Omitted/empty owner passes (partial edits are not blocked).
  const personErr = await validatePersonRefs(body as unknown as Record<string, unknown>, ['owner']);
  if (personErr) { res.status(400).json({ error: personErr }); return; }
  // The SAME check as the POST: the edit form re-sends every impact field, so a verb
  // hardened on one side only leaves the corrupt value one PUT away.
  const numberErr = changeRequestFieldError(body as unknown as Record<string, unknown>);
  if (numberErr) { res.status(400).json({ error: numberErr }); return; }
  const projectErr = await validateProjectReference((body as unknown as Record<string, unknown>)['projectId']);
  if (projectErr) { res.status(400).json({ error: projectErr }); return; }
  const decider = actorId(req);
  const role = trustedRole(req);
  const changesDomainFields = CHANGE_REQUEST_MUTABLE_FIELDS.some(field => body[field] !== undefined);

  // B-CONCURRENCY: this handler writes a FULL merged object built from a snapshot
  // it read before its own policy checks, with no lock — so a concurrent
  // Draft->Submitted transition was silently reverted to Draft by an edit that had
  // read the pre-transition row, and the state machine in
  // `changeRequestMutationError` was evaluated against a status that had already
  // moved. Read, decide and write inside one section.
  const result = await withLock(`change-request:${req.params.id}`, async (): Promise<{ status: number; body: unknown }> => {
    const stored = await repos.changeRequests.get(req.params.id);
    if (stored === undefined) return { status: 404, body: { error: 'Not found' } };
    // The api.service `ChangeRequest` interface predates the server-only
    // `createdBy` SoD field; the persisted row carries it (schema + create pin), so
    // read it through the richer server-side `ChangeRequestEntry` view.
    const existing = stored as unknown as ChangeRequestEntry;
    const creator = existing.createdBy ?? existing.requestedBy;
    const policyError = changeRequestMutationError({
      currentStatus: existing.status,
      requestedStatus: body.status,
      role,
      actorId: decider,
      creatorId: creator,
      changesDomainFields,
    });
    if (policyError) return { status: policyError.status, body: { error: policyError.error } };
    const merged = { ...existing, ...body } as ChangeRequestEntry;
    // CR DECISION: when a CR reaches a terminal decision, stamp who/when (server
    // side, from the verified actor) if not already recorded. decidedBy/decidedAt
    // are not client-settable fields, so they cannot be forged via the body.
    const transitioned = body.status !== undefined && body.status !== existing.status;
    if (transitioned && (merged.status === 'Approved' || merged.status === 'Rejected')) {
      merged.decidedAt = new Date().toISOString();
      merged.decidedBy = decider;
    }
    return { status: 200, body: await repos.changeRequests.update(req.params.id, merged) };
  });
  res.status(result.status).json(result.body);
});
apiRouter.delete('/change-requests/:id', async (req, res) => {
  // STATE GUARD, or every rule in `changeRequestMutationError` is bypassable by
  // deleting the row instead of transitioning it: a pm who cannot move an
  // Approved CR (terminal transitions need delivery-executive/admin, and SoD
  // forbids the creator deciding) could otherwise erase the delivery-executive's
  // decision, and with it the CR's contribution to the project's effective
  // budget. The handler also had no read at all, so it 204'd on a missing id.
  const existing = await repos.changeRequests.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const deleteError = changeRequestDeleteError(existing.status);
  if (deleteError) { res.status(deleteError.status).json({ error: deleteError.error }); return; }
  await repos.changeRequests.remove(req.params.id);
  res.status(204).send();
});

// Configuration-level cost centers (B16)
// PHASE D — `manager` is a person reference (optional).
crud(apiRouter, 'cost-centers', repos.costCenters, ['name', 'manager', 'allocated', 'actual'], ['allocated', 'actual'],
  data => validatePersonRefs(data, ['manager']), [], ['name', 'manager', 'allocated', 'actual']);

// --- Commercial domain (ADR-0001): Customers, Contracts, Orders, OrderLines ---

// REFERENCE-DATA INTEGRITY (Phase F2): `industry` -> industries catalog (name),
// `country` -> countries catalog (country NAME, matching the seeded display). Both
// optional; only supplied non-empty values are checked.
crud(apiRouter, 'customers', repos.customers, ['name', 'industry', 'country'], [], async data => {
  const indErr = await validateCatalogValue(data['industry'], 'industry', industryNames, 'industry (catalog name)');
  if (indErr) return indErr;
  return validateCatalogValue(data['country'], 'country', countryNames, 'country (catalog name)');
}, ['name'], ['name']);

interface ContractEntry { id: string; customerId: string; name: string; type: string; totalValue: number; currency: string; status: string; startDate: string; endDate: string }

/** Every collection that carries a `contractId`, counted for the DELETE guard. */
async function contractChildBlockers(contractId: string): Promise<string | null> {
  const [orders, billingItems, projects, negotiatedRates] = await Promise.all([
    repos.orders.list(), repos.billingPlanItems.list(), repos.projects.list(), repos.negotiatedRates.list(),
  ]);
  return referencedChildMessage('contract', [
    { collection: 'order(s)', count: orders.filter(row => row.contractId === contractId).length },
    { collection: 'billing condition(s)', count: billingItems.filter(row => row.contractId === contractId).length },
    { collection: 'project(s)', count: projects.filter(row => row.contractId === contractId).length },
    { collection: 'negotiated rate(s)', count: negotiatedRates.filter(row => row.contractId === contractId).length },
  ]);
}

interface OrderEntry { id: string; contractId: string; type: string; partnerId: string; amount: number; currency: string; status: string; orderDate: string; invoiceNumber?: string; invoiceDate?: string }

/** SERVER-SET: assign a sequential invoice number + date when an order first
 *  becomes 'Invoiced' and none is set yet. Mutates the order in place. */
function applyInvoiceNumbering(order: OrderEntry, invoiceNumber: string, invoiceDate: string): void {
  if (order.status === 'Invoiced' && !order.invoiceNumber) {
    order.invoiceNumber = invoiceNumber;
    order.invoiceDate = invoiceDate.slice(0, 10);
  }
}

type CompoundOrderCreator = (order: Order) => Promise<Order>;

/**
 * Keep invoice allocation and all repository writes in one serialized operation.
 * PostgreSQL runs the callback under a per-year transaction advisory lock; the
 * in-memory adapter uses the coordinator's keyed queue. The next value is scanned
 * from persisted orders inside that boundary, so a rollback/compensating delete
 * naturally makes the same number available to an idempotent retry.
 */
async function withCommercialWriteTransaction<R>(
  invoiceDate: string,
  operation: (transactionRepos: Repositories, createOrder: CompoundOrderCreator) => Promise<R>,
): Promise<R> {
  return invoiceNumbers.run(invoiceDate, (transactionRepos, invoiceNumber) =>
    operation(transactionRepos, async order => {
      const item = { ...order } as unknown as OrderEntry;
      applyInvoiceNumbering(item, invoiceNumber, invoiceDate);
      return transactionRepos.orders.create(item as unknown as Order);
    }));
}

interface OrderLineEntry { id: string; orderId: string; projectId: string; description: string; amount: number }

// --- Commercial referential integrity: explicit handlers (crud() cannot express FK rules) ---

const CONTRACT_FIELDS = ['customerId', 'name', 'type', 'totalValue', 'currency', 'status', 'startDate', 'endDate'] as const;

apiRouter.get('/contracts', async (req, res) => {
  const all = await repos.contracts.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  res.json(q === undefined ? all : searchPage(all, ['name'], q, clampSearchPage(req.query)));
});
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
  // A CONTRACT IS THE PARENT OF AN ISSUED INVOICE. With no read and no child guard
  // this 204'd in dev and left orders (invoiceNumber and all), billing conditions,
  // projects and negotiated rates pointing at a contract that no longer exists —
  // bypassing `issuedOrderDeleteError` and `invoicedBillingItemDeleteError`
  // wholesale one level up, and making every later PUT on those conditions 400 on
  // 'contractId must reference an existing contract' with no way back. Under
  // Postgres the same request answers 409.
  const existing = await repos.contracts.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const blocking = await contractChildBlockers(req.params.id);
  if (blocking) { res.status(409).json({ error: blocking }); return; }
  await repos.contracts.remove(req.params.id);
  res.status(204).send();
});

const ORDER_FIELDS = ['contractId', 'type', 'partnerId', 'amount', 'currency', 'status', 'orderDate'] as const;
/** The order lifecycle. Picked from the body, so it must be validated against this. */
const ORDER_STATUSES: readonly Order['status'][] = ['Open', 'Confirmed', 'Invoiced', 'Paid'];

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

apiRouter.get('/orders', async (req, res) => {
  const all = await repos.orders.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  // Orders have no name/title field (api.service.ts:660-672) -- match ONLY
  // invoiceNumber, never the parent contract/customer's name (design spec §11:
  // no join, to stay in the same "one filter per collection" shape as every
  // other handler in this task).
  res.json(q === undefined ? all : searchPage(all, ['invoiceNumber'], q, clampSearchPage(req.query)));
});
apiRouter.post('/orders', async (req, res) => {
  const body = pick<OrderEntry>(req.body, ORDER_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  // The PUT path validated `status` against the enum; CREATE did not, so
  // `POST /orders {status:'Cancelled'}` (or the lowercase 'paid') persisted verbatim
  // on both adapters — an order that matches no status filter anywhere: absent from
  // invoiced and from Paid, still counted in customerRevenue by the unfiltered
  // lineSum, and rendered as an unknown chip label.
  if (body.status !== undefined && !(ORDER_STATUSES as readonly string[]).includes(body.status)) {
    res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
    return;
  }
  const fkError = await validateOrder(body);
  if (fkError) { res.status(400).json({ error: fkError }); return; }
  // Phase G: orderDate must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['orderDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  const item = { id: newId(), partnerId: '', ...body } as OrderEntry;
  // INVOICE NUMBERING: an order created directly as 'Invoiced' gets a number now.
  // Allocation and persistence share the per-year transaction boundary.
  const invoiceDate = new Date().toISOString();
  const created = await withCommercialWriteTransaction(invoiceDate, (_transactionRepos, createOrder) =>
    createOrder(item as unknown as Order));
  res.json(created);
});
apiRouter.put('/orders/:id', async (req, res) => {
  const existing = await repos.orders.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<OrderEntry>(req.body, ORDER_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  // `status` is picked from the body but was never checked against the enum, so any
  // string landed on the column — including one no consumer matches, which silently
  // drops the order out of every status-keyed rollup.
  if (body.status !== undefined && !(ORDER_STATUSES as readonly string[]).includes(body.status)) {
    res.status(400).json({ error: `status must be one of: ${ORDER_STATUSES.join(', ')}` });
    return;
  }
  const fkError = await validateOrder(body, existing as unknown as OrderEntry);
  if (fkError) { res.status(400).json({ error: fkError }); return; }
  // Phase G: orderDate must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['orderDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  // AN ISSUED DOCUMENT'S MONEY IS NOT CLIENT-SETTABLE. Checked here for a fast
  // 409, and AGAIN inside the transaction below against the freshest row, because
  // that is where the write happens — a guard that only runs before the
  // read-modify-write can be raced by a concurrent invoice assignment.
  const issuedErr = issuedOrderFieldLockError(
    existing as unknown as Pick<Order, 'invoiceNumber' | 'status'> & Record<string, unknown>,
    body as Record<string, unknown>,
  );
  if (issuedErr) { res.status(409).json({ error: issuedErr }); return; }
  // INVOICE NUMBERING: assign a sequential number/date on transition to
  // 'Invoiced'. invoiceNumber/invoiceDate are not in ORDER_FIELDS, so the
  // client can never set them; they are strictly server-assigned.
  // B-CONCURRENCY: allocation, fresh read and update share the same per-year
  // transaction. A second worker sees the first worker's committed number and
  // therefore keeps it instead of allocating another.
  const invoiceDate = new Date().toISOString();
  const result = await invoiceNumbers.run(invoiceDate, async (transactionRepos, invoiceNumber) => {
    const current = (await transactionRepos.orders.get(req.params.id)) as OrderEntry | undefined;
    const authoritative = current ?? (existing as unknown as OrderEntry);
    // Re-checked against the row we are about to write, not the pre-transaction
    // snapshot: between the two, another request may have moved this order to
    // 'Invoiced' and assigned it a number.
    const freshIssuedErr = issuedOrderFieldLockError(
      authoritative as unknown as Pick<Order, 'invoiceNumber' | 'status'> & Record<string, unknown>,
      body as Record<string, unknown>,
    );
    if (freshIssuedErr) return { status: 409, body: { error: freshIssuedErr } };
    const merged = { ...authoritative, ...body };
    applyInvoiceNumbering(merged, invoiceNumber, invoiceDate);
    return { status: 200, body: await transactionRepos.orders.update(req.params.id, merged as Partial<Order>) };
  });
  res.status(result.status).json(result.body);
});
apiRouter.delete('/orders/:id', async (req, res) => {
  // AN ISSUED DOCUMENT IS NOT DELETABLE. Invoice numbers are assigned as
  // max(existing) + 1, so they are derived from the rows that still exist:
  // deleting the order holding the highest number released that legal number for
  // reuse, and the next invoice went out under a number a customer already had.
  // The handler also had no read, so it 204'd on a missing id.
  const existing = await repos.orders.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const issuedErr = issuedOrderDeleteError(existing as unknown as Pick<Order, 'invoiceNumber' | 'status'>);
  if (issuedErr) { res.status(409).json({ error: issuedErr }); return; }
  await repos.orders.remove(req.params.id);
  res.status(204).send();
});

const ORDER_LINE_FIELDS = ['orderId', 'projectId', 'description', 'amount'] as const;

/**
 * Atomic order + project-imputation creation. The client supplies one stable
 * idempotency key for the form submission; retries resolve the same deterministic
 * order/line ids and therefore cannot create duplicate records.
 */
apiRouter.post('/orders/with-line', async (req, res, next) => {
  const idempotencyKey = (req.body as Record<string, unknown> | undefined)?.['idempotencyKey'];
  if (!isValidCommercialIdempotencyKey(idempotencyKey)) {
    res.status(400).json({ error: 'idempotencyKey must be 8-128 safe ASCII characters' });
    return;
  }

  const rawOrder = (req.body as { order?: unknown } | undefined)?.order;
  const rawLine = (req.body as { line?: unknown } | undefined)?.line;
  const orderBody = pick<OrderEntry>(rawOrder, ORDER_FIELDS);
  const lineBody = pick<OrderLineEntry>(rawLine, ['projectId', 'description', 'amount']);
  const missingOrderField = ['contractId', 'type', 'amount', 'currency', 'status', 'orderDate']
    .find(field => orderBody[field as keyof OrderEntry] === undefined);
  const missingLineField = ['projectId', 'description', 'amount']
    .find(field => lineBody[field as keyof OrderLineEntry] === undefined);
  if (missingOrderField || missingLineField) {
    res.status(400).json({ error: `${missingOrderField ?? missingLineField} is required` });
    return;
  }
  if (!['Customer', 'Purchase'].includes(orderBody.type as string)) {
    res.status(400).json({ error: 'type must be Customer or Purchase' });
    return;
  }
  if (!['Open', 'Confirmed', 'Invoiced', 'Paid'].includes(orderBody.status as string)) {
    res.status(400).json({ error: 'status is invalid' });
    return;
  }
  const badOrderField = findInvalidNumericField(orderBody, ['amount']);
  if (badOrderField) { res.status(400).json({ error: `${badOrderField} must be a non-negative number` }); return; }
  const badLineField = findInvalidNumericField(lineBody, ['amount']);
  if (badLineField) { res.status(400).json({ error: `${badLineField} must be a non-negative number` }); return; }
  const fkError = await validateOrder(orderBody);
  if (fkError) { res.status(400).json({ error: fkError }); return; }
  if (!(await existsRepo(repos.projects, lineBody.projectId))) {
    res.status(400).json({ error: 'projectId must reference an existing project' });
    return;
  }
  const dateErr = validateDateFields(orderBody as Record<string, unknown>, ['orderDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }

  const normalizedOrder = {
    contractId: orderBody.contractId,
    type: orderBody.type,
    amount: orderBody.amount,
    currency: orderBody.currency,
    status: orderBody.status,
    orderDate: orderBody.orderDate,
    ...(orderBody.type === 'Purchase' ? { partnerId: orderBody.partnerId } : {}),
  } as OrderWithLineRequest['order'];
  const request: OrderWithLineRequest = {
    idempotencyKey,
    order: normalizedOrder,
    line: {
      projectId: lineBody.projectId,
      description: lineBody.description,
      amount: lineBody.amount,
    } as OrderWithLineRequest['line'],
  };

  try {
    const result = await withLock(`order-request:${idempotencyKey}`, () =>
      withCommercialWriteTransaction(new Date().toISOString(), (transactionRepos, createOrder) =>
        createOrderWithLineWrite({
          orders: transactionRepos.orders,
          orderLines: transactionRepos.orderLines,
          // `projects` is read to reject a line whose project belongs to a
          // different contract than the order, BEFORE either row is written.
          // Same transaction as the writes it guards.
          projects: transactionRepos.projects,
          createOrder,
        }, request)));
    res.json(result);
  } catch (error) {
    if (error instanceof CommercialWriteError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

apiRouter.get('/order-lines', async (_req, res) => { res.json(await repos.orderLines.list()); });
apiRouter.post('/order-lines', async (req, res) => {
  const body = pick<OrderLineEntry>(req.body, ORDER_LINE_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  if (!(await existsRepo(repos.orders, body.orderId))) { res.status(400).json({ error: 'orderId must reference an existing order' }); return; }
  if (!(await existsRepo(repos.projects, body.projectId))) { res.status(400).json({ error: 'projectId must reference an existing project' }); return; }
  // ADDING a line to an issued order breaks the Σ-lines == order.amount invariant
  // `assertGeneratedLineTotal` established when the invoice was generated.
  const parent = await repos.orders.get(body.orderId as string);
  const addErr = parent && issuedOrderLineStructureError(parent, 'add');
  if (addErr) { res.status(409).json({ error: addErr }); return; }
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
  // AN ISSUED INVOICE'S LINES ARE ITS MONEY. Both the CURRENT parent and any
  // retargeting `body.orderId` are checked, so a line cannot be re-parented off an
  // issued order to escape the lock (nor onto one to inflate it).
  for (const orderId of new Set([existing.orderId, body.orderId].filter((id): id is string => typeof id === 'string'))) {
    const order = await repos.orders.get(orderId);
    const issuedErr = order && issuedOrderLineWriteError(
      order,
      existing as unknown as Record<string, unknown>,
      body as Record<string, unknown>,
    );
    if (issuedErr) { res.status(409).json({ error: issuedErr }); return; }
  }
  const updated = await repos.orderLines.update(req.params.id, body as Partial<OrderLine>);
  res.json(updated);
});
apiRouter.delete('/order-lines/:id', async (req, res) => {
  // Was a bare remove() + 204: it removed the whole line amount from
  // invoicedRevenue while the order header kept its legal invoice number (the
  // e-invoice then silently falls back to the header amount), and it 204'd for an
  // id that never existed, appending a phantom audit entry.
  const existing = await repos.orderLines.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const parent = await repos.orders.get(existing.orderId);
  const issuedErr = parent && issuedOrderLineStructureError(parent, 'remove');
  if (issuedErr) { res.status(409).json({ error: issuedErr }); return; }
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

/** Referential rules shared by billing create and fully-merged update paths. */
async function validateBillingPlanReferences(item: BillingPlanEntry): Promise<string | null> {
  const contract = await repos.contracts.get(item.contractId);
  if (!contract) return 'contractId must reference an existing contract';
  if (item.projectId) {
    const project = await repos.projects.get(item.projectId);
    if (!project) return 'projectId must reference an existing project';
    if (project.contractId !== item.contractId) return 'projectId must belong to the billing contract';
  }
  if (item.type === 'Milestone' && item.milestoneId) {
    const milestone = await repos.milestones.get(item.milestoneId);
    if (!milestone) return 'milestoneId must reference an existing milestone';
    if (item.projectId && milestone.projectId !== item.projectId) return 'milestoneId must belong to the billing project';
    const milestoneProject = await repos.projects.get(milestone.projectId);
    if (!milestoneProject || milestoneProject.contractId !== item.contractId) {
      return 'milestoneId must belong to a project on the billing contract';
    }
  }
  if (item.orderId) {
    const order = await repos.orders.get(item.orderId);
    if (!order) return 'orderId must reference an existing order';
    if (order.contractId !== item.contractId) return 'orderId must belong to the billing contract';
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
 * Accrued T&M for a project, DERIVED as Σ(approved time-entry hours × the
 * NEGOTIATED SELL RATE) — the same as-incurred rule the finance util's
 * `recognitionSchedule` applies, resolved through the very same `sellRateFor`
 * (project override -> the project's contract rate for hours dated inside that
 * contract's period -> the resource's own effective billRate). That parity claim
 * used to be stated here and was false: this function summed
 * `hours × resource.billRate` while recognitionSchedule priced at the negotiated
 * rate, and THIS figure is what decides whether the `[CAP-EXCEEDED]`
 * not-to-exceed flag is written into a billing item's notes. A negotiated
 * discount therefore fired the flag on an accrual the customer will never be
 * billed, and a negotiated premium let a genuine breach of a not-to-exceed
 * ceiling pass unflagged.
 *
 * UNITS: `resolveResourceRates` yields an EUR/HOUR reference rate and
 * `sellRateFor` returns EUR/HOUR on every path (dividing a stored EUR/DAY
 * negotiated rate by the configured hours/day), so both factors of the
 * multiplication below are hourly.
 *
 * Rates are EUR (the base currency) — `sellRateFor` only ever resolves a
 * base-currency row — so the returned accrual is a BASE-currency figure; the
 * caller converts a per-item cap into base before comparing. Returns undefined
 * when accrual is not derivable (no projectId), so the caller can skip the
 * accrued<=cap check rather than treat "no data" as zero accrual.
 */
async function accruedTAndM(item: Pick<BillingPlanEntry, 'projectId'>): Promise<number | undefined> {
  if (!item.projectId) return undefined;
  const [entries, rawResources, projects, contracts, negotiatedRates, hoursPerDay] = await Promise.all([
    repos.timeEntries.list(),
    repos.resources.list(),
    repos.projects.list(),
    repos.contracts.list(),
    repos.negotiatedRates.list(),
    getHoursPerDay(),
  ]);
  // Phase E: use EFFECTIVE bill rates (override ?? rate card), not the raw column.
  const resources = await resolveResourceRates(rawResources);
  const resourceById = new Map(resources.map(r => [r.id, r]));
  let accrued = 0;
  for (const t of entries) {
    if (t.status !== 'Approved' || t.projectId !== item.projectId) continue;
    const resource = resourceById.get(t.resourceId);
    const rate = sellRateFor({
      projectId: t.projectId,
      role: resource?.role,
      date: t.date,
      referenceBillRate: resource?.billRate,
      hoursPerDay,
      rates: negotiatedRates as unknown as NegotiatedRate[],
      projects: projects as unknown as { id: string; contractId?: string }[],
      contracts: contracts as unknown as { id: string; startDate: string; endDate?: string }[],
    }) ?? 0;
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
  // The CUSTOMER-FACING amount is what the cap constrains: a not-to-exceed ceiling
  // is a promise about what the customer will be billed. On an Expense condition the
  // stored `amount` excludes markupPct, so a 3200 expense with 5% markup bills 3360
  // and used to slip under a 3300 cap unflagged — the same raw-vs-customer-facing
  // confusion that made /billing under-bill the printed invoice.
  const customerFacing = customerFacingBillingAmount(merged as unknown as BillingPlanItem);
  if (Number.isFinite(customerFacing) && customerFacing > cap) {
    return { error: `amount ${customerFacing} exceeds capAmount ${cap} (not-to-exceed)` };
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

/** One server-owned, transaction-backed invoice generation operation. */
function generateInvoiceForBillingItem(id: string, issuedDate: string): Promise<BillingInvoiceResult> {
  return withLock(`billing:${id}`, () =>
    withCommercialWriteTransaction(issuedDate, (transactionRepos, createInvoicedOrder) =>
      generateBillingInvoiceWrite({
        billingPlanItems: transactionRepos.billingPlanItems,
        orders: transactionRepos.orders,
        orderLines: transactionRepos.orderLines,
        projects: transactionRepos.projects,
        milestones: transactionRepos.milestones,
        createInvoicedOrder,
      }, id, issuedDate)));
}

/**
 * PAYMENT is two records, so it is one operation. Marking a billing condition
 * Paid must also move its linked customer order to Paid; the client used to PUT
 * only the billing item, which left the order 'Invoiced' forever and made Orders
 * show a paid invoice as outstanding. `markBillingInvoicePaid` was written for
 * exactly this and was never imported — the guards it carries (Invoiced-before-
 * Paid, same-contract, customer-order-only, compensation on failure) were
 * unreachable and its three unit tests were credited against dead code.
 *
 * Idempotent by state, not by key: both records already Paid is a replay
 * (`replayed: true`), never a 409, so a lost response is safe to retry. Both
 * repositories are taken from ONE transaction, and the same
 * `billing:<id>` lock the invoice path uses serialises it against generation.
 */
function markBillingItemPaid(id: string, paidDate: string): Promise<BillingPaymentResult> {
  return withLock(`billing:${id}`, () =>
    withRepositoriesTransaction(
      transactionRepos => markBillingInvoicePaidWrite({
        billingPlanItems: transactionRepos.billingPlanItems,
        orders: transactionRepos.orders,
      }, id, paidDate),
      { advisoryLockKeys: [`billing:${id}`] },
    ));
}

apiRouter.post('/billing-plan-items/:id/mark-paid', async (req, res, next) => {
  const paidDate = (req.body as Record<string, unknown> | undefined)?.['paidDate'] ?? new Date().toISOString();
  const dateErr = validateDateFields({ paidDate }, ['paidDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  try {
    res.json(await markBillingItemPaid(req.params.id, paidDate as string));
  } catch (error) {
    if (error instanceof CommercialWriteError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

apiRouter.post('/billing-plan-items/:id/generate-invoice', async (req, res, next) => {
  const issuedDate = (req.body as Record<string, unknown> | undefined)?.['issuedDate'] ?? new Date().toISOString();
  const dateErr = validateDateFields({ issuedDate }, ['issuedDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  try {
    res.json(await generateInvoiceForBillingItem(req.params.id, issuedDate as string));
  } catch (error) {
    if (error instanceof CommercialWriteError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  }
});

/**
 * Batch semantics are deliberately per-item: input ids are de-duplicated,
 * processed in request order (so invoice numbers are predictable), and one
 * failure does not roll back invoices already committed for other conditions.
 * Retrying the same batch is safe because each individual operation is
 * idempotent. HTTP 207 exposes partial completion without turning it into a
 * transport error for HttpClient.
 */
apiRouter.post('/billing-plan-items/generate-invoices', async (req, res) => {
  const rawIds = (req.body as Record<string, unknown> | undefined)?.['ids'];
  const issuedDate = (req.body as Record<string, unknown> | undefined)?.['issuedDate'] ?? new Date().toISOString();
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.length > 100 || rawIds.some(id => typeof id !== 'string' || !id)) {
    res.status(400).json({ error: 'ids must be an array of 1-100 non-empty strings' });
    return;
  }
  const dateErr = validateDateFields({ issuedDate }, ['issuedDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }

  const ids = [...new Set(rawIds as string[])];
  const results: BillingInvoiceResult[] = [];
  const failures: { id: string; status: number; error: string }[] = [];
  for (const id of ids) {
    try {
      results.push(await generateInvoiceForBillingItem(id, issuedDate as string));
    } catch (error) {
      failures.push(error instanceof CommercialWriteError
        ? { id, status: error.status, error: error.message }
        : { id, status: 500, error: 'Invoice generation failed' });
    }
  }
  res.status(failures.length ? 207 : 200).json({ results, failures });
});

apiRouter.get('/billing-plan-items', async (_req, res) => { res.json(await repos.billingPlanItems.list()); });
apiRouter.post('/billing-plan-items', async (req, res) => {
  const body = pick<BillingPlanEntry>(req.body, BILLING_PLAN_FIELDS);
  const curErr = await validateCurrency(body);
  if (curErr) { res.status(400).json({ error: curErr }); return; }
  // Phase G: every billing date (expected/issued/due/paid) must be ISO when supplied.
  const dateErr = validateDateFields(body as Record<string, unknown>, ['expectedDate', 'issuedDate', 'dueDate', 'paidDate']);
  if (dateErr) { res.status(400).json({ error: dateErr }); return; }
  // TERMINAL STATUSES ARE NOT CLIENT-SETTABLE ON CREATE either. The PUT path is
  // guarded by billingPlanStatusTransitionError, but the CREATE path pinned nothing
  // and billingPlanValidationError only checks enum membership — an enum that
  // includes 'Invoiced' and 'Paid'. A POST could therefore mint a condition already
  // 'Paid' with any amount, which BILLED_STATUSES counts as billed and collected:
  // phantom revenue with no invoice, no order and no payment behind it.
  const createStatusErr = billingPlanCreateStatusError(body.status);
  if (createStatusErr) { res.status(409).json({ error: createStatusErr }); return; }
  // `orderId` IS THE LINK TO AN ISSUED DOCUMENT, so it is server-owned too.
  // validateBillingPlanReferences only checks that the order exists and shares the
  // contract, and generateBillingInvoice takes `item.orderId ?? billingInvoiceOrderId(item.id)`
  // — so pre-linking a new condition to an already-invoiced customer order whose
  // fields happen to satisfy sameGeneratedInvoice let a SECOND condition ride an
  // invoice number already sent to the customer. The link is written by
  // generate-invoice, never by the client.
  if (body.orderId !== undefined) {
    res.status(409).json({
      error: 'orderId is assigned by POST /billing-plan-items/:id/generate-invoice and cannot be set on create',
    });
    return;
  }
  const item = { id: newId(), ...body } as BillingPlanEntry;
  const validationErr = billingPlanValidationError(item as unknown as BillingPlanItem);
  if (validationErr) { res.status(400).json({ error: validationErr }); return; }
  const referenceErr = await validateBillingPlanReferences(item);
  if (referenceErr) { res.status(400).json({ error: referenceErr }); return; }
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
    const merged = { ...prev, ...body, type: body.type ?? prev.type } as BillingPlanEntry;

    // #14 PROGRESS auto-advance: when progressPct CHANGES and reaches 100%, advance
    // a still-'Planned' Progress item to 'Ready' (same trigger pattern as the
    // milestone→'Ready' flip). Idempotent — fold the status into the merged item
    // first so the cap check below also sees the advanced status.
    Object.assign(merged, progressAutoAdvance(merged, body.progressPct, prev.progressPct));

    const validationErr = billingPlanValidationError(merged as unknown as BillingPlanItem);
    if (validationErr) return { status: 400, body: { error: validationErr } };
    const referenceErr = await validateBillingPlanReferences(merged);
    if (referenceErr) return { status: 400, body: { error: referenceErr } };

    // INVOICED AND PAID ARE NOT CLIENT-SETTABLE. `billingPlanValidationError`
    // validates enum membership only, so before this guard a client could PUT
    // status:'Paid' onto a 'Planned' item with no orderId — and BILLED_STATUSES
    // (finance.util.ts) then counts it as billed, moving the Paid/Unbilled KPIs
    // with no invoice and no order behind it. Both transitions are owned by a
    // server operation that also writes the linked order:
    // POST :id/generate-invoice and POST :id/mark-paid. A re-PUT of the status
    // the item already has stays allowed, so ordinary full-object updates of an
    // Invoiced/Paid row are unaffected.
    const statusTransitionErr = billingPlanStatusTransitionError(prev.status, body.status);
    if (statusTransitionErr) return { status: 409, body: { error: statusTransitionErr } };

    // ...AND, once Invoiced/Paid, WHAT WAS BILLED IS NO LONGER CLIENT-SETTABLE.
    // The guard above only stops a client REACHING those statuses; it returns
    // null whenever `body.status` is absent or unchanged, so a plain
    // `PUT {amount: 999999}` on an already-Invoiced condition used to rewrite the
    // amount while the linked order — already carrying a server-assigned
    // invoiceNumber — kept the old one. Same invoice number, two different
    // totals, and the finance KPIs derived from this row diverge from the
    // document the customer received. Re-PUTting unchanged values still passes,
    // so the edit form's full-object update of an Invoiced row keeps working.
    const invoicedFieldErr = billingPlanInvoicedFieldLockError(
      prev as unknown as Pick<BillingPlanItem, 'status'> & Record<string, unknown>,
      body as Record<string, unknown>,
    );
    if (invoicedFieldErr) return { status: 409, body: { error: invoicedFieldErr } };

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
  // Counterpart of `billingPlanInvoicedFieldLockError` above: that guard stops a
  // client rewriting what was billed, this one stops it being deleted instead —
  // otherwise the field lock is bypassable by removing the row, which also
  // orphans the linked customer order and drops the billed amount out of every
  // finance figure derived from the plan.
  const existing = await repos.billingPlanItems.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const deleteErr = invoicedBillingItemDeleteError(existing);
  if (deleteErr) { res.status(409).json({ error: deleteErr }); return; }
  await repos.billingPlanItems.remove(req.params.id);
  res.status(204).send();
});

// --- Negotiated sell rates (Task 3, design spec §5) -------------------------
//
// `/negotiated-rates` is a bespoke handler set, NOT mounted with `crud()` — it
// carries referential-integrity rules `crud()` cannot express, following the
// same shape as `/resource-organizations` above: a required-field list
// declared ONCE (`REQUIRED_NEGOTIATED_RATE_FIELDS`) so the pick()-forwards-null
// class (see the note at `REQUIRED_ORG_FIELDS`) is rejected for the whole class
// of notNull columns rather than a hand-picked subset, a single validator
// called from both POST and PUT, and the SAME `pick()` allow-list literally
// duplicated in both handlers (a field missing from one list is not writable
// through that verb and fails SILENTLY — see the note at
// `/resource-organizations`'s POST/PUT for the exact same trap).
//
// No cross-record lock (unlike ORG_TREE_LOCK above): the org-tree guard reasons
// over the WHOLE tree (parent/child/level, a graph), so an unserialized
// concurrent write can leave the graph inconsistent. This validator reasons
// over a single collection's own uniqueness key instead — a narrower shape
// than the org tree's, though NOT one shared by `/contracts`/`/orders`/
// `/order-lines` (those only run FK lookups and numeric checks; none of them
// scan their own collection for a same-key duplicate the way this does). On
// its own merits: a race here would at worst let two near-simultaneous POSTs
// both insert the same key, `sellRateFor` (src/app/services/sell-rate.util.ts)
// already resolves that deterministically (first match), and this collection
// is low-frequency and finance/sales-gated (no high-concurrency writers) — so
// no data is actually corrupted, unlike the org tree's graph-wide guards.

/** Every notNull column on negotiated_rates (src/db/schema.ts), declared ONCE
 *  so the null-rejection covers the class rather than a hand-picked subset. */
const REQUIRED_NEGOTIATED_RATE_FIELDS = ['role', 'currency', 'billRate'] as const;

/**
 * Validate a `/negotiated-rates` body against every rule in design spec §5, in
 * the order the spec lists them: the null/empty-string-rejection loop first,
 * then contractId XOR projectId, then FK existence (whichever side is
 * supplied), then role existence, then currency validity, then same-key
 * uniqueness (self-excluded on PUT), then the numeric check. Returns a
 * 400-suitable message, or null when the body is acceptable. Both POST and
 * PUT call this same function so the rule can never drift between the two
 * verbs.
 *
 * `ctx.id` is the record's own id on PUT (absent on POST) — mirrors
 * `validateOrgTreeNode`'s signature above. A field omitted from `body` (POST
 * of a full row, or a partial PUT patch) falls back to the EXISTING row's
 * value so a partial PUT is validated against its full, post-merge shape —
 * exactly what check 9 in the smoke suite (PUT changing only billRate) needs
 * to keep passing its own xor/FK/role/uniqueness checks unchanged.
 *
 * ROLE CHECK (user decision, superseding an earlier reading of spec §5) —
 * against the project-roles CATALOG, via the SAME `validateRoleRefs` helper
 * every other role reference in the app already uses (resources,
 * requests/`requiredRole`), not a second rule. An earlier draft checked
 * roles actually HELD by a resource today (`repos.resources`), reasoning that
 * a role no resource holds is a typo. That reasoning has it backwards: a
 * sell rate is negotiated with a customer BEFORE anyone with that profile is
 * ever hired, and a contract is signed before staffing begins — so a
 * catalog role with no resource staffed on it yet is a perfectly legitimate,
 * forward-looking configuration, not an error. Checking against
 * `repos.resources` would reject the exact rates this feature exists to let
 * sales negotiate early. Only a role absent from the catalog too (a genuine
 * typo) is rejected.
 *
 * CURRENCY CHECK — first reuses the SAME `validateCurrency` helper `/contracts`,
 * `/orders` and `/rate-cards` call, then applies the negotiated-rate contract:
 * rates must be denominated in reporting base currency (EUR). Before this check
 * existed, `currency: ''`
 * was accepted by every rule below untouched (the null-rejection loop only
 * ever caught an explicit `null`) and produced a row that LOOKED saved but
 * was silently never read again: `sellRateFor`
 * (`src/app/services/sell-rate.util.ts`) only ever resolves a rate whose
 * currency is the base currency, so an empty-string row never participated
 * in resolution. The null-rejection loop below now treats `''` the same as
 * `null` for every required column (closing the empty-string gap for `role`
 * too, not only `currency`), and this step additionally rejects a non-empty
 * but unconfigured currency code. A configured non-base code is now rejected
 * coherently instead of being saved and then silently ignored by sellRateFor.
 *
 * ROUND 2 (coordinator review, critical) — OMITTED is not the same bug as
 * NULL. Every check below the null loop reads `body.field === undefined ?
 * existing?.field : body.field`, which is exactly PUT's fall-back-to-existing
 * semantics: a field the client didn't touch should keep its stored value. On
 * POST there IS no existing row, so an outright-OMITTED (not nulled) required
 * field resolved to `undefined` and every one of those checks silently
 * no-opped — `POST {contractId:'CT1'}` alone used to pass xor and the FK
 * check, then skip role-existence, uniqueness AND the numeric check entirely,
 * creating a row missing three notNull columns (200 in-memory, unmapped 23502
 * as an opaque 500 on Postgres — the exact two-adapters-disagree class this
 * whole task exists to close, reached by omission instead of by an explicit
 * null). Closed by extending the SAME declared list: on POST (`ctx ===
 * undefined`, so there is nothing to inherit from) every
 * REQUIRED_NEGOTIATED_RATE_FIELDS entry must also be PRESENT, not merely
 * non-null. PUT's fall-back-to-existing behaviour is untouched — this check
 * is gated OFF whenever `ctx` is supplied.
 */
async function validateNegotiatedRate(
  body: Partial<NegotiatedRate>,
  ctx?: { id?: string },
): Promise<string | null> {
  // 1. Null/empty-string-rejection loop — every notNull column, rejected as a
  // class BEFORE anything below (the `??` merges, the xor, the uniqueness
  // key) ever sees a masked corruption. Two distinct classes closed here:
  //   - pick() forwards an explicit JSON null (it filters only undefined),
  //     and a naive `body.role ?? existing?.role` cannot tell "the client
  //     didn't touch this field" from "the client sent null" — it would fall
  //     back to the EXISTING value for every check below while the object
  //     handed to the repo still carries the literal null, corrupting the
  //     row in-memory (repository.ts's explicit-null-clears rule deletes the
  //     key) and raising an unmapped NOT NULL violation (23502) as an opaque
  //     500 on Postgres — the two adapters silently disagreeing.
  //   - an explicit empty string is not `null`, so it survived that check
  //     alone, but it is the same "cleared to nothing" corruption for a
  //     notNull column in practice (see the CURRENCY CHECK doc note above for
  //     the concrete, previously-silent consequence) — treated identically to
  //     `null` here so neither `currency` nor `role` can ever be saved empty.
  for (const field of REQUIRED_NEGOTIATED_RATE_FIELDS) {
    if (body[field] === null || body[field] === '') return `${field} is required and cannot be cleared`;
  }
  // 1b. Required-PRESENT on POST only (see the ROUND 2 doc note above): with
  // no existing row to inherit from, an omitted key is not "unchanged", it is
  // simply missing. PUT keeps its fall-back-to-existing behaviour untouched —
  // this loop runs ONLY when there is no ctx (i.e. no existing row at all).
  if (ctx === undefined) {
    for (const field of REQUIRED_NEGOTIATED_RATE_FIELDS) {
      if (body[field] === undefined) return `${field} is required`;
    }
  }

  const all = await repos.negotiatedRates.list();
  const existing = ctx?.id === undefined ? undefined : all.find(r => r.id === ctx.id);

  // 1c. THE TWO NULLABLE FKs MUST BE USABLE OR ABSENT — NOTHING IN BETWEEN.
  // The xor below asks `typeof x === 'string' && x.length > 0`, but the object
  // handed to create()/update() is this `body` VERBATIM: a value that FAILED
  // that test was read as "absent" by the xor and then persisted anyway. So
  // `{contractId: '', projectId: '2'}` used to return 200 with BOTH FK columns
  // set in-memory — breaking the invariant that exactly one of them is ever
  // populated (docs/architecture/03-backend-and-data.md) — while on Postgres
  // `contract_id = ''` is a non-NULL value with no matching contracts row, so
  // the FK raised 23503 and the error middleware mapped it to 409. Same
  // request, two different answers: the two-adapters-disagree class the rest of
  // this validator exists to close, left open on the only two nullable columns.
  // `{contractId: 123}` is the same hole with a different type.
  //
  // An explicit `null` is deliberately NOT rejected here: it is the one signal
  // that CLEARS a side (repository.ts drops the key in-memory, Postgres writes
  // NULL, `nullsToUndefined` reports both as absent), which is what makes a
  // rate movable from contract-level to project-level in one PUT. The xor
  // already reads it as absent, which is exactly what it will become.
  for (const field of ['contractId', 'projectId'] as const) {
    const raw = (body as Record<string, unknown>)[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string' || raw.length === 0) {
      return `${field} must be a non-empty string referencing an existing row, or null to clear it`;
    }
  }

  // 2. contractId XOR projectId — exactly one, never neither, never both. Safe
  // to judge with the string test now that 1c has rejected everything that
  // would fail it while still being written (see that note).
  const contractId = body.contractId === undefined ? existing?.contractId : body.contractId;
  const projectId = body.projectId === undefined ? existing?.projectId : body.projectId;
  const hasContract = typeof contractId === 'string' && contractId.length > 0;
  const hasProject = typeof projectId === 'string' && projectId.length > 0;
  if (hasContract === hasProject) {
    return 'exactly one of contractId or projectId is required';
  }

  // 3. FK existence — only the side actually carrying a value is checked.
  if (hasContract && !(await existsRepo(repos.contracts, contractId))) {
    return 'contractId must reference an existing contract';
  }
  if (hasProject && !(await existsRepo(repos.projects, projectId))) {
    return 'projectId must reference an existing project';
  }

  // 4. Role existence — against the project-roles CATALOG (see doc comment
  // above), via the same `validateRoleRefs` helper the rest of the app uses
  // for role references, rather than a second, negotiated-rates-only rule.
  const role = body.role === undefined ? existing?.role : body.role;
  if (role !== undefined) {
    const roleErr = await validateRoleRefs({ role });
    if (roleErr) return roleErr;
  }

  // 5. Currency validity + interpretation contract. It must be configured, and
  // negotiated rates must use base currency so every accepted row is consumable.
  const currency = body.currency === undefined ? existing?.currency : body.currency;
  const curErr = await validateCurrency({ currency });
  if (curErr) return curErr;
  const negotiatedCurrencyErr = negotiatedRateCurrencyError(currency);
  if (negotiatedCurrencyErr) return negotiatedCurrencyErr;

  // 6. Same-key uniqueness on (contractId|projectId, role, currency), self-excluded on PUT.
  if (role !== undefined && currency !== undefined) {
    const dupe = all.find(r =>
      r.id !== ctx?.id
      && r.role === role
      && r.currency === currency
      && (hasContract ? r.contractId === contractId : r.projectId === projectId),
    );
    if (dupe) return `a negotiated rate already exists for this key (existing id ${dupe.id})`;
  }

  // 7. Numeric — billRate must be a finite, non-negative number.
  const billRate = body.billRate === undefined ? existing?.billRate : body.billRate;
  if (billRate !== undefined && !isNonNegNumber(billRate)) {
    return 'billRate must be a non-negative number';
  }

  return null;
}

apiRouter.get('/negotiated-rates', async (_req, res) => { res.json(await repos.negotiatedRates.list()); });
apiRouter.post('/negotiated-rates', async (req, res) => {
  const body = pick<NegotiatedRate>(req.body, [
    'contractId', 'projectId', 'role', 'currency', 'billRate',
  ]);
  // On a CREATE there is no previous value, so an explicit null on a nullable FK
  // means "not set" — normalise it to ABSENT before anything else sees it.
  // Otherwise `InMemoryRepository.create` (unlike `update`, which drops a null
  // key) stores the literal null and serves `contractId: null` forever, while
  // Postgres inserts NULL and `nullsToUndefined` reports it absent: the same
  // POST, two different JSON shapes. Doing it HERE, before validation, is what
  // makes the validator judge the object that will actually be stored.
  for (const field of ['contractId', 'projectId'] as const) {
    if ((body as Record<string, unknown>)[field] === null) delete body[field];
  }
  const err = await validateNegotiatedRate(body);
  if (err) { res.status(400).json({ error: err }); return; }
  const item = { id: newId(), ...body } as NegotiatedRate;
  const created = await repos.negotiatedRates.create(item);
  res.json(created);
});
apiRouter.put('/negotiated-rates/:id', async (req, res) => {
  const existing = await repos.negotiatedRates.get(req.params.id);
  if (existing === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<NegotiatedRate>(req.body, [
    'contractId', 'projectId', 'role', 'currency', 'billRate',
  ]);
  const err = await validateNegotiatedRate(body, { id: req.params.id });
  if (err) { res.status(400).json({ error: err }); return; }
  const updated = await repos.negotiatedRates.update(req.params.id, body);
  res.json(updated);
});
apiRouter.delete('/negotiated-rates/:id', async (req, res) => {
  await repos.negotiatedRates.remove(req.params.id);
  res.status(204).send();
});

/**
 * Freeze (or re-freeze) a project's monthly cost baseline (design spec, block
 * E, §3.4/§3.5). The freeze horizon is the union of every month the project
 * has at least one AssignmentDay in, expanded contiguously. Writes ONE ROW
 * PER PERIOD, atomically, under a per-project lock — a re-freeze APPENDS a
 * new batch, never updates or deletes an existing row (there is no unique
 * constraint on (project_id, period) by design). No PUT/DELETE is exposed.
 *
 * UNITS (spec §9): this handler MUST assemble its own resolved-rate
 * FinanceData via `resolveResourceRates(await repos.resources.list())` —
 * never `loadFinanceData()`, whose `resources` field is a documented,
 * deliberately-unfixed EUR/day (not EUR/hour) hazard (see the comment on
 * `loadFinanceData`, src/server.ts:6517-6527). Reusing it here would
 * overstate every baseline by a factor of hoursPerDay, the same defect shape
 * `sell-rate.util.ts` once shipped.
 */
apiRouter.get('/cost-baselines', async (_req, res) => { res.json(await repos.costBaselines.list()); });
apiRouter.post('/cost-baselines', async (req, res) => {
  const body = pick<{ projectId: string }>(req.body, ['projectId']);
  if (typeof body.projectId !== 'string' || body.projectId.length === 0) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const projectId = body.projectId;
  if (!(await existsRepo(repos.projects, projectId))) {
    res.status(400).json({ error: 'projectId must reference an existing project' });
    return;
  }
  const result = await withLock(`cost-baseline:${projectId}`, async (): Promise<{ status?: number; error?: string; created?: CostBaseline[] }> => {
    const [requests, assignments, assignmentDays, assignmentMonths, rawResources] = await Promise.all([
      repos.requests.list(),
      repos.assignments.list(),
      repos.assignmentDays.list(),
      repos.assignmentMonths.list(),
      repos.resources.list(),
    ]);
    const resources = await resolveResourceRates(rawResources); // resolved EUR/HOUR — never loadFinanceData()
    const reqIds = new Set(requests.filter(r => r.projectId === projectId).map(r => r.id));
    const assignmentIds = new Set(assignments.filter(a => reqIds.has(a.requestId)).map(a => a.id));
    const bookedMonths = assignmentDays
      .filter(d => assignmentIds.has(d.assignmentId))
      .map(d => d.date.slice(0, 7));
    if (bookedMonths.length === 0) {
      return { status: 400, error: 'project has no booked hours to freeze' };
    }
    const from = bookedMonths.reduce((a, b) => (b < a ? b : a));
    const to = bookedMonths.reduce((a, b) => (b > a ? b : a));
    const data: FinanceData = {
      requests, assignments, resources, orders: [], orderLines: [], financials: [],
      assignmentDays, assignmentMonths,
    };
    const schedule = plannedCostSchedule(data, { from, to }, { projectId });
    const at = new Date().toISOString();
    const frozenBy = actorId(req);
    const rows: CostBaseline[] = [];
    for (const p of schedule) {
      const row = await repos.costBaselines.create({
        id: newId(), projectId, period: p.period, amount: p.plannedCost, frozenAt: at, frozenBy,
      } as CostBaseline);
      rows.push(row as CostBaseline);
    }
    return { created: rows };
  });
  if (result.error !== undefined) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json(result.created);
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
  //
  // B-CONCURRENCY: get-then-create is a read-modify-write on a PRIMARY-KEYED row
  // and was unserialized. Two concurrent PUTs for a currency that does not exist
  // yet both saw `undefined` and both called create(): a duplicate row under the
  // in-memory adapter, and a primary-key violation surfacing as an unmapped 500
  // under Postgres — with the later (correct) rate silently discarded. An FX rate
  // multiplies every converted amount in the portfolio, so a stale one is a wrong
  // number everywhere. Re-read inside the section so the branch is taken against
  // the freshest state.
  const row = await withLock(`fx-rate:${currency}`, async () => {
    const existing = await repos.fxRates.get(currency);
    return existing === undefined
      ? await repos.fxRates.create({ id: currency, currency, rateToBase: body.rateToBase } as FxRateRow)
      : await repos.fxRates.update(currency, { rateToBase: body.rateToBase } as Partial<FxRateRow>);
  });
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
/** SLA target measured in whole days from creation. */
const APPROVAL_SLA_DAYS = 3;

/**
 * The row-fetching half of the derived-amount routing rule. The RULE (which kind
 * reads which field, how a milestone's billing conditions are summed, what the
 * threshold compares) lives in `resolveApprovalRoutingAmount` where Vitest can
 * reach it; this adapter is the only part that needs the repositories, and is
 * deliberately kept to one expression per source so there is no logic here to
 * leave untested.
 */
function approvalAmountSources(): ApprovalAmountSources {
  return {
    order: id => repos.orders.get(id),
    changeRequest: id => repos.changeRequests.get(id),
    milestone: id => repos.milestones.get(id),
    billingConditionsForMilestone: async id =>
      (await repos.billingPlanItems.list()).filter(item => item.milestoneId === id),
  };
}

function slaDueFrom(createdAtIso: string): string {
  return new Date(new Date(createdAtIso).getTime() + APPROVAL_SLA_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// `requestedBy` is intentionally NOT client-settable: it is the SoD basis the
// decision endpoint compares the trusted decider against, so it is pinned to the
// verified actor at creation rather than copied from the (forgeable) body.
//
// `amount` IS ABSENT FOR THE SAME REASON, and it is the whole of H2: it used to be
// allow-listed and handed straight to `buildApprovalSteps`, which never reconciled
// it with `refId` — so a requester declared `amount: 1` on a €120k invoice and
// picked the single-approver chain over the two-signature one the
// APPROVAL_HIGH_VALUE_THRESHOLD control exists to force. The amount is now DERIVED
// from `refId` per kind and pinned below, so the stored figure is also the one the
// routing used. A body that still sends `amount` is silently dropped by `pick()`,
// exactly as it drops a forged `requestedBy`.
const APPROVAL_REQUEST_FIELDS = ['kind', 'refId', 'projectId', 'note'] as const;

apiRouter.get('/approval-requests', async (_req, res) => { res.json(await repos.approvalRequests.list()); });
apiRouter.post('/approval-requests', async (req, res) => {
  const body = pick<ApprovalRequestEntry>(req.body, APPROVAL_REQUEST_FIELDS);
  if (typeof body.kind !== 'string' || !APPROVAL_KINDS.includes(body.kind as ApprovalKind)) {
    res.status(400).json({ error: `kind must be one of: ${APPROVAL_KINDS.join(', ')}` });
    return;
  }
  // ALLOCATION APPROVALS ARE NOT CLIENT-CREATABLE. They are opened only by the
  // server's own month lifecycle (`createAllocationApprovalEntry`), which pins
  // `refId` to a composite `<assignmentId>:<YYYY-MM>` so one decision governs one
  // month. The `refId` check below only demands a non-empty string, so a forged
  // `kind:'Allocation'` carrying a BARE assignment id was treated downstream by
  // `applyAllocationDecision` as a legacy gap-A approval and applied to the
  // assignment AND every non-Draft month row beneath it — one decision flipping
  // every month and bypassing the per-month manager approval entirely.
  const kindErr = clientCreatableApprovalKindError(body.kind as string);
  if (kindErr) { res.status(400).json({ error: kindErr }); return; }
  if (typeof body.refId !== 'string' || body.refId.length === 0) {
    res.status(400).json({ error: 'refId is required' });
    return;
  }
  // THE ESCALATION AMOUNT IS DERIVED FROM `refId`, NEVER DECLARED (H2). See
  // `resolveApprovalRoutingAmount` for the per-kind mapping and for why TimeEntry
  // and Expense carry no amount at all rather than falling back to the body.
  // An unresolvable reference on a derivable kind is a 400: it is a bad request,
  // not a licence to route on a number the requester chose.
  const routing = await resolveApprovalRoutingAmount(body.kind as string, body.refId, approvalAmountSources());
  if (routing.outcome === 'unresolved') { res.status(400).json({ error: routing.error }); return; }
  const createdAt = new Date().toISOString();
  const item: ApprovalRequestEntry = {
    id: `AR${newId()}`,
    kind: body.kind as ApprovalKind,
    refId: body.refId,
    projectId: body.projectId,
    // The RECORDED amount is the DERIVED one (signed, as it stands on the
    // referenced document), so the stored figure is the same figure the chain was
    // routed on — an approval whose amount and steps disagree is unauditable.
    amount: routing.outcome === 'derived' ? routing.amount : undefined,
    // SoD basis: pinned to the SERVER-VERIFIED actor, never a client-supplied
    // value (excluded from the create allow-list), so the requester cannot forge
    // a different identity and defeat the self-approval guard at /decision.
    requestedBy: actorId(req),
    status: 'Pending',
    steps: buildApprovalSteps(body.kind as string, routing),
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

/**
 * Persist a month-row transition entry — best-effort, and ONLY when the row moved.
 *
 * Used by the paths that rewrite a governed month straight through the repository
 * rather than through a decision endpoint: `PUT /assignments/:id/allocation` (whose
 * auto-approve branch is an implicit self-approval) and the retarget branch of
 * `PUT /assignments/:id` (which walks approved months back to 'Requested', i.e.
 * un-approves work). Both were invisible in the trail: the middleware snapshots the
 * ASSIGNMENT, which those operations may leave byte-identical.
 *
 * The empty-diff guard matters. An entry with `changedKeys: []` is worse than no
 * entry — it is a positive claim that nothing changed — and the middleware already
 * writes one for the HTTP request itself.
 */
async function appendMonthTransitionAudit(
  req: Request,
  before: AssignmentMonth | undefined,
  after: AssignmentMonth | undefined,
): Promise<void> {
  if (before === undefined || after === undefined) return;
  if (diffChangedKeys(cloneEntity(before), cloneEntity(after)).length === 0) return;
  try {
    await repos.auditLogs.create(monthTransitionAudit(req, before, after));
  } catch { /* audit is best-effort; the transition itself already committed */ }
}

/** The SERVER-VERIFIED principal driving a decision. Never client-supplied: a
 *  client-controlled `by` would defeat the SoD check and forge the recorded
 *  approver. Resolved once by the caller and passed down unchanged.
 *
 *  `decidingRoles` is the WHOLE verified set and is what every authorization
 *  answer below is computed from. This field used to be a single
 *  `decidingRole: string` filled from `primaryRole()`, and the step check compared
 *  it to `step.role` — so an approver holding the step's role PLUS a higher-ranked
 *  one was refused the step routed to them (see `stepRoleMatch`). Typed as an
 *  array deliberately: every call site must supply `trustedRoles(req)` or fail to
 *  compile.
 *
 *  There is deliberately no display-role field here. Neither 403 below names the
 *  actor's role (they name the STEP: "a step assigned to finance"), and the 401
 *  principal check happens at each route before this context is built, so a
 *  retained label would be dead state inviting a future authorization check to
 *  read it. */
interface DeciderContext {
  by: string;
  decidingRoles: readonly UserRole[];
  deciderResourceId: string | undefined;
}
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
 * Reads only, so it takes NO lock: it runs inside the caller's serialized
 * approval command (generic `approval:<id>` or B3 month transaction), and
 * acquiring the `org-chart` lock (or any other)
 * from in there would invent a lock order no other call site uses — see the
 * ordering note on the `/resources` PUT handler.
 */
async function allocationTargetResourceId(
  ar: ApprovalRequestEntry,
  repositorySet: Repositories = repos,
): Promise<string | undefined> {
  if (ar.kind !== 'Allocation') return undefined;
  const assignmentId = parseMonthRowId(ar.refId)?.assignmentId ?? ar.refId;
  const assignment = await repositorySet.assignments.get(assignmentId);
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
 * B-CONCURRENCY: the caller supplies the serialized boundary. Generic approvals
 * use `approval:<id>`; B3 allocation approvals use the month lifecycle executor
 * so this update and the governed month transition share one transaction.
 */
async function decideOneApprovalInRepositories(
  req: Request,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  note: string | undefined,
  ctx: DeciderContext,
  repositorySet: Repositories,
): Promise<DecisionOutcome> {
  const { by, decidingRoles, deciderResourceId } = ctx;
    const ar = await repositorySet.approvalRequests.get(approvalId) as ApprovalRequestEntry | undefined;
    if (ar === undefined) return { status: 404, body: { error: 'Not found' } };
    if (ar.status !== 'Pending') return { status: 400, body: { error: `approval request already ${ar.status}` } };
    // SoD: the requester may never approve/reject their own item. Meaningful now
    // that `by` is the trusted principal rather than a forgeable body field.
    if (by === ar.requestedBy) {
      return { status: 403, body: { error: 'Segregation of duties: the requester cannot decide their own approval request' } };
    }
    // SoD, SECOND RULE: no actor may decide TWO steps of the same chain.
    // The requester check above was the only SoD rule, and it says nothing about
    // a MULTI-STEP chain. `buildApprovalSteps` escalates anything above
    // APPROVAL_HIGH_VALUE_THRESHOLD to a sequential
    // ['delivery-executive', 'finance'] chain precisely so two different people
    // sign off — but `roleMatch` below is true for `admin` on EVERY step, so one
    // admin decided step 0, the chain advanced, and the same admin decided step 1.
    // A €120k invoice cleared by one person through a two-person control.
    // `admin` is deliberately NOT exempt: the exemption would restore the hole.
    const crossStepErr = crossStepSoDError(ar.steps, by);
    if (crossStepErr) return { status: 403, body: { error: crossStepErr } };
    const step = ar.steps[ar.currentStep];
    if (!step) return { status: 400, body: { error: 'No pending step to decide' } };
    // STEP ENFORCEMENT — D (design spec §3.4). Supersedes the gap-A role
    // fallback: an actor holding the step's role no longer decides for ANYONE.
    // An actor may decide when ANY of these holds:
    //   1. they are the step's named approver (`step.approverId`, a RESOURCE id
    //      — that is how `allocationApproverStep` routes an allocation);
    //   2. they are an ACCOUNTABLE MANAGER of the target resource — in its
    //      transitive org chart, or the manager of a node above it
    //      (`accountableApproversOf(...).managerIds`). This stands ON ITS OWN,
    //      independent of the actor's global role;
    //   3. they hold the step's role AND the target resource is in their scope;
    //   4. they hold the step's role AND the target has no accountable manager
    //      ANYWHERE (`accountableApproversOf(...).roleFallback`) — the last resort;
    //   5. their role is 'admin'.
    //
    // WHY RULE 2 IS ITS OWN ALLOW (review round 4, critical #1). D deliberately
    // adds NO new RBAC role, because authority over a set of resources is
    // RELATIVE while every role here is GLOBAL: the design's whole claim is that
    // "the node's manager IS the Capability Leader / Practice Manager /
    // Competence Manager". Subordinating that grant to `roleMatch` made it
    // INERT — a node manager could only decide if their global role happened to
    // be 'resource-manager' — while its mere presence in the set still set
    // `roleFallback` false. The shipped seed was the exhibit: node '2'
    // (Engineering) is managed by resource '1' (Julie, a delivery-executive),
    // and the Engineering dummy '4' has no personal manager, so John (the only
    // seeded resource-manager) got the SCOPE 403, Julie — the actual Capability
    // Leader — got the ROLE 403, and only an admin could clear the month.
    // Authority now comes from the structure, as the design says.
    //
    // This is SAFE because it is not the only gate: `roleGate` has already
    // admitted this request (`/approval-requests` mutations are limited to
    // pm/resource-manager/delivery-executive/finance/admin), so anyone reaching
    // here holds an approver-grade role — rule 2 decides WHICH resources, not
    // WHETHER. And segregation of duties sits ABOVE, untouched: an accountable
    // manager still cannot decide an approval they requested themselves (which
    // is exactly why `autoApprovesAllocation` exists).
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
    // 'resource-manager', so their ROLE grants them nothing here. `globalRole`
    // exempts them from scope, it does not grant them a step their role was
    // never routed to — they reach an allocation through the named-approver
    // path or through rule 2, i.e. by actually being accountable for the
    // resource, never by being a delivery-executive.
    //
    // Segregation of duties is enforced separately, ABOVE, and binds every role.
    // `canDecideFor` in the approvals modal and `scopeAllows` in the Approvals
    // Inbox mirror this rule.
    //
    // LOCKING: the two list reads below take NO lock. They are reads, and this
    // runs inside the caller's approval/month command — acquiring `org-chart` or
    // `org-tree` here would create an `approval:` -> `org-*` order that no other
    // call site uses (see the lock-order notes on `PUT /resources/:id` and
    // `ORG_TREE_LOCK`) and is exactly how a deadlock gets introduced. It also
    // means those two writers are never held off by a decision, which is the
    // right trade for a read that only informs an authorization answer.
    // ASKED OF THE WHOLE SET, not the collapsed display role: an approver who
    // holds the step's role AND a higher-ranked one was refused the step routed to
    // them, and `crossStepSoDError` had already barred the admin who cleared the
    // previous step — so a high-value chain could reach a state no one could
    // legally clear. Same reasoning for `globalRole`: holding a global role must
    // not depend on it outranking every other role the principal carries.
    const roleMatch = stepRoleMatch(decidingRoles, step.role);
    const managerMatch = step.approverId !== undefined && deciderResourceId === step.approverId;
    const globalRole = hasGlobalApprovalRole(decidingRoles);
    let scopeMatch = roleMatch;
    // Rule 2 — accountable-manager, role-independent (see above).
    let accountableMatch = false;
    const targetResourceId = await allocationTargetResourceId(ar, repositorySet);
    // The scope lookup is skipped for an actor `roleMatch && globalRole` already
    // admits unconditionally (an `admin`, or a global role on a step routed to
    // it): nothing below could change the outcome, so it would be pure I/O.
    if (targetResourceId !== undefined && !(roleMatch && globalRole)) {
      const target = await repositorySet.resources.get(targetResourceId);
      if (target !== undefined) {
        const [resources, nodes] = await Promise.all([
          repositorySet.resources.list(),
          repositorySet.resourceOrganizations.list(),
        ]);
        const { managerIds, roleFallback } = accountableApproversOf(target, resources, nodes, todayIso());
        accountableMatch = deciderResourceId !== undefined && managerIds.has(deciderResourceId);
        if (roleMatch) scopeMatch = roleFallback || accountableMatch;
      }
    }
    if (!scopeMatch && !managerMatch && !accountableMatch) {
      // TWO DISTINCT REFUSALS, worded apart on purpose. Reaching here with
      // `roleMatch` true can only be the SCOPE branch above (`scopeMatch` starts
      // as `roleMatch` and only that branch lowers it), and for that actor the
      // role/step wording would be a lie: they DO hold the step's role, and were
      // refused because the resource is not theirs to decide. A 403 that
      // misdescribes its own reason costs the next person an afternoon. The
      // other message therefore covers everyone whose ROLE was never routed
      // here and who is not accountable for the resource either — which is the
      // same population it covered before rule 2 existed.
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
    const updated = await repositorySet.approvalRequests.update(ar.id, ar as ApprovalRequest);
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
}

async function decideOneApproval(
  req: Request,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  note: string | undefined,
  ctx: DeciderContext,
): Promise<DecisionOutcome> {
  return withLock(`approval:${approvalId}`, () => decideOneApprovalInRepositories(
    req,
    approvalId,
    decision,
    note,
    ctx,
    repos,
  ));
}

/**
 * Apply an Allocation decision to the governed entity. `refId` carries the
 * shape: a composite `<assignmentId>:<YYYY-MM>` targets ONE month row (B3);
 * a bare assignment id is a LEGACY gap-A approval opened before B3 and still
 * pending — applied to the assignment AND to every non-Draft month row a
 * migrated database backfilled under it, so nothing in flight is orphaned (see
 * the branch's own comment for why the assignment write alone was a no-op).
 *
 * Called after the governing approval/month command has committed (or, for a
 * legacy bare ref, after `approval:<id>` is released), under the fixed res -> req
 * lock order used by every other assignment mutation.
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
  committedMonth?: Pick<AllocationMonthDecisionCommit, 'before' | 'after'>,
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

  const row = committedMonth?.before ?? await repos.assignmentMonths.get(refId);
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
  const rowAfter = committedMonth?.after ?? await repos.assignmentMonths.update(row.id, {
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

/**
 * B3 decision path: approval-engine mutation + month transition share the same
 * per-month command, PostgreSQL transaction and approvalId CAS. Auditing,
 * substitution give-back and aggregates remain post-commit best-effort effects.
 */
async function decideVersionedAllocationMonth(
  req: Request,
  monthId: string,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  note: string | undefined,
  ctx: DeciderContext,
  deferAggregates = false,
): Promise<{
  outcome: DecisionOutcome;
  touched?: { resourceId: string; requestId: string; assignmentId: string };
}> {
  const atomic = await allocationLifecycle.run(monthId, transactionRepos =>
    decideCurrentAllocationMonth(
      transactionRepos,
      monthId,
      approvalId,
      decision,
      note,
      () => decideOneApprovalInRepositories(
        req,
        approvalId,
        decision,
        note,
        ctx,
        transactionRepos,
      ),
    ));
  if (!atomic.commit) return { outcome: atomic.outcome };

  const touched = await applyAllocationDecision(
    req,
    monthId,
    decision,
    note,
    deferAggregates,
    atomic.commit,
  );
  return { outcome: atomic.outcome, touched };
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

  // The SET drives every authorization answer; `decidingRole` above is only the
  // 401 principal check.
  const ctx: DeciderContext = { by, decidingRoles: trustedRoles(req), deciderResourceId };
  const approval = await repos.approvalRequests.get(req.params.id);
  const monthRef = approval?.kind === 'Allocation' ? parseMonthRowId(approval.refId) : undefined;
  const result = monthRef
    ? (await decideVersionedAllocationMonth(
      req,
      approval!.refId,
      req.params.id,
      decision,
      body.note,
      ctx,
    )).outcome
    : await decideOneApproval(req, req.params.id, decision, body.note, ctx);

  // LEGACY bare-assignment Allocation effect: applied AFTER `approval:<id>` has
  // been released. B3 month effects were already paired atomically above.
  // Executes at most once per
  // decision: `ar.status` starts 'Pending' and `decideOneApproval` only ever
  // sets it to 'Approved'/'Rejected' once (a retried decision 400s on the
  // `ar.status !== 'Pending'` guard, so `result.allocation` is undefined then).
  // Same note the step recorded; no deferral — a single decision has exactly
  // one resource/request to recompute.
  if (monthRef === undefined && result.status === 200 && result.allocation) {
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

  const ctx: DeciderContext = {
    by: actorId(req),
    decidingRoles: trustedRoles(req),
    deciderResourceId: await actorResourceId(req),
  };
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

        const versioned = await decideVersionedAllocationMonth(
          req,
          id,
          row.approvalId,
          decision,
          note,
          ctx,
          true,
        );
        if (versioned.outcome.status !== 200) {
          const message = (versioned.outcome.body as { error?: string } | undefined)?.error
            ?? `decision failed (${versioned.outcome.status})`;
          results.push({ assignmentMonthId: id, status: 'Error', error: message });
          continue;
        }
        if (versioned.touched) {
          touchedAssignments.add(versioned.touched.assignmentId);
          touchedResources.add(versioned.touched.resourceId);
          touchedRequests.add(versioned.touched.requestId);
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
  provider: persistenceConfig.adapter,
  persistent: persistenceConfig.adapter === 'postgresql',
  // Header-trust is on ONLY in local/dev. When true, the SPA may bootstrap a demo
  // admin identity (without a running Keycloak) so the in-memory app is fully
  // usable for testing. In production this is false → the SPA stays anonymous and
  // the server still ignores any client-set role header.
  demoMode: trustHeaders,
  oidcIssuer: OIDC_PUBLIC_ISSUER,
  oidcClientId: OIDC_CLIENT_ID,
}));

// --- Integrations (local-artifact adapters: implemented, NOT connected) ------
//
// Every adapter is a pure builder producing a downloadable artifact from the
// repository data. No network calls, no credentials, no vendor SDKs — the
// descriptors advertise `connected: false` / `mode: 'local-artifact'`.
// RBAC: '/integrations' is gated (reads AND mutations) to
// finance/delivery-executive/admin via READ_RULES + the mutation rules above.

/**
 * Assemble the full FinanceData snapshot from the repositories.
 *
 * `contracts` was already part of this envelope (customerProfitability /
 * arAgingByCustomer walk project -> contract -> customer via it). Negotiated
 * sell rates (design spec §4/§6) are new: one `repos.negotiatedRates.list()`
 * call here, shared by every consumer of this snapshot — the as-incurred
 * branch of recognitionSchedule then resolves per-entry via sellRateFor, never
 * issuing its own per-row query.
 *
 * `hoursPerDay` travels WITH those rates and is not optional in practice: a
 * negotiated rate is stored in EUR/DAY while every other rate in the envelope is
 * EUR/HOUR, so this is the divisor `sellRateFor` converts with. Omitting it does
 * not fail loudly — it silently prices at the default 8h day — which is exactly
 * why it is fetched here, next to the rates it belongs to.
 *
 * KNOWN, ADJUDICATED INCONSISTENCY (recorded, deliberately NOT fixed here).
 * `resources` below is `repos.resources.list()` — the RAW rows, whose `billRate`
 * is the per-resource override in EUR per DAY. The client surfaces instead read
 * `/api/resources`, which resolves it to EUR per HOUR via `withEffectiveRates`.
 * So in THIS envelope only, the `referenceBillRate` fallback of `sellRateFor` is
 * fed a €/day value, and the as-incurred figures in the GL/BI exports overstate
 * un-negotiated T&M by a factor of hoursPerDay. That predates negotiated rates
 * (the pre-feature code multiplied the same raw column by hours) and switching it
 * to `resolveResourceRates` moves every exported artifact's numbers, so it was
 * ruled its own change — see the 2026-08-04 user decision 2 in the SDD ledger.
 * The NEGOTIATED path here is correct: it converts with `hoursPerDay`.
 */
async function loadFinanceData(): Promise<FinanceData> {
  const [
    requests, assignments, resources, orders, orderLines, financials,
    timeEntries, billingItems, contracts, customers, milestones,
    changeRequests, projects, fxRates, negotiatedRates, hoursPerDay,
  ] = await Promise.all([
    repos.requests.list(), repos.assignments.list(), repos.resources.list(),
    repos.orders.list(), repos.orderLines.list(), repos.projectFinancials.list(),
    repos.timeEntries.list(), repos.billingPlanItems.list(), repos.contracts.list(),
    repos.customers.list(), repos.milestones.list(), repos.changeRequests.list(),
    repos.projects.list(), repos.fxRates.list(), repos.negotiatedRates.list(),
    getHoursPerDay(),
  ]);
  return {
    requests, assignments, resources, orders, orderLines, financials,
    timeEntries, billingItems, contracts, customers, milestones,
    changeRequests, projects, fxRates, negotiatedRates, hoursPerDay,
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
  const customerCountryCode = customer.country
    ? (await repos.countries.list()).find(country => country.name === customer.country || country.code === customer.country)?.code
    : undefined;
  try {
    const artifact = getIntegrations().einvoice.buildInvoiceXml({
      order, customer, customerCountryCode, contract, lines, supplier: supplierFromEnv(),
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
  // The adapter is pure and never assigns ids; this ephemeral persistence layer
  // assigns the same process-independent UUID form used by stored entities.
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

await initPersistence();

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
 *
 * The 409 BODY is chosen by verb (`referentialViolationMessage`): the same SQLSTATE
 * is raised by a CREATE whose reference does not exist, where "Cannot delete: the
 * record is still referenced by other records" describes the opposite situation and
 * sent developers looking for a cascade that was never involved.
 *
 * A not-null violation (23502) is mapped too, as a 400: it is a bad request body,
 * and it used to surface as an opaque 500 on the Pg adapter while the same request
 * returned 200 in memory.
 */
apiRouter.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) { next(err); return; }
  if (isFkViolation(err)) {
    res.status(409).json({ error: referentialViolationMessage(req.method) });
    return;
  }
  if (isNotNullViolation(err)) {
    res.status(400).json({ error: 'A required field was missing or null' });
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
