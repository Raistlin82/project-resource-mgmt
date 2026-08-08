import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of, throwError } from 'rxjs';
import { IntegrationsComponent } from './integrations.component';
import { ApiService, CrmOutboxEntry, IntegrationsInfo, Order } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

const INFO: IntegrationsInfo = {
  adapters: [
    { kind: 'erp', key: 'gl-csv', name: 'General Ledger Export', description: 'Balanced GL journal.', connected: false, mode: 'local-artifact' },
    { kind: 'einvoice', key: 'fatturapa-fpr12', name: 'FatturaPA e-invoice', description: 'FPR12 XML.', connected: false, mode: 'local-artifact' },
    { kind: 'crm', key: 'crm-outbox', name: 'CRM Sync Outbox', description: 'Prepared payloads.', connected: false, mode: 'local-artifact' },
    { kind: 'bi', key: 'bi-flat-json', name: 'BI Feed', description: 'Flat JSON dataset.', connected: false, mode: 'local-artifact' },
    { kind: 'inbound', key: 'declared-sources', name: 'DeclaredSources', description: 'Upstream masters; preview only.', connected: false, mode: 'local-artifact' },
    { kind: 'demand', key: 'servicenow-requester-portal', name: 'ServiceNowRequesterPortal', description: 'Hiring requisitions.', connected: false, mode: 'local-artifact' },
    { kind: 'email', key: 'local-mail-outbox', name: 'LocalMailOutbox', description: 'Notifications, never sent.', connected: false, mode: 'local-artifact' },
  ],
  active: {
    erp: 'gl-csv', einvoice: 'fatturapa-fpr12', crm: 'crm-outbox', bi: 'bi-flat-json',
    inbound: 'declared-sources', demand: 'servicenow-requester-portal', email: 'local-mail-outbox',
  },
};

/** The declared upstream landscape: two mapped, one declared only. */
const SOURCES = [
  { key: 'zucchetti', name: 'Zucchetti', owns: 'Resource master data', target: 'resources' as const, mappable: true, connected: false as const },
  { key: 'pcp', name: 'PCP', owns: 'Commessa master data', target: 'projects' as const, mappable: true, connected: false as const },
  { key: 'skill-matrix', name: 'Skill Matrix', owns: 'Assessed skills', target: 'skills' as const, mappable: false, connected: false as const },
];

/** One exportable customer invoice, so the e-invoice <select> has a real option. */
const ORDERS = [
  { id: 'O1', type: 'Customer', status: 'Invoiced', invoiceNumber: 'INV-2026-0001', amount: 12000, currency: 'EUR' },
] as unknown as Order[];

const OUTBOX = [
  { id: 'OB1', preparedAt: '2026-08-01T10:00:00.000Z', status: 'Prepared', payload: { accounts: [{}], deals: [{}, {}] } },
] as unknown as CrmOutboxEntry[];

function setup(overrides: {
  ready?: boolean;
  authenticated?: boolean;
  getIntegrations?: ReturnType<typeof vi.fn>;
  getOrders?: ReturnType<typeof vi.fn>;
  getCrmOutbox?: ReturnType<typeof vi.fn>;
  getInboundSources?: ReturnType<typeof vi.fn>;
} = {}) {
  const ready = overrides.ready ?? true;
  const getIntegrations = overrides.getIntegrations ?? vi.fn(() => of(INFO));
  const getOrders = overrides.getOrders ?? vi.fn(() => of(ORDERS));
  const getCrmOutbox = overrides.getCrmOutbox ?? vi.fn(() => of(OUTBOX));
  const getInboundSources = overrides.getInboundSources ?? vi.fn(() => of({ sources: SOURCES }));
  const apiStub = {
    getIntegrations,
    getOrders,
    getCrmOutbox,
    getInboundSources,
    prepareCrmSync: vi.fn(() => of(OUTBOX[0])),
    getBiFeedPreview: vi.fn(() => of({ generatedAt: '2026-08-01T10:00:00.000Z', rowCount: 0, rows: [] })),
    erpJournalExportUrl: vi.fn((f: string) => `/api/integrations/erp/journal.${f}`),
    einvoiceXmlUrl: vi.fn((id: string) => `/api/integrations/einvoice/${id}.xml`),
  } as unknown as ApiService;
  const authStub = {
    authReady: signal(ready),
    isAuthenticated: signal(overrides.authenticated ?? ready),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [IntegrationsComponent],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: { show: vi.fn(), error: vi.fn() } as unknown as NotificationService },
    ],
  });

  const fixture = TestBed.createComponent(IntegrationsComponent);
  return { fixture, getIntegrations, getOrders, getCrmOutbox };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function failing() {
  return vi.fn(() => throwError(() => new HttpErrorResponse({ status: 500, statusText: 'Server Error' })));
}

