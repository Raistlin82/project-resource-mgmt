import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { DecimalPipe, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { forkJoin, of, map } from 'rxjs';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import {
  ForecastData,
  CapacityPeriod,
  OverAllocationEntry,
  SkillGapEntry,
  capacityForecast,
  overAllocated,
  skillGap,
} from '../services/forecast.util';
import { notFullyAllocatedAt, type BenchRow } from '../services/bench.util';
import { toCsv, downloadCsv, CsvColumn } from '../services/export.util';
import { todayLocalIso } from '../services/local-date.util';
import { DEFAULT_HOURS_PER_DAY } from '../services/sell-rate.util';
import {
  CommandBarChartComponent,
  CommandTrendChartComponent,
  BarSeries,
  TrendSeries,
} from '../shared/charts';
import { ListStateComponent } from '../shared/list-state.component';

/** Selectable rolling horizon, in weeks. */
type Horizon = 8 | 12;

/** Gap band used to colour utilisation: spare / healthy / over capacity. */
type GapBand = 'under' | 'tight' | 'over';

/** A capacity period enriched with display-only band + label for the table. */
interface PeriodRow extends CapacityPeriod {
  /** Utilisation band driving the gap colour. */
  band: GapBand;
  /** Short label for the period start (e.g. "12 May"). */
  label: string;
}

@Component({
  selector: 'app-forecast',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DecimalPipe, RouterLink, CommandBarChartComponent, CommandTrendChartComponent, ListStateComponent],
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
                [class]="horizon() === h ? 'bg-accent text-white shadow-sm' : 'text-ink-secondary hover:text-accent-text'">
                {{ h }}w
              </button>
            }
          </div>
        </div>
      </header>

      <app-list-state [loading]="loading()" [error]="dataRes.status() === 'error'"
                      label="forecast data" (retry)="dataRes.reload()">
        <ng-template>
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
          <div class="command-kpi" [class.danger]="peakDemand() > totalSupply()">
            <p class="command-kpi-label">Total Demand</p>
            <p class="command-kpi-value">{{ peakDemand() | number: '1.0-0' }}</p>
            <p class="command-kpi-note">Peak weekly hours</p>
          </div>
          <div class="command-kpi green">
            <p class="command-kpi-label">On Bench</p>
            <p class="command-kpi-value">{{ benchCount() }}</p>
            <p class="command-kpi-note">{{ benchIdleCount() }} idle &middot; {{ benchPartialCount() }} partial</p>
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
              @if (canExport()) {
                <button type="button" class="command-button secondary" (click)="exportTimeline()">Export CSV</button>
              }
            </div>
          </div>

          <!-- Supply (Σ capacity) vs the committed + pipeline demand stack, per week. -->
          <div class="px-5 pt-4">
            <command-bar-chart
              [categories]="weekLabels()"
              [series]="capacitySeries()"
              [stacked]="false"
              [height]="300"
              formatKind="number"
              ariaLabel="Supply versus committed and pipeline demand by week"
              caption="Weekly supply, committed and pipeline demand in hours" />
          </div>

          <!-- Utilisation trend across the horizon, against the 100% capacity line. -->
          <div class="px-5 pb-2">
            <command-trend-chart
              [categories]="weekLabels()"
              [series]="utilizationSeries()"
              mode="area" [smooth]="true"
              formatKind="percent"
              ariaLabel="Weekly utilization versus 100% capacity"
              caption="Weekly utilization percentage against the 100% capacity line" />
          </div>

          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th scope="col">Week of</th>
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
                    <td class="num font-semibold" [style.color]="row.gap < 0 ? 'var(--cc-red)' : 'var(--cc-green-text)'">
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
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Not fully allocated this month (BENCH or PARTIAL) — see the full 6-month view on <a routerLink="/bench" class="font-semibold text-[var(--cc-primary-text)]">Bench</a>.</p>
              </div>
              <span class="command-status green">{{ benchCount() }}</span>
            </div>
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th scope="col">Resource</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  @for (b of bench(); track b.resourceId) {
                    <tr>
                      <td class="font-semibold text-[var(--cc-ink)]">{{ b.resourceName }}</td>
                      <td class="text-[var(--cc-muted)] capitalize">{{ b.kind }}</td>
                      <td>
                        <span class="command-status" [class.red]="b.monthly[currentMonth()]?.state === 'BENCH'" [class.amber]="b.monthly[currentMonth()]?.state === 'PARTIAL'">
                          {{ b.monthly[currentMonth()]?.state }}
                        </span>
                      </td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="3" class="text-center text-[var(--cc-muted)]">No bench — every resource is fully allocated.</td>
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
      } @else {
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
        </ng-template>
      </app-list-state>
    </div>
  `,
})
export class Forecast {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** True only in the browser, where the CSV download primitives are available. */
  readonly canExport = computed<boolean>(() => this.isBrowser && this.hasData());

  /** Available horizon options, in weeks. */
  readonly horizons: readonly Horizon[] = [8, 12];

  /** Selected rolling horizon (weeks). */
  readonly horizon = signal<Horizon>(8);

  private static readonly EMPTY_DATA: ForecastData = {
    resources: [], requests: [], assignments: [], assignmentDays: [], assignmentMonths: [], holidays: [], hoursPerDay: DEFAULT_HOURS_PER_DAY,
  };

  // resources is principal-gated server-side: key the forkJoin on auth readiness
  // so it fires only AFTER the OAuth bootstrap has settled and the bearer token is
  // attached; firing earlier (e.g. on a reload/deep-link) sent an unauthenticated
  // request that 401'd and forkJoin's fail-fast collapsed the forecast to empty.
  // `protected` (not `private`): the template reads `dataRes.status()`/`.reload()`
  // directly for the error-state branch, per this repo's established pattern
  // (see e.g. `my-assignments.component.ts`, `customers.ts`).
  protected readonly dataRes = rxResource<ForecastData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            resources: this.api.getResources(),
            requests: this.api.getRequests(),
            assignments: this.api.getAssignments(),
            assignmentDays: this.api.getAssignmentDays(),
            assignmentMonths: this.api.getAssignmentMonths(),
            holidays: this.api.getHolidays(),
            hoursPerDay: this.api.getHoursPerDay().pipe(map(r => r.value)),
          })
        : of<ForecastData>(Forecast.EMPTY_DATA),
    defaultValue: Forecast.EMPTY_DATA,
  });

  /** True while the initial load is in flight. */
  readonly loading = computed(() => this.dataRes.isLoading());

  /** Strongly-typed forecast inputs derived from the loaded resource. */
  private readonly forecastData = computed<ForecastData>(() => this.dataRes.value());

  readonly hasData = computed<boolean>(() => {
    const d = this.forecastData();
    return d.resources.length > 0 || d.requests.length > 0 || d.assignments.length > 0;
  });

  /** Horizon start = today (UTC midnight), so periods line up with calendar weeks. */
  private readonly horizonStartIso = computed<string>(() => todayLocalIso());

  /** Raw rolling capacity forecast for the selected horizon. */
  private readonly periods = computed<CapacityPeriod[]>(() =>
    capacityForecast(this.forecastData(), this.horizonStartIso(), this.horizon(), 'weekly'),
  );

  /** Capacity periods enriched with colour band + short label for the table. */
  readonly periodRows = computed<PeriodRow[]>(() => {
    return this.periods().map(r => ({
      ...r,
      band: this.bandFor(r.utilizationPct),
      label: this.shortDate(r.period),
    }));
  });

  /** Week-start labels (e.g. "12 May") shared by the bar + trend charts. */
  readonly weekLabels = computed<string[]>(() => this.periods().map(r => this.shortDate(r.period)));

  /**
   * Capacity bar series — Supply (series-6/slate), Committed (accent), Pipeline (series-2/teal).
   * Committed and Pipeline get genuinely distinct tones so the two demand bands (and
   * their matching legend swatches) never collapse to the same colour.
   */
  readonly capacitySeries = computed<BarSeries[]>(() => {
    const rows = this.periods();
    return [
      { name: 'Supply', values: rows.map(r => r.supply), color: 'var(--color-series-6)' },
      { name: 'Committed', values: rows.map(r => r.committed), color: 'var(--color-accent)' },
      { name: 'Pipeline', values: rows.map(r => r.pipeline), color: 'var(--color-series-2)' },
    ];
  });

  /**
   * Utilisation trend (as a 0..1 fraction so the percent formatter renders 42%
   * etc.) against a flat 100%-capacity reference line.
   */
  readonly utilizationSeries = computed<TrendSeries[]>(() => {
    const rows = this.periods();
    return [
      { name: 'Utilization', values: rows.map(r => r.utilizationPct / 100) },
      { name: 'Capacity', values: rows.map(() => 1) },
    ];
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

  // Both `currentMonth` and `bench` are read directly by the template (the
  // Bench table's status cell and `@for` loop) — kept public/readonly rather
  // than `private`, matching this file's existing convention for every other
  // template-bound computed (`hasData`, `periodRows`, `skills`, etc.).
  readonly currentMonth = computed<string>(() => this.horizonStartIso().slice(0, 7));

  readonly bench = computed<BenchRow[]>(() => {
    const d = this.forecastData();
    const input = {
      resources: d.resources, assignments: d.assignments, assignmentDays: d.assignmentDays,
      assignmentMonths: d.assignmentMonths, hoursPerDay: d.hoursPerDay,
      holidays: new Set(d.holidays.map(h => h.id)),
    };
    return notFullyAllocatedAt(input, this.currentMonth(), todayLocalIso());
  });
  readonly benchCount = computed<number>(() => this.bench().length);
  readonly benchIdleCount = computed<number>(() =>
    this.bench().filter(r => r.monthly[this.currentMonth()]?.state === 'BENCH').length,
  );
  readonly benchPartialCount = computed<number>(() => this.benchCount() - this.benchIdleCount());

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
      { key: 'utilizationPct', header: 'Utilization %', map: r => r.utilizationPct.toFixed(1) },
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
