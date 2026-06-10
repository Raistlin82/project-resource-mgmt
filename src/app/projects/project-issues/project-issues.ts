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
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            @if (!projectId()) {
              <h2 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Issues</h2>
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" class="bg-white focus:bg-white border border-slate-300 text-slate-900 text-sm rounded-lg focus:ring-blue-500/25 focus:border-blue-500 block p-2.5">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            } @else {
              <h2 class="text-lg font-semibold text-slate-900">Issues</h2>
            }
          </div>
          <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 shadow-sm">
            <mat-icon class="text-sm">add</mat-icon> Create Issue
          </button>
        </div>

        @if (!(projectId() || selectedProjectId())) {
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm p-12 text-center">
            <mat-icon class="text-slate-400 mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="text-lg font-medium text-slate-900 mt-4">No Project Selected</h3>
            <p class="text-slate-500 mt-1">Please select a project from the dropdown above to view issues.</p>
          </div>
        } @else {
        <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm overflow-hidden">
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wider">
              <tr>
                <th class="px-6 py-4 font-medium">Issue</th>
                <th class="px-6 py-4 font-medium">Type</th>
                <th class="px-6 py-4 font-medium">Severity</th>
                <th class="px-6 py-4 font-medium">Status</th>
                <th class="px-6 py-4 font-medium">Owner / Due</th>
                <th class="px-6 py-4 font-medium">Action Plan</th>
                <th class="px-6 py-4 font-medium">Reported By</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (issue of filteredIssues(); track issue.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-4 font-medium text-slate-900">{{ issue.title }}</td>
                  <td class="px-6 py-4 text-slate-600">{{ issue.type }}</td>
                  <td class="px-6 py-4">
                    <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1"
                          [class.bg-red-50]="issue.severity === 'High'" [class.text-red-700]="issue.severity === 'High'" [class.ring-red-200]="issue.severity === 'High'"
                          [class.bg-amber-50]="issue.severity === 'Medium'" [class.text-amber-700]="issue.severity === 'Medium'" [class.ring-amber-200]="issue.severity === 'Medium'"
                          [class.bg-emerald-50]="issue.severity === 'Low'" [class.text-emerald-700]="issue.severity === 'Low'" [class.ring-emerald-200]="issue.severity === 'Low'">
                      {{ issue.severity }}
                    </span>
                  </td>
                  <td class="px-6 py-4">
                    <div class="flex items-center gap-2">
                      <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1"
                            [class.bg-blue-50]="issue.status === 'Open'" [class.text-blue-700]="issue.status === 'Open'" [class.ring-blue-200]="issue.status === 'Open'"
                            [class.bg-slate-100]="issue.status === 'Mitigated' || issue.status === 'Closed'" [class.text-slate-700]="issue.status === 'Mitigated' || issue.status === 'Closed'" [class.ring-slate-200]="issue.status === 'Mitigated' || issue.status === 'Closed'">
                        {{ issue.status }}
                      </span>
                      <select [ngModel]="issue.status" (ngModelChange)="updateStatus(issue, $event)" class="bg-white focus:bg-white border border-slate-300 text-slate-900 text-xs rounded-lg focus:ring-blue-500/25 focus:border-blue-500 p-1.5">
                        <option value="Open">Open</option>
                        <option value="Mitigated">Mitigated</option>
                        <option value="Closed">Closed</option>
                      </select>
                    </div>
                  </td>
                  <td class="px-6 py-4 text-slate-600">
                    <div class="font-medium text-slate-900">{{ issue.owner || 'Unassigned' }}</div>
                    <div class="text-xs mt-1" [class.text-red-700]="isOverdue(issue)" [class.text-slate-500]="!isOverdue(issue)">
                      {{ issue.dueDate || 'No due date' }}
                    </div>
                    @if (issue.escalated) {
                      <span class="mt-2 inline-flex items-center px-2 py-0.5 rounded-md bg-red-50 text-red-700 ring-1 ring-red-200 text-[10px] font-bold uppercase tracking-wider">Escalated</span>
                    }
                  </td>
                  <td class="px-6 py-4 text-slate-600 max-w-xs">
                    <div class="line-clamp-2">{{ issue.actionPlan || 'No action plan' }}</div>
                    @if (issue.impact) {
                      <div class="text-xs text-slate-500 mt-1 line-clamp-1">Impact: {{ issue.impact }}</div>
                    }
                  </td>
                  <td class="px-6 py-4 text-slate-600">{{ issue.reportedBy }}</td>
                </tr>
              }
              @if (filteredIssues().length === 0) {
                <tr>
                  <td colspan="7" class="px-6 py-8 text-center text-slate-500">No issues found for this project.</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        }
      </div>

      <!-- Report Issue Modal -->
      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6"
             appModal ariaLabelledby="issueModalTitle" (dismiss)="closeForm()">
          <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh] transform transition-all">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
              <h2 id="issueModalTitle" class="text-2xl font-bold text-slate-900 tracking-tight">Report Issue</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" class="text-slate-400 hover:text-slate-600 hover:bg-slate-100 p-2 rounded-full transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 sm:p-8 overflow-y-auto flex-1">
              <form [formGroup]="issueForm" (ngSubmit)="saveIssue()" class="space-y-6">
                <div>
                  <label for="issueTitle" class="block text-sm font-semibold text-slate-700 mb-1.5">Title *</label>
                  <input id="issueTitle" type="text" formControlName="title" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. API Rate Limiting">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="issueType" class="block text-sm font-semibold text-slate-700 mb-1.5">Type *</label>
                    <select id="issueType" formControlName="type" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                      <option value="Bug">Bug</option>
                      <option value="Risk">Risk</option>
                      <option value="Task">Task</option>
                    </select>
                  </div>

                  <div>
                    <label for="issueSeverity" class="block text-sm font-semibold text-slate-700 mb-1.5">Severity *</label>
                    <select id="issueSeverity" formControlName="severity" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 bg-white focus:bg-white">
                      <option value="Low">Low</option>
                      <option value="Medium">Medium</option>
                      <option value="High">High</option>
                      <option value="Critical">Critical</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label for="issueReportedBy" class="block text-sm font-semibold text-slate-700 mb-1.5">Reported By</label>
                  <input id="issueReportedBy" type="text" formControlName="reportedBy" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. Jane Doe">
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label for="issueOwner" class="block text-sm font-semibold text-slate-700 mb-1.5">Owner</label>
                    <input id="issueOwner" type="text" formControlName="owner" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="e.g. Delivery Lead">
                  </div>
                  <div>
                    <label for="issueDueDate" class="block text-sm font-semibold text-slate-700 mb-1.5">Due Date</label>
                    <input id="issueDueDate" type="date" formControlName="dueDate" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white">
                  </div>
                </div>

                <div>
                  <label for="issueImpact" class="block text-sm font-semibold text-slate-700 mb-1.5">Impact</label>
                  <input id="issueImpact" type="text" formControlName="impact" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white" placeholder="Budget, schedule, quality, or client impact">
                </div>

                <div>
                  <label for="issueActionPlan" class="block text-sm font-semibold text-slate-700 mb-1.5">Action Plan</label>
                  <textarea id="issueActionPlan" formControlName="actionPlan" rows="3" class="w-full px-4 py-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none transition-all text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:bg-white resize-none"></textarea>
                </div>

                <label class="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                  <input type="checkbox" formControlName="escalated" class="rounded border-slate-300 text-blue-600 focus:ring-blue-500/25">
                  Escalated
                </label>
              </form>
            </div>

            <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
              <button type="button" (click)="closeForm()" class="px-5 py-2.5 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-all">Cancel</button>
              <button type="button" (click)="saveIssue()" [disabled]="!issueForm.valid" class="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none">
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
