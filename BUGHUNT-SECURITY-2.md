# Bug Hunt & Security Audit #2 — Resource Scheduling App

Scope: second audit, focused on the changes since audit #1 — the rewritten
`src/server.ts`, the new Commercial domain (customers / contracts / orders /
order-lines), `finance.util.ts`, the Project 360 Overview tab, the analytics in
`reporting.ts`, the mock `auth.service.ts`, and the 7 project sub-tabs migrated
to `rxResource`.

---

## Executive summary

The server rewrite added real hardening primitives (`pick()` allow-listing,
`isNonNegNumber()`, a fixed-window `rateLimit()`, `clampUtil()`, and a generic
`crud()` helper). These are genuine improvements over audit #1, but they were
applied **unevenly**:

- The custom-coded endpoints (`/requests`, `/assignments`) validate their
  numeric inputs. The generic `crud()` helper — which now backs **11**
  resources, including every monetary field in the Commercial domain and the
  cost-center / financial-plan endpoints — performs **no value validation at
  all**. Allow-listing prevents mass-assignment but does nothing to stop
  negative / `NaN` / `Infinity` monetary values from being persisted and then
  flowing straight into `finance.util.ts`.
- The Commercial domain has **no referential-integrity checks**: orphan
  contracts, orders, and order-lines can be created against non-existent foreign
  keys, and Purchase-order partner constraints are unenforced on the server.
- Two latent **division-by-zero / Infinity** vectors exist: a client-settable
  `capacity` on resources (used as a divisor in assignment math) and a dashboard
  progress bar dividing by `requiredEffort`.
- `finance.util.ts` performs naive `reduce()` arithmetic with no `Number.isFinite`
  guards, so any corrupt amount propagates silently into revenue / margin /
  burn and renders as blank or `Infinity%` in the UI.
- The frontend largely follows the conventions, but there is a **systemic
  subscription-leak pattern**: ~16 `.subscribe()` call sites across the new /
  migrated components have no `takeUntilDestroyed()`. Plus three form-validation
  gaps (`min(0)` / conditional `partnerId`) and one stray `CommonModule` import.

Highest-priority items: client-settable `capacity` (division by zero in core
assignment math), `status` in `REQUEST_FIELDS` (workflow-bypass), missing
`requestId`/`resourceId` validation on assignment POST, and the across-the-board
monetary validation gap in `crud()`.

### Coverage caveats

- Line numbers in the confirmed-findings input are approximate; the live code
  has shifted (e.g. `project-details.ts` binds the route param as
  `id = input.required<string>()`, not `projectId`; the unused `CommonModule`
  import is on line 4 / imports array line 21). The substance of every finding
  was re-verified against the current source.
- This is an in-memory mock backend. There is no persistence, no real
  authentication, and `auth.service.ts` is an explicit mock identity. Findings
  are scored for the intended production shape of these endpoints, not the mock.
- No automated test run or full type-check was performed as part of this audit;
  findings are from source inspection of the files in scope. The frontend
  sub-tab components were spot-checked, not all exhaustively re-read.

---

## Security (by severity)

### CRITICAL

**S-C1 — Client-settable `capacity` enables division-by-zero in assignment math**
`src/server.ts:162` (`RESOURCE_FIELDS`), divisors at lines 215, 236, 253.
`capacity` is in the `PUT /resources/:id` allow-list with no validation. The
assignment POST/PUT/DELETE handlers compute
`utilization + (hours / resource.capacity) * 100`. A client setting
`capacity: 0` yields `Infinity`/`NaN`; `clampUtil()` then turns `NaN` into `0`
(via `Math.max/min`/`Math.round`), corrupting utilization silently.
CWE-369 (Divide By Zero), CWE-20 (Improper Input Validation).
Remediation: validate `capacity` as `isNonNegNumber(v) && v > 0` in
`PUT /resources/:id`, and guard `resource.capacity > 0` before each division.

