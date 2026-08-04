import { describe, it, expect } from 'vitest';
import {
  accountableApproversOf, ancestorChain, descendantOrgIds, dimensionsOf, isTerminatedAsOf, nodeManagersAbove,
  nodeByName, reportsClosure, scopeOf, scopedApproversOf, wouldCycleInOrgChart, wouldCycleInOrgTree,
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

  it('does not hang on a cycle in the org tree', () => {
    const cyclic: OrgNode[] = [
      { id: 'A', name: 'A', level: 'practice', parentId: 'B' },
      { id: 'B', name: 'B', level: 'practice', parentId: 'A' },
    ];
    expect([...descendantOrgIds('A', cyclic)].sort()).toEqual(['A', 'B']);
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

  it('falls back when the only candidate manager is the target itself', () => {
    // r100 IS the manager of 'Delivery' (CAP) and sits on that very node, with
    // no personal managerId. Removing the target from its own candidate set
    // empties it: nobody but r100 is accountable, and r100 cannot approve for
    // themselves, so this must be a role fallback, not an empty-but-valid set.
    const { managerIds, roleFallback } = scopedApproversOf(
      { id: 'r100', organization: 'Delivery' }, RESOURCES, NODES);
    expect([...managerIds]).toEqual([]);
    expect(roleFallback).toBe(true);
  });

  it("ignores an empty-string node managerId instead of admitting it as a manager", () => {
    // The clear-to-absent sentinel, persisted. Admitting it would name an
    // approver nobody can be AND keep roleFallback false — a silent lockout.
    const sentinel: OrgNode[] = [{ id: 'CAP3', name: 'Sentinel', level: 'capability', managerId: '' }];
    const { managerIds, roleFallback } = scopedApproversOf(
      { id: 'z', organization: 'Sentinel' }, [], sentinel);
    expect([...managerIds]).toEqual([]);
    expect(roleFallback).toBe(true);
  });
});

describe('nodeManagersAbove', () => {
  it('names every node manager from the attachment up to the root, and nothing else', () => {
    expect([...nodeManagersAbove({ id: 'x', organization: 'Backend' }, NODES)].sort())
      .toEqual(['r100', 'r200', 'r300']);
    // The org chart contributes NOTHING here — that is the whole point of the
    // split (autoApprovesAllocation must widen on this axis alone).
    expect([...nodeManagersAbove({ id: 'x', managerId: 'r2' }, NODES)]).toEqual([]);
  });

  it('is empty for an unknown or absent attachment, and ignores the empty-string sentinel', () => {
    expect([...nodeManagersAbove({ id: 'x' }, NODES)]).toEqual([]);
    expect([...nodeManagersAbove({ id: 'x', organization: 'Nope' }, NODES)]).toEqual([]);
    const sentinel: OrgNode[] = [{ id: 'CAP6', name: 'Blank', level: 'capability', managerId: '' }];
    expect([...nodeManagersAbove({ id: 'x', organization: 'Blank' }, sentinel)]).toEqual([]);
  });
});

describe('isTerminatedAsOf', () => {
  it('is true only from the termination date onwards', () => {
    expect(isTerminatedAsOf({ terminationDate: '2026-08-04' }, '2026-08-04')).toBe(true);
    expect(isTerminatedAsOf({ terminationDate: '2026-08-03' }, '2026-08-04')).toBe(true);
    expect(isTerminatedAsOf({ terminationDate: '2026-08-05' }, '2026-08-04')).toBe(false);
  });

  it('treats an absent or cleared terminationDate as active', () => {
    expect(isTerminatedAsOf({}, '2026-08-04')).toBe(false);
    expect(isTerminatedAsOf({ terminationDate: '' }, '2026-08-04')).toBe(false);
  });
});

describe('accountableApproversOf', () => {
  const TODAY = '2026-08-04';

  it('is scopedApproversOf when every named approver is still active', () => {
    const structural = scopedApproversOf(RESOURCES[0], RESOURCES, NODES);
    const accountable = accountableApproversOf(RESOURCES[0], RESOURCES, NODES, TODAY);
    expect([...accountable.managerIds].sort()).toEqual([...structural.managerIds].sort());
    expect(accountable.roleFallback).toBe(false);
  });

  it('drops a terminated manager from the set', () => {
    const resources: ScopeResource[] = [
      { id: 'r1', managerId: 'gone', organization: 'Engineering' },
      { id: 'gone', terminationDate: '2026-01-31' },
    ];
    // The org chart offers only the departed manager; 'Engineering' still has
    // its own (active) node manager r200, so the set narrows but is not empty.
    const { managerIds, roleFallback } = accountableApproversOf(resources[0], resources, NODES, TODAY);
    expect([...managerIds].sort()).toEqual(['r100', 'r200']);
    expect(roleFallback).toBe(false);
  });

  it('falls back to the role when the ONLY accountable manager is terminated', () => {
    // THE LOCKOUT this function exists to prevent: a stale managerId keeps
    // roleFallback false, so nobody but an admin can decide for r1.
    const resources: ScopeResource[] = [
      { id: 'r1', managerId: 'gone' },
      { id: 'gone', terminationDate: '2026-01-31' },
    ];
    expect(scopedApproversOf(resources[0], resources, NODES).roleFallback).toBe(false);
    const { managerIds, roleFallback } = accountableApproversOf(resources[0], resources, NODES, TODAY);
    expect([...managerIds]).toEqual([]);
    expect(roleFallback).toBe(true);
  });

  it('falls back when a terminated NODE manager is the only candidate', () => {
    const nodes: OrgNode[] = [{ id: 'CAP4', name: 'Orphaned', level: 'capability', managerId: 'gone' }];
    const resources: ScopeResource[] = [
      { id: 'r1', organization: 'Orphaned' },
      { id: 'gone', terminationDate: '2026-01-31' },
    ];
    expect(accountableApproversOf(resources[0], resources, nodes, TODAY)).toEqual({
      managerIds: new Set<string>(), roleFallback: true,
    });
  });

  it('keeps a manager whose termination is still in the future', () => {
    const resources: ScopeResource[] = [
      { id: 'r1', managerId: 'leaving' },
      { id: 'leaving', terminationDate: '2026-12-31' },
    ];
    const { managerIds, roleFallback } = accountableApproversOf(resources[0], resources, NODES, TODAY);
    expect([...managerIds]).toEqual(['leaving']);
    expect(roleFallback).toBe(false);
  });

  it('keeps a NODE managerId that resolves to no resource at all (it fails open)', () => {
    // The tree axis adds `node.managerId` WITHOUT resolving it (there has never
    // been a referential check on it), so an unknown id does reach the set. It
    // must stay: treating "unknown" as "nobody" would quietly widen who may
    // decide for every row carrying imported/legacy data. Only a manager we can
    // see, and can see is gone, is dropped.
    //
    // The CHART axis is different by construction — it walks THROUGH the
    // resources-by-id map, so an unknown `Resource.managerId` never enters the
    // set in the first place (asserted below, so the asymmetry is deliberate
    // and recorded rather than discovered later).
    const nodes: OrgNode[] = [{ id: 'CAP5', name: 'Ghosted', level: 'capability', managerId: 'ghost' }];
    const resources: ScopeResource[] = [{ id: 'r1', organization: 'Ghosted' }];
    const viaTree = accountableApproversOf(resources[0], resources, nodes, TODAY);
    expect([...viaTree.managerIds]).toEqual(['ghost']);
    expect(viaTree.roleFallback).toBe(false);

    const chartOnly: ScopeResource[] = [{ id: 'r1', managerId: 'ghost' }];
    const viaChart = accountableApproversOf(chartOnly[0], chartOnly, [], TODAY);
    expect([...viaChart.managerIds]).toEqual([]);
    expect(viaChart.roleFallback).toBe(true);
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
