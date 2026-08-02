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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import {
  AllocationApprovalItem,
  AllocationApprovalRow,
  AllocationDecisionItem,
  ApiService,
} from '../services/api.service';
import { NotificationService } from '../services/notification.service';

/** One rendered line: a project's (assignment, month) item, alongside the resource
 *  row it belongs to (needed once Task 12 renders more than one resource's rows). */
interface Line {
  row: AllocationApprovalRow;
  item: AllocationApprovalItem;
}

/**
 * Single-resource month-approval modal (B3, Task 11): one line per project
 * booked in the selected month, a checkbox per line defaulting to every
 * pending ('Requested') item, the planner's note and an editable approver
 * note, and two batch actions — Approve / Reject — over the checked lines.
 *
 * `rows` already accepts an ARRAY (a resource's row list) so Task 12's
 * multi-resource mode is a drop-in: `lines` flattens every row's items for
 * the selected month regardless of how many rows are passed. `multi` is
 * accepted for that same reason but is otherwise inert here — Task 12 owns
 * the multi-resource UI (resource grouping, "Approve & Continue") this input
 * will eventually gate.
 *
 * Server semantics this modal must respect (see decideAllocationMonths):
 * items are decided INDEPENDENTLY — a batch call can return a mix of decided
 * items and per-item errors and still be a 200. Only a month with a pending
 * approval is decidable, so non-'Requested' lines render with a disabled
 * checkbox. `decided` is emitted even when some items errored, because the
 * successful ones did land and the page's feed needs to reflect that.
 *
 * Renders its OWN full panel (header, body, footer) — same shape as
 * AllocationCalendarComponent — so the host only wraps it in the standard
 * modal backdrop + `appModal` directive.
 */
