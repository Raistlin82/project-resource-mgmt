import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import {
  ApiService,
  ApprovalKind,
  ApprovalRequest,
  Assignment,
  Project,
  Resource,
  ResourceOrganization,
  User,
  UserRole,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ListStateComponent } from '../shared/list-state.component';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { parseMonthRowId } from '../services/allocation-month.util';
import { accountableApproversOf } from '../services/org-scope.util';
import { todayLocalIso } from '../services/local-date.util';

/** Today as ISO 'YYYY-MM-DD'. The org-scope layer is pure and takes this as a
 *  value, so the clock read lives here — same helper as the other screens. */
function todayIso(): string {
  return todayLocalIso();
}

interface ApprovalsData {
  approvals: ApprovalRequest[];
  projects: Project[];
  resources: Resource[];
  users: User[];
  /** D: an Allocation approval's `refId` addresses a month ROW, so the target
   *  resource is only reachable through its assignment — see `scopeAllows`. */
  assignments: Assignment[];
  /** D: the second scope axis (the capability > practice > competence tree). */
  orgNodes: ResourceOrganization[];
}

/** A row enriched with derived, display-ready labels and SoD/authorization flags. */
interface ApprovalRow {
  request: ApprovalRequest;
  kind: ApprovalKind;
  reference: string;
  /** Human, kind-aware description (used for Allocation, which has an opaque refId). */
  label: string;
  projectLabel: string;
  amount?: number;
  requestedByLabel: string;
  stepLabel: string;
  currentRole?: string;
  stepRoleLabel: string;
  slaDueAt?: string;
  overdue: boolean;
  /** Pending AND the current step is awaiting the signed-in user's role. */
  approvable: boolean;
  /** The requester can never decide their own item (segregation of duties). */
  selfRequested: boolean;
  /** D: the actor DOES hold the step's role but the resource is outside their org
   *  scope. Kept apart from `!approvable` so the tooltip does not tell a resource
   *  manager they are "awaiting Resource Manager approval" — the same reason the
   *  server words its two 403s differently. */
  outOfScope: boolean;
  /** Final guard for the Approve/Reject buttons (pending + role match + not self). */
  canDecide: boolean;
}

interface DecisionDraft {
  row: ApprovalRow;
  decision: 'Approved' | 'Rejected';
}

/** The single empty value for both the pre-`authReady` stream and the default,
 *  so the two can never drift as fields are added to `ApprovalsData`. */
const EMPTY_DATA: ApprovalsData = { approvals: [], projects: [], resources: [], users: [], assignments: [], orgNodes: [] };

/** D: the out-of-scope tooltip. Deliberately does NOT name the resource's
 *  managers or its org node — the same leak the server's scope 403 avoids. */
const OUT_OF_SCOPE_TITLE = 'You do not manage this resource, so you cannot decide its allocation';

/**
 * APPROVALS INBOX — surfaces every approval request whose current workflow step
 * is awaiting the signed-in user's role, with explicit Segregation-of-Duties
 * enforcement: a requester can never approve their own item. The server is the
 * authority (it re-checks SoD and role on /decision); this UI mirrors those
 * rules so the affordances never invite a request the server would reject.
 */
