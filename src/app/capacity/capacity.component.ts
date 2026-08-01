import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe, isPlatformBrowser } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { of } from 'rxjs';
import { rxResource } from '@angular/core/rxjs-interop';
import { ApiService, CapacityMonthly, CapacityRow } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { CsvColumn, downloadCsv, downloadJson, toCsv, toJson } from '../services/export.util';
import { ListStateComponent } from '../shared/list-state.component';
import type { SemaphoreBand } from '../services/capacity.util';
import { monthsInRange } from '../services/capacity.util';

/** Empty envelope used until auth settles (and as the resource default). */
const EMPTY: CapacityMonthly = { months: [], rows: [], totals: {} };

/** How many months to pad the range-selector option list beyond the loaded window. */
const OPTION_PAD_MONTHS = 6;

/** Per-band presentation: label (WCAG text, not colour alone) + design-system tone tokens. */
interface BandMeta {
  label: string;
  /** Cell background tint token. */
  cell: string;
  /** Accent-as-text token (the `-text` / `-700` shade for AA contrast). */
  text: string;
  /** Ring token matching the tint. */
  ring: string;
  /** Solid tone for the confirmed inner bar. */
  bar: string;
}

/**
 * Band → tone mapping. idle→neutral (surface-muted, no dedicated tint token),
 * under→caution, healthy→positive, over→critical. Accent-as-text always uses the
 * `-text` shade so the label meets AA on its tint.
 */
const BAND_META: Record<SemaphoreBand, BandMeta> = {
  idle: { label: 'Idle', cell: 'bg-surface-muted', text: 'text-ink-secondary', ring: 'ring-line', bar: 'bg-ink-muted' },
  under: { label: 'Under', cell: 'bg-caution-tint', text: 'text-caution-text', ring: 'ring-caution', bar: 'bg-caution' },
  healthy: { label: 'Healthy', cell: 'bg-positive-tint', text: 'text-positive-text', ring: 'ring-positive', bar: 'bg-positive' },
  over: { label: 'Over', cell: 'bg-critical-tint', text: 'text-critical-text', ring: 'ring-critical', bar: 'bg-critical' },
};

/** One rendered grid cell (view model), precomputed so the template stays declarative. */
interface CellVm {
  month: string;
  /** False when the resource has no cell that month (inactive) — renders a muted placeholder. */
  present: boolean;
  band: SemaphoreBand;
  meta: BandMeta;
  /** Planned utilisation as a whole percentage (ftePlanned × 100). */
  plannedPct: number;
  /** Confirmed utilisation as a whole percentage (fteConfirmed × 100). */
  confirmedPct: number;
  /** Confirmed share of planned, 0..100, for the inner marker bar. */
  confirmedWidth: number;
  aria: string;
}

interface RowVm {
  resourceId: string;
  resourceName: string;
  cells: CellVm[];
}

interface TotalsVm {
  month: string;
  confirmed: number;
  planned: number;
  capacity: number;
}

/** Shift a 'YYYY-MM' month by `delta` months (may be negative). */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/**
 * Monthly FTE capacity dashboard (B2, Task 4). A read-only resource × month grid
 * of planned utilisation, colour-and-label banded (idle/under/healthy/over), with
 * a KPI strip for the first month, a per-month totals row (demand vs capacity),
 * a from/to range selector and CSV/JSON export.
 *
 * Signal-first and SSR-safe: the gated `/capacity/monthly` read is keyed on
 * {@link AuthService.authReady} + the selected range so it fires only once the
 * OIDC bootstrap has settled (bearer attached), resolving to an empty default
 * until then. Identity is read reactively — never snapshotted at field-init.
 */
