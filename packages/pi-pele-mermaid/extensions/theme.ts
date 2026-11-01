/**
 * Pele → terminal palette conversion.
 *
 * Pele SVGs express every color through CSS custom properties (`var(--_s)`,
 * `var(--pele-surface,#f3f3f3)`). resvg does not resolve custom properties, so a straight
 * rasterization comes out fully transparent. Every variable is therefore folded into a
 * concrete color literal before the SVG reaches resvg.
 *
 * Background handling: leaving `--pele-bg`/`--_n` transparent turns filled shapes into empty
 * holes, so the diagram is painted with the terminal's own background color instead. Node
 * surfaces are mixed from that background so they stay visible on any terminal theme.
 */

export type Appearance = "dark" | "light";

export interface Palette {
  background: string;
  foreground: string;
  muted: string;
  line: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  accent: string;
  series: [string, string, string, string, string, string, string, string];
}

/** Single-color tokens; `series` is handled separately. */
type ScalarToken = Exclude<keyof Palette, "series">;

export const DARK: Palette = {
  background: "#101014",
  foreground: "#d4d4d4",
  muted: "#949494",
  line: "#b4b4b4",
  surface: "#242424",
  surfaceAlt: "#1b1b1b",
  border: "#6d6d6d",
  accent: "#7aa2f7",
  series: ["#6b9fd4", "#e0965a", "#7fb069", "#e0706f", "#5fb3b3", "#d8c05a", "#b18fb8", "#b39482"],
};

export const LIGHT: Palette = {
  background: "#ffffff",
  foreground: "#24292f",
  muted: "#6b7280",
  line: "#4b5563",
  surface: "#f4f4f5",
  surfaceAlt: "#e9e9eb",
  border: "#b6b6bb",
  accent: "#2563eb",
  series: ["#4c78a8", "#e08214", "#4f9b46", "#d05553", "#4aa5a0", "#c4a534", "#a1739b", "#93705a"],
};

/** Evaluates `color-mix(in srgb, A n%, B)` in sRGB space. */
export function mixSrgb(a: string, b: string, ratioA: number): string {
  const left = parseHex(a);
  const right = parseHex(b);
  if (!left || !right) return a;
  const ratio = clamp(ratioA, 0, 1);
  const channel = (x: number, y: number) => Math.round(x * ratio + y * (1 - ratio));
  return `#${[channel(left[0], right[0]), channel(left[1], right[1]), channel(left[2], right[2])]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseHex(value: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const n = Number.parseInt(match[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG relative luminance, used to pick the light or dark palette from a background color. */
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Short private aliases Pele sets on the root element. */
const rootAliases: Record<string, ScalarToken> = {
  _bg: "background",
  _fg: "foreground",
  _m: "muted",
  _l: "line",
  _s: "surface",
  _a: "surfaceAlt",
  _b: "border",
  _c: "accent",
  n: "background",
};

/** Public `--pele-*` tokens. */
const namedTokens: Record<string, ScalarToken> = {
  bg: "background",
  fg: "foreground",
  muted: "muted",
  line: "line",
  surface: "surface",
  "surface-alt": "surfaceAlt",
  border: "border",
  accent: "accent",
};

/** Replaces every Pele CSS variable with a concrete palette color. */
export function applyPalette(svg: string, palette: Palette): string {
  let out = svg;

  // 1) Root aliases without a fallback, e.g. var(--_s).
  out = out.replace(/var\(--_(bg|fg|m|l|s|a|b|c|n)\)/g, (match, key: string) => {
    const token = rootAliases[`_${key}`];
    return token ? palette[token] : match;
  });

  // 2) Public tokens with a fallback, e.g. var(--pele-surface, #f3f3f3).
  out = out.replace(
    /var\(--pele-([a-z0-9-]+)(?:,\s*([^)]*))?\)/g,
    (match, name: string, fallback?: string) => {
      const series = /^series-([1-8])$/.exec(name);
      if (series) return palette.series[Number(series[1]) - 1] ?? fallback ?? match;
      const token = namedTokens[name];
      return token ? palette[token] : (fallback?.trim() ?? match);
    },
  );

  // 3) Font weight and radius aliases become plain SVG attribute values.
  out = out.replace(/var\(--_(?:tw|hw|w)\)/g, "700").replace(/var\(--_r\)/g, "4");

  // 4) Pele paints subgraphs and shapes with color-mix(), which resvg does not implement.
  out = resolveColorMix(out, palette);

  // 5) Any remaining variable folds into its fallback. A value resvg cannot parse would
  //    otherwise drop the whole element.
  out = out.replace(
    /var\((--[a-z0-9-]+)(?:,\s*([^)]*))?\)/gi,
    (_match, _name: string, fallback?: string) => fallback?.trim() ?? "transparent",
  );

  return out;
}

/** Evaluates `color-mix(in srgb, A p%, B)` when both endpoints resolve. */
function resolveColorMix(svg: string, palette: Palette): string {
  return svg.replace(
    /color-mix\(in srgb,\s*([^,]+?)\s+([\d.]+)%\s*,\s*([^)]+?)\s*\)/gi,
    (match, first: string, percent: string, second: string) => {
      const a = resolveColorToken(first.trim(), palette);
      const b = resolveColorToken(second.trim(), palette);
      if (!a || !b) return b ?? a ?? match;
      return mixSrgb(a, b, Number(percent) / 100);
    },
  );
}

function resolveColorToken(value: string, palette: Palette): string | undefined {
  if (parseHex(value)) return value;
  const alias = /^var\(--_(bg|fg|m|l|s|a|b|c|n)\)$/.exec(value);
  if (alias) {
    const token = rootAliases[`_${alias[1]}`];
    return token ? palette[token] : undefined;
  }
  const named = /^var\(--pele-([a-z0-9-]+)(?:,\s*([^)]*))?\)$/.exec(value);
  if (named) {
    const token = namedTokens[named[1]!];
    return token ? palette[token] : named[2];
  }
  return undefined;
}

/** Picks the light or dark palette and anchors surfaces to the terminal background. */
export function paletteFor(background: string, appearance: Appearance): Palette {
  const valid = parseHex(background) !== undefined;
  const light = valid ? luminance(background) > 0.5 : appearance === "light";
  const chosen: Palette = { ...(light ? LIGHT : DARK) };
  if (!valid) return chosen;
  chosen.background = background;
  // Surfaces are mixed from the background so shapes stay legible on any terminal color.
  chosen.surface = mixSrgb(light ? "#7c7c84" : "#ffffff", background, light ? 0.055 : 0.09);
  chosen.surfaceAlt = mixSrgb(light ? "#6a6a72" : "#ffffff", background, light ? 0.09 : 0.045);
  return chosen;
}
