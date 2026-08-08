/**
 * The RPT .xlsx reports, as pure functions over plain data.
 *
 * RPT ships three Excel reports and the SHAPE of the workbook is part of
 * the requirement, not decoration (`docs/rpt-comparison.md`, matrix rows 24, 44, 53):
 *
 *  1. **Pianificazione** (PM) — ONE sheet: every commessa with its plan, its details
 *     and its monthly costs.
 *  2. **Allocazione** (People Manager) — TWO sheets: `Allocazione - Dettaglio`, per
 *     resource with its plans and monthly costs SPLIT BY COMMESSA, and
 *     `Allocazione - Testata`, per resource with the monthly costs AGGREGATED,
 *     commessa-agnostic.
 *  3. **Unchargeable** — FOUR sheets, one per aging category (A/B/C/D), sourced from
 *     the bench rollup (`bench.util.ts`) and triggered from the bench screen. See
 *     {@link unchargeableSheets}.
 *
 * No Angular, no DI, no component state — the caller passes the data it has already
 * loaded and gets {@link XlsxSheet}s back, so the row/column/aggregation logic is
 * unit-testable without a TestBed and the same builder can serve any screen.
 */

import type {
  Assignment, AssignmentDay, AssignmentMonth, Project, Resource, ResourceRequest,
} from './api.service';
import { monthRowId } from './allocation-month.util';
import { IDLE_WORKING_DAYS_B_MAX, IDLE_WORKING_DAYS_C_MAX } from './absence.util';
import type { AvailabilityDate, BenchRollup, BenchRow, BenchState, UnallocatedAgingBucket } from './bench.util';
import { XlsxColumn, XlsxSheet, xlsxNum, xlsxSheet } from './export.util';
import { hasMeasuredMarginPct } from './finance.util';
import { ancestorChain, nodeByName, type OrgLevel, type OrgNode } from './org-scope.util';

/** Sheet names — fixed by the RPT report definition, not ours to prettify. */
export const SHEET_PIANIFICAZIONE = 'Pianificazione';
export const SHEET_ALLOCAZIONE_DETTAGLIO = 'Allocazione - Dettaglio';
export const SHEET_ALLOCAZIONE_TESTATA = 'Allocazione - Testata';
export const SHEET_UNCHARGEABLE_A = 'Unchargeable A';
export const SHEET_UNCHARGEABLE_B = 'Unchargeable B';
export const SHEET_UNCHARGEABLE_C = 'Unchargeable C';
export const SHEET_UNCHARGEABLE_D = 'Unchargeable D';

/** Money format: thousands separator + exactly 2 decimals (the project-wide cap). */
const FMT_MONEY = '#,##0.00';
/** Quantity format (hours, days, FTE, percentages): 2 decimals, no grouping. */
const FMT_QTY = '0.00';

/** Label for a commessa-less booking, so the hours are never silently dropped. */
const NO_PROJECT = '(no commessa)';

/**
 * The slice of the reporting envelope these reports read. Structurally a subset of
 * `reporting.ts`'s `ReportingData`, so the component passes its loaded value through
 * unchanged — and a spec can build a five-line fixture.
 */
export interface RptPlanData {
  projects: readonly Project[];
  requests: readonly ResourceRequest[];
  assignments: readonly Assignment[];
  assignmentDays: readonly AssignmentDay[];
  assignmentMonths: readonly AssignmentMonth[];
  resources: readonly Resource[];
}

/** Units and labels shared by both reports. */
export interface RptOpts {
  /** Reporting/base currency code, for the money column headers. */
  currency: string;
  /** Working hours per day — the divisor that turns planned hours into planned days. */
  hoursPerDay: number;
}

/**
 * Per-commessa financial summary for the Pianificazione sheet's "dettagli" columns.
 *
 * Structurally the subset of `reporting.ts`'s `marginRows()` element that this sheet
 * reports, so the component hands its own rows over as-is: the exported figures are
 * BY CONSTRUCTION the ones on screen, never a second derivation that can drift.
 */
export interface RptProjectFinancials {
  id: string;
  revenue: number;
  laborCost: number;
  externalCost: number;
  expenseCost: number;
  margin: number;
  marginPct: number;
  eac: number;
  vac: number;
  pcpBaseline: number;
  pcpPlanned: number;
  pcpDelta: number;
}

/** One (resource x commessa) line of the plan, with its monthly hours and costs. */
export interface AllocationCubeRow {
  resourceId: string;
  resourceName: string;
  organization: string;
  jobRole: string;
  projectId: string;
  projectName: string;
  hoursByMonth: ReadonlyMap<string, number>;
  costByMonth: ReadonlyMap<string, number>;
  totalHours: number;
  totalCost: number;
}