@Component({
  selector: 'app-approval-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, DecimalPipe],
  host: { class: 'contents' },
  template: `
    <div class="command-card w-full max-w-2xl max-h-[92vh] overflow-hidden flex flex-col">
      <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] flex items-start justify-between bg-gradient-to-br from-surface-muted to-transparent">
        <div>
          <h2 id="approvalModalTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] tracking-tight">{{ title() }}</h2>
          @if (selectedMonth()) {
            <p class="text-sm font-medium text-[var(--cc-muted)] mt-1.5">{{ monthLabelLong(selectedMonth()) }}</p>
          }
        </div>
        <button type="button" (click)="closed.emit()" aria-label="Close" title="Close" class="text-ink-muted hover:text-ink-secondary hover:bg-surface-muted p-2 rounded-full transition-colors">
          <mat-icon>close</mat-icon>
        </button>
      </div>

      <div class="p-6 sm:p-8 overflow-y-auto flex-1 space-y-4">
        @if (months().length > 0) {
          <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
            <span class="text-ink-muted">Open months</span>
            <select [value]="selectedMonth()" (change)="onMonthChange($event)" aria-label="Open months" class="command-select">
              @for (m of months(); track m) {
                <option [value]="m">{{ monthLabel(m) }}</option>
              }
            </select>
          </label>
        }

        @if (lines().length === 0) {
          <p class="text-sm text-ink-secondary p-6 text-center">No projects booked in this month.</p>
        } @else {
          <div class="space-y-3">
            @for (line of lines(); track line.item.assignmentMonthId) {
              <div class="rounded-lg border border-line p-3 flex flex-col gap-2" data-test="project-line">
                <div class="flex items-center gap-3">
                  <input type="checkbox" class="command-checkbox"
                         [checked]="checked().has(line.item.assignmentMonthId)"
                         [disabled]="!decidable(line.item)"
                         (change)="toggleChecked(line.item.assignmentMonthId)"
                         [attr.aria-label]="'Select ' + projectLabel(line.item)">
                  <span class="font-semibold text-ink flex-1">{{ projectLabel(line.item) }}</span>
                  <span class="font-mono tabular-nums text-sm text-ink-secondary">{{ line.item.hours | number:'1.0-1' }}h</span>
                  <span class="command-status uppercase" [class]="statusClass(line.item.status)">{{ line.item.status }}</span>
                  <button type="button" (click)="toggleNotes(line.item.assignmentMonthId)"
                          class="p-1.5 rounded-full transition-colors"
                          [class.text-caution-text]="hasNote(line.item)"
                          [class.bg-caution-tint]="hasNote(line.item)"
                          [class.text-ink-muted]="!hasNote(line.item)"
                          [attr.aria-expanded]="notesExpanded(line.item.assignmentMonthId)"
                          [attr.aria-label]="'Notes for ' + projectLabel(line.item)">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">sticky_note_2</mat-icon>
                  </button>
                </div>
                @if (notesExpanded(line.item.assignmentMonthId)) {
                  <div class="pl-9 space-y-2">
                    @if (line.item.plannerNote) {
                      <p class="text-xs text-ink-secondary"><span class="font-semibold">Planner note:</span> {{ line.item.plannerNote }}</p>
                    }
                    <label class="block text-xs font-semibold text-ink-secondary">
                      Approver note
                      <textarea rows="2" class="command-input mt-1 w-full" data-test="approver-note"
                                [ngModel]="approverNote(line.item)"
                                (ngModelChange)="setApproverNote(line.item.assignmentMonthId, $event)"
                                [attr.aria-label]="'Approver note for ' + projectLabel(line.item)"></textarea>
                    </label>
                  </div>
                }
              </div>
            }
          </div>
        }
      </div>

      <div class="p-6 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
        <button type="button" (click)="closed.emit()" class="command-button secondary">Close</button>
        <button type="button" data-test="reject-month" (click)="reject()" [disabled]="checked().size === 0"
                class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">close</mat-icon> Reject month
        </button>
        <button type="button" data-test="approve-month" (click)="approve()" [disabled]="checked().size === 0"
                class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">check</mat-icon> Approve month
        </button>
      </div>
    </div>
  `,
})
export class ApprovalModalComponent {
  private api = inject(ApiService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  /** The resource row(s) whose projects can be decided. A single-element array
   *  for this (Task 11) single-resource modal; Task 12 passes more than one. */
  readonly rows = input.required<AllocationApprovalRow[]>();
  /** Every month offered in the "Open months" selector (the feed's loaded window). */
  readonly months = input.required<string[]>();
  /** Accepted for Task 12's multi-resource mode (resource grouping, "Approve &
   *  Continue"); this modal does not build that UI yet and does not read it. */
  readonly multi = input(false);

  /** Emitted once a batch decision call has completed (even a partial one — see
   *  the class doc comment) so the host reloads its feed. */
  readonly decided = output<void>();
  /** Emitted when the user dismisses the modal without deciding anything. */
  readonly closed = output<void>();

  /** Public: driven directly by the component spec. Resets to the first offered
   *  month whenever the `months` input changes. */
  selectedMonth = linkedSignal(() => this.months()[0] ?? '');

  /** Every (row, item) pair booked in the selected month, across ALL rows. */
  protected lines = computed<Line[]>(() => {
    const month = this.selectedMonth();
    const out: Line[] = [];
    for (const row of this.rows()) {
      for (const item of row.items) {
        if (item.month === month) out.push({ row, item });
      }
    }
    return out;
  });

  /**
   * Public: the spec asserts on it directly. Checked assignmentMonthIds,
   * defaulting to every PENDING ('Requested') line of the selected month — a
   * linkedSignal so it rebuilds that default whenever the selected month (or
   * the underlying rows, e.g. after a reload) changes, while still allowing
   * the user to freely check/uncheck within the current month.
   */
  checked = linkedSignal<Line[], Set<string>>({
    source: () => this.lines(),
    computation: (lines) => new Set(lines.filter(l => this.decidable(l.item)).map(l => l.item.assignmentMonthId)),
  });

  /** In-flight approver-note edits, keyed by assignmentMonthId, before a decision is sent. */
  private approverNoteDrafts = signal<Record<string, string>>({});

  /** Which lines currently have their notes panel expanded. */
  private expandedNoteIds = signal<ReadonlySet<string>>(new Set());

  /** Modal header. Falls back to a plain "Approve month" (no dangling dash)
   *  once the target resource has dropped out of `rows` entirely — e.g. after
   *  deciding its only pending item while the page's status filter is still
   *  'Requested' ("Pending"), which removes the resource from that filtered
   *  feed. The empty `lines()` state below already explains why nothing shows. */
  protected title = computed(() => {
    const name = this.rows()[0]?.resourceName;
    return name ? `Approve month — ${name}` : 'Approve month';
  });

  protected decidable(item: AllocationApprovalItem): boolean {
    return item.status === 'Requested';
  }

  protected projectLabel(item: AllocationApprovalItem): string {
    return item.projectName ?? item.requestId;
  }

  protected toggleChecked(id: string): void {
    this.checked.update(set => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected notesExpanded(id: string): boolean {
    return this.expandedNoteIds().has(id);
  }

  protected toggleNotes(id: string): void {
    this.expandedNoteIds.update(set => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Current approver-note value for a line: an in-flight local edit if
   *  present, else the persisted item's note, else empty. */
  protected approverNote(item: AllocationApprovalItem): string {
    return this.approverNoteDrafts()[item.assignmentMonthId] ?? item.approverNote ?? '';
  }

  /** Public: the spec drives this directly. */
  setApproverNote(id: string, text: string): void {
    this.approverNoteDrafts.update(d => ({ ...d, [id]: text }));
  }

  /** RPT: the notes toggle is highlighted (non-colour-only: also a distinct
   *  tone token, not just a colour swap) once either the planner or the
   *  approver has left a note. */
  protected hasNote(item: AllocationApprovalItem): boolean {
    return !!(item.plannerNote || this.approverNote(item));
  }

  protected onMonthChange(event: Event): void {
    this.selectedMonth.set((event.target as HTMLSelectElement).value);
  }

  protected approve(): void {
    this.decide('Approved');
  }

  protected reject(): void {
    this.decide('Rejected');
  }

  /**
   * Send every checked line as one batch call. Items are decided
   * INDEPENDENTLY server-side and the call is a 200 even when some items
   * error — surface the FIRST error (if any) and still emit `decided`,
   * because the successful items did land and the host's feed must reflect
   * that rather than silently looking unchanged.
   */
  private decide(decision: 'Approved' | 'Rejected'): void {
    const ids = [...this.checked()];
    if (ids.length === 0) return;
    const drafts = this.approverNoteDrafts();
    const items: AllocationDecisionItem[] = ids.map(id => ({
      assignmentMonthId: id,
      decision,
      note: drafts[id],
    }));
    this.api.decideAllocationMonths(items)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const failed = res.results.find(r => r.status === 'Error');
          if (failed) this.notifications.error(failed.error ?? `Could not decide ${failed.assignmentMonthId}.`);
          this.decided.emit();
        },
        // Network/5xx failures are already toasted by the global error interceptor.
      });
  }

  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  protected monthLabel(month: string): string {
    return ApprovalModalComponent.MONTH_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  private static readonly MONTH_LONG_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  protected monthLabelLong(month: string): string {
    return ApprovalModalComponent.MONTH_LONG_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  /** command-status tone modifier for a month's lifecycle status — same
   *  palette as AllocationCalendarComponent's own local duplicate. */
  protected statusClass(status: AllocationApprovalItem['status']): string {
    switch (status) {
      case 'Allocated': return 'green';
      case 'Requested': return 'amber';
      case 'Rejected': return 'red';
      default: return 'neutral';
    }
  }
}
