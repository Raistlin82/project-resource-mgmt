#!/usr/bin/env node
// @ts-check
/*
 * rate-inheritance-impact.mjs — the merge gate for the rate-card-inheritance
 * branch. DEPENDENCY-FREE, modelled on scripts/negotiated-rate-impact.mjs's
 * plain-fetch idiom (same BASE/API/RBAC_HEADERS/req() shape) — no test
 * framework, no npm dependencies, Node 20+ global fetch only.
 *
 * WHAT IT DOES
 * Queries a running server and computes, for every resource with a role,
 * the effective cost/bill rate in EUR/DAY (the unit a rate card is stored
 * in — comparing in EUR/day sidesteps the hoursPerDay divisor entirely,
 * since that factor is identical on "before" and "after" and would add no
 * information to the comparison, design spec §9) TWICE:
 *   - "before" — today's pre-block resolution: exact match on the resource's
 *                own `organization`, else the generic (no-organization)
 *                card. Ported here verbatim from what pickRateCard used to
 *                be before this block (src/server.ts, prior to this branch).
 *   - "after"  — the ancestor-walk resolution this block ships: node, then
 *                each ancestor nearest-first, then the generic card. Ported
 *                verbatim from src/app/services/rate-card.util.ts's
 *                `pickRateCard`, so this report can never silently drift
 *                from what the app actually resolves.
 * Both sides apply `resource.costRateOverride ?? card.costRate` (same for
 * bill) — the per-resource override is unaffected by this block and must be
 * read identically on both sides, or the script would attribute an
 * unrelated override to "the inheritance change".
 *
 * Only the resources where either figure differs are printed: id, name,
 * role, organization, cost before->after, bill before->after, delta.
 *
 * THE GATE, STATED PRECISELY — because this project has already let an 8x
 * revenue defect through a "zero rows" reading exactly once (this script's
 * own twin, negotiated-rate-impact.mjs):
 *   - The STRONG property — no card sits on a node with children implies
 *     zero rows for ANY resource placement — is proved as a property test in
 *     rate-card.util.spec.ts, NOT by this script. This script's own job is
 *     narrower and empirical: it photographs today's actual data.
 *   - On an environment where every rate card sits on a leaf node, this
 *     script printing zero rows is TRUE BY CONSTRUCTION (the ancestor walk
 *     never finds anything to differ on), not evidence the walk works.
 *   - On THIS repository's own committed seed, RC_DEV_ENG sits on
 *     Engineering — a NON-LEAF node (it has a child, Platform) — and seed
 *     resource '13' (Nora Keller) sits on Backend, two levels beneath it,
 *     with no rate override of her own. That is a real, non-empty case:
 *     this script MUST print exactly one row for her, with
 *     `cost: 600.00 -> 640.00 (delta +40.00)` and
 *     `bill: 1120.00 -> 1200.00 (delta +80.00)`. If it prints zero rows on
 *     this seed, the seed row or this script's port of the ancestor walk is
 *     wrong — investigate before treating zero as a pass.
 *
 * Usage:
 *   AUTH_TRUST_HEADERS=true npm run serve:ssr:app
 *   node scripts/rate-inheritance-impact.mjs
 *   IMPACT_BASE=http://localhost:4173 node scripts/rate-inheritance-impact.mjs
 *
 * IMPACT_BASE overrides the origin, exactly as it does for
 * negotiated-rate-impact.mjs (and SMOKE_BASE for smoke-api.mjs).
 *
 * Exit code: 0 if the fetch/compute succeeds (regardless of row count — this
 * is a report, the reader decides what a given row count means against the
 * environment's own data). Nonzero only on a hard failure to reach the API.
 */