/** `ListStateComponent`'s error-panel heading for this screen's `label`. */
const LIST_STATE_ERROR = "Couldn't load integration adapters";
/** The role-denied wording of `accessNotice()`. */
const ROLE_NOTICE = 'Your role does not have access to the integration adapters';
/** The signed-out wording — must NOT fire for a signed-in actor. */
const SIGNIN_NOTICE = 'Sign in to view the integration adapters';
/**
 * Two "loaded fine, nothing here" sentences a failed read must never show. Both
 * are claims about the DATA, and a 403 is not an answer about the data.
 */
const EMPTY_ORDERS_COPY = 'No eligible customer invoices available.';
const EMPTY_OUTBOX_COPY = 'No prepared payloads yet.';

function retryButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find(b => /Retry/.test(b.textContent ?? ''));
}

describe('IntegrationsComponent — a failed read reaches an error panel and its Retry', () => {
  it('does not throw, and renders the notice plus Retry, when /integrations+/orders fails', async () => {
    // The live sequence: the first heading on the page evaluates
    // erpDescriptor() -> data() -> dataRes.value(), which THROWS while the
    // status is 'error'. Before the guard the second detectChanges() below threw
    // ResourceValueError and the page rendered nothing at all.
    const { fixture } = setup({ getIntegrations: failing() });

    fixture.detectChanges();
    await fixture.whenStable();
    expect(() => fixture.detectChanges()).not.toThrow();

    // Positive control: the read really did fail, so the case cannot pass by the
    // stub having quietly succeeded.
    expect(fixture.componentInstance['dataRes'].status()).toBe('error');

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain(LIST_STATE_ERROR);
    expect(retryButton(host)).toBeDefined();
    expect(host.textContent).toContain(ROLE_NOTICE);
    expect(host.textContent).not.toContain(SIGNIN_NOTICE);

    // WITHHELD IS NOT EMPTY: neither "nothing here" sentence may be stated about
    // a read that failed, and no download control may be offered for an artifact
    // built from data this page could not read.
    expect(host.textContent).not.toContain(EMPTY_ORDERS_COPY);
    expect(host.textContent).not.toContain(EMPTY_OUTBOX_COPY);
    expect([...host.querySelectorAll('button')].filter(b => /Download GL journal/.test(b.textContent ?? '')).length).toBe(0);
  });

  it('does not throw when only the CRM outbox fails, even though the other legs resolved', async () => {
    // The second, INDEPENDENTLY failing leg. /integrations and /orders succeeding
    // is not enough: the CRM card's table dereferences outbox(), so this alone
    // used to freeze the page — which is why the gate covers both legs.
    const { fixture } = setup({ getCrmOutbox: failing() });

    fixture.detectChanges();
    await fixture.whenStable();
    expect(() => fixture.detectChanges()).not.toThrow();

    expect(fixture.componentInstance['outboxRes'].status()).toBe('error');
    expect(fixture.componentInstance['dataRes'].status()).not.toBe('error');

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain(LIST_STATE_ERROR);
    expect(retryButton(host)).toBeDefined();
    expect(host.textContent).not.toContain(EMPTY_OUTBOX_COPY);
  });

  it('the guarded envelopes themselves do not throw in the error state, independently of the template', async () => {
    // The wrapper above is what a USER hits, and it makes the accessor guards
    // redundant TODAY: ListState's ng-template is never instantiated in the error
    // state, so no card binding dereferences them. Removing a guard therefore
    // leaves every case above green — which is precisely why the guard needs its
    // own detector rather than an assumption.
    //
    // It is not ceremony: the guarded computed is the ONE place `.value()` is
    // dereferenced, and that is the property that makes the NEXT binding placed
    // outside the wrapper (a header count, an effect, an export handler) safe by
    // construction. Template placement protects a template; it protects nothing
    // that reads the signal from outside a view, which is the shape that took
    // /capacity down.
    const { fixture } = setup({ getIntegrations: failing(), getCrmOutbox: failing() });
    await flush(fixture);

    const component = fixture.componentInstance;
    expect(component['dataRes'].status()).toBe('error');
    expect(component['outboxRes'].status()).toBe('error');

    // Read every accessor that hangs off the two envelopes, exactly as a binding
    // outside the wrapper would.
    expect(() => component['data']()).not.toThrow();
    expect(() => component.outbox()).not.toThrow();
    expect(() => component['erpDescriptor']()).not.toThrow();
    expect(() => component['einvoiceDescriptor']()).not.toThrow();
    expect(() => component['crmDescriptor']()).not.toThrow();
    expect(() => component['biDescriptor']()).not.toThrow();
    expect(() => component['invoicedOrders']()).not.toThrow();
    expect(() => component.activeKey('erp')).not.toThrow();

    // And what they yield is inert, never a claim: '—' is the placeholder the
    // template already used for an unknown adapter key, and the empty lists are
    // never RENDERED (the wrapper shows the error panel instead) — the pairing
    // the assertions above already pin.
    expect(component.activeKey('erp')).toBe('—');
    expect(component['invoicedOrders']()).toEqual([]);
    expect(component.outbox()).toEqual([]);
  });

  it('says "sign in", not "your role", when nobody is authenticated', async () => {
    // The mirror branch of accessNotice(): without it a single hard-coded
    // sentence would satisfy the two cases above.
    const { fixture } = setup({ getIntegrations: failing(), authenticated: false });
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain(SIGNIN_NOTICE);
    expect(host.textContent).not.toContain(ROLE_NOTICE);
  });

  it('Retry reloads BOTH legs, not only the one that broke', async () => {
    const { fixture, getIntegrations, getCrmOutbox } = setup({ getCrmOutbox: failing() });
    await flush(fixture);

    const infoBefore = getIntegrations.mock.calls.length;
    const outboxBefore = getCrmOutbox.mock.calls.length;
    expect(infoBefore).toBeGreaterThan(0);

    retryButton(fixture.nativeElement as HTMLElement)!.click();
    await flush(fixture);

    expect(getCrmOutbox.mock.calls.length).toBeGreaterThan(outboxBefore);
    expect(getIntegrations.mock.calls.length).toBeGreaterThan(infoBefore);
  });

  it('shows NONE of the failure affordances, and the four real cards, once every read resolves', async () => {
    // THE ABSENCE TWIN of every case above: a template that printed the notice or
    // the error panel unconditionally would satisfy all of them. This also
    // re-asserts what must still render, so a gate that simply always refuses
    // cannot pass either.
    const { fixture } = setup();
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).not.toContain(LIST_STATE_ERROR);
    expect(host.textContent).not.toContain(ROLE_NOTICE);
    expect(host.textContent).not.toContain(SIGNIN_NOTICE);
    expect(retryButton(host)).toBeUndefined();

    // All four adapter cards, their live descriptors and their active keys.
    expect(host.textContent).toContain('General Ledger Export');
    expect(host.textContent).toContain('FatturaPA e-invoice');
    expect(host.textContent).toContain('CRM Sync Outbox');
    expect(host.textContent).toContain('BI Feed');
    expect(host.textContent).toContain('gl-csv');
    expect(host.textContent).toContain('bi-flat-json');
    // The export controls are back, and the exportable order reached the select.
    expect([...host.querySelectorAll('button')].filter(b => /Download GL journal/.test(b.textContent ?? '')).length).toBe(1);
    expect(host.querySelectorAll('#einvoiceOrder option').length).toBe(2);
    // ...and the outbox row rendered rather than its empty copy.
    expect(host.textContent).toContain('OB1');
    expect(host.textContent).not.toContain(EMPTY_OUTBOX_COPY);
  });

  it('reads as loading — not as an empty page — for the whole pre-authReady window', async () => {
    // isLoading() alone is FALSE here: both resources resolve their pre-auth
    // defaults synchronously, which is how "No eligible customer invoices
    // available." and "Active adapter: —" came to be rendered as settled facts
    // about reads that had not been made (and are frozen that way in the SSR
    // HTML). Not-ready counts as loading.
    const { fixture, getIntegrations } = setup({ ready: false });
    await flush(fixture);

    expect(getIntegrations).not.toHaveBeenCalled();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(host.textContent).not.toContain(EMPTY_ORDERS_COPY);
    expect(host.textContent).not.toContain(EMPTY_OUTBOX_COPY);
    expect(host.textContent).not.toContain('Active adapter:');
    // A pre-auth window is not a failure either: no error panel, no notice.
    expect(host.textContent).not.toContain(LIST_STATE_ERROR);
    expect(host.textContent).not.toContain(ROLE_NOTICE);
  });

  it('shows the empty-outbox copy once the reads really do resolve empty — the mirror of the loading case', async () => {
    // Without this, pinning the skeleton on forever would pass the case above.
    const { fixture } = setup({ getCrmOutbox: vi.fn(() => of([] as CrmOutboxEntry[])) });
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[role="status"][aria-busy="true"]')).toBeNull();
    expect(host.textContent).toContain(EMPTY_OUTBOX_COPY);
    expect(host.textContent).toContain('Active adapter:');
  });
});

