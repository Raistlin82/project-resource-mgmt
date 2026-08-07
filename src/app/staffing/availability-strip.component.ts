import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import type { BenchCell, BenchRow, BenchState } from '../services/api.service';

/** Tri-state of the read that feeds the strip, owned by the screen. */
export type AvailabilityReadState = 'loading' | 'error' | 'ready';

/** One rendered dot. `state` is absent when the rollup has nothing for that month. */
interface DotVm {
  month: string;
  state: BenchState | undefined;
  /** The non-colour signal INSIDE the dot: B / P / A, or an em dash when untracked. */
  glyph: string;
  /** Accessible name: month AND state spelled out, never a colour word. */
  aria: string;
  tone: string;
}

/**
 * Per-state presentation. The tone pairs a `-tint` background with the matching
 * `-text` foreground — the combination `styles.css` documents as AA-verified in
 * BOTH themes (`--color-caution-text` is annotated "~5.0:1 on caution-tint"),
 * which is also why there is no `dark:` variant anywhere here: this design
 * system re-points the same tokens under `:root[data-theme="dark"]`.
 */
const STATE_META: Record<BenchState, { glyph: string; label: string; tone: string }> = {
  BENCH: { glyph: 'B', label: 'Bench (free)', tone: 'bg-positive-tint text-positive-text ring-positive' },
  PARTIAL: { glyph: 'P', label: 'Partially allocated', tone: 'bg-caution-tint text-caution-text ring-caution' },
  ALLOCATED: { glyph: 'A', label: 'Fully allocated', tone: 'bg-critical-tint text-critical-text ring-critical' },
  /**
   * H's fourth state (`BenchState` gained `'ABSENT'`, spec §4.3), which makes this
   * `Record` incomplete and the build red until it is filled — so this entry is
   * the minimum needed to keep the tree compiling, and PROVISIONAL: T7 owns the
   * consumer sweep and will settle the final treatment across /bench,
   * /utilization, /dashboard and /reporting so all four read alike.
   *
   * Three things must stay TELLABLE APART on this strip, because they are three
   * different facts: FREE (`BENCH`, green B), AWAY (here), and WE DO NOT KNOW
   * (`UNTRACKED_META` below, grey en dash). Hence the `info` tone — the only
   * status family not already spoken for — plus its own glyph, so a monochrome
   * screenshot still separates it from both neighbours. 'A' was taken by
   * ALLOCATED, so 'L' (leave) breaks the initial-letter convention on purpose
   * rather than colliding with it.
   *
   * THE LABEL NAMES NO CAUSE, and that is a privacy requirement, not a style
   * choice. Absence reasons are special-category data (§7.3) and /staffing's
   * audience is not the reason's audience; the whole arithmetic of this block is
   * built so `reasonCode` never reaches a screen (§3.4), and the `BenchCell` this
   * component reads cannot carry one. Do not add a prop to pass it in.
   */
  ABSENT: { glyph: 'L', label: 'Away (on leave) — not staffable', tone: 'bg-info-tint text-info-text ring-info' },
};

const UNTRACKED_META = {
  glyph: '–',
  label: 'not tracked',
  tone: 'bg-surface-muted text-ink-muted ring-line',
};

/**
 * The RPT "Disponibilità futura" traffic light (manual §3.2.2): one dot per
 * month of the server's fixed 6-month bench window, on the candidate card
 * where the staffing decision is actually made.
 *
 * WCAG 1.4.1 — colour is never the only signal. Every dot carries a letter
 * (B / P / A) as visible text and an `aria-label` naming the month and the
 * state in words; the tone is the third, redundant channel. A monochrome
 * screenshot, a screen reader and a colour-blind reader all get the same three
 * states.
 *
 * The three read states are kept apart on purpose, because collapsing them is
 * the defect this codebase keeps re-fixing: a failed read must NOT render as
 * six green dots ("everyone is free"), and a resource the rollup simply does
 * not cover must not either. Hence:
 *   - `loading` -> says so, draws no dots at all;
 *   - `error`   -> says "unavailable", draws no dots at all;
 *   - `ready` with no row (every dummy: placeholders are excluded from the
 *     bench rollup by design, and so is anyone not active in the window) ->
 *     draws the dots as explicitly UNTRACKED, never as free.
 */
