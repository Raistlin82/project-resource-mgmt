/**
 * Block H / T1 — the PERSISTENCE CONTRACT for non-billable engagements and
 * resource absences.
 * Design spec: docs/superpowers/specs/2026-08-06-h-basket-non-billable-design.md
 *
 * WHY THESE TESTS EXIST, AND WHY THEY ARE SHAPED LIKE THIS.
 *
 * T1 adds a table, two columns, two types and three lines of wiring. NO DATA
 * FLOWS THROUGH ANY OF IT YET — the seed fixture is T2's. That is precisely the
 * situation in which this project has repeatedly shipped GREEN GATES NO DATA
 * EXERCISES, so every assertion below is deliberately aimed at something a
 * mistake could actually break, and NONE of them is "the type compiles" or
 * "the collection is in the interface" (both true by construction).
 *
 * The three real failure modes at this stage, and the test that catches each:
 *
 *  1. A NOT NULL column WITHOUT a default. That — not the column itself — is
 *     what forces a backfill and what makes migration 0019 fail on a database
 *     that already has projects. Pinned as the exact (notNull, hasDefault,
 *     default) triple, against Drizzle's runtime column metadata.
 *  2. A silent schema drift: a renamed or dropped column that drizzle-kit would
 *     happily turn into an ALTER nobody reviewed. Pinned as the FULL column
 *     name set, so an addition is visible and a rename is a failure.
 *  3. A parity break between the two adapters on the one nullable column
 *     (`note`) — the shim seam this repo keeps re-breaking.
 *
 * Every presence assertion below is paired with the absence assertion that
 * proves it discriminates: a test that "billable has a default" is worthless if
 * the metadata would report a default for every column, so the control asserts
 * `description` has none.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';

import { projects, resourceAbsences, resources } from './schema';
import { InMemoryRepository, nullsToUndefined } from './repository';
import type { ResourceAbsence, RedactedAbsence } from '../app/services/api.service';

const projectsTable = getTableConfig(projects);
const absencesTable = getTableConfig(resourceAbsences);

/** The (nullability, default) facts that decide whether a migration can be additive. */
function migrationShapeOf(table: typeof projectsTable, columnName: string) {
  const column = table.columns.find((c) => c.name === columnName);
  if (!column) throw new Error(`no column '${columnName}' — the test itself is stale`);
  return {
    name: column.name,
    notNull: column.notNull,
    hasDefault: column.hasDefault,
    default: column.default,
  };
}

describe('projects — non-billable classification (block H, migration 0019)', () => {
  it('adds `billable` as NOT NULL DEFAULT true, which is what makes 0019 backfill-free', () => {
    // The DEFAULT is the load-bearing half. A NOT NULL column without one
    // cannot be added to a table that already has rows: PostgreSQL rejects the
    // ALTER outright. With `DEFAULT true`, every pre-existing row becomes a
    // billable delivery engagement — which is exactly what it is. Same pattern
    // as `resources.kind` (C1, migration 0011).
    //
    // `true` is also the SAFE default in the other direction: an unknown
    // billability keeps margin alerts ON. Defaulting to false would silently
    // switch off the alerts this block exists to make honest.
    expect(migrationShapeOf(projectsTable, 'billable')).toStrictEqual({
      name: 'billable', notNull: true, hasDefault: true, default: true,
    });
  });

  it('adds `type` as NOT NULL DEFAULT Delivery', () => {
    expect(migrationShapeOf(projectsTable, 'type')).toStrictEqual({
      name: 'type', notNull: true, hasDefault: true, default: 'Delivery',
    });
  });

  it('does NOT report a default for every column — `description` is still nullable and undefaulted', () => {
    // THE CONTROL for the two assertions above. Without it, they would still
    // pass on a schema (or a Drizzle version) that reported a default for
    // everything, and would therefore prove nothing about `billable`.
    expect(migrationShapeOf(projectsTable, 'description')).toStrictEqual({
      name: 'description', notNull: false, hasDefault: false, default: undefined,
    });
  });

  it('adds exactly two columns and renames none', () => {
    // Guards failure mode 2. drizzle-kit turns a renamed TS property into an
    // ALTER … RENAME (or a drop + add) that reads as a schema improvement in
    // review. Pinning the full set means an unintended rename fails HERE, in a
    // diff a human reads, rather than in a migration nobody re-derives.
    expect(projectsTable.columns.map((c) => c.name).sort()).toStrictEqual([
      'billable', 'contract_id', 'description', 'end_date', 'id', 'location',
      'name', 'owner_id', 'start_date', 'status', 'type',
    ]);
  });
});

