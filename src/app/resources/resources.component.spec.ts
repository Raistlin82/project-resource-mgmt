import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ResourcesComponent } from './resources.component';
import { ApiService, Resource, Vendor } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/** Two internal resources and one subco (vendor V4) — the seeded shape from Task 2. */
const RESOURCES: Resource[] = [
  { id: '1', name: 'Alice', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: '2', name: 'Bob', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'internal' },
  { id: '6', name: 'External Co', role: 'Consultant', skills: [], projectRoles: [], externalExperience: [], utilization: 0, capacity: 40, kind: 'subco', vendorId: 'V4' },
];

const VENDORS: Vendor[] = [{ id: 'V4', name: 'Acme Staffing' }];

function setup(resources: Resource[] = RESOURCES) {
  const getResources = vi.fn(() => of(resources));
  const getProjectRoles = vi.fn(() => of([]));
  const getResourceOrganizations = vi.fn(() => of([]));
  const getCountries = vi.fn(() => of([]));
  const getCities = vi.fn(() => of([]));
  const getRateCards = vi.fn(() => of([]));
  const getVendors = vi.fn(() => of(VENDORS));
  const createResource = vi.fn(() => of({} as Resource));
  const updateResource = vi.fn(() => of({} as Resource));
  const apiStub = {
    getResources, getProjectRoles, getResourceOrganizations, getCountries, getCities,
    getRateCards, getVendors, createResource, updateResource,
  } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ResourcesComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ResourcesComponent);
  return { fixture, getResources, getVendors, createResource, updateResource, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('ResourcesComponent', () => {
  it('shows the vendor field only when the kind is subco', async () => {
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="res-vendor"]')).toBeNull();

    fixture.componentInstance.form.controls.kind.setValue('subco');
    fixture.detectChanges();
    expect(host.querySelector('[data-test="res-vendor"]')).not.toBeNull();

    fixture.componentInstance.form.controls.kind.setValue('internal');
    fixture.detectChanges();
    expect(host.querySelector('[data-test="res-vendor"]')).toBeNull();
  });

  it('marks the vendor control required for a subco and optional otherwise', () => {
    const { fixture } = setup();
    const form = fixture.componentInstance.form;

    form.controls.kind.setValue('subco');
    form.controls.vendorId.setValue('');
    expect(form.controls.vendorId.valid).toBe(false);

    form.controls.kind.setValue('internal');
    expect(form.controls.vendorId.valid).toBe(true);
  });

  it('clears a previously-picked vendor when kind is switched back to internal', () => {
    const { fixture } = setup();
    const form = fixture.componentInstance.form;

    form.controls.kind.setValue('subco');
    form.controls.vendorId.setValue('V4');
    expect(form.controls.vendorId.value).toBe('V4');

    form.controls.kind.setValue('internal');
    expect(form.controls.vendorId.value).toBe('');
  });

  it('blocks saving a subco with no vendor selected, and allows it once one is picked', async () => {
    const { fixture, createResource } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.componentInstance.form.patchValue({ name: 'New Sub', role: 'Consultant', hireDate: '2026-01-01', kind: 'subco' });
    fixture.detectChanges();

    expect(fixture.componentInstance.form.invalid).toBe(true);
    fixture.componentInstance.save();
    expect(createResource).not.toHaveBeenCalled();

    fixture.componentInstance.form.controls.vendorId.setValue('V4');
    expect(fixture.componentInstance.form.valid).toBe(true);
    fixture.componentInstance.save();
    expect(createResource).toHaveBeenCalledWith(expect.objectContaining({ kind: 'subco', vendorId: 'V4' }));
  });

  it('loads an existing subco with its vendor pre-filled, valid, and the vendor field shown', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const subco = RESOURCES.find(r => r.id === '6')!;
    fixture.componentInstance.openForm(subco);
    fixture.detectChanges();

    // No further interaction (no setValue/markAsTouched) — the load itself must
    // already leave the form in this state.
    const form = fixture.componentInstance.form;
    expect(form.controls.kind.value).toBe('subco');
    expect(form.controls.vendorId.value).toBe('V4');
    expect(form.controls.vendorId.valid).toBe(true);

    const host = fixture.nativeElement as HTMLElement;
    const vendorSelect = host.querySelector('[data-test="res-vendor"]') as HTMLSelectElement | null;
    expect(vendorSelect).not.toBeNull();
    expect(vendorSelect!.value).toBe('V4');
  });

  it('loads an existing internal resource with no vendor field and a valid vendorId control', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const internal = RESOURCES.find(r => r.id === '1')!;
    fixture.componentInstance.openForm(internal);
    fixture.detectChanges();

    const form = fixture.componentInstance.form;
    expect(form.controls.kind.value).toBe('internal');
    expect(form.controls.vendorId.valid).toBe(true);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="res-vendor"]')).toBeNull();
  });

  it('renders a kind badge per resource and the kind filter isolates one kind', async () => {
    const { fixture } = setup();
    await flush(fixture);

    const host = fixture.nativeElement as HTMLElement;
    expect(host.textContent).toContain('Subcontractor');

    fixture.componentInstance.kindFilter.set('subco');
    fixture.detectChanges();
    expect(fixture.componentInstance.filteredResources().map(r => r.id)).toEqual(['6']);

    const rows = host.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('External Co');
  });
});
