# C1 — Dummy/Subco Resource Kinds + Multi-FTE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let planners book capacity that does not exist yet — placeholder (dummy) and subcontractor (subco) resources, allocatable beyond 1 FTE — while keeping them out of the internal saturation KPIs and surfacing them as uncovered demand.

**Architecture:** Two columns on `resources` (`kind`, `vendorId`) plus one pure layer, `resource-kind.util.ts`, holding the three rules that depend on the kind: multi-FTE eligibility, the daily hours cap, and whether the resource counts toward internal capacity. No persisted FTE field — hours per day stay the single source of truth (B1) and FTE stays derived (B2); "multi-FTE" simply means the daily cap widens by 30× for dummy and subco. `rollupMonthly` partitions resources into internal `rows` (with the semaphore) and `demandRows` (without), and the totals gain a separate uncovered-demand figure.

**Tech Stack:** Angular 21 (standalone, signal-first, OnPush), Express 5, Drizzle ORM + PostgreSQL, Vitest via `@angular/build:unit-test`, dependency-free smoke script.

**Spec:** `docs/superpowers/specs/2026-08-02-c1-dummy-subco-multi-fte-design.md`
**Branch:** `feature/c1-dummy-subco-multi-fte` (already created; the spec commit is `3822844`).

## Global Constraints

- **Tooling:** `./node_modules/.bin/ng test`, `./node_modules/.bin/ng lint`, `./node_modules/.bin/ng build`, `./node_modules/.bin/drizzle-kit generate` — **never `npx`**.
- **Live smoke:** build, then `env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &`, then `SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs`. Host `localhost`, NOT `127.0.0.1` (the server binds `::1`). Kill the server afterwards. **Baselines: unit 447, smoke 164 — none may regress.**
- **Postgres parity:** the final task re-runs the smoke suite against Postgres. The shared `…/postgres` database carries state from earlier runs — create a fresh database for the run and drop it after, as B3's final task did.
- **`src/db/seed.ts` is the single source of truth** for seed data (in-memory adapter + Postgres seeder).
- **`nullsToUndefined()`** runs on every repository *return* path; an explicit `null` in an update patch means "clear to absent" on **both** adapters; `undefined` means "leave untouched".
- **Pure utils are SSR-safe:** no `Date.now()`, no argless `new Date()`, ISO strings only.
- **Angular:** standalone only, `ChangeDetectionStrategy.OnPush`, `signal`/`computed`/`linkedSignal`, native control flow, `inject()` in field initializers, `rxResource` params keyed on `auth.authReady()`. Never snapshot `auth.userId()`/`auth.role()` at field-init.
- **Design system:** bespoke `command-*` classes + CSS tokens; Material for icons only; the `-text` token shade wherever an accent renders as text (WCAG AA).
- **UI copy is English.**
- **`MULTI_FTE_MAX = 30`** — the manual's ceiling, a code constant, not configurable.
- TypeScript strict; no `any` at the repo boundary; `ng lint` **errors** on unused vars.
- Commit messages in English.

---

## File Structure

**Create:**
- `src/app/services/resource-kind.util.ts` — the pure kind rules.
- `src/app/services/resource-kind.util.spec.ts`
- `drizzle/0011_*.sql` — generated migration.

**Modify:**
- `src/app/services/api.service.ts` — `ResourceKind`, `Resource.kind`/`Resource.vendorId`, `CapacityRollup.demandRows`, `CapacityTotals.demandFteUncovered`.
- `src/db/schema.ts` — two columns on `resources`.
- `src/db/seed.ts` — dummy and subco rows.
- `src/server.ts` — `RESOURCE_FIELDS`, the `/resources` POST/PUT validation, the daily-cap resolution in `PUT /assignments/:id/allocation`, the `rollupMonthly` call in `/capacity/monthly`.
- `src/app/services/capacity.util.ts` + `.spec.ts` — the internal/demand partition.
- `src/app/capacity/capacity.component.ts` + `.spec.ts` — the *Uncovered demand* section and the KPI.
- `src/app/resources/resources.component.ts` — kind field, conditional vendor field, badge, filter.
- `src/app/allocation-calendar/allocation-calendar.component.ts` — the FTE selector and the kind-aware per-day hint.
- `src/app/staffing/staffing.component.ts` — kind badge in the resource picker.
- `scripts/smoke-api.mjs` — a `checkResourceKinds()` section.
- `docs/architecture/03-backend-and-data.md` — the entity catalogue.

---

### Task 1: Pure resource-kind layer

**Files:**
- Create: `src/app/services/resource-kind.util.ts`
- Test: `src/app/services/resource-kind.util.spec.ts`

**Interfaces:**
- Produces (every later task depends on these exact names):
  - `type ResourceKind = 'internal' | 'dummy' | 'subco'`
  - `RESOURCE_KINDS: readonly ResourceKind[]`
  - `MULTI_FTE_MAX = 30`
  - `isResourceKind(value: unknown): value is ResourceKind`
  - `isMultiFteEligible(kind: ResourceKind): boolean`
  - `dailyCapFor(kind: ResourceKind, contractHoursPerDay: number): number`
  - `countsTowardInternalCapacity(kind: ResourceKind): boolean`
  - `kindOf(resource: { kind?: string } | undefined): ResourceKind` — defensive reader: anything unrecognised or absent reads as `'internal'`

- [ ] **Step 1: Write the failing test**

Create `src/app/services/resource-kind.util.spec.ts`:

