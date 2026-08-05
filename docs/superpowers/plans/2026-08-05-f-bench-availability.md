# Bench dashboard and 6-month availability (Block F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every internal/subcontractor resource a monthly BENCH/PARTIAL/ALLOCATED state with aging and a 6-month availability date, a separate hiring-demand view for unstaffed dummy placeholders, and retire the stale utilization-scalar bench panel on `/forecast` in favour of this one true source.

**Architecture:** A new pure layer (`bench.util.ts`) reuses the per-resource/per-month hour aggregation already inside `capacity.util.ts`'s `rollupMonthly` (extracted into a shared `hoursByResourceMonth` helper) but repartitions it by `countsTowardDeliveryCapacity` instead of `countsTowardInternalCapacity`, so a subcontractor lands in bench like an internal resource while a dummy never does. A new read-only `GET /bench/monthly` endpoint (bespoke, no mutation, no audit) serves a 6-month rollup fetched over a 9-month window (2 look-back + 6 shown + 1 look-ahead) to a dedicated `/bench` page, and the same aggregate feeds a badge on `/utilization` and a two-number tile on `/dashboard`. `/forecast` and `/forecast/what-if` are retargeted onto the same pure layer (calling it directly, client-side, over two new raw `GET /assignment-days` / `GET /assignment-months` endpoints — root-level, hyphenated, shared with block E's spec) because the What-If sandbox mutates data only in memory and can never round-trip through the server.

**Tech Stack:** Angular 21 (standalone, signals, OnPush), Express 5, Vitest, dependency-free scripts. No schema change, no migration — Block F is pure derivation over `resources`/`assignments`/`assignmentDays`/`assignmentMonths`, exactly like `rollupMonthly` and `arAging`.

**Spec:** `docs/superpowers/specs/2026-08-04-f-bench-availability-design.md` — authoritative. Read the section named in each task. Its closed decisions (numbered in the spec) are not renegotiable here; only the wiring is this plan's own judgment call where the spec left it unstated.

## Global Constraints

- **Displayed precision:** amounts, day/FTE counts and percentages never render with more than **2 decimals** — screens, CSV/JSON exports and chart labels included. `digitsInfo` with `maxFractionDigits ≤ 2`; a `DecimalPipe` with no `digitsInfo` defaults to `1.0-3` and is non-compliant. A bench percentage and an FTE count are exactly where this breaks.
- **The `authReady` pattern:** every `rxResource` keys its **`params` on `auth.authReady()`** and returns an empty default until it flips true. Never snapshot `auth.userId()`/`auth.role()` at field-init — read them reactively inside `computed`/`rxResource` params/getter. `src/app/reporting/reporting.ts` is the reference example. An ungated read 401s in production and latches the view empty forever, and it is invisible in dev because dev trusts demo headers. This repo shipped and fixed that defect twice in the last week.
- **A failed or forbidden read must never render as a zero or as an empty list presented as fact.** Distinguish "none" from "unknown": under a failed read say the data is unavailable and offer a retry; "none" may only be claimed when the reads resolved. Shipped as a defect twice on this repo — a money strip rendered confident zeros for a role denied the underlying read.
- **Error toasts auto-dismiss.** No notification stays on screen indefinitely; errors get their own timeout, longer than normal notifications but finite. Timers are **browser-only** (never in SSR) and manual dismiss keeps working.
- **UI copy is English.** Code, comments and commit messages are English.
- **`src/db/seed.ts` is the single source of truth for seed data**, consumed by both the in-memory and the Postgres adapter — never edit one adapter's data alone.
- **Angular 21 idiom:** standalone components, `OnPush`, `signal()`/`computed()`/`linkedSignal()`, native control flow (`@if`/`@for`/`@switch`), `inject()` in field initializers, lazy `loadComponent` routes.
- **Design system is bespoke, not Material** — `command-*` classes and CSS tokens in `src/styles.css`. Material is used **only** for icons. Where an accent renders as text, use the `-text` (`-700`) token for WCAG AA contrast. Do not invent class names that do not exist in `src/styles.css` — verify each one.
- **Tests are Vitest** via the `@angular/build:unit-test` builder; specs are `*.spec.ts` colocated with source. Commands: `npm test`, `npm run lint`, `npm run build`.

**Traps this repo has already charged for:**
- `[value]` on a `<select>` whose options come from `@for` is **silently dropped**; bind `[selected]` per `<option>` instead.
- `fixture.nativeElement.querySelector<T>()` does not compile in this setup — cast the host once, then `host.querySelector<T>(...)`.
- `whenStable()` hangs while an `rxResource` stream is open — use microtask ticks (`await Promise.resolve()` / `fixture.detectChanges()`) for a still-pending checkpoint.
- A `?? ` treats an explicit `null` as absent — know whether you mean "absent" or "explicitly cleared". (Not exercised by this block's own writes — Block F adds no mutation endpoints — but the raw read endpoints in Task 4 must not accidentally silently coerce a malformed query param.)
- String literals for a discriminant must match the code's exact casing (a `kind: 'allocation'` vs `'Allocation'` mismatch once left an entire check inert with every test green). This block introduces two new discriminants — `BenchState` (`'BENCH' | 'PARTIAL' | 'ALLOCATED'`) and `AvailabilityDate.kind` (`'date' | 'beyond-horizon'`) — spell them exactly, including case, everywhere they are compared.

**Ordering constraint (spec §9, decision 2):** this block retires `/forecast`'s `benchList()`/`BenchEntry` and repoints both `/forecast` and `/forecast/what-if` at `bench.util.ts`. **Task 5 (the retarget) must land before Task 7 (the `/bench` route ships)** — never the reverse, and never both half-done at once. If `/bench` existed first while `/forecast` still read the old `utilization`-scalar heuristic, the two screens could show two different bench numbers for the same person, which is the exact outcome spec decision 5/2 exists to prevent. Tasks 1–4 (seed, pure layer, plumbing) carry no user-visible surface and may land in any internal order relative to each other, but all of them precede Task 5.

---

### Task 1: Seed fixtures for Block F

**Spec:** §11 in full — the fixture table is the authoritative source for every number below. Anchor `from = '2026-04'` (first Open planning period, `src/db/seed.ts:246`), display window `2026-04..2026-09`, fetch window `2026-02..2026-10`.

Working-day counts used below (holidays `2026-12-25`/`2026-01-01` per `src/db/seed.ts:237-240`, neither falling in these windows except where noted): Jan 2 –Mar 15 2026 = 51 working days; Feb 2026 = 20; Mar 2026 = 22; Apr 2026 = 22; May 2026 = 21; Jun 2026 = 22; Jul 2026 = 23; Aug 2026 = 21; Sep 2026 = 22. All new resources use `contractHoursPerDay: 8`, so a "flat 8h/day" assignment's `assignedHours` total is `workingDays × 8`, which `distributeHoursOverWindow` (`src/app/services/calendar.util.ts:59-82`) then spreads back to exactly 8h/day with zero rounding remainder.

**Files:**
- Modify: `src/db/seed.ts` — add 3 resources, 5 requests, 5 assignments (as `assignmentsBase` entries; `assignmentDays`/`assignmentMonths`/`assignments` are derived automatically by `buildAssignmentDays`/`buildAssignmentMonths`, `src/db/seed.ts:267-337`)

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces — later tasks assume these exact ids exist in the seed:
  - Resource `'6'` (existing subco) gains bookings: full Feb–Mar 2026, one 0.4h day in April, nothing after.
  - Resource `'4'` (existing dummy) gains a real Apr–Sep 2026 booking.
  - Resource `'5'` (existing dummy) — **untouched, deliberately**. No seed change.
  - New resource `'7'` (internal, hireDate 2020): full Apr–Sep 2026 booking, nothing beyond.
  - New resource `'8'` (internal, hireDate exactly `2026-04-01`): no booking at all.
  - New resource `'9'` (internal, historical hireDate, terminationDate `2026-03-15`): one real Jan–Mar15 2026 booking.
  - Resources `'1'`/`'2'`/`'3'` (Julie/John/Alice) — untouched; already have no bookings before May 2026, which later tasks rely on as a free sanity check.

- [ ] **Step 1: Add the three new resources**

In `src/db/seed.ts`, inside the `resources` array, immediately before the closing `];` at line 145 (after resource `'6'`):

```ts
  // BLOCK F fixture (design spec §11, row 4): a plain internal resource fully
  // allocated for the whole displayed window (Apr-Sep) with NOTHING booked
  // beyond it. Proves availabilityDate stays 'beyond-horizon' on the LAST
  // shown month even though the look-ahead month (Oct, fetched but never
  // shown) already knows the answer — the two fields deliberately have
  // different data scopes (spec §7).
  { id: '7', name: 'Priya Kapoor', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 3 }], projectRoles: ['Senior Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 100, utilizationPlanned: 100, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2020-01-01', contractHoursPerDay: 8 },
  // BLOCK F fixture (design spec §11, row 5): hireDate IS the '2026-04' anchor
  // month's own start, with NO booking ever. Proves `isActiveInMonth`'s guard
  // truncates the look-back at Feb/Mar (both inactive) instead of reading the
  // absence of earlier months as "idle since forever" — April must bucket B,
  // never D.
  { id: '8', name: 'Marco Belli', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 2 }], projectRoles: ['Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2026-04-01', contractHoursPerDay: 8 },
  // BLOCK F fixture (design spec §11, row 6): terminated mid-March, WITH a real
  // booking inside the fetch window's look-back (Jan-Mar15) — proves the
  // exclusion from every displayed month (Apr-Sep) is the termination gate,
  // not an absence of data that would pass for lack of trying.
  { id: '9', name: 'Elena Rossi', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 2 }], projectRoles: ['Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 100, utilizationPlanned: 100, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2018-01-01', terminationDate: '2026-03-15', contractHoursPerDay: 8 },
```

- [ ] **Step 2: Add the five new requests**

In the `requests` array, immediately before the closing `];` at line 186 (after request `'6'`):

```ts
  // BLOCK F fixtures (design spec §11). staffedEffort === requiredEffort on
  // every one of these so `requestStatusFor` derives 'Fulfilled' (B9 rule),
  // matching the seed's own convention above.
  { id: '7', name: 'Subco Mediolanum - Backend (Feb-Mar)', requiredRole: 'Developer', requiredEffort: 336, staffedEffort: 336, staffedEffortPlanned: 336, status: 'Fulfilled', skills: ['Java'], description: 'Full allocation ahead of Project Alpha ramp-up', startDate: '2026-02-01', endDate: '2026-03-31', requesterId: '1', projectId: '1' },
  { id: '8', name: 'Subco Mediolanum - Ramp-down day', requiredRole: 'Developer', requiredEffort: 0.4, staffedEffort: 0.4, staffedEffortPlanned: 0.4, status: 'Fulfilled', skills: ['Java'], description: 'Single partial day closing out the engagement', startDate: '2026-04-01', endDate: '2026-04-01', requesterId: '1', projectId: '1' },
  { id: '9', name: 'Dummy Senior Developer - Alpha backfill', requiredRole: 'Developer', requiredEffort: 1048, staffedEffort: 1048, staffedEffortPlanned: 1048, status: 'Fulfilled', skills: [], description: 'Placeholder booking pending a real hire', startDate: '2026-04-01', endDate: '2026-09-30', requesterId: '1', projectId: '1' },
  { id: '10', name: 'Project Alpha - Priya full allocation', requiredRole: 'Developer', requiredEffort: 1048, staffedEffort: 1048, staffedEffortPlanned: 1048, status: 'Fulfilled', skills: ['Java'], description: 'Full-time booking through the displayed window', startDate: '2026-04-01', endDate: '2026-09-30', requesterId: '1', projectId: '1' },
  { id: '11', name: 'Project Alpha - Elena (pre-termination)', requiredRole: 'Developer', requiredEffort: 408, staffedEffort: 408, staffedEffortPlanned: 408, status: 'Fulfilled', skills: ['Java'], description: 'Work booked before her termination date', startDate: '2026-01-01', endDate: '2026-03-15', requesterId: '1', projectId: '1' },
```

- [ ] **Step 3: Add the five new assignments to `assignmentsBase`**

In `assignmentsBase` (the `Omit<Assignment, 'status'>[]` array), immediately before the closing `];` at line 229 (after assignment `'6'`):

```ts
  // BLOCK F fixtures (design spec §11) — see the requests above for context.
  // Resource '6' (subco): full 8h/day Feb-Mar, then a single 0.4h day in
  // April and nothing after. 336 = 42 working days (20 Feb + 22 Mar) × 8h;
  // distributeHoursOverWindow spreads it back to exactly 8h/day, no remainder.
  { id: '7', requestId: '7', resourceId: '6', assignedHours: 336, startDate: '2026-02-01', endDate: '2026-03-31', allocationPct: 100 },
  // Deliberately 0.4h — rounds to "0.00%" of April's ~176h target in any
  // display, but is NOT zero: a genuine (if tiny) booking, pinning the
  // BENCH-vs-PARTIAL boundary at exactly 0 (design spec §3).
  { id: '8', requestId: '8', resourceId: '6', assignedHours: 0.4, startDate: '2026-04-01', endDate: '2026-04-01', allocationPct: 1 },
  // Resource '4' (dummy): flat 8h/day for the whole displayed window.
  // 1048 = 131 working days (22+21+22+23+21+22, Apr..Sep) × 8h.
  { id: '9', requestId: '9', resourceId: '4', assignedHours: 1048, startDate: '2026-04-01', endDate: '2026-09-30', allocationPct: 100 },
  // Resource '7' (new internal): flat 8h/day for the whole displayed window,
  // nothing booked in the look-ahead month (October) — the point of this fixture.
  { id: '10', requestId: '10', resourceId: '7', assignedHours: 1048, startDate: '2026-04-01', endDate: '2026-09-30', allocationPct: 100 },
  // Resource '9' (new internal, terminated 2026-03-15): real booking entirely
  // BEFORE the displayed window but partly INSIDE the fetch window's look-back
  // (Feb-Mar15). 408 = 51 working days (Jan2..Mar13, skipping the 2026-01-01
  // holiday) × 8h.
  { id: '11', requestId: '11', resourceId: '9', assignedHours: 408, startDate: '2026-01-01', endDate: '2026-03-15', allocationPct: 100 },
```

- [ ] **Step 4: Verify the seed loads on both adapters**

```bash
./node_modules/.bin/ng test
npx ng serve &
sleep 8
curl -s http://localhost:4200/api/resources | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.filter(r=>['6','4','7','8','9'].includes(r.id)).map(r=>r.id+':'+r.kind));"
kill %1
```
Expected output includes `6:subco,4:dummy,7:internal,8:internal,9:internal` (order may vary). No existing spec should regress — none imports from `src/db/seed.ts` (verified: `grep -rln "from '.*db/seed'" src --include="*.spec.ts"` returns nothing) and no smoke check asserts an exact resource/request count, so adding rows is safe.

- [ ] **Step 5: Commit**

```bash
git add src/db/seed.ts
git commit -m "test: seed Block F bench fixtures (subco ramp-down, dummy backfill, hire-mid-window, pre-termination booking)"
```

---

### Task 2: `bench.util.ts` — state, aging and availability (pure helpers)

**Spec:** §3, §5, §7 in full.

**Files:**
- Create: `src/app/services/bench.util.ts`
- Test: `src/app/services/bench.util.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces — Task 3 depends on these exact names/signatures:

```ts
export type BenchState = 'BENCH' | 'PARTIAL' | 'ALLOCATED';
export function benchStateFor(plannedHours: number, targetHours: number): BenchState;

export const UNALLOCATED_AGING_BUCKETS = ['B', 'C', 'D'] as const;
export type UnallocatedAgingBucket = typeof UNALLOCATED_AGING_BUCKETS[number];
export function monthsIdleAt(benchFlags: readonly boolean[], index: number): number;
export function bucketForMonthsIdle(monthsIdle: number): UnallocatedAgingBucket;

export function freeingUpNextMonth(
  activeThis: boolean, stateThis: BenchState,
  activeNext: boolean, stateNext: BenchState | undefined,
): boolean;

export type AvailabilityDate =
  | { kind: 'date'; date: string }
  | { kind: 'beyond-horizon'; horizonEndMonth: string };
export function availabilityDateFor(
  cells: readonly { month: string; state: BenchState }[],
  today: string,
): AvailabilityDate;
```

- [ ] **Step 1: Write the failing spec**

Create `src/app/services/bench.util.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  benchStateFor, monthsIdleAt, bucketForMonthsIdle, freeingUpNextMonth, availabilityDateFor,
  type BenchState,
} from './bench.util';