/** The cube plus the month axis every sheet's columns are laid out on. */
export interface AllocationCube {
  /** Every month with at least one planned hour, ascending. */
  months: readonly string[];
  /** (resource x commessa) rows, ordered by resource name then commessa name. */
  rows: readonly AllocationCubeRow[];
}

/** 'YYYY-MM-DD' -> 'YYYY-MM'. */
function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

const MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** 'YYYY-MM' -> 'Mar 26'. Falls back to the raw key if it is not a parsable month. */
export function monthLabel(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? month : MONTH_FMT.format(d);
}

function add(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/**
 * The (resource x commessa x month) planned-effort and planned-cost cube — the single
 * reduction all three sheets read, so a figure can never disagree between them.
 *
 * The rule is `plannedCostSchedule`'s (finance.util), deliberately reproduced rather
 * than approximated, because this cube slices the same population three ways and that
 * helper only accepts a `{ projectId }`:
 *
 *  - a day counts only when its OWNING (assignment, month) row is 'Allocated' or
 *    'Requested' — the same `planned` bucket `monthlyAggregateHours` uses. 'Draft',
 *    'Rejected' and a missing row count zero, because they are not a plan yet;
 *  - a counted day is priced at its resource's `costRate`, which the server resolves
 *    to **EUR/HOUR** (override ?? rate card, already divided by hours-per-day). Do not
 *    hand this the EUR/DAY column — the figures come out ~8x.
 *
 * `rpt-xlsx.util.spec.ts` asserts the per-project monthly totals equal
 * `plannedCostSchedule`'s for the same fixture, so the two cannot drift apart.
 */
export function allocationCube(data: RptPlanData): AllocationCube {
  const projectByRequest = new Map(data.requests.map((r) => [r.id, r.projectId]));
  const projectNameById = new Map(data.projects.map((p) => [p.id, p.name]));
  const assignmentById = new Map(data.assignments.map((a) => [a.id, a]));
  const resourceById = new Map(data.resources.map((r) => [r.id, r]));
  const monthStatus = new Map(data.assignmentMonths.map((m) => [m.id, m.status]));

  const hours = new Map<string, Map<string, number>>();
  const cost = new Map<string, Map<string, number>>();
  const meta = new Map<string, { resource: Resource | undefined; resourceId: string; projectId: string }>();
  const months = new Set<string>();

  for (const day of data.assignmentDays) {
    const assignment = assignmentById.get(day.assignmentId);
    if (assignment === undefined) continue;
    const month = monthOf(day.date);
    const status = monthStatus.get(monthRowId(day.assignmentId, month));
    if (status !== 'Allocated' && status !== 'Requested') continue;
    const dayHours = Number.isFinite(day.hours) ? day.hours : 0;

    const resource = resourceById.get(assignment.resourceId);
    const projectId = projectByRequest.get(assignment.requestId) ?? '';
    // '\0' as an escape, NOT a literal NUL byte in the source. A NUL is the
    // right separator here — no id can contain one, so the composite key is
    // unambiguous — but writing it raw made git classify this whole file as
    // BINARY: no line diff, no line-level merge, and grep silently skips it.
    // (That last one is not hypothetical: a repo-wide grep for a symbol in
    // this file came back empty while the symbol was on line 295.) The
    // runtime string is byte-for-byte identical.
    const key = `${assignment.resourceId}\0${projectId}`;
    if (!meta.has(key)) meta.set(key, { resource, resourceId: assignment.resourceId, projectId });
    if (!hours.has(key)) hours.set(key, new Map());
    if (!cost.has(key)) cost.set(key, new Map());

    add(hours.get(key)!, month, dayHours);
    add(cost.get(key)!, month, dayHours * (resource?.costRate ?? 0));
    months.add(month);
  }

  const rows: AllocationCubeRow[] = [...meta.entries()].map(([key, m]) => {
    const hoursByMonth = hours.get(key) ?? new Map<string, number>();
    const costByMonth = cost.get(key) ?? new Map<string, number>();
    const sum = (map: ReadonlyMap<string, number>): number => [...map.values()].reduce((s, v) => s + v, 0);
    return {
      resourceId: m.resourceId,
      resourceName: m.resource?.name ?? m.resourceId,
      organization: m.resource?.organization ?? '',
      jobRole: m.resource?.role ?? '',
      projectId: m.projectId,
      projectName: m.projectId === '' ? NO_PROJECT : projectNameById.get(m.projectId) ?? m.projectId,
      hoursByMonth,
      costByMonth,
      totalHours: sum(hoursByMonth),
      totalCost: sum(costByMonth),
    };
  });

  rows.sort((a, b) => a.resourceName.localeCompare(b.resourceName) || a.projectName.localeCompare(b.projectName));
  return { months: [...months].sort(), rows };
}

/** Appends one `<Mon YY> <suffix>` column per month, reading `pick` for the figure. */
function monthColumns<T>(
  months: readonly string[],
  suffix: string,
  numFmt: string,
  pick: (row: T, month: string) => number,
): XlsxColumn<T>[] {
  return months.map((m) => ({
    header: `${monthLabel(m)} ${suffix}`,
    value: (row: T) => xlsxNum(pick(row, m)),
    width: 13,
    numFmt,
  }));
}

/**
 * Report 1 — **Pianificazione** (PM): one sheet, one row per commessa, with the plan
 * (hours/days), the commercial and margin details, and one planned-cost column per
 * month.
 *
 * The row universe is the COMMESSA MASTER, not the set of commesse that happen to
 * carry a booking: a commessa opened and not yet staffed is precisely what a PM opens
 * this report to notice.
 */
export function planningSheet(
  data: RptPlanData,
  financials: readonly RptProjectFinancials[],
  opts: RptOpts,
): XlsxSheet {
  const cube = allocationCube(data);
  const cur = opts.currency;
  const hoursPerDay = opts.hoursPerDay > 0 ? opts.hoursPerDay : 8;

  // Fold the (resource x commessa) cube down to one line per commessa.
  const byProject = new Map<string, { hours: Map<string, number>; cost: Map<string, number>; resources: Set<string> }>();
  for (const row of cube.rows) {
    let agg = byProject.get(row.projectId);
    if (agg === undefined) {
      agg = { hours: new Map(), cost: new Map(), resources: new Set() };
      byProject.set(row.projectId, agg);
    }
    agg.resources.add(row.resourceId);
    for (const [m, h] of row.hoursByMonth) add(agg.hours, m, h);
    for (const [m, c] of row.costByMonth) add(agg.cost, m, c);
  }

  const financialsById = new Map(financials.map((f) => [f.id, f]));

  interface Line {
    project: Project;
    hours: Map<string, number>;
    cost: Map<string, number>;
    headcount: number;
    totalHours: number;
    totalCost: number;
    fin: RptProjectFinancials | undefined;
  }

  const empty = new Map<string, number>();
  const lines: Line[] = [...data.projects]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((project) => {
      const agg = byProject.get(project.id);
      const hours = agg?.hours ?? empty;
      const cost = agg?.cost ?? empty;
      return {
        project,
        hours,
        cost,
        headcount: agg?.resources.size ?? 0,
        totalHours: [...hours.values()].reduce((s, v) => s + v, 0),
        totalCost: [...cost.values()].reduce((s, v) => s + v, 0),
        fin: financialsById.get(project.id),
      };
    });

  const columns: XlsxColumn<Line>[] = [
    { header: 'Commessa', value: (l) => l.project.name, width: 30 },
    { header: 'Commessa Code', value: (l) => l.project.id, width: 16 },
    { header: 'Status', value: (l) => l.project.status, width: 14 },
    { header: 'Start', value: (l) => l.project.startDate, width: 12 },
    { header: 'End', value: (l) => l.project.endDate, width: 12 },
    { header: 'Location', value: (l) => l.project.location, width: 16 },
    { header: 'Resources Planned', value: (l) => l.headcount, width: 12, numFmt: '0' },
    { header: 'Planned Hours', value: (l) => xlsxNum(l.totalHours), width: 13, numFmt: FMT_QTY },
    { header: 'Planned Days', value: (l) => xlsxNum(l.totalHours / hoursPerDay), width: 12, numFmt: FMT_QTY },
    { header: `Planned Cost (${cur})`, value: (l) => xlsxNum(l.totalCost), width: 15, numFmt: FMT_MONEY },
    { header: `Revenue (${cur})`, value: (l) => xlsxNum(l.fin?.revenue), width: 15, numFmt: FMT_MONEY },
    { header: `Labor Cost (${cur})`, value: (l) => xlsxNum(l.fin?.laborCost), width: 15, numFmt: FMT_MONEY },
    { header: `External Cost (${cur})`, value: (l) => xlsxNum(l.fin?.externalCost), width: 15, numFmt: FMT_MONEY },
    { header: `Expense Cost (${cur})`, value: (l) => xlsxNum(l.fin?.expenseCost), width: 15, numFmt: FMT_MONEY },
    { header: `Margin (${cur})`, value: (l) => xlsxNum(l.fin?.margin), width: 15, numFmt: FMT_MONEY },
    // An EMPTY cell, not 0, when there is no revenue to be a percentage of —
    // finance.util's `marginPct` is a sentinel there, not a measurement
    // (hasMeasuredMarginPct). `null` is the right shape for it in a workbook and
    // strictly better than the em dash the CSVs use: Excel skips empty cells in
    // =AVERAGE()/=SUM(), where a 0 would silently drag a portfolio average down,
    // and unlike a dash it does not turn a numeric column into text.
    { header: 'Margin %', value: (l) => (l.fin && hasMeasuredMarginPct(l.fin.revenue) ? xlsxNum(l.fin.marginPct) : null), width: 10, numFmt: FMT_QTY },
    { header: `EAC (${cur})`, value: (l) => xlsxNum(l.fin?.eac), width: 15, numFmt: FMT_MONEY },
    { header: `VAC (${cur})`, value: (l) => xlsxNum(l.fin?.vac), width: 15, numFmt: FMT_MONEY },
    { header: `PCP Baseline (${cur})`, value: (l) => xlsxNum(l.fin?.pcpBaseline), width: 16, numFmt: FMT_MONEY },
    { header: `PCP Planned (${cur})`, value: (l) => xlsxNum(l.fin?.pcpPlanned), width: 16, numFmt: FMT_MONEY },
    { header: `PCP Delta (${cur})`, value: (l) => xlsxNum(l.fin?.pcpDelta), width: 15, numFmt: FMT_MONEY },
    ...monthColumns<Line>(cube.months, `Cost (${cur})`, FMT_MONEY, (l, m) => l.cost.get(m) ?? 0),
  ];

  return xlsxSheet(SHEET_PIANIFICAZIONE, lines, columns);
}

/**
 * Report 2 — **Allocazione** (People Manager): the TWO sheets RPT produces, in order.
 *
 * `Allocazione - Dettaglio` is the cube verbatim — one row per (resource, commessa),
 * hours and cost per month. `Allocazione - Testata` collapses the commessa dimension
 * away — one row per resource, the SUM of that resource's per-commessa figures for
 * each month. Testata is therefore strictly narrower than Dettaglio, never a copy of
 * it: a resource on three commesse has three Dettaglio rows and exactly one Testata
 * row whose monthly figure is the total of the three.
 */
export function allocationSheets(data: RptPlanData, opts: RptOpts): XlsxSheet[] {
  const cube = allocationCube(data);
  const cur = opts.currency;
  const hoursPerDay = opts.hoursPerDay > 0 ? opts.hoursPerDay : 8;

  const detail: XlsxColumn<AllocationCubeRow>[] = [
    { header: 'Resource Code', value: (r) => r.resourceId, width: 16 },
    { header: 'Resource', value: (r) => r.resourceName, width: 26 },
    { header: 'Organization', value: (r) => r.organization, width: 22 },
    { header: 'Job Role', value: (r) => r.jobRole, width: 22 },
    { header: 'Commessa', value: (r) => r.projectName, width: 30 },
    { header: 'Commessa Code', value: (r) => r.projectId, width: 16 },
    ...monthColumns<AllocationCubeRow>(cube.months, 'Hours', FMT_QTY, (r, m) => r.hoursByMonth.get(m) ?? 0),
    ...monthColumns<AllocationCubeRow>(cube.months, `Cost (${cur})`, FMT_MONEY, (r, m) => r.costByMonth.get(m) ?? 0),
    { header: 'Total Hours', value: (r) => xlsxNum(r.totalHours), width: 13, numFmt: FMT_QTY },
    { header: 'Total Days', value: (r) => xlsxNum(r.totalHours / hoursPerDay), width: 12, numFmt: FMT_QTY },
    { header: `Total Cost (${cur})`, value: (r) => xlsxNum(r.totalCost), width: 15, numFmt: FMT_MONEY },
  ];

  interface Head {
    resourceId: string;
    resourceName: string;
    organization: string;
    jobRole: string;
    commesse: number;
    hoursByMonth: Map<string, number>;
    costByMonth: Map<string, number>;
    totalHours: number;
    totalCost: number;
  }

  const heads = new Map<string, Head>();
  for (const row of cube.rows) {
    let head = heads.get(row.resourceId);
    if (head === undefined) {
      head = {
        resourceId: row.resourceId,
        resourceName: row.resourceName,
        organization: row.organization,
        jobRole: row.jobRole,
        commesse: 0,
        hoursByMonth: new Map(),
        costByMonth: new Map(),
        totalHours: 0,
        totalCost: 0,
      };
      heads.set(row.resourceId, head);
    }
    head.commesse += 1;
    head.totalHours += row.totalHours;
    head.totalCost += row.totalCost;
    for (const [m, h] of row.hoursByMonth) add(head.hoursByMonth, m, h);
    for (const [m, c] of row.costByMonth) add(head.costByMonth, m, c);
  }

  const headRows = [...heads.values()].sort((a, b) => a.resourceName.localeCompare(b.resourceName));

  const header: XlsxColumn<Head>[] = [
    { header: 'Resource Code', value: (r) => r.resourceId, width: 16 },
    { header: 'Resource', value: (r) => r.resourceName, width: 26 },
    { header: 'Organization', value: (r) => r.organization, width: 22 },
    { header: 'Job Role', value: (r) => r.jobRole, width: 22 },
    { header: 'Commesse', value: (r) => r.commesse, width: 10, numFmt: '0' },
    ...monthColumns<Head>(cube.months, 'Hours', FMT_QTY, (r, m) => r.hoursByMonth.get(m) ?? 0),
    ...monthColumns<Head>(cube.months, `Cost (${cur})`, FMT_MONEY, (r, m) => r.costByMonth.get(m) ?? 0),
    { header: 'Total Hours', value: (r) => xlsxNum(r.totalHours), width: 13, numFmt: FMT_QTY },
    { header: 'Total Days', value: (r) => xlsxNum(r.totalHours / hoursPerDay), width: 12, numFmt: FMT_QTY },
    { header: `Total Cost (${cur})`, value: (r) => xlsxNum(r.totalCost), width: 15, numFmt: FMT_MONEY },
  ];

  return [
    xlsxSheet(SHEET_ALLOCAZIONE_DETTAGLIO, cube.rows, detail),
    xlsxSheet(SHEET_ALLOCAZIONE_TESTATA, headRows, header),
  ];
}

// ---------------------------------------------------------------------------
// Report 3 — Unchargeable (manuale RPT §7.2, comparison matrix row 53)
// ---------------------------------------------------------------------------

/**
 * The FOUR RPT categories, in the manual's own order.
 *
 * **`'A'` IS NOT AN AGING BUCKET, and that is the whole trap of this report.**
 * RPT lists four categories side by side, which invites reading them as one
 * ordered scale; they are not. `UNALLOCATED_AGING_BUCKETS` (bench.util.ts) has
 * THREE members — B, C, D — because aging is retrospective and requires the month
 * to BE bench. A is the forward-looking "disallocato dal mese successivo" signal,
 * which requires the month NOT to be bench (`freeingUpNextMonth`), and it lives on
 * a different field of {@link BenchCell}: `upcomingUnallocated`, a boolean.
 *
 * So the two are mutually exclusive BY CONSTRUCTION, and a builder that read one
 * field for all four sheets would ship a workbook with one permanently empty tab —
 * `agingBucket` alone leaves A empty, `upcomingUnallocated` alone leaves B, C and D
 * empty. {@link unchargeableRows} therefore reads BOTH fields, and the union type
 * below is deliberately `'A' | UnallocatedAgingBucket` rather than a fourth member
 * added to that tuple: adding it there would let `bucketForIdleWorkingDays` return
 * a value it can never mean.
 */
export const UNCHARGEABLE_CATEGORIES = ['A', 'B', 'C', 'D'] as const;
export type UnchargeableCategory = 'A' | UnallocatedAgingBucket;

/** Sheet name per category, positionally aligned with {@link UNCHARGEABLE_CATEGORIES}. */
export const UNCHARGEABLE_SHEET_NAMES: Readonly<Record<UnchargeableCategory, string>> = {
  A: SHEET_UNCHARGEABLE_A,
  B: SHEET_UNCHARGEABLE_B,
  C: SHEET_UNCHARGEABLE_C,
  D: SHEET_UNCHARGEABLE_D,
};

/**
 * The in-row description of each category.
 *
 * B/C/D's boundaries are INTERPOLATED from `IDLE_WORKING_DAYS_B_MAX`/`_C_MAX`, never
 * typed as literals. Those constants are derived from how `workingDaysInMonth`
 * actually counts a month (absence.util.ts), so a hardcoded "1-21 days" here would
 * become a quiet falsehood the day the derivation window moves — printed inside the
 * file a planner takes to a meeting. RPT's own wording ("meno di 1 mese", "tra 1 e 2
 * mesi") is deliberately NOT reproduced: this app ages in working days (product
 * decision Q1), and a month label over a day count is the same falsehood.
 */
export const UNCHARGEABLE_CATEGORY_LABELS: Readonly<Record<UnchargeableCategory, string>> = {
  A: 'A - freeing up from next month',
  B: `B - idle 1-${IDLE_WORKING_DAYS_B_MAX} working days`,
  C: `C - idle ${IDLE_WORKING_DAYS_B_MAX + 1}-${IDLE_WORKING_DAYS_C_MAX} working days`,
  D: `D - idle ${IDLE_WORKING_DAYS_C_MAX + 1}+ working days`,
};

/** How many technical skills RPT shows per resource (manual §7.2). */
export const UNCHARGEABLE_SKILL_SLOTS = 3;

/**
 * The join data the bench rollup does NOT carry.
 *
 * `BenchRow` is deliberately narrow — id, name, kind, the monthly cells and the
 * availability date — so everything else RPT asks for (job role, org structure,
 * managers, skills, rates) is looked up here from the collections the caller
 * already holds. Nothing in this context is fetched by this module.
 */
export interface UnchargeableContext {
  /** The resource master: job role, `organization`, `managerId`, skills, day rates. */
  resources: readonly Resource[];
  /** The org tree, for the Capability/Practice/Competence walk and its managers. */
  organizations: readonly OrgNode[];
}

/** One skill slot: absent when the resource has fewer than three. */
export interface UnchargeableSkill { name: string; level: number }

/** One row of one Unchargeable sheet — flat, so the columns are a pure projection. */
export interface UnchargeableRow {
  category: UnchargeableCategory;
  resourceId: string;
  resourceName: string;
  kind: 'internal' | 'subco';
  state: BenchState;
  jobRole: string;
  capability: string;
  practice: string;
  competence: string;
  peopleManager: string;
  capabilityLeader: string;
  practiceManager: string;
  competenceManager: string;
  /** At most {@link UNCHARGEABLE_SKILL_SLOTS}, HIGHEST PROFICIENCY FIRST. Never padded. */
  skills: readonly UnchargeableSkill[];
  /** Standard cost, EUR/DAY (`costRateDay`). `undefined` when unresolvable — never 0. */
  costRateDay?: number;
  /** Tariffa (bill rate), EUR/DAY (`billRateDay`). Same absence rule. */
  billRateDay?: number;
  /** Same "absent means unanswerable" rule as `BenchCell.unallocatedPct`. */
  unallocatedPct?: number;
  unallocatedDays?: number;
  /** Never blank — an ISO date, or `Beyond <YYYY-MM>` past the horizon. */
  availability: string;
}

/**
 * The three technical skills RPT shows: **the three at the HIGHEST proficiency**,
 * not the first three as entered.
 *
 * `resources.skills` is an insertion-ordered array, so `slice(0, 3)` reads correct
 * and is wrong: a developer whose profile happens to list two beginner skills before
 * an expert one would be exported as a beginner. Sorted by level DESCENDING, with
 * the name as the tie-break so the same profile always exports the same three (an
 * unstable tie would make two runs of the same report differ).
 *
 * A resource with FEWER than three keeps fewer — the caller writes empty cells for
 * the missing slots. Padding with `{ name: '', level: 0 }` would put a zero
 * proficiency in the sheet, which reads as "measured at zero" rather than "not
 * recorded", and `=AVERAGE()` over the column would then be wrong by construction.
 *
 * A non-finite level sorts as 0 rather than poisoning the comparator (NaN makes
 * `Array.sort` order-dependent), and is emitted as an empty cell by `xlsxNum`.
 */
export function topSkills(
  skills: readonly UnchargeableSkill[] | undefined,
  slots = UNCHARGEABLE_SKILL_SLOTS,
): UnchargeableSkill[] {
  const lvl = (s: UnchargeableSkill): number => (Number.isFinite(s.level) ? s.level : 0);
  return [...(skills ?? [])]
    .sort((a, b) => lvl(b) - lvl(a) || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, slots));
}

