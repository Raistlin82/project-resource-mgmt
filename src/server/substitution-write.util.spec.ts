import { describe, expect, it } from 'vitest';
import type { AssignmentDay, AssignmentMonth } from '../app/services/api.service';
import { InMemoryRepository } from '../db/repository';
import { planGiveBack, planSubstitution } from '../app/services/substitution.util';
import { applyGiveBackDays, applySubstitutionDays, closeSubstitutionLink } from './substitution-write.util';

const DUMMY = 'A-DUMMY';
const TARGET = 'A-TARGET';
const MONTH_ROW = `${TARGET}:2026-09`;
/** Five working days of 8h on the dummy — the shape the register's exhibit uses. */
const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07'];

function dummyMonthRows(): AssignmentDay[] {
  return DATES.map(date => ({ id: `${DUMMY}:${date}`, assignmentId: DUMMY, date, hours: 8 }));
}

/**
 * Fails the Nth write of a chosen KIND, then behaves normally.
 *
 * Keyed on the kind of call rather than on a plain counter because the
 * substitution loop interleaves target writes with dummy writes: "the second
 * date" and "the second repository call" are different instants, and the
 * register's exhibit is the former.
 */
class FaultInjectingDayRepository extends InMemoryRepository<AssignmentDay> {
  private failures: { fail: (id: string) => boolean } | undefined;

  failOnce(predicate: (id: string) => boolean): void {
    let armed = true;
    this.failures = {
      fail: (id: string) => {
        if (armed && predicate(id)) { armed = false; return true; }
        return false;
      },
    };
  }

  override update(id: string, patch: Partial<AssignmentDay>): Promise<AssignmentDay | undefined> {
    if (this.failures?.fail(id)) return Promise.reject(new Error(`simulated day-row outage on ${id}`));
    return super.update(id, patch);
  }

  override create(entity: AssignmentDay): Promise<AssignmentDay> {
    if (this.failures?.fail(entity.id)) return Promise.reject(new Error(`simulated day-row outage on ${entity.id}`));
    return super.create(entity);
  }

  override remove(id: string): Promise<boolean> {
    if (this.failures?.fail(id)) return Promise.reject(new Error(`simulated day-row outage on ${id}`));
    return super.remove(id);
  }
}

async function sumHours(store: InMemoryRepository<AssignmentDay>, assignmentId: string): Promise<number> {
  const rows = (await store.list()).filter(row => row.assignmentId === assignmentId);
  return Math.round(rows.reduce((total, row) => total + row.hours, 0) * 100) / 100;
}

async function hoursByDate(
  store: InMemoryRepository<AssignmentDay>,
  assignmentId: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const row of await store.list()) {
    if (row.assignmentId === assignmentId) out[row.date] = row.hours;
  }
  return out;
}

