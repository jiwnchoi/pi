/**
 * Minimal one-line tool rows with a state indicator and syntax-highlighted output.
 *
 * Zentui's Tool display owns `write`, `edit`, and `bash` (diffs, previews, line
 * counts), so this extension leaves those alone and covers the tools it does not
 * own: `read`, `grep`, `find`, `ls`, `codemode`, and the web tools.
 *
 * Collapsed rows are exactly one line — `● path · 4 lines` — with no result body
 * and no background box. `renderShell: "self"` keeps pi from wrapping the row in a
 * themed `Box`, which is what painted the background and padding before. Ctrl+O (or
 * a click) expands the same row to the full, untruncated result, highlighted by the
 * file's language when the call names one.
 *
 * A click works while the row is still streaming arguments or running, not only after it
 * settles: the card opens on the full source first, and a click on the output hint opens
 * the output underneath it.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import {
  Box,
  MouseRegion,
  Text,
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** Tools this extension draws. Absent names are left to zentui or pi's native row. */
const TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "ffgrep",
  "find",
  "fffind",
  "ls",
  "codemode",
  "bash",
  "web_search",
  "fetch_content",
  "get_search_content",
  "tool_search",
]);

/**
 * The leading dot that replaces the old per-tool emoji anchor. Shape carries the state as well
 * as color, so a running row is a hollow ring and a settled one is filled — readable in a
 * monochrome terminal or for anyone who cannot separate the green from the red.
 */
const INDICATORS: Readonly<Record<RowStatus, { glyph: string; color: "success" | "error" | "warning" }>> = {
  running: { glyph: "○", color: "warning" },
  success: { glyph: "●", color: "success" },
  error: { glyph: "●", color: "error" },
};

type RowStatus = "running" | "success" | "error";

function indicator(status: RowStatus, theme: ThemeLike): string {
  const { glyph, color } = INDICATORS[status];
  return theme.fg(color, glyph);
}

/** pi's search tools print one of these instead of a list when nothing matched. */
const EMPTY_RESULT = /^(?:No matches found|No files found|No matching tools found|\(empty directory\))\s*$/i;

type ThemeLike = Theme;

/**
 * One rendered line, cut to the viewport width. `Text` wraps, which would turn a long command into
 * several header rows inside the card; the header must stay the same single line the collapsed row
 * draws.
 */
class TruncatedLine implements Component {
  constructor(private readonly line: string) {}

  render(width: number): string[] {
    return [truncateToWidth(this.line, Math.max(1, width), "…")];
  }

  invalidate(): void {}
}

/**
 * One row's view: the collapsed one-liner, or the expanded card with its children already built.
 * The output hint inside a card is its own click target, so clicking it opens the output without
 * collapsing the card.
 */
type View =
  | { kind: "collapsed"; line: string }
  | { kind: "card"; children: Component[]; bg: (line: string) => string };

/**
 * One transcript row: either the single collapsed line or the expanded card, inside one
 * `Box(2, 1)` background, which is the padding and framing pi gives `edit`/`write` diff rows.
 *
 * pi hands this same component back as `lastComponent` per slot, so both views must come from one
 * class rather than two. The call slot and the result slot each keep their own instance but share
 * the row's state, and `gate` keeps exactly one of them drawing: the call slot draws while no
 * result exists (arguments streaming, tool running), the result slot once there is one.
 */
class RowCard implements Component {
  private box?: Box;
  private collapsed?: string;
  private gate?: () => boolean;
  private hidden = true;
  private onClick?: () => void;
  private paddingX = 2;

  setGate(gate: () => boolean): void {
    this.gate = gate;
  }

  setOnClick(onClick: () => void): void {
    this.onClick = onClick;
  }

  /** One line, no card, no background: the collapsed row. */
  showCollapsed(line: string): void {
    this.hidden = false;
    this.collapsed = line;
    this.box = undefined;
  }

  /** The expanded card: header, source, output hint and output inside one padded box. */
  showCard(children: Component[], bg: (line: string) => string): void {
    this.hidden = false;
    this.collapsed = undefined;
    const box = new Box(this.paddingX, 1, bg);
    for (const child of children) box.addChild(child);
    this.box = box;
  }

  private visible(): boolean {
    if (this.hidden) return false;
    return this.gate ? this.gate() : true;
  }

  invalidate(): void {
    this.box?.invalidate();
  }

  render(width: number): string[] {
    if (!this.visible()) return [];
    if (this.collapsed !== undefined) {
      const indent = " ".repeat(this.paddingX);
      return [indent + truncateToWidth(this.collapsed, Math.max(1, width - this.paddingX), "…")];
    }
    return this.box ? this.box.render(width) : [];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // pi's row regions only toggle once a result exists, so a running row would ignore clicks.
    // Owning the click here is what lets a call be opened while its arguments still stream.
    if (!this.visible()) return undefined;
    const routed = this.box?.handleMouse(event);
    if (routed) return routed;
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.onClick?.();
    return { handled: true };
  }
}

