import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { ApiService, Customer, Contract } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { ListStateComponent } from '../../shared/list-state.component';

@Component({
  selector: 'app-customers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, ModalDialogDirective, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="command-eyebrow">Commercial</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Customers</h1>
          <p class="mt-2 text-sm text-[var(--cc-muted)]">Manage commercial customers and their contracts.</p>
        </div>
        <button (click)="openForm()" class="command-button w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Customer
        </button>
      </div>

      <!-- Customers Table -->
      <app-list-state [loading]="customersRes.isLoading()" [error]="customersRes.status() === 'error'" label="customers" (retry)="customersRes.reload()">
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
              @for (customer of customers(); track customer.id) {
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
                    <div class="command-empty">
                      <mat-icon>domain_disabled</mat-icon>
                      <h3 class="command-empty-title">No customers yet</h3>
                      <p class="command-empty-note">Get started by adding your first customer.</p>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
      </app-list-state>
    </div>

    <!-- Create Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="customerModalTitle" (dismiss)="closeForm()">
        <div class="command-card w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]">
          <div class="command-card-header">
            <h2 id="customerModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">New Customer</h2>
            <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="customerForm" (ngSubmit)="save()" class="space-y-6">
              <div class="grid grid-cols-1 gap-6">
                <div>
                  <label for="customerName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Name *</label>
                  <input id="customerName" type="text" formControlName="name" class="command-input" placeholder="e.g. Acme Corporation"
                         [attr.aria-invalid]="customerForm.controls.name.invalid && (customerForm.controls.name.touched || customerForm.controls.name.dirty)"
                         [attr.aria-describedby]="customerForm.controls.name.invalid && (customerForm.controls.name.touched || customerForm.controls.name.dirty) ? 'customerNameError' : null">
                  @if (customerForm.controls.name.invalid && (customerForm.controls.name.touched || customerForm.controls.name.dirty)) {
                    <p id="customerNameError" class="command-field-error" role="alert">Name is required.</p>
                  }
                </div>
                <div>
                  <label for="customerIndustry" class="block text-sm font-semibold text-ink-secondary mb-1.5">Industry</label>
                  <input id="customerIndustry" type="text" formControlName="industry" class="command-input" placeholder="e.g. Manufacturing">
                </div>
                <div>
                  <label for="customerCountry" class="block text-sm font-semibold text-ink-secondary mb-1.5">Country</label>
                  <input id="customerCountry" type="text" formControlName="country" class="command-input" placeholder="e.g. United States">
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
            <button type="button" (click)="save()" [disabled]="customerForm.invalid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              Create Customer
            </button>
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
  private contractsRes = rxResource<Contract[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getContracts() : of<Contract[]>([])),
    defaultValue: [] as Contract[],
  });

  customers = this.customersRes.value;
  contracts = this.contractsRes.value;

  contractCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const contract of this.contracts()) {
      counts[contract.customerId] = (counts[contract.customerId] || 0) + 1;
    }
    return counts;
  });

  showForm = signal(false);

  customerForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
    industry: new FormControl('', { nonNullable: true }),
    country: new FormControl('', { nonNullable: true })
  });

  openForm(): void {
    this.showForm.set(true);
  }

  closeForm(): void {
    this.showForm.set(false);
    this.customerForm.reset();
  }

  save(): void {
    if (this.customerForm.invalid) return;

    const raw = this.customerForm.getRawValue();
    const payload: Partial<Customer> = {
      name: raw.name,
      industry: raw.industry || undefined,
      country: raw.country || undefined
    };

    this.api.createCustomer(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.customersRes.reload();
        this.notifications.show('Customer created successfully.', 'success');
        this.closeForm();
      },
      error: () => this.notifications.show('Failed to create customer.', 'error')
    });
  }
}
