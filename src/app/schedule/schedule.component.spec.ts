import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NEVER, of, throwError } from 'rxjs';
import { ScheduleComponent, currentWeekAnchorMs } from './schedule.component';
import { ApiService, Assignment, Resource, ResourceRequest } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

// =============================================================================
// Fixtures
//
// Two resources in roster order (R1 above R2) each carrying one booking, because
// keyboard REASSIGN is defined relative to the neighbouring lane: a one-lane
// fixture could never distinguish "moved to the next resource" from "did
// nothing". Both windows sit inside the pinned 12-week horizon below, and both
// are conflict-free so no test is accidentally reading conflict styling.
// =============================================================================

const RESOURCES: Resource[] = [
  { id: 'R1', name: 'Anna Rossi', role: 'Developer', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
  { id: 'R2', name: 'Bruno Neri', role: 'Architect', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 32 },
];

const REQUESTS: ResourceRequest[] = [
  { id: 'REQ_A', name: 'Alpha Migration', requiredRole: 'Developer', requiredEffort: 100, status: 'Open', skills: [] },
  { id: 'REQ_B', name: 'Beta Rollout', requiredRole: 'Architect', requiredEffort: 100, status: 'Open', skills: [] },
];

/** A1 is Anna's booking (lane 1); A2 is Bruno's (lane 2). */
const A1_START = '2026-09-14';
const A1_END = '2026-10-11';

function assignments(): Assignment[] {
  return [
    { id: 'A1', requestId: 'REQ_A', resourceId: 'R1', assignedHours: 40, status: 'Allocated', startDate: A1_START, endDate: A1_END, allocationPct: 100 },
    { id: 'A2', requestId: 'REQ_B', resourceId: 'R2', assignedHours: 32, status: 'Allocated', startDate: '2026-09-21', endDate: '2026-10-18', allocationPct: 100 },
  ];
}

/**
 * Monday 2026-09-07, 00:00 UTC. The component derives its horizon anchor from
 * Date.now() in the browser, which would make every bar-geometry expectation
 * drift with the wall clock; the tests pin the anchor instead, so the 12 visible
 * week columns are always 2026-09-07 → 2026-11-29 and all date math stays UTC
 * (no local-timezone dependence).
 */
const ANCHOR_MS = Date.UTC(2026, 8, 7);

interface Harness {
  fixture: ReturnType<typeof TestBed.createComponent<ScheduleComponent>>;
  host: HTMLElement;
  component: ScheduleComponent;
  updateAssignment: ReturnType<typeof vi.fn>;
}

interface SetupOptions {
  /** Leave the three-leg forkJoin in flight (no leg ever emits). */
  pending?: boolean;
  /** Fail the /requests leg, as an expired bearer or a 500 does. */
  failing?: boolean;
  /** false reproduces the pre-OIDC-bootstrap window (and the SSR document). */
  authReady?: boolean;
  /** Override the roster (e.g. one conflict-free resource). */
  resources?: Resource[];
  /** Override the bookings. */
  assignments?: Assignment[];
}

function setup(opts: SetupOptions = {}): Harness {
  const updateAssignment = vi.fn((id: string, patch: Partial<Assignment>) =>
    of({ ...assignments().find(a => a.id === id)!, ...patch }),
  );
  // A leg that never emits keeps forkJoin — and therefore the resource — loading.
  const leg = <T>(value: T) => (opts.pending ? NEVER : of(value));
  const apiStub = {
    getResources: () => leg(opts.resources ?? RESOURCES),
    getAssignments: () => leg(opts.assignments ?? assignments()),
    getRequests: () => (opts.failing ? throwError(() => new Error('500')) : leg(REQUESTS)),
    updateAssignment,
  } as unknown as ApiService;
  // authReady true by default: these are principal-gated reads, and a fixture
  // left un-ready would never fetch, so nothing under test would ever render.
  const authStub = {
    authReady: signal(opts.authReady ?? true),
    isAuthenticated: signal(true),
  } as unknown as AuthService;
  const notifyStub = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    imports: [ScheduleComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ScheduleComponent);
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance,
    updateAssignment,
  };
}

