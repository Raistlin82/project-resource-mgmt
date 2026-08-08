import { DeclaredSourcesInboundAdapter, SOURCE_SYSTEMS } from './inbound-source.adapter';

const adapter = new DeclaredSourcesInboundAdapter();

describe('DeclaredSourcesInboundAdapter — the declared landscape', () => {
  it('self-describes as an inbound adapter that is NOT connected', () => {
    const d = adapter.describe();
    expect(d.kind).toBe('inbound');
    expect(d.key).toBe('declared-sources');
    expect(d.connected).toBe(false);
    expect(d.mode).toBe('local-artifact');
  });

  it('declares every system RPT is fed by', () => {
    // The manual names five upstream masters plus the demand portal. A seam
    // that silently omits one is a landscape nobody can trust to be complete.
    expect(adapter.sources().map(s => s.key).sort()).toStrictEqual(
      ['infor-ln', 'pcp', 'people-portal', 'servicenow', 'skill-matrix', 'zucchetti'],
    );
  });

  it('marks EVERY source disconnected, and names what each one owns', () => {
    for (const s of adapter.sources()) {
      expect(s.connected, s.key).toBe(false);
      expect(s.owns.length, `${s.key} must say what it owns`).toBeGreaterThan(20);
    }
  });

  it('is honest about which sources are mapped and which are only declared', () => {
    // Both halves asserted. "Everything mappable" and "nothing mappable" are
    // each satisfiable by a broken table, and only the split is the real state.
    const mappable = adapter.sources().filter(s => s.mappable).map(s => s.key).sort();
    const declaredOnly = adapter.sources().filter(s => !s.mappable).map(s => s.key).sort();
    expect(mappable).toStrictEqual(['pcp', 'people-portal', 'zucchetti']);
    expect(declaredOnly).toStrictEqual(['infor-ln', 'servicenow', 'skill-matrix']);
  });

  it('hands out COPIES, so a caller cannot mutate the declared landscape', () => {
    const first = adapter.sources();
    first[0].mappable = !first[0].mappable;
    expect(adapter.sources()[0].mappable).toBe(SOURCE_SYSTEMS[0].mappable);
  });
});

describe('normalise — an upstream payload renamed onto our vocabulary', () => {
  it('maps a Zucchetti row, joining the two name columns into one', () => {
    const [record] = adapter.normalise('zucchetti', [{
      matricola: 'Z-4471',
      cognome: 'Ferrari',
      nome: 'Sofia',
      mansione: 'Developer',
      unitaOrganizzativa: 'Engineering',
      sede: 'Milano',
      dataAssunzione: '2022-03-01',
    }]);

    expect(record.externalRef).toBe('Z-4471');
    expect(record.fields).toStrictEqual({
      name: 'Sofia Ferrari',
      role: 'Developer',
      organization: 'Engineering',
      location: 'Milano',
      hireDate: '2022-03-01',
    });
    // The two upstream columns must not survive under their own names.
    expect(record.fields['cognome']).toBeUndefined();
    expect(record.fields['firstName']).toBeUndefined();
  });

  it('keeps a record traceable when the upstream key is missing', () => {
    // Falling back to the row position beats collapsing several key-less
    // records onto one empty string, where the preview would report a single
    // row and silently lose the rest.
    const records = adapter.normalise('zucchetti', [
      { cognome: 'Rossi', nome: 'Anna' },
      { cognome: 'Bianchi', nome: 'Luca' },
    ]);
    expect(records.map(r => r.externalRef)).toStrictEqual(['row-1', 'row-2']);
  });

  it('maps a PCP commessa onto the project fields', () => {
    const [record] = adapter.normalise('pcp', [{
      codiceCommessa: 'C-9001',
      descrizione: 'Mediolanum core banking',
      stato: 'In Execution',
      dataInizio: '2026-01-01',
      dataFine: '2026-12-31',
    }]);
    expect(record.externalRef).toBe('C-9001');
    expect(record.fields['name']).toBe('Mediolanum core banking');
    expect(record.fields['startDate']).toBe('2026-01-01');
  });

  it('drops an upstream column it has no mapping for', () => {
    const [record] = adapter.normalise('pcp', [
      { codiceCommessa: 'C-1', descrizione: 'X', campoIgnoto: 'boh' },
    ]);
    expect(record.fields['campoIgnoto']).toBeUndefined();
    expect(record.fields['name']).toBe('X');
  });

  it('REFUSES a declared-but-unmapped source by name, instead of returning nothing', () => {
    // "Zero records" and "we cannot read this system" are different facts, and
    // a silent empty list makes them look identical to the caller.
    expect(() => adapter.normalise('skill-matrix', [{ x: 1 }])).toThrow(/no normaliser.*skill-matrix/);
    expect(() => adapter.normalise('infor-ln', [{ x: 1 }])).toThrow(/no normaliser/);
  });

  it('refuses a system it has never heard of', () => {
    expect(() => adapter.normalise('sap-hr' as never, [])).toThrow(/unknown source system/);
  });
});

