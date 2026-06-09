import { AngularNodeAppEngine, isMainModule, writeResponseToNodeResponse, createNodeRequestHandler } from '@angular/ssr/node';
import express, { Request, Response, NextFunction, Router } from 'express';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

const serverDistFolder = dirname(fileURLToPath(import.meta.url));
const browserDistFolder = resolve(serverDistFolder, '../browser');

const app = express();
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

/** S6: minimal in-memory fixed-window rate limiter (no external dependency). */
function rateLimit(maxPerWindow: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  let lastSweep = 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || 'unknown';
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
 * AUDIT INTEGRITY: the audit log is APPEND-ONLY. Entries are only ever
 * prepended (newest-first) and capped; existing entries are never edited.
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
const AUDIT_LOG_CAP = 2000;
const auditLogStore = { items: [] as AuditEntry[] };

/**
 * Registry mapping a collection segment (e.g. 'orders') to a getter for its
 * backing array, used by the audit middleware to snapshot an entity
 * before/after a mutation. Getters (not array references) are stored so that
 * collections reassigned via `let` (projects, languages, ...) always resolve
 * to the live binding. Populated by registerAuditStores() once stores exist.
 */
const auditStores = new Map<string, () => readonly { id: string }[]>();

/** Find the current entity targeted by a `/collection/:id` request path. */
function findAuditEntity(path: string): { id: string } | undefined {
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  const getItems = auditStores.get(segments[0]);
  if (!getItems) return undefined;
  const id = segments[1];
  return getItems().find(x => x.id === id);
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
type TimeEntryStatus = 'Draft' | 'Submitted' | 'Approved' | 'Rejected';
const actorId = (req: Request) => String(req.header('X-User-Id') || 'system');
const actorRole = (req: Request) => String(req.header('X-User-Role') || 'unknown') as UserRole | 'unknown';

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
 * As a defence-in-depth guard, `trustHeaders` below restricts header trust to
 * loopback binds (localhost/127.0.0.1) unless explicitly opted in via
 * AUTH_TRUST_HEADERS=true. When headers are NOT trusted, every actor is
 * treated as role 'unknown', so privileged mutations are denied (403).
 */
const bindHost = (process.env['HOST'] || 'localhost').trim();
const isLoopbackHost = ['localhost', '127.0.0.1', '::1'].includes(bindHost);
const trustHeaders = isLoopbackHost || process.env['AUTH_TRUST_HEADERS'] === 'true';

/** Server-trusted role for the request. Falls back to 'unknown' when client headers are not trusted. */
const trustedRole = (req: Request): UserRole | 'unknown' => (trustHeaders ? actorRole(req) : 'unknown');

const canMutate = (role: UserRole | 'unknown', allowed: UserRole[]) => allowed.includes(role as UserRole);

function roleGate(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) {
    next();
    return;
  }

  const path = req.path;
  const role = trustedRole(req);
  const rules: { test: (path: string) => boolean; roles: UserRole[] }[] = [
    { test: p => ['/customers', '/contracts', '/orders', '/order-lines', '/billing-plan-items'].some(prefix => p.startsWith(prefix)), roles: ['sales', 'finance', 'delivery-executive', 'admin'] },
    { test: p => ['/project-financials', '/project-cost-centers', '/cost-centers'].some(prefix => p.startsWith(prefix)), roles: ['finance', 'delivery-executive', 'admin'] },
    { test: p => ['/assignments', '/requests'].some(prefix => p.startsWith(prefix)), roles: ['pm', 'resource-manager', 'delivery-executive', 'admin'] },
    { test: p => ['/projects', '/work-packages', '/milestones', '/project-tasks', '/project-issues', '/change-requests'].some(prefix => p.startsWith(prefix)), roles: ['pm', 'delivery-executive', 'admin'] },
    { test: p => ['/skill-catalogs', '/proficiency-sets', '/skills', '/project-roles', '/resource-organizations', '/languages'].some(prefix => p.startsWith(prefix)), roles: ['admin', 'delivery-executive'] },
    { test: p => p.startsWith('/approval-requests'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
  ];

  const rule = rules.find(r => r.test(path));
  if (rule && !canMutate(role, rule.roles)) {
    res.status(403).json({ error: `Role ${role} cannot modify ${path}` });
    return;
  }
  next();
}

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

/** Generic hardened CRUD for a simple keyed-collection resource. */
function crud<T extends { id: string }>(
  router: Router,
  path: string,
  store: { items: T[] },
  allowed: readonly string[],
  numericFields: readonly string[] = [],
) {
  router.get(`/${path}`, (_req, res) => res.json(store.items));
  router.post(`/${path}`, (req, res) => {
    const data = pick(req.body, allowed);
    const bad = findInvalidNumericField(data, numericFields);
    if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
    const item = { id: newId(), ...data } as T;
    store.items.push(item);
    res.json(item);
  });
  router.put(`/${path}/:id`, (req, res) => {
    const i = store.items.findIndex(x => x.id === req.params.id);
    if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
    const data = pick(req.body, allowed);
    const bad = findInvalidNumericField(data, numericFields);
    if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
    store.items[i] = { ...store.items[i], ...data };
    res.json(store.items[i]);
  });
  router.delete(`/${path}/:id`, (req, res) => {
    store.items = store.items.filter(x => x.id !== req.params.id);
    res.status(204).send();
  });
}

// --- API Routes -------------------------------------------------------------
const apiRouter = express.Router();
apiRouter.use(rateLimit(300, 60_000)); // 300 req/min per client
apiRouter.use(roleGate);
apiRouter.use((req, res, next) => {
  // AUDIT INTEGRITY: snapshot the targeted entity BEFORE the handler runs so a
  // PUT/DELETE can record a before/after diff. POST has no prior state.
  const before = ['PUT', 'DELETE'].includes(req.method) ? cloneEntity(findAuditEntity(req.path)) : undefined;
  res.on('finish', () => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method) || res.statusCode >= 400) return;
    const entry: AuditEntry = {
      id: `AL${newId()}`,
      at: new Date().toISOString(),
      actorId: actorId(req),
      actorRole: actorRole(req),
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
    };
    if (req.method === 'PUT' || req.method === 'DELETE') {
      // DELETE has no after-state; re-resolve the entity for PUT.
      const after = req.method === 'DELETE' ? undefined : cloneEntity(findAuditEntity(req.path));
      const changedKeys = diffChangedKeys(before, after);
      entry.before = before;
      entry.after = after;
      entry.changedKeys = changedKeys;
    }
    // APPEND-ONLY: only ever prepend (newest-first) and cap; never edit prior entries.
    auditLogStore.items.unshift(entry);
    auditLogStore.items = auditLogStore.items.slice(0, AUDIT_LOG_CAP);
    saveState();
  });
  next();
});

