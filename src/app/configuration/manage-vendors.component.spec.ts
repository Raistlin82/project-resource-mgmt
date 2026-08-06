import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ManageVendorsComponent } from './manage-vendors.component';
import { ApiService, Country, Vendor } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * TWO vendors. The interpolation half of the delete copy is only provable with a
 * second vendor: a template that hard-coded "Acme Consulting" would satisfy a
 * single-vendor fixture.
 */
const VENDORS: Vendor[] = [
  { id: 'V1', name: 'Acme Consulting', vatId: 'IT-1234567890', country: 'IT' },
  { id: 'V2', name: 'Globex Partners', vatId: 'DE-9876543210', country: 'DE' },
];

const COUNTRIES: Country[] = [{ code: 'IT', name: 'Italy' }, { code: 'DE', name: 'Germany' }];

function setup(vendors: Vendor[] = VENDORS) {
  const getVendors = vi.fn(() => of(vendors));
  const getCountries = vi.fn(() => of(COUNTRIES));
  const createVendor = vi.fn(() => of({} as Vendor));
  const updateVendor = vi.fn(() => of({} as Vendor));
  const deleteVendor = vi.fn(() => of(undefined as unknown as void));
  const apiStub = { getVendors, getCountries, createVendor, updateVendor, deleteVendor } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageVendorsComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageVendorsComponent);
  return { fixture, deleteVendor, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function host(fixture: { nativeElement: HTMLElement }) {
  return fixture.nativeElement;
}

/** The row-level trash control for a vendor, by its accessible name. */
function trashFor(fixture: { nativeElement: HTMLElement }, name: string): HTMLButtonElement {
  const button = Array.from(host(fixture).querySelectorAll<HTMLButtonElement>('tbody button'))
    .find(b => b.getAttribute('aria-label') === `Delete ${name}`);
  expect(button, `no delete control rendered for ${name}`).toBeTruthy();
  return button!;
}

function deleteOverlay(fixture: { nativeElement: HTMLElement }): HTMLElement | null {
  return host(fixture).querySelector<HTMLElement>('[data-test="vendor-delete-overlay"]');
}

/** The overlay's own Delete button (the confirm control), not the row trash icon. */
function confirmControl(fixture: { nativeElement: HTMLElement }): HTMLButtonElement {
  const overlay = deleteOverlay(fixture);
  expect(overlay, 'the delete confirmation is not open').not.toBeNull();
  const button = Array.from(overlay!.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => b.textContent?.trim() === 'Delete');
  expect(button, 'no confirm control in the delete confirmation').toBeTruthy();
  return button!;
}

describe('ManageVendorsComponent delete confirmation copy', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('names the vendor and the consequence for the resources pointing at it', async () => {
    // THE DEFECT: the copy was the static literal "Are you sure you want to delete
    // this vendor? This action cannot be undone." — it named neither the object nor
    // the fact that vendorId is a REQUIRED control on every subco resource, so those
    // resources keep a raw id in the vendor field and cannot be saved until re-pointed.
    const { fixture } = setup();
    await flush(fixture);

    trashFor(fixture, 'Acme Consulting').click();
    fixture.detectChanges();

    const text = deleteOverlay(fixture)!.textContent ?? '';
    expect(text).toContain('Acme Consulting');
    expect(text).toMatch(/resource/i);
  });

  it('interpolates the vendor actually being deleted, not a fixed name', async () => {
    // ABSENCE TWIN: without this, a template that hard-coded "Acme Consulting"
    // passes the case above. The second vendor's dialog must name IT and must not
    // mention the first.
    const { fixture } = setup();
    await flush(fixture);

    trashFor(fixture, 'Globex Partners').click();
    fixture.detectChanges();

    const text = deleteOverlay(fixture)!.textContent ?? '';
    expect(text).toContain('Globex Partners');
    expect(text).not.toContain('Acme Consulting');
  });

  it('does NOT promise a refusal the API does not implement', async () => {
    // The register's preferred fix adds a reference check to the vendors DELETE so a
    // referenced vendor is refused in BOTH adapters. src/server.ts is out of this
    // batch's ownership, so the copy must describe what actually happens today.
    // This assertion is what stops the wording drifting ahead of the API.
    const { fixture } = setup();
    await flush(fixture);

    trashFor(fixture, 'Acme Consulting').click();
    fixture.detectChanges();

    expect(deleteOverlay(fixture)!.textContent ?? '').not.toMatch(/will be refused/i);
  });
});

