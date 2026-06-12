import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { RouterLink } from '@angular/router';
import { ApiService, Contract, Customer } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-contracts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, MatIconModule, ReactiveFormsModule, RouterLink, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="command-eyebrow">Commercial</div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Contracts</h1>
          <p class="mt-2 text-sm text-[var(--cc-muted)]">Manage customer contracts and their commercial terms.</p>
        </div>
        <button (click)="showForm.set(true)" class="command-button w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Contract
        </button>
      </div>

      <!-- Contracts Table -->
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
              @for (c of contracts(); track c.id) {
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
                    <div class="command-empty">
                      <mat-icon>description</mat-icon>
                      <h3 class="command-empty-title">No contracts yet</h3>
                      <p class="command-empty-note">Create your first contract to get started.</p>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- New Contract Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="contractModalTitle" (dismiss)="closeForm()">
        <div class="command-card w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
          <div class="command-card-header">
            <h2 id="contractModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">New Contract</h2>
            <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="contractForm" (ngSubmit)="save()" class="space-y-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="contractCustomer" class="block text-sm font-semibold text-ink-secondary mb-1.5">Customer *</label>
                  <select id="contractCustomer" formControlName="customerId" class="command-select">
                    <option value="">Select a customer...</option>
                    @for (customer of customers(); track customer.id) {
                      <option [value]="customer.id">{{ customer.name }}</option>
                    }
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="contractName" class="block text-sm font-semibold text-ink-secondary mb-1.5">Name *</label>
                  <input id="contractName" type="text" formControlName="name" class="command-input" placeholder="e.g. Master Services Agreement">
                </div>

                <div>
                  <label for="contractType" class="block text-sm font-semibold text-ink-secondary mb-1.5">Type *</label>
                  <select id="contractType" formControlName="type" class="command-select">
                    <option value="T&M">T&M</option>
                    <option value="Fixed Price">Fixed Price</option>
                    <option value="Framework">Framework</option>
                  </select>
                </div>

                <div>
                  <label for="contractStatus" class="block text-sm font-semibold text-ink-secondary mb-1.5">Status *</label>
                  <select id="contractStatus" formControlName="status" class="command-select">
                    <option value="Draft">Draft</option>
                    <option value="Active">Active</option>
                    <option value="Closed">Closed</option>
                  </select>
                </div>

                <div>
                  <label for="contractTotalValue" class="block text-sm font-semibold text-ink-secondary mb-1.5">Total Value *</label>
                  <input id="contractTotalValue" type="number" formControlName="totalValue" class="command-input" placeholder="0">
                </div>

                <div>
                  <label for="contractCurrency" class="block text-sm font-semibold text-ink-secondary mb-1.5">Currency *</label>
                  <input id="contractCurrency" type="text" formControlName="currency" class="command-input" placeholder="EUR">
                </div>

                <div>
                  <label for="contractStartDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Start Date *</label>
                  <input id="contractStartDate" type="date" formControlName="startDate" class="command-input">
                </div>

                <div>
                  <label for="contractEndDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">End Date *</label>
                  <input id="contractEndDate" type="date" formControlName="endDate" class="command-input">
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
            <button type="button" (click)="save()" [disabled]="contractForm.invalid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
              Create Contract
            </button>
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

  // contracts + customers are principal-gated server-side (401 until a verified
  // JWT is attached). Gate each read on authReady() so the request fires only
  // AFTER the OAuth bootstrap has settled and the interceptor can attach the
  // bearer token; firing earlier (on a reload/deep-link) 401'd and latched the
  // resource into an error/empty state. authReady false->true re-runs the stream.
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
  contracts = this.contractsRes.value;
  customers = this.customersRes.value;

  showForm = signal(false);

  private customersById = computed(() => {
    const map = new Map<string, string>();
    for (const customer of this.customers()) {
      map.set(customer.id, customer.name);
    }
    return map;
  });

  contractForm = new FormGroup({
    customerId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    name: new FormControl('', { nonNullable: true, validators: Validators.required }),
    type: new FormControl<Contract['type']>('T&M', { nonNullable: true, validators: Validators.required }),
    totalValue: new FormControl<number | null>(null, { validators: [Validators.required, Validators.min(0)] }),
    currency: new FormControl('EUR', { nonNullable: true, validators: Validators.required }),
    status: new FormControl<Contract['status']>('Draft', { nonNullable: true, validators: Validators.required }),
    startDate: new FormControl('', { nonNullable: true, validators: Validators.required }),
    endDate: new FormControl('', { nonNullable: true, validators: Validators.required })
  });

  customerName(id: string): string {
    return this.customersById().get(id) ?? id;
  }

  save(): void {
    if (this.contractForm.invalid) return;

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

    this.api.createContract(payload).subscribe({
      next: () => {
        this.contractsRes.reload();
        this.notification.show('Contract created', 'success');
        this.closeForm();
      },
      error: () => this.notification.show('Failed to create contract', 'error')
    });
  }

  closeForm(): void {
    this.showForm.set(false);
    this.contractForm.reset({
      customerId: '',
      name: '',
      type: 'T&M',
      totalValue: null,
      currency: 'EUR',
      status: 'Draft',
      startDate: '',
      endDate: ''
    });
  }
}
