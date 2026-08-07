import { describe, expect, it } from 'vitest';
import type { RedactedAbsence, ResourceAbsence, UserRole } from '../app/services/api.service';
import { hasAnyAllowedRole } from './authz-policy.util';
import {
  ABSENCE_FIELDS,
  ABSENCE_MUTATION_RULES,
  ABSENCE_READ_RULES,
  ABSENCE_REASON_CODE_VALUES,
  AVAILABILITY_READ_ROLES,
  absenceCreateError,
  absenceOutsideEmploymentError,
  absenceOverlapError,
  absencePatchError,
  absenceRangeError,
  absenceReadScope,
  absenceSelfRecordError,
  absencesInMonthRange,
  bookedDaysInAbsence,
  bookingOnAbsenceError,
  isAbsenceCalendarPath,
  isProjectClassificationPath,
  nonBillableBillingItemError,
  nonBillableFlipError,
  parseProjectClassification,
  pinnedAbsenceFields,
  PROJECT_MUTATION_RULES,
  projectClassificationFieldError,
  redactAbsence,
} from './absence-policy.util';

/**
 * roleGate's own resolution, replayed over the SAME exported arrays the server
 * spreads into its tables: FIRST match wins, then `hasAnyAllowedRole` over the
 * verified role set. Asserting through these (rather than on the constants)
 * is what makes the ORDER load-bearing in the test too.
 */
function resolve(
  rules: readonly { test: (p: string) => boolean; roles: readonly UserRole[] }[],
  path: string,
  roles: readonly UserRole[],
): boolean {
  const rule = rules.find(candidate => candidate.test(path));
  return rule === undefined || hasAnyAllowedRole(roles, rule.roles);
}

// ---------------------------------------------------------------------------

describe('absence READ rule order', () => {
  /**
   * THE ORDER IS THE TEST, and it takes BOTH directions to distinguish the three
   * possible states. One assertion alone is worthless here:
   *   - both 403  => the calendar rule is never evaluated (order broken);
   *   - both 200  => the redaction protects nothing (audiences merged);
   *   - 200 / 403 => the only outcome that means the order holds.
   * Reverse ABSENCE_READ_RULES and this test goes red on the first expectation.
   */
  it('lets a pm read the redacted calendar and refuses it the reason', () => {
    expect(resolve(ABSENCE_READ_RULES, '/absences/calendar', ['pm'])).toBe(true);
    expect(resolve(ABSENCE_READ_RULES, '/absences', ['pm'])).toBe(false);
  });

  it('is order-sensitive: the calendar rule precedes the reason rule', () => {
    const calendarIndex = ABSENCE_READ_RULES.findIndex(r => r.test('/absences/calendar'));
    const reasonIndex = ABSENCE_READ_RULES.findIndex(r => r.test('/absences'));
    expect(calendarIndex).toBeLessThan(reasonIndex);
    // NON-VACUITY: the reason rule really does match the calendar path too, which
    // is exactly why the order matters. If it did not, the index assertion above
    // would be a decoration.
    expect(ABSENCE_READ_RULES[reasonIndex].test('/absences/calendar')).toBe(true);
  });

  it('serves the calendar to the same audience as /capacity and /bench', () => {
    for (const role of AVAILABILITY_READ_ROLES) {
      expect(resolve(ABSENCE_READ_RULES, '/absences/calendar', [role])).toBe(true);
    }
    // ...and to nobody else. `employee` and `sales` have no staffing need-to-know.
    expect(resolve(ABSENCE_READ_RULES, '/absences/calendar', ['employee'])).toBe(false);
    expect(resolve(ABSENCE_READ_RULES, '/absences/calendar', ['sales'])).toBe(false);
  });

  it('admits the reason audience — delivery-executive included, by product decision Q5', () => {
    for (const role of ['resource-manager', 'delivery-executive', 'admin'] as const) {
      expect(resolve(ABSENCE_READ_RULES, '/absences', [role])).toBe(true);
    }
    // `employee` is admitted BY THE RULE and narrowed to own rows in the handler
    // (a READ_RULE is per-path, never per-row) — absenceReadScope below.
    expect(resolve(ABSENCE_READ_RULES, '/absences', ['employee'])).toBe(true);
    // The excluded twin: finance and sales have no need-to-know for the reason.
    expect(resolve(ABSENCE_READ_RULES, '/absences', ['finance'])).toBe(false);
    expect(resolve(ABSENCE_READ_RULES, '/absences', ['sales'])).toBe(false);
  });

  it('narrows only the non-privileged principal to their own rows', () => {
    expect(absenceReadScope(['employee'])).toBe('own');
    expect(absenceReadScope(['pm'])).toBe('own');
    expect(absenceReadScope(['resource-manager'])).toBe('all');
    expect(absenceReadScope(['delivery-executive'])).toBe('all');
    expect(absenceReadScope(['admin'])).toBe('all');
    // A principal holding BOTH sees everything: authorization is on the SET.
    expect(absenceReadScope(['employee', 'resource-manager'])).toBe('all');
  });

  it('matches only the exact calendar path', () => {
    expect(isAbsenceCalendarPath('/absences/calendar')).toBe(true);
    expect(isAbsenceCalendarPath('/absences/calendar/2026')).toBe(false);
    expect(isAbsenceCalendarPath('/absences/AB1')).toBe(false);
    expect(isAbsenceCalendarPath('/absences')).toBe(false);
  });
});

