import { buildSchedule, weeksBetween, ScheduleModel } from './schedule.util';
import type { Resource, ResourceRequest, Assignment } from './api.service';

// --- Fixed-date fixtures (no Date.now / no clock dependence) ---

function resource(id: string, overrides: Partial<Resource> = {}): Resource {
  return {
    id,
    name: `Res ${id}`,
    role: 'Developer',
    skills: [],
    projectRoles: [],
    externalExperience: [],
    utilization: 0,
    capacity: 40,
    ...overrides,
  };
}

function request(id: string, overrides: Partial<ResourceRequest> = {}): ResourceRequest {
  return {
    id,
    name: `Request ${id}`,
    requiredRole: 'Developer',
    requiredEffort: 100,
    status: 'Open',
    skills: [],
    ...overrides,
  };
}

function assignment(id: string, overrides: Partial<Assignment> = {}): Assignment {
  return {
    id,
    requestId: 'REQ1',
    resourceId: 'R1',
    assignedHours: 40,
    status: 'Allocated',
    ...overrides,
  };
}

/** Pull a single lane out of the model by resource id. */
function laneOf(model: ScheduleModel, resourceId: string) {
  return model.lanes.find((l) => l.resourceId === resourceId)!;
}

describe('schedule.util weeksBetween', () => {
  it('counts inclusive whole week-columns a window touches', () => {
    expect(weeksBetween('2026-01-01', '2026-01-07')).toBe(1); // 6 days -> 1 week
    expect(weeksBetween('2026-01-01', '2026-01-08')).toBe(1); // exactly 7 days -> 1 week
    expect(weeksBetween('2026-01-01', '2026-01-09')).toBe(2); // 8 days -> 2 weeks
    expect(weeksBetween('2026-01-01', '2026-01-29')).toBe(4); // 28 days -> 4 weeks
  });

  it('returns at least 1 for a same-day (zero-length) window', () => {
    expect(weeksBetween('2026-01-01', '2026-01-01')).toBe(1);
  });

  it('returns 0 for missing or inverted windows', () => {
    expect(weeksBetween(undefined, '2026-01-07')).toBe(0);
    expect(weeksBetween('2026-01-07', undefined)).toBe(0);
    expect(weeksBetween('not-a-date', '2026-01-07')).toBe(0);
    expect(weeksBetween('2026-02-01', '2026-01-01')).toBe(0); // inverted
  });
});

