import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injector, PLATFORM_ID, runInInjectionContext, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ActivatedRoute,
  CanMatchFn,
  GuardResult,
  UrlTree,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';
import {
  AUDIT_FOCUS_PARAM,
  AUDIT_PAGE_LIMIT,
  AuditTrail,
  diffState,
  formatAt,
  renderValue,
} from './audit-trail';
import { AUDIT_TRAIL_READ_ROLES, auditTrailGuard } from '../app.routes';
import { ApiService, AuditLog, UserRole } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { hasAnyAllowedRole } from '../../server/authz-policy.util';

/**
 * jsdom PERFORMS NO LAYOUT. Nothing below proves that a notice is visible, on
 * screen, legible, or reachable at any given width — only that the DOM says what
 * it says. What IS structural, and therefore provable here: which entries render,
 * which copy is present and which is ABSENT, the disabled state of the paging
 * controls, and the `data-kind` each side of a diff is rendered with.
 */

const ALL_ROLES: UserRole[] = ['employee', 'pm', 'resource-manager', 'delivery-executive', 'finance', 'sales', 'admin'];

// ---------------------------------------------------------------------------
// The server's OWN rule, read out of the server's OWN source.
//
// `/audit-logs` has no exported role constant to import (contrast
// `absence-policy.util.ts`): its READ_RULE is an inline literal in `server.ts`,
// and `server.ts` may not be touched by this change. So the rule is PARSED from
// there and replayed through `hasAnyAllowedRole` — roleGate's real resolver —
// rather than compared against a second hand-typed copy, which would agree with
// itself. If the server rule is edited, this parse moves with it or fails.
// ---------------------------------------------------------------------------

const SERVER_SOURCE = readFileSync(resolve(__dirname, '../../server.ts'), 'utf8');

/** Roles the server's `/audit-logs` READ_RULE admits, straight from the source. */
function serverAuditLogRoles(): UserRole[] {
  const rule = /\{\s*test:\s*p\s*=>\s*p\.startsWith\('\/audit-logs'\),\s*roles:\s*\[([^\]]*)\]\s*\}/
    .exec(SERVER_SOURCE);
  if (!rule) return [];
  return [...rule[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1] as UserRole);
}

/** Evaluate a CanMatchFn in the browser for one role, after authReady settles. */
async function decide(guard: CanMatchFn, role: UserRole): Promise<GuardResult> {
  TestBed.resetTestingModule();
  const ready = signal(false);
  const auth = { authReady: ready.asReadonly(), hasAnyRole: (roles: UserRole[]) => roles.includes(role) };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: PLATFORM_ID, useValue: 'browser' },
      { provide: AuthService, useValue: auth },
    ],
  });
  const injector = TestBed.inject(Injector);
  const result = runInInjectionContext(injector, () => guard({} as never, []));
  ready.set(true);
  return firstValueFrom(result as Observable<GuardResult>);
}