```ts
import {
  MULTI_FTE_MAX,
  RESOURCE_KINDS,
  countsTowardInternalCapacity,
  dailyCapFor,
  isMultiFteEligible,
  isResourceKind,
  kindOf,
} from './resource-kind.util';

describe('RESOURCE_KINDS / isResourceKind', () => {
  it('lists exactly the three kinds', () => {
    expect([...RESOURCE_KINDS]).toEqual(['internal', 'dummy', 'subco']);
  });

  it('accepts only the three kinds', () => {
    expect(isResourceKind('internal')).toBe(true);
    expect(isResourceKind('dummy')).toBe(true);
    expect(isResourceKind('subco')).toBe(true);
    expect(isResourceKind('Internal')).toBe(false);
    expect(isResourceKind('')).toBe(false);
    expect(isResourceKind(undefined)).toBe(false);
    expect(isResourceKind(2)).toBe(false);
  });
});

describe('kindOf', () => {
  it('reads the stored kind', () => {
    expect(kindOf({ kind: 'subco' })).toBe('subco');
  });

  it('falls back to internal for an absent, empty or unknown kind', () => {
    expect(kindOf({})).toBe('internal');
    expect(kindOf(undefined)).toBe('internal');
    expect(kindOf({ kind: 'contractor' })).toBe('internal');
  });
});

describe('isMultiFteEligible', () => {
  it('is true only for dummy and subco', () => {
    expect(isMultiFteEligible('dummy')).toBe(true);
    expect(isMultiFteEligible('subco')).toBe(true);
    expect(isMultiFteEligible('internal')).toBe(false);
  });
});

describe('dailyCapFor', () => {
  it('caps an internal resource at its contracted hours', () => {
    expect(dailyCapFor('internal', 8)).toBe(8);
    expect(dailyCapFor('internal', 4)).toBe(4);
  });

  it('widens the cap to MULTI_FTE_MAX times for dummy and subco', () => {
    expect(dailyCapFor('dummy', 8)).toBe(8 * MULTI_FTE_MAX);
    expect(dailyCapFor('subco', 4)).toBe(4 * MULTI_FTE_MAX);
  });

  it('returns a non-usable cap unchanged so the caller keeps its own fallback', () => {
    // The allocation handler treats 0/NaN/negative as "no usable cap" and falls
    // back to settings.hoursPerDay; multiplying those would hide the problem.
    expect(dailyCapFor('dummy', 0)).toBe(0);
    expect(dailyCapFor('dummy', Number.NaN)).toBeNaN();
    expect(dailyCapFor('dummy', -3)).toBe(-3);
  });
});

describe('countsTowardInternalCapacity', () => {
  it('is true only for internal resources', () => {
    expect(countsTowardInternalCapacity('internal')).toBe(true);
    expect(countsTowardInternalCapacity('dummy')).toBe(false);
    expect(countsTowardInternalCapacity('subco')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test`
Expected: FAIL — cannot resolve `./resource-kind.util`.

- [ ] **Step 3: Write the implementation**

Create `src/app/services/resource-kind.util.ts`:

```ts
/**
 * Pure resource-kind rules (C1).
 *
 * Delivery Control knows three kinds of resource. Two of them represent
 * capacity that does not exist yet — see
 * docs/superpowers/specs/2026-08-02-c1-dummy-subco-multi-fte-design.md:
 *   - 'dummy' — a placeholder for a person not yet identified, preconfigured
 *     by practice, level and day rate;
 *   - 'subco' — an external collaborator, belonging to a vendor.
 * Everything that branches on the kind lives here so the server and the UI
 * cannot drift: the multi-FTE ceiling, the daily hours cap, and whether the
 * resource counts toward the internal capacity KPIs.
 *
 * Side-effect free and SSR-safe.
 */
export type ResourceKind = 'internal' | 'dummy' | 'subco';

export const RESOURCE_KINDS: readonly ResourceKind[] = ['internal', 'dummy', 'subco'];

/**
 * Ceiling of the manual's multi-FTE planning (1,5 · 2 · … · 30 FTE). A code
 * constant, not customizing: it bounds a validation rule, not a preference.
 */
export const MULTI_FTE_MAX = 30;

export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Read a resource's kind defensively. A row written before this feature (or a
 * value that somehow escaped validation) reads as 'internal' — the safe
 * default, since it is the STRICTER one: a 1-FTE cap and inclusion in the KPIs.
 */
export function kindOf(resource: { kind?: string } | undefined): ResourceKind {
  const raw = resource?.kind;
  return isResourceKind(raw) ? raw : 'internal';
}

/** True iff this kind may be planned beyond 1 FTE (manual §3.2.3, §3.2.5). */
export function isMultiFteEligible(kind: ResourceKind): boolean {
  return kind !== 'internal';
}

/**
 * The maximum hours/day this kind may carry across ALL its assignments.
 *
 * A non-usable `contractHoursPerDay` (0, NaN, negative) is returned unchanged:
 * the allocation handler already treats those as "no usable cap" and falls back
 * to the configured hours/day, and multiplying a broken value would hide it.
 */
export function dailyCapFor(kind: ResourceKind, contractHoursPerDay: number): number {
  if (!Number.isFinite(contractHoursPerDay) || contractHoursPerDay <= 0) return contractHoursPerDay;
  return isMultiFteEligible(kind) ? contractHoursPerDay * MULTI_FTE_MAX : contractHoursPerDay;
}

/**
 * True iff this kind is a real person whose saturation is worth measuring.
 * Dummy and subco are excluded from the internal capacity totals and from the
 * semaphore — the manual is explicit that subcontractors "non rientrano nei KPI
 * di allocazione delle risorse interne" (§4.1.2), and a placeholder has no
 * capacity to saturate at all.
 */
export function countsTowardInternalCapacity(kind: ResourceKind): boolean {
  return kind === 'internal';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/ng test`
Expected: PASS (447 existing + the new cases; every existing suite still green).

- [ ] **Step 5: Commit**

```bash
git add src/app/services/resource-kind.util.ts src/app/services/resource-kind.util.spec.ts
git commit -m "feat(c1): pure resource-kind util (kinds, multi-FTE eligibility, daily cap, KPI membership)"
```

