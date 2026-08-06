/**
 * OKLCH → WCAG contrast arithmetic over the design tokens in `src/styles.css`.
 *
 * TEST-ONLY. Nothing in the application imports this module: jsdom performs no
 * layout and resolves no custom properties, so the only honest way to make a
 * claim about rendered colour is to parse the token out of the stylesheet and
 * compute the ratio. Three specs used to carry their own copy of this maths
 * (`schedule.component.spec.ts`, `dashboard.component.spec.ts`,
 * `forecast.spec.ts`); this is the one they should share, so a correction to the
 * conversion cannot land in one copy and miss the others.
 *
 * Deliberately free of `node:fs` and of `expect`: callers read the CSS and make
 * the assertions, these functions only compute. That keeps the module importable
 * from any spec and keeps failures attributable to the caller's assertion.
 */

export interface Oklch {
  /** Perceptual lightness, 0–1. */
  l: number;
  /** Chroma (0 = grey). */
  c: number;
  /** Hue angle in degrees. */
  h: number;
}

/** Pure white — the foreground this stylesheet puts on every solid fill. */
export const WHITE: Oklch = { l: 1, c: 0, h: 0 };

/** WCAG AA for text below 18.66px bold / 24px regular. */
export const AA_TEXT = 4.5;

/** WCAG 1.4.11 non-text contrast (a fill against the surface behind it). */
export const AA_NON_TEXT = 3;

/**
 * The declarations of one flat CSS rule. `src/styles.css` has no nested braces,
 * so the block ends at the first `}` after the selector.
 *
 * Throws rather than returning empty: a selector that silently resolves to `''`
 * would make every `token()` lookup below fail as "not found", which reads like
 * a missing token instead of a missing rule.
 */
export function cssBlock(css: string, selector: string): string {
  const needle = `${selector} {`;
  const at = css.indexOf(needle);
  if (at < 0) throw new Error(`CSS selector not found: ${selector}`);
  return css.slice(at + needle.length, css.indexOf('}', at));
}

/** Pull `--token: oklch(l c h)` out of a block of declarations. */
export function token(block: string, name: string): Oklch {
  const m = new RegExp(`${name}:\\s*oklch\\(([^)]+)\\)`).exec(block);
  if (!m) throw new Error(`token not found: ${name}`);
  const [l, c, h] = m[1].trim().split(/\s+/).map(Number);
  if (![l, c].every(Number.isFinite)) throw new Error(`token is not numeric oklch: ${name}`);
  return { l, c, h: Number.isFinite(h) ? h : 0 };
}

/**
 * OKLCH → OKLab → LINEAR sRGB (Ottosson's matrices). Linear sRGB is exactly the
 * gamma-decoded space WCAG defines relative luminance over, so no extra transfer
 * function belongs here.
 */
function linearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const Y = ([r, g, b]: readonly [number, number, number]): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * True when the colour is representable in sRGB. An out-of-gamut declaration is
 * still *rendered* — the browser maps it back to the boundary — so the ratio
 * computed for it is an approximation of what ships. `contrastAtWorst()` is the
 * safe way to reason about those; this predicate is how a spec can insist that a
 * value it pins is exact.
 */
export function isInSrgbGamut(colour: Oklch): boolean {
  return linearSrgb(colour).every(v => v >= -1e-9 && v <= 1 + 1e-9);
}

/** WCAG relative luminance, channels clamped into sRGB (the in-gamut answer). */
export function luminance(colour: Oklch): number {
  const [r, g, b] = linearSrgb(colour);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return Y([clamp(r), clamp(g), clamp(b)]);
}

/** The same, unclamped: the other end of the bracket for an out-of-gamut colour. */
function luminanceUnclamped(colour: Oklch): number {
  return Y(linearSrgb(colour));
}

const ratio = (a: number, b: number): number => {
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

/** WCAG contrast ratio between two OKLCH colours (1–21). */
export function contrast(x: Oklch, y: Oklch): number {
  return ratio(luminance(x), luminance(y));
}

/**
 * The LOWEST contrast the pair can render at, bracketing each colour between its
 * clamped and unclamped luminance.
 *
 * For an in-gamut pair the two agree and this is just `contrast()`. For a token
 * declared outside sRGB it is the pessimistic reading, so a spec asserting
 * `contrastAtWorst(...) >= 4.5` cannot be satisfied by a gamut-mapping artefact
 * — which matters here because several light-theme `-strong` fills are declared
 * with more chroma than sRGB can hold at their lightness.
 */
export function contrastAtWorst(x: Oklch, y: Oklch): number {
  const xs = [luminance(x), luminanceUnclamped(x)];
  const ys = [luminance(y), luminanceUnclamped(y)];
  return Math.min(...xs.flatMap(a => ys.map(b => ratio(a, b))));
}