@Component({
  selector: 'app-capacity',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="command-header">
        <div>
          <div class="command-eyebrow">Capacity Planning</div>
          <h1 class="command-title">Monthly FTE Capacity</h1>
          <p class="command-subtitle">Resource-by-month view of planned demand against capacity, banded by utilisation. Confirmed (approved) load is marked within each planned figure.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
          @if (monthOptions().length > 0) {
            <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
              <span class="text-ink-muted">From</span>
              <select [value]="fromSel() ?? ''" (change)="onFromChange($event)" aria-label="Range start month" class="command-select">
                @for (m of monthOptions(); track m) {
                  <option [value]="m">{{ monthLabel(m) }}</option>
                }
              </select>
            </label>
            <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
              <span class="text-ink-muted">To</span>
              <select [value]="toSel() ?? ''" (change)="onToChange($event)" aria-label="Range end month" class="command-select">
                @for (m of monthOptions(); track m) {
                  <option [value]="m">{{ monthLabel(m) }}</option>
                }
              </select>
            </label>
          }
          <div class="flex items-center gap-2">
            <button type="button" (click)="exportCsv()" [disabled]="rows().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> CSV
            </button>
            <button type="button" (click)="exportJson()" [disabled]="rows().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">data_object</mat-icon> JSON
            </button>
          </div>
        </div>
      </div>

      @if (accessNotice(); as notice) {
        <div class="command-card-muted p-4 flex items-start gap-3" role="alert">
          <mat-icon class="text-[20px] w-[20px] h-[20px] text-[var(--cc-amber-text)] shrink-0">lock</mat-icon>
          <p class="text-sm font-medium text-[var(--cc-ink)]">{{ notice }}</p>
        </div>
      }

      <!-- KPI strip — first month in the range. -->
      @if (firstMonth(); as fm) {
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
          <div class="command-kpi">
            <p class="command-kpi-label">Planned Demand — {{ monthLabel(fm) }}</p>
            <p class="command-kpi-value font-mono tabular-nums" data-test="kpi-planned">{{ kpiPlanned() | number:'1.1-1' }} <span class="text-base font-semibold text-ink-muted">FTE</span></p>
          </div>
          <div class="command-kpi info">
            <p class="command-kpi-label">Capacity — {{ monthLabel(fm) }}</p>
            <p class="command-kpi-value font-mono tabular-nums" data-test="kpi-capacity">{{ kpiCapacity() | number:'1.1-1' }} <span class="text-base font-semibold text-ink-muted">FTE</span></p>
          </div>
          <div class="command-kpi" [class.danger]="kpiOver() > 0">
            <p class="command-kpi-label">Overbooked Resources</p>
            <p class="command-kpi-value font-mono tabular-nums" [class.text-critical-text]="kpiOver() > 0" data-test="kpi-over">{{ kpiOver() }}</p>
          </div>
        </div>
      }

      <!-- Legend — band meaning is text + colour, never colour alone (WCAG 1.4.1). -->
      <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-semibold text-ink-muted">
        <span class="uppercase tracking-wider">Utilisation band:</span>
        @for (b of legend; track b.band) {
          <span class="inline-flex items-center gap-1.5">
            <span class="w-3 h-3 rounded-sm ring-1 {{ b.meta.cell }} {{ b.meta.ring }}"></span>
            <span [class]="b.meta.text">{{ b.meta.label }}</span>
            <span class="text-ink-muted font-normal normal-case">{{ b.range }}</span>
          </span>
        }
      </div>

      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="table-rows" [rows]="6" [columns]="4" label="capacity" (retry)="reload()">
        @if (rows().length > 0) {
          <div class="command-card overflow-hidden">
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead class="bg-surface-muted border-b border-line text-ink-muted">
                  <tr>
                    <th class="px-4 sm:px-6 py-4 font-semibold uppercase tracking-wider text-xs text-left sticky left-0 bg-surface-muted z-10">Resource</th>
                    @for (m of months(); track m) {
                      <th class="px-3 py-4 font-semibold uppercase tracking-wider text-xs text-center min-w-[7rem]">{{ monthLabel(m) }}</th>
                    }
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  @for (row of rows(); track row.resourceId) {
                    <tr class="hover:bg-surface-muted transition-colors">
                      <td class="px-4 sm:px-6 py-4 font-bold text-ink whitespace-nowrap sticky left-0 bg-surface z-10">{{ row.resourceName }}</td>
                      @for (c of row.cells; track c.month) {
                        <td class="px-2 py-2 align-top">
                          @if (c.present) {
                            <div class="rounded-lg ring-1 p-2 text-center {{ c.meta.cell }} {{ c.meta.ring }}"
                                 [attr.data-test]="'cell-' + row.resourceId + '-' + c.month"
                                 [attr.data-band]="c.band"
                                 [attr.aria-label]="c.aria">
                              <div class="text-base font-bold font-mono tabular-nums {{ c.meta.text }}">{{ c.plannedPct | number:'1.0-0' }}%</div>
                              <div class="text-[10px] font-bold uppercase tracking-wide {{ c.meta.text }}">{{ c.meta.label }}</div>
                              <!-- Confirmed marker: inner bar (share of planned that is approved)
                                   + a secondary numeric, so confirmed reads distinctly from planned. -->
                              <div class="mt-1.5 h-1.5 rounded-full bg-surface ring-1 ring-line overflow-hidden" role="presentation">
                                <div class="h-full rounded-full {{ c.meta.bar }}" [style.width.%]="c.confirmedWidth"></div>
                              </div>
                              <div class="mt-1 text-[10px] font-mono tabular-nums text-ink-muted">conf {{ c.confirmedPct | number:'1.0-0' }}%</div>
                            </div>
                          } @else {
                            <div class="rounded-lg border border-dashed border-line bg-surface-muted p-2 text-center text-ink-muted"
                                 [attr.aria-label]="row.resourceName + ' — ' + monthLabel(c.month) + ': not active'">
                              <div class="text-sm font-mono tabular-nums">—</div>
                              <div class="text-[10px] uppercase tracking-wide">n/a</div>
                            </div>
                          }
                        </td>
                      }
                    </tr>
                  }
                </tbody>
                <tfoot class="border-t-2 border-line bg-surface-muted font-bold text-ink">
                  <tr>
                    <td class="px-4 sm:px-6 py-4 sticky left-0 bg-surface-muted z-10">Demand / Capacity <span class="ml-1 text-xs font-semibold text-ink-muted normal-case tracking-normal">FTE</span></td>
                    @for (t of totalsRow(); track t.month) {
                      <td class="px-3 py-4 text-center" [attr.data-test]="'totals-' + t.month">
                        <div class="font-mono tabular-nums text-sm" [class.text-critical-text]="t.planned > t.capacity">
                          {{ t.planned | number:'1.1-1' }} <span class="text-ink-muted font-normal">/ {{ t.capacity | number:'1.1-1' }}</span>
                        </div>
                        <div class="text-[10px] font-mono tabular-nums text-ink-muted font-normal">conf {{ t.confirmed | number:'1.1-1' }}</div>
                      </td>
                    }
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        } @else if (!dataLoading() && !dataError()) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-[40px] w-[40px] h-[40px] text-ink-muted">calendar_view_month</mat-icon>
            <p class="mt-3 text-sm font-medium text-ink-secondary">No capacity data for the selected range.</p>
            <p class="text-xs text-ink-muted">Confirm assignments or widen the month range to populate the grid.</p>
          </div>
        }
      </app-list-state>
    </div>
  `,
})
export class CapacityComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private platformId = inject(PLATFORM_ID);

  /**
   * Selected window. `null` means "not chosen yet" → let the server pick its
   * default window on first load; once loaded the selectors are seeded from the
   * returned months (see the seeding effect). Read reactively as the range key.
   */
  protected fromSel = signal<string | null>(null);
  protected toSel = signal<string | null>(null);

  // Gated read: keyed on authReady + the selected range so it fires only after
  // the OIDC bootstrap settles (bearer attached) and re-runs when the range
  // changes. Until authReady it resolves to the empty default (no 401 latch).
  private capacityRes = rxResource<CapacityMonthly, { ready: boolean; from: string | null; to: string | null }>({
    params: () => ({ ready: this.auth.authReady(), from: this.fromSel(), to: this.toSel() }),
    stream: ({ params }) =>
      params.ready
        ? this.api.getCapacityMonthly(params.from ?? undefined, params.to ?? undefined)
        : of(EMPTY),
    defaultValue: EMPTY,
  });

  constructor() {
    // Seed the range selectors from the FIRST loaded window (server default).
    // Guarded on null so it runs once and never fights a later user choice; the
    // writes are untracked so this effect reacts only to the resource value.
    effect(() => {
      const months = this.capacityRes.value().months;
      if (months.length === 0) return;
      untracked(() => {
        if (this.fromSel() === null) this.fromSel.set(months[0]);
        if (this.toSel() === null) this.toSel.set(months[months.length - 1]);
      });
    });
  }

  protected months = computed(() => this.capacityRes.value().months);
  protected firstMonth = computed<string | null>(() => this.months()[0] ?? null);

  protected dataLoading = computed(() => this.capacityRes.isLoading());
  protected dataError = computed(() => this.capacityRes.status() === 'error');

  /**
   * ACCESS FEEDBACK: the gated read 401s until signed in and 403s for an
   * under-privileged role (staffing roles only). 401/403 are not toasted, so say
   * WHY instead of showing a silently empty grid.
   */
  protected accessNotice = computed<string | null>(() => {
    if (this.capacityRes.status() !== 'error') return null;
    return this.auth.isAuthenticated()
      ? 'Your role does not have access to the capacity data. Staffing roles (PM, resource manager, delivery executive, finance, admin) can view this dashboard.'
      : 'Sign in to view the capacity dashboard — capacity data requires an authenticated staffing role.';
  });

  protected reload(): void {
    this.capacityRes.reload();
  }

  /** Grid rows (view models) — one per resource, cells across every month in range. */
  protected rows = computed<RowVm[]>(() => {
    const value = this.capacityRes.value();
    const months = value.months;
    return value.rows.map((r) => ({
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      cells: months.map((m) => this.toCellVm(r, m)),
    }));
  });

  /** Per-month totals row: confirmed/planned demand vs capacity FTE. */
  protected totalsRow = computed<TotalsVm[]>(() => {
    const value = this.capacityRes.value();
    return value.months.map((m) => {
      const t = value.totals[m];
      return {
        month: m,
        confirmed: t?.demandFteConfirmed ?? 0,
        planned: t?.demandFtePlanned ?? 0,
        capacity: t?.capacityFte ?? 0,
      };
    });
  });

  // --- KPI strip (first month in range) ------------------------------------
  protected kpiPlanned = computed(() => {
    const fm = this.firstMonth();
    return fm ? this.capacityRes.value().totals[fm]?.demandFtePlanned ?? 0 : 0;
  });
  protected kpiCapacity = computed(() => {
    const fm = this.firstMonth();
    return fm ? this.capacityRes.value().totals[fm]?.capacityFte ?? 0 : 0;
  });
  protected kpiOver = computed(() => {
    const fm = this.firstMonth();
    if (!fm) return 0;
    return this.capacityRes.value().rows.filter((r) => r.monthly[fm]?.band === 'over').length;
  });

  /** Range-selector options: the loaded window padded by ±OPTION_PAD_MONTHS so the user can narrow OR extend. */
  protected monthOptions = computed<string[]>(() => {
    const ms = this.months();
    if (ms.length === 0) return [];
    return monthsInRange(shiftMonth(ms[0], -OPTION_PAD_MONTHS), shiftMonth(ms[ms.length - 1], OPTION_PAD_MONTHS));
  });

  protected readonly legend = [
    { band: 'idle' as const, meta: BAND_META.idle, range: '< 50%' },
    { band: 'under' as const, meta: BAND_META.under, range: '50–85%' },
    { band: 'healthy' as const, meta: BAND_META.healthy, range: '85–105%' },
    { band: 'over' as const, meta: BAND_META.over, range: '> 105%' },
  ];

  // --- range selector handlers (string 'YYYY-MM' compares lexicographically) -
  protected onFromChange(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.fromSel.set(v);
    const to = this.toSel();
    if (to && v > to) this.toSel.set(v);
  }

  protected onToChange(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.toSel.set(v);
    const from = this.fromSel();
    if (from && v < from) this.fromSel.set(v);
  }

  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  protected monthLabel(month: string): string {
    return CapacityComponent.MONTH_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  private static readonly MONTH_LONG_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  private monthLabelLong(month: string): string {
    return CapacityComponent.MONTH_LONG_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  /** Build one cell view model, precomputing tone tokens + the WCAG hours aria-label. */
  private toCellVm(row: CapacityRow, month: string): CellVm {
    const cell = row.monthly[month];
    if (!cell) {
      return {
        month,
        present: false,
        band: 'idle',
        meta: BAND_META.idle,
        plannedPct: 0,
        confirmedPct: 0,
        confirmedWidth: 0,
        aria: `${row.resourceName} — ${this.monthLabelLong(month)}: not active`,
      };
    }
    const plannedPct = cell.ftePlanned * 100;
    const confirmedPct = cell.fteConfirmed * 100;
    const confirmedWidth = cell.plannedHours > 0 ? Math.min(100, (cell.confirmedHours / cell.plannedHours) * 100) : 0;
    const meta = BAND_META[cell.band];
    const aria =
      `${row.resourceName}, ${this.monthLabelLong(month)}: planned ${Math.round(cell.plannedHours)}h of ` +
      `${Math.round(cell.targetHours)}h target (${Math.round(plannedPct)}%), confirmed ${Math.round(cell.confirmedHours)}h ` +
      `(${Math.round(confirmedPct)}%). Utilisation band: ${meta.label}.`;
    return { month, present: true, band: cell.band, meta, plannedPct, confirmedPct, confirmedWidth, aria };
  }

  // --- export (SSR-safe; guarded on the browser) ---------------------------
  protected exportCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const value = this.capacityRes.value();
    const cols: CsvColumn<CapacityRow>[] = [{ key: 'resourceName', header: 'Resource' }];
    for (const m of value.months) {
      const label = this.monthLabel(m);
      cols.push({ key: m, header: `${label} Planned FTE`, map: (r) => (r.monthly[m]?.ftePlanned ?? 0).toFixed(2) });
      cols.push({ key: m, header: `${label} Confirmed FTE`, map: (r) => (r.monthly[m]?.fteConfirmed ?? 0).toFixed(2) });
      cols.push({ key: m, header: `${label} Band`, map: (r) => r.monthly[m]?.band ?? 'n/a' });
    }
    downloadCsv('capacity-monthly.csv', toCsv(value.rows, cols));
  }

  protected exportJson(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    downloadJson('capacity-monthly.json', toJson(this.capacityRes.value()));
  }
}
