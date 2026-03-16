import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ProjectRole } from '../services/api.service';

@Component({
  selector: 'app-manage-project-roles',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  template: `
    <div class="bg-white/80 backdrop-blur-md rounded-3xl shadow-sm border border-slate-200/60 overflow-hidden hover:shadow-md transition-all">
      <div class="p-6 sm:p-8 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
        <h2 class="text-xl font-bold text-slate-900 tracking-tight">Manage Project Roles</h2>
        <button (click)="openCreateForm()" class="bg-indigo-600 text-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-indigo-700 transition-all flex items-center gap-2 shadow-sm hover:shadow-md hover:-translate-y-0.5">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Role
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-slate-200/60 bg-slate-50/80 backdrop-blur-sm">
          <form [formGroup]="roleForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-md">
            <div>
              <label for="roleCode" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Code</label>
              <input id="roleCode" type="text" formControlName="code" maxlength="4" class="w-full px-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none bg-white shadow-inner font-bold text-slate-900 transition-all uppercase">
              <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider mt-2">Up to 4 alphanumeric characters.</p>
            </div>
            <div>
              <label for="roleName" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Name</label>
              <input id="roleName" type="text" formControlName="name" class="w-full px-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none bg-white shadow-inner font-bold text-slate-900 transition-all">
            </div>
            <div>
              <label for="roleDescription" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
              <textarea id="roleDescription" formControlName="description" rows="3" class="w-full px-4 py-3 rounded-xl border border-slate-200/60 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 focus:outline-none bg-white shadow-inner font-medium text-slate-700 transition-all"></textarea>
            </div>
            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-bold text-slate-600 bg-white border border-slate-200/60 rounded-xl hover:bg-slate-50 transition-all shadow-sm">Cancel</button>
              <button type="submit" [disabled]="roleForm.invalid" class="px-6 py-2.5 text-sm font-bold text-white bg-indigo-600 border border-transparent rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-all shadow-sm hover:shadow-md hover:-translate-y-0.5">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-slate-200/60">
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-24">Code</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider w-1/3">Name</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider">Description</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-center">Status</th>
                <th class="pb-4 font-bold text-slate-500 text-xs uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="text-sm">
              @for (role of roles(); track role.id) {
                <tr class="border-b border-slate-100 hover:bg-slate-50/80 transition-colors group" [class.opacity-60]="role.restricted">
                  <td class="py-5 text-slate-500 font-mono font-bold tracking-wide">{{ role.code }}</td>
                  <td class="py-5 text-slate-900 font-bold text-base group-hover:text-indigo-700 transition-colors">{{ role.name }}</td>
                  <td class="py-5 text-slate-600 font-medium">{{ role.description }}</td>
                  <td class="py-5 text-center">
                    @if (role.restricted) {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-red-50 text-red-700 border border-red-200/60 uppercase">Restricted</span>
                    } @else {
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold tracking-wide bg-emerald-50 text-emerald-700 border border-emerald-200/60 uppercase">Active</span>
                    }
                  </td>
                  <td class="py-5 text-right">
                    <button (click)="toggleRestrict(role)" class="w-10 h-10 rounded-full bg-white border border-slate-200 text-slate-500 hover:text-amber-600 hover:border-amber-200 hover:bg-amber-50 transition-all inline-flex items-center justify-center shadow-sm" [title]="role.restricted ? 'Unrestrict' : 'Restrict'">
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
export class ManageProjectRolesComponent implements OnInit {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);

  roles = signal<ProjectRole[]>([]);
  showForm = signal(false);

  roleForm: FormGroup = this.fb.group({
    code: ['', [Validators.required, Validators.maxLength(4), Validators.pattern('^[a-zA-Z0-9 ]*$')]],
    name: ['', Validators.required],
    description: ['']
  });

  ngOnInit() {
    this.loadRoles();
  }

  loadRoles() {
    this.api.getProjectRoles().subscribe(res => this.roles.set(res));
  }

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
        this.loadRoles();
        this.closeForm();
      });
    }
  }

  toggleRestrict(role: ProjectRole) {
    if (confirm(`Are you sure you want to ${role.restricted ? 'unrestrict' : 'restrict'} this role?`)) {
      this.api.updateProjectRole(role.id, { restricted: !role.restricted }).subscribe(() => {
        this.loadRoles();
      });
    }
  }
}
