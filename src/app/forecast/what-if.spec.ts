import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { WhatIf } from './what-if';
import { ApiService, Resource, ResourceRequest } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { todayLocalIso } from '../services/local-date.util';

/**
 * A single ALLOCATED resource this month, booked well beyond any standard
 * monthly hours — so the BASE scenario starts with bench count 0. This lets
 * `hire()`'s effect on the SCENARIO be unambiguous: any bench row that shows
 * up afterward can only be the newly-hired, unbooked resource.
 *
 * `todayLocalIso()` — NOT `new Date().toISOString()` — matching what-if.ts's
 * own `currentMonth` (local time). In a timezone ahead of UTC (this repo's
 * commits are +0200), a UTC-derived month tag can name a different month than
 * the component computes near the end of the UTC day, a date-dependent flake.
 */
const CURRENT_MONTH = todayLocalIso().slice(0, 7);
const RESOURCES: Resource[] = [
  { id: 'booked', name: 'Fully Booked', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
];

function apiStub(overrides: Partial<ApiService> = {}): ApiService {
  return {
    getResources: () => of(RESOURCES),
    getRequests: () => of([]),
    getAssignments: () => of([{ id: 'a1', requestId: 'r1', resourceId: 'booked', assignedHours: 999, status: 'Allocated' }]),
    getAssignmentDays: () => of([{ id: 'd1', assignmentId: 'a1', date: `${CURRENT_MONTH}-03`, hours: 999 }]),
    getAssignmentMonths: () => of([{ id: `a1:${CURRENT_MONTH}`, assignmentId: 'a1', month: CURRENT_MONTH, status: 'Allocated' }]),
    getHolidays: () => of([]),
    getHoursPerDay: () => of({ value: 8 }),
    getProjects: () => of([]),
    ...overrides,
  } as unknown as ApiService;
}

async function setup(overrides: Partial<ApiService> = {}, ready = true) {
  TestBed.configureTestingModule({
    imports: [WhatIf],
    providers: [
      { provide: ApiService, useValue: apiStub(overrides) },
      { provide: AuthService, useValue: { authReady: signal(ready) } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(WhatIf);
  return fixture;
}

async function flush(fixture: ComponentFixture<WhatIf>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function host(fixture: ComponentFixture<WhatIf>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function onBenchKpi(fixture: ComponentFixture<WhatIf>) {
  return fixture.componentInstance.kpis().find(k => k.label === 'On Bench')!;
}

describe('WhatIf — bench retargeted onto bench.util, and the sandbox must actually simulate', () => {
  it('base and scenario start equal (bench 0): the single ALLOCATED resource is excluded on both sides', async () => {
    const fixture = await setup();
    await flush(fixture);

    const bench = onBenchKpi(fixture);
    expect(bench.base).toBe(0);
    expect(bench.scenario).toBe(0);
  });

  it('hire() with no bookings makes the SCENARIO bench count grow while BASE stays untouched — the actual simulation guarantee', async () => {
    const fixture = await setup();
    await flush(fixture);
    const c = fixture.componentInstance;

    const before = onBenchKpi(fixture);
    expect(before.scenario).toBe(0);

    c.hireForm.setValue({ role: 'Developer', count: 2, capacity: 40, skill: '' });
    c.hire();
    fixture.detectChanges();

    const after = onBenchKpi(fixture);
    // Presence: the scenario actually moved.
    expect(after.scenario).toBe(2);
    // Absence: the BASE is immutable — a shared-reference bug would have
    // leaked the same 2 into base too.
    expect(after.base).toBe(0);
    expect(after.delta).toBe(2);
  });

  it('a "Win deal" (pipeline demand, not a hire) leaves the scenario bench count unchanged — isolates hire() as the ONLY lever bench reacts to here', async () => {
    const fixture = await setup();
    await flush(fixture);
    const c = fixture.componentInstance;

    c.dealForm.setValue({
      requiredRole: 'Developer', requiredEffort: 100, skills: '',
      startDate: '2026-09-01', endDate: '2026-09-30',
    });
    c.winDeal();
    fixture.detectChanges();

    const bench = onBenchKpi(fixture);
    expect(bench.scenario).toBe(0);
    expect(bench.base).toBe(0);
  });

  it('resetScenario() discards the hire and the scenario bench count returns to matching base', async () => {
    const fixture = await setup();
    await flush(fixture);
    const c = fixture.componentInstance;

    c.hireForm.setValue({ role: 'Developer', count: 1, capacity: 40, skill: '' });
    c.hire();
    fixture.detectChanges();
    expect(onBenchKpi(fixture).scenario).toBe(1);

    c.resetScenario();
    fixture.detectChanges();
    expect(onBenchKpi(fixture).scenario).toBe(0);
  });

  it('fetches through the four new raw endpoints the bench figure depends on', async () => {
    const getAssignmentDays = vi.fn(() => of([{ id: 'd1', assignmentId: 'a1', date: `${CURRENT_MONTH}-03`, hours: 999 }]));
    const getAssignmentMonths = vi.fn(() => of([{ id: `a1:${CURRENT_MONTH}`, assignmentId: 'a1', month: CURRENT_MONTH, status: 'Allocated' as const }]));
    const getHolidays = vi.fn(() => of([]));
    const getHoursPerDay = vi.fn(() => of({ value: 8 }));
    const fixture = await setup({ getAssignmentDays, getAssignmentMonths, getHolidays, getHoursPerDay });
    await flush(fixture);

    expect(getAssignmentDays).toHaveBeenCalled();
    expect(getAssignmentMonths).toHaveBeenCalled();
    expect(getHolidays).toHaveBeenCalled();
    expect(getHoursPerDay).toHaveBeenCalled();
  });
});

describe('WhatIf — failed read renders as an error state, never a confident empty/zero', () => {
  it('shows a retry affordance instead of the empty-state copy when the read fails', async () => {
    const fixture = await setup({ getResources: () => throwError(() => new Error('boom')) as unknown as Observable<Resource[]> });
    await flush(fixture);

    // The shared ListStateComponent (app-list-state) renders its error panel
    // with role="alert" — the accessible signal the previous hand-rolled card
    // (no role, no icon) did not carry.
    const alert = host(fixture).querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain("Couldn't load what-if data");
    expect(host(fixture).textContent).not.toContain('No capacity data yet');
    expect(alert?.querySelector('button')).toBeTruthy();
  });

  it('the retry button actually calls reload', async () => {
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

describe('WhatIf — authReady gating', () => {
  it('does not fetch until auth settles', async () => {
    const getResources = vi.fn(() => of(RESOURCES));
    const fixture = await setup({ getResources }, false);
    await flush(fixture);

    expect(getResources).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Utilisation band + "no capacity" handling.
//
// /what-if and /forecast used to hand-roll ONE ladder EACH (<85 green, 85-100
// amber, >100 red here), so the sandbox's own per-week pills contradicted the
// tone its Avg Utilization card gave the same figure, and both contradicted
// /forecast. Both screens now go through `forecastUtilizationBand`.
//
// Windows are expressed as offsets from `todayLocalIso()` — the same clock the
// component reads and which cannot be injected here — so nothing depends on the
// run date or the CI time zone.
// =============================================================================

const TODAY = todayLocalIso();
/** The fixed comparison horizon of this screen, in weeks (what-if.ts HORIZON_WEEKS). */
const HORIZON_WEEKS = 12;

function isoPlusDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One resource and one open request spanning the whole 12-week horizon, so every
 * period carries exactly `effort / 12` hours and utilisation is an exact figure.
 */
function evenDemand(capacity: number, effort: number, employment: Partial<Resource> = {}): Partial<ApiService> {
  const resources: Resource[] = [
    { id: 'r1', name: 'Solo Dev', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity, kind: 'internal', ...employment },
  ];
  const requests: ResourceRequest[] = [
    { id: 'req1', name: 'Steady demand', requiredRole: 'Developer', requiredEffort: effort, status: 'Open', skills: [], startDate: TODAY, endDate: isoPlusDays(TODAY, HORIZON_WEEKS * 7) },
  ];
  return {
    getResources: () => of(resources),
    getRequests: () => of(requests),
    getAssignments: () => of([]),
    getAssignmentDays: () => of([]),
    getAssignmentMonths: () => of([]),
  } as Partial<ApiService>;
}

function kpiTile(fixture: ComponentFixture<WhatIf>, label: string): HTMLElement {
  const tile = Array.from(host(fixture).querySelectorAll<HTMLElement>('.command-kpi')).find(
    el => el.querySelector('.command-kpi-label')?.textContent?.trim() === label,
  );
  expect(tile, `KPI tile not found: ${label}`).toBeTruthy();
  return tile!;
}

/** The Util % pills of the Scenario Capacity Timeline, in row order. */
function utilPills(fixture: ComponentFixture<WhatIf>): HTMLElement[] {
  const section = Array.from(host(fixture).querySelectorAll('.command-card')).find(
    card => card.querySelector('h2')?.textContent?.trim() === 'Scenario Capacity Timeline',
  );
  expect(section, 'scenario timeline not found').toBeTruthy();
  return Array.from(section!.querySelectorAll<HTMLElement>('tbody tr td:nth-child(4) .command-status'));
}

describe('WhatIf — the scenario timeline paints utilisation with the SAME band as /forecast', () => {
  it('does not paint a 45% week with the healthy tone', async () => {
    // 540h over 12 weeks = 45h/week against 100h/week of supply.
    const fixture = await setup(evenDemand(100, 540));
    await flush(fixture);

    const pills = utilPills(fixture);
    expect(pills.length).toBe(HORIZON_WEEKS);
    expect(pills.every(p => p.textContent?.trim() === '45%')).toBe(true);
    // ABSENCE: green here is what let the sandbox call a 45% week healthy in the
    // table while its own Avg Utilization card scored the move as bad.
    expect(pills.some(p => p.classList.contains('green'))).toBe(false);
    expect(pills.every(p => p.classList.contains('amber'))).toBe(true);
  });

  it('still paints a fully-sold 90% week as healthy — the paired positive', async () => {
    // 1080h over 12 weeks = 90h/week against 100h/week of supply.
    const fixture = await setup(evenDemand(100, 1080));
    await flush(fixture);

    const pills = utilPills(fixture);
    expect(pills.every(p => p.textContent?.trim() === '90%')).toBe(true);
    // 90% used to render amber here (the old >=85 "tight" rung), so neither
    // "delete green" nor "paint everything amber" satisfies both halves.
    expect(pills.every(p => p.classList.contains('green'))).toBe(true);
    expect(pills.some(p => p.classList.contains('amber'))).toBe(false);
  });
});

describe('WhatIf — an unmeasurable average renders as n/a, never as 0%', () => {
  it('shows n/a with no tone for base, scenario and delta when no period has capacity', async () => {
    // The only resource joins long after the horizon ends: there is no supply to
    // measure against in any of the 12 weeks.
    const fixture = await setup(evenDemand(100, 540, { hireDate: isoPlusDays(TODAY, 365) }));
    await flush(fixture);

    const k = fixture.componentInstance.kpis().find(x => x.label === 'Avg Utilization')!;
    expect(k.base).toBeNull();
    expect(k.scenario).toBeNull();
    // A signed delta out of two unknowns would be pure invention.
    expect(k.delta).toBeNull();

    const tile = kpiTile(fixture, 'Avg Utilization');
    expect(tile.querySelector('.command-kpi-value')?.textContent?.trim()).toBe('n/a');
    expect(tile.querySelector('.command-kpi-value')?.textContent?.trim()).not.toBe('0%');
    // No tone: colouring a comparison that was never possible is the same defect
    // as the header badge that used to affirm parity it could not know.
    expect(tile.classList.contains('green')).toBe(false);
    expect(tile.classList.contains('danger')).toBe(false);

    const pills = utilPills(fixture);
    expect(pills.length).toBe(HORIZON_WEEKS);
    // Exact text, not toContain: '0%' is a substring of '100%'.
    expect(pills.every(p => p.textContent?.trim() === 'n/a')).toBe(true);
    expect(pills.some(p => p.textContent?.trim() === '0%')).toBe(false);
  });

  it('still reports a real 0% when the capacity exists and nothing is booked — the paired positive', async () => {
    const fixture = await setup(evenDemand(100, 0));
    await flush(fixture);

    const k = fixture.componentInstance.kpis().find(x => x.label === 'Avg Utilization')!;
    expect(k.scenario).toBe(0);
    expect(kpiTile(fixture, 'Avg Utilization').querySelector('.command-kpi-value')?.textContent?.trim()).toBe('0%');
    expect(utilPills(fixture).every(p => p.textContent?.trim() === '0%')).toBe(true);
  });
});

/**
 * CRITICAL (round 1 review): the header's scenario badge/Reset button sit
 * OUTSIDE the body's loading/error gate, so they used to render unconditionally.
 * With `baseData()` falling back to an empty stand-in on a failed read,
 * `dirty()` compared 0-vs-0 and read false, showing a green "Matches baseline"
 * badge directly above the "Couldn't load" retry card — parity AFFIRMED as fact
 * when parity is actually UNKNOWN (no baseline ever loaded). Fixed by gating the
 * header on `dataState()`, the same tri-state the body uses.
 */
describe('WhatIf — the header badge/Reset must never claim parity it cannot know (CRITICAL fix)', () => {
  function headerText(fixture: ComponentFixture<WhatIf>): string {
    return (fixture.nativeElement as HTMLElement).querySelector('header')?.textContent ?? '';
  }
  function resetButton(fixture: ComponentFixture<WhatIf>): HTMLButtonElement {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('header button'))
      .find(b => b.textContent?.includes('Reset scenario')) as HTMLButtonElement;
  }

  it('on a failed read, shows "Unavailable" — NOT the green "Matches baseline" badge — and disables Reset', async () => {
    const fixture = await setup({ getResources: () => throwError(() => new Error('boom')) as unknown as Observable<Resource[]> });
    await flush(fixture);

    const text = headerText(fixture);
    // Presence: the honest "we don't know" signal.
    expect(text).toContain('Unavailable');
    // Absence: the exact false claim the CRITICAL finding named — this is the
    // assertion a regression of the bug would flip.
    expect(text).not.toContain('Matches baseline');
    expect(resetButton(fixture).disabled).toBe(true);
  });

  it('before authReady settles, the header does not claim "Matches baseline" either — !authReady() must count as loading, not ready-and-empty', async () => {
    const fixture = await setup({}, false);
    await flush(fixture);

    const text = headerText(fixture);
    expect(text).not.toContain('Matches baseline');
    expect(resetButton(fixture).disabled).toBe(true);
  });

  it('once data resolves normally, the header DOES show "Matches baseline" — the paired positive proving the gate does not just hide the badge forever', async () => {
    const fixture = await setup();
    await flush(fixture);

    const text = headerText(fixture);
    expect(text).toContain('Matches baseline');
    expect(text).not.toContain('Unavailable');
  });
});