describe('applySubstitutionDays — a failed transfer books no hours twice', () => {
  it('restores both sides when a mid-loop dummy write fails, leaving no copy on the target', async () => {
    const days = new FaultInjectingDayRepository(dummyMonthRows());
    const preTotal = await sumHours(days, DUMMY);
    expect(preTotal).toBe(40);

    // The target is a real person: 8h/day cap, nothing booked.
    const plan = planSubstitution(await hoursByDate(days, DUMMY), {}, 8);
    expect(plan.transferredHours).toBe(40);

    // The dummy-side write of date #2 fails — the instant the register's exhibit
    // names, after the target has already been credited for that date.
    const failDate = DATES[1];
    days.failOnce(id => id === `${DUMMY}:${failDate}`);

    await expect(applySubstitutionDays(days, plan, DUMMY, TARGET))
      .rejects.toThrow(`simulated day-row outage on ${DUMMY}:${failDate}`);

    // THE INVARIANT: hours are conserved. Before the fix this was preTotal + 8 —
    // date #2 existed on BOTH assignments.
    expect(await sumHours(days, DUMMY) + await sumHours(days, TARGET)).toBe(preTotal);
    // THE ASSERTION OF ABSENCE, and the load-bearing half: the target holds no
    // copy of the failed date. "The dummy still holds its 8h" is TRUE on the
    // unfixed code, so asserting only that proves nothing.
    expect(await days.get(`${TARGET}:${failDate}`)).toBeUndefined();
    // Nor of any other date: the whole call is undone, not just the failed date.
    expect(await sumHours(days, TARGET)).toBe(0);
    expect(await hoursByDate(days, DUMMY)).toStrictEqual(
      Object.fromEntries(DATES.map(date => [date, 8])),
    );
  });

  it('lets the retry move the FULL month after a compensated failure', async () => {
    const days = new FaultInjectingDayRepository(dummyMonthRows());
    const monthTotal = await sumHours(days, DUMMY);
    days.failOnce(id => id === `${DUMMY}:${DATES[1]}`);
    await expect(applySubstitutionDays(
      days,
      planSubstitution(await hoursByDate(days, DUMMY), {}, 8),
      DUMMY,
      TARGET,
    )).rejects.toThrow(/simulated day-row outage/);

    // The retry re-plans from the restored state, exactly as the endpoint does.
    // On the unfixed code the phantom copy consumed the target's room on date #2
    // (`room = cap - booked` = 0), so the retry moved 32h of 40 and reported
    // "the target has no capacity left in this month".
    const retryPlan = planSubstitution(
      await hoursByDate(days, DUMMY),
      await hoursByDate(days, TARGET),
      8,
    );
    expect(retryPlan.transferredHours).toBe(monthTotal);

    const { baseline } = await applySubstitutionDays(days, retryPlan, DUMMY, TARGET);
    expect(await sumHours(days, TARGET)).toBe(monthTotal);
    expect(await sumHours(days, DUMMY)).toBe(0);
    // The baseline covers every transferred date, zeros included — its absence
    // would make the give-back charge the target's own work against the loan.
    expect(Object.keys(baseline).sort()).toStrictEqual([...DATES].sort());
    expect(baseline[DATES[1]]).toBe(0);
  });

  it('merges onto hours the target already holds rather than overwriting them (control)', async () => {
    // NON-VACUITY: a writer that simply refused everything, or that only ever
    // created rows, would pass the two failure cases above.
    const days = new FaultInjectingDayRepository([
      ...dummyMonthRows(),
      { id: `${TARGET}:${DATES[0]}`, assignmentId: TARGET, date: DATES[0], hours: 3 },
    ]);
    const plan = planSubstitution(await hoursByDate(days, DUMMY), { [DATES[0]]: 3 }, 8);
    const { baseline } = await applySubstitutionDays(days, plan, DUMMY, TARGET);

    // 3 held + 5 absorbed on date #1; the remaining 3 stay on the dummy.
    expect((await days.get(`${TARGET}:${DATES[0]}`))?.hours).toBe(8);
    expect((await days.get(`${DUMMY}:${DATES[0]}`))?.hours).toBe(3);
    expect(baseline[DATES[0]]).toBe(3);
    // 40 dummy hours + the 3 the target already held: a substitution conserves
    // the target's own work, it does not overwrite it.
    expect(await sumHours(days, DUMMY) + await sumHours(days, TARGET)).toBe(43);
  });
});

