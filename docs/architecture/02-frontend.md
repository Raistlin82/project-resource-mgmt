# Frontend Architecture — Angular 21 SSR SPA

> **Diátaxis mode:** Explanation + Reference. This page explains *how* the
> Delivery Control frontend is built and *why* it is built that way, and gives
> you look-up tables for routes, guards, and interceptors.

**Delivery Control** is the PSA ("Professional Services Automation") web client:
an **Angular 21** single-page application, **server-side rendered (SSR)** by the
same Express process that serves the API (`src/server.ts`). Identity is
**Keycloak OIDC** (Authorization Code Flow + PKCE); data flows through a
repository-backed `/api`.

Related pages:

- [`01-overview.md`](01-overview.md) — system context and the four layers
- [`03-backend-and-data.md`](03-backend-and-data.md) — the Express API + repositories the frontend calls
- [`04-security-identity.md`](04-security-identity.md) — Keycloak, JWT verification, RBAC
- [`06-deployment-operations.md`](06-deployment-operations.md) — how to run/build/deploy this app
- [`../roles-and-permissions.md`](../roles-and-permissions.md) — the role/capability matrix the guards enforce
- [`../functional/keycloak-setup.md`](../functional/keycloak-setup.md) — realm, client, users

---

## 1. Modern Angular conventions

The app is built entirely on Angular 21's standalone, signal-first idioms — no
NgModules, no zone-based change detection where signals suffice.

| Convention | How it shows up here |
| --- | --- |
| **Standalone components** | Every component is standalone; there is no `AppModule`. Bootstrap is `bootstrapApplication(App, config)` (`src/main.server.ts` for SSR; the browser entry is `src/main.ts`). |
| **`ChangeDetectionStrategy.OnPush`** | Declared on components like `App` (`src/app/app.ts`) and `Reporting` (`src/app/reporting/reporting.ts`). With signal reads in the template, OnPush + signals give fine-grained, pull-based updates. |
| **`signal()` / `computed()`** | UI state is signals: e.g. `App.isMobileMenuOpen`, `App.navFilter`, `Reporting.period`. Derived values are `computed()` — `App.navGroups`, `App.filteredGroups`, the whole `Reporting` KPI/finance layer. |
| **`linkedSignal()`** | Available and used for derived-but-resettable state (a writable signal that recomputes from a source). Prefer it over an `effect()` that copies one signal into another. |
| **`rxResource()`** | The bridge from RxJS HTTP streams to signals for async data loads — see §3. Used in `App` (nav badges) and `Reporting` (the full dataset + FX rates). |
| **Native control flow** | Templates use `@if` / `@for` / `@empty` / `@switch`, not the legacy `*ngIf` / `*ngFor`. See the `App` sidebar and every table in `Reporting`. |
| **`inject()`** | Dependencies are pulled with `inject(...)` in field initializers (e.g. `private auth = inject(AuthService)`), not constructor parameters. |
| **`@angular/material` icons** | `MatIconModule` is imported per-component for Material icons; the rest of the UI is the bespoke `command-*` design system (§6), not Material components. |

---

## 2. Application configuration & SSR wiring

### Browser config — `src/app/app.config.ts`

```
provideRouter(routes, withComponentInputBinding())
provideHttpClient(withFetch(), withInterceptors([authTokenInterceptor, errorInterceptor]))
provideClientHydration(withEventReplay(), withHttpTransferCacheOptions({ includePostRequests: false }))
provideOAuthClient()
{ provide: API_BASE_URL, useValue: '/api' }
```

- **`withComponentInputBinding()`** binds route params straight into component
  `@Input()`s (e.g. `:id` on `/projects/:id`).
- **`withFetch()`** uses the Fetch backend (SSR-friendly) and runs both
  interceptors (§5) in the listed order.
- **`provideClientHydration(withEventReplay(), ...)`** enables non-destructive
  hydration with event replay, and the transfer cache is configured to **not**
  cache POST responses.
- **`API_BASE_URL = '/api'`** — in the browser the API is same-origin.

### Server config — `src/app/app.config.server.ts`

Merges `appConfig` with `provideServerRendering(withRoutes(serverRoutes))` and
**overrides `API_BASE_URL`** to an absolute URL the SSR process can call back
into itself with.

