# B3 — Monthly (per-month) Allocation Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the allocation approval unit from *assignment* to *assignment × month*, so a People Manager approves month by month across projects (RPT «Approva Mese» / «Approva e Prosegui»), and editing one month no longer invalidates the months already approved.

**Architecture:** A new `assignmentMonths` table holds the per-month lifecycle state (`Draft|Requested|Allocated|Rejected`), the planner note and the approver note; `assignments.status` becomes a derived rollup of it. The existing gap-A approval engine is reused unchanged in shape: one `ApprovalRequest` (`kind='Allocation'`) per month row, with `refId` = the month-row id. A new batch decision endpoint decides N month rows in one call, and a dedicated People Manager page renders the resource table plus a multi-project approval modal.

**Tech Stack:** Angular 21 (standalone, signal-first, OnPush), Express 5, Drizzle ORM + PostgreSQL, Vitest via `@angular/build:unit-test`, dependency-free smoke script (`scripts/smoke-api.mjs`).

**Spec:** `docs/superpowers/specs/2026-08-02-b3-monthly-approval-design.md`
**Branch:** `feature/b3-monthly-approval` (already created; the spec commit is `a178417`).

## Global Constraints

- **Tooling:** use `./node_modules/.bin/ng` (NOT `npx ng`). Tests: `./node_modules/.bin/ng test`. Lint: `./node_modules/.bin/ng lint`. Build: `./node_modules/.bin/ng build`.
- **Smoke tests (live server):** port 3000 is occupied on this machine. Build, then run
  `env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs` and
  `SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs` (host `localhost`, NOT `127.0.0.1` — the server binds `::1`).
- **`src/db/seed.ts` is the single source of truth** for seed data (consumed by both the in-memory adapter and the Postgres seeder). Never hand-maintain a parallel copy.
- **Composite ids** (`<assignmentId>:<month>`) are built by the util, never by `newId()`. `assignmentMonths` must NOT be added to `seedSequences()`.
- **`nullsToUndefined()`** runs on every repository *return* path; never apply it to values passed to `.set()`.
- **Pure utils are SSR-safe:** no `Date.now()`, no argless `new Date()`, ISO strings only. The ONE permitted "current date" default lives in a request handler.
- **Angular:** standalone components only, `ChangeDetectionStrategy.OnPush`, `signal`/`computed`/`linkedSignal`, native control flow (`@if`/`@for`), `inject()` in field initializers, `rxResource` params keyed on `auth.authReady()` (never snapshot `auth.userId()`/`auth.role()` at field-init).
- **Design system:** bespoke `command-*` classes + CSS tokens in `src/styles.css`; Material for icons only; use the `-text` token shade wherever an accent renders as text (WCAG AA).
- **UI copy language:** new page + nav label in **English** (matching `/capacity`, B2); edits inside `allocation-calendar.component.ts` stay **Italian**, matching that file's existing copy.
- **Commit messages in English**, one commit per task step group as written in each task.
- **Never** write `assignments.status` from a client body after Task 7; it is derived server-side only.

---

## File Structure

**Create:**
- `src/app/services/allocation-month.util.ts` — pure layer: month-row id helpers, month transition table, derived assignment status, per-month hour aggregation.
- `src/app/services/allocation-month.util.spec.ts` — its Vitest suite.
- `src/app/allocation-approvals/allocation-approvals.component.ts` — People Manager page (period filter, status filter, resource table, multi-select).
- `src/app/allocation-approvals/allocation-approvals.component.spec.ts`
- `src/app/allocation-approvals/approval-modal.component.ts` — multi-project month approval modal ("Approve Month" / "Reject Month" / "Approve & Continue").
- `src/app/allocation-approvals/approval-modal.component.spec.ts`
- `drizzle/0010_*.sql` — generated migration for `assignment_months`.

**Modify:**
- `src/app/services/api.service.ts` — `AssignmentMonth` type, allocation envelope extension, 5 new HTTP methods.
- `src/db/schema.ts` — `assignmentMonths` table.
- `src/db/repositories.ts` — repo wiring (pg + in-memory).
- `src/db/bootstrap.ts` — seed order (after `assignments`).
- `src/db/seed.ts` — `assignmentMonths` derived from the seeded assignments/days.
- `src/server.ts` — audit map, RBAC rules, month helpers, `/allocation` endpoint rewrite, submit/note/decide/feed endpoints, decision extraction, per-month aggregates.
- `src/app/services/capacity.util.ts` — `rollupMonthly` classifies by month status.
- `src/app/services/capacity.util.spec.ts` — updated fixtures.
- `src/app/services/staffing.util.ts` — `ALLOCATION_CLIENT_SETTABLE` emptied; `assignmentAggregateHours` deprecated in favour of the new util.
- `src/app/allocation-calendar/allocation-calendar.component.ts` — month status badge, "Invia mese in approvazione", planner/approver notes.
- `src/app/staffing/staffing.component.ts` — stops sending `status`.
- `src/app/approvals/approvals.ts` — Allocation row shows resource / project / **month**.
- `src/app/guards/role.guard.ts` — `ALLOCATION_APPROVAL_ROLES` + `allocationApprovalsGuard`.
- `src/app/app.routes.ts`, `src/app/app.ts` — route + nav entry.
- `scripts/smoke-api.mjs` — `checkMonthlyApproval()` section.
- `docs/roles-and-permissions.md` — new endpoints and their rules.

---

### Task 1: Pure allocation-month layer

**Files:**
- Create: `src/app/services/allocation-month.util.ts`
- Test: `src/app/services/allocation-month.util.spec.ts`

**Interfaces:**
- Consumes: `monthOf` from `src/app/services/calendar.util.ts`; the `AssignmentDay` type from `src/app/services/api.service.ts`.
- Produces (every later task depends on these exact names):
  - `type MonthStatus = 'Draft' | 'Requested' | 'Allocated' | 'Rejected'`
  - `monthRowId(assignmentId: string, month: string): string`
  - `parseMonthRowId(id: string): { assignmentId: string; month: string } | undefined`
  - `isAllowedMonthTransition(from: MonthStatus, to: MonthStatus): boolean`
  - `deriveAssignmentStatus(statuses: readonly MonthStatus[]): MonthStatus`
  - `monthlyAggregateHours(days: readonly DayHours[], statusByRowId: ReadonlyMap<string, MonthStatus>): { confirmed: number; planned: number }`
  - `interface DayHours { assignmentId: string; date: string; hours: number }`

- [ ] **Step 1: Write the failing test**

Create `src/app/services/allocation-month.util.spec.ts`:

```ts
import {
  deriveAssignmentStatus,
  isAllowedMonthTransition,
  monthRowId,
  monthlyAggregateHours,
  parseMonthRowId,
  type MonthStatus,
} from './allocation-month.util';

describe('monthRowId / parseMonthRowId', () => {
  it('builds the composite id', () => {
    expect(monthRowId('A12', '2026-09')).toBe('A12:2026-09');
  });

  it('round-trips a composite id', () => {
    expect(parseMonthRowId('A12:2026-09')).toEqual({ assignmentId: 'A12', month: '2026-09' });
  });

  it('returns undefined for a legacy (non-composite) refId', () => {
    expect(parseMonthRowId('A12')).toBeUndefined();
  });

  it('rejects a composite id whose month is not YYYY-MM', () => {
    expect(parseMonthRowId('A12:2026-13')).toBeUndefined();
    expect(parseMonthRowId('A12:not-a-month')).toBeUndefined();
  });
});

describe('isAllowedMonthTransition', () => {
  it('allows the planner submit path', () => {
    expect(isAllowedMonthTransition('Draft', 'Requested')).toBe(true);
    expect(isAllowedMonthTransition('Rejected', 'Requested')).toBe(true);
  });

  it('allows the decision outcomes from Requested', () => {
    expect(isAllowedMonthTransition('Requested', 'Allocated')).toBe(true);
    expect(isAllowedMonthTransition('Requested', 'Rejected')).toBe(true);
  });

  it('allows forced re-approval of an approved month', () => {
    expect(isAllowedMonthTransition('Allocated', 'Requested')).toBe(true);
  });

  it('rejects skipping the approval step', () => {
    expect(isAllowedMonthTransition('Draft', 'Allocated')).toBe(false);
    expect(isAllowedMonthTransition('Rejected', 'Allocated')).toBe(false);
  });

  it('treats a no-op transition as allowed', () => {
    expect(isAllowedMonthTransition('Allocated', 'Allocated')).toBe(true);
  });
});

describe('deriveAssignmentStatus', () => {
  it('is Draft when there are no month rows', () => {
    expect(deriveAssignmentStatus([])).toBe('Draft');
  });

  it('prefers Requested over every other state', () => {
    expect(deriveAssignmentStatus(['Allocated', 'Requested', 'Rejected'])).toBe('Requested');
  });

  it('prefers Rejected over Allocated when nothing is pending', () => {
    expect(deriveAssignmentStatus(['Allocated', 'Rejected', 'Draft'])).toBe('Rejected');
  });

  it('is Allocated when every non-draft month is approved', () => {
    expect(deriveAssignmentStatus(['Allocated', 'Draft'])).toBe('Allocated');
  });

  it('is Draft when all months are drafts', () => {
    expect(deriveAssignmentStatus(['Draft', 'Draft'])).toBe('Draft');
  });
});

describe('monthlyAggregateHours', () => {
  const days = [
    { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
    { assignmentId: 'A1', date: '2026-09-02', hours: 4 },
    { assignmentId: 'A1', date: '2026-10-01', hours: 6 },
    { assignmentId: 'A2', date: '2026-09-03', hours: 5 },
  ];

  it('weighs each day by the status of ITS month', () => {
    const status = new Map<string, MonthStatus>([
      ['A1:2026-09', 'Allocated'],
      ['A1:2026-10', 'Requested'],
      ['A2:2026-09', 'Draft'],
    ]);
    // confirmed = Allocated months only (8 + 4); planned = Requested + Allocated (8 + 4 + 6).
    expect(monthlyAggregateHours(days, status)).toEqual({ confirmed: 12, planned: 18 });
  });

  it('ignores days whose month row is missing or Rejected', () => {
    const status = new Map<string, MonthStatus>([['A1:2026-09', 'Rejected']]);
    expect(monthlyAggregateHours(days, status)).toEqual({ confirmed: 0, planned: 0 });
  });

  it('treats non-finite hours as zero', () => {
    const status = new Map<string, MonthStatus>([['A1:2026-09', 'Allocated']]);
    const rows = [{ assignmentId: 'A1', date: '2026-09-01', hours: Number.NaN }];
    expect(monthlyAggregateHours(rows, status)).toEqual({ confirmed: 0, planned: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test`
Expected: FAIL — cannot resolve `./allocation-month.util`.

- [ ] **Step 3: Write the implementation**

Create `src/app/services/allocation-month.util.ts`:

