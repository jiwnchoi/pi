/**
 * Terminal width measurement.
 *
 * `process.stdout.columns` is only populated when stdout is a TTY, and it lags behind a resize
 * until the next `SIGWINCH`. A stale width produces a PNG that is wider than the transcript, so
 * the drawing gets clipped. This module resolves the width from the most trustworthy source and
 * falls back to a query of the controlling terminal.
 */
import { execFileSync } from "node:child_process";

/** Width assumed when nothing reports a size. 80 is the conventional terminal default. */
const FALLBACK_COLUMNS = 80;

let cached: { columns: number; at: number } | undefined;
const CACHE_MS = 250;

/**
 * Columns the terminal is currently showing.
 *
 * Order: an explicit override, then the live TTY size, then `tput`/`stty` on the controlling
 * terminal. The result is cached briefly because this is called for every streaming delta.
 */
export function terminalColumns(env: NodeJS.ProcessEnv = process.env): number {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.columns;

  const override = Number(env.PELE_MERMAID_COLUMNS);
  let columns = 0;

  if (Number.isFinite(override) && override >= 8) {
    columns = Math.floor(override);
  }

  if (columns === 0) {
    const live = process.stdout.columns;
    if (typeof live === "number" && Number.isFinite(live) && live >= 8) columns = Math.floor(live);
  }

  if (columns === 0) columns = querySize(env) ?? FALLBACK_COLUMNS;

  cached = { columns, at: now };
  return columns;
}

/** Asks the controlling terminal for its size. Returns undefined when unavailable. */
function querySize(env: NodeJS.ProcessEnv): number | undefined {
  const candidates: Array<[string, string[]]> = [
    ["stty", ["size"]],
    ["tput", ["cols"]],
  ];
  for (const [command, args] of candidates) {
    try {
      const output = execFileSync(command, args, {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
        env,
      }).trim();
      // `stty size` prints "ROWS COLS"; `tput cols` prints just the column count.
      const parts = output.split(/\s+/).map(Number);
      const value = parts.length === 2 ? parts[1] : parts[0];
      if (typeof value === "number" && Number.isFinite(value) && value >= 8)
        return Math.floor(value);
    } catch {
      // Try the next source.
    }
  }
  return undefined;
}

/** Drops the cached size so the next call re-reads the terminal. */
export function invalidateTerminalColumns(): void {
  cached = undefined;
}
