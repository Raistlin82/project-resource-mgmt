import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  requests, assignments, assignmentDays, assignmentMonths, costBaselines,
  resources, resourceAbsences, projects, timeEntries, holidays, planningPeriods,
  billingPlanItems, users,
} from './seed';
import { workingDaysInMonth } from '../app/services/calendar.util';
import { ABSENCE_REASON_CODES } from '../app/services/api.service';

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

// ---------------------------------------------------------------------------
// BLOCK H / T2 — the seed fixtures for non-billable engagements and absences.
// Design spec: docs/superpowers/specs/2026-08-06-h-basket-non-billable-design.md
//
// WHY THIS SUITE EXISTS, AND WHAT IT DELIBERATELY DOES NOT DO.
//
// T2 ships DATA, and the arithmetic that will consume it (absence.util,
// bench.util's fourth state, capacity.util's pro-rated target, finance.util's
// billable exclusions) belongs to T3/T4/T5 and does not exist yet. So none of
// the assertions below claims a cell is ABSENT or that an alert is suppressed:
// those would be tests of code nobody has written. What they assert instead is
// the property that decides whether those later tests can be blind — that these
// rows ARE CAPABLE OF MOVING A NUMBER, and that they are legal rows the write
// path would accept.
//
// Every "the fixture bites here" assertion is paired with the "and not there"
// twin that proves it discriminates, because the recurring defect of this
// project is the green gate no data exercises. The three shapes guarded:
//   1. the two `[]` placeholders T1 left behind being left as `[]` — invisible
//      in dev, unexercised everywhere, and green;
//   2. a fixture that sits outside the window it claims to move (a date on a
//      weekend, an absence in a month nobody displays);
//   3. a non-billable engagement with no APPROVED hours, which every finance
//      surface skips for lack of data rather than by the rule under test.
// ---------------------------------------------------------------------------

/** The six months `/bench/monthly` and `/capacity/monthly` display by default —
 *  DERIVED from the seed's own anchor (first Open planning period, +5), never
 *  hard-coded, so moving the demo year moves this suite with it. */
const DISPLAY_MONTHS = ((): string[] => {
  const anchor = planningPeriods.filter(p => p.status === 'Open').map(p => p.id).sort()[0];
  const [y, m] = anchor.split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => {
    const idx = y * 12 + (m - 1) + i;
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  });
})();

const HOLIDAY_SET = new Set(holidays.map(h => h.id));

