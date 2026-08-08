import { ChangeDetectionStrategy, Component, inject, signal, computed, DestroyRef, effect } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SEARCH_FOCUS_PARAM } from '../../services/search-target.util';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators, AbstractControl, ValidationErrors } from '@angular/forms';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { ApiService, BASE_CURRENCY, Order, Contract, Partner, Project, OrderLine, FxRate } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { authGatedResource } from '../../services/auth-gated-resource.util';
import { SearchFilterBarComponent } from '../../shared/search-filter-bar.component';
import { ListStateComponent } from '../../shared/list-state.component';

@Component({
  selector: 'app-orders',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DatePipe, ReactiveFormsModule, ModalDialogDirective, SearchFilterBarComponent, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="command-eyebrow">Commercial</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Orders</h1>
          <p class="mt-2 text-sm text-[var(--cc-muted)]">Customer orders are revenue (incoming, green); purchase orders are cost (outgoing to a partner, shown red and signed &minus;).</p>
        </div>
        <button type="button" (click)="openForm()" aria-label="Create a new Open order" title="Create a new Open order" class="command-button w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Order
        </button>
      </div>

      <section aria-labelledby="ordersListHeading">
        <h2 id="ordersListHeading" class="sr-only">Order list</h2>
        <app-list-state
          [loading]="listLoading()"
          [error]="listReadFailed()"
          skeleton="table-rows"
          [rows]="6"
          [columns]="7"
          label="orders"
          (retry)="reloadList()">
          <ng-template>
          @if (!orders().length) {
            <div data-test="orders-source-empty" class="command-card p-10 sm:p-12 text-center border-2 border-dashed">
              <mat-icon class="text-ink-muted text-4xl mb-3">receipt_long</mat-icon>
              <h3 class="command-empty-title">No orders yet</h3>
              <p class="command-empty-note mb-5">Create the first Open customer or purchase order and impute it to a project.</p>
              <button type="button" (click)="openForm()" aria-label="Create the first Open order" class="command-button mx-auto">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> Create first order
              </button>
            </div>
          } @else {
            <app-search-filter-bar
              [query]="orderQuery()"
              placeholder="Search orders by invoice number or order ID..."
              (queryChange)="orderQuery.set($event)"
              (clearAll)="clearFilters()"
            />

            <div class="command-card overflow-hidden mt-6">
              <p id="ordersTablePanHint" data-test="orders-table-pan-hint" class="border-b border-line bg-surface-muted px-4 py-2 text-xs font-semibold text-ink-muted lg:hidden">
                Swipe horizontally for all order fields. Contract and order ID stay visible.
              </p>
              <div data-test="orders-table-pan" class="overflow-x-auto overscroll-x-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" role="region" tabindex="0"
                   aria-label="Orders table" aria-describedby="ordersTablePanHint">
                <table class="command-data-table min-w-[860px]">
                  <caption class="sr-only">Customer and purchase orders</caption>
                  <thead>
                    <tr>
                      <th scope="col" class="sticky left-0 z-10 bg-surface-muted!">Contract</th>
                      <th scope="col">Project Imputation</th>
                      <th scope="col">Type</th>
                      <th scope="col">Partner</th>
                      <th scope="col" class="num">Amount</th>
                      <th scope="col">Status</th>
                      <th scope="col">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (order of filteredOrders(); track order.id) {
                      <tr>
                        <td class="sticky left-0 z-[1] bg-surface! font-medium">
                          {{ contractName(order.contractId) }}
                          <div class="mt-0.5 text-xs font-mono font-normal text-[var(--cc-muted)] break-all">{{ order.invoiceNumber || order.id }}</div>
                        </td>
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
                            [attr.title]="(order.type === 'Customer' ? 'Revenue for ' : 'Cost for ') + (order.invoiceNumber || order.id)">
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
                    @if (!filteredOrders().length) {
                      <tr data-test="orders-filtered-empty">
                        <td colspan="7">
                          <div class="command-empty">
                            <mat-icon>search_off</mat-icon>
                            <h3 class="command-empty-title">No orders match your filters</h3>
                            <p class="command-empty-note">No invoice number or order ID matches “{{ orderQuery().trim() }}”.</p>
                            <button type="button" (click)="clearFilters()" aria-label="Clear order filters" class="command-button secondary mt-4">Clear filters</button>
                          </div>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>
          }
          </ng-template>
        </app-list-state>
      </section>
    </div>

    @if (showForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="orderModalTitle" (dismiss)="closeForm()">
        <div class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]" [attr.aria-busy]="saving()">
          <div class="command-card-header">
            <h2 id="orderModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Create Open Order</h2>
            <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Close new order dialog" title="Close new order dialog" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors disabled:opacity-50">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="orderForm" (ngSubmit)="saveOrder()" class="space-y-6">
              @if (formError(); as message) {
                <div data-test="order-form-error" class="command-card border-critical! bg-critical-tint p-4 text-sm text-critical-text" role="alert">
                  {{ message }}
                </div>
              }
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="contractId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Contract *</label>
                  <select id="contractId" formControlName="contractId" class="command-select" required
                          [attr.aria-invalid]="showControlError(orderForm.controls.contractId)"
                          [attr.aria-describedby]="showControlError(orderForm.controls.contractId) ? 'contractIdError' : null">
                    <option value="">Select a contract...</option>
                    @for (contract of contracts(); track contract.id) {
                      <option [value]="contract.id">{{ contract.name }}</option>
                    }
                  </select>
                  @if (showControlError(orderForm.controls.contractId)) {
                    <p id="contractIdError" class="command-field-error" role="alert">Select a contract.</p>
                  }
                </div>

                <div>
                  <label for="type" class="block text-sm font-semibold text-ink-secondary mb-1.5">Type *</label>
                  <select id="type" formControlName="type" class="command-select" required>
                    <option value="Customer">Customer</option>
                    <option value="Purchase">Purchase</option>
                  </select>
                </div>

                @if (selectedType() === 'Purchase') {
                  <div>
                    <label for="partnerId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Partner *</label>
                    <select id="partnerId" formControlName="partnerId" class="command-select" required
                            [attr.aria-invalid]="partnerErrorVisible()"
                            [attr.aria-describedby]="partnerErrorVisible() ? 'partnerIdError' : null">
                      <option value="">Select a partner...</option>
                      @for (partner of partners(); track partner.id) {
                        <option [value]="partner.id">{{ partner.company }}</option>
                      }
                    </select>
                    @if (partnerErrorVisible()) {
                      <p id="partnerIdError" class="command-field-error" role="alert">Select a partner for a purchase order.</p>
                    }
                  </div>
                }

                <div>
                  <label for="amount" class="block text-sm font-semibold text-ink-secondary mb-1.5">Amount *</label>
                  <input id="amount" type="number" formControlName="amount" class="command-input" placeholder="0.00" min="0" step="0.01" required
                         [attr.aria-invalid]="showControlError(orderForm.controls.amount)"
                         [attr.aria-describedby]="showControlError(orderForm.controls.amount) ? 'amountError' : null">
                  @if (showControlError(orderForm.controls.amount)) {
                    <p id="amountError" class="command-field-error" role="alert">
                      {{ orderForm.controls.amount.hasError('required') ? 'Enter an amount.' : 'Amount must be zero or greater.' }}
                    </p>
                  }
                </div>

                <div>
                  <label for="projectId" class="block text-sm font-semibold text-ink-secondary mb-1.5">Project Imputation *</label>
                  <select id="projectId" formControlName="projectId" class="command-select" required
                          [attr.aria-invalid]="projectErrorVisible()"
                          [attr.aria-describedby]="projectErrorVisible() ? 'projectIdHint projectIdError' : 'projectIdHint'">
                    <option value="">{{ orderForm.controls.contractId.value ? 'Select a project...' : 'Select a contract first...' }}</option>
                    @for (project of projectsForSelectedContract(); track project.id) {
                      <option [value]="project.id">{{ project.name }}</option>
                    }
                  </select>
                  <p id="projectIdHint" class="mt-1 text-xs text-[var(--cc-muted)]">Only projects linked to the selected contract are eligible.</p>
                  @if (projectErrorVisible()) {
                    <p id="projectIdError" class="command-field-error" role="alert">{{ projectErrorMessage() }}</p>
                  } @else if (orderForm.controls.contractId.value && !projectsForSelectedContract().length) {
                    <p class="command-field-error" role="status">No project is linked to this contract. Link a project before creating the order.</p>
                  }
                </div>

                <div class="sm:col-span-2">
                  <label for="lineDescription" class="block text-sm font-semibold text-ink-secondary mb-1.5">Line Description</label>
                  <input id="lineDescription" type="text" formControlName="lineDescription" class="command-input" placeholder="e.g. Phase 1 delivery">
                </div>

                <div>
                  <label for="currency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                  <select id="currency" formControlName="currency" class="command-select" required
                          [attr.aria-invalid]="showControlError(orderForm.controls.currency)"
                          [attr.aria-describedby]="showControlError(orderForm.controls.currency) ? 'currencyError' : null">
                    @for (option of currencyOptions(); track option.code) {
                      <option [value]="option.code" [disabled]="option.orphan">{{ option.label }}</option>
                    }
                  </select>
                  @if (showControlError(orderForm.controls.currency)) {
                    <p id="currencyError" class="command-field-error" role="alert">Select a configured currency.</p>
                  }
                </div>

                <div>
                  <label for="status" class="block text-sm font-semibold text-ink-secondary mb-1.5">Initial Status</label>
                  <input id="status" type="text" formControlName="status" class="command-input bg-[var(--cc-panel-muted)]" readonly aria-describedby="statusHint">
                  <p id="statusHint" class="mt-1 text-xs text-[var(--cc-muted)]">New orders start Open. Invoicing and payment are lifecycle actions in Billing.</p>
                </div>

                <div>
                  <label for="orderDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Order Date *</label>
                  <input id="orderDate" type="date" formControlName="orderDate" class="command-input" required
                         [attr.aria-invalid]="showControlError(orderForm.controls.orderDate)"
                         [attr.aria-describedby]="showControlError(orderForm.controls.orderDate) ? 'orderDateError' : null">
                  @if (showControlError(orderForm.controls.orderDate)) {
                    <p id="orderDateError" class="command-field-error" role="alert">Select an order date.</p>
                  }
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Cancel new order creation" class="command-button secondary">Cancel</button>
            <button type="button" (click)="saveOrder()" [disabled]="saving()" aria-label="Create Open order and impute it to the selected project" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              {{ saving() ? 'Creating Open order…' : 'Create Open Order' }}
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
  private partnersRes = authGatedResource(() => this.api.getProjectPartners(), [] as Partner[]);
  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
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

  protected readonly listLoading = computed(() => !this.auth.authReady()
    || this.ordersRes.isLoading() || this.contractsRes.isLoading()
    || this.partnersRes.isLoading() || this.projectsRes.isLoading()
    || this.orderLinesRes.isLoading());
  protected readonly listReadFailed = computed(() => this.ordersRes.status() === 'error'
    || this.contractsRes.status() === 'error' || this.partnersRes.status() === 'error'
    || this.projectsRes.status() === 'error' || this.orderLinesRes.status() === 'error');

  orders = computed(() => this.ordersRes.status() === 'error' ? [] : this.ordersRes.value());
  contracts = computed(() => this.contractsRes.status() === 'error' ? [] : this.contractsRes.value());
  partners = computed(() => this.partnersRes.status() === 'error' ? [] : this.partnersRes.value());
  projects = computed(() => this.projectsRes.status() === 'error' ? [] : this.projectsRes.value());
  orderLines = computed(() => this.orderLinesRes.status() === 'error' ? [] : this.orderLinesRes.value());
  fxRates = computed(() => this.fxRatesRes.status() === 'error' ? [] : this.fxRatesRes.value());

  protected reloadList(): void {
    this.ordersRes.reload();
    this.contractsRes.reload();
    this.partnersRes.reload();
    this.projectsRes.reload();
    this.orderLinesRes.reload();
  }

  // First-ever filter on this screen (design spec §8). Orders have no `name`
  // field (api.service.ts:660-672) -- match on `invoiceNumber` when present,
  // falling back to `id`, the SAME field choice server.ts's own /orders?q=
  // handler makes (Task 2 Step 7) and spec §11's field table records, so a
  // search that matches here matches the same way through /orders?q= too.
  /**
   * Seeds this list's filter from `?q=`, so a /search hit can land on the row it
   * named instead of on an unfiltered list (search-target.util).
   *
   * Read ONCE from the snapshot in a field initialiser, not subscribed: this
   * seeds a starting value the user is then free to change, and a live
   * subscription would fight every keystroke by writing the stale param back.
   * A blank or whitespace-only `q` is ignored, so `?q=` alone cannot look like a
   * filter the user had already cleared.
   */
  private seededQuery = inject(ActivatedRoute).snapshot.queryParamMap.get(SEARCH_FOCUS_PARAM)?.trim() ?? '';
  protected orderQuery = signal(this.seededQuery);
  protected filteredOrders = computed(() => {
    const q = this.orderQuery().trim().toLowerCase();
    const all = this.orders();
    return q ? all.filter(o => (o.invoiceNumber ?? o.id).toLowerCase().includes(q)) : all;
  });

  protected clearFilters(): void {
    this.orderQuery.set('');
  }

  showForm = signal(false);
  saving = signal(false);
  protected formError = signal<string | null>(null);
  private submitAttempted = signal(false);
  private orderSubmissionKey: string | null = null;
  /**
   * The payload the current `orderSubmissionKey` was minted for. The server derives
   * the order id FROM the key (orderIdsForRequest, commercial-write.util.ts) and
   * 409s 'idempotencyKey is already used by a different order' whenever the stored
   * order under that key differs from the candidate — so a key held across an EDIT
   * refuses the corrected figure forever. Rotating on a payload change is what makes
   * a correction submittable; holding the key when the payload is UNCHANGED is what
   * preserves the replay dedup the same function relies on.
   */
  private orderSubmissionFingerprint: string | null = null;

  private readonly projectContractValidator = (control: AbstractControl): ValidationErrors | null => {
    const contractId = (control.get('contractId')?.value as string | undefined)?.trim() ?? '';
    const projectId = (control.get('projectId')?.value as string | undefined)?.trim() ?? '';
    if (!contractId || !projectId) return null;
    const project = this.projects().find(candidate => candidate.id === projectId);
    return project?.contractId === contractId ? null : { projectContractMismatch: true };
  };

  orderForm = new FormGroup({
    contractId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    type: new FormControl<'Customer' | 'Purchase'>('Customer', { nonNullable: true, validators: Validators.required }),
    partnerId: new FormControl('', { nonNullable: true }),
    amount: new FormControl<number | null>(null, { validators: [Validators.required, Validators.min(0)] }),
    projectId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    lineDescription: new FormControl('', { nonNullable: true }),
    currency: new FormControl(BASE_CURRENCY, { nonNullable: true, validators: Validators.required }),
    status: new FormControl<'Open'>('Open', { nonNullable: true, validators: Validators.required }),
    orderDate: new FormControl('', { nonNullable: true, validators: Validators.required })
  }, { validators: [Orders.partnerTypeValidator, this.projectContractValidator] });

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
    if (!contractId) return [];
    return this.projects().filter(project => project.contractId === contractId);
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

    // A Customer order cannot carry a stale Purchase partner. Clearing it when
    // the type changes prevents a hidden group error from trapping the form.
    effect(() => {
      if (this.selectedType() !== 'Customer') return;
      const partner = this.orderForm.controls.partnerId;
      if (partner.value) partner.setValue('');
    });

    // Project imputation belongs to the selected contract. Reference data arrives
    // asynchronously, so revalidate when it resolves; when the parent contract
    // changes, discard an ineligible stale project rather than submit a known 409.
    effect(() => {
      const contractId = this.selectedContractId();
      const projects = this.projects();
      const project = this.orderForm.controls.projectId;
      if (project.value && !projects.some(candidate => candidate.id === project.value && candidate.contractId === contractId)) {
        project.setValue('');
      }
      this.orderForm.updateValueAndValidity({ emitEvent: false });
    });
  }

  openForm(): void {
    this.submitAttempted.set(false);
    this.formError.set(null);
    this.orderForm.controls.status.setValue('Open');
    this.showForm.set(true);
  }

  protected showControlError(control: AbstractControl): boolean {
    return control.invalid && (control.touched || control.dirty || this.submitAttempted());
  }

  protected partnerErrorVisible(): boolean {
    const partner = this.orderForm.controls.partnerId;
    return this.orderForm.hasError('partnerRequired')
      && (partner.touched || partner.dirty || this.submitAttempted());
  }

  protected projectErrorVisible(): boolean {
    const project = this.orderForm.controls.projectId;
    return (project.invalid || this.orderForm.hasError('projectContractMismatch'))
      && (project.touched || project.dirty || this.submitAttempted());
  }

  protected projectErrorMessage(): string {
    return this.orderForm.hasError('projectContractMismatch')
      ? 'Select a project linked to the chosen contract.'
      : 'Select a project for the order imputation.';
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
    if (this.saving()) return;
    this.submitAttempted.set(true);
    this.formError.set(null);
    this.orderForm.updateValueAndValidity();
    if (this.orderForm.invalid) {
      this.orderForm.markAllAsTouched();
      this.formError.set('Review the highlighted fields before creating the order.');
      return;
    }

    const raw = this.orderForm.getRawValue();
    const payload: Partial<Order> = {
      contractId: raw.contractId,
      type: raw.type,
      amount: raw.amount ?? 0,
      currency: raw.currency,
      // Open is the only manual creation state. Invoiced/Paid are assigned by
      // billing lifecycle commands; keeping the literal here also prevents a
      // programmatic mutation of the read-only control from bypassing the UI.
      status: 'Open',
      orderDate: raw.orderDate
    };
    if (raw.type === 'Purchase' && raw.partnerId) {
      payload.partnerId = raw.partnerId;
    }

    const line = {
      projectId: raw.projectId,
      description: raw.lineDescription || `${raw.type} order imputation`,
      amount: raw.amount ?? 0,
    };

    // ROTATE THE KEY ONLY WHEN THE PAYLOAD ACTUALLY CHANGED. `??=` alone pinned one
    // key to the whole dialog session: after a lost response the user would correct
    // the amount, resubmit, and be 409ed on every click thereafter, with no way to
    // record the correction. Always minting a fresh key is the opposite error — it
    // destroys the replay dedup, so a genuine retry of the SAME payload would create
    // a second order.
    const fingerprint = Orders.submissionFingerprint(payload, line);
    if (this.orderSubmissionKey === null || this.orderSubmissionFingerprint !== fingerprint) {
      this.orderSubmissionKey = globalThis.crypto?.randomUUID?.()
        ?? `order-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.orderSubmissionFingerprint = fingerprint;
    }

    this.saving.set(true);
    this.api.createOrderWithLine({
      idempotencyKey: this.orderSubmissionKey,
      order: payload,
      line,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.ordersRes.reload();
        this.orderLinesRes.reload();
        this.notifications.show('Order created and imputed to project.', 'success');
        this.saving.set(false);
        this.closeForm();
      },
      error: (error: { error?: { error?: string } }) => {
        this.saving.set(false);
        // RELOAD ON FAILURE. The response being lost (proxy 504, suspended tab) does
        // NOT mean the write was refused — the order may well have committed. Without
        // this the list behind the dialog kept showing the pre-submit state, so the
        // committed order was invisible and the user's only evidence was an error.
        this.ordersRes.reload();
        this.orderLinesRes.reload();
        const message = error.error?.error
          ?? 'Failed to create order. Check the list behind this dialog before retrying — it may already have been created.';
        this.formError.set(message);
        this.notifications.show(message, 'error');
      },
    });
  }

  /**
   * A stable, total fingerprint of everything the server compares under a key
   * (sameOrder / sameOrderLine). Field order is fixed by these literals, and every
   * field is listed explicitly so an absent `partnerId` cannot make two different
   * payloads fingerprint alike.
   */
  private static submissionFingerprint(
    order: Partial<Order>,
    line: { projectId: string; description: string; amount: number },
  ): string {
    return JSON.stringify([
      order.contractId ?? '', order.type ?? '', order.partnerId ?? '', order.amount ?? 0,
      order.currency ?? '', order.status ?? '', order.orderDate ?? '',
      line.projectId, line.description, line.amount,
    ]);
  }

  closeForm(): void {
    if (this.saving()) return;
    this.showForm.set(false);
    this.submitAttempted.set(false);
    this.formError.set(null);
    this.orderSubmissionKey = null;
    this.orderSubmissionFingerprint = null;
    this.orderForm.reset({ contractId: '', type: 'Customer', partnerId: '', amount: null, projectId: '', lineDescription: '', currency: BASE_CURRENCY, status: 'Open', orderDate: '' });
  }
}
