# UI and application-logic audit — 2026-08-04

This register is the hand-off for the UI/UX and application-logic audit. It
records the observed failure mode, its severity, the remediation selected for
this branch, and any residual work that must remain visible to maintainers.

## Status legend

- **Fixed** — implemented in this branch and covered by a deterministic
  regression test or an explicit build/browser check.
- **In progress** — assigned to a remediation workstream in this branch; update
  this register before merge.
- **Guarded** — the unsafe behaviour is blocked or honestly labelled, but the
  full product capability requires a separate data-model/infrastructure change.
- **Backlog** — not safe to hide; proposed solution and acceptance criterion are
  recorded below.

## UI and UX findings

| ID | Severity | Finding / user impact | Remediation or hypothesis | Status |
|---|---|---|---|---|
| UI-01 | P0 | Navigation exposed pages the signed-in role could not use, while some valid roles lost additive capabilities. | Derive routes, navigation and dashboard cards from the same additive role-capability set used by authentication. | Fixed |
| UI-02 | P0 | Profile, assignment and time-entry screens could address another resource by changing a client id. | Introduce server-owned `/self` boundaries; derive the resource from verified identity and remove arbitrary ids from employee flows. | Fixed |
| UI-03 | P1 | Mobile navigation lacked focus containment, Escape handling, inert background and focus return. | Use a real modal drawer interaction with focus trap, ARIA state, Escape close and trigger-focus restoration. | Fixed |
| UI-04 | P1 | List pages projected loading/error/empty content inconsistently and could leave interactive content active beneath a state. | Centralize inert list-state projection and accessible loading/error messaging. | Fixed |
| UI-05 | P1 | Client date defaults used UTC and could select yesterday/tomorrow around the local midnight boundary. | Use one local-calendar date helper for form defaults and filters. | Fixed |
| UI-06 | P1 | Unhandled request/navigation failures could strand a page with no feedback. | Add global and navigation error handlers while preserving action-specific recovery messages. | Fixed |
| UI-07 | P2 | Repeated errors produced duplicate, unbounded toasts that overflowed narrow viewports. | De-duplicate notifications, cap the visible queue and constrain mobile width. | Fixed |
| UI-08 | P1 | Unknown routes/API fall-through could produce an SSR response-init failure instead of a usable 404. | Add an explicit soft-404 page and a final JSON `/api` 404 boundary. | Fixed |
| UI-09 | P1 | Project headers and dense tables overflowed small screens. | Stack headers, preserve action access and provide deliberate horizontal table scrolling. | Fixed |
| UI-10 | P1 | Row actions were hover-only and effectively unavailable on touch/keyboard. | Keep actions visible on mobile and on keyboard focus. | Fixed |
| UI-11 | P2 | Location rows behaved like buttons with pointer input only. | Add semantic keyboard activation and accessible state. | Fixed |
| UI-12 | P1 | Runtime fonts depended on external Google endpoints, causing CSP/privacy/offline failures. | Self-host the required font packages and remove remote font links. | Fixed |
| UI-13 | P1 | OIDC settings were browser-hardcoded and login lost the original deep link. | Load public issuer/client id at runtime and restore a validated same-origin route after login. | Fixed |
| UI-14 | P0 | Allocation submission could submit stale data because saving and submitting were independent actions. | Require save-before-submit, block dirty close and prune invalid selection after refresh. | Fixed |
| UI-15 | P1 | My Assignments exposed global ids and incomplete self-service mutations. | Use self endpoints and server-owned identity; align editing with day-level allocation commands. | In progress |
| UI-16 | P1 | Financial-plan create closed optimistically before persistence, losing entered values on failure. | Keep the dialog and values while pending/error; close only after success. | Fixed |
| UI-17 | P1 | Forecast committed demand included non-allocated states and placeholder resources inflated skill supply. | Count only allocated demand and exclude dummy resources from real skill supply. | Fixed |
| UI-18 | P1 | What-if accepted inverted/partial ranges and used positive colour for over-capacity. | Validate a complete ordered window and map utilization deltas to the correct risk tone. | Fixed |
| UI-19 | P1 | Project-rate roles came from currently staffed people and offered currencies the engine silently ignored. | Use the Project Role catalog and expose only supported base-currency rates. | Fixed |
| UI-20 | P1 | Form/nav ids contained whitespace, navigation search missed group labels and duplicate labels were ambiguous. | Generate valid slugs, search groups and disambiguate repeated entries. | Fixed |
| UI-21 | P2 | Integrations copy contained a hard-coded year and overstated the validity/connectedness of local artifacts. | Derive dates dynamically and label local previews and limitations explicitly. | Fixed |
| UI-22 | P1 | FatturaPA action appeared submission-ready despite placeholder customer fiscal data. | Rename it as a preview, explain missing master data and state that it must never be submitted as-is. | Guarded |

