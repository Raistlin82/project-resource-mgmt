/**
 * B-CONCURRENCY: serialized critical section (per-process async mutex).
 *
 * Express handlers run concurrently and every repository call is awaited, so a
 * read-modify-write over a shared aggregate (a request's `staffedEffort` or a
 * resource's `utilization`) can interleave between its `get()` and its
 * `update()` — two concurrent writers both read the pre-state and one increment
 * is silently lost. There is no atomic-increment / FOR UPDATE primitive on the
 * `Repository<T>` boundary (it must serve both the in-memory dev adapter and the
 * Postgres adapter), so we serialize the whole read-modify-write per logical
 * key: each key holds a tail Promise and new work chains onto it, guaranteeing
 * strictly sequential execution per key while different keys still run in
 * parallel. Sufficient for the single-process Node server; a multi-process
 * deployment would additionally need a DB-level lock.
 *
 * WHY THIS LIVES IN ITS OWN MODULE. It used to be a closure inside
 * `src/server.ts`, which Vitest cannot import (that module instantiates the
 * Angular SSR app engine at load time), so the mutex at the centre of every
 * governed write had no test at all. The lock keys are per-entity
 * (`res:<id>`, `req:<id>`, `billing:<id>`, `approval:<id>`, `time-entry:<id>`,
 * …) and entity ids are UUIDs, so the key space grows with traffic — an
 * un-evicted registry is an unbounded Map in a long-running process. That bug
 * was invisible precisely because the code was untestable.
 */

/**
 * Tail promise per key. A key is present only while work is in flight or
 * queued on it; `createCriticalSectionRunner` deletes it once its own tail is
 * the last one, which is what keeps this Map bounded by CONCURRENT work rather
 * than by the number of entities the process has ever touched.
 */
export interface CriticalSectionRunner {
  <R>(key: string, fn: () => Promise<R>): Promise<R>;
  /** Number of keys currently holding queued or in-flight work. Test seam. */
  readonly pendingKeys: () => number;
}

export function createCriticalSectionRunner(): CriticalSectionRunner {
  const criticalSections = new Map<string, Promise<unknown>>();

  const run = <R>(key: string, fn: () => Promise<R>): Promise<R> => {
    const prev = criticalSections.get(key) ?? Promise.resolve();
    // Run `fn` only after any in-flight work on this key settles (success OR
    // failure), so one rejected section never wedges the key.
    const result = prev.then(fn, fn);
    // The stored tail must never reject (an unhandled rejection here would
    // crash the process and the next waiter would inherit it); swallow
    // settlement state.
    const tail = result.then(() => undefined, () => undefined);
    criticalSections.set(key, tail);
    // EVICT when this section is the last one on the key. The identity check is
    // load-bearing: if another caller chained on while we were running, the Map
    // now holds THAT newer tail, and deleting here would let a third caller
    // start concurrently with the queued second one — the exact interleaving
    // this mutex exists to prevent. Deleting only our own tail keeps the
    // guarantee and still bounds the Map by concurrency.
    void tail.then(() => {
      if (criticalSections.get(key) === tail) criticalSections.delete(key);
    });
    return result;
  };

  return Object.assign(run, { pendingKeys: () => criticalSections.size }) as CriticalSectionRunner;
}