/**
 * Render, then pin the horizon anchor and render again.
 *
 * The pre-authReady case IS flushed, and that is the subtlety of the read-state
 * detector below: `params()` false makes the stream `of(<empty>)`, which
 * RESOLVES. Un-flushed, the resource would still be in its initial pending state,
 * so the skeleton would be on screen for a reason unrelated to the gate under
 * test and the spec would pass with the gate removed.
 */
async function render(opts: SetupOptions = {}): Promise<Harness> {
  const h = setup(opts);
  h.fixture.detectChanges();
  await h.fixture.whenStable();
  h.fixture.detectChanges();
  // Set AFTER the first flush so afterNextRender's own Date.now() seed (which
  // has already run by now) cannot clobber the pinned anchor.
  h.component['anchorMs'].set(ANCHOR_MS);
  h.fixture.detectChanges();
  await h.fixture.whenStable();
  h.fixture.detectChanges();
  return h;
}

/**
 * Render WITHOUT awaiting whenStable — it never settles while a resource is in
 * flight, and "in flight" is precisely the state the pending/error cases assert
 * about. The anchor is pinned anyway so the timeline branch is reachable in the
 * cases that do resolve.
 */
function renderUnsettled(opts: SetupOptions = {}): Harness {
  const h = setup(opts);
  h.fixture.detectChanges();
  h.component['anchorMs'].set(ANCHOR_MS);
  h.fixture.detectChanges();
  return h;
}

/** The list-state's loading region — its own contract (role=status +
 *  aria-busy), not a shimmer class. Scoped away from the "Preparing the
 *  timeline…" placeholder, which carries aria-busy but no role. */
function skeleton(host: HTMLElement): Element | null {
  return host.querySelector('[role="status"][aria-busy="true"]');
}

function bars(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('.command-schedule-bar')];
}

function grid(host: HTMLElement): HTMLElement {
  return host.querySelector<HTMLElement>('.command-schedule-grid')!;
}

function key(el: HTMLElement, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

/**
 * A pointer event jsdom will construct: PointerEvent is not guaranteed here, and
 * the handlers only read button/clientX/clientY/pointerId, so a MouseEvent with
 * a pointerId stamped on works and still travels through the real template
 * binding rather than calling the handler directly.
 */
function pointer(type: string, clientX: number, clientY: number, pointerId = 7): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
  Object.defineProperty(ev, 'pointerId', { value: pointerId });
  return ev;
}

// -----------------------------------------------------------------------------
// Source-text reads. Two of the contracts below are about declarations rather
// than behaviour (a CSS width floor, a foreground colour), and jsdom performs NO
// layout — it computes no grid tracks and no used widths — so the honest form of
// those checks is a static assertion over the source, stated as such in the test
// names. The token arithmetic is done numerically, not by matching token names.
// -----------------------------------------------------------------------------

const COMPONENT_SRC = readFileSync(resolve(process.cwd(), 'src/app/schedule/schedule.component.ts'), 'utf8');
const GLOBAL_CSS = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

/** The declarations of one flat CSS rule (no nested braces in this stylesheet). */
function cssBlock(css: string, selector: string): string {
  const needle = `${selector} {`;
  const at = css.indexOf(needle);
  expect(at, `CSS selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', at);
  return css.slice(at + needle.length, end);
}

// --- OKLCH → WCAG contrast ---------------------------------------------------

interface Oklch { l: number; c: number; h: number }

/** Pull `--token: oklch(l c h)` out of a block of CSS declarations. */
function token(block: string, name: string): Oklch {
  const m = new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`).exec(block);
  expect(m, `token not found: ${name}`).not.toBeNull();
  const [l, c, h] = m![1].trim().split(/\s+/).map(Number);
  return { l, c, h: h ?? 0 };
}

/** CSS `color-mix(in oklch, a <pct>%, b)`: polar mix, hue along the shorter arc. */
function mixOklch(a: Oklch, b: Oklch, aPct: number): Oklch {
  const wa = aPct / 100;
  let delta = ((a.h - b.h + 540) % 360) - 180; // shortest signed arc b → a
  if (delta === -180) delta = 180;
  return { l: b.l + wa * (a.l - b.l), c: b.c + wa * (a.c - b.c), h: b.h + wa * delta };
}

