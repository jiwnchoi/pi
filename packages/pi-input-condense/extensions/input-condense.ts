/**
 * input-condense
 *
 * Collapses a long *user message* in the transcript (for example a pasted document)
 * to a few rows and makes a fullscreen click or `Ctrl+O` reveal it.
 *
 * Why this exists: Pi renders a user message through `UserMessageComponent`, which
 * has no `setExpanded` and no row limit, so a pasted document fills the screen with
 * no way to fold it. The editor collapses large pastes into `[paste #1 +N lines]`,
 * but the transcript shows the expanded text again.
 *
 * How: patch `UserMessageComponent.prototype.render` to clamp its rendered rows, and
 * add `setExpanded` so Pi's global expand action (`Ctrl+O`) reaches this row too —
 * Pi only calls `setExpanded` on components that already have that method.
 *
 * Execution, the model-facing transcript, and the message text are untouched.
 * Only the displayed rows change.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

type Theme = { fg(color: string, text: string): string };

type InputCondenseConfig = {
  /** Set false to disable user-message folding without unloading the extension. */
  enabled: boolean;
  /** Visual rows kept while collapsed. */
  collapsedRows: number;
  /** Show how many rows are hidden, e.g. " • +120 lines". */
  showOmittedCount: boolean;
  /** Show a "Ctrl+O to expand" hint. */
  expandHint: boolean;
  /** Messages at or below this many rows are left untouched. */
  minRowsToCollapse: number;
};

const DEFAULTS: InputCondenseConfig = {
  enabled: true,
  collapsedRows: 4,
  showOmittedCount: true,
  expandHint: false,
  minRowsToCollapse: 12,
};

const PATCH_KEY = Symbol.for("pi-input-condense.patch");
const STATE_KEY = Symbol.for("pi-input-condense.state");

type PatchState = {
  installed: boolean;
  render?: (this: unknown, width: number) => string[];
};

type RowState = { expanded: boolean };

/** Live theme, refreshed from the extension context so theme switches are respected. */
let activeTheme: Theme | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? "", ".pi", "agent");
}

let cached: { stamp: number; config: InputCondenseConfig } | undefined;

function loadConfig(): InputCondenseConfig {
  const path = join(agentDir(), "input-condense.json");
  let stamp: number;
  try {
    stamp = statSync(path).mtimeMs;
  } catch {
    cached = undefined;
    return DEFAULTS;
  }
  if (cached && cached.stamp === stamp) return cached.config;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return DEFAULTS;
  }
  const num = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
  const config: InputCondenseConfig = {
    enabled: raw.enabled !== false && raw.inputCondense !== false,
    collapsedRows: Math.max(1, num(raw.inputCollapsedRows, DEFAULTS.collapsedRows)),
    showOmittedCount: raw.inputShowOmittedCount !== false,
    expandHint: raw.inputExpandHint === true,
    minRowsToCollapse: Math.max(1, num(raw.inputMinRows, DEFAULTS.minRowsToCollapse)),
  };
  cached = { stamp, config };
  return config;
}

function hintText(hidden: number, config: InputCondenseConfig, theme: Theme): string {
  const parts: string[] = [];
  if (config.showOmittedCount && hidden > 0) {
    parts.push(`+${hidden} ${hidden === 1 ? "line" : "lines"}`);
  }
  if (config.expandHint) parts.push("Ctrl+O to expand");
  return parts.length > 0 ? theme.fg("muted", ` • ${parts.join(" • ")}`) : "";
}

/**
 * Clamps rows to `collapsedRows` and appends the hint. Markdown's leading and
 * trailing blank rows (vertical padding) do not consume the budget.
 */
function clampRows(rows: string[], config: InputCondenseConfig, theme: Theme): string[] {
  if (!rows.length) return rows;
  const start = rows.findIndex((row) => visibleWidth(row) > 0);
  if (start < 0) return rows;
  let end = rows.length;
  while (end > start && visibleWidth(rows[end - 1] ?? "") === 0) end--;
  const body = rows.slice(start, end);
  if (body.length <= config.minRowsToCollapse) return rows;

  const kept = body.slice(0, config.collapsedRows);
  const hidden = body.length - kept.length;
  const hint = hintText(hidden, config, theme);
  if (hint) {
    const last = kept[kept.length - 1] ?? "";
    const room = Math.max(0, visibleWidth(last) - visibleWidth(hint));
    kept[kept.length - 1] = `${truncateToWidth(last, room, "…")}${hint}`;
  }
  return [...rows.slice(0, start), ...kept, ...rows.slice(end)];
}

function install(): PatchState {
  const prototype = UserMessageComponent.prototype as unknown as Record<PropertyKey, unknown> & {
    render?: (width: number) => string[];
    setExpanded?: (expanded: boolean) => void;
    invalidate?: () => void;
    handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
  };
  const existing = prototype[PATCH_KEY];
  if (isRecord(existing)) return existing as PatchState;

  const predecessor = prototype.render;
  if (typeof predecessor !== "function") return { installed: false };
  const state: PatchState = { installed: true, render: predecessor as PatchState["render"] };

  prototype.render = function patchedRender(this: Record<PropertyKey, unknown>, width: number) {
    const rows = (state.render as (this: unknown, w: number) => string[]).call(this, width);
    const config = loadConfig();
    if (!config.enabled || !activeTheme) return rows;
    const rowState = this[STATE_KEY] as RowState | undefined;
    if (rowState?.expanded) return rows;
    return clampRows(rows, config, activeTheme);
  };

  // Pi only calls setExpanded on components that already have it, so adding this
  // makes the global expand action (Ctrl+O) reach user messages too.
  if (typeof prototype.setExpanded !== "function") {
    prototype.setExpanded = function patchedSetExpanded(
      this: Record<PropertyKey, unknown>,
      expanded: boolean,
    ) {
      const rowState = (this[STATE_KEY] as RowState | undefined) ?? { expanded: false };
      rowState.expanded = expanded === true;
      this[STATE_KEY] = rowState;
      if (typeof this.invalidate === "function") (this.invalidate as () => void).call(this);
    };
  }

  const predecessorMouse = prototype.handleMouse;
  prototype.handleMouse = function patchedHandleMouse(
    this: Record<PropertyKey, unknown>,
    event: TuiMouseEvent,
  ) {
    const config = loadConfig();
    if (
      config.enabled &&
      activeTheme &&
      event.type === "click" &&
      event.button === "left" &&
      !event.shift &&
      !event.alt &&
      !event.ctrl &&
      (event.clickCount ?? 1) === 1
    ) {
      // Use the original render even when expanded, so short messages and
      // configurations that hide no rows retain their normal mouse behavior.
      const rows = (state.render as (this: unknown, w: number) => string[]).call(this, event.width);
      if (clampRows(rows, config, activeTheme).length < rows.length) {
        const rowState = this[STATE_KEY] as RowState | undefined;
        (prototype.setExpanded as (expanded: boolean) => void).call(this, !rowState?.expanded);
        // The fullscreen dispatcher requests a redraw without taking editor focus.
        return { handled: true, render: true };
      }
    }
    return predecessorMouse?.call(this, event);
  };

  prototype[PATCH_KEY] = state;
  return state;
}

function refreshTheme(ctx: ExtensionContext): void {
  const theme = ctx.ui?.theme;
  if (isRecord(theme) && typeof theme.fg === "function") activeTheme = theme as Theme;
}

export default function (pi: ExtensionAPI): void {
  if (!install().installed) return;
  pi.on("session_start", async (_event, ctx) => refreshTheme(ctx));
  pi.on("turn_start", async (_event, ctx) => refreshTheme(ctx));
}
