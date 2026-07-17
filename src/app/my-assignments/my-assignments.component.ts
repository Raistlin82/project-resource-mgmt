import { ChangeDetectionStrategy, Component, inject, signal, computed } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Assignment, ResourceRequest, Resource, TimeEntry } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DecimalPipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { ListStateComponent } from '../shared/list-state.component';

interface CalendarAssignment {
  id: string;
  name: string;
  hours: number;
  status: string;
}

interface CalendarDay {
  iso: string;
  dayOfMonth: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  assignments: CalendarAssignment[];
  hiddenCount: number;
}

interface WeekDay {
  iso: string;
  label: string;
  dayLabel: string;
  isToday: boolean;
}

@Component({
  selector: 'app-my-assignments',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, FormsModule, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">My Assignments</h1>
        <div class="command-card flex items-center gap-2 p-1.5">
          <button type="button"
                  (click)="setViewMode('week')"
                  [attr.aria-pressed]="viewMode() === 'week'"
                  [class.bg-accent-tint]="viewMode() === 'week'"
                  [class.text-accent-text]="viewMode() === 'week'"
                  [class.ring-1]="viewMode() === 'week'"
                  [class.ring-accent]="viewMode() === 'week'"
                  [class.shadow-sm]="viewMode() === 'week'"
                  [class.text-ink-muted]="viewMode() !== 'week'"
                  [class.hover:bg-surface-muted]="viewMode() !== 'week'"
                  class="px-5 py-2 rounded-md text-sm font-bold tracking-wide transition-all">
            Week
          </button>
          <button type="button"
                  (click)="setViewMode('month')"
                  [attr.aria-pressed]="viewMode() === 'month'"
                  [class.bg-accent-tint]="viewMode() === 'month'"
                  [class.text-accent-text]="viewMode() === 'month'"
                  [class.ring-1]="viewMode() === 'month'"
                  [class.ring-accent]="viewMode() === 'month'"
                  [class.shadow-sm]="viewMode() === 'month'"
                  [class.text-ink-muted]="viewMode() !== 'month'"
                  [class.hover:bg-surface-muted]="viewMode() !== 'month'"
                  class="px-5 py-2 rounded-md text-sm font-bold tracking-wide transition-all">
            Month
          </button>
        </div>
      </div>

      <!-- Overview Cards -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-6">
        <div class="command-kpi group">
          <div class="flex items-center gap-5">
            <div class="w-14 h-14 bg-accent-tint text-accent-text ring-1 ring-accent rounded-md flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
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
            <div class="w-14 h-14 bg-positive-tint text-positive-text ring-1 ring-positive rounded-md flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
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
            <div class="w-14 h-14 bg-caution-tint text-caution-text ring-1 ring-caution rounded-md flex items-center justify-center group-hover:scale-110 transition-transform shadow-sm">
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
            <button type="button" (click)="periodOffset.set(periodOffset() - 1)" [attr.aria-label]="'Previous ' + viewMode()" [attr.title]="'Previous ' + viewMode()" class="w-8 h-8 rounded-full hover:bg-surface-muted flex items-center justify-center text-ink-muted transition-colors">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">chevron_left</mat-icon>
            </button>
            <span class="text-sm font-bold tracking-wide text-ink-secondary uppercase">{{ periodLabel() }}</span>
            <button type="button" (click)="periodOffset.set(periodOffset() + 1)" [attr.aria-label]="'Next ' + viewMode()" [attr.title]="'Next ' + viewMode()" class="w-8 h-8 rounded-full hover:bg-surface-muted flex items-center justify-center text-ink-muted transition-colors">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">chevron_right</mat-icon>
            </button>
          </div>
        </div>
        
        <div class="p-6 sm:p-8 overflow-x-auto">
          <!-- Booking windows are real; daily hour splits are estimated because no
               per-day assignment plan is stored. -->
          <div class="mb-6 flex items-start gap-2 rounded-xl border border-caution ring-1 ring-caution bg-caution-tint px-4 py-3 text-sm text-caution-text">
            <mat-icon class="text-[18px] w-[18px] h-[18px] mt-0.5 shrink-0">info</mat-icon>
            <span>
              Booking dates come from the assignment window, falling back to the linked request dates.
              Daily hours are estimated because assignments store total hours, not a per-day timesheet plan.
            </span>
          </div>
          @if (viewMode() === 'week') {
            <table class="w-full text-left border-collapse min-w-[800px]">
              <caption class="sr-only">Estimated assignment hours for {{ periodLabel() }}</caption>
              <thead>
                <tr class="text-xs font-semibold text-ink-muted uppercase tracking-wider border-b border-line">
                  <th class="pb-4 pr-4 w-1/4">Project / Request</th>
                  @for (day of weekDays(); track day.iso) {
                    <th class="pb-4 px-2 text-center" [class.text-accent-text]="day.isToday">
                      <span class="block">{{ day.label }}</span>
                      <span class="block mt-1 font-mono text-[11px] normal-case">{{ day.dayLabel }}</span>
                    </th>
                  }
                  <th class="pb-4 pl-4 text-right">Period est.</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (assignment of periodAssignments(); track assignment.id) {
                  <tr class="text-sm text-ink-secondary hover:bg-surface-muted transition-colors group">
                    <td class="py-5 pr-4">
                      <div class="font-bold text-[var(--cc-ink)]">{{ getRequestName(assignment.requestId) }}</div>
                      <div class="text-xs font-semibold tracking-wide text-[var(--cc-muted)] mt-1 uppercase">{{ assignment.status }}</div>
                      <div class="text-xs text-[var(--cc-muted)] mt-1 font-mono">{{ bookingLabel(assignment) }}</div>
                    </td>
                    @for (day of weekDays(); track day.iso) {
                      <td class="py-5 px-2 text-center">
                        <div class="inline-flex items-center justify-center w-10 h-10 rounded-xl ring-1 font-bold font-mono tabular-nums shadow-sm transition-colors"
                             [class.bg-accent-tint]="estimatedHoursForDay(assignment, day.iso) > 0"
                             [class.text-accent-text]="estimatedHoursForDay(assignment, day.iso) > 0"
                             [class.ring-accent]="estimatedHoursForDay(assignment, day.iso) > 0"
                             [class.bg-surface-muted]="estimatedHoursForDay(assignment, day.iso) === 0"
                             [class.text-ink-muted]="estimatedHoursForDay(assignment, day.iso) === 0"
                             [class.ring-line]="estimatedHoursForDay(assignment, day.iso) === 0">
                          {{ estimatedHoursForDay(assignment, day.iso) || '—' }}
                        </div>
                      </td>
                    }
                    <td class="py-5 pl-4 text-right font-bold text-[var(--cc-ink)] text-lg font-mono tabular-nums">
                      {{ assignedHoursInWeek(assignment) }}h
                    </td>
                  </tr>
                }
                @if (!periodAssignments().length) {
                  <tr>
                    <td colspan="7" class="py-12 text-center text-ink-muted font-medium italic">No assignments found for this period.</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <!-- Monthly View -->
            <div class="grid grid-cols-7 gap-px bg-surface-muted rounded-xl overflow-hidden border border-line">
              <!-- Days of week header -->
              <div class="bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Mon</div>
              <div class="bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Tue</div>
              <div class="bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Wed</div>
              <div class="bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Thu</div>
              <div class="bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Fri</div>
              <div class="bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Sat</div>
              <div class="bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Sun</div>

              @for (day of monthDays(); track day.iso) {
                <div class="bg-surface min-h-[112px] p-2 hover:bg-surface-muted transition-colors"
                     [class.opacity-50]="!day.isCurrentMonth"
                     [class.bg-accent-tint]="day.isToday">
                  <div class="flex items-center justify-between text-xs font-medium mb-2 font-mono tabular-nums"
                       [class.text-accent-text]="day.isToday"
                       [class.text-ink-muted]="!day.isToday">
                    <span>{{ day.iso.slice(5) }}</span>
                    <span>{{ day.dayOfMonth }}</span>
                  </div>
                  @if (day.assignments.length) {
                    <div class="space-y-1">
                      @for (item of day.assignments; track item.id) {
                        <div class="text-[10px] font-medium bg-accent-tint text-accent-text ring-1 ring-accent px-2 py-1 rounded truncate"
                             [title]="item.name + ' · ' + item.hours + 'h estimated'">
                          {{ item.name }} · {{ item.hours }}h
                        </div>
                      }
                      @if (day.hiddenCount > 0) {
                        <div class="text-[10px] font-semibold text-ink-muted px-2">+{{ day.hiddenCount }} more</div>
                      }
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
                        <label [for]="editHoursInputId(assignment.id)" class="sr-only">Assigned hours for {{ getRequestName(assignment.requestId) }}</label>
                        <input [id]="editHoursInputId(assignment.id)" type="number" [ngModel]="editHours()" (ngModelChange)="editHours.set($event)" [attr.aria-label]="'Assigned hours for ' + getRequestName(assignment.requestId)" class="command-input w-20 font-mono tabular-nums">
                        <span class="text-sm text-ink-muted">hours</span>
                        <button type="button" (click)="saveAssignment(assignment)" aria-label="Save hours" title="Save hours" class="p-1.5 text-positive-text hover:bg-positive-tint rounded-lg transition-colors">
                          <mat-icon>check</mat-icon>
                        </button>
                        <button type="button" (click)="cancelEdit()" aria-label="Cancel editing" title="Cancel editing" class="p-1.5 text-ink-muted hover:bg-surface-muted rounded-lg transition-colors">
                          <mat-icon>close</mat-icon>
                        </button>
                      </div>
                    } @else {
                      <div class="text-right">
                        <div class="text-xl font-semibold text-[var(--cc-ink)] font-mono tabular-nums">{{ assignment.assignedHours }}h</div>
                        <div class="text-xs text-[var(--cc-muted)] uppercase tracking-wider">Total Assigned</div>
                        <div class="text-xs text-positive-text font-semibold mt-1 font-mono tabular-nums">{{ approvedHours(assignment.id) }}h approved actual</div>
                      </div>
                      <button type="button" (click)="startEdit(assignment)" class="p-2 text-ink-muted hover:text-accent-text hover:bg-accent-tint rounded-lg transition-colors" aria-label="Edit Hours" title="Edit Hours">
                        <mat-icon>edit</mat-icon>
                      </button>
                      <button type="button" (click)="startTimeEntry(assignment)" class="p-2 text-ink-muted hover:text-positive-text hover:bg-positive-tint rounded-lg transition-colors" aria-label="Log actual time" title="Log actual time">
                        <mat-icon>more_time</mat-icon>
                      </button>
                    }
                  </div>
                </div>
                @if (timeEntryAssignmentId() === assignment.id) {
                  <div class="mt-5 rounded-2xl border border-positive ring-1 ring-positive bg-positive-tint p-4">
                    <div class="grid grid-cols-1 sm:grid-cols-[160px_120px_1fr_auto] gap-3 items-end">
                      <div>
                        <label for="timeEntryDate" class="block text-xs font-bold uppercase tracking-wider text-ink-muted mb-1">Date</label>
                        <input id="timeEntryDate" type="date" [ngModel]="timeEntryDate()" (ngModelChange)="timeEntryDate.set($event)" class="command-input">
                      </div>
                      <div>
                        <label for="timeEntryHours" class="block text-xs font-bold uppercase tracking-wider text-ink-muted mb-1">Hours</label>
                        <input id="timeEntryHours" type="number" min="0" [ngModel]="timeEntryHours()" (ngModelChange)="timeEntryHours.set($event)" class="command-input font-mono tabular-nums">
                      </div>
                      <div>
                        <label for="timeEntryNotes" class="block text-xs font-bold uppercase tracking-wider text-ink-muted mb-1">Notes</label>
                        <input id="timeEntryNotes" type="text" [ngModel]="timeEntryNotes()" (ngModelChange)="timeEntryNotes.set($event)" class="command-input" placeholder="Work performed">
                      </div>
                      <div class="flex gap-2">
                        <button (click)="saveTimeEntry(assignment)" class="command-button">Submit</button>
                        <button type="button" (click)="cancelTimeEntry()" aria-label="Cancel time entry" title="Cancel time entry" class="p-2 rounded-lg text-ink-muted hover:bg-surface-muted"><mat-icon>close</mat-icon></button>
                      </div>
                    </div>
                  </div>
                }
                @if (timeEntriesForAssignment(assignment.id).length) {
                  <div class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    @for (entry of timeEntriesForAssignment(assignment.id); track entry.id) {
                      <div class="command-card-muted px-4 py-3 text-sm">
                        <div class="flex items-center justify-between gap-3">
                          <span class="font-semibold text-ink-secondary font-mono tabular-nums">{{ entry.date }} · {{ entry.hours }}h</span>
                          <span class="command-chip"
                                [class.is-positive]="entry.status === 'Approved'"
                                [class.is-caution]="entry.status === 'Submitted'"
                                [class.is-neutral]="entry.status === 'Draft'"
                                [class.is-critical]="entry.status === 'Rejected'">
                            {{ entry.status }}
                          </span>
                        </div>
                        @if (entry.notes) {
                          <p class="text-xs text-ink-muted mt-1">{{ entry.notes }}</p>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            }
            @if (!myAssignments().length) {
              <div class="text-center py-8 text-ink-muted">
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

  // Read LIVE, never snapshot at field-init (see auth.service note): a captured
  // value freezes the anonymous default and shows the wrong user's data on reload.
  private get currentUserId(): string { return this.auth.userId(); }

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

  // 0 = current period, negative = past, positive = future.
  periodOffset = signal(0);
  private todayIso = this.toIso(new Date());

  private weekStart = computed(() => this.addDays(this.startOfWeek(new Date()), this.periodOffset() * 7));
  private monthStart = computed(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() + this.periodOffset(), 1);
  });
  private periodRange = computed(() => {
    if (this.viewMode() === 'week') {
      const start = this.weekStart();
      return { start, end: this.addDays(start, 4) };
    }
    const start = this.monthStart();
    return { start, end: this.endOfMonth(start) };
  });

  periodLabel = computed(() => {
    const { start, end } = this.periodRange();
    return this.viewMode() === 'week'
      ? `${this.formatDateShort(start)} to ${this.formatDateShort(end)}`
      : this.formatMonth(start);
  });

  weekDays = computed<WeekDay[]>(() => {
    const start = this.weekStart();
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
    return labels.map((label, index) => {
      const date = this.addDays(start, index);
      const iso = this.toIso(date);
      return {
        iso,
        label,
        dayLabel: this.formatDayMonth(date),
        isToday: iso === this.todayIso,
      };
    });
  });

  periodAssignments = computed(() => {
    const { start, end } = this.periodRange();
    return this.myAssignments().filter(a => {
      const win = this.assignmentWindow(a);
      if (!win) return this.periodOffset() === 0;
      return this.rangesOverlap(win.start, win.end, start, end);
    });
  });

  monthDays = computed<CalendarDay[]>(() => {
    const monthStart = this.monthStart();
    const monthEnd = this.endOfMonth(monthStart);
    const gridStart = this.startOfWeek(monthStart);
    const gridEnd = this.addDays(this.startOfWeek(monthEnd), 6);
    const days: CalendarDay[] = [];

    for (let date = gridStart; date <= gridEnd; date = this.addDays(date, 1)) {
      const iso = this.toIso(date);
      const items = this.periodAssignments()
        .filter(assignment => this.estimatedHoursForDay(assignment, iso) > 0)
        .map(assignment => ({
          id: assignment.id,
          name: this.getRequestName(assignment.requestId),
          hours: this.estimatedHoursForDay(assignment, iso),
          status: assignment.status,
        }));

      days.push({
        iso,
        dayOfMonth: date.getDate(),
        isCurrentMonth: date.getMonth() === monthStart.getMonth(),
        isToday: iso === this.todayIso,
        isWeekend: !this.isBusinessDay(date),
        assignments: items.slice(0, 2),
        hiddenCount: Math.max(0, items.length - 2),
      });
    }

    return days;
  });

  // An assignment counts as "active" when it isn't Rejected — i.e. Draft,
  // Requested or Allocated (the allocation-approval workflow states).
  activeAssignmentsCount = computed(() => this.myAssignments().filter(a => a.status !== 'Rejected').length);
  totalAssignedHours = computed(() => this.myAssignments().reduce((sum, a) => sum + a.assignedHours, 0));
  currentUtilization = computed(() => {
    const p = this.profile();
    if (!p || !p.capacity) return 0;
    // Assuming capacity is weekly, multiply by 4 for monthly approx
    return (this.totalAssignedHours() / (p.capacity * 4)) * 100;
  });

  setViewMode(mode: 'week' | 'month'): void {
    if (this.viewMode() !== mode) {
      this.viewMode.set(mode);
      this.periodOffset.set(0);
    }
  }

  estimatedHoursForDay(assignment: Assignment, iso: string): number {
    const date = this.parseIso(iso);
    const win = this.assignmentWindowOrPeriod(assignment);
    if (!date || !win || !this.isBusinessDay(date) || !this.dateInRange(date, win.start, win.end)) return 0;

    const businessDays = this.businessDaysBetween(win.start, win.end);
    if (businessDays <= 0) return 0;
    return this.roundHours(assignment.assignedHours / businessDays);
  }

  assignedHoursInWeek(assignment: Assignment): number {
    return this.roundHours(
      this.weekDays().reduce((sum, day) => sum + this.estimatedHoursForDay(assignment, day.iso), 0),
    );
  }

  bookingLabel(assignment: Assignment): string {
    const win = this.assignmentWindow(assignment);
    if (!win) return 'No booking window';
    const suffix = win.source === 'request' ? ' (request dates)' : '';
    return `${this.toIso(win.start)} to ${this.toIso(win.end)}${suffix}`;
  }

  editHoursInputId(id: string): string {
    return `editHours-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  }

  getRequestName(id: string): string {
    return this.allRequests().find(r => r.id === id)?.name || 'Unknown Project';
  }

  getRequest(id: string): ResourceRequest | undefined {
    return this.allRequests().find(r => r.id === id);
  }

  private assignmentWindowOrPeriod(assignment: Assignment): { start: Date; end: Date; source: 'assignment' | 'request' | 'period' } | null {
    const win = this.assignmentWindow(assignment);
    if (win) return win;
    if (this.periodOffset() !== 0) return null;
    const range = this.periodRange();
    return { ...range, source: 'period' };
  }

  private assignmentWindow(assignment: Assignment): { start: Date; end: Date; source: 'assignment' | 'request' } | null {
    const assignmentStart = this.parseIso(assignment.startDate);
    const assignmentEnd = this.parseIso(assignment.endDate);
    if (assignmentStart && assignmentEnd) {
      return this.normalizeWindow(assignmentStart, assignmentEnd, 'assignment');
    }

    const request = this.getRequest(assignment.requestId);
    const requestStart = this.parseIso(request?.startDate);
    const requestEnd = this.parseIso(request?.endDate);
    if (requestStart && requestEnd) {
      return this.normalizeWindow(requestStart, requestEnd, 'request');
    }

    return null;
  }

  private normalizeWindow<T extends 'assignment' | 'request'>(start: Date, end: Date, source: T): { start: Date; end: Date; source: T } {
    return start <= end ? { start, end, source } : { start: end, end: start, source };
  }

  private parseIso(value?: string): Date | null {
    if (!value) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [, y, m, d] = match;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    return this.toIso(date) === value ? date : null;
  }

  private toIso(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    next.setDate(next.getDate() + days);
    return next;
  }

  private startOfWeek(date: Date): Date {
    const offset = (date.getDay() + 6) % 7;
    return this.addDays(date, -offset);
  }

  private endOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
  }

  private isBusinessDay(date: Date): boolean {
    const day = date.getDay();
    return day >= 1 && day <= 5;
  }

  private businessDaysBetween(start: Date, end: Date): number {
    let count = 0;
    for (let date = start; date <= end; date = this.addDays(date, 1)) {
      if (this.isBusinessDay(date)) count++;
    }
    return count;
  }

  private dateInRange(date: Date, start: Date, end: Date): boolean {
    return date >= start && date <= end;
  }

  private rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
    return aStart <= bEnd && bStart <= aEnd;
  }

  private roundHours(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private formatDateShort(date: Date): string {
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(date);
  }

  private formatDayMonth(date: Date): string {
    return new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short' }).format(date);
  }

  private formatMonth(date: Date): string {
    return new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(date);
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
    if (utilization > 110) return 'text-critical-text';
    if (utilization >= 80) return 'text-positive-text';
    return 'text-caution-text';
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
