import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/** Skeleton placeholder shape rendered while a resource is loading. */
export type ListStateSkeleton = 'block' | 'table-rows' | 'cards';

/**
 * Consistent loading / error / content presentation for resource-backed lists.
 *
 * Wraps a list region and renders exactly one of three states so screens no
 * longer flash a misleading "empty — add your first" state while data is still
 * loading, nor contradict an error toast with an empty state on fetch failure:
 *
 *  - `loading` true  → skeleton placeholder (shape chosen by `skeleton`);
 *  - `error` true    → an error panel with a Retry button (emits `retry`);
 *  - otherwise       → the projected content (the screen's own table/cards,
 *    which keep their existing `@empty` "add your first" block — now only seen
 *    once the load has actually succeeded with zero rows).
 *
 * Wire it from a component with an rxResource/resource:
 *   <app-list-state [loading]="res.isLoading()"
 *                   [error]="res.status() === 'error'"
 *                   (retry)="res.reload()"> ...content... </app-list-state>
 *
 * For list/table screens, pick the matching skeleton shape so the placeholder
 * mirrors the real layout instead of a generic block:
 *   <app-list-state [loading]="res.isLoading()"
 *                   [error]="res.status() === 'error'"
 *                   skeleton="table-rows" [rows]="8" [columns]="5"
 *                   label="invoices" (retry)="res.reload()"> ...table... </app-list-state>
 */
@Component({
  selector: 'app-list-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    @if (loading()) {
      <div class="space-y-3" aria-busy="true" [attr.aria-label]="loadingLabel()">
        @switch (skeleton()) {
          @case ('table-rows') {
            @if (columns(); as cols) {
              <!-- Small shimmer grid: N rows × M cells, matching typical row height. -->
              @for (row of skeletonRows(); track row) {
                <div class="flex items-center gap-3">
                  @for (col of skeletonCols(); track col) {
                    <div class="command-skeleton h-9 flex-1"></div>
                  }
                </div>
              }
            } @else {
              <!-- Plain row bars at typical table-row height. -->
              @for (row of skeletonRows(); track row) {
                <div class="command-skeleton-row"></div>
              }
            }
          }
          @case ('cards') {
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              @for (card of skeletonRows(); track card) {
                <div class="command-card p-4 flex flex-col gap-3">
                  <div class="command-skeleton h-4 w-2/3"></div>
                  <div class="command-skeleton h-3 w-full"></div>
                  <div class="command-skeleton h-3 w-1/2"></div>
                </div>
              }
            </div>
          }
          @default {
            <!-- 'block' (default, backward-compatible). -->
            @for (row of skeletonRows(); track row) {
              <div class="command-skeleton h-14"></div>
            }
          }
        }
      </div>
    } @else if (error()) {
      <div role="alert"
           class="command-card border-critical! p-10 text-center flex flex-col items-center gap-4">
        <div class="w-16 h-16 bg-critical-tint ring-1 ring-critical rounded-full flex items-center justify-center">
          <mat-icon class="text-critical-text text-3xl">error_outline</mat-icon>
        </div>
        <div>
          <h3 class="font-display text-lg font-bold text-[var(--cc-ink)]">Couldn't load {{ label() }}</h3>
          <p class="text-[var(--cc-muted)] text-sm mt-1">Something went wrong while fetching the data.</p>
        </div>
        <button type="button" (click)="retry.emit()"
                class="command-button">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">refresh</mat-icon> Retry
        </button>
      </div>
    } @else {
      <ng-content />
    }
  `,
})
export class ListStateComponent {
  /** Whether the underlying resource is loading or reloading. */
  readonly loading = input(false);
  /** Whether the underlying resource is in its error state. */
  readonly error = input(false);
  /** Human label for messaging, e.g. "customers". */
  readonly label = input('data');
  /**
   * Skeleton placeholder shape while loading:
   *  - `'block'` (default): full-width shimmer bars (original behavior);
   *  - `'table-rows'`: row-height shimmer bars, or a row×column shimmer grid
   *    when `columns` is set — for tabular screens;
   *  - `'cards'`: a responsive grid of shimmer card placeholders.
   */
  readonly skeleton = input<ListStateSkeleton>('block');
  /** Number of skeleton placeholder rows/cards to show while loading. */
  readonly rows = input(3);
  /**
   * Optional number of skeleton cells per row. Only used by the `'table-rows'`
   * shape; when set it renders a row×column shimmer grid instead of plain bars.
   */
  readonly columns = input<number | undefined>(undefined);

  /** Emitted when the user clicks Retry; the host should reload the resource. */
  readonly retry = output<void>();

  protected readonly skeletonRows = computed(() =>
    Array.from({ length: Math.max(0, this.rows()) }, (_, i) => i),
  );
  protected readonly skeletonCols = computed(() =>
    Array.from({ length: Math.max(0, this.columns() ?? 0) }, (_, i) => i),
  );
  protected readonly loadingLabel = computed(() => `Loading ${this.label()}`);
}
