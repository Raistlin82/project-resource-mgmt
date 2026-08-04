# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Delivery Control** — a Professional Services Automation (PSA) platform: resource
management, project delivery, the commercial chain (customers → contracts → orders),
billing & revenue recognition, approvals/governance, and portfolio reporting. It is
an **Angular 21 SSR** front end and an **Express 5** API running in **one Node
process** (`src/server.ts`), with role-based access and an append-only audit trail.

Extensive docs live in [`docs/`](docs/README.md) — architecture under
`docs/architecture/`, functional SOPs under `docs/functional/`, and the definitive
RBAC reference in `docs/roles-and-permissions.md`. Prefer reading those over
re-deriving; this file is the orientation layer.

## Commands

```bash
npm install               # use install, NOT ci — the lockfile may be ahead
npx ng serve              # dev server on :4200 (in-memory seeded API, no DB/Keycloak)
npm run build             # production build → dist/app/{browser,server}
npm run serve:ssr:app     # run the built SSR+API server (dist/app/server/server.mjs)
npm test                  # unit tests (Vitest via @angular/build:unit-test)
npm run lint              # angular-eslint (TS + HTML templates)
npm run start:dev         # build + run full server on :4000 w/ demo data + auto-login
npm run start:prod        # build + run against Postgres/Keycloak (reads env)
```

- **Use `npx ng serve`, not `npm run dev`.** The `dev` script binds `--host=0.0.0.0`,
  which makes Angular's host check reject `localhost` with a 400. Plain `ng serve`
  binds `localhost`. `ng serve` runs the SSR + `/api` middleware, so the in-memory
  API is live under it.
- **Tests are Vitest** driven by the `@angular/build:unit-test` builder. Specs are
  `*.spec.ts` colocated with source. Server/domain logic has non-Angular specs
  (`src/server/server-logic.spec.ts`, `src/db/repository.spec.ts`, the
  `src/app/services/*.util.spec.ts` suites).
- **Smoke test the API:** start the server with `AUTH_TRUST_HEADERS=true`, then
  `node scripts/smoke-api.mjs` (dependency-free; `SMOKE_BASE` overrides the origin).
- **Full stack (Postgres + Keycloak):** `docker compose up -d postgres keycloak`
  (realm auto-imported), optionally add `-f docker-compose.app.yml` for the app tier.

## The one fact that shapes everything: the dev↔prod parity switch

A single env var, **`DATABASE_URL`**, selects the persistence backend at the
composition root (`src/db/repositories.ts` → `getRepositories()`, memoized):

- **unset** → `InMemoryRepository` adapters seeded from `src/db/seed.ts`. No DB, no
  migrations. This is dev/demo mode and what `ng serve` uses.
- **set** → `PgRepository` adapters (PostgreSQL via Drizzle ORM). `initPersistence()`
  (`src/db/bootstrap.ts`) runs pending migrations from `./drizzle` then seeds each
  table only when empty (`count(*) === 0`), parent-before-child for FK order.

The **same route handlers run over either adapter**, so dev and prod must behave
identically. Two shims in `src/db/repository.ts` enforce that and are load-bearing —
respect them when touching persistence:

- **`nullsToUndefined()`** runs on every *return* path (Drizzle emits `null` for
  nullable columns; the in-memory adapter and the `api.service` interfaces model
  those as optional/absent). **Never** apply it to values handed to `.set()`.
- **Empty-patch parity** — `PgRepository.update()` short-circuits an all-`undefined`
  patch to a plain `get(id)`, because Drizzle's `.set()` throws "No values to set".

Other deliberate seam behaviors: Postgres FK violations (SQLSTATE `23503`) are mapped
to a clean **409** by the API error middleware; id sequences are re-seeded past the
max existing suffix at boot (`seedSequences()`) so restarts never re-issue ids.
`Language` (key `code`) and `FxRate` (key `currency`) have no `id` and flow through
**natural-key adapters** that synthesize `id === key`. Full detail:
`docs/architecture/03-backend-and-data.md`.

## Backend: `src/server.ts` is the real security boundary (~2900 lines)

One Express app is both the SSR handler (`AngularNodeAppEngine`) and the host of the
`/api` router. Wiring order matters: `/api` is matched first, static assets next, a
catch-all does SSR last. Every handler is `async` (the repo boundary is async).

- **`crud()`** mounts the four REST endpoints for simple keyed collections. Collections
  with referential-integrity rules or side effects (`contracts`, `orders`,
  `order-lines`, `billing-plan-items`, `requests`, `assignments`, `time-entries`,
  `milestones`, `change-requests`, `approval-requests`) are **bespoke handlers**.
- **`pick()` allow-list** copies only named fields from the untrusted body — the
  mass-assignment guard. Server-pinned fields (`status` on a new time entry,
  `invoiceNumber`, `createdBy`/`requestedBy` for SoD) can never be client-forged.
