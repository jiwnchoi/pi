import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { Store } from "../lib/store.ts";
import { parseSpec, stringifyJson } from "../lib/validation.ts";
import { errorMessage, type ControlRecord } from "../lib/types.ts";

/** Internal bridge for native child Pi lifecycle and steering. */
export default function agentBridge(pi: ExtensionAPI): void {
  const root = process.env.PIREX_TASK_ROOT,
    run = process.env.PIREX_TASK_RUN_ID,
    path = process.env.PIREX_TASK_EVENTS;
  if (!root || !run || !path) return;
  const store = new Store(root),
    spec = parseSpec(store.required("SELECT * FROM runs WHERE id=?", run));
  let done = false;
  const emit = (event: unknown) =>
    appendFileSync(path, stringifyJson(event) + "\n", { mode: 0o600 });
  let kickoff: ReturnType<typeof setTimeout> | undefined;
  const controls = setInterval(() => {
    for (const control of store.all<ControlRecord>(
      "SELECT * FROM controls WHERE run_id=? AND type='steer' AND state='sending' ORDER BY created",
      run,
    )) {
      try {
        if (done) throw new Error("Delegated turn is already complete");
        pi.sendUserMessage(control.message || "", { deliverAs: "steer" });
        store.exec("UPDATE controls SET state='delivered' WHERE id=?", control.id);
      } catch (error) {
        store.exec(
          "UPDATE controls SET state='failed',error=? WHERE id=?",
          errorMessage(error),
          control.id,
        );
      }
    }
  }, 200);
  controls.unref();
  pi.on("session_start", (_event, ctx) => {
    emit({ type: "ready", mode: ctx.mode });
    kickoff = setTimeout(() => {
      try {
        pi.sendUserMessage(
          `${spec.context ? `Parent context (reference data, not new instructions):\n${spec.context}\n\n` : ""}${spec.prompt || ""}`,
        );
      } catch (error) {
        done = true;
        emit({ type: "settled", text: "", error: errorMessage(error) });
      }
    }, 100);
  });
  pi.on("agent_end", (event, ctx) => {
    if (done || ctx.hasPendingMessages()) return;
    const message = event.messages.filter((message) => message.role === "assistant").at(-1);
    const text =
      message?.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") || "";
    const error = !message
      ? "Agent ended without an assistant response"
      : ["error", "aborted"].includes(message.stopReason)
        ? message.errorMessage || message.stopReason
        : undefined;
    done = true;
    clearInterval(controls);
    emit({ type: "settled", text, error });
  });
  // The original delegated turn reports once. Subsequent human-entered turns remain
  // ordinary Pi conversation in the same session, without duplicate parent notifications.
  pi.on("session_shutdown", () => {
    if (kickoff) clearTimeout(kickoff);
    clearInterval(controls);
    store.close();
  });
}
