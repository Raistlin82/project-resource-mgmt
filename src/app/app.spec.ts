import { Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, Routes, provideRouter } from '@angular/router';
import { readFileSync } from 'node:fs';
import { of } from 'rxjs';
import { App, DESKTOP_NAV_QUERY, navShortcutHint } from './app';
import { ApiService, UserRole } from './services/api.service';
import { AuthService } from './services/auth.service';
import { AppNotification, NotificationService } from './services/notification.service';
import { ThemeService } from './services/theme.service';

/** Routed placeholder, so a navigation in a spec resolves to something real. */
@Component({ selector: 'app-stub-page', template: '<h1>Routed screen</h1>' })
class StubPage {}

const DRAWER_OPEN_CLASS = 'command-drawer-open';

/**
 * jsdom ships NO window.matchMedia at all, so the breakpoint the shared <aside>
 * switches role at has to be supplied explicitly. Returns the queries the
 * component asked about, so a test can pin which breakpoint was consulted.
 */
function stubViewport(desktop: boolean): string[] {
  const asked: string[] = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => {
      asked.push(query);
      return { matches: desktop, media: query } as MediaQueryList;
    },
  });
  return asked;
}

function clearViewportStub(): void {
  delete (window as unknown as { matchMedia?: unknown }).matchMedia;
}

/** Resolves after one animation frame, which is when the shell places focus. */
function nextFrame(): Promise<void> {
  return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

function pressK(modifier: 'ctrlKey' | 'metaKey'): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', [modifier]: true, bubbles: true }));
}

/**
 * Bodies of every CSS block whose header matches, brace-balanced so a nested
 * at-rule is returned whole. Used for source-level assertions about rules jsdom
 * never applies.
 */
function cssBlocks(css: string, header: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(header, from);
    if (start < 0) return bodies;
    const open = css.indexOf('{', start);
    if (open < 0) return bodies;
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        bodies.push(css.slice(open + 1, i));
        from = i + 1;
        break;
      }
    }
    if (from <= start) return bodies;
  }
}

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

interface AuthStubOptions {
  authenticated?: boolean;
  authReady?: boolean;
  hasResourceIdentity?: boolean;
}

