import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError, type Observable } from 'rxjs';
import { ManageResourceOrganizationsComponent } from './manage-resource-organizations.component';
import { ApiService, Resource, ResourceOrganization } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * Mirrors the seed shape (src/db/seed.ts): four capability roots — Engineering
 * (id '2') among them — plus a real practice->competence branch under it:
 * Platform (id '5', parentId '2', a practice) and Backend (id '6', parentId
 * '5', a competence). Engineering and Platform both carry managerId '1'.
 */
const ORGS: ResourceOrganization[] = [
  { id: '1', name: 'Res Org Germany', description: 'Resource Org for Germany', costCenters: [], level: 'capability' },
  { id: '2', name: 'Engineering', description: 'Engineering organization', costCenters: [], level: 'capability', managerId: '1' },
  { id: '3', name: 'Consulting', description: 'Consulting organization', costCenters: [], level: 'capability' },
  { id: '5', name: 'Platform', description: 'Platform practice, under Engineering', costCenters: [], level: 'practice', parentId: '2', managerId: '1' },
  { id: '6', name: 'Backend', description: 'Backend competence, under Platform', costCenters: [], level: 'competence', parentId: '5' },
];

const RESOURCES: Resource[] = [
  { id: '1', name: 'Julie', role: 'Practice Lead', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
  { id: '2', name: 'Sam Cole', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
  // REVIEW ROUND 1 (critical): a dummy and a terminated resource must never be
  // offered as a node manager — see managerOptions()'s comment for why (a
  // placeholder manager makes roleFallback FALSE while satisfying nobody).
  { id: '3', name: 'Dummy Placeholder', role: 'Consultant', kind: 'dummy', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40 },
  { id: '4', name: 'Terminated Tom', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, terminationDate: '2020-01-01' },
];

function setup(orgs: ResourceOrganization[] = ORGS, resources: Resource[] = RESOURCES) {
  const getResourceOrganizations = vi.fn(() => of(orgs));
  const getResources = vi.fn(() => of(resources));
  const getCostCenters = vi.fn(() => of([]));
  const getServiceOrganizations = vi.fn(() => of([]));
  const createResourceOrganization = vi.fn<(org: Partial<ResourceOrganization>) => Observable<ResourceOrganization>>(
    () => of({} as ResourceOrganization),
  );
  const updateResourceOrganization = vi.fn<(id: string, org: Partial<ResourceOrganization>) => Observable<ResourceOrganization>>(
    () => of({} as ResourceOrganization),
  );
  const deleteResourceOrganization = vi.fn<(id: string) => Observable<void>>(() => of(undefined));
  const apiStub = {
    getResourceOrganizations, getResources, getCostCenters, getServiceOrganizations,
    createResourceOrganization, updateResourceOrganization, deleteResourceOrganization,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = {
    authReady: signal(true),
    isAuthenticated: signal(true),
    canApproveFinancials: signal(true),
  } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageResourceOrganizationsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageResourceOrganizationsComponent);
  return {
    fixture, getResourceOrganizations, getResources,
    createResourceOrganization, updateResourceOrganization, deleteResourceOrganization, notifyStub,
  };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ManageResourceOrganizationsComponent', () => {
  it('renders the tree with children nested under their parent', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    const row = host.querySelector('[data-test="org-node-5"]');
    expect(row).not.toBeNull();
    expect(row!.getAttribute('data-depth')).toBe('1');
    expect(host.querySelector('[data-test="org-node-2"]')!.getAttribute('data-depth')).toBe('0');
    expect(host.querySelector('[data-test="org-node-6"]')!.getAttribute('data-depth')).toBe('2');
  });

  it('offers a parent select on a practice and none on a capability', async () => {
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '2')!); // Engineering — a capability
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="org-parent"]')).toBeNull();

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '5')!); // Platform — a practice
    fixture.detectChanges();
    const parent = host.querySelector<HTMLSelectElement>('[data-test="org-parent"]');
    expect(parent).not.toBeNull();
    expect(parent!.value).toBe('2'); // the DOM value, not the signal
  });

  it('lists only nodes of the legal parent level', async () => {
    const { fixture } = setup();
    await flush(fixture);

    // Backend is a competence — its legal parent level is 'practice', not 'capability'.
    fixture.componentInstance.openForm(ORGS.find(o => o.id === '6')!);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const optionText = Array.from(host.querySelectorAll<HTMLOptionElement>('[data-test="org-parent"] option'))
      .map(o => o.textContent?.trim());
    expect(optionText).toContain('Platform');        // the one legal (practice) parent
    expect(optionText).not.toContain('Engineering');  // a capability — wrong level
    expect(optionText).not.toContain('Consulting');   // a capability — wrong level
  });

  it('sends level, parent and manager on save', async () => {
    const { fixture, updateResourceOrganization } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '5')!); // Platform
    fixture.detectChanges();
    fixture.componentInstance.save();
    expect(updateResourceOrganization).toHaveBeenCalledWith('5', expect.objectContaining({
      level: 'practice', parentId: '2', managerId: '1',
    }));
  });

  it('omits parentId and managerId when creating a new capability (nothing to persist)', async () => {
    const { fixture, createResourceOrganization } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.componentInstance.orgForm.patchValue({ name: 'New Capability' });
    fixture.detectChanges();
    fixture.componentInstance.save();

    expect(createResourceOrganization).toHaveBeenCalledTimes(1);
    const payload = createResourceOrganization.mock.calls[0][0] as Record<string, unknown>;
    expect(payload['level']).toBe('capability');
    // Sending '' on CREATE (unlike PUT) would persist a literal empty string
    // instead of leaving the field absent — both keys go through the
    // IDENTICAL branch in save(), so both must be omitted entirely.
    expect('parentId' in payload).toBe(false);
    expect('managerId' in payload).toBe(false);
  });

  it('excludes a dummy and a terminated resource from the manager options', async () => {
    // REVIEW ROUND 1 (critical) — a placeholder or terminated resource must
    // never be pickable as a node manager: managerId feeds scopedApproversOf,
    // and a manager id nobody can authenticate as makes roleFallback FALSE
    // (no fallback to "any resource-manager") while satisfying nobody — worse
    // than leaving the field empty. Asserted on the rendered <option>s, not
    // the signal, per this file's own DOM-assertion discipline.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '2')!);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const optionText = Array.from(host.querySelectorAll<HTMLOptionElement>('[data-test="org-manager"] option'))
      .map(o => o.textContent?.trim());
    expect(optionText).toContain('Julie'); // active, internal — still offered
    expect(optionText).not.toContain('Dummy Placeholder');
    expect(optionText).not.toContain('Terminated Tom');
  });

  it('disables the level select while the node being edited has children, and re-enables it once childless', async () => {
    // REVIEW ROUND 1 (critical) — changing a node's level while it has an
    // existing child would leave that child's own parent-level requirement
    // violated (the server now refuses this on save); the UI mirrors it by
    // disabling the control outright rather than letting the admin choose a
    // new level only to hit that refusal.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '5')!); // Platform — has child Backend
    await flush(fixture); // the disable/enable sync runs in an effect, not a computed
    const host = fixture.nativeElement as HTMLElement;
    const levelSelect = host.querySelector<HTMLSelectElement>('[data-test="org-level"]')!;
    expect(levelSelect.disabled).toBe(true);

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '6')!); // Backend — childless leaf
    await flush(fixture);
    expect(levelSelect.disabled).toBe(false);
  });

  it('clears a previously-set manager by sending an explicit empty string on update', async () => {
    const { fixture, updateResourceOrganization } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '2')!); // Engineering, managerId '1'
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const managerSelect = host.querySelector<HTMLSelectElement>('[data-test="org-manager"]')!;
    expect(managerSelect.value).toBe('1');

    managerSelect.value = '';
    managerSelect.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    fixture.componentInstance.save();
    expect(updateResourceOrganization).toHaveBeenCalledWith('2', expect.objectContaining({ managerId: '' }));
  });

  it('keeps the form open when the server refuses the save', async () => {
    // The 409 rename-conflict / level / parent refusals are server-authoritative;
    // the form must stay open (not silently close) so the admin sees the message
    // and can fix the input, rather than the change appearing to have vanished.
    const { fixture, updateResourceOrganization } = setup();
    updateResourceOrganization.mockReturnValueOnce(
      throwError(() => ({ error: { error: 'Cannot rename: 3 resource(s) still reference the name "Engineering"' } })),
    );
    await flush(fixture);

    fixture.componentInstance.openForm(ORGS.find(o => o.id === '2')!);
    fixture.detectChanges();
    fixture.componentInstance.save();
    fixture.detectChanges();

    expect(fixture.componentInstance.showForm()).toBe(true);
  });
});
