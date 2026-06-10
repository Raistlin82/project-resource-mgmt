import { ChangeDetectionStrategy, Component, inject, signal, computed, DestroyRef } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators, AbstractControl, ValidationErrors } from '@angular/forms';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService, Order, Contract, Partner, Project, OrderLine } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-orders',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DatePipe, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Orders</h1>
          <p class="text-slate-500 mt-2 text-sm sm:text-base">Track customer and purchase orders across your contracts.</p>
        </div>
        <button (click)="showForm.set(true)" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-5 py-2.5 rounded-xl text-sm hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 w-full sm:w-auto">
          <mat-icon class="text-[20px] w-[20px] h-[20px]">add</mat-icon> New Order
        </button>
      </div>

      <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="bg-slate-50 border-b border-slate-200 text-left">
                <th class="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider">Contract</th>
                <th class="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider">Project Imputation</th>
                <th class="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider">Type</th>
                <th class="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider">Partner</th>
                <th class="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider text-right">Amount</th>
                <th class="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                <th class="px-6 py-4 font-semibold text-slate-500 uppercase tracking-wider">Date</th>
              </tr>
            </thead>
            <tbody>
              @for (order of orders(); track order.id) {
                <tr class="border-b border-slate-200 last:border-0 hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-slate-900">{{ contractName(order.contractId) }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ orderProjectSummary(order.id) }}</td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide ring-1"
                          [class.bg-blue-50]="order.type === 'Customer'"
                          [class.text-blue-700]="order.type === 'Customer'"
                          [class.ring-blue-200]="order.type === 'Customer'"
                          [class.bg-purple-50]="order.type === 'Purchase'"
                          [class.text-purple-700]="order.type === 'Purchase'"
                          [class.ring-purple-200]="order.type === 'Purchase'">
                      {{ order.type }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-slate-600">
                    @if (order.type === 'Purchase') {
                      {{ partnerName(order.partnerId) }}
                    } @else {
                      <span class="text-slate-400">&mdash;</span>
                    }
                  </td>
                  <td class="px-6 py-4 text-right font-semibold text-slate-900 font-mono tabular-nums">{{ order.amount | currency:order.currency }}</td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold tracking-wide ring-1"
                          [class.bg-slate-100]="order.status === 'Open'"
                          [class.text-slate-700]="order.status === 'Open'"
                          [class.ring-slate-200]="order.status === 'Open'"
                          [class.bg-blue-50]="order.status === 'Confirmed'"
                          [class.text-blue-700]="order.status === 'Confirmed'"
                          [class.ring-blue-200]="order.status === 'Confirmed'"
                          [class.bg-amber-50]="order.status === 'Invoiced'"
                          [class.text-amber-700]="order.status === 'Invoiced'"
                          [class.ring-amber-200]="order.status === 'Invoiced'"
                          [class.bg-emerald-50]="order.status === 'Paid'"
                          [class.text-emerald-700]="order.status === 'Paid'"
                          [class.ring-emerald-200]="order.status === 'Paid'">
                      {{ order.status }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-slate-600 font-mono tabular-nums">{{ order.orderDate | date:'mediumDate' }}</td>
                </tr>
              }
              @if (!orders().length) {
                <tr>
                  <td colspan="7" class="px-6 py-16 text-center">
                    <div class="w-20 h-20 bg-slate-50 ring-1 ring-slate-900/5 shadow-sm rounded-full flex items-center justify-center mx-auto mb-4">
                      <mat-icon class="text-slate-400 text-4xl">receipt_long</mat-icon>
                    </div>
                    <h3 class="text-xl font-bold text-slate-900 mb-2">No orders yet</h3>
                    <p class="text-slate-500">Create your first customer or purchase order to get started.</p>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    @if (showForm()) {
      <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
           appModal ariaLabelledby="orderModalTitle" (dismiss)="closeForm()">
        <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
          <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
            <h2 id="orderModalTitle" class="text-2xl font-bold text-slate-900 tracking-tight">New Order</h2>
            <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-slate-500 hover:text-slate-700 hover:bg-slate-100 p-2 rounded-full transition-colors">
              <mat-icon>close</mat-icon>
            </button>
          </div>

          <div class="p-6 sm:p-8 overflow-y-auto flex-1">
            <form [formGroup]="orderForm" (ngSubmit)="saveOrder()" class="space-y-6">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div class="sm:col-span-2">
                  <label for="contractId" class="block text-sm font-semibold text-slate-700 mb-1.5">Contract *</label>
                  <select id="contractId" formControlName="contractId" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400">
                    <option value="">Select a contract...</option>
                    @for (contract of contracts(); track contract.id) {
                      <option [value]="contract.id">{{ contract.name }}</option>
                    }
                  </select>
                </div>

                <div>
                  <label for="type" class="block text-sm font-semibold text-slate-700 mb-1.5">Type *</label>
                  <select id="type" formControlName="type" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400">
                    <option value="Customer">Customer</option>
                    <option value="Purchase">Purchase</option>
                  </select>
                </div>

                @if (selectedType() === 'Purchase') {
                  <div>
                    <label for="partnerId" class="block text-sm font-semibold text-slate-700 mb-1.5">Partner</label>
                    <select id="partnerId" formControlName="partnerId" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400">
                      <option value="">Select a partner...</option>
                      @for (partner of partners(); track partner.id) {
                        <option [value]="partner.id">{{ partner.company }}</option>
                      }
                    </select>
                  </div>
                }

                <div>
                  <label for="amount" class="block text-sm font-semibold text-slate-700 mb-1.5">Amount *</label>
                  <input id="amount" type="number" formControlName="amount" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="0.00">
                </div>

                <div>
                  <label for="projectId" class="block text-sm font-semibold text-slate-700 mb-1.5">Project Imputation *</label>
                  <select id="projectId" formControlName="projectId" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400">
                    <option value="">Select a project...</option>
                    @for (project of projectsForSelectedContract(); track project.id) {
                      <option [value]="project.id">{{ project.name }}</option>
                    }
                  </select>
                </div>

                <div class="sm:col-span-2">
                  <label for="lineDescription" class="block text-sm font-semibold text-slate-700 mb-1.5">Line Description</label>
                  <input id="lineDescription" type="text" formControlName="lineDescription" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="e.g. Phase 1 delivery">
                </div>

                <div>
                  <label for="currency" class="block text-sm font-semibold text-slate-700 mb-1.5">Currency *</label>
                  <input id="currency" type="text" formControlName="currency" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="EUR">
                </div>

                <div>
                  <label for="status" class="block text-sm font-semibold text-slate-700 mb-1.5">Status *</label>
                  <select id="status" formControlName="status" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400">
                    <option value="Open">Open</option>
                    <option value="Confirmed">Confirmed</option>
                    <option value="Invoiced">Invoiced</option>
                    <option value="Paid">Paid</option>
                  </select>
                </div>

                <div>
                  <label for="orderDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Order Date *</label>
                  <input id="orderDate" type="date" formControlName="orderDate" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400">
                </div>
              </div>
            </form>
          </div>

          <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
            <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button type="button" (click)="saveOrder()" [disabled]="orderForm.invalid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold shadow-sm hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
              Create Order
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

  private ordersRes = rxResource({ stream: () => this.api.getOrders(), defaultValue: [] as Order[] });
  private contractsRes = rxResource({ stream: () => this.api.getContracts(), defaultValue: [] as Contract[] });
  private partnersRes = rxResource({ stream: () => this.api.getProjectPartners(), defaultValue: [] as Partner[] });
  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  private orderLinesRes = rxResource({ stream: () => this.api.getOrderLines(), defaultValue: [] as OrderLine[] });

  orders = this.ordersRes.value;
  contracts = this.contractsRes.value;
  partners = this.partnersRes.value;
  projects = this.projectsRes.value;
  orderLines = this.orderLinesRes.value;

  showForm = signal(false);

  orderForm = new FormGroup({
    contractId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    type: new FormControl<'Customer' | 'Purchase'>('Customer', { nonNullable: true, validators: Validators.required }),
    partnerId: new FormControl('', { nonNullable: true }),
    amount: new FormControl<number | null>(null, { validators: [Validators.required, Validators.min(0)] }),
    projectId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    lineDescription: new FormControl('', { nonNullable: true }),
    currency: new FormControl('EUR', { nonNullable: true, validators: Validators.required }),
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
      .map(line => `${this.projectsById().get(line.projectId) ?? line.projectId} (${line.amount.toLocaleString()} ${this.orders().find(o => o.id === orderId)?.currency ?? ''})`)
      .join(', ');
  }

  saveOrder(): void {
    if (this.orderForm.invalid) return;

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

    this.api.createOrder(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (order) => {
        this.api.createOrderLine({
          orderId: order.id,
          projectId: raw.projectId,
          description: raw.lineDescription || `${raw.type} order imputation`,
          amount: raw.amount ?? 0,
        }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
          next: () => {
            this.ordersRes.reload();
            this.orderLinesRes.reload();
            this.notifications.show('Order created and imputed to project.', 'success');
            this.closeForm();
          },
          error: () => this.notifications.show('Order created, but project imputation failed.', 'error'),
        });
      },
      error: () => this.notifications.show('Failed to create order.', 'error')
    });
  }

  closeForm(): void {
    this.showForm.set(false);
    this.orderForm.reset({ contractId: '', type: 'Customer', partnerId: '', amount: null, projectId: '', lineDescription: '', currency: 'EUR', status: 'Open', orderDate: '' });
  }
}
