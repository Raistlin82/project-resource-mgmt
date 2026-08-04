import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { ProjectRates } from './project-rates';
import { ApiService, NegotiatedRate, Project, Resource } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { NotificationService } from '../../services/notification.service';

function host(fixture: { nativeElement: unknown }): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/**
 * `whenStable()` HANGS while an `rxResource` stream is still open — not needed
 * here since every stub below resolves synchronously, but microtask ticks are
 * still the established idiom (contract-details.spec.ts) for letting an
 * already-synchronous `rxResource` read reach the DOM before asserting.
 */
async function tick(fixture: { detectChanges: () => void }, microtasks = 5): Promise<void> {
  fixture.detectChanges();
  for (let i = 0; i < microtasks; i++) await Promise.resolve();
  fixture.detectChanges();
}

describe('ProjectRates — inherited vs override (Task 5)', () => {
  const project: Project = {
    id: 'P2', name: 'Project Beta', location: 'Remote', startDate: '2026-01-01',
    endDate: '2026-12-31', status: 'Active', contractId: 'CT1',
  };
  const resource: Resource = {
    id: 'R1', name: 'Dev One', role: 'Developer', skills: [], projectRoles: [],
    externalExperience: [], utilization: 80, capacity: 40, billRate: 1200,
  };
  const contractRate: NegotiatedRate = { id: 'NR1', contractId: 'CT1', role: 'Developer', currency: 'EUR', billRate: 1000 };

  function baseStub(overrides: Partial<Record<string, () => unknown>> = {}) {
    return {
      getProjects: () => of([project]),
      getResources: () => of([resource]),
      getFxRates: () => of([]),
      getNegotiatedRates: () => of([contractRate]),
      ...overrides,
    } as unknown as ApiService;
  }

  async function setUp(apiStub: ApiService): Promise<ComponentFixture<ProjectRates>> {
    const authStub = { authReady: signal(true), canManageCommercial: signal(true) } as unknown as AuthService;
    const notifyStub = { show: vi.fn() } as unknown as NotificationService;
    TestBed.configureTestingModule({
      imports: [ProjectRates],
      providers: [
        { provide: ApiService, useValue: apiStub },
        { provide: AuthService, useValue: authStub },
        { provide: NotificationService, useValue: notifyStub },
      ],
    });
    await TestBed.compileComponents();
    const fixture: ComponentFixture<ProjectRates> = TestBed.createComponent(ProjectRates);
    fixture.componentRef.setInput('projectId', 'P2');
    await tick(fixture);
    return fixture;
  }

  it('shows the contract rate greyed out on a project that does not override it', async () => {
    const fixture = await setUp(baseStub());
    const h = host(fixture);

    const inherited = h.querySelectorAll('[data-test="inherited-rate"]');
    expect(inherited.length).toBe(1);
    expect(inherited[0].textContent).toContain('Developer');
    expect(inherited[0].textContent).toContain('1000');
    // Greyed: the row carries the muted styling, not the plain default row.
    expect(inherited[0].className).toContain('text-ink-muted');
  });

  it('shows the project override instead of the inherited row once one exists', async () => {
    const override: NegotiatedRate = { id: 'NR2', projectId: 'P2', role: 'Developer', currency: 'EUR', billRate: 1150 };
    const fixture = await setUp(baseStub({ getNegotiatedRates: () => of([contractRate, override]) }));
    const h = host(fixture);

    // The paired absence assertion: no inherited marker once an override exists.
    expect(h.querySelectorAll('[data-test="inherited-rate"]').length).toBe(0);

    const overrideRows = h.querySelectorAll('[data-test="project-rate-row"]');
    expect(overrideRows.length).toBe(1);
    expect(overrideRows[0].textContent).toContain('Developer');
    expect(overrideRows[0].textContent).toContain('1150');
  });

  it('surfaces the server refusal without closing the form', async () => {
    const createSpy = vi.fn().mockReturnValue(
      throwError(() => ({ error: { error: 'a negotiated rate already exists for this key (existing id NR2)' } })),
    );
    const fixture = await setUp(baseStub({ createNegotiatedRate: createSpy }));
    const h = host(fixture);

    const addButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim().includes('Add Override'));
    expect(addButton).toBeTruthy();
    addButton!.click();
    await tick(fixture);

    const roleSelect = h.querySelector<HTMLSelectElement>('#projectRateRole');
    expect(roleSelect).toBeTruthy();
    roleSelect!.value = 'Developer';
    roleSelect!.dispatchEvent(new Event('change'));

    const billRateInput = h.querySelector<HTMLInputElement>('#projectRateBillRate');
    expect(billRateInput).toBeTruthy();
    billRateInput!.value = '900';
    billRateInput!.dispatchEvent(new Event('input'));
    await tick(fixture);

    const saveButton = [...h.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save Rate');
    expect(saveButton).toBeTruthy();
    saveButton!.click();
    await tick(fixture);

    // The form must still be open, and the exact server message rendered.
    expect(h.querySelector('#projectRateRole')).toBeTruthy();
    const errorEl = h.querySelector('[data-test="negotiated-rate-error"]');
    expect(errorEl?.textContent).toContain('a negotiated rate already exists for this key (existing id NR2)');
  });
});
