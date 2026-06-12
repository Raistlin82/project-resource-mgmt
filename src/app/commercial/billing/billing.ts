import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, PLATFORM_ID, signal } from '@angular/core';
import { CurrencyPipe, DatePipe, isPlatformBrowser, PercentPipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { concatMap, from, of, switchMap, toArray } from 'rxjs';
import {
  ApiService,
  BASE_CURRENCY,
  BillingPlanItem,
  BillingType,
  Contract,
  Customer,
  FxRate,
  Milestone,
  Order,
  Project,
  Resource,
  TimeEntry,
} from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { convertToBase, daysOverdue } from '../../services/finance.util';
import { CsvColumn, downloadCsv, toCsv } from '../../services/export.util';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

type BillingStatus = BillingPlanItem['status'];
type Recurrence = NonNullable<BillingPlanItem['recurrence']>;

interface TypeMeta {
  readonly type: BillingType;
  readonly label: string;
  /** Tailwind translucent chip classes per the Mission Control theme. */
  readonly chip: string;
  /** Accent swatch for the legend dot. */
  readonly dot: string;
  readonly hint: string;
}

/** Single source of truth for type → colour + copy. Drives chips, legend and the modal. */
const TYPE_META: readonly TypeMeta[] = [
  { type: 'Milestone', label: 'Milestone (SAL)', chip: 'bg-accent-tint text-accent-text ring-1 ring-accent', dot: 'bg-accent', hint: 'Fixed-price stage billed when a project milestone is achieved.' },
  { type: 'Recurring', label: 'Recurring', chip: 'bg-surface-muted text-series-3 ring-1 ring-series-3', dot: 'bg-series-3', hint: 'Retainer billed on a fixed cadence.' },
  { type: 'TimeAndMaterials', label: 'Time & Materials', chip: 'bg-surface-muted text-series-2 ring-1 ring-series-2', dot: 'bg-series-2', hint: 'As incurred — approved hours × bill rate.' },
  { type: 'Capped', label: 'Capped T&M', chip: 'bg-positive-tint text-positive-text ring-1 ring-positive', dot: 'bg-positive', hint: 'Time & materials with a not-to-exceed ceiling.' },
  { type: 'Advance', label: 'Advance', chip: 'bg-caution-tint text-caution-text ring-1 ring-caution', dot: 'bg-caution', hint: 'Down payment taken up front.' },
  { type: 'Progress', label: 'Progress (POC)', chip: 'bg-surface-muted text-series-6 ring-1 ring-series-6', dot: 'bg-series-6', hint: 'Percentage-of-completion billing.' },
  { type: 'Expense', label: 'Expense', chip: 'bg-surface-muted text-series-7 ring-1 ring-series-7', dot: 'bg-series-7', hint: 'Pass-through expenses, optionally marked up.' },
  { type: 'CreditNote', label: 'Credit Note', chip: 'bg-critical-tint text-critical-text ring-1 ring-critical', dot: 'bg-critical', hint: 'Credit note — reduces invoiced value (negative).' },
] as const;

const ALL_STATUSES: readonly BillingStatus[] = ['Planned', 'Ready', 'Invoiced', 'Paid', 'Blocked'] as const;
const RECURRENCES: readonly Recurrence[] = ['Monthly', 'Quarterly', 'Annual'] as const;

interface BillingRow {
  readonly item: BillingPlanItem;
  readonly meta: TypeMeta;
  readonly contractName: string;
  readonly projectName: string;
  readonly trigger: string;
  readonly tax: number;
  readonly retention: number;
  readonly netPayable: number;
  readonly due: string | null;
  /** Whole days an Invoiced item is past its due date; 0 when on-time / not invoiced. */
  readonly overdueDays: number;
  /** Compliant invoice number from the linked Order (server-set), when available. */
  readonly invoiceNumber: string | null;
  /** Invoice date from the linked Order (server-set), when available. */
  readonly invoiceDate: string | null;
  /**
   * #14 Capped not-to-exceed: true when the server flagged accrued T&M as having
   * breached the cap (encoded as a `[CAP-EXCEEDED]` marker prefixing item.notes).
   */
  readonly capExceeded: boolean;
}

/**
 * Issuer (supplier) identity printed on the invoice artifact. Static client-side
 * stand-in for company master data — no new service dependency.
 */
const INVOICE_ISSUER = {
  name: 'Key2 Consulting S.r.l.',
  addressLines: ['Via Roma 1', '20121 Milano (MI)', 'Italia'],
  vatId: 'IT01234567890',
} as const;

/** Marker the server (#14) prepends to `notes` when accrued T&M breaches the cap. */
const CAP_EXCEEDED_FLAG = '[CAP-EXCEEDED]';

@Component({
  selector: 'app-billing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, PercentPipe, MatIconModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6 p-4 sm:p-6 lg:p-8">
      <!-- HEADER -->
      <header class="command-header">
        <div>
          <p class="command-eyebrow">Commercial Control</p>
          <h1 class="command-title">Billing Plan</h1>
          <p class="command-subtitle">
            One master ledger for every billing condition — milestones, retainers, time &amp; materials,
            caps, advances, progress, expenses and credit notes — with live tax, retention and net-payable rollups.
          </p>
        </div>
        <div class="flex items-center gap-3">
          <button type="button" class="command-button secondary" (click)="exportCsv()"
                  [disabled]="!rows().length"
                  [attr.aria-label]="'Export ' + rows().length + ' filtered billing conditions to CSV'">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">download</mat-icon>
            Export CSV
          </button>
          <button type="button" class="command-button" (click)="openCreate()">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon>
            New Billing Condition
          </button>
        </div>
      </header>

      <!-- KPI STRIP -->
      <section class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-8 gap-4" aria-label="Billing metrics">
        <article class="command-kpi info">
          <p class="command-kpi-label">Planned</p>
          <p class="command-kpi-value">{{ kpis().planned | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">Conditions awaiting trigger</p>
        </article>
        <article class="command-kpi green">
          <p class="command-kpi-label">Ready</p>
          <p class="command-kpi-value">{{ kpis().ready | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">Billable right now</p>
        </article>
        <article class="command-kpi warning">
          <p class="command-kpi-label">Invoiced</p>
          <p class="command-kpi-value">{{ kpis().invoiced | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">Issued, awaiting payment</p>
        </article>
        <article class="command-kpi danger">
          <p class="command-kpi-label">Overdue</p>
          <p class="command-kpi-value">{{ kpis().overdueAmount | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">{{ kpis().overdueCount }} invoiced past due</p>
        </article>
        <article class="command-kpi">
          <p class="command-kpi-label">Paid</p>
          <p class="command-kpi-value">{{ kpis().paid | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">Cash collected</p>
        </article>
        <article class="command-kpi info">
          <p class="command-kpi-label">T&amp;M Accrued</p>
          <p class="command-kpi-value">{{ kpis().tmAccrued | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">Unbilled approved hours × bill rate</p>
        </article>
        <article class="command-kpi warning">
          <p class="command-kpi-label">Retention Held</p>
          <p class="command-kpi-value">{{ kpis().retentionHeld | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">Retention guarantee, not yet paid</p>
        </article>
        <article class="command-kpi">
          <p class="command-kpi-label">Tax (IVA)</p>
          <p class="command-kpi-value">{{ kpis().tax | currency: baseCurrency : 'symbol' : '1.0-0' }}</p>
          <p class="command-kpi-note">On Ready &amp; Invoiced conditions</p>
        </article>
      </section>

      <!-- TYPE LEGEND -->
      <section class="command-card-muted rounded-lg px-4 py-3" aria-label="Billing type legend">
        <p class="command-section-label mb-2">Condition types</p>
        <ul class="flex flex-wrap gap-x-5 gap-y-2">
          @for (meta of typeMeta; track meta.type) {
            <li class="flex items-center gap-2 text-xs text-ink-secondary">
              <span class="inline-block w-2.5 h-2.5 rounded-full" [class]="meta.dot" aria-hidden="true"></span>
              <span class="font-medium">{{ meta.label }}</span>
            </li>
          }
        </ul>
      </section>

      <!-- FILTERS -->
      <section class="command-card rounded-lg p-4" aria-label="Filters">
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label for="filterType" class="command-section-label block mb-1.5">Type</label>
            <select id="filterType" [formControl]="typeFilter" class="command-select">
              <option value="">All types</option>
              @for (meta of typeMeta; track meta.type) {
                <option [value]="meta.type">{{ meta.label }}</option>
              }
            </select>
          </div>
          <div>
            <label for="filterStatus" class="command-section-label block mb-1.5">Status</label>
            <select id="filterStatus" [formControl]="statusFilter" class="command-select">
              <option value="">All statuses</option>
              @for (status of statuses; track status) {
                <option [value]="status">{{ status }}</option>
              }
            </select>
          </div>
          <div>
            <label for="filterContract" class="command-section-label block mb-1.5">Contract</label>
            <select id="filterContract" [formControl]="contractFilter" class="command-select">
              <option value="">All contracts</option>
              @for (contract of contracts(); track contract.id) {
                <option [value]="contract.id">{{ contract.name }}</option>
              }
            </select>
          </div>
        </div>
      </section>

      <!-- MASTER TABLE -->
      <section class="command-card rounded-lg overflow-hidden">
        <div class="command-card-header">
          <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">All Billing Conditions</h2>
          <div class="flex items-center gap-3">
            @if (selectedReadyCount() > 0) {
              <button type="button" class="command-button"
                      (click)="generateSelectedInvoices()" [disabled]="batchRunning() || busyId() !== null"
                      [attr.aria-label]="'Generate ' + selectedReadyCount() + ' invoices for selected ready conditions'">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">receipt_long</mat-icon>
                Generate {{ selectedReadyCount() }} {{ selectedReadyCount() === 1 ? 'invoice' : 'invoices' }}
              </button>
            }
            <span class="command-status">{{ rows().length }} shown</span>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th scope="col" class="w-10">
                  @if (readyCount() > 0) {
                    <input type="checkbox" class="command-checkbox"
                           [checked]="allReadySelected()"
                           [indeterminate]="someReadySelected()"
                           (change)="toggleSelectAllReady($event)"
                           [disabled]="batchRunning()"
                           aria-label="Select all ready conditions" title="Select all ready conditions">
                  }
                </th>
                <th scope="col">Type</th>
                <th scope="col">Label</th>
                <th scope="col">Contract</th>
                <th scope="col">Project</th>
                <th scope="col">Trigger</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col" class="num">Tax %</th>
                <th scope="col" class="num">Ret %</th>
                <th scope="col" class="num">Net Payable</th>
                <th scope="col">Status</th>
                <th scope="col">Invoice #</th>
                <th scope="col">Due</th>
                <th scope="col" class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.item.id) {
                <tr [class.bg-accent-tint]="isSelected(row.item.id)">
                  <td>
                    @if (row.item.status === 'Ready') {
                      <input type="checkbox" class="command-checkbox"
                             [checked]="isSelected(row.item.id)"
                             (change)="toggleRow(row.item.id, $event)"
                             [disabled]="batchRunning()"
                             [attr.aria-label]="'Select ' + row.item.label" [title]="'Select ' + row.item.label">
                    }
                  </td>
                  <td>
                    <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ring-1" [class]="row.meta.chip">
                      {{ row.meta.label }}
                    </span>
                  </td>
                  <td class="font-medium text-ink">{{ row.item.label }}</td>
                  <td class="text-ink-secondary">{{ row.contractName }}</td>
                  <td class="text-ink-secondary">{{ row.projectName }}</td>
                  <td class="text-ink-muted">{{ row.trigger }}</td>
                  <td class="num font-semibold" [class.text-critical-text]="row.item.type === 'CreditNote'" [class.text-ink]="row.item.type !== 'CreditNote'">
                    {{ row.item.amount | currency: row.item.currency : 'symbol' : '1.0-0' }}
                  </td>
                  <td class="num text-ink-secondary">{{ (row.item.taxRatePct ?? 0) / 100 | percent: '1.0-0' }}</td>
                  <td class="num text-ink-secondary">{{ (row.item.retentionPct ?? 0) / 100 | percent: '1.0-0' }}</td>
                  <td class="num font-semibold text-ink">{{ row.netPayable | currency: row.item.currency : 'symbol' : '1.0-0' }}</td>
                  <td>
                    <div class="flex flex-wrap items-center gap-1.5">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ring-1"
                            [class.bg-surface-muted]="row.item.status === 'Planned'"
                            [class.text-ink-secondary]="row.item.status === 'Planned'"
                            [class.ring-line]="row.item.status === 'Planned'"
                            [class.bg-positive-tint]="row.item.status === 'Ready'"
                            [class.text-positive-text]="row.item.status === 'Ready'"
                            [class.ring-positive]="row.item.status === 'Ready'"
                            [class.bg-caution-tint]="row.item.status === 'Invoiced'"
                            [class.text-caution-text]="row.item.status === 'Invoiced'"
                            [class.ring-caution]="row.item.status === 'Invoiced'"
                            [class.bg-accent-tint]="row.item.status === 'Paid'"
                            [class.text-accent-text]="row.item.status === 'Paid'"
                            [class.ring-accent]="row.item.status === 'Paid'"
                            [class.bg-critical-tint]="row.item.status === 'Blocked'"
                            [class.text-critical-text]="row.item.status === 'Blocked'"
                            [class.ring-critical]="row.item.status === 'Blocked'">
                        {{ row.item.status }}
                      </span>
                      @if (row.overdueDays > 0) {
                        <span class="command-chip is-critical tabular-nums"
                              [attr.aria-label]="'Overdue by ' + row.overdueDays + ' days'"
                              [title]="'Overdue by ' + row.overdueDays + ' days'">
                          Overdue {{ row.overdueDays }}d
                        </span>
                      }
                      @if (row.capExceeded) {
                        <span class="command-chip is-caution"
                              aria-label="Accrued time and materials exceeded the not-to-exceed cap"
                              title="Accrued T&amp;M exceeded the not-to-exceed cap">
                          <mat-icon class="text-[14px] w-[14px] h-[14px] leading-none" aria-hidden="true">warning</mat-icon>
                          Cap exceeded
                        </span>
                      }
                    </div>
                  </td>
                  <td class="font-mono tabular-nums">
                    @if (row.invoiceNumber) {
                      <span class="text-ink-secondary">{{ row.invoiceNumber }}</span>
                    } @else {
                      <span class="text-ink-muted">&mdash;</span>
                    }
                  </td>
                  <td class="text-ink-muted font-mono tabular-nums">
                    @if (row.due) {
                      {{ row.due | date: 'mediumDate' }}
                    } @else {
                      <span class="text-ink-muted">&mdash;</span>
                    }
                  </td>
                  <td class="text-right">
                    <div class="inline-flex items-center gap-1">
                      <button type="button" class="p-1.5 rounded-lg text-ink-muted hover:text-accent-text hover:bg-accent-tint transition-colors"
                              (click)="openEdit(row.item)" [attr.aria-label]="'Edit ' + row.item.label" title="Edit">
                        <mat-icon class="text-[18px] w-[18px] h-[18px]">edit</mat-icon>
                      </button>
                      @if (row.invoiceNumber) {
                        <button type="button" class="p-1.5 rounded-lg text-ink-muted hover:text-accent-text hover:bg-accent-tint transition-colors"
                                (click)="openInvoice(row)"
                                [attr.aria-label]="'View invoice ' + row.invoiceNumber + ' for ' + row.item.label" title="View invoice">
                          <mat-icon class="text-[18px] w-[18px] h-[18px]">description</mat-icon>
                        </button>
                      }
                      @if (row.item.status === 'Ready') {
                        <button type="button" class="p-1.5 rounded-lg text-ink-muted hover:text-positive-text hover:bg-positive-tint transition-colors"
                                (click)="generateInvoice(row.item)" [disabled]="busyId() === row.item.id"
                                [attr.aria-label]="'Generate invoice for ' + row.item.label" title="Generate invoice">
                          <mat-icon class="text-[18px] w-[18px] h-[18px]">receipt_long</mat-icon>
                        </button>
                      }
                      @if (row.item.status === 'Invoiced') {
                        <button type="button" class="p-1.5 rounded-lg text-ink-muted hover:text-accent-text hover:bg-accent-tint transition-colors"
                                (click)="markPaid(row.item)" [disabled]="busyId() === row.item.id"
                                [attr.aria-label]="'Mark ' + row.item.label + ' as paid'" title="Mark paid">
                          <mat-icon class="text-[18px] w-[18px] h-[18px]">paid</mat-icon>
                        </button>
                      }
                    </div>
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="14">
                    <div class="command-empty">
                      <mat-icon>request_quote</mat-icon>
                      <p class="command-empty-title">No billing conditions match</p>
                      <p class="command-empty-note">Adjust the filters above or add a new billing condition to start building the plan.</p>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <!-- CREATE / EDIT MODAL -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="billingModalTitle" (dismiss)="closeForm()">
        <div class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <div class="command-card-header">
            <div>
              <p class="command-eyebrow">{{ editingId() ? 'Edit condition' : 'New condition' }}</p>
              <h2 id="billingModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Billing Condition' : 'New Billing Condition' }}</h2>
            </div>
            <button type="button" (click)="closeForm()" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors" aria-label="Close dialog">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="form" class="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <!-- TYPE selector -->
              <div class="sm:col-span-2">
                <label for="bType" class="block text-sm font-semibold text-ink-secondary mb-1.5">Type *</label>
                <select id="bType" formControlName="type" class="command-select">
                  @for (meta of typeMeta; track meta.type) {
                    <option [value]="meta.type">{{ meta.label }}</option>
                  }
                </select>
                <p class="text-xs text-ink-muted mt-1.5">{{ selectedMeta().hint }}</p>
              </div>

              <!-- Common: contract -->
              <div>
                <label for="bContract" class="block text-sm font-semibold text-ink-secondary mb-1.5">Contract *</label>
                <select id="bContract" formControlName="contractId" class="command-select">
                  <option value="">Select a contract...</option>
                  @for (contract of contracts(); track contract.id) {
                    <option [value]="contract.id">{{ contract.name }}</option>
                  }
                </select>
              </div>

              <!-- Common: project -->
              <div>
                <label for="bProject" class="block text-sm font-semibold text-ink-secondary mb-1.5">Project</label>
                <select id="bProject" formControlName="projectId" class="command-select">
                  <option value="">Unassigned</option>
                  @for (project of projects(); track project.id) {
                    <option [value]="project.id">{{ project.name }}</option>
                  }
                </select>
              </div>

              <!-- Common: label -->
              <div class="sm:col-span-2">
                <label for="bLabel" class="block text-sm font-semibold text-ink-secondary mb-1.5">Label *</label>
                <input id="bLabel" type="text" formControlName="label" class="command-input" placeholder="e.g. SAL 2 — UAT sign-off">
              </div>

              <!-- TYPE-ADAPTIVE FIELDS -->
              @switch (selectedType()) {
                @case ('Milestone') {
                  <div class="sm:col-span-2">
                    <label for="bMilestone" class="block text-sm font-semibold text-ink-secondary mb-1.5">Milestone *</label>
                    <select id="bMilestone" formControlName="milestoneId" class="command-select">
                      <option value="">Select a milestone...</option>
                      @for (milestone of milestonesForSelectedProject(); track milestone.id) {
                        <option [value]="milestone.id">{{ milestone.name }} ({{ milestone.status }})</option>
                      }
                    </select>
                    @if (!milestonesForSelectedProject().length) {
                      <p class="text-xs text-caution-text mt-1.5">No milestones on the selected project — pick a project that has milestones.</p>
                    }
                  </div>
                }
                @case ('Recurring') {
                  <div>
                    <label for="bRecurrence" class="block text-sm font-semibold text-ink-secondary mb-1.5">Recurrence *</label>
                    <select id="bRecurrence" formControlName="recurrence" class="command-select">
                      @for (recurrence of recurrences; track recurrence) {
                        <option [value]="recurrence">{{ recurrence }}</option>
                      }
                    </select>
                  </div>
                }
                @case ('Capped') {
                  <div>
                    <label for="bCap" class="block text-sm font-semibold text-ink-secondary mb-1.5">Cap Amount *</label>
                    <input id="bCap" type="number" formControlName="capAmount" class="command-input" placeholder="Not-to-exceed">
                  </div>
                }
                @case ('Progress') {
                  <div>
                    <label for="bProgress" class="block text-sm font-semibold text-ink-secondary mb-1.5">Progress % *</label>
                    <input id="bProgress" type="number" min="0" max="100" formControlName="progressPct" class="command-input" placeholder="0–100">
                  </div>
                }
                @case ('Expense') {
                  <div>
                    <label for="bMarkup" class="block text-sm font-semibold text-ink-secondary mb-1.5">Markup %</label>
                    <input id="bMarkup" type="number" formControlName="markupPct" class="command-input" placeholder="e.g. 10">
                  </div>
                }
              }

              <!-- Amount (relabelled for credit notes) -->
              <div>
                <label for="bAmount" class="block text-sm font-semibold text-ink-secondary mb-1.5">
                  {{ selectedType() === 'CreditNote' ? 'Credit Amount *' : 'Amount *' }}
                </label>
                <input id="bAmount" type="number" formControlName="amount" class="command-input" [placeholder]="selectedType() === 'CreditNote' ? 'Entered as a credit' : '0.00'">
                @if (selectedType() === 'CreditNote') {
                  <p class="text-xs text-critical-text mt-1.5">Stored as a negative value (credit note).</p>
                }
              </div>

              <!-- Currency -->
              <div>
                <label for="bCurrency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                <input id="bCurrency" type="text" formControlName="currency" class="command-input" placeholder="EUR">
              </div>

              <!-- Tax -->
              <div>
                <label for="bTax" class="block text-sm font-semibold text-ink-secondary mb-1.5">Tax (IVA) %</label>
                <input id="bTax" type="number" formControlName="taxRatePct" class="command-input" placeholder="22">
              </div>

              <!-- Retention -->
              <div>
                <label for="bRetention" class="block text-sm font-semibold text-ink-secondary mb-1.5">Retention %</label>
                <input id="bRetention" type="number" formControlName="retentionPct" class="command-input" placeholder="0">
              </div>

              <!-- Payment terms -->
              <div>
                <label for="bTerms" class="block text-sm font-semibold text-ink-secondary mb-1.5">Payment Terms (days)</label>
                <input id="bTerms" type="number" formControlName="paymentTermsDays" class="command-input" placeholder="30">
              </div>

              <!-- Expected date -->
              <div>
                <label for="bExpected" class="block text-sm font-semibold text-ink-secondary mb-1.5">Expected Date</label>
                <input id="bExpected" type="date" formControlName="expectedDate" class="command-input">
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
            <button type="button" (click)="save()" [disabled]="form.invalid || saving()" class="command-button">
              {{ editingId() ? 'Save changes' : 'Create condition' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- #5 INVOICE DOCUMENT — printable artifact (window.print → PDF) -->
    @if (invoiceRow(); as inv) {
      <div class="invoice-overlay fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
           appModal ariaLabelledby="invoiceDocTitle" (dismiss)="closeInvoice()">
        <div class="invoice-shell command-card w-full max-w-3xl overflow-hidden flex flex-col max-h-[92vh]">
          <!-- Toolbar (screen only) -->
          <div class="invoice-toolbar command-card-header">
            <div>
              <p class="command-eyebrow">Invoice document</p>
              <h2 id="invoiceDocTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ inv.invoiceNumber }}</h2>
            </div>
            <div class="flex items-center gap-2">
              <button type="button" class="command-button" (click)="printInvoice()"
                      [attr.aria-label]="'Print invoice ' + inv.invoiceNumber + ' to PDF'">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">print</mat-icon>
                Print / Save PDF
              </button>
              <button type="button" (click)="closeInvoice()" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors" aria-label="Close invoice">
                <mat-icon>close</mat-icon>
              </button>
            </div>
          </div>

          <!-- The artifact (this is what prints) -->
          <div class="invoice-scroll overflow-y-auto flex-1">
            <article id="invoiceArtifact" class="invoice-doc p-8 sm:p-10 text-ink">
              <!-- Header: issuer + invoice meta -->
              <header class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-6 pb-6 border-b border-line">
                <div>
                  <p class="text-xl font-bold tracking-tight">{{ issuer.name }}</p>
                  <address class="not-italic text-sm text-ink-secondary mt-1 leading-relaxed">
                    @for (line of issuer.addressLines; track line) {
                      <span class="block">{{ line }}</span>
                    }
                    <span class="block">VAT {{ issuer.vatId }}</span>
                  </address>
                </div>
                <div class="sm:text-right">
                  <p class="text-2xl font-bold tracking-tight">INVOICE</p>
                  <dl class="mt-2 text-sm">
                    <div class="flex sm:justify-end gap-2">
                      <dt class="text-ink-muted">No.</dt>
                      <dd class="font-mono font-semibold tabular-nums">{{ inv.invoiceNumber }}</dd>
                    </div>
                    <div class="flex sm:justify-end gap-2">
                      <dt class="text-ink-muted">Date</dt>
                      <dd class="font-mono tabular-nums">
                        @if (inv.invoiceDate) { {{ inv.invoiceDate | date: 'mediumDate' }} } @else { &mdash; }
                      </dd>
                    </div>
                    @if (inv.due) {
                      <div class="flex sm:justify-end gap-2">
                        <dt class="text-ink-muted">Due</dt>
                        <dd class="font-mono tabular-nums">{{ inv.due | date: 'mediumDate' }}</dd>
                      </div>
                    }
                  </dl>
                </div>
              </header>

              <!-- Bill-to + references -->
              <section class="grid grid-cols-1 sm:grid-cols-2 gap-6 py-6">
                <div>
                  <p class="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">Bill to</p>
                  @if (invoiceCustomer(); as customer) {
                    <p class="text-sm font-semibold text-ink">{{ customer.name }}</p>
                    @if (customer.country) {
                      <p class="text-sm text-ink-secondary">{{ customer.country }}</p>
                    }
                  } @else {
                    <p class="text-sm text-ink-muted">&mdash;</p>
                  }
                </div>
                <div class="sm:text-right">
                  <p class="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">References</p>
                  <p class="text-sm text-ink-secondary">{{ inv.contractName }}</p>
                  @if (inv.projectName && inv.projectName !== '—') {
                    <p class="text-sm text-ink-secondary">Project: {{ inv.projectName }}</p>
                  }
                </div>
              </section>

              <!-- Cap-exceeded notice (#14), if flagged -->
              @if (inv.capExceeded) {
                <p class="invoice-warn flex items-center gap-2 text-sm font-medium text-caution-text bg-caution-tint ring-1 ring-caution rounded-lg px-3 py-2 mb-4">
                  <mat-icon class="text-[18px] w-[18px] h-[18px]" aria-hidden="true">warning</mat-icon>
                  Accrued time &amp; materials have exceeded the not-to-exceed cap for this engagement.
                </p>
              }

              <!-- Line items -->
              <table class="w-full text-sm border-collapse">
                <thead>
                  <tr class="border-y border-line text-left">
                    <th scope="col" class="py-2 pr-3 font-semibold text-ink-secondary">Description</th>
                    <th scope="col" class="py-2 px-3 font-semibold text-ink-secondary">Type</th>
                    <th scope="col" class="py-2 pl-3 text-right font-semibold text-ink-secondary">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr class="border-b border-line align-top">
                    <td class="py-3 pr-3">
                      <p class="font-medium text-ink">{{ inv.item.label }}</p>
                      <p class="text-xs text-ink-muted mt-0.5">{{ inv.trigger }}</p>
                    </td>
                    <td class="py-3 px-3 text-ink-secondary">{{ inv.meta.label }}</td>
                    <td class="py-3 pl-3 text-right font-semibold tabular-nums"
                        [class.text-critical-text]="inv.item.type === 'CreditNote'">
                      {{ inv.item.amount | currency: inv.item.currency : 'symbol' : '1.2-2' }}
                    </td>
                  </tr>
                </tbody>
              </table>

              <!-- Totals -->
              <section class="mt-6 flex justify-end">
                <dl class="w-full sm:w-80 text-sm space-y-1.5">
                  <div class="flex justify-between">
                    <dt class="text-ink-secondary">Net</dt>
                    <dd class="tabular-nums">{{ inv.item.amount | currency: inv.item.currency : 'symbol' : '1.2-2' }}</dd>
                  </div>
                  @if (inv.retention > 0) {
                    <div class="flex justify-between text-ink-secondary">
                      <dt>Retention ({{ (inv.item.retentionPct ?? 0) / 100 | percent: '1.0-0' }})</dt>
                      <dd class="tabular-nums">-{{ inv.retention | currency: inv.item.currency : 'symbol' : '1.2-2' }}</dd>
                    </div>
                  }
                  <div class="flex justify-between text-ink-secondary">
                    <dt>Tax / IVA ({{ (inv.item.taxRatePct ?? 0) / 100 | percent: '1.0-0' }})</dt>
                    <dd class="tabular-nums">{{ inv.tax | currency: inv.item.currency : 'symbol' : '1.2-2' }}</dd>
                  </div>
                  <div class="flex justify-between border-t border-line-strong pt-2 mt-1 text-base font-bold text-ink">
                    <dt>Total due</dt>
                    <dd class="tabular-nums">{{ inv.netPayable | currency: inv.item.currency : 'symbol' : '1.2-2' }}</dd>
                  </div>
                </dl>
              </section>

              <footer class="mt-10 pt-4 border-t border-line text-xs text-ink-muted">
                <p>Invoice {{ inv.invoiceNumber }} &middot; {{ issuer.name }} &middot; VAT {{ issuer.vatId }}</p>
                @if (inv.item.paymentTermsDays) {
                  <p class="mt-0.5">Payment terms: net {{ inv.item.paymentTermsDays }} days.</p>
                }
              </footer>
            </article>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    /* #5 Invoice document — print-to-PDF. On screen it is a normal modal; when
       printing, everything except the artifact is hidden so a single clean
       invoice page is produced. */
    @media print {
      /* Hide the whole app shell; the overlay below is re-shown unstyled. */
      :host { display: contents; }
      .command-page { display: none !important; }
      .invoice-overlay {
        position: static !important;
        inset: auto !important;
        padding: 0 !important;
        background: #ffffff !important;
        backdrop-filter: none !important;
        overflow: visible !important;
        display: block !important;
        z-index: auto !important;
      }
      .invoice-shell {
        max-width: none !important;
        width: auto !important;
        max-height: none !important;
        border: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        overflow: visible !important;
      }
      .invoice-toolbar { display: none !important; }
      .invoice-scroll { overflow: visible !important; }
      .invoice-doc {
        padding: 0 !important;
        color: #000000 !important;
      }
      @page { margin: 16mm; }
    }
  `],
})
export class Billing {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(AuthService);

  /** True only in the browser — gates the CSV export (DOM download) per SSR-safety. */
  readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  // --- template constants ---
  readonly typeMeta = TYPE_META;
  readonly statuses = ALL_STATUSES;
  readonly recurrences = RECURRENCES;

  /** Snapshot of "today" (ISO) for overdue / aging math; captured once at construction. */
  private readonly today = new Date().toISOString();

  // --- data via rxResource ---
  // Principal-gated reads (billing-plan-items, contracts, customers, orders,
  // time-entries, resources) 401 until the OAuth bootstrap restores the bearer
  // token. On reload the OIDC token restores async, so firing immediately 401s
  // and the rxResource latches its empty state forever. Keying each on
  // auth.authReady() defers the request until the token is attached; when
  // authReady flips false->true the params change re-runs the stream (reload()
  // still works for the mutation flows below). Open reads (projects, milestones,
  // fx-rates) would not 401, but fx-rates is gated too so the KPI rollups it
  // normalises re-run together with the gated data.
  private readonly itemsRes = rxResource<BillingPlanItem[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getBillingPlanItems() : of<BillingPlanItem[]>([])),
    defaultValue: [] as BillingPlanItem[],
  });
  private readonly contractsRes = rxResource<Contract[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getContracts() : of<Contract[]>([])),
    defaultValue: [] as Contract[],
  });
  private readonly customersRes = rxResource<Customer[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getCustomers() : of<Customer[]>([])),
    defaultValue: [] as Customer[],
  });
  private readonly projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  private readonly milestonesRes = rxResource({ stream: () => this.api.getMilestones(), defaultValue: [] as Milestone[] });
  private readonly ordersRes = rxResource<Order[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getOrders() : of<Order[]>([])),
    defaultValue: [] as Order[],
  });
  private readonly timeEntriesRes = rxResource<TimeEntry[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getTimeEntries() : of<TimeEntry[]>([])),
    defaultValue: [] as TimeEntry[],
  });
  private readonly resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  /** FX rate table (base-currency value of 1 unit of each currency); normalises mixed-currency KPI rollups. Keyed on auth readiness so it re-runs with the gated data load. */
  private readonly fxRatesRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getFxRates() : of<FxRate[]>([])),
    defaultValue: [] as FxRate[],
  });

  readonly items = this.itemsRes.value;
  readonly contracts = this.contractsRes.value;
  readonly customers = this.customersRes.value;
  readonly projects = this.projectsRes.value;
  readonly milestones = this.milestonesRes.value;
  readonly orders = this.ordersRes.value;
  readonly timeEntries = this.timeEntriesRes.value;
  readonly resources = this.resourcesRes.value;
  readonly fxRates = this.fxRatesRes.value;

  /** Reporting/base currency the aggregate KPI strip is denominated in. */
  readonly baseCurrency = BASE_CURRENCY;

  // --- lookups via computed Maps ---
  private readonly metaByType = new Map<BillingType, TypeMeta>(TYPE_META.map(m => [m.type, m]));
  private readonly contractsById = computed(() => new Map(this.contracts().map(c => [c.id, c])));
  private readonly customersById = computed(() => new Map(this.customers().map(c => [c.id, c])));
  private readonly projectsById = computed(() => new Map(this.projects().map(p => [p.id, p])));
  private readonly milestonesById = computed(() => new Map(this.milestones().map(m => [m.id, m])));
  private readonly resourcesById = computed(() => new Map(this.resources().map(r => [r.id, r])));
  private readonly ordersById = computed(() => new Map(this.orders().map(o => [o.id, o])));

  // --- filters (signals) ---
  readonly typeFilter = new FormControl<'' | BillingType>('', { nonNullable: true });
  readonly statusFilter = new FormControl<'' | BillingStatus>('', { nonNullable: true });
  readonly contractFilter = new FormControl('', { nonNullable: true });
  private readonly typeFilterValue = toSignal(this.typeFilter.valueChanges, { initialValue: this.typeFilter.value });
  private readonly statusFilterValue = toSignal(this.statusFilter.valueChanges, { initialValue: this.statusFilter.value });
  private readonly contractFilterValue = toSignal(this.contractFilter.valueChanges, { initialValue: this.contractFilter.value });

  // --- modal state ---
  readonly showForm = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly busyId = signal<string | null>(null);

  // --- #5 invoice document (printable) ---
  readonly issuer = INVOICE_ISSUER;
  /** The row whose invoice artifact is currently shown for print-to-PDF, or null. */
  readonly invoiceRow = signal<BillingRow | null>(null);
  /** Customer (bill-to) resolved for the open invoice, via contract → customer. */
  readonly invoiceCustomer = computed<Customer | null>(() => {
    const row = this.invoiceRow();
    if (!row) return null;
    const contract = this.contractsById().get(row.item.contractId);
    return contract ? this.customersById().get(contract.customerId) ?? null : null;
  });

  // --- batch invoicing selection (Ready rows only) ---
  readonly selectedIds = signal<ReadonlySet<string>>(new Set<string>());
  readonly batchRunning = signal(false);

  readonly form = new FormGroup({
    type: new FormControl<BillingType>('Milestone', { nonNullable: true, validators: Validators.required }),
    contractId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    projectId: new FormControl('', { nonNullable: true }),
    label: new FormControl('', { nonNullable: true, validators: Validators.required }),
    milestoneId: new FormControl('', { nonNullable: true }),
    recurrence: new FormControl<Recurrence>('Monthly', { nonNullable: true }),
    capAmount: new FormControl<number | null>(null),
    progressPct: new FormControl<number | null>(null),
    markupPct: new FormControl<number | null>(null),
    amount: new FormControl<number | null>(null, { validators: [Validators.required, Validators.min(0)] }),
    currency: new FormControl('EUR', { nonNullable: true, validators: Validators.required }),
    taxRatePct: new FormControl<number>(22, { nonNullable: true }),
    retentionPct: new FormControl<number>(0, { nonNullable: true }),
    paymentTermsDays: new FormControl<number>(30, { nonNullable: true }),
    expectedDate: new FormControl('', { nonNullable: true }),
  });

  readonly selectedType = toSignal(this.form.controls.type.valueChanges, { initialValue: this.form.controls.type.value });
  private readonly formProjectId = toSignal(this.form.controls.projectId.valueChanges, { initialValue: this.form.controls.projectId.value });

  readonly selectedMeta = computed(() => this.metaByType.get(this.selectedType()) ?? TYPE_META[0]);

  readonly milestonesForSelectedProject = computed(() => {
    const projectId = this.formProjectId();
    const all = this.milestones();
    return projectId ? all.filter(m => m.projectId === projectId) : all;
  });

  // --- derived rows (master table) ---
  readonly rows = computed<BillingRow[]>(() => {
    const type = this.typeFilterValue();
    const status = this.statusFilterValue();
    const contractId = this.contractFilterValue();
    const contracts = this.contractsById();
    const customers = this.customersById();
    const projects = this.projectsById();
    const milestones = this.milestonesById();
    const orders = this.ordersById();

    return this.items()
      .filter(i => (!type || i.type === type) && (!status || i.status === status) && (!contractId || i.contractId === contractId))
      .map<BillingRow>(item => {
        const tax = this.taxOf(item);
        const retention = this.retentionOf(item);
        const contract = contracts.get(item.contractId);
        const customerName = contract ? customers.get(contract.customerId)?.name : undefined;
        const contractName = contract
          ? customerName ? `${contract.name} · ${customerName}` : contract.name
          : item.contractId;
        const order = item.orderId ? orders.get(item.orderId) : undefined;
        return {
          item,
          meta: this.metaByType.get(item.type) ?? TYPE_META[0],
          contractName,
          projectName: item.projectId ? projects.get(item.projectId)?.name ?? item.projectId : '—',
          trigger: this.triggerOf(item, milestones),
          tax,
          retention,
          netPayable: item.amount - retention + tax,
          due: this.dueOf(item),
          overdueDays: this.overdueDaysOf(item),
          invoiceNumber: order?.invoiceNumber ?? null,
          invoiceDate: order?.invoiceDate ?? null,
          capExceeded: (item.notes ?? '').includes(CAP_EXCEEDED_FLAG),
        };
      });
  });

  /** Ready items in the current (filtered) view — the universe the batch acts on. */
  private readonly readyRows = computed(() => this.rows().filter(r => r.item.status === 'Ready'));
  readonly readyCount = computed(() => this.readyRows().length);

  /** Selected ids restricted to currently-visible Ready rows (stale ids are ignored). */
  private readonly selectedReadyIds = computed(() => {
    const selected = this.selectedIds();
    return this.readyRows().map(r => r.item.id).filter(id => selected.has(id));
  });
  readonly selectedReadyCount = computed(() => this.selectedReadyIds().length);

  readonly allReadySelected = computed(() => {
    const ready = this.readyCount();
    return ready > 0 && this.selectedReadyCount() === ready;
  });
  /** Indeterminate: some — but not all — visible Ready rows are selected. */
  readonly someReadySelected = computed(() => {
    const sel = this.selectedReadyCount();
    return sel > 0 && sel < this.readyCount();
  });

  // --- KPI strip ---
  // Every rollup normalises each item's amount to BASE_CURRENCY before summing
  // (the book mixes EUR/USD/GBP), so the strip's hardcoded base-currency label is
  // truthful. With no FX table loaded, convertToBase is an identity (single-currency).
  readonly kpis = computed(() => {
    const items = this.items();
    const fx = this.fxRates();
    const base = (i: BillingPlanItem) => convertToBase(i.amount, i.currency, fx);
    const sumWhere = (pred: (i: BillingPlanItem) => boolean) =>
      items.filter(pred).reduce((s, i) => s + base(i), 0);

    const planned = sumWhere(i => i.status === 'Planned');
    const ready = sumWhere(i => i.status === 'Ready');
    const invoiced = sumWhere(i => i.status === 'Invoiced');
    const paid = sumWhere(i => i.status === 'Paid');

    // Overdue: Invoiced conditions whose due date has passed.
    const overdueItems = items.filter(i => this.overdueDaysOf(i) > 0);
    const overdueAmount = overdueItems.reduce((s, i) => s + base(i), 0);
    const overdueCount = overdueItems.length;

    // Retention held: ritenuta on every condition not yet paid.
    const retentionHeld = items
      .filter(i => i.status !== 'Paid')
      .reduce((s, i) => s + convertToBase(this.retentionOf(i), i.currency, fx), 0);

    // Tax (IVA): on Ready + Invoiced conditions.
    const tax = items
      .filter(i => i.status === 'Ready' || i.status === 'Invoiced')
      .reduce((s, i) => s + convertToBase(this.taxOf(i), i.currency, fx), 0);

    return { planned, ready, invoiced, paid, tmAccrued: this.tmAccrued(), retentionHeld, tax, overdueAmount, overdueCount };
  });

  /** T&M accrued = approved hours × resource bill rate, for hours not yet captured by an Invoiced/Paid item. */
  private tmAccrued(): number {
    const resources = this.resourcesById();
    // Projects already covered by an invoiced/paid billing item are considered billed.
    const billedProjects = new Set(
      this.items()
        .filter(i => (i.status === 'Invoiced' || i.status === 'Paid') && i.projectId)
        .map(i => i.projectId as string),
    );
    return this.timeEntries()
      .filter(t => t.status === 'Approved' && !billedProjects.has(t.projectId))
      .reduce((s, t) => s + t.hours * (resources.get(t.resourceId)?.billRate ?? 0), 0);
  }

  private taxOf(i: BillingPlanItem): number {
    return i.amount * ((i.taxRatePct ?? 0) / 100);
  }

  private retentionOf(i: BillingPlanItem): number {
    return i.amount * ((i.retentionPct ?? 0) / 100);
  }

  private triggerOf(i: BillingPlanItem, milestones: Map<string, Milestone>): string {
    switch (i.type) {
      case 'Milestone':
        return i.milestoneId ? milestones.get(i.milestoneId)?.name ?? 'Milestone' : 'No milestone';
      case 'Recurring':
        return i.recurrence ?? 'Recurring';
      default:
        return i.expectedDate ? this.formatDate(i.expectedDate) : 'On demand';
    }
  }

  /** Days past due for an Invoiced item (dueDate ?? issuedDate+terms < today); 0 otherwise. */
  private overdueDaysOf(i: BillingPlanItem): number {
    return i.status === 'Invoiced' ? daysOverdue(i, this.today) : 0;
  }

  private dueOf(i: BillingPlanItem): string | null {
    if (i.dueDate) return i.dueDate;
    if (!i.expectedDate) return null;
    const base = new Date(i.expectedDate);
    if (Number.isNaN(base.getTime())) return null;
    base.setDate(base.getDate() + (i.paymentTermsDays ?? 0));
    return base.toISOString();
  }

  private formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  }

  // --- modal lifecycle ---
  openCreate(): void {
    this.editingId.set(null);
    this.form.reset({
      type: 'Milestone',
      contractId: '',
      projectId: '',
      label: '',
      milestoneId: '',
      recurrence: 'Monthly',
      capAmount: null,
      progressPct: null,
      markupPct: null,
      amount: null,
      currency: 'EUR',
      taxRatePct: 22,
      retentionPct: 0,
      paymentTermsDays: 30,
      expectedDate: '',
    });
    this.showForm.set(true);
  }

  openEdit(item: BillingPlanItem): void {
    this.editingId.set(item.id);
    this.form.reset({
      type: item.type,
      contractId: item.contractId,
      projectId: item.projectId ?? '',
      label: item.label,
      milestoneId: item.milestoneId ?? '',
      recurrence: item.recurrence ?? 'Monthly',
      capAmount: item.capAmount ?? null,
      progressPct: item.progressPct ?? null,
      markupPct: item.markupPct ?? null,
      amount: item.type === 'CreditNote' ? Math.abs(item.amount) : item.amount,
      currency: item.currency,
      taxRatePct: item.taxRatePct ?? 0,
      retentionPct: item.retentionPct ?? 0,
      paymentTermsDays: item.paymentTermsDays ?? 30,
      expectedDate: item.expectedDate ? item.expectedDate.slice(0, 10) : '',
    });
    this.showForm.set(true);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  // --- #5 invoice document lifecycle ---
  /** Open the printable invoice artifact for a row that carries an invoice number. */
  openInvoice(row: BillingRow): void {
    if (!row.invoiceNumber) return;
    this.invoiceRow.set(row);
  }

  closeInvoice(): void {
    this.invoiceRow.set(null);
  }

  /**
   * Trigger the browser's print-to-PDF for the invoice artifact. The @media print
   * rules below hide the rest of the app so only the invoice prints. Browser-only
   * (SSR-safe): no-op on the server where window is unavailable.
   */
  printInvoice(): void {
    if (!this.isBrowser) return;
    window.print();
  }

  save(): void {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    const type = v.type;

    // CreditNote amount is always stored negative; others positive.
    const rawAmount = v.amount ?? 0;
    const amount = type === 'CreditNote' ? -Math.abs(rawAmount) : Math.abs(rawAmount);

    const payload: Partial<BillingPlanItem> = {
      type,
      contractId: v.contractId,
      projectId: v.projectId || undefined,
      label: v.label,
      amount,
      currency: v.currency,
      taxRatePct: v.taxRatePct,
      retentionPct: v.retentionPct,
      paymentTermsDays: v.paymentTermsDays,
      expectedDate: v.expectedDate || undefined,
      // type-specific (only the relevant field is set; the rest left undefined)
      milestoneId: type === 'Milestone' ? v.milestoneId || undefined : undefined,
      recurrence: type === 'Recurring' ? v.recurrence : undefined,
      capAmount: type === 'Capped' ? v.capAmount ?? undefined : undefined,
      progressPct: type === 'Progress' ? v.progressPct ?? undefined : undefined,
      markupPct: type === 'Expense' ? v.markupPct ?? undefined : undefined,
    };

    this.saving.set(true);
    const editingId = this.editingId();
    const request$ = editingId
      ? this.api.updateBillingPlanItem(editingId, payload)
      : this.api.createBillingPlanItem({ status: 'Planned', ...payload });

    request$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.itemsRes.reload();
        this.notifications.show(editingId ? 'Billing condition updated.' : 'Billing condition created.', 'success');
        this.saving.set(false);
        this.closeForm();
      },
      error: () => {
        this.notifications.show('Failed to save billing condition.', 'error');
        this.saving.set(false);
      },
    });
  }

  /**
   * Export the currently-FILTERED billing rows as CSV. Per-row amounts stay in their
   * own item.currency (no FX conversion). The button always renders (SSR-safe); the
   * DOM download itself is browser-only, so this handler early-returns under SSR.
   */
  exportCsv(): void {
    if (!this.isBrowser) return;
    const columns: readonly CsvColumn<BillingRow>[] = [
      { key: 'type', header: 'Type', map: r => r.meta.label },
      { key: 'label', header: 'Label', map: r => r.item.label },
      { key: 'contract', header: 'Contract', map: r => r.contractName },
      { key: 'project', header: 'Project', map: r => r.projectName },
      { key: 'trigger', header: 'Trigger', map: r => r.trigger },
      { key: 'amount', header: 'Amount', map: r => r.item.amount },
      { key: 'currency', header: 'Currency', map: r => r.item.currency },
      { key: 'taxPct', header: 'Tax %', map: r => r.item.taxRatePct ?? 0 },
      { key: 'retentionPct', header: 'Retention %', map: r => r.item.retentionPct ?? 0 },
      { key: 'netPayable', header: 'Net Payable', map: r => r.netPayable },
      { key: 'status', header: 'Status', map: r => r.item.status },
      { key: 'due', header: 'Due', map: r => r.due ?? '' },
    ];
    downloadCsv('billing-conditions.csv', toCsv(this.rows(), columns));
  }

  // --- batch selection ---
  isSelected(id: string): boolean {
    return this.selectedIds().has(id);
  }

  toggleRow(id: string, event: Event): void {
    if (this.batchRunning()) return;
    const checked = (event.target as HTMLInputElement).checked;
    const next = new Set(this.selectedIds());
    if (checked) next.add(id);
    else next.delete(id);
    this.selectedIds.set(next);
  }

  toggleSelectAllReady(event: Event): void {
    if (this.batchRunning()) return;
    const checked = (event.target as HTMLInputElement).checked;
    const next = new Set(this.selectedIds());
    const readyIds = this.readyRows().map(r => r.item.id);
    if (checked) readyIds.forEach(id => next.add(id));
    else readyIds.forEach(id => next.delete(id));
    this.selectedIds.set(next);
  }

  // --- row actions ---
  generateInvoice(item: BillingPlanItem): void {
    if (item.status !== 'Ready' || this.busyId()) return;
    this.busyId.set(item.id);
    const issuedDate = new Date().toISOString();

    this.api.createOrder({
      contractId: item.contractId,
      type: 'Customer',
      amount: item.amount,
      currency: item.currency,
      status: 'Invoiced',
      orderDate: issuedDate,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: order => {
        this.api.updateBillingPlanItem(item.id, { status: 'Invoiced', orderId: order.id, issuedDate })
          .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: () => {
              this.itemsRes.reload();
              this.ordersRes.reload();
              this.notifications.show(`Invoice generated for "${item.label}".`, 'success');
              this.busyId.set(null);
            },
            error: () => {
              this.notifications.show('Invoice order created, but condition update failed.', 'error');
              this.busyId.set(null);
            },
          });
      },
      error: () => {
        this.notifications.show('Failed to generate invoice.', 'error');
        this.busyId.set(null);
      },
    });
  }

  /**
   * Generate one Customer invoice per selected Ready condition, processed
   * sequentially: for each item create an Invoiced Order, then stamp the
   * condition (status/orderId/issuedDate). Reloads once at the end.
   */
  generateSelectedInvoices(): void {
    if (this.batchRunning() || this.busyId() !== null) return;

    // Snapshot now: rows can change as the resource reloads underneath us.
    const selected = new Set(this.selectedReadyIds());
    const targets = this.items().filter(i => i.status === 'Ready' && selected.has(i.id));
    if (!targets.length) return;

    this.batchRunning.set(true);
    const issuedDate = new Date().toISOString();

    from(targets)
      .pipe(
        concatMap(item =>
          this.api
            .createOrder({
              contractId: item.contractId,
              type: 'Customer',
              amount: item.amount,
              currency: item.currency,
              status: 'Invoiced',
              orderDate: issuedDate,
            })
            .pipe(
              switchMap(order =>
                this.api.updateBillingPlanItem(item.id, {
                  status: 'Invoiced',
                  orderId: order.id,
                  issuedDate,
                }),
              ),
            ),
        ),
        toArray(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: results => {
          this.itemsRes.reload();
          this.ordersRes.reload();
          this.selectedIds.set(new Set<string>());
          this.batchRunning.set(false);
          const n = results.length;
          this.notifications.show(`Generated ${n} ${n === 1 ? 'invoice' : 'invoices'}.`, 'success');
        },
        error: () => {
          // Some invoices may have been issued before the failure; reload to reflect reality.
          this.itemsRes.reload();
          this.ordersRes.reload();
          this.selectedIds.set(new Set<string>());
          this.batchRunning.set(false);
          this.notifications.show('Invoice batch failed before completing. Review the conditions and retry.', 'error');
        },
      });
  }

  markPaid(item: BillingPlanItem): void {
    if (item.status !== 'Invoiced' || this.busyId()) return;
    this.busyId.set(item.id);
    this.api.updateBillingPlanItem(item.id, { status: 'Paid', paidDate: new Date().toISOString() })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.itemsRes.reload();
          this.notifications.show(`"${item.label}" marked paid.`, 'success');
          this.busyId.set(null);
        },
        error: () => {
          this.notifications.show('Failed to mark condition as paid.', 'error');
          this.busyId.set(null);
        },
      });
  }
}