describe('benchStateFor (design spec §3 — decided on RAW hours, never the rounded %)', () => {
  it('exactly 0 planned -> BENCH', () => expect(benchStateFor(0, 160)).toBe('BENCH'));
  it('just above 0 planned -> PARTIAL, NOT bench (0.4h rounds to 0.00% but is a real booking)', () =>
    expect(benchStateFor(0.4, 176)).toBe('PARTIAL'));
  it('just below target -> PARTIAL', () => expect(benchStateFor(159.99, 160)).toBe('PARTIAL'));
  it('exactly at target -> ALLOCATED', () => expect(benchStateFor(160, 160)).toBe('ALLOCATED'));
  it('above target (over-allocated) -> ALLOCATED, no fourth state', () => expect(benchStateFor(200, 160)).toBe('ALLOCATED'));
});

describe('monthsIdleAt (walks backward from index while benchFlags holds, capped at 3)', () => {
  it('not bench at index -> 0', () => expect(monthsIdleAt([false], 0)).toBe(0));
  it('bench for 1 consecutive month -> 1', () => expect(monthsIdleAt([false, true], 1)).toBe(1));
  it('bench for 2 consecutive months -> 2', () => expect(monthsIdleAt([false, true, true], 2)).toBe(2));
  it('bench for 3 consecutive months -> capped at 3', () => expect(monthsIdleAt([false, true, true, true], 3)).toBe(3));
  it('bench for 4 consecutive months -> STILL capped at 3, not 4', () =>
    expect(monthsIdleAt([true, true, true, true], 3)).toBe(3));
});

describe('bucketForMonthsIdle', () => {
  it('1 -> B', () => expect(bucketForMonthsIdle(1)).toBe('B'));
  it('2 -> C', () => expect(bucketForMonthsIdle(2)).toBe('C'));
  it('3 (capped) -> D', () => expect(bucketForMonthsIdle(3)).toBe('D'));
});

describe('freeingUpNextMonth (mutually exclusive with a BENCH state this month, by construction)', () => {
  it('allocated this month, bench next month -> true (the ordinary signal)', () =>
    expect(freeingUpNextMonth(true, 'ALLOCATED', true, 'BENCH')).toBe(true));
  it('partial this month, bench next month -> STILL true (partial is not-yet-bench)', () =>
    expect(freeingUpNextMonth(true, 'PARTIAL', true, 'BENCH')).toBe(true));
  it('already bench this month -> false (nothing is "freeing up")', () =>
    expect(freeingUpNextMonth(true, 'BENCH', true, 'BENCH')).toBe(false));
  it('inactive next month (resource terminates) -> false, this is offboarding not reallocation (spec §5.2)', () =>
    expect(freeingUpNextMonth(true, 'ALLOCATED', false, undefined)).toBe(false));
});

