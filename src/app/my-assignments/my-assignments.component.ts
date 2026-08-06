import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, Assignment, ResourceRequest, Resource, TimeEntry } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DecimalPipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { ListStateComponent } from '../shared/list-state.component';
import { NotificationService } from '../services/notification.service';
import { todayLocalIso } from '../services/local-date.util';

interface CalendarAssignment {
  id: string;
  name: string;
  hours: number;
  status: string;
}

interface CalendarDay {
  iso: string;
  dayOfMonth: number;
  /** 'Mon'…'Sun'. Carries the weekday in the collapsed (below-`sm`) month list,
   *  where the seven-column header strip is not rendered. */
  weekdayLabel: string;
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

/** Mon-Fri. The divisor that turns a WEEKLY `capacity` into a daily rate — see
 *  `currentUtilization`. Not a stand-in for "weeks in a month": the period's own
 *  business-day count comes from the calendar. */
const BUSINESS_DAYS_PER_WEEK = 5;

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

      <!-- ONE READ-STATE BOUNDARY OWNS THE WHOLE BODY.
           Everything below dereferences dataRes.value() — through
           myAssignments()/profile()/timeEntries() and every accessor derived from
           them — and rxResource.value() THROWS while the resource is in its error
           state. With the KPI tiles and the calendar sitting ABOVE the old wrapper
           (which covered only the Assignment Details list), the first of those
           bindings aborted the change-detection pass, and that made the error
           panel and its Retry button — the markup written for exactly this
           failure — unreachable code: an expired bearer on /self/profile left the
           page as a header over three zero tiles, permanently. Reordering the
           template does not fix that; the abort just moves to whichever binding
           is now first. The only fix is that NOTHING outside this boundary
           dereferences the value. Keep that invariant when adding markup here.

