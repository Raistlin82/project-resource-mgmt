import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { App } from './app';
import { ApiService, UserRole } from './services/api.service';
import { AuthService } from './services/auth.service';
import { NotificationService } from './services/notification.service';
import { ThemeService } from './services/theme.service';

interface AppApiStub {
  getRequests: ReturnType<typeof vi.fn>;
  getProjectIssues: ReturnType<typeof vi.fn>;
  getChangeRequests: ReturnType<typeof vi.fn>;
  getResources: ReturnType<typeof vi.fn>;
}

function makeApiStub(): AppApiStub {
  return {
    getRequests: vi.fn(() => of([])),
    getProjectIssues: vi.fn(() => of([])),
    getChangeRequests: vi.fn(() => of([])),
    getResources: vi.fn(() => of([])),
  };
}

function makeAuthStub(initialRole: UserRole) {
  const role = signal<UserRole>(initialRole);
  const inRoles = (roles: UserRole[]) => roles.includes(role());
  return {
    authReady: signal(true),
    role,
    isAuthenticated: signal(true),
    displayName: signal('Test User'),
    canManageCommercial: computed(() => inRoles(['sales', 'finance', 'delivery-executive', 'admin'])),
    canApproveFinancials: computed(() => inRoles(['finance', 'delivery-executive', 'admin'])),
    canReadStaffing: computed(() => inRoles(['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin'])),
    canManageStaffing: computed(() => inRoles(['pm', 'resource-manager', 'delivery-executive', 'admin'])),
    canManageResources: computed(() => inRoles(['resource-manager', 'delivery-executive', 'admin'])),
    canReadCommercial: computed(() => inRoles(['sales', 'finance', 'delivery-executive', 'admin'])),
    canReadFinancials: computed(() => inRoles(['finance', 'delivery-executive', 'admin'])),
    canManageProjects: computed(() => inRoles(['pm', 'delivery-executive', 'admin'])),
    canManageConfiguration: computed(() => inRoles(['delivery-executive', 'admin'])),
    canViewPortfolioDashboard: computed(() => inRoles(['finance', 'delivery-executive', 'admin'])),
    hasAnyRole: (roles: UserRole[]) => inRoles(roles),
    login: vi.fn(),
    logout: vi.fn(),
  };
}

async function render(role: UserRole) {
  const api = makeApiStub();
  const auth = makeAuthStub(role);
  const notifications = { items: signal([]), dismiss: vi.fn() };
  const theme = { theme: signal<'light' | 'dark'>('light'), toggle: vi.fn() };

  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: api },
      { provide: AuthService, useValue: auth },
      { provide: NotificationService, useValue: notifications },
      { provide: ThemeService, useValue: theme },
    ],
  });
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, app: fixture.componentInstance, api };
}

describe('App capability-aware shell', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('does not call staffing badge endpoints for an employee', async () => {
    const { api } = await render('employee');
    expect(api.getRequests).not.toHaveBeenCalled();
    expect(api.getResources).not.toHaveBeenCalled();
    expect(api.getProjectIssues).toHaveBeenCalledOnce();
    expect(api.getChangeRequests).toHaveBeenCalledOnce();
  });

  it('does not call staffing badge endpoints for sales', async () => {
    const { api } = await render('sales');
    expect(api.getRequests).not.toHaveBeenCalled();
    expect(api.getResources).not.toHaveBeenCalled();
  });

  it('loads staffing badges for a staffing reader', async () => {
    const { api } = await render('pm');
    expect(api.getRequests).toHaveBeenCalledOnce();
    expect(api.getResources).toHaveBeenCalledOnce();
  });

  it('removes dead-end organization affordances from the employee navigation', async () => {
    const { app } = await render('employee');
    const routes = app.navGroups().flatMap(group => group.items.map(item => item.route));
    expect(routes).toContain('/profile');
    expect(routes).toContain('/assignments');
    expect(routes).not.toContain('/requests');
    expect(routes).not.toContain('/staffing');
    expect(routes).not.toContain('/utilization');
    expect(routes).not.toContain('/reporting');
    expect(routes.some(route => route.startsWith('/config/'))).toBe(false);
  });

  it('keeps toast notifications inside narrow viewports', async () => {
    const { fixture } = await render('employee');
    const toastStack = fixture.nativeElement.querySelector('.fixed.bottom-4') as HTMLElement;

    expect(toastStack.classList).toContain('left-4');
    expect(toastStack.classList).toContain('w-auto');
    expect(toastStack.classList).toContain('sm:left-auto');
    expect(toastStack.classList).toContain('sm:w-full');
  });

  it('exposes the mobile navigation as a dismissible modal region', async () => {
    const { fixture, app } = await render('employee');
    const menuButton = fixture.nativeElement.querySelector('[data-testid="mobile-menu-toggle"]') as HTMLButtonElement;

    expect(menuButton.getAttribute('aria-controls')).toBe('primary-navigation');
    expect(menuButton.getAttribute('aria-expanded')).toBe('false');

    menuButton.click();
    fixture.detectChanges();

    const navigation = fixture.nativeElement.querySelector('#primary-navigation') as HTMLElement;
    const main = fixture.nativeElement.querySelector('#main-content') as HTMLElement;
    expect(app.isMobileMenuOpen()).toBe(true);
    expect(menuButton.getAttribute('aria-expanded')).toBe('true');
    expect((main as HTMLElement & { inert: boolean }).inert).toBe(true);
    expect(navigation.querySelector('[data-testid="mobile-menu-close"]')).not.toBeNull();

    navigation.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();

    expect(app.isMobileMenuOpen()).toBe(false);
    expect(document.activeElement).toBe(menuButton);
  });

  it('links accordion controls to valid whitespace-free element ids', async () => {
    const { fixture } = await render('admin');
    const headers = Array.from(
      fixture.nativeElement.querySelectorAll('.command-nav-group-header'),
    ) as HTMLButtonElement[];

    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) {
      const controlledId = header.getAttribute('aria-controls');
      expect(controlledId).toBeTruthy();
      expect(controlledId).not.toMatch(/\s/);
      expect(fixture.nativeElement.querySelector(`[id="${controlledId}"]`)).not.toBeNull();
    }
  });

  it('searches navigation group names and presents unambiguous item labels', async () => {
    const { app } = await render('admin');
    const labels = app.navGroups().flatMap(group => group.items.map(item => item.label));

    expect(new Set(labels).size).toBe(labels.length);

    app.navFilter.set('commercial');
    expect(app.filteredGroups().map(group => group.label)).toEqual(['Commercial']);
    expect(app.filteredGroups()[0].items.length).toBeGreaterThan(0);
  });
});
