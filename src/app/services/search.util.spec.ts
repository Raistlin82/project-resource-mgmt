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

/**
 * Fixture for the STEP-ORDER cases below, deliberately separate from ROWS: the
 * assertions above index into ROWS (`toEqual(ROWS)`, `[ROWS[0]]`, `[ROWS[1]]`),
 * so prepending a row to the shared array would silently re-point every one of
 * them. The leading row is the load-bearing part — it matches nothing, so it
 * occupies index 0 of the ORIGINAL array while occupying no place at all in the
 * matched set.
 */
const PAGING_ROWS: Row[] = [{ id: '0', name: 'Zed Nomatch' }, ROWS[0], ROWS[1], ROWS[2]];

/** 25 non-matching rows, then the one the user is looking for — the row that in
 *  production sits past index 20 of the unfiltered collection. */
const NEEDLE: Row = { id: 'needle', name: 'Needle Wanted' };
const HAYSTACK_ROWS: Row[] = [
  ...Array.from({ length: 25 }, (_, i) => ({ id: `f${i}`, name: `Filler Person ${i}` })),
  NEEDLE,
];

describe('searchPage (filter, when q is present, then paginate — identical on both adapters by construction, spec §7)', () => {
  it('q undefined -> the full array, unfiltered, in original order (the backward-compatibility case)', () =>
    expect(searchPage(ROWS, ['name'], undefined, { limit: 20, offset: 0 })).toEqual(ROWS));
  it('q defined and non-empty -> only matching rows', () =>
    expect(searchPage(ROWS, ['name'], 'Julie', { limit: 20, offset: 0 })).toEqual([ROWS[0]]));
  it('a nonsense term resolves successfully to an empty array, not an error', () =>
    expect(searchPage(ROWS, ['name'], 'zzznonsense123', { limit: 20, offset: 0 })).toEqual([]));
  // Kept, but retitled: on ROWS every row matches 'i', so `filter().slice(1,2)`
  // and `slice(1,2).filter()` both yield ROWS[1]. This case pins that a limit of
  // 1 at offset 1 returns exactly one row — it does NOT pin the step order, and
  // its old title claimed it did. The two cases below are what pin the order.
  it('a limit of 1 at offset 1 returns exactly the second row of the page', () =>
    expect(searchPage(ROWS, ['name'], 'i', { limit: 1, offset: 1 })).toEqual([ROWS[1]]));

  it('the offset walks the MATCHED set, so a leading non-match does not consume it', () => {
    // matched('J') = [Julie, John]; offset 1 -> John. Paginate-first would take
    // PAGING_ROWS.slice(1, 2) = [Julie], which ALSO matches 'J' — so here, and
    // only with a leading non-match, the two orderings disagree.
    const out = searchPage(PAGING_ROWS, ['name'], 'J', { limit: 1, offset: 1 });
    expect(out).toEqual([ROWS[1]]);
    // The assertion of ABSENCE: Julie is precisely the row paginate-then-filter
    // returns, so naming her is what makes this case falsifiable.
    expect(out).not.toContainEqual(ROWS[0]);
  });

  it('finds a match sitting past the first page of the UNFILTERED array', () => {
    // The shipped failure this pins: a resource at index 25 of /resources is
    // reachable only if the filter runs first. Paginate-first yields [] here —
    // "No results" for a record that exists.
    const out = searchPage(HAYSTACK_ROWS, ['name'], 'Needle', { limit: SEARCH_DEFAULT_LIMIT, offset: 0 });
    expect(out.map(r => r.name)).toStrictEqual(['Needle Wanted']);
    // Absence twin: no filler row rode along, so this is a filtered page and not
    // merely a slice that happened to contain the needle.
    expect(out).toHaveLength(1);
  });
});
