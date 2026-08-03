import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AllocationApprovalsComponent } from './allocation-approvals.component';
import { AllocationApprovalFeed, ApiService, Resource, ResourceOrganization } from '../services/api.service';
import { AuthService } from '../services/auth.service';

/** Two resources over one month: Ada has a pending month, Bob only approved work. */
const FEED: AllocationApprovalFeed = {
  months: ['2026-09'],
  rows: [
    {
      resourceId: 'r1', resourceName: 'Ada', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 88 },
      items: [{ assignmentMonthId: 'A1:2026-09', assignmentId: 'A1', month: '2026-09', status: 'Requested', requestId: '1', projectName: 'Apollo', hours: 88, approvalId: 'AR1' }],
    },
    {
      resourceId: 'r2', resourceName: 'Bob', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
      targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 176 },
      items: [{ assignmentMonthId: 'A2:2026-09', assignmentId: 'A2', month: '2026-09', status: 'Allocated', requestId: '2', projectName: 'Gemini', hours: 176 }],
    },
  ],
};

function setup(ready: boolean, overrides: { resources?: Resource[]; orgNodes?: ResourceOrganization[]; feed?: AllocationApprovalFeed } = {}) {
  const getAllocationApprovals = vi.fn(() => of(overrides.feed ?? FEED));
  // D (Task 8): `AllocationApprovalRow` carries no `organization` — the capability/
  // practice/competence filters resolve it via a client-side join against the
  // resources catalog (getResources), same as the org tree comes from
  // getResourceOrganizations. Both default empty so existing feed-only specs are unaffected.
  const getResources = vi.fn(() => of(overrides.resources ?? []));
  const getResourceOrganizations = vi.fn(() => of(overrides.orgNodes ?? []));
  const apiStub = { getAllocationApprovals, getResources, getResourceOrganizations } as unknown as ApiService;
  // `role`/`userId` are read by the embedded ApprovalModalComponent's
  // decidability check; an admin can decide any step, so the modal cases below
  // exercise the modal itself rather than the gate.
  const authStub = {
    authReady: signal(ready), isAuthenticated: signal(ready),
    role: signal('admin'), userId: signal('m1'),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [AllocationApprovalsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
    ],
  });
  const fixture = TestBed.createComponent(AllocationApprovalsComponent);
  return { fixture, getAllocationApprovals };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('AllocationApprovalsComponent', () => {
  it('renders one row per resource once auth is ready', async () => {
    const { fixture, getAllocationApprovals } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const rows = host.querySelectorAll('[data-test="approval-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Ada');
    expect(rows[0].textContent).toContain('88');
    expect(getAllocationApprovals).toHaveBeenCalled();
  });

  it('seeds the From/To selects to the loaded window in the actual DOM, not just the signal', async () => {
    // Regression for the reported bug: the <select>'s live DOM `.value` must
    // match the seeded from/to signal (the loaded window), not just the signal
    // itself — a mismatch here means the browser silently fell back to the
    // first padded option because [value] was applied before the @for's
    // <option> elements existed.
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const fromEl = host.querySelector('select[aria-label="Range start month"]') as HTMLSelectElement;
    const toEl = host.querySelector('select[aria-label="Range end month"]') as HTMLSelectElement;
    expect(fromEl).not.toBeNull();
    expect(toEl).not.toBeNull();

    expect(fixture.componentInstance['from']()).toBe('2026-09');
    expect(fixture.componentInstance['to']()).toBe('2026-09');
    // The assertion that actually catches the bug: the live DOM value.
    expect(fromEl.value).toBe('2026-09');
    expect(toEl.value).toBe('2026-09');
  });

  it('does not call the API before auth is ready', async () => {
    const { fixture, getAllocationApprovals } = setup(false);
    await flush(fixture);
    expect(getAllocationApprovals).not.toHaveBeenCalled();
  });

  it('toggles a resource into the selection', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const checkbox = host.querySelector('[data-test="select-resource"]') as HTMLInputElement;
    checkbox.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.selectedResourceIds().has('r1')).toBe(true);
  });

  it('enables multi-approve only with more than one resource selected', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const button = host.querySelector('[data-test="multi-approve"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    host.querySelectorAll<HTMLInputElement>('[data-test="select-resource"]').forEach(cb => cb.click());
    fixture.detectChanges();
    expect((host.querySelector('[data-test="multi-approve"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the modal in multi mode with a section per selected resource', async () => {
    const { fixture } = setup(true);
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    host.querySelectorAll<HTMLInputElement>('[data-test="select-resource"]').forEach(cb => cb.click());
    fixture.detectChanges();
    host.querySelector<HTMLButtonElement>('[data-test="multi-approve"]')!.click();
    fixture.detectChanges();

    expect(host.querySelector('[data-test="approve-continue"]')).not.toBeNull();
    const sections = host.querySelectorAll('[data-test="resource-section"]');
    expect(sections.length).toBe(2);
    const names = Array.from(sections).map(s => s.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(['Ada', 'Bob']));
  });

  describe('org-dimension and people-manager filters (D, Task 8)', () => {
    /**
     * D (Task 8): Engineering (capability) > Platform (practice) > Backend
     * (competence), plus Consulting, a capability with no children of its own —
     * same ids the real seed uses ('2'/'5'/'6').
     */
    const ORG_NODES: ResourceOrganization[] = [
      { id: '2', name: 'Engineering', description: '', costCenters: [], level: 'capability' },
      { id: '3', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
      { id: '5', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: '2' },
      { id: '6', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: '5' },
    ];

    /** `AllocationApprovalRow` carries no `organization` of its own — the
     *  component resolves it via a client-side join against `getResources()`. */
    const ORG_RESOURCES: Resource[] = [
      { id: 'r10', name: 'Jane Doe', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Backend', managerId: 'm1' },
      { id: 'r11', name: 'John Miller', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal', organization: 'Consulting', managerId: 'm2' },
      { id: 'm1', name: 'Mona Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
      { id: 'm2', name: 'Nora Manager', role: 'Delivery Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
    ];

    /** Jane Doe (Backend, two levels under Engineering) and John Miller (Consulting
     *  directly) — John carries the sole pending item, so the KPI-consistency test
     *  below has something to lose when the capability filter excludes him. */
    const ORG_FEED: AllocationApprovalFeed = {
      months: ['2026-09'],
      rows: [
        {
          resourceId: 'r10', resourceName: 'Jane Doe', managerId: 'm1', kind: 'internal', contractHoursPerDay: 8,
          targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 100 }, items: [],
        },
        {
          resourceId: 'r11', resourceName: 'John Miller', managerId: 'm2', kind: 'internal', contractHoursPerDay: 8,
          targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 50 },
          items: [{ assignmentMonthId: 'A11:2026-09', assignmentId: 'A11', month: '2026-09', status: 'Requested', requestId: '11', projectName: 'Consulting Gig', hours: 50, approvalId: 'AR11' }],
        },
      ],
    };

    it('filters the list by capability', async () => {
      // Fixture: one resource on 'Backend' (competence under Platform under Engineering),
      // one on 'Consulting' (a capability of its own).
      const { fixture } = setup(true, { resources: ORG_RESOURCES, orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toContain('Jane Doe');        // on Backend, under Engineering
      expect(names).not.toContain('John Miller'); // on Consulting
    });

    it('keeps the Pending Project-Months KPI consistent with the filtered grid', async () => {
      // Regression: pendingMonths must be reduced over the SAME filtered row set
      // rows() draws its grid from, not the raw unfiltered feed — otherwise the
      // KPI strip can show a pending month for a capability the grid has just
      // filtered down to zero resources for.
      const { fixture } = setup(true, { resources: ORG_RESOURCES, orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      expect(host.querySelector('[data-test="kpi-pending-resources"]')?.textContent?.trim()).toBe('1');
      expect(host.querySelector('[data-test="kpi-pending-months"]')?.textContent?.trim()).toBe('1');

      // John Miller (Consulting) carries the only pending item; filtering to
      // Engineering excludes him, so BOTH KPIs must drop to zero together.
      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      expect(host.querySelector('[data-test="kpi-pending-resources"]')?.textContent?.trim()).toBe('0');
      expect(host.querySelector('[data-test="kpi-pending-months"]')?.textContent?.trim()).toBe('0');
    });

    it('offers only the dimensions that exist in the tree', async () => {
      const { fixture } = setup(true, { resources: ORG_RESOURCES, orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="capability-filter"] option')]
        .map(o => o.value);
      expect(opts).toEqual(['', 'Engineering', 'Consulting']);   // '' = all
    });

    it('filters the list by practice and by competence', async () => {
      const { fixture } = setup(true, { resources: ORG_RESOURCES, orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      fixture.componentInstance.practiceFilter.set('Platform');
      fixture.detectChanges();
      let rows = host.querySelectorAll('[data-test="approval-row"]');
      expect(rows.length).toBe(1);
      expect(rows[0].textContent).toContain('Jane Doe');

      fixture.componentInstance.practiceFilter.set('');
      fixture.componentInstance.competenceFilter.set('Backend');
      fixture.detectChanges();
      rows = host.querySelectorAll('[data-test="approval-row"]');
      expect(rows.length).toBe(1);
      expect(rows[0].textContent).toContain('Jane Doe');
    });

    it('filters the list by People Manager and offers only the managers present', async () => {
      const { fixture } = setup(true, { resources: ORG_RESOURCES, orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="manager-filter"] option')]
        .map(o => o.textContent?.trim());
      expect(opts).toEqual(['All people managers', 'Mona Manager', 'Nora Manager']);

      fixture.componentInstance.managerFilter.set('m1');
      fixture.detectChanges();
      const rows = host.querySelectorAll('[data-test="approval-row"]');
      expect(rows.length).toBe(1);
      expect(rows[0].textContent).toContain('Jane Doe');
    });
  });
});
