# Faceted search (Block G) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a single cross-entity search surface — resources, projects, requests, and the commercial chain (customers/contracts/orders) — with server-side filtering and pagination from day one, RBAC that reuses each collection's own existing gate instead of inventing a new one, and a shared filter-bar component adopted by the two existing screens whose entity it covers (`resources.component.ts`, `projects.ts`) plus first-time adoption on `customers.ts`/`contracts.ts`/`orders.ts`.

**Architecture:** No new combined endpoint. Six existing collection reads (`GET /resources`, `/projects`, `/requests`, `/customers`, `/contracts`, `/orders`) gain optional `q`/`limit`/`offset` query parameters, each still gated by its own pre-existing `READ_RULES` entry — zero new authorization code. A new pure layer (`search.util.ts`) supplies the shared match/paginate logic, applied identically on both persistence adapters because it runs in-process after the existing, unmodified `repos.X.list()` call (no `pg_trgm`/`tsvector`, deferred — see spec §7). The `/search` page composes six parallel calls in one `forkJoin`, pre-filtering which sections to even attempt using the SAME `AuthService` capability getters (`canReadStaffing`, `canReadCommercial`) the existing route guards already use, then maps each settled/caught leg to one of four states (loading, results, empty, failed) — a 403 that slips through anyway (client/server drift) is a genuine anomaly and is allowed to toast via the existing global error interceptor, not suppressed.

**Tech Stack:** Angular 21 (standalone, signals, OnPush), Express 5, Vitest, dependency-free scripts. No schema change, no migration.

**Spec:** `docs/superpowers/specs/2026-08-05-g-faceted-search-design.md` — authoritative. Read the section named in each task. Its closed decisions are not renegotiable here; only wiring choices the spec left to implementation are this plan's own judgment calls.

## Global Constraints

- **Backward compatibility is non-negotiable (spec §3).** `GET /resources`, `/projects`, `/requests`, `/customers`, `/contracts`, `/orders` called with **no** query parameters must keep returning the exact same full, unfiltered, unpaginated array they return today — `resources.component.ts`, `staffing.component.ts`, `dashboard.component.ts`, `utilization.component.ts`, `reporting.ts`, `forecast.ts`, `billing.ts`, `allocation-approvals.component.ts` and others all call these with zero arguments today and expect the whole collection. Every task touching a handler carries an explicit regression check for this.
- **Displayed precision:** amounts, day/FTE counts and percentages never render with more than **2 decimals** — `digitsInfo` with `maxFractionDigits ≤ 2`; a bare `DecimalPipe` defaults to `1.0-3` and is non-compliant.
- **The `authReady` pattern:** every `rxResource` keys its **`params`** on `auth.authReady()` (folded in alongside the search term itself here, per `auth-gated-resource.util.ts:29-32`'s own note about reads keyed on more than readiness) and returns an empty default until it flips true. Never snapshot `auth.userId()`/`auth.role()` at field-init.
- **A failed or forbidden read must never render as a zero or an empty list presented as fact.** Four states per section (spec §5): loading, results, genuinely empty, failed — plus a fifth outer condition, "not permitted", which is not a `ListStateComponent` state but an `@if` that omits the whole section (header and count included).
- **RBAC is reused, never re-implemented.** No new `authorizeRead()` call, no new role array, no new `READ_RULES` entry. Every one of the six extended endpoints keeps exactly the READ_RULES entry it has today (spec §4).
- **`src/db/seed.ts` is the single source of truth for seed data** — this block adds **no new rows** (spec §14); every acceptance check in this plan is answerable from rows already present after Block F merged. If an implementer discovers a genuine gap, new ids start at `'20'` (verified live max at plan-writing time: resources `'9'`, requests/assignmentsBase `'11'` — re-verify before use, per this project's own repeated lesson about stale citations).
- **Angular 21 idiom:** standalone components, `OnPush`, `signal()`/`computed()`/`linkedSignal()`, native control flow, `inject()` in field initializers, lazy `loadComponent` routes.
- **Design system is bespoke, not Material** — `command-*` classes in `src/styles.css`. Do not invent class names that do not exist there — verify each one. `.command-chip` (871) needs a new tone-neutral "removable" modifier (no existing modifier covers a dismissible chip); every other class this plan uses (`.command-input` 921, `.command-select` 922, `.command-data-table` 1043, `.command-skeleton-row` 1170) already exists.
- **Tests are Vitest** via the `@angular/build:unit-test` builder; specs are `*.spec.ts` colocated with source. Commands: `npm test`, `npm run lint`, `npm run build`.

**Traps this repo has already charged for:**
- `[value]` on a `<select>` whose options come from `@for` is **silently dropped**; bind `[selected]` per `<option>` instead. The shared filter-bar's facet `<select>`s must use this form.
- `fixture.nativeElement.querySelector<T>()` does not compile — cast the host once (`fixture.nativeElement as HTMLElement`), then use plain `querySelector`.
- `whenStable()` hangs while an `rxResource` stream is open — use `await Promise.resolve(); fixture.detectChanges();` for a still-pending checkpoint.
- `??` treats an explicit `null` as absent — this block's query params are optional (`undefined` means "no filter"), never `null`; do not let a form control emit `null` for an empty search box (`FormControl('')`, non-nullable, avoids this).
- A discriminant literal must match the code's exact casing. This block introduces two: the per-section leg result's `status` (`'ok' | 'empty' | 'forbidden' | 'error'`) and nothing else — spell it identically everywhere it is compared.
- **A 403 toasting on every search for a role with partial commercial/staffing visibility would be a real regression**, not a hypothetical one: `error.interceptor.ts:57` toasts any 403 for an authenticated user. Task 6 avoids ever triggering it in the expected case by pre-filtering sections with `auth.canReadStaffing()`/`canReadCommercial()` before firing — an unexpected 403 (client/server drift) is left to toast, which is correct, not a bug to suppress.

**Ordering constraints:**
- Task 1 (pure layer) precedes Tasks 2-3 (server handlers consume it).
- Tasks 2-3 (server accepts `q`/`limit`/`offset`) precede Task 4 (client methods — meaningful only once the server honors the params) and Task 6 (search page — needs the client methods).
- Task 5 (shared component) precedes Tasks 6-9 (all its consumers).
- Tasks 7, 8, 9 (migrations) depend only on Task 5, not on Task 6 — they may land in any order relative to the search page itself, and in any order relative to each other.
- Task 10 (docs, sweep, full verification) is last.

---

### Task 1: `search.util.ts` — pure match/paginate layer

**Spec:** §7, §11 in full.

**Files:**
- Create: `src/app/services/search.util.ts`
- Test: `src/app/services/search.util.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces — Tasks 2-3 depend on these exact names/signatures:

```ts
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

export function clampSearchPage(raw: { limit?: unknown; offset?: unknown }): { limit: number; offset: number };
export function matchesQuery<T>(record: T, fields: readonly (keyof T)[], q: string): boolean;
export function searchPage<T>(
  records: readonly T[],
  fields: readonly (keyof T)[],
  q: string | undefined,
  page: { limit: number; offset: number },
): T[];
```

- [ ] **Step 1: Write the failing spec**

Create `src/app/services/search.util.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { clampSearchPage, matchesQuery, searchPage, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from './search.util';

interface Row { id: string; name: string; role?: string }
const ROWS: Row[] = [
  { id: '1', name: 'Julie Armstrong', role: 'Developer' },
  { id: '2', name: 'John Miller', role: 'Consultant' },
  { id: '3', name: 'Alice Smith', role: undefined },
];

describe('clampSearchPage (mirrors AUDIT_LOG_DEFAULT_LIMIT/AUDIT_LOG_MAX_LIMIT, server.ts:6521-6522, own thresholds)', () => {
  it('no params -> default limit, offset 0', () => expect(clampSearchPage({})).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 0 }));
  it('a limit under the max is honored', () => expect(clampSearchPage({ limit: '5' })).toEqual({ limit: 5, offset: 0 }));
  it('a limit over the max is clamped down, never rejected', () => expect(clampSearchPage({ limit: String(SEARCH_MAX_LIMIT + 50) })).toEqual({ limit: SEARCH_MAX_LIMIT, offset: 0 }));
  it('a non-numeric limit falls back to the default, not NaN or 0', () => expect(clampSearchPage({ limit: 'abc' })).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 0 }));
  it('a negative offset is floored to 0', () => expect(clampSearchPage({ offset: '-5' })).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 0 }));
  it('a positive offset is honored', () => expect(clampSearchPage({ offset: '10' })).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 10 }));
});

describe('matchesQuery (case-insensitive substring, spec §11 — same sophistication as resources.component.ts today, no more)', () => {
  it('matches a substring in the middle of a field, case-insensitive', () => expect(matchesQuery(ROWS[0], ['name'], 'ARMSTRONG')).toBe(true));
  it('does not match an absent substring', () => expect(matchesQuery(ROWS[0], ['name'], 'zzznonsense123')).toBe(false));
  it('matches on ANY of the listed fields, not just the first', () => expect(matchesQuery(ROWS[0], ['name', 'role'], 'developer')).toBe(true));
  it('an undefined field value never matches and never throws', () => expect(matchesQuery(ROWS[2], ['role'], 'anything')).toBe(false));
  it('an empty query matches everything (the caller is responsible for skipping the filter step entirely on an empty q)', () =>
    expect(matchesQuery(ROWS[0], ['name'], '')).toBe(true));
});

