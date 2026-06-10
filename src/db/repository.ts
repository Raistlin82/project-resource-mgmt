/**
 * Generic repository abstraction (SERVER + DEV).
 *
 * Defines a small, fully-typed CRUD boundary — `Repository<T>` — together with
 * two interchangeable implementations:
 *
 *   - `InMemoryRepository<T>`  : array-backed, defensively cloned, synchronous
 *                                logic wrapped in `Promise.resolve`. This is the
 *                                DEV / mock adapter and needs no database. It is
 *                                the persistence used when `DATABASE_URL` is
 *                                unset (see src/db/client.ts), mirroring the
 *                                in-memory mock state the SSR server already uses.
 *
 *   - `PgRepository<T>`        : PostgreSQL adapter backed by Drizzle ORM over a
 *                                node-postgres pool (`db` from src/db/client.ts).
 *                                Used for production persistence.
 *
 * Callers depend only on `Repository<T>`; swapping adapters is a one-line change
 * at the composition root. The public surface never leaks `any` or Drizzle's
 * internal generics — the single unavoidable localized cast lives inside the
 * Pg adapter and is documented at its call site.
 */
import { eq } from 'drizzle-orm';
import type { PgTable, PgColumn, PgInsertValue, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/**
 * Minimal entity contract: every persisted entity is identified by a string
 * `id`. This matches the rows produced by the project's pgTables and the shapes
 * used across `api.service.ts`.
 */
export interface Entity {
  id: string;
}

/**
 * Generic, fully-typed CRUD boundary. Implementations may be synchronous
 * (in-memory) or asynchronous (database) — all methods return Promises so
 * callers are agnostic to the backing store.
 */
export interface Repository<T extends Entity> {
  /** Return all entities. Order is implementation-defined. */
  list(): Promise<T[]>;
  /** Return the entity with the given id, or `undefined` if none exists. */
  get(id: string): Promise<T | undefined>;
  /** Insert `entity` and return the stored representation. */
  create(entity: T): Promise<T>;
  /**
   * Apply a partial `patch` to the entity with the given id and return the
   * updated entity, or `undefined` if no such entity exists. The `id` is never
   * changed by a patch.
   */
  update(id: string, patch: Partial<T>): Promise<T | undefined>;
  /** Remove the entity with the given id. Returns `true` iff a row was removed. */
  remove(id: string): Promise<boolean>;
}

/**
 * Shallow structured clone used to keep the in-memory store isolated from the
 * objects callers hand in or receive back. `structuredClone` is available in
 * Node 17+ / modern browsers; a JSON round-trip is used as a defensive fallback
 * so the adapter never shares references even on exotic runtimes.
 */
function clone<V>(value: V): V {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as V;
}

/**
 * Normalize a database row to the `V | undefined` contract used across the app.
 *
 * Drizzle returns NULLABLE columns as explicit `null`, but the api.service
 * interfaces model those same fields as OPTIONAL (`prop?: V`, i.e. `V | undefined`)
 * — and the in-memory (DEV) adapter simply omits the key. Without this shim the
 * production JSON shape would differ from dev (`key: null` vs key absent),
 * violating the `V | undefined` contract callers rely on.
 *
 * This is a SHALLOW conversion: top-level `null` values become `undefined`.
 * It must only run on RETURN paths (reads + the rows Drizzle returns from
 * insert/update). It must NEVER touch the values handed to `.set()` on an
 * update — there, `undefined` is intentionally omitted (no clobber) while an
 * explicit `null` is intended to set the column NULL.
 */
export function nullsToUndefined<R>(row: R): R {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[key] = value === null ? undefined : value;
  }
  return out as R;
}

/**
 * DEV adapter: an array-backed repository.
 *
 * The constructor takes an initial `T[]` which is defensively cloned, so the
 * caller's array (and the objects in it) can never be mutated through this
 * store and vice versa. All reads and writes return clones for the same reason.
 * Logic is synchronous but wrapped in `Promise.resolve` to satisfy the async
 * `Repository<T>` contract.
 */
export class InMemoryRepository<T extends Entity> implements Repository<T> {
  private readonly items: T[];

  constructor(initial: readonly T[] = []) {
    // Defensive deep clone of the seed so external mutation can't reach the store.
    this.items = initial.map((item) => clone(item));
  }

  list(): Promise<T[]> {
    // Hand back clones so a caller mutating the result can't touch the store.
    return Promise.resolve(this.items.map((item) => clone(item)));
  }

  get(id: string): Promise<T | undefined> {
    const found = this.items.find((item) => item.id === id);
    return Promise.resolve(found ? clone(found) : undefined);
  }

  create(entity: T): Promise<T> {
    // Clone on the way in so later caller mutations don't bleed into the store.
    const stored = clone(entity);
    this.items.push(stored);
    // Clone on the way out so the returned object is independent of the store.
    return Promise.resolve(clone(stored));
  }

  update(id: string, patch: Partial<T>): Promise<T | undefined> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      return Promise.resolve(undefined);
    }
    // Merge a cloned patch onto the stored row; never allow `id` to be changed.
    const merged: T = { ...this.items[index], ...clone(patch), id };
    this.items[index] = merged;
    return Promise.resolve(clone(merged));
  }

  remove(id: string): Promise<boolean> {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) {
      return Promise.resolve(false);
    }
    this.items.splice(index, 1);
    return Promise.resolve(true);
  }
}

