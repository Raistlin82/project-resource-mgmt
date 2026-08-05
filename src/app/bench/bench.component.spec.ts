import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
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

async function setupWith(rollup: BenchRollup, authReady = true) {
  await TestBed.configureTestingModule({
    imports: [BenchComponent],
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: {
        getBenchMonthly: () => of(rollup),
        getHoursPerDay: () => of({ value: 8 }),
        getHolidays: () => of([]),
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
  it('renders the hiring-demand FTE at 2 decimals', async () => {
    const fixture = await setup();
    const host = fixture.nativeElement as HTMLElement;
    const text = host.querySelector('[data-test="hiring-demand"]')!.textContent ?? '';
    // 176h / (22 working days * 8h/day = 176h target) = 1.00 FTE.
    expect(text).toContain('1.00');
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
});