- **`roleGate`** = auth + RBAC. It JWKS-verifies any `Authorization: Bearer` token
  against Keycloak, derives the **highest-privilege role** (`ROLE_PRIORITY`), then
  applies per-collection `READ_RULES` and mutation `rules`. A collection with no
  matching rule is open to any verified actor. **The verified JWT role always wins;
  client `X-User-*` headers are trusted only when `AUTH_TRUST_HEADERS=true`** (dev
  only — never inferred from the bind host).
- **Segregation of Duties** is enforced in handlers on top of RBAC: the
  approver/decider must differ from the item's server-pinned owner/requester
  (`resourceId`, `createdBy`, `requestedBy`). High-value items (amount > **50000**)
  route through a two-step `delivery-executive → finance` chain (`buildApprovalSteps`).
- **`withLock(key, fn)`** serializes read-modify-write over shared aggregates
  (request `staffedEffort`, resource `utilization`, invoice sequence, approval steps)
  since Express handlers run concurrently and there's no atomic increment on the repo.
- **Append-only audit middleware** snapshots the entity before PUT/DELETE and, on a
  successful response `finish`, diffs and appends an `AuditEntry` attributed to the
  trusted actor. `GET /audit-logs` is bounded/newest-first (admin, delivery-executive).

The 7 roles, precedence, the full READ/mutation rule tables, and SoD are transcribed
in `docs/roles-and-permissions.md` — that doc is kept in sync with the code and is the
place to look up "who can do what". `/fx-rates` mutations are the one RBAC exception:
enforced inline (admin only; `EUR` fixed at rate 1), not via `roleGate`.

## Frontend: Angular 21, signal-first

Standalone components only (no NgModules), `OnPush`, `signal()`/`computed()`/
`linkedSignal()`, native control flow (`@if`/`@for`/`@switch`), `inject()` in field
initializers. Routes (`src/app/app.routes.ts`) are all lazy `loadComponent`.

- **The `authReady` data pattern (most important frontend rule).** Principal-gated
  `/api` reads must not fire before OIDC bootstrap settles, or they race the token,
  go out without a bearer, 401, and latch the view empty. Components key their
  `rxResource` **params on `auth.authReady()`** and return an empty default until it
  flips `true`. `Reporting` (`src/app/reporting/reporting.ts`) is the reference
  example. **Never snapshot `auth.userId()`/`auth.role()` at field-init** — read them
  reactively (inside `computed`/`rxResource` params/getter), or a deep-link freezes
  the anonymous default.
- **Route guards mirror server RBAC but are UX only.** `commercialGuard` /
  `financeGuard` / `roleGuard(...)` (`src/app/guards/role.guard.ts`) use `CanMatch`
  (so unauthorized chunks never load) and are **SSR-aware**: they allow on the server
  and re-evaluate in the browser after `authReady`. Data is protected by the server
  regardless.
- **Two HTTP interceptors, in order** `[authTokenInterceptor, errorInterceptor]`.
  Auth attaches `Bearer` to same-origin `/api` only (never leaks the token to
  Keycloak). Error stamps demo `X-User-*` on same-origin `/api` only, suppresses
  transient 401 toasts, and rethrows.
- **Design system is bespoke, not Material.** `command-*` classes + CSS tokens in
  `src/styles.css` (Tailwind v4 via `@tailwindcss/postcss`). Material is used **only
  for icons**. The palette splits each accent into a background token and a separate
  `-text` (`-700`) token for WCAG AA contrast — use the `-text` shade wherever an
  accent renders as text. CSV/JSON exports go through `src/app/services/export.util.ts`
  (SSR-safe, formula-injection guarded).
- **SSR base URL** is derived from `PORT`/`HOST` in `app.config.server.ts` (not
  hardcoded `:3000`); leave `API_BASE_URL` unset unless SSR must call a different
  origin. See `docs/architecture/02-frontend.md`.

## Database migrations

Drizzle. Schema in `src/db/schema.ts` (31 tables); SQL migrations in `drizzle/`;
config `drizzle.config.ts`. **`src/db/seed.ts` is the single source of truth for seed
data** — consumed by both the in-memory adapter and the Postgres seeder, so they never
drift. Money columns are `doublePrecision` today (matches the JS `number` runtime);
they should move to `numeric(14,2)` before issuing real invoices (noted in the docs).

## Integrations

Pluggable adapter seam under `src/server/integrations/` (ERP/GL ledger, FatturaPA
e-invoice, CRM outbox, BI feed) behind a registry. See
`docs/architecture/05-integrations.md`.

## Conventions

- Language of the app domain docs and commit messages is English; code is TypeScript
  throughout (strict; the repo boundary never leaks `any` — localized Drizzle casts
  are confined and documented at their call sites).
- Feature planning specs live in `docs/superpowers/specs/`; review/audit artifacts
  (`AUDIT.md`, `BUGHUNT-SECURITY*.md`, `ANGULAR-REVIEW.md`, `COMPETITIVE-ANALYSIS.md`)
  are historical analysis, not authoritative for current behavior — trust the code and
  `docs/`.
