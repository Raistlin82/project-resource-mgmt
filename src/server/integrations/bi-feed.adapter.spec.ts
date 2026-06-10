import { BI_FEED_DESCRIPTOR, JsonFeedBiAdapter } from './bi-feed.adapter';
import type { BiFeedDocument, BiFeedInput, BiFeedRow, ProjectFinancialsRow } from './bi-feed.adapter';
import type { Project } from '../../app/services/api.service';

/**
 * Unit tests for the JsonFeed BI adapter. Pure formatter — no network, no
 * credentials, no SDKs — so everything runs in the standard unit suite.
 *
 * Test-runner conventions match src/db/repository.spec.ts: vitest globals
 * (`describe`/`it`/`expect`) provided via tsconfig.spec.json
 * (`"types": ["vitest/globals"]`); no per-file imports of the runner.
 */

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `Project ${id}`,
    location: 'Milan',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    status: 'Active',
    ...overrides,
  };
}

function financials(projectId: string, overrides: Partial<ProjectFinancialsRow> = {}): ProjectFinancialsRow {
  return {
    projectId,
    projectName: `Project ${projectId}`,
    status: 'Active',
    revenue: 100_000,
    actualCost: 60_000,
    margin: 40_000,
    marginPct: 0.4,
    budget: 90_000,
    eac: 80_000,
    vac: 10_000,
    ...overrides,
  };
}

function input(overrides: Partial<BiFeedInput> = {}): BiFeedInput {
  return {
    generatedAt: '2026-06-10T12:00:00.000Z',
    projects: [project('p1')],
    financials: [financials('p1')],
    ...overrides,
  };
}

function parseDocument(content: string): BiFeedDocument {
  return JSON.parse(content) as BiFeedDocument;
}

