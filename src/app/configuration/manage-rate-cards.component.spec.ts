import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ManageRateCardsComponent } from './manage-rate-cards.component';
import { ApiService, RateCard, ProjectRole, ResourceOrganization, FxRate } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * Same shape used across this block's other specs (resources.component.spec.ts,
 * manage-resource-organizations.component.spec.ts): Engineering (capability,
 * id '2') > Platform (practice, id '5') > Backend (competence, id '6'), plus
 * Consulting (id '3'), an unrelated capability with no children of its own —
 * so the sort/indentation logic has a case that must NOT be nested under
 * Engineering by mistake.
 */
const ORG_NODES: ResourceOrganization[] = [
  { id: '2', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
  { id: '3', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
  { id: '5', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: '2' },
  { id: '6', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: '5' },
];

const ROLES: ProjectRole[] = [{ id: 'r1', code: 'Developer', name: 'Developer', description: '', restricted: false }];

function setup(orgNodes: ResourceOrganization[] = ORG_NODES, items: RateCard[] = []) {
  const getRateCards = vi.fn(() => of(items));
  const getProjectRoles = vi.fn(() => of(ROLES));
  const getResourceOrganizations = vi.fn(() => of(orgNodes));
  const getFxRates = vi.fn(() => of([] as FxRate[]));
  const getHoursPerDay = vi.fn(() => of({ value: 8 }));
  const createRateCard = vi.fn(() => of({} as RateCard));
  const updateRateCard = vi.fn(() => of({} as RateCard));
  const deleteRateCard = vi.fn(() => of(undefined));
  const apiStub = {
    getRateCards, getProjectRoles, getResourceOrganizations, getFxRates, getHoursPerDay,
    createRateCard, updateRateCard, deleteRateCard,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageRateCardsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageRateCardsComponent);
  return { fixture, getRateCards, createRateCard, updateRateCard, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ManageRateCardsComponent', () => {
  describe('organization select hierarchy indentation (rate-card-inheritance block, Task 5)', () => {
    it('orders a capability before its practice before its competence', async () => {
      const { fixture } = setup();
      await flush(fixture);
      const names = fixture.componentInstance.indentedOrgOptions().map(o => o.node.name);
      const engineeringIdx = names.indexOf('Engineering');
      const platformIdx = names.indexOf('Platform');
      const backendIdx = names.indexOf('Backend');
      expect(engineeringIdx).toBeGreaterThanOrEqual(0);
      expect(engineeringIdx).toBeLessThan(platformIdx);
      expect(platformIdx).toBeLessThan(backendIdx);
    });

    it('assigns depth 0/1/2 to capability/practice/competence respectively', async () => {
      const { fixture } = setup();
      await flush(fixture);
      const byName = new Map(fixture.componentInstance.indentedOrgOptions().map(o => [o.node.name, o.depth]));
      expect(byName.get('Engineering')).toBe(0);
      expect(byName.get('Platform')).toBe(1);
      expect(byName.get('Backend')).toBe(2);
      // Consulting is ALSO a capability (no parent) -- depth 0, not accidentally
      // inheriting a nonzero depth from its position later in the list.
      expect(byName.get('Consulting')).toBe(0);
    });

    it('renders the indentation as a visual prefix, scoped to the org select only', async () => {
      const { fixture } = setup();
      await flush(fixture);
      fixture.componentInstance.openForm();
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const options = [...host.querySelectorAll<HTMLOptionElement>('#rc-org option')];
      const engineeringOpt = options.find(o => o.value === 'Engineering');
      const backendOpt = options.find(o => o.value === 'Backend');
      expect(engineeringOpt).toBeTruthy();
      expect(backendOpt).toBeTruthy();
      // Backend (depth 2) must carry strictly more leading indentation than
      // Engineering (depth 0) -- the pair to the depth assertions above, now
      // checked against what actually renders, scoped to THIS select only.
      const leadingWs = (t: string | null) => (t ?? '').match(/^\s*/)?.[0].length ?? 0;
      expect(leadingWs(backendOpt!.textContent)).toBeGreaterThan(leadingWs(engineeringOpt!.textContent));
    });
  });

  describe('non-blocking conflict warning on save (rate-card-inheritance block, Task 6)', () => {
    /** An existing card on Engineering (an ancestor of Platform/Backend). */
    const CARD_ON_ENGINEERING: RateCard[] = [
      { id: 'ENG', role: 'Developer', organization: 'Engineering', currency: 'EUR', costRate: 640, billRate: 1200 },
    ];
    /** An existing card on Backend (a descendant of Platform/Engineering). */
    const CARD_ON_BACKEND: RateCard[] = [
      { id: 'BACK', role: 'Developer', organization: 'Backend', currency: 'EUR', costRate: 700, billRate: 1300 },
    ];

    function fillAndSave(fixture: ReturnType<typeof setup>['fixture'], organization: string) {
      const c = fixture.componentInstance;
      c.openForm();
      c.form.controls.role.setValue('Developer');
      c.form.controls.organization.setValue(organization);
      c.form.controls.currency.setValue('EUR');
      c.form.controls.costRate.setValue(660);
      c.form.controls.billRate.setValue(1250);
      c.save();
    }

    it('shows an info toast when saving a card whose node has an ancestor with a card', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, CARD_ON_ENGINEERING);
      await flush(fixture);
      fillAndSave(fixture, 'Platform');
      expect(notifyStub.show).toHaveBeenCalledWith(expect.stringContaining('This role already has a card on Engineering'), 'info');
    });

    it('shows an info toast when saving a card whose node has a descendant with its own card', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, CARD_ON_BACKEND);
      await flush(fixture);
      fillAndSave(fixture, 'Engineering');
      expect(notifyStub.show).toHaveBeenCalledWith(expect.stringContaining('This role already has a card on Backend'), 'info');
    });

    it('does NOT show the conflict toast when saving a generic card', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, CARD_ON_ENGINEERING);
      await flush(fixture);
      fillAndSave(fixture, ''); // generic -- no organization
      expect(notifyStub.show).not.toHaveBeenCalledWith(expect.anything(), 'info');
    });

    it('does NOT show the conflict toast when there is no conflict at all', async () => {
      const { fixture, notifyStub } = setup(ORG_NODES, []); // no existing cards anywhere
      await flush(fixture);
      fillAndSave(fixture, 'Platform');
      expect(notifyStub.show).not.toHaveBeenCalledWith(expect.anything(), 'info');
    });

    it('never blocks the save when a conflict is detected', async () => {
      const { fixture, createRateCard } = setup(ORG_NODES, CARD_ON_ENGINEERING);
      await flush(fixture);
      fillAndSave(fixture, 'Platform');
      expect(createRateCard).toHaveBeenCalled();
      expect(fixture.componentInstance.showForm()).toBe(false); // form closed -- save proceeded
    });

    it('editing a card to move it does not false-positive warn about its own pre-edit position', async () => {
      // Round-1 review (Important 2): this.items() is the stale pre-reload
      // cache, so on an edit it still holds the OLD copy of the very card
      // being saved -- conflictingCardMessage has no id parameter to
      // self-exclude by. The card being edited itself sits on Backend;
      // moving it to Platform must NOT warn "this role already has a card on
      // Backend" about itself. This is the ONLY test in this block that
      // exercises the edit branch of save() -- every other test here calls
      // openForm() with no argument (create path only).
      const cardToMove: RateCard = { id: 'MOVE', role: 'Developer', organization: 'Backend', currency: 'EUR', costRate: 700, billRate: 1300 };
      const { fixture, notifyStub, updateRateCard } = setup(ORG_NODES, [cardToMove]);
      await flush(fixture);
      const c = fixture.componentInstance;
      c.openForm(cardToMove); // EDIT path -- editingId() becomes 'MOVE'
      c.form.controls.organization.setValue('Platform');
      c.save();
      expect(updateRateCard).toHaveBeenCalledWith('MOVE', expect.objectContaining({ organization: 'Platform' }));
      expect(notifyStub.show).not.toHaveBeenCalledWith(expect.anything(), 'info');
    });
  });
});
