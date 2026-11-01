/**
 * Pele rasterization: lay out once, enforce display width/row budgets with uniform scaling,
 * then rasterize the chosen SVG at the requested sharpness within bounded pixel dimensions.
 */
import { deflateSync } from "node:zlib";
import { normalizeSource } from "./source.ts";
import { getCellDimensions } from "@earendil-works/pi-tui";
import { Resvg } from "@resvg/resvg-js";
import { render as renderPele } from "pele";
import { applyPalette, paletteFor, parseHex, type Appearance } from "./theme.ts";

/** Pele's default label font size in pixels. */
const BASE_FONT_SIZE = 16;
const SOURCE_LIMIT = 200_000;
/**
 * Below this display scale glyphs are no longer legible, so the source block is kept rather
 * than drawing an unreadable smudge. Chosen against Pretendard at 16px: one cell of text stays
 * readable down to roughly a third of its size.
 */
const MIN_SHRINK = 0.2;
/**
 * Upper bound on magnifying a narrow diagram. Past this the drawing would be blurrier than the
 * layout gain is worth, and a two-node flowchart would occupy half the screen.
 */
const MAX_MAGNIFY = 4;

export interface RasterOptions {
  appearance: Appearance;
  /** Terminal background color. Falls back to the palette default when unusable. */
  background?: string;
  /** Columns available to the diagram in the transcript. */
  maxColumns: number;
  /** Maximum display width as a fraction of `maxColumns` (0..1). */
  fillWidth: number;
  scale: number;
  padding: number;
  fontFamily: string;
  fontFamilyMono?: string;
  fontFiles: string[];
  loadSystemFonts: boolean;
  /** Row budget in terminal cells. 0 disables the limit. */
  maxRows: number;
  /** Kitty accepts zlib-compressed raw RGBA; iTerm2 requires PNG. */
  format?: "rgba-zlib" | "png";
  /** Raster height cap, independent of terminal row count. */
  maxHeightPx?: number;
  /** Decoded RGBA byte cap for terminals with stricter forwarding limits. */
  maxRasterBytes?: number;
}

export interface Raster {
  base64: string;
  /** Vector original using the terminal display palette. */
  svg: string;
  /** Same layout in light mode on an opaque white canvas, for saved/click-to-open SVGs. */
  snapshotSvg: string;
  format: "rgba-zlib" | "png";
  widthPx: number;
  heightPx: number;
  columns: number;
  rows: number;
  /** Columns the diagram needs before being narrowed to the target width. */
  naturalColumns: number;
  /** Display magnification applied to a narrow diagram so it fills the floor. */
  magnify: number;
}

export class RenderError extends Error {}

/** Why a diagram was not drawn, when it was a policy decision rather than a parse failure. */
export type SkipReason = "too-tall" | "too-wide" | "unreadable";

export interface RasterResult {
  raster?: Raster;
  reason?: SkipReason;
}

/** Whether Pele can draw this source. */
export function detect(text: string): boolean {
  if (!/^\s*(?:---|\w)/.test(text)) return false;
  try {
    return renderPele(normalizeSource(text), { limit: SOURCE_LIMIT }).type !== undefined;
  } catch {
    return false;
  }
}

export function rasterize(text: string, options: RasterOptions): Raster | undefined {
  text = normalizeSource(text);
  const cells = getCellDimensions();
  const cellWidth = Math.max(1, cells.widthPx);
  const cellHeight = Math.max(1, cells.heightPx);
  const scale = Math.max(1, options.scale);

  const maxColumns = Math.max(8, Math.floor(options.maxColumns));
  const ratio = Math.min(1, Math.max(0.1, options.fillWidth));
  // fillWidth is a hard display-width cap, not just a magnification target. Otherwise wide
  // charts keep filling 100% while only small diagrams respect the requested side margins.
  const targetColumns = Math.max(1, Math.round(maxColumns * ratio));
  const maxTargetPx = targetColumns * cellWidth;

  const palette = paletteFor(
    options.background ?? fallbackBackground(options.appearance),
    options.appearance,
  );

  const draw = (targetPx: number) => {
    const rendered = renderPele(text, {
      fontFamily: options.fontFamily,
      fontFamilyMono: options.fontFamilyMono,
      fontSize: BASE_FONT_SIZE,
      padding: options.padding,
      maxWidth: targetPx,
      responsive: false,
      links: false,
      images: false,
      limit: SOURCE_LIMIT,
    });
    return {
      svg: rendered.svg,
      width: rendered.width,
      height: rendered.height,
      columns: Math.max(1, Math.round(rendered.width / cellWidth)),
      rows: Math.max(1, Math.ceil(rendered.height / cellHeight)),
    };
  };

  let best: ReturnType<typeof draw>;
  let natural: ReturnType<typeof draw>;
  try {
    // Pele treats maxWidth as a cap: the result is already at most the available width.
    natural = draw(maxTargetPx);
    best = natural;
  } catch (error) {
    throw new RenderError(error instanceof Error ? error.message : String(error));
  }

  // Fill the target width, not the entire transcript. A narrow drawing is magnified toward
  // that width and a wide one is scaled down to fit, leaving centered margins.
  const floorColumns = targetColumns;
  const widthAllowance = floorColumns / Math.max(1, best.columns);
  const magnify = Math.min(MAX_MAGNIFY, Math.max(1, widthAllowance));

  // Then honor both budgets by display scale. Pele sometimes gives up on fitting a wide graph
  // (it keeps the across layout rather than reflowing), so the width is also enforced here.
  // Scaling keeps the rendered layout intact, unlike a second pass.
  let shrink = 1;
  if (best.columns * magnify > targetColumns) shrink = targetColumns / (best.columns * magnify);
  const rowsAtMagnify = best.rows * magnify * shrink;
  if (options.maxRows > 0 && rowsAtMagnify > options.maxRows)
    shrink *= options.maxRows / rowsAtMagnify;
  // A diagram that only fits by becoming illegible is shown as source instead.
  if (shrink < MIN_SHRINK) return undefined;

  const cellRatio = magnify * shrink;

  // Round the cell box to whole cells, then rebuild the canvas from that box so the image
  // occupies it exactly. Kitty fills the declared c=r= box, so any mismatch shows up as
  // horizontal or vertical stretching of the drawing.
  const columns = Math.max(1, Math.round(best.columns * cellRatio));
  const rows = Math.max(1, Math.round(best.rows * cellRatio));
  // Bound native memory and transfer size by lowering raster resolution, not rejecting tall
  // diagrams. Keep the cell box/aspect ratio unchanged. Retina cell sizes can already be
  // large, so even a requested scale of 1 may need downsampling.
  const displayWidth = columns * cellWidth;
  const displayHeight = rows * cellHeight;
  const maxPixels = Math.min(
    16_000_000,
    options.maxRasterBytes === undefined
      ? 16_000_000
      : Math.max(1, Math.floor(options.maxRasterBytes / 4)),
  );
  const rasterScale = Math.min(
    scale,
    (options.maxHeightPx ?? 4096) / displayHeight,
    8192 / displayWidth,
    Math.sqrt(maxPixels / (displayWidth * displayHeight)),
  );
  const canvasWidth = Math.max(1, Math.floor(displayWidth * rasterScale));
  const canvasHeight = Math.max(1, Math.floor(displayHeight * rasterScale));

  const svg = applyPalette(best.svg, palette);
  // Resolve from the original tokens, not the already-colored display SVG. Some Pele
  // charts have no canvas fill, so saved images explicitly paint white behind the drawing.
  const snapshotSvg = applyPalette(best.svg, paletteFor("#ffffff", "light")).replace(
    /^<svg\b[^>]*>/,
    '$&<rect width="100%" height="100%" fill="#ffffff"/>',
  );
  const base64 = rasterizeSvg(svg, options, canvasWidth, canvasHeight);
  return {
    base64,
    svg,
    snapshotSvg,
    format: options.format ?? "png",
    widthPx: canvasWidth,
    heightPx: canvasHeight,
    columns,
    rows,
    naturalColumns: natural.columns,
    magnify: cellRatio,
  };
}

