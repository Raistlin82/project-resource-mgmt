import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { NavigationEnd, Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule, MatIconRegistry } from '@angular/material/icon';
import { CdkTrapFocus } from '@angular/cdk/a11y';
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
import {
  ABSENCE_REASON_READ_ROLES,
  ALLOCATION_APPROVAL_ROLES,
  CAPACITY_ROLES,
  PROJECT_CLASSIFICATION_ROLES,
} from './guards/role.guard';
// The history register's role set lives beside its route (app.routes.ts) so the
// guard stays importable without dragging in the screen's lazy chunk; the nav
// entry reads that SAME constant, never a second hand-typed list.
import { AUDIT_TRAIL_READ_ROLES } from './app.routes';
import { countsTowardDeliveryCapacity, kindOf } from './services/resource-kind.util';

type NavBadge = 'requests' | 'risks' | 'changes' | 'overbooked';

/**
 * The single breakpoint at which `#primary-navigation` stops being the mobile
 * drawer and becomes the desktop sidebar. It MUST stay in lock-step with
 * Tailwind's `lg:` variant (64rem, the framework default — this workspace
 * declares no `--breakpoint-*` override in `@theme`) and with the
 * `.command-drawer` / `.command-drawer-open` rules in `src/styles.css`. Exported
 * so the spec can assert the stylesheet against this very literal.
 */
export const DESKTOP_NAV_QUERY = '(min-width: 64rem)';

/** Class applied to `<html>` to lock document scrolling behind the open drawer. */
const DRAWER_OPEN_CLASS = 'command-drawer-open';

/**
 * Platform-aware label and ARIA key sequence for the nav-search shortcut, so the
 * hint beside the input is honest on a PC keyboard instead of always claiming
 * `⌘K` (P2-06). Exported as a pure function because it is where the platform
 * decision actually lives, and therefore where it is unit-tested.
 *
 * `platform` is whatever the host reports (`navigator.platform`, falling back to
 * `navigator.userAgent`); `undefined` means "no navigator", i.e. the server,
 * which renders the Ctrl form.
 */
