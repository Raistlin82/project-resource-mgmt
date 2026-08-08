/**
 * SHARED SEED DATA (single source of truth).
 *
 * This module contains the canonical initial contents of every in-memory
 * store/array used by the demo backend, extracted VERBATIM from the seed
 * literals in src/server.ts. The goal is one shared source of seed data that
 * both the in-memory adapter (src/server.ts) and the Postgres seeder can use,
 * so the two can never drift apart.
 *
 * RULES:
 *   - Every export is a typed `const` array, one per entity, with camelCase
 *     field names matching the TypeScript interfaces in
 *     src/app/services/api.service.ts (imported below).
 *   - Values are copied EXACTLY from server.ts: same ids, same field values,
 *     including the USD/EUR fxRates, the USD-denominated CT2 contract chain,
 *     the per-BillingType billing items, and the three seeded approval
 *     requests (with their server-derived steps/currentStep/status/slaDueAt
 *     materialised inline so the data is self-contained).
 *   - No `any`. Each export is annotated with its api.service interface so the
 *     literal unions (statuses, kinds, recurrences, ...) are type-checked.
 *
 * NOTE: server.ts is intentionally NOT modified by the change that introduced
 * this file; it remains the behavioural reference these values were copied
 * from.
 */
import type {
  Resource,
  User,
  ResourceRequest,
  Assignment,
  TimeEntry,
  ResourceAbsence,
  Language,
  SkillCatalog,
  ProficiencySet,
  Skill,
  ProjectRole,
  ServiceOrganization,
  ResourceOrganization,
  Country,
  City,
  Industry,
  CostCategory,
  PartnerRole,
  Vendor,
  RateCard,
  NegotiatedRate,
  CostBaseline,
  Setting,
  Project,
  Partner,
  ProjectDocument,
  WorkPackage,
  Milestone,
  FinancialItem,
  ProjectCostCenter,
  Task,
  Issue,
  ChangeRequest,
  CostCenter,
  Customer,
  Contract,
  Order,
  OrderLine,
  BillingPlanItem,
  ApprovalRequest,
  AuditLog,
  FxRate,
  AssignmentDay,
  AssignmentMonth,
  Holiday,
  PlanningPeriod,
} from '../app/services/api.service';
import { distributeHoursOverWindow } from '../app/services/calendar.util';
import { deriveAssignmentStatus, type MonthStatus } from '../app/services/allocation-month.util';

// --- Core resources ---------------------------------------------------------

