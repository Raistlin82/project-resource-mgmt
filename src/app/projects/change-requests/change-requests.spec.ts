import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ChangeRequests } from './change-requests';
import { ApiService, ChangeRequest } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';
import { approvedChangeBudgetForProject, FinanceData } from '../../services/finance.util';

/**
 * CR-IMPL-01, the ANTI-DRIFT half. The Change Requests tab's "Approved Impact"
 * tile and `approvedChangeBudgetForProject` (the engine every project financial
 * is computed from) answer the SAME question — which change requests have a
 * committed budget impact — and they used to answer it with two separately
 * written predicates. The engine matched 'Approved' only; the tile matched
 * 'Approved' or 'Implemented'. So ticking a change request off as implemented,
 * the normal end of its life, withdrew its uplift from budget / burn % / VAC /
 * delivery health while the tile beside it went on showing the money.
 *
 * These tests therefore assert the tile against the ENGINE over one shared
 * fixture, not against a hand-copied number: the pair has to move together or
 * not at all. `countsTowardEffectiveBudget` is what makes that true, and the
 * mutation each test names in its comment is what these assertions exist to
 * catch.
 */

const PROJECT = 'P1';

/** `impactBudget`/`impactScheduleDays` typed loosely on purpose in one case below. */
function cr(over: Partial<ChangeRequest> & { status: ChangeRequest['status'] }): ChangeRequest {
  return {
    id: over.id ?? `CR-${over.status}-${over.impactBudget ?? 0}`,
    projectId: PROJECT,
    title: 'Change',
    description: 'd',
    owner: 'Julie Armstrong',
    priority: 'Medium',
    impactBudget: 0,
    impactScheduleDays: 0,
    impactScope: '',
    requestedBy: '1',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...over,
  } as ChangeRequest;
}

/**
 * The narrowest envelope `approvedChangeBudgetForProject` reads: it touches only
 * `changeRequests`, and every other member is a required-but-unread collection.
 */
function financeData(changeRequests: ChangeRequest[]): FinanceData {
  return {
    requests: [], assignments: [], resources: [], orders: [], orderLines: [], financials: [],
    changeRequests,
  };
}

async function setup(changes: ChangeRequest[]): Promise<ComponentFixture<ChangeRequests>> {
  const api = {
    getProjects: () => of([]),
    getChangeRequests: () => of(changes),
    getResources: () => of([]),
  } as unknown as ApiService;
  TestBed.configureTestingModule({
    imports: [ChangeRequests],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: { authReady: signal(true), userId: signal('1') } },
      { provide: NotificationService, useValue: { show: vi.fn() } },
    ],
  });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(ChangeRequests);
  fixture.componentRef.setInput('projectId', PROJECT);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture;
}