describe('ManageVendorsComponent delete path', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not DELETE on the row click, and the confirm control is the only path that does', async () => {
    const { fixture, deleteVendor } = setup();
    await flush(fixture);

    trashFor(fixture, 'Acme Consulting').click();
    fixture.detectChanges();
    expect(deleteVendor).not.toHaveBeenCalled();

    confirmControl(fixture).click();
    fixture.detectChanges();
    expect(deleteVendor).toHaveBeenCalledTimes(1);
    expect(deleteVendor).toHaveBeenCalledWith('V1');
  });

  it('surfaces the server reason when the DELETE is refused, and keeps the dialog open', async () => {
    // Under Postgres this DELETE hits the resources.vendor_id FK and the API maps
    // SQLSTATE 23503 to 409. With no error arm the subscription's next() never ran:
    // the dialog stayed open, no toast appeared, and the refusal read as a dead button.
    const { fixture, deleteVendor, notifyStub } = setup();
    (deleteVendor as unknown as { mockReturnValueOnce: (v: unknown) => void })
      .mockReturnValueOnce(throwError(() => ({ error: { error: 'Vendor is referenced by 3 resource(s)' } })));
    await flush(fixture);

    trashFor(fixture, 'Acme Consulting').click();
    fixture.detectChanges();
    confirmControl(fixture).click();
    fixture.detectChanges();

    expect(notifyStub.show).toHaveBeenCalledWith('Vendor is referenced by 3 resource(s)', 'error');
    // The dialog must stay open so the message has something to sit next to — a
    // refusal that also closed the dialog would read as a successful delete.
    expect(deleteOverlay(fixture)).not.toBeNull();
  });

  it('reports success and closes the dialog when the DELETE goes through', async () => {
    // ABSENCE TWIN for the error arm: an implementation that always toasted an
    // error, or never closed the dialog, would pass the case above.
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    trashFor(fixture, 'Acme Consulting').click();
    fixture.detectChanges();
    confirmControl(fixture).click();
    fixture.detectChanges();

    expect(notifyStub.show).toHaveBeenCalledWith('Vendor deleted.', 'success');
    expect(notifyStub.show).not.toHaveBeenCalledWith(expect.anything(), 'error');
    expect(deleteOverlay(fixture)).toBeNull();
  });
});

describe('ManageVendorsComponent form overlay — STRUCTURAL contract only (jsdom performs no layout)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('gives the Add Vendor overlay its own scroller and bounds the panel height', async () => {
    // A fixed items-center overlay centres a panel taller than the viewport, pushing
    // the Save row below the fold; a fixed box cannot be scrolled by the page.
    // jsdom CAN prove these class tokens are on the right elements; it CANNOT prove
    // the clipping (offsetHeight is 0, there is no viewport). Only a real browser at
    // 320x460 could assert the submit button's rect stays inside the viewport.
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openForm();
    fixture.detectChanges();

    const overlay = host(fixture).querySelector<HTMLElement>('[data-test="vendor-form-overlay"]')!;
    const panel = host(fixture).querySelector<HTMLElement>('[data-test="vendor-form-panel"]')!;
    const tokens = overlay.className.split(/\s+/);
    expect(tokens).toContain('overflow-y-auto');
    expect(tokens).toContain('items-start');
    // TOKEN comparison, not substring: 'items-center' is a substring of
    // 'sm:items-center', so toContain() on the raw className would be satisfied by
    // the very class that has to go — the same trap as toContain('0%') matching '100%'.
    expect(tokens).not.toContain('items-center');
    expect(tokens).toContain('sm:items-center');
    expect(panel.className).toMatch(/max-h-\[/);
    // The footer is only reachable if the fields, not the panel, are what scrolls.
    const body = panel.querySelector<HTMLElement>('form > div')!;
    expect(body.className.split(/\s+/)).toContain('overflow-y-auto');
  });
});
