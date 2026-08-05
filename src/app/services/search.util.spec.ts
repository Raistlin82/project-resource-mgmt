import { describe, it, expect } from 'vitest';
import { clampSearchPage, matchesQuery, searchPage, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from './search.util';

interface Row { id: string; name: string; role?: string }
const ROWS: Row[] = [
  { id: '1', name: 'Julie Armstrong', role: 'Developer' },
  { id: '2', name: 'John Miller', role: 'Consultant' },
  { id: '3', name: 'Alice Smith', role: undefined },
];

describe('clampSearchPage (mirrors AUDIT_LOG_DEFAULT_LIMIT/AUDIT_LOG_MAX_LIMIT, server.ts:6521-6522, own thresholds)', () => {
  it('no params -> default limit, offset 0', () => expect(clampSearchPage({})).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 0 }));
  it('a limit under the max is honored', () => expect(clampSearchPage({ limit: '5' })).toEqual({ limit: 5, offset: 0 }));
  it('a limit over the max is clamped down, never rejected', () => expect(clampSearchPage({ limit: String(SEARCH_MAX_LIMIT + 50) })).toEqual({ limit: SEARCH_MAX_LIMIT, offset: 0 }));
  it('a non-numeric limit falls back to the default, not NaN or 0', () => expect(clampSearchPage({ limit: 'abc' })).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 0 }));
  it('a negative offset is floored to 0', () => expect(clampSearchPage({ offset: '-5' })).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 0 }));
  it('a positive offset is honored', () => expect(clampSearchPage({ offset: '10' })).toEqual({ limit: SEARCH_DEFAULT_LIMIT, offset: 10 }));
});

describe('matchesQuery (case-insensitive substring, spec §11 — same sophistication as resources.component.ts today, no more)', () => {
  it('matches a substring in the middle of a field, case-insensitive', () => expect(matchesQuery(ROWS[0], ['name'], 'ARMSTRONG')).toBe(true));
  it('does not match an absent substring', () => expect(matchesQuery(ROWS[0], ['name'], 'zzznonsense123')).toBe(false));
  it('matches on ANY of the listed fields, not just the first', () => expect(matchesQuery(ROWS[0], ['name', 'role'], 'developer')).toBe(true));
  it('an undefined field value never matches and never throws', () => expect(matchesQuery(ROWS[2], ['role'], 'anything')).toBe(false));
  it('an empty query matches everything (the caller is responsible for skipping the filter step entirely on an empty q)', () =>
    expect(matchesQuery(ROWS[0], ['name'], '')).toBe(true));
});

describe('searchPage (filter, when q is present, then paginate — identical on both adapters by construction, spec §7)', () => {
  it('q undefined -> the full array, unfiltered, in original order (the backward-compatibility case)', () =>
    expect(searchPage(ROWS, ['name'], undefined, { limit: 20, offset: 0 })).toEqual(ROWS));
  it('q defined and non-empty -> only matching rows', () =>
    expect(searchPage(ROWS, ['name'], 'Julie', { limit: 20, offset: 0 })).toEqual([ROWS[0]]));
  it('a nonsense term resolves successfully to an empty array, not an error', () =>
    expect(searchPage(ROWS, ['name'], 'zzznonsense123', { limit: 20, offset: 0 })).toEqual([]));
  it('pagination slices the MATCHED set, not the original array', () =>
    expect(searchPage(ROWS, ['name'], 'i', { limit: 1, offset: 1 })).toEqual([ROWS[1]])); // 'Julie'+'i', 'John'+'i' both match 'i'; offset 1 skips Julie's row
});
