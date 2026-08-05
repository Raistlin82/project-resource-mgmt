import {
  capacityForecast,
  overAllocated,
  skillGap,
  isCompleteForecastWindow,
  utilizationChangeTone,
  ForecastData,
} from './forecast.util';
import { Resource, ResourceRequest, Assignment } from './api.service';
import { ResourceKind } from './resource-kind.util';

/** `ForecastData`'s tail fields that `capacityForecast`/`overAllocated`/`skillGap`
 * never read (they're `notFullyAllocatedAt`'s concern, exercised in `bench.util.spec.ts`)
 * — spread into every fixture below just to satisfy the shared interface. */
const EMPTY_TAIL = { assignmentDays: [], assignmentMonths: [], holidays: [], hoursPerDay: 8 };

function res(
  id: string,
  capacity: number,
  utilization: number,
  skills: { name: string; level: number }[] = [],
  kind?: ResourceKind,
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

describe('forecast.util — capacityForecast', () => {
  it('builds N weekly periods with 7-day-spaced ISO labels', () => {
    const data: ForecastData = { resources: [res('1', 40, 50)], requests: [], assignments: [], ...EMPTY_TAIL };
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
      ...EMPTY_TAIL,
    };
    const rows = capacityForecast(data, '2026-06-08', 2);
    expect(rows.every(r => r.supply === 72)).toBe(true);
  });

  it('spreads committed assignment hours across the linked request window', () => {
    // Request spans exactly two periods (14 days); 80 booked hours split evenly = 40 each.
    const data: ForecastData = {
      resources: [res('1', 40, 0)],
      requests: [req('r1', 0, 'Open', { startDate: '2026-06-08', endDate: '2026-06-22' })],
      assignments: [assign('a1', 'r1', '1', 80)],
      ...EMPTY_TAIL,
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
      ...EMPTY_TAIL,
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
      ...EMPTY_TAIL,
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
      ...EMPTY_TAIL,
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
      ...EMPTY_TAIL,
    };
    const rows = capacityForecast(data, '2026-06-08', 1);
    expect(rows[0].committed).toBe(30);
    expect(rows[0].pipeline).toBe(10);
    expect(rows[0].demand).toBe(40);
    expect(rows[0].utilizationPct).toBe(100);
    expect(rows[0].gap).toBe(0);
  });

  it('guards against zero capacity (no division by zero)', () => {
    const data: ForecastData = {
      resources: [res('1', 0, 0)], // zero capacity -> zero supply
      requests: [req('p1', 50, 'Open', { startDate: '2026-06-08', endDate: '2026-06-08' })],
      assignments: [],
      ...EMPTY_TAIL,
    };
    const rows = capacityForecast(data, '2026-06-08', 1);
    expect(rows[0].supply).toBe(0);
    expect(rows[0].demand).toBe(50);
    expect(rows[0].utilizationPct).toBe(0); // guarded, not Infinity/NaN
    expect(rows[0].gap).toBe(-50);
  });

  it('returns an empty horizon for non-positive periods or an unparseable start', () => {
    const data: ForecastData = { resources: [res('1', 40, 0)], requests: [], assignments: [], ...EMPTY_TAIL };
    expect(capacityForecast(data, '2026-06-08', 0)).toEqual([]);
    expect(capacityForecast(data, '2026-06-08', -3)).toEqual([]);
    expect(capacityForecast(data, 'not-a-date', 4)).toEqual([]);
  });

  it('scales weekly supply to a monthly period unit', () => {
    const data: ForecastData = { resources: [res('1', 40, 0)], requests: [], assignments: [], ...EMPTY_TAIL };
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
      ...EMPTY_TAIL,
    };
    const rows = capacityForecast(data, '2026-06-08', 1);
    // internal (10) + subco (40) = 50; the dummy's 20 must NOT be counted.
    expect(rows[0].supply).toBe(50);
  });

  it('counts only approved allocations as committed demand', () => {
    const data: ForecastData = {
      resources: [res('1', 40, 0)],
      requests: [req('r1', 0, 'Open')],
      assignments: [
        assign('allocated', 'r1', '1', 20, 'Allocated'),
        assign('draft', 'r1', '1', 30, 'Draft'),
        assign('requested', 'r1', '1', 40, 'Requested'),
        assign('rejected', 'r1', '1', 50, 'Rejected'),
      ],
      ...EMPTY_TAIL,
    };

    expect(capacityForecast(data, '2026-06-08', 1)[0].committed).toBe(20);
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

describe('forecast.util — overAllocated', () => {
  it('lists resources at/above the default 110% threshold, most over first', () => {
    const data: ForecastData = {
      resources: [
        res('1', 40, 130), // over, booked 60 -> 20 over hours
        res('2', 40, 115), // over
        res('3', 40, 105), // under 110 -> excluded
      ],
      requests: [],
      assignments: [assign('a1', 'r1', '1', 60)],
      ...EMPTY_TAIL,
    };
    const over = overAllocated(data);
    expect(over.map(o => o.resourceId)).toEqual(['1', '2']);
    expect(over.find(o => o.resourceId === '1')?.overByHours).toBe(20);
  });

  it('supports a 100% threshold band', () => {
    const data: ForecastData = {
      resources: [res('1', 40, 101), res('2', 40, 100), res('3', 40, 99)],
      requests: [],
      assignments: [],
      ...EMPTY_TAIL,
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
      ...EMPTY_TAIL,
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
      ...EMPTY_TAIL,
    };
    const gaps = skillGap(data);

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
      ...EMPTY_TAIL,
    };
    const gaps = skillGap(data);
    expect(gaps.length).toBe(1);
    expect(gaps[0].supplyCount).toBe(1);
    expect(gaps[0].shortage).toBe(false);
  });

  it('uses only unstaffed effort for skill demand hours', () => {
    const data: ForecastData = {
      resources: [],
      requests: [req('r1', 100, 'Open', { staffedEffort: 70, skills: ['Go'] })],
      assignments: [],
      ...EMPTY_TAIL,
    };
    const gaps = skillGap(data);
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
      ...EMPTY_TAIL,
    };
    expect(skillGap(data)).toEqual([]);
  });

  it('returns an empty list when there is no open demand', () => {
    const data: ForecastData = { resources: [res('1', 40, 50)], requests: [], assignments: [], ...EMPTY_TAIL };
    expect(skillGap(data)).toEqual([]);
  });

  it('does not treat dummy skills as deliverable coverage', () => {
    const data: ForecastData = {
      resources: [
        res('dummy', 40, 0, [{ name: 'Kubernetes', level: 3 }], 'dummy'),
        res('subco', 40, 0, [{ name: 'Angular', level: 3 }], 'subco'),
      ],
      requests: [req('r1', 40, 'Open', { skills: ['Kubernetes', 'Angular'] })],
      assignments: [],
      ...EMPTY_TAIL,
    };

    expect(skillGap(data).find(gap => gap.skill === 'Kubernetes')).toMatchObject({
      supplyCount: 0,
      shortage: true,
    });
    expect(skillGap(data).find(gap => gap.skill === 'Angular')).toMatchObject({
      supplyCount: 1,
      shortage: false,
    });
  });
});
