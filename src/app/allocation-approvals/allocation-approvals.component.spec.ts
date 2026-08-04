import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { AllocationApprovalsComponent } from './allocation-approvals.component';
import { AllocationApprovalFeed, ApiService, ResourceOrganization } from '../services/api.service';
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

function setup(ready: boolean, overrides: {
  orgNodes?: ResourceOrganization[];
  feed?: AllocationApprovalFeed;
  /** For status-aware fixtures: supply the whole mock instead of a static feed. */
  getAllocationApprovals?: ReturnType<typeof vi.fn>;
} = {}) {
  // D (Task 8, round 2): `AllocationApprovalRow` now carries `organization`
  // straight from the server (the handler already has the resource record in
  // hand when it builds the row) — there is no second getResources() load to
  // stub here any more. Only the org tree (getResourceOrganizations) remains.
  const getAllocationApprovals = overrides.getAllocationApprovals ?? vi.fn(() => of(overrides.feed ?? FEED));
  const getResourceOrganizations = vi.fn(() => of(overrides.orgNodes ?? []));
  const apiStub = { getAllocationApprovals, getResourceOrganizations } as unknown as ApiService;
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

    /**
     * Jane Doe (Backend, two levels under Engineering, manager m1/"Mona
     * Manager") and John Miller (Consulting directly, manager m2/"Nora
     * Manager") — John carries the sole pending item, so the KPI-consistency
     * test below has something to lose when the capability filter excludes
     * him. `organization` AND `managerName` now live directly on the row
     * (server-populated, rounds 2 and 3) — no separate resources fixture, and
     * no synthetic "manager's own row" needed: a real feed almost never
     * contains one (it lists a manager's REPORTS, not the manager), so the
     * server resolves the name once, from the resource record it already has,
     * rather than the client hunting for a self-reference that is usually
     * absent.
     */
    const ORG_FEED: AllocationApprovalFeed = {
      months: ['2026-09'],
      rows: [
        {
          resourceId: 'r10', resourceName: 'Jane Doe', managerId: 'm1', managerName: 'Mona Manager', kind: 'internal', contractHoursPerDay: 8,
          targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 100 }, items: [],
          organization: 'Backend',
        },
        {
          resourceId: 'r11', resourceName: 'John Miller', managerId: 'm2', managerName: 'Nora Manager', kind: 'internal', contractHoursPerDay: 8,
          targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 50 },
          items: [{ assignmentMonthId: 'A11:2026-09', assignmentId: 'A11', month: '2026-09', status: 'Requested', requestId: '11', projectName: 'Consulting Gig', hours: 50, approvalId: 'AR11' }],
          organization: 'Consulting',
        },
      ],
    };

    it('filters the list by capability', async () => {
      // Fixture: one resource on 'Backend' (competence under Platform under Engineering),
      // one on 'Consulting' (a capability of its own).
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      const host = fixture.nativeElement as HTMLElement;
      const names = [...host.querySelectorAll('[data-test="resource-name"]')].map(e => e.textContent?.trim());
      expect(names).toContain('Jane Doe');        // on Backend, under Engineering
      expect(names).not.toContain('John Miller'); // on Consulting
    });

    it('drops selected resources that become hidden by an organization filter', async () => {
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;

      host.querySelectorAll<HTMLInputElement>('[data-test="select-resource"]').forEach(cb => cb.click());
      fixture.detectChanges();
      expect([...fixture.componentInstance.selectedResourceIds()]).toEqual(['r10', 'r11']);

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();

      expect([...fixture.componentInstance.selectedResourceIds()]).toEqual(['r10']);
      expect((host.querySelector('[data-test="multi-approve"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('keeps the Pending Project-Months KPI consistent with the filtered grid', async () => {
      // Regression: pendingMonths must be reduced over the SAME filtered row set
      // rows() draws its grid from, not the raw unfiltered feed — otherwise the
      // KPI strip can show a pending month for a capability the grid has just
      // filtered down to zero resources for.
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
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
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const opts = [...host.querySelectorAll<HTMLOptionElement>('[data-test="capability-filter"] option')]
        .map(o => o.value);
      expect(opts).toEqual(['', 'Engineering', 'Consulting']);   // '' = all
    });

    it('filters the list by practice and by competence', async () => {
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
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
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
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

    it('shows the manager NAME in the dropdown option, not the raw resource id (D, Task 8 round 3)', async () => {
      // Regression: a feed lists a manager's REPORTS, not the manager
      // themselves, so there is (almost) never a row to resolve a name from
      // client-side — the server now serves `managerName` directly on each
      // row. Neither Mona Manager (m1) nor Nora Manager (m2) has a row of
      // their own anywhere in this fixture; if `managerName` were dropped
      // (or the component reverted to the old feed-self-reference lookup),
      // this would show the bare ids 'm1'/'m2' instead.
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);

      const host = fixture.nativeElement as HTMLElement;
      const options = [...host.querySelectorAll<HTMLOptionElement>('[data-test="manager-filter"] option')];
      const forM1 = options.find(o => o.value === 'm1');
      const forM2 = options.find(o => o.value === 'm2');
      expect(forM1?.textContent?.trim()).toBe('Mona Manager');
      expect(forM2?.textContent?.trim()).toBe('Nora Manager');
      // The failure mode this guards against, spelled out: neither option's
      // rendered text is the raw id it's keyed by.
      expect(forM1?.textContent?.trim()).not.toBe('m1');
      expect(forM2?.textContent?.trim()).not.toBe('m2');
    });

    it('composes two dimension filters (capability AND manager) — the intersection, not the union', async () => {
      // Jane Doe (Backend/Engineering, manager m1) and John Miller
      // (Consulting, manager m2) sit on DISJOINT capability/manager pairs.
      // An OR-composition bug would keep BOTH once a second filter is added
      // (either one matches); the correct AND keeps NEITHER.
      const { fixture } = setup(true, { orgNodes: ORG_NODES, feed: ORG_FEED });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const rows = () => host.querySelectorAll('[data-test="approval-row"]');

      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      expect(rows().length).toBe(1); // Jane Doe alone

      fixture.componentInstance.managerFilter.set('m2');
      fixture.detectChanges();
      // AND, not OR: capability=Engineering matches only Jane; manager=m2
      // matches only John. Their intersection is empty — a future edit that
      // silently OR'd the two predicates together would show both (2 rows)
      // instead of the correct 0.
      expect(rows().length).toBe(0);

      fixture.componentInstance.capabilityFilter.set('');
      fixture.detectChanges();
      expect(rows().length).toBe(1); // manager=m2 alone is John Miller
      expect(rows()[0].textContent).toContain('John Miller');
    });

    it('composes a dimension filter with the pre-existing status filter — the intersection, not either alone', async () => {
      // Status is a FETCH parameter here (server-side), not an in-memory
      // predicate like the dimension filters — this locks in that the two
      // still compose correctly: switching status re-fetches a different
      // feed, and the capability filter must keep narrowing whatever comes
      // back, rather than one silently overriding the other.
      const FEED_REQUESTED: AllocationApprovalFeed = {
        months: ['2026-09'],
        rows: [
          {
            resourceId: 'r20', resourceName: 'Priya Pending', managerId: 'm3', kind: 'internal', contractHoursPerDay: 8,
            targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 80 }, organization: 'Engineering',
            items: [{ assignmentMonthId: 'A20:2026-09', assignmentId: 'A20', month: '2026-09', status: 'Requested', requestId: '20', projectName: 'Nebula', hours: 80, approvalId: 'AR20' }],
          },
        ],
      };
      const FEED_ALL: AllocationApprovalFeed = {
        months: ['2026-09'],
        rows: [
          ...FEED_REQUESTED.rows,
          {
            resourceId: 'r21', resourceName: 'Sam Settled', managerId: 'm3', kind: 'internal', contractHoursPerDay: 8,
            targetHours: { '2026-09': 176 }, totalHours: { '2026-09': 176 }, organization: 'Consulting',
            items: [{ assignmentMonthId: 'A21:2026-09', assignmentId: 'A21', month: '2026-09', status: 'Allocated', requestId: '21', projectName: 'Orion', hours: 176 }],
          },
        ],
      };
      const getAllocationApprovals = vi.fn((_from?: string, _to?: string, status?: string) =>
        of(status === 'Requested' ? FEED_REQUESTED : FEED_ALL));
      const { fixture } = setup(true, { orgNodes: ORG_NODES, getAllocationApprovals });
      await flush(fixture);
      const host = fixture.nativeElement as HTMLElement;
      const rows = () => host.querySelectorAll('[data-test="approval-row"]');

      // Default status is 'Requested' (Pending) — only Priya is ever fetched.
      expect(rows().length).toBe(1);
      expect(rows()[0].textContent).toContain('Priya Pending');

      // Switch to 'All': the fetch itself now returns BOTH resources.
      const statusSelect = host.querySelector('[data-test="status-filter"]') as HTMLSelectElement;
      statusSelect.value = 'all';
      statusSelect.dispatchEvent(new Event('change'));
      await flush(fixture);
      expect(rows().length).toBe(2);

      // Adding the Engineering capability filter on top must narrow it BACK
      // to just Priya — the AND of "status=All" and "capability=Engineering",
      // not either alone (2 resources, or the un-narrowed all-statuses feed).
      fixture.componentInstance.capabilityFilter.set('Engineering');
      fixture.detectChanges();
      expect(rows().length).toBe(1);
      expect(rows()[0].textContent).toContain('Priya Pending');
    });
  });
});
