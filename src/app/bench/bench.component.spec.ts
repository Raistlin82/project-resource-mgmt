import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NEVER, of, throwError, type Observable } from 'rxjs';
import { BenchComponent } from './bench.component';
import { ApiService, type Resource, type ResourceOrganization } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import type { BenchCell, BenchRollup, BenchRow, UnallocatedHistory } from '../services/bench.util';
import type { XlsxSheet } from '../services/export.util';
import {
  SHEET_UNCHARGEABLE_A, SHEET_UNCHARGEABLE_B, SHEET_UNCHARGEABLE_C, SHEET_UNCHARGEABLE_D,
} from '../services/rpt-xlsx.util';
import { todayLocalIso } from '../services/local-date.util';

/** Stub for the per-resource history read; receives what the component actually asked for. */
type HistoryStub = (resourceId: string, months?: number) => Observable<UnallocatedHistory>;
const NO_HISTORY: HistoryStub = resourceId => of({ resourceId, resourceName: '', cells: [] });

/**
 * Set (or clear) the process time zone. `process.env['TZ']` is honoured by V8 for
 * every subsequent Date operation, so this genuinely relocates the runner's local
 * calendar — the only way to make a local-vs-UTC disagreement deterministic instead
 * of a property of whatever machine happens to run the suite.
 */
