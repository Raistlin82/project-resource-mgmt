import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';
import { Forecast } from './forecast';
import { ApiService, Resource, Assignment, AssignmentDay, AssignmentMonth } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { todayLocalIso } from '../services/local-date.util';

/**
 * `/forecast`'s bench section is now `notFullyAllocatedAt` (bench.util.ts), fed
 * by THIS month's raw day/month data — not the retired `benchList`/`Resource.
 * utilization` heuristic. The fixture below is built against "today"'s actual
 * calendar month (via the same `todayLocalIso()` the component itself calls,
 * un-mockable at the call site) so it stays correct on any run date:
 *   - 'full'    booked 999h this month (>> any standard monthly hours) -> ALLOCATED, excluded
 *   - 'idle'    no booking at all -> BENCH
 *   - 'idle2'   no booking at all -> BENCH (a SECOND idle resource, deliberately —
 *               with exactly one idle + one partial, swapping the idle/partial
 *               filter in `benchIdleCount`/`benchPartialCount` would still produce
 *               "1 idle, 1 partial" and no test would notice; 2-vs-1 makes the
 *               two counts asymmetric so a swapped filter is visibly wrong)
 *   - 'partial' booked 10h this month (> 0, well under standard) -> PARTIAL
 */
const CURRENT_MONTH = todayLocalIso().slice(0, 7);

