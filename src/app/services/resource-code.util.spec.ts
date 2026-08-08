import {
  NAME_PAD_CHAR,
  NAME_PART_LENGTH,
  SEQUENCE_LENGTH,
  codeMatches,
  isPersonCode,
  nextResourceCode,
  personCodePrefix,
  placeholderCode,
  resourceCodeIsUnique,
} from './resource-code.util';

describe('personCodePrefix — surname first, then given name', () => {
  it('builds RPT\'s shape from a "Given Surname" name', () => {
    // The format RPT documents: 3 of the surname, then 3 of the given name.
    expect(personCodePrefix('Julie Armstrong')).toBe('ARMJUL');
    expect(personCodePrefix('Sofia Ferrari')).toBe('FERSOF');
  });

  it('reproduces the manual\'s own worked example', () => {
    // RPT prints `ROMSAL000002` for a second "Salvatore Romano". If this ever
    // disagrees, the convention has drifted from the system we are matching.
    expect(personCodePrefix('Salvatore Romano')).toBe('ROMSAL');
  });

  it('ignores accents, so the code survives being typed without them', () => {
    // A code that changes with an accent is a code nobody can look up.
    expect(personCodePrefix('Anna Rossì')).toBe(personCodePrefix('Anna Rossi'));
    expect(personCodePrefix('José Muñoz')).toBe('MUNJOS');
  });

  it('pads a short name part rather than producing a short code', () => {
    // Fixed width is what makes the sequence position predictable.
    expect(personCodePrefix('Li Wu')).toBe('WU' + NAME_PAD_CHAR + 'LI' + NAME_PAD_CHAR);
    expect(personCodePrefix('Li Wu')).toHaveLength(NAME_PART_LENGTH * 2);
  });

  it('uses the middle name for nothing — first token and LAST token only', () => {
    expect(personCodePrefix('Maria Teresa De Filippi')).toBe('FILMAR');
  });

  it('handles a single-token name by using it for both halves', () => {
    // Stable and searchable. Failing here would leave a resource with no code.
    expect(personCodePrefix('Cher')).toBe('CHECHE');
  });

  it('drops tokens that carry no letters, instead of padding around them', () => {
    // `Anna — Rossi` must not resolve its surname to the em dash.
    expect(personCodePrefix('Anna — Rossi')).toBe('ROSANN');
    expect(personCodePrefix("Anna O'Brien")).toBe('OBRANN');
  });

  it('never throws on a name with no letters at all', () => {
    // Degenerate, but a code of all-padding beats an exception on create.
    expect(personCodePrefix('—')).toBe(NAME_PAD_CHAR.repeat(NAME_PART_LENGTH * 2));
    expect(personCodePrefix('')).toBe(NAME_PAD_CHAR.repeat(NAME_PART_LENGTH * 2));
  });
});

