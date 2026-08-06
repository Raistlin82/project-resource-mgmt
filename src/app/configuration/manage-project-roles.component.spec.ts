import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ManageProjectRolesComponent } from './manage-project-roles.component';
import { ApiService, ProjectRole } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';

/**
 * TWO roles, and one of them ALREADY Restricted. The defect this file pins is a
 * cross-row one — an armed id that outlives its only warning, so a later click
 * flips the wrong role — and a single-row fixture cannot express it. The
 * already-restricted role is the second half: this one control also UNRESTRICTS,
 * so the armed copy and the PUT payload must both follow the row's direction.
 */
const ROLES: ProjectRole[] = [
  { id: 'R1', code: 'DEV', name: 'Developer', description: 'Software Developer', restricted: false },
  { id: 'R2', code: 'PM', name: 'Project Manager', description: 'Delivery lead', restricted: true },
];

function setup(roles: ProjectRole[] = ROLES) {
  const getProjectRoles = vi.fn(() => of(roles));
  const createProjectRole = vi.fn(() => of({} as ProjectRole));
  const updateProjectRole = vi.fn(() => of({} as ProjectRole));
  const apiStub = { getProjectRoles, createProjectRole, updateProjectRole } as unknown as ApiService;
  const notifyStub = { show: vi.fn() } as unknown as NotificationService;
  const authStub = { authReady: signal(true), isAuthenticated: signal(true) } as unknown as AuthService;

  TestBed.configureTestingModule({
    imports: [ManageProjectRolesComponent],
    providers: [
      { provide: ApiService, useValue: apiStub },
      { provide: AuthService, useValue: authStub },
      { provide: NotificationService, useValue: notifyStub },
    ],
  });

  const fixture = TestBed.createComponent(ManageProjectRolesComponent);
  return { fixture, updateProjectRole, notifyStub };
}

async function flush(fixture: { detectChanges: () => void; whenStable: () => Promise<unknown> }) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** The `<tr>` whose Name cell holds this role. */
function rowFor(fixture: { nativeElement: HTMLElement }, name: string): HTMLTableRowElement {
  const row = Array.from(fixture.nativeElement.querySelectorAll<HTMLTableRowElement>('tbody tr'))
    .find(tr => tr.textContent?.includes(name));
  expect(row, `no row rendered for ${name}`).toBeTruthy();
  return row!;
}

/**
 * Accessible name of a control, the way a screen reader resolves it: an explicit
 * aria-label wins, otherwise the text content. Used to find controls WITHIN a row
 * — never document-wide, or the toast container could satisfy the query.
 */
function accessibleName(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
}

function controlIn(row: HTMLElement, pattern: RegExp): HTMLButtonElement | null {
  return Array.from(row.querySelectorAll<HTMLButtonElement>('button'))
    .find(b => pattern.test(accessibleName(b))) ?? null;
}

/**
 * The armed row's own question, read EXACTLY rather than by substring. Direction is
 * the whole point here and "Unrestrict Project Manager?" contains the substring
 * "restrict Project Manager?" — the class of trap where toContain('0%') is
 * satisfied by '100%'. Scoped to the actions cell so the Status chip ("Restricted")
 * cannot answer for it.
 */
function armedLabel(row: HTMLElement): string | null {
  return row.querySelector('td:last-child span')?.textContent?.trim() ?? null;
}

const lastToast = (notifyStub: NotificationService) =>
  (notifyStub.show as unknown as { mock: { calls: [string, string][] } }).mock.calls.at(-1)![0];

