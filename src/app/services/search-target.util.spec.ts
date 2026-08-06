import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UserRole } from './api.service';
import {
  SEARCH_SECTION_KEYS, SEARCH_FOCUS_PARAM, NO_DESTINATION_SECTIONS,
  SearchSectionKey, SearchTargetCapabilities,
  canReachSearchTarget, hasDetailRoute, searchTargetFor, searchFocusLabel,
} from './search-target.util';

// =============================================================================
// The whole point of this module is that a VISIBLE row must never promise a
// navigation the router will refuse. So every test below is paired: one identity
// that may reach the target, one that may not. A one-sided test would pass
// against a function that returns a link unconditionally.
// =============================================================================

function caps(over: Partial<SearchTargetCapabilities> = {}): SearchTargetCapabilities {
  return {
    canReadStaffing: false,
    canManageStaffing: false,
    canManageCommercial: false,
    roles: [] as readonly UserRole[],
    ...over,
  };
}

const NOBODY = caps();
const EVERYTHING = caps({
  canReadStaffing: true, canManageStaffing: true, canManageCommercial: true,
  roles: ['admin'],
});

const ITEM = { id: 'X1', name: 'Northwind Migration' };

describe('canReachSearchTarget mirrors the TARGET ROUTE guard, not the section pre-filter', () => {
  // One case per section, each naming the predicate transcribed from
  // app.routes.ts. If a route's guard is changed without changing this module,
  // one of these fails.
  const CASES: readonly { section: SearchSectionKey; grants: Partial<SearchTargetCapabilities>; denies: Partial<SearchTargetCapabilities> }[] = [
    // /resources guards on an explicit role list, not a capability.
    { section: 'resources', grants: { roles: ['resource-manager'] }, denies: { roles: ['pm'], canReadStaffing: true } },
    { section: 'projects',  grants: { canReadStaffing: true },       denies: {} },
    { section: 'customers', grants: { canManageCommercial: true },   denies: {} },
    { section: 'contracts', grants: { canManageCommercial: true },   denies: {} },
    { section: 'orders',    grants: { canManageCommercial: true },   denies: {} },
  ];

  it.each(CASES)('$section: reachable for the granting identity', ({ section, grants }) => {
    expect(canReachSearchTarget(section, caps(grants))).toBe(true);
  });

  it.each(CASES)('$section: NOT reachable for the denied identity', ({ section, denies }) => {
    expect(canReachSearchTarget(section, caps(denies))).toBe(false);
  });

  it('covers every section — the gated table plus the no-destination list is the whole union', () => {
    expect([...CASES.map(c => c.section), ...NO_DESTINATION_SECTIONS].sort())
      .toStrictEqual([...SEARCH_SECTION_KEYS].sort());
  });

  // `requests` is not merely un-granted: it is unreachable for EVERY identity,
  // because /requests cannot show somebody else's request under any filter.
  it('requests is unreachable even for a fully-privileged identity', () => {
    expect(canReachSearchTarget('requests', EVERYTHING)).toBe(false);
    expect(searchTargetFor('requests', ITEM, EVERYTHING)).toBeNull();
  });

  // The three sharpest mismatches, spelled out so the reason this module exists
  // survives a future reader who assumes the two predicates agree.
  it('projects: readable in /search by ANY principal, but unreachable without staffing read', () => {
    // The section pre-filter is literally `return true` — so this identity SEES
    // the row while the route would refuse it.
    expect(canReachSearchTarget('projects', caps({ canManageCommercial: true }))).toBe(false);
  });

  it('contracts: canReadCommercial shows the row, but the route demands canManageCommercial', () => {
    expect(canReachSearchTarget('contracts', caps({ canManageCommercial: false }))).toBe(false);
  });

  it('resources: staffing READ shows the row, but the route demands one of three roles', () => {
    expect(canReachSearchTarget('resources', caps({ canReadStaffing: true, roles: ['pm'] }))).toBe(false);
  });
});

