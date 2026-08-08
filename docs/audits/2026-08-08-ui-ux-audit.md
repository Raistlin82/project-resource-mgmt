# UI/UX audit — 2026-08-08

> **Historical snapshot.** Audited against `main` at `2255b092b65d37c0678442b6a83828e0414f2293`
> with a clean tree. It records what was true on that date. The code and
> [`docs/`](../README.md) are authoritative for current behaviour; this file is
> the **finding register** and the remediation ledger against it.

**Method.** In-app browser on the local runtime, Demo Admin role, desktop
≈1280×720 and mobile 390×844, plus a parallel static read of information
architecture, states, forms, responsive behaviour, semantics, focus and
accessibility. 49 static application routes exercised — 49/49 served the Angular
app, so no deep-link defect was confirmed. No approval, assignment, invoice,
payment, deletion or import was actually submitted.

**Result.** No P0. **53 confirmed findings: 24 P1, 26 P2, 3 P3**, plus **5 risks
to validate** with a real screen reader, forced colors, or 400% zoom.

The urgent ones are not cosmetic. They are: a desktop container that can make the
main content disappear after scrolling the sidebar; modals that can be clipped
and do not truly isolate the app behind them; two approval experiences where the
record's identity and the action end up far apart; states and KPIs that present
unloaded data, unlinked accounts and non-existent records as empty-or-healthy;
and operational flows that allow incoherent transitions without a barrier.

| Priority | Meaning |
| --- | --- |
| **P1** | blocks or badly compromises a main flow, shows a false state, is a high-risk action, or is a significant accessibility barrier |
| **P2** | significant friction with a workaround, a structural inconsistency, or a bounded accessibility risk |
| **P3** | a clarity or polish defect with contained impact |

