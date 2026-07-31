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
  let otherMonthsHoursBefore = 0;
  {
    const { status, body } = await req('GET', `/assignments/${ASSIGNMENT_ID}/allocation`);
    check(`GET /api/assignments/${ASSIGNMENT_ID}/allocation (pre-edit) -> 200`, status === 200, `status=${status}`);
    otherMonthsHoursBefore = sumHours(body && body.days, MONTH);
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

      // Independent verification via GET: assignedHours must equal the sum of
      // ALL the assignment's day rows (every month), not just the edited one.
      const after = await req('GET', `/assignments/${ASSIGNMENT_ID}/allocation`);
      const totalFromDays = sumHours(after.body && after.body.days);
      check(
        `GET /api/assignments/${ASSIGNMENT_ID}/allocation sum(days.hours) == assignedHours`,
        after.status === 200 && Math.abs(totalFromDays - put.body.assignedHours) < 1e-6,
        `status=${after.status}, sum(days)=${totalFromDays}, assignedHours=${put.body.assignedHours}`,
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

  console.log('---------------------------------------------------------------');
  console.log(`SUMMARY  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
