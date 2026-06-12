# Competitive Analysis — Delivery Control (PSA Platform)

_Prepared for product & executive review. Status: internal, candid._

**Last updated: 2026-06-12** (verified against the codebase; supersedes the 2026-06-08 "modeled, not operational" baseline)

---

## 1. Executive Summary

Delivery Control is no longer a demo. As of 2026-06-12 it is an **operational PSA platform** built on real infrastructure, verified by reading the code — not the prior roadmap.

What is now genuinely operational:

- **Real persistence.** A dual-adapter Repository pattern (`src/db/`) selects Postgres + Drizzle when `DATABASE_URL` is set (31 typed `pgTable`s, FK constraints, indexes, forward migrations, idempotent parent-before-child seeding) and falls back to in-memory otherwise. `GET /storage-status` reports which is live. Dev still defaults to in-memory; Postgres is opt-in.
- **Real authentication & server-side authorization.** Keycloak OIDC (Authorization Code + PKCE) on the client; the server cryptographically verifies every bearer token against the IdP's JWKS via `jose` (`src/server.ts`). A `roleGate` middleware enforces a server-trusted role (JWT realm role wins; spoofable headers honored only in opt-in dev mode) on both reads and writes. Segregation of Duties (no self-approval) is enforced in three flows on server-pinned principals. An append-only audit trail records actor/role/method/path + before/after deltas.
- **Forward-looking resourcing.** A tested capacity-forecasting engine (`forecast.util.ts`) produces rolling 8/12-week supply-vs-demand, bench and over-allocation lists, and per-skill gap analysis, surfaced in `forecast.ts`. A fully working **what-if scenario sandbox** (`what-if.ts`) overlays win-deal / hire / slip-project levers and shows side-by-side deltas. A deterministic **resource-match scorer** (`match.util.ts`, weighted 0-100 across skill/proficiency/role/availability/margin) is wired into Staffing.
- **Actioned finance.** `finance.util.ts` (1,600+ lines, unit-tested) delivers dated ASC-606-style **revenue-recognition schedules** (POC / straight-line / as-incurred / deferred-advance) with a **balanced double-entry journal preview**, **AR aging + DSO** (buckets, per-customer, amount-weighted), **customer profitability + concentration (real HHI)**, **margin drill-down + variance alerts**, and **realization / revenue-per-FTE**. All cross-currency rollups normalize to a base currency via a real FX rate table.
- **Real billing.** Server-side **sequential invoice numbering** under a lock, **batch invoice generation**, a printable invoice artifact, **capped not-to-exceed enforcement** (hard reject + accrual flag), tax/retention modifiers, and a **FatturaPA e-invoice XML** builder.
- **Approval workflow engine.** Multi-step, amount-threshold (>50k → delivery-executive → finance) sequential routing with per-step role enforcement, SLA stamping, and race-safe locked decisions.
- **Integration seam.** Four adapters (GL journal export, FatturaPA e-invoice, CRM outbox, BI feed) produce well-formed, spec-tested artifacts behind a registry — explicitly `connected:false`, `mode:'local-artifact'`.
- **Multi-currency.** FX rate table with admin CRUD, `convertToBase` wired pervasively through all financial rollups.

**What still separates us from enterprise leaders** (Workday, Certinia, NetSuite/OpenAir, Kantata, Planview, Dayshape, Mosaic, Runn) is now sharper and smaller, but real:

1. **The integration seam produces artifacts, not connections.** GL posting, e-invoice transmission (SDI/PEPPOL), and CRM sync all stop at a downloadable/parked file — no network, credentials, acknowledgement, or reverse-sync. There is **no inbound CRM deal → project** handoff.
2. **No payments or collections.** Mark-paid is a status flip; there is no payment gateway, partial payments/cash application, dunning, or bank reconciliation.
3. **No true scheduling Gantt.** Forecasting and conflict detection are aggregate (util > 110%), not per-resource date-level booking bars with drag-and-drop and overlap detection — `Assignment` has no start/end dates.
4. **No performance-obligation / SSP model.** Recognition is per-billing-line heuristic, the journal is a preview (no posted ledger, no period close), and FX is current-rate-only (no dated rates).
5. **Greenfield areas remain:** AI/ML matching & anomaly detection, mobile/offline, client/partner portals, SCIM/HRIS sync, multi-entity (legal entity) consolidation, an ad-hoc BI/report builder, GDPR/data-privacy tooling, and equipment/asset tracking.

