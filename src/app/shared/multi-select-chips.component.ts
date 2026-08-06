import { ChangeDetectionStrategy, Component, computed, forwardRef, input, signal } from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

/** One offered entry: `value` is what gets STORED, `label` is what the user reads. */
export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * UX register P2-19 — the choose-then-add + removable-chip control that replaces
 * `<select multiple>`.
 *
 * THE DEFECT IT CLOSES. A `<select multiple>` can only gain a second selection
 * through Ctrl/Cmd-click, which does not exist on touch: on a phone or tablet the
 * field held exactly one entry and picking a second silently REPLACED the first.
 * Every list this control feeds is consequential — a resource organization's cost
 * centres drive cost allocation, a skill's catalogs decide where a skill appears —
 * so a silent replacement is a silent data change.
 *
 * THE DATA CONTRACT, which is the real reason this is a component and not a
 * template snippet: **the model is the RAW `string[]` and is never intersected
 * with `options()`.** A stored id or name that today's catalog no longer carries
 * (legacy data, a deleted cost centre, a renamed catalog) renders as a chip like
 * any other, flagged, and stays removable. Filtering the model against the option
 * list anywhere in here would silently drop saved values on the next save — the
 * same loss the `<select multiple>` shape produced, reintroduced one layer down.
 * `addableOptions()` filters the OPTIONS, never the model.
 *
 * Shape copied from the landed sites (my-profile.component.ts's skill chips and
 * resource-requests.component.ts's required-skills control) rather than invented:
 * a picker, an explicit Add, and one removable chip per value with its own
 * `aria-label`.
 */
@Component({
  selector: 'app-multi-select-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => MultiSelectChipsComponent),
      multi: true,
    },
  ],
  template: `
    <div class="space-y-2">
      <div class="flex gap-2">
        <select #picker [id]="inputId()" [attr.aria-label]="pickerLabel()" [disabled]="isDisabled()"
                data-test="chips-picker" class="command-select flex-1 disabled:opacity-50"
                (change)="toAdd.set(picker.value)">
          <option value="">{{ placeholder() }}</option>
          @for (opt of addableOptions(); track opt.value) {
            <option [value]="opt.value">{{ opt.label }}</option>
          }
        </select>
        <button type="button" data-test="chips-add" (click)="add(picker)" [disabled]="isDisabled() || !toAdd()"
                class="command-button secondary disabled:opacity-50 disabled:cursor-not-allowed">
          <mat-icon class="text-[18px] w-[18px] h-[18px]">add</mat-icon> Add
        </button>
      </div>
      <div class="flex flex-wrap gap-2 pt-1" data-test="chips-selected">
        @for (value of selected(); track value) {
          <span data-test="chip"
                class="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2 py-1 text-xs font-medium text-ink-secondary">
            <!-- The label is its own element so a test (and a screen reader) can read
                 it without picking up the remove button's mat-icon ligature text. -->
            <span data-test="chip-label">{{ labelFor(value) }}@if (isOrphan(value)) {<span class="text-ink-muted italic"> (not in catalog)</span>}</span>
            <button type="button" (click)="remove(value)" [disabled]="isDisabled()"
                    [attr.aria-label]="'Remove ' + labelFor(value)" [attr.title]="'Remove ' + labelFor(value)"
                    class="text-ink-muted hover:text-critical-text transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              <mat-icon class="text-[14px] w-[14px] h-[14px]">close</mat-icon>
            </button>
          </span>
        }
        @if (!selected().length) {
          <p data-test="chips-empty" class="text-xs font-medium text-[var(--cc-muted)]">{{ emptyText() }}</p>
        }
      </div>
    </div>
  `,
})
export class MultiSelectChipsComponent implements ControlValueAccessor {
  /** Offered entries. Changing them never changes the model — see the class comment. */
  readonly options = input<readonly MultiSelectOption[]>([]);
  /** Put on the picker `<select>` so the call site's `<label for=…>` still points at a real control. */
  readonly inputId = input<string>('');
  /** Accessible name of the picker (it is not the field's own label — the chips are the field). */
  readonly pickerLabel = input<string>('Value to add');
  /** Copy of the picker's neutral first option. */
  readonly placeholder = input<string>('Select…');
  /** Copy shown in place of the chip row while nothing is selected. */
  readonly emptyText = input<string>('Nothing selected yet.');

  /**
   * The stored value, verbatim. Never derived from `options()`, so an entry the
   * catalog no longer offers survives here untouched until the user removes it.
   */
  protected readonly selected = signal<readonly string[]>([]);
  /** The value highlighted in the picker, or '' for none. */
  protected readonly toAdd = signal<string>('');
  protected readonly isDisabled = signal(false);

  private onChange: (value: string[]) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  /**
   * Entries not already chosen. This filters the OPTIONS — an already-selected
   * value simply stops being offered a second time — and can therefore never lose
   * data, unlike a filter applied to the model.
   */
  protected readonly addableOptions = computed<readonly MultiSelectOption[]>(() => {
    const chosen = new Set(this.selected());
    return this.options().filter(o => !chosen.has(o.value));
  });

  /** Display text for a stored value; an orphan falls back to the raw value. */
  protected labelFor(value: string): string {
    return this.options().find(o => o.value === value)?.label ?? value;
  }

  /** True when this stored value is not (or no longer) in the option list. */
  protected isOrphan(value: string): boolean {
    return !this.options().some(o => o.value === value);
  }

  protected add(picker: HTMLSelectElement): void {
    const value = this.toAdd();
    if (!value) return;
    const current = this.selected();
    if (!current.includes(value)) this.commit([...current, value]);
    // Reset the picker: the just-added entry has left the option list, so leaving
    // the control showing it would be a stale selection.
    this.toAdd.set('');
    picker.value = '';
  }

  protected remove(value: string): void {
    this.commit(this.selected().filter(v => v !== value));
  }

  private commit(next: readonly string[]): void {
    this.selected.set(next);
    this.onChange([...next]);
    this.onTouched();
  }

  // --- ControlValueAccessor ---------------------------------------------------

  writeValue(value: readonly string[] | null | undefined): void {
    this.selected.set(Array.isArray(value) ? [...value] : []);
    this.toAdd.set('');
  }

  registerOnChange(fn: (value: string[]) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.isDisabled.set(isDisabled);
  }
}
