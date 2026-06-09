import { ChangeDetectionStrategy, Component, signal, input, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, ProjectCostCenter } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-project-cost-centers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CurrencyPipe, DecimalPipe, FormsModule, ReactiveFormsModule],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <div>
                <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Cost Centers</h2>
                <p class="text-slate-500 mt-2 text-sm sm:text-base">Manage and allocate project budget to specific cost centers.</p>
              </div>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500/25 focus:border-blue-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <div>
                <h3 class="text-lg font-medium text-slate-900">Cost Centers</h3>
                <p class="text-sm text-slate-500">Manage and allocate project budget to specific cost centers.</p>
              </div>
            }
          </div>
          <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors shadow-sm flex items-center gap-2">
            <mat-icon class="text-sm">add</mat-icon> Add Cost Center
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view cost centers.</p>
          </div>
        } @else {
        <div class="bg-white rounded-xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm overflow-hidden">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-50 border-b border-slate-200 text-sm font-medium text-slate-500 uppercase tracking-wider">
                <th class="py-3 px-4">Cost Center ID</th>
                <th class="py-3 px-4">Name</th>
                <th class="py-3 px-4">Manager</th>
                <th class="py-3 px-4 text-right">Allocated Budget</th>
                <th class="py-3 px-4 text-right">Actual Spend</th>
                <th class="py-3 px-4 text-center">Status</th>
                <th class="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (cc of filteredCostCenters(); track cc.id) {
                <tr class="text-sm text-slate-700 hover:bg-slate-50 transition-colors">
                  <td class="py-3 px-4 font-mono text-blue-700">{{ cc.id }}</td>
                  <td class="py-3 px-4 font-medium">{{ cc.name }}</td>
                  <td class="py-3 px-4">{{ cc.manager }}</td>
                  <td class="py-3 px-4 text-right font-mono tabular-nums">{{ cc.allocated | currency:'EUR' }}</td>
                  <td class="py-3 px-4 text-right font-mono tabular-nums">{{ cc.actual | currency:'EUR' }}</td>
                  <td class="py-3 px-4 text-center">
                    @let usage = cc.allocated > 0 ? (cc.actual / cc.allocated) * 100 : 0;
                    <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ring-1"
                          [class.bg-emerald-50]="usage <= 80" [class.text-emerald-700]="usage <= 80" [class.ring-emerald-200]="usage <= 80"
                          [class.bg-amber-50]="usage > 80 && usage <= 100" [class.text-amber-700]="usage > 80 && usage <= 100" [class.ring-amber-200]="usage > 80 && usage <= 100"
                          [class.bg-red-50]="usage > 100" [class.text-red-700]="usage > 100" [class.ring-red-200]="usage > 100">
                      {{ usage | number:'1.0-0' }}% Used
                    </span>
                  </td>
                  <td class="py-3 px-4 text-right">
                    <button type="button" (click)="openEditForm(cc)" class="text-slate-400 hover:text-blue-700 transition-colors">
                      <mat-icon class="text-sm">edit</mat-icon>
                    </button>
                  </td>
                </tr>
              }
              @if (filteredCostCenters().length === 0) {
                <tr>
                  <td colspan="7" class="px-6 py-8 text-center text-slate-500">No cost centers found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      </div>

      <!-- Create Cost Center Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
          <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
              <h2 class="text-2xl font-bold text-slate-900 tracking-tight">{{ editingId() ? 'Edit Cost Center' : 'Add Cost Center' }}</h2>
              <button (click)="closeForm()" class="text-slate-400 hover:text-slate-700 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="ccForm" (ngSubmit)="saveCostCenter()" class="space-y-6">
                <div>
                  <label for="ccId" class="block text-sm font-semibold text-slate-700 mb-1.5">Cost Center ID *</label>
                  <input id="ccId" type="text" formControlName="id" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. CC-1234">
                </div>

                <div>
                  <label for="ccName" class="block text-sm font-semibold text-slate-700 mb-1.5">Name *</label>
                  <input id="ccName" type="text" formControlName="name" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. Engineering">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="ccBudget" class="block text-sm font-semibold text-slate-700 mb-1.5">Allocated Budget *</label>
                    <input id="ccBudget" type="number" formControlName="allocatedBudget" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white">
                  </div>

                  <div>
                    <label for="ccManager" class="block text-sm font-semibold text-slate-700 mb-1.5">Manager</label>
                    <input id="ccManager" type="text" formControlName="manager" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. John Doe">
                  </div>
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="saveCostCenter()" [disabled]="!ccForm.valid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                {{ editingId() ? 'Save Changes' : 'Add Cost Center' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectCostCenters {
  projectId = input<string>();
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  editingId = signal<string | null>(null);

  ccForm = new FormGroup({
    id: new FormControl('', Validators.required),
    name: new FormControl('', Validators.required),
    allocatedBudget: new FormControl(0, [Validators.required, Validators.min(0)]),
    manager: new FormControl('')
  });

  private costCentersRes = rxResource({ stream: () => this.api.getProjectCostCenters(), defaultValue: [] as ProjectCostCenter[] });
  costCenters = this.costCentersRes.value;

  filteredCostCenters = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.costCenters().filter(cc => cc.projectId === pId);
  });

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.editingId.set(null);
    this.ccForm.reset({ allocatedBudget: 0 });
    this.ccForm.get('id')?.enable();
    this.showForm.set(true);
  }

  openEditForm(cc: ProjectCostCenter) {
    this.editingId.set(cc.id);
    this.ccForm.reset({
      id: cc.id,
      name: cc.name,
      allocatedBudget: cc.allocated,
      manager: cc.manager,
    });
    this.ccForm.get('id')?.disable();
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.ccForm.get('id')?.enable();
    this.ccForm.reset({ allocatedBudget: 0 });
  }

  saveCostCenter() {
    if (this.ccForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.ccForm.getRawValue();
    const editingId = this.editingId();
    const allocated = Number.isNaN(v.allocatedBudget) ? 0 : (v.allocatedBudget ?? 0);

    if (editingId) {
      this.api.updateProjectCostCenter(editingId, {
        name: v.name ?? '',
        manager: v.manager ?? '',
        allocated,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.costCentersRes.reload());
    } else {
      this.api.createProjectCostCenter({
        id: v.id ?? '',
        projectId: pId,
        name: v.name ?? '',
        manager: v.manager ?? '',
        allocated,
        actual: 0,
      }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.costCentersRes.reload());
    }

    this.closeForm();
  }
}
