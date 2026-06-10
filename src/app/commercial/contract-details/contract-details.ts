import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { rxResource } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import {
  ApiService,
  Assignment,
  BillingPlanItem,
  Contract,
  Customer,
  FinancialItem,
  Milestone,
  Order,
  OrderLine,
  Project,
  Resource,
  ResourceRequest,
  TimeEntry,
} from '../../services/api.service';
import {
  computeProjectFinancials,
  FinanceData,
  JournalEntry,
  journalTotals,
  recognitionJournal,
  recognitionSchedule,
  RecognitionPeriod,
} from '../../services/finance.util';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

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
  imports: [CurrencyPipe, DatePipe, MatIconModule, ReactiveFormsModule, RouterLink, ModalDialogDirective],
  template: `
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      @if (contract(); as c) {
        <!-- Header card -->
        <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 p-6 sm:p-8 transition-shadow hover:shadow-md">
          <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-6">
            <div class="min-w-0">
              <div class="flex items-center gap-2 text-xs text-slate-500 mb-2">
                <a routerLink="/contracts" class="text-blue-700 hover:text-blue-800 transition-colors flex items-center gap-1">
                  <mat-icon class="text-[16px] w-[16px] h-[16px]">arrow_back</mat-icon> Contracts
                </a>
              </div>
              <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight truncate">{{ c.name }}</h1>
              <div class="flex flex-wrap items-center gap-3 mt-3 text-sm text-slate-600">
                <span class="inline-flex items-center gap-1.5 font-medium">
                  <mat-icon class="text-[18px] w-[18px] h-[18px] text-slate-400">business</mat-icon>
                  {{ customerName() }}
                </span>
                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 font-mono">
                  {{ c.type }}
                </span>
                <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide ring-1"
                      [class.bg-amber-50]="c.status === 'Draft'"
                      [class.text-amber-700]="c.status === 'Draft'"
                      [class.ring-amber-200]="c.status === 'Draft'"
                      [class.bg-emerald-50]="c.status === 'Active'"
                      [class.text-emerald-700]="c.status === 'Active'"
                      [class.ring-emerald-200]="c.status === 'Active'"
                      [class.bg-slate-100]="c.status === 'Closed'"
                      [class.text-slate-700]="c.status === 'Closed'"
                      [class.ring-slate-200]="c.status === 'Closed'">
                  {{ c.status }}
                </span>
              </div>
            </div>
            <div class="text-right shrink-0">
              <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Total Value</p>
              <p class="text-2xl font-bold text-slate-900 mt-1 font-mono tabular-nums">{{ c.totalValue | currency: c.currency }}</p>
            </div>
          </div>
        </div>

        <!-- KPI row -->
        <div class="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <div class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 p-5 transition-shadow hover:shadow-md">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Contract Value</p>
            <p class="text-2xl font-bold text-slate-900 mt-2 font-mono tabular-nums">{{ c.totalValue | currency: c.currency }}</p>
          </div>
          <div class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 p-5 transition-shadow hover:shadow-md">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Order Revenue</p>
            <p class="text-2xl font-bold text-slate-900 mt-2 font-mono tabular-nums">{{ kpis().revenue | currency: c.currency }}</p>
          </div>
          <div class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 p-5 transition-shadow hover:shadow-md">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Invoiced</p>
            <p class="text-2xl font-bold text-slate-900 mt-2 font-mono tabular-nums">{{ kpis().invoiced | currency: c.currency }}</p>
          </div>
          <div class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 p-5 transition-shadow hover:shadow-md">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Margin</p>
            <p class="text-2xl font-bold mt-2 font-mono tabular-nums"
               [class.text-emerald-700]="kpis().margin >= 0"
               [class.text-red-700]="kpis().margin < 0">
              {{ kpis().margin | currency: c.currency }}
            </p>
          </div>
          <div class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 p-5 transition-shadow hover:shadow-md">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">Margin %</p>
            <p class="text-2xl font-bold mt-2 font-mono tabular-nums"
               [class.text-emerald-700]="kpis().marginPct >= 0"
               [class.text-red-700]="kpis().marginPct < 0">
              {{ kpis().marginPct.toFixed(1) }}%
            </p>
          </div>
          <div class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 p-5 transition-shadow hover:shadow-md">
            <p class="text-xs font-semibold text-slate-500 uppercase tracking-wide">EAC</p>
            <p class="text-2xl font-bold text-slate-900 mt-2 font-mono tabular-nums">{{ kpis().eac | currency: c.currency }}</p>
          </div>
        </div>

        <!-- Projects under this contract -->
        <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden transition-shadow hover:shadow-md">
          <div class="px-6 sm:px-8 py-5 border-b border-slate-200">
            <h2 class="text-xl font-bold text-slate-900 tracking-tight">Projects under this contract</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider bg-slate-50">
                  <th class="px-6 sm:px-8 py-3">Project</th>
                  <th class="px-6 py-3 text-right">Revenue</th>
                  <th class="px-6 py-3 text-right">Actual Cost</th>
                  <th class="px-6 py-3 text-right">EAC</th>
                  <th class="px-6 py-3 text-right">Margin</th>
                  <th class="px-6 sm:px-8 py-3 text-right">Margin %</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (row of projectRows(); track row.project.id) {
                  <tr class="hover:bg-slate-50 transition-colors">
                    <td class="px-6 sm:px-8 py-4 font-medium text-slate-900">
                      <a [routerLink]="['/projects', row.project.id]" class="text-blue-700 hover:text-blue-800 transition-colors">
                        {{ row.project.name }}
                      </a>
                    </td>
                    <td class="px-6 py-4 text-right text-slate-700 font-mono tabular-nums">{{ row.fin.revenue | currency: c.currency }}</td>
                    <td class="px-6 py-4 text-right text-slate-700 font-mono tabular-nums">{{ row.fin.actualCost | currency: c.currency }}</td>
                    <td class="px-6 py-4 text-right text-slate-700 font-mono tabular-nums">{{ row.fin.eac | currency: c.currency }}</td>
                    <td class="px-6 py-4 text-right font-medium font-mono tabular-nums"
                        [class.text-emerald-700]="row.fin.margin >= 0"
                        [class.text-red-700]="row.fin.margin < 0">
                      {{ row.fin.margin | currency: c.currency }}
                    </td>
                    <td class="px-6 sm:px-8 py-4 text-right font-medium font-mono tabular-nums"
                        [class.text-emerald-700]="row.fin.marginPct >= 0"
                        [class.text-red-700]="row.fin.marginPct < 0">
                      {{ row.fin.marginPct.toFixed(1) }}%
                    </td>
                  </tr>
                }
                @if (!projectRows().length) {
                  <tr>
                    <td colspan="6" class="px-6 sm:px-8 py-10 text-center text-slate-500">
                      No projects linked to this contract.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

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

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4">
            <div class="command-kpi info">
              <p class="command-kpi-label">Expected To Date</p>
              <p class="command-kpi-value">{{ expectedBillingToDate() | currency: c.currency }}</p>
            </div>
            <div class="command-kpi green">
              <p class="command-kpi-label">Actual To Date</p>
              <p class="command-kpi-value">{{ actualBillingToDate() | currency: c.currency }}</p>
            </div>
            <div class="command-kpi" [class.danger]="billingVarianceToDate() < 0" [class.green]="billingVarianceToDate() >= 0">
              <p class="command-kpi-label">Variance</p>
              <p class="command-kpi-value">{{ billingVarianceToDate() | currency: c.currency }}</p>
            </div>
          </div>

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
                    <td class="text-right font-mono">{{ row.expected | currency: c.currency }}</td>
                    <td class="text-right font-mono">{{ row.actual | currency: c.currency }}</td>
                    <td class="text-right font-mono font-semibold" [class.text-red-700]="row.variance < 0" [class.text-emerald-700]="row.variance >= 0">
                      {{ row.variance | currency: c.currency }}
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
                    <td colspan="7" class="px-6 sm:px-8 py-10 text-center text-slate-500">
                      No billing plan or actual invoices for this contract.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        <!-- Billing -->
        <div class="command-card overflow-hidden">
          <div class="command-card-header">
            <div>
              <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Billing</h2>
              <p class="mt-1 text-sm text-[var(--cc-muted)]">Billing plan items for this contract across the invoicing lifecycle.</p>
            </div>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-5 gap-4 p-4">
            <div class="command-kpi info">
              <p class="command-kpi-label">Planned</p>
              <p class="command-kpi-value">{{ billingKpis().planned | currency: c.currency }}</p>
            </div>
            <div class="command-kpi warning">
              <p class="command-kpi-label">Ready</p>
              <p class="command-kpi-value">{{ billingKpis().ready | currency: c.currency }}</p>
            </div>
            <div class="command-kpi">
              <p class="command-kpi-label">Invoiced</p>
              <p class="command-kpi-value">{{ billingKpis().invoiced | currency: c.currency }}</p>
            </div>
            <div class="command-kpi green">
              <p class="command-kpi-label">Paid</p>
              <p class="command-kpi-value">{{ billingKpis().paid | currency: c.currency }}</p>
            </div>
            <div class="command-kpi danger">
              <p class="command-kpi-label">Retention Held</p>
              <p class="command-kpi-value">{{ billingKpis().retentionHeld | currency: c.currency }}</p>
            </div>
          </div>

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
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 font-mono">
                        {{ item.type }}
                      </span>
                    </td>
                    <td class="text-slate-700">{{ item.label }}</td>
                    <td class="text-[var(--cc-muted)]">{{ billingTrigger(item) }}</td>
                    <td class="text-right font-mono tabular-nums"
                        [class.text-red-700]="item.amount < 0"
                        [class.text-slate-700]="item.amount >= 0">
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
                    <td class="font-mono text-slate-600">{{ (item.dueDate ?? item.expectedDate) ? ((item.dueDate ?? item.expectedDate) | date: 'mediumDate') : '—' }}</td>
                  </tr>
                }
                @if (!contractBillingPlan().length) {
                  <tr>
                    <td colspan="6" class="px-6 sm:px-8 py-10 text-center text-slate-500">
                      No billing plan items for this contract.
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

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4">
            <div class="command-kpi green">
              <p class="command-kpi-label">Recognized To Date</p>
              <p class="command-kpi-value">{{ recognitionSummary().cumulative | currency: c.currency }}</p>
            </div>
            <div class="command-kpi info">
              <p class="command-kpi-label">Total Recognized</p>
              <p class="command-kpi-value">{{ recognitionSummary().totalRecognized | currency: c.currency }}</p>
            </div>
            <div class="command-kpi" [class.warning]="recognitionSummary().deferred > 0">
              <p class="command-kpi-label">Deferred (Advance)</p>
              <p class="command-kpi-value">{{ recognitionSummary().deferred | currency: c.currency }}</p>
            </div>
          </div>

          @if (recognitionPeriods().length) {
            <!-- Cumulative recognition trend -->
            <div class="px-4 pb-2">
              <p class="command-section-label">Cumulative recognition</p>
              <div class="mt-3 space-y-2">
                @for (row of recognitionPeriods(); track row.period) {
                  <div class="flex items-center gap-3">
                    <span class="w-16 shrink-0 font-mono tabular-nums text-xs text-slate-500">{{ row.period }}</span>
                    <div class="relative h-6 flex-1 rounded-md bg-slate-100 ring-1 ring-slate-200 overflow-hidden">
                      <div class="absolute inset-y-0 left-0 rounded-md bg-blue-600 transition-[width]"
                           [style.width.%]="cumulativeBarPct(row)"
                           [attr.aria-label]="'Cumulative recognized through ' + row.period"
                           role="img"></div>
                      <!-- per-period recognized marker -->
                      <div class="absolute inset-y-0 left-0 border-r-2 border-blue-900/40"
                           [style.width.%]="recognizedBarPct(row)"></div>
                    </div>
                    <span class="w-28 shrink-0 text-right font-mono tabular-nums text-xs text-slate-700">
                      {{ row.cumulative | currency: c.currency: 'symbol': '1.0-0' }}
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
                          [class.text-red-700]="row.recognized < 0"
                          [class.text-slate-700]="row.recognized >= 0">
                        {{ row.recognized | currency: c.currency }}
                      </td>
                      <td class="text-right font-mono tabular-nums text-slate-700">{{ row.cumulative | currency: c.currency }}</td>
                      <td class="text-right font-mono tabular-nums"
                          [class.text-amber-700]="row.deferred > 0"
                          [class.text-slate-500]="row.deferred === 0">
                        {{ row.deferred | currency: c.currency }}
                      </td>
                    </tr>
                  }
                </tbody>
                <tfoot>
                  <tr class="border-t-2 border-slate-200">
                    <td class="font-semibold text-slate-700">Total</td>
                    <td class="text-right font-mono tabular-nums font-semibold text-slate-900">{{ recognitionSummary().totalRecognized | currency: c.currency }}</td>
                    <td class="text-right font-mono tabular-nums font-semibold text-slate-900">{{ recognitionSummary().cumulative | currency: c.currency }}</td>
                    <td class="text-right font-mono tabular-nums font-semibold text-slate-900">{{ recognitionSummary().deferred | currency: c.currency }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          } @else {
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-slate-500">
              No dated billing items or approved time entries to build a recognition schedule for this contract.
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
            <span class="command-status shrink-0"
                  [class.green]="journalTotalsRow().balanced"
                  [class.red]="!journalTotalsRow().balanced">
              <mat-icon class="text-[16px] w-[16px] h-[16px]">
                {{ journalTotalsRow().balanced ? 'check_circle' : 'error' }}
              </mat-icon>
              {{ journalTotalsRow().balanced ? 'Balanced' : 'Out of balance' }}
            </span>
          </div>

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
                      <tr [class.border-t-2]="first" [class.border-slate-200]="first">
                        <td class="font-mono font-semibold align-top">{{ first ? entry.date : '' }}</td>
                        <td class="text-[var(--cc-muted)] align-top">{{ first ? entry.memo : '' }}</td>
                        <td class="text-slate-700">{{ line.account }}</td>
                        <td class="text-right font-mono tabular-nums"
                            [class.text-slate-700]="line.debit > 0"
                            [class.text-slate-300]="line.debit === 0">
                          {{ line.debit > 0 ? (line.debit | currency: c.currency) : '—' }}
                        </td>
                        <td class="text-right font-mono tabular-nums"
                            [class.text-slate-700]="line.credit > 0"
                            [class.text-slate-300]="line.credit === 0">
                          {{ line.credit > 0 ? (line.credit | currency: c.currency) : '—' }}
                        </td>
                      </tr>
                    }
                  }
                </tbody>
                <tfoot>
                  <tr class="border-t-2 border-slate-300">
                    <td class="font-semibold text-slate-700" colspan="3">Totals</td>
                    <td class="text-right font-mono tabular-nums font-semibold text-slate-900">{{ journalTotalsRow().debit | currency: c.currency }}</td>
                    <td class="text-right font-mono tabular-nums font-semibold text-slate-900">{{ journalTotalsRow().credit | currency: c.currency }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p class="command-note px-4 py-3">
              Σ Debit {{ journalTotalsRow().debit | currency: c.currency }} = Σ Credit {{ journalTotalsRow().credit | currency: c.currency }}.
              These entries are a preview and have not been posted to the ledger.
            </p>
          } @else {
            <div class="command-empty px-6 sm:px-8 py-10 text-center text-slate-500">
              No journal movement to preview — there is nothing recognized or deferred for this contract yet.
            </div>
          }
        </div>

        <!-- Orders -->
        <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden transition-shadow hover:shadow-md">
          <div class="px-6 sm:px-8 py-5 border-b border-slate-200">
            <h2 class="text-xl font-bold text-slate-900 tracking-tight">Orders</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-xs font-semibold text-slate-500 uppercase tracking-wider bg-slate-50">
                  <th class="px-6 sm:px-8 py-3">Type</th>
                  <th class="px-6 py-3 text-right">Amount</th>
                  <th class="px-6 py-3">Status</th>
                  <th class="px-6 sm:px-8 py-3">Order Date</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (o of contractOrders(); track o.id) {
                  <tr class="hover:bg-slate-50 transition-colors">
                    <td class="px-6 sm:px-8 py-4 font-medium text-slate-900">{{ o.type }}</td>
                    <td class="px-6 py-4 text-right text-slate-700 font-mono tabular-nums">{{ o.amount | currency: o.currency }}</td>
                    <td class="px-6 py-4">
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold tracking-wide ring-1"
                            [class.bg-slate-100]="o.status === 'Open'"
                            [class.text-slate-700]="o.status === 'Open'"
                            [class.ring-slate-200]="o.status === 'Open'"
                            [class.bg-blue-50]="o.status === 'Confirmed'"
                            [class.text-blue-700]="o.status === 'Confirmed'"
                            [class.ring-blue-200]="o.status === 'Confirmed'"
                            [class.bg-amber-50]="o.status === 'Invoiced'"
                            [class.text-amber-700]="o.status === 'Invoiced'"
                            [class.ring-amber-200]="o.status === 'Invoiced'"
                            [class.bg-emerald-50]="o.status === 'Paid'"
                            [class.text-emerald-700]="o.status === 'Paid'"
                            [class.ring-emerald-200]="o.status === 'Paid'">
                        {{ o.status }}
                      </span>
                    </td>
                    <td class="px-6 sm:px-8 py-4 text-slate-700">{{ o.orderDate | date: 'mediumDate' }}</td>
                  </tr>
                }
                @if (!contractOrders().length) {
                  <tr>
                    <td colspan="4" class="px-6 sm:px-8 py-10 text-center text-slate-500">
                      No orders for this contract.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>

        @if (showBillingPlanForm()) {
          <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
               appModal ariaLabelledby="billingPlanModalTitle" (dismiss)="closeBillingPlanForm()">
            <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
              <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
                <h2 id="billingPlanModalTitle" class="text-2xl font-bold text-slate-900 tracking-tight">Expected Billing</h2>
                <button type="button" (click)="closeBillingPlanForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-50 p-2 rounded-full transition-colors" aria-label="Close">
                  <mat-icon>close</mat-icon>
                </button>
              </div>

              <div class="p-6 sm:p-8 overflow-y-auto flex-1">
                <form [formGroup]="billingPlanForm" (ngSubmit)="saveBillingPlanItem(c)" class="space-y-6">
                  <div>
                    <label for="billingLabel" class="block text-sm font-semibold text-slate-700 mb-1.5">Label *</label>
                    <input id="billingLabel" type="text" formControlName="label" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="e.g. Monthly T&M billing">
                  </div>

                  <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                    <div>
                      <label for="billingProject" class="block text-sm font-semibold text-slate-700 mb-1.5">Project</label>
                      <select id="billingProject" formControlName="projectId" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900">
                        <option value="">Contract level</option>
                        @for (project of contractProjects(); track project.id) {
                          <option [value]="project.id">{{ project.name }}</option>
                        }
                      </select>
                    </div>

                    <div>
                      <label for="billingRecurrence" class="block text-sm font-semibold text-slate-700 mb-1.5">Recurrence *</label>
                      <select id="billingRecurrence" formControlName="recurrence" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900">
                        <option value="One-off">One-off</option>
                        <option value="Monthly">Monthly</option>
                        <option value="Quarterly">Quarterly</option>
                        <option value="Milestone">Milestone</option>
                      </select>
                    </div>

                    <div>
                      <label for="billingExpectedDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Expected Date *</label>
                      <input id="billingExpectedDate" type="date" formControlName="expectedDate" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900">
                    </div>

                    <div>
                      <label for="billingAmount" class="block text-sm font-semibold text-slate-700 mb-1.5">Amount *</label>
                      <input id="billingAmount" type="number" formControlName="amount" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="0">
                    </div>

                    <div>
                      <label for="billingCurrency" class="block text-sm font-semibold text-slate-700 mb-1.5">Currency *</label>
                      <input id="billingCurrency" type="text" formControlName="currency" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900">
                    </div>

                    <div>
                      <label for="billingStatus" class="block text-sm font-semibold text-slate-700 mb-1.5">Status *</label>
                      <select id="billingStatus" formControlName="status" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900">
                        <option value="Planned">Planned</option>
                        <option value="Ready">Ready</option>
                        <option value="Blocked">Blocked</option>
                      </select>
                    </div>
                  </div>
                </form>
              </div>

              <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
                <button type="button" (click)="closeBillingPlanForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
                <button type="button" (click)="saveBillingPlanItem(c)" [disabled]="billingPlanForm.invalid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                  Save Expected Billing
                </button>
              </div>
            </div>
          </div>
        }
      } @else {
        <div class="p-12 text-center bg-white rounded-3xl ring-1 ring-slate-900/5 border-2 border-slate-200 border-dashed">
          <div class="w-20 h-20 bg-slate-50 shadow-sm ring-1 ring-slate-900/5 rounded-full flex items-center justify-center mx-auto mb-4">
            <mat-icon class="text-slate-400 text-4xl">description</mat-icon>
          </div>
          <h3 class="text-xl font-bold text-slate-900 mb-2">Contract not found</h3>
          <p class="text-slate-500">The contract you are looking for is unavailable or still loading.</p>
        </div>
      }
    </div>
  `,
})
export class ContractDetails {
  private api = inject(ApiService);
  private notification = inject(NotificationService);