function setTz(tz: string | undefined): void {
  if (tz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = tz;
}

/** 'YYYY-MM' `delta` months from `month`, normalising the year. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const zeroBased = y * 12 + (m - 1) + delta;
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

/**
 * The month whose cells the page's present-tense columns describe.
 *
 * Every fixture below keys its cells on THIS, not on `months[0]`. The window the
 * server sends starts on the oldest OPEN planning period — four months in the past
 * with the shipped seed — and this file used to call that first entry "the CURRENT
 * month", which is precisely the defect: the page read a four-month-old column as
 * the present, so somebody booked solid for the next two months showed "BENCH (D)"
 * and "Available: today".
 */
const NOW_MONTH = todayLocalIso().slice(0, 7);

/**
 * Reproduces the SHAPE of the shipped window: six months of which four are already
 * past, so `months[0]` is never the current month and a regression to it cannot
 * accidentally agree with the fixture.
 */
const WINDOW = [-4, -3, -2, -1, 0, 1].map(d => shiftMonth(NOW_MONTH, d));
const WINDOW_END = WINDOW[WINDOW.length - 1];

const ROLLUP: BenchRollup = {
  months: WINDOW,
  internalRows: [
    {
      resourceId: '7', resourceName: 'Priya Kapoor', kind: 'internal',
      monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false } },
      availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END },
    },
  ],
  subcoRows: [
    {
      resourceId: '6', resourceName: 'Subco — Mediolanum Senior Developer', kind: 'subco',
      monthly: { [NOW_MONTH]: { state: 'PARTIAL', upcomingUnallocated: true } },
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
  months: WINDOW,
  internalRows: [
    { resourceId: 'i1', resourceName: 'Internal Bench One', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
    { resourceId: 'i2', resourceName: 'Internal Bench Two', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
    { resourceId: 'i3', resourceName: 'Internal Partial', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'PARTIAL', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
    { resourceId: 'i4', resourceName: 'Internal Allocated', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END } },
  ],
  subcoRows: [
    { resourceId: 's1', resourceName: 'Subco Bench One', kind: 'subco', monthly: { [NOW_MONTH]: { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
    { resourceId: 's2', resourceName: 'Subco Allocated One', kind: 'subco', monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END } },
    { resourceId: 's3', resourceName: 'Subco Allocated Two', kind: 'subco', monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END } },
  ],
  hiringDemand: [],
};

/**
 * Neither row has a cell for the current month — both are active only from NEXT
 * month — so the `> 0 ? ... : 0` zero-denominator guard on both
 * `internalBenchPct`/`subcoBenchPct` is the only thing standing between this
 * fixture and a `NaN%`/`Infinity%` render.
 */
const ZERO_DENOM_ROLLUP: BenchRollup = {
  months: WINDOW,
  internalRows: [
    { resourceId: 'i9', resourceName: 'Not Yet Active Internal', kind: 'internal', monthly: { [shiftMonth(NOW_MONTH, 1)]: { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
  ],
  subcoRows: [
    { resourceId: 's9', resourceName: 'Not Yet Active Subco', kind: 'subco', monthly: { [shiftMonth(NOW_MONTH, 1)]: { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-05-01' } },
  ],
  hiringDemand: [],
};

/**
 * The join data the Unchargeable export needs — job role, org structure, skills and
 * day rates — which the bench rollup deliberately does not carry. Loaded by the
 * component in its OWN gated resource, so every stub here must answer both reads.
 */
const EXPORT_RESOURCES: Resource[] = [
  {
    id: 'i1', name: 'Internal Bench One', role: 'Developer', organization: 'Backend', managerId: 'm1',
    skills: [{ name: 'Bash', level: 1 }, { name: 'Kubernetes', level: 5 }, { name: 'Java', level: 4 }, { name: 'Terraform', level: 3 }],
    projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, costRateDay: 640, billRateDay: 1200,
  },
  {
    id: 'm1', name: 'Marta Manager', role: 'Manager', organization: 'Engineering',
    skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40,
  },
];

const EXPORT_ORGS: ResourceOrganization[] = [
  { id: 'O1', name: 'Engineering', description: '', costCenters: [], level: 'capability', managerId: 'm1' },
  { id: 'O2', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: 'O1' },
];

interface SetupOpts {
  authReady?: boolean;
  holidayIds?: string[];
  history?: HistoryStub;
  /** Override the two export-only reads (e.g. to fail one of them). */
  resources?: () => Observable<Resource[]>;
  organizations?: () => Observable<ResourceOrganization[]>;
}

async function setupWith(rollup: BenchRollup, authReady = true, holidayIds: string[] = [], history: HistoryStub = NO_HISTORY, extra: SetupOpts = {}) {
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
        getUnallocatedHistory: history,
        getResources: extra.resources ?? (() => of(EXPORT_RESOURCES)),
        getResourceOrganizations: extra.organizations ?? (() => of(EXPORT_ORGS)),
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
      months: WINDOW,
      internalRows: [
        {
          // Flagged: about to free up next month, yet never bench within the
          // 6-month window shown -> availabilityDate is beyond-horizon.
          resourceId: '7', resourceName: 'Freeing Soon Person', kind: 'internal',
          monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: true } },
          availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END },
        },
        {
          // Control row: same beyond-horizon availability, but NOT flagged —
          // isolates that the flag is per-row, not a side effect of the
          // availability kind.
          resourceId: '77', resourceName: 'Steady Person', kind: 'internal',
          monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false } },
          availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END },
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
          getResources: () => of(EXPORT_RESOURCES),
          getResourceOrganizations: () => of(EXPORT_ORGS),
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
      months: WINDOW,
      internalRows: [
        {
          resourceId: 'agingA', resourceName: 'Aging Bench Person', kind: 'internal',
          monthly: { [NOW_MONTH]: { state: 'BENCH', agingBucket: 'B', upcomingUnallocated: false } },
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
    // Column 4 (0-based), not 3: the "Unallocated" column was inserted between
    // Status and Freeing up. Kept positional rather than switched to a data-test
    // hook so a future column insertion goes red here again instead of quietly
    // asserting a neighbouring cell.
    const availableCell = row!.querySelectorAll('td')[4];
    expect(availableCell.textContent?.trim()).toBe('May 1, 2026');
  });
});

/**
 * The current-month disallocation percentage (RPT comparison row 50).
 *
 * The fixture carries FOUR different answers on purpose. A column that simply
 * printed whatever number it found — or printed nothing at all — passes any suite
 * where every row shares one value, so there is one row per outcome: a real
 * non-trivial share, a share that needs rounding, an honest 0, and no answer at
 * all. The 0 row and the no-answer row are the pair that matters: they look the
 * same to a careless renderer and mean opposite things.
 */
describe('BenchComponent — the current month’s unallocated percentage', () => {
  const PCT_ROLLUP: BenchRollup = {
    months: WINDOW,
    internalRows: [
      // 62.5 is neither 0 nor 100 and is NOT its own complement (37.5 is), so an
      // inverted figure upstream would render visibly differently here.
      { resourceId: 'p1', resourceName: 'Two Thirds Idle', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'PARTIAL', upcomingUnallocated: false, unallocatedPct: 62.5, unallocatedDays: 13.125 } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
      // Needs rounding: must render at most 2 decimals (repo-wide rule).
      { resourceId: 'p2', resourceName: 'Repeating Decimal', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'PARTIAL', upcomingUnallocated: false, unallocatedPct: 33.333333333, unallocatedDays: 7 } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
      // A genuine ZERO: must render "0%", never "n/a" and never blank.
      { resourceId: 'p3', resourceName: 'Fully Allocated', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false, unallocatedPct: 0, unallocatedDays: 0 } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END } },
      // NO answer (no contracted target that month): must render "n/a", never "0%".
      { resourceId: 'p4', resourceName: 'No Contract Hours', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'BENCH', upcomingUnallocated: false } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
    ],
    subcoRows: [],
    hiringDemand: [],
  };

  function pctText(fixture: Awaited<ReturnType<typeof setupWith>>, id: string): string {
    const el = (fixture.nativeElement as HTMLElement).querySelector(`[data-test="unallocated-pct-${id}"]`);
    return el?.textContent?.trim() ?? '';
  }

  it('renders a non-trivial share as a percentage', async () => {
    const fixture = await setupWith(PCT_ROLLUP);
    expect(pctText(fixture, 'p1')).toBe('62.5%');
    // The complement, spelled out: 37.5% is what an inversion would show.
    expect(pctText(fixture, 'p1')).not.toBe('37.5%');
  });

  it('caps the share at 2 decimals (repo-wide number rule)', async () => {
    const fixture = await setupWith(PCT_ROLLUP);
    expect(pctText(fixture, 'p2')).toBe('33.33%');
  });

  // THE PAIR. Without both halves, a column hard-coded to '0%' and a column
  // hard-coded to 'n/a' each pass one of them.
  it('renders an honest 0% for a fully-allocated resource — not "n/a", not blank', async () => {
    const fixture = await setupWith(PCT_ROLLUP);
    expect(pctText(fixture, 'p3')).toBe('0%');
    expect(pctText(fixture, 'p3')).not.toBe('n/a');
    expect(pctText(fixture, 'p3')).not.toBe('');
  });
  it('renders "n/a" — never "0%" — when the rollup has NO share for the month', async () => {
    const fixture = await setupWith(PCT_ROLLUP);
    expect(pctText(fixture, 'p4')).toBe('n/a');
    // The error direction that matters: 0% would claim this person is fully
    // allocated when nothing at all is known about their contracted target.
    expect(pctText(fixture, 'p4')).not.toBe('0%');
    expect(pctText(fixture, 'p4')).not.toContain('0');
  });
});

/**
 * The expandable monthly history (RPT comparison row 51).
 *
 * Four read states are kept apart here, because collapsing any two is the defect
 * this repo keeps re-paying: a failed read must not render as "no tracked months"
 * (which reads as reassuring), and an untracked resource must not render as a table
 * of zeroes.
 */
describe('BenchComponent — the per-resource monthly unallocated history', () => {
  const ROW_ID = 'h1';
  const HISTORY_ROLLUP: BenchRollup = {
    months: WINDOW,
    internalRows: [
      { resourceId: ROW_ID, resourceName: 'History Person', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'PARTIAL', upcomingUnallocated: false, unallocatedPct: 75, unallocatedDays: 15.75 } }, availabilityDate: { kind: 'date', date: '2026-08-05' } },
      { resourceId: 'other', resourceName: 'Other Person', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false, unallocatedPct: 0, unallocatedDays: 0 } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END } },
    ],
    subcoRows: [],
    hiringDemand: [],
  };

  const CELLS: UnallocatedHistory = {
    resourceId: ROW_ID, resourceName: 'History Person',
    cells: [
      { month: '2026-03', state: 'BENCH', agingBucket: 'D', unallocatedPct: 100, unallocatedDays: 21 },
      // Needs rounding on BOTH figures, so a missing pipe on either is visible.
      { month: '2026-04', state: 'PARTIAL', unallocatedPct: 33.333333333, unallocatedDays: 7.333333 },
      { month: '2026-05', state: 'ALLOCATED', unallocatedPct: 0, unallocatedDays: 0 },
    ],
  };

  async function open(fixture: Awaited<ReturnType<typeof setupWith>>, id = ROW_ID) {
    const host = fixture.nativeElement as HTMLElement;
    const toggle = host.querySelector<HTMLButtonElement>(`[data-test="history-toggle-${id}"]`);
    expect(toggle, `toggle for ${id} should exist`).toBeTruthy();
    toggle!.click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    return host;
  }

  it('renders no history panel until the row is expanded (so the panel is genuinely on-demand)', async () => {
    const fixture = await setupWith(HISTORY_ROLLUP, true, [], () => of(CELLS));
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="history-table"]')).toBeNull();
    expect(host.querySelector('[data-test="history-loading"]')).toBeNull();
    expect(host.querySelector(`[data-test="history-toggle-${ROW_ID}"]`)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('asks for the EXPANDED resource — not the first row, not every row — and for an explicit month count', async () => {
    const asked: { id: string; months?: number }[] = [];
    const fixture = await setupWith(HISTORY_ROLLUP, true, [], (id, months) => {
      asked.push({ id, months });
      return of({ ...CELLS, resourceId: id });
    });
    await open(fixture, 'other');
    // 'other' is the SECOND row, so a hard-coded "first row" would show up here.
    expect(asked).toStrictEqual([{ id: 'other', months: 12 }]);
  });

  it('renders the month, status+aging, days and percentage — each at most 2 decimals', async () => {
    const fixture = await setupWith(HISTORY_ROLLUP, true, [], () => of(CELLS));
    const host = await open(fixture);
    const table = host.querySelector('[data-test="history-table"]');
    expect(table).toBeTruthy();

    const march = host.querySelector('[data-test="history-row-2026-03"]')!;
    const marchCells = Array.from(march.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '');
    expect(marchCells[0]).toBe('Mar 26');
    expect(marchCells[1]).toBe('BENCH (D)');
    expect(marchCells[2]).toBe('21');
    expect(marchCells[3]).toBe('100%');

    const april = host.querySelector('[data-test="history-row-2026-04"]')!;
    const aprilCells = Array.from(april.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '');
    expect(aprilCells[1]).toBe('PARTIAL'); // no aging bucket -> no suffix
    expect(aprilCells[2]).toBe('7.33');
    expect(aprilCells[3]).toBe('33.33%');

    // The 0 row again, in the history: an honest zero, not blank and not "n/a".
    const may = host.querySelector('[data-test="history-row-2026-05"]')!;
    const mayCells = Array.from(may.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '');
    expect(mayCells[2]).toBe('0');
    expect(mayCells[3]).toBe('0%');

    // Oldest-first, as documented — a reversed list is a different claim about
    // which month is "now".
    //
    // `tbody > tr`, not `tbody tr`: the history table lives inside a <td> of the
    // OUTER table's <tbody>, and `querySelectorAll` lets the leading compound of a
    // descendant selector match an ancestor OUTSIDE the root element — so
    // `tbody tr` also matched this table's own <thead> row (whose ancestor chain
    // reaches the outer tbody) and put a null at the head of the list.
    const months = Array.from(table!.querySelectorAll('tbody > tr')).map(tr => tr.getAttribute('data-test'));
    expect(months).toStrictEqual(['history-row-2026-03', 'history-row-2026-04', 'history-row-2026-05']);
  });

  it('opens only the clicked row’s panel, and collapses it again on a second click', async () => {
    const fixture = await setupWith(HISTORY_ROLLUP, true, [], () => of(CELLS));
    const host = await open(fixture);
    expect(host.querySelectorAll('[data-test="history-table"]').length).toBe(1);
    expect(host.querySelector(`[data-test="history-toggle-${ROW_ID}"]`)?.getAttribute('aria-expanded')).toBe('true');
    // ...and the other row is NOT expanded, so one click did not open everything.
    expect(host.querySelector('[data-test="history-toggle-other"]')?.getAttribute('aria-expanded')).toBe('false');

    await open(fixture); // second click on the same row
    expect(host.querySelector('[data-test="history-table"]')).toBeNull();
    expect(host.querySelector(`[data-test="history-toggle-${ROW_ID}"]`)?.getAttribute('aria-expanded')).toBe('false');
  });

  it('says NOT TRACKED — never an empty table and never a run of zeroes — when the history has no cells', async () => {
    const fixture = await setupWith(HISTORY_ROLLUP, true, [], id => of({ resourceId: id, resourceName: 'X', cells: [] }));
    const host = await open(fixture);
    expect(host.querySelector('[data-test="history-untracked"]')?.textContent).toContain('No tracked months');
    expect(host.querySelector('[data-test="history-table"]')).toBeNull();
    expect(host.querySelector('[data-test="history-error"]')).toBeNull();
  });

  it('shows a LOADING state while the read is in flight — not the "not tracked" copy', async () => {
    const fixture = await setupWith(HISTORY_ROLLUP, true, [], () => NEVER);
    const host = await open(fixture);
    expect(host.querySelector('[data-test="history-loading"]')).toBeTruthy();
    // THE PAIR: a pending read must not read as a settled "nothing to see", which
    // is the more comfortable of the two and therefore the dangerous one.
    expect(host.querySelector('[data-test="history-untracked"]')).toBeNull();
    expect(host.querySelector('[data-test="history-table"]')).toBeNull();
  });

  it('shows an ERROR affordance with a retry — never the "not tracked" copy — when the read fails', async () => {
    const fixture = await setupWith(HISTORY_ROLLUP, true, [], () => throwError(() => new Error('boom')));
    const host = await open(fixture);
    const alert = host.querySelector('[data-test="history-error"]');
    expect(alert).toBeTruthy();
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(host.querySelector('[data-test="history-retry"]')).toBeTruthy();
    // THE PAIR, and the one this repo has shipped wrong repeatedly: a failed read
    // rewritten as an empty result reads as "this person was never idle".
    expect(host.querySelector('[data-test="history-untracked"]')).toBeNull();
    expect(host.querySelector('[data-test="history-table"]')).toBeNull();
    // ...and the main page is unaffected: the row itself still renders.
    expect(host.querySelector('[data-test="internal-section"]')?.textContent).toContain('History Person');
  });

  it('does not fetch the history at all before auth is ready (the principal-gated read pattern)', async () => {
    let calls = 0;
    // authReady false, so the page is still in its loading state and no toggle
    // exists to click — the assertion is that nothing was requested regardless.
    const fixture = await setupWith(HISTORY_ROLLUP, false, [], id => { calls++; return of({ resourceId: id, resourceName: '', cells: [] }); });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector(`[data-test="history-toggle-${ROW_ID}"]`)).toBeNull();
    expect(calls).toBe(0);
  });
});

