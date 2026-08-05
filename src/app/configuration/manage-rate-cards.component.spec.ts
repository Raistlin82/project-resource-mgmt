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
});
