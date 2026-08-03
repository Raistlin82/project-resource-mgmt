# C2 — Dummy → Real Resource Substitution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a People Manager hand a dummy's booked hours to a real person, transferring only what that person can actually absorb and leaving the rest on the dummy for someone else.

**Architecture:** A pure layer does the day-by-day arithmetic (`transfer = min(dummy hours, the person's remaining daily capacity)`), so partial substitution falls out of the existing capacity constraint instead of needing a quota field. The move is immediate but reversible: hours leave the dummy at once — no double counting between demand and uncovered demand — and one nullable, transient column (`replacedFromAssignmentMonthId`) records where to give them back. B3's post-decision hook gains a single branch: a rejection returns everything, an approval returns only the difference the approver trimmed.

**Tech Stack:** Angular 21 (standalone, signal-first, OnPush), Express 5, Drizzle ORM + PostgreSQL, Vitest via `@angular/build:unit-test`, dependency-free smoke script.

**Spec:** `docs/superpowers/specs/2026-08-03-c2-dummy-substitution-design.md`
**Branch:** `feature/c2-dummy-substitution` (already created; the spec commit is `14fce9d`).

## Global Constraints

- **Tooling:** `./node_modules/.bin/ng test`, `./node_modules/.bin/ng lint`, `./node_modules/.bin/ng build`, `./node_modules/.bin/drizzle-kit generate` — **never `npx`**.
- **Live smoke:** build, then `env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &`, then `SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs`. Host `localhost`, NOT `127.0.0.1`. Kill the server after. **Use a FRESH server process** — a warm one gives false failures from the rate limiter. **Baselines: unit 492, smoke 198.**
- **Postgres parity:** the final task re-runs the smoke suite against a FRESH database (the shared one carries state from earlier runs). C1's Postgres run found a defect seven tasks after it landed; do not leave it to the end if you can help it.
- **`src/db/seed.ts` is the single source of truth** for seed data, consumed by both adapters.
- **`nullsToUndefined()`** runs on every repository *return* path. An explicit `null` in an update patch means "clear to absent" on **both** adapters; `undefined` means "leave untouched".
- **Pure utils are SSR-safe:** no `Date.now()`, no argless `new Date()`, ISO strings only.
- **Lock discipline** (documented in `src/server.ts` and load-bearing): approval-repository I/O and status writes NEVER run inside a `res:`/`req:` aggregate lock; aggregate recomputes run last and best-effort. C2 adds one rule: when two `res:` locks are needed, acquire them **in lexicographic order of the resource ids**.
- **Angular:** standalone only, `OnPush`, signal-first, native control flow, `inject()` in field initializers, `rxResource` params keyed on `auth.authReady()`.
- **Design system:** bespoke `command-*` classes + tokens; Material for icons only; `-text` shade wherever an accent renders as text. **UI copy in English.**
- TypeScript strict; no `any`; `ng lint` **errors** on unused vars.
- Commit messages in English.

---

## File Structure

**Create:**
- `src/app/services/substitution.util.ts` — the pure transfer arithmetic.
- `src/app/services/substitution.util.spec.ts`
- `drizzle/0012_*.sql` — generated migration.

**Modify:**
- `src/app/services/api.service.ts` — `AssignmentMonth.replacedFromAssignmentMonthId`, the substitution request/response types, one client method.
- `src/db/schema.ts` — one nullable column on `assignment_months`.
- `src/server.ts` — the substitution endpoint, the per-month transfer helper, the RBAC rule, and the return branch in `applyAllocationDecision`.
- `src/app/allocation-approvals/approval-modal.component.ts` + `.spec.ts` — the *Substitute* action, the person search, the summary and the outcome.
- `src/app/allocation-calendar/allocation-calendar.component.ts` + `.spec.ts` — highlighting months that arrived by substitution.
- `scripts/smoke-api.mjs` — a `checkDummySubstitution()` section.
- `docs/roles-and-permissions.md`, `docs/architecture/03-backend-and-data.md`.

---

### Task 1: Pure substitution arithmetic

**Files:**
- Create: `src/app/services/substitution.util.ts`
- Test: `src/app/services/substitution.util.spec.ts`

**Interfaces:**
- Produces:
  - `interface SubstitutionPlan { transfer: Record<string, number>; remaining: Record<string, number>; transferredHours: number; remainingHours: number }`
  - `planSubstitution(dummyHoursByDate: Readonly<Record<string, number>>, targetBookedByDate: Readonly<Record<string, number>>, targetDailyCap: number): SubstitutionPlan`

- [ ] **Step 1: Write the failing test**

Create `src/app/services/substitution.util.spec.ts`:

