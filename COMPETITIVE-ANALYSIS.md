# Competitive Analysis — Professional Services Automation (PSA) Platform

_Prepared for product & executive review. Status: internal, candid._

---

## 1. Executive Summary

We have built a credible **PSA system-of-record foundation**: resource profiles with skills and proficiency, projects with rich governance sub-tabs (partners, documents, work packages, milestones-with-approval, tasks, issues, change requests), a comprehensive **billing-conditions model** (Milestone, SAL, T&M, Capped, Recurring, Advance, Expense, Credit Note), and genuinely strong **finance math** (POC revenue recognition, margin, EAC/VAC, burn, a DSO proxy) exposed through a delivery command-center dashboard. Skills inventory and proficiency tracking are fully on par with the market.

**But the product stops at "modeled, not operational."** Across every market scan — Planview, Workday, Kantata, Certinia, NetSuite/OpenAir, Projector, plus the mid-market field of Wrike, Smartsheet, Scoro, Productive.io, Projectworks, Float, Runn, Forecast, Mosaic, Resource Guru, and Dayshape — the same gaps surface repeatedly:

- **No forward-looking view.** We hold all the inputs (capacity, bookings, requests, skills) but produce **zero demand/capacity forecasting**. This is the single most-cited table-stakes gap in the analysis.
- **Finance is modeled but not actioned.** We compute revenue recognition and DSO, but there is **no dated recognition schedule, no AR aging, no invoice document, no GL posting**. Leaders auto-generate journals and invoices; we do not.
- **No real integrations and no real auth.** The backend is a mock, RBAC is illustrative and unenforced, and there are no ERP/CRM/HRIS connectors. These are hard enterprise blockers.
- **Scheduling is manual.** Our staffing match is a naïve boolean filter; leaders (Dayshape, Wrike, Forecast) sell rule-based and AI-driven matching as premium differentiators.
- **Web-only.** No mobile/offline, which blocks field-services use cases.

**The good news:** much of the highest-value work is **pure derivation over data we already hold**. Demand forecasting, AR aging, resource-match scoring, and margin drill-down/alerts can be built as signal-driven pure functions with no backend rework — capturing most of the perceived value of the leaders' premium features at modest effort. The expensive, structural items (real auth/OIDC, GL/ERP posting, dated ASC 606 schedules, an approval workflow engine) should be sequenced deliberately behind those quick wins.

**Bottom line:** We are a strong demo and a competent SMB system-of-record, **not yet an enterprise-ready PSA**. Closing the forecasting, AR-aging, and resource-scoring gaps moves us from "tracks what happened" to "tells you what to do" — the threshold buyers expect.

---

## 2. Capability Matrix

Legend — **TS** = Table-stakes. **Have**: yes / partial / no.

