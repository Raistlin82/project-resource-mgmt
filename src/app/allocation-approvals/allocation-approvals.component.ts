import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { of } from 'rxjs';
import { rxResource } from '@angular/core/rxjs-interop';
import { AllocationApprovalFeed, AllocationApprovalRow, ApiService, ResourceKind, ResourceOrganization } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { ListStateComponent } from '../shared/list-state.component';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { ApprovalModalComponent } from './approval-modal.component';
import { AllocationCalendarComponent } from '../allocation-calendar/allocation-calendar.component';
import { monthsInRange, semaphoreBand, type SemaphoreBand } from '../services/capacity.util';
import { dimensionsOf } from '../services/org-scope.util';

/** Empty envelope used until auth settles (and as the resource default). */
const EMPTY: AllocationApprovalFeed = { months: [], rows: [] };

/** How many months to pad the range-selector option list beyond the loaded window. */
const OPTION_PAD_MONTHS = 6;

/**
 * Per-band presentation: label (WCAG text, not colour alone) + design-system tone
 * tokens. Mirrors capacity.component.ts's `BAND_META` (a module-private const
 * there too — there is nothing shared to import from).
 */
interface BandMeta {
  label: string;
  /** Cell background tint token. */
  cell: string;
  /** Accent-as-text token (the `-text` / `-700` shade for AA contrast). */
  text: string;
  /** Ring token matching the tint. */
  ring: string;
}

const BAND_META: Record<SemaphoreBand, BandMeta> = {
  idle: { label: 'Idle', cell: 'bg-surface-muted', text: 'text-ink-secondary', ring: 'ring-line' },
  under: { label: 'Under', cell: 'bg-caution-tint', text: 'text-caution-text', ring: 'ring-caution' },
  healthy: { label: 'Healthy', cell: 'bg-positive-tint', text: 'text-positive-text', ring: 'ring-positive' },
  over: { label: 'Over', cell: 'bg-critical-tint', text: 'text-critical-text', ring: 'ring-critical' },
};

/** One rendered grid cell (view model), precomputed so the template stays declarative. */
interface CellVm {
  month: string;
  /** The resource's full booked hours for the month — ALWAYS independent of
   *  the status filter (server contract; never derive this from `items`). */
  total: number;
  target: number;
  band: SemaphoreBand;
  meta: BandMeta;
  aria: string;
  /**
   * C1: false for a dummy/subco row — they have no capacity to saturate
   * (spec §4.3), so a percentage/band computed against their un-widened
   * `contractHoursPerDay` target would be a meaningless (and often wildly
   * alarming) verdict for a legitimately multi-FTE booking. `total`/`target`
   * stay visible either way; only the tint and the band LABEL are gated on
   * this — never the numbers themselves.
   */
  tracksSaturation: boolean;
}

interface RowVm {
  resourceId: string;
  resourceName: string;
  kind: ResourceKind;
  /** At least one item in the CURRENT (filtered) listing is 'Requested'. */
  hasPending: boolean;
  cells: CellVm[];
}

/** Shift a 'YYYY-MM' month by `delta` months (may be negative). Local copy of
 *  capacity.component.ts's helper — not exported from there either. */
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/**
 * Allocation approvals page (B3, Task 10). The People Manager's resource × month
 * table of per-month allocation requests: a status filter (Pending/Approved/All)
 * narrows which items are listed (and therefore which resources appear), while
 * `totalHours` always reflects each resource's full booked hours for the month —
 * that split is a server contract this page must not misrepresent, so cells
 * render `row.totalHours`/`row.targetHours` directly rather than re-deriving a
 * total from the (filtered) `items` array.
 *
 * Signal-first and SSR-safe, structured like `CapacityComponent` (B2): the
 * gated `/allocation-approvals` read is keyed on `AuthService.authReady` + the
 * selected range + the status filter, resolving to an empty default until auth
 * settles (no 401 latch). Identity is read reactively — never snapshotted at
 * field-init.
 *
 * The approval modal (`ApprovalModalComponent`) is rendered behind the standard
 * `appModal` backdrop whenever `modalResourceId()` (single-resource, Task 11) or
 * `multiMode()` (multi-resource, Task 12 — the toolbar's "Approve selected"
 * button, gated on more than one entry in `selectedResourceIds()`) is set;
 * deciding a month reloads the feed either way.
 *
 * The `months` this page hands the modal are the FEED's loaded window, and in
 * multi mode they are also the bound on the modal's month sweep (RPT §4.2's
 * "Approva e Prosegui": it walks itself forward to each remaining decidable
 * month and never leaves that window — see `ApprovalModalComponent`'s
 * `nextReviewableMonth`). So the From/To selectors above are what widens or
 * narrows how far one multi-resource pass can reach, and the modal stays open
 * across the whole pass: the reload each decision triggers must therefore not
 * disturb the window's VALUES, which is why `from`/`to` are only ever seeded
 * once (see the seeding effect) and never re-derived from a response.
 */
