import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { ProjectPlans } from './project-plans';
import { ApiService, Milestone, Project, WorkPackage } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * `whenStable()` HANGS while an `rxResource` stream is still open; every stub here
 * resolves synchronously, so microtask ticks are the established idiom in this repo
 * (project-rates.spec.ts) for letting an `rxResource` read reach the DOM.
 */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

/**
 * MILESTONE "ACHIEVED" IS A MONEY EVENT. server.ts's MILESTONE_FIELDS comment calls
 * it "a document that RELEASES MONEY": the PUT flips every linked fixed-price
 * BillingPlanItem from 'Planned' to 'Ready', which is what un-gates /billing's
 * "Generate invoice". It used to fire on one unconfirmed click behind a chip
 * labelled "Approve", and the chip then disappears, so a mis-click had no reversal
 * anywhere in the UI.
 */
describe('ProjectPlans — achieving a milestone releases money, so it is confirmed', () => {
  const project: Project = {
    id: 'P1', name: 'Project Alpha', location: 'Rome', startDate: '2026-01-01',
    endDate: '2026-12-31', status: 'In Execution', ownerId: 'R1', contractId: 'CT1',
  };
  const pendingMilestone: Milestone = {
    id: 'MS1', projectId: 'P1', name: 'SAL 2', date: '2026-06-30', status: 'Pending',
  };

  function baseStub(overrides: Record<string, unknown> = {}) {
    return {
      getProjects: () => of([project]),
      getResources: () => of([]),
      getWorkPackages: () => of([] as WorkPackage[]),
      getMilestones: () => of([pendingMilestone]),
      updateMilestone: vi.fn(() => of(pendingMilestone)),
      ...overrides,
    } as unknown as ApiService & { updateMilestone: ReturnType<typeof vi.fn> };
  }

  async function setUp(apiStub: ApiService): Promise<ComponentFixture<ProjectPlans>> {
    const authStub = { authReady: signal(true), userId: signal('U-actor') } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;
    TestBed.configureTestingModule({
      imports: [ProjectPlans],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ProjectPlans> = TestBed.createComponent(ProjectPlans);
    fixture.componentRef.setInput('projectId', 'P1');
    await tick(fixture);
    return fixture;
  }

  function achieveChip(h: HTMLElement): HTMLButtonElement {
    const chip = h.querySelector<HTMLButtonElement>('[data-test="achieve-milestone"]');
    expect(chip).toBeTruthy();
    return chip!;
  }

  afterEach(() => TestBed.resetTestingModule());

  it('the FIRST click issues no updateMilestone and instead names the milestone and says its conditions become invoiceable', async () => {
    const api = baseStub();
    const fixture = await setUp(api);
    const h = host(fixture);

    // No dialog before the click — otherwise "the confirm exists" proves nothing.
    expect(h.querySelector('[data-test="achieve-milestone-confirm"]')).toBeNull();

    achieveChip(h).click();
    await tick(fixture);

    // THE ASSERTION OF ABSENCE: the money-releasing PUT must not have gone out.
    expect(api.updateMilestone).not.toHaveBeenCalled();

    const confirm = h.querySelector('[data-test="achieve-milestone-confirm"]');
    expect(confirm).toBeTruthy();
    const text = confirm!.textContent ?? '';
    // Names the object...
    expect(text).toContain('SAL 2');
    // ...and states the consequence. A bare "Are you sure?" cannot satisfy this.
    expect(text).toMatch(/invoiceab|billab/i);
    // ...and admits there is no reversal, because there genuinely is none.
    expect(text).toMatch(/cannot be undone/i);
  });

  it('the confirm control issues exactly ONE updateMilestone, with status Achieved and NO client-supplied approvedBy', async () => {
    const api = baseStub();
    const fixture = await setUp(api);
    const h = host(fixture);

    achieveChip(h).click();
    await tick(fixture);

    const confirmAction = h.querySelector<HTMLButtonElement>('[data-test="achieve-milestone-confirm-action"]');
    expect(confirmAction).toBeTruthy();
    confirmAction!.click();
    await tick(fixture);

    expect(api.updateMilestone).toHaveBeenCalledTimes(1);
    const [id, body] = api.updateMilestone.mock.calls[0] as [string, Partial<Milestone>];
    expect(id).toBe('MS1');
    // `approvedBy`/`approvedAt` are absent from server.ts's MILESTONE_FIELDS and are
    // pinned by `milestoneApprovalPatch` to the verified principal. toStrictEqual +
    // the explicit key check because `toEqual({approvedBy: undefined})` is satisfied
    // by `{}` — the trap this repo has already paid for.
    expect(body).toStrictEqual({ status: 'Achieved' });
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('Cancel closes the confirm and still issues no updateMilestone', async () => {
    const api = baseStub();
    const fixture = await setUp(api);
    const h = host(fixture);

    achieveChip(h).click();
    await tick(fixture);

    const cancel = [...h.querySelectorAll<HTMLButtonElement>('[data-test="achieve-milestone-confirm"] button')]
      .find(b => b.textContent?.trim() === 'Cancel');
    expect(cancel).toBeTruthy();
    cancel!.click();
    await tick(fixture);

    expect(h.querySelector('[data-test="achieve-milestone-confirm"]')).toBeNull();
    expect(api.updateMilestone).not.toHaveBeenCalled();
  });

  /**
   * The guard-that-always-refuses twin: a confirm wired to a dead handler would
   * pass every assertion above. This is the case that must still be ALLOWED
   * through, end to end, and it also pins that the chip is gone afterwards.
   */
  it('an achieved milestone shows no achieve chip at all, so the confirmed path is the only route to the PUT', async () => {
    const achieved: Milestone = { ...pendingMilestone, id: 'MS2', name: 'SAL 1', status: 'Achieved', approvedBy: 'U-other' };
    const api = baseStub({ getMilestones: () => of([achieved]) });
    const fixture = await setUp(api);
    const h = host(fixture);

    expect(h.querySelector('[data-test="achieve-milestone"]')).toBeNull();
    expect(h.textContent).toContain('Approved by U-other');
    expect(api.updateMilestone).not.toHaveBeenCalled();
  });
});

const PLAN_PROJECT: Project = {
  id: 'P1', name: 'Project Alpha', location: 'Rome', startDate: '2026-01-01',
  endDate: '2026-12-31', status: 'In Execution', ownerId: 'R1', contractId: 'CT1',
};
const PLAN_WP: WorkPackage = {
  id: 'WP1', projectId: 'P1', name: 'Requirements Analysis', startDate: '2026-02-01',
  endDate: '2026-03-31', status: 'In Progress', progress: 40, assignee: 'Anna Rossi',
};
const PENDING_MS: Milestone = {
  id: 'MS1', projectId: 'P1', name: 'SAL 2', date: '2026-06-30', status: 'Pending',
};

async function setUpPlans(overrides: Record<string, unknown> = {}): Promise<ComponentFixture<ProjectPlans>> {
  const api = {
    getProjects: () => of([PLAN_PROJECT]),
    getResources: () => of([]),
    getWorkPackages: () => of([PLAN_WP]),
    getMilestones: () => of([PENDING_MS]),
    createMilestone: vi.fn(() => of(PENDING_MS)),
    createWorkPackage: vi.fn(() => of(PLAN_WP)),
    updateWorkPackage: vi.fn(() => of(PLAN_WP)),
    updateMilestone: vi.fn(() => of(PENDING_MS)),
    ...overrides,
  } as unknown as ApiService;
  TestBed.configureTestingModule({
    imports: [ProjectPlans],
    providers: [
      { provide: ApiService, useValue: api },
      // authReady() MUST be true, or every authGatedResource stays on its empty
      // default and no plan row renders at all.
      { provide: AuthService, useValue: { authReady: signal(true), userId: signal('U-actor') } as unknown as AuthService },
      { provide: NotificationService, useValue: { show: vi.fn() } as unknown as NotificationService },
    ],
  });
  await TestBed.compileComponents();
  const fixture: ComponentFixture<ProjectPlans> = TestBed.createComponent(ProjectPlans);
  fixture.componentRef.setInput('projectId', 'P1');
  await tick(fixture);
  return fixture;
}

/**
 * jsdom performs NO layout: offsetHeight is 0, there is no viewport, and no
 * stylesheet is loaded. These cases therefore assert the STRUCTURAL PRECONDITION of
 * scroll-safety — which class tokens sit on which element — and nothing about
 * reachability at 320px. The height arithmetic is only demonstrable in a real
 * browser (320x460, the Save button's getBoundingClientRect().bottom <= innerHeight)
 * and this repo has no browser runner. Same caveat, and the same predicate, as
 * manage-rate-cards.component.spec.ts.
 */
describe('ProjectPlans form overlays — STRUCTURAL scroll-safety contract only (jsdom performs no layout)', () => {
  /**
   * Evaluated on TOKENS, not on the raw class string: 'items-center' is a substring
   * of 'sm:items-center', so a className.includes() check would be satisfied by the
   * very class that has to go — the class-string form of the trap where
   * toContain('0%') matches '100%'.
   */
  function scrollSafety(overlay: HTMLElement, panel: HTMLElement) {
    const overlayTokens = overlay.className.split(/\s+/);
    const body = panel.querySelector<HTMLElement>('div.overflow-y-auto');
    return {
      overlayScrolls: overlayTokens.includes('overflow-y-auto'),
      anchoredOnShortViewports: overlayTokens.includes('items-start') && !overlayTokens.includes('items-center'),
      recentredOnWideViewports: overlayTokens.includes('sm:items-center'),
      panelBounded: /max-h-\[/.test(panel.className),
      bodyScrolls: !!body && body.className.split(/\s+/).includes('min-h-0'),
    };
  }

  const SAFE = {
    overlayScrolls: true,
    anchoredOnShortViewports: true,
    recentredOnWideViewports: true,
    panelBounded: true,
    bodyScrolls: true,
  };

  function region(h: HTMLElement, name: string): { overlay: HTMLElement; panel: HTMLElement } {
    const overlay = h.querySelector<HTMLElement>(`[data-test="${name}-overlay"]`);
    const panel = h.querySelector<HTMLElement>(`[data-test="${name}-panel"]`);
    expect(overlay, `the ${name} overlay must be rendered`).toBeTruthy();
    expect(panel, `the ${name} panel must be rendered`).toBeTruthy();
    return { overlay: overlay!, panel: panel! };
  }

  afterEach(() => TestBed.resetTestingModule());

  it('the Add Milestone overlay declares its own scroller, a top anchor and a bounded panel whose body scrolls', async () => {
    const fixture = await setUpPlans();
    fixture.componentInstance.openMilestoneForm();
    await tick(fixture);
    const { overlay, panel } = region(host(fixture), 'milestone-form');
    expect(scrollSafety(overlay, panel)).toStrictEqual(SAFE);
  });

  it('the Add Work Package overlay does the same', async () => {
    const fixture = await setUpPlans();
    fixture.componentInstance.openWpForm();
    await tick(fixture);
    const { overlay, panel } = region(host(fixture), 'wp-form');
    expect(scrollSafety(overlay, panel)).toStrictEqual(SAFE);
  });

  it('the Edit Work Package overlay does the same — it is the tallest of the three', async () => {
    const fixture = await setUpPlans();
    fixture.componentInstance.openEditWpForm(PLAN_WP);
    await tick(fixture);
    const { overlay, panel } = region(host(fixture), 'edit-wp-form');
    expect(scrollSafety(overlay, panel)).toStrictEqual(SAFE);
  });

  it('rejects the achieve confirmation overlay — the negative control that keeps the predicate honest', async () => {
    // NON-VACUOUSNESS. The predicate must discriminate a scroll-safe overlay from a
    // clipping one, or it is a class-string tautology. The control is a REAL element
    // rendered by this very component: the achieve confirmation is a short dialog
    // (icon + title + two lines + footer) that fits the ~460px a 320x568 phone
    // leaves, so it deliberately keeps the plain centred overlay — whose className is
    // exactly what the three FORM overlays carried before the fix. A predicate that
    // passed it would pass the defect.
    const fixture = await setUpPlans();
    const h = host(fixture);
    h.querySelector<HTMLButtonElement>('[data-test="achieve-milestone"]')!.click();
    await tick(fixture);

    const panel = h.querySelector<HTMLElement>('[data-test="achieve-milestone-confirm"]')!;
    const overlay = panel.parentElement!;
    const verdict = scrollSafety(overlay, panel);
    expect(verdict.overlayScrolls).toBe(false);
    expect(verdict.anchoredOnShortViewports).toBe(false);
    expect(verdict).not.toStrictEqual(SAFE);
  });
});

describe('ProjectPlans — the three plan dialogs survive a refused write', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('the Add Milestone dialog stays open with its typed values when the POST is refused', async () => {
    // THE DEFECT: closeMilestoneForm() ran unconditionally right after firing the
    // POST, so the reset wiped the name and date while the request was still in
    // flight and a refusal left a toast over an empty screen.
    const fixture = await setUpPlans({
      createMilestone: () => throwError(() => new HttpErrorResponse({ status: 403 })),
    });
    const c = fixture.componentInstance;
    c.openMilestoneForm();
    c.milestoneForm.setValue({ name: 'SAL 3', date: '2026-09-30' });
    c.saveMilestone();
    await tick(fixture);

    expect(c.showMilestoneForm()).toBe(true);
    expect(c.milestoneForm.getRawValue()).toStrictEqual({ name: 'SAL 3', date: '2026-09-30' });
    expect(host(fixture).querySelector('[data-test="plan-save-error"]')?.textContent)
      .toContain('Could not save the milestone.');
  });

  it('MUST STILL close and reset the Add Milestone dialog when the POST is accepted', async () => {
    // The assertion of ABSENCE: "never close the dialog" passes the case above and
    // fails here.
    const fixture = await setUpPlans();
    const c = fixture.componentInstance;
    c.openMilestoneForm();
    c.milestoneForm.setValue({ name: 'SAL 3', date: '2026-09-30' });
    c.saveMilestone();
    await tick(fixture);

    expect(c.showMilestoneForm()).toBe(false);
    expect(c.milestoneForm.controls.name.value).toBeNull();
    expect(host(fixture).querySelector('[data-test="plan-save-error"]')).toBeNull();
  });

  it('the Add Work Package dialog stays open with its typed values when the POST is refused', async () => {
    // The third form. Covered on its own rather than assumed from the other two: a
    // sweep whose red is observed at one site has proven one site.
    const fixture = await setUpPlans({
      createWorkPackage: () => throwError(() => new HttpErrorResponse({ status: 403 })),
    });
    const c = fixture.componentInstance;
    c.openWpForm();
    c.wpForm.setValue({
      name: 'Data migration', startDate: '2026-04-01', endDate: '2026-05-31', assignee: 'Anna Rossi',
    });
    c.saveWp();
    await tick(fixture);

    expect(c.showWpForm()).toBe(true);
    expect(c.wpForm.getRawValue()).toStrictEqual({
      name: 'Data migration', startDate: '2026-04-01', endDate: '2026-05-31', assignee: 'Anna Rossi',
    });
    expect(host(fixture).querySelector('[data-test="plan-save-error"]')?.textContent)
      .toContain('Could not save the work package.');
  });

  it('MUST STILL close and reset the Add Work Package dialog when the POST is accepted', async () => {
    const fixture = await setUpPlans();
    const c = fixture.componentInstance;
    c.openWpForm();
    c.wpForm.setValue({
      name: 'Data migration', startDate: '2026-04-01', endDate: '2026-05-31', assignee: 'Anna Rossi',
    });
    c.saveWp();
    await tick(fixture);

    expect(c.showWpForm()).toBe(false);
    expect(c.wpForm.controls.name.value).toBeNull();
    expect(host(fixture).querySelector('[data-test="plan-save-error"]')).toBeNull();
  });

  it('the Edit Work Package dialog keeps BOTH its values and the id being edited when the PUT is refused', async () => {
    // The worst case of the three: closeEditWpForm() also clears editingWpId, so a
    // refusal used to lose which work package was being edited.
    const fixture = await setUpPlans({
      updateWorkPackage: () => throwError(() => new HttpErrorResponse({ status: 403 })),
    });
    const c = fixture.componentInstance;
    c.openEditWpForm(PLAN_WP);
    c.editWpForm.controls.progress.setValue(75);
    c.saveEditWp();
    await tick(fixture);

    expect(c.showEditWpForm()).toBe(true);
    expect(c.editingWpId()).toBe('WP1');
    expect(c.editWpForm.controls.progress.value).toBe(75);
  });

  it('MUST STILL close the Edit Work Package dialog and clear the edited id when the PUT is accepted', async () => {
    const fixture = await setUpPlans();
    const c = fixture.componentInstance;
    c.openEditWpForm(PLAN_WP);
    c.editWpForm.controls.progress.setValue(75);
    c.saveEditWp();
    await tick(fixture);

    expect(c.showEditWpForm()).toBe(false);
    expect(c.editingWpId()).toBeNull();
  });
});
