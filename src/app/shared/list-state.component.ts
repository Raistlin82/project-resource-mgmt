import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

/**
 * Consistent loading / error / content presentation for resource-backed lists.
 *
 * Wraps a list region and renders exactly one of three states so screens no
 * longer flash a misleading "empty — add your first" state while data is still
 * loading, nor contradict an error toast with an empty state on fetch failure:
 *
 *  - `loading` true  → skeleton placeholder rows;
 *  - `error` true    → an error panel with a Retry button (emits `retry`);
 *  - otherwise       → the projected content (the screen's own table/cards,
 *    which keep their existing `@empty` "add your first" block — now only seen
 *    once the load has actually succeeded with zero rows).
 *
 * Wire it from a component with an rxResource/resource:
 *   <app-list-state [loading]="res.isLoading()"
 *                   [error]="res.status() === 'error'"
 *                   (retry)="res.reload()"> ...content... </app-list-state>
 */
@Component({
  selector: 'app-list-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    @if (loading()) {
      <div class="space-y-3" aria-busy="true" [attr.aria-label]="loadingLabel()">
        @for (row of skeletonRows(); track row) {
          <div class="command-skeleton h-14"></div>
        }
      </div>
    } @else if (error()) {
      <div role="alert"
           class="command-card border-red-200! p-10 text-center flex flex-col items-center gap-4">
        <div class="w-16 h-16 bg-red-50 ring-1 ring-red-200 rounded-full flex items-center justify-center">
          <mat-icon class="text-red-700 text-3xl">error_outline</mat-icon>
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
  /** Number of skeleton placeholder rows to show while loading. */
  readonly rows = input(3);

  /** Emitted when the user clicks Retry; the host should reload the resource. */
  readonly retry = output<void>();

  protected readonly skeletonRows = () => Array.from({ length: this.rows() }, (_, i) => i);
  protected readonly loadingLabel = () => `Loading ${this.label()}`;
}