/**
 * BLOCK H — the fourth state on /bench: the away treatment (U11) and the two
 * percentages Q3 governs (U10).
 *
 * STATIC: jsdom lays out nothing. Everything below is about which markup, class
 * list, accessible name and number the component produces. None of it can show
 * that a chip is visible, that the Status column does not clip it, or that the
 * measured contrast holds — the tones are taken on trust from
 * `availability-strip.component.ts`, which is where they were measured.
 *
 * THE FIXTURE HAS TO CONTAIN THE CASE. One row per outcome, because a suite where
 * every row shares an answer passes against a renderer that prints one thing:
 * a BENCH row, an ABSENT row, a PARTIAL row, an ALLOCATED row and a row the
 * rollup has NO cell for this month. And, for Q3, counts chosen so the two
 * candidate denominators give visibly different percentages — the fixture
 * asserts that of itself below, so it cannot quietly stop exercising the
 * decision.
 */
describe('BenchComponent — ABSENT, the fourth state (static: jsdom lays out nothing)', () => {
  const AWAY_LABEL = 'Away (on leave) — not staffable';

  /** BENCH carries a share and a bucket; ABSENT carries NEITHER (bench.util.ts B8 +
   *  the note on `unallocatedPct`), which is what the "n/a" pair below relies on. */
  const BENCH: BenchCell = { state: 'BENCH', agingBucket: 'C', upcomingUnallocated: false, unallocatedPct: 100, unallocatedDays: 21 };
  const AWAY: BenchCell = { state: 'ABSENT', upcomingUnallocated: false };
  const PARTIAL: BenchCell = { state: 'PARTIAL', upcomingUnallocated: false, unallocatedPct: 40, unallocatedDays: 8.4 };
  const ALLOCATED: BenchCell = { state: 'ALLOCATED', upcomingUnallocated: false, unallocatedPct: 0, unallocatedDays: 0 };

  const mk = (id: string, kind: 'internal' | 'subco', cell?: BenchCell): BenchRow => ({
    resourceId: id, resourceName: `Person ${id}`, kind,
    monthly: cell ? { [NOW_MONTH]: cell } : { [shiftMonth(NOW_MONTH, 1)]: BENCH },
    availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END },
  });

  /**
   * Internal: 1 BENCH, 2 ABSENT, 1 PARTIAL, 1 ALLOCATED (denominator 5) -> 20%.
   *           Drop the two away rows from the denominator and it reads 1/3 = 33%.
   * Subco:    3 BENCH, 4 ABSENT, 1 ALLOCATED (denominator 8) -> 38%.
   *           Without the away rows: 3/4 = 75%.
   * Eight numbers, all distinct (1 / 2 / 20 / 33 and 3 / 4 / 38 / 75), so a
   * swapped numerator, a section mix-up, a hard-coded count and the WRONG
   * denominator each show up as a different figure rather than coinciding.
   * `i-nocell` is active only next month: it is in neither denominator, which is
   * the third fact the page has to keep apart from the other two.
   */
  const Q3_ROLLUP: BenchRollup = {
    months: WINDOW,
    internalRows: [
      mk('i-bench', 'internal', BENCH),
      mk('i-away-1', 'internal', AWAY),
      mk('i-away-2', 'internal', AWAY),
      mk('i-partial', 'internal', PARTIAL),
      mk('i-alloc', 'internal', ALLOCATED),
      mk('i-nocell', 'internal'),
    ],
    subcoRows: [
      mk('s-bench-1', 'subco', BENCH), mk('s-bench-2', 'subco', BENCH), mk('s-bench-3', 'subco', BENCH),
      mk('s-away-1', 'subco', AWAY), mk('s-away-2', 'subco', AWAY), mk('s-away-3', 'subco', AWAY), mk('s-away-4', 'subco', AWAY),
      mk('s-alloc', 'subco', ALLOCATED),
    ],
    hiringDemand: [],
  };

  /** Chip text with runs of whitespace collapsed: the away chip renders its glyph
   *  in its own element, so the raw textContent carries the template's indentation. */
  function chip(host: HTMLElement, key: string): HTMLElement {
    const el = host.querySelector<HTMLElement>(`[data-test="state-${key}"]`);
    if (!el) throw new Error(`no state chip rendered for "${key}"`);
    return el;
  }
  const chipText = (host: HTMLElement, key: string): string =>
    (chip(host, key).textContent ?? '').replace(/\s+/g, ' ').trim();
  const headerText = (host: HTMLElement, section: 'internal' | 'subco'): string =>
    (host.querySelector(`[data-test="${section}-section"] .command-card-header`)?.textContent ?? '')
      .replace(/\s+/g, ' ').trim();

  // THE PAIR THAT MATTERS FOR THE TONE. One direction alone — "the away row shows
  // the info chip" — also passes against a page that puts the info chip on every
  // row, and "the bench row is red" alone passes against a page that never renders
  // ABSENT at all. Both directions, on ONE fixture, is the only shape that pins it.
  it('renders the canonical away treatment on an ABSENT row — and never on the BENCH row of the same fixture', async () => {
    const host = (await setupWith(Q3_ROLLUP)).nativeElement as HTMLElement;

    // The away row: the strip's glyph, the state spelled out, the info tone.
    expect(chipText(host, 'i-away-1')).toBe('L ABSENT');
    expect(chip(host, 'i-away-1').className).toContain('is-info');
    expect(chip(host, 'i-away-1').getAttribute('aria-label')).toBe(AWAY_LABEL);
    expect(chip(host, 'i-away-1').getAttribute('title')).toBe(AWAY_LABEL);

    // ...and it is NOT wearing bench's clothes. `red` is the class the BENCH pill
    // carries; if ABSENT ever picks it up, the two states become one on screen.
    expect(chip(host, 'i-away-1').className).not.toContain('red');
    expect(chip(host, 'i-away-1').className).not.toContain('command-status');

    // The BENCH row on the SAME fixture: red, spelled out with its bucket, and
    // carrying none of the away treatment.
    expect(chipText(host, 'i-bench')).toBe('BENCH (C)');
    expect(chip(host, 'i-bench').className).toContain('red');
    expect(chip(host, 'i-bench').className).not.toContain('is-info');
    expect(chip(host, 'i-bench').getAttribute('aria-label')).toBeNull();
    expect(chipText(host, 'i-bench')).not.toContain('L');
  });

  // The THIRD fact. Before H this rendered an empty pill, one glance away from
  // ABSENT and indistinguishable from a rendering fault.
  it('renders "not tracked" as a grey en dash — distinct from BOTH the away chip and the bench pill', async () => {
    const host = (await setupWith(Q3_ROLLUP)).nativeElement as HTMLElement;
    expect(chipText(host, 'i-nocell')).toBe('–');
    expect(chip(host, 'i-nocell').className).toContain('is-neutral');
    expect(chip(host, 'i-nocell').className).not.toContain('is-info');
    expect(chip(host, 'i-nocell').getAttribute('aria-label')).toContain('not tracked');
    // The three, side by side, must be three different strings on screen.
    const three = [chipText(host, 'i-bench'), chipText(host, 'i-away-1'), chipText(host, 'i-nocell')];
    expect(new Set(three).size).toBe(3);
  });

  // ABSENT never carries an aging bucket (bench.util.ts B8): being on leave is not
  // a delivery problem to age, and a bucket would put the person straight back on
  // the ladder the fourth state took her off.
  it('never stamps an aging bucket on an away row', async () => {
    const host = (await setupWith(Q3_ROLLUP)).nativeElement as HTMLElement;
    expect(chipText(host, 'i-away-1')).not.toMatch(/\((A|B|C|D)\)/);
    // ...while the bench row on the same fixture still shows one, so this is
    // about the STATE and not about a suffix that stopped rendering everywhere.
    expect(chipText(host, 'i-bench')).toContain('(C)');
  });

  /**
   * Q3, as a DIFFERENTIAL. The two candidate rules are spelled out and asserted to
   * disagree on this fixture FIRST — without that, both halves below pass under
   * either rule and the test certifies nothing (spec §8.2's exact trap).
   */
  it('keeps an away row OUT of the bench count and IN the "% of active" denominator (Q3)', async () => {
    // The fixture's own precondition. Internal: 1 of 5 vs 1 of 3.
    expect(Math.round((1 / 5) * 100)).not.toBe(Math.round((1 / 3) * 100));
    // Subco: 3 of 8 vs 3 of 4.
    expect(Math.round((3 / 8) * 100)).not.toBe(Math.round((3 / 4) * 100));

    const host = (await setupWith(Q3_ROLLUP)).nativeElement as HTMLElement;

    const internal = headerText(host, 'internal');
    expect(internal).toContain('1 on bench');   // the two away rows left the numerator
    expect(internal).toContain('20% of active');
    // THE OTHER RULE, named: 33% is what dropping them from the denominator reads.
    expect(internal).not.toContain('33% of active');
    // ...and 60% is what counting them as bench would read (3 of 5), i.e. pre-H.
    expect(internal).not.toContain('60% of active');

    const subco = headerText(host, 'subco');
    expect(subco).toContain('3 on bench');
    expect(subco).toContain('38% of active');
    expect(subco).not.toContain('75% of active');   // away out of the denominator
    expect(subco).not.toContain('88% of active');   // away counted as bench (7 of 8)
  });

  // The count Q3 makes mandatory. Asserted TOGETHER with the percentage above and
  // below, because either one can be wired without the other.
  it('shows the away count beside each percentage, per section and never swapped', async () => {
    const host = (await setupWith(Q3_ROLLUP)).nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="internal-away-count"]')?.textContent?.trim()).toBe('2 away');
    expect(host.querySelector('[data-test="subco-away-count"]')?.textContent?.trim()).toBe('4 away');
    // Cross-section swap: each section's own header must not carry the other's figure.
    expect(headerText(host, 'internal')).not.toContain('4 away');
    expect(headerText(host, 'subco')).not.toContain('2 away');
    // The count has to justify the denominator, so it says so on hover rather than
    // leaving a bare number the reader has to reverse-engineer.
    expect(host.querySelector('[data-test="internal-away-count"]')?.getAttribute('title')).toContain('denominator');
  });

  // THE ABSENCE TWIN of both assertions above: on a rollup with no away rows at
  // all, the count is an honest 0 and BOTH percentages are byte-identical to what
  // they were before this block. A page that always printed a non-zero count, or
  // that changed the arithmetic for everybody, fails here and only here.
  it('reads 0 away — and leaves both percentages exactly as they were — on a rollup with no absences', async () => {
    const host = (await setupWith(COUNTS_ROLLUP)).nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="internal-away-count"]')?.textContent?.trim()).toBe('0 away');
    expect(host.querySelector('[data-test="subco-away-count"]')?.textContent?.trim()).toBe('0 away');
    expect(headerText(host, 'internal')).toContain('50% of active');
    expect(headerText(host, 'subco')).toContain('33% of active');
  });

  // The unallocated share is unanswerable for an away month, and it is unanswerable
  // for a never-contracted month, but for DIFFERENT reasons — and the tooltip is
  // the only place the reader can find out which. One string for both would be a
  // claim they cannot check.
  it('names the AWAY reason on an away row\'s "n/a", and the no-contract reason on an untracked one', async () => {
    const host = (await setupWith(Q3_ROLLUP)).nativeElement as HTMLElement;
    const away = host.querySelector('[data-test="unallocated-pct-i-away-1"]')!;
    const untracked = host.querySelector('[data-test="unallocated-pct-i-nocell"]')!;

    expect(away.textContent?.trim()).toBe('n/a');
    expect(away.getAttribute('title')).toContain('Away for the whole month');
    expect(away.getAttribute('title')).not.toContain('No contracted target');

    expect(untracked.textContent?.trim()).toBe('n/a');
    expect(untracked.getAttribute('title')).toContain('No contracted target');
    expect(untracked.getAttribute('title')).not.toContain('Away for the whole month');
  });

  // The rendered strings are pinned EXACTLY, not by substring, and that is the
  // privacy gate on this surface: an absence reason is special-category data (spec
  // §7.3), `BenchCell` cannot carry one and /bench/monthly does not transmit one,
  // so the only way one could reach the screen is somebody appending it here.
  // `toStrictEqual` on the whole triple makes that a red test rather than a review
  // comment.
  it('says exactly "away", never why', async () => {
    const host = (await setupWith(Q3_ROLLUP)).nativeElement as HTMLElement;
    const el = chip(host, 'i-away-1');
    expect({
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      label: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
    }).toStrictEqual({ text: 'L ABSENT', label: AWAY_LABEL, title: AWAY_LABEL });
  });

  // The expandable history renders the same four states, and rendering them a
  // second way on the same page is the drift this fragment exists to prevent.
  it('gives an ABSENT month in the history panel the same treatment as the grid — beside a BENCH month that keeps its own', async () => {
    const history: UnallocatedHistory = {
      resourceId: 'i-bench', resourceName: 'Person i-bench',
      cells: [
        { month: '2026-03', state: 'BENCH', agingBucket: 'D', unallocatedPct: 100, unallocatedDays: 21 },
        { month: '2026-04', state: 'ABSENT' },
      ],
    };
    const fixture = await setupWith(Q3_ROLLUP, true, [], () => of(history));
    const host = fixture.nativeElement as HTMLElement;
    host.querySelector<HTMLButtonElement>('[data-test="history-toggle-i-bench"]')!.click();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    expect(chipText(host, '2026-04')).toBe('L ABSENT');
    expect(chip(host, '2026-04').className).toContain('is-info');
    expect(chipText(host, '2026-03')).toBe('BENCH (D)');
    expect(chip(host, '2026-03').className).not.toContain('is-info');
  });
});