@Component({
  selector: 'app-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CurrencyPipe, DatePipe, RouterLink, MatIconModule, ListStateComponent, ModalDialogDirective],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Approvals Inbox</h1>
          <p class="text-[var(--cc-muted)] mt-2 text-sm">
            Review and decide items awaiting your sign-off across time, expenses, milestones, changes, and invoices.
          </p>
        </div>
        <!-- UX register P2-09: the pressed segment used to be marked by
             background/shadow/ink classes ONLY, so the control announced its
             selection to nobody — a screen-reader user met two identically
             named buttons with no way to tell which view was showing.
             aria-pressed goes on BOTH segments, never only on the pressed one:
             the attribute's ABSENCE is not the same statement as "false", and a
             control that carries it on one button only reads as a single
             stateful toggle rather than a two-option choice. Bound off the same
             filter() the classes read, so the two can never disagree. -->
        <div class="command-card-muted p-1 grid grid-cols-2 items-center w-full sm:w-auto self-start sm:self-auto">
          <button type="button" (click)="filter.set('mine')" data-test="filter-mine"
                  [attr.aria-pressed]="filter() === 'mine'"
                  [class.bg-surface]="filter() === 'mine'"
                  [class.shadow-sm]="filter() === 'mine'"
                  [class.text-ink]="filter() === 'mine'"
                  [class.text-ink-muted]="filter() !== 'mine'"
                  class="min-w-0 px-3 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out flex items-center justify-center gap-2">
            My inbox
            <!-- The count is the ONLY figure on this screen that renders OUTSIDE
                 the read-state wrapper below, so it needs its own answer for the
                 two non-resolved states — the wrapper cannot cover a figure that
                 is not inside it. null covers both: an em dash says "not known
                 yet", where the 0 this printed before was a claim that nothing
                 awaits this user's sign-off, read and acted on (navigate away)
                 before the read had been made.
                 The dash carries an sr-only sibling rather than an aria-label:
                 this is a <span> (role=generic), where aria-label is discarded —
                 same trap, and same remedy, as list-state.component.ts:50. -->
            <span class="command-status">
              @if (mineCount() === null) {
                <span class="sr-only">Inbox count not loaded yet</span>
                <span aria-hidden="true">&mdash;</span>
              } @else {
                {{ mineCount() }}
              }
            </span>
          </button>
          <button type="button" (click)="filter.set('all')" data-test="filter-all"
                  [attr.aria-pressed]="filter() === 'all'"
                  [class.bg-surface]="filter() === 'all'"
                  [class.shadow-sm]="filter() === 'all'"
                  [class.text-ink]="filter() === 'all'"
                  [class.text-ink-muted]="filter() !== 'all'"
                  class="min-w-0 px-3 sm:px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
            All pending
          </button>
        </div>
      </div>

      <!-- [loading] folds auth readiness — see listLoading(). -->
      <app-list-state [loading]="listLoading()" [error]="res.status() === 'error'"
                      skeleton="cards" [rows]="4" label="approvals" (retry)="res.reload()">
      <ng-template>
      <!-- At narrow widths and under browser zoom the nine-column table turns
           into cards below. Keeping the table for lg+ preserves fast scanning,
           while the breakpoint makes zoom reflow instead of creating a two-axis
           pan whose action column is permanently off-screen. -->
      <div data-test="approvals-desktop" class="hidden 2xl:block command-card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="command-data-table min-w-[960px]">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Reference</th>
                <th scope="col">Project</th>
                <th scope="col" class="text-right">Amount</th>
                <th scope="col">Requested by</th>
                <th scope="col">Current step</th>
                <th scope="col">SLA</th>
                <th scope="col">Status</th>
                <th scope="col" class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-[var(--cc-line)]">
              @for (row of rows(); track row.request.id) {
                <tr class="transition-colors">
                  <td>
                    <span class="command-chip is-neutral">
                      <mat-icon class="text-[16px] w-[16px] h-[16px]">{{ kindIcon(row.kind) }}</mat-icon>
                      {{ row.kind }}
                    </span>
                  </td>
                  <td>
                    @if (row.kind === 'Allocation') {
                      <div class="font-semibold text-[var(--cc-ink)]">{{ row.label }}</div>
                      <div class="text-xs font-mono tabular-nums text-[var(--cc-muted)] mt-0.5">{{ row.reference }}</div>
                      <a routerLink="/allocation-approvals" class="text-xs text-accent-text hover:underline transition-colors">Open monthly approvals</a>
                    } @else {
                      <span class="font-mono tabular-nums">{{ row.reference }}</span>
                    }
                  </td>
                  <td><span class="text-[var(--cc-muted)]">{{ row.projectLabel }}</span></td>
                  <td class="text-right font-semibold">
                    @if (row.amount !== undefined) {
                      {{ row.amount | currency:'EUR':'symbol':'1.0-0' }}
                    } @else {
                      <span class="text-ink-muted">&mdash;</span>
                    }
                  </td>
                  <td><span class="text-[var(--cc-muted)]">{{ row.requestedByLabel }}</span></td>
                  <td>
                    <div class="text-[var(--cc-ink)] font-semibold">{{ row.stepRoleLabel }}</div>
                    <div class="text-xs font-medium text-[var(--cc-muted)] mt-0.5">{{ row.stepLabel }}</div>
                  </td>
                  <td>
                    @if (row.slaDueAt) {
                      <div class="flex flex-col gap-1">
                        <span class="font-mono tabular-nums text-xs text-[var(--cc-muted)]">{{ row.slaDueAt | date:'mediumDate' }}</span>
                        @if (row.overdue) {
                          <span class="command-status red self-start">
                            <mat-icon class="text-[13px] w-[13px] h-[13px]">schedule</mat-icon> Overdue
                          </span>
                        } @else {
                          <span class="command-status green self-start">On track</span>
                        }
                      </div>
                    } @else {
                      <span class="text-ink-muted">&mdash;</span>
                    }
                  </td>
                  <td>
                    <span class="command-status"
                          [class.amber]="row.request.status === 'Pending'"
                          [class.green]="row.request.status === 'Approved'"
                          [class.red]="row.request.status === 'Rejected'">
                      {{ row.request.status }}
                    </span>
                  </td>
                  <td class="text-right">
                    @if (row.request.status === 'Pending') {
                      <div class="inline-flex items-center gap-2 justify-end">
                        <button type="button"
                                data-test="approval-approve"
                                [attr.data-request-id]="row.request.id"
                                (click)="requestDecision(row, 'Approved')"
                                [disabled]="!row.canDecide || pendingId() === row.request.id"
                                [title]="approveTitle(row)"
                                [attr.aria-label]="approveTitle(row)"
                                class="p-2 rounded-lg text-ink-muted enabled:hover:text-positive-text enabled:hover:bg-positive-tint transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">check_circle</mat-icon>
                        </button>
                        <button type="button"
                                data-test="approval-reject"
                                [attr.data-request-id]="row.request.id"
                                (click)="requestDecision(row, 'Rejected')"
                                [disabled]="!row.canDecide || pendingId() === row.request.id"
                                [title]="rejectTitle(row)"
                                [attr.aria-label]="rejectTitle(row)"
                                class="p-2 rounded-lg text-ink-muted enabled:hover:text-critical-text enabled:hover:bg-critical-tint transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">cancel</mat-icon>
                        </button>
                      </div>
                    } @else {
                      <span class="text-xs font-medium text-[var(--cc-muted)]">Decided</span>
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="9" class="text-center text-[var(--cc-muted)]">
                    <div class="flex flex-col items-center justify-center px-6 py-16">
                      <mat-icon class="text-4xl mb-3 opacity-50">inbox</mat-icon>
                      <p class="font-medium text-ink-secondary">
                        {{ filter() === 'mine' ? 'Your inbox is clear.' : 'No pending approvals.' }}
                      </p>
                      <p class="text-sm mt-1">
                        {{ filter() === 'mine' ? 'Nothing is waiting on your sign-off right now.' : 'There are no approval requests awaiting a decision.' }}
                      </p>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>

      <section data-test="approvals-mobile" aria-label="Approval requests" class="space-y-3 2xl:hidden">
        @for (row of rows(); track row.request.id) {
          <article class="command-card p-4 sm:p-5 space-y-4 min-w-0"
                   [attr.aria-labelledby]="'approval-card-title-' + row.request.id"
                   [attr.data-request-id]="row.request.id">
            <div class="flex items-start justify-between gap-3 min-w-0">
              <div class="min-w-0">
                <span class="command-chip is-neutral mb-2">
                  <mat-icon class="text-[16px] w-[16px] h-[16px]">{{ kindIcon(row.kind) }}</mat-icon>
                  {{ row.kind }}
                </span>
                <h2 [id]="'approval-card-title-' + row.request.id"
                    class="font-display text-base font-bold text-[var(--cc-ink)] break-words">
                  {{ row.label }}
                </h2>
                <p class="mt-1 text-xs font-mono tabular-nums text-[var(--cc-muted)] break-all">{{ row.reference }}</p>
                @if (row.kind === 'Allocation') {
                  <a routerLink="/allocation-approvals" class="mt-1 inline-block text-xs text-accent-text hover:underline transition-colors">Open monthly approvals</a>
                }
              </div>
              <span class="command-status shrink-0"
                    [class.amber]="row.request.status === 'Pending'"
                    [class.green]="row.request.status === 'Approved'"
                    [class.red]="row.request.status === 'Rejected'">
                {{ row.request.status }}
              </span>
            </div>

            <dl class="grid grid-cols-1 min-[360px]:grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div class="min-w-0 min-[360px]:col-span-2">
                <dt class="command-kpi-label">Project</dt>
                <dd class="mt-1 text-[var(--cc-ink)] font-medium break-words">{{ row.projectLabel }}</dd>
              </div>
              <div class="min-w-0">
                <dt class="command-kpi-label">Requested by</dt>
                <dd class="mt-1 text-[var(--cc-ink)] font-medium break-words">{{ row.requestedByLabel }}</dd>
              </div>
              <div class="min-w-0">
                <dt class="command-kpi-label">Current step</dt>
                <dd class="mt-1 text-[var(--cc-ink)] font-semibold break-words">{{ row.stepRoleLabel }}</dd>
                <dd class="text-xs text-[var(--cc-muted)]">{{ row.stepLabel }}</dd>
              </div>
              <div>
                <dt class="command-kpi-label">Amount</dt>
                <dd class="mt-1 text-[var(--cc-ink)] font-semibold">
                  @if (row.amount !== undefined) {
                    {{ row.amount | currency:'EUR':'symbol':'1.0-0' }}
                  } @else {
                    <span class="text-ink-muted">&mdash;</span>
                  }
                </dd>
              </div>
              <div>
                <dt class="command-kpi-label">SLA</dt>
                <dd class="mt-1">
                  @if (row.slaDueAt) {
                    <span class="block font-mono tabular-nums text-xs text-[var(--cc-muted)]">{{ row.slaDueAt | date:'mediumDate' }}</span>
                    <span class="command-status mt-1" [class.red]="row.overdue" [class.green]="!row.overdue">
                      @if (row.overdue) { Overdue } @else { On track }
                    </span>
                  } @else {
                    <span class="text-ink-muted">&mdash;</span>
                  }
                </dd>
              </div>
            </dl>

            @if (row.request.status === 'Pending') {
              <div class="pt-4 border-t border-[var(--cc-line)] space-y-2">
                <div class="grid grid-cols-2 gap-2">
                  <button type="button"
                          data-test="approval-approve"
                          [attr.data-request-id]="row.request.id"
                          (click)="requestDecision(row, 'Approved')"
                          [disabled]="!row.canDecide || pendingId() === row.request.id"
                          [title]="approveTitle(row)"
                          [attr.aria-label]="approveTitle(row)"
                          class="command-button secondary min-w-0 justify-center disabled:opacity-40 disabled:cursor-not-allowed">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">check_circle</mat-icon>
                    Approve
                  </button>
                  <button type="button"
                          data-test="approval-reject"
                          [attr.data-request-id]="row.request.id"
                          (click)="requestDecision(row, 'Rejected')"
                          [disabled]="!row.canDecide || pendingId() === row.request.id"
                          [title]="rejectTitle(row)"
                          [attr.aria-label]="rejectTitle(row)"
                          class="command-button secondary min-w-0 justify-center enabled:hover:text-critical-text enabled:hover:border-critical disabled:opacity-40 disabled:cursor-not-allowed">
                    <mat-icon class="text-[18px] w-[18px] h-[18px]">cancel</mat-icon>
                    Reject
                  </button>
                </div>
                @if (!row.canDecide) {
                  <p class="text-xs text-[var(--cc-muted)]">{{ approveTitle(row) }}</p>
                }
              </div>
            }
          </article>
        } @empty {
          <div class="command-card px-5 py-12 text-center text-[var(--cc-muted)]">
            <mat-icon class="text-4xl mb-3 opacity-50">inbox</mat-icon>
            <h2 class="font-display font-bold text-ink-secondary">
              {{ filter() === 'mine' ? 'Your inbox is clear.' : 'No pending approvals.' }}
            </h2>
            <p class="text-sm mt-1">
              {{ filter() === 'mine' ? 'Nothing is waiting on your sign-off right now.' : 'There are no approval requests awaiting a decision.' }}
            </p>
          </div>
        }
      </section>
      </ng-template>
      </app-list-state>

      @if (decisionDraft(); as draft) {
        <div data-test="decision-dialog"
             class="fixed inset-0 z-50 bg-scrim/40 backdrop-blur-sm flex items-center justify-center p-4"
             appModal ariaLabelledby="approvalDecisionTitle"
             aria-describedby="approvalDecisionContext"
             (dismiss)="cancelDecision()">
          <div class="command-card shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[calc(100dvh-2rem)]">
            <div class="command-card-header gap-4">
              <div class="min-w-0">
                <div class="command-eyebrow">{{ draft.row.kind }} decision</div>
                <h2 id="approvalDecisionTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">
                  {{ draft.decision === 'Approved' ? 'Confirm approval' : 'Confirm rejection' }}
                </h2>
              </div>
              <button type="button" (click)="cancelDecision()" [disabled]="decisionInFlight()"
                      aria-label="Close decision dialog" title="Close"
                      class="p-2 rounded-full text-ink-muted hover:text-ink-secondary hover:bg-surface-muted disabled:opacity-40">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-5 sm:p-6 overflow-y-auto space-y-5">
              <div id="approvalDecisionContext" class="command-card-muted p-4 space-y-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="font-bold text-[var(--cc-ink)] break-words">{{ draft.row.label }}</p>
                    <p class="mt-1 text-xs font-mono tabular-nums text-[var(--cc-muted)] break-all">{{ draft.row.reference }}</p>
                  </div>
                  <span class="command-chip is-neutral shrink-0">{{ draft.row.kind }}</span>
                </div>
                <dl class="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3 text-sm">
                  <div class="min-w-0">
                    <dt class="command-kpi-label">Requested by</dt>
                    <dd class="mt-1 font-semibold text-[var(--cc-ink)] break-words">{{ draft.row.requestedByLabel }}</dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="command-kpi-label">Project</dt>
                    <dd class="mt-1 font-semibold text-[var(--cc-ink)] break-words">{{ draft.row.projectLabel }}</dd>
                  </div>
                </dl>
              </div>

              <label class="command-field" for="approvalDecisionNote">
                <span class="command-field-label">
                  {{ draft.decision === 'Rejected' ? 'Reason for rejection' : 'Decision note' }}
                  @if (draft.decision === 'Rejected') { <span class="text-critical">*</span> }
                </span>
                <textarea #decisionNote id="approvalDecisionNote" data-test="decision-note" rows="4"
                          [required]="draft.decision === 'Rejected'"
                          [value]="noteFor(draft.row.request.id)"
                          (input)="setNote(draft.row.request.id, decisionNote.value)"
                          [disabled]="decisionInFlight()"
                          [attr.aria-invalid]="draft.decision === 'Rejected' && decisionReasonMissing()"
                          aria-describedby="approvalDecisionNoteHelp"
                          [attr.aria-label]="(draft.decision === 'Rejected' ? 'Reason for rejecting ' : 'Optional note for approving ') + decisionContext(draft.row)"
                          class="command-textarea"></textarea>
                <span id="approvalDecisionNoteHelp"
                      [class.command-field-error]="draft.decision === 'Rejected' && decisionReasonMissing()"
                      [class.command-field-hint]="draft.decision !== 'Rejected' || !decisionReasonMissing()">
                  @if (draft.decision === 'Rejected') {
                    @if (decisionReasonMissing()) {
                      Enter a rejection reason to continue.
                    } @else {
                      This reason will be recorded with the decision.
                    }
                  } @else {
                    Optional context to record with the approval.
                  }
                </span>
              </label>
            </div>

            <div class="px-5 sm:px-6 py-4 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex flex-col-reverse min-[360px]:flex-row justify-end gap-2">
              <button type="button" (click)="cancelDecision()" [disabled]="decisionInFlight()"
                      class="command-button secondary justify-center disabled:opacity-40">Cancel</button>
              <button type="button" data-test="confirm-decision" (click)="confirmDecision()"
                      [disabled]="decisionInFlight() || (draft.decision === 'Rejected' && decisionReasonMissing())"
                      [attr.aria-label]="confirmDecisionLabel(draft)"
                      class="command-button justify-center disabled:opacity-40 disabled:cursor-not-allowed"
                      [class.bg-critical]="draft.decision === 'Rejected'"
                      [class.hover:bg-critical-strong]="draft.decision === 'Rejected'">
                @if (decisionInFlight()) {
                  {{ draft.decision === 'Approved' ? 'Approving…' : 'Rejecting…' }}
                } @else {
                  {{ draft.decision === 'Approved' ? 'Confirm approval' : 'Confirm rejection' }}
                }
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
})
export class Approvals {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  // resources and users are principal-gated server-side (401 until the Keycloak
  // JWT is restored). On reload the OIDC token restores async; firing the forkJoin
  // immediately 401s and the rxResource latches on the error (inbox shows empty
  // forever). Key the load on auth readiness so it fires only AFTER the OAuth
  // bootstrap has settled and the bearer token is attached.
  //
  // D: `assignments` and `orgNodes` joined the SAME forkJoin rather than
  // becoming their own rxResource on purpose — `scopeAllows` below needs all
  // three lists to answer at all, and one combined load means the rows can
  // never be computed from a half-loaded scope (an independent resource could
  // resolve later and flip a button from enabled to disabled under the
  // operator's cursor). Both reads are already permitted to every role this
  // route admits: `/assignments` to pm/resource-manager/delivery-executive/
  // finance/admin, `/resource-organizations` to any verified actor.
  protected res = rxResource<ApprovalsData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            approvals: this.api.getApprovalRequests(),
            projects: this.api.getProjects(),
            resources: this.api.getResources(),
            users: this.api.getUsers(),
            assignments: this.api.getAssignments(),
            orgNodes: this.api.getResourceOrganizations(),
          })
        : of<ApprovalsData>(EMPTY_DATA),
    defaultValue: EMPTY_DATA,
  });

  /** 'mine' = items awaiting my role (the inbox); 'all' = every pending item. */
  filter = signal<'mine' | 'all'>('mine');
  /** Id of the request whose decision is in flight, to guard against double-submit. */
  pendingId = signal<string | null>(null);
  /** The explicit confirmation currently open. Keeping the enriched row means the
   *  dialog repeats the exact record/person context the triggering action named. */
  protected decisionDraft = signal<DecisionDraft | null>(null);
  /** Optional approval note / mandatory rejection reason per request id. */
  private notes = signal<Record<string, string>>({});
  noteFor(id: string): string {
    return this.notes()[id] ?? '';
  }
  setNote(id: string, value: string): void {
    this.notes.update(m => ({ ...m, [id]: value }));
  }
  protected readonly decisionInFlight = computed(() => {
    const draft = this.decisionDraft();
    return !!draft && this.pendingId() === draft.row.request.id;
  });
  protected readonly decisionReasonMissing = computed(() => {
    const draft = this.decisionDraft();
    return draft?.decision === 'Rejected' && this.noteFor(draft.row.request.id).trim().length === 0;
  });

  private projectsById = computed(() => new Map(this.res.value().projects.map(p => [p.id, p.name])));
  private resourcesById = computed(() => new Map(this.res.value().resources.map(r => [r.id, r.name])));
  private usersById = computed(() => new Map(this.res.value().users.map(u => [u.id, u.name])));
  /** Full records (not just names) — `scopeAllows` needs `managerId`/`organization`. */
  private resourceRecordsById = computed(() => new Map(this.res.value().resources.map(r => [r.id, r])));
  private assignmentsById = computed(() => new Map(this.res.value().assignments.map(a => [a.id, a])));

  /**
   * D (design spec §3.4) — mirror of the ORG-SCOPE half of the server's
   * `decideOneApproval` step enforcement (src/server.ts). Answers: given that
   * the actor already holds the step's role, may they decide THIS item?
   *
   * BEFORE D holding the step's role was the whole answer, and this page still
   * said so: an `Allocation` step is routed to `resource-manager`, so EVERY
   * resource-manager was offered an enabled Approve button for every pending
   * allocation in the inbox — and since D the server 403s the ones outside their
   * scope ("Actor does not manage this resource and cannot decide its
   * allocation"). A dead button, not a cosmetic mismatch.
   *
   * The server's branches, in the same order and with the same outcomes:
   *   - `admin`/`delivery-executive` are GLOBAL roles: never narrowed by scope;
   *   - scope binds `Allocation` steps ONLY — every other kind routes by role
   *     and has no target resource (`allocationTargetResourceId` returns
   *     undefined there), so the rule falls through to the pre-D behaviour;
   *   - an UNRESOLVABLE target (deleted assignment or resource) also falls
   *     through permissively, exactly as the server does: refusing there would
   *     strand a live approval nobody could decide;
   *   - otherwise the target must be in the actor's scope — the transitive
   *     `managerId` chain union the managers of the org nodes above it, minus
   *     anyone already terminated — or have no accountable manager anywhere
   *     (`roleFallback`).
   *
   * TWO paths are an OR with this and are checked by the CALLER: the
   * named-approver path (`step.approverId`) and `isAccountableFor` (the server's
   * rule 2 — being an accountable manager admits an actor whatever their global
   * role, so it must NOT be gated on the role match this function assumes).
   * Both inherit the same demo-identity caveat: `auth.userId()` is a resource-id
   * in this app's demo identity but the JWT `sub` in production, so in prod the
   * comparison may simply not match — the server remains the authority either way.
   *
   * NO LOADING RACE to guard: approvals, assignments and the org tree arrive in
   * ONE forkJoin, so `approvals` is non-empty only when the other two have also
   * resolved. There is no window in which a row exists and its scope inputs do not.
   *
   * UX only, like the route guards. It cannot predict segregation of duties on
   * an item this actor did not request (the caller handles the self case).
   */
  private scopeAllows(request: ApprovalRequest, role: UserRole, userId: string): boolean {
    if (role === 'admin' || role === 'delivery-executive') return true;
    const accountable = this.accountableApprovers(request);
    if (accountable === undefined) return true;
    return accountable.roleFallback || accountable.managerIds.has(userId);
  }

  /**
   * The server's RULE 2, mirrored: is this actor an ACCOUNTABLE MANAGER of the
   * allocation's target resource? True regardless of the actor's global role —
   * that is the whole point (D adds no new RBAC role because authority over a
   * set of resources is relative, while every role here is global), and it is
   * why this is separate from `scopeAllows` above rather than folded into it.
   */
  private isAccountableFor(request: ApprovalRequest, userId: string): boolean {
    return this.accountableApprovers(request)?.managerIds.has(userId) ?? false;
  }

  /** The accountable-approver answer for an allocation request, or `undefined`
   *  when the request is not scoped at all (not an Allocation, or its target
   *  cannot be resolved — both fall through permissively, as the server does). */
  private accountableApprovers(
    request: ApprovalRequest,
  ): { managerIds: Set<string>; roleFallback: boolean } | undefined {
    if (request.kind !== 'Allocation') return undefined;
    // B3's composite `<assignmentId>:<YYYY-MM>`, or a bare (legacy) assignment id.
    const assignmentId = parseMonthRowId(request.refId)?.assignmentId ?? request.refId;
    const targetId = this.assignmentsById().get(assignmentId)?.resourceId;
    if (targetId === undefined) return undefined;
    const target = this.resourceRecordsById().get(targetId);
    if (target === undefined) return undefined;
    return accountableApproversOf(
      target, this.res.value().resources, this.res.value().orgNodes, todayIso());
  }

  /** Every Pending request, enriched with display labels and authorization flags. */
  private allRows = computed<ApprovalRow[]>(() => {
    const userId = this.auth.userId();
    const role = this.auth.role();
    const projects = this.projectsById();
    const users = this.usersById();
    const resources = this.resourcesById();
    const now = Date.now();

    return this.res
      .value()
      .approvals.filter(a => a.status === 'Pending')
      .map(request => {
        const step = request.steps[request.currentStep];
        const currentRole = step?.role;
        const selfRequested = request.requestedBy === userId;
        const roleMatches = !!currentRole && (role === 'admin' || role === currentRole);
        // MANAGER PATH (allocation approvals): a step may pin a specific approver by
        // RESOURCE-id (the resource's People Manager). In this app's demo identity,
        // auth.userId() maps to the resource-id, which is what approverId holds, so
        // allow the assigned manager to decide too. UX-only — the server re-checks.
        // (In prod userId() is the JWT sub, not a resource-id, so this may not match;
        // accepted gap — the role-based path still surfaces the action, server allows.)
        const managerMatches = !!step?.approverId && step.approverId === userId;
        // D: holding the step's role is necessary but no longer sufficient for an
        // Allocation — see `scopeAllows`. The named-approver path is unaffected,
        // and `isAccountableFor` is a THIRD, role-independent path (the server's
        // rule 2): being the resource's accountable manager admits the actor even
        // when no allocation step is routed to their global role, which is how a
        // Capability Leader who is a `delivery-executive` reaches their own rows.
        const inScope = roleMatches && this.scopeAllows(request, role, userId);
        const accountable = this.isAccountableFor(request, userId);
        const authorized = inScope || managerMatches || accountable;
        const outOfScope = roleMatches && !authorized;
        const approvable = !selfRequested && authorized;
        const overdue = !!request.slaDueAt && new Date(request.slaDueAt).getTime() < now;
        const projectLabel = request.projectId ? (projects.get(request.projectId) ?? request.projectId) : 'No project';

        return {
          request,
          kind: request.kind,
          reference: request.refId,
          label: this.rowLabel(request, projectLabel),
          projectLabel,
          amount: request.amount,
          requestedByLabel: users.get(request.requestedBy) ?? resources.get(request.requestedBy) ?? request.requestedBy,
          stepLabel: `Step ${Math.min(request.currentStep + 1, request.steps.length)} of ${request.steps.length}`,
          currentRole,
          stepRoleLabel: this.roleLabel(currentRole),
          slaDueAt: request.slaDueAt,
          overdue,
          approvable,
          selfRequested,
          outOfScope,
          canDecide: authorized && !selfRequested,
        } satisfies ApprovalRow;
      });
  });

  rows = computed(() => {
    const all = this.allRows();
    return this.filter() === 'mine' ? all.filter(r => r.approvable) : all;
  });

  /**
   * Whether the inbox has nothing truthful to render yet. `isLoading()` alone is
   * NOT that question: `params()` above is false until the OIDC bootstrap settles
   * and the stream answers that with `of(EMPTY_DATA)` — a RESOLVED empty, not a
   * pending one — so isLoading() was FALSE for the whole afterNextRender ->
   * /api/storage-status -> OIDC discovery window (auth.service.ts 154, 191-249)
   * *and* in the SSR HTML shipped to the browser. Bound bare, the wrapper below
   * rendered "Your inbox is clear." / "Nothing is waiting on your sign-off right
   * now." while three allocation requests sat pending this PM's decision. A PM
   * who glances and navigates away has been told a falsehood by a page that had
   * not yet asked the question.
   *
   * Not-ready counts as loading, never as ready-and-empty — the same rule
   * resources.component.ts's `listLoading()` applies, whose shape this mirrors.
   */
  protected readonly listLoading = computed<boolean>(
    () => !this.auth.authReady() || this.res.isLoading(),
  );

  /**
   * Count of items awaiting this actor, or `null` when that is not yet known.
   *
   * TWO reasons this is nullable rather than a plain number. (1) The badge that
   * renders it sits ABOVE the read-state wrapper, so a bare 0 during the
   * pre-authReady window is the same false "nothing to approve" statement
   * `listLoading()` exists to prevent — the wrapper cannot cover a figure
   * outside it. (2) `res.value()` THROWS while the resource is in its error
   * state, and `allRows()` dereferences it; an unguarded throw from a binding
   * above the wrapper aborts the change-detection pass and makes the "Couldn't
   * load approvals" panel and its Retry — the only recovery short of a browser
   * reload — unreachable code.
   *
   * This is NOT the banned `status()==='error' ? [] : value()`: nothing here
   * turns a failed read into an empty answer. `null` renders as an em dash and
   * the wrapper renders the error panel in the same pass, so the screen says
   * "we could not load this", never "there is none".
   */
  mineCount = computed<number | null>(() => {
    if (this.listLoading() || this.res.status() === 'error') return null;
    return this.allRows().filter(r => r.approvable).length;
  });

  requestDecision(row: ApprovalRow, decision: 'Approved' | 'Rejected'): void {
    if (!row.canDecide || this.pendingId() !== null) return;
    this.decisionDraft.set({ row, decision });
  }

  cancelDecision(): void {
    if (this.decisionInFlight()) return;
    this.decisionDraft.set(null);
  }

  confirmDecision(): void {
    const draft = this.decisionDraft();
    if (!draft || this.decisionInFlight()) return;
    // Rejection is the one branch where a note is a business-facing reason, not
    // optional commentary. Keep the guard here as well as on the disabled button:
    // programmatic calls and stale DOM cannot bypass the invariant.
    if (draft.decision === 'Rejected' && this.decisionReasonMissing()) return;
    this.decide(draft.row, draft.decision);
  }

  protected confirmDecisionLabel(draft: DecisionDraft): string {
    const verb = draft.decision === 'Approved' ? 'approval' : 'rejection';
    return `Confirm ${verb} for ${this.decisionContext(draft.row)}`;
  }

  protected decisionContext(row: ApprovalRow): string {
    return `${row.kind} ${row.reference} on ${row.projectLabel}, requested by ${row.requestedByLabel}`;
  }

  private decide(row: ApprovalRow, decision: 'Approved' | 'Rejected'): void {
    if (!row.canDecide || this.pendingId() === row.request.id) return;
    this.pendingId.set(row.request.id);
    // The deciding principal is derived server-side. Rejection reaches this point
    // only with a non-empty reason; approval commentary remains optional.
    const note = this.noteFor(row.request.id).trim() || undefined;
    this.api
      .decideApprovalRequest(row.request.id, decision, note)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.res.reload();
          this.pendingId.set(null);
          this.decisionDraft.set(null);
          this.setNote(row.request.id, '');
          this.notifications.show(`${row.kind} ${row.reference} ${decision.toLowerCase()}`, 'success');
        },
        error: () => {
          this.pendingId.set(null);
          this.notifications.error(`Could not ${decision.toLowerCase().replace(/d$/, '')} ${row.reference}. Please try again.`);
        },
      });
  }

  approveTitle(row: ApprovalRow): string {
    const context = this.decisionContext(row);
    if (row.selfRequested) return `Cannot approve ${context}. Segregation of duties: you cannot approve a request you submitted`;
    if (row.outOfScope) return `Cannot approve ${context}: ${OUT_OF_SCOPE_TITLE}`;
    if (!row.approvable) return `Cannot approve ${context}: awaiting ${this.roleLabel(row.currentRole)} approval`;
    return `Approve ${context}`;
  }

  rejectTitle(row: ApprovalRow): string {
    const context = this.decisionContext(row);
    if (row.selfRequested) return `Cannot reject ${context}. Segregation of duties: you cannot decide a request you submitted`;
    if (row.outOfScope) return `Cannot reject ${context}: ${OUT_OF_SCOPE_TITLE}`;
    if (!row.approvable) return `Cannot reject ${context}: awaiting ${this.roleLabel(row.currentRole)} decision`;
    return `Reject ${context}`;
  }

  kindIcon(kind: ApprovalKind): string {
    switch (kind) {
      case 'TimeEntry':
        return 'schedule';
      case 'Expense':
        return 'receipt_long';
      case 'Milestone':
        return 'flag';
      case 'ChangeRequest':
        return 'edit_note';
      case 'Invoice':
        return 'request_quote';
      default:
        return 'task_alt';
    }
  }

  /**
   * Human, kind-aware description. Allocation approvals carry an opaque assignment
   * refId, so surface a readable label built from the fields on hand (the project;
   * the allocated resource isn't joinable here without loading assignments — an
   * accepted limitation). Other kinds fall back to the raw reference.
   *
   * B3's `refId` is the composite `<assignmentId>:<YYYY-MM>`; a bare id (no
   * `parseMonthRowId` match) is a pre-B3 approval, which keeps the un-suffixed
   * wording below. (Translated from the file's original Italian strings —
   * this run's UI-copy decision is English; the rest of the file is untouched.)
   */
  private rowLabel(request: ApprovalRequest, projectLabel: string): string {
    if (request.kind === 'Allocation') {
      const base = request.projectId ? `Allocation on ${projectLabel}` : 'Resource allocation';
      const parsed = parseMonthRowId(request.refId);
      return parsed ? `${base} — ${parsed.month}` : base;
    }
    return request.refId;
  }

  private roleLabel(role: string | undefined): string {
    if (!role) return 'No approver';
    const labels: Record<UserRole, string> = {
      employee: 'Employee',
      pm: 'Project Manager',
      'resource-manager': 'Resource Manager',
      'delivery-executive': 'Delivery Executive',
      finance: 'Finance',
      sales: 'Sales',
      admin: 'Admin',
    };
    return (labels as Record<string, string>)[role] ?? role;
  }
}