describe('ManageProjectRolesComponent restrict confirmation', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('arms the row on the first click and does NOT write', async () => {
    // THE DEFECT: the old shape armed an invisible `pendingRestrictId` and announced
    // it only in a toast that auto-dismisses after 5s. Nothing on the row showed it
    // was armed and the armed id never expired, so a stale click flipped a role's
    // Restricted flag with no dialog and no undo.
    const { fixture, updateProjectRole } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();

    expect(updateProjectRole).not.toHaveBeenCalled();
  });

  it('renders the armed state INSIDE the row — a Confirm control and the role name', async () => {
    // Scoped to the row element, NOT the document: the pre-fix implementation already
    // put the word "confirm" in a toast, so a document-wide query would have passed
    // against the defect.
    const { fixture } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();

    const armedRow = rowFor(fixture, 'Developer');
    expect(controlIn(armedRow, /confirm/i)).not.toBeNull();
    expect(armedLabel(armedRow)).toBe('Restrict Developer?');
    // ABSENCE HALF: while armed, the row must not still offer the plain toggle —
    // an armed state hiding behind an unchanged icon is the defect.
    expect(controlIn(armedRow, /^Restrict Developer$/)).toBeNull();
  });

  it('writes only when the row-scoped Confirm control is clicked', async () => {
    // The case that must still be ALLOWED: a guard that always refuses would pass
    // every negative test in this file.
    const { fixture, updateProjectRole } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Developer'), /confirm/i)!.click();
    fixture.detectChanges();

    expect(updateProjectRole).toHaveBeenCalledTimes(1);
    expect(updateProjectRole).toHaveBeenCalledWith('R1', { restricted: true });
  });

  it('never lets an armed row flip a DIFFERENT row that is clicked next', async () => {
    // The recorded failure, exactly: arm Developer, walk away, then click another
    // row's toggle. Under the old two-step nothing on screen said which role was
    // armed, so the next click wrote blind against a stale id.
    const { fixture, updateProjectRole } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Project Manager'), /^Unrestrict Project Manager$/)!.click();
    fixture.detectChanges();

    expect(updateProjectRole).not.toHaveBeenCalled();
    // Arming moved with the click: only one row is ever armed, and it is the one
    // just clicked — so the armed object is always the object on screen.
    expect(controlIn(rowFor(fixture, 'Project Manager'), /confirm/i)).not.toBeNull();
    expect(controlIn(rowFor(fixture, 'Developer'), /confirm/i)).toBeNull();
    expect(controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)).not.toBeNull();
  });

  it('disarms on Cancel, and a fresh arm + Confirm still writes', async () => {
    const { fixture, updateProjectRole } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Developer'), /^cancel$/i)!.click();
    fixture.detectChanges();

    expect(updateProjectRole).not.toHaveBeenCalled();
    expect(controlIn(rowFor(fixture, 'Developer'), /confirm/i)).toBeNull();

    // ABSENCE TWIN for "Cancel disarms": the screen must not be left permanently
    // unable to restrict either.
    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();
    controlIn(rowFor(fixture, 'Developer'), /confirm/i)!.click();
    fixture.detectChanges();
    expect(updateProjectRole).toHaveBeenCalledTimes(1);
  });

  it('follows the row direction: an already-restricted role arms as UNRESTRICT and writes false', async () => {
    // The same control does both directions. Without this case a fix that hard-coded
    // `restricted: true` — or armed copy that always read "Restrict" — would pass
    // every other test here, and an admin unrestricting a role would be shown the
    // opposite of what Confirm is about to do.
    const { fixture, updateProjectRole } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Project Manager'), /^Unrestrict Project Manager$/)!.click();
    fixture.detectChanges();

    expect(armedLabel(rowFor(fixture, 'Project Manager'))).toBe('Unrestrict Project Manager?');

    controlIn(rowFor(fixture, 'Project Manager'), /confirm/i)!.click();
    fixture.detectChanges();
    expect(updateProjectRole).toHaveBeenCalledWith('R2', { restricted: false });
  });

  it('names the role and the direction in the arming toast', async () => {
    // The old copy — "Click again to confirm you want to restrict this role" — named
    // neither the object nor what the flag does.
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();

    const message = lastToast(notifyStub);
    expect(message).toContain('Developer');
    expect(message).toMatch(/restricting/i);
    // The instruction that made the toast load-bearing is gone: the row carries the
    // affordance now, so the copy must not tell the admin to click the icon again.
    expect(message).not.toMatch(/again/i);
  });

  it('does NOT promise an enforcement the app has no code for', async () => {
    // `restricted` is stored by the server and rendered as a chip here; NOT ONE of
    // the seven consumers of /project-roles filters on it (manage-rate-cards,
    // project-rates, resources, contract-details, my-profile, resource-requests and
    // this screen all list every role). Copy claiming the role can no longer be
    // staffed would describe behaviour that does not exist — the same correction the
    // vendors dialog took.
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Developer'), /^Restrict Developer$/)!.click();
    fixture.detectChanges();

    const message = lastToast(notifyStub);
    expect(message).not.toMatch(/no longer be (staffed|selected|used)/i);
    expect(message).not.toMatch(/removes? (it )?from/i);
  });

  it('names the SECOND role when the second row is armed — the copy interpolates', async () => {
    // ABSENCE TWIN for the toast: a message that hard-coded "Developer" would pass
    // the naming case above. It must name the role being flipped and not the other.
    const { fixture, notifyStub } = setup();
    await flush(fixture);

    controlIn(rowFor(fixture, 'Project Manager'), /^Unrestrict Project Manager$/)!.click();
    fixture.detectChanges();

    const message = lastToast(notifyStub);
    expect(message).toContain('Project Manager');
    expect(message).toMatch(/unrestricting/i);
    expect(message).not.toContain('"Developer"');
  });
});