/** `AvailabilityDate` as one never-blank cell — ISO date, or an explicit "Beyond". */
function availabilityText(a: AvailabilityDate): string {
  return a.kind === 'date' ? a.date : `Beyond ${a.horizonEndMonth}`;
}

/**
 * The resource's org node per LEVEL, from ONE upward walk.
 *
 * Deliberately not `dimensionsOf()` plus a second lookup for the managers: two
 * walks could pick a name from one node and a manager from another if the tree
 * changed between them, and the report would then attribute a practice to the wrong
 * Practice Manager. `ancestorChain` carries the cycle guard and the depth cap.
 */
function orgNodesByLevel(
  organization: string | undefined,
  nodes: readonly OrgNode[],
): Partial<Record<OrgLevel, OrgNode>> {
  const node = nodeByName(organization, nodes);
  const byLevel: Partial<Record<OrgLevel, OrgNode>> = {};
  if (node === undefined) return byLevel;
  for (const n of ancestorChain(node.id, nodes)) byLevel[n.level] = n;
  return byLevel;
}

/**
 * Classifies every bench row of ONE reference month into an RPT category, or into
 * none — the reduction all four sheets read.
 *
 * A ROW CAN BE IN AT MOST ONE CATEGORY, and no row is invented: the categories are
 * read from the two mutually-exclusive fields described on
 * {@link UNCHARGEABLE_CATEGORIES}, and a row whose cell for `month` is ALLOCATED
 * (or absent from the rollup entirely) appears nowhere. In particular:
 *
 *  - `'ABSENT'` cells carry NO `agingBucket` by construction (bench.util.ts: "being
 *    on leave is not [a delivery problem to age]"), so somebody on parental leave
 *    can never surface in B, C or D. That is the arithmetic correction block H
 *    shipped, and this report inherits it rather than re-deciding it;
 *  - an `'ABSENT'` cell CAN still be category A, and that is wanted, not tolerated:
 *    `freeingUpNextMonth` explicitly counts somebody RETURNING from leave into a
 *    bench month, because that person genuinely does need staffing. The row says
 *    `ABSENT` in its Status column and names no cause — see below;
 *  - a `'PARTIAL'` cell can be category A too (it is not bench, so it is eligible
 *    for the forward-looking signal) and never B/C/D.
 *
 * NO ABSENCE CAUSE IS CARRIED, and it cannot be: `BenchRow`/`BenchCell` have no
 * field for one and `GET /bench/monthly` transmits none (spec §7.3, GDPR art. 9
 * special-category data). Do not add one to make a column "more informative" — the
 * audience of an exported bench roster is not the audience of a medical reason, and
 * a spreadsheet leaves the building. `rpt-xlsx.util.spec.ts` scans the produced
 * BYTES for all six reason codes.
 */
