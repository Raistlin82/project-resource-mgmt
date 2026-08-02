import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CapacityComponent } from './capacity.component';
import { ApiService, CapacityMonthly } from '../services/api.service';
import { AuthService } from '../services/auth.service';

/**
 * Known 2-resource × 2-month envelope with distinct bands: Alice is `over` in
 * 2026-07 (planned 1.25 FTE) and Bob is `idle` (planned 0.25 FTE). Totals give
 * the KPI strip a deterministic capacity (2.0 FTE) and planned demand (1.5 FTE).
 */
const ENVELOPE: CapacityMonthly = {
  months: ['2026-07', '2026-08'],
  rows: [
    {
      resourceId: 'r1',
      resourceName: 'Alice',
      monthly: {
        '2026-07': { confirmedHours: 160, plannedHours: 200, targetHours: 160, fteConfirmed: 1.0, ftePlanned: 1.25, band: 'over' },
        '2026-08': { confirmedHours: 152, plannedHours: 160, targetHours: 160, fteConfirmed: 0.95, ftePlanned: 1.0, band: 'healthy' },
      },
    },
    {
      resourceId: 'r2',
      resourceName: 'Bob',
      monthly: {
        '2026-07': { confirmedHours: 20, plannedHours: 40, targetHours: 160, fteConfirmed: 0.125, ftePlanned: 0.25, band: 'idle' },
        '2026-08': { confirmedHours: 80, plannedHours: 128, targetHours: 160, fteConfirmed: 0.5, ftePlanned: 0.8, band: 'under' },
      },
    },
  ],
  totals: {
    '2026-07': { demandFteConfirmed: 1.125, demandFtePlanned: 1.5, capacityFte: 2, resourceCount: 2 },
    '2026-08': { demandFteConfirmed: 1.45, demandFtePlanned: 1.8, capacityFte: 2, resourceCount: 2 },
  },
};

function setup(ready: boolean) {
  const getCapacityMonthly = vi.fn(() => of(ENVELOPE));
  const apiStub = { getCapacityMonthly } as unknown as ApiService;
  const authStub = {
    authReady: signal(ready),
    isAuthenticated: signal(ready),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [CapacityComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });

  const fixture = TestBed.createComponent(CapacityComponent);
  return { fixture, getCapacityMonthly, authStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('CapacityComponent', () => {
  it('renders the over cell (band + percentage) and KPI/totals from the envelope once auth is ready', async () => {
    const { fixture, getCapacityMonthly } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;

    // The data actually loaded.
    expect(getCapacityMonthly).toHaveBeenCalled();

    // The `over` cell: band conveyed by TEXT (not colour alone) + the critical
    // tone token + the planned percentage.
    const overCell = host.querySelector('[data-test="cell-r1-2026-07"]') as HTMLElement;
    expect(overCell).not.toBeNull();
    expect(overCell.getAttribute('data-band')).toBe('over');
    expect(overCell.className).toContain('bg-critical-tint');
    expect(overCell.textContent).toContain('125%');
    expect(overCell.textContent?.toLowerCase()).toContain('over');
    // WCAG: the cell carries an hours-detail aria-label, not colour alone.
    expect(overCell.getAttribute('aria-label')).toMatch(/200|160/);

    // The idle cell is the neutral tone (distinct from the over cell).
    const idleCell = host.querySelector('[data-test="cell-r2-2026-07"]') as HTMLElement;
    expect(idleCell.getAttribute('data-band')).toBe('idle');
    expect(idleCell.className).not.toContain('bg-critical-tint');

    // KPI strip for the first month reflects the envelope totals + the over count.
    expect((host.querySelector('[data-test="kpi-planned"]') as HTMLElement).textContent).toContain('1.5');
    expect((host.querySelector('[data-test="kpi-capacity"]') as HTMLElement).textContent).toContain('2.0');
    expect((host.querySelector('[data-test="kpi-over"]') as HTMLElement).textContent).toContain('1');

    // Totals row for July: planned demand 1.5 vs capacity 2.0.
    const totalsJul = host.querySelector('[data-test="totals-2026-07"]') as HTMLElement;
    expect(totalsJul).not.toBeNull();
    expect(totalsJul.textContent).toContain('1.5');
    expect(totalsJul.textContent).toContain('2.0');

    // Both resources appear as rows.
    expect(host.textContent).toContain('Alice');
    expect(host.textContent).toContain('Bob');
  });

  it('seeds the From/To selects to the loaded window in the actual DOM, not just the signal', async () => {
    // Regression for the reported bug: the <select>'s live DOM `.value` must
    // match the seeded fromSel/toSel signal (the loaded window), not just the
    // signal itself — a mismatch here means the browser silently fell back to
    // the first padded option because [value] was applied before the @for's
    // <option> elements existed.
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const fromEl = host.querySelector('select[aria-label="Range start month"]') as HTMLSelectElement;
    const toEl = host.querySelector('select[aria-label="Range end month"]') as HTMLSelectElement;
    expect(fromEl).not.toBeNull();
    expect(toEl).not.toBeNull();

    expect(fixture.componentInstance['fromSel']()).toBe('2026-07');
    expect(fixture.componentInstance['toSel']()).toBe('2026-08');
    // The assertion that actually catches the bug: the live DOM value.
    expect(fromEl.value).toBe('2026-07');
    expect(toEl.value).toBe('2026-08');
  });

  it('does not fetch and shows no rows until auth settles', async () => {
    const { fixture, getCapacityMonthly } = setup(false);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    expect(getCapacityMonthly).not.toHaveBeenCalled();
    // Empty default until authReady flips true — no resource rows rendered.
    expect(host.textContent).not.toContain('Alice');
    expect(host.querySelector('[data-test="cell-r1-2026-07"]')).toBeNull();
  });
});
