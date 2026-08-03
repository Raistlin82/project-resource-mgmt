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
