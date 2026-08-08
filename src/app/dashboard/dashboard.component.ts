import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, of, map } from 'rxjs';
import { AuthService } from '../services/auth.service';
import {
  ApiService,
  Assignment,
  AssignmentDay,
  AssignmentMonth,
  BASE_CURRENCY,
  BillingPlanItem,
  ChangeRequest,
  Contract,
  CostBaseline,
  FinancialItem,
  FxRate,
  Issue,
  NegotiatedRate,
  Order,
  OrderLine,
  Project,
  Resource,
  ResourceRequest,
  TimeEntry,
  type BenchRollup,
} from '../services/api.service';
import { EMPTY_BENCH_ROLLUP } from '../services/bench.util';
import {
  computeProjectFinancials,
  costBaselineComparison,
  FinanceData,
  hasMeasuredMarginPct,
  PeriodDelta,
  PortfolioAlertRow,
  portfolioAlerts,
  PortfolioMargin,
  portfolioMarginFullyLoaded,
  ProjectAlerts,
  recognitionSchedule,
  recognizedRevenueTrend,
} from '../services/finance.util';
import {
  BarSeries,
  CommandBarChartComponent,
  CommandDonutChartComponent,
  CommandTrendChartComponent,
  TrendSeries,
} from '../shared/charts';
import { ListStateComponent } from '../shared/list-state.component';
import { todayLocalIso, trailingMonths } from '../services/local-date.util';
import { countsTowardDeliveryCapacity, kindOf } from '../services/resource-kind.util';
import { isWorkableUncoveredRequest } from '../services/request-demand.util';
import { DEFAULT_HOURS_PER_DAY } from '../services/sell-rate.util';

interface DashboardData {
  resources: Resource[];
  requests: ResourceRequest[];
  projects: Project[];
  assignments: Assignment[];
  orders: Order[];
  orderLines: OrderLine[];
  financials: FinancialItem[];
  timeEntries: TimeEntry[];
  billingItems: BillingPlanItem[];
  issues: Issue[];
  changeRequests: ChangeRequest[];
  contracts: Contract[];
  negotiatedRates: NegotiatedRate[];
  /**
   * The org's working hours/day — the EUR/DAY -> EUR/HOUR divisor sellRateFor
   * needs for a negotiated rate. In this same envelope, never a second load.
   */
  hoursPerDay: number;
  /**
   * BENCH/PARTIAL/ALLOCATED rollup for the "In Bench" tile (Block F, Task 9).
   * Two counts only (internal, subco), never summed — an idle internal gets
   * reallocated, an idle subcontractor does not get renewed and their cost
   * simply stops, so there is no single action a combined total could name.
   */
  benchRollup: BenchRollup;
  /**
   * Baseline vs Planned portfolio tile (design spec, block E, §7) —
   * portfolio total only, no per-project column. Raw per-day/per-month
   * assignment rows plus frozen cost baselines, joined per-project via
   * costBaselineComparison and summed across the portfolio below.
   */
  assignmentDays: AssignmentDay[];
  assignmentMonths: AssignmentMonth[];
  costBaselines: CostBaseline[];
}

type DeliveryHealth = 'green' | 'amber' | 'red';

