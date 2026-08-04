#!/usr/bin/env node
// @ts-check
/*
 * negotiated-rate-impact.mjs — the merge gate for the negotiated-sell-rates
 * branch. DEPENDENCY-FREE, modelled on scripts/smoke-api.mjs's plain-fetch
 * idiom (same BASE/API/RBAC_HEADERS/req() shape) — no test framework, no
 * npm dependencies, Node 20+ global fetch only.
 *
 * WHAT IT DOES
 * Queries a running server and computes the as-incurred revenue (Σ approved
 * time-entry hours × sell rate) PER PROJECT twice:
 *   - "after"  — the sell rate resolved by the real precedence chain: a
 *                project override, else the project's contract rate (only for
 *                hours dated inside that contract's period), else the
 *                resource's reference billRate. This is exactly
 *                `sellRateFor` (src/app/services/sell-rate.util.ts), ported
 *                here verbatim (no framework import — this script talks HTTP
 *                only) so the report reflects the SAME resolution the app
 *                ships, not a reimplemented approximation.
 *   - "before" — the SAME computation with the negotiated-rate table forced
 *                empty, i.e. every hour prices at the resource's reference
 *                billRate. This is the pre-feature behaviour and the
 *                no-regression guarantee (sell-rate.util.ts's own docstring,
 *                §"Level 3 is the no-regression guarantee").
 * Only the projects where the two totals differ are printed: id, name,
 * revenue before, revenue after, delta in EUR.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT — stated precisely, because the
 * original wording of this header overclaimed and that overclaim helped a ~8x
 * revenue defect through every green gate.
 *   - EMPTY TABLE -> zero rows is TRUE BY CONSTRUCTION, not evidence: with
 *     `negotiated_rates` empty, `negotiatedRates` IS `[]`, so the two calls are
 *     the same pure function over the same arguments. Run it, but do not read
 *     zero rows there as a passing gate; the real no-regression pin is
 *     finance.util.spec.ts's case that fixes [1400,0,2800,0] with the field
 *     both empty AND absent.
 *   - NON-EMPTY TABLE -> the delta is the useful output, and it only means
 *     something if some APPROVED time entry actually lands on a project or
 *     contract carrying a rate. Seed row TE4 (src/db/seed.ts) exists for that:
 *     8 hours of a Developer on project '2', which carries the 1150 €/day
 *     override, must print `before=1120.00 after=1150.00 delta=30.00` — one 8h
 *     day at one day rate. A four-figure delta on that row means the €/day ->
 *     €/hour conversion in `sellRateFor` has been lost again.
 *   - It compares this code against ITSELF (not against pre-feature code), and
 *     it re-implements the aggregation as "Σ approved hours × rate grouped by
 *     project" rather than calling `recognitionSchedule` — no billing-item
 *     scoping, no capAmount, no period windowing. It is a delta REPORT.
 *
 * Usage:
 *   AUTH_TRUST_HEADERS=true npm run serve:ssr:app
 *   node scripts/negotiated-rate-impact.mjs
 *   IMPACT_BASE=http://localhost:4173 node scripts/negotiated-rate-impact.mjs
 *
 * IMPACT_BASE overrides the origin, exactly as SMOKE_BASE does for smoke-api.mjs.
 *
 * Exit code: 0 if the fetch/compute succeeds (regardless of row count — this
 * is a report, the reader/CI wrapper decides what a nonzero row count means
 * against an empty table). Nonzero only on a hard failure to reach the API.
 */

