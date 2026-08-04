export type UuidSource = () => string;

/**
 * Process-independent entity identity. UUID v4 generation is collision-safe
 * across workers/hosts and remains compatible with every existing text PK and
 * the established TE/AL/AR/OB prefix conventions.
 */
export function newEntityId(source: UuidSource = () => globalThis.crypto.randomUUID()): string {
  return source();
}

/**
 * Canonical v4 UUID shape, in one place so an id GENERATED here and an id
 * ACCEPTED from a client (a self time-entry idempotency key becomes the uuid
 * segment of the stored id) are held to the same standard.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}