---

### Task 2: Data model — columns, type, seed, migration

**Files:**
- Modify: `src/app/services/api.service.ts` (the `Resource` interface, ~line 9)
- Modify: `src/db/schema.ts` (the `resources` table, ~line 75)
- Modify: `src/db/seed.ts` (the `resources` array)
- Create: `drizzle/0011_*.sql` (generated)

**Interfaces:**
- Consumes: `ResourceKind` (Task 1).
- Produces: `Resource.kind?: ResourceKind`, `Resource.vendorId?: string`; seeded dummy and subco rows.

- [ ] **Step 1: Extend the canonical type**

In `src/app/services/api.service.ts`, inside the `Resource` interface, and import `ResourceKind` from `./resource-kind.util`:

```ts
  /**
   * Resource kind (C1). 'internal' is a real person; 'dummy' is a placeholder
   * for a person not yet identified; 'subco' is an external collaborator
   * belonging to a vendor. Optional on the wire for backward compatibility —
   * read it through `kindOf()`, which defaults an absent value to 'internal'.
   */
  kind?: ResourceKind;
  /** Vendor a 'subco' resource belongs to (FK to the vendors catalog). Required for subco, absent otherwise. */
  vendorId?: string;
```

- [ ] **Step 2: Add the columns**

In `src/db/schema.ts`, inside the `resources` table definition, after `organization`/`location`:

```ts
    // C1: resource kind. Default 'internal' keeps every pre-existing row a real
    // person, so the migration needs no backfill.
    kind: text('kind').$type<ResourceKind>().notNull().default('internal'),
    // Vendor a subco belongs to; NULL for internal and dummy resources.
    vendorId: text('vendor_id').references(() => vendors.id),
```

Import the `ResourceKind` type in the same type-import statement the file already uses for the api.service types. Note `vendors` is declared LOWER in the file (~line 397) than `resources` — that is fine, the `() => vendors.id` reference is lazy, and the existing schema already does this elsewhere; check one existing example before writing.

- [ ] **Step 3: Seed dummy and subco rows**

In `src/db/seed.ts`, append these three rows to the `resources` array (which currently ends at id `'3'`, Alice Smith). Every value below is taken from the seeded catalogs: roles `Developer`/`Consultant`/`Designer` are in use on the existing rows, `Engineering` and `Consulting` are seeded `resourceOrganizations`, `Remote` is the seeded sentinel city, and `V4` is *Mediolanum Consulting S.r.l.* in the seeded `vendors`:

```ts
  // C1 — placeholder and external resources. The manual pre-loads dummies by
  // practice / professional level / day rate (§3.2.3.1); these mirror that, so
  // the feature is visible on first boot. `contractHoursPerDay` is the BASE for
  // ONE FTE — the multi-FTE ceiling is derived from it (dailyCapFor), never
  // stored. `utilization` starts at 0: nothing is booked on them yet, and for a
  // placeholder the scalar is meaningless anyway (it is not an internal KPI).
  { id: '4', name: 'Dummy — Senior Developer', role: 'Developer', kind: 'dummy',
    skills: [], projectRoles: ['Senior Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2026-01-01', contractHoursPerDay: 8 },
  { id: '5', name: 'Dummy — Associate PMO', role: 'Consultant', kind: 'dummy',
    skills: [], projectRoles: ['Business Consultant'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Consulting', location: 'Remote', hireDate: '2026-01-01', contractHoursPerDay: 8 },
  { id: '6', name: 'Subco — Mediolanum Senior Developer', role: 'Developer', kind: 'subco', vendorId: 'V4',
    skills: [{ name: 'Java', level: 3 }], projectRoles: ['Senior Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2026-01-01', contractHoursPerDay: 8 },
```

Two things to verify rather than assume, and to state in your report: that ids `'4'`–`'6'` are free across the whole seed file (`seedSequences()` re-seeds id counters past the max existing suffix at boot, so a collision would surface as a duplicate key), and that no seeded row already uses them. If they are taken, continue the numbering and say which ids you used. Do not give these rows a `managerId` — a placeholder has no People Manager, and the allocation approval will fall back to the `resource-manager` role, which is the gap-A behaviour for a resource without a manager.

- [ ] **Step 4: Generate the migration**

Run: `./node_modules/.bin/drizzle-kit generate`
Expected: a new `drizzle/0011_*.sql` adding both columns and the FK. Read the SQL and confirm it is additive only — `kind` must carry `DEFAULT 'internal' NOT NULL` so existing rows need no backfill. If drizzle-kit asks an interactive question, stop and report NEEDS_CONTEXT rather than guessing.

- [ ] **Step 5: Run the gates**