#### SSR base-URL derivation (why it isn't hardcoded `:3000`)

During SSR the Angular app runs *inside the same Node process* that serves
`/api/*`. A relative `/api` has no origin server-side, so `API_BASE_URL` must be
an absolute URL pointing at **this** server. The server binds to
`process.env['PORT'] || 3000` and `process.env['HOST'] || 'localhost'`, so the
SSR base URL is derived from the same env:

```ts
const serverPort = process.env['PORT'] || '3000';
const serverHost = fetchableHost((process.env['HOST'] || 'localhost').trim());
const serverApiBaseUrl = process.env['API_BASE_URL'] ?? `http://${serverHost}:${serverPort}/api`;
```

Resolution order: explicit `API_BASE_URL` wins (the external-API override); else
it is derived from `PORT` (+ `HOST`). `fetchableHost()` handles the wildcard /
IPv6 edge cases that would otherwise make SSR fetch the wrong origin:

- A hardcoded `:3000` breaks whenever `PORT` differs (e.g. `PORT=4500`): the SSR
  fetch hits the wrong origin, fails, and a deep-link like `/projects/1` renders
  its empty/"not found" shell **even though the HTTP status is 200**.
- Wildcard binds (`0.0.0.0`, `::`, empty) are **not** usable as fetch targets, so
  they are mapped to `localhost`; bare IPv6 literals are bracketed (`[::1]`).
- The host defaults to `localhost` (not `127.0.0.1`) to match what Express
  actually binds the listener to — a 127.0.0.1 fetch can be refused even though
  both are loopback.

> **Deploy implication:** when you run the app in Docker with `HOST=0.0.0.0`
> (see [`06-deployment-operations.md`](06-deployment-operations.md)), leave
> `API_BASE_URL` **unset** so it auto-derives — `fetchableHost` turns the
> wildcard bind into a `localhost` self-call. Only set `API_BASE_URL` to point
> SSR at a genuinely different origin.

---

## 3. The auth-readiness data pattern (`rxResource` keyed on `authReady()`)

This is the single most important frontend pattern. Principal-gated `/api` reads
(everything that 401s for an anonymous caller) must **not** fire until the OIDC
bootstrap has settled and the bearer token is available; otherwise they race the
token, go out without an `Authorization` header, 401, and latch the view to its
empty default until a manual reload.

### The mechanism

`AuthService` (`src/app/services/auth.service.ts`) exposes a monotonic
`authReady` signal. It flips `false → true` exactly once, in the `.finally()` of
`loadDiscoveryDocumentAndTryLogin()` — i.e. after any post-redirect token is
restored into storage and claims are synced (or after Keycloak is confirmed
unreachable and the app stays anonymous). OAuth bootstrap runs in
`afterNextRender(() => this.init())`, so it never runs on the server and never
re-enters mid-construction.

Components key their `rxResource` **params** on `auth.authReady()` and return the
empty default until it is `true`:

```ts
// src/app/reporting/reporting.ts
private dataRes = rxResource<ReportingData, boolean>({
  params: () => this.auth.authReady(),
  stream: ({ params: ready }) =>
    ready
      ? forkJoin({ resources: this.api.getResources(), /* …13 gated collections… */ })
      : of<ReportingData>({ /* empty default */ }),
  defaultValue: { /* empty default */ },
});
```

Because `params` is a signal read, `authReady` flipping to `true` **re-runs the
stream** with the token now attached. The same pattern drives the sidebar badges
in `App` (`navRes`, keyed on `this.auth.authReady()`) and the FX-rate load in
`Reporting` (`fxRes`).

### Sequence (the post-login token race this prevents)

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as AuthService
    participant KC as Keycloak
    participant R as rxResource (params: authReady)
    participant API as /api (SSR Express)

    Note over B,R: Page load / hard refresh of a gated view
    B->>A: afterNextRender → init()
    A->>R: authReady() = false
    R-->>R: stream returns empty default (no request fired)
    A->>KC: loadDiscoveryDocumentAndTryLogin()
    KC-->>A: token restored / confirmed absent
    A->>A: syncClaims(); _authReady.set(true)
    A-->>R: authReady() = true  (params changed)
    R->>API: GET /api/... (Authorization: Bearer <token> attached)
    API-->>R: 200 + data
    R-->>B: signal value updates → OnPush re-render
```

