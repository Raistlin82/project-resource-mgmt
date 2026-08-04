#!/usr/bin/env node
// @ts-check
/*
 * smoke-noauth.mjs — the gate that runs WITHOUT AUTH_TRUST_HEADERS.
 *
 * WHY THIS EXISTS. Every other gate in this repo (828 unit tests, 530 smoke
 * checks, ng build) runs against a server started with AUTH_TRUST_HEADERS=true.
 * That flag makes the spoofable X-User-* demo headers a *trusted principal* —
 * and the error interceptor stamps those headers on every same-origin /api call,
 * pre-authReady, defaulting to role 'employee'. So under every existing gate a
 * principal-less GET is answered 200, and the entire class of "this read fires
 * before the bearer token exists" defect is unobservable. That is exactly how a
 * deny-by-default read policy shipped on top of ~53 ungated client reads with
 * 828 green tests and 530 green smoke checks.
 *
 * This script is the missing configuration. It runs against a server started
 * with AUTH_TRUST_HEADERS *unset* and asserts three things:
 *
 *   A. STATIC — no field-init `rxResource` in src/app/ lacks `params`. An
 *      ungated read is the defect itself; catching it here is cheaper than
 *      catching it in production.
 *   B. HTTP — the two public bootstrap paths answer anonymously; every other
 *      /api GET answers 401 both anonymously AND with forged X-User-* headers.
 *      The forged-header case is what proves the server is really running
 *      untrusted (see assertHeadersUntrusted below) — without it this whole
 *      script could pass against a trusted-header server and mean nothing.
 *   C. SSR — every real route renders 200 AND the server emits no
 *      `[ui-error-boundary]` output and no `401 Unauthorized` while doing so.
 *      SSR renders with no bearer by definition, so this is the end-to-end
 *      observation of the client half: an ungated read shows up here as a
 *      401-caused render error. Requires the server's combined stdout+stderr in
 *      a file named by NOAUTH_SERVER_LOG; without it, part C FAILS rather than
 *      being skipped.
 *
 * Usage:
 *   PORT=4173 HOST=127.0.0.1 node dist/app/server/server.mjs > /tmp/noauth.log 2>&1 &
 *   SMOKE_BASE=http://127.0.0.1:4173 NOAUTH_SERVER_LOG=/tmp/noauth.log \
 *     node scripts/smoke-noauth.mjs
 *
 * Requires Node 20+ (global fetch). No test framework, no dependencies.
 * Exit code: 0 if every check passes, non-zero otherwise.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BASE = (process.env.SMOKE_BASE || 'http://127.0.0.1:4173').replace(/\/+$/, '');
const API = `${BASE}/api`;
const SERVER_LOG = process.env.NOAUTH_SERVER_LOG || '';

let passed = 0;
let failed = 0;

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** GET with no retry-on-429 games: this suite is ~80 requests, well under the limit. */
async function get(url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  const text = await res.text();
  return { status: res.status, raw: text };
}

// ---------------------------------------------------------------------------
// A. STATIC — every field-init rxResource must be gated.
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** Every `rxResource(...)` call whose options object has no `params` key. */
function ungatedReads(root = 'src/app') {
  const offenders = [];
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    if (!src.includes('rxResource')) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/\brxResource\s*[<(]/.test(lines[i])) continue;
      // Accumulate lines until the call's parentheses balance, then look for `params:`.
      let depth = 0, started = false, body = '';
      for (let j = i; j < lines.length; j++) {
        body += lines[j] + '\n';
        for (const ch of lines[j]) {
          if (ch === '(') { depth++; started = true; }
          else if (ch === ')') depth--;
        }
        if (started && depth <= 0) break;
      }
      if (!/\bparams\s*:/.test(body)) offenders.push(`${file}:${i + 1}`);
    }
  }
  return offenders;
}

function checkStatic() {
  const offenders = ungatedReads();
  check(
    'static: no field-init rxResource without params (use authGatedResource)',
    offenders.length === 0,
    offenders.length ? offenders.join(', ') : 'all reads gated',
  );
}

// ---------------------------------------------------------------------------
// B. HTTP — deny-by-default reads, and headers really are untrusted.
// ---------------------------------------------------------------------------

/** The two paths authz-policy.util.ts PUBLIC_READ_PATHS allows anonymously. */
const PUBLIC_PATHS = ['/storage-status'];

/**
 * One path per collection the client reads. Deliberately includes every path
 * that had NO READ_RULE and therefore flipped from anonymous-readable on main to
 * 401-without-a-principal on this branch — those are the ones whose client reads
 * broke.
 */
const GATED_PATHS = [
  '/projects', '/milestones', '/settings/hours-per-day', '/project-roles',
  '/project-partners', '/project-documents', '/work-packages', '/skills',
  '/skill-catalogs', '/proficiency-sets', '/countries', '/cities', '/vendors',
  '/cost-categories', '/industries', '/partner-roles', '/resource-organizations',
  '/service-organizations', '/project-issues', '/change-requests', '/project-tasks',
  '/languages', '/holidays', '/planning-periods', '/rate-cards', '/fx-rates',
  '/resources', '/assignments', '/requests', '/time-entries', '/customers',
  '/contracts', '/orders', '/order-lines', '/billing-plan-items',
  '/negotiated-rates', '/project-financials', '/cost-centers',
  '/project-cost-centers', '/approval-requests', '/audit-logs',
  '/self/profile', '/self/assignments', '/self/time-entries',
];

