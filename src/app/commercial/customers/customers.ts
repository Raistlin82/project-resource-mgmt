import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, Customer, Contract } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-customers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule],
  template: `
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Customers</h1>
          <p class="text-slate-500 mt-2 text-sm sm:text-base">Manage commercial customers and their contracts.</p>
        </div>
        <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-5 py-2.5 rounded-xl text-sm hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Customer
        </button>
      </div>

      <!-- Customers Table -->
      <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-shadow">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-slate-50 border-b border-slate-200 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                <th class="px-6 py-4">Name</th>
                <th class="px-6 py-4">Industry</th>
                <th class="px-6 py-4">Country</th>
                <th class="px-6 py-4 text-right"># Contracts</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (customer of customers(); track customer.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-semibold text-slate-900">{{ customer.name }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ customer.industry || '—' }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ customer.country || '—' }}</td>
                  <td class="px-6 py-4 text-right">
                    <span class="inline-flex items-center justify-center min-w-[2rem] px-2.5 py-1 rounded-full text-xs font-bold font-mono tabular-nums bg-blue-50 text-blue-700 ring-1 ring-blue-200">
                      {{ contractCounts()[customer.id] || 0 }}
                    </span>
                  </td>
                </tr>
              }
              @if (!customers().length) {
                <tr>
                  <td colspan="4" class="px-6 py-16 text-center">
                    <div class="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                      <mat-icon class="text-slate-400 text-4xl">domain_disabled</mat-icon>
                    </div>
                    <h3 class="text-xl font-bold text-slate-900 mb-2">No customers yet</h3>
                    <p class="text-slate-500">Get started by adding your first customer.</p>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    @if (showForm()) {
      <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
        <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
          <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
            <h2 class="text-2xl font-bold text-slate-900 tracking-tight">New Customer</h2>
            <button (click)="closeForm()" class="text-slate-400 hover:text-slate-700 hover:bg-slate-100 p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="customerForm" (ngSubmit)="save()" class="space-y-6">
              <div class="grid grid-cols-1 gap-6">
                <div>
                  <label for="customerName" class="block text-sm font-semibold text-slate-700 mb-1.5">Name *</label>
                  <input id="customerName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. Acme Corporation">
                </div>
                <div>
                  <label for="customerIndustry" class="block text-sm font-semibold text-slate-700 mb-1.5">Industry</label>
                  <input id="customerIndustry" type="text" formControlName="industry" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. Manufacturing">
                </div>
                <div>
                  <label for="customerCountry" class="block text-sm font-semibold text-slate-700 mb-1.5">Country</label>
                  <input id="customerCountry" type="text" formControlName="country" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. United States">
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button type="button" (click)="save()" [disabled]="customerForm.invalid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm rounded-xl text-sm hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
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

  private customersRes = rxResource({ stream: () => this.api.getCustomers(), defaultValue: [] as Customer[] });
  private contractsRes = rxResource({ stream: () => this.api.getContracts(), defaultValue: [] as Contract[] });

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
