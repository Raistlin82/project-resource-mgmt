/**
 * FatturaPA e-invoice adapter (integration kind: 'einvoice').
 *
 * Generates a simplified Italian FatturaElettronica v1.2 XML document
 * (FormatoTrasmissione FPR12 — fattura verso privati) as a LOCAL ARTIFACT.
 *
 * DESIGN PRINCIPLE: this adapter is deliberately NOT connected to any external
 * system. No SDI transmission, no network calls, no credentials, no SDKs. It is
 * a pure builder: plain entity data in, `{ filename, mimeType, content }` out.
 * The descriptor advertises this via `connected: false` / `mode: 'local-artifact'`.
 *
 * Shared types: the integration contracts (`IntegrationDescriptor`,
 * `ExportArtifact`, `SupplierInfo`, `EInvoiceBuildInput`, `EInvoiceAdapter`)
 * are consolidated in `./types` and re-exported here so existing importers
 * (incl. the spec) keep working.
 */

import type { Contract, Order, OrderLine } from '../../app/services/api.service';
import type {
  EInvoiceAdapter,
  EInvoiceBuildInput,
  ExportArtifact,
  IntegrationDescriptor,
} from './types';

export type {
  EInvoiceAdapter,
  EInvoiceBuildInput,
  ExportArtifact,
  IntegrationDescriptor,
  SupplierInfo,
} from './types';

export type EInvoiceErrorCode = 'MISSING_INVOICE_NUMBER' | 'MISSING_SUPPLIER_VAT';

/** Typed validation error thrown by {@link FatturaPaAdapter.buildInvoiceXml}. */
export class EInvoiceValidationError extends Error {
  constructor(
    readonly code: EInvoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EInvoiceValidationError';
  }
}

// --------------------------------------------------------------------------
// Helpers (pure, exported where useful for tests)
// --------------------------------------------------------------------------

/**
 * Escape a string for use as XML text/attribute content.
 * Order matters: '&' must be escaped first.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Round to 2 decimals (half away from zero for the positive amounts used here). */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Format a monetary amount the FatturaPA way: 2-decimal, dot separator. */
function money(n: number): string {
  return round2(n).toFixed(2);
}

/** Standard Italian VAT rate applied by this simplified adapter. */
export const FATTURAPA_VAT_RATE_PCT = 22;

/** Placeholder partita IVA used when the counterparty VAT number is unknown. */
export const PLACEHOLDER_VAT = '00000000000';

/** Default SDI recipient code when none is configured ('codice destinatario'). */
const DEFAULT_CODICE_DESTINATARIO = '0000000';

/** Customer.country is free-form; only pass it through when it is already an ISO alpha-2 code. */
function countryCode(raw: string | undefined, fallback: string): string {
  return raw !== undefined && /^[A-Z]{2}$/.test(raw) ? raw : fallback;
}

/** Keep artifact filenames filesystem-safe. */
function sanitizeForFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

interface NormalizedLine {
  description: string;
  amount: number;
}

/**
 * Normalize order lines for the invoice body.
 *
 * FALLBACK (documented behaviour): when `lines` is empty, a single synthetic
 * line is produced from the order itself. `Order` has no `description` field
 * in the domain model, so the synthetic description is derived from the
 * contract name (when available) and the order id; the amount is
 * `order.amount`.
 */
function normalizeLines(order: Order, contract: Contract | undefined, lines: readonly OrderLine[]): NormalizedLine[] {
  if (lines.length > 0) {
    return lines.map((l) => ({ description: l.description, amount: l.amount }));
  }
  const description = contract !== undefined ? `${contract.name} - order ${order.id}` : `Order ${order.id}`;
  return [{ description, amount: order.amount }];
}

/** Deterministic 5-char ProgressivoInvio derived from the invoice number digits. */
function progressivoInvio(invoiceNumber: string): string {
  const digits = invoiceNumber.replace(/\D/g, '');
  return (digits.length > 0 ? digits.slice(-5) : '1').padStart(5, '0');
}

// --------------------------------------------------------------------------
// Adapter implementation
// --------------------------------------------------------------------------