| Capability | Market leaders | TS | Have | Note |
|---|---|:--:|:--:|---|
| Resource Scheduling & Optimization | Planview, Workday (constraint solvers, AI matching); Wrike, Projectworks (embedded) | Yes | no/partial | We have staffing requests/assignments but **no optimizer**. Premium differentiator for leaders. |
| Demand Planning & Capacity Forecasting | Kantata, Workday, Forecast, Runn, Smartsheet (3–12mo rolling, heatmaps, scenarios) | Yes | **no** | **Most-cited gap.** Only a simple backlog view; no forecasting engine. |
| Skills Marketplace & Gig Integration | Kantata (Upwork/Toptal), Workday ML, Certinia Einstein | No | partial | Profiles + skills + proficiency, but no marketplace or ML matching. |
| Revenue Recognition (ASC 606 / IFRS 15) | Kantata, SAP, Certinia, Oracle, Workday, NetSuite, Certinia (five-step engine) | Yes | partial | POC + conditions UI exist; **no auto journals, no deferral schedules, no five-step model**. |
| Billing & Accounts Receivable | All leaders (auto-invoice, retainage, AR aging, DSO, consolidation) | Yes | partial | Conditions UI only; **no auto-invoice, no AR aging, no retainage/tax mechanics**. |
| Invoicing & Payment Integration | Stripe, Bill.com, SAP Cash App, UBL/EDIFACT e-invoice | Yes | **no** | All mock. No invoice generation, payment gateways, or reconciliation. |
| Project Financials & Margin Analysis | Realized/contribution/FAC margin, SPI/CPI variance, profitability by dimension | Yes | partial | Strong base (margin, EAC/VAC, burn); lacks trend/alerts, variance breakdown, drill-down. |
| Time & Expense Management | Native mobile, offline, OCR, per-diem/mileage, payroll sync | Yes | partial | Time entries + approval UI; **no mobile, OCR, mileage/per-diem, payroll sync**. |
| Approvals & Workflow Orchestration | Multi-step conditional routing, SLA/escalation, bulk/mobile, Slack/Teams | No/Yes | partial | Mock RBAC + per-entity status flips; **no workflow engine, SLA, escalation, SOD**. |
| ERP & HCM Integrations | SAP, Oracle, NetSuite, Dynamics, Salesforce; real-time GL/AR/HCM/CRM | Yes | **no** | Mock backend, no real integrations. Hard enterprise blocker. |
| Reporting & Analytics | Real-time dashboards, AR aging, DSO, ad-hoc BI, Tableau/Power BI/Looker | Yes | partial | Command center + portfolio margin; lacks ad-hoc BI, AR aging detail, BI connectors. |
| Multi-Entity & Multi-Currency | Intercompany billing, FX revaluation, consolidated reporting, entity GL | No/Yes | **no** | TS only for global firms. SAP/Oracle/Workday core strength. |
| Project Governance & Contract Controls | CR workflows, sign-off, doc mgmt, risk/issue registers, audit, email capture | No | partial | Strong base (sub-tabs, mock RBAC, audit log). Gaps: email capture, real RBAC. |
| Client & Partner Portals | Status/billing/payment portals, partner time/payables, white-label, SSO | No | **no** | All-internal today. Kantata, Certinia, Runn, Float strong here. |
| AI & Automation | Predictive matching, risk/cost prediction, anomaly detection, OCR, chatbots | No | **no** | Emerging differentiator (Workday ML, Certinia Einstein, Wrike/Smartsheet copilots). |
| Mobile & Offline | iOS/Android, offline sync, push, geolocation, receipt capture | Yes | **no** | Web-only. Blocks field-heavy services (construction, utilities, telecom). |
| Enterprise Governance & Compliance | RBAC + hierarchy, data residency (GDPR/HIPAA/SOC 2), 2FA, encryption, ISO 27001 | Yes | partial | Mock RBAC + audit log; **no real auth, residency, or certs**. Enterprise blocker. |
| Visual Capacity Planning (Gantt/Timeline) | Float, Runn, Forecast, Resource Guru (drag-drop, conflict detection, heatmaps) | Yes | partial | Assignments/requests exist; **no visual timeline, over-allocation/conflict UI**. |
| Skills-Based Matching & Gap ID | Kantata, Kimble, Dayshape, Mosaic (ontology, best-fit, gap analysis) | No | partial | Skills/proficiency exist; **no matching algorithm or gap tool**. |
| AI-Powered Scheduling | **Dayshape** (constraint-solving ML), Forecast (AI-assisted) | No | **no** | Manual assignments only. Dayshape is AI-first leader. |
| Project Portfolio Management | Wrike, Smartsheet, Mosaic, Runn (strategic scoring, conflict resolution, scenarios) | No/Yes | partial | Portfolio margin/backlog; **no strategic scoring, cross-project conflict, scenarios**. |
| What-If / Capacity Simulation | Runn, Forecast, Mosaic, Planview (hire/loss/slip scenarios) | No | **no** | No scenario engine. |
| Utilization & Billability Analytics | Billable hours, utilization by dimension, revenue/FTE, bench cost, realization % | Yes | partial | Utilization + DSO + bill-vs-cost; lacks cohort, revenue/FTE trend, realization %. |
| Performance Obligations & Contract Segmentation | Certinia, NetSuite (distinct POBs, separate recognition) | Yes | partial | Projects + milestones, but no POB data model. |
| Contract-Modification Rev Recalc | Certinia, NetSuite (CR scope/timing → catch-up) | Yes | **no** | CR tracker exists but no revenue-impact recalculation. |
| Progress POC Billing | Kantata, Projector (% earned → invoice) | Yes | partial | Other triggers exist; **Progress POC automation missing**. |
| Bill-Rate vs Cost-Rate Gap Analysis | Kantata, Projector, Certinia (margin-compression alerts) | Yes | partial | Margin metrics exist; no rate reconciliation/compression alerts. |
| Tax / Retention / Discount / FX Modifiers | All (VAT/GST, holdback, early-pay/volume discount, FX) | Yes | partial | Tax + retention; **no discount models or currency conversion**. |
| Invoice Batch / PDF / Sequence | All (batch gen, PDF render, e-delivery, compliant numbering) | Yes | partial | Invoice structure only; one-at-a-time, no PDF/number sequence. |
| Subscription/Recurring w/ Proration & True-Up | Kantata, NetSuite, Certinia | Yes | partial | Recurring model exists; no proration or usage true-up. |
| Earned Value & Burndown (progress curves) | Projector, NetSuite | Yes | partial | EAC/VAC metrics; no progress POC models or burndown viz. |
| Budget vs Actual w/ Alerts & Re-forecast | All (variance %, escalation, re-forecast) | Yes | partial | Basic variance; no alerts or re-forecast. |
| Subcontractor / Vendor Mgmt (PO, 3-way match) | NetSuite, Projector, Mosaic, Runn | No/Yes | **no** | No vendor/PO module. Gap for staff-aug/outsource practices. |
| Project Costing & Allocation Engine | Projector (labor, burden, overhead, equipment) | Yes | partial | Cost centers + resource cost; no overhead/equipment allocation. |
| Hierarchical / Conditional Approval Routing | All (amount thresholds, escalation, multi-level) | Yes | partial | Time approval only; no dynamic routing. |
| Concurrent vs Sequential Approval | Certinia, NetSuite (parallel/sequential/OR) | No | **no** | Likely sequential only. |
| Audit Trail & Immutability (SOX/GDPR) | NetSuite, Certinia (immutable, full change history) | Yes | partial | Mutable in-memory log capped at 500, method/path/status only. |
| Segregation of Duties (SOD) | NetSuite, Certinia (no self-approval) | Yes | partial | Roles exist; no SOD rule engine. |
| Project-Level Financial Statements (P&L) | NetSuite, Projector, Certinia | Yes | **no** | No project P&L / WIP balance / deferred statements. |
| Customer Profitability & Concentration Risk | All (margin by customer, DSO trend, concentration %) | Yes | partial | Customer exists; no deep profitability/concentration analysis. |
| Resource Profitability & Realization % | Kantata, Kimble, Projector | Yes | partial | Utilization only; no revenue/FTE, margin/resource, realization %. |
| BI Export / Ad-hoc / Drill-down | Runn, Forecast, Mosaic; Tableau/Power BI/Looker | Yes | partial | Fixed dashboards; no CSV/Excel export, BI connectors, ad-hoc builder. |
| Custom Metrics & KPI Dashboards | Runn, Forecast (user-defined KPIs, alert thresholds) | No | partial | Fixed metrics only. |
| Multi-Currency & FX | NetSuite, Certinia, Projector (spot rates, realized/unrealized FX) | Yes | **no** | Hardcoded EUR; no currency in data model. |
| Bank Feed & Cash Reconciliation | NetSuite, Sage Intacct | Yes | **no** | No bank feed or AR reconciliation. |
| Dunning & Collections Automation | Kantata, Certinia, NetSuite | Yes | **no** | No payment/AR integration, so no dunning. |
| Data Privacy & Retention (GDPR/RTBF) | Certinia, NetSuite | Yes | **no** | No GDPR/erasure framework. |
| Skills Inventory & Proficiency & Certs | Kantata, Kimble, Projector | Yes | **yes** | **Fully implemented.** Foundational strength. |
| Skill-Based Rate Cards | Projector, Kantata (rates by skill+proficiency) | Yes | partial | Bill rate at assignment level; no rate-card library. |
| Equipment & Asset Tracking | NetSuite, Projector | No | **no** | No equipment module. |
| Anomaly Detection / Early Warning | Certinia (Einstein), NetSuite | No | **no** | No anomaly detection. |

