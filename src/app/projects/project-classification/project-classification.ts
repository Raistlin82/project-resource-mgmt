import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  ApiService,
  BillingPlanItem,
  PROJECT_TYPES,
  Project,
  ProjectType,
} from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ModalDialogDirective } from '../../directives/modal-dialog.directive';
import { ListStateComponent } from '../../shared/list-state.component';

/**
 * ENGAGEMENT CLASSIFICATION — block H, task T8.
 *
 * The screen behind `PUT /projects/:id/classification`: the only way `billable`
 * and `type` ever move. Both fields are deliberately absent from
 * `PROJECT_FIELDS`, so the ordinary project form cannot touch them, and the
 * server answers 403 to a `POST`/`PUT /projects` body that carries either.
 *
 * WHY ITS OWN SCREEN AND ITS OWN ROLE SET. Declaring an engagement
 * non-billable switches OFF a revenue expectation and its margin alerts, and
 * pulls the engagement out of customer profitability and realization. That is a
 * financial act, not master data — hence `delivery-executive` / `finance` /
 * `admin`, and hence `pm` excluded although a PM may otherwise mutate
 * `/projects`: whoever is measured on an engagement's margin must not be able
 * to declare that the engagement has no margin.
 *
 * TWO SERVER RULES THIS UI MUST NOT LET THE USER WALK INTO BLIND:
 *   1. `type === 'Basket'` ⇒ `billable === false` (400). The billable control is
 *      FORCED and locked once Basket is chosen, and the payload is built from
 *      the derived value, so the invalid pair cannot be composed at all.
 *   2. Flipping to non-billable while billing plan items still name the
 *      engagement (409). Warned before the click and, when it happens anyway,
 *      rendered with the items to remove rather than as a generic toast.
 */
