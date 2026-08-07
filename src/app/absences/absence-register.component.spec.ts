import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, of, throwError } from 'rxjs';
import { AbsenceRegisterComponent } from './absence-register.component';
import {
  ApiService,
  Resource,
  ResourceAbsence,
  ResourceKind,
  UserRole,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';

/**
 * jsdom PERFORMS NO LAYOUT. Nothing below proves that a control is visible, on
 * screen, or reachable at a given width — only that the DOM says what it says.
 * The disabled/aria contract IS structural, so it is provable here; "the hint is
 * legible beside the button" is not, and is not claimed.
 */

const ME = '2';          // the signed-in resource-manager, resource id '2'
const COLLEAGUE = '8';   // Marco Belli

function res(id: string, name: string, kind: ResourceKind = 'internal'): Resource {
  return {
    id, name, role: 'Developer', skills: [], projectRoles: [], externalExperience: [],
    utilization: 0, capacity: 100, kind,
  };
}

const RESOURCES: Resource[] = [
  res(ME, 'John Miller'),
  res(COLLEAGUE, 'Marco Belli'),
  res('6', 'Subco — Mediolanum Senior Developer', 'subco'),
  res('4', 'Dummy — Senior Developer', 'dummy'),
];

const ABSENCES: ResourceAbsence[] = [
  {
    id: 'AB2', resourceId: COLLEAGUE, startDate: '2026-06-01', endDate: '2026-08-31',
    reasonCode: 'ParentalLeave', note: 'Cover arranged with the Platform practice',
    recordedBy: '2', recordedAt: '2026-05-20T09:00:00.000Z',
  },
];

class AuthStub {
  readonly _ready = signal(true);
  readonly authReady = this._ready.asReadonly();
  private readonly _userId = signal('');
  readonly userId = this._userId.asReadonly();
  constructor(private readonly role: UserRole, me: string) { this._userId.set(me); }
  hasAnyRole(roles: UserRole[]): boolean { return roles.includes(this.role); }
}

interface Overrides {
  role?: UserRole;
  me?: string;
  absences?: ResourceAbsence[];
  createAbsence?: (a: Partial<ResourceAbsence>) => Observable<ResourceAbsence>;
}

function setup(o: Overrides = {}) {
  const createAbsence = vi.fn(o.createAbsence ?? ((a: Partial<ResourceAbsence>) => of(a as ResourceAbsence)));
  const api = {
    getAbsences: vi.fn(() => of(o.absences ?? ABSENCES)),
    getResources: vi.fn(() => of(RESOURCES)),
    createAbsence,
    updateAbsence: vi.fn((_id: string, a: Partial<ResourceAbsence>) => of(a as ResourceAbsence)),
    deleteAbsence: vi.fn(() => of(undefined as unknown as void)),
  } as unknown as ApiService;
  const auth = new AuthStub(o.role ?? 'resource-manager', o.me ?? ME);

  TestBed.configureTestingModule({
    imports: [AbsenceRegisterComponent],
    providers: [
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: auth },
    ],
  });
  const fixture = TestBed.createComponent(AbsenceRegisterComponent);
  return { fixture, api, auth, createAbsence };
}

