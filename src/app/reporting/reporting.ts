import { ChangeDetectionStrategy, Component, inject, signal, computed, PLATFORM_ID } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { isPlatformBrowser, CurrencyPipe, DecimalPipe } from '@angular/common';
import { forkJoin, of, map } from 'rxjs';
import { rxResource } from '@angular/core/rxjs-interop';
import { ApiService, Resource, ResourceRequest, Assignment, Project, Order, OrderLine, FinancialItem, TimeEntry, Issue, ChangeRequest, Milestone, BillingPlanItem, Contract, Customer, FxRate, NegotiatedRate, BASE_CURRENCY, AssignmentDay, AssignmentMonth, CostBaseline, BenchRollup } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { computeProjectFinancials, costBaselineComparison, FinanceData, hasMeasuredMarginPct, arAging, arAgingByCustomer, dsoOutstanding, AR_AGING_BUCKETS, ArAgingBucket, ArAgingBucketTotal, ArAgingCustomerRow, marginDrivers, portfolioAlerts, DEFAULT_ALERT_THRESHOLDS, PortfolioAlertRow, customerProfitability, customerConcentration, marginCompressionAlerts, DEFAULT_MARGIN_COMPRESSION_CONFIG, recognizedRevenueTrend, recognitionSchedule, periodDelta, PeriodDelta, CustomerConcentration, MarginCompressionAlert, AlertSeverity, portfolioMarginFullyLoaded, PortfolioMargin, portfolioRealization, PortfolioRealization } from '../services/finance.util';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';
import { NotificationService } from '../services/notification.service';
import { toCsv, downloadCsv, downloadXlsx, XlsxSheet } from '../services/export.util';
import { allocationSheets, planningSheet, RptOpts, RptPlanData } from '../services/rpt-xlsx.util';
import { countsTowardInternalCapacity, kindOf } from '../services/resource-kind.util';
import { isWorkableUncoveredRequest } from '../services/request-demand.util';
import { DEFAULT_HOURS_PER_DAY } from '../services/sell-rate.util';
import { CommandBarChartComponent, CommandTrendChartComponent, CommandDonutChartComponent, BarSeries, TrendSeries } from '../shared/charts';
import { ListStateComponent } from '../shared/list-state.component';
import { todayLocalIso } from '../services/local-date.util';

interface Kpi {
  label: string;
  value: string;
  /**
   * Real period-over-period trend. `null` means there is no derivable prior
   * reading (e.g. a count metric with no dated history) — the indicator is
   * HIDDEN rather than showing a fabricated number. See requirement #15.
   */
  trend: PeriodDelta | null;
  icon: string;
  colorClass: string;
  /**
   * H (Q4 / spec §5.4 U6) — what the figure LEAVES OUT, when it leaves anything
   * out. Added because the utilization average now drops whoever is away on
   * leave for the whole current month from its DENOMINATOR: a mean that quietly
   * counts fewer people than the headcount is a number nobody can reproduce.
   * Absent (undefined) whenever there is nothing to qualify, so the note is
   * never a permanent decoration that stops being read.
   *
   * It is also carried into the CSV summary (see `buildSummaryCsv`), because an
   * export that keeps the corrected value and drops the caveat is the worse half.
   */
  note?: string;
}

interface ReportingData {
  resources: Resource[];
  assignments: Assignment[];
  requests: ResourceRequest[];
  projects: Project[];
  orders: Order[];
  orderLines: OrderLine[];
  financials: FinancialItem[];
  timeEntries: TimeEntry[];
  issues: Issue[];
  changeRequests: ChangeRequest[];
  milestones: Milestone[];
  billingItems: BillingPlanItem[];
  contracts: Contract[];
  customers: Customer[];
  negotiatedRates: NegotiatedRate[];
  /**
   * The org's working hours/day. Loaded HERE, in the same forkJoin, because a
   * negotiated rate is stored in EUR/DAY and `sellRateFor` needs this divisor to
   * price it in EUR/HOUR — without it the recognition figures on this page silently
   * fall back to the default-8 assumption instead of the configured value.
   */
  hoursPerDay: number;
  /** Baseline vs Planned columns (design spec, block E, §7). */
  assignmentDays: AssignmentDay[];
  assignmentMonths: AssignmentMonth[];
  costBaselines: CostBaseline[];
  /**
   * H (Q4, spec §5.4 U4-U6) — the monthly bench rollup, read ONLY for its
   * fourth state (`ABSENT`). This is the *aggregate* privacy level of §7.3: it
   * carries who cannot be staffed this month and carries NO `reasonCode`, so
   * this screen can mark an away person without ever receiving the cause.
   *
   * `/absences` is deliberately NOT read here. Its audience is the reason's
   * audience (`resource-manager`, `admin`, `delivery-executive`), which is not
   * this screen's audience, and the cause is special-category data (GDPR art. 9).
   * `/bench/monthly` is already served to every role that can reach /reporting —
   * AVAILABILITY_READ_ROLES is a superset of `canViewPortfolioDashboard()` — so
   * this leg cannot turn a permitted reader's page into a 403.
   */
  benchRollup: BenchRollup;
}

interface ArAgingBarRow extends ArAgingBucketTotal {
  bucket: ArAgingBucket;
}

/**
 * Empty envelope used until auth settles, as the resource default, and as what
 * the error-state guard below falls back to — one literal rather than three, so
 * a collection added to `ReportingData` cannot be added to some of them and not
 * the others (the same shape `capacity.component.ts`'s `EMPTY` established).
 */
const EMPTY_DATA: ReportingData = {
  resources: [], assignments: [], requests: [], projects: [], orders: [], orderLines: [], financials: [],
  timeEntries: [], issues: [], changeRequests: [], milestones: [], billingItems: [], contracts: [],
  customers: [], negotiatedRates: [], hoursPerDay: DEFAULT_HOURS_PER_DAY, assignmentDays: [],
  assignmentMonths: [], costBaselines: [], benchRollup: EMPTY_BENCH_ROLLUP,
};