## Identity, authorization and persistence findings

| ID | Severity | Finding / failure mode | Remediation or hypothesis | Status |
|---|---|---|---|---|
| ID-01 | P0 | Time-entry collection/object authorization allowed horizontal access and server-owned approval fields could be forged. | Enforce collection and object scope per verb; derive links/owner; make approval fields immutable and Approved terminal. | Fixed |
| ID-02 | P0 | Change-request creator/state could be supplied by the client and invalid transitions were accepted. | Pin creator/requester/time, force Draft creation and enforce an explicit SoD-aware state machine. | Fixed |
| ID-03 | P1 | A GET route without a matching read rule defaulted open. | Exact public allow-list plus authenticated deny-by-default read authorization. | Fixed |
| ID-04 | P1 | OIDC realm roles were collapsed to one highest role, losing legitimate additive permissions. | Retain all recognized roles for authorization; keep one primary role only for display/audit. | Fixed |
| ID-05 | P1 | Username-to-resource fallback could collide and impersonate a similarly named person. | Require the verified resource claim or an explicit user-directory link; fail closed otherwise. | Fixed |
| ID-06 | P0 | Production could start without audience validation and accept a token minted for another realm client. | Require `OIDC_AUDIENCE` in production and configure the Keycloak audience mapper. | Fixed |
| ID-07 | P1 | Browser and container used the same issuer/JWKS URL, breaking real reverse-proxy/container deployment. | Separate public issuer, internal issuer and JWKS URI. | Fixed |
| ID-08 | P0 | Approval/month writes were split and a stale decision could commit against edited data. | Transaction + month advisory lock + approval revision/CAS; rotate approval on every governed edit. | Fixed |
| ID-09 | P0 | Invoice numbers were process-local, hard-coded to 2026 and duplicate under concurrent workers. | Per-year transaction advisory lock, persisted scan, unique DB index and annual rollover. | Fixed |
| ID-10 | P1 | Generic entity ids were based on a process-local counter and could collide across workers/restarts. | Use collision-safe identifiers while remaining compatible with existing prefixed ids. | In progress |
| ID-11 | P1 | Seed-if-empty bootstrap could interleave across replicas, partially seed data or inject demo data in production. | Transactional/idempotent bootstrap with an explicit production seed policy. | In progress |
| ID-12 | P1 | In-memory and PostgreSQL adapters did not enforce identical duplicate/FK/not-null behaviour. | Add adapter-contract tests and normalize domain validation before repository calls. | Backlog |
| ID-13 | P1 | Audit writes occur after the response and failures are swallowed; a successful mutation can have no trail. | Move security-relevant mutation + audit append into one transaction/outbox; expose audit delivery health. | Backlog |
| ID-14 | P1 | Rate limiting is process-local and middleware ordering spends anonymous capacity before identity is known. | Put the distributed limit at the trusted ingress/Redis and use verified principal + IP buckets after auth. | Backlog |
| ID-15 | P1 | Financial exports used inconsistent currency/time snapshots. | Normalize dated recognition and journals to base currency and derive export windows from source activity. | Fixed |
| ID-16 | P1 | FatturaPA used demo issuer/customer placeholders while appearing fiscally complete. | Enforce eligible order lifecycle and label artifact as a non-submission preview; add fiscal master data and XSD/SDI validation in a future fiscal-integration model. | Guarded |
| ID-17 | P1 | Self time submission is not an idempotent transactional command across all affected rows. | Add an idempotency key and transaction/advisory lock covering entries, submission state and approvals. | Backlog |
| ID-18 | P1 | Several APIs accepted `Date.parse`-compatible strings/partial updates without validating the fully merged record. | Use strict calendar-date validation and validate merged entities on PUT. | In progress |
| ID-19 | P1 | Unknown persistence adapter/configuration silently fell back to in-memory demo state. | Validate configuration at startup and fail closed in production. | In progress |

