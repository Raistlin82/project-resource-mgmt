import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { ApiService, ChangeRequest, Project } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

@Component({
  selector: 'app-change-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, MatIconModule, ReactiveFormsModule],
  template: `
    <div [class]="projectId() ? '' : 'max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8'">
      <div class="space-y-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 class="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Change Control</h2>
            <p class="text-sm text-slate-500 mt-1">Govern scope, budget, and schedule changes through explicit decisions.</p>
          </div>
          <button (click)="openForm()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold shadow-sm px-4 py-2 rounded-xl text-sm transition-colors flex items-center gap-2">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> New Change
          </button>
        </div>

        @if (!projectId()) {
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm p-4">
            <label for="changeProjectFilter" class="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Project Filter</label>
            <select id="changeProjectFilter" [formControl]="projectFilter" class="w-full sm:w-96 px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900">
              <option value="">All projects</option>
              @for (project of projects(); track project.id) {
                <option [value]="project.id">{{ project.name }}</option>
              }
            </select>
          </div>
        }

        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm hover:shadow-md transition-shadow p-5">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider">Open</p>
            <p class="text-3xl font-bold font-mono tabular-nums text-slate-900 mt-1">{{ openCount() }}</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm hover:shadow-md transition-shadow p-5">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider">Approved Impact</p>
            <p class="text-3xl font-bold font-mono tabular-nums text-slate-900 mt-1">{{ approvedBudgetImpact() | currency:'EUR':'symbol':'1.0-0' }}</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm hover:shadow-md transition-shadow p-5">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider">Schedule Impact</p>
            <p class="text-3xl font-bold font-mono tabular-nums text-slate-900 mt-1">{{ approvedScheduleImpact() }}d</p>
          </div>
          <div class="bg-white rounded-2xl border border-slate-200 ring-1 ring-slate-900/5 shadow-sm hover:shadow-md transition-shadow p-5">
            <p class="text-xs font-bold text-slate-500 uppercase tracking-wider">High/Critical</p>
            <p class="text-3xl font-bold font-mono tabular-nums text-slate-900 mt-1">{{ severeCount() }}</p>
          </div>
        </div>

        <div class="bg-white rounded-3xl shadow-sm border border-slate-200 ring-1 ring-slate-900/5 overflow-hidden">
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-slate-50 text-left text-xs font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th class="px-6 py-4">Change</th>
                  <th class="px-6 py-4">Project</th>
                  <th class="px-6 py-4">Priority</th>
                  <th class="px-6 py-4">Budget</th>
                  <th class="px-6 py-4">Schedule</th>
                  <th class="px-6 py-4">Status</th>
                  <th class="px-6 py-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                @for (change of filteredChanges(); track change.id) {
                  <tr class="hover:bg-slate-50 transition-colors">
                    <td class="px-6 py-5 min-w-72">
                      <div class="font-bold text-slate-900">{{ change.title }}</div>
                      <div class="text-xs text-slate-500 mt-1 line-clamp-2">{{ change.description }}</div>
                      <div class="text-xs text-slate-500 mt-2">Owner: {{ change.owner || 'Unassigned' }}</div>
                    </td>
                    <td class="px-6 py-5 text-slate-600">{{ projectName(change.projectId) }}</td>
                    <td class="px-6 py-5">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold ring-1"
                            [class.bg-red-50]="change.priority === 'Critical'"
                            [class.text-red-700]="change.priority === 'Critical'"
                            [class.ring-red-200]="change.priority === 'Critical'"
                            [class.bg-amber-50]="change.priority === 'High'"
                            [class.text-amber-700]="change.priority === 'High'"
                            [class.ring-amber-200]="change.priority === 'High'"
                            [class.bg-blue-50]="change.priority === 'Medium'"
                            [class.text-blue-700]="change.priority === 'Medium'"
                            [class.ring-blue-200]="change.priority === 'Medium'"
                            [class.bg-slate-100]="change.priority === 'Low'"
                            [class.text-slate-700]="change.priority === 'Low'"
                            [class.ring-slate-200]="change.priority === 'Low'">
                        {{ change.priority }}
                      </span>
                    </td>
                    <td class="px-6 py-5 font-semibold font-mono tabular-nums text-slate-900" [class.text-red-600]="change.impactBudget > 0" [class.text-emerald-600]="change.impactBudget < 0">
                      {{ change.impactBudget | currency:'EUR':'symbol':'1.0-0' }}
                    </td>
                    <td class="px-6 py-5 font-semibold font-mono tabular-nums text-slate-900" [class.text-red-600]="change.impactScheduleDays > 0" [class.text-emerald-600]="change.impactScheduleDays < 0">
                      {{ change.impactScheduleDays }}d
                    </td>
                    <td class="px-6 py-5">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold ring-1"
                            [class.bg-slate-100]="change.status === 'Draft'"
                            [class.text-slate-700]="change.status === 'Draft'"
                            [class.ring-slate-200]="change.status === 'Draft'"
                            [class.bg-amber-50]="change.status === 'Submitted'"
                            [class.text-amber-700]="change.status === 'Submitted'"
                            [class.ring-amber-200]="change.status === 'Submitted'"
                            [class.bg-emerald-50]="change.status === 'Approved' || change.status === 'Implemented'"
                            [class.text-emerald-700]="change.status === 'Approved' || change.status === 'Implemented'"
                            [class.ring-emerald-200]="change.status === 'Approved' || change.status === 'Implemented'"
                            [class.bg-red-50]="change.status === 'Rejected'"
                            [class.text-red-700]="change.status === 'Rejected'"
                            [class.ring-red-200]="change.status === 'Rejected'">
                        {{ change.status }}
                      </span>
                    </td>
                    <td class="px-6 py-5 text-right">
                      <div class="inline-flex items-center gap-1">
                        @if (change.status === 'Draft') {
                          <button (click)="setStatus(change, 'Submitted')" class="p-2 rounded-lg text-slate-400 hover:text-amber-700 hover:bg-amber-50" title="Submit">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">send</mat-icon>
                          </button>
                        }
                        @if (change.status === 'Submitted') {
                          <button (click)="setStatus(change, 'Approved')" class="p-2 rounded-lg text-slate-400 hover:text-emerald-700 hover:bg-emerald-50" title="Approve">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">check_circle</mat-icon>
                          </button>
                          <button (click)="setStatus(change, 'Rejected')" class="p-2 rounded-lg text-slate-400 hover:text-red-700 hover:bg-red-50" title="Reject">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">cancel</mat-icon>
                          </button>
                        }
                        @if (change.status === 'Approved') {
                          <button (click)="setStatus(change, 'Implemented')" class="p-2 rounded-lg text-slate-400 hover:text-blue-700 hover:bg-blue-50" title="Mark implemented">
                            <mat-icon class="text-[20px] w-[20px] h-[20px]">task_alt</mat-icon>
                          </button>
                        }
                      </div>
                    </td>
                  </tr>
                }
                @if (!filteredChanges().length) {
                  <tr>
                    <td colspan="7" class="px-6 py-12 text-center text-slate-500">No change requests found.</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>

      @if (showForm()) {
        <div class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4 sm:p-6">
          <div class="bg-white border border-slate-200 rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div class="px-6 sm:px-8 py-6 border-b border-slate-200 flex items-center justify-between bg-gradient-to-br from-slate-50 to-transparent">
              <h3 class="text-2xl font-bold text-slate-900">New Change Request</h3>
              <button (click)="closeForm()" class="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100">
                <mat-icon>close</mat-icon>
              </button>
            </div>
            <div class="p-6 sm:p-8 overflow-y-auto">
              <form [formGroup]="form" class="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div class="sm:col-span-2">
                  <label for="crProject" class="block text-sm font-semibold text-slate-700 mb-1.5">Project *</label>
                  <select id="crProject" formControlName="projectId" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400">
                    <option value="">Select a project...</option>
                    @for (project of projects(); track project.id) {
                      <option [value]="project.id">{{ project.name }}</option>
                    }
                  </select>
                </div>
                <div class="sm:col-span-2">
                  <label for="crTitle" class="block text-sm font-semibold text-slate-700 mb-1.5">Title *</label>
                  <input id="crTitle" formControlName="title" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400">
                </div>
                <div class="sm:col-span-2">
                  <label for="crDescription" class="block text-sm font-semibold text-slate-700 mb-1.5">Description *</label>
                  <textarea id="crDescription" formControlName="description" rows="3" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400"></textarea>
                </div>
                <div>
                  <label for="crOwner" class="block text-sm font-semibold text-slate-700 mb-1.5">Owner *</label>
                  <input id="crOwner" formControlName="owner" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400">
                </div>
                <div>
                  <label for="crPriority" class="block text-sm font-semibold text-slate-700 mb-1.5">Priority *</label>
                  <select id="crPriority" formControlName="priority" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400">
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Critical">Critical</option>
                  </select>
                </div>
                <div>
                  <label for="crBudget" class="block text-sm font-semibold text-slate-700 mb-1.5">Budget Impact</label>
                  <input id="crBudget" type="number" formControlName="impactBudget" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400">
                </div>
                <div>
                  <label for="crSchedule" class="block text-sm font-semibold text-slate-700 mb-1.5">Schedule Impact Days</label>
                  <input id="crSchedule" type="number" formControlName="impactScheduleDays" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400">
                </div>
                <div class="sm:col-span-2">
                  <label for="crScope" class="block text-sm font-semibold text-slate-700 mb-1.5">Scope Impact</label>
                  <input id="crScope" formControlName="impactScope" class="w-full px-4 py-3 border border-slate-300 rounded-xl bg-white focus:bg-white focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 outline-none text-sm text-slate-900 placeholder:text-slate-400">
                </div>
              </form>
            </div>
            <div class="px-6 sm:px-8 py-5 border-t border-slate-200 bg-slate-50 flex justify-end gap-3">
              <button (click)="closeForm()" class="px-5 py-2.5 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
              <button (click)="save()" [disabled]="form.invalid" class="px-6 py-2.5 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-sm disabled:opacity-50">Create</button>
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
