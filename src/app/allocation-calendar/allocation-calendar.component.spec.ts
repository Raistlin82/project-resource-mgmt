import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AllocationCalendarComponent } from './allocation-calendar.component';
import { ApiService, AssignmentAllocation, Holiday, PlanningPeriod } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import type { ResourceKind } from '../services/resource-kind.util';

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

function setup(kind: ResourceKind) {
  const getAssignmentAllocation = vi.fn(() => of(allocationFor(kind)));
  const getPlanningPeriods = vi.fn(() => of(PERIODS));
  const getHolidays = vi.fn(() => of(HOLIDAYS));
  const api = {
    getAssignmentAllocation,
    getPlanningPeriods,
    getHolidays,
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
  return { fixture, api };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AllocationCalendarComponent', () => {
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
});
