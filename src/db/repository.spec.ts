import { InMemoryRepository, nullsToUndefined } from './repository';

/**
 * Unit tests for the DEV adapter (`InMemoryRepository`). These exercise the full
 * CRUD surface plus store isolation and require no database, so they run in the
 * standard unit suite (`npm test`).
 *
 * Test-runner conventions match src/app/services/finance.util.spec.ts: vitest
 * globals (`describe`/`it`/`expect`) provided via tsconfig.spec.json
 * (`"types": ["vitest/globals"]`); no per-file imports of the runner.
 */

interface Widget {
  id: string;
  name: string;
  qty: number;
  tags?: string[];
}

function widget(id: string, name: string, qty: number, tags?: string[]): Widget {
  return { id, name, qty, ...(tags ? { tags } : {}) };
}

describe('InMemoryRepository', () => {
  it('list() returns all seeded entities', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1), widget('2', 'b', 2)]);
    const all = await repo.list();
    expect(all.map((w) => w.id)).toEqual(['1', '2']);
    expect(all).toHaveLength(2);
  });

  it('list() on an empty / default-constructed repo returns []', async () => {
    expect(await new InMemoryRepository<Widget>().list()).toEqual([]);
    expect(await new InMemoryRepository<Widget>([]).list()).toEqual([]);
  });

  it('get() returns the matching entity', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1), widget('2', 'b', 2)]);
    const found = await repo.get('2');
    expect(found).toEqual(widget('2', 'b', 2));
  });

  it('get() returns undefined for an unknown id', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1)]);
    expect(await repo.get('nope')).toBeUndefined();
  });

  it('create() inserts and returns the stored entity', async () => {
    const repo = new InMemoryRepository<Widget>();
    const created = await repo.create(widget('1', 'a', 1));
    expect(created).toEqual(widget('1', 'a', 1));
    expect(await repo.list()).toHaveLength(1);
    expect(await repo.get('1')).toEqual(widget('1', 'a', 1));
  });

  it('update() applies a partial patch and returns the merged entity', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1)]);
    const updated = await repo.update('1', { qty: 99 });
    // Only the patched field changes; untouched fields are preserved.
    expect(updated).toEqual(widget('1', 'a', 99));
    expect(await repo.get('1')).toEqual(widget('1', 'a', 99));
  });

  it('update() never changes the id, even if the patch tries to', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1)]);
    const updated = await repo.update('1', { id: 'hacked', name: 'b' } as Partial<Widget>);
    expect(updated).toEqual(widget('1', 'b', 1));
    // The original id is still addressable; the attempted new id never appears.
    expect(await repo.get('1')).toEqual(widget('1', 'b', 1));
    expect(await repo.get('hacked')).toBeUndefined();
  });

  it('update() returns undefined for an unknown id and does not insert', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1)]);
    expect(await repo.update('nope', { qty: 5 })).toBeUndefined();
    expect(await repo.list()).toHaveLength(1);
  });

  it('update() with an empty patch returns the unchanged entity', async () => {
    // PG PARITY (issue #8): with a patch that has no defined keys after the `id`
    // is stripped, Drizzle's `.set()` throws "No values to set" -> a 500 in the
    // PgRepository / NaturalKeyPgRepository adapters. Both Pg adapters now
    // short-circuit to `this.get(id)` so they match this in-memory behavior:
    // an empty patch is a no-op that returns the current entity unchanged (200).
    //
    // The trigger for the Pg short-circuit is "no value to set" — i.e. either an
    // empty patch OR a patch whose every value is `undefined` (Drizzle omits
    // `undefined` from `.set()`). NOTE: the in-memory adapter spreads the patch
    // verbatim, so a `{ qty: undefined }` patch DOES write `qty: undefined`
    // there; that pre-existing in-memory behavior is intentionally left alone.
    // This test covers the canonical empty-`{}` case where both adapters agree.
    // (The Pg branch isn't unit-tested here as it needs a live database; this
    // documents the contract the Pg short-circuit is written to honor.)
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1)]);
    const updated = await repo.update('1', {});
    expect(updated).toEqual(widget('1', 'a', 1));
    expect(await repo.get('1')).toEqual(widget('1', 'a', 1));
  });

  it('remove() deletes an existing entity and returns true', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1), widget('2', 'b', 2)]);
    expect(await repo.remove('1')).toBe(true);
    expect(await repo.get('1')).toBeUndefined();
    expect((await repo.list()).map((w) => w.id)).toEqual(['2']);
  });

  it('remove() returns false for an unknown id and leaves the store intact', async () => {
    const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1)]);
    expect(await repo.remove('nope')).toBe(false);
    expect(await repo.list()).toHaveLength(1);
  });

  describe('store isolation', () => {
    it('mutating an object returned by get() does not mutate the store', async () => {
      const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1, ['x'])]);
      const first = await repo.get('1');
      first!.name = 'mutated';
      first!.qty = 999;
      first!.tags!.push('y'); // nested mutation must not leak either
      const second = await repo.get('1');
      expect(second).toEqual(widget('1', 'a', 1, ['x']));
    });

    it('mutating an object returned by list() does not mutate the store', async () => {
      const repo = new InMemoryRepository<Widget>([widget('1', 'a', 1)]);
      const all = await repo.list();
      all[0].name = 'mutated';
      all.push(widget('2', 'sneaky', 2));
      // Re-reading shows the store is untouched by either the element edit or the array push.
      expect((await repo.list()).map((w) => ({ id: w.id, name: w.name }))).toEqual([
        { id: '1', name: 'a' },
      ]);
    });

    it('mutating the seed array/objects after construction does not mutate the store', async () => {
      const seed = [widget('1', 'a', 1, ['x'])];
      const repo = new InMemoryRepository<Widget>(seed);
      seed[0].name = 'mutated';
      seed[0].tags!.push('y');
      seed.push(widget('2', 'sneaky', 2));
      expect(await repo.list()).toEqual([widget('1', 'a', 1, ['x'])]);
    });

    it('mutating the object passed to create() after the call does not mutate the store', async () => {
      const repo = new InMemoryRepository<Widget>();
      const input = widget('1', 'a', 1, ['x']);
      await repo.create(input);
      input.name = 'mutated';
      input.tags!.push('y');
      expect(await repo.get('1')).toEqual(widget('1', 'a', 1, ['x']));
    });

    it('mutating the object returned by create() does not mutate the store', async () => {
      const repo = new InMemoryRepository<Widget>();
      const created = await repo.create(widget('1', 'a', 1));
      created.qty = 999;
      expect(await repo.get('1')).toEqual(widget('1', 'a', 1));
    });
  });
});