/**
 * The anchor month, under a clock pinned to an instant where UTC and the local civil
 * date DISAGREE — and in a window that does not start at the current month.
 *
 * Three wrong implementations all pass a TZ-blind test of this, and this repo has
 * recorded that exact failure nine times:
 *   * `months[0]` — what shipped. The server anchors the bench window on the OLDEST
 *     Open planning period, four months back with the seed, so the page presented a
 *     four-month-old column as the present tense.
 *   * `new Date().toISOString().slice(0, 7)` — the obvious "current month", which
 *     names the WRONG month for anyone east of UTC in the first hours of the 1st.
 *     Here the local date is 1 October and UTC still says 30 September.
 *   * a guard that always answers `''` — which passes every "must be absent" case,
 *     so the ALLOWED case below is mandatory.
 *
 * TZ is forced rather than sniffed: on a UTC runner no instant can make local and
 * UTC disagree, and a test that quietly skips its own point is a green gate.
 */
describe('BenchComponent — the anchor month is TODAY, in the LOCAL calendar', () => {
  const ORIGINAL_TZ = process.env['TZ'];
  /** UTC+14, no DST ever: 2026-09-30T23:00Z is 2026-10-01T13:00 local. */
  const LOCAL_MONTH = '2026-10';
  const UTC_MONTH = '2026-09';

  beforeAll(() => {
    setTz('Pacific/Kiritimati');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 23, 0)));
  });
  afterAll(() => {
    vi.useRealTimers();
    setTz(ORIGINAL_TZ);
    TestBed.resetTestingModule();
  });

  it('has a fixture whose local and UTC months genuinely differ (the precondition, not an assumption)', () => {
    expect(todayLocalIso().slice(0, 7)).toBe(LOCAL_MONTH);
    expect(new Date().toISOString().slice(0, 7)).toBe(UTC_MONTH);
    expect(LOCAL_MONTH).not.toBe(UTC_MONTH);
  });

  /** Window ends at the local current month; `months[0]` and the UTC month are both earlier. */
  const IN_WINDOW: BenchRollup = {
    months: ['2026-07', '2026-08', UTC_MONTH, LOCAL_MONTH],
    internalRows: [{
      resourceId: 'i1', resourceName: 'Anchor Person', kind: 'internal',
      monthly: {
        '2026-07': { state: 'ALLOCATED', upcomingUnallocated: false },
        [UTC_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false },
        [LOCAL_MONTH]: { state: 'BENCH', agingBucket: 'B', upcomingUnallocated: false },
      },
      availabilityDate: { kind: 'date', date: '2026-10-01' },
    }],
    subcoRows: [],
    hiringDemand: [],
  };

  it('reads the LOCAL current month, not months[0] and not the UTC month (the case that must still be ALLOWED)', async () => {
    const fixture = await setupWith(IN_WINDOW);
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="internal-section"]')!;
    // RED three ways: months[0] and the UTC month both say ALLOCATED, and an
    // always-empty anchor says nothing at all.
    expect(fixture.componentInstance.internalBenchCount()).toBe(1);
    expect(section.textContent ?? '').toContain('BENCH (B)');
    expect(host.querySelector('[data-test="bench-window-note"]')?.textContent ?? '').toContain('Oct 26');
  });

  /** Window stops BEFORE the local current month, but still contains the UTC one. */
  const PAST_WINDOW: BenchRollup = {
    months: ['2026-06', '2026-07', '2026-08', UTC_MONTH],
    internalRows: [{
      resourceId: 'i1', resourceName: 'Stale Judgement Person', kind: 'internal',
      monthly: {
        '2026-06': { state: 'BENCH', agingBucket: 'D', upcomingUnallocated: false },
        [UTC_MONTH]: { state: 'BENCH', agingBucket: 'C', upcomingUnallocated: false },
      },
      availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: UTC_MONTH },
    }],
    subcoRows: [],
    hiringDemand: [],
  };

  it('reports NOTHING for a window that does not reach the current month, and says why', async () => {
    const fixture = await setupWith(PAST_WINDOW);
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="internal-section"]')!;
    const sectionText = section.textContent ?? '';

    expect(fixture.componentInstance.internalBenchCount()).toBe(0);
    // THE ABSENCE TWIN: a past month's judgement must not appear in a present-tense
    // column. Today both of these fail — `months[0]` renders 'BENCH (D)' and the UTC
    // month renders 'BENCH (C)'.
    expect(sectionText).not.toContain('BENCH');
    expect(sectionText).not.toContain('(D)');
    expect(sectionText).not.toContain('(C)');
    // ...and a blank column is not allowed to pass for "nobody is on the bench":
    // only the `includes()` form can tell the two apart and label it.
    const note = host.querySelector('[data-test="bench-window-note"]')?.textContent ?? '';
    expect(note).toContain('does not include the current month');
    expect(note).toContain('Oct 26');
  });
});

