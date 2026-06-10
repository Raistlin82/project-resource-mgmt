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
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Financial Plans</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="font-display text-lg font-semibold text-[var(--cc-ink)]">Financial Plans</h2>
            }
          </div>
          <button (click)="openForm()" class="command-button">
            <mat-icon class="text-sm">add</mat-icon> Create Financial Plan
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="font-display text-lg font-semibold text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view financial plans.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div class="command-kpi">
            <h3 class="command-kpi-label">Total Budget</h3>
            <p class="command-kpi-value">{{ totalBudget() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
          <div class="command-kpi">
            <h3 class="command-kpi-label">Spent</h3>
            <p class="command-kpi-value">{{ totalSpent() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
          <div class="command-kpi green">
            <h3 class="command-kpi-label">Remaining</h3>
            <p class="command-kpi-value">{{ totalBudget() - totalSpent() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
        </div>

        <div class="command-card overflow-hidden">
          <table class="command-data-table">
            <thead>
              <tr>
                <th class="px-6 py-4">Category</th>
                <th class="px-6 py-4 text-right">Budget</th>
                <th class="px-6 py-4 text-right">Actual</th>
                <th class="px-6 py-4 text-right">Variance</th>
                <th class="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--cc-line)]">
              @for (item of filteredFinancials(); track item.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-[var(--cc-ink)]">{{ item.category }}</td>
                  <td class="px-6 py-4 text-right text-[var(--cc-muted)] font-mono tabular-nums">{{ item.budget | currency:'USD':'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4 text-right text-[var(--cc-muted)] font-mono tabular-nums">{{ item.actual | currency:'USD':'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4 text-right font-mono tabular-nums" [class.text-emerald-700]="item.budget - item.actual > 0" [class.text-red-700]="item.budget - item.actual < 0" [class.text-slate-600]="item.budget - item.actual === 0">
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
                  <td colspan="5" class="px-6 py-8 text-center text-[var(--cc-muted)]">No financial records found for this project.</td>
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
          <div class="command-card shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="command-card-header">
              <h2 id="financialPlanModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ editingId() ? 'Edit Financial Plan' : 'Create Financial Plan' }}</h2>
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
            
            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="savePlan()" [disabled]="!finForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
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
