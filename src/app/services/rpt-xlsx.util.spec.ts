import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import {
  ABSENCE_REASON_CODES,
  type Assignment, type AssignmentDay, type AssignmentMonth, type Project, type Resource,
  type ResourceOrganization, type ResourceRequest,
} from './api.service';
import { monthRowId } from './allocation-month.util';
import { IDLE_WORKING_DAYS_B_MAX, IDLE_WORKING_DAYS_C_MAX } from './absence.util';
import type { BenchRollup, BenchRow } from './bench.util';
import { buildXlsx, XlsxCellValue, XlsxSheet } from './export.util';
import { plannedCostSchedule, FinanceData } from './finance.util';
import {
  allocationCube,
  allocationSheets,
  planningSheet,
  RptOpts,
  RptPlanData,
  RptProjectFinancials,
  SHEET_ALLOCAZIONE_DETTAGLIO,
  SHEET_ALLOCAZIONE_TESTATA,
  SHEET_PIANIFICAZIONE,
  SHEET_UNCHARGEABLE_A,
  SHEET_UNCHARGEABLE_B,
  SHEET_UNCHARGEABLE_C,
  SHEET_UNCHARGEABLE_D,
  topSkills,
  UNCHARGEABLE_CATEGORY_LABELS,
  unchargeableRows,
  unchargeableSheets,
} from './rpt-xlsx.util';

// --- fixtures ---------------------------------------------------------------

const OPTS: RptOpts = { currency: 'EUR', hoursPerDay: 8 };

function res(id: string, name: string, costRate: number, extra: Partial<Resource> = {}): Resource {
  return {
    id,
    name,
    role: 'Cloud Engineer',
    skills: [],
    projectRoles: [],
    externalExperience: [],
    utilization: 0,
    capacity: 40,
    costRate,
    ...extra,
  };
}

function req(id: string, projectId?: string): ResourceRequest {
  return { id, name: id, requiredRole: 'Cloud Engineer', requiredEffort: 40, status: 'Open', skills: [], projectId };
}

function asg(id: string, requestId: string, resourceId: string): Assignment {
  return { id, requestId, resourceId, assignedHours: 0, status: 'Allocated' };
}

function prj(id: string, name: string): Project {
  return { id, name, location: 'Milan', startDate: '2026-01-01', endDate: '2026-06-30', status: 'In Execution' };
}

/** A booked day plus the (assignment, month) lifecycle row that gates it. */
function day(assignmentId: string, date: string, hours: number): AssignmentDay {
  return { id: `${assignmentId}-${date}`, assignmentId, date, hours };
}

function month(assignmentId: string, ym: string, status: AssignmentMonth['status']): AssignmentMonth {
  return { id: monthRowId(assignmentId, ym), assignmentId, month: ym, status };
}

/**
 * Two resources across two commesse plus a third, unstaffed commessa.
 *
 * Rates are round so every expected figure below is exact:
 *   Bianchi 50 EUR/h, Rossi 100 EUR/h.
 *
 * Deliberate traps: A3's March day sits in a **Draft** month (must not count), A3 also
 * has a day with **no month row at all** (must not count), and A4 is booked on a
 * request with **no commessa**.
 */
const DATA: RptPlanData = {
  projects: [prj('P1', 'Alpha Migration'), prj('P2', 'Beta Rollout'), prj('P3', 'Gamma Idle')],
  requests: [req('Q1', 'P1'), req('Q2', 'P2'), req('Q3')],
  assignments: [asg('A1', 'Q1', 'R1'), asg('A2', 'Q2', 'R1'), asg('A3', 'Q1', 'R2'), asg('A4', 'Q3', 'R2')],
  resources: [
    res('R1', 'Bianchi', 50, { organization: 'Delivery / Cloud', role: 'Cloud Engineer' }),
    res('R2', 'Rossi', 100, { organization: 'Delivery / Data', role: 'Data Engineer' }),
  ],
  assignmentDays: [
    day('A1', '2026-01-15', 8),
    day('A1', '2026-02-10', 4),
    day('A2', '2026-01-20', 2),
    day('A3', '2026-02-05', 6),
    day('A3', '2026-03-05', 10), // Draft month -> not a plan
    day('A3', '2026-04-05', 99), // no month row at all -> not a plan
    day('A4', '2026-01-25', 1),
  ],
  assignmentMonths: [
    month('A1', '2026-01', 'Allocated'),
    month('A1', '2026-02', 'Requested'),
    month('A2', '2026-01', 'Allocated'),
    month('A3', '2026-02', 'Allocated'),
    month('A3', '2026-03', 'Draft'),
    month('A4', '2026-01', 'Allocated'),
  ],
};

const EMPTY: RptPlanData = {
  projects: [],
  requests: [],
  assignments: [],
  resources: [],
  assignmentDays: [],
  assignmentMonths: [],
};

const FINANCIALS: RptProjectFinancials[] = [
  {
    id: 'P1',
    revenue: 100000,
    laborCost: 40000,
    externalCost: 5000,
    expenseCost: 1000,
    margin: 54000,
    marginPct: 54,
    eac: 46000,
    vac: -1000,
    pcpBaseline: 45000,
    pcpPlanned: 46000,
    pcpDelta: 1000,
  },
];

// --- helpers over a produced sheet -----------------------------------------

/** Index of a header, so assertions name columns instead of counting them. */
function col(sheet: XlsxSheet, header: string): number {
  const i = sheet.header.indexOf(header);
  if (i < 0) throw new Error(`no column "${header}" in ${sheet.name}: ${sheet.header.join(' | ')}`);
  return i;
}

/** The cell in the row whose `keyHeader` column equals `keyValue`. */
function cellFor(sheet: XlsxSheet, keyHeader: string, keyValue: string, header: string): XlsxCellValue {
  const k = col(sheet, keyHeader);
  const row = sheet.rows.find((r) => r[k] === keyValue);
  if (row === undefined) throw new Error(`no row with ${keyHeader}="${keyValue}" in ${sheet.name}`);
  return row[col(sheet, header)];
}

function rowsWhere(sheet: XlsxSheet, header: string, value: string): readonly (readonly XlsxCellValue[])[] {
  const k = col(sheet, header);
  return sheet.rows.filter((r) => r[k] === value);
}

// --- the cube ---------------------------------------------------------------


/**
 * exceljs arrives through a dynamic `import()` inside `buildXlsx`, and the FIRST
 * call in a worker pays the entire module load — 5.5 to 9.4 seconds on this
 * machine, against Vitest's 5000 ms default. Whichever `buildXlsx` test happened
 * to run first therefore flaked, and the one that usually drew the short straw
 * was the formula-injection assertion: the single worst test in this file to
 * teach anyone to ignore, because it is the safety property of the export.
 *
 * Paying the load once here, outside any test's budget, is the honest fix. Raising
 * each test's timeout instead would have hidden WHY they were slow and left every
 * future `buildXlsx` test to rediscover it.
 */
