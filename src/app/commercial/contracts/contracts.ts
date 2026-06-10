import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { ApiService, Contract, Customer } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-contracts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, MatIconModule, ReactiveFormsModule, RouterLink, ModalDialogDirective],
  template: `
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Contracts</h1>
          <p class="text-slate-500 mt-2 text-sm sm:text-base">Manage customer contracts and their commercial terms.</p>
        </div>
        <button (click)="showForm.set(true)" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-5 py-2.5 rounded-xl text-sm hover:shadow-md hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Contract
        </button>
      </div>

      <!-- Contracts Table -->
      <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-shadow">
        <div class="overflow-x-auto">
          <table class="w-full text-sm text-left">
            <thead class="bg-slate-50 text-slate-500 uppercase text-xs tracking-wider">
              <tr>
                <th scope="col" class="px-6 py-4 font-semibold">Name</th>
                <th scope="col" class="px-6 py-4 font-semibold">Customer</th>
                <th scope="col" class="px-6 py-4 font-semibold">Type</th>
                <th scope="col" class="px-6 py-4 font-semibold">Total Value</th>
                <th scope="col" class="px-6 py-4 font-semibold">Status</th>
                <th scope="col" class="px-6 py-4 font-semibold">Dates</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (c of contracts(); track c.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-semibold text-slate-900">
                    <a [routerLink]="['/contracts', c.id]" class="hover:text-blue-700 transition-colors">{{ c.name }}</a>
                  </td>
                  <td class="px-6 py-4 text-slate-600">{{ customerName(c.customerId) }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ c.type }}</td>
                  <td class="px-6 py-4 text-blue-700 font-medium font-mono tabular-nums">{{ c.totalValue | currency:c.currency }}</td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide ring-1"
                          [class.bg-emerald-50]="c.status === 'Active'"
                          [class.text-emerald-700]="c.status === 'Active'"
                          [class.ring-emerald-200]="c.status === 'Active'"
                          [class.bg-slate-100]="c.status === 'Draft'"
                          [class.text-slate-700]="c.status === 'Draft'"
                          [class.ring-slate-200]="c.status === 'Draft'"
                          [class.bg-blue-50]="c.status === 'Closed'"
                          [class.text-blue-700]="c.status === 'Closed'"
                          [class.ring-blue-200]="c.status === 'Closed'">
                      {{ c.status }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-slate-600 whitespace-nowrap">
                    {{ c.startDate | date:'mediumDate' }} - {{ c.endDate | date:'mediumDate' }}
                  </td>
                </tr>
              }
              @if (!contracts().length) {
                <tr>
                  <td colspan="6" class="px-6 py-16 text-center">
                    <div class="w-20 h-20 bg-slate-50 shadow-inner rounded-full flex items-center justify-center mx-auto mb-4 ring-1 ring-slate-900/5">
                      <mat-icon class="text-slate-400 text-4xl">description</mat-icon>
                    </div>
                    <h3 class="text-xl font-bold text-slate-900 mb-2">No contracts yet</h3>
                    <p class="text-slate-500">Create your first contract to get started.</p>
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
      <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="contractModalTitle" (dismiss)="closeForm()">
        <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl ring-1 ring-slate-900/5 w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
          <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
            <h2 id="contractModalTitle" class="text-2xl font-bold text-slate-900 tracking-tight">New Contract</h2>
            <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-slate-400 hover:text-slate-700 hover:bg-slate-50 p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="contractForm" (ngSubmit)="save()" class="space-y-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="contractCustomer" class="block text-sm font-semibold text-slate-700 mb-1.5">Customer *</label>
                  <select id="contractCustomer" formControlName="customerId" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                    <option value="">Select a customer...</option>
                    @for (customer of customers(); track customer.id) {
                      <option [value]="customer.id">{{ customer.name }}</option>
                    }
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="contractName" class="block text-sm font-semibold text-slate-700 mb-1.5">Name *</label>
                  <input id="contractName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white placeholder:text-slate-400" placeholder="e.g. Master Services Agreement">
                </div>

                <div>
                  <label for="contractType" class="block text-sm font-semibold text-slate-700 mb-1.5">Type *</label>
                  <select id="contractType" formControlName="type" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                    <option value="T&M">T&M</option>
                    <option value="Fixed Price">Fixed Price</option>
                    <option value="Framework">Framework</option>
                  </select>
                </div>

                <div>
                  <label for="contractStatus" class="block text-sm font-semibold text-slate-700 mb-1.5">Status *</label>
                  <select id="contractStatus" formControlName="status" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                    <option value="Draft">Draft</option>
                    <option value="Active">Active</option>
                    <option value="Closed">Closed</option>
                  </select>
                </div>

                <div>
                  <label for="contractTotalValue" class="block text-sm font-semibold text-slate-700 mb-1.5">Total Value *</label>
                  <input id="contractTotalValue" type="number" formControlName="totalValue" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white placeholder:text-slate-400" placeholder="0">
                </div>

                <div>
                  <label for="contractCurrency" class="block text-sm font-semibold text-slate-700 mb-1.5">Currency *</label>
                  <input id="contractCurrency" type="text" formControlName="currency" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white placeholder:text-slate-400" placeholder="EUR">
                </div>

                <div>
                  <label for="contractStartDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Start Date *</label>
                  <input id="contractStartDate" type="date" formControlName="startDate" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                </div>

                <div>
                  <label for="contractEndDate" class="block text-sm font-semibold text-slate-700 mb-1.5">End Date *</label>
                  <input id="contractEndDate" type="date" formControlName="endDate" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button type="button" (click)="save()" [disabled]="contractForm.invalid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm rounded-xl text-sm hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
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

  private contractsRes = rxResource({ stream: () => this.api.getContracts(), defaultValue: [] as Contract[] });
  private customersRes = rxResource({ stream: () => this.api.getCustomers(), defaultValue: [] as Customer[] });
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
