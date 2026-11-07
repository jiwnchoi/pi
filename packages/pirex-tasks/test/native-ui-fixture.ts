// Test-only explicit extension: intercept every prompt before any provider/LLM call.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { stringifyJson } from "../lib/validation.ts";
export default function nativeUIFixture(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => {
    appendFileSync(process.env.PIREX_TASK_EVENTS! + ".inputs", event.text + "\n", { mode: 0o600 });
    if (ctx.mode !== "tui") throw new Error("Expected the real interactive Pi TUI");
    ctx.ui.notify("NATIVE_UI_PROBE", "info");
    pi.sendMessage({
      customType: "native-scroll-probe",
      display: true,
      content: Array.from(
        { length: 160 },
        (_, index) =>
          `SCROLL_PROBE_LINE_${String(index + 1).padStart(3, "0")} native transcript content`,
      ).join("\n"),
    });
    appendFileSync(
      process.env.PIREX_TASK_EVENTS!,
      stringifyJson({
        type: "settled",
        text: "native TUI ready; input intercepted without a model call",
      }) + "\n",
      { mode: 0o600 },
    );
    return { action: "handled" };
  });
}
