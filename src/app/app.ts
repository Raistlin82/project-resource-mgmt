import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule, MatIconRegistry } from '@angular/material/icon';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { forkJoin, of } from 'rxjs';
import { catchError, filter, map } from 'rxjs/operators';
import {
  ApiService,
  ChangeRequest,
  Issue,
  Resource,
  ResourceRequest,
} from './services/api.service';
import { AuthService } from './services/auth.service';
import { NotificationService } from './services/notification.service';
import { ThemeService } from './services/theme.service';

type NavBadge = 'requests' | 'risks' | 'changes' | 'overbooked';

interface NavItem {
  label: string;
  icon: string;
  route: string;
  exact?: boolean;
  compact?: boolean;
  badge?: NavBadge;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface NavState {
  requests: ResourceRequest[];
  issues: Issue[];
  changes: ChangeRequest[];
  resources: Resource[];
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule],
  template: `
    <div class="command-shell min-h-screen flex flex-col lg:flex-row font-sans">
      <a
        href="#main-content"
        (click)="focusMain($event)"
        class="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[200] focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent">
        Skip to main content
      </a>
      <header class="lg:hidden command-sidebar text-ink px-4 py-3 flex items-center justify-between sticky top-0 z-40 shadow-sm">
        <div class="flex items-center gap-2">
          <span class="grid size-9 place-items-center rounded-md border border-accent bg-accent-tint text-accent-text ring-1 ring-accent">
            <mat-icon>hub</mat-icon>
          </span>
          <div>
            <div class="command-brand text-base leading-none text-ink flex items-center gap-2">
              Delivery Control
              <span class="inline-block size-1.5 rounded-full bg-accent"></span>
            </div>
            <div class="text-[11px] text-ink-muted">Portfolio command center</div>
          </div>
        </div>
        <button (click)="toggleMenu()" class="grid size-10 place-items-center rounded-md border border-line text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors" aria-label="Toggle navigation">
          <mat-icon>{{ isMobileMenuOpen() ? 'close' : 'menu' }}</mat-icon>
        </button>
      </header>

      @if (isMobileMenuOpen()) {
        <div
          class="fixed inset-0 bg-scrim/40 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          (click)="closeMenu()"
          (keydown.enter)="closeMenu()"
          tabindex="0"
          role="button"
          aria-label="Close menu">
        </div>
      }

      <aside
        class="command-sidebar fixed inset-y-0 left-0 z-50 w-72 flex flex-col transform transition-transform duration-300 ease-in-out lg:relative lg:translate-x-0 overflow-y-auto shadow-2xl lg:shadow-none"
        [class.-translate-x-full]="!isMobileMenuOpen()"
        [class.translate-x-0]="isMobileMenuOpen()">
        <div class="hidden lg:block sticky top-0 z-10 border-b border-line bg-surface px-5 py-5">
          <div class="flex items-center gap-3 text-ink">
            <span class="grid size-10 place-items-center rounded-md border border-accent bg-accent-tint text-accent-text ring-1 ring-accent">
              <mat-icon>hub</mat-icon>
            </span>
            <div>
              <div class="command-brand text-lg leading-none text-ink flex items-center gap-2">
                Delivery Control
                <span class="inline-block size-1.5 rounded-full bg-accent"></span>
              </div>
              <div class="mt-1 text-xs text-ink-muted">Professional Services Automation</div>
            </div>
          </div>
          <div class="mt-4 grid grid-cols-4 gap-2 text-center">
            <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ openRequestsBadge() }}</div>
              <div class="text-[10px] text-ink-muted">REQ</div>
            </div>
            <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ riskBadge() }}</div>
              <div class="text-[10px] text-ink-muted">RISK</div>
            </div>
            <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ changesBadge() }}</div>
              <div class="text-[10px] text-ink-muted">CR</div>
            </div>
            <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ overbookedBadge() }}</div>
              <div class="text-[10px] text-ink-muted">LOAD</div>
            </div>
          </div>
        </div>

        <nav class="flex-1 px-3 py-4">
          <div class="command-nav-search">
            <mat-icon>search</mat-icon>
            <input
              #navSearch
              type="text"
              [value]="navFilter()"
              (input)="onFilterInput($event)"
              (keydown.escape)="clearFilter()"
              placeholder="Find a section…"
              aria-label="Filter navigation" />
            @if (navFilter()) {
              <button type="button" class="command-nav-clear grid size-6 place-items-center" (click)="clearFilter()" aria-label="Clear filter">
                <mat-icon class="text-[16px] w-[16px] h-[16px]">close</mat-icon>
              </button>
            } @else {
              <kbd>⌘K</kbd>
            }
          </div>

          @for (group of filteredGroups(); track group.label) {
            <section class="mb-2">
              <button
                type="button"
                class="command-nav-group-header"
                [attr.aria-expanded]="isGroupOpen(group.label)"
                [attr.aria-controls]="'navgroup-' + group.label"
                (click)="toggleGroup(group.label)">
                <span class="command-section-label">{{ group.label }}</span>
                <mat-icon class="command-nav-chevron">chevron_right</mat-icon>
              </button>
              <div
                class="command-nav-group-body"
                [class.open]="isGroupOpen(group.label)"
                [id]="'navgroup-' + group.label"
                [inert]="!isGroupOpen(group.label)">
                <div class="space-y-1 pt-1">
                  @for (item of group.items; track item.route) {
                    <a
                      [routerLink]="item.route"
                      routerLinkActive="active"
                      #rla="routerLinkActive"
                      [routerLinkActiveOptions]="item.exact ? exactActiveOptions : defaultActiveOptions"
                      [attr.aria-current]="rla.isActive ? 'page' : null"
                      (click)="closeMenu()"
                      class="command-nav-link"
                      [class.text-sm]="item.compact">
                      <mat-icon class="shrink-0 text-[20px] w-[20px] h-[20px]">{{ item.icon }}</mat-icon>
                      <span class="truncate">{{ item.label }}</span>
                      @if (badgeValue(item.badge); as badge) {
                        <span class="command-nav-badge" [class.danger]="badgeDanger(item.badge)">{{ badge }}</span>
                      }
                    </a>
                  }
                </div>
              </div>
            </section>
          } @empty {
            <div class="command-nav-empty">No matches</div>
          }
        </nav>

        <div class="sticky bottom-0 border-t border-line bg-surface p-4">
          @if (isAuthenticated()) {
            <div class="flex items-center gap-3">
              <span class="grid size-9 shrink-0 place-items-center rounded-full border border-accent bg-accent-tint text-accent-text ring-1 ring-accent">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">account_circle</mat-icon>
              </span>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-semibold text-ink">{{ displayName() }}</div>
                <div class="truncate text-[11px] uppercase tracking-wide text-ink-muted">{{ role() }}</div>
              </div>
              <button
                type="button"
                (click)="toggleTheme()"
                class="grid size-9 shrink-0 place-items-center rounded-md border border-line text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
                [attr.aria-pressed]="isDark()"
                [attr.aria-label]="isDark() ? 'Switch to light theme' : 'Switch to dark theme'"
                [title]="isDark() ? 'Switch to light theme' : 'Switch to dark theme'">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ isDark() ? 'light_mode' : 'dark_mode' }}</mat-icon>
              </button>
              <button
                type="button"
                (click)="signOut()"
                class="grid size-9 shrink-0 place-items-center rounded-md border border-line text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
                aria-label="Sign out"
                title="Sign out">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">logout</mat-icon>
              </button>
            </div>
          } @else {
            <div class="flex items-center gap-2">
              <button
                type="button"
                (click)="signIn()"
                class="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white outline-none transition-colors hover:bg-accent-strong focus:ring-2 focus:ring-accent/40">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">login</mat-icon>
                Sign in
              </button>
              <button
                type="button"
                (click)="toggleTheme()"
                class="grid size-9 shrink-0 place-items-center rounded-md border border-line text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
                [attr.aria-pressed]="isDark()"
                [attr.aria-label]="isDark() ? 'Switch to light theme' : 'Switch to dark theme'"
                [title]="isDark() ? 'Switch to light theme' : 'Switch to dark theme'">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">{{ isDark() ? 'light_mode' : 'dark_mode' }}</mat-icon>
              </button>
            </div>
          }
        </div>
      </aside>

      <main id="main-content" tabindex="-1" class="flex-1 overflow-y-auto lg:h-screen outline-none">
        <div class="command-page p-4 sm:p-6 lg:p-7">
          <router-outlet></router-outlet>
        </div>
      </main>

      <!--
        Toasts are split across two live regions so severity maps to the right
        politeness: errors interrupt (role="alert"/assertive) so a screen-reader
        user is told immediately that an action failed; success/info are polite.
        Both sit in the same fixed wrapper so the visual stack is unchanged.
      -->
      <div class="fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col pointer-events-none">
        <div role="alert" aria-live="assertive" class="flex flex-col gap-2">
          @for (toast of errorToasts(); track toast.id) {
            <div class="pointer-events-auto flex items-start gap-3 rounded-md border p-4 text-sm font-semibold shadow-lg ring-1 animate-in bg-critical-tint border-critical ring-critical text-critical-text">
              <mat-icon class="text-[20px] w-[20px] h-[20px] shrink-0">error</mat-icon>
              <span class="flex-1">{{ toast.message }}</span>
              <button (click)="dismiss(toast.id)" class="shrink-0 hover:opacity-70 transition-opacity" aria-label="Dismiss notification">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">close</mat-icon>
              </button>
            </div>
          }
        </div>
        <div role="status" aria-live="polite" class="flex flex-col gap-2" [class.mt-2]="errorToasts().length && statusToasts().length">
          @for (toast of statusToasts(); track toast.id) {
            <div class="pointer-events-auto flex items-start gap-3 rounded-md border p-4 text-sm font-semibold shadow-lg ring-1 animate-in"
                 [class.bg-positive-tint]="toast.type === 'success'" [class.border-positive]="toast.type === 'success'" [class.ring-positive]="toast.type === 'success'" [class.text-positive-text]="toast.type === 'success'"
                 [class.bg-surface]="toast.type === 'info'" [class.border-line]="toast.type === 'info'" [class.ring-line]="toast.type === 'info'" [class.text-ink-secondary]="toast.type === 'info'">
              <mat-icon class="text-[20px] w-[20px] h-[20px] shrink-0">
                {{ toast.type === 'success' ? 'check_circle' : 'info' }}
              </mat-icon>
              <span class="flex-1">{{ toast.message }}</span>
              <button (click)="dismiss(toast.id)" class="shrink-0 hover:opacity-70 transition-opacity" aria-label="Dismiss notification">
                <mat-icon class="text-[18px] w-[18px] h-[18px]">close</mat-icon>
              </button>
            </div>
          }
        </div>
      </div>
    </div>
  `,
})
export class App {
  // Sidebar: collapsible accordion nav with live filter (light Executive Workstation theme).
  private notifications = inject(NotificationService);
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private router = inject(Router);
  private theme = inject(ThemeService);
  private destroyRef = inject(DestroyRef);