describe('searchPage (filter, when q is present, then paginate — identical on both adapters by construction, spec §7)', () => {
  it('q undefined -> the full array, unfiltered, in original order (the backward-compatibility case)', () =>
    expect(searchPage(ROWS, ['name'], undefined, { limit: 20, offset: 0 })).toEqual(ROWS));
  it('q defined and non-empty -> only matching rows', () =>
    expect(searchPage(ROWS, ['name'], 'Julie', { limit: 20, offset: 0 })).toEqual([ROWS[0]]));
  it('a nonsense term resolves successfully to an empty array, not an error', () =>
    expect(searchPage(ROWS, ['name'], 'zzznonsense123', { limit: 20, offset: 0 })).toEqual([]));
  it('pagination slices the MATCHED set, not the original array', () =>
    expect(searchPage(ROWS, ['name'], 'i', { limit: 1, offset: 1 })).toEqual([ROWS[1]])); // 'Julie'+'i', 'John'+'i' both match 'i'; offset 1 skips Julie's row
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/search.util.spec.ts'
```
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/app/services/search.util.ts`:

```ts
/**
 * Cross-entity search (Block G) — pure match/paginate layer. No I/O, no clock.
 *
 * Mirrors `/audit-logs`'s own clamp shape (`AUDIT_LOG_DEFAULT_LIMIT`/
 * `AUDIT_LOG_MAX_LIMIT`, `server.ts:6521-6522`) with this feature's own
 * thresholds, applied per-collection (design spec §7) rather than invented
 * once for a combined endpoint that does not exist here.
 *
 * Deliberately NOT adapter-aware: every caller applies this AFTER an
 * unmodified `repos.X.list()` call, the same call every existing read of
 * that collection already makes on either persistence adapter. There is no
 * `if (db) { SQL } else { ... }` branch here (contrast `/audit-logs`) because
 * there is no adapter-specific operator to run — parity is a consequence of
 * calling the SAME function once, not a second path to keep in sync
 * (design spec §7).
 */

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;

/** Clamp raw (string | undefined) query values into a safe {limit, offset} pair. */
export function clampSearchPage(raw: { limit?: unknown; offset?: unknown }): { limit: number; offset: number } {
  const rawLimit = Number(raw.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
  const rawOffset = Number(raw.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

/**
 * Case-insensitive substring match across one or more fields of T. A field
 * whose value is not a string (undefined, a number, ...) never matches and
 * never throws — this project's records carry several optional string
 * fields (e.g. `Resource.organization?`, `ResourceRequest.description?`).
 */
export function matchesQuery<T>(record: T, fields: readonly (keyof T)[], q: string): boolean {
  const needle = q.toLowerCase();
  return fields.some(field => {
    const value = record[field];
    return typeof value === 'string' && value.toLowerCase().includes(needle);
  });
}

/**
 * Filters (only when `q` is a non-empty string) then paginates. When `q` is
 * `undefined`, returns the FULL array unmodified — the backward-compatibility
 * invariant every existing caller of these six collections depends on
 * (design spec §3): omitting the query parameter must behave exactly as it
 * does today, on every one of these six endpoints.
 */
export function searchPage<T>(
  records: readonly T[],
  fields: readonly (keyof T)[],
  q: string | undefined,
  page: { limit: number; offset: number },
): T[] {
  if (q === undefined) return [...records];
  const trimmed = q.trim();
  const matched = trimmed === '' ? [...records] : records.filter(r => matchesQuery(r, fields, trimmed));
  return matched.slice(page.offset, page.offset + page.limit);
}
```

- [ ] **Step 4: Run it green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/search.util.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Mutate and confirm red (pick 3, revert after)**

1. In `clampSearchPage`, change `Math.min(rawLimit, SEARCH_MAX_LIMIT)` to `rawLimit`. Run the suite: **"a limit over the max is clamped down"** now fails. Revert.
2. In `matchesQuery`, remove the `typeof value === 'string'` guard. Run the suite: **"an undefined field value never matches and never throws"** now fails (throws on `.toLowerCase()` of `undefined`). Revert.
3. In `searchPage`, change `if (q === undefined) return [...records];` to `if (!q) return [...records];`. Run the suite: **"q defined and non-empty -> only matching rows"** still passes but add a quick manual check that `q=''` (empty string, not undefined) now ALSO shortcuts to unfiltered — which is already the documented behavior via the `trimmed === ''` branch two lines below, so this mutation is actually harmless; instead mutate `matched.slice(page.offset, page.offset + page.limit)` to `matched.slice(0, page.limit)` (drop offset). Run the suite: **"pagination slices the MATCHED set"** now fails (returns Julie's row instead of John's). Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/search.util.ts src/app/services/search.util.spec.ts
git commit -m "feat: search.util.ts — pure match/paginate layer for Block G"
```

---

### Task 2: Extend the five bespoke GET handlers with `q`/`limit`/`offset`

**Spec:** §3, §11 in full.

**Files:**
- Modify: `src/server.ts` — `/resources` (line 1701), `/projects` (line 4436), `/requests` (line 2156), `/contracts` (line 4739), `/orders` (line 4793)
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `searchPage`, `clampSearchPage` (Task 1).
- Produces: five extended handlers; Task 4 depends on their query-param contract (`q?`, `limit?`, `offset?`, all optional, `q` absent ⇒ unchanged full-array response).

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-api.mjs`, add (model directly on `checkCapacityMonthly`, line 1118):

```js
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
  {
    const byName = await req('GET', '/orders?q=Globex');
    check('orders?q=Globex (a customer name, not an invoiceNumber) matches NOTHING -- orders do not join to their parent contract/customer name (spec §11)', Array.isArray(byName.body) && byName.body.length === 0, JSON.stringify(byName.body));
    const byInvoice = await req('GET', '/orders?q=INV-2026-0001');
    check('orders?q=INV-2026-0001 matches EXACTLY order O1', Array.isArray(byInvoice.body) && byInvoice.body.length === 1 && byInvoice.body[0].id === 'O1', JSON.stringify(byInvoice.body?.map((o) => o.id)));
  }
}
```

Register it in `main()` right after `checkBenchMonthly()`:

```js
  try {
    await checkSearchableReads();
  } catch (err) {
    console.log(`FAIL  searchable reads (Block G) — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }
```

- [ ] **Step 2: Run the smoke suite to see it fail**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4176 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4176 node scripts/smoke-api.mjs
kill %1
```
Expected: every new `q=`-bearing check FAILS (the param is silently ignored today, so `q=Julie` still returns the full 9-row array, not 1 row); the backward-compatibility checks (no `q`) already PASS today (nothing to break yet).

- [ ] **Step 3: Implement — `/resources` (server.ts:1701)**

```ts
import { searchPage, clampSearchPage } from './app/services/search.util';
```

(add next to the existing `capacity.util`/`bench.util` imports near the top of `server.ts`)

Replace line 1701:

```ts
apiRouter.get('/resources', async (_req, res) => { res.json(await resolveResourceRates(await repos.resources.list())); });
```

with:

```ts
apiRouter.get('/resources', async (req, res) => {
  const all = await repos.resources.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  const page = q === undefined ? all : searchPage(all, ['name', 'role', 'organization', 'location'], q, clampSearchPage(req.query));
  res.json(await resolveResourceRates(page));
});
```

Note the resolution order: `searchPage` runs on the RAW (unresolved-rate) rows first, then `resolveResourceRates` runs only on the matched page — never the whole collection. Matching is on `name`/`role`/`organization`/`location`, none of which depends on rate resolution, so this is safe and cheaper than resolving rates for every resource on every search.

- [ ] **Step 4: Implement — `/projects` (server.ts:4436)**

Replace:

```ts
apiRouter.get('/projects', async (_req, res) => { res.json(await repos.projects.list()); });
```

with:

```ts
apiRouter.get('/projects', async (req, res) => {
  const all = await repos.projects.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  res.json(q === undefined ? all : searchPage(all, ['name', 'location'], q, clampSearchPage(req.query)));
});
```

- [ ] **Step 5: Implement — `/requests` (server.ts:2156)**

Replace:

```ts
apiRouter.get('/requests', async (_req, res) => { res.json(await repos.requests.list()); });
```

with:

```ts
apiRouter.get('/requests', async (req, res) => {
  const all = await repos.requests.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  res.json(q === undefined ? all : searchPage(all, ['name', 'description'], q, clampSearchPage(req.query)));
});
```

- [ ] **Step 6: Implement — `/contracts` (server.ts:4739)**

Replace:

```ts
apiRouter.get('/contracts', async (_req, res) => { res.json(await repos.contracts.list()); });
```

with:

```ts
apiRouter.get('/contracts', async (req, res) => {
  const all = await repos.contracts.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  res.json(q === undefined ? all : searchPage(all, ['name'], q, clampSearchPage(req.query)));
});
```

- [ ] **Step 7: Implement — `/orders` (server.ts:4793)**

Replace:

```ts
apiRouter.get('/orders', async (_req, res) => { res.json(await repos.orders.list()); });
```

with:

```ts
apiRouter.get('/orders', async (req, res) => {
  const all = await repos.orders.list();
  const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
  // Orders have no name/title field (api.service.ts:660-672) -- match ONLY
  // invoiceNumber, never the parent contract/customer's name (design spec §11:
  // no join, to stay in the same "one filter per collection" shape as every
  // other handler in this task).
  res.json(q === undefined ? all : searchPage(all, ['invoiceNumber'], q, clampSearchPage(req.query)));
});
```

- [ ] **Step 8: Run the smoke suite green, then the gates**

```bash
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4176 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4176 node scripts/smoke-api.mjs
kill %1
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 9: Mutate and confirm red**

In the `/orders` handler, change `['invoiceNumber']` to `['invoiceNumber', 'type']`. Run the smoke suite: no existing check catches this (there is no seed order whose `type` contains "Globex" or similar) — this demonstrates the SPECIFIC regression this task's `orders?q=Globex` check exists to catch is about the JOIN risk, not the field list; instead mutate the real risk: change `q === undefined ? all : searchPage(...)` to always call `searchPage(all, ['invoiceNumber'], q ?? '', clampSearchPage(req.query))` (drop the `undefined` short-circuit). Run the smoke suite: **"GET /api/resources?limit=5 with no q STILL returns the full array"**-style checks on `/orders` (add one if not already covered by Step 1's `/resources` check, which exercises the same code shape) now fail — an omitted `q` on `/orders` now returns only the first `SEARCH_DEFAULT_LIMIT` (20) rows instead of all 3. Since `/orders` only has 3 seed rows this wouldn't visibly break, so run the mutation against `/resources` instead (9 rows, still under 20 — use `/resources?limit=1` with no `q` after the same mutation applied there) to see **"GET /api/resources?limit=5 with no q STILL returns the full array"** go red. Revert.

- [ ] **Step 10: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat: q/limit/offset on /resources, /projects, /requests, /contracts, /orders — unchanged RBAC, unchanged no-arg behavior"
```

---

### Task 3: Extend `crud()` and wire `/customers`

**Spec:** §3, §11.

**Files:**
- Modify: `src/server.ts` — `crud()` (line 772), the `/customers` call site (line 4693)
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `searchPage`, `clampSearchPage` (Task 1).
- Produces: `crud()`'s new optional 6th parameter; the other 11 call sites are unaffected (default `[]`).

- [ ] **Step 1: Write the failing smoke check**

Add to `scripts/smoke-api.mjs`, inside `checkSearchableReads` (Task 2), after the orders block:

```js
  {
    const { status, body } = await req('GET', '/customers?q=Globex');
    check('GET /api/customers?q=Globex -> 200', status === 200, `status=${status}`);
    check('customers?q=Globex returns EXACTLY customer C1', Array.isArray(body) && body.length === 1 && body[0].id === 'C1', JSON.stringify(body?.map((c) => c.id)));
  }
  {
    const noQ = await req('GET', '/vendors'); // an UNRELATED crud()-mounted collection -- must be completely unaffected by this task
    check('GET /api/vendors (untouched crud() caller) still returns the full array with no searchable param passed', Array.isArray(noQ.body) && noQ.body.length > 0, `length=${noQ.body?.length}`);
  }
```

- [ ] **Step 2: Run it to verify the customers check fails**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4176 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4176 node scripts/smoke-api.mjs
kill %1
```
Expected: the `customers?q=Globex` check FAILS (returns all customers, `q` is ignored); the `/vendors` check already PASSES (nothing to break yet — it stays green through this whole task, which is the point).

- [ ] **Step 3: Extend `crud()`'s signature and GET route**

In `src/server.ts`, add the import (if Task 2 has not already added it to this file):

```ts
import { searchPage, clampSearchPage } from './app/services/search.util';
```

Replace the `crud()` function signature and its `router.get` line (`server.ts:772` onward):

```ts
function crud<T extends { id: string }>(
  router: Router,
  path: string,
  repo: Repository<T>,
  allowed: readonly string[],
  numericFields: readonly string[] = [],
  validate?: (data: Record<string, unknown>, ctx?: { id?: string }) => Promise<string | null>,
  // Block G: optional fields this collection's GET should text-match on.
  // Default [] -- every OTHER crud() caller (cities, industries,
  // cost-categories, partner-roles, vendors, rate-cards, project-partners,
  // project-documents, work-packages, project-financials, project-tasks,
  // project-issues, cost-centers) passes nothing here and is byte-for-byte
  // unaffected: `q` is simply never read for their GET route.
  searchable: readonly (keyof T)[] = [],
) {
  router.get(`/${path}`, async (req, res) => {
    const all = await repo.list();
    if (searchable.length === 0) { res.json(all); return; } // unchanged for every non-searchable caller
    const q = typeof req.query['q'] === 'string' ? req.query['q'] : undefined;
    res.json(q === undefined ? all : searchPage(all, searchable, q, clampSearchPage(req.query)));
  });
  router.post(`/${path}`, async (req, res) => {
    // ... unchanged, rest of the function is untouched
```

- [ ] **Step 4: Wire the `/customers` call site (server.ts:4693)**

```ts
crud(apiRouter, 'customers', repos.customers, ['name', 'industry', 'country'], [], async data => {
  // ... existing validator body, unchanged
}, ['name']);
```

(the 7th positional argument in the call becomes the 6th PARAMETER `searchable` — count carefully: `path, repo, allowed, numericFields, validate, searchable` is 6 params after `router`; the existing call already passes `router` implicitly via `apiRouter` as the first arg, then 5 more, so this adds exactly one trailing argument.)

- [ ] **Step 5: Run the smoke suite green, then the gates**

```bash
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4176 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4176 node scripts/smoke-api.mjs
kill %1
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 6: Mutate and confirm red**

In `crud()`'s new GET route, delete the `if (searchable.length === 0) { res.json(all); return; }` short-circuit line. Run the smoke suite: **"GET /api/vendors (untouched crud() caller) still returns the full array"** — this specific check does not actually go red from this mutation (an empty `searchable` array still falls through to `clampSearchPage`/`searchPage` with `q` undefined, which per Task 1's own `searchPage` returns the full array unchanged regardless) — this is a DELIBERATE double-layer safety, not a redundant one: instead mutate `clampSearchPage(req.query)` to always apply even when `searchable.length === 0` AND additionally change `search.util.ts`'s own `searchPage` to default `q` to `''` instead of leaving it `undefined` in a hypothetical future caller — since that mutation is speculative and not reachable from `crud()`'s current call sites, perform the REAL mutation instead: temporarily pass `['name', 'industry', 'country']` (all three original `allowed` fields) as `searchable` for `/vendors`'s own `crud()` call (`server.ts`, the vendors line) instead of leaving it at the default `[]`. Run the smoke suite: **"GET /api/vendors (untouched crud() caller) still returns the full array"** now still passes (no `q` was sent, so behavior is identical) but a NEW manual check `GET /vendors?q=<any vendor name>` now returns a filtered array where it did not before — confirming the parameter genuinely does nothing until a caller opts in. Revert the vendors call site back to no 6th argument.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat: crud() gains an opt-in searchable-fields parameter, wired for /customers only"
```

---

### Task 4: Client — extend the six `ApiService` methods

**Spec:** §3, §11.

**Files:**
- Modify: `src/app/services/api.service.ts` — `getResources()` (921), `getRequests()` (979), `getProjects()` (1255), `getCustomers()` (1320), `getContracts()` (1325), `getOrders()` (1330)

**Interfaces:**
- Consumes: nothing new server-side (Tasks 2-3 already shipped the query params).
- Produces — Tasks 6-9 depend on this exact shape, repeated identically for all six methods:

```ts
export interface SearchOpts { q?: string; limit?: number; offset?: number }
getResources(opts?: SearchOpts): Observable<Resource[]>;
getRequests(opts?: SearchOpts): Observable<ResourceRequest[]>;
getProjects(opts?: SearchOpts): Observable<Project[]>;
getCustomers(opts?: SearchOpts): Observable<Customer[]>;
getContracts(opts?: SearchOpts): Observable<Contract[]>;
getOrders(opts?: SearchOpts): Observable<Order[]>;
```

- [ ] **Step 1: Add the shared `SearchOpts` type and a private param-builder**

Near the top of `api.service.ts`, beside the other exported interfaces:

```ts
/** Block G: optional query params any of the six searchable collection reads accept. */
export interface SearchOpts { q?: string; limit?: number; offset?: number }
```

As a private method on `ApiService` (placed near the top of the class body, before its first use):

```ts
private searchParams(opts?: SearchOpts): HttpParams {
  let params = new HttpParams();
  if (opts?.q) params = params.set('q', opts.q);
  if (opts?.limit !== undefined) params = params.set('limit', opts.limit);
  if (opts?.offset !== undefined) params = params.set('offset', opts.offset);
  return params;
}
```

- [ ] **Step 2: Extend `getResources()` (line 921)**

Replace:

```ts
getResources(): Observable<Resource[]> {
  return this.http.get<Resource[]>(`${this.baseUrl}/resources`);
}
```

with:

```ts
getResources(opts?: SearchOpts): Observable<Resource[]> {
  return this.http.get<Resource[]>(`${this.baseUrl}/resources`, { params: this.searchParams(opts) });
}
```

- [ ] **Step 3: Extend `getRequests()`, `getProjects()`, `getCustomers()`, `getContracts()`, `getOrders()` identically**

Same transformation at each of the remaining five lines (979, 1255, 1320, 1325, 1330) — add the `opts?: SearchOpts` parameter and pass `{ params: this.searchParams(opts) }` as the second argument to `this.http.get`. `getCustomers()`/`getContracts()`/`getOrders()` are currently one-liners (`return this.http.get<Customer[]>(...)`); keep them one-liners, just add the params object.

- [ ] **Step 4: Run the existing suite (regression gate — no behavior change for any existing caller)**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```
Expected: fully green — every existing call site (`this.api.getResources()`, no arguments) still compiles and behaves identically, since `opts` is optional and an absent `HttpParams` entry is indistinguishable from today's param-less request.

- [ ] **Step 5: Write a focused unit test proving the param wiring**

Create/extend `src/app/services/api.service.spec.ts` if one exists, or add inline near existing `ApiService` tests (check first with `find src/app/services -iname "api.service.spec.ts"` — if absent, this step verifies wiring via Task 6's component test instead, since `ApiService` itself has no dedicated spec file in this codebase today; do not create one solely for this — extending an existing test file is preferred, adding a new one is not, per this project's own convention of not inventing a tenth pattern where a consumer test already covers the wiring). If `api.service.spec.ts` exists, add:

```ts
it('getResources(opts) forwards q/limit/offset as query params', () => {
  const httpMock = TestBed.inject(HttpTestingController);
  service.getResources({ q: 'Julie', limit: 5, offset: 10 }).subscribe();
  const request = httpMock.expectOne(req => req.url.endsWith('/resources'));
  expect(request.request.params.get('q')).toBe('Julie');
  expect(request.request.params.get('limit')).toBe('5');
  expect(request.request.params.get('offset')).toBe('10');
  request.flush([]);
});
```

- [ ] **Step 6: Commit**

```bash
git add src/app/services/api.service.ts src/app/services/api.service.spec.ts
git commit -m "feat: getResources/getRequests/getProjects/getCustomers/getContracts/getOrders accept optional q/limit/offset"
```

---

### Task 5: `search-filter-bar.component.ts` — the shared component

**Spec:** §8 in full.

**Files:**
- Create: `src/app/shared/search-filter-bar.component.ts`
- Test: `src/app/shared/search-filter-bar.component.spec.ts`
- Modify: `src/styles.css` — one new `.command-chip` modifier (removable)

**Interfaces:**
- Consumes: `.command-input`, `.command-select`, `.command-chip` (existing).
- Produces — Tasks 6, 7, 8, 9 depend on this exact shape:

```ts
export interface FacetOption { value: string; label: string }
export interface Facet {
  id: string;
  label: string;
  options: readonly FacetOption[];
  value: string; // '' means "no filter" for this facet
}

@Component({ selector: 'app-search-filter-bar', ... })
export class SearchFilterBarComponent {
  query = input('');
  facets = input<readonly Facet[]>([]);
  placeholder = input('Search...');
  queryChange = output<string>();
  facetChange = output<{ id: string; value: string }>();
  clearAll = output<void>();
}
```

- [ ] **Step 1: Add the chip modifier to `src/styles.css`**

Beside the existing `.command-chip.is-*` tone modifiers (`styles.css:886-910`), add:

```css
.command-chip.is-removable {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}
.command-chip.is-removable button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font-size: 0.875rem;
  line-height: 1;
}
```

- [ ] **Step 2: Write the failing component test**

Create `src/app/shared/search-filter-bar.component.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SearchFilterBarComponent, type Facet } from './search-filter-bar.component';

const FACETS: Facet[] = [
  { id: 'kind', label: 'Kind', options: [{ value: 'internal', label: 'Internal' }, { value: 'subco', label: 'Subco' }], value: '' },
];

describe('SearchFilterBarComponent', () => {
  async function setup(query = '', facets: readonly Facet[] = FACETS) {
    await TestBed.configureTestingModule({
      imports: [SearchFilterBarComponent],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(SearchFilterBarComponent);
    fixture.componentRef.setInput('query', query);
    fixture.componentRef.setInput('facets', facets);
    fixture.detectChanges();
    return fixture;
  }

  it('emits queryChange when the text box changes', async () => {
    const fixture = await setup();
    let emitted = '';
    fixture.componentInstance.queryChange.subscribe(v => (emitted = v));
    const input = (fixture.nativeElement as HTMLElement).querySelector('input[data-test="filter-bar-query"]') as HTMLInputElement;
    input.value = 'Julie';
    input.dispatchEvent(new Event('input'));
    expect(emitted).toBe('Julie');
  });

  it('emits facetChange with the facet id and selected value', async () => {
    const fixture = await setup();
    let emitted: { id: string; value: string } | undefined;
    fixture.componentInstance.facetChange.subscribe(v => (emitted = v));
    const select = (fixture.nativeElement as HTMLElement).querySelector('select[data-test="filter-bar-facet-kind"]') as HTMLSelectElement;
    select.value = 'subco';
    select.dispatchEvent(new Event('change'));
    expect(emitted).toEqual({ id: 'kind', value: 'subco' });
  });

  it('renders one removable chip per active facet, none for an empty facet', async () => {
    const fixture = await setup('', [{ ...FACETS[0], value: 'subco' }]);
    const chips = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="filter-bar-chip"]');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('Subco');
  });

  it('renders a query chip when query is non-empty', async () => {
    const fixture = await setup('Julie');
    const chips = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="filter-bar-chip"]');
    expect(chips.length).toBe(1);
    expect(chips[0].textContent).toContain('Julie');
  });

  it('clearAll emits when the Clear all button is clicked, only rendered when at least one filter is active', async () => {
    const fixture = await setup('Julie');
    let cleared = false;
    fixture.componentInstance.clearAll.subscribe(() => (cleared = true));
    const btn = (fixture.nativeElement as HTMLElement).querySelector('[data-test="filter-bar-clear-all"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(cleared).toBe(true);
  });

  it('does NOT render the Clear all button when no filter is active', async () => {
    const fixture = await setup('');
    const btn = (fixture.nativeElement as HTMLElement).querySelector('[data-test="filter-bar-clear-all"]');
    expect(btn).toBeFalsy();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/search-filter-bar.component.spec.ts'
```
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement**

Create `src/app/shared/search-filter-bar.component.ts`:

```ts
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export interface FacetOption { value: string; label: string }
export interface Facet {
  id: string;
  label: string;
  options: readonly FacetOption[];
  value: string; // '' means "no filter" for this facet
}

/**
 * Generic text-box + N `<select>` facets + active-filter chips + Clear all
 * (design spec §8). Deliberately dumb: it holds no filtering logic of its
 * own and knows nothing about resources/projects/etc. — every consumer
 * (Tasks 6-9) supplies its own facet option lists and reacts to
 * (queryChange)/(facetChange)/(clearAll) by updating ITS OWN state and
 * re-fetching. Reuses `.command-input`/`.command-select` (styles.css:921-922)
 * and `.command-chip` (871) with the new `.is-removable` modifier (this task,
 * Step 1) — no other class invented.
 */
@Component({
  selector: 'app-search-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-3">
      <div class="flex flex-col sm:flex-row gap-3">
        <input
          data-test="filter-bar-query"
          type="text"
          class="command-input flex-1"
          [attr.placeholder]="placeholder()"
          [value]="query()"
          (input)="queryChange.emit($any($event.target).value)"
        />
        @for (facet of facets(); track facet.id) {
          <select
            [attr.data-test]="'filter-bar-facet-' + facet.id"
            [attr.aria-label]="facet.label"
            class="command-select sm:w-48"
            (change)="facetChange.emit({ id: facet.id, value: $any($event.target).value })"
          >
            <option value="" [selected]="facet.value === ''">All {{ facet.label }}</option>
            @for (opt of facet.options; track opt.value) {
              <option [value]="opt.value" [selected]="opt.value === facet.value">{{ opt.label }}</option>
            }
          </select>
        }
      </div>
      @if (activeChips().length > 0) {
        <div class="flex flex-wrap items-center gap-2">
          @for (chip of activeChips(); track chip.key) {
            <span class="command-chip is-neutral is-removable" data-test="filter-bar-chip">
              {{ chip.text }}
              <button type="button" [attr.aria-label]="'Remove ' + chip.text" (click)="removeChip(chip.key)">&times;</button>
            </span>
          }
          <button type="button" class="command-chip is-removable" data-test="filter-bar-clear-all" (click)="clearAll.emit()">
            Clear all
          </button>
        </div>
      }
    </div>
  `,
})
export class SearchFilterBarComponent {
  readonly query = input('');
  readonly facets = input<readonly Facet[]>([]);
  readonly placeholder = input('Search...');

  readonly queryChange = output<string>();
  readonly facetChange = output<{ id: string; value: string }>();
  readonly clearAll = output<void>();

  protected readonly activeChips = computed(() => {
    const chips: { key: string; text: string }[] = [];
    if (this.query()) chips.push({ key: 'query', text: this.query() });
    for (const facet of this.facets()) {
      if (!facet.value) continue;
      const opt = facet.options.find(o => o.value === facet.value);
      chips.push({ key: facet.id, text: opt?.label ?? facet.value });
    }
    return chips;
  });

  protected removeChip(key: string): void {
    if (key === 'query') { this.queryChange.emit(''); return; }
    this.facetChange.emit({ id: key, value: '' });
  }
}
```

- [ ] **Step 5: Run it green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/search-filter-bar.component.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 6: Mutate and confirm red**

In `activeChips()`, change `if (!facet.value) continue;` to `if (facet.value === undefined) continue;` (an empty string `''` no longer skipped). Run the suite: **"renders one removable chip per active facet, none for an empty facet"** now fails (a chip appears for the default `''`-valued facet too). Revert.

- [ ] **Step 7: Commit**

```bash
git add src/app/shared/search-filter-bar.component.ts src/app/shared/search-filter-bar.component.spec.ts src/styles.css
git commit -m "feat: SearchFilterBarComponent — shared text+facets+chips filter bar"
```

---

### Task 6: `/search` route and `search.component.ts` page

**CORRECTION (plan defect, fixed against the spec, not the other way around):**
The version of this task originally checked into this plan collapsed all six
sections onto a single `submittedQuery` signal — explicit-submit-only for
EVERY section — under a "v1 simplification" framing, with `submitQuery` cited
as "the seam a debounce timer would call automatically... in a follow-up."
That silently overrode design spec §6, Decision 4, which this document's own
preamble states is **closed**: *"Le quattro decisioni di prodotto che seguono
sono chiuse: sono scritte come design, non come opzioni"* (the four product
decisions are closed — written as design, not options). Decision 4 is a
deliberate product choice the human owner made — explicit submit for the two
highest-cardinality collections (Resources, Requests) to keep server load
predictable, live search with a 300ms debounce for the four collections that
never had ANY filter before this block (Projects, Customers, Contracts,
Orders) because a per-keystroke-pause request there is cheap and the UX
payoff is real. The plan is what was wrong; the spec was always correct and
is untouched. This section now implements §6 as written: **explicit submit
for Resources and Requests; live search with a 300ms debounce for Projects,
Customers, Contracts and Orders** — one shared search box drives both timing
modes at once, keyed off a single `SEARCH_TIMING` map (not duplicated per
section) so a future section cannot silently pick up the wrong mode in one
place while the rest of the code assumes another. The debounce is
browser-only (guarded by `isPlatformBrowser`, mirroring
`NotificationService`'s own established rule that a timer must never be
scheduled during SSR) — a per-request Node process could otherwise carry a
scheduled callback across into a later, unrelated request.

**Spec:** §4, §5, §6, §9, §11 in full.

**Files:**
- Create: `src/app/search/search.component.ts`
- Test: `src/app/search/search.component.spec.ts`
- Modify: `src/app/app.routes.ts` — new route
- Modify: `src/app/app.ts` — new nav entry

**Interfaces:**
- Consumes: `getResources`/`getRequests`/`getProjects`/`getCustomers`/`getContracts`/`getOrders` (Task 4); `AuthService.canReadStaffing()`/`canReadCommercial()`/`authReady()` (existing); `ListStateComponent` (existing).
- Produces: the `/search` page; nothing later tasks depend on.

- [ ] **Step 1: Route and nav**

In `src/app/app.routes.ts`, add after the `projects` route (line 19), matching its no-guard shape:

```ts
  { path: 'search', title: 'Search', loadComponent: () => import('./search/search.component').then(m => m.SearchComponent) },
```

In `src/app/app.ts`, add to the `Resource Control` group's items array (right after `Dashboard`, line 404):

```ts
        { label: 'Search', icon: 'search', route: '/search' },
```

No change needed to the `navGroups` filter function for the `Resource Control` group — an unmatched route already falls through to `return true` (always visible), which is exactly what `/search` needs (any authenticated principal, mirroring `/projects`'s own open-read RBAC, spec §9).

- [ ] **Step 2: Write the failing component test**

Create `src/app/search/search.component.spec.ts`. Covers BOTH timing paths
separately (spec §6, Decision 4), plus the negative case for each, plus the
coalescing guarantee the decision exists for, plus the SSR guard:

```ts
import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { SearchComponent } from './search.component';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';

function apiStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getResources: () => of([{ id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]),
    getRequests: () => of([]),
    getProjects: () => of([{ id: '1', name: 'Project Alpha', location: 'Berlin' }]),
    getCustomers: () => of([]),
    getContracts: () => of([]),
    getOrders: () => of([]),
    ...overrides,
  };
}