```ts
/**
 * Pure per-month allocation helpers (B3).
 *
 * The approval lifecycle lives on the (assignment, month) pair — see
 * docs/superpowers/specs/2026-08-02-b3-monthly-approval-design.md. This layer
 * holds the rules that must be identical on the server (src/server.ts) and in
 * the UI: the composite row id, the transition table, the assignment-level
 * status rollup, and the status-weighted hour aggregation that feeds
 * utilization / staffed effort / the capacity dashboard.
 *
 * Side-effect free and SSR-safe: no clock access, ISO strings only.
 */
import { monthOf } from './calendar.util';

export type MonthStatus = 'Draft' | 'Requested' | 'Allocated' | 'Rejected';

/** One day's hours, as stored by `assignmentDays` (B1). */
export interface DayHours {
  assignmentId: string;
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  hours: number;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Composite key of a month row: `<assignmentId>:<YYYY-MM>` (never newId()). */
export function monthRowId(assignmentId: string, month: string): string {
  return `${assignmentId}:${month}`;
}

/**
 * Split a month-row id back into its parts. Returns undefined when `id` is not
 * the composite form — which is how the decision hook tells a B3 month row from
 * a LEGACY gap-A approval whose refId is a bare assignment id.
 */
export function parseMonthRowId(id: string): { assignmentId: string; month: string } | undefined {
  const idx = id.lastIndexOf(':');
  if (idx <= 0) return undefined;
  const assignmentId = id.slice(0, idx);
  const month = id.slice(idx + 1);
  if (!MONTH_RE.test(month)) return undefined;
  return { assignmentId, month };
}

/**
 * Client- and system-driven transitions of ONE month row. Draft/Rejected are
 * submitted for approval; a decision moves Requested to its outcome; editing an
 * approved month forces re-approval (B1's rule, now scoped to the month).
 */
const MONTH_TRANSITIONS: Readonly<Record<MonthStatus, readonly MonthStatus[]>> = {
  Draft: ['Requested'],
  Requested: ['Allocated', 'Rejected', 'Draft'],
  Allocated: ['Requested'],
  Rejected: ['Requested'],
};

/** True iff a month row may move from `from` to `to`. A no-op is always allowed. */
export function isAllowedMonthTransition(from: MonthStatus, to: MonthStatus): boolean {
  if (from === to) return true;
  return MONTH_TRANSITIONS[from].includes(to);
}

/**
 * Roll month statuses up into the assignment's DERIVED status. Precedence
 * Requested > Rejected > Allocated > Draft: anything awaiting a decision
 * dominates (it is the actionable state), then anything refused, then approved
 * work; no rows at all reads as Draft.
 */
const STATUS_PRECEDENCE: readonly MonthStatus[] = ['Requested', 'Rejected', 'Allocated', 'Draft'];

export function deriveAssignmentStatus(statuses: readonly MonthStatus[]): MonthStatus {
  for (const candidate of STATUS_PRECEDENCE) {
    if (statuses.includes(candidate)) return candidate;
  }
  return 'Draft';
}

/**
 * Sum day hours weighted by the status of the MONTH each day falls in:
 * confirmed = 'Allocated' months, planned = 'Requested' + 'Allocated'.
 *
 * Days whose month row is absent contribute 0 — legacy assignments with day
 * rows but no month row (a Postgres DB populated before B1/B3) stay out of the
 * aggregates until their first calendar edit, continuing B1's self-healing
 * decision.
 */
export function monthlyAggregateHours(
  days: readonly DayHours[],
  statusByRowId: ReadonlyMap<string, MonthStatus>,
): { confirmed: number; planned: number } {
  let confirmed = 0, planned = 0;
  for (const d of days) {
    const status = statusByRowId.get(monthRowId(d.assignmentId, monthOf(d.date)));
    if (status === undefined) continue;
    const h = Number.isFinite(d.hours) ? d.hours : 0;
    if (status === 'Allocated') { confirmed += h; planned += h; }
    else if (status === 'Requested') { planned += h; }
  }
  return { confirmed, planned };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/ng test`
Expected: PASS (all suites green — the existing suites must stay green too).

- [ ] **Step 5: Commit**

```bash
git add src/app/services/allocation-month.util.ts src/app/services/allocation-month.util.spec.ts
git commit -m "feat(b3): pure allocation-month util (row id, transitions, derived status, per-month aggregate)"
```

---

### Task 2: Data model — type, table, repositories, seed, migration

**Files:**
- Modify: `src/app/services/api.service.ts` (add `AssignmentMonth` next to `AssignmentDay`, ~line 113)
- Modify: `src/db/schema.ts` (add `assignmentMonths` after `assignmentDays`, ~line 208)
- Modify: `src/db/repositories.ts` (interface ~line 352, pg ~line 432, mem ~line 498)
- Modify: `src/db/bootstrap.ts` (seed order, ~line 166)
- Modify: `src/db/seed.ts` (after `assignmentDays`, ~line 208)
- Create: `drizzle/0010_*.sql` (generated)
- Test: `src/db/repository.spec.ts` (add a parity case)

**Interfaces:**
- Consumes: `monthRowId`, `MonthStatus` (Task 1).
- Produces:
  - `interface AssignmentMonth { id: string; assignmentId: string; month: string; status: 'Draft'|'Requested'|'Allocated'|'Rejected'; approvalId?: string; plannerNote?: string; approverNote?: string }` (exported from `api.service.ts`)
  - `repos.assignmentMonths: Repository<AssignmentMonth>`
  - `seed.assignmentMonths: AssignmentMonth[]`

- [ ] **Step 1: Add the canonical type**

In `src/app/services/api.service.ts`, immediately after the `AssignmentDay` interface:

```ts
/**
 * Per-month lifecycle state of an assignment (B3). The approval unit is the
 * (assignment, month) pair — RPT approves month by month across projects — so
 * this row, not `Assignment.status`, is authoritative. `Assignment.status` is a
 * derived rollup of these (see allocation-month.util `deriveAssignmentStatus`).
 * A row exists even for a month with 0 hours: zeroing an approved month is
 * itself a proposal the People Manager must approve.
 */
export interface AssignmentMonth {
  /** Composite `<assignmentId>:<YYYY-MM>`. */
  id: string;
  assignmentId: string;
  /** 'YYYY-MM'. */
  month: string;
  status: 'Draft' | 'Requested' | 'Allocated' | 'Rejected';
  /** Id of the ApprovalRequest currently governing THIS month, if any. */
  approvalId?: string;
  /** Note written by the planner (PM) for the approver. */
  plannerNote?: string;
  /** Note written by the approver (People Manager) on the decision. */
  approverNote?: string;
}
```

- [ ] **Step 2: Add the Drizzle table**

In `src/db/schema.ts`, after the `assignmentDays` table (line 208), and add `AssignmentMonth` to the type import at the top of the file (the same import that already brings in `AssignmentDay`):

```ts
export const assignmentMonths = pgTable(
  'assignment_months',
  {
    id: text('id').primaryKey(), // '<assignmentId>:<YYYY-MM>'
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => assignments.id),
    month: text('month').notNull(), // 'YYYY-MM'
    status: text('status').$type<AssignmentMonth['status']>().notNull(),
    approvalId: text('approval_id'),
    plannerNote: text('planner_note'),
    approverNote: text('approver_note'),
  },
  (t) => [
    index('assignment_months_assignment_id_idx').on(t.assignmentId),
    index('assignment_months_month_idx').on(t.month),
  ],
);
```

- [ ] **Step 3: Wire the repositories**

In `src/db/repositories.ts`: add `assignmentMonths: Repository<AssignmentMonth>;` to the `Repositories` interface next to `assignmentDays` (line ~352), `assignmentMonths: pg<AssignmentMonth>(schema.assignmentMonths),` next to the pg adapter (line ~432), `assignmentMonths: mem<AssignmentMonth>(seed.assignmentMonths),` next to the in-memory one (line ~498), and import the `AssignmentMonth` type alongside `AssignmentDay`.

In `src/db/bootstrap.ts`, right after the `assignmentDays` seeding line (~166), parent-before-child ordering:

```ts
  await seedIfEmpty(database, schema.assignmentMonths, seed.assignmentMonths); // -> assignments
```

- [ ] **Step 4: Seed the month rows**

In `src/db/seed.ts`, after the `assignmentDays` export (line 208):

```ts
/**
 * Per-month lifecycle rows (B3), derived — not hand-typed — from the seeded
 * assignmentDays so a month row exists for exactly the months each assignment
 * actually books. Every seeded assignment is 'Allocated', so its months are too;
 * ONE month of assignment '2' is left 'Requested' (governed by the seeded
 * approval AR4 below) to give the People Manager page and the smoke suite a
 * pending item to decide out of the box.
 */
const PENDING_SEED_MONTH = { assignmentId: '2', month: '2026-08', approvalId: 'AR4' } as const;

function buildAssignmentMonths(
  rows: readonly Assignment[],
  days: readonly AssignmentDay[],
): AssignmentMonth[] {
  const monthsByAssignment = new Map<string, Set<string>>();
  for (const d of days) {
    const set = monthsByAssignment.get(d.assignmentId) ?? new Set<string>();
    set.add(d.date.slice(0, 7));
    monthsByAssignment.set(d.assignmentId, set);
  }
  const out: AssignmentMonth[] = [];
  for (const a of rows) {
    for (const month of [...(monthsByAssignment.get(a.id) ?? [])].sort()) {
      const pending = a.id === PENDING_SEED_MONTH.assignmentId && month === PENDING_SEED_MONTH.month;
      out.push({
        id: `${a.id}:${month}`,
        assignmentId: a.id,
        month,
        status: pending ? 'Requested' : 'Allocated',
        ...(pending ? { approvalId: PENDING_SEED_MONTH.approvalId, plannerNote: 'Extra month to cover the migration cut-over' } : {}),
      });
    }
  }
  return out;
}

export const assignmentMonths: AssignmentMonth[] = buildAssignmentMonths(assignments, assignmentDays);
```

Import `AssignmentMonth` in the same type-import statement that already imports `AssignmentDay`.

Then add the governing approval to the `approvalRequests` array (~line 584), following the shape of the existing `AR1` row. `requestedBy: '3'` (a PM, NOT the admin id `1` the smoke harness posts as) so Segregation of Duties does not block the smoke decision; the step carries no `approverId`, so any `resource-manager` may decide it (the role fallback of gap A):

```ts
  // AR4: Allocation (B3). refId is the MONTH ROW id, not an assignment id —
  // this is the pending month the People Manager page opens on.
  { id: 'AR4', kind: 'Allocation', refId: '2:2026-08', projectId: '1', requestedBy: '3', createdAt: '2026-07-28T08:00:00.000Z', note: 'Extra month to cover the migration cut-over',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-07-31T08:00:00.000Z',
    steps: [{ role: 'resource-manager', status: 'Pending' }] },
```

- [ ] **Step 5: Backfill month rows for an already-populated Postgres database**

`seedIfEmpty` only fires on an empty table, so a Postgres database populated before this migration would end up with day rows but **no** month rows — and since `assignments.status` becomes derived, every assignment would collapse to `Draft` and drop out of the confirmed/planned aggregates. Add an idempotent backfill in `src/db/bootstrap.ts`, called right after the `assignmentMonths` seeding line:

```ts
/**
 * Create the month rows an already-populated database is missing (B3).
 *
 * Idempotent and additive: only (assignment, month) pairs that have day rows but
 * no lifecycle row are inserted, carrying the assignment's CURRENT status — what
 * was booked and approved before B3 stays approved. Runs after seeding so a
 * fresh database (already consistent via seed.ts) finds nothing to do. The
 * mapping day -> month needs the calendar, so it cannot live in the SQL migration.
 */
async function backfillAssignmentMonths(database: DrizzleDb): Promise<number> {
  const days = await database.select().from(schema.assignmentDays);
  if (days.length === 0) return 0;
  const existing = new Set((await database.select().from(schema.assignmentMonths)).map(m => m.id));
  const statusById = new Map(
    (await database.select().from(schema.assignments)).map(a => [a.id, a.status]),
  );
  const VALID = new Set(['Draft', 'Requested', 'Allocated', 'Rejected']);

  const rows: { id: string; assignmentId: string; month: string; status: 'Draft' | 'Requested' | 'Allocated' | 'Rejected' }[] = [];
  const seen = new Set<string>();
  for (const d of days) {
    const month = d.date.slice(0, 7);
    const id = `${d.assignmentId}:${month}`;
    if (existing.has(id) || seen.has(id)) continue;
    const raw = statusById.get(d.assignmentId);
    if (raw === undefined) continue; // orphan day row: nothing to attach a lifecycle to
    seen.add(id);
    rows.push({
      id, assignmentId: d.assignmentId, month,
      // A pre-B3 free-text status that is not one of the four is treated as
      // booked work: 'Allocated' preserves the aggregates it already fed.
      status: (VALID.has(raw) ? raw : 'Allocated') as 'Draft' | 'Requested' | 'Allocated' | 'Rejected',
    });
  }
  if (rows.length === 0) return 0;
  await database.insert(schema.assignmentMonths).values(rows);
  return rows.length;
}
```

Call it after the seeding line added in Step 3:

```ts
  await seedIfEmpty(database, schema.assignmentMonths, seed.assignmentMonths); // -> assignments
  await backfillAssignmentMonths(database); // B3: month rows for pre-existing day rows
```

- [ ] **Step 6: Generate the migration**

Run: `./node_modules/.bin/drizzle-kit generate`
Expected: a new `drizzle/0010_*.sql` creating `assignment_months` with its two indexes and the FK to `assignments`. Read the generated SQL and confirm it is additive only (no DROP, no ALTER of existing columns).

- [ ] **Step 7: Add the repository parity test**

In `src/db/repository.spec.ts`, following the existing pattern used for `assignmentDays`, add a case asserting that an `assignmentMonths` row round-trips through the in-memory adapter with optional fields **absent** (not `null`) after an update that leaves them untouched:

```ts
it('keeps assignment-month optional fields absent (nulls-to-undefined parity)', async () => {
  const repos = makeInMemoryRepositories();
  const created = await repos.assignmentMonths.create({
    id: 'A9:2026-09', assignmentId: 'A9', month: '2026-09', status: 'Draft',
  } as AssignmentMonth);
  expect(created.approvalId).toBeUndefined();
  const updated = await repos.assignmentMonths.update('A9:2026-09', { status: 'Requested' });
  expect(updated?.status).toBe('Requested');
  expect(updated?.plannerNote).toBeUndefined();
});
```

Match the spec file's existing helper names for building repositories — read the top of `src/db/repository.spec.ts` first and reuse whatever factory the neighbouring tests use rather than inventing one.

