import { ChangeDetectionStrategy, Component, input, signal, computed, inject, OnInit } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project } from '../../services/api.service';

@Component({
  selector: 'app-financial-plans',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, FormsModule, ReactiveFormsModule],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Financial Plans</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Financial Plans</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors flex items-center gap-2 shadow-sm">
            <mat-icon class="text-sm">add</mat-icon> Create Financial Plan
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-100 p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view financial plans.</p>
          </div>
        } @else {
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div class="bg-white rounded-2xl border border-slate-100 p-6">
            <h3 class="text-sm font-medium text-slate-500 mb-1">Total Budget</h3>
            <p class="text-2xl font-semibold text-slate-900">{{ totalBudget() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-100 p-6">
            <h3 class="text-sm font-medium text-slate-500 mb-1">Spent</h3>
            <p class="text-2xl font-semibold text-slate-900">{{ totalSpent() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-100 p-6">
            <h3 class="text-sm font-medium text-slate-500 mb-1">Remaining</h3>
            <p class="text-2xl font-semibold text-emerald-600">{{ totalBudget() - totalSpent() | currency:'USD':'symbol':'1.0-0' }}</p>
          </div>
        </div>

        <div class="bg-white rounded-2xl border border-slate-100 overflow-hidden">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 border-b border-slate-100 text-slate-500">
              <tr>
                <th class="px-6 py-4 font-medium">Category</th>
                <th class="px-6 py-4 font-medium">Budget</th>
                <th class="px-6 py-4 font-medium">Actual</th>
                <th class="px-6 py-4 font-medium">Variance</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (item of filteredFinancials(); track item.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-slate-900">{{ item.category }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ item.budget | currency:'USD':'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ item.actual | currency:'USD':'symbol':'1.0-0' }}</td>
                  <td class="px-6 py-4" [class.text-emerald-600]="item.budget - item.actual > 0" [class.text-red-600]="item.budget - item.actual < 0" [class.text-slate-600]="item.budget - item.actual === 0">
                    {{ item.budget - item.actual > 0 ? '+' : '' }}{{ item.budget - item.actual | currency:'USD':'symbol':'1.0-0' }}
                  </td>
                </tr>
              }
              @if (filteredFinancials().length === 0) {
                <tr>
                  <td colspan="4" class="px-6 py-8 text-center text-slate-500">No financial records found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      </div>

      <!-- Create Financial Plan Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
          <div class="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-gradient-to-br from-slate-50 to-white">
              <h2 class="text-2xl font-bold text-slate-900 tracking-tight">Create Financial Plan</h2>
              <button (click)="closeForm()" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="finForm" (ngSubmit)="savePlan()" class="space-y-6">
                <div>
                  <label for="finCategory" class="block text-sm font-semibold text-slate-700 mb-1.5">Category *</label>
                  <input id="finCategory" type="text" formControlName="category" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="e.g. Software Licenses">
                </div>
                
                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="finBudget" class="block text-sm font-semibold text-slate-700 mb-1.5">Budget ($) *</label>
                    <input id="finBudget" type="number" formControlName="budget" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="0">
                  </div>
                  <div>
                    <label for="finActual" class="block text-sm font-semibold text-slate-700 mb-1.5">Actual Spent ($) *</label>
                    <input id="finActual" type="number" formControlName="actual" class="w-full px-4 py-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all text-sm bg-slate-50 focus:bg-white" placeholder="0">
                  </div>
                </div>
              </form>
            </div>
            
            <div class="px-6 sm:px-8 py-5 border-t border-slate-100 bg-slate-50/80 backdrop-blur-sm flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="savePlan()" [disabled]="!finForm.valid" class="px-6 py-2.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 hover:shadow-lg hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                Save
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class FinancialPlans implements OnInit {
  projectId = input<string>();
  private api = inject(ApiService);
  
  projects = signal<Project[]>([]);
  selectedProjectId = signal<string>('');
  
  showForm = signal(false);
  
  finForm = new FormGroup({
    category: new FormControl('', Validators.required),
    budget: new FormControl<number | null>(null, [Validators.required, Validators.min(0)]),
    actual: new FormControl<number | null>(null, [Validators.required, Validators.min(0)])
  });

  financials = signal([
    { id: 'F1', projectId: 'P-1001', category: 'Software Licenses', budget: 20000, actual: 18500 },
    { id: 'F2', projectId: 'P-1001', category: 'Consulting Services', budget: 50000, actual: 25000 },
    { id: 'F3', projectId: 'P-1002', category: 'Hardware', budget: 10000, actual: 11200 }
  ]);

  filteredFinancials = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.financials().filter(f => f.projectId === pId);
  });

  totalBudget = computed(() => this.filteredFinancials().reduce((sum, item) => sum + item.budget, 0));
  totalSpent = computed(() => this.filteredFinancials().reduce((sum, item) => sum + item.actual, 0));

  ngOnInit() {
    this.api.getProjects().subscribe(p => this.projects.set(p));
  }

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      alert('Please select a project first.');
      return;
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.finForm.reset();
  }

  savePlan() {
    if (this.finForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const newPlan = {
      id: 'F' + Math.floor(Math.random() * 10000),
      projectId: pId,
      ...this.finForm.value
    } as any;

    this.financials.update(f => [...f, newPlan]);
    this.closeForm();
  }
}
