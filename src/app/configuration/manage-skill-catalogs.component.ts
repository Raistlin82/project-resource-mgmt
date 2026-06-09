import { Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, SkillCatalog } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

@Component({
  selector: 'app-manage-skill-catalogs',
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Manage Skill Catalogs</h2>
        <button (click)="openCreateForm()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center gap-2 shadow-sm hover:-translate-y-0.5">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Catalog
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
          <form [formGroup]="catalogForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-md">
            <div>
              <label for="catalogName" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name</label>
              <input id="catalogName" type="text" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-bold text-slate-900 placeholder:text-slate-400 transition-all">
            </div>
            <div>
              <label for="catalogDescription" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
              <textarea id="catalogDescription" formControlName="description" rows="3" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-900 placeholder:text-slate-400 transition-all"></textarea>
            </div>
            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 transition-all shadow-sm">Cancel</button>
              <button type="submit" [disabled]="catalogForm.invalid" class="px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm hover:-translate-y-0.5">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/3">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Description</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-center">Skills Count</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (catalog of skillCatalogs(); track catalog.id) {
                <tr class="border-b border-slate-200 hover:bg-slate-50 transition-colors group">
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-blue-700 transition-colors">{{ catalog.name }}</td>
                  <td class="py-5 text-slate-600 font-medium">{{ catalog.description }}</td>
                  <td class="py-5 text-center">
                    <span class="inline-flex items-center justify-center w-8 h-8 text-xs font-bold font-mono tabular-nums text-blue-700 bg-blue-50 rounded-xl ring-1 ring-blue-200">{{ catalog.skills.length }}</span>
                  </td>
                  <td class="py-5 text-right">
                    <button (click)="deleteCatalog(catalog.id)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-500 hover:text-red-700 hover:border-red-200 hover:bg-red-50 transition-all inline-flex items-center justify-center shadow-sm" title="Delete">
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
  `
})
export class ManageSkillCatalogsComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notificationService = inject(NotificationService);

  private catalogsRes = rxResource({
    stream: () => this.api.getSkillCatalogs(),
    defaultValue: [] as SkillCatalog[]
  });
  skillCatalogs = computed(() => this.catalogsRes.value());

  showForm = signal(false);
  private pendingDeleteId = signal<string | null>(null);

  catalogForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: ['']
  });

  openCreateForm() {
    this.catalogForm.reset();
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  onSubmit() {
    if (this.catalogForm.valid) {
      this.api.createSkillCatalog(this.catalogForm.value).subscribe(() => {
        this.catalogsRes.reload();
        this.closeForm();
      });
    }
  }

  deleteCatalog(id: string) {
    if (this.pendingDeleteId() === id) {
      this.pendingDeleteId.set(null);
      this.api.deleteSkillCatalog(id).subscribe(() => {
        this.catalogsRes.reload();
      });
    } else {
      this.pendingDeleteId.set(id);
      this.notificationService.show('Click delete again to confirm removing this catalog', 'info');
    }
  }
}
