import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { AvailabilityStripComponent, type AvailabilityReadState } from './availability-strip.component';
import type { BenchRow } from '../services/api.service';
import { contrast, cssBlock, token, AA_TEXT } from '../shared/theme-contrast';

const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];

/** BENCH, PARTIAL, ALLOCATED and a gap — all four rendered cases in one row. */
const MIXED_ROW: BenchRow = {
  resourceId: '1', resourceName: 'Julie Armstrong', kind: 'internal',
  availabilityDate: { kind: 'date', date: '2026-04-01' },
  monthly: {
    '2026-04': { state: 'BENCH', upcomingUnallocated: true },
    '2026-05': { state: 'PARTIAL', upcomingUnallocated: false },
    '2026-06': { state: 'ALLOCATED', upcomingUnallocated: false },
    // 2026-07..09 deliberately absent: a row can start mid-window (a later hire
    // date), and those months must not inherit the last state they saw.
  },
};

async function render(over: {
  state?: AvailabilityReadState;
  months?: readonly string[];
  row?: BenchRow;
  resourceName?: string;
} = {}) {
  TestBed.configureTestingModule({ imports: [AvailabilityStripComponent] });
  const fixture = TestBed.createComponent(AvailabilityStripComponent);
  fixture.componentRef.setInput('state', over.state ?? 'ready');
  fixture.componentRef.setInput('months', over.months ?? MONTHS);
  fixture.componentRef.setInput('row', over.row);
  fixture.componentRef.setInput('resourceName', over.resourceName ?? 'Julie Armstrong');
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function dots(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>('[data-test="availability-dot"]')];
}

