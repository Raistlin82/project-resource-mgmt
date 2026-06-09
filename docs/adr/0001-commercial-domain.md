# ADR-0001: Commercial domain (Customers, Contracts, Orders) + 360° financial analytics

**Status:** Accepted
**Date:** 2026-06-07
**Deciders:** Product owner (gabriele), implementation (Claude)

## Context

The app today has four top-level areas: **Resource Management**, **Project Management**, **Analytics & Reporting**, **Configuration**. The financial side of a project (`FinancialPlan`, `CostCenter`) exists in isolation: it tracks internal budget vs spend but has no link to *why* the money exists — i.e. the commercial/contractual side (what we are entitled to bill, what has been ordered). There is no notion of a customer, a contract, or an order, and `Analytics & Reporting` is entirely hardcoded mock data.

The goal is a **360° view** that connects the full chain:

> **Contract** (billable envelope) → **Order** (committed/ordered) → **Project** (delivery) → **Cost Center / Financial Plan** (internal budget) → **Assignment × rate** (actual cost) → **Margin**.

Forces at play:
- The backend is an in-memory Express mock (`src/server.ts`); adding entities is cheap but must follow the validation hardening from the security audit (ADR references BUGHUNT-SECURITY.md S1/S2/S6).
- Angular 21, SSR, bundle budget 500 kB initial — constrains chart libraries.
- All new code must follow the established conventions (see `ANGULAR-REVIEW.md`) and the `/angular` skill set: standalone + signals + `rxResource` + `computed` + lazy routes + typed forms + SSR-safe + tested.
- A full analytical layer is an explicit requirement, not optional.

## Decision

1. **Introduce a fifth top-level area "Commercial"**, peer to Resource/Project/Analytics/Configuration, containing **Customers**, **Contracts**, **Orders**.
2. **Cardinality:** `Customer 1—N Contract`, `Contract 1—N Project` (a contract funds multiple projects), and order lines are imputed to a project: `Order 1—N OrderLine`, `OrderLine N—1 Project`.
3. **Orders are two-sided:** `Order.type ∈ {Customer, Purchase}`. `Customer` = revenue (funds projects); `Purchase` = cost, with `Order.partnerId` linking to the existing **Project Partners** (external vendor companies).
4. **Rates on `Resource`:** add `costRate` (internal hourly cost) and `billRate` (sell rate). **Actual cost** = Σ(`assignment.assignedHours × resource.costRate`) + Σ(Purchase order amounts). **Revenue** = contract/customer-order value (Fixed Price) or Σ(hours × `billRate`) (T&M). **Margin** = revenue − cost.
5. **Analytics layer is first-class:** the `reporting` page becomes real, fed by the new endpoints, covering margin/profitability, backlog & revenue recognition, budget-vs-actual variance, billability & utilization, portfolio KPIs, and EAC forecast.
6. **Charts:** signal-driven **SVG/CSS** components (no heavy dependency) by default, to respect SSR + bundle budget.
7. **Backend hardening bundled in:** when adding the new endpoints, apply the audit's S1 (allow-list, no raw `req.body` spread), S2 (numeric validation), S6 (payload limit + rate limit) across new *and* existing endpoints.
8. **Bidirectional navigation:** manage contracts in the Commercial area; reference them in a new **Project 360** tab inside `project-details`; join both in Analytics.

### Data model (new/changed)

```ts
interface Customer { id; name; industry?; country?; }
interface Contract {
  id; customerId; name; type: 'T&M' | 'Fixed Price' | 'Framework';
  totalValue; currency; status: 'Draft' | 'Active' | 'Closed';
  startDate; endDate;
}
interface Order {
  id; contractId; type: 'Customer' | 'Purchase';
  partnerId?;          // required when type === 'Purchase'
  amount; currency; status: 'Open' | 'Confirmed' | 'Invoiced' | 'Paid';
  orderDate;
}
interface OrderLine { id; orderId; projectId; description; amount; }
// Project: + contractId?
// Resource: + costRate?; billRate?
```

## Options Considered

### Decision 1 — Where do Contracts live?

