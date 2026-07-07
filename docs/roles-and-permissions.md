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
| `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items` | `sales`, `finance`, `delivery-executive`, `admin` |
| `/project-financials`, `/project-cost-centers`, `/cost-centers` | `finance`, `delivery-executive`, `admin` |
| `/resources` (incl. `/resources/:id`), `/users` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/assignments`, `/requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/time-entries` | `employee`, `pm`, `resource-manager`, `delivery-executive`, `finance`, `sales`, `admin` |
| `/approval-requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/integrations` | `finance`, `delivery-executive`, `admin` |

**Open reads (no rule):** all other GETs — catalogs (`/skill-catalogs`,
`/proficiency-sets`, `/skills`, `/project-roles`), config (`/languages`,
`/fx-rates`, `/service-organizations`, `/resource-organizations`,
`/projects` and non-financial project sub-resources, `/storage-status`, etc.

### (b) Mutation rules — POST / PUT / DELETE

A role not in the matched rule's list gets **403**. Path tests use `startsWith`
(or `some(prefix => p.startsWith(prefix))`).

| Collection(s) | Allowed roles |
| --- | --- |
| `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items` | `sales`, `finance`, `delivery-executive`, `admin` |
| `/project-financials`, `/project-cost-centers`, `/cost-centers` | `finance`, `delivery-executive`, `admin` |
| `/resources` | `resource-manager`, `delivery-executive`, `admin` |
| `/time-entries` | `employee`, `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/assignments`, `/requests` | `pm`, `resource-manager`, `delivery-executive`, `admin` |
| `/projects`, `/project-partners`, `/project-documents`, `/work-packages`, `/milestones`, `/project-tasks`, `/project-issues`, `/change-requests` | `pm`, `delivery-executive`, `admin` |
| `/skill-catalogs`, `/proficiency-sets`, `/skills`, `/project-roles`, `/resource-organizations`, `/languages` | `admin`, `delivery-executive` |
| `/approval-requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/integrations` | `finance`, `delivery-executive`, `admin` |

**Open mutations (no rule):** collections not matched above are open to any
verified actor, e.g. `/service-organizations` (read-only in practice). Note
`/fx-rates` mutations are **not** covered by `roleGate` and are enforced
**inline** in the handler: only `admin` may `PUT /fx-rates/:currency` (and the
base currency `EUR` is fixed at rate 1).

> Two collections appear in the *read* rules but have **no mutation rule**:
> `/audit-logs` (append-only; written only by the audit middleware, never via a
> client mutation) and `/users` (read-only directory). The mutation `/resources`
> rule is *narrower* than its read rule — `pm`/`finance` may *read* resources
> (margin/staffing need-to-know) but not rewrite cost/bill rates.

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
| **Commercial** (`/customers`, `/contracts`, `/orders`, `/order-lines`) | — | — | — | Full | Full | Full | Full |
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
| **Approval request** (`PUT /approval-requests/:id/decision`) | the role assigned to the **current step** (`admin` may decide any step); an `'unknown'` actor is rejected 401 | the **requester** (`requestedBy`) | `requestedBy` (pinned on POST) |

**Approval routing** (`buildApprovalSteps`): an item whose `amount` exceeds the
high-value threshold (**50 000**) routes through a two-step chain
`delivery-executive` → `finance`. Otherwise a single approver is chosen by kind:

| Approval kind | Single-approver role |
| --- | --- |
| `TimeEntry`, `Expense` | `resource-manager` |
| `Milestone`, `ChangeRequest` | `delivery-executive` |
| `Invoice` | `finance` |

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