**Bottom line:** we have crossed the threshold from "tracks what happened" to "tells you what to do" on an enterprise-grade auth + persistence + governance spine. The remaining frontier is **the outside world** — live external integrations, payments, AI, mobile, and portals — plus accounting depth (posted ledgers, performance obligations, dated FX).

---

## 2. Delivered Since the 2026-06-08 Baseline

The prior §4 roadmap (P0/P1/P2) is largely complete. Status verified in code.

| Roadmap item (old §4) | Tier | Status | One-line evidence |
|---|:--:|:--:|---|
| Demand & capacity forecasting + bench view | P0 | **Partial→Done (engine)** | `forecast.util.ts` `capacityForecast`/`benchList`/`overAllocated` + `forecast.ts` UI; tested. No per-resource heatmap/calendars. |
| AR aging & collections view | P0 | **Done** | `arAging` (0-30/31-60/61-90/90+), `arAgingByCustomer`, `dsoOutstanding` surfaced in `reporting.ts` with CSV export. |
| Rule-based resource-match scoring | P0 | **Done** | `match.util.ts` weighted 0-100 scorer wired into `staffing.component.ts`; `match.util.spec.ts`. |
| Dated revenue-recognition schedules + journal preview | P0 | **Done (preview)** | `recognitionSchedule` + balanced `recognitionJournal` in `finance.util.ts`, shown in `contract-details.ts`. Not posted. |
| Real auth / OIDC SSO | P0 | **Done** | `auth.service.ts` (PKCE) + `jose` JWKS `jwtVerify` in `src/server.ts`; `roleGate` server-side. |
| What-if scenario sandbox | P1 | **Done (ephemeral)** | `what-if.ts` win/hire/slip levers, side-by-side deltas; not persisted. |
| Invoice generation + batch + sequence | P1 | **Done** | `nextInvoiceNumber()` under `withLock('invoice-seq')`; batch `generateSelectedInvoices`; printable artifact. |
| Project/customer margin drill-down + variance alerts | P1 | **Done** | `marginDrivers`/`projectAlerts`/`portfolioAlerts` in `finance.util.ts`, rendered in `reporting.ts` + dashboard. |
| CR-driven contract-modification budget recalc | P1 | **Partial** | `effectiveBudgetForProject` folds approved CR `impactBudget` into budget/EAC/VAC. Revenue/recognition **not** recalculated. |
| Enforce RBAC seam | P1 | **Done** | `roleGate` + `READ_RULES` on every `/api` call; client guards are defense-in-depth only. |
| Integrity-credible audit log | P1 | **Partial** | Append-only by convention (no update/delete path), before/after deltas, trusted actor. No hash-chain/WORM; best-effort writes. |
| Approval workflow engine | P1 | **Partial** | Multi-step threshold routing + SoD + SLA stamp + locked decisions. No active escalation, delegation, or parallel/quorum. |
| GL/ERP posting adapter | P1 | **Partial** | `GenericLedgerExportAdapter` balanced journal export at `/integrations/erp/journal-export`. Local artifact only, no posting. |
| CRM deal-to-project handoff | P1 | **Partial** | `WebhookJsonOutboxCrmAdapter` outbound payload, parked in ephemeral array. No inbound deal ingestion. |
| Capped & Progress billing automation | P2 | **Partial** | Capped hard-reject + accrual flag; `progressAutoAdvance` → Ready at ≥100%. Progress % is manual; cap is a flag, not a billing stop. |
| Real period-over-period KPI deltas | P2 | **Partial** | `periodDelta`/`recognizedRevenueTrend` real for recognised revenue (nulls when no basis). Other KPIs intentionally show no delta. |
| BI/data export (CSV/Excel + JSON) | P2 | **Partial** | Hardened `toCsv`/`escapeCsv` wired across reports; JSON export implemented but **not wired** into any UI. |
| Multi-currency foundation | P2 | **Done (current-rate)** | `fx_rates` table + admin CRUD; `convertToBase` pervasive. No dated/historical rates, no FX gain/loss. |
| GL/ERP, CRM, e-invoice, BI **adapter seam** (new) | — | **Done (artifacts)** | 4 spec-tested adapters in `src/server/integrations/`, registry, all `connected:false`. |