describe('schedule.util buildSchedule — conflict detection', () => {
  it('flags both bookings when two overlapping allocations sum to >100 and records peakPct', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A', { name: 'Alpha' }), request('REQ_B', { name: 'Beta' })];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', resourceId: 'R1', startDate: '2026-01-01', endDate: '2026-01-31', allocationPct: 60 }),
      assignment('A2', { requestId: 'REQ_B', resourceId: 'R1', startDate: '2026-01-10', endDate: '2026-02-10', allocationPct: 60 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    // Both bookings overlap [Jan 10, Jan 31) at 120% -> both conflict.
    expect(lane.bookings.every((b) => b.conflict)).toBe(true);
    expect(lane.hasConflict).toBe(true);
    expect(lane.peakAllocationPct).toBe(120);

    expect(model.conflicts).toHaveLength(1);
    const c = model.conflicts[0];
    expect(c.resourceId).toBe('R1');
    expect(c.peakPct).toBe(120);
    expect(c.windowStart).toBe('2026-01-10');
    // A1's last booked day is 31 Jan, so the over-allocation runs THROUGH the
    // 31st and windowEnd (exclusive) is 1 Feb. It read '2026-01-31' while the
    // inclusive end was treated as an exclusive instant — i.e. the 31st was
    // silently excluded from the conflict.
    expect(c.windowEnd).toBe('2026-02-01');
    expect(c.bookingIds.sort()).toEqual(['A1', 'A2']);
  });

  it('does NOT flag two non-overlapping bookings even when each is 100%', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-31', allocationPct: 100 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-02-01', endDate: '2026-02-28', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    expect(lane.bookings.some((b) => b.conflict)).toBe(false);
    expect(lane.hasConflict).toBe(false);
    expect(lane.peakAllocationPct).toBe(100);
    expect(model.conflicts).toHaveLength(0);
  });

  // REWRITTEN (was "treats adjacent intervals (end === next start) as
  // NON-overlapping", asserting hasConflict false / peak 100). endDate is an
  // INCLUSIVE calendar day: a booking ending 15 Jan and one starting 15 Jan are
  // BOTH worked on the 15th, so they are double-booked, not adjacent. The old
  // expectation was the defect's own certificate.
  it('flags a TOUCHING pair (one ends on the day the next starts) — both are booked that day', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-15', allocationPct: 100 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-01-15', endDate: '2026-01-31', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    expect(lane.hasConflict).toBe(true);
    expect(lane.peakAllocationPct).toBe(200);
    expect(model.conflicts).toHaveLength(1);
    // The one shared day, and nothing more: 15 Jan inclusive → 16 Jan exclusive.
    expect(model.conflicts[0].windowStart).toBe('2026-01-15');
    expect(model.conflicts[0].windowEnd).toBe('2026-01-16');
  });

  it('does NOT flag a GENUINELY adjacent pair (one ends the day before the next starts)', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B')];
    const assignments = [
      // A1's last booked day is the 14th; A2's first is the 15th. No shared day.
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-14', allocationPct: 100 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-01-15', endDate: '2026-01-31', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    expect(lane.hasConflict).toBe(false);
    expect(lane.peakAllocationPct).toBe(100);
    expect(model.conflicts).toHaveLength(0);
  });

  it('flags a three-way overlap and reports the combined peak', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B'), request('REQ_C')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-31', allocationPct: 50 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-01-05', endDate: '2026-01-25', allocationPct: 50 }),
      assignment('A3', { requestId: 'REQ_C', startDate: '2026-01-10', endDate: '2026-01-20', allocationPct: 50 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    // [Jan 10, Jan 20) all three active -> 150%.
    expect(lane.peakAllocationPct).toBe(150);
    expect(lane.bookings.every((b) => b.conflict)).toBe(true);
    expect(model.conflicts).toHaveLength(1);
    const c = model.conflicts[0];
    expect(c.peakPct).toBe(150);
    expect(c.bookingIds.sort()).toEqual(['A1', 'A2', 'A3']);
  });

  it('flags only the bookings active during the over-allocated window in a partial three-way mix', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B'), request('REQ_C')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-10', allocationPct: 60 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-01-05', endDate: '2026-01-15', allocationPct: 60 }), // overlaps A1
      assignment('A3', { requestId: 'REQ_C', startDate: '2026-02-01', endDate: '2026-02-10', allocationPct: 100 }), // isolated
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    const byId = new Map(lane.bookings.map((b) => [b.assignmentId, b]));
    expect(byId.get('A1')!.conflict).toBe(true);
    expect(byId.get('A2')!.conflict).toBe(true);
    expect(byId.get('A3')!.conflict).toBe(false);
    expect(lane.peakAllocationPct).toBe(120);

    expect(model.conflicts).toHaveLength(1);
    expect(model.conflicts[0].bookingIds.sort()).toEqual(['A1', 'A2']);
  });

  it('does not flag overlapping bookings that sum to exactly 100% (boundary is non-strict)', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-31', allocationPct: 50 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-01-05', endDate: '2026-01-20', allocationPct: 50 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    expect(lane.hasConflict).toBe(false);
    expect(lane.peakAllocationPct).toBe(100);
    expect(model.conflicts).toHaveLength(0);
  });
});