> **On the screenshots.** The audit's evidence images live outside this
> repository (under the auditing agent's own workspace) and will not survive.
> Each finding below therefore carries its **file:line evidence**, which does
> survive and is what a fix is written against. Where a screenshot was the only
> evidence, the finding says so.

---

## Remediation ledger

Work landed against this register lives on `codex/ui-ux-audit-remediation`.
**This table is the authoritative status** — a finding is only `done` when a test
asserts it, in both directions where that is meaningful.

| Status | Meaning |
| --- | --- |
| `done` | implemented **and** either pinned by a test, or verified in the browser at the audit's own viewport with the measurement recorded |
| `partial` | implemented, or partly implemented, with no test that would catch a regression |
| `open` | not started |

See [§ Coverage against the inherited work](#coverage-against-the-inherited-work)
for how each ID currently stands.

---

## P1

### UIUX-001 — The desktop shell has two competing scroll models

**Evidence.** Browser + code. `body` grows to ≈3143px while `main` stays 720px
tall; after scrolling to the user controls the content is off-screen.
[`app.ts:101`](../../src/app/app.ts), the sidebar at `app.ts:166`, `main` at
`app.ts:341`, scroll policy at [`styles.css:514`](../../src/styles.css).

**Impact.** An ordinary action on the sidebar makes the main workspace look empty.

**Proposed fix.** Constrain the desktop shell to `100dvh`; body not scrollable;
the nav gets its own scroller with a sticky user footer; **one scroll owner per
breakpoint**.

### UIUX-002 — Modals are fixed inside a transformed ancestor, and the background stays live

**Evidence.** Browser + code. The Billing modal loses its title and close control
under the shell and creates two scrollers; the sidebar stays `inert=false`, has no
`aria-hidden`, and remains interactive. The reveal animation leaves a persistent
`transform` on every page child, which creates a containing block and stacking
context for `fixed` descendants. [`styles.css:1368`](../../src/styles.css),
[`billing.ts:446`](../../src/app/commercial/billing/billing.ts),
[`modal-dialog.directive.ts:32`](../../src/app/directives/modal-dialog.directive.ts).

**Impact.** Critical forms clipped, ambiguous scrolling, and a usable background
while the dialog declares `aria-modal=true`.

**Proposed fix.** Mount the overlay under `body`, above the shell; make siblings
genuinely `inert`; lock body scroll; one internal scroller; sticky dialog
header/footer; remove the persistent ancestor transform.

### UIUX-003 — The Approvals inbox separates identity from decision

**Evidence.** Browser + code. `min-w-[960px]` table at
[`approvals.ts:152`](../../src/app/approvals/approvals.ts); the actions sit in the
last column at `approvals.ts:238`.

**Impact.** On mobile the user approves or rejects without seeing the row's
reference or project.

**Proposed fix.** A responsive card per request, or sticky identity and actions;
note and decision in the same block; a named confirm summary.

### UIUX-004 — Allocation Approvals hides months and actions behind an extreme pan

**Evidence.** Browser + code. A very wide filter bar at
[`allocation-approvals.component.ts:136`](../../src/app/allocation-approvals/allocation-approvals.component.ts),
a horizontal grid of nine months with Actions at `:276`.

**Impact.** A monthly approval needs a lot of vertical and horizontal scrolling,
and loses the resource name and the month on the way.

**Proposed fix.** Mobile card/accordion per resource, one month or a small range
at a time, sticky Resource and Actions, collapsible secondary filters.

### UIUX-005 — Search implements two invisible modes

**Evidence.** Runtime + code. Resources/Requests wait for Enter while the other
sections are live —
[`search.component.ts:23`](../../src/app/search/search.component.ts) — and the UI
offers only an input, `:143`.

**Impact.** Results that exist appear not to.

**Proposed fix.** One behaviour with debounce, or an explicit submit, a persistent
label, helper text, and a live status with the count and which sections are still
pending.

### UIUX-006 — An anonymous visitor inherits the `employee` information architecture

**Evidence.** Code. Absent claims produce the employee role
([`auth.service.ts:108`](../../src/app/services/auth.service.ts)); a failed IdP
still sets readiness (`:241`); the menu and guards expose operational paths
([`app.ts:490`](../../src/app/app.ts),
[`role.guard.ts:110`](../../src/app/guards/role.guard.ts)).

**Impact.** The app looks authenticated and then produces 401s or an "account not
linked" diagnosis.

**Proposed fix.** Null capabilities for anonymous, `isAuthenticated` in the
guards, and a landing page with Sign in.

### UIUX-007 — An account with no `resource_id` is shown as "no assignments"

**Evidence.** Code. My Assignments resolves an empty list with no claim
([`my-assignments.component.ts:437`](../../src/app/my-assignments/my-assignments.component.ts))
and renders zero KPIs and an empty state (`:110`).

**Impact.** A provisioning error is mistaken for a genuine absence of work.

**Proposed fix.** A discriminated "account not linked" state, with no KPIs or
calendar, and an administrative escalation.

### UIUX-008 — The dashboard omits Published demand that is still uncovered

**Evidence.** Runtime + code. The dashboard counts a different set from Staffing
and Reporting:
[`dashboard.component.ts:1059`](../../src/app/dashboard/dashboard.component.ts),
[`staffing.component.ts:592`](../../src/app/staffing/staffing.component.ts),
[`reporting.ts:1405`](../../src/app/reporting/reporting.ts).

**Impact.** The command center says 0 requests while residual demand exists.

**Proposed fix.** One shared domain predicate for "workable request"
(`Open || Published`, residual > 0) and a cross-screen test.

### UIUX-009 — "Future availability" includes months already past

**Evidence.** Runtime + code. Staffing shows April–September on 8 August 2026;
the window starts at the oldest Open period
([`staffing.component.ts:906`](../../src/app/staffing/staffing.component.ts),
[`server.ts:4163`](../../src/server.ts)).

**Impact.** History presented as forecast, influencing a staffing decision.

**Proposed fix.** Start at `max(current month, first open period)`, or rename it
"selected planning window".

### UIUX-010 — The Staffing proposal has no coherent validation

**Evidence.** Runtime + code. The form accepts 150%, negative values, inverted
dates and already-expired ranges
([`staffing.component.ts:438`](../../src/app/staffing/staffing.component.ts),
handler at `:1144`).

**Impact.** The error is deferred to the server, or the proposal is backdated.

**Proposed fix.** A FormGroup, 0–100 bounds, ordering and past-date rules, inline
errors, and API parity.

### UIUX-011 — A time entry outside the assignment window

**Evidence.** Runtime + code. A booking that ended 30 June proposes 8 August and
Submit stays enabled
([`my-assignments.component.ts:319`](../../src/app/my-assignments/my-assignments.component.ts),
submit at `:823`); the API validates only ISO format and positive hours
([`server.ts:2486`](../../src/server.ts)).

**Impact.** Actuals and invoicing outside the period.

**Proposed fix.** Assignment/request range, a future-date policy and a daily
maximum, in the UI **and** the API.

### UIUX-012 — A non-existent project id is presented as a healthy project

**Evidence.** Runtime + code. The title reads "Loading..." while the tabs, "On
Track" and zeroed KPIs stay mounted
([`project-details.ts:52`](../../src/app/projects/project-details/project-details.ts),
resource at `:532`).

**Impact.** A 404 is mistaken for a real project with no risks and no cost.

**Proposed fix.** A primary loading/error/not-found state; child panels only
after the project resolves.

### UIUX-013 — A new Order can be created already Invoiced or Paid

**Evidence.** Runtime + code. Initial options at
[`orders.ts:184`](../../src/app/commercial/orders/orders.ts), payload at `:294`,
permissive API at [`server.ts:5948`](../../src/server.ts).

**Impact.** The invoice/payment cycle is bypassed with no document and no
accounting date.

**Proposed fix.** Creation limited to Open/Confirmed; a separate, privileged
historical-import workflow.

### UIUX-014 — Issuing an invoice and recording payment are one-click

**Evidence.** Runtime + code. Table controls at
[`billing.ts:399`](../../src/app/commercial/billing/billing.ts), automatic
timestamps at `:1532` and `:1604`.

**Impact.** A misclick and a wrong accounting date, with no visible correction
path.

**Proposed fix.** A review dialog naming the record and amount, an effective
date, a reference, a pending guard, and an audited corrective operation.

### UIUX-015 — The Reporting period looks global but drives only part of the report

**Evidence.** Runtime + code. The control at
[`reporting.ts:116`](../../src/app/reporting/reporting.ts); `period()` feeds only
a few windows, `:1035`.

**Impact.** KPIs, tables and exports are read as being for the chosen period when
they are not.

**Proposed fix.** Apply the period to every dataset and artifact with an as-of
date, or rename it "Trend comparison window".

### UIUX-016 — Four reports promise distinct artifacts and download the same CSV

**Evidence.** Code. Every row calls the same handler
([`reporting.ts:479`](../../src/app/reporting/reporting.ts)), which always builds
`Reporting_Summary.csv`, `:1822`; "Last Generated" is hardcoded, `:1782`.

**Impact.** Output that does not match the choice, and lost trust.

**Proposed fix.** Report ids with dedicated generators and a real history; or one
"Export summary" action with the unimplemented rows disabled.

### UIUX-017 — The Reporting export is available during loading and error

**Evidence.** Code. "Export Report" has no guard
([`reporting.ts:122`](../../src/app/reporting/reporting.ts)) while the XLSX
exports do, `:131`.

**Impact.** A zero/empty fallback exported as trustworthy data.

**Proposed fix.** Disable on loading and error, and put the period / as-of date in
the artifact.

### UIUX-018 — CSV uploads are exposed but not implemented

**Evidence.** Code. Availability
([`maintain-availability-data.component.ts:19`](../../src/app/configuration/maintain-availability-data.component.ts),
dead end at `:92`); Skills
([`manage-skills.component.ts:19`](../../src/app/configuration/manage-skills.component.ts),
dead end at `:300`).

**Impact.** The user picks a local file and lands on "not available yet".

**Proposed fix.** Hide or disable up front with "Coming soon", or implement
preview, validation, confirmation and import.

### UIUX-019 — Loading, error and empty collapse into one state

**Evidence.** Code, across several families:
[`auth-gated-resource.util.ts:40`](../../src/app/services/auth-gated-resource.util.ts),
[`projects.ts:125`](../../src/app/projects/projects/projects.ts),
[`allocation-calendar.component.ts:120`](../../src/app/allocation-calendar/allocation-calendar.component.ts),
[`contract-details.ts:1065`](../../src/app/commercial/contract-details/contract-details.ts),
[`orders.ts:94`](../../src/app/commercial/orders/orders.ts).

**Impact.** A false "no data", a blank page, or a form with empty lookups — and no
Retry.

**Proposed fix.** A discriminated state model / mandatory `ListState` for the
primary resource and its dependencies; empty only after the read resolves.

> This is the register's own restatement of a defect class this repository has
> paid for repeatedly — see [`blind green gates`](#) in the project notes. An
> `error → empty` accessor is banned by convention precisely because it renders
> a failure as a fact.

### UIUX-020 — The dirty/pending lifecycle is not uniform across CRUD

**Evidence.** Code. Resources, Projects, Requests, Contracts, Customers and Skill
Catalog share no coherent state machine:
[`resources.component.ts:1064`](../../src/app/resources/resources.component.ts),
[`projects.ts:445`](../../src/app/projects/projects/projects.ts),
[`resource-requests.component.ts:753`](../../src/app/resource-requests/resource-requests.component.ts).

**Impact.** Escape / backdrop / Cancel lose the draft; some saves accept a double
click.

**Proposed fix.** A shared `pristine/dirty/saving/error/saved` primitive, a
dismiss confirm, dismiss blocked while saving, and create idempotency.

### UIUX-021 — Tables with no pan-port clip columns and actions

**Evidence.** Code. Global `nowrap`
([`styles.css:1188`](../../src/styles.css)) plus `overflow-hidden` cards with no
`overflow-x-auto`:
[`project-tasks.ts:80`](../../src/app/projects/project-tasks/project-tasks.ts),
[`manage-rate-cards.component.ts:53`](../../src/app/configuration/manage-rate-cards.component.ts),
[`manage-cost-centers.component.ts:28`](../../src/app/configuration/manage-cost-centers.component.ts).

**Impact.** Actual loss of content and function at 320px or under zoom.

**Proposed fix.** A standard pan wrapper with an intentional min-width and a named
region; responsive cards for operational records.

### UIUX-022 — Invalid forms become dead ends with no explanation

**Evidence.** Code. Configuration CRUD disables Save with no required markers and
no errors, e.g.
[`manage-industries.component.ts:91`](../../src/app/configuration/manage-industries.component.ts),
[`manage-cost-centers.component.ts:101`](../../src/app/configuration/manage-cost-centers.component.ts);
same pattern on Request and Order dates.

**Impact.** Correction by trial and error, and a hard barrier for assistive
technology.

**Proposed fix.** Visible and programmatic `required`, `markAllAsTouched`, inline
and cross-field errors, focus to the first error — and never `disabled` as the
only validation.

### UIUX-023 — Publish/Withdraw on a request are immediate transitions

**Evidence.** Code. Actions at
[`resource-requests.component.ts:243`](../../src/app/resource-requests/resource-requests.component.ts),
handler at `:789`.

**Impact.** Even a Fulfilled request can be withdrawn without showing the
consequences for its assignments.

**Proposed fix.** A named transition dialog with the status, the residual and the
assignments; API rules, pending state and feedback.

### UIUX-024 — Critical actions carry too little record context

**Evidence.** Code. Project cards repeat "Edit/Delete project"
([`projects.ts:113`](../../src/app/projects/projects/projects.ts)) and the confirm
does not repeat the name or id; Approvals repeats "Approve/Reject this request"
([`approvals.ts:242`](../../src/app/approvals/approvals.ts)).

**Impact.** Deleting or deciding on the wrong row, especially with a screen reader
or voice control.

**Proposed fix.** Name, id, reference and requester in the accessible name and in
the confirm; a dependency summary for delete.

---

## P2

| ID | Finding | Evidence | Proposed fix |
| --- | --- | --- | --- |
| **UIUX-025** | Project tabs are neither discoverable nor semantically tabs — ten buttons in a pan with a hidden scrollbar, no `aria-selected`, no panel relationship, no arrow keys | [`project-details.ts:138`](../../src/app/projects/project-details/project-details.ts), CSS at `:510` | Child routes, or the full ARIA tabs pattern; an overflow cue or a More menu |
| **UIUX-026** | Two competing architectures for the Project sub-domains — Tasks, Issues, Documents, Plans, Partners and finance are both global routes and detail tabs | [`app.routes.ts:62`](../../src/app/app.routes.ts), [`project-details.ts:480`](../../src/app/projects/project-details/project-details.ts) | Canonical child routes; global ones only for explicit cross-project registers |
| **UIUX-027** | Query, tab, project and period are not serialized in the URL | [`search.component.ts:369`](../../src/app/search/search.component.ts), [`project-details.ts:817`](../../src/app/projects/project-details/project-details.ts), [`reporting.ts:1040`](../../src/app/reporting/reporting.ts) | Query params and child routes kept in sync |
| **UIUX-028** | Primary titles and identifiers are truncated | [`projects.ts:55`](../../src/app/projects/projects/projects.ts), [`project-details.ts:55`](../../src/app/projects/project-details/project-details.ts) | Wrap / `overflow-wrap:anywhere` for the h1; clamp with an accessible disclosure on cards; retune breakpoints |
| **UIUX-029** | The Resource Request form does not announce its expansion — focus stays on the trigger, no `aria-expanded`/`aria-controls`; localized date inputs sit next to ISO rows | [`resource-requests.component.ts:60`](../../src/app/resource-requests/resource-requests.component.ts) | Move and announce focus; unify the date format |
| **UIUX-030** | Staffing has nested scrollers and no pre-Assign warning for a poor fit | [`staffing.component.ts:386`](../../src/app/staffing/staffing.component.ts), `:461` | One primary scroller; a warning/confirm with an explicit reason — not an absolute block, since the override is sometimes legitimate |
| **UIUX-031** | "Active Assignments" actually means "not Rejected" — historical bookings included | [`my-assignments.component.ts:549`](../../src/app/my-assignments/my-assignments.component.ts) | A current-period filter, or relabel it lifetime / non-rejected |
| **UIUX-032** | Admin navigation is too dense and mixes ownership — 48 entries whose groups mix a personal workspace with organisational registers | [`app.ts:486`](../../src/app/app.ts) | A separate "My workspace"; Configuration grouped by catalogues, organisation, finance, integrations |
| **UIUX-033** | "Approvals" and "Allocation Approvals" compete — same icon, same ownership, different groups | [`app.ts:498`](../../src/app/app.ts), `:534` | "Workflow Inbox" and "Monthly Allocation Approval" in one domain, or a drill-down |
| **UIUX-034** | Sidebar KPIs are not investigable and not capability-consistent — RISK/CR are static divs, visible more widely than the routes they refer to | [`app.ts:200`](../../src/app/app.ts) | Capability-gate them, expand the labels, link to filtered views — or remove them |
| **UIUX-035** | The dashboard promises the same command center to every role, then some roles get "My workspace" and unavailable data | [`dashboard.component.ts:125`](../../src/app/dashboard/dashboard.component.ts) | Role-aware h1 and copy, or distinct homes |
| **UIUX-036** | Configuration shares no page shell or outline — several routes start at h2, padding and widths vary | [`set-default-language.component.ts:12`](../../src/app/configuration/set-default-language.component.ts), [`manage-skills.component.ts:17`](../../src/app/configuration/manage-skills.component.ts) | A `ConfigurationPageShell` with eyebrow, h1, subtitle, actions and body |
| **UIUX-037** | Reporting is long and semantically flat — h3 for KPIs and macro-sections after the h1, no h2, no local navigation | [`reporting.ts:209`](../../src/app/reporting/reporting.ts), `:466` | h2 per domain, plain-text KPI labels, local nav / anchors |
| **UIUX-038** | The Reporting header is compressed and its language is mixed — on desktop the select shows little but its chevron; four controls compete in one row; Italian labels sit in an English UI | [`reporting.ts:116`](../../src/app/reporting/reporting.ts) | A select min-width, wrap or an overflow menu, a coherent locale policy |
| **UIUX-039** | Billing and Contract Details apply double padding | [`app.ts:356`](../../src/app/app.ts), [`billing.ts:115`](../../src/app/commercial/billing/billing.ts) | Padding in the shell only; a responsive action group |
| **UIUX-040** | Essential actions are hidden behind hover on touch tablets — `sm:opacity-0 sm:group-hover` in Reporting, Project Plans, Documents, Profile | [`reporting.ts:497`](../../src/app/reporting/reporting.ts) | Hide only under `(hover:hover) and (pointer:fine)`, or keep them always visible |
| **UIUX-041** | Orientation is inconsistent across detail pages — Project has a back icon only, Contract a text link, neither a breadcrumb | [`project-details.ts:46`](../../src/app/projects/project-details/project-details.ts), [`contract-details.ts:76`](../../src/app/commercial/contract-details/contract-details.ts) | A `Parent / Record` breadcrumb; keep back-history separate |
| **UIUX-042** | Focus is unmanaged after SPA navigation — `NavigationEnd` resets scroll only; the drawer closes without moving focus to the new h1/main | [`app.ts:447`](../../src/app/app.ts) | Focus the title/main and announce the page title, distinguishing internal navigations |
| **UIUX-043** | The focus indicator is weak in dark mode and removed on the Project card — composite ring ≈2.3–2.6:1; the card link uses `focus:outline-none` | [`styles.css:411`](../../src/styles.css), [`projects.ts:68`](../../src/app/projects/projects/projects.ts) | An opaque token ≥3:1 on every surface, and no suppression without a replacement |
| **UIUX-044** | Timed toasts cannot be paused — success/info 5s, error 12s, no pause; repeated dismisses share one accessible name | [`notification.service.ts:47`](../../src/app/services/notification.service.ts), [`app.ts:367`](../../src/app/app.ts) | Persistent errors or a notification center; pause on hover/focus; the message in the name; focus recovery |
| **UIUX-045** | Resources errors are not associated with their fields — `aria-invalid` is present, the messages have no id and no `aria-describedby` | [`resources.component.ts:201`](../../src/app/resources/resources.component.ts) | A stable id and a conditional `aria-describedby` |
| **UIUX-046** | "No data" and "no match" are indistinguishable — `filtered.length === 0` treated as a real empty; Orders leaves only the headers | [`manage-industries.component.ts:59`](../../src/app/configuration/manage-industries.component.ts), [`projects.ts:125`](../../src/app/projects/projects/projects.ts), [`orders.ts:94`](../../src/app/commercial/orders/orders.ts) | Separate source-empty from filtered-empty, echo the query, offer Clear filters |
| **UIUX-047** | Reject takes no reason and no confirmation — the note is optional and submission is immediate | [`approvals.ts:233`](../../src/app/approvals/approvals.ts), handler at `:525` | A mandatory reason for Reject and a contextual confirm; an undo if quick-approve is intentional |
| **UIUX-048** | Integrations on mobile compresses technical titles and badges — some cards measure `scrollWidth` 393–395px in 345px available, and "Not connected" is clipped; the new section's header is a non-responsive flex row | [`integrations.component.ts:274`](../../src/app/configuration/integrations.component.ts) | `flex-col`/wrap below `sm`, `min-w-0`, `overflow-wrap:anywhere`, the badge on its own line |
| **UIUX-049** | Changing the default language applies immediately — an important notice, and a button with no confirm, pending or error state | [`set-default-language.component.ts:15`](../../src/app/configuration/set-default-language.component.ts), handler at `:61` | A named confirmation, a pending guard, explicit feedback |
| **UIUX-050** | Scrollable tables do not signal that the actions are far away — Resources and several commercial tables pan, but neither the name nor Actions is sticky | [`resources.component.ts:101`](../../src/app/resources/resources.component.ts) | Responsive cards, or sticky identity/actions; an edge fade or scroll hint at minimum |

---

## P3

| ID | Finding | Evidence | Proposed fix |
| --- | --- | --- | --- |
| **UIUX-051** | The route is "My Profile", the h1 is "My Project Experience" | [`app.ts:492`](../../src/app/app.ts), [`my-profile.component.ts:20`](../../src/app/my-profile/my-profile.component.ts) | h1 "My Profile", with Project Experience as a section |
| **UIUX-052** | "Export to Spreadsheet" produces a CSV | [`service-organization-details.component.ts:14`](../../src/app/configuration/service-organization-details.component.ts), `:81` | Label it "Export CSV", or generate a real XLSX |
| **UIUX-053** | Dashboard financial KPIs are too dense on a laptop — seven columns already at `xl` | [`dashboard.component.ts:227`](../../src/app/dashboard/dashboard.component.ts) | 4+3 up to `2xl`, or `auto-fit/minmax` |

---

## Risks to validate — NOT declared as confirmed defects

These need a real screen reader, forced colors, a device, or 400% zoom. They are
listed so they are not lost, and deliberately **not** counted among the 53.

| ID | Priority | To validate |
| --- | --- | --- |
| **AT-01** | P2 | Tab / Shift+Tab cycling, focus restore when the trigger disappears, nested dialogs. The directive has a trap and restore; the browser Tab test was not conclusive. |
| **RESP-01** | P2 | Reflow at 320 CSS px and 400% zoom for the fixed header/form grids in Rate Cards, Resources, Tasks and Issues. |
| **TARGET-01** | P3 | Real hit-boxes of the 14px remove-chips and the 18px toast dismiss; check the WCAG 2.5.8 spacing exception. |
| **MOTION-01** | P3 | The Allocation Calendar's `scrollIntoView({behavior:'smooth'})` may not honour reduced-motion. |
| **CONTRAST-01** | P2 | Forced colors and computed colours of placeholders, scrollbars, hairline borders and the focus ring on real browsers and OSes. |

---

## Findings NOT retained

Recorded because a discarded finding is as useful as a kept one — it stops the
next audit re-raising it.

- **The supposed Reporting deep-link failure** was an artifact of a server
  running against `dist` chunks from before a rebuild. After a restart, 49/49
  routes opened correctly. Not a product defect.
- **Search cards appeared to have no spacing** in a static read, but at 390px the
  borders and hierarchy are legible. Not retained; it stays subordinate to a
  future multi-breakpoint visual regression.
- **The mobile drawer behaves well overall**: `inert` main, focus trap, Escape,
  scroll lock, and a reachable user footer.

---

## Strengths

Worth keeping in the register, because a remediation that breaks one of these has
made things worse.

- Dashboard and base Billing reflow well into a single mobile column.
- The mobile drawer is legible and has good keyboard/focus primitives.
- `ListStateComponent` offers a live loading state, error + Retry, and keeps
  focus — the problem is that its coverage is still incomplete.
- Charts have accessible names and an alternative data table; Schedule has a
  keyboard alternative to drag.
- Solid-fill tokens and contrast tests already exist; reduced-motion is global.
- Resource Request delete and Skill Catalog delete already have named confirms
  that describe the consequences — good patterns to extend.
- The Allocation Calendar already has a dirty-state confirm.
- The new Integrations section is honest about "Not connected" and does not fake
  external actions.
- 404 and deep links are solid.

---

## Recommended sequence

1. **Layout containment:** UIUX-001, 002, 003, 004, 021.
2. **Truth of state:** UIUX-005–009, 012, 015–019.
3. **Operational guardrails:** UIUX-010, 011, 013, 014, 020, 022–024.
4. **IA, responsive and structural accessibility:** UIUX-025–045.
5. **Clarity and polish:** UIUX-046–053.

For each group: land a focused regression test first (component/integration, plus
at least one mobile visual), implement, then verify desktop 1280, mobile 390, and
320/zoom for the components involved.

---

## Limits of this audit

- Local seed and the Demo Admin role; no full matrix of employee, PM, RM, sales
  and finance.
- No real screen reader, forced colors, iOS/Android, or a second browser.
- No complete fault injection; the deterministic error/empty states were verified
  mostly from the code.
- No destructive or financial action was submitted.
- **This is not a statement of WCAG conformance.**

---

## Coverage against the inherited work

Measured, not read off commit messages. `code` and `spec` are lines changed
(added + removed) across the files each finding cites as evidence, between `main`
at `2255b09` and the remediation tip.

**Every one of the 53 findings has had its cited code touched, and 52 of 53 have
had their spec touched too.** That is a real signal of breadth — and it is NOT
evidence that a finding is fixed.

**Why every row below says `partial` and not `done`.** No spec in the repository
names a finding id, so there is no traceable link between a test and the defect it
is supposed to pin. Churn is a proxy: it tells you a file changed, not that the
behaviour the audit described has stopped happening, and not that a regression
would be caught. Marking these `done` on the strength of a diffstat would be the
project's signature defect — a green gate that no data exercises — applied to its
own audit.

**Promoting a row to `done` takes one of two things**: a test that names the
finding id and fails when the fix is reverted, or a browser verification at the
viewport the audit used, recorded here. Anything less stays `partial`.

| ID | code | spec | Status | Note |
| --- | ---: | ---: | --- | --- |
| UIUX-001 | 406 | 320 | `done` | **verified in browser at 1280×720.** `body.scrollHeight` 720 (was ≈3143), document not scrollable, `main` 720 tall with its own `overflow-y:auto` scroller (content 5711). Defect scenario re-run: scrolling the sidebar nav to its end moves `window.scrollY` by 0 and leaves `main` at top 0, height 720 — one scroll owner |
| UIUX-002 | 512 | 354 | `done` | **verified in browser at 390×844.** Dialog occupies 0,0,390,844 — not clipped; heading "New Billing Condition" and close control both visible; `aria-modal=true`; **sidebar `inert`**; `body` overflow `hidden`; exactly **1** scroller inside the dialog (was two). Residual, honest: `aria-hidden` is not also set, and `main` is not inert — the dialog lives inside it, so that is correct rather than missing. Tab-cycle containment stays **AT-01** |
| UIUX-003 | 319 | 192 | `done` | **verified in browser at 390×844.** The `min-w-[960px]` table is not rendered; a `command-card` article per request is, carrying the identity VISIBLY — `Invoice O3`, `Project Beta`, `Requested by Sales Lead`, `Step 1 of 2`, `€120,000`, SLA overdue — with the Approve button inside the same card at x 33..191 of 390. No horizontal body overflow. The accessible name is contextual too: "Approve Invoice O3 on Project Beta, requested by Sales Lead" (also UIUX-024) |
| UIUX-004 | 375 | 101 | `partial` | code and spec both moved |
| UIUX-005 | 146 | 55 | `partial` | code and spec both moved |
| UIUX-006 | 422 | 348 | `partial` | code and spec both moved |
| UIUX-007 | 142 | 162 | `partial` | code and spec both moved |
| UIUX-008 | 67 | 87 | `partial` | code and spec both moved |
| UIUX-009 | 295 | 204 | `partial` | code and spec both moved |
| UIUX-010 | 161 | 204 | `partial` | code and spec both moved |
| UIUX-011 | 414 | 279 | `partial` | code and spec both moved |
| UIUX-012 | 219 | 265 | `partial` | code and spec both moved |
| UIUX-013 | 528 | 250 | `partial` | code and spec both moved |
| UIUX-014 | 316 | 153 | `partial` | code and spec both moved |
| UIUX-015 | 240 | 175 | `partial` | code and spec both moved |
| UIUX-016 | 240 | 175 | `partial` | code and spec both moved |
| UIUX-017 | 240 | 175 | `partial` | code and spec both moved |
| UIUX-018 | 89 | 51 | `partial` | code and spec both moved |
| UIUX-019 | 928 | 704 | `partial` | code and spec both moved |
| UIUX-020 | 743 | 426 | `partial` | code and spec both moved |
| UIUX-021 | 299 | 352 | `partial` | code and spec both moved |
| UIUX-022 | 272 | 315 | `partial` | code and spec both moved |
| UIUX-023 | 312 | 97 | `partial` | code and spec both moved |
| UIUX-024 | 624 | 412 | `partial` | code and spec both moved |
| UIUX-025 | 219 | 265 | `partial` | code and spec both moved |
| UIUX-026 | 219 | 265 | `partial` | code and spec both moved |
| UIUX-027 | 605 | 495 | `partial` | code and spec both moved |
| UIUX-028 | 524 | 485 | `partial` | code and spec both moved |
| UIUX-029 | 312 | 97 | `partial` | code and spec both moved |
| UIUX-030 | 161 | 204 | `partial` | code and spec both moved |
| UIUX-031 | 142 | 162 | `partial` | code and spec both moved |
| UIUX-032 | 350 | 264 | `partial` | code and spec both moved |
| UIUX-033 | 350 | 264 | `partial` | code and spec both moved |
| UIUX-034 | 350 | 264 | `partial` | code and spec both moved |
| UIUX-035 | 32 | 50 | `partial` | code and spec both moved |
| UIUX-036 | 154 | 133 | `partial` | code and spec both moved |
| UIUX-037 | 240 | 175 | `partial` | code and spec both moved |
| UIUX-038 | 240 | 175 | `partial` | code and spec both moved |
| UIUX-039 | 666 | 417 | `partial` | code and spec both moved |
| UIUX-040 | 240 | 175 | `partial` | code and spec both moved |
| UIUX-041 | 398 | 463 | `partial` | code and spec both moved |
| UIUX-042 | 350 | 264 | `partial` | code and spec both moved |
| UIUX-043 | 361 | 276 | `partial` | code and spec both moved |
| UIUX-044 | 417 | 294 | `partial` | code and spec both moved |
| UIUX-045 | 126 | 109 | `partial` | code and spec both moved |
| UIUX-046 | 806 | 616 | `partial` | code and spec both moved |
| UIUX-047 | 319 | 192 | `partial` | code and spec both moved |
| UIUX-048 | 58 | 14 | `partial` | code and spec both moved |
| UIUX-049 | 78 | 87 | `partial` | code and spec both moved |
| UIUX-050 | 126 | 109 | `partial` | code and spec both moved |
| UIUX-051 | 369 | 298 | `partial` | code and spec both moved |
| UIUX-052 | 15 | 0 | `partial` | code moved, **no spec churn** — the weakest row in the table |
| UIUX-053 | 32 | 50 | `partial` | code and spec both moved |

### What would make this table trustworthy

1. **Name the finding in the test.** A spec that says `UIUX-003` in its
   description binds the assertion to the claim; a grep then answers "which
   findings are pinned" in one command, which is what this table had to
   approximate by counting lines.
2. **Both directions, per finding.** Several of these defects are "state X is
   presented as state Y" (UIUX-007, 012, 019, 046). A test that only asserts the
   corrected state passes against a component that shows it unconditionally.
3. **A viewport for the responsive ones.** UIUX-001, 002, 003, 004, 021, 048 and
   050 are geometry. jsdom does not lay out, so a component test cannot see them;
   they need a measured browser check at 1280, 390 and 320.

