import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { SearchComponent } from './search.component';
import { ApiService } from '../services/api.service';
import { AuthService } from '../services/auth.service';

function apiStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getResources: () => of([{ id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]),
    getRequests: () => of([]),
    getProjects: () => of([{ id: '1', name: 'Project Alpha', location: 'Berlin' }]),
    getCustomers: () => of([]),
    getContracts: () => of([]),
    getOrders: () => of([]),
    ...overrides,
  };
}

describe('SearchComponent', () => {
  async function setup(
    apiOverrides: Partial<Record<string, unknown>> = {},
    authOverrides: Partial<Record<string, unknown>> = {},
    platform = 'browser',
  ) {
    await TestBed.configureTestingModule({
      imports: [SearchComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: PLATFORM_ID, useValue: platform },
        { provide: ApiService, useValue: apiStub(apiOverrides) },
        { provide: AuthService, useValue: { authReady: () => true, canReadStaffing: () => true, canReadCommercial: () => true, ...authOverrides } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(SearchComponent);
    fixture.detectChanges();
    return fixture;
  }

  /** Flushes the still-pending rxResource stream (params effect -> stream() ->
   *  forkJoin resolution -> value() update -> render). A single microtask tick
   *  is not enough for a chain this long under zoneless CD; loop a few rounds
   *  rather than guess a magic number of awaits per call site. */
  async function flush(fixture: { detectChanges(): void }, rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve();
      fixture.detectChanges();
    }
  }

  async function setupAndSubmit(
    apiOverrides: Partial<Record<string, unknown>> = {},
    authOverrides: Partial<Record<string, unknown>> = {},
  ) {
    const fixture = await setup(apiOverrides, authOverrides);
    fixture.componentInstance.submitQuery('Julie');
    await flush(fixture);
    return fixture;
  }

  // --- Explicit-submit path (spec §6: Resources/Requests, and Enter always
  // resolves every section immediately, including the live ones) ---

  it('a matching resource renders in the Resources section', async () => {
    const fixture = await setupAndSubmit();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Armstrong');
  });

  it('a role without canReadStaffing never even requests /resources, and the section does not render', async () => {
    const calls: string[] = [];
    const fixture = await setupAndSubmit(
      { getResources: () => { calls.push('resources'); return of([]); } },
      { canReadStaffing: () => false },
    );
    const host = fixture.nativeElement as HTMLElement;
    expect(calls).not.toContain('resources');
    expect(host.querySelector('[data-test="section-resources"]')).toBeFalsy();
  });

  it('a genuinely empty result renders "no results", not an error and not a missing section', async () => {
    const fixture = await setupAndSubmit({ getProjects: () => of([]) });
    const host = fixture.nativeElement as HTMLElement;
    const section = host.querySelector('[data-test="section-projects"]')!;
    expect(section).toBeTruthy();
    expect(section.textContent).toContain('No results');
  });

  it('a network error on one section shows Retry there, while the other section still shows its own results', async () => {
    const fixture = await setupAndSubmit({ getProjects: () => throwError(() => new HttpErrorResponse({ status: 500 })) });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-projects"]')!.textContent).toContain('Retry');
    expect(host.querySelector('[data-test="section-resources"]')!.textContent).toContain('Julie Armstrong');
  });

  it('a 403 on one section (unexpected, despite the capability pre-filter) omits the section rather than showing an error panel', async () => {
    const fixture = await setupAndSubmit({ getResources: () => throwError(() => new HttpErrorResponse({ status: 403 })) });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[data-test="section-resources"]')).toBeFalsy();
  });

  // --- Live-debounce path (spec §6, Decision 4: Projects/Customers/Contracts/
  // Orders auto-search 300ms after the last keystroke, WITHOUT Enter) ---

  describe('live-debounced sections (spec §6, Decision 4)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('typing into the box fires the Projects (live) section after the debounce, not before', async () => {
      const getProjects = vi.fn(() => of([{ id: '1', name: 'Project Alpha', location: 'Berlin' }]));
      const fixture = await setup({ getProjects });

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Alpha');
      await flush(fixture);

      // Before the debounce elapses: not called, section not rendered.
      vi.advanceTimersByTime(299);
      await flush(fixture);
      expect(getProjects).not.toHaveBeenCalled();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-projects"]')).toBeFalsy();

      // Once the debounce elapses: fired, section renders.
      vi.advanceTimersByTime(1);
      await flush(fixture);
      expect(getProjects).toHaveBeenCalledWith({ q: 'Alpha' });
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-projects"]')!.textContent).toContain('Project Alpha');
    });

    it('typing into the box fires NOTHING in the Resources (explicit-submit) section until Enter, however long you wait', async () => {
      const getResources = vi.fn(() => of([{ id: '1', name: 'Julie Armstrong', role: 'Developer', kind: 'internal' }]));
      const fixture = await setup({ getResources });

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Julie');
      vi.advanceTimersByTime(10_000); // far beyond any debounce window
      await flush(fixture);

      expect(getResources).not.toHaveBeenCalled();
      expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="section-resources"]')).toBeFalsy();

      // Confirm Enter is what actually releases it (rules out a broken test
      // double that would trivially "pass" by never firing at all).
      (fixture.componentInstance as unknown as { submitNow(): void }).submitNow();
      await flush(fixture);
      expect(getResources).toHaveBeenCalledWith({ q: 'Julie' });
    });

    it('rapid keystrokes coalesce into ONE query, not one request per keystroke', async () => {
      const getProjects = vi.fn(() => of([]));
      const fixture = await setup({ getProjects });
      const instance = fixture.componentInstance as unknown as { onInput(v: string): void };

      instance.onInput('J');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Ju');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Jul');
      vi.advanceTimersByTime(100);
      await flush(fixture);
      instance.onInput('Julie');
      vi.advanceTimersByTime(300); // full debounce from the LAST keystroke only
      await flush(fixture);

      expect(getProjects).toHaveBeenCalledTimes(1);
      expect(getProjects).toHaveBeenCalledWith({ q: 'Julie' });
    });

    it('the debounce timer is browser-only: on the server, typing schedules nothing, however long fake time advances', async () => {
      const getProjects = vi.fn(() => of([]));
      const fixture = await setup({ getProjects }, {}, 'server');

      (fixture.componentInstance as unknown as { onInput(v: string): void }).onInput('Alpha');
      vi.advanceTimersByTime(10_000);
      await flush(fixture);

      expect(getProjects).not.toHaveBeenCalled();
    });
  });
});