const BASE = (process.env.IMPACT_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const API = `${BASE}/api`;

// Same admin demo principal smoke-api.mjs uses: reads here touch /resources,
// /contracts and /negotiated-rates, each gated (src/server.ts READ_RULES) to
// need-to-know roles — admin is on every one of those allow-lists, so a
// single header pair covers every GET this script makes. Requires the server
// to be started with AUTH_TRUST_HEADERS=true (dev/demo only — never inferred
// from the bind host).
const RBAC_HEADERS = { 'X-User-Id': '1', 'X-User-Role': 'admin' };

/**
 * Fetch JSON, returning { status, body }. RETRIES A 429 — the API applies a
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

const SELL_RATE_BASE_CURRENCY = 'EUR';

/**
 * Verbatim port of sellRateFor's helpers and precedence chain
 * (src/app/services/sell-rate.util.ts). Kept as a line-for-line mirror —
 * including the ISO-string date comparison and the `usable()` currency/
 * numeric guard — so this report can never silently drift from what the app
 * actually resolves. See that file for the full design-spec rationale; the
 * short version: project override (bounded by its own project's contract
 * period, if any) -> contract rate (bounded by the contract's own period) ->
 * referenceBillRate (the no-regression fallback).
 */
function withinPeriod(date, contract) {
  if (date < contract.startDate) return false;
  return contract.endDate === undefined || date <= contract.endDate;
}

function usable(rate) {
  return (rate.currency ?? SELL_RATE_BASE_CURRENCY) === SELL_RATE_BASE_CURRENCY
    && typeof rate.billRate === 'number' && Number.isFinite(rate.billRate) && rate.billRate >= 0;
}

function hoursPerDayOrDefault(hoursPerDay) {
  return typeof hoursPerDay === 'number' && Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay : 8;
}

function sellRateFor({ projectId, role, date, referenceBillRate, hoursPerDay, rates, projects, contracts }) {
  if (projectId === undefined || role === undefined) return referenceBillRate;
  // UNITS: a negotiated billRate is stored in EUR/DAY, the referenceBillRate
  // /api/resources serves is already EUR/HOUR. Every path returns EUR/HOUR.
  const perHour = (dayRate) => dayRate / hoursPerDayOrDefault(hoursPerDay);

  const contractId = projects.find((p) => p.id === projectId)?.contractId;
  const contract = contractId !== undefined ? contracts.find((c) => c.id === contractId) : undefined;
  const projectPeriodOk = contractId === undefined || (contract !== undefined && withinPeriod(date, contract));

  if (projectPeriodOk) {
    const onProject = rates.find((r) => r.projectId === projectId && r.role === role && usable(r));
    if (onProject !== undefined) return perHour(onProject.billRate);
  }

  if (contract !== undefined && withinPeriod(date, contract)) {
    const onContract = rates.find((r) => r.contractId === contractId && r.role === role && usable(r));
    if (onContract !== undefined) return perHour(onContract.billRate);
  }

  return referenceBillRate;
}

const finite = (v) => (Number.isFinite(v) ? v : 0);

/**
 * Σ approved time-entry hours × sell rate, grouped by projectId. `rates` is
 * the negotiated-rate table to resolve against — pass the real table for
 * "after", and `[]` for "before" (sellRateFor with an empty table always
 * falls through to referenceBillRate, which IS the pre-feature computation).
 */
function revenueByProject({ timeEntries, resources, projects, contracts, rates, hoursPerDay }) {
  const totals = new Map(); // projectId -> revenue
  for (const t of timeEntries) {
    if (t.status !== 'Approved') continue;
    const resource = resources.find((r) => r.id === t.resourceId);
    const rate = sellRateFor({
      projectId: t.projectId,
      role: resource?.role,
      date: t.date,
      referenceBillRate: resource?.billRate,
      hoursPerDay,
      rates,
      projects,
      contracts,
    }) ?? 0;
    const value = finite(t.hours) * rate;
    totals.set(t.projectId, (totals.get(t.projectId) ?? 0) + value);
  }
  return totals;
}

const eur = (n) => n.toFixed(2);

async function main() {
  console.log(`Negotiated-rate impact target: ${API}`);
  console.log('---------------------------------------------------------------');

  const [timeEntries, resources, projects, contracts, negotiatedRates, hoursPerDaySetting] = await Promise.all([
    req('/time-entries'),
    req('/resources'),
    req('/projects'),
    req('/contracts'),
    req('/negotiated-rates'),
    req('/settings/hours-per-day'),
  ]);
  // The EUR/day -> EUR/hour divisor. /resources already serves an HOURLY
  // billRate (withEffectiveRates divides by this same setting server-side),
  // so without it the two sides of the multiplication are in different units.
  const hoursPerDay = hoursPerDayOrDefault(hoursPerDaySetting?.value);

  console.log(`INFO  ${timeEntries.length} time entries, ${resources.length} resources, ${projects.length} projects, ${contracts.length} contracts, ${negotiatedRates.length} negotiated rate(s), hoursPerDay=${hoursPerDay}`);

  const after = revenueByProject({ timeEntries, resources, projects, contracts, rates: negotiatedRates, hoursPerDay });
  const before = revenueByProject({ timeEntries, resources, projects, contracts, rates: [], hoursPerDay });

  const projectIds = new Set([...before.keys(), ...after.keys()]);
  const EPS = 1e-6; // guard against float noise, not a real difference
  let rows = 0;

  for (const id of [...projectIds].sort()) {
    const beforeAmt = before.get(id) ?? 0;
    const afterAmt = after.get(id) ?? 0;
    const delta = afterAmt - beforeAmt;
    if (Math.abs(delta) <= EPS) continue;
    rows++;
    const name = projects.find((p) => p.id === id)?.name ?? '(unknown project)';
    console.log(`DIFF  project=${id} name="${name}" before=${eur(beforeAmt)} after=${eur(afterAmt)} delta=${eur(delta)} EUR`);
  }

  console.log('---------------------------------------------------------------');
  console.log(`SUMMARY  ${rows} project(s) with differing as-incurred revenue (negotiated rate table has ${negotiatedRates.length} row(s))`);
  process.exit(0);
}

main();