---

## 3. Capability Matrix

Legend — **TS** = Table-stakes. **Have**: yes / partial / no. Updated to verified 2026-06-12 status.

| Capability | Market leaders | TS | Have | Note (current state + residual gap) |
|---|---|:--:|:--:|---|
| Resource Scheduling & Optimization | Planview, Workday (constraint solvers, AI matching); Wrike | Yes | partial | Deterministic match scorer + forecasting now exist; **no constraint-based auto-assignment or multi-request optimizer**. |
| Demand Planning & Capacity Forecasting | Kantata, Workday, Forecast, Runn, Smartsheet | Yes | **partial** | Real rolling 8/12-wk supply-vs-demand engine + bench/over-alloc/skill-gap (`forecast.util.ts`). Gap: per-resource **heatmap/calendars**, PTO/ramp, weighted pipeline, longer horizons. |
| Skills Marketplace & Gig Integration | Kantata (Upwork/Toptal), Workday ML | No | partial | Profiles + skills + proficiency + governed catalog; no marketplace or ML matching. |
| Revenue Recognition (ASC 606 / IFRS 15) | Certinia, SAP, Oracle, Workday, NetSuite | Yes | **partial** | Dated `recognitionSchedule` (POC/straight-line/as-incurred/deferred) + balanced journal preview. Gap: **no five-step / performance-obligation / SSP allocation**, preview-only (no posted ledger/period close), currency-naive schedule. |
| Billing & Accounts Receivable | All leaders (auto-invoice, retainage, AR aging, DSO) | Yes | **yes** | Full AR subsystem (aging buckets, per-customer, weighted DSO, retention, tax, WIP, deferred), status lifecycle enforced. Gap: payment application/partial payments, GL-posted AR subledger. |
| Invoicing & Payment Integration | Stripe, Bill.com, SAP Cash App, UBL/e-invoice | Yes | **partial** | Sequential numbering, batch gen, printable artifact, FatturaPA XML. Gap: **no payment gateway/reconciliation**, browser-print PDF only, in-memory counter, no PEPPOL/UBL. |
| Project Financials & Margin Analysis | Realized/contribution/FAC margin, SPI/CPI, profitability by dimension | Yes | **yes** | `computeProjectFinancials` full per-project P&L (rev/cost/margin/EAC/ETC/VAC/burn) + drivers + alerts. Gap: no overhead/G&A burden, no SPI/CPI. |
| Time & Expense Management | Native mobile, offline, OCR, per-diem/mileage | Yes | partial | Time entries + approval + actual-cost drive. Gap: **no mobile/offline/OCR/mileage/per-diem**, no claimed-expense workflow. |
| Approvals & Workflow Orchestration | Multi-step conditional routing, SLA/escalation, Slack/Teams | Yes | **partial** | Real engine: threshold routing, sequential chain, per-step role enforcement, SLA stamp, locked decisions. Gap: **active escalation, delegation, parallel/quorum, configurable thresholds, designer UI**. |
| ERP & HCM Integrations | SAP, Oracle, NetSuite, Salesforce; real-time GL/AR/HCM/CRM | Yes | **partial** | Balanced GL **journal export** adapter exists. Gap: **no live posting**, no chart-of-accounts mapping, no ack/retry, no reverse-sync, no HCM/HRIS. |
| Reporting & Analytics | Real-time dashboards, AR aging, DSO, ad-hoc BI, Tableau/Power BI/Looker | Yes | **yes** | Two data-backed surfaces (Command Center + Portfolio Analytics) with real charts/states. Gap: **no ad-hoc/drag-drop builder**, saved views, scheduled distribution, drill-through nav. |
| Multi-Entity & Multi-Currency | Intercompany billing, FX revaluation, consolidated reporting | No/Yes | **partial** | Multi-currency real (FX table, `convertToBase`). Gap: **no legal-entity model**, no intercompany, no per-entity ledgers, no dated FX/gain-loss. |
| Project Governance & Contract Controls | CR workflows, sign-off, doc mgmt, risk/issue registers, audit | No | **yes** | 9 working sub-tabs, RAG delivery-health, issue/risk + change-control workflows w/ SoD, milestone approval, append-only audit. Gap: real **file upload/versioning**, contract clause library/e-sign, stage-gates. |
| Client & Partner Portals | Status/billing/payment portals, white-label, SSO | No | **no** | All-internal, Keycloak-gated. No external/guest scope or self-service surface. |
| AI & Automation | Predictive matching, risk/cost prediction, anomaly detection, OCR | No | **no** | Match scoring is deterministic (static weights), not ML. No anomaly detection, no learning loop. |
| Mobile & Offline | iOS/Android, offline sync, push, receipt capture | Yes | **no** | Responsive Tailwind only. SSR with no service worker/PWA/offline. |
| Enterprise Governance & Compliance | RBAC + hierarchy, residency, 2FA, encryption, ISO 27001 | Yes | **partial** | Real OIDC + server RBAC + SoD + append-only audit + rate limiting + prod auth guard. Gap: **no admin config layer** (hard-coded rules/thresholds), no policy engine, no residency/retention, no e-sign/attestation. |
| Visual Capacity Planning (Gantt/Timeline) | Float, Runn, Forecast, Resource Guru (drag-drop, conflict detection) | Yes | **partial** | Timeline as charts + colored gap bands + aggregate over-alloc. Gap: **no per-resource swimlanes/booking bars, no drag-drop, no date-level conflict detection** (Assignment has no dates). |
| Skills-Based Matching & Gap ID | Kantata, Dayshape, Mosaic (ontology, best-fit, gap analysis) | No | **yes** | Request-level missing-skills + portfolio-level `skillGap` (tested), surfaced in Staffing + Forecast. Gap: no taxonomy/synonym/adjacency credit, gap ignores min-proficiency. |
| AI-Powered Scheduling | Dayshape (constraint-solving ML), Forecast | No | **no** | Manual + deterministic scoring only. No constraint solver / ML. |
| Project Portfolio Management | Wrike, Smartsheet, Mosaic, Runn (scoring, conflict, scenarios) | No/Yes | partial | Portfolio analytics + what-if scenarios + alerts. Gap: strategic scoring, cross-project conflict resolution, persisted scenarios. |
| What-If / Capacity Simulation | Runn, Forecast, Mosaic, Planview | No | **yes** | Working client-side sandbox (`what-if.ts`): win/hire/slip levers, side-by-side deltas. Gap: **ephemeral** (no save/name/compare), coarse levers, no financial/margin impact, no probability-weighting. |
| Utilization & Billability Analytics | Billable hours, util by dimension, revenue/FTE, realization % | Yes | **yes** | Team utilization (manager-scoped), assignment CRUD → server recompute, realization %/revenue-per-FTE/revenue-per-head. Gap: **billable vs non-billable split** (no billable flag), per-resource realization, target-vs-actual, bench cost. |
| Performance Obligations & Contract Segmentation | Certinia, NetSuite (distinct POBs, separate recognition) | Yes | **no** | No performance-obligation entity; each billing line is its own obligation by heuristic. No SSP, no allocation. |
| Contract-Modification Rev Recalc | Certinia, NetSuite (CR scope/timing → catch-up) | Yes | **partial** | Approved CR `impactBudget` recalculates budget/EAC/VAC. Gap: **no revenue/transaction-price recalc or recognition catch-up** on CR approval. |
| Progress POC Billing | Kantata, Projector (% earned → invoice) | Yes | **partial** | `progressAutoAdvance` → Ready at ≥100%; recognition is POC. Gap: **progress % is manual** (no cost-to-cost / effort-derived POC). |
| Bill-Rate vs Cost-Rate Gap Analysis | Kantata, Projector, Certinia (margin-compression alerts) | Yes | **yes** | `marginCompressionAlerts` (graded severity on margin gap + thin bill-vs-cost) for projects + customers. Gap: per-resource rate-realization leakage. |
| Tax / Retention / Discount / FX Modifiers | All (VAT/GST, holdback, discounts, FX) | Yes | **partial** | Tax (IVA) + retention (ritenuta) first-class + FX to base + FatturaPA 22% VAT. Gap: **no discount modifier**, single flat tax rate (no multi-jurisdiction/reverse-charge). |
| Invoice Batch / PDF / Sequence | All (batch gen, PDF render, e-delivery, compliant numbering) | Yes | **yes** | Server-side gapless-under-lock numbering, batch from Ready queue, printable artifact, FatturaPA. Gap: in-memory counter (resets on restart), browser-print not server PDF, no templates/branding. |
| Subscription/Recurring w/ Proration & True-Up | Kantata, NetSuite, Certinia | Yes | **partial** | Monthly/Quarterly/Annual straight-line recognition over recurrence window. Gap: **no mid-period proration, no true-up, no recurrence start/end, no auto-invoice generation**. |
| Earned Value & Burndown (progress curves) | Projector, NetSuite | Yes | **no** | EAC/ETC/VAC + burn% exist, but **no PV/EV/AC, SPI/CPI, schedule variance, or burndown**. |
| Budget vs Actual w/ Alerts & Re-forecast | All (variance %, escalation, re-forecast) | Yes | **yes** | CR-aware budget vs actual; `burnOver`/`eacOverBudget`/margin-compression alerts with reasons. Gap: **screen-only** (no push/subscription), global thresholds, point-in-time. |
| Subcontractor / Vendor Mgmt (PO, 3-way match) | NetSuite, Projector, Mosaic, Runn | No/Yes | **partial** | POs as first-class order type → external cost; partners; subco task coverage check. Gap: **no goods-receipt/3-way match**, no vendor master, no PO approval, no subco settlement. |
| Project Costing & Allocation Engine | Projector (labor, burden, overhead, equipment) | Yes | **yes** | Per-project cost centers, rate-based labor (cost/bill rates), external PO cost, CR-adjusted budget. Gap: **no overhead/G&A burden engine**, single rate per resource (no dated rate cards). |
| Hierarchical / Conditional Approval Routing | All (amount thresholds, escalation, multi-level) | Yes | **partial** | Amount-threshold 2-step chain; per-step role enforcement. Gap: single threshold, no per-kind/project config, no designer. |
| Concurrent vs Sequential Approval | Certinia, NetSuite (parallel/sequential/OR) | No | **partial** | Sequential multi-step fully implemented + race-safe. Gap: **no concurrent/parallel/quorum mode**. |
| Audit Trail & Immutability (SOX/GDPR) | NetSuite, Certinia (immutable, full change history) | Yes | **partial** | Append-only (no update/delete path), before/after deltas, trusted-actor attribution, paged admin-only read. Gap: **no hash-chain/WORM**, best-effort (swallows failures), only `/api` mutations <400. |
| Segregation of Duties (SOD) | NetSuite, Certinia (no self-approval) | Yes | **yes** | Enforced in 3 flows (approval decision, time-entry, CR) on server-pinned principals. Gap: **no configurable conflict-of-duties matrix**, no indirect-conflict detection. |
| Project-Level Financial Statements (P&L) | NetSuite, Projector, Certinia | Yes | **yes** | Full per-project contribution P&L surfaced in project + contract roll-up. Gap: no fully-burdened net P&L, no closed-period/WIP balance, preview-only journal. |
| Customer Profitability & Concentration Risk | All (margin by customer, DSO trend, concentration %) | Yes | **yes** | `customerProfitability` + `customerConcentration` (real HHI, top-share) with risk-tinted KPIs + gauge. Gap: no CLV/retention, no overhead allocation, snapshot only. |
| Resource Profitability & Realization % | Kantata, Kimble, Projector | Yes | **partial** | `realizationMetrics` (realization %, revenue/FTE, revenue/head) at portfolio level; `resourceBillability` exists. Gap: **no per-resource table/ranking**, no billable split, no per-person margin. |
| BI Export / Ad-hoc / Drill-down | Runn, Forecast, Mosaic; Tableau/Power BI/Looker | Yes | **partial** | Hardened CSV export across reports (injection-guarded, RFC-4180). Gap: **JSON export not wired to UI**, no BI data feed/warehouse connector, no xlsx, no ad-hoc builder. |
| Custom Metrics & KPI Dashboards | Runn, Forecast (user-defined KPIs, thresholds) | No | **no** | KPIs hardcoded; no definition model/formula editor/targets. |
| Multi-Currency & FX | NetSuite, Certinia, Projector (spot rates, realized/unrealized FX) | Yes | **yes** | FX table keyed by currency + admin CRUD; `convertToBase` pervasive. Gap: **no dated/historical rates, no provider feed, no FX gain-loss, floats not decimals, single global base**. |
| Bank Feed & Cash Reconciliation | NetSuite, Sage Intacct | Yes | **no** | No bank entity, statement import, or reconciliation engine. |
| Dunning & Collections Automation | Kantata, Certinia, NetSuite | Yes | **partial** | Overdue exposure + aging + DSO computed/surfaced (reporting-only). Gap: **no dunning levels, reminders, escalation, promise-to-pay, worklist**. |
| Data Privacy & Retention (GDPR/RTBF) | Certinia, NetSuite | Yes | **no** | No DSAR/erasure/consent/PII-classification/retention. Audit retains PII indefinitely (a liability). |
| Skills Inventory & Proficiency & Certs | Kantata, Kimble, Projector | Yes | **yes** | Self-service skill CRUD (1-3 levels) + governed catalog (ESCO conceptUri, proficiency sets). Gap: **inconsistent scales (1-3 vs /5)**, free-text not validated to catalog, no cert/endorsement/recency. |
| Skill-Based Rate Cards | Projector, Kantata (rates by skill+proficiency) | Yes | partial | Bill/cost rate per resource; no rate-card library by skill+proficiency+period. |
| Equipment & Asset Tracking | NetSuite, Projector | No | **no** | No asset register/booking/depreciation. (Possibly intentionally out of scope for people-centric PSA.) |
| Anomaly Detection / Early Warning | Certinia (Einstein), NetSuite | No | **no** | Threshold alerts exist but no statistical/ML anomaly detection. |
| Persistence (real DB) | All enterprise (RDBMS-backed) | Yes | **yes** | _New row._ Dual Postgres/Drizzle + in-memory Repository pattern; 31 tables, migrations, seeding; `GET /storage-status`. Gap: dev defaults in-memory, money as float, forward-only migrations, no row-level multi-tenancy. |
| Real Authentication / SSO (OIDC + PKCE) | All enterprise (SAML/OIDC) | Yes | **yes** | _New row._ Keycloak OIDC + PKCE client; server JWKS `jwtVerify`. Gap: optional audience in dev, single realm, **no SAML/SCIM**, no token revocation/introspection, no MFA/step-up policy. |
| SCIM 2.0 / HRIS Sync | Workday, BambooHR, SuccessFactors | Yes | **no** | _New row._ No SCIM endpoint or HRIS connector; resources seeded/CRUD'd. |
| E-invoicing (FatturaPA / UBL / PEPPOL) | Certinia, NetSuite, IT/EU compliance | Yes | **partial** | _New row._ FatturaPA FPR12 XML builder (spec-tested). Gap: **no SDI transmission, no digital signature/PEC, no UBL/PEPPOL**, simplified flat 22% IVA. |

