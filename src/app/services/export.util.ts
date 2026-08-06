/**
 * Pure, framework-free CSV/JSON/XLSX export helpers.
 *
 * No Angular DI, no component state — just functions over plain data so they can be
 * unit-tested in isolation and called from any component (which is expected to guard
 * the browser-only download helpers with isPlatformBrowser). The download helpers also
 * defensively no-op when `document` is unavailable (SSR / non-browser).
 *
 * SECURITY: escapeCsv applies a CSV formula-injection guard. A cell whose first
 * character is one of = + - @ TAB CR is prefixed with a single quote so spreadsheet
 * apps (Excel, Sheets, LibreOffice) treat it as text rather than a formula. The XLSX
 * writer solves the same problem a different (and better) way — see
 * {@link buildXlsx}: xlsx has a real per-cell TYPE channel, so a string is written
 * as a string and can never be evaluated.
 */

/** Characters that, when leading a cell, can trigger formula evaluation in spreadsheet apps. */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Cells containing any of these must be wrapped in double quotes (with quotes doubled). */
const QUOTE_NEEDED = /[",\n\r]/;

/**
 * A cell that is ENTIRELY a number — optional sign, digits, optional decimals, and an
 * optional trailing `%`. Such a cell cannot be a formula, so the injection prefix must
 * not be applied to it whatever its JavaScript type.
 *
 * The type-based exemption below was not enough: every money column in the app
 * pre-formats with `.toFixed()`, which returns a STRING. So `-12160` was emitted
 * verbatim but `(-12160).toFixed(2)` became `'-12160.00` — a text label. In
 * Excel/Sheets that cell shows a stray apostrophe, `=SUM` over the column skips it,
 * and a pivot omits exactly the overrunning rows the export exists to surface.
 * `reporting.ts` alone has eight such columns (VAC, margin, marginPct, PCP delta and
 * its pct, customer margin, gap points) and billing.ts's amount is negative for
 * every CreditNote.
 *
 * Deliberately strict: anything with a second operator or a letter — `-1+1`, `-A1`,
 * `+SUM(A1)` — is NOT numeric and stays prefixed.
 */
const NUMERIC_CELL = /^[+-]?(\d+(\.\d+)?|\.\d+)%?$/;

/**
 * Escapes a single CSV cell.
 *
 * 1. Formula-injection guard: if the (stringified) value starts with `= + - @`, TAB, or
 *    CR, prefix a single quote so it renders as inert text. A FULLY NUMERIC cell is
 *    exempt whatever its JS type — a number is never a spreadsheet formula, and
 *    prefixing it (e.g. a negative `-1500`, or the string `'-1500.00'` that
 *    `.toFixed(2)` produces) would corrupt it into a text label that breaks
 *    SUM/aggregation.
 * 2. RFC-4180 quoting: if the value contains a comma, double-quote, CR, or LF, wrap it in
 *    double quotes and double any embedded double-quotes.
 *
 * `null`/`undefined` become an empty string. Numbers/booleans are stringified.
 */
export function escapeCsv(value: unknown): string {
  // A finite number can never be interpreted as a formula, so emit it verbatim — never
  // apply the injection prefix (which would turn e.g. -1500 into the text "'-1500").
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  let s = value === null || value === undefined ? '' : String(value);

  if (s.length > 0 && FORMULA_TRIGGERS.has(s[0]) && !NUMERIC_CELL.test(s)) {
    s = `'${s}`;
  }

  if (QUOTE_NEEDED.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

/** Column descriptor for {@link toCsv}. */
export interface CsvColumn<T> {
  /** Property key on the row (used when `map` is absent). */
  key: keyof T | string;
  /** Header label emitted in the first CSV line. */
  header: string;
  /** Optional value extractor; overrides `key`-based lookup. */
  map?: (row: T) => string | number;
}

/**
 * Builds a CSV string (header row + one line per row) from typed rows and column
 * descriptors. Every cell — headers included — is passed through {@link escapeCsv}.
 * Lines are joined with CRLF per RFC 4180.
 */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escapeCsv(c.header)).join(',');

  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const raw = c.map ? c.map(row) : (row as Record<string, unknown>)[c.key as string];
        return escapeCsv(raw);
      })
      .join(','),
  );

  return [headerLine, ...lines].join('\r\n');
}

/** Pretty-prints any JSON-serialisable value with 2-space indentation. */
export function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** True only in a browser context where DOM download primitives exist. */
function canDownload(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  );
}

