# Glossary

> **Diátaxis mode: Reference.** Alphabetized domain and technical terms used
> across Delivery Control. Each entry is a one- or two-line definition. Billing
> types are taken verbatim from the `BillingType` union in
> `src/app/services/api.service.ts`.

## A

**Advance** — Billing type: a down payment taken up front, before delivery.

**AR Aging** — Accounts-receivable aging: the breakdown of outstanding invoices
by how long they have been unpaid (e.g. 0–30, 31–60, 61–90, 90+ days).

**Approval** — A governance gate (an approval request) that must be granted
before an action takes effect; routed by role and subject to segregation of
duties.

**Assignment** — The allocation of a Resource to a Resource Request for a number
of assigned hours; the source of truth from which a resource's utilization is
recomputed.

**Audit log** — The append-only forensic trail: every mutating API call is
recorded (actor, role, method, path, status, before/after diff) and entries are
never edited or deleted.

**Backlog** — Contracted-but-not-yet-delivered/recognized work; the remaining
value still to be earned on signed commercial agreements.

**Base currency / FX** — The single reporting currency that all amounts are
converted into (via FX rates) so multi-currency contracts can be compared and
aggregated.

**Bearer token** — A JWT presented in the `Authorization: Bearer <token>` header;
the backend verifies it against Keycloak before trusting the caller's identity.

**Billing type** — The model that governs how a billing plan item is invoiced.
The eight values are: **Milestone**, **Recurring**, **TimeAndMaterials**,
**Capped**, **Advance**, **Progress**, **Expense**, **CreditNote** (each defined
in this glossary).

**Burn** — The rate at which a project consumes its budget (cost or effort) over
time.

## C

**Capped** — Billing type: time-and-materials with a not-to-exceed ceiling (a
cap on the total billed amount).

**Change Request (CR)** — A formal proposal to change a project's scope, budget,
or schedule; carries an impact assessment and moves through Draft → Submitted →
Approved/Rejected → Implemented.

**Client** (Keycloak) — A registered application in a realm. Here the SPA is the
`psa-web` client that performs the OIDC login.

**Contract** — A signed commercial agreement with a Customer that frames what is
being delivered and on what terms; parent of Orders and billing plan items.

**Cost rate** — The internal hourly cost of a resource; combined with bill rate
to compute margin. Confidential — read-restricted by RBAC.

**CreditNote** — Billing type: a *nota di credito* — a negative billing item that
reverses or reduces a previously invoiced amount.

## D

**DSO** — Days Sales Outstanding: the average number of days it takes to collect
payment after invoicing; a cash-flow / collections health metric.

## E

**EAC** — Estimate At Completion: the forecast total cost (or effort) of a
project once it is finished.

**ETC** — Estimate To Complete: the forecast remaining cost (or effort) from now
until project completion (EAC = actuals + ETC).

**Expense** — Billing type: pass-through expenses re-invoiced to the customer,
optionally with a markup percentage.

## F

**FatturaPA** — The Italian electronic-invoice XML standard. The e-invoice
integration adapter emits FatturaPA-shaped artifacts.

**FX rate** — A currency conversion rate used to translate amounts into the base
currency. See *Base currency / FX*.

## G

**GL journal** — General-ledger journal: the double-entry (balanced
debit/credit) accounting export produced by the ERP integration adapter for
posting into a general ledger.

## H

**HHI** — Herfindahl–Hirschman Index: a concentration measure used in analytics
to gauge how concentrated revenue (or demand) is across few customers/projects
versus spread evenly.

## J

**JWKS** — JSON Web Key Set: the set of public signing keys published by
Keycloak; the backend fetches it (via `jose`'s remote JWKS) to verify JWT
signatures.

**JWT** — JSON Web Token: the signed access token issued by Keycloak and verified
by the backend (signature, issuer, and audience).

## K

**Keycloak realm** — An isolated identity domain in Keycloak. This product uses
the **`psa`** realm (issuer `http://localhost:8081/realms/psa`), which contains
the users, roles, and the `psa-web` client.

## M

**Margin** — Profit on delivered work: bill amount minus cost (bill rate minus
cost rate over the hours delivered).

**Margin %** — Margin expressed as a percentage of revenue.

**Milestone** — (1) A scheduled project checkpoint with an Achieved/Pending
status. (2) **Billing type**: fixed-price (SAL) billing triggered when the linked
project milestone is achieved.

## O

**OIDC** — OpenID Connect: the identity protocol layered on OAuth 2.0 that
Delivery Control uses for login, via the Authorization Code flow with PKCE.

**Order** — A commercial order under a Contract; broken down into Order Lines.

**Order Line** — A single line item of an Order (description and amount) tied to
a project.

## P

**PKCE** — Proof Key for Code Exchange: the OAuth extension that secures the
Authorization Code flow for public clients (the browser SPA) without a client
secret.

**Progress** — Billing type: percentage-of-completion (POC) billing, invoiced
against a progress percentage rather than a fixed event.

**Project** — A unit of delivery work with an owner, dates, status, budget, and
(optionally) a linked Contract; parent of plans, tasks, issues, milestones, and
change requests.

**PSA** — Professional Services Automation: the category of platform that runs a
services organization's delivery lifecycle (resourcing, projects, commercial,
billing, governance, analytics) — what Delivery Control is.

## R

**RACI** — Responsible, Accountable, Consulted, Informed: a responsibility-
assignment model for clarifying who does what on a project or approval.

**RBAC** — Role-Based Access Control: authorization driven by the caller's role.
The backend gates both reads and writes per collection by role.

**Realization** — The proportion of potential (standard) revenue actually billed
and collected — i.e. how much of the theoretical value of delivered work is
realized after discounts, write-offs, and non-billable time.

**Recurring** — Billing type: a retainer billed on a fixed cadence (Monthly,
Quarterly, or Annual).

**Repository pattern** — The `Repository<T>` CRUD abstraction (`src/db`) that
isolates API code from the storage backend; an in-memory adapter (dev) and a
PostgreSQL/Drizzle adapter (prod) are interchangeable behind it.

**Resource** — A person who can be staffed: carries skills, project roles,
capacity, utilization, and (confidential) cost/bill rates.

**Revenue per FTE** — Revenue divided by full-time-equivalent headcount; a
productivity / efficiency metric.

**Revenue Recognition** — Recognizing earned revenue over time (per accounting
rules) rather than at the moment of invoicing; the backend produces a recognition
journal.

## S

**SoD (Segregation of Duties)** — The control that one actor cannot both create
and approve the same item (e.g. a resource cannot approve their own time entry);
enforced server-side against the trusted, verified actor identity.

## T

**TimeAndMaterials (T&M)** — Billing type: billed as incurred — approved hours
multiplied by the resource's bill rate.

## U

**Utilization** — The percentage of a resource's capacity consumed by
assignments; recomputed from the full set of a resource's assignments (never a
lossy running delta) and clamped to a sensible range.

## V

**VAC** — Variance At Completion: the difference between the budget and the
Estimate At Completion (VAC = budget − EAC); positive means under budget.

## W

**WorkPackage** — A schedulable chunk of project work with dates, status, and
progress, sitting beneath a project plan.
