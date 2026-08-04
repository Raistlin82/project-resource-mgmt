import { ChangeDetectionStrategy, Component, inject, signal, computed, DestroyRef, effect } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators, AbstractControl, ValidationErrors } from '@angular/forms';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { ApiService, BASE_CURRENCY, Order, Contract, Partner, Project, OrderLine, FxRate } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-orders',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DatePipe, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="command-eyebrow">Commercial</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Orders</h1>
          <p class="mt-2 text-sm text-[var(--cc-muted)]">Customer orders are revenue (incoming, green); purchase orders are cost (outgoing to a partner, shown red and signed &minus;).</p>
        </div>
        <button (click)="showForm.set(true)" class="command-button w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Order
        </button>
      </div>

      <div class="command-card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th scope="col">Contract</th>
                <th scope="col">Project Imputation</th>
                <th scope="col">Type</th>
                <th scope="col">Partner</th>
                <th scope="col" class="num">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Date</th>
              </tr>
            </thead>
            <tbody>
              @for (order of orders(); track order.id) {
                <tr>
                  <td class="font-medium">{{ contractName(order.contractId) }}</td>
                  <td class="text-[var(--cc-muted)]">{{ orderProjectSummary(order.id) }}</td>
                  <td>
                    <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide ring-1"
                          [class.bg-accent-tint]="order.type === 'Customer'"
                          [class.text-accent-text]="order.type === 'Customer'"
                          [class.ring-accent]="order.type === 'Customer'"
                          [class.bg-surface-muted]="order.type === 'Purchase'"
                          [class.text-series-3]="order.type === 'Purchase'"
                          [class.ring-series-3]="order.type === 'Purchase'">
                      {{ order.type }}
                    </span>
                  </td>
                  <td class="text-[var(--cc-muted)]">
                    @if (order.type === 'Purchase') {
                      {{ partnerName(order.partnerId) }}
                    } @else {
                      <span class="text-[var(--cc-muted)]">&mdash;</span>
                    }
                  </td>
                  <td class="num font-semibold"
                      [class.text-positive-text]="order.type === 'Customer'"
                      [class.text-critical-text]="order.type === 'Purchase'"
                      [attr.title]="order.type === 'Customer' ? 'Revenue (incoming)' : 'Cost (outgoing to partner)'">
                    @if (order.type === 'Purchase') {&minus;}{{ order.amount | currency:order.currency }}
                  </td>
                  <td>
                    <span class="command-status"
                          [class.neutral]="order.status === 'Open'"
                          [class.amber]="order.status === 'Invoiced'"
                          [class.green]="order.status === 'Paid'">
                      {{ order.status }}
                    </span>
                  </td>
                  <td class="text-[var(--cc-muted)] font-mono tabular-nums">{{ order.orderDate | date:'mediumDate' }}</td>
                </tr>
              }
              @if (!orders().length) {
                <tr>
                  <td colspan="7">
                    <div class="command-empty">
                      <mat-icon>receipt_long</mat-icon>
                      <h3 class="command-empty-title">No orders yet</h3>
                      <p class="command-empty-note">Create your first customer or purchase order to get started.</p>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    @if (showForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="orderModalTitle" (dismiss)="closeForm()">
        <div class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <div class="command-card-header">
            <h2 id="orderModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">New Order</h2>
            <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Close dialog" title="Close" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors disabled:opacity-50">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="orderForm" (ngSubmit)="saveOrder()" class="space-y-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="contractId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Contract *</label>
                  <select id="contractId" formControlName="contractId" class="command-select">
                    <option value="">Select a contract...</option>
                    @for (contract of contracts(); track contract.id) {
                      <option [value]="contract.id">{{ contract.name }}</option>
                    }
                  </select>
                </div>

                <div>
                  <label for="type" class="block text-sm font-semibold text-ink-secondary mb-1.5">Type *</label>
                  <select id="type" formControlName="type" class="command-select">
                    <option value="Customer">Customer</option>
                    <option value="Purchase">Purchase</option>
                  </select>
                </div>

                @if (selectedType() === 'Purchase') {
                  <div>
                    <label for="partnerId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Partner</label>
                    <select id="partnerId" formControlName="partnerId" class="command-select">
                      <option value="">Select a partner...</option>
                      @for (partner of partners(); track partner.id) {
                        <option [value]="partner.id">{{ partner.company }}</option>
                      }
                    </select>
                  </div>
                }

                <div>
                  <label for="amount" class="block text-sm font-semibold text-ink-secondary mb-1.5">Amount *</label>
                  <input id="amount" type="number" formControlName="amount" class="command-input" placeholder="0.00">
                </div>

                <div>
                  <label for="projectId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Project Imputation *</label>
                  <select id="projectId" formControlName="projectId" class="command-select">
                    <option value="">Select a project...</option>
                    @for (project of projectsForSelectedContract(); track project.id) {
                      <option [value]="project.id">{{ project.name }}</option>
                    }
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="lineDescription" class="block text-sm font-semibold text-ink-secondary mb-1.5">Line Description</label>
                  <input id="lineDescription" type="text" formControlName="lineDescription" class="command-input" placeholder="e.g. Phase 1 delivery">
                </div>

                <div>
                  <label for="currency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                  <select id="currency" formControlName="currency" class="command-select">
                    @for (option of currencyOptions(); track option.code) {
                      <option [value]="option.code" [disabled]="option.orphan">{{ option.label }}</option>
                    }
                  </select>
                </div>

                <div>
                  <label for="status" class="block text-sm font-semibold text-ink-secondary mb-1.5">Status *</label>
                  <select id="status" formControlName="status" class="command-select">
                    <option value="Open">Open</option>
                    <option value="Confirmed">Confirmed</option>
                    <option value="Invoiced">Invoiced</option>
                    <option value="Paid">Paid</option>
                  </select>
                </div>

                <div>
                  <label for="orderDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Order Date *</label>
                  <input id="orderDate" type="date" formControlName="orderDate" class="command-input">
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeForm()" [disabled]="saving()" class="command-button secondary">Cancel</button>
            <button type="button" (click)="saveOrder()" [disabled]="orderForm.invalid || saving()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              {{ saving() ? 'Creating…' : 'Create Order' }}
            </button>
          </div>
        </div>
      </div>
    }
  `
})
export class Orders {
  private api = inject(ApiService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);
  private auth = inject(AuthService);

  // orders, contracts and order-lines are principal-gated server-side (401 until
  // a verified JWT is attached). Gate each on authReady() so the request fires
  // only AFTER the OAuth bootstrap has settled and the interceptor can attach the
  // bearer token; firing earlier (on a reload/deep-link) 401'd and latched the
  // resource into an error/empty state. authReady false->true re-runs the stream.
  private ordersRes = rxResource<Order[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getOrders() : of<Order[]>([])),
    defaultValue: [] as Order[],
  });
  private contractsRes = rxResource<Contract[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getContracts() : of<Contract[]>([])),
    defaultValue: [] as Contract[],
  });
  private partnersRes = rxResource({ stream: () => this.api.getProjectPartners(), defaultValue: [] as Partner[] });
  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  // REFERENCE-DATA INTEGRITY (Phase B): `currency` is a config-value FK to the
  // configured currency set (fx-rates). Gated on authReady() with the other
  // principal-gated reads so it re-runs when the bearer token attaches.
  private fxRatesRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getFxRates() : of<FxRate[]>([])),
    defaultValue: [] as FxRate[],
  });
  private orderLinesRes = rxResource<OrderLine[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getOrderLines() : of<OrderLine[]>([])),
    defaultValue: [] as OrderLine[],
  });

  orders = this.ordersRes.value;
  contracts = this.contractsRes.value;
  partners = this.partnersRes.value;
  projects = this.projectsRes.value;
  orderLines = this.orderLinesRes.value;
  fxRates = this.fxRatesRes.value;

  showForm = signal(false);
  saving = signal(false);
  private orderSubmissionKey: string | null = null;

  orderForm = new FormGroup({
    contractId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    type: new FormControl<'Customer' | 'Purchase'>('Customer', { nonNullable: true, validators: Validators.required }),
    partnerId: new FormControl('', { nonNullable: true }),
    amount: new FormControl<number | null>(null, { validators: [Validators.required, Validators.min(0)] }),
    projectId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    lineDescription: new FormControl('', { nonNullable: true }),
    currency: new FormControl(BASE_CURRENCY, { nonNullable: true, validators: Validators.required }),
    status: new FormControl<'Open' | 'Confirmed' | 'Invoiced' | 'Paid'>('Open', { nonNullable: true, validators: Validators.required }),
    orderDate: new FormControl('', { nonNullable: true, validators: Validators.required })
  }, { validators: Orders.partnerTypeValidator });

  // Cross-field rule: a Purchase order must name a partner; a Customer order must not.
  private static partnerTypeValidator(control: AbstractControl): ValidationErrors | null {
    const type = control.get('type')?.value as 'Customer' | 'Purchase' | undefined;
    const partnerId = (control.get('partnerId')?.value as string | undefined)?.trim() ?? '';
    if (type === 'Purchase' && !partnerId) {
      return { partnerRequired: true };
    }
    if (type === 'Customer' && partnerId) {
      return { partnerNotAllowed: true };
    }
    return null;
  }

  private contractsById = computed(() => new Map(this.contracts().map(c => [c.id, c.name])));
  private partnersById = computed(() => new Map(this.partners().map(p => [p.id, p.company])));
  private projectsById = computed(() => new Map(this.projects().map(p => [p.id, p.name])));

  // Mirror the form's type control into a signal (auto-cleaned, no manual subscribe)
  selectedType = toSignal(this.orderForm.controls.type.valueChanges, { initialValue: this.orderForm.controls.type.value });
  selectedContractId = toSignal(this.orderForm.controls.contractId.valueChanges, { initialValue: this.orderForm.controls.contractId.value });

  projectsForSelectedContract = computed(() => {
    const contractId = this.selectedContractId();
    if (!contractId) return this.projects();
    const linked = this.projects().filter(p => p.contractId === contractId);
    return linked.length ? linked : this.projects();
  });

  // --- currency (Phase B) ---
  private contractCurrencyById = computed(() => new Map(this.contracts().map(c => [c.id, c.currency])));
  private currencyValue = toSignal(this.orderForm.controls.currency.valueChanges, {
    initialValue: this.orderForm.controls.currency.value,
  });

  /**
   * Currency options: configured currency codes from fx-rates (label = value =
   * code). An orphan value (the control holds a code not in the configured set,
   * e.g. an existing record's legacy currency) is injected as a disabled
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

  constructor() {
    /**
     * Default an order's currency to its parent contract's currency when a contract
     * is selected (an order is a child of a contract), falling back to the base
     * currency. Only steers the default while the form is untouched by the user, so
     * a manual currency choice is never overwritten. Registered as a bare effect()
     * (run for its side-effect) rather than an unused private field.
     */
    effect(() => {
      const contractId = this.selectedContractId();
      const ctrl = this.orderForm.controls.currency;
      if (ctrl.dirty) return;
      const next = (contractId && this.contractCurrencyById().get(contractId)) || BASE_CURRENCY;
      if (ctrl.value !== next) ctrl.setValue(next);
    });
  }

  contractName(id: string): string {
    return this.contractsById().get(id) ?? id;
  }

  partnerName(id: string | undefined): string {
    if (!id) return '';
    return this.partnersById().get(id) ?? id;
  }

  orderProjectSummary(orderId: string): string {
    const lines = this.orderLines().filter(l => l.orderId === orderId);
    if (!lines.length) return 'No project line';
    return lines
      .map(line => `${this.projectsById().get(line.projectId) ?? line.projectId} (${line.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${this.orders().find(o => o.id === orderId)?.currency ?? ''})`)
      .join(', ');
  }

  saveOrder(): void {
    if (this.orderForm.invalid || this.saving()) return;

    const raw = this.orderForm.getRawValue();
    const payload: Partial<Order> = {
      contractId: raw.contractId,
      type: raw.type,
      amount: raw.amount ?? 0,
      currency: raw.currency,
      status: raw.status,
      orderDate: raw.orderDate
    };
    if (raw.type === 'Purchase' && raw.partnerId) {
      payload.partnerId = raw.partnerId;
    }

    this.orderSubmissionKey ??= globalThis.crypto?.randomUUID?.()
      ?? `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.saving.set(true);
    this.api.createOrderWithLine({
      idempotencyKey: this.orderSubmissionKey,
      order: payload,
      line: {
        projectId: raw.projectId,
        description: raw.lineDescription || `${raw.type} order imputation`,
        amount: raw.amount ?? 0,
      },
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.ordersRes.reload();
        this.orderLinesRes.reload();
        this.notifications.show('Order created and imputed to project.', 'success');
        this.saving.set(false);
        this.closeForm();
      },
      error: () => {
        this.saving.set(false);
        this.notifications.show('Failed to create order. You can safely retry.', 'error');
      },
    });
  }

  closeForm(): void {
    if (this.saving()) return;
    this.showForm.set(false);
    this.orderSubmissionKey = null;
    this.orderForm.reset({ contractId: '', type: 'Customer', partnerId: '', amount: null, projectId: '', lineDescription: '', currency: BASE_CURRENCY, status: 'Open', orderDate: '' });
  }
}
