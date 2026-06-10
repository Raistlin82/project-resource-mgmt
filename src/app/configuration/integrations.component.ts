import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, PLATFORM_ID, signal } from '@angular/core';
import { DatePipe, DecimalPipe, isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpResponse } from '@angular/common/http';
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
  imports: [MatIconModule, DatePipe, DecimalPipe],
  template: `
    <div class="command-page space-y-6">
      <header class="command-header">
        <div>
          <div class="command-eyebrow">Configuration</div>
          <h1 class="command-title">Integrations</h1>
          <p class="command-subtitle">
            Typed adapters for ERP, e-invoicing, CRM and BI. Each one is implemented and testable but deliberately
            not connected: it builds a local artifact from live data — no credentials, no network calls.
          </p>
        </div>
      </header>

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
            <span class="command-status amber shrink-0">Implemented — not connected</span>
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
            <p class="text-xs text-[var(--cc-muted)]">Revenue-recognition journal for 2026, monthly periods. Σ debit always equals Σ credit.</p>
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
            <span class="command-status amber shrink-0">Implemented — not connected</span>
          </div>
          <div class="p-4 space-y-3">
            <div class="text-xs font-medium text-[var(--cc-muted)]">
              Active adapter: <span class="font-mono">{{ activeKey('einvoice') }}</span>
            </div>
            <div>
              <label for="einvoiceOrder" class="block text-sm font-medium text-[var(--cc-muted)] mb-1">Invoiced order</label>
              <select
                id="einvoiceOrder"
                [value]="selectedOrderId()"
                (change)="onOrderSelect($event)"
                class="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm text-slate-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/25 outline-none transition-all">
                <option value="">Select an invoiced order…</option>
                @for (order of invoicedOrders(); track order.id) {
                  <option [value]="order.id">{{ order.invoiceNumber }} · Order {{ order.id }} ({{ order.currency }} {{ order.amount | number:'1.0-0' }})</option>
                }
              </select>
            </div>
            <button type="button" class="command-button" [disabled]="!selectedOrderId() || busy() !== null" (click)="downloadInvoiceXml()">
              <mat-icon class="text-[20px] w-[20px] h-[20px]">description</mat-icon>
              Generate FatturaPA XML
            </button>
            @if (invoicedOrders().length === 0) {
              <p class="text-xs text-[var(--cc-muted)]">No invoiced orders available. Only orders carrying an invoice number can be exported.</p>
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
            <span class="command-status amber shrink-0">Implemented — not connected</span>
          </div>
          <div class="p-4 space-y-3">
            <div class="text-xs font-medium text-[var(--cc-muted)]">
              Active adapter: <span class="font-mono">{{ activeKey('crm') }}</span>
            </div>
            <button type="button" class="command-button" [disabled]="preparing()" (click)="prepareSync()">
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
            <span class="command-status amber shrink-0">Implemented — not connected</span>
          </div>
          <div class="p-4 space-y-3">
            <div class="text-xs font-medium text-[var(--cc-muted)]">
              Active adapter: <span class="font-mono">{{ activeKey('bi') }}</span>
            </div>
            <button type="button" class="command-button" [disabled]="loadingPreview()" (click)="previewFeed()">
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

  private data = this.dataRes.value;
  readonly outbox = this.outboxRes.value;

  private descriptorFor(kind: IntegrationKind): IntegrationDescriptor | undefined {
    return this.data().info?.adapters.find(a => a.kind === kind);
  }

  readonly erpDescriptor = computed(() => this.descriptorFor('erp'));
  readonly einvoiceDescriptor = computed(() => this.descriptorFor('einvoice'));
  readonly crmDescriptor = computed(() => this.descriptorFor('crm'));
  readonly biDescriptor = computed(() => this.descriptorFor('bi'));

  /** Only orders carrying an invoice number can be exported as FatturaPA. */
  readonly invoicedOrders = computed(() =>
    this.data().orders.filter(o => typeof o.invoiceNumber === 'string' && o.invoiceNumber.length > 0),
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
        // The global error interceptor already surfaces failures as toasts.
        error: () => this.busy.set(null),
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
