import {
  ErpExportAdapter,
  GenericLedgerExportAdapter,
  GL_CSV_TOTALS_LABEL,
  UnbalancedJournalError,
} from './erp-ledger.adapter';
import {
  FinanceData,
  JournalEntry,
  journalTotals,
  recognitionJournal,
} from '../../app/services/finance.util';

/**
 * Unit tests for the ERP/GL local-artifact adapter ("GenericLedgerExport").
 *
 * Test-runner conventions match src/db/repository.spec.ts: vitest globals
 * (`describe`/`it`/`expect`) provided via tsconfig.spec.json
 * (`"types": ["vitest/globals"]`); no per-file imports of the runner.
 */

/** A balanced two-entry journal (3 lines total) shaped like recognitionJournal output. */
function balancedJournal(): JournalEntry[] {
  return [
    {
      date: '2026-01',
      memo: 'Revenue recognition 2026-01',
      lines: [
        { account: 'Unbilled AR', debit: 1000, credit: 0 },
        { account: 'Revenue', debit: 0, credit: 1000 },
      ],
    },
    {
      date: '2026-02',
      memo: 'Revenue recognition 2026-02',
      lines: [{ account: 'Cash/AR', debit: 500, credit: 500 }],
    },
  ];
}

function adapter(): ErpExportAdapter {
  return new GenericLedgerExportAdapter();
}

const CSV_HEADER = 'date,memo,account,debit,credit';

