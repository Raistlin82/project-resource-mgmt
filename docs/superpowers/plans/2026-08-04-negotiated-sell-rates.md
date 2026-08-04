# Negotiated sell rates: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a sell price be negotiated per contract (with a per-project override) and per profile, so T&M revenue stops billing the same profile at one price to every customer.

**Architecture:** A new pure layer (`sell-rate.util.ts`) holds the three-level precedence — project override, contract rate valid on the hours' date, then today's reference `billRate`. A new `negotiated_rates` table carries the rates, with `contractId` **xor** `projectId`. The single consumption point that matters is the as-incurred revenue line in `finance.util.ts`; cost and the company-wide billability figure are deliberately untouched.

**Tech Stack:** Angular 21 (standalone, signals, OnPush), Express 5, Drizzle ORM + PostgreSQL, Vitest, dependency-free scripts.

**Spec:** `docs/superpowers/specs/2026-08-04-negotiated-sell-rates-design.md` — authoritative. Read the section named in each task.

## Global Constraints

- **All UI copy in English.** Bespoke design system: `command-*` classes + tokens in `src/styles.css`, Material for icons only, **no new tokens**.
- **Angular 21 house style:** standalone, `OnPush`, signals, native control flow, `inject()` in field initializers. Never snapshot `auth.userId()`/`auth.role()` at field-init. Principal-gated reads key their `rxResource` params on `auth.authReady()`.
- **Never bind `[value]` on a `<select>` whose `<option>`s come from an `@for`** — silently dropped; use per-`<option>` `[selected]`.
- **Component specs assert on rendered DOM**, not signal values. An `rxResource`-backed load needs a flush before asserting; `whenStable()` **hangs** while such a stream is open, so use microtask ticks for a still-pending checkpoint.
- **`fixture.nativeElement.querySelector<T>(...)` does not compile** (generics on an `any`-typed callee). Cast the host once, then `host.querySelector<T>(...)`.
- **The pure layer takes no clock.** `sellRateFor` receives the date as a **value**; the caller supplies it.
- **`pick()` forwards an explicit JSON `null`** (it filters only `undefined`). On a `notNull` column that corrupts the row in-memory and 500s on Postgres, so required fields are declared **once** in a list and rejected in one loop — from the first commit, not after three review rounds.
- **`src/db/seed.ts` is the single source of truth for seed data**, consumed by both adapters.
- **Dual-adapter seam:** `nullsToUndefined()` on every *return* path, never on values handed to `.set()`; explicit `null` in a patch means "clear to absent", `undefined` means "leave untouched".
- **Money is `doublePrecision`** in this schema, matching the existing `rate_cards` columns. Do not introduce `numeric` here.
- **Every new check must be shown red before it passes.** A check that never failed proves nothing — and for every assertion of presence, write the one for absence.
- Do not use double quotes in commit subjects or in new headings.

---

### Task 1: The pure sell-rate layer

**Spec:** §4 and §4.1 in full.

**Files:**
- Create: `src/app/services/sell-rate.util.ts`
- Test: `src/app/services/sell-rate.util.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces — later tasks depend on these exact signatures:

```ts
export interface NegotiatedRate {
  id: string;
  contractId?: string;
  projectId?: string;
  role: string;
  currency: string;
  billRate: number;   // EUR per DAY, like rateCards
}
/** Minimal shapes this layer needs — structurally satisfied by the real entities. */
export interface SellRateProject { id: string; contractId?: string }
export interface SellRateContract { id: string; startDate: string; endDate?: string }

export const SELL_RATE_BASE_CURRENCY = 'EUR';

export function sellRateFor(args: {
  projectId: string | undefined;
  role: string | undefined;
  /** ISO 'YYYY-MM-DD' of the hours being priced. A VALUE — this layer never reads a clock. */
  date: string;
  referenceBillRate: number | undefined;
  rates: readonly NegotiatedRate[];
  projects: readonly SellRateProject[];
  contracts: readonly SellRateContract[];
}): number | undefined;
```

- [ ] **Step 1: Write the failing spec**

```ts
import { describe, it, expect } from 'vitest';
import { sellRateFor, type NegotiatedRate, type SellRateContract, type SellRateProject } from './sell-rate.util';

