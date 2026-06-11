# Deployment & Operations

> **Diátaxis mode:** How-to / Runbook + Reference. Follow the steps top-to-bottom
> to install, run, and deploy **Delivery Control** (the PSA app). The later
> sections are look-up reference (env vars, migrations, ops).

This page covers three run modes — local dev, prod-parity (data+identity in
Docker, app on host), and the **full Docker stack** (the app *also* runs in a
container) — plus the environment-variable reference, database migrations,
build/test/lint, backups, and security-ops notes.

The stack (see [`01-overview.md`](01-overview.md)):

- **App** — Angular 21 SSR SPA served by Express (`src/server.ts`), default port
  **3000**.
- **Data** — Repository layer (`src/db`): **in-memory** in dev (no
  `DATABASE_URL`), **PostgreSQL** in prod (via `DATABASE_URL`).
- **Identity** — **Keycloak** (OIDC, realm `psa`), host port **8081** (host 8080
  is owned by openHAB; the Keycloak container still listens on 8080 internally).

Related pages: [`02-frontend.md`](02-frontend.md) ·
[`03-backend-and-data.md`](03-backend-and-data.md) ·
[`04-security-identity.md`](04-security-identity.md) ·
[`../roles-and-permissions.md`](../roles-and-permissions.md) ·
[`../functional/keycloak-setup.md`](../functional/keycloak-setup.md).

---

## 1. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| **Node.js** | 20.19+ or **22 LTS** | Angular 21 / `@angular/build` require Node 20.19+ or 22. The Docker image pins Node 22. |
| **npm** | 10+ | ships with Node 20/22 |
| **Docker** + **Docker Compose v2** | recent | for Postgres + Keycloak (and the full-stack app deploy) |
| **git** | any | to clone the repo |

---

## 2. Installation

```bash
git clone <repo-url> project-resource-mgmt
cd project-resource-mgmt

# Install dependencies.
npm install
```

> **`npm install`, not `npm ci`, if the lockfile has drifted.** This repo's
> `package-lock.json` can be out of sync with `package.json`; `npm ci` fails by
> design when they disagree. Use `npm install` (which reconciles and updates the
> lockfile). The Docker build uses `npm ci` for reproducibility — if it fails
> there, run `npm install` locally and commit the regenerated
> `package-lock.json`.

Set up environment configuration from the template:

```bash
cp .env.example .env
# edit .env — see the env-var reference in §6
```

`docker compose` auto-loads a sibling `.env`; the app reads its own env vars at
boot. For the local dev run mode you don't need a `.env` at all (the app defaults
to in-memory + demo auth).

---

## 3. Run mode (a): Dev — ephemeral, in-memory, demo auth

Fastest inner loop. No database, no Keycloak. Data lives in the in-memory
repositories (seeded at boot, lost on restart); identity is the demo header
mechanism.

```bash
npx ng serve
```

- Serves on **http://localhost:4200** (Angular dev server default).
- `DATABASE_URL` unset → in-memory repositories (`src/db`).
- Keycloak unreachable → `AuthService` stays anonymous (it swallows discovery
  failures and never throws on bootstrap).

> **Use `npx ng serve`, not `npm run dev`.** The `dev` script serves on
> `--host=0.0.0.0 --port=3000`, which trips Angular's dev-server host allowlist
> and 400s on `localhost`. `npx ng serve` uses the safe localhost defaults.

> **Demo-header identity is dev-only.** With no verified JWT, privileged writes
> are denied unless the server runs with `AUTH_TRUST_HEADERS=true` — which must
> **never** be enabled on any network reachable by untrusted clients. See
> [`04-security-identity.md`](04-security-identity.md).

---

## 4. Run mode (b): Prod-parity — data + identity in Docker, app on host

Real Postgres + Keycloak in containers, with the SSR app running on your host
against them. This exercises the production persistence and JWT-verification
paths while keeping a fast rebuild loop on the app itself.

### 4.1 Bring up Postgres + Keycloak

```bash
docker compose up -d
```

This uses the existing `docker-compose.yml`:

