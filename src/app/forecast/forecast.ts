import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { DecimalPipe, isPlatformBrowser } from '@angular/common';
import { forkJoin } from 'rxjs';
import { ApiService } from '../services/api.service';
import {
  ForecastData,
  CapacityPeriod,
  BenchEntry,
  OverAllocationEntry,
  SkillGapEntry,
  capacityForecast,
  benchList,
  overAllocated,
  skillGap,
} from '../services/forecast.util';
import { toCsv, downloadCsv, CsvColumn } from '../services/export.util';

/** Selectable rolling horizon, in weeks. */
type Horizon = 8 | 12;

/** Gap band used to colour utilisation: spare / healthy / over capacity. */
type GapBand = 'under' | 'tight' | 'over';

/** A capacity period enriched with display-only geometry (bar widths + band). */
interface PeriodRow extends CapacityPeriod {
  /** Supply bar width as a % of the horizon's busiest period. */
  supplyPct: number;
  /** Committed-demand bar width as a % of the horizon's busiest period. */
  committedPct: number;
  /** Pipeline-demand bar width as a % of the horizon's busiest period. */
  pipelinePct: number;
  /** Utilisation band driving the gap colour. */
  band: GapBand;
  /** Short label for the period start (e.g. "12 May"). */
  label: string;
}