const resources = [
  { id: '1', name: 'Julie Armstrong', role: 'Developer',
    skills: [{ name: 'Java', level: 3 }, { name: 'Spring', level: 2 }],
    projectRoles: ['Senior Developer', 'Backend Engineer'],
    externalExperience: [{ projectName: 'E-commerce Migration', company: 'TechCorp', role: 'Java Developer', startDate: '2020-01-01', endDate: '2022-12-31', comment: 'Migrated legacy system to Spring Boot.' }],
    profilePicture: '', resume: '', utilization: 85, capacity: 40, managerId: '1', organization: 'Engineering', location: 'New York, NY', costRate: 75, billRate: 140 },
  { id: '2', name: 'John Miller', role: 'Consultant',
    skills: [{ name: 'Project Management', level: 2 }], projectRoles: ['Business Consultant'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 100, capacity: 40, managerId: '1', organization: 'Consulting', location: 'London, UK', costRate: 90, billRate: 180 },
  { id: '3', name: 'Alice Smith', role: 'Designer',
    skills: [{ name: 'Figma', level: 3 }], projectRoles: ['UX Designer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 50, capacity: 40, managerId: '2', organization: 'Design', location: 'Remote', costRate: 65, billRate: 120 },
];

const users = [
  { id: '1', resourceId: '1', name: 'Julie Armstrong', role: 'delivery-executive' },
  { id: '2', resourceId: '2', name: 'John Miller', role: 'resource-manager' },
  { id: '3', resourceId: '3', name: 'Alice Smith', role: 'pm' },
  { id: '4', resourceId: '2', name: 'Finance Controller', role: 'finance' },
  { id: '5', resourceId: '3', name: 'Sales Lead', role: 'sales' },
  { id: '6', resourceId: '1', name: 'System Admin', role: 'admin' },
] satisfies { id: string; resourceId: string; name: string; role: UserRole }[];

// B9: request '1' is fully staffed (staffedEffort >= requiredEffort) so its status must be 'Fulfilled'.
const requests = [
  { id: '1', name: 'Project Alpha - Backend', requiredRole: 'Developer', requiredEffort: 20, staffedEffort: 20, status: 'Fulfilled', skills: ['Java'], description: 'Backend development for Project Alpha', startDate: '2026-04-01', endDate: '2026-06-30', requesterId: '1', projectId: '1' },
  { id: '2', name: 'Project Beta - UI', requiredRole: 'Designer', requiredEffort: 15, staffedEffort: 0, status: 'Published', skills: ['Figma'], description: 'UI Design for Project Beta', startDate: '2026-05-01', endDate: '2026-07-31', requesterId: '1', projectId: '2' },
];

const assignments = [
  { id: '1', requestId: '1', resourceId: '1', assignedHours: 20, status: 'hard-booked' },
];

const timeEntryStore: { items: { id: string; assignmentId: string; requestId: string; resourceId: string; projectId: string; date: string; hours: number; status: TimeEntryStatus; notes?: string; approvedBy?: string; approvedAt?: string }[] } = { items: [
  { id: 'TE1', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-06', hours: 8, status: 'Approved', notes: 'Backend integration', approvedBy: '1', approvedAt: '2026-04-07T09:00:00.000Z' },
  { id: 'TE2', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-07', hours: 8, status: 'Approved', notes: 'API hardening', approvedBy: '1', approvedAt: '2026-04-08T09:00:00.000Z' },
  { id: 'TE3', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-08', hours: 4, status: 'Submitted', notes: 'Defect fixing' },
] };

let languages = [
  { code: 'en', name: 'English', isDefault: true },
  { code: 'de', name: 'German', isDefault: false },
  { code: 'es', name: 'Spanish', isDefault: false },
  { code: 'fr', name: 'French', isDefault: false },
];

const skillCatalogs = [
  { id: '1', name: 'Development Skills', description: 'Skills related to software development', skills: ['1', '2'] },
];

const proficiencySets = [
  { id: '1', name: 'Standard IT Proficiency', description: 'Standard 1-5 level proficiency',
    levels: [
      { id: 'l1', level: 1, name: 'Beginner', description: 'Basic knowledge' },
      { id: 'l2', level: 2, name: 'Intermediate', description: 'Practical application' },
      { id: 'l3', level: 3, name: 'Advanced', description: 'Applied theory' },
      { id: 'l4', level: 4, name: 'Expert', description: 'Recognized authority' },
    ] },
];

const skills = [
  { id: '1', conceptUri: 'sap-rm://skill/1', name: 'Java', description: 'Java programming', catalogs: ['1'], proficiencySetId: '1', restricted: false },
  { id: '2', conceptUri: 'sap-rm://skill/2', name: 'JavaScript', description: 'JS programming', catalogs: ['1'], proficiencySetId: '1', restricted: false },
];

const projectRoles = [
  { id: '1', code: 'DEV', name: 'Developer', description: 'Software Developer', restricted: false },
  { id: '2', code: 'PM', name: 'Project Manager', description: 'Project Manager', restricted: false },
];

const serviceOrganizations = [
  { id: '1', code: 'SO_DE', description: 'Service Org Germany', costCenters: ['CC_DE_1', 'CC_DE_2'] },
];

let resourceOrganizations = [
  { id: '1', name: 'Res Org Germany', description: 'Resource Org for Germany', costCenters: ['CC_DE_1', 'CC_DE_2'], serviceOrganizationId: '1' },
];

let projects = [
  { id: '1', name: 'Project Alpha', location: 'Berlin, Germany', startDate: '2026-04-01', endDate: '2026-12-31', status: 'In Planning', description: 'A major software development project.', ownerId: '1', contractId: 'CT1' },
  { id: '2', name: 'Project Beta', location: 'Munich, Germany', startDate: '2026-05-01', endDate: '2027-05-01', status: 'In Execution', description: 'Infrastructure upgrade project.', ownerId: '1', contractId: 'CT2' },
];

// --- Core resources (custom logic, hardened) --------------------------------

const RESOURCE_FIELDS = ['name', 'role', 'skills', 'projectRoles', 'externalExperience', 'profilePicture', 'resume', 'capacity', 'managerId', 'organization', 'location', 'costRate', 'billRate'] as const;

apiRouter.get('/resources', (_req, res) => res.json(resources));
apiRouter.get('/users', (_req, res) => res.json(users));
apiRouter.get('/resources/:id', (req, res) => {
  const resource = resources.find(r => r.id === req.params.id);
  return resource ? res.json(resource) : res.status(404).json({ error: 'Not found' });
});
apiRouter.put('/resources/:id', (req, res) => {
  const index = resources.findIndex(r => r.id === req.params.id);
  if (index === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<typeof resources[number]>(req.body, RESOURCE_FIELDS);
  // B-DATA: capacity is a divisor in utilization math; never allow 0/negative/NaN.
  if (body.capacity !== undefined && !(isNonNegNumber(body.capacity) && body.capacity > 0)) {
    res.status(400).json({ error: 'capacity must be a positive number' });
    return;
  }
  resources[index] = { ...resources[index], ...body };
  res.json(resources[index]);
});

const REQUEST_FIELDS = ['name', 'requiredRole', 'requiredEffort', 'skills', 'description', 'startDate', 'endDate', 'status', 'requesterId', 'projectId'] as const;

apiRouter.get('/requests', (_req, res) => res.json(requests));
apiRouter.post('/requests', (req, res) => {
  const body = pick<typeof requests[number]>(req.body, REQUEST_FIELDS);
  if (body.requiredEffort !== undefined && !isNonNegNumber(body.requiredEffort)) {
    { res.status(400).json({ error: 'requiredEffort must be a non-negative number' }); return; }
  }
  const newReq = { id: newId(), staffedEffort: 0, ...body, status: 'Not Published' } as typeof requests[number];
  requests.push(newReq);
  res.json(newReq);
});
// B-DATA: client-settable request statuses are limited to the publish/withdraw
// lifecycle. 'Fulfilled' is server-derived from assignment staffing and must
// never be supplied by the client.
const CLIENT_REQUEST_STATUSES = ['Not Published', 'Published', 'Open', 'Withdrawn'] as const;
apiRouter.put('/requests/:id', (req, res) => {
  const index = requests.findIndex(r => r.id === req.params.id);
  if (index === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<typeof requests[number]>(req.body, REQUEST_FIELDS);
  if (body.requiredEffort !== undefined && !isNonNegNumber(body.requiredEffort)) {
    { res.status(400).json({ error: 'requiredEffort must be a non-negative number' }); return; }
  }
  if (body.status !== undefined && !(CLIENT_REQUEST_STATUSES as readonly string[]).includes(body.status)) {
    res.status(400).json({ error: `status must be one of: ${CLIENT_REQUEST_STATUSES.join(', ')}` });
    return;
  }
  requests[index] = { ...requests[index], ...body };
  res.json(requests[index]);
});
apiRouter.delete('/requests/:id', (req, res) => {
  const index = requests.findIndex(r => r.id === req.params.id);
  if (index === -1) { res.status(404).json({ error: 'Not found' }); return; }
  requests.splice(index, 1);
  res.status(204).send();
});

apiRouter.get('/assignments', (_req, res) => res.json(assignments));
apiRouter.post('/assignments', (req, res) => {
  const body = pick<typeof assignments[number]>(req.body, ['requestId', 'resourceId', 'assignedHours', 'status']);
  if (!isNonNegNumber(body.assignedHours)) {
    { res.status(400).json({ error: 'assignedHours must be a non-negative number' }); return; }
  }
  // B-DATA: an assignment must reference an existing request and resource.
  if (!exists(requests, body.requestId)) { res.status(400).json({ error: 'requestId must reference an existing request' }); return; }
  if (!exists(resources, body.resourceId)) { res.status(400).json({ error: 'resourceId must reference an existing resource' }); return; }
  const newAssig = { id: newId(), ...body } as typeof assignments[number];
  assignments.push(newAssig);

  const resource = resources.find(r => r.id === newAssig.resourceId);
  // B-DATA: capacity is a divisor; skip the utilization recompute when it is not usable.
  if (resource && resource.capacity > 0) resource.utilization = clampUtil(resource.utilization + (newAssig.assignedHours / resource.capacity) * 100);

  const request = requests.find(r => r.id === newAssig.requestId);
  if (request) {
    request.staffedEffort += newAssig.assignedHours;
    if (request.staffedEffort >= request.requiredEffort) request.status = 'Fulfilled';
  }
  res.json(newAssig);
});
apiRouter.put('/assignments/:id', (req, res) => {
  const index = assignments.findIndex(a => a.id === req.params.id);
  if (index === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<typeof assignments[number]>(req.body, ['requestId', 'resourceId', 'assignedHours', 'status']);
  if (body.assignedHours !== undefined && !isNonNegNumber(body.assignedHours)) {
    { res.status(400).json({ error: 'assignedHours must be a non-negative number' }); return; }
  }
  const oldAssig = assignments[index];
  // B-DATA: when the FK targets change, the new targets must exist.
  if (body.resourceId !== undefined && body.resourceId !== oldAssig.resourceId && !exists(resources, body.resourceId)) {
    res.status(400).json({ error: 'resourceId must reference an existing resource' });
    return;
  }
  if (body.requestId !== undefined && body.requestId !== oldAssig.requestId && !exists(requests, body.requestId)) {
    res.status(400).json({ error: 'requestId must reference an existing request' });
    return;
  }
  const newAssig = { ...oldAssig, ...body };
  assignments[index] = newAssig;

  const resource = resources.find(r => r.id === newAssig.resourceId);
  // B-DATA: capacity is a divisor; skip the utilization recompute when it is not usable.
  if (resource && resource.capacity > 0) resource.utilization = clampUtil(resource.utilization + ((newAssig.assignedHours - oldAssig.assignedHours) / resource.capacity) * 100);

  const request = requests.find(r => r.id === newAssig.requestId);
  if (request) {
    request.staffedEffort += (newAssig.assignedHours - oldAssig.assignedHours);
    if (request.staffedEffort >= request.requiredEffort) request.status = 'Fulfilled';
    else if (request.status === 'Fulfilled') request.status = 'Open';
  }
  res.json(newAssig);
});
apiRouter.delete('/assignments/:id', (req, res) => {
  const index = assignments.findIndex(a => a.id === req.params.id);
  if (index === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const oldAssig = assignments[index];
  assignments.splice(index, 1);

  const resource = resources.find(r => r.id === oldAssig.resourceId);
  // B-DATA: capacity is a divisor; skip the utilization recompute when it is not usable.
  if (resource && resource.capacity > 0) resource.utilization = clampUtil(resource.utilization - (oldAssig.assignedHours / resource.capacity) * 100);

  const request = requests.find(r => r.id === oldAssig.requestId);
  if (request) {
    request.staffedEffort -= oldAssig.assignedHours;
    if (request.status === 'Fulfilled' && request.staffedEffort < request.requiredEffort) request.status = 'Open';
  }
  res.status(204).send();
});

apiRouter.get('/time-entries', (_req, res) => res.json(timeEntryStore.items));
apiRouter.post('/time-entries', (req, res) => {
  const body = pick<typeof timeEntryStore.items[number]>(req.body, ['assignmentId', 'requestId', 'resourceId', 'projectId', 'date', 'hours', 'status', 'notes']);
  if (!isNonNegNumber(body.hours)) {
    res.status(400).json({ error: 'hours must be a non-negative number' });
    return;
  }
  const reqRef = requests.find(r => r.id === body.requestId);
  const item = {
    id: `TE${newId()}`,
    status: 'Draft',
    ...body,
    projectId: body.projectId || reqRef?.projectId || '',
  } as typeof timeEntryStore.items[number];
  timeEntryStore.items.push(item);
  res.json(item);
});
apiRouter.put('/time-entries/:id', (req, res) => {
  const i = timeEntryStore.items.findIndex(t => t.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<typeof timeEntryStore.items[number]>(req.body, ['assignmentId', 'requestId', 'resourceId', 'projectId', 'date', 'hours', 'status', 'notes', 'approvedBy', 'approvedAt']);
  if (body.hours !== undefined && !isNonNegNumber(body.hours)) {
    res.status(400).json({ error: 'hours must be a non-negative number' });
    return;
  }
  if (body.status === 'Approved') {
    body.approvedBy = body.approvedBy || actorId(req);
    body.approvedAt = body.approvedAt || new Date().toISOString();
  }
  timeEntryStore.items[i] = { ...timeEntryStore.items[i], ...body };
  res.json(timeEntryStore.items[i]);
});
apiRouter.delete('/time-entries/:id', (req, res) => {
  timeEntryStore.items = timeEntryStore.items.filter(t => t.id !== req.params.id);
  res.status(204).send();
});

// --- Configuration ----------------------------------------------------------

apiRouter.get('/languages', (_req, res) => res.json(languages));
apiRouter.post('/languages/default', (req, res) => {
  const code = pick<{ code: string }>(req.body, ['code']).code;
  // B-DATA: only an existing language code may become the default.
  if (typeof code !== 'string' || !languages.some(l => l.code === code)) {
    res.status(400).json({ error: 'code must reference an existing language' });
    return;
  }
  languages = languages.map(l => ({ ...l, isDefault: l.code === code }));
  res.status(204).send();
});

const skillCatalogStore = { items: skillCatalogs };
apiRouter.get('/skill-catalogs', (_req, res) => res.json(skillCatalogStore.items));
apiRouter.post('/skill-catalogs', (req, res) => {
  const item = { id: newId(), skills: [], ...pick(req.body, ['name', 'description', 'skills']) } as typeof skillCatalogs[number];
  skillCatalogStore.items.push(item);
  res.json(item);
});
apiRouter.put('/skill-catalogs/:id', (req, res) => {
  const i = skillCatalogStore.items.findIndex(c => c.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  skillCatalogStore.items[i] = { ...skillCatalogStore.items[i], ...pick(req.body, ['name', 'description', 'skills']) };
  res.json(skillCatalogStore.items[i]);
});
apiRouter.delete('/skill-catalogs/:id', (req, res) => { skillCatalogStore.items = skillCatalogStore.items.filter(c => c.id !== req.params.id); res.status(204).send(); });

const proficiencyStore = { items: proficiencySets };
apiRouter.get('/proficiency-sets', (_req, res) => res.json(proficiencyStore.items));
apiRouter.post('/proficiency-sets', (req, res) => {
  const item = { id: newId(), levels: [], ...pick(req.body, ['name', 'description', 'levels']) } as typeof proficiencySets[number];
  proficiencyStore.items.push(item);
  res.json(item);
});
apiRouter.delete('/proficiency-sets/:id', (req, res) => { proficiencyStore.items = proficiencyStore.items.filter(s => s.id !== req.params.id); res.status(204).send(); });

const skillStore = { items: skills };
apiRouter.get('/skills', (_req, res) => res.json(skillStore.items));
apiRouter.post('/skills', (req, res) => {
  const item = { id: newId(), conceptUri: `sap-rm://skill/${newId()}`, catalogs: [], restricted: false, ...pick(req.body, ['name', 'description', 'catalogs', 'proficiencySetId', 'restricted']) } as typeof skills[number];
  skillStore.items.push(item);
  res.json(item);
});
apiRouter.put('/skills/:id', (req, res) => {
  const i = skillStore.items.findIndex(s => s.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  skillStore.items[i] = { ...skillStore.items[i], ...pick(req.body, ['name', 'description', 'catalogs', 'proficiencySetId', 'restricted']) };
  res.json(skillStore.items[i]);
});
apiRouter.delete('/skills/:id', (req, res) => { skillStore.items = skillStore.items.filter(s => s.id !== req.params.id); res.status(204).send(); });

const roleStore = { items: projectRoles };
apiRouter.get('/project-roles', (_req, res) => res.json(roleStore.items));
apiRouter.post('/project-roles', (req, res) => {
  const item = { id: newId(), restricted: false, ...pick(req.body, ['code', 'name', 'description', 'restricted']) } as typeof projectRoles[number];
  roleStore.items.push(item);
  res.json(item);
});
apiRouter.put('/project-roles/:id', (req, res) => {
  const i = roleStore.items.findIndex(r => r.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  roleStore.items[i] = { ...roleStore.items[i], ...pick(req.body, ['code', 'name', 'description', 'restricted']) };
  res.json(roleStore.items[i]);
});

apiRouter.get('/service-organizations', (_req, res) => res.json(serviceOrganizations));

apiRouter.get('/resource-organizations', (_req, res) => res.json(resourceOrganizations));
apiRouter.post('/resource-organizations', (req, res) => {
  const item = { id: newId(), costCenters: [], ...pick(req.body, ['name', 'description', 'costCenters', 'serviceOrganizationId']) } as typeof resourceOrganizations[number];
  resourceOrganizations.push(item);
  res.json(item);
});
apiRouter.put('/resource-organizations/:id', (req, res) => {
  const i = resourceOrganizations.findIndex(o => o.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  resourceOrganizations[i] = { ...resourceOrganizations[i], ...pick(req.body, ['name', 'description', 'costCenters', 'serviceOrganizationId']) };
  res.json(resourceOrganizations[i]);
});
apiRouter.delete('/resource-organizations/:id', (req, res) => { resourceOrganizations = resourceOrganizations.filter(o => o.id !== req.params.id); res.status(204).send(); });

const PROJECT_FIELDS = ['name', 'location', 'startDate', 'endDate', 'status', 'description', 'ownerId', 'contractId'] as const;
apiRouter.get('/projects', (_req, res) => res.json(projects));
apiRouter.post('/projects', (req, res) => {
  const item = { id: newId(), ...pick(req.body, PROJECT_FIELDS) } as typeof projects[number];
  projects.push(item);
  res.json(item);
});
apiRouter.put('/projects/:id', (req, res) => {
  const i = projects.findIndex(p => p.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  projects[i] = { ...projects[i], ...pick(req.body, PROJECT_FIELDS) };
  res.json(projects[i]);
});
apiRouter.delete('/projects/:id', (req, res) => { projects = projects.filter(p => p.id !== req.params.id); res.status(204).send(); });

// --- B1: project sub-resources (real endpoints, seeded on REAL ids 1/2) -----

const partnerStore = { items: [
  { id: 'PT1', projectId: '1', company: 'TechCorp Inc.', role: 'Development Partner', contact: 'Jane Doe', status: 'Active' },
  { id: 'PT2', projectId: '2', company: 'DesignStudio LLC', role: 'UI/UX Design', contact: 'John Smith', status: 'Invited' },
] };
crud(apiRouter, 'project-partners', partnerStore, ['projectId', 'company', 'role', 'contact', 'status']);

const documentStore = { items: [
  { id: 'D1', projectId: '1', name: 'Project_Charter_v1.pdf', type: 'pdf', size: '2.4 MB', uploadedAt: '2 days ago', author: 'Jane Doe', authorInitials: 'JD' },
  { id: 'D2', projectId: '2', name: 'Requirements_Spec.docx', type: 'word', size: '1.1 MB', uploadedAt: '5 days ago', author: 'John Smith', authorInitials: 'JS' },
] };
crud(apiRouter, 'project-documents', documentStore, ['projectId', 'name', 'type', 'size', 'uploadedAt', 'author', 'authorInitials']);

const workPackageStore = { items: [
  { id: 'WP-1.1', projectId: '1', name: 'Requirements Analysis', startDate: '2026-04-01', endDate: '2026-04-15', status: 'Completed', progress: 100, assignee: 'Alice Smith' },
  { id: 'WP-1.2', projectId: '1', name: 'System Architecture Design', startDate: '2026-04-16', endDate: '2026-05-05', status: 'In Progress', progress: 60, assignee: 'Julie Armstrong' },
  { id: 'WP-2.1', projectId: '2', name: 'Frontend Development', startDate: '2026-05-06', endDate: '2026-06-20', status: 'In Progress', progress: 40, assignee: 'Alice Smith' },
] };
crud(apiRouter, 'work-packages', workPackageStore, ['projectId', 'name', 'startDate', 'endDate', 'status', 'progress', 'assignee']);

interface MilestoneEntry { id: string; projectId: string; name: string; date: string; status: 'Pending' | 'Achieved'; approvedBy?: string; approvedAt?: string }
const milestoneStore = { items: [
  { id: 'M1', projectId: '1', name: 'Project Kickoff', date: '2026-04-01', status: 'Achieved' },
  { id: 'M2', projectId: '1', name: 'Go-Live', date: '2026-12-01', status: 'Pending' },
  { id: 'M3', projectId: '2', name: 'Architecture Approved', date: '2026-05-20', status: 'Pending' },
] as MilestoneEntry[] };
const MILESTONE_FIELDS = ['projectId', 'name', 'date', 'status', 'approvedBy', 'approvedAt'] as const;
apiRouter.get('/milestones', (_req, res) => res.json(milestoneStore.items));
apiRouter.post('/milestones', (req, res) => {
  const item = { id: newId(), ...pick<MilestoneEntry>(req.body, MILESTONE_FIELDS) } as MilestoneEntry;
  milestoneStore.items.push(item);
  res.json(item);
});
apiRouter.put('/milestones/:id', (req, res) => {
  const i = milestoneStore.items.findIndex(m => m.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const previousStatus = milestoneStore.items[i].status;
  const body = pick<MilestoneEntry>(req.body, MILESTONE_FIELDS);
  milestoneStore.items[i] = { ...milestoneStore.items[i], ...body };
  const updated = milestoneStore.items[i];
  // MILESTONE TRIGGER (SAL): when a milestone first transitions to 'Achieved',
  // make its fixed-price billing item billable by flipping every linked
  // BillingPlanItem still in 'Planned' to 'Ready'.
  if (updated.status === 'Achieved' && previousStatus !== 'Achieved') {
    for (const bp of billingPlanStore.items) {
      if (bp.milestoneId === updated.id && bp.status === 'Planned') bp.status = 'Ready';
    }
  }
  res.json(updated);
});
apiRouter.delete('/milestones/:id', (req, res) => {
  milestoneStore.items = milestoneStore.items.filter(m => m.id !== req.params.id);
  res.status(204).send();
});

const financialStore = { items: [
  { id: 'F1', projectId: '1', category: 'Software Licenses', budget: 20000, actual: 18500 },
  { id: 'F2', projectId: '1', category: 'Consulting Services', budget: 50000, actual: 25000 },
  { id: 'F3', projectId: '2', category: 'Hardware', budget: 10000, actual: 11200 },
] };
crud(apiRouter, 'project-financials', financialStore, ['projectId', 'category', 'budget', 'actual'], ['budget', 'actual']);

const projectCostCenterStore = { items: [
  { id: 'CC-1001', projectId: '1', name: 'Engineering & Dev', manager: 'Alice Smith', allocated: 150000, actual: 125000 },
  { id: 'CC-1002', projectId: '1', name: 'Design & UX', manager: 'Bob Jones', allocated: 50000, actual: 48000 },
  { id: 'CC-1003', projectId: '2', name: 'Quality Assurance', manager: 'Charlie Brown', allocated: 40000, actual: 42000 },
] };
crud(apiRouter, 'project-cost-centers', projectCostCenterStore, ['projectId', 'name', 'manager', 'allocated', 'actual'], ['allocated', 'actual']);

const taskStore = { items: [
  { id: 'T1', projectId: '1', name: 'Finalize Requirements Document', assignee: 'Jane Doe', assigneeType: 'Subcontractor', partnerId: 'PT1', dueDate: '2026-04-15', status: 'Done', priority: 'High' },
  { id: 'T2', projectId: '1', name: 'Design Database Schema', assignee: 'John Smith', assigneeType: 'Internal', partnerId: '', dueDate: '2026-04-25', status: 'In Progress', priority: 'Medium' },
  { id: 'T3', projectId: '2', name: 'Setup CI/CD Pipeline', assignee: 'Unassigned', assigneeType: 'Internal', partnerId: '', dueDate: '2026-05-05', status: 'To Do', priority: 'Medium' },
] };
crud(apiRouter, 'project-tasks', taskStore, ['projectId', 'name', 'assignee', 'assigneeType', 'partnerId', 'dueDate', 'status', 'priority']);

const issueStore = { items: [
  { id: 'I1', projectId: '1', title: 'API Rate Limiting', type: 'Bug', severity: 'High', status: 'Open', reportedBy: 'Jane Doe', owner: 'Julie Armstrong', dueDate: '2026-05-15', impact: 'May slow integration testing', actionPlan: 'Add rate-limit handling and retry policy', escalated: true },
  { id: 'I2', projectId: '1', title: 'Delay in Hardware Delivery', type: 'Risk', severity: 'Medium', status: 'Mitigated', reportedBy: 'John Smith', owner: 'John Miller', dueDate: '2026-05-20', impact: 'Potential schedule slippage', actionPlan: 'Use cloud test environment until hardware arrives', escalated: false },
  { id: 'I3', projectId: '2', title: 'UI Inconsistencies', type: 'Bug', severity: 'Low', status: 'Open', reportedBy: 'Alice Johnson', owner: 'Alice Smith', dueDate: '2026-06-01', impact: 'Client acceptance friction', actionPlan: 'Run design QA pass', escalated: false },
] };
crud(apiRouter, 'project-issues', issueStore, ['projectId', 'title', 'type', 'severity', 'status', 'reportedBy', 'owner', 'dueDate', 'impact', 'actionPlan', 'escalated']);

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
const changeRequestStore = { items: [
  { id: 'CR1', projectId: '1', title: 'Extend integration scope', description: 'Add one extra external API integration requested by the customer.', requestedBy: 'Julie Armstrong', owner: 'Alice Smith', status: 'Submitted', impactScope: 'Additional interface and test cycle', impactBudget: 12000, impactScheduleDays: 8, priority: 'High', createdAt: '2026-04-20T10:00:00.000Z' },
  { id: 'CR2', projectId: '2', title: 'Defer reporting automation', description: 'Move reporting automation to phase 2 to protect go-live.', requestedBy: 'John Miller', owner: 'Julie Armstrong', status: 'Approved', impactScope: 'Scope moved to later release', impactBudget: -5000, impactScheduleDays: -3, priority: 'Medium', createdAt: '2026-05-05T11:30:00.000Z', decidedBy: '1', decidedAt: '2026-05-06T09:00:00.000Z' },
] as ChangeRequestEntry[] };
// impactBudget/impactScheduleDays are intentionally allowed to be negative
// (a CR can reduce scope/budget), so they are NOT validated as non-negative.
const CHANGE_REQUEST_FIELDS = ['projectId', 'title', 'description', 'requestedBy', 'owner', 'status', 'impactScope', 'impactBudget', 'impactScheduleDays', 'priority', 'createdAt'] as const;
apiRouter.get('/change-requests', (_req, res) => res.json(changeRequestStore.items));
apiRouter.post('/change-requests', (req, res) => {
  const item = { id: newId(), createdAt: new Date().toISOString(), ...pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_FIELDS) } as ChangeRequestEntry;
  changeRequestStore.items.push(item);
  res.json(item);
});
apiRouter.put('/change-requests/:id', (req, res) => {
  const i = changeRequestStore.items.findIndex(c => c.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ChangeRequestEntry>(req.body, CHANGE_REQUEST_FIELDS);
  const merged = { ...changeRequestStore.items[i], ...body };
  // CR DECISION: when a CR reaches a terminal decision, stamp who/when (server
  // side, from the verified actor) if not already recorded. decidedBy/decidedAt
  // are not client-settable fields, so they cannot be forged via the body.
  if ((merged.status === 'Approved' || merged.status === 'Rejected') && !merged.decidedAt) {
    merged.decidedAt = new Date().toISOString();
    merged.decidedBy = merged.decidedBy || actorId(req);
  }
  changeRequestStore.items[i] = merged;
  res.json(changeRequestStore.items[i]);
});
apiRouter.delete('/change-requests/:id', (req, res) => {
  changeRequestStore.items = changeRequestStore.items.filter(c => c.id !== req.params.id);
  res.status(204).send();
});

// Configuration-level cost centers (B16)
const costCenterStore = { items: [
  { id: 'CC-9001', name: 'Corporate IT', manager: 'Dana White', allocated: 200000, actual: 150000 },
  { id: 'CC-9002', name: 'Shared Services', manager: 'Erik Stone', allocated: 80000, actual: 64000 },
] };
crud(apiRouter, 'cost-centers', costCenterStore, ['name', 'manager', 'allocated', 'actual'], ['allocated', 'actual']);

// --- Commercial domain (ADR-0001): Customers, Contracts, Orders, OrderLines ---

const customerStore = { items: [
  { id: 'C1', name: 'Globex Corp', industry: 'Manufacturing', country: 'Germany' },
  { id: 'C2', name: 'Initech', industry: 'Finance', country: 'United Kingdom' },
] };
crud(apiRouter, 'customers', customerStore, ['name', 'industry', 'country']);

interface ContractEntry { id: string; customerId: string; name: string; type: string; totalValue: number; currency: string; status: string; startDate: string; endDate: string }
const contractStore = { items: [
  { id: 'CT1', customerId: 'C1', name: 'Globex Digital Transformation', type: 'Fixed Price', totalValue: 500000, currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' },
  // MULTI-CURRENCY DEMO: CT2 (and its orders + billing items below) is denominated
  // in USD end-to-end, so portfolio rollups must convert via fx-rates before summing.
  { id: 'CT2', customerId: 'C2', name: 'Initech T&M Framework', type: 'T&M', totalValue: 300000, currency: 'USD', status: 'Active', startDate: '2026-03-01', endDate: '2027-02-28' },
] as ContractEntry[] };

interface OrderEntry { id: string; contractId: string; type: string; partnerId: string; amount: number; currency: string; status: string; orderDate: string; invoiceNumber?: string; invoiceDate?: string }
const orderStore = { items: [
  { id: 'O1', contractId: 'CT1', type: 'Customer', partnerId: '', amount: 200000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-02-01', invoiceNumber: 'INV-2026-0001', invoiceDate: '2026-02-01' },
  { id: 'O2', contractId: 'CT1', type: 'Purchase', partnerId: 'PT1', amount: 50000, currency: 'EUR', status: 'Confirmed', orderDate: '2026-02-15' },
  // MULTI-CURRENCY DEMO: O3 belongs to USD contract CT2, so it carries USD too.
  { id: 'O3', contractId: 'CT2', type: 'Customer', partnerId: '', amount: 120000, currency: 'USD', status: 'Open', orderDate: '2026-03-10' },
] as OrderEntry[] };

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
const orderLineStore = { items: [
  { id: 'OL1', orderId: 'O1', projectId: '1', description: 'Phase 1 delivery', amount: 200000 },
  { id: 'OL2', orderId: 'O2', projectId: '1', description: 'Subcontracted development', amount: 50000 },
  { id: 'OL3', orderId: 'O3', projectId: '2', description: 'UI/UX work package', amount: 120000 },
] as OrderLineEntry[] };

// --- Commercial referential integrity: explicit handlers (crud() cannot express FK rules) ---

const CONTRACT_FIELDS = ['customerId', 'name', 'type', 'totalValue', 'currency', 'status', 'startDate', 'endDate'] as const;
const exists = (items: { id: string }[], id: unknown): boolean =>
  typeof id === 'string' && id.length > 0 && items.some(x => x.id === id);

apiRouter.get('/contracts', (_req, res) => res.json(contractStore.items));
apiRouter.post('/contracts', (req, res) => {
  const body = pick<ContractEntry>(req.body, CONTRACT_FIELDS);
  if (!exists(customerStore.items, body.customerId)) { res.status(400).json({ error: 'customerId must reference an existing customer' }); return; }
  const bad = findInvalidNumericField(body, ['totalValue']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const item = { id: newId(), ...body } as ContractEntry;
  contractStore.items.push(item);
  res.json(item);
});
apiRouter.put('/contracts/:id', (req, res) => {
  const i = contractStore.items.findIndex(c => c.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<ContractEntry>(req.body, CONTRACT_FIELDS);
  if (body.customerId !== undefined && !exists(customerStore.items, body.customerId)) { res.status(400).json({ error: 'customerId must reference an existing customer' }); return; }
  const bad = findInvalidNumericField(body, ['totalValue']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  contractStore.items[i] = { ...contractStore.items[i], ...body };
  res.json(contractStore.items[i]);
});
apiRouter.delete('/contracts/:id', (req, res) => {
  contractStore.items = contractStore.items.filter(c => c.id !== req.params.id);
  res.status(204).send();
});

const ORDER_FIELDS = ['contractId', 'type', 'partnerId', 'amount', 'currency', 'status', 'orderDate'] as const;

/** Validate an order's contract FK and the Purchase/Customer partner rules. Returns an error string or null. */
function validateOrder(body: Partial<OrderEntry>, current?: OrderEntry): string | null {
  const type = body.type ?? current?.type;
  const partnerId = body.partnerId ?? current?.partnerId ?? '';
  if (body.contractId !== undefined || !current) {
    if (!exists(contractStore.items, body.contractId ?? current?.contractId)) return 'contractId must reference an existing contract';
  }
  if (type === 'Purchase') {
    if (!exists(partnerStore.items, partnerId)) return 'Purchase orders require an existing partnerId';
  } else if (type === 'Customer') {
    if (partnerId !== '') return 'Customer orders must not set a partnerId';
  }
  return null;
}

apiRouter.get('/orders', (_req, res) => res.json(orderStore.items));
apiRouter.post('/orders', (req, res) => {
  const body = pick<OrderEntry>(req.body, ORDER_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const fkError = validateOrder(body);
  if (fkError) { res.status(400).json({ error: fkError }); return; }
  const item = { id: newId(), partnerId: '', ...body } as OrderEntry;
  // INVOICE NUMBERING: an order created directly as 'Invoiced' gets a number now.
  applyInvoiceNumbering(item);
  orderStore.items.push(item);
  res.json(item);
});
apiRouter.put('/orders/:id', (req, res) => {
  const i = orderStore.items.findIndex(o => o.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<OrderEntry>(req.body, ORDER_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  const fkError = validateOrder(body, orderStore.items[i]);
  if (fkError) { res.status(400).json({ error: fkError }); return; }
  orderStore.items[i] = { ...orderStore.items[i], ...body };
  // INVOICE NUMBERING: assign a sequential number/date on transition to
  // 'Invoiced'. invoiceNumber/invoiceDate are not in ORDER_FIELDS, so the
  // client can never set them; they are strictly server-assigned.
  applyInvoiceNumbering(orderStore.items[i]);
  res.json(orderStore.items[i]);
});
apiRouter.delete('/orders/:id', (req, res) => {
  orderStore.items = orderStore.items.filter(o => o.id !== req.params.id);
  res.status(204).send();
});

const ORDER_LINE_FIELDS = ['orderId', 'projectId', 'description', 'amount'] as const;
apiRouter.get('/order-lines', (_req, res) => res.json(orderLineStore.items));
apiRouter.post('/order-lines', (req, res) => {
  const body = pick<OrderLineEntry>(req.body, ORDER_LINE_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  if (!exists(orderStore.items, body.orderId)) { res.status(400).json({ error: 'orderId must reference an existing order' }); return; }
  if (!exists(projects, body.projectId)) { res.status(400).json({ error: 'projectId must reference an existing project' }); return; }
  const item = { id: newId(), ...body } as OrderLineEntry;
  orderLineStore.items.push(item);
  res.json(item);
});
apiRouter.put('/order-lines/:id', (req, res) => {
  const i = orderLineStore.items.findIndex(l => l.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<OrderLineEntry>(req.body, ORDER_LINE_FIELDS);
  const bad = findInvalidNumericField(body, ['amount']);
  if (bad) { res.status(400).json({ error: `${bad} must be a non-negative number` }); return; }
  if (body.orderId !== undefined && !exists(orderStore.items, body.orderId)) { res.status(400).json({ error: 'orderId must reference an existing order' }); return; }
  if (body.projectId !== undefined && !exists(projects, body.projectId)) { res.status(400).json({ error: 'projectId must reference an existing project' }); return; }
  orderLineStore.items[i] = { ...orderLineStore.items[i], ...body };
  res.json(orderLineStore.items[i]);
});
apiRouter.delete('/order-lines/:id', (req, res) => {
  orderLineStore.items = orderLineStore.items.filter(l => l.id !== req.params.id);
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

// One representative item PER BillingType, tied to existing contracts/projects.
// Milestone item points at an existing milestone ('M2' Go-Live on project '1').
const billingPlanStore = { items: [
  { id: 'BP1', contractId: 'CT1', projectId: '1', type: 'Milestone', label: 'SAL Go-Live milestone', milestoneId: 'M2', expectedDate: '2026-12-01', amount: 150000, retentionPct: 10, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Planned' },
  // MULTI-CURRENCY DEMO: BP2/BP3/BP4/BP7 bill against USD contract CT2, so they are in USD.
  { id: 'BP2', contractId: 'CT2', projectId: '2', type: 'Recurring', label: 'Monthly retainer', recurrence: 'Monthly', expectedDate: '2026-03-31', amount: 12000, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Invoiced', issuedDate: '2026-03-31', dueDate: '2026-04-30', orderId: 'O3' },
  { id: 'BP3', contractId: 'CT2', projectId: '2', type: 'TimeAndMaterials', label: 'T&M consuntivo Q1', expectedDate: '2026-04-15', amount: 28500, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Ready' },
  { id: 'BP4', contractId: 'CT2', projectId: '2', type: 'Capped', label: 'T&M capped work package', expectedDate: '2026-06-30', amount: 45000, capAmount: 50000, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Planned' },
  { id: 'BP5', contractId: 'CT1', projectId: '1', type: 'Advance', label: 'Down payment / acconto', expectedDate: '2026-01-15', amount: 100000, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Paid', issuedDate: '2026-01-15', dueDate: '2026-02-14', paidDate: '2026-02-10', orderId: 'O1' },
  { id: 'BP6', contractId: 'CT1', projectId: '1', type: 'Progress', label: 'Progress billing (POC 60%)', progressPct: 60, expectedDate: '2026-07-01', amount: 90000, retentionPct: 10, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Ready' },
  { id: 'BP7', contractId: 'CT2', projectId: '2', type: 'Expense', label: 'Re-billed travel expenses', markupPct: 5, expectedDate: '2026-05-10', amount: 3200, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Planned' },
  { id: 'BP8', contractId: 'CT1', projectId: '1', type: 'CreditNote', label: 'Credit note / nota di credito', expectedDate: '2026-08-01', amount: -5000, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Planned', notes: 'Adjustment for descoped feature' },
] as BillingPlanEntry[] };

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

apiRouter.get('/billing-plan-items', (_req, res) => res.json(billingPlanStore.items));
apiRouter.post('/billing-plan-items', (req, res) => {
  const body = pick<BillingPlanEntry>(req.body, BILLING_PLAN_FIELDS);
  const bad = findInvalidBillingNumericField(body, body.type);
  if (bad) {
    const rule = bad === 'amount' ? 'amount must be a non-negative number (negative allowed only for CreditNote)' : `${bad} must be a non-negative number`;
    res.status(400).json({ error: rule });
    return;
  }
  const item = { id: newId(), ...body } as BillingPlanEntry;
  billingPlanStore.items.push(item);
  res.json(item);
});
apiRouter.put('/billing-plan-items/:id', (req, res) => {
  const i = billingPlanStore.items.findIndex(b => b.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<BillingPlanEntry>(req.body, BILLING_PLAN_FIELDS);
  // Resolve the effective type for the negative-amount rule: an incoming type
  // overrides, otherwise fall back to the stored item's type.
  const effectiveType = body.type ?? billingPlanStore.items[i].type;
  const bad = findInvalidBillingNumericField(body, effectiveType);
  if (bad) {
    const rule = bad === 'amount' ? 'amount must be a non-negative number (negative allowed only for CreditNote)' : `${bad} must be a non-negative number`;
    res.status(400).json({ error: rule });
    return;
  }
  billingPlanStore.items[i] = { ...billingPlanStore.items[i], ...body };
  res.json(billingPlanStore.items[i]);
});
apiRouter.delete('/billing-plan-items/:id', (req, res) => {
  billingPlanStore.items = billingPlanStore.items.filter(b => b.id !== req.params.id);
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
const fxRateStore = { items: [
  { currency: 'EUR', rateToBase: 1 },
  { currency: 'USD', rateToBase: 0.92 },
  { currency: 'GBP', rateToBase: 1.17 },
] as FxRateEntry[] };

// Read is open to everyone (a GET, so roleGate already lets it through). Writes
// are optional and admin-only: an upsert keyed by currency that re-pegs or adds
// a rate. The base currency's peg is fixed at 1 and cannot be changed.
apiRouter.get('/fx-rates', (_req, res) => res.json(fxRateStore.items));
apiRouter.put('/fx-rates/:currency', (req, res) => {
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
  const i = fxRateStore.items.findIndex(r => r.currency === currency);
  if (i === -1) fxRateStore.items.push({ currency, rateToBase: body.rateToBase });
  else fxRateStore.items[i] = { currency, rateToBase: body.rateToBase };
  res.json(fxRateStore.items.find(r => r.currency === currency));
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

const approvalRequestStore = { items: (() => {
  const seed = (entry: Omit<ApprovalRequestEntry, 'steps' | 'currentStep' | 'status' | 'slaDueAt'>): ApprovalRequestEntry => ({
    ...entry,
    status: 'Pending',
    steps: buildApprovalSteps(entry.kind, entry.amount),
    currentStep: 0,
    slaDueAt: slaDueFrom(entry.createdAt),
  });
  return [
    seed({ id: 'AR1', kind: 'TimeEntry', refId: 'TE3', projectId: '1', requestedBy: '1', createdAt: '2026-04-08T16:00:00.000Z', note: 'Submitted hours pending approval' }),
    seed({ id: 'AR2', kind: 'Invoice', refId: 'O3', projectId: '2', amount: 120000, requestedBy: '5', createdAt: '2026-03-11T09:00:00.000Z', note: 'Customer invoice over high-value threshold' }),
    seed({ id: 'AR3', kind: 'ChangeRequest', refId: 'CR1', projectId: '1', amount: 12000, requestedBy: '3', createdAt: '2026-04-20T10:30:00.000Z', note: 'Scope extension awaiting delivery sign-off' }),
  ];
})() };

const APPROVAL_REQUEST_FIELDS = ['kind', 'refId', 'projectId', 'amount', 'requestedBy', 'note'] as const;

apiRouter.get('/approval-requests', (_req, res) => res.json(approvalRequestStore.items));
apiRouter.post('/approval-requests', (req, res) => {
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
  approvalRequestStore.items.push(item);
  res.json(item);
});
apiRouter.put('/approval-requests/:id/decision', (req, res) => {
  const i = approvalRequestStore.items.findIndex(a => a.id === req.params.id);
  if (i === -1) { res.status(404).json({ error: 'Not found' }); return; }
  const body = pick<{ decision: string; by: string }>(req.body, ['decision', 'by']);
  if (body.decision !== 'Approved' && body.decision !== 'Rejected') {
    res.status(400).json({ error: "decision must be 'Approved' or 'Rejected'" });
    return;
  }
  const by = typeof body.by === 'string' && body.by.length > 0 ? body.by : actorId(req);
  const ar = approvalRequestStore.items[i];
  if (ar.status !== 'Pending') {
    res.status(400).json({ error: `approval request already ${ar.status}` });
    return;
  }
  // SEGREGATION OF DUTIES: the requester may never approve/reject their own item.
  if (by === ar.requestedBy) {
    res.status(400).json({ error: 'Segregation of duties: the requester cannot decide their own approval request' });
    return;
  }
  const step = ar.steps[ar.currentStep];
  if (!step) { res.status(400).json({ error: 'No pending step to decide' }); return; }
  const decidedAt = new Date().toISOString();
  step.decidedBy = by;
  step.decidedAt = decidedAt;
  if (body.decision === 'Rejected') {
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
  approvalRequestStore.items[i] = ar;
  res.json(ar);
});

apiRouter.get('/audit-logs', (_req, res) => res.json(auditLogStore.items));
apiRouter.get('/storage-status', (_req, res) => res.json({
  provider: pgPool ? 'postgresql' : 'memory',
  stateKey,
  persistent: Boolean(pgPool),
}));

const databaseUrl = process.env['DATABASE_URL'];
const stateKey = process.env['APP_STATE_KEY'] || 'project-resource-mgmt';
const pgPool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      // S-HIGH (TLS): NEVER disable certificate verification. When PGSSL is
      // enabled we always verify the server certificate, optionally pinning a
      // trusted CA bundle supplied via PG_CA_CERT.
      ssl: process.env['PGSSL'] === 'true'
        ? {
            rejectUnauthorized: true,
            ca: process.env['PG_CA_CERT'] ? readFileSync(process.env['PG_CA_CERT'], 'utf8') : undefined,
          }
        : undefined,
    })
  : null;
let saveQueue: Promise<unknown> = Promise.resolve();

function replaceArray<T>(target: T[], source: T[] | undefined) {
  if (!Array.isArray(source)) return;
  target.splice(0, target.length, ...source);
}

function snapshotState() {
  return {
    idSeq,
    invoiceSeq,
    resources,
    users,
    requests,
    assignments,
    timeEntries: timeEntryStore.items,
    languages,
    skillCatalogs: skillCatalogStore.items,
    proficiencySets: proficiencyStore.items,
    skills: skillStore.items,
    projectRoles: roleStore.items,
    resourceOrganizations,
    projects,
    projectPartners: partnerStore.items,
    projectDocuments: documentStore.items,
    workPackages: workPackageStore.items,
    milestones: milestoneStore.items,
    projectFinancials: financialStore.items,
    projectCostCenters: projectCostCenterStore.items,
    projectTasks: taskStore.items,
    projectIssues: issueStore.items,
    changeRequests: changeRequestStore.items,
    costCenters: costCenterStore.items,
    customers: customerStore.items,
    contracts: contractStore.items,
    orders: orderStore.items,
    orderLines: orderLineStore.items,
    billingPlanItems: billingPlanStore.items,
    fxRates: fxRateStore.items,
    approvalRequests: approvalRequestStore.items,
    auditLogs: auditLogStore.items,
  };
}

async function ensureStateTable() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function saveState() {
  if (!pgPool) return;
  const pool = pgPool;
  const state = snapshotState();
  saveQueue = saveQueue
    .then(() => pool.query(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [stateKey, JSON.stringify(state)],
    ))
    .catch(error => {
      console.error('Failed to persist PostgreSQL app_state snapshot', error);
    });
}

async function hydrateState() {
  if (!pgPool) {
    console.warn('DATABASE_URL is not set; using in-memory mock state only.');
    return;
  }
  try {
    await ensureStateTable();
    const result = await pgPool.query<{ value: Partial<ReturnType<typeof snapshotState>> }>(
      'SELECT value FROM app_state WHERE key = $1',
      [stateKey],
    );
    if (!result.rows.length) {
      saveState();
      await saveQueue;
      return;
    }
    const state = result.rows[0].value;
    if (typeof state.idSeq === 'number') idSeq = state.idSeq;
    if (typeof state.invoiceSeq === 'number') invoiceSeq = state.invoiceSeq;
    replaceArray(resources, state.resources);
    replaceArray(users, state.users);
    replaceArray(requests, state.requests);
    replaceArray(assignments, state.assignments);
    replaceArray(timeEntryStore.items, state.timeEntries);
    if (Array.isArray(state.languages)) languages = state.languages;
    replaceArray(skillCatalogStore.items, state.skillCatalogs);
    replaceArray(proficiencyStore.items, state.proficiencySets);
    replaceArray(skillStore.items, state.skills);
    replaceArray(roleStore.items, state.projectRoles);
    if (Array.isArray(state.resourceOrganizations)) resourceOrganizations = state.resourceOrganizations;
    if (Array.isArray(state.projects)) projects = state.projects;
    replaceArray(partnerStore.items, state.projectPartners);
    replaceArray(documentStore.items, state.projectDocuments);
    replaceArray(workPackageStore.items, state.workPackages);
    replaceArray(milestoneStore.items, state.milestones);
    replaceArray(financialStore.items, state.projectFinancials);
    replaceArray(projectCostCenterStore.items, state.projectCostCenters);
    replaceArray(taskStore.items, state.projectTasks);
    replaceArray(issueStore.items, state.projectIssues);
    replaceArray(changeRequestStore.items, state.changeRequests);
    replaceArray(costCenterStore.items, state.costCenters);
    replaceArray(customerStore.items, state.customers);
    replaceArray(contractStore.items, state.contracts);
    replaceArray(orderStore.items, state.orders);
    replaceArray(orderLineStore.items, state.orderLines);
    replaceArray(billingPlanStore.items, state.billingPlanItems);
    replaceArray(fxRateStore.items, state.fxRates);
    replaceArray(approvalRequestStore.items, state.approvalRequests);
    replaceArray(auditLogStore.items, state.auditLogs);
    // INVOICE NUMBERING: reconcile the counter to the highest persisted invoice
    // number for this year so a restart can never re-issue a used number, even
    // if invoiceSeq was absent from an older snapshot.
    reconcileInvoiceSeq();
  } catch (error) {
    console.error('Failed to hydrate PostgreSQL app_state; using seeded defaults in memory', error);
  }
}

/** Bump invoiceSeq past the largest INV-<year>-NNNN currently stored. */
function reconcileInvoiceSeq(): void {
  const prefix = `INV-${INVOICE_YEAR}-`;
  let maxSeq = invoiceSeq;
  for (const o of orderStore.items) {
    if (typeof o.invoiceNumber === 'string' && o.invoiceNumber.startsWith(prefix)) {
      const n = Number(o.invoiceNumber.slice(prefix.length));
      if (Number.isInteger(n) && n > maxSeq) maxSeq = n;
    }
  }
  invoiceSeq = maxSeq;
}

/**
 * AUDIT INTEGRITY: register every mutable collection so the audit middleware
 * can snapshot before/after on PUT/DELETE. Getters resolve the live binding so
 * `let`-reassigned collections (projects, languages, ...) stay correct.
 */
function registerAuditStores(): void {
  auditStores.set('resources', () => resources);
  auditStores.set('requests', () => requests);
  auditStores.set('assignments', () => assignments);
  auditStores.set('time-entries', () => timeEntryStore.items);
  auditStores.set('skill-catalogs', () => skillCatalogStore.items);
  auditStores.set('proficiency-sets', () => proficiencyStore.items);
  auditStores.set('skills', () => skillStore.items);
  auditStores.set('project-roles', () => roleStore.items);
  auditStores.set('resource-organizations', () => resourceOrganizations);
  auditStores.set('projects', () => projects);
  auditStores.set('project-partners', () => partnerStore.items);
  auditStores.set('project-documents', () => documentStore.items);
  auditStores.set('work-packages', () => workPackageStore.items);
  auditStores.set('milestones', () => milestoneStore.items);
  auditStores.set('project-financials', () => financialStore.items);
  auditStores.set('project-cost-centers', () => projectCostCenterStore.items);
  auditStores.set('project-tasks', () => taskStore.items);
  auditStores.set('project-issues', () => issueStore.items);
  auditStores.set('change-requests', () => changeRequestStore.items);
  auditStores.set('cost-centers', () => costCenterStore.items);
  auditStores.set('customers', () => customerStore.items);
  auditStores.set('contracts', () => contractStore.items);
  auditStores.set('orders', () => orderStore.items);
  auditStores.set('order-lines', () => orderLineStore.items);
  auditStores.set('billing-plan-items', () => billingPlanStore.items);
  auditStores.set('approval-requests', () => approvalRequestStore.items);
}
registerAuditStores();

await hydrateState();

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