describe('GenericLedgerExportAdapter', () => {
  // --- descriptor --------------------------------------------------------------

  describe('describe()', () => {
    it('self-describes as an unconnected local-artifact ERP adapter', () => {
      const d = adapter().describe();
      expect(d.kind).toBe('erp');
      expect(d.key).toBe('generic-ledger-export');
      expect(d.name).toBe('GenericLedgerExport');
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.connected).toBe(false);
      expect(d.mode).toBe('local-artifact');
    });
  });

  // --- CSV happy path ----------------------------------------------------------

  describe('buildJournalExport — CSV (default format)', () => {
    it('emits a header, one row per journal LINE, and a trailing totals row', () => {
      const artifact = adapter().buildJournalExport(balancedJournal());
      const rows = artifact.content.split('\r\n');

      // 1 header + 3 lines (2 + 1) + 1 totals = 5 rows.
      expect(rows).toHaveLength(5);
      expect(rows[0]).toBe(CSV_HEADER);

      // Entry date + memo are repeated on each of that entry's lines.
      expect(rows[1]).toBe('2026-01,Revenue recognition 2026-01,Unbilled AR,1000,0');
      expect(rows[2]).toBe('2026-01,Revenue recognition 2026-01,Revenue,0,1000');
      expect(rows[3]).toBe('2026-02,Revenue recognition 2026-02,Cash/AR,500,500');
    });

    it('ends with a TOTALS row whose Σ debit equals Σ credit', () => {
      const journal = balancedJournal();
      const artifact = adapter().buildJournalExport(journal);
      const rows = artifact.content.split('\r\n');
      const totals = journalTotals(journal);

      expect(rows[rows.length - 1]).toBe(`,,${GL_CSV_TOTALS_LABEL},${totals.debit},${totals.credit}`);
      expect(totals.debit).toBe(1500);
      expect(totals.credit).toBe(1500);
    });

    it('returns a .csv filename (derived from the entry dates) and a CSV MIME type', () => {
      const artifact = adapter().buildJournalExport(balancedJournal());
      expect(artifact.filename).toBe('gl-journal_2026-01_2026-02.csv');
      expect(artifact.mimeType).toBe('text/csv;charset=utf-8');
    });

    it('uses a single-period filename when all entries share one date', () => {
      const single = balancedJournal().slice(1); // only the 2026-02 entry (self-balanced)
      const artifact = adapter().buildJournalExport(single);
      expect(artifact.filename).toBe('gl-journal_2026-02.csv');
    });

    it('CSV is the default when no format option is given', () => {
      const explicit = adapter().buildJournalExport(balancedJournal(), { format: 'csv' });
      const implicit = adapter().buildJournalExport(balancedJournal());
      expect(implicit.content).toBe(explicit.content);
      expect(implicit.mimeType).toBe('text/csv;charset=utf-8');
    });
  });

  // --- JSON happy path ---------------------------------------------------------

  describe('buildJournalExport — JSON', () => {
    it('contains the entries plus the batch totals', () => {
      const journal = balancedJournal();
      const artifact = adapter().buildJournalExport(journal, { format: 'json' });

      const parsed = JSON.parse(artifact.content) as {
        format: string;
        entries: JournalEntry[];
        totals: { debit: number; credit: number; balanced: boolean };
      };
      expect(parsed.format).toBe('GenericLedgerExport');
      expect(parsed.entries).toEqual(journal);
      expect(parsed.totals).toEqual({ debit: 1500, credit: 1500, balanced: true });
    });

    it('returns a .json filename and a JSON MIME type', () => {
      const artifact = adapter().buildJournalExport(balancedJournal(), { format: 'json' });
      expect(artifact.filename).toBe('gl-journal_2026-01_2026-02.json');
      expect(artifact.mimeType).toBe('application/json;charset=utf-8');
    });
  });

  // --- unbalanced batches are rejected ------------------------------------------

  describe('unbalanced journal rejection', () => {
    const unbalanced: JournalEntry[] = [
      {
        date: '2026-03',
        memo: 'Broken entry',
        lines: [
          { account: 'Unbilled AR', debit: 1000, credit: 0 },
          { account: 'Revenue', debit: 0, credit: 900 }, // 100 short
        ],
      },
    ];

    it('throws a typed UnbalancedJournalError for CSV', () => {
      expect(() => adapter().buildJournalExport(unbalanced)).toThrowError(UnbalancedJournalError);
    });

    it('throws for JSON too (the invariant is format-independent)', () => {
      expect(() => adapter().buildJournalExport(unbalanced, { format: 'json' })).toThrowError(
        UnbalancedJournalError,
      );
    });

    it('carries the offending totals on the error', () => {
      let caught: unknown;
      try {
        adapter().buildJournalExport(unbalanced);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnbalancedJournalError);
      const err = caught as UnbalancedJournalError;
      expect(err.name).toBe('UnbalancedJournalError');
      expect(err.debit).toBe(1000);
      expect(err.credit).toBe(900);
      expect(err.difference).toBe(100);
      expect(err.message).toContain('unbalanced');
    });
  });

  // --- CSV formula-injection guard -----------------------------------------------

  describe('CSV injection guard', () => {
    it("neutralises a memo starting with '=' by prefixing a single quote", () => {
      const journal: JournalEntry[] = [
        {
          date: '2026-01',
          memo: '=2+2',
          lines: [
            { account: 'Unbilled AR', debit: 10, credit: 0 },
            { account: 'Revenue', debit: 0, credit: 10 },
          ],
        },
      ];
      const artifact = adapter().buildJournalExport(journal);
      const rows = artifact.content.split('\r\n');

      // The memo cell is rendered as inert text ('=2+2), never a live formula.
      expect(rows[1]).toBe("2026-01,'=2+2,Unbilled AR,10,0");
      expect(artifact.content).not.toContain(',=2+2,');
    });

    it('guards account names and applies RFC-4180 quoting to memos with commas/quotes', () => {
      const journal: JournalEntry[] = [
        {
          date: '2026-01',
          memo: 'rev-rec, "Q1" batch',
          lines: [
            { account: '@SUM(A1)', debit: 5, credit: 0 },
            { account: 'Revenue', debit: 0, credit: 5 },
          ],
        },
      ];
      const rows = adapter().buildJournalExport(journal).content.split('\r\n');

      // Comma + embedded quotes => wrapped in quotes with quotes doubled.
      expect(rows[1]).toBe('2026-01,"rev-rec, ""Q1"" batch",\'@SUM(A1),5,0');
    });

    it('never corrupts negative numeric amounts with the injection prefix', () => {
      // Mirrors escapeCsv semantics: a finite number is never a formula. A
      // negative debit/credit pair (atypical but representable) round-trips
      // verbatim so spreadsheet SUM/aggregation still works.
      const journal: JournalEntry[] = [
        {
          date: '2026-01',
          memo: 'reversal',
          lines: [
            { account: 'Unbilled AR', debit: -10, credit: 0 },
            { account: 'Revenue', debit: 0, credit: -10 },
          ],
        },
      ];
      const rows = adapter().buildJournalExport(journal).content.split('\r\n');
      expect(rows[1]).toBe('2026-01,reversal,Unbilled AR,-10,0');
      expect(rows[1]).not.toContain("'-10");
    });
  });

  // --- 2-decimal emission boundary --------------------------------------------------
  //
  // A GL export is imported into an accounting system, so money must LEAVE this
  // adapter at 2 decimals. The reachable source of >2-decimal money: an admin
  // sets hours-per-day to 7.5, every rate card is divided by 7.5, and RC_DEV's
  // 1120 EUR/day recognises 8 approved hours as 1194.6666666666667.

  describe('money leaves the adapter at 2 decimals', () => {
    /** A balanced entry whose amount carries 13 decimal places of float residue. */
    const UNROUNDED = (1120 / 7.5) * 8; // 1194.6666666666667
    function unroundedJournal(): JournalEntry[] {
      return [
        {
          date: '2026-04',
          memo: 'Revenue recognition 2026-04',
          lines: [
            { account: 'Unbilled AR', debit: UNROUNDED, credit: 0 },
            { account: 'Revenue', debit: 0, credit: UNROUNDED },
          ],
        },
      ];
    }

    it('the fixture really is unrounded (guards this whole block against a clean input)', () => {
      // Without this, every assertion below would also pass on an input that
      // never had a rounding problem — the test would prove nothing.
      expect(UNROUNDED).toBe(1194.6666666666667);
      expect(String(UNROUNDED)).toMatch(/\d+\.\d{3,}/);
    });

    it('CSV: writes the line amount as 1194.67 and leaves NO >2-decimal numeral anywhere', () => {
      const artifact = adapter().buildJournalExport(unroundedJournal());
      expect(artifact.content).toContain(',1194.67,0');
      // The regex of ABSENCE is the load-bearing half: toContain('1194.67') alone
      // also passes on the string '1194.6666666666667'. Safe to apply to the
      // whole CSV because its only dates are 'YYYY-MM'.
      expect(artifact.content).not.toMatch(/\d+\.\d{3,}/);
    });

    it('CSV: rounds the TOTALS row too, not just the line rows', () => {
      const rows = adapter().buildJournalExport(unroundedJournal()).content.split('\r\n');
      expect(rows[rows.length - 1]).toBe(`,,${GL_CSV_TOTALS_LABEL},1194.67,1194.67`);
    });

    it('JSON: rounds the entries and the totals (the rule cannot depend on format)', () => {
      const parsed = JSON.parse(
        adapter().buildJournalExport(unroundedJournal(), { format: 'json' }).content,
      ) as { entries: JournalEntry[]; totals: { debit: number; credit: number } };

      expect(parsed.entries[0].lines[0].debit).toBe(1194.67);
      expect(parsed.entries[0].lines[1].credit).toBe(1194.67);
      expect(parsed.totals.debit).toBe(1194.67);
      expect(parsed.totals.credit).toBe(1194.67);
    });

    it('does not mutate the caller-supplied journal (rounding is emission-only)', () => {
      const journal = unroundedJournal();
      adapter().buildJournalExport(journal, { format: 'json' });
      adapter().buildJournalExport(journal);
      expect(journal[0].lines[0].debit).toBe(UNROUNDED);
      expect(journal[0].lines[1].credit).toBe(UNROUNDED);
    });

    it('rejects an imbalance SMALLER than a cent — the balance check runs on the exact figures', () => {
      // Rounding must not migrate upstream of the balance assertion: if it did,
      // both sides would land on 1194.67 and this batch would be emitted as
      // balanced. journalTotals' epsilon is 1e-6, so 0.001 is a real imbalance.
      const nearlyBalanced: JournalEntry[] = [
        {
          date: '2026-04',
          memo: 'Sub-cent imbalance',
          lines: [
            { account: 'Unbilled AR', debit: UNROUNDED, credit: 0 },
            { account: 'Revenue', debit: 0, credit: UNROUNDED - 0.001 },
          ],
        },
      ];
      expect(() => adapter().buildJournalExport(nearlyBalanced)).toThrowError(UnbalancedJournalError);
      expect(() => adapter().buildJournalExport(nearlyBalanced, { format: 'json' })).toThrowError(
        UnbalancedJournalError,
      );
    });

    it('leaves already-clean amounts, and integer amounts, byte-identical', () => {
      // The absence twin for the rounding itself: a formatter that reformatted
      // every number (e.g. toFixed(2)) would turn 1000 into '1000.00' and change
      // every existing row.
      const artifact = adapter().buildJournalExport(balancedJournal());
      expect(artifact.content).toContain('2026-01,Revenue recognition 2026-01,Unbilled AR,1000,0');
      expect(artifact.content).not.toContain('1000.00');
    });
  });

  // --- empty journal ---------------------------------------------------------------

  describe('empty journal', () => {
    it('CSV: yields a valid artifact with header + zero totals row only', () => {
      const artifact = adapter().buildJournalExport([]);
      const rows = artifact.content.split('\r\n');

      expect(rows).toHaveLength(2);
      expect(rows[0]).toBe(CSV_HEADER);
      expect(rows[1]).toBe(`,,${GL_CSV_TOTALS_LABEL},0,0`);
      expect(artifact.filename).toBe('gl-journal_empty.csv');
      expect(artifact.mimeType).toBe('text/csv;charset=utf-8');
    });

    it('JSON: yields empty entries with balanced zero totals', () => {
      const artifact = adapter().buildJournalExport([], { format: 'json' });
      const parsed = JSON.parse(artifact.content) as {
        entries: JournalEntry[];
        totals: { debit: number; credit: number; balanced: boolean };
      };
      expect(parsed.entries).toEqual([]);
      expect(parsed.totals).toEqual({ debit: 0, credit: 0, balanced: true });
      expect(artifact.filename).toBe('gl-journal_empty.json');
    });
  });

  // --- end-to-end with the real journal producer -----------------------------------

  describe('integration with recognitionJournal', () => {
    it('exports a journal built by recognitionJournal (always balanced by construction)', () => {
      const data: FinanceData = {
        requests: [],
        assignments: [],
        resources: [],
        orders: [],
        orderLines: [],
        financials: [],
        billingItems: [
          {
            id: 'b1',
            contractId: 'c1',
            projectId: 'p1',
            type: 'Milestone',
            label: 'Go-live',
            amount: 1000,
            currency: 'EUR',
            status: 'Invoiced',
            issuedDate: '2026-01-15',
          },
          {
            id: 'b2',
            contractId: 'c1',
            projectId: 'p1',
            type: 'Advance',
            label: 'Down payment',
            amount: 400,
            currency: 'EUR',
            status: 'Paid',
            issuedDate: '2026-02-10',
          },
        ],
      };
      const journal = recognitionJournal(data, { from: '2026-01', to: '2026-03' }, { projectId: 'p1' });
      expect(journal.length).toBeGreaterThan(0);
      expect(journalTotals(journal).balanced).toBe(true);

      const artifact = adapter().buildJournalExport(journal);
      const rows = artifact.content.split('\r\n');

      // header + Σ lines + totals row, totals row balanced.
      const lineCount = journal.reduce((n, e) => n + e.lines.length, 0);
      expect(rows).toHaveLength(1 + lineCount + 1);
      const totals = journalTotals(journal);
      expect(rows[rows.length - 1]).toBe(`,,${GL_CSV_TOTALS_LABEL},${totals.debit},${totals.credit}`);

      // Milestone revenue posting lands in 2026-01: Dr Unbilled AR / Cr Revenue 1000.
      expect(rows).toContain('2026-01,Revenue recognition 2026-01,Unbilled AR,1000,0');
      expect(rows).toContain('2026-01,Revenue recognition 2026-01,Revenue,0,1000');
      // Advance billed in 2026-02: Dr Cash/AR / Cr Deferred Revenue 400.
      expect(rows).toContain('2026-02,Revenue recognition 2026-02,Cash/AR,400,0');
      expect(rows).toContain('2026-02,Revenue recognition 2026-02,Deferred Revenue,0,400');
    });
  });
});
