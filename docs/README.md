# Delivery Control — Documentation

**Delivery Control** is a **Professional Services Automation (PSA)** platform: it
runs the full delivery lifecycle of a services organization — from staffing
people onto projects, through project execution and commercial contracts, to
billing, revenue recognition, approvals, and analytics.

Technically it is an **Angular 21 server-side-rendered (SSR) single-page
application** served by an **Express backend** (`src/server.ts`). All data flows
through a **Repository abstraction** (`src/db`) that is **in-memory in
development** (when `DATABASE_URL` is unset) and **PostgreSQL in production**.
Identity is handled by **Keycloak** (OIDC, Authorization Code + PKCE); the server
verifies JWTs and enforces role-based access control (RBAC).

> **This `docs/` tree is the real documentation.** The repository-root
> `README.md` is stale scaffolding boilerplate ("Run and deploy your AI Studio
> app") and does not describe this product — ignore it.

---

## Who should read what

| You are a… | Start here |
| --- | --- |
| **Developer / Architect** | [`architecture/`](#architecture) — system design, frontend, backend, security, integrations, deployment |
| **Business / Process owner** | [`functional/`](#functional-areas) — what each functional area does and how the workflows run |
| **Security / Ops engineer** | [`architecture/04-security-identity.md`](architecture/04-security-identity.md) · [`architecture/06-deployment-operations.md`](architecture/06-deployment-operations.md) · [`functional/keycloak-setup.md`](functional/keycloak-setup.md) |
| **Maintainer / reviewer** | [`audits/2026-08-04-ui-application-audit.md`](audits/2026-08-04-ui-application-audit.md) — current defect register, remediation status and residual acceptance criteria |
| **Everyone** | [`roles-and-permissions.md`](roles-and-permissions.md) · [`glossary.md`](glossary.md) |

---

## Documentation style (Diátaxis)

These docs follow the [Diátaxis](https://diataxis.fr/) framework. Each page is
written for one of four modes, so you know what to expect before you open it:

| Mode | Purpose | Where it lives |
| --- | --- | --- |
| **Explanation** | Understanding-oriented background and rationale | most of `architecture/`, `functional/00-overview.md` |
| **Reference** | Information-oriented, look-it-up facts | [`glossary.md`](glossary.md), [`roles-and-permissions.md`](roles-and-permissions.md) |
| **How-to** | Goal-oriented, step-by-step procedures | [`functional/keycloak-setup.md`](functional/keycloak-setup.md), [`architecture/06-deployment-operations.md`](architecture/06-deployment-operations.md) |
| **Tutorial** | Learning-oriented, hands-on walkthroughs | the Quick start below, and getting-started sections |

---

## Table of contents

### Architecture

Explanation and reference for engineers and architects.

- [`architecture/01-overview.md`](architecture/01-overview.md) — system context, the four layers, dev-vs-prod runtime, tech stack
- [`architecture/02-frontend.md`](architecture/02-frontend.md) — Angular 21 SSR SPA: routing, signals, components
- [`architecture/03-backend-and-data.md`](architecture/03-backend-and-data.md) — Express API, the Repository abstraction, Drizzle schema, PostgreSQL
- [`architecture/04-security-identity.md`](architecture/04-security-identity.md) — Keycloak OIDC, JWT verification, RBAC, demo header trust
- [`architecture/05-integrations.md`](architecture/05-integrations.md) — ERP, e-invoice, CRM, and BI adapters
- [`architecture/06-deployment-operations.md`](architecture/06-deployment-operations.md) — **Docker install/deploy**, configuration, operations

### Roles and permissions

- [`roles-and-permissions.md`](roles-and-permissions.md) — the 7 roles, the highest-wins hierarchy, and what each role can do (read/write RBAC)

### Functional areas

What the product does, by area, for business and process owners.

- [`functional/00-overview.md`](functional/00-overview.md) — the functional map and how the areas connect
- [`functional/resource-management.md`](functional/resource-management.md) — resources, requests, assignments, staffing, utilization
- [`functional/project-delivery.md`](functional/project-delivery.md) — projects, plans, tasks, issues, milestones, change requests
- [`functional/commercial.md`](functional/commercial.md) — customers, contracts, orders, order lines
- [`functional/billing-and-revenue.md`](functional/billing-and-revenue.md) — billing plans, billing types, revenue recognition
- [`functional/approvals-governance.md`](functional/approvals-governance.md) — approval requests, segregation of duties, the audit trail
- [`functional/reporting-analytics.md`](functional/reporting-analytics.md) — forecast, what-if, utilization, reporting
- [`functional/configuration.md`](functional/configuration.md) — skill catalogs, proficiency sets, project roles, cost centers, organizations, languages
- [`functional/integrations.md`](functional/integrations.md) — the integration functional surface (GL journal, e-invoices, CRM feed, BI feed)
- [`functional/keycloak-setup.md`](functional/keycloak-setup.md) — **how-to**: stand up the `psa` realm, client, and roles

### Glossary

- [`glossary.md`](glossary.md) — alphabetized domain and technical terms

### Audits

- [`audits/2026-08-04-ui-application-audit.md`](audits/2026-08-04-ui-application-audit.md) — UI/UX and application-logic findings, fixes and guarded backlog

---

## Quick start

### Development (in-memory, no database)

With no `DATABASE_URL` set, the app runs entirely on the in-memory Repository
adapter — no Postgres or Keycloak required to click around.

```bash
npm install            # NOT `npm ci` — the lockfile may be out of sync
npx ng serve           # serves the SSR app on http://localhost:4200
```

> Use `npx ng serve` rather than `npm run dev`: the `dev` script binds
> `--host=0.0.0.0`, which can trip Angular's SSR host allow-list on `localhost`.

### Production-parity (PostgreSQL + Keycloak)

Bring up the infrastructure, then build and run the app pointed at it:

```bash
docker compose up -d   # Postgres :5432, Keycloak :8081 (realm 'psa')

# then build and run the SSR server with persistence + identity wired up:
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/project_resource_mgmt"
export OIDC_ISSUER="http://localhost:8081/realms/psa"
npm run build
npm run serve:ssr:app  # app listens on :3000
```

Full configuration, environment variables, and operational guidance are in
[`architecture/06-deployment-operations.md`](architecture/06-deployment-operations.md),
which covers the Docker install and deploy in detail. Keycloak realm/client/role
setup is in [`functional/keycloak-setup.md`](functional/keycloak-setup.md).