Run: `./node_modules/.bin/ng test`, then `./node_modules/.bin/ng build`
Expected: PASS / success.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/api.service.ts src/db/schema.ts src/db/seed.ts drizzle/
git commit -m "feat(c1): resource kind + vendor columns, seeded dummy and subco rows, migration"
```

---

### Task 3: Server — kind validation on `/resources`

**Files:**
- Modify: `src/server.ts` — `RESOURCE_FIELDS` (~line 732), `POST /resources` (~line 1291), `PUT /resources/:id` (~line 1337)
- Modify: `scripts/smoke-api.mjs` — new `checkResourceKinds()` section

**Interfaces:**
- Consumes: `isResourceKind`, `kindOf`, `dailyCapFor` (Task 1); `Resource.kind`/`vendorId` (Task 2).
- Produces: `/resources` accepts and validates `kind` + `vendorId`.

- [ ] **Step 1: Write the failing smoke assertions**

In `scripts/smoke-api.mjs`, add a `checkResourceKinds()` section registered in `main()` with its own try/catch (mirror how `checkMonthlyApproval` is registered). Earlier sections mutate seeded data, so build what you need inside this section:

```js
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

  const badKind = await req('POST', '/resources', { body: { ...base, name: 'C1 bad kind', kind: 'contractor' } });
  check('C1 an unknown kind is rejected', badKind.status === 400, `status=${badKind.status}`);

  const subcoNoVendor = await req('POST', '/resources', { body: { ...base, name: 'C1 subco no vendor', kind: 'subco' } });
  check('C1 a subco without a vendor is rejected', subcoNoVendor.status === 400, `status=${subcoNoVendor.status}`);

  const subcoBadVendor = await req('POST', '/resources', { body: { ...base, name: 'C1 subco bad vendor', kind: 'subco', vendorId: 'V-nope' } });
  check('C1 a subco with an unknown vendor is rejected', subcoBadVendor.status === 400, `status=${subcoBadVendor.status}`);

  const internalWithVendor = await req('POST', '/resources', { body: { ...base, name: 'C1 internal with vendor', kind: 'internal', vendorId } });
  check('C1 a non-subco carrying a vendor is rejected', internalWithVendor.status === 400, `status=${internalWithVendor.status}`);

  const subco = await req('POST', '/resources', { body: { ...base, name: 'C1 subco ok', kind: 'subco', vendorId } });
  check('C1 a subco with a vendor is created', subco.status === 200 && subco.body?.kind === 'subco', `status=${subco.status} kind=${subco.body?.kind}`);

  const plain = await req('POST', '/resources', { body: { ...base, name: 'C1 plain resource' } });
  check('C1 an omitted kind defaults to internal', plain.status === 200 && plain.body?.kind === 'internal', `kind=${plain.body?.kind}`);
}
```

- [ ] **Step 2: Run the smoke test to verify it fails**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```
Expected: the new checks FAIL — `kind` is not in the allow-list yet, so it is dropped and every create succeeds as internal.

- [ ] **Step 3: Implement the validation**

Add `'kind'` and `'vendorId'` to `RESOURCE_FIELDS`. Then add this shared validator next to the resource handlers and call it from BOTH `POST /resources` (against the body alone) and `PUT /resources/:id` (against the merged old+new state, so a partial PUT that changes only `kind` is still checked):

```ts
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
```

In `POST /resources`, after the existing validations and before the create, run it and pin the default:

```ts
  const kindErr = await validateResourceKind(body.kind, body.vendorId);
  if (kindErr) { res.status(400).json({ error: kindErr }); return; }
  if (body.kind === undefined) body.kind = 'internal';
```

In `PUT /resources/:id`, validate the MERGED state — `body.kind ?? existing.kind` and `body.vendorId ?? existing.vendorId` — so changing only one of the two cannot produce an incoherent pair. When the merged kind is not `subco`, clear the stored vendor with an explicit `null` (which means "clear to absent" on both adapters) rather than leaving a stale one behind.

- [ ] **Step 4: Re-run the smoke test to verify it passes**

Rebuild, restart on 4173, re-run. Expected: the six new checks PASS and all 164 pre-existing checks still pass.

- [ ] **Step 5: Run the remaining gates and commit**

```bash
./node_modules/.bin/ng test && ./node_modules/.bin/ng lint
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(c1): validate resource kind and the subco vendor pairing"
```

---

### Task 4: Server — kind-aware daily cap, and the kind-change guard

**Files:**
- Modify: `src/server.ts` — the cap resolution in `PUT /assignments/:id/allocation` (~line 1718), and `PUT /resources/:id`
- Modify: `scripts/smoke-api.mjs` — extend `checkResourceKinds()`

**Interfaces:**
- Consumes: `dailyCapFor`, `kindOf` (Task 1).
- Produces: dummy/subco may be booked beyond 1 FTE/day; changing a kind that would invalidate existing allocations is refused.

- [ ] **Step 1: Write the failing smoke assertions**

Append to `checkResourceKinds()`. It needs an assignment on a dummy, so create the dummy, a request and an assignment through the API, then allocate. Read how `checkMonthlyApproval` creates its fixtures and follow the same style; the essential assertions are:

```js
  // A dummy may carry more than one FTE per day; an internal resource may not.
  const dummy = await req('POST', '/resources', { body: { ...base, name: 'C1 dummy', kind: 'dummy', contractHoursPerDay: 8 } });
  check('C1 dummy created', dummy.status === 200, `status=${dummy.status}`);

  // …create a request + an assignment for this dummy, allocate into an OPEN month…
  const overOneFte = await req('PUT', `/assignments/${dummyAssignmentId}/allocation`, {
    body: { month: OPEN_MONTH, dailyHours: { [WORKING_DAY]: 20 } },
  });
  check('C1 a dummy accepts 2.5 FTE on a day', overOneFte.status === 200, `status=${overOneFte.status} err=${overOneFte.body?.error}`);

  const internalOver = await req('PUT', `/assignments/${internalAssignmentId}/allocation`, {
    body: { month: OPEN_MONTH, dailyHours: { [WORKING_DAY]: 20 } },
  });
  check('C1 an internal resource is still capped at 1 FTE', internalOver.status === 400 && /daily capacity/.test(internalOver.body?.error || ''), `status=${internalOver.status}`);

  // Turning that dummy into an internal resource would break its own bookings.
  const demote = await req('PUT', `/resources/${dummy.body.id}`, { body: { kind: 'internal' } });
  check('C1 a kind change that breaks existing allocations is refused', demote.status === 400 && /exceed/i.test(demote.body?.error || ''), `status=${demote.status} err=${demote.body?.error}`);

  // …then zero the allocation and assert the same change now succeeds…
  const demoteOk = await req('PUT', `/resources/${dummy.body.id}`, { body: { kind: 'internal' } });
  check('C1 the same kind change succeeds once the allocation fits', demoteOk.status === 200 && demoteOk.body?.kind === 'internal', `status=${demoteOk.status}`);
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Expected: the dummy over-1-FTE check fails with 400 (`daily capacity exceeded`) because the cap is still the plain contracted hours; the kind-change checks fail because no guard exists.

- [ ] **Step 3: Widen the cap by kind**

In `PUT /assignments/:id/allocation`, the cap is resolved at ~line 1718:

```ts
  const rawCap = resource.contractHoursPerDay;
  const cap = (typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0) ? rawCap : await getHoursPerDay();