@Component({
  selector: 'app-reporting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DecimalPipe, CommandBarChartComponent, CommandTrendChartComponent, CommandDonutChartComponent, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="command-header">
        <div>
          <div class="command-eyebrow">Executive Reporting</div>
          <h1 class="command-title">Portfolio Analytics</h1>
          <p class="command-subtitle">Cross-functional control view across resource demand, utilization, project finance, risks, milestones and change control.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          <select [value]="period()" (change)="onPeriodChange($event)" aria-label="Reporting period" class="command-select w-full sm:w-auto">
            <option value="30d">Last 30 Days</option>
            <option value="quarter">This Quarter</option>
            <option value="year">This Year</option>
          </select>
          <button type="button" (click)="exportReport()" class="command-button w-full sm:w-auto">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">download</mat-icon> Export Report
          </button>
          <!-- RPT parity (docs/rpt-comparison.md rows 24 + 44): the two Excel
               reports RPT's planners expect, in the workbook SHAPE RPT uses —
               Pianificazione is one sheet, Allocazione is two. Disabled on a failed
               read: a workbook built from an errored envelope is a file of confident
               zeros, which is worse than no file (same reasoning as the capacity
               screen's export gate). -->
          <button type="button" (click)="exportPlanningXlsx()" [disabled]="dataError()" data-test="export-planning-xlsx"
                  class="command-button secondary w-full sm:w-auto disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">table_view</mat-icon> Pianificazione
          </button>
          <button type="button" (click)="exportAllocationXlsx()" [disabled]="dataError()" data-test="export-allocation-xlsx"
                  class="command-button secondary w-full sm:w-auto disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">table_view</mat-icon> Allocazione
          </button>
        </div>
      </div>

      @if (accessNotice(); as notice) {
        <div class="command-card-muted p-4 flex items-start gap-3" role="alert">
          <mat-icon class="text-[20px] w-[20px] h-[20px] text-[var(--cc-amber-text)] shrink-0">lock</mat-icon>
          <p class="text-sm font-medium text-[var(--cc-ink)]">{{ notice }}</p>
        </div>
      }

      <!--
        MONEY TILES ARE INSIDE THE GATE. These three regions (KPI cards,
        Portfolio Financials, Realization & Productivity) used to render
        unconditionally, outside every readiness wrapper, with two consequences:
        (1) pre-authReady the gated resource resolves SUCCESSFULLY with an empty
        envelope, so SSR shipped a full page of EUR 0 Revenue / Margin / Backlog /
        EAC / VAC that then jumped on hydration; (2) on the error path
        dataRes.value() throws out of the first tile, aborting the render BEFORE
        the access notice above and all ten Retry panels below — contradicting the
        notice's own text. dashboard.component.ts:158-185 already models the right
        shape: error, then loading, then content.
      -->
      @if (dataError()) {
        <app-list-state [error]="true" label="portfolio analytics" (retry)="reloadData()" />
      } @else if (dataLoading()) {
        <!-- role="status" + aria-live="polite" + an sr-only text node, copying
             list-state.component.ts:49-50. The former aria-label named NOTHING:
             ARIA prohibits an accessible name on a role-less generic div, so it
             was dropped and this whole multi-request window announced silently —
             a deep-link with a screen reader was indistinguishable from an empty
             or broken report. aria-busy only announces inside a live region. -->
        <div class="space-y-6" role="status" aria-live="polite" aria-busy="true">
          <span class="sr-only">Loading portfolio analytics</span>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            @for (tile of [1, 2, 3, 4]; track tile) {
              <div class="command-skeleton h-36"></div>
            }
          </div>
          <div class="command-section-label">Portfolio Financials</div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            @for (tile of [1, 2, 3, 4, 5, 6, 7, 8]; track tile) {
              <div class="command-skeleton h-24"></div>
            }
          </div>
          <div class="command-section-label">Realization &amp; Productivity</div>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            @for (tile of [1, 2, 3, 4]; track tile) {
              <div class="command-skeleton h-28"></div>
            }
          </div>
        </div>
      } @else {
      <!-- KPI Cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        @for (kpi of kpis(); track kpi.label) {
          <div class="command-kpi group">
            <div class="flex items-center justify-between mb-4">
              <div class="w-12 h-12 rounded-md flex items-center justify-center shadow-sm" [class]="kpi.colorClass">
                <mat-icon class="text-white">{{ kpi.icon }}</mat-icon>
              </div>
              <!-- Real trend only; hidden entirely when no prior period is derivable (#15). -->
              @if (kpi.trend?.direction; as dir) {
                <span class="command-chip inline-flex items-center gap-0.5"
                      [class]="dir === 'up' ? 'is-positive' : dir === 'down' ? 'is-critical' : 'is-neutral'"
                      [attr.aria-label]="trendAriaLabel(kpi.trend)">
                  <mat-icon class="text-[14px] w-[14px] h-[14px]">{{ dir === 'up' ? 'trending_up' : dir === 'down' ? 'trending_down' : 'trending_flat' }}</mat-icon>
                  {{ kpi.trend?.deltaPct !== null ? (kpi.trend!.deltaPct! > 0 ? '+' : '') + (kpi.trend!.deltaPct! | number:'1.0-0') + '%' : '—' }}
                </span>
              }
            </div>
            <h3 class="command-kpi-label">{{ kpi.label }}</h3>
            <p class="command-kpi-value">{{ kpi.value }}</p>
            <!-- Only present when the figure leaves something out (H, U6). -->
            @if (kpi.note; as note) {
              <p class="command-note" data-test="kpi-note">{{ note }}</p>
            }
          </div>
        }
      </div>

      <!-- Portfolio financials (real, from commercial + finance data) -->
      <div class="command-section-label flex items-center justify-between">
        <span>Portfolio Financials</span>
        <span class="text-xs font-semibold text-ink-muted normal-case tracking-normal">{{ baseCurrency }} (base)</span>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div class="command-kpi">
          <p class="command-kpi-label">Portfolio Revenue</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ totalRevenue() | currency:'EUR':'symbol':'1.0-0' }}</p>
        </div>
        <!--
          Q2 (spec §10, decided 2026-08-07): FULLY LOADED belongs in the LABEL,
          not only in a caption. The cost of non-billable work is inside this
          figure, which makes it a different quantity from the margin of any
          single delivery project — and the comparison WILL be attempted, because
          both are called "margin" and both are in euro. The note below states
          the term that reconciles them (delivery margin = this + non-billable
          cost), so the reader who makes the comparison can make it correctly
          instead of concluding the portfolio is under-performing its own projects.
        -->
        <div class="command-kpi" [class.danger]="totalMargin() < 0" data-test="fully-loaded-margin-tile">
          <p class="command-kpi-label">Total Margin (fully loaded)</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="totalMargin() >= 0" [class.text-critical-text]="totalMargin() < 0">{{ totalMargin() | currency:'EUR':'symbol':'1.0-0' }}</p>
          @if (nonBillableCount() > 0) {
            <p class="command-note" data-test="fully-loaded-note">Includes {{ portfolioMargin().nonBillableCost | currency:'EUR':'symbol':'1.0-0' }} of non-billable cost across {{ nonBillableCount() }} {{ nonBillableCount() === 1 ? 'engagement' : 'engagements' }} — not comparable with a single project&rsquo;s delivery margin</p>
          } @else {
            <p class="command-note" data-test="fully-loaded-note">No non-billable engagement in the cost base, so this equals delivery margin today</p>
          }
        </div>
        <!-- Tile tone suppressed with the figure: "warning" fires on [0,15), so
             the sentinel would paint an amber tile off a number never measured. -->
        <div class="command-kpi" [class.warning]="hasPortfolioMarginPct() && portfolioMarginPct() >= 0 && portfolioMarginPct() < 15" [class.danger]="hasPortfolioMarginPct() && portfolioMarginPct() < 0">
          <p class="command-kpi-label">Margin % (fully loaded)</p>
          @if (hasPortfolioMarginPct()) {
            <p class="command-kpi-value font-mono tabular-nums" data-test="portfolio-margin-pct" [class.text-positive-text]="portfolioMarginPct() >= 0" [class.text-critical-text]="portfolioMarginPct() < 0">{{ portfolioMarginPct() | number:'1.0-1' }}%</p>
            <p class="command-note">Fully-loaded margin over portfolio revenue</p>
          } @else {
            <p class="command-kpi-value font-mono tabular-nums text-ink-muted" data-test="portfolio-margin-pct">&mdash;</p>
            <p class="command-note">No portfolio revenue, so there is no percentage to compute</p>
          }
        </div>
        <div class="command-kpi info">
          <p class="command-kpi-label">Backlog</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ totalBacklog() | currency:'EUR':'symbol':'1.0-0' }}</p>
        </div>
        <div class="command-kpi info">
          <p class="command-kpi-label">Portfolio EAC</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ totalEac() | currency:'EUR':'symbol':'1.0-0' }}</p>
        </div>
        <div class="command-kpi" [class.danger]="totalVac() < 0">
          <p class="command-kpi-label">VAC</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="totalVac() >= 0" [class.text-critical-text]="totalVac() < 0">{{ totalVac() | currency:'EUR':'symbol':'1.0-0' }}</p>
        </div>
        <div class="command-kpi warning">
          <p class="command-kpi-label">Open Changes</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ openChanges() }}</p>
        </div>
        <div class="command-kpi" [class.danger]="highRiskIssues() > 0">
          <p class="command-kpi-label">High Risk Issues</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-critical-text]="highRiskIssues() > 0">{{ highRiskIssues() }}</p>
        </div>
      </div>

      <!-- Realization & revenue-per-FTE strip (real, recognised revenue vs rate-card) -->
      <div class="command-section-label flex items-center justify-between">
        <span>Realization &amp; Productivity</span>
        <!--
          H (spec §5.3 F-7): a non-billable engagement has revenue 0 against a
          positive rate-card value, i.e. a 0% realization that drags every mean it
          enters. portfolioRealization excludes those, and the subtitle names
          HOW MANY — a mean that silently changed population is not defensible.
        -->
        <span class="text-xs font-semibold text-ink-muted normal-case tracking-normal" data-test="realization-scope">
          Recognised revenue vs rate-card &middot;
          @if (realizationExcludedCount() > 0) {
            billable engagements only ({{ realizationExcludedCount() }} non-billable excluded)
          } @else {
            all engagements are billable
          } &middot; {{ baseCurrency }} (base)
        </span>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div class="command-kpi" [class.warning]="realization().realizationPct > 0 && realization().realizationPct < 85">
          <div class="flex items-center justify-between mb-1">
            <p class="command-kpi-label">Realization</p>
            <!-- Real recognised-revenue trend; hidden when no prior window is derivable (#15). -->
            @if (recognizedTrend().direction; as dir) {
              <span class="command-chip inline-flex items-center gap-0.5"
                    [class]="dir === 'up' ? 'is-positive' : dir === 'down' ? 'is-critical' : 'is-neutral'"
                    [attr.aria-label]="trendAriaLabel(recognizedTrend())">
                <mat-icon class="text-[14px] w-[14px] h-[14px]">{{ dir === 'up' ? 'trending_up' : dir === 'down' ? 'trending_down' : 'trending_flat' }}</mat-icon>
                {{ recognizedTrend().deltaPct !== null ? (recognizedTrend().deltaPct! > 0 ? '+' : '') + (recognizedTrend().deltaPct! | number:'1.0-0') + '%' : '—' }}
              </span>
            }
          </div>
          <p class="command-kpi-value font-mono tabular-nums">{{ realization().realizationPct | number:'1.0-1' }}%</p>
          <p class="command-note">Recognised / rate-card value</p>
        </div>
        <div class="command-kpi info">
          <p class="command-kpi-label">Recognised Revenue</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ realization().revenue | currency:'EUR':'symbol':'1.0-0' }}</p>
          <p class="command-note">Earned to date (POC / realised)</p>
        </div>
        <div class="command-kpi">
          <p class="command-kpi-label">Revenue / FTE</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ realization().revenuePerFte | currency:'EUR':'symbol':'1.0-0' }}</p>
          <p class="command-note">{{ realization().fte | number:'1.0-1' }} FTE &middot; {{ hoursPerFte }}h basis</p>
        </div>
        <div class="command-kpi">
          <p class="command-kpi-label">Revenue / Head</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ realization().revenuePerHead | currency:'EUR':'symbol':'1.0-0' }}</p>
          <p class="command-note">{{ realization().headcount }} {{ realization().headcount === 1 ? 'person' : 'people' }} &middot; {{ realization().hours | number:'1.0-0' }}h</p>
        </div>
      </div>

      }

      <!-- Charts Area -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Resource Utilization (bar chart) -->
        <div class="command-card p-6 sm:p-8">
          <div class="flex items-center justify-between mb-8">
            <h3 class="text-xl font-bold text-ink tracking-tight">Current Resource Utilization</h3>
          </div>
          @defer (hydrate on viewport) {
            <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="block" [rows]="1" label="utilization" (retry)="reloadData()">
              <ng-template>
              @if (utilizationChartCategories().length > 0) {
                <command-bar-chart
                  [categories]="utilizationChartCategories()"
                  [series]="utilizationChartSeries()"
                  [maxValue]="100"
                  [showValues]="true"
                  [height]="256"
                  [format]="utilizationPctFormat"
                  ariaLabel="Utilization by internal resource"
                  caption="Current utilization percentage per internal resource. Dummy and subco are uncovered demand, not capacity. Anyone away on leave for the whole month stays on the chart, labelled &quot;(away)&quot;, and leaves the average — the reason for the leave is never shown." />
                <!--
                  Q4's annotation. It is not decoration: it is the only channel
                  with a drawable area, since an away person's bar is 0% tall (see
                  utilizationData). It also carries the canonical glyph and wording
                  ONCE, where they can be explained, instead of pushing an
                  unexplained 'L' onto the axis. Rendered only when there is
                  something to say; absenceScopeNote covers the two cases where
                  there is not.
                -->
                @if (awayOnChart().length > 0) {
                  <ul class="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4" data-test="utilization-away-legend">
                    @for (b of awayOnChart(); track b.id) {
                      <li class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold {{ AWAY_TONE }}"
                          role="img" [attr.aria-label]="b.month + ': ' + AWAY_LABEL" [title]="AWAY_LABEL">
                        <span class="font-mono font-bold tabular-nums leading-none">{{ AWAY_GLYPH }}</span>
                        {{ b.month }}
                      </li>
                    }
                    <li class="text-xs font-medium text-ink-muted">{{ AWAY_LABEL }}</li>
                  </ul>
                }
                @if (absenceScopeNote(); as note) {
                  <p class="mt-3 text-xs text-ink-muted" data-test="utilization-absence-scope">{{ note }}</p>
                }
              } @else {
                <p class="text-ink-muted text-sm">No resources to chart yet.</p>
              }
              </ng-template>
            </app-list-state>
          } @placeholder {
            <div class="command-skeleton h-64"></div>
          } @loading {
            <div class="command-skeleton h-64"></div>
          }
        </div>

        <!-- Project Margin (real, bar chart + numbers) -->
        <div class="command-card p-6 sm:p-8">
          <div class="flex items-center justify-between mb-8">
            <h3 class="text-xl font-bold text-ink tracking-tight">Project Margin <span class="ml-1 text-xs font-semibold text-ink-muted normal-case tracking-normal">{{ baseCurrency }} (base)</span></h3>
          </div>
          @defer (hydrate on viewport) {
            <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="block" [rows]="1" label="project margin" (retry)="reloadData()">
              <ng-template>
              @if (marginChartCategories().length > 0) {
                <command-bar-chart
                  [categories]="marginChartCategories()"
                  [series]="marginChartSeries()"
                  orientation="horizontal"
                  [showValues]="true"
                  [format]="eurCompact"
                  ariaLabel="Margin by project in base currency"
                  caption="Margin per project (base currency)" />
                <!-- Numeric margin / margin% kept alongside the chart -->
                <dl class="mt-4 space-y-1.5 border-t border-line pt-4">
                  @for (p of marginBars(); track p.name) {
                    <div class="flex justify-between items-baseline gap-3 text-sm">
                      <dt class="font-semibold text-ink-secondary truncate">{{ p.name }}</dt>
                      <dd class="font-mono tabular-nums font-bold shrink-0" [class.text-positive-text]="p.margin >= 0" [class.text-critical-text]="p.margin < 0">
                        {{ p.margin | currency:'EUR':'symbol':'1.0-0' }} · {{ p.marginPct | number:'1.0-0' }}%
                      </dd>
                    </div>
                  }
                </dl>
              } @else {
                <p class="text-ink-muted text-sm">No projects with customer revenue yet. Add Customer orders in Commercial → Orders.</p>
              }
              </ng-template>
            </app-list-state>
          } @placeholder {
            <div class="command-skeleton h-64"></div>
          } @loading {
            <div class="command-skeleton h-64"></div>
          }
        </div>
      </div>

      <!-- Recognised-revenue trend (real monthly series, 12-month trailing) -->
      <div class="command-card p-6 sm:p-8">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-8">
          <h3 class="text-xl font-bold text-ink tracking-tight">Recognised Revenue Trend</h3>
          <span class="text-xs font-semibold uppercase tracking-wider text-ink-muted normal-case">Trailing 12 months &middot; {{ baseCurrency }} (base)</span>
        </div>
        @defer (hydrate on viewport) {
          <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="block" [rows]="1" label="recognised revenue" (retry)="reloadData()">
            <ng-template>
            @if (recognizedTrendCategories().length > 0) {
              <command-trend-chart
                [categories]="recognizedTrendCategories()"
                [series]="recognizedTrendSeries()"
                mode="area" [smooth]="true"
                [format]="eurCompact"
                ariaLabel="Recognised revenue by month, trailing 12 months"
                caption="Monthly recognised revenue (base currency)" />
            } @else {
              <p class="text-ink-muted text-sm">No dated revenue-recognition data to trend yet.</p>
            }
            </ng-template>
          </app-list-state>
        } @placeholder {
          <div class="command-skeleton h-64"></div>
        } @loading {
          <div class="command-skeleton h-64"></div>
        }
      </div>

      <!-- Detailed Reports Table -->
      @defer (hydrate on viewport) {
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-line flex items-center justify-between bg-surface-muted">
          <h3 class="text-xl font-bold text-ink tracking-tight">Available Reports</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-surface-muted border-b border-line text-ink-muted">
              <tr>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Report Name</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Category</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Last Generated</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (report of reports(); track report.name) {
                <tr class="hover:bg-surface-muted transition-colors group">
                  <td class="px-6 sm:px-8 py-5 font-bold text-ink flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-accent-tint ring-1 ring-accent flex items-center justify-center text-accent-text">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">description</mat-icon>
                    </div>
                    {{ report.name }}
                  </td>
                  <td class="px-6 sm:px-8 py-5">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide ring-1"
                          [class.bg-accent-tint]="report.category === 'Resource Management'" [class.text-accent-text]="report.category === 'Resource Management'" [class.ring-accent]="report.category === 'Resource Management'"
                          [class.bg-positive-tint]="report.category === 'Project Management'" [class.text-positive-text]="report.category === 'Project Management'" [class.ring-positive]="report.category === 'Project Management'"
                          [class.bg-accent-tint]="report.category === 'Cross-Functional'" [class.text-accent-text]="report.category === 'Cross-Functional'" [class.ring-accent]="report.category === 'Cross-Functional'">
                      {{ report.category }}
                    </span>
                  </td>
                  <td class="px-6 sm:px-8 py-5 text-ink-secondary font-medium">{{ report.lastGenerated }}</td>
                  <td class="px-6 sm:px-8 py-5 text-right">
                    <button type="button" (click)="exportReport()" class="text-accent-text hover:text-accent-strong hover:underline font-semibold text-sm transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 flex items-center justify-end gap-1 ml-auto">
                      Export <mat-icon class="text-[16px] w-[16px] h-[16px]">download</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      } @placeholder {
        <div class="command-skeleton h-48"></div>
      }

      <!-- Margin & Variance -->
      <div class="command-section-label">Margin &amp; Variance</div>

      <!-- Per-project drill-down with stacked cost-driver mini-bar -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="table-rows" [rows]="6" [columns]="14" label="margin &amp; variance" (retry)="reloadData()">
      <ng-template>
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-muted">
          <h3 class="text-xl font-bold text-ink tracking-tight">Project Margin &amp; Variance</h3>
          <div class="flex items-center gap-4">
            <div class="hidden sm:flex items-center gap-4 text-xs font-semibold text-ink-muted">
              <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-accent"></span>Labor</span>
              <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-caution"></span>External</span>
              <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-series-6"></span>Expense</span>
            </div>
            <button type="button" (click)="exportMarginVarianceCsv()" [disabled]="marginRows().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
            </button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-surface-muted border-b border-line text-ink-muted">
              <tr>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Project</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Revenue</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Labor</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">External</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Expense</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Margin</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Margin %</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">EAC</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">VAC</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Burn %</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Baseline</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Planned</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Delta</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Delta %</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (r of marginRows(); track r.id) {
                <tr class="hover:bg-surface-muted transition-colors">
                  <td class="px-6 sm:px-8 py-5 min-w-[180px]">
                    <div class="font-bold text-ink">{{ r.name }}</div>
                    <!-- Stacked cost-driver mini-bar -->
                    <div class="mt-2 flex w-full h-2 rounded-full overflow-hidden bg-surface-muted shadow-inner"
                         role="img"
                         [attr.aria-label]="'Cost drivers — labor ' + (r.laborCost | currency:'EUR':'symbol':'1.0-0') + ', external ' + (r.externalCost | currency:'EUR':'symbol':'1.0-0') + ', expense ' + (r.expenseCost | currency:'EUR':'symbol':'1.0-0')">
                      <div class="h-full bg-accent" [style.width.%]="r.laborW"></div>
                      <div class="h-full bg-caution" [style.width.%]="r.externalW"></div>
                      <div class="h-full bg-series-6" [style.width.%]="r.expenseW"></div>
                    </div>
                  </td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.laborCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.externalCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.expenseCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums font-bold" [class.text-positive-text]="r.margin >= 0" [class.text-critical-text]="r.margin < 0">{{ r.margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <!-- marginRows() admits a project with cost and NO revenue
                       (its filter is revenue &gt; 0 OR any cost &gt; 0), which is
                       exactly a non-billable engagement — so this cell is where
                       finance.util's no-revenue sentinel 0 reached the P&amp;L
                       table. -->
                  @if (hasMarginPct(r.revenue)) {
                    <td class="px-4 py-5 text-right font-mono tabular-nums" data-test="margin-row-pct" [class.text-positive-text]="r.marginPct >= 0" [class.text-critical-text]="r.marginPct < 0">{{ r.marginPct | number:'1.0-1' }}%</td>
                  } @else {
                    <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-muted" data-test="margin-row-pct" title="No customer revenue — a margin percentage is undefined">&mdash;</td>
                  }
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.eac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-positive-text]="r.vac >= 0" [class.text-critical-text]="r.vac < 0">{{ r.vac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-critical-text]="r.burnPct >= alertThresholds.burnWarnPct" [class.text-ink-secondary]="r.burnPct < alertThresholds.burnWarnPct">{{ r.burnPct | number:'1.0-0' }}%</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.pcpBaseline | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ r.pcpPlanned | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-positive-text]="r.pcpDelta <= 0" [class.text-critical-text]="r.pcpDelta > 0">{{ r.pcpDelta | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums">{{ r.pcpDeltaPct !== null ? ((r.pcpDeltaPct > 0 ? '+' : '') + (r.pcpDeltaPct | number:'1.2-2') + '%') : '—' }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="14" class="px-6 sm:px-8 py-8 text-center text-ink-muted text-sm">No projects with revenue or cost yet.</td>
                </tr>
              }
            </tbody>
            @if (marginRows().length > 0) {
              <tfoot class="border-t-2 border-line bg-surface-muted font-bold text-ink">
                <tr>
                  <td class="px-6 sm:px-8 py-4">Portfolio <span class="ml-1 text-xs font-semibold text-ink-muted normal-case tracking-normal">{{ baseCurrency }} (base)</span></td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().laborCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().externalCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().expenseCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-positive-text]="marginTotals().margin >= 0" [class.text-critical-text]="marginTotals().margin < 0">{{ marginTotals().margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4"></td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().eac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-positive-text]="marginTotals().vac >= 0" [class.text-critical-text]="marginTotals().vac < 0">{{ marginTotals().vac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4"></td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().pcpBaseline | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().pcpPlanned | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-positive-text]="marginTotals().pcpDelta <= 0" [class.text-critical-text]="marginTotals().pcpDelta > 0">{{ marginTotals().pcpDelta | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4"></td>
                </tr>
              </tfoot>
            }
          </table>
        </div>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-64"></div>
      }

      <!-- Threshold-breach alerts -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="table-rows" [rows]="4" label="portfolio alerts" (retry)="reloadData()">
      <ng-template>
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-surface-muted">
          <h3 class="text-xl font-bold text-ink tracking-tight">Portfolio Alerts</h3>
          <span class="text-xs font-semibold text-ink-muted">Margin &le; {{ alertThresholds.marginTargetPct }}% &middot; Burn &ge; {{ alertThresholds.burnWarnPct }}% &middot; EAC &gt; budget</span>
        </div>
        <ul class="divide-y divide-line">
          @for (row of alertRows(); track row.projectId) {
            <li class="px-6 sm:px-8 py-5 flex flex-col sm:flex-row sm:items-start gap-3 hover:bg-surface-muted transition-colors">
              <span class="command-status shrink-0"
                    [class]="alertSeverity(row) === 'critical' ? 'bg-critical-tint text-critical-text ring-1 ring-critical' : 'bg-caution-tint text-caution-text ring-1 ring-caution'">
                {{ alertSeverity(row) === 'critical' ? 'Critical' : 'Warning' }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="font-bold text-ink">{{ row.name ?? row.projectId }}</div>
                <ul class="mt-1.5 space-y-1">
                  @for (reason of row.alerts.items; track reason) {
                    <li class="flex items-start gap-2 text-sm text-ink-secondary">
                      <mat-icon class="text-[16px] w-[16px] h-[16px] mt-0.5 shrink-0"
                                [class.text-critical-text]="alertSeverity(row) === 'critical'" [class.text-caution-text]="alertSeverity(row) === 'warning'">error_outline</mat-icon>
                      <span class="font-mono tabular-nums">{{ reason }}</span>
                    </li>
                  }
                </ul>
              </div>
            </li>
          } @empty {
            <li class="px-6 sm:px-8 py-8 flex items-center justify-center gap-2 text-sm text-positive-text font-semibold">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">check_circle</mat-icon>
              No projects breaching margin, burn or EAC thresholds.
            </li>
          }
        </ul>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-48"></div>
      }

      <!-- Margin-Compression alerts (project + customer, severity-graded) -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="table-rows" [rows]="4" label="margin-compression alerts" (retry)="reloadData()">
      <ng-template>
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-muted">
          <div>
            <h3 class="text-xl font-bold text-ink tracking-tight">Margin-Compression Alerts</h3>
            <span class="text-xs font-semibold text-ink-muted">Margin &le; {{ marginCompressionThresholds.marginTargetPct }}% or thin bill-vs-cost spread &middot; project &amp; customer</span>
          </div>
          <button type="button" (click)="exportMarginCompressionCsv()" [disabled]="compressionAlerts().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
          </button>
        </div>
        <ul class="divide-y divide-line">
          @for (a of compressionAlerts(); track a.scope + ':' + a.id) {
            <li class="px-6 sm:px-8 py-5 flex flex-col sm:flex-row sm:items-start gap-3 hover:bg-surface-muted transition-colors">
              <span class="command-status shrink-0" [class]="severityBadgeClass(a.severity)">
                {{ severityLabel(a.severity) }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-bold text-ink">{{ a.name ?? a.id }}</span>
                  <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide ring-1"
                        [class.bg-accent-tint]="a.scope === 'project'" [class.text-accent-text]="a.scope === 'project'" [class.ring-accent]="a.scope === 'project'"
                        [class.bg-surface-muted]="a.scope === 'customer'" [class.text-series-3]="a.scope === 'customer'" [class.ring-series-3]="a.scope === 'customer'">
                    {{ a.scope }}
                  </span>
                  <span class="text-xs font-semibold text-ink-muted font-mono tabular-nums">{{ a.marginPct | number:'1.0-1' }}% margin &middot; {{ a.gapPts | number:'1.0-1' }}pt gap</span>
                </div>
                <ul class="mt-1.5 space-y-1">
                  @for (reason of a.reasons; track reason) {
                    <li class="flex items-start gap-2 text-sm text-ink-secondary">
                      <mat-icon class="text-[16px] w-[16px] h-[16px] mt-0.5 shrink-0"
                                [class.text-critical-text]="a.severity === 'high'" [class.text-caution-text]="a.severity === 'medium'" [class.text-ink-muted]="a.severity === 'low'">error_outline</mat-icon>
                      <span class="font-mono tabular-nums">{{ reason }}</span>
                    </li>
                  }
                </ul>
              </div>
              <div class="shrink-0 text-right font-mono tabular-nums text-sm text-ink-secondary">
                {{ a.revenue | currency:'EUR':'symbol':'1.0-0' }}
                <div class="text-xs text-ink-muted">revenue</div>
              </div>
            </li>
          } @empty {
            <li class="px-6 sm:px-8 py-8 flex items-center justify-center gap-2 text-sm text-positive-text font-semibold">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">check_circle</mat-icon>
              No projects or customers showing margin compression.
            </li>
          }
        </ul>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-48"></div>
      }

      <!-- Customer Profitability & Concentration ------------------------------- -->
      <div class="command-section-label">Customer Profitability &amp; Concentration</div>

      <!-- Concentration KPI cards (single-customer dependency risk) + HHI gauge.
           ListState-wrapped like every other data-backed panel on this page. This
           block was the ONE reader left outside a gate when the money regions were
           moved inside the dataError() branch above: concentration() reaches the
           gated envelope, so on a failed read it painted a confident 0% top-customer
           share and an HHI of 0 — and, before the envelope guard, threw out of the
           whole render. Content is an ng-template for the reason ListState
           documents: an ordinary projected binding is evaluated even when the
           branch hiding it is not taken. -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="block" [rows]="1" label="customer concentration" (retry)="reloadData()">
      <ng-template>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <div class="command-card p-6 sm:p-8 lg:col-span-2 grid grid-cols-2 gap-4 sm:gap-6 content-start">
          <div class="command-kpi">
            <p class="command-kpi-label">Customers</p>
            <p class="command-kpi-value font-mono tabular-nums">{{ concentration().customerCount }}</p>
            <p class="command-note">With customer revenue</p>
          </div>
          <div class="command-kpi" [class.warning]="concentration().topCustomerSharePct >= 40 && concentration().topCustomerSharePct < 60" [class.danger]="concentration().topCustomerSharePct >= 60">
            <p class="command-kpi-label">Top Customer Share</p>
            <p class="command-kpi-value font-mono tabular-nums">{{ concentration().topCustomerSharePct | number:'1.0-1' }}%</p>
            <p class="command-note">{{ concentration().topCustomerName ?? '—' }}</p>
          </div>
          <div class="command-kpi" [class.warning]="concentration().top3SharePct >= 75">
            <p class="command-kpi-label">Top-3 Share</p>
            <p class="command-kpi-value font-mono tabular-nums">{{ concentration().top3SharePct | number:'1.0-1' }}%</p>
            <p class="command-note">Combined revenue share</p>
          </div>
          <div class="command-kpi" [class.warning]="concentration().hhi >= 2500 && concentration().hhi < 5000" [class.danger]="concentration().hhi >= 5000">
            <p class="command-kpi-label">HHI</p>
            <p class="command-kpi-value font-mono tabular-nums">{{ concentration().hhi | number:'1.0-0' }}</p>
            <p class="command-note">Concentration index (0–10000)</p>
          </div>
        </div>
        <!-- HHI radial gauge: arc fills hhi/10000, centered text shows the raw index -->
        <div class="command-card p-6 sm:p-8 flex flex-col items-center justify-center gap-3">
          <command-donut-chart
            [value]="concentrationHhiRatio()" [max]="1"
            label="HHI" [tone]="concentrationHhiTone()"
            [size]="180"
            [displayText]="(concentration().hhi | number:'1.0-0') ?? '0'"
            ariaLabel="Revenue concentration HHI gauge"
            caption="Revenue-concentration HHI out of 10000" />
          <p class="command-note text-center">Single-customer dependency risk &middot; higher is more concentrated</p>
        </div>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-48"></div>
      }

      <!-- Top customers by revenue (bar chart) -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="block" [rows]="1" label="customer revenue" (retry)="reloadData()">
        <ng-template>
        <div class="command-card p-6 sm:p-8">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-8">
            <h3 class="text-xl font-bold text-ink tracking-tight">Top Customers by Revenue</h3>
            <span class="text-xs font-semibold uppercase tracking-wider text-ink-muted normal-case">Top {{ customerChartCategories().length }} &middot; {{ baseCurrency }} (base)</span>
          </div>
          @if (customerChartCategories().length > 0) {
            <command-bar-chart
              [categories]="customerChartCategories()"
              [series]="customerChartSeries()"
              orientation="horizontal"
              [showValues]="true"
              [format]="eurCompact"
              [height]="320"
              ariaLabel="Revenue by customer in base currency"
              caption="Revenue per customer (base currency)" />
          } @else {
            <p class="text-ink-muted text-sm">No customer revenue to chart yet.</p>
          }
        </div>
        </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-64"></div>
      }

      <!-- Top customers by margin -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="table-rows" [rows]="6" [columns]="7" label="customer profitability" (retry)="reloadData()">
      <ng-template>
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-muted">
          <h3 class="text-xl font-bold text-ink tracking-tight">Top Customers by Margin <span class="ml-1 text-xs font-semibold text-ink-muted normal-case tracking-normal">{{ baseCurrency }} (base)</span></h3>
          <button type="button" (click)="exportCustomerProfitabilityCsv()" [disabled]="customerRows().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-surface-muted border-b border-line text-ink-muted">
              <tr>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Customer</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Revenue</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Cost</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Margin</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Margin %</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Rev. Share</th>
                <th class="px-4 py-4 font-semibold uppercase tracking-wider text-xs text-right">Projects</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (c of customerRows(); track c.customerId) {
                <tr class="hover:bg-surface-muted transition-colors">
                  <td class="px-6 sm:px-8 py-5 font-bold text-ink min-w-[160px]">{{ c.customerName }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ c.revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ c.cost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums font-bold" [class.text-positive-text]="c.margin >= 0" [class.text-critical-text]="c.margin < 0">{{ c.margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <!-- customerProfitability() buckets EVERY project, including
                       the ones with cost and no revenue (they land under the
                       'unknown' customer when unattributed), so a customer row
                       can carry the sentinel too. -->
                  @if (hasMarginPct(c.revenue)) {
                    <td class="px-4 py-5 text-right font-mono tabular-nums" data-test="customer-margin-pct" [class.text-positive-text]="c.marginPct >= 0" [class.text-critical-text]="c.marginPct < 0">{{ c.marginPct | number:'1.0-1' }}%</td>
                  } @else {
                    <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-muted" data-test="customer-margin-pct" title="No customer revenue — a margin percentage is undefined">&mdash;</td>
                  }
                  <td class="px-4 py-5 text-right">
                    <div class="flex items-center justify-end gap-2">
                      <span class="font-mono tabular-nums text-ink-secondary">{{ c.sharePct | number:'1.0-1' }}%</span>
                      <span class="hidden sm:block w-16 bg-surface-muted rounded-full h-2 overflow-hidden shadow-inner">
                        <span class="block h-full bg-accent rounded-full" [style.width.%]="c.shareW"></span>
                      </span>
                    </div>
                  </td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-ink-muted">{{ c.projectIds.length }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="7" class="px-6 sm:px-8 py-8 text-center text-ink-muted text-sm">No customer revenue yet. Link projects to contracts and add Customer orders.</td>
                </tr>
              }
            </tbody>
            @if (customerRows().length > 0) {
              <tfoot class="border-t-2 border-line bg-surface-muted font-bold text-ink">
                <tr>
                  <td class="px-6 sm:px-8 py-4">Total <span class="ml-1 text-xs font-semibold text-ink-muted normal-case tracking-normal">{{ baseCurrency }} (base)</span></td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ customerTotals().revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ customerTotals().cost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-positive-text]="customerTotals().margin >= 0" [class.text-critical-text]="customerTotals().margin < 0">{{ customerTotals().margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <!-- Reachable when the whole customer base has no revenue —
                       a portfolio of only internal / non-billable work. -->
                  @if (hasMarginPct(customerTotals().revenue)) {
                    <td class="px-4 py-4 text-right font-mono tabular-nums" data-test="customer-total-margin-pct" [class.text-positive-text]="customerTotals().marginPct >= 0" [class.text-critical-text]="customerTotals().marginPct < 0">{{ customerTotals().marginPct | number:'1.0-1' }}%</td>
                  } @else {
                    <td class="px-4 py-4 text-right font-mono tabular-nums text-ink-muted" data-test="customer-total-margin-pct" title="No customer revenue — a margin percentage is undefined">&mdash;</td>
                  }
                  <td class="px-4 py-4 text-right font-mono tabular-nums">100%</td>
                  <td class="px-4 py-4"></td>
                </tr>
              </tfoot>
            }
          </table>
        </div>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-64"></div>
      }

      <!-- Accounts Receivable (A/R aging) -->
      <div class="command-section-label">Accounts Receivable</div>

      <!-- A/R KPI cards. Same rule as the strips above: three money figures, so
           they render only from a resolved envelope — never zeros from a
           pre-authReady or failed load. -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="block" [rows]="1" label="accounts receivable" (retry)="reloadData()">
      <ng-template>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
        <div class="command-kpi">
          <p class="command-kpi-label">Total Outstanding</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ arTotalOutstanding() | currency:'EUR':'symbol':'1.0-0' }}</p>
          <p class="command-note">Invoiced, not yet collected</p>
        </div>
        <div class="command-kpi" [class.danger]="arOverdue() > 0">
          <p class="command-kpi-label">Overdue</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-critical-text]="arOverdue() > 0">{{ arOverdue() | currency:'EUR':'symbol':'1.0-0' }}</p>
          <p class="command-note">Past due date</p>
        </div>
        <div class="command-kpi info">
          <p class="command-kpi-label">DSO</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ arDso() | number:'1.0-0' }} <span class="text-base font-semibold text-ink-muted">days</span></p>
          <p class="command-note">Amount-weighted age of A/R</p>
        </div>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-24"></div>
      }

      <!-- Aging bar chart (0-30 / 31-60 / 61-90 / 90+) -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="block" [rows]="1" label="A/R aging" (retry)="reloadData()">
      <ng-template>
      <div class="command-card p-6 sm:p-8">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8">
          <h3 class="text-xl font-bold text-ink tracking-tight">A/R Aging</h3>
          <div class="flex items-center gap-4">
            <span class="text-xs font-semibold uppercase tracking-wider text-ink-muted">Days overdue &middot; {{ baseCurrency }} (base)</span>
            <button type="button" (click)="exportArAgingCsv()" class="command-button secondary">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
            </button>
          </div>
        </div>
        <!-- Horizontal bar chart over the fixed aging buckets -->
        <command-bar-chart
          [categories]="arAgingChartCategories()"
          [series]="arAgingChartSeries()"
          orientation="horizontal"
          [showValues]="true"
          [format]="eurCompact"
          ariaLabel="Accounts receivable aging buckets"
          caption="A/R balance by aging bucket (base currency)" />
        <!-- Numeric amounts + invoice counts kept alongside the chart -->
        <div class="space-y-6 mt-6 border-t border-line pt-6">
          @for (b of arBucketBars(); track b.bucket) {
            <div class="group">
              <div class="flex justify-between items-end mb-2">
                <span class="font-bold tracking-wide" [class.text-critical-text]="b.bucket === '90+'" [class.text-ink-secondary]="b.bucket !== '90+'">
                  {{ b.bucket }} days
                  <span class="ml-2 text-xs font-semibold text-ink-muted tabular-nums">{{ b.count }} {{ b.count === 1 ? 'invoice' : 'invoices' }}</span>
                </span>
                <span class="text-sm font-bold tracking-wide font-mono tabular-nums" [class.text-critical-text]="b.bucket === '90+'" [class.text-ink-secondary]="b.bucket !== '90+'">
                  {{ b.amount | currency:'EUR':'symbol':'1.0-0' }}
                </span>
              </div>
              <div class="w-full bg-surface-muted rounded-full h-3 overflow-hidden shadow-inner">
                <div class="h-full rounded-full transition-all duration-1000 ease-out"
                     [class.bg-critical]="b.bucket === '90+'" [class.bg-accent]="b.bucket !== '90+'"
                     [style.width.%]="b.width"></div>
              </div>
            </div>
          }
        </div>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-64"></div>
      }

      <!-- Per-customer A/R table -->
      @defer (hydrate on viewport) {
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="table-rows" [rows]="5" [columns]="4" label="A/R by customer" (retry)="reloadData()">
      <ng-template>
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-muted">
          <h3 class="text-xl font-bold text-ink tracking-tight">A/R by Customer <span class="ml-1 text-xs font-semibold text-ink-muted normal-case">{{ baseCurrency }} (base)</span></h3>
          <button type="button" (click)="exportArByCustomerCsv()" [disabled]="arByCustomer().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-surface-muted border-b border-line text-ink-muted">
              <tr>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Customer</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs text-right">Outstanding</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs text-right">Overdue</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Oldest Bucket</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              @for (row of arByCustomer(); track row.customerId) {
                <tr class="hover:bg-surface-muted transition-colors">
                  <td class="px-6 sm:px-8 py-5 font-bold text-ink">{{ row.customerName }}</td>
                  <td class="px-6 sm:px-8 py-5 text-right font-mono tabular-nums text-ink-secondary">{{ row.totalOutstanding | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-6 sm:px-8 py-5 text-right font-mono tabular-nums" [class.text-critical-text]="row.overdue > 0" [class.text-ink-secondary]="row.overdue === 0">{{ row.overdue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-6 sm:px-8 py-5">
                    <span class="command-status"
                          [class]="row.oldestBucket === '90+' ? 'bg-critical-tint text-critical-text ring-1 ring-critical' : 'bg-accent-tint text-accent-text ring-1 ring-accent'">
                      {{ row.oldestBucket === '—' ? '—' : row.oldestBucket + ' days' }}
                    </span>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="4" class="px-6 sm:px-8 py-8 text-center text-ink-muted text-sm">No outstanding receivables.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      </ng-template>
      </app-list-state>
      } @placeholder {
        <div class="command-skeleton h-48"></div>
      }
    </div>
  `
})
export class Reporting {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notificationService = inject(NotificationService);
  private platformId = inject(PLATFORM_ID);

  /**
   * Selected reporting period. Drives the length of the recognised-revenue trend
   * window (1 / 3 / 12 months) — the real prior-period comparison shown on the
   * Realization strip. It no longer scales any fabricated KPI trend figures (#15).
   */
  period = signal<'30d' | 'quarter' | 'year'>('30d');

  /** Months in the current trend window for each period selection (prior block is equal-length). */
  private periodMonths = computed(() => (this.period() === 'year' ? 12 : this.period() === 'quarter' ? 3 : 1));

  /**
   * Hours that constitute one FTE over the trend window, used to convert approved
   * delivery hours into an FTE denominator for revenue-per-FTE (≈160h/month).
   */
  protected readonly hoursPerFte = 160;

  // This forkJoin pulls several principal-gated collections (resources, requests,
  // assignments, orders, order-lines, project-financials, time-entries,
  // billing-plan-items, contracts, customers) that 401 until the OIDC token is
  // restored. On reload the token
  // restores async, so firing immediately would 401 and forkJoin's fail-fast would
  // latch the whole report to its empty default. Key the load on auth.authReady()
  // so it fires only AFTER the OAuth bootstrap settles (bearer token attached);
  // until then it resolves to the same empty default. authReady false->true re-runs
  // the stream.
  private dataRes = rxResource<ReportingData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            resources: this.api.getResources(),
            assignments: this.api.getAssignments(),
            requests: this.api.getRequests(),
            projects: this.api.getProjects(),
            orders: this.api.getOrders(),
            orderLines: this.api.getOrderLines(),
            financials: this.api.getProjectFinancials(),
            timeEntries: this.api.getTimeEntries(),
            issues: this.api.getProjectIssues(),
            changeRequests: this.api.getChangeRequests(),
            milestones: this.api.getMilestones(),
            billingItems: this.api.getBillingPlanItems(),
            contracts: this.api.getContracts(),
            customers: this.api.getCustomers(),
            // Negotiated sell rates (design spec §4/§6) feed the as-incurred T&M
            // branch of recognitionSchedule via financeData() below. Loaded in
            // the SAME forkJoin as every other principal-gated collection here —
            // never a second independent load — so it settles at the same tick
            // and never makes a figure change under the user's eyes after paint.
            negotiatedRates: this.api.getNegotiatedRates(),
            // €/day -> €/hour divisor for the negotiated rates above. An OPEN
            // read, but it joins this SAME forkJoin rather than a second
            // independent one so the priced figure never renders from a partial
            // envelope (a money figure must never do that).
            hoursPerDay: this.api.getHoursPerDay().pipe(map(r => r.value)),
            // Baseline vs Planned columns (design spec, block E, §7) — appended
            // AFTER hoursPerDay, matching this forkJoin's own established
            // convention (see the negotiatedRates/hoursPerDay comments above)
            // so a new leg is never inserted mid-block.
            assignmentDays: this.api.getAssignmentDays(),
            assignmentMonths: this.api.getAssignmentMonths(),
            costBaselines: this.api.getCostBaselines(),
            // H (Q4) — the fourth bench state, appended AFTER costBaselines
            // rather than inserted mid-block, this forkJoin's own convention
            // (see the negotiatedRates/hoursPerDay comments above). REQUIRED
            // leg, deliberately no catchError: a failed bench read must surface
            // as this page's error state, never silently render an unmarked
            // chart in which someone on leave is indistinguishable from someone
            // nobody managed to staff — which is the exact defect this leg
            // exists to fix.
            benchRollup: this.api.getBenchMonthly(),
          })
        : of<ReportingData>(EMPTY_DATA),
    defaultValue: EMPTY_DATA,
  });

  /**
   * FX rate table (base-currency value of 1 unit of each currency) for
   * multi-currency rollups. Gated on auth readiness so it (re)runs together with
   * the gated data load above and never feeds stale/empty FX into the rollups
   * while the post-reload token is still being restored.
   */
  private fxRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getFxRates() : of<FxRate[]>([])),
    defaultValue: [],
  });

  /** Reporting/base currency label for converted portfolio/AR/margin totals. */
  protected readonly baseCurrency = BASE_CURRENCY;

  /**
   * Compact base-currency formatter shared by the SVG charts' value/axis labels so
   * they read like the surrounding tables (e.g. "€48K") rather than long figures.
   * Passed to the charts' `format` input, which always wins over formatKind/locale.
   */
  protected readonly eurCompact = (v: number): string =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: BASE_CURRENCY, notation: 'compact', maximumFractionDigits: 1 }).format(v);

  /**
   * ACCESS FEEDBACK: this report reads role-gated collections in a fail-fast
   * forkJoin, and 401s are deliberately NOT toasted by the error interceptor.
   * Without this notice, an anonymous or under-privileged user would see a page
   * of silent zeros with misleading "no data yet" empty states. When the load
   * errors, say WHY (sign in vs insufficient role) instead of pretending the
   * portfolio is empty.
   */
  protected accessNotice = computed<string | null>(() => {
    if (this.dataRes.status() !== 'error') return null;
    return this.auth.isAuthenticated()
      ? 'Your role does not have access to the financial reporting data. The figures below are incomplete.'
      : 'Sign in to view portfolio analytics — financial data requires an authenticated role.';
  });

  /**
   * Loading/error flags for the ListState wrappers around the data-backed panels.
   * `dataLoading` covers both the gated data load and the FX table; `dataError`
   * mirrors the same error state the access notice keys on, so a 401 shows the
   * documented under-privileged notice AND a Retry-able panel instead of zero-flash.
   */
  protected dataLoading = computed(() => !this.auth.authReady()
    || this.dataRes.isLoading()
    || this.fxRes.isLoading());
  protected dataError = computed(() => this.dataRes.status() === 'error' || this.fxRes.status() === 'error');

  /** Reload both gated resources behind the ListState Retry affordance. */
  protected reloadData(): void {
    this.dataRes.reload();
    this.fxRes.reload();
  }

  /**
   * The ONE place `dataRes.value()` is dereferenced (`fxEnvelope` below is its
   * twin for the FX table). Same guard, same reasoning, as
   * `capacity.component.ts`'s `envelope` — read that comment for the full account.
   *
   * `rxResource.value()` THROWS while the resource is in its error state, and the
   * ~40 accessors below used to read it unconditionally. The money regions were
   * gated behind `@if (dataError())` and ListState wrappers, but one reader was
   * missed: the Concentration KPI `@defer` block, which sat outside every gate.
   * `concentration()` -> `financeData()` -> `value()` threw from there and aborted
   * the whole change-detection pass, taking the access notice above it and all ten
   * Retry panels below it with it — the surfaces written for exactly this failure.
   * A finance user whose bearer expired got the header and then nothing.
   *
   * Reordering the template does not fix that: the abort simply moves to whichever
   * binding is now first. The guard has to live at the dereference.
   *
   * Short-circuiting to EMPTY_DATA is NOT the forbidden "a failed read means no
   * data" accessor: nothing derived from these envelopes is ever rendered during
   * the error state. `dataError()` gates the KPI/financials/realization strips,
   * and every remaining panel — the Concentration cards included, as of this fix —
   * is inside a ListState that replaces its content with the error panel. The
   * empty envelope exists only so the signal graph can settle without throwing
   * while the error surfaces are the things on screen, and the spec asserts that
   * absence by name ("Top Customer Share", "Portfolio Financials").
   */
  private envelope = computed<ReportingData>(() =>
    this.dataRes.status() === 'error' ? EMPTY_DATA : this.dataRes.value(),
  );

  /**
   * The FX table's own guard. Separate from `envelope` because the two resources
   * fail independently — an FX-only failure leaves `dataRes` perfectly readable
   * and would still throw out of the same `financeData()` below. Empty rates mean
   * the rollups fall back to unconverted figures, which is why `dataError()`
   * covers BOTH resources and keeps those figures off screen either way.
   */
  private fxEnvelope = computed<FxRate[]>(() =>
    this.fxRes.status() === 'error' ? [] : this.fxRes.value(),
  );

  private financeData = computed<FinanceData>(() => {
    const d = this.envelope();
    return { requests: d.requests, assignments: d.assignments, resources: d.resources, orders: d.orders, orderLines: d.orderLines, financials: d.financials, timeEntries: d.timeEntries, changeRequests: d.changeRequests, projects: d.projects, billingItems: d.billingItems, contracts: d.contracts, customers: d.customers, milestones: d.milestones, fxRates: this.fxEnvelope(), negotiatedRates: d.negotiatedRates, hoursPerDay: d.hoursPerDay, assignmentDays: d.assignmentDays, assignmentMonths: d.assignmentMonths, costBaselines: d.costBaselines };
  });

  /** Real per-project profitability (revenue/margin) from the commercial + finance data. */
  projectMargins = computed(() =>
    this.envelope().projects
      .map(p => {
        const f = computeProjectFinancials(p.id, this.financeData());
        return { name: p.name, revenue: f.revenue, margin: f.margin, marginPct: f.marginPct };
      })
      .filter(p => p.revenue > 0),
  );

  /**
   * THE portfolio margin, fully loaded (Q2, decided 2026-08-07 — spec §10).
   *
   * WHY THIS IS A CALL AND NOT THREE SUMS. The three tiles below used to
   * open-code `Σ projectMargins()`, and `projectMargins()` filters
   * `revenue > 0` — so a non-billable engagement, whose revenue is 0 by
   * construction, was DROPPED from this page's Total Margin while the dashboard's
   * same-named tile (an unfiltered Σ over every project) kept it. Two tiles
   * called "Total Margin"/"Portfolio Margin", two different questions, and
   * nothing on either screen said so. Q2 answers the question once; routing both
   * screens through `portfolioMarginFullyLoaded` is what makes them the same
   * answer, and makes "fully loaded" a property of one named function rather
   * than of two hand-rolled reducers that can drift again.
   *
   * `projectMargins()` is deliberately left as it is: it feeds the PER-PROJECT
   * margin chart and list, where "projects carrying customer revenue" is the
   * right population and a project's own margin is unchanged by H (spec §11).
   */
  protected readonly portfolioMargin = computed<PortfolioMargin>(() =>
    portfolioMarginFullyLoaded(this.financeData()),
  );

  totalRevenue = computed(() => this.portfolioMargin().revenue);
  totalMargin = computed(() => this.portfolioMargin().fullyLoadedMargin);
  portfolioMarginPct = computed(() => this.portfolioMargin().fullyLoadedMarginPct);

  /**
   * finance.util's rule for "is this margin percentage measured, or the
   * no-revenue sentinel?", per ROW — so a non-billable engagement in the P&L
   * table is judged on its own revenue, not the portfolio's.
   */
  protected hasMarginPct(revenue: number): boolean { return hasMeasuredMarginPct(revenue); }

  /** The same question for the fully-loaded PORTFOLIO tile. */
  protected readonly hasPortfolioMarginPct = computed(() => hasMeasuredMarginPct(this.portfolioMargin().revenue));
  totalBacklog = computed(() =>
    this.envelope().projects.reduce((s, p) => s + computeProjectFinancials(p.id, this.financeData()).backlog, 0),
  );
  totalEac = computed(() =>
    this.envelope().projects.reduce((s, p) => s + computeProjectFinancials(p.id, this.financeData()).eac, 0),
  );
  totalVac = computed(() =>
    this.envelope().projects.reduce((s, p) => s + computeProjectFinancials(p.id, this.financeData()).varianceAtCompletion, 0),
  );
  openChanges = computed(() =>
    this.envelope().changeRequests.filter(c => c.status === 'Draft' || c.status === 'Submitted').length,
  );
  highRiskIssues = computed(() =>
    this.envelope().issues.filter(i => i.status !== 'Closed' && (i.severity === 'High' || i.severity === 'Critical' || i.escalated)).length,
  );
  pendingMilestones = computed(() => this.envelope().milestones.filter(m => m.status === 'Pending').length);
  private maxMargin = computed(() => Math.max(1, ...this.projectMargins().map(p => Math.abs(p.margin))));
  marginBars = computed(() => this.projectMargins().map(p => ({ ...p, width: (Math.abs(p.margin) / this.maxMargin()) * 100 })));

  // --- Margin & Variance (per-project drill-down + portfolio alerts) ----------
  /** Alert thresholds surfaced in the UI so the legend matches the firing logic. */
  readonly alertThresholds = DEFAULT_ALERT_THRESHOLDS;

  /**
   * Per-project P&L drill-down: margin drivers (labor/external/expense) joined with
   * the CR-adjusted EAC/VAC/Burn from computeProjectFinancials. Restricted to projects
   * carrying revenue or cost so empty masters don't pad the table. Highest revenue first.
   */
  marginRows = computed(() => {
    const d = this.financeData();
    return this.envelope().projects
      .map(p => {
        const md = marginDrivers(p.id, d);
        const f = computeProjectFinancials(p.id, d);
        const totalCost = md.laborCost + md.externalCost + md.expenseCost;
        // Baseline vs Planned columns (design spec, block E, §7). Rule A
        // (Task 4/6/7, coordinator-confirmed): pcpDeltaPct is null ONLY when
        // pcpBaseline = 0 (never frozen or frozen explicitly at zero) — a
        // descoped month with a nonzero baseline still renders a real,
        // well-defined percentage, never an em dash.
        //
        // COORDINATOR-CAUGHT DEFECT (post-Task-8 review): restricted to
        // periods with a current baseline row (`!outOfBaselineHorizon`)
        // before summing — the unfiltered union also includes every
        // out-of-horizon month (booked hours, baseline 0), so summing
        // planned cost across those never-frozen months against a
        // denominator that only ever contains the few frozen periods
        // compares two different populations (same defect shape as Tasks 6
        // and 7, caught in the same review).
        const baselineRows = costBaselineComparison(d, p.id).filter(r => !r.outOfBaselineHorizon);
        const pcpBaseline = baselineRows.reduce((s, r) => s + r.baseline, 0);
        const pcpPlanned = baselineRows.reduce((s, r) => s + r.planned, 0);
        const pcpDelta = pcpPlanned - pcpBaseline;
        return {
          id: p.id,
          name: p.name,
          revenue: md.revenue,
          laborCost: md.laborCost,
          externalCost: md.externalCost,
          expenseCost: md.expenseCost,
          margin: md.margin,
          marginPct: md.marginPct,
          eac: f.eac,
          vac: f.varianceAtCompletion,
          burnPct: f.burnPct,
          pcpBaseline,
          pcpPlanned,
          pcpDelta,
          pcpDeltaPct: pcpBaseline !== 0 ? (pcpDelta / pcpBaseline) * 100 : null,
          // Stacked cost-driver mini-bar widths (% of this row's total cost; 0 when no cost).
          laborW: totalCost > 0 ? (md.laborCost / totalCost) * 100 : 0,
          externalW: totalCost > 0 ? (md.externalCost / totalCost) * 100 : 0,
          expenseW: totalCost > 0 ? (md.expenseCost / totalCost) * 100 : 0,
        };
      })
      .filter(r => r.revenue > 0 || r.laborCost > 0 || r.externalCost > 0 || r.expenseCost > 0)
      .sort((a, b) => b.revenue - a.revenue);
  });

  /** Portfolio totals for the drill-down footer (CR-adjusted via financeData). */
  marginTotals = computed(() => {
    const rows = this.marginRows();
    return {
      revenue: rows.reduce((s, r) => s + r.revenue, 0),
      laborCost: rows.reduce((s, r) => s + r.laborCost, 0),
      externalCost: rows.reduce((s, r) => s + r.externalCost, 0),
      expenseCost: rows.reduce((s, r) => s + r.expenseCost, 0),
      margin: rows.reduce((s, r) => s + r.margin, 0),
      eac: rows.reduce((s, r) => s + r.eac, 0),
      vac: rows.reduce((s, r) => s + r.vac, 0),
      pcpBaseline: rows.reduce((s, r) => s + r.pcpBaseline, 0),
      pcpPlanned: rows.reduce((s, r) => s + r.pcpPlanned, 0),
      pcpDelta: rows.reduce((s, r) => s + r.pcpDelta, 0),
    };
  });

  /** Projects breaching margin/burn/EAC thresholds; severity-ranked (worst first). */
  alertRows = computed<PortfolioAlertRow[]>(() =>
    [...portfolioAlerts(this.financeData())].sort(
      (a, b) => this.alertSeverityRank(b) - this.alertSeverityRank(a),
    ),
  );

  /** A higher rank = more severe: EAC overrun (3) > over-budget burn (2) > thin margin (1), summed. */
  private alertSeverityRank(row: PortfolioAlertRow): number {
    const a = row.alerts;
    return (a.eacOverBudget ? 3 : 0) + (a.burnOver ? 2 : 0) + (a.marginBelowTarget ? 1 : 0);
  }

  /** Map an alert row to a single overall severity for its colored badge. */
  alertSeverity(row: PortfolioAlertRow): 'critical' | 'warning' {
    return row.alerts.eacOverBudget || row.alerts.burnOver ? 'critical' : 'warning';
  }

  // --- Accounts Receivable (A/R aging) ---------------------------------------
  /** As-of date for aging; resolved once per construction (YYYY-MM-DD). */
  private readonly today = todayLocalIso();

  private arResult = computed(() => arAging(this.envelope().billingItems, this.today, this.fxEnvelope()));
  arTotalOutstanding = computed(() => this.arResult().totalOutstanding);
  arOverdue = computed(() => this.arResult().overdue);
  arDso = computed(() => dsoOutstanding(this.envelope().billingItems, this.today, this.fxEnvelope()));

  /** Aging buckets in fixed oldest-last order, each carrying amount + count. */
  arBuckets = computed<ArAgingBarRow[]>(() => {
    const buckets = this.arResult().buckets;
    return AR_AGING_BUCKETS.map(bucket => ({ bucket, ...buckets[bucket] }));
  });
  /** Largest bucket amount, for proportional bar widths (never 0). */
  private arMaxBucket = computed(() => Math.max(1, ...this.arBuckets().map(b => b.amount)));
  arBucketBars = computed(() => this.arBuckets().map(b => ({ ...b, width: (b.amount / this.arMaxBucket()) * 100 })));

  /** Per-customer A/R rows (outstanding desc), each with its oldest non-empty bucket label. */
  arByCustomer = computed(() => {
    const d = this.envelope();
    return arAgingByCustomer(d.billingItems, d.contracts, d.customers, this.today, this.fxEnvelope())
      .map(row => ({ ...row, oldestBucket: this.oldestBucketFor(row) }));
  });

  /** Oldest aging bucket with a balance for a customer row; '—' when nothing outstanding. */
  private oldestBucketFor(row: ArAgingCustomerRow): string {
    for (let i = AR_AGING_BUCKETS.length - 1; i >= 0; i--) {
      const key = AR_AGING_BUCKETS[i];
      if (row.buckets[key].amount > 0) return key;
    }
    return '—';
  }

  private activeProjectsCount = computed(() =>
    this.envelope().projects.filter(p => ['in execution', 'in planning', 'active'].includes((p.status ?? '').toLowerCase())).length
  );

  private openRequestsCount = computed(() =>
    this.envelope().requests.filter(isWorkableUncoveredRequest).length
  );

  /**
   * C1: the resources whose saturation is worth measuring — dummy and subco are
   * capacity that does not exist yet and are deliberately OUT of the internal
   * capacity KPIs (spec §4.3/§4.4, same `countsTowardInternalCapacity` split
   * `/capacity/monthly` uses to partition its rollup).
   *
   * This matters concretely, not just in principle: a dummy carries
   * `utilization: 0` by construction (nothing is booked on a placeholder, and
   * the scalar is meaningless for one anyway). Averaging it in drags the
   * portfolio number toward zero in proportion to how many placeholders the
   * organisation has pre-loaded, and charting it grows a flat-zero bar per
   * placeholder. Both read as an internal-capacity problem that isn't one.
   */
  private internalResources = computed(() =>
    this.envelope().resources.filter(r => countsTowardInternalCapacity(kindOf(r))),
  );

  /**
   * The month the ABSENT marks describe: TODAY's month, and only if the fetched
   * bench window covers it. Same rule and same clock helper as
   * `dashboard.component.ts`'s `currentBenchMonth` and `bench.component.ts` —
   * `todayLocalIso()` rather than `new Date().toISOString()`, which names the
   * wrong month around midnight on the 1st (east of UTC) or the last (west of it).
   *
   * `''` when the window has no present tense, and every consumer below then
   * marks NOBODY. That is the honest answer — an unmarked chart is what the
   * screen showed before H — but it is also why `absenceScopeNote()` exists: an
   * unmarked chart must not silently pass for "nobody is away".
   */
  private readonly currentBenchMonth = computed(() => {
    const now = todayLocalIso().slice(0, 7);
    return this.envelope().benchRollup.months.includes(now) ? now : '';
  });

  /**
   * Q4 — who cannot be staffed at all this month. Read off the bench rollup's
   * fourth state, so this screen inherits T4's arithmetic (a month is `ABSENT`
   * only when `monthAvailability === 'fully-absent'`) rather than re-deriving
   * "away" from date intervals it would have to fetch from a route whose
   * audience is not this one.
   *
   * BOTH row sets are walked. `internalResources()` filters the CHART to
   * internals, but a subco can be on sick leave too, and building the set from
   * `internalRows` alone would make the correctness of this signal depend on a
   * filter applied three computeds away.
   */
  private readonly absentResourceIds = computed<ReadonlySet<string>>(() => {
    const month = this.currentBenchMonth();
    const out = new Set<string>();
    if (!month) return out;
    const rollup = this.envelope().benchRollup;
    for (const row of [...rollup.internalRows, ...rollup.subcoRows]) {
      if (row.monthly[month]?.state === 'ABSENT') out.add(row.resourceId);
    }
    return out;
  });

  /** The internal resources the utilization average is actually computed over. */
  private readonly countedForAverage = computed(() => {
    const away = this.absentResourceIds();
    return this.internalResources().filter(r => !away.has(r.id));
  });

  /**
   * Org-wide mean utilization (spec §5.4 U6, the twin of `/utilization`'s U2).
   *
   * Someone on leave for the whole month carries the scalar their profile
   * happened to hold — usually 0, since nothing is booked on them — and averaging
   * it in reads as an internal-capacity problem that is not one: nobody failed to
   * staff her, she could not be staffed. So the ABSENT rows leave the
   * DENOMINATOR, and `kpis()` says how many left it. Same shape as the C1 fix
   * one line up, which took dummy and subco out of this same mean.
   */
  private avgUtilization = computed(() => {
    const resources = this.countedForAverage();
    if (!resources.length) return 0;
    const total = resources.reduce((sum, r) => sum + (r.utilization ?? 0), 0);
    return total / resources.length;
  });

  /** How many internal rows the mean above dropped for being away all month. */
  private readonly absentFromAverageCount = computed(() =>
    this.internalResources().length - this.countedForAverage().length,
  );

  // --- Realization & productivity (portfolio roll-up of realizationMetrics) ----
  /**
   * Portfolio realization & revenue-per-FTE, from the pure roll-up (H, spec §5.3
   * F-7). The additive parts are summed and the ratios re-derived on the totals;
   * headcount is de-duplicated across projects. That arithmetic used to be
   * open-coded here, which is precisely why the non-billable exclusion had to
   * move into `finance.util.ts`: re-implementing it in a component would have
   * put a money rule where the money rules are not tested.
   *
   * Two behavioural changes come with the swap, both deliberate:
   *   • non-billable engagements are OUT (0% realization on a positive rate-card
   *     value is not a realization, it is a missing customer);
   *   • the universe is `attributableProjectIds` (every id money can be attributed
   *     to), not `envelope().projects` — so an engagement with approved time and
   *     no project master row no longer silently drops out of the denominator.
   */
  realization = computed<PortfolioRealization>(() =>
    portfolioRealization(this.financeData(), { hoursPerFte: this.hoursPerFte }),
  );

  /** How many engagements the realization strip leaves out for being non-billable. */
  protected readonly realizationExcludedCount = computed(() => this.realization().excludedProjectIds.length);

  /** How many engagements contribute cost, and no customer revenue, to the margin. */
  protected readonly nonBillableCount = computed(() => this.portfolioMargin().nonBillableProjectIds.length);

  /**
   * Real recognised-revenue trend across the selected window vs the immediately
   * preceding equal-length window, derived purely from dated billing/time data.
   * `direction` is null (indicator HIDDEN) whenever the prior window has no basis —
   * we never fabricate a trend (#15).
   */
  recognizedTrend = computed<PeriodDelta>(() => {
    const periods = this.recentPeriods(this.periodMonths());
    return periods.length === 0 ? periodDelta(0, null) : recognizedRevenueTrend(this.financeData(), periods);
  });

  /** The last `n` calendar months as YYYY-MM (oldest first), anchored on `today`. */
  private recentPeriods(n: number): string[] {
    const out: string[] = [];
    const [y, m] = this.today.slice(0, 7).split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return out;
    let yy = y, mm = m;
    for (let i = 0; i < n; i++) {
      out.unshift(`${yy}-${String(mm).padStart(2, '0')}`);
      mm -= 1;
      if (mm < 1) { mm = 12; yy -= 1; }
    }
    return out;
  }

  // --- Customer profitability & concentration --------------------------------
  /** Per-customer revenue/cost/margin (revenue desc) with revenue-share + bar width. */
  customerRows = computed(() => {
    const conc = customerConcentration(this.financeData());
    const total = conc.totalRevenue;
    const maxRev = Math.max(1, ...customerProfitability(this.financeData()).map(r => Math.max(0, r.revenue)));
    return customerProfitability(this.financeData()).map(r => ({
      ...r,
      sharePct: total > 0 && r.revenue > 0 ? (r.revenue / total) * 100 : 0,
      shareW: (Math.max(0, r.revenue) / maxRev) * 100,
    }));
  });

  /** Portfolio totals across the customer rows (for the table footer). */
  customerTotals = computed(() => {
    const rows = this.customerRows();
    const revenue = rows.reduce((s, r) => s + r.revenue, 0);
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    const margin = revenue - cost;
    return { revenue, cost, margin, marginPct: revenue > 0 ? (margin / revenue) * 100 : 0 };
  });

  /** Revenue-concentration metrics (top share, top-3 share, HHI) for the KPI strip. */
  concentration = computed<CustomerConcentration>(() => customerConcentration(this.financeData()));

  // --- Margin-compression alerts (project + customer, severity-graded) --------
  compressionAlerts = computed<MarginCompressionAlert[]>(() => marginCompressionAlerts(this.financeData()));
  /** Thresholds surfaced in the UI so the caption matches the firing logic. */
  readonly marginCompressionThresholds = DEFAULT_MARGIN_COMPRESSION_CONFIG;

  /** Tailwind classes for a severity badge (AA-contrast light theme). */
  severityBadgeClass(s: AlertSeverity): string {
    switch (s) {
      case 'high': return 'bg-critical-tint text-critical-text ring-1 ring-critical';
      case 'medium': return 'bg-caution-tint text-caution-text ring-1 ring-caution';
      default: return 'bg-surface-muted text-ink-secondary ring-1 ring-line';
    }
  }

  /** Title-cased severity label for the badge. */
  severityLabel(s: AlertSeverity): string {
    return s === 'high' ? 'High' : s === 'medium' ? 'Medium' : 'Low';
  }

  kpis = computed<Kpi[]>(() => [
    // #15: these are point-in-time COUNT/AVERAGE metrics with no dated history to
    // derive a prior period from, so their trend is null and the indicator is
    // HIDDEN (never a fabricated %). The one metric we can trend honestly —
    // recognised revenue — drives the Realization strip below via recognizedTrend().
    { label: 'Total Active Projects', value: String(this.activeProjectsCount()), trend: null, icon: 'folder', colorClass: 'bg-accent' },
    {
      label: 'Avg Resource Utilization', value: `${Math.round(this.avgUtilization())}%`, trend: null, icon: 'bar_chart', colorClass: 'bg-positive',
      // U6: the denominator changed, so it says so. `undefined` when nobody was
      // dropped, so the qualification never becomes wallpaper.
      note: this.absentFromAverageCount() > 0
        ? `Excludes ${this.absentFromAverageCount()} away on leave all month`
        : undefined,
    },
    { label: 'Open Resource Requests', value: String(this.openRequestsCount()), trend: null, icon: 'person_add', colorClass: 'bg-caution' },
    { label: 'Delivery Risk Items', value: String(this.highRiskIssues() + this.openChanges() + this.pendingMilestones()), trend: null, icon: 'warning', colorClass: 'bg-critical' },
  ]);

  /** Human-readable label for a real trend badge (used as aria-label on the icon chip). */
  trendAriaLabel(t: PeriodDelta | null): string {
    if (!t || t.direction === null || t.deltaPct === null) return 'No prior-period comparison available';
    const dir = t.direction === 'up' ? 'up' : t.direction === 'down' ? 'down' : 'flat';
    return `Trend ${dir} ${Math.abs(t.deltaPct).toFixed(0)}% versus prior period`;
  }

  /**
   * Q4 — the ONE spelling of "away" this screen uses, kept beside the chart it
   * marks. The glyph, the wording and the tone are `availability-strip`'s
   * canonical treatment verbatim (`bg-info-tint` / `text-info-text` / `ring-info`
   * measures 6.15:1 in light and 7.24:1 in dark, AA with margin in both), so
   * /staffing, /bench, /utilization and this chart read alike instead of three
   * screens agreeing and one not. 'L' rather than 'A' because ALLOCATED already
   * owns 'A' on that strip.
   *
   * NO CAUSE IS NAMED, and that is a privacy requirement rather than a wording
   * choice: absence reasons are special-category data (§7.3), this screen's
   * audience is not the reason's audience, and the rollup it reads carries no
   * `reasonCode` to leak even by accident.
   */
  protected readonly AWAY_GLYPH = 'L';
  protected readonly AWAY_LABEL = 'Away (on leave) — not staffable';
  protected readonly AWAY_TONE = 'bg-info-tint text-info-text ring-1 ring-info';

  /**
   * Per-person utilization bars. Internal only — see `internalResources()`.
   *
   * WHY THE MARK IS IN THE LABEL AND NOT IN THE BAR. Q4 asks for a distinct
   * rendering, and a hatch or pattern on the bar CANNOT be it: the bar chart maps
   * a value of 0 to `h = |valueToPos(0) − valueToPos(0)| = 0`
   * (command-bar-chart.component.ts's `makeGroupedRect`), so an away person's bar
   * has literally no area to fill — a pattern would render nothing at all, and
   * the tone would too. The signals that survive a zero-area bar are the CATEGORY
   * LABEL (text, so it also survives monochrome, a screen reader and the chart's
   * own a11y table) and the annotation beside the chart. The `info` tone is still
   * applied per-datum, as the third redundant channel for the case the bar does
   * have area — the scalar `utilization` is a whole-of-time profile value that H
   * deliberately leaves alone (spec §11), so an away person can read non-zero,
   * and that is the case where a bare 0-height assumption would have marked
   * nothing.
   */
  utilizationData = computed(() => {
    const away = this.absentResourceIds();
    return this.internalResources().map(r => {
      const absent = away.has(r.id);
      const first = r.name.split(' ')[0] || r.name;
      return {
        // The resource id, carried purely so the annotation below has a UNIQUE
        // track key. The chart's own category axis has always been first names,
        // which two people can share; a `@for` keyed on that would throw on a
        // duplicate, and a screen that crashes because two colleagues are both
        // called Marco is not a theoretical failure.
        id: r.id,
        month: absent ? `${first} (away)` : first,
        value: Math.round(r.utilization ?? 0),
        absent,
      };
    });
  });

  /** The away rows the chart is currently marking, for the annotation beside it. */
  protected readonly awayOnChart = computed(() => this.utilizationData().filter(b => b.absent));

  /**
   * What the marks can and cannot say right now — the assertion of absence the
   * caption alone cannot make. With no present-tense column in the fetched bench
   * window there is nothing to mark, and an unmarked chart must not be readable
   * as "nobody is away": that is the same defect as the bench tile's bare "0 / 0"
   * (dashboard.component.ts's `benchTileNote`), and the same remedy.
   */
  protected readonly absenceScopeNote = computed<string>(() => {
    if (this.envelope().benchRollup.months.length === 0) return '';
    if (!this.currentBenchMonth()) return 'Leave is not marked: the fetched availability window does not reach the current month.';
    const n = this.awayOnChart().length;
    return n === 0
      ? 'Nobody internal is away for the whole of this month.'
      : `${n} ${n === 1 ? 'person is' : 'people are'} away for the whole of this month, kept on the chart at their profile figure and left out of the average.`;
  });

  // --- Chart input contracts (Ledger SVG chart library) -----------------------
  /**
   * Per-resource utilization as a vertical bar chart. Categories are the same
   * first-name labels the old div-bar used (`utilizationData().month`); values are
   * the same rounded utilization %. Built-in `percent` treats raw as a fraction, so
   * a custom `format` renders the already-scaled 0–100 value as "NN%".
   */
  utilizationChartCategories = computed<readonly string[]>(() => this.utilizationData().map(b => b.month));
  utilizationChartSeries = computed<readonly BarSeries[]>(() => [
    {
      name: 'Utilization',
      values: this.utilizationData().map(b => b.value),
      // `undefined` keeps the series' own themed default for everyone present —
      // per-datum overrides win only where one is defined — so this tones the
      // away bars without recolouring the chart.
      colors: this.utilizationData().map(b => (b.absent ? 'var(--color-info)' : undefined)),
    },
  ]);
  protected readonly utilizationPctFormat = (v: number): string => `${Math.round(v)}%`;

  /**
   * Project margin as a horizontal bar chart (one bar per project, base-currency).
   * Same source as `projectMargins()`; the chart's signed baseline renders negative
   * margins to the left of zero, replacing the abs()-width div-bar.
   */
  marginChartCategories = computed<readonly string[]>(() => this.projectMargins().map(p => p.name));
  marginChartSeries = computed<readonly BarSeries[]>(() => [
    { name: 'Margin', values: this.projectMargins().map(p => p.margin) },
  ]);

  /**
   * A/R aging as a horizontal bar chart over the fixed oldest-last buckets. Same
   * amounts as `arBuckets()`; the 90+ bucket is tinted critical to match the old
   * div-bar's red highlight, others use the accent.
   */
  arAgingChartCategories = computed<readonly string[]>(() => this.arBuckets().map(b => `${b.bucket} days`));
  arAgingChartSeries = computed<readonly BarSeries[]>(() => [
    {
      name: 'Outstanding',
      values: this.arBuckets().map(b => b.amount),
      color: 'var(--color-accent)',
    },
  ]);

  /**
   * Top customers by revenue as a horizontal bar chart, mirroring the table's
   * revenue column. Capped at the top 8 so the chart stays legible; the full table
   * remains the source of truth below it.
   */
  private customerChartRows = computed(() => this.customerRows().slice(0, 8));
  customerChartCategories = computed<readonly string[]>(() => this.customerChartRows().map(c => c.customerName));
  customerChartSeries = computed<readonly BarSeries[]>(() => [
    { name: 'Revenue', values: this.customerChartRows().map(c => c.revenue) },
  ]);

  /**
   * Revenue-concentration HHI normalised to a 0–1 ratio for the donut gauge (raw
   * HHI is 0–10000). The centered text shows the raw index via `displayText` so the
   * figure matches the KPI card; the arc fills hhi/10000. Tone escalates with risk.
   */
  protected readonly hhiMax = 10000;
  concentrationHhiRatio = computed(() => Math.min(1, Math.max(0, this.concentration().hhi / this.hhiMax)));
  concentrationHhiTone = computed<'accent' | 'caution' | 'critical'>(() => {
    const hhi = this.concentration().hhi;
    return hhi >= 5000 ? 'critical' : hhi >= 2500 ? 'caution' : 'accent';
  });

  /**
   * Recognised-revenue monthly trend over a trailing 12-month window, derived from
   * the same dated recognition schedule that powers `recognizedTrend()`. Each point
   * is that month's `recognized` amount in base currency — a real time series, not a
   * fabricated curve. Empty when there are no derivable periods.
   */
  private recognizedSchedule = computed(() => {
    const periods = this.recentPeriods(12);
    if (periods.length === 0) return [];
    return recognitionSchedule(this.financeData(), periods);
  });
  recognizedTrendCategories = computed<readonly string[]>(() =>
    this.recognizedSchedule().map(r => {
      const [, m] = r.period.split('-');
      const monthIdx = Number(m) - 1;
      return Number.isFinite(monthIdx) && monthIdx >= 0 && monthIdx < 12
        ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthIdx]
        : r.period;
    }),
  );
  recognizedTrendSeries = computed<readonly TrendSeries[]>(() => [
    { name: 'Recognised Revenue', values: this.recognizedSchedule().map(r => r.recognized) },
  ]);

  reports = signal([
    { name: 'Monthly Resource Utilization', category: 'Resource Management', lastGenerated: '2 days ago' },
    { name: 'Project Financial Summary', category: 'Project Management', lastGenerated: '1 week ago' },
    { name: 'Skills Gap Analysis', category: 'Resource Management', lastGenerated: '3 weeks ago' },
    { name: 'Cross-Project Issue Tracking', category: 'Project Management', lastGenerated: 'Yesterday' },
  ]);

  onPeriodChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as '30d' | 'quarter' | 'year';
    this.period.set(value);
  }

  private escapeCsv(v: string): string {
    const s = String(v ?? '');
    const out = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
  }

  /**
   * The KPI summary CSV, split out from `exportReport` so it is assertable
   * without a Blob or an object URL — the export is where a privacy leak would
   * actually leave the building, so it needs a test that reads the bytes.
   *
   * The `Note` column is H's addition (U6/U19): the utilization average now
   * excludes whoever is away all month, and a file that keeps the corrected
   * figure while dropping the caveat is the half that gets forwarded by mail.
   * What the column CANNOT carry is a reason for the leave — not by policy alone
   * but by construction: this screen reads `/bench/monthly`, whose aggregate
   * projection has no `reasonCode` field to write out.
   */
  private buildSummaryCsv(): string {
    // Trend column carries the REAL period delta % (or blank when not derivable) — never a fabricated figure (#15).
    const trendCell = (t: PeriodDelta | null): string =>
      t && t.deltaPct !== null && t.direction !== null ? `${t.deltaPct > 0 ? '+' : ''}${t.deltaPct.toFixed(0)}%` : '';
    return 'KPI,Value,Trend,Note\n' +
      this.kpis()
        .map(k => [k.label, k.value, trendCell(k.trend), k.note ?? ''].map(c => this.escapeCsv(c)).join(','))
        .join('\n');
  }

  exportReport(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const csvContent = this.buildSummaryCsv();

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'Reporting_Summary.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.notificationService.show('Report exported successfully', 'success');
  }

  /** Export the A/R aging buckets (amounts in base currency) as CSV. */
  exportArAgingCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const csv = toCsv(this.arBuckets(), [
      { key: 'bucket', header: 'Bucket (days)' },
      { key: 'count', header: 'Invoices' },
      { key: 'amount', header: `Amount (${this.baseCurrency} base)`, map: r => r.amount.toFixed(2) },
    ]);
    downloadCsv('AR_Aging.csv', csv);
    this.notificationService.show('A/R aging exported', 'success');
  }

  /** Export the per-customer A/R table (amounts in base currency) as CSV. */
  exportArByCustomerCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const csv = toCsv(this.arByCustomer(), [
      { key: 'customerName', header: 'Customer' },
      { key: 'totalOutstanding', header: `Outstanding (${this.baseCurrency} base)`, map: r => r.totalOutstanding.toFixed(2) },
      { key: 'overdue', header: `Overdue (${this.baseCurrency} base)`, map: r => r.overdue.toFixed(2) },
      { key: 'oldestBucket', header: 'Oldest Bucket (days)' },
    ]);
    downloadCsv('AR_By_Customer.csv', csv);
    this.notificationService.show('A/R by customer exported', 'success');
  }

  /**
   * The Margin & Variance drill-down as CSV text.
   *
   * Split out from the exporter below for the same reason `buildPlanningSheet`
   * is split out from its download: a column map that can only be reached
   * through `downloadCsv` can only be tested by mocking the download, and the
   * thing worth asserting is the CELL, not that a click happened.
   */
  private buildMarginVarianceCsv(): string {
    const cur = this.baseCurrency;
    return toCsv(this.marginRows(), [
      { key: 'name', header: 'Project' },
      { key: 'revenue', header: `Revenue (${cur} base)`, map: r => r.revenue.toFixed(2) },
      { key: 'laborCost', header: `Labor (${cur} base)`, map: r => r.laborCost.toFixed(2) },
      { key: 'externalCost', header: `External (${cur} base)`, map: r => r.externalCost.toFixed(2) },
      { key: 'expenseCost', header: `Expense (${cur} base)`, map: r => r.expenseCost.toFixed(2) },
      { key: 'margin', header: `Margin (${cur} base)`, map: r => r.margin.toFixed(2) },
      // Same rule as the on-screen cell, and it matters MORE here: a "0.0" that
      // leaves the app gets pasted into a deck or averaged in a spreadsheet,
      // where nothing recalls it was a sentinel. The em dash matches the
      // pcpDeltaPct column two rows down, which already spells "undefined" that
      // way in this very file.
      { key: 'marginPct', header: 'Margin %', map: r => hasMeasuredMarginPct(r.revenue) ? r.marginPct.toFixed(1) : '—' },
      { key: 'eac', header: `EAC (${cur} base)`, map: r => r.eac.toFixed(2) },
      { key: 'vac', header: `VAC (${cur} base)`, map: r => r.vac.toFixed(2) },
      { key: 'burnPct', header: 'Burn %', map: r => r.burnPct.toFixed(0) },
      { key: 'pcpBaseline', header: `PCP Baseline (${cur} base)`, map: r => r.pcpBaseline.toFixed(2) },
      { key: 'pcpPlanned', header: `PCP Planned (${cur} base)`, map: r => r.pcpPlanned.toFixed(2) },
      { key: 'pcpDelta', header: `PCP Delta (${cur} base)`, map: r => r.pcpDelta.toFixed(2) },
      { key: 'pcpDeltaPct', header: 'PCP Delta %', map: r => r.pcpDeltaPct !== null ? r.pcpDeltaPct.toFixed(2) : '—' },
    ]);
  }

  /** Export the Margin & Variance drill-down (amounts in base currency) as CSV. */
  exportMarginVarianceCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    downloadCsv('Margin_And_Variance.csv', this.buildMarginVarianceCsv());
    this.notificationService.show('Margin & variance exported', 'success');
  }

  /** The per-customer profitability table as CSV text (see buildMarginVarianceCsv). */
  private buildCustomerProfitabilityCsv(): string {
    const cur = this.baseCurrency;
    return toCsv(this.customerRows(), [
      { key: 'customerName', header: 'Customer' },
      { key: 'revenue', header: `Revenue (${cur} base)`, map: r => r.revenue.toFixed(2) },
      { key: 'cost', header: `Cost (${cur} base)`, map: r => r.cost.toFixed(2) },
      { key: 'margin', header: `Margin (${cur} base)`, map: r => r.margin.toFixed(2) },
      { key: 'marginPct', header: 'Margin %', map: r => hasMeasuredMarginPct(r.revenue) ? r.marginPct.toFixed(1) : '—' },
      { key: 'sharePct', header: 'Revenue Share %', map: r => r.sharePct.toFixed(1) },
      { key: 'projectIds', header: 'Projects', map: r => String(r.projectIds.length) },
    ]);
  }

  /** Export the per-customer profitability table (amounts in base currency) as CSV. */
  exportCustomerProfitabilityCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    downloadCsv('Customer_Profitability.csv', this.buildCustomerProfitabilityCsv());
    this.notificationService.show('Customer profitability exported', 'success');
  }

  // --- RPT .xlsx reports (docs/rpt-comparison.md rows 24 + 44) ---------------
  /**
   * The plan slice the RPT report builders read. Structurally a subset of
   * `ReportingData`, so it is a pass-through — never a second load. It lives here
   * rather than in the builder because this component already holds every collection
   * involved (resources, requests, assignments, assignment days/months, projects) in
   * ONE authReady-gated forkJoin.
   */
  private rptPlanData = computed<RptPlanData>(() => {
    const d = this.envelope();
    return {
      projects: d.projects,
      requests: d.requests,
      assignments: d.assignments,
      assignmentDays: d.assignmentDays,
      assignmentMonths: d.assignmentMonths,
      resources: d.resources,
    };
  });

  /** Units/labels for the workbooks: base currency, and the configured hours-per-day divisor. */
  private rptOpts = computed<RptOpts>(() => ({ currency: this.baseCurrency, hoursPerDay: this.envelope().hoursPerDay }));

  /**
   * Report 1 — Pianificazione (PM): the ONE sheet, split out from the click handler so
   * the exact rows/columns written are assertable without a DOM download (the pattern
   * `capacity.component.ts`'s `buildCsv`/`buildJson` established).
   *
   * `marginRows()` is passed straight through as the financial detail, so the money in
   * the workbook is BY CONSTRUCTION the money in the on-screen Margin & Variance table.
   * It is filtered to commesse carrying revenue or cost, while this sheet's rows are
   * the whole commessa master — a plan-only commessa therefore gets its plan and
   * monthly costs with EMPTY financial cells, never fabricated zeros.
   */
  protected buildPlanningSheet(): XlsxSheet {
    return planningSheet(this.rptPlanData(), this.marginRows(), this.rptOpts());
  }

  /** Report 2 — Allocazione (People Manager): the TWO sheets, Dettaglio then Testata. */
  protected buildAllocationSheets(): XlsxSheet[] {
    return allocationSheets(this.rptPlanData(), this.rptOpts());
  }

  async exportPlanningXlsx(): Promise<void> {
    if (!isPlatformBrowser(this.platformId) || this.dataError()) return;
    await this.writeWorkbook('Pianificazione.xlsx', this.buildPlanningSheet(), 'Pianificazione');
  }

  async exportAllocationXlsx(): Promise<void> {
    if (!isPlatformBrowser(this.platformId) || this.dataError()) return;
    await this.writeWorkbook('Allocazione.xlsx', this.buildAllocationSheets(), 'Allocazione');
  }

  /**
   * Shared tail of the two XLSX exports. `downloadXlsx` is async because the ~260 kB
   * (gzipped) spreadsheet writer is imported lazily on first use — a rejection here is
   * a failed chunk fetch, which must surface as a toast rather than an unhandled
   * promise rejection that leaves the user staring at a button that did nothing.
   */
  private async writeWorkbook(filename: string, sheets: XlsxSheet | XlsxSheet[], label: string): Promise<void> {
    try {
      await downloadXlsx(filename, Array.isArray(sheets) ? sheets : [sheets]);
      this.notificationService.show(`${label} exported`, 'success');
    } catch {
      this.notificationService.show(`Could not build the ${label} workbook`, 'error');
    }
  }

  /** Export the margin-compression alert list (project + customer) as CSV. */
  exportMarginCompressionCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const cur = this.baseCurrency;
    const csv = toCsv(this.compressionAlerts(), [
      { key: 'scope', header: 'Scope' },
      { key: 'name', header: 'Name', map: a => a.name ?? a.id },
      { key: 'severity', header: 'Severity', map: a => this.severityLabel(a.severity) },
      { key: 'revenue', header: `Revenue (${cur} base)`, map: a => a.revenue.toFixed(2) },
      { key: 'cost', header: `Cost (${cur} base)`, map: a => a.cost.toFixed(2) },
      { key: 'marginPct', header: 'Margin %', map: a => a.marginPct.toFixed(1) },
      { key: 'gapPts', header: 'Gap (pts)', map: a => a.gapPts.toFixed(1) },
      { key: 'reasons', header: 'Reasons', map: a => a.reasons.join('; ') },
    ]);
    downloadCsv('Margin_Compression_Alerts.csv', csv);
    this.notificationService.show('Margin-compression alerts exported', 'success');
  }
}
