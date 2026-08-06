import {
  FatturaPaAdapter,
  createFatturaPaAdapter,
  EInvoiceValidationError,
  escapeXml,
  PLACEHOLDER_VAT,
  type EInvoiceErrorCode,
  type SupplierInfo,
} from './fatturapa.adapter';
import type { Contract, Customer, Order, OrderLine } from '../../app/services/api.service';

/**
 * Unit tests for the FatturaPA e-invoice adapter (local-artifact builder).
 *
 * Test-runner conventions match src/db/repository.spec.ts: vitest globals
 * (`describe`/`it`/`expect`) provided via tsconfig.spec.json
 * (`"types": ["vitest/globals"]`); no per-file imports of the runner.
 */

function makeSupplier(overrides: Partial<SupplierInfo> = {}): SupplierInfo {
  return {
    name: 'Key2 Consulting S.r.l.',
    vatNumber: '01234567890',
    address: 'Via Roma 1',
    city: 'Milano',
    zip: '20100',
    country: 'IT',
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return { id: 'cust-1', name: 'ACME S.p.A.', ...overrides };
}

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'ctr-1',
    customerId: 'cust-1',
    name: 'Framework 2026',
    type: 'T&M',
    totalValue: 100000,
    currency: 'EUR',
    status: 'Active',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    contractId: 'ctr-1',
    type: 'Customer',
    amount: 1000,
    currency: 'EUR',
    status: 'Invoiced',
    orderDate: '2026-05-01',
    invoiceNumber: 'INV-2026-0042',
    invoiceDate: '2026-06-01',
    ...overrides,
  };
}

function makeLine(id: string, description: string, amount: number): OrderLine {
  return { id, orderId: 'ord-1', projectId: 'prj-1', description, amount };
}

function build(overrides: {
  order?: Partial<Order>;
  customer?: Partial<Customer>;
  customerCountryCode?: string;
  contract?: Contract;
  lines?: OrderLine[];
  supplier?: Partial<SupplierInfo>;
} = {}): string {
  return new FatturaPaAdapter().buildInvoiceXml({
    order: makeOrder(overrides.order),
    customer: makeCustomer(overrides.customer),
    ...(overrides.customerCountryCode ? { customerCountryCode: overrides.customerCountryCode } : {}),
    ...(overrides.contract ? { contract: overrides.contract } : {}),
    lines: overrides.lines ?? [makeLine('l1', 'Consulting services', 1000)],
    supplier: makeSupplier(overrides.supplier),
  }).content;
}