@Component({
  selector: 'app-project-classification',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, ModalDialogDirective, ListStateComponent],
  template: `
    <div class="command-page max-w-6xl mx-auto space-y-6">
      <div class="min-w-0">
        <div class="command-section-label">Project Control</div>
        <h1 class="font-display text-2xl sm:text-3xl font-bold text-[var(--cc-ink)] tracking-tight">Engagement Classification</h1>
        <p class="mt-1 text-sm text-[var(--cc-muted)]">
          Declare whether an engagement produces customer revenue. A non-billable engagement still
          consumes and reports cost — it leaves margin alerts, customer profitability and realization,
          and it can never carry a billing plan item.
        </p>
      </div>

      @if (itemsUnavailable()) {
        <p role="status" data-test="classification-items-unavailable"
           class="rounded-xl bg-caution-tint text-caution-text ring-1 ring-caution p-3 text-sm">
          The billing plan could not be read, so the item counts show an em dash rather than zero.
          Classifying still works, and the server still refuses a non-billable flip while items reference the engagement.
        </p>
      }

      <app-list-state [loading]="projectsRes.isLoading()" [error]="projectsRes.status() === 'error'"
                      skeleton="table-rows" [rows]="5" [columns]="5" label="engagements"
                      (retry)="projectsRes.reload()">
        <ng-template>
          <div class="command-card overflow-x-auto">
            <table class="command-data-table min-w-[48rem]" data-test="classification-table">
              <thead>
                <tr>
                  <th class="px-6 py-4 font-medium">Engagement</th>
                  <th class="px-6 py-4 font-medium">Type</th>
                  <th class="px-6 py-4 font-medium">Billability</th>
                  <th class="px-6 py-4 font-medium text-right">Billing plan items</th>
                  <th class="px-6 py-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-[var(--cc-line)]">
                @for (row of rows(); track row.id) {
                  <tr [attr.data-test]="'classification-row-' + row.id">
                    <td class="px-6 py-4 font-medium text-[var(--cc-ink)]">{{ row.name }}</td>
                    <td class="px-6 py-4">
                      <span class="command-chip" [class.is-info]="row.type === 'Basket'"
                            [class.is-neutral]="row.type !== 'Basket'"
                            [attr.data-test]="'classification-type-' + row.id">{{ row.type }}</span>
                    </td>
                    <!-- The word carries the whole signal; the tone is redundant
                         (WCAG 1.4.1), never the only channel. -->
                    <td class="px-6 py-4">
                      <span class="command-chip" [class.is-positive]="row.billable"
                            [class.is-caution]="!row.billable"
                            [attr.data-test]="'classification-billable-' + row.id">{{ row.billableLabel }}</span>
                    </td>
                    <td class="px-6 py-4 text-right text-[var(--cc-muted)]"
                        [attr.data-test]="'classification-items-' + row.id">{{ row.itemCount }}</td>
                    <td class="px-6 py-4 text-right">
                      <button type="button" (click)="openFor(row.project)"
                              [attr.data-test]="'classify-' + row.id"
                              [attr.aria-label]="'Classify ' + row.name" [attr.title]="'Classify ' + row.name"
                              class="command-button secondary">Classify</button>
                    </td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="px-6 py-8 text-center text-[var(--cc-muted)]" data-test="classification-empty">
                      No engagements yet.
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </ng-template>
      </app-list-state>

      @if (editing(); as project) {
        <div data-test="classification-overlay"
             class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-start sm:items-center justify-center z-50 p-4 sm:p-6 overflow-y-auto"
             appModal ariaLabelledby="classificationModalTitle" (dismiss)="close()">
          <div data-test="classification-panel" class="command-card shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[90vh]">
            <div class="command-card-header">
              <h2 id="classificationModalTitle" class="font-display text-xl font-bold text-[var(--cc-ink)]">Classify {{ project.name }}</h2>
              <button type="button" (click)="close()" aria-label="Close dialog" title="Close"
                      class="text-ink-muted hover:text-ink-secondary transition-colors">
                <mat-icon>close</mat-icon>
              </button>
            </div>

            <div class="p-6 space-y-5 overflow-y-auto flex-1 min-h-0">
              <!-- GATE 2, rendered as the server sent it plus the rows to act on.
                   A generic toast here would tell a delivery executive that "something
                   went wrong" about a refusal whose whole content is a list. -->
              @if (blocked(); as refusal) {
                <div role="alert" data-test="classification-blocked"
                     class="rounded-xl bg-critical-tint text-critical-text ring-1 ring-critical p-4 space-y-2">
                  <p class="font-semibold flex items-center gap-2">
                    <mat-icon aria-hidden="true" class="text-[18px] w-[18px] h-[18px]">block</mat-icon>
                    Refused — billing plan items still reference this engagement
                  </p>
                  <p class="text-sm">{{ refusal }}</p>
                  @if (blockingItems().length > 0) {
                    <ul class="text-sm list-disc pl-5" data-test="classification-blocking-items">
                      @for (item of blockingItems(); track item.id) {
                        <li>{{ item.label }} — {{ item.type }}, {{ item.status }}</li>
                      }
                    </ul>
                  }
                  <p class="text-sm">Remove or re-target those items on the billing plan, then classify this engagement again.</p>
                </div>
              }
              @if (saveError(); as err) {
                <p role="alert" data-test="classification-error" class="text-sm text-critical-text">{{ err }}</p>
              }

              <div>
                <label for="classificationType" class="block text-sm font-semibold text-ink-secondary mb-1.5">Type</label>
                <select id="classificationType" (change)="onTypeChange($event)"
                        data-test="classification-type-select" class="command-select">
                  @for (t of TYPES; track t) {
                    <option [value]="t" [selected]="t === type()">{{ t }}</option>
                  }
                </select>
                <p class="mt-1 text-xs text-[var(--cc-muted)]">
                  <strong>Delivery</strong> is a normal engagement. <strong>Basket</strong> is the practice's dedicated
                  non-billable engagement — leave, AMS duty, technical groups, internal presidio.
                </p>
              </div>

              <div>
                <span class="block text-sm font-semibold text-ink-secondary mb-1.5">Billability</span>
                <!-- THE INVARIANT IS EXPRESSED IN THE CONTROL, not merely checked
                     after it. Choosing Basket forces billable to false and locks the
                     checkbox, with the reason as its accessible description while it
                     is disabled (P2-18). The payload reads billable(), the DERIVED
                     value, so no interaction order can compose Basket + billable. -->
                <label class="flex items-start gap-2 text-sm text-[var(--cc-ink)]">
                  <input type="checkbox" [checked]="billable()" [disabled]="billableLocked()"
                         (change)="billableChoice.set(readChecked($event))"
                         [attr.aria-describedby]="billableLocked() ? 'classificationBasketHint' : null"
                         data-test="classification-billable-input"
                         class="mt-0.5 disabled:opacity-50 disabled:cursor-not-allowed">
                  <span>This engagement produces customer revenue (billable)</span>
                </label>
                @if (billableLocked()) {
                  <p id="classificationBasketHint" data-test="classification-basket-hint"
                     class="mt-1 text-xs text-[var(--cc-muted)]">{{ BASKET_HINT }}</p>
                }
              </div>

              <!-- The 409 announced BEFORE the click. Deliberately a warning and not
                   a disabled Save: the server owns this rule, and a client-side gate
                   would either drift from it or hide it. The user gets the list to
                   act on, and the authoritative refusal still arrives if they go on. -->
              @if (willBeRefused(); as count) {
                <p role="status" data-test="classification-precheck"
                   class="rounded-xl bg-caution-tint text-caution-text ring-1 ring-caution p-3 text-sm">
                  {{ count }} billing plan item(s) still reference this engagement. Marking it non-billable
                  will be refused until they are removed.
                </p>
              }
            </div>

            <div class="px-6 py-4 border-t border-[var(--cc-line)] bg-[var(--cc-panel-muted)] flex justify-end gap-3">
              <button type="button" (click)="close()" class="command-button secondary">Cancel</button>
              <button type="button" (click)="save()" [disabled]="!changed()"
                      [attr.aria-describedby]="changed() ? null : 'classificationUnchangedHint'"
                      data-test="classification-save"
                      class="command-button disabled:opacity-50 disabled:cursor-not-allowed">Save classification</button>
            </div>
            @if (!changed()) {
              <p id="classificationUnchangedHint" data-test="classification-unchanged-hint"
                 class="px-6 pb-4 text-right text-xs text-[var(--cc-muted)]">Nothing has changed yet.</p>
            }
          </div>
        </div>
      }
    </div>
  `,
})
export class ProjectClassificationComponent {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly TYPES = PROJECT_TYPES;
  protected readonly BASKET_HINT =
    'A Basket engagement is non-billable by definition, so billability is fixed to "no" while Basket is selected.';