describe('previewImport — what the feed WOULD do, having done nothing', () => {
  const current = [
    { id: '1', code: 'Z-4471', name: 'Sofia Ferrari', role: 'Developer', organization: 'Engineering' },
    { id: '2', code: 'Z-8899', name: 'Marco Belli', role: 'Developer', organization: 'Engineering' },
  ];

  it('reports a record we do not hold as a CREATE', () => {
    const preview = adapter.previewImport('zucchetti', [
      { externalRef: 'Z-0001', fields: { name: 'Nuova Persona' } },
    ], current);
    expect(preview.counts).toStrictEqual({ create: 1, update: 0, unchanged: 0, rejected: 0 });
    expect(preview.rows[0].effect).toBe('create');
    expect(preview.rows[0].id).toBeUndefined();
  });

  it('reports a record with a moved field as an UPDATE, with the diff', () => {
    const preview = adapter.previewImport('zucchetti', [
      { externalRef: 'Z-4471', fields: { role: 'Senior Developer', organization: 'Engineering' } },
    ], current);
    expect(preview.counts.update).toBe(1);
    expect(preview.rows[0].id).toBe('1');
    // Only the field that MOVED, and both ends of the move.
    expect(preview.rows[0].changes).toStrictEqual({
      role: { from: 'Developer', to: 'Senior Developer' },
    });
  });

  it('reports an identical record as UNCHANGED, not as an update of nothing', () => {
    // The pair of the test above. Without it, a diff that always reported every
    // supplied field would pass there and be useless here.
    const preview = adapter.previewImport('zucchetti', [
      { externalRef: 'Z-4471', fields: { role: 'Developer', organization: 'Engineering' } },
    ], current);
    expect(preview.counts).toStrictEqual({ create: 0, update: 0, unchanged: 1, rejected: 0 });
    expect(preview.rows[0].changes).toBeUndefined();
  });

  it('REJECTS a record with nothing mappable, and says why', () => {
    const preview = adapter.previewImport('zucchetti', [
      { externalRef: 'Z-0002', fields: {} },
    ], current);
    expect(preview.counts.rejected).toBe(1);
    expect(preview.rows[0].reason).toMatch(/no mappable field/);
  });

  it('counts a mixed feed correctly, which is the only realistic case', () => {
    const preview = adapter.previewImport('zucchetti', [
      { externalRef: 'Z-4471', fields: { role: 'Developer' } },          // unchanged
      { externalRef: 'Z-8899', fields: { role: 'Architect' } },          // update
      { externalRef: 'Z-0003', fields: { name: 'Terza Persona' } },      // create
      { externalRef: 'Z-0004', fields: {} },                             // rejected
    ], current);
    expect(preview.counts).toStrictEqual({ create: 1, update: 1, unchanged: 1, rejected: 1 });
    expect(preview.rows).toHaveLength(4);
  });

  it('NEVER reports itself as applied, and never touches the rows it was given', () => {
    // The guarantee the whole seam rests on, asserted rather than assumed. The
    // type pins `applied` to false; this pins the VALUE, and the snapshot below
    // pins that the input survived the call byte for byte.
    const snapshot = JSON.stringify(current);
    const preview = adapter.previewImport('zucchetti', [
      { externalRef: 'Z-4471', fields: { role: 'Something Else' } },
    ], current);
    expect(preview.applied).toBe(false);
    expect(JSON.stringify(current)).toBe(snapshot);
  });

  it('names its target collection, so a reader knows what would be written where', () => {
    expect(adapter.previewImport('zucchetti', [], []).target).toBe('resources');
    expect(adapter.previewImport('pcp', [], []).target).toBe('projects');
    expect(adapter.previewImport('people-portal', [], []).target).toBe('skills');
  });

  it('matches PROJECTS on the id and SKILLS on the name, not on the resource key', () => {
    // Each target has its own natural key. Matching all three on `code` would
    // make every project a create, forever.
    const projects = adapter.previewImport('pcp', [
      { externalRef: 'P-1', fields: { name: 'Renamed' } },
    ], [{ id: 'P-1', name: 'Original' }]);
    expect(projects.rows[0].effect).toBe('update');

    const skills = adapter.previewImport('people-portal', [
      { externalRef: 'Java', fields: { level: 3 } },
    ], [{ id: 'S1', name: 'Java', level: 3 }]);
    expect(skills.rows[0].effect).toBe('unchanged');
  });
});
