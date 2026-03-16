import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';

interface CostCenter {
  id: string;
  code: string;
  name: string;
  manager: string;
  description: string;
  status: 'Active' | 'Inactive';
}

@Component({
  selector: 'app-manage-cost-centers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, CommonModule, ReactiveFormsModule],
  template: `
    <div class="max-w-5xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div>
          <h1 class="text-3xl font-semibold text-slate-900">Manage Cost Centers</h1>
          <p class="text-slate-500 mt-1">Define and manage organizational cost centers for project budgeting.</p>
        </div>
        <button (click)="openForm()" class="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm flex items-center gap-2">
          <mat-icon class="text-sm">add</mat-icon> Add Cost Center
        </button>
      </div>

      <div class="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div class="p-4 border-b border-slate-100 flex gap-4 bg-slate-50/50">
          <div class="flex-1 relative">
            <mat-icon class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">search</mat-icon>
            <input type="text" placeholder="Search cost centers..." 
                   class="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 transition-all outline-none">
          </div>
        </div>
        
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50 border-b border-slate-200 text-sm font-medium text-slate-500">
              <th class="py-3 px-6">Code</th>
              <th class="py-3 px-6">Name</th>
              <th class="py-3 px-6">Manager</th>
              <th class="py-3 px-6">Status</th>
              <th class="py-3 px-6 text-right">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            @for (cc of costCenters(); track cc.id) {
              <tr class="text-sm text-slate-700 hover:bg-slate-50 transition-colors">
                <td class="py-4 px-6 font-mono font-medium text-slate-900">{{ cc.code }}</td>
                <td class="py-4 px-6 font-medium">{{ cc.name }}</td>
                <td class="py-4 px-6">{{ cc.manager }}</td>
                <td class="py-4 px-6">
                  <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium"
                        [class.bg-emerald-100]="cc.status === 'Active'"
                        [class.text-emerald-800]="cc.status === 'Active'"
                        [class.bg-slate-100]="cc.status === 'Inactive'"
                        [class.text-slate-800]="cc.status === 'Inactive'">
                    {{ cc.status }}
                  </span>
                </td>
                <td class="py-4 px-6 text-right">
                  <button (click)="openForm(cc)" class="text-slate-400 hover:text-indigo-600 transition-colors p-1">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                  </button>
                  <button (click)="deleteCostCenter(cc.id)" class="text-slate-400 hover:text-red-600 transition-colors p-1 ml-2">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                  </button>
                </td>
              </tr>
            }
            @if (costCenters().length === 0) {
              <tr>
                <td colspan="5" class="py-8 text-center text-slate-500">No cost centers defined yet.</td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Form Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col">
            <div class="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <h2 class="text-lg font-semibold text-slate-900">{{ editingId() ? 'Edit Cost Center' : 'Add Cost Center' }}</h2>
              <button (click)="closeForm()" class="text-slate-400 hover:text-slate-600 transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            
            <form [formGroup]="form" (ngSubmit)="saveCostCenter()" class="p-6 space-y-4">
              <div>
                <label for="code" class="block text-sm font-medium text-slate-700 mb-1">Code</label>
                <input id="code" type="text" formControlName="code" class="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm" placeholder="e.g. CC-1001">
              </div>
              
              <div>
                <label for="name" class="block text-sm font-medium text-slate-700 mb-1">Name</label>
                <input id="name" type="text" formControlName="name" class="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm" placeholder="e.g. Engineering & Dev">
              </div>
              
              <div>
                <label for="manager" class="block text-sm font-medium text-slate-700 mb-1">Manager</label>
                <input id="manager" type="text" formControlName="manager" class="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm" placeholder="e.g. Alice Smith">
              </div>
              
              <div>
                <label for="description" class="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea id="description" formControlName="description" rows="3" class="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm" placeholder="Optional description..."></textarea>
              </div>
              
              <div>
                <label for="status" class="block text-sm font-medium text-slate-700 mb-1">Status</label>
                <select id="status" formControlName="status" class="w-full px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all text-sm bg-white">
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>
              
              <div class="pt-4 flex justify-end gap-3">
                <button type="button" (click)="closeForm()" class="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors">Cancel</button>
                <button type="submit" [disabled]="!form.valid" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  Save Cost Center
                </button>
              </div>
            </form>
          </div>
        </div>
      }
      <!-- Delete Confirmation Modal -->
      @if (deletingId()) {
        <div class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden flex flex-col">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-red-500 text-3xl">warning</mat-icon>
              </div>
              <h3 class="text-lg font-semibold text-slate-900 mb-2">Delete Cost Center</h3>
              <p class="text-slate-500 text-sm">Are you sure you want to delete this cost center? This action cannot be undone.</p>
            </div>
            <div class="p-4 bg-slate-50 border-t border-slate-100 flex justify-end gap-3">
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
  costCenters = signal<CostCenter[]>([
    { id: '1', code: 'CC-1001', name: 'Engineering & Dev', manager: 'Alice Smith', description: 'Software engineering and development department.', status: 'Active' },
    { id: '2', code: 'CC-1002', name: 'Design & UX', manager: 'Bob Jones', description: 'Product design and user experience team.', status: 'Active' },
    { id: '3', code: 'CC-1003', name: 'Quality Assurance', manager: 'Charlie Brown', description: 'QA and testing department.', status: 'Active' },
    { id: '4', code: 'CC-1004', name: 'Project Management', manager: 'Diana Prince', description: 'PMO and project managers.', status: 'Active' },
  ]);

  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  form = new FormGroup({
    code: new FormControl('', Validators.required),
    name: new FormControl('', Validators.required),
    manager: new FormControl('', Validators.required),
    description: new FormControl(''),
    status: new FormControl<'Active' | 'Inactive'>('Active', Validators.required)
  });

  openForm(cc?: CostCenter) {
    if (cc) {
      this.editingId.set(cc.id);
      this.form.patchValue(cc);
    } else {
      this.editingId.set(null);
      this.form.reset({ status: 'Active' });
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
      const formValue = this.form.value as Omit<CostCenter, 'id'>;
      const id = this.editingId();
      
      if (id) {
        this.costCenters.update(ccs => ccs.map(cc => cc.id === id ? { ...cc, ...formValue } : cc));
      } else {
        const newCc: CostCenter = {
          ...formValue,
          id: Math.random().toString(36).substring(2, 9)
        };
        this.costCenters.update(ccs => [...ccs, newCc]);
      }
      this.closeForm();
    }
  }

  deleteCostCenter(id: string) {
    this.deletingId.set(id);
  }

  confirmDelete() {
    const id = this.deletingId();
    if (id) {
      this.costCenters.update(ccs => ccs.filter(cc => cc.id !== id));
      this.deletingId.set(null);
    }
  }

  cancelDelete() {
    this.deletingId.set(null);
  }
}
