import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ReactiveFormsModule, FormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, CostCenter } from '../services/api.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';

@Component({
  selector: 'app-manage-cost-centers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ReactiveFormsModule, FormsModule, ModalDialogDirective],
  template: `
    <div class="max-w-5xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-3xl font-semibold text-slate-900">Manage Cost Centers</h1>
          <p class="text-slate-500 mt-1">Define and manage organizational cost centers for project budgeting.</p>
        </div>
        <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-4 py-2 rounded-xl text-sm transition-colors flex items-center gap-2">
          <mat-icon class="text-sm">add</mat-icon> Add Cost Center
        </button>
      </div>

      <div class="bg-white rounded-2xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-shadow">
        <div class="p-4 border-b border-slate-200 flex gap-4 bg-slate-50">
          <div class="flex-1 relative">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">search</mat-icon>
            <input type="text" placeholder="Search cost centers..."
                   [ngModel]="search()" (ngModelChange)="search.set($event)"
                   class="w-full pl-10 pr-4 py-2 bg-white focus:bg-white border border-slate-300 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 transition-all outline-none">
          </div>
        </div>

        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-200 text-sm font-medium text-slate-500 uppercase tracking-wider">
              <th class="py-3 px-6">Name</th>
              <th class="py-3 px-6">Manager</th>
              <th class="py-3 px-6 text-right">Allocated</th>
              <th class="py-3 px-6 text-right">Actual</th>
              <th class="py-3 px-6 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            @for (cc of filteredCostCenters(); track cc.id) {
              <tr class="text-sm text-slate-700 hover:bg-slate-50 transition-colors">
                <td class="py-4 px-6 font-medium text-slate-900">{{ cc.name }}</td>
                <td class="py-4 px-6">{{ cc.manager }}</td>
                <td class="py-4 px-6 text-right font-mono tabular-nums text-blue-700">{{ cc.allocated }}</td>
                <td class="py-4 px-6 text-right font-mono tabular-nums text-slate-900">{{ cc.actual }}</td>
                <td class="py-4 px-6 text-right">
                  <button type="button" (click)="openForm(cc)" [attr.aria-label]="'Edit ' + cc.name" [attr.title]="'Edit ' + cc.name" class="text-slate-400 hover:text-blue-700 transition-colors p-1">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                  </button>
                  <button type="button" (click)="deleteCostCenter(cc.id)" [attr.aria-label]="'Delete ' + cc.name" [attr.title]="'Delete ' + cc.name" class="text-slate-400 hover:text-red-600 transition-colors p-1 ml-2">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @if (filteredCostCenters().length === 0) {
              <tr>
                <td colspan="5" class="py-8 text-center text-slate-500">No cost centers defined yet.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Form Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="costCenterModalTitle" (dismiss)="closeForm()">
          <div class="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
            <div class="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-slate-50 to-transparent">
              <h2 id="costCenterModalTitle" class="text-lg font-semibold text-slate-900">{{ editingId() ? 'Edit Cost Center' : 'Add Cost Center' }}</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-slate-400 hover:text-slate-600 transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <form [formGroup]="form" (ngSubmit)="saveCostCenter()" class="p-6 space-y-4">
              <div>
                <label for="name" class="block text-sm font-medium text-slate-700 mb-1">Name</label>
                <input id="name" type="text" formControlName="name" class="w-full px-3 py-2 bg-white focus:bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm" placeholder="e.g. Engineering & Dev">
              </div>

              <div>
                <label for="manager" class="block text-sm font-medium text-slate-700 mb-1">Manager</label>
                <input id="manager" type="text" formControlName="manager" class="w-full px-3 py-2 bg-white focus:bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm" placeholder="e.g. Alice Smith">
              </div>

              <div>
                <label for="allocated" class="block text-sm font-medium text-slate-700 mb-1">Allocated</label>
                <input id="allocated" type="number" formControlName="allocated" class="w-full px-3 py-2 bg-white focus:bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm" placeholder="e.g. 100000">
              </div>

              <div>
                <label for="actual" class="block text-sm font-medium text-slate-700 mb-1">Actual</label>
                <input id="actual" type="number" formControlName="actual" class="w-full px-3 py-2 bg-white focus:bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm" placeholder="e.g. 75000">
              </div>

              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeForm()" class="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">Cancel</button>
                <button type="submit" [disabled]="!form.valid" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  Save Cost Center
                </button>
              </div>
            </form>
          </div>
        </div>
      }
      <!-- Delete Confirmation Modal -->
      @if (deletingId()) {
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="costCenterDeleteTitle" (dismiss)="cancelDelete()">
          <div class="bg-white border border-slate-200 rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-red-50 ring-1 ring-red-200 rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-red-700 text-3xl">warning</mat-icon>
              </div>
              <h3 id="costCenterDeleteTitle" class="text-lg font-semibold text-slate-900 mb-2">Delete Cost Center</h3>
              <p class="text-slate-500 text-sm">Are you sure you want to delete this cost center? This action cannot be undone.</p>
            </div>
            <div class="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-3">
              <button (click)="cancelDelete()" class="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">Cancel</button>
              <button (click)="confirmDelete()" class="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors shadow-sm">Delete</button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ManageCostCentersComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  private costCentersRes = rxResource({ stream: () => this.api.getCostCenters(), defaultValue: [] as CostCenter[] });
  costCenters = this.costCentersRes.value;

  search = signal('');
  filteredCostCenters = computed(() => {
    const q = this.search().toLowerCase();
    return this.costCenters().filter(c => c.name.toLowerCase().includes(q));
  });

  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  form = new FormGroup({
    name: new FormControl('', Validators.required),
    manager: new FormControl('', Validators.required),
    allocated: new FormControl<number>(0, Validators.required),
    actual: new FormControl<number>(0, Validators.required)
  });

  openForm(cc?: CostCenter) {
    if (cc) {
      this.editingId.set(cc.id);
      this.form.patchValue({
        name: cc.name,
        manager: cc.manager,
        allocated: cc.allocated,
        actual: cc.actual
      });
    } else {
      this.editingId.set(null);
      this.form.reset({ name: '', manager: '', allocated: 0, actual: 0 });
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
    this.form.reset();
  }

  saveCostCenter() {
    if (this.form.valid) {
      const raw = this.form.getRawValue();
      const payload: Partial<CostCenter> = {
        name: raw.name ?? '',
        manager: raw.manager ?? '',
        allocated: raw.allocated ?? 0,
        actual: raw.actual ?? 0
      };
      const id = this.editingId();

      if (id) {
        this.api.updateCostCenter(id, payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
          this.costCentersRes.reload();
          this.closeForm();
        });
      } else {
        this.api.createCostCenter(payload).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
          this.costCentersRes.reload();
          this.closeForm();
        });
      }
    }
  }

  deleteCostCenter(id: string) {
    this.deletingId.set(id);
  }

  confirmDelete() {
    const id = this.deletingId();
    if (id) {
      this.api.deleteCostCenter(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
        this.costCentersRes.reload();
        this.deletingId.set(null);
      });
    }
  }

  cancelDelete() {
    this.deletingId.set(null);
  }
}