describe('nullsToUndefined', () => {
  // PG NULL-vs-UNDEFINED (issue #9): Drizzle returns nullable columns as explicit
  // `null`, but the api.service interfaces model them as OPTIONAL (`V | undefined`)
  // and the in-memory (DEV) adapter omits the key entirely. This helper is applied
  // on the Pg adapters' RETURN paths (list/get/create/update) so the prod JSON
  // shape matches dev. It must NEVER touch the values passed to `.set()` on an
  // update — that's covered by leaving the set semantics untouched in the adapter.

  it('converts top-level null values to undefined', () => {
    const out = nullsToUndefined({ id: '1', a: null, b: 2, c: null });
    expect(out).toEqual({ id: '1', a: undefined, b: 2, c: undefined });
  });

  it('leaves non-null values (including falsy ones) untouched', () => {
    const out = nullsToUndefined({ id: '1', zero: 0, empty: '', flag: false });
    expect(out).toEqual({ id: '1', zero: 0, empty: '', flag: false });
  });

  it('leaves already-undefined values as undefined', () => {
    const out = nullsToUndefined({ id: '1', a: undefined });
    expect(out).toEqual({ id: '1', a: undefined });
  });

  it('is shallow: does not convert nulls nested inside objects or arrays', () => {
    const out = nullsToUndefined({ id: '1', nested: { x: null }, arr: [null] });
    expect(out).toEqual({ id: '1', nested: { x: null }, arr: [null] });
  });

  it('preserves all keys (null keys remain present, just undefined)', () => {
    const out = nullsToUndefined({ id: '1', a: null }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['a', 'id']);
  });
});
