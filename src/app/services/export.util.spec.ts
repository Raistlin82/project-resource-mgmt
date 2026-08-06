import { escapeCsv, toCsv, toJson, CsvColumn } from './export.util';

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
