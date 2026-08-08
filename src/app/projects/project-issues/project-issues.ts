import { ChangeDetectionStrategy, Component, input, signal, computed, inject, DestroyRef } from '@angular/core';
import { rxResource, toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule, ReactiveFormsModule, FormControl, FormGroup, Validators } from '@angular/forms';
import { ApiService, Project, Issue, Resource } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { todayLocalIso } from '../../services/local-date.util';
import { authGatedResource } from '../../services/auth-gated-resource.util';

@Component({
  selector: 'app-project-issues',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ReactiveFormsModule, ModalDialogDirective],
  template: `
    <div [class]="projectId() ? '' : 'command-page space-y-6'">
      <div class="space-y-6">
        <div data-test="issues-header" class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            @if (headingLevel() === 1) {
              <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Issues</h1>
            } @else {
              <h2 class="font-display text-lg font-bold text-[var(--cc-ink)]">Issues</h2>
            }
            @if (!projectId()) {
              <select [ngModel]="selectedProjectId()" (ngModelChange)="selectedProjectId.set($event)" aria-label="Select project" class="block w-full min-w-0 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] p-2.5 text-sm font-semibold text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)] sm:w-auto">
                <option value="" disabled>Select a project...</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            }
          </div>
          <!-- P2-18: a control whose only possible outcome without a project is a
               toast is disabled instead, with the reason stated beside it so it is
               readable BEFORE the click and reaches a screen reader through
               aria-describedby. The hint is the accessible description, so it is
               referenced only while the control is actually disabled. -->
          <div class="flex w-full flex-col items-start gap-1 sm:w-auto">
            <button (click)="openForm()" [disabled]="!activeProjectId()"
                    [attr.aria-describedby]="activeProjectId() ? null : 'createIssueHint'"
                    data-test="create-issue"
                    class="command-button w-full disabled:opacity-50 disabled:cursor-not-allowed sm:w-auto">
              <mat-icon class="text-sm">add</mat-icon> Create Issue
            </button>
            @if (!activeProjectId()) {
              <p id="createIssueHint" class="text-xs text-[var(--cc-muted)]" data-test="create-issue-hint">Select a project first.</p>
            }
          </div>
        </div>

        @if (!activeProjectId()) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-ink-muted mb-2" style="font-size: 48px; width: 48px; height: 48px;">folder_open</mat-icon>
            <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] mt-4">No Project Selected</h3>
            <p class="text-[var(--cc-muted)] mt-1">Please select a project from the dropdown above to view issues.</p>
          </div>
        } @else {
        <div class="command-card overflow-hidden">
          <p id="issuesTableHint" class="border-b border-[var(--cc-line)] bg-surface-muted px-4 py-2 text-xs font-semibold text-[var(--cc-muted)] lg:hidden">
            Swipe horizontally to view every issue field. Issue stays visible.
          </p>
          <div data-test="issues-table-scroll" class="overflow-x-auto overscroll-x-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" role="region"
               aria-label="Project issues table" aria-describedby="issuesTableHint" tabindex="0">
          <table class="command-data-table min-w-[72rem]">
            <thead>
              <tr>
                <th class="sticky left-0 z-10 w-48 max-w-48 bg-surface-muted!">Issue</th>
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
                <tr data-test="issue-row">
                  <td class="sticky left-0 z-[1] w-48 max-w-48 break-words bg-surface! font-medium" data-test="issue-title">{{ issue.title }}</td>
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
                      <span data-test="issue-status-chip" class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ring-1"
                            [class.bg-accent-tint]="issue.status === 'Open'" [class.text-accent-text]="issue.status === 'Open'" [class.ring-accent]="issue.status === 'Open'"
                            [class.bg-surface-muted]="issue.status === 'Mitigated' || issue.status === 'Closed'" [class.text-ink-secondary]="issue.status === 'Mitigated' || issue.status === 'Closed'" [class.ring-line]="issue.status === 'Mitigated' || issue.status === 'Closed'">
                        {{ issue.status }}
                      </span>
                      <select #statusSelect data-test="issue-status" [ngModel]="issue.status" (ngModelChange)="updateStatus(issue, $event, statusSelect)" [attr.aria-label]="'Update status for issue ' + issue.title" class="min-h-11 rounded-md border border-[var(--cc-line)] bg-[var(--cc-panel)] px-2 py-1.5 text-xs text-[var(--cc-ink)] outline-none focus:border-[var(--cc-primary)]">
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
        <div data-test="issue-form-overlay" class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim/40 p-4 backdrop-blur-sm sm:items-center sm:p-6"
             appModal ariaLabelledby="issueModalTitle" (dismiss)="closeForm()">
          <div data-test="issue-form-panel" class="command-card flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden">
            <div class="command-card-header">
              <h2 id="issueModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Report Issue</h2>
              <button type="button" (click)="closeForm()" aria-label="Close dialog" title="Close" data-test="issue-form-close" class="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-[var(--cc-muted)] transition-colors hover:bg-surface-muted hover:text-[var(--cc-ink)]">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div data-test="issue-form-body" class="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
              <form [formGroup]="issueForm" (ngSubmit)="saveIssue()" class="space-y-6">
                <!-- Rendered INLINE rather than left to the interceptor's toast, because
                     error toasts in this app auto-dismiss: a dialog that stays open with a
                     vanished toast is an unexplained refusal. Same shape as
                     project-cost-centers.ts's saveError. -->
                @if (saveError(); as err) {
                  <p role="alert" data-test="issue-save-error" class="text-xs text-critical-text">{{ err }}</p>
                }
                <div>
                  <label for="issueTitle" class="block text-sm font-semibold text-ink-secondary mb-1.5">Title *</label>
                  <input id="issueTitle" type="text" formControlName="title" class="command-input" placeholder="e.g. API Rate Limiting">
                </div>

                <div data-test="issue-type-grid" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  <!-- A person reference: bound to the resources (people) catalog by name. -->
                  <select id="issueReportedBy" formControlName="reportedBy" class="command-select">
                    <option value="">Unassigned</option>
                    @for (r of resourceOptions(); track r.id) {
                      <option [value]="r.name">{{ r.name }}</option>
                    }
                    @if (orphanReportedBy(); as orphan) {
                      <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                    }
                  </select>
                </div>

                <div data-test="issue-owner-grid" class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label for="issueOwner" class="block text-sm font-semibold text-ink-secondary mb-1.5">Owner</label>
                    <!-- A person reference: bound to the resources (people) catalog by name. -->
                    <select id="issueOwner" formControlName="owner" class="command-select">
                      <option value="">Unassigned</option>
                      @for (r of resourceOptions(); track r.id) {
                        <option [value]="r.name">{{ r.name }}</option>
                      }
                      @if (orphanOwner(); as orphan) {
                        <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                      }
                    </select>
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

            <div data-test="issue-form-actions" class="flex flex-wrap justify-end gap-3 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] px-6 py-5 sm:px-8">
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
  /**
   * Which element carries this panel's own title: `<h1>` when it stands alone on
   * its route, `<h2>` when project-details embeds it as a tab panel beneath the
   * project-name `<h1>`.
   *
   * ONE mechanism, applied identically by all eight embeddable project panels;
   * the `[headingLevel]="2"` bindings and the full rationale live in
   * project-details.ts. Adding a plain `<h1>` here instead would have put TWO h1
   * elements on /projects/:id — trading the missing-h1 defect for a duplicate-h1
   * one. Typed `1 | 2` so no caller can ask for the `<h3>` that would skip a
   * level under the page `<h1>`. The size classes are unchanged in both
   * branches: the heading LEVEL is what moves, never the type scale.
   */
  headingLevel = input<1 | 2>(1);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private destroyRef = inject(DestroyRef);

  private projectsRes = authGatedResource(() => this.api.getProjects(), [] as Project[]);
  projects = computed(() => this.projectsRes.value());
  selectedProjectId = signal<string>('');

  /**
   * The project in scope: the routed one when this panel is embedded in
   * project-details, else the one picked in the standalone page's selector.
   * Empty means none, which is what disables the create control (P2-18).
   *
   * Declared right after its own dependency, and the SINGLE source of truth for
   * the question — the inline `projectId() || selectedProjectId()` it replaces
   * appeared in the template, in the filtered list and in every save handler,
   * so the disabled state and the empty state could drift apart.
   */
  activeProjectId = computed(() => this.projectId() || this.selectedProjectId());
  showForm = signal(false);

  // reportedBy/owner are PERSON references bound to the resources (people) catalog by
  // name (Phase D). /resources is a principal-gated read, so key the load on authReady
  // to avoid a 401 race that would latch the option list empty.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resourceOptions = this.resourcesRes.value;

  issueForm = new FormGroup({
    title: new FormControl('', Validators.required),
    type: new FormControl('Bug', Validators.required),
    severity: new FormControl('Medium', Validators.required),
    reportedBy: new FormControl(''),
    owner: new FormControl(''),
    dueDate: new FormControl(''),
    impact: new FormControl(''),
    actionPlan: new FormControl(''),
    escalated: new FormControl(false)
  });

  // ORPHAN VALUES: a stored reportedBy/owner that isn't a current resource name is
  // surfaced as a disabled option so editing never silently discards a real value.
  private reportedByValue = toSignal(this.issueForm.controls.reportedBy.valueChanges, { initialValue: this.issueForm.controls.reportedBy.value });
  private ownerValue = toSignal(this.issueForm.controls.owner.valueChanges, { initialValue: this.issueForm.controls.owner.value });
  orphanReportedBy = computed<string | null>(() => this.orphanFor(this.reportedByValue()));
  orphanOwner = computed<string | null>(() => this.orphanFor(this.ownerValue()));
  private orphanFor(value: string | null | undefined): string | null {
    if (!value) return null;
    return this.resourceOptions().some(r => r.name === value) ? null : value;
  }

  private issuesRes = authGatedResource(() => this.api.getProjectIssues(), [] as Issue[]);
  issues = this.issuesRes.value;

  filteredIssues = computed(() => {
    const pId = this.activeProjectId();
    if (!pId) return [];
    return this.issues().filter(i => i.projectId === pId);
  });

  openForm() {
    this.showForm.set(true);
  }

  /**
   * @param control The row's own <select>. The binding is one-way (`[ngModel]`),
   *   so when the server refuses the PUT the model never moves and Angular has
   *   nothing to re-render: the control keeps displaying the status the server
   *   rejected, for the rest of the session, while the chip beside it and the
   *   list behind it still hold the old value. Snap the element back by hand.
   *   Same shape as project-tasks.ts's updateStatus().
   */
  updateStatus(issue: Issue, status: string, control: HTMLSelectElement) {
    this.api.updateProjectIssue(issue.id, { status })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.issuesRes.reload(),
        // Revert to the value the SERVER still holds. errorInterceptor already
        // raised the toast, so this only repairs the control — and it reverts on
        // failure only, never unconditionally, or an accepted change would be
        // undone on screen.
        error: () => { control.value = issue.status; },
      });
  }

  /** Server refusal text for the open dialog, or null. See the template comment. */
  saveError = signal<string | null>(null);

  closeForm() {
    this.showForm.set(false);
    this.saveError.set(null);
    this.issueForm.reset({ type: 'Bug', severity: 'Medium', reportedBy: '', owner: '', escalated: false });
  }

  saveIssue() {
    if (this.issueForm.invalid) return;
    const pId = this.activeProjectId();
    if (!pId) return;

    this.saveError.set(null);
    const v = this.issueForm.getRawValue();
    this.api.createProjectIssue({
      projectId: pId,
      title: v.title ?? '',
      type: v.type ?? 'Bug',
      severity: v.severity ?? 'Medium',
      status: 'Open',
      reportedBy: v.reportedBy ?? '',
      owner: v.owner ?? '',
      dueDate: v.dueDate ?? '',
      impact: v.impact ?? '',
      actionPlan: v.actionPlan ?? '',
      escalated: Boolean(v.escalated),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      // CLOSE ONLY ONCE THE SERVER HAS ACCEPTED IT — same rule as
      // project-cost-centers.ts's saveCostCenter(). `closeForm()` used to run
      // unconditionally right after firing the POST, so `issueForm.reset()` wiped the
      // title, impact and the whole action plan while the request was still in
      // flight; on a refusal the reporter got a toast over an empty screen and had to
      // retype a long free-text field from memory.
      .subscribe({
        next: () => {
          this.issuesRes.reload();
          this.closeForm();
        },
        error: (e: unknown) => {
          this.saveError.set(
            (e as { error?: { error?: string } })?.error?.error ?? 'Could not report the issue.',
          );
        },
      });
  }

  isOverdue(issue: Issue): boolean {
    return Boolean(issue.dueDate && issue.status !== 'Closed' && issue.dueDate < todayLocalIso());
  }
}