/**
 * Draws the SVG onto a canvas of exactly `width`x`height` pixels.
 *
 * The drawing keeps its own aspect ratio and is centered, so the extra space stays
 * transparent instead of being stretched. Kitty fills the cell box it is given, which is why
 * the canvas has to match that box exactly: a mismatch is visible as squashed text.
 *
 * Pele emits a plain `<svg>` with a `viewBox`, so it can be wrapped in an outer SVG that both
 * pads to the canvas and preserves the aspect ratio.
 */
function rasterizeSvg(svg: string, options: RasterOptions, width: number, height: number): string {
  let resvg: Resvg;
  try {
    resvg = new Resvg(wrapToCanvas(svg, width, height), { ...resvgOptions(options) });
  } catch {
    // Wrapping can fail on unusual output (for example a missing viewBox); fall back to the
    // raw document, which resvg can still size from its own width/height attributes.
    resvg = new Resvg(svg, { ...resvgOptions(options), fitTo: { mode: "width", value: width } });
  }
  const image = resvg.render();
  return (
    options.format === "rgba-zlib" ? deflateSync(image.pixels, { level: 1 }) : image.asPng()
  ).toString("base64");
}

function resvgOptions(options: RasterOptions): ConstructorParameters<typeof Resvg>[1] {
  return {
    font: {
      fontFiles: options.fontFiles,
      loadSystemFonts: options.loadSystemFonts,
      defaultFontFamily: options.fontFamily,
      ...(options.fontFamilyMono ? { monospaceFamily: options.fontFamilyMono } : {}),
    },
    // The SVG paints its own background; a second fill here would flatten the alpha channel.
    background: "rgba(0,0,0,0)",
  };
}

/** Places the drawing inside a `width`x`height` canvas with uniform scaling. */
function wrapToCanvas(svg: string, width: number, height: number): string {
  const open = /^<svg\b([^>]*)>/.exec(svg);
  const viewBox = open ? /viewBox="([^"]+)"/.exec(open[1] ?? "")?.[1] : undefined;
  if (!open || !viewBox) return svg;
  const parts = viewBox.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return svg;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0) return svg;

  // Every attribute on the root matters: `fill` carries the text color and `style` carries the
  // resolved palette. Only the size and the viewBox are replaced.
  let attrs = (open[1] ?? "")
    .replace(/\s*viewBox="[^"]*"/, "")
    .replace(/\s*width="[^"]*"/, "")
    .replace(/\s*height="[^"]*"/, "")
    .replace(/\s*(max-width|height)\s*:[^;"]*;?/g, (match) => match);
  const body = svg.slice(open[0].length).replace(/<\/svg>\s*$/, "");

  // preserveAspectRatio keeps glyph proportions; `meet` centers the drawing in the canvas.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<svg${attrs} x="0" y="0" width="${width}" height="${height}" viewBox="${x} ${y} ${w} ${h}" ` +
    `preserveAspectRatio="xMidYMid meet">` +
    body +
    "</svg></svg>"
  );
}

function fallbackBackground(appearance: Appearance): string {
  return appearance === "light" ? "#ffffff" : "#000000";
}

/** True when the value is a usable `#rrggbb` color. */
export function isColor(value: string | undefined): value is string {
  return typeof value === "string" && parseHex(value) !== undefined;
}