describe('availabilityDateFor (design spec §7 — three branches, in order)', () => {
  const state = (s: BenchState) => s;
  it('bench THIS month -> today, not the 1st of the month', () => {
    const cells = [{ month: '2026-04', state: state('BENCH') }, { month: '2026-05', state: state('ALLOCATED') }];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'date', date: '2026-04-17' });
  });
  it('bench a LATER shown month -> the 1st of the FIRST such month', () => {
    const cells = [
      { month: '2026-04', state: state('PARTIAL') },
      { month: '2026-05', state: state('BENCH') },
      { month: '2026-06', state: state('BENCH') },
    ];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'date', date: '2026-05-01' });
  });
  it('never bench in the shown window -> beyond-horizon on the LAST shown month', () => {
    const cells = [
      { month: '2026-04', state: state('ALLOCATED') },
      { month: '2026-05', state: state('ALLOCATED') },
    ];
    expect(availabilityDateFor(cells, '2026-04-17')).toEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-05' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/bench.util.spec.ts'
```
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/app/services/bench.util.ts`:

```ts
/**
 * Bench / Unchargeable and availability (design spec, Block F). PURE: no I/O,
 * no clock — `today` is always a caller-supplied value, never read here.
 *
 * Mirrors `finance.util.ts`'s A/R aging shape (`AR_AGING_BUCKETS` /
 * `bucketForDaysOverdue` / `arAging`, `src/app/services/finance.util.ts:370-462`):
 * an ordered tuple of literal buckets, a pure classifier, an aggregator. The
 * difference that matters: aging here has TWO distinct questions — how long a
 * resource has ALREADY been idle (B/C/D, retrospective) and whether it is ABOUT
 * to become idle next month (forward-looking) — and the two are mutually
 * exclusive by construction, never merged into one bucket set (spec §5).
 */

export type BenchState = 'BENCH' | 'PARTIAL' | 'ALLOCATED';

/**
 * Classifies a single resource-month on RAW (unrounded) hours — never on a
 * percentage already rounded for display. A resource with 0.4h booked out of
 * ~160 standard hours rounds to "0.00%" on screen but is NOT bench: it has a
 * real, if tiny, booking (spec §3).
 */
export function benchStateFor(plannedHours: number, targetHours: number): BenchState {
  if (plannedHours === 0) return 'BENCH';
  if (plannedHours < targetHours) return 'PARTIAL';
  return 'ALLOCATED';
}

/** Retrospective aging buckets (spec §5.1) — ordered, like `AR_AGING_BUCKETS`. */
export const UNALLOCATED_AGING_BUCKETS = ['B', 'C', 'D'] as const;
export type UnallocatedAgingBucket = typeof UNALLOCATED_AGING_BUCKETS[number];

/**
 * How many consecutive months (walking backward from `index`, capped at 3 —
 * the cap is `bucketForMonthsIdle`'s own top bucket 'D', so counting further
 * back would never change the answer) `benchFlags` has held true, INCLUDING
 * `index` itself. `benchFlags[i]` must already read false for any month the
 * resource was not active in (design spec §5.1) — that guard lives in the
 * caller (`benchRollup`), not here.
 */
export function monthsIdleAt(benchFlags: readonly boolean[], index: number): number {
  let n = 0;
  for (let i = index; i >= 0 && benchFlags[i]; i--) { n++; if (n >= 3) break; }
  return n;
}

/** `monthsIdleAt`'s count is only ever called for a month where state === 'BENCH', so `monthsIdle` is always >= 1 in practice. */
export function bucketForMonthsIdle(monthsIdle: number): UnallocatedAgingBucket {
  if (monthsIdle <= 1) return 'B';
  if (monthsIdle === 2) return 'C';
  return 'D';
}

/**
 * Forward-looking "freeing up next month" signal (spec §5.2). Mutually
 * exclusive with an aging bucket by construction: this requires
 * `stateThis !== 'BENCH'`, aging buckets require `stateThis === 'BENCH'`.
 *
 * `activeNext` is deliberate: a resource that TERMINATES between this month
 * and the next is not marked "freeing up" — that is an offboarding event, not
 * a reallocation to plan for (out of scope — spec §12).
 */
export function freeingUpNextMonth(
  activeThis: boolean, stateThis: BenchState,
  activeNext: boolean, stateNext: BenchState | undefined,
): boolean {
  return activeThis && stateThis !== 'BENCH' && activeNext && stateNext === 'BENCH';
}

export type AvailabilityDate =
  | { kind: 'date'; date: string }
  | { kind: 'beyond-horizon'; horizonEndMonth: string };

/**
 * The 6-month availability date (spec §7) — NEVER absent, so a bench table
 * cell can never be misread as "no data" instead of "not free soon". Uses
 * ONLY the shown `cells`, in order — deliberately never the look-ahead month
 * fetched for `freeingUpNextMonth` (spec §7's explicit non-unification: the
 * two fields have different data scopes on purpose).
 */
export function availabilityDateFor(
  cells: readonly { month: string; state: BenchState }[],
  today: string,
): AvailabilityDate {
  if (cells[0]?.state === 'BENCH') return { kind: 'date', date: today };
  const firstBench = cells.find(c => c.state === 'BENCH');
  if (firstBench) return { kind: 'date', date: `${firstBench.month}-01` };
  return { kind: 'beyond-horizon', horizonEndMonth: cells[cells.length - 1]?.month ?? '' };
}
```

- [ ] **Step 4: Run it green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/bench.util.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Mutate and confirm red (pick 3, revert after)**

1. In `benchStateFor`, change `plannedHours < targetHours` to `plannedHours <= targetHours`. Run the suite: **"exactly at target -> ALLOCATED"** now fails (returns `'PARTIAL'`). Revert.
2. In `monthsIdleAt`, change `if (n >= 3) break;` to `if (n >= 4) break;`. Run the suite: **"bench for 4 consecutive months -> STILL capped at 3, not 4"** now fails (returns `4`). Revert.
3. In `freeingUpNextMonth`, change `stateNext === 'BENCH'` to `stateNext !== 'BENCH'`. Run the suite: **"allocated this month, bench next month -> true"** now fails. Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/bench.util.ts src/app/services/bench.util.spec.ts
git commit -m "feat: bench state, aging and availability-date pure helpers"
```

---

### Task 3: `hoursByResourceMonth` extraction + `benchRollup` composer

**Spec:** §2, §4, §6, §8 in full; §11's fixture table is the acceptance test for this task.

**Files:**
- Modify: `src/app/services/capacity.util.ts` (extract the aggregation loop, lines 72-90, into an exported helper; `rollupMonthly` calls it)
- Modify: `src/app/services/capacity.util.spec.ts` (new test for the extracted helper)
- Modify: `src/app/services/bench.util.ts` (add `hiringDemandByMonth`, `benchRollup`, `BenchRollupInput`, `BenchCell`, `BenchRow`, `BenchRollup`, `HiringDemandRow`, `EMPTY_BENCH_ROLLUP`)
- Modify: `src/app/services/bench.util.spec.ts` (the seed-fixture integration test, importing directly from `src/db/seed.ts`)

**Interfaces:**
- Consumes: `benchStateFor`, `monthsIdleAt`, `bucketForMonthsIdle`, `freeingUpNextMonth`, `availabilityDateFor` (Task 2); the seed fixtures from Task 1; `RollupInput`, `isActiveInMonth`, `standardMonthlyHours` (already exported by `capacity.util.ts`); `countsTowardDeliveryCapacity`, `kindOf` (`resource-kind.util.ts`).
- Produces — later tasks depend on these exact names/types:

```ts
// capacity.util.ts — new export, RollupInput unchanged
export function hoursByResourceMonth(
  input: Pick<RollupInput, 'assignments' | 'assignmentDays' | 'assignmentMonths'>,
): Map<string, Map<string, { confirmed: number; planned: number }>>;

// bench.util.ts — new exports
export interface HiringDemandRow { month: string; role: string; hours: number; }
export interface BenchCell {
  state: BenchState;
  agingBucket?: UnallocatedAgingBucket; // present ONLY if state === 'BENCH'
  upcomingUnallocated: boolean;
}
export interface BenchRow {
  resourceId: string; resourceName: string; kind: 'internal' | 'subco';
  monthly: Record<string, BenchCell>;
  availabilityDate: AvailabilityDate;
}
export interface BenchRollup {
  months: string[];           // the DISPLAY months, ascending
  internalRows: BenchRow[];
  subcoRows: BenchRow[];
  hiringDemand: HiringDemandRow[];
}
export const EMPTY_BENCH_ROLLUP: BenchRollup;
export interface BenchRollupInput extends RollupInput {
  /** The 6 months to return as rows — a subset of this.months, positioned so
   *  each display month's 2 preceding months and 1 following month are also
   *  present in `months` (the server computes this window; see Task 6). */
  displayMonths: string[];
}
export function hiringDemandByMonth(
  resources: readonly { id: string; role: string; kind?: string }[],
  hoursByResMonth: ReturnType<typeof hoursByResourceMonth>,
  months: readonly string[],
): HiringDemandRow[];
export function benchRollup(input: BenchRollupInput, today: string): BenchRollup;
```

- [ ] **Step 1: Write the failing test for the extracted helper**

In `src/app/services/capacity.util.spec.ts`, add (near the top, after the `monthsInRange` describe block):

```ts
describe('hoursByResourceMonth (extracted so bench.util can reuse the exact same per-cell arithmetic, spec §4)', () => {
  it('splits confirmed vs planned per resource/month, ignoring a day whose month row is missing', () => {
    const out = hoursByResourceMonth({
      assignments: [{ id: 'a1', resourceId: 'r1' }, { id: 'a2', resourceId: 'r1' }],
      assignmentMonths: [{ assignmentId: 'a1', month: '2026-05', status: 'Allocated' }, { assignmentId: 'a2', month: '2026-05', status: 'Requested' }],
      assignmentDays: [
        { assignmentId: 'a1', date: '2026-05-04', hours: 100 },
        { assignmentId: 'a2', date: '2026-05-05', hours: 40 },
        { assignmentId: 'a2', date: '2026-06-01', hours: 999 }, // no 'a2:2026-06' month row -> ignored
      ],
    });
    const cell = out.get('r1')!.get('2026-05')!;
    expect(cell.confirmed).toBe(100);
    expect(cell.planned).toBe(140);
    expect(out.get('r1')!.has('2026-06')).toBe(false);
  });
  it('ignores non-finite hours (NaN would poison the sum)', () => {
    const out = hoursByResourceMonth({
      assignments: [{ id: 'a1', resourceId: 'r1' }],
      assignmentMonths: [{ assignmentId: 'a1', month: '2026-05', status: 'Requested' }],
      assignmentDays: [{ assignmentId: 'a1', date: '2026-05-04', hours: Number.NaN }],
    });
    expect(out.get('r1')?.get('2026-05')?.planned ?? 0).toBe(0);
  });
});
```

Field names are `confirmed`/`planned` (matching the existing inline shape at `capacity.util.ts:74` — `{ confirmed: number; planned: number }`), not `confirmedHours`/`plannedHours` (those live one level up, on `CapacityCell`).

- [ ] **Step 2: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/capacity.util.spec.ts'
```
Expected: FAIL — `hoursByResourceMonth` is not exported.

- [ ] **Step 3: Extract the helper, then refactor `rollupMonthly` to call it**

In `src/app/services/capacity.util.ts`, replace the body of the aggregation loop (the `const byResMonth = new Map...` block through the end of the `for (const d of assignmentDays)` loop, lines 74-90) with a call to a new exported function:

```ts
/**
 * Per-resource, per-month {confirmed, planned} hours, aggregated from
 * assignmentDays weighted by each day's OWN month-row status (B3) — the exact
 * arithmetic `rollupMonthly` has always used, extracted so `bench.util.ts`'s
 * `benchRollup` can reuse it verbatim instead of re-deriving it (design spec §4).
 */
export function hoursByResourceMonth(
  input: Pick<RollupInput, 'assignments' | 'assignmentDays' | 'assignmentMonths'>,
): Map<string, Map<string, { confirmed: number; planned: number }>> {
  const { assignments, assignmentDays, assignmentMonths } = input;
  const asgById = new Map(assignments.map(a => [a.id, a]));
  const statusByRowId = new Map(assignmentMonths.map(m => [`${m.assignmentId}:${m.month}`, m.status]));
  const byResMonth = new Map<string, Map<string, { confirmed: number; planned: number }>>();
  for (const d of assignmentDays) {
    const a = asgById.get(d.assignmentId); if (!a) continue;
    if (!Number.isFinite(d.hours)) continue;
    const m = monthOf(d.date);
    const status = statusByRowId.get(`${d.assignmentId}:${m}`);
    if (status === undefined) continue;
    let rm = byResMonth.get(a.resourceId); if (!rm) { rm = new Map(); byResMonth.set(a.resourceId, rm); }
    let c = rm.get(m); if (!c) { c = { confirmed: 0, planned: 0 }; rm.set(m, c); }
    if (PLANNED.has(status)) c.planned += d.hours;
    if (CONFIRMED.has(status)) c.confirmed += d.hours;
  }
  return byResMonth;
}
```

Then, inside `rollupMonthly`, replace the loop you just extracted with:

```ts
  const byResMonth = hoursByResourceMonth({ assignments, assignmentDays, assignmentMonths });
```

`hoursByResourceMonth` must be declared BEFORE `rollupMonthly` in the file (or after — TypeScript function declarations hoist; keep it directly above `rollupMonthly` for readability).

- [ ] **Step 4: Run capacity.util.spec.ts fully green (regression gate)**

```bash
./node_modules/.bin/ng test --include='**/capacity.util.spec.ts'
```
Expected: every pre-existing `rollupMonthly` test still passes (unchanged behavior) AND the two new `hoursByResourceMonth` tests pass.

- [ ] **Step 5: Mutate and confirm red**

In `hoursByResourceMonth`, delete the `if (!Number.isFinite(d.hours)) continue;` line. Run `./node_modules/.bin/ng test --include='**/capacity.util.spec.ts'`: **both** "ignores non-finite hours" (the new one) AND the pre-existing `rollupMonthly` test "ignores non-finite hours rows" go red (the shared helper now poisons both). Revert the deletion.

- [ ] **Step 6: Write the failing seed-integration test for `benchRollup`**

Append to `src/app/services/bench.util.spec.ts`:

```ts
import { resources, assignments, assignmentDays, assignmentMonths, holidays } from '../../db/seed';
import { benchRollup, hiringDemandByMonth, EMPTY_BENCH_ROLLUP, type BenchRollupInput } from './bench.util';

const HOURS_PER_DAY = 8;
const HOLIDAY_SET = new Set(holidays.map(h => h.id));
const FETCH_MONTHS = ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const DISPLAY_MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const TODAY = '2026-04-17';

function rollup() {
  const input: BenchRollupInput = {
    resources, assignments, assignmentDays, assignmentMonths,
    months: FETCH_MONTHS, displayMonths: DISPLAY_MONTHS,
    hoursPerDay: HOURS_PER_DAY, holidays: HOLIDAY_SET,
  };
  return benchRollup(input, TODAY);
}

describe('benchRollup — seed integration (design spec §11 fixture table)', () => {
  const out = rollup();

  it('resource 6 (subco): PARTIAL in April, then B/C/D/D/D May-Sep', () => {
    const row = out.subcoRows.find(r => r.resourceId === '6')!;
    expect(row).toBeDefined();
    expect(row.monthly['2026-04'].state).toBe('PARTIAL');
    expect(row.monthly['2026-04'].agingBucket).toBeUndefined();
    expect(row.monthly['2026-04'].upcomingUnallocated).toBe(true); // May is BENCH
    expect(row.monthly['2026-05']).toMatchObject({ state: 'BENCH', agingBucket: 'B' });
    expect(row.monthly['2026-06']).toMatchObject({ state: 'BENCH', agingBucket: 'C' });
    expect(row.monthly['2026-07']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-08']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-09']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.availabilityDate).toEqual({ kind: 'date', date: '2026-05-01' });
  });
  it('resource 6 is in subcoRows ONLY — the case that matters most (spec §11, commit 2cb462b regression class)', () => {
    expect(out.internalRows.some(r => r.resourceId === '6')).toBe(false);
  });

  it('resource 4 (dummy): drives hiringDemand for every one of the 6 months, role Developer, hours > 0', () => {
    for (const m of DISPLAY_MONTHS) {
      const row = out.hiringDemand.find(h => h.month === m && h.role === 'Developer');
      expect(row).toBeDefined();
      expect(row!.hours).toBeGreaterThan(0);
    }
  });
  it('resource 4 (dummy) NEVER appears in internalRows or subcoRows despite real booked hours', () => {
    expect(out.internalRows.some(r => r.resourceId === '4')).toBe(false);
    expect(out.subcoRows.some(r => r.resourceId === '4')).toBe(false);
  });

  it('resource 5 (dummy, untouched) contributes NO row to hiringDemand — meaningful because resource 4 (also a dummy) DOES', () => {
    // Not the "bench is empty" trap: with resource 4 already proven above to
    // populate hiringDemand for all 6 months, this suite's hiringDemand list is
    // provably non-empty by construction — so 5's absence here is a genuine
    // negative, not a pass for lack of data anywhere in this test.
    const resource5Role = resources.find(r => r.id === '5')!.role;
    const contributedByFive = out.hiringDemand.filter(h => h.role === resource5Role && DISPLAY_MONTHS.includes(h.month));
    expect(contributedByFive.length).toBe(0);
  });

  it('resource 7 (new internal): ALLOCATED every shown month, beyond-horizon availability, upcomingUnallocated ONLY via the look-ahead month', () => {
    const row = out.internalRows.find(r => r.resourceId === '7')!;
    expect(row).toBeDefined();
    for (const m of DISPLAY_MONTHS) expect(row.monthly[m].state).toBe('ALLOCATED');
    expect(row.availabilityDate).toEqual({ kind: 'beyond-horizon', horizonEndMonth: '2026-09' });
    expect(row.monthly['2026-09'].upcomingUnallocated).toBe(true);
  });

  it('resource 8 (hired exactly on the anchor month): April is bucket B, not D — the look-back truncation', () => {
    const row = out.internalRows.find(r => r.resourceId === '8')!;
    expect(row.monthly['2026-04']).toMatchObject({ state: 'BENCH', agingBucket: 'B' });
    expect(row.monthly['2026-05']).toMatchObject({ state: 'BENCH', agingBucket: 'C' });
    expect(row.monthly['2026-06']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
    expect(row.monthly['2026-09']).toMatchObject({ state: 'BENCH', agingBucket: 'D' });
  });

  it('resource 9 (terminated 2026-03-15) is absent from internalRows for ALL 6 shown months, despite real booked hours in the look-back', () => {
    expect(out.internalRows.some(r => r.resourceId === '9')).toBe(false);
  });

  it('sanity check (free, no new fixture needed): Julie/John/Alice are already BENCH in April 2026', () => {
    for (const id of ['1', '2', '3']) {
      const row = out.internalRows.find(r => r.resourceId === id)!;
      expect(row).toBeDefined();
      expect(row.monthly['2026-04'].state).toBe('BENCH');
    }
  });
});
```

Resource `'5'`'s `role` is `'Consultant'` and resource `'4'`'s is `'Developer'` (confirmed from `src/db/seed.ts`) — they do not share a role, so the "resource 5" assertion above is clean: it cannot accidentally pass by aggregating resource 4's rows under the same key, only by resource 5 genuinely contributing nothing.

- [ ] **Step 7: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/bench.util.spec.ts'
```
Expected: FAIL — `benchRollup`/`hiringDemandByMonth`/`EMPTY_BENCH_ROLLUP` are not exported yet.

- [ ] **Step 8: Implement `hiringDemandByMonth` and `benchRollup`**

Append to `src/app/services/bench.util.ts`:

```ts
import { RollupInput, isActiveInMonth, standardMonthlyHours, hoursByResourceMonth } from './capacity.util';
import { countsTowardDeliveryCapacity, kindOf } from './resource-kind.util';

export interface HiringDemandRow { month: string; role: string; hours: number; }

/**
 * Hiring demand from DUMMY placeholders only (spec §6) — subco rows go to
 * bench (§4), never here. `hours` is RAW, unrounded; the FTE conversion is a
 * rendering-only step (§6/§10), never computed here.
 */
export function hiringDemandByMonth(
  resources: readonly { id: string; role: string; kind?: string }[],
  hoursByResMonth: ReturnType<typeof hoursByResourceMonth>,
  months: readonly string[],
): HiringDemandRow[] {
  const totals = new Map<string, number>(); // key: `${month} ${role}`
  for (const r of resources) {
    if (kindOf(r) !== 'dummy') continue;
    const byMonth = hoursByResMonth.get(r.id);
    if (!byMonth) continue;
    for (const m of months) {
      const cell = byMonth.get(m);
      if (!cell || cell.planned <= 0) continue;
      const key = `${m} ${r.role}`;
      totals.set(key, (totals.get(key) ?? 0) + cell.planned);
    }
  }
  return [...totals.entries()]
    .map(([key, hours]) => {
      const [month, role] = key.split(' ');
      return { month, role, hours };
    })
    .sort((a, b) => (a.month === b.month ? a.role.localeCompare(b.role) : a.month.localeCompare(b.month)));
}

export interface BenchCell {
  state: BenchState;
  agingBucket?: UnallocatedAgingBucket;
  upcomingUnallocated: boolean;
}
export interface BenchRow {
  resourceId: string; resourceName: string; kind: 'internal' | 'subco';
  monthly: Record<string, BenchCell>;
  availabilityDate: AvailabilityDate;
}
export interface BenchRollup {
  months: string[];
  internalRows: BenchRow[];
  subcoRows: BenchRow[];
  hiringDemand: HiringDemandRow[];
}
export const EMPTY_BENCH_ROLLUP: BenchRollup = { months: [], internalRows: [], subcoRows: [], hiringDemand: [] };

export interface BenchRollupInput extends RollupInput {
  /** The 6 months to return as rows — see the server's window construction (Task 6). */
  displayMonths: string[];
}

/**
 * Composes the whole Block F view: BENCH/PARTIAL/ALLOCATED + aging + the
 * forward-looking signal + availability, split into `internalRows`/`subcoRows`
 * by `countsTowardDeliveryCapacity` (NOT `countsTowardInternalCapacity` —
 * spec §4's whole point: a subco belongs in bench, a dummy never does), plus
 * `hiringDemand` from the dummy rows this split excludes.
 *
 * `input.months` is the WIDER fetch window (2 look-back + 6 shown + 1
 * look-ahead, spec §8); `input.displayMonths` is the 6 shown months. A
 * resource gets a row only if active in at least one DISPLAY month — a
 * DELIBERATE narrowing from `rollupMonthly`'s own `hasAny` gate (which
 * considers every fetched month): a resource whose only booking falls in the
 * look-back window (spec §11 fixture 6) must NOT surface a row here.
 */
export function benchRollup(input: BenchRollupInput, today: string): BenchRollup {
  const { resources, months, displayMonths, hoursPerDay, holidays } = input;
  const hoursByResMonth = hoursByResourceMonth(input);
  const targetByMonth = new Map(months.map(m => [m, standardMonthlyHours(m, hoursPerDay, holidays)]));
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  const internalRows: BenchRow[] = [];
  const subcoRows: BenchRow[] = [];

  for (const r of resources) {
    const kind = kindOf(r);
    if (!countsTowardDeliveryCapacity(kind)) continue; // dummy: never in bench (spec §4)

    const activeOf = new Map<string, boolean>();
    const stateOf = new Map<string, BenchState>();
    for (const m of months) {
      const active = isActiveInMonth(r, m);
      activeOf.set(m, active);
      if (!active) continue;
      const cell = hoursByResMonth.get(r.id)?.get(m) ?? { confirmed: 0, planned: 0 };
      stateOf.set(m, benchStateFor(cell.planned, targetByMonth.get(m)!));
    }

    if (!displayMonths.some(m => activeOf.get(m))) continue; // never active in a SHOWN month -> no row

    const benchFlags = months.map(m => (activeOf.get(m) ?? false) && stateOf.get(m) === 'BENCH');

    const monthly: Record<string, BenchCell> = {};
    for (const m of displayMonths) {
      if (!activeOf.get(m)) continue;
      const state = stateOf.get(m)!;
      const cell: BenchCell = { state, upcomingUnallocated: false };
      if (state === 'BENCH') cell.agingBucket = bucketForMonthsIdle(monthsIdleAt(benchFlags, monthIndex.get(m)!));
      monthly[m] = cell;
    }
    for (const m of displayMonths) {
      const cell = monthly[m];
      if (!cell) continue;
      const idx = monthIndex.get(m)!;
      const nextMonth = months[idx + 1];
      const activeNext = nextMonth !== undefined && (activeOf.get(nextMonth) ?? false);
      const stateNext = nextMonth !== undefined ? stateOf.get(nextMonth) : undefined;
      cell.upcomingUnallocated = freeingUpNextMonth(activeOf.get(m) ?? false, cell.state, activeNext, stateNext);
    }

    const cellsInOrder = displayMonths.filter(m => monthly[m] !== undefined).map(m => ({ month: m, state: monthly[m].state }));
    const row: BenchRow = {
      resourceId: r.id, resourceName: (r as { name: string }).name, kind: kind as 'internal' | 'subco',
      monthly, availabilityDate: availabilityDateFor(cellsInOrder, today),
    };
    if (kind === 'internal') internalRows.push(row); else subcoRows.push(row);
  }

  return { months: displayMonths, internalRows, subcoRows, hiringDemand: hiringDemandByMonth(resources, hoursByResMonth, displayMonths) };
}
```

`resources` in `RollupInput` is typed loosely (`{ id: string; name: string; kind?: string; ... }`); the `(r as { name: string }).name` cast is there because that local interface does not re-declare `name` as non-optional in a way TypeScript narrows automatically after the `kindOf`/`isActiveInMonth` calls above — if your editor does not require the cast, drop it; do not fight the compiler for a cast that is not needed.

- [ ] **Step 9: Run it green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/bench.util.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 10: Mutate and confirm red (the two highest-value mutations)**

1. In `benchRollup`, change `if (!countsTowardDeliveryCapacity(kind)) continue;` to `if (kind === 'internal' === false && kind !== 'subco') continue;` reduced simply to commenting the line out (i.e. remove the dummy exclusion entirely). Run the suite: **"resource 4 (dummy) NEVER appears in internalRows or subcoRows"** goes red (resource 4 now appears). Revert.
2. In the row-partition line, change `if (kind === 'internal') internalRows.push(row); else subcoRows.push(row);` to always `internalRows.push(row);`. Run the suite: **"resource 6 is in subcoRows ONLY"** goes red (resource 6 is absent from subcoRows, present in internalRows). Revert — this is the exact regression class of commit `2cb462b` (spec §11).
3. In `hiringDemandByMonth`, change `if (kindOf(r) !== 'dummy') continue;` to `if (kindOf(r) !== 'internal') continue;`. Run the suite: **"resource 4 (dummy): drives hiringDemand..."** goes red (now filters out dummies, including resource 4). Revert.

- [ ] **Step 11: Commit**

```bash
git add src/app/services/capacity.util.ts src/app/services/capacity.util.spec.ts src/app/services/bench.util.ts src/app/services/bench.util.spec.ts
git commit -m "feat: hoursByResourceMonth extraction + benchRollup composer, verified against seed fixtures"
```

---

### Task 4: Raw assignment-day/month reads for the What-If sandbox (shared with block E)

**Spec:** §8, §9 (the `/forecast` row's "costo di wiring esplicito" paragraph).

**Why this task exists (not spelled out verbatim in the spec, but required by it):** `/forecast/what-if` mutates `resources`/`requests` only in memory and can NEVER round-trip a scenario through the server — so `benchRollup` must run **client-side** there, which means the client needs raw `assignmentDays`/`assignmentMonths`, not a server-pre-aggregated rollup. No endpoint exists today that returns these as plain lists to a client. `/utilization` and `/dashboard` (Tasks 8-9) show only real, persisted data and will instead call the new `/bench/monthly` aggregate (Task 6) directly — they do NOT need this task's endpoints. **Block E's spec independently requires the same two reads over the same underlying collections** — this task's endpoints are shared infrastructure, not a Block-F-only concern; whichever of the two blocks lands on this tree first builds them, and the other must find them already there rather than adding a second pair.

**Path naming — aligned with block E, not a nested sub-resource.** These are `GET /assignment-days` and `GET /assignment-months`, mounted at the root, NOT `/assignments/days`/`/assignments/months`. Verified against every `apiRouter.get/post/put/delete` root path in `src/server.ts`: every compound-concept collection is ONE hyphenated segment at the root — `order-lines`, `billing-plan-items`, `change-requests`, `approval-requests`, `time-entries`, `negotiated-rates`, `project-cost-centers`, `resource-organizations`. The only two-segment literal paths in the file are action/namespace groupings, not competing entity collections — `/integrations/crm/outbox`, `/integrations/bi/feed`, `/integrations/erp/journal-export` (actions under an `/integrations` feature namespace), `/orders/with-line` and `/billing-plan-items/generate-invoices` (bespoke composite-create/batch actions on their own collection), `/allocation-approvals/decide` (an action on that collection), `/self/assignments`/`/self/profile`/`/self/requests`/`/self/time-entries` (a scope prefix, not a parent collection). None of these is a second collection's list mounted under a different collection's plural root — there is **no genuine nested-sub-resource precedent** in this file for what `/assignments/days` would have been. `/assignment-months` itself is already precedented as a ROOT-level hyphenated path: `POST /assignment-months/:id/substitute` (the C2 dummy-substitution action, `src/server.ts:3071`) already lives there, never under `/assignments/months`.

**Files:**
- Modify: `src/server.ts` — two new GET routes (new standalone block, e.g. placed near the existing `/assignments` handlers for topical grouping — physical placement does not matter since these are literal root paths, distinct from `/assignments/:id/...`) — plus **one new `READ_RULES` entry**, added ONLY if it is not already there (see Step 3)
- Modify: `src/app/services/api.service.ts` — two new client methods (names unchanged from an earlier draft of this plan — `getAssignmentDays`/`getAssignmentMonths` already read as "Assignment Days"/"Assignment Months", singular, matching the corrected URL shape with no rename needed)
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `repos.assignmentDays`, `repos.assignmentMonths` (existing repos).
- Produces — Task 5 depends on these exact names:

```ts
// api.service.ts
getAssignmentDays(): Observable<AssignmentDay[]>;   // GET /assignment-days
getAssignmentMonths(): Observable<AssignmentMonth[]>; // GET /assignment-months
```

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-api.mjs`, add a new function following the file's existing idiom (model it on `checkCapacityMonthly` at line 1104):

```js
async function checkAssignmentRawReads() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'employee' };

  {
    const { status, body } = await req('GET', '/assignment-days');
    check('GET /api/assignment-days (admin) -> 200', status === 200, `status=${status}`);
    check('response is an array with at least the seeded rows', Array.isArray(body) && body.length > 0, `length=${Array.isArray(body) ? body.length : 'n/a'}`);
    const row = Array.isArray(body) ? body[0] : undefined;
    check('a row has assignmentId/date/hours', Boolean(row) && typeof row.assignmentId === 'string' && typeof row.date === 'string' && typeof row.hours === 'number', JSON.stringify(row));
  }
  {
    const { status, body } = await req('GET', '/assignment-months');
    check('GET /api/assignment-months (admin) -> 200', status === 200, `status=${status}`);
    check('response is an array with at least the seeded rows', Array.isArray(body) && body.length > 0, `length=${Array.isArray(body) ? body.length : 'n/a'}`);
  }
  {
    const { status } = await req('GET', '/assignment-days', { headers: EMPLOYEE_HEADERS });
    check('GET /api/assignment-days (employee) -> 403', status === 403, `status=${status}`);
  }
  {
    const { status } = await req('GET', '/assignment-months', { headers: EMPLOYEE_HEADERS });
    check('GET /api/assignment-months (employee) -> 403', status === 403, `status=${status}`);
  }
}
```

Register it in `main()`, following the existing try/catch pattern, right after the `checkCapacityMonthly()` block:

```js
  try {
    await checkAssignmentRawReads();
  } catch (err) {
    console.log(`FAIL  assignment raw-reads (Block F/E plumbing) — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }
```

- [ ] **Step 2: Run the smoke suite to see it fail**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```
Expected: the 4 new checks FAIL (404 — the routes do not exist yet). **If they instead already pass, STOP — block E landed here first.** Skip straight to Step 4 without re-adding the route or the `READ_RULES` entry; confirm the existing implementation matches this task's shape (paths, response shape, roles below) and only add what is genuinely missing.

- [ ] **Step 3: Implement the two routes and the shared RBAC rule**

In `src/server.ts`, add the two routes as a new standalone block (e.g. near the existing `/assignments` handlers, around line 2202, for topical grouping — the physical location is not load-bearing since these are distinct root paths):

```ts
// Shared by Block F (bench.util's client-side composition, since the What-If
// sandbox mutates resources/requests only in memory and can never round-trip
// through the server) and block E (same underlying data, independently
// required by its own spec). Root-level, hyphenated, matching this file's own
// convention for a compound-concept collection (order-lines, billing-plan-items,
// change-requests, approval-requests, time-entries) — NOT nested under
// '/assignments', which has no precedent anywhere in this file for a second
// collection's list. `/assignment-months` itself is already a root path here
// (the C2 substitute action, line 3071).
apiRouter.get('/assignment-days', async (_req, res) => { res.json(await repos.assignmentDays.list()); });
apiRouter.get('/assignment-months', async (_req, res) => { res.json(await repos.assignmentMonths.list()); });
```

Then add ONE new `READ_RULES` entry (`src/server.ts`, the array starting at line 701) — **check first that it is not already there** (see Step 2's note: whichever of block E or block F lands first creates this entry, the other must not duplicate it):

```ts
  // Shared by Block F and block E: same need-to-know as '/capacity' and
  // '/bench' (line 721) — these two collections feed exactly the same
  // pre-aggregated rollups those endpoints already serve to this audience,
  // just unaggregated for client-side (What-If sandbox) composition.
  { test: p => p.startsWith('/assignment-days') || p.startsWith('/assignment-months'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
```

**This exact role list — `['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin']` — is the agreed answer for both blocks.** Do not write a different set here than whatever the other block's own plan says; if you find this entry already present with a DIFFERENT role list, stop and reconcile before proceeding rather than picking one silently.

No existing route lives under either `/assignment-days` or `/assignment-months` on the READ side today (confirmed: `grep -n "apiRouter\.\(get\|post\|put\|delete\)('/assignment-months\|.../assignment-days" src/server.ts` shows only the pre-existing `POST /assignment-months/:id/substitute`, governed by its own, separate mutation rule at line 676) — so this new entry only ever gates the two routes this task adds, never tightens something already reachable more broadly.

In `src/app/services/api.service.ts`, add beside `getAssignments()` (around line 991):

```ts
  getAssignmentDays(): Observable<AssignmentDay[]> {
    return this.http.get<AssignmentDay[]>(`${this.baseUrl}/assignment-days`);
  }
  getAssignmentMonths(): Observable<AssignmentMonth[]> {
    return this.http.get<AssignmentMonth[]>(`${this.baseUrl}/assignment-months`);
  }
```

- [ ] **Step 4: Run the smoke suite green**

```bash
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```
Expected: all 4 new checks pass, nothing pre-existing regressed.

- [ ] **Step 5: Mutate and confirm red**

Remove `'finance'` from the new `READ_RULES` entry's role list. Re-run the smoke suite with a finance-role request added temporarily (`{'X-User-Id':'4','X-User-Role':'finance'}`) expecting 200 on `GET /assignment-days`: it now returns 403. Revert the role list to the full 5-role set.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/app/services/api.service.ts scripts/smoke-api.mjs
git commit -m "feat: raw assignment-day/month reads (assignment-days, assignment-months), shared with block E"
```

---

### Task 5: Retarget `/forecast` and `/forecast/what-if` onto `bench.util` (retire `benchList`/`BenchEntry`)

**Spec:** §9's `/forecast` row in full — decision 2 ("sostituito, non affiancato"). **This task must land before Task 7** (see the Ordering constraint at the top of this plan).

**Files:**
- Modify: `src/app/services/forecast.util.ts` — remove `BenchEntry` (lines 59-68) and `benchList` (lines ~300-332); extend `ForecastData`
- Modify: `src/app/services/forecast.util.spec.ts` — remove/replace `benchList` tests if any exist (check first; if none exist, nothing to remove)
- Modify: `src/app/forecast/forecast.ts` — dataRes forkJoin, bench computed signals, template table, error-state branch
- Modify: `src/app/forecast/forecast.spec.ts`
- Modify: `src/app/forecast/what-if.ts` — dataRes forkJoin, `clone()`, bench-count computed signals, error-state branch
- Modify: `src/app/forecast/what-if.spec.ts`
- Modify: `src/app/services/bench.util.ts` — add `notFullyAllocatedAt` (the forecast-shaped wrapper around `benchRollup`)
- Modify: `src/app/services/bench.util.spec.ts`

**Interfaces:**
- Consumes: `benchRollup`, `BenchRow`, `BenchState` (Task 3); `getAssignmentDays()`, `getAssignmentMonths()` (Task 4); existing `getHolidays()`, `getHoursPerDay()`.
- Produces — nothing later tasks in THIS plan depend on, but this is the retirement point: after this task, `benchList`/`BenchEntry` no longer exist anywhere in the codebase.

```ts
// bench.util.ts — new export
export function notFullyAllocatedAt(
  input: Omit<RollupInput, 'months'>,
  month: string,
  today: string,
): BenchRow[];
```

- [ ] **Step 1: Write the failing test for `notFullyAllocatedAt`**

Append to `src/app/services/bench.util.spec.ts`:

```ts
describe('notFullyAllocatedAt (the /forecast + /what-if single-month wrapper around benchRollup)', () => {
  it('excludes an ALLOCATED resource and includes a BENCH one, at the given month', () => {
    const input = {
      resources: [
        { id: 'full', name: 'Full', kind: 'internal', contractHoursPerDay: 8 },
        { id: 'idle', name: 'Idle', kind: 'internal', contractHoursPerDay: 8 },
      ],
      assignments: [{ id: 'a1', resourceId: 'full' }],
      assignmentDays: [{ assignmentId: 'a1', date: '2026-05-04', hours: 168 }],
      assignmentMonths: [{ assignmentId: 'a1', month: '2026-05', status: 'Allocated' }],
      hoursPerDay: 8,
      holidays: new Set<string>(),
    };
    const out = notFullyAllocatedAt(input, '2026-05', '2026-05-10');
    expect(out.some(r => r.resourceId === 'full')).toBe(false);
    expect(out.some(r => r.resourceId === 'idle')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/bench.util.spec.ts'
```
Expected: FAIL — `notFullyAllocatedAt` is not exported.

- [ ] **Step 3: Implement `notFullyAllocatedAt`**

Append to `src/app/services/bench.util.ts`:

```ts
/**
 * Single-month "not fully allocated" snapshot for `/forecast`'s rolling weekly
 * horizon and `/what-if`'s in-memory sandbox — DECOUPLED from `/bench`'s own
 * 6-month display window (spec §9's `/forecast` row: "ripuntato su
 * bench.util.ts... filtrato su monthly[from].state !== 'ALLOCATED'"). Builds
 * the minimal 4-month fetch window (2 look-back + `month` itself + 1
 * look-ahead) `benchRollup` needs for a correct aging bucket / forward signal
 * on that one month, and returns every internal+subco row that is BENCH or
 * PARTIAL there.
 */
export function notFullyAllocatedAt(
  input: Omit<RollupInput, 'months'>,
  month: string,
  today: string,
): BenchRow[] {
  const idx = (m: string) => { const [y, mm] = m.split('-').map(Number); return y * 12 + (mm - 1); };
  const toMonth = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  const c = idx(month);
  const months = [c - 2, c - 1, c, c + 1].map(toMonth);
  const roll = benchRollup({ ...input, months, displayMonths: [month] }, today);
  return [...roll.internalRows, ...roll.subcoRows].filter(r => r.monthly[month]?.state !== 'ALLOCATED');
}
```

- [ ] **Step 4: Run it green**

```bash
./node_modules/.bin/ng test --include='**/bench.util.spec.ts'
```

- [ ] **Step 5: Retire `benchList`/`BenchEntry` from `forecast.util.ts`, extend `ForecastData`**

Check first whether `forecast.util.spec.ts` has any `benchList`/`BenchEntry` tests (`grep -n "benchList\|BenchEntry" src/app/services/forecast.util.spec.ts`); if it does, delete them in this same step — a spec importing a symbol you are about to remove fails the build, not just the test.

In `src/app/services/forecast.util.ts`:
- Delete the `BenchEntry` interface (lines 59-68).
- Delete the `benchList` function (the whole block from its doc comment at line ~300 through its closing `}` at ~332) and its `bookedHoursByResource` helper ONLY IF `overAllocated` no longer needs it — check first: `overAllocated` (line 343) ALSO calls `bookedHoursByResource`, so keep that helper, delete only `benchList` itself.
- Extend `ForecastData` (lines 33-37):

```ts
import { Resource, ResourceRequest, Assignment, AssignmentDay, AssignmentMonth, Holiday } from './api.service';

export interface ForecastData {
  resources: Resource[];
  requests: ResourceRequest[];
  assignments: Assignment[];
  assignmentDays: AssignmentDay[];
  assignmentMonths: AssignmentMonth[];
  holidays: Holiday[];
  hoursPerDay: number;
}
```

Add a one-line pointer comment where `benchList` used to live:

```ts
// `benchList`/`BenchEntry` (utilization-scalar heuristic) retired here — Block F
// design spec §9 decision 2. See `notFullyAllocatedAt` (bench.util.ts) and
// this file's consumers (forecast.ts, what-if.ts) for the replacement.
```

- [ ] **Step 6: Rewire `forecast.ts`**

In `src/app/forecast/forecast.ts`:

Replace the import block:

```ts
import {
  ForecastData,
  CapacityPeriod,
  OverAllocationEntry,
  SkillGapEntry,
  capacityForecast,
  overAllocated,
  skillGap,
} from '../services/forecast.util';
import { notFullyAllocatedAt, type BenchRow } from '../services/bench.util';
```

Replace the `dataRes` (lines 337-348) — same gating, three new forkJoin legs plus `hoursPerDay`:

```ts
  private readonly dataRes = rxResource<ForecastData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            resources: this.api.getResources(),
            requests: this.api.getRequests(),
            assignments: this.api.getAssignments(),
            assignmentDays: this.api.getAssignmentDays(),
            assignmentMonths: this.api.getAssignmentMonths(),
            holidays: this.api.getHolidays(),
            hoursPerDay: this.api.getHoursPerDay().pipe(map(r => r.value)),
          })
        : of<ForecastData>(Forecast.EMPTY_DATA),
    defaultValue: Forecast.EMPTY_DATA,
  });

  private static readonly EMPTY_DATA: ForecastData = {
    resources: [], requests: [], assignments: [], assignmentDays: [], assignmentMonths: [], holidays: [], hoursPerDay: DEFAULT_HOURS_PER_DAY,
  };
```

Add `map` to the `rxjs` import (`import { forkJoin, of } from 'rxjs';` becomes `import { forkJoin, of, map } from 'rxjs';`) and `DEFAULT_HOURS_PER_DAY` from `../services/sell-rate.util`.

Replace the bench section (lines 430-436):

```ts
  // --- Bench / over-allocation / skills ---

  private readonly currentMonth = computed<string>(() => this.horizonStartIso().slice(0, 7));

  private readonly bench = computed<BenchRow[]>(() => {
    const d = this.forecastData();
    const input = {
      resources: d.resources, assignments: d.assignments, assignmentDays: d.assignmentDays,
      assignmentMonths: d.assignmentMonths, hoursPerDay: d.hoursPerDay,
      holidays: new Set(d.holidays.map(h => h.id)),
    };
    return notFullyAllocatedAt(input, this.currentMonth(), todayLocalIso());
  });
  readonly benchCount = computed<number>(() => this.bench().length);
  readonly benchIdleCount = computed<number>(() =>
    this.bench().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length,
  );
  readonly benchPartialCount = computed<number>(() => this.benchCount() - this.benchIdleCount());

  readonly overAllocations = computed<OverAllocationEntry[]>(() => overAllocated(this.forecastData()));
  readonly overCount = computed<number>(() => this.overAllocations().length);

  readonly skills = computed<SkillGapEntry[]>(() => skillGap(this.forecastData()));
  readonly shortageCount = computed<number>(() => this.skills().filter(s => s.shortage).length);
```

Update the `forecastData` computed (lines 354-357) to carry the new fields through:

```ts
  private readonly forecastData = computed<ForecastData>(() => this.dataRes.value());
```

(It can simplify to this now — every field of `ForecastData` is already what `dataRes.value()` returns, so the old field-by-field reconstruction is redundant.)

Update the KPI strip's "On Bench" tile (around line 91-95):

```html
          <div class="command-kpi green">
            <p class="command-kpi-label">On Bench</p>
            <p class="command-kpi-value">{{ benchCount() }}</p>
            <p class="command-kpi-note">{{ benchIdleCount() }} idle &middot; {{ benchPartialCount() }} partial</p>
          </div>
```

Replace the Bench table (lines 176-211) — new columns (BenchRow has no `role`/`utilization`/`availableHours`):

```html
          <!-- Bench -->
          <section class="command-card overflow-hidden">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Bench</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Not fully allocated this month (BENCH or PARTIAL) — see the full 6-month view on <a routerLink="/bench" class="font-semibold text-[var(--cc-primary-text)]">Bench</a>.</p>
              </div>
              <span class="command-status green">{{ benchCount() }}</span>
            </div>
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of bench(); track b.resourceId) {
                    <tr>
                      <td class="font-semibold text-[var(--cc-ink)]">{{ b.resourceName }}</td>
                      <td class="text-[var(--cc-muted)] capitalize">{{ b.kind }}</td>
                      <td>
                        <span class="command-status" [class.red]="b.monthly[currentMonth()]?.state === 'BENCH'" [class.amber]="b.monthly[currentMonth()]?.state === 'PARTIAL'">
                          {{ b.monthly[currentMonth()]?.state }}
                        </span>
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="3" class="text-center text-[var(--cc-muted)]">No bench — every resource is fully allocated.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
```

Add `RouterLink` to the component's `imports` array (needed for the new `routerLink` in the bench card's subtitle).

Add the missing error-state branch (Global Constraint: a failed read must never render as an empty/zero state presented as fact). Change:

```html
      @if (hasData()) {
```
to:
```html
      @if (dataRes.status() === 'error') {
        <div class="command-card border-critical! p-10 text-center flex flex-col items-center gap-4">
          <h3 class="font-display text-lg font-bold text-[var(--cc-ink)]">Couldn't load the forecast</h3>
          <p class="text-[var(--cc-muted)] text-sm">Something went wrong while fetching the data.</p>
          <button type="button" (click)="dataRes.reload()" class="command-button">Retry</button>
        </div>
      } @else if (hasData()) {
```

- [ ] **Step 7: Rewire `what-if.ts`**

Same forkJoin/EMPTY_DATA/import changes as Step 6 (mirror exactly — the two files share the identical `dataRes` shape by design).

Replace `clone()` (lines 769-775) to carry the new fields:

```ts
  private clone(data: ForecastData): ForecastData {
    return {
      resources: data.resources.map(r => ({ ...r, skills: r.skills.map(s => ({ ...s })) })),
      requests: data.requests.map(r => ({ ...r, skills: [...r.skills] })),
      assignments: data.assignments.map(a => ({ ...a })),
      assignmentDays: data.assignmentDays.map(d => ({ ...d })),
      assignmentMonths: data.assignmentMonths.map(m => ({ ...m })),
      holidays: data.holidays.map(h => ({ ...h })),
      hoursPerDay: data.hoursPerDay,
    };
  }
```

Replace the bench-count computeds (lines 480-481):

```ts
  private readonly currentMonth = computed<string>(() => todayLocalIso().slice(0, 7));

  private toRollupInput(d: ForecastData) {
    return {
      resources: d.resources, assignments: d.assignments, assignmentDays: d.assignmentDays,
      assignmentMonths: d.assignmentMonths, hoursPerDay: d.hoursPerDay,
      holidays: new Set(d.holidays.map(h => h.id)),
    };
  }
  private readonly baseBenchCount = computed<number>(() =>
    notFullyAllocatedAt(this.toRollupInput(this.baseData()), this.currentMonth(), todayLocalIso()).length,
  );
  private readonly scenarioBenchCount = computed<number>(() =>
    notFullyAllocatedAt(this.toRollupInput(this.scenario()), this.currentMonth(), todayLocalIso()).length,
  );
```

Replace the `benchList` import with `notFullyAllocatedAt` (from `../services/bench.util`), remove `benchList` from the `forecast.util` import list.

Add the same error-state branch as Step 6 (check the template's top-level `@if` and mirror it).

- [ ] **Step 8: Update the component specs**

In `forecast.spec.ts` and `what-if.spec.ts`: wherever the test's mock `ApiService` stubs `getResources`/`getRequests`/`getAssignments`, add stubs for `getAssignmentDays` (return `of([])`), `getAssignmentMonths` (return `of([])`), `getHolidays` (return `of([])` if not already stubbed), `getHoursPerDay` (return `of({ value: 8 })` if not already stubbed) — otherwise the component's `dataRes` forkJoin throws on the missing methods and every existing test in these two files goes red. Where an existing test asserted on `bench()`/`benchCount()` reading `BenchEntry` shape (`utilization`/`availableHours`/`role`), update it to the `BenchRow` shape (`kind`/`monthly[month].state`) or to just the count, matching the new template.

- [ ] **Step 9: Run the full suite, lint, build**

```bash
./node_modules/.bin/ng test --include='**/forecast/**'
./node_modules/.bin/ng test --include='**/forecast.util.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

- [ ] **Step 10: Confirm the retirement is total**

```bash
grep -rn "benchList\|BenchEntry" src
```
Expected: **no output**. If anything remains, it is a leftover consumer this task missed — fix it before committing.

- [ ] **Step 11: Mutate and confirm red**

In `notFullyAllocatedAt`, change the filter `r.monthly[month]?.state !== 'ALLOCATED'` to `r.monthly[month]?.state === 'ALLOCATED'` (inverted). Run `ng test --include='**/bench.util.spec.ts'`: the "excludes an ALLOCATED resource and includes a BENCH one" test goes red (both assertions flip). Revert.

- [ ] **Step 12: Commit**

```bash
git add src/app/services/forecast.util.ts src/app/services/forecast.util.spec.ts src/app/forecast src/app/services/bench.util.ts src/app/services/bench.util.spec.ts
git commit -m "refactor: retire benchList/BenchEntry, retarget /forecast and /forecast/what-if onto bench.util"
```

---

### Task 6: `GET /bench/monthly` endpoint + RBAC + `ApiService.getBenchMonthly()`

**Spec:** §8 in full (the endpoint, the 9-month fetch window, the RBAC rationale).

**Files:**
- Modify: `src/server.ts` — new import, new route, RBAC extension
- Modify: `src/app/services/api.service.ts` — re-export `BenchRollup` et al., add `getBenchMonthly()`
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `benchRollup` (Task 3, `src/app/services/bench.util.ts`); seed fixtures (Task 1).
- Produces — Tasks 7-9 depend on this exact name and shape:

```ts
// api.service.ts
export type { BenchRollup, BenchRow, BenchCell, BenchState, HiringDemandRow, AvailabilityDate, UnallocatedAgingBucket } from './bench.util';
getBenchMonthly(from?: string): Observable<BenchRollup>;
```

- [ ] **Step 1: Write the failing smoke checks**

Add to `scripts/smoke-api.mjs`, modeled directly on `checkCapacityMonthly` (line 1104):

```js
async function checkBenchMonthly() {
  const EMPLOYEE_HEADERS = { 'X-User-Id': '2', 'X-User-Role': 'employee' };
  const HAPPY_PATH = '/bench/monthly?from=2026-04';

  const { status, body } = await req('GET', HAPPY_PATH);
  const okStatus = check(`GET /api${HAPPY_PATH} (admin) -> 200`, status === 200, `status=${status}`);
  if (!okStatus) return;

  check(
    "response 'months' is exactly the 6 shown months 2026-04..2026-09",
    Array.isArray(body.months) && body.months.length === 6 && body.months[0] === '2026-04' && body.months[5] === '2026-09',
    `months=${JSON.stringify(body.months)}`,
  );

  const subco6 = (body.subcoRows || []).find((r) => r.resourceId === '6');
  check("subcoRows includes resource '6' (subco) with April PARTIAL", Boolean(subco6) && subco6.monthly['2026-04']?.state === 'PARTIAL', JSON.stringify(subco6?.monthly?.['2026-04']));
  check("resource '6' is NEVER in internalRows", !(body.internalRows || []).some((r) => r.resourceId === '6'), 'found in internalRows');

  check(
    'no dummy resource id (4 or 5) appears in internalRows or subcoRows',
    !['4', '5'].some((id) => (body.internalRows || []).some((r) => r.resourceId === id) || (body.subcoRows || []).some((r) => r.resourceId === id)),
    'a dummy id leaked into a bench row list',
  );

  const hiring4 = (body.hiringDemand || []).filter((h) => h.role === 'Developer' && h.hours > 0);
  check('hiringDemand has 6 Developer rows (one per shown month) with hours > 0', hiring4.length >= 6, `count=${hiring4.length}`);

  const { status: empStatus } = await req('GET', '/bench/monthly', { headers: EMPLOYEE_HEADERS });
  check('GET /api/bench/monthly (employee) -> 403', empStatus === 403, `status=${empStatus}`);
}
```

Register it in `main()` right after `checkAssignmentRawReads()`:

```js
  try {
    await checkBenchMonthly();
  } catch (err) {
    console.log(`FAIL  bench-monthly flow — unexpected error — ${err && err.message ? err.message : err}`);
    failed++;
  }
```

- [ ] **Step 2: Run the smoke suite to see it fail**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```
Expected: every `checkBenchMonthly` check FAILS (404 — the route does not exist).

- [ ] **Step 3: Implement the endpoint**

In `src/server.ts`, add the import next to the existing `capacity.util` one (line 17):

```ts
import { benchRollup } from './app/services/bench.util';
```

Add the route immediately after the `/capacity/monthly` handler (after line 3581, before the B3 comment block):

```ts
// ---------------------------------------------------------------------------
// COMPUTED READ (Block F): monthly BENCH/PARTIAL/ALLOCATED rollup + hiring
// demand across internal/subco resources. Gated by the '/capacity' READ_RULE,
// extended below to also match '/bench' (design spec §8) — roleGate is GLOBAL
// middleware, so this handler is already authorized; do NOT re-gate per-handler.
// Read-only: no mutation, no audit entry, no withLock.
// ---------------------------------------------------------------------------
apiRouter.get('/bench/monthly', async (req, res) => {
  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const qParam = (name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === 'string' ? v : undefined;
  };
  const monthToIdx = (mo: string): number => { const [y, m] = mo.split('-').map(Number); return y * 12 + (m - 1); };
  const idxToMonth = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;

  const fromRaw = qParam('from');
  if (fromRaw !== undefined && !MONTH_RE.test(fromRaw)) { res.status(400).json({ error: 'from must be a YYYY-MM month' }); return; }

  let from = fromRaw;
  if (from === undefined) {
    const openIds = (await repos.planningPeriods.list()).filter(p => p.status === 'Open').map(p => p.id).sort();
    from = openIds[0] ?? new Date().toISOString().slice(0, 7);
  }
  // Fixed 6-month display window — NOT configurable by the caller (design spec §8).
  const to = idxToMonth(monthToIdx(from) + 5);
  const fetchFrom = idxToMonth(monthToIdx(from) - 2);
  const fetchTo = idxToMonth(monthToIdx(to) + 1);
  const months = monthsInRange(fetchFrom, fetchTo);   // 9 months: 2 look-back + 6 shown + 1 look-ahead
  const displayMonths = monthsInRange(from, to);        // the 6 shown months

  const [resources, assignments, assignmentDays, assignmentMonthRows, holidays, hoursPerDay] = await Promise.all([
    repos.resources.list(),
    repos.assignments.list(),
    repos.assignmentDays.list(),
    repos.assignmentMonths.list(),
    repos.holidays.list(),
    getHoursPerDay(),
  ]);
  const holSet = new Set(holidays.map(h => h.id));
  const assignmentMonths = assignmentMonthRows.map(m => ({ assignmentId: m.assignmentId, month: m.month, status: m.status }));
  const today = new Date().toISOString().slice(0, 10);

  res.json(benchRollup({ resources, assignments, assignmentDays, assignmentMonths, months, displayMonths, hoursPerDay, holidays: holSet }, today));
});
```

Extend the RBAC test at line 721 (do NOT duplicate the array):

```ts
  { test: p => p.startsWith('/capacity') || p.startsWith('/bench'), roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'] },
```

In `src/app/services/api.service.ts`, re-export the bench types (beside the existing `NegotiatedRate` re-export) and add the method beside `getCapacityMonthly` (line 1078):

```ts
export type { BenchRollup, BenchRow, BenchCell, BenchState, HiringDemandRow, AvailabilityDate, UnallocatedAgingBucket } from './bench.util';
```

```ts
  getBenchMonthly(from?: string): Observable<BenchRollup> {
    let params = new HttpParams();
    if (from) params = params.set('from', from);
    return this.http.get<BenchRollup>(`${this.baseUrl}/bench/monthly`, { params });
  }
```

- [ ] **Step 4: Run the smoke suite green, then the gates**

```bash
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Mutate and confirm red**

Revert the RBAC line back to `p.startsWith('/capacity')` only (drop `|| p.startsWith('/bench')`). Re-run the smoke suite: `GET /api/bench/monthly (admin) -> 200` still passes (no READ_RULE match falls through to "any verified actor", per the doc comment at line 690-700 — admin is verified either way), but re-check with a role OUTSIDE both sets that IS a verified application role... actually the more direct mutation: temporarily change `roles: ['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin']` to omit `'finance'`, add a smoke check `GET /bench/monthly` as `{'X-User-Id':'4','X-User-Role':'finance'}` expecting 200, confirm it now returns 403. Revert both changes.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/app/services/api.service.ts scripts/smoke-api.mjs
git commit -m "feat: GET /bench/monthly endpoint, extending the /capacity RBAC rule"
```

---

### Task 7: `/bench` route and `bench.component.ts`

**Spec:** §8 (RBAC/route), §10 in full (layout, loading, the 2-decimal table).

**Files:**
- Create: `src/app/bench/bench.component.ts`
- Test: `src/app/bench/bench.component.spec.ts`
- Modify: `src/app/app.routes.ts` — new route beside line 58
- Modify: `src/app/app.ts` — new nav entry beside `/capacity`

**Interfaces:**
- Consumes: `getBenchMonthly()` (Task 6); `getHoursPerDay()`, `getHolidays()` (existing); `capacityGuard` (`role.guard.ts`, existing); `standardMonthlyHours`, `fteOf` (`capacity.util.ts`, existing); `authGatedResource` (existing util).
- Produces: the `/bench` page; nothing later tasks depend on.

- [ ] **Step 1: Route and nav (no test needed — pure config, verified by the component test's routing-free unit test plus a manual browser pass in Step 5)**

In `src/app/app.routes.ts`, add right after line 58 (`capacity` route):

```ts
  { path: 'bench', title: 'Bench', canMatch: [capacityGuard], loadComponent: () => import('./bench/bench.component').then(m => m.BenchComponent) },
```

In `src/app/app.ts`, add to the `Analytics` group items array right after the `Capacity` entry (line 444):

```ts
        { label: 'Bench', icon: 'event_busy', route: '/bench' },
```

And to the `Analytics` group's filter (line 523), add a line before the `return canReadStaffing;` fallback:

```ts
            if (item.route === '/bench') return canViewCapacity;
```

- [ ] **Step 2: Write the failing component test**

Create `src/app/bench/bench.component.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { BenchComponent } from './bench.component';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import type { BenchRollup } from '../services/bench.util';

const ROLLUP: BenchRollup = {
  months: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
  internalRows: [
    {
      resourceId: '7', resourceName: 'Priya Kapoor', kind: 'internal',
      monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: false } },
      availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' },
    },
  ],
  subcoRows: [
    {
      resourceId: '6', resourceName: 'Subco — Mediolanum Senior Developer', kind: 'subco',
      monthly: { '2026-04': { state: 'PARTIAL', upcomingUnallocated: true } },
      availabilityDate: { kind: 'date', date: '2026-05-01' },
    },
  ],
  hiringDemand: [{ month: '2026-04', role: 'Developer', hours: 176 }],
};

describe('BenchComponent', () => {
  async function setup() {
    await TestBed.configureTestingModule({
      imports: [BenchComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: {
          getBenchMonthly: () => of(ROLLUP),
          getHoursPerDay: () => of({ value: 8 }),
          getHolidays: () => of([]),
        } },
        { provide: AuthService, useValue: { authReady: () => true } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(BenchComponent);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    return fixture;
  }

  it('renders the subco row in the Subcontractors section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="subco-section"]')!.textContent ?? '';
    expect(text).toContain('Subco — Mediolanum Senior Developer');
  });
  it('does NOT render the subco row in the Internal section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="internal-section"]')!.textContent ?? '';
    expect(text).not.toContain('Subco — Mediolanum Senior Developer');
  });
  it('renders the internal row in the Internal section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="internal-section"]')!.textContent ?? '';
    expect(text).toContain('Priya Kapoor');
  });
  it('does NOT render the internal row in the Subcontractors section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="subco-section"]')!.textContent ?? '';
    expect(text).not.toContain('Priya Kapoor');
  });
  it('renders the hiring-demand FTE at 2 decimals', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="hiring-demand"]')!.textContent ?? '';
    // 176h / (22 working days * 8h/day = 176h target) = 1.00 FTE.
    expect(text).toContain('1.00');
  });
});
```

Note: use `host.querySelector('[data-test="..."]')` (not a generic-typed `querySelector<T>`) — this repo's TS setup does not compile `fixture.nativeElement.querySelector<T>()`.

- [ ] **Step 3: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/bench.component.spec.ts'
```
Expected: FAIL — the module does not exist.