  // Nav search input, used by the global ⌘K shortcut to focus the filter.
  private navSearch = viewChild<ElementRef<HTMLInputElement>>('navSearch');

  // Theme state surfaced to the toggle control (light-first; dark is opt-in).
  readonly isDark = computed(() => this.theme.theme() === 'dark');

  constructor() {
    // Ensure EVERY <mat-icon> uses the Material Icons ligature font. Without a
    // registered default font set, some mat-icon instances render the ligature
    // source text (e.g. "insights"/"add") instead of the glyph. SSR-safe (no DOM).
    const iconRegistry = inject(MatIconRegistry);
    iconRegistry.setDefaultFontSetClass('material-icons', 'mat-ligature-font');

    // Browser-only (afterNextRender never runs on the server) global ⌘K / Ctrl+K
    // shortcut that focuses the nav search input, making the kbd hint honest.
    afterNextRender(() => {
      const handler = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          const input = this.navSearch()?.nativeElement;
          if (input) {
            input.focus();
            input.select();
          }
        }
      };
      document.addEventListener('keydown', handler);
      this.destroyRef.onDestroy(() => document.removeEventListener('keydown', handler));

      // On every navigation, reset scroll to the top so each screen opens at its
      // start. The content pane <main> is the scroll container on desktop
      // (lg:h-screen + overflow-y-auto); on smaller viewports the window/document
      // scrolls instead. Reset BOTH so it works at every breakpoint.
      const navSub = this.router.events
        .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
        .subscribe(() => {
          document.getElementById('main-content')?.scrollTo({ top: 0, left: 0 });
          window.scrollTo({ top: 0, left: 0 });
        });
      this.destroyRef.onDestroy(() => navSub.unsubscribe());
    });
  }

  readonly toasts = this.notifications.items;
  // Split by severity so each maps to a live region with the right politeness
  // (assertive for errors, polite for the rest) — see the toast markup.
  readonly errorToasts = computed(() => this.toasts().filter(t => t.type === 'error'));
  readonly statusToasts = computed(() => this.toasts().filter(t => t.type !== 'error'));
  readonly exactActiveOptions = { exact: true };
  readonly defaultActiveOptions = { exact: false };

  // Static nav definition. The Commercial group is capability-gated at render
  // time (see navGroups) so links only appear when the route guards would let
  // the user through — no dead-end affordances for unauthorized/anonymous users.
  private readonly allNavGroups: NavGroup[] = [
    {
      label: 'Resource Control',
      items: [
        { label: 'Dashboard', icon: 'dashboard', route: '/', exact: true },
        { label: 'My Profile', icon: 'person', route: '/profile' },
        { label: 'My Assignments', icon: 'event_note', route: '/assignments' },
        { label: 'Resource Requests', icon: 'assignment', route: '/requests', badge: 'requests' },
        { label: 'Staffing', icon: 'group_add', route: '/staffing' },
        { label: 'Approvals', icon: 'fact_check', route: '/approvals' },
      ],
    },
    {
      label: 'Project Control',
      items: [
        { label: 'Projects', icon: 'folder', route: '/projects' },
        { label: 'Project Plans', icon: 'account_tree', route: '/project-plans' },
        { label: 'Tasks', icon: 'task', route: '/project-tasks' },
        { label: 'Issues', icon: 'bug_report', route: '/project-issues', badge: 'risks' },
        { label: 'Change Control', icon: 'published_with_changes', route: '/change-requests', badge: 'changes' },
        { label: 'Documents', icon: 'description', route: '/project-documents' },
        { label: 'Project Partners', icon: 'handshake', route: '/project-partners' },
        { label: 'Financial Plans', icon: 'payments', route: '/financial-plans' },
        { label: 'Cost Centers', icon: 'account_balance', route: '/project-cost-centers' },
      ],
    },
    {
      label: 'Commercial',
      items: [
        { label: 'Customers', icon: 'groups', route: '/customers' },
        { label: 'Contracts', icon: 'gavel', route: '/contracts' },
        { label: 'Orders', icon: 'receipt_long', route: '/orders' },
        { label: 'Billing', icon: 'request_quote', route: '/billing' },
      ],
    },
    {
      label: 'Analytics',
      items: [
        { label: 'Forecast', icon: 'query_stats', route: '/forecast' },
        { label: 'What-if', icon: 'tune', route: '/what-if' },
        { label: 'Utilization', icon: 'bar_chart', route: '/utilization', badge: 'overbooked' },
        { label: 'Reporting', icon: 'insights', route: '/reporting', badge: 'risks' },
      ],
    },
    {
      label: 'Configuration',
      items: [
        { label: 'Default Language', icon: 'language', route: '/config/language', compact: true },
        { label: 'Skill Catalogs', icon: 'category', route: '/config/skill-catalogs', compact: true },
        { label: 'Proficiency Sets', icon: 'military_tech', route: '/config/proficiency-sets', compact: true },
        { label: 'Manage Skills', icon: 'psychology', route: '/config/skills', compact: true },
        { label: 'Project Roles', icon: 'badge', route: '/config/project-roles', compact: true },
        { label: 'Cost Centers', icon: 'account_balance', route: '/config/cost-centers', compact: true },
        { label: 'Service Orgs', icon: 'business', route: '/config/service-orgs', compact: true },
        { label: 'Resource Orgs', icon: 'domain', route: '/config/resource-orgs', compact: true },
        { label: 'Availability Data', icon: 'event_available', route: '/config/availability', compact: true },
        { label: 'Integrations', icon: 'cable', route: '/config/integrations', compact: true },
      ],
    },
  ];

  // Capability-filtered nav: Customers/Contracts/Orders require
  // canManageCommercial() and Billing additionally requires
  // canApproveFinancials(), mirroring commercialGuard/financeGuard so links
  // only appear when they would actually navigate. Integrations (Configuration
  // group) mirrors financeGuard for the same reason — its artifacts expose
  // financial data (finance/delivery-executive/admin only). An emptied group
  // is dropped entirely.
  readonly navGroups = computed<NavGroup[]>(() => {
    const canCommercial = this.auth.canManageCommercial();
    const canFinance = this.auth.canApproveFinancials();
    return this.allNavGroups
      .map(group => {
        if (group.label === 'Commercial') {
          const items = group.items.filter(item => {
            if (item.route === '/billing') return canCommercial && canFinance;
            return canCommercial;
          });
          return { label: group.label, items };
        }
        if (group.label === 'Configuration') {
          const items = group.items.filter(item => item.route !== '/config/integrations' || canFinance);
          return { label: group.label, items };
        }
        return group;
      })
      .filter(group => group.items.length > 0);
  });

  // Gate the shell badges' load on auth readiness: getResources() is a
  // principal-gated read, so firing before the post-redirect token is attached
  // 401s and latches the badges at 0 until a manual reload (the same latch the
  // page components fixed). authReady false->true re-runs the stream.
  private navRes = rxResource<NavState, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({
            requests: this.api.getRequests(),
            issues: this.api.getProjectIssues(),
            changes: this.api.getChangeRequests(),
            resources: this.api.getResources(),
          }).pipe(
            // Resilience: a failure of the badge-data endpoints (e.g. a transient
            // 401/403 or outage) must NOT throw out of the resource value — that
            // would break change detection for the whole shell and freeze the nav.
            // Degrade gracefully to empty badges; the navigation stays fully usable.
            catchError(() => of<NavState>({ requests: [], issues: [], changes: [], resources: [] })),
          )
        : of<NavState>({ requests: [], issues: [], changes: [], resources: [] }),
    defaultValue: { requests: [], issues: [], changes: [], resources: [] },
  });

  // Auth state surfaced to the sidebar footer control.
  readonly isAuthenticated = this.auth.isAuthenticated;
  readonly displayName = this.auth.displayName;
  readonly role = this.auth.role;

  isMobileMenuOpen = signal(false);

  // Live filter for the nav.
  navFilter = signal('');

  // Groups the user has explicitly toggled open (overrides the active-route fallback).
  private expandedGroups = signal<Set<string>>(new Set());
  // Whether the user has manually toggled any group yet (controls fallback vs. manual mode).
  private userHasToggled = signal(false);

  // Current router URL, kept in sync with navigation.
  private currentUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  // The group containing the active route (longest-prefix match, exact for '/').
  private activeGroupLabel = computed(() => {
    const url = this.currentUrl().split('?')[0];
    let bestLabel: string | null = null;
    let bestLen = -1;
    for (const group of this.navGroups()) {
      for (const item of group.items) {
        const matches = item.exact ? url === item.route : url === item.route || url.startsWith(item.route + '/');
        if (matches && item.route.length > bestLen) {
          bestLen = item.route.length;
          bestLabel = group.label;
        }
      }
    }
    return bestLabel;
  });

  // Filtered groups; while a query is active, only matching items/groups are shown.
  filteredGroups = computed<NavGroup[]>(() => {
    const q = this.navFilter().trim().toLowerCase();
    if (!q) return this.navGroups();
    return this.navGroups()
      .map(group => ({ label: group.label, items: group.items.filter(i => i.label.toLowerCase().includes(q)) }))
      .filter(group => group.items.length > 0);
  });

  private navState = this.navRes.value;
  openRequestsBadge = computed(() => this.navState().requests.filter(r => r.status === 'Open').length);
  riskBadge = computed(() =>
    this.navState().issues.filter(i => i.status !== 'Resolved' && (i.severity === 'High' || i.severity === 'Critical' || i.escalated)).length,
  );
  changesBadge = computed(() =>
    this.navState().changes.filter(c => c.status === 'Submitted' || c.status === 'Draft').length,
  );
  overbookedBadge = computed(() => this.navState().resources.filter(r => r.utilization > 110).length);

  toggleMenu() {
    this.isMobileMenuOpen.update(v => !v);
  }

  closeMenu() {
    this.isMobileMenuOpen.set(false);
  }

  toggleGroup(label: string): void {
    this.expandedGroups.update(prev => {
      // On first manual interaction, seed from the active-route fallback so it feels continuous.
      const next = this.userHasToggled() ? new Set(prev) : new Set(this.activeGroupLabel() ? [this.activeGroupLabel() as string] : []);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
    this.userHasToggled.set(true);
  }

  isGroupOpen(label: string): boolean {
    // While filtering, matching groups are force-expanded.
    if (this.navFilter().trim()) return true;
    // After any manual toggle, the explicit set is authoritative.
    if (this.userHasToggled()) return this.expandedGroups().has(label);
    // Default: only the group containing the active route is open.
    return this.activeGroupLabel() === label;
  }

  onFilterInput(event: Event): void {
    this.navFilter.set((event.target as HTMLInputElement).value);
  }

  clearFilter(): void {
    this.navFilter.set('');
  }

  toggleTheme(): void {
    this.theme.toggle();
  }

  // Skip-link target: move focus into the main region. Updating the hash via the
  // native anchor would scroll, so we manage focus explicitly and prevent default.
  focusMain(event: Event): void {
    event.preventDefault();
    const main = document.getElementById('main-content');
    main?.focus();
  }

  dismiss(id: number) {
    this.notifications.dismiss(id);
  }

  signIn(): void {
    this.auth.login();
  }

  signOut(): void {
    this.auth.logout();
  }

  badgeValue(key?: NavBadge): number {
    if (key === 'requests') return this.openRequestsBadge();
    if (key === 'risks') return this.riskBadge();
    if (key === 'changes') return this.changesBadge();
    if (key === 'overbooked') return this.overbookedBadge();
    return 0;
  }

  badgeDanger(key?: NavBadge): boolean {
    return key === 'risks' || key === 'overbooked';
  }
}