describe('auditTrailGuard agrees with the server, in BOTH directions', () => {
  it('AUDIT_TRAIL_READ_ROLES is exactly the integrity audience', () => {
    expect([...AUDIT_TRAIL_READ_ROLES].sort()).toStrictEqual(['admin', 'delivery-executive']);
  });

  it('parses a NON-EMPTY rule out of src/server.ts (so the comparison below cannot pass by finding nothing)', () => {
    // NON-VACUOUSNESS GATE. A broken regex returns [], every role then reads as
    // "admitted" (no rule matched), and the per-role table below would agree with
    // a guard that let everybody in. This assertion fails first if that happens.
    expect(serverAuditLogRoles().sort()).toStrictEqual(['admin', 'delivery-executive']);
  });

  it('matches GET /audit-logs for every one of the seven roles', async () => {
    const allowed = serverAuditLogRoles();
    expect(allowed.length, 'the server rule must have been parsed').toBeGreaterThan(0);
    const verdicts: Record<string, { guard: boolean; server: boolean }> = {};
    for (const role of ALL_ROLES) {
      verdicts[role] = {
        guard: (await decide(auditTrailGuard, role)) === true,
        server: hasAnyAllowedRole([role], allowed),
      };
    }
    expect(verdicts).toStrictEqual({
      employee: { guard: false, server: false },
      pm: { guard: false, server: false },
      'resource-manager': { guard: false, server: false },
      'delivery-executive': { guard: true, server: true },
      finance: { guard: false, server: false },
      sales: { guard: false, server: false },
      admin: { guard: true, server: true },
    });
  });

  it('redirects the five excluded roles home rather than letting them reach a 403', async () => {
    // The paired direction, stated as its own claim: "allows admin" passes just as
    // well against a guard that allows everyone.
    for (const role of ['employee', 'pm', 'resource-manager', 'finance', 'sales'] as UserRole[]) {
      expect(await decide(auditTrailGuard, role), `${role} must not match`).toBeInstanceOf(UrlTree);
    }
  });

  it('the /audit-trail nav gate reads the SAME constant, not a second hand-typed list', () => {
    // A transcription rots. app.ts filters the Analytics group, whose DEFAULT is
    // canReadStaffing — which would advertise the register to pm, resource-manager
    // and finance and land them on a 403. This pins the branch and its source.
    const app = readFileSync(resolve(__dirname, '../app.ts'), 'utf8');
    expect(app).toContain("import { AUDIT_TRAIL_READ_ROLES } from './app.routes'");
    expect(app).toMatch(/canViewAuditTrail\s*=\s*this\.auth\.hasAnyRole\(\[\.\.\.AUDIT_TRAIL_READ_ROLES\]\)/);
    expect(app).toMatch(/item\.route === '\/audit-trail'\)\s*return canViewAuditTrail/);
  });
});

// ---------------------------------------------------------------------------
// Component fixtures.
// ---------------------------------------------------------------------------

function entry(over: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'AL1',
    at: '2026-08-07T09:15:00.000Z',
    actorId: '1',
    actorRole: 'admin',
    method: 'PUT',
    path: '/api/resources/2',
    statusCode: 200,
    ...over,
  };
}

/** A PUT whose diff exercises all three renderings a side can take. */
const MIXED = entry({
  id: 'AL10',
  method: 'PUT',
  path: '/api/absences/AB2',
  actorId: '2',
  actorRole: 'resource-manager',
  changedKeys: ['endDate', 'note', 'title'],
  // `note` is absent BEFORE (the field did not exist) and present after;
  // `title` held an empty string before and a value after; `endDate` moved
  // between two values. `reasonCode` is untouched and must not render.
  before: { id: 'AB2', endDate: '2026-08-31', title: '', reasonCode: 'ParentalLeave' },
  after: { id: 'AB2', endDate: '2026-09-30', title: 'Cover', note: 'handover agreed', reasonCode: 'ParentalLeave' },
});

const CREATED = entry({ id: 'AL11', method: 'POST', path: '/api/absences' });
const NO_DIFF = entry({ id: 'AL12', method: 'PUT', changedKeys: [], before: { id: '2' }, after: { id: '2' } });
const DELETED = entry({
  id: 'AL13',
  method: 'DELETE',
  path: '/api/absences/AB9',
  changedKeys: ['startDate'],
  before: { id: 'AB9', startDate: '2026-01-01' },
});

function fullPage(): AuditLog[] {
  return Array.from({ length: AUDIT_PAGE_LIMIT }, (_, i) => entry({ id: `AL${i + 1}` }));
}

interface Options {
  ready?: boolean;
  entries?: AuditLog[];
  getAuditLogs?: ReturnType<typeof vi.fn>;
  focus?: string;
}

