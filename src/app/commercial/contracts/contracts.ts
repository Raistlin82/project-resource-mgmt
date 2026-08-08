import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, afterRenderEffect, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { RouterLink } from '@angular/router';
import { ApiService, BASE_CURRENCY, Contract, Customer, FxRate } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { endNotBeforeStart } from '../../services/date-range.validator';
import { SearchFilterBarComponent } from '../../shared/search-filter-bar.component';
import { ListStateComponent } from '../../shared/list-state.component';

type ContractField = 'customerId' | 'name' | 'type' | 'status' | 'totalValue' | 'currency' | 'startDate' | 'endDate';

@Component({
  selector: 'app-contracts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, MatIconModule, ReactiveFormsModule, RouterLink, ModalDialogDirective, SearchFilterBarComponent, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="command-eyebrow">Commercial</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Contracts</h1>
          <p class="mt-2 text-sm text-[var(--cc-muted)]">Manage customer contracts and their commercial terms.</p>
        </div>
        <button type="button" (click)="openForm()" class="command-button w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Contract
        </button>
      </div>

      <app-search-filter-bar
        [query]="contractQuery()"
        placeholder="Search contracts by name..."
        (queryChange)="contractQuery.set($event)"
        (clearAll)="contractQuery.set('')"
      />

      <!-- Contracts Table -->
      <app-list-state [loading]="listLoading()" [error]="listError()" skeleton="table-rows" [rows]="5" [columns]="6" label="contracts" (retry)="reloadList()">
      <ng-template>
      <div class="command-card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Customer</th>
                <th scope="col">Type</th>
                <th scope="col" class="num">Total Value</th>
                <th scope="col">Status</th>
                <th scope="col">Dates</th>
              </tr>
            </thead>
            <tbody>
              @for (c of filteredContracts(); track c.id) {
                <tr>
                  <td class="font-semibold">
                    <a [routerLink]="['/contracts', c.id]" class="hover:text-accent-text transition-colors">{{ c.name }}</a>
                  </td>
                  <td class="text-[var(--cc-muted)]">{{ customerName(c.customerId) }}</td>
                  <td class="text-[var(--cc-muted)]">{{ c.type }}</td>
                  <td class="num font-semibold">{{ c.totalValue | currency:c.currency }}</td>
                  <td>
                    <span class="command-status"
                          [class.green]="c.status === 'Active'"
                          [class.neutral]="c.status === 'Draft'">
                      {{ c.status }}
                    </span>
                  </td>
                  <td class="text-[var(--cc-muted)] whitespace-nowrap">
                    {{ c.startDate | date:'mediumDate' }} - {{ c.endDate | date:'mediumDate' }}
                  </td>
                </tr>
              }
              @if (!contracts().length) {
                <tr>
                  <td colspan="6">
                    <div class="command-empty" data-test="contracts-source-empty">
                      <mat-icon>description</mat-icon>
                      <h3 class="command-empty-title">No contracts yet</h3>
                      <p class="command-empty-note">Create your first contract to get started.</p>
                      <button type="button" (click)="openForm()" class="command-button mt-4">Create contract</button>
                    </div>
                  </td>
                </tr>
              } @else if (!filteredContracts().length) {
                <tr>
                  <td colspan="6">
                    <div class="command-empty" data-test="contracts-filtered-empty">
                      <mat-icon>search_off</mat-icon>
                      <h3 class="command-empty-title">No contracts match your search</h3>
                      <p class="command-empty-note break-words">No contract name contains “{{ contractQuery() }}”.</p>
                      <button type="button" (click)="contractQuery.set('')" class="command-button secondary mt-4">Clear filters</button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      </ng-template>
      </app-list-state>
    </div>

    <!--
      SCROLL-SAFE OVERLAY (same shape as manage-rate-cards.component.ts:104-124 and
      the billing create/edit overlay). Nine fields plus a header and a pinned footer
      makes this the tallest form in the commercial chain. A POSITION:FIXED box cannot
      be scrolled by the page, so "flex items-center" split the overflow above and
      below the centre: on a short viewport the Customer select went above y=0 and
      "Create Contract" below the fold, with no scroller anywhere — a contract could
      be filled in and never created. The overlay now owns a scroller, anchors to the
      top on short viewports and re-centres from the "sm" breakpoint up; the panel stays bounded by
      max-h-[90vh] and its body scrolls, which keeps the footer reachable.
    -->
    @if (showForm()) {
      <div data-test="contract-form-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
           appModal ariaLabelledby="contractModalTitle" (dismiss)="closeForm()">
        <div data-test="contract-form-panel" class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]" [attr.aria-busy]="saving()">
          <div class="command-card-header">
            <h2 id="contractModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">New Contract</h2>
            <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Close new contract dialog" title="Close new contract dialog" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors disabled:opacity-50">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1 min-h-0">
            <form id="contractCreateForm" [formGroup]="contractForm" (ngSubmit)="save()" class="space-y-6">
              @if (formError(); as message) {
                <div data-test="contract-form-error" class="rounded-md border border-critical bg-critical-tint p-4 text-sm font-semibold text-critical-text" role="alert">
                  {{ message }}
                </div>
              }
              <fieldset [disabled]="saving()" class="contents">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="contractCustomer" class="block text-sm font-semibold text-ink-secondary mb-1.5">Customer *</label>
                  <select id="contractCustomer" formControlName="customerId" class="command-select" required aria-required="true"
                          [attr.aria-invalid]="showFieldError('customerId') ? 'true' : null"
                          [attr.aria-describedby]="showFieldError('customerId') ? 'contractCustomerError' : null">
                    <option value="">Select a customer...</option>
                    @for (customer of customers(); track customer.id) {
                      <option [value]="customer.id">{{ customer.name }}</option>
                    }
                  </select>
                  @if (showFieldError('customerId')) {
                    <p id="contractCustomerError" class="command-field-error" role="alert">Select a customer.</p>
                  }
                </div>

                <div class="sm:col-span-2">
                  <label for="contractName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Name *</label>
                  <input id="contractName" type="text" formControlName="name" class="command-input" placeholder="e.g. Master Services Agreement" required aria-required="true"
                         [attr.aria-invalid]="showFieldError('name') ? 'true' : null"
                         [attr.aria-describedby]="showFieldError('name') ? 'contractNameError' : null">
                  @if (showFieldError('name')) {
                    <p id="contractNameError" class="command-field-error" role="alert">Enter a contract name.</p>
                  }
                </div>

                <div>
                  <label for="contractType" class="block text-sm font-semibold text-ink-secondary mb-1.5">Type *</label>
                  <select id="contractType" formControlName="type" class="command-select" required aria-required="true"
                          [attr.aria-invalid]="showFieldError('type') ? 'true' : null"
                          [attr.aria-describedby]="showFieldError('type') ? 'contractTypeError' : null">
                    <option value="T&M">T&M</option>
                    <option value="Fixed Price">Fixed Price</option>
                    <option value="Framework">Framework</option>
                  </select>
                  @if (showFieldError('type')) {
                    <p id="contractTypeError" class="command-field-error" role="alert">Select a contract type.</p>
                  }
                </div>

                <div>
                  <label for="contractStatus" class="block text-sm font-semibold text-ink-secondary mb-1.5">Status *</label>
                  <select id="contractStatus" formControlName="status" class="command-select" required aria-required="true"
                          [attr.aria-invalid]="showFieldError('status') ? 'true' : null"
                          [attr.aria-describedby]="showFieldError('status') ? 'contractStatusError' : null">
                    <option value="Draft">Draft</option>
                    <option value="Active">Active</option>
                    <option value="Closed">Closed</option>
                  </select>
                  @if (showFieldError('status')) {
                    <p id="contractStatusError" class="command-field-error" role="alert">Select a contract status.</p>
                  }
                </div>

                <div>
                  <label for="contractTotalValue" class="block text-sm font-semibold text-ink-secondary mb-1.5">Total Value *</label>
                  <input id="contractTotalValue" type="number" formControlName="totalValue" class="command-input" placeholder="0" min="0" required aria-required="true"
                         [attr.aria-invalid]="showFieldError('totalValue') ? 'true' : null"
                         [attr.aria-describedby]="showFieldError('totalValue') ? 'contractTotalValueError' : null">
                  @if (showFieldError('totalValue')) {
                    <p id="contractTotalValueError" class="command-field-error" role="alert">
                      {{ contractForm.controls.totalValue.hasError('required') ? 'Enter a total value.' : 'Total value must be zero or greater.' }}
                    </p>
                  }
                </div>

                <div>
                  <label for="contractCurrency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                  <select id="contractCurrency" formControlName="currency" class="command-select" required aria-required="true"
                          [attr.aria-invalid]="showFieldError('currency') ? 'true' : null"
                          [attr.aria-describedby]="showFieldError('currency') ? 'contractCurrencyError' : null">
                    @for (option of currencyOptions(); track option.code) {
                      <option [value]="option.code" [disabled]="option.orphan">{{ option.label }}</option>
                    }
                  </select>
                  @if (showFieldError('currency')) {
                    <p id="contractCurrencyError" class="command-field-error" role="alert">Select a currency.</p>
                  }
                </div>

                <div>
                  <label for="contractStartDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start Date *</label>
                  <input id="contractStartDate" type="date" formControlName="startDate" class="command-input" required aria-required="true"
                         [attr.aria-invalid]="showFieldError('startDate') ? 'true' : null"
                         [attr.aria-describedby]="showFieldError('startDate') ? 'contractStartDateError' : null">
                  @if (showFieldError('startDate')) {
                    <p id="contractStartDateError" class="command-field-error" role="alert">Select a start date.</p>
                  }
                </div>

                <div>
                  <label for="contractEndDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">End Date *</label>
                  <input id="contractEndDate" type="date" formControlName="endDate" class="command-input" required aria-required="true"
                         [min]="contractForm.controls.startDate.value || null"
                         [attr.aria-invalid]="showFieldError('endDate') ? 'true' : null"
                         [attr.aria-describedby]="showFieldError('endDate') ? 'contractEndDateError' : null">
                  @if (showFieldError('endDate')) {
                    <p id="contractEndDateError" class="command-field-error" role="alert">
                      {{ contractForm.controls.endDate.hasError('endBeforeStart') ? 'End date must be on or after the start date.' : 'Select an end date.' }}
                    </p>
                  }
                </div>
              </div>
              </fieldset>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            @if (confirmingDiscard()) {
              <div role="alert" class="flex w-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p class="font-semibold text-ink">Discard unsaved contract?</p>
                  <p class="text-sm text-ink-muted">The values entered in this form will be lost.</p>
                </div>
                <div class="flex justify-end gap-3">
                  <button type="button" (click)="confirmingDiscard.set(false)" class="command-button secondary">Continue editing</button>
                  <button type="button" (click)="closeForm(true)" class="command-button">Discard changes</button>
                </div>
              </div>
            } @else {
              <button type="button" (click)="closeForm()" [disabled]="saving()" class="command-button secondary disabled:opacity-50">Cancel</button>
              <button type="submit" form="contractCreateForm" [disabled]="saving()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                {{ saving() ? 'Creating contract…' : 'Create Contract' }}
              </button>
            }
          </div>
        </div>
      </div>
    }
  `
})
export class Contracts {
  private api = inject(ApiService);
  private notification = inject(NotificationService);
  private auth = inject(AuthService);
  private destroyRef = inject(DestroyRef);
  private host = inject(ElementRef<HTMLElement>);

  // contracts + customers are principal-gated server-side (401 until a verified
  // JWT is attached). Gate each read on authReady() so the request fires only
  // AFTER the OAuth bootstrap has settled and the interceptor can attach the
  // bearer token; firing earlier (on a reload/deep-link) 401'd and latched the
  // resource into an error/empty state. authReady false->true re-runs the stream.
  protected contractsRes = rxResource<Contract[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getContracts() : of<Contract[]>([])),
    defaultValue: [] as Contract[],
  });
  private customersRes = rxResource<Customer[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getCustomers() : of<Customer[]>([])),
    defaultValue: [] as Customer[],
  });
  // REFERENCE-DATA INTEGRITY (Phase B): `currency` is a config-value FK to the
  // configured currency set (the fx-rates table). Load the codes for the SELECT.
  // Gated on authReady() so it re-runs with the other principal-gated reads.
  private fxRatesRes = rxResource<FxRate[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getFxRates() : of<FxRate[]>([])),
    defaultValue: [] as FxRate[],
  });
  contracts = this.contractsRes.value;
  customers = this.customersRes.value;
  fxRates = this.fxRatesRes.value;
  protected readonly listLoading = computed(() =>
    !this.auth.authReady() || this.contractsRes.isLoading() || this.customersRes.isLoading(),
  );
  protected readonly listError = computed(() =>
    this.contractsRes.status() === 'error' || this.customersRes.status() === 'error',
  );

  // First-ever filter on this screen (design spec §8) -- same shape as
  // customers.ts's own filter, over the contract's own `name`.
  protected contractQuery = signal('');
  protected filteredContracts = computed(() => {
    const q = this.contractQuery().trim().toLowerCase();
    const all = this.contracts();
    return q ? all.filter(c => c.name.toLowerCase().includes(q)) : all;
  });

  showForm = signal(false);
  saving = signal(false);
  formError = signal<string | null>(null);
  submitAttempted = signal(false);
  confirmingDiscard = signal(false);
  private focusInvalidRequest = signal(0);
  private handledFocusInvalidRequest = 0;

  contractForm = new FormGroup({
    customerId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
    type: new FormControl<Contract['type']>('T&M', { nonNullable: true, validators: Validators.required }),
    totalValue: new FormControl<number | null>(null, { validators: [Validators.required, Validators.min(0)] }),
    currency: new FormControl(BASE_CURRENCY, { nonNullable: true, validators: Validators.required }),
    status: new FormControl<Contract['status']>('Draft', { nonNullable: true, validators: Validators.required }),
    startDate: new FormControl('', { nonNullable: true, validators: Validators.required }),
    endDate: new FormControl('', { nonNullable: true, validators: Validators.required })
  // P2-35: same cross-field rule the server enforces on /contracts.
  }, { validators: endNotBeforeStart('startDate', 'endDate') });

  // Mirror the currency control so an orphan value (not in the configured set)
  // can be surfaced as a disabled option rather than silently dropped on edit.
  private currencyValue = toSignal(this.contractForm.controls.currency.valueChanges, {
    initialValue: this.contractForm.controls.currency.value,
  });

  /**
   * Currency options for the SELECT: configured currency codes from fx-rates
   * (label = value = code). If the current control value isn't configured, it is
   * injected as a disabled "<code> (not configured)" option so editing never
   * silently wipes a real value (orphan handling, per the plan's UI pattern).
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

  private customersById = computed(() => {
    const map = new Map<string, string>();
    for (const customer of this.customers()) {
      map.set(customer.id, customer.name);
    }
    return map;
  });

  customerName(id: string): string {
    return this.customersById().get(id) ?? id;
  }

  constructor() {
    afterRenderEffect(() => {
      const request = this.focusInvalidRequest();
      if (!this.showForm() || request <= this.handledFocusInvalidRequest) return;
      const invalid = this.host.nativeElement.querySelector(
        '[data-test="contract-form-panel"] input.ng-invalid, [data-test="contract-form-panel"] select.ng-invalid',
      ) as HTMLElement | null;
      if (!invalid) return;
      this.handledFocusInvalidRequest = request;
      invalid.focus();
    });
  }

  protected reloadList(): void {
    this.contractsRes.reload();
    this.customersRes.reload();
  }

  openForm(): void {
    this.resetForm();
    this.showForm.set(true);
  }

  protected showFieldError(field: ContractField): boolean {
    const control = this.contractForm.controls[field];
    return control.invalid && (control.touched || this.submitAttempted());
  }

  save(): void {
    if (this.saving()) return;
    this.submitAttempted.set(true);
    this.formError.set(null);
    this.contractForm.updateValueAndValidity();
    if (this.contractForm.invalid) {
      this.contractForm.markAllAsTouched();
      this.formError.set('Review the highlighted fields before creating the contract.');
      this.focusInvalidRequest.update(request => request + 1);
      return;
    }

    const raw = this.contractForm.getRawValue();
    const payload: Partial<Contract> = {
      customerId: raw.customerId,
      name: raw.name,
      type: raw.type,
      totalValue: raw.totalValue ?? 0,
      currency: raw.currency,
      status: raw.status,
      startDate: raw.startDate,
      endDate: raw.endDate
    };

    this.saving.set(true);
    this.api.createContract(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.contractsRes.reload();
        this.notification.show('Contract created', 'success');
        this.saving.set(false);
        this.closeForm(true);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        // A lost response can follow a committed POST. Refresh the list and keep
        // the draft so the user can verify before choosing to retry.
        this.contractsRes.reload();
        const serverMessage = (error as { error?: { error?: string } })?.error?.error;
        const message = serverMessage
          ? `${serverMessage} Your entries are still here; update them and try again.`
          : 'Contract creation could not be confirmed. Your entries are still here. Before retrying, verify that the contract was not already created.';
        this.formError.set(message);
        this.notification.show(message, 'error');
      }
    });
  }

  closeForm(discard = false): void {
    if (this.saving()) return;
    if (!discard && this.contractForm.dirty) {
      this.confirmingDiscard.set(true);
      return;
    }
    this.showForm.set(false);
    this.resetForm();
  }

  private resetForm(): void {
    this.submitAttempted.set(false);
    this.confirmingDiscard.set(false);
    this.formError.set(null);
    this.contractForm.reset({
      customerId: '',
      name: '',
      type: 'T&M',
      totalValue: null,
      currency: BASE_CURRENCY,
      status: 'Draft',
      startDate: '',
      endDate: ''
    });
  }
}
