import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, Partner } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-project-partners',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Project Partners</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500/25 focus:border-blue-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Project Partners</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors flex items-center gap-2 shadow-sm">
            <mat-icon class="text-sm">person_add</mat-icon> Invite Partner
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view partners.</p>
          </div>
        } @else {
        <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm overflow-hidden">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wider">
              <tr>
                <th class="px-6 py-4 font-medium">Company</th>
                <th class="px-6 py-4 font-medium">Role</th>
                <th class="px-6 py-4 font-medium">Key Contact</th>
                <th class="px-6 py-4 font-medium">Status</th>
                <th class="px-6 py-4 font-medium"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (partner of filteredPartners(); track partner.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-slate-900">{{ partner.company }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ partner.role }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ partner.contact }}</td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1"
                          [class.bg-emerald-50]="partner.status === 'Active'" [class.text-emerald-700]="partner.status === 'Active'" [class.ring-emerald-200]="partner.status === 'Active'"
                          [class.bg-blue-50]="partner.status === 'Invited'" [class.text-blue-700]="partner.status === 'Invited'" [class.ring-blue-200]="partner.status === 'Invited'">
                      {{ partner.status }}
                    </span>
                  </td>
                  <td class="px-6 py-4 text-right">
                    <button type="button" (click)="removePartner(partner)" [attr.aria-label]="'Remove ' + partner.company" [attr.title]="'Remove ' + partner.company" class="text-slate-400 hover:text-blue-700 transition-colors">
                      <mat-icon class="text-sm">more_vert</mat-icon>
                    </button>
                  </td>
                </tr>
              }
              @if (filteredPartners().length === 0) {
                <tr>
                  <td colspan="5" class="px-6 py-8 text-center text-slate-500">No partners found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      </div>

      <!-- Invite Partner Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="partnerModalTitle" (dismiss)="closeForm()">
          <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
              <h2 id="partnerModalTitle" class="text-2xl font-bold text-slate-900 tracking-tight">Invite Partner</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-slate-400 hover:text-slate-700 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="partnerForm" (ngSubmit)="savePartner()" class="space-y-6">
                <div>
                  <label for="partnerCompany" class="block text-sm font-semibold text-slate-700 mb-1.5">Company Name *</label>
                  <input id="partnerCompany" type="text" formControlName="company" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white placeholder:text-slate-400" placeholder="e.g. TechCorp Inc.">
                </div>

                <div>
                  <label for="partnerRole" class="block text-sm font-semibold text-slate-700 mb-1.5">Role *</label>
                  <input id="partnerRole" type="text" formControlName="role" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white placeholder:text-slate-400" placeholder="e.g. Development Partner">
                </div>

                <div>
                  <label for="partnerContact" class="block text-sm font-semibold text-slate-700 mb-1.5">Key Contact</label>
                  <input id="partnerContact" type="text" formControlName="contact" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white placeholder:text-slate-400" placeholder="e.g. Jane Doe">
                </div>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="savePartner()" [disabled]="!partnerForm.valid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
                Invite Partner
              </button>
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

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  partnerForm = new FormGroup({
    company: new FormControl('', Validators.required),
    role: new FormControl('', Validators.required),
    contact: new FormControl('')
  });
  
  private partnersRes = rxResource({ stream: () => this.api.getProjectPartners(), defaultValue: [] as Partner[] });
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

  closeForm() {
    this.showForm.set(false);
    this.partnerForm.reset();
  }

  savePartner() {
    if (this.partnerForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.partnerForm.getRawValue();
    this.api.createProjectPartner({
      projectId: pId,
      company: v.company ?? '',
      role: v.role ?? '',
      contact: v.contact ?? '',
      status: 'Invited',
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.partnersRes.reload());

    this.closeForm();
  }

  removePartner(partner: Partner) {
    this.api.deleteProjectPartner(partner.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.partnersRes.reload());
  }
}