**S-C2 — `status` in `REQUEST_FIELDS` allows arbitrary fulfillment-state override**
`src/server.ts:176`, exposed in POST (180-186) and PUT (188-197).
Business rule B9 says request status is derived from
`staffedEffort >= requiredEffort` and is auto-maintained by the assignment
handlers. Including `status` in the general update allow-list lets a client mark
a request `Fulfilled` with zero assignments, breaking the staffing workflow.
CWE-639 (Authorization Bypass Through User-Controlled Key) / business-logic
bypass. Remediation: remove `status` from `REQUEST_FIELDS`; if explicit
close/archive is needed, add a dedicated endpoint with its own logic. (Note: the
POST handler already overrides to `'Not Published'`, so the exposure is via PUT.)

**S-C3 — `POST /assignments` does not validate required FKs**
`src/server.ts:206-223`. Only `assignedHours` is checked. `requestId` and
`resourceId` are picked but never required, and the object is cast with
`as typeof assignments[number]`. An assignment with `undefined`/missing
`requestId`/`resourceId` is accepted; the resource/request lookups then no-op,
producing orphaned rows and skipped utilization/staffing updates.
CWE-20. Remediation: after `pick()`, reject if `requestId`/`resourceId`/`status`
are missing or empty, and (see S-H7) verify they reference existing entities.

**S-C4 — `crud()` stores arbitrary monetary values for `project-financials`**
`src/server.ts:389` (`['projectId','category','budget','actual']`).
`budget`/`actual` are summed by `budgetForProject()` (finance.util.ts:58) and
feed burn rate. Negative / `NaN` / `Infinity` are accepted as-is.
CWE-20, CWE-1284 (Improper Validation of Specified Quantity in Input).
Remediation: see the cross-cutting `crud()` validation note.

### HIGH

**S-H1 — `crud()` has no numeric validation for any monetary field**
`src/server.ts:64-86`. The single root cause behind S-C4 and S-H2…S-H6. All 11
`crud()`-backed resources accept unchecked field values. Monetary fields:
`contracts.totalValue` (431), `orders.amount` (438), `order-lines.amount` (445),
`project-cost-centers.allocated/actual` (396), `cost-centers.allocated/actual`
(417), `project-financials.budget/actual` (389). CWE-20 / CWE-1284.

**S-H2 — `orders.amount` unvalidated** `src/server.ts:438`. Feeds
`customerRevenueForProject` / `externalCostForProject`. Negative/NaN/Infinity
corrupt revenue and margin. CWE-20.

**S-H3 — `order-lines.amount` unvalidated** `src/server.ts:445`. Summed directly
by `lineSum()` (finance.util.ts:43). CWE-20.

**S-H4 — `contracts.totalValue` unvalidated** `src/server.ts:431`. CWE-20.

**S-H5 — `project-cost-centers.allocated/actual` and `cost-centers.allocated/actual`
unvalidated** `src/server.ts:396, 417`. The project-cost-centers UI computes
`actual / allocated * 100`; a negative or zero `allocated` produces
Infinity/NaN/garbage usage. CWE-369 / CWE-20.

**S-H6 — Resource `costRate` / `billRate` unvalidated** `src/server.ts:162`.
In `RESOURCE_FIELDS`, no validation. `laborCostForProject()`
(finance.util.ts:33) multiplies `assignedHours * costRate`; negative rates yield
negative labor cost. CWE-20.

**S-H7 — Commercial domain has no referential-integrity validation**
`src/server.ts:431, 438, 445`. `contracts.customerId`, `orders.contractId`,
`order-lines.orderId`/`projectId` are accepted without checking the parent
exists. Allows orphan FK references that silently drop out of finance rollups.
CWE-20 / CWE-1288 (Improper Validation of Consistency within Input).
Remediation: replace the generic `crud()` for these three resources with
handlers that look up the parent in the corresponding store and 400 on miss.

**S-H8 — Purchase-order `partnerId` constraint unenforced server-side**
`src/server.ts:438`. `partnerId` is accepted for any order type and never
checked against the partner store. Domain rule: Purchase orders require a valid
partner; Customer orders must have none. The client only conditionally sends it
(orders.ts:225), but a direct PUT/POST can set `partnerId` on a Customer order
or leave a Purchase order partner-less. CWE-20 / business-logic.
Remediation: dedicated handler — require existing `partnerId` when
`type==='Purchase'`, reject non-empty `partnerId` when `type==='Customer'`.