describe('resource_absences — the new table (block H §3.3)', () => {
  it('maps every property to its snake_case column, with `note` the ONLY nullable one', () => {
    // Presence and absence in one assertion: the seven facts that must be
    // NOT NULL, and the single one that must not be. `note` nullable is what
    // routes this table through the `nullsToUndefined()` seam at all.
    expect(absencesTable.columns.map((c) => ({ name: c.name, notNull: c.notNull }))).toStrictEqual([
      { name: 'id', notNull: true },
      { name: 'resource_id', notNull: true },
      { name: 'start_date', notNull: true },
      { name: 'end_date', notNull: true },
      { name: 'reason_code', notNull: true },
      { name: 'note', notNull: false },
      { name: 'recorded_by', notNull: true },
      { name: 'recorded_at', notNull: true },
    ]);
  });

  it('defaults NOTHING, unlike projects — an absence with no reason must be refused, never invented', () => {
    // A DEFAULT on `reason_code` would let a row land with a reason nobody
    // recorded; a DEFAULT on `recorded_by` would forge the actor the SoD rule
    // (spec §7.4) compares against. The contrast with `projects` in the same
    // assertion is what stops the empty array from being vacuously true.
    expect({
      absences: absencesTable.columns.filter((c) => c.hasDefault).map((c) => c.name),
      projects: projectsTable.columns.filter((c) => c.hasDefault).map((c) => c.name),
    }).toStrictEqual({ absences: [], projects: ['billable', 'type'] });
  });

  it('has exactly one foreign key: resource_id -> resources.id', () => {
    // This FK is why the bootstrap seed order below is load-bearing. The
    // "exactly one" half is the absence assertion: `recorded_by` is an actor
    // id and stays SOFT, like `createdBy`/`requestedBy` elsewhere — turning it
    // into an FK would make the audit trail refuse a deleted actor's history.
    const references = absencesTable.foreignKeys.map((fk) => {
      const reference = fk.reference();
      return {
        from: reference.columns.map((c) => c.name),
        toTable: getTableConfig(reference.foreignTable).name,
        to: reference.foreignColumns.map((c) => c.name),
      };
    });
    expect(references).toStrictEqual([
      { from: ['resource_id'], toTable: 'resources', to: ['id'] },
    ]);
    expect(getTableConfig(resources).name).toBe('resources');
  });

  it('indexes the hot query shape — (resource_id) and (resource_id, start_date)', () => {
    // The read this table exists to serve is "this resource's absences
    // intersecting [from,to]", issued once per resource by six derived
    // surfaces. Same composite shape as cost_baselines(project_id, period).
    expect(absencesTable.indexes.map((i) => ({
      name: i.config.name,
      columns: i.config.columns.map((c) => (c as { name?: string }).name),
    }))).toStrictEqual([
      { name: 'resource_absences_resource_id_idx', columns: ['resource_id'] },
      { name: 'resource_absences_resource_start_idx', columns: ['resource_id', 'start_date'] },
    ]);
  });
});

describe('bootstrap seed order — parent before child', () => {
  // The FK above means `resource_absences` MUST be seeded after `resources`.
  // The in-memory adapter enforces no foreign keys, so a wrong order is
  // INVISIBLE in dev and stops the server booting on Postgres — which already
  // happened once in C1. No unit test over the repositories can catch it; the
  // order is a property of the source, so that is where it is asserted.
  const bootstrapSource = readFileSync(resolve(process.cwd(), 'src/db/bootstrap.ts'), 'utf8');

  it('seeds schema.resourceAbsences after schema.resources', () => {
    const resourcesAt = bootstrapSource.indexOf('seedIfEmpty(database, schema.resources,');
    const absencesAt = bootstrapSource.indexOf('seedIfEmpty(database, schema.resourceAbsences,');
    // Both must be found: an indexOf of -1 would otherwise satisfy "before".
    expect(resourcesAt, 'the resources seed call must exist').toBeGreaterThan(-1);
    expect(absencesAt, 'the resourceAbsences seed call must exist').toBeGreaterThan(-1);
    expect(absencesAt).toBeGreaterThan(resourcesAt);
  });
});