describe('schedule.util buildSchedule — allocation & window fallbacks', () => {
  it('defaults a missing allocationPct to 100', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-31' }), // no allocationPct
    ];

    const model = buildSchedule(resources, assignments, requests);
    expect(laneOf(model, 'R1').bookings[0].allocationPct).toBe(100);
  });

  it('treats two unallocated overlapping bookings (each defaulting to 100) as a 200% conflict', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-31' }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-01-10', endDate: '2026-02-10' }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    expect(laneOf(model, 'R1').peakAllocationPct).toBe(200);
    expect(model.conflicts).toHaveLength(1);
  });

  it('falls back to the linked request dates when the assignment has no own dates', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A', { startDate: '2026-03-01', endDate: '2026-03-31' })];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', allocationPct: 80 }), // no startDate/endDate
    ];

    const model = buildSchedule(resources, assignments, requests);
    const booking = laneOf(model, 'R1').bookings[0];
    expect(booking.startDate).toBe('2026-03-01');
    expect(booking.endDate).toBe('2026-03-31');
    expect(booking.allocationPct).toBe(80);
  });

  it('prefers the assignment own dates over the request dates when both present', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A', { startDate: '2026-03-01', endDate: '2026-03-31' })];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-04-01', endDate: '2026-04-30' }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const booking = laneOf(model, 'R1').bookings[0];
    expect(booking.startDate).toBe('2026-04-01');
    expect(booking.endDate).toBe('2026-04-30');
  });

  it('uses the request label as the booking label, falling back to the request id', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A', { name: 'Migration project' })];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-01', endDate: '2026-01-31' }),
      assignment('A2', { requestId: 'REQ_MISSING', startDate: '2026-01-01', endDate: '2026-01-31' }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const byId = new Map(laneOf(model, 'R1').bookings.map((b) => [b.assignmentId, b]));
    expect(byId.get('A1')!.label).toBe('Migration project');
    // No linked request -> falls back to the request id.
    expect(byId.get('A2')!.label).toBe('REQ_MISSING');
  });

  it('skips assignments with no resolvable window (no own dates and no/invalid request dates)', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A')]; // request has no dates either
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', allocationPct: 100 }),
      assignment('A2', { requestId: 'REQ_GONE', startDate: 'nonsense', endDate: 'also-bad' }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    expect(laneOf(model, 'R1').bookings).toHaveLength(0);
    expect(model.conflicts).toHaveLength(0);
  });

  it('skips an assignment with an inverted window (end before start)', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-02-01', endDate: '2026-01-01', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    expect(laneOf(model, 'R1').bookings).toHaveLength(0);
  });
});