- **postgres** — PostgreSQL **17**. Hosts the **app** database
  (`project_resource_mgmt`) and a **separate** `keycloak` database (created once
  by `postgres/init/01-create-keycloak-db.sql` on a fresh volume). Published on
  host **5432**.
- **keycloak** — Keycloak **26.1** in **production mode** (`start --optimized`,
  with the Postgres provider pre-baked via `kc.sh build --db=postgres`).
  Imports the **`psa`** realm from `keycloak/realm-export.json` on first start.
  Published on host **8081** (container listens on 8080). Gated on Postgres being
  `service_healthy`.

Verify Keycloak:

- Admin console → **http://localhost:8081** (default `admin` / `admin`).
- Realm `psa` issuer → **http://localhost:8081/realms/psa**.
- Seeded realm users (from `realm-export.json`): **julie** (delivery-executive),
  **john** (finance), **alice** (pm) — passwords equal to the usernames by
  default. Step-by-step realm/client/user setup is in
  [`../functional/keycloak-setup.md`](../functional/keycloak-setup.md).

### 4.2 Build and run the app on the host

```bash
npx ng build

DATABASE_URL=postgres://postgres:postgres@localhost:5432/project_resource_mgmt \
OIDC_ISSUER=http://localhost:8081/realms/psa \
node dist/app/server/server.mjs
```

- The build emits the SSR + Express entry at **`dist/app/server/server.mjs`**
  (project name `app` in `angular.json`; same path `npm run serve:ssr:app` runs)
  and the client bundles at `dist/app/browser/`.
- With `DATABASE_URL` set, `initPersistence()` runs Drizzle migrations + an
  idempotent seed at boot (§7).
- App serves on **http://localhost:3000** (matches the realm client's
  redirect/web-origin URLs).

---

## 5. Run mode (c): Deploy via Docker — the FULL stack (app in a container too)

Here the **app also runs in Docker**, composed with Postgres + Keycloak. Three
files cooperate:

| File | Role |
| --- | --- |
| `Dockerfile` | Multi-stage image for the app (build → slim runtime). |
| `.dockerignore` | Keeps `node_modules`, `dist`, `.git`, `.angular`, docs, etc. out of the build context. |
| `docker-compose.app.yml` | Overlay that adds the `app` service; composes with `docker-compose.yml`. |

### 5.1 The Dockerfile (reviewed; build not run here)

> **Status: provided and reviewed, but `docker build` was NOT run in this
> environment** (the Docker daemon was not available). The merged Compose config
> *was* validated with `docker compose config`. Run a smoke build before relying
> on it: `docker build -t delivery-control-app:latest .`

Multi-stage, two stages:

1. **`build` (`node:22-bookworm`)** — `npm ci` (deps), then `npx ng build`.
2. **`runtime` (`node:22-bookworm-slim`)** — `npm ci --omit=dev` (prod deps
   only), copies `dist/` + `drizzle/` + `drizzle.config.ts`, sets
   `ENV PORT=3000 HOST=0.0.0.0`, `EXPOSE 3000`, runs as the non-root `node` user,
   and `CMD ["node", "dist/app/server/server.mjs"]`.

The entry path `dist/app/server/server.mjs` was verified against `angular.json`
(`projects.app`, `outputMode: server`, `ssr.entry: src/server.ts`) and
`package.json` (`serve:ssr:app`). The `drizzle/` folder is copied because
`initPersistence()` applies those migrations at boot (it points `migrate()` at
`./drizzle` relative to the working directory).

### 5.2 Deploy commands

```bash
# Build the app image and bring up all three services.
docker compose -f docker-compose.yml -f docker-compose.app.yml up -d --build

# Tail logs / check status.
docker compose -f docker-compose.yml -f docker-compose.app.yml ps
docker compose -f docker-compose.yml -f docker-compose.app.yml logs -f app
```

The `app` service:

- **builds** the `Dockerfile`;
- `depends_on` **postgres** (`service_healthy`) and **keycloak**
  (`service_started`);