describe('ResourceAbsence adapter parity (the two shims of src/db/repository.ts)', () => {
  const stored: ResourceAbsence = {
    id: 'AB1', resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31',
    reasonCode: 'ParentalLeave', note: 'covered by A. Smith',
    recordedBy: '2', recordedAt: '2026-05-20T09:00:00.000Z',
  };

  it('normalizes a Postgres row whose `note` is NULL to `undefined`, touching nothing else', () => {
    // Drizzle serves a nullable column as an explicit `null`; the interface
    // models it as `note?: string`. Without the shim, prod would answer
    // `"note": null` where dev answers no key at all.
    const fromPostgres = { ...stored, note: null } as unknown as ResourceAbsence;
    expect(nullsToUndefined(fromPostgres)).toStrictEqual({ ...stored, note: undefined });
  });

  it('leaves a populated `note` alone — the shim clears nulls, not content', () => {
    // The absence twin of the test above: if the shim erased `note` outright,
    // the first test would still pass and the restricted-audience read would
    // silently lose the field.
    expect(nullsToUndefined({ ...stored })).toStrictEqual(stored);
  });

  it('returns the row unchanged for an all-undefined patch, and changed for a real one', () => {
    // Empty-patch parity: Drizzle's `.set()` throws "No values to set" (a 500)
    // where the in-memory adapter returns the row (a 200), so PgRepository
    // short-circuits to a plain read. Asserted here on the real entity type,
    // together with the twin that proves a patch DOES land — otherwise "the
    // row came back unchanged" could equally mean "update does nothing".
    const repository = new InMemoryRepository<ResourceAbsence>([stored]);
    return (async () => {
      expect(await repository.update('AB1', {})).toStrictEqual(stored);
      expect(await repository.update('AB1', { endDate: '2026-09-30' }))
        .toStrictEqual({ ...stored, endDate: '2026-09-30' });
    })();
  });

  it('keeps an absent `note` absent on create — the dev half of the same seam', async () => {
    const repository = new InMemoryRepository<ResourceAbsence>();
    const created = await repository.create({
      id: 'AB2', resourceId: '6', startDate: '2026-05-04', endDate: '2026-05-08',
      reasonCode: 'Sickness', recordedBy: '2', recordedAt: '2026-05-04T08:00:00.000Z',
    });
    expect('note' in created, 'an omitted note must stay omitted, never become null').toBe(false);
  });
});

describe('RedactedAbsence — the projection that makes the privacy split real', () => {
  const full: ResourceAbsence = {
    id: 'AB1', resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31',
    reasonCode: 'Maternity', note: 'HR ref 4471',
    recordedBy: '2', recordedAt: '2026-05-20T09:00:00.000Z',
  };

  it('carries the four availability fields and NONE of the sensitive ones', () => {
    const redacted: RedactedAbsence = {
      id: full.id, resourceId: full.resourceId,
      startDate: full.startDate, endDate: full.endDate,
    };
    // Presence: the projection is numerically complete — these four fields are
    // everything the arithmetic reads (spec §3.4).
    expect(redacted).toStrictEqual({
      id: 'AB1', resourceId: '8', startDate: '2026-06-01', endDate: '2026-08-31',
    });
    // Absence: the sensitive keys are GONE, not merely undefined. `in` rather
    // than a value check, because `{ reasonCode: undefined }` still serializes
    // the key on some paths and would still be a leak of "there is a reason".
    expect(Object.keys(redacted).sort()).toStrictEqual(['endDate', 'id', 'resourceId', 'startDate']);
    // …and the twin that proves the source HAD something to redact. Without
    // this, redacting an object that never carried a reason proves nothing.
    expect(full.reasonCode).toBe('Maternity');
  });

  it('cannot be satisfied by handing back a full ResourceAbsence', () => {
    // COMPILE-TIME assertion, not a runtime one: `RedactedAbsence` declares
    // `reasonCode?: never`, so assigning a full row is a type error, and the
    // suppression directive below is what keeps it one. Delete the `?: never`
    // members and this line stops erroring — which turns the directive itself
    // into an error ("unused directive") and fails the build. That is the whole
    // point: the redacted route cannot be served by `res.json(rows)`, nor by
    // `delete`-ing a key off a stored row — only by building the projection
    // (spec §6.1). NB this suite is type-checked, so the guard is real.
    // @ts-expect-error — a full absence must never be assignable to the redacted shape
    const leak: RedactedAbsence = full;
    expect(leak.id).toBe('AB1');
  });
});
