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
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Manage Project Roles</h2>
        <button (click)="openCreateForm()" class="command-button">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Role
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
          <form [formGroup]="roleForm" (ngSubmit)="onSubmit()" class="space-y-6 max-w-md">
            <div>
              <label for="roleCode" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Code</label>
              <input id="roleCode" type="text" formControlName="code" maxlength="4" class="command-input font-mono uppercase">
              <p class="text-[10px] font-bold text-[var(--cc-muted)] uppercase tracking-wider mt-2">Up to 4 alphanumeric characters.</p>
            </div>
            <div>
              <label for="roleName" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Name</label>
              <input id="roleName" type="text" formControlName="name" class="command-input">
            </div>
            <div>
              <label for="roleDescription" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Description</label>
              <textarea id="roleDescription" formControlName="description" rows="3" class="command-textarea"></textarea>
            </div>
            <div class="flex justify-end gap-3 pt-2">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="submit" [disabled]="roleForm.invalid" class="command-button disabled:opacity-50">Save</button>
            </div>
          </form>
        </div>
      }

      <div class="overflow-x-auto">
        <table class="command-data-table">
          <thead>
            <tr>
              <th class="w-24">Code</th>
              <th class="w-1/3">Name</th>
              <th>Description</th>
              <th>Status</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            @for (role of roles(); track role.id) {
              <tr [class.opacity-60]="role.restricted">
                <td><span class="font-mono font-bold tracking-wide text-[var(--cc-primary-text)]">{{ role.code }}</span></td>
                <td class="font-bold">{{ role.name }}</td>
                <td>{{ role.description }}</td>
                <td>
                  @if (role.restricted) {
                    <span class="command-status red">Restricted</span>
                  } @else {
                    <span class="command-status green">Active</span>
                  }
                </td>
                <td class="text-right">
                  <button type="button" (click)="toggleRestrict(role)" class="w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-caution-text hover:border-caution hover:bg-caution-tint transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="(role.restricted ? 'Unrestrict ' : 'Restrict ') + role.name" [title]="role.restricted ? 'Unrestrict' : 'Restrict'">
                    <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ role.restricted ? 'lock_open' : 'block' }}</mat-icon>
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
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
