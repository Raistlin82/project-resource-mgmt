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
    <div class="max-w-7xl mx-auto space-y-8 p-4 sm:p-6 lg:p-8">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 class="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">Approvals Inbox</h1>
          <p class="text-slate-500 mt-2 text-sm sm:text-base">
            Review and decide items awaiting your sign-off across time, expenses, milestones, changes, and invoices.
          </p>
        </div>
        <div class="bg-slate-50 p-1 rounded-xl flex items-center shadow-inner ring-1 ring-slate-900/5 border border-slate-200 self-start sm:self-auto">
          <button type="button" (click)="filter.set('mine')"
                  [class.bg-white]="filter() === 'mine'"
                  [class.shadow-sm]="filter() === 'mine'"
                  [class.text-slate-900]="filter() === 'mine'"
                  [class.text-slate-500]="filter() !== 'mine'"
                  class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out flex items-center gap-2">
            My inbox
            <span class="font-mono tabular-nums text-xs px-1.5 py-0.5 rounded-md bg-blue-50 text-blue-700 ring-1 ring-blue-200">{{ mineCount() }}</span>
          </button>
          <button type="button" (click)="filter.set('all')"
                  [class.bg-white]="filter() === 'all'"
                  [class.shadow-sm]="filter() === 'all'"
                  [class.text-slate-900]="filter() === 'all'"
                  [class.text-slate-500]="filter() !== 'all'"
                  class="px-5 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ease-out">
            All pending
          </button>
        </div>
      </div>

      <app-list-state [loading]="res.isLoading()" [error]="res.status() === 'error'" label="approvals" (retry)="res.reload()">
      <div class="bg-white rounded-3xl shadow-sm ring-1 ring-slate-900/5 border border-slate-200 overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-sm text-left border-collapse min-w-[960px]">
            <thead>
              <tr class="bg-slate-50 border-b border-slate-200">
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Kind</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Reference</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Project</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Amount</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Requested by</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Current step</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">SLA</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                <th scope="col" class="px-6 py-4 text-xs font-bold text-slate-500 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              @for (row of rows(); track row.request.id) {
                <tr class="hover:bg-slate-50 transition-colors">
                  <td class="px-6 py-5">
                    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold ring-1 bg-slate-50 text-slate-700 ring-slate-200">
                      <mat-icon class="text-[16px] w-[16px] h-[16px]">{{ kindIcon(row.kind) }}</mat-icon>
                      {{ row.kind }}
                    </span>
                  </td>
                  <td class="px-6 py-5 font-mono tabular-nums text-slate-900">{{ row.reference }}</td>
                  <td class="px-6 py-5 text-slate-600">{{ row.projectLabel }}</td>
                  <td class="px-6 py-5 text-right font-mono tabular-nums font-semibold text-slate-900">
                    @if (row.amount !== undefined) {
                      {{ row.amount | currency:'EUR':'symbol':'1.0-0' }}
                    } @else {
                      <span class="text-slate-400">&mdash;</span>
                    }
                  </td>
                  <td class="px-6 py-5 text-slate-600">{{ row.requestedByLabel }}</td>
                  <td class="px-6 py-5">
                    <div class="text-slate-900 font-semibold">{{ row.stepRoleLabel }}</div>
                    <div class="text-xs font-medium text-slate-500 mt-0.5">{{ row.stepLabel }}</div>
                  </td>
                  <td class="px-6 py-5">
                    @if (row.slaDueAt) {
                      <div class="flex flex-col gap-1">
                        <span class="font-mono tabular-nums text-xs text-slate-500">{{ row.slaDueAt | date:'mediumDate' }}</span>
                        @if (row.overdue) {
                          <span class="inline-flex items-center gap-1 self-start px-2 py-0.5 rounded-md text-[11px] font-bold ring-1 bg-red-50 text-red-700 ring-red-200">
                            <mat-icon class="text-[13px] w-[13px] h-[13px]">schedule</mat-icon> Overdue
                          </span>
                        } @else {
                          <span class="inline-flex items-center self-start px-2 py-0.5 rounded-md text-[11px] font-bold ring-1 bg-emerald-50 text-emerald-700 ring-emerald-200">On track</span>
                        }
                      </div>
                    } @else {
                      <span class="text-slate-400">&mdash;</span>
                    }
                  </td>
                  <td class="px-6 py-5">
                    <span class="inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold ring-1"
                          [class.bg-amber-50]="row.request.status === 'Pending'"
                          [class.text-amber-700]="row.request.status === 'Pending'"
                          [class.ring-amber-200]="row.request.status === 'Pending'"
                          [class.bg-emerald-50]="row.request.status === 'Approved'"
                          [class.text-emerald-700]="row.request.status === 'Approved'"
                          [class.ring-emerald-200]="row.request.status === 'Approved'"
                          [class.bg-red-50]="row.request.status === 'Rejected'"
                          [class.text-red-700]="row.request.status === 'Rejected'"
                          [class.ring-red-200]="row.request.status === 'Rejected'">
                      {{ row.request.status }}
                    </span>
                  </td>
                  <td class="px-6 py-5 text-right">
                    @if (row.request.status === 'Pending') {
                      <div class="inline-flex items-center gap-1">
                        <button type="button"
                                (click)="decide(row, 'Approved')"
                                [disabled]="!row.canDecide || pendingId() === row.request.id"
                                [title]="approveTitle(row)"
                                [attr.aria-label]="approveTitle(row)"
                                class="p-2 rounded-lg text-slate-400 enabled:hover:text-emerald-700 enabled:hover:bg-emerald-50 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">check_circle</mat-icon>
                        </button>
                        <button type="button"
                                (click)="decide(row, 'Rejected')"
                                [disabled]="!row.canDecide || pendingId() === row.request.id"
                                [title]="rejectTitle(row)"
                                [attr.aria-label]="rejectTitle(row)"
                                class="p-2 rounded-lg text-slate-400 enabled:hover:text-red-700 enabled:hover:bg-red-50 transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                          <mat-icon class="text-[20px] w-[20px] h-[20px]">cancel</mat-icon>
                        </button>
                      </div>
                    } @else {
                      <span class="text-xs font-medium text-slate-500">Decided</span>
                    }
                  </td>
                </tr>
              } @empty {
                <tr>
                  <td colspan="9" class="px-6 py-16 text-center text-slate-500">
                    <div class="flex flex-col items-center justify-center">
                      <mat-icon class="text-4xl mb-3 opacity-50">inbox</mat-icon>
                      <p class="font-medium text-slate-600">
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
        const approvable = !selfRequested && roleMatches;
        const overdue = !!request.slaDueAt && new Date(request.slaDueAt).getTime() < now;

        return {
          request,
          kind: request.kind,
          reference: request.refId,
          projectLabel: request.projectId ? (projects.get(request.projectId) ?? request.projectId) : 'No project',
          amount: request.amount,
          requestedByLabel: users.get(request.requestedBy) ?? resources.get(request.requestedBy) ?? request.requestedBy,
          stepLabel: `Step ${Math.min(request.currentStep + 1, request.steps.length)} of ${request.steps.length}`,
          currentRole,
          stepRoleLabel: this.roleLabel(currentRole),
          slaDueAt: request.slaDueAt,
          overdue,
          approvable,
          selfRequested,
          canDecide: roleMatches && !selfRequested,
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
    this.api
      .decideApprovalRequest(row.request.id, decision, this.auth.userId())
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