---

## 4. Remaining Gaps (prioritized — confirmed absent or partial in code)

Ordered by enterprise-deal impact. Each is verified as genuinely missing or partial.

1. **Live external integrations (vs local artifacts).** GL posting, e-invoice transmission (SDI/PEPPOL), and CRM sync all stop at a file/parked payload (`connected:false`). No network, credentials, chart-of-accounts mapping, acknowledgement/idempotency, retry queue, or reverse-sync. **No inbound CRM deal → auto-provision Contract+Project+billing plan.** _The single biggest commercial gap._
2. **Payments, cash application & collections/dunning.** Mark-paid is a status flip. No payment gateway, partial payments, remittance/cash matching, dunning levels/reminders/escalation, or bank feed/reconciliation. AR analytics feed no collections action.
3. **Performance obligations + posted ledger + period close.** No PObj/SSP/allocation model; recognition is per-line heuristic and the journal is preview-only (no posted GL, no period lock, no reversal/catch-up). Recognition schedule is currency-naive.
4. **True resource-scheduling Gantt + date-level conflict detection.** `Assignment` has no start/end dates, so no per-resource booking bars, drag-and-drop, or overlapping-booking detection — only aggregate util>110% flags.
5. **AI/ML matching & anomaly detection.** Scoring is static-weight deterministic; alerts are threshold-based. No learning loop, predictive risk/cost, optimal multi-request allocation, or statistical anomaly detection.
6. **Mobile & offline.** No PWA/service worker/native app/offline time-expense capture. Responsive CSS only.
7. **Client / partner portals.** Entirely internal; no external/guest auth scope or scoped self-service.
8. **SCIM 2.0 / HRIS sync.** No provisioning endpoint or connector to populate the people roster, rates, org, capacity.
9. **Multi-entity (legal entity) consolidation.** Multi-currency exists, but no company/legal-entity model, intercompany, per-entity ledgers, or entity-scoped numbering. FX has no dated rates or gain/loss.
10. **Ad-hoc BI / report & dashboard builder + custom KPIs.** Dashboards are fixed; no drag-drop builder, saved views, scheduled distribution, JSON/BI feed (JSON export exists but is unwired), or user-defined metrics.
11. **Active approval governance.** Engine lacks SLA escalation/reminders, delegation/out-of-office, parallel/quorum approval, configurable per-kind/per-project thresholds, and an admin workflow designer.
12. **GDPR / data privacy.** Zero implementation; append-only audit retains PII indefinitely with no purge path.
13. **Tamper-evident audit.** Append-only by convention only — no hash-chain/WORM/signing; best-effort writes; coverage limited to `/api` mutations <400 (no auth events).
14. **Accounting depth tail.** No discount modifiers, multi-jurisdiction tax engine, overhead/G&A burden allocation, EVM (SPI/CPI/burndown), recurring proration/true-up, dated rate cards, or document management (real file upload/versioning).
15. **Equipment / asset tracking.** Absent (may be intentional for a people-centric PSA).

