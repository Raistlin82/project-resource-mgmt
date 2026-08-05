#!/usr/bin/env node
// @ts-check
/*
 * smoke-api.mjs — dependency-free smoke test for the mock API.
 *
 * Exercises the Express mock API exposed by src/server.ts. The router is
 * mounted at `/api` (app.use('/api', apiRouter)), so every path below is
 * prefixed with `/api`. URLs were cross-checked against src/server.ts route
 * registrations and src/app/services/api.service.ts method URLs.
 *
 * Usage:
 *   AUTH_TRUST_HEADERS=true npm run serve:ssr:app
 *   node scripts/smoke-api.mjs
 *   SMOKE_BASE=http://localhost:3000 node scripts/smoke-api.mjs
 *   SMOKE_CREATE_ONLY=1 node scripts/smoke-api.mjs   # only POST a row, print id+segment
 *
 * Requires Node 20+ (uses global fetch). No test framework, no dependencies.
 *
 * Exit code: 0 if every check passes, non-zero otherwise.
 */

const BASE = (process.env.SMOKE_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const API = `${BASE}/api`;
const CREATE_ONLY = process.env.SMOKE_CREATE_ONLY === '1';

// RBAC: src/server.ts trusts the spoofable X-User-* demo headers only when the
// server is explicitly started with AUTH_TRUST_HEADERS=true. Sensitive reads
// and cost-centers mutations require an authenticated/authorized identity, so
// the smoke harness consistently presents the demo admin principal.
const RBAC_HEADERS = { 'X-User-Id': '1', 'X-User-Role': 'admin' };

// The CRUD round-trip targets the configuration-level cost-centers collection
// (POST/PUT/DELETE all admin-gated, no FK constraints, safe to mutate).
const CRUD_SEGMENT = 'cost-centers';
const SMOKE_MANAGER = 'Julie Armstrong';
const UPDATED_SMOKE_MANAGER = 'John Miller';

let passed = 0;
let failed = 0;
let skipped = 0;

/** Record and print a single PASS/FAIL line. */
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}

/**
 * Record and print a single SKIP line — deliberately NOT a PASS. A check that
 * cannot run on this backend must say so loudly, distinct from both PASS and
 * FAIL, and must never be counted toward `passed`. Reporting an unexercised
 * check as a pass is the exact blind-green-gate shape this project's
 * conventions forbid (see the FK-violation check below for the concrete case
 * this exists to prevent).
 */
function skip(name, detail = '') {
  skipped++;
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Fetch JSON, returning { status, body, raw }. Never throws on HTTP status.
 *
 * RETRIES A 429. The API applies a 300-req/min-per-client rate limit (src/server.ts,
 * `rateLimit(300, 60_000)`) and this suite is well past that in a single 60s
 * window, so without a backoff a growing suite starts reporting phantom failures
 * for every check after the ceiling — the exact way a red gate gets mistaken for a
 * product bug. The retry is SAFE because the limiter is `apiRouter.use(...)`
 * middleware: a 429 is rejected before any handler runs, so the request had no
 * side effect and re-sending it is not a duplicate mutation. Waits out the rest of
 * the window (buckets are fixed-window, keyed on the client ip).
 */
async function req(method, path, { headers, body } = {}) {
  const RETRY_MS = 5_000;
  const MAX_WAIT_MS = 70_000; // one full window plus slack
  let waited = 0;
  for (;;) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...RBAC_HEADERS,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status !== 429 || waited >= MAX_WAIT_MS) {
      return { status: res.status, body: json, raw: text };
    }
    if (waited === 0) console.log(`INFO  rate limit reached — waiting out the window before retrying ${method} ${path}`);
    await sleep(RETRY_MS);
    waited += RETRY_MS;
  }
}

/** SMOKE_CREATE_ONLY: just POST a cost-center and print the created id+segment. */
async function createOnly() {
  const label = `Smoke CreateOnly ${new Date().toISOString()}`;
  let status;
  let body;
  try {
    ({ status, body } = await req('POST', `/${CRUD_SEGMENT}`, {
      headers: RBAC_HEADERS,
      body: { name: label, manager: SMOKE_MANAGER, allocated: 1000, actual: 0 },
    }));
  } catch (err) {
    console.log(`FAIL  create-only POST /api/${CRUD_SEGMENT} — ${err && err.message ? err.message : err}`);
    console.log(`HINT  is the server running at ${BASE}? Start it with: node dist/app/server/server.mjs (or npm run serve:ssr:app)`);
    process.exit(1);
  }
  // crud() in src/server.ts responds with res.json(item) => HTTP 200 (not 201).
  const ok = (status === 201 || status === 200) && body && typeof body.id === 'string';
  if (!ok) {
    console.log(`FAIL  create-only POST /api/${CRUD_SEGMENT} — status=${status} body=${JSON.stringify(body)}`);
    process.exit(1);
  }
  // Machine-readable line for the restart-persistence check that consumes this.
  console.log(`CREATED segment=${CRUD_SEGMENT} id=${body.id}`);
  console.log(`PASS  create-only POST /api/${CRUD_SEGMENT} (status ${status}) — id=${body.id}, name="${label}"`);
  process.exit(0);
}

/** Step 1: GET seed collections, assert HTTP 200 and key seed rows exist. */
async function checkReads() {
  // /api/resources — resource id '1' (Julie Armstrong) must exist.
  {
    const { status, body } = await req('GET', '/resources');
    check('GET /api/resources -> 200', status === 200, `status=${status}`);
    const r1 = Array.isArray(body) ? body.find((r) => r.id === '1') : undefined;
    check("GET /api/resources includes resource id '1'", Boolean(r1), r1 ? `name="${r1.name}"` : 'missing');
  }

  // /api/projects — seeded projects '1' and '2'.
  {
    const { status, body } = await req('GET', '/projects');
    check('GET /api/projects -> 200', status === 200, `status=${status}`);
    const ids = Array.isArray(body) ? body.map((p) => p.id) : [];
    check("GET /api/projects includes ids '1' and '2'", ids.includes('1') && ids.includes('2'), `ids=[${ids.join(',')}]`);
  }

  // /api/contracts — CT2 must exist and be USD.
  let ct2;
  {
    const { status, body } = await req('GET', '/contracts');
    check('GET /api/contracts -> 200', status === 200, `status=${status}`);
    ct2 = Array.isArray(body) ? body.find((c) => c.id === 'CT2') : undefined;
    check('GET /api/contracts includes CT2', Boolean(ct2), ct2 ? `name="${ct2.name}"` : 'missing');
    check('CT2 contract currency is USD', Boolean(ct2) && ct2.currency === 'USD', ct2 ? `currency=${ct2.currency}` : 'n/a');
  }

  // /api/orders — O3 (belongs to CT2) must exist and be USD.
  {
    const { status, body } = await req('GET', '/orders');
    check('GET /api/orders -> 200', status === 200, `status=${status}`);
    const o3 = Array.isArray(body) ? body.find((o) => o.id === 'O3') : undefined;
    check('GET /api/orders includes O3', Boolean(o3), o3 ? `contractId=${o3.contractId}` : 'missing');
    check('O3 order currency is USD', Boolean(o3) && o3.currency === 'USD', o3 ? `currency=${o3.currency}` : 'n/a');
    check('O3 order belongs to contract CT2', Boolean(o3) && o3.contractId === 'CT2', o3 ? `contractId=${o3.contractId}` : 'n/a');
  }

  // /api/billing-plan-items — seeded billing plan must be present.
  {
    const { status, body } = await req('GET', '/billing-plan-items');
    check('GET /api/billing-plan-items -> 200', status === 200, `status=${status}`);
    const bp1 = Array.isArray(body) ? body.find((b) => b.id === 'BP1') : undefined;
    check('GET /api/billing-plan-items includes BP1', Boolean(bp1), bp1 ? `type=${bp1.type}` : 'missing');
  }

  // /api/fx-rates — EUR=1, USD=0.92 seed pegs.
  {
    const { status, body } = await req('GET', '/fx-rates');
    check('GET /api/fx-rates -> 200', status === 200, `status=${status}`);
    const rates = Array.isArray(body) ? body : [];
    const eur = rates.find((r) => r.currency === 'EUR');
    const usd = rates.find((r) => r.currency === 'USD');
    check('fx-rates EUR rateToBase = 1', Boolean(eur) && eur.rateToBase === 1, eur ? `EUR=${eur.rateToBase}` : 'missing');
    check('fx-rates USD rateToBase = 0.92', Boolean(usd) && usd.rateToBase === 0.92, usd ? `USD=${usd.rateToBase}` : 'missing');
  }
}

/** Step 2: full CRUD round-trip against /api/cost-centers. */
async function checkCrud() {
  const seg = CRUD_SEGMENT;
  const label = `Smoke CC ${new Date().toISOString()}`;

  // POST — create.
  const created = await req('POST', `/${seg}`, {
    headers: RBAC_HEADERS,
    body: { name: label, manager: SMOKE_MANAGER, allocated: 5000, actual: 100 },
  });
  // crud() responds with res.json(item) => HTTP 200 (the harness still asserts
  // a created-row shape: a string id is returned). Accept 201 too for safety.
  const createOk = check(
    `POST /api/${seg} creates a row (201/200 + id)`,
    (created.status === 201 || created.status === 200) && created.body && typeof created.body.id === 'string',
    `status=${created.status}, id=${created.body && created.body.id}`,
  );
  if (!createOk) return; // nothing more to verify without an id
  const id = created.body.id;

  // GET — confirm the new row exists. crud() exposes no per-item GET, so fetch
  // the collection and locate the row by id (equivalent to GET /:id here).
  {
    const { status, body } = await req('GET', `/${seg}`);
    const found = Array.isArray(body) ? body.find((c) => c.id === id) : undefined;
    check(`GET /api/${seg} after create includes id ${id}`, status === 200 && Boolean(found), found ? `name="${found.name}"` : `status=${status}, missing`);
  }

  // PUT — change a field and assert it persisted.
  const newManager = UPDATED_SMOKE_MANAGER;
  {
    const put = await req('PUT', `/${seg}/${id}`, {
      headers: RBAC_HEADERS,
      body: { manager: newManager },
    });
    check(`PUT /api/${seg}/${id} -> 200`, put.status === 200, `status=${put.status}`);
    check(`PUT /api/${seg}/${id} persisted manager change`, Boolean(put.body) && put.body.manager === newManager, put.body ? `manager="${put.body.manager}"` : 'no body');
  }
  // Re-read the collection to confirm persistence beyond the PUT response body.
  {
    const { body } = await req('GET', `/${seg}`);
    const found = Array.isArray(body) ? body.find((c) => c.id === id) : undefined;
    check(`GET /api/${seg} reflects persisted manager change`, Boolean(found) && found.manager === newManager, found ? `manager="${found.manager}"` : 'missing');
  }

  // DELETE — assert 204 and that the row is gone.
  {
    const del = await req('DELETE', `/${seg}/${id}`, { headers: RBAC_HEADERS });
    check(`DELETE /api/${seg}/${id} -> 204`, del.status === 204, `status=${del.status}`);
  }
  {
    const { body } = await req('GET', `/${seg}`);
    const stillThere = Array.isArray(body) ? body.some((c) => c.id === id) : true;
    check(`GET /api/${seg} after delete no longer includes id ${id}`, !stillThere, stillThere ? 'row still present' : 'removed');
  }
}

/**
 * Step 3: ALLOCATION APPROVAL flow — B3 (Task 7) rewrite. Originally this
 * section drove the whole lifecycle through POST /assignments carrying a
 * client `status` (gap-A shape). That path no longer exists: `status` is now
 * DERIVED exclusively from the (assignment, month) rows, and any client
 * `status` on POST/PUT /assignments is a 400 (asserted below — this is one of
 * the two carry-forward regressions this task closes). The lifecycle now
 * runs: create (no status, derived 'Draft') -> book hours into a month via
 * PUT .../allocation (lazily opens a 'Draft' month row) -> submit that month
 * for approval -> decide via the still-existing PUT /approval-requests/:id/decision.
 *
 * IDENTITIES — chosen from src/db/seed.ts so this reads deterministically
 * against the demo dataset, and kept separate from RBAC_HEADERS/CRUD_SEGMENT
 * above so this section never shares state with the existing CRUD round-trip:
 *
 *   PROPOSER_HEADERS  X-User-Id '3' / X-User-Role 'pm'
 *     -> seed user '3' (Alice Smith, role 'pm'), which the server's
 *        actorResourceId() maps (via the users directory, matched by id) to
 *        resource-id '3'.
 *
 *   TARGET_RESOURCE_ID '2' (John Miller). His seeded `managerId` is '1'
 *     (Julie Armstrong) — NOT '3' (the proposer's own resource-id) — so
 *     `autoApprovesAllocation()` is false: submitting the month does NOT
 *     auto-approve and a real 'Allocation' approval step is opened, routed to
 *     approverId '1' (role 'resource-manager', per allocationApproverStep()).
 *     This is the "manager routing" the original section proved, now
 *     exercised at the per-month layer.
 *
 *   TARGET_REQUEST_ID '4' (Project Beta - Platform Migration, Consultant) —
 *     matches resource '2's role.
 *
 *   MONTH '2026-07' — an Open planning period (seed opens 2026-04..2026-12).
 *     Resource 2's only seeded assignment (id '3', 30h spread thinly over
 *     2026-05-15..2026-09-15) contributes negligible hours on any single July
 *     day, so booking 1h on 2026-07-06 (a Monday) stays far under the 8h/day
 *     cap (resource 2's contractHoursPerDay).
 *
 *   DECIDER_HEADERS  X-User-Id '1' / X-User-Role 'admin'
 *     -> 'admin' may decide ANY step regardless of its role/approverId (so
 *        this also happens to satisfy the manager-match on approverId '1'),
 *        and actor '1' != the proposer's actor id '3', so the "requester
 *        cannot decide their own approval request" SoD guard (403 otherwise)
 *        does not trip.
 *
 * PORTED BACK (Task 5): the ORIGINAL gap-A section asserted that, after the
 * decision, the GOVERNED ENTITY — not just the ApprovalRequest — reflected the
 * outcome. That assertion could not be written while the post-decision effect
 * inside `PUT /approval-requests/:id/decision` resolved `refId` via a bare
 * `repos.assignments.get(refId)` only: a B3 approval's refId is the composite
 * month-row id (`<assignmentId>:<month>`), which never matches a bare
 * assignment id, so the hook was a silent no-op for every B3 approval. Task 5
 * made that hook month-row-aware (`applyAllocationDecision`), so step 6b below
 * reinstates it at the per-month layer: the decided MONTH reads 'Allocated',
 * the approver's note is mirrored onto the row, and the assignment's DERIVED
 * status rolls up to 'Allocated'. Deliberately driven through the SINGLE-
 * request endpoint (`PUT /approval-requests/:id/decision`), not the new batch
 * one, so this stays the regression guard for the extracted decision core.
 *
 * Kept in its OWN try/catch in main() so an unexpected failure here never
 * masks or blocks the pre-existing checkReads()/checkCrud() results.
 */
async function checkAllocationApproval() {
  const PROPOSER_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };
  const DECIDER_HEADERS = { 'X-User-Id': '1', 'X-User-Role': 'admin' };
  const TARGET_RESOURCE_ID = '2'; // John Miller — managerId '1' (Julie Armstrong), != proposer resource-id '3'
  const TARGET_REQUEST_ID = '4'; // Project Beta - Platform Migration (Consultant)
  const MONTH = '2026-07';
  const DAY = `${MONTH}-06`; // Monday
  // The exact literal src/server.ts's POST/PUT /assignments guard responds
  // with. Asserted verbatim below (not just the 400 status) so a future
  // validation change that swaps in a different rejection reason — or that
  // silently narrows the guard to only SOME status values — cannot pass this
  // check by accident.
  const STATUS_NOT_SETTABLE_ERROR = 'status is derived from the per-month allocation and cannot be set on an assignment';

  // 0) REGRESSION CLOSED (B3 carry-forward #1) — a client can no longer seed a
  // status on create/update; ANY explicit `status`, even a previously-legal
  // 'Draft', is now a 400 on both POST and PUT (assignments.status is derived
  // exclusively from the month rows).
  {
    const forged = await req('POST', '/assignments', {
      headers: PROPOSER_HEADERS,
      body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID, status: 'Draft' },
    });
    check(
      "POST /api/assignments with a client status (even 'Draft') is rejected (400, status is derived)",
      forged.status === 400 && forged.body?.error === STATUS_NOT_SETTABLE_ERROR,
      `status=${forged.status}, body=${JSON.stringify(forged.body)}`,
    );
  }
  {
    const forgedPut = await req('PUT', '/assignments/3', {
      headers: PROPOSER_HEADERS,
      body: { status: 'Draft' },
    });
    check(
      "PUT /api/assignments/:id with a client status is rejected (400, status is derived)",
      forgedPut.status === 400 && forgedPut.body?.error === STATUS_NOT_SETTABLE_ERROR,
      `status=${forgedPut.status}, body=${JSON.stringify(forgedPut.body)}`,
    );
  }

  // 1) CREATE — POST /assignments carries NO status; the server derives
  // 'Draft' (no month rows exist yet).
  const created = await req('POST', '/assignments', {
    headers: PROPOSER_HEADERS,
    body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID },
  });
  const createOk = check(
    "POST /api/assignments (no status) -> 200, derived status 'Draft'",
    created.status === 200 && Boolean(created.body) && typeof created.body.id === 'string' && created.body.status === 'Draft',
    `status=${created.status}, assignmentStatus=${created.body && created.body.status}`,
  );
  if (!createOk) return; // nothing more to verify without an assignment id
  const assignmentId = created.body.id;

  // 2) ALLOCATE — PUT .../allocation books ONE working day, lazily creating a
  // 'Draft' month row for MONTH (ensureAssignmentMonth).
  const alloc = await req('PUT', `/assignments/${assignmentId}/allocation`, {
    headers: PROPOSER_HEADERS,
    body: { month: MONTH, dailyHours: { [DAY]: 1 } },
  });
  check(
    `PUT /api/assignments/${assignmentId}/allocation (open a Draft month) -> 200`,
    alloc.status === 200,
    `status=${alloc.status}, body=${JSON.stringify(alloc.body)}`,
  );

  // 3) PROPOSE — POST .../months/:month/submit as the non-self-managing
  // proposer. Must NOT auto-approve: the month moves Draft -> Requested with a
  // fresh approval, routed to the manager.
  const submitted = await req('POST', `/assignments/${assignmentId}/months/${MONTH}/submit`, {
    headers: PROPOSER_HEADERS,
    body: {},
  });
  const submitOk = check(
    "POST /api/assignments/:id/months/:month/submit -> 200, status 'Requested' + approvalId (manager routing, not self-managed)",
    submitted.status === 200 && Boolean(submitted.body) && submitted.body.status === 'Requested' && typeof submitted.body.approvalId === 'string' && submitted.body.approvalId.length > 0,
    `status=${submitted.status}, monthStatus=${submitted.body && submitted.body.status}, approvalId=${submitted.body && submitted.body.approvalId}`,
  );
  if (!submitOk) return; // nothing more to verify without an approval id
  const approvalId = submitted.body.approvalId;
  const monthRowId = `${assignmentId}:${MONTH}`;

  // 4) GET /approval-requests — a Pending 'Allocation' entry must exist whose
  // refId is the MONTH ROW (B3: the governed entity is the (assignment,
  // month) pair, not the bare assignment id).
  {
    const { status, body } = await req('GET', '/approval-requests', { headers: DECIDER_HEADERS });
    const ar = Array.isArray(body) ? body.find((a) => a.id === approvalId) : undefined;
    check(
      "GET /api/approval-requests includes the new 'Allocation' request (Pending, refId is the month row)",
      status === 200 && Boolean(ar) && ar.kind === 'Allocation' && ar.refId === monthRowId && ar.status === 'Pending',
      ar ? `kind=${ar.kind}, refId=${ar.refId}, status=${ar.status}` : `status=${status}, missing id=${approvalId}`,
    );
  }

  // 5) SoD — the proposer may never decide their own approval request. This
  // guard runs BEFORE the refId is resolved into a governed-entity update, so
  // it is unaffected by the month-row-awareness gap noted above.
  {
    const selfDecided = await req('PUT', `/approval-requests/${approvalId}/decision`, {
      headers: PROPOSER_HEADERS,
      body: { decision: 'Approved', note: 'Smoke: SoD refusal (requester deciding their own request)' },
    });
    check(
      `PUT /api/approval-requests/${approvalId}/decision as the proposer (SoD) -> 403`,
      selfDecided.status === 403,
      `status=${selfDecided.status}, body=${JSON.stringify(selfDecided.body)}`,
    );
  }

  // 6) DECIDE — PUT /approval-requests/:id/decision as a DIFFERENT identity
  // than the proposer (SoD-compliant): admin '1' != pm '3'.
  const APPROVER_NOTE = 'Smoke: approved by admin (SoD-compliant decider)';
  {
    const decided = await req('PUT', `/approval-requests/${approvalId}/decision`, {
      headers: DECIDER_HEADERS,
      body: { decision: 'Approved', note: APPROVER_NOTE },
    });
    check(
      `PUT /api/approval-requests/${approvalId}/decision (Approved) -> 200`,
      decided.status === 200 && Boolean(decided.body) && decided.body.status === 'Approved',
      `status=${decided.status}, arStatus=${decided.body && decided.body.status}`,
    );
  }

  // 6b) GAP-A RESTORED (Task 5) — the decision must APPLY to the governed
  // entity, not merely flip the ApprovalRequest. `refId` here is the composite
  // month row `${assignmentId}:${MONTH}`, so the month-aware post-decision hook
  // must move THAT row to 'Allocated', mirror the approver's note onto it, and
  // let `refreshDerivedAssignmentStatus` roll the assignment up. MONTH is the
  // assignment's ONLY month row (created at step 2), so the rollup is
  // unambiguous: one 'Allocated' month -> a derived 'Allocated' assignment.
  {
    const { body: envelope } = await req('GET', `/assignments/${assignmentId}/allocation?from=${MONTH}&to=${MONTH}`, { headers: DECIDER_HEADERS });
    const decidedRow = Array.isArray(envelope?.months) ? envelope.months.find((m) => m.month === MONTH) : undefined;
    check(
      `B3 gap-A restored: the decided month row ${monthRowId} reads 'Allocated'`,
      decidedRow?.status === 'Allocated',
      `row=${JSON.stringify(decidedRow)}`,
    );
    check(
      "B3 gap-A restored: the approver's note is mirrored onto the decided month row",
      decidedRow?.approverNote === APPROVER_NOTE,
      `approverNote=${JSON.stringify(decidedRow?.approverNote)}`,
    );
  }
  {
    const { status, body } = await req('GET', '/assignments', { headers: DECIDER_HEADERS });
    const assig = Array.isArray(body) ? body.find((a) => a.id === assignmentId) : undefined;
    check(
      "B3 gap-A restored: GET /api/assignments shows the governed assignment as 'Allocated' (derived rollup)",
      status === 200 && assig?.status === 'Allocated',
      assig ? `status=${assig.status}` : `status=${status}, missing id=${assignmentId}`,
    );
  }
  // The SINGLE-REQUEST path must write the SAME audit shape the batch does —
  // the record of a decision cannot depend on which endpoint made it. The batch
  // half of this invariant is asserted in checkMonthlyApproval(); this is the
  // other half, on the very same month row decided above.
  {
    const { body: logs } = await req('GET', '/audit-logs?limit=1000', { headers: DECIDER_HEADERS });
    const entry = (Array.isArray(logs) ? logs : []).find((e) => e.path === `/assignment-months/${monthRowId}`);
    check(
      'B3 the single-request decision writes a month-row audit entry, same shape as the batch',
      Boolean(entry) && entry.before?.status === 'Requested' && entry.after?.status === 'Allocated' &&
      Array.isArray(entry.changedKeys) && entry.changedKeys.includes('status') &&
      entry.after?.approverNote === APPROVER_NOTE && entry.actorId === '1' && entry.actorRole === 'admin',
      `entry=${JSON.stringify(entry)}`,
    );
  }

  // 7) REGRESSION CLOSED (B3 carry-forward #2) — a DELETE must withdraw a
  // Pending month approval and drop the month rows, never orphan either. Uses
  // a SEPARATE throwaway assignment (never touches the one decided above) so
  // this section's own state can't interfere.
  {
    const created2 = await req('POST', '/assignments', {
      headers: PROPOSER_HEADERS,
      body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID },
    });
    const created2Ok = check(
      'POST /api/assignments (throwaway, for delete-orphan check) -> 200',
      created2.status === 200 && Boolean(created2.body) && typeof created2.body.id === 'string',
      `status=${created2.status}`,
    );
    if (created2Ok) {
      const assignmentId2 = created2.body.id;
      const MONTH2 = '2026-09';
      const DAY2 = `${MONTH2}-07`; // Monday

      await req('PUT', `/assignments/${assignmentId2}/allocation`, {
        headers: PROPOSER_HEADERS,
        body: { month: MONTH2, dailyHours: { [DAY2]: 1 } },
      });
      const submit2 = await req('POST', `/assignments/${assignmentId2}/months/${MONTH2}/submit`, {
        headers: PROPOSER_HEADERS,
        body: {},
      });
      const submit2Ok = check(
        'B3 delete-orphan setup: submit opens a Pending month approval',
        submit2.status === 200 && typeof submit2.body?.approvalId === 'string',
        `status=${submit2.status}, approvalId=${submit2.body && submit2.body.approvalId}`,
      );
      if (submit2Ok) {
        const orphanApprovalId = submit2.body.approvalId;

        const del2 = await req('DELETE', `/assignments/${assignmentId2}`, { headers: PROPOSER_HEADERS });
        check(`DELETE /api/assignments/${assignmentId2} (has a Pending month approval) -> 204`, del2.status === 204, `status=${del2.status}`);

        const { status: arStatus, body: arList } = await req('GET', '/approval-requests', { headers: DECIDER_HEADERS });
        const ar2 = Array.isArray(arList) ? arList.find((a) => a.id === orphanApprovalId) : undefined;
        check(
          'B3 regression closed: DELETE withdraws the month approval (no longer Pending)',
          arStatus === 200 && Boolean(ar2) && ar2.status !== 'Pending',
          ar2 ? `status=${ar2.status}` : `status=${arStatus}, missing`,
        );

        const { status: goneStatus } = await req('GET', `/assignments/${assignmentId2}/allocation`);
        check(
          `GET /api/assignments/${assignmentId2}/allocation after delete -> 404 (assignment AND its month rows gone)`,
          goneStatus === 404,
          `status=${goneStatus}`,
        );
      }
    }
  }
}

/**
 * Regression guard for the Utilization view's two assignment-creation call
 * sites (src/app/utilization/utilization.component.ts): `saveAssignment()`'s
 * create branch and `pasteAssignment()`. Both used to send
 * `{ requestId, resourceId, assignedHours, status: 'Draft' }` — a shape the
 * server now rejects with 400 (both `status` and `assignedHours` are derived),
 * which
 * is exactly how the Task-7 review caught two live UI flows breaking ("New
 * assignment" / "Paste assignment" in Utilization both failing with the
 * generic "Failed to create assignment." toast). Both call sites were fixed
 * to drop `status` entirely, and the UX remediation wave then removed
 * `assignedHours` from the client-writable surface too (P1-20/OP-04: hours are
 * derived from the day-level allocation rows, so the server rejects the key with
 * 400 exactly as it rejects `status`). The identical payload both call sites now
 * build is `{ requestId, resourceId }`. This check POSTs that exact
 * shape (not the richer PROPOSER_HEADERS-driven shape exercised above) so a
 * future regression in either call site is caught here, not by a user
 * hitting a dead-end toast in the browser.
 */
async function checkUtilizationAssignmentPayload() {
  // Deliberately the default RBAC_HEADERS (admin/resource '1') and NO headers
  // override, since neither utilization.component.ts call site sends one —
  // both rely on api.service.ts's default same-origin auth. requestId/
  // resourceId '1' are seed rows that always exist.
  const payload = { requestId: '1', resourceId: '1' };
  const created = await req('POST', '/assignments', { body: payload });
  const ok = check(
    "POST /api/assignments with the Utilization view's exact create/paste payload (no status) -> 200, derived 'Draft'",
    created.status === 200 && Boolean(created.body) && typeof created.body.id === 'string' && created.body.status === 'Draft',
    `status=${created.status}, body=${JSON.stringify(created.body)}`,
  );
  // Cleanup: this is a disposable assignment (no booked day rows, no window) —
  // remove it so reruns never accumulate cruft in the demo dataset.
  if (ok) await req('DELETE', `/assignments/${created.body.id}`);
}

/**
 * Regression guard for the retarget-propagation fix in `PUT /assignments/:id`
 * (src/server.ts): retargeting an assignment's `resourceId` must re-baseline
 * every month row carrying a LIVE commitment (`Allocated`/`Requested`)
 * against the NEW resource — withdraw any pending approval (it names the OLD
 * resource's manager as approver) and open a fresh one routed to the NEW
 * resource's manager (or auto-approve if the proposer IS the new resource's
 * manager) — while `Draft`/`Rejected` rows, which carry no live commitment,
 * are left exactly as they are. Before this fix, `refreshDerivedAssignmentStatus`
 * only re-rolled the derived status from the EXISTING month rows; a
 * retargeted month kept reading its old status, booked against the new
 * resource, still governed (if any) by an approval naming the OLD resource's
 * manager as the empowered approver.
 *
 * Asserts (a)-(d) below on the retargeted 'Requested' month, plus the two
 * EXCLUDED states, each proved on a real month row of the same assignment:
 * (e) a 'Draft' month survives untouched, and (f) a 'Rejected' month survives
 * untouched (same status, SAME approvalId — the decided approval stays
 * attached; the retarget must not withdraw it or open a replacement). (f) was
 * previously NOT COVERED: no live API call could produce a 'Rejected' month
 * row, because the single-request decision hook resolved `refId` via a bare
 * `repos.assignments.get(refId)` and so no-op'd on a composite month-row id.
 * Task 5's month-aware `applyAllocationDecision` closed that, so (f) is now
 * built through the REAL flow (submit -> reject via
 * PUT /approval-requests/:id/decision as a non-requester), never by writing
 * repo state directly.
 *
 * SEED CHOICE — a resource pair with DIFFERENT managers, and a caller who is
 * the manager of NEITHER, so both the initial submit and the retarget open a
 * genuine Pending approval rather than tripping the self-managed shortcut:
 *   OLD_RESOURCE_ID '2' (John Miller) — managerId '1' (Julie Armstrong).
 *   NEW_RESOURCE_ID '3' (Alice Smith) — managerId '2' (John Miller).
 *   CALLER_HEADERS  X-User-Id '3' / X-User-Role 'pm' -> seed user '3' (Alice
 *     Smith), which actorResourceId() maps to resource-id '3'. Alice is NOT
 *     resource 2's manager ('1' != '3'), so the initial submit is a real
 *     approval, not self-managed; `autoApprovesAllocation` for the retarget
 *     compares the proposer against resource 3's OWN managerId ('2'), which
 *     also != '3' (Alice is not her own manager), so the retarget is a real
 *     approval too, not an auto-approve just because the proposer happens to
 *     BE the resource being staffed.
 */
async function checkResourceRetargetPropagation() {
  const CALLER_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };
  const OLD_RESOURCE_ID = '2'; // John Miller — managerId '1'
  const NEW_RESOURCE_ID = '3'; // Alice Smith — managerId '2'
  const REQUEST_ID = '2'; // Project Beta - UI (any existing request; no role-match validation on assign)
  const MONTH = '2026-06';
  const DAY = `${MONTH}-09`; // Tuesday

  // SETUP 1 — create a throwaway assignment against the OLD resource (no
  // status; server derives 'Draft').
  const created = await req('POST', '/assignments', {
    headers: CALLER_HEADERS,
    body: { requestId: REQUEST_ID, resourceId: OLD_RESOURCE_ID },
  });
  const createOk = check(
    'retarget-propagation setup: POST /api/assignments (no status) -> 200',
    created.status === 200 && Boolean(created.body) && typeof created.body.id === 'string',
    `status=${created.status}`,
  );
  if (!createOk) return;
  const assignmentId = created.body.id;

  // SETUP 2 — book one working day, lazily opening a 'Draft' month row.
  const alloc = await req('PUT', `/assignments/${assignmentId}/allocation`, {
    headers: CALLER_HEADERS,
    body: { month: MONTH, dailyHours: { [DAY]: 1 } },
  });
  check('retarget-propagation setup: PUT .../allocation opens a Draft month row -> 200', alloc.status === 200, `status=${alloc.status}, body=${JSON.stringify(alloc.body)}`);

  // SETUP 3 — submit the month. Non-self-managing proposer -> a genuine
  // Pending approval opens, routed to the OLD resource's manager ('1').
  const submitted = await req('POST', `/assignments/${assignmentId}/months/${MONTH}/submit`, {
    headers: CALLER_HEADERS,
    body: {},
  });
  const submitOk = check(
    "retarget-propagation setup: submit -> 200, status 'Requested' + a real approvalId (not self-managed)",
    submitted.status === 200 && submitted.body?.status === 'Requested' && typeof submitted.body?.approvalId === 'string' && submitted.body.approvalId.length > 0,
    `status=${submitted.status}, monthStatus=${submitted.body?.status}, approvalId=${submitted.body?.approvalId}`,
  );
  if (!submitOk) return;
  const oldApprovalId = submitted.body.approvalId;

  // SETUP 4 — confirm the OLD approval really is routed to resource 2's
  // manager ('1') BEFORE retargeting, so the "before" half of this test is
  // trustworthy (not just an accident of the fixture).
  {
    const { body: arList } = await req('GET', '/approval-requests', { headers: CALLER_HEADERS });
    const oldAr = Array.isArray(arList) ? arList.find((a) => a.id === oldApprovalId) : undefined;
    check(
      "retarget-propagation setup: OLD approval's pending step approverId is resource 2's manager ('1')",
      Boolean(oldAr) && oldAr.status === 'Pending' && oldAr.steps?.[oldAr.currentStep]?.approverId === '1',
      `ar=${JSON.stringify(oldAr)}`,
    );
  }

  // SETUP 5 — a second month on the SAME assignment, left 'Draft' (booked,
  // never submitted). This is the one EXCLUDED, no-live-commitment state
  // actually reachable through the live API today (see the note on the
  // 'Rejected' case below), so it stands in to prove the retarget code's
  // exclusion branch is real, not just "no rows matched": a genuine month
  // row exists on this assignment, is NOT Allocated/Requested, and must come
  // through untouched.
  const DRAFT_MONTH = '2026-08';
  const draftDay = `${DRAFT_MONTH}-04`; // Tuesday
  const draftAlloc = await req('PUT', `/assignments/${assignmentId}/allocation`, {
    headers: CALLER_HEADERS,
    body: { month: DRAFT_MONTH, dailyHours: { [draftDay]: 1 } },
  });
  check('retarget-propagation setup: a second month stays Draft (booked, not submitted)', draftAlloc.status === 200, `status=${draftAlloc.status}`);

  // SETUP 6 — a THIRD month, driven all the way to 'Rejected' through the REAL
  // flow: book -> submit (Draft -> Requested, opening a genuine approval routed
  // to the OLD resource's manager) -> reject it via
  // PUT /approval-requests/:id/decision as admin '1', who is NOT the requester
  // (caller '3'), so the SoD guard does not trip. This is the second EXCLUDED,
  // no-live-commitment state, and until Task 5 made the post-decision hook
  // month-row-aware it was unreachable through the live API at all.
  // 2026-07-07 is a Tuesday (working day, not a seeded holiday); resource 2's
  // cap is 8h/day and nothing else books him heavily that day, so 1h passes.
  const REJECTED_MONTH = '2026-07';
  const rejectedDay = `${REJECTED_MONTH}-07`; // Tuesday
  let rejectedApprovalId;
  {
    const rejAlloc = await req('PUT', `/assignments/${assignmentId}/allocation`, {
      headers: CALLER_HEADERS,
      body: { month: REJECTED_MONTH, dailyHours: { [rejectedDay]: 1 } },
    });
    check('retarget-propagation setup: a third month is booked (Draft)', rejAlloc.status === 200, `status=${rejAlloc.status}, body=${JSON.stringify(rejAlloc.body)}`);

    const rejSubmit = await req('POST', `/assignments/${assignmentId}/months/${REJECTED_MONTH}/submit`, {
      headers: CALLER_HEADERS,
      body: {},
    });
    const rejSubmitOk = check(
      "retarget-propagation setup: the third month submits to 'Requested' with a real approvalId",
      rejSubmit.status === 200 && rejSubmit.body?.status === 'Requested' && typeof rejSubmit.body?.approvalId === 'string',
      `status=${rejSubmit.status}, monthStatus=${rejSubmit.body?.status}, approvalId=${rejSubmit.body?.approvalId}`,
    );
    if (rejSubmitOk) {
      rejectedApprovalId = rejSubmit.body.approvalId;
      const rejected = await req('PUT', `/approval-requests/${rejectedApprovalId}/decision`, {
        headers: { 'X-User-Id': '1', 'X-User-Role': 'admin' },
        body: { decision: 'Rejected', note: 'Smoke: rejected by admin (SoD-compliant decider)' },
      });
      check(
        "retarget-propagation setup: the third month's approval is Rejected by a SoD-compliant decider",
        rejected.status === 200 && rejected.body?.status === 'Rejected',
        `status=${rejected.status}, arStatus=${rejected.body?.status}`,
      );
    }
  }

  // RETARGET — PUT /assignments/:id { resourceId: NEW_RESOURCE_ID }.
  const retargeted = await req('PUT', `/assignments/${assignmentId}`, {
    headers: CALLER_HEADERS,
    body: { resourceId: NEW_RESOURCE_ID },
  });
  check(`PUT /api/assignments/${assignmentId} {resourceId:'${NEW_RESOURCE_ID}'} -> 200`, retargeted.status === 200, `status=${retargeted.status}, body=${JSON.stringify(retargeted.body)}`);

  // Range spans BOTH the retargeted month and the untouched Draft month (e).
  const after = await req('GET', `/assignments/${assignmentId}/allocation?from=${MONTH}&to=${DRAFT_MONTH}`, { headers: CALLER_HEADERS });
  const monthRow = Array.isArray(after.body?.months) ? after.body.months.find((m) => m.month === MONTH) : undefined;

  // (a) the month row came back as 'Requested'.
  check(
    'B3 retarget: month row is Requested again, re-baselined under the new resource',
    monthRow?.status === 'Requested',
    `status=${monthRow?.status}`,
  );
  // (b) it carries a NEW approvalId, different from the old one.
  check(
    'B3 retarget: month row carries a NEW approvalId, different from the old one',
    typeof monthRow?.approvalId === 'string' && monthRow.approvalId.length > 0 && monthRow.approvalId !== oldApprovalId,
    `newApprovalId=${monthRow?.approvalId}, oldApprovalId=${oldApprovalId}`,
  );
  const newApprovalId = monthRow?.approvalId;

  {
    const { body: arList } = await req('GET', '/approval-requests', { headers: CALLER_HEADERS });
    // (c) the old approval is no longer Pending.
    const oldAr = Array.isArray(arList) ? arList.find((a) => a.id === oldApprovalId) : undefined;
    check(
      'B3 retarget: the OLD approval is no longer Pending (withdrawn)',
      Boolean(oldAr) && oldAr.status !== 'Pending',
      oldAr ? `status=${oldAr.status}` : 'missing',
    );
    // (d) the new approval's pending step is routed to the NEW resource's
    // manager (resource 3's managerId '2'), never the old resource's manager.
    const newAr = Array.isArray(arList) ? arList.find((a) => a.id === newApprovalId) : undefined;
    check(
      "B3 retarget: the NEW approval's pending step approverId is the NEW resource's manager ('2')",
      Boolean(newAr) && newAr.status === 'Pending' && newAr.steps?.[newAr.currentStep]?.approverId === '2',
      newAr ? `ar=${JSON.stringify(newAr)}` : `missing id=${newApprovalId}`,
    );
  }

  // (e) the excluded 'Draft' month is untouched: same status, still no
  // approvalId — the retarget's month-row loop never even reaches it.
  const draftRow = Array.isArray(after.body?.months) ? after.body.months.find((m) => m.month === DRAFT_MONTH) : undefined;
  check(
    "B3 retarget: the excluded 'Draft' month survives untouched (same status, no approvalId)",
    draftRow?.status === 'Draft' && draftRow?.approvalId === undefined,
    `status=${draftRow?.status}, approvalId=${draftRow?.approvalId}`,
  );

  // (f) the excluded 'Rejected' month is untouched: SAME status AND the SAME
  // approvalId it was decided under. A retarget must not withdraw a settled
  // decision or open a replacement approval for a month carrying no live
  // commitment — that is the exclusion this row now proves for real.
  const rejectedRow = Array.isArray(after.body?.months) ? after.body.months.find((m) => m.month === REJECTED_MONTH) : undefined;
  check(
    "B3 retarget: the excluded 'Rejected' month survives untouched (same status, same approvalId)",
    rejectedRow?.status === 'Rejected' && rejectedRow?.approvalId === rejectedApprovalId,
    `status=${rejectedRow?.status}, approvalId=${rejectedRow?.approvalId}, expected=${rejectedApprovalId}`,
  );

  // Cleanup: disposable throwaway assignment — delete it so reruns never
  // accumulate cruft (and incidentally re-proves the DELETE fix withdraws the
  // now-Pending NEW approval too).
  const del = await req('DELETE', `/assignments/${assignmentId}`, { headers: CALLER_HEADERS });
  check(`DELETE /api/assignments/${assignmentId} (retarget-propagation cleanup) -> 204`, del.status === 204, `status=${del.status}`);
}

/**
 * Step 4: TIME-PHASED ALLOCATION flow (src/server.ts PUT /planning-periods/:id,
 * GET/PUT /assignments/:id/allocation — B1, Tasks 5-6).
 *
 * IDENTITY — reuses the top-level RBAC_HEADERS (admin). Admin is permitted by
 * both the '/planning-periods' mutation rule (admin-only) and the
 * '/assignments' mutation + READ rules, so no new identity is needed here.
 *
 * ASSIGNMENT/RESOURCE/DAY CHOICES — from src/db/seed.ts, chosen so every gate
 * is exercised deterministically against the demo dataset:
 *
 *   ASSIGNMENT_ID '4' -> resourceId '3' (Alice Smith, contractHoursPerDay 4 —
 *     the seeded PART-TIME resource, so a 4h/day happy-path value sits exactly
 *     AT the cap, and something as small as 5h/day already exceeds it).
 *     Its booking window is 2026-05-01..2026-07-31, so MONTH '2026-05' falls
 *     fully inside it. Resource 3's OTHER assignment (id '5') books
 *     2026-08-01..2026-09-30 — no overlap with May — so the capacity gate
 *     below sees no contribution from any other assignment on the chosen days.
 *
 *   MONTH '2026-05' — 2026-05-01 is a Friday (task doc), so:
 *     WORKING_DAYS_HOURS '2026-05-05'/'06'/'07' = Tue/Wed/Thu (working days,
 *       verified via UTC getUTCDay()), hours=4 each == the resource's cap
 *       exactly (boundary case: 4 > 4+epsilon is false, so it must PASS).
 *     WEEKEND_DAY '2026-05-09' = Saturday -> working-day gate must reject it.
 *     OVER_CAPACITY_DAY '2026-05-11' = Monday (a working day, untouched by the
 *       happy-path days above) with hours=6 > cap 4 -> capacity gate must
 *       reject it.
 *
 * Every negative case (closed-month / weekend / over-capacity) 400s/403s
 * BEFORE the handler mutates any assignmentDays row (confirmed by reading
 * src/server.ts: all three gates return before the withLock() day-replace
 * step), so none of them perturb assignment 4's state for later checks.
 *
 * Kept in its OWN try/catch in main() so an unexpected failure here never
 * masks or blocks the pre-existing checkReads()/checkCrud()/
 * checkAllocationApproval() results.
 */
async function checkTimePhasedAllocation() {
  const ASSIGNMENT_ID = '4';
  const MONTH = '2026-05';
  const WORKING_DAYS_HOURS = { '2026-05-05': 4, '2026-05-06': 4, '2026-05-07': 4 };
  const WEEKEND_DAY = '2026-05-09';
  const OVER_CAPACITY_DAY = '2026-05-11';

  /** Sum the `hours` of a list of {date, hours} rows, optionally filtered by month. */
  const sumHours = (days, monthPrefix) =>
    (Array.isArray(days) ? days : [])
      .filter((d) => monthPrefix === undefined || !d.date.startsWith(monthPrefix))
      .reduce((s, d) => s + (typeof d.hours === 'number' ? d.hours : 0), 0);

  // 1) Open the month. PUT /planning-periods/:id upserts (no prior row needed).
  {
    const opened = await req('PUT', `/planning-periods/${MONTH}`, { body: { status: 'Open' } });
    check(
      `PUT /api/planning-periods/${MONTH} {status:'Open'} -> 200`,
      opened.status === 200 && Boolean(opened.body) && opened.body.status === 'Open',
      `status=${opened.status}, body.status=${opened.body && opened.body.status}`,
    );
  }

  // Snapshot ALL of assignment 4's day rows BEFORE the edit (GET with no
  // from/to defaults to the assignment's full spanned range), so the expected
  // post-edit assignedHours can be computed from live data, never hard-coded.
  // The envelope's `months` (B3) also lets us pin the MONTH row's pre-edit
  // approvalId — the governing approval now lives there, not on the assignment
  // (see the B3 note below).
  let otherMonthsHoursBefore = 0;
  let preEditMonthApprovalId;
  {
    const { status, body } = await req('GET', `/assignments/${ASSIGNMENT_ID}/allocation`);
    check(`GET /api/assignments/${ASSIGNMENT_ID}/allocation (pre-edit) -> 200`, status === 200, `status=${status}`);
    otherMonthsHoursBefore = sumHours(body && body.days, MONTH);
    const monthRow = Array.isArray(body && body.months) ? body.months.find((m) => m.month === MONTH) : undefined;
    preEditMonthApprovalId = monthRow && monthRow.approvalId;
  }

  // Snapshot assignment 4's governance state BEFORE the edit. The allocation GET
  // above omits status (it's an assignment field), so read the assignment row
  // itself. The FORCED RE-APPROVAL contract (src/server.ts STEP 2) demotes an
  // 'Allocated' assignment to 'Requested' on ANY day-row edit by a
  // non-self-managing actor (resource 3's manager is '2'; the smoke admin maps
  // to resourceId '1'), opening a fresh approval. Pinning status here defends
  // that trigger against a future refactor to a (wrong) assignedHours-delta
  // condition. B3: the fresh approval itself is opened on the MONTH row (see
  // preEditMonthApprovalId above) — `assig.approvalId` is no longer written by
  // this endpoint, so it is not pinned here.
  let preEditStatus;
  {
    const { status, body } = await req('GET', '/assignments');
    const assig = Array.isArray(body) ? body.find((a) => a.id === ASSIGNMENT_ID) : undefined;
    preEditStatus = assig && assig.status;
    check(
      `GET /api/assignments — assignment ${ASSIGNMENT_ID} is 'Allocated' before the edit (re-approval precondition)`,
      status === 200 && Boolean(assig) && preEditStatus === 'Allocated',
      assig ? `status=${preEditStatus}` : `status=${status}, missing`,
    );
  }

  // 2) HAPPY PATH — replace May's days with 3 working days at exactly the
  // resource's daily cap (4h). Expect 200, the echoed `days` to match what was
  // sent, and `assignedHours` to equal (unchanged other-month hours) + (new
  // May hours) — the endpoint's documented "days are the source of truth" rule.
  const newMonthHours = Object.values(WORKING_DAYS_HOURS).reduce((s, h) => s + h, 0);
  {
    const put = await req('PUT', `/assignments/${ASSIGNMENT_ID}/allocation`, {
      body: { month: MONTH, dailyHours: WORKING_DAYS_HOURS },
    });
    const putOk = check(
      `PUT /api/assignments/${ASSIGNMENT_ID}/allocation (happy path, 3 working days @ cap) -> 200`,
      put.status === 200,
      `status=${put.status}, body=${JSON.stringify(put.body)}`,
    );
    if (putOk) {
      const days = Array.isArray(put.body.days) ? put.body.days.slice().sort((a, b) => a.date.localeCompare(b.date)) : [];
      const expectedDays = Object.entries(WORKING_DAYS_HOURS).sort(([a], [b]) => a.localeCompare(b));
      const daysMatch =
        days.length === expectedDays.length &&
        expectedDays.every(([date, hours], i) => days[i] && days[i].date === date && days[i].hours === hours);
      check(
        `PUT response 'days' for ${MONTH} match the sent dailyHours`,
        daysMatch,
        `days=${JSON.stringify(days)}`,
      );

      const expectedTotal = otherMonthsHoursBefore + newMonthHours;
      check(
        `PUT response 'assignedHours' == other-months hours + new ${MONTH} hours`,
        Math.abs(put.body.assignedHours - expectedTotal) < 1e-6,
        `assignedHours=${put.body.assignedHours}, expected=${expectedTotal}`,
      );

      // FORCED RE-APPROVAL: editing an 'Allocated' assignment's days must demote
      // it to 'Requested' (the derived rollup of its months, B3) — driven by the
      // edited MONTH's prior status being 'Allocated', not by any assignedHours
      // delta.
      check(
        `PUT response demotes 'Allocated' -> 'Requested' (forced re-approval)`,
        put.body.status === 'Requested',
        `preEditStatus=${preEditStatus}, status=${put.body.status}`,
      );

      // Independent verification via GET: assignedHours must equal the sum of
      // ALL the assignment's day rows (every month), not just the edited one.
      const after = await req('GET', `/assignments/${ASSIGNMENT_ID}/allocation`);
      const totalFromDays = sumHours(after.body && after.body.days);
      check(
        `GET /api/assignments/${ASSIGNMENT_ID}/allocation sum(days.hours) == assignedHours`,
        after.status === 200 && Math.abs(totalFromDays - put.body.assignedHours) < 1e-6,
        `status=${after.status}, sum(days)=${totalFromDays}, assignedHours=${put.body.assignedHours}`,
      );

      // FORCED RE-APPROVAL, continued (B3): the fresh approval is opened on the
      // edited MONTH row, not the assignment — assert the month's approvalId is
      // a non-empty string that differs from its pre-edit value (undefined here;
      // assignment 4's May row carries no approval in the seed).
      const editedMonthRow = Array.isArray(after.body && after.body.months)
        ? after.body.months.find((m) => m.month === MONTH)
        : undefined;
      check(
        `GET .../allocation month row for ${MONTH} carries a fresh approvalId (!= pre-edit)`,
        Boolean(editedMonthRow) && typeof editedMonthRow.approvalId === 'string' && editedMonthRow.approvalId.length > 0
          && editedMonthRow.approvalId !== preEditMonthApprovalId,
        `preEditMonthApprovalId=${preEditMonthApprovalId}, monthRow=${JSON.stringify(editedMonthRow)}`,
      );
    }
  }

  // 3) NEGATIVE — open-month gate. Close the month, attempt an edit -> 403.
  // Re-open immediately after so steps 4-6 (which need MONTH Open) aren't blocked.
  {
    const closed = await req('PUT', `/planning-periods/${MONTH}`, { body: { status: 'Closed' } });
    check(`PUT /api/planning-periods/${MONTH} {status:'Closed'} -> 200`, closed.status === 200, `status=${closed.status}`);

    const blocked = await req('PUT', `/assignments/${ASSIGNMENT_ID}/allocation`, {
      body: { month: MONTH, dailyHours: { '2026-05-06': 4 } },
    });
    check(
      `PUT .../allocation on a Closed month -> 403`,
      blocked.status === 403 && String((blocked.body && blocked.body.error) || '').toLowerCase().includes('not open'),
      `status=${blocked.status}, body=${JSON.stringify(blocked.body)}`,
    );

    const reopened = await req('PUT', `/planning-periods/${MONTH}`, { body: { status: 'Open' } });
    check(`PUT /api/planning-periods/${MONTH} {status:'Open'} (re-open) -> 200`, reopened.status === 200, `status=${reopened.status}`);
  }

  // 4) NEGATIVE — working-day gate. WEEKEND_DAY (Saturday) carries hours > 0
  // in an Open month -> 400.
  {
    const weekend = await req('PUT', `/assignments/${ASSIGNMENT_ID}/allocation`, {
      body: { month: MONTH, dailyHours: { [WEEKEND_DAY]: 4 } },
    });
    check(
      `PUT .../allocation with hours on weekend day ${WEEKEND_DAY} -> 400`,
      weekend.status === 400,
      `status=${weekend.status}, body=${JSON.stringify(weekend.body)}`,
    );
  }

  // 5) NEGATIVE — daily-capacity gate. OVER_CAPACITY_DAY is a working day but
  // hours (6) exceed resource 3's contractHoursPerDay (4) -> 400 with the
  // "daily capacity exceeded" message.
  {
    const overCap = await req('PUT', `/assignments/${ASSIGNMENT_ID}/allocation`, {
      body: { month: MONTH, dailyHours: { [OVER_CAPACITY_DAY]: 6 } },
    });
    check(
      `PUT .../allocation over daily capacity on ${OVER_CAPACITY_DAY} -> 400 'daily capacity exceeded'`,
      overCap.status === 400 && String((overCap.body && overCap.body.error) || '').includes('daily capacity exceeded'),
      `status=${overCap.status}, body=${JSON.stringify(overCap.body)}`,
    );
  }

  // 5b) NEGATIVE — calendar-date integrity (I-1). Syntax-valid but calendar-
  // INVALID day keys must 400 BEFORE any mutation (they precede the open-month
  // gate, so no planning period is needed for the rollover month). All three
  // are no-ops against assignment 4's state.
  {
    // Impossible day (May has 31 days) → Invalid Date, must not slip past as a
    // phantom working day.
    const badDay = await req('PUT', `/assignments/${ASSIGNMENT_ID}/allocation`, {
      body: { month: MONTH, dailyHours: { '2026-05-32': 4 } },
    });
    check(
      `PUT .../allocation with calendar-invalid day key 2026-05-32 -> 400`,
      badDay.status === 400 && String((badDay.body && badDay.body.error) || '').toLowerCase().includes('invalid calendar date'),
      `status=${badDay.status}, body=${JSON.stringify(badDay.body)}`,
    );

    // Rollover: '2026-04-31' under month '2026-04' resolves to May 1 — must be
    // rejected so it can never alias the real 2026-05-01 row (capacity bypass).
    const rollover = await req('PUT', `/assignments/${ASSIGNMENT_ID}/allocation`, {
      body: { month: '2026-04', dailyHours: { '2026-04-31': 4 } },
    });
    check(
      `PUT .../allocation with rollover day key 2026-04-31 (month 2026-04) -> 400`,
      rollover.status === 400 && String((rollover.body && rollover.body.error) || '').toLowerCase().includes('invalid calendar date'),
      `status=${rollover.status}, body=${JSON.stringify(rollover.body)}`,
    );

    // Out-of-range month (13) must fail the range-checked YYYY-MM guard.
    const badMonth = await req('PUT', `/assignments/${ASSIGNMENT_ID}/allocation`, {
      body: { month: '2026-13', dailyHours: {} },
    });
    check(
      `PUT .../allocation with out-of-range month 2026-13 -> 400`,
      badMonth.status === 400,
      `status=${badMonth.status}, body=${JSON.stringify(badMonth.body)}`,
    );
  }

  // 6) DELETE CLEANUP — create a throwaway assignment (B3: no client status;
  // the server derives 'Draft' — never touches seed data), allocate one day
  // on it, then delete it and confirm 204 (never 409 — assignmentDays must be
  // removed before the parent row) with no orphan left behind (a follow-up
  // allocation GET 404s because the assignment itself is gone).
  {
    const created = await req('POST', '/assignments', {
      body: { requestId: '1', resourceId: '1' },
    });
    const createOk = check(
      'POST /api/assignments (throwaway, for delete-cleanup) -> 200',
      created.status === 200 && Boolean(created.body) && typeof created.body.id === 'string' && created.body.status === 'Draft',
      `status=${created.status}, id=${created.body && created.body.id}, assignmentStatus=${created.body && created.body.status}`,
    );
    if (createOk) {
      const throwawayId = created.body.id;

      const alloc = await req('PUT', `/assignments/${throwawayId}/allocation`, {
        body: { month: MONTH, dailyHours: { '2026-05-12': 1 } },
      });
      check(
        `PUT /api/assignments/${throwawayId}/allocation (allocate 1 day) -> 200`,
        alloc.status === 200 && Array.isArray(alloc.body.days) && alloc.body.days.length === 1,
        `status=${alloc.status}, days=${JSON.stringify(alloc.body && alloc.body.days)}`,
      );

      const del = await req('DELETE', `/assignments/${throwawayId}`);
      check(`DELETE /api/assignments/${throwawayId} (has day rows) -> 204, not 409`, del.status === 204, `status=${del.status}`);

      const { status: goneStatus } = await req('GET', `/assignments/${throwawayId}/allocation`);
      check(`GET /api/assignments/${throwawayId}/allocation after delete -> 404 (no orphan)`, goneStatus === 404, `status=${goneStatus}`);

      const { body: assigList } = await req('GET', '/assignments');
      const stillThere = Array.isArray(assigList) ? assigList.some((a) => a.id === throwawayId) : true;
      check(`GET /api/assignments after delete no longer includes id ${throwawayId}`, !stillThere, stillThere ? 'row still present' : 'removed');
    }
  }
}

/**
 * Step 5: MONTHLY FTE CAPACITY rollup (src/server.ts GET /capacity/monthly —
 * B2, computed read over resources/assignments/assignmentDays).
 *
 * IDENTITY — reuses the top-level RBAC_HEADERS (admin) for every request
 * except the RBAC-negative case below, which swaps in an 'employee' role
 * (not in the '/capacity' READ_RULE's allowed roles, so it must 403).
 *
 * SEED FACTS (cross-checked by manual curl against the running demo data):
 *   - from=2026-05&to=2026-07 -> months includes 2026-05/06/07, and there is
 *     at least one row for resourceId '1' (Julie Armstrong).
 *   - the default range (no from/to) -> months.length >= 1 (2026-04..2026-09
 *     today, but that window shifts over time with the Open-planning-period
 *     default, so only the structural fact is asserted).
 *
 * The band/ftePlanned assertion is CONCORDANCE-based, not a hard-coded band:
 * it recomputes the expected band from the response's own ftePlanned using
 * the same lower-bound-inclusive thresholds as src/app/services/capacity.util.ts
 * (semaphoreBand: pct<50 idle, pct<85 under, pct<=105 healthy, else over), so
 * this check can never go stale if seed hours change.
 *
 * Kept in its OWN try/catch in main() so an unexpected failure here never
 * masks or blocks any of the prior section results.
 */
async function checkCapacityMonthly() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'employee' };
  const HAPPY_PATH = '/capacity/monthly?from=2026-05&to=2026-07';
  const SEED_MONTH = '2026-05';
  const SEED_RESOURCE_ID = '1';

  /** Same lower-bound-inclusive thresholds as capacity.util.ts semaphoreBand(). */
  const expectedBand = (pct) => {
    if (pct < 50) return 'idle';
    if (pct < 85) return 'under';
    if (pct <= 105 + 1e-9) return 'healthy';
    return 'over';
  };

  // 1) HAPPY PATH.
  {
    const { status, body } = await req('GET', HAPPY_PATH);
    const okStatus = check(`GET /api${HAPPY_PATH} (admin) -> 200`, status === 200, `status=${status}`);
    if (!okStatus) return; // nothing more to verify without a body

    const months = Array.isArray(body.months) ? body.months : [];
    check(
      "response 'months' includes 2026-05, 2026-06, 2026-07",
      ['2026-05', '2026-06', '2026-07'].every((m) => months.includes(m)),
      `months=${JSON.stringify(months)}`,
    );

    const rows = Array.isArray(body.rows) ? body.rows : [];
    const row1 = rows.find((r) => r.resourceId === SEED_RESOURCE_ID);
    check(
      `response 'rows' includes resourceId '${SEED_RESOURCE_ID}'`,
      Boolean(row1),
      row1 ? `resourceName="${row1.resourceName}"` : `rows=${JSON.stringify(rows.map((r) => r.resourceId))}`,
    );

    const cell = row1 && row1.monthly ? row1.monthly[SEED_MONTH] : undefined;
    if (cell) {
      const wantBand = expectedBand(cell.ftePlanned * 100);
      check(
        `row ${SEED_RESOURCE_ID} ${SEED_MONTH} band matches ftePlanned*100 (concordance)`,
        cell.band === wantBand,
        `ftePlanned=${cell.ftePlanned}, pct=${cell.ftePlanned * 100}, band=${cell.band}, expected=${wantBand}`,
      );
    } else {
      check(
        `row ${SEED_RESOURCE_ID} has a ${SEED_MONTH} cell (band concordance, skipped)`,
        true,
        'resource inactive that month — no cell to check, not a failure',
      );
    }

    const totals = body.totals || {};
    const t = totals[SEED_MONTH];
    check(
      `response 'totals[${SEED_MONTH}]' exists with numeric capacityFte and resourceCount >= 1`,
      Boolean(t) && typeof t.capacityFte === 'number' && Number.isFinite(t.capacityFte) && typeof t.resourceCount === 'number' && t.resourceCount >= 1,
      t ? `capacityFte=${t.capacityFte}, resourceCount=${t.resourceCount}` : `missing totals[${SEED_MONTH}]`,
    );
  }

  // 2) VALIDATION — out-of-range month values -> 400.
  {
    const { status, body } = await req('GET', '/capacity/monthly?from=2026-13&to=2026-14');
    check(
      'GET /api/capacity/monthly?from=2026-13&to=2026-14 -> 400',
      status === 400,
      `status=${status}, body=${JSON.stringify(body)}`,
    );
  }

  // 2b) VALIDATION — from > to -> 400.
  {
    const { status, body } = await req('GET', '/capacity/monthly?from=2026-08&to=2026-05');
    check(
      'GET /api/capacity/monthly?from=2026-08&to=2026-05 (from>to) -> 400',
      status === 400,
      `status=${status}, body=${JSON.stringify(body)}`,
    );
  }

  // 3) RBAC — 'employee' is not in the '/capacity' READ_RULE roles -> 403.
  {
    const { status, body } = await req('GET', HAPPY_PATH, { headers: EMPLOYEE_HEADERS });
    check(
      `GET /api${HAPPY_PATH} as 'employee' -> 403`,
      status === 403,
      `status=${status}, body=${JSON.stringify(body)}`,
    );
  }

  // 4) DEFAULT RANGE — no from/to -> 200 and at least one month.
  {
    const { status, body } = await req('GET', '/capacity/monthly');
    const months = body && Array.isArray(body.months) ? body.months : [];
    check(
      'GET /api/capacity/monthly (no params, admin) -> 200, months.length >= 1',
      status === 200 && months.length >= 1,
      `status=${status}, months=${JSON.stringify(months)}`,
    );
  }
}

/**
 * Block F — `/bench/monthly`: the pre-aggregated 6-month BENCH/PARTIAL/
 * ALLOCATED rollup + hiring demand. Same READ_RULE roles as `/capacity`
 * (extended, not duplicated — design spec §8); 'employee' must be refused.
 *
 * Round-1 review addition: the 9-month FETCH window (2 look-back + 6 shown +
 * 1 look-ahead, `src/server.ts:3629-3633`) has its own boundary checks below,
 * because the response's `months` field is `displayMonths` — computed
 * independently of `fetchFrom`/`fetchTo` — so the plain "6 months 04..09"
 * assertion above cannot observe either edge of that window. Both new checks
 * hit the LIVE endpoint (bench.util.spec.ts already covers the pure function
 * with hand-built arrays; this is the "through the server" gap that left
 * unobserved).
 */
async function checkBenchMonthly() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'employee' };
  const HAPPY_PATH = '/bench/monthly?from=2026-04';

  const { status, body } = await req('GET', HAPPY_PATH);
  const okStatus = check(`GET /api${HAPPY_PATH} (admin) -> 200`, status === 200, `status=${status}`);
  if (!okStatus) return;

  check(
    "response 'months' is exactly the 6 shown months 2026-04..2026-09",
    Array.isArray(body.months) && body.months.length === 6 && body.months[0] === '2026-04' && body.months[5] === '2026-09',
    `months=${JSON.stringify(body.months)}`,
  );

  const subco6 = (body.subcoRows || []).find((r) => r.resourceId === '6');
  check("subcoRows includes resource '6' (subco) with April PARTIAL", Boolean(subco6) && subco6.monthly['2026-04']?.state === 'PARTIAL', JSON.stringify(subco6?.monthly?.['2026-04']));
  check("resource '6' is NEVER in internalRows", !(body.internalRows || []).some((r) => r.resourceId === '6'), 'found in internalRows');

  check(
    'no dummy resource id (4 or 5) appears in internalRows or subcoRows',
    !['4', '5'].some((id) => (body.internalRows || []).some((r) => r.resourceId === id) || (body.subcoRows || []).some((r) => r.resourceId === id)),
    'a dummy id leaked into a bench row list',
  );

  const hiring4 = (body.hiringDemand || []).filter((h) => h.role === 'Developer' && h.hours > 0);
  // Exactly 6 (one per shown month), not '>=' — '>=' would not catch a
  // duplicate hiring-demand row for the same (month, role) pair (latent
  // today: hiringDemandByMonth's Map-based aggregation cannot produce one,
  // but the assertion shouldn't rely on that being true forever).
  check('hiringDemand has EXACTLY 6 Developer rows (one per shown month) with hours > 0', hiring4.length === 6, `count=${hiring4.length}`);

  // FETCH-WINDOW LOOK-AHEAD (+1 on fetchTo) — resource '7' (Priya Kapoor):
  // ALLOCATED every shown month (never BENCH in the display window), so its
  // ONLY way to reveal itself as about to free up is the look-ahead month
  // (October, never itself returned as a row). Mirrors
  // bench.util.spec.ts:256-268's three-part assertion, but through the live
  // endpoint. Dropping the `+ 1` on `fetchTo` removes October from the fetch
  // window entirely, which flips September's flag to false (no next month to
  // read) while leaving everything else identical — this is the only seeded
  // resource that can observe that specific edge.
  const priya = (body.internalRows || []).find((r) => r.resourceId === '7');
  check(
    "resource '7' (Priya Kapoor, internal): ALLOCATED all 6 shown months -> availabilityDate is beyond-horizon at 2026-09",
    Boolean(priya) && priya.availabilityDate?.kind === 'beyond-horizon' && priya.availabilityDate?.horizonEndMonth === '2026-09',
    JSON.stringify(priya?.availabilityDate),
  );
  check(
    "resource '7' September upcomingUnallocated is true — visible ONLY via the un-displayed October look-ahead month",
    priya?.monthly?.['2026-09']?.upcomingUnallocated === true,
    JSON.stringify(priya?.monthly?.['2026-09']),
  );
  check(
    "resource '7' August upcomingUnallocated is false — paired absence: August's next month (September) is still ALLOCATED, so a hard-coded 'true' would leave the September check above green too",
    priya?.monthly?.['2026-08']?.upcomingUnallocated === false,
    JSON.stringify(priya?.monthly?.['2026-08']),
  );

  // FETCH-WINDOW LOOK-BACK (from - 2 on fetchFrom) — resource '1' (Julie
  // Armstrong): no assignment starts before 2026-05, so she is idle straight
  // through the whole 9-month fetch window. April (the FIRST shown month)
  // needs BOTH extra look-back months (Feb + Mar) to correctly count 3
  // consecutive idle months and cap at bucket 'D'; with only one look-back
  // month the count undercounts to 'C'. May onward never needs more than one
  // look-back month (spec §8's own math), so April is the only cell that can
  // observe this specific edge. NOTE: this is NOT caught by the resource '7'
  // checks above — '7' is never BENCH in the display window, so the aging
  // path is never exercised for it; this look-back edge needs its own
  // resource.
  const julie = (body.internalRows || []).find((r) => r.resourceId === '1');
  check(
    "resource '1' (Julie Armstrong) April agingBucket is 'D' — only reachable by fetching BOTH look-back months",
    julie?.monthly?.['2026-04']?.agingBucket === 'D',
    JSON.stringify(julie?.monthly?.['2026-04']),
  );

  const { status: empStatus } = await req('GET', '/bench/monthly', { headers: EMPLOYEE_HEADERS });
  check('GET /api/bench/monthly (employee) -> 403', empStatus === 403, `status=${empStatus}`);

  // VALIDATION — malformed 'from' -> 400 (mirrors checkCapacityMonthly's own validation step).
  {
    const { status: badStatus } = await req('GET', '/bench/monthly?from=2026-13');
    check('GET /api/bench/monthly?from=2026-13 -> 400', badStatus === 400, `status=${badStatus}`);
  }

  // DEFAULT RANGE — no 'from' -> 200, defaulting to the first Open planning
  // period (2026-04 in this seed, same as the explicit happy path above — so
  // this genuinely exercises the default-resolution branch, not just "some
  // month").
  {
    const { status: defStatus, body: defBody } = await req('GET', '/bench/monthly');
    check(
      'GET /api/bench/monthly (no params, admin) -> 200, defaults from to the first Open planning period (2026-04)',
      defStatus === 200 && Array.isArray(defBody.months) && defBody.months[0] === '2026-04',
      `status=${defStatus}, months=${JSON.stringify(defBody && defBody.months)}`,
    );
  }
}

/**
 * Block F/E shared plumbing — raw `/assignment-days` and `/assignment-months`
 * reads (Task 4). No server-side rollup: these exist so the What-If sandbox
 * (which mutates resources/requests only in memory and can never round-trip
 * through the server) can compose `benchRollup` client-side. Same READ_RULE
 * roles as `/capacity` and `/assignments` — 'employee' must be refused.
 */
async function checkAssignmentRawReads() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'employee' };

  // 1) HAPPY PATH — /assignment-days: seeded rows, each shaped {assignmentId, date, hours}.
  {
    const { status, body } = await req('GET', '/assignment-days');
    check('GET /api/assignment-days (admin) -> 200', status === 200, `status=${status}`);
    check('response is an array with at least the seeded rows', Array.isArray(body) && body.length > 0, `length=${Array.isArray(body) ? body.length : 'n/a'}`);
    const row = Array.isArray(body) ? body[0] : undefined;
    check(
      'a row has assignmentId/date/hours',
      Boolean(row) && typeof row.assignmentId === 'string' && typeof row.date === 'string' && typeof row.hours === 'number',
      JSON.stringify(row),
    );
  }

  // 2) HAPPY PATH — /assignment-months: seeded rows.
  {
    const { status, body } = await req('GET', '/assignment-months');
    check('GET /api/assignment-months (admin) -> 200', status === 200, `status=${status}`);
    check('response is an array with at least the seeded rows', Array.isArray(body) && body.length > 0, `length=${Array.isArray(body) ? body.length : 'n/a'}`);
  }

  // 3) RBAC — 'employee' is not in the shared READ_RULE roles -> 403, on EACH path separately.
  {
    const { status } = await req('GET', '/assignment-days', { headers: EMPLOYEE_HEADERS });
    check('GET /api/assignment-days (employee) -> 403', status === 403, `status=${status}`);
  }
  {
    const { status } = await req('GET', '/assignment-months', { headers: EMPLOYEE_HEADERS });
    check('GET /api/assignment-months (employee) -> 403', status === 403, `status=${status}`);
  }
}

/**
 * Block E, Task 3 — the narrow CONTENT check `checkAssignmentRawReads` above
 * (Block F) does not cover: it pins shape and COUNT only ("a row has
 * assignmentId/date/hours", "length > 0"), so it stays green even if block
 * E's own seeded fixture (assignment '12', request '12', resource '2' John
 * Miller, 2026-10-05, 8h — src/db/seed.ts, Task 1 of the block E plan) stopped
 * flowing through these two shared endpoints entirely. Additive only: no new
 * routes, no duplicate client methods, does not touch `checkAssignmentRawReads`
 * or any route/RBAC Block F owns.
 */
async function checkAssignmentDaysAndMonthsCarryBlockESeed() {
  const days = await req('GET', '/assignment-days');
  check(
    "GET /api/assignment-days includes assignment '12''s 2026-10-05 day (8h) — block E's Task 1 seed",
    Array.isArray(days.body) && days.body.some(d => d.assignmentId === '12' && d.date === '2026-10-05' && d.hours === 8),
    JSON.stringify(Array.isArray(days.body) ? days.body.filter(d => d.assignmentId === '12') : days.body),
  );

  const months = await req('GET', '/assignment-months');
  check(
    "GET /api/assignment-months includes '12:2026-10' with status Allocated — block E's Task 1 seed",
    Array.isArray(months.body) && months.body.some(m => m.id === '12:2026-10' && m.status === 'Allocated'),
    JSON.stringify(Array.isArray(months.body) ? months.body.find(m => m.id === '12:2026-10') : months.body),
  );

  // Cross-check via the pre-existing /assignments endpoint (not owned by this
  // task) that the row actually IS resource '2' on request '12', matching the
  // seed comment in src/db/seed.ts exactly.
  const assignments = await req('GET', '/assignments');
  const a12 = Array.isArray(assignments.body) ? assignments.body.find(a => a.id === '12') : undefined;
  check(
    "assignment '12' (via /assignments) is booked for resource '2' on request '12'",
    Boolean(a12) && a12.resourceId === '2' && a12.requestId === '12',
    JSON.stringify(a12),
  );
}

/**
 * Design spec, block E, §5/§6 — the freeze handler's integrity rules and RBAC.
 * Seed fixtures relied on (src/db/seed.ts, Task 1): project '1' has booked
 * hours (assignments '1'/'2'/'12', plus block F's '7'-'11', all Jan-Sep 2026);
 * '12' alone reaches October, priced at exactly 720 EUR (8h x 90 EUR/h,
 * resource '2' John Miller) — the hand-verified figure this check pins.
 */
async function checkCostBaselines() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '9', 'X-User-Role': 'employee' };
  const PM_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };

  // 1) POST /cost-baselines { projectId: '1' } -> 200, one row per booked
  //    period, October priced at exactly 720 EUR (Task 1's hand-verified figure).
  const frozen = await req('POST', '/cost-baselines', { body: { projectId: '1' } });
  check('POST /api/cost-baselines {projectId:\'1\'} -> 200', frozen.status === 200, `status=${frozen.status}`);
  check(
    'the frozen batch includes a 2026-10 row priced at exactly 720 EUR',
    Array.isArray(frozen.body) && frozen.body.some(r => r.period === '2026-10' && r.amount === 720),
    JSON.stringify(frozen.body),
  );
  check(
    "every frozen row carries a server-set frozenBy/frozenAt, and projectId '1'",
    Array.isArray(frozen.body) && frozen.body.every(r => r.projectId === '1' && typeof r.frozenBy === 'string' && typeof r.frozenAt === 'string'),
  );

  // 2) A client-supplied amount/period/frozenAt/frozenBy is silently ignored
  //    (not a 400) — pick()'s allow-list is ['projectId'] only.
  const forged = await req('POST', '/cost-baselines', { body: { projectId: '1', amount: 999999, frozenBy: 'nobody' } });
  check('POST /api/cost-baselines ignores a forged amount/frozenBy rather than erroring', forged.status === 200, `status=${forged.status}`);
  check(
    'the forged amount never lands in a written row',
    Array.isArray(forged.body) && forged.body.every(r => r.amount !== 999999 && r.frozenBy !== 'nobody'),
  );

  // 3) projectId missing -> 400.
  const missing = await req('POST', '/cost-baselines', { body: {} });
  check('POST /api/cost-baselines with no projectId -> 400', missing.status === 400, `status=${missing.status}`);

  // 4) projectId referencing a non-existent project -> 400.
  const badProject = await req('POST', '/cost-baselines', { body: { projectId: 'NOPE_PROJECT' } });
  check('POST /api/cost-baselines with an unknown projectId -> 400', badProject.status === 400, `status=${badProject.status}`);

  // 5) A second POST on the same project is a re-freeze, NOT rejected, and
  //    writes a SECOND batch of rows (the earlier row for 2026-10 is not
  //    replaced or deleted — GET must still list both, latest wins in the UI).
  const before = await req('GET', '/cost-baselines');
  const countBefore = Array.isArray(before.body) ? before.body.filter(r => r.projectId === '1' && r.period === '2026-10').length : 0;
  const refrozen = await req('POST', '/cost-baselines', { body: { projectId: '1' } });
  check('a second POST /api/cost-baselines for the same project -> 200 (re-freeze, not rejected)', refrozen.status === 200, `status=${refrozen.status}`);
  const after = await req('GET', '/cost-baselines');
  const countAfter = Array.isArray(after.body) ? after.body.filter(r => r.projectId === '1' && r.period === '2026-10').length : 0;
  check('the re-freeze APPENDS a new 2026-10 row rather than replacing the old one', countAfter === countBefore + 1, `before=${countBefore} after=${countAfter}`);

  // 6) No PUT/DELETE registered.
  const put = await req('PUT', '/cost-baselines/CB1', { body: { amount: 1 } });
  check('PUT /api/cost-baselines/:id -> 404 (no route registered)', put.status === 404, `status=${put.status}`);
  const del = await req('DELETE', '/cost-baselines/CB1');
  check('DELETE /api/cost-baselines/:id -> 404 (no route registered)', del.status === 404, `status=${del.status}`);

  // 7) RBAC — mutation restricted to finance/delivery-executive/admin; a pm
  //    (who CAN read the baseline, per §5) must NOT be able to freeze it.
  const pmForbidden = await req('POST', '/cost-baselines', { body: { projectId: '1' } , headers: PM_HEADERS });
  check("POST /api/cost-baselines as a 'pm' -> 403 (read access does not imply write access)", pmForbidden.status === 403, `status=${pmForbidden.status}`);

  // 8) RBAC — read restricted to pm/resource-manager/finance/delivery-executive/admin,
  //    denied to employee/sales. Full matrix exercised here — this is the
  //    over-the-wire debt explicitly recorded when Task 1 added the client
  //    methods/type ahead of this route: "the read rule admits
  //    pm/resource-manager/finance/delivery-executive/admin and denies
  //    employee/sales" — every one of those seven roles gets its own
  //    assertion below, not just a sampled pair.
  const SALES_HEADERS = { 'X-User-Id': '5', 'X-User-Role': 'sales' };
  const RM_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'resource-manager' };
  const FINANCE_HEADERS = { 'X-User-Id': '4', 'X-User-Role': 'finance' };
  const DE_HEADERS = { 'X-User-Id': '1', 'X-User-Role': 'delivery-executive' };
  const employeeForbidden = await req('GET', '/cost-baselines', { headers: EMPLOYEE_HEADERS });
  check("GET /api/cost-baselines as an 'employee' -> 403 (denied)", employeeForbidden.status === 403, `status=${employeeForbidden.status}`);
  const salesForbidden = await req('GET', '/cost-baselines', { headers: SALES_HEADERS });
  check("GET /api/cost-baselines as 'sales' -> 403 (denied)", salesForbidden.status === 403, `status=${salesForbidden.status}`);
  const pmAllowed = await req('GET', '/cost-baselines', { headers: PM_HEADERS });
  check("GET /api/cost-baselines as a 'pm' -> 200 (read is disjoint from freeze — spec §5)", pmAllowed.status === 200, `status=${pmAllowed.status}`);
  const rmAllowed = await req('GET', '/cost-baselines', { headers: RM_HEADERS });
  check("GET /api/cost-baselines as 'resource-manager' -> 200 (admitted)", rmAllowed.status === 200, `status=${rmAllowed.status}`);
  const financeAllowed = await req('GET', '/cost-baselines', { headers: FINANCE_HEADERS });
  check("GET /api/cost-baselines as 'finance' -> 200 (admitted)", financeAllowed.status === 200, `status=${financeAllowed.status}`);
  const deAllowed = await req('GET', '/cost-baselines', { headers: DE_HEADERS });
  check("GET /api/cost-baselines as 'delivery-executive' -> 200 (admitted)", deAllowed.status === 200, `status=${deAllowed.status}`);
  // 'admin' is exercised throughout checks 1-7 above via the default
  // RBAC_HEADERS this script's req() sends, proving admin can both read and
  // freeze; no separate assertion needed for that role.

  // 9) Audit: the global append-only middleware records the freeze POST (no
  //    separate wiring — src/server.ts:820-859 fires on every successful
  //    POST/PUT/DELETE). Confirmed via the audit-logs read (admin, per the
  //    default RBAC_HEADERS this script's req() sends). NOTE: /audit-logs
  //    returns a bare, newest-first ARRAY (confirmed by reading the handler,
  //    src/server.ts ~6523-6548) — NOT an { entries: [...] } envelope. Do not
  //    write `body?.entries ?? body`: since arrays inherit a native
  //    `.entries()` method from Array.prototype, that expression would pick
  //    up the (truthy) FUNCTION reference instead of falling back to the
  //    array, making Array.isArray(...) always false — a phantom failure
  //    that would never once catch a real regression.
  const auditLogs = await req('GET', '/audit-logs');
  check(
    'the freeze POST left an entry in the append-only audit trail',
    auditLogs.status === 200 && Array.isArray(auditLogs.body)
      && auditLogs.body.some(e => e.method === 'POST' && e.path.includes('/cost-baselines')),
  );
}

/**
 * B3 — the per-month approval lifecycle. Editing ONE month of an approved
 * assignment must demote only that month; its siblings stay Allocated.
 */
async function checkMonthlyApproval() {
  // Assignment '3' spans 2026-05..2026-09 in the seed, all months Allocated.
  const before = await req('GET', '/assignments/3/allocation?from=2026-05&to=2026-09');
  check('B3 allocation envelope exposes month rows', Array.isArray(before.body?.months) && before.body.months.length > 1,
    `months=${before.body?.months?.length}`);

  const target = '2026-06';
  const sibling = before.body.months.find(m => m.month !== target);
  const day = (before.body.days || []).find(d => d.date.startsWith(target));
  if (!day) { check('B3 seed has a day in the edited month', false, `no day in ${target}`); return; }

  // Non-self-managing proposer: assignment 3's resource is '2' (John Miller),
  // whose managerId is '1' — the default RBAC_HEADERS admin. Editing as that
  // same actor would hit the self-managed auto-approval shortcut (no forced
  // re-approval, per design), defeating this check's purpose. 'pm' resource-id
  // '3' (Alice Smith) is neither resource 2 nor its manager, so the edit goes
  // through the normal forced-re-approval path.
  const PROPOSER_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };
  const edit = await req('PUT', '/assignments/3/allocation', {
    headers: PROPOSER_HEADERS,
    body: { month: target, dailyHours: { [day.date]: 2 } },
  });
  check('B3 month edit accepted', edit.status === 200, `status=${edit.status}`);
  // The one new write this task adds to `assignments`: its `status` is now a
  // DERIVED rollup of its months (refreshDerivedAssignmentStatus). With June
  // demoted to 'Requested' and every other seeded month still 'Allocated',
  // the rollup precedence (Requested > Rejected > Allocated > Draft) picks
  // 'Requested' for the whole assignment.
  check('B3 edit response derived assignment status is Requested', edit.body?.status === 'Requested', `status=${edit.body?.status}`);

  const after = await req('GET', '/assignments/3/allocation?from=2026-05&to=2026-09');
  const editedRow = after.body.months.find(m => m.month === target);
  const siblingRow = after.body.months.find(m => m.month === sibling.month);
  check('B3 edited month demoted to Requested', editedRow?.status === 'Requested', `status=${editedRow?.status}`);
  check('B3 sibling month stays Allocated', siblingRow?.status === 'Allocated', `status=${siblingRow?.status}`);
  check('B3 edited month row gained an approvalId', typeof editedRow?.approvalId === 'string' && editedRow.approvalId.length > 0,
    `approvalId=${editedRow?.approvalId}`);

  // Submit: the happy path must run against a genuinely 'Draft' month — no
  // seeded month row is ever 'Draft' (buildAssignmentMonths marks every month
  // 'Allocated' except the one seeded pending row on assignment '2'), so
  // exercising submit against an edited-but-seeded 'Allocated' month would
  // validate the wrong thing (submit is only a legal transition FROM
  // Draft/Rejected; Allocated -> Requested happens only via the day-edit
  // forced-reapproval path in the allocation PUT handler, a different caller).
  // Assignment '1' spans 2026-05..2026-06 in the seed (both already
  // 'Allocated'); 2026-07 is an OPEN planning period the assignment does not
  // yet book, so a PUT there lazily creates a fresh 'Draft' row
  // (ensureAssignmentMonth) to submit.
  //
  // Assignment 1's resource is '1' (Julie Armstrong), whose managerId is ALSO
  // '1' — the SAME id as the default RBAC_HEADERS admin actor used everywhere
  // else in this suite. Submitting as that actor hits the self-managed
  // auto-approval shortcut (straight to 'Allocated', no approval opened),
  // which would defeat these checks' purpose, so note/submit as resource '2'
  // (John Miller), who is NOT resource 1's manager.
  const SUBMIT_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'pm' };
  const draftPut = await req('PUT', '/assignments/1/allocation', { body: { month: '2026-07', dailyHours: { '2026-07-06': 1 } } });
  check('B3 setup: PUT into an unbooked open month creates a Draft row', draftPut.status === 200, `status=${draftPut.status}`);

  const noteRes = await req('PUT', '/assignments/1/months/2026-07/note', { headers: SUBMIT_HEADERS, body: { plannerNote: 'ramp-up month' } });
  check('B3 planner note saved', noteRes.status === 200 && noteRes.body?.plannerNote === 'ramp-up month', `status=${noteRes.status}`);

  const submit = await req('POST', '/assignments/1/months/2026-07/submit', { headers: SUBMIT_HEADERS, body: {} });
  check('B3 submit moves a Draft month to Requested', submit.status === 200 && submit.body?.status === 'Requested', `status=${submit.status} row=${submit.body?.status}`);
  check('B3 submit opens an approval', typeof submit.body?.approvalId === 'string', `approvalId=${submit.body?.approvalId}`);

  const resubmit = await req('POST', '/assignments/1/months/2026-07/submit', { headers: SUBMIT_HEADERS, body: {} });
  check('B3 double submit (already Requested) is rejected', resubmit.status === 400, `status=${resubmit.status}`);

  // 2026-05 is a seeded 'Allocated' month, untouched by anything above — an
  // 'Allocated' month is NOT a valid submit source (see comment above).
  const allocatedSubmit = await req('POST', '/assignments/1/months/2026-05/submit', { headers: SUBMIT_HEADERS, body: {} });
  check('B3 submit on an already-Allocated month is rejected', allocatedSubmit.status === 400, `status=${allocatedSubmit.status}`);

  const closed = await req('POST', '/assignments/1/months/2026-03/submit', { headers: SUBMIT_HEADERS, body: {} });
  check('B3 submit on a non-open month is refused', closed.status === 403 || closed.status === 404, `status=${closed.status}`);

  // Self-managed submit-clear path: exercise it directly instead of routing
  // around it. The shortcut fires when the PROPOSER IS THE RESOURCE'S MANAGER
  // (`autoApprovesAllocation`): resource '2' (John Miller) has managerId '1',
  // which is the default RBAC_HEADERS actor's resource-id, so submitting as the
  // DEFAULT actor lands the month straight on 'Allocated' with `approvalId`
  // cleared and no approval opened. This is the regression coverage for that
  // branch's `approvalId: null` clear: it must leave the field ABSENT in the
  // response (both adapters), never a literal `null`.
  //
  // D — THIS FIXTURE WAS RE-ACTORED, and the assertions below are untouched. It
  // used to run on assignment 1 (resource '1', Julie Armstrong) as the default
  // actor, which only worked because the seed had Julie as HER OWN manager
  // (`managerId: '1'`) — a self-cycle that Task 4 now refuses on write and that
  // Task 5 removed from the seed. The rule under test is "the proposer is the
  // resource's manager", so the fixture now uses a REAL manager/report pair
  // instead of a degenerate self-loop. Same idiom as the totals fixture further
  // down this function, which already relies on '1' being resource 2's manager.
  //
  // A throwaway assignment keeps this clear of every seeded booking, and
  // 2026-09-23 (a Wednesday, Open period) is past the end of resource '2's only
  // seeded booking (assignment 3, whose days stop at 2026-09-15) and is used by
  // nothing else in this suite, so the daily-capacity gate never fires.
  const selfManagedCreate = await req('POST', '/assignments', { body: { requestId: '4', resourceId: '2' } });
  const selfManagedCreateOk = check('B3 self-managed setup: throwaway assignment created for a resource whose manager IS the acting principal',
    selfManagedCreate.status === 200 && typeof selfManagedCreate.body?.id === 'string', `status=${selfManagedCreate.status}`);
  if (selfManagedCreateOk) {
    const selfManagedAssignmentId = selfManagedCreate.body.id;
    const selfManagedPut = await req('PUT', `/assignments/${selfManagedAssignmentId}/allocation`, { body: { month: '2026-09', dailyHours: { '2026-09-23': 1 } } });
    check('B3 self-managed setup: PUT into an unbooked open month creates a Draft row', selfManagedPut.status === 200, `status=${selfManagedPut.status}`);

    const selfManagedSubmit = await req('POST', `/assignments/${selfManagedAssignmentId}/months/2026-09/submit`, { body: {} });
    check('B3 self-managed submit auto-approves to Allocated', selfManagedSubmit.status === 200 && selfManagedSubmit.body?.status === 'Allocated',
      `status=${selfManagedSubmit.status} row=${selfManagedSubmit.body?.status}`);
    check('B3 self-managed submit clears approvalId to absent, not null',
      selfManagedSubmit.body !== null && typeof selfManagedSubmit.body === 'object' &&
      !Object.prototype.hasOwnProperty.call(selfManagedSubmit.body, 'approvalId') && selfManagedSubmit.body.approvalId === undefined,
      `approvalId=${JSON.stringify(selfManagedSubmit.body?.approvalId)} hasOwn=${Object.prototype.hasOwnProperty.call(selfManagedSubmit.body ?? {}, 'approvalId')}`);
  }

  // --- BATCH DECIDE (Task 5) -------------------------------------------------
  // "Approva Mese" / "Approva e Prosegui": decide N month rows in ONE call,
  // through the SAME decision core (SoD + per-step enforcement) the
  // single-request endpoint uses.
  //
  // The batch must run against a month with a genuinely PENDING approval, and
  // submit is only legal FROM Draft/Rejected, so build one: 2026-10 is an Open
  // planning period that assignment 1 does not book (its seeded days end
  // 2026-06; the months this section already touched are 2026-07 and 2026-09),
  // so a PUT there lazily opens a fresh 'Draft' row. The PUT runs as the
  // DEFAULT admin, who IS resource 1's manager — irrelevant on a Draft month
  // (the forced-re-approval branch only fires from 'Allocated'), and it keeps
  // the row Draft for the submit below. The submit then runs as SUBMIT_HEADERS
  // (user '2', not resource 1's manager) so a REAL approval opens, requested by
  // '2'; the batch then decides as the default admin '1' — a different
  // principal, so SoD passes. 2026-10-06 is a Tuesday, not a seeded holiday.
  const BATCH_MONTH = '2026-10';
  const BATCH_ROW_ID = `1:${BATCH_MONTH}`;
  const batchPut = await req('PUT', '/assignments/1/allocation', { body: { month: BATCH_MONTH, dailyHours: { [`${BATCH_MONTH}-06`]: 1 } } });
  check('B3 batch setup: PUT into an unbooked open month creates a Draft row', batchPut.status === 200, `status=${batchPut.status}`);

  const batchSubmit = await req('POST', `/assignments/1/months/${BATCH_MONTH}/submit`, { headers: SUBMIT_HEADERS, body: { plannerNote: 'please confirm' } });
  check('B3 batch setup: submit opens a pending approval on the month',
    batchSubmit.status === 200 && batchSubmit.body?.status === 'Requested' && typeof batchSubmit.body?.approvalId === 'string',
    `status=${batchSubmit.status} row=${batchSubmit.body?.status} approvalId=${batchSubmit.body?.approvalId}`);

  // One valid item + one bogus id: each item is independent, so the bogus one
  // must be reported in `results` and must NOT fail its neighbour or the call.
  const decide = await req('POST', '/allocation-approvals/decide', {
    body: { items: [
      { assignmentMonthId: BATCH_ROW_ID, decision: 'Approved', note: 'ok for me' },
      { assignmentMonthId: 'nope:2026-06', decision: 'Approved' },
    ] },
  });
  check('B3 batch decide returns 200', decide.status === 200, `status=${decide.status} body=${JSON.stringify(decide.body)}`);
  const ok = (decide.body?.results || []).find(r => r.assignmentMonthId === BATCH_ROW_ID);
  const bad = (decide.body?.results || []).find(r => r.assignmentMonthId === 'nope:2026-06');
  check('B3 batch decides the valid item', ok?.status === 'Approved', `result=${JSON.stringify(ok)}`);
  check('B3 batch reports the invalid item without failing the call', bad?.status === 'Error' && typeof bad?.error === 'string', `result=${JSON.stringify(bad)}`);

  const decided = await req('GET', `/assignments/1/allocation?from=${BATCH_MONTH}&to=${BATCH_MONTH}`);
  const decidedRow = (decided.body.months || [])[0];
  check('B3 decision applied to the month row', decidedRow?.status === 'Allocated', `status=${decidedRow?.status}`);
  check('B3 approver note stored on the month', decidedRow?.approverNote === 'ok for me', `note=${decidedRow?.approverNote}`);

  // A second decision on the SAME (now decided) approval must be refused by the
  // shared core's `ar.status !== 'Pending'` guard, reported per item.
  const replay = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: BATCH_ROW_ID, decision: 'Rejected' }] },
  });
  const replayResult = (replay.body?.results || [])[0];
  check('B3 batch refuses to re-decide an already-decided month',
    replay.status === 200 && replayResult?.status === 'Error' && /already Approved/.test(String(replayResult?.error)),
    `result=${JSON.stringify(replayResult)}`);

  // SoD through the batch: the REQUESTER of the approval may never decide it.
  // '2:2026-08' is the seeded pending month, requested by '3' (AR4).
  const sod = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: '2:2026-08', decision: 'Approved' }] },
    headers: { 'X-User-Id': '3', 'X-User-Role': 'pm' },
  });
  const sodResult = (sod.body?.results || [])[0];
  check('B3 batch enforces segregation of duties (requester cannot decide)',
    sod.status === 200 && sodResult?.status === 'Error' && /[Ss]egregation of duties/.test(String(sodResult?.error)),
    `result=${JSON.stringify(sodResult)}`);

  const denied = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: '2:2026-08', decision: 'Approved' }] },
    headers: { 'X-User-Id': '9', 'X-User-Role': 'employee' },
  });
  check('B3 batch decide refuses a non-approver role', denied.status === 403, `status=${denied.status}`);

  const emptyBatch = await req('POST', '/allocation-approvals/decide', { body: { items: [] } });
  check('B3 batch decide rejects an empty items array', emptyBatch.status === 400, `status=${emptyBatch.status}`);

  // DECIDE_BATCH_MAX is 200 in src/server.ts; 201 must be refused outright
  // (400), not truncated or processed.
  const oversize = await req('POST', '/allocation-approvals/decide', {
    body: { items: Array.from({ length: 201 }, () => ({ assignmentMonthId: BATCH_ROW_ID, decision: 'Approved' })) },
  });
  check('B3 batch decide rejects more than DECIDE_BATCH_MAX items', oversize.status === 400, `status=${oversize.status}`);

  // Re-open the decided month so the remaining batch checks have a genuinely
  // pending approval again: editing an 'Allocated' month's days as a
  // NON-self-managing proposer (pm '3' is neither resource 1 nor its manager
  // '1') is the forced-re-approval path — the row goes back to 'Requested'
  // under a fresh approval requested by '3'. 2026-10-07 is a Wednesday.
  await req('PUT', '/assignments/1/allocation', { headers: PROPOSER_HEADERS, body: { month: BATCH_MONTH, dailyHours: { [`${BATCH_MONTH}-07`]: 1 } } });
  const reopened = await req('GET', `/assignments/1/allocation?from=${BATCH_MONTH}&to=${BATCH_MONTH}`);
  const reopenedRow = (reopened.body.months || [])[0];
  check('B3 batch setup: the decided month is re-opened by a day edit (forced re-approval)',
    reopenedRow?.status === 'Requested' && typeof reopenedRow?.approvalId === 'string',
    `row=${JSON.stringify(reopenedRow)}`);

  // STEP ENFORCEMENT through the batch — the filter the coarse
  // '/allocation-approvals' role gate relies on. pm '2' (John Miller, resource
  // '2') passes that gate and is NOT the requester ('3'), so SoD lets him
  // through; he is refused by the per-step check instead. Without this the
  // coarse gate would let any pm decide any manager's allocation.
  //
  // D — THE EXPECTED MESSAGE CHANGED WITH THE SEED, not with the rule. This row
  // belongs to assignment 1, i.e. resource '1' (Julie Armstrong), who is the top
  // of the org chart and now correctly has NO `managerId` (Task 5 removed the
  // seed's self-cycle). `allocationApproverStep(undefined)` therefore routes the
  // step by ROLE alone, so the refusal names the role rather than a named
  // approver id. Still the role/step refusal — a 'pm' holds neither
  // 'resource-manager' nor the named-approver position — and still asserted
  // verbatim. The named-approver form of this message (`...assigned to 2`) is
  // pinned in checkScopedAllocationDecision, on Alice's step, which really does
  // carry an approverId.
  const wrongApprover = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: BATCH_ROW_ID, decision: 'Approved' }] },
    headers: { 'X-User-Id': '2', 'X-User-Role': 'pm' },
  });
  const wrongApproverResult = (wrongApprover.body?.results || [])[0];
  check('B3 batch enforces per-step approver routing (non-requester, non-manager is refused)',
    wrongApprover.status === 200 && wrongApproverResult?.status === 'Error' && /cannot decide a step assigned to resource-manager/.test(String(wrongApproverResult?.error)),
    `result=${JSON.stringify(wrongApproverResult)}`);

  // The SAME id twice in one batch: decided once, the duplicate reported as
  // already decided — the shared core's Pending guard, reached through the
  // batch's own loop. This decision carries NO note, which must CLEAR the
  // 'ok for me' the earlier decision left on the row.
  const dup = await req('POST', '/allocation-approvals/decide', {
    body: { items: [
      { assignmentMonthId: BATCH_ROW_ID, decision: 'Approved' },
      { assignmentMonthId: BATCH_ROW_ID, decision: 'Approved' },
    ] },
  });
  const dupResults = dup.body?.results || [];
  check('B3 batch decides a duplicated id exactly once', dupResults[0]?.status === 'Approved', `result=${JSON.stringify(dupResults[0])}`);
  check('B3 batch reports the duplicate as already decided',
    dupResults[1]?.status === 'Error' && /already Approved/.test(String(dupResults[1]?.error)),
    `result=${JSON.stringify(dupResults[1])}`);

  const recleared = await req('GET', `/assignments/1/allocation?from=${BATCH_MONTH}&to=${BATCH_MONTH}`);
  const reclearedRow = (recleared.body.months || [])[0];
  check("B3 a decision without a note clears the previous approver's note (absent, not null)",
    reclearedRow?.status === 'Allocated' && reclearedRow?.approverNote === undefined &&
    !Object.prototype.hasOwnProperty.call(reclearedRow ?? {}, 'approverNote'),
    `row=${JSON.stringify(reclearedRow)}`);

  // TWO MONTHS OF THE SAME ASSIGNMENT IN ONE BATCH, decided differently. This
  // is the case that proves the audit trail keeps its per-month granularity:
  // the expensive follow-up work (status rollup, utilization/staffing
  // recompute) is deduplicated per assignment, but the AUDIT is per decision,
  // so a mixed Approve/Reject must leave TWO distinct entries — collapsing them
  // into one per-assignment entry would record only the final derived status
  // and lose both decisions. It also pins that the batch and single-request
  // endpoints write the SAME shape (`/assignment-months/<rowId>`), so the trail
  // never depends on which endpoint made the decision. Nothing else in this
  // suite asserts audit-log content.
  //
  // 2026-11 and 2026-12 are Open periods assignment 1 does not book (its seeded
  // days end 2026-06; this section has used 2026-07/09/10). 2026-11-03 and
  // 2026-12-01 are Tuesdays; 2026-12-25 (the seeded holiday) is avoided. The
  // PUTs run as the default self-managing admin so the rows are created Draft,
  // then SUBMIT_HEADERS (user '2') submits so a real approval opens requested
  // by '2' — the default admin '1' is then an SoD-compliant decider for both.
  const PAIR = [['2026-11', '2026-11-03'], ['2026-12', '2026-12-01']];
  let pairSetupOk = true;
  for (const [month, day] of PAIR) {
    await req('PUT', '/assignments/1/allocation', { body: { month, dailyHours: { [day]: 1 } } });
    const s = await req('POST', `/assignments/1/months/${month}/submit`, { headers: SUBMIT_HEADERS, body: {} });
    pairSetupOk = check(`B3 audit-granularity setup: ${month} submitted for approval`,
      s.status === 200 && s.body?.status === 'Requested' && typeof s.body?.approvalId === 'string',
      `status=${s.status} row=${s.body?.status}`) && pairSetupOk;
  }
  if (pairSetupOk) {
    const pair = await req('POST', '/allocation-approvals/decide', {
      body: { items: [
        { assignmentMonthId: '1:2026-11', decision: 'Approved', note: 'November is fine' },
        { assignmentMonthId: '1:2026-12', decision: 'Rejected', note: 'December is not' },
      ] },
    });
    const pairResults = pair.body?.results || [];
    check('B3 batch decides two months of one assignment independently',
      pair.status === 200 && pairResults[0]?.status === 'Approved' && pairResults[1]?.status === 'Rejected',
      `results=${JSON.stringify(pairResults)}`);

    const pairRows = (await req('GET', '/assignments/1/allocation?from=2026-11&to=2026-12')).body?.months || [];
    check('B3 the two months carry their OWN outcomes, not a shared one',
      pairRows.find(m => m.month === '2026-11')?.status === 'Allocated' &&
      pairRows.find(m => m.month === '2026-12')?.status === 'Rejected',
      `rows=${JSON.stringify(pairRows)}`);

    // GET /audit-logs is admin-only and newest-first. The explicit entries are
    // written inline (before the response is sent), so they are already
    // durable here — no polling needed.
    const { status: logStatus, body: logs } = await req('GET', '/audit-logs?limit=1000');
    const entries = Array.isArray(logs) ? logs : [];
    const novEntry = entries.find(e => e.path === '/assignment-months/1:2026-11');
    const decEntry = entries.find(e => e.path === '/assignment-months/1:2026-12');
    check('B3 the batch writes one audit entry per DECIDED MONTH, not one per assignment',
      logStatus === 200 && Boolean(novEntry) && Boolean(decEntry) && novEntry.id !== decEntry.id,
      `novEntry=${novEntry?.id}, decEntry=${decEntry?.id}, logs=${entries.length}`);
    check('B3 those audit entries are attributed to the trusted deciding actor',
      novEntry?.actorId === '1' && novEntry?.actorRole === 'admin' && decEntry?.actorId === '1' && decEntry?.actorRole === 'admin',
      `nov=${novEntry?.actorId}/${novEntry?.actorRole}, dec=${decEntry?.actorId}/${decEntry?.actorRole}`);

    // CONTENT, not just shape. The entries must record the MONTH ROW's own
    // transition. Auditing the assignment instead would silently pass the
    // checks above and fail these: assignment 1 also owns 2026-07, submitted
    // earlier in this section and never decided, so `deriveAssignmentStatus`
    // holds the assignment at 'Requested' both before AND after this pair —
    // two opposite decisions would both record before === after and an EMPTY
    // changedKeys, i.e. a trail that shows no transition at all.
    check('B3 each audit entry records its OWN month outcome (opposite decisions, opposite after.status)',
      novEntry?.before?.status === 'Requested' && novEntry?.after?.status === 'Allocated' &&
      decEntry?.before?.status === 'Requested' && decEntry?.after?.status === 'Rejected',
      `nov=${novEntry?.before?.status}->${novEntry?.after?.status}, dec=${decEntry?.before?.status}->${decEntry?.after?.status}`);
    check('B3 each audit entry reports a real transition in changedKeys (status + the approver note)',
      Array.isArray(novEntry?.changedKeys) && novEntry.changedKeys.includes('status') && novEntry.changedKeys.includes('approverNote') &&
      Array.isArray(decEntry?.changedKeys) && decEntry.changedKeys.includes('status') && decEntry.changedKeys.includes('approverNote'),
      `nov=${JSON.stringify(novEntry?.changedKeys)}, dec=${JSON.stringify(decEntry?.changedKeys)}`);
    check("B3 the audited after-state carries the approver's note verbatim",
      novEntry?.after?.approverNote === 'November is fine' && decEntry?.after?.approverNote === 'December is not',
      `nov=${JSON.stringify(novEntry?.after?.approverNote)}, dec=${JSON.stringify(decEntry?.after?.approverNote)}`);
  }

  // A month CLOSED after submission must still be decidable (spec §4.5) — a
  // request in flight may never be left hanging — while its hours are frozen.
  // The seed leaves '2:2026-08' Requested under approval AR4 (requestedBy '3'),
  // so the default admin '1' is an SoD-compliant decider for it.
  await req('PUT', '/planning-periods/2026-08', { body: { status: 'Closed' } });
  const frozen = await req('PUT', '/assignments/2/allocation', { body: { month: '2026-08', dailyHours: {} } });
  check('B3 closed month rejects hour edits', frozen.status === 403, `status=${frozen.status}`);
  const closedDecide = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: '2:2026-08', decision: 'Approved', note: 'confirmed after close' }] },
  });
  const closedResult = (closedDecide.body?.results || [])[0];
  check('B3 closed month is still decidable', closedResult?.status === 'Approved', `result=${JSON.stringify(closedResult)}`);
  const closedRow = await req('GET', '/assignments/2/allocation?from=2026-08&to=2026-08');
  check('B3 seeded AR4 month row is genuinely decided, not just its approval',
    (closedRow.body?.months || [])[0]?.status === 'Allocated',
    `row=${JSON.stringify((closedRow.body?.months || [])[0])}`);
  await req('PUT', '/planning-periods/2026-08', { body: { status: 'Open' } }); // restore for reruns

  // --- READ SIDE (Task 8): the People Manager approval feed ------------------
  // By this point in the suite, seeded data has already been mutated (months
  // submitted/decided, an assignment retargeted, a throwaway assignment
  // deleted) — assert on the envelope's SHAPE and the filter's narrowing
  // behaviour, not on exact counts or a specific resource's exact state.
  const feed = await req('GET', '/allocation-approvals?from=2026-05&to=2026-09&status=all');
  check('B3 feed returns months and rows', feed.status === 200 && Array.isArray(feed.body?.months) && Array.isArray(feed.body?.rows), `status=${feed.status}`);
  const withItems = (feed.body?.rows || []).find(r => (r.items || []).length > 0);
  check('B3 feed rows carry per-month items', !!withItems && typeof withItems.items[0].assignmentMonthId === 'string', `rows=${feed.body?.rows?.length}`);
  check('B3 feed exposes the monthly target', !!withItems && typeof withItems.targetHours === 'object', 'targetHours missing');

  // D (Task 8, round 2): `AllocationApprovalRow` now carries `organization`
  // straight from the server — populated from the SAME resource record the
  // handler already loads to build the row — so the client's capability/
  // practice/competence filters can call `dimensionsOf` on it directly with
  // NO second getResources() catalogue fetch (that second fetch was deleted
  // specifically because it could race the org-tree load and silently show
  // "nothing to approve" instead of "not loaded yet"). Resource '1' (Julie
  // Armstrong) is seeded on 'Engineering' with assignments spanning this
  // window, so her row must carry it.
  const julieRow = (feed.body?.rows || []).find(r => r.resourceId === '1');
  check("D feed rows carry the resource's organization (Task 8) — no client-side join needed",
    julieRow !== undefined && julieRow.organization === 'Engineering',
    `row=${JSON.stringify(julieRow)}`);

  // D (Task 8, round 3): `AllocationApprovalRow` now ALSO carries
  // `managerName`, resolved server-side from the SAME resourceById map the
  // handler already built for this row — no extra I/O. This is what lets the
  // People Manager filter's dropdown show a real name instead of a bare id:
  // a feed lists a manager's REPORTS, not the manager themselves, so a
  // client-side lookup for "the manager's own row in this same feed" almost
  // never finds one. Resource '2' (John Miller) is seeded with managerId '1'
  // (Julie Armstrong) and has an assignment spanning this window.
  const johnRow = (feed.body?.rows || []).find(r => r.resourceId === '2');
  check("D feed rows carry the manager's name (Task 8 round 3) — no client-side lookup needed",
    johnRow !== undefined && johnRow.managerId === '1' && johnRow.managerName === 'Julie Armstrong',
    `row=${JSON.stringify(johnRow)}`);

  const pendingOnly = await req('GET', '/allocation-approvals?from=2026-05&to=2026-09&status=Requested');
  const allPending = (pendingOnly.body?.rows || []).every(r => (r.items || []).every(i => i.status === 'Requested'));
  check('B3 feed status filter narrows to pending months', pendingOnly.status === 200 && allPending, `status=${pendingOnly.status}`);

  const feedDenied = await req('GET', '/allocation-approvals', { headers: { 'X-User-Id': '9', 'X-User-Role': 'employee' } });
  check('B3 feed refuses a non-staffing role', feedDenied.status === 403, `status=${feedDenied.status}`);

  // --- REVIEW FIX #1 — totalHours must be UNCONDITIONAL on the status filter.
  // Resource '2' (John Miller) already carries one 'Requested' month row here
  // (3:2026-06, from the forced-re-approval edit at the very top of this
  // function). Add a SECOND, self-managed assignment booking hours into the
  // SAME resource + SAME month so it lands 'Allocated' — a resource with two
  // assignments in one month under two different statuses is exactly the
  // shape that corrupted totalHours (it was summing only the items that
  // survived the status filter, instead of every month row of that resource
  // in that month).
  const TOTALS_MONTH = '2026-06';
  const TOTALS_RESOURCE = '2';

  const beforeTotalsFeed = await req('GET', `/allocation-approvals?from=${TOTALS_MONTH}&to=${TOTALS_MONTH}&status=all`);
  const beforeTotalsRow = (beforeTotalsFeed.body?.rows || []).find(r => r.resourceId === TOTALS_RESOURCE);
  const beforeTotal = beforeTotalsRow?.totalHours?.[TOTALS_MONTH] ?? 0;

  const totalsCreate = await req('POST', '/assignments', { body: { requestId: '4', resourceId: TOTALS_RESOURCE } });
  const totalsCreateOk = check('B3 totals setup: throwaway assignment created', totalsCreate.status === 200 && typeof totalsCreate.body?.id === 'string', `status=${totalsCreate.status}`);
  if (totalsCreateOk) {
    const totalsAssignmentId = totalsCreate.body.id;
    const totalsPut = await req('PUT', `/assignments/${totalsAssignmentId}/allocation`, { body: { month: TOTALS_MONTH, dailyHours: { [`${TOTALS_MONTH}-16`]: 3 } } });
    check('B3 totals setup: hours booked into the shared month', totalsPut.status === 200, `status=${totalsPut.status}`);

    // Default actor (resource-id '1') IS resource 2's manager -> self-managed
    // shortcut -> straight to 'Allocated', no approval opened.
    const totalsSubmit = await req('POST', `/assignments/${totalsAssignmentId}/months/${TOTALS_MONTH}/submit`, { body: {} });
    check('B3 totals setup: self-managed submit lands Allocated', totalsSubmit.status === 200 && totalsSubmit.body?.status === 'Allocated', `status=${totalsSubmit.status} row=${totalsSubmit.body?.status}`);

    const afterAllFeed = await req('GET', `/allocation-approvals?from=${TOTALS_MONTH}&to=${TOTALS_MONTH}&status=all`);
    const afterAllRow = (afterAllFeed.body?.rows || []).find(r => r.resourceId === TOTALS_RESOURCE);
    const afterRequestedFeed = await req('GET', `/allocation-approvals?from=${TOTALS_MONTH}&to=${TOTALS_MONTH}&status=Requested`);
    const afterRequestedRow = (afterRequestedFeed.body?.rows || []).find(r => r.resourceId === TOTALS_RESOURCE);

    check('B3 totals: the new Allocated month raises the UNFILTERED total by its own hours',
      afterAllRow?.totalHours?.[TOTALS_MONTH] === beforeTotal + 3,
      `before=${beforeTotal} after=${afterAllRow?.totalHours?.[TOTALS_MONTH]}`);

    check("B3 totals: status=Requested does NOT shrink totalHours — it still covers the Allocated sibling",
      afterRequestedRow?.totalHours?.[TOTALS_MONTH] === afterAllRow?.totalHours?.[TOTALS_MONTH],
      `all=${afterAllRow?.totalHours?.[TOTALS_MONTH]} requested=${afterRequestedRow?.totalHours?.[TOTALS_MONTH]}`);

    const allItemsForMonth = (afterAllRow?.items || []).filter(i => i.month === TOTALS_MONTH);
    const requestedItemsForMonth = (afterRequestedRow?.items || []).filter(i => i.month === TOTALS_MONTH);
    check('B3 totals: status=Requested DOES narrow the listed items (excludes the Allocated sibling)',
      requestedItemsForMonth.length < allItemsForMonth.length && requestedItemsForMonth.every(i => i.status === 'Requested'),
      `all=${allItemsForMonth.length} requested=${requestedItemsForMonth.length}`);

    check('B3 totals: the new Allocated item is listed unfiltered but absent from the Requested-filtered view',
      allItemsForMonth.some(i => i.assignmentId === totalsAssignmentId && i.status === 'Allocated') &&
      !requestedItemsForMonth.some(i => i.assignmentId === totalsAssignmentId),
      `allItems=${JSON.stringify(allItemsForMonth.map(i => ({ a: i.assignmentId, s: i.status })))}`);
  }

  // --- REVIEW FIX #2 — window defaulting must never discard or invert a
  // caller-supplied bound, and must reject an inverted range outright.
  const inverted = await req('GET', '/allocation-approvals?from=2026-09&to=2026-05');
  check('B3 feed rejects an inverted from>to range with 400', inverted.status === 400, `status=${inverted.status} body=${JSON.stringify(inverted.body)}`);

  const periodsResp = await req('GET', '/planning-periods');
  const expectedOpenMonths = (periodsResp.body || []).filter(p => p.status === 'Open').map(p => p.id).sort();
  const defaultWindowFeed = await req('GET', '/allocation-approvals');
  const defaultMonths = defaultWindowFeed.body?.months;
  check('B3 feed default window (neither bound supplied) spans exactly the Open planning periods',
    defaultWindowFeed.status === 200 && Array.isArray(defaultMonths) && expectedOpenMonths.length > 0 &&
    defaultMonths[0] === expectedOpenMonths[0] && defaultMonths[defaultMonths.length - 1] === expectedOpenMonths[expectedOpenMonths.length - 1] &&
    expectedOpenMonths.every(m => defaultMonths.includes(m)),
    `months=${JSON.stringify(defaultMonths)} openPeriods=${JSON.stringify(expectedOpenMonths)}`);
}

/**
 * B3 BACKWARD COMPATIBILITY — a LEGACY (pre-B3) allocation approval, whose
 * `refId` is a BARE assignment id rather than a `<assignmentId>:<YYYY-MM>` month
 * row, must move the assignment's month rows too.
 *
 * Why this matters: `backfillAssignmentMonths` (src/db/bootstrap.ts) gives a
 * migrated Postgres database one month row per booked month, COPYING the
 * assignment's status onto it and attaching NO approvalId. The still-pending
 * legacy `ApprovalRequest` can be decided, but before the fix the hook wrote
 * only `assignments.status` — and everything downstream reads the MONTH rows
 * (`monthlyAggregateHours` weighs each day by its own month's status, and the
 * next `refreshDerivedAssignmentStatus` re-derives the column straight back off
 * them). The approval was a no-op and the allocation was stranded.
 *
 * BUILDING THE FIXTURE THROUGH REAL API CALLS:
 *  - The stranded shape is "a NON-Draft month row carrying NO approvalId". The
 *    self-managed submit shortcut produces exactly that live: submitting a month
 *    as the resource's OWN manager lands it 'Allocated' with `approvalId`
 *    cleared. Resource '2' (John Miller) has managerId '1', which is the
 *    default admin actor this suite runs as.
 *
 *    D — RE-ACTORED FROM RESOURCE '1' TO '2', assertions untouched. This fixture
 *    used to use resource '1' (Julie Armstrong), which only produced the
 *    stranded shape because the seed had her as her OWN manager — the self-cycle
 *    Task 4 refuses on write and Task 5 removed from the seed. Resource '2' is a
 *    genuine report of '1', so the shortcut fires for the real reason.
 *  - A bare-`refId` approval can only be created through `POST
 *    /approval-requests` (the B3 endpoints always open month-scoped ones). That
 *    route is gated to the approver-grade roles (pm / resource-manager /
 *    delivery-executive / finance / admin) and pins `requestedBy` to the
 *    verified actor, so it is created as pm '3' and decided by admin '1' — two
 *    different principals, so segregation of duties passes. For kind
 *    'Allocation' `buildApprovalSteps` routes to a single 'delivery-executive'
 *    step with no approverId; role 'admin' satisfies any step.
 *  - The decision is a REJECTION, so the month must move Allocated -> Rejected
 *    and the CONFIRMED hours (the request's `staffedEffort`, which sums only
 *    'Allocated' months) must fall by exactly the booked hours.
 *
 * THE ASSIGNMENT DELIBERATELY CARRIES TWO MONTHS, because the interesting bug is
 * about the one the sweep must NOT touch (re-review finding): a migrated
 * assignment can hold a stranded month AND a later month the planner has since
 * submitted through the normal B3 flow, which owns a live, still-Pending
 * per-month approval. Sweeping that second row in would decouple it from its
 * approval forever — Pending approval, terminal row status, month invisible in
 * the 'Requested' feed. So:
 *   MONTH_STRANDED (2026-11) — self-managed submit -> 'Allocated', NO approvalId.
 *   MONTH_LIVE     (2026-12) — submitted by a NON-manager -> 'Requested' WITH a
 *                              real approvalId and a Pending ApprovalRequest.
 * After the legacy decision, MONTH_STRANDED must move and MONTH_LIVE must be
 * untouched in every respect. The derived assignment status is then the rollup of
 * {Rejected, Requested} = 'Requested' (Requested outranks Rejected), which is
 * itself proof the live month survived.
 *
 * Both months are Open planning periods, and both days are free of every other
 * booking in this suite for resource '2' (8h/day cap, so the capacity gate never
 * fires — resource '2's only seeded booking, assignment 3, stops at 2026-09-15):
 * 2026-11-04 is a Wednesday (checkMonthlyApproval uses 2026-11-03 and
 * checkScopedAllocationDecision 2026-11-03, both on other resources) and
 * 2026-12-02 is a Wednesday (they use 2026-12-01; the 2026-12-25 holiday is
 * avoided).
 */
async function checkLegacyAllocationApproval() {
  const REQUESTER_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };
  // pm '2' maps to resource '2' — the resource ITSELF, which is not its own
  // manager ('1' is), so this submit opens a genuine Pending approval instead of
  // self-approving. That the shortcut needs the MANAGER specifically, not merely
  // a related party, is part of what this fixture demonstrates.
  const NON_MANAGER_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'pm' };
  const RESOURCE_ID = '2'; // John Miller — managerId '1' == the default admin actor
  const REQUEST_ID = '2';
  const MONTH = '2026-11';
  const DAY = `${MONTH}-04`;
  const HOURS = 4;
  const MONTH_LIVE = '2026-12';
  const DAY_LIVE = `${MONTH_LIVE}-02`;

  const created = await req('POST', '/assignments', { body: { requestId: REQUEST_ID, resourceId: RESOURCE_ID } });
  const createOk = check('B3 legacy setup: throwaway assignment created',
    created.status === 200 && typeof created.body?.id === 'string', `status=${created.status}`);
  if (!createOk) return;
  const assignmentId = created.body.id;
  const rowId = `${assignmentId}:${MONTH}`;

  const booked = await req('PUT', `/assignments/${assignmentId}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: HOURS } } });
  check('B3 legacy setup: hours booked (lazily opens a Draft month row)', booked.status === 200, `status=${booked.status} body=${JSON.stringify(booked.body)}`);

  // Self-managed submit -> 'Allocated' with approvalId CLEARED: the same shape
  // backfillAssignmentMonths leaves behind on a migrated database.
  const submitted = await req('POST', `/assignments/${assignmentId}/months/${MONTH}/submit`, { body: {} });
  const shapeOk = check('B3 legacy setup: month row is non-Draft and carries NO approvalId (the backfill shape)',
    submitted.status === 200 && submitted.body?.status === 'Allocated' && submitted.body?.approvalId === undefined,
    `status=${submitted.status} row=${submitted.body?.status} approvalId=${JSON.stringify(submitted.body?.approvalId)}`);
  if (!shapeOk) return;

  // SECOND MONTH on the SAME assignment, with a governance story of its OWN: a
  // live, still-Pending per-month approval. The legacy sweep must not touch it.
  const bookedLive = await req('PUT', `/assignments/${assignmentId}/allocation`, { headers: NON_MANAGER_HEADERS, body: { month: MONTH_LIVE, dailyHours: { [DAY_LIVE]: 3 } } });
  check('B3 legacy setup: second month booked', bookedLive.status === 200, `status=${bookedLive.status} body=${JSON.stringify(bookedLive.body)}`);
  const submittedLive = await req('POST', `/assignments/${assignmentId}/months/${MONTH_LIVE}/submit`, { headers: NON_MANAGER_HEADERS, body: {} });
  const liveOk = check('B3 legacy setup: second month is Requested under a LIVE pending approval',
    submittedLive.status === 200 && submittedLive.body?.status === 'Requested' && typeof submittedLive.body?.approvalId === 'string',
    `status=${submittedLive.status} row=${submittedLive.body?.status} approvalId=${submittedLive.body?.approvalId}`);
  if (!liveOk) return;
  const liveApprovalId = submittedLive.body.approvalId;

  const confirmedBefore = ((await req('GET', '/requests')).body || []).find(r => r.id === REQUEST_ID)?.staffedEffort;
  check('B3 legacy setup: the booked month counts toward confirmed hours',
    typeof confirmedBefore === 'number', `staffedEffort=${JSON.stringify(confirmedBefore)}`);

  // The legacy-shaped approval: kind 'Allocation', refId a BARE assignment id.
  const legacyAr = await req('POST', '/approval-requests', {
    headers: REQUESTER_HEADERS,
    body: { kind: 'Allocation', refId: assignmentId, note: 'pre-B3 approval still in flight' },
  });
  const arOk = check('B3 legacy: POST /api/approval-requests opens a bare-refId Allocation approval',
    legacyAr.status === 200 && typeof legacyAr.body?.id === 'string' && legacyAr.body?.refId === assignmentId &&
    legacyAr.body?.status === 'Pending' && legacyAr.body?.requestedBy === '3',
    `status=${legacyAr.status} body=${JSON.stringify(legacyAr.body)}`);
  if (!arOk) return;
  const legacyApprovalId = legacyAr.body.id;

  // Decide it as the default admin '1' — not the requester ('3'), so SoD passes.
  const decided = await req('PUT', `/approval-requests/${legacyApprovalId}/decision`, { body: { decision: 'Rejected', note: 'legacy rejection' } });
  check('B3 legacy: the bare-refId approval can be decided',
    decided.status === 200 && decided.body?.status === 'Rejected', `status=${decided.status} ar=${decided.body?.status}`);

  // THE REGRESSION: the STRANDED month row must have moved with the decision.
  const after = await req('GET', `/assignments/${assignmentId}/allocation?from=${MONTH}&to=${MONTH_LIVE}`);
  const afterRow = (after.body?.months || []).find(m => m.month === MONTH);
  check('B3 legacy: the decision moves the STRANDED month row (non-Draft, no approvalId)',
    afterRow?.status === 'Rejected', `row=${JSON.stringify(afterRow)}`);

  // THE RE-REVIEW FINDING: a sibling month that owns a LIVE pending approval is
  // NOT swept along. Status, approvalId and the ApprovalRequest itself must all
  // be exactly as they were — otherwise the row shows a terminal status while its
  // approval stays Pending, and the month disappears from the approver's feed.
  const liveRow = (after.body?.months || []).find(m => m.month === MONTH_LIVE);
  check('B3 legacy: a sibling month with its OWN live approval is left untouched',
    liveRow?.status === 'Requested' && liveRow?.approvalId === liveApprovalId,
    `row=${JSON.stringify(liveRow)} expectedApprovalId=${liveApprovalId}`);
  const liveAr = ((await req('GET', '/approval-requests')).body || []).find(a => a.id === liveApprovalId);
  check('B3 legacy: that sibling\'s approval is still Pending and still decidable',
    liveAr?.status === 'Pending' && liveAr?.refId === `${assignmentId}:${MONTH_LIVE}`,
    `ar=${JSON.stringify(liveAr && { id: liveAr.id, status: liveAr.status, refId: liveAr.refId })}`);
  const pendingFeed = await req('GET', `/allocation-approvals?from=${MONTH_LIVE}&to=${MONTH_LIVE}&status=Requested`);
  check('B3 legacy: the untouched month is still listed in the pending approvals feed',
    (pendingFeed.body?.rows || []).some(r => (r.items || []).some(i => i.assignmentMonthId === `${assignmentId}:${MONTH_LIVE}`)),
    `rows=${JSON.stringify((pendingFeed.body?.rows || []).map(r => (r.items || []).map(i => i.assignmentMonthId)))}`);

  // Rollup of {Rejected, Requested} is 'Requested' (Requested outranks Rejected)
  // — which is itself proof the live month survived the sweep.
  const afterAssig = ((await req('GET', '/assignments')).body || []).find(a => a.id === assignmentId);
  check('B3 legacy: the derived assignment status agrees with its month rows',
    afterAssig?.status === 'Requested', `status=${afterAssig?.status}`);

  const confirmedAfter = ((await req('GET', '/requests')).body || []).find(r => r.id === REQUEST_ID)?.staffedEffort;
  check('B3 legacy: confirmed hours drop by the rejected month\'s hours (the aggregates followed)',
    typeof confirmedAfter === 'number' && Math.abs((confirmedBefore - confirmedAfter) - HOURS) < 1e-6,
    `before=${confirmedBefore} after=${confirmedAfter} expectedDelta=${HOURS}`);

  // The trail records the MONTH ROW's own transition, the same shape the B3 and
  // batch paths write — an auditor never has to know which refId shape produced it.
  const { body: logs } = await req('GET', '/audit-logs?limit=1000');
  const monthEntry = (Array.isArray(logs) ? logs : []).find(e => e.path === `/assignment-months/${rowId}`);
  check('B3 legacy: a month-row audit entry records the moved month',
    Boolean(monthEntry) && monthEntry.before?.status === 'Allocated' && monthEntry.after?.status === 'Rejected' &&
    monthEntry.actorId === '1',
    `entry=${JSON.stringify(monthEntry && { path: monthEntry.path, before: monthEntry.before?.status, after: monthEntry.after?.status, actor: monthEntry.actorId })}`);

  // ... and NO entry for the untouched sibling: no entry means no write, which is
  // the strongest form of "left alone".
  const liveEntry = (Array.isArray(logs) ? logs : []).find(e => e.path === `/assignment-months/${assignmentId}:${MONTH_LIVE}`);
  check('B3 legacy: no audit entry is written for the untouched sibling month',
    liveEntry === undefined, `entry=${JSON.stringify(liveEntry && { path: liveEntry.path, after: liveEntry.after?.status })}`);

  // The assignment-level entry records the status the column SETTLED on — the
  // derived rollup 'Requested', not the decision's raw 'Rejected'.
  const assigEntry = (Array.isArray(logs) ? logs : []).find(e => e.path === `/assignments/${assignmentId}`);
  check('B3 legacy: the assignment-level (legacy governed entity) audit entry records the SETTLED derived status',
    Boolean(assigEntry) && assigEntry.after?.status === 'Requested',
    `entry=${JSON.stringify(assigEntry && { path: assigEntry.path, after: assigEntry.after?.status })}`);

  // CLEANUP so re-runs against a persistent Postgres database start clean.
  await req('DELETE', `/assignments/${assignmentId}`);
}

/**
 * C1 — resource kinds. A subco must carry a vendor; nobody else may. The kind
 * itself must be one of the three known values.
 */
async function checkResourceKinds() {
  const vendors = await req('GET', '/vendors');
  const vendorId = (vendors.body || [])[0]?.id;
  check('C1 a vendor exists to attach a subco to', typeof vendorId === 'string', `vendors=${vendors.body?.length}`);
  if (!vendorId) return;

  const base = { role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, hireDate: '2026-01-01' };

  // ADAPTER PARITY: the pre-C1 seeded resources must serve an explicit
  // kind: 'internal' on BOTH backends. Postgres would apply the column DEFAULT
  // even if the seed omitted it; the in-memory adapter would not, and the two
  // would answer this GET with different JSON shapes.
  const seededInternal = await req('GET', '/resources/1');
  check('C1 a seeded pre-existing resource reports kind=internal',
    seededInternal.status === 200 && seededInternal.body?.kind === 'internal',
    `status=${seededInternal.status} kind=${JSON.stringify(seededInternal.body?.kind)}`);

  const badKind = await req('POST', '/resources', { body: { ...base, name: 'C1 bad kind', kind: 'contractor' } });
  check('C1 an unknown kind is rejected', badKind.status === 400, `status=${badKind.status}`);

  const subcoNoVendor = await req('POST', '/resources', { body: { ...base, name: 'C1 subco no vendor', kind: 'subco' } });
  check('C1 a subco without a vendor is rejected', subcoNoVendor.status === 400, `status=${subcoNoVendor.status}`);

  const subcoBadVendor = await req('POST', '/resources', { body: { ...base, name: 'C1 subco bad vendor', kind: 'subco', vendorId: 'V-nope' } });
  check('C1 a subco with an unknown vendor is rejected', subcoBadVendor.status === 400, `status=${subcoBadVendor.status}`);

  const internalWithVendor = await req('POST', '/resources', { body: { ...base, name: 'C1 internal with vendor', kind: 'internal', vendorId } });
  check('C1 a non-subco carrying a vendor is rejected', internalWithVendor.status === 400, `status=${internalWithVendor.status}`);

  // POST /resources responds 201 Created (see src/server.ts), not the generic
  // crud() 200 — matched here rather than asserting 200 to avoid a false FAIL.
  const subco = await req('POST', '/resources', { body: { ...base, name: 'C1 subco ok', kind: 'subco', vendorId } });
  check('C1 a subco with a vendor is created', subco.status === 201 && subco.body?.kind === 'subco', `status=${subco.status} kind=${subco.body?.kind}`);

  const plain = await req('POST', '/resources', { body: { ...base, name: 'C1 plain resource' } });
  check('C1 an omitted kind defaults to internal', plain.status === 201 && plain.body?.kind === 'internal', `kind=${plain.body?.kind}`);

  // An empty-string vendorId is accepted (same as omitted) but must never be
  // PERSISTED literally — it must normalize to absent on both create and update.
  const emptyVendorCreate = await req('POST', '/resources', { body: { ...base, name: 'C1 empty vendorId is absent', vendorId: '' } });
  check('C1 an empty-string vendorId on create is normalized to absent, not literal ""',
    emptyVendorCreate.status === 201 && !('vendorId' in (emptyVendorCreate.body || {})),
    `status=${emptyVendorCreate.status} vendorId=${JSON.stringify(emptyVendorCreate.body?.vendorId)}`);

  // Same for an explicit null: pick() copies it straight through, so without a
  // create-side strip the in-memory adapter (whose create() has no null step)
  // would store a literal null while Postgres stores NULL and reads it back
  // absent — a divergence in exactly the seam this normalization exists for.
  const nullVendorCreate = await req('POST', '/resources', { body: { ...base, name: 'C1 null vendorId is absent', vendorId: null } });
  check('C1 a null vendorId on create is normalized to absent, not literal null',
    nullVendorCreate.status === 201 && !('vendorId' in (nullVendorCreate.body || {})),
    `status=${nullVendorCreate.status} vendorId=${JSON.stringify(nullVendorCreate.body?.vendorId)}`);
  // And it must survive a re-read, not just the create response.
  if (nullVendorCreate.body?.id) {
    const reread = await req('GET', `/resources/${nullVendorCreate.body.id}`);
    check('C1 a null vendorId is still absent when the row is re-read',
      reread.status === 200 && !('vendorId' in (reread.body || {})),
      `status=${reread.status} vendorId=${JSON.stringify(reread.body?.vendorId)}`);
  }

  const emptyVendorPut = await req('PUT', `/resources/${plain.body.id}`, { body: { vendorId: '' } });
  check('C1 an empty-string vendorId on PUT is normalized to absent, not literal ""',
    emptyVendorPut.status === 200 && !('vendorId' in (emptyVendorPut.body || {})),
    `status=${emptyVendorPut.status} vendorId=${JSON.stringify(emptyVendorPut.body?.vendorId)}`);

  // --- PUT: the merged-state validation and the vendor-clear-on-demote path.
  // Everything above is POST-only; none of it would fail if the entire
  // merged-state block in src/server.ts's PUT /resources/:id handler were
  // deleted. This is the trickiest part of the task and the ground Task 4's
  // kind-change guard builds on directly, so it gets its own checks.
  const vendorId2 = (vendors.body || [])[1]?.id;
  check('C1 a second vendor exists to test a vendor-to-vendor move', typeof vendorId2 === 'string', `vendors=${vendors.body?.length}`);

  // A kind-only PUT to 'subco' on a vendor-less row must be rejected — the
  // MERGED state (new kind + the row's existing, absent vendor) is invalid.
  const putKindToSubcoNoVendor = await req('PUT', `/resources/${plain.body.id}`, { body: { kind: 'subco' } });
  check('C1 PUT kind-only to subco on a vendor-less row is rejected', putKindToSubcoNoVendor.status === 400, `status=${putKindToSubcoNoVendor.status}`);

  // A vendorId-only PUT on a row whose (unchanged) kind isn't subco must be
  // rejected — the MERGED state (the row's existing 'internal' kind + the
  // new vendor) is invalid.
  const putVendorOnlyNonSubco = await req('PUT', `/resources/${plain.body.id}`, { body: { vendorId } });
  check('C1 PUT vendorId-only on a non-subco row is rejected', putVendorOnlyNonSubco.status === 400, `status=${putVendorOnlyNonSubco.status}`);

  if (vendorId2) {
    // A subco moved to a different valid vendor: the new vendor is stored.
    const subcoToRevendor = await req('POST', '/resources', { body: { ...base, name: 'C1 subco to revendor', kind: 'subco', vendorId } });
    const revendorSetupOk = check('C1 PUT setup: subco-to-revendor fixture created',
      subcoToRevendor.status === 201 && subcoToRevendor.body?.kind === 'subco', `status=${subcoToRevendor.status}`);
    if (revendorSetupOk) {
      const revendored = await req('PUT', `/resources/${subcoToRevendor.body.id}`, { body: { vendorId: vendorId2 } });
      check('C1 PUT vendorId-only moves a subco to a different valid vendor',
        revendored.status === 200 && revendored.body?.kind === 'subco' && revendored.body?.vendorId === vendorId2,
        `status=${revendored.status} kind=${revendored.body?.kind} vendorId=${revendored.body?.vendorId}`);
    }
  }

  // A subco moved to another kind: the stale vendor must be CLEARED (absent
  // from the JSON entirely) — never left stale, and never a literal `null`
  // surviving the round trip (that would be a different bug: nullsToUndefined
  // / the in-memory null-strip both exist precisely to prevent this).
  const subcoToDemote = await req('POST', '/resources', { body: { ...base, name: 'C1 subco to demote', kind: 'subco', vendorId } });
  const demoteSetupOk = check('C1 PUT setup: subco-to-demote fixture created',
    subcoToDemote.status === 201 && subcoToDemote.body?.kind === 'subco', `status=${subcoToDemote.status}`);
  if (demoteSetupOk) {
    const demoted = await req('PUT', `/resources/${subcoToDemote.body.id}`, { body: { kind: 'internal' } });
    check('C1 PUT kind-only away from subco succeeds', demoted.status === 200 && demoted.body?.kind === 'internal',
      `status=${demoted.status} kind=${demoted.body?.kind}`);
    const afterDemote = await req('GET', `/resources/${subcoToDemote.body.id}`);
    check('C1 the cleared vendor is ABSENT (not stale, not a literal null)',
      afterDemote.status === 200 && !('vendorId' in (afterDemote.body || {})),
      `vendorId=${JSON.stringify(afterDemote.body?.vendorId)} hasKey=${afterDemote.body ? 'vendorId' in afterDemote.body : 'n/a'}`);
  }

  // An unrelated-field PUT on a genuine subco must leave kind and vendor untouched.
  const subcoUnrelated = await req('POST', '/resources', { body: { ...base, name: 'C1 subco unrelated edit', kind: 'subco', vendorId } });
  const unrelatedSetupOk = check('C1 PUT setup: subco-unrelated-edit fixture created',
    subcoUnrelated.status === 201 && subcoUnrelated.body?.kind === 'subco', `status=${subcoUnrelated.status}`);
  if (unrelatedSetupOk) {
    const unrelatedEdited = await req('PUT', `/resources/${subcoUnrelated.body.id}`, { body: { capacity: 41 } });
    check('C1 an unrelated-field PUT on a subco leaves kind and vendor unchanged',
      unrelatedEdited.status === 200 && unrelatedEdited.body?.kind === 'subco' &&
      unrelatedEdited.body?.vendorId === vendorId && unrelatedEdited.body?.capacity === 41,
      `status=${unrelatedEdited.status} kind=${unrelatedEdited.body?.kind} vendorId=${unrelatedEdited.body?.vendorId} capacity=${unrelatedEdited.body?.capacity}`);
  }

  // --- Task 4: kind-aware daily cap + the kind-change guard -----------------
  // 2026-08 is a seeded Open planning period; 2026-08-04 is a Tuesday (no
  // seeded holiday falls in August), so it is a plain working day.
  const OPEN_MONTH = '2026-08';
  const WORKING_DAY = '2026-08-04';

  // A dummy may carry more than one FTE per day; an internal resource may not.
  const dummy = await req('POST', '/resources', { body: { ...base, name: 'C1 dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  // POST /resources responds 201 (see the comment above the first POST in
  // this section) — asserted here rather than 200 to avoid a false FAIL.
  const dummyOk = check('C1 dummy created', dummy.status === 201 && dummy.body?.kind === 'dummy', `status=${dummy.status} kind=${dummy.body?.kind}`);
  if (!dummyOk) return;

  // A request + an assignment for the dummy, and another pair reusing `plain`
  // (created earlier in this section, kind still 'internal' — none of the
  // PUTs above that touched it ever succeeded in changing its kind). Neither
  // resource has any other booking, so both allocations land on a clean slate.
  // requiredRole and skills are both NOT NULL columns with no DB default
  // (schema.ts); the in-memory adapter tolerates them absent, but Postgres
  // rejects the insert — found via this task's fresh-Postgres run (a 500 on
  // this exact POST). The real UI form always sends both (skills defaults to
  // `[]` there too), so this is a smoke-fixture gap, not a product defect.
  const dummyReq = await req('POST', '/requests', { body: { name: 'C1 dummy capacity request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
  const internalReq = await req('POST', '/requests', { body: { name: 'C1 internal capacity request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
  const reqsOk = check('C1 setup: requests created for the dummy/internal assignments',
    dummyReq.status === 200 && typeof dummyReq.body?.id === 'string' &&
    internalReq.status === 200 && typeof internalReq.body?.id === 'string',
    `dummyReq status=${dummyReq.status} internalReq status=${internalReq.status}`);
  if (!reqsOk) return;

  const dummyAssignment = await req('POST', '/assignments', { body: { requestId: dummyReq.body.id, resourceId: dummy.body.id } });
  const internalAssignment = await req('POST', '/assignments', { body: { requestId: internalReq.body.id, resourceId: plain.body.id } });
  const assignmentsOk = check('C1 setup: assignments created for the dummy and the internal resource',
    dummyAssignment.status === 200 && typeof dummyAssignment.body?.id === 'string' &&
    internalAssignment.status === 200 && typeof internalAssignment.body?.id === 'string',
    `dummy assignment status=${dummyAssignment.status} internal assignment status=${internalAssignment.status}`);
  if (!assignmentsOk) return;
  const dummyAssignmentId = dummyAssignment.body.id;
  const internalAssignmentId = internalAssignment.body.id;

  const overOneFte = await req('PUT', `/assignments/${dummyAssignmentId}/allocation`, {
    body: { month: OPEN_MONTH, dailyHours: { [WORKING_DAY]: 20 } },
  });
  check('C1 a dummy accepts 2.5 FTE on a day', overOneFte.status === 200, `status=${overOneFte.status} err=${overOneFte.body?.error}`);

  // The approval feed must surface the dummy's kind on its row (Task 4 review
  // finding): the page needs it to skip the saturation band/percentage for a
  // resource that has no capacity to saturate (spec §4.3).
  const feedWithDummy = await req('GET', `/allocation-approvals?from=${OPEN_MONTH}&to=${OPEN_MONTH}&status=all`);
  const dummyRow = (feedWithDummy.body?.rows || []).find(r => r.resourceId === dummy.body.id);
  check('C1 the allocation-approvals feed row for the dummy carries kind=dummy',
    feedWithDummy.status === 200 && dummyRow?.kind === 'dummy',
    `status=${feedWithDummy.status} row=${JSON.stringify(dummyRow)}`);

  const internalOver = await req('PUT', `/assignments/${internalAssignmentId}/allocation`, {
    body: { month: OPEN_MONTH, dailyHours: { [WORKING_DAY]: 20 } },
  });
  check('C1 an internal resource is still capped at 1 FTE', internalOver.status === 400 && /daily capacity/.test(internalOver.body?.error || ''), `status=${internalOver.status}`);

  // Turning that dummy into an internal resource would break its own bookings.
  const demote = await req('PUT', `/resources/${dummy.body.id}`, { body: { kind: 'internal' } });
  check('C1 a kind change that breaks existing allocations is refused', demote.status === 400 && /exceed/i.test(demote.body?.error || ''), `status=${demote.status} err=${demote.body?.error}`);

  // --- Task 6: the /capacity/monthly envelope partitions internal vs. demand.
  // The demote above was refused, so the dummy is still 'dummy' and still
  // carries its 20h/day booking on WORKING_DAY — checked HERE, before the
  // zero-and-demote below removes it.
  const cap = await req('GET', '/capacity/monthly');
  check('C1 capacity envelope carries demandRows', Array.isArray(cap.body?.demandRows), `status=${cap.status}`);
  const kindsInRows = (cap.body?.rows || []).map(r => r.resourceId);
  const demandIds = (cap.body?.demandRows || []).map(r => r.resourceId);
  check('C1 the dummy is in demandRows, not rows',
    demandIds.includes(dummy.body.id) && !kindsInRows.includes(dummy.body.id),
    `rows=${kindsInRows.length} demand=${demandIds.length}`);
  const firstMonth = (cap.body?.months || [])[0];
  check('C1 totals expose uncovered demand separately',
    firstMonth !== undefined && typeof cap.body.totals[firstMonth]?.demandFteUncovered === 'number',
    `totals=${JSON.stringify(cap.body?.totals?.[firstMonth])}`);

  // Zero the allocation, then assert the same change now succeeds.
  const zeroed = await req('PUT', `/assignments/${dummyAssignmentId}/allocation`, {
    body: { month: OPEN_MONTH, dailyHours: { [WORKING_DAY]: 0 } },
  });
  check('C1 setup: dummy allocation zeroed before retrying the demote', zeroed.status === 200, `status=${zeroed.status}`);

  const demoteOk = await req('PUT', `/resources/${dummy.body.id}`, { body: { kind: 'internal' } });
  check('C1 the same kind change succeeds once the allocation fits', demoteOk.status === 200 && demoteOk.body?.kind === 'internal', `status=${demoteOk.status}`);
}

/**
 * C2 — handing a dummy's hours to a real person. The transfer is capped by what
 * that person can absorb, so a multi-FTE dummy needs more than one substitution.
 */
async function checkDummySubstitution() {
  const MONTH = '2026-04';
  const DAY = `${MONTH}-07`; // Tuesday
  const DAY2 = `${MONTH}-08`; // Wednesday — a second day, for the demoted-existing-work case

  const base = { role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, hireDate: '2026-01-01' };

  // Fixtures: a dummy booked at 2 FTE on one working day of an open month, an
  // internal person free that day, a second dummy of a non-internal kind (to
  // prove a non-internal target is refused), a plain internal resource booked
  // on its OWN request (to prove a non-dummy month is refused — kept separate
  // from `person` so its booking never eats into the target's daily room), and
  // a THIRD dummy on the SAME request as the first, for the
  // demoted-existing-work case.
  const dummy = await req('POST', '/resources', { body: { ...base, name: 'C2 dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const person = await req('POST', '/resources', { body: { ...base, name: 'C2 person', kind: 'internal', contractHoursPerDay: 8 } });
  const otherDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 other dummy (bad target)', kind: 'dummy', contractHoursPerDay: 8 } });
  const plainInternal = await req('POST', '/resources', { body: { ...base, name: 'C2 plain internal (non-dummy month)', kind: 'internal', contractHoursPerDay: 8 } });
  const dummy2 = await req('POST', '/resources', { body: { ...base, name: 'C2 second dummy (demotes existing work)', kind: 'dummy', contractHoursPerDay: 8 } });
  const setupOk = check('C2 setup: dummy/person/other-dummy/plain-internal/dummy2 resources created',
    dummy.status === 201 && person.status === 201 && otherDummy.status === 201 && plainInternal.status === 201 && dummy2.status === 201,
    `dummy=${dummy.status} person=${person.status} other=${otherDummy.status} plain=${plainInternal.status} dummy2=${dummy2.status}`);
  if (!setupOk) return;
  const personId = person.body.id;
  const otherDummyId = otherDummy.body.id;

  const request = await req('POST', '/requests', { body: { name: 'C2 substitution request', requiredRole: 'Developer', requiredEffort: 2, skills: [] } });
  const plainRequest = await req('POST', '/requests', { body: { name: 'C2 non-dummy month request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
  const reqsOk = check('C2 setup: requests created',
    request.status === 200 && typeof request.body?.id === 'string' &&
    plainRequest.status === 200 && typeof plainRequest.body?.id === 'string',
    `request=${request.status} plainRequest=${plainRequest.status}`);
  if (!reqsOk) return;

  // The dummy's assignment (2 FTE) and the second dummy's assignment share
  // `request` — that is what lets the demoted-existing-work substitution below
  // land on the SAME target assignment the first substitution created. The
  // plain-internal fixture is deliberately on its OWN, unrelated request.
  const dummyAssignment = await req('POST', '/assignments', { body: { requestId: request.body.id, resourceId: dummy.body.id } });
  const plainAssignment = await req('POST', '/assignments', { body: { requestId: plainRequest.body.id, resourceId: plainInternal.body.id } });
  const dummy2Assignment = await req('POST', '/assignments', { body: { requestId: request.body.id, resourceId: dummy2.body.id } });
  const assignmentsOk = check('C2 setup: assignments created (dummy, plain internal, second dummy)',
    dummyAssignment.status === 200 && typeof dummyAssignment.body?.id === 'string' &&
    plainAssignment.status === 200 && typeof plainAssignment.body?.id === 'string' &&
    dummy2Assignment.status === 200 && typeof dummy2Assignment.body?.id === 'string',
    `dummy=${dummyAssignment.status} plain=${plainAssignment.status} dummy2=${dummy2Assignment.status}`);
  if (!assignmentsOk) return;
  const dummyAssignmentId = dummyAssignment.body.id;
  const dummy2AssignmentId = dummy2Assignment.body.id;

  // Book the dummy at 2 FTE (16h) on DAY.
  const booked = await req('PUT', `/assignments/${dummyAssignmentId}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 16 } } });
  check('C2 setup: dummy booked at 2 FTE', booked.status === 200, `status=${booked.status} err=${booked.body?.error}`);
  const dummyMonthId = `${dummyAssignmentId}:${MONTH}`;

  // A non-dummy month row, to prove the 'only a dummy month can be substituted' guard.
  const plainBooked = await req('PUT', `/assignments/${plainAssignment.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 1 } } });
  check('C2 setup: plain internal resource booked (non-dummy month fixture)', plainBooked.status === 200, `status=${plainBooked.status}`);
  const internalMonthId = `${plainAssignment.body.id}:${MONTH}`;

  // Book the second dummy at 4h on a DIFFERENT day, for the demoted-existing-work case below.
  const dummy2Booked = await req('PUT', `/assignments/${dummy2AssignmentId}/allocation`, { body: { month: MONTH, dailyHours: { [DAY2]: 4 } } });
  check('C2 setup: second dummy booked on a different day', dummy2Booked.status === 200, `status=${dummy2Booked.status} err=${dummy2Booked.body?.error}`);
  const dummy2MonthId = `${dummy2AssignmentId}:${MONTH}`;

  const sub = await req('POST', `/assignment-months/${dummyMonthId}/substitute`, {
    body: { targetResourceId: personId },
  });
  check('C2 substitution accepted', sub.status === 200, `status=${sub.status} err=${sub.body?.error}`);
  const outcome = (sub.body?.outcomes || [])[0];
  check('C2 the person absorbs one FTE', outcome?.transferredHours === 8, `transferred=${outcome?.transferredHours}`);
  check('C2 the rest stays on the dummy', outcome?.remainingHours === 8, `remaining=${outcome?.remainingHours}`);
  check('C2 no existing work was demoted on a fresh month', !outcome?.demotedExistingWork, `demoted=${outcome?.demotedExistingWork}`);

  const dummyAfter = await req('GET', `/assignments/${dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
  const dummyDay = (dummyAfter.body.days || []).find(d => d.date === DAY);
  check('C2 the dummy day is reduced, not cleared', dummyDay?.hours === 8, `hours=${dummyDay?.hours}`);

  const personAssignmentId = outcome?.targetAssignmentMonthId?.split(':')[0];
  const personAlloc = await req('GET', `/assignments/${personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
  const personMonth = (personAlloc.body.months || [])[0];
  check('C2 the person-s month awaits approval', personMonth?.status === 'Requested', `status=${personMonth?.status}`);
  check('C2 the month is linked back to the dummy', personMonth?.replacedFromAssignmentMonthId === dummyMonthId, `link=${personMonth?.replacedFromAssignmentMonthId}`);

  const notDummy = await req('POST', `/assignment-months/${internalMonthId}/substitute`, { body: { targetResourceId: personId } });
  check('C2 substituting a non-dummy month is refused', notDummy.status === 400, `status=${notDummy.status}`);

  const badTarget = await req('POST', `/assignment-months/${dummyMonthId}/substitute`, { body: { targetResourceId: otherDummyId } });
  check('C2 a non-internal target is refused', badTarget.status === 400, `status=${badTarget.status}`);

  // RBAC (spec §5.7): substituting is an APPROVER action, gated to
  // resource-manager/delivery-executive/admin by the '/assignment-months'
  // mutation rule. 'pm' is the interesting negative — a planner may mutate
  // '/assignments' (and therefore book the dummy's hours in the first place) but
  // must NOT be able to hand them to a person. Asserted here so the rule
  // transcribed in docs/roles-and-permissions.md cannot silently drift: roleGate
  // rejects before the handler runs, so this leaves no state behind.
  const asPlanner = await req('POST', `/assignment-months/${dummyMonthId}/substitute`, {
    headers: { 'X-User-Id': '3', 'X-User-Role': 'pm' },
    body: { targetResourceId: personId },
  });
  check("C2 substituting as 'pm' is refused by RBAC", asPlanner.status === 403,
    `status=${asPlanner.status} body=${JSON.stringify(asPlanner.body)}`);

  const saturated = await req('POST', `/assignment-months/${dummyMonthId}/substitute`, { body: { targetResourceId: personId } });
  check('C2 a saturated target transfers nothing but does not error',
    saturated.status === 200 && (saturated.body.outcomes || [])[0]?.transferredHours === 0,
    `status=${saturated.status} outcome=${JSON.stringify(saturated.body?.outcomes?.[0])}`);
  check('C2 a saturated substitution explains why (distinct from an empty dummy month)',
    (saturated.body?.outcomes || [])[0]?.skipped === 'the target has no capacity left in this month',
    `skipped=${(saturated.body?.outcomes || [])[0]?.skipped}`);

  // --- demotedExistingWork: approve the person's first month, then substitute
  // MORE hours (a different day, same request -> same target assignment) onto
  // it. The added work must demote the month back to Requested, and the
  // outcome must say so — the operator must not discover this after the fact.
  const DECIDER_HEADERS = { 'X-User-Id': '9', 'X-User-Role': 'admin' };
  const approveFirst = await req('POST', '/allocation-approvals/decide', {
    headers: DECIDER_HEADERS,
    body: { items: [{ assignmentMonthId: outcome?.targetAssignmentMonthId, decision: 'Approved', note: 'looks good' }] },
  });
  check('C2 setup: the person-s first month is approved', (approveFirst.body?.results || [])[0]?.status === 'Approved',
    `result=${JSON.stringify(approveFirst.body?.results)}`);
  const allocatedCheck = await req('GET', `/assignments/${personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
  check('C2 setup: the person-s month is now Allocated', (allocatedCheck.body.months || [])[0]?.status === 'Allocated',
    `status=${(allocatedCheck.body.months || [])[0]?.status}`);

  const secondSub = await req('POST', `/assignment-months/${dummy2MonthId}/substitute`, { body: { targetResourceId: personId } });
  check('C2 second substitution accepted', secondSub.status === 200, `status=${secondSub.status} err=${secondSub.body?.error}`);
  const secondOutcome = (secondSub.body?.outcomes || [])[0];
  check('C2 the second transfer lands on the SAME target month', secondOutcome?.targetAssignmentMonthId === outcome?.targetAssignmentMonthId,
    `target=${secondOutcome?.targetAssignmentMonthId} expected=${outcome?.targetAssignmentMonthId}`);
  check('C2 the previously-approved month is demoted back to Requested',
    secondOutcome?.status === 'Requested' && secondOutcome?.demotedExistingWork === true,
    `status=${secondOutcome?.status} demoted=${secondOutcome?.demotedExistingWork}`);

  // --- self-managed substitution: the target's manager IS the acting identity
  // (the suite's default X-User-Id: 1), so the transfer auto-approves straight
  // to Allocated with no back-link left dangling.
  const selfManagedPerson = await req('POST', '/resources', { body: { ...base, name: 'C2 self-managed person', kind: 'internal', contractHoursPerDay: 8, managerId: '1' } });
  const selfManagedDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 self-managed dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const selfSetupOk = check('C2 setup: self-managed person/dummy resources created',
    selfManagedPerson.status === 201 && selfManagedDummy.status === 201,
    `person=${selfManagedPerson.status} dummy=${selfManagedDummy.status}`);
  if (selfSetupOk) {
    const selfRequest = await req('POST', '/requests', { body: { name: 'C2 self-managed request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
    const selfReqOk = check('C2 setup: self-managed request created', selfRequest.status === 200 && typeof selfRequest.body?.id === 'string', `status=${selfRequest.status}`);
    if (selfReqOk) {
      const selfAssignment = await req('POST', '/assignments', { body: { requestId: selfRequest.body.id, resourceId: selfManagedDummy.body.id } });
      const selfAssignOk = check('C2 setup: self-managed dummy assignment created', selfAssignment.status === 200 && typeof selfAssignment.body?.id === 'string', `status=${selfAssignment.status}`);
      if (selfAssignOk) {
        const selfBooked = await req('PUT', `/assignments/${selfAssignment.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 4 } } });
        check('C2 setup: self-managed dummy booked', selfBooked.status === 200, `status=${selfBooked.status} err=${selfBooked.body?.error}`);
        const selfDummyMonthId = `${selfAssignment.body.id}:${MONTH}`;

        const selfSub = await req('POST', `/assignment-months/${selfDummyMonthId}/substitute`, { body: { targetResourceId: selfManagedPerson.body.id } });
        const selfOutcome = (selfSub.body?.outcomes || [])[0];
        check('C2 a self-managed substitution lands Allocated directly',
          selfSub.status === 200 && selfOutcome?.status === 'Allocated', `status=${selfSub.status} outcome=${JSON.stringify(selfOutcome)}`);

        const selfPersonAssignmentId = selfOutcome?.targetAssignmentMonthId?.split(':')[0];
        const selfPersonAlloc = await req('GET', `/assignments/${selfPersonAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
        const selfPersonMonth = (selfPersonAlloc.body.months || [])[0];
        check('C2 the self-managed month carries no dangling back-link or approval',
          selfPersonMonth !== undefined && !('replacedFromAssignmentMonthId' in selfPersonMonth) && !('approvalId' in selfPersonMonth),
          `month=${JSON.stringify(selfPersonMonth)}`);
      }
    }
  }

  // --- Review fix verification: an EMPTY dummy month (no hours booked at all)
  // gets its OWN zero-transfer reason, distinct from "target saturated" above,
  // and a zero-transfer attempt never creates a phantom Draft assignment for
  // the target (the lock-ordering/phantom-assignment review findings).
  const emptyDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 empty dummy (no hours booked)', kind: 'dummy', contractHoursPerDay: 8 } });
  const phantomTarget = await req('POST', '/resources', { body: { ...base, name: 'C2 phantom-check target', kind: 'internal', contractHoursPerDay: 8 } });
  const emptySetupOk = check('C2 setup: empty-dummy/phantom-target resources created',
    emptyDummy.status === 201 && phantomTarget.status === 201,
    `emptyDummy=${emptyDummy.status} phantomTarget=${phantomTarget.status}`);
  if (emptySetupOk) {
    const emptyRequest = await req('POST', '/requests', { body: { name: 'C2 empty-dummy request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
    const emptyReqOk = check('C2 setup: empty-dummy request created', emptyRequest.status === 200 && typeof emptyRequest.body?.id === 'string', `status=${emptyRequest.status}`);
    if (emptyReqOk) {
      const emptyAssignment = await req('POST', '/assignments', { body: { requestId: emptyRequest.body.id, resourceId: emptyDummy.body.id } });
      const emptyAssignOk = check('C2 setup: empty-dummy assignment created', emptyAssignment.status === 200 && typeof emptyAssignment.body?.id === 'string', `status=${emptyAssignment.status}`);
      if (emptyAssignOk) {
        // A 0h PUT still lazily creates the month row (Draft, via ensureAssignmentMonth)
        // without creating any day row — exactly "a dummy month with no hours booked".
        const emptyZeroPut = await req('PUT', `/assignments/${emptyAssignment.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 0 } } });
        check('C2 setup: empty-dummy month row exists with no day rows', emptyZeroPut.status === 200, `status=${emptyZeroPut.status}`);
        const emptyDummyMonthId = `${emptyAssignment.body.id}:${MONTH}`;

        const emptySub = await req('POST', `/assignment-months/${emptyDummyMonthId}/substitute`, { body: { targetResourceId: phantomTarget.body.id } });
        const emptyOutcome = (emptySub.body?.outcomes || [])[0];
        check('C2 an empty dummy month gets its own zero-transfer reason',
          emptySub.status === 200 && emptyOutcome?.transferredHours === 0 &&
          emptyOutcome?.skipped === 'the dummy has no hours booked in this month',
          `status=${emptySub.status} outcome=${JSON.stringify(emptyOutcome)}`);

        const afterAssignments = await req('GET', '/assignments');
        const phantom = (afterAssignments.body || []).find(a => a.resourceId === phantomTarget.body.id);
        check('C2 a zero-transfer substitution creates no phantom assignment for the target',
          phantom === undefined, `phantom=${JSON.stringify(phantom)}`);
      }
    }
  }

  // --- applyToRemainingMonths (Task 4): a dummy booked across THREE
  // consecutive OPEN months, substituted from the FIRST with
  // `applyToRemainingMonths: true`, must return one outcome PER MONTH — not
  // just the primary one — each landing on its own target month row, and the
  // dummy's LATER months (2nd/3rd) must be reduced too, not just the first.
  const REMAINING_M1 = '2026-05', REMAINING_M2 = '2026-06', REMAINING_M3 = '2026-07';
  const REMAINING_DAY1 = `${REMAINING_M1}-05`; // Tuesday
  const REMAINING_DAY2 = `${REMAINING_M2}-01`; // Monday
  const REMAINING_DAY3 = `${REMAINING_M3}-06`; // Monday

  const remDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 remaining-months dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const remPerson = await req('POST', '/resources', { body: { ...base, name: 'C2 remaining-months person', kind: 'internal', contractHoursPerDay: 8 } });
  const remSetupOk = check('C2 remaining-months setup: dummy/person resources created',
    remDummy.status === 201 && remPerson.status === 201,
    `dummy=${remDummy.status} person=${remPerson.status}`);
  if (remSetupOk) {
    const remRequest = await req('POST', '/requests', { body: { name: 'C2 remaining-months request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
    const remReqOk = check('C2 remaining-months setup: request created', remRequest.status === 200 && typeof remRequest.body?.id === 'string', `status=${remRequest.status}`);
    if (remReqOk) {
      const remAssignment = await req('POST', '/assignments', { body: { requestId: remRequest.body.id, resourceId: remDummy.body.id } });
      const remAssignOk = check('C2 remaining-months setup: dummy assignment created', remAssignment.status === 200 && typeof remAssignment.body?.id === 'string', `status=${remAssignment.status}`);
      if (remAssignOk) {
        const remAssignmentId = remAssignment.body.id;
        const remBook1 = await req('PUT', `/assignments/${remAssignmentId}/allocation`, { body: { month: REMAINING_M1, dailyHours: { [REMAINING_DAY1]: 8 } } });
        const remBook2 = await req('PUT', `/assignments/${remAssignmentId}/allocation`, { body: { month: REMAINING_M2, dailyHours: { [REMAINING_DAY2]: 8 } } });
        const remBook3 = await req('PUT', `/assignments/${remAssignmentId}/allocation`, { body: { month: REMAINING_M3, dailyHours: { [REMAINING_DAY3]: 8 } } });
        const remBookedOk = check('C2 remaining-months setup: dummy booked at 1 FTE across three consecutive months',
          remBook1.status === 200 && remBook2.status === 200 && remBook3.status === 200,
          `m1=${remBook1.status} m2=${remBook2.status} m3=${remBook3.status}`);
        if (remBookedOk) {
          const remDummyMonth1Id = `${remAssignmentId}:${REMAINING_M1}`;

          const remSub = await req('POST', `/assignment-months/${remDummyMonth1Id}/substitute`, {
            body: { targetResourceId: remPerson.body.id, applyToRemainingMonths: true },
          });
          check('C2 applyToRemainingMonths accepted', remSub.status === 200, `status=${remSub.status} err=${remSub.body?.error}`);
          const remOutcomes = remSub.body?.outcomes || [];
          check('C2 applyToRemainingMonths returns one outcome per month (3)', remOutcomes.length === 3,
            `count=${remOutcomes.length} outcomes=${JSON.stringify(remOutcomes)}`);
          check('C2 applyToRemainingMonths outcomes are in ascending month order',
            remOutcomes.map(o => o.month).join(',') === [REMAINING_M1, REMAINING_M2, REMAINING_M3].join(','),
            `months=${remOutcomes.map(o => o.month).join(',')}`);
          check('C2 applyToRemainingMonths fully absorbs each month (1 FTE dummy, 1 FTE-capable person)',
            remOutcomes.every(o => o.transferredHours === 8 && o.remainingHours === 0),
            `outcomes=${JSON.stringify(remOutcomes)}`);
          const remTargetAssignmentIds = new Set(remOutcomes.map(o => o.targetAssignmentMonthId?.split(':')[0]));
          check('C2 applyToRemainingMonths lands every month on its OWN target month row, all on the SAME target assignment',
            remOutcomes.every(o => typeof o.targetAssignmentMonthId === 'string') &&
            new Set(remOutcomes.map(o => o.targetAssignmentMonthId)).size === 3 &&
            remTargetAssignmentIds.size === 1,
            `outcomes=${JSON.stringify(remOutcomes)}`);

          // The dummy's LATER months (2nd and 3rd) must be reduced too, not
          // just the primary one that the pre-Task-4 handler already covered.
          const remDummyAfter = await req('GET', `/assignments/${remAssignmentId}/allocation?from=${REMAINING_M1}&to=${REMAINING_M3}`);
          const remDummyDays = remDummyAfter.body?.days || [];
          check('C2 applyToRemainingMonths clears the dummy-s days in ALL three months',
            [REMAINING_DAY1, REMAINING_DAY2, REMAINING_DAY3].every(d => (remDummyDays.find(x => x.date === d)?.hours ?? 0) === 0),
            `days=${JSON.stringify(remDummyDays)}`);
        }
      }
    }
  }

  // --- applyToRemainingMonths + a CLOSED later month: the closed month must
  // be skipped WITH A REASON, but the months after it must still transfer —
  // one closed month must never abort the ones that follow.
  const CLOSED_M1 = '2026-08', CLOSED_M2 = '2026-09', CLOSED_M3 = '2026-10';
  const CLOSED_DAY1 = `${CLOSED_M1}-03`; // Monday
  const CLOSED_DAY2 = `${CLOSED_M2}-01`; // Tuesday
  const CLOSED_DAY3 = `${CLOSED_M3}-05`; // Monday

  const closedDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 closed-month dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const closedPerson = await req('POST', '/resources', { body: { ...base, name: 'C2 closed-month person', kind: 'internal', contractHoursPerDay: 8 } });
  const closedSetupOk = check('C2 closed-month setup: dummy/person resources created',
    closedDummy.status === 201 && closedPerson.status === 201,
    `dummy=${closedDummy.status} person=${closedPerson.status}`);
  if (closedSetupOk) {
    const closedRequest = await req('POST', '/requests', { body: { name: 'C2 closed-month request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
    const closedReqOk = check('C2 closed-month setup: request created', closedRequest.status === 200 && typeof closedRequest.body?.id === 'string', `status=${closedRequest.status}`);
    if (closedReqOk) {
      const closedAssignment = await req('POST', '/assignments', { body: { requestId: closedRequest.body.id, resourceId: closedDummy.body.id } });
      const closedAssignOk = check('C2 closed-month setup: dummy assignment created', closedAssignment.status === 200 && typeof closedAssignment.body?.id === 'string', `status=${closedAssignment.status}`);
      if (closedAssignOk) {
        const closedAssignmentId = closedAssignment.body.id;
        const closedBook1 = await req('PUT', `/assignments/${closedAssignmentId}/allocation`, { body: { month: CLOSED_M1, dailyHours: { [CLOSED_DAY1]: 8 } } });
        const closedBook2 = await req('PUT', `/assignments/${closedAssignmentId}/allocation`, { body: { month: CLOSED_M2, dailyHours: { [CLOSED_DAY2]: 8 } } });
        const closedBook3 = await req('PUT', `/assignments/${closedAssignmentId}/allocation`, { body: { month: CLOSED_M3, dailyHours: { [CLOSED_DAY3]: 8 } } });
        const closedBookedOk = check('C2 closed-month setup: dummy booked at 1 FTE across three consecutive months',
          closedBook1.status === 200 && closedBook2.status === 200 && closedBook3.status === 200,
          `m1=${closedBook1.status} m2=${closedBook2.status} m3=${closedBook3.status}`);
        if (closedBookedOk) {
          const closePeriod = await req('PUT', `/planning-periods/${CLOSED_M2}`, { body: { status: 'Closed' } });
          check('C2 closed-month setup: middle month closed for planning', closePeriod.status === 200, `status=${closePeriod.status}`);

          const closedDummyMonth1Id = `${closedAssignmentId}:${CLOSED_M1}`;
          const closedSub = await req('POST', `/assignment-months/${closedDummyMonth1Id}/substitute`, {
            body: { targetResourceId: closedPerson.body.id, applyToRemainingMonths: true },
          });
          check('C2 applyToRemainingMonths with a closed later month is still accepted', closedSub.status === 200,
            `status=${closedSub.status} err=${closedSub.body?.error}`);
          const closedOutcomes = closedSub.body?.outcomes || [];
          check('C2 applyToRemainingMonths still returns one outcome per month even when one is closed',
            closedOutcomes.length === 3, `count=${closedOutcomes.length} outcomes=${JSON.stringify(closedOutcomes)}`);

          const [closedOutcome1, closedOutcome2, closedOutcome3] = closedOutcomes;
          check('C2 the open first month still transfers',
            closedOutcome1?.month === CLOSED_M1 && closedOutcome1?.transferredHours === 8 && closedOutcome1?.remainingHours === 0,
            `outcome=${JSON.stringify(closedOutcome1)}`);
          check('C2 the closed month is skipped with a reason, not transferred',
            closedOutcome2?.month === CLOSED_M2 && closedOutcome2?.transferredHours === 0 &&
            typeof closedOutcome2?.skipped === 'string' && closedOutcome2.skipped.length > 0,
            `outcome=${JSON.stringify(closedOutcome2)}`);
          check('C2 the month AFTER the closed one still transfers (one closed month does not abort the rest)',
            closedOutcome3?.month === CLOSED_M3 && closedOutcome3?.transferredHours === 8 && closedOutcome3?.remainingHours === 0,
            `outcome=${JSON.stringify(closedOutcome3)}`);

          // The closed month's dummy hours must be left exactly as they were.
          const closedDummyAfter = await req('GET', `/assignments/${closedAssignmentId}/allocation?from=${CLOSED_M2}&to=${CLOSED_M2}`);
          const closedDummyDay = (closedDummyAfter.body?.days || []).find(d => d.date === CLOSED_DAY2);
          check('C2 the closed month-s dummy hours are untouched',
            closedDummyDay?.hours === 8, `hours=${closedDummyDay?.hours}`);

          const reopenPeriod = await req('PUT', `/planning-periods/${CLOSED_M2}`, { body: { status: 'Open' } });
          check('C2 closed-month teardown: middle month reopened for planning', reopenPeriod.status === 200, `status=${reopenPeriod.status}`);
        }
      }
    }
  }

  // --- applyToRemainingMonths with NO later months at all: a dummy booked in
  // only ONE month must still return exactly that one outcome — `laterRows`
  // is empty, so the loop body never runs. Correct by inspection already
  // (an empty `laterRows` array trivially skips the `for`), but untested
  // until now.
  const soloDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 solo-month dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const soloPerson = await req('POST', '/resources', { body: { ...base, name: 'C2 solo-month person', kind: 'internal', contractHoursPerDay: 8 } });
  const soloSetupOk = check('C2 solo-month setup: dummy/person resources created',
    soloDummy.status === 201 && soloPerson.status === 201,
    `dummy=${soloDummy.status} person=${soloPerson.status}`);
  if (soloSetupOk) {
    const soloRequest = await req('POST', '/requests', { body: { name: 'C2 solo-month request', requiredRole: 'Developer', requiredEffort: 1, skills: [] } });
    const soloReqOk = check('C2 solo-month setup: request created', soloRequest.status === 200 && typeof soloRequest.body?.id === 'string', `status=${soloRequest.status}`);
    if (soloReqOk) {
      const soloAssignment = await req('POST', '/assignments', { body: { requestId: soloRequest.body.id, resourceId: soloDummy.body.id } });
      const soloAssignOk = check('C2 solo-month setup: dummy assignment created', soloAssignment.status === 200 && typeof soloAssignment.body?.id === 'string', `status=${soloAssignment.status}`);
      if (soloAssignOk) {
        const soloAssignmentId = soloAssignment.body.id;
        const soloBooked = await req('PUT', `/assignments/${soloAssignmentId}/allocation`, { body: { month: REMAINING_M1, dailyHours: { [REMAINING_DAY1]: 8 } } });
        check('C2 solo-month setup: dummy booked in exactly one month', soloBooked.status === 200, `status=${soloBooked.status} err=${soloBooked.body?.error}`);

        const soloMonthId = `${soloAssignmentId}:${REMAINING_M1}`;
        const soloSub = await req('POST', `/assignment-months/${soloMonthId}/substitute`, {
          body: { targetResourceId: soloPerson.body.id, applyToRemainingMonths: true },
        });
        check('C2 applyToRemainingMonths with no later months is accepted', soloSub.status === 200, `status=${soloSub.status} err=${soloSub.body?.error}`);
        const soloOutcomes = soloSub.body?.outcomes || [];
        check('C2 applyToRemainingMonths with no later months returns exactly ONE outcome (no phantom entries)',
          soloOutcomes.length === 1 && soloOutcomes[0]?.month === REMAINING_M1 && soloOutcomes[0]?.transferredHours === 8,
          `outcomes=${JSON.stringify(soloOutcomes)}`);
      }
    }
  }

  // --- GIVE-BACK ON DECISION (Task 5). A substituted month carries the hours
  // AND a link to the dummy month they came from; the decision closes that link:
  //   (1) a REJECTION hands every transferred hour back and leaves the person
  //       holding nothing — she never took the work;
  //   (2) an APPROVAL hands back only what the approver TRIMMED before
  //       approving, and leaves her the approved remainder.
  // Each scenario runs on its OWN fixtures: the pair at the top of this section
  // has since been approved, demoted and re-substituted, so its back-link no
  // longer points where these checks need it to.
  //
  // The decision is taken by a DIFFERENT principal than the one that requested
  // the substitution (the suite default, X-User-Id 1) — Segregation of Duties
  // forbids deciding your own item.
  const GIVE_BACK_DECIDER = { 'X-User-Id': '9', 'X-User-Role': 'admin' };

  /**
   * A fresh dummy booked at 2 FTE on DAY plus a free person, substituted once:
   * 8h move to the person (her 1-FTE ceiling), 8h stay on the dummy, and her
   * month awaits approval carrying the back-link. Returns undefined (having
   * already recorded the failing check) when any setup step fails.
   */
  async function giveBackFixture(label) {
    const gbDummy = await req('POST', '/resources', { body: { ...base, name: `C2 ${label} dummy`, kind: 'dummy', contractHoursPerDay: 8 } });
    const gbPerson = await req('POST', '/resources', { body: { ...base, name: `C2 ${label} person`, kind: 'internal', contractHoursPerDay: 8 } });
    if (!check(`C2 ${label} setup: dummy/person resources created`,
      gbDummy.status === 201 && gbPerson.status === 201,
      `dummy=${gbDummy.status} person=${gbPerson.status}`)) return undefined;

    const gbRequest = await req('POST', '/requests', { body: { name: `C2 ${label} request`, requiredRole: 'Developer', requiredEffort: 2, skills: [] } });
    if (!check(`C2 ${label} setup: request created`,
      gbRequest.status === 200 && typeof gbRequest.body?.id === 'string', `status=${gbRequest.status}`)) return undefined;

    const gbAssignment = await req('POST', '/assignments', { body: { requestId: gbRequest.body.id, resourceId: gbDummy.body.id } });
    if (!check(`C2 ${label} setup: dummy assignment created`,
      gbAssignment.status === 200 && typeof gbAssignment.body?.id === 'string', `status=${gbAssignment.status}`)) return undefined;

    const gbBooked = await req('PUT', `/assignments/${gbAssignment.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 16 } } });
    if (!check(`C2 ${label} setup: dummy booked at 2 FTE`,
      gbBooked.status === 200, `status=${gbBooked.status} err=${gbBooked.body?.error}`)) return undefined;

    const gbSub = await req('POST', `/assignment-months/${gbAssignment.body.id}:${MONTH}/substitute`, {
      body: { targetResourceId: gbPerson.body.id },
    });
    const gbOutcome = (gbSub.body?.outcomes || [])[0];
    const gbTargetMonthId = typeof gbOutcome?.targetAssignmentMonthId === 'string' ? gbOutcome.targetAssignmentMonthId : '';
    if (!check(`C2 ${label} setup: one FTE moved to the person, her month awaits approval`,
      gbSub.status === 200 && gbOutcome?.transferredHours === 8 && gbOutcome?.status === 'Requested' && gbTargetMonthId !== '',
      `status=${gbSub.status} outcome=${JSON.stringify(gbOutcome)}`)) return undefined;

    return {
      dummyAssignmentId: gbAssignment.body.id,
      personAssignmentId: gbTargetMonthId.split(':')[0],
      substitutedMonthId: gbTargetMonthId,
    };
  }

  const rejFixture = await giveBackFixture('give-back rejection');
  if (rejFixture) {
    const dec = await req('POST', '/allocation-approvals/decide', {
      headers: GIVE_BACK_DECIDER,
      body: { items: [{ assignmentMonthId: rejFixture.substitutedMonthId, decision: 'Rejected', note: 'not available after all' }] },
    });
    check('C2 rejection decided', (dec.body?.results || [])[0]?.status === 'Rejected', `res=${JSON.stringify(dec.body?.results)}`);

    const dummyBack = await req('GET', `/assignments/${rejFixture.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    check('C2 the dummy is whole again after a rejection',
      (dummyBack.body.days || []).find(d => d.date === DAY)?.hours === 16,
      `hours=${(dummyBack.body.days || []).find(d => d.date === DAY)?.hours}`);

    const personBack = await req('GET', `/assignments/${rejFixture.personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    check('C2 the person keeps nothing from a rejected substitution',
      (personBack.body.days || []).every(d => d.date !== DAY), 'the day is still booked on the person');
    const rejMonth = (personBack.body.months || [])[0];
    check('C2 the rejected month is Rejected', rejMonth?.status === 'Rejected', `status=${rejMonth?.status}`);
    check('C2 the back-link AND the recorded hours are cleared by the decision',
      rejMonth !== undefined && !('replacedFromAssignmentMonthId' in rejMonth) && !('replacedDays' in rejMonth),
      `month=${JSON.stringify(rejMonth)}`);

    // Derived state: the dummy's assignedHours must follow its day rows back up
    // (there is no GET /assignments/:id — the list is the only read).
    const allAssignments = await req('GET', '/assignments');
    const dummyAssig = (allAssignments.body || []).find(a => a.id === rejFixture.dummyAssignmentId);
    check('C2 the dummy assignment-s assignedHours is restored with its days',
      dummyAssig?.assignedHours === 16, `assignedHours=${dummyAssig?.assignedHours}`);
  }

  const trimFixture = await giveBackFixture('give-back trimmed approval');
  if (trimFixture) {
    // The approver CORRECTS the month before approving it (a first-class
    // approver power): 8h transferred -> 5h kept. The month is still
    // 'Requested', so the edit keeps its pending approval and its back-link.
    const trim = await req('PUT', `/assignments/${trimFixture.personAssignmentId}/allocation`, {
      body: { month: MONTH, dailyHours: { [DAY]: 5 } },
    });
    check('C2 the substituted month can be trimmed before approval', trim.status === 200, `status=${trim.status} err=${trim.body?.error}`);

    const dec = await req('POST', '/allocation-approvals/decide', {
      headers: GIVE_BACK_DECIDER,
      body: { items: [{ assignmentMonthId: trimFixture.substitutedMonthId, decision: 'Approved', note: '5h is all she can take' }] },
    });
    check('C2 trimmed approval decided', (dec.body?.results || [])[0]?.status === 'Approved', `res=${JSON.stringify(dec.body?.results)}`);

    const personKept = await req('GET', `/assignments/${trimFixture.personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    check('C2 the person keeps exactly the approved remainder',
      (personKept.body.days || []).find(d => d.date === DAY)?.hours === 5,
      `hours=${(personKept.body.days || []).find(d => d.date === DAY)?.hours}`);
    const trimMonth = (personKept.body.months || [])[0];
    check('C2 the trimmed month is Allocated', trimMonth?.status === 'Allocated', `status=${trimMonth?.status}`);
    check('C2 an approved substitution also clears the back-link and the recorded hours',
      trimMonth !== undefined && !('replacedFromAssignmentMonthId' in trimMonth) && !('replacedDays' in trimMonth),
      `month=${JSON.stringify(trimMonth)}`);

    // 16h were booked, 8 moved, the approver cut 3 of them: 8 never left the
    // dummy + 3 came back = 11, and 5 + 11 == the original 16 (no hour is
    // created or destroyed by the give-back).
    const dummyBack = await req('GET', `/assignments/${trimFixture.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    check('C2 an approval gives back exactly the trimmed difference, no more',
      (dummyBack.body.days || []).find(d => d.date === DAY)?.hours === 11,
      `hours=${(dummyBack.body.days || []).find(d => d.date === DAY)?.hours}`);
  }

  // --- MIXED OWN + TRANSFERRED HOURS ON THE SAME MONTH, THEN REJECTED. The
  // regression guard for the give-back's hardest shape, and the one every
  // single-day fixture above is blind to: the dummy is booked on TWO days and the
  // person ALREADY holds a full day of her own work on the first, so the transfer
  // can only move the second. The rejection must return that second day and leave
  // the first — on BOTH resources — exactly as it was. Distributing the returned
  // hours by what she merely *holds* would strip her own work and credit it to a
  // dummy day that never gave up an hour.
  const mixDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 mixed-days dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const mixPerson = await req('POST', '/resources', { body: { ...base, name: 'C2 mixed-days person', kind: 'internal', contractHoursPerDay: 8 } });
  const mixSetupOk = check('C2 mixed-days setup: dummy/person resources created',
    mixDummy.status === 201 && mixPerson.status === 201, `dummy=${mixDummy.status} person=${mixPerson.status}`);
  if (mixSetupOk) {
    const mixRequest = await req('POST', '/requests', { body: { name: 'C2 mixed-days request', requiredRole: 'Developer', requiredEffort: 2, skills: [] } });
    const mixDummyAssig = await req('POST', '/assignments', { body: { requestId: mixRequest.body?.id, resourceId: mixDummy.body.id } });
    const mixPersonAssig = await req('POST', '/assignments', { body: { requestId: mixRequest.body?.id, resourceId: mixPerson.body.id } });
    const mixFixtureOk = check('C2 mixed-days setup: request and both assignments created',
      mixRequest.status === 200 && mixDummyAssig.status === 200 && mixPersonAssig.status === 200,
      `request=${mixRequest.status} dummy=${mixDummyAssig.status} person=${mixPersonAssig.status}`);
    if (mixFixtureOk) {
      // The dummy carries one FTE on each of two days; the person is already full
      // on the FIRST of them with work of her own.
      const mixDummyBooked = await req('PUT', `/assignments/${mixDummyAssig.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 8, [DAY2]: 8 } } });
      const mixOwnBooked = await req('PUT', `/assignments/${mixPersonAssig.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 8 } } });
      const mixBookedOk = check('C2 mixed-days setup: dummy on two days, person already full on the first',
        mixDummyBooked.status === 200 && mixOwnBooked.status === 200,
        `dummy=${mixDummyBooked.status} own=${mixOwnBooked.status} err=${mixDummyBooked.body?.error || mixOwnBooked.body?.error}`);
      if (mixBookedOk) {
        const mixSub = await req('POST', `/assignment-months/${mixDummyAssig.body.id}:${MONTH}/substitute`, {
          body: { targetResourceId: mixPerson.body.id },
        });
        const mixOutcome = (mixSub.body?.outcomes || [])[0];
        check('C2 mixed-days: only the day she has room on transfers',
          mixSub.status === 200 && mixOutcome?.transferredHours === 8 && mixOutcome?.remainingHours === 8,
          `status=${mixSub.status} outcome=${JSON.stringify(mixOutcome)}`);

        const mixDec = await req('POST', '/allocation-approvals/decide', {
          headers: GIVE_BACK_DECIDER,
          body: { items: [{ assignmentMonthId: mixOutcome?.targetAssignmentMonthId, decision: 'Rejected', note: 'no' }] },
        });
        check('C2 mixed-days rejection decided', (mixDec.body?.results || [])[0]?.status === 'Rejected', `res=${JSON.stringify(mixDec.body?.results)}`);

        const mixDummyAfter = await req('GET', `/assignments/${mixDummyAssig.body.id}/allocation?from=${MONTH}&to=${MONTH}`);
        const mixDummyDays = mixDummyAfter.body?.days || [];
        check('C2 mixed-days: the dummy day the substitution never touched is left alone',
          mixDummyDays.find(d => d.date === DAY)?.hours === 8, `hours=${mixDummyDays.find(d => d.date === DAY)?.hours}`);
        check('C2 mixed-days: the transferred day comes back whole to the dummy',
          mixDummyDays.find(d => d.date === DAY2)?.hours === 8, `hours=${mixDummyDays.find(d => d.date === DAY2)?.hours}`);

        const mixPersonAfter = await req('GET', `/assignments/${mixPersonAssig.body.id}/allocation?from=${MONTH}&to=${MONTH}`);
        const mixPersonDays = mixPersonAfter.body?.days || [];
        check('C2 mixed-days: her OWN work on the untouched day survives the rejection',
          mixPersonDays.find(d => d.date === DAY)?.hours === 8, `hours=${mixPersonDays.find(d => d.date === DAY)?.hours}`);
        check('C2 mixed-days: she keeps nothing of the rejected transfer',
          mixPersonDays.every(d => d.date !== DAY2), `days=${JSON.stringify(mixPersonDays)}`);
      }
    }
  }

  // --- ZERO-THEN-APPROVE. Zeroing the allocation and approving it is how the
  // source tool expresses a refusal, so the transferred hours must go back to the
  // days they came from — not vanish because the person's month no longer records
  // where they landed.
  const zeroFixture = await giveBackFixture('give-back zeroed approval');
  if (zeroFixture) {
    const zeroed = await req('PUT', `/assignments/${zeroFixture.personAssignmentId}/allocation`, {
      body: { month: MONTH, dailyHours: { [DAY]: 0 } },
    });
    check('C2 the substituted month can be zeroed before approval', zeroed.status === 200, `status=${zeroed.status} err=${zeroed.body?.error}`);

    const zeroDec = await req('POST', '/allocation-approvals/decide', {
      headers: GIVE_BACK_DECIDER,
      body: { items: [{ assignmentMonthId: zeroFixture.substitutedMonthId, decision: 'Approved', note: 'nothing left to approve' }] },
    });
    check('C2 zeroed approval decided', (zeroDec.body?.results || [])[0]?.status === 'Approved', `res=${JSON.stringify(zeroDec.body?.results)}`);

    const zeroDummy = await req('GET', `/assignments/${zeroFixture.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    check('C2 zeroing the month and approving returns the whole transfer, no hour vanishes',
      (zeroDummy.body.days || []).find(d => d.date === DAY)?.hours === 16,
      `hours=${(zeroDummy.body.days || []).find(d => d.date === DAY)?.hours}`);
    const zeroPerson = await req('GET', `/assignments/${zeroFixture.personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    check('C2 the zeroed month stays empty and carries no back-link',
      (zeroPerson.body.days || []).length === 0 && !('replacedDays' in ((zeroPerson.body.months || [])[0] ?? {})),
      `days=${JSON.stringify(zeroPerson.body.days)} month=${JSON.stringify((zeroPerson.body.months || [])[0])}`);
  }

  // --- THE TWO WAYS A SUBSTITUTION CAN END WITHOUT A DECISION -----------------
  //
  // Both of these end the substitution through a handler that predates C2, so
  // neither goes anywhere near the decision hook. Booked demand left the dummy;
  // if these paths do not hand it back, it is destroyed with no record anywhere.
  //
  // (1) SELF-MANAGED RETARGET. `PUT /assignments/:id` changing resourceId
  //     re-baselines every live month row. On the self-managed branch that lands
  //     'Allocated' with NO approval — an IMPLICIT approval, since no decision
  //     will ever follow — so it must give back exactly what an explicit approval
  //     would: whatever the person no longer covers.
  //
  //     The fixture TRIMS before retargeting on purpose. Without a trim the
  //     give-back owes nothing, and a wrong fix that merely cleared the two
  //     columns would look identical to the right one. With a trim, only a real
  //     give-back puts the 3h back on the dummy.
  const retargetFixture = await giveBackFixture('retarget self-managed');
  if (retargetFixture) {
    // A third internal resource whose manager IS the acting principal: the suite
    // calls as X-User-Id '1', which `actorResourceId` maps to resource '1', so
    // `autoApprovesAllocation` is true for this resource and the retarget takes
    // the self-managed branch.
    const standIn = await req('POST', '/resources', {
      body: { ...base, name: 'C2 retarget stand-in (self-managed)', kind: 'internal', contractHoursPerDay: 8, managerId: '1' },
    });
    const standInOk = check('C2 retarget setup: a self-managed stand-in resource exists',
      standIn.status === 201 && typeof standIn.body?.id === 'string', `status=${standIn.status}`);

    if (standInOk) {
      // 8h transferred -> trimmed to 5h. The month is still 'Requested', so the
      // edit keeps both its pending approval and its back-link.
      const trim = await req('PUT', `/assignments/${retargetFixture.personAssignmentId}/allocation`, {
        body: { month: MONTH, dailyHours: { [DAY]: 5 } },
      });
      check('C2 retarget setup: the substituted month is trimmed 8h -> 5h before the retarget',
        trim.status === 200, `status=${trim.status} err=${trim.body?.error}`);

      const retarget = await req('PUT', `/assignments/${retargetFixture.personAssignmentId}`, {
        body: { resourceId: standIn.body.id },
      });
      check('C2 a substituted assignment can be retargeted', retarget.status === 200,
        `status=${retarget.status} err=${retarget.body?.error}`);

      const retMonth = (await req('GET', `/assignments/${retargetFixture.personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`)).body;
      const retRow = (retMonth.months || [])[0];
      check('C2 a self-managed retarget lands the substituted month Allocated with no approval',
        retRow?.status === 'Allocated' && !('approvalId' in (retRow ?? {})),
        `month=${JSON.stringify(retRow)}`);
      // The regression this exists for: an implicit approval that leaves the link
      // in place is a substitution nothing will ever close.
      check('C2 a self-managed retarget leaves NO dangling substitution back-link',
        retRow !== undefined && !('replacedFromAssignmentMonthId' in retRow) && !('replacedDays' in retRow),
        `month=${JSON.stringify(retRow)}`);
      check('C2 the retargeted stand-in keeps exactly the trimmed allocation',
        (retMonth.days || []).find(d => d.date === DAY)?.hours === 5,
        `hours=${(retMonth.days || []).find(d => d.date === DAY)?.hours}`);

      // 8h remained on the dummy + the 3h the stand-in no longer covers = 11h.
      const retDummy = await req('GET', `/assignments/${retargetFixture.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
      check('C2 a self-managed retarget hands back exactly what the person no longer covers',
        (retDummy.body.days || []).find(d => d.date === DAY)?.hours === 11,
        `hours=${(retDummy.body.days || []).find(d => d.date === DAY)?.hours}`);

      // IDEMPOTENCE, the sequential half. The give-back above closed the link, so
      // ending the SAME month a second way must credit the dummy nothing further
      // — 11h stays 11h, it does not become 14h. This is the reachable, ordered
      // version of the concurrent double-give-back the in-lock re-read in
      // `returnHoursToDummy`/`moveBack` guards; that interleaving itself cannot be
      // forced through HTTP without a timing hack, so it is deliberately not
      // simulated here.
      const secondStandIn = await req('POST', '/resources', {
        body: { ...base, name: 'C2 retarget second stand-in (self-managed)', kind: 'internal', contractHoursPerDay: 8, managerId: '1' },
      });
      if (check('C2 retarget setup: a second self-managed stand-in exists',
        secondStandIn.status === 201 && typeof secondStandIn.body?.id === 'string', `status=${secondStandIn.status}`)) {
        const reRetarget = await req('PUT', `/assignments/${retargetFixture.personAssignmentId}`, {
          body: { resourceId: secondStandIn.body.id },
        });
        check('C2 an already-given-back month can be retargeted again', reRetarget.status === 200,
          `status=${reRetarget.status} err=${reRetarget.body?.error}`);
        const twiceDummy = await req('GET', `/assignments/${retargetFixture.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
        check('C2 a second retarget does NOT credit the dummy the same hours again',
          (twiceDummy.body.days || []).find(d => d.date === DAY)?.hours === 11,
          `hours=${(twiceDummy.body.days || []).find(d => d.date === DAY)?.hours}`);
      }
    }
  }

  // (2) DELETING THE TARGET'S ASSIGNMENT. The assignment disappears, so the
  //     person covers nothing — a rejection in every respect that matters, so
  //     EVERY recorded hour goes home. The inverse case (deleting the DUMMY's
  //     assignment) was already handled: the give-back finds the linked row gone
  //     and logs a no-op, which is exactly why the back-link is not an FK.
  const deleteFixture = await giveBackFixture('delete target');
  if (deleteFixture) {
    const del = await req('DELETE', `/assignments/${deleteFixture.personAssignmentId}`);
    check('C2 the substituted assignment can be deleted', del.status === 204, `status=${del.status}`);
    // Proves the delete PROCEEDED rather than being refused — a 409 "pending
    // substitution" would also leave the dummy whole, for the wrong reason.
    const gone = await req('GET', `/assignments/${deleteFixture.personAssignmentId}/allocation`);
    check('C2 the deleted assignment really is gone', gone.status === 404, `status=${gone.status}`);

    const delDummy = await req('GET', `/assignments/${deleteFixture.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    check('C2 deleting the target assignment returns every transferred hour to the dummy',
      (delDummy.body.days || []).find(d => d.date === DAY)?.hours === 16,
      `hours=${(delDummy.body.days || []).find(d => d.date === DAY)?.hours}`);
    const delDummyAssig = await req('GET', '/assignments');
    const restored = (delDummyAssig.body || []).find(a => a.id === deleteFixture.dummyAssignmentId);
    check('C2 the dummy assignment-s assignedHours is restored by the delete give-back',
      restored?.assignedHours === 16, `assignedHours=${restored?.assignedHours}`);
  }

  // --- HER OWN HOURS AND THE LOAN ON THE **SAME DAY** ------------------------
  //
  // The shape every fixture above is blind to. `mixed-days` puts her own work on
  // a DIFFERENT day from the transfer, so the give-back's per-day arithmetic
  // never has to separate "her own" from "on loan" WITHIN one date. Here it does:
  // she already holds 3h of her own on DAY **on the same assignment**, the dummy
  // lends 5 more (her day reaches her 8h cap), and the approver then trims that
  // one day. What the day HOLDS is no longer decomposable after the fact, which
  // is why the transfer records the pre-transfer baseline alongside the map.
  //
  // Conservation is the invariant under test on both branches: her own 3h plus
  // the dummy's original 5h must still total 8h afterwards — no hour created, no
  // hour destroyed.
  async function sameDayFixture(label, ownHours, dummyHours) {
    const sdDummy = await req('POST', '/resources', { body: { ...base, name: `C2 ${label} dummy`, kind: 'dummy', contractHoursPerDay: 8 } });
    const sdPerson = await req('POST', '/resources', { body: { ...base, name: `C2 ${label} person`, kind: 'internal', contractHoursPerDay: 8 } });
    if (!check(`C2 ${label} setup: dummy/person resources created`,
      sdDummy.status === 201 && sdPerson.status === 201,
      `dummy=${sdDummy.status} person=${sdPerson.status}`)) return undefined;

    const sdRequest = await req('POST', '/requests', { body: { name: `C2 ${label} request`, requiredRole: 'Developer', requiredEffort: 2, skills: [] } });
    // BOTH assignments on the SAME request: that is what makes the transfer land
    // on the assignment she already has hours on, rather than on a new one.
    const sdDummyAssig = await req('POST', '/assignments', { body: { requestId: sdRequest.body?.id, resourceId: sdDummy.body.id } });
    const sdPersonAssig = await req('POST', '/assignments', { body: { requestId: sdRequest.body?.id, resourceId: sdPerson.body.id } });
    if (!check(`C2 ${label} setup: request and both assignments created`,
      sdRequest.status === 200 && sdDummyAssig.status === 200 && sdPersonAssig.status === 200,
      `request=${sdRequest.status} dummy=${sdDummyAssig.status} person=${sdPersonAssig.status}`)) return undefined;

    const sdDummyBooked = await req('PUT', `/assignments/${sdDummyAssig.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: dummyHours } } });
    const sdOwnBooked = await req('PUT', `/assignments/${sdPersonAssig.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: ownHours } } });
    if (!check(`C2 ${label} setup: dummy holds ${dummyHours}h and she holds ${ownHours}h of her own on the SAME day`,
      sdDummyBooked.status === 200 && sdOwnBooked.status === 200,
      `dummy=${sdDummyBooked.status} own=${sdOwnBooked.status} err=${sdDummyBooked.body?.error || sdOwnBooked.body?.error}`)) return undefined;

    const sdSub = await req('POST', `/assignment-months/${sdDummyAssig.body.id}:${MONTH}/substitute`, {
      body: { targetResourceId: sdPerson.body.id },
    });
    const sdOutcome = (sdSub.body?.outcomes || [])[0];
    if (!check(`C2 ${label} setup: the loan lands on the day she already owns`,
      sdSub.status === 200 && sdOutcome?.transferredHours === dummyHours &&
      typeof sdOutcome?.targetAssignmentMonthId === 'string',
      `status=${sdSub.status} outcome=${JSON.stringify(sdOutcome)}`)) return undefined;

    const sdAfter = await req('GET', `/assignments/${sdPersonAssig.body.id}/allocation?from=${MONTH}&to=${MONTH}`);
    check(`C2 ${label} setup: her day now carries her own hours PLUS the loan`,
      (sdAfter.body?.days || []).find(d => d.date === DAY)?.hours === ownHours + dummyHours,
      `hours=${(sdAfter.body?.days || []).find(d => d.date === DAY)?.hours}`);

    return {
      dummyAssignmentId: sdDummyAssig.body.id,
      personAssignmentId: sdPersonAssig.body.id,
      substitutedMonthId: sdOutcome.targetAssignmentMonthId,
    };
  }

  // (a) APPROVAL, trimmed back to exactly her own baseline. Removing the loan and
  //     nothing else must return the WHOLE loan. Charging all 8 held hours
  //     against the 5 on loan returns only 2 and destroys 3h of booked demand.
  const sameDayApprove = await sameDayFixture('same-day trimmed approval', 3, 5);
  if (sameDayApprove) {
    const trim = await req('PUT', `/assignments/${sameDayApprove.personAssignmentId}/allocation`, {
      body: { month: MONTH, dailyHours: { [DAY]: 3 } },
    });
    check('C2 same-day: the approver can trim the loan back off the shared day', trim.status === 200,
      `status=${trim.status} err=${trim.body?.error}`);

    const dec = await req('POST', '/allocation-approvals/decide', {
      headers: GIVE_BACK_DECIDER,
      body: { items: [{ assignmentMonthId: sameDayApprove.substitutedMonthId, decision: 'Approved', note: 'she keeps only her own work' }] },
    });
    check('C2 same-day trimmed approval decided', (dec.body?.results || [])[0]?.status === 'Approved',
      `res=${JSON.stringify(dec.body?.results)}`);

    const sdDummyAfter = await req('GET', `/assignments/${sameDayApprove.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    const sdPersonAfter = await req('GET', `/assignments/${sameDayApprove.personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    const backOnDummy = (sdDummyAfter.body?.days || []).find(d => d.date === DAY)?.hours ?? 0;
    const leftOnPerson = (sdPersonAfter.body?.days || []).find(d => d.date === DAY)?.hours ?? 0;
    check('C2 same-day approval: trimming the loan off a shared day returns the WHOLE loan',
      backOnDummy === 5, `dummy=${backOnDummy}`);
    check('C2 same-day approval: she keeps exactly her own baseline',
      leftOnPerson === 3, `person=${leftOnPerson}`);
    check('C2 same-day approval: no hour is created or destroyed (3 own + 5 lent == 8)',
      backOnDummy + leftOnPerson === 8, `dummy=${backOnDummy} person=${leftOnPerson}`);
  }

  // (b) REJECTION after a trim. The dummy is made whole with the FULL map
  //     (spec §5.6), but her side may only lose what is still ON LOAN — her own
  //     baseline can never be deleted with it.
  const sameDayReject = await sameDayFixture('same-day trimmed rejection', 3, 5);
  if (sameDayReject) {
    const trim = await req('PUT', `/assignments/${sameDayReject.personAssignmentId}/allocation`, {
      body: { month: MONTH, dailyHours: { [DAY]: 5 } },
    });
    check('C2 same-day rejection setup: the shared day is trimmed 8h -> 5h before the decision',
      trim.status === 200, `status=${trim.status} err=${trim.body?.error}`);

    const dec = await req('POST', '/allocation-approvals/decide', {
      headers: GIVE_BACK_DECIDER,
      body: { items: [{ assignmentMonthId: sameDayReject.substitutedMonthId, decision: 'Rejected', note: 'no' }] },
    });
    check('C2 same-day trimmed rejection decided', (dec.body?.results || [])[0]?.status === 'Rejected',
      `res=${JSON.stringify(dec.body?.results)}`);

    const sdDummyAfter = await req('GET', `/assignments/${sameDayReject.dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    const sdPersonAfter = await req('GET', `/assignments/${sameDayReject.personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
    const backOnDummy = (sdDummyAfter.body?.days || []).find(d => d.date === DAY)?.hours ?? 0;
    const leftOnPerson = (sdPersonAfter.body?.days || []).find(d => d.date === DAY)?.hours ?? 0;
    check('C2 same-day rejection: the dummy is made whole with the full recorded map',
      backOnDummy === 5, `dummy=${backOnDummy}`);
    check('C2 same-day rejection: her OWN hours on the shared day are NOT deleted with the loan',
      leftOnPerson === 3, `person=${leftOnPerson}`);
    check('C2 same-day rejection: no hour is created or destroyed (3 own + 5 lent == 8)',
      backOnDummy + leftOnPerson === 8, `dummy=${backOnDummy} person=${leftOnPerson}`);
  }

  // --- THE CREATED ASSIGNMENT MUST NOT READ AS A FULL-TIME BOOKING -----------
  //
  // The substitution is the only writer that creates an assignment; every other
  // path sends an explicit allocationPct. `schedule.util` defaults a missing
  // allocationPct to 100 and falls back to the REQUEST's window, so a
  // few-hours-in-one-month transfer used to appear as a 100% booking spanning the
  // whole request — flagging conflicts for months on end. The created assignment
  // therefore carries the substituted month as its own window and a pct derived
  // from the hours actually transferred, on the same monthly basis the capacity
  // rollup uses.
  const winDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 window dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const winPerson = await req('POST', '/resources', { body: { ...base, name: 'C2 window person', kind: 'internal', contractHoursPerDay: 8 } });
  const winSetupOk = check('C2 window setup: dummy/person resources created',
    winDummy.status === 201 && winPerson.status === 201, `dummy=${winDummy.status} person=${winPerson.status}`);
  if (winSetupOk) {
    // A request spanning SIX months — the window the old default fell back to.
    const winRequest = await req('POST', '/requests', {
      body: { name: 'C2 window request', requiredRole: 'Developer', requiredEffort: 1, skills: [], startDate: '2026-04-01', endDate: '2026-09-30' },
    });
    const winAssig = await req('POST', '/assignments', { body: { requestId: winRequest.body?.id, resourceId: winDummy.body.id } });
    const winSetup2Ok = check('C2 window setup: six-month request and dummy assignment created',
      winRequest.status === 200 && winAssig.status === 200, `request=${winRequest.status} assignment=${winAssig.status}`);
    if (winSetup2Ok) {
      const winBooked = await req('PUT', `/assignments/${winAssig.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 8 } } });
      check('C2 window setup: one working day booked on the dummy', winBooked.status === 200, `status=${winBooked.status} err=${winBooked.body?.error}`);

      const winSub = await req('POST', `/assignment-months/${winAssig.body.id}:${MONTH}/substitute`, {
        body: { targetResourceId: winPerson.body.id },
      });
      const winOutcome = (winSub.body?.outcomes || [])[0];
      const winCreatedId = winOutcome?.targetAssignmentMonthId?.split(':')[0];
      check('C2 window: the substitution transferred the day and created her assignment',
        winSub.status === 200 && winOutcome?.transferredHours === 8 && typeof winCreatedId === 'string',
        `status=${winSub.status} outcome=${JSON.stringify(winOutcome)}`);

      const winAssignments = await req('GET', '/assignments');
      const winCreated = (winAssignments.body || []).find(a => a.id === winCreatedId);
      check('C2 window: the created assignment is bounded by the SUBSTITUTED MONTH, not the request',
        winCreated?.startDate === `${MONTH}-01` && winCreated?.endDate === `${MONTH}-30`,
        `start=${winCreated?.startDate} end=${winCreated?.endDate}`);

      // The expected pct comes from the capacity rollup's own monthly target for
      // her — the same basis, read back from the server rather than hardcoded.
      const winCap = await req('GET', `/capacity/monthly?from=${MONTH}&to=${MONTH}`);
      const winTarget = (winCap.body?.rows || []).find(r => r.resourceId === winPerson.body.id)?.monthly?.[MONTH]?.targetHours;
      const winExpected = typeof winTarget === 'number' && winTarget > 0 ? Math.round((8 / winTarget) * 10000) / 100 : undefined;
      check('C2 window: allocationPct reflects the transferred hours, not a silent 100%',
        winCreated?.allocationPct === winExpected && winCreated?.allocationPct < 100,
        `pct=${winCreated?.allocationPct} expected=${winExpected} monthTarget=${winTarget}`);
    }
  }

  // --- RESTORED HOURS MUST STILL COUNT ON THE CAPACITY DASHBOARD -------------
  //
  // The give-back re-creates day rows on the dummy's month row without looking at
  // its status. `capacity.util` classifies by that status: 'Rejected' is in
  // neither the planned nor the confirmed band, so demand restored onto a rejected
  // placeholder month exists in storage and on the calendar but contributes ZERO
  // to /capacity/monthly and to the B2 semaphore — the gap the feature exists to
  // make visible becomes invisible. Sequence: the placeholder's own month is
  // submitted and then REJECTED while the substitution is pending (the approver
  // sees a placeholder now down to 8h), and only afterwards is her month rejected.
  const bandDummy = await req('POST', '/resources', { body: { ...base, name: 'C2 band dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  const bandPerson = await req('POST', '/resources', { body: { ...base, name: 'C2 band person', kind: 'internal', contractHoursPerDay: 8 } });
  const bandSetupOk = check('C2 band setup: dummy/person resources created',
    bandDummy.status === 201 && bandPerson.status === 201, `dummy=${bandDummy.status} person=${bandPerson.status}`);
  if (bandSetupOk) {
    const bandRequest = await req('POST', '/requests', { body: { name: 'C2 band request', requiredRole: 'Developer', requiredEffort: 2, skills: [] } });
    const bandAssig = await req('POST', '/assignments', { body: { requestId: bandRequest.body?.id, resourceId: bandDummy.body.id } });
    const bandSetup2Ok = check('C2 band setup: request and dummy assignment created',
      bandRequest.status === 200 && bandAssig.status === 200, `request=${bandRequest.status} assignment=${bandAssig.status}`);
    if (bandSetup2Ok) {
      const bandDummyMonthId = `${bandAssig.body.id}:${MONTH}`;
      const bandBooked = await req('PUT', `/assignments/${bandAssig.body.id}/allocation`, { body: { month: MONTH, dailyHours: { [DAY]: 16 } } });
      const bandSubmitted = await req('POST', `/assignments/${bandAssig.body.id}/months/${MONTH}/submit`, { body: {} });
      const bandBookedOk = check('C2 band setup: the placeholder month is booked at 2 FTE and submitted for approval',
        bandBooked.status === 200 && bandSubmitted.status === 200 && bandSubmitted.body?.status === 'Requested',
        `booked=${bandBooked.status} submitted=${bandSubmitted.status}/${bandSubmitted.body?.status}`);
      if (bandBookedOk) {
        const bandSub = await req('POST', `/assignment-months/${bandDummyMonthId}/substitute`, {
          body: { targetResourceId: bandPerson.body.id },
        });
        const bandOutcome = (bandSub.body?.outcomes || [])[0];
        check('C2 band setup: one FTE moved to the person',
          bandSub.status === 200 && bandOutcome?.transferredHours === 8 && typeof bandOutcome?.targetAssignmentMonthId === 'string',
          `status=${bandSub.status} outcome=${JSON.stringify(bandOutcome)}`);

        // The approver rejects the DRAINED placeholder month first.
        const bandRejectDummy = await req('POST', '/allocation-approvals/decide', {
          headers: GIVE_BACK_DECIDER,
          body: { items: [{ assignmentMonthId: bandDummyMonthId, decision: 'Rejected', note: '8h left is not worth a placeholder' }] },
        });
        check('C2 band setup: the drained placeholder month is rejected',
          (bandRejectDummy.body?.results || [])[0]?.status === 'Rejected', `res=${JSON.stringify(bandRejectDummy.body?.results)}`);

        // ...and only then is her month rejected, sending the 8h back.
        const bandRejectPerson = await req('POST', '/allocation-approvals/decide', {
          headers: GIVE_BACK_DECIDER,
          body: { items: [{ assignmentMonthId: bandOutcome?.targetAssignmentMonthId, decision: 'Rejected', note: 'not available' }] },
        });
        check('C2 band setup: her substituted month is rejected, sending the hours home',
          (bandRejectPerson.body?.results || [])[0]?.status === 'Rejected', `res=${JSON.stringify(bandRejectPerson.body?.results)}`);

        const bandDummyAfter = await req('GET', `/assignments/${bandAssig.body.id}/allocation?from=${MONTH}&to=${MONTH}`);
        const bandDummyDay = (bandDummyAfter.body?.days || []).find(d => d.date === DAY)?.hours ?? 0;
        const bandDummyRow = (bandDummyAfter.body?.months || [])[0];
        check('C2 band: the restored hours are back on the placeholder-s day rows',
          bandDummyDay === 16, `hours=${bandDummyDay}`);
        check('C2 band: the re-opened placeholder month is back in a counted status, with an approval to decide',
          bandDummyRow?.status === 'Requested' && typeof bandDummyRow?.approvalId === 'string',
          `month=${JSON.stringify(bandDummyRow)}`);

        // THE POINT: read the capacity surface, not the day rows.
        const bandCap = await req('GET', `/capacity/monthly?from=${MONTH}&to=${MONTH}`);
        const bandRow = (bandCap.body?.demandRows || []).find(r => r.resourceId === bandDummy.body.id);
        check('C2 band: the restored placeholder demand is visible on /capacity/monthly',
          bandRow?.monthly?.[MONTH]?.plannedHours === 16,
          `planned=${bandRow?.monthly?.[MONTH]?.plannedHours} cell=${JSON.stringify(bandRow?.monthly?.[MONTH])}`);
        check('C2 band: the restored demand counts as UNCOVERED demand in the totals',
          (bandCap.body?.totals?.[MONTH]?.demandFteUncovered ?? 0) > 0,
          `uncovered=${bandCap.body?.totals?.[MONTH]?.demandFteUncovered}`);
      }
    }
  }
}

/**
 * D (Task 3) — org-tree integrity on the bespoke `/resource-organizations`
 * handlers (src/server.ts, NOT mounted with `crud()`): levels, parent/child
 * pairing, whole-tree name uniqueness (self excluded on PUT), the
 * capability-is-a-root rule on write, and the two protected-delete guards
 * (children / resources still referencing the node by name) — each isolated
 * on its OWN fixture so neither can mask the other. Plus, alongside the nine
 * checks from the task-3 brief, the same clear-to-absent seam proven for
 * `parentId` is proven again for `managerId` (review round 1 — see below).
 *
 * SEED FIXTURES relied on (src/db/seed.ts resourceOrganizations) — none of
 * these are mutated by earlier smoke sections:
 *   id '2' — 'Engineering' (capability), no parent. Seeded resources carry
 *     organization: 'Engineering' (resources bind to a node BY NAME, spec §2.4).
 *   id '5' — 'Platform' (practice), parentId '2'.
 *   id '6' — 'Backend' (competence), parentId '5' — Engineering's grandchild,
 *     used by check 7 (has-children delete guard) and check 6 (capability
 *     root rule — see the note at check 6 for why this is NOT a cycle-guard
 *     exercise, despite '6' being '2's own descendant).
 *
 * Check 7 DELETEs seeded node '5'. Check 8 (review round 1 — rewritten, see
 * below) no longer touches seeded nodes at all: it builds its OWN fresh,
 * childless leaf and a throwaway resource, specifically so the CHILDREN guard
 * cannot fire first and mask the RESOURCES guard, which check 8 exists to
 * prove. Against the pre-Task-3 build (delete was an unguarded one-liner)
 * check 7's DELETE actually SUCCEEDED (204) and removed '5' from the
 * in-memory store for the rest of THAT throwaway process's lifetime —
 * expected and harmless: the task's own instructions have the server
 * restarted between runs, and post-implementation the 409 guard means the
 * delete never goes through, so seed data survives a green run intact.
 *
 * REVIEW ROUND 1 (coordinator feedback on the first pass):
 *   1. Check 8 originally deleted seeded node '2' (Engineering), which 409s
 *      via the CHILDREN guard (it still has '5' beneath it) — the RESOURCES
 *      guard was never actually exercised. Rewritten as described above;
 *      confirmed by mutation (temporarily commenting out the resources-guard
 *      branch in the DELETE handler made this check fail — see the task-3
 *      report for the captured output) that this version really does depend
 *      on that guard.
 *   2. managerId gained the same clear-to-absent check parentId already had
 *      (see 9b below) — not academic: Task 7's manager `<select>` has no way
 *      to author a literal `null`, so its empty option relies on this exact
 *      translation to ever detach a Capability Leader from a node.
 *   3. Check 6 reworded (see the comment there) to state what it actually
 *      verifies — a capability cannot be given a parent — rather than
 *      implying cycle-guard coverage it never had. Per the coordinator's
 *      ruling, no smoke check was added for the cycle guard itself: with the
 *      level rules enforced, a cycle is structurally unreachable through this
 *      API (closing one would require a capability to sit beneath something,
 *      which the level guard refuses first), so there is no honest API-level
 *      fixture for it. `wouldCycleInOrgTree` is unit-tested directly in
 *      `org-scope.util.spec.ts`; the cycle guard's own defence-in-depth
 *      rationale is now documented at the guard itself (`src/server.ts`,
 *      `validateOrgTreeNode`).
 */
async function checkOrgTreeIntegrity() {
  const ENGINEERING_ID = '2';
  const PLATFORM_ID = '5';
  const BACKEND_ID = '6';

  // 1) POST carries level + parentId through (today: silently dropped by the
  // pick() allow-list — the row still gets created, just as a bare capability).
  const created = await req('POST', '/resource-organizations', {
    headers: RBAC_HEADERS,
    body: { name: 'D Smoke Practice', description: 'x', level: 'practice', parentId: ENGINEERING_ID },
  });
  check(
    "POST /api/resource-organizations {level:'practice', parentId:'2'} -> 200, response carries both through",
    created.status === 200 && created.body?.level === 'practice' && created.body?.parentId === ENGINEERING_ID,
    `status=${created.status}, body=${JSON.stringify(created.body)}`,
  );
  // Keep the id even if the assertion above failed (pre-implementation the
  // POST still succeeds, just with the wrong shape) so check 9 below can
  // still run its own — independently meaningful — assertion.
  const smokeNodeId = typeof created.body?.id === 'string' ? created.body.id : undefined;

  // 2) A practice with no parent -> 400.
  {
    const bad = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Bad', description: 'x', level: 'practice' },
    });
    check(
      'POST a practice with no parentId -> 400',
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 3) A competence whose parent is a capability (wrong level) -> 400.
  {
    const bad2 = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Bad2', description: 'x', level: 'competence', parentId: ENGINEERING_ID },
    });
    check(
      "POST a competence whose parent ('2', a capability) is the wrong level -> 400",
      bad2.status === 400,
      `status=${bad2.status}, body=${JSON.stringify(bad2.body)}`,
    );
  }

  // 4) A name already in the tree -> 400.
  {
    const dup = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'Engineering', description: 'x', level: 'capability' },
    });
    check(
      "POST with a name already in the tree ('Engineering') -> 400",
      dup.status === 400,
      `status=${dup.status}, body=${JSON.stringify(dup.body)}`,
    );
  }

  // 5) PUT its OWN unchanged name -> 200 (must not collide with itself). This
  // is a regression guard on the new uniqueness check's ctx.id exclusion —
  // note it can ALREADY pass today (no uniqueness check exists yet to break
  // it), which is fine: its job is to prove the eventual validator doesn't
  // regress a working rename-to-self, not to prove a currently-broken 400.
  {
    const self = await req('PUT', `/resource-organizations/${ENGINEERING_ID}`, {
      headers: RBAC_HEADERS,
      body: { name: 'Engineering' },
    });
    check(
      "PUT /api/resource-organizations/2 {name:'Engineering'} (unchanged) -> 200, not a self-collision",
      self.status === 200,
      `status=${self.status}, body=${JSON.stringify(self.body)}`,
    );
  }

  // 6) A capability cannot be given a parent -> 400. NOT a cycle-guard
  // exercise, despite '6' (Backend) being '2's (Engineering's) own descendant:
  // node '2' is still a capability in this PUT (no `level` sent), so
  // validateOrgTreeNode's capability-is-a-root guard rejects it before the
  // cycle check ever runs — see the comment at that cycle guard (src/server.ts)
  // for why a cycle is structurally unreachable through this API at all. This
  // check only proves the root rule fires on an UPDATE, not merely on create.
  {
    const cyc = await req('PUT', `/resource-organizations/${ENGINEERING_ID}`, {
      headers: RBAC_HEADERS,
      body: { parentId: BACKEND_ID },
    });
    check(
      "PUT /api/resource-organizations/2 {parentId:'6'} -> 400 (a capability cannot be given a parent)",
      cyc.status === 400,
      `status=${cyc.status}, body=${JSON.stringify(cyc.body)}`,
    );
  }

  // 7) DELETE a node that still has a child -> 409.
  {
    const del1 = await req('DELETE', `/resource-organizations/${PLATFORM_ID}`, { headers: RBAC_HEADERS });
    check(
      "DELETE /api/resource-organizations/5 (Platform) while '6' (Backend) still names it as parent -> 409",
      del1.status === 409,
      `status=${del1.status}, body=${JSON.stringify(del1.body)}`,
    );
  }

  // 8) DELETE a CHILDLESS node that a resource still references by name -> 409
  // — the RESOURCES guard specifically. Deleting '2' (Engineering) would also
  // 409, but only via the CHILDREN guard (it still has '5'/Platform beneath
  // it) — that would leave the resources-guard branch completely untested.
  // Built on a FRESH leaf with zero children instead, so the children guard
  // structurally cannot fire first, and the resources guard is the only one
  // that can produce the 409 below.
  {
    const leaf = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Leaf (resource-guard)', description: 'x', level: 'capability' },
    });
    const leafOk = check(
      'check 8 setup: a fresh, childless leaf node is created',
      leaf.status === 200 && typeof leaf.body?.id === 'string',
      `status=${leaf.status}, body=${JSON.stringify(leaf.body)}`,
    );
    if (leafOk) {
      const leafId = leaf.body.id;
      const leafName = leaf.body.name;

      // No DELETE /resources endpoint exists (checked: src/server.ts has no
      // `apiRouter.delete('/resources...')`), so this throwaway resource is
      // never removed — same convention already used by the C2 dummy-
      // substitution fixtures above, which also never delete the resources
      // they create.
      const resource = await req('POST', '/resources', {
        headers: RBAC_HEADERS,
        body: { name: 'D Smoke Resource (resource-guard)', role: 'Developer', kind: 'internal', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8 },
      });
      const resourceOk = check(
        'check 8 setup: a throwaway resource is created',
        resource.status === 201 && typeof resource.body?.id === 'string',
        `status=${resource.status}, body=${JSON.stringify(resource.body)}`,
      );
      if (resourceOk) {
        const resourceId = resource.body.id;
        const attach = await req('PUT', `/resources/${resourceId}`, {
          headers: RBAC_HEADERS,
          body: { organization: leafName },
        });
        const attachOk = check(
          `check 8 setup: PUT /api/resources/${resourceId} {organization:'${leafName}'} -> 200 (resources bind by NAME, spec §2.4)`,
          attach.status === 200 && attach.body?.organization === leafName,
          `status=${attach.status}, body=${JSON.stringify(attach.body)}`,
        );
        if (attachOk) {
          const del2 = await req('DELETE', `/resource-organizations/${leafId}`, { headers: RBAC_HEADERS });
          check(
            `DELETE /api/resource-organizations/${leafId} (childless leaf) while a resource carries organization:'${leafName}' -> 409, the RESOURCES guard specifically`,
            del2.status === 409 && del2.body?.error === 'Cannot delete an organization that resources still reference',
            `status=${del2.status}, body=${JSON.stringify(del2.body)}`,
          );
        }

        // Cleanup: detach the resource (organization: '') so the leaf becomes
        // deletable again, then remove the leaf itself — leaving only the
        // permanent, un-deletable throwaway resource behind (see the note above).
        const detach = await req('PUT', `/resources/${resourceId}`, {
          headers: RBAC_HEADERS,
          body: { organization: '' },
        });
        check(`check 8 cleanup: PUT /api/resources/${resourceId} {organization:''} -> 200, detaches`, detach.status === 200, `status=${detach.status}`);
        const cleanup = await req('DELETE', `/resource-organizations/${leafId}`, { headers: RBAC_HEADERS });
        check(`check 8 cleanup: DELETE /api/resource-organizations/${leafId} (now unreferenced, childless) -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
      }
    }
  }

  // 9) THE DUAL-ADAPTER CLEAR-TO-ABSENT SEAM — PUT {level:'capability',
  // parentId:''} on the node from check 1 must land as a root (parentId
  // ABSENT from the response, not a stored literal ''), identically on both
  // adapters. The assertion below folds in the precondition that the node
  // really did carry parentId '2' beforehand (from check 1) — so pre-
  // implementation this fails for the REAL reason (parentId was never
  // attached by POST in the first place), not by accident.
  if (smokeNodeId !== undefined) {
    const cleared = await req('PUT', `/resource-organizations/${smokeNodeId}`, {
      headers: RBAC_HEADERS,
      body: { level: 'capability', parentId: '' },
    });
    check(
      `PUT /api/resource-organizations/${smokeNodeId} {level:'capability', parentId:''} -> 200, clears a REAL parentId to absent (root)`,
      created.body?.parentId === ENGINEERING_ID && cleared.status === 200 &&
      cleared.body !== undefined && !('parentId' in cleared.body),
      `preParentId=${created.body?.parentId}, status=${cleared.status}, body=${JSON.stringify(cleared.body)}`,
    );
    // Re-confirm via a FRESH GET (not just the PUT's own echoed response) —
    // the point of this seam is that it persists identically on both adapters.
    {
      const { status, body } = await req('GET', '/resource-organizations');
      const node = Array.isArray(body) ? body.find((n) => n.id === smokeNodeId) : undefined;
      check(
        'GET /api/resource-organizations reflects the cleared node as a root (parentId absent) on re-read',
        status === 200 && Boolean(node) && !('parentId' in node),
        node ? `node=${JSON.stringify(node)}` : `status=${status}, missing`,
      );
    }

    // 9b) THE SAME SEAM FOR managerId — a client clears the manager by
    // sending '', not null (identical reasoning to parentId above: an
    // untranslated '' would persist as a literal empty string on both
    // adapters, never becoming absent). This is not just symmetry for its own
    // sake: Task 7 builds a manager <select> whose empty option is the ONLY
    // way to detach a Capability Leader from a node — without this
    // translation, clearing the manager in that UI would silently do nothing.
    const managerSet = await req('PUT', `/resource-organizations/${smokeNodeId}`, {
      headers: RBAC_HEADERS,
      body: { managerId: '1' },
    });
    check(
      `PUT /api/resource-organizations/${smokeNodeId} {managerId:'1'} -> 200, sets a real manager`,
      managerSet.status === 200 && managerSet.body?.managerId === '1',
      `status=${managerSet.status}, body=${JSON.stringify(managerSet.body)}`,
    );
    // The assertion folds in the precondition that a REAL managerId was set
    // beforehand (same discipline as the parentId seam above), so this fails
    // for the right reason if the translation is missing, not by accident.
    const managerCleared = await req('PUT', `/resource-organizations/${smokeNodeId}`, {
      headers: RBAC_HEADERS,
      body: { managerId: '' },
    });
    check(
      `PUT /api/resource-organizations/${smokeNodeId} {managerId:''} -> 200, clears a REAL manager to absent`,
      managerSet.body?.managerId === '1' && managerCleared.status === 200 &&
      managerCleared.body !== undefined && !('managerId' in managerCleared.body),
      `preManagerId=${managerSet.body?.managerId}, status=${managerCleared.status}, body=${JSON.stringify(managerCleared.body)}`,
    );
    {
      const { status, body } = await req('GET', '/resource-organizations');
      const node = Array.isArray(body) ? body.find((n) => n.id === smokeNodeId) : undefined;
      check(
        'GET /api/resource-organizations reflects the cleared node with managerId absent on re-read',
        status === 200 && Boolean(node) && !('managerId' in node),
        node ? `node=${JSON.stringify(node)}` : `status=${status}, missing`,
      );
    }

    // Cleanup: the smoke node is now a childless root with no resources
    // referencing it — deletable, so a future run against a persistent
    // (Postgres) backend never accumulates cruft.
    const cleanup = await req('DELETE', `/resource-organizations/${smokeNodeId}`, { headers: RBAC_HEADERS });
    check(`DELETE /api/resource-organizations/${smokeNodeId} (smoke cleanup) -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
  }

  // 10) REVIEW ROUND 2 (critical #1) — PUT {name: null} must be REJECTED
  // (400), never masked. `body.level ?? existing?.level` / `body.name ??
  // existing?.name` cannot tell "absent" from "explicitly null" — both are
  // nullish to `??` — and pick() copies an explicit `null` straight through
  // (it only filters `undefined`). Left unchecked this corrupts the row: the
  // in-memory adapter's update() DELETES the `name` key outright (it is
  // `notNull()` in the schema); Postgres raises an unmapped NOT NULL
  // violation (SQLSTATE 23502) as an opaque 500. Uses a FRESH throwaway node,
  // never a seeded one — against the pre-fix build this call actually
  // corrupts whatever row it targets, and seeded nodes are load-bearing for
  // every other check in this function.
  {
    const throwaway = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Null-Name Guard', description: 'x', level: 'capability' },
    });
    const throwawayOk = check(
      'null-name guard setup: a fresh throwaway node is created',
      throwaway.status === 200 && typeof throwaway.body?.id === 'string',
      `status=${throwaway.status}, body=${JSON.stringify(throwaway.body)}`,
    );
    if (throwawayOk) {
      const throwawayId = throwaway.body.id;
      const masked = await req('PUT', `/resource-organizations/${throwawayId}`, {
        headers: RBAC_HEADERS,
        body: { name: null },
      });
      check(
        `PUT /api/resource-organizations/${throwawayId} {name: null} -> 400 (rejected, not masked by the ?? fallback)`,
        masked.status === 400,
        `status=${masked.status}, body=${JSON.stringify(masked.body)}`,
      );
      // The point of this check is that the row was never corrupted, even
      // transiently — not just that the response was a 400.
      {
        const { status, body } = await req('GET', '/resource-organizations');
        const node = Array.isArray(body) ? body.find((n) => n.id === throwawayId) : undefined;
        check(
          "GET /api/resource-organizations shows the throwaway node's name UNCHANGED after the rejected PUT",
          status === 200 && node?.name === 'D Smoke Null-Name Guard',
          node ? `name=${JSON.stringify(node.name)}` : `status=${status}, missing`,
        );
      }
      const cleanup10 = await req('DELETE', `/resource-organizations/${throwawayId}`, { headers: RBAC_HEADERS });
      check(`null-name guard cleanup: DELETE /api/resource-organizations/${throwawayId} -> 204`, cleanup10.status === 204, `status=${cleanup10.status}`);
    }
  }

  // 11) REVIEW ROUND 2 (critical #1, the full exploit chain) — a masked
  // {name: null} PUT was the one thing that could get a resource-still-
  // referenced node PAST the delete guard: rename to `undefined` (silently),
  // then the guard's `resources.some(r => r.organization === node.name)`
  // compares against `undefined` and matches nobody. Proves the WHOLE chain
  // is closed, not just the isolated PUT from check 10 — a fresh, childless
  // leaf with an attached resource, attempt the masking PUT (must now 400),
  // then attempt the delete (must STILL 409 — the guard never stopped
  // working, because the name never actually changed).
  {
    const leaf2 = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Leaf (null-name chain)', description: 'x', level: 'capability' },
    });
    const leaf2Ok = check(
      'check 11 setup: a fresh, childless leaf node is created',
      leaf2.status === 200 && typeof leaf2.body?.id === 'string',
      `status=${leaf2.status}, body=${JSON.stringify(leaf2.body)}`,
    );
    if (leaf2Ok) {
      const leaf2Id = leaf2.body.id;
      const leaf2Name = leaf2.body.name;
      const resource2 = await req('POST', '/resources', {
        headers: RBAC_HEADERS,
        body: { name: 'D Smoke Resource (null-name chain)', role: 'Developer', kind: 'internal', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8 },
      });
      const resource2Ok = check(
        'check 11 setup: a throwaway resource is created',
        resource2.status === 201 && typeof resource2.body?.id === 'string',
        `status=${resource2.status}, body=${JSON.stringify(resource2.body)}`,
      );
      if (resource2Ok) {
        const resource2Id = resource2.body.id;
        const attach2 = await req('PUT', `/resources/${resource2Id}`, {
          headers: RBAC_HEADERS,
          body: { organization: leaf2Name },
        });
        const attach2Ok = check(
          `check 11 setup: PUT /api/resources/${resource2Id} {organization:'${leaf2Name}'} -> 200`,
          attach2.status === 200 && attach2.body?.organization === leaf2Name,
          `status=${attach2.status}, body=${JSON.stringify(attach2.body)}`,
        );
        if (attach2Ok) {
          const maskAttempt = await req('PUT', `/resource-organizations/${leaf2Id}`, {
            headers: RBAC_HEADERS,
            body: { name: null },
          });
          check(
            `check 11: PUT /api/resource-organizations/${leaf2Id} {name: null} -> 400 (the masking attempt is rejected)`,
            maskAttempt.status === 400,
            `status=${maskAttempt.status}, body=${JSON.stringify(maskAttempt.body)}`,
          );
          const delAttempt = await req('DELETE', `/resource-organizations/${leaf2Id}`, { headers: RBAC_HEADERS });
          check(
            `check 11: DELETE /api/resource-organizations/${leaf2Id} -> 409, the resources guard STILL fires (the name was never actually changed, so the bypass is closed)`,
            delAttempt.status === 409,
            `status=${delAttempt.status}, body=${JSON.stringify(delAttempt.body)}`,
          );
        }
        // Cleanup: detach, then remove the leaf.
        const detach2 = await req('PUT', `/resources/${resource2Id}`, {
          headers: RBAC_HEADERS,
          body: { organization: '' },
        });
        check(`check 11 cleanup: PUT /api/resources/${resource2Id} {organization:''} -> 200, detaches`, detach2.status === 200, `status=${detach2.status}`);
        const cleanup11 = await req('DELETE', `/resource-organizations/${leaf2Id}`, { headers: RBAC_HEADERS });
        check(`check 11 cleanup: DELETE /api/resource-organizations/${leaf2Id} (now unreferenced, childless) -> 204`, cleanup11.status === 204, `status=${cleanup11.status}`);
      }
    }
  }

  // 12) REVIEW ROUND 2 (important) — a rename must not silently orphan every
  // resource still bound to the OLD name. Exercises the EXACT scenario the
  // coordinator reported: renaming seeded 'Engineering' (id '2'), which
  // several seeded resources reference by organization name (spec §2.4:
  // resources bind by NAME, and tree-wide name uniqueness exists PRECISELY
  // because of that binding). Mirrors the delete guard as a 409 refusal, NOT
  // a cascade onto the resources — see the comment at this guard in
  // src/server.ts for why cascading was considered and deliberately deferred.
  {
    const renamed = await req('PUT', `/resource-organizations/${ENGINEERING_ID}`, {
      headers: RBAC_HEADERS,
      body: { name: 'Engineering EMEA' },
    });
    check(
      "PUT /api/resource-organizations/2 {name:'Engineering EMEA'} -> 409 (resources still reference 'Engineering' by name)",
      renamed.status === 409,
      `status=${renamed.status}, body=${JSON.stringify(renamed.body)}`,
    );
    // Not just the status — confirm the name genuinely never changed.
    const { status, body } = await req('GET', '/resource-organizations');
    const node = Array.isArray(body) ? body.find((n) => n.id === ENGINEERING_ID) : undefined;
    check(
      "GET /api/resource-organizations shows 'Engineering' (id '2') name UNCHANGED after the refused rename",
      status === 200 && node?.name === 'Engineering',
      node ? `name=${JSON.stringify(node.name)}` : `status=${status}, missing`,
    );
  }

  // 13) REVIEW ROUND 2 (minor, the brief's "highest-risk area") — three
  // single-field PUTs the validator's cross-field logic already handles
  // correctly (per the coordinator's own read of the code), pinned so a
  // future edit to validateOrgTreeNode can't quietly break them. Read-only:
  // each is rejected with 400 before validateOrgTreeNode ever reaches
  // `update()`, so none of these mutate seed data.
  {
    // {level: 'capability'} ALONE on '5' (Platform), which still has parentId
    // '2' — the capability-is-a-root rule must fire off the EXISTING
    // parentId, not just a parentId supplied in the same body.
    const r13a = await req('PUT', `/resource-organizations/${PLATFORM_ID}`, {
      headers: RBAC_HEADERS,
      body: { level: 'capability' },
    });
    check(
      "PUT /api/resource-organizations/5 {level:'capability'} ALONE (still has parentId '2') -> 400",
      r13a.status === 400,
      `status=${r13a.status}, body=${JSON.stringify(r13a.body)}`,
    );

    // {parentId: X} ALONE on '6' (Backend, competence), where X ('2',
    // Engineering) is a capability, not the practice a competence requires —
    // the wrong-level check must fire off the EXISTING level, not just a
    // level supplied in the same body. '2' is not '6's descendant, so this is
    // purely the wrong-level branch, not a cycle.
    const r13b = await req('PUT', `/resource-organizations/${BACKEND_ID}`, {
      headers: RBAC_HEADERS,
      body: { parentId: ENGINEERING_ID },
    });
    check(
      "PUT /api/resource-organizations/6 {parentId:'2'} ALONE (a capability, wrong level for a competence's parent) -> 400",
      r13b.status === 400,
      `status=${r13b.status}, body=${JSON.stringify(r13b.body)}`,
    );

    // {parentId: ''} ALONE on '5' (Platform, practice) — clearing the parent
    // must be caught off the EXISTING level ('practice' must have a parent),
    // not just a level supplied in the same body.
    const r13c = await req('PUT', `/resource-organizations/${PLATFORM_ID}`, {
      headers: RBAC_HEADERS,
      body: { parentId: '' },
    });
    check(
      "PUT /api/resource-organizations/5 {parentId:''} ALONE (a practice, which must have a parent) -> 400",
      r13c.status === 400,
      `status=${r13c.status}, body=${JSON.stringify(r13c.body)}`,
    );
  }

  // 14) REVIEW ROUND 3 — the required-field null-rejection covers the WHOLE
  // class of notNull columns (name, description, costCenters, level), not
  // just the two round 2 found. {description: null} on PUT -> 400, same
  // primitive as the round-2 name bug: description has no "absent" state to
  // clear to, so an explicit null is invalid input, not a clear-to-absent.
  {
    const throwaway14 = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Null-Description Guard', description: 'x', level: 'capability' },
    });
    const ok14 = check(
      'null-description guard setup: a fresh throwaway node is created',
      throwaway14.status === 200 && typeof throwaway14.body?.id === 'string',
      `status=${throwaway14.status}, body=${JSON.stringify(throwaway14.body)}`,
    );
    if (ok14) {
      const id14 = throwaway14.body.id;
      const masked14 = await req('PUT', `/resource-organizations/${id14}`, {
        headers: RBAC_HEADERS,
        body: { description: null },
      });
      check(
        `PUT /api/resource-organizations/${id14} {description: null} -> 400 (rejected, notNull column)`,
        masked14.status === 400,
        `status=${masked14.status}, body=${JSON.stringify(masked14.body)}`,
      );
      const { status: s14, body: b14 } = await req('GET', '/resource-organizations');
      const node14 = Array.isArray(b14) ? b14.find((n) => n.id === id14) : undefined;
      check(
        "GET /api/resource-organizations shows the throwaway node's description UNCHANGED after the rejected PUT",
        s14 === 200 && node14?.description === 'x',
        node14 ? `description=${JSON.stringify(node14.description)}` : `status=${s14}, missing`,
      );
      const cleanup14 = await req('DELETE', `/resource-organizations/${id14}`, { headers: RBAC_HEADERS });
      check(`null-description guard cleanup: DELETE /api/resource-organizations/${id14} -> 204`, cleanup14.status === 204, `status=${cleanup14.status}`);
    }
  }

  // 15) {costCenters: null} on PUT -> 400. Additionally notable because
  // validateResourceOrgRefs's OWN `!== null` clause explicitly treats null as
  // acceptable for ITS check (see the comment there) — it is the required-
  // field loop in validateOrgTreeNode, called right after in the same
  // request, that actually stops a null costCenters from reaching the repo.
  {
    const throwaway15 = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Null-CostCenters Guard', description: 'x', level: 'capability', costCenters: ['CC-9001'] },
    });
    const ok15 = check(
      'null-costCenters guard setup: a fresh throwaway node is created (with a real costCenters entry)',
      throwaway15.status === 200 && typeof throwaway15.body?.id === 'string' && Array.isArray(throwaway15.body?.costCenters) && throwaway15.body.costCenters.includes('CC-9001'),
      `status=${throwaway15.status}, body=${JSON.stringify(throwaway15.body)}`,
    );
    if (ok15) {
      const id15 = throwaway15.body.id;
      const masked15 = await req('PUT', `/resource-organizations/${id15}`, {
        headers: RBAC_HEADERS,
        body: { costCenters: null },
      });
      check(
        `PUT /api/resource-organizations/${id15} {costCenters: null} -> 400 (rejected, notNull column)`,
        masked15.status === 400,
        `status=${masked15.status}, body=${JSON.stringify(masked15.body)}`,
      );
      const { status: s15, body: b15 } = await req('GET', '/resource-organizations');
      const node15 = Array.isArray(b15) ? b15.find((n) => n.id === id15) : undefined;
      check(
        "GET /api/resource-organizations shows the throwaway node's costCenters UNCHANGED after the rejected PUT",
        s15 === 200 && Array.isArray(node15?.costCenters) && node15.costCenters.includes('CC-9001'),
        node15 ? `costCenters=${JSON.stringify(node15.costCenters)}` : `status=${s15}, missing`,
      );
      const cleanup15 = await req('DELETE', `/resource-organizations/${id15}`, { headers: RBAC_HEADERS });
      check(`null-costCenters guard cleanup: DELETE /api/resource-organizations/${id15} -> 204`, cleanup15.status === 204, `status=${cleanup15.status}`);
    }
  }

  // 16) THE POST-SPECIFIC HALF — {costCenters: null} on POST -> 400, not a
  // persisted null. Before this round, the POST handler's
  // `{ costCenters: [], ...body }` spread meant an explicit
  // `costCenters: null` OVERRODE the `[]` default (the trailing spread always
  // wins), landing a literal null straight in the created row — no row
  // should be created at all now.
  {
    const rejectedPost = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Null-CostCenters POST Guard', description: 'x', level: 'capability', costCenters: null },
    });
    check(
      'POST /api/resource-organizations {costCenters: null} -> 400 (rejected, not persisted via the spread)',
      rejectedPost.status === 400,
      `status=${rejectedPost.status}, body=${JSON.stringify(rejectedPost.body)}`,
    );
    // Confirm no row leaked under that name (not just the status code) — and
    // clean it up if it did (only reachable pre-fix, on a red run).
    const { status: s16, body: b16 } = await req('GET', '/resource-organizations');
    const leaked = Array.isArray(b16) ? b16.find((n) => n.name === 'D Smoke Null-CostCenters POST Guard') : undefined;
    check(
      'GET /api/resource-organizations confirms no row was created for the rejected POST',
      s16 === 200 && leaked === undefined,
      leaked ? `leaked row=${JSON.stringify(leaked)}` : 'none found (correct)',
    );
    if (leaked !== undefined) {
      await req('DELETE', `/resource-organizations/${leaked.id}`, { headers: RBAC_HEADERS });
    }
  }

  // 17) REVIEW ROUND 1 (Task 7 coordinator feedback, critical #2) — changing a
  // node's OWN level while it has an EXISTING CHILD must be refused: every
  // check above only ever validates the record being edited against ITS OWN
  // parent, never against a child pointing back at it. Isolated on a fresh,
  // throwaway capability -> practice -> competence chain (never the seeded
  // Platform/Backend used elsewhere in this function) so a pre-fix run that
  // lets this through does not corrupt a fixture other checks rely on.
  {
    const rootC = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Level-Guard Root', description: 'x', level: 'capability' },
    });
    const rootOk = check(
      'check 17 setup: a fresh capability root is created',
      rootC.status === 200 && typeof rootC.body?.id === 'string',
      `status=${rootC.status}, body=${JSON.stringify(rootC.body)}`,
    );
    if (rootOk) {
      const rootId = rootC.body.id;
      const midC = await req('POST', '/resource-organizations', {
        headers: RBAC_HEADERS,
        body: { name: 'D Smoke Level-Guard Mid', description: 'x', level: 'practice', parentId: rootId },
      });
      const midOk = check(
        'check 17 setup: a fresh practice, child of the root, is created',
        midC.status === 200 && typeof midC.body?.id === 'string',
        `status=${midC.status}, body=${JSON.stringify(midC.body)}`,
      );
      if (midOk) {
        const midId = midC.body.id;
        const leafC = await req('POST', '/resource-organizations', {
          headers: RBAC_HEADERS,
          body: { name: 'D Smoke Level-Guard Leaf', description: 'x', level: 'competence', parentId: midId },
        });
        const leafOk = check(
          'check 17 setup: a fresh competence, child of the practice, is created',
          leafC.status === 200 && typeof leafC.body?.id === 'string',
          `status=${leafC.status}, body=${JSON.stringify(leafC.body)}`,
        );
        if (leafOk) {
          const leafId = leafC.body.id;
          // The guard itself: mid has a child (the leaf, a competence
          // requiring a practice parent) — changing mid's own level to
          // 'capability' would leave that child's parent no longer a practice.
          const changed = await req('PUT', `/resource-organizations/${midId}`, {
            headers: RBAC_HEADERS,
            body: { level: 'capability', parentId: '' },
          });
          check(
            `PUT /api/resource-organizations/${midId} {level:'capability'} while it still has a competence child -> 400 (would orphan the child's level requirement)`,
            changed.status === 400,
            `status=${changed.status}, body=${JSON.stringify(changed.body)}`,
          );
          // Confirm the row was never actually changed, not just the status.
          const { status: sMid, body: bMid } = await req('GET', '/resource-organizations');
          const midNode = Array.isArray(bMid) ? bMid.find((n) => n.id === midId) : undefined;
          check(
            "GET /api/resource-organizations shows the mid node's level UNCHANGED ('practice') after the rejected PUT",
            sMid === 200 && midNode?.level === 'practice' && midNode?.parentId === rootId,
            midNode ? `node=${JSON.stringify(midNode)}` : `status=${sMid}, missing`,
          );
          // The guard is scoped to "has children", not "level changes are
          // never allowed again" — delete the only child, then the exact same
          // PUT must now succeed.
          const delLeaf = await req('DELETE', `/resource-organizations/${leafId}`, { headers: RBAC_HEADERS });
          check(`check 17: DELETE /api/resource-organizations/${leafId} (the now-only child) -> 204`, delLeaf.status === 204, `status=${delLeaf.status}`);
          const changedOk = await req('PUT', `/resource-organizations/${midId}`, {
            headers: RBAC_HEADERS,
            body: { level: 'capability', parentId: '' },
          });
          check(
            `PUT /api/resource-organizations/${midId} {level:'capability'} now that it has NO children -> 200 (the guard is scoped to children, not a blanket freeze)`,
            changedOk.status === 200 && changedOk.body?.level === 'capability',
            `status=${changedOk.status}, body=${JSON.stringify(changedOk.body)}`,
          );
        }
        // Cleanup: mid is now childless either way (the leaf was deleted
        // above on the success path; leaf creation never happened at all on
        // the setup-failure path), so a single DELETE here covers both.
        const cleanupMid = await req('DELETE', `/resource-organizations/${midId}`, { headers: RBAC_HEADERS });
        check(`check 17 cleanup: DELETE /api/resource-organizations/${midId} -> 204`, cleanupMid.status === 204, `status=${cleanupMid.status}`);
      }
      const cleanupRoot = await req('DELETE', `/resource-organizations/${rootId}`, { headers: RBAC_HEADERS });
      check(`check 17 cleanup: DELETE /api/resource-organizations/${rootId} -> 204`, cleanupRoot.status === 204, `status=${cleanupRoot.status}`);
    }
  }

  // 18) REVIEW ROUND 4 (important #3) — THE '' SENTINEL ON **CREATE**. The PUT
  // handler translates '' -> null ("clear this field"); POST used to spread the
  // body straight into `create()`, which strips nothing, while
  // `validateOrgTreeNode` skips the reference check for '' — so a POST carrying
  // `managerId: ''` persisted a LITERAL empty string. That value then entered
  // `scopedApproversOf`'s manager set (which guarded only `!== undefined`),
  // naming an approver nobody can be while still suppressing the role fallback:
  // the same lockout critical #1 describes, through a second door. `parentId: ''`
  // likewise persisted and made the node fall out of the customizing tree's main
  // walk. The client was working around this by omitting the keys on create —
  // the UI as sole guardian, which the Global Constraints forbid.
  //
  // Mirrors checks 5/6 of `checkResourceManagerCycle` (the same bug, the same
  // fix, on `POST /resources`' own managerId) — including the literal-`null`
  // half, which `pick()` forwards unchanged.
  {
    const emptySentinels = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Empty Sentinels', description: 'x', level: 'capability', parentId: '', managerId: '' },
    });
    check(
      "POST /api/resource-organizations {parentId:'', managerId:''} -> 200, both normalized to ABSENT, not persisted as literal ''",
      emptySentinels.status === 200
      && emptySentinels.body?.parentId === undefined && emptySentinels.body?.managerId === undefined,
      `status=${emptySentinels.status}, body=${JSON.stringify(emptySentinels.body)}`,
    );
    // Re-READ it, not just the create response: the in-memory adapter returns
    // what it was handed, so only a fresh GET proves what was actually stored.
    if (typeof emptySentinels.body?.id === 'string') {
      const id = emptySentinels.body.id;
      const reread = await req('GET', '/resource-organizations');
      const stored = (Array.isArray(reread.body) ? reread.body : []).find((n) => n.id === id);
      check(
        'check 18: the stored row reads back with parentId/managerId genuinely absent (adapter parity)',
        stored !== undefined && stored.parentId === undefined && stored.managerId === undefined,
        `stored=${JSON.stringify(stored)}`,
      );
      const cleanup = await req('DELETE', `/resource-organizations/${id}`, { headers: RBAC_HEADERS });
      check(`check 18 cleanup: DELETE /api/resource-organizations/${id} -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
    }
  }

  // 19) The literal-`null` half of check 18 — `pick()` forwards an explicit
  // JSON null unchanged (it only filters `undefined`), and `create()` has no
  // null-stripping step on either adapter, so an unnormalized null would live
  // on in an in-memory row while Postgres stored a proper NULL: a silent
  // adapter disagreement. Neither field is in REQUIRED_ORG_FIELDS, so a null is
  // NOT a 400 here (unlike `name`/`level`/`description`/`costCenters`) — it is
  // a legitimate "no parent / no manager", normalized to absent.
  {
    const nullSentinels = await req('POST', '/resource-organizations', {
      headers: RBAC_HEADERS,
      body: { name: 'D Smoke Null Sentinels', description: 'x', level: 'capability', parentId: null, managerId: null },
    });
    check(
      'POST /api/resource-organizations {parentId: null, managerId: null} -> 200, both normalized to ABSENT, not persisted as literal null',
      nullSentinels.status === 200
      && nullSentinels.body?.parentId === undefined && nullSentinels.body?.managerId === undefined,
      `status=${nullSentinels.status}, body=${JSON.stringify(nullSentinels.body)}`,
    );
    if (typeof nullSentinels.body?.id === 'string') {
      const cleanup = await req('DELETE', `/resource-organizations/${nullSentinels.body.id}`, { headers: RBAC_HEADERS });
      check(`check 19 cleanup: DELETE /api/resource-organizations/${nullSentinels.body.id} -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
    }
  }
}

/**
 * Task 3 (negotiated sell rates, design spec §5) — write-side integrity on the
 * bespoke `/negotiated-rates` handlers (src/server.ts, NOT mounted with
 * `crud()`, following the `/resource-organizations` shape exercised above):
 * contractId XOR projectId, FK existence on whichever side is supplied, a role
 * check against the project-roles CATALOG (not roles actually held by a
 * resource — a negotiated rate is agreed BEFORE anyone with that profile is
 * hired, and a contract is signed before staffing, so the catalog, not
 * today's staffing, is the right authority; see `validateNegotiatedRate`'s doc
 * comment), same-key uniqueness on (contractId|projectId, role, currency), the
 * numeric guard on billRate, and the pick()-forwards-null class proven again
 * here (spec §5's own callback to the D block's REQUIRED_ORG_FIELDS fix).
 *
 * SEED FIXTURES relied on (src/db/seed.ts) — none of these are mutated by
 * earlier smoke sections:
 *   - contract 'CT1' exists and carries NO 'Developer'/EUR negotiated rate
 *     (the seeded pair is on 'CT2' and project '2') — safe for checks 1/7/8/10
 *     to create/duplicate/mutate against without colliding with seed rows.
 *   - resource '1' (Julie Armstrong) has role 'Developer'; resource '3' (Alice
 *     Smith) has role 'Designer'; resource '2' (John Miller) has role
 *     'Consultant' — all three are real project-roles catalog entries, used
 *     below so the role-existence check is exercised against genuine data,
 *     not a fixture invented for the test.
 *   - no resource anywhere holds the literal role 'Nobody Has This', AND it is
 *     not a project-roles catalog entry either (check 6) — a typo under
 *     either candidate mechanism.
 *   - 'Project Manager' (check 14) IS a genuine project-roles catalog entry
 *     (seed.ts projectRoles id '2') but NO seeded resource holds it as `role`
 *     — the fixture that actually distinguishes the catalog check from a
 *     resources-based one, unlike check 6's string which fails under either.
 *
 * Every "expect 400" check below deliberately uses a FRESH, otherwise-unique
 * (contractId, role, currency) key of its own (never CT1+Developer+EUR, which
 * check 1 owns) so a check that wrongly returns 200 pre-implementation cannot
 * leave a row behind that later collides with — or is mistaken for evidence
 * for — a different check.
 *
 * ROUND 2 (coordinator review): checks 13a-c and 14 added.
 *   - 13a-c close a CRITICAL gap the first round missed: every check past the
 *     null-rejection loop gates on `!== undefined`, which is PUT's fall-back-
 *     to-existing semantics — on POST (no existing row) an OMITTED key (not an
 *     explicit null) left the merged value `undefined` and silently skipped
 *     role-existence, uniqueness AND the numeric check, so a required column
 *     could be omitted outright rather than nulled. See the checks' own
 *     comment for the exact pre-fix repro.
 *   - 14 closes a MINOR gap: check 6 cannot prove which of two candidate role
 *     checks (catalog vs. resources-held) actually governs, since its string
 *     fails under both. 14 uses a role that is real in one and absent in the
 *     other.
 *
 * ROUND 3 (user decision, this branch's closing work) — check 14 FLIPPED.
 * The role check now validates against the project-roles CATALOG, not
 * against roles actually held by a resource (see the doc comment on
 * `validateNegotiatedRate` in src/server.ts for the full rationale). 'Project
 * Manager' is a genuine catalog entry held by no seeded resource, so it now
 * must be ACCEPTED (200), the opposite of its original 400 expectation.
 */
async function checkNegotiatedRates() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '9', 'X-User-Role': 'employee' };
  const CONTRACT_ID = 'CT1';

  // 1) POST a valid contract-level rate -> 200, response carries all four fields.
  const created = await req('POST', '/negotiated-rates', {
    headers: RBAC_HEADERS,
    body: { contractId: CONTRACT_ID, role: 'Developer', currency: 'EUR', billRate: 900 },
  });
  check(
    "POST /api/negotiated-rates {contractId:'CT1', role:'Developer', currency:'EUR', billRate:900} -> 200, all four fields carried through",
    created.status === 200 && created.body?.contractId === CONTRACT_ID && created.body?.role === 'Developer'
      && created.body?.currency === 'EUR' && created.body?.billRate === 900,
    `status=${created.status}, body=${JSON.stringify(created.body)}`,
  );
  // Keep the id even if the assertion above failed, so later checks (9-11),
  // which are independently meaningful, can still run against something.
  const createdId = typeof created.body?.id === 'string' ? created.body.id : undefined;

  // 2) Neither contractId nor projectId -> 400.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { role: 'Developer', currency: 'EUR', billRate: 800 },
    });
    check(
      'POST /api/negotiated-rates with neither contractId nor projectId -> 400',
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 3) Both contractId and projectId -> 400.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, projectId: '1', role: 'Developer', currency: 'EUR', billRate: 800 },
    });
    check(
      'POST /api/negotiated-rates with BOTH contractId and projectId -> 400',
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 4) A contractId that does not exist -> 400.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: 'NOPE_CONTRACT', role: 'Developer', currency: 'EUR', billRate: 800 },
    });
    check(
      "POST /api/negotiated-rates {contractId:'NOPE_CONTRACT'} -> 400 (does not reference an existing contract)",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 5) A projectId that does not exist -> 400.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { projectId: 'NOPE_PROJECT', role: 'Developer', currency: 'EUR', billRate: 800 },
    });
    check(
      "POST /api/negotiated-rates {projectId:'NOPE_PROJECT'} -> 400 (does not reference an existing project)",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 6) A role absent from the project-roles catalog -> 400 (a typo). NOTE: this
  // fails under EITHER candidate authority, so it does not discriminate between
  // them — check 14 is the one that pins the catalog as the governing rule.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Nobody Has This', currency: 'EUR', billRate: 800 },
    });
    check(
      "POST /api/negotiated-rates {role:'Nobody Has This'} -> 400 (absent from the project-roles catalog — see check 14 for which authority governs)",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 7) Duplicating check 1's (contractId, role, currency) key -> 400 naming the existing id.
  {
    const dup = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Developer', currency: 'EUR', billRate: 950 },
    });
    check(
      "POST /api/negotiated-rates duplicating check 1's (contractId:'CT1', role:'Developer', currency:'EUR') -> 400, naming the existing id",
      dup.status === 400 && (createdId === undefined || (typeof dup.body?.error === 'string' && dup.body.error.includes(createdId))),
      `status=${dup.status}, body=${JSON.stringify(dup.body)}, expectedId=${createdId}`,
    );
  }

  // 8) billRate: -1 -> 400; billRate: null -> 400. Each uses its OWN unique
  // (role, currency) key on CONTRACT_ID so the uniqueness check (7, above in
  // the validator's own order) cannot mask what this check exists to prove.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Designer', currency: 'EUR', billRate: -1 },
    });
    check(
      "POST /api/negotiated-rates {billRate: -1} -> 400",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Consultant', currency: 'EUR', billRate: null },
    });
    check(
      "POST /api/negotiated-rates {billRate: null} -> 400 (the pick()-forwards-null class, not merely 'not a number')",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 9) PUT changing ONLY billRate on the row from check 1 -> 200, new value, other fields intact.
  if (createdId !== undefined) {
    const updated = await req('PUT', `/negotiated-rates/${createdId}`, {
      headers: RBAC_HEADERS,
      body: { billRate: 975 },
    });
    check(
      `PUT /api/negotiated-rates/${createdId} {billRate:975} -> 200, new value, contractId/role/currency intact`,
      updated.status === 200 && updated.body?.billRate === 975 && updated.body?.contractId === CONTRACT_ID
        && updated.body?.role === 'Developer' && updated.body?.currency === 'EUR',
      `status=${updated.status}, body=${JSON.stringify(updated.body)}`,
    );
  } else {
    check('PUT changing only billRate on the check-1 row -> 200 (skipped: check 1 did not yield an id)', false, 'no createdId');
  }

  // 10) PUT with role: null -> 400 (pick() forwards a literal null; the row must not be corrupted).
  if (createdId !== undefined) {
    const bad = await req('PUT', `/negotiated-rates/${createdId}`, {
      headers: RBAC_HEADERS,
      body: { role: null },
    });
    check(
      `PUT /api/negotiated-rates/${createdId} {role: null} -> 400 (rejected, not masked by a ?? fallback)`,
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  } else {
    check('PUT {role: null} on the check-1 row -> 400 (skipped: check 1 did not yield an id)', false, 'no createdId');
  }

  // 11) DELETE the row from check 1 -> 204, and a subsequent GET no longer lists it.
  if (createdId !== undefined) {
    const del = await req('DELETE', `/negotiated-rates/${createdId}`, { headers: RBAC_HEADERS });
    check(`DELETE /api/negotiated-rates/${createdId} -> 204`, del.status === 204, `status=${del.status}`);
    const { status, body } = await req('GET', '/negotiated-rates');
    const stillListed = Array.isArray(body) && body.some(r => r.id === createdId);
    check(
      `GET /api/negotiated-rates no longer lists ${createdId} after DELETE`,
      status === 200 && !stillListed,
      `status=${status}, stillListed=${stillListed}`,
    );
  } else {
    check('DELETE the check-1 row -> 204 (skipped: check 1 did not yield an id)', false, 'no createdId');
    check('GET /api/negotiated-rates no longer lists the check-1 row (skipped: check 1 did not yield an id)', false, 'no createdId');
  }

  // 12) RBAC — 'employee' is outside the commercial read set -> 403.
  {
    const { status, body } = await req('GET', '/negotiated-rates', { headers: EMPLOYEE_HEADERS });
    check(
      "GET /api/negotiated-rates as an 'employee' -> 403",
      status === 403,
      `status=${status}, body=${JSON.stringify(body)}`,
    );
  }

  // 13a-c) ROUND 2 (coordinator review, critical) — a required field OMITTED
  // OUTRIGHT on POST is a DIFFERENT bug from an explicit null (checks 8/10
  // above): every check past the null-rejection loop gates on `!== undefined`,
  // which is exactly PUT's "field not touched, fall back to existing"
  // semantics — but POST has no existing row to fall back to, so an absent key
  // leaves the merged value `undefined` and each downstream check (xor is the
  // one exception, since it treats an absent contractId/projectId as meaningful)
  // silently no-ops. Pre-fix, `POST {contractId:'CT1'}` (role/currency/billRate
  // ALL absent) passed the null loop (nothing is `=== null`), passed xor and
  // the FK check, then skipped role-existence, uniqueness AND the numeric
  // check entirely, and the row was created with three missing notNull
  // columns — a 200 in-memory, an unmapped 23502-as-500 on Postgres. Each
  // sub-check below omits exactly ONE of the three REQUIRED_NEGOTIATED_RATE_FIELDS
  // (never null — that path is already covered by checks 8/10), with the
  // OTHER two present and valid, so a check can only pass by covering the
  // specific omitted field, not by coincidentally tripping some other rule.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, currency: 'EUR', billRate: 700 }, // role OMITTED, not null
    });
    check(
      'POST /api/negotiated-rates with role OMITTED OUTRIGHT (not null) -> 400',
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Designer', billRate: 700 }, // currency OMITTED, not null
    });
    check(
      'POST /api/negotiated-rates with currency OMITTED OUTRIGHT (not null) -> 400',
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Consultant', currency: 'EUR' }, // billRate OMITTED, not null
    });
    check(
      'POST /api/negotiated-rates with billRate OMITTED OUTRIGHT (not null) -> 400',
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
  }

  // 14) ROUND 3 (user decision, this branch's closing work) — PIN THE
  // ROLE-CHECK SEMANTICS, FLIPPED. Check 6 ('Nobody Has This') fails under
  // EITHER candidate mechanism (the project-roles CATALOG, or roles actually
  // HELD by a resource), so it cannot prove which one governs. 'Project
  // Manager' is a genuine project-roles catalog entry (src/db/seed.ts
  // projectRoles id '2') that NO seeded resource holds as its role (resources
  // '1'-'6' hold only Developer/Consultant/Designer) — a price is negotiated
  // BEFORE anyone with that profile is hired, and a contract is signed before
  // staffing, so the catalog (not today's staffing) is the right authority.
  // This is now ACCEPTED (200), the opposite of this check's original 400
  // expectation — the fixture that pins the deliberate semantics, not merely
  // 'some invalid string'.
  {
    const ok = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Project Manager', currency: 'EUR', billRate: 700 },
    });
    check(
      "POST /api/negotiated-rates {role:'Project Manager'} -> 200 (a real project-roles CATALOG entry, held by NO seeded resource — negotiation precedes staffing, so the catalog governs, not repos.resources)",
      ok.status === 200 && ok.body?.role === 'Project Manager',
      `status=${ok.status}, body=${JSON.stringify(ok.body)}`,
    );
    if (typeof ok.body?.id === 'string') {
      const cleanup = await req('DELETE', `/negotiated-rates/${ok.body.id}`, { headers: RBAC_HEADERS });
      check(`check 14 cleanup: DELETE /api/negotiated-rates/${ok.body.id} -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
    }
  }

  // 15) NEW (this branch's closing work, change #2) — currency: '' must be
  // REJECTED, not silently accepted. The null-rejection loop used to reject
  // only an explicit `null`, never an empty string, so `currency: ''` sailed
  // through every rule below untouched and produced a row that LOOKED saved
  // but was silently never read again: `sellRateFor`
  // (src/app/services/sell-rate.util.ts) only ever resolves a rate whose
  // currency is the base currency, so an empty-string row never participates
  // in resolution — a configuration that looks saved and never applies.
  // Fixed by reusing the SAME `validateCurrency` helper /contracts and
  // /orders already call (no second currency rule). Uses role 'Consultant' —
  // a role actually HELD by seeded resource '2' — so the check exercises
  // ONLY the currency rule: it must pass both the old resources-based role
  // check and the new catalog-based one, so a failure here can only be about
  // the currency, never a role collision (unlike a role no resource holds,
  // which would 400 for the wrong reason on the pre-fix code too).
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, role: 'Consultant', currency: '', billRate: 800 },
    });
    check(
      "POST /api/negotiated-rates {currency: ''} -> 400 (an empty currency is silently ignored forever by sellRateFor's resolution — validateCurrency, reused from /contracts and /orders)",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
    if (bad.status === 200 && typeof bad.body?.id === 'string') {
      const cleanup = await req('DELETE', `/negotiated-rates/${bad.body.id}`, { headers: RBAC_HEADERS });
      check(`check 15 cleanup: DELETE /api/negotiated-rates/${bad.body.id} -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
    }
  }

  // 16a-e) FINAL REVIEW, finding 1 — THE XOR MUST JUDGE THE VALUE THAT WILL
  // ACTUALLY BE WRITTEN. `hasContract`/`hasProject` were computed as
  // `typeof x === 'string' && x.length > 0`, but the object handed to create()
  // is the picked body VERBATIM — so a present-but-unusable FK (an empty
  // string, a number) failed the string test, was read as ABSENT by the xor,
  // and was then persisted anyway. `{contractId:'', projectId:'2'}` returned
  // 200 with BOTH FK columns populated in-memory (breaking the documented
  // "exactly one of contractId/projectId" invariant), while on Postgres the
  // same row raised a 23503 the error middleware maps to 409 — the two
  // adapters disagreeing, which is the exact class this endpoint's validation
  // exists to close. Rejected outright now, on either side.
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: '', projectId: '2', role: 'Consultant', currency: 'EUR', billRate: 900 },
    });
    check(
      "POST /api/negotiated-rates {contractId:'', projectId:'2'} -> 400 (an empty FK is not 'absent'; it used to persist BOTH columns in-memory and 409 on Postgres)",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
    if (bad.status === 200 && typeof bad.body?.id === 'string') {
      await req('DELETE', `/negotiated-rates/${bad.body.id}`, { headers: RBAC_HEADERS });
    }
  }
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: CONTRACT_ID, projectId: '', role: 'Consultant', currency: 'EUR', billRate: 900 },
    });
    check(
      "POST /api/negotiated-rates {projectId:'', contractId:'CT1'} -> 400 (the mirror side of the same hole)",
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
    if (bad.status === 200 && typeof bad.body?.id === 'string') {
      await req('DELETE', `/negotiated-rates/${bad.body.id}`, { headers: RBAC_HEADERS });
    }
  }
  {
    const bad = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: 123, projectId: '2', role: 'Consultant', currency: 'EUR', billRate: 900 },
    });
    check(
      'POST /api/negotiated-rates {contractId: 123} -> 400 (a non-string FK is the same hole with a different type)',
      bad.status === 400,
      `status=${bad.status}, body=${JSON.stringify(bad.body)}`,
    );
    if (bad.status === 200 && typeof bad.body?.id === 'string') {
      await req('DELETE', `/negotiated-rates/${bad.body.id}`, { headers: RBAC_HEADERS });
    }
  }
  // An explicit null is DIFFERENT from '' and must keep working: it is the one
  // signal that clears a side, and it clears identically on both adapters
  // (repository.ts's explicit-null rule on update, NULL on Postgres). On POST
  // it is normalised to ABSENT so the in-memory row never carries a literal
  // null while Postgres carries NULL — the response must have no contractId key.
  {
    const ok = await req('POST', '/negotiated-rates', {
      headers: RBAC_HEADERS,
      body: { contractId: null, projectId: '2', role: 'Consultant', currency: 'EUR', billRate: 900 },
    });
    check(
      "POST /api/negotiated-rates {contractId: null, projectId:'2'} -> 200 with NO contractId in the response (null means absent, normalised so both adapters agree)",
      ok.status === 200 && ok.body?.projectId === '2' && ok.body?.contractId === undefined,
      `status=${ok.status}, body=${JSON.stringify(ok.body)}`,
    );
    // ... and a PUT that nulls the winning side while naming the other one
    // MOVES the rate rather than ending up with both columns set.
    if (typeof ok.body?.id === 'string') {
      const moved = await req('PUT', `/negotiated-rates/${ok.body.id}`, {
        headers: RBAC_HEADERS,
        body: { projectId: null, contractId: CONTRACT_ID },
      });
      check(
        `PUT /api/negotiated-rates/${ok.body.id} {projectId: null, contractId:'CT1'} -> 200, moves the rate: contractId set, projectId cleared`,
        moved.status === 200 && moved.body?.contractId === CONTRACT_ID && moved.body?.projectId === undefined,
        `status=${moved.status}, body=${JSON.stringify(moved.body)}`,
      );
      const cleanup = await req('DELETE', `/negotiated-rates/${ok.body.id}`, { headers: RBAC_HEADERS });
      check(`check 16 cleanup: DELETE /api/negotiated-rates/${ok.body.id} -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
    } else {
      check('check 16 PUT side-move (skipped: the POST did not yield an id)', false, `body=${JSON.stringify(ok.body)}`);
      check('check 16 cleanup (skipped: the POST did not yield an id)', false, 'no id');
    }
  }

  // 17a-b) FINAL REVIEW, finding 4 — THE [CAP-EXCEEDED] NOT-TO-EXCEED FLAG MUST
  // BE PRICED AT THE NEGOTIATED RATE. `accruedTAndM` (src/server.ts) summed
  // `hours × resource.billRate` while its own doc comment claimed it applied
  // "the same as-incurred rule the finance util's recognitionSchedule uses" —
  // true before this branch, false after it. That figure decides whether a cap
  // is REPORTED AS BREACHED, so a wrong rate mis-flags a contract to whoever
  // reads the billing plan: a negotiated DISCOUNT fires the flag on an accrual
  // the customer will never be billed, and a negotiated PREMIUM lets a genuine
  // breach pass unflagged. Both directions are checked, and each cap is placed
  // BETWEEN the reference-priced and negotiated-priced accrual so the check can
  // only pass with the right one — a check that merely calls the endpoint would
  // pass either way.
  //
  // Project '1' is used because it carries approved seeded hours AND no
  // cap-bearing billing item, which `enforceCappedBilling` requires (the flag is
  // only attributed when a project has exactly ONE cap). The two accruals are
  // computed from LIVE data, never hard-coded, so a change to the seeded hours
  // cannot silently turn this into a tautology.
  {
    const CAP_PROJECT = '1';
    const [entriesRes, resourcesRes, hpdRes] = await Promise.all([
      req('GET', '/time-entries'),
      req('GET', '/resources'),
      req('GET', '/settings/hours-per-day'),
    ]);
    const entries = (entriesRes.body || []).filter(t => t.projectId === CAP_PROJECT && t.status === 'Approved');
    const byId = new Map((resourcesRes.body || []).map(r => [r.id, r]));
    // /resources serves an HOURLY billRate (withEffectiveRates already divided).
    const refAccrual = entries.reduce((sum, t) => sum + t.hours * (byId.get(t.resourceId)?.billRate ?? 0), 0);
    const hoursPerDay = Number(hpdRes.body?.value) || 8;
    const roles = new Set(entries.map(t => byId.get(t.resourceId)?.role));
    const setupOk = check(
      `finding 4 setup: project '${CAP_PROJECT}' has approved hours priced at a non-zero reference accrual, all one role`,
      refAccrual > 0 && roles.size === 1 && roles.has('Developer'),
      `refAccrual=${refAccrual} roles=${JSON.stringify([...roles])} entries=${entries.length}`,
    );

    /** POST a Capped item on the project and return its stored notes (''-safe). */
    const capItemNotes = async (capAmount, label) => {
      const created = await req('POST', '/billing-plan-items', {
        headers: RBAC_HEADERS,
        body: {
          contractId: 'CT1', projectId: CAP_PROJECT, type: 'Capped', label,
          amount: 100, capAmount, currency: 'EUR', status: 'Planned', expectedDate: '2026-09-30',
        },
      });
      const notes = typeof created.body?.notes === 'string' ? created.body.notes : '';
      if (typeof created.body?.id === 'string') {
        await req('DELETE', `/billing-plan-items/${created.body.id}`, { headers: RBAC_HEADERS });
      }
      return { status: created.status, notes };
    };

    if (setupOk) {
      // (a) FALSE BREACH — a negotiated DISCOUNT at HALF the reference hourly
      // price. Cap sits between the two accruals, so the reference-priced
      // accrual breaches it and the negotiated one does not.
      const discountDayRate = (refAccrual / entries.reduce((h, t) => h + t.hours, 0)) * hoursPerDay / 2;
      const rate = await req('POST', '/negotiated-rates', {
        headers: RBAC_HEADERS,
        body: { projectId: CAP_PROJECT, role: 'Developer', currency: 'EUR', billRate: discountDayRate },
      });
      const rateId = typeof rate.body?.id === 'string' ? rate.body.id : undefined;
      check(
        `finding 4 setup: a project-level DISCOUNT rate (${discountDayRate}/day = half the reference hourly) is created`,
        rate.status === 200 && rateId !== undefined,
        `status=${rate.status} body=${JSON.stringify(rate.body)}`,
      );

      const midCap = (refAccrual / 2 + refAccrual) / 2; // between negotiated and reference
      const discounted = await capItemNotes(midCap, 'finding 4 — discount must not flag');
      check(
        `POST /api/billing-plan-items Capped capAmount=${Math.round(midCap)} with a negotiated DISCOUNT -> NO [CAP-EXCEEDED] (the reference-priced accrual ${Math.round(refAccrual)} would have flagged it)`,
        discounted.status === 200 && !discounted.notes.includes('[CAP-EXCEEDED]'),
        `status=${discounted.status} notes="${discounted.notes}"`,
      );

      // (b) MISSED BREACH — the same rate raised to a PREMIUM at double the
      // reference hourly price, with a cap above the reference accrual but below
      // the negotiated one. The flag MUST fire; pre-fix it did not.
      if (rateId !== undefined) {
        const premiumDayRate = (refAccrual / entries.reduce((h, t) => h + t.hours, 0)) * hoursPerDay * 2;
        const bumped = await req('PUT', `/negotiated-rates/${rateId}`, {
          headers: RBAC_HEADERS,
          body: { billRate: premiumDayRate },
        });
        check(
          `finding 4 setup: the same rate is raised to a PREMIUM (${premiumDayRate}/day = double the reference hourly)`,
          bumped.status === 200 && bumped.body?.billRate === premiumDayRate,
          `status=${bumped.status} body=${JSON.stringify(bumped.body)}`,
        );

        const highCap = (refAccrual + refAccrual * 2) / 2; // above reference, below negotiated
        const premium = await capItemNotes(highCap, 'finding 4 — premium must flag');
        check(
          `POST /api/billing-plan-items Capped capAmount=${Math.round(highCap)} with a negotiated PREMIUM -> [CAP-EXCEEDED] IS flagged (the reference-priced accrual ${Math.round(refAccrual)} would have missed the breach)`,
          premium.status === 200 && premium.notes.includes('[CAP-EXCEEDED]'),
          `status=${premium.status} notes="${premium.notes}"`,
        );

        const cleanup = await req('DELETE', `/negotiated-rates/${rateId}`, { headers: RBAC_HEADERS });
        check(`finding 4 cleanup: DELETE /api/negotiated-rates/${rateId} -> 204`, cleanup.status === 204, `status=${cleanup.status}`);
      }
    }
  }
}

/**
 * D task 5 — THE SCOPED ALLOCATION DECISION (design spec §3.3, §3.4, §3.5).
 *
 * Until D, `decideOneApproval` admitted ANY actor holding the step's role, so
 * every `resource-manager` could decide every allocation (the gap-A §4.3
 * fallback). D replaces that with a real scope — the target's transitive
 * `managerId` chain UNION the managers of every org node above the target —
 * and keeps the role fallback ONLY for a resource with no manager anywhere.
 * §3.5 declares the breaking change: "chi oggi approva risorse che non
 * gestisce smetterà di poterlo fare".
 *
 * IDENTITIES — AND A FIXTURE THAT USED TO CERTIFY A FICTION (review round 4).
 * Header trust (AUTH_TRUST_HEADERS=true) resolves ROLE and IDENTITY through two
 * independent paths: `trustedRole` reads X-User-Role while `actorResourceId`
 * maps X-User-Id through the users directory. This section used to exploit that
 * by sending `X-User-Id: '1'` with a FORGED `X-User-Role: resource-manager` —
 * but seed user '1' (Julie) is a **delivery-executive**, and the only seeded
 * resource-manager is user '2' (John). So the green "the node manager decides"
 * check below proved a principal that DOES NOT EXIST in the directory, and it
 * masked the real defect: the node-manager grant was subordinated to the role
 * match, which made it inert for every actor whose global role was not
 * 'resource-manager' — i.e. for Julie, the actual Capability Leader of node
 * 'Engineering'. The fixture now uses her REAL role, which is exactly what the
 * fix makes work: being an accountable manager is an allow of its own
 * (design spec §3.4 rule 2), because the node's manager IS that profile and D
 * deliberately adds no new RBAC role.
 *
 * SEED FACTS this section leans on (asserted as preconditions below, so a
 * failure points at the rule and not at drifted seed data):
 *   - resource '3' (Alice) has managerId '2' (John), who has managerId '1'
 *     (Julie) -> Alice's scoped approvers are {'2','1'};
 *   - org node '2' 'Engineering' has managerId '1' -> anyone attached to
 *     Engineering (or to 'Platform'/'Backend' beneath it) is decidable by '1'
 *     even with NO org-chart link at all;
 *   - resource '4' (a dummy) is attached to 'Engineering' and has NO
 *     managerId -> its ONLY scoped approver is node manager '1';
 *   - resource '5' (a dummy) is attached to 'Consulting', which has no
 *     manager and no parent -> `roleFallback` is true and ANY
 *     resource-manager may still decide (this is what keeps C2's
 *     substitutions decidable).
 *
 * The PROPOSER is never one of the deciders, so a scope refusal can never be
 * masked by (or mistaken for) the segregation-of-duties 403 that sits above
 * the scope check in `decideOneApproval`.
 */
async function checkScopedAllocationDecision() {
  const PROPOSER = { 'X-User-Id': '3', 'X-User-Role': 'pm' };                // -> resource '3'
  // Resource '1' (Julie) with her REAL directory role: a delivery-executive who
  // is the manager of node '2' 'Engineering' and the top of the 3 -> 2 -> 1
  // chain. NO role forging — see the IDENTITIES note above.
  const MANAGER_1 = { 'X-User-Id': '1', 'X-User-Role': 'delivery-executive' };
  const MANAGER_2 = { 'X-User-Id': '2', 'X-User-Role': 'resource-manager' };  // -> resource '2' (John)
  // Maps to no user row, so `actorResourceId` falls back to the raw id: a
  // resource-manager who manages nobody and no node — the "stranger" of §3.5.
  const STRANGER = { 'X-User-Id': '99', 'X-User-Role': 'resource-manager' };
  // A role NO allocation step is ever routed to: refused for a different reason
  // than scope, and must keep saying so.
  const OTHER_ROLE = { 'X-User-Id': '98', 'X-User-Role': 'pm' };
  const ADMIN = { 'X-User-Id': '9', 'X-User-Role': 'admin' };

  const ALICE = '3';
  const DUMMY_ENGINEERING = '4';
  const DUMMY_CONSULTING = '5';

  // One month per approval: a month row can only be decided once, and reusing
  // ONE assignment across several months is what keeps this section's request
  // count down (each approval otherwise needs its own assignment).
  // All three months are Open in the seed (2026-04..2026-12) and every day
  // below is a Tuesday that is not a seeded holiday.
  const MONTHS = { a: '2026-10', b: '2026-11', c: '2026-12' };
  const DAYS = { '2026-10': '2026-10-06', '2026-11': '2026-11-03', '2026-12': '2026-12-01' };

  // --- Preconditions --------------------------------------------------------
  {
    const alice = await req('GET', `/resources/${ALICE}`);
    const john = await req('GET', '/resources/2');
    check(
      "D5 setup: the seeded chain 3 -> 2 -> 1 is intact (Alice's managerId is '2', John's is '1') — her scoped approvers are {'2','1'}",
      alice.status === 200 && alice.body?.managerId === '2' && john.status === 200 && john.body?.managerId === '1',
      `alice=${JSON.stringify(alice.body?.managerId)}, john=${JSON.stringify(john.body?.managerId)}`,
    );
    // The top of the chain, asserted as data: Julie has NO manager of her own
    // (Task 5 removed the seed's self-cycle), which is what makes the transitive
    // walk above terminate at her rather than at the traversal's `visited` set.
    const julie = await req('GET', '/resources/1');
    check(
      "D5 setup: resource '1' (Julie) is the top of the chain — no managerId at all, not a self-loop",
      julie.status === 200 && julie.body?.managerId === undefined,
      `status=${julie.status}, managerId=${JSON.stringify(julie.body?.managerId)}`,
    );
    const dummyEng = await req('GET', `/resources/${DUMMY_ENGINEERING}`);
    check(
      "D5 setup: resource '4' (dummy) is attached to 'Engineering' and has NO managerId",
      dummyEng.status === 200 && dummyEng.body?.organization === 'Engineering' && dummyEng.body?.managerId === undefined,
      `status=${dummyEng.status}, organization=${JSON.stringify(dummyEng.body?.organization)}, managerId=${JSON.stringify(dummyEng.body?.managerId)}`,
    );
    const dummyCon = await req('GET', `/resources/${DUMMY_CONSULTING}`);
    check(
      "D5 setup: resource '5' (dummy) is attached to 'Consulting' and has NO managerId",
      dummyCon.status === 200 && dummyCon.body?.organization === 'Consulting' && dummyCon.body?.managerId === undefined,
      `status=${dummyCon.status}, organization=${JSON.stringify(dummyCon.body?.organization)}, managerId=${JSON.stringify(dummyCon.body?.managerId)}`,
    );
    const { status, body } = await req('GET', '/resource-organizations');
    const nodes = Array.isArray(body) ? body : [];
    const engineering = nodes.find((n) => n.name === 'Engineering');
    const consulting = nodes.find((n) => n.name === 'Consulting');
    check(
      "D5 setup: org node 'Engineering' has managerId '1' and 'Consulting' has no manager and no parent",
      status === 200 && engineering?.managerId === '1' &&
      consulting !== undefined && consulting.managerId === undefined && consulting.parentId === undefined,
      `engineering=${JSON.stringify(engineering)}, consulting=${JSON.stringify(consulting)}`,
    );
  }

  // Shared parent request for every assignment below — one row, not one per case.
  const request = await req('POST', '/requests', {
    headers: PROPOSER,
    body: { name: 'D5 scoped-decision request', requiredRole: 'Developer', requiredEffort: 1, skills: [] },
  });
  const requestOk = check(
    'D5 setup: the shared parent request is created',
    request.status === 200 && typeof request.body?.id === 'string',
    `status=${request.status}, body=${JSON.stringify(request.body)}`,
  );
  if (!requestOk) return;

  /** One assignment per target resource, booked lazily per month below. */
  async function assignmentFor(resourceId) {
    const created = await req('POST', '/assignments', {
      headers: PROPOSER,
      body: { requestId: request.body.id, resourceId },
    });
    const ok = check(
      `D5 setup: assignment created for resource '${resourceId}'`,
      created.status === 200 && typeof created.body?.id === 'string',
      `status=${created.status}, body=${JSON.stringify(created.body)}`,
    );
    return ok ? created.body.id : undefined;
  }

  /**
   * Book one hour in `month` and submit it, returning the Pending approval id.
   * The PROPOSER is a `pm` who is nobody's manager here, so
   * `autoApprovesAllocation` is false and a REAL approval always opens.
   */
  async function openApproval(assignmentId, month) {
    const booked = await req('PUT', `/assignments/${assignmentId}/allocation`, {
      headers: PROPOSER,
      body: { month, dailyHours: { [DAYS[month]]: 1 } },
    });
    if (!check(
      `D5 setup: 1h booked on ${DAYS[month]} for assignment ${assignmentId}`,
      booked.status === 200,
      `status=${booked.status}, body=${JSON.stringify(booked.body)}`,
    )) return undefined;
    const submitted = await req('POST', `/assignments/${assignmentId}/months/${month}/submit`, {
      headers: PROPOSER, body: {},
    });
    const ok = check(
      `D5 setup: ${assignmentId}:${month} submitted -> 'Requested' with a real approvalId`,
      submitted.status === 200 && submitted.body?.status === 'Requested' && typeof submitted.body?.approvalId === 'string',
      `status=${submitted.status}, monthStatus=${submitted.body?.status}, approvalId=${submitted.body?.approvalId}`,
    );
    return ok ? submitted.body.approvalId : undefined;
  }

  /**
   * Decide `approvalId` as `headers` and assert the HTTP status — and, when
   * `errorRe` is given, the refusal MESSAGE too. The two 403s this rule can
   * produce are worded differently on purpose (out-of-scope vs a role the step
   * was never routed to), so asserting only the status would let the server
   * report the wrong reason and still pass.
   */
  async function decideAs(name, approvalId, headers, expected, errorRe) {
    if (approvalId === undefined) { check(name, false, 'no approval id (setup failed above)'); return; }
    const decided = await req('PUT', `/approval-requests/${approvalId}/decision`, {
      headers, body: { decision: 'Approved', note: 'D5 smoke' },
    });
    const messageOk = errorRe === undefined || errorRe.test(String(decided.body?.error));
    check(name, decided.status === expected && messageOk, `status=${decided.status}, body=${JSON.stringify(decided.body)}`);
  }

  // --- Alice ('3'): a real org-chart chain, 3 -> 2 -> 1 ---------------------
  const aliceAssignment = await assignmentFor(ALICE);
  if (aliceAssignment !== undefined) {
    // §3.4 rule 1 + rule 2: John IS the step's named approver AND is in scope.
    await decideAs(
      "D5 the resource's own manager decides in scope (Alice/'3' decided by '2') -> 200",
      await openApproval(aliceAssignment, MONTHS.a), MANAGER_2, 200,
    );
    // §3.4 rule 2 ALONE: Julie is NOT the step's `approverId` (that is '2') and
    // her role ('delivery-executive') matches no allocation step, so this can
    // only pass by her being ACCOUNTABLE via the TRANSITIVE chain 3 -> 2 -> 1.
    await decideAs(
      "D5 a transitive manager decides on the strength of the chain alone (Alice/'3' decided by '1', not the named approver, role not routed here) -> 200",
      await openApproval(aliceAssignment, MONTHS.b), MANAGER_1, 200,
    );
    // ONE approval, TWO refusals — a refused decision leaves the request
    // Pending, so the same month proves both messages against the same step.
    const strangerApprovalId = await openApproval(aliceAssignment, MONTHS.c);
    // (a) The UNCHANGED role/step refusal, on a step that really does carry an
    // `approverId`: a 'pm' holds neither 'resource-manager' nor the named
    // position, so the message names the approver — nothing to do with scope.
    await decideAs(
      "D5 a role the step was never routed to is refused with the role/step message (Alice/'3' decided by a pm) -> 403",
      strangerApprovalId, OTHER_ROLE, 403, /cannot decide a step assigned to 2/,
    );
    // (b) THE BREAKING CHANGE (§3.5): passes today via the role fallback, must
    // not — and must say WHY. The actor DOES hold 'resource-manager', so the
    // message above would misdescribe this refusal; it must not name the
    // resource or its managers either.
    await decideAs(
      "D5 a stranger resource-manager is refused with the SCOPE message (Alice/'3' decided by '99') -> 403",
      strangerApprovalId, STRANGER, 403, /does not manage this resource/,
    );
  }

  // --- Dummy in Engineering ('4'): no org-chart link, node manager only -----
  const dummyEngAssignment = await assignmentFor(DUMMY_ENGINEERING);
  if (dummyEngAssignment !== undefined) {
    // §3.4 rule 2 via the ORG TREE, AND THE REAL PRINCIPAL: '1' manages node
    // 'Engineering' and the dummy has no `managerId` at all, so the org chart
    // offers nothing here — the grant can ONLY come from the node. Her role is
    // her directory role ('delivery-executive'), which no allocation step is
    // routed to, so this check is the one that fails before the fix: the whole
    // point of rule 2 is that the Capability Leader does not need a global role.
    await decideAs(
      "D5 the node manager decides with no org-chart link and no routed role (dummy '4' in Engineering decided by Capability Leader '1') -> 200",
      await openApproval(dummyEngAssignment, MONTHS.a), MANAGER_1, 200,
    );
    // A REAL seeded resource-manager who manages neither the dummy nor any
    // node above it. Passes today via the role fallback, must not.
    await decideAs(
      "D5 a resource-manager outside the node's scope is refused with the SCOPE message (dummy '4' decided by '2') -> 403",
      await openApproval(dummyEngAssignment, MONTHS.b), MANAGER_2, 403, /does not manage this resource/,
    );
    // §3.3: `admin` is a global role and is never scoped.
    await decideAs(
      "D5 admin is unaffected by scope (dummy '4' decided by admin '9') -> 200",
      await openApproval(dummyEngAssignment, MONTHS.c), ADMIN, 200,
    );
  }

  // --- Dummy in Consulting ('5'): no manager ANYWHERE -> the last resort ----
  const dummyConAssignment = await assignmentFor(DUMMY_CONSULTING);
  if (dummyConAssignment !== undefined) {
    // §3.4 rule 3. This is the check that keeps C2's substitutions decidable:
    // it must stay GREEN across this change.
    await decideAs(
      "D5 the role fallback survives for a resource with no manager anywhere (dummy '5' decided by '99') -> 200",
      await openApproval(dummyConAssignment, MONTHS.b), STRANGER, 200,
    );
  }

  // --- Scope binds ALLOCATION only -----------------------------------------
  // Another kind routes by ROLE and has no target resource, so
  // `allocationTargetResourceId` returns undefined and the rule falls through
  // to the pre-D behaviour. A stranger resource-manager must still decide it.
  {
    const other = await req('POST', '/approval-requests', {
      headers: PROPOSER,
      body: { kind: 'TimeEntry', refId: 'D5-not-an-allocation' },
    });
    const otherOk = check(
      "D5 setup: a non-allocation ('TimeEntry') approval is created, routed to 'resource-manager'",
      other.status === 200 && typeof other.body?.id === 'string' && other.body?.steps?.[0]?.role === 'resource-manager',
      `status=${other.status}, body=${JSON.stringify(other.body)}`,
    );
    if (otherOk) {
      await decideAs(
        'D5 scope binds allocation only: a non-allocation approval still routes by role -> 200',
        other.body.id, STRANGER, 200,
      );
    }
  }
}

/**
 * D task 6 — THE SCOPED APPROVAL FEED (design spec §3.3).
 *
 * `GET /allocation-approvals` used to return every row to anyone holding one
 * of the feed's roles (src/server.ts:542), regardless of what
 * `decideOneApproval` (Task 5) would actually let them decide — offering a
 * manager rows whose buttons the server then refused, which reads as a
 * broken UI rather than as a permission boundary. This proves the feed now
 * mirrors the decision gate: a resource is visible when it is in the actor's
 * `scopeOf(...)`, OR when `scopedApproversOf(resource).roleFallback` is true
 * (nobody is accountable for it anywhere) — the second disjunct is what keeps
 * a no-manager-anywhere placeholder both VISIBLE and DECIDABLE, never one
 * without the other.
 *
 * REUSES the fixtures `checkScopedAllocationDecision` (Task 5, immediately
 * above) already created, rather than booking fresh ones: that section left
 * genuine assignment-month rows for MONTH '2026-11' on resource '3' (Alice —
 * decided, Allocated), resource '4' (the Engineering dummy — refused, still
 * Requested) and resource '5' (the Consulting dummy — decided, Allocated).
 * `status=all` on the feed query returns a row regardless of decided/pending
 * state, so all three show up under one `from=to='2026-11'` query with no new
 * bookings needed. This is WHY this section must run immediately after
 * `checkScopedAllocationDecision` and — like it — BEFORE
 * `checkResourceManagerCycle`, which permanently rewrites resource '3's
 * managerId and would break the chain both sections read.
 *
 * SEED FACTS this leans on (already asserted as preconditions in
 * `checkScopedAllocationDecision`, immediately above):
 *   - resource '3' (Alice) is reachable from resource-manager '2' (John) via
 *     the managerId chain 3 -> 2 — `scopeOf('2', ...)` is exactly {'3'}, since
 *     John manages no org-tree node.
 *   - resource '4' (a dummy attached to 'Engineering') is decidable ONLY by
 *     node-manager '1' (Julie), NOT by '2' — `scopedApproversOf('4').roleFallback`
 *     is FALSE (a real manager exists), so it is the genuine "outside scope,
 *     must be hidden" row for actor '2' and for a stranger alike.
 *   - resource '5' (a dummy attached to 'Consulting', which has no manager and
 *     no parent) has NO manager anywhere — `roleFallback` is TRUE — so it stays
 *     visible to EVERY resource-manager, including one who manages nobody.
 */
async function checkScopedApprovalFeed() {
  const MANAGER_2 = { 'X-User-Id': '2', 'X-User-Role': 'resource-manager' };            // -> resource '2' (John); scope = {'3'}
  const ADMIN = { 'X-User-Id': '9', 'X-User-Role': 'admin' };                            // global role — resourceId irrelevant
  const DELIVERY_EXECUTIVE = { 'X-User-Id': '1', 'X-User-Role': 'delivery-executive' };  // global role — resourceId irrelevant
  // Maps to no user row, so `actorResourceId` falls back to the raw id: a
  // resource-manager who manages NOBODY and no org node — scope = ∅.
  const STRANGER = { 'X-User-Id': '99', 'X-User-Role': 'resource-manager' };

  const FEED_PATH = '/allocation-approvals?from=2026-11&to=2026-11&status=all';
  const ALICE = '3';
  const DUMMY_ENGINEERING = '4';
  const DUMMY_CONSULTING = '5';

  /** The set of `resourceId`s carried by the feed's `rows`, or empty on a bad body. */
  const rowIds = (body) => new Set((Array.isArray(body?.rows) ? body.rows : []).map((r) => r.resourceId));
  const rowCount = (body) => (Array.isArray(body?.rows) ? body.rows.length : -1);

  // --- Check 1: a resource-manager sees their own scope, not more ----------
  const scoped = await req('GET', FEED_PATH, { headers: MANAGER_2 });
  const scopedIds = rowIds(scoped.body);
  check(
    "D6 the feed scopes to the actor: manager '2' sees resource '3' (in scope, 3 -> 2)",
    scoped.status === 200 && scopedIds.has(ALICE),
    `status=${scoped.status}, resourceIds=[${[...scopedIds].join(',')}]`,
  );
  check(
    "D6 the feed scopes to the actor: manager '2' does NOT see resource '4' (outside scope — a real manager exists elsewhere)",
    scoped.status === 200 && !scopedIds.has(DUMMY_ENGINEERING),
    `status=${scoped.status}, resourceIds=[${[...scopedIds].join(',')}]`,
  );

  // --- Check 2: admin's feed is unrestricted --------------------------------
  const asAdmin = await req('GET', FEED_PATH, { headers: ADMIN });
  const adminIds = rowIds(asAdmin.body);
  check(
    "D6 admin's feed is unrestricted: at least as many rows as the scoped call",
    asAdmin.status === 200 && rowCount(asAdmin.body) >= rowCount(scoped.body),
    `status=${asAdmin.status}, adminRows=${rowCount(asAdmin.body)}, scopedRows=${rowCount(scoped.body)}`,
  );
  check(
    "D6 admin's feed is unrestricted: includes resource '4', which the scoped manager could not see",
    asAdmin.status === 200 && adminIds.has(DUMMY_ENGINEERING),
    `status=${asAdmin.status}, resourceIds=[${[...adminIds].join(',')}]`,
  );

  // --- Check 3: delivery-executive's feed is unrestricted — a global oversight
  // role sees every row. It does NOT follow that they can decide every row: the
  // role is routed to no allocation step, so on the DECISION they get in only
  // where they are actually accountable for the resource (§3.4 rule 2 — see D5's
  // Capability-Leader check) or are the step's named approver. The feed being
  // wider than the decision is deliberate for the two global roles; do not "fix"
  // it into consistency.
  const asDE = await req('GET', FEED_PATH, { headers: DELIVERY_EXECUTIVE });
  const deIds = rowIds(asDE.body);
  check(
    "D6 delivery-executive's feed is unrestricted: at least as many rows as the scoped call",
    asDE.status === 200 && rowCount(asDE.body) >= rowCount(scoped.body),
    `status=${asDE.status}, deRows=${rowCount(asDE.body)}, scopedRows=${rowCount(scoped.body)}`,
  );
  check(
    "D6 delivery-executive's feed is unrestricted: includes resource '4' too",
    asDE.status === 200 && deIds.has(DUMMY_ENGINEERING),
    `status=${asDE.status}, resourceIds=[${[...deIds].join(',')}]`,
  );

  // --- Check 4: the decision fallback is mirrored in the feed ---------------
  // A resource-manager who manages NOBODY (not even resource '3') must still
  // see resource '5' — the fallback exists precisely so a no-manager-anywhere
  // row is never both invisible AND undecidable.
  const asStranger = await req('GET', FEED_PATH, { headers: STRANGER });
  const strangerIds = rowIds(asStranger.body);
  check(
    "D6 the decision fallback is mirrored in the feed: a resource-manager who manages nobody still sees resource '5' (no manager anywhere)",
    asStranger.status === 200 && strangerIds.has(DUMMY_CONSULTING),
    `status=${asStranger.status}, resourceIds=[${[...strangerIds].join(',')}]`,
  );
  check(
    "D6 the fallback stays narrow: the same stranger does NOT see resource '3' or '4' (both have a real accountable manager elsewhere)",
    asStranger.status === 200 && !strangerIds.has(ALICE) && !strangerIds.has(DUMMY_ENGINEERING),
    `status=${asStranger.status}, resourceIds=[${[...strangerIds].join(',')}]`,
  );
}

/**
 * D REVIEW ROUND 4 — THE ACCOUNTABLE-MANAGER RULES, the two cases the suite
 * could not see before.
 *
 * (A) CRITICAL #2 — the ORG-TREE half of the AUTO-APPROVAL shortcut.
 * `autoApprovesAllocation` exists so a manager's own submission never deadlocks:
 * segregation of duties forbids the requester from deciding their own approval,
 * so when the only competent approver IS the proposer, opening a real approval
 * strands the month. D widened the APPROVER set to node managers but not that
 * shortcut, so the mainline Practice Manager workflow — plan your practice's
 * placeholders, then confirm them — deadlocked: John's own decision 403s on SoD,
 * every other resource-manager 403s on scope, a delivery-executive 403s on role,
 * and only an admin can clear it. Worse, BOTH client mirrors showed John an
 * ENABLED Approve button, because they check the scope and cannot predict SoD.
 * The suite deliberately never made the proposer a decider, which is exactly
 * why this was outside its coverage.
 *
 * (C) THE RULE (A) CANNOT DISTINGUISH — the shortcut must fire only where a
 * deadlock is actually possible, i.e. where the node manager is the resource's
 * ONLY accountable approver. (A)'s target has no personal manager and no seeded
 * resource has both a personal manager and a managed node above it, so (A) is
 * equally consistent with "auto-approve whenever you manage a node above" — a
 * rule that would delete a working human review step wherever a direct people
 * manager exists, and would let a `pm` who manages a node self-approve across
 * their whole subtree. (C) is the fixture that pins which rule is intended.
 *
 * (B) CRITICAL #1, SECOND TRIGGER — a manager who has LEFT must not suppress
 * the role fallback. Nothing revisits a stored `managerId` when a
 * `terminationDate` is set and there is no `DELETE /resources`, so the stale id
 * stays in the structural approver set, keeps `roleFallback` false, and turns
 * the whole subtree beneath the departed manager admin-only — silently. The
 * CONTRAST case (an ACTIVE manager still refusing a stranger) is D5's
 * "a stranger resource-manager is refused with the SCOPE message" check, which
 * must stay green: this must widen who can decide only when nobody is left.
 *
 * ORDERING. Runs AFTER `checkScopedApprovalFeed` — case (A) temporarily makes
 * resource-manager '2' the manager of node '3' ('Consulting'), which would
 * otherwise destroy that section's `roleFallback` fixture on resource '5' — and
 * BEFORE `checkResourceManagerCycle`, which permanently rewrites resource '3'.
 * The node's manager is restored at the end of (A) either way.
 */
async function checkAccountableApproverRules() {
  const JOHN = { 'X-User-Id': '2', 'X-User-Role': 'resource-manager' };   // -> resource '2'
  const PROPOSER = { 'X-User-Id': '3', 'X-User-Role': 'pm' };             // -> resource '3'
  // Same principal as PROPOSER, named for the role it plays in (C): the DIRECT
  // people manager, who gets in as the step's named approver rather than by role.
  const ALICE = { 'X-User-Id': '3', 'X-User-Role': 'pm' };                // -> resource '3'
  // Maps to no user row, so `actorResourceId` falls back to the raw id: a
  // resource-manager who manages nobody and no node — the §3.5 "stranger".
  const STRANGER = { 'X-User-Id': '99', 'X-User-Role': 'resource-manager' };

  const CONSULTING_ID = '3';       // org node 'Consulting': no parent, no manager in the seed
  const DUMMY_CONSULTING = '5';    // attached to 'Consulting', NO personal managerId
  const MONTH = '2026-09';         // Open, and left Open by every earlier section
  const DAY_A = '2026-09-08';      // Tuesday, not a seeded holiday
  const DAY_B = '2026-09-15';      // Tuesday, not a seeded holiday
  const DAY_C = '2026-09-22';      // Tuesday, not a seeded holiday

  /** Book 1h in MONTH on `day` and submit it as `headers`; returns the month row. */
  async function bookAndSubmit(label, assignmentId, day, headers) {
    const booked = await req('PUT', `/assignments/${assignmentId}/allocation`, {
      headers, body: { month: MONTH, dailyHours: { [day]: 1 } },
    });
    if (!check(`${label}: 1h booked on ${day}`, booked.status === 200, `status=${booked.status}, body=${JSON.stringify(booked.body)}`)) {
      return undefined;
    }
    const submitted = await req('POST', `/assignments/${assignmentId}/months/${MONTH}/submit`, { headers, body: {} });
    return submitted;
  }

  // --- (A) the node manager's OWN submission auto-approves -------------------
  {
    const grant = await req('PUT', `/resource-organizations/${CONSULTING_ID}`, {
      headers: RBAC_HEADERS, body: { managerId: '2' },
    });
    const grantOk = check(
      "D-R4(A) setup: resource-manager '2' (John) is made the manager of node '3' ('Consulting') -> 200",
      grant.status === 200 && grant.body?.managerId === '2',
      `status=${grant.status}, body=${JSON.stringify(grant.body)}`,
    );
    const dummy = await req('GET', `/resources/${DUMMY_CONSULTING}`);
    const dummyOk = check(
      "D-R4(A) setup: resource '5' sits on 'Consulting' with NO personal managerId, so John is its ONLY accountable manager",
      dummy.status === 200 && dummy.body?.organization === 'Consulting' && dummy.body?.managerId === undefined,
      `status=${dummy.status}, organization=${JSON.stringify(dummy.body?.organization)}, managerId=${JSON.stringify(dummy.body?.managerId)}`,
    );
    if (grantOk && dummyOk) {
      const request = await req('POST', '/requests', {
        headers: JOHN,
        body: { name: 'D-R4 node-manager self-submission', requiredRole: 'Developer', requiredEffort: 1, skills: [] },
      });
      const assig = request.status === 200 && typeof request.body?.id === 'string'
        ? await req('POST', '/assignments', { headers: JOHN, body: { requestId: request.body.id, resourceId: DUMMY_CONSULTING } })
        : { status: 0, body: undefined };
      const setupOk = check(
        "D-R4(A) setup: John creates a request + an assignment on the placeholder he is accountable for",
        assig.status === 200 && typeof assig.body?.id === 'string',
        `request=${request.status}/${JSON.stringify(request.body?.id)}, assignment=${assig.status}/${JSON.stringify(assig.body)}`,
      );
      if (setupOk) {
        const submitted = await bookAndSubmit('D-R4(A) setup', assig.body.id, DAY_A, JOHN);
        check(
          "D-R4(A) a NODE manager's own submission auto-approves, exactly as a direct manager's does (month -> 'Allocated', no approval opened) -> 200",
          submitted !== undefined && submitted.status === 200 && submitted.body?.status === 'Allocated'
          && submitted.body?.approvalId === undefined,
          `status=${submitted?.status}, monthStatus=${submitted?.body?.status}, approvalId=${JSON.stringify(submitted?.body?.approvalId)}`,
        );
        // The DEADLOCK, asserted as data rather than inferred: if an approval
        // had opened, it would be Pending on this very month row, requested by
        // John, and nobody but an admin could ever decide it.
        const rowId = `${assig.body.id}:${MONTH}`;
        const approvals = await req('GET', '/approval-requests', { headers: RBAC_HEADERS });
        const stranded = (Array.isArray(approvals.body) ? approvals.body : [])
          .filter((a) => a.refId === rowId && a.status === 'Pending');
        check(
          'D-R4(A) no Pending approval is left on that month row — the SoD deadlock cannot form',
          approvals.status === 200 && stranded.length === 0,
          `status=${approvals.status}, stranded=${JSON.stringify(stranded)}`,
        );
      }
    }
    // --- (C) THE DISTINGUISHING CASE, run while John still manages the node ---
    // (A) above only proves the rule where the node manager is the resource's
    // ONLY accountable approver ('5' has no personal managerId — the fixture
    // says so explicitly), and NO seeded resource has both a personal manager
    // and a managed node above it. So (A) alone cannot tell "auto-approve when
    // you are the sole approver" from "auto-approve whenever you manage a node
    // above" — and the broad rule would have shipped on the narrow rule's
    // evidence. This is that missing fixture.
    //
    // A resource under 'Consulting' (so John, its node manager, is accountable)
    // that ALSO has a direct people manager, Alice ('3'). John submits. Before
    // this narrowing the month auto-approved and ALICE NEVER SAW IT: a working
    // human review step silently deleted, in a case that was never admin-only —
    // `allocationApproverStep` pins `approverId` to the direct manager, and she
    // faces neither an SoD conflict nor a scope refusal. Worst shape: a `pm` who
    // manages a node granting themselves unreviewed approval across their whole
    // subtree, having been unable to decide an allocation at all before D.
    if (grantOk) {
      const stamp = Date.now();
      const managed = await req('POST', '/resources', {
        headers: RBAC_HEADERS,
        body: {
          name: `D-R4 Has Both Managers ${stamp}`, role: 'Developer', kind: 'internal',
          skills: [], projectRoles: [], externalExperience: [],
          capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8,
          organization: 'Consulting', managerId: '3',
        },
      });
      const managedOk = check(
        "D-R4(C) setup: a resource under 'Consulting' (node manager John '2') that ALSO has a direct people manager, Alice '3'",
        managed.status === 201 && managed.body?.managerId === '3' && managed.body?.organization === 'Consulting',
        `status=${managed.status}, body=${JSON.stringify(managed.body)}`,
      );
      if (managedOk) {
        const request = await req('POST', '/requests', {
          headers: JOHN,
          body: { name: 'D-R4 node manager is not the only approver', requiredRole: 'Developer', requiredEffort: 1, skills: [] },
        });
        const assig = request.status === 200 && typeof request.body?.id === 'string'
          ? await req('POST', '/assignments', { headers: JOHN, body: { requestId: request.body.id, resourceId: managed.body.id } })
          : { status: 0, body: undefined };
        const setupOk = check(
          'D-R4(C) setup: John creates a request + an assignment on that resource',
          assig.status === 200 && typeof assig.body?.id === 'string',
          `request=${request.status}/${JSON.stringify(request.body?.id)}, assignment=${assig.status}/${JSON.stringify(assig.body)}`,
        );
        if (setupOk) {
          const submitted = await bookAndSubmit('D-R4(C) setup', assig.body.id, DAY_C, JOHN);
          const submitOk = check(
            "D-R4(C) a node manager who is NOT the only accountable approver does NOT auto-approve — a real approval opens, pinned to the direct manager '3'",
            submitted !== undefined && submitted.status === 200 && submitted.body?.status === 'Requested'
            && typeof submitted.body?.approvalId === 'string',
            `status=${submitted?.status}, monthStatus=${submitted?.body?.status}, approvalId=${JSON.stringify(submitted?.body?.approvalId)}`,
          );
          if (submitOk) {
            // There is no `GET /approval-requests/:id` — the collection is
            // list-only on the read side — so find it in the list.
            const list = await req('GET', '/approval-requests', { headers: RBAC_HEADERS });
            const ar = (Array.isArray(list.body) ? list.body : []).find((a) => a.id === submitted.body.approvalId);
            check(
              "D-R4(C) the approval really is routed to the direct people manager (step.approverId === '3'), which is why nothing was stranded",
              list.status === 200 && ar?.steps?.[0]?.approverId === '3' && ar?.requestedBy === '2',
              `status=${list.status}, approval=${JSON.stringify(ar)}`,
            );
            // ...and the review step actually WORKS: Alice decides it. Her role
            // is 'pm', which no allocation step is routed to — she gets in as the
            // step's NAMED approver, and SoD passes because John requested it.
            const decided = await req('PUT', `/approval-requests/${submitted.body.approvalId}/decision`, {
              headers: ALICE, body: { decision: 'Approved', note: 'D-R4(C) smoke' },
            });
            check(
              'D-R4(C) and the direct manager can still decide it -> 200 (the human review step the broad rule would have deleted)',
              decided.status === 200 && decided.body?.status === 'Approved',
              `status=${decided.status}, body=${JSON.stringify(decided.body)}`,
            );
          }
        }
      }
    }

    // RESTORE the seeded shape whatever happened above: resource '5' must go
    // back to having no accountable manager anywhere.
    const restore = await req('PUT', `/resource-organizations/${CONSULTING_ID}`, {
      headers: RBAC_HEADERS, body: { managerId: '' },
    });
    check(
      "D-R4(A) cleanup: node '3' ('Consulting') is detached from its manager again -> 200, managerId absent",
      restore.status === 200 && restore.body?.managerId === undefined,
      `status=${restore.status}, body=${JSON.stringify(restore.body)}`,
    );
  }

  // --- (B) a TERMINATED manager does not suppress the role fallback ---------
  {
    const stamp = Date.now();
    const departed = await req('POST', '/resources', {
      headers: RBAC_HEADERS,
      body: {
        name: `D-R4 Departed Manager ${stamp}`, role: 'Developer', kind: 'internal',
        skills: [], projectRoles: [], externalExperience: [],
        capacity: 40, hireDate: '2020-01-01', terminationDate: '2026-01-31', contractHoursPerDay: 8,
      },
    });
    const departedOk = check(
      'D-R4(B) setup: a manager whose contract ALREADY ended is created (terminationDate in the past)',
      departed.status === 201 && typeof departed.body?.id === 'string' && departed.body?.terminationDate === '2026-01-31',
      `status=${departed.status}, body=${JSON.stringify(departed.body)}`,
    );
    if (departedOk) {
      // NO `organization`: the org-tree axis must contribute nothing, so the
      // departed manager is the resource's ONLY structural approver.
      const orphan = await req('POST', '/resources', {
        headers: RBAC_HEADERS,
        body: {
          name: `D-R4 Orphaned Report ${stamp}`, role: 'Developer', kind: 'internal',
          skills: [], projectRoles: [], externalExperience: [],
          capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8, managerId: departed.body.id,
        },
      });
      const orphanOk = check(
        'D-R4(B) setup: a report whose ONLY manager is that departed person is created (no organization, so the org tree adds nobody)',
        orphan.status === 201 && orphan.body?.managerId === departed.body.id && orphan.body?.organization === undefined,
        `status=${orphan.status}, body=${JSON.stringify(orphan.body)}`,
      );
      if (orphanOk) {
        const request = await req('POST', '/requests', {
          headers: PROPOSER,
          body: { name: 'D-R4 terminated-manager fallback', requiredRole: 'Developer', requiredEffort: 1, skills: [] },
        });
        const assig = request.status === 200 && typeof request.body?.id === 'string'
          ? await req('POST', '/assignments', { headers: PROPOSER, body: { requestId: request.body.id, resourceId: orphan.body.id } })
          : { status: 0, body: undefined };
        const setupOk = check(
          'D-R4(B) setup: a request + assignment on that report, proposed by a pm who is nobody\'s manager',
          assig.status === 200 && typeof assig.body?.id === 'string',
          `request=${request.status}/${JSON.stringify(request.body?.id)}, assignment=${assig.status}/${JSON.stringify(assig.body)}`,
        );
        if (setupOk) {
          const submitted = await bookAndSubmit('D-R4(B) setup', assig.body.id, DAY_B, PROPOSER);
          const submitOk = check(
            "D-R4(B) setup: submit opens a REAL approval (the proposer is not accountable, so no auto-approval) -> 'Requested' + approvalId",
            submitted !== undefined && submitted.status === 200 && submitted.body?.status === 'Requested'
            && typeof submitted.body?.approvalId === 'string',
            `status=${submitted?.status}, monthStatus=${submitted?.body?.status}, approvalId=${JSON.stringify(submitted?.body?.approvalId)}`,
          );
          if (submitOk) {
            const decided = await req('PUT', `/approval-requests/${submitted.body.approvalId}/decision`, {
              headers: STRANGER, body: { decision: 'Approved', note: 'D-R4 smoke' },
            });
            check(
              'D-R4(B) a departed manager does not suppress the fallback: with nobody accountable left, any competent approver may decide -> 200',
              decided.status === 200,
              `status=${decided.status}, body=${JSON.stringify(decided.body)}`,
            );
          }
        }
      }
    }
  }
}

/**
 * /self/* — P0-02 and P0-05, the two release blockers this suite could not see.
 *
 * WHY THIS EXISTS. Before this section the suite had 448 req(...) assertions and
 * not one touched /self/*. P0-05's server-side field whitelist and P0-02's
 * create-and-submit were verified by READING the code; P0-02's issue text asks
 * explicitly for an end-to-end test. self-service.util.spec.ts covers the pure
 * helpers, which cannot see the wiring: whether the route exists, whether the
 * whitelist is actually applied to the request body, whether the target id is
 * really taken from the principal rather than the payload.
 *
 * Identity: X-User-Id '2' maps through the seeded user directory to resource '2'
 * (John Miller). Every assertion below is about resource '2' NEVER being able to
 * name another resource, and about rate fields never crossing the boundary in
 * either direction.
 *
 * Restores every profile field it touches.
 */
async function checkSelfService() {
  const SELF = { 'X-User-Id': '2', 'X-User-Role': 'employee' };
  const SELF_RESOURCE = '2';

  // --- P0-05 READ: rate data must not cross the boundary --------------------
  const profile = await req('GET', '/self/profile', { headers: SELF });
  const profileOk = check(
    'GET /self/profile -> 200 for the signed-in resource (never a client-named id)',
    profile.status === 200 && profile.body?.id === SELF_RESOURCE,
    `status=${profile.status} id=${profile.body?.id}`,
  );
  if (!profileOk) return;

  const RATE_FIELDS = ['costRate', 'billRate', 'costRateOverride', 'billRateOverride', 'costRateDay', 'billRateDay'];
  const leaked = RATE_FIELDS.filter(field => field in (profile.body ?? {}));
  check(
    'GET /self/profile strips every rate field (P0-05 read side)',
    leaked.length === 0,
    leaked.length ? `leaked=${leaked.join(',')}` : 'none of the 6 present',
  );
  // The SAME resource read through the privileged collection DOES carry them —
  // otherwise the assertion above could pass because the seed has no rates.
  const asAdmin = await req('GET', `/resources/${SELF_RESOURCE}`);
  check(
    'control: the privileged /resources view of the same row DOES carry a billRate',
    asAdmin.status === 200 && typeof asAdmin.body?.billRate === 'number',
    `status=${asAdmin.status} billRate=${asAdmin.body?.billRate}`,
  );

  // --- P0-05 WRITE: the whitelist ------------------------------------------
  const before = asAdmin.body;
  // The resource the escalating body NAMES, captured before the write. Compared
  // field-by-field afterwards rather than probed for a sentinel value: resource 1
  // already seeds 'Senior Developer', so a `not.toContain` there would pass for
  // the wrong reason.
  const namedVictimBefore = (await req('GET', '/resources/1')).body;
  const escalation = await req('PUT', '/self/profile', {
    headers: SELF,
    body: {
      // The one allowed field, so the request is a legitimate profile edit...
      projectRoles: ['Senior Developer'],
      // ...carrying every escalation the whitelist must drop.
      id: '1',
      resourceId: '1',
      costRate: 1, billRate: 9999, costRateOverride: 1, billRateOverride: 9999,
      costRateDay: 1, billRateDay: 9999,
      managerId: '3', resourceOrganizationId: 'ORG-9', capacity: 999,
      kind: 'dummy', vendorId: 'V1', role: 'admin', utilization: 1,
      hireDate: '1999-01-01', terminationDate: '1999-12-31', contractHoursPerDay: 24,
    },
  });
  check('PUT /self/profile with an escalating body -> 200 (the allowed field applies)', escalation.status === 200, `status=${escalation.status} error=${escalation.body?.error ?? ''}`);
  check(
    'PUT /self/profile applied the whitelisted field',
    Array.isArray(escalation.body?.projectRoles) && escalation.body.projectRoles.includes('Senior Developer'),
    `projectRoles=${JSON.stringify(escalation.body?.projectRoles)}`,
  );

  const after = await req('GET', `/resources/${SELF_RESOURCE}`);
  const changed = [
    'costRate', 'billRate', 'costRateOverride', 'billRateOverride', 'costRateDay', 'billRateDay',
    'managerId', 'resourceOrganizationId', 'capacity', 'kind', 'vendorId', 'role', 'utilization',
    'hireDate', 'terminationDate', 'contractHoursPerDay',
  ].filter(field => JSON.stringify(after.body?.[field]) !== JSON.stringify(before?.[field]));
  check(
    'PUT /self/profile changed NONE of the 16 privileged fields it was handed (P0-05 write side)',
    changed.length === 0,
    changed.length ? `mutated=${changed.join(',')}` : 'all unchanged',
  );
  // And it did not write to the resource the body NAMED instead of the principal.
  const namedVictimAfter = (await req('GET', '/resources/1')).body;
  check(
    'PUT /self/profile ignored the body\'s id/resourceId and left resource 1 byte-identical',
    JSON.stringify(namedVictimAfter) === JSON.stringify(namedVictimBefore),
    `before=${JSON.stringify(namedVictimBefore?.projectRoles)} after=${JSON.stringify(namedVictimAfter?.projectRoles)}`,
  );
  // Restore.
  await req('PUT', '/self/profile', { headers: SELF, body: { projectRoles: before?.projectRoles ?? [] } });

  // --- Fail-closed: no principal, and a principal with no resource ---------
  const anonymous = await req('GET', '/self/profile', { headers: { 'X-User-Id': '', 'X-User-Role': '' } });
  check('GET /self/profile with no application role -> 401/403, never a default resource', anonymous.status === 401 || anonymous.status === 403, `status=${anonymous.status}`);
  const unlinked = await req('GET', '/self/profile', { headers: { 'X-User-Id': 'nobody-in-the-directory', 'X-User-Role': 'employee' } });
  check(
    'GET /self/profile for an identity that maps to NO resource -> 403 (never resource 1)',
    unlinked.status === 403,
    `status=${unlinked.status} body=${JSON.stringify(unlinked.body)}`,
  );

  // --- Self-scoped collections --------------------------------------------
  const assignments = await req('GET', '/self/assignments', { headers: SELF });
  check(
    'GET /self/assignments returns ONLY the signed-in resource\'s assignments',
    assignments.status === 200 && Array.isArray(assignments.body)
      && assignments.body.every(a => a.resourceId === SELF_RESOURCE),
    `status=${assignments.status} resourceIds=${JSON.stringify([...new Set((assignments.body || []).map(a => a.resourceId))])}`,
  );
  const selfEntriesBefore = await req('GET', '/self/time-entries', { headers: SELF });
  check(
    'GET /self/time-entries returns ONLY the signed-in resource\'s entries',
    selfEntriesBefore.status === 200 && (selfEntriesBefore.body || []).every(e => e.resourceId === SELF_RESOURCE),
    `status=${selfEntriesBefore.status} resourceIds=${JSON.stringify([...new Set((selfEntriesBefore.body || []).map(e => e.resourceId))])}`,
  );

  // --- P0-02: create-and-submit, end to end -------------------------------
  const ownAssignment = (assignments.body || [])[0];
  if (!check('P0-02 setup: the signed-in resource has at least one assignment', Boolean(ownAssignment), `assignments=${(assignments.body || []).length}`)) return;

  const KEY = '9f1c2b7e-4d3a-4c5b-9e8f-0a1b2c3d4e5f';
  const DATE = '2026-06-16';
  const submitted = await req('POST', '/self/time-entries', {
    headers: SELF,
    body: { assignmentId: ownAssignment.id, date: DATE, hours: 3, notes: 'smoke self-service', idempotencyKey: KEY, status: 'Approved', resourceId: '1', projectId: 'P9' },
  });
  check(
    'POST /self/time-entries -> 201 Submitted in ONE call (P0-02: never left as a Draft)',
    submitted.status === 201 && submitted.body?.status === 'Submitted',
    `status=${submitted.status} entryStatus=${submitted.body?.status} error=${submitted.body?.error ?? ''}`,
  );
  check(
    'POST /self/time-entries pins resourceId/projectId server-side and ignores a client status',
    submitted.body?.resourceId === SELF_RESOURCE && submitted.body?.projectId !== 'P9' && submitted.body?.status === 'Submitted',
    `resourceId=${submitted.body?.resourceId} projectId=${submitted.body?.projectId} status=${submitted.body?.status}`,
  );

  // IDEMPOTENCY (P1-21): the same key must return the same row, not a second one.
  const countFor = async () => {
    const list = await req('GET', '/self/time-entries', { headers: SELF });
    return (list.body || []).filter(e => e.date === DATE && e.assignmentId === ownAssignment.id).length;
  };
  const afterFirst = await countFor();
  const replay = await req('POST', '/self/time-entries', {
    headers: SELF,
    body: { assignmentId: ownAssignment.id, date: DATE, hours: 3, notes: 'smoke self-service', idempotencyKey: KEY },
  });
  const afterReplay = await countFor();
  check(
    'POST /self/time-entries replayed with the SAME idempotencyKey -> 200, same id, NO duplicate',
    replay.status === 200 && replay.body?.id === submitted.body?.id && afterReplay === afterFirst,
    `status=${replay.status} id=${replay.body?.id} expected=${submitted.body?.id} count ${afterFirst}->${afterReplay}`,
  );
  const reused = await req('POST', '/self/time-entries', {
    headers: SELF,
    body: { assignmentId: ownAssignment.id, date: DATE, hours: 7, idempotencyKey: KEY },
  });
  check(
    'POST /self/time-entries reusing a key for DIFFERENT hours -> 409 (a lost submission is not hidden)',
    reused.status === 409,
    `status=${reused.status} error=${reused.body?.error ?? ''}`,
  );
  const badKey = await req('POST', '/self/time-entries', {
    headers: SELF,
    body: { assignmentId: ownAssignment.id, date: DATE, hours: 1, idempotencyKey: '../../etc/passwd' },
  });
  check('POST /self/time-entries with a malformed idempotencyKey -> 400', badKey.status === 400, `status=${badKey.status} error=${badKey.body?.error ?? ''}`);

  // Someone else's assignment must be refused even with a valid own principal.
  const foreign = (await req('GET', '/assignments')).body?.find(a => a.resourceId !== SELF_RESOURCE);
  if (foreign) {
    const stolen = await req('POST', '/self/time-entries', {
      headers: SELF,
      body: { assignmentId: foreign.id, date: DATE, hours: 1 },
    });
    check(
      "POST /self/time-entries against another resource's assignment -> 403",
      stolen.status === 403,
      `status=${stolen.status} error=${stolen.body?.error ?? ''}`,
    );
  }

  await req('DELETE', `/time-entries/${submitted.body?.id}`);
}

/**
 * THE RETARGET DOOR AROUND THE PER-DAY CAPACITY GATE.
 *
 * `AssignmentDay` carries only assignmentId, so day rows travel wholesale when
 * an assignment's resourceId changes. Narrowing `assignmentRetargetError` to
 * `hasTimeEntries` dropped the only thing standing between that move and a
 * resource booked over its daily cap — and `clampUtil` then stores 200% as 100,
 * so the result is invisible in every view. The unit spec even asserted the move
 * was allowed WITH day rows present, i.e. it certified the hole.
 *
 * The sequence below is the one from the review, run against the live API:
 *   1. book 8h on one day for A1 -> Alice   (200)
 *   2. book 8h on the SAME day for A2 -> Bob (200)
 *   3. retarget A1 to Bob                    (must be 400, was 200)
 * The same 16h through PUT /assignments/:id/allocation is a 400, so the retarget
 * door must not be a 200. Check 4 proves the guard is not simply "refuse every
 * retarget that has day rows": the same move onto a free day succeeds.
 *
 * Resources '1' (Julie, 8h/day) and '2' (John, 8h/day) are seeded internal
 * one-FTE people. Uses a far-future month no other section books, and deletes
 * both assignments afterwards.
 */
async function checkRetargetDailyCapacity() {
  const CALLER_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };
  const ALICE = '1';
  const BOB = '2';
  const REQUEST_ID = '2';
  // 2026-10 is an Open planning period (seed opens 2026-04..2026-12) that NEITHER
  // resource books in the seed, and no other section touches. Both days are
  // Tuesdays; the only seeded holidays are 2026-12-25 and 2026-01-01.
  const MONTH = '2026-10';
  const DAY = `${MONTH}-06`;       // Tuesday
  const FREE_DAY = `${MONTH}-13`;  // Tuesday, one week later

  const a1 = await req('POST', '/assignments', { headers: CALLER_HEADERS, body: { requestId: REQUEST_ID, resourceId: ALICE } });
  const a2 = await req('POST', '/assignments', { headers: CALLER_HEADERS, body: { requestId: REQUEST_ID, resourceId: BOB } });
  const setupOk = check(
    'retarget-capacity setup: two assignments created (one per resource) -> 200',
    a1.status === 200 && a2.status === 200 && typeof a1.body?.id === 'string' && typeof a2.body?.id === 'string',
    `a1=${a1.status} a2=${a2.status}`,
  );
  if (!setupOk) return;
  const a1Id = a1.body.id;
  const a2Id = a2.body.id;

  const bookA1 = await req('PUT', `/assignments/${a1Id}/allocation`, { headers: CALLER_HEADERS, body: { month: MONTH, dailyHours: { [DAY]: 8 } } });
  const bookA2 = await req('PUT', `/assignments/${a2Id}/allocation`, { headers: CALLER_HEADERS, body: { month: MONTH, dailyHours: { [DAY]: 8 } } });
  check(
    `retarget-capacity setup: both resources booked to their full 8h cap on ${DAY} -> 200`,
    bookA1.status === 200 && bookA2.status === 200,
    `a1=${bookA1.status} ${JSON.stringify(bookA1.body)} a2=${bookA2.status} ${JSON.stringify(bookA2.body)}`,
  );

  // The control: the same 16h asked for through the allocation endpoint is a 400.
  const viaAllocation = await req('PUT', `/assignments/${a2Id}/allocation`, { headers: CALLER_HEADERS, body: { month: MONTH, dailyHours: { [DAY]: 16 } } });
  check(
    'control: 16h on one day through PUT .../allocation -> 400 (daily capacity)',
    viaAllocation.status === 400,
    `status=${viaAllocation.status} error=${viaAllocation.body?.error ?? ''}`,
  );

  // THE DOOR: the identical end state reached by retargeting instead.
  const retarget = await req('PUT', `/assignments/${a1Id}`, { headers: CALLER_HEADERS, body: { resourceId: BOB } });
  check(
    'PUT /assignments/:id {resourceId} that would double the target\'s day -> 400',
    retarget.status === 400 && String(retarget.body?.error ?? '').includes('daily capacity'),
    `status=${retarget.status} error=${retarget.body?.error ?? ''}`,
  );

  // And the refusal wrote nothing: the assignment still belongs to Alice.
  const afterRefusal = await req('GET', '/assignments', { headers: CALLER_HEADERS });
  const a1After = (afterRefusal.body || []).find(a => a.id === a1Id);
  check(
    'the refused retarget left the assignment on the original resource',
    a1After?.resourceId === ALICE,
    `resourceId=${a1After?.resourceId}`,
  );

  // NOT a blanket refusal of day-bearing retargets: move A1's booking to a day
  // Bob has free, then the same retarget must succeed.
  const rebook = await req('PUT', `/assignments/${a1Id}/allocation`, { headers: CALLER_HEADERS, body: { month: MONTH, dailyHours: { [DAY]: 0, [FREE_DAY]: 8 } } });
  check('retarget-capacity: A1 rebooked onto a day the target has free -> 200', rebook.status === 200, `status=${rebook.status} ${JSON.stringify(rebook.body)}`);
  const retargetOk = await req('PUT', `/assignments/${a1Id}`, { headers: CALLER_HEADERS, body: { resourceId: BOB } });
  check(
    'PUT /assignments/:id {resourceId} that FITS the target\'s cap -> 200 (the guard is per-day, not per-assignment)',
    retargetOk.status === 200 && retargetOk.body?.resourceId === BOB,
    `status=${retargetOk.status} resourceId=${retargetOk.body?.resourceId} error=${retargetOk.body?.error ?? ''}`,
  );

  await req('DELETE', `/assignments/${a1Id}`, { headers: CALLER_HEADERS });
  await req('DELETE', `/assignments/${a2Id}`, { headers: CALLER_HEADERS });
}

/**
 * INVOICE -> PAYMENT LIFECYCLE, both records, end to end.
 *
 * WHY THIS EXISTS. `markBillingInvoicePaid` shipped with three passing unit
 * tests and no import: no route reached it, so the client kept PUTting only the
 * billing item and every linked customer order stayed 'Invoiced' forever. Unit
 * tests could not see that — only the live wiring can. Every check below is an
 * assertion about the ORDER as much as about the billing item.
 *
 * Uses contract CT1 / project '1' (Fixed-Price, no negotiated rate) and cleans
 * up everything it creates, so it is order-independent.
 */
async function checkBillingPaymentLifecycle() {
  const CONTRACT = 'CT1';
  const PROJECT = '1';

  const created = await req('POST', '/billing-plan-items', {
    body: {
      contractId: CONTRACT, projectId: PROJECT, type: 'Advance',
      label: 'Smoke payment lifecycle', amount: 1234.5, currency: 'EUR',
      status: 'Ready', expectedDate: '2026-09-30', paymentTermsDays: 30,
    },
  });
  if (!check('POST /api/billing-plan-items (payment lifecycle setup) -> 200', created.status === 200, `status=${created.status} error=${created.body?.error ?? ''}`)) return;
  const itemId = created.body.id;

  // A Ready item has no invoice yet, so payment is not a legal transition. 409,
  // not a silent success that would move the Paid KPI with no invoice behind it.
  const early = await req('POST', `/billing-plan-items/${itemId}/mark-paid`, { body: { paidDate: '2026-10-01' } });
  check(
    'POST /billing-plan-items/:id/mark-paid before any invoice -> 409',
    early.status === 409,
    `status=${early.status} error=${early.body?.error ?? ''}`,
  );

  const invoiced = await req('POST', `/billing-plan-items/${itemId}/generate-invoice`, { body: { issuedDate: '2026-09-30' } });
  const orderId = invoiced.body?.order?.id;
  check(
    'POST /billing-plan-items/:id/generate-invoice -> 200 with an Invoiced customer order',
    invoiced.status === 200
      && invoiced.body?.billingItem?.status === 'Invoiced'
      && invoiced.body?.order?.status === 'Invoiced'
      && invoiced.body?.order?.type === 'Customer'
      && typeof invoiced.body?.order?.invoiceNumber === 'string',
    `status=${invoiced.status} item=${invoiced.body?.billingItem?.status} order=${invoiced.body?.order?.status} invoiceNumber=${invoiced.body?.order?.invoiceNumber}`,
  );

  // THE GUARD: 'Paid' is owned by the operation that also writes the order.
  // Before it, this PUT succeeded and BILLED_STATUSES counted the row as billed
  // with the order still outstanding.
  const forgedPaid = await req('PUT', `/billing-plan-items/${itemId}`, { body: { status: 'Paid', paidDate: '2026-10-01' } });
  check(
    'PUT /billing-plan-items/:id {status:Paid} -> 409 (server-owned transition)',
    forgedPaid.status === 409,
    `status=${forgedPaid.status} error=${forgedPaid.body?.error ?? ''}`,
  );
  const afterForged = await req('GET', '/billing-plan-items');
  const stillInvoiced = (afterForged.body || []).find(i => i.id === itemId);
  check(
    'the refused PUT left the item Invoiced, not Paid',
    stillInvoiced?.status === 'Invoiced',
    `status=${stillInvoiced?.status}`,
  );

  // A field update that re-sends the status the item already has must still work
  // (the edit form re-PUTs every field).
  const benignPut = await req('PUT', `/billing-plan-items/${itemId}`, { body: { status: 'Invoiced', label: 'Smoke payment lifecycle (edited)' } });
  check(
    'PUT /billing-plan-items/:id re-sending the CURRENT status -> 200',
    benignPut.status === 200 && benignPut.body?.label === 'Smoke payment lifecycle (edited)',
    `status=${benignPut.status} label=${benignPut.body?.label}`,
  );

  const paid = await req('POST', `/billing-plan-items/${itemId}/mark-paid`, { body: { paidDate: '2026-10-01' } });
  check(
    'POST /billing-plan-items/:id/mark-paid -> 200 and moves BOTH records to Paid',
    paid.status === 200
      && paid.body?.billingItem?.status === 'Paid'
      && paid.body?.billingItem?.paidDate === '2026-10-01'
      && paid.body?.order?.status === 'Paid'
      && paid.body?.replayed === false,
    `status=${paid.status} item=${paid.body?.billingItem?.status} paidDate=${paid.body?.billingItem?.paidDate} order=${paid.body?.order?.status} replayed=${paid.body?.replayed}`,
  );

  // The order is the half the old client-side write never touched. Read it back
  // from its own collection, not from the operation's response envelope.
  const orders = await req('GET', '/orders');
  const storedOrder = (orders.body || []).find(o => o.id === orderId);
  check(
    'GET /orders shows the linked customer order as Paid',
    storedOrder?.status === 'Paid',
    `orderId=${orderId} status=${storedOrder?.status}`,
  );

  // Idempotent by STATE: a retry after a lost response must not 409, and must
  // not overwrite the recorded payment date.
  const replay = await req('POST', `/billing-plan-items/${itemId}/mark-paid`, { body: { paidDate: '2026-11-15' } });
  check(
    'POST /billing-plan-items/:id/mark-paid twice -> 200 replayed, paidDate unchanged',
    replay.status === 200 && replay.body?.replayed === true && replay.body?.billingItem?.paidDate === '2026-10-01',
    `status=${replay.status} replayed=${replay.body?.replayed} paidDate=${replay.body?.billingItem?.paidDate}`,
  );

  // Cleanup: generated order line, billing item, generated order.
  const lines = await req('GET', '/order-lines');
  for (const line of (lines.body || []).filter(l => l.orderId === orderId)) {
    await req('DELETE', `/order-lines/${line.id}`);
  }
  await req('DELETE', `/billing-plan-items/${itemId}`);
  if (orderId) await req('DELETE', `/orders/${orderId}`);
}

/**
 * D task 4 — refuse a `Resource.managerId` assignment that would close a
 * cycle in the ORG CHART (distinct from the ORG TREE cycle guard exercised
 * above — see org-scope.util's module doc for the two axes). Uses
 * `wouldCycleInOrgChart` (src/app/services/org-scope.util.ts), which is
 * already unit-tested directly; this is the live-API wiring.
 *
 * Leans on the SEEDED chain 3 -> 2 -> 1: Alice Smith ('3') has managerId '2'
 * (John Miller), who has managerId '1' (Julie Armstrong). Resource '1' is the
 * TOP and has no managerId at all.
 *
 * HISTORY (Task 5): resource '1' used to seed with `managerId: '1'` — herself,
 * a self-loop shipped as demo data, i.e. exactly the write check 1 below
 * refuses. It was removed from the seed rather than tolerated: "the read side
 * survives a cycle in the data" is proven by unit tests over synthetic input
 * (org-scope.util.spec), and a fixture that can only be produced by illegal
 * data is a fixture that stops meaning anything the day the data is fixed.
 * Checks 2 and 3 below were re-actored accordingly, with their assertions
 * intact.
 *
 * MUST RUN LAST in main(): check 3 below permanently clears resource '3's
 * managerId for the rest of THIS server process, which breaks the 3 -> 2 -> 1
 * chain every earlier section reads. Nothing in this file may run after this
 * function within the same process; per the suite's own restart discipline
 * (see the file header) that is expected, not a bug.
 */
async function checkResourceManagerCycle() {
  const RESOURCE_1 = '1'; // Julie Armstrong — the TOP of the chain, no managerId.
  const RESOURCE_2 = '2'; // John Miller — seeded managerId '1'.
  const RESOURCE_3 = '3'; // Alice Smith — seeded managerId '2'.

  // Setup/precondition: confirm the chain this whole function leans on is
  // still what the seed data promises, so a failure below points at the
  // guard, not at drifted seed data.
  {
    const { status, body } = await req('GET', `/resources/${RESOURCE_3}`);
    check(
      "setup: seeded resource '3' (Alice Smith) has managerId '2' (John Miller), as this section assumes",
      status === 200 && body?.managerId === RESOURCE_2,
      `status=${status}, managerId=${JSON.stringify(body?.managerId)}`,
    );
    const top = await req('GET', `/resources/${RESOURCE_1}`);
    check(
      "setup: seeded resource '1' (Julie Armstrong) is the TOP of the chain and has NO managerId",
      top.status === 200 && top.body?.managerId === undefined,
      `status=${top.status}, managerId=${JSON.stringify(top.body?.managerId)}`,
    );
  }

  // 1) Self-management -> 400 mentioning a cycle. Pre-implementation this was
  // ACCEPTED (200) — nothing stopped a resource naming itself its own manager,
  // which is how the seed came to carry exactly this shape on resource '1'
  // until Task 5 removed it (see the note above).
  {
    const self = await req('PUT', `/resources/${RESOURCE_1}`, {
      headers: RBAC_HEADERS,
      body: { managerId: RESOURCE_1 },
    });
    check(
      "PUT /api/resources/1 {managerId:'1'} (itself) -> 400, mentions a cycle",
      self.status === 400 && typeof self.body?.error === 'string' && /cycle/i.test(self.body.error),
      `status=${self.status}, body=${JSON.stringify(self.body)}`,
    );
  }

  // 2) A longer cycle: seeded 3 -> 2 -> 1, closed by making '1' report to
  // '3' (1 -> 3 -> 2 -> 1). Pre-implementation this is ALSO accepted (200) —
  // nothing today walks the manager chain before writing it. (Review round 1,
  // minor: now asserts /cycle/i on the message too, matching check 1's
  // discipline — a bare 400 could previously have passed on a coincidental,
  // unrelated rejection.)
  {
    const closeLoop = await req('PUT', `/resources/${RESOURCE_1}`, {
      headers: RBAC_HEADERS,
      body: { managerId: RESOURCE_3 },
    });
    check(
      "PUT /api/resources/1 {managerId:'3'} -> 400 (would close 1 -> 3 -> 2 -> 1), mentions a cycle",
      closeLoop.status === 400 && typeof closeLoop.body?.error === 'string' && /cycle/i.test(closeLoop.body.error),
      `status=${closeLoop.status}, body=${JSON.stringify(closeLoop.body)}`,
    );
    // Not just the status — confirm the refused PUT wrote NOTHING. Resource '1'
    // is the top of the chain, so "nothing" means still no managerId at all.
    const { status, body } = await req('GET', `/resources/${RESOURCE_1}`);
    check(
      'GET /api/resources/1 still has NO managerId after the refused PUT (the refusal wrote nothing)',
      status === 200 && body?.managerId === undefined,
      `status=${status}, managerId=${JSON.stringify(body?.managerId)}`,
    );
  }

  // 2b) THE SAME "a refusal writes nothing" PROOF, on a resource that carries a
  // REAL managerId — so the witness is a value that survived, not an absence
  // that would look identical whether the guard wrote or not. This is what
  // check 2's re-read used to give while resource '1' still carried the seed's
  // self-loop; with that gone, the observable-unchanged case needs a resource
  // that genuinely has a manager. Alice ('3') self-targeting is refused by the
  // same guard, and her seeded managerId '2' must be exactly as it was.
  {
    const selfAlice = await req('PUT', `/resources/${RESOURCE_3}`, {
      headers: RBAC_HEADERS,
      body: { managerId: RESOURCE_3 },
    });
    check(
      "PUT /api/resources/3 {managerId:'3'} (itself) -> 400, mentions a cycle",
      selfAlice.status === 400 && typeof selfAlice.body?.error === 'string' && /cycle/i.test(selfAlice.body.error),
      `status=${selfAlice.status}, body=${JSON.stringify(selfAlice.body)}`,
    );
    const { status, body } = await req('GET', `/resources/${RESOURCE_3}`);
    check(
      "GET /api/resources/3 shows managerId UNCHANGED ('2') after the refused PUT",
      status === 200 && body?.managerId === RESOURCE_2,
      `status=${status}, managerId=${JSON.stringify(body?.managerId)}`,
    );
  }

  // 3) THE CLEAR-TO-ABSENT SEAM for the Resource entity's OWN managerId
  // (distinct from the org-tree NODE's managerId proven in check 9b above) —
  // '' must clear a REAL managerId to absent, identically on both adapters,
  // and must NEVER be refused as a cycle (a cleared manager has no manager
  // to close a loop with). This is expected to ALREADY PASS pre-implementation
  // (no cycle-guard code path can reject it), unlike checks 1-2 — its job is to
  // prove the new guard doesn't regress the clear-to-absent write once it
  // exists, not to prove new rejection behavior.
  //
  // Runs on Alice ('3'), whose seeded managerId '2' is a REAL value: the
  // assertion folds in that precondition, so "cleared" cannot pass on a field
  // that was empty to begin with. It used to run on resource '1', which only had
  // a value to clear because of the seed's self-loop — clearing an already-absent
  // field would still have returned 200 and asserted nothing. Sequenced AFTER
  // every cycle check above, since it breaks the 3 -> 2 -> 1 chain those use.
  {
    const before = await req('GET', `/resources/${RESOURCE_3}`);
    const cleared = await req('PUT', `/resources/${RESOURCE_3}`, {
      headers: RBAC_HEADERS,
      body: { managerId: '' },
    });
    check(
      "PUT /api/resources/3 {managerId:''} -> 200, clears a REAL managerId to absent",
      before.body?.managerId === RESOURCE_2 && cleared.status === 200 && cleared.body !== undefined && !('managerId' in cleared.body),
      `preManagerId=${JSON.stringify(before.body?.managerId)}, status=${cleared.status}, body=${JSON.stringify(cleared.body)}`,
    );
    // Re-confirm via a FRESH GET, not just the PUT's own echoed response —
    // the point of this seam is that it persists identically on both adapters.
    const reread = await req('GET', `/resources/${RESOURCE_3}`);
    check(
      'GET /api/resources/3 reflects managerId absent on re-read',
      reread.status === 200 && !('managerId' in (reread.body || {})),
      `status=${reread.status}, body=${JSON.stringify(reread.body)}`,
    );
  }

  // 4) REGRESSION GUARD, not part of the task-4 brief's three required
  // checks: proves the guard does not misfire on an ordinary create. A
  // brand-new resource has no reports yet (POST's `all` never includes the
  // not-yet-created row — see the guard's own comment in src/server.ts), so
  // a real, pre-existing managerId can never close a cycle here; this must
  // stay 201 both before and after implementation.
  {
    const ok = await req('POST', '/resources', {
      headers: RBAC_HEADERS,
      body: {
        name: 'D Smoke Manager-Cycle Regression', role: 'Developer', kind: 'internal',
        skills: [], projectRoles: [], externalExperience: [], utilization: 0,
        capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8,
        managerId: RESOURCE_2,
      },
    });
    check(
      "POST /api/resources {managerId:'2'} (an ordinary, real manager on a brand-new resource) -> 201, not blocked by the cycle guard",
      ok.status === 201 && ok.body?.managerId === RESOURCE_2,
      `status=${ok.status}, body=${JSON.stringify(ok.body)}`,
    );
  }

  // 5) REVIEW ROUND 1 ("Important") — POST managerId:'' must normalize to
  // absent, not persist as a literal empty string. NOT an edge case: the
  // resources form's `save()` (src/app/resources/resources.component.ts
  // ~line 709) sends `managerId: raw.managerId ?? ''` on EVERY create, so
  // every ordinary "onboard someone with no People Manager" hits this path.
  // Same reasoning, and the identical fix, as vendorId's own POST-side
  // normalization a few lines above it in src/server.ts: nothing breaks
  // TODAY only because no real id is ever '', but `reportsClosure`/
  // `scopedApproversOf` (org-scope.util) both gate on `=== undefined`, so an
  // unnormalized '' would slip past them and seed a phantom key.
  {
    const emptyManagerCreate = await req('POST', '/resources', {
      headers: RBAC_HEADERS,
      body: {
        name: 'D Smoke Empty ManagerId Is Absent', role: 'Developer', kind: 'internal',
        skills: [], projectRoles: [], externalExperience: [], utilization: 0,
        capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8,
        managerId: '',
      },
    });
    check(
      "POST /api/resources {managerId:''} -> 201, normalized to absent, not persisted as a literal ''",
      emptyManagerCreate.status === 201 && !('managerId' in (emptyManagerCreate.body || {})),
      `status=${emptyManagerCreate.status}, body=${JSON.stringify(emptyManagerCreate.body)}`,
    );
  }

  // 6) The same for a literal `null` — `pick()` forwards an explicit JSON
  // null unchanged (it only filters `undefined`), so this is reachable the
  // same way vendorId's own null case is.
  {
    const nullManagerCreate = await req('POST', '/resources', {
      headers: RBAC_HEADERS,
      body: {
        name: 'D Smoke Null ManagerId Is Absent', role: 'Developer', kind: 'internal',
        skills: [], projectRoles: [], externalExperience: [], utilization: 0,
        capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8,
        managerId: null,
      },
    });
    check(
      'POST /api/resources {managerId: null} -> 201, normalized to absent, not persisted as a literal null',
      nullManagerCreate.status === 201 && !('managerId' in (nullManagerCreate.body || {})),
      `status=${nullManagerCreate.status}, body=${JSON.stringify(nullManagerCreate.body)}`,
    );
  }

  // 7) New entity ids are process-independent UUIDs, so two app workers cannot
  // issue the same local counter value. The org-chart self-cycle guard remains
  // covered through PUT, where the persisted UUID is known to the caller.
  {
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const probe1 = await req('POST', '/resources', {
      headers: RBAC_HEADERS,
      body: {
        name: 'D Smoke UUID Probe 1', role: 'Developer', kind: 'internal',
        skills: [], projectRoles: [], externalExperience: [], utilization: 0,
        capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8,
      },
    });
    const probe1Ok = check(
      'collision-safe id: probe #1 receives a UUID v4',
      probe1.status === 201 && typeof probe1.body?.id === 'string' && UUID_V4.test(probe1.body.id),
      `status=${probe1.status}, body=${JSON.stringify(probe1.body)}`,
    );
    if (probe1Ok) {
      const probe2 = await req('POST', '/resources', {
        headers: RBAC_HEADERS,
        body: {
          name: 'D Smoke UUID Probe 2', role: 'Developer', kind: 'internal',
          skills: [], projectRoles: [], externalExperience: [], utilization: 0,
          capacity: 40, hireDate: '2026-01-01', contractHoursPerDay: 8,
        },
      });
      const probe2Ok = check(
        'collision-safe id: independent probe #2 receives a distinct UUID v4',
        probe2.status === 201 && typeof probe2.body?.id === 'string'
          && UUID_V4.test(probe2.body.id) && probe2.body.id !== probe1.body.id,
        `status=${probe2.status}, body=${JSON.stringify(probe2.body)}`,
      );
      if (probe2Ok) {
        const attempt = await req('PUT', `/resources/${probe2.body.id}`, {
          headers: RBAC_HEADERS,
          body: { managerId: probe2.body.id },
        });
        check(
          `PUT /api/resources/${probe2.body.id} {managerId:self} -> 400, mentions a cycle`,
          attempt.status === 400 && typeof attempt.body?.error === 'string' && /cycle/i.test(attempt.body.error),
          `status=${attempt.status}, body=${JSON.stringify(attempt.body)}`,
        );
      }
    }
  }
}

/**
 * Rate-card inheritance (design spec §2, plan Task 2) — end-to-end through the
 * real HTTP surface, on the seed's OWN Engineering > Platform > Backend tree
 * and the seed's OWN RC_DEV_ENG card. Does not need a new seed row (that is
 * Task 7's concern, for the impact report, not this one). Rate cards created
 * here are deleted at the end (checks 4 and 8); the resource created in check
 * 2 is left in place — resources have no DELETE endpoint (logical deletion
 * only), matching the established checkResourceKinds precedent of creating
 * scoped resources with no cleanup.
 */
async function checkRateCardInheritance() {
  // 1) A new card on Platform (a practice — nearer to Backend than Engineering).
  const platformCard = await req('POST', '/rate-cards', {
    body: { role: 'Developer', organization: 'Platform', currency: 'EUR', costRate: 660, billRate: 1250 },
  });
  check(
    "POST /api/rate-cards {role:'Developer', organization:'Platform', currency:'EUR', costRate:660, billRate:1250} -> 200",
    platformCard.status === 200 && platformCard.body?.organization === 'Platform',
    `status=${platformCard.status}, body=${JSON.stringify(platformCard.body)}`,
  );
  const platformCardId = typeof platformCard.body?.id === 'string' ? platformCard.body.id : undefined;

  // 2) A fresh resource attached to Backend (a competence, under Platform, under Engineering).
  const createdResource = await req('POST', '/resources', {
    body: {
      name: 'RC-Inheritance smoke — Backend', role: 'Developer', organization: 'Backend',
      skills: [], projectRoles: [], externalExperience: [], capacity: 40, hireDate: '2026-02-15',
    },
  });
  check(
    'POST /api/resources — fresh Developer on Backend -> 201',
    createdResource.status === 201,
    `status=${createdResource.status}, body=${JSON.stringify(createdResource.body)}`,
  );
  const backendResourceId = typeof createdResource.body?.id === 'string' ? createdResource.body.id : undefined;

  // 3) With Platform's card in place, resolution must prefer it — the nearest
  //    ancestor — over Engineering's RC_DEV_ENG (640/1200) and the generic
  //    RC_DEV (600/1120). This is the check that fails against the
  //    exact-match-only resolver that shipped before this block.
  if (backendResourceId) {
    const { status, body } = await req('GET', `/resources/${backendResourceId}`);
    check(
      'GET /api/resources/:id — Backend resource resolves the NEAREST ancestor card (Platform, 660/1250), not Engineering or the generic card',
      status === 200 && body?.costRateDay === 660 && body?.billRateDay === 1250,
      `status=${status}, costRateDay=${body?.costRateDay}, billRateDay=${body?.billRateDay}`,
    );
  } else {
    check('GET /api/resources/:id — Backend resource resolves Platform\'s card', false, 'no resource id from check 2');
  }

  // 4) Remove Platform's card — cleanup, and sets up check 5.
  if (platformCardId) {
    const del = await req('DELETE', `/rate-cards/${platformCardId}`);
    check(`DELETE /api/rate-cards/${platformCardId} (Platform card) -> 204`, del.status === 204, `status=${del.status}`);
  }

  // 5) With Platform's card gone, resolution re-walks to Engineering's
  //    RC_DEV_ENG — proves the walk is live on every read, not cached at
  //    creation time.
  if (backendResourceId) {
    const { status, body } = await req('GET', `/resources/${backendResourceId}`);
    check(
      'GET /api/resources/:id — after Platform\'s card is removed, falls through to Engineering\'s RC_DEV_ENG (640/1200)',
      status === 200 && body?.costRateDay === 640 && body?.billRateDay === 1200,
      `status=${status}, costRateDay=${body?.costRateDay}, billRateDay=${body?.billRateDay}`,
    );
  } else {
    check('GET /api/resources/:id — falls through to Engineering after Platform card removed', false, 'no resource id from check 2');
  }

  // 6) A card on Backend itself — the resource's OWN node.
  const backendCard = await req('POST', '/rate-cards', {
    body: { role: 'Developer', organization: 'Backend', currency: 'EUR', costRate: 700, billRate: 1300 },
  });
  check(
    "POST /api/rate-cards {role:'Developer', organization:'Backend', currency:'EUR', costRate:700, billRate:1300} -> 200",
    backendCard.status === 200 && backendCard.body?.organization === 'Backend',
    `status=${backendCard.status}, body=${JSON.stringify(backendCard.body)}`,
  );
  const backendCardId = typeof backendCard.body?.id === 'string' ? backendCard.body.id : undefined;

  // 7) The own-node card wins over Engineering's ancestor card, even though
  //    Engineering's card is still present.
  if (backendResourceId) {
    const { status, body } = await req('GET', `/resources/${backendResourceId}`);
    check(
      'GET /api/resources/:id — own-node card (Backend, 700/1300) wins over the Engineering ancestor card',
      status === 200 && body?.costRateDay === 700 && body?.billRateDay === 1300,
      `status=${status}, costRateDay=${body?.costRateDay}, billRateDay=${body?.billRateDay}`,
    );
  } else {
    check('GET /api/resources/:id — own-node card wins over ancestor', false, 'no resource id from check 2');
  }

  // 8) Cleanup — remove Backend's own card.
  if (backendCardId) {
    const del = await req('DELETE', `/rate-cards/${backendCardId}`);
    check(`DELETE /api/rate-cards/${backendCardId} (Backend card) -> 204`, del.status === 204, `status=${del.status}`);
  }

  // 9) A legacy/orphan organization value is refused at the API boundary
  //    (validateResourceCatalogRefs) — the tree-walk's handling of an
  //    unresolvable organization is exercised by the unit test in
  //    rate-card.util.spec.ts, not by smoke, precisely because the live API
  //    never lets such a value be created.
  const orphanAttempt = await req('POST', '/resources', {
    body: {
      name: 'RC-Inheritance smoke — orphan org', role: 'Developer', organization: 'This Org Does Not Exist',
      skills: [], projectRoles: [], externalExperience: [], capacity: 40, hireDate: '2026-02-15',
    },
  });
  check(
    "POST /api/resources with organization:'This Org Does Not Exist' -> 400 (catalog reference check refuses it before any orphan value can exist)",
    orphanAttempt.status === 400,
    `status=${orphanAttempt.status}, body=${JSON.stringify(orphanAttempt.body)}`,
  );
}

/**
 * POSTGRES-ONLY — the FK-violation -> 409 mapping fixed in 0420c80.
 *
 * `isFkViolation()` (src/server/fk-violation.util.ts) walks drizzle-orm's
 * `.cause` chain because the `pg` driver's SQLSTATE never survives flat on
 * the outer error once drizzle wraps it (see that file's doc comment). This
 * behavior can ONLY be observed against a real Postgres FK constraint — the
 * InMemory adapter has no FK enforcement at all, so DELETEing an
 * FK-referenced row there just succeeds (204) and silently orphans the child
 * row instead of raising anything for the mapper to catch.
 *
 * GATED ON DATABASE_URL, the same switch `getRepositories()` itself uses to
 * choose the adapter (CLAUDE.md's "dev<->prod parity switch"): this check is
 * meaningless unless the server it is talking to is Postgres-backed, and this
 * project's own dual-run recipe (Task 10 of f-bench-availability) runs the
 * Postgres-backed server and this smoke suite in the SAME shell session, so
 * DATABASE_URL being set here is the same signal the server used to pick its
 * adapter.
 *
 * LOUD SKIP, NEVER A SILENT PASS: when DATABASE_URL is unset in this process,
 * this check cannot exercise anything real. Counting it as a pass would
 * reproduce the exact blind-green-gate shape as the bug it exists to catch —
 * `npm test`'s in-memory adapter can't raise SQLSTATE 23503 either, which is
 * why the underlying bug went unnoticed for as long as it did. It is logged
 * as SKIP and deliberately excluded from `passed`.
 */
async function checkFkViolationMapping() {
  const NAME = 'DELETE /api/customers/C1 (referenced by contract CT1) -> clean 409, not a raw 500';
  if (!process.env.DATABASE_URL) {
    skip(
      NAME,
      'DATABASE_URL is not set in this process — the InMemory adapter cannot raise a real Postgres FK violation, so this check has nothing to exercise. Re-run with DATABASE_URL set against a Postgres-backed server to exercise it (see docs/architecture/03-backend-and-data.md and CLAUDE.md\'s dev<->prod parity switch).',
    );
    return;
  }

  const { status, body } = await req('DELETE', '/customers/C1');
  check(
    NAME,
    status === 409 && body?.error === 'Cannot delete: the record is still referenced by other records',
    `status=${status}, body=${JSON.stringify(body)}`,
  );

  // Confirm the row actually survived — Postgres must have REJECTED the
  // delete outright (the FK constraint aborts the statement), not applied it
  // and merely reported the outcome wrong.
  const { status: listStatus, body: list } = await req('GET', '/customers');
  check(
    'customers/C1 still present after the rejected delete',
    listStatus === 200 && Array.isArray(list) && list.some(c => c.id === 'C1'),
    `listStatus=${listStatus}`,
  );
}

/**
 * Block G (faceted search) — q/limit/offset on the five bespoke GET handlers
 * this task extends (/resources, /projects, /requests, /contracts, /orders).
 * /customers is added in Task 3 alongside crud()'s own q/limit/offset support.
 */
async function checkSearchableReads() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'employee' };

  // Backward compatibility: no `q` -> the full, unfiltered array, same as today.
  {
    const noQ = await req('GET', '/resources');
    const withEmptyParams = await req('GET', '/resources?limit=5'); // limit alone, no q, still must NOT filter
    check('GET /api/resources with no q returns the full array', Array.isArray(noQ.body) && noQ.body.length > 0, `length=${noQ.body?.length}`);
    check('GET /api/resources?limit=5 with no q STILL returns the full array (q is what gates pagination)', Array.isArray(withEmptyParams.body) && withEmptyParams.body.length === noQ.body.length, `withLimit=${withEmptyParams.body?.length} full=${noQ.body?.length}`);
  }

  // Positive: an exact seed row, and only that row.
  {
    const { status, body } = await req('GET', '/resources?q=Julie');
    check('GET /api/resources?q=Julie -> 200', status === 200, `status=${status}`);
    check('resources?q=Julie returns EXACTLY resource id 1, no other', Array.isArray(body) && body.length === 1 && body[0].id === '1', JSON.stringify(body?.map((r) => r.id)));
  }

  // Negative twin: a nonsense term resolves successfully to zero rows, not an error.
  {
    const { status, body } = await req('GET', '/resources?q=zzznonsense123');
    check('resources?q=zzznonsense123 -> 200 (resolved, not errored)', status === 200, `status=${status}`);
    check('resources?q=zzznonsense123 -> zero rows', Array.isArray(body) && body.length === 0, `length=${body?.length}`);
  }

  // Case-insensitivity: search.util.ts's matchesQuery lower-cases both sides
  // before comparing. Every check above uses the seed's own casing ("Julie",
  // "Globex"), which can't tell a working .toLowerCase() apart from one that
  // was silently dropped -- this was curled manually once during Task 2 and
  // never committed (see the dispatch for this fix). Opposite-case here so a
  // regression in that call can no longer pass unnoticed.
  {
    const { status, body } = await req('GET', '/resources?q=JULIE');
    check('GET /api/resources?q=JULIE (opposite case) -> 200', status === 200, `status=${status}`);
    check('resources?q=JULIE (opposite case) still returns EXACTLY resource id 1', Array.isArray(body) && body.length === 1 && body[0].id === '1', JSON.stringify(body?.map((r) => r.id)));
  }

  // Projects: open read, any authenticated role, exact seed row.
  {
    const { status, body } = await req('GET', '/projects?q=Alpha', { headers: EMPLOYEE_HEADERS });
    check('GET /api/projects?q=Alpha (employee) -> 200 (open read)', status === 200, `status=${status}`);
    check('projects?q=Alpha returns EXACTLY project id 1', Array.isArray(body) && body.length === 1 && body[0].id === '1', JSON.stringify(body?.map((p) => p.id)));
  }

  // Requests: same RBAC as /resources -- employee is 403'd, same as today.
  {
    const { status } = await req('GET', '/requests?q=Alpha', { headers: EMPLOYEE_HEADERS });
    check('GET /api/requests?q=Alpha (employee) -> 403 (unchanged RBAC)', status === 403, `status=${status}`);
  }

  // Contracts/Orders: commercial RBAC, unchanged; orders match on invoiceNumber only.
  {
    const { status, body } = await req('GET', '/contracts?q=Globex');
    check('GET /api/contracts?q=Globex -> 200', status === 200, `status=${status}`);
    check('contracts?q=Globex returns EXACTLY contract CT1', Array.isArray(body) && body.length === 1 && body[0].id === 'CT1', JSON.stringify(body?.map((c) => c.id)));
  }
  // Case-insensitivity, opposite case from the seed's own "Globex" -- same
  // rationale as the resources?q=JULIE check above.
  {
    const { status, body } = await req('GET', '/contracts?q=globex');
    check('GET /api/contracts?q=globex (opposite case) -> 200', status === 200, `status=${status}`);
    check('contracts?q=globex (opposite case) still returns EXACTLY contract CT1', Array.isArray(body) && body.length === 1 && body[0].id === 'CT1', JSON.stringify(body?.map((c) => c.id)));
  }
  {
    const byName = await req('GET', '/orders?q=Globex');
    check('orders?q=Globex (a customer name, not an invoiceNumber) matches NOTHING -- orders do not join to their parent contract/customer name (spec §11)', Array.isArray(byName.body) && byName.body.length === 0, JSON.stringify(byName.body));
    const byInvoice = await req('GET', '/orders?q=INV-2026-0001');
    check('orders?q=INV-2026-0001 matches EXACTLY order O1', Array.isArray(byInvoice.body) && byInvoice.body.length === 1 && byInvoice.body[0].id === 'O1', JSON.stringify(byInvoice.body?.map((o) => o.id)));
  }

  // Customers: wired via crud()'s new opt-in searchable-fields parameter (Task 3).
  {
    const { status, body } = await req('GET', '/customers?q=Globex');
    check('GET /api/customers?q=Globex -> 200', status === 200, `status=${status}`);
    check('customers?q=Globex returns EXACTLY customer C1', Array.isArray(body) && body.length === 1 && body[0].id === 'C1', JSON.stringify(body?.map((c) => c.id)));
  }
  {
    const noQ = await req('GET', '/vendors'); // an UNRELATED crud()-mounted collection -- must be completely unaffected by this task
    check('GET /api/vendors (untouched crud() caller) still returns the full array with no searchable param passed', Array.isArray(noQ.body) && noQ.body.length > 0, `length=${noQ.body?.length}`);
  }
}

async function main() {
  console.log(`Smoke test target: ${API}${CREATE_ONLY ? '  (SMOKE_CREATE_ONLY)' : ''}`);
  console.log('---------------------------------------------------------------');

  if (CREATE_ONLY) {
    await createOnly(); // exits the process itself
    return;
  }

  try {
    await checkReads();
    await checkCrud();
  } catch (err) {
    console.log(`FAIL  unexpected error — ${err && err.message ? err.message : err}`);
    console.log('---------------------------------------------------------------');
    console.log(`HINT  is the server running at ${BASE}? Start it with: node dist/app/server/server.mjs (or npm run serve:ssr:app)`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the allocation-approval
  // flow never interferes with (or is masked by) the CRUD checks above.
  try {
    await checkAllocationApproval();
  } catch (err) {
    console.log(`FAIL  allocation-approval flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the Utilization-payload
  // regression guard never masks or blocks any of the other sections.
  try {
    await checkUtilizationAssignmentPayload();
  } catch (err) {
    console.log(`FAIL  utilization assignment-payload check — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the retarget-propagation
  // regression guard never masks or blocks any of the other sections.
  try {
    await checkResourceRetargetPropagation();
  } catch (err) {
    console.log(`FAIL  resource retarget-propagation check — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the time-phased
  // allocation flow never masks or blocks any of the prior section results.
  try {
    await checkTimePhasedAllocation();
  } catch (err) {
    console.log(`FAIL  time-phased allocation flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the capacity-rollup flow
  // never masks or blocks any of the prior section results.
  try {
    await checkCapacityMonthly();
  } catch (err) {
    console.log(`FAIL  capacity-monthly flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the assignment raw-reads
  // check (Block F/E shared plumbing) never masks or blocks any of the prior
  // section results.
  try {
    await checkAssignmentRawReads();
  } catch (err) {
    console.log(`FAIL  assignment raw-reads (Block F/E plumbing) — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the block E content
  // check (Task 3 — proves the Task 1 seed actually flows through the
  // shared /assignment-days and /assignment-months endpoints, not just that
  // the endpoints have the right shape) never masks or blocks any of the
  // prior section results.
  try {
    await checkAssignmentDaysAndMonthsCarryBlockESeed();
  } catch (err) {
    console.log(`FAIL  assignment-days/assignment-months carry block E's seed (Task 3) — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the cost-baselines
  // freeze flow (Task 5) never masks or blocks any of the prior section
  // results.
  try {
    await checkCostBaselines();
  } catch (err) {
    console.log(`FAIL  cost-baselines integrity flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the bench-monthly flow
  // never masks or blocks any of the prior section results.
  try {
    await checkBenchMonthly();
  } catch (err) {
    console.log(`FAIL  bench-monthly flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the searchable-reads flow
  // never masks or blocks any of the prior section results.
  try {
    await checkSearchableReads();
  } catch (err) {
    console.log(`FAIL  searchable reads (Block G) — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the monthly-approval flow
  // never masks or blocks any of the prior section results.
  try {
    await checkMonthlyApproval();
  } catch (err) {
    console.log(`FAIL  monthly-approval flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the legacy (bare-refId)
  // approval flow never masks or blocks any of the prior section results.
  try {
    await checkLegacyAllocationApproval();
  } catch (err) {
    console.log(`FAIL  legacy allocation-approval flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the C1 resource-kind
  // validation flow never masks or blocks any of the prior section results.
  try {
    await checkResourceKinds();
  } catch (err) {
    console.log(`FAIL  resource-kinds flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the C2 dummy-substitution
  // flow never masks or blocks any of the prior section results.
  try {
    await checkDummySubstitution();
  } catch (err) {
    console.log(`FAIL  dummy-substitution flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the D org-tree-integrity
  // flow never masks or blocks any of the prior section results.
  try {
    await checkOrgTreeIntegrity();
  } catch (err) {
    console.log(`FAIL  org-tree integrity flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the D scoped-decision
  // flow never masks or blocks any of the prior section results. Runs BEFORE
  // checkResourceManagerCycle, which permanently clears resource '3's
  // managerId — this section reads the seeded 3 -> 2 -> 1 chain.
  try {
    await checkScopedAllocationDecision();
  } catch (err) {
    console.log(`FAIL  scoped allocation-decision flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the D scoped-approval-feed
  // flow never masks or blocks any of the prior section results. MUST run
  // immediately after checkScopedAllocationDecision (reuses its '2026-11'
  // fixtures for resources '3'/'4'/'5') and — like it — BEFORE
  // checkResourceManagerCycle, which permanently clears resource '3's
  // managerId.
  try {
    await checkScopedApprovalFeed();
  } catch (err) {
    console.log(`FAIL  scoped approval-feed flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the D review-round-4
  // accountable-manager flow never masks or blocks any of the prior section
  // results. MUST run AFTER checkScopedApprovalFeed (it temporarily gives node
  // '3' a manager, which would destroy that section's roleFallback fixture) and
  // BEFORE checkResourceManagerCycle.
  try {
    await checkAccountableApproverRules();
  } catch (err) {
    console.log(`FAIL  accountable-manager rules — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the Task 3 negotiated-rates
  // integrity flow never masks or blocks any of the prior section results.
  try {
    await checkNegotiatedRates();
  } catch (err) {
    console.log(`FAIL  negotiated-rates integrity flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the /self/* section never
  // masks or blocks any of the prior section results.
  try {
    await checkSelfService();
  } catch (err) {
    console.log(`FAIL  /self/* self-service flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the retarget per-day
  // capacity guard never masks or blocks any of the prior section results.
  try {
    await checkRetargetDailyCapacity();
  } catch (err) {
    console.log(`FAIL  retarget daily-capacity guard — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the billing payment
  // lifecycle never masks or blocks any of the prior section results.
  try {
    await checkBillingPaymentLifecycle();
  } catch (err) {
    console.log(`FAIL  billing payment lifecycle — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the D resource-manager-
  // cycle flow never masks or blocks any of the prior section results. MUST
  // run LAST (see the function's doc comment) — it permanently clears
  // resource '3's managerId for the rest of this server process, breaking the
  // seeded 3 -> 2 -> 1 chain that earlier sections read.
  try {
    await checkResourceManagerCycle();
  } catch (err) {
    console.log(`FAIL  resource-manager-cycle flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the rate-card
  // inheritance flow never masks or blocks any of the prior section results.
  // Safe anywhere in the order: it creates/deletes its own scoped rate cards
  // and one scoped resource (never touched again), never mutates seed rows
  // other sections depend on.
  try {
    await checkRateCardInheritance();
  } catch (err) {
    console.log(`FAIL  rate-card inheritance flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  // Own try/catch: guarded so an unexpected error in the Postgres-only
  // FK-violation mapping check never masks or blocks any of the prior section
  // results. Runs LAST and is safe to run anywhere in the order: on a match it
  // asserts the delete was REJECTED (customers/C1 survives), so it never
  // mutates state other sections depend on.
  try {
    await checkFkViolationMapping();
  } catch (err) {
    console.log(`FAIL  FK-violation -> 409 mapping check — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  console.log('---------------------------------------------------------------');
  console.log(`SUMMARY  ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} SKIPPED (not exercised — see SKIP lines above)` : ''}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
