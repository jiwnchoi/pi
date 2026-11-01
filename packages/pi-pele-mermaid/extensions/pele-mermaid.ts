/**
 * pi-pele-mermaid
 *
 * Renders ```` ```mermaid ```` blocks in the Pi transcript as terminal graphics. Pele
 * (https://github.com/obsidianmd/pele) produces the SVG, which is rasterized at the sharpness
 * multiplier and sent through the Kitty graphics protocol (or iTerm2 inline images).
 *
 * Design notes
 *  - Background: the diagram is painted with the terminal's own background color, and node
 *    surfaces are mixed from it, so shapes stay legible on any terminal theme. Only light and
 *    dark appearances are supported.
 *  - Sharpness: layout is computed once at the base font size; the finished vector is then
 *    re-rasterized onto a `scale`× canvas. This is real vector rasterization, not pixel scaling.
 *  - Lossless: model context and session history keep the original Markdown. Only the rendered
 *    rows are changed.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { configPath, ensureConfigFile, loadConfig, type PeleConfig } from "./config.ts";
import {
  encodeITerm2Block,
  encodeKittyBlock,
  kittyRasterByteLimit,
  supportsPlaceholders,
} from "./kitty.ts";
import type { PlacementInput } from "./markdown.ts";
import {
  clearPlacements,
  installPlacementPass,
  rearmPlacementPass,
  replaceFences,
} from "./markdown.ts";
import { DIAGRAM_GUIDELINE, DIAGRAM_SECTION } from "./prompt.ts";
import { isColor, rasterize } from "./render.ts";
import { linkImageLines, saveSnapshot } from "./snapshot.ts";
import { luminance, type Appearance } from "./theme.ts";

const FONT_DIRS = [
  join(homedir(), "Library", "Fonts"),
  "/Library/Fonts",
  "/System/Library/Fonts",
  "/usr/share/fonts",
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts") : "",
].filter((dir) => dir !== "");

/**
 * Passing every system font to resvg slows startup noticeably, and Latin-only display faces add
 * nothing. These cover the fonts that can actually render CJK labels.
 */
const USEFUL_FONT =
  /pretendard|noto|d2coding|nanum|spoqa|ibm ?plex|jetbrains|fira|source ?code|hack|dejavu/i;

const fontFileCache = new Map<string, string[]>();
const fontSelectionCache = new Map<string, string[]>();

function listFontFiles(dir: string): string[] {
  const cached = fontFileCache.get(dir);
  if (cached) return cached;
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((name) => /\.(otf|ttf|ttc)$/i.test(name))
      .map((name) => join(dir, name));
  } catch {
    files = [];
  }
  fontFileCache.set(dir, files);
  return files;
}

function resolveFonts(config: PeleConfig): string[] {
  const key = JSON.stringify([config.font, config.fontMono, config.fontDirs]);
  const cached = fontSelectionCache.get(key);
  if (cached) return cached;
  const files =
    config.fontDirs.length > 0
      ? config.fontDirs.flatMap((dir) => listFontFiles(dir))
      : FONT_DIRS.flatMap((dir) => listFontFiles(dir));
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const families = [config.font, config.fontMono].filter((value): value is string =>
    Boolean(value),
  );
  const selected = families.flatMap((family) => {
    const matches = files.filter((file) => normalize(basename(file)).includes(normalize(family)));
    // SVG labels use normal/bold. Loading all nine Pretendard weights into a fresh resvg
    // instance per raster parses many megabytes of unused font data.
    const faces = matches.filter((file) =>
      /(?:regular|variable|(?:^|[-_])bold\b|\.ttc$)/i.test(basename(file)),
    );
    return faces.length > 0 ? faces : matches;
  });
  const result =
    config.fontDirs.length > 0
      ? files
      : [
          ...new Set(
            selected.length > 0 ? selected : files.filter((file) => USEFUL_FONT.test(file)),
          ),
        ];
  fontSelectionCache.set(key, result);
  return result;
}

interface ThemeColors {
  colors?: Record<string, unknown>;
  appearance?: string;
}

