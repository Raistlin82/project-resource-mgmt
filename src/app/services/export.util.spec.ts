import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inflateRawSync } from 'node:zlib';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  escapeCsv,
  toCsv,
  toJson,
  CsvColumn,
  buildXlsx,
  downloadXlsx,
  xlsxNum,
  xlsxSheet,
  XlsxColumn,
  XlsxSheet,
} from './export.util';


/**
 * exceljs arrives through a dynamic `import()` inside `buildXlsx`, and the FIRST
 * call in a worker pays the entire module load — 5.5 to 9.4 seconds on this
 * machine, against Vitest's 5000 ms default. Whichever `buildXlsx` test happened
 * to run first therefore flaked, and the one that usually drew the short straw
 * was the formula-injection assertion: the single worst test in this file to
 * teach anyone to ignore, because it is the safety property of the export.
 *
 * Paying the load once here, outside any test's budget, is the honest fix. Raising
 * each test's timeout instead would have hidden WHY they were slow and left every
 * future `buildXlsx` test to rediscover it.
 */
beforeAll(async () => {
  await buildXlsx([]);
}, 60_000);

describe('export.util — escapeCsv', () => {
  it('passes through a plain value unchanged', () => {
    expect(escapeCsv('hello')).toBe('hello');
    expect(escapeCsv(42)).toBe('42');
    expect(escapeCsv(0)).toBe('0');
  });

  it('renders null and undefined as empty string', () => {
    expect(escapeCsv(null)).toBe('');
    expect(escapeCsv(undefined)).toBe('');
  });

  it('prefixes a single quote to neutralise formula-injection triggers', () => {
    expect(escapeCsv('=1+1')).toBe("'=1+1");
    expect(escapeCsv('+SUM(A1)')).toBe("'+SUM(A1)");
    // A leading '-' followed by anything non-numeric IS dangerous and stays prefixed.
    // (This case used to be `escapeCsv('-2') === "'-2"`, which was the defect: every
    // money column pre-formats with .toFixed(), so a real negative amount arrived here
    // as a STRING and was turned into a text label. See the numeric-cell test below.)
    expect(escapeCsv('-1+1')).toBe("'-1+1");
    expect(escapeCsv('-A1')).toBe("'-A1");
    expect(escapeCsv('@cmd')).toBe("'@cmd");
    expect(escapeCsv('\tTAB')).toBe("'\tTAB");
    // A leading CR triggers the formula prefix AND forces RFC-4180 quoting (CR is a quote-trigger).
    expect(escapeCsv('\rCR')).toBe('"\'\rCR"');
  });

  it('emits a fully numeric STRING cell verbatim, whatever its JS type', () => {
    // THE DEFECT. The exemption above was typeof-based, but every money column in the
    // app pre-formats with .toFixed(), which returns a string: reporting.ts's VAC,
    // margin, marginPct, PCP delta and gap columns, and billing.ts's amount (negative
    // for every CreditNote). So `-12160` was emitted verbatim while
    // `(-12160).toFixed(2)` became "'-12160.00" — a text label. =SUM over the column
    // then skipped exactly the overrunning rows the export exists to surface.
    expect(escapeCsv((-12160).toFixed(2))).toBe('-12160.00');
    expect(escapeCsv((-3.5).toFixed(1))).toBe('-3.5');
    expect(escapeCsv('-2')).toBe('-2');
    expect(escapeCsv('+7')).toBe('+7');
    expect(escapeCsv('-.5')).toBe('-.5');
    // Percentages are pre-formatted the same way (marginPct, gapPts).
    expect(escapeCsv('-12.34%')).toBe('-12.34%');
  });

  it('still refuses anything that only LOOKS numeric', () => {
    // ASSERTION OF ABSENCE: the guard must not be deletable to make the test above
    // green. These are the shapes an attacker actually uses, and every one of them
    // starts with a trigger character while failing the numeric test.
    expect(escapeCsv('=1+1')).toBe("'=1+1");
    expect(escapeCsv('-1+1')).toBe("'-1+1");
    expect(escapeCsv('-1-2')).toBe("'-1-2");
    expect(escapeCsv('+1e9')).toBe("'+1e9");
    expect(escapeCsv('-12160.00.00')).toBe("'-12160.00.00");
    expect(escapeCsv('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('emits finite numbers verbatim — never as injection-prefixed text', () => {
    // A negative number is a value, not a formula: it must stay numeric so spreadsheet
    // SUM/aggregation keeps working on margin/VAC/gap/credit-note columns.
    expect(escapeCsv(-2)).toBe('-2');
    expect(escapeCsv(-1500.5)).toBe('-1500.5');
    expect(escapeCsv(0)).toBe('0');
    expect(escapeCsv(42)).toBe('42');
    // Non-finite numbers fall through to the string path (String(NaN) === 'NaN', etc.).
    expect(escapeCsv(NaN)).toBe('NaN');
    expect(escapeCsv(Infinity)).toBe('Infinity');
  });

  it('quotes and prefixes a dangerous value that also needs quoting', () => {
    // Leading '=' triggers the quote prefix; the embedded comma forces RFC-4180 quoting.
    expect(escapeCsv('=1,2')).toBe('"\'=1,2"');
  });

  it('wraps values containing a comma in double quotes', () => {
    expect(escapeCsv('a,b')).toBe('"a,b"');
  });

  it('doubles embedded double-quotes and wraps the field', () => {
    expect(escapeCsv('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('wraps values containing newlines', () => {
    expect(escapeCsv('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsv('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('does not treat an internal trigger char as a formula', () => {
    expect(escapeCsv('a=b')).toBe('a=b');
  });
});

interface Row {
  id: string;
  name: string;
  amount: number;
}

describe('export.util — toCsv', () => {
  const rows: Row[] = [
    { id: 'P1', name: 'Alpha', amount: 1000 },
    { id: 'P2', name: 'Beta, Inc', amount: 2500 },
  ];

  it('emits a header row from the column headers', () => {
    const cols: CsvColumn<Row>[] = [
      { key: 'id', header: 'ID' },
      { key: 'name', header: 'Name' },
    ];
    const csv = toCsv(rows, cols);
    expect(csv.split('\r\n')[0]).toBe('ID,Name');
  });

  it('reads cells by key and joins rows with CRLF', () => {
    const cols: CsvColumn<Row>[] = [
      { key: 'id', header: 'ID' },
      { key: 'amount', header: 'Amount' },
    ];
    const csv = toCsv(rows, cols);
    expect(csv).toBe(['ID,Amount', 'P1,1000', 'P2,2500'].join('\r\n'));
  });

  it('applies the map function when provided', () => {
    const cols: CsvColumn<Row>[] = [
      { key: 'name', header: 'Name' },
      { key: 'amount', header: 'EUR', map: (r) => `EUR ${r.amount.toFixed(2)}` },
    ];
    const csv = toCsv(rows, cols);
    const dataLines = csv.split('\r\n').slice(1);
    expect(dataLines[0]).toBe('Alpha,EUR 1000.00');
    expect(dataLines[1]).toBe('"Beta, Inc",EUR 2500.00');
  });

  it('escapes every cell, including headers and mapped values', () => {
    const cols: CsvColumn<Row>[] = [
      { key: 'name', header: 'Display, Name' },
      { key: 'id', header: 'Formula', map: () => '=HYPERLINK("x")' },
    ];
    const csv = toCsv([rows[0]], cols);
    const [header, dataLine] = csv.split('\r\n');
    expect(header).toBe('"Display, Name",Formula');
    // map output starts with '=' -> single-quote prefix, then quoted because it has a comma + quotes
    expect(dataLine).toBe('Alpha,"\'=HYPERLINK(""x"")"');
  });

  it('handles missing keys as empty cells and an empty row list', () => {
    const cols: CsvColumn<Row>[] = [{ key: 'missing', header: 'Missing' }];
    expect(toCsv([], cols)).toBe('Missing');
    expect(toCsv(rows, cols)).toBe(['Missing', '', ''].join('\r\n'));
  });
});

describe('export.util — toJson', () => {
  it('pretty-prints with 2-space indentation', () => {
    expect(toJson({ a: 1, b: [2, 3] })).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/**
 * A .xlsx IS a zip of XML parts, and the whole point of the security assertion below
 * is to read what was actually WRITTEN — the `t=` attribute and the absence of an
 * `<f>` element — rather than to ask the writing library to describe its own output.
 * So: a ~30-line central-directory reader over the produced bytes, with no dependency
 * of its own (`node:zlib` only). Central directory rather than local headers because
 * the local ones may defer their sizes to a data descriptor.
 */
function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | b[o + 3] * 0x1000000) >>> 0;
}

function unzipEntries(zip: Uint8Array): Map<string, string> {
  const dec = new TextDecoder();
  const out = new Map<string, string>();
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = u16(zip, eocd + 10);
  let p = u32(zip, eocd + 16);
  for (let n = 0; n < count; n++) {
    if (u32(zip, p) !== 0x02014b50) throw new Error(`corrupt central directory at ${p}`);
    const method = u16(zip, p + 10);
    const compSize = u32(zip, p + 20);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const localOff = u32(zip, p + 42);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    const dataStart = localOff + 30 + u16(zip, localOff + 26) + u16(zip, localOff + 28);
    const raw = zip.subarray(dataStart, dataStart + compSize);
    out.set(name, dec.decode(method === 0 ? raw : inflateRawSync(raw)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The `<c r="A2" …>…</c>` element for one cell, straight out of the sheet XML. */
function cellXml(sheetXml: string, ref: string): string {
  const m = new RegExp(`<c r="${ref}"[^>]*(?:/>|>.*?</c>)`).exec(sheetXml);
  if (m === null) throw new Error(`no cell ${ref} in sheet XML`);
  return m[0];
}

/** ExcelJS `ValueType` members this suite asserts on (from the library's own enum). */
const VT_NUMBER = 2;
const VT_STRING = 3;

/** Re-open produced bytes with ExcelJS, to assert typed values and number formats. */
async function readBack(bytes: Uint8Array): Promise<import('exceljs').Workbook> {
  const mod = (await import('exceljs')) as typeof import('exceljs') & { default?: typeof import('exceljs') };
  const ExcelJS = mod.default ?? mod;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

interface XRow {
  label: string;
  amount: number;
}

const xCols: XlsxColumn<XRow>[] = [
  { header: 'Label', value: (r) => r.label, width: 20 },
  { header: 'Amount', value: (r) => xlsxNum(r.amount), numFmt: '#,##0.00' },
];

describe('export.util — xlsxNum', () => {
  it('rounds to 2 decimals by default and stays a NUMBER', () => {
    // The project-wide ≤2-decimal rule applies to exports too. `.toFixed(2)` would
    // satisfy the eye and break the arithmetic, so the value is rounded, not stringified.
    // (Rounding is Math.round(v*100)/100 — the same technique `capacity.component.ts`'s
    // `round2` uses. Exact-half cases such as 1.005 are not representable in binary and
    // resolve by whichever side the stored double actually falls on; the values here are
    // deliberately unambiguous.)
    expect(xlsxNum(0.13232954545454542)).toBe(0.13);
    expect(xlsxNum(-12160.567)).toBe(-12160.57);
    expect(xlsxNum(1.006)).toBe(1.01);
    expect(typeof xlsxNum(1 / 3)).toBe('number');
  });

  it('honours an explicit decimal count', () => {
    expect(xlsxNum(1.23456, 0)).toBe(1);
    expect(xlsxNum(1.23456, 4)).toBe(1.2346);
  });

  it('empties the cell for absent and non-finite input — never the text NaN', () => {
    // ASSERTION OF ABSENCE. A 0/0 percentage must not land in the sheet as the string
    // 'NaN': one text cell poisons =SUM/AVERAGE over the whole column.
    expect(xlsxNum(null)).toBeNull();
    expect(xlsxNum(undefined)).toBeNull();
    expect(xlsxNum(NaN)).toBeNull();
    expect(xlsxNum(Infinity)).toBeNull();
    expect(xlsxNum(-Infinity)).toBeNull();
  });
});

describe('export.util — xlsxSheet', () => {
  it('builds the header, rows, widths and formats from the column descriptors', () => {
    const sheet = xlsxSheet('S', [{ label: 'a', amount: 1.006 }], xCols);
    expect(sheet.header).toEqual(['Label', 'Amount']);
    expect(sheet.rows).toEqual([['a', 1.01]]);
    expect(sheet.widths).toEqual([20, undefined]);
    expect(sheet.numFmts).toEqual([undefined, '#,##0.00']);
  });

  it('yields a header-only sheet for an empty row list', () => {
    // ASSERTION OF ABSENCE: no phantom row is invented for an empty dataset.
    const sheet = xlsxSheet('S', [], xCols);
    expect(sheet.header).toEqual(['Label', 'Amount']);
    expect(sheet.rows).toEqual([]);
  });
});

describe('export.util — buildXlsx: cell typing (formula-injection)', () => {
  it('writes a =SUM(A1) cell as a STRING, not a formula — asserted on the file itself', async () => {
    const bytes = await buildXlsx([
      xlsxSheet('Sheet One', [{ label: '=SUM(A1)', amount: -12160.005 }], xCols),
    ]);
    const parts = unzipEntries(bytes);
    const sheetXml = parts.get('xl/worksheets/sheet1.xml') ?? '';
    const shared = parts.get('xl/sharedStrings.xml') ?? '';

    // 1. The cell is TYPED as a string in the XML (`t="s"` = shared string)...
    expect(cellXml(sheetXml, 'A2')).toContain('t="s"');
    // 2. ...it is not a formula: no <f> element, in this cell or anywhere in the sheet.
    expect(cellXml(sheetXml, 'A2')).not.toContain('<f>');
    expect(sheetXml).not.toContain('<f>');
    // 3. The text stored is the value VERBATIM — the CSV apostrophe hack is
    //    deliberately NOT carried over (in xlsx it would be a literal stray char,
    //    corrupting the value to guard against a risk the type channel already kills).
    expect(shared).toContain('<t>=SUM(A1)</t>');
    expect(shared).not.toContain(`<t>'=SUM(A1)</t>`);

    // 4. And the same conclusion from a reader: String, no formula, value intact.
    const wb = await readBack(bytes);
    const cell = wb.getWorksheet('Sheet One')!.getCell('A2');
    expect(cell.type).toBe(VT_STRING);
    expect(cell.formula).toBeUndefined();
    expect(cell.value).toBe('=SUM(A1)');
  });

  it('writes a numeric cell as a NUMBER, with no string type attribute', async () => {
    // THE OTHER HALF. Typing every cell as a string would make the test above pass
    // while silently turning every money column into text: this is the assertion that
    // catches it.
    const bytes = await buildXlsx([xlsxSheet('S', [{ label: 'x', amount: -12160.567 }], xCols)]);
    const sheetXml = unzipEntries(bytes).get('xl/worksheets/sheet1.xml') ?? '';
    expect(cellXml(sheetXml, 'B2')).not.toContain('t="s"');
    expect(cellXml(sheetXml, 'B2')).toContain('<v>-12160.57</v>');

    const cell = (await readBack(bytes)).getWorksheet('S')!.getCell('B2');
    expect(cell.type).toBe(VT_NUMBER);
    expect(cell.value).toBe(-12160.57);
    expect(cell.numFmt).toBe('#,##0.00');
  });

  it('leaves a text cell in a formatted column unformatted', async () => {
    // A number format on a string cell is meaningless; assert it is not applied.
    const cols: XlsxColumn<{ v: string | number }>[] = [
      { header: 'Mixed', value: (r) => r.v, numFmt: '#,##0.00' },
    ];
    const bytes = await buildXlsx([xlsxSheet('S', [{ v: 5 }, { v: '—' }], cols)]);
    const ws = (await readBack(bytes)).getWorksheet('S')!;
    expect(ws.getCell('A2').numFmt).toBe('#,##0.00');
    expect(ws.getCell('A3').numFmt).toBeUndefined();
  });

  it('empties a cell for null/undefined instead of writing "null"', async () => {
    const cols: XlsxColumn<{ v: number | null | undefined }>[] = [{ header: 'V', value: (r) => r.v }];
    const bytes = await buildXlsx([xlsxSheet('S', [{ v: null }, { v: undefined }, { v: 7 }], cols)]);
    const ws = (await readBack(bytes)).getWorksheet('S')!;
    expect(ws.getCell('A2').value).toBeNull();
    expect(ws.getCell('A3').value).toBeNull();
    expect(ws.getCell('A4').value).toBe(7);
  });
});

describe('export.util — buildXlsx: sheets', () => {
  const sheetOf = (name: string, label: string): XlsxSheet =>
    xlsxSheet(name, [{ label, amount: 1 }], xCols);

  it('writes exactly the sheets it is given, in order, and each with its OWN rows', async () => {
    const wb = await readBack(
      await buildXlsx([sheetOf('Alpha', 'a-row'), sheetOf('Beta', 'b-row'), sheetOf('Gamma', 'g-row')]),
    );
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
    // Never assert on tab names alone: a generator that writes three sheets of
    // headers and no data would pass that. Read a cell out of each.
    expect(wb.getWorksheet('Alpha')!.getCell('A2').value).toBe('a-row');
    expect(wb.getWorksheet('Beta')!.getCell('A2').value).toBe('b-row');
    expect(wb.getWorksheet('Gamma')!.getCell('A2').value).toBe('g-row');
  });

  it('writes ONE sheet for a one-sheet workbook — it never pads to a fixed count', async () => {
    // ASSERTION OF ABSENCE, and the one that matters for the multi-sheet reports: a
    // builder that always emits N sheets (some of them empty) must not pass.
    const wb = await readBack(await buildXlsx([sheetOf('Only', 'only-row')]));
    expect(wb.worksheets).toHaveLength(1);
    expect(wb.worksheets[0].name).toBe('Only');
  });

  it('writes a header-only sheet with NO data rows', async () => {
    // ASSERTION OF ABSENCE: an empty dataset yields an empty (but declared) sheet.
    const wb = await readBack(await buildXlsx([xlsxSheet('Empty', [] as XRow[], xCols)]));
    const ws = wb.getWorksheet('Empty')!;
    expect(ws.getCell('A1').value).toBe('Label');
    expect(ws.getCell('A2').value).toBeNull();
    expect(ws.actualRowCount).toBe(1);
  });

  it('sanitises a tab name Excel would reject, and truncates at 31 characters', async () => {
    const wb = await readBack(
      await buildXlsx([xlsxSheet('Allocazione: A/B [x]?', [] as XRow[], xCols), xlsxSheet('x'.repeat(40), [] as XRow[], xCols)]),
    );
    expect(wb.worksheets[0].name).toBe('Allocazione- A-B -x--');
    expect(wb.worksheets[1].name).toBe('x'.repeat(31));
  });

  it('keeps two names that collide only after truncation DISTINCT', async () => {
    // ASSERTION OF ABSENCE: neither sheet may be dropped or silently overwritten.
    const long = 'Allocazione - Dettaglio per com';
    const wb = await readBack(
      await buildXlsx([
        xlsxSheet(`${long}messa`, [{ label: 'first', amount: 1 }], xCols),
        xlsxSheet(`${long}petenza`, [{ label: 'second', amount: 2 }], xCols),
      ]),
    );
    expect(wb.worksheets).toHaveLength(2);
    expect(wb.worksheets[0].name).not.toBe(wb.worksheets[1].name);
    expect(wb.getWorksheet(wb.worksheets[0].name)!.getCell('A2').value).toBe('first');
    expect(wb.getWorksheet(wb.worksheets[1].name)!.getCell('A2').value).toBe('second');
  });

  it('produces a real zip whose parts are the xlsx skeleton', async () => {
    const parts = unzipEntries(await buildXlsx([sheetOf('S', 'r')]));
    expect([...parts.keys()]).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']));
  });
});

describe('export.util — downloadXlsx (SSR safety)', () => {
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;

  afterEach(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    vi.restoreAllMocks();
  });

  it('no-ops when the DOM download primitives are absent', async () => {
    // Reproduce the SSR condition `canDownload()` actually tests — no usable
    // URL.createObjectURL — and require downloadXlsx to resolve quietly without
    // touching the document. (The server has no `document` or `Blob` either; this is
    // the one arm of the same guard that a jsdom test can remove.)
    URL.createObjectURL = undefined as unknown as typeof URL.createObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click');
    const append = vi.spyOn(document.body, 'appendChild');
    await expect(downloadXlsx('x.xlsx', [xlsxSheet('S', [{ label: 'a', amount: 1 }], xCols)])).resolves.toBeUndefined();
    expect(click).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('clicks an anchor carrying the filename and the xlsx MIME type when it can', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = ((b: Blob) => {
      blobs.push(b);
      return 'blob:stub';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });

    await downloadXlsx('Allocazione.xlsx', [xlsxSheet('S', [{ label: 'a', amount: 1 }], xCols)]);

    expect(downloads).toEqual(['Allocazione.xlsx']);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(blobs[0].size).toBeGreaterThan(0);
  });
});

// =============================================================================
// The warm-up above is a protection a future edit can silently remove: delete it,
// or add a THIRD spec file that calls buildXlsx without one, and the flake comes
// back with nothing to notice. So the convention is scanned, not trusted.
//
// This is the absence assertion for the fix itself. Every other test in these two
// files would stay green while the exposure quietly returned.
// =============================================================================
describe('every spec that builds a workbook pays the exceljs load up front', () => {
  const SERVICES_DIR = resolve(__dirname);

  /** Spec files in this directory that actually CALL buildXlsx (not just mention it). */
  function specsCallingBuildXlsx(): string[] {
    return readdirSync(SERVICES_DIR)
      .filter(f => f.endsWith('.spec.ts'))
      .filter(f => /\bbuildXlsx\s*\(/.test(readFileSync(resolve(SERVICES_DIR, f), 'utf8')));
  }

  it('finds the callers it is meant to guard — the scan is not vacuously empty', () => {
    // Without this, a broken glob would make the guard below pass over zero files.
    const callers = specsCallingBuildXlsx();
    expect(callers).toContain('export.util.spec.ts');
    expect(callers).toContain('rpt-xlsx.util.spec.ts');
  });

  it('every one of them warms the module before its first test', () => {
    const missing = specsCallingBuildXlsx().filter(f => {
      const src = readFileSync(resolve(SERVICES_DIR, f), 'utf8');
      // A beforeAll that calls buildXlsx, with an explicit timeout: the default
      // 5000ms would make the warm-up itself the thing that times out.
      return !/beforeAll\(\s*async[\s\S]{0,200}?buildXlsx\([\s\S]{0,80}?\}\s*,\s*\d/.test(src);
    });
    expect(missing,
      'these specs call buildXlsx with no warm-up, so whichever of their tests runs first pays the 5-9s module load'
    ).toStrictEqual([]);
  });
});
