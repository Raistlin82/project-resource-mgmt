import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CapacityComponent } from './capacity.component';
import { ApiService, CapacityMonthly } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { toJson } from '../services/export.util';

/**
 * Known 2-resource × 2-month envelope with distinct bands: Alice is `over` in
 * 2026-07 (planned 1.25 FTE) and Bob is `idle` (planned 0.25 FTE). Totals give
 * the KPI strip a deterministic capacity (2.0 FTE) and planned demand (1.5 FTE).
 */
const ENVELOPE: CapacityMonthly = {
  months: ['2026-07', '2026-08'],
  rows: [
    {
      resourceId: 'r1',
      resourceName: 'Alice',
      monthly: {
        '2026-07': { confirmedHours: 160, plannedHours: 200, targetHours: 160, fteConfirmed: 1.0, ftePlanned: 1.25, band: 'over' },
        '2026-08': { confirmedHours: 152, plannedHours: 160, targetHours: 160, fteConfirmed: 0.95, ftePlanned: 1.0, band: 'healthy' },
      },
    },
    {
      resourceId: 'r2',
      resourceName: 'Bob',
      monthly: {
        '2026-07': { confirmedHours: 20, plannedHours: 40, targetHours: 160, fteConfirmed: 0.125, ftePlanned: 0.25, band: 'idle' },
        '2026-08': { confirmedHours: 80, plannedHours: 128, targetHours: 160, fteConfirmed: 0.5, ftePlanned: 0.8, band: 'under' },
      },
    },
  ],
  // C1: a single dummy row — same monthly cells as an internal row, but an
  // inert 'idle' band (never rendered) and its planned FTE lands only in
  // `totals[month].demandFteUncovered`, never in the internal capacity/demand
  // figures above.
  demandRows: [
    {
      resourceId: 'd1',
      resourceName: 'Dummy SAP',
      monthly: {
        '2026-07': { confirmedHours: 0, plannedHours: 320, targetHours: 160, fteConfirmed: 0, ftePlanned: 2.0, band: 'idle' },
        '2026-08': { confirmedHours: 0, plannedHours: 160, targetHours: 160, fteConfirmed: 0, ftePlanned: 1.0, band: 'idle' },
      },
    },
  ],
  totals: {
    '2026-07': { demandFteConfirmed: 1.125, demandFtePlanned: 1.5, capacityFte: 2, resourceCount: 2, demandFteUncovered: 2.0 },
    '2026-08': { demandFteConfirmed: 1.45, demandFtePlanned: 1.8, capacityFte: 2, resourceCount: 2, demandFteUncovered: 1.0 },
  },
};

function setup(ready: boolean, envelope: CapacityMonthly = ENVELOPE) {
  const getCapacityMonthly = vi.fn(() => of(envelope));
  const apiStub = { getCapacityMonthly } as unknown as ApiService;
  const authStub = {
    authReady: signal(ready),
    isAuthenticated: signal(ready),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [CapacityComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });

  const fixture = TestBed.createComponent(CapacityComponent);
  return { fixture, getCapacityMonthly, authStub };
}

/**
 * The same component wired to a `/capacity/monthly` read that FAILS — the
 * finance user whose bearer expired (401) or an under-privileged role (403).
 *
 * `authReady` AND `isAuthenticated` are both true on purpose: those are the
 * signals `accessNotice()` branches on, and a fixture that left `authReady`
 * false would never fetch at all (so never error), while one that left
 * `isAuthenticated` false would exercise the "Sign in" wording instead of the
 * role-denied one. Either mistake would certify nothing — the identity in the
 * fixture has to be the identity in the failure being reproduced.
 */
function setupFailingRead() {
  const getCapacityMonthly = vi.fn(() => throwError(() => new Error('403 Forbidden')));
  const apiStub = { getCapacityMonthly } as unknown as ApiService;
  const authStub = {
    authReady: signal(true),
    isAuthenticated: signal(true),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [CapacityComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });

  return { fixture: TestBed.createComponent(CapacityComponent), getCapacityMonthly };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** The role-denied wording of `accessNotice()`, quoted once. */
const ROLE_NOTICE = 'Your role does not have access to the capacity data';
/** The signed-out wording of `accessNotice()` — the branch that must NOT fire for a signed-in actor. */
const SIGNIN_NOTICE = 'Sign in to view the capacity dashboard';
/** `ListStateComponent`'s error-panel heading for this screen's `label`. */
const LIST_STATE_ERROR = "Couldn't load capacity";
/** The benign "loaded fine, nothing in range" copy — a failed read must never show it. */
const EMPTY_RANGE_COPY = 'No capacity data for the selected range.';

function retryButton(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => /Retry/.test(b.textContent ?? ''));
}