- [ ] **Step 4: Implement `bench.component.ts`**

```ts
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { forkJoin, map } from 'rxjs';
import { ApiService } from '../services/api.service';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { fteOf, standardMonthlyHours } from '../services/capacity.util';
import { EMPTY_BENCH_ROLLUP, type AvailabilityDate, type BenchRollup, type BenchRow } from '../services/bench.util';
import { ListStateComponent } from '../shared/list-state.component';

interface BenchPageData {
  rollup: BenchRollup;
  hoursPerDay: number;
  holidays: string[];
}

@Component({
  selector: 'app-bench',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Capacity Control</div>
          <h1 class="command-title">Bench</h1>
          <p class="command-subtitle">Unallocated and partially-allocated resources, aging, and the 6-month availability outlook.</p>
        </div>
      </header>

      <app-list-state [loading]="loading()" [error]="hasError()" skeleton="table-rows" [rows]="5" label="bench data" (retry)="reload()">
        <ng-template>
          <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
            <section class="command-card overflow-hidden" data-test="internal-section">
              <div class="command-card-header">
                <div>
                  <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Internal</h2>
                  <p class="mt-1 text-sm text-[var(--cc-muted)]">{{ internalBenchCount() }} on bench &middot; {{ internalBenchPct() | number:'1.0-0' }}% of active</p>
                </div>
                <span class="command-status" [class.red]="internalBenchCount() > 0" [class.green]="internalBenchCount() === 0">{{ internalBenchCount() }}</span>
              </div>
              <div class="overflow-x-auto">
                <table class="command-data-table">
                  <thead>
                    <tr>
                      <th scope="col">Resource</th>
                      <th scope="col">Status</th>
                      <th scope="col">Freeing up</th>
                      <th scope="col">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of internalRows(); track row.resourceId) {
                      <tr>
                        <td class="font-semibold text-[var(--cc-ink)]">{{ row.resourceName }}</td>
                        <td><span class="command-status" [class.red]="cellState(row) === 'BENCH'" [class.amber]="cellState(row) === 'PARTIAL'" [class.green]="cellState(row) === 'ALLOCATED'">{{ cellState(row) }}{{ agingSuffix(row) }}</span></td>
                        <td>@if (isFreeingUp(row)) { <span class="command-status amber">Freeing up next month</span> }</td>
                        <td class="font-mono tabular-nums">{{ availabilityLabel(row.availabilityDate) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="text-center text-[var(--cc-muted)]">No internal resources in the shown window.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>

            <section class="command-card overflow-hidden" data-test="subco-section">
              <div class="command-card-header">
                <div>
                  <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Subcontractors</h2>
                  <p class="mt-1 text-sm text-[var(--cc-muted)]">{{ subcoBenchCount() }} on bench &middot; {{ subcoBenchPct() | number:'1.0-0' }}% of active</p>
                </div>
                <span class="command-status" [class.red]="subcoBenchCount() > 0" [class.green]="subcoBenchCount() === 0">{{ subcoBenchCount() }}</span>
              </div>
              <div class="overflow-x-auto">
                <table class="command-data-table">
                  <thead>
                    <tr>
                      <th scope="col">Resource</th>
                      <th scope="col">Status</th>
                      <th scope="col">Freeing up</th>
                      <th scope="col">Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of subcoRows(); track row.resourceId) {
                      <tr>
                        <td class="font-semibold text-[var(--cc-ink)]">{{ row.resourceName }}</td>
                        <td><span class="command-status" [class.red]="cellState(row) === 'BENCH'" [class.amber]="cellState(row) === 'PARTIAL'" [class.green]="cellState(row) === 'ALLOCATED'">{{ cellState(row) }}{{ agingSuffix(row) }}</span></td>
                        <td>@if (isFreeingUp(row)) { <span class="command-status amber">Freeing up next month</span> }</td>
                        <td class="font-mono tabular-nums">{{ availabilityLabel(row.availabilityDate) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="text-center text-[var(--cc-muted)]">No subcontractors in the shown window.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section class="command-card overflow-hidden" data-test="hiring-demand">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Hiring Demand</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Hours still booked on placeholder (dummy) resources, by month and role.</p>
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col">Role</th>
                    <th scope="col" class="num">FTE</th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of hiringDemand(); track d.month + d.role) {
                    <tr>
                      <td>{{ d.month }}</td>
                      <td class="text-[var(--cc-muted)]">{{ d.role }}</td>
                      <td class="num font-mono tabular-nums">{{ fteFor(d.month, d.hours) | number:'1.0-2' }}</td>
                    </tr>
                  } @empty {
                    <tr><td colspan="3" class="text-center text-[var(--cc-muted)]">No hiring demand in the shown window.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        </ng-template>
      </app-list-state>
    </div>
  `,
})
export class BenchComponent {
  private readonly api = inject(ApiService);