```ts
import { planSubstitution } from './substitution.util';

describe('planSubstitution', () => {
  it('transfers everything when the target is free', () => {
    const plan = planSubstitution({ '2026-09-01': 8, '2026-09-02': 8 }, {}, 8);
    expect(plan.transfer).toEqual({ '2026-09-01': 8, '2026-09-02': 8 });
    expect(plan.remaining).toEqual({});
    expect(plan.transferredHours).toBe(16);
    expect(plan.remainingHours).toBe(0);
  });

  it('caps each day at the target-s remaining capacity and leaves the rest', () => {
    // A 2.5-FTE dummy day (20h) against an 8h person who is free: 8 move, 12 stay.
    const plan = planSubstitution({ '2026-09-01': 20 }, {}, 8);
    expect(plan.transfer).toEqual({ '2026-09-01': 8 });
    expect(plan.remaining).toEqual({ '2026-09-01': 12 });
    expect(plan.transferredHours).toBe(8);
    expect(plan.remainingHours).toBe(12);
  });

  it('accounts for what the target has already booked that day', () => {
    const plan = planSubstitution({ '2026-09-01': 8 }, { '2026-09-01': 6 }, 8);
    expect(plan.transfer).toEqual({ '2026-09-01': 2 });
    expect(plan.remaining).toEqual({ '2026-09-01': 6 });
  });

  it('transfers nothing on a day the target is already full', () => {
    const plan = planSubstitution({ '2026-09-01': 8 }, { '2026-09-01': 8 }, 8);
    expect(plan.transfer).toEqual({});
    expect(plan.remaining).toEqual({ '2026-09-01': 8 });
    expect(plan.transferredHours).toBe(0);
  });

  it('treats an over-booked target as having no room, never negative room', () => {
    const plan = planSubstitution({ '2026-09-01': 4 }, { '2026-09-01': 12 }, 8);
    expect(plan.transfer).toEqual({});
    expect(plan.remaining).toEqual({ '2026-09-01': 4 });
  });

  it('handles an empty dummy month', () => {
    expect(planSubstitution({}, { '2026-09-01': 4 }, 8)).toEqual({
      transfer: {}, remaining: {}, transferredHours: 0, remainingHours: 0,
    });
  });

  it('ignores non-finite hours rather than poisoning the totals', () => {
    const plan = planSubstitution({ '2026-09-01': Number.NaN, '2026-09-02': 8 }, {}, 8);
    expect(plan.transfer).toEqual({ '2026-09-02': 8 });
    expect(plan.transferredHours).toBe(8);
  });

  it('transfers nothing when the cap is not usable', () => {
    // 0 / NaN / negative all mean "no usable cap" elsewhere in the codebase.
    expect(planSubstitution({ '2026-09-01': 8 }, {}, 0).transfer).toEqual({});
    expect(planSubstitution({ '2026-09-01': 8 }, {}, Number.NaN).transfer).toEqual({});
    expect(planSubstitution({ '2026-09-01': 8 }, {}, -8).transfer).toEqual({});
  });

  it('rounds to two decimals so repeated splits do not drift', () => {
    const plan = planSubstitution({ '2026-09-01': 10 }, { '2026-09-01': 2.005 }, 8);
    expect(plan.transfer['2026-09-01']).toBe(6);
    expect(plan.remaining['2026-09-01']).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/ng test`
Expected: FAIL — cannot resolve `./substitution.util`.

- [ ] **Step 3: Write the implementation**

Create `src/app/services/substitution.util.ts`:

```ts
/**
 * Pure substitution arithmetic (C2).
 *
 * A dummy can be planned beyond 1 FTE (C1); a person cannot — the daily
 * capacity gate (B1) stops them at their contracted hours. So handing a dummy's
 * work to someone is never a bulk move: each day transfers only what that
 * person can still absorb, and the rest stays on the dummy for the next
 * substitution. Partial substitution therefore falls out of the capacity
 * constraint instead of needing a quota field — which is exactly how the RPT
 * manual describes it (§4.2.1: "le ore che vengono decurtate restano da
 * sostituire nel dummy con una eventuale risorsa aggiuntiva").
 *
 * Side-effect free and SSR-safe: no clock, no I/O.
 */

/** Hours are rounded to 2 decimals, as everywhere else money-and-hours are stored. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface SubstitutionPlan {
  /** Hours to move to the target, per ISO date. Days transferring 0 are absent. */
  transfer: Record<string, number>;
  /** Hours that stay on the dummy, per ISO date. Days keeping 0 are absent. */
  remaining: Record<string, number>;
  transferredHours: number;
  remainingHours: number;
}

/**
 * Split a dummy month's per-day hours between what `target` can absorb and what
 * stays behind.
 *
 * `targetDailyCap` is the person's own ceiling (1 FTE — `dailyCapFor('internal', …)`),
 * and `targetBookedByDate` is what they ALREADY hold that day across every
 * assignment, so the room left is `cap - booked`, never negative. A cap that is
 * not usable (0, NaN, negative) transfers nothing: the same convention the
 * allocation gate uses, and refusing to guess is safer than moving hours onto a
 * resource whose limit we do not know.
 */
export function planSubstitution(
  dummyHoursByDate: Readonly<Record<string, number>>,
  targetBookedByDate: Readonly<Record<string, number>>,
  targetDailyCap: number,
): SubstitutionPlan {
  const capUsable = Number.isFinite(targetDailyCap) && targetDailyCap > 0;
  const transfer: Record<string, number> = {};
  const remaining: Record<string, number> = {};
  let transferredHours = 0;
  let remainingHours = 0;

  for (const [date, rawHours] of Object.entries(dummyHoursByDate)) {
    const hours = Number.isFinite(rawHours) ? rawHours : 0;
    if (hours <= 0) continue;

    const booked = Number.isFinite(targetBookedByDate[date]) ? targetBookedByDate[date] : 0;
    const room = capUsable ? Math.max(0, round2(targetDailyCap - booked)) : 0;
    const moved = round2(Math.min(hours, room));
    const left = round2(hours - moved);

    if (moved > 0) { transfer[date] = moved; transferredHours += moved; }
    if (left > 0) { remaining[date] = left; remainingHours += left; }
  }

  return { transfer, remaining, transferredHours: round2(transferredHours), remainingHours: round2(remainingHours) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/ng test`