describe('absence MUTATION rule', () => {
  it('lets resource-manager and admin record, and nobody else', () => {
    expect(resolve(ABSENCE_MUTATION_RULES, '/absences', ['resource-manager'])).toBe(true);
    expect(resolve(ABSENCE_MUTATION_RULES, '/absences/AB1', ['admin'])).toBe(true);
    // Q5 widened the READ audience only. A delivery-executive may LEARN the
    // reason; it does not own the HR fact, so it may not record one.
    expect(resolve(ABSENCE_MUTATION_RULES, '/absences', ['delivery-executive'])).toBe(false);
    expect(resolve(ABSENCE_MUTATION_RULES, '/absences', ['pm'])).toBe(false);
    expect(resolve(ABSENCE_MUTATION_RULES, '/absences', ['employee'])).toBe(false);
  });

  it('keeps the pinned fields out of the write allow-list', () => {
    expect([...ABSENCE_FIELDS]).toStrictEqual(['resourceId', 'startDate', 'endDate', 'reasonCode', 'note']);
    expect(ABSENCE_FIELDS).not.toContain('recordedBy');
    expect(ABSENCE_FIELDS).not.toContain('recordedAt');
  });

  it('pins provenance from the actor, not the body', () => {
    expect(pinnedAbsenceFields('7', '2026-08-07T09:00:00.000Z')).toStrictEqual({
      recordedBy: '7', recordedAt: '2026-08-07T09:00:00.000Z',
    });
  });
});