**S-H9 — `rateLimit()` map grows unbounded (memory leak)** `src/server.ts:39-58`.
Per-IP entries are never evicted after their window expires. CWE-401 (Missing
Release of Memory) / CWE-770 (Allocation Without Limits). Remediation: evict
entries where `now > entry.reset` (lazy sweep on each call, or a periodic
`setInterval`).

**S-H10 — `finance.util.ts` has no defensive arithmetic** `finance.util.ts:26`
(`sum`), 37-44 (`lineSum`), 62-82 (`computeProjectFinancials`). Naive `reduce`
with no `Number.isFinite` filtering; a single corrupt amount poisons revenue,
cost, margin, marginPct, burnPct, and the UI renders blanks/`Infinity`. This is
the defense-in-depth backstop for S-H1…S-H6. CWE-20.
Remediation: `sum` filters non-finite inputs; clamp `margin`/`marginPct`/
`burnPct` to finite values.

### MEDIUM

**S-M1 — `PUT /assignments/:id` allows unvalidated FK reassignment**
`src/server.ts:224-245`. `resourceId`/`requestId` can be changed to
non-existent ids; the subsequent lookups silently fail, leaving
utilization/staffedEffort stale. CWE-20.

**S-M2 — `POST /languages/default` silently accepts a non-existent code**
`src/server.ts:266-270`. If `code` matches nothing, all languages end up
`isDefault: false` (no default) and the endpoint still returns 204.
CWE-20. Remediation: 400 if `code` is not present in `languages`.

### LOW

**S-L1 — `RESOURCE_FIELDS` omits `utilization` but it is server-computed**
`src/server.ts:162`. Correct by design (read-only / auto-calculated) but
undocumented; a reader may think it's an oversight. Add a comment marking
`utilization` as computed. (Informational.)

**S-L2 — Inconsistent guard-block style in validation early-returns**
`src/server.ts:181-183, 192-194, 208-210, 228-230`. The extra `{ … }` wrapper
blocks are harmless (returns are present) but inconsistent. Cosmetic.

---

## Bugs (by severity)

### HIGH

**B-H1 — Division by zero on dashboard progress bar**
`src/app/dashboard/dashboard.component.ts:97`.
`[style.width.%]="(req.staffedEffort || 0) / req.requiredEffort * 100"` →
`Infinity%` when `requiredEffort === 0`, producing invalid CSS.
Fix: guard `req.requiredEffort > 0 ? … : 0`.

**B-H2 — Margin bar normalization conflates profit and loss**
`src/app/reporting/reporting.ts:230-231` (consumed in template at line 131).
`width = Math.abs(p.margin) / maxMargin * 100` makes a −500k loss render the
same width as a +500k profit, distinguished only by color. Misleading.
Fix: normalize profit and loss separately, use a diverging representation, or
explicitly document that width encodes magnitude only.

**B-H3…B-H16 — Subscription leaks: `.subscribe()` without `takeUntilDestroyed()`**
A systemic pattern across the new/migrated components. Each `.subscribe()` in a
command method (save/delete/updateStatus) is created without lifecycle binding;
in-flight requests are not cancelled on destroy and rapid open/submit/close can
accumulate subscriptions. CWE-401-adjacent (resource leak).
Sites confirmed:
- `project-partners/project-partners.ts:176` (savePartner), `:182` (removePartner)
- `project-documents/project-documents.ts:157-158` (deleteDocument), `:184` (saveDocument)
- `project-plans/project-plans.ts:419` (saveMilestone), `:451` (saveWp), `:487` (saveEditWp)
- `project-cost-centers/project-cost-centers.ts:217-226` (saveCostCenter, two paths)
- `project-tasks/project-tasks.ts:180` (updateStatus) — also `:203` (createProjectTask)
- `project-issues/project-issues.ts:187` (updateStatus), `:208` (saveIssue)
- `financial-plans/financial-plans.ts:225-238` (savePlan, two paths)
- `configuration/manage-cost-centers.component.ts:189-196` (saveCostCenter), `:209` (confirmDelete)
- `commercial/customers/customers.ts:152` (save)
- `commercial/contracts/contracts.ts:212` (save)
- `commercial/orders/orders.ts:229` (saveOrder)
Fix (per file): inject `private destroyRef = inject(DestroyRef)` and pipe each
call with `.pipe(takeUntilDestroyed(this.destroyRef))`.