- env: `DATABASE_URL=postgres://postgres:postgres@postgres:5432/project_resource_mgmt`
  (reaches the `postgres` service by name on the compose network),
  `OIDC_ISSUER=http://localhost:8081/realms/psa`, `OIDC_AUDIENCE` (optional,
  empty by default), **`AUTH_TRUST_HEADERS=false`**, `PORT=3000`, `HOST=0.0.0.0`,
  `NG_ALLOWED_HOSTS=localhost,127.0.0.1`;
- publishes **`3000:3000`**;
- adds `extra_hosts: host.docker.internal:host-gateway` so the container can
  reach the host gateway (see the issuer caveat below).

App → **http://localhost:3000**. Keycloak → **http://localhost:8081**.

### 5.3 The browser-vs-SSR issuer caveat (read this)

There are **two** consumers of Keycloak, and they reach it differently:

- The **browser** authenticates against **`http://localhost:8081/realms/psa`**
  (host port 8081). The tokens it obtains carry
  `iss=http://localhost:8081/realms/psa`.
- The **SSR server** (the `app` container) *also* verifies those tokens — it
  fetches the realm JWKS from `OIDC_ISSUER` and `jwtVerify` requires the issuer
  string to **byte-match** the token's `iss`. So `OIDC_ISSUER` must stay
  `http://localhost:8081/realms/psa`.

Inside a container, `localhost` is the container itself, so the SSR server can't
reach Keycloak via a bare `localhost:8081`. Two facts make the single-host local
deploy work anyway:

1. **Tokens are browser-obtained.** The container-side JWKS fetch is the only
   server→Keycloak call, and `extra_hosts: host.docker.internal:host-gateway`
   plus the host's published 8081 give the container a route to the host
   gateway. On Docker Desktop (macOS/Windows) `localhost` from a container
   already routes to the host gateway for published ports; the `extra_hosts`
   entry makes the same reachability explicit and portable to Linux engines.
2. **Keeping `issuer=localhost:8081` for both sides** keeps the `iss` match
   intact, so the SSR JWKS verification succeeds.

> **For a real multi-host production deploy:** drop the per-container
> `localhost`. Use a **stable external issuer URL** (a DNS name) with **TLS**,
> configured identically in (a) Keycloak `KC_HOSTNAME`, (b) the SPA's issuer
> (`AuthService` `ISSUER` in `src/app/services/auth.service.ts`), and (c)
> `OIDC_ISSUER` on the app. All three must agree or the `iss` byte-match fails.
> Also set `OIDC_AUDIENCE` so tokens minted for another client in the realm
> cannot be replayed against this API.

### 5.4 Full-stack topology

```mermaid
flowchart LR
    Browser["Browser<br/>(SPA + OIDC PKCE)"]

    subgraph host["Docker host"]
      subgraph net["compose network"]
        App["app container<br/>Angular 21 SSR + Express<br/>:3000 (HOST=0.0.0.0)"]
        KC["keycloak container<br/>Keycloak 26.1 (prod)<br/>realm psa · :8080 internal"]
        PG["postgres container<br/>PostgreSQL 17<br/>app db + keycloak db"]
      end
    end

    Browser -- "http :3000 (app UI + /api)" --> App
    Browser -- "http :8081 OIDC login (PKCE)" --> KC
    App -- "DATABASE_URL postgres:5432" --> PG
    App -- "JWKS verify via :8081 issuer<br/>(host.docker.internal gateway)" --> KC
    KC -- "JDBC keycloak db :5432" --> PG

    classDef c fill:#eff6ff,stroke:#2563eb,color:#0f1222;
    class App,KC,PG c;
```

---

## 6. Environment variables reference

From `.env.example`. "Dev" = run mode (a); "Prod/Docker" = run modes (b)/(c).

### App runtime