export function unchargeableRows(
  rollup: BenchRollup,
  month: string,
  ctx: UnchargeableContext,
): UnchargeableRow[] {
  const resourceById = new Map(ctx.resources.map((r) => [r.id, r]));
  const nameById = new Map(ctx.resources.map((r) => [r.id, r.name]));
  const managerName = (id: string | undefined): string => (id === undefined ? '' : nameById.get(id) ?? id);

  const rows: UnchargeableRow[] = [];
  const all: readonly BenchRow[] = [...rollup.internalRows, ...rollup.subcoRows];
  for (const row of all) {
    const cell = row.monthly[month];
    if (cell === undefined) continue;
    // THE TWO FIELDS, read separately. `upcomingUnallocated` first only because A
    // comes first in RPT's list; the two can never both be set (see the union's doc).
    const category: UnchargeableCategory | undefined = cell.upcomingUnallocated ? 'A' : cell.agingBucket;
    if (category === undefined) continue;

    const resource = resourceById.get(row.resourceId);
    const byLevel = orgNodesByLevel(resource?.organization, ctx.organizations);
    const out: UnchargeableRow = {
      category,
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      kind: row.kind,
      state: cell.state,
      jobRole: resource?.role ?? '',
      capability: byLevel.capability?.name ?? '',
      practice: byLevel.practice?.name ?? '',
      competence: byLevel.competence?.name ?? '',
      peopleManager: managerName(resource?.managerId),
      capabilityLeader: managerName(byLevel.capability?.managerId),
      practiceManager: managerName(byLevel.practice?.managerId),
      competenceManager: managerName(byLevel.competence?.managerId),
      skills: topSkills(resource?.skills),
      availability: availabilityText(row.availabilityDate),
    };
    // Optional keys OMITTED rather than set to `undefined`, so a `toStrictEqual`
    // assertion describes the shape a consumer actually receives — the same rule
    // `unallocatedHistoryFor` follows for the same reason.
    if (resource?.costRateDay !== undefined) out.costRateDay = resource.costRateDay;
    if (resource?.billRateDay !== undefined) out.billRateDay = resource.billRateDay;
    if (cell.unallocatedPct !== undefined) out.unallocatedPct = cell.unallocatedPct;
    if (cell.unallocatedDays !== undefined) out.unallocatedDays = cell.unallocatedDays;
    rows.push(out);
  }

  // Internal before subco is an artefact of the concatenation above, not a report
  // rule: sort by name so the file's order is a property of the DATA and two runs
  // over the same rollup cannot differ.
  return rows.sort((a, b) => a.resourceName.localeCompare(b.resourceName) || a.resourceId.localeCompare(b.resourceId));
}