/**
 * WCAG relative luminance of an OKLCH colour: OKLCH → OKLab → linear sRGB
 * (Ottosson's matrices) → Y. Linear channels are clamped to [0,1], which is the
 * gamut clip a display applies; every colour here is well inside sRGB anyway.
 */
function luminance({ l, c, h }: Oklch): number {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const bb = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_);
  const g = clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_);
  const b = clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(x: Oklch, y: Oklch): number {
  const a = luminance(x);
  const b = luminance(y);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Oklch = { l: 1, c: 0, h: 0 };
/** The light-theme token block, and the dark-theme override block. */
const LIGHT_TOKENS = cssBlock(GLOBAL_CSS, '@theme');
const DARK_TOKENS = cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]');

/**
 * The summary strip used to render ABOVE the read-state wrapper, so for the whole
 * three-endpoint read the page asserted "No over-allocation detected" across
 * "0 resources and 0 bookings" — a reassuring claim about data not yet fetched.
 * When a leg failed, model() threw out of that strip and aborted the pass, which
 * made the error panel unreachable and left the false all-clear as the screen's
 * TERMINAL state.
 *
 * The third case is what stops "delete the sentence" from passing: a genuinely
 * conflict-free roster MUST still say it.
 */
describe('ScheduleComponent — the summary strip no longer certifies unfetched data', () => {
  it('does not claim "No over-allocation detected" before authReady, even though the API has a roster', async () => {
    const { host, component } = await render({ authReady: false });

    // POSITIVE CONTROLS pinning the exact state: the read resolved to the
    // pre-auth default AND is not reporting loading. Without the second, the
    // skeleton could be up merely because nothing had flushed.
    expect(component['data'].value().resources).toEqual([]);
    expect(component['data'].isLoading()).toBe(false);

    expect(host.textContent).not.toContain('No over-allocation detected');
    expect(host.textContent).not.toContain('No resources to schedule');
    expect(skeleton(host)).not.toBeNull();
    // The header must survive — it is how the user knows WHICH screen is loading.
    expect(host.textContent).toContain('Resource Schedule');
  });

  it('does not claim it while the three-leg read is genuinely in flight either', () => {
    const { host, component } = renderUnsettled({ pending: true });

    expect(component['data'].isLoading()).toBe(true);
    expect(host.textContent).not.toContain('No over-allocation detected');
    expect(host.textContent).not.toContain('No resources to schedule');
    expect(skeleton(host)).not.toBeNull();
  });

  // THE MIRROR, and the reason "delete the sentence" cannot pass: a resolved read
  // over a roster with no overlapping bookings MUST state the all-clear.
  it('does say "No over-allocation detected" for a resolved, genuinely conflict-free roster', async () => {
    const { host, component } = await render();

    expect(skeleton(host)).toBeNull();
    // Positive control on the DATA, not just the copy: the roster really is
    // conflict-free and really has bookings, so the sentence is earned.
    expect(component['overAllocatedCount']()).toBe(0);
    expect(component['totalBookings']()).toBe(2);
    expect(host.textContent).toContain('No over-allocation detected');
    expect(host.textContent).toContain('Across 2 resources and 2 bookings.');
  });

  // And the opposite data state on the same element, so the strip is proven to
  // report a real figure rather than a constant.
  it('reports the over-allocated count when two bookings overlap past 100%', async () => {
    const overlapping: Assignment[] = [
      { id: 'A1', requestId: 'REQ_A', resourceId: 'R1', assignedHours: 40, status: 'Allocated', startDate: A1_START, endDate: A1_END, allocationPct: 100 },
      { id: 'A2', requestId: 'REQ_B', resourceId: 'R1', assignedHours: 40, status: 'Allocated', startDate: A1_START, endDate: A1_END, allocationPct: 100 },
    ];
    const { host, component } = await render({ resources: [RESOURCES[0]], assignments: overlapping });

    expect(component['overAllocatedCount']()).toBe(1);
    expect(host.textContent).toContain('1 resource over-allocated');
    expect(host.textContent).not.toContain('No over-allocation detected');
  });

  it('shows the error panel and Retry instead of aborting change detection when a leg fails', async () => {
    // model() and the `working` linkedSignal SOURCE both dereference
    // data.value(), which throws in the error state. The linkedSignal source is
    // evaluated outside the template, so no reordering protects it — this case
    // fails on an unguarded source even with the strip moved inside the wrapper.
    const h = renderUnsettled({ failing: true });
    // Microtask flushes, NOT whenStable(): the rxResource reaches its error state
    // one microtask after the stream throws, and whenStable() would be a coin
    // flip on a resource that has not settled.
    await Promise.resolve();
    await Promise.resolve();
    expect(() => h.fixture.detectChanges()).not.toThrow();

    // Positive control: the test cannot pass by the read quietly succeeding.
    expect(h.component['data'].status()).toBe('error');
    expect(h.host.textContent).toContain("Couldn't load the schedule");
    const retry = [...h.host.querySelectorAll('button')].find(b => b.textContent!.includes('Retry'));
    expect(retry).toBeDefined();
    // A failed read is not an all-clear, and not an empty roster either.
    expect(h.host.textContent).not.toContain('No over-allocation detected');
    expect(h.host.textContent).not.toContain('No resources to schedule');
    // The header stays, so the user can see which screen failed.
    expect(h.host.textContent).toContain('Resource Schedule');
  });

  // THE MIRROR for the empty state: a resolved read with an empty roster must
  // say so — this is the half a permanently-loading wrapper fails.
  it('does say "No resources to schedule" once a resolved read has an empty roster', async () => {
    const { host } = await render({ resources: [], assignments: [] });

    expect(skeleton(host)).toBeNull();
    expect(host.textContent).toContain('No resources to schedule');
  });

  /**
   * The two accessors that are evaluated OUTSIDE the ng-template — the `working`
   * linkedSignal's SOURCE, and `model()` (reached from projectColor() and the
   * drag handlers) — asserted at the seam rather than through the DOM.
   *
   * Deliberately not folded into the error-panel case above: with the summary
   * strip now inside the wrapper, NOTHING in the template evaluates either one
   * in the error state, so the DOM test passes with both guards removed. It is
   * exactly that invisibility that makes this the regression the next person
   * will reintroduce — moving one binding back above the wrapper is enough — so
   * the invariant is pinned where it lives instead of relying on the current
   * template layout to enforce it.
   */
  it('keeps the working copy and the derived model readable in the error state (guarded at the seam, not by template placement)', async () => {
    const h = renderUnsettled({ failing: true });
    await Promise.resolve();
    await Promise.resolve();
    h.fixture.detectChanges();

    // Positive control: these assertions are meaningless unless the read failed.
    expect(h.component['data'].status()).toBe('error');

    // A linkedSignal source is evaluated outside the template; no reordering or
    // ng-template deferral protects it.
    expect(() => h.component['working']()).not.toThrow();
    expect(() => h.component['model']()).not.toThrow();
    expect(h.component['model']().lanes).toEqual([]);

    // ABSENCE TWIN: the guards must not have turned the accessors into constant
    // empties. A resolved read must still produce the real lanes and bookings —
    // so "return [] unconditionally" cannot pass.
    TestBed.resetTestingModule();
    const ok = await render();
    expect(ok.component['working']()).toHaveLength(2);
    expect(ok.component['model']().lanes).toHaveLength(2);
  });
});