  private static readonly EMPTY: BenchPageData = { rollup: EMPTY_BENCH_ROLLUP, hoursPerDay: 8, holidays: [] };
  private static readonly DATE_FMT = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  private readonly dataRes = authGatedResource<BenchPageData>(
    () => forkJoin({
      rollup: this.api.getBenchMonthly(),
      hoursPerDay: this.api.getHoursPerDay().pipe(map(r => r.value)),
      holidays: this.api.getHolidays().pipe(map(hs => hs.map(h => h.id))),
    }),
    BenchComponent.EMPTY,
  );

  readonly loading = computed(() => this.dataRes.isLoading());
  readonly hasError = computed(() => this.dataRes.status() === 'error');
  reload(): void { this.dataRes.reload(); }

  private readonly rollup = computed(() => this.dataRes.value().rollup);
  private readonly currentMonth = computed(() => this.rollup().months[0] ?? '');
  readonly internalRows = computed<BenchRow[]>(() => this.rollup().internalRows);
  readonly subcoRows = computed<BenchRow[]>(() => this.rollup().subcoRows);
  readonly hiringDemand = computed(() => this.rollup().hiringDemand);

  readonly internalBenchCount = computed(() => this.internalRows().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length);
  private readonly internalActiveCount = computed(() => this.internalRows().filter(r => r.monthly[this.currentMonth()] !== undefined).length);
  readonly internalBenchPct = computed(() => (this.internalActiveCount() > 0 ? (this.internalBenchCount() / this.internalActiveCount()) * 100 : 0));