Expected: PASS (492 existing + the new cases, every existing suite still green).

- [ ] **Step 5: Commit**

```bash
git add src/app/services/substitution.util.ts src/app/services/substitution.util.spec.ts
git commit -m "feat(c2): pure substitution arithmetic (per-day transfer capped by the target's remaining capacity)"
```

---

### Task 2: The back-link columns

**Files:**
- Modify: `src/app/services/api.service.ts` (`AssignmentMonth`, ~line 139)
- Modify: `src/db/schema.ts` (the `assignmentMonths` table)
- Create: `drizzle/0012_*.sql` (generated)

**Interfaces:**
- Produces: `AssignmentMonth.replacedFromAssignmentMonthId?: string` and `AssignmentMonth.replacedHours?: number`, with the two matching nullable columns.

- [ ] **Step 1: Extend the canonical type**

In `src/app/services/api.service.ts`, inside `AssignmentMonth`:

```ts
  /**
   * C2 — the dummy month this month's hours came from, while a substitution is
   * pending. Transient: written when the hours are transferred, cleared when the
   * decision resolves (a rejection returns them all, an approval returns only
   * what the approver trimmed). A month without it is an ordinary month.
   */
  replacedFromAssignmentMonthId?: string;
  /**
   * C2 — how many hours that substitution moved. NOT derivable at decision time:
   * the approver may have trimmed the month before approving, so the original
   * figure is no longer readable anywhere, and the give-back is
   * `replacedHours - hoursStillOnTheMonth`. Written and cleared together with
   * the back-link above.
   */
  replacedHours?: number;
```

- [ ] **Step 2: Add the columns**

In `src/db/schema.ts`, inside the `assignmentMonths` table, after `approverNote`:

```ts
    // C2: back-link to the dummy month a substitution took these hours from, and
    // how many hours it moved. Both nullable and transient — written together at
    // transfer time, cleared together when the decision resolves.
    replacedFromAssignmentMonthId: text('replaced_from_assignment_month_id'),
    replacedHours: doublePrecision('replaced_hours'),
```

