# Block E — Frozen Monthly PCP Baseline: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `finance`/`delivery-executive`/`admin` freeze a monthly cost baseline per project (budget/PCP), and let them plus `pm`/`resource-manager` compare it, month by month, against the live plan — surfaced on the Project 360, the portfolio dashboard, and the Margin & Variance report.

**Architecture:** A new pure function, `plannedCostSchedule` (same shape as `recognitionSchedule`), joins per-day booked hours (`AssignmentDay`, gated by its owning `AssignmentMonth.status`) with each resource's **resolved** `costRate` to give the cost side of the plan a monthly bucketing it does not have today. A second pure function, `costBaselineComparison`, diffs that live schedule against the **current** frozen row per period (the row with the latest `frozenAt` for that `(projectId, period)` — a re-freeze is a new row, never an `UPDATE`). A new `cost_baselines` table stores write-once snapshots behind a bespoke, per-project-lock-serialized `POST` handler that builds its own resolved-rate `FinanceData` — **never** `loadFinanceData()`, whose `resources` field is a documented, still-open EUR/day-vs-EUR/hour hazard.

**Tech Stack:** Angular 21 (standalone, signals, OnPush), Express 5, Drizzle ORM + PostgreSQL, Vitest, dependency-free scripts.

**Spec:** `docs/superpowers/specs/2026-08-04-e-pcp-baseline-design.md` — authoritative. Read the section named in each task. Verified against the tree on `feature/e-pcp-baseline` on 2026-08-05: every file:line the spec cites still matched exactly (see the closing report).

## Global Constraints

- **Persistence parity.** The same route handlers run over `InMemoryRepository` (dev, `DATABASE_URL` unset) and `PgRepository` (Postgres/Drizzle). `nullsToUndefined()` runs on every *return* path, never on values handed to `.set()`. An all-`undefined` patch short-circuits `PgRepository.update()` to a plain `get(id)`. `pick()` forwards an explicit JSON `null` and filters only `undefined` — never let that reach a `notNull` column. Postgres FK violations (`23503`) map to a clean 409. `src/db/seed.ts` is the single source of truth for seed data, consumed by both adapters; seeding is parent-before-child and only when a table is empty (`count(*) === 0`).
- **`withLock(key, fn)`** (`src/server.ts:217-226`) serializes a read-modify-write per key via a chained tail promise; it is **not re-entrant**.
- **RBAC:** `roleGate` (`src/server.ts`) keeps **separate** `rules` (mutation, `src/server.ts:647-679`) and `READ_RULES` (`src/server.ts:701-734`) arrays. `pick()` is the mass-assignment guard.
- **Audit is append-only.** The global middleware (`src/server.ts:820-859`, mounted via `apiRouter.use(...)` before every route) snapshots the targeted entity before PUT/DELETE and, on any successful (`< 400`) `POST`/`PUT`/`DELETE` response, appends an `AuditEntry` attributed to the **trusted** actor (`auditActorId`/`trustedRole`, never raw `X-User-*`). For **POST** specifically it still appends an entry (id/at/actor/method/path/status) but `before`/`after`/`changedKeys` stay `undefined` — those are only populated for PUT/DELETE (`src/server.ts:827,833,848`). This means **any new `POST /cost-baselines` is already audited from its first commit with zero extra wiring** — verify it, do not build a parallel mechanism. Note for anyone reasoning about ids: this codebase's `newId()` (`src/server.ts:266`, aliasing `newEntityId` in `src/server/entity-id.util.ts`) now returns a `crypto.randomUUID()`, not a numeric sequence — the historical "off-by-one on a re-seeded numeric sequence" failure mode this project once had does not apply to freshly-generated ids; it *does* still mean the audit middleware allocates one more UUID per successful mutating call, which matters only if a test asserts on `audit_logs` row *count*, never on numeric id gaps.
- **Displayed precision:** amounts/day-or-FTE counts/percentages never render with more than 2 decimals — screens, CSV, chart labels. Use `currency:'EUR':'symbol':'1.0-0'` for EUR (matching the adjacent `eac`/`vac` cells) and an explicit `number:'1.0-2'` for `deltaPct` (never the `DecimalPipe` default of `1.0-3`).
- **Unit of measure.** `resource.costRate` as consumed by `plannedCostSchedule` must be the **resolved** EUR/HOUR value (`override ?? rate card`, already divided by `hoursPerDay` by `withEffectiveRates`, `src/server.ts:1629-1644`) — never the raw `resources.cost_rate` column, which is EUR/DAY. The freeze handler must call **`resolveResourceRates(await repos.resources.list())`** (`src/server.ts:1646-1650`) directly; it must **not** call `loadFinanceData()` (`src/server.ts:6529-6547`), whose own doc comment (`src/server.ts:6517-6527`) records that its `resources` field is deliberately still the raw, unresolved row (EUR/DAY) — the exact defect shape that once inflated `sell-rate.util.ts` revenue ~8x.
- **The `authReady` pattern.** Every `rxResource` keys `params` on `auth.authReady()` (plus, for this block's new resources, `auth.canReadStaffing()` — see Task 6) and returns an empty default until ready. Never snapshot `auth.userId()`/`auth.role()` at field-init.
- **A failed or forbidden read must never render as a zero.** Three states: role may read → render; role may not read → the section is **absent** (never mounted, no zeroed numbers); a read failed or is pending → the existing `<app-list-state>` component (`src/app/shared/list-state.component.ts`) shows a skeleton or a "Couldn't load … / Retry" panel — reuse it, do not invent new copy.
- **Error toasts auto-dismiss**, timers browser-only.
- **UI copy is English.**
- **Angular 21 idiom:** standalone, `OnPush`, signals, native control flow, `inject()` in field initializers. Bespoke `command-*` classes + tokens in `src/styles.css`; Material for icons only. Verify every class name exists before using it (`command-kpi`, `command-card`, `command-status`, `command-skeleton`, `command-data-table`, `command-button`, `text-positive-text`, `text-critical-text` are all confirmed present).
- **Tests are Vitest** via `@angular/build:unit-test`. Commands: `npm test`, `npm run lint`, `npm run build`. Smoke: `AUTH_TRUST_HEADERS=true` + `node scripts/smoke-api.mjs`; `scripts/smoke-noauth.mjs` (flag unset) must stay green.
- **Traps already paid for here:** `[value]` on a `<select>` populated by `@for` is silently dropped — use per-`<option>` `[selected]` (not needed by this block's UI, but keep in mind if a select is added). `fixture.nativeElement.querySelector<T>()` does not compile — cast the host once (`function host(fixture): HTMLElement { return fixture.nativeElement as HTMLElement; }`, as `reporting.spec.ts`/`contract-details.spec.ts` already do). `fixture.whenStable()` hangs while an `rxResource` stream is open — use the microtask-tick helper (`contract-details.spec.ts:24-31`) instead. `??` treats an explicit `null` as absent — be deliberate. A discriminant string must match exact casing. Seed ids must exist and be the right kind.
- **Test design.** For every test, name the seed row or fixture that makes it fail if the code is wrong. Every non-trivial test gets an explicit mutation step (break the code, confirm red, before committing). Every non-regression check gets its positive twin. Pair every presence assertion with an absence assertion. **`—` (em dash)** is the established convention for "no percentage available" (`reporting.ts:139,204,1381` — confirmed unchanged); never invent another placeholder.

---

### Task 1: `cost_baselines` table, migration, seed fixture, and API plumbing

**Spec:** §3 (data model), §10 (seed fixture) in full.

**Files:**
- Modify: `src/db/schema.ts` (new table, after the `negotiatedRates` block ending at line 488)
- Modify: `src/app/services/api.service.ts` (new `CostBaseline` interface after `RateCard`, ~line 502; new `ApiService` methods after the negotiated-rate methods, ~line 1216)
- Modify: `src/db/seed.ts` (add request `'7'` + assignment `'7'` to the existing arrays; add a new `costBaselines` export)
- Modify: `src/db/repositories.ts` (add `costBaselines` to the `Repositories` interface at line 330, the Postgres adapter at line 412, the in-memory adapter at line 481; add `CostBaseline` to the type-only import block, line 66)
- Modify: `src/db/bootstrap.ts` (add a `seedIfEmpty` call for `costBaselines`, after `assignmentMonths`)
- Create: `drizzle/0018_*.sql` — generated by `drizzle-kit generate`, never hand-written
- Create: `src/db/seed.spec.ts` (new file — pins the fixture)

**Interfaces:**
- Consumes: nothing new (`projects` FK already exists).
- Produces — later tasks depend on these exact names/types:

```ts
// src/app/services/api.service.ts
export interface CostBaseline {
  id: string;
  projectId: string;
  period: string;    // 'YYYY-MM'
  amount: number;    // EUR, frozen at write time, never recomputed
  frozenAt: string;  // ISO timestamp
  frozenBy: string;  // the freezing user's id
}
```
- `repos.costBaselines: Repository<CostBaseline>` (both adapters).
- `ApiService.getCostBaselines(): Observable<CostBaseline[]>`, `ApiService.freezeCostBaseline(projectId: string): Observable<CostBaseline[]>` (client methods; the server route they call is built in Task 5 — these methods can be added now so Task 6-8 have a stable client surface to import).
- Seed rows: `requests` gains id `'7'` (`projectId: '1'`); `assignments`/`assignmentDays`/`assignmentMonths` gain id `'7'` / `'7:2026-10-05'` / `'7:2026-10'`; `costBaselines` exports `[CB1, CB2]`.

- [ ] **Step 1: Write the failing seed-pinning test**

Create `src/db/seed.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { requests, assignments, assignmentDays, assignmentMonths, costBaselines } from './seed';

describe('cost-baseline seed fixture (design spec, block E)', () => {
  it('adds request \'7\' staffing project \'1\' for the Consultant role', () => {
    const r = requests.find(x => x.id === '7');
    expect(r).toBeDefined();
    expect(r?.projectId).toBe('1');
    expect(r?.requiredRole).toBe('Consultant');
  });

  it('books assignment \'7\' for resource \'2\' (John Miller) on 2026-10-05 only', () => {
    const a = assignments.find(x => x.id === '7');
    expect(a).toBeDefined();
    expect(a?.resourceId).toBe('2');
    expect(a?.requestId).toBe('7');
    expect(a?.startDate).toBe('2026-10-05');
    expect(a?.endDate).toBe('2026-10-05');
    expect(a?.assignedHours).toBe(8);
  });

  it('derives an Allocated 2026-10 month row for assignment \'7\' with 8 booked hours on 2026-10-05', () => {
    const days = assignmentDays.filter(d => d.assignmentId === '7');
    expect(days.map(d => d.date)).toEqual(['2026-10-05']);
    expect(days.map(d => d.hours)).toEqual([8]);
    const m = assignmentMonths.find(x => x.id === '7:2026-10');
    expect(m?.status).toBe('Allocated');
  });

  it('freezes CB1 at 600 EUR for project \'1\' period 2026-10 (live plan will be 720 -> +120 / +20.00%)', () => {
    expect(costBaselines.find(c => c.id === 'CB1')).toEqual({
      id: 'CB1', projectId: '1', period: '2026-10', amount: 600,
      frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4',
    });
  });

  it('freezes CB2 at 500 EUR for project \'1\' period 2026-11, a month project \'1\' has no booked hours in (live plan will be 0 -> -500 / null)', () => {
    expect(costBaselines.find(c => c.id === 'CB2')).toEqual({
      id: 'CB2', projectId: '1', period: '2026-11', amount: 500,
      frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4',
    });
    // Project '1's only assignments are '1', '2' and '7' (requests '1'/'3'/'7' all
    // carry projectId '1'); none has a day in November.
    expect(assignmentDays.some(d => d.date.startsWith('2026-11') && ['1', '2', '7'].includes(d.assignmentId))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `./node_modules/.bin/ng test --include='**/db/seed.spec.ts'`
Expected: FAIL — request/assignment `'7'` and `costBaselines` do not exist yet.

- [ ] **Step 3: Declare the table**

In `src/db/schema.ts`, immediately after the `negotiatedRates` block (which ends at line 488, right before the `holidays` comment block):

```ts
// COST BASELINES — a frozen monthly PCP/budget snapshot per project (design
// spec, block E). WRITE-ONCE: `amount` is written at freeze time and never
// recomputed (spec §3.1). NO unique constraint on (project_id, period): a
// re-freeze (spec §3.4) writes a NEW row rather than updating the old one, so
// more than one row can share a (project_id, period) pair — the CURRENT
// baseline for a period is, by definition, the row with the latest
// frozen_at for that pair (resolved in `costBaselineComparison`, never here).
// `frozen_at` is `text()` (ISO string), matching this schema's stated
// date/time convention (see the file header) rather than a native timestamp.
export const costBaselines = pgTable(
  'cost_baselines',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => projects.id),
    period: text('period').notNull(), // 'YYYY-MM'
    amount: doublePrecision('amount').notNull(), // EUR, frozen — never recomputed
    frozenAt: text('frozen_at').notNull(),
    frozenBy: text('frozen_by').notNull(),
  },
  (t) => [
    index('cost_baselines_project_id_idx').on(t.projectId),
    index('cost_baselines_project_period_idx').on(t.projectId, t.period),
  ],
);
```

- [ ] **Step 4: Add the client type and API methods**

In `src/app/services/api.service.ts`, immediately after the `RateCard` interface (ends line 502), before `Setting`:

```ts
/** A frozen monthly PCP/budget snapshot (design spec, block E). Write-once per
 *  row: a re-freeze appends a NEW row, never updates an existing one. */
