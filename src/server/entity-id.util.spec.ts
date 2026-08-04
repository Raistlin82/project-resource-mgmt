import { newEntityId } from './entity-id.util';

describe('collision-safe entity identifiers', () => {
  it('uses UUID identifiers with no process-local sequence', () => {
    const generated = Array.from({ length: 2_048 }, () => newEntityId());

    expect(new Set(generated).size).toBe(generated.length);
    expect(generated.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)))
      .toBe(true);
  });

  it('remains compatible with the existing prefixed string-id conventions', () => {
    const fixed = '123e4567-e89b-42d3-a456-426614174000';

    expect(newEntityId(() => fixed)).toBe(fixed);
    expect(`TE${newEntityId(() => fixed)}`).toBe(`TE${fixed}`);
    expect(`AL${newEntityId(() => fixed)}`).toBe(`AL${fixed}`);
  });
});