@Component({
  selector: 'app-availability-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    @switch (state()) {
      @case ('loading') {
        <p class="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--cc-muted)]"
           data-test="availability-loading" aria-busy="true">
          <mat-icon class="text-[14px] w-[14px] h-[14px] shrink-0">schedule</mat-icon>
          Loading future availability…
        </p>
      }
      @case ('error') {
        <p class="flex items-center gap-1.5 text-[11px] font-semibold text-caution-text"
           data-test="availability-unavailable">
          <mat-icon class="text-[14px] w-[14px] h-[14px] shrink-0">warning_amber</mat-icon>
          Future availability unavailable
        </p>
      }
      @default {
        @if (dots().length === 0) {
          <p class="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--cc-muted)]"
             data-test="availability-unavailable">
            <mat-icon class="text-[14px] w-[14px] h-[14px] shrink-0">warning_amber</mat-icon>
            Future availability unavailable
          </p>
        } @else {
          <div class="flex flex-wrap items-center gap-1.5" role="group"
               data-test="availability-strip"
               [attr.aria-label]="'Future availability for ' + resourceName()">
            @for (dot of dots(); track dot.month) {
              <span class="w-6 h-6 rounded-full ring-1 flex items-center justify-center
                           text-[10px] font-bold font-mono tabular-nums leading-none"
                    [class]="dot.tone"
                    data-test="availability-dot"
                    role="img"
                    [attr.aria-label]="dot.aria"
                    [title]="dot.aria">{{ dot.glyph }}</span>
            }
            @if (untrackedOnly()) {
              <span class="text-[10px] font-semibold uppercase tracking-wider text-[var(--cc-muted)]"
                    data-test="availability-untracked-note">not tracked</span>
            }
          </div>
        }
      }
    }
  `,
})
export class AvailabilityStripComponent {
  readonly state = input.required<AvailabilityReadState>();
  /** The rollup's own months ('YYYY-MM'), server-fixed at six — not re-derived here. */
  readonly months = input<readonly string[]>([]);
  /** This candidate's rollup row, or undefined when the rollup has none for them. */
  readonly row = input<BenchRow | undefined>(undefined);
  readonly resourceName = input('');

  private static readonly MONTH_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
  private static readonly MONTH_LONG_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  /** Short month label, e.g. 'Apr 26' — the capacity screen's own formatter. */
  protected monthLabel(month: string): string {
    return AvailabilityStripComponent.MONTH_FMT.format(new Date(month + '-01T00:00:00Z'));
  }
  private monthLabelLong(month: string): string {
    return AvailabilityStripComponent.MONTH_LONG_FMT.format(new Date(month + '-01T00:00:00Z'));
  }

  protected readonly dots = computed<DotVm[]>(() => {
    const row = this.row();
    return this.months().map(month => {
      const cell: BenchCell | undefined = row?.monthly[month];
      const meta = cell ? STATE_META[cell.state] : UNTRACKED_META;
      return {
        month,
        state: cell?.state,
        glyph: meta.glyph,
        tone: meta.tone,
        aria: `${this.monthLabelLong(month)}: ${meta.label}`,
      };
    });
  });

  /** True when NOT ONE month is tracked — the caption that keeps six grey dots
   *  from reading as a state of their own. A partially covered row (hired
   *  mid-window, say) keeps the per-dot labels and needs no caption. */
  protected readonly untrackedOnly = computed(() => {
    const dots = this.dots();
    return dots.length > 0 && dots.every(d => d.state === undefined);
  });
}