describe('applyGiveBackDays — a failed give-back neither double-books nor wedges', () => {
  /** The state after a full substitution: the target holds all 40h, the dummy none. */
  function substitutedState(): {
    days: FaultInjectingDayRepository;
    months: InMemoryRepository<AssignmentMonth>;
    replacedDays: Record<string, number>;
  } {
    const days = new FaultInjectingDayRepository(
      DATES.map(date => ({ id: `${TARGET}:${date}`, assignmentId: TARGET, date, hours: 8 })),
    );
    const months = new InMemoryRepository<AssignmentMonth>([{
      id: MONTH_ROW,
      assignmentId: TARGET,
      month: '2026-09',
      status: 'Requested',
      replacedFromAssignmentMonthId: `${DUMMY}:2026-09`,
      replacedDays: Object.fromEntries(DATES.map(date => [date, 8])),
      replacedBaselineDays: Object.fromEntries(DATES.map(date => [date, 0])),
    } as AssignmentMonth]);
    return { days, months, replacedDays: Object.fromEntries(DATES.map(date => [date, 8])) };
  }

  function dependencies(
    days: FaultInjectingDayRepository,
    months: InMemoryRepository<AssignmentMonth>,
    recomputed: string[] = [],
  ) {
    return {
      assignmentDays: days,
      assignmentMonths: months,
      recomputeAssignedHours: async (assignmentId: string) => { recomputed.push(assignmentId); },
    };
  }

  it('gives the dummy nothing when the first target-side write fails', async () => {
    const { days, months, replacedDays } = substitutedState();
    const preDummyTotal = await sumHours(days, DUMMY);
    expect(preDummyTotal).toBe(0);

    const plan = planGiveBack(
      replacedDays,
      Object.fromEntries(DATES.map(date => [date, 0])),
      await hoursByDate(days, TARGET),
      'Rejected',
      {},
      8,
    );
    expect(plan.giveBackHours).toBe(40);
    expect(Object.keys(plan.targetHours).length).toBeGreaterThan(0);

    // The FIRST target-loop write — the dummy has already been credited for
    // every date by then, which is what made this 320h where 160 existed.
    days.failOnce(id => id === `${TARGET}:${DATES[0]}`);
    await expect(applyGiveBackDays(dependencies(days, months), plan, TARGET, DUMMY, MONTH_ROW))
      .rejects.toThrow(/simulated day-row outage/);

    // RED #1: the dummy was credited and not un-credited — preDummyTotal + 160
    // in the register's exhibit, +40 at this fixture's scale.
    expect(await sumHours(days, DUMMY)).toBe(preDummyTotal);
    // Its assertion of ABSENCE: the dummy's row for the first give-back date is
    // still absent. "The target still holds their hours" is TRUE on the unfixed
    // code, so that alone proves nothing.
    expect(await days.get(`${DUMMY}:${DATES[0]}`)).toBeUndefined();
    expect(await sumHours(days, TARGET)).toBe(40);
  });

  it('LEAVES THE SUBSTITUTION LINK OPEN after a failure, so the give-back is retryable', async () => {
    const { days, months, replacedDays } = substitutedState();
    const plan = planGiveBack(
      replacedDays,
      Object.fromEntries(DATES.map(date => [date, 0])),
      await hoursByDate(days, TARGET),
      'Rejected',
      {},
      8,
    );
    days.failOnce(id => id === `${TARGET}:${DATES[0]}`);
    await expect(applyGiveBackDays(dependencies(days, months), plan, TARGET, DUMMY, MONTH_ROW))
      .rejects.toThrow(/simulated day-row outage/);

    // RED #2, the load-bearing one: the unconditional `finally` cleared this, so
    // a partial give-back was permanent AND unrepeatable — no later decision,
    // retarget or delete could run it again.
    const row = await months.get(MONTH_ROW);
    expect(row?.replacedFromAssignmentMonthId).toBe(`${DUMMY}:2026-09`);
    expect(row?.replacedDays).toStrictEqual(replacedDays);
    expect(row?.replacedBaselineDays).toBeDefined();

    // AND THE RETRY SUCCEEDS over the restored state.
    const retryPlan = planGiveBack(
      row!.replacedDays!,
      row!.replacedBaselineDays!,
      await hoursByDate(days, TARGET),
      'Rejected',
      await hoursByDate(days, DUMMY),
      8,
    );
    await applyGiveBackDays(dependencies(days, months), retryPlan, TARGET, DUMMY, MONTH_ROW);
    expect(await sumHours(days, DUMMY)).toBe(40);
    expect(await sumHours(days, TARGET)).toBe(0);
  });

  it('CLOSES the link on a successful give-back (the mirror that stops "never close it")', async () => {
    // Without this case a "fix" that simply never clears the link goes green on
    // the case above and reintroduces the double-return the caller's own doc
    // comment warns about.
    const { days, months, replacedDays } = substitutedState();
    const recomputed: string[] = [];
    const plan = planGiveBack(
      replacedDays,
      Object.fromEntries(DATES.map(date => [date, 0])),
      await hoursByDate(days, TARGET),
      'Rejected',
      {},
      8,
    );
    await applyGiveBackDays(dependencies(days, months, recomputed), plan, TARGET, DUMMY, MONTH_ROW);

    const row = await months.get(MONTH_ROW);
    expect(row?.replacedFromAssignmentMonthId).toBeUndefined();
    expect(row?.replacedDays).toBeUndefined();
    expect(row?.replacedBaselineDays).toBeUndefined();
    // `toStrictEqual({...: undefined})` is satisfied by `{}`, so pin the keys too:
    // these three must be genuinely absent from the stored row.
    expect(Object.keys(row ?? {})).not.toContain('replacedFromAssignmentMonthId');
    expect(Object.keys(row ?? {})).not.toContain('replacedDays');
    expect(Object.keys(row ?? {})).not.toContain('replacedBaselineDays');
    // The row itself survives — the link is cleared, not the month.
    expect(row?.status).toBe('Requested');
    expect(recomputed).toStrictEqual([DUMMY, TARGET]);
  });

  it('closes the link and recomputes nothing when the plan moves no hours', async () => {
    // An empty plan (the dummy is at its ceiling on every date) must still settle
    // the link, and must NOT recompute: rewriting `assignedHours` from day rows on
    // an untouched assignment zeroes a legacy assignment that has no day rows.
    const { days, months } = substitutedState();
    const recomputed: string[] = [];
    await applyGiveBackDays(
      dependencies(days, months, recomputed),
      { giveBack: {}, targetHours: {} },
      TARGET,
      DUMMY,
      MONTH_ROW,
    );
    expect((await months.get(MONTH_ROW))?.replacedFromAssignmentMonthId).toBeUndefined();
    expect(recomputed).toStrictEqual([]);
    expect(await sumHours(days, TARGET)).toBe(40);
  });

  it('closeSubstitutionLink clears all three columns for the write-nothing paths', async () => {
    const { months } = substitutedState();
    await closeSubstitutionLink(months, MONTH_ROW);
    const row = await months.get(MONTH_ROW);
    expect(row?.replacedFromAssignmentMonthId).toBeUndefined();
    expect(Object.keys(row ?? {})).not.toContain('replacedBaselineDays');
  });
});
