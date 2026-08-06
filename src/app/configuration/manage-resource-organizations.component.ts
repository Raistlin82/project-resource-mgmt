import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, signal, computed } from '@angular/core';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { of } from 'rxjs';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { ApiService, ResourceOrganization, CostCenter, ServiceOrganization, Resource } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ModalDialogDirective } from '../directives/modal-dialog.directive';
import { ORG_LEVELS, ancestorChain, descendantOrgIds, type OrgLevel } from '../services/org-scope.util';
import { countsTowardInternalCapacity, kindOf } from '../services/resource-kind.util';
import { todayLocalIso } from '../services/local-date.util';
import { authGatedResource } from '../services/auth-gated-resource.util';
import { MultiSelectChipsComponent, type MultiSelectOption } from '../shared/multi-select-chips.component';

/** One rendered tree row: the node plus its indentation depth (root = 0). */
interface OrgTreeRow {
  org: ResourceOrganization;
  depth: number;
}

/** Today as ISO 'YYYY-MM-DD' — matches ResourcesComponent.isTerminated's own
 *  local helper exactly, so a candidate manager is filtered out here under the
 *  SAME rule the People page shows it terminated under. */
function todayIso(): string {
  return todayLocalIso();
}

@Component({
  selector: 'app-manage-resource-organizations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatIconModule, ModalDialogDirective, MultiSelectChipsComponent],
  template: `
    <div class="command-page space-y-6">
    <div class="command-card overflow-hidden">
      <div class="command-card-header">
        <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">Manage Resource Organizations</h2>
        <button (click)="openForm()" class="command-button">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Create Organization
        </button>
      </div>

      @if (showForm()) {
        <div class="p-6 sm:p-8 border-b border-[var(--cc-line)] bg-[var(--cc-panel-muted)]">
          <form [formGroup]="orgForm" (ngSubmit)="save()" class="space-y-6 max-w-3xl">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="orgName" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Name</label>
                <input id="orgName" type="text" formControlName="name" class="command-input">
              </div>
              <div>
                <label for="orgDescription" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Description</label>
                <input id="orgDescription" type="text" formControlName="description" class="command-input">
              </div>
            </div>

            <!-- D: the delivery tree — level, and (for anything but a capability) the
                 parent. This is a DIFFERENT axis from serviceOrganizationId below
                 (financial belonging); never merge or reorder the two. -->
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="orgLevel" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Level</label>
                <select id="orgLevel" formControlName="level" data-test="org-level" class="command-select disabled:opacity-50 disabled:cursor-not-allowed">
                  @for (l of orgLevels; track l) {
                    <option [value]="l">{{ levelLabel(l) }}</option>
                  }
                </select>
                @if (hasChildren()) {
                  <p class="mt-1 text-xs text-[var(--cc-muted)]">This node has children — its level cannot change while they exist.</p>
                }
              </div>
              @if (levelValue() !== 'capability') {
                <div>
                  <label for="orgParent" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Parent {{ levelLabel(parentLevel()!) }}</label>
                  <!-- TRAP (twice reached the browser in this repo): never bind [value] on
                       a <select> whose <option>s come from an @for — the binding is applied
                       before the options exist and is silently dropped. Per-option [selected]
                       instead (established pattern: allocation-approvals.component.ts's
                       From/To range selects). No formControlName here for the same reason:
                       this is a genuinely plain, non-Forms-module select. -->
                  <select id="orgParent" data-test="org-parent" class="command-select"
                          (change)="onParentChange($event)"
                          [attr.aria-invalid]="parentMissing()">
                    <option value="" [selected]="formParentId() === ''">— Select a parent —</option>
                    @for (p of parentOptions(); track p.id) {
                      <option [value]="p.id" [selected]="p.id === formParentId()">{{ p.name }}</option>
                    }
                    @if (orphanParent(); as orphan) {
                      <option [value]="orphan.id" disabled [selected]="orphan.id === formParentId()">{{ orphan.name }} (not selectable)</option>
                    }
                  </select>
                  @if (parentMissing()) {
                    <p role="alert" class="mt-1 text-xs text-critical-text">A {{ levelValue() }} must have a parent.</p>
                  }
                </div>
              }
            </div>

            <div>
              <label for="orgManager" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Manager</label>
              <!-- The resource who manages this node (Capability Leader / Practice
                   Manager / Competence Manager — the level says which). Same
                   plain-select + per-option [selected] pattern as the parent select
                   above, for the same reason. -->
              <select id="orgManager" data-test="org-manager" class="command-select" (change)="onManagerChange($event)">
                <option value="" [selected]="formManagerId() === ''">— None —</option>
                @for (m of managerOptions(); track m.id) {
                  <option [value]="m.id" [selected]="m.id === formManagerId()">{{ m.name }}</option>
                }
                @if (orphanManagerResource(); as orphan) {
                  <option [value]="orphan.id" disabled [selected]="orphan.id === formManagerId()">{{ orphan.name }} (not selectable)</option>
                }
              </select>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label for="orgServiceOrg" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Service Organization</label>
                <!-- serviceOrganizationId is an FK to the service-organizations catalog (by id). -->
                <select id="orgServiceOrg" formControlName="serviceOrganizationId" class="command-select">
                  <option value="">— None —</option>
                  @for (so of serviceOrgOptions(); track so.id) {
                    <option [value]="so.id">{{ so.code }} — {{ so.description }}</option>
                  }
                  @if (orphanServiceOrg(); as orphan) {
                    <option [value]="orphan" disabled>{{ orphan }} (not in catalog)</option>
                  }
                </select>
              </div>
              <div>
                <label for="orgCostCenters" class="block text-xs font-bold text-[var(--cc-muted)] uppercase tracking-wider mb-2">Cost Centers</label>
                <!-- costCenters[] is a MULTI-value FK to the cost-centers catalog (by id).
                     UX register P2-19: this was a <select multiple>, which needs a
                     Ctrl/Cmd-click to hold a second cost centre — impossible on touch,
                     where picking a second one silently REPLACED the first. These ids feed
                     cost allocation, so that replacement was a silent money-side data
                     change. Now the shared choose-then-add + removable-chip primitive,
                     which keeps the ORPHAN contract this select already had (a stored id
                     the catalog no longer offers stays on the node and stays removable):
                     the model is the raw id array and the primitive never intersects it
                     with its option list. -->
                <app-multi-select-chips formControlName="costCenters" inputId="orgCostCenters"
                                        [options]="costCenterChipOptions()"
                                        pickerLabel="Cost center to add"
                                        placeholder="Select a cost center..."
                                        emptyText="No cost centers assigned yet." />
              </div>
            </div>

            <div class="flex justify-end gap-3 pt-6 border-t border-[var(--cc-line)]">
              <button type="button" (click)="closeForm()" class="command-button secondary">Cancel</button>
              <button type="submit" [disabled]="orgForm.invalid || parentMissing()" class="command-button disabled:opacity-50 disabled:cursor-not-allowed">
                {{ editingId() ? 'Save changes' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      }

      <div class="p-6 sm:p-8">
        <div class="overflow-x-auto">
          <table class="command-data-table">
            <thead>
              <tr>
                <th class="w-1/4">Name</th>
                <th>Level</th>
                <th>Parent</th>
                <th>Manager</th>
                <th>Description</th>
                <th>Service Org</th>
                <th>Cost Centers</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              @for (row of orgTree(); track row.org.id) {
                <tr [attr.data-test]="'org-node-' + row.org.id" [attr.data-depth]="row.depth">
                  <td class="font-bold text-base">
                    <span [style.padding-left.px]="row.depth * 20">{{ row.org.name }}</span>
                  </td>
                  <td><span class="command-status">{{ levelLabel(row.org.level) }}</span></td>
                  <td><span class="text-[var(--cc-muted)]">{{ parentLabel(row.org) }}</span></td>
                  <td><span class="text-[var(--cc-muted)]">{{ managerLabel(row.org) }}</span></td>
                  <td class="font-medium"><span class="text-[var(--cc-muted)]">{{ row.org.description }}</span></td>
                  <td><span class="text-[var(--cc-muted)]">{{ serviceOrgLabel(row.org.serviceOrganizationId) }}</span></td>
                  <td>
                    <div class="flex flex-wrap gap-2">
                      @for (cc of row.org.costCenters; track cc) {
                        <span class="command-status">
                          {{ cc }}
                        </span>
                      }
                    </div>
                  </td>
                  <td class="text-right whitespace-nowrap">
                    <button (click)="openForm(row.org)" [attr.aria-label]="'Edit resource organization ' + row.org.name" [attr.title]="'Edit resource organization ' + row.org.name" class="text-ink-muted hover:text-accent-text transition-colors p-1">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">edit</mat-icon>
                    </button>
                    <button (click)="deleteOrg(row.org.id)" class="w-10 h-10 rounded-full bg-surface-muted border border-line text-ink-muted hover:text-critical-text hover:border-critical hover:bg-critical-tint transition-all inline-flex items-center justify-center shadow-sm" [attr.aria-label]="'Delete resource organization ' + row.org.name" [attr.title]="'Delete resource organization ' + row.org.name">
                      <mat-icon class="text-[20px] w-[20px] h-[20px]">delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    @if (deletingId()) {
      <div class="fixed inset-0 bg-scrim/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
           appModal ariaLabelledby="resourceOrgDeleteTitle" (dismiss)="cancelDelete()">
        <div class="command-card shadow-2xl w-full max-w-sm overflow-hidden flex flex-col transform transition-all">
          <div class="p-8 text-center">
            <div class="w-20 h-20 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center mx-auto mb-5 shadow-inner">
              <mat-icon class="text-critical-text text-4xl">warning</mat-icon>
            </div>
            <h3 id="resourceOrgDeleteTitle" class="font-display text-2xl font-bold text-[var(--cc-ink)] mb-2 tracking-tight">Delete Resource Organization</h3>
            <p class="text-[var(--cc-muted)] text-sm">Are you sure you want to delete this resource organization? This action cannot be undone. A node with children, or one still referenced by a resource, will be refused.</p>
          </div>
          <div class="p-5 bg-[var(--cc-panel-muted)] border-t border-[var(--cc-line)] flex justify-end gap-3">
            <button (click)="cancelDelete()" class="command-button secondary">Cancel</button>
            <button (click)="confirmDelete()" class="px-6 py-2.5 bg-critical-tint text-critical-text ring-1 ring-critical rounded-xl text-sm font-semibold hover:bg-[color-mix(in_oklch,var(--color-critical)_16%,var(--color-surface))] hover:shadow-md hover:-translate-y-0.5 transition-all">Delete</button>
          </div>
        </div>
      </div>
    }
    </div>
  `
})
export class ManageResourceOrganizationsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private fb = inject(FormBuilder);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  private orgsRes = authGatedResource(() => this.api.getResourceOrganizations(), [] as ResourceOrganization[]);
  resourceOrganizations = computed(() => this.orgsRes.value());
  showForm = signal(false);
  editingId = signal<string | null>(null);
  deletingId = signal<string | null>(null);

  // PHASE F2 — costCenters[] -> cost-centers catalog (multi, by id), serviceOrganizationId
  // -> service-organizations (by id). Cost-center options are finance-grade reads.
  private costCentersRes = rxResource<CostCenter[], boolean>({
    params: () => this.auth.authReady() && this.auth.canApproveFinancials(),
    stream: ({ params: canLoad }) => (canLoad ? this.api.getCostCenters() : of<CostCenter[]>([])),
    defaultValue: [] as CostCenter[],
  });
  private serviceOrgsRes = authGatedResource(() => this.api.getServiceOrganizations(), [] as ServiceOrganization[]);
  costCenterOptions = this.costCentersRes.value;
  serviceOrgOptions = this.serviceOrgsRes.value;

  // D: the manager select — Principal-gated read, so key on authReady like
  // the resources.component.ts convention.
  private resourcesRes = rxResource<Resource[], boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) => (ready ? this.api.getResources() : of<Resource[]>([])),
    defaultValue: [] as Resource[],
  });
  resources = this.resourcesRes.value;

  // REVIEW ROUND 1 (critical) — a dummy or terminated resource must NEVER be
  // offered here, the same rule (and the same reused helpers) as
  // ResourcesComponent's own People Manager select. This is not cosmetic
  // parity: `managerId` on an org node feeds `scopedApproversOf`, which adds
  // every ancestor node's manager into the candidate set regardless of
  // whether that id belongs to an authenticatable user. Pick a dummy as a
  // Capability Leader and `roleFallback` becomes FALSE for everyone under that
  // node — so the subtree does NOT fall back to "any resource-manager" — while
  // the one id that would satisfy scope belongs to a resource nobody can ever
  // log in as. Every allocation under that subtree becomes decidable by admin
  // alone, and silently vanishes from every resource-manager's feed, with no
  // error anywhere. An EMPTY manager is strictly safer than a placeholder one
  // (empty correctly falls through to the role fallback).
  managerOptions = computed<Resource[]>(() =>
    this.resources()
      .filter(r => !this.isTerminated(r) && countsTowardInternalCapacity(kindOf(r)))
      .sort((a, b) => a.name.localeCompare(b.name)));

  /** A resource is Terminated when terminationDate is set to a date on/before today. */
  private isTerminated(r: Resource): boolean {
    return !!r.terminationDate && r.terminationDate <= todayIso();
  }

  orgForm: FormGroup = this.fb.group({
    name: ['', Validators.required],
    description: [''],
    costCenters: [[] as string[]],
    serviceOrganizationId: [''],
    // D: root-first also means legal-parent order (ORG_LEVELS[i-1] is level i's
    // required parent level) — see parentOptions() below.
    level: ['capability' as OrgLevel, Validators.required],
  });

  protected readonly orgLevels = ORG_LEVELS;

  // D: parentId and managerId are deliberately OUTSIDE orgForm/Reactive Forms.
  // Their <select>s render options from an @for over async-loaded data
  // (resourceOrganizations()/resources()) — binding [value] on the <select>
  // itself in that shape is the exact bug that has twice reached the browser
  // in this repo (the binding runs before the options exist and is silently
  // dropped). The fix is per-option [selected] driven by a plain signal +
  // (change) handler, mirroring allocation-approvals.component.ts's From/To
  // range selects — not Reactive Forms, which is why these live here instead
  // of as orgForm controls.
  formParentId = signal('');
  formManagerId = signal('');

  levelValue = toSignal(this.orgForm.controls['level'].valueChanges, {
    initialValue: this.orgForm.controls['level'].value as OrgLevel,
  });

  // REVIEW ROUND 1 (critical) — the node being edited has an EXISTING CHILD
  // pointing at it. The server now refuses a level change in that state (it
  // would leave the child's own parent-level requirement violated —
  // validateOrgTreeNode has no way to re-validate a node it isn't editing),
  // so the Level select is disabled here rather than letting the admin pick a
  // new level only to meet that refusal on save. False while creating (a
  // brand-new node has no children yet).
  hasChildren = computed(() => {
    const id = this.editingId();
    return id !== null && this.resourceOrganizations().some(n => n.parentId === id);
  });

  constructor() {
    // A level change invalidates whatever was selected as parent under the
    // PREVIOUS level (parentOptions() below recomputes against the new legal
    // parent level) — clear it so the DOM (nothing rendered as [selected],
    // since the stale id almost certainly matches no new option) and the
    // signal driving save() never disagree.
    this.orgForm.controls['level'].valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.formParentId.set(''));

    // Reactive Forms recommends toggling `disabled` via the control itself
    // (not a template `[disabled]` binding alongside `formControlName`) — this
    // keeps `hasChildren()` and the control's own disabled state from ever
    // disagreeing, including when the underlying tree data changes out from
    // under an open form. `getRawValue()` in save() still returns a disabled
    // control's value, so this never affects what gets sent.
    effect(() => {
      const disable = this.hasChildren();
      const control = this.orgForm.controls['level'];
      if (disable && control.enabled) control.disable({ emitEvent: false });
      if (!disable && control.disabled) control.enable({ emitEvent: false });
    });
  }

  /** Legal parent level for the CURRENT level control value; undefined for a capability (root, no parent). */
  parentLevel = computed<OrgLevel | undefined>(() => {
    const level = this.levelValue();
    const idx = ORG_LEVELS.indexOf(level);
    return idx <= 0 ? undefined : ORG_LEVELS[idx - 1];
  });

  /** Nodes of the legal parent level, excluding the node being edited and its
   *  own descendants (selecting either would 400 on the server's cycle guard —
   *  see validateOrgTreeNode's comment on why that check stays live even
   *  though level constraints alone usually rule cycles out structurally). */
  parentOptions = computed<ResourceOrganization[]>(() => {
    const wanted = this.parentLevel();
    if (wanted === undefined) return [];
    const nodes = this.resourceOrganizations();
    const editingId = this.editingId();
    const excluded = editingId ? descendantOrgIds(editingId, nodes) : new Set<string>();
    return nodes.filter(n => n.level === wanted && !excluded.has(n.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  // ORPHAN VALUE: a stored parentId that isn't in the current option list
  // (legacy data, or excluded above as a would-be cycle) stays selectable as a
  // disabled option so an edit never silently discards it.
  orphanParent = computed<ResourceOrganization | null>(() => {
    const current = this.formParentId();
    if (!current) return null;
    if (this.parentOptions().some(p => p.id === current)) return null;
    return this.resourceOrganizations().find(o => o.id === current) ?? null;
  });

  // ORPHAN VALUE: a stored managerId no longer among current resources (e.g. deleted).
  orphanManagerResource = computed<Resource | null>(() => {
    const current = this.formManagerId();
    if (!current) return null;
    if (this.managerOptions().some(m => m.id === current)) return null;
    return this.resources().find(r => r.id === current) ?? null;
  });

  /** Mirrors the server's "a `${level}` must have a parent" 400 — UI-side only, never the sole guardian. */
  parentMissing = computed(() => this.levelValue() !== 'capability' && !this.formParentId());

  // D: the tree view. Ordered so each node follows its parent (a plain
  // parent-grouped DFS), with `depth` computed via ancestorChain — root = 0.
  // Cycle-safe: `visited` stops a node being emitted twice even if the data
  // already contains a cycle (admin-edited, like every org-tree/org-chart
  // field here), and the trailing sweep still surfaces any node the DFS never
  // reached (a dangling parentId, or one caught in that cycle) rather than
  // silently dropping it from the customizing screen.
  orgTree = computed<OrgTreeRow[]>(() => {
    const nodes = this.resourceOrganizations();
    const childrenOf = new Map<string | undefined, ResourceOrganization[]>();
    for (const n of nodes) {
      const list = childrenOf.get(n.parentId) ?? [];
      list.push(n);
      childrenOf.set(n.parentId, list);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.name.localeCompare(b.name));

    const rows: OrgTreeRow[] = [];
    const visited = new Set<string>();
    const visit = (parentId: string | undefined) => {
      for (const n of childrenOf.get(parentId) ?? []) {
        if (visited.has(n.id)) continue;
        visited.add(n.id);
        rows.push({ org: n, depth: Math.max(0, ancestorChain(n.id, nodes).length - 1) });
        visit(n.id);
      }
    };
    visit(undefined);
    // REVIEW ROUND 1 (small) — a node whose parentId never resolves back to a
    // real, visited root (a dangling parentId, or a pre-D cycle) is never
    // reached by visit(undefined) above. Sweep those in through the SAME
    // parent-before-children walk (each leftover "root" pushed, then its own
    // children pulled in via visit()) rather than a flat, raw-array-order
    // loop — the previous version could render a child ABOVE and LESS
    // indented than its own displayed parent. Sorted so the result is
    // deterministic regardless of the array order the data happens to arrive in.
    const leftoverRoots = nodes.filter(n => !visited.has(n.id)).sort((a, b) => a.name.localeCompare(b.name));
    for (const root of leftoverRoots) {
      if (visited.has(root.id)) continue; // already swept in as a "child" of an earlier leftover root
      visited.add(root.id);
      rows.push({ org: root, depth: Math.max(0, ancestorChain(root.id, nodes).length - 1) });
      visit(root.id);
    }
    return rows;
  });

  /**
   * Cost-centre picker options for the chips control: the STORED value is the cost
   * centre id, the label carries the id AND the name because the id is what the table
   * and every cost-allocation report show. Mapping only — the ORPHAN case is owned by
   * the chips primitive (which never intersects the model with these options), so
   * there is deliberately no orphan list here any more.
   */
  costCenterChipOptions = computed<MultiSelectOption[]>(() =>
    this.costCenterOptions().map(cc => ({ value: cc.id, label: `${cc.id} — ${cc.name}` })));

  // ORPHAN VALUE: a stored id no longer in the catalog stays selectable as a disabled
  // option so an edit never silently discards it.
  orphanServiceOrg = computed<string | null>(() => {
    const current: string = this.orgForm.controls['serviceOrganizationId'].value ?? '';
    if (!current) return null;
    return this.serviceOrgOptions().some(so => so.id === current) ? null : current;
  });

  levelLabel(level: OrgLevel): string {
    return level.charAt(0).toUpperCase() + level.slice(1);
  }

  /** Display label for the parent of a tree row (resolved by id), or an em-dash for a root. */
  parentLabel(org: ResourceOrganization): string {
    if (!org.parentId) return '—';
    return this.resourceOrganizations().find(o => o.id === org.parentId)?.name ?? org.parentId;
  }

  /** Display label for a tree row's manager (resolved by id), or an em-dash when unassigned. */
  managerLabel(org: ResourceOrganization): string {
    if (!org.managerId) return '—';
    return this.resources().find(r => r.id === org.managerId)?.name ?? org.managerId;
  }

  onParentChange(event: Event) {
    this.formParentId.set((event.target as HTMLSelectElement).value);
  }

  onManagerChange(event: Event) {
    this.formManagerId.set((event.target as HTMLSelectElement).value);
  }

  openForm(org?: ResourceOrganization) {
    if (org) {
      this.editingId.set(org.id);
      this.orgForm.reset({
        name: org.name,
        description: org.description ?? '',
        costCenters: org.costCenters ?? [],
        serviceOrganizationId: org.serviceOrganizationId ?? '',
        level: org.level,
      });
      // Explicit, not incidental: reset() above already triggered the
      // level.valueChanges subscription that clears formParentId to '' — these
      // two calls, made AFTER reset() has fully settled, are what leave the
      // form in the correct loaded state regardless of that ordering.
      this.formParentId.set(org.parentId ?? '');
      this.formManagerId.set(org.managerId ?? '');
    } else {
      this.editingId.set(null);
      this.orgForm.reset({ name: '', description: '', costCenters: [], serviceOrganizationId: '', level: 'capability' });
      this.formParentId.set('');
      this.formManagerId.set('');
    }
    this.showForm.set(true);
  }

  closeForm() {
    this.showForm.set(false);
    this.editingId.set(null);
  }

  save() {
    if (this.orgForm.invalid || this.parentMissing()) {
      this.orgForm.markAllAsTouched();
      return;
    }
    const raw = this.orgForm.getRawValue();
    const level = raw.level as OrgLevel;
    const id = this.editingId();
    const parentId = level === 'capability' ? '' : this.formParentId();
    const managerId = this.formManagerId();
    const payload: Partial<ResourceOrganization> = {
      name: raw.name,
      description: raw.description ?? '',
      costCenters: raw.costCenters ?? [],
      serviceOrganizationId: raw.serviceOrganizationId || undefined,
      level,
    };
    // UPDATE: always send parentId/managerId as keys — '' explicitly clears
    // (the server's ''->null translation for these two fields lives only in
    // the PUT handler). CREATE: there is nothing to clear yet, and sending ''
    // there would persist a literal empty string instead of leaving the field
    // genuinely absent (POST has no such translation) — so the key is only
    // ADDED when there's a real value to send; omitted entirely otherwise.
    if (id) {
      payload.parentId = parentId;
      payload.managerId = managerId;
    } else {
      if (parentId) payload.parentId = parentId;
      if (managerId) payload.managerId = managerId;
    }
    const op = id ? this.api.updateResourceOrganization(id, payload) : this.api.createResourceOrganization(payload);
    op.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.orgsRes.reload();
        this.notifications.show(id ? 'Resource organization updated.' : 'Resource organization created.', 'success');
        this.closeForm();
      },
      // The server's message (surfaced globally by the error interceptor) IS
      // the point here — the 400s of §2.1 and the 409 rename/delete refusals
      // are worded as full sentences (the rename one names the exact
      // resource count), not raw errors. Leaving this a no-op — rather than
      // overwriting it with a generic fallback — keeps that message the only
      // one shown, and keeps the form OPEN (closeForm() runs only in next())
      // so the admin can see it next to the field and fix/resubmit.
      error: () => undefined,
    });
  }

  /** Display label for a service-org id (code), falling back to the raw id / em-dash. */
  serviceOrgLabel(id: string | undefined): string {
    if (!id) return '—';
    return this.serviceOrgOptions().find(so => so.id === id)?.code ?? id;
  }

  deleteOrg(id: string) {
    this.deletingId.set(id);
  }

  confirmDelete() {
    const id = this.deletingId();
    if (id) {
      this.api.deleteResourceOrganization(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: () => {
          this.orgsRes.reload();
          this.deletingId.set(null);
          this.notifications.show('Resource organization deleted.', 'success');
        },
        // Same rationale as save()'s error handler: the 409s (children /
        // referenced-by-resources) are toasted globally with their own
        // sentence; keep the confirm dialog open (deletingId untouched) so
        // the admin can read it and Cancel, rather than silently closing.
        error: () => undefined,
      });
    }
  }

  cancelDelete() {
    this.deletingId.set(null);
  }
}
