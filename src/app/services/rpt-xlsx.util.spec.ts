import { beforeAll, describe, expect, it } from 'vitest';
import type { Assignment, AssignmentDay, AssignmentMonth, Project, Resource, ResourceRequest } from './api.service';
import { monthRowId } from './allocation-month.util';
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