  id = input.required<string>();

  private contractsRes = rxResource({ stream: () => this.api.getContracts(), defaultValue: [] as Contract[] });
  private customersRes = rxResource({ stream: () => this.api.getCustomers(), defaultValue: [] as Customer[] });
  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  private ordersRes = rxResource({ stream: () => this.api.getOrders(), defaultValue: [] as Order[] });
  private orderLinesRes = rxResource({ stream: () => this.api.getOrderLines(), defaultValue: [] as OrderLine[] });
  private requestsRes = rxResource({ stream: () => this.api.getRequests(), defaultValue: [] as ResourceRequest[] });
  private assignmentsRes = rxResource({ stream: () => this.api.getAssignments(), defaultValue: [] as Assignment[] });
  private resourcesRes = rxResource({ stream: () => this.api.getResources(), defaultValue: [] as Resource[] });
  private financialsRes = rxResource({ stream: () => this.api.getProjectFinancials(), defaultValue: [] as FinancialItem[] });
  private timeEntriesRes = rxResource({ stream: () => this.api.getTimeEntries(), defaultValue: [] as TimeEntry[] });
  private billingPlanRes = rxResource({ stream: () => this.api.getBillingPlanItems(), defaultValue: [] as BillingPlanItem[] });
  private milestonesRes = rxResource({ stream: () => this.api.getMilestones(), defaultValue: [] as Milestone[] });