  readonly subcoBenchCount = computed(() => this.subcoRows().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length);
  private readonly subcoActiveCount = computed(() => this.subcoRows().filter(r => r.monthly[this.currentMonth()] !== undefined).length);
  readonly subcoBenchPct = computed(() => (this.subcoActiveCount() > 0 ? (this.subcoBenchCount() / this.subcoActiveCount()) * 100 : 0));

  cellState(row: BenchRow): string {
    return row.monthly[this.currentMonth()]?.state ?? '';
  }
  agingSuffix(row: BenchRow): string {
    const bucket = row.monthly[this.currentMonth()]?.agingBucket;
    return bucket ? ` (${bucket})` : '';
  }
  isFreeingUp(row: BenchRow): boolean {
    return row.monthly[this.currentMonth()]?.upcomingUnallocated ?? false;
  }
  availabilityLabel(a: AvailabilityDate): string {
    return a.kind === 'date'
      ? BenchComponent.DATE_FMT.format(new Date(a.date + 'T00:00:00Z'))
      : `Beyond ${BenchComponent.MONTH_FMT.format(new Date(a.horizonEndMonth + '-01T00:00:00Z'))}`;
  }
  fteFor(month: string, hours: number): number {
    const holSet = new Set(this.dataRes.value().holidays);
    return fteOf(hours, standardMonthlyHours(month, this.dataRes.value().hoursPerDay, holSet));
  }
}
```

Verify every `command-*` class used above (`command-page`, `command-header`, `command-eyebrow`, `command-title`, `command-subtitle`, `command-card`, `command-card-header`, `command-status`, `command-data-table`) exists in `src/styles.css` — all are already used verbatim in `src/app/forecast/forecast.ts` and `src/app/capacity/capacity.component.ts`, so this is a reuse, not an invention.

- [ ] **Step 5: Run it green, then the gates and a browser pass**

```bash
./node_modules/.bin/ng test --include='**/bench.component.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