describe('JsonFeedBiAdapter', () => {
  const adapter = new JsonFeedBiAdapter();

  describe('describe()', () => {
    it('self-describes as a local-artifact BI connector that is NOT connected', () => {
      const d = adapter.describe();
      expect(d.kind).toBe('bi');
      expect(d.key).toBe('json-feed');
      expect(d.name).toBe('JsonFeed');
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.connected).toBe(false);
      expect(d.mode).toBe('local-artifact');
    });

    it('returns a copy so callers cannot mutate the shared descriptor', () => {
      const d = adapter.describe();
      expect(d).not.toBe(BI_FEED_DESCRIPTOR);
      expect(d).toEqual(BI_FEED_DESCRIPTOR);
      d.name = 'tampered';
      expect(adapter.describe().name).toBe('JsonFeed');
    });
  });

  describe('artifact envelope', () => {
    it('produces an application/json artifact with a .json filename', () => {
      const artifact = adapter.buildFeed(input());
      expect(artifact.mimeType).toBe('application/json');
      expect(artifact.filename.startsWith('bi-feed-')).toBe(true);
      expect(artifact.filename.endsWith('.json')).toBe(true);
    });

    it('strips filename-hostile characters (":" and ".") from the timestamp in the filename', () => {
      const artifact = adapter.buildFeed(input({ generatedAt: '2026-06-10T12:34:56.789Z' }));
      expect(artifact.filename).toBe('bi-feed-2026-06-10T123456789Z.json');
    });

    it('content is valid JSON shaped as { generatedAt, rowCount, rows }', () => {
      const artifact = adapter.buildFeed(input());
      const doc = parseDocument(artifact.content);
      expect(doc.generatedAt).toBe('2026-06-10T12:00:00.000Z');
      expect(typeof doc.rowCount).toBe('number');
      expect(Array.isArray(doc.rows)).toBe(true);
    });

    it('echoes the caller-supplied generatedAt verbatim (pure formatter, no clock access)', () => {
      const generatedAt = '1999-12-31T23:59:59.000Z';
      const doc = parseDocument(adapter.buildFeed(input({ generatedAt })).content);
      expect(doc.generatedAt).toBe(generatedAt);
      for (const row of doc.rows) expect(row['generatedAt']).toBe(generatedAt);
    });
  });

  describe('rowCount invariant', () => {
    it('rowCount equals rows.length for a populated feed', () => {
      const doc = parseDocument(
        adapter
          .buildFeed(
            input({
              projects: [project('p1'), project('p2'), project('p3')],
              financials: [financials('p1'), financials('p2')],
            }),
          ).content,
      );
      expect(doc.rowCount).toBe(doc.rows.length);
      expect(doc.rowCount).toBe(3);
    });

    it('rowCount equals rows.length when empty', () => {
      const doc = parseDocument(adapter.buildFeed(input({ projects: [], financials: [] })).content);
      expect(doc.rowCount).toBe(0);
      expect(doc.rows).toEqual([]);
    });
  });

  describe('empty input', () => {
    it('handles fully empty input without throwing and still emits a valid document', () => {
      const artifact = adapter.buildFeed(input({ projects: [], financials: [] }));
      const doc = parseDocument(artifact.content);
      expect(doc).toEqual({ generatedAt: '2026-06-10T12:00:00.000Z', rowCount: 0, rows: [] });
      expect(artifact.mimeType).toBe('application/json');
    });
  });

  describe('flatness invariant (BI-tool friendliness)', () => {
    const isPrimitiveCell = (v: unknown): boolean =>
      v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

    it('every value of every row is string | number | boolean | null — no nesting', () => {
      const doc = parseDocument(
        adapter
          .buildFeed(
            input({
              projects: [
                project('p1'),
                project('p2', { description: 'with description', ownerId: 'u1', contractId: 'c1' }),
                project('p3'), // no financials row
              ],
              financials: [financials('p1'), financials('p2'), financials('orphan')],
            }),
          ).content,
      );
      expect(doc.rows.length).toBeGreaterThan(0);
      for (const row of doc.rows) {
        for (const [key, value] of Object.entries(row)) {
          expect(isPrimitiveCell(value), `row value for "${key}" must be a primitive`).toBe(true);
        }
      }
    });

    it('maps undefined optional project fields to null (never undefined / missing-after-parse)', () => {
      const doc = parseDocument(
        adapter.buildFeed(input({ projects: [project('p1')], financials: [financials('p1')] })).content,
      );
      const row = doc.rows[0];
      // description/ownerId/contractId are optional on Project and unset here.
      expect(row['description']).toBeNull();
      expect(row['ownerId']).toBeNull();
      expect(row['contractId']).toBeNull();
    });

    it('coerces non-finite numbers (NaN / Infinity) to null so the JSON stays valid', () => {
      const doc = parseDocument(
        adapter
          .buildFeed(
            input({
              financials: [financials('p1', { marginPct: Number.NaN, vac: Number.POSITIVE_INFINITY, eac: Number.NEGATIVE_INFINITY })],
            }),
          ).content,
      );
      const row = doc.rows[0];
      expect(row['marginPct']).toBeNull();
      expect(row['vac']).toBeNull();
      expect(row['eac']).toBeNull();
      expect(row['revenue']).toBe(100_000); // finite values untouched
    });
  });

  describe('join semantics', () => {
    it('enriches a financials row with project metadata when the project is present', () => {
      const doc = parseDocument(
        adapter
          .buildFeed(
            input({
              projects: [project('p1', { location: 'Rome', ownerId: 'u9' })],
              financials: [financials('p1')],
            }),
          ).content,
      );
      const row = doc.rows[0];
      expect(row['projectId']).toBe('p1');
      expect(row['projectName']).toBe('Project p1');
      expect(row['location']).toBe('Rome');
      expect(row['ownerId']).toBe('u9');
      expect(row['startDate']).toBe('2026-01-01');
      expect(row['endDate']).toBe('2026-12-31');
      // Financial columns from the pre-computed row, passed through verbatim.
      expect(row['revenue']).toBe(100_000);
      expect(row['actualCost']).toBe(60_000);
      expect(row['margin']).toBe(40_000);
      expect(row['marginPct']).toBe(0.4);
      expect(row['budget']).toBe(90_000);
      expect(row['eac']).toBe(80_000);
      expect(row['vac']).toBe(10_000);
    });

    it('emits projects without financials, padding financial columns with null', () => {
      const doc = parseDocument(
        adapter.buildFeed(input({ projects: [project('p1')], financials: [] })).content,
      );
      expect(doc.rowCount).toBe(1);
      const row = doc.rows[0];
      expect(row['projectId']).toBe('p1');
      expect(row['projectName']).toBe('Project p1');
      for (const col of ['revenue', 'actualCost', 'margin', 'marginPct', 'budget', 'eac', 'vac']) {
        expect(row[col], `financial column "${col}" should be null`).toBeNull();
      }
    });

    it('emits orphan financial rows (no matching project), padding project metadata with null', () => {
      const doc = parseDocument(
        adapter
          .buildFeed(
            input({
              projects: [],
              financials: [financials('ghost', { projectName: 'Ghost', status: 'Closed' })],
            }),
          ).content,
      );
      expect(doc.rowCount).toBe(1);
      const row = doc.rows[0];
      expect(row['projectId']).toBe('ghost');
      // Falls back to the name/status carried on the financials row itself.
      expect(row['projectName']).toBe('Ghost');
      expect(row['status']).toBe('Closed');
      for (const col of ['location', 'startDate', 'endDate', 'description', 'ownerId', 'contractId']) {
        expect(row[col], `project column "${col}" should be null`).toBeNull();
      }
      expect(row['revenue']).toBe(100_000);
    });

    it('project name/status from the Project entity win over the financials-row copies', () => {
      const doc = parseDocument(
        adapter
          .buildFeed(
            input({
              projects: [project('p1', { name: 'Canonical Name', status: 'On Hold' })],
              financials: [financials('p1', { projectName: 'Stale Name', status: 'Active' })],
            }),
          ).content,
      );
      expect(doc.rows[0]['projectName']).toBe('Canonical Name');
      expect(doc.rows[0]['status']).toBe('On Hold');
    });

    it('passes duplicate financial rows for the same project through as distinct rows', () => {
      const doc = parseDocument(
        adapter
          .buildFeed(
            input({
              projects: [project('p1')],
              financials: [financials('p1', { revenue: 1 }), financials('p1', { revenue: 2 })],
            }),
          ).content,
      );
      expect(doc.rowCount).toBe(2);
      expect(doc.rows.map((r) => r['revenue']).sort()).toEqual([1, 2]);
    });
  });

  describe('determinism', () => {
    it('sorts rows by projectId so identical input yields an identical artifact', () => {
      const a = adapter.buildFeed(
        input({
          projects: [project('p3'), project('p1')],
          financials: [financials('p2'), financials('p1')],
        }),
      );
      const b = adapter.buildFeed(
        input({
          projects: [project('p1'), project('p3')],
          financials: [financials('p1'), financials('p2')],
        }),
      );
      const ids = (artifact: { content: string }): unknown[] =>
        parseDocument(artifact.content).rows.map((r: BiFeedRow) => r['projectId']);
      expect(ids(a)).toEqual(['p1', 'p2', 'p3']);
      expect(a.content).toBe(b.content);
    });

    it('is pure: does not mutate its input arrays', () => {
      const projects = [project('p2'), project('p1')];
      const fins = [financials('p2'), financials('p1')];
      adapter.buildFeed(input({ projects, financials: fins }));
      expect(projects.map((p) => p.id)).toEqual(['p2', 'p1']);
      expect(fins.map((f) => f.projectId)).toEqual(['p2', 'p1']);
    });
  });
});