#### Option A: Commercial as a peer top-level area *(chosen)*
| Dimension | Assessment |
|-----------|------------|
| Complexity | Med |
| Domain fit | High — distinct lifecycle/actors |
| Scalability | High — grows independently of projects |

**Pros:** matches the 1—N reality (a contract can't be "inside" one project); mirrors org roles (sales vs delivery vs resourcing); keeps `project-details` focused.
**Cons:** one more nav section; needs cross-links to avoid silos.

#### Option B: Contracts as a tab inside `project-details`
**Pros:** zero new nav. **Cons:** **breaks** as soon as a contract spans multiple projects (the confirmed cardinality); duplicates the contract across projects. Rejected.

### Decision 4 — Source of "actual cost" / margin

#### Option A: Full actuals from `assignment × rate` *(chosen — "serve tutto")*
**Pros:** real margin, billability, EAC; enables the analytics layer. **Cons:** requires rates on `Resource` and rate maintenance.

#### Option B: Budget-only margin (contract value − budgeted cost)
**Pros:** no rate model. **Cons:** no true cost/margin; analytics would be shallow. Rejected per requirement.

### Decision 6 — Charting approach

#### Option A: Signal-driven SVG/CSS components *(chosen)*
| Dimension | Assessment |
|-----------|------------|
| Bundle impact | ~0 kB |
| SSR/hydration | Safe (no canvas/DOM-only lib) |
| Effort | Med (build a few reusable chart components) |

#### Option B: Charting library (e.g. ECharts/Chart.js/ngx-charts)
**Pros:** rich charts fast. **Cons:** 100–400 kB, canvas often SSR-unfriendly, hydration caveats, blows the 500 kB budget. Deferred — revisit only if viz complexity demands it.

## Trade-off Analysis

The central trade-off is **upfront modeling cost vs. analytical depth**. Choosing full actuals (rates, two-sided orders, order-line→project imputation) is more to build and maintain, but it is the only model that supports the required margin/billability/forecast analytics; a budget-only model would have to be re-done later. The peer-area placement costs one nav section but is forced by the `Contract 1—N Project` cardinality. SVG/CSS charts trade some authoring effort for staying within the SSR + bundle constraints that a chart library would violate.

## Consequences

**Easier:**
- True 360° per project and per contract; real Analytics replacing mock KPIs.
- Backend validation hardening lands alongside the new endpoints (one pass).
- Reuses established patterns (rxResource/computed/lazy/typed forms) → consistent, testable.

**Harder / new burden:**
- Rate data must be maintained on resources (new Configuration surface or profile field).
- More entities/endpoints to keep consistent; cross-entity invariants (order lines must sum within contract value) need validation.
- An `AuthService` is still absent (audit B18); revenue/cost data makes role-based access more important — tracked as a follow-up, not in this ADR's scope.

**To revisit:**
- Invoicing/billing-plan granularity (currently modeled as order `status` only).
- Multi-currency handling (currency stored, but FX conversion not yet specified).
- Whether to extract a shared chart library once 3+ chart types exist.

## Action Items

1. [ ] Backend: add `Customer`/`Contract`/`Order`/`OrderLine` stores + CRUD in `src/server.ts`; add `contractId` to projects, `costRate`/`billRate` to resources; apply S1/S2/S6 hardening to new + existing endpoints; add real CRUD for the 7 project sub-resources (fixes B1).
2. [ ] `ApiService`: typed methods + **shared exported interfaces** (Customer, Contract, Order, OrderLine, Partner, …) so components stop redefining local ones.
3. [ ] Commercial area: lazy routes `customers`, `contracts`, `contracts/:id`, `orders`; nav section in `app.ts`.
4. [ ] Project 360 cockpit: new "Overview" tab in `project-details` with `computed` rollups (revenue, cost, margin, backlog, burn).
5. [ ] Analytics layer: make `reporting` real; add portfolio dashboard KPIs; SVG/CSS chart components.
6. [ ] Tests: unit-test the financial `computed` (margin, margin%, EAC, variance) and the new endpoints (HttpTestingController).
7. [ ] Follow-up ADR: `AuthService` + role-based access for commercial/financial data.