/**
 * The Unchargeable .xlsx control (RPT comparison row 53), under the P2-18 convention
 * seven other screens already follow.
 *
 * BOTH HALVES ARE ASSERTED FOR EVERY BLOCKED CASE — the button disabled AND the hint
 * present AND `aria-describedby` wired — because each half alone goes green on a
 * half-fix: a disabled button with no reason is the affordance P2-18 exists to
 * replace, and a hint beside a live button is decoration.
 *
 * `buildXlsx` is deliberately never called from this file. It pulls exceljs through a
 * dynamic import (5-9s on the first call in a worker) and the warm-up scan in
 * `export.util.spec.ts` only guards the services directory, so a workbook built here
 * would be an unguarded flake. The SHEETS are asserted instead — the component splits
 * `buildUnchargeableSheets()` out of the click handler for exactly that reason — and
 * `rpt-xlsx.util.spec.ts` takes them through the real writer.
 */
describe('BenchComponent — the Unchargeable .xlsx export (P2-18)', () => {
  /** One resource per RPT category, plus one in none, keyed on the current month. */
  const EXPORTABLE: BenchRollup = {
    months: WINDOW,
    internalRows: [
      { resourceId: 'i1', resourceName: 'Internal Bench One', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'BENCH', agingBucket: 'C', upcomingUnallocated: false, unallocatedPct: 62.5, unallocatedDays: 13.125 } }, availabilityDate: { kind: 'date', date: '2026-08-07' } },
      { resourceId: 'i4', resourceName: 'Internal Allocated', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END } },
    ],
    subcoRows: [],
    hiringDemand: [],
  };

  /** Nobody in any category: every cell is ALLOCATED. */
  const NOTHING_TO_EXPORT: BenchRollup = {
    months: WINDOW,
    internalRows: [
      { resourceId: 'i4', resourceName: 'Internal Allocated', kind: 'internal', monthly: { [NOW_MONTH]: { state: 'ALLOCATED', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: WINDOW_END } },
    ],
    subcoRows: [],
    hiringDemand: [],
  };

  function control(fixture: Awaited<ReturnType<typeof setupWith>>) {
    const host = fixture.nativeElement as HTMLElement;
    return {
      button: host.querySelector<HTMLButtonElement>('[data-test="export-unchargeable-xlsx"]'),
      hint: host.querySelector('[data-test="export-unchargeable-hint"]'),
    };
  }

  it('is ENABLED, unlabelled and un-described when there IS something to export', async () => {
    const fixture = await setupWith(EXPORTABLE);
    const { button, hint } = control(fixture);
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
    // ASSERTION OF ABSENCE, twice. No hint on the page, and no dangling
    // aria-describedby pointing at an element that is not there — a description
    // that does not resolve is worse for a screen reader than none.
    expect(hint).toBeNull();
    expect(button!.getAttribute('aria-describedby')).toBeNull();
    expect(fixture.componentInstance.exportBlockedReason()).toBe('');
  });

  it('is DISABLED with the reason beside it when nobody is unchargeable this month', async () => {
    const fixture = await setupWith(NOTHING_TO_EXPORT);
    const { button, hint } = control(fixture);
    expect(button!.disabled).toBe(true);
    expect(hint).toBeTruthy();
    expect(hint!.textContent).toContain('Nobody is unchargeable');
    // The hint IS the accessible description, so the wiring must resolve.
    expect(button!.getAttribute('aria-describedby')).toBe(hint!.id);
    expect(hint!.id).toBe('unchargeableExportHint');
  });

  it('is DISABLED with a DIFFERENT reason when the bench read failed', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [BenchComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: {
          getBenchMonthly: () => throwError(() => new Error('boom')),
          getHoursPerDay: () => of({ value: 8 }),
          getHolidays: () => of([]),
          getResources: () => of(EXPORT_RESOURCES),
          getResourceOrganizations: () => of(EXPORT_ORGS),
        } },
        { provide: AuthService, useValue: { authReady: () => true } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(BenchComponent);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    const { button, hint } = control(fixture);
    expect(button!.disabled).toBe(true);
    expect(hint!.textContent).toContain("Couldn't load the bench data");
    // NOT the empty-report reason: "we could not load the bench" and "nobody is on
    // the bench" are opposite facts, and one catch-all string would tell the reader
    // the reassuring one.
    expect(hint!.textContent).not.toContain('Nobody is unchargeable');
  });

  it('is DISABLED with its OWN reason when only the resource master failed', async () => {
    // The whole point of loading the join data separately: the bench tables still
    // render, and exactly one control goes dark with an accurate reason.
    const fixture = await setupWith(EXPORTABLE, true, [], NO_HISTORY, {
      resources: () => throwError(() => new Error('resources down')),
    });
    const host = fixture.nativeElement as HTMLElement;
    const { button, hint } = control(fixture);
    expect(button!.disabled).toBe(true);
    expect(hint!.textContent).toContain('resource master');
    // ASSERTION OF ABSENCE: the page itself is NOT in its error state, and the bench
    // row is still on screen.
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-test="internal-section"]')?.textContent ?? '').toContain('Internal Bench One');
  });

  it('is DISABLED with the window reason when the fetched window has no current month', async () => {
    const past = [-5, -4, -3, -2, -1].map(d => shiftMonth(NOW_MONTH, d));
    const fixture = await setupWith({
      months: past,
      internalRows: [{ resourceId: 'i1', resourceName: 'Internal Bench One', kind: 'internal', monthly: { [past[0]]: { state: 'BENCH', agingBucket: 'D', upcomingUnallocated: false } }, availabilityDate: { kind: 'beyond-horizon', horizonEndMonth: past[past.length - 1] } }],
      subcoRows: [], hiringDemand: [],
    });
    const { button, hint } = control(fixture);
    expect(button!.disabled).toBe(true);
    expect(hint!.textContent).toContain('no current month');
  });

  it('builds FOUR sheets and puts the row in the tab its category names', async () => {
    const fixture = await setupWith(EXPORTABLE);
    // `buildUnchargeableSheets` is protected; the cast is the same one the codebase
    // uses to assert a builder without going through the DOM download.
    const sheets = (fixture.componentInstance as unknown as { buildUnchargeableSheets(): XlsxSheet[] }).buildUnchargeableSheets();
    expect(sheets.map(s => s.name)).toStrictEqual([
      SHEET_UNCHARGEABLE_A, SHEET_UNCHARGEABLE_B, SHEET_UNCHARGEABLE_C, SHEET_UNCHARGEABLE_D,
    ]);
    const rowsPerSheet = sheets.map(s => s.rows.length);
    // The C row and ONLY the C row — a builder that dumped everything into one tab,
    // or that emitted four header-only tabs, reads [1,0,0,0] or [0,0,0,0] here.
    expect(rowsPerSheet).toStrictEqual([0, 0, 1, 0]);

    const c = sheets[2];
    const at = (header: string) => c.rows[0][c.header.indexOf(header)];
    expect(at('Resource')).toBe('Internal Bench One');
    // The join data really was joined: role, org walk, top-proficiency skill, rate.
    expect(at('Job Role')).toBe('Developer');
    expect(at('Capability')).toBe('Engineering');
    expect(at('Competence')).toBe('Backend');
    expect(at('Capability Leader')).toBe('Marta Manager');
    expect(at('Skill 1')).toBe('Kubernetes');
    expect(at('Standard Cost Rate (EUR/day)')).toBe(640);
    expect(at('Unallocated Days')).toBe(13.13);
    // ASSERTION OF ABSENCE: the ALLOCATED colleague is in no tab at all.
    expect(sheets.flatMap(s => s.rows.map(r => r[c.header.indexOf('Resource')]))).not.toContain('Internal Allocated');
  });

  it('does nothing at all when clicked while blocked', async () => {
    // The affordance is the gate, but the handler must not rely on the template:
    // a programmatic call (or a stale click) must not produce an empty workbook.
    const fixture = await setupWith(NOTHING_TO_EXPORT);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    await fixture.componentInstance.exportUnchargeableXlsx();
    expect(clicks).toStrictEqual([]);
    vi.restoreAllMocks();
  });
});