// -----------------------------------------------------------------------------
// The declared-but-not-connected seams (RPT rows 29, 43, 56).
//
// These three have no action to offer, and the surface must not pretend
// otherwise: the four cards above each DO something, these describe what WOULD
// happen. What is worth asserting is that the honesty survives rendering — the
// "declared only" state is shown as such rather than quietly dropped, which is
// the one thing that would make the landscape look more complete than it is.
// -----------------------------------------------------------------------------
describe('IntegrationsComponent — declared, not connected', () => {
  const host = (fixture: { nativeElement: unknown }) => fixture.nativeElement as HTMLElement;

  it('renders the section, marked Not connected', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const section = host(fixture).querySelector('[data-test="declared-seams"]');
    expect(section).not.toBeNull();
    expect(section!.textContent).toContain('Not connected');
  });

  it('lets every technical card header wrap without clipping its title or status on mobile', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const headers = Array.from(host(fixture).querySelectorAll<HTMLElement>('.command-card-header'));

    expect(headers).toHaveLength(5);
    for (const header of headers) {
      expect(header.classList).toContain('flex-col');
      expect(header.classList).toContain('sm:flex-row');
      expect(header.querySelector('.min-w-0')).not.toBeNull();
      expect(header.querySelector('.command-status')?.classList).toContain('self-start');
    }
  });

  it('lists every declared upstream source', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const rows = host(fixture).querySelectorAll('[data-test="inbound-sources"] tbody tr');
    expect(rows.length).toBe(SOURCES.length);
    expect(host(fixture).querySelector('[data-test="inbound-sources"]')!.textContent).toContain('Zucchetti');
  });

  it('shows a MAPPED source and a DECLARED-ONLY source differently', async () => {
    // The assertion the honesty rests on. A table that rendered every row the
    // same would look like a fully mapped landscape, which is the impression
    // the `mappable` flag exists to prevent.
    const { fixture } = setup();
    await flush(fixture);
    const table = host(fixture).querySelector('[data-test="inbound-sources"]')!;
    expect(table.querySelectorAll('[data-test="declared-only"]').length).toBe(1);
    expect(table.textContent).toContain('Mapped');
  });

  it('puts the MAPPED sources first, so the usable ones are read first', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const names = Array.from(host(fixture).querySelectorAll('[data-test="inbound-sources"] tbody tr td:first-child'))
      .map(td => td.textContent?.trim());
    expect(names).toStrictEqual(['PCP', 'Zucchetti', 'Skill Matrix']);
  });

  it('names the active adapter for the demand and email seams', async () => {
    const { fixture } = setup();
    await flush(fixture);
    const section = host(fixture).querySelector('[data-test="declared-seams"]')!;
    expect(section.textContent).toContain('servicenow-requester-portal');
    expect(section.textContent).toContain('local-mail-outbox');
  });

  it('renders NO source table when the landscape comes back empty', async () => {
    // The pair: an always-rendered table would show an empty header strip on a
    // failed or empty read, which reads as "there are no upstream systems".
    const { fixture } = setup({ getInboundSources: vi.fn(() => of({ sources: [] })) });
    await flush(fixture);
    expect(host(fixture).querySelector('[data-test="inbound-sources"]')).toBeNull();
    // The section itself still renders — the other two seams are unaffected.
    expect(host(fixture).querySelector('[data-test="declared-seams"]')).not.toBeNull();
  });
});
