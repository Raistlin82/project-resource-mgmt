/**
 * BI connector adapter ("JsonFeed").
 *
 * Builds a flat, BI-tool-friendly JSON dataset (one row per project, all
 * values primitives) suitable for Power BI / Tableau ingestion. Per the
 * integration design principle this adapter is a LOCAL-ARTIFACT formatter:
 * it performs no network calls, holds no credentials and uses no SDKs — it
 * is a pure function from plain entity data to an in-memory artifact.
 *
 * Shared types: the integration contracts (`IntegrationDescriptor`,
 * `ExportArtifact`, the BiFeed* shapes) are consolidated in `./types` and
 * re-exported here so existing importers (incl. the spec) keep working.
 */

import type { Project } from '../../app/services/api.service';
import type {
  BiFeedAdapter,
  BiFeedCellValue,
  BiFeedDocument,
  BiFeedInput,
  BiFeedRow,
  ExportArtifact,
  IntegrationDescriptor,
  ProjectFinancialsRow,
} from './types';

export type {
  BiFeedAdapter,
  BiFeedCellValue,
  BiFeedDocument,
  BiFeedInput,
  BiFeedRow,
  ExportArtifact,
  IntegrationDescriptor,
  ProjectFinancialsRow,
} from './types';

// --- Implementation -----------------------------------------------------------

export const BI_FEED_DESCRIPTOR: IntegrationDescriptor = {
  kind: 'bi',
  key: 'json-feed',
  name: 'JsonFeed',
  description:
    'Flat JSON dataset (rows of primitives) for Power BI / Tableau ingestion, ' +
    'produced as a local artifact. Not connected to any external system.',
  connected: false,
  mode: 'local-artifact',
};

/**
 * Normalizes an arbitrary primitive-ish value to a BI-safe cell value:
 * `undefined` becomes `null` and non-finite numbers (NaN/Infinity — which
 * JSON cannot represent) become `null`. Strings/booleans pass through.
 */
function cell(value: string | number | boolean | null | undefined): BiFeedCellValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

/**
 * A money or percentage cell: `cell()` semantics, then rounded to 2 decimals.
 *
 * The feed is an EXPORT, so the 2-decimal rule for money/percentages applies on
 * the way out. `marginPct` is the reason this is not cosmetic: it is a computed
 * ratio ×100, so it reaches the feed as `70.19999999999999` / `31.000000000000004`
 * on the seed as shipped — no configuration change needed — and a BI tool
 * renders whatever it is handed.
 *
 * Non-finite values are still `null` (via `cell`), never 0: `Math.round(NaN)` is
 * NaN, which JSON cannot represent, and a fabricated 0 would read as a real
 * figure downstream.
 */
function num2(value: number | undefined): BiFeedCellValue {
  const c = cell(value);
  return typeof c === 'number' ? Math.round((c + Number.EPSILON) * 100) / 100 : c;
}

/** Financial columns emitted as `null` when a project has no financials row. */
const NULL_FINANCIALS: Readonly<Record<string, null>> = {
  revenue: null,
  actualCost: null,
  margin: null,
  marginPct: null,
  budget: null,
  eac: null,
  vac: null,
};

function financialCells(f: ProjectFinancialsRow): BiFeedRow {
  return {
    revenue: num2(f.revenue),
    actualCost: num2(f.actualCost),
    margin: num2(f.margin),
    marginPct: num2(f.marginPct),
    budget: num2(f.budget),
    eac: num2(f.eac),
    vac: num2(f.vac),
  };
}

function projectCells(p: Project): BiFeedRow {
  return {
    projectName: cell(p.name),
    status: cell(p.status),
    location: cell(p.location),
    startDate: cell(p.startDate),
    endDate: cell(p.endDate),
    description: cell(p.description),
    ownerId: cell(p.ownerId),
    contractId: cell(p.contractId),
  };
}

/** Project-metadata columns emitted as `null` for orphan financial rows. */
const NULL_PROJECT_META: Readonly<Record<string, null>> = {
  location: null,
  startDate: null,
  endDate: null,
  description: null,
  ownerId: null,
  contractId: null,
};

/**
 * JsonFeed BI adapter. Pure formatter: joins the supplied projects and
 * pre-computed financial rows by `projectId` into one flat row per project
 * (left/right inclusive — projects without financials and financial rows
 * without a matching project are both emitted, padded with `null`s so no
 * input data is silently dropped). Rows are sorted by `projectId` so the
 * artifact is deterministic for identical input.
 */
export class JsonFeedBiAdapter implements BiFeedAdapter {
  describe(): IntegrationDescriptor {
    return { ...BI_FEED_DESCRIPTOR };
  }

  buildFeed(input: BiFeedInput): ExportArtifact {
    const projectById = new Map<string, Project>(input.projects.map((p) => [p.id, p]));
    const financialProjectIds = new Set<string>(input.financials.map((f) => f.projectId));

    const rows: BiFeedRow[] = [];

    // One row per financials entry, enriched with project metadata when known.
    for (const f of input.financials) {
      const p = projectById.get(f.projectId);
      rows.push({
        generatedAt: input.generatedAt,
        projectId: cell(f.projectId),
        projectName: cell(p ? p.name : f.projectName),
        status: cell(p ? p.status : f.status),
        ...(p ? projectCells(p) : { ...NULL_PROJECT_META }),
        ...financialCells(f),
      });
    }

    // Projects with no financials row still appear (financial columns null).
    for (const p of input.projects) {
      if (financialProjectIds.has(p.id)) continue;
      rows.push({
        generatedAt: input.generatedAt,
        projectId: cell(p.id),
        ...projectCells(p),
        ...NULL_FINANCIALS,
      });
    }

    rows.sort((a, b) => {
      const ai = typeof a['projectId'] === 'string' ? a['projectId'] : '';
      const bi = typeof b['projectId'] === 'string' ? b['projectId'] : '';
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });

    const document: BiFeedDocument = {
      generatedAt: input.generatedAt,
      rowCount: rows.length,
      rows,
    };

    // ISO timestamps contain ':' and '.' which are awkward in filenames.
    const stamp = input.generatedAt.replace(/[:.]/g, '');
    return {
      filename: `bi-feed-${stamp}.json`,
      mimeType: 'application/json',
      content: JSON.stringify(document, null, 2),
    };
  }
}