describe('schedule.util buildSchedule — same-day edge & lane grouping', () => {
  // REWRITTEN (was "keeps a same-day booking but never treats it as overlapping
  // a touching window", asserting hasConflict false). A same-day booking occupies
  // a whole day of the resource; when another booking covers that same day the
  // resource is double-booked. The old expectation certified the miss.
  it('flags a same-day booking that lands inside another booking window', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B')];
    const assignments = [
      // A1 is a single day, 15 Jan. A2 covers 15–31 Jan, so both hold the 15th.
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-15', endDate: '2026-01-15', allocationPct: 100 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-01-15', endDate: '2026-01-31', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    expect(lane.bookings).toHaveLength(2);
    expect(lane.hasConflict).toBe(true);
    expect(lane.peakAllocationPct).toBe(200);
    expect(model.conflicts).toHaveLength(1);
    // The bar still stops on the 15th: the +1 day the sweep needs stays internal.
    expect(lane.bookings.find((b) => b.assignmentId === 'A1')!.endDate).toBe('2026-01-15');
  });

  it('measures a lone same-day booking at its real allocation instead of 0%', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-01-15', endDate: '2026-01-15', allocationPct: 60 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    // A zero-length window produced a single sweep boundary, so the interval loop
    // body never ran and the lane reported peak 0% no matter how much was booked.
    expect(lane.peakAllocationPct).toBe(60);
    // ...and 60% alone is not a conflict — the fix must not be "flag everything".
    expect(lane.hasConflict).toBe(false);
    expect(model.conflicts).toHaveLength(0);
  });

  it('flags two same-day bookings on the same day at 200%', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A'), request('REQ_B')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-09-30', endDate: '2026-09-30', allocationPct: 100 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-09-30', endDate: '2026-09-30', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    expect(lane.peakAllocationPct).toBe(200);
    expect(lane.hasConflict).toBe(true);
    expect(model.conflicts).toHaveLength(1);
    expect(model.conflicts[0].windowStart).toBe('2026-09-30');
    expect(model.conflicts[0].bookingIds.sort()).toEqual(['A1', 'A2']);
  });

  it('flags the month-boundary handover the substitution flow writes (Sep 30 booked twice)', () => {
    const resources = [resource('R1')];
    const requests = [request('REQ_A', { name: 'Alpha' }), request('REQ_B', { name: 'Beta' })];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', startDate: '2026-09-01', endDate: '2026-09-30', allocationPct: 100 }),
      assignment('A2', { requestId: 'REQ_B', startDate: '2026-09-30', endDate: '2026-10-30', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    const lane = laneOf(model, 'R1');

    expect(lane.hasConflict).toBe(true);
    expect(lane.peakAllocationPct).toBe(200);
    expect(model.conflicts).toHaveLength(1);
    expect(model.conflicts[0].windowStart).toBe('2026-09-30');
    expect(model.conflicts[0].windowEnd).toBe('2026-10-01');
    // Both bars keep the dates that were booked.
    const byId = new Map(lane.bookings.map((b) => [b.assignmentId, b]));
    expect(byId.get('A1')!.endDate).toBe('2026-09-30');
    expect(byId.get('A2')!.startDate).toBe('2026-09-30');
    expect(byId.get('A2')!.endDate).toBe('2026-10-30');
  });

  it('groups bookings per resource and orders each lane by resolved start then end', () => {
    const resources = [resource('R1'), resource('R2')];
    const requests = [request('REQ_A'), request('REQ_B'), request('REQ_C')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', resourceId: 'R1', startDate: '2026-02-01', endDate: '2026-02-28', allocationPct: 50 }),
      assignment('A2', { requestId: 'REQ_B', resourceId: 'R1', startDate: '2026-01-01', endDate: '2026-01-31', allocationPct: 50 }),
      assignment('A3', { requestId: 'REQ_C', resourceId: 'R2', startDate: '2026-01-10', endDate: '2026-01-20', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);

    const r1 = laneOf(model, 'R1');
    expect(r1.bookings.map((b) => b.assignmentId)).toEqual(['A2', 'A1']); // ordered by start
    const r2 = laneOf(model, 'R2');
    expect(r2.bookings.map((b) => b.assignmentId)).toEqual(['A3']);
  });

  it('emits an empty lane (in roster order) for a resource with no bookings', () => {
    const resources = [resource('R1'), resource('R2')];
    const requests = [request('REQ_A')];
    const assignments = [
      assignment('A1', { requestId: 'REQ_A', resourceId: 'R1', startDate: '2026-01-01', endDate: '2026-01-31' }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    expect(model.lanes.map((l) => l.resourceId)).toEqual(['R1', 'R2']);
    const r2 = laneOf(model, 'R2');
    expect(r2.bookings).toHaveLength(0);
    expect(r2.hasConflict).toBe(false);
    expect(r2.peakAllocationPct).toBe(0);
  });

  it('carries resource name, role and capacity onto the lane for the view', () => {
    const resources = [resource('R1', { name: 'Ada Lovelace', role: 'Architect', capacity: 32 })];
    const model = buildSchedule(resources, [], []);
    const lane = laneOf(model, 'R1');
    expect(lane.resourceName).toBe('Ada Lovelace');
    expect(lane.role).toBe('Architect');
    expect(lane.capacity).toBe(32);
  });

  it('isolates conflicts per resource (one resource over-allocated does not flag another)', () => {
    const resources = [resource('R1'), resource('R2')];
    const requests = [request('REQ_A'), request('REQ_B'), request('REQ_C')];
    const assignments = [
      // R1 over-allocated.
      assignment('A1', { requestId: 'REQ_A', resourceId: 'R1', startDate: '2026-01-01', endDate: '2026-01-31', allocationPct: 80 }),
      assignment('A2', { requestId: 'REQ_B', resourceId: 'R1', startDate: '2026-01-10', endDate: '2026-01-20', allocationPct: 80 }),
      // R2 fine.
      assignment('A3', { requestId: 'REQ_C', resourceId: 'R2', startDate: '2026-01-01', endDate: '2026-01-31', allocationPct: 100 }),
    ];

    const model = buildSchedule(resources, assignments, requests);
    expect(laneOf(model, 'R1').hasConflict).toBe(true);
    expect(laneOf(model, 'R2').hasConflict).toBe(false);
    expect(model.conflicts).toHaveLength(1);
    expect(model.conflicts[0].resourceId).toBe('R1');
  });
});

// C2 — the six-month phantom conflict. An assignment created by a dummy
// substitution used to be written with neither a window nor an allocationPct, so
// `resolveWindow` fell back to the REQUEST's dates and `allocationPct` defaulted to
// 100: a few hours transferred into ONE month rendered as a full-time booking across
// the whole request, and the sweep then flagged it AND the person's real booking as
// conflicting for every month of it. The substitution now writes the substituted
// month as the window and the transferred FTE as the pct
// (`planSubstitutionBooking`); this pins that the phantom conflict is gone.
describe('schedule.util buildSchedule — a substitution-created booking', () => {
  const SIX_MONTH_REQUEST = { startDate: '2026-09-01', endDate: '2027-02-28' };

  it('would conflict for the whole request window with no dates and no pct (the defect)', () => {
    const model = buildSchedule(
      [resource('R1')],
      [
        assignment('A_OWN', { requestId: 'REQ_OWN', resourceId: 'R1', startDate: '2026-11-01', endDate: '2026-11-30', allocationPct: 100 }),
        assignment('A_SUB', { requestId: 'REQ_SUB', resourceId: 'R1' }), // no window, no pct
      ],
      [request('REQ_OWN', { startDate: '2026-11-01', endDate: '2026-11-30' }), request('REQ_SUB', SIX_MONTH_REQUEST)],
    );
    const lane = laneOf(model, 'R1');
    expect(lane.hasConflict).toBe(true);
    expect(lane.peakAllocationPct).toBe(200);
    expect(lane.bookings.every(b => b.conflict)).toBe(true);
  });

  it('does not conflict once it carries the substituted month and the transferred FTE', () => {
    // 40h transferred into 2026-09 against a 176h month => 22.73%.
    const model = buildSchedule(
      [resource('R1')],
      [
        assignment('A_OWN', { requestId: 'REQ_OWN', resourceId: 'R1', startDate: '2026-11-01', endDate: '2026-11-30', allocationPct: 100 }),
        assignment('A_SUB', { requestId: 'REQ_SUB', resourceId: 'R1', startDate: '2026-09-01', endDate: '2026-09-30', allocationPct: 22.73 }),
      ],
      [request('REQ_OWN', { startDate: '2026-11-01', endDate: '2026-11-30' }), request('REQ_SUB', SIX_MONTH_REQUEST)],
    );
    const lane = laneOf(model, 'R1');
    expect(lane.hasConflict).toBe(false);
    expect(model.conflicts).toEqual([]);
    expect(lane.bookings.every(b => !b.conflict)).toBe(true);
    // The bar stops at the substituted month instead of running to 2027-02.
    expect(lane.bookings.find(b => b.assignmentId === 'A_SUB')?.endDate).toBe('2026-09-30');
  });
});