describe('nextResourceCode — the sequence disambiguates a shared prefix', () => {
  it('starts at 000001 when the prefix is free', () => {
    expect(nextResourceCode({ name: 'Julie Armstrong' }, [])).toBe('ARMJUL000001');
  });

  it('only collides when BOTH name parts do — two Armstrongs are usually distinct', () => {
    // Worth pinning, because it is the first thing a reader gets wrong: the
    // prefix carries the given name too, so `Jack Armstrong` does NOT share
    // `Julie Armstrong`'s prefix and both start at 000001.
    const taken = ['ARMJUL000001'];
    expect(nextResourceCode({ name: 'Jack Armstrong' }, taken)).toBe('ARMJAC000001');
  });

  it('takes the next sequence for a genuine collision', () => {
    // `Julie` and `Julian` share their first three letters, so both are ARMJUL —
    // which is exactly the case RPT's own `ROMSAL000002` illustrates.
    const taken = ['ARMJUL000001'];
    expect(nextResourceCode({ name: 'Julian Armstrong' }, taken)).toBe('ARMJUL000002');
  });

  it('counts from the HIGHEST used, not from the count — a deleted row must not reissue', () => {
    // 000002 was deleted. Reissuing it would attach a stale code to a new person,
    // and any archived plan naming it would now name the wrong one.
    const taken = ['ARMJUL000001', 'ARMJUL000003'];
    expect(nextResourceCode({ name: 'Julius Armstrong' }, taken)).toBe('ARMJUL000004');
  });

  it('is not confused by a DIFFERENT prefix at a high sequence', () => {
    const taken = ['FERSOF000042', 'MILJOH000007'];
    expect(nextResourceCode({ name: 'Julie Armstrong' }, taken)).toBe('ARMJUL000001');
  });

  it('is not confused by a placeholder code sharing no shape with a sequence', () => {
    // The assertion of absence for `highestSequenceFor`'s pattern: a descriptive
    // code must never be parsed as a counter.
    const taken = ['ZZ - Dummy - Engineering - Senior Developer', 'ARMJUL000001'];
    expect(nextResourceCode({ name: 'Julian Armstrong' }, taken)).toBe('ARMJUL000002');
  });

  it('pads the sequence to a fixed width so codes sort lexicographically', () => {
    const taken = Array.from({ length: 9 }, (_, i) => `ARMJUL00000${i + 1}`);
    expect(nextResourceCode({ name: 'Julian Armstrong' }, taken)).toBe('ARMJUL000010');
    expect(nextResourceCode({ name: 'Julian Armstrong' }, taken)).toHaveLength(NAME_PART_LENGTH * 2 + SEQUENCE_LENGTH);
  });
});

describe('nextResourceCode — a placeholder is DESCRIBED, not named', () => {
  it('gives a dummy RPT\'s descriptive form', () => {
    expect(nextResourceCode(
      { name: 'Dummy — Senior Developer', kind: 'dummy', organization: 'Engineering', role: 'Developer' },
      [],
    )).toBe('ZZ - Dummy - Engineering - Developer');
  });

  it('marks a subco as a subco, not as a dummy', () => {
    expect(nextResourceCode(
      { name: 'Subco — Mediolanum Senior Developer', kind: 'subco', organization: 'Engineering', role: 'Developer' },
      [],
    )).toBe('ZZ - Subco - Engineering - Developer');
  });

  it('NEVER runs a placeholder through the person format', () => {
    // The claim the shape split exists for. "Subco — Mediolanum Senior Developer"
    // would yield `DEVSUB000001` — a code that reads like a person named Sub
    // Developer, on a row that is vendor capacity. A planner would trust it.
    const code = nextResourceCode(
      { name: 'Subco — Mediolanum Senior Developer', kind: 'subco', organization: 'Engineering', role: 'Developer' },
      [],
    );
    expect(isPersonCode(code)).toBe(false);
    expect(code).not.toContain('DEVSUB');
  });

  it('drops a missing part rather than rendering an empty one', () => {
    expect(placeholderCode({ name: 'x', kind: 'dummy', role: 'Developer' }))
      .toBe('ZZ - Dummy - Developer');
    expect(placeholderCode({ name: 'x', kind: 'dummy' })).toBe('ZZ - Dummy');
  });

  it('treats an absent kind as internal — the safe default', () => {
    // The mirror of the two tests above. Without this, a fix that routed
    // everything to the placeholder branch would still pass them.
    expect(isPersonCode(nextResourceCode({ name: 'Julie Armstrong' }, []))).toBe(true);
    expect(isPersonCode(nextResourceCode({ name: 'Julie Armstrong', kind: 'internal' }, []))).toBe(true);
  });
});