---

## 3. Gap Analysis

Three workstreams. **Priority**: P0 (do now) → P2 (later). **Effort**: S / M / L.

### 3.1 ADD — new capabilities

| Item | Why | Priority | Effort |
|---|---|:--:|:--:|
| **Demand & capacity forecasting + bench view** (rolling 3–12mo): supply from availability data, demand from open ResourceRequests + bookings; skill-level capacity-gap heatmap, bench list, over/under-allocation. Pure-function engine over existing /requests, /assignments, /resources, /availability. | Single most-cited table-stakes gap across **every** scan (Kantata, Workday, Forecast, Runn, Smartsheet). We hold all inputs but offer zero forward view. Highest leverage — pure aggregation, no ML, no backend rework. Drives hire/bench/win-this-deal decisions. | **P0** | M |
| **AR aging & collections view**: aging buckets (0–30/31–60/61–90/90+) and overdue flags from BillingPlanItem dates + status; portfolio DSO trend; dedicated AR tab with per-customer rollup and "overdue" chips. | We already compute `dsoProxy()` and hold issuedDate/dueDate/paidDate/paymentTermsDays but never surface aging — the #1 CFO-facing gap behind invoicing. Pure derivation, no new persistence. | **P0** | S |
| **Rule-based resource-match scoring in Staffing**: replace boolean role-OR-skill filter with a weighted score (skill+proficiency coverage, role fit, availability headroom, cost-vs-bill margin); rank candidates; show score breakdown + skills-gap. | Resource optimization/AI scheduling is the top PSA differentiator (Dayshape, Wrike, Forecast). Our match is a naïve `includes()`. A deterministic scorer captures ~80% of the perceived value at modest effort; big demo/sales lift. | **P0** | M |
| **What-if capacity scenario sandbox**: client-side overlay on the forecasting engine — "win this deal," "hire N of skill X," "slip project B" — recompute utilization, skill gaps, portfolio margin. No persistence. | Recurring strategic differentiator (Runn, Forecast, Mosaic, Planview). Because forecasting is pure-function, scenarios are incremental: clone, mutate, recompute. High executive appeal. **Depends on forecasting landing first.** | P1 | M |
| **Invoice document generation + batch + sequence**: render invoice artifact (HTML/PDF) with compliant sequential numbering; multi-select batch generation from the Ready queue. | `generateInvoice()` flips status but produces no document, no number sequence, one-at-a-time. Concrete table-stakes step toward real invoicing; mostly frontend/templating over existing billing logic. | P1 | M |
| **Multi-step / conditional approval workflow engine** for time/expense/milestone/CR/invoice: amount-threshold routing, sequential vs parallel, SLA/aging escalation, SOD guard (requester ≠ approver). Generic ApprovalRequest store + rules evaluator + Approvals inbox. | Governance is table-stakes; we have ad-hoc per-entity status flips with no routing, SLA, escalation, or SOD. A single engine consolidates scattered logic and unblocks enterprise/regulated buyers. Spans many entities → larger. | P1 | L |
| **Project- & customer-level margin drill-down + variance alerts** (margin < target, burn > 90%, EAC > budget): per-driver breakdown (labor vs external vs expense); portfolio alert feed on dashboard. | `computeProjectFinancials` already yields margin/EAC/VAC/burnPct per project, but reporting shows only portfolio bars with hardcoded trends. Real drill-down + alerts (pure derivation) deliver the variance/alerting buyers expect. | P1 | S |
| **BI/data export**: CSV/Excel on every report + read-only JSON export of portfolio/finance rollups for Power BI/Tableau/Looker ingestion. | Reporting is consistently rated "partial — missing BI connectors/export." A generic export utility over existing computed datasets is cheap and clears a frequent procurement checkbox. | P2 | S |
| **Multi-currency foundation**: currency + FX-rate on orders/billing; conversion to a base reporting currency; show original and converted. Stop hardcoding EUR. | Hardcoded EUR across seed and every pipe. TS only for global firms (lower SMB priority) but structural — touches data model, finance.util, all pipes. Scope deliberately rather than retrofit. | P2 | L |

