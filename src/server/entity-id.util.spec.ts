import { isUuidV4, newEntityId } from './entity-id.util';

describe('collision-safe entity identifiers', () => {
  it('uses UUID identifiers with no process-local sequence', () => {
    const generated = Array.from({ length: 2_048 }, () => newEntityId());

    expect(new Set(generated).size).toBe(generated.length);
    expect(generated.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)))
      .toBe(true);
  });

  /**
   * REPLACES A TAUTOLOGY. The previous case asserted
   * `newEntityId(() => fixed) === fixed` — the function's entire body — and
   * `` `TE${fixed}` === `TE${fixed}` ``, a concatenation performed inside the
   * test itself. Neither could fail. What is actually worth pinning is the shape
   * a client-supplied key must satisfy before it becomes the uuid segment of a
   * stored id (POST /self/time-entries), because that is the one place an id is
   * not generated here.
   */
  it('accepts only a canonical v4 UUID as an externally supplied id segment', () => {
    expect(isUuidV4(newEntityId())).toBe(true);
    expect(isUuidV4('123e4567-e89b-42d3-a456-426614174000')).toBe(true);

    // Wrong version nibble (v1), wrong variant nibble, uppercase, truncated,
    // padded, non-hex, and non-strings must all be refused: each of these would
    // otherwise be spliced straight into a primary key.
    expect(isUuidV4('123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(isUuidV4('123e4567-e89b-42d3-7456-426614174000')).toBe(false);
    expect(isUuidV4('123E4567-E89B-42D3-A456-426614174000')).toBe(false);
    expect(isUuidV4('123e4567-e89b-42d3-a456-42661417400')).toBe(false);
    expect(isUuidV4('123e4567-e89b-42d3-a456-426614174000 ')).toBe(false);
    expect(isUuidV4('../../etc/passwd')).toBe(false);
    expect(isUuidV4('')).toBe(false);
    expect(isUuidV4(undefined)).toBe(false);
    expect(isUuidV4(42)).toBe(false);
  });
});
