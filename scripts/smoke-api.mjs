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
 * Step 3: ALLOCATION APPROVAL flow (src/server.ts POST /assignments + the
 * 'Allocation' approval kind + PUT /approval-requests/:id/decision).
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
 *     `autoApprovesAllocation()` is false: the proposal does NOT auto-approve
 *     and a real 'Allocation' approval step is opened, routed to approverId
 *     '1' (role 'resource-manager', per allocationApproverStep()).
 *
 *   TARGET_REQUEST_ID '4' (Project Beta - Platform Migration, Consultant) —
 *     matches resource '2's role and is the request it is already partly
 *     staffed against, so an incremental 'Requested' assignment is realistic.
 *
 *   DECIDER_HEADERS  X-User-Id '1' / X-User-Role 'admin'
 *     -> 'admin' may decide ANY step regardless of its role/approverId (so
 *        this also happens to satisfy the manager-match on approverId '1'),
 *        and actor '1' != the proposer's actor id '3', so the "requester
 *        cannot decide their own approval request" SoD guard (403 otherwise)
 *        does not trip.
 *
 * Kept in its OWN try/catch in main() so an unexpected failure here never
 * masks or blocks the pre-existing checkReads()/checkCrud() results.
 */
async function checkAllocationApproval() {
  const PROPOSER_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };
  const DECIDER_HEADERS = { 'X-User-Id': '1', 'X-User-Role': 'admin' };
  const TARGET_RESOURCE_ID = '2'; // John Miller — managerId '1' (Julie Armstrong), != proposer resource-id '3'
  const TARGET_REQUEST_ID = '4'; // Project Beta - Platform Migration (Consultant)

  // 1) PROPOSE — POST /assignments as the proposer, status 'Requested'. Must
  // NOT auto-approve (proposer resource-id '3' != target's managerId '1'), so
  // the response should carry status 'Requested' + a non-empty approvalId.
  const proposed = await req('POST', '/assignments', {
    headers: PROPOSER_HEADERS,
    body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID, assignedHours: 5, status: 'Requested' },
  });
  const proposeOk = check(
    "POST /api/assignments (Requested) -> 200, status 'Requested' + approvalId",
    proposed.status === 200 && Boolean(proposed.body) && proposed.body.status === 'Requested' && typeof proposed.body.approvalId === 'string' && proposed.body.approvalId.length > 0,
    `status=${proposed.status}, assignmentStatus=${proposed.body && proposed.body.status}, approvalId=${proposed.body && proposed.body.approvalId}`,
  );
  if (!proposeOk) return; // nothing more to verify without an assignment id + approvalId
  const assignmentId = proposed.body.id;
  const approvalId = proposed.body.approvalId;

  // 2) GET /approval-requests — a Pending 'Allocation' entry must exist whose
  // refId is the new assignment.
  {
    const { status, body } = await req('GET', '/approval-requests', { headers: DECIDER_HEADERS });
    const ar = Array.isArray(body) ? body.find((a) => a.id === approvalId) : undefined;
    check(
      "GET /api/approval-requests includes the new 'Allocation' request (Pending, refId matches)",
      status === 200 && Boolean(ar) && ar.kind === 'Allocation' && ar.refId === assignmentId && ar.status === 'Pending',
      ar ? `kind=${ar.kind}, refId=${ar.refId}, status=${ar.status}` : `status=${status}, missing id=${approvalId}`,
    );
  }

  // 3) DECIDE — PUT /approval-requests/:id/decision as a DIFFERENT identity
  // than the proposer (SoD): admin '1' != pm '3'.
  {
    const decided = await req('PUT', `/approval-requests/${approvalId}/decision`, {
      headers: DECIDER_HEADERS,
      body: { decision: 'Approved', note: 'Smoke: approved by admin (SoD-compliant decider)' },
    });
    check(
      `PUT /api/approval-requests/${approvalId}/decision (Approved) -> 200`,
      decided.status === 200 && Boolean(decided.body) && decided.body.status === 'Approved',
      `status=${decided.status}, arStatus=${decided.body && decided.body.status}`,
    );
  }

  // 4) The governed assignment must now be 'Allocated' (system transition
  // applied by the decision hook, never client-forged).
  {
    const { status, body } = await req('GET', '/assignments', { headers: DECIDER_HEADERS });
    const assig = Array.isArray(body) ? body.find((a) => a.id === assignmentId) : undefined;
    check(
      `GET /api/assignments reflects assignment ${assignmentId} -> 'Allocated'`,
      status === 200 && Boolean(assig) && assig.status === 'Allocated',
      assig ? `status=${assig.status}` : `status=${status}, missing`,
    );
  }

  // 5) NEGATIVE — a client can never forge 'Allocated' (or 'Rejected') on
  // create; only 'Draft'/'Requested' are client-settable.
  {
    const forged = await req('POST', '/assignments', {
      headers: PROPOSER_HEADERS,
      body: { requestId: TARGET_REQUEST_ID, resourceId: TARGET_RESOURCE_ID, assignedHours: 5, status: 'Allocated' },
    });
    check(
      "POST /api/assignments with status 'Allocated' is rejected (400, not client-settable)",
      forged.status === 400,
      `status=${forged.status}, body=${JSON.stringify(forged.body)}`,
    );
  }
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

  // 6) DELETE CLEANUP — create a throwaway 'Draft' assignment (never touches
  // seed data), allocate one day on it, then delete it and confirm 204 (never
  // 409 — assignmentDays must be removed before the parent row) with no orphan
  // left behind (a follow-up allocation GET 404s because the assignment itself
  // is gone).
  {
    const created = await req('POST', '/assignments', {
      body: { requestId: '1', resourceId: '1', assignedHours: 0, status: 'Draft' },
    });
    const createOk = check(
      'POST /api/assignments (throwaway Draft, for delete-cleanup) -> 200',
      created.status === 200 && Boolean(created.body) && typeof created.body.id === 'string',
      `status=${created.status}, id=${created.body && created.body.id}`,
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

  const after = await req('GET', '/assignments/3/allocation?from=2026-05&to=2026-09');
  const editedRow = after.body.months.find(m => m.month === target);
  const siblingRow = after.body.months.find(m => m.month === sibling.month);
  check('B3 edited month demoted to Requested', editedRow?.status === 'Requested', `status=${editedRow?.status}`);
  check('B3 sibling month stays Allocated', siblingRow?.status === 'Allocated', `status=${siblingRow?.status}`);
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
