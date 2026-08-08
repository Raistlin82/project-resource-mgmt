# Bug Hunt & Security Report — project-resource-mgmt

> **Historical snapshot (2026-06-07).** Findings and counts describe the codebase
> as it was then; most are long since fixed. The current defect register is
> [`docs/audits/2026-08-05-full-audit.md`](docs/audits/2026-08-05-full-audit.md).

Date: 2026-06-07
Scope: Angular 21 frontend (`src/app`), in-memory mock backend (`src/server.ts`), shared API layer (`src/app/services/api.service.ts`).
Inputs: confirmed bug + security findings, AUDIT.md remediation tasks, Angular pattern-debt tasks.

---

## 1. Executive Summary

The application is a feature-rich Angular 21 (standalone + signals + SSR) resource-management app backed by an in-memory Express mock. Functionally it works for the seeded happy path, but the review surfaced a consistent set of structural problems:

- **Security (mock backend):** every POST/PUT spreads `req.body` directly into the in-memory store with no validation, type-checking, allow-listing, request-size limits, or rate limiting. Three client-side CSV exports are vulnerable to CSV/formula injection. These are the highest-impact items even in a mock, because they encode patterns that would be dangerous in production.
- **Critical correctness / SSR:** browser-only APIs (`confirm()`, `alert()`, `document.*`, `URL.createObjectURL`) are called unguarded in components that render under `@angular/ssr`, risking server-side crashes.
- **Pervasive data-model mismatch:** all 7 project sub-tabs (partners, tasks, issues, documents, financial-plans, cost-centers, plans) seed mock rows under fake project ids `P-1001`/`P-1002`, while real projects use `'1'`/`'2'`/`Date.now()`. Result: every sub-tab is permanently empty for real projects.
- **Pervasive Angular pattern debt:** ~20 components still use `ngOnInit` + unsubscribed `.subscribe()` (memory leaks), `CommonModule`, `[ngClass]`, `alert()`/`confirm()`, and `standalone: true`, contrary to the established conventions already applied in dashboard/projects/manage-skills.
- **Authorization is non-functional:** `currentUserId`/`currentManagerId` are hardcoded to `'1'` across my-assignments, my-profile, utilization, and resource-requests. Acceptable only as documented mock limitation.
- **Honesty gaps:** several dead buttons (no `(click)`), fake-success CSV upload stubs, and hardcoded reporting KPIs present non-real data/behavior as if real.

### Coverage caveats (areas explicitly NOT fully covered)
- **Line numbers are trusted from inputs, not all re-verified.** I directly read and confirmed `project-partners.ts`, `manage-skills.component.ts`, `project-cost-centers.ts`, and the relevant `src/server.ts` seed block. Other files' line references are carried over from the supplied findings and may drift by a few lines.
- **No build/test/lint was run** in this pass; correctness of fixes must be verified by the implementer.
- **No runtime SSR reproduction** was performed; SSR-crash findings are static-analysis based (the APIs are genuinely browser-only, so the risk is real).
- **Backend-dependent items are NOT auto-fixable per file** — they require coordinated `src/server.ts` + `api.service.ts` changes and are listed under Cross-Cutting in the fix plan.

---

## 2. Security Findings (by severity)

### HIGH

**S1 — Unvalidated request body spread into store (Object Injection / Mass Assignment)** — `src/server.ts`
CWE-915 (Improperly Controlled Modification of Object Prototype/Attributes) / CWE-20.
Endpoints spread `req.body` directly (`{ ...existing, ...req.body }`, `id: Date.now().toString(), ...req.body`) at the create/update handlers (approx. lines 154, 163, 170, 188, 212, 293, 300, 313, 324, 331, 344, 351, 362, 369, 382, 389). An attacker can inject arbitrary fields (`restricted: true`, `isDefault`, server-managed `id`, `utilization`) and overwrite invariants.
Remediation: per-endpoint allow-list (explicit pick of permitted fields) or schema validation (Zod/Joi). Never spread raw `req.body`.

**S2 — No numeric type validation on `assignedHours`, `utilization`, `capacity`** — `src/server.ts`
CWE-1287 (Improper Validation of Specified Type of Input). Values flow into arithmetic (utilization recompute at ~lines 194, 218, 264). `{ assignedHours: "NaN" }` / `"Infinity"` poisons calculations.
Remediation: validate `typeof === 'number'`, finite, and non-negative before use; reject with 400.

**S3 — CSV / formula injection in `downloadCsv()`** — `src/app/configuration/manage-skills.component.ts:205-219` (confirmed)
CWE-1236 (Improper Neutralization of Formula Elements in a CSV File). `s.conceptUri`, `s.name`, `s.description` are interpolated unescaped (confirmed line 208). A skill named `=cmd|'/c calc'!A1` executes on open in Excel/Sheets.
Remediation: prefix-escape any field starting with `= + - @ \t \r` with a leading apostrophe; quote fields containing commas/quotes/newlines.

**S4 — CSV injection in `exportToSpreadsheet()`** — `src/app/configuration/service-organization-details.component.ts` (~line 71)
Same class as S3; `o.code`, `o.description`, `o.costCenters` unescaped.