/**
 * The single concrete implementation of {@link EInvoiceAdapter}.
 *
 * Produces a well-formed, simplified `FatturaElettronica` FPR12 document:
 * - Header: DatiTrasmissione, CedentePrestatore (supplier), CessionarioCommittente
 *   (customer, with placeholder VAT — the `Customer` entity carries none).
 * - Body: DatiGeneraliDocumento (TD01, Divisa, Data, Numero, ImportoTotaleDocumento),
 *   DettaglioLinee, DatiRiepilogo at a flat 22.00% AliquotaIVA.
 *
 * Totals: ImponibileImporto = rounded sum of line amounts; Imposta = 22% of the
 * imponibile, rounded to 2 decimals; ImportoTotaleDocumento = imponibile + imposta.
 */
export class FatturaPaAdapter implements EInvoiceAdapter {
  describe(): IntegrationDescriptor {
    return {
      kind: 'einvoice',
      key: 'fatturapa',
      name: 'FatturaPA e-invoice (FPR12)',
      description:
        'Generates a simplified Italian FatturaElettronica v1.2 XML (formato FPR12) for an invoiced order ' +
        'as a downloadable local artifact. Not connected to SDI: no transmission, no credentials, no network.',
      connected: false,
      mode: 'local-artifact',
    };
  }