Then on port **4173** (build + `env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs`): open `/bench`, confirm the Internal and Subcontractors sections both render with distinct rows (resource `'6'` only under Subcontractors, resource `'7'` only under Internal, per Task 1's seed), the hiring-demand table shows 6 rows for `Developer`, and the availability column shows a real date or "Beyond <month>" for every row, never blank.

- [ ] **Step 6: Mutate and confirm red**

In `bench.component.ts`, change `internalRows = computed<BenchRow[]>(() => this.rollup().internalRows);` to return `this.rollup().subcoRows` instead. Run the component spec: **"renders the internal row in the Internal section"** goes red (Priya Kapoor no longer appears there) and **"does NOT render the subco row in the Internal section"** ALSO goes red (the subco row now appears there instead). Revert.

- [ ] **Step 7: Commit**

```bash
git add src/app/bench src/app/app.routes.ts src/app/app.ts
git commit -m "feat: /bench dashboard (internal/subco sections, hiring demand, availability)"
```

---

### Task 8: `/utilization` bench badge

**Spec:** §9's `/utilization` row in full.

**Files:**
- Modify: `src/app/utilization/utilization.component.ts` — `UtilizationData`, `dataResource` forkJoin, per-row badge, a missing error-state affordance (Global Constraint)
- Modify: `src/app/utilization/utilization.component.spec.ts`

**Interfaces:**
- Consumes: `getBenchMonthly()` (Task 6).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

In `src/app/utilization/utilization.component.spec.ts` (read the file's existing setup helper first and mirror its exact mock-provider shape), add:

```ts
it('shows a BENCH badge for an internal/subco team member on bench this month', async () => {
  // Arrange the mocked ApiService.getBenchMonthly() to return a rollup where
  // the seeded direct-report resource is BENCH in the current month; assert
  // the badge text 'BENCH' appears on that resource's row.
});
it('shows "Not applicable" for a dummy resource that has a manager (never BENCH, never omitted)', () => {
  // A dummy row in managedResources() must render a distinct 'Not applicable'
  // badge — not the loading skeleton, not an empty cell.
});
it('does NOT show "Not applicable" on a real internal/subco row (the twin absence check)', () => {
  // Pairs with the previous test: an internal resource's badge must never
  // read 'Not applicable'.
});
```

Fill each body against the file's real mock-provider setup (read it first — do not invent a second style). Mock `getBenchMonthly()` to return a small `BenchRollup` containing exactly the resource ids the test's `managedResources()` fixture already uses.

- [ ] **Step 2: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/utilization.component.spec.ts'
```

- [ ] **Step 3: Implement**

Extend `UtilizationData` and the forkJoin:

```ts
import type { BenchRollup } from '../services/api.service';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';

interface UtilizationData {
  resources: Resource[];
  assignments: Assignment[];
  requests: ResourceRequest[];
  timeEntries: TimeEntry[];
  orgs: ResourceOrganization[];
  benchRollup: BenchRollup;
}
```

In the `dataResource` forkJoin (lines 298-322), add `benchRollup: this.api.getBenchMonthly(),` as a REQUIRED leg (no `catchError` — unlike the `orgs` leg, a bench-fetch failure must not silently degrade to "nobody is on bench"; Global Constraint: a failed read must show an error, never a confident zero). Add `benchRollup: EMPTY_BENCH_ROLLUP` to both the `of<UtilizationData>({...})` fallback and `defaultValue`.

Add the computed lookups and the missing error affordance:

```ts
  private readonly currentBenchMonth = computed(() => this.dataResource.value().benchRollup.months[0] ?? '');
  private readonly benchByResourceId = computed(() => {
    const roll = this.dataResource.value().benchRollup;
    return new Map([...roll.internalRows, ...roll.subcoRows].map(r => [r.resourceId, r]));
  });
  benchBadge(res: Resource): string {
    if (kindOf(res) === 'dummy') return 'Not applicable';
    const row = this.benchByResourceId().get(res.id);
    return row?.monthly[this.currentBenchMonth()]?.state ?? '';
  }
  protected readonly hasError = computed(() => this.dataResource.status() === 'error');
```

Wrap the "My Team" list (the `@for (res of managedResources(); ...)` block, lines 89-136) in `<app-list-state>`:

```html
          <div class="overflow-y-auto flex-1 divide-y divide-[var(--cc-line)]">
            <app-list-state [loading]="dataResource.isLoading()" [error]="hasError()" skeleton="cards" [rows]="4" label="team utilization" (retry)="dataResource.reload()">
              <ng-template>
                @for (res of managedResources(); track res.id) {
                  <div class="p-6 hover:bg-surface-muted transition-all cursor-pointer group relative" ...>
                    ...
                    <span class="command-status" [class.neutral]="benchBadge(res) === 'Not applicable'" [class.red]="benchBadge(res) === 'BENCH'" [class.amber]="benchBadge(res) === 'PARTIAL'" [class.green]="benchBadge(res) === 'ALLOCATED'">{{ benchBadge(res) }}</span>
                    ...
                  </div>
                }
                @if (managedResources().length === 0) {
                  ...unchanged...
                }
              </ng-template>
            </app-list-state>
          </div>
```

Add `ListStateComponent` to the component's `imports` array. Keep every existing binding inside the `@for` unchanged — only add the new badge `<span>` and the wrapping `<app-list-state>`.

- [ ] **Step 4: Run it green, then the gates**

```bash
./node_modules/.bin/ng test --include='**/utilization.component.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Mutate and confirm red**

In `benchBadge`, change `if (kindOf(res) === 'dummy') return 'Not applicable';` to check `'internal'` instead of `'dummy'`. Run the spec: the "Not applicable" test now fails for the dummy row (it gets a real state instead) AND the "does NOT show Not applicable on a real internal row" test now fails (an internal row gets 'Not applicable' instead). Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/utilization/utilization.component.ts src/app/utilization/utilization.component.spec.ts
git commit -m "feat: bench-state badge on /utilization, with a Not applicable state for dummy rows"
```

---

### Task 9: `/dashboard` "In Bench" tile

**Spec:** §9's `/dashboard` row in full.

**Files:**
- Modify: `src/app/dashboard/dashboard.component.ts` — `DashboardData`, `EMPTY_DATA`, `dataRes` forkJoin, new tile
- Modify: `src/app/dashboard/dashboard.component.spec.ts`

**Interfaces:**
- Consumes: `getBenchMonthly()` (Task 6).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

In `src/app/dashboard/dashboard.component.spec.ts` (read the existing setup helper first), add:

```ts
it('shows separate internal and subco bench counts, never a combined total', async () => {
  // Mock getBenchMonthly() with 2 internal BENCH rows and 1 subco BENCH row
  // (current month). Assert the tile shows '2' and '1' — NOT '3' anywhere.
});
```

> **Correction (Task 10, added after implementation and verification against the
> real seed — do not re-derive this):** the "2 internal / 1 subco" numbers above
> are a **unit-test mock**, purpose-built for this one test, and are correct as
> written — a unit fixture need not match `src/db/seed.ts`. But if read as a
> prediction of what the *real*, seed-backed `/dashboard` tile shows today, it is
> wrong. Running the real `benchRollup()` (`src/app/services/bench.util.ts`) over
> `src/db/seed.ts`, replicating `GET /bench/monthly`'s default-`from` logic
> (first `Open` planning period, sorted → `2026-04`) gives, at that anchor month:
> internal BENCH count = **4** (resources `1` Julie Armstrong, `2` John Miller,
> `3` Alice Smith, `8` Marco Belli — resource `7` Priya Kapoor is internal but
> ALLOCATED, not BENCH), subco BENCH count = **0** (subcontractor resource `6` is
> **PARTIAL**, not BENCH, in April — its 0.4h day rounds to "0.00%" on screen but
> is a real, non-zero booking, so `benchStateFor` classifies it PARTIAL; it only
> reaches BENCH from May, per the design spec's own §11 fixture table). So the
> real `/dashboard` tile reads **"4 int. / 0 subco"**, not "2 int. / 1 subco".
> See `.superpowers/sdd/2026-08-05-f-bench-availability/task-9-report.md`
> ("Seed-derivation correction, restated for the durable record") for the full
> derivation and its history.

- [ ] **Step 2: Run it to verify it fails**

```bash
./node_modules/.bin/ng test --include='**/dashboard.component.spec.ts'
```

- [ ] **Step 3: Implement**

```ts
import type { BenchRollup } from '../services/api.service';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';
```

Add `benchRollup: BenchRollup;` to `DashboardData`, `benchRollup: EMPTY_BENCH_ROLLUP,` to `EMPTY_DATA` (line 566-581), and `benchRollup: this.api.getBenchMonthly(),` as a new leg of the `dataRes` forkJoin, appended AFTER the existing `hoursPerDay` leg (line 629) — never inserted mid-block, matching this file's own stated convention for avoiding merge collisions on this exact forkJoin.

Add the computed signals:

```ts
  private readonly currentBenchMonth = computed(() => this.dataRes.value().benchRollup.months[0] ?? '');
  readonly internalBenchCount = computed(() =>
    this.dataRes.value().benchRollup.internalRows.filter(r => r.monthly[this.currentBenchMonth()]?.state === 'BENCH').length,
  );
  readonly subcoBenchCount = computed(() =>
    this.dataRes.value().benchRollup.subcoRows.filter(r => r.monthly[this.currentBenchMonth()]?.state === 'BENCH').length,
  );
```

Add the tile to the 4-tile grid at lines 264-303, changing `grid-cols-1 lg:grid-cols-4` to `grid-cols-1 lg:grid-cols-5` and appending a 5th `command-card-muted`:

```html
        <div class="command-card-muted p-4">
          <div class="command-kpi-label">In Bench</div>
          <div class="mt-2 flex items-end justify-between gap-3">
            <span class="font-mono text-2xl font-semibold text-[var(--cc-ink)]">{{ internalBenchCount() }} <span class="text-sm font-normal text-ink-muted">int.</span> / {{ subcoBenchCount() }} <span class="text-sm font-normal text-ink-muted">subco</span></span>
            <a routerLink="/bench" class="text-sm font-bold text-[var(--cc-primary)]">Bench</a>
          </div>
        </div>
```

Never write `internalBenchCount() + subcoBenchCount()` anywhere in this component (spec §4/§12: no combined total, on any surface).

- [ ] **Step 4: Run it green, then the gates**

```bash
./node_modules/.bin/ng test --include='**/dashboard.component.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

- [ ] **Step 5: Mutate and confirm red**

Change `internalRows.filter(r => r.monthly[this.currentBenchMonth()]?.state === 'BENCH')` to `.state !== 'ALLOCATED'` (i.e., silently start counting PARTIAL as bench too). Run the spec: the count test goes red (now includes PARTIAL rows in the internal count). Revert.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/dashboard.component.ts src/app/dashboard/dashboard.component.spec.ts
git commit -m "feat: In Bench tile on /dashboard, two separate counts"
```

---

### Task 10: Docs, sweep, full verification

**Spec:** §2 (no schema), §4 (the split), §8 (RBAC), §12 (out of scope) — cross-check every one against the docs below.

**Files:**
- Modify: `docs/architecture/03-backend-and-data.md` — new derived-view section for Block F (no new table)
- Modify: `docs/architecture/02-frontend.md` — `/bench` route, the retired `benchList`
- Modify: `docs/roles-and-permissions.md` — `/bench` under the `/capacity` rule, both read
- Modify: whatever the sweep turns up

- [ ] **Step 1: Sweep for stale references**

```bash
grep -rn "benchList\|BenchEntry" src docs
grep -rn "thresholdPct" src/app/services/forecast.util.ts
```
The first must return nothing (Task 5 already asserted this once; re-confirm here after all later tasks). The second confirms `overAllocated`'s own `thresholdPct` parameter (a DIFFERENT, still-valid concept — over-allocation, not bench) was not accidentally touched.

- [ ] **Step 2: Docs**

`docs/architecture/03-backend-and-data.md`: add a short subsection alongside the existing B2/capacity description — Block F is pure derivation over the same four inputs (`resources`, `assignments`, `assignmentDays`, `assignmentMonths`), no migration, `GET /bench/monthly` fetches a 9-month window (2 look-back + 6 shown + 1 look-ahead) and returns the 6 shown months split by `countsTowardDeliveryCapacity` (internal/subco bench, dummy hiring demand).

`docs/architecture/02-frontend.md`: add `/bench` to the route table; note that `/forecast`'s bench panel now calls `bench.util.ts` directly (client-side, via the raw `/assignment-days`/`/assignment-months` reads, shared with block E) rather than the retired `benchList`/`BenchEntry`.

`docs/roles-and-permissions.md`: add `/bench` to the `/capacity` READ_RULE's row (same 5 roles), with the same rationale spec §8 gives (pm/resource-manager: staffing tool; delivery-executive: cross-delivery oversight; finance: idle dummy/subco cost is P&L-relevant, the "Unchargeable" half of the name; employee/sales explicitly excluded).

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

- [ ] **Step 4: Fresh-Postgres run — not a new gate, but still owed**

Spec §11: "not a new gate" since there is no migration, but the general dual-adapter parity obligation still applies (Block F's new endpoints read the SAME repos both adapters already implement). Create a genuinely fresh Postgres database (`docker compose up -d postgres`), run the built server against it with `DATABASE_URL` set, re-run the smoke suite, confirm `/bench/monthly` and `/assignment-days`/`/assignment-months` return the same shapes as the in-memory run, then drop the database. If Docker is unavailable, say so prominently rather than skipping silently.

- [ ] **Step 5: Browser verification**

On port 4173: `/bench` (both sections + hiring demand, as in Task 7 Step 5); `/utilization` in BOTH `teamScope` views (`direct` and `org`), including the `Not applicable` badge on a dummy row if one falls in scope; `/dashboard`'s new tile; `/forecast`'s retargeted Bench card (confirm it links to `/bench`); `/forecast/what-if`'s "On Bench" KPI still moves when using the "Hire" lever (a newly hired scenario resource should increase the scenario bench count, since it starts with zero bookings).

- [ ] **Step 6: Commit**

```bash
git add -A docs
git commit -m "docs: Block F bench/availability in the architecture and RBAC references"
```

---

## Verification Checklist (before merge)

- [ ] A subcontractor under-allocated for a month appears in `subcoRows`, never `internalRows` — the `2cb462b`-class regression this plan mutates for explicitly (Task 3).
- [ ] A dummy resource NEVER appears in `internalRows`/`subcoRows`, on any surface (`/bench`, `/utilization`, `/dashboard`, `/forecast`) — but DOES drive `hiringDemand` when it carries real booked hours.
- [ ] `benchStateFor` classifies on raw hours: 0.4h out of ~176h target is PARTIAL, not BENCH.
- [ ] Aging buckets: B (≤1 month idle), C (2), D (≥3, capped) — a resource hired mid-window starts at B even with no prior data.
- [ ] `upcomingUnallocated` is mutually exclusive with a BENCH state the same month, and requires the resource to still be ACTIVE next month (a termination is not "freeing up").
- [ ] `availabilityDate` is NEVER absent: a concrete date, or `beyond-horizon` on the last shown month — computed only from the 6 shown months, never the look-ahead month.
- [ ] `/forecast` and `/forecast/what-if` no longer import `benchList`/`BenchEntry` — `grep -rn "benchList|BenchEntry" src` returns nothing.
- [ ] `/bench` shipped only AFTER `/forecast`'s retarget (Task 5 before Task 7) — no commit in this branch's history has both an old-benchList `/forecast` and a live `/bench`.
- [ ] `GET /bench/monthly` is reachable by exactly pm/resource-manager/delivery-executive/finance/admin — an `employee` gets 403.
- [ ] `GET /assignment-days`/`GET /assignment-months` are root-level, hyphenated paths (never `/assignments/days`/`/assignments/months`), reachable by exactly pm/resource-manager/delivery-executive/finance/admin via ONE shared `READ_RULES` entry — not duplicated if block E already added it.
- [ ] A failed `/bench/monthly` read shows a Retry affordance on `/bench` and `/utilization`, never a silent empty list.
- [ ] Every displayed percentage/FTE uses an explicit `digitsInfo` of `1.0-0` or `1.0-2` — none defaults to `DecimalPipe`'s bare `1.0-3`.
- [ ] No surface sums `internalBenchCount + subcoBenchCount` into one figure.
- [ ] Unit, lint, build, live smoke and the fresh-Postgres parity run are all green.

## Self-Review

**Spec section → task mapping:**
- §1 (gap analysis) — no task; it is the spec's own justification, not a requirement to implement.
- §2 (pure derivation, no migration) — honored by every task: no `drizzle-kit generate` step anywhere in this plan, confirmed in Task 3/6's design.
- §3 (BENCH/PARTIAL/ALLOCATED thresholds) — Task 2 (`benchStateFor`).
- §4 (delivery-capacity split, subco-in-bench) — Task 3 (`benchRollup`'s `countsTowardDeliveryCapacity` partition), mutated explicitly in Task 3 Step 10.
- §5.1 (aging buckets) — Task 2 (`monthsIdleAt`/`bucketForMonthsIdle`).
- §5.2 (forward-looking signal) — Task 2 (`freeingUpNextMonth`).
- §6 (hiring demand from dummies) — Task 3 (`hiringDemandByMonth`), consumed at render time in Task 7 (`fteFor`).
- §7 (availability date, 3 branches, 6-month-only scope) — Task 2 (`availabilityDateFor`), the look-ahead/display-scope separation pinned by Task 3's resource-7 fixture test.
- §8 (endpoint, 9-month fetch window, RBAC) — Task 6.
- §8 ("no export shared for round2") — noted in Task 7; the bench page uses `DecimalPipe` digitsInfo directly, no manual `round2` needed since no non-pipe rounded text is produced.
- §9 consumption table — `/capacity` (no task, untouched by design); `/utilization` (Task 8); `/dashboard` (Task 9); `/forecast`+`/forecast/what-if` (Tasks 4-5); `app.ts overbookedBadge` (no task, untouched by design); `/reporting` (no task, untouched by design); `/my-profile` etc. (no task, out of scope by design); `/config/availability` (no task, false-match, explicitly not this feature).
- §10 (UI layout, loading/error states, 2-decimal table) — Task 7 (page), Task 8/9 (badge/tile error-state additions beyond what the spec explicitly wrote out, justified against the Global Constraints).
- §11 (verification) — Tasks 1 (seed), 2/3 (unit + integration tests), 4/6 (smoke), 10 (browser + fresh-Postgres).
- §12 (out of scope) — no task adds a combined total, a historical substitution report, a cost/rate figure, a `/bench`-own manager scope, a skill-match on hiring demand, or an offboarding signal; verified by the Verification Checklist's explicit no-combined-total line and by Task 2's `freeingUpNextMonth` test for the termination case.

**Placeholder scan:** no step in this plan contains "TBD", "add appropriate error handling", "add validation", "write tests for the above", or "similar to Task N" — every code block is complete and every command has its expected output stated. (Task 5 Step 6/7 and Task 8/9 Step 1 point at "the file's existing setup helper" rather than inlining it, because that helper is a pre-existing fixture in a file this plan does not otherwise rewrite — reading it first is a normal part of extending a spec file, not a stand-in for undecided content.)

**Name/type consistency across tasks:**
- `BenchState`, `BenchCell`, `BenchRow`, `BenchRollup`, `BenchRollupInput`, `HiringDemandRow`, `AvailabilityDate`, `UnallocatedAgingBucket`, `UNALLOCATED_AGING_BUCKETS`, `EMPTY_BENCH_ROLLUP` are defined once (Tasks 2-3) and referenced by the identical name/shape in every later task (4 does not touch them; 5, 6, 7, 8, 9 all import them unchanged).
- `benchStateFor`, `monthsIdleAt`, `bucketForMonthsIdle`, `freeingUpNextMonth`, `availabilityDateFor` (Task 2), `hoursByResourceMonth` (Task 3, in `capacity.util.ts`), `hiringDemandByMonth`, `benchRollup` (Task 3), `notFullyAllocatedAt` (Task 5) — each defined exactly once, consumed under that exact name everywhere else.
- `getAssignmentDays`/`getAssignmentMonths` (Task 4) are consumed only by Task 5 (forecast/what-if), never by Task 7/8/9, which instead all use `getBenchMonthly` (Task 6) — this asymmetry is intentional (client-only What-If sandbox vs. server-aggregated real-data pages) and is stated explicitly in Task 4's own preamble so a reviewer does not mistake it for an inconsistency.
- Seed ids from Task 1 (`'6'`/`'4'`/`'5'`/`'7'`/`'8'`/`'9'` resources; `'7'`-`'11'` requests/assignments) are referenced by the identical ids in Task 3's integration test, and nowhere else by number — Tasks 4-10 reference resources only structurally (via the API), never by hard-coded id, except Task 6's and Task 7's smoke/manual checks, which reuse the same `'6'`/`'7'` ids Task 1 defined.

**Spec citations that no longer matched the tree when re-checked today** (the spec's own note that citations were fresh as of yesterday but the tree moved earlier today):
- `src/db/schema.ts`: `replacedFromAssignmentMonthId` is now at line **251** (spec cited 250), `replacedDays`/`replacedBaselineDays` now at **252-253** (spec cited 251-252) — 1-line drift, no functional impact on this plan (Block F never touches these columns).
- `src/server.ts`: `transferDummyMonth()` is now at line **2810** (spec cited 2476-2679) and `dummyMonthHours()` is now at line **3038-3043** (spec cited 2686-2691) — roughly 330-350 lines of drift, most likely from other work landing earlier in the file. Neither function is modified by this plan; the spec's §6 argument about `replacedFromAssignmentMonthId` not surviving long enough to answer "hiring demand" still holds structurally regardless of the exact line numbers, and Task 3's `hiringDemandByMonth` was designed against the CURRENT `capacity.util.ts:38`'s `PLANNED` set, not against `dummyMonthHours`'s own (unfiltered) sum — so this task's implementation does not depend on the drifted lines at all.
- `src/app/services/finance.util.ts`: the spec's loose citation "348-440" for the AR-aging apparatus undershoots `arAging()` itself, which is at lines 447-462. `AR_AGING_BUCKETS` (370), `bucketForDaysOverdue` (405-411) and `emptyBuckets()` (427-434) do fall inside the cited range. Cosmetic only — this plan cites the corrected, verified line numbers directly rather than repeating the spec's range.
- All other citations this plan depends on (`capacity.util.ts` 5/30-35/38/43-44/46-52/53-62/63-68/70-135; `resource-kind.util.ts` 75-77/96-98; `server.ts` 701-734 RBAC tables, 3541-3581 `/capacity/monthly`, 17 the capacity.util import; `role.guard.ts` 65; `app.routes.ts` 58; `db/seed.ts` 246 the anchor month; `dashboard.component.ts` 566-633; `reporting.ts` 249; `utilization.component.ts` 298-299/343/351-357/367-374; `capacity.component.ts` 326/502-510) were re-verified directly against the current tree while writing this plan and matched exactly.
