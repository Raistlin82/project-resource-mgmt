import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { BenchComponent } from './bench.component';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import type { BenchRollup } from '../services/bench.util';

const ROLLUP: BenchRollup = {
  months: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
  internalRows: [
    {
      resourceId: '7', resourceName: 'Priya Kapoor', kind: 'internal',
      monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: false } },
      availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' },
    },
  ],
  subcoRows: [
    {
      resourceId: '6', resourceName: 'Subco — Mediolanum Senior Developer', kind: 'subco',
      monthly: { '2026-04': { state: 'PARTIAL', upcomingUnallocated: true } },
      availabilityDate: { kind: 'date', date: '2026-05-01' },
    },
  ],
  hiringDemand: [{ month: '2026-04', role: 'Developer', hours: 176 }],
};

/**
 * Distinct, non-round counts for BOTH sections so a swapped numerator/
 * denominator, a wrong state comparison, or a section mix-up all produce a
 * visibly different figure rather than accidentally matching by coincidence
 * (both round-tripping to the same 50%, say). Internal: 2 of 4 -> 50%.
 * Subcontractors: 1 of 3 -> 33% (rounded).
 */
const COUNTS_ROLLUP: BenchRollup = {
  months: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
  internalRows: [
    { resourceId: 'i1', resourceName: 'Internal Bench One', kind: 'internal', monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
    { resourceId: 'i2', resourceName: 'Internal Bench Two', kind: 'internal', monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
    { resourceId: 'i3', resourceName: 'Internal Partial', kind: 'internal', monthly: { '2026-04': { state: 'PARTIAL', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
    { resourceId: 'i4', resourceName: 'Internal Allocated', kind: 'internal', monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' } },
  ],
  subcoRows: [
    { resourceId: 's1', resourceName: 'Subco Bench One', kind: 'subco', monthly: { '2026-04': { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
    { resourceId: 's2', resourceName: 'Subco Allocated One', kind: 'subco', monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' } },
    { resourceId: 's3', resourceName: 'Subco Allocated Two', kind: 'subco', monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' } },
  ],
  hiringDemand: [],
};

/**
 * Neither row has a cell for the CURRENT month ('2026-04', `months[0]`) — both
 * are active only from '2026-05' — so the `> 0 ? ... : 0` zero-denominator
 * guard on both `internalBenchPct`/`subcoBenchPct` is the only thing standing
 * between this fixture and a `NaN%`/`Infinity%` render.
 */
const ZERO_DENOM_ROLLUP: BenchRollup = {
  months: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
  internalRows: [
    { resourceId: 'i9', resourceName: 'Not Yet Active Internal', kind: 'internal', monthly: { '2026-05': { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
  ],
  subcoRows: [
    { resourceId: 's9', resourceName: 'Not Yet Active Subco', kind: 'subco', monthly: { '2026-05': { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
  ],
  hiringDemand: [],
};

async function setupWith(rollup: BenchRollup, authReady = true, holidayIds: string[] = []) {
  // Reset first so ONE test can render the same component twice under different
  // providers — the holiday-threading cases below compare two renders, and
  // configureTestingModule throws once the module has been instantiated.
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [BenchComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: {
        getBenchMonthly: () => of(rollup),
        getHoursPerDay: () => of({ value: 8 }),
        getHolidays: () => of(holidayIds.map(id => ({ id, name: id }))),
      } },
      { provide: AuthService, useValue: { authReady: () => authReady } },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(BenchComponent);
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();
  return fixture;
}

describe('BenchComponent', () => {
  async function setup() {
    return setupWith(ROLLUP);
  }

  it('renders the subco row in the Subcontractors section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="subco-section"]')!.textContent ?? '';
    expect(text).toContain('Subco — Mediolanum Senior Developer');
  });
  it('does NOT render the subco row in the Internal section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="internal-section"]')!.textContent ?? '';
    expect(text).not.toContain('Subco — Mediolanum Senior Developer');
  });
  it('renders the internal row in the Internal section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="internal-section"]')!.textContent ?? '';
    expect(text).toContain('Priya Kapoor');
  });
  it('does NOT render the internal row in the Subcontractors section', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="subco-section"]')!.textContent ?? '';
    expect(text).not.toContain('Priya Kapoor');
  });

  // 44h / (22 working days * 8h/day = 176h target for 2026-04) = 0.25 FTE
  // exactly — deliberately NOT an exact multiple of the standard hours, so the
  // assertion is meaningful under '1.0-2' (a value of exactly 1.0 would render
  // as "1", not "1.00", under minFractionDigits=0 — see Minor 4 of round 1).
  // Pinned to the specific FTE cell rather than the whole hiring-demand block.
  it('renders the hiring-demand FTE at up to 2 decimals, pinned to the FTE cell', async () => {
    const rollup: BenchRollup = { ...ROLLUP, hiringDemand: [{ month: '2026-04', role: 'Developer', hours: 44 }] };
    const fixture = await setupWith(rollup);
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="hiring-demand"]')!;
    const row = Array.from(section.querySelectorAll('tbody tr')).find(tr => (tr.textContent ?? '').includes('Developer'));
    expect(row).toBeTruthy();
    const fteCell = row!.querySelectorAll('td')[2];
    expect(fteCell.textContent?.trim()).toBe('0.25');
  });

  /**
   * `getHolidays: () => of([])` used to be the ONLY holiday input this file ever
   * supplied, which made `fteFor`'s third argument inert here: dropping the
   * `holSet` from `standardMonthlyHours(month, hoursPerDay, holSet)`
   * (bench.component.ts) left this whole suite green while every Hiring Demand FTE
   * was computed against a month that never closes for a public holiday. That is
   * the third hop of the same threading (bench.util.spec.ts owns the two inside
   * `benchRollup`), and it is the one that renders.
   *
   * April 2026 arithmetic, verified: 22 working days = 176h at 8h/day; 2026-04-06
   * is a MONDAY (a real working day) and 2026-04-05 a SUNDAY (already excluded).
   * 168 booked hours therefore read 168/176 = 0.95 FTE with no holiday and
   * 168/168 = 1 FTE once the Monday is closed.
   */
  const HIRING_168: BenchRollup = { ...ROLLUP, hiringDemand: [{ month: '2026-04', role: 'Developer', hours: 168 }] };

  function hiringFteText(fixture: Awaited<ReturnType<typeof setupWith>>): string {
    const section = (fixture.nativeElement as HTMLElement).querySelector('[data-test="hiring-demand"]')!;
    const row = Array.from(section.querySelectorAll('tbody tr')).find(tr => (tr.textContent ?? '').includes('Developer'));
    return row!.querySelectorAll('td')[2].textContent?.trim() ?? '';
  }

  it('threads the loaded holidays into the hiring-demand FTE denominator: a working-day holiday raises the figure', async () => {
    expect(hiringFteText(await setupWith(HIRING_168, true, []))).toBe('0.95');
    expect(hiringFteText(await setupWith(HIRING_168, true, ['2026-04-06']))).toBe('1');
    // ABSENCE TWIN: 0.95 is exactly what a dropped holiday set produces — the
    // company closed a day and the placeholder's demand still read as under one FTE.
    expect(hiringFteText(await setupWith(HIRING_168, true, ['2026-04-06']))).not.toBe('0.95');
  });

  it('a holiday falling on a Sunday leaves the hiring-demand FTE untouched (so the case above is about the CALENDAR, not the list length)', async () => {
    expect(hiringFteText(await setupWith(HIRING_168, true, ['2026-04-05']))).toBe('0.95');
    expect(hiringFteText(await setupWith(HIRING_168, true, ['2026-04-05']))).not.toBe('1');
  });

  // Design spec: a resource can legitimately show "Beyond <month>" (never bench
  // within the 6 SHOWN months) while ALSO being flagged "freeing up next
  // month" (the look-ahead 7th month, outside the display window, goes bench).
  // The two fields have deliberately different data scopes and must never be
  // presented as mutually exclusive, nor may one silently suppress the other.
  it('shows "Beyond <month>" together with "Freeing up next month" for the same resource, and only for the flagged one', async () => {
    const rollup: BenchRollup = {
      months: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
      internalRows: [
        {
          // Flagged: about to free up next month, yet never bench within the
          // 6-month window shown -> availabilityDate is beyond-horizon.
          resourceId: '7', resourceName: 'Freeing Soon Person', kind: 'internal',
          monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: true } },
          availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' },
        },
        {
          // Control row: same beyond-horizon availability, but NOT flagged —
          // isolates that the flag is per-row, not a side effect of the
          // availability kind.
          resourceId: '77', resourceName: 'Steady Person', kind: 'internal',
          monthly: { '2026-04': { state: 'ALLOCATED', upcomingUnallocated: false } },
          availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: '2026-09' },
        },
      ],
      subcoRows: [],
      hiringDemand: [],
    };
    const fixture = await setupWith(rollup);
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="internal-section"]')!;
    const rows = Array.from(section.querySelectorAll('tbody tr'));
    const flaggedRow = rows.find(tr => (tr.textContent ?? '').includes('Freeing Soon Person'));
    const steadyRow = rows.find(tr => (tr.textContent ?? '').includes('Steady Person'));
    expect(flaggedRow).toBeTruthy();
    expect(steadyRow).toBeTruthy();

    const flaggedText = flaggedRow!.textContent ?? '';
    expect(flaggedText).toContain('Beyond');
    expect(flaggedText).toContain('Freeing up next month');

    const steadyText = steadyRow!.textContent ?? '';
    expect(steadyText).toContain('Beyond');
    expect(steadyText).not.toContain('Freeing up next month');
  });

  // authReady pattern (CLAUDE.md): before OIDC bootstrap settles, the bench
  // read must present as LOADING, never as a resolved "nobody on the bench"
  // empty state — an empty bench reads as good news, so a pre-auth zero would
  // be an unverified claim rendered as fact.
  it('shows the loading state (not the resolved rollup) while auth is not ready yet', async () => {
    const fixture = await setupWith(ROLLUP, false);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[role="status"][aria-busy="true"]')).toBeTruthy();
    expect(host.querySelector('[data-test="internal-section"]')).toBeNull();
    expect(host.textContent ?? '').not.toContain('Priya Kapoor');
  });

  // Round-1 review, Important 1: the two "% on bench" figures (section
  // headers) had no coverage at all. Distinct, non-round numbers for each
  // section so a swapped numerator/denominator, a wrong state comparison
  // (e.g. matching 'PARTIAL' instead of 'BENCH'), or a section mix-up each
  // produce a visibly wrong figure — paired with the absence of the OTHER
  // section's figure so a cross-section swap is also caught.
  it('renders the Internal bench count and percentage — not swapped, not the Subcontractors figures', async () => {
    const fixture = await setupWith(COUNTS_ROLLUP);
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="internal-section"] .command-card-header')!.textContent ?? '';
    expect(text).toContain('2 on bench');
    expect(text).toContain('50% of active');
    expect(text).not.toContain('1 on bench');
    expect(text).not.toContain('33% of active');
  });
  it('renders the Subcontractors bench count and percentage — not swapped, not the Internal figures', async () => {
    const fixture = await setupWith(COUNTS_ROLLUP);
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="subco-section"] .command-card-header')!.textContent ?? '';
    expect(text).toContain('1 on bench');
    expect(text).toContain('33% of active');
    expect(text).not.toContain('2 on bench');
    expect(text).not.toContain('50% of active');
  });
  it('renders 0% (never NaN%/Infinity%) when no row is active in the current month, for both sections', async () => {
    const fixture = await setupWith(ZERO_DENOM_ROLLUP);
    const host = fixture.nativeElement as HTMLElement;
    const internalText = host.querySelector('[data-test="internal-section"] .command-card-header')!.textContent ?? '';
    const subcoText = host.querySelector('[data-test="subco-section"] .command-card-header')!.textContent ?? '';
    expect(internalText).toContain('0 on bench');
    expect(internalText).toContain('0% of active');
    expect(internalText).not.toContain('NaN');
    expect(internalText).not.toContain('Infinity');
    expect(subcoText).toContain('0 on bench');
    expect(subcoText).toContain('0% of active');
    expect(subcoText).not.toContain('NaN');
    expect(subcoText).not.toContain('Infinity');
  });

  // Round-1 review, Important 2: on a bench page, a broken `hasError` is worse
  // than blank — because the content sits inside <app-list-state>'s
  // <ng-template>, a broken gate falls through to the CONTENT branch and
  // renders EMPTY_BENCH_ROLLUP's "no resources" copy on a genuine fetch
  // failure. Presence of the accessible error affordance is paired with the
  // absence of the empty-state copy it would otherwise be confused for.
  it('shows the error affordance — never the empty-rollup "no resources" copy — when the read fails', async () => {
    await TestBed.configureTestingModule({
      imports: [BenchComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: {
          getBenchMonthly: () => throwError(() => new Error('boom')),
          getHoursPerDay: () => of({ value: 8 }),
          getHolidays: () => of([]),
        } },
        { provide: AuthService, useValue: { authReady: () => true } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(BenchComponent);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    const alert = host.querySelector('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(alert?.textContent).toContain("Couldn't load bench data");

    expect(host.textContent ?? '').not.toContain('No internal resources in the shown window.');
    expect(host.textContent ?? '').not.toContain('No subcontractors in the shown window.');
    expect(host.querySelector('[data-test="internal-section"]')).toBeNull();
  });

  // Round-1 review, Important 3a: agingSuffix()'s non-empty branch was never
  // rendered by any fixture — only the pure bucket computation in
  // bench.util.spec.ts was covered, not this component's use of it.
  it('renders the aging-bucket suffix on a BENCH status (e.g. "BENCH (B)")', async () => {
    const rollup: BenchRollup = {
      months: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'],
      internalRows: [
        {
          resourceId: 'agingA', resourceName: 'Aging Bench Person', kind: 'internal',
          monthly: { '2026-04': { state: 'BENCH', agingBucket: 'B', upcomingUnallocated: false } },
          availabilityDate: { kind: 'date', date: '2026-08-05' },
        },
      ],
      subcoRows: [],
      hiringDemand: [],
    };
    const fixture = await setupWith(rollup);
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="internal-section"]')!;
    const row = Array.from(section.querySelectorAll('tbody tr')).find(tr => (tr.textContent ?? '').includes('Aging Bench Person'));
    expect(row).toBeTruthy();
    const statusCell = row!.querySelector('td:nth-child(2) .command-status');
    expect(statusCell?.textContent?.trim()).toBe('BENCH (B)');
  });

  // Round-1 review, Important 3b: availabilityLabel()'s 'date' branch — the
  // COMMON case — had no assertion on its rendered text, only the rarer
  // 'beyond-horizon' branch did. Asserts the exact string, TZ-safe: this repo
  // already shipped a timezone-formatting defect in this area (commit
  // 7d86d94, "TZ-consistent fixture"); the component forces `timeZone: 'UTC'`
  // in its formatter, so this must hold regardless of the machine running the
  // test (this environment's local zone is Europe/Rome, not UTC).
  it('renders the "date" availability branch as a formatted date, pinned to the exact string', async () => {
    const fixture = await setup(); // ROLLUP's subco row carries { kind: 'date', date: '2026-05-01' }.
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="subco-section"]')!;
    const row = Array.from(section.querySelectorAll('tbody tr')).find(tr => (tr.textContent ?? '').includes('Subco — Mediolanum Senior Developer'));
    expect(row).toBeTruthy();
    const availableCell = row!.querySelectorAll('td')[3];
    expect(availableCell.textContent?.trim()).toBe('May 1, 2026');
  });
});