export interface CostBaseline {
  id: string;
  projectId: string;
  period: string;
  amount: number;
  frozenAt: string;
  frozenBy: string;
}
```

Immediately after the negotiated-rates methods (ending line 1216), before the `getHoursPerDay` block:

```ts
// COST BASELINES (design spec, block E) — a frozen monthly PCP snapshot.
// No PUT/DELETE: a re-freeze (POST again) writes a NEW batch of rows rather
// than mutating existing ones (design spec §3.4/§3.5).
getCostBaselines(): Observable<CostBaseline[]> { return this.http.get<CostBaseline[]>(`${this.baseUrl}/cost-baselines`); }
freezeCostBaseline(projectId: string): Observable<CostBaseline[]> { return this.http.post<CostBaseline[]>(`${this.baseUrl}/cost-baselines`, { projectId }); }
```

- [ ] **Step 5: Wire the repository**

In `src/db/repositories.ts`, add `CostBaseline` to the type-only import block (line 66, after `NegotiatedRate`); then:

```ts
// interface Repositories, line 330 (after negotiatedRates):
  costBaselines: Repository<CostBaseline>;

// Postgres adapter, line 412 (after negotiatedRates):
    costBaselines: pg<CostBaseline>(schema.costBaselines),

// In-memory adapter, line 481 (after negotiatedRates):
    costBaselines: mem<CostBaseline>(seed.costBaselines),
```

- [ ] **Step 6: Wire the seed order in bootstrap.ts**

In `src/db/bootstrap.ts`, immediately after `await seedIfEmpty(database, schema.assignmentMonths, seed.assignmentMonths);` (in the "Demand/staffing fulfilment" block):

```ts
  // Cost baselines (design spec, block E) FK only to projects, but are seeded
  // here — after assignments/assignmentDays/assignmentMonths — purely for
  // narrative grouping: the demo rows (CB1/CB2) document specific booked
  // hours on assignment '7' above. The only LOAD-BEARING order requirement is
  // "after projects", already satisfied far earlier in this function.
  await seedIfEmpty(database, schema.costBaselines, seed.costBaselines); // -> projects
```

- [ ] **Step 7: Add the seed fixture**

In `src/db/seed.ts`, add to the `requests` array (after id `'6'`):

```ts
  // COST BASELINE (block E) — the request that staffs the assignment below.
  { id: '7', name: 'Project Alpha - PCP Baseline Demo', requiredRole: 'Consultant', requiredEffort: 8, staffedEffort: 8, staffedEffortPlanned: 8, status: 'Fulfilled', skills: ['Project Management'], description: 'Demonstrates the frozen monthly cost baseline vs the live plan (design spec, block E)', startDate: '2026-10-05', endDate: '2026-10-05', requesterId: '1', projectId: '1' },
```

Add to `assignmentsBase` (after id `'6'`):

```ts
  // COST BASELINE (block E): John Miller (resource '2', Consultant, costRate
  // override 720 EUR/DAY -> resolved 90 EUR/HOUR at hoursPerDay=8) booked for
  // ONE working day on project '1' (Fixed Price CT1 — the baseline prices
  // COST, not T&M revenue, so the contract type is irrelevant here),
  // 2026-10-05 (a Monday, no holiday, no other October booking for John).
  // Planned cost for period '2026-10' = 8h x 90 EUR/h = 720 EUR exactly —
  // hand-verifiable against cost_baselines 'CB1' below (600 -> delta +120 /
  // +20.00%).
  { id: '7', requestId: '7', resourceId: '2', assignedHours: 8, startDate: '2026-10-05', endDate: '2026-10-05', allocationPct: 20 },