/** Internal: create a Blob and trigger an anchor download. No-ops outside the browser. */
function triggerDownload(filename: string, content: BlobPart, mime: string): void {
  if (!canDownload()) {
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Downloads `csv` as a UTF-8 .csv file. Browser-only: callers should guard with
 * isPlatformBrowser, but this also no-ops when `document` is unavailable.
 */
export function downloadCsv(filename: string, csv: string): void {
  triggerDownload(filename, csv, 'text/csv;charset=utf-8');
}

/**
 * Downloads `json` as a UTF-8 .json file. Browser-only: callers should guard with
 * isPlatformBrowser, but this also no-ops when `document` is unavailable.
 */
export function downloadJson(filename: string, json: string): void {
  triggerDownload(filename, json, 'application/json;charset=utf-8');
}

// ---------------------------------------------------------------------------
// XLSX (multi-sheet workbooks)
// ---------------------------------------------------------------------------

/**
 * A value that can be written into one xlsx cell.
 *
 * The union is deliberately narrow — `number` OR text — because the union member
 * IS the type channel: {@link buildXlsx} writes a finite `number` as a numeric
 * cell and everything else as a string cell. `null`/`undefined` write an empty
 * cell. Booleans and Dates are excluded on purpose: an exported report is read by
 * humans and by `=SUM()`, and a locale-dependent date serial or a TRUE/FALSE
 * literal is neither — format those at the call site.
 */
export type XlsxCellValue = string | number | null | undefined;

/** Column descriptor for {@link xlsxSheet}. */
export interface XlsxColumn<T> {
  /** Header label emitted in the sheet's first row. */
  header: string;
  /**
   * Cell extractor. Return a NUMBER for anything that should stay arithmetic in
   * Excel (money, hours, FTE, percentages — run it through {@link xlsxNum} for the
   * project's ≤2-decimal rule) and a string for labels. Never pre-format a figure
   * with `.toFixed()`: that produces text, and text does not sum.
   */
  value: (row: T) => XlsxCellValue;
  /** Optional column width, in approximate characters. */
  width?: number;
  /** Optional Excel number format applied to this column's data cells (e.g. '#,##0.00'). */
  numFmt?: string;
}

/** One worksheet of a workbook: a name, a header row and already-flattened data rows. */
export interface XlsxSheet {
  /** Sheet tab name. Sanitised/deduplicated by {@link buildXlsx} against Excel's rules. */
  name: string;
  header: readonly string[];
  /** Data rows, header excluded. An empty array yields a header-only sheet. */
  rows: readonly (readonly XlsxCellValue[])[];
  /** Per-column widths, positionally aligned with `header`. */
  widths?: readonly (number | undefined)[];
  /** Per-column Excel number formats, positionally aligned with `header`. */
  numFmts?: readonly (string | undefined)[];
}

/** Excel's own limit on a sheet-tab name. */
const SHEET_NAME_MAX = 31;

/** Characters Excel forbids in a sheet-tab name. */
const SHEET_NAME_FORBIDDEN = /[\\/?*[\]:]/g;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Rounds a quantity for export, keeping it a NUMBER.
 *
 * The project-wide rule is at most 2 decimals for money, days/FTE and percentages —
 * on screen, in chart labels AND in exported files. The obvious way to satisfy it,
 * `.toFixed(2)`, is wrong here: it returns a STRING, which lands in the sheet as a
 * text cell that `=SUM()` skips and a pivot ignores. So round the value and leave
 * the type alone.
 *
 * Non-finite input (NaN/Infinity, e.g. a 0/0 percentage) becomes `null` — an empty
 * cell — rather than the text 'NaN', which would poison a whole column's arithmetic.
 */
export function xlsxNum(value: number | null | undefined, decimals = 2): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** Math.min(6, Math.max(0, Math.trunc(decimals)));
  return Math.round(value * factor) / factor;
}

/**
 * Builds an {@link XlsxSheet} from typed rows and column descriptors — the xlsx
 * sibling of {@link toCsv}, and the only place column order is decided.
 */
export function xlsxSheet<T>(name: string, rows: readonly T[], columns: readonly XlsxColumn<T>[]): XlsxSheet {
  return {
    name,
    header: columns.map((c) => c.header),
    rows: rows.map((row) => columns.map((c) => c.value(row))),
    widths: columns.map((c) => c.width),
    numFmts: columns.map((c) => c.numFmt),
  };
}

/**
 * Coerce a caller-supplied tab name into one Excel will accept, and keep it unique.
 *
 * Excel rejects `\ / ? * [ ] :`, an empty name and anything over 31 characters, and
 * silently refuses a duplicate (case-insensitively). Truncation is what makes
 * collisions realistic — two long report sections can easily share their first 31
 * characters — so the dedupe suffix is not theoretical.
 */
function toSheetName(raw: string, taken: Set<string>): string {
  let base = raw.replace(SHEET_NAME_FORBIDDEN, '-').replace(/^'+|'+$/g, '').trim();
  if (base.length === 0) base = 'Sheet';
  base = base.slice(0, SHEET_NAME_MAX);

  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = base.slice(0, SHEET_NAME_MAX - suffix.length) + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** The ExcelJS module namespace, however the bundler's CJS interop hands it over. */
type ExcelJsModule = typeof import('exceljs');

/**
 * Loads ExcelJS lazily.
 *
 * DYNAMIC on purpose. The browser build is ~950 kB raw / ~260 kB gzipped, and this
 * app's production budget for the INITIAL bundle is 650 kB (warning) / 1 MB (error).
 * A static import would blow it and would make every user pay for a spreadsheet
 * writer most of them never trigger; imported here, esbuild emits it as its own lazy
 * chunk fetched on the first XLSX click.
 *
 * The `default ?? namespace` dance is the CJS interop: ExcelJS publishes a CJS entry
 * for Node and a prebundled UMD (`dist/exceljs.min.js`, via its `browser` field) for
 * the web. Depending on which one the bundler picks and whether it can statically see
 * the named exports, the namespace object is either the module itself or nested under
 * `default`.
 */
async function loadExcelJs(): Promise<ExcelJsModule> {
  const mod = (await import('exceljs')) as ExcelJsModule & { default?: ExcelJsModule };
  return mod.default ?? mod;
}

/**
 * Renders `sheets` into xlsx bytes — one worksheet per entry, in the given order.
 *
 * SECURITY — HOW A CELL IS MADE SAFE. CSV has no type channel, so `escapeCsv` has to
 * neutralise a leading `= + - @` with an apostrophe and then carve out an exemption
 * for cells that are wholly numeric. xlsx does have one: a cell carries its type in
 * the file itself. ExcelJS derives that type from the SHAPE of the assigned value —
 * a `number` becomes a numeric cell, a `string` becomes a (shared-)string cell
 * `t="s"`, and a formula requires an explicit `{ formula: '…' }` object which this
 * writer never constructs. So `=SUM(A1)` arriving as a string is stored as the TEXT
 * "=SUM(A1)" and Excel cannot evaluate it — there is nothing to neutralise.
 *
 * That is why the CSV apostrophe is deliberately NOT carried over: replicating it
 * here would put a literal stray `'` in the cell (visible in Excel, and part of the
 * value for anything reading the file), trading a non-existent injection risk for a
 * real data-corruption one. Write the type, not a prefix.
 *
 * Exported separately from {@link downloadXlsx} so the produced bytes are assertable
 * without a DOM download.
 */
export async function buildXlsx(sheets: readonly XlsxSheet[]): Promise<Uint8Array<ArrayBuffer>> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Delivery Control';
  const taken = new Set<string>();

  for (const sheet of sheets) {
    // Freeze the header: these reports are wide (one column pair per month), and a
    // planner scrolling to December must still see which column is which.
    const ws = workbook.addWorksheet(toSheetName(sheet.name, taken), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    const headerRow = ws.getRow(1);
    sheet.header.forEach((label, i) => {
      headerRow.getCell(i + 1).value = label;
    });
    headerRow.font = { bold: true };
    headerRow.commit();

    sheet.rows.forEach((cells, r) => {
      const row = ws.getRow(r + 2);
      cells.forEach((value, c) => {
        const cell = row.getCell(c + 1);
        // THE TYPE DECISION, and the only one. A finite number goes in as a number
        // (so =SUM/pivots work); anything else goes in as text (so nothing is ever
        // evaluated). NaN/Infinity are not representable in xlsx and would surface
        // as the text 'NaN', so they empty the cell instead.
        if (typeof value === 'number') {
          cell.value = Number.isFinite(value) ? value : null;
        } else {
          cell.value = value === null || value === undefined ? null : String(value);
        }
        const numFmt = sheet.numFmts?.[c];
        if (numFmt !== undefined && typeof cell.value === 'number') cell.numFmt = numFmt;
      });
      row.commit();
    });

    sheet.header.forEach((label, i) => {
      // Fall back to the header's own length so a data-less column is still readable.
      ws.getColumn(i + 1).width = sheet.widths?.[i] ?? Math.min(40, Math.max(10, label.length + 2));
    });
  }

  const raw: unknown = await workbook.xlsx.writeBuffer();
  // Node returns a Buffer (already a Uint8Array), the browser build an ArrayBuffer.
  // Copy into a plain, non-shared-backed Uint8Array either way: that is the one form
  // both `Blob` and every byte consumer accept without a cast (a `Uint8Array` over a
  // possibly-SharedArrayBuffer is not a valid `BlobPart`). One copy per click.
  return raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw as ArrayBuffer);
}

/**
 * Downloads `sheets` as a .xlsx workbook. Browser-only: callers should guard with
 * isPlatformBrowser, but this also no-ops when `document` is unavailable.
 *
 * The `canDownload()` check comes BEFORE the dynamic import, so SSR never pulls a
 * ~1 MB spreadsheet writer into the server process just to discard the result — the
 * same caution `downloadCsv`/`downloadJson` apply, one step earlier because here the
 * work is expensive.
 */
export async function downloadXlsx(filename: string, sheets: readonly XlsxSheet[]): Promise<void> {
  if (!canDownload()) return;
  triggerDownload(filename, await buildXlsx(sheets), XLSX_MIME);
}