async function flush(fixture: ComponentFixture<AbsenceRegisterComponent>) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function host(fixture: ComponentFixture<AbsenceRegisterComponent>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function q<T extends HTMLElement>(fixture: ComponentFixture<AbsenceRegisterComponent>, test: string): T | null {
  return host(fixture).querySelector<T>(`[data-test="${test}"]`);
}

/** Fill the form through the DOM, the way a user does. */
function pickSubject(fixture: ComponentFixture<AbsenceRegisterComponent>, resourceId: string) {
  const select = q<HTMLSelectElement>(fixture, 'absence-resource')!;
  select.value = resourceId;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
}

function typeDate(fixture: ComponentFixture<AbsenceRegisterComponent>, test: string, value: string) {
  const input = q<HTMLInputElement>(fixture, test)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

afterEach(() => TestBed.resetTestingModule());

// ---------------------------------------------------------------------------

describe('AbsenceRegisterComponent — SoD stated BEFORE the click (structural; jsdom performs no layout)', () => {
  /**
   * THE PAIRED ASSERTION, on ONE fixture and ONE principal.
   *
   * A single direction is worthless here: "disabled when the subject is me"
   * passes just as well against a control that is ALWAYS disabled, which is
   * exactly the shape of a P2-18 hint copy-pasted with the wrong predicate. The
   * subject moves from me to a colleague and back, and both verdicts are read
   * off the same DOM.
   */
  it('disables Save with the reason when the subject is the signed-in person, and NOT when it is a colleague', async () => {
    const { fixture } = setup();
    await flush(fixture);

    fixture.componentInstance.openCreate();
    fixture.detectChanges();
    typeDate(fixture, 'absence-start', '2026-09-01');
    typeDate(fixture, 'absence-end', '2026-09-05');

    // (a) SUBJECT = ME -> refused before the click, with the reason attached as
    //     the control's accessible description.
    pickSubject(fixture, ME);
    const save = q<HTMLButtonElement>(fixture, 'absence-save')!;
    const sodHint = q(fixture, 'absence-save-sod-hint');
    expect({
      disabled: save.disabled,
      describedBy: save.getAttribute('aria-describedby'),
      hintText: sodHint?.textContent?.trim() ?? null,
      hintIdMatches: sodHint?.id === save.getAttribute('aria-describedby'),
    }).toStrictEqual({
      disabled: true,
      describedBy: 'absenceSaveSodHint',
      hintText: 'You cannot record your own absence. Segregation of duties requires a colleague or an admin to record it.',
      hintIdMatches: true,
    });

    // (b) SUBJECT = A COLLEAGUE -> live, and the hint is GONE. aria-describedby
    //     must be dropped too: a description pointing at a removed node is a
    //     dangling reference that screen readers announce as nothing at all.
    pickSubject(fixture, COLLEAGUE);
    const saveNow = q<HTMLButtonElement>(fixture, 'absence-save')!;
    expect({
      disabled: saveNow.disabled,
      describedBy: saveNow.getAttribute('aria-describedby'),
      hintPresent: q(fixture, 'absence-save-sod-hint') !== null,
    }).toStrictEqual({ disabled: false, describedBy: null, hintPresent: false });
  });

  it('sends the create for a colleague, and sends NOTHING for self', async () => {
    // The disabled attribute is an affordance; this pins the BEHAVIOUR behind it,
    // in both directions, so a save() that ignored the blocker would go red even
    // though the button still rendered as disabled.
    const { fixture, createAbsence } = setup();
    await flush(fixture);

    fixture.componentInstance.openCreate();
    fixture.detectChanges();
    typeDate(fixture, 'absence-start', '2026-09-01');
    typeDate(fixture, 'absence-end', '2026-09-05');

    pickSubject(fixture, ME);
    fixture.componentInstance.save();
    expect(createAbsence).not.toHaveBeenCalled();

    pickSubject(fixture, COLLEAGUE);
    fixture.componentInstance.save();
    expect(createAbsence).toHaveBeenCalledOnce();
    expect(createAbsence.mock.calls[0][0]).toStrictEqual({
      resourceId: COLLEAGUE,
      startDate: '2026-09-01',
      endDate: '2026-09-05',
      reasonCode: 'Vacation',
      note: '',
    });
  });

  it('has no SoD blocker at all for a principal with no resource identity', async () => {
    // An unmapped principal has userId() === '', and '' must never match a
    // subject. Without this, the empty default would block the first option in
    // the picker for anyone whose OIDC claim carries no resource_id.
    const { fixture } = setup({ me: '' });
    await flush(fixture);
    fixture.componentInstance.openCreate();
    fixture.detectChanges();
    pickSubject(fixture, COLLEAGUE);
    expect(fixture.componentInstance.selfRecordBlocked()).toBe(false);
  });
});

describe('AbsenceRegisterComponent — the write ROLE gate, also stated before the click', () => {
  it('disables "Record absence" with the reason for a reader who cannot write, and leaves it live for a writer', async () => {
    // delivery-executive READS the reason (product decision Q5) and cannot
    // record one. That asymmetry is the reason this gate exists separately from
    // the route gate, and it is asserted in both directions on the same screen.
    const reader = setup({ role: 'delivery-executive' });
    await flush(reader.fixture);
    const readerButton = q<HTMLButtonElement>(reader.fixture, 'record-absence')!;
    expect({
      disabled: readerButton.disabled,
      describedBy: readerButton.getAttribute('aria-describedby'),
      hint: q(reader.fixture, 'record-absence-role-hint')?.textContent?.includes('resource managers and admins') ?? false,
    }).toStrictEqual({ disabled: true, describedBy: 'absenceWriteRoleHint', hint: true });

    TestBed.resetTestingModule();
    const writer = setup({ role: 'resource-manager' });
    await flush(writer.fixture);
    const writerButton = q<HTMLButtonElement>(writer.fixture, 'record-absence')!;
    expect({
      disabled: writerButton.disabled,
      describedBy: writerButton.getAttribute('aria-describedby'),
      hintPresent: q(writer.fixture, 'record-absence-role-hint') !== null,
    }).toStrictEqual({ disabled: false, describedBy: null, hintPresent: false });
  });

  it('disables the per-row edit and delete controls for a reader, and enables them for a writer', async () => {
    const reader = setup({ role: 'delivery-executive' });
    await flush(reader.fixture);
    const row = q(reader.fixture, 'absence-row-AB2')!;
    expect(Array.from(row.querySelectorAll('button')).map(b => (b as HTMLButtonElement).disabled))
      .toStrictEqual([true, true]);

    TestBed.resetTestingModule();
    const writer = setup({ role: 'admin' });
    await flush(writer.fixture);
    const writerRow = q(writer.fixture, 'absence-row-AB2')!;
    expect(Array.from(writerRow.querySelectorAll('button')).map(b => (b as HTMLButtonElement).disabled))
      .toStrictEqual([false, false]);
  });
});

describe('AbsenceRegisterComponent — privacy (GDPR art. 9)', () => {
  it('renders the reason, because this screen exists to render it', async () => {
    const { fixture } = setup();
    await flush(fixture);
    expect(q(fixture, 'absence-reason-AB2')?.textContent?.trim()).toBe('Parental leave');
    expect(q(fixture, 'absence-privacy-notice')?.textContent).toContain('special-category personal data');
  });

  it('is the ONLY component in src/app that calls getAbsences(), and the redacted feed is what everyone else uses', () => {
    // THE REPO-WIDE INVARIANT, checked rather than trusted. A future screen that
    // wants "who is away" has a redacted feed for it; reaching for getAbsences()
    // instead hands the reason to that screen's whole audience, and no test in
    // that screen's own spec would notice.
    //
    // NON-VACUOUS BY CONSTRUCTION: the same scan asserts getAbsenceCalendar() IS
    // called elsewhere. If the walker were broken or looking at the wrong tree,
    // that expectation fails first and this one cannot pass by finding nothing.
    const root = resolve(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) files.push(full);
      }
    };
    walk(root);

    const callsReason = files.filter(f => /\.getAbsences\(/.test(readFileSync(f, 'utf8')));
    const callsRedacted = files.filter(f => /\.getAbsenceCalendar\(/.test(readFileSync(f, 'utf8')));

    expect(callsReason.map(f => f.slice(root.length + 1)).sort())
      .toStrictEqual(['absences/absence-register.component.ts']);
    // Not pinned to a list: the redacted feed is meant to grow more consumers.
    // Its only job here is to prove the walker finds call sites at all.
    expect(callsRedacted.length).toBeGreaterThanOrEqual(2);
  });

  it('offers no export control — the reason must never leave the application in a file', async () => {
    // Paired with the assertion above it: the reason IS on screen and is NOT
    // exportable, so "nothing found" here is not "nothing rendered".
    const { fixture } = setup();
    await flush(fixture);
    const labels = Array.from(host(fixture).querySelectorAll('button'))
      .map(b => `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`.toLowerCase());
    expect(labels.some(l => l.includes('export') || l.includes('csv') || l.includes('download'))).toBe(false);
    expect(q(fixture, 'absence-reason-AB2')).not.toBeNull();
  });

  it('does not fetch /resources for an employee, whose role the server refuses on that path', async () => {
    // THE DIVERGENCE THIS SCREEN HAD TO ABSORB: the server admits `employee` to
    // GET /absences (own rows) and REFUSES them on GET /resources. Firing the
    // roster read would 403 and tip the page into its error state for exactly
    // the audience the privacy design went out of its way to admit.
    const employee = setup({ role: 'employee', me: COLLEAGUE });
    await flush(employee.fixture);
    expect(employee.api.getResources).not.toHaveBeenCalled();
    expect(employee.api.getAbsences).toHaveBeenCalled();

    TestBed.resetTestingModule();
    const manager = setup({ role: 'resource-manager' });
    await flush(manager.fixture);
    expect(manager.api.getResources).toHaveBeenCalled();
  });

  it('names the employee their own row without a roster, and never invents a colleague name', async () => {
    const { fixture } = setup({ role: 'employee', me: COLLEAGUE });
    await flush(fixture);
    expect(q(fixture, 'absence-row-AB2')?.querySelector('td')?.textContent?.trim()).toBe('You');
  });

  it('words the empty state by SCOPE — an employee is never told the organization has none', async () => {
    const employee = setup({ role: 'employee', me: ME, absences: [] });
    await flush(employee.fixture);
    expect(q(employee.fixture, 'absence-empty')?.textContent?.trim())
      .toBe('You have no recorded absences. This list shows only your own.');
    expect(q(employee.fixture, 'absence-own-scope-note')).not.toBeNull();

    // THE TWIN. Same zero rows, a role the server serves in full: now "none" is
    // a claim about the organization, and it is true.
    TestBed.resetTestingModule();
    const manager = setup({ role: 'resource-manager', absences: [] });
    await flush(manager.fixture);
    expect(q(manager.fixture, 'absence-empty')?.textContent?.trim()).toBe('No absences recorded.');
    expect(q(manager.fixture, 'absence-own-scope-note')).toBeNull();
  });
});

describe('AbsenceRegisterComponent — the accepted-with-conflicts response', () => {
  it('reports the already-booked days the new absence collides with', async () => {
    // Spec §6.4: the write is ACCEPTED and REPORTS. Leaving the report unrendered
    // turns a deliberate asymmetry into a silent success, and the planner never
    // learns which days to un-book.
    const { fixture } = setup({
      createAbsence: a => of({
        ...(a as ResourceAbsence),
        bookedDayConflicts: [{ date: '2026-05-11', hours: 8 }, { date: '2026-05-12', hours: 7.5 }],
      } as ResourceAbsence),
    });
    await flush(fixture);
    fixture.componentInstance.openCreate();
    fixture.detectChanges();
    pickSubject(fixture, COLLEAGUE);
    typeDate(fixture, 'absence-start', '2026-05-11');
    typeDate(fixture, 'absence-end', '2026-05-15');
    fixture.componentInstance.save();
    fixture.detectChanges();

    const panel = q(fixture, 'absence-conflicts');
    expect(panel).not.toBeNull();
    const text = panel!.textContent ?? '';
    expect(text).toContain('2 already-booked day(s)');
    expect(text).toContain('2026-05-11 (8 h)');
    expect(text).toContain('2026-05-12 (7.5 h)');
  });

  it('shows no conflict panel when the response carries an empty list', async () => {
    // THE TWIN. An empty array is "no conflicts", not "the field was missing";
    // rendering a panel that says zero would be noise on every ordinary save.
    const { fixture } = setup({
      createAbsence: a => of({ ...(a as ResourceAbsence), bookedDayConflicts: [] } as ResourceAbsence),
    });
    await flush(fixture);
    fixture.componentInstance.openCreate();
    fixture.detectChanges();
    pickSubject(fixture, COLLEAGUE);
    typeDate(fixture, 'absence-start', '2026-09-01');
    typeDate(fixture, 'absence-end', '2026-09-02');
    fixture.componentInstance.save();
    fixture.detectChanges();
    expect(q(fixture, 'absence-conflicts')).toBeNull();
  });

  it('keeps the dialog open and states a server refusal inline, rather than behind an auto-dismissing toast', async () => {
    const { fixture } = setup({
      createAbsence: () => throwError(() => ({
        status: 409,
        error: { error: 'absence 2026-06-01..2026-06-05 overlaps an existing absence 2026-06-01..2026-08-31 for this resource' },
      })),
    });
    await flush(fixture);
    fixture.componentInstance.openCreate();
    fixture.detectChanges();
    pickSubject(fixture, COLLEAGUE);
    typeDate(fixture, 'absence-start', '2026-06-01');
    typeDate(fixture, 'absence-end', '2026-06-05');
    fixture.componentInstance.save();
    fixture.detectChanges();

    expect(fixture.componentInstance.showForm()).toBe(true);
    expect(q(fixture, 'absence-save-error')?.textContent).toContain('overlaps an existing absence');
  });
});

describe('AbsenceRegisterComponent — authReady and the subject picker', () => {
  it('reads nothing before the OIDC bootstrap settles, and reads once it does', async () => {
    const { fixture, api, auth } = setup();
    auth._ready.set(false);
    await flush(fixture);
    expect(api.getAbsences).not.toHaveBeenCalled();

    auth._ready.set(true);
    await flush(fixture);
    expect(api.getAbsences).toHaveBeenCalled();
  });

  it('offers subco but not dummy as an absence subject', async () => {
    // A subco can be off sick (the seed has exactly that row). A DUMMY is an
    // unfilled position: offering it would let a planner record leave for a
    // vacancy, and the vacancy would then leave the bench.
    const { fixture } = setup();
    await flush(fixture);
    expect(fixture.componentInstance.subjectOptions().map(r => r.id)).toStrictEqual([ME, COLLEAGUE, '6']);
  });

  it('marks the signed-in person in the picker, so the SoD refusal is not a surprise', async () => {
    const { fixture } = setup();
    await flush(fixture);
    fixture.componentInstance.openCreate();
    fixture.detectChanges();
    const options = Array.from(q<HTMLSelectElement>(fixture, 'absence-resource')!.options).map(o => o.textContent?.trim());
    expect(options).toStrictEqual(['Select a person...', 'John Miller (you)', 'Marco Belli', 'Subco — Mediolanum Senior Developer']);
  });
});
