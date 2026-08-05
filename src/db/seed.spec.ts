import { describe, it, expect } from 'vitest';
import { requests, assignments, assignmentDays, assignmentMonths, costBaselines } from './seed';

describe('cost-baseline seed fixture (design spec, block E)', () => {
  it('adds request \'7\' staffing project \'1\' for the Consultant role', () => {
    const r = requests.find(x => x.id === '7');
    expect(r).toBeDefined();
    expect(r?.projectId).toBe('1');
    expect(r?.requiredRole).toBe('Consultant');
  });

  it('books assignment \'7\' for resource \'2\' (John Miller) on 2026-10-05 only', () => {
    const a = assignments.find(x => x.id === '7');
    expect(a).toBeDefined();
    expect(a?.resourceId).toBe('2');
    expect(a?.requestId).toBe('7');
    expect(a?.startDate).toBe('2026-10-05');
    expect(a?.endDate).toBe('2026-10-05');
    expect(a?.assignedHours).toBe(8);
  });

  it('derives an Allocated 2026-10 month row for assignment \'7\' with 8 booked hours on 2026-10-05', () => {
    const days = assignmentDays.filter(d => d.assignmentId === '7');
    expect(days.map(d => d.date)).toEqual(['2026-10-05']);
    expect(days.map(d => d.hours)).toEqual([8]);
    const m = assignmentMonths.find(x => x.id === '7:2026-10');
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
    // Project '1's only assignments are '1', '2' and '7' (requests '1'/'3'/'7' all
    // carry projectId '1'); none has a day in November.
    expect(assignmentDays.some(d => d.date.startsWith('2026-11') && ['1', '2', '7'].includes(d.assignmentId))).toBe(false);
  });
});
