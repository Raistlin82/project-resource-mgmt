# Functional Documentation — Master Index

> **Diátaxis mode: How-to / Reference.** This is the functional master index for
> **Delivery Control**, the Professional Services Automation (PSA) platform. Each
> functional area below links to a document of **Standard Operating Procedures
> (SOPs)**: who does what, when, how (in the UI / API), and what comes out. For
> the architectural mental model see [`../architecture/01-overview.md`](../architecture/01-overview.md);
> for the term definitions see [`../glossary.md`](../glossary.md).

Delivery Control runs the delivery business end to end: it keeps **people**,
**demand**, **projects**, **commercial agreements**, **billing/revenue**, and
**governance** consistent with one another, so that — for example — a milestone
being achieved makes a fixed-price billing item billable, and an approved change
request flows into the project's effective budget without manual re-keying.

---

## Functional area map

| # | Functional area | Document | Primary roles | Key processes |
|---|-----------------|----------|---------------|---------------|
| 1 | Resource management | [`resource-management.md`](resource-management.md) | `employee`, `pm`, `resource-manager`, `delivery-executive` | Maintain profile; log & submit time; create/publish resource requests; match & rank candidates and assign; approve time (SoD); **record absences**; monitor utilization, the **bench** and availability; capacity forecast; what-if scenarios |
| 2 | Project delivery | [`project-delivery.md`](project-delivery.md) | `pm`, `delivery-executive`, `finance` | Create projects; **classify the engagement (billable vs non-billable BASKET)**; Project 360 review; tasks; issues & escalation; work packages/plans; financial plans & project cost centers; partners & documents; change requests (SoD); milestone → billing "Ready" |
| 3 | Commercial | [`commercial.md`](commercial.md) | `sales`, `finance`, `delivery-executive` | Customers; contracts; orders & order lines; purchase orders; invoice numbering |
| 4 | Billing & revenue | [`billing-and-revenue.md`](billing-and-revenue.md) | `finance`, `delivery-executive` | Billing-plan items; milestone/progress → "Ready"; capped not-to-exceed; revenue recognition; A/R aging |
| 5 | Approvals & governance | [`approvals-governance.md`](approvals-governance.md) | `pm`, `resource-manager`, `finance`, `delivery-executive`, `admin` | Multi-step approval engine; step-role enforcement; segregation of duties; append-only audit trail |
| 6 | Reporting & analytics | [`reporting-analytics.md`](reporting-analytics.md) | `pm`, `resource-manager`, `finance`, `delivery-executive` | Portfolio rollups; **fully-loaded margin**; margin drivers; realization; customer profitability; margin-compression alerts; CSV and RPT `.xlsx` exports |
| 7 | Configuration | [`configuration.md`](configuration.md) | `admin`, `delivery-executive` | Skill catalogs; proficiency sets; skills; project roles; resource organizations; languages; cost centers |
| 8 | Integrations | [`integrations.md`](integrations.md) | `finance`, `delivery-executive`, `admin` | ERP GL journal export; e-invoice (FatturaPA) generation; CRM outbox; BI financial feed |
| 9 | Keycloak / identity setup | [`keycloak-setup.md`](keycloak-setup.md) | `admin` | Realm, clients, roles, JWT verification, audience pinning |

For the canonical role definitions and the full permission matrix, see
[`../roles-and-permissions.md`](../roles-and-permissions.md).

---

## Roles at a glance

Delivery Control has **seven roles**, ordered by privilege (highest-privilege
wins when a Keycloak token carries several realm roles — verified in
`src/server.ts` `ROLE_PRIORITY` and mirrored in `src/app/services/auth.service.ts`):

```
admin > delivery-executive > finance > sales > resource-manager > pm > employee
```

- **employee** — owns their profile, assignments, and timesheets.
- **pm** — project manager: raises demand, runs projects, raises change requests.
- **resource-manager** — staffs demand, approves time, rebalances utilization, owns capacity forecasting.
- **sales** — owns the commercial pipeline (customers, contracts, orders).
- **finance** — owns financials, billing, revenue, and integrations.
- **delivery-executive** — cross-domain authority; approves change requests; reads everything.
- **admin** — full access, including configuration and the audit trail.

### How authorization is enforced

Authorization is **server-side**. The Angular SPA hides controls a user cannot
use, but the authoritative gate is `roleGate` in `src/server.ts`:

1. **Authentication.** Any `Authorization: Bearer <token>` is verified against the
   Keycloak realm JWKS + issuer (`OIDC_ISSUER`), with the audience (`OIDC_AUDIENCE`)
   pinned when configured. A **valid** token's role wins over any client header.
   An **invalid** token → `401`. **No** token → the demo `X-User-*` headers are
   trusted **only** when `AUTH_TRUST_HEADERS=true` (dev-only); otherwise the actor
   is `unknown` and privileged mutations are denied.
2. **Write RBAC.** `POST`/`PUT`/`DELETE` are gated per collection (see the matrix
   below).