/** Forged demo headers. Trusted only under AUTH_TRUST_HEADERS=true (dev only). */
const FORGED = { 'X-User-Id': '1', 'X-User-Role': 'admin' };

/**
 * Self-check, and the reason the rest of part B is not vacuous: if a forged
 * admin header can read a gated path, the server under test IS trusting headers
 * and this script is measuring nothing. Fail hard and say so.
 */
async function assertHeadersUntrusted() {
  const { status } = await get(`${API}/projects`, FORGED);
  const ok = status === 401;
  check(
    'harness: server is running WITHOUT AUTH_TRUST_HEADERS',
    ok,
    ok
      ? 'forged X-User-Role: admin is refused'
      : `GET /api/projects with forged admin headers returned ${status}; restart the server with AUTH_TRUST_HEADERS unset`,
  );
  return ok;
}

async function checkPublicPaths() {
  for (const path of PUBLIC_PATHS) {
    const { status } = await get(`${API}${path}`);
    check(`GET ${path} is anonymous-readable`, status === 200, `status ${status}`);
  }
  // /health is in PUBLIC_READ_PATHS but has no route: it must pass the gate and
  // then 404 — never 401, which would mean the public list stopped working.
  const { status } = await get(`${API}/health`);
  check('GET /health passes the read gate anonymously', status !== 401, `status ${status}`);
}

async function checkGatedPaths() {
  for (const path of GATED_PATHS) {
    const anon = await get(`${API}${path}`);
    check(`GET ${path} without a principal is 401`, anon.status === 401, `status ${anon.status}`);
    const forged = await get(`${API}${path}`, FORGED);
    check(`GET ${path} with forged headers is 401`, forged.status === 401, `status ${forged.status}`);
  }
}

// ---------------------------------------------------------------------------
// C. SSR — every route renders with no bearer, and nothing 401s while it does.
// ---------------------------------------------------------------------------

/**
 * Every route in src/app/app.routes.ts that renders a component with data
 * reads. SSR runs with no bearer token by construction, so any ungated read
 * surfaces here.
 */
const SSR_ROUTES = [
  '/', '/profile', '/assignments', '/requests', '/resources', '/staffing',
  '/schedule', '/utilization', '/forecast', '/what-if', '/approvals',
  '/projects', '/projects/1', '/project-partners', '/project-documents',
  '/project-plans', '/financial-plans', '/project-cost-centers', '/project-tasks',
  '/project-issues', '/change-requests', '/customers', '/contracts',
  '/contracts/CT1', '/orders', '/billing', '/reporting', '/capacity',
  '/allocation-approvals', '/config/language', '/config/skill-catalogs',
  '/config/proficiency-sets', '/config/skills', '/config/project-roles',
  '/config/cost-centers', '/config/service-orgs', '/config/resource-orgs',
  '/config/locations', '/config/industries', '/config/cost-categories',
  '/config/partner-roles', '/config/vendors', '/config/rate-cards',
  '/config/availability', '/config/integrations',
];

/** Byte offset of the server log, so part C only judges its own requests. */
function logSize() {
  try {
    return statSync(SERVER_LOG).size;
  } catch {
    return -1;
  }
}

function logSince(offset) {
  try {
    const all = readFileSync(SERVER_LOG, 'utf8');
    return all.slice(offset);
  } catch {
    return '';
  }
}

async function checkSsrRoutes() {
  if (!SERVER_LOG) {
    check(
      'SSR: server log available for the render-error assertion',
      false,
      'NOAUTH_SERVER_LOG is unset — part C cannot observe a render error, so it is a FAILURE, not a skip',
    );
    return;
  }
  const before = logSize();
  if (before < 0) {
    check('SSR: server log available for the render-error assertion', false, `cannot stat ${SERVER_LOG}`);
    return;
  }

  for (const route of SSR_ROUTES) {
    const { status } = await get(`${BASE}${route}`);
    check(`SSR ${route} renders`, status === 200, `status ${status}`);
  }

  // Give the render's async tail a moment to flush into the log.
  await sleep(500);
  const appended = logSince(before);
  const boundary = (appended.match(/ui-error-boundary/g) || []).length;
  const unauthorized = (appended.match(/401 Unauthorized/g) || []).length;
  check(
    'SSR: no render reached the error boundary',
    boundary === 0,
    boundary === 0 ? 'clean' : `${boundary} [ui-error-boundary] line(s) — an ungated read 401'd during SSR`,
  );
  check(
    'SSR: no /api read 401d during a render',
    unauthorized === 0,
    unauthorized === 0 ? 'clean' : `${unauthorized} "401 Unauthorized" line(s) in the server log`,
  );
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`smoke-noauth against ${BASE}`);
  console.log('---------------------------------------------------------------');
  checkStatic();
  const untrusted = await assertHeadersUntrusted();
  if (!untrusted) {
    console.log('---------------------------------------------------------------');
    console.log(`SUMMARY  ${passed} passed, ${failed} failed (aborted: headers are trusted)`);
    process.exit(1);
  }
  await checkPublicPaths();
  await checkGatedPaths();
  await checkSsrRoutes();
  console.log('---------------------------------------------------------------');
  console.log(`SUMMARY  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
