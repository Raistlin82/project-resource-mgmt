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
- **E — Rate Cards (new config)**: rate-cards entity + table + seed + CRUD + `config/rate-cards` screen + nav (admin/finance/delivery-executive); wire resource effective rates (derive from card by role+org+currency, override allowed) through finance.util; resource form shows derived vs override.
- **F — New catalogs + remaining binds**: Locations, Cost Categories, Partner Roles, Vendors (entities + screens + nav, gated) and bind `Resource.location`→locations, `financial-plans.category`→cost-categories, `project-partners.role`→partner-roles, `project-partners.company`→vendors, `project-cost-centers.id`→cost-centers, `resource-organizations.costCenters[]`→cost-centers, add the missing `serviceOrganizationId` select, `Resource.organization`→resource-organizations; server-validate all.

## Out of scope / later
Migrating role storage from name→code (coordinated migration); locations/vendors as full master records (start as simple {id,name} catalogs).