/**
 * The Drizzle database handle this adapter talks to. Matches the type exported
 * by src/db/client.ts (`NodePgDatabase`, schema-less); a schema-bound database
 * is assignable to it, so callers can pass either.
 */
export type DrizzleDb = NodePgDatabase<Record<string, never>>;

/**
 * A Drizzle pgTable whose row type satisfies the `Entity` contract — i.e. it
 * exposes a string `id` column. Constraining the constructor to this shape (a)
 * keeps `PgRepository` usable only with id-bearing tables and (b) lets us infer
 * the row type `T` straight from the table via `InferSelectModel`.
 */
export type EntityTable<T extends Entity> = PgTable & {
  id: PgColumn;
} & { $inferSelect: T };

/**
 * Production adapter: a PostgreSQL-backed repository implemented with Drizzle ORM.
 *
 * Constructed from the shared Drizzle `db` handle and a pgTable that has an `id`
 * column. CRUD maps directly onto Drizzle's query builder:
 *   - list   -> db.select().from(table)
 *   - get    -> db.select().from(table).where(eq(table.id, id))
 *   - create -> db.insert(table).values(entity).returning()
 *   - update -> db.update(table).set(patch).where(eq(table.id, id)).returning()
 *   - remove -> db.delete(table).where(eq(table.id, id))
 */
export class PgRepository<T extends Entity> implements Repository<T> {
  constructor(
    private readonly db: DrizzleDb,
    private readonly table: EntityTable<T>,
  ) {}

  async list(): Promise<T[]> {
    // `.orderBy(id)` gives a stable, deterministic order (Postgres makes no
    // ordering guarantee otherwise), matching the seed/insertion order the
    // in-memory adapter preserves.
    const rows = await this.db
      .select()
      .from(this.table)
      .orderBy(this.table.id);
    // LOCALIZED CAST (Drizzle generics): a schema-less `select()` yields rows
    // typed as `Record<string, unknown>`, which TypeScript cannot prove equals
    // the generic `T`. The `EntityTable<T>` constraint guarantees the table's
    // select model *is* `T`, so the rows are structurally correct at runtime.
    // We bridge through `unknown` (TS's own recommendation) and keep the cast
    // confined here rather than weakening `db`/`table` to `any`.
    // `nullsToUndefined` normalizes nullable columns to the `V | undefined`
    // contract so the prod JSON shape matches the in-memory (DEV) adapter.
    return (rows as unknown as T[]).map((row) => nullsToUndefined(row));
  }

  async get(id: string): Promise<T | undefined> {
    const rows = await this.db
      .select()
      .from(this.table)
      .where(eq(this.table.id, id))
      .limit(1);
    // LOCALIZED CAST (Drizzle generics): see `list`.
    const row = rows[0] as unknown as T | undefined;
    return row ? nullsToUndefined(row) : undefined;
  }

  async create(entity: T): Promise<T> {
    // LOCALIZED CAST (Drizzle generics):
    // `.values()` expects the table's derived insert model (`PgInsertValue`),
    // which Drizzle infers from the concrete pgTable's column builders. Because
    // `PgRepository` is generic over `T` (not over the literal table config),
    // TypeScript cannot prove `T` equals that inferred insert model here. The
    // `EntityTable<T>` constraint already guarantees `T` is this table's select
    // model, so the values are structurally correct at runtime. We isolate the
    // single unavoidable cast (via `unknown`) to this one argument rather than
    // typing `table`/`db` as `any`, keeping the `Repository<T>` boundary typed.
    const values = entity as unknown as PgInsertValue<EntityTable<T>>;
    const rows = await this.db
      .insert(this.table)
      .values(values)
      .returning();
    // Normalize nullable columns on the returned row (see `list`).
    return nullsToUndefined(rows[0] as unknown as T);
  }

  async update(id: string, patch: Partial<T>): Promise<T | undefined> {
    // Never let a patch rewrite the primary key. Strip `id` from the patch
    // without binding an unused variable (the binding would trip no-unused-vars).
    const rest = { ...patch };
    delete (rest as Partial<T>).id;
    // Empty-patch parity with the in-memory adapter: if there is nothing to set
    // (no keys, or every remaining value is `undefined`), Drizzle's `.set()`
    // throws "No values to set" — a 500 in prod, while the in-memory adapter
    // returns the unchanged entity (200). Short-circuit to a plain read so both
    // adapters behave identically.
    const hasValuesToSet = Object.values(rest).some(
      (value) => value !== undefined,
    );
    if (!hasValuesToSet) {
      return this.get(id);
    }
    // LOCALIZED CAST (Drizzle generics): same rationale as `create` — `.set()`
    // wants the table-derived update model (`PgUpdateSetSource`), which can't be
    // statically tied to the generic `T`. The cast (via `unknown`) is confined
    // to this argument.
    //
    // NOTE: set semantics are unchanged — `undefined` values are omitted by
    // Drizzle (no clobber), an explicit `null` still sets the column NULL. We
    // therefore pass `rest` UNTOUCHED to `.set()` and only normalize the
    // RETURNED row below.
    const setValues = rest as unknown as PgUpdateSetSource<EntityTable<T>>;
    const rows = await this.db
      .update(this.table)
      .set(setValues)
      .where(eq(this.table.id, id))
      .returning();
    const row = rows[0] as unknown as T | undefined;
    return row ? nullsToUndefined(row) : undefined;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db
      .delete(this.table)
      .where(eq(this.table.id, id))
      .returning();
    return rows.length > 0;
  }
}
