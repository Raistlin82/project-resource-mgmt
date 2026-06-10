import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import {
  ApiService,
  Assignment,
  BASE_CURRENCY,
  BillingPlanItem,
  ChangeRequest,
  FinancialItem,
  FxRate,
  Issue,
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
  recognizedRevenueTrend,
} from '../services/finance.util';

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
  imports: [MatIconModule, CurrencyPipe, DecimalPipe, RouterLink],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Portfolio Delivery Control</div>
          <h1 class="command-title">Delivery Command Center</h1>
          <p class="command-subtitle">
            Vista unica per presidiare margine, EAC, rischi, change control, domanda risorse e saturazione del team.
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

      <div class="flex items-center justify-between gap-3">
        <div class="command-eyebrow">Portfolio Financials</div>
        <span class="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
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
            <mat-icon class="text-[28px] text-[var(--cc-primary)]">stacked_line_chart</mat-icon>
          </div>
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
            <div class="rounded-md ring-1 ring-emerald-200 bg-emerald-50 py-2">
              <div class="font-mono text-lg font-semibold text-emerald-700">{{ healthDistribution().green }}</div>
              <div class="text-[10px] font-bold uppercase text-emerald-700">Green</div>
            </div>
            <div class="rounded-md ring-1 ring-amber-200 bg-amber-50 py-2">
              <div class="font-mono text-lg font-semibold text-amber-700">{{ healthDistribution().amber }}</div>
              <div class="text-[10px] font-bold uppercase text-amber-700">Amber</div>
            </div>
            <div class="rounded-md ring-1 ring-red-200 bg-red-50 py-2">
              <div class="font-mono text-lg font-semibold text-red-700">{{ healthDistribution().red }}</div>
              <div class="text-[10px] font-bold uppercase text-red-700">Red</div>
            </div>
          </div>
        </div>
      </section>

      <section class="command-card overflow-hidden">
        <div class="command-card-header">
          <div>
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Delivery Alerts</h2>
            <p class="mt-1 text-sm text-[var(--cc-muted)]">Progetti che sforano soglie di margine, burn o EAC (budget CR-adjusted).</p>
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
                  <a [routerLink]="['/projects', row.projectId]" class="font-bold text-blue-700 hover:underline">
                    {{ row.name || projectName(row.projectId) }}
                  </a>
                  <div class="mt-2 flex flex-wrap items-center gap-1.5">
                    @for (flag of alertFlags(row.alerts); track flag) {
                      <span class="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-700 ring-1 ring-amber-200">{{ flag }}</span>
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

      <div class="grid grid-cols-1 xl:grid-cols-[1.45fr_.85fr] gap-5">
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Portfolio Control Board</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Progetti ordinati per attenzione richiesta.</p>
            </div>
            <a routerLink="/projects" class="command-status">Open Project 360</a>
          </div>
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
                    <td class="font-mono font-semibold" [style.color]="project.vac < 0 ? 'var(--cc-red)' : 'var(--cc-green)'">{{ project.vac | currency:'EUR':'symbol':'1.0-0' }}</td>
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
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Issue aperte con severità alta, critica o escalation.</p>
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
                <p class="mt-1 text-sm text-[var(--cc-muted)]">Impatto budget e schedule in attesa decisione.</p>
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
                      <div class="font-mono font-semibold">{{ change.impactScheduleDays }}d</div>
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

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Demand Queue</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Richieste aperte con gap di staffing residuo.</p>
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
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Risorse oltre soglia di controllo.</p>
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
    </div>
  `,
})
export class DashboardComponent {
  private api = inject(ApiService);
  private router = inject(Router);

  /** Reporting/base currency for portfolio money KPIs (see EUR caption). */
  protected readonly baseCurrency = BASE_CURRENCY;

  // FX rates feed FinanceData so portfolio rollups (margin, revenue, EAC, VAC)
  // are normalised to base currency; empty default => no-op conversion until loaded.
  private fxRes = rxResource<FxRate[], unknown>({
    stream: () => this.api.getFxRates(),
    defaultValue: [],
  });

  private dataRes = rxResource<DashboardData, unknown>({
    stream: () => forkJoin({
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
    }),
    defaultValue: {
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
    },
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
      // Normalise multi-currency amounts to base for portfolio money rollups.
      fxRates: this.fxRates(),
    };
  });

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

  projectRows = computed<ProjectCommandRow[]>(() =>
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
      .sort((a, b) => this.healthWeight(b.health) - this.healthWeight(a.health) || a.vac - b.vac)
      .slice(0, 8),
  );

  healthDistribution = computed(() => {
    const base = { green: 0, amber: 0, red: 0 };
    return this.projectRows().reduce((acc, p) => ({ ...acc, [p.health]: acc[p.health] + 1 }), base);
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

  overbookedResourcesList = computed(() =>
    this.data().resources.filter(r => r.utilization > 110).sort((a, b) => b.utilization - a.utilization).slice(0, 6),
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