## Operational-domain findings

| ID | Severity | Finding / failure mode | Remediation or hypothesis | Status |
|---|---|---|---|---|
| OP-01 | P0 | Monthly allocation submit/edit/decision/withdraw could interleave and leave orphan approvals or stale decisions. | One transaction/lock per assignment-month with revision/CAS. | Fixed |
| OP-02 | P1 | Retargeting `requestId` on a populated assignment transfers approved/planned hours to another demand without reapproval. | Reject direct retarget when governed dependants exist; require a future explicit migration workflow. | In progress |
| OP-03 | P1 | Retargeting `resourceId` can move bookings and approval context to another person. | Same fail-closed retarget guard over days, months, time entries and approvals. | In progress |
| OP-04 | P1 | `assignedHours` was writable although assignment days are the source of truth. | Remove it from client commands and derive it after day-level writes. | In progress |
| OP-05 | P1 | `contractHoursPerDay` existed in the model but could not be safely maintained. | Allow-list and validate a positive finite optional override. | In progress |
| OP-06 | P1 | Bookings could be created before hire or after termination, then disappear from capacity views. | Validate every booking date/window against the resource employment interval. | In progress |
| OP-07 | P1 | Resource-request PUT checked only supplied fields and could create an invalid merged effort/status/date state. | Validate the complete merged entity and keep derived staffing fields server-owned. | In progress |
| OP-08 | P1 | Bespoke DELETE handlers sometimes returned 204 for missing ids or relied on adapter FK behaviour. | Normalize existence/conflict checks and adapter-contract tests for every destructive route. | Backlog |
| OP-09 | P1 | Process-local locks protected some aggregates only on a single Node worker. | Use DB advisory locks/transactions for governed commands; replace remaining aggregate counters with DB-derived/atomic updates. | Guarded |
| OP-10 | P1 | Compound writes and self-service retries could duplicate or partially commit. | Deterministic idempotency keys, transactions and compensating recovery. Commercial writes are fixed; self-time remains ID-17. | Guarded |
| OP-11 | P1 | Substituted hours can be misattributed when another pending substitution targets the same person/month. | Refuse a second unresolved substitution or model loans as a one-to-many ledger rather than overwriting one backlink. | Backlog |
| OP-12 | P1 | A terminated direct named manager could still match `approverId` even though accountable-manager discovery excluded them. | Apply the active-employment filter to the direct named-approver path too, with fallback routing. | Backlog |
| OP-13 | P1 | Substitution endpoint role-gated resource managers but did not prove the dummy/target were in their org scope. | Reuse the same accountable scope predicate used by approval decisions. | Backlog |
| OP-14 | P1 | Capacity/utilization divided hours across an unbounded horizon by one weekly capacity and then clamped, hiding magnitude. | Derive utilization per explicit week/month (peak and average) and keep over-capacity values visible rather than saturating at 100. | Backlog |
| OP-15 | P2 | Holiday/capacity setting edits retroactively changed historical feasibility. | Version capacity calendars and bind governed months to the version approved at decision time. | Backlog |
| OP-16 | P2 | Legacy assignment window/% and day-level allocation can drift and show contradictory schedules. | Make assignment days the only write model; derive the legacy projection or remove it after migration. | In progress |
| OP-17 | P2 | Dummy/subcontractor employment semantics are inconsistent across allocation and substitution paths. | Centralize kind-aware employment/capacity eligibility and apply it to every day-write command. | In progress |
| OP-18 | P2 | Server business date uses UTC, changing termination/approval eligibility around local midnight. | Introduce a validated `BUSINESS_TIME_ZONE` calendar-date helper and use it for business decisions. | Backlog |

## Commercial and financial findings