@Component({
  selector: 'app-allocation-approvals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DecimalPipe, ListStateComponent, ModalDialogDirective, ApprovalModalComponent, AllocationCalendarComponent],
  template: `
    <div class="command-page space-y-6">
      <div class="command-header">
        <div>
          <div class="command-eyebrow">Allocation Approvals</div>
          <h1 class="command-title">Allocation Approvals</h1>
          <p class="command-subtitle">Per-month allocation requests awaiting a People Manager decision, by resource. Booked-hours totals always reflect the full month regardless of the status filter below.</p>
        </div>
        <!-- F4: the whole control cluster is gated on the feed's error state, and
             the gate is load-bearing twice over. It stops a failed read from
             offering filters and an "Approve selected (0)" button over rows that
             were never fetched; and it is the half that keeps feed()'s error
             short-circuit honest, since an EMPTY envelope must never be
             *rendered* as though there were simply nothing pending. A 401/403
             gets the notice below plus the ListState error panel and its Retry. -->
        @if (!dataError()) {
          <div class="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 w-full sm:w-auto">
            <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
              <span class="text-ink-muted">Status</span>
              <select [value]="statusFilter()" (change)="onStatusChange($event)" aria-label="Status filter" data-test="status-filter" class="command-select">
                <option value="Requested">Pending</option>
                <option value="Allocated">Approved</option>
                <option value="all">All</option>
              </select>
            </label>
            <!-- Capability / Practice / Competence / People Manager filters (D, Task 8).
                 Derived through dimensionsOf, so a capability filter also matches a
                 resource attached BELOW it (e.g. a competence two levels down) — never
                 a raw equality check against the resource's organization. These
                 <select>s load their <option>s from an async rxResource, so per the
                 established trap they use (change) + per-option [selected] rather
                 than [value]/[ngModel] on the <select> itself. Explicit min-widths
                 (this row now packs 7 controls + a button) so the label text never
                 shrink-wraps down to an unreadable sliver — the sm:flex-wrap above
                 lets the row spill onto a second line rather than fight them for space. -->
            <!-- F4: the three dimension filters hang off orgsRes, a SEPARATE read
                 from the feed with its own error state. When the org tree fails we
                 withdraw them and say so, rather than render three <select>s whose
                 only option is "All capabilities" — an empty option list asserts
                 "this organization has no capabilities", which is a different and
                 worse claim than "the tree could not be loaded". The feed is
                 unaffected, so the approvals themselves stay reviewable. -->
            @if (orgsError()) {
              <p role="alert" data-test="org-filters-unavailable"
                 class="flex items-center gap-2 text-sm font-medium text-[var(--cc-ink)]">
                <mat-icon class="text-[18px] w-[18px] h-[18px] text-[var(--cc-amber-text)] shrink-0">filter_alt_off</mat-icon>
                Capability / practice / competence filters unavailable — the organization tree could not be loaded.
              </p>
            } @else {
              <select (change)="onCapabilityChange($event)" aria-label="Filter by capability"
                      data-test="capability-filter" class="command-select sm:min-w-[9rem]">
                <option value="" [selected]="capabilityFilter() === ''">All capabilities</option>
                @for (name of capabilityOptions(); track name) {
                  <option [value]="name" [selected]="name === capabilityFilter()">{{ name }}</option>
                }
              </select>
              <select (change)="onPracticeChange($event)" aria-label="Filter by practice"
                      data-test="practice-filter" class="command-select sm:min-w-[9rem]">
                <option value="" [selected]="practiceFilter() === ''">All practices</option>
                @for (name of practiceOptions(); track name) {
                  <option [value]="name" [selected]="name === practiceFilter()">{{ name }}</option>
                }
              </select>
              <select (change)="onCompetenceChange($event)" aria-label="Filter by competence"
                      data-test="competence-filter" class="command-select sm:min-w-[9rem]">
                <option value="" [selected]="competenceFilter() === ''">All competences</option>
                @for (name of competenceOptions(); track name) {
                  <option [value]="name" [selected]="name === competenceFilter()">{{ name }}</option>
                }
              </select>
            }
            <select (change)="onManagerFilterChange($event)" aria-label="Filter by People Manager"
                    data-test="manager-filter" class="command-select sm:min-w-[10rem]">
              <option value="" [selected]="managerFilter() === ''">All people managers</option>
              @for (m of managerFilterOptions(); track m.id) {
                <option [value]="m.id" [selected]="m.id === managerFilter()">{{ m.name }}</option>
              }
            </select>
            @if (monthOptions().length > 0) {
              <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
                <span class="text-ink-muted">From</span>
                <select (change)="onFromChange($event)" aria-label="Range start month" class="command-select">
                  @for (m of monthOptions(); track m) {
                    <option [value]="m" [selected]="m === from()">{{ monthLabel(m) }}</option>
                  }
                </select>
              </label>
              <label class="flex items-center gap-2 text-sm font-semibold text-ink-secondary">
                <span class="text-ink-muted">To</span>
                <select (change)="onToChange($event)" aria-label="Range end month" class="command-select">
                  @for (m of monthOptions(); track m) {
                    <option [value]="m" [selected]="m === to()">{{ monthLabel(m) }}</option>
                  }
                </select>
              </label>
            }
            <button type="button" (click)="openMultiApprove()" [disabled]="selectedResourceIds().size <= 1"
                    data-test="multi-approve" class="command-button secondary disabled:opacity-40 disabled:cursor-not-allowed">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">done_all</mat-icon>
              Approve selected ({{ selectedResourceIds().size }})
            </button>
          </div>
        }
      </div>

      @if (accessNotice(); as notice) {
        <div class="command-card-muted p-4 flex items-start gap-3" role="alert">
          <mat-icon class="text-[20px] w-[20px] h-[20px] text-[var(--cc-amber-text)] shrink-0">lock</mat-icon>
          <p class="text-sm font-medium text-[var(--cc-ink)]">{{ notice }}</p>
        </div>
      }

      <!-- KPI strip. F4: gated on the error state for the same reason as the
           controls above — "0 Resources Pending / 0 Pending Project-Months" is
           the most damaging thing this page could tell an approver whose read
           just 403'd, because it is indistinguishable from an empty queue. -->
      @if (!dataError()) {
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
          <div class="command-kpi" [class.danger]="pendingResourceCount() > 0">
            <p class="command-kpi-label">Resources Pending</p>
            <p class="command-kpi-value font-mono tabular-nums" data-test="kpi-pending-resources">{{ pendingResourceCount() }}</p>
          </div>
          <div class="command-kpi">
            <!-- One (assignment, month) item, not one month: a resource with three
                 projects booked in September contributes three. -->
            <p class="command-kpi-label">Pending Project-Months</p>
            <p class="command-kpi-value font-mono tabular-nums" data-test="kpi-pending-months">{{ pendingMonths() }}</p>
          </div>
        </div>
      }

      <!-- Legend — band meaning is text + colour, never colour alone (WCAG 1.4.1).
           F4: it belongs to the grid, so it goes with the grid — a band key above
           an error panel describes tints that are nowhere on the page. -->
      @if (!dataError()) {
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-semibold text-ink-muted">
          <span class="uppercase tracking-wider">Utilisation band:</span>
          @for (b of legend; track b.band) {
            <span class="inline-flex items-center gap-1.5">
              <span class="w-3 h-3 rounded-sm ring-1 {{ b.meta.cell }} {{ b.meta.ring }}"></span>
              <span [class]="b.meta.text">{{ b.meta.label }}</span>
            </span>
          }
        </div>
      }

      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="table-rows" [rows]="6" [columns]="4" label="allocation approvals" (retry)="reload()">
        <ng-template>
        @if (rows().length > 0) {
          <div class="command-card overflow-hidden">
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead class="bg-surface-muted border-b border-line text-ink-muted">
                  <tr>
                    <th class="px-3 py-4 text-left sticky left-0 bg-surface-muted z-10"></th>
                    <th class="px-4 sm:px-6 py-4 font-semibold uppercase tracking-wider text-xs text-left sticky left-10 bg-surface-muted z-10">Resource</th>
                    @for (m of months(); track m) {
                      <th class="px-3 py-4 font-semibold uppercase tracking-wider text-xs text-center min-w-[7rem]">{{ monthLabel(m) }}</th>
                    }
                    <th class="px-3 py-4 font-semibold uppercase tracking-wider text-xs text-center">Actions</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  @for (row of rows(); track row.resourceId) {
                    <tr class="hover:bg-surface-muted transition-colors" data-test="approval-row">
                      <td class="px-3 py-4 sticky left-0 bg-surface z-10">
                        <input type="checkbox" data-test="select-resource"
                               [checked]="selectedResourceIds().has(row.resourceId)"
                               (change)="toggleResource(row.resourceId)"
                               [attr.aria-label]="'Select ' + row.resourceName"
                               class="command-checkbox">
                      </td>
                      <td class="px-4 sm:px-6 py-4 font-bold text-ink whitespace-nowrap sticky left-10 bg-surface z-10">
                        <span data-test="resource-name">{{ row.resourceName }}</span>
                        @if (row.hasPending) {
                          <span class="command-status amber uppercase ml-2 text-[10px]">Pending</span>
                        }
                        <!-- C1: explains the neutral (uncoloured) cells to the right — a
                             dummy/subco has no saturation band, not a missing one. -->
                        @if (row.kind !== 'internal') {
                          <span class="command-status uppercase ml-2 text-[10px]">{{ row.kind }}</span>
                        }
                      </td>
                      @for (c of row.cells; track c.month) {
                        <td class="px-2 py-2 align-top">
                          <div class="rounded-lg ring-1 p-2 text-center {{ c.meta.cell }} {{ c.meta.ring }}"
                               [attr.data-test]="'cell-' + row.resourceId + '-' + c.month"
                               [attr.data-band]="c.tracksSaturation ? c.band : null">
                            <!-- A11Y: the composed name lives in a visually-hidden SPAN,
                                 never in an aria-label on this div. The div has no role,
                                 and ARIA forbids naming a role=generic element — so the
                                 attribute sat in the DOM while no screen reader ever
                                 surfaced it, and the approver deciding month rows heard
                                 only the cell's own fragments ("88 / 176 Under"): no
                                 resource, no month, and not the percentage that makes the
                                 band judgement checkable.
                                 An aria-label on the enclosing td would expose the name but
                                 REPLACE that visible reading; an sr-only child ADDS to it
                                 (same device as capacity.component.ts and
                                 list-state.component.ts:58). -->
                            <span class="sr-only">{{ c.aria }}</span>
                            <div class="text-sm font-bold font-mono tabular-nums {{ c.meta.text }}">
                              {{ c.total | number:'1.0-1' }} <span class="text-ink-muted font-normal">/ {{ c.target | number:'1.0-1' }}</span>
                            </div>
                            <!-- C1: dummy/subco have no capacity to saturate (spec §4.3) — the
                                 band LABEL is the saturation judgement, so it is never shown
                                 for them (the neutral 'idle' tokens above only supply a plain,
                                 uncoloured box, not a claim). -->
                            @if (c.tracksSaturation) {
                              <div class="text-[10px] font-bold uppercase tracking-wide {{ c.meta.text }}">{{ c.meta.label }}</div>
                            }
                          </div>
                        </td>
                      }
                      <td class="px-3 py-2 text-center">
                        <button type="button" (click)="openModal(row.resourceId)" data-test="open-modal" class="command-button secondary text-xs px-3 py-1.5 whitespace-nowrap">
                          Approve month
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        } @else if (!dataLoading() && !dataError()) {
          <div class="command-card p-12 text-center">
            <mat-icon class="text-[40px] w-[40px] h-[40px] text-ink-muted">fact_check</mat-icon>
            <p class="mt-3 text-sm font-medium text-ink-secondary">No allocation requests for the selected range and status.</p>
            <p class="text-xs text-ink-muted">Widen the month range or switch the status filter to All.</p>
          </div>
        }
        </ng-template>
      </app-list-state>

      <!-- Approval modal (Task 11 single-resource, Task 12 multi-resource): the
           standard modal backdrop + focus trap directive used across the app;
           the panel content lives in ApprovalModalComponent, which owns its
           own header/body/footer. -->
      @if ((modalResourceId() || multiMode()) && !calendarTarget()) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             appModal ariaLabelledby="approvalModalTitle" (dismiss)="closeModal()">
          <app-approval-modal
            [rows]="multiMode() ? selectedRows() : modalRows()"
            [months]="months()"
            [multi]="multiMode()"
            (decided)="reload()"
            (openCalendar)="openCalendar($event)"
            (closed)="closeModal()" />
        </div>
      }

      <!-- "Correct the hours" (spec §3.5): the approver's third power, reached
           per line from the modal above. Same component and same modal shape the
           staffing page uses — while it is open the approval modal is hidden, so
           only one focus trap is ever active (ResourceRequestsComponent does the
           same with its tracking modal). -->
      @if (calendarTarget(); as target) {
        <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 sm:p-6"
             appModal ariaLabelledby="allocCalTitle" (dismiss)="closeCalendar()">
          <app-allocation-calendar
            [assignmentId]="target.assignmentId"
            [resourceName]="target.resourceName"
            [focusMonth]="target.month"
            (closed)="closeCalendar()" />
        </div>
      }
    </div>
  `,
})
export class AllocationApprovalsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  /** 'Requested' = RPT "Richiesto" (Pending), 'Allocated' = "Confermato" (Approved). */
  protected statusFilter = signal<'all' | 'Requested' | 'Allocated'>('Requested');

  /**
   * Selected window. `null` means "not chosen yet" → let the server pick its
   * default window (the open planning periods) on first load; once loaded the
   * selectors are seeded from the returned months (see the seeding effect).
   * Read reactively as the range key, same pattern as CapacityComponent.
   */
  protected from = signal<string | null>(null);
  protected to = signal<string | null>(null);

  // D (Task 8): Capability / Practice / Competence / People Manager filters. '' = all.
  // The dimension filters are matched via `dimensionsOf`, not a raw equality against
  // a resource's organization — that is what makes a capability filter also match a
  // resource attached BELOW it (e.g. a competence two levels down).
  capabilityFilter = signal('');
  practiceFilter = signal('');
  competenceFilter = signal('');
  managerFilter = signal('');

  // The org tree (D). Gated on authReady like every other principal-gated read
  // here. This is the ONLY extra read this task needs: `AllocationApprovalRow`
  // now carries `organization` straight from the server (populated from the
  // SAME resource record the handler already loads to build the row), so
  // `dimensionsOf` reads `row.organization` directly below — no second
  // getResources() catalogue fetch, and therefore no client-side join to race
  // against `orgsRes`. (An earlier version of this fix DID add a second
  // `resourcesRes` load purely to recover `organization` — that was wrong: its
  // `organizationByResourceId` map could still be empty while `orgsRes` had
  // already resolved and `capabilityOptions` was already offering real values,
  // so picking a capability in that window silently filtered every row out —
  // "nothing to approve" when the truth was "not loaded yet". Deleting the
  // second fetch removes the race outright rather than guarding it.)
  private orgsRes = rxResource<ResourceOrganization[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResourceOrganizations() : of<ResourceOrganization[]>([])),
    defaultValue: [] as ResourceOrganization[],
  });

  /** Whether the org-tree read failed. Its OWN error state: `orgsRes` is a
   *  separate request from the feed, so the feed's `dataError()` says nothing
   *  about it and vice versa. */
  protected orgsError = computed(() => this.orgsRes.status() === 'error');

  /**
   * F4 — the ONE place `orgsRes.value()` is dereferenced.
   *
   * This used to be `this.orgsRes.value` handed out raw, so the three dimension
   * <select>s in the header read a `.value()` that THROWS while the org read is
   * erroring — a second ungated dereference, independent of the feed's, and one
   * that aborted the change-detection pass before the notice and the ListState
   * Retry panel further down could render.
   *
   * Falling back to `[]` is safe only because `orgsError()` withdraws the three
   * filters and says so (see the template): an empty option list left on screen
   * would claim "this organization has no capabilities", which is a different
   * and worse lie than "the tree could not be loaded". With the selects gone the
   * filters cannot be set either, so `filteredFeedRows` never asks
   * `dimensionsOf` to resolve a dimension against a tree that is not there.
   */
  private orgNodes = computed<ResourceOrganization[]>(() =>
    this.orgsError() ? [] : this.orgsRes.value(),
  );

  /** Option lists filtered by level, in tree order (node names are unique across the whole tree). */
  capabilityOptions = computed<string[]>(() => this.orgNodes().filter(n => n.level === 'capability').map(n => n.name));
  practiceOptions = computed<string[]>(() => this.orgNodes().filter(n => n.level === 'practice').map(n => n.name));
  competenceOptions = computed<string[]>(() => this.orgNodes().filter(n => n.level === 'competence').map(n => n.name));

  /**
   * Distinct People Managers actually present among the (unfiltered) feed
   * rows, name-sorted. D (Task 8, round 3): the display name is now served
   * directly as `row.managerName` (resolved server-side from the resourceById
   * map the handler already builds) — an EARLIER version of this resolved the
   * name by looking for the manager's OWN row in the same feed
   * (`resourceId === managerId`), which almost never exists (a feed lists a
   * manager's REPORTS, not the manager themselves), so that approach fell
   * back to a bare id in the common case — visibly broken to the approver.
   * The `?? id` fallback below is kept only as a last resort for a manager
   * whose resource record has genuinely vanished; it should be unreachable
   * in normal operation now.
   */
  managerFilterOptions = computed<{ id: string; name: string }[]>(() => {
    const rows = this.feed().rows;
    const ids = new Set(rows.map(r => r.managerId).filter((id): id is string => !!id));
    const nameByManagerId = new Map(rows.filter(r => r.managerId !== undefined).map(r => [r.managerId as string, r.managerName]));
    return [...ids]
      .map(id => ({ id, name: nameByManagerId.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  protected onCapabilityChange(event: Event): void {
    this.capabilityFilter.set((event.target as HTMLSelectElement).value);
  }
  protected onPracticeChange(event: Event): void {
    this.practiceFilter.set((event.target as HTMLSelectElement).value);
  }
  protected onCompetenceChange(event: Event): void {
    this.competenceFilter.set((event.target as HTMLSelectElement).value);
  }
  protected onManagerFilterChange(event: Event): void {
    this.managerFilter.set((event.target as HTMLSelectElement).value);
  }

  // Gated read: keyed on authReady + the selected range + the status filter so
  // it fires only after the OIDC bootstrap settles (bearer attached) and re-runs
  // when either changes. Until authReady it resolves to the empty default.
  private feedRes = rxResource<AllocationApprovalFeed, { ready: boolean; from: string | null; to: string | null; status: 'all' | 'Requested' | 'Allocated' }>({
    params: () => ({ ready: this.auth.authReady(), from: this.from(), to: this.to(), status: this.statusFilter() }),
    stream: ({ params }) => params.ready
      ? this.api.getAllocationApprovals(params.from ?? undefined, params.to ?? undefined, params.status)
      : of(EMPTY),
    defaultValue: EMPTY,
  });

  constructor() {
    // Seed the range selectors from the FIRST loaded window (server default).
    // Guarded on null so it runs once and never fights a later user choice; the
    // writes are untracked so this effect reacts only to the resource value.
    // F4: reads through `feed` (which short-circuits the error state) — an
    // effect that throws is reported as an unhandled error and, unlike a
    // template binding, no amount of markup reordering can protect it. A failed
    // read yields no months, so this simply does not seed.
    effect(() => {
      const months = this.feed().months;
      if (months.length === 0) return;
      untracked(() => {
        if (this.from() === null) this.from.set(months[0]);
        if (this.to() === null) this.to.set(months[months.length - 1]);
      });
    });

    // Selection belongs to the visible result set. Whenever a range, status,
    // organization or manager filter removes a row, prune its id so the toolbar
    // count and multi-approve payload cannot include an invisible resource.
    // F4: safe in the error state because `filteredFeedRows` reads BOTH guarded
    // accessors (`feed` and `orgNodes`) and nothing else — it used to throw here
    // for either failed read.
    effect(() => {
      const visibleIds = new Set(this.filteredFeedRows().map(row => row.resourceId));
      untracked(() => {
        const current = this.selectedResourceIds();
        const next = new Set([...current].filter(id => visibleIds.has(id)));
        if (next.size !== current.size) this.selectedResourceIds.set(next);
      });
    });
  }

  /**
   * F4 — the ONE place `feedRes.value()` is dereferenced.
   *
   * `rxResource.value()` THROWS while the resource is in its error state (the
   * previous `?? EMPTY` never fired: with a `defaultValue` set, `value()` is
   * never nullish — it either has data or throws). Every accessor below reads
   * this, and the bindings that consume them — `managerFilterOptions()` and
   * `monthOptions()` in the header, the two KPI tiles — sit ABOVE the access
   * notice and the ListState error panel, so the first of them aborted the whole
   * change-detection pass and left both affordances as unreachable code. The two
   * constructor effects read the same value from OUTSIDE the view, where no
   * template reordering could have protected them at all.
   *
   * Short-circuiting to EMPTY is NOT the forbidden "a failed read means nothing
   * to approve": `dataError()` gates the entire control cluster and the KPI
   * strip, ListState swaps the table for its error panel, and the "No allocation
   * requests for the selected range and status" empty state is already gated on
   * `!dataError()`. Nothing derived from this envelope reaches the screen while
   * the read is failing — the spec asserts that region by region.
   */
  protected feed = computed<AllocationApprovalFeed>(() =>
    this.feedRes.status() === 'error' ? EMPTY : this.feedRes.value(),
  );
  protected months = computed(() => this.feed().months);

  protected dataLoading = computed(() => this.feedRes.isLoading());
  protected dataError = computed(() => this.feedRes.status() === 'error');

  /**
   * ACCESS FEEDBACK: the gated read 401s until signed in and 403s for an
   * under-privileged role. 401/403 are not toasted, so say WHY instead of
   * showing a silently empty table.
   */
  protected accessNotice = computed<string | null>(() => {
    if (this.feedRes.status() !== 'error') return null;
    return this.auth.isAuthenticated()
      ? 'Your role does not have access to allocation approvals. Resource managers, delivery executives and admins can review pending months.'
      : 'Sign in to view allocation approvals.';
  });

  protected reload(): void {
    this.feedRes.reload();
  }

  /**
   * The feed's raw rows narrowed by the capability/practice/competence/People
   * Manager filters — shared by `rows` (the grid) and `pendingMonths` (the KPI
   * strip) so both stay consistent with the filter, not just the grid. The org
   * dimensions are derived through `dimensionsOf` from `row.organization`
   * (server-populated on `AllocationApprovalRow` directly — no client-side
   * join) — never a raw equality check, so a capability filter also matches a
   * resource attached BELOW it (e.g. a competence two levels down).
   */
  private filteredFeedRows = computed<AllocationApprovalRow[]>(() => {
    const cap = this.capabilityFilter();
    const pra = this.practiceFilter();
    const com = this.competenceFilter();
    const mgr = this.managerFilter();
    const nodes = this.orgNodes();
    return this.feed().rows.filter(r => {
      const dims = dimensionsOf({ id: r.resourceId, organization: r.organization }, nodes);
      if (cap && dims.capability !== cap) return false;
      if (pra && dims.practice !== pra) return false;
      if (com && dims.competence !== com) return false;
      if (mgr && r.managerId !== mgr) return false;
      return true;
    });
  });

  /** Grid rows (view models) — one per resource, cells across every month in range. */
  protected rows = computed<RowVm[]>(() => {
    const months = this.feed().months;
    return this.filteredFeedRows().map(r => ({
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      kind: r.kind,
      hasPending: r.items.some(i => i.status === 'Requested'),
      cells: months.map(m => this.toCellVm(r, m)),
    }));
  });

  /** Public: the spec asserts on it, and the multi-resource mode reads it. */
  selectedResourceIds = signal<ReadonlySet<string>>(new Set());

  /** Set while the single-resource approval modal is open. */
  protected modalResourceId = signal<string | null>(null);
  /** Set while the multi-resource approve modal is open. */
  protected multiMode = signal(false);

  protected toggleResource(resourceId: string): void {
    this.selectedResourceIds.update(current => {
      const next = new Set(current);
      if (!next.delete(resourceId)) next.add(resourceId);
      return next;
    });
  }

  protected openModal(resourceId: string): void {
    this.modalResourceId.set(resourceId);
  }

  protected closeModal(): void {
    // Closing a completed multi-approve flow must also drop the toolbar
    // checkbox selection — otherwise the page keeps showing checked rows and a
    // stale "Approve selected (N)" count after the modal is gone. Single-
    // resource close (openModal) never touched the selection, so leave it be.
    if (this.multiMode()) {
      this.selectedResourceIds.set(new Set());
    }
    this.modalResourceId.set(null);
    this.multiMode.set(false);
  }

  /** The modal's `rows` input: the single resource behind `modalResourceId`, as
   *  a one-element array of its full `AllocationApprovalRow` (with `items`) —
   *  NOT `rows()` above, whose `RowVm` view models carry only grid cells, never
   *  `items`. Reflects the page's current status filter (e.g. under the default
   *  'Requested'/Pending filter the modal only lists pending items for that
   *  month; switch the page to 'All' first to also see already-decided
   *  siblings). Empty when no modal is open, or the target resource dropped out
   *  of the feed (e.g. a reload after deciding its only pending item under the
   *  Pending filter) — the modal then simply shows "no projects this month". */
  protected modalRows = computed<AllocationApprovalRow[]>(() => {
    const id = this.modalResourceId();
    if (!id) return [];
    const row = this.feed().rows.find(r => r.resourceId === id);
    return row ? [row] : [];
  });

  /** The modal's `rows` input in multi mode: every currently-selected
   *  resource's full `AllocationApprovalRow` (with `items`) from the current
   *  feed, in the same shape `modalRows` uses for the single-resource case. */
  protected selectedRows = computed<AllocationApprovalRow[]>(() => {
    const ids = this.selectedResourceIds();
    return this.feed().rows.filter(r => ids.has(r.resourceId));
  });

  protected openMultiApprove(): void {
    this.multiMode.set(true);
  }

  /** The assignment/month whose allocation calendar is open on top of the modal. */
  protected calendarTarget = signal<{ assignmentId: string; resourceName: string; month: string } | null>(null);

  protected openCalendar(target: { assignmentId: string; resourceName: string; month: string }): void {
    this.calendarTarget.set(target);
  }

  /** Closing the calendar reveals the approval modal again and reloads the feed:
   *  the approver may have corrected the hours, which re-opens the month's
   *  approval server-side, so the listed state would otherwise be stale. */
  protected closeCalendar(): void {
    this.calendarTarget.set(null);
    this.reload();
  }

  // --- KPI strip -------------------------------------------------------
  /** Resources with at least one 'Requested' item in the CURRENT (filtered) listing. */
  protected pendingResourceCount = computed(() => this.rows().filter(r => r.hasPending).length);
  /**
   * Total 'Requested' (assignment, month) items across every resource
   * currently listed. D (Task 8): reduces over `filteredFeedRows`, the SAME
   * capability/practice/competence/People-Manager-narrowed set `rows` builds
   * its grid from — not the raw `feed().rows` — so this KPI never disagrees
   * with "Resources Pending" above it (e.g. showing a pending month for a
   * capability the grid has just filtered down to zero resources for).
   */
  protected pendingMonths = computed(() =>
    this.filteredFeedRows().reduce((n, r) => n + r.items.filter(i => i.status === 'Requested').length, 0));

  /** Range-selector options: the loaded window padded by ±OPTION_PAD_MONTHS so the user can narrow OR extend. */
  protected monthOptions = computed<string[]>(() => {
    const ms = this.months();
    if (ms.length === 0) return [];
    return monthsInRange(shiftMonth(ms[0], -OPTION_PAD_MONTHS), shiftMonth(ms[ms.length - 1], OPTION_PAD_MONTHS));
  });

  protected readonly legend = [
    { band: 'idle' as const, meta: BAND_META.idle },
    { band: 'under' as const, meta: BAND_META.under },
    { band: 'healthy' as const, meta: BAND_META.healthy },
    { band: 'over' as const, meta: BAND_META.over },
  ];

  // --- filter handlers (string 'YYYY-MM' compares lexicographically) --
  protected onFromChange(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.from.set(v);
    const to = this.to();
    if (to && v > to) this.to.set(v);
  }

  protected onToChange(event: Event): void {
    const v = (event.target as HTMLSelectElement).value;
    this.to.set(v);
    const from = this.from();
    if (from && v < from) this.from.set(v);
  }

  protected onStatusChange(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value as 'all' | 'Requested' | 'Allocated');
  }

  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  protected monthLabel(month: string): string {
    return AllocationApprovalsComponent.MONTH_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  private static readonly MONTH_LONG_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  private monthLabelLong(month: string): string {
    return AllocationApprovalsComponent.MONTH_LONG_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  /**
   * Build one cell view model. `total`/`target` come straight from the row's
   * `totalHours`/`targetHours` maps — NEVER re-derived from `items`, since
   * `items` is narrowed by the status filter while these totals are not
   * (server contract this page must not misrepresent).
   *
   * C1: a dummy/subco row's `contractHoursPerDay` (and therefore `target`) is
   * deliberately NOT widened by the multi-FTE factor (the server keeps it at
   * the 1-FTE-equivalent base — see `GET /allocation-approvals` in
   * server.ts), so a percentage/band computed against it would call a
   * legitimate 20h/day dummy booking "250% — Over" on the approver's
   * dashboard. Those rows skip the saturation judgement entirely
   * (`tracksSaturation: false`) — the template renders the hours plainly,
   * neutrally styled, with no band tint or label. The numbers themselves
   * (`total`/`target`) are still returned and still shown.
   */
  private toCellVm(row: AllocationApprovalRow, month: string): CellVm {
    const target = row.targetHours[month] ?? 0;
    const total = row.totalHours[month] ?? 0;
    const tracksSaturation = row.kind === 'internal';
    if (!tracksSaturation) {
      const aria = `${row.resourceName}, ${this.monthLabelLong(month)}: ${Math.round(total)}h booked (${row.kind} — no saturation band).`;
      return { month, total, target, band: 'idle', meta: BAND_META.idle, aria, tracksSaturation };
    }
    const pct = target > 0 ? (total / target) * 100 : 0;
    const band = semaphoreBand(pct);
    const meta = BAND_META[band];
    const aria =
      `${row.resourceName}, ${this.monthLabelLong(month)}: ${Math.round(total)}h of ${Math.round(target)}h target ` +
      `(${Math.round(pct)}%). Utilisation band: ${meta.label}.`;
    return { month, total, target, band, meta, aria, tracksSaturation };
  }
}
