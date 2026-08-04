import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { Router, RouterLink } from '@angular/router';
import { forkJoin, of } from 'rxjs';
import { AuthService } from '../services/auth.service';
import {
  ApiService,
  Assignment,
  BASE_CURRENCY,
  BillingPlanItem,
  ChangeRequest,
  Contract,
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
} from '../services/api.service';
import {
  computeProjectFinancials,
  FinanceData,
  PeriodDelta,
  PortfolioAlertRow,
  portfolioAlerts,
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
import { countsTowardDeliveryCapacity, kindOf } from '../services/resource-kind.util';

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
          <a routerLink="/reporting" class="command-button secondary">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">insights</mat-icon>
            Reporting
          </a>
          <button type="button" (click)="onNewRequest()" class="command-button">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon>
            New Request
          </button>
        </div>
      </header>

      @if (hasError()) {
        <!-- Whole-page fetch failure: never contradict the failure with zero KPIs. -->
        <app-list-state
          [error]="true"
          label="the command center"
          (retry)="reload()" />
      } @else if (isLoading()) {
        <!-- 11-endpoint load in flight: skeletons in place of fabricated zeros. -->
        <div class="space-y-6" aria-busy="true" aria-label="Loading delivery command center">
          <div class="command-eyebrow">Portfolio Financials</div>
          <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
            <div class="command-skeleton h-28 xl:col-span-2"></div>
            @for (tile of [1, 2, 3, 4]; track tile) {
              <div class="command-skeleton h-28"></div>
            }
          </section>
          <section class="grid grid-cols-1 lg:grid-cols-4 gap-4">
            @for (tile of [1, 2, 3, 4]; track tile) {
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

      <section class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
        <div class="command-kpi xl:col-span-2" [class.danger]="portfolioMarginPct() < 0" [class.warning]="portfolioMarginPct() >= 0 && portfolioMarginPct() < 15">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="command-kpi-label">Portfolio Margin</div>
              <div class="command-kpi-value">{{ portfolioMarginPct() | number:'1.0-1' }}%</div>
              <div class="command-kpi-note">{{ totalMargin() | currency:'EUR':'symbol':'1.0-0' }} on {{ totalRevenue() | currency:'EUR':'symbol':'1.0-0' }} revenue</div>
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
            <!-- Portfolio margin% as a radial gauge (capped at a 40% full ring). -->
            <command-donut-chart
              [value]="marginGaugeValue()"
              [max]="40"
              [size]="76"
              [thickness]="12"
              [tone]="marginGaugeTone()"
              [displayText]="(portfolioMarginPct() | number:'1.0-0') + '%'"
              ariaLabel="Portfolio margin gauge"
              caption="Portfolio margin percent of a 40 percent target ring" />
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

      <section class="grid grid-cols-1 lg:grid-cols-4 gap-4">
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
                      <div class="font-mono font-semibold" [style.color]="project.marginPct < 0 ? 'var(--cc-red)' : null">{{ project.marginPct | number:'1.0-1' }}%</div>
                      <div class="mt-1 command-meter"><span [style.width.%]="meter(project.marginPct, 40)"></span></div>
                    </td>
                    <td class="font-mono">{{ project.eac | currency:'EUR':'symbol':'1.0-0' }}</td>
                    <td class="font-mono font-semibold" [style.color]="project.vac < 0 ? 'var(--cc-red)' : 'var(--cc-green-text)'">{{ project.vac | currency:'EUR':'symbol':'1.0-0' }}</td>
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
              <a routerLink="/project-issues" class="command-status red" [class.green]="criticalRisks() === 0">Issues</a>
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
  };

  // FX rates feed FinanceData so portfolio rollups (margin, revenue, EAC, VAC)
  // are normalised to base currency; empty default => no-op conversion until loaded.
  // Keyed on auth readiness so it (re)runs together with the gated data load.
  private fxRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getFxRates() : of<FxRate[]>([])),
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
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
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
          })
        : of(DashboardComponent.EMPTY_DATA),
    defaultValue: DashboardComponent.EMPTY_DATA,
  });

  private data = this.dataRes.value;
  private fxRates = this.fxRes.value;
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
      // Normalise multi-currency amounts to base for portfolio money rollups.
      fxRates: this.fxRates(),
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

  /** Trailing 3 calendar months ending at the current month, as sorted YYYY-MM. */
  private readonly trendPeriods = ((): string[] => {
    const now = new Date();
    const out: string[] = [];
    for (let back = 2; back >= 0; back--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  })();

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

  /** Trailing 6 calendar months (sorted YYYY-MM) for the recognised-revenue chart. */
  private readonly chartPeriods = ((): string[] => {
    const now = new Date();
    const out: string[] = [];
    for (let back = 5; back >= 0; back--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return out;
  })();

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

  totalRevenue = computed(() =>
    this.data().projects.reduce((sum, p) => sum + computeProjectFinancials(p.id, this.financeData()).revenue, 0),
  );
  totalMargin = computed(() =>
    this.data().projects.reduce((sum, p) => sum + computeProjectFinancials(p.id, this.financeData()).margin, 0),
  );
  portfolioMarginPct = computed(() => this.totalRevenue() > 0 ? (this.totalMargin() / this.totalRevenue()) * 100 : 0);
  totalEac = computed(() =>
    this.data().projects.reduce((sum, p) => sum + computeProjectFinancials(p.id, this.financeData()).eac, 0),
  );
  totalVac = computed(() =>
    this.data().projects.reduce((sum, p) => sum + computeProjectFinancials(p.id, this.financeData()).varianceAtCompletion, 0),
  );

  activeProjects = computed(() => this.data().projects.filter(p => p.status !== 'Completed').length);
  openRequests = computed(() => this.data().requests.filter(r => r.status === 'Open').length);
  openChanges = computed(() => this.data().changeRequests.filter(c => c.status === 'Draft' || c.status === 'Submitted').length);
  criticalChanges = computed(() =>
    this.data().changeRequests.filter(c => (c.status === 'Draft' || c.status === 'Submitted') && (c.priority === 'High' || c.priority === 'Critical')).length,
  );
  criticalRisks = computed(() =>
    this.data().issues.filter(i => i.status !== 'Resolved' && (i.severity === 'Critical' || i.severity === 'High' || i.escalated)).length,
  );
  escalations = computed(() => this.data().issues.filter(i => i.status !== 'Resolved' && i.escalated).length);

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
    this.data().requests
      .filter(r => r.status === 'Open' && this.staffedPct(r) < 100)
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
