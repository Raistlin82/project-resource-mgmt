import { Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ProjectRole } from '../services/api.service';
import { NotificationService } from '../services/notification.service';

@Component({
  selector: 'app-manage-project-roles',
  imports: [ReactiveFormsModule, MatIconModule],
  template: `
    <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-200 flex justify-between items-center bg-slate-50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Manage Project Roles</h2>
        <button (click)="openCreateForm()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center gap-2 shadow-sm hover:-translate-y-0.5">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Role
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-slate-200 bg-slate-50">
          <form [formGroup]="roleForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-md">
            <div>
              <label for="roleCode" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Code</label>
              <input id="roleCode" type="text" formControlName="code" maxlength="4" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-bold text-blue-700 font-mono placeholder:text-slate-400 transition-all uppercase">
              <p class="text-[10px] font-bold text-slate-600 uppercase tracking-wider mt-2">Up to 4 alphanumeric characters.</p>
            </div>
            <div>
              <label for="roleName" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name</label>
              <input id="roleName" type="text" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-bold text-slate-900 placeholder:text-slate-400 transition-all">
            </div>
            <div>
              <label for="roleDescription" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
              <textarea id="roleDescription" formControlName="description" rows="3" class="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none bg-white focus:bg-white shadow-inner font-medium text-slate-700 placeholder:text-slate-400 transition-all"></textarea>
            </div>
            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-bold text-slate-600 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all shadow-sm">Cancel</button>
              <button type="submit" [disabled]="roleForm.invalid" class="px-6 py-2.5 text-sm font-semibold text-white bg-blue-600 border border-transparent rounded-xl hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm hover:-translate-y-0.5">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-24">Code</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/3">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Description</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-center">Status</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (role of roles(); track role.id) {
                <tr class="border-b border-slate-200 hover:bg-slate-50 transition-colors group" [class.opacity-60]="role.restricted">
                  <td class="py-5 text-blue-700 font-mono font-bold tracking-wide">{{ role.code }}</td>
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-blue-700 transition-colors">{{ role.name }}</td>
                  <td class="py-5 text-slate-600 font-medium">{{ role.description }}</td>
                  <td class="py-5 text-center">
                    @if (role.restricted) {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-red-50 text-red-700 ring-1 ring-red-200 uppercase">Restricted</span>
                    } @else {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 uppercase">Active</span>
                    }
                  </td>
                  <td class="py-5 text-right">
                    <button type="button" (click)="toggleRestrict(role)" class="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 text-slate-500 hover:text-amber-700 hover:border-amber-200 hover:bg-amber-50 transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="(role.restricted ? 'Unrestrict ' : 'Restrict ') + role.name" [title]="role.restricted ? 'Unrestrict' : 'Restrict'">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ role.restricted ? 'lock_open' : 'block' }}</mat-icon>
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
export class ManageProjectRolesComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notificationService = inject(NotificationService);

  private rolesRes = rxResource({ stream: () => this.api.getProjectRoles(), defaultValue: [] as ProjectRole[] });
  roles = computed(() => this.rolesRes.value());
  showForm = signal(false);
  private pendingRestrictId = signal<string | null>(null);

  roleForm: FormGroup = this.fb.group({
    code: ['', [Validators.required, Validators.maxLength(4), Validators.pattern('^[a-zA-Z0-9 ]*$')]],
    name: ['', Validators.required],
    description: ['']
  });

  openCreateForm() {
    this.roleForm.reset();
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
  }

  onSubmit() {
    if (this.roleForm.valid) {
      // Ensure code is uppercase
      const formValue = { ...this.roleForm.value, code: this.roleForm.value.code.toUpperCase() };
      this.api.createProjectRole(formValue).subscribe(() => {
        this.rolesRes.reload();
        this.closeForm();
      });
    }
  }

  toggleRestrict(role: ProjectRole) {
    const action = role.restricted ? 'unrestrict' : 'restrict';
    if (this.pendingRestrictId() === role.id) {
      this.pendingRestrictId.set(null);
      this.api.updateProjectRole(role.id, { restricted: !role.restricted }).subscribe(() => {
        this.rolesRes.reload();
      });
    } else {
      this.pendingRestrictId.set(role.id);
      this.notificationService.show(`Click again to confirm you want to ${action} this role`, 'info');
    }
  }
}
