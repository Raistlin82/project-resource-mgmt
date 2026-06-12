# Plan — Reference-data integrity: bind every FK/config field, no free text

**Date:** 2026-06-12 · **Status:** approved (decisions below) · **Goal:** every create/edit field that is a foreign key to an entity or to configured master data must be a SELECT bound to the live data — never free text. Enforced in the UI AND validated server-side. New customizing catalogs created where missing.

## Decisions (user)
- **Rates → Rate Card customizing** keyed by **project role + currency (+ optional organization)**, with **per-resource override**. Resource effective cost/bill rate = override ?? rateCard(role, org, currency).
- **Maximum control**: create customizing catalogs even for the currently-uncatalogued reference fields — **Locations**, **Cost Categories**, **Partner Roles**, **Vendors** (partner companies). Truly-open prose (names, descriptions, comments) stays free.
- Role storage value = catalog **name** (backward-compatible with existing match-scoring on string roles); `project-roles` is the single canonical role catalog, expanded to cover live values.

## Reference sources (existing)
project-roles, skills, skill-catalogs, proficiency-sets, cost-centers, resource-organizations, service-organizations, languages, fx-rates (currencies); core entities customers/contracts/projects/resources/users/partners/requests/milestones/orders. New: rate-cards, locations, cost-categories, partner-roles, vendors.

## UI pattern
Native `<select class="command-select">` + option list from a signal (rxResource/forkJoin), the existing idiom (billing/manage-skills). Required FKs: disabled placeholder + Validators.required. **Orphan-value handling:** on edit, if the stored value isn't in the option list, inject it as a disabled "… (not in catalog)" option so editing never silently wipes a real value. Multi-select for array FKs (projectRoles, skills, catalogs, costCenters).

## Server pattern
Extend the generic `crud()` helper with an optional `fks: {field, repo|domain, required?}[]` spec; validate via existing `existsRepo` (entity FKs) or membership (config-value FKs: role names, currencies, skill names). Add to bespoke handlers too (resources, requests, projects, milestones, change-requests, billing-plan-items, contracts/orders currency).

## Phases (each: build + live verify + PR + merge)
- **A — Roles**: expand project-roles seed to cover live values; bind `Resource.role` (resources form), `Resource.projectRoles[]` (my-profile, multi), `ResourceRequest.requiredRole` (requests) → project-roles; server-validate role/requiredRole/projectRoles against the catalog.
- **B — Currency**: bind the 4 commercial `currency` fields (contracts, orders, billing, contract-details) → fx-rates currencies; fix contract-details recurrence option set; server-validate currency on contracts/orders/billing.
- **C — Skills**: bind `request.skills` (multi) + my-profile skill name → /skills; server-validate.
- **D — People**: bind assignee/owner/reportedBy/manager/cost-center-manager/project-owner → resources; document author/owner → auth user; reconcile seed people stored as names → resource ids; server-validate person FKs.
- **E — Rate Cards (new config)** ✅ DELIVERED (PR #19): rate-cards entity + table (migration 0005) + seed (8 generic + 1 org-specific) + CRUD + `config/rate-cards` screen + nav (admin/delivery-executive/finance); resource effective rates derive from the card by role(+org), override allowed.
  - **Decision (user, 2026-06-12): LIVE default, not snapshot.** Editing a card updates every resource that hasn't overridden — chosen for coherence.
  - **Implementation:** the resource's `cost_rate`/`bill_rate` COLUMN holds the per-resource OVERRIDE (nullable; null = inherit). Effective rate = `override ?? pickRateCard(role, org)` resolved **on read** (`resolveResourceRates` in server.ts) — so `finance.util`, `billing`, `match.util`, and the GL/e-invoice accrual keep reading `costRate`/`billRate` (now effective) UNCHANGED. The form writes `costRateOverride`/`billRateOverride`; reads expose both effective + override. Migration is behavior-neutral (existing rates become overrides → effective == prior value). Org-specific card wins over generic; currency = base (EUR). Verified live: inherit, org-override, partial per-field override, and live propagation (edit card → inheriting resource's effective rate changes).
  - **Follow-up — HYBRID day-rate model (user, 2026-06-12; PR #22):** rate cards + the per-resource override are expressed in **€/giorno** (how PSA work is quoted); `withEffectiveRates` divides by a configurable **hours-per-day** setting (`settings.hoursPerDay`, default 8, migration 0006) to produce the **€/ora** `costRate`/`billRate` the margin math consumes. Timesheets/assignments/capacity stay in HOURS. Resources expose `costRateDay`/`billRateDay` (effective €/day) + `costRateOverride`/`billRateOverride` (€/day) alongside the hourly effective rates. Seed values ×8 so effective hourly — and every margin — is unchanged. Hours/day is editable on the Rate Cards screen (gated to finance roles); changing it rescales all effective rates. Verified live: hourly == pre-hybrid (75/140, 90/180, 65/120), hpd change rescales, validation (0/30 → 400), RBAC (pm → 403).
- **F — New catalogs + remaining binds**: Locations, Cost Categories, Partner Roles, Vendors (entities + screens + nav, gated) and bind `Resource.location`→locations, `financial-plans.category`→cost-categories, `project-partners.role`→partner-roles, `project-partners.company`→vendors, `project-cost-centers.id`→cost-centers, `resource-organizations.costCenters[]`→cost-centers, add the missing `serviceOrganizationId` select, `Resource.organization`→resource-organizations; server-validate all.

## Final field decisions (2026-06-12, user-confirmed)
- **Industries**: new customizing catalog, pre-seeded with the standard industry list → `Customer.industry`.
- **Locations = Country + City**: new `countries` catalog + new `cities` catalog (city belongs to a country), cities pre-seeded with the principal Italian cities/comuni and extendable in customizing. `Resource.location` & `Project.location` → City (with its Country); `Customer.country` → Country. (Full ISTAT comuni list can be imported later; seed a representative set now.)
- **skills[].level**: bound to the proficiency-set levels (not a free number).
- **ProjectPartner.contact**: stays FREE (external person name, not an internal FK).
- **Dates**: every date input across the app uses a native calendar date-picker (`<input type="date">`); convert any free-text date field. (Phase G — cross-cutting sweep.)
- New catalogs total: rate-cards, industries, countries, cities, cost-categories, partner-roles, vendors.

## Phase G — Date pickers ✅ DELIVERED (PR #21)
Sweep all create/edit forms; ensure every date field is an `<input type="date">` (calendar popup), never free text. Validate ISO + sensible ranges server-side where missing.
- **UI**: audit found ALL 14 forms already use `<input type="date">` (hire/termination, project & contract start/end, request start/end, milestone date, task/issue due date, order date, billing expected/issued/due/paid, time-entry date, my-profile experience dates). Zero free-text date inputs — nothing to convert.
- **Server (added)**: reusable `validateDateFields(body, fields, order?)` (ISO via `Date.parse`; optional `to >= from`) wired into every date-bearing write handler — requests, projects, milestones, work-packages, project-tasks, project-issues, contracts, orders, billing-plan-items. Each rejects a malformed date (400) and an inverted range; valid ISO + omitted/'' pass. Verified live across all handlers.

## Out of scope / later
Migrating role storage from name→code (coordinated migration); locations/vendors as full master records (start as simple {id,name} catalogs).