  contracts = this.contractsRes.value;
  customers = this.customersRes.value;
  projects = this.projectsRes.value;
  orders = this.ordersRes.value;
  orderLines = this.orderLinesRes.value;
  requests = this.requestsRes.value;
  assignments = this.assignmentsRes.value;
  resources = this.resourcesRes.value;
  financials = this.financialsRes.value;
  timeEntries = this.timeEntriesRes.value;
  billingPlanItems = this.billingPlanRes.value;
  milestones = this.milestonesRes.value;

  showBillingPlanForm = signal(false);

  billingPlanForm = new FormGroup({
    projectId: new FormControl('', { nonNullable: true }),
    label: new FormControl('', { nonNullable: true, validators: Validators.required }),
    expectedDate: new FormControl('', { nonNullable: true, validators: Validators.required }),
    amount: new FormControl<number | null>(null, { validators: Validators.required }),
    currency: new FormControl('EUR', { nonNullable: true, validators: Validators.required }),
    recurrence: new FormControl<BillingPlanItem['recurrence']>('Monthly', { nonNullable: true, validators: Validators.required }),
    status: new FormControl<BillingPlanItem['status']>('Planned', { nonNullable: true, validators: Validators.required }),
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
  }));

  contractProjects = computed(() => this.projects().filter(p => p.contractId === this.id()));

  contractOrders = computed(() => this.orders().filter(o => o.contractId === this.id()));

  contractBillingPlan = computed(() =>
    this.billingPlanItems()
      .filter(i => i.contractId === this.id())
      .sort((a, b) => (a.expectedDate ?? '').localeCompare(b.expectedDate ?? '')),
  );

  private actualBillingEvents = computed<BillingActualEvent[]>(() => {
    const actualOrders = this.contractOrders().filter(o => o.type === 'Customer' && (o.status === 'Invoiced' || o.status === 'Paid'));
    return actualOrders.flatMap(order => {
      const lines = this.orderLines().filter(line => line.orderId === order.id);
      if (!lines.length) {
        return [{
          period: this.periodKey(order.orderDate),
          projectId: '',
          amount: order.amount,
          orderId: order.id,
          status: order.status,
        }];
      }
      return lines.map(line => ({
        period: this.periodKey(order.orderDate),
        projectId: line.projectId,
        amount: line.amount,
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

    for (const item of this.contractBillingPlan()) {
      const row = ensure(this.periodKey(item.expectedDate ?? ''), item.projectId ?? '');
      row.expected += item.amount;
      row.expectedLabels = [row.expectedLabels, `${item.label} (${item.type})`].filter(Boolean).join(', ');
    }

    for (const event of this.actualBillingEvents()) {
      const row = ensure(event.period, event.projectId);
      row.actual += event.amount;
      row.actualSources = [row.actualSources, `${event.orderId} ${event.status}`].filter(Boolean).join(', ');
    }

    const todayPeriod = this.periodKey(new Date().toISOString().slice(0, 10));
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

  expectedBillingToDate = computed(() => {
    const today = new Date().toISOString().slice(0, 10);
    return this.contractBillingPlan()
      .filter(i => !!i.expectedDate && i.expectedDate <= today)
      .reduce((sum, i) => sum + i.amount, 0);
  });

  actualBillingToDate = computed(() =>
    this.actualBillingEvents().reduce((sum, event) => sum + event.amount, 0),
  );

  billingVarianceToDate = computed(() => this.actualBillingToDate() - this.expectedBillingToDate());

  billingKpis = computed(() => {
    const items = this.contractBillingPlan();
    const sumBy = (status: BillingPlanItem['status']) =>
      items.filter(i => i.status === status).reduce((sum, i) => sum + i.amount, 0);
    const retentionHeld = items.reduce((sum, i) => sum + i.amount * ((i.retentionPct ?? 0) / 100), 0);
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
    this.billingPlanForm.reset({
      projectId: this.contractProjects()[0]?.id ?? '',
      label: contract.type === 'T&M' ? 'Monthly T&M billing' : 'Milestone billing',
      expectedDate: '',
      amount: null,
      currency: contract.currency,
      recurrence: 'Monthly',
      status: 'Planned',
    });
    this.showBillingPlanForm.set(true);
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
        return item.progressPct != null ? `${item.progressPct}% complete` : 'Progress';
      case 'Capped':
        return item.capAmount != null ? `Capped @ ${item.capAmount}` : 'Capped';
      case 'TimeAndMaterials':
        return 'Time & Materials';
      case 'Advance':
        return 'Advance';
      case 'Expense':
        return item.markupPct != null ? `Expense +${item.markupPct}%` : 'Expense';
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
