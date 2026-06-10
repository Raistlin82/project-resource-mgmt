import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, FinancialItem } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-financial-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Financial Plans</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500/25 focus:border-blue-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Financial Plans</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-4 py-2 rounded-xl text-sm transition-colors flex items-center gap-2">
            <mat-icon class="text-sm">add</mat-icon> Create Financial Plan
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/5 p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view financial plans.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/5 p-6 transition-shadow hover:shadow-md">
            <h3 class="text-sm font-medium text-slate-500 mb-1">Total Budget</h3>
            <p class="text-2xl font-semibold text-slate-900 font-mono tabular-nums">{{ totalBudget() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/5 p-6 transition-shadow hover:shadow-md">
            <h3 class="text-sm font-medium text-slate-500 mb-1">Spent</h3>
            <p class="text-2xl font-semibold text-slate-900 font-mono tabular-nums">{{ totalSpent() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/5 p-6 transition-shadow hover:shadow-md">
            <h3 class="text-sm font-medium text-slate-500 mb-1">Remaining</h3>
            <p class="text-2xl font-semibold text-emerald-700 font-mono tabular-nums">{{ totalBudget() - totalSpent() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
        </div>

        <div class="bg-white rounded-2xl border border-slate-200 shadow-sm ring-1 ring-slate-900/5 overflow-hidden">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500">
              <tr>
                <th class="px-6 py-4 font-medium uppercase tracking-wider">Category</th>
                <th class="px-6 py-4 font-medium uppercase tracking-wider">Budget</th>
                <th class="px-6 py-4 font-medium uppercase tracking-wider">Actual</th>
                <th class="px-6 py-4 font-medium uppercase tracking-wider">Variance</th>
                <th class="px-6 py-4 font-medium uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (item of filteredFinancials(); track item.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-slate-900">{{ item.category }}</td>
                  <td class="px-6 py-4 text-slate-600 font-mono tabular-nums">{{ item.budget | currency:'USD':'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4 text-slate-600 font-mono tabular-nums">{{ item.actual | currency:'USD':'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4 font-mono tabular-nums" [class.text-emerald-700]="item.budget - item.actual > 0" [class.text-red-700]="item.budget - item.actual < 0" [class.text-slate-600]="item.budget - item.actual === 0">
                    {{ item.budget - item.actual > 0 ? '+' : '' }}{{ item.budget - item.actual | currency:'USD':'symbol':'1.0-0' }}
                  </td>
                  <td class="px-6 py-4 text-right">
                    <div class="flex items-center justify-end gap-2">
                      <button type="button" (click)="editPlan(item)" class="text-slate-400 hover:text-blue-700 hover:bg-blue-50 p-1.5 rounded-lg transition-colors" aria-label="Edit financial plan">
                        <mat-icon class="text-sm">edit</mat-icon>
                      </button>
                      <button type="button" (click)="deletePlan(item)" class="text-slate-400 hover:text-red-700 hover:bg-red-50 p-1.5 rounded-lg transition-colors" aria-label="Delete financial plan">
                        <mat-icon class="text-sm">delete</mat-icon>
                      </button>
                    </div>
                  </td>
                </tr>
              }
              @if (filteredFinancials().length === 0) {
                <tr>
                  <td colspan="5" class="px-6 py-8 text-center text-slate-500">No financial records found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      </div>

      <!-- Create Financial Plan Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="financialPlanModalTitle" (dismiss)="closeForm()">
          <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
              <h2 id="financialPlanModalTitle" class="text-2xl font-bold text-slate-900 tracking-tight">{{ editingId() ? 'Edit Financial Plan' : 'Create Financial Plan' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-slate-400 hover:text-slate-700 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="finForm" (ngSubmit)="savePlan()" class="space-y-6">
                <div>
                  <label for="finCategory" class="block text-sm font-semibold text-slate-700 mb-1.5">Category *</label>
                  <input id="finCategory" type="text" formControlName="category" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="e.g. Software Licenses">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="finBudget" class="block text-sm font-semibold text-slate-700 mb-1.5">Budget ($) *</label>
                    <input id="finBudget" type="number" formControlName="budget" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="0">
                  </div>
                  <div>
                    <label for="finActual" class="block text-sm font-semibold text-slate-700 mb-1.5">Actual Spent ($) *</label>
                    <input id="finActual" type="number" formControlName="actual" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm bg-white focus:bg-white text-slate-900 placeholder:text-slate-400" placeholder="0">
                  </div>
                </div>
              </form>
            </div>
            
            <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="savePlan()" [disabled]="!finForm.valid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm rounded-xl text-sm hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                Save
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class FinancialPlans {
  projectId = input<string>();
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({
    stream: () => this.api.getProjects(),
    defaultValue: [] as Project[]
  });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');

  showForm = signal(false);
  editingId = signal<string | null>(null);

  finForm = new FormGroup({
    category: new FormControl('', Validators.required),
    budget: new FormControl<number | null>(null, [Validators.required, Validators.min(0)]),
    actual: new FormControl<number | null>(null, [Validators.required, Validators.min(0)])
  });

  private financialsRes = rxResource({
    stream: () => this.api.getProjectFinancials(),
    defaultValue: [] as FinancialItem[]
  });
  financials = this.financialsRes.value;

  filteredFinancials = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.financials().filter(f => f.projectId === pId);
  });

  totalBudget = computed(() => this.filteredFinancials().reduce((sum, item) => sum + item.budget, 0));
  totalSpent = computed(() => this.filteredFinancials().reduce((sum, item) => sum + item.actual, 0));

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.editingId.set(null);
    this.showForm.set(true);
  }

  editPlan(item: FinancialItem) {
    this.editingId.set(item.id);
    this.finForm.setValue({
      category: item.category,
      budget: item.budget,
      actual: item.actual,
    });
    this.showForm.set(true);
  }

  deletePlan(item: FinancialItem) {
    this.api.deleteProjectFinancial(item.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.financialsRes.reload();
      this.notificationService.show('Financial plan deleted', 'success');
    });
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.finForm.reset();
  }

  savePlan() {
    if (this.finForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.finForm.getRawValue();
    const id = this.editingId();
    if (id) {
      this.api.updateProjectFinancial(id, {
        projectId: pId,
        category: v.category ?? '',
        budget: v.budget ?? 0,
        actual: v.actual ?? 0,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        this.financialsRes.reload();
        this.notificationService.show('Financial plan updated', 'success');
      });
    } else {
      this.api.createProjectFinancial({
        projectId: pId,
        category: v.category ?? '',
        budget: v.budget ?? 0,
        actual: v.actual ?? 0,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        this.financialsRes.reload();
        this.notificationService.show('Financial plan created', 'success');
      });
    }
    this.closeForm();
  }
}
