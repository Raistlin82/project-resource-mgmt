import { ChangeDetectionStrategy, Component, inject, signal, input, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { of } from 'rxjs';
import { ApiService, Project, Order, OrderLine, ResourceRequest, Assignment, Resource, FinancialItem, TimeEntry, Issue, ChangeRequest, CostBaseline, AssignmentDay, AssignmentMonth, FxRate } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { computeProjectFinancials, costBaselineComparison, CostBaselineComparisonRow, FinanceData, hasMeasuredMarginPct } from '../../services/finance.util';
import { NotificationService } from '../../services/notification.service';
import { ProjectPartners } from '../project-partners/project-partners';
import { ProjectDocuments } from '../project-documents/project-documents';
import { ProjectPlans } from '../project-plans/project-plans';
import { FinancialPlans } from '../financial-plans/financial-plans';
import { ProjectCostCenters } from '../project-cost-centers/project-cost-centers';
import { ProjectTasks } from '../project-tasks/project-tasks';
import { ProjectIssues } from '../project-issues/project-issues';
import { ChangeRequests } from '../change-requests/change-requests';
import { ProjectRates } from '../project-rates/project-rates';
import { ListStateComponent } from '../../shared/list-state.component';
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
    ProjectRates,
    ListStateComponent
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
                  <!--
                    deliveryHealth() dereferences three resources whose value()
                    throws while erroring, and this pill renders ABOVE the money
                    grid's error branch — so it needs its own gate or the throw
                    here aborts the pass before that branch can run, blanking
                    the route (utilization.component.ts:34-52).
                    While loading, NO pill: an unbadged header is honest, where
                    a "green / On Track" computed from an empty pre-authReady
                    envelope is a wrong verdict rendered as authoritative.
                  -->
                  @if (healthReady()) {
                    <span data-test="health-chip" class="command-status"
                          [class.green]="deliveryHealth() === 'green'"
                          [class.amber]="deliveryHealth() === 'amber'"
                          [class.red]="deliveryHealth() === 'red'">
                      {{ deliveryHealthLabel() }}
                    </span>
                  } @else if (overviewErrored()) {
                    <!-- Its own wording, never a dash: a failed read is a
                         different fact from "nothing to measure", and this
                         codebase has already paid for collapsing the two. -->
                    <span data-test="health-chip" class="command-status red">Health unavailable</span>
                  }
                </div>
                <p class="text-sm text-[var(--cc-muted)] font-mono bg-[var(--cc-panel-muted)] inline-block px-2.5 py-1 rounded-md">{{ p.id }}</p>
              </div>

              <!--
                THESE THREE ARE FIELD LABELS, NOT HEADINGS.
                They used to be h3 elements sitting directly under the project
                name h1, which SKIPS h2 — and the tab panel below now legitimately
                occupies h2, so the page outline read h1 → h3 → h2. A skipped
                level is its own accessibility defect, and inflating a value's
                label to a section rank to paper over it would be a second one.
                The command-kpi-label class is a plain paragraph at 80 of the 88
                places this codebase uses it (every KPI tile on this very page
                included); these three were the outliers, so this is the
                designed rendering rather than a new one. Precisely: the class
                itself sets colour, family, size, weight and tracking
                (styles.css:759), all of which outrank the h1-h4 element rule
                (styles.css:333) that these three are leaving; the only
                properties that rule contributed and the class does not are
                line-height (tight, now the normal the other 80 labels already
                use) and text-wrap: balance, which does nothing to a one-word
                uppercase micro-label.
              -->
              <div class="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6 border-t border-[var(--cc-line)]">
                <div class="md:col-span-2">
                  <p class="command-kpi-label mb-2">Description</p>
                  <p class="text-[var(--cc-ink)] leading-relaxed">{{ p.description || 'No description provided.' }}</p>
                </div>
                <div class="space-y-4">
                  <div>
                    <p class="command-kpi-label mb-1">Location</p>
                    <div class="flex items-center gap-2 text-[var(--cc-ink)] font-medium">
                      <mat-icon class="text-[var(--cc-primary)] text-[18px] w-[18px] h-[18px]">location_on</mat-icon>
                      {{ p.location }}
                    </div>
                  </div>
                  <div>
                    <p class="command-kpi-label mb-1">Timeline</p>
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
          <div class="space-y-6">
            <!--
              READINESS FIRST, THEN PERMISSION, THEN THE FIGURES.
              The money grid used to sit outside every gate, with the
              "@let f = financials()" declaration at the top of this block. Two
              consequences, both already documented on /reporting
              (reporting.ts:95-105): pre-authReady it shipped a whole strip of
              EUR 0 tiles plus a confident "On Track"; and one failed read threw
              ResourceValueError out of the first tile, aborting the render above
              every recovery affordance on the page. Error, then loading, then
              content — and the @let moved inside the resolved branch so it is
              only evaluated there.
            -->
            @if (overviewErrored()) {
              <app-list-state [error]="true" label="project financials" (retry)="reloadOverview()" />
            } @else if (overviewLoading()) {
              <!-- Same ARIA contract as list-state.component.ts:49-50 (role +
                   aria-live + aria-busy + an sr-only name), so a screen reader
                   is told the region is busy instead of reading a stale grid.
                   aria-label duplicates the sr-only text purely so the region is
                   addressable: it is the only stable handle a test has for "the
                   MONEY grid is skeletonised", distinct from the Baseline card's
                   skeleton, which is also on screen in this state. -->
              <div class="space-y-6" role="status" aria-live="polite" aria-busy="true" aria-label="Loading project financials">
                <span class="sr-only">Loading project financials</span>
                <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                  @for (tile of [1, 2, 3, 4]; track tile) {
                    <div class="command-skeleton h-28"></div>
                  }
                </div>
                <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                  @for (tile of [1, 2, 3, 4, 5, 6, 7, 8, 9]; track tile) {
                    <div class="command-skeleton h-24"></div>
                  }
                </div>
              </div>
            } @else {
            @let f = financials();
            @if (!financeVisible()) {
              <div role="note" data-test="finance-withheld-notice" class="command-card p-4 flex items-start gap-3">
                <mat-icon class="text-[var(--cc-muted)] text-[20px] w-[20px] h-[20px] shrink-0">lock</mat-icon>
                <p class="text-sm text-[var(--cc-muted)]">
                  Your role does not have access to this project's
                  @if (commercialWithheld() && financialsWithheld()) {
                    commercial and financial records
                  } @else if (commercialWithheld()) {
                    commercial records
                  } @else {
                    financial records
                  }, so the tiles below marked “—” are withheld rather than zero.
                  Delivery Health is based on issues and change control only.
                </p>
              </div>
            }
            <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <div class="command-kpi" [class.green]="deliveryHealth() === 'green'" [class.warning]="deliveryHealth() === 'amber'" [class.danger]="deliveryHealth() === 'red'">
                <p class="command-kpi-label">Delivery Health</p>
                <p class="command-kpi-value">{{ deliveryHealthLabel() }}</p>
                <!-- The BASIS is stated, not implied: with the money reads
                     withheld this verdict really is computed from issues and
                     change control alone, and a note claiming otherwise would
                     be the same lie the fabricated "Critical" was. -->
                <p class="command-kpi-note">{{ financeVisible() ? 'Based on VAC, burn, risks and change control' : 'Based on issues and change control — VAC and burn need commercial + financial access' }}</p>
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
                @if (financeVisible()) {
                  <p class="command-kpi-value">{{ f.eac | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <p class="command-kpi-note">Actual cost + planned residual</p>
                } @else {
                  <p class="command-kpi-value">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
            </div>
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
              <div class="command-kpi">
                <p class="command-kpi-label">Contract Revenue</p>
                @if (!commercialWithheld()) {
                  <p class="command-kpi-value font-mono tabular-nums">{{ f.revenue | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <p class="command-kpi-note">Invoiced <span class="font-mono">{{ f.invoiced | currency:'EUR':'symbol':'1.0-0' }}</span></p>
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
              <!-- Actual Cost is withheld by the COMMERCIAL half even though its
                   labor term is readable: actualCost = laborCost + externalCost,
                   and externalCost is a Purchase-order-line sum. Printing the
                   total would print a silently understated figure, so the value
                   is withheld and the labor term the role CAN see is surfaced in
                   the note instead of being thrown away with it. -->
              <div class="command-kpi">
                <p class="command-kpi-label">Actual Cost</p>
                @if (!commercialWithheld()) {
                  <p class="command-kpi-value font-mono tabular-nums">{{ f.actualCost | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <p class="command-kpi-note">Labor <span class="font-mono">{{ f.laborCost | currency:'EUR':'symbol':'1.0-0' }}</span> · External <span class="font-mono">{{ f.externalCost | currency:'EUR':'symbol':'1.0-0' }}</span></p>
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">Labor <span class="font-mono">{{ f.laborCost | currency:'EUR':'symbol':'1.0-0' }}</span> · External needs commercial + financial access</p>
                }
              </div>
              <div class="command-kpi" [class.danger]="financeVisible() && f.margin < 0">
                <p class="command-kpi-label">Margin</p>
                @if (financeVisible()) {
                  <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="f.margin >= 0" [class.text-critical-text]="f.margin < 0">{{ f.margin | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <!-- The AMOUNT above is always real and always shown. The
                       PERCENTAGE below is not: with no revenue to be a
                       percentage of it is finance.util's no-revenue sentinel 0,
                       and "0% margin" beside a red negative amount asserted
                       break-even on an engagement that lost money. A
                       non-billable engagement earns no revenue by construction,
                       so on those pages the sentinel is the only value it ever
                       had. -->
                  @if (hasMarginPct(f.revenue)) {
                    <p class="command-kpi-note font-semibold" data-test="margin-pct" [class.text-positive-text]="f.margin >= 0" [class.text-critical-text]="f.margin < 0">{{ f.marginPct | number:'1.0-1' }}% margin</p>
                  } @else {
                    <p class="command-kpi-note" data-test="margin-pct">&mdash; no customer revenue, so there is no percentage to compute</p>
                  }
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
              <div class="command-kpi info">
                <p class="command-kpi-label">Backlog</p>
                @if (!commercialWithheld()) {
                  <p class="command-kpi-value font-mono tabular-nums">{{ f.backlog | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <p class="command-kpi-note">Revenue not yet invoiced</p>
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
              <div class="command-kpi">
                <p class="command-kpi-label">Budget</p>
                @if (!financialsWithheld()) {
                  <p class="command-kpi-value font-mono tabular-nums">{{ f.budget | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <p class="command-kpi-note">Planned cost</p>
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
              <!-- Burn needs BOTH halves: its numerator is actualCost (commercial)
                   and its denominator the effective budget (financial). Withheld
                   it rendered 0% with a full-width GREEN bar — the most reassuring
                   possible presentation of a number nobody computed. -->
              <div class="command-kpi" [class.danger]="financeVisible() && f.burnPct > 100">
                <p class="command-kpi-label">Budget Burn</p>
                @if (financeVisible()) {
                  <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="f.burnPct <= 100" [class.text-critical-text]="f.burnPct > 100">{{ f.burnPct | number:'1.0-0' }}%</p>
                  <div class="w-full bg-surface-muted rounded-full h-2 overflow-hidden mt-2">
                    <div class="h-2 rounded-full" [class.bg-gradient-to-r]="f.burnPct <= 100" [class.from-accent]="f.burnPct <= 100" [class.to-accent]="f.burnPct <= 100" [class.bg-critical]="f.burnPct > 100" [style.width.%]="f.burnPct < 100 ? f.burnPct : 100"></div>
                  </div>
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
              <div class="command-kpi info">
                <p class="command-kpi-label">EAC</p>
                @if (financeVisible()) {
                  <p class="command-kpi-value font-mono tabular-nums">{{ f.eac | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <p class="command-kpi-note">Estimate at completion</p>
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
              <!-- ETC is DELIBERATELY not withheld. It is
                   max(0, plannedLaborCost − actualLaborCost): requests,
                   assignments, resources and time entries only, all of which a
                   staffing role reads. Dashing it would hide a figure that is
                   correct — the mirror-image defect of printing one that is not. -->
              <div class="command-kpi">
                <p class="command-kpi-label">ETC</p>
                <p class="command-kpi-value font-mono tabular-nums">{{ f.etc | currency:'EUR':'symbol':'1.0-0' }}</p>
                <p class="command-kpi-note">Estimated remaining cost</p>
              </div>
              <div class="command-kpi" [class.danger]="financeVisible() && f.varianceAtCompletion < 0">
                <p class="command-kpi-label">VAC</p>
                @if (financeVisible()) {
                  <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="f.varianceAtCompletion >= 0" [class.text-critical-text]="f.varianceAtCompletion < 0">{{ f.varianceAtCompletion | currency:'EUR':'symbol':'1.0-0' }}</p>
                  <p class="command-kpi-note">Budget minus EAC</p>
                } @else {
                  <p class="command-kpi-value font-mono tabular-nums">—</p>
                  <p class="command-kpi-note">needs commercial + financial access</p>
                }
              </div>
            </div>

            <!-- The whole card is commercial: the bar is a proportion OF revenue,
                 and its @else copy ("Add a Customer order with a line imputed to
                 this project") was the most actively misleading string on the
                 page — printed to the one role that cannot read the orders that
                 already exist. -->
            @if (!commercialWithheld()) {
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
            }
            <!-- end of the resolved branch of the readiness gate above -->
            }

            <!-- The Baseline card stays OUTSIDE that gate on purpose: it carries
                 its own app-list-state over its own three resources, so a failed
                 /time-entries or /fx-rates must not take it down with the money
                 grid, and its error panel must stay reachable. -->
            @if (auth.canReadStaffing()) {
              <div class="command-card p-6 sm:p-8">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
                  <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] tracking-tight">Baseline vs Planned</h3>
                  @if (auth.canApproveFinancials()) {
                    <button type="button" (click)="freezeBaseline()" [disabled]="freezingBaseline()"
                            class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
                      <mat-icon class="text-[18px] w-[18px] h-[18px]">ac_unit</mat-icon>
                      {{ freezingBaseline() ? 'Freezing…' : 'Freeze baseline' }}
                    </button>
                  }
                </div>
                <app-list-state [loading]="baselineLoading()" [error]="baselineErrored()" skeleton="table-rows" [rows]="3" [columns]="5" label="cost baseline" (retry)="reloadBaseline()">
                  <ng-template>
                    @if (!hasComparisonRows()) {
                      <p class="text-sm text-[var(--cc-muted)]">No baseline frozen for this project yet.</p>
                    } @else {
                      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                        <div class="command-kpi">
                          <p class="command-kpi-label">Baseline</p>
                          <p class="command-kpi-value font-mono tabular-nums">{{ baselineTotals().baseline | currency:'EUR':'symbol':'1.0-0' }}</p>
                        </div>
                        <div class="command-kpi">
                          <p class="command-kpi-label">Planned</p>
                          <p class="command-kpi-value font-mono tabular-nums">{{ baselineTotals().planned | currency:'EUR':'symbol':'1.0-0' }}</p>
                        </div>
                        <div class="command-kpi" [class.danger]="baselineTotals().delta > 0">
                          <p class="command-kpi-label">Delta</p>
                          <p class="command-kpi-value font-mono tabular-nums" [class.text-positive-text]="baselineTotals().delta <= 0" [class.text-critical-text]="baselineTotals().delta > 0">{{ baselineTotals().delta | currency:'EUR':'symbol':'1.0-0' }}</p>
                          <p class="command-kpi-note">{{ baselineTotals().deltaPct !== null ? ((baselineTotals().deltaPct! > 0 ? '+' : '') + (baselineTotals().deltaPct! | number:'1.2-2') + '%') : '—' }}</p>
                        </div>
                      </div>
                      <div class="overflow-x-auto">
                        <table class="command-data-table">
                          <thead class="bg-surface-muted border-b border-line text-ink-muted">
                            <tr>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-left">Period</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Baseline</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Planned</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Delta</th>
                              <th class="px-4 py-3 font-semibold uppercase tracking-wider text-xs text-right">Delta %</th>
                            </tr>
                          </thead>
                          <tbody class="divide-y divide-line">
                            @for (row of baselineRows(); track row.period) {
                              <tr>
                                <td class="px-4 py-3 font-medium text-ink">
                                  {{ row.period }}
                                  @if (row.outOfBaselineHorizon) {
                                    <span class="command-status amber ml-2 text-[10px]">not frozen</span>
                                  }
                                </td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums">{{ row.baseline | currency:'EUR':'symbol':'1.0-0' }}</td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums">{{ row.planned | currency:'EUR':'symbol':'1.0-0' }}</td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums" [class.text-positive-text]="row.delta <= 0" [class.text-critical-text]="row.delta > 0">{{ row.delta | currency:'EUR':'symbol':'1.0-0' }}</td>
                                <td class="px-4 py-3 text-right font-mono tabular-nums">{{ row.deltaPct !== null ? ((row.deltaPct > 0 ? '+' : '') + (row.deltaPct | number:'1.2-2') + '%') : '—' }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                    }
                  </ng-template>
                </app-list-state>
              </div>
            }
          </div>
        }
        <!--
          [headingLevel]="2" ON EVERY PANEL — the whole of the heading convention.

          Each of these eight components is ALSO a standalone route
          (app.routes.ts: project-partners, project-documents, project-plans,
          financial-plans, project-cost-centers, project-tasks, project-issues,
          change-requests), where it IS the page and its title must therefore be
          the page's one h1. Here the same component is a tab panel UNDER the
          project-name h1 above, so that title must be an h2: giving each panel a
          plain h1 would have put TWO h1 elements on this route, trading the
          missing-h1 defect for a duplicate-h1 one.

          The level is therefore the PARENT's to declare, not something a child
          can infer. It deliberately does NOT reuse projectId: that input is
          project()?.id, which is undefined for the whole window before the
          project resolves, so a child keying its heading off "do I have an id"
          — the discriminator these panels already use for their project picker
          — would render its standalone h1 inside this page mid-load.
          headingLevel says what it means and never flickers.

          app-project-rates takes no binding: it is tab-only (no route of its
          own) and its title is already an h2, which is what embedding requires.
          The moment it gains a route it needs this input too.
        -->
        @if (activeTab() === 'partners') {
          <app-project-partners [projectId]="project()?.id" [headingLevel]="2" />
        }
        @if (activeTab() === 'documents') {
          <app-project-documents [projectId]="project()?.id" [headingLevel]="2" />
        }
        @if (activeTab() === 'plans') {
          <app-project-plans [projectId]="project()?.id" [headingLevel]="2" />
        }
        @if (activeTab() === 'financials') {
          <app-financial-plans [projectId]="project()?.id" [headingLevel]="2" />
        }
        @if (activeTab() === 'cost-centers') {
          <app-project-cost-centers [projectId]="project()?.id" [headingLevel]="2" />
        }
        @if (activeTab() === 'rates') {
          <app-project-rates [projectId]="project()?.id" />
        }
        @if (activeTab() === 'tasks') {
          <app-project-tasks [projectId]="project()?.id" [headingLevel]="2" />
        }
        @if (activeTab() === 'issues') {
          <app-project-issues [projectId]="project()?.id" [headingLevel]="2" />
        }
        @if (activeTab() === 'changes') {
          <app-change-requests [projectId]="project()?.id" [headingLevel]="2" />
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
  protected auth = inject(AuthService);
  private notificationService = inject(NotificationService);

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

  // Baseline vs Planned (design spec, block E, §8). Gated on BOTH authReady
  // AND canReadStaffing — unlike the pre-existing KPIs above (authReady only)
  // — so employee/sales never even issue these three fetches.
  private assignmentDaysRes = rxResource<AssignmentDay[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadStaffing(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getAssignmentDays() : of<AssignmentDay[]>([])),
    defaultValue: [] as AssignmentDay[],
  });
  private assignmentMonthsRes = rxResource<AssignmentMonth[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadStaffing(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getAssignmentMonths() : of<AssignmentMonth[]>([])),
    defaultValue: [] as AssignmentMonth[],
  });
  private costBaselinesRes = rxResource<CostBaseline[], boolean>({
    params: () => this.auth.authReady() && this.auth.canReadStaffing(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getCostBaselines() : of<CostBaseline[]>([])),
    defaultValue: [] as CostBaseline[],
  });

  private issuesRes = authGatedResource(() => this.api.getProjectIssues(), [] as Issue[]);
  private changesRes = authGatedResource(() => this.api.getChangeRequests(), [] as ChangeRequest[]);
  // FX is REQUIRED to sum order lines, not an enrichment. An OrderLine carries no
  // currency of its own — it inherits its parent ORDER's (`lineSum`) — and
  // `convertToBase` is a no-op when `d.fxRates` is absent, so a multi-currency
  // project had its lines added together as bare numbers and printed under this
  // page's hardcoded 'EUR' symbol. On seeded project 2, order O3 is USD with a
  // 120,000 line and USD→EUR is 0.92: this page read EUR 120,000 for something
  // worth EUR 110,400 — EUR 9,600 too high — and its Margin subtracted
  // EUR-denominated cost from a USD revenue. /reporting, which passes the table,
  // read 110,400 for the same order. Only principal-gated (no capability term):
  // /fx-rates is readable by any verified actor, and it is reference data, not a
  // figure of this project's.
  private fxRatesRes = authGatedResource(() => this.api.getFxRates(), [] as FxRate[]);

  private financeData = computed<FinanceData>(() => ({
    requests: this.requestsRes.value(),
    assignments: this.assignmentsRes.value(),
    resources: this.resourcesRes.value(),
    orders: this.ordersRes.value(),
    orderLines: this.orderLinesRes.value(),
    financials: this.financialsRes.value(),
    timeEntries: this.timeEntriesRes.value(),
    // changeRequests is REQUIRED here, not optional enrichment. `finance.util.ts`
    // computes `effectiveBudgetForProject = budgetForProject + approvedChangeBudget`,
    // and its approved-CR term returns 0 when `d.changeRequests` is undefined — so
    // omitting the key silently dropped every APPROVED change request from this
    // screen's Budget, Budget Burn and VAC while /reporting, whose envelope carries
    // it, used the effective figure. On seeded project 2 (financial plan 10,000 and
    // CR2 Approved at impactBudget -5,000) this page showed Budget EUR 10,000 and a
    // burn of actualCost/10,000 against /reporting's 5,000 — exactly double, with a
    // EUR 5,000 VAC gap that can also flip `deliveryHealth()` from red to green.
    //
    // GATED ON THE SAME CAPABILITY AS THE BUDGET IT ADJUSTS. `changesRes` is only
    // principal-gated, because the open-change COUNT is a delivery figure a pm may
    // see; but inside this envelope the rows have exactly one job — adjusting the
    // budget — and `financialsRes` is gated on canApproveFinancials. Passing them
    // ungated made a pm's Budget read −5,000: the plan budget was withheld (0) while
    // the approved CR was still subtracted, fabricating a negative budget out of a
    // read that role never made. A withheld budget must stay withheld, not become
    // the CR adjustment on its own.
    changeRequests: this.auth.canApproveFinancials() ? this.changesRes.value() : [],
    fxRates: this.fxRatesRes.value(),
  }));
  financials = computed(() => computeProjectFinancials(this.id(), this.financeData()));

  /**
   * WITHHELD IS NOT ZERO — permission, deliberately NOT readiness.
   *
   * `ordersRes`/`orderLinesRes` only fetch for canManageCommercial and
   * `financialsRes` only for canApproveFinancials (above), so for every other
   * principal — notably `pm`, whose own route guard is just canReadStaffing()
   * (app.routes.ts) — those resources resolve SUCCESSFULLY with an empty array.
   * `computeProjectFinancials` cannot tell "this project has no orders" from
   * "you may not read the orders", so it returned revenue 0 and budget 0 and
   * then DERIVED figures from them: a negative Margin, a negative VAC, a 0%
   * burn with a green bar, and — because `deliveryHealth()` turns red on
   * varianceAtCompletion < 0 — "Delivery Health: Critical" on a healthy
   * project, for the one role that acts on Delivery Health.
   *
   * These flags let the template print "withheld" where it would otherwise
   * print a fabrication. They must never be collapsed with
   * `overviewLoading()`/`overviewErrored()` below: a withheld read rendered as
   * a skeleton spins forever, and a failed read rendered as an access notice
   * blames the user for a 500.
   */
  protected commercialWithheld = computed(() => !this.auth.canManageCommercial());
  protected financialsWithheld = computed(() => !this.auth.canApproveFinancials());
  /** Every money figure on the Overview is real only when BOTH halves are readable. */
  protected financeVisible = computed(() => !this.commercialWithheld() && !this.financialsWithheld());

  /**
   * finance.util's rule for "is this margin percentage measured, or the
   * no-revenue sentinel?". Independent of `financeVisible()` above: that one
   * answers MAY the reader see it, this one answers IS THERE anything to see.
   */
  protected hasMarginPct(revenue: number): boolean { return hasMeasuredMarginPct(revenue); }

  /**
   * READINESS of the Overview money grid — the gate the grid never had.
   *
   * reporting.ts:95-105 documents the identical shape on the portfolio screen:
   * (1) before `authReady` every gated resource resolves with an EMPTY
   * envelope, so SSR and the whole pre-hydration window shipped a strip of
   * EUR 0 tiles plus a confident "On Track" that then jumped; (2) on the error
   * path `financials()` dereferences a resource whose `value()` THROWS, which
   * aborted the render inside the FIRST tile — above the Baseline card's own
   * error panel — and blanked the entire route with no message and no Retry.
   *
   * Covers every resource the grid and the health verdict dereference,
   * including `issuesRes`/`changesRes` (the two count tiles live in the same
   * grid and `deliveryHealth()` reads both) and `fxRatesRes` (a failed FX read
   * must suppress the strip, not silently render unconverted amounts under a
   * base-currency symbol). Deliberately EXCLUDES the three Baseline-card
   * resources: that card carries its own app-list-state and must keep
   * rendering when only a finance read failed.
   */
  protected overviewLoading = computed(() => !this.auth.authReady()
    || this.requestsRes.isLoading() || this.assignmentsRes.isLoading() || this.resourcesRes.isLoading()
    || this.ordersRes.isLoading() || this.orderLinesRes.isLoading() || this.financialsRes.isLoading()
    || this.timeEntriesRes.isLoading() || this.fxRatesRes.isLoading()
    || this.issuesRes.isLoading() || this.changesRes.isLoading());
  protected overviewErrored = computed(() => this.requestsRes.status() === 'error'
    || this.assignmentsRes.status() === 'error' || this.resourcesRes.status() === 'error'
    || this.ordersRes.status() === 'error' || this.orderLinesRes.status() === 'error'
    || this.financialsRes.status() === 'error' || this.timeEntriesRes.status() === 'error'
    || this.fxRatesRes.status() === 'error' || this.issuesRes.status() === 'error'
    || this.changesRes.status() === 'error');
  /**
   * `deliveryHealth()` dereferences `financials()`, `openIssues()` and
   * `openChanges()` — three resource `value()` calls that THROW while erroring.
   * The header pill that renders it sits ABOVE the money grid's error branch,
   * so without its own gate the throw there makes that branch unreachable code:
   * the panel written for the failure can never render. This is the guard shape
   * utilization.component.ts:34-52 documents.
   */
  protected healthReady = computed(() => !this.overviewLoading() && !this.overviewErrored());

  /** Retry for the Overview money grid; every resource its figures are built from. */
  reloadOverview(): void {
    this.requestsRes.reload();
    this.assignmentsRes.reload();
    this.resourcesRes.reload();
    this.ordersRes.reload();
    this.orderLinesRes.reload();
    this.financialsRes.reload();
    this.timeEntriesRes.reload();
    this.fxRatesRes.reload();
    this.issuesRes.reload();
    this.changesRes.reload();
  }

  protected baselineLoading = computed(() => !this.auth.authReady()
    || this.requestsRes.isLoading() || this.assignmentsRes.isLoading() || this.resourcesRes.isLoading()
    || this.assignmentDaysRes.isLoading() || this.assignmentMonthsRes.isLoading() || this.costBaselinesRes.isLoading());
  protected baselineErrored = computed(() => this.requestsRes.status() === 'error' || this.assignmentsRes.status() === 'error'
    || this.resourcesRes.status() === 'error' || this.assignmentDaysRes.status() === 'error'
    || this.assignmentMonthsRes.status() === 'error' || this.costBaselinesRes.status() === 'error');
  private baselineData = computed<FinanceData>(() => ({
    requests: this.requestsRes.value(),
    assignments: this.assignmentsRes.value(),
    resources: this.resourcesRes.value(),
    orders: [], orderLines: [], financials: [],
    assignmentDays: this.assignmentDaysRes.value(),
    assignmentMonths: this.assignmentMonthsRes.value(),
    costBaselines: this.costBaselinesRes.value(),
  }));
  protected baselineRows = computed<CostBaselineComparisonRow[]>(() => costBaselineComparison(this.baselineData(), this.id()));
  // Named for exactly what it checks (not "does a CostBaseline row exist" —
  // costBaselineComparison's own union of baseline-periods and booked-periods
  // means a project with booked hours but NO frozen baseline still produces a
  // real row, flagged outOfBaselineHorizon: true, that the UI must show with
  // its "not frozen" badge rather than hide behind an empty-state message).
  // Reuses costBaselineComparison's OWN definition of "truly nothing to show"
  // (returns [] only when neither a baseline nor any booked hours exist) so
  // there is one definition of "empty" in one place, not two that can drift.
  protected hasComparisonRows = computed(() => this.baselineRows().length > 0);
  /**
   * Portfolio-vs-baseline coordinator ruling (block E, post-Task-8 review):
   * the summary totals must aggregate the SAME population as the ratio's
   * denominator — periods that actually have a current baseline row — never
   * every period in baselineRows()'s union (which also includes out-of-
   * -horizon months with baseline 0 purely because they have booked hours).
   * Summing planned cost across those never-frozen months against a
   * denominator that only ever contains the few frozen ones produces a
   * numerator and denominator describing DIFFERENT populations — a ratio
   * that is arithmetically derivable but semantically meaningless (a
   * five-digit percentage). The per-period table below is unaffected: each
   * row's own baseline/planned/delta/deltaPct already reflects its own
   * period correctly (Rule A, Task 4) — only this AGGREGATE was wrong.
   */
  protected baselineTotals = computed(() => {
    const rows = this.baselineRows().filter(r => !r.outOfBaselineHorizon);
    const baseline = rows.reduce((s, r) => s + r.baseline, 0);
    const planned = rows.reduce((s, r) => s + r.planned, 0);
    const delta = planned - baseline;
    return { baseline, planned, delta, deltaPct: baseline !== 0 ? (delta / baseline) * 100 : null };
  });

  protected freezingBaseline = signal(false);
  freezeBaseline(): void {
    const id = this.project()?.id;
    if (!id || this.freezingBaseline()) return;
    this.freezingBaseline.set(true);
    this.api.freezeCostBaseline(id).subscribe({
      next: () => {
        this.freezingBaseline.set(false);
        this.costBaselinesRes.reload();
        this.notificationService.show('Baseline frozen', 'success');
      },
      error: (err: { error?: { error?: string } }) => {
        this.freezingBaseline.set(false);
        this.notificationService.show(err.error?.error ?? 'Could not freeze baseline', 'error');
      },
    });
  }
  reloadBaseline(): void {
    this.assignmentDaysRes.reload();
    this.assignmentMonthsRes.reload();
    this.costBaselinesRes.reload();
  }

  openIssues = computed(() =>
    this.issuesRes.value().filter(i => i.projectId === this.id() && i.status !== 'Resolved' && i.status !== 'Closed' && (i.severity === 'High' || i.severity === 'Critical' || i.escalated)).length,
  );
  openChanges = computed(() =>
    this.changesRes.value().filter(c => c.projectId === this.id() && (c.status === 'Draft' || c.status === 'Submitted')).length,
  );
  deliveryHealth = computed<'green' | 'amber' | 'red'>(() => {
    const f = this.financials();
    // The variance and burn terms are built from the commercial + financial
    // reads. When those are withheld both are 0-based fabrications, and
    // `varianceAtCompletion < 0` pinned this at 'red' — so the header pill and
    // the first tile BOTH announced "Critical" on a healthy project while the
    // money tiles beside them were explicitly marked unavailable. Dropping the
    // two withheld terms lets the verdict fall through to the terms this
    // principal genuinely can read (issues and change control); the tile's note
    // states that reduced basis rather than leaving it implied.
    const moneyKnown = this.financeVisible();
    if ((moneyKnown && f.varianceAtCompletion < 0) || this.openIssues() > 0) return 'red';
    if ((moneyKnown && f.burnPct > 85) || this.openChanges() > 0) return 'amber';
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