/** The `Skill N` / `Proficiency N` column pairs — one pair per RPT slot. */
function skillColumns(): XlsxColumn<UnchargeableRow>[] {
  return Array.from({ length: UNCHARGEABLE_SKILL_SLOTS }, (_unused, i) => [
    { header: `Skill ${i + 1}`, value: (r: UnchargeableRow) => r.skills[i]?.name ?? null, width: 20 },
    {
      header: `Proficiency ${i + 1}`,
      // `?? null` — an EMPTY cell for a slot the resource does not fill. Never 0:
      // see {@link topSkills} for why a padded zero is a measurement claim.
      value: (r: UnchargeableRow) => (r.skills[i] === undefined ? null : xlsxNum(r.skills[i].level)),
      width: 12,
      numFmt: '0',
    },
  ]).flat();
}

/**
 * Report 3 — **Unchargeable**: exactly FOUR sheets, one per RPT category, always in
 * A-B-C-D order and ALWAYS all four.
 *
 * A category with nobody in it yields a HEADER-ONLY sheet rather than being dropped.
 * That is the RPT shape (the manual defines the workbook as four tabs), and it is
 * also the honest one: a missing "D" tab reads as a report that failed to build,
 * while an empty one states that nobody has been idle that long.
 *
 * `month` is the ONE reference month the snapshot describes — the same month
 * /bench's own Status / Freeing up / Available columns describe, so the file and the
 * screen cannot disagree. A month absent from the rollup yields four empty sheets;
 * the caller is expected to disable the control rather than hand a user a workbook
 * of four empty tabs (P2-18).
 */
