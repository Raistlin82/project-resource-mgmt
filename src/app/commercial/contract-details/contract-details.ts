import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { of } from 'rxjs';
import {
  ApiService,
  Assignment,
  BASE_CURRENCY,
  BillingPlanItem,
  Contract,
  Customer,
  FinancialItem,
  FxRate,
  Milestone,
  NegotiatedRate,
  Order,
  OrderLine,
  Project,
  ProjectRole,
  Resource,
  ResourceRequest,
  TimeEntry,
} from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import {
  computeProjectFinancials,
  convertToBase,
  FinanceData,
  hasMeasuredMarginPct,
  JournalEntry,
  journalTotals,
  recognitionJournal,
  recognitionSchedule,
  RecognitionPeriod,
} from '../../services/finance.util';
import { NotificationService } from '../../services/notification.service';
import { todayLocalIso } from '../../services/local-date.util';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { DEFAULT_HOURS_PER_DAY } from '../../services/sell-rate.util';
import { authGatedResource } from '../../services/auth-gated-resource.util';

interface BillingActualEvent {
  period: string;
  projectId: string;
  amount: number;
  orderId: string;
  status: Order['status'];
}

interface BillingControlRow {
  period: string;
  projectId: string;
  projectName: string;
  expected: number;
  actual: number;
  variance: number;
  status: 'Covered' | 'Behind' | 'Partial' | 'Planned' | 'Actual only';
  expectedLabels: string;
  actualSources: string;
}

