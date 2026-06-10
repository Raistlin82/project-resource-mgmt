import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Assignment, ResourceRequest, Resource, TimeEntry } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DecimalPipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { ListStateComponent } from '../shared/list-state.component';

@Component({
  selector: 'app-my-assignments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, FormsModule, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">My Assignments</h1>
        <div class="command-card flex items-center gap-2 p-1.5">
          <button (click)="viewMode.set('week')"
                  [class.bg-blue-50]="viewMode() === 'week'"
                  [class.text-blue-700]="viewMode() === 'week'"
                  [class.ring-1]="viewMode() === 'week'"
                  [class.ring-blue-200]="viewMode() === 'week'"
                  [class.shadow-sm]="viewMode() === 'week'"
                  [class.text-slate-500]="viewMode() !== 'week'"
                  [class.hover:bg-slate-50]="viewMode() !== 'week'"
                  class="px-5 py-2 rounded-md text-sm font-bold tracking-wide transition-all">
            Week
          </button>
          <button (click)="viewMode.set('month')"
                  [class.bg-blue-50]="viewMode() === 'month'"
                  [class.text-blue-700]="viewMode() === 'month'"
                  [class.ring-1]="viewMode() === 'month'"
                  [class.ring-blue-200]="viewMode() === 'month'"
                  [class.shadow-sm]="viewMode() === 'month'"
                  [class.text-slate-500]="viewMode() !== 'month'"
                  [class.hover:bg-slate-50]="viewMode() !== 'month'"
                  class="px-5 py-2 rounded-md text-sm font-bold tracking-wide transition-all">
            Month
          </button>
        </div>
      </div>

      <!-- Overview Cards -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
        <div class="command-kpi group">
          <div class="flex items-center gap-5">
            <div class="w-14 h-14 bg-blue-50 text-blue-700 ring-1 ring-blue-200 rounded-md flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
              <mat-icon class="text-[28px] w-[28px] h-[28px]">assignment</mat-icon>
            </div>
            <div>
              <p class="command-kpi-label">Active Assignments</p>
              <p class="command-kpi-value">{{ activeAssignmentsCount() }}</p>
            </div>
          </div>
        </div>
        <div class="command-kpi group">
          <div class="flex items-center gap-5">
            <div class="w-14 h-14 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 rounded-md flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
              <mat-icon class="text-[28px] w-[28px] h-[28px]">schedule</mat-icon>
            </div>
            <div>
              <p class="command-kpi-label">Total Assigned Hours</p>
              <p class="command-kpi-value">{{ totalAssignedHours() }}h</p>
            </div>
          </div>
        </div>
        <div class="command-kpi group"
             [class.danger]="currentUtilization() > 110"
             [class.green]="currentUtilization() >= 80 && currentUtilization() <= 110"
             [class.warning]="currentUtilization() < 80">
          <div class="flex items-center gap-5">
            <div class="w-14 h-14 bg-amber-50 text-amber-700 ring-1 ring-amber-200 rounded-md flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
              <mat-icon class="text-[28px] w-[28px] h-[28px]">trending_up</mat-icon>
            </div>
            <div>
              <p class="command-kpi-label">Current Utilization</p>
              <p class="command-kpi-value">
                {{ currentUtilization() | number:'1.0-0' }}%
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Calendar View -->
      <div class="command-card overflow-hidden">
        <div class="command-card-header">
          <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">
            {{ viewMode() === 'week' ? 'Weekly Schedule' : 'Monthly Overview' }}
          </h2>
          <div class="flex items-center gap-3">
            <button type="button" (click)="periodOffset.set(periodOffset() - 1)" [attr.aria-label]="'Previous ' + viewMode()" [attr.title]="'Previous ' + viewMode()" class="w-8 h-8 rounded-full hover:bg-slate-50 flex items-center justify-center text-slate-500 transition-colors">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">chevron_left</mat-icon>
            </button>
            <span class="text-sm font-bold tracking-wide text-slate-700 uppercase">{{ periodLabel() }}</span>
            <button type="button" (click)="periodOffset.set(periodOffset() + 1)" [attr.aria-label]="'Next ' + viewMode()" [attr.title]="'Next ' + viewMode()" class="w-8 h-8 rounded-full hover:bg-slate-50 flex items-center justify-center text-slate-500 transition-colors">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">chevron_right</mat-icon>
            </button>
          </div>
        </div>
        
        <div class="p-6 sm:p-8 overflow-x-auto">
          <!-- Honesty notice: per-day data is not tracked. Assignments only store a
               total number of hours, so the breakdowns below are illustrative. -->
          <div class="mb-6 flex items-start gap-2 rounded-xl border border-amber-200 ring-1 ring-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <mat-icon class="text-[18px] w-[18px] h-[18px] mt-0.5 shrink-0">info</mat-icon>
            <span>
              Estimated distribution only. Assignments track a total number of hours, not per-day data,
              so the {{ viewMode() === 'week' ? 'daily breakdown' : 'calendar placement' }} below is an
              even illustrative spread rather than a real schedule.
            </span>
          </div>
          @if (viewMode() === 'week') {
            <table class="w-full text-left border-collapse min-w-[800px]">
              <thead>
                <tr class="text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200">
                  <th class="pb-4 pr-4 w-1/4">Project / Request</th>
                  <th class="pb-4 px-2 text-center">Mon</th>
                  <th class="pb-4 px-2 text-center">Tue</th>
                  <th class="pb-4 px-2 text-center">Wed</th>
                  <th class="pb-4 px-2 text-center">Thu</th>
                  <th class="pb-4 px-2 text-center">Fri</th>
                  <th class="pb-4 pl-4 text-right">Total</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (assignment of myAssignments(); track assignment.id) {
                  <tr class="text-sm text-slate-700 hover:bg-slate-50 transition-colors group">
                    <td class="py-5 pr-4">
                      <div class="font-bold text-[var(--cc-ink)]">{{ getRequestName(assignment.requestId) }}</div>
                      <div class="text-xs font-semibold tracking-wide text-[var(--cc-muted)] mt-1 uppercase">{{ assignment.status }}</div>
                    </td>
                    <!-- Estimated even daily distribution (Mon–Fri) -->
                    @for (h of dailyHours(assignment.assignedHours); track $index) {
                      <td class="py-5 px-2 text-center">
                        <div class="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-blue-50 text-blue-700 ring-1 ring-blue-200 font-bold font-mono tabular-nums shadow-sm group-hover:bg-blue-100 transition-colors">
                          {{ h }}
                        </div>
                      </td>
                    }
                    <td class="py-5 pl-4 text-right font-bold text-[var(--cc-ink)] text-lg font-mono tabular-nums">
                      {{ assignment.assignedHours }}h
                    </td>
                  </tr>
                }
                @if (!myAssignments().length) {
                  <tr>
                    <td colspan="7" class="py-12 text-center text-slate-500 font-medium italic">No assignments found for this period.</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <!-- Monthly View -->
            <div class="grid grid-cols-7 gap-px bg-slate-200 rounded-xl overflow-hidden border border-slate-200">
              <!-- Days of week header -->
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Mon</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Tue</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Wed</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Thu</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Fri</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Sat</div>
              <div class="bg-slate-50 py-2 text-center text-xs font-medium text-slate-500 uppercase tracking-wider">Sun</div>

              <!-- Mock Calendar Grid -->
              @for (day of mockDays; track day.date) {
                <div class="bg-white min-h-[100px] p-2 hover:bg-slate-50 transition-colors" [class.opacity-50]="!day.isCurrentMonth">
                  <div class="text-right text-xs font-medium text-slate-500 mb-2 font-mono tabular-nums">{{ day.date }}</div>
                  @if (day.isCurrentMonth && day.date % 2 !== 0 && myAssignments().length > 0) {
                    <div class="space-y-1">
                      <div class="text-[10px] font-medium bg-blue-50 text-blue-700 ring-1 ring-blue-200 px-2 py-1 rounded truncate" [title]="getRequestName(myAssignments()[0].requestId)">
                        {{ getRequestName(myAssignments()[0].requestId) }}
                      </div>
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>
      </div>

      <!-- Assignment Details & Editing -->
      <div class="command-card overflow-hidden">
        <div class="command-card-header">
          <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Assignment Details</h2>
        </div>
        <div class="p-6">
          <app-list-state [loading]="dataRes.isLoading()" [error]="dataRes.status() === 'error'" label="assignments" (retry)="dataRes.reload()">
          <div class="space-y-4">
            @for (assignment of myAssignments(); track assignment.id) {
              <div class="command-card-muted p-5 hover:shadow-md transition-all">
                <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div class="flex-1">
                    <h3 class="text-lg font-medium text-[var(--cc-ink)]">{{ getRequestName(assignment.requestId) }}</h3>
                    <div class="flex items-center gap-4 mt-2 text-sm text-[var(--cc-muted)]">
                      <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px]">business</mat-icon> Client Project</span>
                      <span class="flex items-center gap-1"><mat-icon class="text-[16px] w-[16px] h-[16px]">info</mat-icon> <span class="capitalize">{{ assignment.status }}</span></span>
                    </div>
                  </div>
                  
                  <div class="flex items-center gap-4">
                    @if (editingAssignmentId() === assignment.id) {
                      <div class="flex items-center gap-2">
                        <input type="number" [ngModel]="editHours()" (ngModelChange)="editHours.set($event)" class="w-20 px-3 py-1.5 rounded-lg bg-white focus:bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none text-sm font-mono tabular-nums">
                        <span class="text-sm text-slate-500">hours</span>
                        <button type="button" (click)="saveAssignment(assignment)" aria-label="Save hours" title="Save hours" class="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors">
                          <mat-icon>check</mat-icon>
                        </button>
                        <button type="button" (click)="cancelEdit()" aria-label="Cancel editing" title="Cancel editing" class="p-1.5 text-slate-400 hover:bg-slate-50 rounded-lg transition-colors">
                          <mat-icon>close</mat-icon>
                        </button>
                      </div>
                    } @else {
                      <div class="text-right">
                        <div class="text-xl font-semibold text-[var(--cc-ink)] font-mono tabular-nums">{{ assignment.assignedHours }}h</div>
                        <div class="text-xs text-[var(--cc-muted)] uppercase tracking-wider">Total Assigned</div>
                        <div class="text-xs text-emerald-700 font-semibold mt-1 font-mono tabular-nums">{{ approvedHours(assignment.id) }}h approved actual</div>
                      </div>
                      <button type="button" (click)="startEdit(assignment)" class="p-2 text-slate-400 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors" aria-label="Edit Hours" title="Edit Hours">
                        <mat-icon>edit</mat-icon>
                      </button>
                      <button type="button" (click)="startTimeEntry(assignment)" class="p-2 text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 rounded-lg transition-colors" aria-label="Log actual time" title="Log actual time">
                        <mat-icon>more_time</mat-icon>
                      </button>
                    }
                  </div>
                </div>
                @if (timeEntryAssignmentId() === assignment.id) {
                  <div class="mt-5 rounded-2xl border border-emerald-200 ring-1 ring-emerald-200 bg-emerald-50 p-4">
                    <div class="grid grid-cols-1 sm:grid-cols-[160px_120px_1fr_auto] gap-3 items-end">
                      <div>
                        <label for="timeEntryDate" class="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Date</label>
                        <input id="timeEntryDate" type="date" [ngModel]="timeEntryDate()" (ngModelChange)="timeEntryDate.set($event)" class="w-full px-3 py-2 rounded-lg bg-white focus:bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none text-sm">
                      </div>
                      <div>
                        <label for="timeEntryHours" class="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Hours</label>
                        <input id="timeEntryHours" type="number" min="0" [ngModel]="timeEntryHours()" (ngModelChange)="timeEntryHours.set($event)" class="w-full px-3 py-2 rounded-lg bg-white focus:bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none text-sm font-mono tabular-nums">
                      </div>
                      <div>
                        <label for="timeEntryNotes" class="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1">Notes</label>
                        <input id="timeEntryNotes" type="text" [ngModel]="timeEntryNotes()" (ngModelChange)="timeEntryNotes.set($event)" class="w-full px-3 py-2 rounded-lg bg-white focus:bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400 focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 focus:outline-none text-sm" placeholder="Work performed">
                      </div>
                      <div class="flex gap-2">
                        <button (click)="saveTimeEntry(assignment)" class="command-button">Submit</button>
                        <button type="button" (click)="cancelTimeEntry()" aria-label="Cancel time entry" title="Cancel time entry" class="p-2 rounded-lg text-slate-500 hover:bg-slate-50"><mat-icon>close</mat-icon></button>
                      </div>
                    </div>
                  </div>
                }
                @if (timeEntriesForAssignment(assignment.id).length) {
                  <div class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    @for (entry of timeEntriesForAssignment(assignment.id); track entry.id) {
                      <div class="command-card-muted px-4 py-3 text-sm">
                        <div class="flex items-center justify-between gap-3">
                          <span class="font-semibold text-slate-700 font-mono tabular-nums">{{ entry.date }} · {{ entry.hours }}h</span>
                          <span class="text-xs font-bold rounded-md px-2 py-0.5 ring-1"
                                [class.bg-emerald-50]="entry.status === 'Approved'"
                                [class.text-emerald-700]="entry.status === 'Approved'"
                                [class.ring-emerald-200]="entry.status === 'Approved'"
                                [class.bg-amber-50]="entry.status === 'Submitted'"
                                [class.text-amber-700]="entry.status === 'Submitted'"
                                [class.ring-amber-200]="entry.status === 'Submitted'"
                                [class.bg-slate-100]="entry.status === 'Draft'"
                                [class.text-slate-700]="entry.status === 'Draft'"
                                [class.ring-slate-200]="entry.status === 'Draft'"
                                [class.bg-red-50]="entry.status === 'Rejected'"
                                [class.text-red-700]="entry.status === 'Rejected'"
                                [class.ring-red-200]="entry.status === 'Rejected'">
                            {{ entry.status }}
                          </span>
                        </div>
                        @if (entry.notes) {
                          <p class="text-xs text-slate-500 mt-1">{{ entry.notes }}</p>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            }
            @if (!myAssignments().length) {
              <div class="text-center py-8 text-slate-500">
                You don't have any active assignments.
              </div>
            }
          </div>
          </app-list-state>
        </div>
      </div>
    </div>
  `
})
export class MyAssignmentsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  private currentUserId = this.auth.userId();

  // The resource profile (getResource) and time-entries reads are principal-gated
  // server-side (401 until the Keycloak JWT is restored). On reload the OIDC token
  // restores async; firing the forkJoin immediately 401s and the rxResource latches
  // on the error (page shows zeros forever). Key the load on auth readiness so it
  // fires only AFTER the OAuth bootstrap has settled and the bearer token is attached.
  protected dataRes = rxResource<{ assignments: Assignment[]; requests: ResourceRequest[]; profile: Resource | null; timeEntries: TimeEntry[] }, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => ready
      ? forkJoin({
          assignments: this.api.getAssignments(),
          requests: this.api.getRequests(),
          profile: this.api.getResource(this.currentUserId),
          timeEntries: this.api.getTimeEntries(),
        })
      : of({ assignments: [], requests: [], profile: null, timeEntries: [] }),
    defaultValue: { assignments: [], requests: [], profile: null, timeEntries: [] },
  });

  myAssignments = computed(() => this.dataRes.value().assignments.filter(a => a.resourceId === this.currentUserId));
  allRequests = computed(() => this.dataRes.value().requests);
  profile = computed(() => this.dataRes.value().profile);
  timeEntries = computed(() => this.dataRes.value().timeEntries.filter(t => t.resourceId === this.currentUserId));

  viewMode = signal<'week' | 'month'>('week');
  editingAssignmentId = signal<string | null>(null);
  editHours = signal(0);
  timeEntryAssignmentId = signal<string | null>(null);
  timeEntryDate = signal(new Date().toISOString().slice(0, 10));
  timeEntryHours = signal(8);
  timeEntryNotes = signal('');

  // Frontend-only period navigation. Assignments have no date fields, so this
  // only changes the displayed label (e.g. "Next Week"); the underlying data
  // is unchanged. 0 = current period, negative = past, positive = future.
  periodOffset = signal(0);

  periodLabel = computed(() => {
    const offset = this.periodOffset();
    const unit = this.viewMode() === 'week' ? 'Week' : 'Month';
    if (offset === 0) return `Current ${unit}`;
    if (offset === -1) return `Previous ${unit}`;
    if (offset === 1) return `Next ${unit}`;
    return offset < 0 ? `${-offset} ${unit}s Ago` : `In ${offset} ${unit}s`;
  });

  // Mock calendar days for month view
  mockDays = Array.from({ length: 35 }, (_, i) => {
    const isCurrentMonth = i >= 3 && i < 34;
    return {
      date: isCurrentMonth ? i - 2 : (i < 3 ? 28 + i : i - 33),
      isCurrentMonth
    };
  });

  activeAssignmentsCount = computed(() => this.myAssignments().filter(a => a.status !== 'completed').length);
  totalAssignedHours = computed(() => this.myAssignments().reduce((sum, a) => sum + a.assignedHours, 0));
  currentUtilization = computed(() => {
    const p = this.profile();
    if (!p || !p.capacity) return 0;
    // Assuming capacity is weekly, multiply by 4 for monthly approx
    return (this.totalAssignedHours() / (p.capacity * 4)) * 100;
  });

  dailyHours(total: number): number[] {
    const base = Math.floor(total / 5);
    const last = total - base * 4;
    return [base, base, base, base, last].map(x => Math.max(0, x));
  }

  getRequestName(id: string): string {
    return this.allRequests().find(r => r.id === id)?.name || 'Unknown Project';
  }

  getRequest(id: string): ResourceRequest | undefined {
    return this.allRequests().find(r => r.id === id);
  }

  timeEntriesForAssignment(id: string): TimeEntry[] {
    return this.timeEntries().filter(t => t.assignmentId === id).sort((a, b) => b.date.localeCompare(a.date));
  }

  approvedHours(id: string): number {
    return this.timeEntriesForAssignment(id)
      .filter(t => t.status === 'Approved')
      .reduce((sum, t) => sum + t.hours, 0);
  }

  getUtilizationColorText(utilization: number): string {
    if (utilization > 110) return 'text-red-600';
    if (utilization >= 80) return 'text-emerald-600';
    return 'text-orange-600';
  }

  startEdit(assignment: Assignment) {
    this.editingAssignmentId.set(assignment.id);
    this.editHours.set(assignment.assignedHours);
  }

  cancelEdit() {
    this.editingAssignmentId.set(null);
  }

  startTimeEntry(assignment: Assignment) {
    this.timeEntryAssignmentId.set(assignment.id);
    this.timeEntryHours.set(Math.min(8, assignment.assignedHours || 8));
    this.timeEntryDate.set(new Date().toISOString().slice(0, 10));
    this.timeEntryNotes.set('');
  }

  cancelTimeEntry() {
    this.timeEntryAssignmentId.set(null);
  }

  saveTimeEntry(assignment: Assignment) {
    const request = this.getRequest(assignment.requestId);
    const hours = this.timeEntryHours();
    if (!request?.projectId || hours <= 0) return;
    this.api.createTimeEntry({
      assignmentId: assignment.id,
      requestId: assignment.requestId,
      resourceId: assignment.resourceId,
      projectId: request.projectId,
      date: this.timeEntryDate(),
      hours,
      status: 'Submitted',
      notes: this.timeEntryNotes(),
    }).subscribe(() => {
      this.dataRes.reload();
      this.cancelTimeEntry();
    });
  }

  saveAssignment(assignment: Assignment) {
    const hours = this.editHours();
    if (hours >= 0) {
      this.api.updateAssignment(assignment.id, { assignedHours: hours }).subscribe(() => {
        this.dataRes.reload();
        this.cancelEdit();
      });
    }
  }
}