| Variable | Purpose | Default | Dev | Prod / Docker |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. **Unset → in-memory** repositories. | empty | unset | `postgres://postgres:postgres@postgres:5432/project_resource_mgmt` (compose) / `…@localhost:5432/…` (host) |
| `PGSSL` | `true` for managed Postgres requiring TLS. Local docker Postgres has no TLS. | `false` | `false` | `false` local · `true` managed |
| `PG_CA_CERT` | PEM CA bundle (path) to verify the Postgres TLS cert. Only used when `PGSSL=true`. Verification is **never** disabled. | empty | — | managed only |
| `OIDC_ISSUER` | Keycloak `psa` realm issuer. Must byte-match the token `iss`. | `http://localhost:8081/realms/psa` | (Keycloak optional) | `http://localhost:8081/realms/psa` |
| `OIDC_AUDIENCE` | Expected token `aud` (client id). Set → rejects cross-audience tokens. Empty → audience not checked (issuer+signature still verified). | empty | empty | set in real prod |
| `AUTH_TRUST_HEADERS` | **DEV-ONLY.** `true` trusts the spoofable `X-User-*` demo headers as identity. | `false` | `true` only on a trusted local machine | **`false`** (verified JWTs only) |
| `PORT` | HTTP listen port. SSR self-call base URL tracks this. | `3000` | `3000` | `3000` |
| `HOST` | Bind host. Wildcards (`0.0.0.0`/`::`) are mapped to `localhost` for the SSR self-call. | `localhost` | `localhost` | `0.0.0.0` in Docker |
| `API_BASE_URL` | SSR self-call base for `/api`. **Leave unset** to auto-derive from `PORT`(+`HOST`); set only to point SSR at a different origin. | derived | unset | unset |
| `NG_ALLOWED_HOSTS` | Hostnames Angular SSR host-validation accepts. | `localhost,127.0.0.1` | default | `localhost,127.0.0.1` |
| `TRUST_PROXY` | Number of trusted reverse-proxy hops for real-client-IP rate limiting. `0` = off (no proxy). | `0` | `0` | `1` behind one proxy |

### docker-compose: Postgres

| Variable | Purpose | Default |
| --- | --- | --- |
| `POSTGRES_USER` | App DB superuser. | `postgres` |
| `POSTGRES_PASSWORD` | App DB password. | `postgres` |
| `POSTGRES_DB` | App database name. | `project_resource_mgmt` |
| `POSTGRES_PORT` | Host-published Postgres port (container side stays 5432). | `5432` |

### docker-compose: Keycloak

| Variable | Purpose | Default |
| --- | --- | --- |
| `KC_DB_NAME` | Name of Keycloak's separate DB inside the shared Postgres (matches the init SQL). | `keycloak` |
| `KC_DB_USERNAME` / `KC_DB_PASSWORD` | Credentials Keycloak uses to reach Postgres. | `postgres` / `postgres` |
| `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` | Temporary master-realm admin (admin-console login). | `admin` / `admin` |
| `KC_HOSTNAME` | Externally reachable Keycloak base URL. Must use host **8081**. | `http://localhost:8081` |

### Integrations

`INTEGRATION_*` variables configure the optional ERP / e-invoice / CRM / BI
adapters (see [`05-integrations.md`](05-integrations.md)). They are not required
for the core deploy; leave unset to run without external integration targets.

`GEMINI_API_KEY` / `APP_URL` are AI-Studio scaffolding placeholders and are not
used by the deployed PSA backend.

---

## 7. Database migrations (Drizzle)

- **Schema** lives in `src/db/schema.ts`; **generated SQL migrations** live in
  `./drizzle/` (`drizzle.config.ts` sets `out: './drizzle'`, `dialect:
  postgresql`, reads `DATABASE_URL`).
- **At boot**, `initPersistence()` (`src/db/bootstrap.ts`) — called once from
  `src/server.ts` — does the following **only when `DATABASE_URL` is set**:
  1. `migrate(db, { migrationsFolder: './drizzle' })` — applies any **pending**
     migrations. Idempotent: already-applied migrations are skipped.
  2. **Idempotent seed** — each core table is seeded **only when empty**
     (`count(*) === 0`), parent-before-child so foreign keys are satisfied.
     `auditLogs` is seeded empty (append-only). Repeated boots never duplicate
     rows.
  - When `DATABASE_URL` is **unset**, this is a no-op — the in-memory
    repositories are already seeded from the same arrays.