describe('isPersonCode / resourceCodeIsUnique', () => {
  it('recognises the person shape and only that', () => {
    expect(isPersonCode('ARMJUL000001')).toBe(true);
    expect(isPersonCode('ZZ - Dummy - Engineering - Developer')).toBe(false);
    expect(isPersonCode('ARMJUL1')).toBe(false);        // sequence too short
    expect(isPersonCode('ARMJU000001')).toBe(false);    // prefix too short
    expect(isPersonCode('armjul000001')).toBe(false);   // codes are upper-case
  });

  it('rejects a duplicate PERSON code', () => {
    expect(resourceCodeIsUnique('ARMJUL000001', ['ARMJUL000001'])).toBe(false);
    expect(resourceCodeIsUnique('ARMJUL000002', ['ARMJUL000001'])).toBe(true);
  });

  it('allows a repeated PLACEHOLDER code, deliberately', () => {
    // Two dummies for the same practice and role are the same description. That
    // is not a collision; telling them apart is what the id is for.
    const dummy = 'ZZ - Dummy - Engineering - Developer';
    expect(resourceCodeIsUnique(dummy, [dummy])).toBe(true);
  });
});

describe('codeMatches — what a planner types in the search box', () => {
  it('matches the prefix, the sequence, or the whole code, case-insensitively', () => {
    expect(codeMatches('ARMJUL000001', 'armjul')).toBe(true);
    expect(codeMatches('ARMJUL000001', '000001')).toBe(true);
    expect(codeMatches('ARMJUL000001', 'ARMJUL000001')).toBe(true);
  });

  it('does not match an unrelated fragment, and never matches an empty query', () => {
    // The assertion of absence: an always-true matcher would make the search box
    // return the whole directory for any input.
    expect(codeMatches('ARMJUL000001', 'FERSOF')).toBe(false);
    expect(codeMatches('ARMJUL000001', '')).toBe(false);
    expect(codeMatches('ARMJUL000001', '   ')).toBe(false);
  });

  it('is false for a resource that has no code yet', () => {
    expect(codeMatches(undefined, 'ARMJUL')).toBe(false);
  });

  it('matches a placeholder code by its words', () => {
    expect(codeMatches('ZZ - Dummy - Engineering - Developer', 'dummy')).toBe(true);
    expect(codeMatches('ZZ - Dummy - Engineering - Developer', 'sap')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The SEED must agree with the generator.
//
// Seed codes are written by hand into `src/db/seed.ts` (they have to be: the
// seed is plain data, consumed by both persistence adapters). Hand-written data
// that duplicates a rule is data that drifts from it — and a drifted seed is
// invisible, because every test that reads the seed reads the drifted value and
// agrees with itself.
//
// So the rule is re-run here over the seeded rows and the results compared. A
// change to the generator that nobody reflected in the seed fails HERE, which is
// where it is cheap, rather than the first time a demo shows two people sharing
// a code.
// -----------------------------------------------------------------------------
describe('the seeded resource codes are exactly what the generator would mint', () => {
  it('reproduces every seeded code, in seed order', async () => {
    const { resources } = await import('../../db/seed');

    const minted: string[] = [];
    for (const r of resources) {
      minted.push(nextResourceCode(
        { name: r.name, kind: r.kind, organization: r.organization, role: r.role },
        minted,
      ));
    }

    expect(resources.map(r => r.code)).toStrictEqual(minted);
  });

  it('gives every seeded resource a code — an absent one is a hole, not a default', () => {
    // The pair of the test above: it compares two lists, so it would also pass
    // if BOTH were full of undefined.
    return import('../../db/seed').then(({ resources }) => {
      expect(resources.length).toBeGreaterThan(0);
      for (const r of resources) {
        expect(r.code, `${r.name} has no code`).toBeTruthy();
      }
    });
  });

  it('keeps every seeded PERSON code unique', () => {
    return import('../../db/seed').then(({ resources }) => {
      const person = resources.map(r => r.code!).filter(isPersonCode);
      expect(person.length).toBeGreaterThan(0);
      expect(new Set(person).size, 'two seeded people share a code').toBe(person.length);
    });
  });

  it('gives placeholders the descriptive shape and people the person shape', () => {
    return import('../../db/seed').then(({ resources }) => {
      for (const r of resources) {
        const placeholder = r.kind === 'dummy' || r.kind === 'subco';
        expect(isPersonCode(r.code!), `${r.name} (${r.kind ?? 'internal'})`).toBe(!placeholder);
      }
    });
  });
});