describe('Change Requests — the impact tiles and the finance engine share ONE committed-status predicate', () => {
  /**
   * The fixture that makes the drift observable: an Implemented uplift beside an
   * Approved one, and — the ABSENCE TWIN — a Submitted and a Rejected CR at
   * distinct, deliberately huge amounts that must contribute NOTHING to either
   * side. Without those two, "count every status" would satisfy the equality.
   */
  const MIXED: ChangeRequest[] = [
    cr({ id: 'CR-A', status: 'Approved', impactBudget: 7_500, impactScheduleDays: 3 }),
    cr({ id: 'CR-I', status: 'Implemented', impactBudget: 2_500, impactScheduleDays: 2 }),
    cr({ id: 'CR-S', status: 'Submitted', impactBudget: 999_999, impactScheduleDays: 99 }),
    cr({ id: 'CR-R', status: 'Rejected', impactBudget: 888_888, impactScheduleDays: 88 }),
    cr({ id: 'CR-D', status: 'Draft', impactBudget: 777_777, impactScheduleDays: 77 }),
  ];

  it('counts an Implemented uplift, and reports EXACTLY what the finance engine reports for the same change requests', async () => {
    const fixture = await setup(MIXED);
    const cmp = fixture.componentInstance;

    // The engine's own answer, computed independently from the same rows.
    const engine = approvedChangeBudgetForProject(PROJECT, financeData(MIXED));
    expect(engine).toBe(10_000); // guard: the independent computation is non-trivial
    expect(cmp.approvedBudgetImpact()).toBe(engine);

    // And the literal, so the equality cannot be satisfied by both sides being
    // wrong in the same direction (e.g. both dropping Implemented).
    expect(cmp.approvedBudgetImpact()).toBe(10_000);
    // MUTATION THIS CATCHES: filtering on `c.status === 'Approved'` alone — the
    // engine's pre-CR-IMPL-01 predicate — yields 7500 here.
    expect(cmp.approvedBudgetImpact()).not.toBe(7_500);
  });

  it('leaves Draft/Submitted/Rejected out of BOTH figures (so "count every status" cannot pass the equality above)', async () => {
    const fixture = await setup(MIXED);
    const cmp = fixture.componentInstance;

    // 7500 + 2500 only. The three excluded rows sum to 2_666_664, so any leak is
    // visible by orders of magnitude rather than by a rounding difference.
    expect(cmp.approvedBudgetImpact()).toBe(10_000);
    expect(cmp.approvedScheduleImpact()).toBe(5);
    expect(cmp.openCount()).toBe(2); // Draft + Submitted — unchanged by this fix
  });

  it('the schedule tile uses the SAME committed-status set as the budget tile', async () => {
    // Both tiles filter through one predicate; a fixture where the two status
    // sets would differ (an Implemented row carrying BOTH impacts) is the only
    // one that can tell them apart.
    const fixture = await setup([
      cr({ id: 'CR-I2', status: 'Implemented', impactBudget: 4_000, impactScheduleDays: 6 }),
      cr({ id: 'CR-S2', status: 'Submitted', impactBudget: 500_000, impactScheduleDays: 50 }),
    ]);
    const cmp = fixture.componentInstance;
    expect(cmp.approvedBudgetImpact()).toBe(4_000);
    expect(cmp.approvedScheduleImpact()).toBe(6);
    expect(cmp.approvedScheduleImpact()).not.toBe(0); // an Implemented-blind schedule tile reads 0
  });

  /**
   * The other half of the same register entry, and the one that is RED against
   * the pre-fix source: POST/PUT /change-requests does not validate that
   * impactBudget is a number (src/server.ts:4712, still open), so a string
   * reaches the client. `0 + "50000"` is `"050000"`, then `"050000" + "50000"` is
   * `"05000050000"`, and `| currency:'EUR'` printed EUR 5,000,050,000 for two
   * change requests worth 100,000 — while the engine, which already sums through
   * its own finite(), reported 0 for the very same rows.
   *
   * Asserted as a NUMBER, never with toContain('50000'): '05000050000' contains
   * '50000', so the substring form is green on the defect.
   */
  it('sums a non-numeric stored impactBudget as a number, never by string concatenation', async () => {
    const stringy = [
      cr({ id: 'CR-X', status: 'Approved', impactBudget: '50000' as unknown as number }),
      cr({ id: 'CR-Y', status: 'Approved', impactBudget: '50000' as unknown as number }),
    ];
    const fixture = await setup(stringy);
    const cmp = fixture.componentInstance;

    // finite() maps a non-number to 0 — exactly what the engine does — so the
    // two screens agree instead of disagreeing by five billion.
    expect(cmp.approvedBudgetImpact()).toBe(approvedChangeBudgetForProject(PROJECT, financeData(stringy)));
    expect(cmp.approvedBudgetImpact()).toBe(0);
    expect(typeof cmp.approvedBudgetImpact()).toBe('number');
    // ABSENCE TWIN: the concatenation the defect produced, named literally.
    expect(String(cmp.approvedBudgetImpact())).not.toBe('05000050000');
    // And the rendered tile must not carry it either.
    expect((fixture.nativeElement as HTMLElement).textContent ?? '').not.toContain('5,000,050,000');
  });

  it('a NaN impactScheduleDays does not poison the schedule tile, while a real negative scope reduction still counts', async () => {
    // The negative case is the load-bearing absence twin: booking a scope
    // REDUCTION is documented behaviour, so a guard that rejected anything but a
    // positive number would silently delete it.
    const fixture = await setup([
      cr({ id: 'CR-N', status: 'Approved', impactBudget: Number.NaN, impactScheduleDays: Number.NaN }),
      cr({ id: 'CR-M', status: 'Approved', impactBudget: -5_000, impactScheduleDays: -7 }),
    ]);
    const cmp = fixture.componentInstance;
    expect(cmp.approvedBudgetImpact()).toBe(-5_000);
    expect(cmp.approvedScheduleImpact()).toBe(-7);
    expect(Number.isNaN(cmp.approvedBudgetImpact())).toBe(false);
    expect(Number.isNaN(cmp.approvedScheduleImpact())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The heading convention. This component is BOTH the /change-requests route and a
// tab panel inside project-details, which renders its own h1 (the project name).
// `headingLevel` is the one mechanism all eight embeddable panels use; the twin
// of these cases — that /projects/:id still has exactly ONE h1 with a panel open
// — lives in project-details.spec.ts.
// ---------------------------------------------------------------------------

function host(fixture: ComponentFixture<ChangeRequests>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** Class tokens, SPLIT — never a className substring check. 'text-3xl' is a
 *  substring of 'sm:text-3xl', so a substring test cannot tell the responsive
 *  variant from the base one. */
function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

/** The heading — at whatever level — whose trimmed text is exactly `text`. */
function headingFor(fixture: ComponentFixture<ChangeRequests>, text: string): HTMLElement {
  const el = Array.from(host(fixture).querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .find(h => h.textContent?.trim() === text);
  expect(el, `a heading reading "${text}" must be rendered`).toBeTruthy();
  return el!;
}

describe('ChangeRequests — the screen title is an h1 on its own route, an h2 when embedded', () => {
  afterEach(() => TestBed.resetTestingModule());

  const TITLE = 'Change Control';
  const APPROVED = cr({ status: 'Approved', impactBudget: 1_000, id: 'CR-A' });

  /** The /change-requests route: the router sets no inputs at all, so the
   *  component's own defaults are what ships. */
  function renderStandalone(): ComponentFixture<ChangeRequests> {
    const api = {
      getProjects: () => of([]),
      getChangeRequests: () => of([APPROVED]),
      getResources: () => of([]),
    } as unknown as ApiService;
    TestBed.configureTestingModule({
      imports: [ChangeRequests],
      providers: [
        { provide: ApiService, useValue: api },
        { provide: AuthService, useValue: { authReady: signal(true), userId: signal('1') } },
        { provide: NotificationService, useValue: { show: vi.fn() } },
      ],
    });
    return TestBed.createComponent(ChangeRequests);
  }

  /** Exactly what project-details binds on this panel. */
  function renderEmbedded(): ComponentFixture<ChangeRequests> {
    const fixture = renderStandalone();
    fixture.componentRef.setInput('projectId', PROJECT);
    fixture.componentRef.setInput('headingLevel', 2);
    return fixture;
  }

  async function settle(fixture: ComponentFixture<ChangeRequests>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('standalone: EXACTLY ONE h1, and it carries the screen title', async () => {
    const fixture = renderStandalone();
    await settle(fixture);
    // RED before the fix: 0 — the title was an h2 and the route had no h1 at all.
    // COUNTED, not looked up: querySelector('h1') would also pass with two.
    const h1s = host(fixture).querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe(TITLE);
    // The standalone shape, proved by its own affordance: the all-projects filter
    // that only this route shows.
    expect(host(fixture).querySelector('#changeProjectFilter')).not.toBeNull();
  });

  it('embedded: NO h1 anywhere, and the title is an h2 — the absence twin', async () => {
    const fixture = renderEmbedded();
    await settle(fixture);
    expect(host(fixture).querySelectorAll('h1')).toHaveLength(0);
    expect(headingFor(fixture, TITLE).tagName).toBe('H2');
    expect(headingFor(fixture, TITLE).tagName).not.toBe('H3');
    expect(host(fixture).querySelector('#changeProjectFilter')).toBeNull();
    // The panel really rendered its own content, so the count is not vacuous.
    expect(host(fixture).textContent).toContain(APPROVED.title);
  });

  it('the title keeps its type scale — and here that is the SAME scale in both states, because this panel only ever had one title branch (class TOKENS read from the source; jsdom loads no stylesheet)', async () => {
    const standalone = renderStandalone();
    await settle(standalone);
    const standaloneTokens = classTokens(headingFor(standalone, TITLE));
    TestBed.resetTestingModule();

    const embedded = renderEmbedded();
    await settle(embedded);
    const embeddedTokens = classTokens(headingFor(embedded, TITLE));

    // The strongest form of "the element moves, the styling does not": byte-equal
    // token lists, page scale in both.
    expect(embeddedTokens).toEqual(standaloneTokens);
    expect(standaloneTokens).toEqual(expect.arrayContaining(['text-2xl', 'sm:text-3xl', 'tracking-tight']));
  });
});