export function unchargeableSheets(
  rollup: BenchRollup,
  month: string,
  ctx: UnchargeableContext,
  opts: RptOpts,
): XlsxSheet[] {
  const cur = opts.currency;
  const rows = unchargeableRows(rollup, month, ctx);

  const byCategory = new Map<UnchargeableCategory, UnchargeableRow[]>(
    UNCHARGEABLE_CATEGORIES.map((c) => [c, [] as UnchargeableRow[]]),
  );
  for (const row of rows) byCategory.get(row.category)!.push(row);

  const columns: XlsxColumn<UnchargeableRow>[] = [
    { header: 'Category', value: (r) => UNCHARGEABLE_CATEGORY_LABELS[r.category], width: 30 },
    { header: 'Reference Month', value: () => month, width: 15 },
    // The state, and never a cause. 'ABSENT' is a fact about staffability; why is
    // special-category data that this pipeline does not carry (see unchargeableRows).
    { header: 'Status', value: (r) => r.state, width: 12 },
    { header: 'Resource Code', value: (r) => r.resourceId, width: 16 },
    { header: 'Resource', value: (r) => r.resourceName, width: 28 },
    { header: 'Type', value: (r) => r.kind, width: 10 },
    { header: 'Job Role', value: (r) => r.jobRole, width: 20 },
    // Struttura organizzativa, DECOMPOSED into RPT's own three levels rather than
    // joined into one path string: those are the dimensions RPT filters on (matrix
    // row 47), and three columns are filterable in Excel where a path is not. A
    // level that does not exist above the attachment point is EMPTY, not invented.
    { header: 'Capability', value: (r) => r.capability, width: 20 },
    { header: 'Practice', value: (r) => r.practice, width: 20 },
    { header: 'Competence', value: (r) => r.competence, width: 20 },
    // Responsabili: the People Manager plus the manager of each org level.
    { header: 'People Manager', value: (r) => r.peopleManager, width: 22 },
    { header: 'Capability Leader', value: (r) => r.capabilityLeader, width: 22 },
    { header: 'Practice Manager', value: (r) => r.practiceManager, width: 22 },
    { header: 'Competence Manager', value: (r) => r.competenceManager, width: 22 },
    ...skillColumns(),
    { header: `Standard Cost Rate (${cur}/day)`, value: (r) => xlsxNum(r.costRateDay), width: 20, numFmt: FMT_MONEY },
    { header: `Tariffa (${cur}/day)`, value: (r) => xlsxNum(r.billRateDay), width: 18, numFmt: FMT_MONEY },
    { header: 'Unallocated %', value: (r) => xlsxNum(r.unallocatedPct), width: 14, numFmt: FMT_QTY },
    { header: 'Unallocated Days', value: (r) => xlsxNum(r.unallocatedDays), width: 15, numFmt: FMT_QTY },
    { header: 'Available From', value: (r) => r.availability, width: 16 },
  ];

  return UNCHARGEABLE_CATEGORIES.map((c) =>
    xlsxSheet(UNCHARGEABLE_SHEET_NAMES[c], byCategory.get(c)!, columns),
  );
}
