/**
 * Pure, framework-free CSV/JSON export helpers.
 *
 * No Angular DI, no component state — just functions over plain data so they can be
 * unit-tested in isolation and called from any component (which is expected to guard
 * the browser-only download helpers with isPlatformBrowser). The download helpers also
 * defensively no-op when `document` is unavailable (SSR / non-browser).
 *
 * SECURITY: escapeCsv applies a CSV formula-injection guard. A cell whose first
 * character is one of = + - @ TAB CR is prefixed with a single quote so spreadsheet
 * apps (Excel, Sheets, LibreOffice) treat it as text rather than a formula.
 */

/** Characters that, when leading a cell, can trigger formula evaluation in spreadsheet apps. */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** Cells containing any of these must be wrapped in double quotes (with quotes doubled). */
const QUOTE_NEEDED = /[",\n\r]/;

/**
 * Escapes a single CSV cell.
 *
 * 1. Formula-injection guard: if the (stringified) value starts with `= + - @`, TAB, or
 *    CR, prefix a single quote so it renders as inert text. This applies only to
 *    strings — a finite number is never a spreadsheet formula, and prefixing it (e.g.
 *    a negative `-1500`) would corrupt it into a text label that breaks SUM/aggregation.
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

  if (s.length > 0 && FORMULA_TRIGGERS.has(s[0])) {
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
function triggerDownload(filename: string, content: string, mime: string): void {
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
