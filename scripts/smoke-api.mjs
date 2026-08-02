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

/** Fetch JSON, returning { status, body, raw }. Never throws on HTTP status. */
async function req(method, path, { headers, body } = {}) {
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
  return { status: res.status, body: json, raw: text };
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
      body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID, assignedHours: 5, status: 'Draft' },
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
    body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID, assignedHours: 0 },
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

  // 7) REGRESSION CLOSED (B3 carry-forward #2) — a DELETE must withdraw a
  // Pending month approval and drop the month rows, never orphan either. Uses
  // a SEPARATE throwaway assignment (never touches the one decided above) so
  // this section's own state can't interfere.
  {
    const created2 = await req('POST', '/assignments', {
      headers: PROPOSER_HEADERS,
      body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID, assignedHours: 0 },
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
 * `{ requestId, resourceId, assignedHours, status: 'Draft' }` — a shape this
 * task's server change now rejects with 400 ("status is derived..."), which
 * is exactly how the Task-7 review caught two live UI flows breaking ("New
 * assignment" / "Paste assignment" in Utilization both failing with the
 * generic "Failed to create assignment." toast). Both call sites were fixed
 * to drop `status` entirely, and now build the IDENTICAL payload shape:
 * `{ requestId, resourceId, assignedHours }`. This check POSTs that exact
 * shape (not the richer PROPOSER_HEADERS-driven shape exercised above) so a
 * future regression in either call site is caught here, not by a user
 * hitting a dead-end toast in the browser.
 */
async function checkUtilizationAssignmentPayload() {
  // Deliberately the default RBAC_HEADERS (admin/resource '1') and NO headers
  // override, since neither utilization.component.ts call site sends one —
  // both rely on api.service.ts's default same-origin auth. requestId/
  // resourceId '1' are seed rows that always exist.
  const payload = { requestId: '1', resourceId: '1', assignedHours: 1 };
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
    body: { requestId: REQUEST_ID, resourceId: OLD_RESOURCE_ID, assignedHours: 0 },
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
      body: { requestId: '1', resourceId: '1', assignedHours: 0 },
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
  // around it. Assignment 1's resource is '1' (Julie Armstrong), whose
  // managerId is ALSO '1' — the default RBAC_HEADERS admin actor — so
  // submitting as the DEFAULT actor hits the self-managed auto-approval
  // shortcut (straight to 'Allocated', approvalId cleared, no approval
  // opened). 2026-09 is an OPEN period neither of assignment 1's assignments
  // books (assignment 1 ends 2026-06-30; assignment 2, also resource 1, ends
  // 2026-08-31), so a PUT there is guaranteed conflict-free and creates a
  // fresh Draft row to submit. This is the regression coverage for the
  // self-managed branch's `approvalId: null` clear: it must leave the field
  // ABSENT in the response (both adapters), never a literal `null`.
  const selfManagedPut = await req('PUT', '/assignments/1/allocation', { body: { month: '2026-09', dailyHours: { '2026-09-07': 1 } } });
  check('B3 self-managed setup: PUT into an unbooked open month creates a Draft row', selfManagedPut.status === 200, `status=${selfManagedPut.status}`);

  const selfManagedSubmit = await req('POST', '/assignments/1/months/2026-09/submit', { body: {} });
  check('B3 self-managed submit auto-approves to Allocated', selfManagedSubmit.status === 200 && selfManagedSubmit.body?.status === 'Allocated',
    `status=${selfManagedSubmit.status} row=${selfManagedSubmit.body?.status}`);
  check('B3 self-managed submit clears approvalId to absent, not null',
    selfManagedSubmit.body !== null && typeof selfManagedSubmit.body === 'object' &&
    !Object.prototype.hasOwnProperty.call(selfManagedSubmit.body, 'approvalId') && selfManagedSubmit.body.approvalId === undefined,
    `approvalId=${JSON.stringify(selfManagedSubmit.body?.approvalId)} hasOwn=${Object.prototype.hasOwnProperty.call(selfManagedSubmit.body ?? {}, 'approvalId')}`);

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

  // Own try/catch: guarded so an unexpected error in the monthly-approval flow
  // never masks or blocks any of the prior section results.
  try {
    await checkMonthlyApproval();
  } catch (err) {
    console.log(`FAIL  monthly-approval flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }

  console.log('---------------------------------------------------------------');
  console.log(`SUMMARY  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
