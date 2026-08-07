import {
  capacityForecast,
  forecastUtilizationBand,
  overAllocated,
  skillGap,
  isCompleteForecastWindow,
  utilizationChangeTone,
  ForecastData,
} from './forecast.util';
import { Resource, ResourceRequest, Assignment, AssignmentDay, AssignmentMonth, RedactedAbsence } from './api.service';
import { MonthStatus, monthRowId } from './allocation-month.util';
import { ResourceKind } from './resource-kind.util';
// Imported to CROSS-CHECK, never to re-test: `notFullyAllocatedAt` is /what-if's
// bench KPI, and the last H suite in this file asserts that it and
// `capacityForecast`'s supply now agree about the same absent person. Neither that
// file nor bench.util.ts is touched here, so the only way to show the two tiles
// stopped contradicting each other is to put both answers in one assertion.
import { notFullyAllocatedAt } from './bench.util';

/**
 * The month `skillGap` measures coverage "as of" throughout this suite. Coverage
 * is employment-dependent, so every call has to name a month — there is no
 * "whenever" for whether somebody works here.
 */
const AS_OF = '2026-08';

/** One month of an assignment: its lifecycle status and the hours booked in it. */
interface MonthPlan {
  month: string;
  status: MonthStatus;
  hours: number;
}

/**
 * Build the (assignmentDays, assignmentMonths) pair for an assignment.
 *
 * These rows are NOT decoration: committed demand is aggregated from them
 * (`monthlyAggregateHours`), so a fixture without them books nothing. The
 * previous version of this file spread a hard-coded `EMPTY_TAIL` into every
 * fixture with a comment claiming `capacityForecast`/`overAllocated` "never
 * read" these fields — which is what let the suite report full coverage of
 * committed demand while the only shape that occurs in production (an assignment
 * with one approved month and one still-pending month) was untested.
 */
function monthRows(assignmentId: string, plans: readonly MonthPlan[]): {
  days: AssignmentDay[];
  months: AssignmentMonth[];
} {
  return {
    days: plans.map(p => ({
      id: `${assignmentId}:${p.month}:day`,
      assignmentId,
      date: `${p.month}-03`,
      hours: p.hours,
    })),
    months: plans.map(p => ({
      id: monthRowId(assignmentId, p.month),
      assignmentId,
      month: p.month,
      status: p.status,
    })),
  };
}

/** `ForecastData`'s allocation-row tail, assembled from zero or more `monthRows` groups. */
function tail(...groups: { days: AssignmentDay[]; months: AssignmentMonth[] }[]) {
  return {
    assignmentDays: groups.flatMap(g => g.days),
    assignmentMonths: groups.flatMap(g => g.months),
    holidays: [],
    hoursPerDay: 8,
  };
}

/**
 * No day/month rows at all. Committed demand is then 0 BY RULE, not by accident:
 * `monthlyAggregateHours` documents that a day whose month row is absent
 * contributes to neither total (B1 self-healing), and with no day rows there is
 * nothing to aggregate. Used by the fixtures that are about pipeline, supply or
 * skills — never as a stand-in for "committed demand exists".
 */
const NO_ALLOCATION_ROWS = tail();

/**
 * `NO_ALLOCATION_ROWS` plus a public-holiday calendar.
 *
 * `ForecastData.holidays` was fetched by both consumers and then read by NOTHING
 * in this module, so every fixture here passed `[]` and any holiday hop could be
 * dropped without turning a single case red. The cases below that pass a real
 * holiday are the only ones that pin the threading.
 */
function withHolidays(...ids: readonly string[]) {
  return { ...NO_ALLOCATION_ROWS, holidays: ids.map(id => ({ id, name: id })) };
}

function res(
  id: string,
  capacity: number,
  utilization: number,
  skills: { name: string; level: number }[] = [],
  kind?: ResourceKind,
  extra: Partial<Resource> = {},
): Resource {
  return {
    id,
    name: `R${id}`,
    role: 'Dev',
    skills,
    projectRoles: [],
    externalExperience: [],
    utilization,
    capacity,
    ...(kind ? { kind } : {}),
    ...extra,
  };
}

function req(
  id: string,
  requiredEffort: number,
  status: string,
  extra: Partial<ResourceRequest> = {},
): ResourceRequest {
  return {
    id,
    name: `Req${id}`,
    requiredRole: 'Dev',
    requiredEffort,
    status,
    skills: [],
    ...extra,
  };
}

function assign(
  id: string,
  requestId: string,
  resourceId: string,
  hours: number,
  status: Assignment['status'] = 'Allocated',
): Assignment {
  return { id, requestId, resourceId, assignedHours: hours, status };
}

/**
 * One REDACTED absence interval, both bounds inclusive.
 *
 * `RedactedAbsence` and not `ResourceAbsence`: `reasonCode` is typed `never` on it,
 * so a fixture that tried to make the arithmetic branch on WHY somebody is away
 * would not compile — which is the point of the redacted projection (spec §3.4).
 */
function absence(resourceId: string, startDate: string, endDate: string): RedactedAbsence {
  return { id: `abs:${resourceId}:${startDate}`, resourceId, startDate, endDate };
}

