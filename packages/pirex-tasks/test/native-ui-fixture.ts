// Test-only explicit extension: intercept every prompt before any provider/LLM call.
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { stringifyJson } from "../lib/validation.ts";
export default function nativeUIFixture(pi: ExtensionAPI): void {
  pi.on("input", (event, ctx) => {
    const events = process.env.PIREX_TASK_EVENTS || process.env.PIREX_TEST_EVENTS;
    if (!events) throw new Error("Native UI fixture event path missing");
    appendFileSync(events + ".inputs", event.text + "\n", { mode: 0o600 });
    if (ctx.mode !== "tui") throw new Error("Expected the real interactive Pi TUI");
    ctx.ui.notify("NATIVE_UI_PROBE", "info");
    if (process.env.PIREX_TASK_EVENTS)
      (ctx.sessionManager as SessionManager).appendMessage({
        role: "assistant",
        content: [
          { type: "text", text: "native TUI ready; fixture response without a model call" },
        ],
        api: "anthropic-messages",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    pi.sendMessage({
      customType: "native-scroll-probe",
      display: true,
      content: Array.from(
        { length: 160 },
        (_, index) =>
          `SCROLL_PROBE_LINE_${String(index + 1).padStart(3, "0")} native transcript content`,
      ).join("\n"),
    });
    if (process.env.PIREX_TASK_EVENTS)
      appendFileSync(
        events,
        stringifyJson({
          type: "settled",
          text: "native TUI ready; input intercepted without a model call",
        }) + "\n",
        { mode: 0o600 },
      );
    return { action: "handled" };
  });
}