### 3.2 MODIFY — deepen what exists

| Item | Why | Priority | Effort |
|---|---|:--:|:--:|
| **Auditable, dated revenue-recognition schedules**: extend finance.util to emit per-period schedule (recognized this period, cumulative, Advance deferral amortization, expense pass-through with markup) + a recognition "journal" preview per milestone-approval/invoice event with an audit row. | Solid POC math exists but is point-in-time, not dated, with no journal/catch-up. ASC 606/IFRS 15 auto-recognition is the most-repeated finance gap. Building schedules on the existing tested pure functions is the realistic next layer without a real GL. | **P0** | L |
| **Contract-modification revenue & budget recalc on CR approval**: when a CR with impactBudget/impactScheduleDays is Approved, fold impact into budget/EAC and trigger recognition catch-up. | ChangeRequest already carries impactBudget/impactScheduleDays + approval status, but `computeProjectFinancials` ignores them — approved scope changes never move budget, EAC, or revenue. High value for change-order-heavy practices. | P1 | M |
| **Enforce mock RBAC into an authorization seam**: move AuthService capability computeds into route guards + per-endpoint checks in the mock server (audit log records actorRole but endpoints don't enforce). Keep single-file swap for OIDC/SSO drop-in. | `auth.service.ts` is the explicit swap point and derives capabilities, but nothing enforces them — any role can call any endpoint. Enforcement is the prerequisite for SOD, approval routing, and SSO/SCIM. | P1 | M |
| **Make the audit log integrity-credible**: append-only (no in-place edits), capture before/after field deltas, remove/justify the silent 500-entry truncation, add export, filterable viewer. | Currently a mutable in-memory array capped at 500 with only method/path/status — undermines the SOX/immutability claim that's table-stakes for regulated/PE-backed buyers. Focused change to existing audit middleware. | P1 | M |
| **Capped & Progress billing automation**: enforce Capped not-to-exceed against accrued T&M (block/flag when accrued > cap); auto-advance Progress items as % complete changes, mirroring the milestone→Ready trigger. | Billing types exist as data (capAmount, progressPct) and one automated trigger already works (milestone→Ready), but Capped enforcement and Progress auto-advance aren't wired. Extends the proven trigger pattern. | P2 | M |
| **Replace illustrative dashboard/reporting trends with real period-over-period deltas**; remove hardcoded `trendFactor` multipliers. | KPI trends use hardcoded factors (12/4/−5 × trendFactor) presented as percentages — misleading in a financial product. Once period data exists, real deltas are a small, high-trust fix benefiting the command center too. | P2 | S |

### 3.3 INTEGRATE — connect to the outside world

| Item | Why | Priority | Effort |
|---|---|:--:|:--:|
| **Real authentication / SSO via OIDC** (OAuth2 Auth Code + PKCE) replacing mock AuthService; claim→UserRole mapping; Angular auth interceptor for token attach/refresh alongside the error interceptor. | No real auth is a hard enterprise blocker cited across scans. AuthService and the new interceptors/ folder are purpose-built as the swap seam. **P0 because it gates SCIM, real RBAC enforcement, audit attribution, and portals.** | **P0** | L |
| **GL/ERP posting integration** (NetSuite/QuickBooks/SAP/Dynamics) via a posting-adapter abstraction: emit revenue/WIP/deferred/labor-cost/invoice journals from the recognition schedule + invoicing events to an outbound connector (start QuickBooks/Xero-style REST), feature-flagged. | Real-time GL posting is the most-cited enterprise TS integration and the natural consumer of rev-rec + invoicing work. A clean adapter boundary now prevents hard-coding to one ERP. **Depends on rev-rec + invoicing landing first.** | P1 | L |
| **CRM deal-to-project handoff** (Salesforce/HubSpot/Pipedrive): import won opportunities as Customers/Contracts/Projects; feed weighted pipeline into demand forecasting so "if we win this" uses real deal probability. | CRM integration is TS for mid-market and makes demand forecasting probabilistic rather than guesswork. Inbound mapper into existing Customer/Contract/Project + the forecasting engine. **Secondary to internal forecasting existing first.** | P1 | M |
| **E-invoicing / payment & AR integration** (Stripe / Bill.com / UBL export) + payment-status webhooks feeding AR aging + dunning. | Invoicing/payment integration is legally required for real revenue and the endpoint for AR aging + dunning. **Sequenced after invoice generation and AR aging exist internally.** | P2 | L |
| **SCIM 2.0 + HRIS sync** (Workday/BambooHR) for employees, org units, cost centers, capacity — feeding resource master + forecasting capacity side. | Enterprise-governance and capacity enabler, but only meaningful once OIDC identity exists. Lower priority than the auth seam; pairs naturally with forecasting capacity inputs once SSO is in. | P2 | L |

---

## 4. Recommended Roadmap

### NOW (P0) — turn data we already hold into forward-looking value
1. **Demand & capacity forecasting + bench view** (ADD, M) — close the #1 gap; pure functions, no backend.
2. **AR aging & collections view** (ADD, S) — fastest CFO-facing win; derive from existing billing dates.
3. **Rule-based resource-match scoring** (ADD, M) — biggest demo/sales lift; deterministic scorer over skills/availability.
4. **Dated revenue-recognition schedules + journal preview** (MODIFY, L) — the most-repeated finance gap; build on existing tested POC math.
5. **Real auth / OIDC SSO** (INTEGRATE, L) — start now; it gates everything enterprise (RBAC enforcement, SOD, SCIM, portals). Long pole — begin in parallel.

> Sequencing note: items 1–3 are pure-function, parallelizable, and unblock the "Next" tier. Items 4–5 are long poles that should start immediately even though they land later.

### NEXT (P1) — make it operational and governable
6. **What-if scenario sandbox** (ADD, M) — overlay on the forecasting engine (item 1).
7. **Invoice generation + batch + sequence** (ADD, M) — first real invoicing step.
8. **Project/customer margin drill-down + variance alerts** (ADD, S) — quick credibility win on existing math.
9. **CR-driven contract-modification revenue/budget recalc** (MODIFY, M) — wire impactBudget/impactScheduleDays into finance.util.
10. **Enforce RBAC seam** + **integrity-credible audit log** (MODIFY, M+M) — prerequisites for SOD and approval routing; depend on item 5.
11. **Approval workflow engine** (ADD, L) — consolidates scattered approvals; needs RBAC enforcement first.
12. **GL/ERP posting adapter** (INTEGRATE, L) — consumes rev-rec (item 4) + invoicing (item 7).
13. **CRM deal-to-project handoff** (INTEGRATE, M) — makes forecasting probabilistic; consumes item 1.

### LATER (P2) — breadth, scale, and global reach
14. **Capped & Progress billing automation** (MODIFY, M).
15. **Real period-over-period KPI deltas** (MODIFY, S) — remove hardcoded trend factors.
16. **BI/data export** (ADD, S) — CSV/Excel + JSON for Power BI/Tableau/Looker.
17. **E-invoicing / payment & AR + dunning** (INTEGRATE, L) — after invoicing + AR aging exist.
18. **SCIM 2.0 + HRIS sync** (INTEGRATE, L) — after OIDC.
19. **Multi-currency foundation** (ADD, L) — structural; only when pursuing global/multi-entity buyers.

**Deferred / opportunistic** (track but not roadmapped now): mobile & offline apps (blocks field-services segment — revisit if that market is targeted), client/partner portals, AI/anomaly detection, subcontractor/PO management, multi-entity consolidation, equipment/asset tracking.

### Guiding principle
Roughly **70% of P0/P1 value is pure derivation or wiring over data and seams we already have** (forecasting, AR aging, match scoring, margin drill-down, CR recalc, RBAC enforcement). Bank those first. Reserve the heavy structural lifts — OIDC, GL posting, dated ASC 606 schedules, the approval engine, multi-currency — for deliberate, dependency-ordered investment. This path moves us from "system of record" to "system of decision" without a backend rewrite.