describe('AvailabilityStripComponent — one dot per month of the server window', () => {
  it('renders the six months in order, each with its own glyph and accessible name', async () => {
    const host = await render({ row: MIXED_ROW });
    expect(dots(host)).toHaveLength(6);
    expect(dots(host).map(d => d.textContent?.trim())).toStrictEqual(['B', 'P', 'A', '–', '–', '–']);
    expect(dots(host).map(d => d.getAttribute('aria-label'))).toStrictEqual([
      'April 2026: Bench (free)',
      'May 2026: Partially allocated',
      'June 2026: Fully allocated',
      'July 2026: not tracked',
      'August 2026: not tracked',
      'September 2026: not tracked',
    ]);
  });

  it('names the group after the candidate, so a card full of dots says WHOSE', async () => {
    const host = await render({ row: MIXED_ROW, resourceName: 'Priya Kapoor' });
    const group = host.querySelector('[data-test="availability-strip"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Future availability for Priya Kapoor');
  });

  it('gives each state a DIFFERENT tone as well as a different glyph', async () => {
    const host = await render({ row: MIXED_ROW });
    const tones = dots(host).slice(0, 3).map(d => d.className.replace(/\s+/g, ' '));
    expect(new Set(tones).size).toBe(3);
    expect(tones[0]).toContain('text-positive-text');
    expect(tones[1]).toContain('text-caution-text');
    expect(tones[2]).toContain('text-critical-text');
  });

  it('never distinguishes the states by colour ALONE (WCAG 1.4.1)', async () => {
    // The absence half of the tone assertion above: strip the classes and the
    // three states must still be told apart — by the glyph and by the name.
    const host = await render({ row: MIXED_ROW });
    const glyphs = dots(host).slice(0, 3).map(d => d.textContent?.trim());
    expect(new Set(glyphs).size).toBe(3);
    const names = dots(host).slice(0, 3).map(d => d.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(3);
    expect(names.every(n => n && n.length > 0)).toBe(true);
    // ...and no accessible name leans on a colour word, which would be the same
    // failure wearing a text disguise.
    expect(names.some(n => /green|amber|yellow|red/i.test(n ?? ''))).toBe(false);
  });

  it('carries a title as well, so a mouse user gets the same three states', async () => {
    const host = await render({ row: MIXED_ROW });
    expect(dots(host).map(d => d.getAttribute('title')))
      .toStrictEqual(dots(host).map(d => d.getAttribute('aria-label')));
  });
});

describe('AvailabilityStripComponent — a resource the rollup does not cover', () => {
  it('renders every month as explicitly NOT TRACKED, never as free', async () => {
    // The real case, not a hypothetical: every dummy is excluded from the bench
    // rollup by design, and so is anyone inactive across the whole window.
    const host = await render({ row: undefined });
    expect(dots(host)).toHaveLength(6);
    expect(dots(host).map(d => d.textContent?.trim())).toStrictEqual(['–', '–', '–', '–', '–', '–']);
    expect(dots(host)[0].getAttribute('aria-label')).toBe('April 2026: not tracked');
    // PRESENCE of the caption, so six grey dots cannot be mistaken for a state.
    expect(host.querySelector('[data-test="availability-untracked-note"]')).not.toBeNull();
    // ABSENCE: not one dot claims bench/partial/allocated, by glyph or by tone.
    expect(dots(host).some(d => ['B', 'P', 'A'].includes(d.textContent?.trim() ?? ''))).toBe(false);
    expect(dots(host).some(d => /positive|caution|critical/.test(d.className))).toBe(false);
  });

  it('drops the caption when SOME month is tracked — it describes nothing-at-all, not a gap', async () => {
    const host = await render({ row: MIXED_ROW });
    expect(host.querySelector('[data-test="availability-untracked-note"]')).toBeNull();
  });
});

describe('AvailabilityStripComponent — the read states stay apart', () => {
  it('says it is loading and draws NO dots while the rollup has not arrived', async () => {
    const host = await render({ state: 'loading', months: [], row: undefined });
    expect(host.querySelector('[data-test="availability-loading"]')).not.toBeNull();
    expect(dots(host)).toHaveLength(0);
  });

  it('says unavailable and draws NO dots when the rollup read FAILED', async () => {
    // The defect this guards: a failed read rendering as six green dots is a
    // confident "everybody is free" derived from no data at all.
    const host = await render({ state: 'error', months: MONTHS, row: MIXED_ROW });
    expect(host.querySelector('[data-test="availability-unavailable"]')).not.toBeNull();
    expect(dots(host)).toHaveLength(0);
    expect(host.querySelector('[data-test="availability-strip"]')).toBeNull();
  });

  it('says unavailable when the read succeeded but carries no months at all', async () => {
    const host = await render({ state: 'ready', months: [], row: undefined });
    expect(host.querySelector('[data-test="availability-unavailable"]')).not.toBeNull();
    expect(dots(host)).toHaveLength(0);
  });

  it('draws the dots once the read is ready — the states are not all one state', async () => {
    // The must-still-work control: a component that always said "unavailable"
    // would satisfy all three cases above.
    const host = await render({ state: 'ready', row: MIXED_ROW });
    expect(dots(host)).toHaveLength(6);
    expect(host.querySelector('[data-test="availability-unavailable"]')).toBeNull();
    expect(host.querySelector('[data-test="availability-loading"]')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Token arithmetic, not token names. jsdom resolves no custom properties and
// performs no layout, so the honest form of a legibility claim is the OKLCH →
// WCAG ratio computed from styles.css — the shared helper three other specs
// already use for exactly this.
// -----------------------------------------------------------------------------
const GLOBAL_CSS = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const COMPONENT_SRC = readFileSync(
  resolve(process.cwd(), 'src/app/staffing/availability-strip.component.ts'), 'utf8',
);

describe('AvailabilityStripComponent — the glyph inside each dot is legible in BOTH themes', () => {
  // Light lives in `@theme` (Tailwind v4's token block); dark re-points the same
  // names under the attribute selector — the split `theme-contrast.spec.ts` uses.
  const THEMES = [
    { name: 'light', block: cssBlock(GLOBAL_CSS, '@theme') },
    { name: 'dark', block: cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]') },
  ];
  const PAIRS = ['positive', 'caution', 'critical'] as const;

  it.each(THEMES)('$name: every -text glyph clears AA on its own -tint fill', ({ block }) => {
    for (const accent of PAIRS) {
      const text = token(block, `--color-${accent}-text`);
      const tint = token(block, `--color-${accent}-tint`);
      expect(contrast(text, tint), `${accent}-text on ${accent}-tint`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('is a MEASUREMENT: the raw fill tone used as the glyph would fail the same check', () => {
    // Absence twin. Without it, "clears AA" could be a constant that any token
    // pair satisfies — this shows the -text variant is what does the work.
    const dark = cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]');
    const rawCritical = token(dark, '--color-critical');
    const tintCritical = token(dark, '--color-critical-tint');
    expect(contrast(rawCritical, tintCritical)).toBeLessThan(AA_TEXT);
  });

  it('declares exactly those measured pairs, and no dark: variant this design system does not have', () => {
    expect(COMPONENT_SRC).toMatch(/bg-positive-tint text-positive-text/);
    expect(COMPONENT_SRC).toMatch(/bg-caution-tint text-caution-text/);
    expect(COMPONENT_SRC).toMatch(/bg-critical-tint text-critical-text/);
    // Theming here is token re-pointing under :root[data-theme="dark"], never a
    // Tailwind dark: variant — one would silently do nothing.
    expect(COMPONENT_SRC).not.toMatch(/\bdark:[a-z[-]/);
  });

  it('wraps rather than overflowing at a narrow width (static: jsdom lays out nothing)', async () => {
    // No test can prove the six dots fit 320px — jsdom has no layout and
    // offsetWidth is 0. What is checkable is the declaration that lets the row
    // wrap instead of forcing a horizontal scroll on the card.
    const host = await render({ row: MIXED_ROW });
    expect(host.querySelector('[data-test="availability-strip"]')!.className).toContain('flex-wrap');
  });
});
