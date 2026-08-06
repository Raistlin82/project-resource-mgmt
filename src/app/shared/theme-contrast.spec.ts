import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AA_NON_TEXT,
  AA_TEXT,
  contrast,
  contrastAtWorst,
  cssBlock,
  isInSrgbGamut,
  token,
  WHITE,
  type Oklch,
} from './theme-contrast';

/* ===========================================================================
 * The palette contract: a coloured token used as a SOLID FILL under white text
 * must clear WCAG AA in BOTH themes.
 *
 * This replaces a 17-site `text-white` allow-list. That allow-list encoded the
 * theory that `text-white` was itself the defect and `text-ink-inverse` the fix;
 * on a lifted dark fill neither clears AA, so it was counting call sites instead
 * of measuring the thing that fails. What follows measures the RATIO, for every
 * pairing the source actually ships, so it cannot rot: a new site on a new token
 * is picked up by the scan and asserted automatically, and there is no list to
 * keep in step with the code.
 *
 * jsdom performs no layout and resolves no custom properties, so every number
 * here is computed from the declarations in src/styles.css (OKLCH → linear sRGB
 * → WCAG relative luminance), never read off an element.
 * =========================================================================== */

const GLOBAL_CSS = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const LIGHT = cssBlock(GLOBAL_CSS, '@theme');
const DARK = cssBlock(GLOBAL_CSS, ':root[data-theme="dark"]');
const ALIASES = cssBlock(GLOBAL_CSS, ':root');
const THEMES = [
  ['light', LIGHT],
  ['dark', DARK],
] as const;

/** The colour families the palette exposes as utilities. */
const FAMILIES = ['accent', 'critical', 'caution', 'positive', 'info'] as const;
/** `-tint` is included on purpose: white on a tint is the same category of bug. */
const SUFFIXES = ['', '-strong', '-text', '-tint'] as const;
const FILL_NAMES = FAMILIES.flatMap(f => SUFFIXES.map(s => `${f}${s}`)).sort((a, b) => b.length - a.length);

/**
 * A background utility for a palette token, in any state variant, including the
 * gradient stops (`from-accent to-accent` is a solid accent fill).
 */
const FILL_RE = new RegExp(
  `(?:^|[\\s"'\`:.\\[])(?:hover:|focus:|focus-visible:|active:|group-hover:)?` +
    `(?:bg|from|via|to)-(${FILL_NAMES.join('|')})(?=[\\s"'\`\\]]|$)`,
  'g',
);
/** The two foregrounds that resolve to white. `bg-ink/40` and friends are not
 *  palette fills and cannot be reasoned about statically, so they are excluded
 *  by requiring a delimiter (a `/opacity` suffix never matches). */
const WHITE_FG_RE = /(?:^|[\s"'`:.[])(?:hover:|focus:|focus-visible:|active:|group-hover:)?text-(white|ink-inverse)(?=[\s"'`\]]|$)/;

interface Pairing {
  /** `path:line`, repo-relative. */
  readonly at: string;
  /** Token name without the `--color-` prefix, e.g. `critical-strong`. */
  readonly fill: string;
  readonly fg: 'white' | 'ink-inverse';
}

/** Blank out comments while KEEPING line numbers, so `at` stays truthful. */
const stripComments = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));

/** Every component source (comments blanked), read once. */
const APP_SOURCES: readonly { readonly path: string; readonly text: string }[] = (() => {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) {
        out.push({ path: relative(process.cwd(), p), text: stripComments(readFileSync(p, 'utf8')) });
      }
    }
  };
  walk(resolve(process.cwd(), 'src/app'));
  return out;
})();

/** Files mentioning a token stem, as a utility class or as `var(--color-…)`. */
const filesReferencing = (stem: string): string[] =>
  APP_SOURCES.filter(f => new RegExp(`(?:bg|text|border|ring|from|via|to)-${stem}\\b|var\\(--color-${stem}\\)`).test(f.text))
    .map(f => f.path)
    .sort();

/**
 * Every source line that puts a white foreground on a palette fill. Same-line
 * co-occurrence is how this codebase writes them, including both arms of a
 * `cond ? 'bg-accent text-white' : '…'` and the `hover:` variant that follows.
 */
