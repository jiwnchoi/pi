/** Local vector snapshots. OSC 8 links let Pi/terminal launch the OS default image handler. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Snapshots persist across reload/session changes so scrollback links remain valid. */
export function saveSnapshot(svg: string): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const directory = join(agentDir, "cache", "pele-mermaid");
  const digest = createHash("sha256").update(svg).digest("hex").slice(0, 32);
  const path = join(directory, `${digest}.svg`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(path, svg, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return pathToFileURL(path).href;
  } catch {
    // Snapshot storage must never prevent the diagram from rendering.
    return undefined;
  }
}

/** Fullscreen Pi opens on click via `open` on macOS; regular terminals own modifier-click. */
export function linkImageLines(
  lines: string[],
  url: string | undefined,
  left: number,
  placeholders: boolean,
): string[] {
  if (!url) return lines;
  const start = `\x1b]8;;${url}\x1b\\`;
  const end = "\x1b]8;;\x1b\\";
  if (placeholders) return lines.map((line) => `${start}${line}${end}`);
  // Anchored image rows must remain genuinely blank for Pi's reservation scanner. A small
  // link below the image is reliable on these terminals; filling the blanks breaks scrolling.
  return [...lines, `${" ".repeat(left)}${start}열기${end}`];
}