@Component({
  selector: 'app-forecast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Capacity Control</div>
          <h1 class="command-title">Demand &amp; Capacity Forecast</h1>
          <p class="command-subtitle">
            Rolling supply-versus-demand outlook from committed bookings and the unstaffed pipeline,
            with bench availability, over-allocation pressure and skill shortages.
          </p>
        </div>
        <div class="flex flex-col items-stretch gap-2 sm:items-end">
          <span class="command-section-label">Horizon</span>
          <div class="inline-flex rounded-md border border-[var(--cc-line-strong)] bg-[var(--cc-surface)] p-1" role="group" aria-label="Forecast horizon in weeks">
            @for (h of horizons; track h) {
              <button
                type="button"
                (click)="setHorizon(h)"
                [attr.aria-pressed]="horizon() === h"
                class="rounded px-4 py-1.5 text-sm font-semibold font-mono tabular-nums transition-colors"
                [class]="horizon() === h ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 hover:text-blue-700'">
                {{ h }}w
              </button>
            }
          </div>
        </div>
      </header>

      @if (hasData()) {
        <!-- KPI strip -->
        <section class="grid grid-cols-2 gap-4 sm:gap-6 lg:grid-cols-5" aria-label="Capacity key metrics">
          <div class="command-kpi" [class.warning]="avgBand() === 'tight'" [class.danger]="avgBand() === 'over'" [class.green]="avgBand() === 'under'">
            <p class="command-kpi-label">Avg Utilization</p>
            <p class="command-kpi-value">{{ avgUtilization() | number: '1.0-0' }}%</p>
            <p class="command-kpi-note">Mean across {{ horizon() }} weeks</p>
          </div>
          <div class="command-kpi info">
            <p class="command-kpi-label">Total Supply</p>
            <p class="command-kpi-value">{{ totalSupply() | number: '1.0-0' }}</p>
            <p class="command-kpi-note">Capacity hours / week</p>
          </div>
          <div class="command-kpi" [class.danger]="totalDemand() > totalSupply()">
            <p class="command-kpi-label">Total Demand</p>
            <p class="command-kpi-value">{{ peakDemand() | number: '1.0-0' }}</p>
            <p class="command-kpi-note">Peak weekly hours</p>
          </div>
          <div class="command-kpi green">
            <p class="command-kpi-label">On Bench</p>
            <p class="command-kpi-value">{{ benchCount() }}</p>
            <p class="command-kpi-note">{{ benchAvailableHours() | number: '1.0-0' }}h available</p>
          </div>
          <div class="command-kpi" [class.danger]="overCount() > 0" [class.green]="overCount() === 0">
            <p class="command-kpi-label">Over-Allocated</p>
            <p class="command-kpi-value">{{ overCount() }}</p>
            <p class="command-kpi-note">Above 110% utilization</p>
          </div>
        </section>

        <!-- Capacity timeline -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Supply vs Demand Timeline</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Per week: committed plus pipeline demand against available supply.</p>
            </div>
            <div class="flex flex-wrap items-center gap-3 text-xs text-[var(--cc-muted)]">
              <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-slate-300"></span>Supply</span>
              <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-blue-600"></span>Committed</span>
              <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-blue-300"></span>Pipeline</span>
              @if (canExport()) {
                <button type="button" class="command-button secondary" (click)="exportTimeline()">Export CSV</button>
              }
            </div>
          </div>

          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <th scope="col">Capacity profile</th>
                  <th scope="col" class="num">Supply</th>
                  <th scope="col" class="num">Demand</th>
                  <th scope="col" class="num">Util %</th>
                  <th scope="col" class="num">Gap</th>
                </tr>
              </thead>
              <tbody>
                @for (row of periodRows(); track row.period) {
                  <tr>
                    <td class="font-mono whitespace-nowrap">{{ row.label }}</td>
                    <td class="min-w-[14rem]">
                      <div class="space-y-1.5" [attr.aria-label]="row.committed + ' committed plus ' + row.pipeline + ' pipeline hours against ' + row.supply + ' supply'">
                        <!-- Supply track -->
                        <div class="h-2 overflow-hidden rounded-full bg-slate-100">
                          <span class="block h-full rounded-full bg-slate-300" [style.width.%]="row.supplyPct"></span>
                        </div>
                        <!-- Demand track: committed + pipeline stacked -->
                        <div class="flex h-2 overflow-hidden rounded-full bg-slate-100">
                          <span class="block h-full bg-blue-600" [style.width.%]="row.committedPct"></span>
                          <span class="block h-full bg-blue-300" [style.width.%]="row.pipelinePct"></span>
                        </div>
                      </div>
                    </td>
                    <td class="num">{{ row.supply | number: '1.0-0' }}</td>
                    <td class="num">{{ row.demand | number: '1.0-0' }}</td>
                    <td class="num">
                      <span class="command-status"
                            [class.green]="row.band === 'under'"
                            [class.amber]="row.band === 'tight'"
                            [class.red]="row.band === 'over'">
                        {{ row.utilizationPct | number: '1.0-0' }}%
                      </span>
                    </td>
                    <td class="num font-semibold" [style.color]="row.gap < 0 ? 'var(--cc-red)' : 'var(--cc-green)'">
                      {{ row.gap | number: '1.0-0' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <div class="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <!-- Bench -->
          <section class="command-card overflow-hidden">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Bench</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Under-allocated resources with spare hours.</p>
              </div>
              <span class="command-status green">{{ benchCount() }}</span>
            </div>
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    <th scope="col">Role</th>
                    <th scope="col" class="num">Util %</th>
                    <th scope="col" class="num">Available</th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of bench(); track b.resourceId) {
                    <tr>
                      <td class="font-semibold text-[var(--cc-ink)]">{{ b.name }}</td>
                      <td class="text-[var(--cc-muted)]">{{ b.role }}</td>
                      <td class="num">{{ b.utilization | number: '1.0-0' }}%</td>
                      <td class="num font-semibold" style="color: var(--cc-green)">{{ b.availableHours | number: '1.0-0' }}h</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="4" class="text-center text-[var(--cc-muted)]">No bench — every resource is fully allocated.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>

          <!-- Over-allocated -->
          <section class="command-card overflow-hidden">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Over-Allocated</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Resources booked beyond sustainable capacity.</p>
              </div>
              <span class="command-status" [class.red]="overCount() > 0" [class.green]="overCount() === 0">{{ overCount() }}</span>
            </div>
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    <th scope="col">Role</th>
                    <th scope="col" class="num">Util %</th>
                    <th scope="col" class="num">Over by</th>
                  </tr>
                </thead>
                <tbody>
                  @for (o of overAllocations(); track o.resourceId) {
                    <tr>
                      <td class="font-semibold text-[var(--cc-ink)]">{{ o.name }}</td>
                      <td class="text-[var(--cc-muted)]">{{ o.role }}</td>
                      <td class="num">
                        <span class="command-status red">{{ o.utilization | number: '1.0-0' }}%</span>
                      </td>
                      <td class="num font-semibold" style="color: var(--cc-red)">{{ o.overByHours | number: '1.0-0' }}h</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="4" class="text-center text-[var(--cc-muted)]">No over-allocations — capacity is within limits.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <!-- Skill gap -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Skill Gap</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Demand from open requests against the resources that cover each skill.</p>
            </div>
            <div class="flex items-center gap-3">
              <span class="command-status" [class.red]="shortageCount() > 0" [class.green]="shortageCount() === 0">
                {{ shortageCount() }} shortage{{ shortageCount() === 1 ? '' : 's' }}
              </span>
              @if (canExport()) {
                <button type="button" class="command-button secondary" (click)="exportSkillGap()">Export CSV</button>
              }
            </div>
          </div>
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th scope="col">Skill</th>
                  <th scope="col" class="num">Demand (req)</th>
                  <th scope="col" class="num">Demand (h)</th>
                  <th scope="col" class="num">Covered by</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                @for (s of skills(); track s.skill) {
                  <tr>
                    <td class="font-semibold text-[var(--cc-ink)]">{{ s.skill }}</td>
                    <td class="num">{{ s.demandCount }}</td>
                    <td class="num">{{ s.demandHours | number: '1.0-0' }}</td>
                    <td class="num">{{ s.supplyCount }}</td>
                    <td>
                      <span class="command-status"
                            [class.red]="s.shortage"
                            [class.amber]="!s.shortage && s.supplyCount < s.demandCount"
                            [class.green]="!s.shortage && s.supplyCount >= s.demandCount">
                        {{ s.shortage ? 'No coverage' : (s.supplyCount < s.demandCount ? 'Thin' : 'Covered') }}
                      </span>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="text-center text-[var(--cc-muted)]">No open requests demand specific skills.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else if (!loading()) {
        <div class="command-card">
          <div class="command-empty">
            <div class="command-empty-title">No forecast data yet</div>
            <p class="command-empty-note">
              Add resources with capacity, then create resource requests and assignments to build a
              demand-and-capacity outlook.
            </p>
          </div>
        </div>
      }
    </div>
  `,
})
export class Forecast {
  private api = inject(ApiService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** True only in the browser, where the CSV download primitives are available. */
  readonly canExport = computed<boolean>(() => this.isBrowser && this.hasData());

  /** Available horizon options, in weeks. */
  readonly horizons: readonly Horizon[] = [8, 12];

  /** Selected rolling horizon (weeks). */
  readonly horizon = signal<Horizon>(8);

  private readonly dataRes = rxResource<ForecastData, unknown>({
    stream: () =>
      forkJoin({
        resources: this.api.getResources(),
        requests: this.api.getRequests(),
        assignments: this.api.getAssignments(),
      }),
    defaultValue: { resources: [], requests: [], assignments: [] },
  });

  /** True while the initial load is in flight. */
  readonly loading = computed(() => this.dataRes.isLoading());

  /** Strongly-typed forecast inputs derived from the loaded resource. */
  private readonly forecastData = computed<ForecastData>(() => {
    const d = this.dataRes.value();
    return { resources: d.resources, requests: d.requests, assignments: d.assignments };
  });

  readonly hasData = computed<boolean>(() => {
    const d = this.forecastData();
    return d.resources.length > 0 || d.requests.length > 0 || d.assignments.length > 0;
  });

  /** Horizon start = today (UTC midnight), so periods line up with calendar weeks. */
  private readonly horizonStartIso = computed<string>(() => new Date().toISOString().slice(0, 10));

  /** Raw rolling capacity forecast for the selected horizon. */
  private readonly periods = computed<CapacityPeriod[]>(() =>
    capacityForecast(this.forecastData(), this.horizonStartIso(), this.horizon(), 'weekly'),
  );

  /** Capacity periods enriched with bar geometry + colour band for the timeline. */
  readonly periodRows = computed<PeriodRow[]>(() => {
    const rows = this.periods();
    // Scale every bar against the busiest figure across the horizon (>=1 to avoid /0).
    const scale = Math.max(1, ...rows.map(r => Math.max(r.supply, r.demand)));
    const pct = (v: number) => Math.min(100, Math.max(0, (v / scale) * 100));
    return rows.map(r => ({
      ...r,
      supplyPct: pct(r.supply),
      committedPct: pct(r.committed),
      pipelinePct: pct(r.pipeline),
      band: this.bandFor(r.utilizationPct),
      label: this.shortDate(r.period),
    }));
  });

  // --- KPI strip ---

  readonly totalSupply = computed<number>(() => this.periods()[0]?.supply ?? 0);

  readonly totalDemand = computed<number>(() =>
    this.periods().reduce((acc, r) => acc + r.demand, 0),
  );

  readonly peakDemand = computed<number>(() =>
    this.periods().reduce((max, r) => Math.max(max, r.demand), 0),
  );

  readonly avgUtilization = computed<number>(() => {
    const rows = this.periods();
    if (!rows.length) return 0;
    return rows.reduce((acc, r) => acc + r.utilizationPct, 0) / rows.length;
  });

  readonly avgBand = computed<GapBand>(() => this.bandFor(this.avgUtilization()));

  // --- Bench / over-allocation / skills ---

  readonly bench = computed<BenchEntry[]>(() => benchList(this.forecastData()));
  readonly benchCount = computed<number>(() => this.bench().length);
  readonly benchAvailableHours = computed<number>(() =>
    this.bench().reduce((acc, b) => acc + b.availableHours, 0),
  );

  readonly overAllocations = computed<OverAllocationEntry[]>(() => overAllocated(this.forecastData()));
  readonly overCount = computed<number>(() => this.overAllocations().length);

  readonly skills = computed<SkillGapEntry[]>(() => skillGap(this.forecastData()));
  readonly shortageCount = computed<number>(() => this.skills().filter(s => s.shortage).length);

  setHorizon(h: Horizon): void {
    this.horizon.set(h);
  }

  /** Export the capacity timeline (per-period supply/demand/util/gap) as CSV. */
  exportTimeline(): void {
    if (!this.isBrowser) return;
    const columns: readonly CsvColumn<CapacityPeriod>[] = [
      { key: 'period', header: 'Period' },
      { key: 'supply', header: 'Supply' },
      { key: 'committed', header: 'Committed' },
      { key: 'pipeline', header: 'Pipeline' },
      { key: 'demand', header: 'Demand' },
      { key: 'utilizationPct', header: 'Utilization %' },
      { key: 'gap', header: 'Gap' },
    ];
    downloadCsv(`capacity-timeline-${this.horizon()}w.csv`, toCsv(this.periods(), columns));
  }

  /** Export the skill-gap table (demand hours, supply count, shortage flag) as CSV. */
  exportSkillGap(): void {
    if (!this.isBrowser) return;
    const columns: readonly CsvColumn<SkillGapEntry>[] = [
      { key: 'skill', header: 'Skill' },
      { key: 'demandHours', header: 'Demand Hours' },
      { key: 'supplyCount', header: 'Supply Count' },
      { key: 'shortage', header: 'Shortage' },
    ];
    downloadCsv('skill-gap.csv', toCsv(this.skills(), columns));
  }

  /** Utilisation → colour band: <85% spare, 85–100% tight, >100% over capacity. */
  private bandFor(utilizationPct: number): GapBand {
    if (utilizationPct > 100) return 'over';
    if (utilizationPct >= 85) return 'tight';
    return 'under';
  }

  /** ISO date → "12 May" style label (UTC, time-zone stable). */
  private shortDate(iso: string): string {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
}
