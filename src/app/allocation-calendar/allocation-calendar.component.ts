import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin, of } from 'rxjs';
import {
  ApiService,
  AssignmentAllocation,
  Holiday,
  PlanningPeriod,
  type AssignmentDay,
  type AssignmentMonth,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import {
  exceedsDailyCapacity,
  isWorkingDay,
  monthOf,
  monthlyTargetHours,
} from '../services/calendar.util';
import { dailyCapFor, isMultiFteEligible, kindOf } from '../services/resource-kind.util';
import { ResourceKindBadgeComponent } from '../shared/resource-kind-badge.component';

/** The three collections the calendar loads together, keyed on the assignment. */
interface CalendarData {
  allocation: AssignmentAllocation;
  periods: PlanningPeriod[];
  holidays: Holiday[];
}

/** One calendar day cell (hours are read reactively from the edit map, not stored here). */
interface DayCell {
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  /** Day-of-month (1..31), for the cell label. */
  dom: number;
  /** True iff a weekday and not a holiday (from calendar.util) — the only allocable days. */
  working: boolean;
  /** Name of the holiday when this non-working day is a holiday (else ''); weekends read ''. */
  holidayName: string;
}

/** Fallback daily cap when the envelope reports a non-positive value (shouldn't happen). */
const DEFAULT_CAP = 8;

const EMPTY_DATA: CalendarData = {
  allocation: { assignmentId: '', contractHoursPerDay: DEFAULT_CAP, days: [] },
  periods: [],
  holidays: [],
};

/**
 * Daily allocation calendar (B1, Task 8). Given an assignment id (+ an optional
 * resource name for the header), it renders a grid of months × days for the spanned months
 * unioned with the open planning-period months. Open months are editable per-day
 * (working days only); Closed months are visible but read-only. A per-day hint marks
 * days that exceed the daily contract cap — the server enforces the true
 * cross-assignment total and the global error interceptor surfaces its message.
 *
 * Signal-first and SSR-safe: dates come from the loaded data and calendar.util does
 * all working-day/holiday math; no Date.now / argless new Date. Renders its own
 * panel (the host wraps it in the modal backdrop), so it embeds in a modal or a page.
 */
@Component({
  selector: 'app-allocation-calendar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, ResourceKindBadgeComponent],
  host: { class: 'contents' },
  template: `
    <div class="command-card w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col">
      <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] flex items-start justify-between bg-gradient-to-br from-surface-muted to-transparent">
        <div>
          <h2 id="allocCalTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] tracking-tight">Allocation calendar</h2>
          <p class="text-sm font-medium text-[var(--cc-muted)] mt-1.5 flex items-center gap-1.5">
            <mat-icon class="text-[16px] w-[16px] h-[16px]">calendar_month</mat-icon>
            {{ resourceName() || 'Resource' }}
            <app-resource-kind-badge [kind]="resourceKind()" />
            <span class="text-ink-muted">•</span>
            <span class="font-mono tabular-nums">{{ contractHoursPerDay() }}h / day</span>
          </p>
          <!-- The per-day capacity hint is a CLIENT check on THIS assignment only; the
               true cross-assignment total per day is validated server-side at save. -->
          <p class="text-xs text-[var(--cc-muted)] mt-2 flex items-start gap-1.5 max-w-2xl">
            <mat-icon class="text-[14px] w-[14px] h-[14px] mt-0.5 shrink-0">info</mat-icon>
            <span>The capacity indicator only considers this assignment. The resource's daily total across all assignments is verified by the server on save: green does not guarantee the outcome.</span>
          </p>
        </div>
        <button type="button" (click)="closed.emit()" aria-label="Close" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      <div class="p-6 sm:p-8 overflow-y-auto flex-1 space-y-8">
        @if (data.isLoading()) {
          <div class="p-12 text-center text-sm text-[var(--cc-muted)]">Loading calendar…</div>
        } @else if (months().length === 0) {
          <div class="p-12 text-center text-sm text-[var(--cc-muted)]">
            No months available: open a planning period or assign a date range to the assignment.
          </div>
        } @else {
          @for (month of months(); track month) {
            <section class="command-card-muted p-5" [attr.data-month]="month"
                     [class.ring-2]="month === focusMonth()" [class.ring-accent]="month === focusMonth()">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div class="flex items-center gap-3">
                  <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] capitalize">{{ monthLabel(month) }}</h3>
                  <span class="command-status uppercase" [class]="isOpen(month) ? 'green' : 'neutral'">
                    {{ isOpen(month) ? 'Open' : 'Closed' }}
                  </span>
                  @if (monthStatus(month); as status) {
                    <span class="command-status uppercase" [class]="monthStatusClass(status)">
                      {{ status }}
                    </span>
                  }
                  <!-- The caller's focus month (a deep link from the approvals
                       modal). Labelled, not just ringed — the ring alone would be
                       colour-only information (WCAG 1.4.1). -->
                  @if (month === focusMonth()) {
                    <span class="command-status uppercase neutral" data-test="focused-month">In review</span>
                  }
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-xs font-semibold text-ink-secondary font-mono tabular-nums"
                        [class.text-critical-text]="tracksSaturation() && monthTotal(month) > monthTarget(month)">
                    {{ monthTotal(month) }}h / {{ monthTarget(month) }}h
                  </span>
                  @if (isOpen(month)) {
                    <div class="flex items-center gap-1.5">
                      <button type="button" (click)="fill(month, 1)" [attr.aria-label]="'100% allocation — ' + monthLabel(month)" class="command-button secondary text-xs px-3 py-1.5">100% allocation</button>
                      <button type="button" (click)="fill(month, 0.5)" [attr.aria-label]="'50% allocation — ' + monthLabel(month)" class="command-button secondary text-xs px-3 py-1.5">50%</button>
                      @if (multiFteEligible()) {
                        <select data-test="fte-select"
                                [attr.aria-label]="'FTE allocation — ' + monthLabel(month)"
                                (change)="onFteSelect(month, $event)"
                                class="command-select text-xs py-1.5">
                          <option value="" selected disabled>FTE…</option>
                          @for (fte of FTE_OPTIONS; track fte) {
                            <option [value]="fte">{{ fte }} FTE</option>
                          }
                        </select>
                      }
                      <button type="button" (click)="clear(month)" [attr.aria-label]="'Clear — ' + monthLabel(month)" class="command-button secondary text-xs px-3 py-1.5">Clear</button>
                    </div>
                  }
                </div>
              </div>

              @if (!isOpen(month)) {
                <p class="text-xs font-medium text-[var(--cc-muted)] mb-4 flex items-center gap-1">
                  <mat-icon class="text-[14px] w-[14px] h-[14px]">lock</mat-icon> Month closed: read-only.
                </p>
              }

              <div class="flex flex-wrap gap-2">
                @for (cell of cellsByMonth()[month]; track cell.date) {
                  @if (cell.working) {
                    <div class="w-16 rounded-lg border p-1.5 text-center transition-colors"
                         [class.border-critical]="over(month, cell.date)"
                         [class.bg-critical-tint]="over(month, cell.date)"
                         [class.border-line]="!over(month, cell.date)"
                         [class.bg-surface]="!over(month, cell.date)">
                      <div class="text-[11px] font-bold text-ink-secondary tabular-nums">{{ cell.dom }}</div>
                      @if (isOpen(month)) {
                        <input type="number" min="0" step="0.5"
                               [ngModel]="hoursFor(month, cell.date)"
                               (ngModelChange)="setHours(month, cell.date, $event)"
                               [attr.aria-label]="'Hours for ' + dayLabel(cell.date)"
                               [attr.aria-invalid]="over(month, cell.date)"
                               [class.text-critical-text]="over(month, cell.date)"
                               class="command-input w-full text-center px-1 py-0.5 text-sm font-mono tabular-nums mt-1">
                      } @else {
                        <div class="text-sm font-mono tabular-nums mt-1 py-0.5"
                             [class.text-critical-text]="over(month, cell.date)"
                             [class.text-ink]="!over(month, cell.date)">{{ hoursFor(month, cell.date) }}</div>
                      }
                      <!-- Non-colour over-capacity signal (WCAG 1.4.1): a text+icon marker so
                           the state is perceivable without relying on the red highlight alone. -->
                      @if (over(month, cell.date)) {
                        <div class="text-[9px] font-bold text-critical-text uppercase tracking-wide flex items-center justify-center gap-0.5 mt-0.5"
                             title="Over daily capacity">
                          <mat-icon class="text-[11px] w-[11px] h-[11px]">warning</mat-icon> over
                        </div>
                      }
                    </div>
                  } @else {
                    <div class="w-16 rounded-lg border border-dashed border-line bg-surface-muted p-1.5 text-center opacity-70"
                         [title]="cell.holidayName || 'Weekend'">
                      <div class="text-[11px] font-bold text-ink-muted tabular-nums">{{ cell.dom }}</div>
                      <div class="text-[9px] font-semibold text-ink-muted uppercase tracking-wide mt-1 truncate">
                        {{ cell.holidayName ? 'Holiday' : 'Weekend' }}
                      </div>
                    </div>
                  }
                }
              </div>

              <div class="mt-4 grid gap-3 sm:grid-cols-2">
                <label class="text-xs font-semibold text-ink-secondary">
                  Note for the approver
                  <textarea rows="2" class="command-input mt-1 w-full"
                            [disabled]="!monthRow(month)"
                            [attr.aria-label]="'Note for the approver — ' + monthLabel(month)"
                            [ngModel]="plannerNoteDraft(month)"
                            (ngModelChange)="setPlannerNoteDraft(month, $event)"
                            (blur)="savePlannerNote(month)"></textarea>
                </label>
                @if (monthRow(month)?.approverNote; as approverNote) {
                  <p class="text-xs text-ink-secondary"><span class="font-semibold">Approver note:</span> {{ approverNote }}</p>
                }
              </div>

              @if (isOpen(month)) {
                <div class="flex justify-end items-center gap-3 mt-4 pt-4 border-t border-[var(--cc-line)]">
                  <button type="button" (click)="submitMonth(month)"
                          [disabled]="!canSubmit(month) || submittingMonth() === month"
                          [attr.aria-label]="'Submit month for approval — ' + monthLabel(month)"
                          class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">send</mat-icon>
                    {{ submittingMonth() === month ? 'Submitting…' : 'Submit month for approval' }}
                  </button>
                  <button type="button" (click)="saveMonth(month)" [disabled]="savingMonth() === month"
                          [attr.aria-label]="'Save month — ' + monthLabel(month)"
                          class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">save</mat-icon>
                    {{ savingMonth() === month ? 'Saving…' : 'Save month' }}
                  </button>
                </div>
              }
            </section>
          }
        }
      </div>

      <div class="p-6 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end">
        <button type="button" (click)="closed.emit()" class="command-button secondary">Close</button>
      </div>
    </div>
  `,
})
export class AllocationCalendarComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  /** The assignment whose per-day allocation is edited. */
  readonly assignmentId = input.required<string>();
  /** Resource display name for the header (optional). */
  readonly resourceName = input<string>('');
  /**
   * Optional 'YYYY-MM' the caller wants the user to land on — the approvals
   * modal's "correct the hours" deep link. Purely presentational: that month's
   * section is labelled and scrolled into view; every open month stays editable
   * exactly as before, and an unknown/absent value changes nothing.
   */
  readonly focusMonth = input<string>('');
  /** Emitted when the user dismisses the calendar. */
  readonly closed = output<void>();

  private hostEl = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The focus month already scrolled to, so a later render (e.g. editing a day)
   *  never yanks the viewport back. */
  private scrolledTo = '';

  constructor() {
    // Bring the deep link's month into view once its section has ACTUALLY
    // rendered — the sections only exist after the async load resolves, so this
    // cannot be a one-shot afterNextRender. `afterRenderEffect` re-runs on the
    // signals it reads and never runs on the server, so this stays SSR-safe.
    afterRenderEffect(() => {
      const month = this.focusMonth();
      // Read reactively so the effect re-runs when the load resolves.
      const known = this.months().includes(month);
      if (!month || !known || month === this.scrolledTo) return;
      const el = this.hostEl.nativeElement.querySelector(`[data-month="${month}"]`);
      if (!el) return;
      this.scrolledTo = month;
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  // Principal-gated reads (allocation/planning-periods) 401 until the OIDC bootstrap
  // settles — key the load on authReady AND the assignment id so it fires with a
  // bearer and reloads if the target assignment changes.
  protected data = rxResource<CalendarData, { ready: boolean; id: string }>({
    params: () => ({ ready: this.auth.authReady(), id: this.assignmentId() }),
    stream: ({ params }) => (params.ready && params.id
      ? forkJoin({
          allocation: this.api.getAssignmentAllocation(params.id),
          periods: this.api.getPlanningPeriods(),
          holidays: this.api.getHolidays(),
        })
      : of(EMPTY_DATA)),
    defaultValue: EMPTY_DATA,
  });

  /** Effective daily contract cap from the envelope (guarded to a positive number). */
  protected contractHoursPerDay = computed(() => {
    const cap = this.data.value().allocation.contractHoursPerDay;
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP;
  });

  /**
   * Raw resource kind from the envelope (C1) — absent for a pre-C1 client/
   * fixture. Consumed only through `kindOf()` below (never compared to
   * directly), so an absent/unknown value safely resolves to 'internal'.
   */
  protected resourceKind = computed(() => this.data.value().allocation.resourceKind);

  /** Normalized kind (`kindOf` defaults an absent/unknown value to 'internal'). */
  protected kind = computed(() => kindOf({ kind: this.resourceKind() }));

  /** True iff this resource may be planned beyond 1 FTE (dummy/subco) — gates
   *  the FTE selector in the template. */
  protected multiFteEligible = computed(() => isMultiFteEligible(this.kind()));

  /**
   * True iff the month header's total-vs-target comparison is a meaningful
   * saturation judgement — 'internal' only, same split
   * `AllocationApprovalsComponent.toCellVm` already uses for the equivalent
   * misreport on the approvals dashboard (manual §4.3: dummy/subco have no
   * capacity to saturate). `monthTarget()` stays the 1-FTE-equivalent base
   * (there is no natural "target" for a placeholder planned at N FTE), so
   * WITHOUT this gate a legitimate multi-FTE dummy/subco booking would tint
   * the header's total red even though the per-day cells (via `dailyCap`)
   * correctly show no over-capacity flag — the numbers are still shown
   * plainly, just not judged.
   */
  protected tracksSaturation = computed(() => this.kind() === 'internal');

  /**
   * Effective daily hours ceiling for the per-day capacity hint (`over()`).
   * C1 carry-forward: Task 4 widened the SERVER's daily cap for dummy/subco
   * (`dailyCapFor`) so a multi-FTE booking is legal, but this component was
   * still judging every day against the un-widened `contractHoursPerDay` — a
   * legitimate 2.5-FTE dummy booking (20h/day on an 8h/day base) was flagged
   * red as over-capacity in the very screen used to enter it. Only THIS hint
   * is widened; `contractHoursPerDay` itself (and `fill`'s per-FTE unit)
   * stays the 1-FTE base that `applyFte` multiplies.
   */
  protected dailyCap = computed(() => dailyCapFor(this.kind(), this.contractHoursPerDay()));

  private holidaysSet = computed(() => new Set(this.data.value().holidays.map(h => h.id)));
  private holidayNames = computed(() => new Map(this.data.value().holidays.map(h => [h.id, h.name])));

  /**
   * Months to render: the assignment's spanned months (from its day rows) unioned
   * with every OPEN planning-period month, ascending. Closed months only appear when
   * they already carry days (spanned); open months always show so they can be filled.
   */
  protected months = computed(() => {
    const d = this.data.value();
    const set = new Set(d.allocation.days.map(x => monthOf(x.date)));
    for (const p of d.periods) if (p.status === 'Open') set.add(p.id);
    return Array.from(set).sort();
  });

  /** Day cells per month (weekday/holiday classification via calendar.util; hours read separately). */
  protected cellsByMonth = computed<Record<string, DayCell[]>>(() => {
    const holidays = this.holidaysSet();
    const names = this.holidayNames();
    const out: Record<string, DayCell[]> = {};
    for (const month of this.months()) {
      out[month] = this.datesOfMonth(month).map(date => {
        const working = isWorkingDay(date, holidays);
        return { date, dom: Number(date.slice(8, 10)), working, holidayName: !working ? (names.get(date) ?? '') : '' };
      });
    }
    return out;
  });

  /**
   * Editable per-day hours as month -> (date -> hours). A linkedSignal so it rebuilds
   * from server truth on every (re)load — after a save the reload discards local edits
   * in favour of the persisted rows.
   */
  protected edited = linkedSignal<AssignmentDay[], Record<string, Record<string, number>>>({
    source: () => this.data.value().allocation.days,
    computation: (days) => {
      const map: Record<string, Record<string, number>> = {};
      for (const d of days) (map[monthOf(d.date)] ??= {})[d.date] = d.hours;
      return map;
    },
  });

  /**
   * Per-month lifecycle rows (B3), keyed by month — deliberately a SEPARATE
   * linkedSignal from `data`, not a plain read of `data.value().allocation.months`.
   * `linkedSignal.computation` always re-runs in FULL whenever `source()` is
   * merely marked dirty (it diffs the computed OUTPUT, never the source value —
   * see Angular's `LinkedSignalNode.producerRecomputeValue`), so patching a row
   * through `data.update()`, even leaving `allocation.days`'s array reference
   * untouched, would still force `edited` above to rebuild from scratch and
   * wipe every OTHER open month's unsaved hour edits. Keeping this map on its
   * own signal means `patchMonthRow` never touches `data` at all, so `edited`
   * is only ever rebuilt on a genuine full (re)load.
   */
  protected monthRows = linkedSignal<AssignmentMonth[], Record<string, AssignmentMonth>>({
    source: () => this.data.value().allocation.months ?? [],
    computation: (months) => Object.fromEntries(months.map(m => [m.month, m])),
  });

  /** Which month is currently being saved (disables its Save button); null when idle. */
  protected savingMonth = signal<string | null>(null);
  /** Which month is currently being submitted for approval; null when idle. */
  protected submittingMonth = signal<string | null>(null);
  /** In-flight planner-note edits, keyed by month, before they are blurred to the server. */
  private plannerNoteDrafts = signal<Record<string, string>>({});

  protected isOpen(month: string): boolean {
    return this.data.value().periods.find(p => p.id === month)?.status === 'Open';
  }

  /** Lifecycle row of a month, when the assignment has one (created on first save). */
  protected monthRow = (month: string): AssignmentMonth | undefined => this.monthRows()[month];

  protected monthStatus = (month: string): AssignmentMonth['status'] | undefined => this.monthRow(month)?.status;

  /** A month may be submitted when it exists, its planning period is open, and it is
   *  not already pending approval or already approved (Draft/Rejected only). */
  protected canSubmit = (month: string): boolean => {
    const status = this.monthStatus(month);
    return this.isOpen(month) && (status === 'Draft' || status === 'Rejected');
  };

  /** command-status tone modifier for a month's lifecycle status (same palette as
   *  the assignment-level status chip: Draft neutral, Requested amber, Allocated
   *  green, Rejected red). */
  protected monthStatusClass(status: AssignmentMonth['status']): string {
    switch (status) {
      case 'Allocated': return 'green';
      case 'Requested': return 'amber';
      case 'Rejected': return 'red';
      default: return 'neutral';
    }
  }

  /** Current planner-note value for a month: an in-flight local edit if present,
   *  else the persisted row's note, else empty (row may not exist yet). */
  protected plannerNoteDraft(month: string): string {
    return this.plannerNoteDrafts()[month] ?? this.monthRow(month)?.plannerNote ?? '';
  }

  protected setPlannerNoteDraft(month: string, value: string): void {
    this.plannerNoteDrafts.update(d => ({ ...d, [month]: value }));
  }

  /** Persist the planner note on blur — only when the month row already exists
   *  (the server 404s otherwise, mirroring the RPT rule that a note can only be
   *  saved once the month has been drafted) and only when it actually changed.
   *  The endpoint returns the updated row directly, so it is patched straight
   *  into `monthRows` (see patchMonthRow) rather than a full `data.reload()`,
   *  which would flash the whole calendar back to its loading placeholder and
   *  wipe any unsaved hour edits in OTHER open months — the same concern
   *  `saveMonth` documents below. */
  protected savePlannerNote(month: string): void {
    const row = this.monthRow(month);
    const draft = this.plannerNoteDraft(month);
    if (!row || draft === (row.plannerNote ?? '')) return;
    this.api.setAssignmentMonthNote(this.assignmentId(), month, draft)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: updated => this.patchMonthRow(updated),
        error: () => { /* the global error interceptor surfaces the message */ },
      });
  }

  /**
   * Submit a Draft/Rejected month for approval. The server may hand back either
   * 'Requested' (a manager approval was created) or 'Allocated' (the proposer IS
   * the resource's manager, so the request is auto-approved on the spot) — the
   * success message reflects whichever actually came back rather than assuming
   * 'Requested', so it never claims a pending approval that didn't happen. Like
   * savePlannerNote, the response IS the updated row, so it is patched directly
   * into `monthRows` — no full `data.reload()` (see saveMonth's doc comment for why).
   */
  protected submitMonth(month: string): void {
    if (this.submittingMonth() !== null) return;
    this.submittingMonth.set(month);
    this.api.submitAssignmentMonth(this.assignmentId(), month, this.plannerNoteDraft(month) || undefined)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: row => {
          this.submittingMonth.set(null);
          const label = this.monthLabel(month);
          this.notifications.show(
            row.status === 'Allocated' ? `${label} allocated (self-managed, no approval needed).` : `${label} submitted for approval.`,
            'success',
          );
          this.patchMonthRow(row);
        },
        error: () => this.submittingMonth.set(null),
      });
  }

  protected hoursFor(month: string, date: string): number {
    return this.edited()[month]?.[date] ?? 0;
  }

  protected setHours(month: string, date: string, value: number | null): void {
    const v = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    this.edited.update(map => ({ ...map, [month]: { ...(map[month] ?? {}), [date]: v } }));
  }

  /**
   * Test seam: a month's pending per-day hour edits (date -> hours), as
   * currently held in the `edited` edit-map signal — not necessarily saved
   * yet. Exposed narrowly for the component spec rather than reaching into
   * `edited` directly. Public (no access modifier) so the spec can call it,
   * matching this codebase's convention for test-exposed members (e.g.
   * `AllocationApprovalsComponent.selectedResourceIds`).
   */
  editedHours(month: string): Record<string, number> {
    return this.edited()[month] ?? {};
  }

  /** True iff this single day's hours exceed the daily cap (client hint only).
   *  Compares against `dailyCap()` (widened for dummy/subco), not
   *  `contractHoursPerDay()` directly — see `dailyCap`'s doc comment. */
  protected over(month: string, date: string): boolean {
    const v = this.hoursFor(month, date);
    return v > 0 && exceedsDailyCapacity(v, this.dailyCap());
  }

  protected monthTarget(month: string): number {
    return monthlyTargetHours(this.contractHoursPerDay(), month, this.holidaysSet());
  }

  protected monthTotal(month: string): number {
    let sum = 0;
    for (const cell of this.cellsByMonth()[month] ?? []) {
      if (cell.working) sum += this.hoursFor(month, cell.date);
    }
    return Math.round(sum * 100) / 100;
  }

  /** Fill every working day of an open month with `cap × fraction` (100% / 50%). */
  protected fill(month: string, fraction: number): void {
    if (!this.isOpen(month)) return;
    const hours = Math.round(this.contractHoursPerDay() * fraction * 100) / 100;
    this.edited.update(map => {
      const next = { ...(map[month] ?? {}) };
      for (const cell of this.cellsByMonth()[month] ?? []) if (cell.working) next[cell.date] = hours;
      return { ...map, [month]: next };
    });
  }

  /** Manual's multi-FTE steps in usable increments (§3.2.3/§3.2.5) — offered
   *  by the FTE `<select>` (dummy/subco only). */
  protected readonly FTE_OPTIONS: readonly number[] = [1, 1.5, 2, 2.5, 3, 4, 5, 10, 20, 30];

  /**
   * Fill every working day of an open month with `fte` FTE-equivalent hours.
   * Built on top of `fill` rather than duplicating its working-day walk: an
   * FTE value beyond 1 is just a larger fraction of the same 1-FTE contracted-
   * hours unit `fill(month, 1)` / `fill(month, 0.5)` already use (`fill`
   * already computes `cap × fraction`, and a fraction > 1 is exactly what an
   * FTE > 1 is). Dummy/subco only — gated in the template by
   * `multiFteEligible()`; the server already accepts the result (Task 4's
   * `dailyCapFor` cap). Public (no access modifier) so the component spec can
   * call it directly, matching `editedHours` above.
   */
  applyFte(month: string, fte: number): void {
    this.fill(month, fte);
  }

  /** `<select data-test="fte-select">`'s (change) handler. */
  protected onFteSelect(month: string, event: Event): void {
    const value = Number((event.target as HTMLSelectElement).value);
    if (Number.isFinite(value) && value > 0) this.applyFte(month, value);
  }

  /** Zero every working day of an open month. */
  protected clear(month: string): void {
    if (!this.isOpen(month)) return;
    this.edited.update(map => {
      const next = { ...(map[month] ?? {}) };
      for (const cell of this.cellsByMonth()[month] ?? []) if (cell.working) next[cell.date] = 0;
      return { ...map, [month]: next };
    });
  }

  /**
   * Persist one month. Sends every working day's hours (0 removes the row server-side).
   * On success it patches ONLY the saved month in `edited` from the response's
   * day rows (server-truth) — deliberately NOT a global `data.reload()`, which would
   * reset the `edited` linkedSignal for EVERY month and wipe unsaved edits in other
   * open months (and flash the "Loading calendar…" placeholder, losing scroll). The
   * resulting status is surfaced (an edit to an Allocated assignment demotes it to
   * Requested for re-approval unless self-managed). On error the global error
   * interceptor already toasts the server message (which names the offending date on
   * a capacity 400), so we only clear the in-flight flag here.
   */
  protected saveMonth(month: string): void {
    if (this.savingMonth() !== null) return;
    const id = this.assignmentId();
    const dailyHours: Record<string, number> = {};
    for (const cell of this.cellsByMonth()[month] ?? []) {
      if (cell.working) dailyHours[cell.date] = this.hoursFor(month, cell.date);
    }
    this.savingMonth.set(month);
    this.api.saveAssignmentAllocation(id, month, dailyHours)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.savingMonth.set(null);
          // Server-truth for THIS month only (0-hour days are dropped server-side).
          // Replace just this month's slice; sibling months keep their local edits.
          const persisted: Record<string, number> = {};
          for (const d of result.days) persisted[d.date] = d.hours;
          this.edited.update(map => ({ ...map, [month]: persisted }));
          this.notifications.show(this.saveMessage(month, result.status), 'success');
          // `result.status` above is the ASSIGNMENT's derived rollup, not this
          // month's own lifecycle row (B3) — the save may have just lazily
          // created a Draft row (first booking in this month) or demoted an
          // Allocated row to Requested, and either way the badge/Submit button
          // read `data.value().allocation.months`, which this response does not
          // carry. Refresh that one row (see refreshMonthRow) instead of a full
          // `data.reload()`, which would discard `edited`'s in-flight state.
          this.refreshMonthRow(month);
        },
        error: () => this.savingMonth.set(null),
      });
  }

  /**
   * saveAssignmentAllocation's response carries only the ASSIGNMENT's derived
   * rollup, not the saved month's own lifecycle row, so — unlike submitMonth /
   * savePlannerNote, which already get the fresh row back directly — a save
   * needs its own narrow re-read to learn it (e.g. the lazily-created Draft row
   * on a month's first booking). Best-effort: on failure the badge simply stays
   * as it was until the next patch.
   */
  private refreshMonthRow(month: string): void {
    this.api.getAssignmentAllocation(this.assignmentId(), month, month)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: fresh => {
          const row = fresh.months?.find(m => m.month === month);
          if (row) this.patchMonthRow(row);
        },
        error: () => { /* best-effort refresh; the badge just stays stale until the next reload */ },
      });
  }

  /**
   * Merge one fresh month row into `monthRows` — NOT into `data` (see
   * `monthRows`'s doc comment for why: touching `data` at all, even leaving
   * `allocation.days` untouched, would force `edited` to rebuild from scratch
   * and wipe every other open month's unsaved hour edits). This is the ONLY
   * way this component updates a month's lifecycle state; it never calls a
   * full `data.reload()`, which would additionally flash the whole calendar
   * back to its loading placeholder.
   */
  private patchMonthRow(row: AssignmentMonth): void {
    this.monthRows.update(map => ({ ...map, [row.month]: row }));
  }

  private saveMessage(month: string, status: string): string {
    const label = this.monthLabel(month);
    switch (status) {
      case 'Requested':
        return `${label} allocation saved and submitted for approval.`;
      case 'Allocated':
        return `${label} allocation saved (allocated).`;
      default:
        return `${label} allocation saved.`;
    }
  }

  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  protected monthLabel(month: string): string {
    return AllocationCalendarComponent.MONTH_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  private static readonly DAY_FMT = new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  /** Human-readable date for aria-labels, e.g. 'July 15, 2026'. */
  protected dayLabel(date: string): string {
    return AllocationCalendarComponent.DAY_FMT.format(new Date(date + 'T00:00:00Z'));
  }

  /** All ISO dates of a 'YYYY-MM' month, ascending. Layout enumeration only —
   *  weekend/holiday classification is left to calendar.util's isWorkingDay. */
  private datesOfMonth(month: string): string[] {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based → day 0 of next month
    const out: string[] = [];
    for (let day = 1; day <= days; day++) out.push(`${month}-${String(day).padStart(2, '0')}`);
    return out;
  }
}