function themeBackgroundColor(theme: ThemeColors | undefined): string | undefined {
  const colors = theme?.colors;
  if (!colors) return undefined;
  for (const token of ["userMessageBg", "toolPendingBg", "customMessageBg", "selectedBg"]) {
    const value = colors[token] as
      | { kind?: string; r?: number; g?: number; b?: number }
      | undefined;
    if (value?.kind === "rgb" && typeof value.r === "number") {
      const hex = (channel: number) =>
        Math.max(0, Math.min(255, Math.round(channel)))
          .toString(16)
          .padStart(2, "0");
      return `#${hex(value.r)}${hex(value.g ?? 0)}${hex(value.b ?? 0)}`;
    }
  }
  return undefined;
}

/** Resolves light or dark from the Pi theme, falling back to the theme's background luminance. */
function resolveAppearance(config: PeleConfig, ctx: ExtensionContext | undefined): Appearance {
  if (config.mode === "dark" || config.mode === "light") return config.mode;
  const theme = ctx?.ui.theme as unknown as ThemeColors | undefined;
  if (theme?.appearance === "dark" || theme?.appearance === "light") return theme.appearance;
  const background = themeBackgroundColor(theme);
  if (background && isColor(background)) return luminance(background) > 0.5 ? "light" : "dark";
  return "dark";
}

/**
 * The terminal background color.
 *
 * Pi negotiates OSC 11 for its own theme rendering but does not expose the result to
 * extensions, so this resolves `PELE_MERMAID_BACKGROUND` first, then the theme's background
 * tokens, then a per-appearance default.
 */
function resolveBackground(config: PeleConfig, ctx: ExtensionContext | undefined): string {
  const override = process.env.PELE_MERMAID_BACKGROUND?.trim();
  if (isColor(override)) return override;
  const fromTheme = themeBackgroundColor(ctx?.ui.theme as unknown as ThemeColors | undefined);
  if (fromTheme && isColor(fromTheme)) return fromTheme;
  return resolveAppearance(config, ctx) === "light" ? "#ffffff" : "#000000";
}

function clearCaches(): void {
  fontFileCache.clear();
  fontSelectionCache.clear();
  renderCache.clear();
  skipReasons.clear();
}

/**
 * Without caching, every streaming delta re-rasterizes identical diagrams. The cache key covers
 * the source and every layout input, and a hit keeps the previous block so Kitty only has to
 * reposition an image it already holds.
 */
const renderCache = new Map<string, PlacementInput | undefined>();
const CACHE_LIMIT = 48;
/**
 * Sources that could not be drawn, with the reason. Reported once per source rather than on
 * every streaming delta, so a diagram that silently stays as source text explains itself.
 */
const skipReasons = new Map<string, string>();
let notifySkip: ((message: string) => void) | undefined;