@Component({
  selector: 'app-contract-details',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, DecimalPipe, MatIconModule, ReactiveFormsModule, RouterLink, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6 p-4 sm:p-6 lg:p-8">
      @if (contract(); as c) {
        <!-- Header card -->
        <div class="command-card p-6 sm:p-8">
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-6">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-xs text-ink-muted mb-2">
                <a routerLink="/contracts" class="text-accent-text hover:underline transition-colors flex items-center gap-1">
                  <mat-icon class="text-[16px] w-[16px] h-[16px]">arrow_back</mat-icon> Contracts
                </a>
              </div>
              <p class="command-eyebrow">Contract</p>
              <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight truncate">{{ c.name }}</h1>
              <div class="flex flex-wrap items-center gap-3 mt-3 text-sm text-[var(--cc-muted)]">
                <span class="inline-flex items-center gap-1.5 font-medium">
                  <mat-icon class="text-[18px] w-[18px] h-[18px] text-ink-muted">business</mat-icon>
                  {{ customerName() }}
                </span>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-surface-muted text-ink-secondary font-mono">
                  {{ c.type }}
                </span>
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide ring-1"
                      [class.bg-caution-tint]="c.status === 'Draft'"
                      [class.text-caution-text]="c.status === 'Draft'"
                      [class.ring-caution]="c.status === 'Draft'"
                      [class.bg-positive-tint]="c.status === 'Active'"
                      [class.text-positive-text]="c.status === 'Active'"
                      [class.ring-positive]="c.status === 'Active'"
                      [class.bg-surface-muted]="c.status === 'Closed'"
                      [class.text-ink-secondary]="c.status === 'Closed'"
                      [class.ring-line]="c.status === 'Closed'">
                  {{ c.status }}
                </span>
              </div>
            </div>
            <div class="text-right shrink-0">
              <p class="command-kpi-label">Total Value</p>
              <p class="command-kpi-value">{{ c.totalValue | currency: c.currency }}</p>
            </div>
          </div>
        </div>

        <!--
          MONEY STRIP GATE (round 2). An errored or forbidden read must never
          reach a currency pipe: the status()==='error' ? [] : value() accessors
          make the page survive, but an empty array renders as 0.00, which is a
          claim, not a blank.
        -->
        @if (moneyFiguresState() === 'error') {
          <div class="command-empty command-card p-10 text-center text-ink-muted" role="alert">
            <p class="font-semibold text-[var(--cc-ink)]">Limited data — contract figures are unavailable.</p>
            <p class="mt-1 text-sm">One of the reads these amounts are derived from failed, so no figure is shown rather than a zero.</p>
            <button type="button" class="command-button mt-3" (click)="reloadMoneyData()">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
            </button>
          </div>
        } @else if (moneyFiguresState() === 'loading') {
          <div class="grid grid-cols-2 lg:grid-cols-6 gap-4" aria-busy="true" aria-label="Loading contract figures">
            @for (tile of [1, 2, 3, 4, 5, 6]; track tile) {
              <div class="command-skeleton h-24"></div>
            }
          </div>
        } @else {
        <!-- KPI row -->
        <div class="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <div class="command-kpi">
            <p class="command-kpi-label">Contract Value</p>
            <p class="command-kpi-value">{{ c.totalValue | currency: c.currency }}</p>
          </div>
          <div class="command-kpi">
            <p class="command-kpi-label">Order Revenue</p>
            <p class="command-kpi-value">{{ kpis().revenue | currency: BASE_CURRENCY }}</p>
          </div>
          <div class="command-kpi info">
            <p class="command-kpi-label">Invoiced</p>
            <p class="command-kpi-value">{{ kpis().invoiced | currency: BASE_CURRENCY }}</p>
          </div>
          <div class="command-kpi" [class.danger]="kpis().margin < 0">
            <p class="command-kpi-label">Margin</p>
            <p class="command-kpi-value"
               [class.text-positive-text]="kpis().margin >= 0"
               [class.text-critical-text]="kpis().margin < 0">
              {{ kpis().margin | currency: BASE_CURRENCY }}
            </p>
          </div>
          <!-- A signed contract with no order lines yet has zero revenue and
               real delivery cost — an ordinary state, not an edge — and then
               the margin % here is finance.util's no-revenue sentinel 0. The
               tone goes with the figure so the tile does not turn red off it. -->
          <div class="command-kpi" [class.danger]="hasMarginPct(kpis().revenue) && kpis().marginPct < 0">
            <p class="command-kpi-label">Margin %</p>
            @if (hasMarginPct(kpis().revenue)) {
              <p class="command-kpi-value" data-test="contract-margin-pct"
                 [class.text-positive-text]="kpis().marginPct >= 0"
                 [class.text-critical-text]="kpis().marginPct < 0">
                {{ kpis().marginPct.toFixed(1) }}%
              </p>
            } @else {
              <p class="command-kpi-value text-ink-muted" data-test="contract-margin-pct"
                 title="No customer revenue — a margin percentage is undefined">&mdash;</p>
            }
          </div>
          <div class="command-kpi info">
            <p class="command-kpi-label">EAC</p>
            <p class="command-kpi-value">{{ kpis().eac | currency: BASE_CURRENCY }}</p>
          </div>
        </div>
        }

        <!-- Projects under this contract -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Projects under this contract</h2>
          </div>
          <!-- The per-project figures are the SAME money, so the same gate: under
               a failed read this table showed Actual Cost 0.00 and Margin % 100.0
               per project. -->
          @if (moneyFiguresState() === 'error') {
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted" role="alert">
              <p class="font-semibold text-[var(--cc-ink)]">Limited data — per-project figures are unavailable.</p>
              <p class="mt-1 text-sm">A read these amounts are derived from failed; no figure is shown rather than a zero.</p>
              <button type="button" class="command-button mt-3" (click)="reloadMoneyData()">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
              </button>
            </div>
          } @else if (moneyFiguresState() === 'loading') {
            <div class="p-4 space-y-2" aria-busy="true" aria-label="Loading per-project figures">
              @for (row of [1, 2, 3]; track row) {
                <div class="command-skeleton h-10"></div>
              }
            </div>
          } @else {
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th class="text-right">Revenue</th>
                  <th class="text-right">Actual Cost</th>
                  <th class="text-right">EAC</th>
                  <th class="text-right">Margin</th>
                  <th class="text-right">Margin %</th>
                </tr>
              </thead>
              <tbody>
                @for (row of projectRows(); track row.project.id) {
                  <tr>
                    <td class="font-medium">
                      <a [routerLink]="['/projects', row.project.id]" class="text-accent-text hover:underline transition-colors">
                        {{ row.project.name }}
                      </a>
                    </td>
                    <td class="text-right text-ink-secondary font-mono tabular-nums">{{ row.fin.revenue | currency: BASE_CURRENCY }}</td>
                    <td class="text-right text-ink-secondary font-mono tabular-nums">{{ row.fin.actualCost | currency: BASE_CURRENCY }}</td>
                    <td class="text-right text-ink-secondary font-mono tabular-nums">{{ row.fin.eac | currency: BASE_CURRENCY }}</td>
                    <td class="text-right font-medium font-mono tabular-nums"
                        [class.text-positive-text]="row.fin.margin >= 0"
                        [class.text-critical-text]="row.fin.margin < 0">
                      {{ row.fin.margin | currency: BASE_CURRENCY }}
                    </td>
                    @if (hasMarginPct(row.fin.revenue)) {
                      <td class="text-right font-medium font-mono tabular-nums" data-test="contract-project-margin-pct"
                          [class.text-positive-text]="row.fin.marginPct >= 0"
                          [class.text-critical-text]="row.fin.marginPct < 0">
                        {{ row.fin.marginPct.toFixed(1) }}%
                      </td>
                    } @else {
                      <td class="text-right font-medium font-mono tabular-nums text-ink-muted" data-test="contract-project-margin-pct"
                          title="No customer revenue — a margin percentage is undefined">&mdash;</td>
                    }
                  </tr>
                }
                @if (!projectRows().length) {
                  <tr>
                    <td colspan="6" class="px-6 sm:px-8 py-10 text-center text-ink-muted">
                      No projects linked to this contract.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          }
        </div>

        <!-- Negotiated Rates (design spec §7) -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Negotiated Rates</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Per-profile sell price for Time &amp; Materials revenue on this contract. A project under this contract can override any row.</p>
            </div>
            <button type="button" (click)="openRateForm()" class="command-button">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon>
              Add Rate
            </button>
          </div>
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Currency</th>
                  <th class="text-right">Bill rate (€/day)</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                @for (rate of contractNegotiatedRates(); track rate.id) {
                  <tr data-test="negotiated-rate-row">
                    <td class="font-medium">
                      {{ rate.role }}
                      @if (rate.currency !== BASE_CURRENCY) {
                        <span class="command-status amber ml-1.5" title="sellRateFor only reads EUR-denominated rates; this row is not yet applied to any invoice.">Not applied (EUR only)</span>
                      }
                    </td>
                    <td class="font-mono text-ink-secondary">{{ rate.currency }}</td>
                    <td class="text-right font-mono tabular-nums">{{ rate.billRate | number:'1.0-2' }}</td>
                    <td class="text-right">
                      <button type="button" (click)="openRateForm(rate)" [attr.aria-label]="'Edit rate for ' + rate.role" class="text-ink-muted hover:text-accent-text p-1.5 rounded-lg transition-colors">
                        <mat-icon class="text-[18px] w-[18px] h-[18px]">edit</mat-icon>
                      </button>
                      <button type="button" (click)="deleteRate(rate)" [attr.aria-label]="'Delete rate for ' + rate.role" class="text-ink-muted hover:text-critical-text p-1.5 rounded-lg transition-colors ml-1">
                        <mat-icon class="text-[18px] w-[18px] h-[18px]">delete</mat-icon>
                      </button>
                    </td>
                  </tr>
                }
                @if (!contractNegotiatedRates().length) {
                  <tr>
                    <td colspan="4" class="px-6 sm:px-8 py-10 text-center text-ink-muted">
                      @if (moneyFiguresState() === 'error') {
                        <!-- "None" is a FACT. Under a failed read it is not one, and
                             printing it under the Limited-data banner above states
                             as fact the very thing the banner says is unknown. -->
                        <span>Unavailable — a read this list depends on failed.</span>
                      } @else if (moneyFiguresState() === 'loading') {
                        <span>Loading…</span>
                      } @else {
                        No negotiated rates for this contract. T&amp;M revenue prices at each profile's reference rate card.
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        @if (showRateForm()) {
          <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
               appModal ariaLabelledby="rateModalTitle" (dismiss)="closeRateForm()">
            <div class="command-card w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
              <div class="command-card-header">
                <h2 id="rateModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">
                  {{ editingRateId() ? 'Edit Negotiated Rate' : 'Add Negotiated Rate' }}
                </h2>
                <button type="button" (click)="closeRateForm()" aria-label="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                  <mat-icon>close</mat-icon>
                </button>
              </div>
              <div class="p-6 sm:p-8 overflow-y-auto flex-1 space-y-6">
                <div>
                  <label for="rateRole" class="block text-sm font-semibold text-ink-secondary mb-1.5">Role *</label>
                  <!-- Never [value] on a <select> whose <option>s come from an @for — the
                       write lands before Angular has inserted the options and is silently
                       dropped. Per-option [selected], driven by a plain (change) handler. -->
                  <select id="rateRole" (change)="onRateRoleChange($event)" class="command-select">
                    <option value="" [selected]="rateRole() === ''">Select a role...</option>
                    @for (role of roleOptions(); track role) {
                      <option [value]="role" [selected]="role === rateRole()">{{ role }}</option>
                    }
                  </select>
                </div>
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="rateCurrency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                    <select id="rateCurrency" (change)="onRateCurrencyChange($event)" class="command-select">
                      @for (code of rateCurrencyOptions(); track code) {
                        <option [value]="code" [selected]="code === rateCurrency()">{{ code }}</option>
                      }
                    </select>
                  </div>
                  <div>
                    <label for="rateBillRate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Bill rate (€/day) *</label>
                    <input id="rateBillRate" type="number" min="0" step="1" [value]="rateBillRate()" (input)="onRateBillRateChange($event)" class="command-input" placeholder="e.g. 1000">
                  </div>
                </div>
                @if (rateError(); as err) {
                  <p role="alert" data-test="negotiated-rate-error" class="text-xs text-critical-text">{{ err }}</p>
                }
              </div>
              <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
                <button type="button" (click)="closeRateForm()" class="command-button secondary">Cancel</button>
                <button type="button" (click)="saveRate(c)" [disabled]="!rateFormValid()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  Save Rate
                </button>
              </div>
            </div>
          </div>
        }

        <!-- Billing expected vs actual -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Billing expected vs actual</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Expected recurrence from billing plan compared with Customer Orders in Invoiced/Paid status.</p>
            </div>
            <button type="button" (click)="openBillingPlanForm(c)" class="command-button">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon>
              Expected Billing
            </button>
          </div>

          @if (moneyFiguresState() === 'error') {
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted" role="alert">
              <p class="font-semibold text-[var(--cc-ink)]">Limited data — billing control amounts are unavailable.</p>
              <p class="mt-1 text-sm">A read these amounts are derived from failed; no figure is shown rather than a zero.</p>
              <button type="button" class="command-button mt-3" (click)="reloadMoneyData()">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
              </button>
            </div>
          } @else if (moneyFiguresState() === 'loading') {
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4" aria-busy="true" aria-label="Loading billing control amounts">
              @for (tile of [1, 2, 3]; track tile) {
                <div class="command-skeleton h-24"></div>
              }
            </div>
          } @else {
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4">
            <div class="command-kpi info">
              <p class="command-kpi-label">Expected To Date</p>
              <p class="command-kpi-value">{{ expectedBillingToDate() | currency: BASE_CURRENCY }}</p>
            </div>
            <div class="command-kpi green">
              <p class="command-kpi-label">Actual To Date</p>
              <p class="command-kpi-value">{{ actualBillingToDate() | currency: BASE_CURRENCY }}</p>
            </div>
            <div class="command-kpi" [class.danger]="billingVarianceToDate() < 0" [class.green]="billingVarianceToDate() >= 0">
              <p class="command-kpi-label">Variance</p>
              <p class="command-kpi-value">{{ billingVarianceToDate() | currency: BASE_CURRENCY }}</p>
            </div>
          </div>
          }

          <!-- The per-period rows are the same money as the strip above, so they
               share its gate: under a failed read this table printed
               Expected 0.00 / Variance = Actual for every period. -->
          @if (moneyFiguresState() === 'ready') {
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Project</th>
                  <th class="text-right">Expected</th>
                  <th class="text-right">Actual</th>
                  <th class="text-right">Variance</th>
                  <th>Status</th>
                  <th>Trace</th>
                </tr>
              </thead>
              <tbody>
                @for (row of billingRows(); track row.period + row.projectId) {
                  <tr>
                    <td class="font-mono font-semibold">{{ row.period }}</td>
                    <td>{{ row.projectName }}</td>
                    <td class="text-right font-mono">{{ row.expected | currency: BASE_CURRENCY }}</td>
                    <td class="text-right font-mono">{{ row.actual | currency: BASE_CURRENCY }}</td>
                    <td class="text-right font-mono font-semibold" [class.text-critical-text]="row.variance < 0" [class.text-positive-text]="row.variance >= 0">
                      {{ row.variance | currency: BASE_CURRENCY }}
                    </td>
                    <td>
                      <span class="command-status"
                            [class.green]="row.status === 'Covered'"
                            [class.amber]="row.status === 'Partial' || row.status === 'Planned'"
                            [class.red]="row.status === 'Behind'">
                        {{ row.status }}
                      </span>
                    </td>
                    <td class="text-[var(--cc-muted)]">
                      <div>{{ row.expectedLabels || 'No expected plan' }}</div>
                      <div class="mt-1 text-xs">{{ row.actualSources || 'No actual invoice' }}</div>
                    </td>
                  </tr>
                }
                @if (!billingRows().length) {
                  <tr>
                    <td colspan="7" class="px-6 sm:px-8 py-10 text-center text-ink-muted">
                      No billing plan or actual invoices for this contract.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          }
        </div>

        <!-- Billing -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Billing</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Billing plan items for this contract across the invoicing lifecycle.</p>
            </div>
          </div>

          @if (moneyFiguresState() === 'error') {
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted" role="alert">
              <p class="font-semibold text-[var(--cc-ink)]">Limited data — billing plan amounts are unavailable.</p>
              <p class="mt-1 text-sm">A read these amounts are derived from failed; no figure is shown rather than a zero.</p>
              <button type="button" class="command-button mt-3" (click)="reloadMoneyData()">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
              </button>
            </div>
          } @else if (moneyFiguresState() === 'loading') {
            <div class="grid grid-cols-1 sm:grid-cols-5 gap-4 p-4" aria-busy="true" aria-label="Loading billing plan amounts">
              @for (tile of [1, 2, 3, 4, 5]; track tile) {
                <div class="command-skeleton h-24"></div>
              }
            </div>
          } @else {
          <div class="grid grid-cols-2 lg:grid-cols-5 gap-4 p-4">
            <div class="command-kpi info">
              <p class="command-kpi-label">Planned</p>
              <p class="command-kpi-value">{{ billingKpis().planned | currency: BASE_CURRENCY }}</p>
            </div>
            <div class="command-kpi warning">
              <p class="command-kpi-label">Ready</p>
              <p class="command-kpi-value">{{ billingKpis().ready | currency: BASE_CURRENCY }}</p>
            </div>
            <div class="command-kpi">
              <p class="command-kpi-label">Invoiced</p>
              <p class="command-kpi-value">{{ billingKpis().invoiced | currency: BASE_CURRENCY }}</p>
            </div>
            <div class="command-kpi green">
              <p class="command-kpi-label">Paid</p>
              <p class="command-kpi-value">{{ billingKpis().paid | currency: BASE_CURRENCY }}</p>
            </div>
            <div class="command-kpi danger">
              <p class="command-kpi-label">Retention Held</p>
              <p class="command-kpi-value">{{ billingKpis().retentionHeld | currency: BASE_CURRENCY }}</p>
            </div>
          </div>
          }

          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Label</th>
                  <th>Trigger</th>
                  <th class="text-right">Amount</th>
                  <th>Status</th>
                  <th>Due</th>
                </tr>
              </thead>
              <tbody>
                @for (item of contractBillingPlan(); track item.id) {
                  <tr>
                    <td>
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-surface-muted text-ink-secondary font-mono">
                        {{ item.type }}
                      </span>
                    </td>
                    <td class="text-ink-secondary">{{ item.label }}</td>
                    <td class="text-[var(--cc-muted)]">{{ billingTrigger(item) }}</td>
                    <td class="text-right font-mono tabular-nums"
                        [class.text-critical-text]="item.amount < 0"
                        [class.text-ink-secondary]="item.amount >= 0">
                      {{ item.amount | currency: item.currency }}
                    </td>
                    <td>
                      <span class="command-status"
                            [class.green]="item.status === 'Paid' || item.status === 'Invoiced'"
                            [class.amber]="item.status === 'Planned' || item.status === 'Ready'"
                            [class.red]="item.status === 'Blocked'">
                        {{ item.status }}
                      </span>
                    </td>
                    <td class="font-mono text-ink-secondary">{{ (item.dueDate ?? item.expectedDate) ? ((item.dueDate ?? item.expectedDate) | date: 'mediumDate') : '—' }}</td>
                  </tr>
                }
                @if (!contractBillingPlan().length) {
                  <tr>
                    <td colspan="6" class="px-6 sm:px-8 py-10 text-center text-ink-muted">
                      @if (moneyFiguresState() === 'error') {
                        <!-- "None" is a FACT. Under a failed read it is not one, and
                             printing it under the Limited-data banner above states
                             as fact the very thing the banner says is unknown. -->
                        <span>Unavailable — a read this list depends on failed.</span>
                      } @else if (moneyFiguresState() === 'loading') {
                        <span>Loading…</span>
                      } @else {
                        No billing plan items for this contract.
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Revenue Recognition Schedule -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Revenue Recognition Schedule</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">
                Dated recognition (ASC&nbsp;606 / IFRS&nbsp;15, simplified) across this contract's projects — POC for fixed price,
                straight-line for recurring, as-incurred for T&amp;M, advances deferred until earned.
              </p>
            </div>
          </div>

          <!--
            GATE (round 3): every read the as-incurred branch needs (contracts,
            projects, negotiatedRates, resources, timeEntries, billingItems) must
            have resolved before this money figure renders — see
            recognitionDataReady()'s doc comment. Never render a partial-envelope
            figure: $0/loading reads honest, a plausible-but-wrong number does not.
          -->
          @if (recognitionDataReady()) {
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4">
              <div class="command-kpi green">
                <p class="command-kpi-label">Recognized To Date</p>
                <p class="command-kpi-value">{{ recognitionSummary().cumulative | currency: BASE_CURRENCY }}</p>
              </div>
              <div class="command-kpi info">
                <p class="command-kpi-label">Total Recognized</p>
                <p class="command-kpi-value">{{ recognitionSummary().totalRecognized | currency: BASE_CURRENCY }}</p>
              </div>
              <div class="command-kpi" [class.warning]="recognitionSummary().deferred > 0">
                <p class="command-kpi-label">Deferred (Advance)</p>
                <p class="command-kpi-value">{{ recognitionSummary().deferred | currency: BASE_CURRENCY }}</p>
              </div>
            </div>

            @if (recognitionPeriods().length) {
              <!-- Cumulative recognition trend -->
              <div class="px-4 pb-2">
                <p class="command-section-label">Cumulative recognition</p>
                <div class="mt-3 space-y-2">
                  @for (row of recognitionPeriods(); track row.period) {
                    <div class="flex items-center gap-3">
                      <span class="w-16 shrink-0 font-mono tabular-nums text-xs text-ink-muted">{{ row.period }}</span>
                      <div class="relative h-6 flex-1 rounded-md bg-surface-muted ring-1 ring-line overflow-hidden">
                        <div class="absolute inset-y-0 left-0 rounded-md bg-accent transition-[width]"
                             [style.width.%]="cumulativeBarPct(row)"
                             [attr.aria-label]="'Cumulative recognized through ' + row.period"
                             role="img"></div>
                        <!-- per-period recognized marker -->
                        <div class="absolute inset-y-0 left-0 border-r-2 border-accent-strong/40"
                             [style.width.%]="recognizedBarPct(row)"></div>
                      </div>
                      <span class="w-28 shrink-0 text-right font-mono tabular-nums text-xs text-ink-secondary">
                        {{ row.cumulative | currency: BASE_CURRENCY: 'symbol': '1.0-0' }}
                      </span>
                    </div>
                  }
                </div>
                <p class="command-note mt-3">
                  Bars show cumulative revenue recognized through each month; the darker edge marks that month's incremental recognition.
                </p>
              </div>

              <!-- Period detail table -->
              <div class="overflow-x-auto">
                <table class="command-data-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th class="text-right">Recognized</th>
                      <th class="text-right">Cumulative</th>
                      <th class="text-right">Deferred</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of recognitionPeriods(); track row.period) {
                      <tr>
                        <td class="font-mono font-semibold">{{ row.period }}</td>
                        <td class="text-right font-mono tabular-nums"
                            [class.text-critical-text]="row.recognized < 0"
                            [class.text-ink-secondary]="row.recognized >= 0">
                          {{ row.recognized | currency: BASE_CURRENCY }}
                        </td>
                        <td class="text-right font-mono tabular-nums text-ink-secondary">{{ row.cumulative | currency: BASE_CURRENCY }}</td>
                        <td class="text-right font-mono tabular-nums"
                            [class.text-caution-text]="row.deferred > 0"
                            [class.text-ink-muted]="row.deferred === 0">
                          {{ row.deferred | currency: BASE_CURRENCY }}
                        </td>
                      </tr>
                    }
                  </tbody>
                  <tfoot>
                    <tr class="border-t-2 border-line">
                      <td class="font-semibold text-ink-secondary">Total</td>
                      <td class="text-right font-mono tabular-nums font-semibold text-ink">{{ recognitionSummary().totalRecognized | currency: BASE_CURRENCY }}</td>
                      <td class="text-right font-mono tabular-nums font-semibold text-ink">{{ recognitionSummary().cumulative | currency: BASE_CURRENCY }}</td>
                      <td class="text-right font-mono tabular-nums font-semibold text-ink">{{ recognitionSummary().deferred | currency: BASE_CURRENCY }}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            } @else {
              <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted">
                No dated billing items or approved time entries to build a recognition schedule for this contract.
              </div>
            }
          } @else if (recognitionDataError()) {
            <!-- An errored read is NOT a slow read: saying "Loading…" forever is a
                 lie the user cannot act on, and rendering the figure anyway would
                 print a wrong number. Say what happened and offer the retry. -->
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted">
              <p>Recognition figures are unavailable — one of the reads they are derived from failed.</p>
              <button type="button" class="command-button mt-3" (click)="reloadRecognitionData()">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
              </button>
            </div>
          } @else {
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted">
              Loading recognition data…
            </div>
          }
        </div>

        <!-- Journal Preview (#10) -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Journal Preview</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">
                Per-period double-entry postings derived from the recognition schedule above — preview before posting.
                Revenue earned is <span class="font-semibold">Dr Unbilled AR / Cr Revenue</span>; advances are
                <span class="font-semibold">Dr Cash / Cr Deferred Revenue</span> and amortise as work is earned.
                Every entry is balanced by construction.
              </p>
            </div>
            @if (recognitionDataReady()) {
              <span class="command-status shrink-0"
                    [class.green]="journalTotalsRow().balanced"
                    [class.red]="!journalTotalsRow().balanced">
                <mat-icon class="text-[16px] w-[16px] h-[16px]">
                  {{ journalTotalsRow().balanced ? 'check_circle' : 'error' }}
                </mat-icon>
                {{ journalTotalsRow().balanced ? 'Balanced' : 'Out of balance' }}
              </span>
            }
          </div>

          <!-- Same GATE as the recognition schedule above: journalEntries() is
               derived from the same partial-envelope-sensitive data(). -->
          @if (recognitionDataReady()) {
            @if (journalEntries().length) {
              <div class="overflow-x-auto">
                <table class="command-data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Memo</th>
                      <th>Account</th>
                      <th class="text-right">Debit</th>
                      <th class="text-right">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (entry of journalEntries(); track entry.date) {
                      @for (line of entry.lines; track $index; let first = $first) {
                        <tr [class.border-t-2]="first" [class.border-line]="first">
                          <td class="font-mono font-semibold align-top">{{ first ? entry.date : '' }}</td>
                          <td class="text-[var(--cc-muted)] align-top">{{ first ? entry.memo : '' }}</td>
                          <td class="text-ink-secondary">{{ line.account }}</td>
                          <td class="text-right font-mono tabular-nums"
                              [class.text-ink-secondary]="line.debit > 0"
                              [class.text-ink-muted]="line.debit === 0">
                            {{ line.debit > 0 ? (line.debit | currency: BASE_CURRENCY) : '—' }}
                          </td>
                          <td class="text-right font-mono tabular-nums"
                              [class.text-ink-secondary]="line.credit > 0"
                              [class.text-ink-muted]="line.credit === 0">
                            {{ line.credit > 0 ? (line.credit | currency: BASE_CURRENCY) : '—' }}
                          </td>
                        </tr>
                      }
                    }
                  </tbody>
                  <tfoot>
                    <tr class="border-t-2 border-line-strong">
                      <td class="font-semibold text-ink-secondary" colspan="3">Totals</td>
                      <td class="text-right font-mono tabular-nums font-semibold text-ink">{{ journalTotalsRow().debit | currency: BASE_CURRENCY }}</td>
                      <td class="text-right font-mono tabular-nums font-semibold text-ink">{{ journalTotalsRow().credit | currency: BASE_CURRENCY }}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p class="command-note px-4 py-3">
                Σ Debit {{ journalTotalsRow().debit | currency: BASE_CURRENCY }} = Σ Credit {{ journalTotalsRow().credit | currency: BASE_CURRENCY }}.
                These entries are a preview and have not been posted to the ledger.
              </p>
            } @else {
              <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted">
                No journal movement to preview — there is nothing recognized or deferred for this contract yet.
              </div>
            }
          } @else if (recognitionDataError()) {
            <!-- An errored read is NOT a slow read: saying "Loading…" forever is a
                 lie the user cannot act on, and rendering the figure anyway would
                 print a wrong number. Say what happened and offer the retry. -->
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted">
              <p>Recognition figures are unavailable — one of the reads they are derived from failed.</p>
              <button type="button" class="command-button mt-3" (click)="reloadRecognitionData()">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
              </button>
            </div>
          } @else {
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-ink-muted">
              Loading recognition data…
            </div>
          }
        </div>

        <!-- Orders -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Orders</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th class="text-right">Amount</th>
                  <th>Status</th>
                  <th>Order Date</th>
                </tr>
              </thead>
              <tbody>
                @for (o of contractOrders(); track o.id) {
                  <tr>
                    <td class="font-medium">{{ o.type }}</td>
                    <td class="text-right text-ink-secondary font-mono tabular-nums">{{ o.amount | currency: o.currency }}</td>
                    <td>
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold tracking-wide ring-1"
                            [class.bg-surface-muted]="o.status === 'Open'"
                            [class.text-ink-secondary]="o.status === 'Open'"
                            [class.ring-line]="o.status === 'Open'"
                            [class.bg-accent-tint]="o.status === 'Confirmed'"
                            [class.text-accent-text]="o.status === 'Confirmed'"
                            [class.ring-accent]="o.status === 'Confirmed'"
                            [class.bg-caution-tint]="o.status === 'Invoiced'"
                            [class.text-caution-text]="o.status === 'Invoiced'"
                            [class.ring-caution]="o.status === 'Invoiced'"
                            [class.bg-positive-tint]="o.status === 'Paid'"
                            [class.text-positive-text]="o.status === 'Paid'"
                            [class.ring-positive]="o.status === 'Paid'">
                        {{ o.status }}
                      </span>
                    </td>
                    <td class="text-ink-secondary">{{ o.orderDate | date: 'mediumDate' }}</td>
                  </tr>
                }
                @if (!contractOrders().length) {
                  <tr>
                    <td colspan="4" class="px-6 sm:px-8 py-10 text-center text-ink-muted">
                      @if (moneyFiguresState() === 'error') {
                        <!-- "None" is a FACT. Under a failed read it is not one, and
                             printing it under the Limited-data banner above states
                             as fact the very thing the banner says is unknown. -->
                        <span>Unavailable — a read this list depends on failed.</span>
                      } @else if (moneyFiguresState() === 'loading') {
                        <span>Loading…</span>
                      } @else {
                        No orders for this contract.
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        @if (showBillingPlanForm()) {
          <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
               appModal ariaLabelledby="billingPlanModalTitle" (dismiss)="closeBillingPlanForm()">
            <div class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div class="command-card-header">
                <h2 id="billingPlanModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Expected Billing</h2>
                <button type="button" (click)="closeBillingPlanForm()" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors" aria-label="Close">
                  <mat-icon>close</mat-icon>
                </button>
              </div>

              <div class="p-6 sm:p-8 overflow-y-auto flex-1">
                <form [formGroup]="billingPlanForm" (ngSubmit)="saveBillingPlanItem(c)" class="space-y-6">
                  <div>
                    <label for="billingLabel" class="block text-sm font-semibold text-ink-secondary mb-1.5">Label *</label>
                    <input id="billingLabel" type="text" formControlName="label" class="command-input" placeholder="e.g. Monthly T&M billing">
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div>
                      <label for="billingProject" class="block text-sm font-semibold text-ink-secondary mb-1.5">Project</label>
                      <select id="billingProject" formControlName="projectId" (change)="onBillingProjectChange()" class="command-select">
                        <option value="">Contract level</option>
                        @for (project of contractProjects(); track project.id) {
                          <option [value]="project.id">{{ project.name }}</option>
                        }
                      </select>
                    </div>

                    @if (c.type === 'T&M') {
                      <div>
                        <label for="billingRecurrence" class="block text-sm font-semibold text-ink-secondary mb-1.5">Recurrence *</label>
                        <select id="billingRecurrence" formControlName="recurrence" class="command-select">
                          @for (recurrence of recurrences; track recurrence) {
                            <option [value]="recurrence">{{ recurrence }}</option>
                          }
                        </select>
                      </div>
                    } @else {
                      <div>
                        <label for="billingMilestone" class="block text-sm font-semibold text-ink-secondary mb-1.5">Milestone *</label>
                        <select id="billingMilestone" formControlName="milestoneId" class="command-select">
                          <option value="">Select a milestone...</option>
                          @for (milestone of billingMilestoneOptions(); track milestone.id) {
                            <option [value]="milestone.id">{{ milestone.name }}</option>
                          }
                        </select>
                      </div>
                    }

                    <div>
                      <label for="billingExpectedDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Expected Date *</label>
                      <input id="billingExpectedDate" type="date" formControlName="expectedDate" class="command-input">
                    </div>

                    <div>
                      <label for="billingAmount" class="block text-sm font-semibold text-ink-secondary mb-1.5">Amount *</label>
                      <input id="billingAmount" type="number" formControlName="amount" class="command-input" placeholder="0">
                    </div>

                    <div>
                      <label for="billingCurrency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                      <select id="billingCurrency" formControlName="currency" class="command-select">
                        @for (option of currencyOptions(); track option.code) {
                          <option [value]="option.code" [disabled]="option.orphan">{{ option.label }}</option>
                        }
                      </select>
                    </div>

                    <div>
                      <label for="billingStatus" class="block text-sm font-semibold text-ink-secondary mb-1.5">Status *</label>
                      <select id="billingStatus" formControlName="status" class="command-select">
                        <option value="Planned">Planned</option>
                        <option value="Ready">Ready</option>
                        <option value="Blocked">Blocked</option>
                      </select>
                    </div>
                  </div>
                </form>
              </div>

              <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
                <button type="button" (click)="closeBillingPlanForm()" class="command-button secondary">Cancel</button>
                <button type="button" (click)="saveBillingPlanItem(c)" [disabled]="billingPlanForm.invalid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  Save Expected Billing
                </button>
              </div>
            </div>
          </div>
        }
      } @else {
        <div class="command-card-muted p-12 text-center">
          <div class="w-20 h-20 bg-surface shadow-sm ring-1 ring-line rounded-full flex items-center justify-center mx-auto mb-4">
            <mat-icon class="text-ink-muted text-4xl">description</mat-icon>
          </div>
          <h3 class="font-display text-xl font-bold text-[var(--cc-ink)] mb-2">Contract not found</h3>
          <p class="text-[var(--cc-muted)]">The contract you are looking for is unavailable or still loading.</p>
        </div>
      }
    </div>
  `,
})
export class ContractDetails {
  private api = inject(ApiService);
  private notification = inject(NotificationService);
  private auth = inject(AuthService);

  /** Exposed for the template's "not applied" check — sellRateFor only ever reads a BASE_CURRENCY row. */
  readonly BASE_CURRENCY = BASE_CURRENCY;

  id = input.required<string>();

  // Principal-gated reads (contracts, customers, orders, order-lines, resources,
  // project-financials, time-entries, billing-plan-items) 401 until the OAuth
  // bootstrap restores the bearer token. On reload the OIDC token restores async,
  // so firing immediately 401s and the rxResource latches its error/empty state
  // forever. Keying each on auth.authReady() defers the request until the token
  // is attached; when authReady flips false->true the params change re-runs the
  // stream. EVERY read on this screen is principal-gated: since the server made
  // GETs deny-by-default, an ungated field-init read 401s with no bearer and, with
  // no params, never re-fires. The ones that need only readiness go through
  // authGatedResource().
  private contractsRes = rxResource<Contract[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getContracts() : of<Contract[]>([])),
    defaultValue: [] as Contract[],
  });
  private customersRes = rxResource<Customer[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getCustomers() : of<Customer[]>([])),
    defaultValue: [] as Customer[],
  });
  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  private ordersRes = rxResource<Order[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getOrders() : of<Order[]>([])),
    defaultValue: [] as Order[],
  });
  private orderLinesRes = rxResource<OrderLine[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getOrderLines() : of<OrderLine[]>([])),
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
  private billingPlanRes = rxResource<BillingPlanItem[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getBillingPlanItems() : of<BillingPlanItem[]>([])),
    defaultValue: [] as BillingPlanItem[],
  });
  // Negotiated sell rates (design spec §4/§6) feed the as-incurred T&M branch of
  // recognitionSchedule via sellRateFor (see `data` below). /negotiated-rates is
  // principal-gated server-side the same way contracts/customers/orders are, so
  // this follows THAT gated idiom (keyed on auth.authReady()).
  private negotiatedRatesRes = rxResource<NegotiatedRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getNegotiatedRates() : of<NegotiatedRate[]>([])),
    defaultValue: [] as NegotiatedRate[],
  });
  // The org's working hours/day — the EUR/DAY -> EUR/HOUR divisor sellRateFor
  // needs to price a negotiated rate (see FinanceData.hoursPerDay). Principal-gated
  // like every other read here, AND included in recognitionDataReady() below in
  // both its loading and its error form, because a money figure must never
  // render from a partial envelope — pricing 8 hours with the wrong divisor is a
  // believable wrong number, which is worse than a loading state.
  private hoursPerDayRes = authGatedResource(() => this.api.getHoursPerDay(), { value: DEFAULT_HOURS_PER_DAY });
  // Role options for the rate form come from the project-roles CATALOG — the same
  // authority the server validates against (see roleOptions below).
  private rolesRes = authGatedResource(() => this.api.getProjectRoles(), [] as ProjectRole[]);
  private milestonesRes = authGatedResource(() => this.api.getMilestones(), [] as Milestone[]);
  // REFERENCE-DATA INTEGRITY (Phase B): `currency` is a config-value FK to the
  // configured currency set (fx-rates). Gated on authReady() with the other
  // principal-gated reads.
  private fxRatesRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getFxRates() : of<FxRate[]>([])),
    defaultValue: [] as FxRate[],
  });

  // NEVER dereference rxResource.value() in an error state: it throws
  // ResourceValueError, which aborts the whole template — so ONE failed read
  // takes the entire contract page down, including the panels that would have
  // explained the failure. The money figures are separately suppressed by
  // recognitionDataReady() below; these accessors only keep the page renderable.
  // Same rule, same treatment as billing.ts:822-832.
  contracts = computed(() => this.contractsRes.status() === 'error' ? [] : this.contractsRes.value());
  customers = computed(() => this.customersRes.status() === 'error' ? [] : this.customersRes.value());
  projects = computed(() => this.projectsRes.status() === 'error' ? [] : this.projectsRes.value());
  orders = computed(() => this.ordersRes.status() === 'error' ? [] : this.ordersRes.value());
  orderLines = computed(() => this.orderLinesRes.status() === 'error' ? [] : this.orderLinesRes.value());
  requests = computed(() => this.requestsRes.status() === 'error' ? [] : this.requestsRes.value());
  assignments = computed(() => this.assignmentsRes.status() === 'error' ? [] : this.assignmentsRes.value());
  resources = computed(() => this.resourcesRes.status() === 'error' ? [] : this.resourcesRes.value());
  financials = computed(() => this.financialsRes.status() === 'error' ? [] : this.financialsRes.value());
  timeEntries = computed(() => this.timeEntriesRes.status() === 'error' ? [] : this.timeEntriesRes.value());
  billingPlanItems = computed(() => this.billingPlanRes.status() === 'error' ? [] : this.billingPlanRes.value());
  milestones = computed(() => this.milestonesRes.status() === 'error' ? [] : this.milestonesRes.value());
  fxRates = computed(() => this.fxRatesRes.status() === 'error' ? [] : this.fxRatesRes.value());
  negotiatedRates = computed(() => this.negotiatedRatesRes.status() === 'error' ? [] : this.negotiatedRatesRes.value());
  private hoursPerDay = computed(() => this.hoursPerDayRes.status() === 'error'
    ? DEFAULT_HOURS_PER_DAY
    : this.hoursPerDayRes.value().value);

  /** Canonical recurrence enum (matches BillingPlanItem['recurrence'] and billing's RECURRENCES). */
  readonly recurrences: readonly NonNullable<BillingPlanItem['recurrence']>[] = ['Monthly', 'Quarterly', 'Annual'];

  showBillingPlanForm = signal(false);

  billingPlanForm = new FormGroup({
    projectId: new FormControl('', { nonNullable: true }),
    label: new FormControl('', { nonNullable: true, validators: Validators.required }),
    expectedDate: new FormControl('', { nonNullable: true, validators: Validators.required }),
    amount: new FormControl<number | null>(null, { validators: Validators.required }),
    currency: new FormControl(BASE_CURRENCY, { nonNullable: true, validators: Validators.required }),
    recurrence: new FormControl<BillingPlanItem['recurrence']>('Monthly', { nonNullable: true, validators: Validators.required }),
    milestoneId: new FormControl('', { nonNullable: true }),
    status: new FormControl<BillingPlanItem['status']>('Planned', { nonNullable: true, validators: Validators.required }),
  });

  private billingProjectValue = toSignal(this.billingPlanForm.controls.projectId.valueChanges, {
    initialValue: this.billingPlanForm.controls.projectId.value,
  });
  billingMilestoneOptions = computed(() => {
    const projectId = this.billingProjectValue();
    const contractProjectIds = new Set(this.contractProjects().map(project => project.id));
    return this.milestones().filter(milestone => contractProjectIds.has(milestone.projectId)
      && (!projectId || milestone.projectId === projectId));
  });

  // --- currency options (Phase B) ---
  private currencyValue = toSignal(this.billingPlanForm.controls.currency.valueChanges, {
    initialValue: this.billingPlanForm.controls.currency.value,
  });

  /**
   * Currency options for the SELECT: configured currency codes from fx-rates
   * (label = value = code). When creating an expected-billing item the currency
   * defaults to the parent contract's currency (set in openBillingPlanForm). An
   * orphan value (not in the configured set) is injected as a disabled
   * "<code> (not configured)" option so it is never silently dropped.
   */
  currencyOptions = computed(() => {
    const codes = this.fxRates().map(r => r.currency);
    const options = codes.map(code => ({ code, label: code, orphan: false }));
    const current = this.currencyValue();
    if (current && !codes.includes(current)) {
      options.push({ code: current, label: `${current} (not configured)`, orphan: true });
    }
    return options;
  });

  contract = computed<Contract | undefined>(() => this.contracts().find(c => c.id === this.id()));

  customerName = computed(() => {
    const c = this.contract();
    if (!c) return '';
    return this.customers().find(cust => cust.id === c.customerId)?.name ?? 'Unknown customer';
  });

  private data = computed<FinanceData>(() => ({
    requests: this.requests(),
    assignments: this.assignments(),
    resources: this.resources(),
    orders: this.orders(),
    orderLines: this.orderLines(),
    financials: this.financials(),
    timeEntries: this.timeEntries(),
    billingItems: this.billingPlanItems(),
    milestones: this.milestones(),
    // `projects`/`contracts` were already loaded (contractProjects/contractOrders
    // below use them) but not previously fed into FinanceData. Both are REQUIRED
    // for sellRateFor's project-override / contract-period precedence (design
    // spec §4/§6) to resolve correctly, not merely to carry `negotiatedRates`:
    // without `contracts` here, a project's own contract can never be found and
    // every negotiated rate silently falls back to the reference billRate.
    projects: this.projects(),
    contracts: this.contracts(),
    negotiatedRates: this.negotiatedRates(),
    hoursPerDay: this.hoursPerDay(),
    // MF-02. /fx-rates was already read (it drives the currency picker) but was
    // NOT in this envelope, and with `d.fxRates === undefined` convertToBase is
    // documented to be an exact identity — so every figure below summed raw face
    // values across currencies. On seeded CT2 (USD) 'Total Recognised' printed
    // 12000 USD + 1150 EUR as one number: an amount in no currency at all.
    // Supplying the table normalises each amount to BASE_CURRENCY, which is why
    // every derived tile in the template is labelled BASE_CURRENCY and not
    // `c.currency` — the pair is one change, not two. Only single-item facts
    // (`c.totalValue`, an order's `amount`, a billing item's `amount`) stay on
    // their own currency, because those numbers really are denominated in it.
    fxRates: this.fxRates(),
  }));

  contractProjects = computed(() => this.projects().filter(p => p.contractId === this.id()));

  contractOrders = computed(() => this.orders().filter(o => o.contractId === this.id()));

  // --- Negotiated Rates (design spec §7) --------------------------------

  contractNegotiatedRates = computed(() => this.negotiatedRates().filter(r => r.contractId === this.id()));

  /**
   * Role options for the rate form's select: the project-roles CATALOG, which is
   * the SAME authority the server validates a rate's role against
   * (validateRoleRefs, src/server.ts) — widened to the catalog this wave so a
   * price can be negotiated BEFORE anyone with that profile is hired, the
   * workflow docs/functional/commercial.md now describes. Sourced from the
   * staffed roles (`resources.map(r => r.role)`) this picker could not offer an
   * unstaffed profile at all, making that workflow reachable only by hand-posting
   * to the API. Stored value is the catalog NAME.
   */
  roleOptions = computed<string[]>(() => [...new Set(this.rolesRes.value().map(r => r.name))].sort());

  /** Negotiated rates are stored in the reporting base currency only. */
  rateCurrencyOptions = computed<string[]>(() => [BASE_CURRENCY]);

  showRateForm = signal(false);
  editingRateId = signal<string | null>(null);
  rateRole = signal('');
  rateCurrency = signal(BASE_CURRENCY);
  rateBillRate = signal<number | null>(null);
  rateError = signal<string | null>(null);

  rateFormValid = computed(() => !!this.rateRole()
    && this.rateCurrency() === BASE_CURRENCY
    && this.rateBillRate() !== null
    && Number.isFinite(this.rateBillRate())
    && this.rateBillRate()! >= 0);

  onRateRoleChange(event: Event): void {
    this.rateRole.set((event.target as HTMLSelectElement).value);
  }

  onRateCurrencyChange(event: Event): void {
    this.rateCurrency.set((event.target as HTMLSelectElement).value);
  }

  onRateBillRateChange(event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.rateBillRate.set(raw === '' ? null : Number(raw));
  }

  openRateForm(existing?: NegotiatedRate): void {
    this.rateError.set(null);
    if (existing) {
      this.editingRateId.set(existing.id);
      this.rateRole.set(existing.role);
      // Legacy non-base rows were accepted but are never consumed by sellRateFor.
      // Keep the STORED currency rather than rewriting it to EUR on open: the
      // amount is denominated in that currency, so silently relabelling 950 USD
      // as 950 EUR would change the negotiated price by the FX spread without
      // anyone deciding to. `rateFormValid` refuses to save it and the message
      // below says what to do instead.
      this.rateCurrency.set(existing.currency);
      this.rateBillRate.set(existing.billRate);
      if (existing.currency !== BASE_CURRENCY) {
        this.rateError.set(
          `This rate is stored in ${existing.currency}, which no invoice ever prices at `
          + `(sellRateFor reads ${BASE_CURRENCY} only). Delete it and add the agreed `
          + `${BASE_CURRENCY} figure — re-labelling the same number would change the price.`,
        );
      }
    } else {
      this.editingRateId.set(null);
      this.rateRole.set('');
      this.rateCurrency.set(BASE_CURRENCY);
      this.rateBillRate.set(null);
    }
    this.showRateForm.set(true);
  }

  closeRateForm(): void {
    this.showRateForm.set(false);
    this.editingRateId.set(null);
    this.rateError.set(null);
  }

  saveRate(contract: Contract): void {
    if (!this.rateFormValid()) return;
    // contractId ONLY — projectId is never sent from this surface (spec §3's xor).
    const payload: Partial<NegotiatedRate> = {
      contractId: contract.id,
      role: this.rateRole(),
      currency: this.rateCurrency(),
      billRate: this.rateBillRate() ?? 0,
    };
    const id = this.editingRateId();
    const done = () => {
      this.negotiatedRatesRes.reload();
      this.notification.show('Negotiated rate saved', 'success');
      this.closeRateForm();
    };
    // Surface the server's own refusal text (400s from validateNegotiatedRate,
    // src/server.ts) INLINE, and do NOT close the form — the coordinator's
    // requirement, not just the generic toast the error interceptor also fires.
    const fail = (e: unknown) => {
      this.rateError.set((e as { error?: { error?: string } })?.error?.error ?? 'Could not save the negotiated rate.');
    };
    if (id) {
      this.api.updateNegotiatedRate(id, payload).subscribe({ next: done, error: fail });
    } else {
      this.api.createNegotiatedRate(payload).subscribe({ next: done, error: fail });
    }
  }

  deleteRate(rate: NegotiatedRate): void {
    this.api.deleteNegotiatedRate(rate.id).subscribe(() => {
      this.negotiatedRatesRes.reload();
      this.notification.show('Negotiated rate deleted', 'success');
    });
  }

  contractBillingPlan = computed(() =>
    this.billingPlanItems()
      .filter(i => i.contractId === this.id())
      .sort((a, b) => (a.expectedDate ?? '').localeCompare(b.expectedDate ?? '')),
  );

  /**
   * MF-02. `amount` here is in BASE_CURRENCY, because it is only ever SUMMED —
   * into the Actual/Variance tiles and the per-period rows, all of which are
   * labelled BASE_CURRENCY. An order line carries no currency of its own, so the
   * parent order's currency is the denomination (same rule as finance.util's
   * lineSum). With an empty/absent rate table convertToBase is an identity, so a
   * single-currency contract reads exactly as it did before.
   */
  private actualBillingEvents = computed<BillingActualEvent[]>(() => {
    const rates = this.fxRates();
    const actualOrders = this.contractOrders().filter(o => o.type === 'Customer' && (o.status === 'Invoiced' || o.status === 'Paid'));
    return actualOrders.flatMap(order => {
      const lines = this.orderLines().filter(line => line.orderId === order.id);
      if (!lines.length) {
        return [{
          period: this.periodKey(order.orderDate),
          projectId: '',
          amount: convertToBase(order.amount, order.currency, rates),
          orderId: order.id,
          status: order.status,
        }];
      }
      return lines.map(line => ({
        period: this.periodKey(order.orderDate),
        projectId: line.projectId,
        amount: convertToBase(line.amount, order.currency, rates),
        orderId: order.id,
        status: order.status,
      }));
    });
  });

  billingRows = computed<BillingControlRow[]>(() => {
    const rows = new Map<string, BillingControlRow>();
    const ensure = (period: string, projectId: string) => {
      const key = `${period}|${projectId}`;
      const row = rows.get(key);
      if (row) return row;
      const created: BillingControlRow = {
        period,
        projectId,
        projectName: this.projectName(projectId),
        expected: 0,
        actual: 0,
        variance: 0,
        status: 'Planned',
        expectedLabels: '',
        actualSources: '',
      };
      rows.set(key, created);
      return created;
    };

    // Expected is summed across items that may each carry their own currency, so
    // it is accumulated in BASE_CURRENCY — the unit the column is labelled in and
    // the unit `actual` (above) is already in, which is what makes the Variance
    // subtraction and billingStatus's expected-vs-actual comparison meaningful.
    const rates = this.fxRates();
    for (const item of this.contractBillingPlan()) {
      const row = ensure(this.periodKey(item.expectedDate ?? ''), item.projectId ?? '');
      row.expected += convertToBase(item.amount, item.currency, rates);
      row.expectedLabels = [row.expectedLabels, `${item.label} (${item.type})`].filter(Boolean).join(', ');
    }

    for (const event of this.actualBillingEvents()) {
      const row = ensure(event.period, event.projectId);
      row.actual += event.amount;
      row.actualSources = [row.actualSources, `${event.orderId} ${event.status}`].filter(Boolean).join(', ');
    }

    const todayPeriod = this.periodKey(todayLocalIso());
    return [...rows.values()]
      .map(row => {
        const variance = row.actual - row.expected;
        return {
          ...row,
          variance,
          status: this.billingStatus(row.period, row.expected, row.actual, todayPeriod),
        };
      })
      .sort((a, b) => a.period.localeCompare(b.period) || a.projectName.localeCompare(b.projectName));
  });

  /** Σ expected billing due on or before today, in BASE_CURRENCY (see actualBillingEvents). */
  expectedBillingToDate = computed(() => {
    const today = todayLocalIso();
    const rates = this.fxRates();
    return this.contractBillingPlan()
      .filter(i => !!i.expectedDate && i.expectedDate <= today)
      .reduce((sum, i) => sum + convertToBase(i.amount, i.currency, rates), 0);
  });

  actualBillingToDate = computed(() =>
    this.actualBillingEvents().reduce((sum, event) => sum + event.amount, 0),
  );

  billingVarianceToDate = computed(() => this.actualBillingToDate() - this.expectedBillingToDate());

  /** Billing-plan rollups, all in BASE_CURRENCY (each item's own currency is converted before summing). */
  billingKpis = computed(() => {
    const items = this.contractBillingPlan();
    const rates = this.fxRates();
    const inBase = (i: BillingPlanItem) => convertToBase(i.amount, i.currency, rates);
    const sumBy = (status: BillingPlanItem['status']) =>
      items.filter(i => i.status === status).reduce((sum, i) => sum + inBase(i), 0);
    const retentionHeld = items.reduce((sum, i) => sum + inBase(i) * ((i.retentionPct ?? 0) / 100), 0);
    return {
      planned: sumBy('Planned'),
      ready: sumBy('Ready'),
      invoiced: sumBy('Invoiced'),
      paid: sumBy('Paid'),
      retentionHeld,
    };
  });

  projectRows = computed(() => {
    const d = this.data();
    return this.contractProjects().map(project => ({
      project,
      fin: computeProjectFinancials(project.id, d),
    }));
  });

  /**
   * finance.util's rule for "is this margin percentage measured, or the
   * no-revenue sentinel?". Used per project row AND on the contract KPI, each
   * against its OWN revenue: one project under the contract can be measurable
   * while another is not.
   */
  protected hasMarginPct(revenue: number): boolean { return hasMeasuredMarginPct(revenue); }

  kpis = computed(() => {
    const d = this.data();
    const rows = this.contractProjects().map(p => computeProjectFinancials(p.id, d));
    const revenue = rows.reduce((acc, f) => acc + f.revenue, 0);
    const invoiced = rows.reduce((acc, f) => acc + f.invoiced, 0);
    const margin = rows.reduce((acc, f) => acc + f.margin, 0);
    const eac = rows.reduce((acc, f) => acc + f.eac, 0);
    return {
      revenue,
      invoiced,
      margin,
      eac,
      marginPct: revenue > 0 ? (margin / revenue) * 100 : 0,
    };
  });

  /**
   * True once every read the as-incurred (T&M) branch of recognitionSchedule/
   * recognitionJournal depends on — via sellRateFor's project-override /
   * contract-period precedence — has resolved its REAL (post-auth) value:
   * contracts, projects, negotiatedRates, resources, timeEntries, billingItems,
   * hoursPerDay (the EUR/day -> EUR/hour divisor for a negotiated rate: without
   * it the figure prices at the default-8 assumption instead of the configured
   * working day, which is a plausible wrong number, not a missing one).
   *
   * This screen has NO shared forkJoin (unlike reporting.ts/dashboard.component.ts) —
   * each collection is its own independent rxResource, and the page's only gate
   * (`@if (contract(); as c)`) depends on contractsRes alone. Without this guard,
   * the recognition card could render as soon as contracts/resources/timeEntries/
   * billingItems have landed while projects or negotiatedRates are still in
   * flight: sellRateFor would then silently fall through to the reference
   * billRate for every entry, and the page would show a PLAUSIBLE BUT WRONG
   * "Total Recognized" that jumps once the remaining reads complete. A money
   * figure must never render from a partial envelope — $0 while loading reads as
   * "still loading"; a believable wrong number does not. Gating only THIS
   * figure (not the whole page) because everything else here is fine to show
   * as soon as it individually has data.
   */
  private recognitionInputs() {
    return [
      this.contractsRes,
      this.projectsRes,
      this.negotiatedRatesRes,
      this.resourcesRes,
      this.timeEntriesRes,
      this.billingPlanRes,
      this.hoursPerDayRes,
      // MF-02: fxRates belongs here for exactly the hoursPerDay reason above. A
      // FAILED /fx-rates read yields [] through the accessor, and an empty rate
      // table makes convertToBase an IDENTITY — so the figure silently reverts to
      // the pre-fix mixed-unit sum instead of reporting that it cannot be
      // computed. A conversion input whose absence changes the number is a money
      // input, and every money input has to be gated.
      this.fxRatesRes,
    ];
  }

  /**
   * NOT LOADING IS NOT THE SAME AS RESOLVED. An errored resource reports
   * `isLoading() === false`, so a gate written only on `isLoading()` lets a
   * FAILED envelope through — and then `sellRateFor` falls through to the
   * reference billRate at the default-8 divisor and Total Recognized renders a
   * believable wrong figure from a read that never arrived. That is the exact
   * outcome the doc comment above exists to prevent, so the gate must assert the
   * resolved state positively: neither loading nor errored, for all seven.
   * billing.ts:financialDataLoading/financialDataError models the same rule.
   */
  protected recognitionDataReady = computed<boolean>(() =>
    this.recognitionInputs().every(res => !res.isLoading() && res.status() !== 'error'),
  );

  /** True when one of those seven reads FAILED — a Retry, not a spinner. */
  protected recognitionDataError = computed<boolean>(() =>
    this.recognitionInputs().some(res => res.status() === 'error'),
  );

  /**
   * Every read a money figure ANYWHERE on this screen derives from — the
   * recognition inputs plus the order/cost side. One list, so the gates below
   * cannot drift apart the way recognitionDataReady() and the ungated KPI strip
   * did.
   *
   * `requestsRes` and `assignmentsRes` ARE in this list, and their absence was a
   * defect the comment above was already claiming they were not: EAC derives from
   * them. `computeProjectFinancials` -> `plannedLaborCostForProject`
   * (finance.util.ts) reads `d.requests` to find the project's requests and
   * `d.assignments` to price their assigned hours, feeding
   * `etc = max(0, plannedLaborCost - actualLaborCost)` and therefore `eac`. If
   * either read fails, `plannedLaborCost` collapses to 0, EAC understates, and
   * without them here `moneyFiguresState()` would still say 'ready'. No role can
   * trigger it today — requests, assignments and resources share one READ_RULES
   * set — but this screen deliberately has no shared forkJoin, so an independent
   * transient failure of one of them is exactly the case it is built to allow.
   *
   * A comment asserting completeness that the list does not deliver is the failure
   * mode this branch has been paying for all week, so: if a figure on this screen
   * reads a collection, that collection belongs here.
   */
  private moneyInputs() {
    return [
      ...this.recognitionInputs(),
      this.ordersRes,
      this.orderLinesRes,
      this.financialsRes,
      this.requestsRes,
      this.assignmentsRes,
    ];
  }

  /**
   * P1-10, REINTRODUCED BY THIS WAVE'S OWN FIX AND NOW CLOSED. The
   * `status() === 'error' ? [] : value()` accessors above stop one failed read
   * aborting the page — but on their own they turn a failed read into an EMPTY
   * array, and an empty array is a NUMBER. The live case is role `sales`:
   * /resources is gated by READ_RULES to the staffing roles, which excludes
   * sales, so `resourcesRes` 401s; `actualLaborCostForProject` then sums nothing,
   * and `margin = revenue - 0` renders as Margin = Order Revenue, Margin % =
   * 100.0, EAC = 0.00. Confident wrong figures are worse than the crash they
   * replaced.
   *
   * So every money region on this screen is gated on this ONE state — the four of
   * them (KPI strip, projects table, billing control, billing plan) plus
   * recognitionDataReady()'s narrower gate over a subset of the same list.
   */
  protected moneyFiguresState = computed<'error' | 'loading' | 'ready'>(() => {
    const inputs = this.moneyInputs();
    if (inputs.some(res => res.status() === 'error')) return 'error';
    // Pre-authReady the gated resources resolve SUCCESSFULLY with empty defaults,
    // so readiness has to be part of the state or SSR ships zeros.
    if (!this.auth.authReady() || inputs.some(res => res.isLoading())) return 'loading';
    return 'ready';
  });

  protected reloadMoneyData(): void {
    for (const res of this.moneyInputs()) res.reload();
  }

  protected reloadRecognitionData(): void {
    for (const res of this.recognitionInputs()) res.reload();
  }

  /** YYYY-MM bounds spanning every dated signal that could carry recognition for this contract. */
  private recognitionWindow = computed<{ from: string; to: string } | null>(() => {
    const ym = (iso: string | undefined): string => {
      if (!iso) return '';
      const t = Date.parse(iso);
      return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 7) : '';
    };
    const months: string[] = [];

    const milestoneById = new Map(this.milestones().map(m => [m.id, m]));
    for (const item of this.contractBillingPlan()) {
      months.push(ym(item.expectedDate), ym(item.issuedDate), ym(item.paidDate), ym(item.dueDate));
      if (item.milestoneId) months.push(ym(milestoneById.get(item.milestoneId)?.date));
    }

    const projectIds = new Set(this.contractProjects().map(p => p.id));
    for (const t of this.timeEntries()) {
      if (t.status === 'Approved' && projectIds.has(t.projectId)) months.push(ym(t.date));
    }

    const dated = months.filter(Boolean).sort();
    if (!dated.length) return null;
    return { from: dated[0], to: dated[dated.length - 1] };
  });

  /** Dated revenue-recognition schedule for this contract (YYYY-MM | recognized | cumulative | deferred). */
  recognitionPeriods = computed<RecognitionPeriod[]>(() => {
    const window = this.recognitionWindow();
    if (!window) return [];
    return recognitionSchedule(this.data(), window, { contractId: this.id() });
  });

  /** Totals + chart scale for the recognition schedule. */
  recognitionSummary = computed(() => {
    const rows = this.recognitionPeriods();
    const totalRecognized = rows.reduce((acc, r) => acc + r.recognized, 0);
    const cumulative = rows.length ? rows[rows.length - 1].cumulative : 0;
    const deferred = rows.length ? rows[rows.length - 1].deferred : 0;
    const maxCumulative = rows.reduce((acc, r) => Math.max(acc, r.cumulative), 0);
    const maxRecognized = rows.reduce((acc, r) => Math.max(acc, Math.abs(r.recognized)), 0);
    return { totalRecognized, cumulative, deferred, maxCumulative, maxRecognized };
  });

  /** Cumulative bar width (0–100) for a recognition row, scaled to the peak cumulative. */
  cumulativeBarPct(row: RecognitionPeriod): number {
    const max = this.recognitionSummary().maxCumulative;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(100, (row.cumulative / max) * 100));
  }

  /** Per-period recognized bar width (0–100), scaled to the largest single-period amount. */
  recognizedBarPct(row: RecognitionPeriod): number {
    const max = this.recognitionSummary().maxRecognized;
    if (max <= 0) return 0;
    return Math.max(0, Math.min(100, (Math.abs(row.recognized) / max) * 100));
  }

  /**
   * Balanced double-entry journal preview for this contract's rev-rec schedule —
   * one entry per period with movement, built from the same window/filters as
   * recognitionPeriods() so the postings reconcile with the schedule above.
   */
  journalEntries = computed<JournalEntry[]>(() => {
    const window = this.recognitionWindow();
    if (!window) return [];
    return recognitionJournal(this.data(), window, { contractId: this.id() });
  });

  /** Σ debit / Σ credit across the whole preview, plus the balanced flag (within ε). */
  journalTotalsRow = computed(() => journalTotals(this.journalEntries()));

  openBillingPlanForm(contract: Contract): void {
    const isRecurring = contract.type === 'T&M';
    this.billingPlanForm.controls.recurrence.setValidators(isRecurring ? Validators.required : []);
    this.billingPlanForm.controls.milestoneId.setValidators(isRecurring ? [] : Validators.required);
    this.billingPlanForm.reset({
      projectId: this.contractProjects()[0]?.id ?? '',
      label: contract.type === 'T&M' ? 'Monthly T&M billing' : 'Milestone billing',
      expectedDate: '',
      amount: null,
      currency: contract.currency,
      recurrence: 'Monthly',
      milestoneId: '',
      status: 'Planned',
    });
    this.billingPlanForm.controls.recurrence.updateValueAndValidity();
    this.billingPlanForm.controls.milestoneId.updateValueAndValidity();
    this.showBillingPlanForm.set(true);
  }

  onBillingProjectChange(): void {
    this.billingPlanForm.controls.milestoneId.setValue('');
  }

  closeBillingPlanForm(): void {
    this.showBillingPlanForm.set(false);
  }

  saveBillingPlanItem(contract: Contract): void {
    if (this.billingPlanForm.invalid) return;
    const raw = this.billingPlanForm.getRawValue();
    const type: BillingPlanItem['type'] = contract.type === 'T&M' ? 'Recurring' : 'Milestone';
    this.api.createBillingPlanItem({
      contractId: contract.id,
      projectId: raw.projectId || undefined,
      type,
      label: raw.label,
      expectedDate: raw.expectedDate,
      amount: raw.amount ?? 0,
      currency: raw.currency,
      recurrence: type === 'Recurring' ? raw.recurrence : undefined,
      milestoneId: type === 'Milestone' ? raw.milestoneId : undefined,
      status: raw.status,
    }).subscribe({
      next: () => {
        this.billingPlanRes.reload();
        this.notification.show('Expected billing saved', 'success');
        this.closeBillingPlanForm();
      },
      error: () => this.notification.show('Failed to save expected billing', 'error'),
    });
  }

  private projectName(projectId: string): string {
    if (!projectId) return 'Contract level';
    return this.projects().find(p => p.id === projectId)?.name ?? projectId;
  }

  billingTrigger(item: BillingPlanItem): string {
    switch (item.type) {
      case 'Milestone':
        return item.milestoneId ? `Milestone ${item.milestoneId}` : 'Milestone';
      case 'Recurring':
        return item.recurrence ?? 'Recurring';
      case 'Progress':
        return item.progressPct != null ? `${item.progressPct.toFixed(0)}% complete` : 'Progress';
      case 'Capped':
        return item.capAmount != null ? `Capped @ ${item.capAmount.toFixed(2)}` : 'Capped';
      case 'TimeAndMaterials':
        return 'Time & Materials';
      case 'Advance':
        return 'Advance';
      case 'Expense':
        return item.markupPct != null ? `Expense +${item.markupPct.toFixed(1)}%` : 'Expense';
      case 'CreditNote':
        return 'Credit Note';
      default:
        return item.recurrence ?? item.type;
    }
  }

  private periodKey(date: string): string {
    return (date || '').slice(0, 7) || 'Unscheduled';
  }

  private billingStatus(period: string, expected: number, actual: number, todayPeriod: string): BillingControlRow['status'] {
    if (expected <= 0 && actual > 0) return 'Actual only';
    if (actual >= expected && expected > 0) return 'Covered';
    if (period > todayPeriod) return 'Planned';
    if (actual > 0) return 'Partial';
    return 'Behind';
  }
}