- **Generating a new migration after a schema change:**

  ```bash
  DATABASE_URL=postgres://postgres:postgres@localhost:5432/project_resource_mgmt \
  npx drizzle-kit generate
  ```

  Commit the generated SQL under `drizzle/`. It is applied automatically on the
  next boot (and is copied into the Docker image, §5.1). `drizzle-kit` reads
  `DATABASE_URL` from the environment at CLI invocation time.

---

## 8. Build / test / lint

| Task | Command | Notes |
| --- | --- | --- |
| Production build | `npx ng build` | emits `dist/app/browser/` + `dist/app/server/server.mjs` |
| Run built SSR server | `npm run serve:ssr:app` | `node dist/app/server/server.mjs` |
| Dev server | `npx ng serve` | localhost defaults (see run mode (a)) |
| Unit tests | `npm test` | `ng test` (Vitest) |
| Lint | `npm run lint` | `ng lint` (angular-eslint) |

---

## 9. Backups & teardown

### Backups

App data and Keycloak's realm/users both live in the **postgres** container,
persisted to the `postgres-data` named volume.

```bash
# Logical dump of the app database.
docker exec prm-postgres pg_dump -U postgres project_resource_mgmt > app-db.sql

# Logical dump of the Keycloak database (realm config + users).
docker exec prm-postgres pg_dump -U postgres keycloak > keycloak-db.sql
```

The `psa` realm definition is also version-controlled in
`keycloak/realm-export.json` (imported on first Keycloak start), so realm
*structure* is reproducible from the repo; `pg_dump` of the `keycloak` db is what
captures *runtime* state (e.g. users created after import).

### Teardown

```bash
# Stop and remove containers; KEEP the data volume.
docker compose -f docker-compose.yml -f docker-compose.app.yml down

# Stop and remove containers AND the data volume (DESTROYS all Postgres data —
# both the app db and Keycloak's realm/users; the init script + realm import
# re-run on the next fresh `up`).
docker compose -f docker-compose.yml -f docker-compose.app.yml down -v
```

> `down -v` is destructive. The Postgres init script and Keycloak realm import
> only run on a **fresh** volume, so after `-v` the next `up` re-creates the
> `keycloak` db and re-imports the realm — any post-import changes are lost
> unless you restored a `pg_dump`.

---

## 10. Security operations notes

- **Bind Postgres/Keycloak to loopback in shared environments.** On a multi-user
  host or anything reachable beyond your machine, publish the data/identity ports
  to `127.0.0.1` only (e.g. `127.0.0.1:5432:5432`, `127.0.0.1:8081:8080`) so they
  are not exposed on the network. Put the app behind a TLS-terminating reverse
  proxy and set `TRUST_PROXY` to the proxy hop count.
- **`AUTH_TRUST_HEADERS=false` in prod — always.** The `X-User-*` demo headers
  are trivially spoofable; header trust must never be enabled on any network
  reachable by untrusted clients (including behind a TLS proxy on a loopback
  bind). The full-stack overlay already sets it to `false`. Identity in prod is
  verified JWTs only. See [`04-security-identity.md`](04-security-identity.md).
- **Never disable TLS verification.** When `PGSSL=true`, the Postgres client
  always verifies the server certificate (`rejectUnauthorized: true`), optionally
  pinning `PG_CA_CERT`. Do not turn this off.
- **Set `OIDC_AUDIENCE`** in real deployments so a token minted for another
  client in the same realm cannot be replayed against this API.
- **Use TLS + a stable external issuer** for any non-localhost deploy (§5.3), and
  set `KC_HOSTNAME` to the externally reachable HTTPS URL.
- **Rotate the demo credentials.** The defaults — Keycloak admin `admin`/`admin`
  and realm users `julie`/`john`/`alice` with passwords equal to their usernames
  — are for local demo only. Change the bootstrap admin password and every demo
  user password (and disable `bruteForceProtected` bypasses) before any shared or
  internet-facing deployment.

Step-by-step Keycloak realm / client / user setup lives in
[`../functional/keycloak-setup.md`](../functional/keycloak-setup.md).
