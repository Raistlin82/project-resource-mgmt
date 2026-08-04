import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { ApiService, ChangeRequest, Project, Resource } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-change-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DecimalPipe, MatIconModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Change Control</h2>
            <p class="text-sm text-[var(--cc-muted)] mt-1">Govern scope, budget, and schedule changes through explicit decisions.</p>
          </div>
          <button (click)="openForm()" class="command-button">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> New Change
          </button>
        </div>

        @if (!projectId()) {
          <div class="command-card p-4">
            <label for="changeProjectFilter" class="command-section-label block mb-2">Project Filter</label>
            <select id="changeProjectFilter" [formControl]="projectFilter" class="command-select sm:w-96">
              <option value="">All projects</option>
              @for (project of projects(); track project.id) {
                <option [value]="project.id">{{ project.name }}</option>
              }
            </select>
          </div>
        }

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="command-kpi warning">
            <p class="command-kpi-label">Open</p>
            <p class="command-kpi-value">{{ openCount() }}</p>
          </div>
          <div class="command-kpi">
            <p class="command-kpi-label">Approved Impact</p>
            <p class="command-kpi-value">{{ approvedBudgetImpact() | currency:'EUR':'symbol':'1.0-0' }}</p>
          </div>
          <div class="command-kpi">
            <p class="command-kpi-label">Schedule Impact</p>
            <p class="command-kpi-value">{{ approvedScheduleImpact() | number:'1.0-1' }}d</p>
          </div>
          <div class="command-kpi" [class.danger]="severeCount() > 0">
            <p class="command-kpi-label">High/Critical</p>
            <p class="command-kpi-value">{{ severeCount() }}</p>
          </div>
        </div>

        <div class="command-card overflow-hidden">
          <div class="overflow-x-auto">
            <table class="command-data-table">
              <thead>
                <tr>
                  <th class="px-6 py-4">Change</th>
                  <th class="px-6 py-4">Project</th>
                  <th class="px-6 py-4">Priority</th>
                  <th class="px-6 py-4 text-right">Budget</th>
                  <th class="px-6 py-4 text-right">Schedule</th>
                  <th class="px-6 py-4">Status</th>
                  <th class="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (change of filteredChanges(); track change.id) {
                  <tr class="hover:bg-surface-muted transition-colors">
                    <td class="px-6 py-5 min-w-72">
                      <div class="font-bold text-[var(--cc-ink)]">{{ change.title }}</div>
                      <div class="text-xs text-[var(--cc-muted)] mt-1 line-clamp-2">{{ change.description }}</div>
                      <div class="text-xs text-[var(--cc-muted)] mt-2">Owner: {{ change.owner || 'Unassigned' }}</div>
                    </td>
                    <td class="px-6 py-5 text-[var(--cc-muted)]">{{ projectName(change.projectId) }}</td>
                    <td class="px-6 py-5">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold ring-1"
                            [class.bg-critical-tint]="change.priority === 'Critical'"
                            [class.text-critical-text]="change.priority === 'Critical'"
                            [class.ring-critical]="change.priority === 'Critical'"
                            [class.bg-caution-tint]="change.priority === 'High'"
                            [class.text-caution-text]="change.priority === 'High'"
                            [class.ring-caution]="change.priority === 'High'"
                            [class.bg-accent-tint]="change.priority === 'Medium'"
                            [class.text-accent-text]="change.priority === 'Medium'"
                            [class.ring-accent]="change.priority === 'Medium'"
                            [class.bg-surface-muted]="change.priority === 'Low'"
                            [class.text-ink-secondary]="change.priority === 'Low'"
                            [class.ring-line]="change.priority === 'Low'">
                        {{ change.priority }}
                      </span>
                    </td>
                    <td class="px-6 py-5 text-right font-semibold font-mono tabular-nums text-ink" [class.text-critical-text]="change.impactBudget > 0" [class.text-positive-text]="change.impactBudget < 0">
                      {{ change.impactBudget | currency:'EUR':'symbol':'1.0-0' }}
                    </td>
                    <td class="px-6 py-5 text-right font-semibold font-mono tabular-nums text-ink" [class.text-critical-text]="change.impactScheduleDays > 0" [class.text-positive-text]="change.impactScheduleDays < 0">
                      {{ change.impactScheduleDays | number:'1.0-1' }}d
                    </td>
                    <td class="px-6 py-5">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold ring-1"
                            [class.bg-surface-muted]="change.status === 'Draft'"
                            [class.text-ink-secondary]="change.status === 'Draft'"
                            [class.ring-line]="change.status === 'Draft'"
                            [class.bg-caution-tint]="change.status === 'Submitted'"
                            [class.text-caution-text]="change.status === 'Submitted'"
                            [class.ring-caution]="change.status === 'Submitted'"
                            [class.bg-positive-tint]="change.status === 'Approved' || change.status === 'Implemented'"
                            [class.text-positive-text]="change.status === 'Approved' || change.status === 'Implemented'"
                            [class.ring-positive]="change.status === 'Approved' || change.status === 'Implemented'"
                            [class.bg-critical-tint]="change.status === 'Rejected'"
                            [class.text-critical-text]="change.status === 'Rejected'"
                            [class.ring-critical]="change.status === 'Rejected'">
                        {{ change.status }}
                      </span>
                    </td>
                    <td class="px-6 py-5 text-right">
                      <div class="inline-flex items-center gap-1">
                        @if (change.status === 'Draft') {
                          <button (click)="setStatus(change, 'Submitted')" class="p-2 rounded-lg text-ink-muted hover:text-caution-text hover:bg-caution-tint" [attr.aria-label]="'Submit change request ' + change.title" [attr.title]="'Submit ' + change.title">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">send</mat-icon>
                          </button>
                        }
                        @if (change.status === 'Submitted') {
                          <button (click)="setStatus(change, 'Approved')" class="p-2 rounded-lg text-ink-muted hover:text-positive-text hover:bg-positive-tint" [attr.aria-label]="'Approve change request ' + change.title" [attr.title]="'Approve ' + change.title">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">check_circle</mat-icon>
                          </button>
                          <button (click)="setStatus(change, 'Rejected')" class="p-2 rounded-lg text-ink-muted hover:text-critical-text hover:bg-critical-tint" [attr.aria-label]="'Reject change request ' + change.title" [attr.title]="'Reject ' + change.title">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">cancel</mat-icon>
                          </button>
                        }
                        @if (change.status === 'Approved') {
                          <button (click)="setStatus(change, 'Implemented')" class="p-2 rounded-lg text-ink-muted hover:text-accent-text hover:bg-accent-tint" [attr.aria-label]="'Mark change request ' + change.title + ' implemented'" [attr.title]="'Mark ' + change.title + ' implemented'">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">task_alt</mat-icon>
                          </button>
                        }
                      </div>
                    </td>
                  </tr>
                }
                @if (!filteredChanges().length) {
                  <tr>
                    <td colspan="7" class="px-6 py-12 text-center text-[var(--cc-muted)]">No change requests found.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>

      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="changeRequestModalTitle" (dismiss)="closeForm()">
          <div class="command-card shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h3 id="changeRequestModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">New Change Request</h3>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <div class="p-6 sm:p-8 overflow-y-auto">
              <form [formGroup]="form" class="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div class="sm:col-span-2">
                  <label for="crProject" class="block text-sm font-semibold text-ink-secondary mb-1.5">Project *</label>
                  <select id="crProject" formControlName="projectId" class="command-select">
                    <option value="">Select a project...</option>
                    @for (project of projects(); track project.id) {
                      <option [value]="project.id">{{ project.name }}</option>
                    }
                  </select>
                </div>
                <div class="sm:col-span-2">
                  <label for="crTitle" class="block text-sm font-semibold text-ink-secondary mb-1.5">Title *</label>
                  <input id="crTitle" formControlName="title" class="command-input">
                </div>
                <div class="sm:col-span-2">
                  <label for="crDescription" class="block text-sm font-semibold text-ink-secondary mb-1.5">Description *</label>
                  <textarea id="crDescription" formControlName="description" rows="3" class="command-textarea"></textarea>
                </div>
                <div>
                  <label for="crOwner" class="block text-sm font-semibold text-ink-secondary mb-1.5">Owner *</label>
                  <!-- The CR owner is a PERSON reference: bound to the resources (people)
                       catalog by name. requestedBy/decidedBy stay auth-derived (server-pinned). -->
                  <select id="crOwner" formControlName="owner" class="command-select">
                    <option value="">Select owner...</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanOwner(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>
                <div>
                  <label for="crPriority" class="block text-sm font-semibold text-ink-secondary mb-1.5">Priority *</label>
                  <select id="crPriority" formControlName="priority" class="command-select">
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Critical">Critical</option>
                  </select>
                </div>
                <div>
                  <label for="crBudget" class="block text-sm font-semibold text-ink-secondary mb-1.5">Budget Impact</label>
                  <input id="crBudget" type="number" formControlName="impactBudget" class="command-input">
                </div>
                <div>
                  <label for="crSchedule" class="block text-sm font-semibold text-ink-secondary mb-1.5">Schedule Impact Days</label>
                  <input id="crSchedule" type="number" formControlName="impactScheduleDays" class="command-input">
                </div>
                <div class="sm:col-span-2">
                  <label for="crScope" class="block text-sm font-semibold text-ink-secondary mb-1.5">Scope Impact</label>
                  <input id="crScope" formControlName="impactScope" class="command-input">
                </div>
              </form>
            </div>
            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button (click)="save()" [disabled]="form.invalid" class="command-button disabled:opacity-50">Create</button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class ChangeRequests {
  projectId = input<string>();
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  private changesRes = rxResource({ stream: () => this.api.getChangeRequests(), defaultValue: [] as ChangeRequest[] });
  projects = this.projectsRes.value;
  changes = this.changesRes.value;

  // The CR owner is a PERSON reference bound to the resources (people) catalog by name
  // (Phase D). /resources is a principal-gated read, so key the load on authReady to
  // avoid a 401 race that would latch the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  projectFilter = new FormControl('');
  projectFilterValue = toSignal(this.projectFilter.valueChanges, { initialValue: '' });
  showForm = signal(false);

  private projectsById = computed(() => new Map(this.projects().map(p => [p.id, p.name])));

  filteredChanges = computed(() => {
    const pId = this.projectId() || this.projectFilterValue() || '';
    return this.changes().filter(c => !pId || c.projectId === pId);
  });

  openCount = computed(() => this.filteredChanges().filter(c => c.status === 'Draft' || c.status === 'Submitted').length);
  approvedBudgetImpact = computed(() => this.filteredChanges().filter(c => c.status === 'Approved' || c.status === 'Implemented').reduce((s, c) => s + c.impactBudget, 0));
  approvedScheduleImpact = computed(() => this.filteredChanges().filter(c => c.status === 'Approved' || c.status === 'Implemented').reduce((s, c) => s + c.impactScheduleDays, 0));
  severeCount = computed(() => this.filteredChanges().filter(c => c.priority === 'High' || c.priority === 'Critical').length);

  form = new FormGroup({
    projectId: new FormControl('', { nonNullable: true, validators: Validators.required }),
    title: new FormControl('', { nonNullable: true, validators: Validators.required }),
    description: new FormControl('', { nonNullable: true, validators: Validators.required }),
    owner: new FormControl('', { nonNullable: true, validators: Validators.required }),
    priority: new FormControl<ChangeRequest['priority']>('Medium', { nonNullable: true, validators: Validators.required }),
    impactBudget: new FormControl(0, { nonNullable: true }),
    impactScheduleDays: new FormControl(0, { nonNullable: true }),
    impactScope: new FormControl('', { nonNullable: true }),
  });

  // ORPHAN VALUE: a stored owner that isn't a current resource name is surfaced as a
  // disabled option so editing never silently discards a real value.
  private ownerValue = toSignal(this.form.controls.owner.valueChanges, { initialValue: this.form.controls.owner.value });
  orphanOwner = computed<string | null>(() => {
    const current = this.ownerValue();
    if (!current) return null;
    return this.resourceOptions().some(r => r.name === current) ? null : current;
  });

  projectName(id: string): string {
    return this.projectsById().get(id) ?? id;
  }

  openForm(): void {
    this.form.reset({
      projectId: this.projectId() || this.projectFilter.value || '',
      title: '',
      description: '',
      owner: '',
      priority: 'Medium',
      impactBudget: 0,
      impactScheduleDays: 0,
      impactScope: '',
    });
    this.showForm.set(true);
  }

  closeForm(): void {
    this.showForm.set(false);
  }

  save(): void {
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.api.createChangeRequest({
      ...v,
      requestedBy: this.auth.userId(),
      status: 'Draft',
      createdAt: new Date().toISOString(),
    }).subscribe(() => {
      this.changesRes.reload();
      this.notifications.show('Change request created', 'success');
      this.closeForm();
    });
  }

  setStatus(change: ChangeRequest, status: ChangeRequest['status']): void {
    const decision = status === 'Approved' || status === 'Rejected'
      ? { decidedBy: this.auth.userId(), decidedAt: new Date().toISOString() }
      : {};
    this.api.updateChangeRequest(change.id, { status, ...decision }).subscribe(() => {
      this.changesRes.reload();
      this.notifications.show(`Change request ${status.toLowerCase()}`, 'success');
    });
  }
}
