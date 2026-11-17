import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, Text, VStack, matchesKey } from "@earendil-works/pi-tui";
import { readBounded, sanitize } from "../lib/runtime.ts";
import type { TaskRecord } from "../lib/types.ts";
import { oneLine, stateLabel } from "./presentation.ts";

export function taskLogView(
  title: string,
  output: string,
  footer: string,
  height: number,
  theme: Pick<Theme, "fg">,
  done: () => void,
) {
  const scroll = new ScrollView(new Text(sanitize(output) || "(No output)", 0, 0), {
    follow: "end",
    overscroll: "contain",
    scrollbar: "always",
  });
  const view = new VStack([
    { component: new Text(theme.fg("accent", oneLine(title)), 0, 0), basis: 2, shrink: 0 },
    { component: scroll, basis: height, shrink: 1, minSize: 1 },
    { component: new Text(theme.fg("dim", footer), 0, 0), basis: 2, shrink: 0 },
  ]);
  return Object.assign(view, {
    handleInput(data: string) {
      if (matchesKey(data, "escape") || data === "q") done();
      else if (matchesKey(data, "up")) scroll.scrollBy(-1);
      else if (matchesKey(data, "down")) scroll.scrollBy(1);
      else if (matchesKey(data, "pageUp")) scroll.scrollBy(-Math.max(1, scroll.viewportHeight));
      else if (matchesKey(data, "pageDown")) scroll.scrollBy(Math.max(1, scroll.viewportHeight));
      else if (matchesKey(data, "home")) scroll.scrollToStart();
      else if (matchesKey(data, "end")) scroll.scrollToEnd();
    },
  });
}

export async function showTaskLog(ctx: ExtensionContext, row: TaskRecord): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Use task_logs or task_result outside interactive Pi");
  const output = readBounded(row.result_path || row.log_path, 51200);
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      taskLogView(
        `${stateLabel(row.state)} · ${row.name}`,
        output.text,
        `↑↓ scroll · PgUp/PgDn · Home/End · Esc close${output.truncated ? " · last 50 KiB; full output: " + output.path : ""}`,
        Math.max(3, Math.floor(tui.terminal.rows * 0.7) - 4),
        theme,
        done,
      ),
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
  );
}