3. **Read RBAC.** Sensitive `GET`s (`/audit-logs`, commercial collections,
   `/resources` + `/users`, `/time-entries`, `/integrations`) are gated; other
   reference reads stay open.
4. **Segregation of duties (SoD).** Beyond the role gate, specific transitions
   block the actor from approving their own work (time-entry approval, change-request
   approval, approval-engine steps). The SoD basis is a **server-pinned** identity
   (the time entry's `resourceId`, the change request's `createdBy`), never a
   client-supplied field.

### Mutation RBAC matrix (verified in `src/server.ts`)

| Collection(s) | Roles allowed to mutate |
|---|---|
| `/resources` | `resource-manager`, `delivery-executive`, `admin` |
| `/absences` | `resource-manager`, `admin` (`pm` and `employee` deliberately excluded) |
| `PUT /projects/:id/classification` | `delivery-executive`, `admin` (narrower than `/projects`, and registered **before** it) |
| `/assignments`, `/requests` | `pm`, `resource-manager`, `delivery-executive`, `admin` |
| `/time-entries` | `employee`, `pm`, `resource-manager`, `finance`, `delivery-executive`, `admin` (approval additionally SoD-gated: approver ≠ entry owner) |
| `/projects`, `/project-partners`, `/project-documents`, `/work-packages`, `/milestones`, `/project-tasks`, `/project-issues`, `/change-requests` | `pm`, `delivery-executive`, `admin` |
| `/project-financials`, `/project-cost-centers`, `/cost-centers` | `finance`, `delivery-executive`, `admin` |
| `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items` | `sales`, `finance`, `delivery-executive`, `admin` |
| `/skill-catalogs`, `/proficiency-sets`, `/skills`, `/project-roles`, `/resource-organizations`, `/languages` | `admin`, `delivery-executive` |
| `/approval-requests` (+ `/decision`) | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/integrations/*` (actions) | `finance`, `delivery-executive`, `admin` |

### Read RBAC matrix (sensitive collections only)

| Collection(s) | Roles allowed to read |
|---|---|
| `/audit-logs` | `admin`, `delivery-executive` |
| `/absences` (with the **reason** — GDPR art. 9) | `resource-manager`, `delivery-executive`, `admin`; `employee` narrowed to their own rows |
| `/absences/calendar` (redacted: who and when, never why), `/capacity`, `/bench` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/customers`, `/contracts`, `/orders`, `/order-lines`, `/billing-plan-items` | `sales`, `finance`, `delivery-executive`, `admin` |
| `/project-financials`, `/project-cost-centers`, `/cost-centers` | `finance`, `delivery-executive`, `admin` |
| `/resources`, `/users` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/assignments`, `/requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/time-entries` | `employee`, `pm`, `resource-manager`, `delivery-executive`, `finance`, `sales`, `admin` |
| `/approval-requests` | `pm`, `resource-manager`, `delivery-executive`, `finance`, `admin` |
| `/integrations/*` | `finance`, `delivery-executive`, `admin` |

All other `GET`s (catalogs, non-financial config reference, `/projects` and
non-financial project sub-resources) stay open to any caller, as non-sensitive
reference reads.

---

## SOP format legend

Every feature in the functional documents follows the same Standard Operating
Procedure shape, so a reader always knows where to look:

| Section | What it contains |
|---|---|
| **`### <Feature>`** | The feature name as a heading. |
| **Purpose** | One or two sentences: what the procedure achieves and why it exists. |
| **Scope** | What is **in** scope and what is explicitly **out** of scope. |
| **RACI table** | `Step | Responsible role | Accountable role | Consulted | Informed`. Roles match the real RBAC above. |
| **Process flow** | A `mermaid flowchart TD` diagram of the happy path. |
| **Detailed steps** | Numbered steps; each states **Who** (exact role), **When** (trigger), **How** (concrete UI action / API call), **Output**. |
| **Exceptions & edge cases** | A table of what can go wrong and how the system responds. |
| **Metrics** | A table of how the feature's effectiveness is measured. |
| **Related** | Links to adjacent SOPs and reference material. |

> **RACI key.** **R**esponsible = does the work; **A**ccountable = owns the
> outcome / sign-off (one role); **C**onsulted = two-way input; **I**nformed =
> kept up to date one-way.

### Development vs production

Where a step differs between environments it is called out inline. The two that
matter:

- **Persistence.** **Production** persists all data in **PostgreSQL** (via Drizzle)
  and uses **Keycloak** for identity. **Development** may run fully in-memory and,
  when `AUTH_TRUST_HEADERS=true`, trust demo `X-User-*` headers. The *steps* are
  identical; only the durability and the identity source change.
- **Identity.** In production the actor is the verified JWT subject
  (`preferred_username` / `sub`); in header-trust dev mode it is the demo header
  identity. SoD checks resolve the actor to a **resource id** through the user
  directory before comparing, so they behave identically in both modes.