> **Why it matters:** without keying on `authReady`, the resource fires while
> `authReady` is still `false`, the request races the OAuth bootstrap, leaves
> without a bearer token, 401s, and (for a fail-fast `forkJoin`) latches the
> *entire* report to empty until reload.

### Access feedback

A silent page of zeros is misleading, so `Reporting.accessNotice` watches the
resource status: on error it distinguishes **"sign in"** (anonymous) from
**"your role does not have access"** (authenticated but under-privileged) — it
never pretends the portfolio is empty. This pairs with the interceptor's 401
suppression (§5): transient 401s aren't toasted, so the notice is the
user-facing signal.

> **Anti-pattern to avoid:** never snapshot `auth.userId()` / `auth.role()` at
> field-init. Until `authReady` flips they return the anonymous defaults; a
> captured value freezes the wrong identity for the component's life (loading
> another user's data on a deep-link/reload). Always read them *reactively*
> (inside a `computed` / `rxResource` params / getter).

---

## 4. Routing

Routes are defined in `src/app/app.routes.ts`. Every feature is **lazily loaded**
via `loadComponent: () => import(...).then(m => m.X)`, so each route ships its own
chunk and unauthorized chunks never download (see guards below).

### Route guards — `CanMatch`

Two functional `CanMatchFn` guards live in `src/app/guards/role.guard.ts`, built
from a shared `roleGuard(check, redirect)` factory. `CanMatch` (not
`CanActivate`) is used deliberately: when the predicate fails the route does not
match and **the lazy chunk is never even loaded**, redirecting to `/`.

| Guard | Predicate | Mirrors |
| --- | --- | --- |
| `commercialGuard` | `auth.canManageCommercial()` | server `/customers /contracts /orders /order-lines /billing-plan-items` RBAC |
| `financeGuard` | `auth.canApproveFinancials()` | server `/integrations` + financial-collection RBAC |

**SSR-aware:** identity is unknowable on the server (claims only populate
client-side via `afterNextRender`), so a server-side capability check would
always fail and surface as an HTTP 302 — breaking refresh / deep-link / bookmark
of guarded routes for everyone. The guard therefore **allows the match on the
server** (`isPlatformBrowser(...) === false → return true`) and re-runs
authoritatively in the browser after hydration. Data stays protected regardless
because the server JWKS-verifies the bearer on every `/api` call.

**Hydration timing:** in the browser the guard returns an `Observable` that
**waits for `authReady`** before evaluating the predicate
(`toObservable(auth.authReady).pipe(filter(ready => ready), take(1), map(...))`),
so it sees the real post-login role, not the anonymous default.

### Guarded-route table

| Path | Guard(s) | Component (lazy) |
| --- | --- | --- |
| `/customers` | `commercialGuard` | `Customers` |
| `/contracts`, `/contracts/:id` | `commercialGuard` | `Contracts`, `ContractDetails` |
| `/orders` | `commercialGuard` | `Orders` |
| `/billing` | `commercialGuard` **and** `financeGuard` | `Billing` |
| `/config/integrations` | `financeGuard` | `IntegrationsComponent` |

All other routes (Resource Control, Project Control, Analytics, the rest of
Configuration, `/projects/:id`, …) are ungated at the route level — the server
still enforces read/write RBAC on their data. The trailing `{ path: '**' }`
loads `NotFoundComponent`.

The sidebar nav (`App.navGroups`) mirrors these guards at render time: the
**Commercial** group is filtered by `canManageCommercial()` (and `/billing`
additionally by `canApproveFinancials()`), and **Integrations** by
`canApproveFinancials()` — so links never appear as dead ends for unauthorized
users. An emptied group is dropped entirely.

### Server routes & render mode — `src/app/app.routes.server.ts`

```ts
export const serverRoutes: ServerRoute[] = [
  { path: '**', renderMode: RenderMode.Server },
];
```

A single catch-all with **`RenderMode.Server`**: every route is rendered on
demand per request (dynamic SSR), not prerendered. This is correct for an app
whose pages depend on per-request identity and live data — there is no static
HTML to precompute. (`outputMode` is `server` in `angular.json`, producing the
`dist/app/server/server.mjs` entry.)

---

## 5. HTTP interceptors

