import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import {
  ApiService,
  ApprovalKind,
  ApprovalRequest,
  Project,
  Resource,
  User,
  UserRole,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ListStateComponent } from '../shared/list-state.component';

interface ApprovalsData {
  approvals: ApprovalRequest[];
  projects: Project[];
  resources: Resource[];
  users: User[];
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
  /** Final guard for the Approve/Reject buttons (pending + role match + not self). */
  canDecide: boolean;
}

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
  imports: [CurrencyPipe, DatePipe, MatIconModule, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Approvals Inbox</h1>
          <p class="text-[var(--cc-muted)] mt-2 text-sm">
            Review and decide items awaiting your sign-off across time, expenses, milestones, changes, and invoices.
          </p>
        </div>
        <div class="command-card-muted p-1 flex items-center self-start sm:self-auto">
          <button type="button" (click)="filter.set('mine')"
                  [class.bg-surface]="filter() === 'mine'"
                  [class.shadow-sm]="filter() === 'mine'"
                  [class.text-ink]="filter() === 'mine'"
                  [class.text-ink-muted]="filter() !== 'mine'"
                  class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out flex items-center gap-2">
            My inbox
            <span class="command-status">{{ mineCount() }}</span>
          </button>
          <button type="button" (click)="filter.set('all')"
                  [class.bg-surface]="filter() === 'all'"
                  [class.shadow-sm]="filter() === 'all'"
                  [class.text-ink]="filter() === 'all'"
                  [class.text-ink-muted]="filter() !== 'all'"
                  class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
            All pending
          </button>
        </div>
      </div>

      <app-list-state [loading]="res.isLoading()" [error]="res.status() === 'error'" label="approvals" (retry)="res.reload()">
      <div class="command-card overflow-hidden">
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
                        @if (row.canDecide) {
                          <span class="inline-block w-40">
                            <input #noteInput type="text"
                                   [value]="noteFor(row.request.id)"
                                   (input)="setNote(row.request.id, noteInput.value)"
                                   [disabled]="pendingId() === row.request.id"
                                   placeholder="Nota (opzionale)"
                                   [attr.aria-label]="'Approval note for ' + row.reference"
                                   class="command-input">
                          </span>
                        }
                        <button type="button"
                                (click)="decide(row, 'Approved')"
                                [disabled]="!row.canDecide || pendingId() === row.request.id"
                                [title]="approveTitle(row)"
                                [attr.aria-label]="approveTitle(row)"
                                class="p-2 rounded-lg text-ink-muted enabled:hover:text-positive-text enabled:hover:bg-positive-tint transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">check_circle</mat-icon>
                        </button>
                        <button type="button"
                                (click)="decide(row, 'Rejected')"
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
      </app-list-state>
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
  protected res = rxResource<ApprovalsData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            approvals: this.api.getApprovalRequests(),
            projects: this.api.getProjects(),
            resources: this.api.getResources(),
            users: this.api.getUsers(),
          })
        : of<ApprovalsData>({ approvals: [], projects: [], resources: [], users: [] }),
    defaultValue: { approvals: [], projects: [], resources: [], users: [] },
  });

  /** 'mine' = items awaiting my role (the inbox); 'all' = every pending item. */
  filter = signal<'mine' | 'all'>('mine');
  /** Id of the request whose decision is in flight, to guard against double-submit. */
  pendingId = signal<string | null>(null);
  /** Optional approver note per request id, captured before an approve/reject. */
  private notes = signal<Record<string, string>>({});
  noteFor(id: string): string {
    return this.notes()[id] ?? '';
  }
  setNote(id: string, value: string): void {
    this.notes.update(m => ({ ...m, [id]: value }));
  }

  private projectsById = computed(() => new Map(this.res.value().projects.map(p => [p.id, p.name])));
  private resourcesById = computed(() => new Map(this.res.value().resources.map(r => [r.id, r.name])));
  private usersById = computed(() => new Map(this.res.value().users.map(u => [u.id, u.name])));

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
        const authorized = roleMatches || managerMatches;
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
          canDecide: authorized && !selfRequested,
        } satisfies ApprovalRow;
      });
  });

  rows = computed(() => {
    const all = this.allRows();
    return this.filter() === 'mine' ? all.filter(r => r.approvable) : all;
  });

  mineCount = computed(() => this.allRows().filter(r => r.approvable).length);

  decide(row: ApprovalRow, decision: 'Approved' | 'Rejected'): void {
    if (!row.canDecide || this.pendingId() === row.request.id) return;
    this.pendingId.set(row.request.id);
    // Optional approver note; the deciding principal is derived server-side.
    const note = this.noteFor(row.request.id).trim() || undefined;
    this.api
      .decideApprovalRequest(row.request.id, decision, note)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.res.reload();
          this.pendingId.set(null);
          this.notifications.show(`${row.kind} ${row.reference} ${decision.toLowerCase()}`, 'success');
        },
        error: () => {
          this.pendingId.set(null);
          this.notifications.error(`Could not ${decision.toLowerCase().replace(/d$/, '')} ${row.reference}. Please try again.`);
        },
      });
  }

  approveTitle(row: ApprovalRow): string {
    if (row.selfRequested) return 'Segregation of duties: you cannot approve a request you submitted';
    if (!row.approvable) return `Awaiting ${this.roleLabel(row.currentRole)} approval`;
    return 'Approve this request';
  }

  rejectTitle(row: ApprovalRow): string {
    if (row.selfRequested) return 'Segregation of duties: you cannot decide a request you submitted';
    if (!row.approvable) return `Awaiting ${this.roleLabel(row.currentRole)} decision`;
    return 'Reject this request';
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
   */
  private rowLabel(request: ApprovalRequest, projectLabel: string): string {
    if (request.kind === 'Allocation') {
      return request.projectId ? `Allocazione su ${projectLabel}` : 'Allocazione risorsa';
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
