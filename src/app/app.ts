import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { rxResource, toSignal } from '@angular/core/rxjs-interop';
import { forkJoin } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import {
  ApiService,
  ChangeRequest,
  Issue,
  Resource,
  ResourceRequest,
} from './services/api.service';
import { AuthService } from './services/auth.service';
import { NotificationService } from './services/notification.service';

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
      <header class="lg:hidden command-sidebar text-slate-900 px-4 py-3 flex items-center justify-between sticky top-0 z-40 shadow-sm">
        <div class="flex items-center gap-2">
          <span class="grid size-9 place-items-center rounded-md border border-blue-200 bg-blue-50 text-blue-600 ring-1 ring-blue-200">
            <mat-icon>hub</mat-icon>
          </span>
          <div>
            <div class="command-brand text-base leading-none text-slate-900 flex items-center gap-2">
              Delivery Control
              <span class="inline-block size-1.5 rounded-full bg-blue-600"></span>
            </div>
            <div class="text-[11px] text-slate-500">Portfolio command center</div>
          </div>
        </div>
        <button (click)="toggleMenu()" class="grid size-10 place-items-center rounded-md border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors" aria-label="Toggle navigation">
          <mat-icon>{{ isMobileMenuOpen() ? 'close' : 'menu' }}</mat-icon>
        </button>
      </header>

      @if (isMobileMenuOpen()) {
        <div
          class="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-40 lg:hidden transition-opacity"
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
        <div class="hidden lg:block sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-5">
          <div class="flex items-center gap-3 text-slate-900">
            <span class="grid size-10 place-items-center rounded-md border border-blue-200 bg-blue-50 text-blue-600 ring-1 ring-blue-200">
              <mat-icon>hub</mat-icon>
            </span>
            <div>
              <div class="command-brand text-lg leading-none text-slate-900 flex items-center gap-2">
                Delivery Control
                <span class="inline-block size-1.5 rounded-full bg-blue-600"></span>
              </div>
              <div class="mt-1 text-xs text-slate-500">PMO cockpit · Keycloak-ready RBAC</div>
            </div>
          </div>
          <div class="mt-4 grid grid-cols-4 gap-2 text-center">
            <div class="rounded-md border border-slate-200 bg-slate-50 px-2 py-2 ring-1 ring-slate-900/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-blue-700">{{ openRequestsBadge() }}</div>
              <div class="text-[10px] text-slate-500">REQ</div>
            </div>
            <div class="rounded-md border border-slate-200 bg-slate-50 px-2 py-2 ring-1 ring-slate-900/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-blue-700">{{ riskBadge() }}</div>
              <div class="text-[10px] text-slate-500">RISK</div>
            </div>
            <div class="rounded-md border border-slate-200 bg-slate-50 px-2 py-2 ring-1 ring-slate-900/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-blue-700">{{ changesBadge() }}</div>
              <div class="text-[10px] text-slate-500">CR</div>
            </div>
            <div class="rounded-md border border-slate-200 bg-slate-50 px-2 py-2 ring-1 ring-slate-900/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-blue-700">{{ overbookedBadge() }}</div>
              <div class="text-[10px] text-slate-500">LOAD</div>
            </div>
          </div>
        </div>

        <nav class="flex-1 px-3 py-4">
          <div class="command-nav-search">
            <mat-icon>search</mat-icon>
            <input
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
                [attr.aria-hidden]="!isGroupOpen(group.label)">
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

        <div class="sticky bottom-0 border-t border-slate-200 bg-white p-4">
          @if (isAuthenticated()) {
            <div class="flex items-center gap-3">
              <span class="grid size-9 shrink-0 place-items-center rounded-full border border-blue-200 bg-blue-50 text-blue-600 ring-1 ring-blue-200">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">account_circle</mat-icon>
              </span>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-semibold text-slate-900">{{ displayName() }}</div>
                <div class="truncate text-[11px] uppercase tracking-wide text-slate-500">{{ role() }}</div>
              </div>
              <button
                type="button"
                (click)="signOut()"
                class="grid size-9 shrink-0 place-items-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900 transition-colors"
                aria-label="Sign out"
                title="Sign out">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">logout</mat-icon>
              </button>
            </div>
          } @else {
            <button
              type="button"
              (click)="signIn()"
              class="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white outline-none transition-colors hover:bg-blue-700 focus:ring-2 focus:ring-blue-500/40">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">login</mat-icon>
              Sign in
            </button>
          }
        </div>
      </aside>

      <main class="flex-1 overflow-y-auto lg:h-screen">
        <div class="command-page p-4 sm:p-6 lg:p-7">
          <router-outlet></router-outlet>
        </div>
      </main>

      <div class="fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 pointer-events-none">
        @for (toast of toasts(); track toast.id) {
          <div class="pointer-events-auto flex items-start gap-3 rounded-md border p-4 text-sm font-semibold shadow-lg ring-1 animate-in"
               [class.bg-red-50]="toast.type === 'error'" [class.border-red-200]="toast.type === 'error'" [class.ring-red-200]="toast.type === 'error'" [class.text-red-700]="toast.type === 'error'"
               [class.bg-emerald-50]="toast.type === 'success'" [class.border-emerald-200]="toast.type === 'success'" [class.ring-emerald-200]="toast.type === 'success'" [class.text-emerald-700]="toast.type === 'success'"
               [class.bg-white]="toast.type === 'info'" [class.border-slate-200]="toast.type === 'info'" [class.ring-slate-200]="toast.type === 'info'" [class.text-slate-700]="toast.type === 'info'"
               role="status" aria-live="polite">
            <mat-icon class="text-[20px] w-[20px] h-[20px] shrink-0">
              {{ toast.type === 'error' ? 'error' : toast.type === 'success' ? 'check_circle' : 'info' }}
            </mat-icon>
            <span class="flex-1">{{ toast.message }}</span>
            <button (click)="dismiss(toast.id)" class="shrink-0 hover:opacity-70 transition-opacity" aria-label="Dismiss notification">
              <mat-icon class="text-[18px] w-[18px] h-[18px]">close</mat-icon>
            </button>
          </div>
        }
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

  readonly toasts = this.notifications.items;
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
      ],
    },
  ];

  // Capability-filtered nav: Customers/Contracts/Orders require
  // canManageCommercial() and Billing additionally requires
  // canApproveFinancials(), mirroring commercialGuard/financeGuard so links
  // only appear when they would actually navigate. An emptied Commercial group
  // is dropped entirely.
  readonly navGroups = computed<NavGroup[]>(() => {
    const canCommercial = this.auth.canManageCommercial();
    const canFinance = this.auth.canApproveFinancials();
    return this.allNavGroups
      .map(group => {
        if (group.label !== 'Commercial') return group;
        const items = group.items.filter(item => {
          if (item.route === '/billing') return canCommercial && canFinance;
          return canCommercial;
        });
        return { label: group.label, items };
      })
      .filter(group => group.items.length > 0);
  });

  private navRes = rxResource<NavState, unknown>({
    stream: () => forkJoin({
      requests: this.api.getRequests(),
      issues: this.api.getProjectIssues(),
      changes: this.api.getChangeRequests(),
      resources: this.api.getResources(),
    }),
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
