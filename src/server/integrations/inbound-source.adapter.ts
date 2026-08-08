/**
 * Inbound master-data seam — "DeclaredSources" (RPT gap register, row 56).
 *
 * RPT does not own its masters. Resources and the company organisation come
 * from Zucchetti, skills from the Skill Matrix and the People Portal, commesse
 * from PCP and InforLN, hiring demand from ServiceNow. We hold the same masters
 * locally, which makes the interesting question not "can we parse their file"
 * but **what would that file DO to our data**.
 *
 * So this adapter answers exactly that and nothing else:
 *
 *   sources()        the declared landscape — every system, what it owns, and
 *                    whether a normaliser exists for it yet
 *   normalise()      an upstream payload renamed onto OUR vocabulary
 *   previewImport()  create / update / unchanged / rejected, per record, with
 *                    the field-level diff for an update and a reason for a
 *                    rejection
 *
 * NOTHING IS WRITTEN, and that is a property of the shape rather than a flag:
 * `previewImport` returns a report, and there is no apply function to call by
 * mistake. `InboundPreview.applied` is typed `false`, so a future implementation
 * that starts writing cannot quietly keep this type.
 *
 * NOTHING IS FETCHED either: the payload is passed IN. A connected version would
 * add a transport in front of `normalise`, and every mapping and rule below
 * would keep working unchanged — which is the whole point of specifying them
 * now.
 *
 * A source can be DECLARED without being mappable (`mappable: false`). That is
 * the honest state for a system whose payload shape we have not seen, and it is
 * far better than a normaliser that invents a mapping and is discovered to be
 * wrong on the day it is connected.
 */

import type {
  InboundEffect,
  InboundPreview,
  InboundPreviewRow,
  InboundSourceAdapter,
  IntegrationDescriptor,
  NormalisedRecord,
  SourceSystemDescriptor,
  SourceSystemKey,
} from './types';

export type {
  InboundEffect,
  InboundPreview,
  InboundPreviewRow,
  InboundSourceAdapter,
  NormalisedRecord,
  SourceSystemDescriptor,
  SourceSystemKey,
} from './types';

/**
 * The five upstream systems RPT names, plus ServiceNow.
 *
 * `mappable` is the load-bearing field. Three have a normaliser because their
 * feed maps onto a collection we already hold with fields we already have;
 * three do not, and say so rather than pretending.
 */
export const SOURCE_SYSTEMS: readonly SourceSystemDescriptor[] = [
  {
    key: 'zucchetti',
    name: 'Zucchetti',
    owns: 'Resource master data and the company organisation tree',
    target: 'resources',
    mappable: true,
    connected: false,
  },
  {
    key: 'pcp',
    name: 'PCP',
    owns: 'Commessa master data and the cost forecast behind a baseline',
    target: 'projects',
    mappable: true,
    connected: false,
  },
  {
    key: 'people-portal',
    name: 'People Portal',
    owns: 'Skills declared by the person themselves',
    target: 'skills',
    mappable: true,
    connected: false,
  },
  {
    key: 'skill-matrix',
    name: 'Skill Matrix',
    owns: 'Assessed skill and proficiency per resource',
    target: 'skills',
    // Declared, not mapped: its payload carries an assessment SCALE we have not
    // reconciled with `proficiencySets`, and guessing that mapping would put
    // wrong levels on real people.
    mappable: false,
    connected: false,
  },
  {
    key: 'infor-ln',
    name: 'InforLN',
    owns: 'Commessa master data on the ERP side',
    target: 'projects',
    // Declared, not mapped: it overlaps PCP on the same target, and which one
    // wins per field is a product decision nobody has taken.
    mappable: false,
    connected: false,
  },
  {
    key: 'servicenow',
    name: 'ServiceNow Requester Portal',
    owns: 'Hiring and subcontractor demand, and the RES requisition number',
    target: 'resources',
    // Declared here for completeness of the landscape; its actual seam is the
    // DEMAND adapter, which models the request and the RES answer properly.
    mappable: false,
    connected: false,
  },
];

/** Upstream field name -> our field name, per mappable system. */
const FIELD_MAPS: Readonly<Partial<Record<SourceSystemKey, Readonly<Record<string, string>>>>> = {
  zucchetti: {
    matricola: 'externalRef',
    cognome: 'lastName',
    nome: 'firstName',
    mansione: 'role',
    unitaOrganizzativa: 'organization',
    sede: 'location',
    dataAssunzione: 'hireDate',
    dataCessazione: 'terminationDate',
  },
  pcp: {
    codiceCommessa: 'externalRef',
    descrizione: 'name',
    stato: 'status',
    dataInizio: 'startDate',
    dataFine: 'endDate',
  },
  'people-portal': {
    matricola: 'externalRef',
    competenza: 'name',
    livello: 'level',
  },
};