describe('forecast.util — capacityForecast', () => {
  it('builds N weekly periods with 7-day-spaced ISO labels', () => {
    const data: ForecastData = { resources: [res('1', 40, 50)], requests: [], assignments: [], ...NO_ALLOCATION_ROWS };
    const rows = capacityForecast(data, '2026-06-08', 4);
    expect(rows.length).toBe(4);
    expect(rows.map(r => r.period)).toEqual([
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
      '2026-06-29',
    ]);
  });

  it('sums resource capacity into per-period supply (weekly hours)', () => {
    const data: ForecastData = {
      resources: [res('1', 40, 0), res('2', 32, 0)],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-06-08', 2);
    expect(rows.every(r => r.supply === 72)).toBe(true);
  });

  it('spreads committed assignment hours across the linked request window', () => {
    // Request spans exactly two periods (14 days); 80 confirmed hours split evenly = 40 each.
    const data: ForecastData = {
      resources: [res('1', 40, 0)],
      requests: [req('r1', 0, 'Open', { startDate: '2026-06-08', endDate: '2026-06-22' })],
      assignments: [assign('a1', 'r1', '1', 80)],
      ...tail(monthRows('a1', [{ month: '2026-06', status: 'Allocated', hours: 80 }])),
    };
    const rows = capacityForecast(data, '2026-06-08', 3);
    expect(rows[0].committed).toBeCloseTo(40, 6);
    expect(rows[1].committed).toBeCloseTo(40, 6);
    expect(rows[2].committed).toBeCloseTo(0, 6);
  });

  it('falls back to the first period when the linked request has no window', () => {
    const data: ForecastData = {
      resources: [res('1', 40, 0)],
      requests: [req('r1', 0, 'Open')], // no start/end dates
      assignments: [assign('a1', 'r1', '1', 25)],
      ...tail(monthRows('a1', [{ month: '2026-06', status: 'Allocated', hours: 25 }])),
    };
    const rows = capacityForecast(data, '2026-06-08', 3);
    expect(rows[0].committed).toBe(25);
    expect(rows[1].committed).toBe(0);
    expect(rows[2].committed).toBe(0);
  });

  it('counts only the unstaffed remainder of open requests as pipeline demand', () => {
    // requiredEffort 100, staffedEffort 30 -> 70 unstaffed, spread over one period (point window).
    const data: ForecastData = {
      resources: [res('1', 40, 0)],
      requests: [
        req('r1', 100, 'Open', { staffedEffort: 30, startDate: '2026-06-08', endDate: '2026-06-08' }),
      ],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-06-08', 2);
    expect(rows[0].pipeline).toBe(70);
    expect(rows[1].pipeline).toBe(0);
  });

  it('excludes fully-staffed and closed requests from pipeline demand', () => {
    const data: ForecastData = {
      resources: [res('1', 40, 0)],
      requests: [
        req('full', 50, 'Open', { staffedEffort: 50 }), // nothing left to staff
        req('closed', 40, 'Fulfilled'), // closed status
      ],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-06-08', 2);
    expect(rows[0].pipeline).toBe(0);
    expect(rows[1].pipeline).toBe(0);
  });

  it('computes demand, utilizationPct and gap from supply', () => {
    // supply 40; committed 30 (point in P0) + pipeline 10 (point in P0) = demand 40 -> 100% util, gap 0.
    const data: ForecastData = {
      resources: [res('1', 40, 0)],
      requests: [
        req('r1', 0, 'Open', { startDate: '2026-06-08', endDate: '2026-06-08' }),
        req('p1', 10, 'Open', { startDate: '2026-06-08', endDate: '2026-06-08' }),
      ],
      assignments: [assign('a1', 'r1', '1', 30)],
      ...tail(monthRows('a1', [{ month: '2026-06', status: 'Allocated', hours: 30 }])),
    };
    const rows = capacityForecast(data, '2026-06-08', 1);
    expect(rows[0].committed).toBe(30);
    expect(rows[0].pipeline).toBe(10);
    expect(rows[0].demand).toBe(40);
    expect(rows[0].utilizationPct).toBe(100);
    expect(rows[0].gap).toBe(0);
  });

  it('reports NO utilization (null, never 0%) for a period with zero capacity', () => {
    const data: ForecastData = {
      resources: [res('1', 0, 0)], // zero capacity -> zero supply
      requests: [req('p1', 50, 'Open', { startDate: '2026-06-08', endDate: '2026-06-08' })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-06-08', 1);
    expect(rows[0].supply).toBe(0);
    expect(rows[0].demand).toBe(50);
    // null = "no answer". Not Infinity/NaN, and NOT the 0 this used to assert:
    // 0% sits in the below-healthy band, so every consumer painted a period with
    // no capacity at all as spare capacity and folded it into the average.
    expect(rows[0].utilizationPct).toBeNull();
    expect(rows[0].gap).toBe(-50);
  });

  it('returns an empty horizon for non-positive periods or an unparseable start', () => {
    const data: ForecastData = { resources: [res('1', 40, 0)], requests: [], assignments: [], ...NO_ALLOCATION_ROWS };
    expect(capacityForecast(data, '2026-06-08', 0)).toEqual([]);
    expect(capacityForecast(data, '2026-06-08', -3)).toEqual([]);
    expect(capacityForecast(data, 'not-a-date', 4)).toEqual([]);
  });

  it('scales weekly supply to a monthly period unit', () => {
    const data: ForecastData = { resources: [res('1', 40, 0)], requests: [], assignments: [], ...NO_ALLOCATION_ROWS };
    const rows = capacityForecast(data, '2026-06-08', 1, 'monthly');
    expect(rows[0].supply).toBeCloseTo(40 * (52 / 12), 6);
  });

  it('excludes dummy resources from supply but keeps subco in (C1: a dummy is not deliverable capacity)', () => {
    // Distinct capacities per kind so the assertion can only pass for the
    // correct filter: excluding internal (60), excluding subco (30), or
    // summing all three (70) are all distinguishable from the expected 50.
    const data: ForecastData = {
      resources: [
        res('1', 10, 0, [], 'internal'),
        res('2', 20, 0, [], 'dummy'),
        res('3', 40, 0, [], 'subco'),
      ],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-06-08', 1);
    // internal (10) + subco (40) = 50; the dummy's 20 must NOT be counted.
    expect(rows[0].supply).toBe(50);
  });
});

/**
 * Committed demand is the CONFIRMED month hours, not `Assignment.status` +
 * `assignedHours`.
 *
 * The case this replaced ("counts only approved allocations as committed
 * demand") asserted that the assignment-level status IS the policy — it pinned
 * `committed === 20` for an assignment with no month rows at all. That is the
 * defect: `Assignment.status` is a DERIVED rollup in which one pending month
 * dominates every approved one, so the pinned model erases board-approved hours
 * in the mixed case and over-counts unapproved ones in the inverse case. The
 * arithmetic below restates the same intent ("only approved work is committed")
 * at the granularity the approval actually happens at.
 */
describe('forecast.util — committed demand comes from the CONFIRMED month rows', () => {
  /** Request + assignment shaped like the live case: Aug approved, Sep pending. */
  function mixedMonthData(plans: readonly MonthPlan[], staffedEffort: number): ForecastData {
    return {
      resources: [res('1', 320, 0)],
      requests: [
        req('r1', 320, 'Open', { staffedEffort, startDate: '2026-08-03', endDate: '2026-09-28' }),
      ],
      // Derived rollup of ['Allocated','Requested'] is 'Requested' — which is
      // exactly why the old all-or-nothing filter dropped the whole booking.
      assignments: [assign('a1', 'r1', '1', 320, 'Requested')],
      ...tail(monthRows('a1', plans)),
    };
  }

  it('keeps the APPROVED month of an assignment whose other month is still pending', () => {
    const data = mixedMonthData(
      [
        { month: '2026-08', status: 'Allocated', hours: 160 },
        { month: '2026-09', status: 'Requested', hours: 160 },
      ],
      160,
    );
    const rows = capacityForecast(data, '2026-08-03', 8);
    const committed = rows.reduce((acc, r) => acc + r.committed, 0);
    const demand = rows.reduce((acc, r) => acc + r.demand, 0);

    // 160 approved hours are committed demand; the unstaffed 160 stays pipeline.
    expect(committed).toBeCloseTo(160, 6);
    expect(demand).toBeCloseTo(320, 6);
    // Absence: the erasure this closes. The whole engagement contributed 0.00
    // committed hours to every week of the forecast, the Committed bar and the CSV.
    expect(committed).not.toBeCloseTo(0, 6);
  });

  it('counts NOTHING when every month is still awaiting a decision', () => {
    // The absence twin of the case above: a fix that merely deleted the status
    // filter and counted every assignment would report 320 here.
    const data = mixedMonthData(
      [
        { month: '2026-08', status: 'Requested', hours: 160 },
        { month: '2026-09', status: 'Requested', hours: 160 },
      ],
      0,
    );
    const rows = capacityForecast(data, '2026-08-03', 8);
    expect(rows.reduce((acc, r) => acc + r.committed, 0)).toBe(0);
    // ...while the unstaffed effort is still visible as pipeline, so "0 committed"
    // is a statement about approval, not a dropped booking.
    expect(rows.reduce((acc, r) => acc + r.pipeline, 0)).toBeCloseTo(320, 6);
  });

  it('counts NOTHING for an assignment with no month row at all', () => {
    // monthlyAggregateHours' documented rule: a day whose month row is absent
    // contributes to neither total. Here there are no rows of either kind.
    const data = mixedMonthData([], 0);
    const rows = capacityForecast(data, '2026-08-03', 8);
    expect(rows.reduce((acc, r) => acc + r.committed, 0)).toBe(0);
  });

  it('does not count a Draft/Rejected month even when the rollup reads Allocated', () => {
    // The inverse direction, previously untested: ['Allocated','Draft'] rolls up
    // to 'Allocated', so the old filter took the assignment's whole 200h.
    const data: ForecastData = {
      resources: [res('1', 320, 0)],
      requests: [req('r1', 0, 'Open', { startDate: '2026-08-03', endDate: '2026-09-28' })],
      assignments: [assign('a1', 'r1', '1', 200, 'Allocated')],
      ...tail(
        monthRows('a1', [
          { month: '2026-08', status: 'Allocated', hours: 100 },
          { month: '2026-09', status: 'Draft', hours: 100 },
        ]),
      ),
    };
    const rows = capacityForecast(data, '2026-08-03', 8);
    const committed = rows.reduce((acc, r) => acc + r.committed, 0);
    expect(committed).toBeCloseTo(100, 6);
    expect(committed).not.toBeCloseTo(200, 6);
  });

  it('ignores a Rejected month entirely', () => {
    const data: ForecastData = {
      resources: [res('1', 320, 0)],
      requests: [req('r1', 0, 'Open', { startDate: '2026-08-03', endDate: '2026-09-28' })],
      assignments: [assign('a1', 'r1', '1', 50, 'Rejected')],
      ...tail(monthRows('a1', [{ month: '2026-08', status: 'Rejected', hours: 50 }])),
    };
    const rows = capacityForecast(data, '2026-08-03', 8);
    expect(rows.reduce((acc, r) => acc + r.committed, 0)).toBe(0);
  });
});

/**
 * Supply and skill coverage may only count people who actually work here in the
 * period being measured. Every case here is paired with the one that must still
 * be ALLOWED — a gate that always refuses would otherwise pass the lot.
 */
describe('forecast.util — supply and coverage follow employment', () => {
  it('drops a resource who left before the horizon, keeps one whose leaving date is still ahead', () => {
    const data: ForecastData = {
      resources: [
        res('leaver', 40, 0, [], 'internal', { terminationDate: '2026-03-15' }),
        res('staying', 40, 0, [], 'internal', { terminationDate: '2026-12-31' }),
      ],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-08-03', 1);
    // Only the person still employed in August contributes.
    expect(rows[0].supply).toBe(40);
    // Absence: the inflated total the /forecast KPI used to advertise, which the
    // Bench table on the same page already excluded.
    expect(rows[0].supply).not.toBe(80);
  });

  it('makes supply period-dependent: a future hire contributes 0 before joining and full capacity after', () => {
    const data: ForecastData = {
      resources: [res('joiner', 40, 0, [], 'internal', { hireDate: '2026-10-01' })],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    // 10 weekly periods from 2026-08-03: rows[0] is August, rows[9] is 2026-10-05.
    const rows = capacityForecast(data, '2026-08-03', 10);
    expect(rows[0].period).toBe('2026-08-03');
    expect(rows[9].period).toBe('2026-10-05');
    expect(rows[0].supply).toBe(0);
    // The presence half: supply must actually VARY by period, so "drop anyone
    // with a hireDate" and "supply is a constant" both fail here.
    expect(rows[9].supply).toBe(40);
  });

  it('reports no utilization (not 0%) for a period whose only resource has not joined yet', () => {
    // The P1-17/P1-18 coupling: once supply can legitimately be 0 for a period,
    // that period has no utilisation to report even though demand is real.
    const data: ForecastData = {
      resources: [res('joiner', 40, 0, [], 'internal', { hireDate: '2026-10-01' })],
      requests: [req('p1', 20, 'Open', { startDate: '2026-08-03', endDate: '2026-08-03' })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-08-03', 10);
    expect(rows[0].demand).toBe(20);
    expect(rows[0].utilizationPct).toBeNull();
    // ...and the period where she IS employed reports a real number.
    expect(rows[9].utilizationPct).toBe(0);
  });

  it('does not count a departed holder of a skill as coverage', () => {
    const data: ForecastData = {
      resources: [
        res('gone', 40, 0, [{ name: 'Java', level: 4 }], 'internal', { terminationDate: '2026-03-15' }),
        res('here', 40, 0, [{ name: 'Angular', level: 3 }], 'internal'),
      ],
      requests: [req('r1', 80, 'Open', { skills: ['Java', 'Angular'] })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const gaps = skillGap(data, AS_OF);

    const java = gaps.find(g => g.skill === 'Java');
    expect(java?.supplyCount).toBe(0);
    // The shortage the inflated count suppressed: the only Java holder has left.
    expect(java?.shortage).toBe(true);
    // The presence twin — an employed holder must still count, so the fix cannot
    // be "stop counting skills".
    const angular = gaps.find(g => g.skill === 'Angular');
    expect(angular?.supplyCount).toBe(1);
    expect(angular?.shortage).toBe(false);
  });

  it('counts a hire as coverage from the month she starts, not before', () => {
    const data: ForecastData = {
      resources: [res('joiner', 40, 0, [{ name: 'Go', level: 3 }], 'internal', { hireDate: '2026-10-01' })],
      requests: [req('r1', 40, 'Open', { skills: ['Go'] })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    expect(skillGap(data, '2026-08')[0].supplyCount).toBe(0);
    expect(skillGap(data, '2026-10')[0].supplyCount).toBe(1);
  });
});

/**
 * Employment is measured in DAYS, one calendar day at a time, because that is how
 * the SERVER measures it (`bookingOutsideEmploymentError`) and how /capacity and
 * /bench already measure it (`employedWorkingDays`). Until this change /forecast
 * measured it per MONTH, so the two Capacity Control screens disagreed about the
 * same mid-month joiner.
 *
 * August 2026 calendar facts every case below relies on (verified, not assumed):
 * the 3rd, 10th, 17th and 24th are all MONDAYS, so each weekly period from
 * 2026-08-03 spans exactly five working days (Mon–Fri) with no holidays; the 19th
 * is a Wednesday, the 20th a Thursday, the 21st a Friday; the 30th is a SUNDAY and
 * the 31st a Monday.
 */
describe('forecast.util — employment is measured per DAY, and supply is pro-rated', () => {
  /** Weekly periods from this Monday: P0 Aug 3-9, P1 Aug 10-16, P2 Aug 17-23, P3 Aug 24-30. */
  const HORIZON_START = '2026-08-03';
  const WORKING_DAYS_PER_WEEK = 5;

  it('gives a mid-month joiner the weeks she works — and still nothing for the weeks before she arrives', () => {
    // THE JOINER DEFECT. The month-granular gate compared hireDate ('2026-08-17') with
    // the month's START, so every August week reported 0 supply for a person whose
    // August hours /allocation-calendar books and the API accepts.
    const data: ForecastData = {
      resources: [res('joiner', 40, 0, [], 'internal', { hireDate: '2026-08-17' })],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, HORIZON_START, 4);
    expect(rows.map(r => r.period)).toEqual(['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24']);

    // RED before: 0. She is employed for all five working days of both weeks.
    expect(rows[2].supply).toBe(40);
    expect(rows[3].supply).toBe(40);

    // THE ABSENCE TWIN, and the reason a bare presence gate was not enough: simply
    // admitting the hire MONTH would advertise a full 40h/week for two weeks that
    // ended before she existed here — trading an under-report for an over-report.
    expect(rows[0].supply).toBe(0);
    expect(rows[1].supply).toBe(0);
    expect(rows[0].utilizationPct).toBeNull();
    expect(rows[1].utilizationPct).toBeNull();
  });

  it('pro-rates the week that STRADDLES the hire date instead of answering all-or-nothing', () => {
    // Hired Wednesday the 19th: three of the week's five working days (19, 20, 21).
    const EMPLOYED_DAYS = 3;
    const data: ForecastData = {
      resources: [res('joiner', 40, 0, [], 'internal', { hireDate: '2026-08-19' })],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-08-17', 1);
    expect(rows[0].supply).toBeCloseTo(40 * (EMPLOYED_DAYS / WORKING_DAYS_PER_WEEK), 10);
    // Both wrong answers named explicitly: 0 was the old one, 40 is the one a
    // presence-only gate would give.
    expect(rows[0].supply).not.toBe(0);
    expect(rows[0].supply).not.toBe(40);
  });

  it('stops a mid-week leaver’s supply the day they go, and keeps the full-timer beside them whole', () => {
    // THE LEAVER MIRROR. The month-granular test credited the whole of August, so
    // the week of the 24th advertised 40h for somebody who left on the 19th.
    const EMPLOYED_DAYS = 3; // Mon 17, Tue 18, Wed 19
    const data: ForecastData = {
      resources: [
        res('leaver', 40, 0, [], 'internal', { terminationDate: '2026-08-19' }),
        res('steady', 32, 0, [], 'internal', { hireDate: '2020-01-01' }),
      ],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const rows = capacityForecast(data, '2026-08-17', 2);
    // Week of the 17th: the leaver's pro-rated share PLUS the full-timer's 32.
    expect(rows[0].supply).toBeCloseTo(32 + 40 * (EMPLOYED_DAYS / WORKING_DAYS_PER_WEEK), 10);
    // Week of the 24th: only the full-timer is left. RED before: 72.
    expect(rows[1].supply).toBe(32);
    expect(rows[1].supply).not.toBe(72);
    // Utilisation still exists in that week — pro-rating must not manufacture an
    // "n/a" wherever anybody's employment ends.
    expect(rows[1].utilizationPct).not.toBeNull();
  });

  it('leaves an ordinary full-time employee at EXACTLY her capacity, holiday in the week or not', () => {
    // ABSENCE TWIN, the one that matters most: a pro-rating applied to everybody
    // would pass every case above while quietly halving the whole org's supply.
    // A holiday shortens the week for employee and employer alike, so it cancels
    // out of the ratio — the same way it cancels out of `rollupMonthly`'s FTE.
    const steady = res('steady', 40, 0, [], 'internal', { hireDate: '2020-01-01', terminationDate: '2030-01-01' });
    const base = { resources: [steady], requests: [], assignments: [] };
    const plain = capacityForecast({ ...base, ...NO_ALLOCATION_ROWS }, '2026-08-17', 1);
    const withThursdayClosed = capacityForecast({ ...base, ...withHolidays('2026-08-20') }, '2026-08-17', 1);
    expect(plain[0].supply).toBe(40);
    expect(withThursdayClosed[0].supply).toBe(40);
  });

  it('threads the holiday calendar into the pro-rating (the hop that was dead code here)', () => {
    // Hired Wednesday the 19th with Thursday the 20th closed: the week has FOUR
    // working days (17, 18, 19, 21) and she is employed for two of them (19, 21).
    // 40 × 2/4 = 20, against 40 × 3/5 = 24 with no holiday — so dropping
    // `holidaySet` from either call changes the number instead of staying green.
    const joiner = res('joiner', 40, 0, [], 'internal', { hireDate: '2026-08-19' });
    const base = { resources: [joiner], requests: [], assignments: [] };
    const closed = capacityForecast({ ...base, ...withHolidays('2026-08-20') }, '2026-08-17', 1);
    const open = capacityForecast({ ...base, ...NO_ALLOCATION_ROWS }, '2026-08-17', 1);
    expect(closed[0].supply).toBeCloseTo(40 * (2 / 4), 10);
    expect(open[0].supply).toBeCloseTo(40 * (3 / 5), 10);
    expect(closed[0].supply).not.toBeCloseTo(open[0].supply, 6);
  });

  it('pro-rates a monthly period the same way, on the period’s own working days', () => {
    // A monthly period is a 30-day rolling window, not a calendar month, so the
    // denominator is the window's working days — and the ratio is 1 for a
    // full-timer, keeping the weekly→monthly scale factor exact.
    const base = { requests: [], assignments: [], ...NO_ALLOCATION_ROWS };
    const steadyRows = capacityForecast(
      { ...base, resources: [res('steady', 40, 0, [], 'internal', { hireDate: '2020-01-01' })] },
      '2026-08-03', 1, 'monthly',
    );
    expect(steadyRows[0].supply).toBeCloseTo(40 * (52 / 12), 6);

    // 2026-08-03 + 30 days ⇒ the window is 2026-08-03..2026-09-01 inclusive, which
    // holds 22 working days (verified). A hire on 2026-09-01, a Tuesday, is
    // employed for exactly ONE of them.
    const WINDOW_WORKING_DAYS = 22;
    const joinerRows = capacityForecast(
      { ...base, resources: [res('joiner', 40, 0, [], 'internal', { hireDate: '2026-09-01' })] },
      '2026-08-03', 1, 'monthly',
    );
    // RED before: 0, because the window's FIRST month is August and she is a
    // September hire — a 30-day window is not a calendar month.
    expect(joinerRows[0].supply).toBeCloseTo(40 * (52 / 12) * (1 / WINDOW_WORKING_DAYS), 10);
    expect(joinerRows[0].supply).toBeGreaterThan(0);
    // Absence: not the whole month's worth, which is what admitting the window's
    // month wholesale would have produced.
    expect(joinerRows[0].supply).not.toBeCloseTo(steadyRows[0].supply, 6);
  });

  it('counts a mid-month hire as skill coverage in her hire month', () => {
    // Same day-granular question on the coverage side: she is bookable on every
    // working day from the 17th, so 'Go' is covered and the shortage badge must
    // stop shouting for a hire the org has already made. RED before: 0 / true.
    const data: ForecastData = {
      resources: [res('joiner', 40, 0, [{ name: 'Go', level: 3 }], 'internal', { hireDate: '2026-08-17' })],
      requests: [req('r1', 40, 'Open', { skills: ['Go'] })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    expect(skillGap(data, '2026-08')[0].supplyCount).toBe(1);
    expect(skillGap(data, '2026-08')[0].shortage).toBe(false);
    // ABSENCE TWIN: the month BEFORE she starts must still report the shortage, so
    // the gate cannot have been deleted rather than made day-granular.
    expect(skillGap(data, '2026-07')[0].supplyCount).toBe(0);
    expect(skillGap(data, '2026-07')[0].shortage).toBe(true);
  });

  it('does not count a hire whose only days in the month are non-working days', () => {
    // The distinction between "hired within this month" and "employed for a day
    // she could actually work": hired SUNDAY the 30th with Monday the 31st closed,
    // so August holds no working day of hers at all. A month-containment test
    // would say "covered"; the calendar says otherwise.
    const data: ForecastData = {
      resources: [res('joiner', 40, 0, [{ name: 'Go', level: 3 }], 'internal', { hireDate: '2026-08-30' })],
      requests: [req('r1', 40, 'Open', { skills: ['Go'] })],
      assignments: [],
      ...withHolidays('2026-08-31'),
    };
    expect(skillGap(data, '2026-08')[0].supplyCount).toBe(0);
    expect(skillGap(data, '2026-08')[0].shortage).toBe(true);
    // ...and September, her first real working month, must flip both back.
    expect(skillGap(data, '2026-09')[0].supplyCount).toBe(1);
    expect(skillGap(data, '2026-09')[0].shortage).toBe(false);
  });
});

/**
 * H — ABSENCES ARE NOT SUPPLY (spec §11's declared residue, register P1-17/P1-18).
 *
 * EVERY TEST IN HERE IS DIFFERENTIAL, AND THAT IS NOT A STYLE CHOICE.
 * `ForecastData.absences` is optional with an empty default, so `absences: []`
 * reproduces the pre-H arithmetic to the digit: all ~60 cases above this block stay
 * green while exercising not one new line. A value assertion alone therefore proves
 * nothing about whether the field is read — only the SAME fixture run twice, with
 * and without rows, asserted to DISAGREE, can. That is the twelfth instance of this
 * project's blind-green-gate defect being designed out rather than discovered.
 *
 * And a differential can lie too, which is the second trap: if the absence covers
 * days that were never workable — a weekend, a public holiday, a day outside the
 * person's employment — the supply does not move and the differential measures
 * zero while looking like a pass. So every mover below is paired with a TWIN whose
 * absence lands on non-working days and must move NOTHING. Without both halves you
 * cannot tell "reads the absence calendar" from "subtracts arbitrary days".
 */
describe('forecast.util — H: an absent day is not supply, and demand does not move', () => {
  /** Mon 2026-08-17. The week is Mon 17 – Sun 23, five working days: 17-21. */
  const WEEK_START = '2026-08-17';
  const WORKING_DAYS_PER_WEEK = 5;

  /** One full-time internal, employed long before and long after the horizon. */
  const alice = res('alice', 40, 0, [], 'internal', { hireDate: '2020-01-01' });
  const bob = res('bob', 32, 0, [], 'internal', { hireDate: '2020-01-01' });

  function forecastOf(absences: RedactedAbsence[], resources: Resource[] = [alice], periods = 1) {
    return capacityForecast(
      { resources, requests: [], assignments: [], ...NO_ALLOCATION_ROWS, absences },
      WEEK_START,
      periods,
    );
  }

  it('subtracts the absent WORKING days from a week’s supply', () => {
    // Tue-Thu off: three of the week's five working days gone, so two remain.
    // 40 × 2/5 = 16. This is the whole defect §11 left standing — the week
    // advertised 40h for somebody the API would refuse a booking for on three of
    // the five days (§6.4's write gate).
    const PRESENT_DAYS = 2;
    const without = forecastOf([]);
    const withRows = forecastOf([absence('alice', '2026-08-18', '2026-08-20')]);

    expect(without[0].supply).toBe(40);
    expect(withRows[0].supply).toBeCloseTo(40 * (PRESENT_DAYS / WORKING_DAYS_PER_WEEK), 10);
    // THE DIFFERENTIAL. Delete the `availableWorkingDays` call and this is the line
    // that goes red; the two value assertions above would not.
    expect(withRows[0].supply).not.toBeCloseTo(without[0].supply, 6);
  });

  it('subtracts NOTHING for an absence that only covers a weekend', () => {
    // THE TWIN. Sat + Sun off is not a day of capacity lost, because neither was
    // capacity to begin with. A fix that subtracted calendar days rather than
    // working days would report 40 × 3/5 = 24 here and still pass the case above.
    const without = forecastOf([]);
    const weekendOnly = forecastOf([absence('alice', '2026-08-22', '2026-08-23')]);
    expect(weekendOnly[0].supply).toBe(40);
    expect(weekendOnly.map(r => r.supply)).toStrictEqual(without.map(r => r.supply));
  });

  it('subtracts NOTHING for an absence that only covers a public holiday', () => {
    // The same twin against the OTHER non-working day, and it doubles as the
    // holiday-threading pin: with Thursday closed the week has four working days
    // (17, 18, 19, 21) and an absence on Thursday takes none of them, so the ratio
    // is 4/4 and supply is whole. Drop `holidaySet` from either `windowDays` call
    // and the answer becomes 40 × 4/5 = 32 instead.
    const base = { resources: [alice], requests: [], assignments: [] };
    const thursdayOff = [absence('alice', '2026-08-20', '2026-08-20')];
    const closed = capacityForecast({ ...base, ...withHolidays('2026-08-20'), absences: thursdayOff }, WEEK_START, 1);
    const open = capacityForecast({ ...base, ...NO_ALLOCATION_ROWS, absences: thursdayOff }, WEEK_START, 1);

    expect(closed[0].supply).toBe(40);
    // ...and on an ordinary week the very same absence DOES cost a fifth of it, so
    // "nothing moved" above is a statement about the calendar, not a dead branch.
    expect(open[0].supply).toBeCloseTo(40 * (4 / WORKING_DAYS_PER_WEEK), 10);
    expect(closed[0].supply).not.toBeCloseTo(open[0].supply, 6);
  });

  it('reports NO utilization (null, never 0%) for a week nobody is available for', () => {
    // A fully-absent week with a single resource has no supply at all, and the
    // established rule is that no supply means no answer — a 0 there would paint
    // the week as spare capacity in `forecastUtilizationBand` and drag the /what-if
    // horizon average down with a measurement that does not exist.
    const withRows = forecastOf([absence('alice', '2026-08-17', '2026-08-21')]);
    expect(withRows[0].supply).toBe(0);
    expect(withRows[0].utilizationPct).toBeNull();
    // Absence twin: the following week, which the interval does not reach, is whole.
    const twoWeeks = forecastOf([absence('alice', '2026-08-17', '2026-08-21')], [alice], 2);
    expect(twoWeeks[1].supply).toBe(40);
    expect(twoWeeks[1].utilizationPct).not.toBeNull();
  });

  it('leaves COMMITTED demand exactly where it was, so a booking clashing with leave stays visible', () => {
    // THE OPPOSITE DEFECT, and the worse one. The server deliberately ACCEPTS an
    // absence recorded over already-booked days and returns `bookedDayConflicts`
    // (spec §6.4) so the clash can be seen and resolved. If the absent days came
    // off the demand side too, the 40 booked hours would vanish from the horizon
    // that exists to surface them and `gap` would read a comfortable 0 for a week
    // in which nobody can work.
    const booked = {
      resources: [alice],
      requests: [req('r1', 40, 'Open', { staffedEffort: 40, startDate: WEEK_START, endDate: '2026-08-21' })],
      assignments: [assign('a1', 'r1', 'alice', 40, 'Allocated')],
      ...tail(monthRows('a1', [{ month: '2026-08', status: 'Allocated', hours: 40 }])),
    };
    const without = capacityForecast({ ...booked, absences: [] }, WEEK_START, 1);
    const withRows = capacityForecast(
      { ...booked, absences: [absence('alice', '2026-08-17', '2026-08-21')] },
      WEEK_START,
      1,
    );

    // Demand is IDENTICAL on both sides — the booked hours are a fact about the
    // world, not a function of who is available to honour them.
    expect(without[0].committed).toStrictEqual(40);
    expect(withRows[0].committed).toStrictEqual(40);
    expect(withRows[0].pipeline).toStrictEqual(without[0].pipeline);
    expect(withRows[0].demand).toStrictEqual(without[0].demand);

    // The supply is what moved, and the gap therefore goes as negative as the
    // bookings — the conflict, stated in the currency of the screen.
    expect(without[0].gap).toStrictEqual(0);
    expect(withRows[0].gap).toStrictEqual(-40);
    expect(withRows[0].utilizationPct).toBeNull();
    expect(without[0].utilizationPct).toBeCloseTo(100, 10);
  });

  it('takes only the absent person’s capacity, and nothing from an unrelated resourceId', () => {
    const both = [alice, bob];
    const without = forecastOf([], both);
    expect(without[0].supply).toBe(72);

    // Bob out all week: his 32 go, Alice's 40 stay whole. A fix that filtered the
    // whole interval list without matching on `resourceId` would report 0 here.
    const bobOut = forecastOf([absence('bob', '2026-08-17', '2026-08-21')], both);
    expect(bobOut[0].supply).toBe(40);

    // TWIN: an interval for somebody who is not in this forecast at all is inert.
    const stranger = forecastOf([absence('carol', '2026-08-17', '2026-08-21')], both);
    expect(stranger.map(r => r.supply)).toStrictEqual(without.map(r => r.supply));
  });

  it('pro-rates a MONTHLY period on the window’s own working days too', () => {
    // The 30-day rolling window 2026-08-03..2026-09-01 holds 22 working days (the
    // figure the day-granular suite above already pins). One week of leave inside
    // it removes five, leaving 17 — so the monthly horizon is not a second code
    // path that quietly kept the old answer.
    const WINDOW_WORKING_DAYS = 22;
    const base = { resources: [alice], requests: [], assignments: [], ...NO_ALLOCATION_ROWS };
    const without = capacityForecast({ ...base, absences: [] }, '2026-08-03', 1, 'monthly');
    const withRows = capacityForecast(
      { ...base, absences: [absence('alice', '2026-08-17', '2026-08-21')] },
      '2026-08-03',
      1,
      'monthly',
    );
    expect(without[0].supply).toBeCloseTo(40 * (52 / 12), 6);
    expect(withRows[0].supply).toBeCloseTo(40 * (52 / 12) * (17 / WINDOW_WORKING_DAYS), 10);
    expect(withRows[0].supply).not.toBeCloseTo(without[0].supply, 6);
  });

  it('never gives an absence the chance to add capacity a leaver no longer has', () => {
    // Composition, not competition: `availableWorkingDays` is handed the EMPLOYED
    // day list, so the two gates narrow in sequence. A leaver who went on Wed the
    // 19th has three employed days (17, 18, 19); an absence over the days AFTER she
    // left can only subtract days she never had, i.e. nothing.
    const leaver = res('leaver', 40, 0, [], 'internal', { terminationDate: '2026-08-19' });
    const EMPLOYED_DAYS = 3;
    const without = forecastOf([], [leaver]);
    const afterLeaving = forecastOf([absence('leaver', '2026-08-20', '2026-08-21')], [leaver]);
    const beforeLeaving = forecastOf([absence('leaver', '2026-08-18', '2026-08-18')], [leaver]);

    expect(without[0].supply).toBeCloseTo(40 * (EMPLOYED_DAYS / WORKING_DAYS_PER_WEEK), 10);
    expect(afterLeaving[0].supply).toBeCloseTo(without[0].supply, 10);
    // ...while an absence on a day she WAS employed for still costs that day, so
    // the composition is a narrowing and not an ignored argument.
    expect(beforeLeaving[0].supply).toBeCloseTo(40 * ((EMPLOYED_DAYS - 1) / WORKING_DAYS_PER_WEEK), 10);
  });

  it('does not let an absence move overAllocated — booked hours are booked (U16)', () => {
    // An EXPLICIT non-verdict, in the form the project's own lesson demands: for
    // every assertion of presence, the one of absence. Somebody 200h over capacity
    // who then takes a week off is still 200h over; shrinking her capacity here
    // would inflate the overrun into hours nobody booked, and the `capacity` scalar
    // is a whole-of-time profile value that H deliberately leaves alone (spec §11).
    const hot = res('hot', 100, 200, [], 'internal', { hireDate: '2020-01-01' });
    const data = {
      resources: [hot],
      requests: [req('r1', 300, 'Staffed', { staffedEffort: 300, startDate: WEEK_START, endDate: '2026-08-21' })],
      assignments: [assign('a1', 'r1', 'hot', 300, 'Allocated')],
      ...tail(monthRows('a1', [{ month: '2026-08', status: 'Allocated', hours: 300 }])),
    };
    const without = overAllocated({ ...data, absences: [] });
    const withRows = overAllocated({ ...data, absences: [absence('hot', '2026-08-17', '2026-08-21')] });
    expect(withRows).toStrictEqual(without);
    expect(withRows[0].overByHours).toStrictEqual(200);
  });
});

/**
 * H — the two /what-if tiles that disagreed about one person.
 *
 * `/what-if` puts "Bench" and "Avg Utilization" in the same row of tiles. Block H
 * fixed the first (a fully-absent month is `ABSENT`, and `notFullyAllocatedAt`
 * excludes it) and declared the second out of scope, so a person on leave was
 * simultaneously NOT on the bench and still counted as available capacity in the
 * utilisation denominator — two numbers, one row, one person, opposite claims.
 *
 * `what-if.ts` cannot be touched from here, so the disagreement is pinned where
 * both answers can be put in one assertion: this file calls `notFullyAllocatedAt`
 * (bench.util.ts, unmodified) and `capacityForecast` over ONE fixture and asserts
 * they now agree in BOTH directions — the absent person is out of both, and with no
 * absence rows she is in both. Agreement in one direction only would be satisfied by
 * a function that always returns 0.
 */
describe('forecast.util — H: the /what-if bench tile and the utilization tile agree', () => {
  const MONTH = '2026-08';
  const TODAY = '2026-08-17';
  const alice = res('alice', 40, 0, [], 'internal', { hireDate: '2020-01-01' });
  const bob = res('bob', 40, 0, [], 'internal', { hireDate: '2020-01-01' });

  /** The shape `what-if.ts`'s `toRollupInput` builds, from the same `ForecastData`. */
  function benchIds(data: ForecastData): string[] {
    return notFullyAllocatedAt(
      {
        resources: data.resources,
        assignments: data.assignments,
        assignmentDays: data.assignmentDays,
        assignmentMonths: data.assignmentMonths,
        hoursPerDay: data.hoursPerDay,
        holidays: new Set(data.holidays.map(h => h.id)),
        absences: data.absences ?? [],
      },
      MONTH,
      TODAY,
    ).map(r => r.resourceId);
  }

  function fixture(absences: RedactedAbsence[]): ForecastData {
    return { resources: [alice, bob], requests: [], assignments: [], ...NO_ALLOCATION_ROWS, absences };
  }

  it('excludes an absent person from the bench count AND from the utilization denominator', () => {
    const data = fixture([absence('alice', '2026-08-01', '2026-08-31')]);
    // The bench tile: Alice is ABSENT for the whole month, so she is not bench.
    expect(benchIds(data)).toStrictEqual(['bob']);
    // The utilization tile's denominator: only Bob's 40h. RED BEFORE THIS CHANGE —
    // it read 80, Alice's capacity included, which is the contradiction itself.
    expect(capacityForecast(data, TODAY, 1)[0].supply).toBe(40);
    expect(capacityForecast(data, TODAY, 1)[0].supply).not.toBe(80);
  });

  it('includes her in BOTH when there is no absence to exclude her for', () => {
    // The other direction, and the reason the pair is needed: a supply of 0 for
    // everybody would satisfy the assertion above and fail this one.
    const data = fixture([]);
    expect(benchIds(data)).toStrictEqual(['alice', 'bob']);
    expect(capacityForecast(data, TODAY, 1)[0].supply).toBe(80);
  });

  it('keeps a PARTLY absent person in both — one week off is not a month off', () => {
    // The threshold twin. `ABSENT` is assigned only for a FULLY absent month
    // (spec §4.3), so three days' leave leaves Alice on the bench list; the supply
    // side, which measures days rather than states, drops exactly her three days.
    const data = fixture([absence('alice', '2026-08-18', '2026-08-20')]);
    expect(benchIds(data)).toStrictEqual(['alice', 'bob']);
    expect(capacityForecast(data, TODAY, 1)[0].supply).toBeCloseTo(40 + 40 * (2 / 5), 10);
  });
});

/**
 * H — `skillGap` coverage, and the DIRECTION of the risk (spec §11).
 *
 * Two defects face each other and are not symmetric: declaring a shortage that does
 * not exist costs a hiring conversation, hiding a real one costs the signal this
 * table exists to raise and nothing else re-raises it. Narrowing `covering` can only
 * ever flip `shortage` false → true, never the reverse, so the rule cannot suppress
 * a shortage that exists today. The threshold — FULLY absent, never "any absent
 * day" — is what stops it overshooting in the other direction, and it is the same
 * threshold `BenchState = 'ABSENT'` already uses rather than a second one.
 */
describe('forecast.util — H: skillGap coverage counts only staffable holders', () => {
  const goDev = (id: string) =>
    res(id, 40, 0, [{ name: 'Go', level: 3 }], 'internal', { hireDate: '2020-01-01' });

  function gapFor(resources: Resource[], absences: RedactedAbsence[], month = '2026-08') {
    return skillGap(
      {
        resources,
        requests: [req('r1', 80, 'Open', { skills: ['Go'] })],
        assignments: [],
        ...NO_ALLOCATION_ROWS,
        absences,
      },
      month,
    )[0];
  }

  it('stops counting the ONLY holder of a skill when she is absent all month', () => {
    const without = gapFor([goDev('go1')], []);
    const withRows = gapFor([goDev('go1')], [absence('go1', '2026-08-01', '2026-08-31')]);

    expect(without.supplyCount).toStrictEqual(1);
    expect(without.shortage).toStrictEqual(false);
    // THE DIFFERENTIAL: the shortage appears, which is the signal a month with no
    // Go developer in it should raise.
    expect(withRows.supplyCount).toStrictEqual(0);
    expect(withRows.shortage).toStrictEqual(true);
  });

  it('still counts a holder who is away for three days of a month', () => {
    // THE DIRECTION-OF-RISK ASSERTION, written as an assertion because a
    // requirement left in prose never goes red. Excluding anyone with ANY absent
    // day would report a shortage here — a hire requisition raised because the Go
    // developer took Tuesday to Thursday off, when she can still be booked on the
    // month's other nineteen working days.
    const withRows = gapFor([goDev('go1')], [absence('go1', '2026-08-18', '2026-08-20')]);
    expect(withRows.supplyCount).toStrictEqual(1);
    expect(withRows.shortage).toStrictEqual(false);
  });

  it('measures the absence against WORKING days, not calendar days', () => {
    // The fixture in which the two wrong answers would otherwise coincide, made
    // sharp: hired Friday the 28th, so her only August working days are Fri 28 and
    // Mon 31 (29-30 are the weekend).
    const lateHire = res('go1', 40, 0, [{ name: 'Go', level: 3 }], 'internal', { hireDate: '2026-08-28' });
    // Both of her two days covered ⇒ fully absent ⇒ no coverage.
    expect(gapFor([lateHire], [absence('go1', '2026-08-28', '2026-08-31')]).supplyCount).toStrictEqual(0);
    // TWIN: an interval over the weekend in between covers neither of them, so she
    // is still coverage. A calendar-day implementation would call this "absent".
    expect(gapFor([lateHire], [absence('go1', '2026-08-29', '2026-08-30')]).supplyCount).toStrictEqual(1);
  });

  it('never turns an existing shortage into coverage, and never overshoots past one holder', () => {
    // Monotonicity, asserted rather than argued: `supplyCount` can only fall, so
    // `shortage` can only flip false → true. With two holders and one of them out
    // the count drops to 1 and the shortage badge stays quiet — the table must not
    // shout for a hire the org already has present.
    const two = [goDev('go1'), goDev('go2')];
    expect(gapFor(two, []).supplyCount).toStrictEqual(2);
    const oneOut = gapFor(two, [absence('go1', '2026-08-01', '2026-08-31')]);
    expect(oneOut.supplyCount).toStrictEqual(1);
    expect(oneOut.shortage).toStrictEqual(false);
    // ...and an interval belonging to nobody in the fixture changes nothing.
    expect(gapFor(two, [absence('nobody', '2026-08-01', '2026-08-31')])).toStrictEqual(gapFor(two, []));
  });

  it('does not carry an absence into a month it does not cover', () => {
    // The month-scoping twin: August off is not September off, and `asOfMonth` is
    // still the only thing that decides which days are looked at.
    const august = [absence('go1', '2026-08-01', '2026-08-31')];
    expect(gapFor([goDev('go1')], august, '2026-08').shortage).toStrictEqual(true);
    expect(gapFor([goDev('go1')], august, '2026-09').shortage).toStrictEqual(false);
  });
});

describe('forecast.util — scenario validation and KPI tone', () => {
  it('requires a complete, ordered demand window', () => {
    expect(isCompleteForecastWindow('', '')).toBe(false);
    expect(isCompleteForecastWindow('2026-08-04', '')).toBe(false);
    expect(isCompleteForecastWindow('', '2026-08-05')).toBe(false);
    expect(isCompleteForecastWindow('2026-08-06', '2026-08-05')).toBe(false);
    expect(isCompleteForecastWindow('2026-08-04', '2026-08-05')).toBe(true);
  });

  it('judges utilization changes by distance from the healthy band', () => {
    expect(utilizationChangeTone(95, 140)).toBe('bad');
    expect(utilizationChangeTone(120, 90)).toBe('good');
    expect(utilizationChangeTone(90, 95)).toBe('neutral');
  });
});

describe('forecast.util — forecastUtilizationBand', () => {
  it('does not call a below-healthy figure the same thing as a healthy one', () => {
    // The contradiction this closes: 45% was painted with the healthy green tone
    // on /forecast while /what-if scored the same move as bad.
    expect(forecastUtilizationBand(45)).not.toBe(forecastUtilizationBand(90));
    expect(forecastUtilizationBand(45)).toBe('spare');
    expect(forecastUtilizationBand(90)).toBe('healthy');
  });

  it('keeps the whole healthy band together and puts over-capacity outside it', () => {
    // 90 and 95 are both healthy: a ladder that split them (the old >=85/<=100
    // hand-rolled pair called 95 healthy and 100.1 over) would fail here.
    expect(forecastUtilizationBand(90)).toBe(forecastUtilizationBand(95));
    expect(forecastUtilizationBand(105)).toBe('healthy');
    expect(forecastUtilizationBand(120)).toBe('over');
    // Three distinct bands must survive: any collapse into two fails one of these.
    expect(new Set([forecastUtilizationBand(45), forecastUtilizationBand(90), forecastUtilizationBand(120)]).size).toBe(3);
  });

  it('answers "unknown" — never a tone — when there is no utilization to paint', () => {
    expect(forecastUtilizationBand(null)).toBe('unknown');
    expect(forecastUtilizationBand(Number.NaN)).toBe('unknown');
    // Absence: 'unknown' must not be any of the three real bands, or a
    // no-capacity period inherits a colour that asserts something.
    expect(['spare', 'healthy', 'over']).not.toContain(forecastUtilizationBand(null));
  });
});

describe('forecast.util — overAllocated', () => {
  it('lists resources at/above the default 110% threshold, most over first', () => {
    const data: ForecastData = {
      resources: [
        res('1', 40, 130), // over, 60 confirmed hours -> 20 over hours
        res('2', 40, 115), // over
        res('3', 40, 105), // under 110 -> excluded
      ],
      requests: [],
      assignments: [assign('a1', 'r1', '1', 60)],
      ...tail(monthRows('a1', [{ month: '2026-08', status: 'Allocated', hours: 60 }])),
    };
    const over = overAllocated(data);
    expect(over.map(o => o.resourceId)).toEqual(['1', '2']);
    expect(over.find(o => o.resourceId === '1')?.overByHours).toBe(20);
  });

  it('measures "Over by" from the confirmed months only, and does not zero it because another month is pending', () => {
    // Same all-or-nothing bug as committed demand: the assignment rolls up to
    // 'Requested', which used to erase its 100 APPROVED hours and report 0h over.
    const data: ForecastData = {
      resources: [res('1', 40, 150)],
      requests: [],
      assignments: [assign('a1', 'r1', '1', 180, 'Requested')],
      ...tail(
        monthRows('a1', [
          { month: '2026-08', status: 'Allocated', hours: 100 },
          { month: '2026-09', status: 'Requested', hours: 80 },
        ]),
      ),
    };
    const over = overAllocated(data);
    // 100 confirmed − 40 capacity = 60 over.
    expect(over[0].overByHours).toBe(60);
    // Absence, both directions: not the erased 0, and not the 140 the whole
    // assignment's 180h would give.
    expect(over[0].overByHours).not.toBe(0);
    expect(over[0].overByHours).not.toBe(140);
  });

  it('supports a 100% threshold band', () => {
    const data: ForecastData = {
      resources: [res('1', 40, 101), res('2', 40, 100), res('3', 40, 99)],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    expect(overAllocated(data, 100).map(o => o.resourceId)).toEqual(['1', '2']);
  });

  it('never lists a dummy even when over threshold, but keeps a matching subco', () => {
    const data: ForecastData = {
      resources: [
        res('1', 40, 150, [], 'dummy'), // would qualify by utilization alone
        res('2', 40, 150, [], 'subco'), // same shape, but IS deliverable capacity
      ],
      requests: [],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const over = overAllocated(data);
    expect(over.map(o => o.resourceId)).toEqual(['2']);
  });
});

describe('forecast.util — skillGap', () => {
  it('reports per-skill demand vs covering supply and flags shortages', () => {
    const data: ForecastData = {
      resources: [
        res('1', 40, 50, [{ name: 'Angular', level: 3 }]),
        res('2', 40, 50, [{ name: 'Angular', level: 2 }]),
      ],
      requests: [
        req('r1', 80, 'Open', { skills: ['Angular', 'Kubernetes'] }),
        req('r2', 40, 'Open', { skills: ['Kubernetes'] }),
      ],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const gaps = skillGap(data, AS_OF);

    const k8s = gaps.find(g => g.skill === 'Kubernetes');
    expect(k8s).toBeDefined();
    expect(k8s?.demandCount).toBe(2);
    expect(k8s?.demandHours).toBe(120); // 80 + 40
    expect(k8s?.supplyCount).toBe(0);
    expect(k8s?.shortage).toBe(true);

    const ng = gaps.find(g => g.skill === 'Angular');
    expect(ng?.demandCount).toBe(1);
    expect(ng?.demandHours).toBe(80);
    expect(ng?.supplyCount).toBe(2);
    expect(ng?.shortage).toBe(false);

    // Shortages sort ahead of covered skills.
    expect(gaps[0].skill).toBe('Kubernetes');
  });

  it('matches skills case-insensitively between supply and demand', () => {
    const data: ForecastData = {
      resources: [res('1', 40, 50, [{ name: 'angular', level: 3 }])],
      requests: [req('r1', 10, 'Open', { skills: ['Angular'] })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const gaps = skillGap(data, AS_OF);
    expect(gaps.length).toBe(1);
    expect(gaps[0].supplyCount).toBe(1);
    expect(gaps[0].shortage).toBe(false);
  });

  it('uses only unstaffed effort for skill demand hours', () => {
    const data: ForecastData = {
      resources: [],
      requests: [req('r1', 100, 'Open', { staffedEffort: 70, skills: ['Go'] })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    const gaps = skillGap(data, AS_OF);
    expect(gaps[0].demandHours).toBe(30); // 100 - 70
    expect(gaps[0].shortage).toBe(true);
  });

  it('ignores closed / fully-staffed requests', () => {
    const data: ForecastData = {
      resources: [],
      requests: [
        req('r1', 40, 'Fulfilled', { skills: ['Rust'] }),
        req('r2', 40, 'Open', { staffedEffort: 40, skills: ['Rust'] }),
      ],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };
    expect(skillGap(data, AS_OF)).toEqual([]);
  });

  it('returns an empty list when there is no open demand', () => {
    const data: ForecastData = { resources: [res('1', 40, 50)], requests: [], assignments: [], ...NO_ALLOCATION_ROWS };
    expect(skillGap(data, AS_OF)).toEqual([]);
  });

  it('does not treat dummy skills as deliverable coverage', () => {
    const data: ForecastData = {
      resources: [
        res('dummy', 40, 0, [{ name: 'Kubernetes', level: 3 }], 'dummy'),
        res('subco', 40, 0, [{ name: 'Angular', level: 3 }], 'subco'),
      ],
      requests: [req('r1', 40, 'Open', { skills: ['Kubernetes', 'Angular'] })],
      assignments: [],
      ...NO_ALLOCATION_ROWS,
    };

    expect(skillGap(data, AS_OF).find(gap => gap.skill === 'Kubernetes')).toMatchObject({
      supplyCount: 0,
      shortage: true,
    });
    expect(skillGap(data, AS_OF).find(gap => gap.skill === 'Angular')).toMatchObject({
      supplyCount: 1,
      shortage: false,
    });
  });
});