---

## 5. Recommended Roadmap (revised 2026-06-12)

Most P0/P1 from the prior plan is done. The new frontier is **the outside world plus accounting depth**.

### NOW — connect to reality & take money
1. **Live GL/ERP posting** behind the existing adapter seam: real connector (REST/OData), chart-of-accounts + dimension mapping, posting acknowledgement + idempotency keys, posted-ledger persistence with period close. _Consumes the journal export we already emit._
2. **Payments + cash application**: payment gateway, partial payments, remittance matching, mark-paid → cash receipt; then **dunning/collections workflow** on the AR aging we already compute.
3. **Inbound CRM deal → project handoff**: Closed-Won → auto-provision Contract + Project + billing plan; field mapping; persisted (non-ephemeral) outbox with delivery/retry. _Makes forecasting pipeline real._
4. **Date-level scheduling**: add start/end to `Assignment`, build a per-resource timeline/Gantt with booking bars + overlap-conflict detection (the core leaders sell).

### NEXT — accounting depth & governance polish
5. **Performance-obligation model + SSP allocation + posted journals + period close** (true ASC 606 step 2-4); CR approval triggers revenue/recognition catch-up.
6. **E-invoice transmission**: SDI/PEC for FatturaPA, digital signature, plus UBL/PEPPOL BIS; credit-memo (TD04) flow.
7. **Dated multi-currency** (transaction/period-end rates, FX gain/loss) + **legal-entity model** for multi-entity consolidation.
8. **Active approval governance**: SLA escalation/reminders, delegation, parallel/quorum, configurable thresholds, designer UI; admin-configurable RBAC/SoD matrix.
9. **Tamper-evident audit** (hash-chain/WORM, guaranteed writes, auth-event coverage) + GDPR tooling (DSAR/erasure/retention) — paired since erasure complicates append-only audit.

