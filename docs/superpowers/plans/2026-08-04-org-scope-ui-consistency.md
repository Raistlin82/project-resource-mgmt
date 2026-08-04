# Org-scope UI consistency: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the two surfaces that stayed on the pre-D notion of "my people" onto the organizational scope D already made authoritative — a second view on `/utilization`, and a Substitute picker whose organization pre-filter reaches into nested organizations.

**Architecture:** Both changes are frontend-only and consume the existing pure layer `src/app/services/org-scope.util.ts` (`scopeOf`, `dimensionsOf`) — nothing in it changes. `/utilization` gains a view switch whose default is the current behaviour, and loads the org tree inside the `forkJoin` it already has. The Substitute picker's candidate filter compares against derived dimensions instead of an exact organization name; its org tree is already loaded.

**Tech Stack:** Angular 21 (standalone, signals, OnPush, native control flow), Vitest via `@angular/build:unit-test`.

**Spec:** `docs/superpowers/specs/2026-08-04-org-scope-ui-consistency-design.md` — authoritative. Read the section named in each task.

## Global Constraints

- **All UI copy in English.**
- **Design system is bespoke:** `command-*` classes + CSS tokens in `src/styles.css`. Material for **icons only**. Where an accent renders as text, use the `-text` (`-700`) token shade. **No new tokens.**
- **Angular 21 house style:** standalone components, `ChangeDetectionStrategy.OnPush`, `signal`/`computed`/`linkedSignal`, native control flow (`@if`/`@for`), `inject()` in field initializers.
- **Never snapshot `auth.userId()`/`auth.role()` at field-init** — read them reactively. In `/utilization` `currentManagerId` is deliberately a **getter**; keep it one.
- **Principal-gated `/api` reads key their `rxResource` params on `auth.authReady()`** and return an empty default until it flips `true`.
- **Never bind `[value]` on a `<select>` whose `<option>`s come from an `@for`** — silently dropped. Use per-`<option>` `[selected]`.
- **Component specs assert on rendered DOM**, not on signal values, wherever the requirement is about what the operator sees.
- **Import the pure layer, never reimplement it:** `scopeOf`, `dimensionsOf` from `src/app/services/org-scope.util.ts`; `kindOf`, `countsTowardInternalCapacity` from `src/app/services/resource-kind.util.ts`.
- **No new endpoint, no new column, no migration.** A fresh-Postgres run is therefore not required — say so explicitly rather than leaving it ambiguous.
- Do not use double quotes in commit subjects or in new headings.

---

### Task 1: The two views on /utilization

**Spec:** §2 in full.

**Files:**
- Modify: `src/app/utilization/utilization.component.ts`
- Create: `src/app/utilization/utilization.component.spec.ts` (none exists)

**Interfaces:**
- Consumes:
  ```ts
  // src/app/services/org-scope.util.ts
  export function scopeOf(managerResourceId: string, resources: readonly ScopeResource[], nodes: readonly OrgNode[]): Set<string>;
  export interface OrgNode { id: string; name: string; level: OrgLevel; parentId?: string; managerId?: string }
  export interface ScopeResource { id: string; managerId?: string; organization?: string }
  // src/app/services/resource-kind.util.ts
  export function kindOf(resource: { kind?: string } | undefined): ResourceKind;   // defaults to 'internal'
  export function countsTowardInternalCapacity(kind: ResourceKind): boolean;       // true only for 'internal'
  // src/app/services/api.service.ts
  getResourceOrganizations(): Observable<ResourceOrganization[]>;
  ```
- Produces: nothing later tasks depend on.

`scopeOf` is the union of the transitive org chart below the actor and the resources sitting in the org subtrees they manage. It **excludes the actor**.

- [ ] **Step 1: Write the failing spec file**

