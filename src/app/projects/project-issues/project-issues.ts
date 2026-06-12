import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, Issue } from '../../services/api.service';
import { NotificationService } from '../../services/notification.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';

@Component({
  selector: 'app-project-issues',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Issues</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="block rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Issues</h2>
            }
          </div>
          <button (click)="openForm()" class="command-button">
            <mat-icon class="text-sm">add</mat-icon> Create Issue
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view issues.</p>
          </div>
        } @else {
        <div class="command-card overflow-hidden">
          <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th>Issue</th>
                <th>Type</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Owner / Due</th>
                <th>Action Plan</th>
                <th>Reported By</th>
              </tr>
            </thead>
            <tbody>
              @for (issue of filteredIssues(); track issue.id) {
                <tr>
                  <td class="font-medium">{{ issue.title }}</td>
                  <td class="text-[var(--cc-muted)]">{{ issue.type }}</td>
                  <td>
                    <span class="command-status"
                          [class.red]="issue.severity === 'High'"
                          [class.amber]="issue.severity === 'Medium'"
                          [class.green]="issue.severity === 'Low'">
                      {{ issue.severity }}
                    </span>
                  </td>
                  <td>
                    <div class="flex items-center gap-2">
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1"
                            [class.bg-accent-tint]="issue.status === 'Open'" [class.text-accent-text]="issue.status === 'Open'" [class.ring-accent]="issue.status === 'Open'"
                            [class.bg-surface-muted]="issue.status === 'Mitigated' || issue.status === 'Closed'" [class.text-ink-secondary]="issue.status === 'Mitigated' || issue.status === 'Closed'" [class.ring-line]="issue.status === 'Mitigated' || issue.status === 'Closed'">
                        {{ issue.status }}
                      </span>
                      <select [ngModel]="issue.status" (ngModelChange)="updateStatus(issue, $event)" class="rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-1.5 text-xs text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
                        <option value="Open">Open</option>
                        <option value="Mitigated">Mitigated</option>
                        <option value="Closed">Closed</option>
                      </select>
                    </div>
                  </td>
                  <td>
                    <div class="font-medium">{{ issue.owner || 'Unassigned' }}</div>
                    <div class="text-xs mt-1" [class.text-critical-text]="isOverdue(issue)" [class.text-ink-muted]="!isOverdue(issue)">
                      {{ issue.dueDate || 'No due date' }}
                    </div>
                    @if (issue.escalated) {
                      <span class="mt-2 command-status red uppercase">Escalated</span>
                    }
                  </td>
                  <td class="text-[var(--cc-muted)] max-w-xs">
                    <div class="line-clamp-2">{{ issue.actionPlan || 'No action plan' }}</div>
                    @if (issue.impact) {
                      <div class="text-xs text-[var(--cc-muted)] mt-1 line-clamp-1">Impact: {{ issue.impact }}</div>
                    }
                  </td>
                  <td class="text-[var(--cc-muted)]">{{ issue.reportedBy }}</td>
                </tr>
              }
              @if (filteredIssues().length === 0) {
                <tr>
                  <td colspan="7" class="text-center text-[var(--cc-muted)]">No issues found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
          </div>
        </div>
        }
      </div>

      <!-- Report Issue Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="issueModalTitle" (dismiss)="closeForm()">
          <div class="command-card w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="issueModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Report Issue</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-[var(--cc-muted)] hover:text-[var(--cc-ink)] hover:bg-surface-muted p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="issueForm" (ngSubmit)="saveIssue()" class="space-y-6">
                <div>
                  <label for="issueTitle" class="block text-sm font-semibold text-ink-secondary mb-1.5">Title *</label>
                  <input id="issueTitle" type="text" formControlName="title" class="command-input" placeholder="e.g. API Rate Limiting">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="issueType" class="block text-sm font-semibold text-ink-secondary mb-1.5">Type *</label>
                    <select id="issueType" formControlName="type" class="command-select">
                      <option value="Bug">Bug</option>
                      <option value="Risk">Risk</option>
                      <option value="Task">Task</option>
                    </select>
                  </div>

                  <div>
                    <label for="issueSeverity" class="block text-sm font-semibold text-ink-secondary mb-1.5">Severity *</label>
                    <select id="issueSeverity" formControlName="severity" class="command-select">
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                      <option value="Critical">Critical</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label for="issueReportedBy" class="block text-sm font-semibold text-ink-secondary mb-1.5">Reported By</label>
                  <input id="issueReportedBy" type="text" formControlName="reportedBy" class="command-input" placeholder="e.g. Jane Doe">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="issueOwner" class="block text-sm font-semibold text-ink-secondary mb-1.5">Owner</label>
                    <input id="issueOwner" type="text" formControlName="owner" class="command-input" placeholder="e.g. Delivery Lead">
                  </div>
                  <div>
                    <label for="issueDueDate" class="block text-sm font-semibold text-ink-secondary mb-1.5">Due Date</label>
                    <input id="issueDueDate" type="date" formControlName="dueDate" class="command-input">
                  </div>
                </div>

                <div>
                  <label for="issueImpact" class="block text-sm font-semibold text-ink-secondary mb-1.5">Impact</label>
                  <input id="issueImpact" type="text" formControlName="impact" class="command-input" placeholder="Budget, schedule, quality, or client impact">
                </div>

                <div>
                  <label for="issueActionPlan" class="block text-sm font-semibold text-ink-secondary mb-1.5">Action Plan</label>
                  <textarea id="issueActionPlan" formControlName="actionPlan" rows="3" class="command-textarea"></textarea>
                </div>

                <label class="inline-flex items-center gap-2 text-sm font-semibold text-ink-secondary">
                  <input type="checkbox" formControlName="escalated" class="command-checkbox">
                  Escalated
                </label>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="saveIssue()" [disabled]="!issueForm.valid" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                Report Issue
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `
})
export class ProjectIssues {
  projectId = input<string>();
  private api = inject(ApiService);
  private notificationService = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = rxResource({ stream: () => this.api.getProjects(), defaultValue: [] as Project[] });
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');
  showForm = signal(false);
  
  issueForm = new FormGroup({
    title: new FormControl('', Validators.required),
    type: new FormControl('Bug', Validators.required),
    severity: new FormControl('Medium', Validators.required),
    reportedBy: new FormControl('Current User'),
    owner: new FormControl(''),
    dueDate: new FormControl(''),
    impact: new FormControl(''),
    actionPlan: new FormControl(''),
    escalated: new FormControl(false)
  });
  
  private issuesRes = rxResource({ stream: () => this.api.getProjectIssues(), defaultValue: [] as Issue[] });
  issues = this.issuesRes.value;

  filteredIssues = computed(() => {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return [];
    return this.issues().filter(i => i.projectId === pId);
  });

  openForm() {
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) {
      this.notificationService.show('Please select a project first', 'info');
      return;
    }
    this.showForm.set(true);
  }

  updateStatus(issue: Issue, status: string) {
    this.api.updateProjectIssue(issue.id, { status })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.issuesRes.reload());
  }

  closeForm() {
    this.showForm.set(false);
    this.issueForm.reset({ type: 'Bug', severity: 'Medium', reportedBy: 'Current User', escalated: false });
  }

  saveIssue() {
    if (this.issueForm.invalid) return;
    const pId = this.projectId() || this.selectedProjectId();
    if (!pId) return;

    const v = this.issueForm.getRawValue();
    this.api.createProjectIssue({
      projectId: pId,
      title: v.title ?? '',
      type: v.type ?? 'Bug',
      severity: v.severity ?? 'Medium',
      status: 'Open',
      reportedBy: v.reportedBy ?? 'Current User',
      owner: v.owner ?? '',
      dueDate: v.dueDate ?? '',
      impact: v.impact ?? '',
      actionPlan: v.actionPlan ?? '',
      escalated: Boolean(v.escalated),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.issuesRes.reload());

    this.closeForm();
  }

  isOverdue(issue: Issue): boolean {
    return Boolean(issue.dueDate && issue.status !== 'Closed' && issue.dueDate < new Date().toISOString().slice(0, 10));
  }
}
