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
import { of } from 'rxjs';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import {
  AllocationApprovalItem,
  AllocationApprovalRow,
  AllocationDecisionItem,
  ApiService,
  Resource,
  ResourceOrganization,
  SubstitutionMonthOutcome,
  SubstitutionResult,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ResourceKindBadgeComponent } from '../shared/resource-kind-badge.component';
import { countsTowardInternalCapacity, kindOf } from '../services/resource-kind.util';
import { accountableApproversOf, dimensionsOf, isTerminatedAsOf, type ScopeResource } from '../services/org-scope.util';

/** Today as ISO 'YYYY-MM-DD' — matches ResourcesComponent.isTerminated's own
 *  local helper exactly, so a candidate resource is filtered out here under
 *  the SAME rule the People page shows it terminated under. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One rendered line: a project's (assignment, month) item, alongside the resource
 *  row it belongs to (needed once Task 12 renders more than one resource's rows). */
interface Line {
  row: AllocationApprovalRow;
  item: AllocationApprovalItem;
}

/**
 * Month-approval modal (B3, Tasks 11-12): one line per project booked in the
 * selected month, a checkbox per line defaulting to every pending
 * ('Requested') item, the planner's note and an editable approver note, and
 * two batch actions — Approve / Reject — over the checked lines.
 *
 * `rows` accepts an ARRAY: a single-element array for the single-resource
 * view (Task 11), or several rows when `multi` is true (Task 12). `lines`
 * flattens every row's items for the selected month regardless of how many
 * rows are passed. In multi mode the body groups those lines back by
 * resource into one collapsible `<details>` section per row (resource name
 * as the header), and the primary action becomes "Approve & Continue"
 * (`data-test="approve-continue"`): after a decision it advances
 * `selectedMonth` to the next entry in `months()` and stays open, or emits
 * `closed` once the current month is the last one — regardless of per-item
 * errors, since the call itself completed.
 *
 * Server semantics this modal must respect (see decideAllocationMonths):
 * items are decided INDEPENDENTLY — a batch call can return a mix of decided
 * items and per-item errors and still be a 200. `decided` is emitted even when
 * some items errored, because the successful ones did land and the page's feed
 * needs to reflect that; a success toast fires only when the batch landed with
 * NO errors, and a failure reports HOW MANY items failed alongside the first
 * message (reporting only the first silently hid the rest of a batch).
 *
 * A line is decidable only when ALL THREE hold — anything else renders with a
 * disabled checkbox and a one-line reason (`blockedReason`) rather than
 * pre-checking an action the server will refuse:
 *   1. its month is 'Requested';
 *   2. it carries an `approvalId` — a month whose lifecycle row says
 *      'Requested' but has no pending approval (the shape a pre-B3 database's
 *      `backfillAssignmentMonths` leaves behind) is not decidable here;
 *   3. the current principal passes the server's per-step check (`canDecideFor`).
 * Segregation of duties is the one refusal the client CANNOT predict (the
 * approval's requester is not in the feed), which is why the batch error
 * summary still has to be honest.
 *
 * Single-mode-only UX: when a decision leaves nothing further to act on for
 * the resource(s) currently loaded (no rows at all, or no row has a
 * remaining 'Requested' item) the modal closes itself instead of sitting on
 * an empty, untitled panel — the common case is deciding a resource's last
 * pending item under the page's default Pending filter, which drops that
 * resource out of the server-filtered feed entirely. Multi mode never uses
 * this close-on-empty check; its advance-or-close rule above is the only one
 * that governs there.
 *
 * Renders its OWN full panel (header, body, footer) — same shape as
 * AllocationCalendarComponent — so the host only wraps it in the standard
 * modal backdrop + `appModal` directive.
 */