```

Keep that resolution — including its guard against 0/NaN/negative stored values — and apply the kind on top of the resolved value:

```ts
  const rawCap = resource.contractHoursPerDay;
  const baseCap = (typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0) ? rawCap : await getHoursPerDay();
  // C1: dummy and subco represent capacity that a single person does not cover,
  // so their daily ceiling is MULTI_FTE_MAX times the one-FTE base. Internal
  // resources keep the 1-FTE cap (manual §3.2.3).
  const cap = dailyCapFor(kindOf(resource), baseCap);
```

Nothing else in the handler changes: the gate still sums every assignment of the resource on that day, still re-checks inside the `res:` lock, and still reports the offending day.

- [ ] **Step 4: Guard the kind change**

In `PUT /resources/:id`, when the merged kind differs from the stored one AND the new kind is stricter (`dailyCapFor` yields a smaller cap), verify every day the resource already has booked still fits. Sum this resource's `assignmentDays` by date across all its assignments — the same shape `sumHoursByDate` already produces in the allocation handler — and refuse with 400 naming the first offending day:

```ts
  // C1: narrowing a kind (dummy/subco -> internal) shrinks the daily ceiling by
  // MULTI_FTE_MAX. Refuse if that would strand existing bookings above the new
  // cap rather than silently leaving invalid allocations behind.
  const newCap = dailyCapFor(mergedKind, baseCap);
  if (newCap < currentCap) {
    const ids = new Set((await repos.assignments.list()).filter(a => a.resourceId === existing.id).map(a => a.id));
    const byDate = sumHoursByDate((await repos.assignmentDays.list()).filter(d => ids.has(d.assignmentId)));
    const offender = Object.keys(byDate).sort().find(day => exceedsDailyCapacity(byDate[day], newCap));
    if (offender !== undefined) {
      res.status(400).json({ error: `changing kind to ${mergedKind} would exceed the daily capacity on ${offender}` });
      return;
    }
  }
