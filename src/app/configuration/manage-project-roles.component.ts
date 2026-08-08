import { Component, inject, signal, computed } from '@angular/core';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ProjectRole } from '../services/api.service';
import { NotificationService } from '../services/notification.service';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { ConfigurationPageShellComponent } from './configuration-page-shell.component';

@Component({
  selector: 'app-manage-project-roles',
  imports: [ReactiveFormsModule, MatIconModule, ConfigurationPageShellComponent],
  template: `
    <app-configuration-page-shell title="Manage Project Roles" subtitle="Maintain the controlled roles used in project staffing.">
      <button configuration-actions (click)="openCreateForm()" class="command-button">
        <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Role
      </button>
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Project roles</h2>
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
                  <!-- ARMED STATE IS RENDERED IN THE ROW, not announced in a toast.
                       The previous shape armed pendingRestrictId invisibly and never
                       expired it, while its only warning was a toast that
                       auto-dismisses after 5s. Ten minutes later a click on the same
                       icon flipped the role's Restricted flag with no dialog and no
                       undo — and the armed id survived a click on ANOTHER row, so
                       nothing on screen said which role was armed. Confirm/Cancel
                       live inside the armed row, so the armed object is always the
                       object the admin can see. Same shape as
                       manage-skills.component.ts.
                       The armed label follows the ROW's direction, because this one
                       control both restricts and unrestricts. -->
                  @if (pendingRestrictId() === role.id) {
                    <div class="inline-flex items-center gap-2">
                      <span class="text-xs font-bold text-[var(--cc-muted)]">{{ role.restricted ? 'Unrestrict' : 'Restrict' }} {{ role.name }}?</span>
                      <button type="button" (click)="confirmRestrict(role)" class="px-3 py-1.5 text-xs font-bold text-caution-text bg-caution-tint ring-1 ring-caution rounded-lg hover:bg-[color-mix(in_oklch,var(--color-caution)_16%,var(--color-surface))] transition-all shadow-sm">Confirm</button>
                      <button type="button" (click)="cancelRestrict()" class="px-3 py-1.5 text-xs font-bold text-ink-secondary bg-surface border border-line rounded-lg hover:bg-surface-muted transition-all shadow-sm">Cancel</button>
                    </div>
                  } @else {
                    <button type="button" (click)="requestRestrict(role)" class="w-10 h-10 rounded-full bg-surface border border-line text-ink-muted hover:text-caution-text hover:border-caution hover:bg-caution-tint transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="(role.restricted ? 'Unrestrict ' : 'Restrict ') + role.name" [title]="role.restricted ? 'Unrestrict' : 'Restrict'">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ role.restricted ? 'lock_open' : 'block' }}</mat-icon>
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </div>
    </app-configuration-page-shell>
  `
})
export class ManageProjectRolesComponent {
  private api = inject(ApiService);
  private fb = inject(FormBuilder);
  private notificationService = inject(NotificationService);

  private rolesRes = authGatedResource(() => this.api.getProjectRoles(), [] as ProjectRole[]);
  roles = computed(() => this.rolesRes.value());
  showForm = signal(false);
  /** Read by the template: the armed row renders its own Confirm/Cancel pair. */
  protected pendingRestrictId = signal<string | null>(null);

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

  /**
   * Arms the row. Deliberately CANNOT write: the only path to the PUT is the
   * Confirm control rendered inside the armed row, so a stale click on this icon —
   * or on another row's — can never flip a role.
   *
   * The toast is corroboration, not the warning: it names the role and the
   * direction. It deliberately does NOT promise that restricting takes the role out
   * of staffing. NOTHING enforces the flag today: all seven consumers of
   * /project-roles (manage-rate-cards, project-rates, resources, contract-details,
   * my-profile, resource-requests and this screen) list every role, none filters on
   * `restricted`, and the server only stores it. So the honest statement is that the
   * catalog entry is marked — promising an enforcement that does not exist is the
   * same defect the vendors dialog was corrected for.
   */
  requestRestrict(role: ProjectRole) {
    this.pendingRestrictId.set(role.id);
    const action = role.restricted ? 'unrestricting' : 'restricting';
    this.notificationService.show(
      `Confirm ${action} "${role.name}". This marks the catalog entry only: rate cards, requests and resumes that already name the role keep it.`,
      'info',
    );
  }

  cancelRestrict() {
    this.pendingRestrictId.set(null);
  }

  confirmRestrict(role: ProjectRole) {
    this.api.updateProjectRole(role.id, { restricted: !role.restricted }).subscribe(() => {
      this.pendingRestrictId.set(null);
      this.rolesRes.reload();
    });
  }
}