describe('SearchComponent', () => {
  async function setup(
    apiOverrides: Partial<Record<string, unknown>> = {},
    authOverrides: Partial<Record<string, unknown>> = {},
    platform = 'browser',
  ) {
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: ApiService, useValue: apiStub(apiOverrides) },
        { provide: AuthService, useValue: { authReady: () => true, canReadStaffing: () => true, canReadCommercial: () => true, ...authOverrides } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SearchComponent);
    fixture.detectChanges();
    return fixture;
  }

  /** Flushes the still-pending rxResource stream (params effect -> stream() ->
   *  forkJoin resolution -> value() update -> render). A single microtask tick
   *  is not enough for a chain this long under zoneless CD; loop a few rounds
   *  rather than guess a magic number of awaits per call site. */
  async function flush(fixture: { detectChanges(): void }, rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
      fixture.detectChanges();
    }
  }

  async function setupAndSubmit(
    apiOverrides: Partial<Record<string, unknown>> = {},
    authOverrides: Partial<Record<string, unknown>> = {},
  ) {
    const fixture = await setup(apiOverrides, authOverrides);
    fixture.componentInstance.submitQuery('Julie');
    await flush(fixture);
    return fixture;
  }

  // --- Explicit-submit path (spec §6: Resources/Requests, and Enter always
  // resolves every section immediately, including the live ones) ---

  it('a matching resource renders in the Resources section', async () => {
    const fixture = await setupAndSubmit();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Armstrong');
  });

  it('a role without canReadStaffing never even requests /resources, and the section does not render', async () => {
    const calls: string[] = [];
    const fixture = await setupAndSubmit(
      { getResources: () => { calls.push('resources'); return of([]); } },
      { canReadStaffing: () => false },
    );
    const host = fixture.nativeElement as HTMLElement;
    expect(calls).not.toContain('resources');
    expect(host.querySelector('[data-test="section-resources"]')).toBeFalsy();
  });

  it('a genuinely empty result renders "no results", not an error and not a missing section', async () => {
    const fixture = await setupAndSubmit({ getProjects: () => of([]) });
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="section-projects"]')!;
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('No results');
  });

  it('a network error on one section shows Retry there, while the other section still shows its own results', async () => {
    const fixture = await setupAndSubmit({ getProjects: () => throwError(() => new HttpErrorResponse({ status: 500 })) });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-projects"]')!.textContent).toContain('Retry');
    expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Armstrong');
  });

  it('a 403 on one section (unexpected, despite the capability pre-filter) omits the section rather than showing an error panel', async () => {
    const fixture = await setupAndSubmit({ getResources: () => throwError(() => new HttpErrorResponse({ status: 403 })) });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-resources"]')).toBeFalsy();
  });

  // --- Live-debounce path (spec §6, Decision 4: Projects/Customers/Contracts/
  // Orders auto-search 300ms after the last keystroke, WITHOUT Enter) ---

  describe('live-debounced sections (spec §6, Decision 4)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('typing into the box fires the Projects (live) section after the debounce, not before', async () => {
      const getProjects = vi.fn(() => of([{ id: '1', name: 'Project Alpha', location: 'Berlin' }]));
      const fixture = await setup({ getProjects });

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Alpha');
      await flush(fixture);

      // Before the debounce elapses: not called, section not rendered.
      vi.advanceTimersByTime(299);
      await flush(fixture);
      expect(getProjects).not.toHaveBeenCalled();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-projects"]')).toBeFalsy();

      // Once the debounce elapses: fired, section renders.
      vi.advanceTimersByTime(1);
      await flush(fixture);
      expect(getProjects).toHaveBeenCalledWith({ q: 'Alpha' });
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-projects"]')!.textContent).toContain('Project Alpha');
    });

    it('typing into the box fires NOTHING in the Resources (explicit-submit) section until Enter, however long you wait', async () => {
      const getResources = vi.fn(() => of([{ id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]));
      const fixture = await setup({ getResources });

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Julie');
      vi.advanceTimersByTime(10_000); // far beyond any debounce window
      await flush(fixture);

      expect(getResources).not.toHaveBeenCalled();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-resources"]')).toBeFalsy();

      // Confirm Enter is what actually releases it (rules out a broken test
      // double that would trivially "pass" by never firing at all).
      (fixture.componentInstance as unknown as { submitNow(): void }).submitNow();
      await flush(fixture);
      expect(getResources).toHaveBeenCalledWith({ q: 'Julie' });
    });

    it('rapid keystrokes coalesce into ONE query, not one request per keystroke', async () => {
      const getProjects = vi.fn(() => of([]));
      const fixture = await setup({ getProjects });
      const instance = fixture.componentInstance as unknown as { onInput(v: string): void };

      instance.onInput('J');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Ju');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Jul');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Julie');
      vi.advanceTimersByTime(300); // full debounce from the LAST keystroke only
      await flush(fixture);

      expect(getProjects).toHaveBeenCalledTimes(1);
      expect(getProjects).toHaveBeenCalledWith({ q: 'Julie' });
    });

    it('the debounce timer is browser-only: on the server, typing schedules nothing, however long fake time advances', async () => {
      const getProjects = vi.fn(() => of([]));
      const fixture = await setup({ getProjects }, {}, 'server');

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Alpha');
      vi.advanceTimersByTime(10_000);
      await flush(fixture);

      expect(getProjects).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/search.component.spec.ts'
```
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement `search.component.ts`**

```ts
import { ChangeDetectionStrategy, Component, DestroyRef, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, forkJoin, map, of, type Observable } from 'rxjs';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ListStateComponent } from '../shared/list-state.component';
import type { Resource, ResourceRequest, Project, Customer, Contract, Order } from '../services/api.service';

/** One collection's outcome for this search (design spec §5's four states, minus
 *  "loading" which is the whole rxResource's own isLoading(), not per-leg). */
type SectionResult<T> =
  | { status: 'ok'; rows: T[] }
  | { status: 'forbidden' }
  | { status: 'error' };

type SectionKey = 'resources' | 'requests' | 'projects' | 'customers' | 'contracts' | 'orders';

/**
 * Design spec §6, Decision 4 (CLOSED — a deliberate product decision the human
 * owner made, not a wiring choice left to implementation): which of the six
 * sections wait for an explicit submit (Enter) versus live-search with a
 * debounce. This is the ONLY place that split is decided — every consumer
 * below reads through this map rather than re-testing entity names, so a
 * future section added here cannot silently pick up the wrong timing mode in
 * one spot while the rest of the code assumes another.
 *
 *  - 'submit' (Resources, Requests): the highest-cardinality collections in
 *    the app (hundreds of rows in production, not the seed's handful) — even
 *    a debounce still fires one request per typing pause, so these wait for
 *    an explicit Enter to keep server load predictable.
 *  - 'live' (Projects, Customers, Contracts, Orders): lower-cardinality
 *    collections — Customers/Contracts/Orders never had ANY filter before
 *    this block (spec §1) — where a per-pause request is an acceptable cost
 *    in exchange for a more fluid search experience.
 */
const SEARCH_TIMING: Record<SectionKey, 'submit' | 'live'> = {
  resources: 'submit',
  requests: 'submit',
  projects: 'live',
  customers: 'live',
  contracts: 'live',
  orders: 'live',
};

/** How long a 'live' section waits after the last keystroke before firing
 *  (spec §6, Decision 4). */
const LIVE_SEARCH_DEBOUNCE_MS = 300;

interface SearchResults {
  resources: SectionResult<Resource> | undefined; // undefined = not attempted (RBAC pre-filter, or no active query yet for this section's mode)
  requests: SectionResult<ResourceRequest> | undefined;
  projects: SectionResult<Project>;
  customers: SectionResult<Customer> | undefined;
  contracts: SectionResult<Contract> | undefined;
  orders: SectionResult<Order> | undefined;
}

const EMPTY_RESULTS: SearchResults = {
  resources: undefined, requests: undefined, projects: { status: 'ok', rows: [] },
  customers: undefined, contracts: undefined, orders: undefined,
};

/** Wraps one section's HTTP call: success -> {status:'ok', rows}; a 403 (an
 *  UNEXPECTED one, since the caller pre-filters with capability getters below)
 *  -> {status:'forbidden'}; anything else -> {status:'error'}. Mirrors the
 *  established "wrap one forkJoin leg in catchError so it can't kill the
 *  others" idiom (utilization.component.ts's 'orgs' leg) but reports WHY,
 *  instead of degrading to a fixed empty default. */
function sectionCall<T>(source: Observable<T[]>): Observable<SectionResult<T>> {
  return source.pipe(
    map(rows => ({ status: 'ok' as const, rows })),
    catchError((err: HttpErrorResponse) => of(err.status === 403 ? { status: 'forbidden' as const } : { status: 'error' as const })),
  );
}

@Component({
  selector: 'app-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Find</div>
          <h1 class="command-title">Search</h1>
          <p class="command-subtitle">Find resources, projects, requests, and commercial records by name.</p>
        </div>
      </header>

      <input
        class="command-input w-full"
        type="text"
        placeholder="Search by name..."
        [value]="draftQuery()"
        (input)="onInput($any($event.target).value)"
        (keydown.enter)="submitNow()"
      />

      @if (hasActiveQuery()) {
        @if (results().resources; as section) {
          <section class="command-card" data-test="section-resources">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Resources</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="resources" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (r of section.rows; track r.id) { <div>{{ r.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('resources') }}" in Resources.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().projects; as projectsSection) {
          <section class="command-card" data-test="section-projects">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Projects</h2>
            <app-list-state [loading]="loading()" [error]="projectsSection.status === 'error'" label="projects" (retry)="reload()">
              <ng-template>
                @if (projectsSection.status === 'ok') {
                  @for (p of projectsSection.rows; track p.id) { <div>{{ p.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('projects') }}" in Projects.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().requests; as section) {
          <section class="command-card" data-test="section-requests">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Requests</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="requests" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (r of section.rows; track r.id) { <div>{{ r.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('requests') }}" in Requests.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().customers; as section) {
          <section class="command-card" data-test="section-customers">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Customers</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="customers" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (c of section.rows; track c.id) { <div>{{ c.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('customers') }}" in Customers.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().contracts; as section) {
          <section class="command-card" data-test="section-contracts">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Contracts</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="contracts" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (c of section.rows; track c.id) { <div>{{ c.name }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('contracts') }}" in Contracts.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
        @if (results().orders; as section) {
          <section class="command-card" data-test="section-orders">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Orders</h2>
            <app-list-state [loading]="loading()" [error]="section.status === 'error'" label="orders" (retry)="reload()">
              <ng-template>
                @if (section.status === 'ok') {
                  @for (o of section.rows; track o.id) { <div>{{ o.invoiceNumber ?? o.id }}</div> }
                  @empty { <p class="text-[var(--cc-muted)]">No results for "{{ displayQueryFor('orders') }}" in Orders.</p> }
                }
              </ng-template>
            </app-list-state>
          </section>
        }
      }
    </div>
  `,
})
export class SearchComponent {
  private api = inject(ApiService);
  protected auth = inject(AuthService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  // Draft text (every keystroke) vs the two things that actually trigger a
  // fetch, per spec §6, Decision 4: `submittedQuery` (Resources/Requests,
  // explicit Enter only) and `liveQuery` (Projects/Customers/Contracts/
  // Orders, a debounced mirror of the draft). `submitQuery` is the seam a
  // real Enter keydown drives; exposed (not `protected`) so tests can invoke
  // it directly without simulating a keydown event.
  protected draftQuery = signal('');
  protected submittedQuery = signal('');
  /**
   * Debounced mirror of `draftQuery` feeding the 'live' entities. Browser-only:
   * this project already has an established rule that a timer with no
   * corresponding real-time clock during SSR must never be scheduled there
   * (NotificationService's auto-dismiss `setTimeout`, guarded by the same
   * `isPlatformBrowser` check) — a per-request Node process could otherwise
   * carry a timer callback across into a LATER, unrelated request. On the
   * server this signal simply never advances past its initial `''`, which is
   * harmless: the whole resource stays gated on `!authReady()` there anyway,
   * and `authReady()` never flips true during SSR (auth.service.ts).
   */
  protected liveQuery = signal('');
  private liveDebounceHandle: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if (this.isBrowser) {
      effect(() => {
        const value = this.draftQuery();
        if (this.liveDebounceHandle !== undefined) clearTimeout(this.liveDebounceHandle);
        // The write below happens inside the setTimeout callback, i.e. AFTER
        // this effect's own synchronous execution has already finished — not
        // a same-tick write from inside the effect — so no `allowSignalWrites`
        // is needed (same reasoning as NotificationService.dismiss()'s own
        // setTimeout-deferred signal write).
        this.liveDebounceHandle = setTimeout(() => this.liveQuery.set(value), LIVE_SEARCH_DEBOUNCE_MS);
      });
      this.destroyRef.onDestroy(() => {
        if (this.liveDebounceHandle !== undefined) clearTimeout(this.liveDebounceHandle);
      });
    }
  }

  protected onInput(value: string): void { this.draftQuery.set(value); }
  protected submitNow(): void { this.applySubmit(this.draftQuery()); }
  /** Test/production seam: equivalent to typing `q` then pressing Enter in one
   *  step. An explicit submit reaches EVERY section immediately, including the
   *  'live' ones — Enter is an unambiguous "search now" signal that should
   *  never leave a live section stale behind a still-pending debounce. */
  submitQuery(q: string): void { this.draftQuery.set(q); this.applySubmit(q); }

  private applySubmit(q: string): void {
    this.submittedQuery.set(q);
    this.liveQuery.set(q); // Enter always resolves any pending debounce immediately
    if (this.liveDebounceHandle !== undefined) { clearTimeout(this.liveDebounceHandle); this.liveDebounceHandle = undefined; }
  }

  /** Which active query text a section's "No results for ..." message should
   *  show — reads the SAME `SEARCH_TIMING` map `stream` below reads, so the
   *  displayed term can never disagree with the term actually sent. */
  protected displayQueryFor(key: SectionKey): string {
    return SEARCH_TIMING[key] === 'submit' ? this.submittedQuery() : this.liveQuery();
  }

  private searchRes = rxResource<SearchResults, { ready: boolean } & Record<SectionKey, string>>({
    params: () => {
      const submitted = this.submittedQuery().trim();
      const live = this.liveQuery().trim();
      // Single source of truth for "which query value feeds which section":
      // SEARCH_TIMING above. Safe cast: Object.keys(SEARCH_TIMING) is exactly
      // the six SectionKey literals, so every key of Record<SectionKey, string>
      // is always populated below.
      const perSection = Object.fromEntries(
        (Object.keys(SEARCH_TIMING) as SectionKey[]).map(key => [key, SEARCH_TIMING[key] === 'submit' ? submitted : live]),
      ) as Record<SectionKey, string>;
      return { ready: this.auth.authReady(), ...perSection };
    },
    stream: ({ params }) => {
      if (!params.ready) return of(EMPTY_RESULTS);
      const anyActive = params.resources || params.requests || params.projects || params.customers || params.contracts || params.orders;
      if (!anyActive) return of(EMPTY_RESULTS);
      const canStaffing = this.auth.canReadStaffing();
      const canCommercial = this.auth.canReadCommercial();
      return forkJoin({
        resources: canStaffing && params.resources ? sectionCall(this.api.getResources({ q: params.resources })) : of(undefined),
        requests: canStaffing && params.requests ? sectionCall(this.api.getRequests({ q: params.requests })) : of(undefined),
        // /projects has no RBAC pre-filter (open read, spec §4) -- always
        // attempted once its own (live) query is non-empty; otherwise the same
        // "ok, empty" default as EMPTY_RESULTS.projects, never absent.
        projects: params.projects ? sectionCall(this.api.getProjects({ q: params.projects })) : of({ status: 'ok' as const, rows: [] as Project[] }),
        customers: canCommercial && params.customers ? sectionCall(this.api.getCustomers({ q: params.customers })) : of(undefined),
        contracts: canCommercial && params.contracts ? sectionCall(this.api.getContracts({ q: params.contracts })) : of(undefined),
        orders: canCommercial && params.orders ? sectionCall(this.api.getOrders({ q: params.orders })) : of(undefined),
      }).pipe(
        map(r => ({
          resources: r.resources?.status === 'forbidden' ? undefined : r.resources,
          requests: r.requests?.status === 'forbidden' ? undefined : r.requests,
          projects: r.projects.status === 'forbidden' ? { status: 'error' as const } : r.projects, // /projects has no rule to forbid on; treat a stray 403 as a genuine error, not absence
          customers: r.customers?.status === 'forbidden' ? undefined : r.customers,
          contracts: r.contracts?.status === 'forbidden' ? undefined : r.contracts,
          orders: r.orders?.status === 'forbidden' ? undefined : r.orders,
        })),
      );
    },
    defaultValue: EMPTY_RESULTS,
  });

  protected results = computed(() => this.searchRes.value() ?? EMPTY_RESULTS);
  protected loading = computed(() => !this.auth.authReady() || this.searchRes.isLoading());
  protected hasActiveQuery = computed(() => !!this.submittedQuery().trim() || !!this.liveQuery().trim());
  protected reload(): void { this.searchRes.reload(); }
}
```

NOTE (a second, independent defect caught while writing this — not the
closed-decision issue, a plain type error): the ORIGINAL plan's Projects
section called `results().projects.status` and, in a separate expression,
`results().projects.rows` without an intervening `; as` binding. The Angular
template compiler does not narrow `SectionResult<Project>` (a union that
includes a variant with no `rows`) across two independent calls to the same
signal-returning function — `results().projects.rows` fails to compile
(`Property 'rows' does not exist on type '{ status: "forbidden" }'`). Fixed
by binding `@if (results().projects; as projectsSection)` first, exactly the
same pattern the other five (RBAC-gated) sections already use for exactly
this reason — the fix does not change Projects' always-visible behavior
(`results().projects` is never `undefined`, so the `@if` is always truthy;
it exists purely to give the template compiler a stable, narrowable binding).

- [ ] **Step 5: Run it green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/search.component.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

Also smoke-check that `/search` actually renders under SSR without error —
this is exactly the surface the browser-only debounce guard protects:

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4176 HOST=localhost node dist/app/server/server.mjs &
sleep 4
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4176/search   # expect 200
kill %1
```

- [ ] **Step 6: Mutate and confirm red (five mutations — two RBAC/four-state, three timing-split)**

1. In the `stream` capability pre-filter, change `canStaffing && params.resources ? sectionCall(...) : of(undefined)` to `params.resources ? sectionCall(...) : of(undefined)` (drop the capability check for resources). Run the suite: **"a role without canReadStaffing never even requests /resources"** goes red (the stub's `getResources` is now called). Revert.
2. In `sectionCall`, change `err.status === 403 ? {status:'forbidden' as const} : {status:'error' as const}` to always `{status:'error' as const}`. Run the suite: **"a 403 on one section... omits the section rather than showing an error panel"** goes red (the section now renders an error panel instead of disappearing). Revert.
3. In `SEARCH_TIMING`, change `projects: 'live'` to `projects: 'submit'`. Run the suite: **both** "typing into the box fires the Projects (live) section after the debounce" and "rapid keystrokes coalesce into ONE query" go red (Projects no longer fires from typing at all, since it now waits on `submittedQuery`, which `onInput` never touches) — proof the map is the single place that decides the split, not something re-derived per call site. Revert.
4. In the debounce `effect`, delete the `if (this.liveDebounceHandle !== undefined) clearTimeout(this.liveDebounceHandle);` line. Run the suite: **"rapid keystrokes coalesce into ONE query, not one request per keystroke"** goes red (`getProjects` is now called 2 times instead of 1) — this is the specific load-bearing guarantee Decision 4 exists for; if this line regresses, every keystroke pause fires its own request again. Revert.
5. Remove the `if (this.isBrowser) { ... }` guard around the debounce `effect()` (run it unconditionally). Run the suite: **"the debounce timer is browser-only"** goes red (`getProjects` is now called even with `PLATFORM_ID` set to `'server'`). Revert.

- [ ] **Step 7: Commit**

```bash
git add src/app/search/search.component.ts src/app/search/search.component.spec.ts src/app/app.routes.ts src/app/app.ts
git commit -m "feat: /search route — cross-entity search page with per-section RBAC pre-filtering, four-state rendering, and the explicit-submit/live-debounce split from spec §6"
```

---

### Task 7: Migrate `projects.ts` onto the shared filter bar

**Spec:** §8.

**Files:**
- Modify: `src/app/projects/projects/projects.ts` — replace the `searchControl`/`FormControl` box (line 335-336, template line 40) with `<app-search-filter-bar>`

**Interfaces:**
- Consumes: `SearchFilterBarComponent` (Task 5).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Run the existing suite first (regression baseline)**

```bash
find src/app/projects/projects -iname "*.spec.ts"
./node_modules/.bin/ng test --include='**/projects.spec.ts'
```
Note the pass count before changing anything.

- [ ] **Step 2: Replace the template's search box**

In `projects.ts`'s template (around line 40), replace:

```html
<input [formControl]="searchControl" type="text" placeholder="Search projects by name, ID, or location..." class="command-input">
```

with:

```html
<app-search-filter-bar
  [query]="searchValue() ?? ''"
  placeholder="Search projects by name, ID, or location..."
  (queryChange)="searchControl.setValue($event)"
  (clearAll)="searchControl.setValue('')"
/>
```

Add `SearchFilterBarComponent` to the component's `imports` array.

- [ ] **Step 3: Run the suite — must stay green with zero test changes**

```bash
./node_modules/.bin/ng test --include='**/projects.spec.ts'
```
Expected: same pass count as Step 1 — `filteredProjects` (`projects.ts:393-399`) reads `searchValue()` exactly as before; only the INPUT markup changed, not the filtering logic, so no existing test should need editing.

- [ ] **Step 4: Manual browser check**

```bash
npx ng serve &
sleep 8
```
Open `/projects`, type "Alpha" into the new filter-bar box, confirm the list narrows to Project Alpha; click the (only-when-active) Clear all chip button, confirm the list resets to both projects.

```bash
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add src/app/projects/projects/projects.ts
git commit -m "refactor: projects.ts adopts SearchFilterBarComponent for its search box"
```

---

### Task 8: Migrate `customers.ts`/`contracts.ts`/`orders.ts` — first-time adoption

**Spec:** §8.

**Files:**
- Modify: `src/app/commercial/customers/customers.ts` — add a filter bar (none exists today)
- Modify: `src/app/commercial/contracts/contracts.ts` — same
- Modify: `src/app/commercial/orders/orders.ts` — same

**Interfaces:**
- Consumes: `SearchFilterBarComponent` (Task 5).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: `customers.ts` — add the signal, the computed filter, and the bar**

Add to the component class:

```ts
protected customerQuery = signal('');
protected filteredCustomers = computed(() => {
  const q = this.customerQuery().trim().toLowerCase();
  const all = this.customers(); // existing resource/signal already on this component
  return q ? all.filter(c => c.name.toLowerCase().includes(q)) : all;
});
```

Add to the template, immediately above the existing customer list/table:

```html
<app-search-filter-bar
  [query]="customerQuery()"
  placeholder="Search customers by name..."
  (queryChange)="customerQuery.set($event)"
  (clearAll)="customerQuery.set('')"
/>
```

Change the list's iteration source from `customers()` to `filteredCustomers()`. Add `SearchFilterBarComponent` to `imports`.

- [ ] **Step 2: `contracts.ts` and `orders.ts` — identical shape**

Same three-part change (signal, computed filter over `name` for contracts; over `invoiceNumber ?? id` for orders, matching the server's own field choice from Task 2 Step 7 — an order has no `name`), same template addition, same `imports` change.

- [ ] **Step 3: Write one new test per screen — the seed row this filter must find**

For `customers.ts` (create the spec file if none exists, otherwise extend it):

```ts
it('filters to exactly customer C1 when searching "Globex"', () => {
  // ... standard TestBed setup for this component, providing ApiService returning
  // the two seed customers (C1 Globex Corp, C2 Initech)
  component.customerQuery.set('Globex');
  fixture.detectChanges();
  expect(component.filteredCustomers().map(c => c.id)).toEqual(['C1']);
});
it('an empty query returns both seed customers, not zero', () => {
  component.customerQuery.set('');
  fixture.detectChanges();
  expect(component.filteredCustomers().length).toBe(2);
});
```

Mirror the same two-test shape (a named-row positive, an all-rows-when-empty twin) for `contracts.ts` (searching "Globex" → exactly `CT1`) and `orders.ts` (searching "INV-2026-0001" → exactly `O1`).

- [ ] **Step 4: Run the suite and lint**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Mutate and confirm red (customers, representative — repeat for contracts/orders if time allows)**

In `filteredCustomers`, change `c.name.toLowerCase().includes(q)` to `c.name.toLowerCase() === q`. Run the suite: no existing test catches a PARTIAL match regression directly — add the missing case first ("Glob" (partial) should still match "Globex Corp") if not already covered, confirm it goes red under this mutation, then revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/commercial/customers/customers.ts src/app/commercial/contracts/contracts.ts src/app/commercial/orders/orders.ts
git commit -m "feat: customers/contracts/orders gain their first-ever filter, via SearchFilterBarComponent"
```

---

### Task 9: Migrate `resources.component.ts` — full filter-bar replacement

**Spec:** §8. **This is the highest-regression-risk task in this plan** — `resources.component.ts` carries the richest filter bar in the app (six ANDed predicates, existing test suite with 15 `it()` blocks) and is the one screen where "migrate the whole thing" (not just the text box) is the committed decision.

**Files:**
- Modify: `src/app/resources/resources.component.ts` — replace the text box (line 581 signal, template ~line 74), `activeOnly` toggle, `kindFilter` select, and the capability/practice/competence/manager selects (lines 96-123) with one `<app-search-filter-bar>` fed a facet list built from the SAME existing computed option sources (`capabilityOptions`, `practiceOptions`, `competenceOptions`, `managerFilterOptions`)

**Interfaces:**
- Consumes: `SearchFilterBarComponent` (Task 5); `capabilityOptions`/`practiceOptions`/`competenceOptions`/`managerFilterOptions` (existing, unchanged).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Run the existing suite first (regression baseline)**

```bash
./node_modules/.bin/ng test --include='**/resources.component.spec.ts'
```
Note the exact pass count (15 `it()` blocks as of this plan's writing — re-verify the live count, it may have grown).

- [ ] **Step 2: Build the facet list as a `computed()`, without touching the filtering logic**

Add, near the existing `capabilityOptions`/`practiceOptions`/`competenceOptions`/`managerFilterOptions` (line 600-605):

```ts
protected filterFacets = computed<Facet[]>(() => [
  { id: 'kind', label: 'Kind', value: this.kindFilter(), options: resourceKindOptions.map(o => ({ value: o.value, label: o.label })) },
  { id: 'capability', label: 'Capability', value: this.capabilityFilter(), options: this.capabilityOptions().map(name => ({ value: name, label: name })) },
  { id: 'practice', label: 'Practice', value: this.practiceFilter(), options: this.practiceOptions().map(name => ({ value: name, label: name })) },
  { id: 'competence', label: 'Competence', value: this.competenceFilter(), options: this.competenceOptions().map(name => ({ value: name, label: name })) },
  { id: 'manager', label: 'People Manager', value: this.managerFilter(), options: this.managerFilterOptions().map(m => ({ value: m.id, label: m.name })) },
]);

protected onFacetChange(event: { id: string; value: string }): void {
  switch (event.id) {
    case 'kind': this.kindFilter.set(event.value as '' | ResourceKind); break;
    case 'capability': this.capabilityFilter.set(event.value); break;
    case 'practice': this.practiceFilter.set(event.value); break;
    case 'competence': this.competenceFilter.set(event.value); break;
    case 'manager': this.managerFilter.set(event.value); break;
  }
}

protected clearAllFilters(): void {
  this.search.set('');
  this.kindFilter.set('');
  this.capabilityFilter.set('');
  this.practiceFilter.set('');
  this.competenceFilter.set('');
  this.managerFilter.set('');
}
```

`Facet` imported from `../shared/search-filter-bar.component`; `resourceKindOptions`, `capabilityFilter`, `practiceFilter`, `competenceFilter`, `managerFilter` are the pre-existing signals this component already declares (verify each name against the current file before use — they back the SIX `<select>`s this task removes) — no new signal is introduced for the FILTER VALUES themselves, only the facet-list projection and the dispatch switch above.

- [ ] **Step 3: Replace the template markup**

Replace the search input (~line 74), the `activeOnly` checkbox (line 74 area), the `kindFilter` select (lines 80-86), and the four org-dimension selects (lines 96-123) with:

```html
<app-search-filter-bar
  [query]="search()"
  [facets]="filterFacets()"
  placeholder="Search by name, role, organization, or location..."
  (queryChange)="search.set($event)"
  (facetChange)="onFacetChange($event)"
  (clearAll)="clearAllFilters()"
/>
<label class="flex items-center gap-2">
  <input type="checkbox" [ngModel]="activeOnly()" (ngModelChange)="activeOnly.set($event)" />
  Active only
</label>
```

The `activeOnly` toggle is kept OUTSIDE the shared component deliberately: it is a boolean, not a facet with an option list, and `Facet` (Task 5) models only single-select dimensions — forcing a boolean into a two-option `<select>` would be a worse UI than the existing checkbox, and the component's own contract (Task 5) does not claim to cover every filter shape, only the ones already expressed as facets. Add `SearchFilterBarComponent` to `imports`; remove now-unused imports (`FormsModule`'s `ngModel` directive stays, since `activeOnly` still uses it).

- [ ] **Step 4: Run the suite — this is the real regression gate**

```bash
./node_modules/.bin/ng test --include='**/resources.component.spec.ts'
```
Expected: some of the 15 existing tests reference the REMOVED markup directly (e.g. `querySelector('[data-test="capability-filter"]')` — Task 5's shared component renders `[data-test="filter-bar-facet-capability"]` instead, a DIFFERENT selector). Update each failing test's selector to the new `data-test` attribute Task 5 established (`filter-bar-query`, `filter-bar-facet-<id>`) — do not change what each test ASSERTS, only how it locates the element, since the underlying `filteredResources` computed (line 626) is untouched by this task.

- [ ] **Step 5: Run the whole suite and lint**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 6: Mutate and confirm red**

In `onFacetChange`, change `case 'kind': this.kindFilter.set(...)` to `case 'kindx':` (typo the case label). Run the resources suite: the existing kind-filter test (whichever of the 15 covers `kindFilter`) goes red — selecting "Subco" in the facet no longer narrows the list. Revert the typo.

- [ ] **Step 7: Manual browser check**

```bash
npx ng serve &
sleep 8
```
Open `/resources`, exercise all five facets plus the text box plus "Active only", confirm identical narrowing behavior to before this task, confirm the Clear all button resets everything including `activeOnly`.

```bash
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add src/app/resources/resources.component.ts src/app/resources/resources.component.spec.ts
git commit -m "refactor: resources.component.ts adopts SearchFilterBarComponent for all five select facets and its text box"
```

---

### Task 10: Docs, sweep, full verification

**Spec:** §2 (rollout order), §3 (compatibility), §4 (RBAC — unchanged), §12 (docs), §14 (out of scope) — cross-check every one against the docs below.

**Files:**
- Modify: `docs/roles-and-permissions.md` — annotate the six extended READ_RULES rows, add `/search` to Route access
- Modify: `docs/architecture/02-frontend.md` — `/search` route, `SearchFilterBarComponent`
- Modify: `docs/architecture/03-backend-and-data.md` — the six extended reads, `search.util.ts`
- Modify: whatever the sweep turns up

- [ ] **Step 1: Sweep for stale references**

```bash
grep -rn "getResources()\.\|getProjects()\.\|getRequests()\." src/app --include="*.ts" | grep -v spec
```
This should show no BROKEN call sites (every existing zero-arg call remains valid — Task 4's `opts?` is optional); this is a read-only sanity pass, not an expectation of zero output.

```bash
grep -rn "searchControl\|kindFilter\|capabilityFilter" src/app/projects src/app/resources --include="*.ts"
```
Confirm the underlying signals Task 7/9 still reference (`searchControl` in `projects.ts`, `kindFilter`/`capabilityFilter`/etc. in `resources.component.ts`) still exist under those names — only their template wiring changed, not their declarations.

- [ ] **Step 2: Docs**

`docs/roles-and-permissions.md` — in the "(a) READ_RULES — gated GET collections" table, add a short parenthetical to the existing rows for `/resources`, `/requests`, `/customers`/`/contracts`/`/orders`, and to the "Open reads" paragraph's `/projects` mention: "(also accepts optional `q`/`limit`/`offset` for Block G's cross-entity search — same roles, same 403/401 behavior, no new rule)." Add a row to "Route access (client guards)" for `/search`: no guard, any authenticated principal, mirroring `/projects`.

`docs/architecture/02-frontend.md` — add `/search` to the route table; note `SearchFilterBarComponent` (`src/app/shared/search-filter-bar.component.ts`) as the shared filter-bar primitive, consumed by the search page plus `resources.component.ts`/`projects.ts`/`customers.ts`/`contracts.ts`/`orders.ts`.

`docs/architecture/03-backend-and-data.md` — add a short subsection: Block G adds no schema, no migration; six existing collection reads gained optional `q`/`limit`/`offset`, filtered/paginated in-process via `search.util.ts` AFTER the existing unmodified `repos.X.list()` call — identical on both persistence adapters by construction, no adapter-specific branch. Note the deferred text index and its cost (no ranking, no typo tolerance) per spec §7.

- [ ] **Step 3: Full gate set**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4176 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4176 node scripts/smoke-api.mjs
kill %1
```

- [ ] **Step 4: Fresh-Postgres run**

Spec §7: parity is not a new gate here since both adapters call the identical in-process filter after an unmodified `list()` — but the general dual-adapter obligation still applies. Create a fresh Postgres database (`docker compose up -d postgres`), run the built server against it with `DATABASE_URL` set, re-run the smoke suite, confirm every `q=`-bearing check in Task 2/3 passes identically, then drop the database. If Docker is unavailable, say so prominently rather than skipping silently.

- [ ] **Step 5: Browser verification**

On port 4176: `/search` with a role that can read staffing AND commercial (e.g. `delivery-executive`) — confirm all six sections can appear; the same page as `sales` — confirm Resources/Requests sections are absent (not "0 results") while Customers/Contracts/Orders and Projects show; the same page as `employee` — confirm only Projects shows. `/projects`, `/resources`, `/customers`, `/contracts`, `/orders` — confirm each screen's own filter bar (Tasks 7-9) still narrows correctly and Clear all resets it.

- [ ] **Step 6: Commit**

```bash
git add -A docs
git commit -m "docs: Block G faceted search in the architecture and RBAC references"
```

---

## Verification Checklist (before merge)

- [ ] `GET /resources`, `/projects`, `/requests`, `/contracts`, `/orders`, `/customers` called with NO query parameters return the exact same full array they returned before this block — verified by an explicit smoke check per collection (Task 2/3).
- [ ] `q=Julie` on `/resources` returns exactly resource `'1'`; `q=zzznonsense123` resolves to `200` with zero rows, never an error status.
- [ ] `q=Globex` on `/orders` returns zero rows (no join to the parent contract/customer name); `q=INV-2026-0001` returns exactly `O1`.
- [ ] An `employee` gets 403 on `/resources?q=...`/`/requests?q=...`, exactly as they do on the unparameterized reads today; `/projects?q=...` is 200 for every role, `employee` included.
- [ ] No new `READ_RULES` entry, no new `authorizeRead()` call, exists anywhere in this block's diff.
- [ ] The `/search` page never fires a request for a section the current role's `canReadStaffing()`/`canReadCommercial()` already says it cannot read — verified by a spy/call-count assertion, not just an absence of the rendered section.
- [ ] A 403 that occurs anyway (client/server drift) causes that section to disappear, never a rendered error panel — and is left to the existing global error-interceptor toast, not suppressed.
- [ ] A non-403 error on one section shows that section's own Retry panel while every other section still renders its own results.
- [ ] A genuinely empty, successfully-resolved section renders "No results for ...", never indistinguishable from a failed or omitted section.
- [ ] Every displayed percentage/FTE/amount uses an explicit `digitsInfo` of `1.0-0` or `1.0-2` — none defaults to `DecimalPipe`'s bare `1.0-3`.
- [ ] `resources.component.ts`'s full existing test suite passes after Task 9's migration, with only `data-test` selectors updated, no assertion rewritten.
- [ ] `crud()`'s 11 other callers (cities, industries, cost-categories, partner-roles, vendors, rate-cards, project-partners, project-documents, work-packages, project-financials, project-tasks, project-issues, cost-centers) are unaffected — verified by at least one smoke check on an unrelated crud()-mounted collection (`/vendors`, Task 3).
- [ ] Unit, lint, build, live smoke and the fresh-Postgres parity run are all green.

## Self-Review

**Spec section → task mapping:**
- §1 (gap analysis, reconciled screen count) — no task; spec's own justification.
- §2 (v1 entity scope, rollout order for what's next) — no task implements a rollout order for LATER work by definition; the four in-scope entities are covered by Tasks 2-3 (server) and 6-9 (client).
- §3 (six extended reads, no new endpoint, backward-compat invariant) — Task 2 (five bespoke handlers), Task 3 (`crud()`/customers).
- §4 (RBAC reuse, zero new surface, facet-count disclosure via existing 403) — Task 2/3 (no new rule added), Task 6 (client-side capability pre-filter + 403-as-absence).
- §5 (four states per section) — Task 6 (`SectionResult`, the `@if` per section, `ListStateComponent`'s existing loading/error inputs).
- §6 (authReady + live/explicit-submit map) — Task 6 (`draftQuery`/`submittedQuery`, the `params` keyed on `{ready, q}`).
- §7 (server-side, no index, trivial parity) — Task 1 (`search.util.ts`), consumed identically by Task 2/3 regardless of adapter.
- §8 (shared component, targeted migration) — Task 5 (component), Tasks 7-9 (the three migrations), the follow-up list itself needs no task (it is a declared non-action).
- §9 (distinct entry point, no guard on `/search`) — Task 6, Step 1.
- §10 (two-decimal rule) — noted in Task 6's template guidance; this block's own result rows (names, ids, invoice numbers) carry no fractional figures directly, so no `digitsInfo` binding is exercised by Task 6 itself — the rule is inherited by any future addition of a monetary/percentage column to a result row, not violated by omission today.
- §11 (technical surface: types, handler shape, response shape) — Task 1 (types), Task 2/3 (handler shape), Task 4 (client shape).
- §12 (docs) — Task 10.
- §13 (verification: seed-row-per-check, twins, mutation, RBAC positive/negative, DOM scoping, permutation risk) — Tasks 1-9 each carry their own mutation step; Task 2's smoke checks carry the named seed rows; Task 6's spec carries the RBAC positive/negative pair and the 403-vs-500 distinction.
- §14 (out of scope: no new seed rows, no ranking, no assignment/config-catalog search, no retroactive migration of staffing/allocation-approvals/billing, no self-scoped reads, no total count, no second org-scope axis) — no task in this plan adds any of these; the Global Constraints section states the no-new-seed-rows constraint explicitly, and the migration tasks (7-9) name exactly the three screens in scope, nothing more.

**Placeholder scan:** no step in this plan contains "TBD", "add appropriate error handling", "add validation", or "similar to Task N" as a substitute for content — every code block is complete. Task 8's Step 2 says "identical shape" for `contracts.ts`/`orders.ts` after Step 1 spells out `customers.ts` in full; this is repetition-by-reference to a FULLY WRITTEN prior step in the SAME task (not a cross-task reference an out-of-order reader would miss), consistent with how Block F's own plan handled its per-collection repetition. Task 4's Step 3 does the same for the five remaining `ApiService` methods after Step 2 spells out `getResources` in full, for the same reason.

**Name/type consistency across tasks:** `SEARCH_DEFAULT_LIMIT`, `SEARCH_MAX_LIMIT`, `clampSearchPage`, `matchesQuery`, `searchPage` (Task 1) are consumed unchanged by Tasks 2-3. `SearchOpts` (Task 4) is consumed unchanged by Task 6. `Facet`/`FacetOption`/`SearchFilterBarComponent` (Task 5) are consumed unchanged, with identical `(queryChange)`/`(facetChange)`/`(clearAll)` output names, by Tasks 6, 7, 8, 9. `SectionResult<T>`/`sectionCall` (Task 6) are local to that task's own file — no later task needs them. The discriminant `status: 'ok' | 'forbidden' | 'error'` is spelled identically in Task 6's type, its template's `.status === 'error'` checks, and its two mutation-testing steps.

**Citations re-verified against the live `f2b6edd` tree while writing this plan** (all matched exactly, no drift found beyond the two already corrected in the design spec — orders having 3 seed rows, and `resource-requests.component.ts`'s search targeting a candidate sublist rather than a Requests list): `server.ts` 1701/2156/4436/4739/4793/703-744/772/4693/6521-6548; `api.service.ts` 921/979/1255/1320/1325/1330; `resources.component.ts` 80-123/581/583/585/600-605/626; `projects.ts` 335-336/393-399; `styles.css` 871/886-910/921-922/1043/1148/1170; `access-policy.util.ts` 35-120 (the exact role sets behind `canReadStaffing`/`canReadCommercial`, confirmed to match `/resources`+`/requests` and `/customers`+`/contracts`+`/orders` respectively); `error.interceptor.ts` 44-67 (the 403-toasts-for-authenticated-users behavior Task 6 avoids triggering by construction, not by suppression); `db/seed.ts` resources `'1'`-`'9'`, requests/assignmentsBase `'1'`-`'11'`, projects `'1'`-`'2'`, customers `C1`-`C2`, contracts `CT1`-`CT2`, orders `O1`-`O3`.
