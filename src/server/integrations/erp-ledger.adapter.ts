/**
 * ERP / accounting GL export adapter ("GenericLedgerExport").
 *
 * DESIGN PRINCIPLE: this is a LOCAL-ARTIFACT adapter. It is a pure builder that
 * turns an in-memory revenue-recognition journal (the output of
 * `recognitionJournal` in finance.util) into a flat-file artifact an ERP /
 * accounting system could import. There is NO network I/O, NO credentials and
 * NO vendor SDK here — the adapter self-describes as `connected: false`,
 * `mode: 'local-artifact'`.
 *
 * Formats:
 *   • CSV  — one row per journal LINE (`date,memo,account,debit,credit`),
 *            header row first, trailing TOTALS row, RFC-4180 quoting and a
 *            formula-injection guard on every cell (via `escapeCsv`).
 *   • JSON — the journal entries verbatim plus the debit/credit totals.
 *
 * Invariant: an ERP must NEVER receive an unbalanced batch. When
 * `journalTotals(entries).balanced === false` the builder throws a typed
 * {@link UnbalancedJournalError} instead of producing an artifact.
 */

import { JournalEntry, journalTotals } from '../../app/services/finance.util';
// Cleanly importable: export.util is pure/framework-free (its download helpers
// no-op outside the browser and are not used here).
import { escapeCsv } from '../../app/services/export.util';

// Shared integration contracts live in ./types (single source of truth). They
// are re-exported here so existing importers (incl. the spec) keep working.
import type {
  ErpExportAdapter,
  ErpExportFormat,
  ErpExportOptions,
  ExportArtifact,
  IntegrationDescriptor,
} from './types';

export type {
  ErpExportAdapter,
  ErpExportFormat,
  ErpExportOptions,
  ExportArtifact,
  IntegrationDescriptor,
} from './types';

/**
 * Typed rejection for unbalanced batches. Carries the offending totals so a
 * caller (route handler, CLI, test) can report exactly how far off the batch is.
 */
export class UnbalancedJournalError extends Error {
  readonly debit: number;
  readonly credit: number;
  /** debit − credit (signed imbalance). */
  readonly difference: number;

  constructor(debit: number, credit: number) {
    super(
      `Journal batch is unbalanced: Σ debit ${debit} ≠ Σ credit ${credit} ` +
        `(difference ${debit - credit}). An ERP must never receive an unbalanced batch.`,
    );
    this.name = 'UnbalancedJournalError';
    this.debit = debit;
    this.credit = credit;
    this.difference = debit - credit;
  }
}

// --- CSV layout ----------------------------------------------------------------

/** CSV column order: one row per journal LINE. */
export const GL_CSV_HEADER = ['date', 'memo', 'account', 'debit', 'credit'] as const;

/** Label placed in the `account` column of the trailing totals row. */
export const GL_CSV_TOTALS_LABEL = 'TOTALS';

/** Join cells of one CSV row, escaping every cell (injection guard + RFC 4180). */
function csvRow(cells: readonly unknown[]): string {
  return cells.map(escapeCsv).join(',');
}

/** Sanitise a free-form date/period string for use inside a filename. */
function filenameToken(value: string): string {
  const safe = value.replace(/[^0-9A-Za-z-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.length > 0 ? safe : 'undated';
}

/** Deterministic filename stem derived from the journal's first/last entry date. */
function filenameStem(entries: readonly JournalEntry[]): string {
  if (entries.length === 0) return 'gl-journal_empty';
  const first = filenameToken(entries[0].date);
  const last = filenameToken(entries[entries.length - 1].date);
  return first === last ? `gl-journal_${first}` : `gl-journal_${first}_${last}`;
}

// --- Concrete adapter -----------------------------------------------------------

/**
 * The single concrete ERP adapter: "GenericLedgerExport".
 *
 * Pure builder over plain {@link JournalEntry} data — safe to instantiate
 * anywhere (server route, test, script). Both build paths first validate the
 * balance invariant via `journalTotals` and throw {@link UnbalancedJournalError}
 * on violation. An EMPTY journal is balanced by definition (Σ0 = Σ0) and yields
 * a valid, importable empty artifact.
 */
export class GenericLedgerExportAdapter implements ErpExportAdapter {
  describe(): IntegrationDescriptor {
    return {
      kind: 'erp',
      key: 'generic-ledger-export',
      name: 'GenericLedgerExport',
      description:
        'Builds a balanced double-entry general-ledger journal export (CSV or JSON) ' +
        'from the revenue-recognition journal, as a local file artifact. Not connected ' +
        'to any external ERP — no network, credentials or vendor SDK.',
      connected: false,
      mode: 'local-artifact',
    };
  }

  buildJournalExport(entries: readonly JournalEntry[], opts: ErpExportOptions = {}): ExportArtifact {
    const totals = journalTotals(entries);
    if (!totals.balanced) {
      throw new UnbalancedJournalError(totals.debit, totals.credit);
    }

    const format: ErpExportFormat = opts.format ?? 'csv';
    return format === 'json'
      ? this.buildJson(entries, totals)
      : this.buildCsv(entries, totals);
  }

  /**
   * CSV: header row, one row per journal line (the entry's date + memo are
   * repeated on each of its lines), then a trailing totals row with the batch
   * Σ debit / Σ credit in the `account = TOTALS` row. Lines joined with CRLF
   * (RFC 4180), every cell passed through `escapeCsv` so a memo or account
   * starting with `=`, `+`, `-`, `@`, TAB or CR cannot inject a formula.
   */
  private buildCsv(
    entries: readonly JournalEntry[],
    totals: { debit: number; credit: number },
  ): ExportArtifact {
    const rows: string[] = [csvRow(GL_CSV_HEADER)];
    for (const entry of entries) {
      for (const line of entry.lines) {
        rows.push(csvRow([entry.date, entry.memo, line.account, line.debit, line.credit]));
      }
    }
    rows.push(csvRow(['', '', GL_CSV_TOTALS_LABEL, totals.debit, totals.credit]));

    return {
      filename: `${filenameStem(entries)}.csv`,
      mimeType: 'text/csv;charset=utf-8',
      content: rows.join('\r\n'),
    };
  }

  /** JSON: the entries verbatim plus the (already validated) totals. */
  private buildJson(
    entries: readonly JournalEntry[],
    totals: { debit: number; credit: number; balanced: boolean },
  ): ExportArtifact {
    const payload = {
      format: 'GenericLedgerExport',
      entries,
      totals,
    };
    return {
      filename: `${filenameStem(entries)}.json`,
      mimeType: 'application/json;charset=utf-8',
      content: JSON.stringify(payload, null, 2),
    };
  }
}