describe('ScheduleComponent — the timeline no longer claims a table it does not own', () => {
  it('does not declare role="table" while owning zero role="row" elements', async () => {
    const { host } = await render();
    const root = grid(host);

    // Positive control first: the fixture really did render a populated grid.
    expect(bars(host).length).toBe(2);

    // The implication a valid ARIA table must satisfy — written without a branch
    // so it cannot pass by being skipped. RED before: role was 'table' with 0 rows.
    const rowCount = root.querySelectorAll('[role="row"]').length;
    const claimsTable = root.getAttribute('role') === 'table';
    expect(claimsTable && rowCount === 0).toBe(false);

    // ABSENCE twin: no columnheader/rowheader/cell may exist without a row owner.
    // RED before at 15 elements (corner + 12 week heads + 2 lanes + 2 tracks).
    const orphans = [...root.querySelectorAll('[role="columnheader"],[role="rowheader"],[role="cell"]')]
      .filter(el => el.closest('[role="row"]') === null)
      .map(el => el.getAttribute('role'));
    expect(orphans).toEqual([]);

    // And the grid is still an announced, named region rather than nothing at all.
    expect(root.getAttribute('role')).toBe('group');
    expect(root.getAttribute('aria-label')).toBe('Resource schedule timeline');
  });

  it('still names every booking, so dropping the structural roles loses no information', async () => {
    const { host } = await render();

    const labels = bars(host).map(b => b.getAttribute('aria-label') ?? '');
    expect(labels).toHaveLength(2);
    // Each bar carries who / what / when — the semantics the roles were meant to
    // express are on the focusable element that actually gets announced.
    expect(labels[0]).toContain('Anna Rossi');
    expect(labels[0]).toContain('Alpha Migration');
    expect(labels[0]).toContain(A1_START);
    expect(labels[0]).toContain(A1_END);
    expect(bars(host).every(b => b.getAttribute('role') === 'button' && b.tabIndex === 0)).toBe(true);
  });
});