function digest(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

interface RenderContext {
  config: PeleConfig;
  appearance: Appearance;
  background: string;
  maxColumns: number;
  /** Effective row budget: the configured cap, further limited by the terminal height. */
  maxRows: number;
}

function renderBlock(source: string, ctx: RenderContext): PlacementInput | undefined {
  const protocol = getCapabilities().images;
  if (protocol !== "kitty" && protocol !== "iterm2") return undefined;

  const cells = getCellDimensions();
  const maxRasterBytes = protocol === "kitty" ? kittyRasterByteLimit() : undefined;
  const { config } = ctx;
  const key = [
    digest(source),
    protocol,
    supportsPlaceholders(),
    maxRasterBytes ?? "",
    cells.widthPx,
    cells.heightPx,
    config.fontDirs.join("\n"),
    config.scale,
    config.padding,
    config.font,
    config.fontMono ?? "",
    ctx.maxRows,
    config.maxHeightPx,
    config.fillWidth,
    ctx.appearance,
    ctx.background,
    ctx.maxColumns,
  ].join("|");

  const cached = renderCache.get(key);
  if (renderCache.has(key)) {
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached;
  }

  let block: PlacementInput | undefined;
  try {
    const raster = rasterize(source, {
      appearance: ctx.appearance,
      background: ctx.background,
      maxColumns: ctx.maxColumns,
      fillWidth: config.fillWidth,
      scale: config.scale,
      padding: config.padding,
      fontFamily: config.font,
      fontFamilyMono: config.fontMono,
      fontFiles: resolveFonts(config),
      // Font files are supplied explicitly, so a full system scan is redundant.
      loadSystemFonts: false,
      maxRows: ctx.maxRows,
      maxHeightPx: config.maxHeightPx,
      maxRasterBytes,
      format: protocol === "kitty" ? "rgba-zlib" : "png",
    });
    if (!raster) {
      const key = digest(source);
      if (!skipReasons.has(key)) {
        skipReasons.set(key, "does not fit the row budget");
        notifySkip?.(
          "pele-mermaid: this diagram is too tall to draw at a readable size. Raise maxRows, split it into smaller diagrams, or set fillWidth below 1.",
        );
      }
    }
    if (raster) {
      const imageId = (Math.floor(Math.random() * 0xff_fffe) + 1) | 0;
      const url = saveSnapshot(raster.snapshotSvg);
      const encoded = new Map<number, string[]>();
      block = {
        columns: raster.columns,
        rows: raster.rows,
        encode: (left: number) => {
          let lines = encoded.get(left);
          if (!lines) {
            const image =
              protocol === "kitty"
                ? encodeKittyBlock(
                    raster.base64,
                    raster.columns,
                    raster.rows,
                    imageId,
                    left,
                    raster,
                  )
                : encodeITerm2Block(raster.base64, raster.columns, raster.rows, left);
            lines = linkImageLines(image.lines, url, left, image.placeholders);
            encoded.set(left, lines);
          }
          return lines;
        },
      };
    }
  } catch (error) {
    // Falling back to the source code block is better than failing the whole render, but the
    // reason should be visible: a silently missing diagram reads like a broken extension.
    const message = error instanceof Error ? error.message : String(error);
    const key = digest(source);
    if (!skipReasons.has(key)) {
      skipReasons.set(key, message);
      notifySkip?.(`pele-mermaid: this diagram could not be drawn — ${message}`);
    }
    block = undefined;
  }

  renderCache.set(key, block);
  if (renderCache.size > CACHE_LIMIT) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
  return block;
}

/**
 * Pi's built-in Mermaid transformer runs before extension transformers, so with it enabled the
 * fences are already Unicode box art by the time this extension sees them. Turning it off is
 * therefore a prerequisite, not a preference.
 */
function disableBuiltinMermaid(): "changed" | "already" | "failed" {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const path = join(agentDir, "settings.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return "failed";
  }
  const markdown =
    typeof raw.markdown === "object" && raw.markdown !== null
      ? (raw.markdown as Record<string, unknown>)
      : {};
  if (markdown.mermaid === "off") return "already";
  try {
    writeFileSync(
      path,
      `${JSON.stringify({ ...raw, markdown: { ...markdown, mermaid: "off" } }, null, 2)}\n`,
      "utf8",
    );
    return "changed";
  } catch {
    return "failed";
  }
}

/**
 * The row budget in cells.
 *
 * With Unicode placeholders the drawing is ordinary text, so a tall diagram simply scrolls and
 * the configured cap is the only limit. An anchored placement is a single terminal image, which
 * cannot scroll internally: it has to fit the viewport or it gets clipped, so the budget there
 * also follows the terminal height.
 */
function rowBudget(config: PeleConfig): number {
  const configured = config.maxRows;
  if (supportsPlaceholders()) return configured;
  const terminalRows = process.stdout.rows;
  const viewport =
    typeof terminalRows === "number" && terminalRows > 0 ? Math.floor(terminalRows * 0.6) : 0;
  if (configured <= 0) return viewport;
  return viewport > 0 ? Math.min(configured, viewport) : configured;
}

export default function peleMermaid(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;

  installPlacementPass();

  pi.on("session_start", (_event, context) => {
    ctx = context;
    notifySkip = (message: string) => context.ui.notify(message, "warning");
    clearCaches();
    clearPlacements();
    rearmPlacementPass();
    ensureConfigFile((path, content) => {
      try {
        writeFileSync(path, content, "utf8");
      } catch {
        // Defaults still apply when the config cannot be written.
      }
    });
    if (disableBuiltinMermaid() === "changed") {
      context.ui.notify(
        'pele-mermaid: disabled the built-in Mermaid renderer (markdown.mermaid: "off"). Restore that setting and restart Pi to undo.',
        "info",
      );
    }
  });

  pi.on("session_shutdown", () => {
    ctx = undefined;
    clearCaches();
    clearPlacements();
  });

  // The renderer is only useful if the model emits Mermaid, so the guidance travels with it.
  pi.on("before_agent_start", (event) => {
    const config = loadConfig();
    if (!config.enabled || !config.guidance) return;
    const options = event.systemPromptOptions;
    if (!options.promptGuidelines.includes(DIAGRAM_GUIDELINE)) {
      options.promptGuidelines.push(DIAGRAM_GUIDELINE);
    }
    if (options.appendSystemPrompt.includes(DIAGRAM_SECTION)) return;
    options.appendSystemPrompt = options.appendSystemPrompt
      ? `${options.appendSystemPrompt}\n\n${DIAGRAM_SECTION}`
      : DIAGRAM_SECTION;
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    // Most transcript updates contain no diagram; avoid synchronous config I/O there.
    if (!/(?:`{3,}|~{3,})[ \t]*mermaid\b/i.test(markdown)) return markdown;
    const config = loadConfig();
    if (!config.enabled) return markdown;
    if (context.messageType === "assistant-thinking") return markdown;
    if (context.isStreaming && !config.streaming) return markdown;
    const protocol = getCapabilities().images;
    if (protocol === null) return markdown;
    try {
      const appearance = resolveAppearance(config, ctx);
      const background = resolveBackground(config, ctx);
      const available = Math.max(1, Math.floor(context.availableWidth));
      const maxRows = rowBudget(config);
      return replaceFences({
        markdown,
        availableWidth: available,
        place: (source, contentColumns) =>
          renderBlock(source, {
            config,
            appearance,
            background,
            maxRows,
            maxColumns:
              config.maxColumns > 0 ? Math.min(config.maxColumns, contentColumns) : contentColumns,
          }),
      });
    } catch {
      return markdown;
    }
  });

  pi.registerCommand("pele-mermaid", {
    description: "Show Pele Mermaid rendering status and the config path",
    handler: async (_args, context) => {
      const config = loadConfig();
      const extensionCtx = context as unknown as ExtensionContext;
      const appearance = resolveAppearance(config, extensionCtx);
      const background = resolveBackground(config, extensionCtx);
      context.ui.notify(
        [
          `pele-mermaid: ${config.enabled ? "on" : "off"}`,
          `terminal graphics: ${getCapabilities().images ?? "none"}`,
          `mode: ${config.mode} → ${appearance}`,
          `background: ${background} (luminance ${luminance(background).toFixed(3)})`,
          `scale: ${config.scale}x · font: ${config.font}${config.fontMono ? ` / ${config.fontMono}` : ""}`,
          `transport: ${getCapabilities().images === "kitty" ? "RGBA raw + zlib (level 1)" : "PNG"}`,
          `height limits: ${config.maxRows || "unlimited"} rows / ${config.maxHeightPx}px raster`,
          ...(getCapabilities().images === "kitty" && kittyRasterByteLimit() !== undefined
            ? ["decoded raster limit: 16 MiB (Herdr)"]
            : []),
          `render cache: ${renderCache.size}`,
          `config: ${configPath()}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("pele-mermaid-reload", {
    description: "Reload the pele-mermaid config and clear render caches",
    handler: async (_args, context) => {
      clearCaches();
      // Existing Markdown instances retain marker rows in their own cache. Keep those
      // placements alive until the components are replaced, rather than blanking diagrams.
      rearmPlacementPass();
      context.ui.notify("pele-mermaid: config reloaded", "info");
    },
  });
}
