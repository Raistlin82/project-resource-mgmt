import { ChangeDetectionStrategy, Component, inject, signal, computed, PLATFORM_ID } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { isPlatformBrowser, CurrencyPipe, DecimalPipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { rxResource } from '@angular/core/rxjs-interop';
import { ApiService, Resource, ResourceRequest, Assignment, Project, Order, OrderLine, FinancialItem, TimeEntry, Issue, ChangeRequest, Milestone, BillingPlanItem, Contract, Customer, FxRate, BASE_CURRENCY } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { computeProjectFinancials, FinanceData, arAging, arAgingByCustomer, dsoOutstanding, AR_AGING_BUCKETS, ArAgingBucket, ArAgingBucketTotal, ArAgingCustomerRow, marginDrivers, portfolioAlerts, DEFAULT_ALERT_THRESHOLDS, PortfolioAlertRow, realizationMetrics, customerProfitability, customerConcentration, marginCompressionAlerts, DEFAULT_MARGIN_COMPRESSION_CONFIG, recognizedRevenueTrend, periodDelta, PeriodDelta, CustomerConcentration, MarginCompressionAlert, AlertSeverity } from '../services/finance.util';
import { NotificationService } from '../services/notification.service';
import { toCsv, downloadCsv } from '../services/export.util';

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
}

interface ArAgingBarRow extends ArAgingBucketTotal {
  bucket: ArAgingBucket;
}