- [ ] **Step 8: Run tests and build**

Run: `./node_modules/.bin/ng test` — Expected: PASS.
Run: `./node_modules/.bin/ng build` — Expected: success (type errors in `repositories.ts`/`seed.ts`/`bootstrap.ts` surface here).

- [ ] **Step 9: Commit**

```bash
git add src/app/services/api.service.ts src/db/schema.ts src/db/repositories.ts src/db/bootstrap.ts src/db/seed.ts src/db/repository.spec.ts drizzle/
git commit -m "feat(b3): assignmentMonths table, type, repositories, seed and migration"
```

---

### Task 3: Server month helpers + per-month forced re-approval in the allocation endpoint

**Files:**
- Modify: `src/server.ts` — audit map (~line 262), imports (~line 13), month helpers (next to `createAllocationApproval`, ~line 1084), `PUT /assignments/:id/allocation` (~lines 1586-1718), `GET /assignments/:id/allocation` envelope (~line 1574)

**Interfaces:**
- Consumes: `monthRowId`, `deriveAssignmentStatus`, `MonthStatus` (Task 1); `repos.assignmentMonths` (Task 2).
- Produces (used by Tasks 4, 5, 6, 8):
  - `async function monthStatusByRowId(): Promise<Map<string, MonthStatus>>`
  - `async function ensureAssignmentMonth(assignmentId: string, month: string): Promise<AssignmentMonth>`
  - `async function refreshDerivedAssignmentStatus(assignmentId: string): Promise<void>`
  - `createAllocationApproval(req: Request, assig: Assignment, refId?: string): Promise<string>` (existing function, new optional third parameter defaulting to `assig.id`)
  - `GET /assignments/:id/allocation` response gains `months: AssignmentMonth[]`

- [ ] **Step 1: Add the helpers**

In `src/server.ts`, extend the import from `./app/services/staffing.util` line with a new import from the new util:

```ts
import { deriveAssignmentStatus, monthRowId, parseMonthRowId, monthlyAggregateHours, type MonthStatus } from './app/services/allocation-month.util';
```

Add `['assignment-months', repos.assignmentMonths],` to `auditRepoBySegment` next to `assignment-days`.

Next to `createAllocationApproval` (~line 1084) add:

```ts
/** Snapshot of every month row's status, keyed by composite row id. */
async function monthStatusByRowId(): Promise<Map<string, MonthStatus>> {
  const rows = await repos.assignmentMonths.list();
  return new Map(rows.map(r => [r.id, r.status as MonthStatus]));
}

/**
 * Get (or lazily create as 'Draft') the month row for an assignment. The row is
 * created on the FIRST allocation write to that month, so a month with hours
 * always has a lifecycle state to carry.
 */
async function ensureAssignmentMonth(assignmentId: string, month: string): Promise<AssignmentMonth> {
  const id = monthRowId(assignmentId, month);
  const existing = await repos.assignmentMonths.get(id);
  if (existing) return existing;
  return repos.assignmentMonths.create({ id, assignmentId, month, status: 'Draft' } as AssignmentMonth);
}

/**
 * Recompute and persist `assignments.status` from its month rows. The column is
 * DERIVED (B3): no handler may write it from a client body — see the rollup rule
 * in allocation-month.util.
 */
async function refreshDerivedAssignmentStatus(assignmentId: string): Promise<void> {
  const rows = (await repos.assignmentMonths.list()).filter(r => r.assignmentId === assignmentId);
  const derived = deriveAssignmentStatus(rows.map(r => r.status as MonthStatus));
  await repos.assignments.update(assignmentId, { status: derived });
}
```

Change the signature of the existing `createAllocationApproval` so the approval can point at a month row:

```ts
/** Open a single-step (resource-manager) approval for `assig` and return its id.
 *  `refId` defaults to the assignment id (legacy gap-A shape); B3 passes the
 *  month-row id so the decision governs ONE month. */
async function createAllocationApproval(req: Request, assig: Assignment, refId: string = assig.id): Promise<string> {
```
and use `refId` in place of `refId: assig.id` inside the built `ApprovalRequestEntry`.

Import the `AssignmentMonth` type in the existing `import type { ... } from './app/services/api.service'` line.

- [ ] **Step 2: Write the failing smoke assertions**

In `scripts/smoke-api.mjs`, add a new section function `checkMonthlyApproval()` (registered in `main()` with its own try/catch, mirroring `checkTimePhasedAllocation`). For this task assert only the per-month re-approval scoping; later tasks extend the same function:

```js
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

  const edit = await req('PUT', '/assignments/3/allocation', {
    body: { month: target, dailyHours: { [day.date]: 2 } },
  });
  check('B3 month edit accepted', edit.status === 200, `status=${edit.status}`);

  const after = await req('GET', '/assignments/3/allocation?from=2026-05&to=2026-09');
  const editedRow = after.body.months.find(m => m.month === target);
  const siblingRow = after.body.months.find(m => m.month === sibling.month);
  check('B3 edited month demoted to Requested', editedRow?.status === 'Requested', `status=${editedRow?.status}`);
  check('B3 sibling month stays Allocated', siblingRow?.status === 'Allocated', `status=${siblingRow?.status}`);
}
```

- [ ] **Step 3: Run the smoke test to verify it fails**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 3
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
```
Expected: the three new B3 checks FAIL (no `months` in the envelope yet). Stop the server afterwards (`kill %1`).

- [ ] **Step 4: Extend the GET envelope**

In `GET /assignments/:id/allocation` (~line 1574), before `res.json(...)`, load the month rows for the requested span and include them:

```ts
  const months = (await repos.assignmentMonths.list())
    .filter(m => m.assignmentId === assig.id && (from === undefined || m.month >= from) && (to === undefined || m.month <= to))
    .sort((a, b) => a.month.localeCompare(b.month));
  res.json({ assignmentId: assig.id, from, to, contractHoursPerDay, months, days });
```

Add the field to the client-side envelope type in `src/app/services/api.service.ts` (`AssignmentAllocation`, ~line 122) so Task 9's calendar can read it:

```ts
  /** Per-month lifecycle rows for the requested span (B3). */
  months?: AssignmentMonth[];