beforeAll(async () => {
  await buildXlsx([]);
}, 60_000);

describe('rpt-xlsx.util — allocationCube', () => {
  it('counts only days whose owning month is Allocated or Requested', () => {
    const cube = allocationCube(DATA);
    // ASSERTION OF ABSENCE, and the one the whole report rests on: March is Draft and
    // April has no month row, so neither month exists on the axis at all. A cube that
    // counted every booked day would list four months here.
    expect(cube.months).toEqual(['2026-01', '2026-02']);
    expect(cube.rows.some((r) => r.hoursByMonth.has('2026-03'))).toBe(false);
    expect(cube.rows.some((r) => r.hoursByMonth.has('2026-04'))).toBe(false);
    // The 10h Draft day and the 99h orphan day are worth 0, not "some" cost.
    expect(cube.rows.reduce((s, r) => s + r.totalHours, 0)).toBe(21); // 8+4+2+6+1
  });

  it('splits a resource by commessa and prices each day at the resource cost rate', () => {
    const cube = allocationCube(DATA);
    const bianchi = cube.rows.filter((r) => r.resourceName === 'Bianchi');
    expect(bianchi.map((r) => r.projectName)).toEqual(['Alpha Migration', 'Beta Rollout']);
    expect(bianchi[0].hoursByMonth.get('2026-01')).toBe(8);
    expect(bianchi[0].costByMonth.get('2026-01')).toBe(400); // 8h x 50
    expect(bianchi[0].costByMonth.get('2026-02')).toBe(200); // 4h x 50
    expect(bianchi[1].totalCost).toBe(100); // 2h x 50
    expect(cube.rows.find((r) => r.resourceName === 'Rossi' && r.projectId === 'P1')!.totalCost).toBe(600);
  });

  it('keeps a booking with no commessa, labelled rather than dropped', () => {
    const orphan = allocationCube(DATA).rows.find((r) => r.projectId === '');
    expect(orphan).toBeDefined();
    expect(orphan!.projectName).toBe('(no commessa)');
    expect(orphan!.totalHours).toBe(1);
    expect(orphan!.totalCost).toBe(100);
  });

  it('agrees with finance.util plannedCostSchedule for the same project', () => {
    // DRIFT GUARD. This cube reimplements `plannedCostSchedule`'s rule because that
    // helper only slices by project and the reports need three slices. Pin the two
    // together so a change to either shows up here.
    const finance: FinanceData = {
      requests: [...DATA.requests],
      assignments: [...DATA.assignments],
      resources: [...DATA.resources],
      orders: [],
      orderLines: [],
      financials: [],
      assignmentDays: [...DATA.assignmentDays],
      assignmentMonths: [...DATA.assignmentMonths],
    };
    const cube = allocationCube(DATA);
    for (const projectId of ['P1', 'P2', 'P3']) {
      const expected = plannedCostSchedule(finance, cube.months, { projectId });
      for (const { period, plannedCost } of expected) {
        const mine = cube.rows
          .filter((r) => r.projectId === projectId)
          .reduce((s, r) => s + (r.costByMonth.get(period) ?? 0), 0);
        expect(mine).toBeCloseTo(plannedCost, 6);
      }
    }
  });

  it('has no rows and no months for an empty dataset', () => {
    expect(allocationCube(EMPTY)).toEqual({ months: [], rows: [] });
  });
});

// --- report 1: Pianificazione ----------------------------------------------

describe('rpt-xlsx.util — planningSheet (RPT report 1: one sheet)', () => {
  const sheet = planningSheet(DATA, FINANCIALS, OPTS);

  it('is a single sheet named Pianificazione, one row per commessa in the master', () => {
    expect(sheet.name).toBe(SHEET_PIANIFICAZIONE);
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows.map((r) => r[col(sheet, 'Commessa')])).toEqual(['Alpha Migration', 'Beta Rollout', 'Gamma Idle']);
    // ASSERTION OF ABSENCE: the commessa-less booking does NOT invent a commessa row.
    expect(rowsWhere(sheet, 'Commessa', '(no commessa)')).toHaveLength(0);
  });

  it('rolls the plan up per commessa: headcount, hours, days and total cost', () => {
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Resources Planned')).toBe(2);
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Planned Hours')).toBe(18); // 8+4+6
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Planned Days')).toBe(2.25); // 18/8
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Planned Cost (EUR)')).toBe(1200); // 400+200+600
    expect(cellFor(sheet, 'Commessa', 'Beta Rollout', 'Resources Planned')).toBe(1);
    expect(cellFor(sheet, 'Commessa', 'Beta Rollout', 'Planned Cost (EUR)')).toBe(100);
  });

  it('carries one monthly-cost column per planned month, and only those', () => {
    // Month columns only — March (Draft) and April (no month row) must not appear.
    expect(sheet.header.filter((h) => /^[A-Z][a-z]{2} \d\d /.test(h))).toEqual([
      'Jan 26 Cost (EUR)',
      'Feb 26 Cost (EUR)',
    ]);
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Jan 26 Cost (EUR)')).toBe(400);
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Feb 26 Cost (EUR)')).toBe(800); // 200 + 600
    expect(cellFor(sheet, 'Commessa', 'Beta Rollout', 'Feb 26 Cost (EUR)')).toBe(0);
  });

  it('passes the on-screen financials through, and leaves them EMPTY where there are none', () => {
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Revenue (EUR)')).toBe(100000);
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Margin %')).toBe(54);
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'PCP Delta (EUR)')).toBe(1000);
    // ASSERTION OF ABSENCE: an unstaffed, revenue-less commessa still gets its row and
    // its plan columns, but its money cells are BLANK — never fabricated zeros that a
    // reader would take for a measured figure.
    expect(cellFor(sheet, 'Commessa', 'Gamma Idle', 'Planned Hours')).toBe(0);
    expect(cellFor(sheet, 'Commessa', 'Gamma Idle', 'Revenue (EUR)')).toBeNull();
    expect(cellFor(sheet, 'Commessa', 'Gamma Idle', 'EAC (EUR)')).toBeNull();
    expect(cellFor(sheet, 'Commessa', 'Beta Rollout', 'Revenue (EUR)')).toBeNull();
  });

  it('has no rows and no month columns for an empty dataset', () => {
    // ASSERTION OF ABSENCE: a declared-but-empty sheet, not a fabricated one.
    const none = planningSheet(EMPTY, [], OPTS);
    expect(none.name).toBe(SHEET_PIANIFICAZIONE);
    expect(none.rows).toEqual([]);
    expect(none.header.some((h) => /^[A-Z][a-z]{2} \d\d /.test(h))).toBe(false);
  });
});

// --- report 2: Allocazione (2 sheets) --------------------------------------

