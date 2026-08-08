import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { AllocationCalendarComponent } from './allocation-calendar.component';
import {
  ApiService,
  AssignmentAllocation,
  AssignmentAllocationResult,
  AssignmentMonth,
  Holiday,
  PlanningPeriod,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { MULTI_FTE_MAX, type ResourceKind } from '../services/resource-kind.util';

/** One open month ('2026-09'), no pre-existing day rows, 8h/day contracted —
 *  same shape for every kind; only `resourceKind` varies per test. */
function allocationFor(kind: ResourceKind): AssignmentAllocation {
  return {
    assignmentId: 'A1',
    contractHoursPerDay: 8,
    resourceKind: kind,
    months: [],
    days: [],
  };
}

const PERIODS: PlanningPeriod[] = [{ id: '2026-09', status: 'Open' }];
const HOLIDAYS: Holiday[] = [];

function setup(
  kind: ResourceKind,
  overrides: Partial<AssignmentAllocation> = {},
  allocationSource?: () => Observable<AssignmentAllocation>,
) {
  const getAssignmentAllocation = vi.fn(() => allocationSource?.() ?? of({ ...allocationFor(kind), ...overrides }));
  const getPlanningPeriods = vi.fn(() => of(PERIODS));
  const getHolidays = vi.fn(() => of(HOLIDAYS));
  const saveAssignmentAllocation = vi.fn((_id: string, month: string, dailyHours: Record<string, number>) =>
    of({
      id: 'A1',
      requestId: 'REQ1',
      resourceId: 'R1',
      assignedHours: Object.values(dailyHours).reduce((sum, hours) => sum + hours, 0),
      status: 'Draft',
      month,
      contractHoursPerDay: 8,
      days: Object.entries(dailyHours)
        .filter(([, hours]) => hours > 0)
        .map(([date, hours], index) => ({ id: `D${index}`, assignmentId: 'A1', date, hours })),
    } satisfies AssignmentAllocationResult),
  );
  const submitAssignmentMonth = vi.fn((_id: string, month: string) =>
    of({
      id: `A1:${month}`,
      assignmentId: 'A1',
      month,
      status: 'Requested',
    } satisfies AssignmentMonth),
  );
  const api = {
    getAssignmentAllocation,
    getPlanningPeriods,
    getHolidays,
    saveAssignmentAllocation,
    submitAssignmentMonth,
  } as unknown as ApiService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    imports: [AllocationCalendarComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });
  const fixture = TestBed.createComponent(AllocationCalendarComponent);
  fixture.componentRef.setInput('assignmentId', 'A1');
  return { fixture, api, getAssignmentAllocation, saveAssignmentAllocation, submitAssignmentMonth };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AllocationCalendarComponent', () => {
  it('shows a retryable error instead of treating a failed load as an empty calendar', async () => {
    const { fixture, getAssignmentAllocation } = setup(
      'internal',
      {},
      () => throwError(() => new Error('network failure')),
    );
    await flush(fixture);

    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain("Couldn't load allocation calendar");
    expect(element.textContent).not.toContain('No months available');

    element.querySelector<HTMLButtonElement>('.command-button')?.click();
    fixture.detectChanges();
    expect(getAssignmentAllocation).toHaveBeenCalledTimes(2);
  });

  it('offers the FTE selector for a dummy', async () => {
    const { fixture } = setup('dummy');
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="fte-select"]')).not.toBeNull();
  });

  it('offers the FTE selector for a subco', async () => {
    const { fixture } = setup('subco');
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="fte-select"]')).not.toBeNull();
  });

  it('hides the FTE selector for an internal resource', async () => {
    const { fixture } = setup('internal');
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="fte-select"]')).toBeNull();
  });

  it('fills every working day with hours = fte × contracted hours', async () => {
    const { fixture } = setup('dummy');
    await flush(fixture);

    fixture.componentInstance.applyFte('2026-09', 2.5);
    fixture.detectChanges();

    // 8 contracted hours × 2.5 FTE = 20h on each working day of the month.
    const edited = fixture.componentInstance.editedHours('2026-09');
    const values = Object.values(edited);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set([20]));
  });

  it('does not flag a multi-FTE dummy booking as over daily capacity', async () => {
    // Carry-forward regression (Task 4 review): the server now accepts up to
    // MULTI_FTE_MAX x the 1-FTE base for dummy/subco, so a legitimate 20h/day
    // (2.5 FTE on an 8h/day base) booking must not be flagged red here.
    const { fixture } = setup('dummy');
    await flush(fixture);

    fixture.componentInstance.applyFte('2026-09', 2.5);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[title="Over daily capacity"]')).toBeNull();
    expect(host.querySelectorAll('.border-critical').length).toBe(0);
  });

  it('does not tint the month total/target red for a multi-FTE dummy booking', async () => {
    // Same root cause as the per-day flag above, one level up: monthTarget()
    // stays the 1-FTE-equivalent base (there is no natural "target" for a
    // placeholder planned at N FTE), so without suppressing the comparison
    // for non-internal kinds, a full month of legitimate 20h/day bookings
    // would still tint the header's total red even though no single day is
    // flagged — mirrors how the approvals dashboard suppresses its band for
    // non-internal rows (AllocationApprovalsComponent.toCellVm).
    const { fixture } = setup('dummy');
    await flush(fixture);

    fixture.componentInstance.applyFte('2026-09', 2.5);
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    const totals = Array.from(host.querySelectorAll('span')).filter(s => s.textContent?.includes(' / ') && s.textContent?.includes('h'));
    expect(totals.length).toBeGreaterThan(0);
    expect(totals.some(s => s.classList.contains('text-critical-text'))).toBe(false);
  });

  it('re-applies the same FTE step after a Clear, because the select snaps back to its placeholder', async () => {
    // The select is a one-shot action, not a bound value. Left showing "2.5 FTE"
    // after a pick, the browser fires no `change` when 2.5 is chosen again, and
    // "Clear, then re-apply 2.5 FTE" silently does nothing.
    const { fixture } = setup('dummy');
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const select = host.querySelector('[data-test="fte-select"]') as HTMLSelectElement;
    expect(select).not.toBeNull();

    const pick = (fte: string) => {
      select.value = fte;
      select.dispatchEvent(new Event('change'));
      fixture.detectChanges();
    };

    pick('2.5');
    expect(new Set(Object.values(fixture.componentInstance.editedHours('2026-09')))).toEqual(new Set([20]));
    // Snapped back, so the next identical pick is a real change event.
    expect(select.value).toBe('');

    fixture.componentInstance['clear']('2026-09');
    fixture.detectChanges();
    expect(new Set(Object.values(fixture.componentInstance.editedHours('2026-09')))).toEqual(new Set([0]));

    pick('2.5');
    expect(new Set(Object.values(fixture.componentInstance.editedHours('2026-09')))).toEqual(new Set([20]));
  });

  it('marks a month that arrived by substitution', async () => {
    const { fixture } = setup('internal', { months: [{ id: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', replacedFromAssignmentMonthId: 'A9:2026-09' }] });
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substituted-month"]')).not.toBeNull();
  });

  it('leaves an ordinary month unmarked', async () => {
    const { fixture } = setup('internal', { months: [{ id: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested' }] });
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="substituted-month"]')).toBeNull();
  });

  it('caps the FTE options at MULTI_FTE_MAX', async () => {
    const { fixture } = setup('dummy');
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const values = Array.from(host.querySelectorAll('[data-test="fte-select"] option'))
      .map(o => (o as HTMLOptionElement).value)
      .filter(v => v !== '');
    expect(values.at(-1)).toBe(String(MULTI_FTE_MAX));
    expect(values.every(v => Number(v) > 0 && Number(v) <= MULTI_FTE_MAX)).toBe(true);
  });

  it('persists dirty daily hours before submitting the month for approval', async () => {
    const { fixture, saveAssignmentAllocation, submitAssignmentMonth } = setup('internal', {
      months: [{ id: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Draft' }],
    });
    await flush(fixture);

    fixture.componentInstance['setHours']('2026-09', '2026-09-01', 6);
    fixture.componentInstance['submitMonth']('2026-09');

    expect(saveAssignmentAllocation).toHaveBeenCalledWith(
      'A1',
      '2026-09',
      expect.objectContaining({ '2026-09-01': 6 }),
    );
    expect(submitAssignmentMonth).toHaveBeenCalledWith('A1', '2026-09', undefined);
    expect(saveAssignmentAllocation.mock.invocationCallOrder[0])
      .toBeLessThan(submitAssignmentMonth.mock.invocationCallOrder[0]);
  });

  it('asks for confirmation instead of closing when daily hours are dirty', async () => {
    const { fixture } = setup('internal');
    await flush(fixture);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);

    fixture.componentInstance['setHours']('2026-09', '2026-09-01', 4);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click();
    fixture.detectChanges();

    expect(closed).not.toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Unsaved changes');
  });
});