Two functional interceptors run, **in this order**:
`[authTokenInterceptor, errorInterceptor]` (`app.config.ts`). Order matters — the
auth-token interceptor attaches the bearer first; the error interceptor then
stamps demo headers and handles failures around the resulting request.

### `authTokenInterceptor` — `src/app/interceptors/auth-token.interceptor.ts`

Attaches `Authorization: Bearer <token>` from `OAuthService.getAccessToken()`.

- **Browser-only:** on SSR (`!isPlatformBrowser`) it is a no-op — the server is
  anonymous and has no token.
- **Same-origin `/api` only:** `isSameOriginApiRequest()` matches relative
  `/api/...` and absolute same-origin `/api` URLs. The token is **never** sent to
  third-party hosts (notably never to Keycloak's own endpoints).
- No token (anonymous / Keycloak unreachable) → passes through unchanged.

### `errorInterceptor` — `src/app/interceptors/error.interceptor.ts`

Surfaces failures as toasts (`NotificationService`) and rethrows so
callers/resources still observe the error. It does three subtle things:

1. **401 suppression on own `/api`.** A 401 on a same-origin `/api` request is
   **not** toasted (still rethrown). During OIDC bootstrap and for anonymous
   users these GETs transiently 401 as auth state settles — they are auth-state
   transitions, not user-actionable errors (and `rxResource`s already fall back
   to empty defaults). Other 4xx, any 5xx, and any non-`/api` failure are toasted
   normally.

2. **`X-User-*` stamping — scoped to own `/api`.** It clones the request to add
   `X-User-Id: auth.userId()` and `X-User-Role: auth.role()`, but **only** on
   same-origin `/api` calls. These are the demo-identity headers (trusted by the
   server **only** when `AUTH_TRUST_HEADERS=true`; see
   [`04-security-identity.md`](04-security-identity.md)). They are real identity
   in dev and harmless in prod (the server ignores them when header trust is
   off — verified JWTs win).

3. **CORS rationale.** The header stamping is scoped to own `/api` precisely so
   cross-origin requests — the Keycloak OIDC discovery/token endpoints on
   :8081 — do **not** carry `X-User-*`. Custom headers would trigger a CORS
   preflight that Keycloak rejects, breaking login. Scoping the `AuthService`
   injection to `/api` also avoids an `AuthService` ↔ interceptor bootstrap cycle
   (the discovery request, fired while `AuthService` initializes, no longer
   re-enters `AuthService` in the interceptor).

| | `authTokenInterceptor` | `errorInterceptor` |
| --- | --- | --- |
| Runs on SSR? | No (browser-only) | Yes (header logic falls back; no `window`) |
| Touches own `/api`? | Adds `Authorization: Bearer` | Adds `X-User-*`; suppresses 401 toasts |
| Touches Keycloak / 3rd-party? | No (never leaks token) | No (never leaks `X-User-*`) |

---

## 6. Design system & accessibility

The UI is a bespoke design system, **not** Angular Material components (Material
is used only for icons). It lives in `src/styles.css` (Tailwind v4 via
`@tailwindcss/postcss`) as a set of `command-*` classes and CSS custom
properties.

### `command-*` classes & tokens

- **Component classes:** `command-shell`, `command-sidebar`, `command-nav-link`,
  `command-nav-group-header/body`, `command-nav-badge`, `command-card`,
  `command-kpi` / `command-kpi-label` / `command-kpi-value`, `command-button`
  (`.secondary`), `command-status`, `command-data-table`, `command-header` /
  `command-title` / `command-subtitle` / `command-eyebrow`,
  `command-section-label`.
- **Design tokens** (`:root`): `--cc-bg`, `--cc-surface`, `--cc-panel`,
  `--cc-ink`, `--cc-muted`, `--cc-line`, `--cc-primary`, `--cc-primary-strong`,
  plus a fluid type scale, spacing rhythm, motion easings, and shadow tokens.

### WCAG AA token split (the load-bearing part)

The palette deliberately **splits each accent into a background token and a
separate text token**, because the vivid background colors fail AA contrast for
*normal text* on white:

| Use as **background / border** | Use as **readable text on white** | Why |
| --- | --- | --- |
| `--cc-primary` `#2563eb` (~4.0:1) | `--cc-primary-text` `#1d4ed8` (~5.9:1) | `#2563eb` fails AA for normal text |
| `--cc-green` `#059669` (~3.8:1) | `--cc-green-text` `#047857` (~5.5:1) | financial figures must be readable |
| `--cc-amber` `#d97706` (~3.2:1) | `--cc-amber-text` `#b45309` (~5.0:1) | amber fails worst as text |

The rule (documented inline in `styles.css`): keep the `--cc-primary` /
`--cc-green` / `--cc-amber` shades for solid button/bar **backgrounds and
borders** only; use the `-text` (`-700`) shades wherever the accent renders as
**text**.

Other accessibility affordances baked in:

- **Focus visibility:** a global `:focus-visible` outline (2px blue, 2px offset),
  reinforced on links, buttons, inputs, and `command-*` interactive elements.
- **Reduced motion:** animations are gated behind
  `@media (prefers-reduced-motion: no-preference)` and explicitly neutralized
  under `@media (prefers-reduced-motion: reduce)`.
- **Live regions for toasts:** the `App` template splits toasts into **two**
  regions — errors in `role="alert"` / `aria-live="assertive"` (interrupt), and
  success/info in `role="status"` / `aria-live="polite"` — so severity maps to
  the right screen-reader politeness.
- **Inert collapsed nav:** collapsed nav groups get `[inert]` so they are removed
  from the tab order; `aria-expanded` / `aria-controls` / `aria-current` are
  wired on the nav.

### SSR-safe blob downloads

CSV/JSON exports (the "Export" buttons across `Reporting`) go through
`src/app/services/export.util.ts`. The download primitives are **SSR-safe**:
`canDownload()` checks `document`, `Blob`, `URL`, and `URL.createObjectURL`
exist, so `downloadCsv` / `downloadJson` **no-op outside the browser** (SSR /
non-browser) instead of throwing. The Blob URL is revoked in a `finally` after
the synthetic anchor click. The CSV builder additionally applies a
**formula-injection guard** (a leading `= + - @ TAB CR` in a string cell is
prefixed with `'`) and RFC-4180 quoting — relevant because these exports carry
financial data into spreadsheet apps.

---

## 7. Component map (orientation)

| Area | Routes (see §4) | Notes |
| --- | --- | --- |
| **Shell** | `App` (`app.ts`) | sidebar nav, capability-filtered groups, live nav badges (`rxResource` on `authReady`), auth footer (sign in/out) |
| **Resource Control** | `/`, `/profile`, `/assignments`, `/requests`, `/staffing`, `/approvals`, `/utilization` | staffing, utilization, approvals |
| **Project Control** | `/projects`, `/projects/:id`, `/project-plans`, `/project-tasks`, `/project-issues`, `/change-requests`, `/project-documents`, `/project-partners`, `/financial-plans`, `/project-cost-centers` | project execution |
| **Commercial** *(gated)* | `/customers`, `/contracts`, `/contracts/:id`, `/orders`, `/billing` | `commercialGuard` (+ `financeGuard` for billing) |
| **Analytics** | `/forecast`, `/what-if`, `/utilization`, `/reporting`, `/bench` | `Reporting` is the reference example of the `authReady` data pattern; `/bench` (Block F) shares `capacityGuard` with `/capacity` (see [`../roles-and-permissions.md`](../roles-and-permissions.md#route-access-client-guards)) |
| **Configuration** | `/config/*` | catalogs, roles, orgs; `/config/integrations` gated on `financeGuard` |

For what each of these *does* functionally, see the [`../functional/`](../functional) area docs.

`/forecast`'s and `/what-if`'s bench panel ("available for reallocation") calls
`bench.util.ts`'s pure `benchRollup`/`notFullyAllocatedAt` directly, client-side,
over the raw `GET /assignment-days`/`GET /assignment-months` reads (shared with
block E) — **not** the retired `benchList()`/`BenchEntry` (`forecast.util.ts`),
which classified on the whole-of-lifetime `Resource.utilization` scalar rather
than a specific month. `/bench` and `/utilization`'s bench badge instead call the
server-aggregated `GET /bench/monthly` (`ApiService.getBenchMonthly()`) — the
client-only What-If sandbox is the one consumer that cannot round-trip through
the server, so it is the only one composing `bench.util.ts` itself rather than
reading its server-side rollup.
