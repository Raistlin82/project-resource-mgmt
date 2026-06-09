import { Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormArray } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceOrganization } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

@Component({
  selector: 'app-manage-resource-organizations',
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Manage Resource Organizations</h2>
        <button (click)="openCreateForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2.5 rounded-xl text-sm shadow-sm transition-all flex items-center gap-2 hover:-translate-y-0.5">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Organization
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
          <form [formGroup]="orgForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-3xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="orgName" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name</label>
                <input id="orgName" type="text" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-bold text-slate-900 placeholder:text-slate-400 transition-all">
              </div>
              <div>
                <label for="orgDescription" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
                <input id="orgDescription" type="text" formControlName="description" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-900 placeholder:text-slate-400 transition-all">
              </div>
            </div>

            <div formArrayName="costCenters" class="space-y-4 mt-8">
              <div class="flex justify-between items-center pb-2 border-b border-slate-200">
                <h3 class="text-sm font-bold text-slate-700 uppercase tracking-wider">Cost Centers</h3>
                <button type="button" (click)="addCostCenter()" class="text-blue-700 hover:text-blue-800 text-sm font-bold flex items-center gap-1.5 transition-colors bg-blue-50 hover:bg-blue-100 ring-1 ring-blue-200 px-3 py-1.5 rounded-lg">
                  <mat-icon class="text-[18px] w-[18px] h-[18px]">add_circle</mat-icon> Add Cost Center
                </button>
              </div>

              <div class="space-y-3">
                @for (cc of costCenters.controls; track i; let i = $index) {
                  <div class="flex gap-4 items-center bg-white p-4 rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm hover:shadow-md transition-all group">
                    <div class="flex-1">
                      <input type="text" [formControlName]="i" placeholder="Cost Center ID" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white font-mono font-bold text-blue-700 placeholder:text-slate-400 transition-all">
                    </div>
                    <button type="button" (click)="removeCostCenter(i)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-400 hover:text-red-600 hover:border-red-300 hover:bg-red-50 transition-all inline-flex items-center justify-center shadow-sm">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">remove_circle</mat-icon>
                    </button>
                  </div>
                }
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-6 border-t border-slate-200">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 transition-all shadow-sm">Cancel</button>
              <button type="submit" [disabled]="orgForm.invalid" class="px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm hover:-translate-y-0.5">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/4">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/3">Description</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Cost Centers</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (org of resourceOrganizations(); track org.id) {
                <tr class="border-b border-slate-200 hover:bg-slate-50 transition-colors group">
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-blue-700 transition-colors">{{ org.name }}</td>
                  <td class="py-5 text-slate-600 font-medium">{{ org.description }}</td>
                  <td class="py-5 text-slate-600">
                    <div class="flex flex-wrap gap-2">
                      @for (cc of org.costCenters; track cc) {
                        <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-blue-50 text-blue-700 font-mono ring-1 ring-blue-200">
                          {{ cc }}
                        </span>
                      }
                    </div>
                  </td>
                  <td class="py-5 text-right">
                    <button (click)="deleteOrg(org.id)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-500 hover:text-red-600 hover:border-red-300 hover:bg-red-50 transition-all inline-flex items-center justify-center shadow-sm" title="Delete">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    @if (deletingId()) {
      <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
        <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden flex flex-col transform transition-all">
          <div class="p-8 text-center">
            <div class="w-20 h-20 bg-red-50 ring-1 ring-red-200 rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
              <mat-icon class="text-red-600 text-4xl">warning</mat-icon>
            </div>
            <h3 class="text-2xl font-bold text-slate-900 mb-2 tracking-tight">Delete Resource Organization</h3>
            <p class="text-slate-500 text-sm">Are you sure you want to delete this resource organization? This action cannot be undone.</p>
          </div>
          <div class="p-5 bg-slate-50 border-t border-slate-200 flex justify-end gap-3">
            <button (click)="cancelDelete()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
            <button (click)="confirmDelete()" class="px-6 py-2.5 bg-red-50 text-red-700 ring-1 ring-red-200 rounded-xl text-sm font-semibold hover:bg-red-100 hover:shadow-md hover:-translate-y-0.5 transition-all">Delete</button>
          </div>
        </div>
      </div>
    }
  `
})
export class ManageResourceOrganizationsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notifications = inject(NotificationService);

  private orgsRes = rxResource({ stream: () => this.api.getResourceOrganizations(), defaultValue: [] as ResourceOrganization[] });
  resourceOrganizations = computed(() => this.orgsRes.value());
  showForm = signal(false);
  deletingId = signal<string | null>(null);

  orgForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: [''],
    costCenters: this.fb.array([])
  });

  get costCenters() {
    return this.orgForm.get('costCenters') as FormArray;
  }

  openCreateForm() {
    this.orgForm.reset();
    this.costCenters.clear();
    this.addCostCenter();
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  addCostCenter() {
    this.costCenters.push(this.fb.control('', Validators.required));
  }

  removeCostCenter(index: number) {
    this.costCenters.removeAt(index);
  }

  onSubmit() {
    if (this.orgForm.valid) {
      this.api.createResourceOrganization(this.orgForm.value).subscribe(() => {
        this.orgsRes.reload();
        this.closeForm();
        this.notifications.show('Resource organization created.', 'success');
      });
    }
  }

  deleteOrg(id: string) {
    this.deletingId.set(id);
  }

  confirmDelete() {
    const id = this.deletingId();
    if (id) {
      this.api.deleteResourceOrganization(id).subscribe(() => {
        this.orgsRes.reload();
        this.deletingId.set(null);
        this.notifications.show('Resource organization deleted.', 'success');
      });
    }
  }

  cancelDelete() {
    this.deletingId.set(null);
  }
}
