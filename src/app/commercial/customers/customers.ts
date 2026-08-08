import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, afterRenderEffect, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SEARCH_FOCUS_PARAM } from '../../services/search-target.util';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { ApiService, Customer, Contract, Country, Industry } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { ListStateComponent } from '../../shared/list-state.component';
import { SearchFilterBarComponent } from '../../shared/search-filter-bar.component';

@Component({
  selector: 'app-customers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, ModalDialogDirective, ListStateComponent, SearchFilterBarComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="command-eyebrow">Commercial</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Customers</h1>
          <p class="mt-2 text-sm text-[var(--cc-muted)]">Manage commercial customers and their contracts.</p>
        </div>
        <button type="button" (click)="openForm()" class="command-button w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Customer
        </button>
      </div>

      <app-search-filter-bar
        [query]="customerQuery()"
        placeholder="Search customers by name..."
        (queryChange)="customerQuery.set($event)"
        (clearAll)="customerQuery.set('')"
      />

      <!-- Customers Table. [loading] folds auth readiness — see listLoading(). -->
      <app-list-state [loading]="listLoading()" [error]="listError()" skeleton="table-rows" [rows]="5" [columns]="4" label="customers" (retry)="reloadList()">
      <ng-template>
      <div class="command-card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Industry</th>
                <th scope="col">Country</th>
                <th scope="col" class="text-right"># Contracts</th>
              </tr>
            </thead>
            <tbody>
              @for (customer of filteredCustomers(); track customer.id) {
                <tr>
                  <td class="font-semibold">{{ customer.name }}</td>
                  <td class="text-[var(--cc-muted)]">{{ customer.industry || '—' }}</td>
                  <td class="text-[var(--cc-muted)]">{{ customer.country || '—' }}</td>
                  <td class="text-right">
                    <span class="command-status min-w-[2rem] justify-center">
                      {{ contractCounts()[customer.id] || 0 }}
                    </span>
                  </td>
                </tr>
              }
              @if (!customers().length) {
                <tr>
                  <td colspan="4">
                    <div class="command-empty" data-test="customers-source-empty">
                      <mat-icon>domain_disabled</mat-icon>
                      <h3 class="command-empty-title">No customers yet</h3>
                      <p class="command-empty-note">Get started by adding your first customer.</p>
                      <button type="button" (click)="openForm()" class="command-button mt-4">Create customer</button>
                    </div>
                  </td>
                </tr>
              } @else if (!filteredCustomers().length) {
                <tr>
                  <td colspan="4">
                    <div class="command-empty" data-test="customers-filtered-empty">
                      <mat-icon>search_off</mat-icon>
                      <h3 class="command-empty-title">No customers match your search</h3>
                      <p class="command-empty-note break-words">No customer name contains “{{ customerQuery() }}”.</p>
                      <button type="button" (click)="customerQuery.set('')" class="command-button secondary mt-4">Clear filters</button>
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

    <!-- Create Modal -->
    @if (showForm()) {
      <div data-test="customer-form-overlay" class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="customerModalTitle" (dismiss)="closeForm()">
        <div data-test="customer-form-panel" class="command-card w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]" [attr.aria-busy]="saving()">
          <div class="command-card-header">
            <h2 id="customerModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">New Customer</h2>
            <button type="button" (click)="closeForm()" [disabled]="saving()" aria-label="Close new customer dialog" title="Close new customer dialog" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors disabled:opacity-50">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form id="customerCreateForm" [formGroup]="customerForm" (ngSubmit)="save()" class="space-y-6">
              @if (formError(); as message) {
                <div data-test="customer-form-error" class="rounded-md border border-critical bg-critical-tint p-4 text-sm font-semibold text-critical-text" role="alert">
                  {{ message }}
                </div>
              }
              <fieldset [disabled]="saving()" class="contents">
              <div class="grid grid-cols-1 gap-6">
                <div>
                  <label for="customerName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Name *</label>
                  <input id="customerName" type="text" formControlName="name" class="command-input" placeholder="e.g. Acme Corporation"
                         required aria-required="true"
                         [attr.aria-invalid]="showNameError() ? 'true' : null"
                         [attr.aria-describedby]="showNameError() ? 'customerNameError' : null">
                  @if (showNameError()) {
                    <p id="customerNameError" class="command-field-error" role="alert">Name is required.</p>
                  }
                </div>
                <div>
                  <label for="customerIndustry" class="block text-sm font-semibold text-ink-secondary mb-1.5">Industry</label>
                  <!-- Industry is a config FK to the industries catalog (store = name). -->
                  <select id="customerIndustry" formControlName="industry" class="command-select">
                    <option value="">— None —</option>
                    @for (ind of industryOptions(); track ind.id) {
                      <option [value]="ind.name">{{ ind.name }}</option>
                    }
                    @if (orphanIndustry(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
                <div>
                  <label for="customerCountry" class="block text-sm font-semibold text-ink-secondary mb-1.5">Country</label>
                  <!-- Country is a config FK to the countries catalog (store = country NAME). -->
                  <select id="customerCountry" formControlName="country" class="command-select">
                    <option value="">— None —</option>
                    @for (c of countryOptions(); track c.code) {
                      <option [value]="c.name">{{ c.name }}</option>
                    }
                    @if (orphanCountry(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
              </div>
              </fieldset>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            @if (confirmingDiscard()) {
              <div role="alert" class="flex w-full flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p class="font-semibold text-ink">Discard unsaved customer?</p>
                  <p class="text-sm text-ink-muted">The values entered in this form will be lost.</p>
                </div>
                <div class="flex justify-end gap-3">
                  <button type="button" (click)="confirmingDiscard.set(false)" class="command-button secondary">Continue editing</button>
                  <button type="button" (click)="closeForm(true)" class="command-button">Discard changes</button>
                </div>
              </div>
            } @else {
              <button type="button" (click)="closeForm()" [disabled]="saving()" class="command-button secondary disabled:opacity-50">Cancel</button>
              <button type="submit" form="customerCreateForm" [disabled]="saving()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                {{ saving() ? 'Creating customer…' : 'Create Customer' }}
              </button>
            }
          </div>
        </div>
      </div>
    }
  `
})
export class Customers {
  private api = inject(ApiService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);
  private auth = inject(AuthService);
  private host = inject(ElementRef<HTMLElement>);

  // customers + contracts are principal-gated server-side (401 until a verified
  // JWT is attached). Gate each read on authReady() so the request fires only
  // AFTER the OAuth bootstrap has settled and the interceptor can attach the
  // bearer token; firing earlier (on a reload/deep-link) 401'd and latched the
  // resource into an error/empty state. authReady false->true re-runs the stream.
  protected customersRes = rxResource<Customer[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getCustomers() : of<Customer[]>([])),
    defaultValue: [] as Customer[],
  });
  protected contractsRes = rxResource<Contract[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getContracts() : of<Contract[]>([])),
    defaultValue: [] as Contract[],
  });

  customers = this.customersRes.value;
  contracts = this.contractsRes.value;

  /**
   * Whether the customers table has nothing truthful to render yet.
   * `isLoading()` alone is NOT that question: `params()` above is false until the
   * OIDC bootstrap settles and the stream answers that with `of([])` — a RESOLVED
   * empty, not a pending one — so isLoading() was FALSE for the entire
   * afterNextRender -> /api/storage-status -> OIDC discovery window (auth.service.ts
   * 154, 191-249) *and* in the SSR HTML shipped to the browser. Bound bare, this
   * wrapper therefore rendered "No customers yet" / "Get started by adding your
   * first customer." over a read that had not been made — a confident claim about
   * a commercial book that may well be full, and one whose suggested remedy
   * (create a customer) invites a duplicate of a customer that already exists.
   *
   * Not-ready counts as loading, never as ready-and-empty — the same rule
   * resources.component.ts's `listLoading()` applies, whose shape this mirrors.
   */
  protected readonly listLoading = computed<boolean>(() =>
    !this.auth.authReady() || this.customersRes.isLoading() || this.contractsRes.isLoading(),
  );
  protected readonly listError = computed(() =>
    this.customersRes.status() === 'error' || this.contractsRes.status() === 'error',
  );

  // First-ever filter on this screen (design spec §8) -- a plain client-side
  // text match over the already-loaded list, same sophistication as
  // resources.component.ts's own filter (no server round-trip needed for a
  // list this small; the server-side q/limit/offset from Block G's other
  // tasks exists for the dedicated /search page, not this screen).
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
  protected customerQuery = signal(this.seededQuery);
  protected filteredCustomers = computed(() => {
    const q = this.customerQuery().trim().toLowerCase();
    const all = this.customers();
    return q ? all.filter(c => c.name.toLowerCase().includes(q)) : all;
  });

  // Industry + Country are config FKs (Phase F2). Gated on authReady.
  private industriesRes = rxResource<Industry[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getIndustries() : of<Industry[]>([])),
    defaultValue: [] as Industry[],
  });
  private countriesRes = rxResource<Country[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getCountries() : of<Country[]>([])),
    defaultValue: [] as Country[],
  });
  industryOptions = this.industriesRes.value;
  countryOptions = this.countriesRes.value;

  contractCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const contract of this.contracts()) {
      counts[contract.customerId] = (counts[contract.customerId] || 0) + 1;
    }
    return counts;
  });

  showForm = signal(false);
  saving = signal(false);
  formError = signal<string | null>(null);
  submitAttempted = signal(false);
  confirmingDiscard = signal(false);
  private focusInvalidRequest = signal(0);
  private handledFocusInvalidRequest = 0;

  customerForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
    industry: new FormControl('', { nonNullable: true }),
    country: new FormControl('', { nonNullable: true })
  });

  // ORPHAN VALUE: a stored industry/country not in the catalog stays selectable as a
  // disabled option so editing never silently discards a real value.
  private industryValue = toSignal(this.customerForm.controls.industry.valueChanges, { initialValue: this.customerForm.controls.industry.value });
  private countryValue = toSignal(this.customerForm.controls.country.valueChanges, { initialValue: this.customerForm.controls.country.value });
  orphanIndustry = computed<string | null>(() => {
    const current = this.industryValue();
    if (!current) return null;
    return this.industryOptions().some(i => i.name === current) ? null : current;
  });
  orphanCountry = computed<string | null>(() => {
    const current = this.countryValue();
    if (!current) return null;
    return this.countryOptions().some(c => c.name === current) ? null : current;
  });

  constructor() {
    afterRenderEffect(() => {
      const request = this.focusInvalidRequest();
      if (!this.showForm() || request <= this.handledFocusInvalidRequest) return;
      const invalid = this.host.nativeElement.querySelector(
        '[data-test="customer-form-panel"] input.ng-invalid, [data-test="customer-form-panel"] select.ng-invalid',
      ) as HTMLElement | null;
      if (!invalid) return;
      this.handledFocusInvalidRequest = request;
      invalid.focus();
    });
  }

  protected reloadList(): void {
    this.customersRes.reload();
    this.contractsRes.reload();
  }

  openForm(): void {
    this.resetForm();
    this.showForm.set(true);
  }

  protected showNameError(): boolean {
    const control = this.customerForm.controls.name;
    return control.invalid && (control.touched || this.submitAttempted());
  }

  save(): void {
    if (this.saving()) return;
    this.submitAttempted.set(true);
    this.formError.set(null);
    this.customerForm.updateValueAndValidity();
    if (this.customerForm.invalid) {
      this.customerForm.markAllAsTouched();
      this.formError.set('Review the highlighted fields before creating the customer.');
      this.focusInvalidRequest.update(request => request + 1);
      return;
    }

    const raw = this.customerForm.getRawValue();
    const payload: Partial<Customer> = {
      name: raw.name,
      industry: raw.industry || undefined,
      country: raw.country || undefined
    };

    this.saving.set(true);
    this.api.createCustomer(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.customersRes.reload();
        this.notifications.show('Customer created successfully.', 'success');
        this.saving.set(false);
        this.closeForm(true);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        // A lost response can follow a committed POST. Refresh the list and keep
        // the draft so the user can verify before choosing to retry.
        this.customersRes.reload();
        const serverMessage = (error as { error?: { error?: string } })?.error?.error;
        const message = serverMessage
          ? `${serverMessage} Your entries are still here; update them and try again.`
          : 'Customer creation could not be confirmed. Your entries are still here. Before retrying, verify that the customer was not already created.';
        this.formError.set(message);
        this.notifications.show(message, 'error');
      }
    });
  }

  closeForm(discard = false): void {
    if (this.saving()) return;
    if (!discard && this.customerForm.dirty) {
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
    this.customerForm.reset({
      name: '',
      industry: '',
      country: '',
    });
  }
}