const CONTRACTS: SellRateContract[] = [
  { id: 'C1', startDate: '2026-01-01', endDate: '2026-12-31' },
  { id: 'C2', startDate: '2026-06-01' },                       // open-ended
];
const PROJECTS: SellRateProject[] = [
  { id: 'P1', contractId: 'C1' },
  { id: 'P2', contractId: 'C1' },
  { id: 'P3', contractId: 'C2' },
  { id: 'P9' },                                                 // no contract
];
const RATES: NegotiatedRate[] = [
  { id: 'N1', contractId: 'C1', role: 'Developer', currency: 'EUR', billRate: 1000 },
  { id: 'N2', projectId: 'P2', role: 'Developer', currency: 'EUR', billRate: 1100 },
  { id: 'N3', contractId: 'C1', role: 'Designer', currency: 'USD', billRate: 900 },
  { id: 'N4', projectId: 'P9', role: 'Developer', currency: 'EUR', billRate: 1300 },
];

const call = (o: Partial<Parameters<typeof sellRateFor>[0]> = {}) => sellRateFor({
  projectId: 'P1', role: 'Developer', date: '2026-03-01', referenceBillRate: 1200,
  rates: RATES, projects: PROJECTS, contracts: CONTRACTS, ...o,
});

describe('sellRateFor — precedence', () => {
  it('uses the contract rate inside the contract period', () => {
    expect(call()).toBe(1000);
  });

  it('lets a project override beat the contract rate', () => {
    expect(call({ projectId: 'P2' })).toBe(1100);
  });

  it('falls back to the reference rate outside the contract period', () => {
    // C1 ends 2026-12-31; these hours are dated after it.
    expect(call({ date: '2027-02-01' })).toBe(1200);
  });

  it('honours an open-ended contract with no endDate', () => {
    expect(call({ projectId: 'P3', date: '2030-01-01', rates: [
      { id: 'N5', contractId: 'C2', role: 'Developer', currency: 'EUR', billRate: 950 },
    ] })).toBe(950);
  });

  it('does not apply a contract rate to hours before the contract started', () => {
    expect(call({ date: '2025-12-31' })).toBe(1200);
  });

  it('applies a project override with no date limit when the project has no contract', () => {
    expect(call({ projectId: 'P9', date: '2099-01-01' })).toBe(1300);
  });

  it('ignores a rate in a non-base currency', () => {
    expect(call({ role: 'Designer' })).toBe(1200);   // N3 is USD
  });

  it('falls back for a role nobody negotiated', () => {
    expect(call({ role: 'QA Engineer' })).toBe(1200);
  });

  it('returns the reference rate when the table is empty — the no-regression guarantee', () => {
    expect(call({ rates: [] })).toBe(1200);
  });

  it('returns undefined when there is no rate anywhere and no reference', () => {
    expect(call({ rates: [], referenceBillRate: undefined })).toBeUndefined();
  });

  it('DOES NOT let a higher personal reference beat the negotiated price', () => {
    // The case that would only surface at month end, on a wrong invoice: the
    // customer signed 1000, so 1000 is billed even though this person's own
    // reference rate is 1500.
    expect(call({ referenceBillRate: 1500 })).toBe(1000);
  });

  it('tolerates an unknown project and an absent projectId', () => {
    expect(call({ projectId: 'NOPE' })).toBe(1200);
    expect(call({ projectId: undefined })).toBe(1200);
  });

  it('tolerates an absent role', () => {
    expect(call({ role: undefined })).toBe(1200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./node_modules/.bin/ng test --include='**/sell-rate.util.spec.ts'`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

```ts
/**
 * Negotiated SELL rates (design spec §4). PURE: no I/O, no clock, no Angular.
 *
 * THE SELL PRICE IS NOT A PROPERTY OF THE PERSON. The same profile can be sold
 * at 1200/day to one customer and 1000/day to another, so it cannot live on the
 * resource — it belongs to the (contract-or-project, role) pair. Cost is a
 * different question and is NOT touched by this layer.
 *
 * PRECEDENCE, first match wins:
 *   1. a rate on THIS PROJECT for this role;
 *   2. a rate on the project's CONTRACT for this role, but only for hours DATED
 *      INSIDE that contract's period (§4.1 — the contract already carries its own
 *      validity, so none was invented);
 *   3. `referenceBillRate` — today's resolution (personal override -> rate card).
 *
 * Level 3 is the no-regression guarantee: an empty table behaves exactly like the
 * system before this feature.
 *
 * A PERSONAL OVERRIDE NEVER BEATS A NEGOTIATED PRICE. If the customer signed
 * 1000, 1000 is billed even when that person's own rate is higher: the override
 * is a company default, not a sell price. Do not "fix" this by reordering.
 */
export interface NegotiatedRate {
  id: string;
  contractId?: string;
  projectId?: string;
  role: string;
  currency: string;
  billRate: number;
}
export interface SellRateProject { id: string; contractId?: string }
export interface SellRateContract { id: string; startDate: string; endDate?: string }

export const SELL_RATE_BASE_CURRENCY = 'EUR';

/** ISO date-string comparison is safe here: both sides are 'YYYY-MM-DD'. */
function withinPeriod(date: string, contract: SellRateContract): boolean {
  if (date < contract.startDate) return false;
  return contract.endDate === undefined || date <= contract.endDate;
}

function usable(rate: NegotiatedRate): boolean {
  return (rate.currency ?? SELL_RATE_BASE_CURRENCY) === SELL_RATE_BASE_CURRENCY
    && typeof rate.billRate === 'number' && Number.isFinite(rate.billRate) && rate.billRate >= 0;
}

export function sellRateFor(args: {
  projectId: string | undefined;
  role: string | undefined;
  date: string;
  referenceBillRate: number | undefined;
  rates: readonly NegotiatedRate[];
  projects: readonly SellRateProject[];
  contracts: readonly SellRateContract[];
}): number | undefined {
  const { projectId, role, date, referenceBillRate, rates, projects, contracts } = args;
  if (projectId === undefined || role === undefined) return referenceBillRate;

  // 1. project override — no date limit of its own; it is scoped by the project.
  const onProject = rates.find(r => r.projectId === projectId && r.role === role && usable(r));
  if (onProject !== undefined) return onProject.billRate;

  // 2. contract rate, only for hours dated inside the contract's own period.
  const contractId = projects.find(p => p.id === projectId)?.contractId;
  if (contractId !== undefined) {
    const contract = contracts.find(c => c.id === contractId);
    if (contract !== undefined && withinPeriod(date, contract)) {
      const onContract = rates.find(r => r.contractId === contractId && r.role === role && usable(r));
      if (onContract !== undefined) return onContract.billRate;
    }
  }

  // 3. today's behaviour.
  return referenceBillRate;
}
```

- [ ] **Step 4: Run it green, then the whole suite and lint**

```bash
./node_modules/.bin/ng test --include='**/sell-rate.util.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
```

- [ ] **Step 5: Commit**

```bash
git add src/app/services/sell-rate.util.ts src/app/services/sell-rate.util.spec.ts
git commit -m "feat: pure sell-rate layer with project, contract and reference precedence"
```

---

### Task 2: The table, the migration and the seed

**Spec:** §3, and §4.1 for why no validity columns exist.

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/app/services/api.service.ts`
- Modify: `src/db/seed.ts`
- Modify: `src/db/repositories.ts` and `src/db/bootstrap.ts` — wire the new repo and its seed step
- Create: `drizzle/00NN_*.sql` — **generated**, never hand-written

**Interfaces:**
- Consumes: `NegotiatedRate` from Task 1 — the client interface **is** that type; import it rather than declaring a second shape.
- Produces: `repos.negotiatedRates`, `ApiService.getNegotiatedRates()/createNegotiatedRate()/updateNegotiatedRate()/deleteNegotiatedRate()`.

- [ ] **Step 1: Declare the table**

In `src/db/schema.ts`, beside `rateCards`:

```ts
export const negotiatedRates = pgTable(
  'negotiated_rates',
  {
    id: text('id').primaryKey(),
    // EXACTLY ONE of these two is set (design spec §3). The xor is a write-time
    // invariant, not a CHECK: no portable constraint expresses it across the two
    // adapters this project runs on.
    contractId: text('contract_id').references(() => contracts.id),
    projectId: text('project_id').references(() => projects.id),
    role: text('role').notNull(),
    currency: text('currency').notNull(),
    // SELL price in EUR per DAY, same unit and type as rate_cards.
    billRate: doublePrecision('bill_rate').notNull(),
  },
  (t) => [
    index('negotiated_rates_contract_id_idx').on(t.contractId),
    index('negotiated_rates_project_id_idx').on(t.projectId),
  ],
);
```

- [ ] **Step 2: Export the client type**

In `src/app/services/api.service.ts`, re-export Task 1's interface as the wire shape rather than duplicating it:

```ts
export type { NegotiatedRate } from './sell-rate.util';
```

and add the four methods beside the rate-card ones, following their exact idiom (`getNegotiatedRates(): Observable<NegotiatedRate[]>`, `createNegotiatedRate(rate: Partial<NegotiatedRate>)`, `updateNegotiatedRate(id: string, rate: Partial<NegotiatedRate>)`, `deleteNegotiatedRate(id: string)`), all on `${this.baseUrl}/negotiated-rates`.

- [ ] **Step 3: Wire the repository and the seed**

Add `negotiatedRates` to `src/db/repositories.ts` following the pattern of `rateCards` exactly (both the in-memory and the Pg adapter), and add its seed step to `src/db/bootstrap.ts`.

**Seed order matters and is the thing that has broken this project before:** `negotiated_rates` references `contracts` and `projects`, so its step must run **after** both. A previous feature shipped a server that could not boot on a fresh database because a new reference broke this order — invisible in-memory, because that adapter enforces no foreign keys.

In `src/db/seed.ts`, add a demonstration pair so the feature is visible on first boot and the impact script has something to report:

```ts
// The sell price is negotiated per contract, and a single project inside a
// framework can override it (design spec §3). CT2 is the seed's T&M contract —
// the only type whose revenue is hours × rate, so the only one where a negotiated
// rate is observable at all (spec §11). Project '2' hangs off CT2, which is what
// makes the override demonstrable. 1000/day is BELOW the Developer card's
// 1120/day on purpose, so the seed shows a negotiated DISCOUNT rather than a
// figure that could be mistaken for the card's own.
export const negotiatedRates: NegotiatedRate[] = [
  { id: 'NR_CT2_DEV', contractId: 'CT2', role: 'Developer', currency: 'EUR', billRate: 1000 },
  { id: 'NR_P2_DEV', projectId: '2', role: 'Developer', currency: 'EUR', billRate: 1150 },
];
```

These ids are verified against the seed as it stands: contracts are `CT1` (**Fixed Price**, `2026-01-01`–`2026-12-31`) and `CT2` (**T&M**, `2026-03-01`–`2027-02-28`); project `'1'` hangs off `CT1` and project `'2'` off `CT2`. **Do not put the demonstration rate on `CT1`** — a Fixed Price contract's revenue never passes through `hours × rate`, so nothing would change and the seed would appear broken.

One thing to notice rather than trip over: `CT2` is denominated in **USD** (the seed's multi-currency demo), while the negotiated rate above is in **EUR**. That is deliberate and consistent with how `rateCards` already work — rates live in the base currency and conversion happens downstream through `fx-rates`. The rate's `currency` is the rate's own, not the contract's. Confirm this holds when you run the impact script, and if the downstream conversion turns out to treat them differently, report it instead of changing the currency to paper over it.

- [ ] **Step 4: Generate the migration and read it**

Run: `./node_modules/.bin/drizzle-kit generate`
Then **read the generated SQL**: it must be one `CREATE TABLE` plus two `CREATE INDEX`. If it proposes to alter or recreate anything else, stop and report it.

- [ ] **Step 5: Boot both adapters**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
curl -s http://localhost:4173/api/negotiated-rates
kill %1
```

Then on a **genuinely fresh** Postgres database (`docker compose up -d postgres`, create an empty DB, run with `DATABASE_URL`, drop it after): confirm every migration applied, the table exists, and the seeded rows come back. **This run is mandatory** — see Step 3 on why. If Docker is unavailable, say so prominently rather than skipping quietly.

- [ ] **Step 6: Commit**

```bash
git add src/db drizzle src/app/services/api.service.ts
git commit -m "feat: negotiated_rates table, repository and seeded demonstration pair"
```

---

### Task 3: The endpoint and its integrity rules

**Spec:** §5 in full.

**Files:**
- Modify: `src/server.ts`
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `repos.negotiatedRates` (Task 2).
- Produces: `GET/POST/PUT/DELETE /negotiated-rates`.

**Read this first:** `/resource-organizations` (`src/server.ts`, search for `apiRouter.get('/resource-organizations'`) is the closest precedent — bespoke handlers, a `pick()` allow-list duplicated between POST and PUT, a validator called from both, and a `REQUIRED_ORG_FIELDS` list that rejects an explicit `null` for every `notNull` column in one loop. Follow that shape; do **not** mount this with `crud()`.

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-api.mjs`, a new block following the file's existing helper idiom (read a neighbouring block first). Each must fail against the current build:

1. `POST` with `{contractId, role, currency:'EUR', billRate:900}` → 200, and the response carries all four fields.
2. `POST` with neither `contractId` nor `projectId` → **400**.
3. `POST` with **both** → **400**.
4. `POST` with a `contractId` that does not exist → **400**.
5. `POST` with a `projectId` that does not exist → **400**.
6. `POST` with `role: 'Nobody Has This'` → **400**.
7. `POST` duplicating an existing (`contractId`, `role`, `currency`) → **400** naming the existing id.
8. `POST` with `billRate: -1` → **400**; with `billRate: null` → **400**.
9. `PUT` changing only `billRate` on the row from check 1 → 200 with the new value, other fields intact.
10. `PUT` with `role: null` → **400** (the `pick()`-forwards-`null` class).
11. `DELETE` the row from check 1 → 204, and a subsequent `GET` no longer lists it.
12. `GET /negotiated-rates` as a role **outside** the commercial set (an `employee`) → **403**.

- [ ] **Step 2: Run the smoke suite to see them fail**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```

Record the failure lines — that is the evidence the checks are real. Restart the process between runs: the suite is not idempotent against a warm in-memory server, and it runs near the API's 300 req/min limit.

- [ ] **Step 3: Implement the handlers and the validator**

Four bespoke handlers, plus:

```ts
/** Every notNull column on negotiated_rates, declared ONCE so the null-rejection
 *  covers the class rather than a hand-picked subset. */
const REQUIRED_NEGOTIATED_RATE_FIELDS = ['role', 'currency', 'billRate'] as const;
```

and a `validateNegotiatedRate(body, ctx?)` returning a 400-suitable message or `null`, enforcing every row of spec §5 in this order: the `null` loop first, then the xor, then the FK existence checks, then the role existence, then uniqueness (excluding `ctx.id` on PUT), then the numeric check. Both POST and PUT call it; the `pick()` allow-list is `['contractId', 'projectId', 'role', 'currency', 'billRate']` in **both** places — a field missing from one list is not writable through that verb and fails **silently**.

**RBAC:** add `'/negotiated-rates'` to the **two** existing rule lists that already carry `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items` — the mutation rule and the READ rule. Do not create a new rule.

- [ ] **Step 4: Run the smoke green, then the gates**

Re-run the Step 2 sequence and confirm every new check passes with nothing pre-existing regressed. Then `ng test` and `ng lint`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat: negotiated-rates endpoint with xor, reference and uniqueness rules"
```

---

### Task 4: Wire it into the revenue

**Spec:** §6 in full — including what must NOT change.

**Files:**
- Modify: `src/app/services/finance.util.ts` (the as-incurred branch, around `:681-700`)
- Modify: `src/app/services/finance.util.spec.ts`
- Modify: `src/server.ts` — supply the new data to whatever builds the finance input

**Interfaces:**
- Consumes: `sellRateFor` (Task 1), `repos.negotiatedRates` (Task 2).
- Produces: nothing later tasks depend on.

**The one line that changes.** `finance.util.ts:697` today reads:

```ts
const rate = data.resources.find(r => r.id === t.resourceId)?.billRate ?? 0;
```

It becomes a `sellRateFor` call. Everything it needs is already in scope: `t.projectId`, `t.date`, and the resource (for its `role` and its `billRate` as the reference). The data envelope gains `negotiatedRates` and needs `contracts`; check whether `data.contracts` already exists and say what you found — `data.projects` does.

**What must NOT change:** the company-wide billability figure at `finance.util.ts:208-214` stays on the reference `billRate`. It has no project — it answers "what is our time worth", not "what do we invoice". Add a comment saying so, or a later reader will "fix" it believing they found an inconsistency.

Also unchanged: the cap-filling order, the `Capped`/`Expense` handling, and every non-as-incurred branch.

- [ ] **Step 1: Write the failing unit cases**

In `finance.util.spec.ts`, following the file's existing fixture idiom:

```ts
it('prices as-incurred revenue at the negotiated contract rate', () => {
  // 10 approved hours, resource reference 1200/day, contract rate 1000/day.
  // Expect the schedule to recognize the CONTRACT price, not the reference.
});

it('lets a project override beat the contract rate in revenue', () => {});

it('does not let a higher personal rate raise the invoice', () => {
  // reference 1500, contract 1000 -> recognized at 1000.
});

it('prices hours dated outside the contract period at the reference rate', () => {});

it('is byte-identical to the pre-feature figures when no rate is negotiated', () => {
  // The no-regression case: same fixture, empty negotiatedRates, same totals.
});
```

Fill each body against the file's real fixture builders — read them first and reuse them rather than inventing a second style. The last case is the most important of the five: it is the promise this whole block rests on.

- [ ] **Step 2: Run them to see them fail**

Run: `./node_modules/.bin/ng test --include='**/finance.util.spec.ts'`

- [ ] **Step 3: Implement**

Replace the rate lookup with `sellRateFor`, passing `t.date` as the date and the resource's `billRate` as `referenceBillRate`. Keep `?? 0` semantics at the end so an unpriced entry still recognizes nothing rather than `NaN`.

- [ ] **Step 4: Supply the data server-side**

Find where the finance input envelope is assembled for the reporting/billing surfaces and add the negotiated rates and contracts to it. Say in your report which call sites you touched and confirm each loads the list **once per request**, not per row.

- [ ] **Step 5: Gates**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

Then the live smoke with a check that recognizes the difference end to end: with the seeded contract rate in place, the T&M revenue of that contract's project must equal hours × 1000, not hours × the card rate. Red first.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/finance.util.ts src/app/services/finance.util.spec.ts src/server.ts
git commit -m "feat: price as-incurred revenue at the negotiated sell rate"
```

---

### Task 5: The two tables in the commercial UI

**Spec:** §7.

**Files:**
- Modify: the contract-detail and project-detail surfaces under `src/app/commercial` — read the directory and say which files you chose
- Modify/create: their `.spec.ts`

**Interfaces:**
- Consumes: the four `ApiService` methods (Task 2); `sellRateFor` is **not** needed here — the UI shows configuration, not resolution.

- [ ] **Step 1: Write the failing component tests**

Following each spec file's own setup helper:

```ts
it('lists the negotiated rates of the contract', async () => {});

it('sends contractId and never projectId when adding on a contract', async () => {
  // expect(createNegotiatedRate).toHaveBeenCalledWith(expect.objectContaining({ contractId: 'C1' }));
  // and: expect('projectId' in payload).toBe(false);
});

it('shows the contract rate greyed out on a project that does not override it', async () => {
  // assert the row is rendered AND carries the inherited marker
});

it('shows the project override instead of the inherited row once one exists', async () => {
  // and the inherited marker is ABSENT — the assertion of absence for the one above
});

it('surfaces the server refusal without closing the form', async () => {
  // e.g. a duplicate -> 400; the form stays open and the message is shown
});
```

Fill each body against the real component API — read it first. The third and fourth cases are a pair: one asserts the inherited marker present, the other asserts it **absent**. Neither alone proves the behaviour.

- [ ] **Step 2: Run them to see them fail**

Run: `./node_modules/.bin/ng test --include='**/commercial/**'`

- [ ] **Step 3: Implement**

On the **contract**: a table of profile → price/day with add, edit and delete. On the **project**: the same table as an override, plus each contract-level row rendered **greyed out with an inherited marker** when the project does not override it — `data-test="inherited-rate"` so the spec can assert it. That grey is the requirement that matters: it shows *where the applied price comes from*, which is the first question of anyone auditing a margin.

Role options come from the distinct `role` values of the resource list. Any `<select>` populated from an `@for` uses per-`<option>` `[selected]`, never `[value]` on the `<select>`. Copy in English, `command-*` classes only.

- [ ] **Step 4: Gates and a browser pass**

`ng test`, `ng lint`, `ng build`. Then on port **4173** (**port 4200 may be a dev server of the coordinator's — do not use it or stop it**): open a contract, add a rate, open a project under it and confirm the inherited row is greyed, override it and confirm the grey disappears, then try a duplicate and confirm the refusal is readable. Report concretely what you saw, including the exact error text.

- [ ] **Step 5: Commit**

```bash
git add src/app/commercial
git commit -m "feat: negotiated rate tables on the contract and the project"
```

---

### Task 6: Impact report, sweep, docs, full verification

**Spec:** §9, §10, §11.

**Files:**
- Create: `scripts/negotiated-rate-impact.mjs`
- Modify: `docs/architecture/03-backend-and-data.md`, `docs/roles-and-permissions.md`, and the functional doc covering the commercial chain under `docs/functional/`
- Modify: whatever the sweep turns up

- [ ] **Step 1: Write the impact report**

`scripts/negotiated-rate-impact.mjs`, **dependency-free**, modelled on `scripts/smoke-api.mjs`'s plain-`fetch` style. It queries a running server, computes the as-incurred revenue per project **twice** — once with the negotiated rates applied and once with an empty rate list — and prints only the projects whose total differs: project id and name, revenue before, revenue after, delta in EUR. `IMPACT_BASE` overrides the origin, exactly as `SMOKE_BASE` does.

**The gate:** on a system with **no** negotiated rates the script must print **zero rows**. If it prints anything against an empty table, the no-regression guarantee of spec §4 level 3 is broken and the merge does not proceed. Run it both ways — empty and with the seeded pair — and put both outputs in your report.

- [ ] **Step 2: Sweep every other reader of a sell price**

`grep -rn 'billRate' src` and, for each hit, record what it reads, whether a negotiated price should change it, and your decision — **including the ones that need nothing, with the reason.** A consumer you do not mention reads as one you did not look at.

Two you must judge explicitly rather than skip: the **company-wide billability** figure (spec §6 says it stays on the reference rate — confirm it still does) and anything under `match.util` or the forecast surfaces that prices future work, where a negotiated rate may or may not belong. Where it needs a product call, report it instead of guessing.

- [ ] **Step 3: Docs**

`docs/architecture/03-backend-and-data.md`: the new table, the xor invariant, and that validity comes from the contract's own period rather than from columns on the rate. `docs/roles-and-permissions.md`: `/negotiated-rates` under the commercial rule, both read and mutation. The functional doc for the commercial chain: how a price is negotiated, that a project can override it, that a personal override does **not** beat it, and that `Fixed Price` and `Milestone` revenue is unaffected (spec §11) — that last one because a user may otherwise enter a rate on a Fixed Price contract and expect an effect.

- [ ] **Step 4: Full gate set**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```

- [ ] **Step 5: Fresh-Postgres run — mandatory**

There is a migration and a new seed step with two foreign keys, so this is the gate that matters most. Create a genuinely **fresh** database, boot the built server against it with `DATABASE_URL`, confirm every migration applied and report the count, run the same smoke suite, then drop the database. If Docker is unavailable, say so **prominently** rather than skipping silently.

- [ ] **Step 6: Commit**

```bash
git add -A scripts docs src
git commit -m "docs: negotiated sell rates in the entity catalogue, RBAC and the commercial flow"
```

---

## Verification Checklist (before merge)

- [ ] With an empty `negotiated_rates` table, every revenue figure is identical to before the branch — and the impact script prints **zero rows**.
- [ ] A contract rate prices the T&M revenue of every project under that contract.
- [ ] A project override beats the contract rate for that project only.
- [ ] Hours dated **outside** the contract period fall back to the reference rate.
- [ ] An open-ended contract (no `endDate`) applies to every later date.
- [ ] A **higher personal override does not raise the invoice** above the negotiated price.
- [ ] A rate in a non-base currency is ignored.
- [ ] The company-wide billability figure still uses the reference rate.
- [ ] All seven integrity rules of spec §5 refuse with 400, each shown red first.
- [ ] An `employee` cannot read or mutate `/negotiated-rates`.
- [ ] The project table shows the inherited contract row greyed out, and **not** greyed once overridden.
- [ ] Unit, lint, build, live smoke and the **fresh-Postgres** run are all green.