const BASE = (process.env.IMPACT_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const API = `${BASE}/api`;

// Same admin demo principal negotiated-rate-impact.mjs/smoke-api.mjs use:
// reads here touch /resources, /rate-cards and /resource-organizations, each
// either gated to need-to-know roles (src/server.ts READ_RULES) or open —
// admin is on every allow-list that exists, so one header pair covers every
// GET this script makes. Requires the server to be started with
// AUTH_TRUST_HEADERS=true (dev/demo only — never inferred from the bind host).
const RBAC_HEADERS = { 'X-User-Id': '1', 'X-User-Role': 'admin' };

/**
 * Fetch JSON, returning the parsed body. RETRIES A 429 — the API applies a
 * 300-req/min-per-client rate limit (src/server.ts, `rateLimit(300, 60_000)`);
 * this script makes only a handful of GETs so it should never hit the
 * ceiling on its own, but a warm server shared with a freshly-run smoke suite
 * might already be close to it. The retry is SAFE because the limiter runs as
 * `apiRouter.use(...)` middleware: a 429 is rejected before any handler runs,
 * so re-sending a GET has no side effect either way.
 */
async function req(path) {
  const RETRY_MS = 5_000;
  const MAX_WAIT_MS = 70_000; // one full window plus slack
  let waited = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(`${API}${path}`, { headers: RBAC_HEADERS });
    } catch (err) {
      console.log(`FAIL  GET ${API}${path} — ${err && err.message ? err.message : err}`);
      console.log(`HINT  is the server running at ${BASE}? Start it with: node dist/app/server/server.mjs (or npm run serve:ssr:app)`);
      process.exit(1);
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (res.status !== 429 || waited >= MAX_WAIT_MS) {
      if (res.status !== 200) {
        console.log(`FAIL  GET ${API}${path} -> ${res.status} ${JSON.stringify(json)}`);
        process.exit(1);
      }
      return json;
    }
    if (waited === 0) console.log(`INFO  rate limit reached — waiting out the window before retrying GET ${path}`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    waited += RETRY_MS;
  }
}

const RATE_BASE_CURRENCY = 'EUR';

/**
 * Verbatim port of TODAY'S pre-block resolution (what pickRateCard was
 * before this branch, src/server.ts): exact match on `organization`, else
 * the generic (no-organization) card. No tree, no ancestor.
 */
function oldPickRateCard(cards, role, organization) {
  if (!role) return undefined;
  const forRole = cards.filter((c) => c.role === role && (c.currency ?? RATE_BASE_CURRENCY) === RATE_BASE_CURRENCY);
  return forRole.find((c) => c.organization && c.organization === organization) ?? forRole.find((c) => !c.organization);
}

/**
 * Verbatim port of `nodeByName`/`ancestorChain`
 * (src/app/services/org-scope.util.ts) — the two tree primitives the new
 * resolver needs. Kept as a line-for-line mirror so this script can never
 * silently drift from what the app actually resolves.
 */
function nodeByName(name, nodes) {
  if (name === undefined || name === '') return undefined;
  return nodes.find((n) => n.name === name);
}

function ancestorChain(nodeId, nodes) {
  const MAX_CHAIN_DEPTH = 64;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain = [];
  const visited = new Set();
  let current = byId.get(nodeId);
  while (current !== undefined && !visited.has(current.id) && chain.length < MAX_CHAIN_DEPTH) {
    visited.add(current.id);
    chain.push(current);
    current = current.parentId === undefined ? undefined : byId.get(current.parentId);
  }
  return chain;
}

/**
 * Verbatim port of THIS BLOCK'S resolution (src/app/services/rate-card.util.ts
 * `pickRateCard`): the node's own card, then each ancestor nearest-first,
 * then the generic card.
 */
function newPickRateCard(cards, role, organization, nodes) {
  if (!role) return undefined;
  const forRole = cards.filter((c) => c.role === role && (c.currency ?? RATE_BASE_CURRENCY) === RATE_BASE_CURRENCY);
  const own = forRole.find((c) => c.organization && c.organization === organization);
  if (own) return own;
  const node = nodeByName(organization, nodes);
  if (node) {
    for (const ancestor of ancestorChain(node.id, nodes).slice(1)) {
      const hit = forRole.find((c) => c.organization === ancestor.name);
      if (hit) return hit;
    }
  }
  return forRole.find((c) => !c.organization);
}

const eur = (n) => n.toFixed(2);

async function main() {
  console.log(`Rate-inheritance impact target: ${API}`);
  console.log('---------------------------------------------------------------');

  const [resources, rateCards, orgNodes] = await Promise.all([
    req('/resources'),
    req('/rate-cards'),
    req('/resource-organizations'),
  ]);

  console.log(`INFO  ${resources.length} resources, ${rateCards.length} rate card(s), ${orgNodes.length} org node(s)`);

  const EPS = 1e-6; // guard against float noise, not a real difference
  let rows = 0;

  for (const r of [...resources].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!r.role) continue;
    const beforeCard = oldPickRateCard(rateCards, r.role, r.organization);
    const afterCard = newPickRateCard(rateCards, r.role, r.organization, orgNodes);
    // Same override on both sides -- unaffected by this block, must not be
    // attributed to "the inheritance change".
    const beforeCost = r.costRateOverride ?? beforeCard?.costRate;
    const afterCost = r.costRateOverride ?? afterCard?.costRate;
    const beforeBill = r.billRateOverride ?? beforeCard?.billRate;
    const afterBill = r.billRateOverride ?? afterCard?.billRate;

    const costDiffers = Math.abs((afterCost ?? 0) - (beforeCost ?? 0)) > EPS || (beforeCost === undefined) !== (afterCost === undefined);
    const billDiffers = Math.abs((afterBill ?? 0) - (beforeBill ?? 0)) > EPS || (beforeBill === undefined) !== (afterBill === undefined);
    if (!costDiffers && !billDiffers) continue;

    rows++;
    const costBefore = beforeCost === undefined ? '(none)' : eur(beforeCost);
    const costAfter = afterCost === undefined ? '(none)' : eur(afterCost);
    const billBefore = beforeBill === undefined ? '(none)' : eur(beforeBill);
    const billAfter = afterBill === undefined ? '(none)' : eur(afterBill);
    const costDelta = beforeCost !== undefined && afterCost !== undefined ? ` delta=${eur(afterCost - beforeCost)}` : '';
    const billDelta = beforeBill !== undefined && afterBill !== undefined ? ` delta=${eur(afterBill - beforeBill)}` : '';
    console.log(
      `DIFF  resource=${r.id} name="${r.name}" role="${r.role}" organization="${r.organization ?? '(none)'}" `
      + `cost: ${costBefore} -> ${costAfter}${costDelta} EUR/day  bill: ${billBefore} -> ${billAfter}${billDelta} EUR/day`,
    );
  }

  console.log('---------------------------------------------------------------');
  console.log(`SUMMARY  ${rows} resource(s) with a differing effective rate (${rateCards.length} rate card(s) on this environment)`);
  process.exit(0);
}

main();