@Component({
  selector: 'app-approval-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, FormsModule, DecimalPipe, NgTemplateOutlet, ResourceKindBadgeComponent],
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
        } @else if (multi()) {
          <!-- Multi-resource mode (Task 12): one collapsible section per
               resource, the resource name as its header, its lines beneath. -->
          <div class="space-y-3">
            @for (group of resourceGroups(); track group.resourceId) {
              <details class="rounded-lg border border-line" open>
                <summary class="px-3 py-2 font-semibold text-ink cursor-pointer select-none" data-test="resource-section">
                  {{ group.resourceName }}
                </summary>
                <div class="px-3 pb-3 space-y-3">
                  @for (line of group.lines; track line.item.assignmentMonthId) {
                    <ng-container [ngTemplateOutlet]="lineRow" [ngTemplateOutletContext]="{ $implicit: line }" />
                  }
                </div>
              </details>
            }
          </div>
        } @else {
          <div class="space-y-3">
            @for (line of lines(); track line.item.assignmentMonthId) {
              <ng-container [ngTemplateOutlet]="lineRow" [ngTemplateOutletContext]="{ $implicit: line }" />
            }
          </div>
        }
      </div>

      <ng-template #lineRow let-line>
        <div class="rounded-lg border border-line p-3 flex flex-col gap-2" data-test="project-line">
          <div class="flex items-center gap-3">
            <input type="checkbox" class="command-checkbox"
                   [checked]="checked().has(line.item.assignmentMonthId)"
                   [disabled]="!decidable(line)"
                   (change)="toggleChecked(line.item.assignmentMonthId)"
                   [attr.aria-label]="'Select ' + projectLabel(line.item)">
            <span class="font-semibold text-ink flex-1">{{ projectLabel(line.item) }}</span>
            <span class="font-mono tabular-nums text-sm text-ink-secondary">{{ line.item.hours | number:'1.0-1' }}h</span>
            <span class="command-status uppercase" [class]="statusClass(line.item.status)">{{ line.item.status }}</span>
            <!-- "Correct the hours": the approver's third power alongside
                 approve/reject (spec §3.5). Deep-links into the SAME allocation
                 calendar the staffing page opens, focused on this month. -->
            <button type="button" data-test="open-calendar"
                    (click)="openCalendar.emit({ assignmentId: line.item.assignmentId, resourceName: line.row.resourceName, month: selectedMonth() })"
                    class="p-1.5 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors"
                    title="Open the allocation calendar to correct the hours"
                    [attr.aria-label]="'Open the allocation calendar for ' + projectLabel(line.item)">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">calendar_month</mat-icon>
            </button>
            <!-- Substitute (C2): only a dummy placeholder can be handed to a
                 real person — an internal/subco line never offers this. -->
            @if (line.row.kind === 'dummy') {
              <button type="button" data-test="substitute"
                      (click)="openSubstitute(line.item)"
                      class="p-1.5 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted transition-colors"
                      title="Substitute this dummy with a real person"
                      [attr.aria-label]="'Substitute ' + projectLabel(line.item)">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">person_add</mat-icon>
              </button>
            }
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
          <!-- A pending line the current actor cannot act on says WHY, instead of
               offering a checkbox whose decision the server would refuse. -->
          @if (blockedReason(line); as reason) {
            <p class="pl-9 text-xs font-medium text-caution-text flex items-center gap-1.5" data-test="line-blocked">
              <mat-icon class="text-[14px] w-[14px] h-[14px] shrink-0">lock</mat-icon>{{ reason }}
            </p>
          }
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
          <!-- Substitute panel (C2): opened per line via the button above. Only
               ONE line's panel is ever open at once (substituteTarget is a
               single signal, not a Set like the notes toggle) — heavier than a
               note, and opening a second one mid-flow would abandon whatever
               person/flag state was chosen for the first without saying so. -->
          @if (substituteTargetFor(line); as target) {
            <div class="pl-9 space-y-3 rounded-lg bg-surface-muted p-3" data-test="substitute-panel">
              <div class="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary flex-wrap">
                <mat-icon class="text-[16px] w-[16px] h-[16px] text-ink-muted">swap_horiz</mat-icon>
                <span>Substitute</span>
                <span class="text-ink">{{ target.row.resourceName }}</span>
                <app-resource-kind-badge [kind]="target.row.kind" />
                <span class="text-ink-muted">on</span>
                <span class="text-ink">{{ projectLabel(target.item) }}</span>
                <span class="text-ink-muted">—</span>
                <span class="text-ink">{{ monthLabelLong(target.item.month) }}</span>
              </div>

              @if (substitutionResult(); as result) {
                <!-- Outcome (post-confirm): the server always returns 200 — a
                     transferredHours of 0 or a skipped reason is NOT success,
                     so it renders under its own red/amber tone, never green. -->
                <div class="space-y-2">
                  @for (outcome of result.outcomes; track outcome.month) {
                    <div class="rounded-lg border border-line p-3" data-test="substitute-outcome">
                      <div class="flex items-center justify-between gap-2">
                        <span class="font-semibold text-ink text-sm">{{ monthLabel(outcome.month) }}</span>
                        <span class="command-status uppercase" [class]="outcomeStatusClass(outcome)">{{ outcomeStatusLabel(outcome) }}</span>
                      </div>
                      @if (outcome.skipped) {
                        <p class="text-xs text-ink-secondary mt-1" data-test="outcome-skipped">{{ outcome.skipped }}</p>
                      } @else {
                        <p class="text-xs text-ink-secondary mt-1" data-test="outcome-transferred">
                          Moved {{ outcome.transferredHours | number:'1.0-1' }}h to {{ result.targetResourceName }}.
                        </p>
                      }
                      @if (outcome.remainingHours > 0) {
                        <p class="text-xs text-caution-text mt-1" data-test="outcome-remaining">
                          {{ outcome.remainingHours | number:'1.0-1' }}h left on {{ target.row.resourceName }} — another person may be needed.
                        </p>
                      }
                      @if (outcome.demotedExistingWork) {
                        <p class="text-xs text-caution-text mt-1">This demoted work {{ result.targetResourceName }} already had approved that month.</p>
                      }
                    </div>
                  }
                  @if (result.outcomes.length === 0) {
                    <p class="text-xs text-critical-text">Nothing was transferred.</p>
                  }
                  <button type="button" class="command-button secondary text-xs" (click)="closeSubstitute()">Done</button>
                </div>
              } @else {
                <!-- Picker: internal, non-terminated resources only, filtered by
                     name/role text and an organization select pre-set to the
                     dummy's own organization (see defaultOrgFor) — always
                     clearable via its "All organizations" option. -->
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input type="text" [ngModel]="personFilter()" (ngModelChange)="personFilter.set($event)"
                         placeholder="Search by name or role..." aria-label="Search candidate resources"
                         data-test="substitute-search" class="command-input">
                  <!-- No [value] binding on the SELECT itself — same fix as
                       AllocationApprovalsComponent's From/To range selects
                       (regression: a [value] applied before its @for's
                       <option>s exist is silently dropped by the browser and
                       never re-applied once they do, since the bound
                       expression itself hasn't changed). [selected] on each
                       OPTION is evaluated per-option and has no such race. -->
                  <select (change)="onOrgFilterChange($event)"
                          aria-label="Filter by organization" data-test="substitute-org-filter" class="command-select">
                    <option value="" [selected]="orgFilter() === ''">All organizations</option>
                    @for (org of candidateOrganizations(); track org) {
                      <option [value]="org" [selected]="org === orgFilter()">{{ org }}</option>
                    }
                  </select>
                </div>
                <p class="mt-1 text-xs text-[var(--cc-muted)]">Includes candidates in nested organizations.</p>

                <div class="max-h-40 overflow-y-auto divide-y divide-line rounded-lg border border-line">
                  @for (cand of filteredCandidates(); track cand.id) {
                    <button type="button"
                            class="w-full text-left px-3 py-2 hover:bg-surface-muted transition-colors flex items-center justify-between gap-2"
                            [class.bg-accent-tint]="chosenTargetId() === cand.id"
                            (click)="chooseTarget(cand.id)" data-test="substitute-candidate">
                      <span><span class="font-semibold text-ink">{{ cand.name }}</span><span class="text-ink-muted"> — {{ cand.role }}</span></span>
                      @if (cand.organization) {
                        <span class="text-xs text-ink-muted shrink-0">{{ cand.organization }}</span>
                      }
                    </button>
                  }
                  @if (filteredCandidates().length === 0) {
                    <p class="p-3 text-xs text-ink-secondary text-center">No matching resources.</p>
                  }
                </div>

                @if (chosenTarget(); as person) {
                  <div class="command-card-muted p-3 text-sm space-y-2" data-test="substitute-summary">
                    <p>Hand <span class="font-semibold">{{ projectLabel(target.item) }}</span> — <span class="font-semibold">{{ monthLabelLong(target.item.month) }}</span> to <span class="font-semibold">{{ person.name }}</span>.</p>
                    <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
                      <input type="checkbox" class="command-checkbox" data-test="substitute-apply-remaining"
                             [checked]="applyToRemaining()" (change)="applyToRemaining.set(!applyToRemaining())">
                      Apply to all remaining months
                    </label>
                    <button type="button" data-test="substitute-confirm" (click)="confirmSubstitute()" class="command-button">Confirm substitution</button>
                  </div>
                }
                <button type="button" class="command-button secondary text-xs" (click)="closeSubstitute()">Cancel</button>
              }
            </div>
          }
        </div>
      </ng-template>

      <div class="p-6 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
        <button type="button" (click)="closed.emit()" class="command-button secondary">Close</button>
        <button type="button" data-test="reject-month" (click)="reject()" [disabled]="checked().size === 0"
                class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">close</mat-icon> Reject month
        </button>
        @if (multi()) {
          <button type="button" data-test="approve-continue" (click)="approve()" [disabled]="checked().size === 0"
                  class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">check</mat-icon> Approve & Continue
          </button>
        } @else {
          <button type="button" data-test="approve-month" (click)="approve()" [disabled]="checked().size === 0"
                  class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
            <mat-icon class="text-[18px] w-[18px] h-[18px]">check</mat-icon> Approve month
          </button>
        }
      </div>
    </div>
  `,
})
export class ApprovalModalComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  /** The resource row(s) whose projects can be decided. A single-element array
   *  for the single-resource view; more than one when `multi` is true. */
  readonly rows = input.required<AllocationApprovalRow[]>();
  /** Every month offered in the "Open months" selector (the feed's loaded window). */
  readonly months = input.required<string[]>();
  /** Multi-resource mode (Task 12): groups `lines()` back into one collapsible
   *  section per resource and swaps the primary action for "Approve & Continue". */
  readonly multi = input(false);

  /** Emitted once a batch decision call has completed (even a partial one — see
   *  the class doc comment) so the host reloads its feed. */
  readonly decided = output<void>();
  /** Emitted when the user dismisses the modal without deciding anything. */
  readonly closed = output<void>();
  /** Deep link to one line's allocation calendar, focused on the selected month
   *  — the approver's "correct the hours" route. The HOST opens the calendar
   *  (it owns the modal backdrop), exactly as the staffing page does. */
  readonly openCalendar = output<{ assignmentId: string; resourceName: string; month: string }>();

  /**
   * Public: driven directly by the component spec. Defaults to the first
   * offered month; when `months` changes (e.g. the host reloads its feed
   * after a decision) it keeps the CURRENTLY selected month if that month is
   * still offered, and only falls back to the first month when it is not.
   * A plain `linkedSignal(() => this.months()[0] ?? '')` would reset on every
   * reload even when the month list's VALUES are unchanged, because a fresh
   * feed response gives `months()` a new array reference each time — that
   * would silently undo multi mode's "advance to the next month" (see
   * `advanceOrClose`) the instant the host's post-decision reload lands.
   */
  selectedMonth = linkedSignal<string[], string>({
    source: () => this.months(),
    computation: (months, previous) =>
      previous && months.includes(previous.value) ? previous.value : (months[0] ?? ''),
  });

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
   * The signed-in principal, read REACTIVELY (never snapshotted at field-init —
   * see AuthService's note): until `authReady` flips true, `role()`/`userId()`
   * are the anonymous defaults, so a captured value would judge every line
   * against the wrong identity for the modal's whole life. `userId()` is a
   * RESOURCE id, the same space `AllocationApprovalRow.managerId` lives in.
   */
  private principal = computed(() => ({
    ready: this.auth.authReady(),
    role: this.auth.role(),
    resourceId: this.auth.userId(),
  }));

  /**
   * Public: the spec asserts on it directly. Checked assignmentMonthIds,
   * defaulting to every DECIDABLE line of the selected month — a linkedSignal
   * so it rebuilds that default whenever the selected month, the underlying
   * rows (e.g. after a reload) OR the principal (auth settling after a
   * deep-link) changes, while still allowing the user to freely check/uncheck
   * within the current month.
   */
  checked = linkedSignal<{ lines: Line[]; principal: unknown }, Set<string>>({
    source: () => ({ lines: this.lines(), principal: this.principal() }),
    computation: ({ lines }) => new Set(lines.filter(l => this.decidable(l)).map(l => l.item.assignmentMonthId)),
  });

  /** In-flight approver-note edits, keyed by assignmentMonthId, before a decision is sent. */
  private approverNoteDrafts = signal<Record<string, string>>({});

  /** Which lines currently have their notes panel expanded. */
  private expandedNoteIds = signal<ReadonlySet<string>>(new Set());

  /** Modal header. Falls back to a plain "Approve month" (no dangling dash)
   *  once the target resource has dropped out of `rows` entirely — e.g. after
   *  deciding its only pending item while the page's status filter is still
   *  'Requested' ("Pending"), which removes the resource from that filtered
   *  feed. The empty `lines()` state below already explains why nothing shows.
   *  In multi mode the resource name is per-section (see `resourceGroups`),
   *  so the header names the selection instead of a single resource. */
  protected title = computed(() => {
    if (this.multi()) {
      const n = this.rows().length;
      return n > 0 ? `Approve ${n} resource${n === 1 ? '' : 's'}` : 'Approve selected resources';
    }
    const name = this.rows()[0]?.resourceName;
    return name ? `Approve month — ${name}` : 'Approve month';
  });

  /** Multi-resource mode (Task 12): `lines()` regrouped by resource, in `rows()`
   *  order, so the body can render one collapsible section per resource with
   *  its own lines beneath — rather than one flat list across every resource. */
  protected resourceGroups = computed<{ resourceId: string; resourceName: string; lines: Line[] }[]>(() => {
    const byResource = new Map<string, { resourceId: string; resourceName: string; lines: Line[] }>();
    for (const line of this.lines()) {
      const { resourceId, resourceName } = line.row;
      let group = byResource.get(resourceId);
      if (!group) {
        group = { resourceId, resourceName, lines: [] };
        byResource.set(resourceId, group);
      }
      group.lines.push(line);
    }
    return [...byResource.values()];
  });

  /**
   * Mirror of the server's per-step enforcement in `decideOneApproval`
   * (src/server.ts) — D design spec §3.4. The actor may decide when:
   *   - their role is 'admin' (global, never scoped); or
   *   - they ARE the resource's manager, i.e. the step's `approverId`, compared
   *     in resource-id space (exactly what `AuthService.userId()` returns); or
   *   - they are an ACCOUNTABLE MANAGER of the resource — in its transitive
   *     `managerId` chain, or the manager of an org node above it
   *     (`accountableApproversOf`), minus anyone already terminated. This holds
   *     REGARDLESS of the actor's global role, exactly as the server's rule 2
   *     does: the node's manager IS the Capability Leader / Practice Manager /
   *     Competence Manager, and that authority is relative, not global; or
   *   - they hold the role every allocation step is routed to
   *     ('resource-manager', per `allocationApproverStep`) AND the resource has
   *     no accountable manager ANYWHERE (`roleFallback`) — a placeholder/dummy
   *     today, which is what keeps C2's substitutions actionable.
   *
   * BEFORE D this returned true for ANY `resource-manager`, which now would
   * promise the operator a button the server refuses.
   *
   * For the 'resource-manager' path it falls back to PERMISSIVE while the lists
   * are still resolving (see the note in the body): the server is the authority,
   * and disabling a line on a not-yet-loaded list would flicker a refusal that
   * isn't one.
   *
   * UX only, like the route guards — the server is the authority. It cannot
   * predict segregation of duties (the approval's requester is not in the feed),
   * which is why an accountable manager's OWN submission is auto-approved
   * server-side rather than offered here as a button they could never press.
   */
  private canDecideFor(row: AllocationApprovalRow): boolean {
    const { role, resourceId } = this.principal();
    if (role === 'admin') return true;
    if (row.managerId !== undefined && row.managerId === resourceId) return true;
    const resources = this.resources();
    // NOTE on the not-yet-loaded state, and why there is deliberately no
    // `resources.length === 0 -> true` shortcut here: `checked` is a
    // linkedSignal seeded from `decidable()` on FIRST render, and the catalogue
    // resolves after it. A blanket permissive answer would therefore PRE-CHECK
    // lines the server refuses and never un-check them (the resource list
    // arriving does not change `lines()`, so the linkedSignal does not
    // recompute). The empty-list case is handled where it belongs instead: the
    // org-chart walk resolves managers THROUGH this list, so an empty list
    // yields an empty approver set and `roleFallback` — permissive for the
    // 'resource-manager' path (the one that would otherwise flicker a refusal),
    // fail-closed for every other role, which is exactly what the server does.
    //
    // The scope target is the real resource when the catalogue has it; the row's
    // own fields are the fallback shape. `organization` is carried on the feed
    // row itself (Task 8), so even that fallback exercises BOTH axes.
    const target: ScopeResource = resources.find(r => r.id === row.resourceId)
      ?? { id: row.resourceId, managerId: row.managerId, organization: row.organization };
    const { managerIds, roleFallback } = accountableApproversOf(target, resources, this.orgNodes(), todayIso());
    if (managerIds.has(resourceId)) return true;
    return role === 'resource-manager' && roleFallback;
  }

  protected decidable(line: Line): boolean {
    return line.item.status === 'Requested'
      && !!line.item.approvalId
      && this.canDecideFor(line.row);
  }

  /**
   * Why a PENDING line cannot be decided here, or null when it can (or when it
   * is not pending at all — the status chip already says so). Rendered inline so
   * an un-actionable line is visibly un-actionable instead of failing silently
   * on submit.
   */
  protected blockedReason(line: Line): string | null {
    if (line.item.status !== 'Requested') return null;
    if (!line.item.approvalId) return 'No pending approval on this month — it cannot be decided here.';
    if (!this.canDecideFor(line.row)) return `Only ${line.row.resourceName}'s manager can decide this month.`;
    return null;
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
   * error — report the failures and still emit `decided`, because the
   * successful items did land and the host's feed must reflect that rather
   * than silently looking unchanged. A success toast fires only when NOTHING
   * errored (a partial or total failure only toasts the error).
   *
   * The error toast summarises the BATCH: with more than one failure it says
   * how many of how many failed before quoting the first message. Quoting only
   * the first message (the previous behaviour) reported one refusal out of N
   * and left the user believing the rest had gone through.
   *
   * What happens next differs by mode:
   *  - multi: always advance to the next month or close on the last one
   *    (the call completed either way — see the class doc comment).
   *  - single: close when nothing is left to decide — simulated locally from
   *    the CURRENT `rows()` plus this response's successfully-decided ids,
   *    rather than waiting on the host's async reload to feed back new rows.
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
          const failures = res.results.filter(r => r.status === 'Error');
          if (failures.length > 0) {
            const first = failures[0].error ?? `Could not decide ${failures[0].assignmentMonthId}.`;
            this.notifications.error(failures.length === 1
              ? first
              : `${failures.length} of ${res.results.length} months could not be decided. First error: ${first}`);
          } else {
            this.notifications.success(decision === 'Approved' ? 'Month approved.' : 'Month rejected.');
          }
          this.decided.emit();

          if (this.multi()) {
            this.advanceOrClose();
            return;
          }
          const decidedIds = new Set(res.results.filter(r => r.status !== 'Error').map(r => r.assignmentMonthId));
          if (this.nothingLeftAfter(decidedIds)) this.closed.emit();
        },
        // Network/5xx failures are already toasted by the global error interceptor.
      });
  }

  /** Single-mode close check: true once no row has a remaining decidable item
   *  once `decidedIds` (this response's non-error results) are accounted for —
   *  including the trivial case of no rows at all. */
  private nothingLeftAfter(decidedIds: ReadonlySet<string>): boolean {
    return this.rows().every(row =>
      row.items.every(item => decidedIds.has(item.assignmentMonthId) || !this.decidable({ row, item })));
  }

  /** Multi-mode advance rule: move to the next month in `months()`, or emit
   *  `closed` once the current month is the last one. `checked()` re-derives
   *  its default from the new month's lines automatically (it is a
   *  `linkedSignal` sourced off `lines()`, which recomputes off `selectedMonth`). */
  private advanceOrClose(): void {
    const months = this.months();
    const idx = months.indexOf(this.selectedMonth());
    if (idx === -1 || idx >= months.length - 1) {
      this.closed.emit();
      return;
    }
    this.selectedMonth.set(months[idx + 1]);
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

  // --- Substitute (C2): hand a dummy's booked month to a real person --------

  /**
   * Candidate person list. `/resources` is principal-gated exactly like the
   * approval feed itself (every role that can open this modal — resource-
   * manager, delivery-executive, admin — can also read it; see
   * docs/roles-and-permissions.md), so this is keyed on `authReady` the same
   * way `ReportingComponent` gates its own reads: never fire before the OIDC
   * bootstrap settles, or it races the token and 401s into an empty latch.
   */
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of([] as Resource[])),
    defaultValue: [] as Resource[],
  });
  private resources = computed(() => this.resourcesRes.value() ?? []);

  /**
   * D — the ORG TREE, the second axis `canDecideFor` scopes on (the first being
   * `resources`' own `managerId` chain). Loaded exactly like `resourcesRes`
   * above and keyed on the same `authReady()`: `/resource-organizations` reads
   * are open to any verified actor, but firing before the OIDC bootstrap
   * settles would still race the token and latch an empty tree — which reads as
   * "no node has a manager", i.e. silently permissive.
   */
  private orgNodesRes = rxResource<ResourceOrganization[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResourceOrganizations() : of([] as ResourceOrganization[])),
    defaultValue: [] as ResourceOrganization[],
  });
  private orgNodes = computed(() => this.orgNodesRes.value() ?? []);

  /**
   * Internal, non-terminated resources — every other filter (text,
   * organization) only narrows this set further, never widens beyond it.
   * `countsTowardInternalCapacity` is true only for 'internal' (excludes both
   * dummy and subco); termination mirrors `ResourcesComponent.isTerminated`
   * exactly (`terminationDate` set to a date on or before today).
   */
  private eligibleTargets = computed<Resource[]>(() =>
    this.resources().filter(r => countsTowardInternalCapacity(kindOf(r)) && !this.isTerminated(r)));

  private isTerminated(r: Resource): boolean {
    return isTerminatedAsOf(r, todayIso());
  }

  /** Organizations actually present among `eligibleTargets` — what the
   *  organization `<select>` offers, so a chosen filter can never produce a
   *  silently-empty list. */
  protected candidateOrganizations = computed<string[]>(() => {
    const orgs = new Set<string>();
    for (const r of this.eligibleTargets()) if (r.organization) orgs.add(r.organization);
    return [...orgs].sort();
  });

  protected personFilter = signal('');
  protected orgFilter = signal('');

  protected filteredCandidates = computed<Resource[]>(() => {
    const org = this.orgFilter();
    const q = this.personFilter().trim().toLowerCase();
    const nodes = this.orgNodes();
    return this.eligibleTargets().filter(r => {
      // The filter names ONE node, but a candidate anywhere BENEATH it belongs to
      // the same branch: compare against the DERIVED dimensions, not the stored
      // name, so a dummy on a capability still offers the practices under it.
      if (org) {
        const dims = dimensionsOf(r, nodes);
        if (dims.capability !== org && dims.practice !== org && dims.competence !== org) return false;
      }
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || r.role.toLowerCase().includes(q);
    });
  });

  protected onOrgFilterChange(event: Event): void {
    this.orgFilter.set((event.target as HTMLSelectElement).value);
  }

  /** The line whose substitute panel is open, or null. A single signal (not a
   *  Set, unlike the notes toggle): only one panel is ever open at a time,
   *  since opening a second mid-flow would silently abandon whatever
   *  person/flag was chosen for the first. */
  private substituteTarget = signal<Line | null>(null);

  /** Public: the spec drives this directly, opening the panel for one line's item.
   *  Resets EVERY piece of picker/outcome state — including `applyToRemaining` —
   *  so a flag or selection left over from a PREVIOUS line's panel can never
   *  silently carry into this one. Regression: `applyToRemaining` was originally
   *  left out of this reset, so checking "Apply to all remaining months" on one
   *  dummy line and then opening Substitute on a different line kept it checked,
   *  which would apply the transfer to months the operator never opted into. */
  openSubstitute(item: AllocationApprovalItem): void {
    const row = this.rows().find(r => r.items.some(i => i.assignmentMonthId === item.assignmentMonthId));
    if (!row) return;
    this.substituteTarget.set({ row, item });
    this.chosenTargetId.set(null);
    this.substitutionResult.set(null);
    this.personFilter.set('');
    this.orgFilter.set(this.defaultOrgFor(row));
    this.applyToRemaining.set(false);
  }

  protected closeSubstitute(): void {
    this.substituteTarget.set(null);
  }

  /** Returns the open substitute target when it's THIS line's, else null —
   *  lets the template gate the panel with `@if (...; as target)`. */
  protected substituteTargetFor(line: Line): Line | null {
    const target = this.substituteTarget();
    return target && target.item.assignmentMonthId === line.item.assignmentMonthId ? target : null;
  }

  /**
   * Ambiguity resolution: the approval row carries no organization of its
   * own, so the filter is pre-set to the DUMMY's organization, looked up by
   * `row.resourceId` in the resource list — but only when that organization
   * still has at least one eligible candidate under it; otherwise the filter
   * starts empty rather than presenting the operator an unexplained empty
   * list. The select stays clearable ("All organizations") either way.
   */
  private defaultOrgFor(row: AllocationApprovalRow): string {
    const dummy = this.resources().find(r => r.id === row.resourceId);
    const org = dummy?.organization;
    return org && this.candidateOrganizations().includes(org) ? org : '';
  }

  /** Protected, not private: the template reads it directly to highlight the
   *  selected candidate row. */
  protected chosenTargetId = signal<string | null>(null);

  /** Public: the spec drives this directly. */
  chooseTarget(id: string): void {
    this.chosenTargetId.set(id);
  }

  protected chosenTarget = computed(() => this.resources().find(r => r.id === this.chosenTargetId()));

  /** Public: the spec drives this directly (defaults to substituting just the one month). */
  applyToRemaining = signal(false);

  protected substitutionResult = signal<SubstitutionResult | null>(null);

  /**
   * Send the substitution. The endpoint always returns 200 — even when the
   * primary month's transfer failed outright, it comes back as an outcome
   * with `skipped` set rather than an HTTP error (see the class doc comment
   * and `outcomeStatusLabel`/`outcomeStatusClass` below) — so a 200 here only
   * means "render the outcomes", never "it succeeded". `decided` is emitted
   * regardless so the host's feed reflects whatever DID move.
   */
  protected confirmSubstitute(): void {
    const target = this.substituteTarget();
    const targetId = this.chosenTargetId();
    if (!target || !targetId) return;
    this.api.substituteDummyMonth(target.item.assignmentMonthId, targetId, this.applyToRemaining())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(result => {
        this.substitutionResult.set(result);
        this.decided.emit();
      });
  }

  /**
   * Tells the three outcomes apart (see the class doc comment / api.service's
   * `SubstitutionMonthOutcome`): a `skipped` reason OR zero transferred hours
   * is NOT a success regardless of the month's remaining hours — it must
   * never read the same as a full transfer.
   */
  protected outcomeStatusLabel(o: SubstitutionMonthOutcome): string {
    if (o.skipped || o.transferredHours === 0) return 'Not done';
    return o.remainingHours > 0 ? 'Partial' : 'Transferred';
  }

  /** command-status tone for `outcomeStatusLabel` — green only for a full
   *  transfer, amber for a partial one, red for skipped/zero (never green). */
  protected outcomeStatusClass(o: SubstitutionMonthOutcome): string {
    if (o.skipped || o.transferredHours === 0) return 'red';
    return o.remainingHours > 0 ? 'amber' : 'green';
  }
}