| ID | Severity | Finding / failure mode | Remediation or hypothesis | Status |
|---|---|---|---|---|
| CF-01 | P0 | Concurrent invoice generation could reuse a number and the year was hard-coded. | Annual transactional allocator + DB unique constraint. | Fixed |
| CF-02 | P1 | Generated billing invoices created an Order without a project-attribution OrderLine. | Create deterministic order + line atomically and recover/replay the pair idempotently. | In progress |
| CF-03 | P1 | Billing lifecycle fields were freely writable through generic CRUD. | Server-owned lifecycle commands; ordinary create/update accepts business fields only. | In progress |
| CF-04 | P1 | Marking a billing item Paid did not update its linked Order. | Atomic mark-paid command updates both records and records paid date. | In progress |
| CF-05 | P1 | Credit notes produced negative TD01 invoice XML. | Keep the negative domain amount, emit TD04 and positive FatturaPA document amounts. | Fixed |
| CF-06 | P1 | Contract/order enum and required-field validation differed between direct, compound and persistence adapters. | One merged domain validator shared by POST/PUT/compound paths. | Backlog |
| CF-07 | P1 | Commercial deletes could leave dependants or differ between memory/PostgreSQL. | Explicit dependency checks/cascading policy and consistent 404/409 semantics. | Backlog |
| CF-08 | P1 | OrderLine could reference a project on another contract and generated line totals could diverge from Order amount. | Validate order→contract→project and reconcile generated line sum to customer-facing order amount. | In progress |
| CF-09 | P1 | Partial commercial updates validated date order on the patch rather than the merged record. | Strict merged validation for contract/order/billing date ranges. | In progress |
| CF-10 | P1 | Revenue-recognition schedules and journals added mixed nominal currencies. | Convert each movement and cap to base currency before scheduling/posting. | Fixed |
| CF-11 | P1 | Multiple active T&M conditions recognized the same approved hours repeatedly. | Gate on realized status and assign one deterministic owner per project/contract scope, preferring project specificity. | Fixed |
| CF-12 | P1 | Expense markup was stored but ignored by recognition, aging and invoice totals. | Use one customer-facing amount (`amount × (1 + markup)`) across commercial and finance paths. | In progress |
| CF-13 | P1 | Project-rate UI sourced roles from people and allowed unsupported currencies. | Catalog roles + supported base currency only. | Fixed |
| CF-14 | P1 | Forecast treated Draft/Rejected assignments as committed and dummy supply as staffed capability. | Allocated-only committed demand and real-resource skill supply. | Fixed |
| CF-15 | P1 | What-if allowed partial/inverted date windows. | Complete ordered range validator. | Fixed |
| CF-16 | P1 | FatturaPA export accepted Purchase/Open orders. | Adapter and UI eligibility restricted to Invoiced/Paid Customer orders. | Fixed |
| CF-17 | P1 | Customer country display name fell back to `IT` and was written as `Comune`. | Resolve the ISO code from the country catalog and never use country name as city. | Fixed |
| CF-18 | P2 | Forecast KPI compared total demand to weekly supply. | Bind risk to peak weekly demand on the same time grain. | Fixed |
| CF-19 | P2 | Over-capacity what-if deltas were rendered as positive. | Risk-aware tone mapping. | Fixed |
| CF-20 | P1 | Invoice due date could differ between UI, aging and generated lifecycle. | Derive and persist due date server-side from issue date + payment terms. | In progress |
| CF-21 | P1 | Financial-plan dialog discarded values before persistence result. | Pending/error state and success-only close. | Fixed |
| CF-22 | P2 | Integration copy embedded a fixed 2026 assumption and overstated artifact validity. | Dynamic date copy and explicit preview semantics. | Fixed |

## Exit criteria for this branch

1. Every **P0** is Fixed with a red-to-green regression.
2. Every implemented **P1** has targeted tests; remaining P1 entries are retained
   here with an owner-ready acceptance criterion rather than hidden.
3. Full unit/component suite, lint, browser/SSR build and desktop/mobile smoke
   checks pass from a clean checkout with the required Node version.
4. PostgreSQL migration metadata has no drift; the absence of a live local
   PostgreSQL migration run is stated in the pull request when applicable.
5. Two independent reviewers compare the final diff to project standards and
   functional/spec documentation before the branch is pushed.