function scanPairings(): Pairing[] {
  const out: Pairing[] = [];
  for (const { path, text } of APP_SOURCES) {
    text.split('\n').forEach((line, i) => {
      if (!WHITE_FG_RE.test(line)) return;
      const fills = [...new Set([...line.matchAll(FILL_RE)].map(m => m[1]))];
      for (const fill of fills) {
        out.push({ at: `${path}:${i + 1}`, fill, fg: /text-ink-inverse/.test(line) ? 'ink-inverse' : 'white' });
      }
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const PAIRINGS = scanPairings();
/** `-text` tokens are TEXT tones by construction; see the dedicated spec below. */
const isTextTone = (fill: string) => fill.endsWith('-text');
const FILL_TOKENS = [...new Set(PAIRINGS.filter(p => !isTextTone(p.fill)).map(p => p.fill))].sort();
const sitesFor = (fill: string) => PAIRINGS.filter(p => p.fill === fill).map(p => p.at);

describe('Theme palette — the contrast arithmetic itself', () => {
  it('computes WCAG ratios that can be trusted, against three known answers', () => {
    // Without this row every ratio below could be wrong in the same direction
    // and the suite would still look green.
    expect(contrast(WHITE, { l: 0, c: 0, h: 0 })).toBeCloseTo(21, 2);
    expect(contrast({ l: 0.62, c: 0.2, h: 25 }, { l: 0.62, c: 0.2, h: 25 })).toBeCloseTo(1, 6);
    // …and a third point read out of the stylesheet, so the PARSER is calibrated
    // too, not only the conversion: light --color-accent measures 5.17:1.
    expect(contrast(WHITE, token(LIGHT, '--color-accent'))).toBeCloseTo(5.173, 2);
  });

  it('reports a too-light background as FAILING, including the values this change replaced', () => {
    // The assertion of absence for every "≥ 4.5" below: if the helper returned
    // large numbers unconditionally, "clears AA" would mean nothing. These are
    // the exact dark fills that shipped before this change.
    expect(contrast(WHITE, { l: 0.64, c: 0.16, h: 258 })).toBeCloseTo(3.401, 2); // old dark accent
    expect(contrast(WHITE, { l: 0.62, c: 0.2, h: 25 })).toBeCloseTo(4.013, 2); // old dark critical
    expect(contrast(WHITE, { l: 0.7, c: 0.16, h: 60 })).toBeCloseTo(2.791, 2); // old dark caution
    for (const old of [
      { l: 0.64, c: 0.16, h: 258 },
      { l: 0.62, c: 0.2, h: 25 },
      { l: 0.7, c: 0.16, h: 60 },
      { l: 0.85, c: 0, h: 0 }, // and a plain light grey, far above the line
    ] satisfies Oklch[]) {
      expect(contrast(WHITE, old)).toBeLessThan(AA_TEXT);
      expect(contrastAtWorst(WHITE, old)).toBeLessThan(AA_TEXT);
    }
  });
});

describe('Theme palette — white on a solid fill clears AA in both themes', () => {
  it('finds the white-on-fill sites the app ships, in the files that ship them', () => {
    // Non-vacuity for the two ratio specs below: a walker that read nothing, or
    // a regex that matched nothing, would pass them trivially.
    expect(PAIRINGS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(PAIRINGS.map(p => p.at.split(':')[0])).size).toBeGreaterThanOrEqual(18);

    // Named sites, one per shape the scan has to understand: a ternary arm, a
    // `hover:` variant on the same line, a gradient pair, and the ink-inverse
    // foreground. Each is a real site that must stay covered.
    const found = new Set(PAIRINGS.map(p => `${p.at.split(':')[0]} ${p.fill} ${p.fg}`));
    for (const expected of [
      'src/app/utilization/utilization.component.ts accent white', // ternary arm
      'src/app/not-found/not-found.component.ts accent-strong white', // hover: variant
      'src/app/my-profile/my-profile.component.ts accent white', // from-/to- gradient
      'src/app/forecast/forecast.ts accent ink-inverse', // ink-inverse foreground
      'src/app/configuration/manage-vendors.component.ts critical white',
      'src/app/projects/project-plans/project-plans.ts caution white',
      'src/app/projects/financial-plans/financial-plans.ts critical-strong ink-inverse',
    ]) {
      expect(found, `the scan stopped seeing: ${expected}`).toContain(expected);
    }

    // Every family the app actually paints white on. `positive` and `info` are
    // absent from this set BY MEASUREMENT — they are dots, bars and borders — and
    // that is why they were left bright; if one ever gains a white foreground the
    // scan below starts asserting it and the token has to move.
    expect(FILL_TOKENS).toEqual([
      'accent',
      'accent-strong',
      'caution',
      'caution-strong',
      'critical',
      'critical-strong',
    ]);
  });

  for (const [theme, block] of THEMES) {
    it(`clears ${AA_TEXT}:1 for every shipped pairing in the ${theme} theme`, () => {
      // BOTH themes, from one loop: the light half is what proves a global edit
      // was not applied to the wrong block — darkening the light fills to satisfy
      // dark would show up as the light ratios drifting, and pasting the dark
      // block over the light one is caught by the distinctness spec below.
      expect(FILL_TOKENS.length).toBeGreaterThan(0);
      for (const fill of FILL_TOKENS) {
        const bg = token(block, `--color-${fill}`);
        // `contrastAtWorst` brackets an out-of-gamut declaration between its
        // clamped and unclamped luminance, so no verdict here can be an artefact
        // of how a browser maps a token back into sRGB.
        expect(
          contrastAtWorst(WHITE, bg),
          `${theme} --color-${fill} under white text (${sitesFor(fill).length} sites, e.g. ${sitesFor(fill)[0]})`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });
  }

  it('keeps the two white-ish foregrounds identical, so a class swap cannot change the ratio', () => {
    for (const [theme, block] of THEMES) {
      const inkInverse = token(block, '--color-ink-inverse');
      expect(inkInverse.l, `${theme} --color-ink-inverse must be white`).toBe(1);
      expect(inkInverse.c, `${theme} --color-ink-inverse must be white`).toBe(0);
      for (const fill of FILL_TOKENS) {
        const bg = token(block, `--color-${fill}`);
        expect(contrast(inkInverse, bg)).toBeCloseTo(contrast(WHITE, bg), 6);
      }
    }

    // Absence twin, and the reason the token had to move: dark --color-ink-inverse
    // used to be the dark SURFACE colour, which read 5.27:1 on the old lifted
    // accent — that is what made "swap text-white for text-ink-inverse" look like
    // a fix. Against the darkened fills the same value is sub-AA, so the class
    // swap alone would now be the defect.
    const oldDarkInkInverse: Oklch = { l: 0.205, c: 0.018, h: 270 };
    expect(contrast(oldDarkInkInverse, { l: 0.64, c: 0.16, h: 258 })).toBeGreaterThanOrEqual(AA_TEXT);
    for (const fill of FILL_TOKENS) {
      expect(
        contrast(oldDarkInkInverse, token(DARK, `--color-${fill}`)),
        `the old dark ink-inverse must NOT still pass on --color-${fill}`,
      ).toBeLessThan(AA_TEXT);
    }
  });

  it('keeps the fills perceivable against the dark surfaces they sit on', () => {
    // The other wall of the window, and the absence twin for the darkening
    // itself: "white must clear 4.5:1" is satisfiable by painting every fill
    // black, which would make the buttons vanish into the panel. WCAG 1.4.11
    // wants 3:1 against the backdrop, so the values are pinned from both sides
    // and there is no legal move left except the narrow band that was chosen.
    for (const surface of ['--color-surface', '--color-surface-muted', '--color-canvas'] as const) {
      const bg = token(DARK, surface);
      for (const fill of FILL_TOKENS) {
        expect(
          contrast(token(DARK, `--color-${fill}`), bg),
          `dark --color-${fill} against ${surface}`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    }
    // Non-vacuous: a fill darkened all the way to the canvas fails this, which is
    // exactly the mistake the assertion exists to catch.
    expect(contrast({ l: 0.22, c: 0.02, h: 270 }, token(DARK, '--color-surface'))).toBeLessThan(AA_NON_TEXT);

    // --color-surface-raised is NOT in that list, and the omission is asserted
    // rather than quietly taken: it is declared but no component renders on it,
    // so no fill sits there. Against it the base fills measure 2.98:1 — just
    // under the floor — so the day it becomes a real backdrop the fills have to
    // lift ~0.005 L and this list has to grow. This is what makes that day fail
    // loudly instead of shipping a surface the palette was never checked on.
    expect(filesReferencing('surface-raised'), 'surface-raised is in use now — add it above').toEqual([]);
    expect(
      contrast(token(DARK, '--color-accent'), token(DARK, '--color-surface-raised')),
      'the fills now clear 3:1 on surface-raised — add it to the list above and delete this line',
    ).toBeLessThan(AA_NON_TEXT);
    // …and the same scan does find the surfaces that ARE in use, so an empty
    // result above is a fact about the codebase and not a broken regex.
    expect(filesReferencing('surface-muted').length).toBeGreaterThan(0);
    expect(filesReferencing('canvas').length).toBeGreaterThan(0);
  });

  it('declares every fill this change moved inside the sRGB gamut', () => {
    // An out-of-gamut declaration renders as whatever the browser maps it to, so
    // the ratio computed for it is an estimate. Every value this change chose is
    // exact; the two light `-strong` fills it did NOT touch are still declared
    // beyond the boundary, which is why the ratio specs use `contrastAtWorst`.
    for (const [theme, block, name] of [
      ['dark', DARK, '--color-accent'],
      ['dark', DARK, '--color-accent-strong'],
      ['dark', DARK, '--color-critical'],
      ['dark', DARK, '--color-critical-strong'],
      ['dark', DARK, '--color-caution'],
      ['dark', DARK, '--color-caution-strong'],
      ['dark', DARK, '--color-info'],
      ['light', LIGHT, '--color-caution'],
    ] as const) {
      expect(isInSrgbGamut(token(block, name)), `${theme} ${name} is not representable in sRGB`).toBe(true);
    }
    // Non-vacuous: the predicate does reject something, and specifically the
    // value this change would have used had it moved lightness alone — dark
    // caution's old chroma at its new lightness is beyond the sRGB boundary
    // (blue goes negative). That is why 0.16 became 0.125, and it is the only
    // reason: hue is untouched and no token was desaturated for taste.
    expect(isInSrgbGamut({ l: 0.535, c: 0.16, h: 60 })).toBe(false);
    expect(isInSrgbGamut({ l: 0.535, c: 0.125, h: 60 })).toBe(true);
  });

  it('keeps hover a real step, in each theme’s own direction, with both ends above AA', () => {
    // A palette can be made AA-compliant by collapsing hover onto the resting
    // colour, or by inverting it. Neither is acceptable: dark LIFTS on hover (and
    // always did), light DARKENS, and both ends have to clear the floor — the
    // ratio specs above cover `-strong` because the app paints white on it too.
    for (const family of ['accent', 'critical', 'caution'] as const) {
      const light = { base: token(LIGHT, `--color-${family}`), hover: token(LIGHT, `--color-${family}-strong`) };
      const dark = { base: token(DARK, `--color-${family}`), hover: token(DARK, `--color-${family}-strong`) };
      expect(dark.hover.l, `dark ${family} hover must stay lighter than its resting fill`).toBeGreaterThan(dark.base.l);
      expect(light.hover.l, `light ${family} hover must stay darker than its resting fill`).toBeLessThan(light.base.l);
      // …and a step a user can actually see, not a rounding difference.
      expect(Math.abs(dark.hover.l - dark.base.l)).toBeGreaterThanOrEqual(0.03);
      expect(Math.abs(light.hover.l - light.base.l)).toBeGreaterThanOrEqual(0.03);
    }
  });

  it('keeps the info family a mirror of the accent family in both themes', () => {
    // `info` ships no white foreground of its own, so the ratio specs above do
    // not reach it — and it was darkened with accent purely to keep the two
    // identical, which is how both themes have always declared them. Without
    // this, that edit would be an unpinned colour change: exactly the kind of
    // "nothing measures it" move this suite exists to prevent.
    for (const [theme, block] of THEMES) {
      for (const suffix of ['', '-text', '-tint'] as const) {
        expect(token(block, `--color-info${suffix}`), `${theme} info${suffix} drifted from accent${suffix}`).toEqual(
          token(block, `--color-accent${suffix}`),
        );
      }
    }
    // Twin: the comparison is not satisfied by any two tokens — families that are
    // meant to be different still are.
    expect(token(DARK, '--color-critical')).not.toEqual(token(DARK, '--color-caution'));
  });

  it('keeps the light and dark declarations distinct, so neither block was pasted over the other', () => {
    // The light fills are near the dark ones now — the white-text constraint is
    // the same in both themes — which is precisely when a copy-paste stops being
    // obvious. Chroma is the tell: dark keeps it lower against a dark surround.
    for (const family of ['accent', 'critical', 'caution'] as const) {
      const light = token(LIGHT, `--color-${family}`);
      const dark = token(DARK, `--color-${family}`);
      expect(dark.c, `dark --color-${family} should keep less chroma than light`).toBeLessThan(light.c);
    }
    // And the surfaces — the tokens that really do flip — are still opposites.
    expect(token(LIGHT, '--color-surface').l).toBeGreaterThan(0.9);
    expect(token(DARK, '--color-surface').l).toBeLessThan(0.3);
  });
});

describe('Theme palette — the .command-button primitive', () => {
  it('pairs its white ink with the accent fill through the legacy aliases', () => {
    // The one white-on-fill pairing that lives in CSS rather than in a template,
    // so the source scan above cannot see it. Pinning the alias chain is what
    // makes the accent ratios apply to this primitive: repoint --cc-primary at a
    // lighter token and this fails instead of silently going sub-AA.
    const button = cssBlock(GLOBAL_CSS, '.command-button');
    expect(button).toMatch(/background:\s*var\(--cc-primary\)/);
    expect(button).toMatch(/color:\s*var\(--color-ink-inverse\)/);
    expect(cssBlock(GLOBAL_CSS, '.command-button:hover')).toMatch(/background:\s*var\(--cc-primary-strong\)/);
    expect(ALIASES).toMatch(/--cc-primary:\s*var\(--color-accent\)/);
    expect(ALIASES).toMatch(/--cc-primary-strong:\s*var\(--color-accent-strong\)/);
  });
});

describe('Theme palette — a -text tone cannot double as a white-text fill', () => {
  /**
   * Files that paint white on a `*-text` token. This is a different defect from
   * the one above and the stylesheet cannot fix it: a `-text` tone has to stay
   * LIGHT in dark theme to be readable as text on the dark surface, which is the
   * opposite of what a white-text background needs. It has to change at the call
   * site — `hover:bg-critical-text` should be `hover:bg-critical-strong`.
   *
   * Exact equality, by file (not line, so unrelated edits to that file do not
   * fail this): a new offender fails, and so does a fixed one, with a message
   * saying to delete the entry.
   */
  const OFFENDERS = ['src/app/projects/projects/projects.ts'];

  it('has exactly the known call sites left, and they are not fixable here', () => {
    const files = [...new Set(PAIRINGS.filter(p => isTextTone(p.fill)).map(p => p.at.split(':')[0]))].sort();
    expect(files, 'fixed at the call site? delete its entry here').toEqual(OFFENDERS);

    // WHY it is not fixable token-side, in numbers rather than prose. The tone is
    // pinned as text by dashboard.component.spec.ts and forecast.spec.ts…
    const criticalText = token(DARK, '--color-critical-text');
    expect(contrast(criticalText, token(DARK, '--color-surface'))).toBeGreaterThanOrEqual(AA_TEXT);
    // …and at that lightness white on top of it is not even large-text legible,
    // so no value of this token satisfies both roles.
    expect(contrast(WHITE, criticalText)).toBeLessThan(AA_NON_TEXT);
  });
});
