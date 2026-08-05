import { isFkViolation } from './fk-violation.util';

/**
 * `isFkViolation` used to check `err.code === '23503'` directly, which never
 * matched in practice: drizzle-orm's `PgPreparedQuery.queryWithCache` (every
 * query path) catches the `pg` driver's error and rethrows a
 * `DrizzleQueryError` that wraps the original as `.cause`, never copying
 * `.code` onto the outer error. These cases pin the walk-the-`.cause`-chain
 * fix (`0420c80`) against exactly that shape, plus the bound and the
 * degenerate inputs the walk must survive.
 */
describe('isFkViolation', () => {
  it('matches a real DrizzleQueryError shape: an Error whose .cause holds { code: 23503 }', () => {
    class DrizzleQueryError extends Error {
      constructor(message: string, options: { cause: unknown }) {
        super(message, options);
        this.name = 'DrizzleQueryError';
      }
    }
    const pgDriverError = { code: '23503', message: 'update or delete on table "customers" violates foreign key constraint' };
    const wrapped = new DrizzleQueryError('Failed query', { cause: pgDriverError });

    expect(isFkViolation(wrapped)).toBe(true);
  });

  it('still matches a bare, unwrapped { code: 23503 } — walking .cause must not break the flat case', () => {
    expect(isFkViolation({ code: '23503' })).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isFkViolation(new Error('boom'))).toBe(false);
  });

  it('does not match a different SQLSTATE (23505 unique_violation)', () => {
    expect(isFkViolation({ code: '23505' })).toBe(false);
  });

  it('does not match past the bound: 23503 six levels deep (one past the 5-hop cap) is invisible', () => {
    // Levels 0-4 (5 objects) are within the bound and hold no code; level 5
    // (the 6th object) is where '23503' actually sits, one hop past what the
    // bounded walk ever inspects.
    const level5 = { code: '23503' };
    const level4 = { cause: level5 };
    const level3 = { cause: level4 };
    const level2 = { cause: level3 };
    const level1 = { cause: level2 };
    const level0 = { cause: level1 };

    expect(isFkViolation(level0)).toBe(false);
  });

  it('matches right at the bound: 23503 as the 5th object (last one the walk inspects)', () => {
    const level4 = { code: '23503' };
    const level3 = { cause: level4 };
    const level2 = { cause: level3 };
    const level1 = { cause: level2 };
    const level0 = { cause: level1 };

    expect(isFkViolation(level0)).toBe(true);
  });

  it('does not hang and returns false on a cyclic .cause chain', () => {
    const cyclic: { message: string; cause?: unknown } = { message: 'wraps itself' };
    cyclic.cause = cyclic;

    expect(isFkViolation(cyclic)).toBe(false);
  });

  it('returns false without throwing for non-object inputs', () => {
    expect(isFkViolation(null)).toBe(false);
    expect(isFkViolation(undefined)).toBe(false);
    expect(isFkViolation('23503')).toBe(false);
    expect(isFkViolation(23503)).toBe(false);
  });
});