/** Count opening tags (`<Tag ...>` or `<Tag>`) of a given element name. */
function countOpen(xml: string, tag: string): number {
  return (xml.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
}

/** Count closing tags (`</Tag>`) of a given element name. */
function countClose(xml: string, tag: string): number {
  return (xml.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
}

describe('escapeXml', () => {
  it('escapes the five XML special characters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  it('escapes the ampersand first (no double-escaping)', () => {
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain text untouched', () => {
    expect(escapeXml('Plain text 123')).toBe('Plain text 123');
  });
});

describe('FatturaPaAdapter.describe()', () => {
  it('self-describes as an unconnected local-artifact e-invoice adapter', () => {
    const d = new FatturaPaAdapter().describe();
    expect(d.kind).toBe('einvoice');
    expect(d.key).toBe('fatturapa');
    expect(d.connected).toBe(false);
    expect(d.mode).toBe('local-artifact');
    expect(d.name.length).toBeGreaterThan(0);
    expect(d.description.length).toBeGreaterThan(0);
  });

  it('factory returns an adapter with the same descriptor', () => {
    expect(createFatturaPaAdapter().describe()).toEqual(new FatturaPaAdapter().describe());
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — artifact shape', () => {
  it('returns an XML artifact with a filesystem-safe filename derived from VAT + invoice number', () => {
    const artifact = new FatturaPaAdapter().buildInvoiceXml({
      order: makeOrder(),
      customer: makeCustomer(),
      lines: [makeLine('l1', 'Consulting', 1000)],
      supplier: makeSupplier(),
    });
    expect(artifact.mimeType).toBe('application/xml');
    expect(artifact.filename).toBe('IT01234567890_INV-2026-0042.xml');
    expect(artifact.content.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it('sanitizes unsafe characters in the invoice number for the filename', () => {
    const artifact = new FatturaPaAdapter().buildInvoiceXml({
      order: makeOrder({ invoiceNumber: 'INV/2026 #7' }),
      customer: makeCustomer(),
      lines: [],
      supplier: makeSupplier(),
    });
    expect(artifact.filename).toBe('IT01234567890_INV_2026__7.xml');
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — structure', () => {
  it('produces balanced tags for all key elements', () => {
    const xml = build({
      contract: makeContract(),
      lines: [makeLine('l1', 'Phase 1', 600), makeLine('l2', 'Phase 2', 400)],
    });
    const keyTags = [
      'p:FatturaElettronica',
      'FatturaElettronicaHeader',
      'FatturaElettronicaBody',
      'DatiTrasmissione',
      'CedentePrestatore',
      'CessionarioCommittente',
      'DatiGenerali',
      'DatiGeneraliDocumento',
      'DatiBeniServizi',
      'DettaglioLinee',
      'DatiRiepilogo',
      'Denominazione',
      'IdFiscaleIVA',
      'Sede',
    ];
    for (const tag of keyTags) {
      const open = countOpen(xml, tag);
      const close = countClose(xml, tag);
      expect(open, `unbalanced <${tag}>`).toBe(close);
      expect(open, `missing <${tag}>`).toBeGreaterThan(0);
    }
  });

  it('declares versione FPR12 and FormatoTrasmissione FPR12 with TipoDocumento TD01', () => {
    const xml = build();
    expect(xml).toContain('versione="FPR12"');
    expect(xml).toContain('<FormatoTrasmissione>FPR12</FormatoTrasmissione>');
    expect(xml).toContain('<TipoDocumento>TD01</TipoDocumento>');
  });

  it('emits a credit note as TD04 with positive document amounts', () => {
    const xml = build({ order: { amount: -250 }, lines: [] });

    expect(xml).toContain('<TipoDocumento>TD04</TipoDocumento>');
    expect(xml).toContain('<PrezzoUnitario>250.00</PrezzoUnitario>');
    expect(xml).toContain('<PrezzoTotale>250.00</PrezzoTotale>');
    expect(xml).toContain('<ImponibileImporto>250.00</ImponibileImporto>');
    expect(xml).toContain('<ImportoTotaleDocumento>305.00</ImportoTotaleDocumento>');
    expect(xml).not.toContain('<PrezzoTotale>-250.00</PrezzoTotale>');
  });

  it('renders supplier as CedentePrestatore and customer as CessionarioCommittente', () => {
    const xml = build();
    const header = xml.slice(xml.indexOf('<CedentePrestatore>'), xml.indexOf('</CedentePrestatore>'));
    expect(header).toContain('<Denominazione>Key2 Consulting S.r.l.</Denominazione>');
    expect(header).toContain('<IdCodice>01234567890</IdCodice>');
    const cessionario = xml.slice(xml.indexOf('<CessionarioCommittente>'), xml.indexOf('</CessionarioCommittente>'));
    expect(cessionario).toContain('<Denominazione>ACME S.p.A.</Denominazione>');
  });

  it('uses the catalog ISO code and never writes a country name as the customer city', () => {
    const xml = build({ customer: { country: 'Germany' }, customerCountryCode: 'DE' });
    const cessionario = xml.slice(xml.indexOf('<CessionarioCommittente>'), xml.indexOf('</CessionarioCommittente>'));

    expect(cessionario).toContain('<IdPaese>DE</IdPaese>');
    expect(cessionario).toContain('<Nazione>DE</Nazione>');
    expect(cessionario).toContain('<Comune>N/D</Comune>');
    expect(cessionario).not.toContain('<Comune>Germany</Comune>');
  });

  it('uses a placeholder VAT for the customer (Customer entity carries no VAT number)', () => {
    const xml = build();
    const cessionario = xml.slice(xml.indexOf('<CessionarioCommittente>'), xml.indexOf('</CessionarioCommittente>'));
    expect(cessionario).toContain(`<IdCodice>${PLACEHOLDER_VAT}</IdCodice>`);
  });

  it('emits invoice number and invoice date in DatiGeneraliDocumento', () => {
    const xml = build();
    expect(xml).toContain('<Numero>INV-2026-0042</Numero>');
    expect(xml).toContain('<Data>2026-06-01</Data>');
  });

  it('includes the contract name as Causale when a contract is provided, omits it otherwise', () => {
    expect(build({ contract: makeContract() })).toContain('<Causale>Framework 2026</Causale>');
    expect(build()).not.toContain('<Causale>');
  });

  it('uses the default CodiceDestinatario 0000000 unless the supplier provides one', () => {
    expect(build()).toContain('<CodiceDestinatario>0000000</CodiceDestinatario>');
    expect(build({ supplier: { codiceDestinatario: 'ABC1234' } })).toContain(
      '<CodiceDestinatario>ABC1234</CodiceDestinatario>',
    );
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — XML escaping', () => {
  it('escapes ampersands and angle brackets in the customer name', () => {
    const xml = build({ customer: { name: 'R&D <Labs> & Co.' } });
    expect(xml).toContain('<Denominazione>R&amp;D &lt;Labs&gt; &amp; Co.</Denominazione>');
    expect(xml).not.toContain('<Labs>');
    expect(xml).not.toContain('R&D');
  });

  it('escapes quotes and special characters in line descriptions', () => {
    const xml = build({ lines: [makeLine('l1', `Dev "sprint" <Q2> & 'fixes'`, 1000)] });
    expect(xml).toContain('<Descrizione>Dev &quot;sprint&quot; &lt;Q2&gt; &amp; &apos;fixes&apos;</Descrizione>');
  });

  it('leaves no raw unescaped ampersand anywhere in the document', () => {
    const xml = build({
      customer: { name: 'A & B' },
      contract: makeContract({ name: 'M&A <advisory>' }),
      lines: [makeLine('l1', 'T&M hours', 1000)],
      supplier: { name: 'S&P <Consulting>' },
    });
    expect(/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml)).toBe(false);
  });
});

/**
 * NOTE on the fixtures below: every one sets `order.amount` to the sum of its
 * own lines. That is not decoration — `buildInvoiceXml` reconciles the two and
 * refuses ORDER_TOTAL_MISMATCH otherwise, so an order whose amount contradicts
 * its lines can no longer be exported at all. The assertions themselves
 * (Imponibile/Imposta/Totale numerals) are unchanged.
 */
describe('FatturaPaAdapter.buildInvoiceXml() — lines and totals math', () => {
  it('numbers DettaglioLinee sequentially with per-line PrezzoTotale', () => {
    const xml = build({
      order: { amount: 1100 },
      lines: [makeLine('l1', 'Phase 1', 600.5), makeLine('l2', 'Phase 2', 399.5), makeLine('l3', 'Expenses', 100)],
    });
    expect(countOpen(xml, 'DettaglioLinee')).toBe(3);
    expect(xml).toContain('<NumeroLinea>1</NumeroLinea>');
    expect(xml).toContain('<NumeroLinea>2</NumeroLinea>');
    expect(xml).toContain('<NumeroLinea>3</NumeroLinea>');
    expect(xml).toContain('<PrezzoTotale>600.50</PrezzoTotale>');
    expect(xml).toContain('<PrezzoTotale>399.50</PrezzoTotale>');
    expect(xml).toContain('<PrezzoTotale>100.00</PrezzoTotale>');
  });

  it('computes Imposta at 22% of the imponibile with 2-decimal rounding', () => {
    // imponibile = 600.50 + 399.50 + 100 = 1100.00; imposta = 242.00; total = 1342.00
    const xml = build({
      order: { amount: 1100 },
      lines: [makeLine('l1', 'Phase 1', 600.5), makeLine('l2', 'Phase 2', 399.5), makeLine('l3', 'Expenses', 100)],
    });
    expect(xml).toContain('<AliquotaIVA>22.00</AliquotaIVA>');
    expect(xml).toContain('<ImponibileImporto>1100.00</ImponibileImporto>');
    expect(xml).toContain('<Imposta>242.00</Imposta>');
    expect(xml).toContain('<ImportoTotaleDocumento>1342.00</ImportoTotaleDocumento>');
  });

  it('rounds Imposta to 2 decimals (150.01 -> 33.0022 -> 33.00)', () => {
    const xml = build({ order: { amount: 150.01 }, lines: [makeLine('l1', 'A', 100.005), makeLine('l2', 'B', 50.0)] });
    // sum = 150.005 -> imponibile rounds to 150.01 (round half up at 2 decimals)
    expect(xml).toContain('<ImponibileImporto>150.01</ImponibileImporto>');
    expect(xml).toContain('<Imposta>33.00</Imposta>');
    expect(xml).toContain('<ImportoTotaleDocumento>183.01</ImportoTotaleDocumento>');
  });

  it('rounds Imposta up when the third decimal is >= 5 (47.50 -> 10.45)', () => {
    const xml = build({ order: { amount: 47.5 }, lines: [makeLine('l1', 'A', 47.5)] });
    expect(xml).toContain('<ImponibileImporto>47.50</ImponibileImporto>');
    expect(xml).toContain('<Imposta>10.45</Imposta>');
    expect(xml).toContain('<ImportoTotaleDocumento>57.95</ImportoTotaleDocumento>');
  });

  it('handles floating-point sums cleanly (0.1 + 0.2)', () => {
    const xml = build({ order: { amount: 0.3 }, lines: [makeLine('l1', 'A', 0.1), makeLine('l2', 'B', 0.2)] });
    expect(xml).toContain('<ImponibileImporto>0.30</ImponibileImporto>');
    expect(xml).toContain('<Imposta>0.07</Imposta>'); // 0.066 -> 0.07
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — synthetic line fallback', () => {
  it('falls back to a single synthetic line from the order when lines is empty', () => {
    const xml = build({ order: { amount: 2500 }, lines: [] });
    expect(countOpen(xml, 'DettaglioLinee')).toBe(1);
    expect(xml).toContain('<NumeroLinea>1</NumeroLinea>');
    expect(xml).toContain('<Descrizione>Order ord-1</Descrizione>');
    expect(xml).toContain('<PrezzoTotale>2500.00</PrezzoTotale>');
    expect(xml).toContain('<ImponibileImporto>2500.00</ImponibileImporto>');
    expect(xml).toContain('<Imposta>550.00</Imposta>');
  });

  it('includes the contract name in the synthetic line description when available', () => {
    const xml = build({ order: { amount: 100 }, lines: [], contract: makeContract() });
    expect(xml).toContain('<Descrizione>Framework 2026 - order ord-1</Descrizione>');
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — validation', () => {
  it('rejects purchase orders and customer orders outside the issued lifecycle', () => {
    const ineligibleOrders: Partial<Order>[] = [
      { type: 'Purchase', status: 'Invoiced' },
      { type: 'Customer', status: 'Open' },
    ];

    for (const order of ineligibleOrders) {
      try {
        build({ order });
        expect.unreachable('expected buildInvoiceXml to reject an ineligible order');
      } catch (error) {
        expect(error).toBeInstanceOf(EInvoiceValidationError);
        expect((error as EInvoiceValidationError).code).toBe('INELIGIBLE_ORDER');
      }
    }
  });

  it('throws a typed error when the order has no invoice number', () => {
    const call = (): unknown => build({ order: { invoiceNumber: undefined, status: 'Open' } });
    expect(call).toThrowError(EInvoiceValidationError);
    try {
      call();
      expect.unreachable('expected buildInvoiceXml to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EInvoiceValidationError);
      expect((e as EInvoiceValidationError).code).toBe('MISSING_INVOICE_NUMBER');
    }
  });

  it('throws MISSING_INVOICE_NUMBER for a blank invoice number too', () => {
    expect(() => build({ order: { invoiceNumber: '   ' } })).toThrowError(EInvoiceValidationError);
  });

  it('throws a typed error when the supplier VAT number is blank', () => {
    try {
      build({ supplier: { vatNumber: '' } });
      expect.unreachable('expected buildInvoiceXml to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(EInvoiceValidationError);
      expect((e as EInvoiceValidationError).code).toBe('MISSING_SUPPLIER_VAT');
    }
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — reconciliation against the order (ORDER_TOTAL_MISMATCH)', () => {
  /** Run the builder and return the EInvoiceValidationError code it threw, or null. */
  function codeThrownBy(overrides: Parameters<typeof build>[0]): EInvoiceErrorCode | null {
    try {
      build(overrides);
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(EInvoiceValidationError);
      return (e as EInvoiceValidationError).code;
    }
  }

  /** The document total as EMITTED — the numeral, never the tag's presence. */
  function importoTotale(xml: string): string {
    return /<ImportoTotaleDocumento>([^<]*)<\/ImportoTotaleDocumento>/.exec(xml)?.[1] ?? '';
  }

  // --- the failure this closes -------------------------------------------------

  it('refuses to emit when a line added after issue pushes the lines above the order amount', () => {
    // Seed O1: issued for 200,000 EUR under INV-2026-0001. A 500,000 "Change
    // request" line is POSTed to the already-invoiced order; the lines then sum
    // to 700,000 and the adapter used to emit ImportoTotaleDocumento 854000.00
    // under the invoice number the customer already holds.
    expect(
      codeThrownBy({
        order: { amount: 200_000, invoiceNumber: 'INV-2026-0001' },
        lines: [makeLine('l1', 'Initial scope', 200_000), makeLine('l2', 'Change request', 500_000)],
      }),
    ).toBe('ORDER_TOTAL_MISMATCH');
  });

  it('refuses to emit when a line is edited DOWN after issue (the guard is symmetric)', () => {
    // PUT /order-lines/L9 {"amount": 1} on an issued 120,000 order. Under-billing
    // must be refused exactly like over-billing — a one-sided check would let the
    // customer be invoiced 1.00 EUR under an issued number.
    expect(
      codeThrownBy({ order: { amount: 120_000 }, lines: [makeLine('l1', 'Delivery', 1)] }),
    ).toBe('ORDER_TOTAL_MISMATCH');
  });

  it('refuses a divergence of a single cent (the tolerance is half a cent, not a slush fund)', () => {
    expect(
      codeThrownBy({ order: { amount: 200_000 }, lines: [makeLine('l1', 'Delivery', 200_000.01)] }),
    ).toBe('ORDER_TOTAL_MISMATCH');
  });

  it('names both figures in the message so the divergence is actionable', () => {
    try {
      build({ order: { amount: 200_000 }, lines: [makeLine('l1', 'Delivery', 700_000)] });
      expect.unreachable('expected buildInvoiceXml to refuse the mismatch');
    } catch (e) {
      const message = (e as EInvoiceValidationError).message;
      expect(message).toContain('200000.00');
      expect(message).toContain('700000.00');
      expect(message).toContain('INV-2026-0042');
    }
  });

  // --- the ABSENCE side: what must STILL be emitted ----------------------------
  //
  // A guard that always refused would pass every test above. These five cases
  // are the ones that must keep working, and each asserts the emitted total
  // NUMERAL — a tag-presence assertion would pass on a wrong total too.

  it('emits normally when the lines sum exactly to the order amount', () => {
    const xml = build({ order: { amount: 200_000 }, lines: [makeLine('l1', 'Delivery', 200_000)] });
    expect(importoTotale(xml)).toBe('244000.00'); // 200000 + 22%
  });

  it('emits normally for a multi-line order whose lines sum to the order amount', () => {
    const xml = build({
      order: { amount: 200_000 },
      lines: [makeLine('l1', 'Phase 1', 120_000), makeLine('l2', 'Phase 2', 80_000)],
    });
    expect(countOpen(xml, 'DettaglioLinee')).toBe(2);
    expect(importoTotale(xml)).toBe('244000.00');
  });

  it('keeps the documented empty-lines fallback working (it can never diverge)', () => {
    // The synthetic line IS order.amount, so reconciliation is a no-op here. This
    // is the case a naive "lines must exist" guard would have broken.
    const xml = build({ order: { amount: 200_000 }, lines: [] });
    expect(countOpen(xml, 'DettaglioLinee')).toBe(1);
    expect(importoTotale(xml)).toBe('244000.00');
  });

  it('emits a credit note whose negative amount matches its negative line (compared in absolute value)', () => {
    // TD04 carries a negative order.amount and positive line amounts, so a signed
    // comparison would have refused every credit note.
    const xml = build({ order: { amount: -1500 }, lines: [makeLine('l1', 'Credit for overbilling', -1500)] });
    expect(xml).toContain('<TipoDocumento>TD04</TipoDocumento>');
    expect(importoTotale(xml)).toBe('1830.00'); // 1500 + 22%
  });

  it('tolerates sub-cent float residue on the order amount (both sides are rounded to cents first)', () => {
    const xml = build({ order: { amount: 1000.0000000000002 }, lines: [makeLine('l1', 'Consulting', 1000)] });
    expect(importoTotale(xml)).toBe('1220.00');
  });

  // --- precedence --------------------------------------------------------------

  it('still reports the more fundamental failure first when the order is also ineligible', () => {
    // Reconciliation runs AFTER eligibility/invoice-number/VAT: a draft order with
    // mismatching lines is INELIGIBLE_ORDER, not ORDER_TOTAL_MISMATCH.
    expect(
      codeThrownBy({ order: { amount: 200_000, status: 'Open' }, lines: [makeLine('l1', 'x', 700_000)] }),
    ).toBe('INELIGIBLE_ORDER');
    expect(
      codeThrownBy({ order: { amount: 200_000, invoiceNumber: '  ' }, lines: [makeLine('l1', 'x', 700_000)] }),
    ).toBe('MISSING_INVOICE_NUMBER');
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — currency and dates', () => {
  it('propagates the order currency into Divisa', () => {
    expect(build({ order: { currency: 'USD' } })).toContain('<Divisa>USD</Divisa>');
    expect(build({ order: { currency: 'EUR' } })).toContain('<Divisa>EUR</Divisa>');
  });

  it('falls back to orderDate when invoiceDate is absent', () => {
    const xml = build({ order: { invoiceDate: undefined } });
    expect(xml).toContain('<Data>2026-05-01</Data>');
  });

  it('derives a 5-digit ProgressivoInvio from the invoice number digits', () => {
    expect(build({ order: { invoiceNumber: 'INV-2026-0042' } })).toContain(
      '<ProgressivoInvio>60042</ProgressivoInvio>',
    );
    expect(build({ order: { invoiceNumber: 'NO-DIGITS-X' } })).toContain('<ProgressivoInvio>00001</ProgressivoInvio>');
  });
});

describe('FatturaPaAdapter.buildInvoiceXml() — FPR12 schema-validity regressions', () => {
  it('emits Quantita and a PrezzoUnitario equal to PrezzoTotale on every line (PrezzoUnitario is mandatory in the FPR12 XSD)', () => {
    const xml = build({ lines: [makeLine('l1', 'Analysis', 600), makeLine('l2', 'Build', 400)] });
    expect(countOpen(xml, 'PrezzoUnitario')).toBe(2);
    expect(countOpen(xml, 'Quantita')).toBe(2);
    expect(xml).toContain('<Quantita>1.00</Quantita>');
    expect(xml).toContain('<PrezzoUnitario>600.00</PrezzoUnitario>');
    expect(xml).toContain('<PrezzoTotale>600.00</PrezzoTotale>');
    // XSD element order inside DettaglioLinee: Descrizione, Quantita, PrezzoUnitario, PrezzoTotale, AliquotaIVA.
    const first = (tag: string) => xml.indexOf(`<${tag}>`);
    expect(first('Descrizione')).toBeLessThan(first('Quantita'));
    expect(first('Quantita')).toBeLessThan(first('PrezzoUnitario'));
    expect(first('PrezzoUnitario')).toBeLessThan(first('PrezzoTotale'));
    expect(first('PrezzoTotale')).toBeLessThan(first('AliquotaIVA'));
  });

  it('keeps ImponibileImporto identical to the sum of the rendered PrezzoTotale values (no per-line rounding drift, SDI 00422)', () => {
    const lines = [1, 2, 3, 4, 5].map(n => makeLine(`l${n}`, `Item ${n}`, 10.125));
    // order.amount is 50.65, the sum of the ROUNDED lines — not the raw 50.625.
    // The reconciliation compares against the figure the document emits, which
    // is by construction the sum of the rendered PrezzoTotale values.
    const xml = build({ order: { amount: 50.65 }, lines });
    // Each 10.125 line renders as 10.13; the riepilogo must sum the ROUNDED amounts.
    expect((xml.match(/<PrezzoTotale>10\.13<\/PrezzoTotale>/g) ?? []).length).toBe(5);
    expect(xml).toContain('<ImponibileImporto>50.65</ImponibileImporto>');
    expect(xml).toContain('<Imposta>11.14</Imposta>');
    expect(xml).toContain('<ImportoTotaleDocumento>61.79</ImportoTotaleDocumento>');
  });

  it('normalises a full ISO timestamp invoiceDate to an xs:date for <Data>', () => {
    const xml = build({ order: { invoiceDate: '2026-06-01T10:30:00.000Z' } });
    expect(xml).toContain('<Data>2026-06-01</Data>');
  });
});
