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
  UtilizationBand,
  capacityForecast,
  forecastUtilizationBand,
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

/**
 * Round to 2 decimals and stay a NUMBER — the repo-wide display/export rule for
 * hours. Numeric matters: `escapeCsv` emits a finite number verbatim, so a
 * negative Gap (the over-capacity weeks the export exists to flag) is written
 * summable. `.toFixed(2)` would hand it a STRING and make that cell's inertness
 * depend on escapeCsv's numeric-cell regex instead of on its type.
 */
function round2(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/** A capacity period enriched with display-only band + label for the table. */
interface PeriodRow extends CapacityPeriod {
  /** Utilisation band driving the pill colour (`forecastUtilizationBand`). */
  band: UtilizationBand;
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
              <!-- text-ink-inverse, NOT text-white, on the pressed (bg-accent) state.
                   This design system has no 'dark:' variant, so legibility has to be
                   token-side: dark --color-ink-inverse is near-black against the dark
                   accent (>= AA), while a literal white is 3.40:1 there — which made the
                   SELECTED horizon the harder of the two labels to read. -->
              <button
                type="button"
                (click)="setHorizon(h)"
                [attr.aria-pressed]="horizon() === h"
                class="rounded px-4 py-1.5 text-sm font-semibold font-mono tabular-nums transition-colors"
                [class]="horizon() === h ? 'bg-accent text-ink-inverse shadow-sm' : 'text-ink-secondary hover:text-accent-text'">
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
          <!-- Bands come from 'forecastUtilizationBand' (the repo's semaphore), so
               'spare' — below the healthy 85-105 band — is a CAUTION, not green:
               unsold capacity is the bench bill, and painting it green is what made
               one 45% average read as healthy here while /what-if scored the same
               move as bad. 'unknown' (no capacity anywhere in the horizon) carries
               no tone at all and renders "n/a", never 0%. -->
          <div class="command-kpi" [class.warning]="avgBand() === 'spare'" [class.danger]="avgBand() === 'over'" [class.green]="avgBand() === 'healthy'">
            <p class="command-kpi-label">Avg Utilization</p>
            <p class="command-kpi-value">
              @if (avgUtilization() === null) { n/a } @else { {{ avgUtilization() | number: '1.0-0' }}% }
            </p>
            <p class="command-kpi-note">
              @if (avgUtilization() === null) {
                No capacity in the horizon to measure against
              } @else {
                Mean across {{ measuredWeeks() }} of {{ horizon() }} weeks
              }
            </p>
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
          <!-- Bench headcount is UNBILLABLE capacity: green is reserved for an EMPTY
               bench, idle people are critical and partials a caution. The tone used to
               be the static 'green' class, so bench 0 and bench 14 rendered
               byte-identically healthy here while /bench showed the same metric in the
               critical tone. The three conditions are mutually exclusive on purpose —
               .command-kpi.green is declared AFTER .danger/.warning in styles.css, so
               any overlap would let the cascade pick the colour instead of the data. -->
          <div class="command-kpi"
               [class.danger]="benchIdleCount() > 0"
               [class.warning]="benchIdleCount() === 0 && benchPartialCount() > 0"
               [class.green]="benchCount() === 0">
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

          <!-- Supply (Σ capacity) vs the committed + pipeline demand STACK, per week.
               Supply goes through [overlay], not [series]: this chart is stacked, and
               [stacked] stacks every entry of [series], so a Supply left in that list
               would be added ON TOP of the demand it is supposed to be compared with —
               a week booked to exactly its capacity would draw a column of 2x supply
               and read as a shortfall. As an overlay it is a step reference LINE that
               still widens the y-domain, so a supply above the stack raises the axis
               instead of being clipped flat along the top gridline. -->
          <div class="px-5 pt-4">
            <command-bar-chart
              [categories]="weekLabels()"
              [series]="demandSeries()"
              [overlay]="supplyOverlay()"
              [stacked]="true"
              [height]="300"
              formatKind="number"
              ariaLabel="Supply versus committed and pipeline demand by week"
              caption="Weekly supply, committed and pipeline demand in hours" />
          </div>

          <!-- Utilisation trend across the horizon, against the 100% capacity line.
               Plotted over 'measuredWeekLabels()', not 'weekLabels()': a week with no
               supply has NO utilisation, and TrendSeries takes plain numbers, so the
               choices were to plot a 0 (a fabricated idle week — the coercion this fix
               removes) or to omit the point. Both axes drop the same weeks together so
               they stay index-aligned, the omitted weeks are named underneath, and the
               table below still lists every week of the horizon with "n/a". -->
          <div class="px-5 pb-2">
            @if (measuredWeekLabels().length) {
              <command-trend-chart
                [categories]="measuredWeekLabels()"
                [series]="utilizationSeries()"
                mode="area" [smooth]="true"
                formatKind="percent"
                ariaLabel="Weekly utilization versus 100% capacity"
                caption="Weekly utilization percentage against the 100% capacity line" />
            }
            @if (unmeasuredWeekLabels().length) {
              <p class="pb-2 text-xs text-[var(--cc-muted)]" role="status">
                No utilization for {{ unmeasuredWeekLabels().length }} week{{ unmeasuredWeekLabels().length === 1 ? '' : 's' }}
                ({{ unmeasuredWeekLabels().join(', ') }}): there is no capacity then, so there is nothing to measure against.
              </p>
            }
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
                            [class.green]="row.band === 'healthy'"
                            [class.amber]="row.band === 'spare'"
                            [class.red]="row.band === 'over'">
                        @if (row.utilizationPct === null) { n/a } @else { {{ row.utilizationPct | number: '1.0-0' }}% }
                      </span>
                    </td>
                    <!-- --cc-red-text, not --cc-red: this is a 14px figure, so the
                         4.5:1 AA floor applies and the raw fill tone reads 4.47:1 on
                         the dark surface. Its green twin already uses the -text shade;
                         the pair must be measured the same way. -->
                    <td class="num font-semibold" [style.color]="row.gap < 0 ? 'var(--cc-red-text)' : 'var(--cc-green-text)'">
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
              <!-- Same tri-state as the "On Bench" KPI above, and mutually exclusive for
                   the same cascade reason: .command-status.red is declared AFTER .green
                   in styles.css, so overlapping conditions would let the order of the
                   stylesheet decide the chip's colour. -->
              <span class="command-status"
                    [class.red]="benchIdleCount() > 0"
                    [class.amber]="benchIdleCount() === 0 && benchPartialCount() > 0"
                    [class.green]="benchCount() === 0">{{ benchCount() }}</span>
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
                      <!-- Small text again (see the Gap column): the -text shade. -->
                      <td class="num font-semibold" style="color: var(--cc-red-text)">{{ o.overByHours | number: '1.0-0' }}h</td>
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
    resources: [], requests: [], assignments: [], assignmentDays: [], assignmentMonths: [], holidays: [], hoursPerDay: DEFAULT_HOURS_PER_DAY, absences: [],
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
            // The REDACTED feed, never GET /absences: this screen rebuilds the bench
            // rollup in the browser, so it needs the intervals — but a reason is
            // special-category data and its audience is narrower than this one.
            absences: this.api.getAbsenceCalendar(),
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
      band: forecastUtilizationBand(r.utilizationPct),
      label: this.shortDate(r.period),
    }));
  });

  /** Week-start labels (e.g. "12 May") for the supply/demand bar chart. */
  readonly weekLabels = computed<string[]>(() => this.periods().map(r => this.shortDate(r.period)));

  /**
   * The periods whose utilisation is DEFINED (i.e. that have supply). A period
   * with no capacity has no utilisation, so it is excluded from the average and
   * from the trend chart rather than being read as 0% — the whole point of
   * `utilizationPct` being nullable. It still appears in the table, as "n/a".
   */
  private readonly measuredPeriods = computed<PeriodRow[]>(() =>
    this.periodRows().filter(r => r.utilizationPct !== null),
  );

  /** Week labels the utilisation trend can actually plot. */
  readonly measuredWeekLabels = computed<string[]>(() => this.measuredPeriods().map(r => r.label));

  /** Week labels the utilisation trend must omit — named in the note under the chart. */
  readonly unmeasuredWeekLabels = computed<string[]>(() =>
    this.periodRows().filter(r => r.utilizationPct === null).map(r => r.label),
  );

  /**
   * The DEMAND stack only — Committed (accent) over Pipeline (series-2/teal), so the
   * two bands read as one total demand column per week and keep genuinely distinct
   * tones (their legend swatches must never collapse to the same colour).
   *
   * Supply is deliberately NOT here; see {@link supplyOverlay}.
   */
  readonly demandSeries = computed<BarSeries[]>(() => {
    const rows = this.periods();
    return [
      { name: 'Committed', values: rows.map(r => r.committed), color: 'var(--color-accent)' },
      { name: 'Pipeline', values: rows.map(r => r.pipeline), color: 'var(--color-series-2)' },
    ];
  });

  /**
   * Supply (Σ capacity) as the chart's reference overlay rather than a third bar.
   * A stacked chart adds every [series] entry together, so supply-as-a-series would
   * be summed INTO the demand it exists to be measured against; as an overlay it is
   * drawn as a step line that still contributes to the y-domain.
   */
  readonly supplyOverlay = computed<BarSeries>(() => ({
    name: 'Supply',
    values: this.periods().map(r => r.supply),
    color: 'var(--color-series-6)',
  }));

  /**
   * Utilisation trend (as a 0..1 fraction so the percent formatter renders 42%
   * etc.) against a flat 100%-capacity reference line. Built from
   * `measuredPeriods()` only — a null utilisation is never plotted as 0.
   */
  readonly utilizationSeries = computed<TrendSeries[]>(() => {
    const rows = this.measuredPeriods();
    return [
      { name: 'Utilization', values: rows.map(r => (r.utilizationPct as number) / 100) },
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

  /**
   * Mean utilisation over the periods that HAVE one, and `null` — rendered
   * "n/a" — when none do. Dividing by the full horizon length (or defaulting to
   * 0) would report a confident, healthy-looking low utilisation for weeks that
   * simply have no capacity to measure.
   */
  readonly avgUtilization = computed<number | null>(() => {
    const rows = this.measuredPeriods();
    if (!rows.length) return null;
    return rows.reduce((acc, r) => acc + (r.utilizationPct as number), 0) / rows.length;
  });

  /** How many weeks the average is actually computed over (shown in the KPI note). */
  readonly measuredWeeks = computed<number>(() => this.measuredPeriods().length);

  readonly avgBand = computed<UtilizationBand>(() => forecastUtilizationBand(this.avgUtilization()));

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
      // Without this the corrected branch in `notFullyAllocatedAt` is never
      // entered: with no absences nobody is ever ABSENT, so the fix reads as
      // applied while listing people on leave among the reallocatable.
      absences: d.absences ?? [],
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

  // `currentMonth()` is threaded in so coverage counts only people employed NOW:
  // a departed colleague's skills used to count as capability, which flipped
  // 'Thin' to 'Covered' and — where the leaver was the only holder of a skill —
  // hid the very shortage this table exists to raise.
  readonly skills = computed<SkillGapEntry[]>(() => skillGap(this.forecastData(), this.currentMonth()));
  readonly shortageCount = computed<number>(() => this.skills().filter(s => s.shortage).length);

  setHorizon(h: Horizon): void {
    this.horizon.set(h);
  }

  /** Export the capacity timeline (per-period supply/demand/util/gap) as CSV. */
  exportTimeline(): void {
    if (!this.isBrowser) return;
    downloadCsv(`capacity-timeline-${this.horizon()}w.csv`, this.buildTimelineCsv());
  }

  /**
   * The exact CSV text `exportTimeline()` writes, split out so it is assertable
   * without a DOM download — the same seam `capacity.component.ts` uses for its
   * own `buildCsv()`.
   *
   * Every hour figure goes through `round2`. The raw `overlapFraction` products
   * carry 14 decimals (Committed 83.48936835522201, Gap 196.510631644778) where
   * the screen shows 83 and 197, and this file gets pasted straight into
   * capacity decks: five of the seven columns disagreed with the UI they were
   * exported from.
   */
  protected buildTimelineCsv(rows: readonly CapacityPeriod[] = this.periods()): string {
    const columns: readonly CsvColumn<CapacityPeriod>[] = [
      { key: 'period', header: 'Period' },
      { key: 'supply', header: 'Supply', map: r => round2(r.supply) },
      { key: 'committed', header: 'Committed', map: r => round2(r.committed) },
      { key: 'pipeline', header: 'Pipeline', map: r => round2(r.pipeline) },
      { key: 'demand', header: 'Demand', map: r => round2(r.demand) },
      {
        key: 'utilizationPct',
        header: 'Utilization %',
        // 'n/a', never 0: a 0 in a spreadsheet column is indistinguishable from
        // a genuinely idle week, and this cell means "no capacity to measure".
        map: r => (r.utilizationPct === null ? 'n/a' : round2(r.utilizationPct)),
      },
      { key: 'gap', header: 'Gap', map: r => round2(r.gap) },
    ];
    return toCsv(rows, columns);
  }

  /** Export the skill-gap table (demand hours, supply count, shortage flag) as CSV. */
  exportSkillGap(): void {
    if (!this.isBrowser) return;
    downloadCsv('skill-gap.csv', this.buildSkillGapCsv());
  }

  /**
   * The skill-gap CSV, split out for the same reason as `buildTimelineCsv`.
   * `demandHours` is a sum of `unstaffedEffort` values and is fractional in the
   * seed as shipped (request '8' has requiredEffort 0.4), so it needs the same
   * 2-decimal rule — otherwise this fix leaves a second raw-float column on the
   * very same screen.
   */
  protected buildSkillGapCsv(rows: readonly SkillGapEntry[] = this.skills()): string {
    const columns: readonly CsvColumn<SkillGapEntry>[] = [
      { key: 'skill', header: 'Skill' },
      { key: 'demandHours', header: 'Demand Hours', map: r => round2(r.demandHours) },
      { key: 'supplyCount', header: 'Supply Count' },
      { key: 'shortage', header: 'Shortage' },
    ];
    return toCsv(rows, columns);
  }

  /** ISO date → "12 May" style label (UTC, time-zone stable). */
  private shortDate(iso: string): string {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
}