**S5 — CSV injection in `downloadTemplate()`** — `src/app/configuration/maintain-availability-data.component.ts` (~line 90)
Same class as S3; `resource.name`/`resource.id` unescaped.

### MEDIUM

**S6 — No request-size limit / no rate limiting** — `src/server.ts`
CWE-770 (Allocation of Resources Without Limits or Throttling). `express.json()` has no `limit`; no rate-limit middleware. DoS via large payloads.
Remediation: `express.json({ limit: '1mb' })`; add `express-rate-limit` on `/api`.

### LOW

**S7 — Base64 data URIs stored for `profilePicture`/`resume`** — `src/app/my-profile/my-profile.component.ts` (~lines 459, 471)
CWE-79-adjacent. Currently safe because Angular `[src]` sanitizes; risk only if later rendered via `[innerHTML]`/exported. Add a size cap (e.g. 2 MB) and keep binding through `[src]`. Consider CSP.

> Note: A reusable `escapeCsv()` helper shared across S3/S4/S5 is the durable fix. Because the three files are independent, each is patched in place in the fix plan; consider extracting a shared util later (cross-cutting nicety, not required).

---

## 3. Bug Findings (by severity)

### CRITICAL

**B1 — Project id mismatch breaks all 7 sub-tabs** — `project-partners.ts:148-149` (confirmed) and siblings (`project-tasks.ts`, `project-issues.ts`, `project-documents.ts`, `financial-plans.ts`, `project-cost-centers.ts`, `project-plans.ts`).
Mock seeds use `P-1001`/`P-1002`; real projects are `'1'`/`'2'`/`Date.now()` (confirmed in `server.ts:119-128`, requests at `:68-69`). `filteredX()` filters by `projectId`, so real projects show nothing.
Interim frontend fix: stop seeding fake-id rows (start empty). Durable fix: backend sub-resource endpoints keyed on real ids (cross-cutting).

**B2 — `confirm()` under SSR** — `manage-project-roles.component.ts:125`, `manage-proficiency-sets.component.ts:171`, `manage-resource-organizations.component.ts:157`, `manage-skills.component.ts:184` (confirmed).
`confirm()` is undefined on the server; crashes SSR. Replace with a NotificationService-based confirm flow (no native dialog).

### HIGH

**B3 — SSR-unsafe DOM access** — `maintain-availability-data.component.ts:75-100`, `manage-skills.component.ts:191-219` (confirmed: `document.getElementById`, `createElement`, `body.appendChild/removeChild`), `service-organization-details.component.ts:69-82` (+ `URL.createObjectURL`).
Guard all DOM/URL access with `isPlatformBrowser(inject(PLATFORM_ID))`.

**B4 — Unsubscribed observables (memory leaks)** — `project-partners.ts:159` (confirmed), `project-tasks.ts:178`, `project-issues.ts:185`, `project-documents.ts:151`, `project-cost-centers.ts:181`, `project-plans.ts:349`, `projects.ts:230/235/249`, `resource-requests.component.ts:445-447`, plus all configuration components using bare `.subscribe()` in `ngOnInit`.
Replace data loads with `rxResource`; for form-control streams (`valueChanges`) use `takeUntilDestroyed()`.

**B5 — `alert()` instead of NotificationService** — `project-partners.ts:165` (confirmed) and every sub-tab `openForm`/`openX` ("Please select a project first."), plus `manage-skills.component.ts:200` and `maintain-availability-data.component.ts:83` (fake-success upload). Violates convention; not SSR-safe.

**B6 — Reporting shows hardcoded KPIs** — `reporting.ts:154-182`. KPI/chart/table values are static signals disconnected from real data; metrics never reflect system state. Derive via `rxResource`/`computed` from `getProjects`/`getRequests`/`getResources`.

**B7 — `dailyHours()` rounding** — `my-assignments.component.ts:261-263`. `Math.round` base can make the last day negative for some totals. Use `Math.floor` base + remainder and clamp to non-negative.

### MEDIUM

**B8 — No response caching in ApiService** — `api.service.ts:115-118`. Each call fires a fresh request; multiple subscribers duplicate. Mitigated by moving components to `rxResource`; optionally `shareReplay(1)` for GETs (cross-cutting).

**B9 — Initial request invariant violation** — `server.ts:68` (confirmed). Request `'1'` has `requiredEffort=20`, `staffedEffort=20` but `status:'Open'`; server logic (~201-202) would set `'Fulfilled'`. Seed should be `'Fulfilled'`.

**B10 — Utilization float drift, no bounds** — `server.ts:194/264`. `utilization += (hours/capacity)*100` accumulates rounding and can go <0 or >100. Clamp with `Math.max(0, Math.min(100, ...))`.

**B11 — `editHours` not a signal** — `my-assignments.component.ts:241`. Plain property with `[(ngModel)]`; convert to `signal(0)` with `[ngModel]`/`(ngModelChange)`.

