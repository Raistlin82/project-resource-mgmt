import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import {
  exceedsDailyCapacity,
  isWorkingDay,
  monthOf,
  monthlyTargetHours,
} from '../services/calendar.util';

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
  imports: [MatIconModule, FormsModule],
  host: { class: 'contents' },
  template: `
    <div class="command-card w-full max-w-5xl max-h-[92vh] overflow-hidden flex flex-col">
      <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] flex items-start justify-between bg-gradient-to-br from-surface-muted to-transparent">
        <div>
          <h2 id="allocCalTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] tracking-tight">Calendario allocazione</h2>
          <p class="text-sm font-medium text-[var(--cc-muted)] mt-1.5 flex items-center gap-1.5">
            <mat-icon class="text-[16px] w-[16px] h-[16px]">calendar_month</mat-icon>
            {{ resourceName() || 'Risorsa' }}
            <span class="text-ink-muted">•</span>
            <span class="font-mono tabular-nums">{{ contractHoursPerDay() }}h / giorno</span>
          </p>
          <!-- The per-day capacity hint is a CLIENT check on THIS assignment only; the
               true cross-assignment total per day is validated server-side at save. -->
          <p class="text-xs text-[var(--cc-muted)] mt-2 flex items-start gap-1.5 max-w-2xl">
            <mat-icon class="text-[14px] w-[14px] h-[14px] mt-0.5 shrink-0">info</mat-icon>
            <span>L'indicatore di capacità considera solo questo incarico. Il totale giornaliero su tutti gli incarichi della risorsa è verificato dal server al salvataggio: il verde non ne garantisce l'esito.</span>
          </p>
        </div>
        <button type="button" (click)="closed.emit()" aria-label="Chiudi" title="Chiudi" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      <div class="p-6 sm:p-8 overflow-y-auto flex-1 space-y-8">
        @if (data.isLoading()) {
          <div class="p-12 text-center text-sm text-[var(--cc-muted)]">Caricamento del calendario…</div>
        } @else if (months().length === 0) {
          <div class="p-12 text-center text-sm text-[var(--cc-muted)]">
            Nessun mese disponibile: apri un periodo di pianificazione o assegna un intervallo all'incarico.
          </div>
        } @else {
          @for (month of months(); track month) {
            <section class="command-card-muted p-5">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div class="flex items-center gap-3">
                  <h3 class="font-display text-lg font-bold text-[var(--cc-ink)] capitalize">{{ monthLabel(month) }}</h3>
                  <span class="command-status uppercase" [class]="isOpen(month) ? 'green' : 'neutral'">
                    {{ isOpen(month) ? 'Aperto' : 'Chiuso' }}
                  </span>
                </div>
                <div class="flex items-center gap-3">
                  <span class="text-xs font-semibold text-ink-secondary font-mono tabular-nums"
                        [class.text-critical-text]="monthTotal(month) > monthTarget(month)">
                    {{ monthTotal(month) }}h / {{ monthTarget(month) }}h
                  </span>
                  @if (isOpen(month)) {
                    <div class="flex items-center gap-1.5">
                      <button type="button" (click)="fill(month, 1)" [attr.aria-label]="'Allocazione 100% — ' + monthLabel(month)" class="command-button secondary text-xs px-3 py-1.5">Allocazione 100%</button>
                      <button type="button" (click)="fill(month, 0.5)" [attr.aria-label]="'Allocazione 50% — ' + monthLabel(month)" class="command-button secondary text-xs px-3 py-1.5">50%</button>
                      <button type="button" (click)="clear(month)" [attr.aria-label]="'Azzera — ' + monthLabel(month)" class="command-button secondary text-xs px-3 py-1.5">Azzera</button>
                    </div>
                  }
                </div>
              </div>

              @if (!isOpen(month)) {
                <p class="text-xs font-medium text-[var(--cc-muted)] mb-4 flex items-center gap-1">
                  <mat-icon class="text-[14px] w-[14px] h-[14px]">lock</mat-icon> Mese chiuso: sola lettura.
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
                               [attr.aria-label]="'Ore del ' + dayLabel(cell.date)"
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
                             title="Oltre la capacità giornaliera">
                          <mat-icon class="text-[11px] w-[11px] h-[11px]">warning</mat-icon> oltre
                        </div>
                      }
                    </div>
                  } @else {
                    <div class="w-16 rounded-lg border border-dashed border-line bg-surface-muted p-1.5 text-center opacity-70"
                         [title]="cell.holidayName || 'Weekend'">
                      <div class="text-[11px] font-bold text-ink-muted tabular-nums">{{ cell.dom }}</div>
                      <div class="text-[9px] font-semibold text-ink-muted uppercase tracking-wide mt-1 truncate">
                        {{ cell.holidayName ? 'Festivo' : 'Weekend' }}
                      </div>
                    </div>
                  }
                }
              </div>

              @if (isOpen(month)) {
                <div class="flex justify-end mt-4 pt-4 border-t border-[var(--cc-line)]">
                  <button type="button" (click)="saveMonth(month)" [disabled]="savingMonth() === month"
                          [attr.aria-label]="'Salva mese — ' + monthLabel(month)"
                          class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">save</mat-icon>
                    {{ savingMonth() === month ? 'Salvataggio…' : 'Salva mese' }}
                  </button>
                </div>
              }
            </section>
          }
        }
      </div>

      <div class="p-6 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end">
        <button type="button" (click)="closed.emit()" class="command-button secondary">Chiudi</button>
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
  /** Emitted when the user dismisses the calendar. */
  readonly closed = output<void>();

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

  /** Which month is currently being saved (disables its Save button); null when idle. */
  protected savingMonth = signal<string | null>(null);

  protected isOpen(month: string): boolean {
    return this.data.value().periods.find(p => p.id === month)?.status === 'Open';
  }

  protected hoursFor(month: string, date: string): number {
    return this.edited()[month]?.[date] ?? 0;
  }

  protected setHours(month: string, date: string, value: number | null): void {
    const v = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    this.edited.update(map => ({ ...map, [month]: { ...(map[month] ?? {}), [date]: v } }));
  }

  /** True iff this single day's hours exceed the daily cap (client hint only). */
  protected over(month: string, date: string): boolean {
    const v = this.hoursFor(month, date);
    return v > 0 && exceedsDailyCapacity(v, this.contractHoursPerDay());
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
   * open months (and flash the "Caricamento…" placeholder, losing scroll). The
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
        },
        error: () => this.savingMonth.set(null),
      });
  }

  private saveMessage(month: string, status: string): string {
    const label = this.monthLabel(month);
    switch (status) {
      case 'Requested':
        return `Allocazione di ${label} salvata e inviata in approvazione.`;
      case 'Allocated':
        return `Allocazione di ${label} salvata (allocata).`;
      default:
        return `Allocazione di ${label} salvata.`;
    }
  }

  private static readonly MONTH_FMT = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  protected monthLabel(month: string): string {
    return AllocationCalendarComponent.MONTH_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  private static readonly DAY_FMT = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  /** Human-readable Italian date for aria-labels, e.g. '15 luglio 2026'. */
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