### LATER — breadth, intelligence & reach
10. **AI/ML**: predictive match learning loop, anomaly/early-warning detection, probability-weighted pipeline.
11. **Mobile/offline PWA** (offline time/expense + sync queue) — gates field-services segment.
12. **Client/partner portals** (scoped self-service, white-label, external auth scope).
13. **SCIM 2.0 / HRIS sync**; **ad-hoc BI/report builder + custom KPIs + scheduled distribution + JSON/BI feed**; per-resource realization & rate-card library.
14. **Accounting tail**: discount modifiers, multi-jurisdiction tax engine, overhead/burden allocation, EVM (SPI/CPI/burndown), recurring proration/true-up, document management.

### Guiding principle (revised)
The "pure derivation over data we hold" era is **largely banked** — forecasting, AR aging, match scoring, rev-rec schedules, margin drill-down, what-if, approvals, and real auth/persistence all shipped. The remaining value is **structural and outward-facing**: live connectors, money movement, and accounting-grade ledgers. Sequence the external-integration long poles deliberately, because each (ERP posting, payments, e-invoice transmission, CRM ingestion) carries credentials, compliance, and reverse-sync complexity that the local-artifact seam deliberately deferred. This path moves us from "system of decision" to **"system of execution"** — acting in the customer's real financial and operational systems.