**B-H17 — `totalValue` FormControl missing `min(0)`**
`src/app/commercial/contracts/contracts.ts:186`. Only `Validators.required`.
Negative/zero contract values pass. Fix: add `Validators.min(0)`.

**B-H18 — `amount` FormControl missing `min(0)`**
`src/app/commercial/orders/orders.ts:192`. Fix: add `Validators.min(0)`.

**B-H19 — `partnerId` lacks conditional `required` for Purchase orders**
`src/app/commercial/orders/orders.ts:191` (control), 225-227 (payload).
A Purchase order can be saved with an empty partner. Client-side mirror of S-H8.
Fix: cross-field/group validator requiring `partnerId` when `type==='Purchase'`.

### MEDIUM

**B-M1 — Weak semantic condition on margin-bar width**
`src/app/projects/project-details/project-details.ts:148`.
`[style.width.%]="f.marginPct > 0 ? f.marginPct : 0"` checks the derived value
rather than the source of truth. Fix: `f.margin >= 0 ? f.marginPct : 0`.

**B-M2 — Negative backlog shown without visual warning**
`src/app/projects/project-details/project-details.ts:125`.
`backlog = revenue − invoiced` can go negative (over-invoicing) and renders as a
plain `-€…`. Fix: conditional warning color and/or clarify the label.

**B-M3 — Unused `CommonModule` import in OnPush standalone component**
`src/app/projects/project-details/project-details.ts:4` (import) / line 21
(imports array). Template uses native control flow only; violates the
"no CommonModule" convention. Fix: remove the import and the array entry.

---

## Financial-integrity notes

The finance pipeline is a single trust chain with **no validation at either
end**:

1. **Ingress (server):** `crud()` accepts any value for `totalValue`, `amount`,
   `budget`, `actual`, `allocated`, `costRate`, `billRate`
   (S-H1…S-H6, S-C4).
2. **Aggregation (finance.util.ts):** `sum`/`lineSum` reduce blindly; one `NaN`
   or `Infinity` poisons the whole project rollup (S-H10).
3. **No referential integrity:** orphan order-lines / orders / contracts silently
   vanish from or distort rollups (S-H7), and there is **no cap** ensuring the
   sum of order-line amounts stays within the parent contract's `totalValue`
   (over-revenue is accepted).
4. **Egress (UI):** templates do inline `f.laborCost / f.revenue * 100`
   (project-details.ts:146-147) guarded only by `@if (f.revenue > 0)`; a
   negative `revenue` would pass that guard and still produce negative-width
   bars.

Recommended layering: (a) validate non-negative finite monetary values at every
ingress endpoint; (b) add `Number.isFinite` guards in `finance.util.ts` as a
backstop; (c) enforce FK existence and the contract-total cap on order-lines.
(a) and (c) are server-side / cross-cutting; (b) is a single-file frontend-local
fix to `finance.util.ts`.

---

## What is intentionally deferred

- **Mock authentication / authorization.** `auth.service.ts` is an explicit mock
  identity; there is no real authn/authz on the API, no per-user scoping, and no
  CSRF protection. Endpoint-level authorization (e.g. who may change request
  status, edit rates, or create contracts) is out of scope for the mock and
  should be revisited when a real identity provider is wired in. The S-C2
  workflow-bypass is filed as input-validation, not authz, on that basis.
- **Persistence & concurrency.** In-memory stores; no transactions, no optimistic
  locking. Race conditions on the shared mutable arrays are not in scope.
- **Rate-limit tuning.** The `rateLimit()` leak (S-H9) is real, but the limiter's
  policy (300/min/IP, `req.ip` keying behind a proxy) is a production-hardening
  concern deferred until deployment topology is known.
- **Transport security / headers** (HSTS, CSP, secure cookies) — deferred to the
  real deployment.