           The loading predicate folds auth readiness deliberately. params() is
           false until the OIDC bootstrap settles, and the stream answers that
           with of(<empty>) — a RESOLVED empty, not a pending one — so
           isLoading() alone left the whole pre-authReady window, including the
           SSR-rendered document, telling a person with five live bookings
           "Active Assignments 0", "0h", a 0% utilization tile and "No
           assignments found for this period.". Withheld is not zero. -->
      <app-list-state [loading]="!auth.authReady() || dataRes.isLoading()"
                      [error]="dataRes.status() === 'error'"
                      label="assignments" [rows]="5" (retry)="dataRes.reload()">
        <ng-template>
          <div class="space-y-6">
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
                    <p class="command-kpi-value">{{ totalAssignedHours() | number:'1.0-2' }}h</p>
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
                    <!-- The label names the denominator. The figure is scoped to
                         the period the navigator below is showing, so a bare
                         "Current Utilization" beside a week/month toggle left the
                         reader no way to know what it was a percentage OF. -->
                    <p class="command-kpi-label">Utilization ({{ viewMode() }})</p>
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
                  <!-- SEVEN COLUMNS ARE A WIDE-VIEWPORT LAYOUT, NOT A FLOOR.
                       "grid-cols-7" unconditionally divided the card by 7 at every
                       width: at 320px that is ~33px per track and ~17px of content box
                       per day, while the date header's min-content ("08-06" at 12px
                       monospace plus the day number) is ~50px — so every header
                       overflowed into the neighbouring day and Sunday's overflow was
                       cut off by this container's own "overflow-hidden". The
                       "overflow-x-auto" on the parent never engaged, because the grid
                       had shrunk to fit rather than overflowed: there was no
                       pan-to-read escape. Collapsing to a single column below "sm"
                       gives each day the full card width; a "min-w-[]" floor would
                       only have traded the overlap for a pan across a grid whose 10px
                       chips are still unreadable. The weekday header strip belongs to
                       the 7-track layout only, so it is hidden in the collapsed list
                       where each row carries its own weekday. -->
                  <div class="grid grid-cols-1 sm:grid-cols-7 gap-px bg-surface-muted rounded-xl overflow-hidden border border-line"
                       data-test="month-grid">
                    <!-- Days of week header -->
                    <div class="hidden sm:block bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Mon</div>
                    <div class="hidden sm:block bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Tue</div>
                    <div class="hidden sm:block bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Wed</div>
                    <div class="hidden sm:block bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Thu</div>
                    <div class="hidden sm:block bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Fri</div>
                    <div class="hidden sm:block bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Sat</div>
                    <div class="hidden sm:block bg-surface-muted py-2 text-center text-xs font-medium text-ink-muted uppercase tracking-wider">Sun</div>

                    @for (day of monthDays(); track day.iso) {
                      <div class="bg-surface min-h-[72px] sm:min-h-[112px] p-2 hover:bg-surface-muted transition-colors"
                           [class.opacity-50]="!day.isCurrentMonth"
                           [class.bg-accent-tint]="day.isToday">
                        <div class="flex items-center justify-between text-xs font-medium mb-2 font-mono tabular-nums"
                             data-test="month-day-header"
                             [class.text-accent-text]="day.isToday"
                             [class.text-ink-muted]="!day.isToday">
                          <!-- The weekday replaces the dropped "iso.slice(5)": it is the
                               fact the hidden column header used to carry, and unlike
                               "08-06" it is not a restatement of the day number beside
                               it. Hidden from "sm" up, where the header strip is back. -->
                          <span class="sm:hidden uppercase">{{ day.weekdayLabel }}</span>
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
                          <div class="text-right">
                            <div class="text-xl font-semibold text-[var(--cc-ink)] font-mono tabular-nums">{{ assignment.assignedHours | number:'1.0-2' }}h</div>
                            <div class="text-xs text-[var(--cc-muted)] uppercase tracking-wider">Total Assigned</div>
                            <div class="text-xs text-positive-text font-semibold mt-1 font-mono tabular-nums">{{ approvedHours(assignment.id) | number:'1.0-2' }}h approved actual</div>
                            <div class="text-xs text-[var(--cc-muted)] mt-1">Planned hours are edited per day in the Allocation Calendar.</div>
                          </div>
                          @if (canSubmitOwnTime()) {
                            <button type="button" (click)="startTimeEntry(assignment)" class="p-2 text-ink-muted hover:text-positive-text hover:bg-positive-tint rounded-lg transition-colors" aria-label="Log actual time" title="Log actual time">
                              <mat-icon>more_time</mat-icon>
                            </button>
                          }
                        </div>
                      </div>
                      @if (timeEntryAssignmentId() === assignment.id) {
                        <form (ngSubmit)="saveTimeEntry(assignment)" class="mt-5 rounded-2xl border border-positive ring-1 ring-positive bg-positive-tint p-4">
                          <div class="grid grid-cols-1 sm:grid-cols-[160px_120px_1fr_auto] gap-3 items-end">
                            <div>
                              <label for="timeEntryDate" class="block text-xs font-bold uppercase tracking-wider text-ink-muted mb-1">Date</label>
                              <!-- The disabled Submit is the actual dead end, so the
                                   sentence that explains it must be reachable FROM the
                                   control: aria-describedby names the live region and
                                   aria-invalid marks which control it is about. -->
                              <input id="timeEntryDate" name="timeEntryDate" type="date" required
                                     aria-describedby="timeEntryMessage"
                                     [attr.aria-invalid]="timeEntryDateInvalid()"
                                     [disabled]="savingTimeEntryAssignmentId() !== null"
                                     [ngModel]="timeEntryDate()" (ngModelChange)="timeEntryDate.set($event)" class="command-input">
                            </div>
                            <div>
                              <label for="timeEntryHours" class="block text-xs font-bold uppercase tracking-wider text-ink-muted mb-1">Hours</label>
                              <input id="timeEntryHours" name="timeEntryHours" type="number" min="0.25" step="0.25" required
                                     aria-describedby="timeEntryMessage"
                                     [attr.aria-invalid]="timeEntryHoursInvalid()"
                                     [disabled]="savingTimeEntryAssignmentId() !== null"
                                     [ngModel]="timeEntryHours()" (ngModelChange)="timeEntryHours.set($event)" class="command-input font-mono tabular-nums">
                            </div>
                            <div>
                              <label for="timeEntryNotes" class="block text-xs font-bold uppercase tracking-wider text-ink-muted mb-1">Notes</label>
                              <input id="timeEntryNotes" name="timeEntryNotes" type="text"
                                     [disabled]="savingTimeEntryAssignmentId() !== null"
                                     [ngModel]="timeEntryNotes()" (ngModelChange)="timeEntryNotes.set($event)" class="command-input" placeholder="Work performed">
                            </div>
                            <div class="flex gap-2">
                              <button type="submit" data-test="submit-time-entry"
                                      [disabled]="!!timeEntryValidationMessage(assignment) || savingTimeEntryAssignmentId() !== null"
                                      class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                                {{ savingTimeEntryAssignmentId() === assignment.id ? 'Submitting…' : 'Submit' }}
                              </button>
                              <button type="button" (click)="cancelTimeEntry()"
                                      [disabled]="savingTimeEntryAssignmentId() !== null"
                                      aria-label="Cancel time entry" title="Cancel time entry"
                                      class="p-2 rounded-lg text-ink-muted hover:bg-surface-muted disabled:opacity-50"><mat-icon>close</mat-icon></button>
                            </div>
                          </div>
                          <!-- A LIVE REGION MUST EXIST BEFORE ITS CONTENT CHANGES.
                               This paragraph used to be created by an "@if" in the same
                               change-detection pass that produced its text, so screen
                               readers had nothing to observe a change on and announced
                               nothing at all — while the Submit button beside it went
                               inert. The region is now mounted for the whole life of the
                               open form and only its TEXT changes, which is the event
                               "aria-live" reports. Empty text renders no visible line.
                               "polite", not "assertive": the validation text changes on
                               every keystroke in Hours, and an assertive region would
                               interrupt the reader on each one. That deliberately
                               demotes the submission error, which used to announce by
                               being inserted as role="alert"; both messages now share
                               one region, because two live regions competing over the
                               same form is worse than a polite queue. -->
                          <p id="timeEntryMessage" data-test="time-entry-message" aria-live="polite"
                             class="mt-3 text-sm font-medium text-critical-text">{{ timeEntryValidationMessage(assignment) || timeEntrySubmissionError() }}</p>
                        </form>
                      }
                      @if (timeEntriesForAssignment(assignment.id).length) {
                        <div class="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          @for (entry of timeEntriesForAssignment(assignment.id); track entry.id) {
                            <div class="command-card-muted px-4 py-3 text-sm">
                              <div class="flex items-center justify-between gap-3">
                                <span class="font-semibold text-ink-secondary font-mono tabular-nums">{{ entry.date }} · {{ entry.hours | number:'1.0-2' }}h</span>
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
              </div>
            </div>
          </div>
        </ng-template>
      </app-list-state>
    </div>
  `
})
export class MyAssignmentsComponent {
  private api = inject(ApiService);
  // Read from the template: the read-state boundary below folds auth readiness
  // into its loading predicate, so it cannot be `private`.
  protected auth = inject(AuthService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  protected canSubmitOwnTime = computed(() => this.auth.canSubmitOwnTime());

  // The resource profile (getResource) and time-entries reads are principal-gated
  // server-side (401 until the Keycloak JWT is restored). On reload the OIDC token
  // restores async; firing the forkJoin immediately 401s and the rxResource latches
  // on the error (page shows zeros forever). Key the load on auth readiness so it
  // fires only AFTER the OAuth bootstrap has settled and the bearer token is attached.
  protected dataRes = rxResource<{ assignments: Assignment[]; requests: ResourceRequest[]; profile: Resource | null; timeEntries: TimeEntry[] }, boolean>({
    params: () => this.auth.authReady() && this.auth.hasResourceIdentity(),
    stream: ({ params: ready }) => ready
      ? forkJoin({
          assignments: this.api.getMyAssignments(),
          requests: this.api.getMyRequests(),
          profile: this.api.getMyProfile(),
          timeEntries: this.api.getMyTimeEntries(),
        })
      : of({ assignments: [], requests: [], profile: null, timeEntries: [] }),
    defaultValue: { assignments: [], requests: [], profile: null, timeEntries: [] },
  });

  myAssignments = computed(() => this.dataRes.value().assignments);
  allRequests = computed(() => this.dataRes.value().requests);
  profile = computed(() => this.dataRes.value().profile);
  timeEntries = computed(() => this.dataRes.value().timeEntries);

  viewMode = signal<'week' | 'month'>('week');
  timeEntryAssignmentId = signal<string | null>(null);
  timeEntryDate = signal(todayLocalIso());
  timeEntryHours = signal(8);
  timeEntryNotes = signal('');
  protected savingTimeEntryAssignmentId = signal<string | null>(null);
  protected timeEntrySubmissionError = signal('');
  /** Idempotency key for the current PAYLOAD; see saveTimeEntry(). */
  private timeEntrySubmissionKey: string | undefined;
  /** The payload fingerprint the key above was minted for; rotates the key when it changes. */
  private timeEntrySubmissionKeyFor: string | undefined;

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
        weekdayLabel: this.formatWeekday(date),
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

  /** Every business-day ISO inside the displayed period. Both halves of the
   *  utilization ratio are derived from this ONE list, so the numerator and the
   *  denominator can never be scoped to different windows. */
  private periodBusinessDays = computed<string[]>(() => {
    const { start, end } = this.periodRange();
    const days: string[] = [];
    for (let date = start; date <= end; date = this.addDays(date, 1)) {
      if (this.isBusinessDay(date)) days.push(this.toIso(date));
    }
    return days;
  });

  /**
   * Estimated hours booked INSIDE the displayed period — the same per-day figures
   * the table below renders, summed. Reusing `estimatedHoursForDay` is the point:
   * the tile and the grid the user is looking at can never disagree.
   */
  periodAssignedHours = computed(() => {
    const days = this.periodBusinessDays();
    let total = 0;
    for (const assignment of this.periodAssignments()) {
      for (const iso of days) total += this.estimatedHoursForDay(assignment, iso);
    }
    return this.roundHours(total);
  });

  /**
   * Utilization over the DISPLAYED PERIOD — booked hours in the period against
   * the resource's capacity for that same period.
   *
   * It used to divide LIFETIME `totalAssignedHours()` by `capacity * 4`, with the
   * comment "Assuming capacity is weekly, multiply by 4 for monthly approx". Both
   * halves were wrong and they compounded. The numerator summed every assignment
   * the person has ever held, so a consultant with six months of past bookings
   * read as catastrophically over-allocated for work already delivered; the
   * denominator was one fabricated month regardless of which week or month the
   * screen was showing, and 4 weeks is not a month (a 31-day month holds 21-23
   * business days, not 20). The figure therefore answered no question at all,
   * while sitting beside a week/month toggle and a period navigator that implied
   * it tracked them, and it drove the red/green/amber tile tint.
   *
   * `capacity` is WEEKLY hours, so the daily rate is capacity / 5 business days,
   * and the period's capacity is that rate times the business days actually in
   * the period — 5 for a week view, 20-23 for a month, from the real calendar
   * rather than a constant.
   *
   * Worked example: capacity 40 (8h/day), week view, Mon-Fri = 5 business days
   * => denominator 40h. One booking of 20h spread over that window estimates 4h
   * per day, so the numerator is 20h and the tile reads 50%. The same inputs
   * under the old formula gave 20 / (40 * 4) = 12.5% — a quarter of the truth,
   * and it would not have moved had the user paged to a different week.
   *
   * Returns 0 only when there is genuinely nothing to divide by (no profile, no
   * capacity, or a period with no business days). That is not a withheld read
   * being reported as zero: `dataRes` failing or still loading is answered by the
   * app-list-state wrapper above, which never instantiates this template.
   */
  currentUtilization = computed(() => {
    const p = this.profile();
    const businessDays = this.periodBusinessDays().length;
    if (!p || !p.capacity || businessDays === 0) return 0;
    const periodCapacity = (p.capacity / BUSINESS_DAYS_PER_WEEK) * businessDays;
    return (this.periodAssignedHours() / periodCapacity) * 100;
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

  /**
   * Identity of the submission, and it MUST match the server's discriminants
   * exactly: assignmentId, date, hours (resourceId is constant for the session).
   *
   * `notes` IS DELIBERATELY ABSENT, and including it was a duplicate-creating
   * bug. The server's dedup is entirely KEYED — `repos.timeEntries.get(entryId)`
   * — and its four-field comparison is only a guard against reusing one key for a
   * different row (`!sameEntry` -> 409). There is no content-based dedup, so a
   * NEW key with the same assignment/date/hours creates a second row with nothing
   * to stop it. With `notes` in the fingerprint the path was: submit (D, H, N1),
   * response lost after the server committed, the error message invites "review
   * the details", the user fixes a typo in the NOTES only, the fingerprint
   * changes, a new key is minted, the server finds nothing under it -> a second
   * time entry with identical date and hours. Hours double-booked on a billable
   * record, through the exact flow the message invites.
   *
   * The consequence of leaving it out is intended: on a lost response the key is
   * reused, the server returns 200 with the row it already has, and the notes edit
   * is silently dropped. A dropped typo fix beats a double-booked day, and the
   * reload on the error path surfaces what was actually recorded. Changing hours
   * or date still mints a new key, which is a genuinely different submission.
   */
  private timeEntryFingerprint(assignment: Assignment): string {
    return JSON.stringify([
      assignment.id,
      this.timeEntryDate(),
      this.timeEntryHours(),
    ]);
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

  private formatWeekday(date: Date): string {
    return new Intl.DateTimeFormat('en', { weekday: 'short' }).format(date);
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

  startTimeEntry(assignment: Assignment) {
    if (!this.canSubmitOwnTime()) return;
    this.timeEntryAssignmentId.set(assignment.id);
    this.timeEntryHours.set(Math.min(8, assignment.assignedHours || 8));
    this.timeEntryDate.set(todayLocalIso());
    this.timeEntryNotes.set('');
    this.timeEntrySubmissionError.set('');
  }

  cancelTimeEntry() {
    if (this.savingTimeEntryAssignmentId() !== null) return;
    this.timeEntryAssignmentId.set(null);
    this.timeEntrySubmissionError.set('');
    // The form is done with (submitted or abandoned): the NEXT submission is a
    // different entry and must not replay this one. A retry of the CURRENT
    // submission keeps the key, because the error path never comes through here.
    this.timeEntrySubmissionKey = undefined;
    this.timeEntrySubmissionKeyFor = undefined;
  }

  /**
   * Per-control validity, so `aria-invalid` on the two inputs and the sentence
   * the live region carries are derived from ONE source and cannot disagree —
   * marking a control invalid while the message says otherwise is the failure
   * mode that makes assistive output contradict the screen.
   */
  protected timeEntryDateInvalid = computed(() => this.parseIso(this.timeEntryDate()) === null);
  protected timeEntryHoursInvalid = computed(() => {
    const hours = this.timeEntryHours();
    return typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0;
  });

  protected timeEntryValidationMessage(assignment: Assignment): string {
    if (!assignment.id || this.timeEntryDateInvalid() || this.timeEntryHoursInvalid()) {
      return 'Enter a valid date and hours greater than zero.';
    }
    return '';
  }

  saveTimeEntry(assignment: Assignment) {
    if (!this.canSubmitOwnTime() || this.savingTimeEntryAssignmentId() !== null ||
        this.timeEntryValidationMessage(assignment)) return;

    this.savingTimeEntryAssignmentId.set(assignment.id);
    this.timeEntrySubmissionError.set('');
    // THE KEY BELONGS TO THE PAYLOAD, NOT TO THE FORM SESSION.
    //
    // The server derives the entry's id from this key, so resending the SAME
    // payload must reuse it (that is the replay dedup: a retry after a lost
    // response returns the entry already recorded instead of logging the hours
    // twice — the pending-state guard above only stops a double click in this tab).
    //
    // But the server answers 409 when a key is reused for DIFFERENT hours, and it
    // is right to: silently returning the old row would hide a lost submission. So
    // a key that never rotates turns the error message's own advice — "Review the
    // details and try again" — into a dead end: correct the hours, retry, 409,
    // forever. Rotating on a changed payload keeps both properties: same payload
    // collapses, edited payload is a new submission.
    const fingerprint = this.timeEntryFingerprint(assignment);
    if (this.timeEntrySubmissionKey === undefined || this.timeEntrySubmissionKeyFor !== fingerprint) {
      this.timeEntrySubmissionKey = globalThis.crypto?.randomUUID?.();
      this.timeEntrySubmissionKeyFor = fingerprint;
    }
    this.api.createMyTimeEntry({
      assignmentId: assignment.id,
      date: this.timeEntryDate(),
      hours: this.timeEntryHours(),
      notes: this.timeEntryNotes(),
      ...(this.timeEntrySubmissionKey ? { idempotencyKey: this.timeEntrySubmissionKey } : {}),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.savingTimeEntryAssignmentId.set(null);
        this.dataRes.reload();
        this.cancelTimeEntry();
        this.notifications.show('Time entry submitted for approval.', 'success');
      },
      error: () => {
        this.savingTimeEntryAssignmentId.set(null);
        // A response can be lost AFTER the server committed. Reload, so an entry
        // that IS already recorded appears below instead of the user being invited
        // to retry a submission that already succeeded.
        this.dataRes.reload();
        const message = 'Could not submit the time entry. Check the list below — if the entry is already there it was recorded; otherwise review the details and try again.';
        this.timeEntrySubmissionError.set(message);
        this.notifications.show(message, 'error');
      },
    });
  }

}