```

Add a new exported array after `negotiatedRates` (near line 691), importing `CostBaseline` into the type-only import block at the top of the file:

```ts
// COST BASELINES (design spec, block E) — frozen monthly PCP snapshot.
// 'CB1' undercounts October: the live plan (720, see assignment '7' above)
// exceeds it -> delta +120 EUR / +20.00%, the "spending more than planned"
// case this block exists to surface.
// 'CB2' has NO assignmentDay in project '1' for November in this seed ->
// planned = 0, delta = 0 - 500 = -500 EUR, deltaPct: null (rendered '—') —
// the descoped-month case (design spec §4).
// Free, from existing seed data: assignments '1'/'2' of project '1' (May-Aug
// 2026) carry no cost_baselines row at all, exercising
// outOfBaselineHorizon: true for those four months with no new fixture.
export const costBaselines: CostBaseline[] = [
  { id: 'CB1', projectId: '1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4' },
  { id: 'CB2', projectId: '1', period: '2026-11', amount: 500, frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4' },
];
```

- [ ] **Step 8: Run the seed test green**

Run: `./node_modules/.bin/ng test --include='**/db/seed.spec.ts'`
Expected: PASS.

- [ ] **Step 9: Mutate and confirm red**

Temporarily change `CB1`'s `amount` from `600` to `650` in `src/db/seed.ts`. Run: `./node_modules/.bin/ng test --include='**/db/seed.spec.ts'`. Expected: FAIL on the CB1 `toEqual`. Revert to `600`.

- [ ] **Step 10: Generate the migration and read it**

Run: `./node_modules/.bin/drizzle-kit generate`
Read the generated `drizzle/0018_*.sql`. It must be one `CREATE TABLE "cost_baselines"`, one FK to `projects`, and two `CREATE INDEX` statements — the same shape as the design spec's own §3.3 SQL:

```sql
CREATE TABLE "cost_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"period" text NOT NULL,
	"amount" double precision NOT NULL,
	"frozen_at" text NOT NULL,
	"frozen_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_baselines" ADD CONSTRAINT "cost_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cost_baselines_project_id_idx" ON "cost_baselines" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "cost_baselines_project_period_idx" ON "cost_baselines" USING btree ("project_id","period");
```

If it proposes anything else, stop and report it.

- [ ] **Step 11: Boot both adapters**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
curl -s http://localhost:4173/api/cost-baselines
kill %1
```

Confirm the response includes `CB1` and `CB2`. Then on a **genuinely fresh** Postgres database (`docker compose up -d postgres`, create an empty DB, run with `DATABASE_URL`, drop it after): confirm every migration applies and `CB1`/`CB2` round-trip. **Mandatory** — a bad seed order would only surface here (in-memory enforces no FK). If Docker is unavailable, say so prominently.

- [ ] **Step 12: Commit**

```bash
git add src/db src/app/services/api.service.ts drizzle
git commit -m "feat: cost_baselines table, seed fixture, and repository wiring"
```

---

### Task 2: `plannedCostSchedule` — the monthly cost derivation

**Spec:** §2 (the join), §9 (units), §10 (unit test) in full.

**Files:**
- Modify: `src/app/services/finance.util.ts` (new `PlannedCostPeriod` interface + `plannedCostSchedule` function, after `plannedLaborCostForProject`, ~line 131; extend `FinanceData` at lines 6-53)
- Modify: `src/app/services/finance.util.spec.ts` (new fixture helpers + test suite)

**Interfaces:**
- Consumes: `monthRowId` from `./allocation-month.util` (`export function monthRowId(assignmentId: string, month: string): string`), `monthOf` from `./calendar.util` (`export function monthOf(date: string): string`) — both already exported and pure.
- Produces — Tasks 4 and 5 depend on these exact names/types:

```ts
export interface PlannedCostPeriod {
  period: string;
  plannedCost: number;
  cumulative: number;
}
export function plannedCostSchedule(
  data: FinanceData,
  periods: readonly string[] | { from: string; to: string },
  opts: { projectId: string },
): PlannedCostPeriod[];
```
- `FinanceData` (`src/app/services/finance.util.ts:6-53`) gains two new optional fields:
```ts
  assignmentDays?: AssignmentDay[];
  assignmentMonths?: AssignmentMonth[];
```

- [ ] **Step 1: Write the failing tests**

In `src/app/services/finance.util.spec.ts`, add `AssignmentDay, AssignmentMonth` to the existing `import { ... } from './api.service';` line (line 45), and add `plannedCostSchedule, PlannedCostPeriod` to the `import { ... } from './finance.util';` block. Add two fixture helpers near the other local builders (after `function assign(...)`, ~line 55):

```ts
function day(id: string, assignmentId: string, date: string, hours: number): AssignmentDay {
  return { id, assignmentId, date, hours };
}
function month(assignmentId: string, month: string, status: AssignmentMonth['status']): AssignmentMonth {
  return { id: `${assignmentId}:${month}`, assignmentId, month, status };
}
```

Add a new `describe` block after `describe('finance.util recognitionSchedule', ...)` (ends ~line 797):

```ts
describe('finance.util plannedCostSchedule', () => {
  const base: FinanceData = {
    resources: [res('1', 100, 200)],
    requests: [req('r1', 'P')],
    assignments: [assign('a1', 'r1', '1', 0)],
    orders: [], orderLines: [], financials: [],
  };

  it('prices an Allocated day at hours x the resource\'s costRate, bucketed by month', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8), day('ad2', 'a1', '2026-02-05', 4)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated'), month('a1', '2026-02', 'Allocated')],
    };
    const rows = plannedCostSchedule(d, ['2026-01', '2026-02'], { projectId: 'P' });
    expect(rows).toEqual([
      { period: '2026-01', plannedCost: 800, cumulative: 800 },
      { period: '2026-02', plannedCost: 400, cumulative: 1200 },
    ]);
  });

  it('counts a Requested month exactly like an Allocated one', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Requested')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(800);
  });

  it('zeroes a day whose month is Draft', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Draft')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('zeroes a day whose month is Rejected', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Rejected')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('zeroes a day with NO month row at all', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('treats a day whose assignment references a missing resource as costRate 0', () => {
    const d: FinanceData = {
      ...base,
      assignments: [assign('a1', 'r1', 'ghost-resource', 0)],
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated')],
    };
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(0);
  });

  it('ignores a day whose assignment belongs to another project\'s request', () => {
    const d: FinanceData = {
      ...base,
      requests: [req('r1', 'P'), req('r2', 'OTHER')],
      assignments: [assign('a1', 'r1', '1', 0), assign('a2', 'r2', '1', 0)],
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8), day('ad2', 'a2', '2026-01-11', 100)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated'), month('a2', '2026-01', 'Allocated')],
    };
    // Only a1's 8h counts toward project 'P'; a2's 100h (project 'OTHER') must not leak in.
    expect(plannedCostSchedule(d, ['2026-01'], { projectId: 'P' })[0].plannedCost).toBe(800);
  });

  it('clamps a day dated before the requested window into the first period', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2025-11-20', 8)],
      assignmentMonths: [month('a1', '2025-11', 'Allocated')],
    };
    expect(plannedCostSchedule(d, ['2026-01', '2026-02'], { projectId: 'P' })[0].plannedCost).toBe(800);
  });

  it('expands a {from,to} range the same way an explicit period array would', () => {
    const d: FinanceData = {
      ...base,
      assignmentDays: [day('ad1', 'a1', '2026-01-10', 8), day('ad2', 'a1', '2026-02-05', 4)],
      assignmentMonths: [month('a1', '2026-01', 'Allocated'), month('a1', '2026-02', 'Allocated')],
    };
    expect(plannedCostSchedule(d, { from: '2026-01', to: '2026-02' }, { projectId: 'P' }))
      .toEqual(plannedCostSchedule(d, ['2026-01', '2026-02'], { projectId: 'P' }));
  });

  it('returns an empty array for an empty period list', () => {
    expect(plannedCostSchedule(base, [], { projectId: 'P' })).toEqual([]);
  });

  // UNIT-PINNING TEST (spec §9) — the exact defect class this project already
  // shipped once (~8x revenue via sell-rate.util.ts). costRate 720 mirrors the
  // RAW resources.cost_rate column (EUR/DAY) that loadFinanceData() carries;
  // costRate 90 mirrors the RESOLVED value resolveResourceRates()/GET
  // /api/resources produce (EUR/HOUR = 720 / hoursPerDay 8). Feeding the raw
  // figure MUST NOT be how either the freeze handler or the client comparison
  // computes cost. If a future change swaps resolved for raw resources on
  // either path, this ratio silently becomes hoursPerDay (8), not 1, and this
  // test fails.
  it('is fed resolved (EUR/HOUR) rates, never raw (EUR/DAY) ones — the ratio must be exactly hoursPerDay (8), never 1', () => {
    const days = [day('ad1', 'a1', '2026-10-05', 8)];
    const months = [month('a1', '2026-10', 'Allocated')];
    const resolved: FinanceData = { ...base, resources: [res('1', 90, 180)], assignmentDays: days, assignmentMonths: months };
    const raw: FinanceData = { ...base, resources: [res('1', 720, 1440)], assignmentDays: days, assignmentMonths: months };
    const resolvedCost = plannedCostSchedule(resolved, ['2026-10'], { projectId: 'P' })[0].plannedCost;
    const rawCost = plannedCostSchedule(raw, ['2026-10'], { projectId: 'P' })[0].plannedCost;
    expect(resolvedCost).toBe(720); // 8h x 90 EUR/h — the seeded John Miller figure (Task 1)
    expect(rawCost / resolvedCost).toBe(8); // hoursPerDay — proves the trap, does not silently pass at ratio 1
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `./node_modules/.bin/ng test --include='**/finance.util.spec.ts'`
Expected: FAIL — `plannedCostSchedule` is not exported.

- [ ] **Step 3: Extend `FinanceData` and implement**

In `src/app/services/finance.util.ts`, add `AssignmentDay, AssignmentMonth` to the existing import from `./api.service` (line 1), and add to the `FinanceData` interface (after `projects?: Project[];`, line 21):

```ts
  /**
   * Optional per-day booked hours and per-month lifecycle state (design spec,
   * block E, §2). Consumed ONLY by `plannedCostSchedule`, which buckets a day's
   * hours by month and gates it on its OWNING month's status — 'Allocated' or
   * 'Requested' count (the same `planned` bucket `monthlyAggregateHours`
   * already uses in `allocation-month.util.ts`), 'Draft'/'Rejected'/absent do
   * not. Absent or empty behaves exactly like a project with no plan yet.
   */
  assignmentDays?: AssignmentDay[];
  assignmentMonths?: AssignmentMonth[];
```

Add the import and function after `plannedLaborCostForProject` (ends line 131), before `actualLaborCostForProject`:

```ts
import { monthRowId } from './allocation-month.util';
import { monthOf } from './calendar.util';
```

(add these two lines to the top import block, alongside the existing imports)

```ts
export interface PlannedCostPeriod {
  period: string;      // YYYY-MM
  plannedCost: number;  // EUR — this month's planned cost
  cumulative: number;   // EUR — Σ plannedCost from the start of the requested periods
}

/**
 * The monthly cost side of the plan (design spec §2) — the sibling
 * `recognitionSchedule` never had, because cost has no monthly bucketing
 * today. For every AssignmentDay belonging to the project (same request-set
 * join as `plannedLaborCostForProject`), looks up its OWNING AssignmentMonth
 * (`monthRowId(assignmentId, monthOf(date))`, reusing the B3 helper
 * verbatim): a day whose month is 'Allocated' or 'Requested' counts (the
 * `planned` bucket `monthlyAggregateHours` already uses elsewhere), a day
 * whose month is 'Draft'/'Rejected'/absent counts 0. A counted day is priced
 * at its resource's `costRate` — see the CRITICAL unit note below — and
 * bucketed by `periodOf(date)`, clamped exactly like `recognitionSchedule`.
 *
 * UNITS — READ BEFORE CALLING: `data.resources[].costRate` must be the
 * RESOLVED EUR/HOUR value (override ?? rate card, already divided by
 * hoursPerDay), never the raw EUR/DAY column. This function is unit-agnostic
 * by design (it only multiplies hours x whatever costRate it is given) —
 * the CALLER is responsible for resolution. See `finance.util.spec.ts`'s
 * "is fed resolved... rates" test for the exact failure mode of getting this
 * wrong.
 */
export function plannedCostSchedule(
  data: FinanceData,
  periods: readonly string[] | { from: string; to: string },
  opts: { projectId: string },
): PlannedCostPeriod[] {
  const periodList = Array.isArray(periods)
    ? [...periods]
    : periodRange((periods as { from: string; to: string }).from, (periods as { from: string; to: string }).to);
  if (periodList.length === 0) return [];

  const reqIds = new Set(data.requests.filter(r => r.projectId === opts.projectId).map(r => r.id));
  const assignmentIds = new Set(data.assignments.filter(a => reqIds.has(a.requestId)).map(a => a.id));
  const resourceByAssignment = new Map(data.assignments.map(a => [a.id, a.resourceId]));
  const costRateByResource = new Map(data.resources.map(r => [r.id, r.costRate ?? 0]));
  const monthStatus = new Map((data.assignmentMonths ?? []).map(m => [m.id, m.status]));

  const index = new Map(periodList.map((p, i) => [p, i]));
  const costByPeriod = new Array<number>(periodList.length).fill(0);

  for (const d of (data.assignmentDays ?? [])) {
    if (!assignmentIds.has(d.assignmentId)) continue;
    const status = monthStatus.get(monthRowId(d.assignmentId, monthOf(d.date)));
    if (status !== 'Allocated' && status !== 'Requested') continue;
    const resourceId = resourceByAssignment.get(d.assignmentId);
    const costRate = resourceId !== undefined ? (costRateByResource.get(resourceId) ?? 0) : 0;
    const i = index.get(clampPeriod(periodOf(d.date), periodList));
    if (i !== undefined) costByPeriod[i] += finite(d.hours) * costRate;
  }

  let cumulative = 0;
  return periodList.map((period, i) => {
    cumulative += finite(costByPeriod[i]);
    return { period, plannedCost: finite(costByPeriod[i]), cumulative };
  });
}
```

- [ ] **Step 4: Run green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/finance.util.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Mutate and confirm red**

Temporarily change the month-status guard from `status !== 'Allocated' && status !== 'Requested'` to `status !== 'Allocated'` (dropping the `'Requested'` bucket). Run the `finance.util.spec.ts` suite: expect the "counts a Requested month exactly like an Allocated one" test to fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/finance.util.ts src/app/services/finance.util.spec.ts
git commit -m "feat: plannedCostSchedule — the monthly cost side of the plan"
```

---

### Task 3: Read-only `GET /assignment-days` and `GET /assignment-months`

**Spec:** §2, §5, §7 (the two new read endpoints).

**Files:**
- Modify: `src/server.ts` (two new one-line routes after `apiRouter.get('/assignments', ...)` at line 2202; one `READ_RULES` edit at line 718)
- Modify: `src/app/services/api.service.ts` (two new client methods, after `getAssignments`, ~line 993)
- Modify: `scripts/smoke-api.mjs` (new check block + driver call)

**Interfaces:**
- Consumes: `repos.assignmentDays`/`repos.assignmentMonths` — **both already exist** (`src/db/repositories.ts:353,355`, backing the existing per-month/day mutation endpoints); this task adds no schema, repo, or seed work, only two new GET routes.
- Produces: `GET /assignment-days` -> `AssignmentDay[]`, `GET /assignment-months` -> `AssignmentMonth[]`; `ApiService.getAssignmentDays()`, `ApiService.getAssignmentMonths()`.

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-api.mjs`, add a new function after `checkNegotiatedRates` (ends line 3780), following its `EMPLOYEE_HEADERS` idiom:

```js
/**
 * Design spec, block E, §2/§5/§7 — the two read-only endpoints the monthly
 * cost derivation needs. Both repositories already exist (they back the
 * existing per-day/per-month mutation endpoints); only the GET route and the
 * READ_RULES prefix are new.
 */
async function checkAssignmentDaysAndMonths() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '9', 'X-User-Role': 'employee' };

  // 1) GET /assignment-days as admin -> 200, includes assignment '7''s day
  //    (src/db/seed.ts, Task 1 of this plan).
  const days = await req('GET', '/assignment-days');
  check('GET /api/assignment-days -> 200', days.status === 200, `status=${days.status}`);
  check(
    'GET /api/assignment-days includes assignment \'7\'\'s 2026-10-05 day (8h)',
    Array.isArray(days.body) && days.body.some(d => d.assignmentId === '7' && d.date === '2026-10-05' && d.hours === 8),
  );

  // 2) GET /assignment-days as employee -> 403 (mirrors /assignments+/requests).
  const forbiddenDays = await req('GET', '/assignment-days', { headers: EMPLOYEE_HEADERS });
  check("GET /api/assignment-days as an 'employee' -> 403", forbiddenDays.status === 403, `status=${forbiddenDays.status}`);

  // 3) GET /assignment-months as admin -> 200, includes assignment '7''s
  //    derived Allocated 2026-10 row.
  const months = await req('GET', '/assignment-months');
  check('GET /api/assignment-months -> 200', months.status === 200, `status=${months.status}`);
  check(
    'GET /api/assignment-months includes \'7:2026-10\' with status Allocated',
    Array.isArray(months.body) && months.body.some(m => m.id === '7:2026-10' && m.status === 'Allocated'),
  );

  // 4) GET /assignment-months as employee -> 403.
  const forbiddenMonths = await req('GET', '/assignment-months', { headers: EMPLOYEE_HEADERS });
  check("GET /api/assignment-months as an 'employee' -> 403", forbiddenMonths.status === 403, `status=${forbiddenMonths.status}`);
}
```

Wire the call in `main()`, after the `checkNegotiatedRates()` try/catch block (line 5824):

```js
  // Own try/catch: guarded so an unexpected error in the new assignment-days/
  // assignment-months reads never masks or blocks any of the prior section results.
  try {
    await checkAssignmentDaysAndMonths();
  } catch (err) {
    console.log(`FAIL  assignment-days/assignment-months reads — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }
```

- [ ] **Step 2: Run the smoke suite to see checks 1-4 fail**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```

Expected: the new checks FAIL with 404 (no route registered yet).

- [ ] **Step 3: Implement the routes and the RBAC edit**

In `src/server.ts`, immediately after `apiRouter.get('/assignments', async (_req, res) => { res.json(await repos.assignments.list()); });` (line 2202):

```ts
// Read-only (design spec, block E, §2/§7): assignment-days/assignment-months
// have no REST collection of their own today — they are mutated only through
// /assignments and /allocation-approvals — but the monthly cost derivation
// (plannedCostSchedule) needs the client to be able to fetch them in bulk.
apiRouter.get('/assignment-days', async (_req, res) => { res.json(await repos.assignmentDays.list()); });
apiRouter.get('/assignment-months', async (_req, res) => { res.json(await repos.assignmentMonths.list()); });
```

In the `READ_RULES` array, change line 718 from:

```ts
  { test: p => ['/assignments', '/requests'].some(prefix => p === prefix || p.startsWith(prefix + '/')), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
```

to:

```ts
  { test: p => ['/assignments', '/requests', '/assignment-days', '/assignment-months'].some(prefix => p === prefix || p.startsWith(prefix + '/')), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
```

In `src/app/services/api.service.ts`, add after `getAssignments()` (ends line 993):

```ts
getAssignmentDays(): Observable<AssignmentDay[]> {
  return this.http.get<AssignmentDay[]>(`${this.baseUrl}/assignment-days`);
}

getAssignmentMonths(): Observable<AssignmentMonth[]> {
  return this.http.get<AssignmentMonth[]>(`${this.baseUrl}/assignment-months`);
}
```

- [ ] **Step 4: Run the smoke suite green, then the gates**

Re-run the Step 2 sequence; confirm checks 1-4 pass and nothing pre-existing regressed. Then `ng test` and `ng lint`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/app/services/api.service.ts scripts/smoke-api.mjs
git commit -m "feat: read-only GET /assignment-days and GET /assignment-months"
```

---

### Task 4: `costBaselineComparison` — planned vs. frozen, with re-freeze and horizon rules

**Spec:** §3.4 (re-freeze), §4 (the comparison), §10 (unit tests) in full.

**Files:**
- Modify: `src/app/services/finance.util.ts` (new `CostBaselineComparisonRow` interface + `costBaselineComparison` function, after `plannedCostSchedule`; extend `FinanceData` with `costBaselines?`)
- Modify: `src/app/services/finance.util.spec.ts`

**Interfaces:**
- Consumes: `plannedCostSchedule` (Task 2), `CostBaseline` (Task 1, imported into `finance.util.ts` from `./api.service`), the module-private `periodRange` (`finance.util.ts:562-582`, already in scope — same file).
- Produces — Tasks 6-8 depend on this exact shape:

```ts
export interface CostBaselineComparisonRow {
  period: string;
  baseline: number;             // EUR — the CURRENT frozen amount for this period, 0 if never frozen
  planned: number;              // EUR — live plannedCostSchedule for this period
  delta: number;                // EUR — planned - baseline
  deltaPct: number | null;      // % — null when baseline = 0 (never frozen OR frozen explicitly at 0)
  outOfBaselineHorizon: boolean; // true iff NO current baseline row exists for this period
}
export function costBaselineComparison(data: FinanceData, projectId: string): CostBaselineComparisonRow[];
```
- `FinanceData` gains: `costBaselines?: CostBaseline[];`

- [ ] **Step 1: Write the failing tests**

In `src/app/services/finance.util.spec.ts`, add `CostBaseline` to the `import { ... } from './api.service';` line and `costBaselineComparison, CostBaselineComparisonRow` to the `finance.util` import block. Add a local fixture helper near `day`/`month` (Task 2):

```ts
function baseline(id: string, projectId: string, period: string, amount: number, frozenAt: string): CostBaseline {
  return { id, projectId, period, amount, frozenAt, frozenBy: 'u1' };
}
```

Add a new `describe` block after the `plannedCostSchedule` one:

```ts
describe('finance.util costBaselineComparison', () => {
  // Mirrors the seeded fixture exactly (Task 1): resource '1' at 90 EUR/HOUR
  // (resolved), one Allocated day of 8h in project 'P' period '2026-10'
  // (720 EUR planned). A frozen baseline of 600 gives a hand-verifiable
  // +120 EUR / +20.00% delta.
  const withOctoberPlan: FinanceData = {
    resources: [res('1', 90, 180)],
    requests: [req('r1', 'P')],
    assignments: [assign('a1', 'r1', '1', 0)],
    orders: [], orderLines: [], financials: [],
    assignmentDays: [day('ad1', 'a1', '2026-10-05', 8)],
    assignmentMonths: [month('a1', '2026-10', 'Allocated')],
  };

  it('reports +120 EUR / +20.00% when the live plan (720) exceeds a 600 baseline', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [baseline('CB1', 'P', '2026-10', 600, '2026-09-15T09:00:00.000Z')] };
    const rows = costBaselineComparison(d, 'P');
    const oct = rows.find(r => r.period === '2026-10');
    expect(oct).toBeDefined();
    expect(oct?.baseline).toBe(600);
    expect(oct?.planned).toBe(720);
    expect(oct?.delta).toBe(120);
    expect(oct?.deltaPct).toBeCloseTo(20, 5);
    expect(oct?.outOfBaselineHorizon).toBe(false);
  });

  it('reports -500 EUR / null when a frozen month has no booked hours at all (descoped)', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [baseline('CB2', 'P', '2026-11', 500, '2026-09-15T09:00:00.000Z')] };
    const rows = costBaselineComparison(d, 'P');
    const nov = rows.find(r => r.period === '2026-11');
    expect(nov).toBeDefined();
    expect(nov?.baseline).toBe(500);
    expect(nov?.planned).toBe(0);
    expect(nov?.delta).toBe(-500);
    expect(nov?.deltaPct).toBeNull();
    expect(nov?.outOfBaselineHorizon).toBe(false); // frozen explicitly at 500 — NOT the same as never-frozen
  });

  it('flags a booked month with NO baseline row as outOfBaselineHorizon, with baseline 0 and deltaPct null', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [] };
    const rows = costBaselineComparison(d, 'P');
    const oct = rows.find(r => r.period === '2026-10');
    expect(oct?.baseline).toBe(0);
    expect(oct?.deltaPct).toBeNull();
    expect(oct?.outOfBaselineHorizon).toBe(true); // the pair of the two tests above: absence, not zero
  });

  it('uses the row with the LATEST frozenAt for a re-frozen period, never the first one written', () => {
    const d: FinanceData = {
      ...withOctoberPlan,
      costBaselines: [
        baseline('CB_OLD', 'P', '2026-10', 600, '2026-09-01T00:00:00.000Z'),
        baseline('CB_NEW', 'P', '2026-10', 750, '2026-09-20T00:00:00.000Z'),
      ],
    };
    const oct = costBaselineComparison(d, 'P').find(r => r.period === '2026-10');
    expect(oct?.baseline).toBe(750); // NOT 600 — the later re-freeze wins
    expect(oct?.delta).toBe(720 - 750);
  });

  it('never mixes another project\'s baseline rows into this project\'s comparison', () => {
    const d: FinanceData = { ...withOctoberPlan, costBaselines: [baseline('CB_OTHER', 'OTHER_PROJECT', '2026-10', 999, '2026-09-01T00:00:00.000Z')] };
    const oct = costBaselineComparison(d, 'P').find(r => r.period === '2026-10');
    expect(oct?.baseline).toBe(0);
    expect(oct?.outOfBaselineHorizon).toBe(true);
  });

  it('returns an empty array when the project has neither a baseline nor any booked hours', () => {
    const d: FinanceData = { resources: [], requests: [], assignments: [], orders: [], orderLines: [], financials: [], costBaselines: [] };
    expect(costBaselineComparison(d, 'GHOST')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `./node_modules/.bin/ng test --include='**/finance.util.spec.ts'`
Expected: FAIL — `costBaselineComparison` is not exported.

- [ ] **Step 3: Extend `FinanceData` and implement**

Add `CostBaseline` to the `finance.util.ts` import from `./api.service` (line 1). Add to `FinanceData` (after the `assignmentMonths?` field added in Task 2):

```ts
  /** Optional frozen monthly cost baselines (design spec, block E, §3).
   *  Consumed ONLY by `costBaselineComparison`. */
  costBaselines?: CostBaseline[];
```

Add after `plannedCostSchedule`:

```ts
/**
 * The CURRENT baseline row per period for a project: the row with the
 * latest `frozenAt` among all rows sharing that (projectId, period) —
 * NEVER the first one found (design spec §3.4: a re-freeze is a new row,
 * never an update, so more than one row can share a period).
 */
function currentCostBaselinesByPeriod(rows: readonly CostBaseline[], projectId: string): Map<string, CostBaseline> {
  const out = new Map<string, CostBaseline>();
  for (const row of rows) {
    if (row.projectId !== projectId) continue;
    const existing = out.get(row.period);
    if (existing === undefined || row.frozenAt > existing.frozenAt) out.set(row.period, row);
  }
  return out;
}

export interface CostBaselineComparisonRow {
  period: string;
  baseline: number;
  planned: number;
  delta: number;
  deltaPct: number | null;
  outOfBaselineHorizon: boolean;
}

/**
 * Baseline vs. live plan, month by month (design spec §4). "Planned" is
 * always the LIVE value of `plannedCostSchedule` on today's plan, never a
 * second snapshot. The period universe is the union of every period with a
 * CURRENT baseline row and every period with at least one booked
 * AssignmentDay for the project — never the intersection, so a descoped or
 * never-frozen month is visible rather than silently dropped — expanded
 * contiguously from the earliest to the latest such period.
 */
export function costBaselineComparison(data: FinanceData, projectId: string): CostBaselineComparisonRow[] {
  const current = currentCostBaselinesByPeriod(data.costBaselines ?? [], projectId);
  const reqIds = new Set(data.requests.filter(r => r.projectId === projectId).map(r => r.id));
  const assignmentIds = new Set(data.assignments.filter(a => reqIds.has(a.requestId)).map(a => a.id));
  const bookedMonths = (data.assignmentDays ?? [])
    .filter(d => assignmentIds.has(d.assignmentId))
    .map(d => periodOf(d.date));
  const allMonths = [...new Set([...current.keys(), ...bookedMonths])].sort();
  if (allMonths.length === 0) return [];

  const periodsList = periodRange(allMonths[0], allMonths[allMonths.length - 1]);
  const planned = plannedCostSchedule(data, { from: periodsList[0], to: periodsList[periodsList.length - 1] }, { projectId });
  const plannedByPeriod = new Map(planned.map(p => [p.period, p.plannedCost]));

  return periodsList.map(period => {
    const baselineRow = current.get(period);
    const baselineAmount = baselineRow?.amount ?? 0;
    const plannedAmount = plannedByPeriod.get(period) ?? 0;
    const delta = plannedAmount - baselineAmount;
    return {
      period,
      baseline: baselineAmount,
      planned: plannedAmount,
      delta,
      deltaPct: baselineAmount !== 0 ? (delta / baselineAmount) * 100 : null,
      outOfBaselineHorizon: baselineRow === undefined,
    };
  });
}
```

- [ ] **Step 4: Run green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/finance.util.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Mutate and confirm red**

Temporarily change `existing === undefined || row.frozenAt > existing.frozenAt` to `existing === undefined` in `currentCostBaselinesByPeriod` (making it keep the FIRST row instead of the latest). Run the suite: expect the "uses the row with the LATEST frozenAt" test to fail (asserts `750`, would now see `600`). Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/finance.util.ts src/app/services/finance.util.spec.ts
git commit -m "feat: costBaselineComparison — planned vs. frozen with re-freeze semantics"
```

---

### Task 5: `POST /cost-baselines` freeze handler and `GET /cost-baselines`

**Spec:** §3.4, §3.5, §5, §6 in full.

**Files:**
- Modify: `src/server.ts` (new routes after the `/negotiated-rates` DELETE handler, line 5550; the `rules` array at line 649; the `READ_RULES` array at line 721; the `finance.util` import at line 18)
- Modify: `src/app/services/api.service.ts` (already has the client methods from Task 1 — this task only needs the server side)
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `plannedCostSchedule` (Task 2), `resolveResourceRates` (`src/server.ts:1646-1650`), `withLock` (`src/server.ts:217-226`), `existsRepo` (`src/server.ts:880-881`), `pick` (`src/server.ts:108`), `actorId` (`src/server.ts:481`), `repos.costBaselines` (Task 1), `repos.requests`/`repos.assignments`/`repos.assignmentDays`/`repos.resources`.
- Produces: `GET /cost-baselines` -> `CostBaseline[]`; `POST /cost-baselines { projectId }` -> `CostBaseline[]` (the newly-written batch, one row per period in the freeze horizon).

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-api.mjs`, add a new function after `checkAssignmentDaysAndMonths` (Task 3), following the `/negotiated-rates` block's idiom:

```js
/**
 * Design spec, block E, §5/§6 — the freeze handler's integrity rules and RBAC.
 * Seed fixtures relied on (src/db/seed.ts, Task 1): project '1' has booked
 * hours (assignments '1'/'2'/'7'); project 'CT1'-only or an unstaffed project
 * would 400 on an empty horizon, but project '1' is staffed, so a normal
 * freeze against it must succeed.
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
  );
  check(
    'every frozen row carries a server-set frozenBy/frozenAt, and projectId \'1\'',
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

  // 8) RBAC — read restricted to pm/resource-manager/finance/delivery-executive/admin.
  const employeeForbidden = await req('GET', '/cost-baselines', { headers: EMPLOYEE_HEADERS });
  check("GET /api/cost-baselines as an 'employee' -> 403", employeeForbidden.status === 403, `status=${employeeForbidden.status}`);
  const pmAllowed = await req('GET', '/cost-baselines', { headers: PM_HEADERS });
  check("GET /api/cost-baselines as a 'pm' -> 200 (read is disjoint from freeze — spec §5)", pmAllowed.status === 200, `status=${pmAllowed.status}`);

  // 9) Audit: the global append-only middleware records the freeze POST
  //    (no separate wiring — src/server.ts:820-859 fires on every successful
  //    POST/PUT/DELETE). Confirmed via the audit-logs read (admin only).
  const auditLogs = await req('GET', '/audit-logs');
  check(
    'the freeze POST left an entry in the append-only audit trail',
    auditLogs.status === 200 && Array.isArray(auditLogs.body?.entries ?? auditLogs.body)
      && (auditLogs.body?.entries ?? auditLogs.body).some(e => e.method === 'POST' && e.path.includes('/cost-baselines')),
  );
}
```

**Note on check 9:** read `/audit-logs`'s actual response shape (paged, per the CLAUDE.md description "bounded/newest-first") before wiring this assertion — adjust the `.entries` access to whatever the real envelope is; do not guess blindly.

Wire the call in `main()` after `checkCostBaselines`'s Task-3 sibling:

```js
  try {
    await checkCostBaselines();
  } catch (err) {
    console.log(`FAIL  cost-baselines integrity flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }
```

- [ ] **Step 2: Run the smoke suite to see the new checks fail**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```

Expected: FAIL with 404 (no route yet).

- [ ] **Step 3: Implement the freeze handler**

Add `plannedCostSchedule` to the `finance.util` import in `src/server.ts` (line 18):

```ts
import { convertToBase, computeProjectFinancials, recognitionJournal, plannedCostSchedule, type FinanceData } from './app/services/finance.util';
```

Add the RBAC entries. In the `rules` array (mutation), immediately after the `/project-financials` rule (line 649):

```ts
    { test: p => p.startsWith('/cost-baselines'), roles: ['finance', 'delivery-executive', 'admin'] },
```

In `READ_RULES`, immediately after the `/capacity` rule (line 721):

```ts
  // Cost baselines (design spec, block E, §5): read is DISJOINT from freeze —
  // pm/resource-manager can read the variance to act on it early, but cannot
  // freeze or re-freeze (§3.4: whoever is measured on the variance must not be
  // able to rewrite the metric). Mirrors the /capacity read set exactly.
  { test: p => p.startsWith('/cost-baselines'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
```

Add the routes after the `/negotiated-rates` DELETE handler (line 5550), before the "Multi-currency foundation" comment:

```ts
/**
 * Freeze (or re-freeze) a project's monthly cost baseline (design spec, block
 * E, §3.4/§3.5). The freeze horizon is the union of every month the project
 * has at least one AssignmentDay in, expanded contiguously. Writes ONE ROW
 * PER PERIOD, atomically, under a per-project lock — a re-freeze APPENDS a
 * new batch, never updates or deletes an existing row (there is no unique
 * constraint on (project_id, period) by design). No PUT/DELETE is exposed.
 *
 * UNITS (spec §9): this handler MUST assemble its own resolved-rate
 * FinanceData via `resolveResourceRates(await repos.resources.list())` —
 * never `loadFinanceData()`, whose `resources` field is a documented,
 * deliberately-unfixed EUR/day (not EUR/hour) hazard (see the comment on
 * `loadFinanceData`, src/server.ts:6517-6527). Reusing it here would
 * overstate every baseline by a factor of hoursPerDay, the same defect shape
 * `sell-rate.util.ts` once shipped.
 */
apiRouter.get('/cost-baselines', async (_req, res) => { res.json(await repos.costBaselines.list()); });
apiRouter.post('/cost-baselines', async (req, res) => {
  const body = pick<{ projectId: string }>(req.body, ['projectId']);
  if (typeof body.projectId !== 'string' || body.projectId.length === 0) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const projectId = body.projectId;
  if (!(await existsRepo(repos.projects, projectId))) {
    res.status(400).json({ error: 'projectId must reference an existing project' });
    return;
  }
  const result = await withLock(`cost-baseline:${projectId}`, async (): Promise<{ status?: number; error?: string; created?: CostBaseline[] }> => {
    const [requests, assignments, assignmentDays, assignmentMonths, rawResources] = await Promise.all([
      repos.requests.list(),
      repos.assignments.list(),
      repos.assignmentDays.list(),
      repos.assignmentMonths.list(),
      repos.resources.list(),
    ]);
    const resources = await resolveResourceRates(rawResources); // resolved EUR/HOUR — never loadFinanceData()
    const reqIds = new Set(requests.filter(r => r.projectId === projectId).map(r => r.id));
    const assignmentIds = new Set(assignments.filter(a => reqIds.has(a.requestId)).map(a => a.id));
    const bookedMonths = assignmentDays
      .filter(d => assignmentIds.has(d.assignmentId))
      .map(d => d.date.slice(0, 7));
    if (bookedMonths.length === 0) {
      return { status: 400, error: 'project has no booked hours to freeze' };
    }
    const from = bookedMonths.reduce((a, b) => (b < a ? b : a));
    const to = bookedMonths.reduce((a, b) => (b > a ? b : a));
    const data: FinanceData = {
      requests, assignments, resources, orders: [], orderLines: [], financials: [],
      assignmentDays, assignmentMonths,
    };
    const schedule = plannedCostSchedule(data, { from, to }, { projectId });
    const at = new Date().toISOString();
    const frozenBy = actorId(req);
    const rows: CostBaseline[] = [];
    for (const p of schedule) {
      const row = await repos.costBaselines.create({
        id: newId(), projectId, period: p.period, amount: p.plannedCost, frozenAt: at, frozenBy,
      } as CostBaseline);
      rows.push(row as CostBaseline);
    }
    return { created: rows };
  });
  if (result.error !== undefined) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json(result.created);
});
```

Add `CostBaseline` to the type-only import from `./app/services/api.service` near the top of `src/server.ts` (alongside the other entity types already imported there).

- [ ] **Step 4: Run the smoke suite green, then the gates**

Re-run the Step 2 sequence; confirm all `checkCostBaselines` checks pass and nothing pre-existing regressed. Then `ng test` and `ng lint`.

- [ ] **Step 5: Mutate and confirm red**

Temporarily change `const resources = await resolveResourceRates(rawResources);` to `const resources = rawResources;` (feeding raw, unresolved rates). Re-run the smoke suite: expect the "frozen batch includes a 2026-10 row priced at exactly 720 EUR" check to fail (it will instead see `5760` = `8 x 720`, the 8x-style inflation this exact plan's unit-pinning test (Task 2) was written to catch). Revert.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat: POST/GET /cost-baselines — the freeze handler and its integrity rules"
```

---

### Task 6: Project 360 "Baseline vs Planned" card

**Spec:** §5 (RBAC), §7 (surface decision), §8 (loading states), §9 (formatting) in full.

**Files:**
- Modify: `src/app/projects/project-details/project-details.ts`
- Create: `src/app/projects/project-details/project-details.spec.ts` (no spec file exists today for this component)

**Interfaces:**
- Consumes: `ApiService.getAssignmentDays()/getAssignmentMonths()/getCostBaselines()/freezeCostBaseline()` (Tasks 1/3/5), `costBaselineComparison`, `CostBaselineComparisonRow` (Task 4), `AuthService.canReadStaffing`/`canApproveFinancials` (`src/app/services/auth.service.ts:124,134` — already exist, no new capability needed: `canReadStaffing` is true for exactly `pm`/`resource-manager`/`delivery-executive`/`finance`/`admin`, matching the read RBAC set 1:1), `NotificationService` (`src/app/services/notification.service.ts`).
- Produces: nothing later tasks depend on.

**Design decision, stated explicitly for the reviewer:** the existing Overview tab's revenue/margin/EAC/ETC/VAC KPIs load on `authReady()` alone (no capability gate) — a pre-existing, looser pattern this task does not touch or fix. The new Baseline card is stricter by design, per spec §8: its own three rxResources are gated on `auth.authReady() && auth.canReadStaffing()`, so `employee`/`sales` never fire the fetch and never see the section mounted at all.

- [ ] **Step 1: Write the failing component tests**

Create `src/app/projects/project-details/project-details.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { ProjectDetailsComponent } from './project-details';
import { ApiService, AssignmentDay, AssignmentMonth, CostBaseline, Project, Resource, ResourceRequest, Assignment } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

async function tick(fixture: ComponentFixture<unknown>, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

const PROJECT: Project = { id: 'P1', name: 'Project One', location: 'Berlin', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' };
const RESOURCE: Resource = { id: 'R1', name: 'Res One', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 90, billRate: 180 };
const REQUEST: ResourceRequest = { id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled', skills: [], projectId: 'P1' };
const ASSIGNMENT: Assignment = { id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' };
const DAYS: AssignmentDay[] = [{ id: 'A1:2026-10-05', assignmentId: 'A1', date: '2026-10-05', hours: 8 }];
const MONTHS: AssignmentMonth[] = [{ id: 'A1:2026-10', assignmentId: 'A1', month: '2026-10', status: 'Allocated' }];
const BASELINE: CostBaseline[] = [{ id: 'CB1', projectId: 'P1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T00:00:00.000Z', frozenBy: 'u4' }];

function makeApiStub(overrides: Partial<Record<string, unknown>> = {}) {
  const empty = () => of([]);
  return {
    getProjects: () => of([PROJECT]),
    getOrders: empty, getOrderLines: empty, getProjectFinancials: empty, getTimeEntries: empty,
    getProjectIssues: empty, getChangeRequests: empty,
    getRequests: () => of([REQUEST]),
    getAssignments: () => of([ASSIGNMENT]),
    getResources: () => of([RESOURCE]),
    getAssignmentDays: () => of(DAYS),
    getAssignmentMonths: () => of(MONTHS),
    getCostBaselines: () => of(BASELINE),
    freezeCostBaseline: () => of(BASELINE),
    ...overrides,
  } as unknown as ApiService;
}

function makeAuthStub(role: 'employee' | 'sales' | 'pm' | 'finance') {
  const canReadStaffing = ['pm', 'finance'].includes(role);
  const canApproveFinancials = role === 'finance';
  return {
    authReady: () => true,
    canReadStaffing: () => canReadStaffing,
    canApproveFinancials: () => canApproveFinancials,
    canManageCommercial: () => false,
  } as unknown as AuthService;
}

async function render(role: 'employee' | 'sales' | 'pm' | 'finance', apiOverrides: Partial<Record<string, unknown>> = {}) {
  const api = makeApiStub(apiOverrides);
  TestBed.configureTestingModule({
    imports: [ProjectDetailsComponent],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: makeAuthStub(role) },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(ProjectDetailsComponent);
  fixture.componentRef.setInput('id', 'P1');
  await tick(fixture);
  return { fixture, api };
}

describe('ProjectDetailsComponent — Baseline vs Planned card (design spec, block E)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is ABSENT for employee — no fetch fires, no "Baseline vs Planned" text renders', async () => {
    const { fixture, api } = await render('employee');
    expect(host(fixture).textContent).not.toContain('Baseline vs Planned');
    expect(api.getAssignmentDays).not.toHaveBeenCalled();
    expect(api.getAssignmentMonths).not.toHaveBeenCalled();
    expect(api.getCostBaselines).not.toHaveBeenCalled();
  });

  it('is ABSENT for sales — the pair of the presence assertion below', async () => {
    const { fixture } = await render('sales');
    expect(host(fixture).textContent).not.toContain('Baseline vs Planned');
  });

  it('is PRESENT for pm and renders the hand-verified +120 EUR / +20.00% October row', async () => {
    const { fixture } = await render('pm');
    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Baseline vs Planned');
    expect(text).toContain('2026-10');
    expect(text).toMatch(/\+?20\.00%/);
  });

  it('renders "—" for a period whose baseline is 0 (never frozen), not a fabricated percentage', async () => {
    const { fixture } = await render('pm', { getCostBaselines: () => of([]) });
    expect(host(fixture).textContent).toContain('—');
  });

  it('shows "No baseline frozen for this project yet." when costBaselines resolves empty for this project', async () => {
    const { fixture } = await render('pm', { getCostBaselines: () => of([]) });
    expect(host(fixture).textContent).toContain('No baseline frozen for this project yet.');
  });

  it('does NOT show the empty-state message once a baseline exists — the pair of the test above', async () => {
    const { fixture } = await render('pm');
    expect(host(fixture).textContent).not.toContain('No baseline frozen for this project yet.');
  });

  it('shows a Couldn\'t-load / Retry panel when a dependency errors, never a number', async () => {
    const { fixture } = await render('pm', { getCostBaselines: () => throwError(() => new Error('boom')) });
    const text = host(fixture).textContent ?? '';
    expect(text).toContain("Couldn't load cost baseline");
    expect(text).not.toContain('20.00%');
  });

  it('shows a loading skeleton while a dependency is still pending', async () => {
    const pending = new Subject<CostBaseline[]>();
    const { fixture } = await render('pm', { getCostBaselines: () => pending.asObservable() });
    expect(fixture.nativeElement.querySelectorAll('.command-skeleton').length).toBeGreaterThan(0);
    pending.next(BASELINE);
    pending.complete();
    await tick(fixture);
  });

  it('shows the Freeze baseline button only for finance, never for pm', async () => {
    const { fixture: financeFixture } = await render('finance');
    expect(host(financeFixture).textContent).toContain('Freeze baseline');
    const { fixture: pmFixture } = await render('pm');
    expect(host(pmFixture).textContent).not.toContain('Freeze baseline');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `./node_modules/.bin/ng test --include='**/project-details/**'`
Expected: FAIL — no such text/behavior exists yet.

- [ ] **Step 3: Implement**

In `src/app/projects/project-details/project-details.ts`:

Change `private auth = inject(AuthService);` (line 255) to `protected auth = inject(AuthService);` (the template needs direct access, matching how `tabs` already calls `this.auth.canApproveFinancials()` from class code — this is the one field visibility change that lets the new markup call `auth.*()` too).

Add `NotificationService` to the imports (alongside the existing service imports) and inject it: `private notificationService = inject(NotificationService);`.

Add `CostBaseline, AssignmentDay, AssignmentMonth` to the `ApiService` type import (line 7), and `costBaselineComparison, CostBaselineComparisonRow` to the `finance.util` import (line 9). Import `ListStateComponent` from `'../../shared/list-state.component'` and add it to the component's `imports` array.

After `private timeEntriesRes = ...` (ends line 300), add:

```ts
  // Baseline vs Planned (design spec, block E, §8). Gated on BOTH authReady
  // AND canReadStaffing — unlike the pre-existing KPIs above (authReady only)
  // — so employee/sales never even issue these three fetches.
  private assignmentDaysRes = rxResource<AssignmentDay[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadStaffing(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getAssignmentDays() : of<AssignmentDay[]>([])),
    defaultValue: [] as AssignmentDay[],
  });
  private assignmentMonthsRes = rxResource<AssignmentMonth[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadStaffing(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getAssignmentMonths() : of<AssignmentMonth[]>([])),
    defaultValue: [] as AssignmentMonth[],
  });
  private costBaselinesRes = rxResource<CostBaseline[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadStaffing(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getCostBaselines() : of<CostBaseline[]>([])),
    defaultValue: [] as CostBaseline[],
  });
```

After `financials = computed(...)` (ends line 313), add:

```ts
  protected baselineLoading = computed(() => !this.auth.authReady()
    || this.requestsRes.isLoading() || this.assignmentsRes.isLoading() || this.resourcesRes.isLoading()
    || this.assignmentDaysRes.isLoading() || this.assignmentMonthsRes.isLoading() || this.costBaselinesRes.isLoading());
  protected baselineErrored = computed(() => this.requestsRes.status() === 'error' || this.assignmentsRes.status() === 'error'
    || this.resourcesRes.status() === 'error' || this.assignmentDaysRes.status() === 'error'
    || this.assignmentMonthsRes.status() === 'error' || this.costBaselinesRes.status() === 'error');
  protected hasAnyBaseline = computed(() => this.costBaselinesRes.value().some(c => c.projectId === this.id()));
  private baselineData = computed<FinanceData>(() => ({
    requests: this.requestsRes.value(),
    assignments: this.assignmentsRes.value(),
    resources: this.resourcesRes.value(),
    orders: [], orderLines: [], financials: [],
    assignmentDays: this.assignmentDaysRes.value(),
    assignmentMonths: this.assignmentMonthsRes.value(),
    costBaselines: this.costBaselinesRes.value(),
  }));
  protected baselineRows = computed<CostBaselineComparisonRow[]>(() => costBaselineComparison(this.baselineData(), this.id()));
  protected baselineTotals = computed(() => {
    const rows = this.baselineRows();
    const baseline = rows.reduce((s, r) => s + r.baseline, 0);
    const planned = rows.reduce((s, r) => s + r.planned, 0);
    const delta = planned - baseline;
    return { baseline, planned, delta, deltaPct: baseline !== 0 ? (delta / baseline) * 100 : null };
  });

  protected freezingBaseline = signal(false);
  freezeBaseline(): void {
    const id = this.project()?.id;
    if (!id || this.freezingBaseline()) return;
    this.freezingBaseline.set(true);
    this.api.freezeCostBaseline(id).subscribe({
      next: () => {
        this.freezingBaseline.set(false);
        this.costBaselinesRes.reload();
        this.notificationService.show('Baseline frozen', 'success');
      },
      error: (err: { error?: { error?: string } }) => {
        this.freezingBaseline.set(false);
        this.notificationService.show(err.error?.error ?? 'Could not freeze baseline', 'error');
      },
    });
  }
  reloadBaseline(): void {
    this.assignmentDaysRes.reload();
    this.assignmentMonthsRes.reload();
    this.costBaselinesRes.reload();
  }
```

In the template, insert a new sibling card immediately after the "Revenue breakdown" card (ends line 206), still inside the `@if (activeTab() === 'overview')` block's `<div class="space-y-6">`:

```html
            @if (auth.canReadStaffing()) {
              <div class="command-card p-6 sm:p-8">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
                  <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] tracking-tight">Baseline vs Planned</h3>
                  @if (auth.canApproveFinancials()) {
                    <button type="button" (click)="freezeBaseline()" [disabled]="freezingBaseline()"
                            class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">ac_unit</mat-icon>
                      {{ freezingBaseline() ? 'Freezing…' : 'Freeze baseline' }}
                    </button>
                  }
                </div>
                <app-list-state [loading]="baselineLoading()" [error]="baselineErrored()" skeleton="table-rows" [rows]="3" label="cost baseline" (retry)="reloadBaseline()">
                  <ng-template>
                    @if (!hasAnyBaseline()) {
                      <p class="text-sm text-[var(--cc-muted)]">No baseline frozen for this project yet.</p>
                    } @else {
                      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                        <div class="command-kpi">
                          <p class="command-kpi-label">Baseline</p>
                          <p class="command-kpi-value font-mono tabular-nums">{{ baselineTotals().baseline | currency:'EUR':'symbol':'1.0-0' }}</p>
                        </div>
                        <div class="command-kpi">
                          <p class="command-kpi-label">Planned</p>
                          <p class="command-kpi-value font-mono tabular-nums">{{ baselineTotals().planned | currency:'EUR':'symbol':'1.0-0' }}</p>
                        </div>
                        <div class="command-kpi" [class.danger]="baselineTotals().delta > 0">
                          <p class="command-kpi-label">Delta</p>
                          <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="baselineTotals().delta <= 0" [class.text-critical-text]="baselineTotals().delta > 0">{{ baselineTotals().delta | currency:'EUR':'symbol':'1.0-0' }}</p>
                          <p class="command-kpi-note">{{ baselineTotals().deltaPct !== null ? ((baselineTotals().deltaPct! > 0 ? '+' : '') + (baselineTotals().deltaPct! | number:'1.0-2') + '%') : '—' }}</p>
                        </div>
                      </div>
                      <div class="overflow-x-auto">
                        <table class="command-data-table">
                          <thead class="bg-surface-muted border-b border-line text-ink-muted">
                            <tr>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-left">Period</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Baseline</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Planned</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Delta</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Delta %</th>
                            </tr>
                          </thead>
                          <tbody class="divide-y divide-line">
                            @for (row of baselineRows(); track row.period) {
                              <tr>
                                <td class="px-4 py-3 font-medium text-ink">
                                  {{ row.period }}
                                  @if (row.outOfBaselineHorizon) {
                                    <span class="command-status amber ml-2 text-[10px]">not frozen</span>
                                  }
                                </td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums">{{ row.baseline | currency:'EUR':'symbol':'1.0-0' }}</td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums">{{ row.planned | currency:'EUR':'symbol':'1.0-0' }}</td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums" [class.text-positive-text]="row.delta <= 0" [class.text-critical-text]="row.delta > 0">{{ row.delta | currency:'EUR':'symbol':'1.0-0' }}</td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums">{{ row.deltaPct !== null ? ((row.deltaPct > 0 ? '+' : '') + (row.deltaPct | number:'1.0-2') + '%') : '—' }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                    }
                  </ng-template>
                </app-list-state>
              </div>
            }
```

- [ ] **Step 4: Run green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/project-details/**'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

- [ ] **Step 5: Mutate and confirm red**

Temporarily change `params: () => this.auth.authReady() && this.auth.canReadStaffing(),` on `costBaselinesRes` to `params: () => this.auth.authReady(),` (dropping the capability gate). Re-run the spec: expect the "is ABSENT for employee" test to fail (the fetch now fires). Revert.

- [ ] **Step 6: Browser pass**

On port **4173** (never touch a coordinator's dev server on 4200): open a project as `pm`, confirm the card renders with numbers and no Freeze button; as `finance`, confirm the Freeze button appears and clicking it updates the table; as `employee`, confirm the whole section is absent from the DOM (not blank, not zeroed).

- [ ] **Step 7: Commit**

```bash
git add src/app/projects/project-details
git commit -m "feat: Baseline vs Planned card on the Project 360 review"
```

---

### Task 7: Dashboard portfolio "Baseline vs Planned" tile

**Spec:** §7 (surface decision — portfolio total only, no per-project column).

**Files:**
- Modify: `src/app/dashboard/dashboard.component.ts`
- Modify: `src/app/dashboard/dashboard.component.spec.ts`

**Interfaces:**
- Consumes: `costBaselineComparison` (Task 4), `ApiService.getAssignmentDays()/getAssignmentMonths()/getCostBaselines()` (Tasks 1/3/5).
- Produces: nothing later tasks depend on.

**Design decision:** this whole panel is already gated behind `canViewPortfolioDashboard()` (`finance`/`delivery-executive`/`admin` only — a strict subset of the read RBAC set) at the template level (`dashboard.component.ts:124,158,164`), with its own loading/error branches already covering every KPI in it. Adding the three new fields to the SAME `dataRes` forkJoin and one new tile inherits that gate, loading skeleton, and error panel automatically — no new three-state machine is needed on this surface.

- [ ] **Step 1: Write the failing test**

In `src/app/dashboard/dashboard.component.spec.ts`, add `'getAssignmentDays', 'getAssignmentMonths', 'getCostBaselines'` to the `DASHBOARD_METHODS` array. Add a new test after the existing three:

```ts
describe('Dashboard — Baseline vs Planned portfolio tile (design spec, block E)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('renders the portfolio Baseline vs Planned delta for a finance reader', async () => {
    const api = makeApiStub();
    api.getProjects = vi.fn(() => of([
      { id: 'P1', name: 'Project One', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' },
    ]));
    api.getRequests = vi.fn(() => of([{ id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled', skills: [], projectId: 'P1' }]));
    api.getAssignments = vi.fn(() => of([{ id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' }]));
    api.getResources = vi.fn(() => of([{ id: 'R1', name: 'Res', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 90, billRate: 180 }]));
    api.getAssignmentDays = vi.fn(() => of([{ id: 'A1:2026-10-05', assignmentId: 'A1', date: '2026-10-05', hours: 8 }]));
    api.getAssignmentMonths = vi.fn(() => of([{ id: 'A1:2026-10', assignmentId: 'A1', month: '2026-10', status: 'Allocated' }]));
    api.getCostBaselines = vi.fn(() => of([{ id: 'CB1', projectId: 'P1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T00:00:00.000Z', frozenBy: 'u4' }]));

    TestBed.configureTestingModule({
      imports: [DashboardComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: makeAuthStub('finance') },
      ],
    });
    const fixture = TestBed.createComponent(DashboardComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // Planned (720) - baseline (600) = +120 EUR portfolio-wide, the same
    // hand-verified figure as the seed fixture (Task 1) and the Project 360
    // card (Task 6).
    expect(fixture.nativeElement.textContent).toContain('Baseline vs Planned');
    expect(fixture.nativeElement.textContent).toContain('€120');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `./node_modules/.bin/ng test --include='**/dashboard.component.spec.ts'`
Expected: FAIL — no such tile/text exists yet.

- [ ] **Step 3: Implement**

Add `AssignmentDay, AssignmentMonth, CostBaseline` to the `ApiService` type import, and `costBaselineComparison` to the `finance.util` import.

Extend the `DashboardData` interface (near line 47) with:

```ts
  assignmentDays: AssignmentDay[];
  assignmentMonths: AssignmentMonth[];
  costBaselines: CostBaseline[];
```

Extend `DashboardComponent.EMPTY_DATA` (the static default object, alongside the other empty arrays) with `assignmentDays: [], assignmentMonths: [], costBaselines: []`.

In the `dataRes` forkJoin (line 603-630), add:

```ts
            assignmentDays: this.api.getAssignmentDays(),
            assignmentMonths: this.api.getAssignmentMonths(),
            costBaselines: this.api.getCostBaselines(),
```

In `financeData` (line 640-664), add to the returned object:

```ts
      assignmentDays: d.assignmentDays,
      assignmentMonths: d.assignmentMonths,
      costBaselines: d.costBaselines,
```

After `totalVac`/`totalEac` computeds (near line 843), add:

```ts
  /** Portfolio Baseline vs Planned total (design spec, block E, §7) — a
   *  portfolio total only, no per-project column (a dense table already). */
  protected readonly totalBaselineDelta = computed(() =>
    this.data().projects.reduce((sum, p) => sum + costBaselineComparison(this.financeData(), p.id).reduce((s, r) => s + r.delta, 0), 0),
  );
  protected readonly totalBaselineAmount = computed(() =>
    this.data().projects.reduce((sum, p) => sum + costBaselineComparison(this.financeData(), p.id).reduce((s, r) => s + r.baseline, 0), 0),
  );
  protected readonly totalBaselineDeltaPct = computed(() => {
    const baseline = this.totalBaselineAmount();
    return baseline !== 0 ? (this.totalBaselineDelta() / baseline) * 100 : null;
  });
```

In the template, change the first KPI grid's class from `sm:grid-cols-2 xl:grid-cols-6` (line 194) to `sm:grid-cols-2 xl:grid-cols-7`, and insert a new tile immediately after the "Portfolio EAC" tile (ends line 249):

```html
        <div class="command-kpi" [class.danger]="totalBaselineDelta() > 0" [class.info]="totalBaselineDelta() <= 0">
          <div class="command-kpi-label">Baseline vs Planned</div>
          <div class="command-kpi-value">{{ totalBaselineDelta() | currency:'EUR':'symbol':'1.0-0' }}</div>
          <div class="command-kpi-note">{{ totalBaselineDeltaPct() !== null ? ((totalBaselineDeltaPct()! > 0 ? '+' : '') + (totalBaselineDeltaPct() | number:'1.0-2') + '% vs frozen PCP') : 'No baseline frozen yet' }}</div>
        </div>
```

- [ ] **Step 4: Run green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/dashboard.component.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

- [ ] **Step 5: Mutate and confirm red**

Temporarily change `s + r.delta` to `s - r.delta` in `totalBaselineDelta`. Re-run the new test: expect it to fail (sees `-120`, textContent no longer contains `€120`). Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard
git commit -m "feat: portfolio Baseline vs Planned tile on the dashboard"
```

---

### Task 8: Reporting Margin & Variance baseline columns and CSV export

**Spec:** §7 (surface decision), §9 (CSV/formatting).

**Files:**
- Modify: `src/app/reporting/reporting.ts`
- Modify: `src/app/reporting/reporting.spec.ts`

**Interfaces:**
- Consumes: `costBaselineComparison` (Task 4), `ApiService.getAssignmentDays()/getAssignmentMonths()/getCostBaselines()`.
- Produces: nothing later tasks depend on.

**Design decision, stated for the reviewer:** `reporting.ts`'s single `dataRes` forkJoin already fails fast (and shows the page-wide `accessNotice` + error panel) for any role lacking `canReadCommercial`/`canReadFinancials` — in practice today only `finance`/`delivery-executive`/`admin` can load this page's data at all (`pm`/`resource-manager` lack `canReadCommercial`, `sales`/`employee` lack `canReadFinancials`, both trip the same forkJoin). The new baseline columns are added to that SAME forkJoin/table and rendered unconditionally within it — this is not a new gap this block introduces; it inherits the page's existing all-or-nothing access pattern rather than adding a second, redundant capability check.

- [ ] **Step 1: Write the failing test**

In `src/app/reporting/reporting.spec.ts`, add `'getAssignmentDays', 'getAssignmentMonths', 'getCostBaselines'` to the `setup()` function's `apiStub` object (each defaulting to `empty`). Add a new `describe` block after the negotiated-rates one:

```ts
describe('Reporting — Baseline vs Planned columns (design spec, block E)', () => {
  it('renders the hand-verified +120 EUR / +20.00% baseline delta for a project with a frozen October baseline', async () => {
    const project = { id: 'P1', name: 'Project One', location: 'EU', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution' as const };
    const resource = { id: 'R1', name: 'Res', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRate: 90, billRate: 180 };
    const request = { id: 'REQ1', name: 'Req', requiredRole: 'Consultant', requiredEffort: 8, status: 'Fulfilled' as const, skills: [], projectId: 'P1' };
    const assignment = { id: 'A1', requestId: 'REQ1', resourceId: 'R1', assignedHours: 8, status: 'Allocated' as const };
    // Revenue is required for marginRows() to include the project at all
    // (it filters to projects carrying revenue or cost) — an order line gives
    // it non-zero cost-driver revenue independent of the baseline figures.
    const order = { id: 'O1', contractId: 'CT1', type: 'Customer' as const, amount: 1000, currency: 'EUR', status: 'Invoiced' as const, orderDate: '2026-01-01' };
    const line = { id: 'L1', orderId: 'O1', projectId: 'P1', description: 'x', amount: 1000 };

    const { fixture } = await setup([resource], {
      getProjects: () => of([project]),
      getRequests: () => of([request]),
      getAssignments: () => of([assignment]),
      getOrders: () => of([order]),
      getOrderLines: () => of([line]),
      getAssignmentDays: () => of([{ id: 'A1:2026-10-05', assignmentId: 'A1', date: '2026-10-05', hours: 8 }]),
      getAssignmentMonths: () => of([{ id: 'A1:2026-10', assignmentId: 'A1', month: '2026-10', status: 'Allocated' as const }]),
      getCostBaselines: () => of([{ id: 'CB1', projectId: 'P1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T00:00:00.000Z', frozenBy: 'u4' }]),
    });
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Project One');
    expect(text).toContain('20.00%');
  });
});
```

**Note:** confirm `setup()`'s exact signature (`setup(resources, overrides)`) by reading `reporting.spec.ts` before writing this — adapt the call if the real signature differs.

- [ ] **Step 2: Run it to see it fail**

Run: `./node_modules/.bin/ng test --include='**/reporting.spec.ts'`
Expected: FAIL — no `20.00%` text exists in the Margin & Variance table yet.

- [ ] **Step 3: Implement**

Add `AssignmentDay, AssignmentMonth, CostBaseline` to the `ApiService` type import, and `costBaselineComparison` to the `finance.util` import.

Extend the local `ReportingData` interface (line 30-53) with:

```ts
  assignmentDays: AssignmentDay[];
  assignmentMonths: AssignmentMonth[];
  costBaselines: CostBaseline[];
```

In the `dataRes` forkJoin (line 883-916), add to BOTH the `forkJoin({...})` call and the two `{...}` object literals (the `of<ReportingData>({...})` fallback and the `defaultValue:`):

```ts
            assignmentDays: this.api.getAssignmentDays(),
            assignmentMonths: this.api.getAssignmentMonths(),
            costBaselines: this.api.getCostBaselines(),
```

(and `assignmentDays: [], assignmentMonths: [], costBaselines: []` in the two empty-object literals)

In `financeData` (line 973-...), add to the returned object: `assignmentDays: d.assignmentDays, assignmentMonths: d.assignmentMonths, costBaselines: d.costBaselines,`.

In `marginRows` (lines 1019-1046), extend the mapped object:

```ts
  marginRows = computed(() => {
    const d = this.financeData();
    return this.dataRes.value().projects
      .map(p => {
        const md = marginDrivers(p.id, d);
        const f = computeProjectFinancials(p.id, d);
        const totalCost = md.laborCost + md.externalCost + md.expenseCost;
        const baselineRows = costBaselineComparison(d, p.id);
        const pcpBaseline = baselineRows.reduce((s, r) => s + r.baseline, 0);
        const pcpPlanned = baselineRows.reduce((s, r) => s + r.planned, 0);
        const pcpDelta = pcpPlanned - pcpBaseline;
        return {
          id: p.id,
          name: p.name,
          revenue: md.revenue,
          laborCost: md.laborCost,
          externalCost: md.externalCost,
          expenseCost: md.expenseCost,
          margin: md.margin,
          marginPct: md.marginPct,
          eac: f.eac,
          vac: f.varianceAtCompletion,
          burnPct: f.burnPct,
          pcpBaseline,
          pcpPlanned,
          pcpDelta,
          pcpDeltaPct: pcpBaseline !== 0 ? (pcpDelta / pcpBaseline) * 100 : null,
          laborW: totalCost > 0 ? (md.laborCost / totalCost) * 100 : 0,
          externalW: totalCost > 0 ? (md.externalCost / totalCost) * 100 : 0,
          expenseW: totalCost > 0 ? (md.expenseCost / totalCost) * 100 : 0,
        };
      })
      .filter(r => r.revenue > 0 || r.laborCost > 0 || r.externalCost > 0 || r.expenseCost > 0)
      .sort((a, b) => b.revenue - a.revenue);
  });
```

In `marginTotals` (lines 1049-1060), add:

```ts
      pcpBaseline: rows.reduce((s, r) => s + r.pcpBaseline, 0),
      pcpPlanned: rows.reduce((s, r) => s + r.pcpPlanned, 0),
      pcpDelta: rows.reduce((s, r) => s + r.pcpDelta, 0),
```

In the template's Margin & Variance `<thead>` (lines 404-416), add two columns after "Burn %":

```html
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Baseline</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Delta</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Delta %</th>
```

In the `<tbody>` row (after the burn% `<td>`, line 440), add:

```html
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.pcpBaseline | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-positive-text]="r.pcpDelta <= 0" [class.text-critical-text]="r.pcpDelta > 0">{{ r.pcpDelta | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums">{{ r.pcpDeltaPct !== null ? ((r.pcpDeltaPct > 0 ? '+' : '') + (r.pcpDeltaPct | number:'1.0-2') + '%') : '—' }}</td>
```

Update the `@empty` block's `colspan="10"` to `colspan="13"` (line 444), and the `<tfoot>` row (lines 450-461) to add:

```html
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().pcpBaseline | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-positive-text]="marginTotals().pcpDelta <= 0" [class.text-critical-text]="marginTotals().pcpDelta > 0">{{ marginTotals().pcpDelta | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4"></td>
```

(no portfolio `pcpDeltaPct` in the footer, matching how the existing footer already leaves `marginPct`/`burnPct` blank rather than averaging percentages)

Update `<app-list-state ... [columns]="10" ...>` (line 386) to `[columns]="13"`.

Extend `exportMarginVarianceCsv()` (lines 1423-1440) with three new columns after `burnPct`:

```ts
      { key: 'pcpBaseline', header: `PCP Baseline (${cur} base)`, map: r => r.pcpBaseline.toFixed(2) },
      { key: 'pcpDelta', header: `PCP Delta (${cur} base)`, map: r => r.pcpDelta.toFixed(2) },
      { key: 'pcpDeltaPct', header: 'PCP Delta %', map: r => r.pcpDeltaPct !== null ? r.pcpDeltaPct.toFixed(2) : '—' },
```

- [ ] **Step 4: Run green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/reporting.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

- [ ] **Step 5: Mutate and confirm red**

Temporarily change `pcpDeltaPct: pcpBaseline !== 0 ? (pcpDelta / pcpBaseline) * 100 : null` to always `null`. Re-run the reporting test: expect the `20.00%` assertion to fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/reporting
git commit -m "feat: Baseline vs Planned columns on the Margin & Variance report"
```

---

### Task 9: Impact script, docs, sweep, and full verification

**Spec:** §9 (units, the mandatory sweep), §10 (smoke/impact) in full.

**Files:**
- Create: `scripts/cost-baseline-impact.mjs`
- Modify: `docs/architecture/03-backend-and-data.md` (new table entry, mirroring the `negotiatedRates` entry at line 712 and the ER-diagram block at lines 459-460/495)
- Modify: `docs/roles-and-permissions.md` (new rows mirroring `/capacity`/`/project-financials` at lines 138,164; a new mutation-rule row)
- Modify: `docs/functional/project-delivery.md` (a short new paragraph in the "Project 360 review" section, ~line 114)
- Modify: whatever the sweep in Step 2 turns up

- [ ] **Step 1: Write the impact script**

Create `scripts/cost-baseline-impact.mjs`, dependency-free, modelled on `scripts/negotiated-rate-impact.mjs`'s plain-`fetch` idiom (same `BASE`/`API`/`RBAC_HEADERS`/`req()` shape):

```js
#!/usr/bin/env node
// @ts-check
/*
 * cost-baseline-impact.mjs — the merge gate for block E (frozen monthly PCP
 * baseline). DEPENDENCY-FREE, modelled on scripts/negotiated-rate-impact.mjs's
 * plain-fetch idiom. Node 20+ global fetch only.
 *
 * WHAT IT DOES: freezes project '1''s baseline via POST, re-reads it via GET
 * to confirm no drift, recomputes the comparison client-side against the
 * design spec's hand-verified fixture (Task 1: CB1=600 vs a 720 October plan,
 * CB2=500 vs a 0 November plan), and verifies an RBAC 403 for a 'pm' POST.
 *
 * A COMPARISON PRODUCING ZERO ROWS PROVES NOTHING BY ITSELF (the lesson this
 * project has paid for seven times): the real gate is the non-null case below,
 * whose figures are hand-verifiable against the seed.
 *
 * Usage:
 *   AUTH_TRUST_HEADERS=true npm run serve:ssr:app
 *   node scripts/cost-baseline-impact.mjs
 *   IMPACT_BASE=http://localhost:4173 node scripts/cost-baseline-impact.mjs
 */

const BASE = (process.env.IMPACT_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const API = `${BASE}/api`;
const RBAC_HEADERS = { 'X-User-Id': '4', 'X-User-Role': 'finance' };
const PM_HEADERS = { 'X-User-Id': '3', 'X-User-Role': 'pm' };

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function req(method, path, { headers, body } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { ...RBAC_HEADERS, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    console.log(`FAIL  ${method} ${API}${path} — ${err && err.message ? err.message : err}`);
    console.log(`HINT  is the server running at ${BASE}?`);
    process.exit(1);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, body: json };
}

async function main() {
  const frozen = await req('POST', '/cost-baselines', { body: { projectId: '1' } });
  check('POST /api/cost-baselines {projectId:\'1\'} -> 200', frozen.status === 200, `status=${frozen.status}`);

  const rows = Array.isArray(frozen.body) ? frozen.body : [];
  const oct = rows.find(r => r.period === '2026-10');
  check('the frozen batch includes a 2026-10 row', oct !== undefined);
  if (oct) {
    check('2026-10 planned cost = 720 EUR exactly (John Miller, 8h x 90 EUR/h)', oct.amount === 720, `amount=${oct.amount}`);
  }

  const reread = await req('GET', '/cost-baselines');
  check('a second GET returns exactly the rows just written, no drift', reread.status === 200 && Array.isArray(reread.body));

  // The seeded CB1 (600, period 2026-10) is a SEPARATE, earlier-frozen row
  // from the one this script just wrote (see Task 1) — compute the delta
  // against the hand-verified seed baseline, not the fresh one this script
  // itself created, to pin the design spec's own worked example.
  const cb1 = (reread.body ?? []).find(r => r.id === 'CB1');
  check('the seeded CB1 (600 EUR, 2026-10) is present', cb1 !== undefined);
  if (cb1 && oct) {
    const delta = oct.amount - cb1.amount;
    const deltaPct = (delta / cb1.amount) * 100;
    check('delta vs the seeded CB1 = +120 EUR', delta === 120, `delta=${delta}`);
    check('deltaPct vs the seeded CB1 = +20.00%', Math.abs(deltaPct - 20) < 0.01, `deltaPct=${deltaPct}`);
  }
  const cb2 = (reread.body ?? []).find(r => r.id === 'CB2');
  const novRow = rows.find(r => r.period === '2026-11');
  check('the seeded CB2 (500 EUR, 2026-11) is present, and the fresh freeze wrote NO 2026-11 row (no booked hours that month)', cb2 !== undefined && novRow === undefined);

  const pmForbidden = await req('POST', '/cost-baselines', { body: { projectId: '1' }, headers: PM_HEADERS });
  check("POST /api/cost-baselines as a 'pm' -> 403", pmForbidden.status === 403, `status=${pmForbidden.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
```

- [ ] **Step 2: Sweep every other reader of a project's cost**

`grep -rn 'plannedLaborCostForProject\|costRate' src` and, for each hit outside this block's own new code, record: what it reads, whether the frozen baseline should affect it, and your decision — **including the ones that need nothing, with the reason.** Two you must judge explicitly:
- `computeProjectFinancials`'s `plannedLaborCost`/`etc`/`eac` (`finance.util.ts:199-229`) — these stay on the existing whole-project `plannedLaborCostForProject`, UNCHANGED by this block (design spec §11: "Baseline and Budget remain two distinct numbers on screen, never a synonym of one another"). Confirm this still holds after your changes.
- `resourceBillability` (the company-wide billability figure, `finance.util.ts:232-...`) — confirm it is untouched (it was already deliberately isolated from the negotiated-rates work; this block does not touch it either).

Where a consumer needs a product call rather than a guess, report it instead of changing it.

- [ ] **Step 3: Docs**

`docs/architecture/03-backend-and-data.md`: add `cost_baselines` to the entity table (mirroring the `negotiatedRates` row at line 712) and a short paragraph (mirroring lines 509-540) explaining the write-once semantics and that "current" means latest `frozenAt`. `docs/roles-and-permissions.md`: add `/cost-baselines` to both the mutation-rule table (a new row, `finance`/`delivery-executive`/`admin`) and the read-rule table (mirroring the `/capacity` row at line 142, `pm`/`resource-manager`/`delivery-executive`/`finance`/`admin`); add `/assignment-days`, `/assignment-months` to the existing `/assignments`, `/requests` read row (line 141). `docs/functional/project-delivery.md`: in the "Project 360 review" section (~line 114), add a short paragraph describing the Baseline vs Planned card, who can freeze it, and that it is pinned (does not move with an approved Change Request) — cross-reference `reporting-analytics.md`.

- [ ] **Step 4: Full gate set**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
node scripts/cost-baseline-impact.mjs
kill %1
```

Then confirm `scripts/smoke-noauth.mjs` stays green with `AUTH_TRUST_HEADERS` **unset** against the same build.

- [ ] **Step 5: Fresh-Postgres run — mandatory**

There is a migration with a FK to `projects` and a new seed step. Create a genuinely fresh database, boot the built server against it with `DATABASE_URL` set, confirm every migration applied (report the count) and `CB1`/`CB2` and assignment `'7'` round-trip, run the full smoke suite plus `cost-baseline-impact.mjs` against it, then drop the database. If Docker is unavailable, say so prominently rather than skipping silently.

- [ ] **Step 6: Commit**

```bash
git add -A scripts docs
git commit -m "docs: block E in the entity catalogue, RBAC, and the Project 360 SOP; impact script"
```

---

## Verification Checklist (before merge)

- [ ] `plannedCostSchedule` counts a day whose owning month is `Allocated` or `Requested`, and zeroes `Draft`/`Rejected`/absent.
- [ ] The unit-pinning test proves a raw (EUR/day) resource feed produces exactly `hoursPerDay` (8) times the resolved (EUR/hour) figure — never silently 1.
- [ ] The freeze handler builds its own `FinanceData` via `resolveResourceRates(await repos.resources.list())`, never `loadFinanceData()`.
- [ ] `POST /cost-baselines` writes one row per booked month, ignores a client-forged `amount`/`period`/`frozenAt`/`frozenBy`, 400s on a missing/unknown `projectId` and on an empty freeze horizon, and never rejects a re-freeze.
- [ ] A re-freeze appends a NEW batch; the comparison always resolves to the row with the latest `frozenAt` for a period.
- [ ] The hand-verified fixture holds exactly: `2026-10` = +120 EUR / +20.00%; `2026-11` = −500 EUR / `—`; the four pre-existing project-`'1'` months (May-Aug 2026) show `outOfBaselineHorizon: true`.
- [ ] `GET /cost-baselines`, `GET /assignment-days`, `GET /assignment-months` are readable by `pm`/`resource-manager`/`finance`/`delivery-executive`/`admin` and 403 for `employee`/`sales`.
- [ ] `POST /cost-baselines` 403s for `pm` (read access does not imply write access) and succeeds for `finance`/`delivery-executive`/`admin`.
- [ ] The freeze `POST` produces an append-only audit-log entry with no extra wiring.
- [ ] The Baseline card is ABSENT (not empty, not zeroed) for `employee`/`sales` on the Project 360; shows a skeleton while loading; shows "Couldn't load cost baseline" + Retry on a dependency error; shows "No baseline frozen for this project yet." only when `costBaselines` is genuinely empty for that project.
- [ ] "Freeze baseline" is visible only for `finance`/`delivery-executive`/`admin`.
- [ ] Every EUR figure renders with ≤ 2 decimals; every `deltaPct` renders `—` (em dash) when `null`, never a fabricated percentage.
- [ ] Unit, lint, build, live smoke (with and without `AUTH_TRUST_HEADERS`), the impact script, and the fresh-Postgres run are all green.

---

## Self-Review

**Spec coverage** (walked section by section against the design doc):
- §1 (the gap) — Task 2/4 close it (no task needed; it is the motivation).
- §2 (the join, the two new endpoints, the `FinanceData` extension) — Tasks 2, 3.
- §3.1-3.3 (what's frozen, granularity, the table/migration) — Task 1.
- §3.4 (re-freeze semantics) — Task 4 (comparison picks latest `frozenAt`) and Task 5 (handler always appends).
- §3.5 (the write action, the lock, the allow-list) — Task 5.
- §4 (the comparison, period universe, edge cases, `deltaPct` null/em-dash) — Task 4.
- §5 (RBAC — freeze vs. read, the five-role read set, the People Manager reading) — Tasks 3, 5, 6 (`auth.canReadStaffing()` maps exactly).
- §6 (integrity table) — Task 5's smoke checks, one row each.
- §7 (the three surfaces + the two "No" surfaces) — Tasks 6, 7, 8 cover the three "Yes" rows; `contract-details.ts` and `financial-plans.ts` are untouched by design, confirmed by omission from every task's file list.
- §8 (the three-state loading model, the four-state-by-role table) — Task 6 in full (own three rxResources, own loading/errored computeds); Task 7 inherits the page's existing all-or-nothing gate; Task 8 inherits the page's existing forkJoin gate (both decisions stated explicitly in their tasks for a reviewer to challenge).
- §9 (units, the mandatory unit test, display precision) — Task 2 (unit-pinning test), Task 5 (handler uses `resolveResourceRates`), Tasks 6-8 (`1.0-0`/`1.0-2` pipes, no default `DecimalPipe`).
- §10 (verification: unit tests, seed fixture, smoke, fresh-Postgres) — Task 1 (seed), Task 2/4 (unit tests), Task 9 (impact script + fresh-Postgres).
- §11 (what this block does NOT do) — respected by omission: no currency conversion, no CR auto-re-baselining, no PM self-service freeze, no per-project dashboard column, no `contract-details.ts`/`financial-plans.ts` changes, no `PUT`/`DELETE` routes, no automatic alert — none of these appear in any task.

**Placeholder scan:** no "TBD"/"similar to Task N"/unshown code found on review; every step carries literal code, a literal command, or a literal expected value.

**Type/name consistency:** `CostBaseline`, `PlannedCostPeriod`, `plannedCostSchedule`, `CostBaselineComparisonRow`, `costBaselineComparison` are defined once each (Tasks 1, 2, 4) and referenced by the identical name/shape in every later task (5, 6, 7, 8) — checked field-by-field (`baseline`/`planned`/`delta`/`deltaPct`/`outOfBaselineHorizon` used consistently, never renamed en route to the UI tasks).

**One gap found and closed during review:** the initial draft used `baselineRows().length === 0` as the "never frozen" condition in Task 6 — wrong, because `costBaselineComparison` still returns rows (all `outOfBaselineHorizon: true`) for a project with booked hours but zero baseline rows. Replaced with the explicit `hasAnyBaseline` computed, checked against `costBaselinesRes.value()` filtered by `projectId`, matching spec §8's "the third state ... resolves successfully, with an empty list for that project" precisely.