@Component({
  selector: 'app-reporting',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DecimalPipe],
  template: `
    <div class="command-page space-y-6">
      <div class="command-header">
        <div>
          <div class="command-eyebrow">Executive Reporting</div>
          <h1 class="command-title">Portfolio Analytics</h1>
          <p class="command-subtitle">Cross-functional control view across resource demand, utilization, project finance, risks, milestones and change control.</p>
        </div>
        <div class="flex flex-col sm:flex-row items-center gap-3 w-full sm:w-auto">
          <select [value]="period()" (change)="onPeriodChange($event)" class="w-full sm:w-auto rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
            <option value="30d">Last 30 Days</option>
            <option value="quarter">This Quarter</option>
            <option value="year">This Year</option>
          </select>
          <button (click)="exportReport()" class="command-button w-full sm:w-auto">
            <mat-icon class="text-[20px] w-[20px] h-[20px]">download</mat-icon> Export Report
          </button>
        </div>
      </div>

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
                <span class="command-status inline-flex items-center gap-0.5"
                      [class]="dir === 'up' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : dir === 'down' ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'"
                      [attr.aria-label]="trendAriaLabel(kpi.trend)">
                  <mat-icon class="text-[14px] w-[14px] h-[14px]">{{ dir === 'up' ? 'trending_up' : dir === 'down' ? 'trending_down' : 'trending_flat' }}</mat-icon>
                  {{ kpi.trend?.deltaPct !== null ? (kpi.trend!.deltaPct! > 0 ? '+' : '') + (kpi.trend!.deltaPct! | number:'1.0-0') + '%' : '—' }}
                </span>
              }
            </div>
            <h3 class="command-kpi-label">{{ kpi.label }}</h3>
            <p class="command-kpi-value">{{ kpi.value }}</p>
          </div>
        }
      </div>

      <!-- Portfolio financials (real, from commercial + finance data) -->
      <div class="command-section-label flex items-center justify-between">
        <span>Portfolio Financials</span>
        <span class="text-xs font-semibold text-slate-500 normal-case tracking-normal">{{ baseCurrency }} (base)</span>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div class="command-kpi">
          <p class="command-kpi-label">Portfolio Revenue</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ totalRevenue() | currency:'EUR':'symbol':'1.0-0' }}</p>
        </div>
        <div class="command-kpi" [class.danger]="totalMargin() < 0">
          <p class="command-kpi-label">Total Margin</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-emerald-700]="totalMargin() >= 0" [class.text-red-700]="totalMargin() < 0">{{ totalMargin() | currency:'EUR':'symbol':'1.0-0' }}</p>
        </div>
        <div class="command-kpi" [class.warning]="portfolioMarginPct() >= 0 && portfolioMarginPct() < 15" [class.danger]="portfolioMarginPct() < 0">
          <p class="command-kpi-label">Margin %</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-emerald-700]="portfolioMarginPct() >= 0" [class.text-red-700]="portfolioMarginPct() < 0">{{ portfolioMarginPct() | number:'1.0-1' }}%</p>
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
          <p class="command-kpi-value font-mono tabular-nums" [class.text-emerald-700]="totalVac() >= 0" [class.text-red-700]="totalVac() < 0">{{ totalVac() | currency:'EUR':'symbol':'1.0-0' }}</p>
        </div>
        <div class="command-kpi warning">
          <p class="command-kpi-label">Open Changes</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ openChanges() }}</p>
        </div>
        <div class="command-kpi" [class.danger]="highRiskIssues() > 0">
          <p class="command-kpi-label">High Risk Issues</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-red-700]="highRiskIssues() > 0">{{ highRiskIssues() }}</p>
        </div>
      </div>

      <!-- Realization & revenue-per-FTE strip (real, recognised revenue vs rate-card) -->
      <div class="command-section-label flex items-center justify-between">
        <span>Realization &amp; Productivity</span>
        <span class="text-xs font-semibold text-slate-500 normal-case tracking-normal">Recognised revenue vs rate-card &middot; {{ baseCurrency }} (base)</span>
      </div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        <div class="command-kpi" [class.warning]="realization().realizationPct > 0 && realization().realizationPct < 85">
          <div class="flex items-center justify-between mb-1">
            <p class="command-kpi-label">Realization</p>
            <!-- Real recognised-revenue trend; hidden when no prior window is derivable (#15). -->
            @if (recognizedTrend().direction; as dir) {
              <span class="command-status inline-flex items-center gap-0.5"
                    [class]="dir === 'up' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : dir === 'down' ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'"
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

      <!-- Charts Area -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Resource Utilization Trend -->
        <div class="command-card p-6 sm:p-8">
          <div class="flex items-center justify-between mb-8">
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Current Resource Utilization</h3>
          </div>
          <div class="h-64 flex items-end gap-2 sm:gap-4">
            @for (bar of utilizationData(); track bar.month) {
              <div class="flex-1 flex flex-col items-center gap-3 group relative h-full justify-end">
                <!-- Tooltip -->
                <div class="absolute -top-12 bg-white ring-1 ring-slate-900/5 border border-slate-200 text-blue-700 font-mono tabular-nums text-xs font-bold py-1.5 px-3 rounded-lg opacity-0 group-hover:opacity-100 transition-all transform group-hover:-translate-y-1 pointer-events-none whitespace-nowrap z-10 shadow-md">
                  {{ bar.value }}%
                  <div class="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white border-b border-r border-slate-200 rotate-45"></div>
                </div>
                <div class="w-full bg-slate-100 rounded-t-xl relative flex-1 flex items-end overflow-hidden group-hover:bg-slate-200 transition-colors">
                  <div class="w-full bg-gradient-to-t from-blue-500 to-blue-600 rounded-t-xl transition-all duration-700 ease-out group-hover:opacity-90" [style.height.%]="bar.value"></div>
                </div>
                <span class="text-xs text-slate-500 font-semibold uppercase tracking-wider">{{ bar.month }}</span>
              </div>
            }
          </div>
        </div>

        <!-- Project Margin (real) -->
        <div class="command-card p-6 sm:p-8">
          <div class="flex items-center justify-between mb-8">
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Project Margin</h3>
          </div>
          <div class="space-y-6">
            @for (p of marginBars(); track p.name) {
              <div class="group">
                <div class="flex justify-between items-end mb-2">
                  <span class="font-bold text-slate-700 group-hover:text-slate-900 transition-colors">{{ p.name }}</span>
                  <span class="text-sm font-bold tracking-wide font-mono tabular-nums" [class.text-emerald-700]="p.margin >= 0" [class.text-red-700]="p.margin < 0">
                    {{ p.margin | currency:'EUR':'symbol':'1.0-0' }} · {{ p.marginPct | number:'1.0-0' }}%
                  </span>
                </div>
                <div class="w-full bg-slate-100 rounded-full h-3 overflow-hidden shadow-inner">
                  <div class="h-full rounded-full transition-all duration-1000 ease-out"
                       [class.bg-emerald-500]="p.margin >= 0" [class.bg-red-500]="p.margin < 0"
                       [style.width.%]="p.width"></div>
                </div>
              </div>
            } @empty {
              <p class="text-slate-500 text-sm">No projects with customer revenue yet. Add Customer orders in Commercial → Orders.</p>
            }
          </div>
        </div>
      </div>

      <!-- Detailed Reports Table -->
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <h3 class="text-xl font-bold text-slate-900 tracking-tight">Available Reports</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Report Name</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Category</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Last Generated</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (report of reports(); track report.name) {
                <tr class="hover:bg-slate-50 transition-colors group">
                  <td class="px-6 sm:px-8 py-5 font-bold text-slate-900 flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-blue-50 ring-1 ring-blue-200 flex items-center justify-center text-blue-700">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">description</mat-icon>
                    </div>
                    {{ report.name }}
                  </td>
                  <td class="px-6 sm:px-8 py-5">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide ring-1"
                          [class.bg-blue-50]="report.category === 'Resource Management'" [class.text-blue-700]="report.category === 'Resource Management'" [class.ring-blue-200]="report.category === 'Resource Management'"
                          [class.bg-emerald-50]="report.category === 'Project Management'" [class.text-emerald-700]="report.category === 'Project Management'" [class.ring-emerald-200]="report.category === 'Project Management'"
                          [class.bg-blue-50]="report.category === 'Cross-Functional'" [class.text-blue-700]="report.category === 'Cross-Functional'" [class.ring-blue-200]="report.category === 'Cross-Functional'">
                      {{ report.category }}
                    </span>
                  </td>
                  <td class="px-6 sm:px-8 py-5 text-slate-600 font-medium">{{ report.lastGenerated }}</td>
                  <td class="px-6 sm:px-8 py-5 text-right">
                    <button (click)="exportReport()" class="text-blue-700 hover:text-blue-800 font-semibold text-sm transition-colors opacity-0 group-hover:opacity-100 focus-within:opacity-100 flex items-center justify-end gap-1 ml-auto">
                      Export <mat-icon class="text-[16px] w-[16px] h-[16px]">download</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      <!-- Margin & Variance -->
      <div class="command-section-label">Margin &amp; Variance</div>

      <!-- Per-project drill-down with stacked cost-driver mini-bar -->
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50">
          <h3 class="text-xl font-bold text-slate-900 tracking-tight">Project Margin &amp; Variance</h3>
          <div class="flex items-center gap-4">
            <div class="hidden sm:flex items-center gap-4 text-xs font-semibold text-slate-500">
              <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-blue-600"></span>Labor</span>
              <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-amber-500"></span>External</span>
              <span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm bg-slate-400"></span>Expense</span>
            </div>
            <button type="button" (click)="exportMarginVarianceCsv()" [disabled]="marginRows().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
            </button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
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
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (r of marginRows(); track r.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 sm:px-8 py-5 min-w-[180px]">
                    <div class="font-bold text-slate-900">{{ r.name }}</div>
                    <!-- Stacked cost-driver mini-bar -->
                    <div class="mt-2 flex w-full h-2 rounded-full overflow-hidden bg-slate-100 shadow-inner"
                         role="img"
                         [attr.aria-label]="'Cost drivers — labor ' + (r.laborCost | currency:'EUR':'symbol':'1.0-0') + ', external ' + (r.externalCost | currency:'EUR':'symbol':'1.0-0') + ', expense ' + (r.expenseCost | currency:'EUR':'symbol':'1.0-0')">
                      <div class="h-full bg-blue-600" [style.width.%]="r.laborW"></div>
                      <div class="h-full bg-amber-500" [style.width.%]="r.externalW"></div>
                      <div class="h-full bg-slate-400" [style.width.%]="r.expenseW"></div>
                    </div>
                  </td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-700">{{ r.revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-600">{{ r.laborCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-600">{{ r.externalCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-600">{{ r.expenseCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums font-bold" [class.text-emerald-700]="r.margin >= 0" [class.text-red-700]="r.margin < 0">{{ r.margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-emerald-700]="r.marginPct >= 0" [class.text-red-700]="r.marginPct < 0">{{ r.marginPct | number:'1.0-1' }}%</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-700">{{ r.eac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-emerald-700]="r.vac >= 0" [class.text-red-700]="r.vac < 0">{{ r.vac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-red-700]="r.burnPct >= alertThresholds.burnWarnPct" [class.text-slate-700]="r.burnPct < alertThresholds.burnWarnPct">{{ r.burnPct | number:'1.0-0' }}%</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="10" class="px-6 sm:px-8 py-8 text-center text-slate-500 text-sm">No projects with revenue or cost yet.</td>
                </tr>
              }
            </tbody>
            @if (marginRows().length > 0) {
              <tfoot class="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                <tr>
                  <td class="px-6 sm:px-8 py-4">Portfolio <span class="ml-1 text-xs font-semibold text-slate-500 normal-case tracking-normal">{{ baseCurrency }} (base)</span></td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().laborCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().externalCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().expenseCost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-emerald-700]="marginTotals().margin >= 0" [class.text-red-700]="marginTotals().margin < 0">{{ marginTotals().margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4"></td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ marginTotals().eac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-emerald-700]="marginTotals().vac >= 0" [class.text-red-700]="marginTotals().vac < 0">{{ marginTotals().vac | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4"></td>
                </tr>
              </tfoot>
            }
          </table>
        </div>
      </div>

      <!-- Threshold-breach alerts -->
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-50">
          <h3 class="text-xl font-bold text-slate-900 tracking-tight">Portfolio Alerts</h3>
          <span class="text-xs font-semibold text-slate-500">Margin &le; {{ alertThresholds.marginTargetPct }}% &middot; Burn &ge; {{ alertThresholds.burnWarnPct }}% &middot; EAC &gt; budget</span>
        </div>
        <ul class="divide-y divide-slate-100">
          @for (row of alertRows(); track row.projectId) {
            <li class="px-6 sm:px-8 py-5 flex flex-col sm:flex-row sm:items-start gap-3 hover:bg-slate-50 transition-colors">
              <span class="command-status shrink-0"
                    [class]="alertSeverity(row) === 'critical' ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'">
                {{ alertSeverity(row) === 'critical' ? 'Critical' : 'Warning' }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="font-bold text-slate-900">{{ row.name ?? row.projectId }}</div>
                <ul class="mt-1.5 space-y-1">
                  @for (reason of row.alerts.items; track reason) {
                    <li class="flex items-start gap-2 text-sm text-slate-600">
                      <mat-icon class="text-[16px] w-[16px] h-[16px] mt-0.5 shrink-0"
                                [class.text-red-700]="alertSeverity(row) === 'critical'" [class.text-amber-700]="alertSeverity(row) === 'warning'">error_outline</mat-icon>
                      <span class="font-mono tabular-nums">{{ reason }}</span>
                    </li>
                  }
                </ul>
              </div>
            </li>
          } @empty {
            <li class="px-6 sm:px-8 py-8 flex items-center justify-center gap-2 text-sm text-emerald-700 font-semibold">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">check_circle</mat-icon>
              No projects breaching margin, burn or EAC thresholds.
            </li>
          }
        </ul>
      </div>

      <!-- Margin-Compression alerts (project + customer, severity-graded) -->
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50">
          <div>
            <h3 class="text-xl font-bold text-slate-900 tracking-tight">Margin-Compression Alerts</h3>
            <span class="text-xs font-semibold text-slate-500">Margin &le; {{ marginCompressionThresholds.marginTargetPct }}% or thin bill-vs-cost spread &middot; project &amp; customer</span>
          </div>
          <button type="button" (click)="exportMarginCompressionCsv()" [disabled]="compressionAlerts().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
          </button>
        </div>
        <ul class="divide-y divide-slate-100">
          @for (a of compressionAlerts(); track a.scope + ':' + a.id) {
            <li class="px-6 sm:px-8 py-5 flex flex-col sm:flex-row sm:items-start gap-3 hover:bg-slate-50 transition-colors">
              <span class="command-status shrink-0" [class]="severityBadgeClass(a.severity)">
                {{ severityLabel(a.severity) }}
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-bold text-slate-900">{{ a.name ?? a.id }}</span>
                  <span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wide ring-1"
                        [class.bg-blue-50]="a.scope === 'project'" [class.text-blue-700]="a.scope === 'project'" [class.ring-blue-200]="a.scope === 'project'"
                        [class.bg-violet-50]="a.scope === 'customer'" [class.text-violet-700]="a.scope === 'customer'" [class.ring-violet-200]="a.scope === 'customer'">
                    {{ a.scope }}
                  </span>
                  <span class="text-xs font-semibold text-slate-500 font-mono tabular-nums">{{ a.marginPct | number:'1.0-1' }}% margin &middot; {{ a.gapPts | number:'1.0-1' }}pt gap</span>
                </div>
                <ul class="mt-1.5 space-y-1">
                  @for (reason of a.reasons; track reason) {
                    <li class="flex items-start gap-2 text-sm text-slate-600">
                      <mat-icon class="text-[16px] w-[16px] h-[16px] mt-0.5 shrink-0"
                                [class.text-red-700]="a.severity === 'high'" [class.text-amber-700]="a.severity === 'medium'" [class.text-slate-500]="a.severity === 'low'">error_outline</mat-icon>
                      <span class="font-mono tabular-nums">{{ reason }}</span>
                    </li>
                  }
                </ul>
              </div>
              <div class="shrink-0 text-right font-mono tabular-nums text-sm text-slate-700">
                {{ a.revenue | currency:'EUR':'symbol':'1.0-0' }}
                <div class="text-xs text-slate-500">revenue</div>
              </div>
            </li>
          } @empty {
            <li class="px-6 sm:px-8 py-8 flex items-center justify-center gap-2 text-sm text-emerald-700 font-semibold">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">check_circle</mat-icon>
              No projects or customers showing margin compression.
            </li>
          }
        </ul>
      </div>

      <!-- Customer Profitability & Concentration ------------------------------- -->
      <div class="command-section-label">Customer Profitability &amp; Concentration</div>

      <!-- Concentration KPI cards (single-customer dependency risk) -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
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

      <!-- Top customers by margin -->
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50">
          <h3 class="text-xl font-bold text-slate-900 tracking-tight">Top Customers by Margin <span class="ml-1 text-xs font-semibold text-slate-500 normal-case tracking-normal">{{ baseCurrency }} (base)</span></h3>
          <button type="button" (click)="exportCustomerProfitabilityCsv()" [disabled]="customerRows().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
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
            <tbody class="divide-y divide-slate-100">
              @for (c of customerRows(); track c.customerId) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 sm:px-8 py-5 font-bold text-slate-900 min-w-[160px]">{{ c.customerName }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-700">{{ c.revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-600">{{ c.cost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums font-bold" [class.text-emerald-700]="c.margin >= 0" [class.text-red-700]="c.margin < 0">{{ c.margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums" [class.text-emerald-700]="c.marginPct >= 0" [class.text-red-700]="c.marginPct < 0">{{ c.marginPct | number:'1.0-1' }}%</td>
                  <td class="px-4 py-5 text-right">
                    <div class="flex items-center justify-end gap-2">
                      <span class="font-mono tabular-nums text-slate-700">{{ c.sharePct | number:'1.0-1' }}%</span>
                      <span class="hidden sm:block w-16 bg-slate-100 rounded-full h-2 overflow-hidden shadow-inner">
                        <span class="block h-full bg-blue-600 rounded-full" [style.width.%]="c.shareW"></span>
                      </span>
                    </div>
                  </td>
                  <td class="px-4 py-5 text-right font-mono tabular-nums text-slate-500">{{ c.projectIds.length }}</td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="7" class="px-6 sm:px-8 py-8 text-center text-slate-500 text-sm">No customer revenue yet. Link projects to contracts and add Customer orders.</td>
                </tr>
              }
            </tbody>
            @if (customerRows().length > 0) {
              <tfoot class="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-900">
                <tr>
                  <td class="px-6 sm:px-8 py-4">Total <span class="ml-1 text-xs font-semibold text-slate-500 normal-case tracking-normal">{{ baseCurrency }} (base)</span></td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ customerTotals().revenue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">{{ customerTotals().cost | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-emerald-700]="customerTotals().margin >= 0" [class.text-red-700]="customerTotals().margin < 0">{{ customerTotals().margin | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums" [class.text-emerald-700]="customerTotals().marginPct >= 0" [class.text-red-700]="customerTotals().marginPct < 0">{{ customerTotals().marginPct | number:'1.0-1' }}%</td>
                  <td class="px-4 py-4 text-right font-mono tabular-nums">100%</td>
                  <td class="px-4 py-4"></td>
                </tr>
              </tfoot>
            }
          </table>
        </div>
      </div>

      <!-- Accounts Receivable (A/R aging) -->
      <div class="command-section-label">Accounts Receivable</div>

      <!-- A/R KPI cards -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6">
        <div class="command-kpi">
          <p class="command-kpi-label">Total Outstanding</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ arTotalOutstanding() | currency:'EUR':'symbol':'1.0-0' }}</p>
          <p class="command-note">Invoiced, not yet collected</p>
        </div>
        <div class="command-kpi" [class.danger]="arOverdue() > 0">
          <p class="command-kpi-label">Overdue</p>
          <p class="command-kpi-value font-mono tabular-nums" [class.text-red-700]="arOverdue() > 0">{{ arOverdue() | currency:'EUR':'symbol':'1.0-0' }}</p>
          <p class="command-note">Past due date</p>
        </div>
        <div class="command-kpi info">
          <p class="command-kpi-label">DSO</p>
          <p class="command-kpi-value font-mono tabular-nums">{{ arDso() | number:'1.0-0' }} <span class="text-base font-semibold text-slate-500">days</span></p>
          <p class="command-note">Amount-weighted age of A/R</p>
        </div>
      </div>

      <!-- Aging bar (0-30 / 31-60 / 61-90 / 90+) -->
      <div class="command-card p-6 sm:p-8">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8">
          <h3 class="text-xl font-bold text-slate-900 tracking-tight">A/R Aging</h3>
          <div class="flex items-center gap-4">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">Days overdue &middot; {{ baseCurrency }} (base)</span>
            <button type="button" (click)="exportArAgingCsv()" class="command-button secondary">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
            </button>
          </div>
        </div>
        <div class="space-y-6">
          @for (b of arBucketBars(); track b.bucket) {
            <div class="group">
              <div class="flex justify-between items-end mb-2">
                <span class="font-bold tracking-wide" [class.text-red-700]="b.bucket === '90+'" [class.text-slate-700]="b.bucket !== '90+'">
                  {{ b.bucket }} days
                  <span class="ml-2 text-xs font-semibold text-slate-500 tabular-nums">{{ b.count }} {{ b.count === 1 ? 'invoice' : 'invoices' }}</span>
                </span>
                <span class="text-sm font-bold tracking-wide font-mono tabular-nums" [class.text-red-700]="b.bucket === '90+'" [class.text-slate-700]="b.bucket !== '90+'">
                  {{ b.amount | currency:'EUR':'symbol':'1.0-0' }}
                </span>
              </div>
              <div class="w-full bg-slate-100 rounded-full h-3 overflow-hidden shadow-inner">
                <div class="h-full rounded-full transition-all duration-1000 ease-out"
                     [class.bg-red-500]="b.bucket === '90+'" [class.bg-blue-600]="b.bucket !== '90+'"
                     [style.width.%]="b.width"></div>
              </div>
            </div>
          }
        </div>
      </div>

      <!-- Per-customer A/R table -->
      <div class="command-card overflow-hidden">
        <div class="p-6 sm:p-8 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50">
          <h3 class="text-xl font-bold text-slate-900 tracking-tight">A/R by Customer <span class="ml-1 text-xs font-semibold text-slate-500 normal-case">{{ baseCurrency }} (base)</span></h3>
          <button type="button" (click)="exportArByCustomerCsv()" [disabled]="arByCustomer().length === 0" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon> Export CSV
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Customer</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs text-right">Outstanding</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs text-right">Overdue</th>
                <th class="px-6 sm:px-8 py-4 font-semibold uppercase tracking-wider text-xs">Oldest Bucket</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (row of arByCustomer(); track row.customerId) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 sm:px-8 py-5 font-bold text-slate-900">{{ row.customerName }}</td>
                  <td class="px-6 sm:px-8 py-5 text-right font-mono tabular-nums text-slate-700">{{ row.totalOutstanding | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-6 sm:px-8 py-5 text-right font-mono tabular-nums" [class.text-red-700]="row.overdue > 0" [class.text-slate-700]="row.overdue === 0">{{ row.overdue | currency:'EUR':'symbol':'1.0-0' }}</td>
                  <td class="px-6 sm:px-8 py-5">
                    <span class="command-status"
                          [class]="row.oldestBucket === '90+' ? 'bg-red-50 text-red-700 ring-1 ring-red-200' : 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'">
                      {{ row.oldestBucket === '—' ? '—' : row.oldestBucket + ' days' }}
                    </span>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="4" class="px-6 sm:px-8 py-8 text-center text-slate-500 text-sm">No outstanding receivables.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
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

  // This forkJoin pulls several principal-gated collections (resources, orders,
  // order-lines, project-financials, time-entries, billing-plan-items, contracts,
  // customers) that 401 until the OIDC token is restored. On reload the token
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
          })
        : of<ReportingData>({ resources: [], assignments: [], requests: [], projects: [], orders: [], orderLines: [], financials: [], timeEntries: [], issues: [], changeRequests: [], milestones: [], billingItems: [], contracts: [], customers: [] }),
    defaultValue: { resources: [], assignments: [], requests: [], projects: [], orders: [], orderLines: [], financials: [], timeEntries: [], issues: [], changeRequests: [], milestones: [], billingItems: [], contracts: [], customers: [] },
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

  private financeData = computed<FinanceData>(() => {
    const d = this.dataRes.value();
    return { requests: d.requests, assignments: d.assignments, resources: d.resources, orders: d.orders, orderLines: d.orderLines, financials: d.financials, timeEntries: d.timeEntries, changeRequests: d.changeRequests, projects: d.projects, fxRates: this.fxRes.value() };
  });

  /** Real per-project profitability (revenue/margin) from the commercial + finance data. */
  projectMargins = computed(() =>
    this.dataRes.value().projects
      .map(p => {
        const f = computeProjectFinancials(p.id, this.financeData());
        return { name: p.name, revenue: f.revenue, margin: f.margin, marginPct: f.marginPct };
      })
      .filter(p => p.revenue > 0),
  );

  totalRevenue = computed(() => this.projectMargins().reduce((s, p) => s + p.revenue, 0));
  totalMargin = computed(() => this.projectMargins().reduce((s, p) => s + p.margin, 0));
  portfolioMarginPct = computed(() => this.totalRevenue() > 0 ? (this.totalMargin() / this.totalRevenue()) * 100 : 0);
  totalBacklog = computed(() =>
    this.dataRes.value().projects.reduce((s, p) => s + computeProjectFinancials(p.id, this.financeData()).backlog, 0),
  );
  totalEac = computed(() =>
    this.dataRes.value().projects.reduce((s, p) => s + computeProjectFinancials(p.id, this.financeData()).eac, 0),
  );
  totalVac = computed(() =>
    this.dataRes.value().projects.reduce((s, p) => s + computeProjectFinancials(p.id, this.financeData()).varianceAtCompletion, 0),
  );
  openChanges = computed(() =>
    this.dataRes.value().changeRequests.filter(c => c.status === 'Draft' || c.status === 'Submitted').length,
  );
  highRiskIssues = computed(() =>
    this.dataRes.value().issues.filter(i => i.status !== 'Closed' && (i.severity === 'High' || i.severity === 'Critical' || i.escalated)).length,
  );
  pendingMilestones = computed(() => this.dataRes.value().milestones.filter(m => m.status === 'Pending').length);
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
    return this.dataRes.value().projects
      .map(p => {
        const md = marginDrivers(p.id, d);
        const f = computeProjectFinancials(p.id, d);
        const totalCost = md.laborCost + md.externalCost + md.expenseCost;
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
  private readonly today = new Date().toISOString().slice(0, 10);

  private arResult = computed(() => arAging(this.dataRes.value().billingItems, this.today, this.fxRes.value()));
  arTotalOutstanding = computed(() => this.arResult().totalOutstanding);
  arOverdue = computed(() => this.arResult().overdue);
  arDso = computed(() => dsoOutstanding(this.dataRes.value().billingItems, this.today, this.fxRes.value()));

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
    const d = this.dataRes.value();
    return arAgingByCustomer(d.billingItems, d.contracts, d.customers, this.today, this.fxRes.value())
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
    this.dataRes.value().projects.filter(p => ['in execution', 'in planning', 'active'].includes((p.status ?? '').toLowerCase())).length
  );

  private openRequestsCount = computed(() =>
    this.dataRes.value().requests.filter(r => ['open', 'published'].includes((r.status ?? '').toLowerCase())).length
  );

  private avgUtilization = computed(() => {
    const resources = this.dataRes.value().resources;
    if (!resources.length) return 0;
    const total = resources.reduce((sum, r) => sum + (r.utilization ?? 0), 0);
    return total / resources.length;
  });

  // --- Realization & productivity (portfolio roll-up of realizationMetrics) ----
  /**
   * Portfolio realization & revenue-per-FTE. realizationMetrics is per-project, so
   * we sum its additive parts (recognised revenue, approved hours, rate-card value,
   * headcount, FTE) across every project and re-derive the ratios on the totals.
   * headcount is de-duplicated across projects so a resource on several projects
   * counts once. Pass-through of the hoursPerFte basis keeps FTE comparable.
   */
  realization = computed(() => {
    const d = this.financeData();
    const heads = new Set<string>();
    let revenue = 0, hours = 0, standardBillValue = 0, fte = 0;
    for (const p of this.dataRes.value().projects) {
      const m = realizationMetrics(p.id, d, { hoursPerFte: this.hoursPerFte });
      revenue += m.revenue;
      hours += m.hours;
      standardBillValue += m.standardBillValue;
      fte += m.fte;
      for (const t of d.timeEntries ?? []) {
        if (t.projectId === p.id && t.status === 'Approved') heads.add(t.resourceId);
      }
    }
    const headcount = heads.size;
    const revenuePerHead = headcount > 0 ? revenue / headcount : 0;
    return {
      revenue,
      hours,
      standardBillValue,
      realizationPct: standardBillValue > 0 ? (revenue / standardBillValue) * 100 : 0,
      headcount,
      fte,
      revenuePerHead,
      revenuePerFte: fte > 0 ? revenue / fte : revenuePerHead,
    };
  });

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
      case 'high': return 'bg-red-50 text-red-700 ring-1 ring-red-200';
      case 'medium': return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
      default: return 'bg-slate-100 text-slate-600 ring-1 ring-slate-200';
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
    { label: 'Total Active Projects', value: String(this.activeProjectsCount()), trend: null, icon: 'folder', colorClass: 'bg-blue-500' },
    { label: 'Avg Resource Utilization', value: `${Math.round(this.avgUtilization())}%`, trend: null, icon: 'bar_chart', colorClass: 'bg-emerald-500' },
    { label: 'Open Resource Requests', value: String(this.openRequestsCount()), trend: null, icon: 'person_add', colorClass: 'bg-amber-500' },
    { label: 'Delivery Risk Items', value: String(this.highRiskIssues() + this.openChanges() + this.pendingMilestones()), trend: null, icon: 'warning', colorClass: 'bg-red-500' },
  ]);

  /** Human-readable label for a real trend badge (used as aria-label on the icon chip). */
  trendAriaLabel(t: PeriodDelta | null): string {
    if (!t || t.direction === null || t.deltaPct === null) return 'No prior-period comparison available';
    const dir = t.direction === 'up' ? 'up' : t.direction === 'down' ? 'down' : 'flat';
    return `Trend ${dir} ${Math.abs(t.deltaPct).toFixed(0)}% versus prior period`;
  }

  utilizationData = computed(() => this.dataRes.value().resources.map(r => ({
    month: r.name.split(' ')[0] || r.name,
    value: Math.round(r.utilization ?? 0),
  })));

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

  exportReport(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    // Trend column carries the REAL period delta % (or blank when not derivable) — never a fabricated figure (#15).
    const trendCell = (t: PeriodDelta | null): string =>
      t && t.deltaPct !== null && t.direction !== null ? `${t.deltaPct > 0 ? '+' : ''}${t.deltaPct.toFixed(0)}%` : '';
    const csvContent = 'KPI,Value,Trend\n' +
      this.kpis().map(k => `${this.escapeCsv(k.label)},${this.escapeCsv(k.value)},${this.escapeCsv(trendCell(k.trend))}`).join('\n');

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
      { key: 'amount', header: `Amount (${this.baseCurrency} base)` },
    ]);
    downloadCsv('AR_Aging.csv', csv);
    this.notificationService.show('A/R aging exported', 'success');
  }

  /** Export the per-customer A/R table (amounts in base currency) as CSV. */
  exportArByCustomerCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const csv = toCsv(this.arByCustomer(), [
      { key: 'customerName', header: 'Customer' },
      { key: 'totalOutstanding', header: `Outstanding (${this.baseCurrency} base)` },
      { key: 'overdue', header: `Overdue (${this.baseCurrency} base)` },
      { key: 'oldestBucket', header: 'Oldest Bucket (days)' },
    ]);
    downloadCsv('AR_By_Customer.csv', csv);
    this.notificationService.show('A/R by customer exported', 'success');
  }

  /** Export the Margin & Variance drill-down (amounts in base currency) as CSV. */
  exportMarginVarianceCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const cur = this.baseCurrency;
    const csv = toCsv(this.marginRows(), [
      { key: 'name', header: 'Project' },
      { key: 'revenue', header: `Revenue (${cur} base)` },
      { key: 'laborCost', header: `Labor (${cur} base)` },
      { key: 'externalCost', header: `External (${cur} base)` },
      { key: 'expenseCost', header: `Expense (${cur} base)` },
      { key: 'margin', header: `Margin (${cur} base)` },
      { key: 'marginPct', header: 'Margin %', map: r => r.marginPct.toFixed(1) },
      { key: 'eac', header: `EAC (${cur} base)` },
      { key: 'vac', header: `VAC (${cur} base)` },
      { key: 'burnPct', header: 'Burn %', map: r => r.burnPct.toFixed(0) },
    ]);
    downloadCsv('Margin_And_Variance.csv', csv);
    this.notificationService.show('Margin & variance exported', 'success');
  }

  /** Export the per-customer profitability table (amounts in base currency) as CSV. */
  exportCustomerProfitabilityCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const cur = this.baseCurrency;
    const csv = toCsv(this.customerRows(), [
      { key: 'customerName', header: 'Customer' },
      { key: 'revenue', header: `Revenue (${cur} base)` },
      { key: 'cost', header: `Cost (${cur} base)` },
      { key: 'margin', header: `Margin (${cur} base)` },
      { key: 'marginPct', header: 'Margin %', map: r => r.marginPct.toFixed(1) },
      { key: 'sharePct', header: 'Revenue Share %', map: r => r.sharePct.toFixed(1) },
      { key: 'projectIds', header: 'Projects', map: r => String(r.projectIds.length) },
    ]);
    downloadCsv('Customer_Profitability.csv', csv);
    this.notificationService.show('Customer profitability exported', 'success');
  }

  /** Export the margin-compression alert list (project + customer) as CSV. */
  exportMarginCompressionCsv(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const cur = this.baseCurrency;
    const csv = toCsv(this.compressionAlerts(), [
      { key: 'scope', header: 'Scope' },
      { key: 'name', header: 'Name', map: a => a.name ?? a.id },
      { key: 'severity', header: 'Severity', map: a => this.severityLabel(a.severity) },
      { key: 'revenue', header: `Revenue (${cur} base)` },
      { key: 'cost', header: `Cost (${cur} base)` },
      { key: 'marginPct', header: 'Margin %', map: a => a.marginPct.toFixed(1) },
      { key: 'gapPts', header: 'Gap (pts)', map: a => a.gapPts.toFixed(1) },
      { key: 'reasons', header: 'Reasons', map: a => a.reasons.join('; ') },
    ]);
    downloadCsv('Margin_Compression_Alerts.csv', csv);
    this.notificationService.show('Margin-compression alerts exported', 'success');
  }
}