**B12 — Staffing race / derived-state-in-writable** — `staffing.component.ts:160-170`. Separate subscribes; `openRequests` stored as writable from a filter. Use `rxResource` (forkJoin) and make `openRequests` a `computed`.

**B13 — Cost-center `NaN%`** — `project-cost-centers.ts:77` (confirmed: `usage = (cc.actual / cc.allocated) * 100`). Guard `allocated > 0 ? ... : 0`.

**B14 — Form/model naming mismatch** — `project-cost-centers.ts` (`allocatedBudget` control → `allocated` property). Cosmetic; standardize.

**B15 — Dead controls** — Filter/New-Request (dashboard), calendar arrows (my-assignments), Export/date-range/more_vert/Filter/Search/View-report (reporting), per-row edit/more_vert across sub-tabs. Wire or remove; no handler-less buttons.

**B16 — manage-cost-centers hardcoded data + weak ids + dead search** — `manage-cost-centers.component.ts:156-161`/`202`/`35-36`. Not API-integrated; `Math.random()` ids; unbound search. Bind search now; backend integration is cross-cutting.

**B17 — `getAssignedHoursForMonth` dead code** — `my-profile.component.ts:372` `+ (monthIndex * 0)`. Remove the no-op.

### LOW

**B18 — Hardcoded `currentUserId`/`currentManagerId = '1'`** — `my-assignments.component.ts:224`, `my-profile.component.ts:354`, `utilization.component.ts:181`, `resource-requests.component.ts:379`. No auth; all users see resource/manager 1. Add explicit mock-limitation comments until an AuthService exists (cross-cutting).

**B19 — Race in `project()` computed** — `project-details.ts:141-142`. Use `@if (project() as p)` guard.

**B20 — Hardcoded author/assignee mock values** — `project-documents.ts` (`'Current User'`/`'CU'`), `project-tasks.ts` (`'Unassigned'`). Cosmetic until auth.

---

## 4. AUDIT.md Remediation Status

| Area | Status | Notes |
|---|---|---|
| Dashboard dead buttons (Filter / New Request) | OPEN | Frontend-only: wire New Request → `/requests`; honest no-op or removal for Filter. |
| my-assignments calendar arrows + illustrative grids | OPEN | Frontend-only: add `periodOffset` signal; label weekly/monthly views as estimated. |
| reporting dead controls + hardcoded data + export | OPEN | Frontend-only: derive KPIs from real endpoints; implement CSV export; wire/remove controls. |
| manage-skills upload stub | OPEN | Frontend-only interim: honest NotificationService message; real import is backend-dependent. |
| maintain-availability upload stub | OPEN | Frontend-only interim: honest message; remove `standalone:true`. |
| 7 project sub-tabs: project-id mismatch | OPEN | Interim frontend: drop fake-id seeds. Durable: backend endpoints (cross-cutting). |
| sub-tab dead actions (edit/more_vert/status/delete) | OPEN | Frontend-only: implement on signal or remove. |
| project-documents file input honesty | OPEN | Frontend-only: real file input or honest metadata-only label. |
| manage-cost-centers dead search | OPEN | Frontend-only: bind search + computed filter. |
| ApiService sub-resource + cost-center methods | OPEN | Backend-dependent (cross-cutting). |
| server.ts sub-resource + cost-center endpoints + seeds | OPEN | Backend-dependent (cross-cutting). |

Backend-dependent tasks remain blocked until the matching `server.ts` + `api.service.ts` endpoints exist; the frontend interim fixes (drop fake seeds, honest messages, NotificationService) are independently shippable now.

---

## 5. Angular Pattern Debt

Recurring across configuration + project + feature components:

- **`ngOnInit` + bare `.subscribe()` → `rxResource({ stream, defaultValue })`** with `res.reload()` after mutations; remove `OnInit` import/implements. (maintain-availability, manage-proficiency-sets, manage-project-roles, manage-resource-organizations, manage-skill-catalogs, service-organization-details, set-default-language, my-profile, financial-plans, project-cost-centers, project-documents, project-issues, project-partners, project-plans, project-tasks, resource-requests, staffing, utilization.)
- **Remove `CommonModule`**; import only specific pipes actually used (`DatePipe`, `DecimalPipe`, `CurrencyPipe`).
- **Remove `standalone: true`** (it's the default) where present.
- **Replace `[ngClass]`/`[ngStyle]`** with `[class.x]`/`[class]`/`[style.x]` (my-profile, reporting, project-issues, utilization).
- **Replace `alert()`/`confirm()`** with NotificationService (and SSR-safe confirm flow).
- **No derived state in writable signals** — use `computed()` (staffing `openRequests`).

These are individually small but pervasive; the fix plan groups them per file so each file becomes convention-compliant in one pass.

---

## 6. Silent Caps / Not Covered
- Line numbers from supplied findings were not all re-verified (verified: project-partners, manage-skills, project-cost-centers, server.ts seeds).
- No compile/lint/test/SSR run performed.
- Auth is mock-only; authorization findings are documented, not fixed.
- Backend + ApiService changes are out of per-file scope and listed as cross-cutting.