  readonly projectsRes = rxResource<Project[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getProjects() : of<Project[]>([])),
    defaultValue: [] as Project[],
  });

  /**
   * The billing plan, read ONLY to name what blocks a flip. All three roles this
   * screen admits are inside the `/billing-plan-items` READ_RULE
   * (sales/finance/delivery-executive/admin), so the read is legitimate rather
   * than hopeful.
   *
   * Its failure is NOT this screen's failure, and the shape below is what makes
   * that true. The failure is caught IN THE STREAM and resolved to `null`, so
   * the resource never enters its error state and `value()` never throws — the
   * latch that would otherwise take the whole table down with it. (Reading
   * `status() === 'error' ? [] : value()` instead is the banned accessor, and it
   * would also erase the distinction below.)
   *
   * `null` means "could not load", which is NOT the same claim as "this
   * engagement has no billing plan items" — one is ignorance, the other is a
   * fact about the engagement, and the count column must not print the second
   * when it holds the first. The server's 409 remains the guarantee either way.
   */
  private readonly billingItemsRes = rxResource<BillingPlanItem[] | null, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready
      ? this.api.getBillingPlanItems().pipe(catchError(() => of(null)))
      : of<BillingPlanItem[]>([])),
    defaultValue: [] as BillingPlanItem[] | null,
  });

  /** True when the billing plan could not be read at all — see the resource above. */
  readonly itemsUnavailable = computed(() => this.billingItemsRes.value() === null);

  private readonly itemsByProject = computed(() => {
    const map = new Map<string, BillingPlanItem[]>();
    for (const item of this.billingItemsRes.value() ?? []) {
      if (!item.projectId) continue;
      const bucket = map.get(item.projectId);
      if (bucket) bucket.push(item);
      else map.set(item.projectId, [item]);
    }
    return map;
  });

  readonly rows = computed(() =>
    this.projectsRes.value().map(project => ({
      id: project.id,
      project,
      name: project.name,
      // Both fields are optional on the wire and both read DEFENSIVELY: an absent
      // `billable` means billable, which keeps margin alerts on rather than
      // silently switching them off for a row the backend simply did not spell out.
      type: project.type ?? 'Delivery',
      billable: project.billable ?? true,
      billableLabel: (project.billable ?? true) ? 'Billable' : 'Not billable',
      // An em dash, never 0, when the plan could not be read: printing 0 would
      // assert "nothing references this engagement", which is the one thing this
      // screen must not get wrong.
      itemCount: this.itemsUnavailable() ? '—' : String(this.itemsByProject().get(project.id)?.length ?? 0),
    })));

  editing = signal<Project | null>(null);
  type = signal<ProjectType>('Delivery');
  /**
   * The user's raw choice for billability, which is NOT what gets sent. Basket
   * overrides it; see {@link billable}. Keeping the raw choice means switching
   * Basket → Delivery restores what the user had picked rather than silently
   * leaving them on "not billable".
   */
  billableChoice = signal(true);
  saveError = signal<string | null>(null);
  blocked = signal<string | null>(null);

  /** The invariant, applied where it cannot be bypassed: at the value itself. */
  readonly billable = computed(() => (this.type() === 'Basket' ? false : this.billableChoice()));
  readonly billableLocked = computed(() => this.type() === 'Basket');

  /** Items naming the engagement being edited — the "what to remove" list. */
  readonly blockingItems = computed(() => {
    const project = this.editing();
    return project ? (this.itemsByProject().get(project.id) ?? []) : [];
  });

  /** Non-zero only when the pending classification would hit gate 2. */
  readonly willBeRefused = computed(() => {
    if (this.billable()) return 0;
    return this.blockingItems().length;
  });

  /** Does the pending pair differ from what is stored? */
  readonly changed = computed(() => {
    const project = this.editing();
    if (!project) return false;
    return (project.billable ?? true) !== this.billable() || (project.type ?? 'Delivery') !== this.type();
  });

  openFor(project: Project): void {
    this.editing.set(project);
    this.type.set(project.type ?? 'Delivery');
    this.billableChoice.set(project.billable ?? true);
    this.saveError.set(null);
    this.blocked.set(null);
  }

  close(): void {
    this.editing.set(null);
    this.saveError.set(null);
    this.blocked.set(null);
  }

  protected onTypeChange(event: Event): void {
    const raw = (event.target as HTMLSelectElement | null)?.value ?? 'Delivery';
    this.type.set((PROJECT_TYPES as readonly string[]).includes(raw) ? (raw as ProjectType) : 'Delivery');
  }

  protected readChecked(event: Event): boolean {
    return (event.target as HTMLInputElement | null)?.checked ?? false;
  }

  save(): void {
    const project = this.editing();
    if (!project || !this.changed()) return;
    this.saveError.set(null);
    this.blocked.set(null);
    // `billable()`, never `billableChoice()`: the derived value is what makes the
    // Basket invariant impossible to compose from this screen.
    this.api.classifyProject(project.id, { billable: this.billable(), type: this.type() })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.projectsRes.reload();
          this.close();
        },
        error: (e: unknown) => {
          const err = e as { status?: number; error?: { error?: string } };
          const message = err?.error?.error ?? null;
          // 409 is gate 2 and has its own panel, which stays open over the form so
          // the user can change the choice without re-opening anything. Anything
          // else is an ordinary refusal.
          if (err?.status === 409) {
            this.blocked.set(message ?? 'Billing plan items still reference this engagement.');
          } else {
            this.saveError.set(message ?? 'Could not change the classification.');
          }
        },
      });
  }
}
