import { describe, it, expect } from 'vitest';
import { createCriticalSectionRunner } from './critical-section.util';

/** Resolvable barrier, so a test can hold a section open and observe overlap. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = () => r(); });
  return { promise, resolve };
}

/**
 * Eviction is chained onto the key's tail, so it lands a couple of microtasks
 * AFTER the caller's own `await` resumes — the caller's promise settles first,
 * then the tail, then the eviction callback. That lag is by design and harmless
 * (the Map stays bounded by concurrent work, not by entities ever touched), but
 * a test must drain the queue before counting, or it measures the lag instead of
 * the eviction.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createCriticalSectionRunner', () => {
  it('serializes two sections on the SAME key', async () => {
    const withLock = createCriticalSectionRunner();
    const log: string[] = [];
    const first = deferred();

    const a = withLock('k', async () => { log.push('a:start'); await first.promise; log.push('a:end'); });
    const b = withLock('k', async () => { log.push('b:start'); log.push('b:end'); });

    // b must not have started while a is still open.
    await Promise.resolve();
    expect(log).toEqual(['a:start']);
    first.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does NOT serialize across DIFFERENT keys', async () => {
    // The mirror of the test above, and the reason it is not vacuous: a "lock"
    // that simply awaited everything in call order would pass the serialization
    // test. This one fails on such an implementation, because b must overlap a.
    const withLock = createCriticalSectionRunner();
    const log: string[] = [];
    const first = deferred();

    const a = withLock('k1', async () => { log.push('a:start'); await first.promise; log.push('a:end'); });
    const b = withLock('k2', async () => { log.push('b:start'); log.push('b:end'); });

    await b;
    expect(log).toEqual(['a:start', 'b:start', 'b:end']);
    first.resolve();
    await a;
  });

  it('a rejected section does not wedge the key', async () => {
    const withLock = createCriticalSectionRunner();
    await expect(withLock('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withLock('k', async () => 'ok')).resolves.toBe('ok');
  });

  it('evicts the key once its work has settled', async () => {
    // RED before the eviction fix: the registry held every key it had ever seen,
    // so pendingKeys() grew monotonically with the number of entities touched.
    const withLock = createCriticalSectionRunner();
    expect(withLock.pendingKeys()).toBe(0);

    await withLock('res:a', async () => undefined);
    await withLock('res:b', async () => undefined);
    await withLock('res:c', async () => undefined);
    await flushMicrotasks();

    expect(withLock.pendingKeys()).toBe(0);
  });

  it('evicts a key whose section REJECTED', async () => {
    const withLock = createCriticalSectionRunner();
    await expect(withLock('res:x', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await flushMicrotasks();
    expect(withLock.pendingKeys()).toBe(0);
  });

  it('keeps the key while a waiter is queued, and still serializes it', async () => {
    // THE ASSERTION OF ABSENCE for the eviction fix. An unconditional delete
    // (dropping the `criticalSections.get(key) === tail` identity check) still
    // passes every test above — pendingKeys() reaches 0, keys are freed — but it
    // releases the key while a waiter is queued, so a third caller would run
    // CONCURRENTLY with that waiter. This test pins both halves: the key is
    // still held mid-flight, and the queued order is preserved.
    const withLock = createCriticalSectionRunner();
    const log: string[] = [];
    const first = deferred();
    const second = deferred();

    const a = withLock('k', async () => { log.push('a:start'); await first.promise; log.push('a:end'); });
    const b = withLock('k', async () => { log.push('b:start'); await second.promise; log.push('b:end'); });
    const c = withLock('k', async () => { log.push('c'); });

    await Promise.resolve();
    expect(withLock.pendingKeys()).toBe(1);

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // a finished; b is running, c is queued — the key must NOT have been freed.
    expect(withLock.pendingKeys()).toBe(1);

    second.resolve();
    await Promise.all([a, b, c]);
    await flushMicrotasks();
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c']);
    expect(withLock.pendingKeys()).toBe(0);
  });
});
