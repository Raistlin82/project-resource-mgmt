import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export interface FacetOption { value: string; label: string }
export interface Facet {
  id: string;
  label: string;
  options: readonly FacetOption[];
  value: string; // '' means "no filter" for this facet
  /**
   * Text for the "show everything" pseudo-option, e.g. "All kinds". Optional,
   * defaulting to `All ${label}` — but English pluralization is NOT mechanical
   * ("All Kind" / "All People Manager" read wrong), so any consumer migrating
   * an EXISTING screen with its own hand-written wording must supply this
   * explicitly to stay byte-identical to what the screen rendered before.
   * `label` itself feeds the `<select>`'s `aria-label` too (via "Filter by
   * <label>") — a single string cannot correctly serve both jobs, which is
   * why this is a second, independent field rather than a pluralization
   * helper applied to `label`.
   */
  allLabel?: string;
}

/**
 * Generic text-box + N `<select>` facets + active-filter chips + Clear all
 * (design spec §8). Deliberately dumb: it holds no filtering logic of its
 * own and knows nothing about resources/projects/etc. — every consumer
 * (Tasks 6-9) supplies its own facet option lists and reacts to
 * (queryChange)/(facetChange)/(clearAll) by updating ITS OWN state and
 * re-fetching. Reuses `.command-input`/`.command-select` (styles.css:921-922)
 * and `.command-chip` (871) with the new `.is-removable` modifier (this task,
 * Step 1) — no other class invented.
 */
@Component({
  selector: 'app-search-filter-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-col gap-3">
      <div class="flex flex-col sm:flex-row gap-3">
        <input
          data-test="filter-bar-query"
          type="text"
          class="command-input flex-1"
          [attr.placeholder]="placeholder()"
          [value]="query()"
          (input)="queryChange.emit($any($event.target).value)"
        />
        @for (facet of facets(); track facet.id) {
          <select
            [attr.data-test]="'filter-bar-facet-' + facet.id"
            [attr.aria-label]="'Filter by ' + facet.label"
            class="command-select sm:w-48"
            (change)="facetChange.emit({ id: facet.id, value: $any($event.target).value })"
          >
            <option value="" [selected]="facet.value === ''">{{ allLabelFor(facet) }}</option>
            @for (opt of facet.options; track opt.value) {
              <option [value]="opt.value" [selected]="opt.value === facet.value">{{ opt.label }}</option>
            }
          </select>
        }
      </div>
      @if (activeChips().length > 0) {
        <div class="flex flex-wrap items-center gap-2">
          @for (chip of activeChips(); track chip.key) {
            <span class="command-chip is-neutral is-removable" data-test="filter-bar-chip">
              {{ chip.text }}
              <button type="button" [attr.aria-label]="'Remove ' + chip.text" (click)="removeChip(chip.key)">&times;</button>
            </span>
          }
          <button type="button" class="command-chip is-removable" data-test="filter-bar-clear-all" (click)="clearAll.emit()">
            Clear all
          </button>
        </div>
      }
    </div>
  `,
})
export class SearchFilterBarComponent {
  readonly query = input('');
  readonly facets = input<readonly Facet[]>([]);
  readonly placeholder = input('Search...');

  readonly queryChange = output<string>();
  readonly facetChange = output<{ id: string; value: string }>();
  readonly clearAll = output<void>();

  protected readonly activeChips = computed(() => {
    const chips: { key: string; text: string }[] = [];
    if (this.query()) chips.push({ key: 'query', text: this.query() });
    for (const facet of this.facets()) {
      if (!facet.value) continue;
      const opt = facet.options.find(o => o.value === facet.value);
      chips.push({ key: facet.id, text: opt?.label ?? facet.value });
    }
    return chips;
  });

  protected removeChip(key: string): void {
    if (key === 'query') { this.queryChange.emit(''); return; }
    this.facetChange.emit({ id: key, value: '' });
  }

  /** `facet.allLabel` if the consumer supplied one (migrating a screen with its
   *  own existing wording); otherwise a generic `All <label>` fallback for a
   *  brand-new facet that has no prior wording to preserve. */
  protected allLabelFor(facet: Facet): string {
    return facet.allLabel ?? `All ${facet.label}`;
  }
}