describe('ScheduleComponent — keyboard reassign and start-resize', () => {
  it('ArrowDown reassigns the booking to the next resource lane', async () => {
    const { host, fixture, updateAssignment } = await render();

    key(bars(host)[0], { key: 'ArrowDown' });
    fixture.detectChanges();
    await fixture.whenStable();

    // Asserted on the PUT payload, not on the bar's position: the bar is
    // repositioned by a plain move too, so only the payload can tell them apart.
    expect(updateAssignment).toHaveBeenCalledTimes(1);
    const [id, payload] = updateAssignment.mock.calls[0] as [string, Partial<Assignment>];
    expect(id).toBe('A1');
    expect(payload.resourceId).toBe('R2');
    // ABSENCE twin: a reassign moves the person, never the dates.
    expect(payload.startDate).toBe(A1_START);
    expect(payload.endDate).toBe(A1_END);
  });

  it('ArrowUp reassigns back up the roster, and neither arrow wraps around the ends', async () => {
    const { host, fixture, updateAssignment } = await render();
    const [annaBar, brunoBar] = bars(host);

    // Bruno is the last lane: ArrowDown has nowhere to go and must write nothing.
    key(brunoBar, { key: 'ArrowDown' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(updateAssignment).not.toHaveBeenCalled();

    // Anna is the first lane: ArrowUp likewise.
    key(annaBar, { key: 'ArrowUp' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(updateAssignment).not.toHaveBeenCalled();

    // ...but the guard is not a blanket refusal: upwards from Bruno works.
    key(brunoBar, { key: 'ArrowUp' });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(updateAssignment).toHaveBeenCalledTimes(1);
    const [id, payload] = updateAssignment.mock.calls[0] as [string, Partial<Assignment>];
    expect(id).toBe('A2');
    expect(payload.resourceId).toBe('R1');
  });

  it('Alt+Shift+ArrowLeft moves the START back one week and leaves the end where it was', async () => {
    const { host, fixture, updateAssignment } = await render();

    key(bars(host)[0], { key: 'ArrowLeft', altKey: true, shiftKey: true });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(updateAssignment).toHaveBeenCalledTimes(1);
    const payload = updateAssignment.mock.calls[0][1] as Partial<Assignment>;
    expect(payload.startDate).toBe('2026-09-07'); // 2026-09-14 − 7 days
    // ABSENCE assertion, and the whole point of the test: without it the same
    // expectations would pass against the pre-existing move path, which shifts
    // BOTH dates — i.e. the resize would be certified by a non-resize.
    expect(payload.endDate).toBe(A1_END);
    // A start-resize never changes the resource either.
    expect(payload.resourceId).toBeUndefined();
  });

  it('bare ArrowLeft still moves the whole booking (the branch Alt+Shift must not swallow)', async () => {
    const { host, fixture, updateAssignment } = await render();

    key(bars(host)[0], { key: 'ArrowLeft' });
    fixture.detectChanges();
    await fixture.whenStable();

    expect(updateAssignment).toHaveBeenCalledTimes(1);
    const payload = updateAssignment.mock.calls[0][1] as Partial<Assignment>;
    expect(payload.startDate).toBe('2026-09-07');
    expect(payload.endDate).toBe('2026-10-04'); // both ends travel: 2026-10-11 − 7
  });

  it('Shift+ArrowRight still resizes only the END', async () => {
    const { host, fixture, updateAssignment } = await render();

    key(bars(host)[0], { key: 'ArrowRight', shiftKey: true });
    fixture.detectChanges();
    await fixture.whenStable();

    const payload = updateAssignment.mock.calls[0][1] as Partial<Assignment>;
    expect(payload.startDate).toBe(A1_START);
    expect(payload.endDate).toBe('2026-10-18'); // 2026-10-11 + 7
  });

  it('announces every one of those bindings on the bar and in the on-screen hint', async () => {
    const { host } = await render();

    const label = bars(host)[0].getAttribute('aria-label') ?? '';
    expect(label).toMatch(/up and down arrows reassign/i);
    expect(label).toMatch(/alt plus shift plus arrows resize the start/i);
    // The sighted-keyboard user needs the same list; it lives in the header hint.
    const hint = host.textContent ?? '';
    expect(hint).toMatch(/Alt\+Shift\+arrows resize the start/i);
    expect(hint).toMatch(/up\/down reassign/i);
  });
});

describe('ScheduleComponent — pointer drag movement threshold', () => {
  beforeEach(() => {
    // jsdom does no hit testing. The move path only asks which lane the pointer
    // is over; a null answer keeps the booking in its own lane, which is exactly
    // the state this test is about (a nudge must not reassign anything).
    Object.defineProperty(document, 'elementFromPoint', { value: () => null, configurable: true, writable: true });
  });

  it('previews nothing below the 3px threshold and exactly once past it (both halves)', async () => {
    const { host, component } = await render();
    const bar = bars(host)[0];
    // Spy on the preview step: it is what writes the optimistic change into the
    // working copy, so its call count IS the "did the drag engage" signal.
    const preview = vi.spyOn(component as unknown as { applyPreview: (d: unknown) => void }, 'applyPreview');

    bar.dispatchEvent(pointer('pointerdown', 100, 50));
    expect(component['drag']()).not.toBeNull(); // the gesture really started

    // Half one: a 3px nudge (a tap with a shaky finger) previews nothing. RED if
    // the threshold is removed. This half alone is not enough — see below.
    bar.dispatchEvent(pointer('pointermove', 103, 50));
    expect(preview).toHaveBeenCalledTimes(0);
    expect(component['drag']()!.moved).toBe(false);

    // Half two: past the threshold the drag engages, exactly once. RED if the
    // threshold refuses everything — which is how relaxing touch-action to pan-x
    // could otherwise disable dragging outright while half one stayed green.
    bar.dispatchEvent(pointer('pointermove', 120, 50));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(component['drag']()!.moved).toBe(true);
  });

  it('engages on a purely VERTICAL drag, which is the only way to reassign by pointer', async () => {
    const { host, component } = await render();
    const bar = bars(host)[0];
    const preview = vi.spyOn(component as unknown as { applyPreview: (d: unknown) => void }, 'applyPreview');

    bar.dispatchEvent(pointer('pointerdown', 100, 50));
    // No horizontal travel at all: an X-only threshold would refuse this forever
    // and silently kill drag-to-reassign.
    bar.dispatchEvent(pointer('pointermove', 100, 90));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(component['drag']()!.moved).toBe(true);
  });
});

describe('ScheduleComponent — narrow-viewport contract (static: jsdom lays out nothing)', () => {
  it('floors the sticky lane column against the viewport instead of a fixed 13rem', () => {
    // A fixed 13rem pinned 208 of the 288px content box at 320px, leaving 80px —
    // less than one week column. jsdom CANNOT prove the 288−208 < 88 arithmetic
    // (no layout, offsetWidth is 0, sticky is unimplemented); this pins the
    // declaration that makes the width viewport-relative at all.
    const { component } = setup();
    expect(component['laneColWidth']).toMatch(/vw|min\(/);
    // ...and the week column gets a narrow-viewport override, or capping the lane
    // alone still leaves less than a full week visible.
    expect(COMPONENT_SRC).toMatch(/@media \(max-width: 480px\)[\s\S]*?--week-col:/);
  });

  it('gives the resize handles a 24px pointer target while keeping the 9px grip', () => {
    const handle = cssBlock(COMPONENT_SRC, '.command-schedule-handle');
    // The handles are the only pointer route to a booking's start/end.
    expect(handle).toMatch(/width:\s*(24px|1\.5rem)/);
    // ABSENCE twin: the old 9px hit box must be gone from the target itself, and
    // present on the ::before grip — so the fix cannot be "call it 24 and also
    // leave a 9px box", nor "grow it and lose the visible affordance".
    expect(handle).not.toMatch(/width:\s*9px/);
    expect(cssBlock(COMPONENT_SRC, '.command-schedule-handle::before')).toMatch(/width:\s*9px/);
  });

  it('lets a horizontal swipe that starts on a bar reach the timeline scroller', () => {
    const barBlock = cssBlock(COMPONENT_SRC, '.command-schedule-bar');
    expect(barBlock).toMatch(/touch-action:\s*pan-x/);
    // The resize handles keep touch-action: none — they are not a pan surface.
    expect(cssBlock(COMPONENT_SRC, '.command-schedule-handle')).toMatch(/touch-action:\s*none/);
  });
});

describe('ScheduleComponent — booking-bar label contrast (token arithmetic, not token names)', () => {
  /**
   * The label colour and fill the bar rule DECLARES, read out of the component
   * source: the ratio below then measures what actually ships instead of a
   * hard-coded restatement of it, so reverting the declaration turns it red.
   */
  function declaredBarColours(): { foreground: string; mixPct: number; backdrop: string } {
    const block = cssBlock(COMPONENT_SRC, '.command-schedule-bar');
    const fg = /^\s*color:\s*var\((--[\w-]+)\)/m.exec(block);
    const pct = /background:\s*color-mix\(in oklch,[\s\S]*?(\d+)%/.exec(block);
    const backdrop = /background:\s*color-mix\(in oklch,[\s\S]*?\d+%,\s*var\((--[\w-]+)\)/.exec(block);
    expect(fg, 'the bar must declare its label colour as a theme token').not.toBeNull();
    expect(pct, 'the bar fill must be a color-mix of the series colour').not.toBeNull();
    expect(backdrop, 'the bar fill must mix the series colour into a surface token').not.toBeNull();
    return { foreground: fg![1], mixPct: Number(pct![1]), backdrop: backdrop![1] };
  }

  it('clears AA for all seven series in BOTH themes', () => {
    const { foreground, mixPct, backdrop } = declaredBarColours();

    for (const [theme, block] of [['light', LIGHT_TOKENS], ['dark', DARK_TOKENS]] as const) {
      const surface = token(block, backdrop);
      const ink = token(block, foreground);

      for (let n = 1; n <= 7; n++) {
        const bg = mixOklch(token(block, `--color-series-${n}`), surface, mixPct);
        // The RATIO, not the token name: asserting a token name would have been
        // green against the 3.19:1 this screen actually shipped. (Measures
        // 11.0–14.8:1 across the fourteen series/theme pairs.)
        expect(contrast(ink, bg), `${theme} series-${n} label on bar`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('measures BOTH arrangements it replaced as sub-AA, under the same arithmetic', () => {
    // Calibration, and the assertion of absence for the test above: if the helper
    // simply returned large numbers, "clears AA" would mean nothing. These are the
    // two things the bar could otherwise have declared, and both must come out
    // below the 4.5 floor here — which is also why swapping white for the ink
    // token on the SOLID fill was not an acceptable minimal fix.
    const darkSurfaceInk = token(DARK_TOKENS, '--color-ink');
    for (let n = 1; n <= 7; n++) {
      const series = token(DARK_TOKENS, `--color-series-${n}`);
      expect(contrast(WHITE, series), `dark series-${n}, white on the solid fill`).toBeLessThan(4.5);
      expect(contrast(darkSurfaceInk, series), `dark series-${n}, ink on the solid fill`).toBeLessThan(4.5);
    }
    // Light theme: amber is the series that fails there, and ink-inverse IS white
    // in light, so there was no token swap available at all.
    expect(contrast(WHITE, token(LIGHT_TOKENS, '--color-series-4'))).toBeLessThan(4.5);
  });

  it('declares no literal white foreground on the bar', () => {
    const barBlock = cssBlock(COMPONENT_SRC, '.command-schedule-bar');
    expect(barBlock).toMatch(/color:\s*var\(--color-ink\)/);
    // Scoped to this block so the legitimate white elsewhere is not swept in.
    expect(barBlock).not.toMatch(/color:\s*(#fff\b|#ffffff\b|white\b)/i);
    // Non-vacuity: the identical scan DOES find the foreground the conflict rule
    // declares, proving it is really reading these declarations.
    expect(cssBlock(COMPONENT_SRC, '.command-schedule-bar.is-conflict')).toMatch(
      /color:\s*var\(--color-critical-text\)/,
    );
  });
});

/**
 * B12 / P2-21 — the timeline's "this week" anchor.
 *
 * This file currently covers ONLY that rule: it needs no TestBed, since the
 * anchor is an exported pure function with an injectable clock. The component
 * itself still has no spec (B11 owns writing one — keyboard reassign, the drag
 * threshold and the ARIA rows); add those describes here rather than starting a
 * second file.
 *
 * Both cases pin a real timezone, because the defect is unreachable without one:
 * under TZ=UTC `mondayUtcMs(Date.now())` and `mondayUtcMs(todayLocalUtcMs())`
 * agree on every instant, so an unpinned test certifies nothing. The pin is
 * restored afterwards so a later file in the same worker sees the machine's zone.
 *
 * 2026-08-03 is a Monday, which is what makes these two instants — 90 minutes
 * apart in real time — land on DIFFERENT WEEKS rather than adjacent days.
 */
describe('Schedule week anchor (P2-21)', () => {
  const originalTz = process.env['TZ'];
  afterEach(() => { process.env['TZ'] = originalTz; });

  /** The anchor read back as a UTC date string: what week the grid opens on. */
  const anchorDate = (iso: string) => new Date(currentWeekAnchorMs(() => new Date(iso))).toISOString().slice(0, 10);

  it('opens on the Monday of the user\'s local week, not of the UTC week (positive offset)', () => {
    process.env['TZ'] = 'Europe/Rome'; // UTC+2 in August
    // 00:30 on Monday 3 August in Rome. In UTC it is still Sunday the 2nd, so
    // the pre-fix anchor was Monday 27 JULY — the grid opened a whole week
    // behind, with today off the right-hand edge of the visible horizon.
    expect(anchorDate('2026-08-02T23:30:00.000Z')).toBe('2026-08-03');
  });

  it('opens on the Monday of the user\'s local week, not of the UTC week (negative offset)', () => {
    process.env['TZ'] = 'America/New_York'; // UTC-4 in August
    // 22:30 on Sunday 2 August in New York. In UTC it is already Monday the 3rd,
    // so the pre-fix anchor jumped the grid a week AHEAD of the user's own week.
    expect(anchorDate('2026-08-03T02:30:00.000Z')).toBe('2026-07-27');
  });

  it('is midnight UTC, so the week-column arithmetic starts on a day boundary', () => {
    process.env['TZ'] = 'Europe/Rome';
    expect(currentWeekAnchorMs(() => new Date('2026-08-05T13:00:00.000Z'))).toBe(Date.UTC(2026, 7, 3));
  });
});