Declare it as a plain `text` column, NOT a Drizzle `.references()` self-FK: the row it points at is legitimately deleted while this one lives on (deleting a dummy assignment removes its month rows, and that must not cascade into a person's month or fail her decision). The lifecycle rule in §5.6 of the spec — a missing dummy row makes the return a recorded no-op — depends on this being a soft reference. Say so in the comment.

- [ ] **Step 3: Generate the migration**

Run: `./node_modules/.bin/drizzle-kit generate`
Expected: `drizzle/0012_*.sql` with a single additive `ADD COLUMN`. Read it and confirm there is no constraint and no backfill. If drizzle-kit asks an interactive question, stop and report NEEDS_CONTEXT.

- [ ] **Step 4: Run the gates**

Run: `./node_modules/.bin/ng test`, then `./node_modules/.bin/ng build`
Expected: PASS / success.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/api.service.ts src/db/schema.ts drizzle/
git commit -m "feat(c2): back-link column from a substituted month to its dummy month"
```

---

### Task 3: The substitution endpoint (one month)

**Files:**
- Modify: `src/server.ts` — a transfer helper next to the allocation endpoint, the new route, and the RBAC rule in the mutation `rules` array
- Modify: `src/app/services/api.service.ts` — the request/response types and the client method
- Modify: `scripts/smoke-api.mjs` — a new `checkDummySubstitution()` section

**Interfaces:**
- Consumes: `planSubstitution` (Task 1); `replacedFromAssignmentMonthId` (Task 2); the existing `kindOf`, `dailyCapFor`, `resolveBaseCap`, `sumHoursByDate`, `monthRowId`, `ensureAssignmentMonth`, `refreshDerivedAssignmentStatus`, `createAllocationApproval`, `withdrawAllocationApproval`, `autoApprovesAllocation`.
- Produces:
  - `POST /assignment-months/:id/substitute`, body `{ targetResourceId: string; applyToRemainingMonths?: boolean }`
  - ```ts
    export interface SubstitutionMonthOutcome {
      month: string; transferredHours: number; remainingHours: number;
      targetAssignmentMonthId?: string; status?: AssignmentMonth['status']; skipped?: string;
      /** True when the transfer demoted work the target already had approved that month. */
      demotedExistingWork?: boolean;
    }
    export interface SubstitutionResult { targetResourceId: string; targetResourceName: string; outcomes: SubstitutionMonthOutcome[] }
    ```
  - `ApiService.substituteDummyMonth(assignmentMonthId, targetResourceId, applyToRemainingMonths?)`
  - `async function transferDummyMonth(req, dummyRow, target, targetBaseCap): Promise<SubstitutionMonthOutcome>` (server-internal; Task 4 calls it in a loop)

- [ ] **Step 1: Write the failing smoke assertions**

In `scripts/smoke-api.mjs`, add `checkDummySubstitution()`, registered in `main()` with its own try/catch (mirror `checkResourceKinds`). Build every fixture inside the section — earlier sections have mutated the seeded data. The essential shape:

```js
/**
 * C2 — handing a dummy's hours to a real person. The transfer is capped by what
 * that person can absorb, so a multi-FTE dummy needs more than one substitution.
 */
async function checkDummySubstitution() {
  // Fixtures: a dummy booked at 2 FTE on one working day of an open month, and
  // an internal person who is free that day. Create both, plus a request and
  // assignments, exactly as checkResourceKinds does.
  // …

  const sub = await req('POST', `/assignment-months/${dummyMonthId}/substitute`, {
    body: { targetResourceId: personId },
  });
  check('C2 substitution accepted', sub.status === 200, `status=${sub.status} err=${sub.body?.error}`);
  const outcome = (sub.body?.outcomes || [])[0];
  check('C2 the person absorbs one FTE', outcome?.transferredHours === 8, `transferred=${outcome?.transferredHours}`);
  check('C2 the rest stays on the dummy', outcome?.remainingHours === 8, `remaining=${outcome?.remainingHours}`);

  const dummyAfter = await req('GET', `/assignments/${dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
  const dummyDay = (dummyAfter.body.days || []).find(d => d.date === DAY);
  check('C2 the dummy day is reduced, not cleared', dummyDay?.hours === 8, `hours=${dummyDay?.hours}`);

  const personAlloc = await req('GET', `/assignments/${outcome.targetAssignmentMonthId.split(':')[0]}/allocation?from=${MONTH}&to=${MONTH}`);
  const personMonth = (personAlloc.body.months || [])[0];
  check('C2 the person-s month awaits approval', personMonth?.status === 'Requested', `status=${personMonth?.status}`);
  check('C2 the month is linked back to the dummy', personMonth?.replacedFromAssignmentMonthId === dummyMonthId, `link=${personMonth?.replacedFromAssignmentMonthId}`);

  const notDummy = await req('POST', `/assignment-months/${internalMonthId}/substitute`, { body: { targetResourceId: personId } });
  check('C2 substituting a non-dummy month is refused', notDummy.status === 400, `status=${notDummy.status}`);

  const badTarget = await req('POST', `/assignment-months/${dummyMonthId}/substitute`, { body: { targetResourceId: otherDummyId } });
  check('C2 a non-internal target is refused', badTarget.status === 400, `status=${badTarget.status}`);

  const saturated = await req('POST', `/assignment-months/${dummyMonthId}/substitute`, { body: { targetResourceId: personId } });
  check('C2 a saturated target transfers nothing but does not error', saturated.status === 200 && (saturated.body.outcomes || [])[0]?.transferredHours === 0, `status=${saturated.status}`);
}
```

Fill in the fixture ids from what you create. Use non-self-managing headers where a real approval must be opened: the suite's default identity is `X-User-Id: 1` / admin, and resource `1`'s manager is `'1'`, so that identity auto-approves its own proposals.

- [ ] **Step 2: Run the smoke test to verify it fails**

Build, start a fresh server on 4173, run the suite. Expected: the new checks FAIL with 404 — the route is not mounted.

- [ ] **Step 3: Implement the per-month transfer helper**

In `src/server.ts`, next to the allocation endpoint:

```ts
/**
 * Move ONE dummy month's hours to `target`, as far as that person can absorb
 * them. Returns what moved and what stayed; transferring zero is a legitimate
 * outcome (the target is full that month), not an error — it tells the caller
 * another person is needed.
 *
 * CONCURRENCY: touches TWO resources, so it takes both `res:` locks — in
 * LEXICOGRAPHIC ORDER OF THE RESOURCE IDS, never "dummy first". Two crossing
 * substitutions would otherwise take them in opposite orders and deadlock. The
 * approval I/O and the month status write stay OUTSIDE both locks, as the rest
 * of this file requires, and the aggregate recompute runs last, best-effort.
 */
async function transferDummyMonth(
  req: Request,
  dummyRow: AssignmentMonth,
  dummyAssig: Assignment,
  target: Resource,
  targetBaseCap: number,
): Promise<SubstitutionMonthOutcome> {
  const month = dummyRow.month;

  // The person's own ceiling: always 1 FTE — dailyCapFor is kind-aware and the
  // target is validated `internal` by the caller.
  const cap = dailyCapFor(kindOf(target), targetBaseCap);

  // The target's assignment on the SAME request; created if absent. Created
  // 'Draft': status is derived, never client-set (C1/B3).
  const assignments = await repos.assignments.list();
  let targetAssig = assignments.find(a => a.resourceId === target.id && a.requestId === dummyAssig.requestId);
  if (targetAssig === undefined) {
    targetAssig = await repos.assignments.create({
      id: newId(), requestId: dummyAssig.requestId, resourceId: target.id,
      assignedHours: 0, status: 'Draft',
    } as Assignment);
  }

  const [firstId, secondId] = [dummyAssig.resourceId, target.id].sort();
  const plan = await withLock(`res:${firstId}`, () => withLock(`res:${secondId}`, async (): Promise<SubstitutionPlan> => {
    const allDays = await repos.assignmentDays.list();
    const dummyDays = allDays.filter(d => d.assignmentId === dummyAssig.id && monthOf(d.date) === month);
    const dummyByDate = sumHoursByDate(dummyDays);

    // What the target already holds on those days, across ALL their assignments.
    const targetIds = new Set(assignments.filter(a => a.resourceId === target.id).map(a => a.id).concat(targetAssig!.id));
    const targetBooked = sumHoursByDate(allDays.filter(d => targetIds.has(d.assignmentId) && dummyByDate[d.date] !== undefined));

    const p = planSubstitution(dummyByDate, targetBooked, cap);

    for (const [date, hours] of Object.entries(p.transfer)) {
      // Add to the target (merging with anything already booked that day on THIS
      // assignment), then reduce the dummy — a day that reaches zero is removed,
      // the same rule the allocation endpoint applies.
      const targetDayId = `${targetAssig!.id}:${date}`;
      const existing = await repos.assignmentDays.get(targetDayId);
      const merged = Math.round(((existing?.hours ?? 0) + hours) * 100) / 100;
      if (existing) await repos.assignmentDays.update(targetDayId, { hours: merged });
      else await repos.assignmentDays.create({ id: targetDayId, assignmentId: targetAssig!.id, date, hours: merged } as AssignmentDay);

      const dummyDayId = `${dummyAssig.id}:${date}`;
      const left = p.remaining[date] ?? 0;
      if (left > 0) await repos.assignmentDays.update(dummyDayId, { hours: left });
      else await repos.assignmentDays.remove(dummyDayId);
    }

    await recomputeAssignedHours(dummyAssig.id);
    await recomputeAssignedHours(targetAssig!.id);
    return p;
  }));

  if (plan.transferredHours === 0) {
    return { month, transferredHours: 0, remainingHours: plan.remainingHours, skipped: 'the target has no capacity left in this month' };
  }

  // OUTSIDE both locks: the month row, its approval and the notes.
  const targetRow = await ensureAssignmentMonth(targetAssig.id, month);
  const selfManaged = await autoApprovesAllocation(req, target.id);
  await withdrawAllocationApproval(targetRow.approvalId, 'superseded by substitution');

  const note = `Takes over from ${(await repos.resources.get(dummyAssig.resourceId))?.name ?? 'a placeholder'} — ${month}`;
  const plannerNote = targetRow.plannerNote ? `${targetRow.plannerNote}\n${note}` : note;

  if (selfManaged) {
    // No decision will follow, so there is nothing to give back later: close the
    // link immediately rather than leaving it dangling forever.
    await repos.assignmentMonths.update(targetRow.id, {
      status: 'Allocated', approvalId: null as unknown as undefined,
      replacedFromAssignmentMonthId: null as unknown as undefined,
      replacedHours: null as unknown as undefined, plannerNote,
    } as Partial<AssignmentMonth>);
  } else {
    const approvalId = await createAllocationApproval(req, targetAssig, targetRow.id);
    await repos.assignmentMonths.update(targetRow.id, {
      status: 'Requested', approvalId,
      replacedFromAssignmentMonthId: dummyRow.id, replacedHours: plan.transferredHours,
      plannerNote,
    } as Partial<AssignmentMonth>);
  }
```

**One consequence to surface, not to hide.** If the target already held `Allocated` hours on that request in that month, adding more demotes the month back to `Requested` — B1/B3's forced re-approval on editing an approved month, which applies here too. That is correct (the approver must see the resulting daily profile, not the previous one), but it means a substitution can put work back into approval that the person had already had confirmed. Say so in the outcome the endpoint returns, so the operator does not discover it afterwards: add a `demotedExistingWork?: boolean` to `SubstitutionMonthOutcome`, set when the target month was `Allocated` before the transfer, and cover it with a smoke check.

  // The dummy's own month records who took what.
  const dummyNote = `${target.name} took ${plan.transferredHours}h for ${month}`;
  await repos.assignmentMonths.update(dummyRow.id, {
    plannerNote: dummyRow.plannerNote ? `${dummyRow.plannerNote}\n${dummyNote}` : dummyNote,
  });

  await refreshDerivedAssignmentStatus(dummyAssig.id);
  await refreshDerivedAssignmentStatus(targetAssig.id);

  const fresh = await repos.assignmentMonths.get(targetRow.id);
  return {
    month, transferredHours: plan.transferredHours, remainingHours: plan.remainingHours,
    targetAssignmentMonthId: targetRow.id, status: fresh?.status,
  };
}
```

`recomputeAssignedHours(assignmentId)` may not exist as a named helper — the allocation endpoint rewrites `assignedHours` inline from the remaining day rows. Extract that inline block into a small helper and call it from both places rather than duplicating the sum; say in your report that you did.

- [ ] **Step 4: Mount the route and the RBAC rule**

```ts
// C2 — hand a dummy's month to a real person. `:id` is the DUMMY's month row.
apiRouter.post('/assignment-months/:id/substitute', async (req, res) => {
  const dummyRow = await repos.assignmentMonths.get(req.params.id);
  if (dummyRow === undefined) { res.status(404).json({ error: 'Not found' }); return; }

  const body = pick<{ targetResourceId: string; applyToRemainingMonths?: boolean }>(req.body, ['targetResourceId', 'applyToRemainingMonths']);
  if (typeof body.targetResourceId !== 'string' || body.targetResourceId === '') {
    res.status(400).json({ error: 'targetResourceId is required' }); return;
  }

  const dummyAssig = await repos.assignments.get(dummyRow.assignmentId);
  if (dummyAssig === undefined) { res.status(400).json({ error: 'the month row references a missing assignment' }); return; }
  const dummyResource = await repos.resources.get(dummyAssig.resourceId);
  if (kindOf(dummyResource) !== 'dummy') {
    res.status(400).json({ error: 'only a dummy month can be substituted' }); return;
  }

  const target = await repos.resources.get(body.targetResourceId);
  if (target === undefined) { res.status(400).json({ error: 'targetResourceId must reference an existing resource' }); return; }
  if (kindOf(target) !== 'internal') { res.status(400).json({ error: 'a dummy can only be replaced by an internal resource' }); return; }
  if (target.terminationDate) { res.status(400).json({ error: 'the target resource is terminated' }); return; }
  if (target.id === dummyAssig.resourceId) { res.status(400).json({ error: 'a resource cannot replace itself' }); return; }

  const period = await repos.planningPeriods.get(dummyRow.month);
  if (period?.status !== 'Open') { res.status(403).json({ error: 'month is not open for planning' }); return; }

  const targetBaseCap = await resolveBaseCap(target);
  const outcome = await transferDummyMonth(req, dummyRow, dummyAssig, target, targetBaseCap);

  // Aggregates last, best-effort — the transfer has already committed.
  try {
    await withLock(`res:${dummyAssig.resourceId}`, () => recomputeResourceUtilization(dummyAssig.resourceId));
    await withLock(`res:${target.id}`, () => recomputeResourceUtilization(target.id));
    await withLock(`req:${dummyAssig.requestId}`, () => recomputeRequestStaffing(dummyAssig.requestId));
  } catch { /* aggregates self-heal on the next mutation */ }

  res.json({ targetResourceId: target.id, targetResourceName: target.name, outcomes: [outcome] } as SubstitutionResult);
});
```

Add the RBAC rule to the mutation `rules` array, next to the `/allocation-approvals` one:

```ts
    // C2: substituting a dummy is an approver action — the same roles that decide allocations.
    { test: p => p.startsWith('/assignment-months'), roles: ['resource-manager', 'delivery-executive', 'admin'] },
```

Then add the two envelope types and the client method to `api.service.ts`, following `decideAllocationMonths` for the `HttpParams`-free POST idiom.

- [ ] **Step 5: Re-run the smoke test to verify it passes**

Rebuild, fresh server, re-run. Expected: the new checks PASS and all 198 pre-existing ones still pass.

- [ ] **Step 6: Run the remaining gates and commit**

```bash
./node_modules/.bin/ng test && ./node_modules/.bin/ng lint && ./node_modules/.bin/ng build
git add src/server.ts src/app/services/api.service.ts scripts/smoke-api.mjs
git commit -m "feat(c2): substitute a dummy month with an internal resource, capped by their capacity"
```

---

### Task 4: "Apply to all remaining months"

**Files:**
- Modify: `src/server.ts` — the substitution handler
- Modify: `scripts/smoke-api.mjs` — extend `checkDummySubstitution()`

**Interfaces:**
- Consumes: `transferDummyMonth` (Task 3).
- Produces: `applyToRemainingMonths: true` returns one `SubstitutionMonthOutcome` per month attempted.

- [ ] **Step 1: Write the failing smoke assertions**

Append to `checkDummySubstitution()`: build a dummy booked across three consecutive open months, substitute the FIRST with `applyToRemainingMonths: true`, and assert one outcome per month, each with its own `targetAssignmentMonthId`, plus that the dummy's later months are reduced too. Add a case where one of the later months is CLOSED (`PUT /planning-periods/:month {status:'Closed'}`) and assert it comes back with a `skipped` reason while the others still transfer — then reopen it.

- [ ] **Step 2: Run the smoke test to verify it fails**

Expected: only one outcome is returned; the later months are untouched.

- [ ] **Step 3: Implement the iteration**

In the handler, after the single-month transfer, when `applyToRemainingMonths` is true: list the dummy assignment's month rows with `month > dummyRow.month` that still carry hours, sort them ascending, and run `transferDummyMonth` for each. A month whose planning period is not `Open` is **skipped with a reason**, not an error — it must not abort the months that follow. Collect every outcome into `outcomes`, and run the aggregate recompute once at the end rather than per month.

- [ ] **Step 4: Re-run the smoke test to verify it passes**

Expected: all checks pass, 198 pre-existing intact.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(c2): apply a substitution to the dummy's remaining months"
```

---

### Task 5: Give the hours back when the decision lands

**Files:**
- Modify: `src/server.ts` — `applyAllocationDecision`, the month branch (~line 3696)
- Modify: `scripts/smoke-api.mjs` — extend `checkDummySubstitution()`

**Interfaces:**
- Consumes: `replacedFromAssignmentMonthId` (Task 2).

**This is the most delicate task in the plan.** `applyAllocationDecision` is where B3's Segregation of Duties, step enforcement and audit meet. Add ONE branch; do not restructure the existing ones. The branch runs AFTER the month's own status write and audit entry, so a failure in the give-back can never make the decision itself disappear.

- [ ] **Step 1: Write the failing smoke assertions**

Append to `checkDummySubstitution()`:

```js
  // A rejection gives every transferred hour back to the dummy.
  const dec = await req('POST', '/allocation-approvals/decide', {
    body: { items: [{ assignmentMonthId: substitutedMonthId, decision: 'Rejected', note: 'not available after all' }] },
  });
  check('C2 rejection decided', (dec.body?.results || [])[0]?.status === 'Rejected', `res=${JSON.stringify(dec.body?.results)}`);

  const dummyBack = await req('GET', `/assignments/${dummyAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
  check('C2 the dummy is whole again after a rejection',
    (dummyBack.body.days || []).find(d => d.date === DAY)?.hours === 16, `hours=${(dummyBack.body.days || []).find(d => d.date === DAY)?.hours}`);
  const personBack = await req('GET', `/assignments/${personAssignmentId}/allocation?from=${MONTH}&to=${MONTH}`);
  check('C2 the person keeps nothing from a rejected substitution',
    (personBack.body.days || []).every(d => d.date !== DAY), 'the day is still booked on the person');
  check('C2 the back-link is cleared', !('replacedFromAssignmentMonthId' in ((personBack.body.months || [])[0] ?? {})), 'link still present');
```

Add the second half too: substitute again, have the approver **reduce** the person's hours through `PUT /assignments/:id/allocation` before approving, then approve, and assert the dummy got back exactly the trimmed difference while the person keeps the approved remainder.

- [ ] **Step 2: Run the smoke test to verify it fails**

Expected: after a rejection the person's day is still booked and the dummy is still short — nothing gives the hours back yet.

- [ ] **Step 3: Implement the branch**

In `applyAllocationDecision`'s month branch, after `rowAfter` is written and the audit entry is attempted, and before the `deferAggregates` return:

```ts
  // C2 — SUBSTITUTION GIVE-BACK. A month that arrived by substitution carries a
  // link to the dummy month it came from. The decision closes that link:
  //   - Rejected: every transferred hour goes back to the dummy and this month
  //     is emptied — the person never took the work.
  //   - Approved: only the hours the approver TRIMMED go back; the rest is now
  //     genuinely hers. `assignedHours` at decision time may be lower than what
  //     was transferred, because correcting the hours before approving is a
  //     first-class approver power (C1 spec, decision 2).
  // Best-effort and last, exactly like the recompute: the decision and the month
  // transition have already committed, and a give-back failure must not 500 a
  // decision that landed. A dummy row that no longer exists (its assignment was
  // deleted) makes this a recorded no-op, not an error.
  if (row.replacedFromAssignmentMonthId) {
    try {
      await returnHoursToDummy(req, row, rowAfter, decided);
    } catch { /* give-back is best-effort; the decision already committed */ }
  }
```

Write `returnHoursToDummy` next to `transferDummyMonth`, sharing its day-merge logic: read the person's day rows for that month, compute what to give back (all of them on a rejection; on an approval, only the difference between the hours recorded at transfer time and the hours present now), add those hours back to the dummy's day rows, remove or reduce the person's, clear `replacedFromAssignmentMonthId` with an explicit `null`, and refresh both assignments' derived state.

**How much goes back, precisely.** On a rejection: every hour the person holds for that month on that assignment. On an approval: `replacedHours − hoursStillOnTheMonth`, where `replacedHours` is the figure Task 2's column recorded at transfer time and `hoursStillOnTheMonth` is the sum of the person's day rows for that month now. If the difference is **≤ 0** — the approver left everything, or added hours of their own — nothing goes back: the extra is a new allocation, not part of the substitution.

Distribute the returned hours across the dummy's days **proportionally to what was taken from each day**, reconstructing that split with `planSubstitution`'s own arithmetic rather than a second implementation: give back day by day, capped at what was transferred from that day. A day the dummy no longer has (its row was deleted because it went to zero) is recreated.

Clear BOTH `replacedFromAssignmentMonthId` and `replacedHours` with explicit `null`s in the same patch — the documented "clear to absent" value on both adapters — so a decided month can never be mistaken for a pending substitution.

- [ ] **Step 4: Re-run the smoke test to verify it passes**

Expected: both give-back scenarios pass; the 198 pre-existing checks and every B3 approval check still pass.

- [ ] **Step 5: Run all gates and commit**

```bash
./node_modules/.bin/ng test && ./node_modules/.bin/ng lint && ./node_modules/.bin/ng build
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(c2): return substituted hours to the dummy when the decision lands"
```

---

### Task 6: The Substitute action in the approval modal

**Files:**
- Modify: `src/app/allocation-approvals/approval-modal.component.ts` (~527 lines) + `.spec.ts`
- Modify: `src/app/allocation-approvals/allocation-approvals.component.ts` if the modal needs the resource list passed in

**Interfaces:**
- Consumes: `ApiService.substituteDummyMonth` (Task 3); `AllocationApprovalRow.kind` (C1).

- [ ] **Step 1: Write the failing component test**

In `approval-modal.component.spec.ts`, following the file's existing `setup()` helper:

```ts
it('offers Substitute only on a dummy line', () => {
  const { fixture } = setup([{ ...ROW, kind: 'dummy' }]);
  expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substitute"]')).not.toBeNull();
});

it('does not offer Substitute on an internal line', () => {
  const { fixture } = setup([{ ...ROW, kind: 'internal' }]);
  expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substitute"]')).toBeNull();
});

it('sends the chosen person and the remaining-months flag', () => {
  const { fixture, substituteDummyMonth } = setup([{ ...ROW, kind: 'dummy' }]);
  fixture.componentInstance.openSubstitute(ROW.items[0]);
  fixture.componentInstance.chooseTarget('r9');
  fixture.componentInstance.applyToRemaining.set(true);
  fixture.detectChanges();
  (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-test="substitute-confirm"]')!.click();

  expect(substituteDummyMonth).toHaveBeenCalledWith(ROW.items[0].assignmentMonthId, 'r9', true);
});

it('shows what moved and what stayed', async () => {
  // substituteDummyMonth stub resolves with one outcome: 8 transferred, 8 remaining
  // → assert both numbers are rendered in [data-test="substitute-outcome"].
});
```

Extend the spec's `ApiService` stub with `substituteDummyMonth` and `getResources` (the search reads the resource list; the component must filter to internal, non-terminated).

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — no such control.

- [ ] **Step 3: Implement**

On a line whose row `kind` is `'dummy'`, render a *Substitute* button (`data-test="substitute"`). It opens a panel listing internal, non-terminated resources with a text filter over name and role and an organization select **pre-set to the dummy's organization and clearable**. Selecting a person shows a summary — who, which project, which month — the "apply to all remaining months" checkbox, and a confirm button (`data-test="substitute-confirm"`). After the call, render the outcome per month (`data-test="substitute-outcome"`): hours moved and hours left, so the operator sees immediately whether another person is needed. Emit `decided` so the page reloads the feed.

Copy in English. Reuse the modal's existing panel styling rather than inventing markup, and the `ResourceKindBadgeComponent` where a kind is shown.

- [ ] **Step 4: Run the tests, then verify in the browser**

`./node_modules/.bin/ng test`, `ng lint`, `ng build`. Then with a fresh built server: open `/allocation-approvals`, find the seeded dummy, substitute an internal person, and confirm the outcome shows the split and the feed refreshes. Say concretely what you saw.

- [ ] **Step 5: Commit**

```bash
git add src/app/allocation-approvals
git commit -m "feat(c2): Substitute action, person search and outcome in the approval modal"
```

---

### Task 7: Highlight months that arrived by substitution

**Files:**
- Modify: `src/app/allocation-calendar/allocation-calendar.component.ts` + `.spec.ts`
- Modify: `src/server.ts` — include `replacedFromAssignmentMonthId` in the allocation envelope's month rows if it is not already there (they are whole `AssignmentMonth` rows, so verify rather than assume)

- [ ] **Step 1: Write the failing component test**

```ts
it('marks a month that arrived by substitution', async () => {
  const { fixture } = setup('internal', { months: [{ id: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', replacedFromAssignmentMonthId: 'A9:2026-09' }] });
  await flush(fixture);
  expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substituted-month"]')).not.toBeNull();
});

it('leaves an ordinary month unmarked', async () => {
  const { fixture } = setup('internal', { months: [{ id: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested' }] });
  await flush(fixture);
  expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substituted-month"]')).toBeNull();
});
```

Adapt `setup` to the signature the file's spec already uses (Task 8 of C1 created it).

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL — nothing renders the marker.

- [ ] **Step 3: Implement**

In the month header, when the month row carries `replacedFromAssignmentMonthId`, render a marker (`data-test="substituted-month"`) reading *Taken over from a placeholder* — the manual's "leggera evidenziazione". Keep it a text label, not colour alone. This component has a history of reactivity defects: read the row through the existing month-rows signal, do not add a `linkedSignal` over the loaded data.

- [ ] **Step 4: Run the tests and commit**

```bash
./node_modules/.bin/ng test && ./node_modules/.bin/ng lint
git add src/app/allocation-calendar src/server.ts
git commit -m "feat(c2): flag months that arrived by substitution in the calendar"
```

---

### Task 8: Consumer sweep, docs, full verification

**Files:**
- Modify: `docs/roles-and-permissions.md`, `docs/architecture/03-backend-and-data.md`
- Modify: whatever the sweep turns up

- [ ] **Step 1: Do the sweep C1 taught us to do**

C1 shipped four screens that kept their old behaviour because no task owned them. Before closing C2, grep every consumer of `assignmentDays` and `assignmentMonths` — `src/server.ts`, `capacity.util`, `allocation-month.util`, the reporting and forecast surfaces, `dashboard.component.ts`, `app.ts` — and for each one decide, explicitly, whether a substitution changes what it should show. Record the decision for every consumer in your report, including the ones you decide need nothing. Fix what needs fixing; if something needs a product call rather than a mechanical change, report it instead of guessing.

- [ ] **Step 2: Update the docs**

`docs/roles-and-permissions.md`: the new `POST /assignment-months/:id/substitute` and its rule (`resource-manager, delivery-executive, admin`). `docs/architecture/03-backend-and-data.md`: the new column and the fact that it is a soft self-reference, deliberately not an FK.

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

- [ ] **Step 4: Postgres parity run**

Create a FRESH database, start the built server against it with `DATABASE_URL`, confirm migration `0012` applied, run the same smoke suite, drop the database. Report the evidence. If Docker is unavailable, say so explicitly rather than skipping silently.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(c2): substitution endpoint in the RBAC reference and the entity catalogue"
```

---

## Verification Checklist (before merge)

- [ ] A 2-FTE dummy substituted with one person moves exactly 1 FTE and leaves 1 FTE behind.
- [ ] A saturated target transfers nothing, returns 200, and says why.
- [ ] A rejection returns every transferred hour to the dummy and clears the back-link.
- [ ] An approval after the approver trimmed the hours returns exactly the trimmed difference.
- [ ] A self-managed substitution lands `Allocated` with NO back-link left dangling.
- [ ] Substituting a non-dummy month, or targeting a non-internal resource, is refused with 400.
- [ ] "Apply to all remaining months" skips a closed month with a reason without aborting the rest.
- [ ] The two `res:` locks are taken in lexicographic id order, and no approval I/O happens inside them.
- [ ] Unit, lint, build, live smoke and the Postgres run are all green.