Create `src/app/utilization/utilization.component.spec.ts`. The component has no spec, so this establishes the harness. Model the stubs on `src/app/allocation-approvals/approval-modal.component.spec.ts` — read its `setup()` first and match its idiom (a plain object cast to the service type, `of(...)` for every stream, `authReady: signal(true)`).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { UtilizationComponent } from './utilization.component';
import { ApiService, type Resource, type ResourceOrganization } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

// Tree: CAP 'Engineering' (managed by m1) > PRA 'Platform' > COM 'Backend'
const ORGS: ResourceOrganization[] = [
  { id: 'o1', name: 'Engineering', description: '', costCenters: [], level: 'capability', managerId: 'm1' },
  { id: 'o2', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: 'o1' },
  { id: 'o3', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: 'o2' },
  { id: 'o4', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
];

const base = { skills: [], projectRoles: [], externalExperience: [], capacity: 40 };
const RESOURCES: Resource[] = [
  // reachable ONLY through the org chart (no organization at all)
  { ...base, id: 'd1', name: 'Direct Dana', role: 'Developer', utilization: 80, kind: 'internal', managerId: 'm1' },
  // reachable ONLY through the org subtree, two levels down, no org-chart link
  { ...base, id: 's1', name: 'Subtree Sven', role: 'Developer', utilization: 40, kind: 'internal', organization: 'Backend' },
  // a placeholder inside the same subtree
  { ...base, id: 'p1', name: 'Dummy Placeholder', role: 'Developer', utilization: 0, kind: 'dummy', organization: 'Platform' },
  // outside every axis
  { ...base, id: 'x1', name: 'Outside Otto', role: 'Developer', utilization: 90, kind: 'internal', organization: 'Consulting' },
] as Resource[];

function setup({ resources = RESOURCES, orgs = ORGS, userId = 'm1' } = {}) {
  const apiStub = {
    getResources: vi.fn(() => of(resources)),
    getAssignments: vi.fn(() => of([])),
    getRequests: vi.fn(() => of([])),
    getTimeEntries: vi.fn(() => of([])),
    getResourceOrganizations: vi.fn(() => of(orgs)),
  } as unknown as ApiService;
  const authStub = {
    authReady: signal(true), isAuthenticated: signal(true),
    role: signal('resource-manager'), userId: signal(userId),
  } as unknown as AuthService;
  const notifyStub = { success: vi.fn(), error: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });
  const fixture = TestBed.createComponent(UtilizationComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

const names = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[data-test="team-member"]')].map(e => e.textContent?.trim() ?? '');

describe('UtilizationComponent — team scope', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('defaults to direct reports, exactly the pre-existing behaviour', () => {
    const { host } = setup();
    expect(names(host).join(' ')).toContain('Direct Dana');
    expect(names(host).join(' ')).not.toContain('Subtree Sven');
  });

  it('switching to All my org adds people reachable only through the org subtree', () => {
    const { fixture, host } = setup();
    fixture.nativeElement.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    const shown = names(host).join(' ');
    // Sven sits on 'Backend', two levels under the capability m1 manages, with no
    // org-chart link — an implementation matching only `organization === node`
    // would miss him, which is the whole point of deriving through the tree.
    expect(shown).toContain('Subtree Sven');
    expect(shown).toContain('Direct Dana');       // the chart axis still counts
    expect(shown).not.toContain('Outside Otto');
  });

  it('shows a placeholder in the org list but keeps it out of the average', () => {
    const { fixture, host } = setup();
    fixture.nativeElement.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(names(host).join(' ')).toContain('Dummy Placeholder');
    // Internal-only mean: Dana 80 + Sven 40 = 60. Including the dummy's 0 would read 40.
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('60');
    expect(host.querySelector('[data-test="kpi-internal-note"]')).not.toBeNull();
  });

  it('the average follows the view', () => {
    const { fixture, host } = setup();
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('80'); // Dana alone
    fixture.nativeElement.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('60');
  });

  it('explains an empty direct-reports view and an empty org view differently', () => {
    // 'nobody' manages no person and no node.
    const { fixture, host } = setup({ userId: 'nobody' });
    expect(host.querySelector('[data-test="team-empty"]')!.textContent).toContain('report directly');
    fixture.nativeElement.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-test="team-empty"]')!.textContent).toContain('organization');
  });

  it('keeps the view switch visible even when the org view would be empty', () => {
    const { host } = setup({ userId: 'nobody' });
    expect(host.querySelector('[data-test="team-scope-org"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `./node_modules/.bin/ng test --include='**/utilization.component.spec.ts'`
Expected: FAIL — no `data-test` hooks exist yet, and `getResourceOrganizations` is not consumed.

- [ ] **Step 3: Load the org tree in the existing forkJoin**

In `src/app/utilization/utilization.component.ts`, extend the data interface and the single `forkJoin` — **do not add a second `rxResource`**. A separate load would make the switch usable before its data resolved, which is the defect removed from the approvals screen in D's Task 8.

```ts
interface UtilizationData {
  resources: Resource[];
  assignments: Assignment[];
  requests: ResourceRequest[];
  timeEntries: TimeEntry[];
  orgs: ResourceOrganization[];
}
```

Add `orgs: this.api.getResourceOrganizations()` to the `forkJoin`, `orgs: []` to both the `of<UtilizationData>(...)` fallback and `defaultValue`, and expose `orgNodes = computed(() => this.dataResource.value().orgs);`.

- [ ] **Step 4: Implement the switch, the scoped list and the internal-only mean**

```ts
/** Which set 'My Team' means. 'direct' is the pre-D behaviour and stays the default. */
protected teamScope = signal<'direct' | 'org'>('direct');

/**
 * 'direct' — people who report to the actor directly (unchanged).
 * 'org'    — the actor's ORGANIZATIONAL SCOPE: the transitive org chart below
 *            them UNION the resources in the org subtrees they manage. Same
 *            `scopeOf` the approval feed uses, so the two cannot drift.
 */
managedResources = computed(() => {
  const me = this.currentManagerId;
  const all = this.resources();
  if (this.teamScope() === 'direct') return all.filter(r => r.managerId === me);
  const inScope = scopeOf(me, all, this.orgNodes());
  return all.filter(r => inScope.has(r.id));
});

/**
 * Only INTERNAL resources carry a meaningful `utilization`: a placeholder is
 * nobody's capacity, and a subco is not internal saturation. `scopeOf` reaches
 * into org subtrees where placeholders live, so without this filter the mean
 * would sink toward zero as the tree grows — the exact defect C1 fixed on
 * /reporting, where the seed alone halved the average. Applies to BOTH views:
 * a placeholder given a manager would otherwise land in the direct one too.
 */
private countedForAverage = computed(() =>
  this.managedResources().filter(r => countsTowardInternalCapacity(kindOf(r))));

averageUtilization = computed(() => {
  const counted = this.countedForAverage();
  if (!counted.length) return 0;
  return counted.reduce((sum, r) => sum + r.utilization, 0) / counted.length;
});

/** True when the list shows rows the average deliberately does not count. */
protected hasUncountedRows = computed(() =>
  this.countedForAverage().length !== this.managedResources().length);
```

- [ ] **Step 5: Implement the template**

In the KPI card, add `data-test="team-average"` to the percentage span, and after it:

```html
@if (hasUncountedRows()) {
  <span data-test="kpi-internal-note" class="command-kpi-note">internal only</span>
}
```

`command-kpi-note` is a real class in `src/styles.css` — do not invent a new one.

In the `My Team` card header, replace the static subtitle with the switch. **This markup is the established segmented-toggle pattern of this codebase, copied from `src/app/forecast/forecast.ts:57-68` (the Horizon switch)** — follow it rather than inventing classes, and note there is no `command-button`-family class for a segmented control:

```html
<div class="inline-flex rounded-md border border-[var(--cc-line-strong)] bg-[var(--cc-surface)] p-1"
     role="group" aria-label="Team scope">
  <button type="button" data-test="team-scope-direct"
          (click)="teamScope.set('direct')"
          [attr.aria-pressed]="teamScope() === 'direct'"
          class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
          [class]="teamScope() === 'direct' ? 'bg-accent text-white shadow-sm' : 'text-ink-secondary hover:text-accent-text'">
    Direct reports
  </button>
  <button type="button" data-test="team-scope-org"
          (click)="teamScope.set('org')"
          [attr.aria-pressed]="teamScope() === 'org'"
          class="rounded px-3 py-1.5 text-xs font-semibold transition-colors"
          [class]="teamScope() === 'org' ? 'bg-accent text-white shadow-sm' : 'text-ink-secondary hover:text-accent-text'">
    All my org
  </button>
</div>
```

Add `data-test="team-member"` to the element carrying each row's name in the `@for`, and replace the empty state with:

```html
@if (managedResources().length === 0) {
  <div data-test="team-empty" class="p-12 text-center text-sm text-[var(--cc-muted)]">
    @if (teamScope() === 'direct') {
      Nobody reports directly to you.
    } @else {
      You do not manage any organization, and nobody reports to you.
    }
  </div>
}
```

- [ ] **Step 6: Run the spec, then the full gates**

```bash
./node_modules/.bin/ng test --include='**/utilization.component.spec.ts'
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

- [ ] **Step 7: Look at it in a browser**

Run a built server on port **4173** (port 4200 may be occupied — do not use or stop it) and open `/utilization` as a principal who manages a node. Switch views, confirm the subtree people appear only in `All my org`, and confirm the average changes with the view. Say concretely what you saw, including both numbers.

- [ ] **Step 8: Commit**

```bash
git add src/app/utilization
git commit -m "feat: direct-reports and all-my-org views on utilization, internal-only mean"
```

---

### Task 2: The Substitute picker reaches nested organizations

**Spec:** §3.

**Files:**
- Modify: `src/app/allocation-approvals/approval-modal.component.ts` (`filteredCandidates`, around `:755-763`)
- Modify: `src/app/allocation-approvals/approval-modal.component.spec.ts`

**Interfaces:**
- Consumes: `dimensionsOf(resource, nodes)` from `src/app/services/org-scope.util.ts`, returning `{ capability?: string; practice?: string; competence?: string }` — a key is absent when that level does not exist above the resource's attachment point.
- Produces: nothing.

The component **already** loads the tree: `orgNodesRes`/`orgNodes()` at `approval-modal.component.ts:723-728`, added in D for `canDecideFor`. Do not add another load.

- [ ] **Step 1: Write the failing spec case**

The spec's `setup()` already accepts `orgs` (default `[]`) and `resources`. Add, inside the Substitute describe block:

```ts
it('offers a candidate nested below the pre-filtered organization', async () => {
  // 'Digital' is a capability; 'Digital Backend' a competence beneath it.
  const orgs = [
    { id: 'g1', name: 'Digital', description: '', costCenters: [], level: 'capability' as const },
    { id: 'g2', name: 'Digital Platform', description: '', costCenters: [], level: 'practice' as const, parentId: 'g1' },
    { id: 'g3', name: 'Digital Backend', description: '', costCenters: [], level: 'competence' as const, parentId: 'g2' },
  ];
  // Nora sits TWO levels below the dummy's own organization. A filter comparing
  // `r.organization === 'Digital'` would drop her, so this fixture is what makes
  // the test meaningful — a candidate attached directly to 'Digital' would pass
  // against the old code too.
  const resources = [
    { ...RESOURCES[0] },                                       // Dummy Ada, organization 'Digital'
    { ...RESOURCES[1], organization: 'Digital Backend' },      // Nora Fenn, nested
  ] as Resource[];
  const { fixture } = setup({ rows: [{ ...ROW, kind: 'dummy' }], orgs, resources });
  fixture.componentInstance.openSubstitute(ROW.items[0]);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  expect(host.textContent).toContain('Nora Fenn');
});
```

Adapt the row/fixture names to what the spec file actually defines — read it first.

- [ ] **Step 2: Run the spec to verify it fails**

Run: `./node_modules/.bin/ng test --include='**/approval-modal.component.spec.ts'`
Expected: FAIL — Nora is filtered out by the exact-name comparison.

- [ ] **Step 3: Implement**

Replace the organization comparison in `filteredCandidates`:

```ts
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
```

Then, under the organization `<select>`, add the line that makes the behaviour visible:

```html
<p class="mt-1 text-xs text-[var(--cc-muted)]">Includes candidates in nested organizations.</p>
```

Do not touch `defaultOrgFor`, the eligibility rules (internal only, non-terminated), the name/role filter, or the option list.

- [ ] **Step 4: Run the spec and the gates**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
```

- [ ] **Step 5: Commit**

```bash
git add src/app/allocation-approvals
git commit -m "feat: substitute candidates match nested organizations"
```

---

### Task 3: Sweep, docs, full verification

**Spec:** §6 for what must stay out.

**Files:**
- Modify: `docs/functional/resource-management.md`
- Modify: whatever the sweep turns up

- [ ] **Step 1: Sweep the two patterns this block changed**

The three previous blocks each shipped a surface that kept its old behaviour because no task owned it. Both patterns this block touched are cheap to grep, so grep them:

1. `grep -rn 'managerId ===' src/app` — every place that equates a manager id. For each: is it a *display* filter that should follow the scope, an authorization mirror (which D already handled), or correctly about direct reports only? Record a decision for each, **including the ones that need nothing, with the reason.**
2. `grep -rn '\.organization ===\|organization !==' src/app` — every exact-name organization comparison. Same treatment: some are legitimately exact (a rate-card key, a form value), some are branch questions like the one Task 2 fixed.

A consumer you do not mention reads as one you did not look at. Fix what needs a mechanical fix; where something needs a product call, report it instead of guessing.

- [ ] **Step 2: Update the functional docs**

`docs/functional/resource-management.md` documents the utilization screen. Add the two views, what each means, and the fact that the average counts internal resources only — that last one is a number an auditor may ask about, so it belongs in the functional doc, not only in a comment.

D's final review found this same file and `docs/functional/configuration.md` describing pre-D screens; do not repeat that. Check whether the Substitute flow is documented anywhere under `docs/functional/` and, if it is, add the nested-organization behaviour there too.

- [ ] **Step 3: Full gate set**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng lint
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```

The smoke suite is **not idempotent against a warm in-memory server** — restart the process between runs. It also runs near the API's 300 req/min rate limit; a burst of 429s is the limiter, not your code. **A fresh-Postgres run is not required** (no schema change, no migration, no server change) — state that explicitly in the report rather than leaving it ambiguous.

- [ ] **Step 4: Commit**

```bash
git add -A docs src
git commit -m "docs: the two utilization views and the nested-organization picker"
```

---

## Verification Checklist (before merge)

- [ ] `/utilization` opens on **Direct reports**, showing exactly what it showed before this block.
- [ ] **All my org** adds a person reachable only through an org subtree two levels down, with no org-chart link.
- [ ] **All my org** still includes people reachable only through the org chart.
- [ ] A placeholder in the subtree appears in the list and is **absent** from the average, in both views.
- [ ] The average changes when the view changes, and the internal-only note appears exactly when the list holds uncounted rows.
- [ ] `admin` and `delivery-executive` see their **own** scope in the second view, not the whole company.
- [ ] The empty state distinguishes "nobody reports to you" from "you manage no organization".
- [ ] The view switch is present even when the second view is empty.
- [ ] A dummy on a capability offers a candidate attached to a competence two levels beneath it, and the note under the select says so.
- [ ] Substitute eligibility is unchanged: no placeholder and no terminated person among the candidates.
- [ ] Unit, lint, build and the live smoke are green; the fresh-Postgres run is explicitly stated as not required.