describe('rpt-xlsx.util — allocationSheets (RPT report 2: two sheets)', () => {
  const [detail, head] = allocationSheets(DATA, OPTS);

  it('is exactly two sheets, Dettaglio then Testata', () => {
    const sheets = allocationSheets(DATA, OPTS);
    expect(sheets).toHaveLength(2);
    expect(sheets.map((s) => s.name)).toEqual([SHEET_ALLOCAZIONE_DETTAGLIO, SHEET_ALLOCAZIONE_TESTATA]);
  });

  it('Dettaglio is per resource AND per commessa, with monthly hours and costs', () => {
    expect(detail.rows).toHaveLength(4); // R1xP1, R1xP2, R2xP1, R2x(none)
    expect(rowsWhere(detail, 'Resource', 'Bianchi')).toHaveLength(2);
    expect(cellFor(detail, 'Commessa Code', 'P2', 'Jan 26 Hours')).toBe(2);
    expect(cellFor(detail, 'Commessa Code', 'P2', 'Jan 26 Cost (EUR)')).toBe(100);
    expect(cellFor(detail, 'Commessa Code', 'P2', 'Feb 26 Hours')).toBe(0);
    expect(cellFor(detail, 'Commessa Code', 'P2', 'Organization')).toBe('Delivery / Cloud');
    expect(cellFor(detail, 'Commessa Code', 'P2', 'Job Role')).toBe('Cloud Engineer');
  });

  it('Testata collapses the commessa dimension: one row per resource, monthly TOTALS', () => {
    // THE DISCRIMINATING ASSERTION. Bianchi has two Dettaglio rows and exactly ONE
    // Testata row, whose January cost is the SUM of the two (400 + 100) and therefore
    // equal to NEITHER of them. A Testata that merely copied Dettaglio, or that picked
    // one commessa's figure, fails right here.
    expect(head.rows).toHaveLength(2);
    expect(rowsWhere(head, 'Resource', 'Bianchi')).toHaveLength(1);
    expect(cellFor(head, 'Resource', 'Bianchi', 'Commesse')).toBe(2);
    expect(cellFor(head, 'Resource', 'Bianchi', 'Jan 26 Cost (EUR)')).toBe(500);
    expect(cellFor(head, 'Resource', 'Bianchi', 'Jan 26 Hours')).toBe(10);
    expect(cellFor(head, 'Resource', 'Bianchi', 'Feb 26 Cost (EUR)')).toBe(200);
    expect(cellFor(head, 'Resource', 'Bianchi', 'Total Cost (EUR)')).toBe(700);
    expect(cellFor(head, 'Resource', 'Bianchi', 'Total Hours')).toBe(14);
    // Rossi's total spans a commessa AND a commessa-less booking: 600 + 100.
    expect(cellFor(head, 'Resource', 'Rossi', 'Total Cost (EUR)')).toBe(700);
    expect(cellFor(head, 'Resource', 'Rossi', 'Jan 26 Cost (EUR)')).toBe(100);
  });

  it('Testata carries NO commessa column at all — that is what makes it the Testata', () => {
    // ASSERTION OF ABSENCE: the two sheets must differ in SHAPE, not only in row count.
    expect(head.header).not.toContain('Commessa');
    expect(head.header).not.toContain('Commessa Code');
    expect(detail.header).toContain('Commessa');
  });

  it('still yields both sheets, header-only, for an empty dataset', () => {
    const sheets = allocationSheets(EMPTY, OPTS);
    expect(sheets.map((s) => s.name)).toEqual([SHEET_ALLOCAZIONE_DETTAGLIO, SHEET_ALLOCAZIONE_TESTATA]);
    expect(sheets[0].rows).toEqual([]);
    expect(sheets[1].rows).toEqual([]);
    expect(sheets[0].header).not.toContain('Jan 26 Hours');
  });
});

// --- the ≤2-decimal rule ---------------------------------------------------

describe('rpt-xlsx.util — the ≤2-decimal rule', () => {
  const oddRate: RptPlanData = {
    ...EMPTY,
    projects: [prj('P9', 'Odd Rate')],
    requests: [req('Q9', 'P9')],
    assignments: [asg('A9', 'Q9', 'R9')],
    resources: [res('R9', 'Neri', 33.333333)],
    assignmentDays: [day('A9', '2026-05-04', 7.7)],
    assignmentMonths: [month('A9', '2026-05', 'Allocated')],
  };

  it('rounds money and hours to at most 2 decimals, as numbers', () => {
    const sheet = planningSheet(oddRate, [], OPTS);
    const cost = cellFor(sheet, 'Commessa', 'Odd Rate', 'Planned Cost (EUR)');
    expect(cost).toBe(256.67); // 7.7h x 33.333333 = 256.6666641
    expect(typeof cost).toBe('number');
    expect(cellFor(sheet, 'Commessa', 'Odd Rate', 'Planned Days')).toBe(0.96); // 7.7/8 = 0.9625
    // ASSERTION OF ABSENCE: no cell in the sheet carries a third decimal.
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (typeof cell !== 'number') continue;
        expect(String(cell).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
      }
    }
  });
});

// --- end to end through the writer ----------------------------------------

describe('rpt-xlsx.util — through buildXlsx', () => {
  it('writes the Allocazione workbook as two named sheets with real rows', async () => {
    const bytes = await buildXlsx(allocationSheets(DATA, OPTS));
    const mod = (await import('exceljs')) as typeof import('exceljs') & { default?: typeof import('exceljs') };
    const wb = new (mod.default ?? mod).Workbook();
    await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);

    expect(wb.worksheets.map((w) => w.name)).toEqual([SHEET_ALLOCAZIONE_DETTAGLIO, SHEET_ALLOCAZIONE_TESTATA]);
    // Content, not just tab names: Dettaglio has 4 data rows, Testata 2, and the
    // January cost of Bianchi's Beta row (100) differs from her Testata total (500).
    const dettaglio = wb.getWorksheet(SHEET_ALLOCAZIONE_DETTAGLIO)!;
    const testata = wb.getWorksheet(SHEET_ALLOCAZIONE_TESTATA)!;
    expect(dettaglio.actualRowCount).toBe(5); // header + 4
    expect(testata.actualRowCount).toBe(3); // header + 2
    expect(dettaglio.getCell('A1').value).toBe('Resource Code');
    expect(testata.getRow(1).values).not.toContain('Commessa');
    // The two sheets disagree on purpose — that is the report's whole point.
    expect(dettaglio.getCell(2, col(allocationSheets(DATA, OPTS)[0], 'Total Cost (EUR)') + 1).value).not.toBe(
      testata.getCell(2, col(allocationSheets(DATA, OPTS)[1], 'Total Cost (EUR)') + 1).value,
    );
    // 20s budget: this is the first spec in the file to pull the lazily-imported
    // ~1.7 MB spreadsheet writer, and the default 5s does not cover that cold load.
  }, 20_000);
});