```
Optional, because `PUT /assignments/:id/allocation` returns a narrower result envelope that carries no month list.

- [ ] **Step 5: Scope the forced re-approval to the edited month**

In `PUT /assignments/:id/allocation`, replace STEP 2 (lines ~1687-1700, the block starting `if (oldStatus === 'Allocated' && ...`) with the month-scoped version, and drop the now-unused `const oldStatus = assig.status;` in favour of the month row's status read BEFORE the write:

```ts
  // The lifecycle state of the month being written, read BEFORE the replace.
  const monthRow = await ensureAssignmentMonth(assig.id, month);
  const priorMonthStatus = monthRow.status as MonthStatus;
```
(place these two lines immediately before the `const replaced = await withLock(...)` block, after the capacity pre-check), then:

```ts
  // STEP 2 — OUTSIDE any res:/req: lock: forced re-approval, scoped to THIS month.
  // Trigger is the month's PRIOR status 'Allocated' (its days changed by
  // definition), not an assignedHours delta. Self-managed → stays Allocated with
  // no approval; otherwise supersede this month's approval and open a fresh one.
  // A still-'Requested' month keeps its pending approval (the approver re-reads
  // the days); Draft/Rejected have no approval effect. Months OTHER than the one
  // written are untouched — that is the whole point of B3.
  if (priorMonthStatus === 'Allocated' && !(await autoApprovesAllocation(req, resource.id))) {
    await withdrawAllocationApproval(monthRow.approvalId, 'superseded');
    const approvalId = await createAllocationApproval(req, assig, monthRow.id);
    await repos.assignmentMonths.update(monthRow.id, { status: 'Requested', approvalId });
  }
  // The assignment's own status is a rollup of its months — recompute it last.
  await refreshDerivedAssignmentStatus(assig.id);
```

Also remove the assignment-level `status` write from STEP 1 if present (STEP 1 only writes `assignedHours`).

- [ ] **Step 6: Re-run the smoke test to verify it passes**

Rebuild, restart the server on 4173, re-run the smoke script.
Expected: the three B3 checks PASS and every pre-existing check still passes.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(b3): month rows on the allocation endpoint — per-month forced re-approval, derived assignment status"
```

---

### Task 4: Submit a month for approval + planner note

**Files:**
- Modify: `src/server.ts` — new endpoints next to the allocation endpoint (~line 1718)
- Modify: `scripts/smoke-api.mjs` — extend `checkMonthlyApproval()`

**Interfaces:**
- Consumes: `ensureAssignmentMonth`, `refreshDerivedAssignmentStatus`, `createAllocationApproval`, `autoApprovesAllocation`, `isAllowedMonthTransition`.
- Produces:
  - `POST /assignments/:id/months/:month/submit` body `{ plannerNote?: string }` → `200` the updated `AssignmentMonth`
  - `PUT /assignments/:id/months/:month/note` body `{ plannerNote: string }` → `200` the updated `AssignmentMonth`

- [ ] **Step 1: Write the failing smoke assertions**

Append to `checkMonthlyApproval()` in `scripts/smoke-api.mjs`:

```js
  // Submit: the month edited above is Requested already, so drive a Draft month.
  // Assignment '1' spans 2026-05..2026-06; zero out 2026-06 to create a Draft
  // month row, then submit it.
  const alloc1 = await req('GET', '/assignments/1/allocation?from=2026-05&to=2026-06');
  const june = (alloc1.body.days || []).find(d => d.date.startsWith('2026-06'));
  if (june) {
    await req('PUT', '/assignments/1/allocation', { body: { month: '2026-06', dailyHours: { [june.date]: 3 } } });
  }
  const noteRes = await req('PUT', '/assignments/1/months/2026-06/note', { body: { plannerNote: 'ramp-up month' } });
  check('B3 planner note saved', noteRes.status === 200 && noteRes.body?.plannerNote === 'ramp-up month', `status=${noteRes.status}`);

  const submit = await req('POST', '/assignments/1/months/2026-06/submit', { body: {} });
  check('B3 submit moves the month to Requested', submit.status === 200 && submit.body?.status === 'Requested', `status=${submit.status} row=${submit.body?.status}`);
  check('B3 submit opens an approval', typeof submit.body?.approvalId === 'string', `approvalId=${submit.body?.approvalId}`);

  const resubmit = await req('POST', '/assignments/1/months/2026-06/submit', { body: {} });
  check('B3 double submit is rejected', resubmit.status === 400, `status=${resubmit.status}`);

  const closed = await req('POST', '/assignments/1/months/2026-03/submit', { body: {} });
  check('B3 submit on a non-open month is refused', closed.status === 403 || closed.status === 404, `status=${closed.status}`);
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Rebuild + restart + run (see Task 3 Step 3 commands).
Expected: the new checks FAIL with 404 (routes not mounted).

- [ ] **Step 3: Implement the endpoints**

In `src/server.ts`, after the `PUT /assignments/:id/allocation` handler:

```ts
/**
 * Shared preamble for the per-month endpoints: resolve the assignment and
 * validate the :month path parameter. Returns undefined after having written
 * the error response.
 */
async function resolveMonthTarget(req: Request, res: Response): Promise<{ assig: Assignment; month: string } | undefined> {
  const assig = await repos.assignments.get(req.params.id);
  if (assig === undefined) { res.status(404).json({ error: 'Not found' }); return undefined; }
  const month = req.params.month;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { res.status(400).json({ error: 'month must match YYYY-MM' }); return undefined; }
  return { assig, month };
}

// SUBMIT one month for approval ("Invia mese in approvazione"). Draft|Rejected
// -> Requested with a fresh single-step manager approval, or straight to
// Allocated when the proposer IS the resource's manager (the gap-A self-managed
// shortcut, unchanged). Requires an OPEN planning period: proposing work in a
// closed month is a planning error, not a governance one.
apiRouter.post('/assignments/:id/months/:month/submit', async (req, res) => {
  const target = await resolveMonthTarget(req, res);
  if (target === undefined) return;
  const { assig, month } = target;

  const period = await repos.planningPeriods.get(month);
  if (period?.status !== 'Open') { res.status(403).json({ error: 'month is not open for planning' }); return; }

  const row = await repos.assignmentMonths.get(monthRowId(assig.id, month));
  if (row === undefined) { res.status(404).json({ error: 'no allocation for this month' }); return; }
  if (!isAllowedMonthTransition(row.status as MonthStatus, 'Requested') || row.status === 'Requested') {
    res.status(400).json({ error: `illegal month transition ${row.status} -> Requested` });
    return;
  }

  const body = pick<{ plannerNote?: string }>(req.body, ['plannerNote']);
  const plannerNote = typeof body.plannerNote === 'string' ? body.plannerNote : undefined;

  // Self-managed: approver and requester would be the same principal (SoD would
  // block the decision anyway), so the month is approved on the spot.
  if (await autoApprovesAllocation(req, assig.resourceId)) {
    await withdrawAllocationApproval(row.approvalId, 'superseded');
    await repos.assignmentMonths.update(row.id, {
      status: 'Allocated', approvalId: undefined, ...(plannerNote !== undefined ? { plannerNote } : {}),
    } as Partial<AssignmentMonth>);
  } else {
    await withdrawAllocationApproval(row.approvalId, 'superseded');
    const approvalId = await createAllocationApproval(req, assig, row.id);
    await repos.assignmentMonths.update(row.id, {
      status: 'Requested', approvalId, ...(plannerNote !== undefined ? { plannerNote } : {}),
    } as Partial<AssignmentMonth>);
  }

  await refreshDerivedAssignmentStatus(assig.id);
  // Status-aware aggregates follow the month's new state. Best-effort, same
  // discipline as the allocation endpoint: the transition is already committed.
  try {
    await withLock(`res:${assig.resourceId}`, () => recomputeResourceUtilization(assig.resourceId));
    await withLock(`req:${assig.requestId}`, () => recomputeRequestStaffing(assig.requestId));
  } catch { /* aggregates self-heal on the next mutation */ }

  res.json(await repos.assignmentMonths.get(row.id));
});

// PLANNER NOTE on a month ("campo note" in RPT §3.5): saved only once the month
// exists, i.e. after the allocation has been drafted.
apiRouter.put('/assignments/:id/months/:month/note', async (req, res) => {
  const target = await resolveMonthTarget(req, res);
  if (target === undefined) return;
  const { assig, month } = target;

  const body = pick<{ plannerNote?: string }>(req.body, ['plannerNote']);
  if (typeof body.plannerNote !== 'string') { res.status(400).json({ error: 'plannerNote must be a string' }); return; }

  const row = await repos.assignmentMonths.get(monthRowId(assig.id, month));
  if (row === undefined) { res.status(404).json({ error: 'no allocation for this month' }); return; }
  await repos.assignmentMonths.update(row.id, { plannerNote: body.plannerNote });
  res.json(await repos.assignmentMonths.get(row.id));
});
```

Add `Response` to the existing `import type { Request, ... } from 'express'` if it is not already imported.

- [ ] **Step 4: Re-run the smoke test to verify it passes**

Expected: the five new checks PASS, everything else stays green.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(b3): submit-month-for-approval and planner-note endpoints"
```

---

### Task 5: Extract the decision core, month-aware hook, batch decide endpoint

**Files:**
- Modify: `src/server.ts` — `PUT /approval-requests/:id/decision` (~lines 2956-3075), new `POST /allocation-approvals/decide`, `allocationTransitionAudit` (~line 2937)
- Modify: `scripts/smoke-api.mjs` — extend `checkMonthlyApproval()`

**Interfaces:**
- Consumes: `parseMonthRowId`, `refreshDerivedAssignmentStatus`, `decisionToAssignmentStatus`.
- Produces:
  - `async function decideOneApproval(req: Request, approvalId: string, decision: 'Approved' | 'Rejected', note: string | undefined, ctx: DeciderContext): Promise<DecisionOutcome>`
  - `interface DeciderContext { by: string; decidingRole: string; deciderResourceId: string | undefined }`
  - `interface DecisionOutcome { status: number; body: unknown; allocation?: { refId: string; decided: 'Approved' | 'Rejected' } }`
  - `async function applyAllocationDecision(req: Request, refId: string, decided: 'Approved' | 'Rejected', note: string | undefined, deferAggregates?: boolean): Promise<{ resourceId: string; requestId: string } | undefined>` — returns the ids to recompute when `deferAggregates` is true (the batch dedupes them), and recomputes inline otherwise
  - `POST /allocation-approvals/decide` body `{ items: [{ assignmentMonthId, decision, note? }] }` → `200 { results: [{ assignmentMonthId, status, error? }] }`

- [ ] **Step 1: Write the failing smoke assertions**

Append to `checkMonthlyApproval()`:

```js
  // Decide the month submitted above, in batch, as a DIFFERENT principal than
  // the requester (SoD). The smoke harness posts as admin (id 1); decide as the
  // admin too but on a month requested by admin would violate SoD, so submit as
  // pm (id 2) first and decide as admin.
  await req('PUT', '/assignments/1/allocation', {
    body: { month: '2026-06', dailyHours: {} },
    headers: { 'X-User-Id': '2', 'X-User-Role': 'pm' },
  });
  const submitted = await req('POST', '/assignments/1/months/2026-06/submit', {
    body: { plannerNote: 'please confirm' },
    headers: { 'X-User-Id': '2', 'X-User-Role': 'pm' },
  });
  check('B3 pm submit ok', submitted.status === 200, `status=${submitted.status}`);

  const decide = await req('POST', '/allocation-approvals/decide', {
    body: { items: [
      { assignmentMonthId: '1:2026-06', decision: 'Approved', note: 'ok for me' },
      { assignmentMonthId: 'nope:2026-06', decision: 'Approved' },
    ] },
  });
  check('B3 batch decide returns 200', decide.status === 200, `status=${decide.status}`);
  const ok = (decide.body?.results || []).find(r => r.assignmentMonthId === '1:2026-06');
  const bad = (decide.body?.results || []).find(r => r.assignmentMonthId === 'nope:2026-06');
  check('B3 batch decides the valid item', ok?.status === 'Approved', `result=${JSON.stringify(ok)}`);
  check('B3 batch reports the invalid item without failing the call', bad?.status === 'Error' && typeof bad?.error === 'string', `result=${JSON.stringify(bad)}`);

  const decided = await req('GET', '/assignments/1/allocation?from=2026-06&to=2026-06');
  const decidedRow = (decided.body.months || [])[0];
  check('B3 decision applied to the month row', decidedRow?.status === 'Allocated', `status=${decidedRow?.status}`);
  check('B3 approver note stored on the month', decidedRow?.approverNote === 'ok for me', `note=${decidedRow?.approverNote}`);

  const denied = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: '2:2026-08', decision: 'Approved' }] },
    headers: { 'X-User-Id': '9', 'X-User-Role': 'employee' },
  });
  check('B3 batch decide refuses a non-approver role', denied.status === 403, `status=${denied.status}`);

  // A month CLOSED after submission must still be decidable (spec §4.5) — a
  // request in flight may never be left hanging — while its hours are frozen.
  // The seed leaves '2:2026-08' Requested under approval AR4.
  await req('PUT', '/planning-periods/2026-08', { body: { status: 'Closed' } });
  const frozen = await req('PUT', '/assignments/2/allocation', { body: { month: '2026-08', dailyHours: {} } });
  check('B3 closed month rejects hour edits', frozen.status === 403, `status=${frozen.status}`);
  const closedDecide = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: '2:2026-08', decision: 'Approved', note: 'confirmed after close' }] },
  });
  const closedResult = (closedDecide.body?.results || [])[0];
  check('B3 closed month is still decidable', closedResult?.status === 'Approved', `result=${JSON.stringify(closedResult)}`);
  await req('PUT', '/planning-periods/2026-08', { body: { status: 'Open' } }); // restore for reruns
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Expected: the batch checks FAIL with 404.

- [ ] **Step 3: Extract the decision core**

In `src/server.ts`, above `apiRouter.put('/approval-requests/:id/decision', ...)`, add the extracted function containing the body of the current `withLock('approval:...')` callback **verbatim** (SoD guard, step enforcement, note on step, chain advance, `allocation` surfacing):

```ts
interface DeciderContext { by: string; decidingRole: string; deciderResourceId: string | undefined }
interface DecisionOutcome { status: number; body: unknown; allocation?: { refId: string; decided: 'Approved' | 'Rejected' } }

/**
 * Decide ONE approval request. Extracted from the /decision handler so the B3
 * batch endpoint and the single-request endpoint share ONE implementation of
 * SoD + per-manager step enforcement — duplicating those rules is exactly how a
 * governance hole gets introduced.
 *
 * B-CONCURRENCY: serializes the read-decide-write under `approval:<id>`, and
 * re-reads INSIDE the lock so the decision applies to the freshest state.
 */
async function decideOneApproval(
  req: Request,
  approvalId: string,
  decision: 'Approved' | 'Rejected',
  note: string | undefined,
  ctx: DeciderContext,
): Promise<DecisionOutcome> {
  const { by, decidingRole, deciderResourceId } = ctx;
  return withLock(`approval:${approvalId}`, async (): Promise<DecisionOutcome> => {
    /* MOVE, don't rewrite: cut the body of the existing `withLock('approval:' +
       req.params.id, ...)` callback (src/server.ts lines ~2991-3040, from
       `const ar = await repos.approvalRequests.get(...)` down to and including
       the returned object with its `allocation` field) and paste it here
       VERBATIM, with exactly three substitutions:
         req.params.id -> approvalId
         body.note     -> note
         `decision`    -> the parameter of the same name (no other change)
       Every guard must survive the move unchanged: the 404, the
       `ar.status !== 'Pending'` 400, the SoD 403, the missing-step 400, and the
       roleMatch/managerMatch 403. Diff the moved block against the original
       before continuing — this function is the security boundary. */
  });
}
```

Then reduce the existing handler to: validate the body, resolve `decidingRole`/`by`/`deciderResourceId` exactly as today, call `decideOneApproval`, run the post-decision effect, respond. The post-decision effect moves into its own function (next step) so the batch endpoint reuses it.

- [ ] **Step 4: Make the post-decision hook month-aware**

Replace the inline post-decision block with:

```ts
/**
 * Apply an Allocation decision to the governed entity. `refId` carries the
 * shape: a composite `<assignmentId>:<YYYY-MM>` targets ONE month row (B3);
 * a bare assignment id is a LEGACY gap-A approval opened before B3 and still
 * pending — applied to the assignment itself so nothing in flight is orphaned.
 *
 * Called AFTER the `approval:<id>` lock has been released, under the fixed
 * res -> req lock order used by every other assignment mutation.
 *
 * `deferAggregates` lets the BATCH endpoint skip the per-item recompute and
 * instead recompute once per distinct resource/request at the end (spec §4.4):
 * approving twelve months of one resource must not recompute her utilization
 * twelve times. The returned ids are what the caller then dedupes.
 */
async function applyAllocationDecision(
  req: Request,
  refId: string,
  decided: 'Approved' | 'Rejected',
  note: string | undefined,
  deferAggregates = false,
): Promise<{ resourceId: string; requestId: string } | undefined> {
  const parsed = parseMonthRowId(refId);
  const newStatus = decisionToAssignmentStatus(decided);

  const recompute = async (resourceId: string, requestId: string): Promise<void> => {
    if (deferAggregates) return;
    await withLock(`res:${resourceId}`, () => recomputeResourceUtilization(resourceId));
    await withLock(`req:${requestId}`, () => recomputeRequestStaffing(requestId));
  };

  if (parsed === undefined) {
    const assig = await repos.assignments.get(refId);
    if (!assig) return undefined;
    await repos.assignments.update(assig.id, { status: newStatus });
    try {
      await recompute(assig.resourceId, assig.requestId);
      await repos.auditLogs.create(allocationTransitionAudit(req, assig, newStatus, `/assignments/${assig.id}`));
    } catch { /* recompute/audit are best-effort; the decision already committed */ }
    return { resourceId: assig.resourceId, requestId: assig.requestId };
  }

  const row = await repos.assignmentMonths.get(refId);
  if (!row) return undefined;
  const assig = await repos.assignments.get(row.assignmentId);
  if (!assig) return undefined;

  // The month transition MUST succeed (or surface as a 500): an approval that
  // reports Approved while the governed month stays Requested is the exact
  // divergence this hook exists to prevent. The approver's note is mirrored onto
  // the row (it also lives on the decided step, as in gap A) so the calendar can
  // show it without resolving the approval request.
  await repos.assignmentMonths.update(row.id, {
    status: newStatus, ...(note !== undefined ? { approverNote: note } : {}),
  } as Partial<AssignmentMonth>);
  await refreshDerivedAssignmentStatus(assig.id);
  try {
    await recompute(assig.resourceId, assig.requestId);
    await repos.auditLogs.create(allocationTransitionAudit(req, assig, newStatus, `/assignment-months/${row.id}`));
  } catch { /* recompute/audit are best-effort; the decision already committed */ }
  return { resourceId: assig.resourceId, requestId: assig.requestId };
}
```

Give `allocationTransitionAudit` a fourth parameter `path: string` and use it for the entry's `path` (today it hardcodes `/assignments/${assig.id}`).

In the single-request `/decision` handler, the post-decision call becomes
`await applyAllocationDecision(req, result.allocation.refId, result.allocation.decided, body.note);` — same note the step recorded, no deferral.

- [ ] **Step 5: Add the batch endpoint**

```ts
/** Hard cap on one batch: a People Manager approving a month across projects
 *  for a multi-resource selection stays far below this. */
const DECIDE_BATCH_MAX = 200;

/**
 * B3 — "Approva Mese" / "Approva e Prosegui": decide N month rows in one call.
 * Each item is independent: a row already decided, missing, carrying no pending
 * approval, or refused by SoD / step enforcement yields an Error result and
 * never fails its neighbours. Aggregate recompute is deduplicated per
 * resource/request at the END of the batch rather than per item.
 */
apiRouter.post('/allocation-approvals/decide', async (req, res) => {
  const decidingRole = trustedRole(req);
  if (decidingRole === 'unknown') {
    res.status(401).json({ error: 'A verified principal is required to decide an approval request' });
    return;
  }
  const body = pick<{ items?: unknown }>(req.body, ['items']);
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items must be a non-empty array' }); return;
  }
  if (items.length > DECIDE_BATCH_MAX) {
    res.status(400).json({ error: `items must contain at most ${DECIDE_BATCH_MAX} entries` }); return;
  }

  const ctx: DeciderContext = { by: actorId(req), decidingRole, deciderResourceId: await actorResourceId(req) };
  const results: { assignmentMonthId: string; status: string; error?: string }[] = [];
  // Aggregates are recomputed ONCE per distinct resource/request after the loop
  // (spec §4.4), never per item.
  const touchedResources = new Set<string>();
  const touchedRequests = new Set<string>();

  for (const raw of items) {
    const item = raw as { assignmentMonthId?: unknown; decision?: unknown; note?: unknown };
    const id = typeof item.assignmentMonthId === 'string' ? item.assignmentMonthId : '';
    const decision = item.decision === 'Approved' || item.decision === 'Rejected' ? item.decision : undefined;
    const note = typeof item.note === 'string' ? item.note : undefined;
    if (!id || decision === undefined) {
      results.push({ assignmentMonthId: id, status: 'Error', error: "each item needs assignmentMonthId and decision 'Approved'|'Rejected'" });
      continue;
    }
    const row = await repos.assignmentMonths.get(id);
    if (row === undefined) { results.push({ assignmentMonthId: id, status: 'Error', error: 'Not found' }); continue; }
    if (row.approvalId === undefined) { results.push({ assignmentMonthId: id, status: 'Error', error: 'month has no pending approval' }); continue; }

    const outcome = await decideOneApproval(req, row.approvalId, decision, note, ctx);
    if (outcome.status !== 200) {
      const message = (outcome.body as { error?: string } | undefined)?.error ?? `decision failed (${outcome.status})`;
      results.push({ assignmentMonthId: id, status: 'Error', error: message });
      continue;
    }
    if (outcome.allocation) {
      const touched = await applyAllocationDecision(req, outcome.allocation.refId, outcome.allocation.decided, note, true);
      if (touched) { touchedResources.add(touched.resourceId); touchedRequests.add(touched.requestId); }
    }
    results.push({ assignmentMonthId: id, status: decision });
  }

  // Deduplicated aggregate recompute, fixed res -> req lock order. Best-effort:
  // every decision above has already committed.
  try {
    for (const resourceId of touchedResources) {
      await withLock(`res:${resourceId}`, () => recomputeResourceUtilization(resourceId));
    }
    for (const requestId of touchedRequests) {
      await withLock(`req:${requestId}`, () => recomputeRequestStaffing(requestId));
    }
  } catch { /* aggregates self-heal on the next mutation of the same resource/request */ }

  res.json({ results });
});
```

- [ ] **Step 6: Add the RBAC rules for the new prefix**

In the mutation `rules` array (~line 522), next to the `/approval-requests` rule:

```ts
    // B3 batch month decisions run the SAME engine as /approval-requests, so the
    // coarse gate matches; the fine filter is the per-step approverId check.
    { test: p => p.startsWith('/allocation-approvals'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
```

- [ ] **Step 7: Re-run the smoke test to verify it passes**

Expected: every B3 check PASSES; the pre-existing allocation-approval section (gap A, single-request decisions) still passes — that section is the regression guard for the extraction.

- [ ] **Step 8: Run the unit tests and lint**

Run: `./node_modules/.bin/ng test` then `./node_modules/.bin/ng lint`
Expected: PASS / clean.

- [ ] **Step 9: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(b3): batch month decisions — shared decision core, month-aware post-decision hook"
```

---

### Task 6: Per-month aggregates (utilization, staffed effort, capacity rollup)

**Files:**
- Modify: `src/server.ts` — `recomputeResourceUtilization` (~line 1020), `recomputeRequestStaffing` (~line 1062), the `/capacity/monthly` handler (~line 1727)
- Modify: `src/app/services/capacity.util.ts` — `RollupInput`/`rollupMonthly`
- Modify: `src/app/services/capacity.util.spec.ts` — fixtures carry month statuses
- Modify: `src/app/services/staffing.util.ts` — deprecate `assignmentAggregateHours`

**Interfaces:**
- Consumes: `monthlyAggregateHours`, `monthRowId` (Task 1); `repos.assignmentMonths` (Task 2).
- Produces: `RollupInput` gains `assignmentMonths: { assignmentId: string; month: string; status: string }[]` and drops the `status` field from `RollupAssignment`.

- [ ] **Step 1: Write the failing capacity test**

In `src/app/services/capacity.util.spec.ts`, add (adapting the existing fixture builders in that file):

```ts
it('classifies each month by ITS OWN status, not the assignment status', () => {
  const rollup = rollupMonthly({
    resources: [{ id: 'R1', name: 'Ada' }],
    assignments: [{ id: 'A1', resourceId: 'R1' }],
    assignmentMonths: [
      { assignmentId: 'A1', month: '2026-09', status: 'Allocated' },
      { assignmentId: 'A1', month: '2026-10', status: 'Requested' },
    ],
    assignmentDays: [
      { assignmentId: 'A1', date: '2026-09-01', hours: 8 },
      { assignmentId: 'A1', date: '2026-10-01', hours: 8 },
    ],
    months: ['2026-09', '2026-10'],
    hoursPerDay: 8,
    holidays: new Set<string>(),
  });
  const row = rollup.rows[0];
  expect(row.monthly['2026-09'].confirmedHours).toBe(8);
  expect(row.monthly['2026-10'].confirmedHours).toBe(0);
  expect(row.monthly['2026-10'].plannedHours).toBe(8);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test`
Expected: FAIL — `assignmentMonths` is not part of `RollupInput`.

- [ ] **Step 3: Update the capacity util**

In `src/app/services/capacity.util.ts`:

```ts
interface RollupAssignment { id: string; resourceId: string }
interface RollupMonth { assignmentId: string; month: string; status: string }

export interface RollupInput {
  resources: RollupResource[]; assignments: RollupAssignment[]; assignmentDays: RollupDay[];
  /** B3: per-month lifecycle state — the classifier for confirmed/planned. */
  assignmentMonths: RollupMonth[];
  months: string[]; hoursPerDay: number; holidays: ReadonlySet<string>;
}
```

In `rollupMonthly`, build `const statusByRowId = new Map(assignmentMonths.map(m => [`${m.assignmentId}:${m.month}`, m.status]));` and, in the day loop, replace the two `a.status` lookups with a lookup of `statusByRowId.get(`${d.assignmentId}:${monthOf(d.date)}`)` — a day whose month row is missing contributes to neither total (same rule as `monthlyAggregateHours`). Keep `CONFIRMED`/`PLANNED` as the classifying sets.

- [ ] **Step 4: Feed the new input from the server**

In the `/capacity/monthly` handler, add `assignmentMonths: (await repos.assignmentMonths.list()).map(m => ({ assignmentId: m.assignmentId, month: m.month, status: m.status })),` to the `rollupMonthly({...})` call and drop `status` from the mapped assignments.

- [ ] **Step 5: Switch the two recomputes to per-month aggregation**

In `recomputeResourceUtilization`, replace the `assignmentAggregateHours(rows)` call with:

```ts
  const statusByRowId = await monthStatusByRowId();
  const assignmentIds = new Set(rows.map(a => a.id));
  const days = (await repos.assignmentDays.list()).filter(d => assignmentIds.has(d.assignmentId));
  const { confirmed, planned } = monthlyAggregateHours(days, statusByRowId);
```
keeping every surrounding line (capacity guard, clamping, the `utilizationPlanned` write) as-is — only the source of `confirmed`/`planned` changes. Apply the identical change in `recomputeRequestStaffing`, where `rows` is the request's assignments.

In `src/app/services/staffing.util.ts`, mark the now-unused helper as legacy rather than deleting it (its spec documents gap-A behaviour):

```ts
/**
 * @deprecated B3 — superseded by `monthlyAggregateHours` (allocation-month.util),
 * which weighs each day by the status of ITS month. Kept for the gap-A unit
 * tests that document the pre-B3 rollup; no runtime caller remains.
 */
```

- [ ] **Step 6: Run tests, lint, build**

Run: `./node_modules/.bin/ng test`, `./node_modules/.bin/ng lint`, `./node_modules/.bin/ng build`
Expected: PASS / clean / success. Fix any capacity spec fixture that still passes `status` on an assignment.

- [ ] **Step 7: Verify the capacity dashboard end-to-end**

Rebuild, restart on 4173, run the smoke script.
Expected: the B2 `checkCapacityMonthly()` section still passes, and the B3 section still passes.

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/app/services/capacity.util.ts src/app/services/capacity.util.spec.ts src/app/services/staffing.util.ts
git commit -m "feat(b3): confirmed/planned aggregates weighted by per-month status"
```

---

### Task 7: Retire client-settable assignment status

**Files:**
- Modify: `src/app/services/staffing.util.ts` — `ALLOCATION_CLIENT_SETTABLE`
- Modify: `src/server.ts` — `POST /assignments` (~line 1359), `PUT /assignments/:id` (~line 1403), `DELETE /assignments/:id` (~line 1521)
- Modify: `src/app/staffing/staffing.component.ts` — the create call
- Test: `src/app/services/staffing.util.spec.ts`

**Interfaces:**
- Produces: `POST/PUT /assignments` ignore a client `status` (400 if explicitly supplied); new assignments are created `Draft`; `DELETE /assignments/:id` also removes the assignment's month rows.

- [ ] **Step 1: Write the failing test**

In `src/app/services/staffing.util.spec.ts`:

```ts
it('exposes no client-settable allocation status after B3 (status is derived)', () => {
  expect([...ALLOCATION_CLIENT_SETTABLE]).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test` — Expected: FAIL (currently `['Draft', 'Requested']`).

- [ ] **Step 3: Empty the list and reject a client status**

In `src/app/services/staffing.util.ts`:

```ts
/**
 * B3: NOTHING is client-settable — `assignments.status` is derived from the
 * month rows (allocation-month.util `deriveAssignmentStatus`). The lifecycle is
 * driven exclusively by the per-month endpoints. Kept as an exported constant so
 * the handlers' guard reads the same way it did in gap A.
 */
export const ALLOCATION_CLIENT_SETTABLE: readonly AllocationStatus[] = [];
```

In `POST /assignments`: drop `'status'` from the `pick(...)` allow-list, delete the `requestedStatus`/`selfManaged`/`effectiveStatus` block and the approval-opening block, and create with `status: 'Draft'`. Add an explicit rejection so a stale client is told why:

```ts
  // B3: the lifecycle lives on the month rows; a client may not seed a status.
  if ((req.body as { status?: unknown } | undefined)?.status !== undefined) {
    res.status(400).json({ error: 'status is derived from the per-month allocation and cannot be set on an assignment' });
    return;
  }
```

In `PUT /assignments/:id`: apply the same rejection, drop `'status'` from the `pick(...)` allow-list, and delete the whole approval side-effect block (lines ~1443-1495) plus the `finalStatus`/`autoApproved`/`materialChange` machinery — the patch no longer carries `status` or `approvalId`. Keep the FK-retarget validation and the aggregate recomputes untouched, and after the `repos.assignments.update(...)` call add `await refreshDerivedAssignmentStatus(req.params.id);`.

In `DELETE /assignments/:id`: after the per-day rows are deleted, delete the month rows too, and withdraw each row's pending approval first:

```ts
  // B3: withdraw each month's pending approval and drop the month rows before
  // the parent delete (assignment_months -> assignments is ON DELETE no action,
  // so Postgres would otherwise reject the parent delete with an FK violation).
  const monthRows = (await repos.assignmentMonths.list()).filter(m => m.assignmentId === oldAssig.id);
  for (const m of monthRows) {
    await withdrawAllocationApproval(m.approvalId, 'assignment deleted');
    await repos.assignmentMonths.remove(m.id);
  }
```

After these deletions `ALLOCATION_CLIENT_SETTABLE` and `isAllowedAllocationTransition` have no remaining caller in `src/server.ts` — remove them from its import list (lint fails on unused imports). Both stay exported from `staffing.util.ts`: the constant is asserted by the Step 1 test, the transition guard is still covered by its own gap-A suite.

- [ ] **Step 4: Update the staffing component**

In `src/app/staffing/staffing.component.ts`, remove `status` from the `createAssignment(...)` payload and adjust the button copy so it reads as creating a proposal (the approval submission now happens in the calendar). Read the surrounding code first and keep the file's existing Italian/English copy convention.

- [ ] **Step 5: Run tests, lint, build, smoke**

Run all four gates (unit, lint, build, live smoke on 4173).
Expected: PASS. The gap-A smoke section still exercises single-request decisions through the legacy path; if any of its checks POSTed an assignment with a `status`, update those calls to the new contract and note it in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/staffing.util.ts src/app/services/staffing.util.spec.ts src/server.ts src/app/staffing/staffing.component.ts scripts/smoke-api.mjs
git commit -m "feat(b3)!: assignment status is derived — remove client-settable status from /assignments"
```

---

### Task 8: Approval feed endpoint + API client methods

**Files:**
- Modify: `src/server.ts` — `GET /allocation-approvals`, `READ_RULES` (~line 568)
- Modify: `src/app/services/api.service.ts` — envelope types + 5 methods (next to the B1 block, ~line 728)

**Interfaces:**
- Produces:
  - `GET /allocation-approvals?from&to&status` → `AllocationApprovalFeed`
  - ```ts
    export interface AllocationApprovalItem {
      assignmentMonthId: string; assignmentId: string; month: string; status: AssignmentMonth['status'];
      projectId?: string; projectName?: string; requestId: string; hours: number;
      plannerNote?: string; approverNote?: string; approvalId?: string;
    }
    export interface AllocationApprovalRow {
      resourceId: string; resourceName: string; managerId?: string; contractHoursPerDay: number;
      targetHours: Record<string, number>; totalHours: Record<string, number>;
      items: AllocationApprovalItem[];
    }
    export interface AllocationApprovalFeed { months: string[]; rows: AllocationApprovalRow[] }
    export interface AllocationDecisionItem { assignmentMonthId: string; decision: 'Approved' | 'Rejected'; note?: string }
    export interface AllocationDecisionResult { assignmentMonthId: string; status: string; error?: string }
    ```
  - `ApiService`: `getAllocationApprovals(from?, to?, status?)`, `submitAssignmentMonth(assignmentId, month, plannerNote?)`, `setAssignmentMonthNote(assignmentId, month, plannerNote)`, `decideAllocationMonths(items)`

- [ ] **Step 1: Write the failing smoke assertion**

Append to `checkMonthlyApproval()`:

```js
  const feed = await req('GET', '/allocation-approvals?from=2026-05&to=2026-09&status=all');
  check('B3 feed returns months and rows', feed.status === 200 && Array.isArray(feed.body?.months) && Array.isArray(feed.body?.rows), `status=${feed.status}`);
  const withItems = (feed.body?.rows || []).find(r => (r.items || []).length > 0);
  check('B3 feed rows carry per-month items', !!withItems && typeof withItems.items[0].assignmentMonthId === 'string', `rows=${feed.body?.rows?.length}`);
  check('B3 feed exposes the monthly target', !!withItems && typeof withItems.targetHours === 'object', 'targetHours missing');

  const pendingOnly = await req('GET', '/allocation-approvals?from=2026-05&to=2026-09&status=Requested');
  const allPending = (pendingOnly.body?.rows || []).every(r => (r.items || []).every(i => i.status === 'Requested'));
  check('B3 feed status filter narrows to pending months', pendingOnly.status === 200 && allPending, `status=${pendingOnly.status}`);

  const denied = await req('GET', '/allocation-approvals', { headers: { 'X-User-Id': '9', 'X-User-Role': 'employee' } });
  check('B3 feed refuses a non-staffing role', denied.status === 403, `status=${denied.status}`);
```

- [ ] **Step 2: Run the smoke test to verify it fails**

Expected: FAIL with 404.

- [ ] **Step 3: Implement the feed endpoint**

In `src/server.ts`, next to the `/capacity/monthly` handler (it owns the same "one permitted current-date default" pattern — copy its `from`/`to` defaulting verbatim so both views span the same window). The `AllocationApprovalRow`/`AllocationApprovalItem` types this handler builds are declared in Step 4 — add those first if your editor complains:

```ts
/**
 * B3 — People Manager approval feed: resources × months × projects with the
 * per-month lifecycle state, hours, target and notes. Read-only; gated by the
 * '/allocation-approvals' READ_RULE (roleGate is GLOBAL middleware — do NOT
 * re-gate per handler).
 */
apiRouter.get('/allocation-approvals', async (req, res) => {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const qParam = (name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === 'string' ? v : undefined;
  };
  const fromRaw = qParam('from');
  const toRaw = qParam('to');
  if (fromRaw !== undefined && !MONTH_RE.test(fromRaw)) { res.status(400).json({ error: 'from must be a YYYY-MM month' }); return; }
  if (toRaw !== undefined && !MONTH_RE.test(toRaw)) { res.status(400).json({ error: 'to must be a YYYY-MM month' }); return; }
  const statusFilter = qParam('status') ?? 'all';
  if (!['all', 'Requested', 'Allocated'].includes(statusFilter)) {
    res.status(400).json({ error: "status must be 'all', 'Requested' or 'Allocated'" }); return;
  }

  // Default window: the open planning periods, so the page opens on exactly the
  // months a People Manager can act on (RPT's "Mesi aperti").
  const openMonths = (await repos.planningPeriods.list()).filter(p => p.status === 'Open').map(p => p.id).sort();
  const from = fromRaw ?? openMonths[0];
  const to = toRaw ?? openMonths[openMonths.length - 1];
  if (from === undefined || to === undefined) { res.json({ months: [], rows: [] }); return; }
  const months = monthsInRange(from, to);

  const [resources, assignments, monthRows, days, requests, projects, holidayRows] = await Promise.all([
    repos.resources.list(), repos.assignments.list(), repos.assignmentMonths.list(),
    repos.assignmentDays.list(), repos.requests.list(), repos.projects.list(), repos.holidays.list(),
  ]);
  const holidays = new Set(holidayRows.map(h => h.id));
  const hoursPerDay = await getHoursPerDay();
  const assignmentById = new Map(assignments.map(a => [a.id, a]));
  const requestById = new Map(requests.map(r => [r.id, r]));
  const projectById = new Map(projects.map(p => [p.id, p]));

  // Hours per (assignment, month), summed from the day rows.
  const hoursByRow = new Map<string, number>();
  for (const d of days) {
    const key = monthRowId(d.assignmentId, monthOf(d.date));
    hoursByRow.set(key, (hoursByRow.get(key) ?? 0) + (Number.isFinite(d.hours) ? d.hours : 0));
  }

  const rowsByResource = new Map<string, AllocationApprovalRow>();
  for (const m of monthRows) {
    if (m.month < from || m.month > to) continue;
    if (statusFilter !== 'all' && m.status !== statusFilter) continue;
    const assig = assignmentById.get(m.assignmentId);
    if (assig === undefined) continue;
    const resource = resources.find(r => r.id === assig.resourceId);
    if (resource === undefined) continue;

    let row = rowsByResource.get(resource.id);
    if (row === undefined) {
      const cap = (typeof resource.contractHoursPerDay === 'number' && Number.isFinite(resource.contractHoursPerDay) && resource.contractHoursPerDay > 0)
        ? resource.contractHoursPerDay : hoursPerDay;
      row = {
        resourceId: resource.id, resourceName: resource.name, managerId: resource.managerId,
        contractHoursPerDay: cap,
        targetHours: Object.fromEntries(months.map(mo => [mo, monthlyTargetHours(cap, mo, holidays)])),
        totalHours: Object.fromEntries(months.map(mo => [mo, 0])),
        items: [],
      };
      rowsByResource.set(resource.id, row);
    }
    const request = requestById.get(assig.requestId);
    const project = request?.projectId ? projectById.get(request.projectId) : undefined;
    const hours = hoursByRow.get(m.id) ?? 0;
    row.totalHours[m.month] = (row.totalHours[m.month] ?? 0) + hours;
    row.items.push({
      assignmentMonthId: m.id, assignmentId: m.assignmentId, month: m.month, status: m.status,
      projectId: project?.id, projectName: project?.name, requestId: assig.requestId, hours,
      plannerNote: m.plannerNote, approverNote: m.approverNote, approvalId: m.approvalId,
    });
  }

  const rows = [...rowsByResource.values()].sort((a, b) => a.resourceName.localeCompare(b.resourceName));
  for (const row of rows) row.items.sort((a, b) => a.month.localeCompare(b.month) || a.assignmentId.localeCompare(b.assignmentId));
  res.json({ months, rows });
});
```

Import `monthsInRange` from `capacity.util` and `monthlyTargetHours`/`monthOf` from `calendar.util` if the server does not already import them, and declare the `AllocationApprovalRow`/`AllocationApprovalItem` types by importing them from `api.service` (they live there per the Interfaces block).

Add the READ rule next to `/capacity` (~line 568):

```ts
  // B3 approval feed: the People Manager's month-by-month queue — approver-grade
  // roles only (stricter than /capacity, which is a read-only rollup).
  { test: p => p.startsWith('/allocation-approvals'), roles: ['resource-manager', 'delivery-executive', 'admin'] },
```

- [ ] **Step 4: Add the API client methods**

In `src/app/services/api.service.ts`, after the B1 allocation block (~line 748), and extend `AssignmentAllocation` with `months: AssignmentMonth[]`:

```ts
  // --- Per-month approval (B3) ---

  /** Read the People Manager approval feed. Omitted bounds default to the open planning periods. */
  getAllocationApprovals(from?: string, to?: string, status?: 'all' | 'Requested' | 'Allocated'): Observable<AllocationApprovalFeed> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    if (to) params = params.set('to', to);
    if (status) params = params.set('status', status);
    return this.http.get<AllocationApprovalFeed>(`${this.baseUrl}/allocation-approvals`, { params });
  }

  /** Send ONE month of an assignment for approval ("Invia mese in approvazione"). */
  submitAssignmentMonth(assignmentId: string, month: string, plannerNote?: string): Observable<AssignmentMonth> {
    return this.http.post<AssignmentMonth>(`${this.baseUrl}/assignments/${assignmentId}/months/${month}/submit`, { plannerNote });
  }

  /** Save the planner's note on a month row. */
  setAssignmentMonthNote(assignmentId: string, month: string, plannerNote: string): Observable<AssignmentMonth> {
    return this.http.put<AssignmentMonth>(`${this.baseUrl}/assignments/${assignmentId}/months/${month}/note`, { plannerNote });
  }

  /** Decide N month rows in one call ("Approva Mese" / "Approva e Prosegui"). */
  decideAllocationMonths(items: AllocationDecisionItem[]): Observable<{ results: AllocationDecisionResult[] }> {
    return this.http.post<{ results: AllocationDecisionResult[] }>(`${this.baseUrl}/allocation-approvals/decide`, { items });
  }
```

Match the file's existing `HttpParams` usage (check `getCapacityMonthly` for the exact idiom before writing).

- [ ] **Step 5: Re-run the smoke test to verify it passes**

Expected: the five feed checks PASS.

- [ ] **Step 6: Run tests, lint, build**

Expected: PASS / clean / success.

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/app/services/api.service.ts scripts/smoke-api.mjs
git commit -m "feat(b3): allocation-approval feed endpoint and API client methods"
```

---

### Task 9: Calendar — submit month, status badge, notes

**Files:**
- Modify: `src/app/allocation-calendar/allocation-calendar.component.ts`

**Interfaces:**
- Consumes: `AssignmentAllocation.months` (Task 8), `api.submitAssignmentMonth`, `api.setAssignmentMonthNote`.

- [ ] **Step 1: Surface the month state**

Add a computed lookup next to the existing month helpers:

```ts
  /** Lifecycle row of a month, when the assignment has one (created on first save). */
  protected monthRow = (month: string): AssignmentMonth | undefined =>
    this.data.value().allocation.months?.find(m => m.month === month);

  protected monthStatus = (month: string): AssignmentMonth['status'] | undefined => this.monthRow(month)?.status;

  /** A month may be submitted when it exists, is open, and is not already pending/approved. */
  protected canSubmit = (month: string): boolean => {
    const status = this.monthStatus(month);
    return this.isOpen(month) && (status === 'Draft' || status === 'Rejected');
  };
```

- [ ] **Step 2: Render the badge, the submit button and the notes**

In the per-month header (next to the existing `Aperto`/`Chiuso` badge at line ~113) add a status chip, using the design-system status classes already used in the file and the `-text` token shade for accent text:

```html
                  @if (monthStatus(month); as status) {
                    <span class="command-status uppercase"
                          [class]="status === 'Allocated' ? 'green' : status === 'Requested' ? 'amber' : status === 'Rejected' ? 'red' : 'neutral'">
                      {{ statusLabel(status) }}
                    </span>
                  }
```

Next to the existing `saveMonth` button (line ~183):

```html
                  <button type="button" (click)="submitMonth(month)"
                          [disabled]="!canSubmit(month) || submittingMonth() === month"
                          class="command-btn-primary">
                    {{ submittingMonth() === month ? 'Invio…' : 'Invia mese in approvazione' }}
                  </button>
```

Below the month grid, the notes block (planner editable, approver read-only) — the planner note field is disabled until the month row exists, mirroring RPT §3.5 ("il salvataggio della nota è possibile solo dopo aver salvato in bozza"):

```html
              <div class="mt-4 grid gap-3 sm:grid-cols-2">
                <label class="text-xs font-semibold text-ink-secondary">
                  Nota per l'approvatore
                  <textarea rows="2" class="command-input mt-1 w-full"
                            [disabled]="!monthRow(month)"
                            [ngModel]="plannerNoteDraft(month)"
                            (ngModelChange)="setPlannerNoteDraft(month, $event)"
                            (blur)="savePlannerNote(month)"></textarea>
                </label>
                @if (monthRow(month)?.approverNote; as approverNote) {
                  <p class="text-xs text-ink-secondary"><span class="font-semibold">Nota approvatore:</span> {{ approverNote }}</p>
                }
              </div>
```

- [ ] **Step 3: Implement the handlers**

Follow the existing `saveMonth` implementation for the notification + reload idiom (read it first — it uses `NotificationService` and reloads `data`):

```ts
  protected submittingMonth = signal<string | null>(null);
  private plannerNoteDrafts = signal<Record<string, string>>({});

  protected statusLabel(status: AssignmentMonth['status']): string {
    return status === 'Allocated' ? 'Allocato' : status === 'Requested' ? 'In approvazione' : status === 'Rejected' ? 'Rifiutato' : 'Bozza';
  }

  protected plannerNoteDraft(month: string): string {
    return this.plannerNoteDrafts()[month] ?? this.monthRow(month)?.plannerNote ?? '';
  }

  protected setPlannerNoteDraft(month: string, value: string): void {
    this.plannerNoteDrafts.update(d => ({ ...d, [month]: value }));
  }

  protected savePlannerNote(month: string): void {
    const row = this.monthRow(month);
    const draft = this.plannerNoteDraft(month);
    if (!row || draft === (row.plannerNote ?? '')) return;
    this.api.setAssignmentMonthNote(this.assignmentId(), month, draft)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.data.reload(),
        error: () => { /* the global error interceptor surfaces the message */ },
      });
  }

  protected submitMonth(month: string): void {
    this.submittingMonth.set(month);
    this.api.submitAssignmentMonth(this.assignmentId(), month, this.plannerNoteDraft(month) || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: row => {
          this.submittingMonth.set(null);
          this.notify.success(row.status === 'Allocated' ? `Mese ${month} allocato` : `Mese ${month} inviato in approvazione`);
          this.data.reload();
        },
        error: () => this.submittingMonth.set(null),
      });
  }
```

Match the component's existing injected member names (`api`, `notify`, `destroyRef`, `assignmentId`) — read the class body before writing.

- [ ] **Step 4: Verify in the browser**

Run: `./node_modules/.bin/ng serve` and open the staffing page → calendar for an assignment. Confirm: status chip per month; the submit button disabled on an `Allocated`/`Requested` month and enabled on a `Draft`; the note field disabled before the first save; submitting flips the chip to "In approvazione".

- [ ] **Step 5: Run tests, lint, build**

Expected: PASS / clean / success.

- [ ] **Step 6: Commit**

```bash
git add src/app/allocation-calendar/allocation-calendar.component.ts
git commit -m "feat(b3): calendar month status, submit-for-approval and planner/approver notes"
```

---

### Task 10: Allocation approvals page — table, filters, route, guard, nav

**Files:**
- Create: `src/app/allocation-approvals/allocation-approvals.component.ts`
- Create: `src/app/allocation-approvals/allocation-approvals.component.spec.ts`
- Modify: `src/app/guards/role.guard.ts`, `src/app/app.routes.ts`, `src/app/app.ts`

**Interfaces:**
- Consumes: `api.getAllocationApprovals` (Task 8), `semaphoreBand` (`capacity.util`).
- Produces: `ALLOCATION_APPROVAL_ROLES: readonly UserRole[]`, `allocationApprovalsGuard: CanMatchFn`, route `/allocation-approvals`, and the component's `selectedResourceIds()` signal consumed by Task 12.

- [ ] **Step 1: Add the guard**

In `src/app/guards/role.guard.ts`, after the capacity block:

```ts
/**
 * Approver-grade roles allowed to open the per-month allocation approvals page
 * (B3), mirroring the server's '/allocation-approvals' READ_RULE. Single source
 * of truth shared by {@link allocationApprovalsGuard} and the nav entry in app.ts.
 */
export const ALLOCATION_APPROVAL_ROLES: readonly UserRole[] = ['resource-manager', 'delivery-executive', 'admin'];

/** Allows matching only for {@link ALLOCATION_APPROVAL_ROLES}. */
export const allocationApprovalsGuard: CanMatchFn = roleGuard(auth => auth.hasAnyRole([...ALLOCATION_APPROVAL_ROLES]));
```

- [ ] **Step 2: Write the failing component test**

Create `src/app/allocation-approvals/allocation-approvals.component.spec.ts`. It follows `src/app/capacity/capacity.component.spec.ts`, which stubs `ApiService` with `vi.fn()` returning `of(...)` — there is no `HttpTestingController` in these suites:

```ts
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AllocationApprovalsComponent } from './allocation-approvals.component';
import { AllocationApprovalFeed, ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';

/** Two resources over one month: Ada has a pending month, Bob only approved work. */
const FEED: AllocationApprovalFeed = {
  months: ['2026-09'],
  rows: [
    {
      resourceId: 'r1', resourceName: 'Ada', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 88 },
      items: [{ assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 88 }],
    },
    {
      resourceId: 'r2', resourceName: 'Bob', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 176 },
      items: [{ assignmentMonthId: 'A2:2026-09', assignmentId: 'A2', month: '2026-09', status: 'Allocated', requestId: '2', projectName: 'Gemini', hours: 176 }],
    },
  ],
};

