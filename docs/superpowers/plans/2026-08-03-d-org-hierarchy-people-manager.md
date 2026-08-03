# D — Organizational hierarchy + People Manager: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `resourceOrganizations` into a Capability > Practice > Competence tree whose nodes carry a manager, and use it — together with the transitive org chart — to route allocation visibility and decisions to the competent manager instead of to anyone holding the `resource-manager` role.

**Architecture:** One new pure util (`org-scope.util.ts`) computes everything: the ancestor chain, the descendant sets, the two transitive closures, the cycle checks and the derived dimensions. Three additive columns on `resource_organizations` (`parent_id`, `level`, `manager_id`). The server consumes the util in the bespoke catalog handlers, in `decideOneApproval` and in the `/allocation-approvals` feed; the frontend consumes the same util for the customizing tree, for the three filter surfaces and for the modal's own `canDecideFor` mirror, so client and server cannot drift.

**Tech Stack:** Angular 21 (standalone, signals, OnPush, native control flow), Express 5, Drizzle ORM + PostgreSQL, in-memory adapter for dev, Vitest via `@angular/build:unit-test`, dependency-free `scripts/smoke-api.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-03-d-org-hierarchy-people-manager-design.md` — authoritative. Read the section named in each task.

## Global Constraints

- **All UI copy in English.** Multilingual is deferred to a future revision.
- **Design system is bespoke:** `command-*` classes + CSS tokens in `src/styles.css` (Tailwind v4). Material for **icons only**. Where an accent renders as text, use the `-text` (`-700`) token shade.
- **Angular 21 house style:** standalone components only, `ChangeDetectionStrategy.OnPush`, `signal`/`computed`/`linkedSignal`, native control flow (`@if`/`@for`), `inject()` in field initializers.
- **Never snapshot `auth.userId()`/`auth.role()` at field-init** — read them reactively inside a `computed`/`rxResource` params/getter, or a deep link freezes the anonymous default.
- **Principal-gated `/api` reads key their `rxResource` params on `auth.authReady()`** and return an empty default until it flips `true`. `src/app/reporting/reporting.ts` is the reference.
- **Never bind `[value]` on a `<select>` whose `<option>`s come from an `@for`** — the binding is applied before the options exist and is silently dropped. Use per-`<option>` `[selected]`. `src/app/allocation-approvals/allocation-approvals.component.ts:135-148` is the established pattern.
- **Component specs assert on rendered DOM**, not on signal values, wherever the requirement is about what the operator sees.
- **`src/db/seed.ts` is the single source of truth for seed data**, consumed by both the in-memory adapter and the Postgres seeder.
- **Dual-adapter seam:** `nullsToUndefined()` runs on every *return* path and never on values handed to `.set()`; explicit `null` in an update patch means "clear to absent" on both adapters, `undefined` means "leave untouched".
- **`withLock(key, fn)` is NOT re-entrant** — nesting the same key wedges it forever. None of this plan's work needs a new lock: the scope computation is read-only.
- **`MAX_CHAIN_DEPTH = 64`.** The `visited` set is what guarantees termination; the depth cap is a second net and a declared semantic limit.
- **Tree levels:** `'capability' | 'practice' | 'competence'`. A `capability` has no parent; a `practice`'s parent is a `capability`; a `competence`'s parent is a `practice`.
- **`Resource.organization` stays a NAME, not an id** — and node names are unique across the whole tree.
- **Derived dimensions are never denormalized onto the resource.**
- Do not use double quotes in commit subjects or in new headings (a tooling limitation in this repo's plan scripts).

---

### Task 1: The pure scope layer

**Spec:** §3.1, §3.2, §2.5.

**Files:**
- Create: `src/app/services/org-scope.util.ts`
- Test: `src/app/services/org-scope.util.spec.ts`

**Interfaces:**
- Consumes: nothing. No imports beyond types.
- Produces — every later task depends on these exact signatures:

```ts
export type OrgLevel = 'capability' | 'practice' | 'competence';
export const MAX_CHAIN_DEPTH = 64;
export const ORG_LEVELS: readonly OrgLevel[] = ['capability', 'practice', 'competence'];

/** Minimal shape of an org-tree node this layer needs. */
export interface OrgNode { id: string; name: string; level: OrgLevel; parentId?: string; managerId?: string }
/** Minimal shape of a resource this layer needs. */
export interface ScopeResource { id: string; managerId?: string; organization?: string }

export function nodeByName(name: string | undefined, nodes: readonly OrgNode[]): OrgNode | undefined;
export function ancestorChain(nodeId: string, nodes: readonly OrgNode[]): OrgNode[];
export function dimensionsOf(resource: ScopeResource, nodes: readonly OrgNode[]): { capability?: string; practice?: string; competence?: string };
export function descendantOrgIds(rootId: string, nodes: readonly OrgNode[]): Set<string>;
export function reportsClosure(managerResourceId: string, resources: readonly ScopeResource[]): Set<string>;
export function scopeOf(managerResourceId: string, resources: readonly ScopeResource[], nodes: readonly OrgNode[]): Set<string>;
export function scopedApproversOf(target: ScopeResource, resources: readonly ScopeResource[], nodes: readonly OrgNode[]): { managerIds: Set<string>; roleFallback: boolean };
export function wouldCycleInOrgTree(nodeId: string, newParentId: string | undefined, nodes: readonly OrgNode[]): boolean;
export function wouldCycleInOrgChart(resourceId: string, newManagerId: string | undefined, resources: readonly ScopeResource[]): boolean;
```

`scopedApproversOf` is the whole of spec §3.4 expressed as data: `managerIds` are the resource ids allowed to decide for `target` (its transitive managers in the org chart, plus the managers of every node from its own node up to the root), and `roleFallback` is `true` **only** when `managerIds` is empty — i.e. the target has no manager anywhere. The caller combines that with the actor's role; the util knows nothing about roles.

- [ ] **Step 1: Write the failing tests**

Create `src/app/services/org-scope.util.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ancestorChain, descendantOrgIds, dimensionsOf, nodeByName, reportsClosure,
  scopeOf, scopedApproversOf, wouldCycleInOrgChart, wouldCycleInOrgTree,
  type OrgNode, type ScopeResource,
} from './org-scope.util';

// Tree: CAP (Delivery) > PRA (Engineering) > COM (Backend)
//       CAP2 (Advisory) with no children
const NODES: OrgNode[] = [
  { id: 'CAP', name: 'Delivery', level: 'capability', managerId: 'r100' },
  { id: 'PRA', name: 'Engineering', level: 'practice', parentId: 'CAP', managerId: 'r200' },
  { id: 'COM', name: 'Backend', level: 'competence', parentId: 'PRA', managerId: 'r300' },
  { id: 'CAP2', name: 'Advisory', level: 'capability' },
];

// Org chart: r1 -> r2 -> r3 (r3 is r2's manager, r2 is r1's manager)
const RESOURCES: ScopeResource[] = [
  { id: 'r1', managerId: 'r2', organization: 'Backend' },
  { id: 'r2', managerId: 'r3', organization: 'Engineering' },
  { id: 'r3', organization: 'Delivery' },
  { id: 'r9', organization: 'Advisory' },   // node has no manager
  { id: 'r10' },                            // no org, no manager
];

describe('nodeByName / ancestorChain', () => {
  it('resolves a node by its name', () => {
    expect(nodeByName('Backend', NODES)?.id).toBe('COM');
  });

  it('returns undefined for an unknown or absent name', () => {
    expect(nodeByName('Nope', NODES)).toBeUndefined();
    expect(nodeByName(undefined, NODES)).toBeUndefined();
  });

  it('walks from a node up to the root, innermost first', () => {
    expect(ancestorChain('COM', NODES).map(n => n.id)).toEqual(['COM', 'PRA', 'CAP']);
  });

  it('does not hang on a cycle already present in the data', () => {
    const cyclic: OrgNode[] = [
      { id: 'A', name: 'A', level: 'practice', parentId: 'B' },
      { id: 'B', name: 'B', level: 'practice', parentId: 'A' },
    ];
    const chain = ancestorChain('A', cyclic).map(n => n.id);
    expect(chain).toEqual(['A', 'B']);   // stops when it meets a node it has seen
  });
});

describe('dimensionsOf', () => {
  it('derives all three levels from a competence attachment', () => {
    expect(dimensionsOf({ id: 'x', organization: 'Backend' }, NODES))
      .toEqual({ capability: 'Delivery', practice: 'Engineering', competence: 'Backend' });
  });

  it('derives only what exists above a practice attachment', () => {
    expect(dimensionsOf({ id: 'x', organization: 'Engineering' }, NODES))
      .toEqual({ capability: 'Delivery', practice: 'Engineering' });
  });

  it('derives only the capability from a capability attachment', () => {
    expect(dimensionsOf({ id: 'x', organization: 'Delivery' }, NODES))
      .toEqual({ capability: 'Delivery' });
  });

  it('returns an empty object for a resource with no organization', () => {
    expect(dimensionsOf({ id: 'x' }, NODES)).toEqual({});
  });
});

describe('descendantOrgIds', () => {
  it('includes the root and everything under it', () => {
    expect([...descendantOrgIds('CAP', NODES)].sort()).toEqual(['CAP', 'COM', 'PRA']);
  });

  it('is just the node itself for a leaf', () => {
    expect([...descendantOrgIds('COM', NODES)]).toEqual(['COM']);
  });
});

describe('reportsClosure', () => {
  it('includes reports of reports, but not the manager themselves', () => {
    expect([...reportsClosure('r3', RESOURCES).values()].sort()).toEqual(['r1', 'r2']);
  });

  it('does not hang on a cycle in the org chart', () => {
    const cyclic: ScopeResource[] = [
      { id: 'a', managerId: 'b' },
      { id: 'b', managerId: 'a' },
    ];
    expect([...reportsClosure('a', cyclic)].sort()).toEqual(['a', 'b']);
  });
});

describe('scopeOf', () => {
  it('is the union of the org chart closure and the org subtree', () => {
    // r200 manages the Engineering practice: that covers r2 (Engineering) and
    // r1 (Backend, under Engineering) via the tree, with no org-chart link.
    expect([...scopeOf('r200', RESOURCES, NODES)].sort()).toEqual(['r1', 'r2']);
  });

  it('covers via the org chart even across different org nodes', () => {
    // r3 manages r2 who manages r1: the org chart alone reaches both.
    expect([...scopeOf('r3', RESOURCES, NODES)].sort()).toEqual(['r1', 'r2']);
  });

  it('is empty for someone who manages nobody and no node', () => {
    expect([...scopeOf('r10', RESOURCES, NODES)]).toEqual([]);
  });
});

describe('scopedApproversOf', () => {
  it('names the org-chart managers and every node manager above the resource', () => {
    const { managerIds, roleFallback } = scopedApproversOf(RESOURCES[0], RESOURCES, NODES);
    expect([...managerIds].sort()).toEqual(['r100', 'r200', 'r2', 'r3', 'r300'].sort());
    expect(roleFallback).toBe(false);
  });

  it('falls back to the role ONLY when no manager exists anywhere', () => {
    // r9 sits on 'Advisory', a node with no manager, and has no manager itself.
    const { managerIds, roleFallback } = scopedApproversOf(RESOURCES[3], RESOURCES, NODES);
    expect([...managerIds]).toEqual([]);
    expect(roleFallback).toBe(true);
  });

  it('does not fall back when only the org chart provides a manager', () => {
    const { managerIds, roleFallback } = scopedApproversOf(
      { id: 'z', managerId: 'r3' }, RESOURCES, NODES);
    expect([...managerIds]).toEqual(['r3']);
    expect(roleFallback).toBe(false);
  });
});

describe('cycle guards', () => {
  it('refuses a parent that is the node itself or one of its descendants', () => {
    expect(wouldCycleInOrgTree('CAP', 'COM', NODES)).toBe(true);
    expect(wouldCycleInOrgTree('CAP', 'CAP', NODES)).toBe(true);
    expect(wouldCycleInOrgTree('COM', 'CAP2', NODES)).toBe(false);
    expect(wouldCycleInOrgTree('COM', undefined, NODES)).toBe(false);
  });

  it('refuses a manager that is the resource itself or one of its reports', () => {
    expect(wouldCycleInOrgChart('r3', 'r1', RESOURCES)).toBe(true);
    expect(wouldCycleInOrgChart('r3', 'r3', RESOURCES)).toBe(true);
    expect(wouldCycleInOrgChart('r9', 'r3', RESOURCES)).toBe(false);
    expect(wouldCycleInOrgChart('r9', undefined, RESOURCES)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/ng test --include='**/org-scope.util.spec.ts'`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the util**

Create `src/app/services/org-scope.util.ts`. Every traversal carries a `visited` set and stops at `MAX_CHAIN_DEPTH`; no function throws, and none mutates its inputs.

```ts
/**
 * D — the organizational scope layer. PURE: no I/O, no clock, no Angular.
 *
 * TWO INDEPENDENT AXES, per the RPT manual §6 (see the D design spec §1):
 *   - the ORG CHART (`Resource.managerId`, transitively) is the axis of
 *     VISIBILITY: who a manager may see and decide for;
 *   - the ORG TREE (capability > practice > competence) is the axis of
 *     BELONGING, and in UI it is a FILTER within that scope.
 * A manager's scope is the UNION of the two.
 *
 * TERMINATION: both chains are admin-edited data and can contain a cycle
 * (`managerId` is a free field of the resource form). Every traversal here
 * carries a `visited` set — THAT is what guarantees termination. The
 * MAX_CHAIN_DEPTH cap is a second net and a declared semantic limit, not the
 * safety mechanism.
 */
export type OrgLevel = 'capability' | 'practice' | 'competence';

/** Declared order, root first — also the legal parent order. */
export const ORG_LEVELS: readonly OrgLevel[] = ['capability', 'practice', 'competence'];

/** Declared maximum chain length. See the TERMINATION note above. */
export const MAX_CHAIN_DEPTH = 64;

export interface OrgNode { id: string; name: string; level: OrgLevel; parentId?: string; managerId?: string }
export interface ScopeResource { id: string; managerId?: string; organization?: string }

/** The node a resource is attached to — resources reference nodes BY NAME (spec §2.4). */
export function nodeByName(name: string | undefined, nodes: readonly OrgNode[]): OrgNode | undefined {
  if (name === undefined || name === '') return undefined;
  return nodes.find(n => n.name === name);
}

/** From `nodeId` up to the root, innermost first. Empty when the id is unknown. */
export function ancestorChain(nodeId: string, nodes: readonly OrgNode[]): OrgNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const chain: OrgNode[] = [];
  const visited = new Set<string>();
  let current = byId.get(nodeId);
  while (current !== undefined && !visited.has(current.id) && chain.length < MAX_CHAIN_DEPTH) {
    visited.add(current.id);
    chain.push(current);
    current = current.parentId === undefined ? undefined : byId.get(current.parentId);
  }
  return chain;
}

/**
 * The resource's org dimensions, DERIVED by walking up — never denormalized
 * onto the resource, so a practice can never disagree with its competence
 * (spec §2.5). A resource may attach at ANY level, so a key is absent when
 * that level does not exist above the attachment point.
 */
export function dimensionsOf(
  resource: ScopeResource,
  nodes: readonly OrgNode[],
): { capability?: string; practice?: string; competence?: string } {
  const node = nodeByName(resource.organization, nodes);
  if (node === undefined) return {};
  const out: { capability?: string; practice?: string; competence?: string } = {};
  for (const n of ancestorChain(node.id, nodes)) out[n.level] = n.name;
  return out;
}

/** `rootId` and every node beneath it. */
export function descendantOrgIds(rootId: string, nodes: readonly OrgNode[]): Set<string> {
  const childrenOf = new Map<string, OrgNode[]>();
  for (const n of nodes) {
    if (n.parentId === undefined) continue;
    const siblings = childrenOf.get(n.parentId) ?? [];
    siblings.push(n);
    childrenOf.set(n.parentId, siblings);
  }
  const out = new Set<string>();
  const queue = [rootId];
  let depth = 0;
  while (queue.length > 0 && depth < MAX_CHAIN_DEPTH * nodes.length + 1) {
    depth += 1;
    const id = queue.shift() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of childrenOf.get(id) ?? []) queue.push(child.id);
  }
  return out;
}

/** Everyone below `managerResourceId` in the org chart. Excludes the manager. */
export function reportsClosure(managerResourceId: string, resources: readonly ScopeResource[]): Set<string> {
  const reportsOf = new Map<string, string[]>();
  for (const r of resources) {
    if (r.managerId === undefined) continue;
    const list = reportsOf.get(r.managerId) ?? [];
    list.push(r.id);
    reportsOf.set(r.managerId, list);
  }
  const out = new Set<string>();
  const queue = [...(reportsOf.get(managerResourceId) ?? [])];
  while (queue.length > 0 && out.size < resources.length) {
    const id = queue.shift() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of reportsOf.get(id) ?? []) queue.push(child);
  }
  return out;
}

/** The union of the two axes: what `managerResourceId` may see and decide for. */
export function scopeOf(
  managerResourceId: string,
  resources: readonly ScopeResource[],
  nodes: readonly OrgNode[],
): Set<string> {
  const out = reportsClosure(managerResourceId, resources);
  const managedRoots = nodes.filter(n => n.managerId === managerResourceId);
  if (managedRoots.length === 0) return out;
  const covered = new Set<string>();
  for (const root of managedRoots) for (const id of descendantOrgIds(root.id, nodes)) covered.add(id);
  const nameById = new Map(nodes.map(n => [n.id, n.name]));
  const coveredNames = new Set([...covered].map(id => nameById.get(id)).filter((n): n is string => n !== undefined));
  for (const r of resources) {
    if (r.id === managerResourceId) continue;
    if (r.organization !== undefined && coveredNames.has(r.organization)) out.add(r.id);
  }
  return out;
}

/**
 * Spec §3.4 as data. `managerIds` are the resource ids allowed to decide for
 * `target`; `roleFallback` is true ONLY when there is no manager anywhere —
 * neither in the org chart nor on any node above the target. That is the case
 * of a placeholder (dummy) today, and it is what keeps C2's substitutions
 * decidable with no special case.
 *
 * Roles are NOT this layer's business: the caller combines `roleFallback` with
 * the actor's role.
 */
export function scopedApproversOf(
  target: ScopeResource,
  resources: readonly ScopeResource[],
  nodes: readonly OrgNode[],
): { managerIds: Set<string>; roleFallback: boolean } {
  const managerIds = new Set<string>();
  const byId = new Map(resources.map(r => [r.id, r]));
  const visited = new Set<string>([target.id]);
  let current = target.managerId === undefined ? undefined : byId.get(target.managerId);
  let hops = 0;
  while (current !== undefined && !visited.has(current.id) && hops < MAX_CHAIN_DEPTH) {
    hops += 1;
    visited.add(current.id);
    managerIds.add(current.id);
    current = current.managerId === undefined ? undefined : byId.get(current.managerId);
  }
  const node = nodeByName(target.organization, nodes);
  if (node !== undefined) {
    for (const n of ancestorChain(node.id, nodes)) if (n.managerId !== undefined) managerIds.add(n.managerId);
  }
  managerIds.delete(target.id);
  return { managerIds, roleFallback: managerIds.size === 0 };
}

/** True when making `newParentId` the parent of `nodeId` would close a loop. */
export function wouldCycleInOrgTree(
  nodeId: string,
  newParentId: string | undefined,
  nodes: readonly OrgNode[],
): boolean {
  if (newParentId === undefined || newParentId === '') return false;
  if (newParentId === nodeId) return true;
  return descendantOrgIds(nodeId, nodes).has(newParentId);
}

/** True when making `newManagerId` the manager of `resourceId` would close a loop. */
export function wouldCycleInOrgChart(
  resourceId: string,
  newManagerId: string | undefined,
  resources: readonly ScopeResource[],
): boolean {
  if (newManagerId === undefined || newManagerId === '') return false;
  if (newManagerId === resourceId) return true;
  return reportsClosure(resourceId, resources).has(newManagerId);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `./node_modules/.bin/ng test --include='**/org-scope.util.spec.ts'`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/org-scope.util.ts src/app/services/org-scope.util.spec.ts
git commit -m "feat(d): pure org-scope layer — two axes, cycle-safe traversals"
```

---

### Task 2: The three columns, the migration and the seed

**Spec:** §2.1, §2.3, §5.

**Files:**
- Modify: `src/db/schema.ts` (the `resourceOrganizations` table, currently at `:360-376`)
- Modify: `src/app/services/api.service.ts` (`ResourceOrganization`, currently at `:388-394`)
- Modify: `src/db/seed.ts` (`resourceOrganizations`, currently at `:361-367`)
- Create: `drizzle/00NN_*.sql` — generated, do not hand-write the filename

**Interfaces:**
- Consumes: `OrgLevel` from Task 1.
- Produces: `ResourceOrganization` gains `parentId?: string`, `level: OrgLevel`, `managerId?: string`. Every later task reads these.

- [ ] **Step 1: Extend the client interface**

In `src/app/services/api.service.ts`, replace the `ResourceOrganization` interface with:

```ts
/**
 * A node of the organizational tree (D). Capability > Practice > Competence.
 *
 * TWO REFERENCES UPWARD, deliberately orthogonal (design spec §2.3):
 *   - `parentId`              -> the DELIVERY hierarchy. Drives manager scope,
 *                                derived dimensions and filters.
 *   - `serviceOrganizationId` -> FINANCIAL belonging. Drives cost centres and
 *                                rate-card selection. NOT part of the tree; it
 *                                is never walked for scope.
 *
 * `managerId` IS the manual's Capability Leader / Practice Manager / Competence
 * Manager — the node's level says which. No new RBAC role exists for them.
 */
export interface ResourceOrganization {
  id: string;
  name: string;
  description: string;
  costCenters: string[];
  serviceOrganizationId?: string;
  /** The node above this one in the DELIVERY tree. Absent on a capability (root). */
  parentId?: string;
  /** Declared level. A capability has no parent; a practice's parent is a capability; a competence's parent is a practice. */
  level: OrgLevel;
  /** The resource who manages this node — soft reference, like `Resource.managerId`. */
  managerId?: string;
}
```

Import `OrgLevel` from `./org-scope.util` at the top of the file, beside the other util type imports.

- [ ] **Step 2: Extend the Drizzle table**

In `src/db/schema.ts`, inside the `resourceOrganizations` table definition, add the three columns and an index on the parent (the tree is walked upward on every read that derives dimensions):

```ts
    parentId: text('parent_id'),
    level: text('level').$type<OrgLevel>().notNull().default('capability'),
    managerId: text('manager_id'),
```

and add to the index list:

```ts
    index('resource_organizations_parent_id_idx').on(t.parentId),
```

`parentId` is a **plain `text`**, not a self-FK — the same deliberate choice C2 made for `replacedFromAssignmentMonthId`: a self-FK would order the seed and the deletes for no benefit the validation does not already give. Import `OrgLevel` from `../app/services/org-scope.util`.

The `default('capability')` is what makes the migration additive with no backfill step: existing rows become valid roots (spec §2.5).

- [ ] **Step 3: Generate the migration**

Run: `./node_modules/.bin/drizzle-kit generate`
Expected: a new `drizzle/00NN_*.sql` adding the three columns and the index, plus its journal entry and snapshot. **Read the generated SQL** and confirm it is `ALTER TABLE ... ADD COLUMN` only — if it proposes to drop or recreate anything, stop and report it.

- [ ] **Step 4: Seed a real three-level example**

In `src/db/seed.ts`, replace the `resourceOrganizations` array with the tree below. The four pre-existing rows keep their ids and names — resources reference them by name and rate cards match on the same names — and become `capability` roots, exactly as the spec requires. Two new nodes give the feature something to exercise on first boot, and `managerId: '1'` makes the scope non-empty (resource `'1'` is a seeded internal resource who already manages others).

```ts
// D — the org tree. The four F2 rows keep their ids and names (resources bind
// by NAME and rate cards match on the same value) and become capability roots:
// we do not invent a hierarchy we do not know. PRA-1/COM-1 are a real
// three-level branch so the scope and the filters are exercisable on first boot.
export const resourceOrganizations: ResourceOrganization[] = [
  { id: '1', name: 'Res Org Germany', description: 'Resource Org for Germany', costCenters: ['CC_DE_1', 'CC_DE_2'], serviceOrganizationId: '1', level: 'capability' },
  { id: '2', name: 'Engineering', description: 'Engineering organization', costCenters: ['CC-9001'], serviceOrganizationId: '1', level: 'capability', managerId: '1' },
  { id: '3', name: 'Consulting', description: 'Consulting organization', costCenters: ['CC-9002'], serviceOrganizationId: '1', level: 'capability' },
  { id: '4', name: 'Design', description: 'Design organization', costCenters: [], serviceOrganizationId: '1', level: 'capability' },
  { id: '5', name: 'Platform', description: 'Platform practice, under Engineering', costCenters: [], serviceOrganizationId: '1', level: 'practice', parentId: '2', managerId: '1' },
  { id: '6', name: 'Backend', description: 'Backend competence, under Platform', costCenters: [], serviceOrganizationId: '1', level: 'competence', parentId: '5' },
];
```

- [ ] **Step 5: Verify both adapters boot and agree**

```bash
./node_modules/.bin/ng test
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
curl -s http://localhost:4173/api/resource-organizations | head -c 400
kill %1
```

Then on a **fresh** Postgres database — this is not optional, and it is not a formality. C1 shipped a server that could not boot on a fresh DB because a new reference broke the seed order in `src/db/bootstrap.ts`, invisible in-memory because that adapter enforces no FKs. `parentId` is a self-reference: confirm the roots are inserted before the children, or that nothing enforces it.

```bash
docker compose up -d postgres
createdb -h localhost -U postgres d_task2_fresh    # or psql CREATE DATABASE
DATABASE_URL=postgres://postgres:postgres@localhost:5432/d_task2_fresh \
  AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 6
curl -s http://localhost:4173/api/resource-organizations | head -c 400
kill %1
dropdb -h localhost -U postgres d_task2_fresh
```

Report the actual JSON you saw from both adapters, and confirm `level` came back on every row. If Docker is unavailable, say so **prominently** rather than skipping it quietly.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/seed.ts src/app/services/api.service.ts drizzle/
git commit -m "feat(d): org tree columns on resource_organizations, with a seeded three-level branch"
```

---

### Task 3: Integrity on the org catalog

**Spec:** §2.1, §2.4, §4.1 (the two backend facts), §6.

**Files:**
- Modify: `src/server.ts:3117-3136` — the four bespoke `/resource-organizations` handlers
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `wouldCycleInOrgTree`, `ORG_LEVELS`, `OrgLevel` (Task 1); the three columns (Task 2).
- Produces: `validateOrgTreeNode(body, ctx)` — an async validator beside the existing `validateResourceOrgRefs`, returning a 400-suitable message or `null`.

**Read this before you start.** `/resource-organizations` is **not** mounted with `crud()`: it has four bespoke handlers, and the `pick()` allow-list is **duplicated** between `POST` (`:3119`) and `PUT` (`:3130`). A column missing from an allow-list is not writable and fails **silently** — no error, the field simply never arrives. Both lists must gain the three names.

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-api.mjs`, beside the existing customizing-catalog checks, add a block that drives the real API. Follow the file's existing helper style (`post`, `put`, `del`, `check`) — read a neighbouring block first and match it exactly.

The checks, each of which must fail against the current build:

1. `POST /resource-organizations` with `{name: 'D Smoke Practice', description: 'x', level: 'practice', parentId: '2'}` → 200, and the response **carries** `level: 'practice'` and `parentId: '2'` (today: silently dropped by `pick`).
2. `POST` with `{name: 'D Smoke Bad', description: 'x', level: 'practice'}` (no parent) → **400**.
3. `POST` with `{name: 'D Smoke Bad2', description: 'x', level: 'competence', parentId: '2'}` (a competence whose parent is a capability) → **400**.
4. `POST` with `{name: 'Engineering', description: 'x', level: 'capability'}` (a name already in the tree) → **400**.
5. `PUT /resource-organizations/2` with `{name: 'Engineering'}` (its own name, unchanged) → **200** — a record must not collide with itself.
6. `PUT /resource-organizations/2` with `{parentId: '6'}` (its own descendant) → **400**.
7. `DELETE /resource-organizations/5` while node `6` still names it as parent → **409**.
8. `DELETE /resource-organizations/2` while seeded resources carry `organization: 'Engineering'` → **409**.
9. `PUT /resource-organizations/<the node from check 1>` with `{level: 'capability', parentId: ''}` → 200, and the node reads back as a root (`parentId` absent) — this is the clear-to-absent seam, and it must behave identically on both adapters.

- [ ] **Step 2: Run the smoke suite to verify the new checks fail**

```bash
./node_modules/.bin/ng build
env -u DATABASE_URL AUTH_TRUST_HEADERS=true PORT=4173 HOST=localhost node dist/app/server/server.mjs &
sleep 4
SMOKE_BASE=http://localhost:4173 node scripts/smoke-api.mjs
kill %1
```

Expected: the new checks FAIL. Record the failure lines in your report — they are the evidence the checks are real.

- [ ] **Step 3: Widen both allow-lists and add the validator**

In both `POST` (`src/server.ts:3119`) and `PUT` (`:3130`), extend the picked field list:

```ts
  const body = pick<ResourceOrganization>(req.body, [
    'name', 'description', 'costCenters', 'serviceOrganizationId',
    // D — the delivery tree. A field missing here is dropped SILENTLY.
    'parentId', 'level', 'managerId',
  ]);
```

Add the validator next to `validateResourceOrgRefs`:

```ts
/**
 * D — org-tree integrity for a `/resource-organizations` body (design spec §2.1,
 * §2.4). Returns a 400-suitable message, or null when the body is acceptable.
 *
 * `ctx.id` is the record's own id on PUT (absent on POST): the name-uniqueness
 * check must exclude the record being edited, or renaming nothing would 400.
 *
 * Cycles are refused here, in WRITE. The read side is separately cycle-safe
 * (org-scope.util carries a visited set on every traversal) — both are needed:
 * this stops new cycles, that survives ones already in the data.
 */
async function validateOrgTreeNode(
  body: Partial<ResourceOrganization>,
  ctx?: { id?: string },
): Promise<string | null> {
  const all = await repos.resourceOrganizations.list();
  const nodes = all.map(n => ({ id: n.id, name: n.name, level: n.level, parentId: n.parentId, managerId: n.managerId }));
  const existing = ctx?.id === undefined ? undefined : all.find(n => n.id === ctx.id);

  const level = (body.level ?? existing?.level) as OrgLevel | undefined;
  if (level !== undefined && !ORG_LEVELS.includes(level)) {
    return `level must be one of ${ORG_LEVELS.join(', ')}`;
  }
  // An empty string clears the parent (the clear-to-absent seam), so treat it as absent.
  const rawParent = body.parentId === undefined ? existing?.parentId : body.parentId;
  const parentId = rawParent === '' || rawParent === null ? undefined : rawParent;

  if (level === 'capability' && parentId !== undefined) return 'a capability is a root and cannot have a parent';
  if (level !== undefined && level !== 'capability') {
    if (parentId === undefined) return `a ${level} must have a parent`;
    const parent = all.find(n => n.id === parentId);
    if (parent === undefined) return 'parentId must reference an existing resource organization';
    const wanted = ORG_LEVELS[ORG_LEVELS.indexOf(level) - 1];
    if (parent.level !== wanted) return `the parent of a ${level} must be a ${wanted}`;
  }
  if (ctx?.id !== undefined && wouldCycleInOrgTree(ctx.id, parentId, nodes)) {
    return 'parentId would close a cycle in the organizational tree';
  }
  const name = body.name ?? existing?.name;
  if (name !== undefined && all.some(n => n.name === name && n.id !== ctx?.id)) {
    return 'name must be unique across the whole organizational tree';
  }
  if (body.managerId !== undefined && body.managerId !== '') {
    const manager = await repos.resources.get(body.managerId);
    if (manager === undefined) return 'managerId must reference an existing resource';
  }
  return null;
}
```

Call it in both `POST` and `PUT`, immediately after the existing `validateResourceOrgRefs` call, passing `{ id: req.params.id }` on the `PUT` and nothing on the `POST`.

Then guard the `DELETE` (`:3136`), which today removes with no checks at all:

```ts
apiRouter.delete('/resource-organizations/:id', async (req, res) => {
  const node = await repos.resourceOrganizations.get(req.params.id);
  if (node === undefined) { res.status(404).json({ error: 'Not found' }); return; }
  const all = await repos.resourceOrganizations.list();
  if (all.some(n => n.parentId === req.params.id)) {
    res.status(409).json({ error: 'Cannot delete an organization that has children' }); return;
  }
  // Resources bind to a node by NAME (design spec §2.4), so this is a name check.
  const resources = await repos.resources.list();
  if (resources.some(r => r.organization === node.name)) {
    res.status(409).json({ error: 'Cannot delete an organization that resources still reference' }); return;
  }
  await repos.resourceOrganizations.remove(req.params.id);
  res.status(204).send();
});
```

- [ ] **Step 4: Run the smoke suite again, then the full gates**

Re-run the sequence from Step 2 and confirm every new check now passes and no pre-existing check regressed. Then `./node_modules/.bin/ng test` and `./node_modules/.bin/ng lint`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(d): org-tree integrity — levels, unique names, cycles, protected deletes"
```

---

### Task 4: Refuse a cycle in the org chart

**Spec:** §3.2 point 2, §6.

**Files:**
- Modify: `src/server.ts` — the `PUT /resources/:id` handler (find it by its `validateResourceCatalogRefs` call, around `:1352-1372`)
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `wouldCycleInOrgChart` (Task 1).
- Produces: nothing new.

`managerId` is a free field of the resource form, so a cycle is one careless edit away — and a cycle in the org chart is what would make the scope computation of Task 5 traverse forever if the read side were not separately guarded.

- [ ] **Step 1: Write the failing smoke checks**

In `scripts/smoke-api.mjs`, in the resource-validation block:

1. `PUT /resources/1` with `{managerId: '1'}` (itself) → **400** mentioning a cycle.
2. Seeded resource `'3'` has `managerId: '2'` and `'2'` has `managerId: '1'`. `PUT /resources/1` with `{managerId: '3'}` → **400** (it would close 1 → 3 → 2 → 1).
3. `PUT /resources/1` with `{managerId: ''}` → 200, and the resource reads back with no manager (clear-to-absent).

- [ ] **Step 2: Run the smoke suite to verify they fail**

Same build-and-run sequence as Task 3 Step 2. Expected: checks 1 and 2 FAIL (today both are accepted).

- [ ] **Step 3: Implement the guard**

In the `PUT /resources/:id` handler, after the existing catalog validation and before the write:

```ts
  // D — a cycle in the org chart would make every scope computation for these
  // people meaningless, and `managerId` is a free field of the resource form.
  // The read side (org-scope.util) is separately cycle-safe; this stops NEW ones.
  if (body.managerId !== undefined) {
    const all = await repos.resources.list();
    if (wouldCycleInOrgChart(req.params.id, body.managerId === '' ? undefined : body.managerId, all)) {
      res.status(400).json({ error: 'managerId would close a cycle in the org chart' }); return;
    }
  }
```

Apply the same check in `POST /resources` **only if** that handler accepts `managerId` — read it and say which you found. A brand-new resource has no reports, so a cycle there is only possible by naming itself, which it cannot do (the id does not exist yet).

- [ ] **Step 4: Run the smoke suite and the unit gates**

Re-run smoke; then `./node_modules/.bin/ng test` and `./node_modules/.bin/ng lint`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(d): refuse a manager assignment that would close a cycle"
```

---

### Task 5: Scope the decision

**Spec:** §3.3, §3.4, §3.5. This is the task the whole block exists for. Read those three sections in full before writing anything.

**Files:**
- Modify: `src/server.ts` — `decideOneApproval`, the step-enforcement block at `:4255-4283`
- Modify: `src/app/allocation-approvals/approval-modal.component.ts:483-487` — `canDecideFor`, plus its `.spec.ts`
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `scopedApproversOf` (Task 1).
- Produces: the decision rule that Task 6's feed mirrors.

**You are deliberately reopening a documented decision. Read this carefully.**

The comment at `src/server.ts:4263-4272` says, in so many words, that admitting *any* `resource-manager` is DELIBERATE per the gap-A spec §4.3, and it ends with: *"do not tighten the code to match that wording without reopening the spec decision."* **That decision has been reopened and changed with the user**, and the D design spec §3.4 is the new rule. Your job includes **rewriting that comment** so the next reader is not told the opposite of what the code now does — that exact confusion already cost a review cycle in B3.

The new rule, precisely:

```
An actor may decide a step when ANY of these holds:
  1. they are the step's named approver (`step.approverId === deciderResourceId`)  — unchanged;
  2. they hold the step's role AND the target resource is in their scope;
  3. they hold the step's role AND the target has no manager anywhere
     (`scopedApproversOf(...).roleFallback === true`)                              — the last resort;
  4. their role is 'admin'                                                          — unchanged.
```

`delivery-executive` keeps the coarse access it has today: it is a global role (spec §3.3), so treat it like `admin` for **allocation** steps rather than subjecting it to scope. Segregation of duties stays exactly where it is, above this block, and still binds every role.

**Scope applies to allocation steps only.** Other approval kinds (time entries, change requests, high-value chains) route by role and have no target resource — leave them on the current rule. Find the target resource id from the approval's `refId`/`resourceId` the same way the surrounding code already does, and if you cannot determine a target resource, fall through to the current behaviour rather than refusing.

- [ ] **Step 1: Write the failing smoke checks**

The pre-existing allocation-approval checks authenticate as some `resource-manager`. Some will now legitimately fail — **that is the breaking change of spec §3.5**. Fix them by making the actor a manager who is actually in scope (change the fixture's actor, never weaken the assertion), and list every check you touched in your report.

New checks, each of which must fail against the current build:

1. **A manager in scope decides and succeeds.** Resource `'3'` has `managerId: '2'`; acting as the user whose `resourceId` is `'2'`, decide an allocation approval for resource `'3'` → **200**.
2. **A stranger is refused.** Acting as a `resource-manager` who is neither in `'3'`'s management chain nor a manager of any node above `'3'`'s organization, decide the same kind of approval → **403**. This is the check that passes today and must not.
3. **The node manager decides.** Resource `'1'` manages node `'2'` (`Engineering`) in the seed. A resource attached to `Engineering` — or to `Platform`/`Backend` beneath it — is decidable by `'1'` even with no org-chart link → **200**.
4. **The fallback still works.** A dummy (seeded ids `'4'`/`'5'`) has no `managerId`; attach it to a node with no manager anywhere above it, and confirm an arbitrary `resource-manager` can still decide → **200**. This is what keeps C2's substitutions working.
5. **Admin is unaffected** → **200**.

- [ ] **Step 2: Run the smoke suite to verify the new checks fail**

Same build-and-run sequence as Task 3 Step 2. Report the failure lines.

- [ ] **Step 3: Implement the scoped rule**

Replace the `roleMatch`/`managerMatch` block, keeping the SoD check above it untouched:

```ts
    // STEP ENFORCEMENT — D (design spec §3.4). Supersedes the gap-A role
    // fallback: an actor holding the step's role no longer decides for ANYONE.
    //
    // HISTORY, so nobody re-tightens or re-loosens this by accident: gap-A §4.3
    // deliberately let any resource-manager decide, so that a manager was not a
    // single point of failure for their own team. D replaces that with a real
    // scope — the transitive org chart UNION the org subtrees the actor manages —
    // and keeps a fallback ONLY for a resource with no manager anywhere, which is
    // the case of a placeholder (dummy) today and is what keeps C2's
    // substitutions decidable. This change was made WITH the user; the previous
    // comment here said the opposite and predates that decision.
    //
    // Scope binds ALLOCATION steps only: other kinds route by role and have no
    // target resource. `admin` and `delivery-executive` are global roles and are
    // not scoped. Segregation of duties is enforced separately, ABOVE, and binds
    // every role. `canDecideFor` in the approvals modal mirrors this rule.
    const roleMatch = decidingRole === step.role || decidingRole === 'admin';
    const managerMatch = step.approverId !== undefined && deciderResourceId === step.approverId;
    const globalRole = decidingRole === 'admin' || decidingRole === 'delivery-executive';
    let scopeMatch = roleMatch;
    const targetResourceId = await allocationTargetResourceId(ar);
    if (roleMatch && !globalRole && targetResourceId !== undefined) {
      const target = await repos.resources.get(targetResourceId);
      if (target !== undefined) {
        const [resources, nodes] = await Promise.all([repos.resources.list(), repos.resourceOrganizations.list()]);
        const { managerIds, roleFallback } = scopedApproversOf(target, resources, nodes);
        scopeMatch = roleFallback || (deciderResourceId !== undefined && managerIds.has(deciderResourceId));
      }
    }
    if (!scopeMatch && !managerMatch) {
      return { status: 403, body: { error: `Actor cannot decide a step assigned to ${step.approverId ?? step.role}` } };
    }
```

Add the helper that answers "which resource is this approval about", returning `undefined` for any approval that is not an allocation — that `undefined` is what makes the rule fall through for the other kinds:

```ts
/**
 * D — the resource an ALLOCATION approval is about, or undefined for any other
 * kind. Undefined means "not scoped": the caller falls through to the role rule.
 */
async function allocationTargetResourceId(ar: ApprovalRequestEntry): Promise<string | undefined> {
  if (ar.kind !== 'allocation') return undefined;
  // An allocation approval's refId is either an assignment id or a
  // `<assignmentId>:<YYYY-MM>` month-row id (B3). Both resolve via the assignment.
  const assignmentId = ar.refId.includes(':') ? ar.refId.split(':')[0] : ar.refId;
  const assignment = await repos.assignments.get(assignmentId);
  return assignment?.resourceId;
}
```

**Verify the `kind` value and the `refId` shape against the code before you rely on them** — read how `createAllocationApproval` builds the entry, and say in your report what you found. Do not guess.

- [ ] **Step 4: Mirror the rule in the modal**

`canDecideFor` (`src/app/allocation-approvals/approval-modal.component.ts:483-487`) currently returns `true` for any `resource-manager`, which would now promise the operator a button the server refuses. Replace its body with the same rule, using `scopedApproversOf` over the resource list and the org tree, and add the component spec cases: a manager in scope sees the action, a stranger does not, admin always does, and a resource with no manager anywhere leaves it available to any `resource-manager`. **Assert on the rendered DOM**, not on the method's return value.

The modal needs the resources and the org tree: add them the way the file already loads its resource list for C2's person search (`resourcesRes`, keyed on `auth.authReady()`), and follow that pattern exactly for the org tree.

- [ ] **Step 5: Run everything**

`./node_modules/.bin/ng test`, `./node_modules/.bin/ng lint`, `./node_modules/.bin/ng build`, then the smoke suite in-memory. Report the numbers.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/app/allocation-approvals scripts/smoke-api.mjs
git commit -m "feat(d): scope the allocation decision to the competent manager"
```

---

### Task 6: Scope the approval feed

**Spec:** §3.3.

**Files:**
- Modify: `src/server.ts` — the `GET /allocation-approvals` handler (starts at `:2851`)
- Modify: `scripts/smoke-api.mjs`

**Interfaces:**
- Consumes: `scopeOf`, `scopedApproversOf` (Task 1); the decision rule (Task 5).
- Produces: nothing new.

Today the feed returns every row to anyone holding one of the roles in the `/allocation-approvals` rule (`src/server.ts:542`). A manager should see their own scope — otherwise the page offers rows whose buttons the server now refuses, which reads as a broken UI rather than as a permission boundary.

- [ ] **Step 1: Write the failing smoke checks**

1. Acting as the user whose `resourceId` is `'2'` (manager of resource `'3'`), `GET /allocation-approvals` → the payload's `rows` contain `'3'` and **do not** contain a resource outside that scope.
2. Acting as `admin` → the feed is unrestricted (at least as many rows as the scoped call).
3. Acting as `delivery-executive` → unrestricted, for the same reason as in Task 5.
4. A resource with no manager anywhere (a dummy) **appears** for any `resource-manager` — the feed must mirror the decision fallback, or those rows would become invisible and undecidable in practice.

- [ ] **Step 2: Run the smoke suite to verify they fail**

Same sequence as Task 3 Step 2.

- [ ] **Step 3: Implement**

**This handler does not read the principal today** — it takes only query parameters. You are adding the first principal read to it, so use the two established helpers rather than inventing a third path:

- `trustedRole(req)` (`src/server.ts:460`) → `UserRole | 'unknown'`. A verified JWT role always wins; the demo `X-User-*` header is honoured only when `AUTH_TRUST_HEADERS=true`.
- `await actorResourceId(req)` (`src/server.ts:425`) → the actor's **resource** id or `undefined`. The org chart keys on resource ids, not user ids: comparing a raw username against a `resourceId` is always false under real JWT auth, which is exactly how a scope check silently degrades into "nobody matches". `PUT /time-entries/:id` at `src/server.ts:3029` is the precedent — read its comment.

In the handler, after the existing query-parameter validation and before building the rows:

```ts
  // D (design spec §3.3) — a manager sees their own scope. This rule MUST mirror
  // `decideOneApproval`: a row the actor cannot decide would render as a dead
  // button, and a row they CAN decide must never be hidden — hence the
  // no-manager-anywhere rows stay visible to every resource-manager.
  const feedRole = trustedRole(req);
  const feedActorResourceId = await actorResourceId(req);
  const feedGlobalRole = feedRole === 'admin' || feedRole === 'delivery-executive';
  const visibleResourceIds = feedGlobalRole || feedActorResourceId === undefined
    ? undefined
    : scopeOf(feedActorResourceId, allResources, orgNodes);
```

then, where the handler decides whether to include a resource, skip it when

```ts
  visibleResourceIds !== undefined
    && !visibleResourceIds.has(resource.id)
    && !scopedApproversOf(resource, allResources, orgNodes).roleFallback
```

`allResources` and `orgNodes` are the lists the handler must load — it already loads resources for the rows; add the org tree beside it with a single `repos.resourceOrganizations.list()`. Say in your report which existing variable held the resource list.

Note the `undefined` actor case: it means the principal could not be resolved to a resource, which under `AUTH_TRUST_HEADERS=true` includes an unmapped demo user. Leaving the feed unscoped there is deliberate — the alternative is an empty page for a legitimate dev session — and the decision gate in Task 5 still refuses those actors.

- [ ] **Step 4: Run the smoke suite and the gates**

Re-run smoke; then `./node_modules/.bin/ng test` and `./node_modules/.bin/ng lint`.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts scripts/smoke-api.mjs
git commit -m "feat(d): the approval feed shows a manager their own scope"
```

---

### Task 7: The customizing tree

**Spec:** §4.1.

**Files:**
- Modify: `src/app/configuration/manage-resource-organizations.component.ts` + its `.spec.ts`

**Interfaces:**
- Consumes: `ResourceOrganization` with the three columns (Task 2); `ORG_LEVELS`, `ancestorChain` (Task 1).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing component tests**

Read the component and its existing spec first, and follow the spec file's own setup helper. Then add:

```ts
it('renders the tree with children nested under their parent', async () => {
  // Fixture: capability 'Engineering' (id 2) with practice 'Platform' (id 5, parentId 2).
  const { fixture } = await setup();
  const host = fixture.nativeElement as HTMLElement;
  const row = host.querySelector('[data-test="org-node-5"]');
  expect(row).not.toBeNull();
  expect(row!.getAttribute('data-depth')).toBe('1');
  expect(host.querySelector('[data-test="org-node-2"]')!.getAttribute('data-depth')).toBe('0');
});

it('offers a parent select on a practice and none on a capability', async () => {
  const { fixture } = await setup();
  fixture.componentInstance.startEdit(/* the capability fixture row */);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  expect(host.querySelector('[data-test="org-parent"]')).toBeNull();
  fixture.componentInstance.startEdit(/* the practice fixture row */);
  fixture.detectChanges();
  const parent = host.querySelector<HTMLSelectElement>('[data-test="org-parent"]');
  expect(parent).not.toBeNull();
  expect(parent!.value).toBe('2');          // the DOM value, not the signal
});

it('sends level, parent and manager on save', async () => {
  const { fixture, updateResourceOrganization } = await setup();
  fixture.componentInstance.startEdit(/* the practice fixture row */);
  fixture.detectChanges();
  fixture.componentInstance.save();
  expect(updateResourceOrganization).toHaveBeenCalledWith('5', expect.objectContaining({
    level: 'practice', parentId: '2',
  }));
});
```

Adapt the fixture rows and the method names to what the component actually exposes — read it, do not assume `startEdit`/`save` exist under those names.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./node_modules/.bin/ng test --include='**/manage-resource-organizations.component.spec.ts'`

- [ ] **Step 3: Implement**

The list becomes a tree: order the rows so each node follows its parent, and indent by depth (`ancestorChain(...).length - 1`), with `data-test="org-node-<id>"` and `data-depth` on each row so the spec can assert structure. The form gains a **level** select, a **parent** select (hidden for a `capability`, and listing only nodes of the legal parent level) and a **manager** select over the resource list.

**The parent and manager selects must use per-`<option>` `[selected]`, never `[value]` on the `<select>`.** Options come from an `@for`, and a `[value]` binding applied before they exist is silently dropped — this exact bug reached the browser twice in this repo. The established pattern is at `src/app/allocation-approvals/allocation-approvals.component.ts:135-148`.

Server-side validation stays the authority (Task 3); the UI mirrors it to avoid a pointless roundtrip. Copy in English, `command-*` classes only.

- [ ] **Step 4: Run the tests, then look at it in a browser**

`./node_modules/.bin/ng test`, `./node_modules/.bin/ng lint`, `./node_modules/.bin/ng build`. Then run a server on port **4173** (4200 may be occupied), open the configuration page, create a practice under a capability, reparent it, and try an illegal level — say concretely what you saw, including the error text the server returned.

- [ ] **Step 5: Commit**

```bash
git add src/app/configuration
git commit -m "feat(d): tree view, level, parent and manager in the org customizing"
```

---

### Task 8: The dimension filters

**Spec:** §4.2.

**Files:**
- Modify: `src/app/resources/resources.component.ts` + `.spec.ts`
- Modify: `src/app/staffing/staffing.component.ts` + `.spec.ts`
- Modify: `src/app/allocation-approvals/allocation-approvals.component.ts` + `.spec.ts`

**Interfaces:**
- Consumes: `dimensionsOf` (Task 1); the org tree from `ApiService.getResourceOrganizations(): Observable<ResourceOrganization[]>` (`src/app/services/api.service.ts:1045`).
- Produces: nothing.

Three surfaces, one pattern. `resources.component.ts` already has the shape to copy: `search`, `activeOnly` and `kindFilter` signals feeding a single `filteredResources` computed (`:536-556`).

- [ ] **Step 1: Write the failing component tests**

For **each** of the three components, following that file's own setup helper:

```ts
it('filters the list by capability', async () => {
  // Fixture: one resource on 'Backend' (competence under Platform under Engineering),
  // one on 'Consulting' (a capability of its own).
  const { fixture } = await setup();
  fixture.componentInstance.capabilityFilter.set('Engineering');
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
  expect(names).toContain('Jane Doe');        // on Backend, under Engineering
  expect(names).not.toContain('John Miller'); // on Consulting
});

it('offers only the dimensions that exist in the tree', async () => {
  const { fixture } = await setup();
  const host = fixture.nativeElement as HTMLElement;
  const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="capability-filter"] option')]
    .map(o => o.value);
  expect(opts).toEqual(['', 'Engineering', 'Consulting']);   // '' = all
});
```

The filter must match a resource attached **below** the chosen capability, not only one attached directly to it — that is the whole point of deriving through `dimensionsOf`, and a test that attaches the resource directly to the capability would pass against a naive `r.organization === filter` implementation. Keep the indirect fixture.

- [ ] **Step 2: Run the tests to verify they fail**

Run each: `./node_modules/.bin/ng test --include='**/resources.component.spec.ts'` and so on.

- [ ] **Step 3: Implement**

In each component: three signals (`capabilityFilter`, `practiceFilter`, `competenceFilter`, all `signal('')`), the org tree loaded through an `rxResource` keyed on `auth.authReady()`, and the existing filter `computed` extended with

```ts
      const dims = dimensionsOf(r, this.orgNodes());
      if (cap && dims.capability !== cap) return false;
      if (pra && dims.practice !== pra) return false;
      if (com && dims.competence !== com) return false;
```

The option lists come from the tree filtered by level, and the People Manager filter (spec §4.2) is the same gesture: a select over the distinct `managerId`s present, matching on `r.managerId`. Selects use per-`<option>` `[selected]`. Copy in English.

- [ ] **Step 4: Run the tests and the gates**

`./node_modules/.bin/ng test`, `./node_modules/.bin/ng lint`, `./node_modules/.bin/ng build`.

- [ ] **Step 5: Commit**

```bash
git add src/app/resources src/app/staffing src/app/allocation-approvals
git commit -m "feat(d): capability, practice, competence and people-manager filters"
```

---

### Task 9: Consumer sweep, docs, full verification

**Spec:** all of it, plus §8 for what must stay out.

**Files:**
- Modify: `docs/roles-and-permissions.md`, `docs/architecture/03-backend-and-data.md`
- Modify: whatever the sweep turns up

- [ ] **Step 1: Do the sweep, and record a decision for every consumer**

The two previous blocks each shipped surfaces that kept their old behaviour because no task owned them: C1 missed four (a legitimate multi-FTE booking reading as over-capacity, ~250% in the worst band, a second instance in the month header, and dummy demand inflating the portfolio KPIs while being dropped from the CSV), and in C2 the sweep found two pre-existing handlers that ended a substitution without giving hours back — but concluded "0 surfaces to change" and **missed** that the feature *created* an assignment other surfaces read, which rendered 40 hours as a six-month full-time booking with false conflicts.

So the sweep has two questions, not one:

1. **Who reads what I changed?** `grep` every consumer of `resource.organization`, `resource.managerId`, `repos.resourceOrganizations` and the approval feed — `src/server.ts`, `pickRateCard`, `match.util`, `schedule.util`, `capacity.util`, `dashboard.component.ts`, `app.ts`, the reporting surfaces, every `manage-*` component.
2. **What do I now create or expose that others read?** The derived dimensions, the node manager, and the newly-scoped feed.

Record in your report, for **every** consumer: what it reads, whether D changes what it should show, and your decision — **including the ones that need nothing, with the reason.** A consumer you do not mention reads as one you did not look at.

Two specific things to confirm, not assume:
- **`pickRateCard` still resolves.** It matches a rate card on the resource's organization **name** (`src/server.ts:1240-1252`). Names did not change in Task 2 — verify a seeded resource still gets its rate, and say which resource and which rate you saw.
- **A resource attached to a `practice` or `competence` still gets a rate card**, or say plainly that it does not and that it is out of scope (a rate card configured on `Engineering` does not automatically cover a competence beneath it — this is a real product question, not a bug for you to fix).

- [ ] **Step 2: Update the docs**

`docs/roles-and-permissions.md`: the new scope rule for allocation decisions, the fallback and its exact condition, and that `admin`/`delivery-executive` stay global. This file is the definitive RBAC reference and is kept in sync with the code — the old gap-A fallback sentence must go.

`docs/architecture/03-backend-and-data.md`: the three columns, the two orthogonal upward references (`parentId` = delivery, `serviceOrganizationId` = financial), that `parentId` is deliberately not a self-FK, and that dimensions are derived rather than stored.

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

Note: the smoke suite is **not idempotent against a warm in-memory server** — restart the process between runs, or you will chase phantom failures. It also runs close to the API's own 300 req/min rate limit; if you see 429s, that is the limiter, not your code.

- [ ] **Step 4: Postgres parity run on a fresh database**

Create a genuinely **fresh** database, start the built server against it with `DATABASE_URL`, confirm every migration applied (including Task 2's), run the same smoke suite, then drop the database. Report the evidence: the migration count, the columns present, and the pass count. If Docker is unavailable, say so **prominently** rather than skipping silently.

- [ ] **Step 5: Commit**

```bash
git add -A docs src scripts
git commit -m "docs(d): the scope rule in the RBAC reference and the org tree in the entity catalogue"
```

---

## Verification Checklist (before merge)

- [ ] A manager decides for a direct report, and for a report of a report.
- [ ] A manager of a `capability` decides for a resource attached to a `competence` two levels beneath it, with no org-chart link.
- [ ] A `resource-manager` who is neither gets **403** — the check that passes today and must not.
- [ ] A resource with no manager anywhere stays decidable by any `resource-manager`, and its rows stay **visible** in the feed.
- [ ] `admin` and `delivery-executive` are unaffected in both the decision and the feed.
- [ ] Segregation of duties still refuses a requester deciding their own item, at every role.
- [ ] The modal offers the decision action exactly where the server would allow it.
- [ ] A cycle in the org tree and a cycle in the org chart are both refused with **400**; a cycle already in the data does not hang any read.
- [ ] A duplicate node name is refused; renaming a node to its own name is not.
- [ ] Deleting a node with children, or one that resources still reference, gives **409**.
- [ ] Clearing `parentId` and clearing `managerId` behave identically on both adapters.
- [ ] `pickRateCard` still resolves a rate for a seeded resource.
- [ ] Filters match resources attached **below** the chosen dimension, not only directly to it.
- [ ] Unit, lint, build, live smoke and the fresh-Postgres run are all green.