// ===========================================================================
// Report 3 — Unchargeable (manuale RPT §7.2, comparison matrix row 53)
// ===========================================================================

/** The reference month every fixture below is keyed on. */
const UM = '2026-08';
/** A month with rows that must NEVER reach the UM snapshot. */
const OTHER_MONTH = '2026-07';

/**
 * The org tree, three levels deep on one branch and one level on the other, so a
 * resource attached at a COMPETENCE fills all three org columns while one attached
 * at a CAPABILITY leaves two of them empty — which is the difference between
 * deriving the structure and fabricating it.
 *
 * `Backend` deliberately has NO manager: RPT's "responsabili" columns must come out
 * empty for a level nobody manages, not fall back to the parent's manager (that
 * would attribute an approval chain that does not exist).
 */
const ORGS: ResourceOrganization[] = [
  { id: 'O1', name: 'Engineering', description: '', costCenters: [], level: 'capability', managerId: 'M1' },
  { id: 'O2', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: 'O1', managerId: 'M2' },
  { id: 'O3', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: 'O2' },
  { id: 'O4', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
];

function ures(id: string, name: string, extra: Partial<Resource> = {}): Resource {
  return {
    id, name, role: 'Developer', skills: [], projectRoles: [], externalExperience: [],
    utilization: 0, capacity: 40, ...extra,
  };
}

/**
 * Anna's FIVE skills, at five DIFFERENT levels, entered in an order whose first
 * three share NOTHING with the top three by proficiency:
 *   as entered  -> Bash(1), Docker(2), Kubernetes(5)
 *   by level    -> Kubernetes(5), Java(4), Terraform(3)
 * A builder doing `slice(0, 3)` therefore exports two wrong skills AND two wrong
 * proficiencies, which is what makes "the three at the highest proficiency" an
 * assertion rather than a sentence in a doc comment.
 */
const ANNA_SKILLS = [
  { name: 'Bash', level: 1 },
  { name: 'Docker', level: 2 },
  { name: 'Kubernetes', level: 5 },
  { name: 'Java', level: 4 },
  { name: 'Terraform', level: 3 },
];

const URESOURCES: Resource[] = [
  ures('M1', 'Marta Capability'),
  ures('M2', 'Paolo Practice'),
  // Deepest attachment: Backend -> Platform -> Engineering. Five skills. Rates set.
  ures('U1', 'Anna Aging', {
    role: 'Backend Engineer', organization: 'Backend', managerId: 'M2',
    skills: ANNA_SKILLS, costRateDay: 640, billRateDay: 1200,
  }),
  // Attached at a CAPABILITY with no manager, and only TWO skills.
  ures('U2', 'Bruno Bench', {
    role: 'Consultant', organization: 'Consulting', managerId: 'M1',
    skills: [{ name: 'Project Management', level: 2 }, { name: 'Excel', level: 3 }],
    costRateDay: 720, billRateDay: 1440,
  }),
  // NO skills and NO rates — every one of those cells must be EMPTY, never 0.
  ures('U3', 'Carla Idle', { organization: 'Backend' }),
  // Three skills all at the SAME level: the name tie-break is the only thing that
  // makes two runs of this report produce the same three names in the same order.
  ures('U4', 'Dario Freeing', {
    organization: 'Engineering', managerId: 'M1',
    skills: [{ name: 'Zsh', level: 3 }, { name: 'Ansible', level: 3 }, { name: 'Go', level: 3 }, { name: 'Rust', level: 1 }],
    costRateDay: 600, billRateDay: 1120,
  }),
  ures('U5', 'Elena Away', { organization: 'Engineering', costRateDay: 600 }),
  ures('U6', 'Fabio Allocated', { organization: 'Engineering', costRateDay: 600 }),
  ures('U7', 'Gina Lastmonth', { organization: 'Engineering' }),
  ures('S1', 'Subco Sergio', { organization: 'Engineering', costRateDay: 900, billRateDay: 1500 }),
];

const UCTX = { resources: URESOURCES, organizations: ORGS };

function brow(
  resourceId: string, resourceName: string, kind: 'internal' | 'subco',
  monthly: BenchRow['monthly'], availabilityDate: BenchRow['availabilityDate'] = { kind: 'beyond-horizon', horizonEndMonth: '2026-09' },
): BenchRow {
  return { resourceId, resourceName, kind, monthly, availabilityDate };
}

/**
 * ONE ROW PER OUTCOME, which is the point: a fixture whose resources all land in the
 * same bucket cannot tell a four-sheet split from a one-sheet dump.
 *
 *   U4 Dario  PARTIAL + upcomingUnallocated -> A   (a DIFFERENT field from B/C/D)
 *   U2 Bruno  BENCH   bucket B              -> B
 *   U1 Anna   BENCH   bucket C              -> C
 *   U3 Carla  BENCH   bucket D              -> D
 *   S1 Sergio BENCH   bucket D (SUBCO)      -> D   (proves subcoRows is read at all)
 *   U5 Elena  ABSENT, not freeing up        -> NOWHERE
 *   U6 Fabio  ALLOCATED                     -> NOWHERE
 *   U7 Gina   BENCH, but only in OTHER_MONTH -> NOWHERE
 */
const UROLLUP: BenchRollup = {
  months: [OTHER_MONTH, UM, '2026-09'],
  internalRows: [
    brow('U4', 'Dario Freeing', 'internal', { [UM]: { state: 'PARTIAL', upcomingUnallocated: true, unallocatedPct: 25, unallocatedDays: 5.25 } }),
    brow('U2', 'Bruno Bench', 'internal', { [UM]: { state: 'BENCH', agingBucket: 'B', upcomingUnallocated: false, unallocatedPct: 100, unallocatedDays: 21 } }, { kind: 'date', date: '2026-08-07' }),
    brow('U1', 'Anna Aging', 'internal', { [UM]: { state: 'BENCH', agingBucket: 'C', upcomingUnallocated: false, unallocatedPct: 62.5, unallocatedDays: 13.125 } }, { kind: 'date', date: '2026-08-07' }),
    brow('U3', 'Carla Idle', 'internal', { [UM]: { state: 'BENCH', agingBucket: 'D', upcomingUnallocated: false } }),
    brow('U5', 'Elena Away', 'internal', { [UM]: { state: 'ABSENT', upcomingUnallocated: false } }),
    brow('U6', 'Fabio Allocated', 'internal', { [UM]: { state: 'ALLOCATED', upcomingUnallocated: false, unallocatedPct: 0, unallocatedDays: 0 } }),
    brow('U7', 'Gina Lastmonth', 'internal', { [OTHER_MONTH]: { state: 'BENCH', agingBucket: 'D', upcomingUnallocated: false } }),
  ],
  subcoRows: [
    brow('S1', 'Subco Sergio', 'subco', { [UM]: { state: 'BENCH', agingBucket: 'D', upcomingUnallocated: false } }, { kind: 'date', date: '2026-08-07' }),
  ],
  hiringDemand: [],
};

const UEMPTY_ROLLUP: BenchRollup = { months: [UM], internalRows: [], subcoRows: [], hiringDemand: [] };

/** Sheet by name, so an assertion names its tab instead of trusting array order. */
function sheetNamed(sheets: readonly XlsxSheet[], name: string): XlsxSheet {
  const s = sheets.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no sheet "${name}" in ${sheets.map((x) => x.name).join(' | ')}`);
  return s;
}

function resourceNames(sheet: XlsxSheet): string[] {
  const k = col(sheet, 'Resource');
  return sheet.rows.map((r) => String(r[k]));
}

describe('rpt-xlsx.util — unchargeableRows: the four categories, from TWO fields', () => {
  const rows = unchargeableRows(UROLLUP, UM, UCTX);

  it('reads `upcomingUnallocated` for A and `agingBucket` for B/C/D — one row in each', () => {
    // THE DISCRIMINATING ASSERTION of this whole report. A is not a bucket: it lives
    // on a different field of BenchCell and is mutually exclusive with the buckets by
    // construction. A builder reading `agingBucket` alone leaves A empty; one reading
    // `upcomingUnallocated` alone leaves B, C and D empty. Either way exactly one of
    // the four sheets is permanently blank, and this map is what says so.
    expect(rows.map((r) => [r.resourceId, r.category])).toStrictEqual([
      ['U1', 'C'],
      ['U2', 'B'],
      ['U3', 'D'],
      ['U4', 'A'],
      ['S1', 'D'],
    ]);
  });

  it('leaves out ALLOCATED, ABSENT-and-not-freeing-up, and other months entirely', () => {
    // ASSERTIONS OF ABSENCE, one per way a row can legitimately have no category.
    const ids = rows.map((r) => r.resourceId);
    expect(ids).not.toContain('U6'); // ALLOCATED — not unchargeable
    expect(ids).not.toContain('U5'); // ABSENT with no forward signal — on leave is not idle
    expect(ids).not.toContain('U7'); // BENCH, but in a month this snapshot is not about
    expect(rows).toHaveLength(5);
  });

  it('never puts an ABSENT resource in an aging bucket, and DOES admit one returning to a bench month', () => {
    // Both directions, because bench.util decided them in opposite ways on purpose:
    // an ABSENT cell carries no `agingBucket` at all (so B/C/D are unreachable), while
    // `freeingUpNextMonth` deliberately counts somebody coming BACK from leave into a
    // bench month — that person genuinely needs staffing.
    const returning: BenchRollup = {
      months: [UM], hiringDemand: [], subcoRows: [],
      internalRows: [brow('U5', 'Elena Away', 'internal', { [UM]: { state: 'ABSENT', upcomingUnallocated: true } })],
    };
    const out = unchargeableRows(returning, UM, UCTX);
    expect(out.map((r) => [r.resourceId, r.category, r.state])).toStrictEqual([['U5', 'A', 'ABSENT']]);
    // And still no bucket anywhere near her.
    expect(out.every((r) => r.category !== 'B' && r.category !== 'C' && r.category !== 'D')).toBe(true);
  });

  it('derives the org structure and its managers from ONE upward walk', () => {
    const anna = rows.find((r) => r.resourceId === 'U1')!;
    // Attached at the COMPETENCE: all three levels resolve, and each manager comes
    // from its OWN node — Backend has none, so that column is empty rather than
    // inheriting Platform's.
    expect(anna.capability).toBe('Engineering');
    expect(anna.practice).toBe('Platform');
    expect(anna.competence).toBe('Backend');
    expect(anna.capabilityLeader).toBe('Marta Capability');
    expect(anna.practiceManager).toBe('Paolo Practice');
    expect(anna.competenceManager).toBe('');
    expect(anna.peopleManager).toBe('Paolo Practice');
    expect(anna.jobRole).toBe('Backend Engineer');

    // Attached at a CAPABILITY with no manager: the two lower levels are EMPTY, never
    // back-filled with the capability's own name.
    const bruno = rows.find((r) => r.resourceId === 'U2')!;
    expect(bruno.capability).toBe('Consulting');
    expect(bruno.practice).toBe('');
    expect(bruno.competence).toBe('');
    expect(bruno.capabilityLeader).toBe('');
  });

  it('takes the three skills at the HIGHEST proficiency, not the first three entered', () => {
    const anna = rows.find((r) => r.resourceId === 'U1')!;
    expect(anna.skills).toStrictEqual([
      { name: 'Kubernetes', level: 5 },
      { name: 'Java', level: 4 },
      { name: 'Terraform', level: 3 },
    ]);
    // ASSERTION OF ABSENCE: the two lowest-proficiency skills — which are also the
    // FIRST TWO as entered — do not appear at all.
    expect(anna.skills.map((s) => s.name)).not.toContain('Bash');
    expect(anna.skills.map((s) => s.name)).not.toContain('Docker');
  });

  it('breaks a proficiency tie by name, so the same profile always exports the same three', () => {
    const dario = rows.find((r) => r.resourceId === 'U4')!;
    expect(dario.skills).toStrictEqual([
      { name: 'Ansible', level: 3 },
      { name: 'Go', level: 3 },
      { name: 'Zsh', level: 3 },
    ]);
    // The level-1 skill is beaten by all three ties, in either order of arrival.
    expect(dario.skills.map((s) => s.name)).not.toContain('Rust');
  });

  it('keeps FEWER than three when there are fewer, and never invents a zero-level skill', () => {
    expect(rows.find((r) => r.resourceId === 'U2')!.skills).toHaveLength(2);
    expect(rows.find((r) => r.resourceId === 'U3')!.skills).toStrictEqual([]);
  });

  it('omits an unresolvable rate and an unanswerable share rather than defaulting them to 0', () => {
    // `toStrictEqual` on the whole row: an added `costRateDay: undefined` key is a
    // different shape from an absent one, and only the absent one survives the JSON
    // round-trip a consumer actually sees.
    expect(rows.find((r) => r.resourceId === 'U3')).toStrictEqual({
      category: 'D', resourceId: 'U3', resourceName: 'Carla Idle', kind: 'internal', state: 'BENCH',
      jobRole: 'Developer', capability: 'Engineering', practice: 'Platform', competence: 'Backend',
      peopleManager: '', capabilityLeader: 'Marta Capability', practiceManager: 'Paolo Practice',
      competenceManager: '', skills: [], availability: 'Beyond 2026-09',
    });
  });

  it('answers with no rows for an empty rollup, and for a month the rollup does not cover', () => {
    expect(unchargeableRows(UEMPTY_ROLLUP, UM, UCTX)).toStrictEqual([]);
    expect(unchargeableRows(UROLLUP, '2030-01', UCTX)).toStrictEqual([]);
  });
});

describe('rpt-xlsx.util — topSkills', () => {
  it('is a stable, level-descending pick that never pads', () => {
    expect(topSkills(ANNA_SKILLS).map((s) => s.name)).toStrictEqual(['Kubernetes', 'Java', 'Terraform']);
    expect(topSkills([])).toStrictEqual([]);
    expect(topSkills(undefined)).toStrictEqual([]);
    // A non-finite level sorts as 0 instead of poisoning the comparator (NaN makes
    // Array.sort order-dependent) — and it does NOT beat a real level 1.
    expect(topSkills([{ name: 'Broken', level: Number.NaN }, { name: 'Real', level: 1 }]).map((s) => s.name))
      .toStrictEqual(['Real', 'Broken']);
  });

  it('does not mutate the array it was handed', () => {
    const input = [...ANNA_SKILLS];
    topSkills(input);
    expect(input.map((s) => s.name)).toStrictEqual(['Bash', 'Docker', 'Kubernetes', 'Java', 'Terraform']);
  });
});

describe('rpt-xlsx.util — unchargeableSheets (RPT report 3: four sheets)', () => {
  const sheets = unchargeableSheets(UROLLUP, UM, UCTX, OPTS);

  it('is exactly four sheets, A B C D, always all four', () => {
    expect(sheets).toHaveLength(4);
    expect(sheets.map((s) => s.name)).toStrictEqual([
      SHEET_UNCHARGEABLE_A, SHEET_UNCHARGEABLE_B, SHEET_UNCHARGEABLE_C, SHEET_UNCHARGEABLE_D,
    ]);
  });

  it('puts each resource in its OWN sheet — never all of them in one', () => {
    // The fault this fixture exists to catch. Sheet names alone would pass with four
    // header-only tabs, and one tab holding all five rows would pass any assertion
    // that only counted the total.
    expect(resourceNames(sheetNamed(sheets, SHEET_UNCHARGEABLE_A))).toStrictEqual(['Dario Freeing']);
    expect(resourceNames(sheetNamed(sheets, SHEET_UNCHARGEABLE_B))).toStrictEqual(['Bruno Bench']);
    expect(resourceNames(sheetNamed(sheets, SHEET_UNCHARGEABLE_C))).toStrictEqual(['Anna Aging']);
    expect(resourceNames(sheetNamed(sheets, SHEET_UNCHARGEABLE_D))).toStrictEqual(['Carla Idle', 'Subco Sergio']);
    // ASSERTION OF ABSENCE: nobody is duplicated across tabs, and nobody uncategorised
    // slipped in. 5 rows over 4 sheets, and the uncategorised three are in none.
    const all = sheets.flatMap((s) => resourceNames(s));
    expect(all).toHaveLength(5);
    expect(new Set(all).size).toBe(5);
    expect(all).not.toContain('Fabio Allocated');
    expect(all).not.toContain('Elena Away');
    expect(all).not.toContain('Gina Lastmonth');
  });

  it('writes real DATA cells, not just headers — one asserted cell per sheet', () => {
    const a = sheetNamed(sheets, SHEET_UNCHARGEABLE_A);
    const b = sheetNamed(sheets, SHEET_UNCHARGEABLE_B);
    const c = sheetNamed(sheets, SHEET_UNCHARGEABLE_C);
    const d = sheetNamed(sheets, SHEET_UNCHARGEABLE_D);
    expect(cellFor(a, 'Resource', 'Dario Freeing', 'Skill 1')).toBe('Ansible');
    expect(cellFor(b, 'Resource', 'Bruno Bench', 'Capability')).toBe('Consulting');
    expect(cellFor(c, 'Resource', 'Anna Aging', 'Standard Cost Rate (EUR/day)')).toBe(640);
    expect(cellFor(d, 'Resource', 'Subco Sergio', 'Tariffa (EUR/day)')).toBe(1500);
    // Every sheet with a row has at least one non-header cell filled.
    for (const s of [a, b, c, d]) expect(s.rows.length).toBeGreaterThan(0);
  });

  it('carries the RPT column set: structure, managers, code, name, role, 3 skills+proficiency, rates, availability', () => {
    const c = sheetNamed(sheets, SHEET_UNCHARGEABLE_C);
    for (const header of [
      'Category', 'Reference Month', 'Status', 'Resource Code', 'Resource', 'Type', 'Job Role',
      'Capability', 'Practice', 'Competence',
      'People Manager', 'Capability Leader', 'Practice Manager', 'Competence Manager',
      'Skill 1', 'Proficiency 1', 'Skill 2', 'Proficiency 2', 'Skill 3', 'Proficiency 3',
      'Standard Cost Rate (EUR/day)', 'Tariffa (EUR/day)', 'Unallocated %', 'Unallocated Days', 'Available From',
    ]) expect(c.header).toContain(header);
    // ASSERTION OF ABSENCE: there is no fourth skill slot, so a profile with ten
    // skills cannot silently widen the report.
    expect(c.header).not.toContain('Skill 4');
    expect(c.header).not.toContain('Proficiency 4');
    // And every sheet has the SAME columns — four tabs of one report, not four reports.
    for (const s of sheets) expect(s.header).toStrictEqual(c.header);
  });

  it('writes the top three skills with their proficiency, and EMPTY cells for missing slots', () => {
    const c = sheetNamed(sheets, SHEET_UNCHARGEABLE_C);
    expect(cellFor(c, 'Resource', 'Anna Aging', 'Skill 1')).toBe('Kubernetes');
    expect(cellFor(c, 'Resource', 'Anna Aging', 'Proficiency 1')).toBe(5);
    expect(cellFor(c, 'Resource', 'Anna Aging', 'Skill 3')).toBe('Terraform');
    expect(cellFor(c, 'Resource', 'Anna Aging', 'Proficiency 3')).toBe(3);

    // Two skills -> the third pair is NULL (an empty cell), never '' + 0. A zero
    // proficiency is a measurement claim, and it would drag =AVERAGE() down.
    const b = sheetNamed(sheets, SHEET_UNCHARGEABLE_B);
    expect(cellFor(b, 'Resource', 'Bruno Bench', 'Skill 1')).toBe('Excel'); // level 3 beats PM's 2
    expect(cellFor(b, 'Resource', 'Bruno Bench', 'Skill 3')).toBeNull();
    expect(cellFor(b, 'Resource', 'Bruno Bench', 'Proficiency 3')).toBeNull();

    // No skills at all -> all six cells empty.
    const d = sheetNamed(sheets, SHEET_UNCHARGEABLE_D);
    for (const h of ['Skill 1', 'Proficiency 1', 'Skill 2', 'Proficiency 2', 'Skill 3', 'Proficiency 3']) {
      expect(cellFor(d, 'Resource', 'Carla Idle', h)).toBeNull();
    }
  });

  it('leaves an unresolvable rate and an unanswerable share BLANK, never 0', () => {
    const d = sheetNamed(sheets, SHEET_UNCHARGEABLE_D);
    expect(cellFor(d, 'Resource', 'Carla Idle', 'Standard Cost Rate (EUR/day)')).toBeNull();
    expect(cellFor(d, 'Resource', 'Carla Idle', 'Tariffa (EUR/day)')).toBeNull();
    expect(cellFor(d, 'Resource', 'Carla Idle', 'Unallocated %')).toBeNull();
    expect(cellFor(d, 'Resource', 'Carla Idle', 'Unallocated Days')).toBeNull();
    // ...while a genuine figure of 100% is written as the number 100.
    const b = sheetNamed(sheets, SHEET_UNCHARGEABLE_B);
    expect(cellFor(b, 'Resource', 'Bruno Bench', 'Unallocated %')).toBe(100);
  });

  it('caps every numeric cell at 2 decimals, as a NUMBER', () => {
    const c = sheetNamed(sheets, SHEET_UNCHARGEABLE_C);
    // 13.125 idle days must round, and stay arithmetic (a '.toFixed()' string would
    // land as text that =SUM() skips).
    const days = cellFor(c, 'Resource', 'Anna Aging', 'Unallocated Days');
    expect(days).toBe(13.13);
    expect(typeof days).toBe('number');
    for (const sheet of sheets) {
      for (const row of sheet.rows) {
        for (const cell of row) {
          if (typeof cell !== 'number') continue;
          expect(String(cell).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('names the category from the DERIVED thresholds, not from hardcoded month labels', () => {
    const b = sheetNamed(sheets, SHEET_UNCHARGEABLE_B);
    expect(cellFor(b, 'Resource', 'Bruno Bench', 'Category')).toBe(UNCHARGEABLE_CATEGORY_LABELS.B);
    expect(UNCHARGEABLE_CATEGORY_LABELS.B).toContain(String(IDLE_WORKING_DAYS_B_MAX));
    expect(UNCHARGEABLE_CATEGORY_LABELS.C).toContain(String(IDLE_WORKING_DAYS_C_MAX));
    expect(UNCHARGEABLE_CATEGORY_LABELS.D).toContain(String(IDLE_WORKING_DAYS_C_MAX + 1));
    // ASSERTION OF ABSENCE: the three AGING labels do not measure in calendar months.
    // This app ages in WORKING DAYS (product decision Q1), so RPT's own "meno di 1
    // mese" / "tra 1 e 2 mesi" wording would be a falsehood printed inside the file.
    // A is exempt and must stay so: "freeing up from next month" is a statement about
    // the CALENDAR, not a duration, and it is exactly what category A means.
    for (const c of ['B', 'C', 'D'] as const) expect(UNCHARGEABLE_CATEGORY_LABELS[c]).not.toContain('month');
    expect(UNCHARGEABLE_CATEGORY_LABELS.A).toContain('next month');
  });

  it('still yields all FOUR sheets, header-only, when nobody is unchargeable', () => {
    // A dropped tab reads as a report that failed to build; an empty one states that
    // nobody has been idle that long. RPT defines the workbook as four tabs.
    const none = unchargeableSheets(UEMPTY_ROLLUP, UM, UCTX, OPTS);
    expect(none.map((s) => s.name)).toStrictEqual([
      SHEET_UNCHARGEABLE_A, SHEET_UNCHARGEABLE_B, SHEET_UNCHARGEABLE_C, SHEET_UNCHARGEABLE_D,
    ]);
    for (const s of none) {
      expect(s.rows).toStrictEqual([]);
      expect(s.header.length).toBeGreaterThan(0);
    }
  });
});

// --- the privacy property, asserted on the produced file --------------------

/** Minimal ZIP reader: every entry of an xlsx, DECOMPRESSED. */
function xlsxEntries(zip: Uint8Array): Map<string, string> {
  const dec = new TextDecoder();
  const u16 = (o: number): number => zip[o] | (zip[o + 1] << 8);
  const u32 = (o: number): number => (zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | zip[o + 3] * 0x1000000) >>> 0;
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) if (u32(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const out = new Map<string, string>();
  let p = u32(eocd + 16);
  for (let n = 0, count = u16(eocd + 10); n < count; n++) {
    if (u32(p) !== 0x02014b50) throw new Error(`corrupt central directory at ${p}`);
    const method = u16(p + 10);
    const compSize = u32(p + 20);
    const nameLen = u16(p + 28);
    const localOff = u32(p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    const start = localOff + 30 + u16(localOff + 26) + u16(localOff + 28);
    const raw = zip.subarray(start, start + compSize);
    out.set(name, dec.decode(method === 0 ? raw : inflateRawSync(raw)));
    p += 46 + nameLen + u16(p + 30) + u16(p + 32);
  }
  return out;
}

describe('rpt-xlsx.util — the Unchargeable workbook carries NO absence cause', () => {
  /**
   * Absence reasons are special-category data (GDPR art. 9, spec §7.3) and the
   * audience of an exported bench roster is not the audience of a medical reason. The
   * pipeline structurally cannot leak one — `BenchCell` has no such field and
   * `/bench/monthly` transmits none — but "structurally cannot" is exactly the claim
   * that stops being true one field at a time, and a spreadsheet leaves the building.
   *
   * SCANNED ON THE DECOMPRESSED ENTRIES, not on the raw zip bytes. An xlsx is a
   * DEFLATE archive: searching the compressed bytes for 'Maternity' would find
   * nothing whatever the file contained, which is a green gate no data exercises —
   * the exact defect this project has now paid for twelve times. The vacuity check
   * below is what proves the scan can see text at all.
   */
  it('has no reason code anywhere in the file, and the scan is not vacuous', async () => {
    const away: BenchRollup = {
      months: [UM], hiringDemand: [], subcoRows: [],
      internalRows: [
        // An ABSENT person who IS in the report (returning to a bench month), which is
        // the only shape where a cause could plausibly have been attached.
        brow('U5', 'Elena Away', 'internal', { [UM]: { state: 'ABSENT', upcomingUnallocated: true } }),
      ],
    };
    const bytes = await buildXlsx(unchargeableSheets(away, UM, UCTX, OPTS));
    const entries = xlsxEntries(bytes);
    const text = [...entries.values()].join('\n');

    // NOT VACUOUS: the scan finds strings that ARE in the workbook — the subject's
    // name, her state, and a sheet name. Without this, the six assertions below would
    // pass over an unreadable blob.
    expect(text).toContain('Elena Away');
    expect(text).toContain('ABSENT');
    expect(text).toContain(SHEET_UNCHARGEABLE_A);
    expect(entries.has('xl/sharedStrings.xml')).toBe(true);

    // The property itself: none of the six codes, in any entry.
    expect(ABSENCE_REASON_CODES).toHaveLength(6);
    for (const code of ABSENCE_REASON_CODES) {
      expect(text, `absence reason "${code}" reached the exported workbook`).not.toContain(code);
    }
    // Nor the words a cause would arrive under if a future field were added.
    for (const word of ['reasonCode', 'Parental', 'Leave', 'Absence reason']) {
      expect(text).not.toContain(word);
    }
  }, 20_000);

  it('writes the four tabs and their rows into the real file', async () => {
    const bytes = await buildXlsx(unchargeableSheets(UROLLUP, UM, UCTX, OPTS));
    const mod = (await import('exceljs')) as typeof import('exceljs') & { default?: typeof import('exceljs') };
    const wb = new (mod.default ?? mod).Workbook();
    await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);

    expect(wb.worksheets.map((w) => w.name)).toStrictEqual([
      SHEET_UNCHARGEABLE_A, SHEET_UNCHARGEABLE_B, SHEET_UNCHARGEABLE_C, SHEET_UNCHARGEABLE_D,
    ]);
    // ROW COUNTS FROM THE FILE, not from the sheet objects: 1+1, 1+1, 1+1, 1+2. Four
    // header-only tabs would read 1/1/1/1 here.
    expect(wb.worksheets.map((w) => w.actualRowCount)).toStrictEqual([2, 2, 2, 3]);

    // AT LEAST ONE DATA CELL READ BACK PER SHEET, by header lookup rather than by a
    // counted column index.
    const built = unchargeableSheets(UROLLUP, UM, UCTX, OPTS);
    const at = (name: string, rowNo: number, header: string): unknown =>
      wb.getWorksheet(name)!.getCell(rowNo, col(sheetNamed(built, name), header) + 1).value;
    expect(at(SHEET_UNCHARGEABLE_A, 2, 'Resource')).toBe('Dario Freeing');
    expect(at(SHEET_UNCHARGEABLE_B, 2, 'Unallocated %')).toBe(100);
    expect(at(SHEET_UNCHARGEABLE_C, 2, 'Skill 1')).toBe('Kubernetes');
    expect(at(SHEET_UNCHARGEABLE_D, 3, 'Resource')).toBe('Subco Sergio');
    expect(at(SHEET_UNCHARGEABLE_D, 2, 'Available From')).toBe('Beyond 2026-09');
  }, 20_000);
});

// -----------------------------------------------------------------------------
// The Margin % column and the no-revenue sentinel.
//
// finance.util reports `marginPct` as 0 when there is no revenue — a sentinel
// for "undefined", not a measurement. Writing that 0 into a workbook is the
// worst place for it: nothing in the file recalls the caveat, and Excel will
// happily average it into a portfolio figure.
//
// EMPTY rather than an em dash, deliberately: this sheet's own convention for a
// missing money figure is `null` (see "leaves them EMPTY where there are none"
// above), Excel skips empty cells in =AVERAGE()/=SUM() where a 0 would drag the
// result down, and a dash would turn a numeric column into text.
// -----------------------------------------------------------------------------
describe('rpt-xlsx.util — Margin % is written only where revenue makes it measurable', () => {
  /** P1 earns; P2 carries real cost against no revenue (a non-billable engagement). */
  const MIXED: RptProjectFinancials[] = [
    ...FINANCIALS,
    {
      id: 'P2', revenue: 0, laborCost: 8000, externalCost: 0, expenseCost: 0,
      margin: -8000, marginPct: 0, eac: 8000, vac: -8000,
      pcpBaseline: 0, pcpPlanned: 0, pcpDelta: 0,
    },
  ];
  const sheet = planningSheet(DATA, MIXED, OPTS);

  it('writes the real percentage for a commessa that earns revenue', () => {
    expect(cellFor(sheet, 'Commessa', 'Alpha Migration', 'Margin %')).toBe(54);
  });

  it('leaves the cell EMPTY — never 0 — for a commessa that earns none', () => {
    expect(cellFor(sheet, 'Commessa', 'Beta Rollout', 'Margin %')).toBeNull();
  });

  it('KEEPS the margin AMOUNT, which is measured, beside the percentage that is not', () => {
    // The distinction the whole change turns on: -8,000 is a real figure and
    // must reach the workbook. Only the ratio is undefined.
    expect(cellFor(sheet, 'Commessa', 'Beta Rollout', `Margin (${OPTS.currency})`)).toBe(-8000);
    expect(cellFor(sheet, 'Commessa', 'Beta Rollout', `Labor Cost (${OPTS.currency})`)).toBe(8000);
  });

  it('still blanks the cell for a commessa with NO financial row at all', () => {
    // A different absence with the same rendering, and both must hold: the
    // guard reads `l.fin && …`, so dropping either half regresses one of them.
    expect(cellFor(sheet, 'Commessa', 'Gamma Idle', 'Margin %')).toBeNull();
  });
});

/**
 * No source file may contain a LITERAL NUL byte.
 *
 * `allocationCube` builds its composite key as `${resourceId}\0${projectId}`,
 * and a NUL really is the right separator — no id can contain one, so the key
 * is unambiguous. The hazard is writing it RAW instead of as the escape `\0`:
 * git then classifies the whole file as binary, which costs a line diff, a
 * line-level merge, and — the one that actually bit — grep, which silently
 * skips binary files. A repo-wide grep for a symbol in this file returned
 * nothing while the symbol sat on line 295, and only a scan that read bytes
 * found it.
 *
 * The escape and the literal produce the identical runtime string, so this
 * costs nothing to keep true.
 */
describe('no source file is secretly binary', () => {
  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') sourceFiles(full, acc); }
      else if (/\.(ts|html|css|json|mjs)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  }

  it('contains no literal NUL byte anywhere under src/', () => {
    const SRC = resolve(__dirname, '..', '..');
    const offenders = sourceFiles(SRC)
      .filter(f => readFileSync(f).includes(0x00))
      .map(f => relative(SRC, f));
    expect(offenders, "write '\\0' as an escape; a raw NUL makes git treat the file as binary").toStrictEqual([]);
  });

  it('CONFIRMS the detector works — a byte array carrying a NUL is recognised', () => {
    // Without this the test above is satisfied by a scan that reads nothing.
    expect(Buffer.from([0x61, 0x00, 0x62]).includes(0x00)).toBe(true);
    expect(Buffer.from('ab', 'utf8').includes(0x00)).toBe(false);
    // And the escape this file uses really is one byte of value zero.
    expect(Buffer.from(`a\0b`, 'utf8')).toStrictEqual(Buffer.from([0x61, 0x00, 0x62]));
  });
});
