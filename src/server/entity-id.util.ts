export type UuidSource = () => string;

/**
 * Process-independent entity identity. UUID v4 generation is collision-safe
 * across workers/hosts and remains compatible with every existing text PK and
 * the established TE/AL/AR/OB prefix conventions.
 */
export function newEntityId(source: UuidSource = () => globalThis.crypto.randomUUID()): string {
  return source();
}
