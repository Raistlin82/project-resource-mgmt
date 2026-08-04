import { ChangeDetectionStrategy, Component, inject, signal, input, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { of } from 'rxjs';
import { ApiService, Project, Order, OrderLine, ResourceRequest, Assignment, Resource, FinancialItem, TimeEntry, Issue, ChangeRequest } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { computeProjectFinancials, FinanceData } from '../../services/finance.util';
import { ProjectPartners } from '../project-partners/project-partners';
import { ProjectDocuments } from '../project-documents/project-documents';
import { ProjectPlans } from '../project-plans/project-plans';
import { FinancialPlans } from '../financial-plans/financial-plans';
import { ProjectCostCenters } from '../project-cost-centers/project-cost-centers';
import { ProjectTasks } from '../project-tasks/project-tasks';
import { ProjectIssues } from '../project-issues/project-issues';
import { ChangeRequests } from '../change-requests/change-requests';
import { ProjectRates } from '../project-rates/project-rates';
import { authGatedResource } from '../../services/auth-gated-resource.util';

@Component({
  selector: 'app-project-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatIconModule,
    CurrencyPipe,
    DatePipe,
    DecimalPipe,
    RouterLink,
    ProjectPartners,
    ProjectDocuments,
    ProjectPlans,
    FinancialPlans,
    ProjectCostCenters,
    ProjectTasks,
    ProjectIssues,
    ChangeRequests,
    ProjectRates
  ],
  template: `
    <div class="command-page space-y-6">
      <!-- Header & Main Info -->
      <div class="command-card overflow-hidden p-6 sm:p-8">
        <div class="flex flex-col sm:flex-row sm:items-start gap-6">
          <a routerLink="/projects" class="command-button secondary w-12 h-12 p-0 shrink-0 mt-1" aria-label="Back to projects">
            <mat-icon>arrow_back</mat-icon>
          </a>
          <div class="flex-1 min-w-0 space-y-6">
            @if (project(); as p) {
              <div>
                <div class="flex flex-wrap items-center gap-3 mb-2">
                  <h1 class="font-display text-3xl sm:text-4xl font-bold text-[var(--cc-ink)] truncate">{{ p.name }}</h1>
                  <span class="command-status"
                        [class.amber]="p.status === 'In Planning'"
                        [class.green]="p.status === 'In Execution'"
                        [class.text-ink-secondary]="p.status === 'Completed'">
                    {{ p.status }}
                  </span>
                  <span class="command-status"
                        [class.green]="deliveryHealth() === 'green'"
                        [class.amber]="deliveryHealth() === 'amber'"
                        [class.red]="deliveryHealth() === 'red'">
                    {{ deliveryHealthLabel() }}
                  </span>
                </div>
                <p class="text-sm text-[var(--cc-muted)] font-mono bg-[var(--cc-panel-muted)] inline-block px-2.5 py-1 rounded-md">{{ p.id }}</p>
              </div>

              <div class="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6 border-t border-[var(--cc-line)]">
                <div class="md:col-span-2">
                  <h3 class="command-kpi-label mb-2">Description</h3>
                  <p class="text-[var(--cc-ink)] leading-relaxed">{{ p.description || 'No description provided.' }}</p>
                </div>
                <div class="space-y-4">
                  <div>
                    <h3 class="command-kpi-label mb-1">Location</h3>
                    <div class="flex items-center gap-2 text-[var(--cc-ink)] font-medium">
                      <mat-icon class="text-[var(--cc-primary)] text-[18px] w-[18px] h-[18px]">location_on</mat-icon>
                      {{ p.location }}
                    </div>
                  </div>
                  <div>
                    <h3 class="command-kpi-label mb-1">Timeline</h3>
                    <div class="flex items-center gap-2 text-[var(--cc-ink)] font-medium">
                      <mat-icon class="text-[var(--cc-green)] text-[18px] w-[18px] h-[18px]">date_range</mat-icon>
                      {{ p.startDate | date:'mediumDate' }} - {{ p.endDate | date:'mediumDate' }}
                    </div>
                  </div>
                </div>
              </div>
            } @else {
              <div class="py-8 text-[var(--cc-muted)] font-medium">Loading...</div>
            }
          </div>
        </div>
      </div>

      <!-- Tabs Navigation -->
      <div class="command-card flex overflow-x-auto hide-scrollbar px-2 sm:px-4">
        @for (tab of tabs(); track tab.id) {
          <button (click)="activeTab.set(tab.id)"
                  class="px-4 py-4 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors"
                  [class.project-tab-active]="activeTab() === tab.id"
                  [class.border-transparent]="activeTab() !== tab.id"
                  [class.text-ink-muted]="activeTab() !== tab.id"
                  [class.hover:text-ink-secondary]="activeTab() !== tab.id"
                  [class.hover:border-line-strong]="activeTab() !== tab.id">
            {{ tab.label }}
          </button>
        }
      </div>

      <!-- Tab Content -->
      <div class="mt-6">
        @if (activeTab() === 'overview') {
          @let f = financials();
          <div class="space-y-6">
            <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <div class="command-kpi" [class.green]="deliveryHealth() === 'green'" [class.warning]="deliveryHealth() === 'amber'" [class.danger]="deliveryHealth() === 'red'">
                <p class="command-kpi-label">Delivery Health</p>
                <p class="command-kpi-value">{{ deliveryHealthLabel() }}</p>
                <p class="command-kpi-note">Based on VAC, burn, risks and change control</p>
              </div>
              <div class="command-kpi" [class.danger]="openIssues() > 0">
                <p class="command-kpi-label">Open Critical Issues</p>
                <p class="command-kpi-value">{{ openIssues() }}</p>
                <p class="command-kpi-note">High, critical or escalated</p>
              </div>
              <div class="command-kpi warning">
                <p class="command-kpi-label">Open Change Requests</p>
                <p class="command-kpi-value">{{ openChanges() }}</p>
                <p class="command-kpi-note">Draft or submitted</p>
              </div>
              <div class="command-kpi info">
                <p class="command-kpi-label">EAC Basis</p>
                <p class="command-kpi-value">{{ f.eac | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Actual cost + planned residual</p>
              </div>
            </div>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              <div class="command-kpi">
                <p class="command-kpi-label">Contract Revenue</p>
                <p class="command-kpi-value font-mono tabular-nums">{{ f.revenue | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Invoiced <span class="font-mono">{{ f.invoiced | currency:'EUR':'symbol':'1.0-0' }}</span></p>
              </div>
              <div class="command-kpi">
                <p class="command-kpi-label">Actual Cost</p>
                <p class="command-kpi-value font-mono tabular-nums">{{ f.actualCost | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Labor <span class="font-mono">{{ f.laborCost | currency:'EUR':'symbol':'1.0-0' }}</span> · External <span class="font-mono">{{ f.externalCost | currency:'EUR':'symbol':'1.0-0' }}</span></p>
              </div>
              <div class="command-kpi" [class.danger]="f.margin < 0">
                <p class="command-kpi-label">Margin</p>
                <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="f.margin >= 0" [class.text-critical-text]="f.margin < 0">{{ f.margin | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note font-semibold" [class.text-positive-text]="f.margin >= 0" [class.text-critical-text]="f.margin < 0">{{ f.marginPct | number:'1.0-1' }}% margin</p>
              </div>
              <div class="command-kpi info">
                <p class="command-kpi-label">Backlog</p>
                <p class="command-kpi-value font-mono tabular-nums">{{ f.backlog | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Revenue not yet invoiced</p>
              </div>
              <div class="command-kpi">
                <p class="command-kpi-label">Budget</p>
                <p class="command-kpi-value font-mono tabular-nums">{{ f.budget | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Planned cost</p>
              </div>
              <div class="command-kpi" [class.danger]="f.burnPct > 100">
                <p class="command-kpi-label">Budget Burn</p>
                <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="f.burnPct <= 100" [class.text-critical-text]="f.burnPct > 100">{{ f.burnPct | number:'1.0-0' }}%</p>
                <div class="w-full bg-surface-muted rounded-full h-2 overflow-hidden mt-2">
                  <div class="h-2 rounded-full" [class.bg-gradient-to-r]="f.burnPct <= 100" [class.from-accent]="f.burnPct <= 100" [class.to-accent]="f.burnPct <= 100" [class.bg-critical]="f.burnPct > 100" [style.width.%]="f.burnPct < 100 ? f.burnPct : 100"></div>
                </div>
              </div>
              <div class="command-kpi info">
                <p class="command-kpi-label">EAC</p>
                <p class="command-kpi-value font-mono tabular-nums">{{ f.eac | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Estimate at completion</p>
              </div>
              <div class="command-kpi">
                <p class="command-kpi-label">ETC</p>
                <p class="command-kpi-value font-mono tabular-nums">{{ f.etc | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Estimated remaining cost</p>
              </div>
              <div class="command-kpi" [class.danger]="f.varianceAtCompletion < 0">
                <p class="command-kpi-label">VAC</p>
                <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="f.varianceAtCompletion >= 0" [class.text-critical-text]="f.varianceAtCompletion < 0">{{ f.varianceAtCompletion | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Budget minus EAC</p>
              </div>
            </div>

            <div class="command-card p-6 sm:p-8">
              <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] tracking-tight mb-6">Revenue breakdown</h3>
              @if (f.revenue > 0) {
                <div class="flex h-9 w-full rounded-xl overflow-hidden text-xs font-bold ring-1 ring-line">
                  <div class="bg-caution-tint text-caution-text flex items-center justify-center min-w-0" [style.width.%]="f.laborCost / f.revenue * 100">Labor</div>
                  <div class="bg-caution-tint text-caution-text flex items-center justify-center min-w-0" [style.width.%]="f.externalCost / f.revenue * 100">Ext</div>
                  <div class="flex items-center justify-center min-w-0" [class.bg-positive-tint]="f.margin >= 0" [class.text-positive-text]="f.margin >= 0" [class.bg-critical-tint]="f.margin < 0" [class.text-critical-text]="f.margin < 0" [style.width.%]="f.marginPct > 0 ? f.marginPct : 0">Margin</div>
                </div>
                <div class="flex flex-wrap gap-4 mt-3 text-xs text-[var(--cc-muted)]">
                  <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-sm bg-caution"></span> Labor</span>
                  <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-sm bg-caution"></span> External</span>
                  <span class="flex items-center gap-1.5"><span class="w-3 h-3 rounded-sm bg-positive"></span> Margin</span>
                </div>
              } @else {
                <p class="text-sm text-[var(--cc-muted)]">No customer revenue recorded for this project yet. Add a Customer order with a line imputed to this project (Commercial → Orders).</p>
              }
            </div>
          </div>
        }
        @if (activeTab() === 'partners') {
          <app-project-partners [projectId]="project()?.id" />
        }
        @if (activeTab() === 'documents') {
          <app-project-documents [projectId]="project()?.id" />
        }
        @if (activeTab() === 'plans') {
          <app-project-plans [projectId]="project()?.id" />
        }
        @if (activeTab() === 'financials') {
          <app-financial-plans [projectId]="project()?.id" />
        }
        @if (activeTab() === 'cost-centers') {
          <app-project-cost-centers [projectId]="project()?.id" />
        }
        @if (activeTab() === 'rates') {
          <app-project-rates [projectId]="project()?.id" />
        }
        @if (activeTab() === 'tasks') {
          <app-project-tasks [projectId]="project()?.id" />
        }
        @if (activeTab() === 'issues') {
          <app-project-issues [projectId]="project()?.id" />
        }
        @if (activeTab() === 'changes') {
          <app-change-requests [projectId]="project()?.id" />
        }
      </div>
    </div>
  `,
  styles: `
    .hide-scrollbar::-webkit-scrollbar {
      display: none;
    }
    .hide-scrollbar {
      -ms-overflow-style: none;
      scrollbar-width: none;
    }
    .project-tab-active {
      border-color: var(--cc-primary);
      color: var(--cc-primary);
    }
  `
})
export class ProjectDetailsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  // Route param ':id' bound via withComponentInputBinding()
  id = input.required<string>();

  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  project = computed(() => this.projectsRes.value().find(p => p.id === this.id()) ?? null);

  // Data for the 360° financial rollup. Sensitive collections are loaded only
  // after authReady, and only for capabilities that can read them, so project
  // delivery users do not hit finance/commercial 403s just by opening details.
  private ordersRes = rxResource<Order[], boolean>({
    params: () => this.auth.authReady() && this.auth.canManageCommercial(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getOrders() : of<Order[]>([])),
    defaultValue: [] as Order[],
  });
  private orderLinesRes = rxResource<OrderLine[], boolean>({
    params: () => this.auth.authReady() && this.auth.canManageCommercial(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getOrderLines() : of<OrderLine[]>([])),
    defaultValue: [] as OrderLine[],
  });
  private requestsRes = rxResource<ResourceRequest[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getRequests() : of<ResourceRequest[]>([])),
    defaultValue: [] as ResourceRequest[],
  });
  private assignmentsRes = rxResource<Assignment[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getAssignments() : of<Assignment[]>([])),
    defaultValue: [] as Assignment[],
  });
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  private financialsRes = rxResource<FinancialItem[], boolean>({
    params: () => this.auth.authReady() && this.auth.canApproveFinancials(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getProjectFinancials() : of<FinancialItem[]>([])),
    defaultValue: [] as FinancialItem[],
  });
  private timeEntriesRes = rxResource<TimeEntry[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getTimeEntries() : of<TimeEntry[]>([])),
    defaultValue: [] as TimeEntry[],
  });
  private issuesRes = authGatedResource(() => this.api.getProjectIssues(), [] as Issue[]);
  private changesRes = authGatedResource(() => this.api.getChangeRequests(), [] as ChangeRequest[]);

  private financeData = computed<FinanceData>(() => ({
    requests: this.requestsRes.value(),
    assignments: this.assignmentsRes.value(),
    resources: this.resourcesRes.value(),
    orders: this.ordersRes.value(),
    orderLines: this.orderLinesRes.value(),
    financials: this.financialsRes.value(),
    timeEntries: this.timeEntriesRes.value(),
  }));
  financials = computed(() => computeProjectFinancials(this.id(), this.financeData()));
  openIssues = computed(() =>
    this.issuesRes.value().filter(i => i.projectId === this.id() && i.status !== 'Resolved' && i.status !== 'Closed' && (i.severity === 'High' || i.severity === 'Critical' || i.escalated)).length,
  );
  openChanges = computed(() =>
    this.changesRes.value().filter(c => c.projectId === this.id() && (c.status === 'Draft' || c.status === 'Submitted')).length,
  );
  deliveryHealth = computed<'green' | 'amber' | 'red'>(() => {
    const f = this.financials();
    if (f.varianceAtCompletion < 0 || this.openIssues() > 0) return 'red';
    if (f.burnPct > 85 || this.openChanges() > 0) return 'amber';
    return 'green';
  });

  activeTab = signal('overview');

  tabs = computed(() => [
    { id: 'overview', label: 'Overview' },
    { id: 'partners', label: 'Partners' },
    { id: 'documents', label: 'Documents' },
    { id: 'plans', label: 'Plans' },
    ...(this.auth.canApproveFinancials()
      ? [
          { id: 'financials', label: 'Financials' },
          { id: 'cost-centers', label: 'Cost Centers' },
        ]
      : []),
    // Negotiated rates (design spec §7) are commercial config, gated the same
    // as /negotiated-rates itself (src/server.ts: sales/finance/
    // delivery-executive/admin) — canManageCommercial() matches that role set
    // exactly, so a non-commercial role never even sees the tab.
    ...(this.auth.canManageCommercial() ? [{ id: 'rates', label: 'Rates' }] : []),
    { id: 'tasks', label: 'Tasks' },
    { id: 'issues', label: 'Issues' },
    { id: 'changes', label: 'Changes' },
  ]);

  deliveryHealthLabel(): string {
    const health = this.deliveryHealth();
    if (health === 'red') return 'Critical';
    if (health === 'amber') return 'Watch';
    return 'On Track';
  }
}
