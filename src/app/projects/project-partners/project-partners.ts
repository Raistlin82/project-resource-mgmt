import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, Partner, Vendor, PartnerRole } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { authGatedResource } from '../../services/auth-gated-resource.util';

@Component({
  selector: 'app-project-partners',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            @if (!projectId()) {
              <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Project Partners</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" aria-label="Select project" class="block w-full min-w-0 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)] sm:w-auto">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Project Partners</h2>
            }
          </div>
          <button (click)="openForm()" class="command-button self-start sm:self-auto">
            <mat-icon class="text-sm">person_add</mat-icon> Invite Partner
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view partners.</p>
          </div>
        } @else {
        <div class="command-card overflow-x-auto">
          <table class="command-data-table min-w-[44rem]">
            <thead>
              <tr>
                <th class="px-6 py-4 font-medium">Company</th>
                <th class="px-6 py-4 font-medium">Role</th>
                <th class="px-6 py-4 font-medium">Key Contact</th>
                <th class="px-6 py-4 font-medium">Status</th>
                <th class="px-6 py-4 font-medium"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--cc-line)]">
              @for (partner of filteredPartners(); track partner.id) {
                <tr>
                  <td class="px-6 py-4 font-medium text-[var(--cc-ink)]">{{ partner.company }}</td>
                  <td class="px-6 py-4 text-[var(--cc-muted)]">{{ partner.role }}</td>
                  <td class="px-6 py-4 text-[var(--cc-muted)]">{{ partner.contact }}</td>
                  <td class="px-6 py-4">
                    <span class="command-status" [class.green]="partner.status === 'Active'">
                      {{ partner.status }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-right">
                    <button type="button" (click)="askRemove(partner)" [attr.aria-label]="'Remove ' + partner.company" [attr.title]="'Remove ' + partner.company" class="text-ink-muted hover:text-critical-text transition-colors p-1">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
              @if (filteredPartners().length === 0) {
                <tr>
                  <td colspan="5" class="px-6 py-8 text-center text-[var(--cc-muted)]">No partners found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      </div>

      <!-- Invite Partner Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="partnerModalTitle" (dismiss)="closeForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="partnerModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Invite Partner</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="partnerForm" (ngSubmit)="savePartner()" class="space-y-6">
                <!-- Rendered INLINE rather than left to the interceptor's toast, because
                     error toasts in this app auto-dismiss: a dialog that stays open with a
                     vanished toast is an unexplained refusal. Same shape as
                     project-cost-centers.ts's saveError. -->
                @if (saveError(); as err) {
                  <p role="alert" data-test="partner-save-error" class="text-xs text-critical-text">{{ err }}</p>
                }
                <div>
                  <label for="partnerCompany" class="block text-sm font-semibold text-ink-secondary mb-1.5">Company Name *</label>
                  <!-- Company is a config FK to the vendors catalog (store = company name). -->
                  <select id="partnerCompany" formControlName="company" class="command-select">
                    <option value="" disabled>Select a vendor...</option>
                    @for (v of vendorOptions(); track v.id) {
                      <option [value]="v.name">{{ v.name }}</option>
                    }
                    @if (orphanCompany(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>

                <div>
                  <label for="partnerRole" class="block text-sm font-semibold text-ink-secondary mb-1.5">Role *</label>
                  <!-- Role is a config FK to the partner-roles catalog (store = role name). -->
                  <select id="partnerRole" formControlName="role" class="command-select">
                    <option value="" disabled>Select a role...</option>
                    @for (r of roleOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanRole(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>

                <div>
                  <label for="partnerContact" class="block text-sm font-semibold text-ink-secondary mb-1.5">Key Contact</label>
                  <input id="partnerContact" type="text" formControlName="contact" class="command-input" placeholder="e.g. Jane Doe">
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="savePartner()" [disabled]="!partnerForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Invite Partner
              </button>
            </div>
          </div>
        </div>
      }

      <!--
        REMOVE CONFIRMATION. The confirm step itself was already here; what was
        missing is the CONSEQUENCE. "Are you sure … cannot be undone" tells the PM
        nothing they could weigh: what leaves with the row is this project's only
        record of the engagement (role and key contact), and every subcontractor task
        still pointing at this partner keeps a partnerId that no longer resolves —
        project-tasks.ts:409-411 then prints the raw id in place of the company name.
        Short dialog, so the plain centred overlay is deliberate (see
        manage-rate-cards.component.spec.ts's negative control).
      -->
      @if (removing(); as partner) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="partnerRemoveTitle" (dismiss)="cancelRemove()">
          <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col" data-test="partner-remove-confirm">
            <div class="p-6 text-center">
              <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-4">
                <mat-icon class="text-critical-text text-3xl">warning</mat-icon>
              </div>
              <h3 id="partnerRemoveTitle" class="font-display text-lg font-bold text-[var(--cc-ink)] mb-2">Remove Partner</h3>
              <p class="text-[var(--cc-muted)] text-sm">
                <strong class="text-ink">{{ partner.company }}</strong> leaves this project, and with it the
                {{ partner.role || 'partner' }} role and the key contact {{ partner.contact || 'on record' }}.
                Any subcontractor task still assigned to this partner keeps a reference that no longer resolves,
                so its Assignment cell shows the raw partner id instead of the company name.
                This cannot be undone from this screen.
              </p>
            </div>
            <div class="p-4 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
              <button type="button" (click)="cancelRemove()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="confirmRemove()" data-test="partner-remove-confirm-action" class="px-4 py-2 bg-critical text-white rounded-lg text-sm font-medium hover:bg-critical-strong transition-colors shadow-sm">Remove</button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectPartners {
  projectId = input<string>();
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  partnerForm = new FormGroup({
    company: new FormControl('', Validators.required),
    role: new FormControl('', Validators.required),
    contact: new FormControl('')
  });

  // Company -> vendors, Role -> partner-roles (Phase F2). `contact` stays FREE (it is
  // an external person name, not an internal FK). Both catalogs need a principal.
  private vendorsRes = authGatedResource(() => this.api.getVendors(), [] as Vendor[]);
  private rolesRes = authGatedResource(() => this.api.getPartnerRoles(), [] as PartnerRole[]);
  vendorOptions = this.vendorsRes.value;
  roleOptions = this.rolesRes.value;

  // ORPHAN VALUE: a stored company/role not in the catalog stays selectable as a disabled option.
  private companyValue = toSignal(this.partnerForm.controls.company.valueChanges, { initialValue: this.partnerForm.controls.company.value });
  private roleValue = toSignal(this.partnerForm.controls.role.valueChanges, { initialValue: this.partnerForm.controls.role.value });
  orphanCompany = computed<string | null>(() => {
    const current = this.companyValue();
    if (!current) return null;
    return this.vendorOptions().some(v => v.name === current) ? null : current;
  });
  orphanRole = computed<string | null>(() => {
    const current = this.roleValue();
    if (!current) return null;
    return this.roleOptions().some(r => r.name === current) ? null : current;
  });
  
  private partnersRes = authGatedResource(() => this.api.getProjectPartners(), [] as Partner[]);
  partners = this.partnersRes.value;

  filteredPartners = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.partners().filter(p => p.projectId === pId);
  });

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.showForm.set(true);
  }

  /** Server refusal text for the open dialog, or null. See the template comment. */
  saveError = signal<string | null>(null);

  closeForm() {
    this.showForm.set(false);
    this.saveError.set(null);
    this.partnerForm.reset();
  }

  savePartner() {
    if (this.partnerForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.partnerForm.getRawValue();
    // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT — same rule as
    // project-cost-centers.ts's saveCostCenter(). `closeForm()` used to run
    // unconditionally right after firing the POST, so `partnerForm.reset()` wiped the
    // chosen vendor, role and key contact while the request was still in flight; on a
    // refusal the user got a toast over an empty screen and had to re-pick all three.
    this.api.createProjectPartner({
      projectId: pId,
      company: v.company ?? '',
      role: v.role ?? '',
      contact: v.contact ?? '',
      status: 'Invited',
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.partnersRes.reload();
        this.closeForm();
      },
      error: (e: unknown) => {
        this.saveError.set(
          (e as { error?: { error?: string } })?.error?.error ?? 'Could not invite the partner.',
        );
      },
    });
  }

  // Remove a partner behind a confirm step (parity with the other delete flows).
  removing = signal<Partner | null>(null);

  askRemove(partner: Partner) {
    this.removing.set(partner);
  }

  cancelRemove() {
    this.removing.set(null);
  }

  confirmRemove() {
    const partner = this.removing();
    if (!partner) return;
    this.api.deleteProjectPartner(partner.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.partnersRes.reload();
      this.removing.set(null);
    });
  }
}