```

Resolve `baseCap` the same way the allocation handler does (stored `contractHoursPerDay` with the 0/NaN/negative fallback to `getHoursPerDay()`), and reuse the existing `sumHoursByDate`/`exceedsDailyCapacity` helpers rather than reimplementing them.

- [ ] **Step 5: Re-run the smoke test to verify it passes**

Expected: all `checkResourceKinds()` checks PASS; the 164 pre-existing checks still pass.

- [ ] **Step 6: Run the remaining gates and commit**

```bash
./node_modules/.bin/ng test && ./node_modules/.bin/ng lint && ./node_modules/.bin/ng build
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(c1): kind-aware daily cap and a guard against narrowing a kind under live allocations"
```

---

### Task 5: Capacity rollup — split internal capacity from uncovered demand

**Files:**
- Modify: `src/app/services/capacity.util.ts` — `RollupInput`, `CapacityRollup`, `CapacityTotals`, `rollupMonthly`
- Modify: `src/app/services/capacity.util.spec.ts`
- Modify: `src/app/services/api.service.ts` — the mirrored `CapacityMonthly` envelope types

**Interfaces:**
- Consumes: `countsTowardInternalCapacity`, `kindOf` (Task 1).
- Produces:
  - `RollupResource` gains `kind?: string`
  - `CapacityRollup` gains `demandRows: CapacityRow[]`
  - `CapacityTotals` gains `demandFteUncovered: number`
  - `CapacityCell.band` stays `SemaphoreBand` for internal rows; demand rows carry `band: 'idle'` and MUST NOT be tinted by the UI (Task 6 renders them without a band)

- [ ] **Step 1: Write the failing test**

In `src/app/services/capacity.util.spec.ts`, add (adapting the file's existing fixture helpers):

```ts
it('keeps dummy and subco out of the internal rows, totals and headcount', () => {
  const rollup = rollupMonthly({
    resources: [
      { id: 'R1', name: 'Ada', kind: 'internal' },
      { id: 'R2', name: 'Dummy SAP', kind: 'dummy' },
      { id: 'R3', name: 'Subco Dev', kind: 'subco' },
    ],
    assignments: [
      { id: 'A1', resourceId: 'R1' },
      { id: 'A2', resourceId: 'R2' },
      { id: 'A3', resourceId: 'R3' },
    ],
    assignmentMonths: [
      { assignmentId: 'A1', month: '2026-09', status: 'Allocated' },
      { assignmentId: 'A2', month: '2026-09', status: 'Allocated' },
      { assignmentId: 'A3', month: '2026-09', status: 'Allocated' },
    ],
    assignmentDays: [
      { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
      { assignmentId: 'A2', date: '2026-09-01', hours: 16 },
      { assignmentId: 'A3', date: '2026-09-01', hours: 8 },
    ],
    months: ['2026-09'],
    hoursPerDay: 8,
    holidays: new Set<string>(),
  });

  expect(rollup.rows.map(r => r.resourceId)).toEqual(['R1']);
  expect(rollup.demandRows.map(r => r.resourceId)).toEqual(['R2', 'R3']);
  // One internal head, so one FTE of capacity — the dummy and the subco add none.
  expect(rollup.totals['2026-09'].resourceCount).toBe(1);
  expect(rollup.totals['2026-09'].capacityFte).toBeCloseTo(1, 5);
});

it('reports uncovered demand separately from internal demand', () => {
  const rollup = rollupMonthly({
    resources: [
      { id: 'R1', name: 'Ada', kind: 'internal' },
      { id: 'R2', name: 'Dummy SAP', kind: 'dummy' },
    ],
    assignments: [{ id: 'A1', resourceId: 'R1' }, { id: 'A2', resourceId: 'R2' }],
    assignmentMonths: [
      { assignmentId: 'A1', month: '2026-09', status: 'Allocated' },
      { assignmentId: 'A2', month: '2026-09', status: 'Requested' },
    ],
    assignmentDays: [
      { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
      { assignmentId: 'A2', date: '2026-09-01', hours: 16 },
    ],
    months: ['2026-09'],
    hoursPerDay: 8,
    holidays: new Set<string>(),
  });

  const t = rollup.totals['2026-09'];
  const standard = standardMonthlyHours('2026-09', 8, new Set<string>());
  // The internal figure counts only Ada; the uncovered figure only the dummy,
  // and it follows the same planned (Requested + Allocated) rule.
  expect(t.demandFtePlanned).toBeCloseTo(8 / standard, 5);
  expect(t.demandFteUncovered).toBeCloseTo(16 / standard, 5);
});

it('treats a resource with no kind as internal', () => {
  const rollup = rollupMonthly({
    resources: [{ id: 'R1', name: 'Legacy row' }],
    assignments: [{ id: 'A1', resourceId: 'R1' }],
    assignmentMonths: [{ assignmentId: 'A1', month: '2026-09', status: 'Allocated' }],
    assignmentDays: [{ assignmentId: 'A1', date: '2026-09-01', hours: 8 }],
    months: ['2026-09'], hoursPerDay: 8, holidays: new Set<string>(),
  });
  expect(rollup.rows.map(r => r.resourceId)).toEqual(['R1']);
  expect(rollup.demandRows).toEqual([]);
});
```

Add `standardMonthlyHours` to the spec's imports if it is not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test`
Expected: FAIL — `demandRows` and `demandFteUncovered` do not exist.

- [ ] **Step 3: Implement the partition**

In `src/app/services/capacity.util.ts`:

```ts
interface RollupResource { id: string; name: string; kind?: string; contractHoursPerDay?: number; hireDate?: string; terminationDate?: string; }

export interface CapacityTotals {
  demandFteConfirmed: number; demandFtePlanned: number; capacityFte: number; resourceCount: number;
  /** C1: planned FTE booked on dummy/subco — capacity that does not exist yet. */
  demandFteUncovered: number;
}

export interface CapacityRollup {
  months: string[];
  rows: CapacityRow[];
  /** C1: dummy and subco rows. Same monthly cells, but no capacity and no band. */
  demandRows: CapacityRow[];
  totals: Record<string, CapacityTotals>;
}
```

In `rollupMonthly`, initialise `demandFteUncovered: 0` alongside the other totals, and in the per-resource loop branch on the kind. Internal resources keep today's behaviour exactly (cells with a band, `demandFte*`, `capacityFte`, `resourceCount`); dummy/subco build the same monthly cells but add only to `demandFteUncovered`, contribute no capacity and no headcount, and land in `demandRows`. Their cells carry `band: 'idle'` as an inert placeholder — Task 6 renders demand rows without a tint, and the field exists only so the two row lists share one type.

Keep `isActiveInMonth` applied to BOTH lists: a terminated subco should not show a month it cannot work.

Mirror the two type changes in `src/app/services/api.service.ts`'s `CapacityMonthly` envelope so the client sees the same shape.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/ng test`
Expected: PASS. Fix any existing capacity fixture that now needs `demandRows` in its expected object.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/capacity.util.ts src/app/services/capacity.util.spec.ts src/app/services/api.service.ts
git commit -m "feat(c1): split the capacity rollup into internal rows and uncovered demand"
```

---

### Task 6: `/capacity` endpoint and dashboard

**Files:**
- Modify: `src/server.ts` — the `rollupMonthly` call in `/capacity/monthly` (~line 1923)
- Modify: `src/app/capacity/capacity.component.ts` + `src/app/capacity/capacity.component.spec.ts`
- Modify: `scripts/smoke-api.mjs` — extend `checkResourceKinds()`

**Interfaces:**
- Consumes: the Task 5 envelope (`demandRows`, `demandFteUncovered`).

- [ ] **Step 1: Feed the kind from the server**

In the `/capacity/monthly` handler, the resources are mapped into `rollupMonthly`'s input — add `kind: r.kind` to that mapping. One line; nothing else in the handler changes.

- [ ] **Step 2: Write the failing smoke assertion**

Append to `checkResourceKinds()`:

```js
  const cap = await req('GET', '/capacity/monthly');
  check('C1 capacity envelope carries demandRows', Array.isArray(cap.body?.demandRows), `status=${cap.status}`);
  const kindsInRows = (cap.body?.rows || []).map(r => r.resourceId);
  const demandIds = (cap.body?.demandRows || []).map(r => r.resourceId);
  check('C1 the dummy is in demandRows, not rows',
    demandIds.includes(dummyId) && !kindsInRows.includes(dummyId),
    `rows=${kindsInRows.length} demand=${demandIds.length}`);
  const firstMonth = (cap.body?.months || [])[0];
  check('C1 totals expose uncovered demand separately',
    firstMonth !== undefined && typeof cap.body.totals[firstMonth]?.demandFteUncovered === 'number',
    `totals=${JSON.stringify(cap.body?.totals?.[firstMonth])}`);
```

Use the dummy id you created earlier in the section, and make sure that dummy still has an allocation in the window at this point.

- [ ] **Step 3: Write the failing component test**

In `src/app/capacity/capacity.component.spec.ts`, extend the `ENVELOPE` fixture with a `demandRows` entry and a `demandFteUncovered` total, then add:

```ts
it('renders uncovered demand in its own section, without a semaphore band', async () => {
  const { fixture } = setup(true);
  await flush(fixture);

  const host = fixture.nativeElement as HTMLElement;
  const demand = host.querySelectorAll('[data-test="demand-row"]');
  expect(demand.length).toBe(1);
  expect(demand[0].textContent).toContain('Dummy SAP');
  // A demand cell must not carry a band tint class — it has no capacity to saturate.
  expect(demand[0].querySelector('[data-test="band-cell"]')).toBeNull();
  expect(host.querySelector('[data-test="kpi-uncovered"]')?.textContent).toContain('2.0');
});
```

Adapt the expected FTE to whatever you put in the fixture, and give the EXISTING internal band cells the `data-test="band-cell"` attribute if they do not have one, so the assertion means something.

- [ ] **Step 4: Run both to verify they fail**

Run the unit suite and the smoke run.
Expected: the component case fails (no demand section), the smoke checks fail (no `demandRows` in the envelope until Step 1 is built — if you did Step 1 first, they pass and only the component case fails; say which in your report).

- [ ] **Step 5: Render the section**

In `capacity.component.ts`, after the existing grid, add an *Uncovered demand* section that renders `demandRows` with the same month columns and the same hours/FTE formatting, each row tagged `data-test="demand-row"`, and **no band tint**. Add a KPI tile `data-test="kpi-uncovered"` reading the month's `demandFteUncovered`, next to the existing capacity/demand tiles. Reuse the existing table markup, the `MONTH_FMT` label helper and the `command-*` classes — do not invent a new layout. Copy in English: *Uncovered demand*, and a one-line explanation that these are dummy and subco resources, which have no capacity of their own.

- [ ] **Step 6: Run everything to verify it passes**

`./node_modules/.bin/ng test`, `./node_modules/.bin/ng lint`, `./node_modules/.bin/ng build`, then the live smoke run.
Expected: all green, 164 pre-existing smoke checks intact.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/app/capacity scripts/smoke-api.mjs
git commit -m "feat(c1): surface uncovered demand on the capacity dashboard"
```

---

### Task 7: Resource form — kind, vendor, badge, filter

**Files:**
- Modify: `src/app/resources/resources.component.ts`
- Test: add cases to the file's existing spec if it has one; otherwise create `src/app/resources/resources.component.spec.ts` with the two cases below

**Interfaces:**
- Consumes: `RESOURCE_KINDS`, `kindOf` (Task 1); `Resource.kind`/`vendorId` (Task 2); the `/vendors` catalog read (`ApiService` already exposes it — check the method name before using it).

- [ ] **Step 1: Write the failing test**

Model the setup on `src/app/capacity/capacity.component.spec.ts` (stubbed `ApiService`, `AuthService` with `authReady` true):

```ts
it('shows the vendor field only when the kind is subco', async () => {
  const { fixture } = setup();
  await flush(fixture);

  const host = fixture.nativeElement as HTMLElement;
  // Open the create form the same way the component does (read the template first).
  expect(host.querySelector('[data-test="res-vendor"]')).toBeNull();

  fixture.componentInstance.form.controls.kind.setValue('subco');
  fixture.detectChanges();
  expect(host.querySelector('[data-test="res-vendor"]')).not.toBeNull();
});

it('marks the vendor control required for a subco and optional otherwise', () => {
  const { fixture } = setup();
  const form = fixture.componentInstance.form;

  form.controls.kind.setValue('subco');
  form.controls.vendorId.setValue('');
  expect(form.controls.vendorId.valid).toBe(false);

  form.controls.kind.setValue('internal');
  expect(form.controls.vendorId.valid).toBe(true);
});
```

Adjust the control names to whatever the reactive form actually uses — read the `FormGroup` definition (~line 486) first.

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — no `kind`/`vendorId` controls.

- [ ] **Step 3: Implement**

Add `kind` and `vendorId` controls to the form group, defaulting `kind` to `'internal'`. Render a kind `<select>` over `RESOURCE_KINDS` with readable labels (*Internal* / *Dummy (placeholder)* / *Subcontractor*), and a vendor `<select>` — `data-test="res-vendor"` — populated from the vendors catalog, rendered only when the kind is `subco` and validated as required in that case (wire the validator dynamically on the kind's `valueChanges`, or use a form-level validator; pick one and comment which). Follow the file's existing pattern for a catalog-backed select — the organization field (~line 184) is the closest example, including how it keeps an orphan stored value selectable.

In the resource list, add a kind badge next to the name (`command-status` classes, `-text` shade) and a kind filter alongside the existing search. Copy in English.

- [ ] **Step 4: Run the gates and verify in the browser**

`./node_modules/.bin/ng test`, `ng lint`, `ng build`. Then `./node_modules/.bin/ng serve`: create a subco without a vendor and confirm the form blocks it; create one with a vendor and confirm it appears in the list with its badge; switch the kind back to internal and confirm the vendor field disappears.

- [ ] **Step 5: Commit**

```bash
git add src/app/resources
git commit -m "feat(c1): resource form kind selector, conditional vendor, list badge and filter"
```

---

### Task 8: Calendar — the FTE selector for dummy and subco

**Files:**
- Modify: `src/app/allocation-calendar/allocation-calendar.component.ts`
- Test: `src/app/allocation-calendar/allocation-calendar.component.spec.ts` (create it — this component has none, and B3's review flagged that as a gap)

**Interfaces:**
- Consumes: `isMultiFteEligible`, `dailyCapFor`, `kindOf` (Task 1); the `GET /assignments/:id/allocation` envelope, which must now carry the resource's kind.

- [ ] **Step 1: Expose the kind on the allocation envelope**

`GET /assignments/:id/allocation` already returns `contractHoursPerDay`; add `resourceKind` next to it, read from the resource the handler has already loaded. Mirror the field on `AssignmentAllocation` in `api.service.ts`. One line each — the calendar cannot decide what to offer without it.

- [ ] **Step 2: Write the failing component test**

Create `src/app/allocation-calendar/allocation-calendar.component.spec.ts`. Stub `ApiService` with `getAssignmentAllocation` (check the real method name) returning an envelope with `resourceKind: 'dummy'`, plus the planning periods and holidays the component loads; stub `AuthService` with `authReady` true and `NotificationService` with `vi.fn()`s:

```ts
it('offers the FTE selector for a dummy', async () => {
  const { fixture } = setup('dummy');
  await flush(fixture);
  expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="fte-select"]')).not.toBeNull();
});

it('hides the FTE selector for an internal resource', async () => {
  const { fixture } = setup('internal');
  await flush(fixture);
  expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="fte-select"]')).toBeNull();
});

it('fills every working day with hours = fte × contracted hours', async () => {
  const { fixture, api } = setup('dummy');
  await flush(fixture);

  fixture.componentInstance.applyFte('2026-09', 2.5);
  fixture.detectChanges();

  // 8 contracted hours × 2.5 FTE = 20h on each working day of the month.
  const edited = fixture.componentInstance.editedHours('2026-09');
  const values = Object.values(edited);
  expect(values.length).toBeGreaterThan(0);
  expect(new Set(values)).toEqual(new Set([20]));
});
```

Adapt `editedHours` to whatever accessor the component exposes for a month's pending edits — read the class first, and if none is public, expose a narrow one for the test rather than reaching into internals.

- [ ] **Step 3: Run the test to verify it fails**

Expected: FAIL — no selector, no `applyFte`.

- [ ] **Step 4: Implement**

The month action bar already has `fill(month, 1)` / `fill(month, 0.5)` / `clear(month)` (~line 139). Add, **only when `isMultiFteEligible(kindOf({kind: resourceKind()}))`**, an FTE `<select>` (`data-test="fte-select"`) offering 1 · 1.5 · 2 · 2.5 · 3 · 4 · 5 · 10 · 20 · 30 — the manual's range in usable steps — that calls `applyFte(month, fte)`. Implement `applyFte` on top of the existing `fill` logic, which already writes `cap × fraction` on every working day: an FTE value is just a fraction greater than 1, so the two share one code path rather than duplicating the working-day walk.

The per-day capacity hint must use `dailyCapFor(kind, contractHoursPerDay)` so a dummy at 20h is not flagged red against a 1-FTE ceiling.

**Care required:** this component produced two reactivity defects in B3 — a `linkedSignal` that dropped unsaved edits in sibling months, and one that reset the selected month on every reload. Do not introduce new `linkedSignal` sources over the loaded data; write through the existing edit-map signal the way `fill` does.

- [ ] **Step 5: Run the gates and verify in the browser**

Unit, lint, build, then `ng serve`: open the calendar on a seeded dummy, set 2.5 FTE, confirm the days show 20h and no red flag, save, and confirm the server accepts it. Then open the calendar on an internal resource and confirm the selector is absent.

- [ ] **Step 6: Commit**

```bash
git add src/app/allocation-calendar src/server.ts src/app/services/api.service.ts
git commit -m "feat(c1): multi-FTE selector on the allocation calendar for dummy and subco"
```

---

### Task 9: Staffing picker badge, docs, and full verification

**Files:**
- Modify: `src/app/staffing/staffing.component.ts`
- Modify: `docs/architecture/03-backend-and-data.md`
- Modify: `scripts/smoke-api.mjs` (final pass, if anything is missing)

- [ ] **Step 1: Badge the resource picker**

In the staffing resource selector, show the kind badge next to each non-internal resource's name, so a planner does not pick a dummy believing it is a person. Reuse the badge markup from Task 7 rather than writing a second one — if that means extracting a tiny shared helper or a two-line snippet, do the smallest thing that avoids two divergent badges, and say what you chose.

- [ ] **Step 2: Update the entity catalogue**

In `docs/architecture/03-backend-and-data.md`, note the two new `resources` columns and what they mean, and correct the table count if the new migration changed it.

- [ ] **Step 3: Full gate set**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```
Expected: unit green, lint clean, build succeeds, smoke 164 + the C1 checks, zero regressions.

- [ ] **Step 4: Postgres parity run**

Create a FRESH database (the shared `…/postgres` one carries state from earlier runs and cannot produce a clean baseline), start the built server against it with `DATABASE_URL`, confirm in the boot output that migration `0011` applied and the seeded dummy/subco rows are present, run the same smoke suite, then drop the database. Report the evidence. If Docker is unavailable, say so explicitly rather than skipping silently.

- [ ] **Step 5: Commit**

```bash
git add src/app/staffing docs/architecture/03-backend-and-data.md scripts/smoke-api.mjs
git commit -m "feat(c1): kind badge in the staffing picker, entity catalogue update"
```

---

## Verification Checklist (before merge)

- [ ] A subco cannot exist without a vendor; nobody else can carry one.
- [ ] An omitted `kind` reads as `internal` everywhere, including on rows written before the migration.
- [ ] A dummy accepts more than 1 FTE per day; an internal resource still cannot.
- [ ] A dummy's month still appears in the `/allocation-approvals` feed and is decidable — the People Manager approves placeholders like anyone else, and C2's substitution will hang off exactly that row.
- [ ] Narrowing a kind under live allocations is refused, naming the offending day.
- [ ] `/capacity` keeps dummy and subco out of `rows`, `capacityFte` and `resourceCount`, and reports them under uncovered demand.
- [ ] The FTE selector appears only on dummy and subco, and writes `fte × contracted hours` on working days only.
- [ ] Unit, lint, build, live smoke and the Postgres run are all green.