interface ProjectCommandRow {
  id: string;
  name: string;
  status: string;
  owner: string;
  health: DeliveryHealth;
  revenue: number;
  marginPct: number;
  eac: number;
  vac: number;
  burnPct: number;
  openRisks: number;
  openChanges: number;
}

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    CurrencyPipe,
    DecimalPipe,
    RouterLink,
    CommandTrendChartComponent,
    CommandBarChartComponent,
    CommandDonutChartComponent,
    ListStateComponent,
  ],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Portfolio Delivery Control</div>
          <h1 class="command-title">Delivery Command Center</h1>
          <p class="command-subtitle">
            A single view to govern margin, EAC, risks, change control, resource demand and team utilization.
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 pt-1">
          @if (canViewPortfolioDashboard()) {
            <a routerLink="/reporting" class="command-button secondary">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">insights</mat-icon>
              Reporting
            </a>
          }
          @if (canManageStaffing()) {
            <button type="button" (click)="onNewRequest()" class="command-button">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon>
              New Request
            </button>
          }
        </div>
      </header>

      @if (!canViewPortfolioDashboard()) {
        <section class="command-card p-6 sm:p-8" aria-labelledby="workspace-title">
          <div class="command-eyebrow">Role-aware home</div>
          <h2 id="workspace-title" class="mt-2 font-display text-2xl font-bold text-ink">My workspace</h2>
          <p class="mt-2 max-w-2xl text-sm text-ink-muted">
            Open the areas available to your role. Portfolio financials are shown only to authorized finance readers.
          </p>
          <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <a routerLink="/profile" class="command-card-muted p-5 hover:ring-1 hover:ring-accent">
              <mat-icon class="text-accent-text">person</mat-icon>
              <div class="mt-3 font-bold text-ink">My Profile</div>
              <p class="mt-1 text-sm text-ink-muted">Maintain your skills, roles and experience.</p>
            </a>
            <a routerLink="/assignments" class="command-card-muted p-5 hover:ring-1 hover:ring-accent">
              <mat-icon class="text-accent-text">event_note</mat-icon>
              <div class="mt-3 font-bold text-ink">My Assignments</div>
              <p class="mt-1 text-sm text-ink-muted">Review your schedule and submit actual time.</p>
            </a>
            @if (canManageStaffing()) {
              <a routerLink="/requests" class="command-card-muted p-5 hover:ring-1 hover:ring-accent">
                <mat-icon class="text-accent-text">assignment</mat-icon>
                <div class="mt-3 font-bold text-ink">Resource Requests</div>
                <p class="mt-1 text-sm text-ink-muted">Manage staffing demand and allocations.</p>
              </a>
            }
            @if (canReadCommercial()) {
              <a routerLink="/orders" class="command-card-muted p-5 hover:ring-1 hover:ring-accent">
                <mat-icon class="text-accent-text">receipt_long</mat-icon>
                <div class="mt-3 font-bold text-ink">Commercial</div>
                <p class="mt-1 text-sm text-ink-muted">Open contracts, customers and orders.</p>
              </a>
            }
          </div>
        </section>
      } @else if (hasError()) {
        <!-- Whole-page fetch failure: never contradict the failure with zero KPIs. -->
        <app-list-state
          [error]="true"
          label="the command center"
          (retry)="reload()" />
      } @else if (isLoading()) {
        <!-- 11-endpoint load in flight: skeletons in place of fabricated zeros.
             role="status" + aria-live="polite" + an sr-only text node, copying
             list-state.component.ts:49-50. The aria-label alone named NOTHING:
             ARIA prohibits an accessible name on a role-less generic div, so it
             was dropped, and aria-busy carries no announcement outside a live
             region — the whole 11-request window was silent, indistinguishable
             from an empty or broken page. -->
        <div class="space-y-6" role="status" aria-live="polite" aria-busy="true">
          <span class="sr-only">Loading delivery command center</span>
          <div class="command-eyebrow">Portfolio Financials</div>
          <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 gap-4">
            <div class="command-skeleton h-28 xl:col-span-2"></div>
            @for (tile of [1, 2, 3, 4, 5]; track tile) {
              <div class="command-skeleton h-28"></div>
            }
          </section>
          <section class="grid grid-cols-1 lg:grid-cols-5 gap-4">
            @for (tile of [1, 2, 3, 4, 5]; track tile) {
              <div class="command-skeleton h-24"></div>
            }
          </section>
          <div class="command-skeleton h-48"></div>
          <div class="grid grid-cols-1 xl:grid-cols-[1.45fr_.85fr] gap-5">
            <div class="command-skeleton h-72"></div>
            <div class="command-skeleton h-72"></div>
          </div>
        </div>
      } @else {
      <div class="flex items-center justify-between gap-3">
        <div class="command-eyebrow">Portfolio Financials</div>
        <span class="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted">
          <mat-icon class="text-[16px] w-[16px] h-[16px]">payments</mat-icon>
          {{ baseCurrency }} (base)
        </span>
      </div>

      <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-7 gap-4">
        <!--
          Q2 (spec §10, decided 2026-08-07): FULLY LOADED is in the LABEL, not
          only in a caption. The arithmetic behind this tile did not change — it
          already carried non-billable cost — but its MEANING now has a name, and
          the reader who compares it with a single project's delivery margin needs
          to be told the two are different quantities. The second note line gives
          the term that reconciles them.
        -->
        <div class="command-kpi xl:col-span-2" data-test="portfolio-margin-tile" [class.danger]="hasPortfolioMarginPct() && portfolioMarginPct() < 0" [class.warning]="hasPortfolioMarginPct() && portfolioMarginPct() >= 0 && portfolioMarginPct() < 15">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="command-kpi-label">Portfolio Margin (fully loaded)</div>
              <!-- Reachable with no revenue at all: a portfolio running only
                   non-billable engagements earns none by construction, and then
                   the fully-loaded margin % is finance.util's no-revenue
                   sentinel 0. The tile tone is suppressed with it — "warning"
                   fires on [0,15), so the sentinel would have painted an amber
                   tile off a number that was never measured. -->
              @if (hasPortfolioMarginPct()) {
                <div class="command-kpi-value" data-test="portfolio-margin-pct">{{ portfolioMarginPct() | number:'1.0-1' }}%</div>
              } @else {
                <div class="command-kpi-value text-[var(--cc-muted)]" data-test="portfolio-margin-pct" title="No customer revenue — a margin percentage is undefined">&mdash;</div>
              }
              <div class="command-kpi-note">{{ totalMargin() | currency:'EUR':'symbol':'1.0-0' }} on {{ totalRevenue() | currency:'EUR':'symbol':'1.0-0' }} revenue</div>
              @if (nonBillableCount() > 0) {
                <div class="command-kpi-note" data-test="fully-loaded-note">Includes {{ portfolioMargin().nonBillableCost | currency:'EUR':'symbol':'1.0-0' }} of non-billable cost across {{ nonBillableCount() }} {{ nonBillableCount() === 1 ? 'engagement' : 'engagements' }} — not comparable with a single project&rsquo;s delivery margin</div>
              } @else {
                <div class="command-kpi-note" data-test="fully-loaded-note">No non-billable engagement in the cost base, so this equals delivery margin today</div>
              }
              @if (hasRecognizedRevTrend()) {
                <div class="mt-2 flex items-center gap-1.5">
                  <span class="command-status" [class.green]="trendChipClass(recognizedRevTrend()) === 'green'" [class.red]="trendChipClass(recognizedRevTrend()) === 'red'">
                    <mat-icon class="text-[14px] w-[14px] h-[14px]">{{ trendArrow(recognizedRevTrend()) }}</mat-icon>
                    {{ trendLabel(recognizedRevTrend()) }}
                  </span>
                  <span class="text-[11px] font-medium text-[var(--cc-muted)]">Recognized rev vs prior 3 mo</span>
                </div>
              }
            </div>
            <!-- Portfolio margin% as a radial gauge (capped at a 40% full ring).
                 Dropped entirely when there is no revenue: an arc drawn at the
                 sentinel 0 is the "0%" claim in another shape, and a gauge whose
                 centre reads "—" is a ring measuring nothing. -->
            @if (hasPortfolioMarginPct()) {
              <command-donut-chart
                [value]="marginGaugeValue()"
                [max]="40"
                [size]="76"
                [thickness]="12"
                [tone]="marginGaugeTone()"
                [displayText]="(portfolioMarginPct() | number:'1.0-0') + '%'"
                ariaLabel="Fully loaded portfolio margin gauge"
                caption="Fully loaded portfolio margin percent (non-billable cost included) of a 40 percent target ring" />
            }
          </div>
          @if (hasRecognitionChart()) {
            <!-- Real trailing-6-month recognised-revenue spark (same dated source as the chip). -->
            <div class="mt-3">
              <command-trend-chart
                [categories]="recognitionLabels()"
                [series]="recognitionSeries()"
                mode="area"
                [smooth]="true"
                [showDots]="false"
                formatKind="currency"
                currency="EUR"
                ariaLabel="Recognized revenue, trailing six months"
                caption="Recognized revenue by month (trailing 6 months), base currency EUR" />
            </div>
          }
        </div>

        <div class="command-kpi" [class.danger]="totalVac() < 0" [class.warning]="totalVac() >= 0 && totalVac() < 10000">
          <div class="command-kpi-label">VAC</div>
          <div class="command-kpi-value">{{ totalVac() | currency:'EUR':'symbol':'1.0-0' }}</div>
          <div class="command-kpi-note">Budget minus EAC</div>
        </div>

        <div class="command-kpi info">
          <div class="command-kpi-label">Portfolio EAC</div>
          <div class="command-kpi-value">{{ totalEac() | currency:'EUR':'symbol':'1.0-0' }}</div>
          <div class="command-kpi-note">Actuals + planned residual</div>
        </div>

        <div class="command-kpi" data-test="baseline-tile" [class.danger]="totalBaselineDelta() > 0" [class.info]="totalBaselineDelta() <= 0">
          <div class="command-kpi-label">Baseline vs Planned</div>
          <div class="command-kpi-value">{{ totalBaselineDelta() | currency:'EUR':'symbol':'1.0-0' }}</div>
          <div class="command-kpi-note">{{ totalBaselineDeltaPct() !== null ? ((totalBaselineDeltaPct()! > 0 ? '+' : '') + (totalBaselineDeltaPct() | number:'1.2-2') + '% vs frozen PCP') : 'No baseline frozen yet' }}</div>
        </div>

        <div class="command-kpi warning">
          <div class="command-kpi-label">Open Changes</div>
          <div class="command-kpi-value">{{ openChanges() }}</div>
          <div class="command-kpi-note">{{ criticalChanges() }} critical/high</div>
        </div>

        <div class="command-kpi" [class.danger]="criticalRisks() > 0" [class.info]="criticalRisks() === 0">
          <div class="command-kpi-label">Critical Risks</div>
          <div class="command-kpi-value">{{ criticalRisks() }}</div>
          <div class="command-kpi-note">{{ escalations() }} escalated issues</div>
        </div>
      </section>

      <section class="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div class="command-card-muted p-4">
          <div class="command-kpi-label">Open Resource Requests</div>
          <div class="mt-2 flex items-end justify-between gap-3">
            <span class="font-mono text-3xl font-semibold text-[var(--cc-ink)]">{{ openRequests() }}</span>
            <a routerLink="/requests" class="text-sm font-bold text-[var(--cc-primary)]">Queue</a>
          </div>
        </div>
        <div class="command-card-muted p-4">
          <div class="command-kpi-label">Overbooked Resources</div>
          <div class="mt-2 flex items-end justify-between gap-3">
            <span class="font-mono text-3xl font-semibold" [style.color]="overbookedResources() > 0 ? 'var(--cc-red)' : null">{{ overbookedResources() }}</span>
            <a routerLink="/utilization" class="text-sm font-bold text-[var(--cc-primary)]">Utilization</a>
          </div>
        </div>
        <div class="command-card-muted p-4">
          <div class="command-kpi-label">Active Projects</div>
          <div class="mt-2 flex items-end justify-between gap-3">
            <span class="font-mono text-3xl font-semibold text-[var(--cc-ink)]">{{ activeProjects() }}</span>
            <a routerLink="/projects" class="text-sm font-bold text-[var(--cc-primary)]">Portfolio</a>
          </div>
        </div>
        <div class="command-card-muted p-4">
          <div class="command-kpi-label">Delivery Health</div>
          <div class="mt-3 grid grid-cols-3 gap-2 text-center">
            <div class="rounded-md ring-1 ring-positive bg-positive-tint py-2">
              <div class="font-mono text-lg font-semibold text-positive-text">{{ healthDistribution().green }}</div>
              <div class="text-[10px] font-bold uppercase text-positive-text">Green</div>
            </div>
            <div class="rounded-md ring-1 ring-caution bg-caution-tint py-2">
              <div class="font-mono text-lg font-semibold text-caution-text">{{ healthDistribution().amber }}</div>
              <div class="text-[10px] font-bold uppercase text-caution-text">Amber</div>
            </div>
            <div class="rounded-md ring-1 ring-critical bg-critical-tint py-2">
              <div class="font-mono text-lg font-semibold text-critical-text">{{ healthDistribution().red }}</div>
              <div class="text-[10px] font-bold uppercase text-critical-text">Red</div>
            </div>
          </div>
        </div>
        <div class="command-card-muted p-4" data-test="bench-tile">
          <div class="command-kpi-label">In Bench</div>
          <div class="mt-2 flex items-end justify-between gap-3">
            <span class="font-mono text-2xl font-semibold text-[var(--cc-ink)]">{{ internalBenchCount() }} <span class="text-sm font-normal text-ink-muted">int.</span> / {{ subcoBenchCount() }} <span class="text-sm font-normal text-ink-muted">subco</span></span>
            <a routerLink="/bench" class="text-sm font-bold text-[var(--cc-primary)]">Bench</a>
          </div>
          <!-- Names the month the two counts describe: a bare "0 / 0" cannot say
               whether nobody is benched or the fetched window has no present tense. -->
          @if (benchTileNote()) {
            <div class="mt-1 text-xs text-[var(--cc-muted)]" data-test="bench-tile-month">{{ benchTileNote() }}</div>
          }
          <!-- H (U7/U8): the counts above self-corrected the moment BenchState
               gained a fourth value — somebody on leave is no longer BENCH. But a
               tile whose number simply drops is unexplainable at the point of
               reading, which is the same failure the "fully loaded" label above
               exists to prevent. So the people who LEFT the counts are named here,
               with no reason attached (spec §7.3) and never summed with them. -->
          @if (internalAbsentCount() + subcoAbsentCount() > 0) {
            <div class="mt-1 text-xs text-[var(--cc-muted)]" data-test="bench-tile-away">
              Not counted: {{ internalAbsentCount() }} int. / {{ subcoAbsentCount() }} subco away on leave
            </div>
          }
        </div>
      </section>

      <!-- Below-the-fold: server-rendered into the SSR payload, hydration deferred until scrolled into view. -->
      @defer (hydrate on viewport) {
      <section class="command-card overflow-hidden">
        <div class="command-card-header">
          <div>
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Delivery Alerts</h2>
            <p class="mt-1 text-sm text-[var(--cc-muted)]">Projects breaching margin, burn or EAC thresholds (CR-adjusted budget).</p>
          </div>
          <a routerLink="/reporting" class="command-status" [class.red]="portfolioAlertRows().length > 0" [class.green]="portfolioAlertRows().length === 0">
            {{ portfolioAlertRows().length }} flagged
          </a>
        </div>
        <div class="divide-y divide-[var(--cc-line)]">
          @for (row of portfolioAlertRows(); track row.projectId) {
            <div class="p-4">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <a [routerLink]="['/projects', row.projectId]" class="font-bold text-accent-text hover:underline">
                    {{ row.name || projectName(row.projectId) }}
                  </a>
                  <div class="mt-2 flex flex-wrap items-center gap-1.5">
                    @for (flag of alertFlags(row.alerts); track flag) {
                      <span class="inline-flex items-center rounded-md bg-caution-tint px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-caution-text ring-1 ring-caution">{{ flag }}</span>
                    }
                  </div>
                </div>
                <span class="command-status shrink-0" [class.red]="alertSeverity(row.alerts) === 'red'" [class.amber]="alertSeverity(row.alerts) === 'amber'">
                  {{ alertSeverityLabel(row.alerts) }}
                </span>
              </div>
              <ul class="mt-3 space-y-1">
                @for (reason of row.alerts.items; track reason) {
                  <li class="text-sm text-[var(--cc-muted)]">{{ reason }}</li>
                }
              </ul>
            </div>
          } @empty {
            <div class="p-6 text-sm text-[var(--cc-muted)]">No projects breaching margin, burn or EAC thresholds.</div>
          }
        </div>
      </section>
      } @placeholder {
        <div class="command-skeleton h-48"></div>
      }

      @defer (hydrate on viewport) {
      <div class="grid grid-cols-1 xl:grid-cols-[1.45fr_.85fr] gap-5">
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Portfolio Control Board</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Projects ordered by attention required.</p>
            </div>
            <a routerLink="/projects" class="command-status">Open Project 360</a>
          </div>
          @if (hasVacChart()) {
            <!-- Variance-at-completion of the same top rows below; overruns dip below zero. -->
            <div class="px-4 pt-4">
              <command-bar-chart
                [categories]="vacChartCategories()"
                [series]="vacChartSeries()"
                orientation="horizontal"
                [showValues]="false"
                [height]="200"
                formatKind="currency"
                currency="EUR"
                ariaLabel="Variance at completion by project"
                caption="Variance at completion (budget minus EAC) by project, base currency EUR" />
            </div>
          }
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Health</th>
                  <th>Margin</th>
                  <th>EAC</th>
                  <th>VAC</th>
                  <th>Risk / CR</th>
                </tr>
              </thead>
              <tbody>
                @for (project of projectRows(); track project.id) {
                  <tr>
                    <td>
                      <div class="font-bold">{{ project.name }}</div>
                      <div class="mt-1 text-xs text-[var(--cc-muted)]">{{ project.status }} · {{ project.owner }}</div>
                    </td>
                    <td><span class="command-status" [class.green]="project.health === 'green'" [class.amber]="project.health === 'amber'" [class.red]="project.health === 'red'">{{ healthLabel(project.health) }}</span></td>
                    <td>
                      <!-- A margin PERCENTAGE needs revenue to be a percentage
                           OF. With none it is finance.util's no-revenue
                           sentinel 0 (hasMeasuredMarginPct), and printing "0%"
                           would assert break-even on an engagement that lost
                           money — which is every non-billable row, since
                           revenue is 0 there by construction. The meter goes
                           too: a bar at the 0 mark is the same claim in another
                           shape. -->
                      @if (hasMarginPct(project.revenue)) {
                        <!-- --cc-red-text, not --cc-red: this is a 14px semibold
                             FIGURE, so AA's 4.5:1 applies and the fill tone only
                             reaches 4.47:1 against the dark surface (4.16:1 on a
                             muted row) while the positive figure in the VAC column
                             beside it already uses the -text shade at ~10.8:1. -->
                        <div class="font-mono font-semibold" data-test="project-margin-pct" [style.color]="project.marginPct < 0 ? 'var(--cc-red-text)' : null">{{ project.marginPct | number:'1.0-1' }}%</div>
                        <div class="mt-1 command-meter"><span [style.width.%]="meter(project.marginPct, 40)"></span></div>
                      } @else {
                        <div class="font-mono font-semibold text-[var(--cc-muted)]" data-test="project-margin-pct" title="No customer revenue — a margin percentage is undefined">&mdash;</div>
                      }
                    </td>
                    <td class="font-mono">{{ project.eac | currency:'EUR':'symbol':'1.0-0' }}</td>
                    <!-- Both halves of one signed figure must use the -text
                         shade; this binding was the clearest instance of the
                         disparity (negative VAC 4.47:1, positive VAC ~10.8:1). -->
                    <td class="font-mono font-semibold" [style.color]="project.vac < 0 ? 'var(--cc-red-text)' : 'var(--cc-green-text)'">{{ project.vac | currency:'EUR':'symbol':'1.0-0' }}</td>
                    <td>
                      <span class="font-mono font-semibold">{{ project.openRisks }}</span>
                      <span class="text-[var(--cc-muted)]"> / </span>
                      <span class="font-mono font-semibold">{{ project.openChanges }}</span>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="6" class="text-center text-[var(--cc-muted)]">No projects available.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>

        <section class="space-y-5">
          <div class="command-card overflow-hidden">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Risk & Escalation Queue</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Open issues with high or critical severity, or escalated.</p>
              </div>
              <!-- BOTH tones are conditional. With "red" in the static class
                   list the chip carried it unconditionally, and because
                   styles.css declares .command-status.red AFTER .green the
                   all-clear branch was dead by cascade order: a queue with zero
                   criticals rendered in the same alarm tone as forty open ones,
                   directly contradicting the card body below. Same shape as the
                   criticalRisks KPI tile at :285. -->
              <a routerLink="/project-issues" class="command-status" [class.red]="criticalRisks() > 0" [class.green]="criticalRisks() === 0">Issues</a>
            </div>
            <div class="divide-y divide-[var(--cc-line)]">
              @for (risk of riskQueue(); track risk.id) {
                <div class="p-4">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="font-bold text-[var(--cc-ink)]">{{ risk.title }}</div>
                      <div class="mt-1 text-xs text-[var(--cc-muted)]">{{ projectName(risk.projectId) }} · {{ risk.owner || risk.reportedBy }}</div>
                    </div>
                    <span class="command-status red">{{ risk.severity }}</span>
                  </div>
                  @if (risk.actionPlan) {
                    <p class="mt-3 text-sm text-[var(--cc-muted)]">{{ risk.actionPlan }}</p>
                  }
                </div>
              } @empty {
                <div class="p-6 text-sm text-[var(--cc-muted)]">No critical escalations currently open.</div>
              }
            </div>
          </div>

          <div class="command-card overflow-hidden">
            <div class="command-card-header">
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Change Control</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Budget and schedule impact awaiting decision.</p>
              </div>
              <a routerLink="/change-requests" class="command-status amber">CR</a>
            </div>
            <div class="divide-y divide-[var(--cc-line)]">
              @for (change of changeQueue(); track change.id) {
                <div class="p-4">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <div class="font-bold text-[var(--cc-ink)]">{{ change.title }}</div>
                      <div class="mt-1 text-xs text-[var(--cc-muted)]">{{ projectName(change.projectId) }} · {{ change.status }}</div>
                    </div>
                    <span class="command-status" [class.red]="change.priority === 'Critical'" [class.amber]="change.priority !== 'Critical'">{{ change.priority }}</span>
                  </div>
                  <div class="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <div class="rounded-md bg-[var(--cc-panel-muted)] px-3 py-2">
                      <div class="command-kpi-label">Budget</div>
                      <div class="font-mono font-semibold">{{ change.impactBudget | currency:'EUR':'symbol':'1.0-0' }}</div>
                    </div>
                    <div class="rounded-md bg-[var(--cc-panel-muted)] px-3 py-2">
                      <div class="command-kpi-label">Schedule</div>
                      <div class="font-mono font-semibold">{{ change.impactScheduleDays | number:'1.0-1' }}d</div>
                    </div>
                  </div>
                </div>
              } @empty {
                <div class="p-6 text-sm text-[var(--cc-muted)]">No submitted or draft change requests.</div>
              }
            </div>
          </div>
        </section>
      </div>
      } @placeholder {
        <div class="grid grid-cols-1 xl:grid-cols-[1.45fr_.85fr] gap-5">
          <div class="command-skeleton h-72"></div>
          <div class="command-skeleton h-72"></div>
        </div>
      }

      @defer (hydrate on viewport) {
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Demand Queue</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Open requests with a residual staffing gap.</p>
            </div>
            <a routerLink="/staffing" class="command-status">Staffing</a>
          </div>
          <div class="divide-y divide-[var(--cc-line)]">
            @for (req of demandQueue(); track req.id) {
              <div class="p-4">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="font-bold text-[var(--cc-ink)]">{{ req.name }}</div>
                    <div class="mt-1 text-xs text-[var(--cc-muted)]">{{ req.requiredRole }} · {{ projectName(req.projectId) }}</div>
                  </div>
                  <span class="font-mono text-sm font-semibold">{{ staffedPct(req) | number:'1.0-0' }}%</span>
                </div>
                <div class="mt-3 command-meter">
                  <span [style.width.%]="staffedPct(req)"></span>
                </div>
              </div>
            } @empty {
              <div class="p-6 text-sm text-[var(--cc-muted)]">No open demand gaps.</div>
            }
          </div>
        </section>

        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Capacity Exceptions</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Resources over the control threshold.</p>
            </div>
            <a routerLink="/utilization" class="command-status" [class.red]="overbookedResources() > 0" [class.green]="overbookedResources() === 0">Load</a>
          </div>
          <div class="divide-y divide-[var(--cc-line)]">
            @for (res of overbookedResourcesList(); track res.id) {
              <div class="p-4 flex items-center justify-between gap-4">
                <div class="flex min-w-0 items-center gap-3">
                  <div class="grid size-10 shrink-0 place-items-center rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel-muted)] font-display font-bold text-[var(--cc-ink)]">{{ res.name.charAt(0) }}</div>
                  <div class="min-w-0">
                    <div class="truncate font-bold text-[var(--cc-ink)]">{{ res.name }}</div>
                    <div class="truncate text-xs text-[var(--cc-muted)]">{{ res.role }} · {{ res.organization || 'No org' }}</div>
                  </div>
                </div>
                <div class="text-right">
                  <div class="font-mono text-xl font-semibold text-[var(--cc-red)]">{{ res.utilization | number:'1.0-0' }}%</div>
                  <div class="text-[10px] font-bold uppercase text-[var(--cc-muted)]">Utilization</div>
                </div>
              </div>
            } @empty {
              <div class="p-6 text-sm text-[var(--cc-muted)]">No resources above 110% utilization.</div>
            }
          </div>
        </section>
      </div>
      } @placeholder {
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div class="command-skeleton h-72"></div>
          <div class="command-skeleton h-72"></div>
        </div>
      }
      }
    </div>
  `,
})
export class DashboardComponent {
  private api = inject(ApiService);
  private router = inject(Router);
  private auth = inject(AuthService);

  /** Reporting/base currency for portfolio money KPIs (see EUR caption). */
  protected readonly baseCurrency = BASE_CURRENCY;

  /** Month label for the "In Bench" tile's subtitle — UTC-pinned, like bench.component.ts's. */
  private static readonly BENCH_MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  private static readonly EMPTY_DATA: DashboardData = {
    resources: [],
    requests: [],
    projects: [],
    assignments: [],
    orders: [],
    orderLines: [],
    financials: [],
    timeEntries: [],
    billingItems: [],
    issues: [],
    changeRequests: [],
    contracts: [],
    negotiatedRates: [],
    hoursPerDay: DEFAULT_HOURS_PER_DAY,
    benchRollup: EMPTY_BENCH_ROLLUP,
    assignmentDays: [],
    assignmentMonths: [],
    costBaselines: [],
  };

  // FX rates feed FinanceData so portfolio rollups (margin, revenue, EAC, VAC)
  // are normalised to base currency; empty default => no-op conversion until loaded.
  // Keyed on auth readiness so it (re)runs together with the gated data load.
  private fxRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady() && this.auth.canViewPortfolioDashboard(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getFxRates() : of<FxRate[]>([])),
    defaultValue: [],
  });

  // Several of these reads are principal-gated server-side (resources,
  // time-entries, orders, order-lines, billing-plan-items). Keying the load on
  // auth readiness ensures the forkJoin fires only AFTER the OAuth bootstrap has
  // settled and the bearer token is attached by the interceptor; firing earlier
  // (e.g. on the post-login redirect) sent unauthenticated requests that 401'd,
  // and forkJoin's fail-fast then collapsed the entire dashboard to empty. When
  // authReady flips false->true the params change re-runs the stream.
  private dataRes = rxResource<DashboardData, boolean>({
    params: () => this.auth.authReady() && this.auth.canViewPortfolioDashboard(),
    stream: ({ params: canLoad }) =>
      canLoad
        ? forkJoin({
            resources: this.api.getResources(),
            requests: this.api.getRequests(),
            projects: this.api.getProjects(),
            assignments: this.api.getAssignments(),
            orders: this.api.getOrders(),
            orderLines: this.api.getOrderLines(),
            financials: this.api.getProjectFinancials(),
            timeEntries: this.api.getTimeEntries(),
            billingItems: this.api.getBillingPlanItems(),
            issues: this.api.getProjectIssues(),
            changeRequests: this.api.getChangeRequests(),
            // Negotiated sell rates (design spec §4/§6) need BOTH `contracts`
            // (previously not fetched here at all) and `negotiatedRates` to
            // resolve via sellRateFor: without `contracts`, a project's own
            // contract can never be found, `projectPeriodOk` resolves false,
            // and every as-incurred entry silently falls back to the reference
            // billRate — the negotiated price would never surface here even
            // though `negotiatedRates` was present. Both added to this SAME
            // forkJoin (never a second independent load) so they settle at the
            // same tick as everything else.
            contracts: this.api.getContracts(),
            negotiatedRates: this.api.getNegotiatedRates(),
            // The €/day -> €/hour divisor for those rates (see FinanceData's
            // `hoursPerDay`): in THIS forkJoin so the revenue
            // chart never paints from a partial envelope.
            hoursPerDay: this.api.getHoursPerDay().pipe(map(r => r.value)),
            // "In Bench" tile (Block F, Task 9) — appended AFTER hoursPerDay,
            // never inserted mid-block, to avoid a merge collision on this
            // exact forkJoin (this file's own established convention, see the
            // contracts/negotiatedRates comment above). REQUIRED leg,
            // deliberately no catchError: a failed bench read must surface as
            // this whole page's error state, never silently render "0 in
            // bench" — the Global Constraint this codebase keeps re-fixing.
            // Since dataRes already gates the entire tile grid behind
            // hasError()/isLoading() (computed over this SAME forkJoin), no
            // separate gating is needed for this one tile: the page was
            // already all-or-nothing across its other 14 legs, and this is
            // leg 15, not a new failure surface.
            benchRollup: this.api.getBenchMonthly(),
            // Baseline vs Planned portfolio tile (design spec, block E, Task 7)
            // — appended AFTER benchRollup, matching this forkJoin's own
            // established convention (see the contracts/negotiatedRates and
            // benchRollup comments above) so a new leg is never inserted
            // mid-block. REQUIRED legs, deliberately no catchError: same
            // reasoning as benchRollup — a failed read must surface as this
            // whole page's error state, never silently render a zeroed tile.
            assignmentDays: this.api.getAssignmentDays(),
            assignmentMonths: this.api.getAssignmentMonths(),
            costBaselines: this.api.getCostBaselines(),
          })
        : of(DashboardComponent.EMPTY_DATA),
    defaultValue: DashboardComponent.EMPTY_DATA,
  });

  private data = this.dataRes.value;
  private fxRates = this.fxRes.value;
  protected readonly canViewPortfolioDashboard = this.auth.canViewPortfolioDashboard;
  protected readonly canManageStaffing = this.auth.canManageStaffing;
  protected readonly canReadCommercial = this.auth.canReadCommercial;
  private financeData = computed<FinanceData>(() => {
    const d = this.data();
    return {
      requests: d.requests,
      assignments: d.assignments,
      resources: d.resources,
      orders: d.orders,
      orderLines: d.orderLines,
      financials: d.financials,
      timeEntries: d.timeEntries,
      // Dated billing items + approved time feed recognizedRevenueTrend's
      // current-vs-prior-window recognition (see recognizedRevTrend below).
      billingItems: d.billingItems,
      // CR-adjusted budgets feed burn/EAC/VAC; projects label the alert rows.
      changeRequests: d.changeRequests,
      projects: d.projects,
      // Contract periods + negotiated rates feed the as-incurred T&M branch of
      // recognitionSchedule via sellRateFor (design spec §4/§6).
      contracts: d.contracts,
      negotiatedRates: d.negotiatedRates,
      hoursPerDay: d.hoursPerDay,
      // Normalise multi-currency amounts to base for portfolio money rollups.
      fxRates: this.fxRates(),
      // Baseline vs Planned portfolio tile (design spec, block E, §7).
      assignmentDays: d.assignmentDays,
      assignmentMonths: d.assignmentMonths,
      costBaselines: d.costBaselines,
    };
  });

  // --- Load lifecycle (loading / error gating) --------------------------------
  // The 11-endpoint forkJoin previously rendered the whole command center with
  // zeros while in-flight, and a fetch failure left it indistinguishable from a
  // genuinely empty portfolio — the audit's biggest trust gap. We surface the
  // resource status so the template can show skeletons while loading and an
  // error+retry panel on failure instead of fabricated zero KPIs. Both the data
  // and FX resources gate the view: FX feeds the base-currency rollups, so its
  // status matters too. `reload()` re-fires both.
  protected readonly isLoading = computed(
    () => this.dataRes.isLoading() || this.fxRes.isLoading(),
  );
  protected readonly hasError = computed(
    () => this.dataRes.status() === 'error' || this.fxRes.status() === 'error',
  );

  /** Re-run both gated resources after an error (wired to ListState Retry). */
  protected reload(): void {
    this.dataRes.reload();
    this.fxRes.reload();
  }

  // --- Real period-over-period trend (#15) ------------------------------------
  // The ONLY portfolio KPI here with a prior period derivable from finance.util
  // is recognised revenue: recognizedRevenueTrend compares revenue recognised in
  // the trailing window against the immediately preceding equal-length window,
  // both reconstructed from dated billing items + approved time. The margin/VAC/
  // EAC snapshots and the open-changes/critical-risk counts have NO dated prior
  // basis in finance.util, so they are intentionally rendered WITHOUT a trend
  // chip rather than with a fabricated one.

  /**
   * Trailing 3 calendar months ending at the current month, as sorted YYYY-MM.
   *
   * P2-21: the window closes on the user's LOCAL civil month. It used to read
   * `new Date().getUTCFullYear()/getUTCMonth()`, so from 22:00 (or 23:00) on the
   * last day of a month until midnight UTC, a user at a positive offset — already
   * into the new month — was shown the window ending on the month before, and the
   * "vs prior period" chip compared two windows both one month stale. The month
   * walk itself is still UTC arithmetic (see trailingMonths).
   *
   * Public: the spec reads it directly. There is no other way to observe the
   * window — the trend chip renders a percentage, which is identical for two
   * different windows over empty data.
   */
  readonly trendPeriods = trailingMonths(3, todayLocalIso().slice(0, 7));

  /**
   * Portfolio recognised-revenue delta: current trailing window vs the prior
   * equal-length window. `direction` is null when the prior window is not
   * derivable (no dated source data before the window) — the chip is hidden,
   * never faked. No projectId => whole portfolio.
   */
  recognizedRevTrend = computed<PeriodDelta>(() =>
    recognizedRevenueTrend(this.financeData(), this.trendPeriods),
  );

  /** True only when a real prior reading was derived (caller renders the chip). */
  hasRecognizedRevTrend = computed(() => this.recognizedRevTrend().direction !== null);

  // --- Inline charts -----------------------------------------------------------
  // Real, dated portfolio signal rendered with the Ledger SVG chart library —
  // no fabricated series. The recognised-revenue spark is built from the SAME
  // dated recognitionSchedule that backs the trailing-window trend chip, so the
  // chart and the chip agree by construction.

  /** Trailing 6 calendar months (sorted YYYY-MM) for the recognised-revenue
   *  chart, on the same local-civil-month anchor as `trendPeriods` above — the
   *  chart and the chip must agree about which month is "now". Public for the
   *  same reason: the rendered x-axis labels only exist once some month has a
   *  non-zero recognised amount. */
  readonly chartPeriods = trailingMonths(6, todayLocalIso().slice(0, 7));

  /** Per-period recognised revenue over the trailing 6 months (whole portfolio). */
  private readonly recognitionRows = computed(() =>
    recognitionSchedule(this.financeData(), this.chartPeriods),
  );

  /** Short month labels (e.g. "Jan") for the recognised-revenue trend x-axis. */
  protected readonly recognitionLabels = computed<string[]>(() =>
    this.chartPeriods.map(p => {
      const [y, m] = p.split('-').map(Number);
      return new Date(Date.UTC(y, (m || 1) - 1, 1)).toLocaleString('en-US', {
        month: 'short',
        timeZone: 'UTC',
      });
    }),
  );

  /** Single recognised-revenue series, index-aligned with recognitionLabels. */
  protected readonly recognitionSeries = computed<TrendSeries[]>(() => [
    { name: 'Recognized revenue', values: this.recognitionRows().map(r => r.recognized) },
  ]);

  /** True once there is at least one non-zero recognised month to plot. */
  protected readonly hasRecognitionChart = computed(() =>
    this.recognitionRows().some(r => r.recognized !== 0),
  );

  /**
   * Template access to finance.util's rule for "is this percentage measured, or
   * the no-revenue sentinel?". Taken per ROW (the control-board table), so a
   * non-billable engagement beside a revenue-bearing one is judged on its own
   * revenue rather than the portfolio's.
   */
  protected hasMarginPct(revenue: number): boolean { return hasMeasuredMarginPct(revenue); }

  /** The same question for the fully-loaded PORTFOLIO tile and its gauge. */
  protected readonly hasPortfolioMarginPct = computed(() => hasMeasuredMarginPct(this.portfolioMargin().revenue));

  // --- Portfolio margin gauge --------------------------------------------------
  // The donut arc fills against a 40% full ring; the centred text shows the true
  // margin % (the gauge is a visual cue, the number is the truth). A negative
  // margin fills nothing (arc clamps at 0) but the centred text still shows it.
  protected readonly marginGaugeValue = computed(() => Math.max(0, this.portfolioMarginPct()));
  protected readonly marginGaugeTone = computed<'positive' | 'caution' | 'critical'>(() => {
    const pct = this.portfolioMarginPct();
    if (pct < 0) return 'critical';
    if (pct < 15) return 'caution';
    return 'positive';
  });

  // --- Portfolio control-board chart -------------------------------------------
  // The control-board table lists projects by attention; a companion horizontal
  // bar of the same top rows' VAC (budget − EAC) gives an at-a-glance read of
  // which projects are most over/under their CR-adjusted budget. Negative bars
  // (overruns) render below the zero baseline. Values come straight from
  // projectRows() — identical to the table — so chart and table never diverge.
  protected readonly vacChartCategories = computed<string[]>(() =>
    this.projectRows().map(p => p.name),
  );
  protected readonly vacChartSeries = computed<BarSeries[]>(() => {
    const values = this.projectRows().map(p => p.vac);
    // Tone each bar by sign so overruns read as critical, not the default accent
    // blue: negative VAC (EAC over budget) => critical, non-negative => positive.
    // Mirrors the table's text-critical-text treatment of over-budget rows.
    const colors = values.map(v =>
      v < 0 ? 'var(--color-critical)' : 'var(--color-positive)',
    );
    return [{ name: 'VAC', values, colors }];
  });
  /** Only worth charting once there are at least two projects to compare. */
  protected readonly hasVacChart = computed(() => this.projectRows().length >= 2);

  /** All projects scored + sorted (NOT truncated). Source of truth for KPIs. */
  allProjectRows = computed<ProjectCommandRow[]>(() =>
    this.data().projects
      .map(project => {
        const financials = computeProjectFinancials(project.id, this.financeData());
        const openRisks = this.openProjectRisks(project.id).length;
        const openChanges = this.openProjectChanges(project.id).length;
        const health = this.projectHealth(financials.varianceAtCompletion, financials.burnPct, openRisks, openChanges);
        return {
          id: project.id,
          name: project.name,
          status: project.status,
          owner: this.resourceName(project.ownerId),
          health,
          revenue: financials.revenue,
          marginPct: financials.marginPct,
          eac: financials.eac,
          vac: financials.varianceAtCompletion,
          burnPct: financials.burnPct,
          openRisks,
          openChanges,
        };
      })
      .sort((a, b) => this.healthWeight(b.health) - this.healthWeight(a.health) || a.vac - b.vac),
  );

  /** Truncated for the control-board table only. */
  projectRows = computed<ProjectCommandRow[]>(() => this.allProjectRows().slice(0, 8));

  healthDistribution = computed(() => {
    const base = { green: 0, amber: 0, red: 0 };
    // Over the FULL portfolio, not the 8-row table slice.
    return this.allProjectRows().reduce((acc, p) => ({ ...acc, [p.health]: acc[p.health] + 1 }), base);
  });

  /**
   * THE portfolio margin, fully loaded (Q2, decided 2026-08-07 — spec §10): the
   * cost of non-billable work is IN it.
   *
   * The three sums this replaced were already fully loaded in EFFECT — an
   * unfiltered Σ over every project, and `computeProjectFinancials` is unchanged
   * by H (spec §11) — so the headline number does not move. That is exactly why
   * the change is worth making: the figure whose MEANING changed is the one
   * nobody will see change, and the label is the only thing that can close that
   * gap. Routing through the named rollup also makes this tile and /reporting's
   * answer the same question by construction; before H they did not (that page
   * summed only revenue-bearing projects, which silently dropped every
   * non-billable engagement).
   *
   * The universe also widens from `data().projects` to `attributableProjectIds`,
   * so an engagement carrying approved time but no project master row can no
   * longer drop its cost out of a total whose whole purpose is to carry it.
   */
  protected readonly portfolioMargin = computed<PortfolioMargin>(() =>
    portfolioMarginFullyLoaded(this.financeData()),
  );

  totalRevenue = computed(() => this.portfolioMargin().revenue);
  totalMargin = computed(() => this.portfolioMargin().fullyLoadedMargin);
  portfolioMarginPct = computed(() => this.portfolioMargin().fullyLoadedMarginPct);
  /** How many engagements contribute cost, and no customer revenue, to the figure. */
  protected readonly nonBillableCount = computed(() => this.portfolioMargin().nonBillableProjectIds.length);
  totalEac = computed(() =>
    this.data().projects.reduce((sum, p) => sum + computeProjectFinancials(p.id, this.financeData()).eac, 0),
  );
  totalVac = computed(() =>
    this.data().projects.reduce((sum, p) => sum + computeProjectFinancials(p.id, this.financeData()).varianceAtCompletion, 0),
  );

  /**
   * Portfolio Baseline vs Planned total (design spec, block E, §7) — a
   * portfolio total only, no per-project column (a dense table already).
   *
   * COORDINATOR-CAUGHT DEFECT (post-Task-8 review): both totals — and
   * therefore the ratio between them — must be restricted to periods that
   * actually carry a current baseline row (`!outOfBaselineHorizon`), never
   * summed over costBaselineComparison's full period union. That union also
   * includes every out-of-horizon month (booked hours, baseline 0, for
   * PROJECTS/PERIODS with no freeze at all) purely so the per-period table
   * can show them with a "not frozen" badge. Summing planned cost across
   * those never-frozen months into the numerator, while the denominator
   * only ever contains the few periods someone actually froze, compares two
   * different populations: with this seed that produced a numerator around
   * 235k EUR against a ~1,100 EUR denominator — a five-digit percentage
   * that is arithmetically derivable and completely meaningless. Restricting
   * BOTH sums to the same filtered set keeps the headline EUR figure and its
   * "% vs frozen PCP" subtitle describing the same thing.
   */
  protected readonly totalBaselineDelta = computed(() =>
    this.data().projects.reduce((sum, p) => sum + costBaselineComparison(this.financeData(), p.id).filter(r => !r.outOfBaselineHorizon).reduce((s, r) => s + r.delta, 0), 0),
  );
  protected readonly totalBaselineAmount = computed(() =>
    this.data().projects.reduce((sum, p) => sum + costBaselineComparison(this.financeData(), p.id).filter(r => !r.outOfBaselineHorizon).reduce((s, r) => s + r.baseline, 0), 0),
  );
  protected readonly totalBaselineDeltaPct = computed(() => {
    const baseline = this.totalBaselineAmount();
    return baseline !== 0 ? (this.totalBaselineDelta() / baseline) * 100 : null;
  });

  activeProjects = computed(() => this.data().projects.filter(p => p.status !== 'Completed').length);
  /** The same actionable-demand set Staffing lists and Reporting counts. */
  private workableDemand = computed(() => this.data().requests.filter(isWorkableUncoveredRequest));
  openRequests = computed(() => this.workableDemand().length);
  openChanges = computed(() => this.data().changeRequests.filter(c => c.status === 'Draft' || c.status === 'Submitted').length);
  criticalChanges = computed(() =>
    this.data().changeRequests.filter(c => (c.status === 'Draft' || c.status === 'Submitted') && (c.priority === 'High' || c.priority === 'Critical')).length,
  );
  criticalRisks = computed(() =>
    this.data().issues.filter(i => i.status !== 'Resolved' && (i.severity === 'Critical' || i.severity === 'High' || i.escalated)).length,
  );
  escalations = computed(() => this.data().issues.filter(i => i.status !== 'Resolved' && i.escalated).length);

  // --- "In Bench" tile (Block F, Task 9) --------------------------------------
  // Two SEPARATE counts, never summed (design spec decision 4): an idle
  // internal gets reallocated, an idle subcontractor does not get renewed and
  // their cost simply stops — the two actions have no common denominator, so
  // there is never an `internalBenchCount() + subcoBenchCount()` anywhere here.
  /**
   * The month the tile's two counts describe: TODAY's month, and only if the fetched
   * bench window contains it — the same rule (and the same clock helper)
   * bench.component.ts and utilization.component.ts now use.
   *
   * It used to be `months[0]`, which the server anchors on the OLDEST Open planning
   * period — four months in the past with the shipped seed — so this KPI was a
   * four-month-old snapshot presented as the present. `todayLocalIso()`, not
   * `new Date().toISOString()`: the UTC form names the wrong month around midnight on
   * the 1st (east of UTC) or the last of the month (west of it).
   */
  private readonly currentBenchMonth = computed(() => {
    const now = todayLocalIso().slice(0, 7);
    return this.data().benchRollup.months.includes(now) ? now : '';
  });

  /**
   * The month the tile is speaking about, or the explicit admission that the fetched
   * window has no present tense. A blank subtitle under two zeros would read as
   * "nobody is on the bench" — the opposite of "we are not looking at now".
   */
  readonly benchTileNote = computed<string>(() => {
    const months = this.data().benchRollup.months;
    if (months.length === 0) return '';
    const shown = this.currentBenchMonth();
    return shown
      ? DashboardComponent.BENCH_MONTH_FMT.format(new Date(shown + '-01T00:00:00Z'))
      : 'Current month not in window';
  });
  readonly internalBenchCount = computed(() =>
    this.data().benchRollup.internalRows.filter(r => r.monthly[this.currentBenchMonth()]?.state === 'BENCH').length,
  );
  readonly subcoBenchCount = computed(() =>
    this.data().benchRollup.subcoRows.filter(r => r.monthly[this.currentBenchMonth()]?.state === 'BENCH').length,
  );

  /**
   * H (spec §5.4 U7/U8) — the rows the two counts above stopped counting.
   *
   * Derived from the same `monthly[...]` cells rather than a new rollup field:
   * `EMPTY_BENCH_ROLLUP`'s own comment (bench.util.ts B9) rejects an added total
   * precisely because two numbers over the same rows can disagree, and this is
   * the consumer that would have asked for one. Kept SEPARATE by kind, matching
   * the tile's own grammar and decision 4's never-summed rule for the counts they
   * explain: an internal on parental leave and a subco off sick are different
   * facts with different consequences for the same reason bench is.
   */
  readonly internalAbsentCount = computed(() =>
    this.data().benchRollup.internalRows.filter(r => r.monthly[this.currentBenchMonth()]?.state === 'ABSENT').length,
  );
  readonly subcoAbsentCount = computed(() =>
    this.data().benchRollup.subcoRows.filter(r => r.monthly[this.currentBenchMonth()]?.state === 'ABSENT').length,
  );

  /**
   * C1: a dummy is a placeholder for a hole to be filled, not a real over-booked
   * body, and must never appear in this alert list — but a subco IS deliverable
   * capacity, just not internal, so an over-booked subco stays in (same
   * `countsTowardDeliveryCapacity` split `forecast.util`'s `overAllocated` uses).
   */
  overbookedResourcesList = computed(() =>
    this.data().resources
      .filter(r => countsTowardDeliveryCapacity(kindOf(r)) && r.utilization > 110)
      .sort((a, b) => b.utilization - a.utilization)
      .slice(0, 6),
  );
  overbookedResources = computed(() => this.overbookedResourcesList().length);

  riskQueue = computed(() =>
    this.data().issues
      .filter(i => i.status !== 'Resolved' && (i.severity === 'Critical' || i.severity === 'High' || i.escalated))
      .sort((a, b) => this.issueWeight(b) - this.issueWeight(a))
      .slice(0, 5),
  );

  changeQueue = computed(() =>
    this.data().changeRequests
      .filter(c => c.status === 'Draft' || c.status === 'Submitted')
      .sort((a, b) => this.changeWeight(b) - this.changeWeight(a) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5),
  );

  demandQueue = computed(() =>
    [...this.workableDemand()]
      .sort((a, b) => this.staffedPct(a) - this.staffedPct(b))
      .slice(0, 6),
  );

  // Portfolio delivery alerts: projects breaching margin / burn / EAC thresholds.
  // EAC-over-budget (real overrun) outranks burn, which outranks a thin margin.
  portfolioAlertRows = computed<PortfolioAlertRow[]>(() =>
    portfolioAlerts(this.financeData())
      .sort((a, b) => this.alertWeight(b.alerts) - this.alertWeight(a.alerts))
      .slice(0, 6),
  );

  onNewRequest(): void {
    this.router.navigateByUrl('/requests');
  }

  projectName(projectId?: string): string {
    if (!projectId) return 'No project';
    return this.data().projects.find(p => p.id === projectId)?.name ?? 'Unknown project';
  }

  healthLabel(health: DeliveryHealth): string {
    if (health === 'red') return 'Critical';
    if (health === 'amber') return 'Watch';
    return 'On Track';
  }

  meter(value: number, max: number): number {
    return Math.max(0, Math.min(100, (value / max) * 100));
  }

  /** AA-safe pill modifier for a real trend ('' = neutral/flat). Empty when not derivable. */
  trendChipClass(t: PeriodDelta): 'green' | 'red' | '' {
    if (t.direction === 'up') return 'green';
    if (t.direction === 'down') return 'red';
    return '';
  }

  /** Material icon for a real trend direction; '' when not derivable. */
  trendArrow(t: PeriodDelta): string {
    if (t.direction === 'up') return 'trending_up';
    if (t.direction === 'down') return 'trending_down';
    if (t.direction === 'flat') return 'trending_flat';
    return '';
  }

  /**
   * Signed, human-readable change for a derived trend: percentage when defined,
   * otherwise the absolute base-currency delta. Returns '' when not derivable.
   */
  trendLabel(t: PeriodDelta): string {
    if (t.direction === null) return '';
    const pct = t.deltaPct;
    if (pct !== null) {
      const sign = pct > 0 ? '+' : '';
      return `${sign}${pct.toFixed(1)}%`;
    }
    const delta = t.delta ?? 0;
    const sign = delta > 0 ? '+' : '';
    return `${sign}${Math.round(delta).toLocaleString()} ${this.baseCurrency}`;
  }

  staffedPct(req: ResourceRequest): number {
    return Math.max(0, Math.min(100, ((req.staffedEffort ?? 0) / Math.max(req.requiredEffort, 1)) * 100));
  }

  private openProjectRisks(projectId: string): Issue[] {
    return this.data().issues.filter(i => i.projectId === projectId && i.status !== 'Resolved' && (i.severity === 'High' || i.severity === 'Critical' || i.escalated));
  }

  private openProjectChanges(projectId: string): ChangeRequest[] {
    return this.data().changeRequests.filter(c => c.projectId === projectId && (c.status === 'Draft' || c.status === 'Submitted'));
  }

  private projectHealth(vac: number, burnPct: number, openRisks: number, openChanges: number): DeliveryHealth {
    if (vac < 0 || openRisks > 0) return 'red';
    if (burnPct > 85 || openChanges > 0) return 'amber';
    return 'green';
  }

  private healthWeight(health: DeliveryHealth): number {
    if (health === 'red') return 3;
    if (health === 'amber') return 2;
    return 1;
  }

  private issueWeight(issue: Issue): number {
    const severity = issue.severity === 'Critical' ? 4 : issue.severity === 'High' ? 3 : 1;
    return severity + (issue.escalated ? 2 : 0);
  }

  private changeWeight(change: ChangeRequest): number {
    if (change.priority === 'Critical') return 4;
    if (change.priority === 'High') return 3;
    if (change.priority === 'Medium') return 2;
    return 1;
  }

  private alertWeight(a: ProjectAlerts): number {
    return (a.eacOverBudget ? 4 : 0) + (a.burnOver ? 2 : 0) + (a.marginBelowTarget ? 1 : 0);
  }

  /** Red when EAC overruns the budget (real money), otherwise amber. */
  alertSeverity(a: ProjectAlerts): 'red' | 'amber' {
    return a.eacOverBudget ? 'red' : 'amber';
  }

  alertSeverityLabel(a: ProjectAlerts): string {
    return a.eacOverBudget ? 'At Risk' : 'Watch';
  }

  /** Compact flag chips (e.g. Margin / Burn / EAC) for the breaches that fired. */
  alertFlags(a: ProjectAlerts): string[] {
    const flags: string[] = [];
    if (a.marginBelowTarget) flags.push('Margin');
    if (a.burnOver) flags.push('Burn');
    if (a.eacOverBudget) flags.push('EAC');
    return flags;
  }

  private resourceName(resourceId?: string): string {
    if (!resourceId) return 'Unassigned owner';
    return this.data().resources.find(r => r.id === resourceId)?.name ?? 'Unknown owner';
  }
}
