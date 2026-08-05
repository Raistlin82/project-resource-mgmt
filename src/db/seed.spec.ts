import { describe, it, expect } from 'vitest';
import { requests, assignments, assignmentDays, assignmentMonths, costBaselines } from './seed';

describe('cost-baseline seed fixture (design spec, block E)', () => {
  it('adds request \'12\' staffing project \'1\' for the Consultant role', () => {
    const r = requests.find(x => x.id === '12');
    expect(r).toBeDefined();
    expect(r?.projectId).toBe('1');
    expect(r?.requiredRole).toBe('Consultant');
  });

  it('books assignment \'12\' for resource \'2\' (John Miller) on 2026-10-05 only', () => {
    const a = assignments.find(x => x.id === '12');
    expect(a).toBeDefined();
    expect(a?.resourceId).toBe('2');
    expect(a?.requestId).toBe('12');
    expect(a?.startDate).toBe('2026-10-05');
    expect(a?.endDate).toBe('2026-10-05');
    expect(a?.assignedHours).toBe(8);
  });

  it('derives an Allocated 2026-10 month row for assignment \'12\' with 8 booked hours on 2026-10-05', () => {
    const days = assignmentDays.filter(d => d.assignmentId === '12');
    expect(days.map(d => d.date)).toEqual(['2026-10-05']);
    expect(days.map(d => d.hours)).toEqual([8]);
    const m = assignmentMonths.find(x => x.id === '12:2026-10');
    expect(m?.status).toBe('Allocated');
  });

  it('freezes CB1 at 600 EUR for project \'1\' period 2026-10 (live plan will be 720 -> +120 / +20.00%)', () => {
    expect(costBaselines.find(c => c.id === 'CB1')).toEqual({
      id: 'CB1', projectId: '1', period: '2026-10', amount: 600,
      frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4',
    });
  });

  it('freezes CB2 at 500 EUR for project \'1\' period 2026-11, a month project \'1\' has no booked hours in (live plan will be 0 -> -500 / null)', () => {
    expect(costBaselines.find(c => c.id === 'CB2')).toEqual({
      id: 'CB2', projectId: '1', period: '2026-11', amount: 500,
      frozenAt: '2026-09-15T09:00:00.000Z', frozenBy: '4',
    });
    // DERIVED, not hardcoded: every assignment whose request carries
    // projectId '1' (currently '1', '2', '7'-'11', '12' — the list keeps
    // growing block over block, which is exactly why it must not be
    // hand-copied here again). None of them has a booked day in November.
    const projectOneRequestIds = new Set(requests.filter(r => r.projectId === '1').map(r => r.id));
    const projectOneAssignmentIds = assignments
      .filter(a => projectOneRequestIds.has(a.requestId))
      .map(a => a.id);
    expect(projectOneAssignmentIds.length).toBeGreaterThan(0); // sanity: the derivation actually found rows
    expect(assignmentDays.some(d => d.date.startsWith('2026-11') && projectOneAssignmentIds.includes(d.assignmentId))).toBe(false);
  });
});
