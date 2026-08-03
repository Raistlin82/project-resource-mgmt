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
 * carries a `visited`/accumulator set — THAT is what guarantees termination,
 * because a node already recorded is never re-expanded. `MAX_CHAIN_DEPTH` is
 * a second net and a declared semantic limit (a chain should never legitimately
 * be 64 hops deep), not the safety mechanism. Where a traversal fans out over a
 * tree/graph instead of walking a single chain (`descendantOrgIds`,
 * `reportsClosure`), the accumulator set alone already bounds the work to the
 * size of the input — see the note on each function for why no extra depth
 * cap is needed there.
 */
export type OrgLevel = 'capability' | 'practice' | 'competence';

/** Declared order, root first — also the legal parent order. */
export const ORG_LEVELS: readonly OrgLevel[] = ['capability', 'practice', 'competence'];

/** Declared maximum chain length. See the TERMINATION note above. */
export const MAX_CHAIN_DEPTH = 64;

/** Minimal shape of an org-tree node this layer needs. */
export interface OrgNode { id: string; name: string; level: OrgLevel; parentId?: string; managerId?: string }
/** Minimal shape of a resource this layer needs. */
export interface ScopeResource { id: string; managerId?: string; organization?: string }

/** The node a resource is attached to — resources reference nodes BY NAME (spec §2.4). */
export function nodeByName(name: string | undefined, nodes: readonly OrgNode[]): OrgNode | undefined {
  if (name === undefined || name === '') return undefined;
  return nodes.find(n => n.name === name);
}

/**
 * From `nodeId` up to the root, innermost first. Empty when the id is unknown.
 * A single-chain walk: the `visited` set stops it the instant it revisits a
 * node, and `MAX_CHAIN_DEPTH` is the declared semantic cap on top of that.
 */
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

/**
 * `rootId` and every node beneath it.
 *
 * This fans out over the tree rather than walking a single chain, so there is
 * no meaningful "depth" to cap. Termination still does not depend on
 * `MAX_CHAIN_DEPTH`: each node is grouped under its OWN `parentId` at most
 * once when `childrenOf` is built, so it can be pushed onto the queue at most
 * once across the whole run, and `out.has(id)` skips it if it is ever popped
 * again (e.g. from a cycle). Total work is therefore bounded by `nodes.length`
 * regardless of cycles, with no extra counter needed.
 */
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
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of childrenOf.get(id) ?? []) queue.push(child.id);
  }
  return out;
}

/**
 * Everyone below `managerResourceId` in the org chart. Excludes the manager.
 *
 * Same shape as `descendantOrgIds`: each resource is grouped under its OWN
 * `managerId` at most once, so `out.has(id)` alone bounds the traversal to
 * `resources.length` regardless of a cycle in the data — no extra counter.
 */
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
  while (queue.length > 0) {
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
  // This is an AUTHORIZATION decision, not hygiene. A target that is itself the
  // manager of the very node it sits on (e.g. a Capability Leader with no
  // personal managerId, managing their own capability) would otherwise appear
  // as its own only approver. Removing it can legitimately empty `managerIds`
  // and flip `roleFallback` to true — and that is CORRECT and must stay: nobody
  // can be their own approver (SoD refuses it one layer up regardless), so "the
  // only candidate is the target" really does mean nobody is accountable for
  // this resource. Do not "fix" this by keeping the target in the set.
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