function setup(o: Options = {}) {
  const getAuditLogs = o.getAuditLogs ?? vi.fn(() => of(o.entries ?? [MIXED]));
  const api = { getAuditLogs } as unknown as ApiService;
  const ready = signal(o.ready ?? true);
  const auth = { authReady: ready.asReadonly() } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [AuditTrail],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: auth },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            queryParamMap: convertToParamMap(o.focus === undefined ? {} : { [AUDIT_FOCUS_PARAM]: o.focus }),
          },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(AuditTrail);
  return { fixture, getAuditLogs, ready };
}

async function flush(fixture: ComponentFixture<AuditTrail>) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function host(fixture: ComponentFixture<AuditTrail>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function q<T extends HTMLElement>(fixture: ComponentFixture<AuditTrail>, test: string): T | null {
  return host(fixture).querySelector<T>(`[data-test="${test}"]`);
}

function retryButton(fixture: ComponentFixture<AuditTrail>): HTMLButtonElement | undefined {
  return [...host(fixture).querySelectorAll('button')].find(b => /Retry/.test(b.textContent ?? ''));
}

function failing() {
  return vi.fn(() => throwError(() => new HttpErrorResponse({ status: 500, statusText: 'Server Error' })));
}

afterEach(() => TestBed.resetTestingModule());

// ---------------------------------------------------------------------------

describe('AuditTrail — authReady and the explicit page bound (structural; jsdom performs no layout)', () => {
  it('reads nothing before the OIDC bootstrap settles, and reads once it does', async () => {
    const { fixture, getAuditLogs, ready } = setup({ ready: false });
    await flush(fixture);
    expect(getAuditLogs).not.toHaveBeenCalled();

    ready.set(true);
    await flush(fixture);
    expect(getAuditLogs).toHaveBeenCalled();
  });

  it('holds the space with a skeleton before authReady, and never claims the register is empty', async () => {
    // THE SSR PAYLOAD. `authReady` never flips true on the server, so the resource
    // resolves its empty default there — and without folding "not ready" into
    // "loading" the server-rendered HTML said "No changes have been recorded yet"
    // before a single read had been attempted. Verified against the built server
    // too, not only here.
    const notReady = setup({ ready: false });
    await flush(notReady.fixture);
    expect(host(notReady.fixture).textContent).toContain('Loading the history');
    expect(q(notReady.fixture, 'audit-empty')).toBeNull();
    expect(host(notReady.fixture).textContent).not.toContain('No changes have been recorded yet');

    // THE PAIRED DIRECTION: once it is ready and the answer really is zero rows,
    // the claim is made — otherwise the skeleton would just hide an empty register
    // for ever and the assertion above would be worthless.
    TestBed.resetTestingModule();
    const ready = setup({ entries: [] });
    await flush(ready.fixture);
    expect(host(ready.fixture).textContent).not.toContain('Loading the history');
    expect(q(ready.fixture, 'audit-empty')?.textContent?.trim()).toBe('No changes have been recorded yet.');
  });

  it('sends limit EXPLICITLY, so a truncated page can never be mistaken for the whole trail', async () => {
    const { fixture, getAuditLogs } = setup();
    await flush(fixture);
    expect(getAuditLogs.mock.calls[0][0]).toStrictEqual({ limit: AUDIT_PAGE_LIMIT, offset: 0 });
  });

  it('walks back and forward by whole pages', async () => {
    const { fixture, getAuditLogs } = setup({ entries: fullPage() });
    await flush(fixture);

    q<HTMLButtonElement>(fixture, 'audit-older')!.click();
    await flush(fixture);
    expect(getAuditLogs.mock.calls.at(-1)![0]).toStrictEqual({ limit: AUDIT_PAGE_LIMIT, offset: AUDIT_PAGE_LIMIT });
    expect(q(fixture, 'audit-range')?.textContent).toContain(`Entries ${AUDIT_PAGE_LIMIT + 1}`);

    q<HTMLButtonElement>(fixture, 'audit-newer')!.click();
    await flush(fixture);
    expect(getAuditLogs.mock.calls.at(-1)![0]).toStrictEqual({ limit: AUDIT_PAGE_LIMIT, offset: 0 });
    expect(q<HTMLButtonElement>(fixture, 'audit-newer')!.disabled).toBe(true);
  });
});

describe('AuditTrail — the feed is bounded and says so, and says nothing when it is not', () => {
  it('warns on a FULL page and enables Older', async () => {
    const { fixture } = setup({ entries: fullPage() });
    await flush(fixture);
    expect(q(fixture, 'audit-truncation-hint')?.textContent).toContain(`full at ${AUDIT_PAGE_LIMIT} entries`);
    expect(q<HTMLButtonElement>(fixture, 'audit-older')!.disabled).toBe(false);
    expect(q(fixture, 'audit-range')?.textContent).toBe(`Entries 1–${AUDIT_PAGE_LIMIT}, newest first.`);
  });

  it('shows NO warning on a short page, and disables Older — a short page proves nothing older exists', async () => {
    // THE PAIRED ASSERTION. Without it, an always-present hint passes the test
    // above and the register cries truncation on a complete answer; a hint that
    // is never rendered fails here instead of hiding.
    const { fixture } = setup({ entries: [MIXED, CREATED, NO_DIFF] });
    await flush(fixture);
    expect(q(fixture, 'audit-truncation-hint')).toBeNull();
    expect(q<HTMLButtonElement>(fixture, 'audit-older')!.disabled).toBe(true);
    expect(q(fixture, 'audit-range')?.textContent).toBe('Entries 1–3, newest first.');
  });
});

describe('AuditTrail — a failed read is an error, never "nothing was ever changed"', () => {
  it('renders the error panel with a real Retry, and NOT the empty-register sentence', async () => {
    const getAuditLogs = failing();
    const { fixture } = setup({ getAuditLogs });
    await flush(fixture);

    const text = host(fixture).textContent ?? '';
    expect(text).toContain("Couldn't load the history");
    expect(retryButton(fixture)).toBeDefined();
    // "No changes have been recorded yet" is a claim about the SYSTEM. A read that
    // failed is not an answer about the system, and the table must not be there at
    // all to make it.
    expect(q(fixture, 'audit-empty')).toBeNull();
    expect(q(fixture, 'audit-table')).toBeNull();
    expect(text).not.toContain('No changes have been recorded yet');
  });

  it('Retry re-fires the read', async () => {
    const getAuditLogs = failing();
    const { fixture } = setup({ getAuditLogs });
    await flush(fixture);
    const before = getAuditLogs.mock.calls.length;
    retryButton(fixture)!.click();
    await flush(fixture);
    expect(getAuditLogs.mock.calls.length).toBeGreaterThan(before);
  });

  it('THE TWIN — a page that succeeded with zero rows DOES say the register is empty, and shows no error', async () => {
    const { fixture } = setup({ entries: [] });
    await flush(fixture);
    expect(q(fixture, 'audit-empty')?.textContent?.trim()).toBe('No changes have been recorded yet.');
    expect(retryButton(fixture)).toBeUndefined();
    expect(host(fixture).textContent).not.toContain("Couldn't load the history");
  });
});

describe('AuditTrail — the per-key diff, with "absent" kept apart from "empty"', () => {
  it('renders key / was / now for each changed key, and never collapses absent into empty', async () => {
    const { fixture } = setup({ entries: [MIXED] });
    await flush(fixture);

    const side = (test: string) => {
      const el = q(fixture, test);
      return el === null ? null : { kind: el.dataset['kind'], text: el.textContent?.trim() };
    };

    expect({
      endDateBefore: side('audit-before-AL10-endDate'),
      endDateAfter: side('audit-after-AL10-endDate'),
      // The field did NOT exist before: "not present", kind 'absent'.
      noteBefore: side('audit-before-AL10-note'),
      noteAfter: side('audit-after-AL10-note'),
      // The field existed and held '': "empty text", kind 'empty'. A blank cell
      // for both would erase the difference between these two rows.
      titleBefore: side('audit-before-AL10-title'),
      titleAfter: side('audit-after-AL10-title'),
    }).toStrictEqual({
      endDateBefore: { kind: 'value', text: '2026-08-31' },
      endDateAfter: { kind: 'value', text: '2026-09-30' },
      noteBefore: { kind: 'absent', text: 'not present' },
      noteAfter: { kind: 'value', text: 'handover agreed' },
      titleBefore: { kind: 'empty', text: 'empty text' },
      titleAfter: { kind: 'value', text: 'Cover' },
    });
  });

  it('lists ONLY the changed keys — an untouched absence reason is not put on screen by a date change', async () => {
    // `before`/`after` are FULL entity snapshots on the wire (server.ts's own
    // comment says "just those keys"; the code stores the whole row). Rendering
    // them whole would show `reasonCode` — special-category data — for a change
    // that only moved a date. Paired with the assertion above, so "reasonCode is
    // absent" is not "nothing rendered".
    const { fixture } = setup({ entries: [MIXED] });
    await flush(fixture);
    const row = q(fixture, 'audit-row-AL10')!;
    expect(row.textContent).toContain('endDate');
    expect(row.textContent).not.toContain('reasonCode');
    expect(row.textContent).not.toContain('ParentalLeave');
  });

  it('a DELETE reads as "not present" on the after side, because the record is gone', async () => {
    const { fixture } = setup({ entries: [DELETED] });
    await flush(fixture);
    expect(q(fixture, 'audit-before-AL13-startDate')?.textContent?.trim()).toBe('2026-01-01');
    const after = q(fixture, 'audit-after-AL13-startDate')!;
    expect({ kind: after.dataset['kind'], text: after.textContent?.trim() })
      .toStrictEqual({ kind: 'absent', text: 'not present' });
  });

  it('distinguishes a creation from a mutation that moved nothing', async () => {
    // Two states that look alike if collapsed, and mean opposite things: a POST
    // has no prior state to diff; a PUT with `changedKeys: []` had one and it
    // did not move.
    const { fixture } = setup({ entries: [CREATED, NO_DIFF] });
    await flush(fixture);
    expect(q(fixture, 'audit-created-AL11')?.textContent).toContain('no prior state');
    expect(q(fixture, 'audit-no-diff-AL12')?.textContent).toContain('No field value changed');
    expect(q(fixture, 'audit-diff-AL11')).toBeNull();
    expect(q(fixture, 'audit-diff-AL12')).toBeNull();
  });

  it('spells the two markers out in the legend, so the difference is READ and not guessed', async () => {
    const { fixture } = setup({ entries: [MIXED] });
    await flush(fixture);
    const legend = q(fixture, 'audit-diff-legend')?.textContent ?? '';
    expect(legend).toContain('not present');
    expect(legend).toContain('empty text');
    expect(legend).toContain('not the same thing');
  });

  it('rounds a stored number to 2 decimals on screen and keeps the exact value reachable', async () => {
    const { fixture } = setup({
      entries: [entry({
        id: 'AL20', method: 'PUT', path: '/api/rate-cards/RC1',
        changedKeys: ['billRate', 'capacity'],
        before: { id: 'RC1', billRate: 100, capacity: 100 },
        after: { id: 'RC1', billRate: 1234.5678, capacity: 100.5 },
      })],
    });
    await flush(fixture);
    const rate = q(fixture, 'audit-after-AL20-billRate')!;
    expect(rate.textContent?.trim()).toBe('1234.57');
    expect(rate.getAttribute('title')).toBe('Exact stored value: 1234.5678');
    // A value that needed no rounding carries no title — the marker must mean
    // "this was rounded", not decorate every number.
    expect(q(fixture, 'audit-after-AL20-capacity')?.getAttribute('title')).toBeNull();
  });
});

describe('AuditTrail — append-only, therefore read-only', () => {
  it('offers no control that could change or export an entry, while rows ARE on screen', async () => {
    // The second half is what stops this from passing vacuously: if the table
    // rendered nothing, "no edit button" would be trivially true.
    const { fixture } = setup({ entries: [MIXED] });
    await flush(fixture);
    expect(q(fixture, 'audit-row-AL10')).not.toBeNull();

    const labels = [...host(fixture).querySelectorAll('button, a')]
      .map(el => `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase());
    const forbidden = ['edit', 'delete', 'remove', 'save', 'export', 'csv', 'download'];
    expect(labels.filter(label => forbidden.some(word => label.includes(word)))).toStrictEqual([]);
  });

  it('states the append-only guarantee and the special-category warning in the interface', async () => {
    const { fixture } = setup({ entries: [MIXED] });
    await flush(fixture);
    expect(q(fixture, 'audit-append-only-notice')?.textContent).toContain('cannot be edited or deleted');
    const notice = q(fixture, 'audit-privacy-notice')!;
    expect(notice.textContent).toContain('special-category personal data');
    expect(notice.textContent).toContain('no export');
    // jsdom cannot measure a horizontal scroll, so the CAUSE is pinned instead:
    // `.command-chip` is `white-space: nowrap`, and a sentence this long inside it
    // pushed the whole page sideways in the real browser. Caught on screen, kept
    // out here.
    expect(notice.className).not.toContain('command-chip');
    expect(notice.className).toContain('bg-info-tint');
    expect(notice.className).toContain('text-info-text');
  });
});

describe('AuditTrail — filters narrow the loaded page, and say so', () => {
  it('seeds the entity filter from ?entity= (RPT\'s per-row history), and leaves it empty without the param', async () => {
    const focused = setup({ focus: '/api/absences/AB2', entries: [MIXED, entry({ id: 'AL30', path: '/api/resources/9' })] });
    await flush(focused.fixture);
    expect(q(focused.fixture, 'audit-row-AL10')).not.toBeNull();
    expect(q(focused.fixture, 'audit-row-AL30')).toBeNull();
    expect(q<HTMLInputElement>(focused.fixture, 'audit-entity-filter')!.value).toBe('/api/absences/AB2');
    // The range line has to say the other row was FILTERED, not that it does not
    // exist: "Entries 1–2, newest first" over one visible row invites the second
    // reading.
    expect(q(focused.fixture, 'audit-range')?.textContent)
      .toBe('1 of 2 shown by the filters. Entries 1–2, newest first.');

    // THE PAIRED DIRECTION: no param, no filter, both rows.
    TestBed.resetTestingModule();
    const open = setup({ entries: [MIXED, entry({ id: 'AL30', path: '/api/resources/9' })] });
    await flush(open.fixture);
    expect(q(open.fixture, 'audit-row-AL10')).not.toBeNull();
    expect(q(open.fixture, 'audit-row-AL30')).not.toBeNull();
    expect(q<HTMLInputElement>(open.fixture, 'audit-entity-filter')!.value).toBe('');
    expect(q(open.fixture, 'audit-range')?.textContent).toBe('Entries 1–2, newest first.');
  });

  it('words the empty state by SCOPE — a filtered miss is never "nothing was ever changed"', async () => {
    const { fixture } = setup({ entries: [MIXED] });
    await flush(fixture);
    const input = q<HTMLInputElement>(fixture, 'audit-entity-filter')!;
    input.value = '/api/orders/nope';
    input.dispatchEvent(new Event('input'));
    await flush(fixture);

    expect(q(fixture, 'audit-empty')?.textContent).toContain('No entry on this page matches the filters');
    expect(q(fixture, 'audit-empty')?.textContent).not.toContain('No changes have been recorded yet');
    expect(q(fixture, 'audit-filter-scope-note')?.textContent).toContain('do not search the rest of the trail');
  });

  it('drives the actor picker from the loaded page and marks the choice per option (no value binding on the select)', async () => {
    const { fixture } = setup({ entries: [MIXED, entry({ id: 'AL31', actorId: '7' })] });
    await flush(fixture);
    const select = q<HTMLSelectElement>(fixture, 'audit-actor-filter')!;
    expect([...select.options].map(o => o.value)).toStrictEqual(['', '2', '7']);

    select.value = '7';
    select.dispatchEvent(new Event('change'));
    await flush(fixture);
    expect(q(fixture, 'audit-row-AL31')).not.toBeNull();
    expect(q(fixture, 'audit-row-AL10')).toBeNull();
    // The per-option `[selected]` is what survives options arriving late; a
    // `[value]` on the <select> would have reset to the first option.
    expect([...q<HTMLSelectElement>(fixture, 'audit-actor-filter')!.options].filter(o => o.selected).map(o => o.value))
      .toStrictEqual(['7']);
  });

  it('filters by operation', async () => {
    const { fixture } = setup({ entries: [MIXED, CREATED] });
    await flush(fixture);
    const select = q<HTMLSelectElement>(fixture, 'audit-method-filter')!;
    expect([...select.options].map(o => o.value)).toStrictEqual(['', 'POST', 'PUT']);
    select.value = 'POST';
    select.dispatchEvent(new Event('change'));
    await flush(fixture);
    expect(q(fixture, 'audit-row-AL11')).not.toBeNull();
    expect(q(fixture, 'audit-row-AL10')).toBeNull();
  });
});

describe('AuditTrail — the pure rendering layer', () => {
  it('renderValue keeps absent, null and empty apart, and caps numbers at 2 decimals', () => {
    expect(renderValue(undefined)).toStrictEqual({ kind: 'absent' });
    expect(renderValue(null)).toStrictEqual({ kind: 'null' });
    expect(renderValue('')).toStrictEqual({ kind: 'empty' });
    expect(renderValue('x')).toStrictEqual({ kind: 'value', text: 'x', exact: null });
    expect(renderValue(false)).toStrictEqual({ kind: 'value', text: 'false', exact: null });
    expect(renderValue(0)).toStrictEqual({ kind: 'value', text: '0', exact: null });
    expect(renderValue(0.1 + 0.2)).toStrictEqual({ kind: 'value', text: '0.3', exact: '0.30000000000000004' });
    expect(renderValue(['a', 'b'])).toStrictEqual({ kind: 'value', text: '["a","b"]', exact: null });
  });

  it('diffState reads presence on the OBJECT, so a missing snapshot is "absent" and not "empty"', () => {
    expect(diffState(entry({ changedKeys: undefined }))).toStrictEqual({ kind: 'created' });
    expect(diffState(entry({ changedKeys: [] }))).toStrictEqual({ kind: 'no-diff' });
    expect(diffState(entry({ changedKeys: ['a'], before: {}, after: { a: '' } }))).toStrictEqual({
      kind: 'lines',
      lines: [{ key: 'a', before: { kind: 'absent' }, after: { kind: 'empty' } }],
    });
    // No `before` at all (a DELETE has no `after`, a POST has no `before`).
    expect(diffState(entry({ changedKeys: ['a'], after: { a: 1 } }))).toStrictEqual({
      kind: 'lines',
      lines: [{ key: 'a', before: { kind: 'absent' }, after: { kind: 'value', text: '1', exact: null } }],
    });
  });

  it('formatAt states the zone and never depends on the host locale', () => {
    expect(formatAt('2026-08-07T09:15:00.000Z')).toBe('2026-08-07 09:15:00 UTC');
    expect(formatAt('not-a-date')).toBe('not-a-date');
  });
});
