import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of } from 'rxjs';
import { UtilizationComponent } from './utilization.component';
import { ApiService, type Resource, type ResourceOrganization, type UserRole } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

// Tree: CAP 'Engineering' (managed by m1) > PRA 'Platform' > COM 'Backend'
const ORGS: ResourceOrganization[] = [
  { id: 'o1', name: 'Engineering', description: '', costCenters: [], level: 'capability', managerId: 'm1' },
  { id: 'o2', name: 'Platform', description: '', costCenters: [], level: 'practice', parentId: 'o1' },
  { id: 'o3', name: 'Backend', description: '', costCenters: [], level: 'competence', parentId: 'o2' },
  { id: 'o4', name: 'Consulting', description: '', costCenters: [], level: 'capability' },
];

const base = { skills: [], projectRoles: [], externalExperience: [], capacity: 40 };
const RESOURCES: Resource[] = [
  // reachable ONLY through the org chart (no organization at all)
  { ...base, id: 'd1', name: 'Direct Dana', role: 'Developer', utilization: 80, kind: 'internal', managerId: 'm1' },
  // reachable ONLY through the org subtree, two levels down, no org-chart link
  { ...base, id: 's1', name: 'Subtree Sven', role: 'Developer', utilization: 40, kind: 'internal', organization: 'Backend' },
  // a placeholder inside the same subtree
  { ...base, id: 'p1', name: 'Dummy Placeholder', role: 'Developer', utilization: 0, kind: 'dummy', organization: 'Platform' },
  // outside every axis
  { ...base, id: 'x1', name: 'Outside Otto', role: 'Developer', utilization: 90, kind: 'internal', organization: 'Consulting' },
] as Resource[];

function setup({ resources = RESOURCES, orgs = ORGS, userId = 'm1', role = 'resource-manager' as UserRole } = {}) {
  const apiStub = {
    getResources: vi.fn(() => of(resources)),
    getAssignments: vi.fn(() => of([])),
    getRequests: vi.fn(() => of([])),
    getTimeEntries: vi.fn(() => of([])),
    getResourceOrganizations: vi.fn(() => of(orgs)),
  } as unknown as ApiService;
  const authStub = {
    authReady: signal(true), isAuthenticated: signal(true),
    role: signal(role), userId: signal(userId),
  } as unknown as AuthService;
  const notifyStub = { success: vi.fn(), error: vi.fn() } as unknown as NotificationService;

  TestBed.configureTestingModule({
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });
  const fixture = TestBed.createComponent(UtilizationComponent);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

const names = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[data-test="team-member"]')].map(e => e.textContent?.trim() ?? '');

/** `getResources()`/`getResourceOrganizations()` (an rxResource, like every
 *  other principal-gated feed in this codebase) resolve asynchronously even
 *  over a synchronous `of(...)` stream — mirrors the `flush` helper in
 *  resources.component.spec.ts / approval-modal.component.spec.ts. Every
 *  assertion on the loaded team list needs this BEFORE reading the DOM. */
async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('UtilizationComponent — team scope', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('defaults to direct reports, exactly the pre-existing behaviour', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    expect(names(host).join(' ')).toContain('Direct Dana');
    expect(names(host).join(' ')).not.toContain('Subtree Sven');
  });

  it('switching to All my org adds people reachable only through the org subtree', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    const shown = names(host).join(' ');
    // Sven sits on 'Backend', two levels under the capability m1 manages, with no
    // org-chart link — an implementation matching only `organization === node`
    // would miss him, which is the whole point of deriving through the tree.
    expect(shown).toContain('Subtree Sven');
    expect(shown).toContain('Direct Dana');       // the chart axis still counts
    expect(shown).not.toContain('Outside Otto');
  });

  it('shows a placeholder in the org list but keeps it out of the average', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(names(host).join(' ')).toContain('Dummy Placeholder');
    // Internal-only mean: Dana 80 + Sven 40 = 60. Including the dummy's 0 would read 40.
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('60');
    expect(host.querySelector('[data-test="kpi-internal-note"]')).not.toBeNull();
  });

  it('excludes a placeholder from the average in Direct reports too, when it has a manager', async () => {
    // None of the other fixtures give a dummy/subco a `managerId`, so this is
    // the only case that exercises `countedForAverage` on the DIRECT branch —
    // its own comment says the internal-only rule is not `teamScope`-conditional
    // ("a placeholder given a manager would otherwise land in the direct one
    // too"), but nothing else here proves it.
    const resources = [
      ...RESOURCES,
      { ...base, id: 'p2', name: 'Direct Dummy', role: 'Developer', utilization: 0, kind: 'dummy', managerId: 'm1' },
    ] as Resource[];
    const { fixture, host } = setup({ resources });
    await flush(fixture);
    const shown = names(host).join(' ');
    expect(shown).toContain('Direct Dana');
    expect(shown).toContain('Direct Dummy');
    // Dana alone counts (80) — the dummy is listed but never in the denominator.
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('80');
    expect(host.querySelector('[data-test="kpi-internal-note"]')).not.toBeNull();
  });

  it('the average follows the view', async () => {
    const { fixture, host } = setup();
    await flush(fixture);
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('80'); // Dana alone
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-test="team-average"]')!.textContent).toContain('60');
  });

  it('explains an empty direct-reports view and an empty org view differently', async () => {
    // 'nobody' manages no person and no node.
    const { fixture, host } = setup({ userId: 'nobody' });
    await flush(fixture);
    expect(host.querySelector('[data-test="team-empty"]')!.textContent).toContain('report directly');
    host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-test="team-empty"]')!.textContent).toContain('organization');
  });

  it('keeps the view switch visible even when the org view would be empty', async () => {
    const { fixture, host } = setup({ userId: 'nobody' });
    await flush(fixture);
    expect(host.querySelector('[data-test="team-scope-org"]')).not.toBeNull();
  });

  it.each(['admin', 'delivery-executive'] as const)(
    '%s sees their OWN org scope in All my org, not the whole company',
    async role => {
      // Both roles are omniscient in the Allocation Approvals feed, but
      // `managedResources` never reads `auth.role()` — only `scopeOf(userId, ...)`
      // — so the design's "same scope for every role" decision must hold for
      // them too. 'Outside Otto' sits on 'Consulting', a capability m1 does not
      // manage: whole-company visibility would surface him, `scopeOf(m1, ...)`
      // must not.
      const { fixture, host } = setup({ role });
      await flush(fixture);
      host.querySelector<HTMLButtonElement>('[data-test="team-scope-org"]')!.click();
      fixture.detectChanges();
      const shown = names(host).join(' ');
      expect(shown).toContain('Direct Dana');
      expect(shown).toContain('Subtree Sven');
      expect(shown).not.toContain('Outside Otto');
    },
  );
});