describe('searchTargetFor', () => {
  it('returns null for every section when the identity cannot reach the target', () => {
    for (const section of SEARCH_SECTION_KEYS) {
      expect(searchTargetFor(section, ITEM, NOBODY), `${section} must stay inert`).toBeNull();
    }
  });

  // ABSENCE HALF of the test above: with everything granted, every section that
  // HAS a destination must resolve. Without this, a function returning null
  // unconditionally passes the previous test.
  it('returns a target for every section that has a destination', () => {
    const withDestination = SEARCH_SECTION_KEYS.filter(
      s => !(NO_DESTINATION_SECTIONS as readonly string[]).includes(s));
    expect(withDestination.length, 'the union must not be all-inert').toBeGreaterThan(0);
    for (const section of withDestination) {
      expect(searchTargetFor(section, ITEM, EVERYTHING), `${section} must resolve`).not.toBeNull();
    }
  });

  it('the two detail sections go to the item, by id — never to a filtered list', () => {
    expect(searchTargetFor('projects', ITEM, EVERYTHING)).toStrictEqual({ link: ['/projects', 'X1'] });
    expect(searchTargetFor('contracts', ITEM, EVERYTHING)).toStrictEqual({ link: ['/contracts', 'X1'] });
  });

  it('the list sections seed the list filter with the label, never with the id', () => {
    for (const section of ['resources', 'customers', 'orders'] as const) {
      expect(searchTargetFor(section, ITEM, EVERYTHING)).toStrictEqual({
        link: [`/${section}`],
        queryParams: { [SEARCH_FOCUS_PARAM]: 'Northwind Migration' },
      });
    }
  });

  it('a blank or absent name falls back to the bare list, never to an empty filter', () => {
    // `?q=` with nothing after it renders as a filter the user appears to have
    // cleared, which is worse than arriving unfiltered.
    for (const name of [undefined, '', '   ']) {
      const t = searchTargetFor('orders', { id: 'O1', name }, EVERYTHING);
      expect(t, `name=${JSON.stringify(name)}`).toStrictEqual({ link: ['/orders'] });
      expect(t && 'queryParams' in t).toBe(false);
    }
  });

  it('trims the seeded name so a padded value does not filter to nothing', () => {
    expect(searchTargetFor('customers', { id: 'C1', name: '  Acme  ' }, EVERYTHING))
      .toStrictEqual({ link: ['/customers'], queryParams: { [SEARCH_FOCUS_PARAM]: 'Acme' } });
  });
});

describe('searchFocusLabel matches what each list actually filters on', () => {
  it('orders is labelled by invoice number, not by a name field it does not have', () => {
    expect(searchFocusLabel('orders', { id: 'O7', invoiceNumber: 'INV-0001' })).toBe('INV-0001');
  });

  it('orders with no invoice yet falls back to the id — which is what /orders filters on too', () => {
    expect(searchFocusLabel('orders', { id: 'O7' })).toBe('O7');
  });

  it('every other section is labelled by name', () => {
    for (const section of ['resources', 'projects', 'customers', 'contracts'] as const) {
      expect(searchFocusLabel(section, { id: 'X', name: 'Acme' }), section).toBe('Acme');
    }
  });
});

describe('hasDetailRoute', () => {
  it('is true for exactly the two sections that have a :id route, and false for the other four', () => {
    expect(SEARCH_SECTION_KEYS.filter(hasDetailRoute)).toStrictEqual(['projects', 'contracts']);
    expect(SEARCH_SECTION_KEYS.filter(s => !hasDetailRoute(s)))
      .toStrictEqual(['resources', 'requests', 'customers', 'orders']);
  });
});

// =============================================================================
// The claims above are transcriptions of app.routes.ts. A transcription rots
// silently: the route guard changes, this module keeps the old predicate, and
// every test here stays green because they all agree with each other. These read
// the ROUTES FILE, so a divergence fails instead of drifting.
// =============================================================================
describe('the transcribed guards still match app.routes.ts', () => {
  const ROUTES = readFileSync(resolve(__dirname, '../app.routes.ts'), 'utf8');

  /** The `canMatch` text declared for a top-level path, or null when unguarded. */
  function guardOf(path: string): string | null {
    const line = ROUTES.split('\n').find(l => l.includes(`path: '${path}'`));
    expect(line, `route '${path}' must exist`).toBeDefined();
    const m = /canMatch: \[([^\]]+)\]/.exec(line!);
    return m ? m[1].trim() : null;
  }

  it('/resources is still guarded on the three-role list this module transcribes', () => {
    const g = guardOf('resources');
    expect(g).toContain('resource-manager');
    expect(g).toContain('delivery-executive');
    expect(g).toContain('admin');
  });

  it('/requests is still guarded on canManageStaffing', () => {
    expect(guardOf('requests')).toContain('canManageStaffing()');
  });

  it('/projects/:id is still guarded on canReadStaffing', () => {
    expect(guardOf('projects/:id')).toContain('canReadStaffing()');
  });

  it('/contracts/:id, /customers and /orders still go through commercialGuard', () => {
    for (const p of ['contracts/:id', 'customers', 'orders']) {
      expect(guardOf(p), `${p}`).toContain('commercialGuard');
    }
  });

  it('commercialGuard is still canManageCommercial — the predicate this module mirrors', () => {
    const guardSrc = readFileSync(resolve(__dirname, '../guards/role.guard.ts'), 'utf8');
    expect(guardSrc).toContain('export const commercialGuard: CanMatchFn = roleGuard(auth => auth.canManageCommercial());');
  });

  it('the /projects LIST is still open, which is why the projects row needs its own gate', () => {
    // If this ever gains a guard, the mismatch this module compensates for may
    // have been resolved at the source — and this file should be revisited
    // rather than left compensating for a problem that no longer exists.
    expect(guardOf('projects')).toBeNull();
  });
});