export function navShortcutHint(platform: string | undefined): { label: string; keys: string } {
  return /mac|iphone|ipad|ipod/i.test(platform ?? '')
    ? { label: '⌘K', keys: 'Meta+K' }
    : { label: 'Ctrl K', keys: 'Control+K' };
}

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
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, CdkTrapFocus],
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
        <button
          #mobileMenuButton
          data-testid="mobile-menu-toggle"
          type="button"
          (click)="toggleMenu()"
          class="grid size-10 place-items-center rounded-md border border-line text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
          aria-label="Toggle navigation"
          aria-controls="primary-navigation"
          [attr.aria-expanded]="isMobileMenuOpen()">
          <mat-icon>{{ isMobileMenuOpen() ? 'close' : 'menu' }}</mat-icon>
        </button>
      </header>

      @if (isMobileMenuOpen()) {
        <!-- Decorative scrim: tap-to-dismiss for pointer users only. It is
             aria-hidden and tabindex="-1" (programmatically focusable, never
             tab-reachable) — keyboard users close the drawer with Escape or its
             own Close button, which is why this is NOT a role="button" with a
             keydown handler as it used to be. -->
        <div
          class="fixed inset-0 bg-scrim/40 backdrop-blur-sm z-40 lg:hidden transition-opacity"
          tabindex="-1"
          (click)="closeMenu(true)"
          aria-hidden="true">
        </div>
      }

      <!--
        ONE element, two roles — the open/hidden model every shell fix shares.

          isMobileMenuOpen()   meaningful only BELOW lg. Drives the slide-in
                               transform, the CDK focus trap, main[inert], the
                               <html> scroll lock, and data-drawer.
          desktopSidebarOpen() meaningful only AT lg and above. Drives
                               lg:relative / lg:hidden.

        Whether the drawer's links are in the tab order is decided in
        src/styles.css off data-drawer, INSIDE a breakpoint scope. Nothing here
        binds [inert] or [hidden] on this element: at lg+ it is the desktop
        sidebar, and a blanket attribute would strand desktop navigation
        entirely — the trap that left P1-23 open.
      -->
      <aside
        id="primary-navigation"
        aria-label="Primary navigation"
        class="command-sidebar command-drawer fixed inset-y-0 left-0 z-50 w-72 flex flex-col transform transition-transform duration-300 ease-in-out lg:translate-x-0 overflow-y-auto shadow-2xl lg:shadow-none"
        [attr.data-drawer]="isMobileMenuOpen() ? 'open' : 'closed'"
        [cdkTrapFocus]="isMobileMenuOpen()"
        [cdkTrapFocusAutoCapture]="drawerAutoCapture()"
        tabindex="-1"
        (keydown.escape)="closeMenu(true)"
        [class.-translate-x-full]="!isMobileMenuOpen()"
        [class.translate-x-0]="isMobileMenuOpen()"
        [class.lg:relative]="desktopSidebarOpen()"
        [class.lg:hidden]="!desktopSidebarOpen()">
        <div class="flex items-center justify-between border-b border-line bg-surface px-4 py-3 lg:hidden">
          <span class="text-sm font-semibold text-ink">Navigation</span>
          <button
            data-testid="mobile-menu-close"
            type="button"
            (click)="closeMenu(true)"
            class="grid size-10 place-items-center rounded-md border border-line text-ink-secondary hover:bg-surface-muted hover:text-ink"
            aria-label="Close navigation">
            <mat-icon>close</mat-icon>
          </button>
        </div>
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
          <div class="mt-4 grid grid-cols-2 gap-2 text-center" [class.grid-cols-4]="canReadStaffing()">
            @if (canReadStaffing()) {
              <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
                <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ openRequestsBadge() }}</div>
                <div class="text-[10px] text-ink-muted">REQ</div>
              </div>
            }
            <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ riskBadge() }}</div>
              <div class="text-[10px] text-ink-muted">RISK</div>
            </div>
            <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
              <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ changesBadge() }}</div>
              <div class="text-[10px] text-ink-muted">CR</div>
            </div>
            @if (canReadStaffing()) {
              <div class="rounded-md border border-line bg-surface-muted px-2 py-2 ring-1 ring-black/5">
                <div class="font-mono tabular-nums text-sm font-semibold text-accent-text">{{ overbookedBadge() }}</div>
                <div class="text-[10px] text-ink-muted">LOAD</div>
              </div>
            }
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
              [attr.aria-keyshortcuts]="shortcut.keys"
              aria-label="Filter navigation" />
            @if (navFilter()) {
              <button type="button" class="command-nav-clear grid size-6 place-items-center" (click)="clearFilter()" aria-label="Clear filter">
                <mat-icon class="text-[16px] w-[16px] h-[16px]">close</mat-icon>
              </button>
            } @else {
              <!-- Platform-aware: a PC keyboard has no ⌘. Same source as the
                   aria-keyshortcuts above, so the two can never disagree. -->
              <kbd data-testid="nav-search-shortcut">{{ shortcut.label }}</kbd>
            }
          </div>

          @for (group of filteredGroups(); track group.label) {
            <section class="mb-2">
              <button
                type="button"
                class="command-nav-group-header"
                [attr.aria-expanded]="isGroupOpen(group.label)"
                [attr.aria-controls]="navGroupId(group.label)"
                [attr.aria-label]="'Toggle ' + group.label + ' navigation group'"
                (click)="toggleGroup(group.label)">
                <span class="command-section-label">{{ group.label }}</span>
                <mat-icon class="command-nav-chevron">chevron_right</mat-icon>
              </button>
              <div
                class="command-nav-group-body"
                [class.open]="isGroupOpen(group.label)"
                [id]="navGroupId(group.label)"
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

      <main id="main-content" tabindex="-1" [inert]="isMobileMenuOpen()" class="flex-1 overflow-y-auto lg:h-screen outline-none">
        <!-- Desktop top bar: hamburger to collapse/expand the left navigation. -->
        <div class="hidden lg:flex items-center gap-3 sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur px-4 py-2">
          <button
            type="button"
            (click)="toggleDesktopSidebar()"
            class="grid size-9 place-items-center rounded-md border border-line text-ink-secondary hover:text-ink hover:bg-surface-muted transition-colors"
            [attr.aria-label]="desktopSidebarOpen() ? 'Collapse navigation' : 'Expand navigation'"
            [attr.aria-expanded]="desktopSidebarOpen()">
            <mat-icon>{{ desktopSidebarOpen() ? 'menu_open' : 'menu' }}</mat-icon>
          </button>
          @if (!desktopSidebarOpen()) {
            <span class="command-brand text-sm text-ink">Delivery Control</span>
          }
        </div>
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
      <div class="fixed bottom-4 left-4 right-4 z-[100] flex max-h-[calc(100dvh-2rem)] w-auto max-w-sm flex-col overflow-y-auto pointer-events-none sm:left-auto sm:w-full">
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
  private isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  // Nav search input, used by the global ⌘K shortcut to focus the filter.
  private navSearch = viewChild<ElementRef<HTMLInputElement>>('navSearch');
  private mobileMenuButton = viewChild<ElementRef<HTMLButtonElement>>('mobileMenuButton');

  // Theme state surfaced to the toggle control (light-first; dark is opt-in).
  readonly isDark = computed(() => this.theme.theme() === 'dark');

  /**
   * Resolved once, before the first render, so hydration sees the browser's own
   * answer rather than a value that flips later. The server has no
   * `navigator.platform` and renders the Ctrl form; on a Mac the browser's
   * constructor pass renders `⌘K`. Only the interpolated text differs between
   * the two, never the element structure.
   */
  readonly shortcut = navShortcutHint(
    typeof navigator === 'undefined' ? undefined : navigator.platform || navigator.userAgent,
  );

  constructor() {
    // Ensure EVERY <mat-icon> uses the Material Icons ligature font. Without a
    // registered default font set, some mat-icon instances render the ligature
    // source text (e.g. "insights"/"add") instead of the glyph. SSR-safe (no DOM).
    const iconRegistry = inject(MatIconRegistry);
    iconRegistry.setDefaultFontSetClass('material-icons', 'mat-ligature-font');

    // Browser-only (afterNextRender never runs on the server) global ⌘K / Ctrl+K
    // shortcut that focuses the nav search input, making the kbd hint honest.
    // Both modifiers are accepted regardless of the hint's platform wording — a
    // Mac with an external PC keyboard is a real configuration.
    afterNextRender(() => {
      const handler = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          this.focusNavSearch();
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

    // Scroll lock for the open mobile drawer (P1-23): below lg the document —
    // not <main> — is the scroll container, so the page would otherwise scroll
    // away behind the scrim under the user's finger. The class goes on <html>
    // because that element is outside this component's template, and its effect
    // is breakpoint-scoped in styles.css (.command-drawer-open) for the same
    // reason the drawer's visibility is: at lg+ the aside is the desktop sidebar
    // and the page must keep scrolling.
    if (this.isBrowser) {
      effect(() => {
        document.documentElement.classList.toggle(DRAWER_OPEN_CLASS, this.isMobileMenuOpen());
      });
      this.destroyRef.onDestroy(() => document.documentElement.classList.remove(DRAWER_OPEN_CLASS));
    }
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
        { label: 'Search', icon: 'search', route: '/search' },
        { label: 'My Profile', icon: 'person', route: '/profile' },
        { label: 'My Assignments', icon: 'event_note', route: '/assignments' },
        { label: 'Resource Requests', icon: 'assignment', route: '/requests', badge: 'requests' },
        { label: 'Resources', icon: 'badge', route: '/resources' },
        { label: 'Staffing', icon: 'group_add', route: '/staffing' },
        { label: 'Schedule', icon: 'calendar_view_week', route: '/schedule' },
        { label: 'Approvals', icon: 'fact_check', route: '/approvals' },
        { label: 'Absences', icon: 'person_off', route: '/absences' },
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
        { label: 'Project Cost Centers', icon: 'account_balance', route: '/project-cost-centers' },
        { label: 'Engagement Classification', icon: 'label', route: '/project-classification' },
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
        { label: 'Capacity', icon: 'calendar_view_month', route: '/capacity' },
        { label: 'Bench', icon: 'event_busy', route: '/bench' },
        { label: 'Allocation Approvals', icon: 'fact_check', route: '/allocation-approvals' },
        { label: 'Reporting', icon: 'insights', route: '/reporting', badge: 'risks' },
        { label: 'History', icon: 'history', route: '/audit-trail' },
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
        { label: 'Organization Cost Centers', icon: 'account_balance', route: '/config/cost-centers', compact: true },
        { label: 'Service Orgs', icon: 'business', route: '/config/service-orgs', compact: true },
        { label: 'Resource Orgs', icon: 'domain', route: '/config/resource-orgs', compact: true },
        { label: 'Locations', icon: 'public', route: '/config/locations', compact: true },
        { label: 'Industries', icon: 'factory', route: '/config/industries', compact: true },
        { label: 'Cost Categories', icon: 'sell', route: '/config/cost-categories', compact: true },
        { label: 'Partner Roles', icon: 'diversity_3', route: '/config/partner-roles', compact: true },
        { label: 'Vendors', icon: 'storefront', route: '/config/vendors', compact: true },
        { label: 'Rate Cards', icon: 'request_quote', route: '/config/rate-cards', compact: true },
        { label: 'Availability Data', icon: 'event_available', route: '/config/availability', compact: true },
        { label: 'Integrations', icon: 'cable', route: '/config/integrations', compact: true },
      ],
    },
  ];

  // Capability-filtered nav mirrors the route guards so links only appear when
  // they would actually navigate. Finance-grade project/config pages expose
  // budget/cost data; approvals expose routed workflow items.
  readonly navGroups = computed<NavGroup[]>(() => {
    const canReadStaffing = this.auth.canReadStaffing();
    const canManageStaffing = this.auth.canManageStaffing();
    const canManageResources = this.auth.canManageResources();
    const canCommercial = this.auth.canReadCommercial();
    const canFinance = this.auth.canReadFinancials();
    const canManageProjects = this.auth.canManageProjects();
    const canManageConfiguration = this.auth.canManageConfiguration();
    const canViewPortfolio = this.auth.canViewPortfolioDashboard();
    const canApproveWorkflow = this.auth.hasAnyRole(['pm', 'resource-manager', 'delivery-executive', 'finance', 'admin']);
    // Capacity nav visibility uses the SAME role set as capacityGuard (imported
    // CAPACITY_ROLES) — a dedicated local so it can never desync from the route
    // gate, and stays independent of the (semantically different) approvals gate.
    const canViewCapacity = this.auth.hasAnyRole([...CAPACITY_ROLES]);
    // Allocation Approvals nav visibility uses the SAME role set as
    // allocationApprovalsGuard (imported ALLOCATION_APPROVAL_ROLES) — a
    // dedicated local so it can never desync from the route gate.
    const canViewAllocationApprovals = this.auth.hasAnyRole([...ALLOCATION_APPROVAL_ROLES]);
    // H — the two block-H screens gate their nav entries on the SAME exported
    // role sets their route guards use, so a nav link can never outlive the gate
    // behind it. Absences deliberately includes `employee`: the server serves
    // them their OWN rows, so the link leads somewhere real for them.
    const canViewAbsences = this.auth.hasAnyRole([...ABSENCE_REASON_READ_ROLES]);
    const canClassifyEngagements = this.auth.hasAnyRole([...PROJECT_CLASSIFICATION_ROLES]);
    // The history register is the NARROWEST entry in Analytics: the audit trail is
    // cross-cutting and carries special-category data by ricochet, so its nav gate
    // is the server's own '/audit-logs' audience and NOT the group's canReadStaffing
    // default — which would advertise the register to pm/resource-manager/finance
    // and land them on a 403.
    const canViewAuditTrail = this.auth.hasAnyRole([...AUDIT_TRAIL_READ_ROLES]);
    // Resources (people lifecycle) mirrors its roleGuard — visible only to the
    // roles that own resource master data (resource-manager/delivery-executive/admin).
    return this.allNavGroups
      .map(group => {
        if (group.label === 'Resource Control') {
          const items = group.items.filter(item => {
            if (item.route === '/requests' || item.route === '/staffing' || item.route === '/schedule') return canManageStaffing;
            if (item.route === '/resources') return canManageResources;
            if (item.route === '/approvals') return canApproveWorkflow;
            if (item.route === '/absences') return canViewAbsences;
            return true;
          });
          return { label: group.label, items };
        }
        if (group.label === 'Project Control') {
          const items = group.items.filter(item => {
            if (item.route === '/financial-plans' || item.route === '/project-cost-centers') return canFinance;
            if (item.route === '/project-classification') return canClassifyEngagements;
            if (item.route === '/projects') return true;
            return canManageProjects;
          });
          return { label: group.label, items };
        }
        if (group.label === 'Commercial') {
          const items = group.items.filter(item => {
            if (item.route === '/billing') return canCommercial && canFinance;
            return canCommercial;
          });
          return { label: group.label, items };
        }
        if (group.label === 'Analytics') {
          const items = group.items.filter(item => {
            if (item.route === '/capacity') return canViewCapacity;
            if (item.route === '/bench') return canViewCapacity;
            if (item.route === '/allocation-approvals') return canViewAllocationApprovals;
            if (item.route === '/reporting') return canViewPortfolio;
            if (item.route === '/audit-trail') return canViewAuditTrail;
            return canReadStaffing;
          });
          return { label: group.label, items };
        }
        if (group.label === 'Configuration') {
          // The Phase F1 customizing catalogs mirror their route guards
          // (admin/delivery-executive); Integrations mirrors financeGuard.
          const canManageCatalogs = this.auth.hasAnyRole(['admin', 'delivery-executive']);
          // Rate Cards (Phase E) expose rates — finance-grade roles only.
          const canManageRateCards = this.auth.hasAnyRole(['admin', 'delivery-executive', 'finance']);
          const catalogRoutes = new Set([
            '/config/locations', '/config/industries', '/config/cost-categories',
            '/config/partner-roles', '/config/vendors',
          ]);
          const items = group.items.filter(item => {
            if (item.route === '/config/integrations') return canFinance;
            if (item.route === '/config/cost-centers') return canFinance;
            if (item.route === '/config/rate-cards') return canManageRateCards;
            if (item.route === '/config/availability') return canManageResources;
            if (catalogRoutes.has(item.route)) return canManageCatalogs;
            return canManageConfiguration;
          });
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
  private navRes = rxResource<NavState, { ready: boolean; canReadStaffing: boolean }>({
    params: () => ({
      ready: this.auth.authReady(),
      canReadStaffing: this.auth.canReadStaffing(),
    }),
    stream: ({ params }) =>
      params.ready
        ? forkJoin({
            requests: params.canReadStaffing ? this.api.getRequests() : of<ResourceRequest[]>([]),
            issues: this.api.getProjectIssues(),
            changes: this.api.getChangeRequests(),
            resources: params.canReadStaffing ? this.api.getResources() : of<Resource[]>([]),
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
  readonly canReadStaffing = this.auth.canReadStaffing;

  /** Mobile-only (below lg): whether the drawer is open. See the model comment on
   *  the <aside> — this is never set at lg+, because it also inerts <main>. */
  isMobileMenuOpen = signal(false);
  /** Desktop-only: whether the left nav is expanded (lg+). Toggled by the top-bar
   *  hamburger; when false the sidebar is removed from the layout and the content
   *  pane takes the full width. */
  desktopSidebarOpen = signal(true);

  /**
   * True for the duration of a ⌘K-initiated drawer open. The drawer's focus trap
   * auto-captures its first tabbable element — the Close button — whenever it is
   * armed, which on this one path would fight the focus we are about to place on
   * the search input. Withheld for that open only, and re-armed on close.
   */
  private searchFocusPending = signal(false);
  /** Whether the drawer's focus trap may capture focus on open. */
  readonly drawerAutoCapture = computed(() => this.isMobileMenuOpen() && !this.searchFocusPending());

  // Live filter for the nav.
  navFilter = signal('');

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

  /**
   * Which accordion groups are open, linked to the active route (P2-05).
   *
   * When the active group CHANGES, that group is added to the open set, so a
   * navigation can never land on a link inside a collapsed group — and the group
   * bodies carry [inert] when collapsed, so such a link is not merely invisible
   * but unreachable. The previous model froze on first interaction: one manual
   * toggle switched the accordion into "manual mode" for the rest of the session
   * and every later navigation into a different group stayed shut.
   *
   * The set stays writable, so `toggleGroup` can still collapse the active group
   * afterwards — the header button must not become a dead control. It reopens
   * only when the active group actually changes, so navigating within one group
   * respects a deliberate collapse.
   */
  private expandedGroups = linkedSignal<string | null, ReadonlySet<string>>({
    source: () => this.activeGroupLabel(),
    computation: (active, previous) => {
      const next = new Set(previous?.value ?? []);
      if (active) next.add(active);
      return next;
    },
  });

  // Filtered groups; while a query is active, only matching items/groups are shown.
  filteredGroups = computed<NavGroup[]>(() => {
    const q = this.navFilter().trim().toLowerCase();
    if (!q) return this.navGroups();
    return this.navGroups()
      .map(group => ({
        label: group.label,
        items: group.label.toLowerCase().includes(q)
          ? group.items
          : group.items.filter(i => i.label.toLowerCase().includes(q)),
      }))
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
  /**
   * C1: same "who is overbooked" semantic as the dashboard's
   * `overbookedResourcesList` — a dummy is a placeholder hole, not a real
   * over-booked body, and must never inflate this globally-visible nav badge;
   * a subco IS deliverable capacity, just not internal, so it stays in
   * (`countsTowardDeliveryCapacity`). Keeping this in lock-step with the
   * dashboard matters: two views of the same KPI disagreeing is worse than
   * either being wrong consistently.
   */
  overbookedBadge = computed(() =>
    this.navState().resources.filter(r => countsTowardDeliveryCapacity(kindOf(r)) && r.utilization > 110).length,
  );

  toggleMenu() {
    if (this.isMobileMenuOpen()) {
      this.closeMenu(true);
    } else {
      this.isMobileMenuOpen.set(true);
    }
  }

  closeMenu(restoreFocus = false) {
    this.isMobileMenuOpen.set(false);
    // Re-arm the trap's auto-capture for the next ordinary open. Written AFTER
    // the line above so drawerAutoCapture is never transiently true.
    this.searchFocusPending.set(false);
    if (restoreFocus) this.mobileMenuButton()?.nativeElement.focus();
  }

  toggleDesktopSidebar() {
    this.desktopSidebarOpen.update(v => !v);
  }

  /**
   * ⌘K / Ctrl+K target. The nav search lives inside the one element that is the
   * mobile drawer below lg and the desktop sidebar above it, and in both roles it
   * can be hidden right now — off-canvas and `visibility: hidden` as a closed
   * drawer, `display: none` as a collapsed sidebar. `focus()` on a non-rendered
   * element silently no-ops, so the container that governs the CURRENT breakpoint
   * is opened first and the focus deferred by one frame, after change detection
   * and a paint have actually revealed it.
   */
  focusNavSearch(): void {
    if (this.isDesktopViewport()) {
      this.desktopSidebarOpen.set(true);
    } else {
      this.searchFocusPending.set(true);
      this.isMobileMenuOpen.set(true);
    }
    requestAnimationFrame(() => {
      const input = this.navSearch()?.nativeElement;
      input?.focus();
      input?.select();
    });
  }

  /**
   * Which role the shared <aside> is playing right now. `matchMedia` is the only
   * honest source, because Tailwind's `lg:` variant is a media query and not
   * component state.
   *
   * Its absence — the server, or a test environment such as jsdom, which ships no
   * `matchMedia` at all — is treated as DESKTOP deliberately: the mobile branch
   * sets `isMobileMenuOpen`, which makes <main> inert, so guessing "mobile" on a
   * wide viewport would lock the user out of the page. Guessing "desktop" only
   * ever expands a sidebar.
   */
  private isDesktopViewport(): boolean {
    const query = typeof window === 'undefined' ? undefined : window.matchMedia;
    return query ? query.call(window, DESKTOP_NAV_QUERY).matches : true;
  }

  toggleGroup(label: string): void {
    this.expandedGroups.update(prev => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  }

  isGroupOpen(label: string): boolean {
    // While filtering, matching groups are force-expanded.
    if (this.navFilter().trim()) return true;
    // Otherwise the open set is authoritative; it always contains the active
    // group (see expandedGroups) unless the user has collapsed it since.
    return this.expandedGroups().has(label);
  }

  navGroupId(label: string): string {
    return `navgroup-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
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
