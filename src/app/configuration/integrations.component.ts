import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, PLATFORM_ID, signal } from '@angular/core';
import { DatePipe, DecimalPipe, isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconModule } from '@angular/material/icon';
import { forkJoin, of } from 'rxjs';
import {
  ApiService,
  BiFeedCell,
  BiFeedPreview,
  CrmOutboxEntry,
  IntegrationDescriptor,
  IntegrationKind,
  IntegrationsInfo,
  Order,
} from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { NotificationService } from '../services/notification.service';
import { ListStateComponent } from '../shared/list-state.component';

interface IntegrationsPageData {
  info: IntegrationsInfo | null;
  orders: Order[];
}

type BusyAction = 'erp-csv' | 'erp-json' | 'einvoice' | null;

/**
 * Integrations page: one card per integration kind (ERP, e-invoicing, CRM,
 * BI). Every adapter is IMPLEMENTED but NOT CONNECTED — it produces a local
 * artifact (CSV/JSON/XML) from live data; nothing is ever transmitted to an
 * external system. Downloads are browser-guarded (SSR no-op) and fetched as
 * blobs through HttpClient so the auth interceptor attaches the bearer token.
 */
@Component({
  selector: 'app-integrations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule, DatePipe, DecimalPipe, ListStateComponent],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Configuration</div>
          <h1 class="command-title">Integrations</h1>
          <p class="command-subtitle">
            Local export previews for ERP, e-invoicing, CRM and BI. Each adapter turns live data into an
            inspectable file without sending it to an external service.
          </p>
        </div>
      </header>

      @if (accessNotice(); as notice) {
        <div class="command-card-muted p-4 flex items-start gap-3" role="alert">
          <mat-icon class="text-[20px] w-[20px] h-[20px] text-[var(--cc-amber-text)] shrink-0">lock</mat-icon>
          <p class="text-sm font-medium text-[var(--cc-ink)]">{{ notice }}</p>
        </div>
      }

      <!-- The whole card grid lives inside the wrapper, not beside it. Every card
           dereferences the guarded envelopes (descriptors, activeKey, the order
           list, the outbox table), and each one also offers a DOWNLOAD button for
           an artifact built from the very data that failed to load — a CSV export
           of a ledger this page could not read is not an affordance, it is a
           second failure. ListState's ng-template is what keeps the deferral
           honest: Angular evaluates ordinary projected bindings even inside a
           hidden @if branch. -->
      <app-list-state [loading]="dataLoading()" [error]="dataError()" skeleton="cards" [rows]="4"
                      label="integration adapters" (retry)="reload()">
        <ng-template>
      <div class="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <!-- ERP / General ledger -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div class="flex items-start gap-3">
              <mat-icon class="text-[24px] text-[var(--cc-primary)]">account_balance</mat-icon>
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ erpDescriptor()?.name ?? 'General Ledger Export' }}</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">
                  {{ erpDescriptor()?.description ?? 'Balanced double-entry GL journal export built from the revenue-recognition schedule.' }}
                </p>
              </div>
            </div>
            <span class="command-status amber shrink-0">Not connected</span>
          </div>
          <div class="p-4 space-y-3">
            <div class="text-xs font-medium text-[var(--cc-muted)]">
              Active adapter: <span class="font-mono">{{ activeKey('erp') }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="command-button" [disabled]="busy() !== null" (click)="downloadJournal('csv')">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">download</mat-icon>
                Download GL journal (CSV)
              </button>
              <button type="button" class="command-button secondary" [disabled]="busy() !== null" (click)="downloadJournal('json')">
                <mat-icon class="text-[20px] w-[20px] h-[20px]">data_object</mat-icon>
                (JSON)
              </button>
            </div>
            <p class="text-xs text-[var(--cc-muted)]">Monthly revenue-recognition journal; the export window is derived from dated financial activity. Σ debit always equals Σ credit.</p>
          </div>
        </section>

        <!-- E-invoicing / FatturaPA -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div class="flex items-start gap-3">
              <mat-icon class="text-[24px] text-[var(--cc-primary)]">receipt_long</mat-icon>
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ einvoiceDescriptor()?.name ?? 'FatturaPA e-invoice' }}</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">
                  {{ einvoiceDescriptor()?.description ?? 'Simplified Italian FatturaElettronica v1.2 XML (FPR12) for an invoiced order.' }}
                </p>
              </div>
            </div>
            <span class="command-status amber shrink-0">Not connected</span>
          </div>
          <div class="p-4 space-y-3">
            <div class="text-xs font-medium text-[var(--cc-muted)]">
              Active adapter: <span class="font-mono">{{ activeKey('einvoice') }}</span>
            </div>
            <div>
              <label for="einvoiceOrder" class="block text-sm font-medium text-[var(--cc-muted)] mb-1">Invoiced order</label>
              <!-- [selected] per OPTION, never [value] on the select: a [value]
                   applied before its @for options exist is dropped and never
                   re-applied, because the bound expression itself has not
                   changed. Masked today only because the initial '' matches the
                   static placeholder; it breaks the moment selectedOrderId is set
                   programmatically or the order list reloads. -->
              <select
                id="einvoiceOrder"
                (change)="onOrderSelect($event)"
                class="command-select">
                <option value="" [selected]="selectedOrderId() === ''">Select an invoiced order…</option>
                @for (order of invoicedOrders(); track order.id) {
                  <option [value]="order.id" [selected]="order.id === selectedOrderId()">{{ order.invoiceNumber }} · Order {{ order.id }} ({{ order.currency }} {{ order.amount | number:'1.0-0' }})</option>
                }
              </select>
            </div>
            <button type="button" class="command-button" [disabled]="!selectedOrderId() || busy() !== null" (click)="downloadInvoiceXml()">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">description</mat-icon>
              Generate FatturaPA preview
            </button>
            <p class="text-xs text-[var(--cc-muted)]">
              Preview only: customer fiscal identifiers and address data are not stored by this application,
              so this XML is not submission-ready and is never sent to SDI.
            </p>
            @if (invoicedOrders().length === 0) {
              <p class="text-xs text-[var(--cc-muted)]">No eligible customer invoices available. Only Invoiced or Paid customer orders can be exported.</p>
            }
          </div>
        </section>

        <!-- CRM sync outbox -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div class="flex items-start gap-3">
              <mat-icon class="text-[24px] text-[var(--cc-primary)]">sync_alt</mat-icon>
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ crmDescriptor()?.name ?? 'CRM Sync Outbox' }}</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">
                  {{ crmDescriptor()?.description ?? 'Builds the JSON payload a CRM webhook would receive and parks it in a Prepared outbox.' }}
                </p>
              </div>
            </div>
            <span class="command-status amber shrink-0">Not connected</span>
          </div>
          <div class="p-4 space-y-3">
            <div class="text-xs font-medium text-[var(--cc-muted)]">
              Active adapter: <span class="font-mono">{{ activeKey('crm') }}</span>
            </div>
            <button type="button" class="command-button" [disabled]="preparing()" (click)="prepareSync()" [attr.aria-label]="preparing() ? 'Preparing CRM sync payload' : 'Prepare CRM sync payload'">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">outbox</mat-icon>
              {{ preparing() ? 'Preparing…' : 'Prepare sync payload' }}
            </button>
            <p class="text-xs text-[var(--cc-muted)]">The outbox is ephemeral demo state: entries are kept in memory only and never transmitted.</p>
            <div class="overflow-x-auto">
              <table class="command-data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Prepared at</th>
                    <th>Status</th>
                    <th>Accounts</th>
                    <th>Deals</th>
                  </tr>
                </thead>
                <tbody>
                  @for (entry of outbox(); track entry.id) {
                    <tr>
                      <td class="font-mono">{{ entry.id }}</td>
                      <td>{{ entry.preparedAt | date:'medium' }}</td>
                      <td><span class="command-status">{{ entry.status }}</span></td>
                      <td class="font-mono">{{ entry.payload.accounts.length }}</td>
                      <td class="font-mono">{{ entry.payload.deals.length }}</td>
                    </tr>
                  } @empty {
                    <tr>
                      <td colspan="5" class="text-center text-[var(--cc-muted)]">No prepared payloads yet.</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <!-- BI feed -->
        <section class="command-card overflow-hidden">
          <div class="command-card-header">
            <div class="flex items-start gap-3">
              <mat-icon class="text-[24px] text-[var(--cc-primary)]">insights</mat-icon>
              <div>
                <h2 class="font-display text-xl font-bold text-[var(--cc-ink)]">{{ biDescriptor()?.name ?? 'BI Feed' }}</h2>
                <p class="mt-1 text-sm text-[var(--cc-muted)]">
                  {{ biDescriptor()?.description ?? 'Flat JSON dataset (one row per project, primitives only) for Power BI / Tableau ingestion.' }}
                </p>
              </div>
            </div>
            <span class="command-status amber shrink-0">Not connected</span>
          </div>
          <div class="p-4 space-y-3">
            <div class="text-xs font-medium text-[var(--cc-muted)]">
              Active adapter: <span class="font-mono">{{ activeKey('bi') }}</span>
            </div>
            <button type="button" class="command-button" [disabled]="loadingPreview()" (click)="previewFeed()" [attr.aria-label]="loadingPreview() ? 'Loading BI feed preview' : 'Preview BI feed'">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">preview</mat-icon>
              {{ loadingPreview() ? 'Loading…' : 'Preview feed' }}
            </button>
            @if (biPreview(); as feed) {
              <div class="text-xs font-medium text-[var(--cc-muted)]">
                {{ feed.rowCount }} rows · generated {{ feed.generatedAt | date:'medium' }} · showing first {{ previewRows().length }}
              </div>
              <div class="overflow-x-auto">
                <table class="command-data-table">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Status</th>
                      <th>Revenue</th>
                      <th>Actual cost</th>
                      <th>Margin %</th>
                      <th>VAC</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of previewRows(); track $index) {
                      <tr>
                        <td class="font-bold">{{ cellText(row, 'projectName') }}</td>
                        <td>{{ cellText(row, 'status') }}</td>
                        <td class="font-mono">{{ cellNumber(row, 'revenue') | number:'1.0-0' }}</td>
                        <td class="font-mono">{{ cellNumber(row, 'actualCost') | number:'1.0-0' }}</td>
                        <td class="font-mono">{{ cellNumber(row, 'marginPct') | number:'1.0-1' }}</td>
                        <td class="font-mono">{{ cellNumber(row, 'vac') | number:'1.0-0' }}</td>
                      </tr>
                    } @empty {
                      <tr>
                        <td colspan="6" class="text-center text-[var(--cc-muted)]">The feed contains no rows.</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </div>
        </section>
      </div>
        </ng-template>
      </app-list-state>
    </div>
  `,
})
export class IntegrationsComponent {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private http = inject(HttpClient);
  private notifications = inject(NotificationService);
  private destroyRef = inject(DestroyRef);
  private platformId = inject(PLATFORM_ID);

  private static readonly EMPTY_DATA: IntegrationsPageData = { info: null, orders: [] };

  // Both reads are principal-gated server-side; key the load on auth readiness
  // so requests fire only once the bearer token can be attached (mirrors the
  // dashboard's gated rxResource pattern).
  private dataRes = rxResource<IntegrationsPageData, boolean>({
    params: () => this.auth.authReady(),
    stream: ({ params: ready }) =>
      ready
        ? forkJoin({ info: this.api.getIntegrations(), orders: this.api.getOrders() })
        : of(IntegrationsComponent.EMPTY_DATA),
    defaultValue: IntegrationsComponent.EMPTY_DATA,
  });

  /** Bumped after a successful POST so the outbox list refreshes. */
  private outboxTick = signal(0);

  private outboxRes = rxResource<CrmOutboxEntry[], { ready: boolean; tick: number }>({
    params: () => ({ ready: this.auth.authReady(), tick: this.outboxTick() }),
    stream: ({ params }) => (params.ready ? this.api.getCrmOutbox() : of<CrmOutboxEntry[]>([])),
    defaultValue: [],
  });

  /**
   * READ-FAILURE GUARD — the ONE place `dataRes.value()` is dereferenced.
   *
   * `rxResource.value()` THROWS ResourceValueError while its status is 'error',
   * and this envelope used to be the bare `.value` accessor read from bindings
   * in all four cards: `erpDescriptor()` is evaluated by the very first heading
   * on the page. A throw there aborts the whole change-detection pass and every
   * later one at the same expression, so a 401/403/500 on either leg left the
   * page frozen — and this screen had no error affordance of its own to be made
   * unreachable, which is worse than the /capacity case, not better: there was
   * never a message or a Retry to reach.
   *
   * This is NOT the banned `status()==='error' ? [] : value()`: emptiness is
   * never this screen's ANSWER about the data. `dataError()` gates the entire
   * card grid, ListState replaces it with the error panel plus Retry, and
   * `accessNotice()` says why — the empty envelope exists only so the signal
   * graph can settle while those surfaces are what the user sees.
   *
   * Honest about what carries the fix: the ListState wrapper alone is what a user
   * hits, because its `ng-template` is never instantiated in the error state, so
   * this guard is REDUNDANT today — neutralising it leaves every rendering test
   * green (the spec says so, and pins the guard with its own direct-accessor
   * case). It stays because template placement protects a template and nothing
   * else: the moment a binding, an effect or an export handler reads one of these
   * signals from OUTSIDE that view — which is exactly the shape that took
   * /capacity down — the reordering is worth nothing and this short-circuit is
   * the whole defence.
   */
  private data = computed<IntegrationsPageData>(() =>
    this.dataRes.status() === 'error' ? IntegrationsComponent.EMPTY_DATA : this.dataRes.value(),
  );

  /** Same guard for the outbox, which is an INDEPENDENTLY failing read: the CRM
   *  card's table dereferences it, so /integrations+/orders succeeding while
   *  /crm-outbox 500s is on its own enough to freeze the page. `pageState()`
   *  therefore covers BOTH legs and Retry reloads both. */
  readonly outbox = computed<CrmOutboxEntry[]>(() =>
    this.outboxRes.status() === 'error' ? [] : this.outboxRes.value(),
  );

  /** Every read the card grid derives from — one shared list, so the gate, the
   *  skeleton and the Retry cannot drift from what feeds them. */
  private pageInputs() {
    return [this.dataRes, this.outboxRes];
  }

  /**
   * Tri-state for the card grid. `isLoading()` alone is NOT the question: both
   * resources resolve their pre-auth defaults SYNCHRONOUSLY while `authReady()`
   * is false, so isLoading() is false for the whole OIDC bootstrap window and in
   * the SSR HTML — which is how the page came to state "No eligible customer
   * invoices available." and an "Active adapter: —" as settled facts about reads
   * that had not been made. Not-ready counts as loading, never ready-and-empty.
   */
  protected readonly pageState = computed<'error' | 'loading' | 'ready'>(() => {
    const inputs = this.pageInputs();
    if (inputs.some(r => r.status() === 'error')) return 'error';
    if (!this.auth.authReady() || inputs.some(r => r.isLoading())) return 'loading';
    return 'ready';
  });

  protected readonly dataError = computed(() => this.pageState() === 'error');
  protected readonly dataLoading = computed(() => this.pageState() === 'loading');

  /**
   * ACCESS FEEDBACK: `GET /integrations` is gated to finance-grade readers
   * (src/server.ts READ_RULES: finance, delivery-executive, admin — the same set
   * the `financeGuard` on this route mirrors), so it 401s until signed in and
   * 403s for every other role. Neither is toasted (the error interceptor
   * suppresses transient 401s), so say WHY rather than showing an error panel
   * with no cause. The roles are NAMED because a notice that misstates them
   * sends the user to the wrong administrator.
   */
  protected readonly accessNotice = computed<string | null>(() => {
    if (!this.dataError()) return null;
    return this.auth.isAuthenticated()
      ? 'Your role does not have access to the integration adapters. Finance, delivery executive and admin can view this page.'
      : 'Sign in to view the integration adapters — they require an authenticated finance, delivery-executive or admin role.';
  });

  /** Retry target: reloads every leg `pageState()` watches, so one Retry can
   *  never leave the other leg still failed. */
  protected reload(): void {
    for (const r of this.pageInputs()) r.reload();
  }

  private descriptorFor(kind: IntegrationKind): IntegrationDescriptor | undefined {
    return this.data().info?.adapters.find(a => a.kind === kind);
  }

  readonly erpDescriptor = computed(() => this.descriptorFor('erp'));
  readonly einvoiceDescriptor = computed(() => this.descriptorFor('einvoice'));
  readonly crmDescriptor = computed(() => this.descriptorFor('crm'));
  readonly biDescriptor = computed(() => this.descriptorFor('bi'));

  /** FatturaPA is only valid for issued customer invoices, never purchases/open orders. */
  readonly invoicedOrders = computed(() =>
    this.data().orders.filter(o =>
      o.type === 'Customer'
      && (o.status === 'Invoiced' || o.status === 'Paid')
      && typeof o.invoiceNumber === 'string'
      && o.invoiceNumber.length > 0,
    ),
  );

  readonly selectedOrderId = signal('');
  readonly busy = signal<BusyAction>(null);
  readonly preparing = signal(false);
  readonly loadingPreview = signal(false);
  readonly biPreview = signal<BiFeedPreview | null>(null);

  /** First rows of the previewed feed (kept short for the on-page table). */
  readonly previewRows = computed(() => this.biPreview()?.rows.slice(0, 5) ?? []);

  activeKey(kind: IntegrationKind): string {
    return this.data().info?.active[kind] ?? '—';
  }

  onOrderSelect(event: Event): void {
    this.selectedOrderId.set((event.target as HTMLSelectElement).value);
  }

  downloadJournal(format: 'csv' | 'json'): void {
    this.downloadArtifact(
      this.api.erpJournalExportUrl(format),
      `gl-journal.${format}`,
      format === 'csv' ? 'erp-csv' : 'erp-json',
    );
  }

  downloadInvoiceXml(): void {
    const orderId = this.selectedOrderId();
    if (!orderId) return;
    this.downloadArtifact(this.api.einvoiceXmlUrl(orderId), `fatturapa-order-${orderId}.xml`, 'einvoice');
  }

  prepareSync(): void {
    this.preparing.set(true);
    this.api.prepareCrmSync().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: entry => {
        this.preparing.set(false);
        this.outboxTick.update(v => v + 1);
        this.notifications.show(
          `Sync payload prepared: ${entry.payload.accounts.length} accounts, ${entry.payload.deals.length} deals (not transmitted).`,
          'success',
        );
      },
      // The global error interceptor already surfaces failures as toasts.
      error: () => this.preparing.set(false),
    });
  }

  previewFeed(): void {
    this.loadingPreview.set(true);
    this.api.getBiFeedPreview().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: feed => {
        this.loadingPreview.set(false);
        this.biPreview.set(feed);
      },
      error: () => this.loadingPreview.set(false),
    });
  }

  cellText(row: Record<string, BiFeedCell>, key: string): string {
    const value = row[key];
    return value === null || value === undefined ? '—' : String(value);
  }

  cellNumber(row: Record<string, BiFeedCell>, key: string): number | null {
    const value = row[key];
    return typeof value === 'number' ? value : null;
  }

  /**
   * Fetch a server-built artifact as a blob (HttpClient, so the auth
   * interceptor attaches the bearer token) and trigger a download.
   * Browser-only — mirrors export.util's guard and no-ops during SSR.
   */
  private downloadArtifact(url: string, fallbackName: string, action: Exclude<BusyAction, null>): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.busy.set(action);
    this.http
      .get(url, { observe: 'response', responseType: 'blob' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          this.busy.set(null);
          this.saveBlob(response, fallbackName);
        },
        // The global error interceptor surfaces most failures as toasts, but it
        // deliberately SUPPRESSES 401s on /api (transient auth-state noise).
        // For an explicit user action like a download that would mean silent
        // failure — no file, no message — so surface the expired-session case here.
        error: (err: unknown) => {
          this.busy.set(null);
          if (err instanceof HttpErrorResponse && err.status === 401) {
            this.notifications.error('Download failed: your session has expired. Sign in again and retry.');
          }
        },
      });
  }

  /** Defensive DOM-availability guard, mirroring export.util's canDownload(). */
  private saveBlob(response: HttpResponse<Blob>, fallbackName: string): void {
    const blob = response.body;
    if (
      !blob ||
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return;
    }
    const filename = this.filenameFrom(response.headers.get('Content-Disposition')) ?? fallbackName;
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Extract the server-provided artifact filename from Content-Disposition. */
  private filenameFrom(disposition: string | null): string | null {
    if (!disposition) return null;
    const match = /filename="([^"]+)"/.exec(disposition);
    return match ? match[1] : null;
  }
}