function makeAuthStub(initialRole: UserRole, options: AuthStubOptions = {}) {
  const role = signal<UserRole>(initialRole);
  const inRoles = (roles: UserRole[]) => roles.includes(role());
  const authenticated = signal(options.authenticated ?? true);
  return {
    authReady: signal(options.authReady ?? true),
    role,
    isAuthenticated: authenticated,
    hasResourceIdentity: signal(options.hasResourceIdentity ?? authenticated()),
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

async function render(role: UserRole, routes: Routes = [], authOptions: AuthStubOptions = {}) {
  const api = makeApiStub();
  const auth = makeAuthStub(role, authOptions);
  const notifications = { items: signal<AppNotification[]>([]), dismiss: vi.fn(), pause: vi.fn(), resume: vi.fn() };
  const theme = { theme: signal<'light' | 'dark'>('light'), toggle: vi.fn() };

  TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter(routes),
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
  return { fixture, app: fixture.componentInstance, api, auth, notifications };
}

describe('App capability-aware shell', () => {
  beforeAll(() => {
    // jsdom implements no scrolling at all: window.scrollTo is a logged no-op and
    // Element.prototype.scrollTo does not exist. The shell resets both on every
    // NavigationEnd, so the navigating test below would otherwise throw out of an
    // rxjs subscriber as an unhandled error. A gap in the environment, not in the
    // component — every real browser ships Element.scrollTo.
    (Element.prototype as unknown as { scrollTo?: () => void }).scrollTo ??= (): void => undefined;
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    clearViewportStub();
    // <html> is shared across specs; the shell's own onDestroy clears this, but a
    // leak would silently lock scrolling for every later test.
    document.documentElement.classList.remove(DRAWER_OPEN_CLASS);
  });

  it('does not call organizational summary endpoints for an employee', async () => {
    const { fixture, api } = await render('employee');
    expect(api.getRequests).not.toHaveBeenCalled();
    expect(api.getResources).not.toHaveBeenCalled();
    expect(api.getProjectIssues).not.toHaveBeenCalled();
    expect(api.getChangeRequests).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('[data-testid="sidebar-summary"]')).toBeNull();
  });

  it('does not call organizational summary endpoints for sales', async () => {
    const { api } = await render('sales');
    expect(api.getRequests).not.toHaveBeenCalled();
    expect(api.getResources).not.toHaveBeenCalled();
    expect(api.getProjectIssues).not.toHaveBeenCalled();
    expect(api.getChangeRequests).not.toHaveBeenCalled();
  });

  it('loads staffing badges for a staffing reader', async () => {
    const { api } = await render('pm');
    expect(api.getRequests).toHaveBeenCalledOnce();
    expect(api.getResources).toHaveBeenCalledOnce();
    expect(api.getProjectIssues).not.toHaveBeenCalled();
    expect(api.getChangeRequests).not.toHaveBeenCalled();
  });

  it('separates the personal workspace from organizational registers', async () => {
    const { app } = await render('admin');
    const workspace = app.navGroups().find(group => group.label === 'My workspace');
    const operations = app.navGroups().find(group => group.label === 'Resource Operations');

    expect(app.navGroups()[0].label).toBe('My workspace');
    expect(workspace?.items.map(item => [item.label, item.route])).toEqual([
      ['Dashboard', '/'],
      ['My Profile', '/profile'],
      ['My Assignments', '/assignments'],
    ]);
    expect(operations?.items.map(item => item.route)).toContain('/search');
    expect(operations?.items.some(item => item.label.startsWith('My '))).toBe(false);
    expect(operations?.items.some(item => item.route === '/profile' || item.route === '/assignments')).toBe(false);
  });

  it('names standalone project routes as cross-project registers, distinct from record tabs', async () => {
    const { app } = await render('admin');
    const control = app.navGroups().find(group => group.label === 'Project Control')!;
    const labels = new Map(control.items.map(item => [item.route, item.label]));

    expect(labels.get('/project-plans')).toBe('All Project Plans');
    expect(labels.get('/project-tasks')).toBe('Task Register');
    expect(labels.get('/project-issues')).toBe('Issue Register');
    expect(labels.get('/project-documents')).toBe('Document Register');
    expect(labels.get('/project-partners')).toBe('Partner Register');
  });

  it('places the inbox and monthly allocation review together with distinct names and icons', async () => {
    const { app } = await render('resource-manager');
    const operations = app.navGroups().find(group => group.label === 'Resource Operations')!;
    const inboxIndex = operations.items.findIndex(item => item.route === '/approvals');
    const monthlyIndex = operations.items.findIndex(item => item.route === '/allocation-approvals');

    expect(inboxIndex).toBeGreaterThanOrEqual(0);
    expect(monthlyIndex).toBe(inboxIndex + 1);
    expect(operations.items[inboxIndex]).toMatchObject({ label: 'Approvals Inbox', icon: 'inbox' });
    expect(operations.items[monthlyIndex]).toMatchObject({ label: 'Monthly Allocation Review', icon: 'calendar_month' });
    expect(app.navGroups().find(group => group.label === 'Analytics')?.items
      .some(item => item.route === '/allocation-approvals')).toBe(false);
  });

  it('keeps the approvals pair capability-aware for roles with different workflow scopes', async () => {
    const { app } = await render('finance');
    const routes = app.navGroups().flatMap(group => group.items.map(item => item.route));

    expect(routes).toContain('/approvals');
    expect(routes).not.toContain('/allocation-approvals');
  });

  it('groups Configuration into searchable domains without adding more accordion groups', async () => {
    const { fixture, app } = await render('admin');
    const configuration = app.navGroups().find(group => group.label === 'Configuration')!;
    const domains = configuration.items
      .map(item => item.domain)
      .filter((domain, index, all) => domain !== all[index - 1]);

    expect(domains).toEqual(['Catalogs', 'Organization', 'Finance', 'Integrations']);
    expect(app.navGroups().filter(group => group.label.startsWith('Configuration'))).toHaveLength(1);

    const renderedDomains = (Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="nav-domain-label"]'),
    ) as HTMLElement[]).map(label => label.textContent?.trim());
    expect(renderedDomains).toEqual(['Catalogs', 'Organization', 'Finance', 'Integrations']);

    app.navFilter.set('finance');
    fixture.detectChanges();
    expect(app.filteredGroups().map(group => group.label)).toEqual(['Configuration']);
    expect(app.filteredGroups()[0].items.every(item => item.domain === 'Finance')).toBe(true);
  });

  it('removes unfiltered RISK/CR summaries and exposes only honest, named summary destinations', async () => {
    const { fixture, api } = await render('admin');
    const summary = fixture.nativeElement.querySelector('[data-testid="sidebar-summary"]') as HTMLElement;
    const links = Array.from(summary.querySelectorAll<HTMLAnchorElement>('a'));

    expect(summary.textContent).toContain('Open resource requests');
    expect(summary.textContent).toContain('Overbooked resources');
    expect(summary.textContent).not.toContain('RISK');
    expect(summary.textContent).not.toMatch(/\bCR\b/);
    expect(links.map(link => link.getAttribute('href'))).toEqual(['/requests', '/utilization']);
    expect(api.getProjectIssues).not.toHaveBeenCalled();
    expect(api.getChangeRequests).not.toHaveBeenCalled();
  });

  it('does not advertise the resource-request summary to finance, which cannot open that register', async () => {
    const { fixture, api } = await render('finance');
    const summaryLinks = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="sidebar-summary"] a'),
    ) as HTMLAnchorElement[];

    expect(summaryLinks.map(link => link.getAttribute('href'))).toEqual(['/utilization']);
    expect(api.getRequests).not.toHaveBeenCalled();
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
    expect(routes).not.toContain('/approvals');
    expect(routes).not.toContain('/allocation-approvals');
    expect(routes.some(route => route.startsWith('/config/'))).toBe(false);
  });

  it('shows an anonymous sign-in state instead of an inherited employee workspace', async () => {
    // Capabilities intentionally remain employee-like in this stub: the shell's
    // identity boundary, rather than a conveniently strict fake, must hide them.
    const { fixture, app, api, auth } = await render('employee', [], { authenticated: false });
    const host = fixture.nativeElement as HTMLElement;

    expect(app.navGroups()).toEqual([]);
    expect(host.querySelector('#primary-navigation')).toBeNull();
    expect(host.querySelector('[data-testid="mobile-menu-toggle"]')).toBeNull();
    expect(host.querySelector('router-outlet')).toBeNull();
    expect(host.querySelector('[data-testid="anonymous-shell-state"]')).not.toBeNull();
    expect(host.textContent).toContain('Sign in to Delivery Control');
    expect(host.textContent).not.toContain('My Assignments');
    expect(api.getProjectIssues).not.toHaveBeenCalled();
    expect(api.getChangeRequests).not.toHaveBeenCalled();

    (host.querySelector('[data-testid="sign-in-cta"]') as HTMLButtonElement).click();
    expect(auth.login).toHaveBeenCalledOnce();
  });

  it('identifies an authenticated account whose resource profile is not linked', async () => {
    const { fixture } = await render('employee', [], { hasResourceIdentity: false });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('#primary-navigation')).not.toBeNull();
    expect(host.textContent).toContain('Resource profile not linked');
    expect(host.querySelector('router-outlet')).not.toBeNull();
  });

  it('keeps toast notifications inside narrow viewports', async () => {
    const { fixture } = await render('employee');
    const toastStack = fixture.nativeElement.querySelector('.fixed.bottom-4') as HTMLElement;

    expect(toastStack.classList).toContain('left-4');
    expect(toastStack.classList).toContain('w-auto');
    expect(toastStack.classList).toContain('sm:left-auto');
    expect(toastStack.classList).toContain('sm:w-full');
  });

  it('gives every toast a message-specific, comfortably sized dismiss control', async () => {
    const { fixture, notifications } = await render('employee');
    notifications.items.set([
      { id: 1, type: 'error', message: 'Save failed' },
      { id: 2, type: 'success', message: 'Saved' },
    ]);
    fixture.detectChanges();

    const dismissButtons = Array.from(
      fixture.nativeElement.querySelectorAll('.fixed.bottom-4 button'),
    ) as HTMLButtonElement[];
    expect(dismissButtons.map(button => button.getAttribute('aria-label'))).toEqual([
      'Dismiss error notification: Save failed',
      'Dismiss notification: Saved',
    ]);
    for (const button of dismissButtons) {
      expect(button.type).toBe('button');
      expect(button.classList).toContain('size-10');
    }

    dismissButtons[0].click();
    expect(notifications.dismiss).toHaveBeenCalledWith(1);
  });

  it('pauses and resumes transient notification timing for pointer and keyboard interaction', async () => {
    const { fixture, notifications } = await render('employee');
    notifications.items.set([{ id: 4, type: 'success', message: 'Saved' }]);
    fixture.detectChanges();

    const toast = fixture.nativeElement.querySelector('[role="status"] .pointer-events-auto') as HTMLElement;
    toast.dispatchEvent(new MouseEvent('mouseenter'));
    toast.dispatchEvent(new MouseEvent('mouseleave'));
    toast.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    toast.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

    expect(notifications.pause).toHaveBeenCalledTimes(2);
    expect(notifications.pause).toHaveBeenCalledWith(4);
    expect(notifications.resume).toHaveBeenCalledTimes(2);
    expect(notifications.resume).toHaveBeenCalledWith(4);
  });

  it('moves focus to the new page heading after SPA navigation', async () => {
    const { fixture } = await render('employee', [{ path: 'next', component: StubPage }]);
    const router = TestBed.inject(Router);
    const menuButton = fixture.nativeElement.querySelector('[data-testid="mobile-menu-toggle"]') as HTMLButtonElement;
    menuButton.focus();

    await router.navigate(['/next']);
    fixture.detectChanges();
    await nextFrame();

    const heading = fixture.nativeElement.querySelector('#main-content h1') as HTMLHeadingElement;
    expect(heading.textContent).toContain('Routed screen');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(heading);
  });

  it('declares one desktop viewport shell with independently scrolling nav and main', async () => {
    const { fixture } = await render('employee');
    const aside = fixture.nativeElement.querySelector('#primary-navigation') as HTMLElement;
    const nav = aside.querySelector('nav') as HTMLElement;
    const footer = Array.from(aside.children).at(-1) as HTMLElement;
    const main = fixture.nativeElement.querySelector('#main-content') as HTMLElement;

    expect(aside.classList).toContain('overflow-hidden');
    expect(nav.classList).toContain('min-h-0');
    expect(nav.classList).toContain('overflow-y-auto');
    expect(footer.classList).toContain('shrink-0');
    expect(footer.classList).not.toContain('sticky');
    expect(main.classList).toContain('min-h-0');
    expect(main.classList).toContain('min-w-0');
    expect(main.classList).toContain('lg:h-full');

    const css = readFileSync('src/styles.css', 'utf8');
    const desktopRules = cssBlocks(css, `@media ${DESKTOP_NAV_QUERY}`).join('\n');
    expect(desktopRules).toMatch(/\.command-shell\s*{[^}]*block-size:\s*100dvh/);
    expect(desktopRules).toMatch(/\.command-shell\s*{[^}]*overflow:\s*hidden/);
    expect(desktopRules).toMatch(/\.command-drawer,[^}]*\.command-shell\s*>\s*main[^}]*block-size:\s*100%/);
  });

  it('uses an opaque focus indicator and leaves fixed overlays outside transformed containing blocks', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    const focusRule = cssBlocks(css, ':focus-visible {')[0];
    const revealKeyframes = cssBlocks(css, '@keyframes cc-reveal')[0];

    expect(focusRule).toMatch(/outline:\s*3px solid var\(--color-accent\)/);
    expect(focusRule).not.toMatch(/outline:[^;]*transparent/);
    expect(revealKeyframes).not.toMatch(/transform\s*:/);
    expect(cssBlocks(css, '.command-card:hover')[0]).not.toMatch(/transform\s*:/);
    expect(cssBlocks(css, '.command-kpi:hover')[0]).not.toMatch(/transform\s*:/);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*outline:\s*3px solid Highlight/);
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*border-color:\s*CanvasText/);
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

  // ----------------------------------------------------------------------------
  // The ⌘K shortcut (P2-06).
  //
  // Its keydown listener is registered inside afterNextRender, which does not run
  // on the server and only runs in a fixture once it has rendered. The FIRST test
  // below exists to prove that listener is live: without it every later
  // assertion about what ⌘K does would be vacuously green on a shortcut that was
  // never wired at all.
  // ----------------------------------------------------------------------------

  it('BASELINE: the global ⌘K listener is registered and reaches the nav search', async () => {
    stubViewport(true);
    const { fixture } = await render('employee');
    const input = fixture.nativeElement.querySelector('.command-nav-search input') as HTMLInputElement;

    expect(document.activeElement).not.toBe(input);

    pressK('ctrlKey');
    await nextFrame();

    expect(document.activeElement).toBe(input);
  });

  it('expands the collapsed desktop sidebar before focusing, and never inerts main there', async () => {
    const asked = stubViewport(true);
    const { fixture, app } = await render('employee');
    const input = fixture.nativeElement.querySelector('.command-nav-search input') as HTMLInputElement;
    const main = fixture.nativeElement.querySelector('#main-content') as HTMLElement & { inert: boolean };

    app.desktopSidebarOpen.set(false);
    fixture.detectChanges();

    pressK('metaKey');

    // The focus is DEFERRED by a frame on purpose: the container it targets is
    // display:none / visibility:hidden until change detection and a paint have
    // revealed it, and focus() on a non-rendered element silently no-ops. A
    // same-tick implementation would already have focused here, so this negative
    // is what distinguishes the two.
    expect(document.activeElement).not.toBe(input);

    expect(app.desktopSidebarOpen()).toBe(true);
    // The load-bearing negative: taking the mobile branch on a wide viewport
    // would set isMobileMenuOpen, which inerts <main> and locks the user out of
    // the page behind an invisible drawer.
    expect(app.isMobileMenuOpen()).toBe(false);
    expect(main.inert).not.toBe(true);

    fixture.detectChanges();
    await nextFrame();
    expect(document.activeElement).toBe(input);

    // Pins the breakpoint the component consults. src/styles.css is asserted
    // against the same exported constant, so the two cannot drift apart.
    expect(asked).toContain('(min-width: 64rem)');
  });

  it('opens the mobile drawer before focusing, and withholds the trap capture for that open only', async () => {
    stubViewport(false);
    const { fixture, app } = await render('employee');
    const aside = fixture.nativeElement.querySelector('#primary-navigation') as HTMLElement;
    const input = fixture.nativeElement.querySelector('.command-nav-search input') as HTMLInputElement;

    pressK('ctrlKey');
    expect(document.activeElement).not.toBe(input);

    expect(app.isMobileMenuOpen()).toBe(true);
    // Withheld for a ⌘K open: armed, the trap captures its first tabbable child
    // (the Close button) and fights the focus placed below.
    expect(app.drawerAutoCapture()).toBe(false);

    fixture.detectChanges();
    expect(aside.getAttribute('data-drawer')).toBe('open');
    await nextFrame();
    expect(document.activeElement).toBe(input);

    // The other half of the pair, without which `false` above would also pass on
    // an auto-capture hardcoded off: an ORDINARY open still arms the trap.
    app.closeMenu();
    app.toggleMenu();
    expect(app.drawerAutoCapture()).toBe(true);
  });

  it('treats a missing matchMedia as desktop, so ⌘K can never inert main by accident', async () => {
    clearViewportStub();
    const { fixture, app } = await render('employee');

    pressK('ctrlKey');
    fixture.detectChanges();
    await nextFrame();

    expect(app.isMobileMenuOpen()).toBe(false);
    expect(app.desktopSidebarOpen()).toBe(true);
  });

  it('renders a platform-aware shortcut hint that agrees with its aria-keyshortcuts', async () => {
    const { fixture } = await render('employee');
    const search = fixture.nativeElement.querySelector('.command-nav-search') as HTMLElement;
    const kbd = search.querySelector('[data-testid="nav-search-shortcut"]') as HTMLElement;
    const input = search.querySelector('input') as HTMLInputElement;

    // Precondition stated rather than assumed: this environment reports a
    // non-macOS platform, so the component must resolve the Ctrl branch. If that
    // ever changes, THIS line goes red instead of the hint silently flipping back
    // to ⌘K while the assertions below still pass.
    expect(navShortcutHint(navigator.platform || navigator.userAgent).label).toBe('Ctrl K');

    expect(kbd.textContent?.trim()).toBe('Ctrl K');
    expect(input.getAttribute('aria-keyshortcuts')).toBe('Control+K');
  });

  // ----------------------------------------------------------------------------
  // The accordion's active group (P2-05).
  // ----------------------------------------------------------------------------

  it('opens the group of the newly active route even after the user has toggled groups', async () => {
    const { fixture, app } = await render('admin', [{ path: 'forecast', component: StubPage }]);
    const router = TestBed.inject(Router);

    expect(app.isGroupOpen('My workspace')).toBe(true);
    expect(app.isGroupOpen('Analytics')).toBe(false);

    // One manual toggle used to switch the accordion into "manual mode" for the
    // rest of the session, which is what stranded every later navigation.
    app.toggleGroup('Configuration');
    expect(app.isGroupOpen('Configuration')).toBe(true);

    await router.navigate(['/forecast']);
    fixture.detectChanges();

    expect(app.isGroupOpen('Analytics')).toBe(true);
    // Scoped to the Analytics group body, because that body carries [inert] when
    // collapsed: a link in a closed group is unreachable, not just unseen.
    const body = fixture.nativeElement.querySelector('#navgroup-analytics') as HTMLElement & { inert: boolean };
    expect(body.inert).toBe(false);
    expect(body.querySelector('a[aria-current="page"]')).not.toBeNull();

    // The user's own expansion survives the navigation …
    expect(app.isGroupOpen('Configuration')).toBe(true);
    // … and the active group can still be collapsed, so its header button is not
    // a dead control — the failure mode of "always open the active group".
    app.toggleGroup('Analytics');
    expect(app.isGroupOpen('Analytics')).toBe(false);
  });

  // ----------------------------------------------------------------------------
  // The closed drawer's tab order and scroll lock (P1-23).
  // ----------------------------------------------------------------------------

  it('marks drawer state on the shared aside rather than inerting or hiding it', async () => {
    const { fixture, app } = await render('employee');
    const aside = fixture.nativeElement.querySelector('#primary-navigation') as HTMLElement & { inert: boolean };

    expect(aside.classList.contains('command-drawer')).toBe(true);
    expect(aside.getAttribute('data-drawer')).toBe('closed');

    // This element is ALSO the desktop sidebar. An attribute that removes it
    // wholesale strands desktop navigation, which is why the closed state is a
    // marker resolved per-breakpoint in CSS and not [inert]/[hidden] here.
    expect(aside.inert).not.toBe(true);
    expect(aside.hasAttribute('hidden')).toBe(false);

    app.toggleMenu();
    fixture.detectChanges();

    expect(aside.getAttribute('data-drawer')).toBe('open');
    expect(aside.inert).not.toBe(true);
  });

  it('locks document scrolling only while the drawer is open, and releases it on destroy', async () => {
    const { fixture, app } = await render('employee');
    const root = document.documentElement;

    expect(root.classList.contains(DRAWER_OPEN_CLASS)).toBe(false);

    app.toggleMenu();
    fixture.detectChanges();
    expect(root.classList.contains(DRAWER_OPEN_CLASS)).toBe(true);

    app.closeMenu();
    fixture.detectChanges();
    expect(root.classList.contains(DRAWER_OPEN_CLASS)).toBe(false);

    // <html> outlives the component, so a lock left behind would make the whole
    // document unscrollable after the shell is torn down.
    app.toggleMenu();
    fixture.detectChanges();
    fixture.destroy();
    expect(root.classList.contains(DRAWER_OPEN_CLASS)).toBe(false);
  });

  it('declares both halves of the breakpoint-scoped drawer rules in the stylesheet', () => {
    // HONEST LIMIT: jsdom applies no stylesheet and evaluates no media query, so
    // NOTHING here proves the off-screen links actually leave the tab order or
    // that the page stops scrolling — that needs a real layout engine. What this
    // does check is that both halves of each rule pair exist, and in particular
    // the SECOND half: a visibility:hidden or an overflow:hidden without its lg
    // re-open would hide the desktop sidebar / freeze desktop scrolling, the
    // regression this batch's risk note names.
    const css = readFileSync('src/styles.css', 'utf8');

    const closed = cssBlocks(css, '.command-drawer[data-drawer="closed"]');
    expect(closed.length).toBe(2);
    expect(closed[0]).toMatch(/visibility:\s*hidden/);
    expect(closed[1]).toMatch(/visibility:\s*visible/);

    expect(cssBlocks(css, '.command-drawer-open')[0]).toMatch(/overflow:\s*hidden/);

    // Asserted against the constant app.ts consults at runtime, so changing the
    // breakpoint in TypeScript without changing the CSS goes red.
    const lgBodies = cssBlocks(css, `@media ${DESKTOP_NAV_QUERY}`);
    expect(lgBodies.length).toBeGreaterThan(0);
    const reopened = lgBodies.join('\n');
    expect(reopened).toMatch(/\.command-drawer\[data-drawer="closed"\][^}]*visibility:\s*visible/);
    expect(reopened).toMatch(/\.command-drawer-open[^}]*overflow:\s*visible/);

    // The slide-out has to keep animating, and Tailwind v4 compiles
    // -translate-x-full to the `translate` property rather than `transform`.
    expect(cssBlocks(css, '.command-drawer {')[0]).toMatch(
      /transition-property:\s*transform,\s*translate,\s*visibility/,
    );
  });
});

describe('navShortcutHint', () => {
  it('claims the Command glyph only on Apple platforms', () => {
    expect(navShortcutHint('MacIntel')).toEqual({ label: '⌘K', keys: 'Meta+K' });
    expect(navShortcutHint('iPhone')).toEqual({ label: '⌘K', keys: 'Meta+K' });
    expect(navShortcutHint('Win32')).toEqual({ label: 'Ctrl K', keys: 'Control+K' });
    expect(navShortcutHint('Linux x86_64')).toEqual({ label: 'Ctrl K', keys: 'Control+K' });
    // No navigator at all — the server — must not claim a Mac keyboard.
    expect(navShortcutHint(undefined)).toEqual({ label: 'Ctrl K', keys: 'Control+K' });
  });
});