/** The key each target is matched on when deciding create vs update. */
const MATCH_KEY: Readonly<Record<SourceSystemDescriptor['target'], string>> = {
  resources: 'code',
  projects: 'id',
  skills: 'name',
};

function descriptorFor(system: SourceSystemKey): SourceSystemDescriptor {
  const found = SOURCE_SYSTEMS.find(s => s.key === system);
  if (!found) throw new Error(`unknown source system '${system}'`);
  return found;
}

/** Zucchetti sends the name in two columns; we store one. */
function joinName(fields: Record<string, unknown>): string | undefined {
  const first = typeof fields['firstName'] === 'string' ? fields['firstName'].trim() : '';
  const last = typeof fields['lastName'] === 'string' ? fields['lastName'].trim() : '';
  const joined = `${first} ${last}`.trim();
  return joined === '' ? undefined : joined;
}

/**
 * The single concrete inbound adapter: declares the landscape, normalises the
 * payloads it can, and reports what an import WOULD do.
 */
export class DeclaredSourcesInboundAdapter implements InboundSourceAdapter {
  describe(): IntegrationDescriptor {
    return {
      kind: 'inbound',
      key: 'declared-sources',
      name: 'DeclaredSources',
      description:
        'Declares the upstream masters RPT is fed by (Zucchetti, PCP, InforLN, People Portal, ' +
        'Skill Matrix, ServiceNow), normalises the payloads it has a mapping for, and reports ' +
        'what an import WOULD create, update or reject. Nothing is fetched and nothing is ' +
        'written — there is no apply path to call by mistake.',
      connected: false,
      mode: 'local-artifact',
    };
  }

  sources(): SourceSystemDescriptor[] {
    return SOURCE_SYSTEMS.map(s => ({ ...s }));
  }

  normalise(system: SourceSystemKey, payload: readonly Record<string, unknown>[]): NormalisedRecord[] {
    const descriptor = descriptorFor(system);
    if (!descriptor.mappable) {
      // A named refusal, not a silent empty list: "0 records" and "we cannot
      // read this system" are different facts and must not look the same.
      throw new Error(
        `no normaliser for '${system}': it is declared but not mapped (see SOURCE_SYSTEMS for why)`,
      );
    }
    const map = FIELD_MAPS[system] ?? {};
    return payload.map((raw, index) => {
      const fields: Record<string, string | number | boolean | null> = {};
      for (const [upstream, ours] of Object.entries(map)) {
        if (ours === 'externalRef') continue;
        const value = raw[upstream];
        if (value === undefined) continue;
        fields[ours] =
          typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
            ? value
            : value === null
              ? null
              : String(value);
      }
      const refKey = Object.keys(map).find(k => map[k] === 'externalRef');
      const rawRef = refKey === undefined ? undefined : raw[refKey];
      // Falling back to the row INDEX keeps a ref-less record traceable through
      // the preview instead of collapsing several of them onto one empty key.
      const externalRef = typeof rawRef === 'string' && rawRef.trim() !== '' ? rawRef.trim() : `row-${index + 1}`;

      if (descriptor.target === 'resources') {
        const name = joinName(fields);
        if (name !== undefined) fields['name'] = name;
        delete fields['firstName'];
        delete fields['lastName'];
      }
      return { externalRef, fields };
    });
  }

  previewImport(
    system: SourceSystemKey,
    records: readonly NormalisedRecord[],
    current: readonly Record<string, unknown>[],
  ): InboundPreview {
    const descriptor = descriptorFor(system);
    const matchKey = MATCH_KEY[descriptor.target];
    const byKey = new Map<string, Record<string, unknown>>();
    for (const row of current) {
      const key = row[matchKey];
      if (typeof key === 'string' && key !== '') byKey.set(key, row);
    }

    const rows: InboundPreviewRow[] = records.map(record => {
      if (Object.keys(record.fields).length === 0) {
        return {
          externalRef: record.externalRef,
          effect: 'rejected' as const,
          reason: 'the record carries no mappable field',
        };
      }
      const existing = byKey.get(record.externalRef);
      if (existing === undefined) {
        return { externalRef: record.externalRef, effect: 'create' as const };
      }
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [field, value] of Object.entries(record.fields)) {
        if (existing[field] !== value) changes[field] = { from: existing[field], to: value };
      }
      const id = typeof existing['id'] === 'string' ? existing['id'] : undefined;
      return Object.keys(changes).length === 0
        ? { externalRef: record.externalRef, effect: 'unchanged' as const, id }
        : { externalRef: record.externalRef, effect: 'update' as const, id, changes };
    });

    const counts: Record<InboundEffect, number> = { create: 0, update: 0, unchanged: 0, rejected: 0 };
    for (const row of rows) counts[row.effect] += 1;

    return { system, target: descriptor.target, applied: false, counts, rows };
  }
}
