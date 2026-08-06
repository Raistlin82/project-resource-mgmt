import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
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