  buildInvoiceXml(input: EInvoiceBuildInput): ExportArtifact {
    const { order, customer, contract, lines, supplier } = input;

    if (order.invoiceNumber === undefined || order.invoiceNumber.trim() === '') {
      throw new EInvoiceValidationError(
        'MISSING_INVOICE_NUMBER',
        `Order ${order.id} has no invoice number: only invoiced orders can be exported as FatturaPA.`,
      );
    }
    if (supplier.vatNumber.trim() === '') {
      throw new EInvoiceValidationError(
        'MISSING_SUPPLIER_VAT',
        'Supplier VAT number (partita IVA) is required to build a FatturaPA document.',
      );
    }

    const invoiceNumber = order.invoiceNumber.trim();
    const invoiceDate = order.invoiceDate ?? order.orderDate;
    const supplierCountry = countryCode(supplier.country, 'IT');
    const customerCountry = countryCode(customer.country, 'IT');
    const codiceDestinatario = supplier.codiceDestinatario ?? DEFAULT_CODICE_DESTINATARIO;

    const normalized = normalizeLines(order, contract, lines);
    const imponibile = round2(normalized.reduce((sum, l) => sum + l.amount, 0));
    const imposta = round2(imponibile * (FATTURAPA_VAT_RATE_PCT / 100));
    const importoTotale = round2(imponibile + imposta);
    const aliquota = FATTURAPA_VAT_RATE_PCT.toFixed(2);

    const dettaglioLinee = normalized
      .map((line, i) =>
        [
          '      <DettaglioLinee>',
          `        <NumeroLinea>${i + 1}</NumeroLinea>`,
          `        <Descrizione>${escapeXml(line.description)}</Descrizione>`,
          `        <PrezzoTotale>${money(line.amount)}</PrezzoTotale>`,
          `        <AliquotaIVA>${aliquota}</AliquotaIVA>`,
          '      </DettaglioLinee>',
        ].join('\n'),
      )
      .join('\n');

    const causale = contract !== undefined ? `        <Causale>${escapeXml(contract.name)}</Causale>\n` : '';

    const content =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<p:FatturaElettronica versione="FPR12" ' +
      'xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">\n' +
      '  <FatturaElettronicaHeader>\n' +
      '    <DatiTrasmissione>\n' +
      '      <IdTrasmittente>\n' +
      `        <IdPaese>${escapeXml(supplierCountry)}</IdPaese>\n` +
      `        <IdCodice>${escapeXml(supplier.vatNumber)}</IdCodice>\n` +
      '      </IdTrasmittente>\n' +
      `      <ProgressivoInvio>${progressivoInvio(invoiceNumber)}</ProgressivoInvio>\n` +
      '      <FormatoTrasmissione>FPR12</FormatoTrasmissione>\n' +
      `      <CodiceDestinatario>${escapeXml(codiceDestinatario)}</CodiceDestinatario>\n` +
      '    </DatiTrasmissione>\n' +
      '    <CedentePrestatore>\n' +
      '      <DatiAnagrafici>\n' +
      '        <IdFiscaleIVA>\n' +
      `          <IdPaese>${escapeXml(supplierCountry)}</IdPaese>\n` +
      `          <IdCodice>${escapeXml(supplier.vatNumber)}</IdCodice>\n` +
      '        </IdFiscaleIVA>\n' +
      '        <Anagrafica>\n' +
      `          <Denominazione>${escapeXml(supplier.name)}</Denominazione>\n` +
      '        </Anagrafica>\n' +
      '        <RegimeFiscale>RF01</RegimeFiscale>\n' +
      '      </DatiAnagrafici>\n' +
      '      <Sede>\n' +
      `        <Indirizzo>${escapeXml(supplier.address)}</Indirizzo>\n` +
      `        <CAP>${escapeXml(supplier.zip)}</CAP>\n` +
      `        <Comune>${escapeXml(supplier.city)}</Comune>\n` +
      `        <Nazione>${escapeXml(supplierCountry)}</Nazione>\n` +
      '      </Sede>\n' +
      '    </CedentePrestatore>\n' +
      '    <CessionarioCommittente>\n' +
      '      <DatiAnagrafici>\n' +
      '        <IdFiscaleIVA>\n' +
      `          <IdPaese>${escapeXml(customerCountry)}</IdPaese>\n` +
      // The Customer entity carries no VAT number; a placeholder keeps the
      // document well-formed for local preview purposes (documented above).
      `          <IdCodice>${PLACEHOLDER_VAT}</IdCodice>\n` +
      '        </IdFiscaleIVA>\n' +
      '        <Anagrafica>\n' +
      `          <Denominazione>${escapeXml(customer.name)}</Denominazione>\n` +
      '        </Anagrafica>\n' +
      '      </DatiAnagrafici>\n' +
      '      <Sede>\n' +
      '        <Indirizzo>N/D</Indirizzo>\n' +
      '        <CAP>00000</CAP>\n' +
      `        <Comune>${escapeXml(customer.country ?? 'N/D')}</Comune>\n` +
      `        <Nazione>${escapeXml(customerCountry)}</Nazione>\n` +
      '      </Sede>\n' +
      '    </CessionarioCommittente>\n' +
      '  </FatturaElettronicaHeader>\n' +
      '  <FatturaElettronicaBody>\n' +
      '    <DatiGenerali>\n' +
      '      <DatiGeneraliDocumento>\n' +
      '        <TipoDocumento>TD01</TipoDocumento>\n' +
      `        <Divisa>${escapeXml(order.currency)}</Divisa>\n` +
      `        <Data>${escapeXml(invoiceDate)}</Data>\n` +
      `        <Numero>${escapeXml(invoiceNumber)}</Numero>\n` +
      causale +
      `        <ImportoTotaleDocumento>${money(importoTotale)}</ImportoTotaleDocumento>\n` +
      '      </DatiGeneraliDocumento>\n' +
      '    </DatiGenerali>\n' +
      '    <DatiBeniServizi>\n' +
      `${dettaglioLinee}\n` +
      '      <DatiRiepilogo>\n' +
      `        <AliquotaIVA>${aliquota}</AliquotaIVA>\n` +
      `        <ImponibileImporto>${money(imponibile)}</ImponibileImporto>\n` +
      `        <Imposta>${money(imposta)}</Imposta>\n` +
      '        <EsigibilitaIVA>I</EsigibilitaIVA>\n' +
      '      </DatiRiepilogo>\n' +
      '    </DatiBeniServizi>\n' +
      '  </FatturaElettronicaBody>\n' +
      '</p:FatturaElettronica>\n';

    return {
      filename: `${sanitizeForFilename(supplierCountry + supplier.vatNumber)}_${sanitizeForFilename(invoiceNumber)}.xml`,
      mimeType: 'application/xml',
      content,
    };
  }
}

/** Factory for the single concrete e-invoice adapter. */
export function createFatturaPaAdapter(): EInvoiceAdapter {
  return new FatturaPaAdapter();
}