const RESOURCES: Resource[] = [
  { id: 'full', name: 'Fully Booked', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: 'idle', name: 'Idle Person', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: 'idle2', name: 'Also Idle', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: 'partial', name: 'Partly Booked', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
];
const ASSIGNMENTS: Assignment[] = [
  { id: 'a-full', requestId: 'r-full', resourceId: 'full', assignedHours: 999, status: 'Allocated' },
  { id: 'a-partial', requestId: 'r-partial', resourceId: 'partial', assignedHours: 10, status: 'Allocated' },
];
const ASSIGNMENT_DAYS: AssignmentDay[] = [
  { id: 'd-full', assignmentId: 'a-full', date: `${CURRENT_MONTH}-03`, hours: 999 },
  { id: 'd-partial', assignmentId: 'a-partial', date: `${CURRENT_MONTH}-03`, hours: 10 },
];
const ASSIGNMENT_MONTHS: AssignmentMonth[] = [
  { id: `a-full:${CURRENT_MONTH}`, assignmentId: 'a-full', month: CURRENT_MONTH, status: 'Allocated' },
  { id: `a-partial:${CURRENT_MONTH}`, assignmentId: 'a-partial', month: CURRENT_MONTH, status: 'Allocated' },
];

function apiStub(overrides: Partial<ApiService> = {}): ApiService {
  return {
    getResources: () => of(RESOURCES),
    getRequests: () => of([]),
    getAssignments: () => of(ASSIGNMENTS),
    getAssignmentDays: () => of(ASSIGNMENT_DAYS),
    getAssignmentMonths: () => of(ASSIGNMENT_MONTHS),
    getHolidays: () => of([]),
    getHoursPerDay: () => of({ value: 8 }),
    ...overrides,
  } as unknown as ApiService;
}

async function setup(overrides: Partial<ApiService> = {}, ready = true) {
  TestBed.configureTestingModule({
    imports: [Forecast],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: apiStub(overrides) },
      { provide: AuthService, useValue: { authReady: signal(ready) } },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(Forecast);
  return fixture;
}

async function flush(fixture: ComponentFixture<Forecast>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function host(fixture: ComponentFixture<Forecast>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

describe('Forecast — bench retargeted onto bench.util (retired benchList/BenchEntry)', () => {
  it('excludes the fully-booked resource, includes the idle and partial ones, and splits idle vs partial correctly', async () => {
    const fixture = await setup();
    await flush(fixture);

    const c = fixture.componentInstance;
    // Presence: idle + partial both surface.
    expect(c.bench().some(r => r.resourceId === 'idle')).toBe(true);
    expect(c.bench().some(r => r.resourceId === 'partial')).toBe(true);
    // Absence: the ALLOCATED resource must NOT appear — this is the whole point
    // of switching off `Resource.utilization` (a scalar that can't tell "booked
    // this month" from "booked at all") onto the monthly bench.util classifier.
    expect(c.bench().some(r => r.resourceId === 'full')).toBe(false);

    expect(c.benchCount()).toBe(3);
    // 2 idle vs 1 partial — DELIBERATELY asymmetric (see the fixture comment):
    // a filter swapped between the two buckets changes both numbers, so this
    // pair can't both stay green under that mutation the way a symmetric
    // 1-vs-1 fixture would.
    expect(c.benchIdleCount()).toBe(2);
    expect(c.benchPartialCount()).toBe(1);

    const text = host(fixture).textContent ?? '';
    expect(text).toContain('Idle Person');
    expect(text).toContain('Also Idle');
    expect(text).toContain('Partly Booked');
    expect(text).not.toContain('Fully Booked');
  });

  it('fetches through the four new raw endpoints (assignment-days, assignment-months, holidays, hours-per-day) the bench figure depends on', async () => {
    const getAssignmentDays = vi.fn(() => of(ASSIGNMENT_DAYS));
    const getAssignmentMonths = vi.fn(() => of(ASSIGNMENT_MONTHS));
    const getHolidays = vi.fn(() => of([]));
    const getHoursPerDay = vi.fn(() => of({ value: 8 }));
    const fixture = await setup({ getAssignmentDays, getAssignmentMonths, getHolidays, getHoursPerDay });
    await flush(fixture);

    expect(getAssignmentDays).toHaveBeenCalled();
    expect(getAssignmentMonths).toHaveBeenCalled();
    expect(getHolidays).toHaveBeenCalled();
    expect(getHoursPerDay).toHaveBeenCalled();
  });

  it('renders the retired BenchEntry shape nowhere: no Role/Util %/Available column, only Kind/Status', async () => {
    const fixture = await setup();
    await flush(fixture);

    // Scoped to the Bench card specifically — an earlier version of this test
    // queried '.command-card th' unscoped, which also collects the untouched
    // Skill Gap table's own <th>Status</th> (forecast.ts's Skill Gap section).
    // Both tables render a "Status" header, so an unscoped query passes even
    // if the Bench table's own Status column is deleted outright: the
    // assertion would still be satisfied by Skill Gap's. Scoping to the card
    // whose <h2> reads "Bench" makes the check actually about Bench.
    const benchSection = Array.from(host(fixture).querySelectorAll('.command-card'))
      .find(card => card.querySelector('h2')?.textContent?.trim() === 'Bench');
    expect(benchSection).toBeTruthy();
    const headers = Array.from(benchSection!.querySelectorAll('th')).map(th => th.textContent?.trim());
    expect(headers).toEqual(['Resource', 'Kind', 'Status']);
    // Paired absence: the retired BenchEntry-shaped columns must be gone from
    // THIS table (redundant with the exact toEqual above, kept explicit).
    expect(headers).not.toContain('Available');
    expect(headers).not.toContain('Role');
  });
});

describe('Forecast — failed read renders as an error state, never a confident empty/zero', () => {
  it('shows a retry affordance instead of the empty-state copy when the read fails', async () => {
    const fixture = await setup({ getResources: () => throwError(() => new Error('boom')) as unknown as Observable<Resource[]> });
    await flush(fixture);

    // The shared ListStateComponent (app-list-state) renders its error panel
    // with role="alert" — the accessible signal a screen-reader announces,
    // which the previous hand-rolled card did not carry.
    const alert = host(fixture).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't load forecast data");
    // Absence: the ordinary "no forecast data yet" empty copy must NOT also render —
    // an error must never be presented as a benign "nothing here" state.
    expect(host(fixture).textContent).not.toContain('No forecast data yet');
    expect(alert?.querySelector('button')).toBeTruthy();
  });

  it('the retry button actually calls reload — a dead button would leave a user stuck on a failed read forever', async () => {
    const getResources = vi.fn(() => throwError(() => new Error('boom')) as unknown as Observable<Resource[]>);
    const fixture = await setup({ getResources });
    await flush(fixture);
    const callsBeforeRetry = getResources.mock.calls.length;

    const retryButton = host(fixture).querySelector('[role="alert"] button') as HTMLButtonElement;
    retryButton.click();
    await flush(fixture);

    expect(getResources.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
  });
});

describe('Forecast — authReady gating', () => {
  it('does not fetch and shows no bench rows until auth settles', async () => {
    const getResources = vi.fn(() => of(RESOURCES));
    const fixture = await setup({ getResources }, false);
    await flush(fixture);

    expect(getResources).not.toHaveBeenCalled();
    expect(fixture.componentInstance.bench()).toEqual([]);
  });
});