/** Display level of a row: the one-liner, the card with the source, the card with the output too. */
type Level = 0 | 1 | 2;

/** Per-row scratch space; pi shares one object across a row's render calls. */
type RowState = {
  /** Current level. Undefined until the first render, which seeds it from pi's expand flag. */
  level?: Level;
  /** pi's global expand flag as of the last render, so Ctrl+O still moves every row. */
  lastExpanded?: boolean;
  /** Set once a result exists; from then on the result slot draws the row, not the call slot. */
  hasResult?: boolean;
  status?: RowStatus;
  /** The right half of the one-liner: line counts, `failed`, or `…` while running. */
  summary?: string;
  /** Result text as of the latest render, so the card can show it or hold it behind a hint. */
  output?: string;
  isError?: boolean;
};

type RenderContextLike = {
  args: unknown;
  lastComponent: unknown;
  state: RowState;
  cwd: string;
  expanded: boolean;
  isError: boolean;
  outputPad: number;
  invalidate: () => void;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** pi types tool arguments as `unknown`; every row here reads them by key. */
function asArgs(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function resultText(result: { content?: Array<{ type?: unknown; text?: unknown }> }): string {
  const parts: string[] = [];
  for (const block of result.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trimEnd();
}

/** Shorten a path without losing the file name. */
function shortPath(path: string, cwd: string): string {
  const home = process.env.HOME;
  let display = path;
  if (home && path.startsWith(`${home}/`)) display = `~${path.slice(home.length)}`;
  else if (path.startsWith(`${cwd}/`)) display = path.slice(cwd.length + 1);
  return display;
}

/** What the call targets, without the outcome: the left half of the row. */
function callLabel(toolName: string, args: Record<string, unknown>, cwd: string): string {
  switch (toolName) {
    case "read": {
      const path = str(args.path);
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const range =
        offset !== undefined || limit !== undefined
          ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
          : "";
      return path ? `${shortPath(path, cwd)}${range}` : "read";
    }
    case "grep":
    case "ffgrep": {
      const pattern = str(args.pattern);
      const path = str(args.path);
      const glob = str(args.glob);
      return `${pattern ? `/${pattern}/` : "grep"}${path ? ` ${shortPath(path, cwd)}` : ""}${glob ? ` --glob ${glob}` : ""}`;
    }
    case "find":
    case "fffind": {
      const pattern = str(args.pattern);
      const path = str(args.path);
      return `${pattern ?? "find"}${path ? ` ${shortPath(path, cwd)}` : ""}`;
    }
    case "ls": {
      const path = str(args.path);
      return path ? shortPath(path, cwd) : cwd;
    }
    case "web_search": {
      const query = str(args.query) ?? (Array.isArray(args.queries) ? str(args.queries[0]) : undefined);
      return query ?? "search";
    }
    case "tool_search": {
      const query = str(args.query);
      return query ? `/${query}/` : "tool_search";
    }
    case "bash": {
      const command = str(args.command);
      if (!command) return "bash";
      // One line: the first command line, plus a marker when more follows.
      const lines = command.split("\n").map((line) => line.trim()).filter(Boolean);
      const first = lines[0] ?? "bash";
      return lines.length > 1 ? `${first} …` : first;
    }
    case "codemode": {
      const code = str(args.code);
      if (!code) return "codemode";
      // The first meaningful statement, so the row says what the script does.
      const first = code
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("//"));
      return first ?? "codemode";
    }
    default:
      return toolName;
  }
}

/** The right half of the row: a stat that fits in the same line. */
function outcomeSummary(toolName: string, text: string, isError: boolean): string | undefined {
  if (isError) return "failed";
  if (!text) return undefined;
  if (EMPTY_RESULT.test(text.trim())) return "no results";
  const lines = text.split("\n");
  const listed = lines.filter((line) => line.trim().length > 0).length;
  switch (toolName) {
    case "grep":
    case "ffgrep":
    case "find":
    case "fffind":
      return `${listed} ${listed === 1 ? "match" : "matches"}`;
    case "ls":
      return `${listed} ${listed === 1 ? "entry" : "entries"}`;
    case "read":
      return `${lines.length} ${lines.length === 1 ? "line" : "lines"}`;
    case "bash": {
      const count = lines.length;
      return `${count} ${count === 1 ? "line" : "lines"}`;
    }
    case "codemode": {
      const count = lines.length;
      return `${count} ${count === 1 ? "line" : "lines"}`;
    }
    case "tool_search": {
      // The result lists one `- <tool>: <description>` line per loaded tool.
      const loaded = lines.filter((line) => line.startsWith("- ")).length;
      return `${loaded} ${loaded === 1 ? "tool" : "tools"}`;
    }
    default:
      return undefined;
  }
}

/**
 * Highlight result text when the call names a file with a known language. Output
 * without a language stays plain, so prose is never miscolored.
 */
function highlightResult(text: string, args: Record<string, unknown>, theme: ThemeLike): string {
  const path = str(args.path) ?? str(args.file_path);
  const lang = path ? getLanguageFromPath(path) : undefined;
  if (!lang) return text.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
  return highlightCode(text, lang).join("\n");
}

/**
 * The row's headline: `<indicator> <source>`. The source is highlighted in its own language,
 * so a shell command or JS snippet reads like code rather than one flat title color. Used by
 * both the collapsed one-liner and the expanded card's header.
 */
function headline(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  status: RowStatus,
  theme: ThemeLike,
): string {
  const dot = indicator(status, theme);
  const source =
    toolName === "bash"
      ? firstLine(str(args.command))
      : toolName === "codemode"
        ? firstLine(str(args.code))
        : undefined;

  if (!source) return `${dot} ${theme.fg("toolTitle", callLabel(toolName, args, cwd))}`;
  const lang = toolName === "bash" ? "bash" : "javascript";
  const highlighted = highlightCode(source, lang)[0] ?? source;
  return `${dot} ${highlighted}`;
}

/**
 * The settled one-line row: `<headline> · <summary>`.
 */
function collapsedLine(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  summary: string | undefined,
  status: RowStatus,
  theme: ThemeLike,
): string {
  const head = headline(toolName, args, cwd, status, theme);
  return summary ? `${head} ${theme.fg("muted", `· ${summary}`)}` : head;
}

/** First meaningful line of a script, so one row can show what it does. */
function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const first = lines.find((line) => !line.startsWith("//") && !line.startsWith("#")) ?? lines[0];
  return lines.length > 1 && first ? `${first} …` : first;
}

/** The program a tool runs, when the row can show its source above the output. */
function sourceOf(
  toolName: string,
  args: Record<string, unknown>,
): { text: string; lang: string; label: string } | undefined {
  if (toolName === "bash") {
    const command = str(args.command);
    return command ? { text: command, lang: "bash", label: "command" } : undefined;
  }
  if (toolName === "codemode") {
    // codemode runs JavaScript in pi's QuickJS sandbox.
    const code = str(args.code);
    return code ? { text: code, lang: "javascript", label: "script" } : undefined;
  }
  return undefined;
}

/** Collapse the card, or open it on the source. The header line always toggles this. */
function toggleBody(state: RowState, invalidate: () => void): void {
  state.level = (state.level ?? 0) === 0 ? 1 : 0;
  invalidate();
}

/** Open the output under an already open source, or put it back behind the hint line. */
function toggleOutput(state: RowState, invalidate: () => void): void {
  state.level = (state.level ?? 0) >= 2 ? 1 : 2;
  invalidate();
}
/**
 * Follow pi's global expand flag (Ctrl+O) without fighting a row's own clicks: the level only moves
 * when the flag actually flips, so a row someone clicked open stays open across re-renders.
 *
 * Expanded through the flag means the full row, output included, which is also what an HTML export
 * renders for its expanded view. A click opens one step at a time instead.
 */
function syncExpanded(state: RowState, expanded: boolean): void {
  if (state.level === undefined) state.level = expanded ? 2 : 0;
  else if (state.lastExpanded !== undefined && state.lastExpanded !== expanded) {
    state.level = expanded ? 2 : 0;
  }
  state.lastExpanded = expanded;
}

function lineCount(text: string): string {
  const count = text.split("\n").length;
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

/**
 * The expanded card: the same line as the collapsed row, then the source, then either the output or
 * one clickable hint that opens it. A tool with no source opens straight onto its output.
 */
function cardView(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  state: RowState,
  theme: ThemeLike,
  invalidate: () => void,
): View {
  const level = state.level ?? 0;
  const status = state.status ?? "running";
  const output = state.output ?? "";
  const source = sourceOf(toolName, args);

  const children: Component[] = [
    new TruncatedLine(collapsedLine(toolName, args, cwd, state.summary, status, theme)),
  ];

  if (source) {
    children.push(new Text("", 0, 0));
    children.push(new Text(theme.fg("muted", source.label), 0, 0));
    children.push(new Text(highlightCode(source.text, source.lang).join("\n"), 0, 0));
  }

  // Without a source there is no second level to open: the card already is the output. A failed
  // call opens its error too, since that is what the reader opened the row for.
  const outputOpen = !source || level >= 2 || state.isError;
  if (output && outputOpen) {
    children.push(new Text("", 0, 0));
    children.push(new Text(theme.fg("muted", state.isError ? "error" : "output"), 0, 0));
    const body = state.isError ? theme.fg("error", output) : highlightResult(output, args, theme);
    children.push(new Text(body, 0, 0));
  } else if (output) {
    // One clickable line keeps a long source readable until the output is asked for.
    const hint = `▸ output · ${lineCount(output)} · click to show`;
    children.push(new Text("", 0, 0));
    children.push(
      new MouseRegion(new Text(theme.fg("muted", hint), 0, 0), (event) => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        toggleOutput(state, invalidate);
        return { handled: true };
      }),
    );
  } else if (status === "running") {
    children.push(new Text("", 0, 0));
    children.push(new Text(theme.fg("muted", "running…"), 0, 0));
  }

  // pi picks `toolErrorBg` itself, but only for a shell it owns. With `renderShell: "self"`
  // it wraps our output in a plain Container, so the card's background is ours to choose —
  // otherwise a failed call paints green behind a red indicator.
  const bg =
    status === "error" ? "toolErrorBg" : status === "running" ? "toolPendingBg" : "toolSuccessBg";
  return { kind: "card", children, bg: (line: string) => theme.bg(bg, line) };
}

/** What the row draws right now: the one-liner until it is opened, the card after. */
function viewFor(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  state: RowState,
  theme: ThemeLike,
  invalidate: () => void,
): View {
  if ((state.level ?? 0) === 0) {
    const status = state.status ?? "running";
    const summary = state.summary ?? (status === "running" ? "…" : undefined);
    return {
      kind: "collapsed",
      line: collapsedLine(toolName, args, cwd, summary, status, theme),
    };
  }
  return cardView(toolName, args, cwd, state, theme, invalidate);
}

/** Draw a view into a row component, reusing the instance pi handed back. */
function applyView(component: RowCard, view: View): void {
  if (view.kind === "collapsed") component.showCollapsed(view.line);
  else component.showCard(view.children, view.bg);
}

export default function toolRows(pi: ExtensionAPI): void {
  // `registerToolRenderer` was added in pi 1.4.0. Older managed installs (1.0.x) do not
  // expose it, and throwing here aborts the whole pi process before the first turn.
  const register = (pi as unknown as { registerToolRenderer?: unknown }).registerToolRenderer;
  if (typeof register !== "function") {
    if (process.env.PI_DEBUG) {
      console.error("tool-rows: pi.registerToolRenderer is unavailable; skipping custom tool rows");
    }
    return;
  }

  pi.registerToolRenderer((toolName, next) => {
    if (!TOOLS.has(toolName)) return next();

    return {
      // No themed Box around the row: no background, no padding.
      renderShell: "self" as const,

      renderCall(args: unknown, theme: ThemeLike, context: RenderContextLike) {
        const state = context.state;
        const callArgs = asArgs(args);
        syncExpanded(state, context.expanded);

        // While a row has no result yet — arguments still streaming, or the tool running — this
        // slot is the only one pi renders, so it draws the row and keeps the full source
        // reachable. The gate turns it off as soon as the result slot takes over.
        const component = (context.lastComponent as RowCard | undefined) ?? new RowCard();
        component.setGate(() => state.hasResult !== true);
        component.setOnClick(() => toggleBody(state, context.invalidate));
        applyView(
          component,
          viewFor(
            toolName,
            callArgs,
            context.cwd,
            state,
            theme,
            context.invalidate,
          ),
        );
        return component;
      },

      renderResult(
        result: { content?: Array<{ type?: unknown; text?: unknown }>; isError?: boolean },
        options: { expanded: boolean; isPartial: boolean },
        theme: ThemeLike,
        context: RenderContextLike,
      ) {
        const state = context.state;
        const resultArgs = asArgs(context.args);
        const text = resultText(result);
        const isError = result.isError === true || context.isError === true;

        // From the first partial result on, this slot draws the row: the call slot's gate reads
        // `hasResult` when it renders, which happens after this method, so the row is never
        // drawn twice and it stays visible while the tool is still working.
        state.hasResult = true;
        state.output = text;
        state.isError = isError;
        state.status = options.isPartial ? "running" : isError ? "error" : "success";
        state.summary = options.isPartial
          ? "…"
          : isError
            ? "failed"
            : outcomeSummary(toolName, text, isError);
        syncExpanded(state, context.expanded);

        const component = (context.lastComponent as RowCard | undefined) ?? new RowCard();
        component.setOnClick(() => toggleBody(state, context.invalidate));
        applyView(
          component,
          viewFor(
            toolName,
            resultArgs,
            context.cwd,
            state,
            theme,
            context.invalidate,
          ),
        );
        return component;
      },
    };
  });
}
