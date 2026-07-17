import {
  capacityForecast,
  benchList,
  overAllocated,
  skillGap,
  ForecastData,
} from './forecast.util';
import { Resource, ResourceRequest, Assignment } from './api.service';

function res(
  id: string,
  capacity: number,
  utilization: number,
  skills: { name: string; level: number }[] = [],
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

function assign(id: string, requestId: string, resourceId: string, hours: number): Assignment {
  // TODO(alloc-approval): 'hard-booked' predates the typed Assignment.status
  // union added in the allocation-approval-workflow feature; cast is type-only
  // (no runtime/behavioral change) — these fixtures don't assert on status value.
  return { id, requestId, resourceId, assignedHours: hours, status: 'hard-booked' as Assignment['status'] };
}

describe('forecast.util — capacityForecast', () => {
  it('builds N weekly periods with 7-day-spaced ISO labels', () => {
    const data: ForecastData = { resources: [res('1', 40, 50)], requests: [], assignments: [] };
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
    };
    const rows = capacityForecast(data, '2026-06-08', 1);
    expect(rows[0].supply).toBe(0);
    expect(rows[0].demand).toBe(50);
    expect(rows[0].utilizationPct).toBe(0); // guarded, not Infinity/NaN
    expect(rows[0].gap).toBe(-50);
  });

  it('returns an empty horizon for non-positive periods or an unparseable start', () => {
    const data: ForecastData = { resources: [res('1', 40, 0)], requests: [], assignments: [] };
    expect(capacityForecast(data, '2026-06-08', 0)).toEqual([]);
    expect(capacityForecast(data, '2026-06-08', -3)).toEqual([]);
    expect(capacityForecast(data, 'not-a-date', 4)).toEqual([]);
  });

  it('scales weekly supply to a monthly period unit', () => {
    const data: ForecastData = { resources: [res('1', 40, 0)], requests: [], assignments: [] };
    const rows = capacityForecast(data, '2026-06-08', 1, 'monthly');
    expect(rows[0].supply).toBeCloseTo(40 * (52 / 12), 6);
  });
});

describe('forecast.util — benchList', () => {
  it('lists under-allocated resources with spare hours, most available first', () => {
    const data: ForecastData = {
      resources: [
        res('1', 40, 50), // under 80% -> bench, booked 10 -> 30 spare
        res('2', 40, 60), // under 80% -> bench, booked 0 -> 40 spare
        res('3', 40, 95), // not under threshold
      ],
      requests: [],
      assignments: [assign('a1', 'r1', '1', 10)],
    };
    const bench = benchList(data);
    expect(bench.map(b => b.resourceId)).toEqual(['2', '1']); // 40 spare before 30 spare
    expect(bench.find(b => b.resourceId === '1')?.availableHours).toBe(30);
    expect(bench.find(b => b.resourceId === '2')?.availableHours).toBe(40);
  });

  it('excludes zero-capacity resources from the bench', () => {
    const data: ForecastData = {
      resources: [res('1', 0, 0)], // 0% util but no real capacity
      requests: [],
      assignments: [],
    };
    expect(benchList(data)).toEqual([]);
  });

  it('honors a custom threshold', () => {
    const data: ForecastData = { resources: [res('1', 40, 65)], requests: [], assignments: [] };
    expect(benchList(data, 60).length).toBe(0); // 65 not below 60
    expect(benchList(data, 70).length).toBe(1); // 65 below 70
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
    };
    expect(overAllocated(data, 100).map(o => o.resourceId)).toEqual(['1', '2']);
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
    };
    expect(skillGap(data)).toEqual([]);
  });

  it('returns an empty list when there is no open demand', () => {
    const data: ForecastData = { resources: [res('1', 40, 50)], requests: [], assignments: [] };
    expect(skillGap(data)).toEqual([]);
  });
});