function setup(ready: boolean) {
  const getAllocationApprovals = vi.fn(() => of(FEED));
  const apiStub = { getAllocationApprovals } as unknown as ApiService;
  const authStub = { authReady: signal(ready), isAuthenticated: signal(ready) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [AllocationApprovalsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });
  const fixture = TestBed.createComponent(AllocationApprovalsComponent);
  return { fixture, getAllocationApprovals };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AllocationApprovalsComponent', () => {
  it('renders one row per resource once auth is ready', async () => {
    const { fixture, getAllocationApprovals } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const rows = host.querySelectorAll('[data-test="approval-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Ada');
    expect(rows[0].textContent).toContain('88');
    expect(getAllocationApprovals).toHaveBeenCalled();
  });

  it('does not call the API before auth is ready', async () => {
    const { fixture, getAllocationApprovals } = setup(false);
    await flush(fixture);
    expect(getAllocationApprovals).not.toHaveBeenCalled();
  });

  it('toggles a resource into the selection', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const checkbox = host.querySelector('[data-test="select-resource"]') as HTMLInputElement;
    checkbox.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedResourceIds().has('r1')).toBe(true);
  });

  it('enables multi-approve only with more than one resource selected', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector('[data-test="multi-approve"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    host.querySelectorAll<HTMLInputElement>('[data-test="select-resource"]').forEach(cb => cb.click());
    fixture.detectChanges();
    expect((host.querySelector('[data-test="multi-approve"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
```

`selectedResourceIds` must therefore be a **public** signal on the component (the spec reads it directly).

- [ ] **Step 3: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test` — Expected: FAIL (component does not exist).

- [ ] **Step 4: Implement the page**

Create `src/app/allocation-approvals/allocation-approvals.component.ts`. Structure it exactly like `capacity.component.ts` (read it as the template):

- `rxResource<AllocationApprovalFeed, {ready: boolean; from: string|null; to: string|null; status: string}>` whose `params` include `this.auth.authReady()` and return `EMPTY` until ready;
- `linkedSignal` for the `from`/`to` month inputs, defaulting to the feed's own months;
- a status filter signal with the three RPT choices — `Requested` ("Richiesto"), `Allocated` ("Confermato"), `all` ("Tutti") — rendered as English UI copy: `Pending` / `Approved` / `All`;
- a `selectedResourceIds = signal<Set<string>>(new Set())` with a `toggleResource(id: string)` method (`data-test="select-resource"` on the checkbox);
- the table: one `<tr data-test="approval-row">` per feed row with the resource name, then a cell per month showing `totalHours / targetHours` tinted by `semaphoreBand((total / target) * 100)`, and a button `data-test="open-modal"` that sets `modalResourceId`;
- KPI header: number of resources with at least one `Requested` item, and total pending months;
- an `@if (modalResourceId())` block rendering `<app-approval-modal>` (Task 11) inside the standard modal backdrop used elsewhere in the app;
- a toolbar button `data-test="multi-approve"` enabled when `selectedResourceIds().size > 1` (wired in Task 12).

Page copy in English (`Allocation Approvals`, `Pending`, `Approved`, `All`, `Approve month`), consistent with `/capacity`. The class skeleton the spec of Step 2 is written against:

```ts
const EMPTY: AllocationApprovalFeed = { months: [], rows: [] };

@Component({
  selector: 'app-allocation-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, DecimalPipe, ApprovalModalComponent],
  template: `...`,
})
export class AllocationApprovalsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  /** 'Requested' = RPT "Richiesto", 'Allocated' = "Confermato". */
  protected statusFilter = signal<'all' | 'Requested' | 'Allocated'>('Requested');
  protected from = signal<string | null>(null);
  protected to = signal<string | null>(null);

  private feedRes = rxResource<AllocationApprovalFeed, { ready: boolean; from: string | null; to: string | null; status: 'all' | 'Requested' | 'Allocated' }>({
    params: () => ({ ready: this.auth.authReady(), from: this.from(), to: this.to(), status: this.statusFilter() }),
    stream: ({ params }) => params.ready
      ? this.api.getAllocationApprovals(params.from ?? undefined, params.to ?? undefined, params.status)
      : of(EMPTY),
    defaultValue: EMPTY,
  });

  protected feed = computed(() => this.feedRes.value() ?? EMPTY);
  protected months = computed(() => this.feed().months);
  protected rows = computed(() => this.feed().rows);

  /** Public: the spec asserts on it, and Task 12's multi mode reads it. */
  selectedResourceIds = signal<ReadonlySet<string>>(new Set());
  protected selectedRows = computed(() => this.rows().filter(r => this.selectedResourceIds().has(r.resourceId)));
  protected modalResourceId = signal<string | null>(null);
  protected multiMode = signal(false);

  protected toggleResource(resourceId: string): void {
    this.selectedResourceIds.update(current => {
      const next = new Set(current);
      if (!next.delete(resourceId)) next.add(resourceId);
      return next;
    });
  }

  protected pendingMonths = computed(() =>
    this.rows().reduce((n, r) => n + r.items.filter(i => i.status === 'Requested').length, 0));

  protected cellBand(row: AllocationApprovalRow, month: string): SemaphoreBand {
    const target = row.targetHours[month] ?? 0;
    return semaphoreBand(target > 0 ? ((row.totalHours[month] ?? 0) / target) * 100 : 0);
  }

  protected onDecided(): void { this.feedRes.reload(); this.modalResourceId.set(null); this.multiMode.set(false); }
}
```

Copy the `rxResource` idiom, the KPI strip markup and the sticky-first-column table styling from `capacity.component.ts` rather than inventing new markup.

- [ ] **Step 5: Register route and nav**

`src/app/app.routes.ts`, next to the capacity route:

```ts
  { path: 'allocation-approvals', title: 'Allocation Approvals', canMatch: [allocationApprovalsGuard], loadComponent: () => import('./allocation-approvals/allocation-approvals.component').then(m => m.AllocationApprovalsComponent) },
```

`src/app/app.ts`: import `ALLOCATION_APPROVAL_ROLES`, add `{ label: 'Allocation Approvals', icon: 'fact_check', route: '/allocation-approvals' }` to the same nav group as Capacity, add `const canViewAllocationApprovals = this.auth.hasAnyRole([...ALLOCATION_APPROVAL_ROLES]);` next to `canViewCapacity`, and extend the visibility switch with `if (item.route === '/allocation-approvals') return canViewAllocationApprovals;`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `./node_modules/.bin/ng test` — Expected: PASS.

- [ ] **Step 7: Verify in the browser**

`./node_modules/.bin/ng serve`, sign in as the demo resource-manager, open `/allocation-approvals`: the table lists resources, the filters change the feed, the nav entry is hidden for a `pm` identity.

- [ ] **Step 8: Commit**

```bash
git add src/app/allocation-approvals src/app/guards/role.guard.ts src/app/app.routes.ts src/app/app.ts
git commit -m "feat(b3): allocation approvals page — resource table, filters, guard, route, nav"
```

---

### Task 11: Multi-project approval modal (Approve / Reject one month)

**Files:**
- Create: `src/app/allocation-approvals/approval-modal.component.ts`
- Create: `src/app/allocation-approvals/approval-modal.component.spec.ts`
- Modify: `src/app/allocation-approvals/allocation-approvals.component.ts` (render the modal, reload on decision)

**Interfaces:**
- Consumes: `AllocationApprovalRow` (Task 8), `api.decideAllocationMonths`.
- Produces: component `ApprovalModalComponent` with inputs `rows = input.required<AllocationApprovalRow[]>()`, `months = input.required<string[]>()`, and outputs `decided = output<void>()`, `closed = output<void>()`.

- [ ] **Step 1: Write the failing test**

Create `src/app/allocation-approvals/approval-modal.component.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApprovalModalComponent } from './approval-modal.component';
import { AllocationApprovalRow, ApiService } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

/** One resource, two projects in the same month: one pending, one already approved. */
const ROW: AllocationApprovalRow = {
  resourceId: 'r1', resourceName: 'Ada', contractHoursPerDay: 8,
  targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 120 },
  items: [
    { assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 80, plannerNote: 'kickoff' },
    { assignmentMonthId: 'A2:2026-09', assignmentId: 'A2', month: '2026-09', status: 'Allocated', requestId: '2', projectName: 'Gemini', hours: 40 },
  ],
};

function setup(rows: AllocationApprovalRow[] = [ROW], months = ['2026-09'], multi = false) {
  const decideAllocationMonths = vi.fn(() => of({ results: [{ assignmentMonthId: 'A1:2026-09', status: 'Approved' }] }));
  const apiStub = { decideAllocationMonths } as unknown as ApiService;
  const notifyStub = { success: vi.fn(), error: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    imports: [ApprovalModalComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });
  const fixture = TestBed.createComponent(ApprovalModalComponent);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('months', months);
  fixture.componentRef.setInput('multi', multi);
  fixture.detectChanges();
  return { fixture, decideAllocationMonths, notifyStub };
}

describe('ApprovalModalComponent', () => {
  it('lists one line per project of the selected month', () => {
    const { fixture } = setup();
    const lines = (fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="project-line"]');
    expect(lines.length).toBe(2);
    expect(lines[0].textContent).toContain('Apollo');
  });

  it('pre-checks only the pending months', () => {
    const { fixture } = setup();
    expect([...fixture.componentInstance.checked()]).toEqual(['A1:2026-09']);
  });

  it('sends exactly the checked months to the batch decision', () => {
    const { fixture, decideAllocationMonths } = setup();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-month"]')!.click();

    expect(decideAllocationMonths).toHaveBeenCalledWith([
      { assignmentMonthId: 'A1:2026-09', decision: 'Approved', note: undefined },
    ]);
  });

  it('sends Rejected with the approver note', () => {
    const { fixture, decideAllocationMonths } = setup();
    fixture.componentInstance.setApproverNote('A1:2026-09', 'no capacity');
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="reject-month"]')!.click();

    expect(decideAllocationMonths).toHaveBeenCalledWith([
      { assignmentMonthId: 'A1:2026-09', decision: 'Rejected', note: 'no capacity' },
    ]);
  });

  it('disables the actions when nothing is checked', () => {
    const { fixture } = setup([{ ...ROW, items: [ROW.items[1]] }]);
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-month"]')!;
    expect(button.disabled).toBe(true);
  });
});
```

`checked()` and `setApproverNote(id, text)` must be public members of the component (the spec drives them directly).

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test` — Expected: FAIL.

- [ ] **Step 3: Implement the modal**

Create `src/app/allocation-approvals/approval-modal.component.ts`:

- standalone, `OnPush`, `imports: [MatIconModule, FormsModule]`, `host: { class: 'contents' }` and the `command-card` panel shell copied from `allocation-calendar.component.ts` (same modal look);
- `selectedMonth = linkedSignal(() => this.months()[0] ?? '')` plus a month `<select>` labelled `Open months`;
- for each row and each item in the selected month, a line `data-test="project-line"` with a checkbox, the project name (`item.projectName ?? item.requestId`), the hours (`{{ item.hours }}h`), the month status chip, and a notes toggle showing `plannerNote` and an editable approver note `data-test="approver-note"` (RPT: the note button is highlighted when a note already exists);
- `checked = signal<Set<string>>(new Set())` keyed by `assignmentMonthId`, defaulting to every **pending** item of the selected month (only `Requested` items are decidable — non-pending lines render with a disabled checkbox);
- `approve()` / `reject()` build `AllocationDecisionItem[]` from `checked()` and call `api.decideAllocationMonths(...)`, then emit `decided`. On a response containing any `status === 'Error'`, surface the first message via `NotificationService.error` and still emit `decided` (the successful items landed);
- buttons `data-test="approve-month"` ("Approve month") and `data-test="reject-month"` ("Reject month"), both disabled when `checked().size === 0`.

In `allocation-approvals.component.ts`, render it for the resource behind `modalResourceId()` (pass a single-element `rows` array) and call `feed.reload()` on `(decided)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/ng test` — Expected: PASS.

- [ ] **Step 5: Verify end-to-end in the browser**

With `ng serve`: open the page as the demo resource-manager, open the modal on the resource holding the seeded `Requested` month (assignment `2`, month `2026-08`), approve it, and confirm the chip flips to approved and the row's numbers refresh.

- [ ] **Step 6: Run lint and build**

Expected: clean / success.

- [ ] **Step 7: Commit**

```bash
git add src/app/allocation-approvals
git commit -m "feat(b3): multi-project month approval modal (approve/reject with approver note)"
```

---

### Task 12: Multi-resource selection — "Approve & Continue"

**Files:**
- Modify: `src/app/allocation-approvals/allocation-approvals.component.ts`
- Modify: `src/app/allocation-approvals/approval-modal.component.ts`
- Modify: `src/app/allocation-approvals/approval-modal.component.spec.ts`

**Interfaces:**
- Produces: modal input `multi = input<boolean>(false)`; when true the modal renders "Approve & Continue" instead of "Approve month" and advances `selectedMonth` to the next month in `months()` after a successful decision, staying open.

- [ ] **Step 1: Write the failing test**

Add to `approval-modal.component.spec.ts` (the `setup` helper from Task 11 already takes `months` and `multi`):

```ts
describe('ApprovalModalComponent — multi-resource mode', () => {
  it('advances to the next month and stays open after Approve & Continue', () => {
    const { fixture } = setup([ROW], ['2026-09', '2026-10'], true);
    let closedEmitted = 0;
    fixture.componentInstance.closed.subscribe(() => closedEmitted++);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedMonth()).toBe('2026-10');
    expect(closedEmitted).toBe(0);
  });

  it('closes after deciding the last month', () => {
    const { fixture } = setup([ROW], ['2026-09'], true);
    let closedEmitted = 0;
    fixture.componentInstance.closed.subscribe(() => closedEmitted++);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="approve-continue"]')!.click();
    fixture.detectChanges();

    expect(closedEmitted).toBe(1);
  });

  it('renders the single-month action when multi is false', () => {
    const { fixture } = setup([ROW], ['2026-09'], false);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="approve-continue"]')).toBeNull();
    expect(host.querySelector('[data-test="approve-month"]')).not.toBeNull();
  });
});
```

`selectedMonth` must be public for the spec to read it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test` — Expected: FAIL.

- [ ] **Step 3: Implement**

In `approval-modal.component.ts`: add the `multi` input; in multi mode render one collapsible section per row (resource name as the section header, its project lines beneath) and swap the primary button for `data-test="approve-continue"` labelled "Approve & Continue". After a successful decision in multi mode, compute the next month from `months()`; set it and reset `checked()` to that month's pending items, or emit `closed` when the current month is the last.

In `allocation-approvals.component.ts`: wire the `data-test="multi-approve"` toolbar button to open the modal with `[rows]="selectedRows()" [multi]="true"`, where `selectedRows()` filters the feed by `selectedResourceIds()`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/ng test` — Expected: PASS.

- [ ] **Step 5: Verify in the browser**

Select two resources, click the multi-approve button, approve a month, confirm the modal stays open and shows the next month.

- [ ] **Step 6: Run lint and build; commit**

```bash
git add src/app/allocation-approvals
git commit -m "feat(b3): multi-resource approval mode with Approve & Continue"
```

---

### Task 13: Approvals inbox wording, docs, and full verification

**Files:**
- Modify: `src/app/approvals/approvals.ts` (~lines 117, 369-380)
- Modify: `docs/roles-and-permissions.md`
- Modify: `scripts/smoke-api.mjs` (final pass)

- [ ] **Step 1: Describe Allocation rows by month**

In `src/app/approvals/approvals.ts`, `rowLabel` (~line 374) currently ignores the month. Make it month-aware, keeping today's wording for a legacy `refId` that carries none:

```ts
  private rowLabel(request: ApprovalRequest, projectLabel: string): string {
    if (request.kind === 'Allocation') {
      const base = request.projectId ? `Allocazione su ${projectLabel}` : 'Allocazione risorsa';
      // B3: refId is '<assignmentId>:<YYYY-MM>'. A bare id is a pre-B3 approval.
      const parsed = parseMonthRowId(request.refId);
      return parsed ? `${base} — ${parsed.month}` : base;
    }
    return request.refId;
  }
```

Import `parseMonthRowId` from `../services/allocation-month.util`. In the template, inside the existing `@if (row.kind === 'Allocation')` block (~line 117), add the deep link to the dedicated page:

```html
                      <a routerLink="/allocation-approvals" class="command-link text-xs">Apri approvazioni mensili</a>
```

Add `RouterLink` to the component's `imports` array if it is not already there.

- [ ] **Step 2: Update the RBAC reference**

In `docs/roles-and-permissions.md`, add the new paths to the tables: `GET /allocation-approvals` (read: `resource-manager, delivery-executive, admin`), `POST /allocation-approvals/decide` (mutation: `pm, resource-manager, delivery-executive, finance, admin`, narrowed by per-step `approverId`), `POST /assignments/:id/months/:month/submit` and `PUT /assignments/:id/months/:month/note` (mutation: `pm, resource-manager, delivery-executive, admin`). Note the B3 change to `/assignments`: `status` is no longer client-settable.

- [ ] **Step 3: Run the complete gate set**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 3
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```
Expected: all unit tests pass, lint clean, build succeeds, smoke 100% (the pre-B1/B2 sections included).

- [ ] **Step 4: Verify Postgres parity**

```bash
docker compose up -d postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node dist/app/server/server.mjs
```
Confirm the boot log shows migration `0010` applied and `assignment_months` seeded, then run the smoke script against it. This is the check that the new table's optional columns round-trip through `nullsToUndefined()` the same way in both adapters.

- [ ] **Step 5: Commit**

```bash
git add src/app/approvals/approvals.ts docs/roles-and-permissions.md scripts/smoke-api.mjs
git commit -m "docs(b3): month-aware approvals inbox wording and RBAC reference"
```

---

## Verification Checklist (before merge)

- [ ] Editing one month of a multi-month approved assignment demotes **only** that month.
- [ ] "Invia mese in approvazione" opens exactly one approval; a self-managed proposer skips it and lands on `Allocated`.
- [ ] Batch decide returns per-item outcomes; a bad item never breaks its neighbours.
- [ ] SoD holds: the submitter cannot decide their own month, in the batch path too.
- [ ] A month closed after submission is still decidable, but its hours are not editable.
- [ ] `/capacity` numbers reflect per-month statuses (a pending month counts as planned, not confirmed).
- [ ] `POST /assignments` with a `status` in the body is rejected with 400.
- [ ] A pre-B3 pending Allocation approval (bare `refId`) still applies to its assignment when decided.
- [ ] Unit tests, lint, build, live smoke, and the Postgres run are all green.