// Time-phased allocation (B1): contractHoursPerDay drives distributeHoursOverWindow
// below. Julie and John are full-time (8h/day); Alice is the seeded part-time
// resource (4h/day) so the demo data exercises both branches.
export const resources: Resource[] = [
  // utilization is an independent profile value (NOT derived from assignedHours).
  // It is kept plausible against each resource's booking load below: Julie is the
  // over-allocated developer (two overlapping Alpha bookings), John is fully
  // committed on the Beta migration, Alice carries two partial Beta bookings.
  // PHASE F2 — REFERENCE-DATA INTEGRITY: `location` is bound to the cities catalog
  // (store = city name; 'New York'/'London' are seeded cities, 'Remote' is the
  // seeded sentinel city). `organization` is bound to the resource-organizations
  // catalog (store = org name); the names below are seeded resource-org rows.
  // ALLOCATION APPROVAL WORKFLOW: utilizationPlanned mirrors utilization for the
  // seed because every seeded assignment status is 'Allocated' (confirmed) —
  // there are no pending allocations, so planned == confirmed here.
  // C1 — ADAPTER PARITY: `kind: 'internal'` is spelled out on these three rather
  // than left to the reader's default. Omitting it diverges the two backends:
  // Postgres applies the column's DEFAULT 'internal' on insert and serves the
  // field back, while the in-memory adapter stores exactly what it was given and
  // serves no `kind` at all. Same seed, two different JSON shapes.
  // D — JULIE HAS NO `managerId`, DELIBERATELY AND BY ABSENCE. She is the top of
  // the seeded org chart (3 -> 2 -> 1) and the manager of nodes '2'
  // (Engineering) and '5' (Platform). She used to carry `managerId: '1'` —
  // herself — which was a SELF-CYCLE in the org chart: precisely the write that
  // `wouldCycleInOrgChart` now refuses on both POST and PUT /resources, shipped
  // as demo data. The field is ABSENT rather than `''`: '' is normalized to
  // absent on every write path for exactly this reason, and a stored '' would
  // seed a phantom key in `reportsClosure`/`scopedApproversOf`, which gate on
  // `=== undefined`.
  //
  // Authorization consequence, stated rather than left to be inferred:
  // `scopedApproversOf('1', ...)` returns `{ managerIds: ∅, roleFallback: true }`
  // — the org chart offers nobody above her, and the only node manager above her
  // is herself (removed, since nobody may approve their own allocation). So any
  // `resource-manager` may decide Julie's allocations. That is CORRECT for the
  // top of a hierarchy and is the §3.4 rule-3 last resort, not the old flat
  // fallback; it was already the outcome before this change (the self-loop was
  // stopped by the traversal's `visited` set), so removing the field fixes the
  // DATA without changing who can decide.
  { id: '1', name: 'Julie Armstrong', code: 'ARMJUL000001', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 3 }, { name: 'Spring', level: 2 }],
    projectRoles: ['Senior Developer', 'Backend Engineer'],
    externalExperience: [{ projectName: 'E-commerce Migration', company: 'TechCorp', role: 'Java Developer', startDate: '2020-01-01', endDate: '2022-12-31', comment: 'Migrated legacy system to Spring Boot.' }],
    profilePicture: '', resume: '', utilization: 95, utilizationPlanned: 95, capacity: 40, organization: 'Engineering', location: 'New York', costRate: 600, billRate: 1120, hireDate: '2019-03-04', contractHoursPerDay: 8 },
  { id: '2', name: 'John Miller', code: 'MILJOH000001', role: 'Consultant', kind: 'internal',
    skills: [{ name: 'Project Management', level: 2 }], projectRoles: ['Business Consultant'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 90, utilizationPlanned: 90, capacity: 40, managerId: '1', organization: 'Consulting', location: 'London', costRate: 720, billRate: 1440, hireDate: '2021-09-13', contractHoursPerDay: 8 },
  { id: '3', name: 'Alice Smith', code: 'SMIALI000001', role: 'Designer', kind: 'internal',
    skills: [{ name: 'Figma', level: 3 }], projectRoles: ['UX Designer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 55, utilizationPlanned: 55, capacity: 40, managerId: '2', organization: 'Design', location: 'Remote', hireDate: '2023-01-16', contractHoursPerDay: 4 },
  // C1 — placeholder and external resources. The manual pre-loads dummies by
  // practice / professional level / day rate (§3.2.3.1); these mirror that, so
  // the feature is visible on first boot. `contractHoursPerDay` is the BASE for
  // ONE FTE — the multi-FTE ceiling is derived from it (dailyCapFor), never
  // stored. `utilization` starts at 0: nothing is booked on them yet, and for a
  // placeholder the scalar is meaningless anyway (it is not an internal KPI).
  { id: '4', name: 'Dummy — Senior Developer', code: 'ZZ - Dummy - Engineering - Developer', role: 'Developer', kind: 'dummy',
    skills: [], projectRoles: ['Senior Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2026-01-01', contractHoursPerDay: 8 },
  { id: '5', name: 'Dummy — Associate PMO', code: 'ZZ - Dummy - Consulting - Consultant', role: 'Consultant', kind: 'dummy',
    skills: [], projectRoles: ['Business Consultant'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Consulting', location: 'Remote', hireDate: '2026-01-01', contractHoursPerDay: 8 },
  { id: '6', name: 'Subco — Mediolanum Senior Developer', code: 'ZZ - Subco - Engineering - Developer', role: 'Developer', kind: 'subco', vendorId: 'V4',
    skills: [{ name: 'Java', level: 3 }], projectRoles: ['Senior Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2026-01-01', contractHoursPerDay: 8 },
  // BLOCK F fixture (design spec §11, row 4): a plain internal resource fully
  // allocated for the whole displayed window (Apr-Sep) with NOTHING booked
  // beyond it. Proves availabilityDate stays 'beyond-horizon' on the LAST
  // shown month even though the look-ahead month (Oct, fetched but never
  // shown) already knows the answer — the two fields deliberately have
  // different data scopes (spec §7).
  { id: '7', name: 'Priya Kapoor', code: 'KAPPRI000001', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 3 }], projectRoles: ['Senior Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 100, utilizationPlanned: 100, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2020-01-01', contractHoursPerDay: 8 },
  // BLOCK F fixture (design spec §11, row 5): hireDate IS the '2026-04' anchor
  // month's own start, with NO booking ever. Proves the month-granular guard
  // truncates the look-back at Feb/Mar (both inactive) instead of reading the
  // absence of earlier months as "idle since forever" — April must bucket B,
  // never D.
  { id: '8', name: 'Marco Belli', code: 'BELMAR000001', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 2 }], projectRoles: ['Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2026-04-01', contractHoursPerDay: 8 },
  // BLOCK F fixture (design spec §11, row 6): terminated mid-March, WITH a real
  // booking inside the fetch window's look-back (Jan-Mar15) — proves the
  // exclusion from every displayed month (Apr-Sep) is the termination gate,
  // not an absence of data that would pass for lack of trying.
  { id: '9', name: 'Elena Rossi', code: 'ROSELE000001', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 2 }], projectRoles: ['Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 100, utilizationPlanned: 100, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2018-01-01', terminationDate: '2026-03-15', contractHoursPerDay: 8 },
  // Rate-card inheritance (design spec §1, §9): the seed's own tree already has
  // Backend (competence) under Platform (practice) under Engineering
  // (capability), and RC_DEV_ENG already sits on Engineering -- a NON-LEAF node.
  // No seeded resource sat under it before this row, which is why the
  // inheritance defect this block fixes was real but invisible on the
  // committed seed. THIS resource makes it visible, and gives the impact
  // report (scripts/rate-inheritance-impact.mjs) a real, non-zero row to
  // print: no costRate/billRate override, so the card resolution does all the
  // work. Expected: BEFORE this block, resolves the generic RC_DEV (600/1120
  // EUR/day, exact-match-only); AFTER, resolves RC_DEV_ENG via the ancestor
  // walk (640/1200 EUR/day) -- delta cost +40.00, bill +80.00 EUR/day.
  // Id '13', not '7': ids '7'-'9' are already taken in this very array
  // (Priya/Marco/Elena above), '7'-'11' in requests/assignmentsBase, and '12'
  // on a concurrent branch -- verified against the live seed before picking 13.
  { id: '13', name: 'Nora Keller', code: 'KELNOR000001', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 2 }], projectRoles: ['Backend Engineer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 0, utilizationPlanned: 0, capacity: 40,
    organization: 'Backend', location: 'Remote', hireDate: '2026-02-01', contractHoursPerDay: 8 },
  // BLOCK H fixture S2/S3 (design spec §8.3) — the PRO-RATED TARGET case, and
  // the only new person this block needs.
  //
  // Fully booked across the whole displayed window (assignment '16', May-Sep,
  // plus the April basket booking '15'), so nothing except an absence can move
  // her percentages. May is the point: 21 working days x 8h = 168h booked
  // against a 168h month reads 100.00% today. The five-working-day Vacation
  // AB2 leaves 16 AVAILABLE days, so the SAME unchanged 168h must read
  // 168 / (16 x 8) = 131.25% and band `over`. The signal is visible rather
  // than silent, which is the whole reason the fixture books the absence days
  // instead of dodging them: it is also §6.4's accepted direction (an absence
  // recorded OVER existing bookings is accepted and reports the conflict; only
  // a NEW booking onto an absence day is refused).
  //
  // hireDate is 2022, not 2026: AB3 records a FEBRUARY absence (S3) and an
  // absence outside the employment window is a 400 on the write path. A seed
  // row the API itself would refuse is a fixture that lies about its own
  // legality.
  //
  // organization 'Engineering' is LOAD-BEARING, do not move her to
  // 'Platform'/'Backend': scripts/rate-inheritance-impact.mjs states it must
  // print EXACTLY ONE row (Nora, above). 'Engineering' is RC_DEV_ENG's own
  // node, so she resolves 640/1200 both before and after the ancestor walk and
  // contributes no row. Her resolved rates are therefore 80 EUR/h cost and
  // 150 EUR/h bill — the figures every arithmetic comment below is built on.
  //
  // Id '14' continues the id discipline the '13' comment above started: ids are
  // taken to be GLOBAL across resources/requests/assignments, so this block's
  // four new requests+assignments start at '15' rather than reusing '13'/'14'.
  { id: '14', name: 'Sofia Ferrari', code: 'FERSOF000001', role: 'Developer', kind: 'internal',
    skills: [{ name: 'Java', level: 3 }], projectRoles: ['Senior Developer'],
    externalExperience: [], profilePicture: '', resume: '', utilization: 100, utilizationPlanned: 100, capacity: 40,
    organization: 'Engineering', location: 'Remote', hireDate: '2022-03-01', contractHoursPerDay: 8,
    // Sofia is the ONE resource whose fixture depends on having rates. She was
    // added (H/T2) to carry both billable and non-billable hours on one person,
    // so that `resourceBillability` has exactly one right answer and the two
    // plausible wrong ones — uncorrected (all her hours) and over-corrected
    // (none) — are excluded. With no rates all three collapse to 0 and the
    // fixture distinguishes nothing: the blind green gate it exists to prevent.
    // Same €/day scale as the other internals.
    costRate: 600, billRate: 1120 },
];

export const users: User[] = [
  { id: '1', resourceId: '1', name: 'Julie Armstrong', role: 'delivery-executive' },
  { id: '2', resourceId: '2', name: 'John Miller', role: 'resource-manager' },
  { id: '3', resourceId: '3', name: 'Alice Smith', role: 'pm' },
  { id: '4', resourceId: '2', name: 'Finance Controller', role: 'finance' },
  { id: '5', resourceId: '3', name: 'Sales Lead', role: 'sales' },
  { id: '6', resourceId: '1', name: 'System Admin', role: 'admin' },
];

// B9: a request is 'Fulfilled' iff staffedEffort >= requiredEffort (server-derived
// rule; see staffing.util `requestStatusFor`). Each request's staffedEffort below
// equals the sum of assignedHours across its assignments, keeping the seed coherent.
// Date windows are anchored across 2026-04 .. 2026-09 so the bookings fall inside
// the schedule view's default ~12-week horizon from "today" (2026-06-12).
// ALLOCATION APPROVAL WORKFLOW: staffedEffortPlanned mirrors staffedEffort here.
// KNOWN SEED DRIFT (pre-existing, deliberately not "fixed" as data): both numbers
// are hand-typed sums of `assignedHours`, whereas the runtime aggregates are
// `monthlyAggregateHours` — per-DAY hours weighed by the status of their OWN
// month row. The one seeded pending month (2:2026-08) therefore means request
// '3''s true CONFIRMED effort is below the 24 typed below until that month is
// approved. Deriving these two columns from the month rows would also flip the
// seeded request statuses, so it is a separate change; the first mutation of
// either request recomputes both from source of truth regardless.
export const requests: ResourceRequest[] = [
  { id: '1', name: 'Project Alpha - Backend', requiredRole: 'Developer', requiredEffort: 20, staffedEffort: 20, staffedEffortPlanned: 20, status: 'Fulfilled', skills: ['Java'], description: 'Backend development for Project Alpha', startDate: '2026-04-01', endDate: '2026-06-30', requesterId: '1', projectId: '1' },
  { id: '2', name: 'Project Beta - UI', requiredRole: 'Designer', requiredEffort: 15, staffedEffort: 8, staffedEffortPlanned: 8, status: 'Published', skills: ['Figma'], description: 'UI Design for Project Beta', startDate: '2026-05-01', endDate: '2026-07-31', requesterId: '1', projectId: '2' },
  { id: '3', name: 'Project Alpha - API Hardening', requiredRole: 'Developer', requiredEffort: 24, staffedEffort: 24, staffedEffortPlanned: 24, status: 'Fulfilled', skills: ['Java'], description: 'API hardening and performance work for Project Alpha', startDate: '2026-06-15', endDate: '2026-08-31', requesterId: '1', projectId: '1' },
  { id: '4', name: 'Project Beta - Platform Migration', requiredRole: 'Consultant', requiredEffort: 30, staffedEffort: 30, staffedEffortPlanned: 30, status: 'Fulfilled', skills: ['Project Management'], description: 'Lead the platform migration workstream for Project Beta', startDate: '2026-05-15', endDate: '2026-09-15', requesterId: '1', projectId: '2' },
  { id: '5', name: 'Project Beta - Design QA', requiredRole: 'Designer', requiredEffort: 10, staffedEffort: 10, staffedEffortPlanned: 10, status: 'Fulfilled', skills: ['Figma'], description: 'Design quality pass ahead of Project Beta go-live', startDate: '2026-08-01', endDate: '2026-09-30', requesterId: '1', projectId: '2' },
  // NEGOTIATED SELL RATES — the demand row that makes the feature observable on
  // seeded data. Project '2' carries the negotiated Developer override
  // (NR_P2_DEV below) but had NO Developer staffed on it and therefore no
  // Developer hours, so resolution never ran on a single seeded row: the impact
  // report printed zero because nothing exercised the code, which is how a ~8x
  // revenue defect passed every green gate. A Developer request on project '2'
  // is what lets an assignment, and then an approved time entry, exist here
  // without lying about their own identity (a time entry's project must be its
  // assignment's request's project — that is what the Log Hours UI writes).
  { id: '6', name: 'Project Beta - Backend Development', requiredRole: 'Developer', requiredEffort: 8, staffedEffort: 8, staffedEffortPlanned: 8, status: 'Fulfilled', skills: ['Java'], description: 'Backend workstream on Project Beta, priced at the negotiated Developer rate', startDate: '2026-06-01', endDate: '2026-06-30', requesterId: '1', projectId: '2' },
  // BLOCK F fixtures (design spec §11). staffedEffort === requiredEffort on
  // every one of these so `requestStatusFor` derives 'Fulfilled' (B9 rule),
  // matching the seed's own convention above.
  { id: '7', name: 'Subco Mediolanum - Backend (Feb-Mar)', requiredRole: 'Developer', requiredEffort: 336, staffedEffort: 336, staffedEffortPlanned: 336, status: 'Fulfilled', skills: ['Java'], description: 'Full allocation ahead of Project Alpha ramp-up', startDate: '2026-02-01', endDate: '2026-03-31', requesterId: '1', projectId: '1' },
  { id: '8', name: 'Subco Mediolanum - Ramp-down day', requiredRole: 'Developer', requiredEffort: 0.4, staffedEffort: 0.4, staffedEffortPlanned: 0.4, status: 'Fulfilled', skills: ['Java'], description: 'Single partial day closing out the engagement', startDate: '2026-04-01', endDate: '2026-04-01', requesterId: '1', projectId: '1' },
  { id: '9', name: 'Dummy Senior Developer - Alpha backfill', requiredRole: 'Developer', requiredEffort: 1048, staffedEffort: 1048, staffedEffortPlanned: 1048, status: 'Fulfilled', skills: [], description: 'Placeholder booking pending a real hire', startDate: '2026-04-01', endDate: '2026-09-30', requesterId: '1', projectId: '1' },
  { id: '10', name: 'Project Alpha - Priya full allocation', requiredRole: 'Developer', requiredEffort: 1048, staffedEffort: 1048, staffedEffortPlanned: 1048, status: 'Fulfilled', skills: ['Java'], description: 'Full-time booking through the displayed window', startDate: '2026-04-01', endDate: '2026-09-30', requesterId: '1', projectId: '1' },
  { id: '11', name: 'Project Alpha - Elena (pre-termination)', requiredRole: 'Developer', requiredEffort: 408, staffedEffort: 408, staffedEffortPlanned: 408, status: 'Fulfilled', skills: ['Java'], description: 'Work booked before her termination date', startDate: '2026-01-01', endDate: '2026-03-15', requesterId: '1', projectId: '1' },
  // COST BASELINE (block E) — the request that staffs the assignment below.
  { id: '12', name: 'Project Alpha - PCP Baseline Demo', requiredRole: 'Consultant', requiredEffort: 8, staffedEffort: 8, staffedEffortPlanned: 8, status: 'Fulfilled', skills: ['Project Management'], description: 'Demonstrates the frozen monthly cost baseline vs the live plan (design spec, block E)', startDate: '2026-10-05', endDate: '2026-10-05', requesterId: '1', projectId: '1' },
  // BLOCK H fixtures (design spec §8.3, S5/S8 and the non-basket control).
  // Ids start at '15' because resources '13'/'14' already claimed those two in
  // this seed's global id discipline. staffedEffort === requiredEffort on every
  // row so `requestStatusFor` derives 'Fulfilled' (B9), like every row above.
  //
  // '15' and '17' both staff project '3', the BASKET engagement, DELIBERATELY
  // with two different resource kinds: a real person (S5, whose hours must
  // stop counting as billable value) and a placeholder (S8, whose hours must
  // KEEP counting as hiring demand — needing to hire for AMS is still needing
  // to hire). One entity, two opposite verdicts; a fixture with only one of
  // them lets an implementation satisfy both by accident.
  { id: '15', name: 'BASKET Engineering - AMS presidio', requiredRole: 'Developer', requiredEffort: 176, staffedEffort: 176, staffedEffortPlanned: 176, status: 'Fulfilled', skills: ['Java'], description: 'Application-management duty on the Engineering basket: real cost, no customer revenue', startDate: '2026-04-01', endDate: '2026-04-30', requesterId: '1', projectId: '3' },
  // The BILLABLE half of Sofia's year. Without it she would carry only
  // non-billable hours and `resourceBillability` could be "corrected" to zero
  // for her without anyone noticing the over-correction (spec F-8/U18 asks for
  // a fixture with BOTH kinds of hours on ONE person).
  { id: '16', name: 'Project Alpha - Sofia full allocation', requiredRole: 'Developer', requiredEffort: 872, staffedEffort: 872, staffedEffortPlanned: 872, status: 'Fulfilled', skills: ['Java'], description: 'Full-time booking on the billable delivery engagement, May through September', startDate: '2026-05-01', endDate: '2026-09-30', requesterId: '1', projectId: '1' },
  { id: '17', name: 'BASKET Engineering - AMS backfill', requiredRole: 'Developer', requiredEffort: 88, staffedEffort: 88, staffedEffortPlanned: 88, status: 'Fulfilled', skills: [], description: 'Placeholder half-head on the Engineering basket, pending a real hire', startDate: '2026-04-01', endDate: '2026-04-30', requesterId: '1', projectId: '3' },
  // THE CONTROL FOR THE INVARIANT, not a basket: project '4' is
  // `billable: false` with `type: 'Delivery'`. Without a row here, every
  // finance exclusion could be keyed on `type === 'Basket'` instead of on
  // `billable`, and every test would still pass — the reading of the invariant
  // that is exactly backwards (spec §3.2: Basket implies non-billable, the
  // converse stays free).
  { id: '18', name: 'Internal Platform - Delivery Control build', requiredRole: 'Consultant', requiredEffort: 80, staffedEffort: 80, staffedEffortPlanned: 80, status: 'Fulfilled', skills: ['Project Management'], description: 'Internal platform work: not billable, and not a basket either', startDate: '2026-05-01', endDate: '2026-05-14', requesterId: '1', projectId: '4' },
];

// Resource Schedule (Approach B): every assignment carries an explicit booking
// window (startDate/endDate) + an allocationPct of the resource's weekly capacity.
//
// DELIBERATE OVER-ALLOCATION (conflict-detection demo): resource '1' Julie
// Armstrong is double-booked — A1 (Alpha Backend, 60%, 2026-05-01..2026-06-30)
// overlaps A2 (Alpha API Hardening, 70%, 2026-06-15..2026-08-31). In the overlap
// window 2026-06-15..2026-06-30 the summed allocation is 60 + 70 = 130% > 100%, so
// the schedule util flags both bookings and records a peak of 130%.
//
// The rest read realistically: a FULL booking (A3 John Miller 100%, no overlap)
// and two PARTIAL, NON-OVERLAPPING bookings (A4/A5 Alice Smith 50% each — A4 ends
// 2026-07-31, A5 starts 2026-08-01; the half-open [start,end) interval makes these
// adjacent, NOT conflicting).
// NOTE(alloc-approval Task 1): status literals were 'hard-booked'/'soft-booked'
// (free string) prior to that feature; typing Assignment.status as a
// 'Draft' | 'Requested' | 'Allocated' | 'Rejected' union made them incompatible.
// The hard/soft distinction was never reintroduced and is not modelled today.
//
// B3: `status` is NOT part of this literal. It is a DERIVED rollup of the
// assignment's month rows (`deriveAssignmentStatus`), so hard-coding it here let
// the seed contradict its own invariant from the very first boot: assignment '2'
// shipped 'Allocated' while its 2:2026-08 month row is 'Requested', which the
// rollup reads as 'Requested'. The exported `assignments` below is built from
// this base once the month rows exist, so a fresh database is consistent by
// construction and no hand-maintained pair can drift.
const assignmentsBase: readonly Omit<Assignment, 'status'>[] = [
  { id: '1', requestId: '1', resourceId: '1', assignedHours: 20, startDate: '2026-05-01', endDate: '2026-06-30', allocationPct: 60 },
  { id: '2', requestId: '3', resourceId: '1', assignedHours: 24, startDate: '2026-06-15', endDate: '2026-08-31', allocationPct: 70 },
  { id: '3', requestId: '4', resourceId: '2', assignedHours: 30, startDate: '2026-05-15', endDate: '2026-09-15', allocationPct: 100 },
  { id: '4', requestId: '2', resourceId: '3', assignedHours: 8, startDate: '2026-05-01', endDate: '2026-07-31', allocationPct: 50 },
  { id: '5', requestId: '5', resourceId: '3', assignedHours: 10, startDate: '2026-08-01', endDate: '2026-09-30', allocationPct: 50 },
  // NEGOTIATED SELL RATES (see request '6'): Julie — the seeded Developer — booked
  // for ONE day on Project Beta, which is where the negotiated Developer override
  // lives. Deliberately a single working day (2026-06-01, a Monday, no holiday):
  // 8 assigned hours == the 8 hours TE4 logs, so the demo prices exactly one day
  // at one day rate and the arithmetic in the impact report is checkable by hand.
  // 20% == 8h of her 40h week. It overlaps assignment '1' (60%) on that date for
  // 80% total, deliberately UNDER 100%, so the seeded over-allocation demo stays
  // the one it documents (A1+A2, 130% in 2026-06-15..06-30) and no new conflict
  // is invented here.
  { id: '6', requestId: '6', resourceId: '1', assignedHours: 8, startDate: '2026-06-01', endDate: '2026-06-01', allocationPct: 20 },
  // BLOCK F fixtures (design spec §11) — see the requests above for context.
  // Resource '6' (subco): full 8h/day Feb-Mar, then a single 0.4h day in
  // April and nothing after. 336 = 42 working days (20 Feb + 22 Mar) × 8h;
  // distributeHoursOverWindow spreads it back to exactly 8h/day, no remainder.
  { id: '7', requestId: '7', resourceId: '6', assignedHours: 336, startDate: '2026-02-01', endDate: '2026-03-31', allocationPct: 100 },
  // Deliberately 0.4h — rounds to "0.00%" of April's ~176h target in any
  // display, but is NOT zero: a genuine (if tiny) booking, pinning the
  // BENCH-vs-PARTIAL boundary at exactly 0 (design spec §3).
  { id: '8', requestId: '8', resourceId: '6', assignedHours: 0.4, startDate: '2026-04-01', endDate: '2026-04-01', allocationPct: 1 },
  // Resource '4' (dummy): flat 8h/day for the whole displayed window.
  // 1048 = 131 working days (22+21+22+23+21+22, Apr..Sep) × 8h.
  { id: '9', requestId: '9', resourceId: '4', assignedHours: 1048, startDate: '2026-04-01', endDate: '2026-09-30', allocationPct: 100 },
  // Resource '7' (new internal): flat 8h/day for the whole displayed window,
  // nothing booked in the look-ahead month (October) — the point of this fixture.
  { id: '10', requestId: '10', resourceId: '7', assignedHours: 1048, startDate: '2026-04-01', endDate: '2026-09-30', allocationPct: 100 },
  // Resource '9' (new internal, terminated 2026-03-15): real booking entirely
  // BEFORE the displayed window but partly INSIDE the fetch window's look-back
  // (Feb-Mar15). 408 = 51 working days (Jan2..Mar13, skipping the 2026-01-01
  // holiday) × 8h.
  { id: '11', requestId: '11', resourceId: '9', assignedHours: 408, startDate: '2026-01-01', endDate: '2026-03-15', allocationPct: 100 },
  // COST BASELINE (block E): John Miller (resource '2', Consultant, costRate
  // override 720 EUR/DAY -> resolved 90 EUR/HOUR at hoursPerDay=8) booked for
  // ONE working day on project '1' (Fixed Price CT1 — the baseline prices
  // COST, not T&M revenue, so the contract type is irrelevant here),
  // 2026-10-05 (a Monday, no holiday, no other October booking for John).
  // Planned cost for period '2026-10' = 8h x 90 EUR/h = 720 EUR exactly —
  // hand-verifiable against cost_baselines 'CB1' below (600 -> delta +120 /
  // +20.00%).
  { id: '12', requestId: '12', resourceId: '2', assignedHours: 8, startDate: '2026-10-05', endDate: '2026-10-05', allocationPct: 20 },
  // BLOCK H fixtures (design spec §8.3). Every hour figure below is
  // working-days x 8h with no remainder, so distributeHoursOverWindow spreads
  // them back to a flat daily rate and the arithmetic in the comments is
  // checkable by hand:
  //   April 2026            = 22 working days (no seeded holiday)
  //   May-Sep 2026          = 21+22+23+21+22 = 109 working days
  //   2026-05-01..05-14     = 10 working days
  //
  // S5 — Sofia on the BASKET engagement for April: 22 x 8 = 176h. Priced at
  // her resolved 80 EUR/h this is 14,080.00 EUR of planned cost on a project
  // that can never earn a euro of customer revenue.
  { id: '15', requestId: '15', resourceId: '14', assignedHours: 176, startDate: '2026-04-01', endDate: '2026-04-30', allocationPct: 100 },
  // The billable half: 109 x 8 = 872h, May through September. April is
  // deliberately NOT part of it — Sofia's year splits cleanly into 176
  // non-billable hours and 872 billable ones, so `resourceBillability` for her
  // must fall from 1,048 x 150 = 157,200.00 EUR to 872 x 150 = 130,800.00 EUR
  // and to nothing else. Two wrong answers (0, or unchanged) are both excluded
  // by one number.
  { id: '16', requestId: '16', resourceId: '14', assignedHours: 872, startDate: '2026-05-01', endDate: '2026-09-30', allocationPct: 100 },
  // S8 — the DUMMY on the same basket engagement, at half a head: 22 x 4 = 88h.
  // Half rather than whole on purpose: resource '4' already carries 8h/day from
  // assignment '9', so April reads 12h/day — 1.5 FTE of placeholder demand,
  // well inside `dailyCapFor('dummy', 8)` (multi-FTE, C1) and unmistakably NOT
  // a person double-booked. Pins B7: hiring demand counts basket hours too.
  { id: '17', requestId: '17', resourceId: '4', assignedHours: 88, startDate: '2026-04-01', endDate: '2026-04-30', allocationPct: 50 },
  // The non-billable NON-basket control (project '4'): John Miller, 10 x 8 =
  // 80h, ending the day before his existing booking '3' starts (2026-05-15),
  // so no new over-allocation is invented and the seeded 130% demo stays the
  // only one. At his 90 EUR/h override that is 7,200.00 EUR of planned May cost.
  { id: '18', requestId: '18', resourceId: '2', assignedHours: 80, startDate: '2026-05-01', endDate: '2026-05-14', allocationPct: 100 },
];

// --- Time-phased allocation (B1) config --------------------------------------

// Non-working days (id IS the ISO date). Neither falls inside any seeded
// assignment window (2026-05..2026-09 above), so they don't perturb the
// assignmentDays distribution below — they exist to exercise the holiday-aware
// calendar helpers (isWorkingDay/workingDaysInMonth) for OTHER months.
export const holidays: Holiday[] = [
  { id: '2026-12-25', name: 'Christmas' },
  { id: '2026-01-01', name: "New Year's Day" },
];

// Open/closed state per calendar month (id IS 'YYYY-MM'). Opens the demo
// period's full span (2026-04..2026-12) so every seeded assignment window
// (May..September) falls inside an Open period.
export const planningPeriods: PlanningPeriod[] = [
  { id: '2026-04', status: 'Open' },
  { id: '2026-05', status: 'Open' },
  { id: '2026-06', status: 'Open' },
  { id: '2026-07', status: 'Open' },
  { id: '2026-08', status: 'Open' },
  { id: '2026-09', status: 'Open' },
  { id: '2026-10', status: 'Open' },
  { id: '2026-11', status: 'Open' },
  { id: '2026-12', status: 'Open' },
];

/**
 * Per-day breakdown of every seeded assignment's `assignedHours`, computed
 * (not hand-typed) via the same pure `distributeHoursOverWindow` helper the
 * runtime allocation endpoints use. This guarantees Σ assignmentDays.hours per
 * assignment === that assignment's assignedHours by construction (the helper
 * preserves the total, absorbing the rounding remainder on the last working
 * day) instead of relying on two hand-maintained numbers staying in sync.
 * Assignments without a booking window (no startDate/endDate) contribute no
 * days — none of the seeded rows above hit that case.
 */
function buildAssignmentDays(
  rows: readonly Omit<Assignment, 'status'>[],
  holidayRows: readonly Holiday[],
): AssignmentDay[] {
  const holidaySet = new Set(holidayRows.map((h) => h.id));
  const out: AssignmentDay[] = [];
  for (const a of rows) {
    if (!a.startDate || !a.endDate) continue;
    const perDay = distributeHoursOverWindow(a.assignedHours, a.startDate, a.endDate, holidaySet);
    for (const [date, hours] of Object.entries(perDay)) {
      if (hours > 0) {
        out.push({ id: `${a.id}:${date}`, assignmentId: a.id, date, hours });
      }
    }
  }
  return out;
}

export const assignmentDays: AssignmentDay[] = buildAssignmentDays(assignmentsBase, holidays);

/**
 * Per-month lifecycle rows (B3), derived — not hand-typed — from the seeded
 * assignmentDays so a month row exists for exactly the months each assignment
 * actually books. Months are seeded 'Allocated' (booked, approved work); ONE
 * month of assignment '2' is left 'Requested' (governed by the seeded approval
 * AR4 below) to give the People Manager page and the smoke suite a pending item
 * to decide out of the box — which is why assignment '2' then DERIVES to
 * 'Requested' rather than 'Allocated'.
 */
const PENDING_SEED_MONTH = { assignmentId: '2', month: '2026-08', approvalId: 'AR4' } as const;

function buildAssignmentMonths(
  rows: readonly Omit<Assignment, 'status'>[],
  days: readonly AssignmentDay[],
): AssignmentMonth[] {
  const monthsByAssignment = new Map<string, Set<string>>();
  for (const d of days) {
    const set = monthsByAssignment.get(d.assignmentId) ?? new Set<string>();
    set.add(d.date.slice(0, 7));
    monthsByAssignment.set(d.assignmentId, set);
  }
  const out: AssignmentMonth[] = [];
  for (const a of rows) {
    for (const month of [...(monthsByAssignment.get(a.id) ?? [])].sort()) {
      const pending = a.id === PENDING_SEED_MONTH.assignmentId && month === PENDING_SEED_MONTH.month;
      out.push({
        id: `${a.id}:${month}`,
        assignmentId: a.id,
        month,
        status: pending ? 'Requested' : 'Allocated',
        ...(pending ? { approvalId: PENDING_SEED_MONTH.approvalId, plannerNote: 'Extra month to cover the migration cut-over' } : {}),
      });
    }
  }
  return out;
}

export const assignmentMonths: AssignmentMonth[] = buildAssignmentMonths(assignmentsBase, assignmentDays);

/**
 * The seeded assignments, with `status` DERIVED from the month rows above via
 * the very same rollup the server applies (`refreshDerivedAssignmentStatus`), so
 * a freshly seeded database already satisfies the B3 invariant instead of
 * needing the first mutation to repair it.
 */
export const assignments: Assignment[] = assignmentsBase.map(a => ({
  ...a,
  status: deriveAssignmentStatus(
    assignmentMonths.filter(m => m.assignmentId === a.id).map(m => m.status as MonthStatus),
  ),
}));

export const timeEntries: TimeEntry[] = [
  { id: 'TE1', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-06', hours: 8, status: 'Approved', notes: 'Backend integration', approvedBy: '1', approvedAt: '2026-04-07T09:00:00.000Z' },
  { id: 'TE2', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-07', hours: 8, status: 'Approved', notes: 'API hardening', approvedBy: '1', approvedAt: '2026-04-08T09:00:00.000Z' },
  { id: 'TE3', assignmentId: '1', requestId: '1', resourceId: '1', projectId: '1', date: '2026-04-08', hours: 4, status: 'Submitted', notes: 'Defect fixing' },
  // NEGOTIATED SELL RATES — THE ROW THAT MAKES THE GATE REAL. Every entry above
  // is on project '1' (Fixed-Price CT1, which carries no negotiated rate), so
  // before this row no seeded hour ever reached `sellRateFor`'s negotiated
  // branches and a green impact report proved nothing.
  //
  // This one is APPROVED (only approved hours are recognized), on project '2',
  // by resource '1' whose role is 'Developer', dated inside CT2's period
  // (2026-03-01..2027-02-28) — the four conditions the project override
  // NR_P2_DEV needs to win. Exact expected arithmetic, one 8h day:
  //   reference : 1120 €/day override ÷ 8 = 140.00 €/h -> 8h = 1,120.00 €
  //   negotiated: 1150 €/day override ÷ 8 = 143.75 €/h -> 8h = 1,150.00 €
  //   delta = +30.00 € on project '2'. Under the €/day-vs-hours defect this was
  //   8 × 1150 = 9,200 €, so the SIZE of this delta is itself the regression
  //   pin: a four-figure delta here means the conversion is gone again.
  // approvedBy is user '2' (John Miller), NOT Julie's own user — segregation of
  // duties, which TE1/TE2 predate and violate.
  { id: 'TE4', assignmentId: '6', requestId: '6', resourceId: '1', projectId: '2', date: '2026-06-01', hours: 8, status: 'Approved', notes: 'Beta backend — priced at the negotiated Developer rate', approvedBy: '2', approvedAt: '2026-06-02T09:00:00.000Z' },
  // BLOCK H (design spec §8.3, S5) — THE ROWS WITHOUT WHICH THE NON-BILLABLE
  // HALF OF THIS BLOCK PROVES NOTHING.
  //
  // `realizationMetrics`, `actualLaborCostForProject` and `customerProfitability`
  // all read APPROVED hours and nothing else. A basket engagement with an
  // assignment but no approved time entry has revenue 0, cost 0 and margin 0:
  // it is excluded from every finance surface for lack of data, and a green
  // "the non-billable project raises no margin alert" would mean nothing. That
  // is trap (c) of §8, the same shape as the negotiated-rate impact report that
  // printed zero because nothing exercised the code (see request '6' above).
  //
  // 24 approved hours on project '3', at Sofia's resolved 80/150 EUR per hour:
  //   actual labour cost   = 24 x 80  = 1,920.00 EUR
  //   standardBillValue    = 24 x 150 = 3,600.00 EUR
  //   revenue              = 0        (no contract, no order line, no billing item)
  // so TODAY this project reports margin -1,920.00 EUR, realization 0.00%, and
  // a permanently loss-making 'unknown' customer row — the three numbers F-3,
  // F-5 and F-7 exist to stop reporting.
  //
  // approvedBy is user '2' (John Miller), never Sofia's own — segregation of
  // duties, the convention TE4 introduced and TE1/TE2 predate.
  { id: 'TE5', assignmentId: '15', requestId: '15', resourceId: '14', projectId: '3', date: '2026-04-06', hours: 8, status: 'Approved', notes: 'AMS duty — incident triage', approvedBy: '2', approvedAt: '2026-04-07T09:00:00.000Z' },
  { id: 'TE6', assignmentId: '15', requestId: '15', resourceId: '14', projectId: '3', date: '2026-04-07', hours: 8, status: 'Approved', notes: 'AMS duty — corrective maintenance', approvedBy: '2', approvedAt: '2026-04-08T09:00:00.000Z' },
  { id: 'TE7', assignmentId: '15', requestId: '15', resourceId: '14', projectId: '3', date: '2026-04-08', hours: 8, status: 'Approved', notes: 'AMS duty — release support', approvedBy: '2', approvedAt: '2026-04-09T09:00:00.000Z' },
  // The same shape on project '4', the non-billable engagement that is NOT a
  // basket. Different resource and different rate on purpose (John's 90/180
  // EUR-per-hour overrides): 16 x 90 = 1,440.00 EUR cost and 16 x 180 =
  // 2,880.00 EUR of standard bill value are distinguishable at a glance from
  // project '3''s 1,920.00 / 3,600.00, so a test can tell WHICH project an
  // exclusion actually excluded.
  { id: 'TE8', assignmentId: '18', requestId: '18', resourceId: '2', projectId: '4', date: '2026-05-04', hours: 8, status: 'Approved', notes: 'Internal platform build', approvedBy: '1', approvedAt: '2026-05-05T09:00:00.000Z' },
  { id: 'TE9', assignmentId: '18', requestId: '18', resourceId: '2', projectId: '4', date: '2026-05-05', hours: 8, status: 'Approved', notes: 'Internal platform build', approvedBy: '1', approvedAt: '2026-05-06T09:00:00.000Z' },
];

// --- Block H: recorded absences (design spec §3.3, §8.3) ---------------------

/**
 * The rows that make the fourth bench state VISIBLE ON FIRST BOOT.
 *
 * WHY THIS EXPORT IS THE POINT OF TASK T2, stated rather than assumed: T1
 * shipped the table, the migration, the types and the wiring, and NOTHING
 * flowed through any of it. With this array empty the whole block is invisible
 * in dev, unexercised by every derived surface, and green everywhere — the
 * project's recurring defect. `src/db/repositories.ts` and `src/db/bootstrap.ts`
 * must therefore point at THIS export, not at a literal `[]`.
 *
 * FOUR PROPERTIES EVERY ROW HERE SATISFIES, because each is a rule the write
 * path will enforce (spec §6.1/§7.4) and a seed the API would refuse is a
 * fixture that lies:
 *   - `startDate <= endDate`, both INCLUSIVE;
 *   - the whole interval falls inside the resource's employment window;
 *   - no two rows for the same resource overlap (409 on the write path);
 *   - `recordedBy` is user '2' (John Miller, resource-manager) and never the
 *     subject's own user — the SoD rule that the recorder may not be the
 *     person recorded. Note the operational consequence this bakes in: John
 *     could not have recorded an absence of his own.
 *
 * `reasonCode` is special-category data (GDPR art. 9) and the arithmetic never
 * branches on it — that is what lets the redacted projection stay numerically
 * complete. Two of the four causes here are health-related precisely so the
 * privacy split of §7.3 has something real to protect: a test that asserts
 * "no reasonCode leaked" against rows that carry only 'Vacation' proves very
 * little.
 *
 * `note` is populated on AB1 and ABSENT on the other three, deliberately. It is
 * the block's only nullable column, so it is the only row-level exercise of the
 * `nullsToUndefined()` seam on a live Postgres boot: one row must come back
 * with the text, three must come back with NO key at all (never `null`).
 */
export const resourceAbsences: ResourceAbsence[] = [
  // S4 — THE SUBCO CASE. Resource '6' is bench from May onward (block F), and
  // this covers every one of August's 21 working days, so the month is FULLY
  // absent and the subco tile on /dashboard (`subcoBenchCount`) has something
  // to stop counting. DELIBERATELY A WHOLE MONTH rather than the "short"
  // absence §8.3 suggests: a short absence inside an already-BENCH month leaves
  // the state BENCH, moves no tile, and would be a fixture that exercises
  // nothing while appearing to cover the subco case.
  //
  // August is also the month S1 covers for an INTERNAL resource, so the two
  // tiles move together in August and only the internal one moves in June and
  // July — which is what makes them distinguishable rather than a single
  // pass/fail.
  { id: 'AB1', resourceId: '6', startDate: '2026-08-01', endDate: '2026-08-31',
    reasonCode: 'Sickness', recordedBy: '2', recordedAt: '2026-07-30T10:00:00.000Z' },
  // S1 — THE HEADLINE CORRECTION. Resource '8' (Marco Belli) is the seed's pure
  // bench case: hired on the anchor month, never booked, so today he reads
  // BENCH/B-C-D-D-D-D straight across April-September and every one of those
  // six months counts him as idle delivery capacity. Three months of parental
  // leave cover every working day of June, July and August, so those three must
  // leave the bench entirely — and MAY must not, which is the paired assertion
  // that proves the change is scoped to the interval and not to the row.
  { id: 'AB2', resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31',
    reasonCode: 'ParentalLeave', note: 'Cover arranged with the Platform practice',
    recordedBy: '2', recordedAt: '2026-05-20T09:00:00.000Z' },
  // S3 — THE NO-EFFECT TWIN. Five working days in FEBRUARY: inside Sofia's
  // employment window, inside the 9-month range /bench/monthly fetches, and
  // outside all six DISPLAYED months. Nothing on screen may move. Paired with
  // AB4 below — same resource, same length, one week's worth each — so the two
  // differ only in WHERE they sit, and "the window is respected" is proved in
  // both directions by one comparison.
  { id: 'AB3', resourceId: '14', startDate: '2026-02-09', endDate: '2026-02-13',
    reasonCode: 'Sickness', recordedBy: '2', recordedAt: '2026-02-09T07:45:00.000Z' },
  // S2 — THE PRO-RATED TARGET. Five working days of May, on a month Sofia is
  // booked 168h in. Her booked hours do not change; her AVAILABLE target drops
  // from 21 x 8 = 168h to 16 x 8 = 128h, so /capacity must read 131.25% and
  // band `over` where it reads 100.00% today. See her resource comment above.
  { id: 'AB4', resourceId: '14', startDate: '2026-05-11', endDate: '2026-05-15',
    reasonCode: 'Vacation', recordedBy: '2', recordedAt: '2026-04-27T08:30:00.000Z' },
];

// --- Configuration ----------------------------------------------------------

export const languages: Language[] = [
  { code: 'en', name: 'English', isDefault: true },
  { code: 'de', name: 'German', isDefault: false },
  { code: 'es', name: 'Spanish', isDefault: false },
  { code: 'fr', name: 'French', isDefault: false },
];

export const skillCatalogs: SkillCatalog[] = [
  { id: '1', name: 'Development Skills', description: 'Skills related to software development', skills: ['1', '2'] },
];

export const proficiencySets: ProficiencySet[] = [
  { id: '1', name: 'Standard IT Proficiency', description: 'Standard 1-5 level proficiency',
    levels: [
      { id: 'l1', level: 1, name: 'Beginner', description: 'Basic knowledge' },
      { id: 'l2', level: 2, name: 'Intermediate', description: 'Practical application' },
      { id: 'l3', level: 3, name: 'Advanced', description: 'Applied theory' },
      { id: 'l4', level: 4, name: 'Expert', description: 'Recognized authority' },
    ] },
];

export const skills: Skill[] = [
  { id: '1', conceptUri: 'sap-rm://skill/1', name: 'Java', description: 'Java programming', catalogs: ['1'], proficiencySetId: '1', restricted: false },
  { id: '2', conceptUri: 'sap-rm://skill/2', name: 'JavaScript', description: 'JS programming', catalogs: ['1'], proficiencySetId: '1', restricted: false },
];

// CANONICAL ROLE CATALOG (reference-data integrity, Phase A). The stored value
// on resources/requests is the role NAME (backward-compatible with match-scoring
// which compares role strings), so this catalog MUST cover every role value used
// by the seeded resources (`role` + `projectRoles[]`) and requests (`requiredRole`):
//   - resources.role:         Developer, Consultant, Designer
//   - resources.projectRoles: Senior Developer, Backend Engineer, Business Consultant, UX Designer
//   - requests.requiredRole:  Developer, Designer, Consultant
// The original DEV/PM rows are kept; the rest are added so existing data stay
// valid SELECT options and never get silently discarded on edit.
export const projectRoles: ProjectRole[] = [
  { id: '1', code: 'DEV', name: 'Developer', description: 'Software Developer', restricted: false },
  { id: '2', code: 'PM', name: 'Project Manager', description: 'Project Manager', restricted: false },
  { id: '3', code: 'SR_DEV', name: 'Senior Developer', description: 'Senior Software Developer', restricted: false },
  { id: '4', code: 'BE_ENG', name: 'Backend Engineer', description: 'Backend Engineer', restricted: false },
  { id: '5', code: 'CONS', name: 'Consultant', description: 'Consultant', restricted: false },
  { id: '6', code: 'BIZ_CONS', name: 'Business Consultant', description: 'Business Consultant', restricted: false },
  { id: '7', code: 'DESIGN', name: 'Designer', description: 'Designer', restricted: false },
  { id: '8', code: 'UX_DESIGN', name: 'UX Designer', description: 'UX Designer', restricted: false },
];

export const serviceOrganizations: ServiceOrganization[] = [
  { id: '1', code: 'SO_DE', description: 'Service Org Germany', costCenters: ['CC_DE_1', 'CC_DE_2'] },
];

// PHASE F2 — `Resource.organization` is bound to this catalog by NAME. The seeded
// resources carry organization 'Engineering'/'Consulting'/'Design', so add a row per
// name (alongside the original Germany org) to keep existing data a valid SELECT
// option. costCenters reference the configuration cost-centers catalog (CC-9001/9002).
//
// D — the org tree. The four F2 rows keep their ids and names (resources bind
// by NAME and rate cards match on the same value) and become capability roots:
// we do not invent a hierarchy we do not know. PRA-1/COM-1 are a real
// three-level branch so the scope and the filters are exercisable on first boot.
export const resourceOrganizations: ResourceOrganization[] = [
  { id: '1', name: 'Res Org Germany', description: 'Resource Org for Germany', costCenters: ['CC_DE_1', 'CC_DE_2'], serviceOrganizationId: '1', level: 'capability' },
  { id: '2', name: 'Engineering', description: 'Engineering organization', costCenters: ['CC-9001'], serviceOrganizationId: '1', level: 'capability', managerId: '1' },
  { id: '3', name: 'Consulting', description: 'Consulting organization', costCenters: ['CC-9002'], serviceOrganizationId: '1', level: 'capability' },
  { id: '4', name: 'Design', description: 'Design organization', costCenters: [], serviceOrganizationId: '1', level: 'capability' },
  { id: '5', name: 'Platform', description: 'Platform practice, under Engineering', costCenters: [], serviceOrganizationId: '1', level: 'practice', parentId: '2', managerId: '1' },
  { id: '6', name: 'Backend', description: 'Backend competence, under Platform', costCenters: [], serviceOrganizationId: '1', level: 'competence', parentId: '5' },
];

// --- Customizing catalogs (Phase F1 — additive reference data) --------------

// Countries keyed by ISO 3166-1 alpha-2 code. Covers the countries present in
// the existing resource/project/customer location data (US New York, GB London,
// DE Berlin/Munich) plus the principal extras (IT/FR/ES) so F2 can reconcile.
export const countries: Country[] = [
  { code: 'IT', name: 'Italy' },
  { code: 'DE', name: 'Germany' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
];

// Principal Italian cities/comuni (~20) plus the cities present in existing data
// (Berlin/Munich DE, London GB, New York US) so F2 can reconcile project/resource
// locations. Extendable in customizing.
export const cities: City[] = [
  { id: 'CITY_ROMA', name: 'Roma', countryCode: 'IT' },
  { id: 'CITY_MILANO', name: 'Milano', countryCode: 'IT' },
  { id: 'CITY_NAPOLI', name: 'Napoli', countryCode: 'IT' },
  { id: 'CITY_TORINO', name: 'Torino', countryCode: 'IT' },
  { id: 'CITY_PALERMO', name: 'Palermo', countryCode: 'IT' },
  { id: 'CITY_GENOVA', name: 'Genova', countryCode: 'IT' },
  { id: 'CITY_BOLOGNA', name: 'Bologna', countryCode: 'IT' },
  { id: 'CITY_FIRENZE', name: 'Firenze', countryCode: 'IT' },
  { id: 'CITY_BARI', name: 'Bari', countryCode: 'IT' },
  { id: 'CITY_CATANIA', name: 'Catania', countryCode: 'IT' },
  { id: 'CITY_VENEZIA', name: 'Venezia', countryCode: 'IT' },
  { id: 'CITY_VERONA', name: 'Verona', countryCode: 'IT' },
  { id: 'CITY_PADOVA', name: 'Padova', countryCode: 'IT' },
  { id: 'CITY_TRIESTE', name: 'Trieste', countryCode: 'IT' },
  { id: 'CITY_BRESCIA', name: 'Brescia', countryCode: 'IT' },
  { id: 'CITY_PARMA', name: 'Parma', countryCode: 'IT' },
  { id: 'CITY_MODENA', name: 'Modena', countryCode: 'IT' },
  { id: 'CITY_PERUGIA', name: 'Perugia', countryCode: 'IT' },
  { id: 'CITY_CAGLIARI', name: 'Cagliari', countryCode: 'IT' },
  { id: 'CITY_REGGIO_CALABRIA', name: 'Reggio Calabria', countryCode: 'IT' },
  // Cities present in existing project/resource data (for F2 reconciliation).
  { id: 'CITY_BERLIN', name: 'Berlin', countryCode: 'DE' },
  { id: 'CITY_MUNICH', name: 'Munich', countryCode: 'DE' },
  { id: 'CITY_LONDON', name: 'London', countryCode: 'GB' },
  { id: 'CITY_NEW_YORK', name: 'New York', countryCode: 'US' },
];

// PHASE F2 — 'Remote' is an allowed location sentinel (not a physical city). It is
// stored on `Resource.location` for fully-remote staff. Bindings surface it as a
// dedicated "Remote" option (outside the Country>City filter) and the server treats
// it as a valid location value.
export const REMOTE_LOCATION = 'Remote';

// Standard industry list (covers existing customer industries Manufacturing,
// Finance -> Financial Services).
export const industries: Industry[] = [
  { id: 'IND_TECH', name: 'Technology' },
  { id: 'IND_FINSERV', name: 'Financial Services' },
  { id: 'IND_MANUF', name: 'Manufacturing' },
  { id: 'IND_HEALTH', name: 'Healthcare' },
  { id: 'IND_RETAIL', name: 'Retail' },
  { id: 'IND_ENERGY', name: 'Energy & Utilities' },
  { id: 'IND_TELCO', name: 'Telecommunications' },
  { id: 'IND_PUBLIC', name: 'Public Sector' },
  { id: 'IND_PROFSVC', name: 'Professional Services' },
  { id: 'IND_MEDIA', name: 'Media & Entertainment' },
  { id: 'IND_TRANSPORT', name: 'Transportation & Logistics' },
  { id: 'IND_EDU', name: 'Education' },
  { id: 'IND_REALESTATE', name: 'Real Estate' },
  { id: 'IND_PHARMA', name: 'Pharmaceuticals' },
];

// Cost categories (covers existing financial-plan categories: Software Licenses
// -> Software & Licenses, Consulting Services -> Subcontracting, Hardware).
export const costCategories: CostCategory[] = [
  { id: 'CCAT_LABOR', name: 'Labor' },
  { id: 'CCAT_TRAVEL', name: 'Travel & Expenses' },
  { id: 'CCAT_SOFTWARE', name: 'Software & Licenses' },
  { id: 'CCAT_HARDWARE', name: 'Hardware' },
  { id: 'CCAT_SUBCONTRACT', name: 'Subcontracting' },
  { id: 'CCAT_TRAINING', name: 'Training' },
  { id: 'CCAT_FACILITIES', name: 'Facilities' },
  { id: 'CCAT_MARKETING', name: 'Marketing' },
  { id: 'CCAT_OTHER', name: 'Other' },
];

// Partner relationship roles (covers existing project-partner role values:
// 'Development Partner', and 'UI/UX Design' which maps to a Technology Partner).
export const partnerRoles: PartnerRole[] = [
  { id: 'PROLE_DEV', name: 'Development Partner' },
  { id: 'PROLE_SUBCONTRACT', name: 'Subcontractor' },
  { id: 'PROLE_RESELLER', name: 'Reseller' },
  { id: 'PROLE_TECH', name: 'Technology Partner' },
  { id: 'PROLE_STAFFING', name: 'Staffing Agency' },
  { id: 'PROLE_CONSULTING', name: 'Consulting Partner' },
];

// Vendor catalog: partner/supplier companies. Seeded from existing project-partner
// companies (TechCorp Inc., DesignStudio LLC) plus a few plausible others.
export const vendors: Vendor[] = [
  { id: 'V1', name: 'TechCorp Inc.', vatId: 'US-TECH-0001', country: 'US' },
  { id: 'V2', name: 'DesignStudio LLC', vatId: 'US-DSGN-0002', country: 'US' },
  { id: 'V3', name: 'Nordwind Software GmbH', vatId: 'DE-NORD-0003', country: 'DE' },
  { id: 'V4', name: 'Mediolanum Consulting S.r.l.', vatId: 'IT-MEDI-0004', country: 'IT' },
  { id: 'V5', name: 'Albion Cloud Services Ltd', vatId: 'GB-ALBI-0005', country: 'GB' },
];

// RATE CARDS (Phase E) — DEFAULT cost/bill rates per role (base currency EUR).
// A resource's effective rate = its per-resource override ?? the card matching
// its role (and organization, if an org-specific card exists). Generic cards
// (no organization) cover every org; 'RC_DEV_ENG' demonstrates an org-specific
// override that beats the generic Developer card for the Engineering org.
// Hybrid day-rate model: rates are €/DAY (the server converts to €/hour via the
// hoursPerDay setting, default 8). These equal the prior hourly rates × 8, so the
// effective hourly rate — and therefore every margin — is unchanged.
export const rateCards: RateCard[] = [
  { id: 'RC_DEV', role: 'Developer', currency: 'EUR', costRate: 600, billRate: 1120 },
  { id: 'RC_PM', role: 'Project Manager', currency: 'EUR', costRate: 760, billRate: 1520 },
  { id: 'RC_SR_DEV', role: 'Senior Developer', currency: 'EUR', costRate: 760, billRate: 1400 },
  { id: 'RC_BE_ENG', role: 'Backend Engineer', currency: 'EUR', costRate: 680, billRate: 1280 },
  { id: 'RC_CONS', role: 'Consultant', currency: 'EUR', costRate: 720, billRate: 1440 },
  { id: 'RC_BIZ_CONS', role: 'Business Consultant', currency: 'EUR', costRate: 880, billRate: 1680 },
  { id: 'RC_DESIGN', role: 'Designer', currency: 'EUR', costRate: 520, billRate: 960 },
  { id: 'RC_UX_DESIGN', role: 'UX Designer', currency: 'EUR', costRate: 560, billRate: 1040 },
  // Org-specific override: Developers in the Engineering org bill higher.
  { id: 'RC_DEV_ENG', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 640, billRate: 1200 },
];

// Global settings. hoursPerDay converts the €/day rate cards into €/hour.
export const settings: Setting[] = [
  { id: 'hoursPerDay', value: '8' },
];

// PHASE F2 — `location` is bound to the cities catalog (store = city name).
// 'Berlin'/'Munich' are seeded cities (countryCode 'DE').
//
// BLOCK H — `billable` and `type` ARE SPELLED OUT ON EVERY ROW, including the
// two that only ever take the default. This is NOT redundancy: both columns are
// `NOT NULL DEFAULT ...`, so Postgres applies the default on insert and serves
// the field back, while the in-memory adapter stores exactly the literal it was
// given and serves NO key at all. Omitting them here is the C1 divergence
// described at the top of this file — same seed, two different JSON shapes —
// and it was measured on these very rows before this change:
//   Postgres  {"id":"1",...,"billable":true,"type":"Delivery",...}
//   in-memory {"id":"1",...}                       (both keys missing)
// S9 of the design spec says "no change" to '1' and '2'; that instruction is
// wrong on this one point, while its INTENT — that no number of theirs moves —
// is exactly what spelling the defaults out preserves.
export const projects: Project[] = [
  { id: '1', name: 'Project Alpha', location: 'Berlin', startDate: '2026-04-01', endDate: '2026-12-31', status: 'In Planning', description: 'A major software development project.', ownerId: '1', contractId: 'CT1', billable: true, type: 'Delivery' },
  { id: '2', name: 'Project Beta', location: 'Munich', startDate: '2026-05-01', endDate: '2027-05-01', status: 'In Execution', description: 'Infrastructure upgrade project.', ownerId: '1', contractId: 'CT2', billable: true, type: 'Delivery' },
  // S5 — THE BASKET ENGAGEMENT. One per Practice, per the manual; this is
  // Engineering's. NO `contractId`, deliberately and by absence: that is what
  // drops it under the synthetic 'unknown' customer in `customerProfitability`
  // today, which is the permanently loss-making customer row F-5 removes. It
  // carries real staffed cost (requests '15'/'17', approved entries TE5-TE7)
  // and a frozen cost baseline (CB3), because the manual's annual historical
  // plans for AMS/SW Factory/GCC are exactly `costBaselines` on a basket — the
  // one place where "exclude the non-billable from finance" is the tempting
  // OVER-correction (F-4).
  //
  // S7, RECORDED AS A NON-FIXTURE SO ITS ABSENCE IS NOT MISTAKEN FOR A TEST:
  // there is deliberately NO `billingPlanItems` row for project '3'. The
  // assertion that belongs to that absence is a POSITIVE one on the write path
  // (`POST /billing-plan-items` on '3' -> 400, on '1' -> 200), and it lives in
  // the smoke suite, not here. Zero rows in an array prove nothing on their own.
  { id: '3', name: 'BASKET — Engineering Practice', location: 'Milano', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', description: 'Dedicated non-billable engagement for the Engineering practice: AMS duty, technical groups and internal presidio. Consumes cost, earns no customer revenue.', ownerId: '1', billable: false, type: 'Basket' },
  // THE OTHER SIDE OF THE INVARIANT. `type === 'Basket'` implies
  // `billable === false`; the converse is FREE, and this row is the free case:
  // a non-billable internal engagement that is not a basket. It exists so that
  // "excluded because non-billable" and "excluded because Basket" cannot be
  // confused — with only project '3' in the seed, keying every finance
  // exclusion on `type === 'Basket'` (the exactly-backwards reading) passes
  // every test. It carries its own cost (request '18', TE8/TE9) for the same
  // reason project '3' does: an engagement with no approved hours is excluded
  // from the finance surfaces for lack of data, not by the rule under test.
  { id: '4', name: 'Internal — Delivery Control Platform', location: 'Roma', startDate: '2026-01-01', endDate: '2026-12-31', status: 'In Execution', description: 'Internal product work. Not billable, and not a basket — the converse of the Basket invariant.', ownerId: '1', billable: false, type: 'Delivery' },
];

// --- Project sub-resources (seeded on REAL ids 1/2) -------------------------

// PHASE F2 — `company` is bound to the vendors catalog (store = company name) and
// `role` to the partner-roles catalog (store = role name). 'TechCorp Inc.' /
// 'DesignStudio LLC' are seeded vendors; 'Development Partner' / 'Technology Partner'
// are seeded partner-roles ('UI/UX Design' reconciled to 'Technology Partner').
export const projectPartners: Partner[] = [
  { id: 'PT1', projectId: '1', company: 'TechCorp Inc.', role: 'Development Partner', contact: 'Jane Doe', status: 'Active' },
  { id: 'PT2', projectId: '2', company: 'DesignStudio LLC', role: 'Technology Partner', contact: 'John Smith', status: 'Invited' },
];

export const projectDocuments: ProjectDocument[] = [
  // PHASE D — author is an ACTOR field (the document's creator). Reconcile the seed
  // names to existing resources so the displayed authors are real people.
  { id: 'D1', projectId: '1', name: 'Project_Charter_v1.pdf', type: 'pdf', size: '2.4 MB', uploadedAt: '2 days ago', author: 'Julie Armstrong', authorInitials: 'JA' },
  { id: 'D2', projectId: '2', name: 'Requirements_Spec.docx', type: 'word', size: '1.1 MB', uploadedAt: '5 days ago', author: 'John Miller', authorInitials: 'JM' },
];

export const workPackages: WorkPackage[] = [
  { id: 'WP-1.1', projectId: '1', name: 'Requirements Analysis', startDate: '2026-04-01', endDate: '2026-04-15', status: 'Completed', progress: 100, assignee: 'Alice Smith' },
  { id: 'WP-1.2', projectId: '1', name: 'System Architecture Design', startDate: '2026-04-16', endDate: '2026-05-05', status: 'In Progress', progress: 60, assignee: 'Julie Armstrong' },
  { id: 'WP-2.1', projectId: '2', name: 'Frontend Development', startDate: '2026-05-06', endDate: '2026-06-20', status: 'In Progress', progress: 40, assignee: 'Alice Smith' },
];

export const milestones: Milestone[] = [
  { id: 'M1', projectId: '1', name: 'Project Kickoff', date: '2026-04-01', status: 'Achieved' },
  { id: 'M2', projectId: '1', name: 'Go-Live', date: '2026-12-01', status: 'Pending' },
  { id: 'M3', projectId: '2', name: 'Architecture Approved', date: '2026-05-20', status: 'Pending' },
];

// PHASE F2 — `category` is bound to the cost-categories catalog (store = name).
// 'Software & Licenses' / 'Subcontracting' / 'Hardware' are seeded categories
// ('Software Licenses' -> 'Software & Licenses', 'Consulting Services' -> 'Subcontracting').
export const projectFinancials: FinancialItem[] = [
  { id: 'F1', projectId: '1', category: 'Software & Licenses', budget: 20000, actual: 18500 },
  { id: 'F2', projectId: '1', category: 'Subcontracting', budget: 50000, actual: 25000 },
  { id: 'F3', projectId: '2', category: 'Hardware', budget: 10000, actual: 11200 },
];

export const projectCostCenters: ProjectCostCenter[] = [
  { id: 'CC-1001', projectId: '1', name: 'Engineering & Dev', manager: 'Alice Smith', allocated: 150000, actual: 125000 },
  // PHASE D — manager is a PERSON reference to the resources catalog; reconcile the
  // orphan names ('Bob Jones'/'Charlie Brown') to existing resources.
  { id: 'CC-1002', projectId: '1', name: 'Design & UX', manager: 'John Miller', allocated: 50000, actual: 48000 },
  { id: 'CC-1003', projectId: '2', name: 'Quality Assurance', manager: 'Julie Armstrong', allocated: 40000, actual: 42000 },
];

export const projectTasks: Task[] = [
  // PHASE D — assignee is a PERSON reference to the resources catalog (or 'Unassigned').
  // Reconcile the orphan names ('Jane Doe'/'John Smith') to existing resources.
  { id: 'T1', projectId: '1', name: 'Finalize Requirements Document', assignee: 'Julie Armstrong', assigneeType: 'Subcontractor', partnerId: 'PT1', dueDate: '2026-04-15', status: 'Done', priority: 'High' },
  // Internal tasks have no partner. partnerId is a nullable FK to project_partners;
  // omit it (-> NULL) rather than '' so the Postgres FK is satisfied (an empty
  // string is a non-NULL value with no matching partner row).
  { id: 'T2', projectId: '1', name: 'Design Database Schema', assignee: 'John Miller', assigneeType: 'Internal', dueDate: '2026-04-25', status: 'In Progress', priority: 'Medium' },
  { id: 'T3', projectId: '2', name: 'Setup CI/CD Pipeline', assignee: 'Unassigned', assigneeType: 'Internal', dueDate: '2026-05-05', status: 'To Do', priority: 'Medium' },
];

export const projectIssues: Issue[] = [
  // PHASE D — reportedBy/owner are PERSON references to the resources catalog. Reconcile
  // the orphan reportedBy names ('Jane Doe'/'John Smith'/'Alice Johnson') to existing
  // resources; owners were already valid resource names.
  { id: 'I1', projectId: '1', title: 'API Rate Limiting', type: 'Bug', severity: 'High', status: 'Open', reportedBy: 'Julie Armstrong', owner: 'Julie Armstrong', dueDate: '2026-05-15', impact: 'May slow integration testing', actionPlan: 'Add rate-limit handling and retry policy', escalated: true },
  { id: 'I2', projectId: '1', title: 'Delay in Hardware Delivery', type: 'Risk', severity: 'Medium', status: 'Mitigated', reportedBy: 'John Miller', owner: 'John Miller', dueDate: '2026-05-20', impact: 'Potential schedule slippage', actionPlan: 'Use cloud test environment until hardware arrives', escalated: false },
  { id: 'I3', projectId: '2', title: 'UI Inconsistencies', type: 'Bug', severity: 'Low', status: 'Open', reportedBy: 'Alice Smith', owner: 'Alice Smith', dueDate: '2026-06-01', impact: 'Client acceptance friction', actionPlan: 'Run design QA pass', escalated: false },
];

export const changeRequests: ChangeRequest[] = [
  { id: 'CR1', projectId: '1', title: 'Extend integration scope', description: 'Add one extra external API integration requested by the customer.', requestedBy: 'Julie Armstrong', owner: 'Alice Smith', status: 'Submitted', impactScope: 'Additional interface and test cycle', impactBudget: 12000, impactScheduleDays: 8, priority: 'High', createdAt: '2026-04-20T10:00:00.000Z' },
  { id: 'CR2', projectId: '2', title: 'Defer reporting automation', description: 'Move reporting automation to phase 2 to protect go-live.', requestedBy: 'John Miller', owner: 'Julie Armstrong', status: 'Approved', impactScope: 'Scope moved to later release', impactBudget: -5000, impactScheduleDays: -3, priority: 'Medium', createdAt: '2026-05-05T11:30:00.000Z', decidedBy: '1', decidedAt: '2026-05-06T09:00:00.000Z' },
];

// Configuration-level cost centers (B16)
// PHASE F2 — this catalog is the source for the project-cost-center `id` SELECT
// (selecting a cost center fills+locks the id and derives the name) and the
// resource-organizations `costCenters[]` multi-select. The CC-1001/1002/1003 rows
// are added so the seeded project cost centers (which reference those ids) resolve
// to a real catalog cost center and stay valid SELECT options.
export const costCenters: CostCenter[] = [
  // PHASE D — manager is a PERSON reference to the resources catalog; reconcile the
  // orphan names ('Dana White'/'Erik Stone') to existing resources.
  { id: 'CC-9001', name: 'Corporate IT', manager: 'Alice Smith', allocated: 200000, actual: 150000 },
  { id: 'CC-9002', name: 'Shared Services', manager: 'John Miller', allocated: 80000, actual: 64000 },
  { id: 'CC-1001', name: 'Engineering & Dev', manager: 'Alice Smith', allocated: 150000, actual: 125000 },
  { id: 'CC-1002', name: 'Design & UX', manager: 'John Miller', allocated: 50000, actual: 48000 },
  { id: 'CC-1003', name: 'Quality Assurance', manager: 'Julie Armstrong', allocated: 40000, actual: 42000 },
];

// --- Commercial domain (ADR-0001): Customers, Contracts, Orders, OrderLines ---

// PHASE F2 — `industry` is bound to the industries catalog (store = name) and
// `country` to the countries catalog (store = country NAME, matching the seeded
// display). 'Manufacturing' / 'Financial Services' are seeded industries ('Finance'
// -> 'Financial Services'); 'Germany' / 'United Kingdom' are seeded country names.
export const customers: Customer[] = [
  { id: 'C1', name: 'Globex Corp', industry: 'Manufacturing', country: 'Germany' },
  { id: 'C2', name: 'Initech', industry: 'Financial Services', country: 'United Kingdom' },
];

export const contracts: Contract[] = [
  { id: 'CT1', customerId: 'C1', name: 'Globex Digital Transformation', type: 'Fixed Price', totalValue: 500000, currency: 'EUR', status: 'Active', startDate: '2026-01-01', endDate: '2026-12-31' },
  // MULTI-CURRENCY DEMO: CT2 (and its orders + billing items below) is denominated
  // in USD end-to-end, so portfolio rollups must convert via fx-rates before summing.
  { id: 'CT2', customerId: 'C2', name: 'Initech T&M Framework', type: 'T&M', totalValue: 300000, currency: 'USD', status: 'Active', startDate: '2026-03-01', endDate: '2027-02-28' },
];

// The sell price is negotiated per contract, and a single project inside a
// framework can override it (design spec §3). CT2 is the seed's T&M contract —
// the only type whose revenue is hours × rate, so the only one where a negotiated
// rate is observable at all (spec §11). Project '2' hangs off CT2, which is what
// makes the override demonstrable. 1000/day is BELOW the Developer card's
// 1120/day on purpose, so the seed shows a negotiated DISCOUNT rather than a
// figure that could be mistaken for the card's own.
//
// UNITS: 1000/1150 are EUR per DAY, like the cards. `sellRateFor` divides by the
// `hoursPerDay` setting (8 below) to reach the EUR/HOUR that hours are multiplied
// by — 1150/day is 143.75/h, NOT 1150/h. Time entry TE4 above is the seeded row
// that exercises this: see its comment for the expected figures.
export const negotiatedRates: NegotiatedRate[] = [
  { id: 'NR_CT2_DEV', contractId: 'CT2', role: 'Developer', currency: 'EUR', billRate: 1000 },
  { id: 'NR_P2_DEV', projectId: '2', role: 'Developer', currency: 'EUR', billRate: 1150 },
];

// COST BASELINES (design spec, block E) — frozen monthly PCP snapshot.
// 'CB1' undercounts October: the live plan (720, see assignment '12' above)
// exceeds it -> delta +120 EUR / +20.00%, the "spending more than planned"
// case this block exists to surface.
// 'CB2' has NO assignmentDay in project '1' for November in this seed ->
// planned = 0, delta = 0 - 500 = -500 EUR, deltaPct = -100.00% (rendered
// normally, NEVER an em dash: the baseline here is 500, not 0, so the
// "null only when baseline = 0" rule (design spec §4 line 139 / §9) does not
// apply — the whole baseline evaporated, which is the loudest variance this
// block exists to surface) — the descoped-month case (design spec §4). This
// holds across block F's assignments '7'-'11' too (all on project '1', all
// Jan-Sep 2026) — none of them reaches November either.
// Free, from existing seed data: assignments '1'/'2' of project '1' (May-Aug
// 2026) carry no cost_baselines row at all, exercising
// outOfBaselineHorizon: true for those four months with no new fixture.
export const costBaselines: CostBaseline[] = [
  { id: 'CB1', projectId: '1', period: '2026-10', amount: 600, frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4' },
  { id: 'CB2', projectId: '1', period: '2026-11', amount: 500, frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4' },
  // BLOCK H / S6 — the same mechanism ON A NON-BILLABLE BASKET, which is the
  // manual's "annual plan on a historical basis" for AMS / SW Factory / GCC
  // (design spec §2.5). This row is the assertion against the OVER-correction:
  // F-4 says `plannedCostSchedule` and `costBaselineComparison` must keep
  // working on a basket engagement, and only a baseline that actually sits on
  // one can catch a blanket "exclude the non-billable from finance".
  //
  // April 2026 on project '3' is staffed by BOTH its assignments — Sofia 176h
  // and the placeholder 88h — and both resolve to 80 EUR/h:
  //   live plan = (176 + 88) x 80 = 21,120.00 EUR
  //   baseline  =                   20,000.00 EUR
  //   delta     =                   +1,120.00 EUR  /  +5.60%
  { id: 'CB3', projectId: '3', period: '2026-04', amount: 20000, frozenAt: '2026-03-20T09:00:00.000Z', frozenBy: '4' },
];

export const orders: Order[] = [
  // Customer orders carry no partner. partnerId is a nullable FK to
  // project_partners; omit it (-> NULL) rather than '' so the Postgres FK holds
  // (an empty string is a non-NULL value with no matching partner row). This
  // also matches the API rule that Customer orders must not set a partnerId.
  { id: 'O1', contractId: 'CT1', type: 'Customer', amount: 200000, currency: 'EUR', status: 'Invoiced', orderDate: '2026-02-01', invoiceNumber: 'INV-2026-0001', invoiceDate: '2026-02-01' },
  { id: 'O2', contractId: 'CT1', type: 'Purchase', partnerId: 'PT1', amount: 50000, currency: 'EUR', status: 'Confirmed', orderDate: '2026-02-15' },
  // MULTI-CURRENCY DEMO: O3 belongs to USD contract CT2, so it carries USD too.
  { id: 'O3', contractId: 'CT2', type: 'Customer', amount: 120000, currency: 'USD', status: 'Open', orderDate: '2026-03-10' },
];

export const orderLines: OrderLine[] = [
  { id: 'OL1', orderId: 'O1', projectId: '1', description: 'Phase 1 delivery', amount: 200000 },
  { id: 'OL2', orderId: 'O2', projectId: '1', description: 'Subcontracted development', amount: 50000 },
  { id: 'OL3', orderId: 'O3', projectId: '2', description: 'UI/UX work package', amount: 120000 },
];

// One representative item PER BillingType, tied to existing contracts/projects.
// Milestone item points at an existing milestone ('M2' Go-Live on project '1').
export const billingPlanItems: BillingPlanItem[] = [
  { id: 'BP1', contractId: 'CT1', projectId: '1', type: 'Milestone', label: 'SAL Go-Live milestone', milestoneId: 'M2', expectedDate: '2026-12-01', amount: 150000, retentionPct: 10, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Planned' },
  // MULTI-CURRENCY DEMO: BP2/BP3/BP4/BP7 bill against USD contract CT2, so they are in USD.
  { id: 'BP2', contractId: 'CT2', projectId: '2', type: 'Recurring', label: 'Monthly retainer', recurrence: 'Monthly', expectedDate: '2026-03-31', amount: 12000, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Invoiced', issuedDate: '2026-03-31', dueDate: '2026-04-30', orderId: 'O3' },
  { id: 'BP3', contractId: 'CT2', projectId: '2', type: 'TimeAndMaterials', label: 'T&M consuntivo Q1', expectedDate: '2026-04-15', amount: 28500, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Ready' },
  { id: 'BP4', contractId: 'CT2', projectId: '2', type: 'Capped', label: 'T&M capped work package', expectedDate: '2026-06-30', amount: 45000, capAmount: 50000, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Planned' },
  { id: 'BP5', contractId: 'CT1', projectId: '1', type: 'Advance', label: 'Down payment / acconto', expectedDate: '2026-01-15', amount: 100000, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Paid', issuedDate: '2026-01-15', dueDate: '2026-02-14', paidDate: '2026-02-10', orderId: 'O1' },
  { id: 'BP6', contractId: 'CT1', projectId: '1', type: 'Progress', label: 'Progress billing (POC 60%)', progressPct: 60, expectedDate: '2026-07-01', amount: 90000, retentionPct: 10, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Ready' },
  { id: 'BP7', contractId: 'CT2', projectId: '2', type: 'Expense', label: 'Re-billed travel expenses', markupPct: 5, expectedDate: '2026-05-10', amount: 3200, taxRatePct: 22, paymentTermsDays: 30, currency: 'USD', status: 'Planned' },
  { id: 'BP8', contractId: 'CT1', projectId: '1', type: 'CreditNote', label: 'Credit note / nota di credito', expectedDate: '2026-08-01', amount: -5000, taxRatePct: 22, paymentTermsDays: 30, currency: 'EUR', status: 'Planned', notes: 'Adjustment for descoped feature' },
];

// --- Multi-currency foundation ----------------------------------------------

/**
 * FX rates expressed as the base-currency (EUR) value of 1 unit of `currency`.
 * EUR is the base, so its rateToBase is 1. Rollups that span currencies must
 * convert each amount via `amount * rateToBase` before summing.
 */
export const fxRates: FxRate[] = [
  { currency: 'EUR', rateToBase: 1 },
  { currency: 'USD', rateToBase: 0.92 },
  { currency: 'GBP', rateToBase: 1.17 },
];

// --- Approval workflow engine -----------------------------------------------

/**
 * Seeded approval requests. In server.ts these are produced by a `seed()`
 * helper that materialises the server-derived fields from the static input:
 *   - status      -> always 'Pending' at seed time
 *   - steps        -> buildApprovalSteps(kind, amount): a high-value item
 *                     (amount > 50000) routes to ['delivery-executive',
 *                     'finance']; otherwise a single approver is chosen by kind
 *                     (TimeEntry/Expense -> resource-manager;
 *                      Milestone/ChangeRequest -> delivery-executive;
 *                      Invoice -> finance). Each step starts 'Pending'.
 *   - currentStep  -> 0
 *   - slaDueAt     -> createdAt + 3 days (APPROVAL_SLA_DAYS), ISO string
 * The derived values are inlined here verbatim so the seed is self-contained
 * and does not depend on server.ts internals.
 */
export const approvalRequests: ApprovalRequest[] = [
  // AR1: TimeEntry, no amount -> single resource-manager step. SLA = createdAt + 3d.
  { id: 'AR1', kind: 'TimeEntry', refId: 'TE3', projectId: '1', requestedBy: '1', createdAt: '2026-04-08T16:00:00.000Z', note: 'Submitted hours pending approval',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-04-11T16:00:00.000Z',
    steps: [{ role: 'resource-manager', status: 'Pending' }] },
  // AR2: Invoice, amount 120000 > 50000 -> high-value chain delivery-executive then finance.
  { id: 'AR2', kind: 'Invoice', refId: 'O3', projectId: '2', amount: 120000, requestedBy: '5', createdAt: '2026-03-11T09:00:00.000Z', note: 'Customer invoice over high-value threshold',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-03-14T09:00:00.000Z',
    steps: [{ role: 'delivery-executive', status: 'Pending' }, { role: 'finance', status: 'Pending' }] },
  // AR3: ChangeRequest, amount 12000 (not high-value) -> single delivery-executive step.
  { id: 'AR3', kind: 'ChangeRequest', refId: 'CR1', projectId: '1', amount: 12000, requestedBy: '3', createdAt: '2026-04-20T10:30:00.000Z', note: 'Scope extension awaiting delivery sign-off',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-04-23T10:30:00.000Z',
    steps: [{ role: 'delivery-executive', status: 'Pending' }] },
  // AR4: Allocation (B3). refId is the MONTH ROW id, not an assignment id —
  // this is the pending month the People Manager page opens on.
  { id: 'AR4', kind: 'Allocation', refId: '2:2026-08', projectId: '1', requestedBy: '3', createdAt: '2026-07-28T08:00:00.000Z', note: 'Extra month to cover the migration cut-over',
    status: 'Pending', currentStep: 0, slaDueAt: '2026-07-31T08:00:00.000Z',
    steps: [{ role: 'resource-manager', status: 'Pending' }] },
];

// --- Audit log --------------------------------------------------------------

/**
 * The audit log is APPEND-ONLY and starts EMPTY: server.ts initialises
 * `auditLogStore` as `{ items: [] }` and only ever prepends runtime entries.
 */
export const auditLogs: AuditLog[] = [];