/**
 * The accessible name of a grid cell AS ASSISTIVE TECH WOULD COMPUTE IT: an
 * `aria-label` on the cell's own `<td>` (a namable host), else the visually-hidden
 * text inside it.
 *
 * The cell `<div>`'s own `aria-label` is deliberately NOT consulted — that is the
 * defect. The div has no role, ARIA prohibits naming a role=generic element, and
 * reading the attribute back with `getAttribute` is exactly the assertion that
 * certified the bug for as long as it shipped.
 */
function exposedName(cell: Element): string {
  return cell.closest('td')?.getAttribute('aria-label') ?? cell.querySelector('.sr-only')?.textContent ?? '';
}

describe('CapacityComponent', () => {
  it('renders the over cell (band + percentage) and KPI/totals from the envelope once auth is ready', async () => {
    const { fixture, getCapacityMonthly } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;

    // The data actually loaded.
    expect(getCapacityMonthly).toHaveBeenCalled();

    // The `over` cell: band conveyed by TEXT (not colour alone) + the critical
    // tone token + the planned percentage. Every internal band cell also
    // carries `data-test="band-cell"` (the marker a demand cell must NOT have —
    // see the "no semaphore band" test below); the per-cell unique lookup here
    // uses the sibling `data-cell` attribute instead.
    const overCell = host.querySelector('[data-cell="r1-2026-07"]') as HTMLElement;
    expect(overCell).not.toBeNull();
    expect(overCell.getAttribute('data-test')).toBe('band-cell');
    expect(overCell.getAttribute('data-band')).toBe('over');
    expect(overCell.className).toContain('bg-critical-tint');
    expect(overCell.textContent).toContain('125%');
    expect(overCell.textContent?.toLowerCase()).toContain('over');
    // WCAG: the hours detail is EXPOSED, not merely present in the markup. This
    // replaces `expect(overCell.getAttribute('aria-label')).toMatch(/200|160/)`,
    // which was green purely because the attribute string sat in the DOM — on a
    // role-less <div>, where ARIA forbids naming, so no AT ever surfaced it. The
    // dedicated describe below covers all four cell branches.
    expect(exposedName(overCell)).toMatch(/200|160/);
    expect(overCell.hasAttribute('aria-label')).toBe(false);

    // The idle cell is the neutral tone (distinct from the over cell).
    const idleCell = host.querySelector('[data-cell="r2-2026-07"]') as HTMLElement;
    expect(idleCell.getAttribute('data-band')).toBe('idle');
    expect(idleCell.className).not.toContain('bg-critical-tint');

    // KPI strip for the first month reflects the envelope totals + the over count.
    expect((host.querySelector('[data-test="kpi-planned"]') as HTMLElement).textContent).toContain('1.5');
    expect((host.querySelector('[data-test="kpi-capacity"]') as HTMLElement).textContent).toContain('2.0');
    expect((host.querySelector('[data-test="kpi-over"]') as HTMLElement).textContent).toContain('1');

    // Totals row for July: planned demand 1.5 vs capacity 2.0.
    const totalsJul = host.querySelector('[data-test="totals-2026-07"]') as HTMLElement;
    expect(totalsJul).not.toBeNull();
    expect(totalsJul.textContent).toContain('1.5');
    expect(totalsJul.textContent).toContain('2.0');

    // Both resources appear as rows.
    expect(host.textContent).toContain('Alice');
    expect(host.textContent).toContain('Bob');
  });

  it('seeds the From/To selects to the loaded window in the actual DOM, not just the signal', async () => {
    // Regression for the reported bug: the <select>'s live DOM `.value` must
    // match the seeded fromSel/toSel signal (the loaded window), not just the
    // signal itself — a mismatch here means the browser silently fell back to
    // the first padded option because [value] was applied before the @for's
    // <option> elements existed.
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const fromEl = host.querySelector('select[aria-label="Range start month"]') as HTMLSelectElement;
    const toEl = host.querySelector('select[aria-label="Range end month"]') as HTMLSelectElement;
    expect(fromEl).not.toBeNull();
    expect(toEl).not.toBeNull();

    expect(fixture.componentInstance['fromSel']()).toBe('2026-07');
    expect(fixture.componentInstance['toSel']()).toBe('2026-08');
    // The assertion that actually catches the bug: the live DOM value.
    expect(fromEl.value).toBe('2026-07');
    expect(toEl.value).toBe('2026-08');
  });

  it('does not fetch and shows no rows until auth settles', async () => {
    const { fixture, getCapacityMonthly } = setup(false);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    expect(getCapacityMonthly).not.toHaveBeenCalled();
    // Empty default until authReady flips true — no resource rows rendered.
    expect(host.textContent).not.toContain('Alice');
    expect(host.querySelector('[data-cell="r1-2026-07"]')).toBeNull();
  });

  it('renders uncovered demand in its own section, without a semaphore band', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const demand = host.querySelectorAll('[data-test="demand-row"]');
    expect(demand.length).toBe(1);
    expect(demand[0].textContent).toContain('Dummy SAP');
    // A demand cell must not carry a band tint class — it has no capacity to saturate.
    expect(demand[0].querySelector('[data-test="band-cell"]')).toBeNull();
    expect(host.querySelector('[data-test="kpi-uncovered"]')?.textContent).toContain('2.0');
  });

  it('writes both the internal grid and the uncovered-demand block to the CSV', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const csv = fixture.componentInstance['buildCsv']();
    const lines = csv.split('\r\n');

    // Header names the section column first, then a Planned/Confirmed/Band trio per month.
    expect(lines[0]).toBe(
      'Section,Resource,Jul 26 Planned FTE,Jul 26 Confirmed FTE,Jul 26 Band,' +
      'Aug 26 Planned FTE,Aug 26 Confirmed FTE,Aug 26 Band',
    );
    // Internal rows first, then the demand block — nothing dropped.
    expect(lines.length).toBe(4);
    expect(lines[1]).toBe('Internal capacity,Alice,1.25,1.00,over,1.00,0.95,healthy');
    expect(lines[2]).toBe('Internal capacity,Bob,0.25,0.13,idle,0.80,0.50,under');
    // The demand row carries its FTE, but never a band: the envelope's `idle` is
    // an inert placeholder and must not reach a spreadsheet as a judgement.
    expect(lines[3]).toBe('Uncovered demand,Dummy SAP,2.00,0.00,n/a,1.00,0.00,n/a');
  });

  it('keeps the exports enabled for a window whose only content is uncovered demand', async () => {
    const demandOnly: CapacityMonthly = {
      ...ENVELOPE,
      rows: [],
      totals: {
        '2026-07': { demandFteConfirmed: 0, demandFtePlanned: 0, capacityFte: 0, resourceCount: 0, demandFteUncovered: 2.0 },
        '2026-08': { demandFteConfirmed: 0, demandFtePlanned: 0, capacityFte: 0, resourceCount: 0, demandFteUncovered: 1.0 },
      },
    };
    const { fixture } = setup(true, demandOnly);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(host.querySelectorAll('button')).filter((b) => /CSV|JSON/.test(b.textContent ?? ''));
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(false);

    // And the file that comes out actually carries the demand block.
    expect(fixture.componentInstance['buildCsv']()).toContain('Uncovered demand,Dummy SAP');
  });

  describe('failed capacity read (F4)', () => {
    it('renders the access notice and a Retry control instead of throwing out of change detection', async () => {
      const { fixture, getCapacityMonthly } = setupFailingRead();

      // THE defect this pins: every resource-derived binding above the error
      // affordances (monthOptions/hasExportableRows in the header, the KPI
      // strip) dereferences an rxResource `.value()` that THROWS while the
      // resource is erroring. That throw aborts the change-detection pass, so
      // the hand-written notice below it and the ListState Retry panel below
      // that were unreachable code — the screen rendered a header and nothing.
      // The constructor's range-seeding effect read the same throwing value.
      expect(() => fixture.detectChanges()).not.toThrow();
      await fixture.whenStable();
      expect(() => fixture.detectChanges()).not.toThrow();

      const host = fixture.nativeElement as HTMLElement;
      expect(getCapacityMonthly).toHaveBeenCalled();

      // 1. The hand-written access notice, in its role-denied wording.
      expect(host.textContent).toContain(ROLE_NOTICE);
      // ...and NOT the signed-out wording: this actor is authenticated, so the
      // other branch of accessNotice() must stay shut (a notice that printed
      // both would satisfy a bare "contains something" assertion).
      expect(host.textContent).not.toContain(SIGNIN_NOTICE);
      expect(host.querySelector('[role="alert"]')).not.toBeNull();

      // 2. The ListState error panel and its Retry affordance, which the
      //    aborted pass never reached.
      expect(host.textContent).toContain(LIST_STATE_ERROR);
      expect(retryButton(host)).toBeDefined();

      // 3. A failed read is NOT "no data": neither the benign empty-range copy
      //    nor any confident zero may appear. The KPI strip and the
      //    range/export controls are gated on the error state precisely so the
      //    error short-circuit inside the accessors can never surface as 0.0
      //    FTE of demand against 0.0 FTE of capacity.
      expect(host.textContent).not.toContain(EMPTY_RANGE_COPY);
      // The band legend is static markup with no data dependency at all, so its
      // absence can only come from the error gate — it is the one region here
      // whose gate nothing else could have hidden.
      expect(host.textContent).not.toContain('Utilisation band:');
      expect(host.querySelector('[data-test="kpi-planned"]')).toBeNull();
      expect(host.querySelector('[data-test="kpi-capacity"]')).toBeNull();
      expect(host.querySelector('[data-test="kpi-over"]')).toBeNull();
      expect(host.querySelector('[data-test="kpi-uncovered"]')).toBeNull();
      expect(host.querySelector('select[aria-label="Range start month"]')).toBeNull();
      expect(host.querySelector('select[aria-label="Range end month"]')).toBeNull();
      expect([...host.querySelectorAll('button')].filter((b) => /CSV|JSON/.test(b.textContent ?? ''))).toEqual([]);
      // No grid rows either — the table region must be the error panel, not an
      // empty table with a totals footer of zeros.
      expect(host.querySelectorAll('[data-test="band-cell"]').length).toBe(0);
      expect(host.querySelectorAll('[data-test="demand-row"]').length).toBe(0);
    });

    it('clicking Retry re-issues the failed read', async () => {
      const { fixture, getCapacityMonthly } = setupFailingRead();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const before = getCapacityMonthly.mock.calls.length;
      retryButton(host)!.click();
      await fixture.whenStable();
      fixture.detectChanges();

      // The Retry control is wired, not decoration: an unreachable panel could
      // never have been proven either way.
      expect(getCapacityMonthly.mock.calls.length).toBeGreaterThan(before);
    });

    it('shows none of the failure affordances once the read resolves', async () => {
      // The companion assertion of ABSENCE. Without it a template that printed
      // the notice (or the error panel) unconditionally would satisfy the
      // failure case above, and a guard that always refused to render the data
      // region would satisfy it too — so this also asserts the region that
      // must still be ALLOWED.
      const { fixture } = setup(true);
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      expect(host.textContent).not.toContain(ROLE_NOTICE);
      expect(host.textContent).not.toContain(SIGNIN_NOTICE);
      expect(host.textContent).not.toContain(LIST_STATE_ERROR);
      expect(retryButton(host)).toBeUndefined();
      expect(host.querySelector('[role="alert"]')).toBeNull();

      // Still allowed: the KPI strip, the legend, the range selectors, the
      // export buttons and the grid itself all render on a successful load.
      expect(host.textContent).toContain('Utilisation band:');
      expect(host.querySelector('[data-test="kpi-planned"]')).not.toBeNull();
      expect(host.querySelector('[data-test="kpi-uncovered"]')).not.toBeNull();
      expect(host.querySelector('select[aria-label="Range start month"]')).not.toBeNull();
      expect(host.querySelector('select[aria-label="Range end month"]')).not.toBeNull();
      expect([...host.querySelectorAll('button')].filter((b) => /CSV|JSON/.test(b.textContent ?? '')).length).toBe(2);
      expect(host.querySelectorAll('[data-test="band-cell"]').length).toBeGreaterThan(0);
      expect(host.querySelectorAll('[data-test="demand-row"]').length).toBe(1);
    });
  });

  describe('cell accessible name (must sit on a namable host, not a role-less div)', () => {
    it('exposes resource, month, hours and target on an internal band cell', async () => {
      const { fixture } = setup(true);
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const cell = host.querySelector('[data-cell="r1-2026-07"]') as HTMLElement;
      const name = exposedName(cell);

      // Everything the visible fragments cannot supply: who, when, and the
      // 200h-of-160h detail that makes the band judgement checkable.
      expect(name).toContain('Alice');
      expect(name).toMatch(/July 2026/);
      expect(name).toMatch(/planned 200h of 160h target/);
      expect(name).toMatch(/confirmed 160h/);
      expect(name).toMatch(/band: Over/i);

      // ABSENCE: the prohibited attribute is GONE from the div, so "leave it and
      // also add a span" does not count and the old assertion cannot come back.
      expect(cell.hasAttribute('aria-label')).toBe(false);
      // ...and it did not simply migrate to the <td>: an aria-label there would
      // expose the name but REPLACE the cell's visible reading for AT.
      expect(cell.closest('td')!.hasAttribute('aria-label')).toBe(false);
      expect(cell.textContent).toContain('125%');
      expect(cell.textContent).toContain('conf 100%');
    });

    it('exposes resource and month on an inactive placeholder cell', async () => {
      // A resource present in `months` but with no cell for one of them — the
      // dashed placeholder, whose only visible text is an em dash and "n/a".
      const partial: CapacityMonthly = {
        ...ENVELOPE,
        rows: [{ resourceId: 'r1', resourceName: 'Alice', monthly: { '2026-07': ENVELOPE.rows[0].monthly['2026-07'] } }],
        demandRows: [],
      };
      const { fixture } = setup(true, partial);
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const placeholder = host.querySelector('[data-cell="r1-2026-08"]') as HTMLElement;
      expect(placeholder).not.toBeNull();
      // It really is the placeholder branch, not a band cell.
      expect(placeholder.getAttribute('data-test')).not.toBe('band-cell');
      expect(placeholder.textContent).toContain('n/a');

      const name = exposedName(placeholder);
      expect(name).toContain('Alice');
      expect(name).toMatch(/August 2026/);
      expect(name).toMatch(/not active/);
      expect(placeholder.hasAttribute('aria-label')).toBe(false);
    });

    it('exposes resource, month and hours on an uncovered-demand cell', async () => {
      const { fixture } = setup(true);
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const cell = host.querySelector('[data-cell="d1-2026-07"]') as HTMLElement;
      expect(cell).not.toBeNull();

      const name = exposedName(cell);
      expect(name).toContain('Dummy SAP');
      expect(name).toMatch(/July 2026/);
      expect(name).toMatch(/320h planned/);
      expect(name).toMatch(/uncovered demand/);
      // The demand cell must still NOT announce a band: the envelope's 'idle' is an
      // inert placeholder, and a dummy has no capacity to saturate.
      expect(name).not.toMatch(/Utilisation band/);
      expect(cell.hasAttribute('aria-label')).toBe(false);
    });

    it('leaves no aria-label on any role-less div or span in the rendered page', async () => {
      // The local form of the register's repo-wide scan. Repo-wide cannot go green
      // from this batch (8 further live sites are in files this change does not
      // own), but scoped here it is still the absence twin the three cases above
      // need: each of them anchors ONE cell, so a sibling branch could regress
      // while all three stayed green.
      const { fixture } = setup(true);
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const offenders = [...host.querySelectorAll('div[aria-label], span[aria-label]')]
        .filter((el) => !el.hasAttribute('role'))
        .map((el) => el.getAttribute('data-cell') ?? el.className);
      expect(offenders).toEqual([]);

      // And the scan is not vacuous: the elements it would have caught ARE on the
      // page (2 resources + 1 dummy × 2 months), they just carry a named child now.
      expect(host.querySelectorAll('.sr-only').length).toBeGreaterThanOrEqual(6);
    });
  });

  describe('JSON export (≤2 decimals, like its CSV sibling)', () => {
    /**
     * Any number printed with 3+ fractional digits. Safe swept over the whole
     * document: ids are opaque strings and months are 'YYYY-MM', so nothing else
     * in this payload contains a decimal point.
     */
    const LONG_FLOAT = /\d+\.\d{3,}/;

    /**
     * The float shape the server actually returns: `rollupMonthly` divides summed
     * hours by a working-day target, so every FTE is a raw quotient and every hours
     * sum carries binary-float residue. A FACTORY, not a shared constant, so the
     * immutability case below cannot be fooled by an earlier test's mutation.
     */
    function longFloatEnvelope(): CapacityMonthly {
      return {
        months: ['2026-06'],
        rows: [{
          resourceId: 'r1',
          resourceName: 'Alice',
          monthly: {
            '2026-06': {
              confirmedHours: 23.289999999999996, plannedHours: 46.57999999999999, targetHours: 176,
              fteConfirmed: 0.13232954545454542, ftePlanned: 0.26465909090909084, band: 'idle',
            },
          },
        }],
        demandRows: [{
          resourceId: 'd1',
          resourceName: 'Dummy SAP',
          monthly: {
            '2026-06': {
              confirmedHours: 0, plannedHours: 11.229999999999997, targetHours: 176,
              fteConfirmed: 0, ftePlanned: 0.06380681818181817, band: 'idle',
            },
          },
        }],
        totals: {
          '2026-06': {
            demandFteConfirmed: 0.13232954545454542, demandFtePlanned: 0.26465909090909084,
            capacityFte: 0.9545454545454546, resourceCount: 1, demandFteUncovered: 0.06380681818181817,
          },
        },
      };
    }

    it('rounds every quantity to 2 decimals — cells, demand rows and totals alike', async () => {
      const { fixture } = setup(true, longFloatEnvelope());
      await flush(fixture);

      // The fixture itself must carry a long float, or the sweep at the end is a
      // blind green gate: an already-clean envelope passes `not.toMatch` unchanged.
      expect(toJson(longFloatEnvelope())).toMatch(LONG_FLOAT);

      const json = fixture.componentInstance['buildJson']();
      const parsed = JSON.parse(json) as CapacityMonthly;

      // toStrictEqual, not toEqual: `toEqual({k: undefined})` is satisfied by `{}`,
      // so a round that DROPPED a field would otherwise pass here.
      expect(parsed.rows[0].monthly['2026-06']).toStrictEqual({
        confirmedHours: 23.29, plannedHours: 46.58, targetHours: 176,
        fteConfirmed: 0.13, ftePlanned: 0.26, band: 'idle',
      });
      expect(Object.keys(parsed.rows[0].monthly['2026-06']).sort()).toEqual(
        ['band', 'confirmedHours', 'fteConfirmed', 'ftePlanned', 'plannedHours', 'targetHours'],
      );

      // The demand block and the totals are export payload too — the original fix
      // proposal listed neither, and `demandFteUncovered` is the figure the
      // hiring/subco forecast block consumes.
      expect(parsed.demandRows[0].monthly['2026-06'].plannedHours).toBe(11.23);
      expect(parsed.demandRows[0].monthly['2026-06'].ftePlanned).toBe(0.06);
      expect(parsed.totals['2026-06']).toStrictEqual({
        demandFteConfirmed: 0.13, demandFtePlanned: 0.26, capacityFte: 0.95,
        resourceCount: 1, demandFteUncovered: 0.06,
      });

      // The sweep: nowhere in the serialised text does 3+ decimals survive.
      expect(json).not.toMatch(LONG_FLOAT);
      // Non-quantities are untouched, so the round is not a blanket reformat.
      expect(parsed.months).toEqual(['2026-06']);
      expect(parsed.rows[0].resourceName).toBe('Alice');
    });

    it('rebuilds immutably: the live envelope the grid renders from is never rounded', async () => {
      // `envelope()` IS the rxResource value the table binds to. A round applied in
      // place would silently change the on-screen figures — and only for users who
      // clicked Export.
      const env = longFloatEnvelope();
      const { fixture } = setup(true, env);
      await flush(fixture);

      fixture.componentInstance['buildJson']();

      expect(env.rows[0].monthly['2026-06'].confirmedHours).toBe(23.289999999999996);
      expect(env.rows[0].monthly['2026-06'].ftePlanned).toBe(0.26465909090909084);
      expect(env.demandRows[0].monthly['2026-06'].plannedHours).toBe(11.229999999999997);
      expect(env.totals['2026-06'].capacityFte).toBe(0.9545454545454546);
    });

    it('agrees with the CSV sibling on the same cell', async () => {
      // The whole point of the finding: two buttons side by side must not hand out
      // mutually inconsistent artefacts. CSV writes 2-decimal FTE strings.
      const { fixture } = setup(true, longFloatEnvelope());
      await flush(fixture);

      const csv = fixture.componentInstance['buildCsv']();
      const parsed = JSON.parse(fixture.componentInstance['buildJson']()) as CapacityMonthly;
      expect(csv).toContain('Internal capacity,Alice,0.26,0.13');
      expect(parsed.rows[0].monthly['2026-06'].ftePlanned).toBe(0.26);
      expect(parsed.rows[0].monthly['2026-06'].fteConfirmed).toBe(0.13);
    });
  });

  /**
   * Block H — the deliberate two-denominator divergence, DECLARED on screen.
   *
   * jsdom does NOT lay out, so nothing here proves the note is visible or that a
   * reader reaches it: these are structural assertions on presence, wording and
   * placement.
   *
   * `rollupMonthly` pro-rates the CELL target to staffable days while the TOTALS
   * keep the whole standard month — the two must diverge, because recording an
   * absence changes an individual's saturation without creating any work for the
   * organisation. This screen prints both, one under the other, so the divergence
   * has to be stated. What makes these tests non-blind is that the two fixtures
   * below carry the SAME booked hours and differ only in Alice's May target: if
   * the component ignored the difference, the "no note" twin would still pass and
   * the "note" one would not.
   */
  describe('cells-vs-totals divergence disclosure (block H — structural, not visual: jsdom does no layout)', () => {
    /**
     * Alice absent 11 of May's 22 working days, booked solid on the 11 she is
     * there (88 h); Bob at a full 176 h. June has no absence at all, so ONE
     * envelope carries both a divergent column and an untouched one.
     *
     *   May  cells: 88/88 = 1.0 and 176/176 = 1.0        -> Σ 2.0
     *   May  total: 88/176 + 176/176 = 0.5 + 1.0         -> 1.5   (diverges by 0.5)
     *   June cells: 1.0 + 1.0 = 2.0  =  June total 2.0           (does not diverge)
     */
    const ABSENCE_ENVELOPE: CapacityMonthly = {
      months: ['2026-05', '2026-06'],
      rows: [
        {
          resourceId: 'r1',
          resourceName: 'Alice',
          monthly: {
            '2026-05': { confirmedHours: 88, plannedHours: 88, targetHours: 88, fteConfirmed: 1, ftePlanned: 1, band: 'healthy' },
            '2026-06': { confirmedHours: 176, plannedHours: 176, targetHours: 176, fteConfirmed: 1, ftePlanned: 1, band: 'healthy' },
          },
        },
        {
          resourceId: 'r2',
          resourceName: 'Bob',
          monthly: {
            '2026-05': { confirmedHours: 176, plannedHours: 176, targetHours: 176, fteConfirmed: 1, ftePlanned: 1, band: 'healthy' },
            '2026-06': { confirmedHours: 176, plannedHours: 176, targetHours: 176, fteConfirmed: 1, ftePlanned: 1, band: 'healthy' },
          },
        },
      ],
      demandRows: [],
      totals: {
        '2026-05': { demandFteConfirmed: 1.5, demandFtePlanned: 1.5, capacityFte: 1.5, resourceCount: 2, demandFteUncovered: 0 },
        '2026-06': { demandFteConfirmed: 2, demandFtePlanned: 2, capacityFte: 2, resourceCount: 2, demandFteUncovered: 0 },
      },
    };

    /**
     * The twin: the SAME 88 booked hours for Alice in May, with no absence, so her
     * target is the whole standard month and her cell reads 50% instead of 100%.
     * Every column now reconciles. This is the "without absences" half of the
     * differential — and Alice's cell reading differently in the two is what
     * proves the pair is genuinely different data rather than two spellings of
     * the same thing.
     */
    const NO_ABSENCE_ENVELOPE: CapacityMonthly = {
      ...ABSENCE_ENVELOPE,
      rows: [
        {
          resourceId: 'r1',
          resourceName: 'Alice',
          monthly: {
            '2026-05': { confirmedHours: 88, plannedHours: 88, targetHours: 176, fteConfirmed: 0.5, ftePlanned: 0.5, band: 'under' },
            '2026-06': { confirmedHours: 176, plannedHours: 176, targetHours: 176, fteConfirmed: 1, ftePlanned: 1, band: 'healthy' },
          },
        },
        ABSENCE_ENVELOPE.rows[1],
      ],
      totals: {
        '2026-05': { demandFteConfirmed: 1.5, demandFtePlanned: 1.5, capacityFte: 2, resourceCount: 2, demandFteUncovered: 0 },
        '2026-06': { demandFteConfirmed: 2, demandFtePlanned: 2, capacityFte: 2, resourceCount: 2, demandFteUncovered: 0 },
      },
    };

    function noteOf(host: HTMLElement): HTMLElement | null {
      return host.querySelector('[data-test="prorated-note"]');
    }
    function markerIn(host: HTMLElement, month: string): Element | null {
      return host.querySelector(`[data-test="totals-${month}"] [data-test="totals-prorated"]`);
    }

    it('declares the divergence, and marks only the column where it is real', async () => {
      const { fixture } = setup(true, ABSENCE_ENVELOPE);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      const note = noteOf(host);
      expect(note).not.toBeNull();
      expect(note?.textContent).toContain('May 2026');
      // The paired absence assertion, inside the same envelope: June reconciles,
      // so the note must not claim it. A note that named every month would pass a
      // bare "contains May" check while saying something false about June.
      expect(note?.textContent).not.toContain('June 2026');
      expect(note?.textContent).toContain('that month');

      expect(markerIn(host, '2026-05')).not.toBeNull();
      expect(markerIn(host, '2026-06')).toBeNull();

      // The pro-rated cell is genuinely what is on screen: Alice reads 100% on the
      // days she was staffable, not 50% of a month she was half absent for. That
      // is the §1.2 correction, and without it the note would be explaining a
      // divergence the grid does not actually show.
      expect((host.querySelector('[data-cell="r1-2026-05"]') as HTMLElement).textContent).toContain('100%');
    });

    it('DIFFERENTIAL: the same booked hours without the absence render no note and no marker', async () => {
      const { fixture } = setup(true, NO_ABSENCE_ENVELOPE);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(noteOf(host)).toBeNull();
      expect(host.querySelectorAll('[data-test="totals-prorated"]').length).toBe(0);
      // Same 88 hours, whole-month denominator: 50%. If this read 100% the two
      // fixtures would be the same data and the pair would prove nothing.
      expect((host.querySelector('[data-cell="r1-2026-05"]') as HTMLElement).textContent).toContain('50%');
      // And the totals row is untouched by any of this — the point of keeping the
      // organisation's denominator fixed.
      expect((host.querySelector('[data-test="totals-2026-05"]') as HTMLElement).textContent).toContain('1.5');
    });

    it('DIFFERENTIAL: the two envelopes disagree on which months diverge', async () => {
      // The comparison itself, asserted rather than left to the reader across two
      // tests. Both mount the same component; only the envelope differs.
      const withAbsence = setup(true, ABSENCE_ENVELOPE);
      await flush(withAbsence.fixture);
      const divergentMonths = withAbsence.fixture.componentInstance['proRatedMonths']();

      TestBed.resetTestingModule();
      const without = setup(true, NO_ABSENCE_ENVELOPE);
      await flush(without.fixture);
      const reconcilingMonths = without.fixture.componentInstance['proRatedMonths']();

      expect(divergentMonths).toStrictEqual(['2026-05']);
      expect(reconcilingMonths).toStrictEqual([]);
      expect(divergentMonths).not.toStrictEqual(reconcilingMonths);
    });

    it('says nothing on the shipped default envelope, where every column reconciles', async () => {
      // The regression control: a screen with no absences anywhere must read
      // exactly as it did before this block. A note that appeared unconditionally
      // would be boilerplate a planner learns to skip, and it would be false.
      const { fixture } = setup(true);
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(noteOf(host)).toBeNull();
      expect(host.querySelectorAll('[data-test="totals-prorated"]').length).toBe(0);
    });

    it('says nothing on a failed read', async () => {
      // Same gate as the legend and the KPI strip: an explanation of a grid that
      // is not on the page describes nothing, and the error panel is what should
      // hold the reader's attention.
      const { fixture } = setupFailingRead();
      await flush(fixture);

      expect(noteOf(fixture.nativeElement as HTMLElement)).toBeNull();
    });
  });

  it('disables the exports only when both blocks are empty', async () => {
    const { fixture } = setup(true, { months: [], rows: [], demandRows: [], totals: {} });
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const buttons = Array.from(host.querySelectorAll('button')).filter((b) => /CSV|JSON/.test(b.textContent ?? ''));
    expect(buttons.length).toBe(2);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