/** ISO calendar days covered by an absence — start and end both INCLUSIVE. */
function daysCovered(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${startDate}T00:00:00Z`); d <= new Date(`${endDate}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** How many of `month`'s WORKING days this resource is absent for. The only
 *  arithmetic the derived surfaces will do on these rows (spec §3.4: the
 *  reason is never read), reproduced here so the fixture can be checked
 *  without the util that will do it. */
function absentWorkingDaysIn(resourceId: string, month: string): number {
  const working = new Set(workingDaysInMonth(month, HOLIDAY_SET));
  const covered = new Set(
    resourceAbsences.filter(a => a.resourceId === resourceId).flatMap(a => daysCovered(a.startDate, a.endDate)),
  );
  return [...working].filter(d => covered.has(d)).length;
}

/** Hours booked for a resource in a month, counting only day rows whose OWN
 *  month row is confirmed/pending — the same `planned` bucket the rollups use. */
function bookedHoursIn(resourceId: string, month: string): number {
  const own = new Set(assignments.filter(a => a.resourceId === resourceId).map(a => a.id));
  const statusOf = new Map(assignmentMonths.map(m => [m.id, m.status]));
  return assignmentDays
    .filter(d => own.has(d.assignmentId) && d.date.startsWith(month))
    .filter(d => {
      const s = statusOf.get(`${d.assignmentId}:${month}`);
      return s === 'Allocated' || s === 'Requested';
    })
    .reduce((total, d) => total + d.hours, 0);
}

describe('block H — the two placeholders T1 left for this task', () => {
  // T1 wired both call sites to a literal `[]` and said so in an imperative
  // comment. Left that way, `seed.resourceAbsences` exists, type-checks, is
  // exported, and is read by NOTHING: the feature is invisible on first boot in
  // both dev and a fresh Postgres, and every gate in the repository stays
  // green. These two assertions are the ones that go red if the placeholder
  // comes back, which is what makes the rest of this suite worth writing.
  //
  // Asserted against the SOURCE rather than by calling `getRepositories()`,
  // for the reason T1's own bootstrap-order test gives: the wiring is a
  // property of the source text, and `bootstrap.ts`'s half cannot be observed
  // at all without a live database.
  const sourceOf = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

  it('the in-memory adapter is seeded from `seed.resourceAbsences`, not from `[]`', () => {
    const source = sourceOf('src/db/repositories.ts');
    expect(source).toContain('resourceAbsences: mem<ResourceAbsence>(seed.resourceAbsences)');
    expect(source).not.toContain('resourceAbsences: mem<ResourceAbsence>([])');
  });

  it('the Postgres seeder is fed `seed.resourceAbsences`, not `[]`', () => {
    const source = sourceOf('src/db/bootstrap.ts');
    expect(source).toContain('seedIfEmpty(database, schema.resourceAbsences, seed.resourceAbsences)');
    expect(source).not.toContain('seedIfEmpty(database, schema.resourceAbsences, [])');
  });

  it('and there is something to wire: the export is non-empty', () => {
    // The twin of the two above. Wiring an empty array is the same defect with
    // a longer identifier.
    expect(resourceAbsences.length).toBeGreaterThan(0);
  });
});

describe('block H — every seeded absence is a row the write path would accept', () => {
  // A fixture the API itself would refuse is a fixture that lies: it certifies
  // a state the product cannot reach. Each rule below is one the server task
  // (T6) will enforce, checked here against the data T2 ships.

  it('has start <= end, both inclusive, on every row', () => {
    expect(resourceAbsences.filter(a => a.endDate < a.startDate)).toStrictEqual([]);
  });

  it('references only seeded resources, and stays inside each one\'s employment window', () => {
    const byId = new Map(resources.map(r => [r.id, r]));
    const offenders = resourceAbsences.filter(a => {
      const r = byId.get(a.resourceId);
      if (!r) return true;
      if (r.hireDate !== undefined && a.startDate < r.hireDate) return true;
      return r.terminationDate !== undefined && a.endDate > r.terminationDate;
    });
    expect(offenders.map(a => a.id)).toStrictEqual([]);
    // The twin: the check above is only meaningful if the resources it looked
    // up actually declare a hire date to be compared against.
    expect(resourceAbsences.every(a => byId.get(a.resourceId)?.hireDate !== undefined)).toBe(true);
  });

  it('never overlaps another absence of the same resource (the 409 rule)', () => {
    const overlaps: string[] = [];
    for (const a of resourceAbsences) {
      for (const b of resourceAbsences) {
        if (a.id >= b.id || a.resourceId !== b.resourceId) continue;
        if (a.startDate <= b.endDate && b.startDate <= a.endDate) overlaps.push(`${a.id}/${b.id}`);
      }
    }
    expect(overlaps).toStrictEqual([]);
    // The twin: the loop above compares nothing unless some resource really
    // does carry two rows. Sofia ('14') carries AB3 and AB4.
    const perResource = new Map<string, number>();
    for (const a of resourceAbsences) perResource.set(a.resourceId, (perResource.get(a.resourceId) ?? 0) + 1);
    expect([...perResource.values()].some(n => n > 1)).toBe(true);
  });

  it('is recorded by a real user who is never the subject (segregation of duties)', () => {
    const userById = new Map(users.map(u => [u.id, u]));
    for (const a of resourceAbsences) {
      const recorder = userById.get(a.recordedBy);
      expect(recorder, `absence ${a.id} recordedBy '${a.recordedBy}' is not a seeded user`).toBeDefined();
      expect(recorder!.resourceId, `absence ${a.id} records its own recorder`).not.toBe(a.resourceId);
    }
  });

  it('uses only the manual\'s six reasons, and no engagement masquerading as one', () => {
    expect([...ABSENCE_REASON_CODES]).toStrictEqual([
      'Maternity', 'ParentalLeave', 'Vacation', 'Sickness', 'Indisposition', 'Other',
    ]);
    const codes = new Set<string>(ABSENCE_REASON_CODES);
    expect(resourceAbsences.filter(a => !codes.has(a.reasonCode))).toStrictEqual([]);
    // The distinction that keeps the two halves of block H apart: AMS and
    // technical groups are ENGAGEMENTS, never absence reasons. If one ever
    // shows up as a reason, the wrong entity was used.
    expect(codes.has('AMS')).toBe(false);
  });

  it('exercises the nullable `note` column in BOTH directions', () => {
    // `note` is this table's only nullable column and therefore its only
    // row-level exercise of the `nullsToUndefined()` seam on a live Postgres
    // boot. All-with or all-without would leave one of the two paths untested
    // by the shipped data.
    const withNote = resourceAbsences.filter(a => a.note !== undefined);
    const withoutNote = resourceAbsences.filter(a => a.note === undefined);
    expect(withNote.length).toBeGreaterThan(0);
    expect(withoutNote.length).toBeGreaterThan(0);
    // …and absent, never an empty string: '' is a non-null value that would
    // come back as '' from Postgres and as '' from memory, quietly skipping
    // the null path this fixture exists to exercise.
    expect(resourceAbsences.some(a => a.note === '')).toBe(false);
  });
});

describe('block H — the absences bite exactly where they claim to (S1-S4)', () => {
  it('S1: resource 8 loses June, July and August entirely — and keeps April, May and September', () => {
    // The headline correction. Marco is the seed's pure bench case (hired on
    // the anchor month, never booked), so today all six displayed months count
    // him as idle delivery capacity. Three of them must stop.
    const covered = Object.fromEntries(DISPLAY_MONTHS.map(m => [m, absentWorkingDaysIn('8', m)]));
    const total = Object.fromEntries(DISPLAY_MONTHS.map(m => [m, workingDaysInMonth(m, HOLIDAY_SET).length]));
    expect(covered).toStrictEqual({
      '2026-04': 0, '2026-05': 0, '2026-06': 22, '2026-07': 23, '2026-08': 21, '2026-09': 0,
    });
    // The pairing that matters (§8.1): the three covered months are covered
    // COMPLETELY — a partially covered month is not the same fixture and would
    // not leave the bench — and the other three are untouched, so the absence
    // changed an interval, not a row.
    expect(total).toStrictEqual({
      '2026-04': 22, '2026-05': 21, '2026-06': 22, '2026-07': 23, '2026-08': 21, '2026-09': 22,
    });
  });

  it('S4: the subco loses August entirely, and only August', () => {
    // Deliberately a whole month, not the "short" absence §8.3 suggests: a
    // short absence inside an already-BENCH month leaves the state BENCH and
    // moves no tile, so it would look like coverage of the subco case while
    // exercising nothing.
    expect(Object.fromEntries(DISPLAY_MONTHS.map(m => [m, absentWorkingDaysIn('6', m)]))).toStrictEqual({
      '2026-04': 0, '2026-05': 0, '2026-06': 0, '2026-07': 0, '2026-08': 21, '2026-09': 0,
    });
    expect(resources.find(r => r.id === '6')?.kind).toBe('subco');
  });

  it('S1 and S4 overlap in August alone, so the internal and subco tiles are separable', () => {
    // Both /dashboard tiles must move in August; only the internal one in June
    // and July. Were both fixtures in the same single month, one tile staying
    // wrong would be indistinguishable from both being right.
    const monthsWithInternalAbsence = DISPLAY_MONTHS.filter(m => absentWorkingDaysIn('8', m) > 0);
    const monthsWithSubcoAbsence = DISPLAY_MONTHS.filter(m => absentWorkingDaysIn('6', m) > 0);
    expect(monthsWithInternalAbsence).toStrictEqual(['2026-06', '2026-07', '2026-08']);
    expect(monthsWithSubcoAbsence).toStrictEqual(['2026-08']);
  });

  it('S2: the same 168 booked May hours read 100.00% against the month and 131.25% against the available days', () => {
    // The differential, expressed as data rather than as a call into code that
    // does not exist yet: ONE unchanged numerator, TWO denominators. Delete
    // AB4, move it onto a weekend, or push it out of May, and the two
    // percentages collapse to the same number.
    const hoursPerDay = resources.find(r => r.id === '14')!.contractHoursPerDay!;
    const mayWorkingDays = workingDaysInMonth('2026-05', HOLIDAY_SET).length;
    const absentDays = absentWorkingDaysIn('14', '2026-05');
    const booked = bookedHoursIn('14', '2026-05');

    expect({ hoursPerDay, mayWorkingDays, absentDays, booked })
      .toStrictEqual({ hoursPerDay: 8, mayWorkingDays: 21, absentDays: 5, booked: 168 });

    const wholeMonthPct = (booked / (mayWorkingDays * hoursPerDay)) * 100;
    const availablePct = (booked / ((mayWorkingDays - absentDays) * hoursPerDay)) * 100;
    expect(Number(wholeMonthPct.toFixed(2))).toBe(100);
    expect(Number(availablePct.toFixed(2))).toBe(131.25);
    expect(availablePct).toBeGreaterThan(100); // …and therefore band `over`, not `optimal`
  });

  it('S3: the February absence covers real working days and still touches no displayed month', () => {
    // The no-effect twin of S2 — same resource, same five working days, only a
    // different place on the calendar. The first assertion is what stops this
    // from being a pass for lack of data: a fixture that covered nothing would
    // satisfy the second one for the wrong reason.
    expect(absentWorkingDaysIn('14', '2026-02')).toBe(5);
    expect(DISPLAY_MONTHS).not.toContain('2026-02');
    expect(DISPLAY_MONTHS.filter(m => absentWorkingDaysIn('14', m) > 0)).toStrictEqual(['2026-05']);
  });

  it('touches exactly three resources and leaves every block-F pin alone', () => {
    // Priya ('7') and Elena ('9') carry block F's `availabilityDate` and
    // termination assertions; an absence on either would break another block's
    // pins for a reason unrelated to this one.
    const touched = [...new Set(resourceAbsences.map(a => a.resourceId))].sort();
    expect(touched).toStrictEqual(['14', '6', '8']);
    expect(touched).not.toContain('7');
    expect(touched).not.toContain('9');
  });
});

describe('block H — the non-billable engagements (S5-S9)', () => {
  const projectById = new Map(projects.map(p => [p.id, p]));
  const requestById = new Map(requests.map(r => [r.id, r]));
  /** assignment -> the project it ultimately books against. */
  const projectOfAssignment = (assignmentId: string): string | undefined =>
    requestById.get(assignments.find(a => a.id === assignmentId)?.requestId ?? '')?.projectId;

  it('S9: EVERY project spells `billable` and `type` out, including the two that take the default', () => {
    // The C1 adapter-parity trap, and the one point on which spec §8.3's "no
    // change to '1' and '2'" is wrong: both columns are NOT NULL DEFAULT, so
    // Postgres serves them back while the in-memory adapter serves whatever the
    // literal holds. Omitting them ships one seed with two JSON shapes.
    const missing = projects.filter(p => !('billable' in p) || !('type' in p)).map(p => p.id);
    expect(missing).toStrictEqual([]);
    // …and the intent of S9 preserved: the two pre-existing engagements are
    // still billable Delivery work, so not one of their numbers moves.
    expect(projects.filter(p => ['1', '2'].includes(p.id)).map(p => ({ id: p.id, billable: p.billable, type: p.type })))
      .toStrictEqual([
        { id: '1', billable: true, type: 'Delivery' },
        { id: '2', billable: true, type: 'Delivery' },
      ]);
  });

  it('holds the invariant AND exercises its free converse', () => {
    // `type === 'Basket'` implies `billable === false`. The converse is free,
    // and project '4' is the free case. Without it, every finance exclusion
    // could be keyed on `type === 'Basket'` — the exactly-backwards reading —
    // and this seed would not notice.
    expect(projects.filter(p => p.type === 'Basket' && p.billable !== false).map(p => p.id)).toStrictEqual([]);
    expect(projects.filter(p => p.type === 'Basket').map(p => p.id)).toStrictEqual(['3']);
    expect(projects.filter(p => p.billable === false && p.type !== 'Basket').map(p => p.id)).toStrictEqual(['4']);
    expect(projects.filter(p => p.billable === true).map(p => p.id)).toStrictEqual(['1', '2']);
  });

  it('S5: the basket engagement carries APPROVED hours, which is what makes every finance exclusion testable', () => {
    // Trap (c) of §8: an engagement with an assignment but no approved time
    // entry has revenue 0, cost 0 and margin 0 — excluded from every finance
    // surface for lack of data, so "raises no margin alert" would prove nothing.
    const basket = projectById.get('3')!;
    expect({ billable: basket.billable, type: basket.type, contractId: basket.contractId })
      .toStrictEqual({ billable: false, type: 'Basket', contractId: undefined });

    const approved = timeEntries.filter(t => t.projectId === '3' && t.status === 'Approved');
    expect(approved.length).toBeGreaterThanOrEqual(2);
    expect(approved.reduce((n, t) => n + t.hours, 0)).toBe(24);
    // Every one of them coherent with its own assignment's request's project —
    // the rule the Log Hours UI writes and a seed row can silently break.
    for (const t of approved) expect(projectOfAssignment(t.assignmentId!)).toBe('3');
    // The twin: no contract means it lands under the synthetic 'unknown'
    // customer today, which is the permanently loss-making row F-5 removes.
    expect(basket.contractId).toBeUndefined();
  });

  it('S8: the basket is staffed by BOTH a real person and a placeholder', () => {
    // The two halves of block H interacting: the placeholder's hours must KEEP
    // counting as hiring demand (needing to hire for AMS is still needing to
    // hire) while the person's stop counting as billable value. One fixture
    // with only one kind lets an implementation satisfy both by accident.
    const kindOf = new Map(resources.map(r => [r.id, r.kind]));
    const staffed = assignments
      .filter(a => projectOfAssignment(a.id) === '3')
      .map(a => ({ resourceId: a.resourceId, kind: kindOf.get(a.resourceId), hours: a.assignedHours }))
      .sort((x, y) => x.resourceId.localeCompare(y.resourceId));
    expect(staffed).toStrictEqual([
      { resourceId: '14', kind: 'internal', hours: 176 },
      { resourceId: '4', kind: 'dummy', hours: 88 },
    ]);
  });

  it('F-8/U18: Sofia carries BOTH kinds of hours, so the billable figure has exactly one right answer', () => {
    // `resourceBillability` sums assignedHours over ALL her assignments today.
    // With 176 non-billable and 872 billable hours, the corrected figure is
    // 872 — and the two plausible wrong answers (unchanged 1,048, or an
    // over-corrected 0) are both excluded by this one split.
    const hers = assignments.filter(a => a.resourceId === '14');
    const split = { billable: 0, nonBillable: 0 };
    for (const a of hers) {
      const project = projectById.get(projectOfAssignment(a.id) ?? '');
      if (project?.billable === false) split.nonBillable += a.assignedHours;
      else split.billable += a.assignedHours;
    }
    expect(split).toStrictEqual({ billable: 872, nonBillable: 176 });
  });

  it('S6: a cost baseline sits ON the basket, which is the assertion against over-correcting', () => {
    // F-4 keeps `plannedCostSchedule`/`costBaselineComparison` alive on a
    // non-billable engagement — the manual's annual historical plan. Only a
    // baseline that actually sits on one can catch a blanket exclusion.
    const cb3 = costBaselines.find(c => c.id === 'CB3');
    expect(cb3).toStrictEqual({
      id: 'CB3', projectId: '3', period: '2026-04', amount: 20000,
      frozenAt: '2026-03-20T09:00:00.000Z', frozenBy: '4',
    });
    // …and the live plan it is compared against is non-zero and hand-derivable:
    // 176 + 88 = 264 booked hours in that period, at 80 EUR/h = 21,120.00 EUR
    // against a 20,000.00 baseline -> +1,120.00 / +5.60%.
    const basketAssignments = new Set(assignments.filter(a => projectOfAssignment(a.id) === '3').map(a => a.id));
    const aprilHours = assignmentDays
      .filter(d => basketAssignments.has(d.assignmentId) && d.date.startsWith('2026-04'))
      .reduce((n, d) => n + d.hours, 0);
    expect(aprilHours).toBe(264);
  });

  it('S7: the basket has NO billing plan item — recorded as a deliberate absence, with the twin that proves it is one', () => {
    // Zero rows in an array prove nothing on their own. The positive assertion
    // for this absence is a write-path one (POST /billing-plan-items on '3' ->
    // 400, on '1' -> 200) and belongs to the smoke suite; what this pins is
    // that the seed does not quietly acquire a row that would make the gate
    // untestable, AND that billing plan items exist at all in this seed.
    expect(billingPlanItems.filter(b => b.projectId === '3')).toStrictEqual([]);
    expect(billingPlanItems.filter(b => b.projectId === '1').length).toBeGreaterThan(0);
  });

  it('the non-basket non-billable engagement carries its own, distinguishable cost', () => {
    // Different resource and different rate from project '3' on purpose: 16
    // approved hours at John's 90/180 EUR-per-hour overrides read 1,440.00 /
    // 2,880.00 against the basket's 1,920.00 / 3,600.00, so a test can tell
    // WHICH project an exclusion actually excluded.
    const internal = projectById.get('4')!;
    expect({ billable: internal.billable, type: internal.type, contractId: internal.contractId })
      .toStrictEqual({ billable: false, type: 'Delivery', contractId: undefined });
    const approved = timeEntries.filter(t => t.projectId === '4' && t.status === 'Approved');
    expect(approved.reduce((n, t) => n + t.hours, 0)).toBe(16);
    expect(approved.every(t => t.resourceId === '2')).toBe(true);
    // …on a different resource from the basket's, so the two cannot be
    // conflated by a filter that happens to key on the person.
    expect(timeEntries.filter(t => t.projectId === '3').every(t => t.resourceId === '14')).toBe(true);
  });
});
