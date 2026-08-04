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
const EMPTY: CapacityMonthly = { months: [], rows: [], demandRows: [], totals: {} };

/** How many months to pad the range-selector option list beyond the loaded window. */
const OPTION_PAD_MONTHS = 6;

/**
 * CSV `Section` values. The export flattens the screen's two blocks into one
 * sheet, so every line has to say which it belongs to — and the demand block's
 * Band cells key off this discriminator rather than the row's inert `band`.
 */
const SECTION_INTERNAL = 'Internal capacity';
const SECTION_DEMAND = 'Uncovered demand';

/** A `CapacityRow` tagged with the block it came from, for the flattened CSV. */
type ExportRow = CapacityRow & { section: string };

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

/**
 * C1: one rendered demand-grid cell. Dummy/subco cells share the server's
 * `CapacityCell` shape but never carry a band — no `meta`/`band` fields here,
 * so the template has nothing to accidentally tint.
 */
interface DemandCellVm {
  month: string;
  /** False when the resource has no cell that month (inactive). */
  present: boolean;
  plannedFte: number;
  plannedHours: number;
  confirmedHours: number;
  aria: string;
}

interface DemandRowVm {
  resourceId: string;
  resourceName: string;
  cells: DemandCellVm[];
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
              <select (change)="onFromChange($event)" aria-label="Range start month" class="command-select">
                @for (m of monthOptions(); track m) {
                  <option [value]="m" [selected]="m === fromSel()">{{ monthLabel(m) }}</option>
                }
              </select>
            </label>
            <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
              <span class="text-ink-muted">To</span>
              <select (change)="onToChange($event)" aria-label="Range end month" class="command-select">
                @for (m of monthOptions(); track m) {
                  <option [value]="m" [selected]="m === toSel()">{{ monthLabel(m) }}</option>
                }
              </select>
            </label>
          }
          <!-- C1: a window whose only content is uncovered demand (every planned
               hour on dummies, nobody internal in range) is still exportable —
               gating on the internal rows alone made the one figure the
               forecast block needs unreachable. -->
          <div class="flex items-center gap-2">
            <button type="button" (click)="exportCsv()" [disabled]="!hasExportableRows()" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> CSV
            </button>
            <button type="button" (click)="exportJson()" [disabled]="!hasExportableRows()" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
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
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
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
          <div class="command-kpi" [class.danger]="kpiUncovered() > 0">
            <p class="command-kpi-label">Uncovered Demand — {{ monthLabel(fm) }}</p>
            <p class="command-kpi-value font-mono tabular-nums" [class.text-critical-text]="kpiUncovered() > 0" data-test="kpi-uncovered">{{ kpiUncovered() | number:'1.1-1' }} <span class="text-base font-semibold text-ink-muted">FTE</span></p>
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
        <ng-template>
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
                                 data-test="band-cell"
                                 [attr.data-cell]="row.resourceId + '-' + c.month"
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
                        <div class="font-mono tabular-nums text-sm" [class.text-critical-text]="t.planned > t.capacity + 1e-9">
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
        </ng-template>
      </app-list-state>

      <!-- Uncovered demand (C1): dummy/subco resources have no capacity of their
           own, so they never appear in the grid above or its semaphore band —
           this section shows what is booked against them instead, plainly, with
           no band tint (mirrors how allocation-approvals.component.ts suppresses
           the band for the same kinds). -->
      @if (demandRows().length > 0) {
        <div class="space-y-3">
          <div>
            <h2 class="text-lg font-bold text-ink">Uncovered demand</h2>
            <p class="text-sm text-ink-secondary">Booked against dummy placeholders and subcontractors, which have no capacity of their own — this is demand waiting on real headcount, not the saturation of an existing resource.</p>
          </div>
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
                  @for (row of demandRows(); track row.resourceId) {
                    <tr class="hover:bg-surface-muted transition-colors" data-test="demand-row">
                      <td class="px-4 sm:px-6 py-4 font-bold text-ink whitespace-nowrap sticky left-0 bg-surface z-10">{{ row.resourceName }}</td>
                      @for (c of row.cells; track c.month) {
                        <td class="px-2 py-2 align-top">
                          @if (c.present) {
                            <div class="rounded-lg ring-1 ring-line bg-surface-muted p-2 text-center" [attr.aria-label]="c.aria">
                              <div class="text-base font-bold font-mono tabular-nums text-ink">{{ c.plannedFte | number:'1.1-1' }} <span class="text-[10px] font-semibold text-ink-muted">FTE</span></div>
                              <div class="mt-1 text-[10px] font-mono tabular-nums text-ink-muted">
                                {{ c.plannedHours | number:'1.0-0' }}h planned
                                @if (c.confirmedHours > 0) {
                                  ({{ c.confirmedHours | number:'1.0-0' }}h confirmed)
                                }
                              </div>
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
              </table>
            </div>
          </div>
        </div>
      }
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

  /** C1: dummy/subco rows — same monthly cells as `rows`, but rendered
   *  without a semaphore band (see `toDemandCellVm`). */
  protected demandRows = computed<DemandRowVm[]>(() => {
    const value = this.capacityRes.value();
    const months = value.months;
    return value.demandRows.map((r) => ({
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      cells: months.map((m) => this.toDemandCellVm(r, m)),
    }));
  });

  /** Either block has something to write — see the export buttons' disabled state. */
  protected hasExportableRows = computed(() => this.rows().length > 0 || this.demandRows().length > 0);

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
  /** C1: planned FTE booked on dummy/subco for the first month — capacity that does not exist yet. */
  protected kpiUncovered = computed(() => {
    const fm = this.firstMonth();
    return fm ? this.capacityRes.value().totals[fm]?.demandFteUncovered ?? 0 : 0;
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

  /**
   * Build one demand-cell view model. C1: a dummy/subco has no capacity to
   * saturate (manual §4.3, mirrors `AllocationApprovalsComponent.toCellVm`'s
   * `tracksSaturation` gate) — the accessible name states the hours plainly
   * and never announces a band, since the server's `band: 'idle'` on this
   * cell is an inert placeholder, not a real judgement.
   */
  private toDemandCellVm(row: CapacityRow, month: string): DemandCellVm {
    const cell = row.monthly[month];
    if (!cell) {
      return {
        month, present: false, plannedFte: 0, plannedHours: 0, confirmedHours: 0,
        aria: `${row.resourceName} — ${this.monthLabelLong(month)}: not active`,
      };
    }
    const aria =
      `${row.resourceName}, ${this.monthLabelLong(month)}: ${Math.round(cell.plannedHours)}h planned ` +
      `(${cell.ftePlanned.toFixed(1)} FTE), ${Math.round(cell.confirmedHours)}h confirmed — ` +
      `uncovered demand, no capacity of its own to band.`;
    return { month, present: true, plannedFte: cell.ftePlanned, plannedHours: cell.plannedHours, confirmedHours: cell.confirmedHours, aria };
  }

  // --- export (SSR-safe; guarded on the browser) ---------------------------
  /**
   * CSV of BOTH blocks the screen shows: the internal capacity grid and the C1
   * uncovered-demand section. Exporting only `rows` would silently drop the
   * dummy/subco demand a user just read off the KPI strip ("3.0 FTE uncovered
   * demand"), and would disagree with `exportJson()`, which serialises the whole
   * envelope. `demandFteUncovered` is the figure the hiring/subco forecast block
   * consumes, and this file is the hand-off artefact.
   *
   * A leading Section column keeps the two blocks apart. The Band cells of a
   * demand row read 'n/a', never the envelope's inert `band: 'idle'` — a
   * dummy/subco has no capacity to saturate, so it has no band (spec §4.3), and
   * writing 'idle' into a spreadsheet would invite exactly the misreading the
   * on-screen table is careful to avoid.
   */
  protected exportCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    downloadCsv('capacity-monthly.csv', this.buildCsv());
  }

  /** The exact CSV text `exportCsv()` writes — split out so it is assertable without a DOM download. */
  protected buildCsv(): string {
    const value = this.capacityRes.value();
    const rows: ExportRow[] = [
      ...value.rows.map((r) => ({ ...r, section: SECTION_INTERNAL })),
      ...value.demandRows.map((r) => ({ ...r, section: SECTION_DEMAND })),
    ];
    const cols: CsvColumn<ExportRow>[] = [
      { key: 'section', header: 'Section' },
      { key: 'resourceName', header: 'Resource' },
    ];
    for (const m of value.months) {
      const label = this.monthLabel(m);
      cols.push({ key: m, header: `${label} Planned FTE`, map: (r) => (r.monthly[m]?.ftePlanned ?? 0).toFixed(2) });
      cols.push({ key: m, header: `${label} Confirmed FTE`, map: (r) => (r.monthly[m]?.fteConfirmed ?? 0).toFixed(2) });
      cols.push({ key: m, header: `${label} Band`, map: (r) => (r.section === SECTION_DEMAND ? 'n/a' : r.monthly[m]?.band ?? 'n/a') });
    }
    return toCsv(rows, cols);
  }

  protected exportJson(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    downloadJson('capacity-monthly.json', toJson(this.capacityRes.value()));
  }
}
