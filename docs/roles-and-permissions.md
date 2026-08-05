# Roles & Permissions

> **Diátaxis mode: Reference.** This is the *definitive*, look-it-up record of
> who can do what in Delivery Control. Every table is transcribed from the
> source of truth — the role arrays in `src/server.ts`, the capability computeds
> in `src/app/services/auth.service.ts`, the guards in
> `src/app/guards/role.guard.ts`, and the Keycloak realm in
> `keycloak/realm-export.json`. For the *why* behind the model (OIDC login,
> defence-in-depth, SoD, auditing) read
> [`architecture/04-security-identity.md`](architecture/04-security-identity.md).
> To assign roles, see [`functional/keycloak-setup.md`](functional/keycloak-setup.md);
> for the functional areas these roles map onto, see
> [`functional/00-overview.md`](functional/00-overview.md).

---

## The 7 roles

Roles are Keycloak **realm roles** in the `psa` realm. A user may hold several;
both client and server collapse them to the single **highest-privilege** role
(see [Precedence](#role-precedence)).

| Role | Description | Typical responsibilities (functional areas) |
| --- | --- | --- |
| **`employee`** | Base role: any authenticated employee. The default composite role grants it to every user. | Own profile, own assignments, record own time entries. |
| **`pm`** | Project manager. | Project execution: projects, work packages, milestones, tasks, issues, change requests; staffing requests & assignments; approve delivery items. |
| **`resource-manager`** | Resource manager. | Resource pool & staffing: edit resource master data (incl. cost/bill rates), manage requests & assignments; first-line approver of time entries / expenses. |
| **`sales`** | Sales / commercial. | Commercial: customers, contracts, orders, billing-plan items. |
| **`finance`** | Finance / financial approver. | Financials: project financials, cost centers, billing; approve invoices & high-value items; read the integration/finance artifacts. |
| **`delivery-executive`** | Delivery executive (broad approval authority). | Cross-cutting delivery & commercial oversight; approves delivery, financial, and change-request items; reads the audit trail. |
| **`admin`** | Administrator (highest privilege). | Everything, including configuration master data (skills, catalogs, project roles, organizations), FX rates, and the audit trail. |

### Role precedence

`ROLE_PRIORITY` (highest-wins). The server lists it lowest-first (higher index =
more privilege); the client lists the same order highest-first. Effective
ordering:

> **`admin` > `delivery-executive` > `finance` > `sales` > `resource-manager` > `pm` > `employee`**

Any realm role outside this set is ignored; if none match, the actor is
`'unknown'` (server) / `'employee'` (client default).

---

## Capability matrix

The four capability computeds in `auth.service.ts`. `✓` = the role is in the
computed's list; `—` = not. Transcribed exactly:

```ts
isManager           = ['resource-manager', 'delivery-executive', 'admin']
canManageCommercial = ['sales', 'finance', 'delivery-executive', 'admin']
canApproveFinancials= ['finance', 'delivery-executive', 'admin']
canApproveDelivery  = ['pm', 'delivery-executive', 'admin']
```

| Role | `isManager` | `canManageCommercial` | `canApproveFinancials` | `canApproveDelivery` |
| --- | :---: | :---: | :---: | :---: |
| `employee` | — | — | — | — |
| `pm` | — | — | — | ✓ |
| `resource-manager` | ✓ | — | — | — |
| `sales` | — | ✓ | — | — |
| `finance` | — | ✓ | ✓ | — |
| `delivery-executive` | ✓ | ✓ | ✓ | ✓ |
| `admin` | ✓ | ✓ | ✓ | ✓ |

---

## Route access (client guards)

Angular routes in `app.routes.ts`. Only **commercial**, **billing**, and the
**schedule** routes are guarded; all other routes are open at the routing layer
(data is still protected by the server — see
[Server endpoint RBAC](#server-endpoint-rbac)). Guards are SSR-aware (allow on the
server, re-evaluate in the browser after `authReady`).

| Route(s) | Guard(s) | Allowed roles (via capability) |
| --- | --- | --- |
| `customers`, `contracts`, `contracts/:id`, `orders` | `commercialGuard` → `canManageCommercial()` | `sales`, `finance`, `delivery-executive`, `admin` |
| `billing` | `commercialGuard` **and** `financeGuard` | intersection → `finance`, `delivery-executive`, `admin` |
| `financial-plans`, `project-cost-centers`, `config/cost-centers`, `config/integrations` | `financeGuard` → `canApproveFinancials()` | `finance`, `delivery-executive`, `admin` |
| `approvals` | `roleGuard(a => a.hasAnyRole(['pm','resource-manager','delivery-executive','finance','admin']))` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `schedule` | `roleGuard(a => a.hasAnyRole(['pm','resource-manager','delivery-executive','admin']))` | `pm`, `resource-manager`, `delivery-executive`, `admin` |
| `resources` | `roleGuard(a => a.hasAnyRole(['resource-manager','delivery-executive','admin']))` | `resource-manager`, `delivery-executive`, `admin` |
| `capacity` (B2), `bench` (Block F) | `capacityGuard` → `hasAnyRole(CAPACITY_ROLES)` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `allocation-approvals` (B3, the People Manager per-month approval page) | `allocationApprovalsGuard` → `hasAnyRole(ALLOCATION_APPROVAL_ROLES)` | `resource-manager`, `delivery-executive`, `admin` |
| Everything else (dashboard, profile, assignments, requests, staffing, utilization, forecast, what-if, remaining `projects/*`, `reporting`, remaining `config/*`) | _none_ | open to any signed-in user (UX layer; API still enforces RBAC) |

> The **`schedule`** route (the read-only Resource Schedule timeline) is gated to
> the staffing roles (`pm`, `resource-manager`, `delivery-executive`, `admin`) —
> and its nav item appears in the **Resource Control** group only for those roles.
> No new endpoint backs it: it reads the already-gated `/assignments` plus
> `/requests` and `/resources` (see [Server endpoint RBAC](#server-endpoint-rbac)),
> and writes go through the existing `/assignments` mutation rule.

> The **`resources`** route (People management: the resource/employee lifecycle —
> view, create, edit, and logical termination/reactivation) is gated to the roles
> that own resource master data (`resource-manager`, `delivery-executive`,
> `admin`) — matching the existing `/resources` mutation rule — and its nav item
> appears in the **Resource Control** group only for those roles. It reads the
> already-gated `/resources` collection and writes through `POST /resources`
> (create) and `PUT /resources/:id` (edit + terminate via `terminationDate`); both
> are covered by the existing `/resources` mutation rule. There is no hard
> `DELETE` for resources — termination is logical only.

> The `billing` route stacks `commercialGuard` **and** `financeGuard`, so a user
> must satisfy *both* — effectively the `canApproveFinancials` set, since it is a
> subset of `canManageCommercial`.

> The **`capacity`** route (the monthly FTE capacity/demand dashboard, B2) and the
> **`allocation-approvals`** route (the People Manager's per-month approval page,
> B3) are each gated to a single exported role-set constant
> (`CAPACITY_ROLES`/`ALLOCATION_APPROVAL_ROLES` in `role.guard.ts`) so the route
> guard and the corresponding nav-item visibility check can never drift from one
> another. Both sets mirror their server `READ_RULE` exactly (`/capacity` and
> `/allocation-approvals` respectively — see
> [Server endpoint RBAC](#server-endpoint-rbac)); neither route introduces a
> mutation of its own — `allocation-approvals` writes through
> `POST /allocation-approvals/decide` and the `/assignments` per-month endpoints.
>
> The **`bench`** route (Block F's bench/availability page) reuses **the same**
> `capacityGuard` — not a copy, the identical `canMatch` reference — rather than
> a route-specific guard of its own, because it shares `CAPACITY_ROLES` and the
> server extends the `/capacity` `READ_RULE` to also match `/bench` instead of
> adding a second rule (see the `/capacity`, `/bench` row below). One guard, one
> role set, one server predicate: none of the three can drift from the other two.

---

## Server endpoint RBAC

The server is the real boundary (`roleGate` in `src/server.ts`). Two rule sets
apply, transcribed verbatim. A collection with **no** matching rule is **open**
to any actor that passed bearer verification.

### (a) READ_RULES — gated GET collections

A read failure is **401** when the actor's role is `'unknown'` (unauthenticated)
and **403** otherwise. Path tests use `startsWith`.

| Collection(s) | Allowed roles |
| --- | --- |
| `/audit-logs` | `admin`, `delivery-executive` |
| `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items`, `/negotiated-rates` | `sales`, `finance`, `delivery-executive`, `admin` |
| `/project-financials`, `/project-cost-centers`, `/cost-centers` | `finance`, `delivery-executive`, `admin` |
| `/resources` (incl. `/resources/:id`), `/users` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/rate-cards` (role/organization default cost-bill rates, resolved onto every `/resources` read — the ancestor-walk resolution, rate-card inheritance block, design spec §2) | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/assignments`, `/requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/capacity`, `/bench` (ONE predicate — `p.startsWith('/capacity') \|\| p.startsWith('/bench')`, not two rules — read-only computed rollups, e.g. `GET /capacity/monthly` (B2) and `GET /bench/monthly` (Block F, design spec §8); the latter extends this rule rather than duplicating the role array) | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/assignment-days`, `/assignment-months` (raw per-day/per-month assignment rows, e.g. `GET /assignment-days` — shared plumbing for Block F's client-side What-If bench composition and block E's own spec; same need-to-know as `/capacity` and `/assignments` above, just unaggregated) | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/time-entries` | `employee`, `pm`, `resource-manager`, `delivery-executive`, `finance`, `sales`, `admin` |
| `/approval-requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/allocation-approvals` (B3 People Manager feed, e.g. `GET /allocation-approvals?from&to&status`) | `resource-manager`, `delivery-executive`, `admin` |
| `/integrations` | `finance`, `delivery-executive`, `admin` |

**Open reads (no rule):** all other GETs — catalogs (`/skill-catalogs`,
`/proficiency-sets`, `/skills`, `/project-roles`), config (`/languages`,
`/fx-rates`, `/service-organizations`, `/resource-organizations`,
`/projects` and non-financial project sub-resources, `/storage-status`, etc.
Time-phased allocation (B1) adds `/holidays` and `/planning-periods` to this
open-read set, deliberately: both are config catalogs read by the Task-8
calendar (used by `pm`/`resource-manager`) to render holidays and open/closed
months, so neither carries a `READ_RULE` despite being mutation-gated below.

### (b) Mutation rules — POST / PUT / DELETE

A role not in the matched rule's list gets **403**. Path tests use `startsWith`
(or `some(prefix => p.startsWith(prefix))`).

| Collection(s) | Allowed roles |
| --- | --- |
| `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items`, `/negotiated-rates` | `sales`, `finance`, `delivery-executive`, `admin` |
| `/project-financials`, `/project-cost-centers`, `/cost-centers` | `finance`, `delivery-executive`, `admin` |
| `/resources` | `resource-manager`, `delivery-executive`, `admin` |
| `/rate-cards` | `admin`, `delivery-executive`, `finance` — deliberately **not** `resource-manager`: that role edits a resource's own override (the `/resources` row above), never the catalog cards themselves |
| `/time-entries` | `employee`, `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/assignments`, `/requests` (incl. the B3 per-month endpoints `POST /assignments/:id/months/:month/submit` and `PUT /assignments/:id/months/:month/note`, matched by the same `/assignments` prefix test — no separate rule) | `pm`, `resource-manager`, `delivery-executive`, `admin` |
| `/projects`, `/project-partners`, `/project-documents`, `/work-packages`, `/milestones`, `/project-tasks`, `/project-issues`, `/change-requests` | `pm`, `delivery-executive`, `admin` |
| `/skill-catalogs`, `/proficiency-sets`, `/skills`, `/project-roles`, `/resource-organizations`, `/languages` | `admin`, `delivery-executive` |
| `/holidays` | `admin`, `delivery-executive` |
| `/planning-periods` | `admin` only |
| `/approval-requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/allocation-approvals` (B3 batch month decisions, `POST /allocation-approvals/decide`) | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/assignment-months` (C2 dummy substitution, `POST /assignment-months/:id/substitute`) | `resource-manager`, `delivery-executive`, `admin` |
| `/integrations` | `finance`, `delivery-executive`, `admin` |

**Open mutations (no rule):** collections not matched above are open to any
verified actor, e.g. `/service-organizations` (read-only in practice). Note
`/fx-rates` mutations are **not** covered by `roleGate` and are enforced
**inline** in the handler: only `admin` may `PUT /fx-rates/:currency` (and the
base currency `EUR` is fixed at rate 1).

> Five collections appear in the *read* rules but have **no mutation rule**:
> `/audit-logs` (append-only; written only by the audit middleware, never via a
> client mutation), `/users` (read-only directory), `/capacity` (a GET-only
> computed rollup — `GET /capacity/monthly` — with no write endpoint at all),
> `/bench` (Task 6, Block F: same shape as `/capacity` — `GET /bench/monthly` is
> GET-only, sharing `/capacity`'s `READ_RULE` predicate rather than adding a
> second one, and has no write endpoint of its own either), and
> `/assignment-days` (Task 4: a GET-only raw feed shared by Block F's
> client-side What-If bench composition and block E's own spec — no write
> endpoint of its own; assignment-day rows are written only as a side effect of
> the `/assignments`/allocation mutation handlers). The mutation `/resources`
> rule is *narrower* than its read rule — `pm`/`finance` may *read* resources
> (margin/staffing need-to-know) but not rewrite cost/bill rates.
>
> `/assignment-months` shares that same narrowing shape, but split across two
> **independent** rules on the same prefix rather than one rule narrowed against
> another collection's. Its *read* rule (Task 4, `GET /assignment-months`) is
> the same shared rule as `/assignment-days` above —
> `pm`/`resource-manager`/`delivery-executive`/`finance`/`admin` — so month rows
> are now readable raw through this prefix, in addition to the pre-existing
> aggregated views inside `GET /assignments/:id/allocation` and
> `GET /allocation-approvals`. Its *mutation* rule is its own, separate, and
> deliberately **narrower**: only `POST /assignment-months/:id/substitute` (C2)
> is gated by it, to `resource-manager`/`delivery-executive`/`admin`.
> Substituting is an *approver* action, so `pm` may book a dummy's hours (via
> `/assignments`) and *read* the raw month rows, but may not hand them to a
> person (see
> [C2 substitution](#c2-substituting-a-dummy-with-a-real-person) below).

---

## Role → feature access map

The eight functional areas crossed with the 7 roles, derived from the route
guards + server RBAC above. Legend: **Full** = create/edit (mutation-allowed),
**Approve** = may decide/approve items in this area, **Read** = read-only access,
**—** = no access at the API layer.

| Functional area | `employee` | `pm` | `resource-manager` | `sales` | `finance` | `delivery-executive` | `admin` |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Resource pool** (`/resources`, `/users` read) | — | Read | Full | — | Read | Full | Full |
| **Staffing** (`/requests`, `/assignments`) | — | Full | Full | — | — | Full | Full |
| **Schedule** (`/schedule` view — reads `/assignments`, `/requests`, `/resources`)³ | — | Read | Read | — | — | Read | Read |
| **Time entries** (`/time-entries`) | Full (own) | Full | Full + Approve | Read | Full + Approve | Full + Approve | Full |
| **Projects** (`/projects` + sub-resources) | Read | Full | Read | Read | Read | Full | Full |
| **Commercial** (`/customers`, `/contracts`, `/orders`, `/order-lines`, `/negotiated-rates`) | — | — | — | Full | Full | Full | Full |
| **Billing & finance** (`/billing-plan-items`, `/project-financials`, `/cost-centers`) | — | — | — | Read/Full¹ | Full + Approve | Full + Approve | Full |
| **Configuration** (catalogs, skills, project-roles, orgs, languages, FX) | Read | Read | Read | Read | Read | Full | Full |
| **Governance** (`/approval-requests`, `/audit-logs`, `/integrations`) | — | Approve² | Approve² | — | Approve² + Read | Full + Read | Full + Read |

¹ `sales` may mutate `/billing-plan-items` (it is in the commercial mutation
rule) but **not** `/project-financials` or `/cost-centers` (finance-grade). It
has no read access to `/project-financials`/`/cost-centers`.
² Approval *capability* is via the `/approval-requests` mutation rule; whether a
given role may decide a specific step is further constrained by **step-role
enforcement** (see [Segregation of Duties](#segregation-of-duties)). `admin` may
decide any step.
³ **Schedule** is a UX view, not an API boundary — it is a read-only timeline
over staffing data with date-level conflict detection, gated by the `schedule`
route guard to `pm`/`resource-manager`/`delivery-executive`/`admin`. It adds no
new endpoint: it reads the existing (gated) `/assignments` plus `/requests` and
`/resources`, and any edits flow through the `/assignments` mutation rule. The
"Read" here is the *view's* read-only nature; the underlying staffing data is
mutable for the same roles via the **Staffing** row.

> This map reflects the *API* boundary. The client may additionally hide a
> feature behind a route guard (e.g. the commercial menu), but that is UX only.

---

## Segregation of Duties

SoD is enforced in the handlers, on top of RBAC. The recurring rule: **the
approver/decider must differ from the item's requester/owner, and the SoD basis
is a server-pinned identity the client cannot forge.** See
[`architecture/04-security-identity.md`](architecture/04-security-identity.md#segregation-of-duties-sod)
for the rationale.

| Flow | Who may approve | Cannot approve / SoD constraint | Server-pinned basis |
| --- | --- | --- | --- |
| **Time entry** (`PUT /time-entries/:id` → `Approved`) | any role in the time-entries mutation rule | the entry's **owner** (its `resourceId`, resolved from the actor's user→resource mapping) | `resourceId` (not reassignable on PUT); `status` forced to `Draft` on create |
| **Change request** (`PUT /change-requests/:id` → `Approved`) | only `delivery-executive` or `admin` | the CR **creator** (`createdBy`); legacy rows fall back to `requestedBy`/`owner` | `createdBy` (pinned on POST) |
| **Approval request** (`PUT /approval-requests/:id/decision`) | the role assigned to the **current step**, **or** (Allocation steps only) the specific resource identified by `step.approverId` (resource-id match); `admin` may decide any step; an `'unknown'` actor is rejected 401 | the **requester** (`requestedBy`) | `requestedBy` (pinned on POST); `step.approverId` (Allocation only, see below) |
| **Allocation** (`PUT /approval-requests/:id/decision`, kind `Allocation`) | the resource's **People Manager** (`step.approverId`, matched in resource-id space via `actorResourceId`) — **or** a `resource-manager` in whose **org scope** the resource falls (D, see [Allocation decisions are scoped](#d--allocation-decisions-are-scoped-to-the-competent-manager)) — **or**, only when the resource has **no manager anywhere**, any `resource-manager`; `admin` may decide any step | the **proposer** (`requestedBy`, the actor who called `POST /assignments/:id/months/:month/submit` — B3's per-month submit endpoint; see below) | `requestedBy` (pinned at open); `step.approverId` = the resource's `managerId` at approval-creation time |
| **Allocation, batched** (`POST /allocation-approvals/decide`, B3) | identical — the batch resolves each item's month row to its `approvalId` and runs the **same** `decideOneApproval` core, so SoD and per-step enforcement are one implementation, not two | identical (the **requester** of each item's approval) | identical; the month row's `approvalId` is server-written only (never taken from the body) |

**Approval routing** (`buildApprovalSteps`): an item whose `amount` exceeds the
high-value threshold (**50 000**) routes through a two-step chain
`delivery-executive` → `finance`. Otherwise a single approver is chosen by kind:

| Approval kind | Single-approver role |
| --- | --- |
| `TimeEntry`, `Expense` | `resource-manager` |
| `Milestone`, `ChangeRequest` | `delivery-executive` |
| `Invoice` | `finance` |
| `Allocation` | the resource's manager (`managerId`, resource-id match), with `role: 'resource-manager'` on the step — **always single-step, no €-threshold escalation** (routed directly by `createAllocationApproval`/`allocationApproverStep`, not `buildApprovalSteps`). Holding that role is what makes the step *reachable*; since D it is no longer sufficient on its own — see [Allocation decisions are scoped](#d--allocation-decisions-are-scoped-to-the-competent-manager) |

### Allocation approval (resource staffing)

**B3** moved the allocation lifecycle off the `Assignment` itself and onto the
**(assignment, month) pair**: each `AssignmentMonth` row (`Draft` → `Requested`
→ `Allocated`/`Rejected`, transitions in `allocation-month.util.ts`) carries
its own status, and `assignments.status` is now a **derived rollup** of those
rows (`deriveAssignmentStatus`, precedence `Requested > Rejected > Allocated >
Draft` — anything awaiting a decision dominates, then anything refused, then
approved work, else `Draft`). Neither `POST /assignments` nor
`PUT /assignments/:id` accepts a client-supplied `status` **at all** any
more — presence of *any* `status` field in the body is rejected with **400**
(`"status is derived from the per-month allocation and cannot be set on an
assignment"`). This is stricter than pre-B3, which allowed `Draft`/`Requested`
client-side; `refreshDerivedAssignmentStatus` is the only writer of the column
now.

The proposal/decision workflow instead runs through the **per-month
endpoints**, both reached under the existing `/assignments` mutation rule
(matched by prefix — `pm`, `resource-manager`, `delivery-executive`, `admin`;
see [Server endpoint RBAC](#server-endpoint-rbac)):

- **`POST /assignments/:id/months/:month/submit`** ("Invia mese in
  approvazione") — moves **one** month row `Draft`/`Rejected` → `Requested`
  and opens an `Allocation` approval request (`kind: 'Allocation'`, `refId` =
  the **month-row id**, i.e. `<assignmentId>:<YYYY-MM>`) with a **single
  step** routed to the resource's **People Manager** — the assignment's
  `resource.managerId`, addressed in **resource-id space**
  (`step.approverId = managerId`, `step.role = 'resource-manager'`). When the
  resource has no `managerId` set, the step still carries
  `role: 'resource-manager'` but no `approverId` — who may then decide it is
  settled by the **scope** rule at decision time, not by the role alone (D, see
  [Allocation decisions are scoped](#d--allocation-decisions-are-scoped-to-the-competent-manager)).
  The target month must be an **Open** planning period (403 otherwise), and the
  month row must currently be `Draft`/`Rejected` — an
  already-`Requested`/`Allocated` month is refused with **400** (submit is not
  idempotent).
- **`PUT /assignments/:id/months/:month/note`** — the **planner's** note on
  that month row (`plannerNote`), independent of the *approver's* note
  captured at decision time (`step.note`, mirrored onto `approverNote`).
- **Self-managed auto-approval shortcut** (unchanged from the pre-B3 flow):
  when the proposer *is* the target resource's own manager (`resource.
  managerId` equals the proposer's own resource-id, resolved via the users
  directory), the month auto-completes straight to `Allocated` with **no**
  approval request opened at all — approver and requester would be the same
  principal, so SoD would block the decision anyway.
- **Retarget propagation**: `PUT /assignments/:id` changing `resourceId`
  re-baselines every **live** month row (`Requested` or `Allocated`) against
  the **new** resource — withdrawing any pending approval, then either
  auto-approving (self-managed) or opening a fresh `Requested` approval
  routed to the new resource's manager. `Draft` and `Rejected` rows are left
  untouched (no promise was made / the conversation is closed).
- **Decision-endpoint step enforcement** (shared by `PUT
  /approval-requests/:id/decision` and the B3 batch `POST
  /allocation-approvals/decide`, both through the same `decideOneApproval`
  core): a step is decided by an actor who either (a) holds the step's `role`
  (or is `admin`) **and**, for an `Allocation`, has the target resource in
  their **org scope** (D — the sub-clause that used to be absent, see
  [Allocation decisions are scoped](#d--allocation-decisions-are-scoped-to-the-competent-manager)),
  **or** (b) is the specific resource identified by `step.approverId`. The
  resource-id match in (b) is what lets the named manager decide their own
  reports' allocations; the scope clause in (a) is what stops an unrelated
  `resource-manager`-role holder deciding anyone's.
- On decision, the approver's `note` (if supplied) is recorded on the
  **decided step** (`step.note`), never on the approval request's top-level
  `note` (which remains the *requester's* note captured at creation).
- On a terminal `Approved`/`Rejected` decision, `applyAllocationDecision`
  parses `refId` (`parseMonthRowId`): a **composite** id transitions that one
  month row and then re-derives the assignment's rollup `status`; a **bare**
  assignment id is a **legacy** approval opened before the B3 migration and is
  applied directly to the assignment's `status` so nothing already in flight
  is orphaned. Either way the resource/request staffing aggregates are
  recomputed afterwards.

### D — allocation decisions are scoped to the competent manager

**This replaces the gap-A rule.** Until D, holding the `resource-manager` role
was the whole answer for an allocation step: *any* resource manager other than
the proposer could decide *anyone's* allocation, deliberately, so that a single
manager was not a bottleneck for their own team. That decision was **reopened
and changed**: an actor who does not manage the resource can no longer decide
its allocation. Whoever used to approve allocations for people they do not
manage stops being able to.

The rule lives in one place — `decideOneApproval` (`src/server.ts`) — and is
derived by the pure layer `src/app/services/org-scope.util.ts`. An actor may
decide an `Allocation` step when **any** of these holds:

1. they are the step's **named approver** (`step.approverId`, a resource id —
   how `allocationApproverStep` routes the step);
2. they are an **accountable manager** of the target resource — in its transitive
   org chart, or the manager of a node above it
   (`accountableApproversOf(...).managerIds`). **This holds on its own, whatever
   their global role**: the node's manager *is* the Capability Leader / Practice
   Manager / Competence Manager, and that authority comes from the structure, not
   from a role. Safe because it is not the only gate — `roleGate` has already
   limited `/approval-requests` mutations to the approver-grade roles, so rule 2
   decides *which* resources, not *whether*;
3. they hold the step's **role** *and* the target resource is in their **org
   scope**;
4. they hold the step's role *and* the target has **no accountable manager
   anywhere** (`accountableApproversOf(...).roleFallback`) — the last resort;
5. their role is **`admin`**.

**Org scope** (`scopeOf`) is the union of two orthogonal axes:

| Axis | Field | Meaning |
| --- | --- | --- |
| **Org chart** | `Resource.managerId`, **transitively** | a manager reaches their direct reports *and* their reports' reports, to any depth |
| **Org tree** | `ResourceOrganization.managerId` over `parentId` | the manager of a node reaches every resource attached at or **below** it — a `capability` leader covers the `practice` and `competence` nodes beneath, with no org-chart link needed |

A node's `managerId` **is** the manual's Capability Leader / Practice Manager /
Competence Manager. **No new role exists** — the seven roles are unchanged; a
node manager is data, and their reach is derived.

**The fallback and its exact condition.** `roleFallback` is true **only** when
`accountableApproversOf` finds *nobody* accountable: no manager in the org chart
above the target, no `managerId` on any node above it, **and** nobody left after
the terminated are dropped. Then, and only then, any `resource-manager` may
decide — which is what keeps a placeholder (dummy) and C2's substitutions
decidable with no special case. Two consequences worth stating:

- a person who manages the very node they are attached to and has no `managerId`
  of their own is removed from their own approver set (nobody may approve their
  own allocation), so they legitimately fall into `roleFallback`;
- an approver who **cannot act** does not suppress the fallback. Nothing revisits
  a stored `managerId` when a `terminationDate` is set, and there is no
  `DELETE /resources`, so a departed manager would otherwise stay in the
  structural set, keep `roleFallback` false, and make the whole subtree beneath
  them admin-only — silently. `isTerminatedAsOf` (the same rule the People screen
  shows the Terminated badge under) drops them first.

**`admin` and `delivery-executive` stay global** and are never narrowed by
scope. Note what that does *not* mean for an allocation: a `delivery-executive`'s
**role** matches no allocation step, so being a delivery-executive grants them
nothing here. They reach an allocation only as the step's named approver or
through rule 2 — by actually being accountable for that resource. Being global
exempts them from scope; it does not grant them a step their role was never
routed to.

**Segregation of duties is separate and binds every role**, `admin` included:
the requester can never decide their own item. Scope is checked on top of it,
not instead of it. That is precisely why the **auto-approval shortcut**
(`autoApprovesAllocation`) exists: when the person proposing an allocation is the
*only* one competent to approve it, opening a real approval would deadlock it —
they cannot decide it (SoD) and nobody else is competent (scope) — so the month is
approved implicitly on submit, landing `Allocated` with no `approvalId`.

**It reaches exactly as far as a deadlock can, and no further.** It fires when the
proposer is:

- the resource's **direct people manager** (`Resource.managerId`) — unchanged
  since before D; or
- an **accountable manager with nobody else accountable alongside them**, which is
  how a Capability Leader / Practice Manager confirms the placeholders they just
  planned under their own node.

It deliberately does **not** fire in two adjacent cases, because neither can
strand:

- a merely **transitive** org-chart manager — the direct manager can still decide
  it, so a real approval opens, exactly as it always has;
- a **node manager when the resource also has a direct people manager**. That
  approval is pinned to the direct manager by `allocationApproverStep`, faces no
  SoD conflict and no scope refusal, and is decided by a human. Auto-approving
  there would not resolve a deadlock — it would silently delete a working review
  step, and (since D admits any accountable manager) would let a `pm` who manages
  a node self-approve across their whole subtree.

**Where else the same rule applies:**

- **`GET /allocation-approvals`** — for a **`resource-manager`** the feed is
  scoped by the *same* rule (`scopeOf`, plus the `roleFallback` rows), so they
  see exactly the rows they can act on. Those two are duals: `scopeOf` walks down
  the edges `accountableApproversOf` walks up, and both use the same
  terminated-manager filter, so for that role the feed and the decision cannot
  disagree.
  **For the two global roles they deliberately do disagree, and by a lot.**
  `admin`/`delivery-executive` see **every** row. An `admin` can also decide every
  row. A `delivery-executive` **cannot** — their role is routed to no allocation
  step, so they can decide only the rows where they are the named approver or an
  accountable manager (rule 2), which in a typical directory is a small fraction
  of what their feed shows. That is intentional: a global oversight role should
  see the whole queue without being handed authority over it. Do not "fix" it
  into consistency in either direction.
- **Two 403s, worded apart** — an actor who holds the role but is out of scope
  gets *"Actor does not manage this resource and cannot decide its
  allocation"*, distinct from the role/step refusal (which now also covers an
  actor whose role was never routed here *and* who is not accountable for the
  resource). Neither message names the resource's managers or its org node: the
  actor has just failed an authorization check on that resource, so naming who
  *would* be competent would leak org structure to exactly the wrong person.
- **The UI mirrors it, as UX only** — `canDecideFor` in
  `allocation-approvals/approval-modal.component.ts` and `scopeAllows` +
  `isAccountableFor` in `approvals/approvals.ts` (the Approvals Inbox) all call
  `accountableApproversOf` so no screen offers a decision button the server would
  refuse. Neither can predict segregation of duties, which is the other reason
  the auto-approval shortcut above matters: without it a manager's own row would
  render an enabled Approve button the server always refuses. The server remains
  the authority.

### C2 — substituting a dummy with a real person

**`POST /assignment-months/:id/substitute`** — `:id` is the **dummy's** month
row. Body `{ targetResourceId, applyToRemainingMonths?: boolean }`. It moves that
month's booked hours to a real person, day by day, capped by what the person can
actually absorb (`min(dummy hours, their remaining daily capacity)`); whatever
does not fit **stays on the dummy** for a second person.

**Rule:** `resource-manager`, `delivery-executive`, `admin` — matched by
`p.startsWith('/assignment-months')`, its own rule, **not** the `/assignments`
one. Substituting is an *approver* action (the same roles that decide
allocations), so the gate is deliberately **narrower** than the rule that lets a
planner book the dummy's hours in the first place: **`pm` gets 403**, before the
handler runs and therefore without leaving any state behind. The smoke suite
asserts that negative (`checkDummySubstitution`) so the rule cannot drift away
from this table silently.

Validation, in the handler on top of RBAC:

- **404** when the month row does not exist.
- **400** when the row does not belong to a `kind='dummy'` resource, when
  `targetResourceId` is missing, unknown, not `internal`, terminated, or is the
  dummy itself, or when the row references a missing assignment.
- **403** when the month's planning period is not `Open` — a substitution moves
  hours, so B1's open-month gate applies exactly as it does to a day-row edit.
- **200 with `transferredHours: 0`** and a human-readable `skipped` reason when
  the target has no room left (or the dummy has no hours booked). That is an
  outcome, not an error: it says another person is needed.

**No new approval role.** The person's month lands `Requested` with an ordinary
single-step `Allocation` approval routed to **her own** People Manager — the same
approval object, routing and SoD as a B3 submit. The self-managed shortcut above
applies unchanged: when the substituting actor *is* the target's manager, the
month goes straight to `Allocated` with no approval opened.

**Reversibility.** The transfer is immediate (the hours leave the dummy at once,
so demand is never double-counted) but reversible until the decision: the
person's month row carries a transient back-link to the dummy month
(`replacedFromAssignmentMonthId`) plus the per-day map of what moved
(`replacedDays`) and, over the same dates, what she already held before it
(`replacedBaselineDays` — a date can carry both, and the split is not
reconstructable afterwards). The decision closes the link: a rejection returns
every transferred hour, an approval returns only what the approver trimmed off the
**loan**, and neither branch may ever reduce her below her own baseline. A
give-back that restores hours onto a `Rejected` placeholder month reopens it to
`Requested` with a fresh approval, so the restored demand still counts on
`/capacity/monthly`. See
[`docs/architecture/03-backend-and-data.md`](architecture/03-backend-and-data.md)
for the three columns and why the back-link is not a foreign key.

**Audit.** The substitution POST records the ordinary
method/path/status/actor entry, but **no** before/after diff (the middleware only
snapshots for PUT/DELETE), and the give-back — which runs inside the decision
hook rather than as its own request — records none of its own beyond the month's
status transition. Neither side records *which day rows moved*. Known gap, open
for both sides together.

---

## Demo users & how role is derived

The seeded `psa` realm (`keycloak/realm-export.json`) ships three users.
Passwords equal the username (dev only). Each holds the composite
`default-roles-psa` (which grants `employee`) plus one explicit role:

| Username | Password | Realm roles | Effective role (highest-wins) | Resource id |
| --- | --- | --- | --- | --- |
| **julie** | `julie` | `default-roles-psa`, `delivery-executive` | **`delivery-executive`** | `1` |
| **john** | `john` | `default-roles-psa`, `finance` | **`finance`** | `2` |
| **alice** | `alice` | `default-roles-psa`, `pm` | **`pm`** | `3` |

### How the role is derived

1. The browser logs in via OIDC; Keycloak emits `realm_access.roles` in the
   **access token** (and `preferred_username`/`name` in the ID token).
   `AuthService` merges both sets of claims.
2. `role()` collapses `realm_access.roles` to the **highest-privilege** match
   (`ROLE_PRIORITY`). With no claims it defaults to `employee`.
3. The server independently re-derives the role from the verified JWT
   (`highestRole`) — it never trusts the client's computed role.

### Username → resource id

The app keys demo data by **resource id**, so the username is mapped to one
(`USERNAME_TO_RESOURCE_ID` in `auth.service.ts`):

```ts
{ julie: '1', john: '2', alice: '3' }   // default: '1'
```

An unmapped username falls back to resource id `'1'`. This mapping also makes
SoD work in demo mode: the `errorInterceptor` sends the mapped resource id as
`X-User-Id`, which the server's `actorResourceId` matches by id.

> To add a role to a user, or add a new realm role, follow
> [`functional/keycloak-setup.md`](functional/keycloak-setup.md). Changing the
> code's role sets (`ROLE_PRIORITY`, `READ_RULES`, the mutation `rules`, or the
> capability computeds) requires a code change in `src/server.ts` /
> `auth.service.ts`.

---

## See also

- [`architecture/04-security-identity.md`](architecture/04-security-identity.md)
  — the end-to-end auth model and rationale.
- [`architecture/03-backend-and-data.md`](architecture/03-backend-and-data.md)
  — the backend and the entities these rules protect.
- [`functional/keycloak-setup.md`](functional/keycloak-setup.md) — realm setup
  and role assignment.
- [`functional/00-overview.md`](functional/00-overview.md) — the functional
  areas the roles map onto.
- [`glossary.md`](glossary.md) — term definitions.
