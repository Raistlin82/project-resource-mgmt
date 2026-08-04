# Delivery Control

A **Professional Services Automation (PSA)** platform for running a delivery
organisation end to end: resource management, project delivery, the commercial
chain (customers → contracts → orders), billing & revenue recognition,
approvals & governance, and portfolio reporting — with role-based access and an
append-only audit trail.

Built as an **Angular 21 SSR** front end on an **Express 5** API, with a
repository layer that runs in-memory for local development and on **PostgreSQL
(Drizzle ORM)** in production, and **Keycloak (OIDC + PKCE)** for identity.

---

## 📚 Documentation

Full documentation lives in [`docs/`](docs/README.md) — start there.

| Area | Entry point |
|------|-------------|
| Documentation home + table of contents | [`docs/README.md`](docs/README.md) |
| Architecture (overview, frontend, backend & data, security, integrations, ops) | [`docs/architecture/`](docs/architecture/01-overview.md) |
| Functional guides (SOPs with per-step roles) | [`docs/functional/00-overview.md`](docs/functional/00-overview.md) |
| Roles & permissions (the 7 roles + capability matrix) | [`docs/roles-and-permissions.md`](docs/roles-and-permissions.md) |
| **Keycloak setup** (step-by-step) | [`docs/functional/keycloak-setup.md`](docs/functional/keycloak-setup.md) |
| **Install & deploy (incl. Docker)** | [`docs/architecture/06-deployment-operations.md`](docs/architecture/06-deployment-operations.md) |
| Glossary | [`docs/glossary.md`](docs/glossary.md) |

---

## 🚀 Quick start (local development)

No database or identity provider required — the API uses an in-memory repository
seeded with demo data when `DATABASE_URL` is unset.

```bash
npm install          # use install, not ci (lockfile may be ahead)
npx ng serve         # dev server on http://localhost:4200
```

> **Why `npx ng serve` and not `npm run dev`?** The `dev` script binds
> `--host=0.0.0.0`, which makes Angular's host check reject `localhost` with a
> 400. Plain `npx ng serve` binds `localhost` and works out of the box. To use
> `0.0.0.0`, set the allowed hosts via `NG_ALLOWED_HOSTS` (see `.env.example`).

For the **full stack** (PostgreSQL + Keycloak, production parity or full Docker),
see [Deployment & Operations](docs/architecture/06-deployment-operations.md) and
the [Keycloak setup guide](docs/functional/keycloak-setup.md).

```bash
# Dependencies (Postgres + Keycloak), realm auto-imported:
docker compose up -d postgres keycloak

# App tier in Docker too:
docker compose -f docker-compose.yml -f docker-compose.app.yml up -d --build
```

### Demo users (local only)

| Username | Password | Role |
|----------|----------|------|
| `julie`  | `julie`  | delivery-executive |
| `john`   | `john`   | finance |
| `alice`  | `alice`  | pm |
| `admin`  | `admin`  | Keycloak admin console |

---

## 🧩 Tech stack

| Layer | Technology |
|-------|-----------|
| Front end | Angular 21 (signals, `rxResource`, native control flow, OnPush), SSR |
| API | Express 5 (`src/server.ts`), SSR entry `dist/app/server/server.mjs` |
| Data | Repository pattern — in-memory (dev) ↔ PostgreSQL + Drizzle ORM (prod) |
| Identity | Keycloak OIDC, Authorization Code + PKCE, realm `psa`, client `psa-web` |
| Integrations | Pluggable adapter seam (ERP/GL, FatturaPA e-invoice, CRM, BI feed) |

See [Architecture overview](docs/architecture/01-overview.md) for the full picture.

---

## 👤 Roles

Seven roles, highest privilege first:
`admin` › `delivery-executive` › `finance` › `sales` › `resource-manager` › `pm` › `employee`.

Access is enforced server-side (verified JWT role wins; client headers are never
trusted for authorization unless `AUTH_TRUST_HEADERS=true`, local only), with
Segregation of Duties on time entries, change requests and approvals. Details in
[Roles & permissions](docs/roles-and-permissions.md).

---

## 🛠️ Common commands

```bash
npx ng serve            # dev server (http://localhost:4200)
npm run build           # production build (browser + SSR)
npm run serve:ssr:app   # run the built SSR server (dist/app/server/server.mjs)
npm test                # unit tests
npm run lint            # lint
```

---

## ⚙️ Configuration

Copy `.env.example` and set the values for your target environment. Key
variables: `PERSISTENCE_ADAPTER` (`memory`/`postgresql`), `DATABASE_URL`,
`SEED_DEMO_DATA` (production defaults off), `OIDC_ISSUER` /
`OIDC_PUBLIC_ISSUER` / `OIDC_JWKS_URI` / `OIDC_AUDIENCE` (Keycloak),
`AUTH_TRUST_HEADERS` (must be `false` in production),
and the `POSTGRES_*` / `KC_*` settings used by Docker Compose. The full reference
is in [Deployment & Operations](docs/architecture/06-deployment-operations.md).

---

## 📁 Project layout

```
src/
  app/          Angular application (feature areas, services, design system)
  server.ts     Express API: routing, RBAC, audit, persistence wiring
  db/           Repository layer (in-memory + Postgres/Drizzle)
  server/       Integration adapters
drizzle/        Database migrations
docs/           Project documentation (architecture + functional)
Dockerfile, docker-compose*.yml   Container packaging
```