describe('project mutation rule order', () => {
  /**
   * The twin of the READ-side order test, and the same three-state argument: a
   * single direction cannot tell "the narrow rule works" from "the narrow rule
   * is dead code intercepted by the coarse one".
   */
  it('refuses a pm the classification and allows it the ordinary project edit', () => {
    expect(resolve(PROJECT_MUTATION_RULES, '/projects/3/classification', ['pm'])).toBe(false);
    expect(resolve(PROJECT_MUTATION_RULES, '/projects/3', ['pm'])).toBe(true);
  });

  it('is order-sensitive: the classification rule precedes the coarse projects rule', () => {
    const narrow = PROJECT_MUTATION_RULES.findIndex(r => r.test('/projects/3/classification'));
    const coarse = PROJECT_MUTATION_RULES.findIndex(r => r.roles.includes('pm'));
    expect(narrow).toBeLessThan(coarse);
    // NON-VACUITY: the coarse rule DOES match the classification path — that is
    // the whole hazard. Without this the index comparison proves nothing.
    expect(PROJECT_MUTATION_RULES[coarse].test('/projects/3/classification')).toBe(true);
  });

  it('admits the finance-grade classification audience', () => {
    for (const role of ['delivery-executive', 'finance', 'admin'] as const) {
      expect(resolve(PROJECT_MUTATION_RULES, '/projects/3/classification', [role])).toBe(true);
    }
    // ...and refuses the roles that may not switch off a margin expectation.
    expect(resolve(PROJECT_MUTATION_RULES, '/projects/3/classification', ['resource-manager'])).toBe(false);
    expect(resolve(PROJECT_MUTATION_RULES, '/projects/3/classification', ['sales'])).toBe(false);
  });

  it('recognises the classification path exactly', () => {
    expect(isProjectClassificationPath('/projects/3/classification')).toBe(true);
    expect(isProjectClassificationPath('/projects/a-b-c/classification')).toBe(true);
    expect(isProjectClassificationPath('/projects/3/classification/extra')).toBe(false);
    expect(isProjectClassificationPath('/projects/classification')).toBe(false);
    expect(isProjectClassificationPath('/projects/3')).toBe(false);
  });

  it('keeps the rest of the project slice on the coarse rule', () => {
    for (const path of ['/milestones/M1', '/work-packages/W1', '/change-requests/CR1', '/project-tasks/T1']) {
      expect(resolve(PROJECT_MUTATION_RULES, path, ['pm'])).toBe(true);
      expect(resolve(PROJECT_MUTATION_RULES, path, ['sales'])).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

describe('absence write validation', () => {
  const good = { resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31', reasonCode: 'ParentalLeave' };

  it('accepts a well-formed create', () => {
    expect(absenceCreateError({ ...good })).toBeNull();
    expect(absenceCreateError({ ...good, note: 'cover arranged' })).toBeNull();
  });

  it('requires every field on create', () => {
    expect(absenceCreateError({ startDate: '2026-06-01', endDate: '2026-06-02', reasonCode: 'Vacation' }))
      .toBe('resourceId is required');
    expect(absenceCreateError({ resourceId: '8', endDate: '2026-06-02', reasonCode: 'Vacation' }))
      .toBe('startDate is required and must match YYYY-MM-DD');
    expect(absenceCreateError({ resourceId: '8', startDate: '2026-06-01', reasonCode: 'Vacation' }))
      .toBe('endDate is required and must match YYYY-MM-DD');
    expect(absenceCreateError({ resourceId: '8', startDate: '2026-06-01', endDate: '2026-06-02' }))
      .toContain('reasonCode must be one of');
  });

  it('rejects a rollover date the permissive parser would accept', () => {
    expect(absenceCreateError({ ...good, startDate: '2026-02-30' })).toBe('startDate must match YYYY-MM-DD');
  });

  it('rejects a reason outside the six of the manual plus Other', () => {
    expect(absenceCreateError({ ...good, reasonCode: 'AMS' })).toContain('reasonCode must be one of');
    // The paired presence assertion: every declared code IS accepted, so the
    // rejection above is about the value and not about a broken validator.
    for (const code of ABSENCE_REASON_CODE_VALUES) {
      expect(absenceCreateError({ ...good, reasonCode: code })).toBeNull();
    }
  });

  it('mirrors the client enum exactly', () => {
    expect([...ABSENCE_REASON_CODE_VALUES]).toStrictEqual(
      ['Maternity', 'ParentalLeave', 'Vacation', 'Sickness', 'Indisposition', 'Other']);
  });

  it('checks only the fields a patch supplies', () => {
    expect(absencePatchError({})).toBeNull();
    expect(absencePatchError({ endDate: '2026-09-30' })).toBeNull();
    expect(absencePatchError({ endDate: 'soon' })).toBe('endDate must match YYYY-MM-DD');
    expect(absencePatchError({ reasonCode: 'Nope' })).toContain('reasonCode must be one of');
    expect(absencePatchError({ note: 42 })).toBe('note must be a string');
    expect(absencePatchError({ note: null })).toBeNull();
  });

  it('requires end on or after start, one-day absences included', () => {
    expect(absenceRangeError({ startDate: '2026-06-01', endDate: '2026-06-01' })).toBeNull();
    expect(absenceRangeError({ startDate: '2026-06-02', endDate: '2026-06-01' }))
      .toBe('endDate 2026-06-01 must be on or after startDate 2026-06-02');
  });

  it('keeps the absence inside the employment window, both ends', () => {
    const window = { hireDate: '2026-04-01', terminationDate: '2026-10-31' };
    expect(absenceOutsideEmploymentError({ startDate: '2026-06-01', endDate: '2026-08-31' }, window)).toBeNull();
    expect(absenceOutsideEmploymentError({ startDate: '2026-03-31', endDate: '2026-04-05' }, window))
      .toBe('absence start 2026-03-31 is before hireDate 2026-04-01');
    expect(absenceOutsideEmploymentError({ startDate: '2026-10-01', endDate: '2026-11-01' }, window))
      .toBe('absence end 2026-11-01 is after terminationDate 2026-10-31');
    // Both bounds INCLUSIVE — an absence on the hire day is legitimate.
    expect(absenceOutsideEmploymentError({ startDate: '2026-04-01', endDate: '2026-10-31' }, window)).toBeNull();
    // No window at all constrains nothing.
    expect(absenceOutsideEmploymentError({ startDate: '2020-01-01', endDate: '2030-01-01' }, {})).toBeNull();
  });
});

describe('absence overlap', () => {
  const stored = [
    { id: 'AB2', resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31' },
    { id: 'AB4', resourceId: '14', startDate: '2026-05-11', endDate: '2026-05-15' },
  ];

  it('refuses an overlapping absence for the same resource', () => {
    expect(absenceOverlapError({ resourceId: '8', startDate: '2026-08-31', endDate: '2026-09-10' }, stored))
      .toBe('absence 2026-08-31..2026-09-10 overlaps an existing absence 2026-06-01..2026-08-31 for this resource');
  });

  it('allows the adjacent day, and another resource on the very same dates', () => {
    // The gemella of the refusal above: one day later is fine, so the 409 is
    // about the interval and not about the resource being blocked outright.
    expect(absenceOverlapError({ resourceId: '8', startDate: '2026-09-01', endDate: '2026-09-10' }, stored)).toBeNull();
    expect(absenceOverlapError({ resourceId: '9', startDate: '2026-06-01', endDate: '2026-08-31' }, stored)).toBeNull();
  });

  it('does not clash with itself on an update', () => {
    expect(absenceOverlapError({ id: 'AB2', resourceId: '8', startDate: '2026-06-01', endDate: '2026-09-30' }, stored))
      .toBeNull();
  });

  it('never names the reason of the blocking row', () => {
    const withReason = [{ ...stored[0], reasonCode: 'Maternity' as const }];
    const message = absenceOverlapError({ resourceId: '8', startDate: '2026-07-01', endDate: '2026-07-05' }, withReason);
    expect(message).not.toBeNull();
    expect(message).not.toContain('Maternity');
  });
});

describe('segregation of duties', () => {
  it('refuses the actor recording their own absence', () => {
    expect(absenceSelfRecordError('2', '2')).toBe(
      'the actor recording an absence cannot be its subject (segregation of duties)');
  });

  it('allows a colleague, and an unresolvable principal is not silently the subject', () => {
    expect(absenceSelfRecordError('2', '8')).toBeNull();
    expect(absenceSelfRecordError(undefined, '8')).toBeNull();
  });
});

describe('redaction', () => {
  const stored: ResourceAbsence = {
    id: 'AB2', resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31',
    reasonCode: 'ParentalLeave', note: 'cover arranged',
    recordedBy: '2', recordedAt: '2026-05-20T08:00:00.000Z',
  };

  it('projects exactly the four availability fields', () => {
    expect(redactAbsence(stored)).toStrictEqual({
      id: 'AB2', resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31',
    });
  });

  it('leaves the stored row untouched — a projection, not a delete', () => {
    redactAbsence(stored);
    expect(stored.reasonCode).toBe('ParentalLeave');
    expect(stored.note).toBe('cover arranged');
  });

  it('makes a leak a COMPILE error, not a runtime hope', () => {
    // @ts-expect-error a full ResourceAbsence is NOT assignable to RedactedAbsence
    const leaked: RedactedAbsence = stored;
    // Referenced so the assignment is not elided; the assertion that matters is
    // the @ts-expect-error above, which fails the BUILD if the type ever widens.
    expect(leaked.id).toBe('AB2');
  });

  it('keeps a month-range filter inclusive at both ends', () => {
    const rows = [
      { id: 'A', resourceId: '1', startDate: '2026-02-09', endDate: '2026-02-13' },
      { id: 'B', resourceId: '1', startDate: '2026-05-11', endDate: '2026-05-15' },
      { id: 'C', resourceId: '1', startDate: '2026-06-01', endDate: '2026-08-31' },
    ];
    expect(absencesInMonthRange(rows, '2026-04', '2026-09').map(r => r.id)).toStrictEqual(['B', 'C']);
    // The gemella: the SAME row is included once the window reaches it.
    expect(absencesInMonthRange(rows, '2026-02', '2026-03').map(r => r.id)).toStrictEqual(['A']);
    // A range crossing the window edge still counts — C starts in June.
    expect(absencesInMonthRange(rows, '2026-08', '2026-08').map(r => r.id)).toStrictEqual(['C']);
  });
});

describe('the booking gate and its deliberate asymmetry', () => {
  const absences = [
    { resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31' },
    { resourceId: '14', startDate: '2026-05-11', endDate: '2026-05-15' },
  ];
  const marco = { id: '8', name: 'Marco Belli' };

  it('refuses a new booking on an absent day, naming the date and the person', () => {
    expect(bookingOnAbsenceError(['2026-06-15'], marco, absences))
      .toBe('booking date 2026-06-15 falls in a recorded absence for Marco Belli');
  });

  it('accepts the very same booking a day outside the interval', () => {
    // The paired assertion: the gate is the INTERVAL, not the resource. Without
    // it, a rule that refused every booking for Marco would pass the test above.
    expect(bookingOnAbsenceError(['2026-05-29'], marco, absences)).toBeNull();
    expect(bookingOnAbsenceError(['2026-09-01'], marco, absences)).toBeNull();
  });

  it('is inclusive on both ends and reports the earliest offender', () => {
    expect(bookingOnAbsenceError(['2026-06-01'], marco, absences)).toContain('2026-06-01');
    expect(bookingOnAbsenceError(['2026-08-31'], marco, absences)).toContain('2026-08-31');
    expect(bookingOnAbsenceError(['2026-07-20', '2026-06-02'], marco, absences)).toContain('2026-06-02');
  });

  it('ignores another resource\'s absences', () => {
    expect(bookingOnAbsenceError(['2026-05-12'], marco, absences)).toBeNull();
    // ...and does catch that resource's own.
    expect(bookingOnAbsenceError(['2026-05-12'], { id: '14', name: 'Sofia' }, absences)).not.toBeNull();
  });

  it('never names the reason — the refusal reaches pm, outside the reason audience', () => {
    const withReason = [{ ...absences[0], reasonCode: 'Maternity' as const, note: 'private' }];
    const message = bookingOnAbsenceError(['2026-06-15'], marco, withReason);
    expect(message).not.toContain('Maternity');
    expect(message).not.toContain('private');
  });

  it('ACCEPTS an absence over booked days and reports them — the other direction', () => {
    const days = [
      { date: '2026-05-08', hours: 8 },
      { date: '2026-05-11', hours: 8 },
      { date: '2026-05-13', hours: 7.125 },
      { date: '2026-05-14', hours: 0 },
      { date: '2026-05-20', hours: 8 },
    ];
    expect(bookedDaysInAbsence({ startDate: '2026-05-11', endDate: '2026-05-15' }, days)).toStrictEqual([
      { date: '2026-05-11', hours: 8 },
      { date: '2026-05-13', hours: 7.13 },
    ]);
  });

  it('reports an empty list rather than nothing when there is no conflict', () => {
    expect(bookedDaysInAbsence({ startDate: '2026-05-11', endDate: '2026-05-15' }, [{ date: '2026-06-01', hours: 8 }]))
      .toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('engagement classification', () => {
  it('accepts a valid pair', () => {
    expect(parseProjectClassification({ billable: false, type: 'Basket' }))
      .toStrictEqual({ value: { billable: false, type: 'Basket' } });
    expect(parseProjectClassification({ billable: true, type: 'Delivery' }))
      .toStrictEqual({ value: { billable: true, type: 'Delivery' } });
  });

  it('enforces Basket implies non-billable, and leaves the converse free', () => {
    expect(parseProjectClassification({ billable: true, type: 'Basket' }))
      .toStrictEqual({ error: 'a Basket engagement must be non-billable (billable: false)' });
    // The converse: a non-billable Delivery engagement is legitimate (an internal
    // project that is not a practice basket). If this ever went red the invariant
    // would have been implemented backwards, which is the easy mistake.
    expect(parseProjectClassification({ billable: false, type: 'Delivery' }))
      .toStrictEqual({ value: { billable: false, type: 'Delivery' } });
  });

  it('rejects a missing or mistyped field', () => {
    expect(parseProjectClassification({ type: 'Delivery' })).toStrictEqual({ error: 'billable must be a boolean' });
    expect(parseProjectClassification({ billable: 'false', type: 'Delivery' }))
      .toStrictEqual({ error: 'billable must be a boolean' });
    expect(parseProjectClassification({ billable: true })).toStrictEqual({ error: 'type must be one of: Delivery, Basket' });
    expect(parseProjectClassification({ billable: true, type: 'AMS' }))
      .toStrictEqual({ error: 'type must be one of: Delivery, Basket' });
    expect(parseProjectClassification(undefined)).toStrictEqual({ error: 'billable must be a boolean' });
  });

  it('refuses the two fields on the ordinary project write, loudly', () => {
    expect(projectClassificationFieldError({ name: 'X', billable: false }))
      .toBe('billable is set by PUT /projects/:id/classification and cannot be sent here');
    expect(projectClassificationFieldError({ name: 'X', type: 'Basket' }))
      .toBe('type is set by PUT /projects/:id/classification and cannot be sent here');
    // The gemella: an ordinary body is untouched, so the 403 is about these two
    // keys and not about a project write that has stopped working.
    expect(projectClassificationFieldError({ name: 'X', status: 'In Planning', contractId: 'CT1' })).toBeNull();
    expect(projectClassificationFieldError(undefined)).toBeNull();
  });
});

describe('the two zero-euro-invoice gates', () => {
  const basket = { id: '3', name: 'BASKET — Engineering Practice', billable: false };
  const alpha = { id: '1', name: 'Project Alpha', billable: true };

  it('GATE 1 refuses a billing item on a non-billable engagement', () => {
    expect(nonBillableBillingItemError(basket))
      .toBe('projectId 3 is a non-billable engagement and cannot carry a billing plan item');
  });

  it('GATE 1 accepts one on a billable engagement — the refusal is about billability', () => {
    expect(nonBillableBillingItemError(alpha)).toBeNull();
    // An absent `billable` reads as billable: the safe default, which keeps a
    // pre-existing row billable rather than silently un-invoiceable.
    expect(nonBillableBillingItemError({ id: '2' })).toBeNull();
    expect(nonBillableBillingItemError(undefined)).toBeNull();
  });

  it('GATE 2 refuses the flip while billing items still reference the project', () => {
    expect(nonBillableFlipError({ billable: false, type: 'Basket' }, 2))
      .toBe('cannot classify this engagement as non-billable: 2 billing plan item(s) still reference it');
  });

  it('GATE 2 allows the flip with no items, and never blocks the flip BACK to billable', () => {
    // Both gemelle of the refusal above: the 409 is about the items, not the flip;
    // and re-enabling billing on an engagement that has items is always fine.
    expect(nonBillableFlipError({ billable: false, type: 'Basket' }, 0)).toBeNull();
    expect(nonBillableFlipError({ billable: true, type: 'Delivery' }, 2)).toBeNull();
  });

  it('needs BOTH gates: gate 1 alone is walked around by create-then-flip', () => {
    // The three-step sequence, replayed on the pure rules. Step 2 is legal
    // BECAUSE step 1 made the project billable; only gate 2 stops step 3.
    const beforeFlip = { id: '3', name: 'X', billable: true };
    expect(nonBillableBillingItemError(beforeFlip)).toBeNull();            // 1+2: item created
    expect(nonBillableFlipError({ billable: false, type: 'Basket' }, 1))   // 3: the flip
      .toContain('1 billing plan item(s) still reference it');
  });
});
