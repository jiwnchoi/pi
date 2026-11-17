import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import agentBridge from "../runner/agent-bridge.ts";
import { Runtime, readBounded } from "../lib/runtime.ts";
import { loadConfig } from "../lib/config.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function bridge() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), "pirex-bridge-"));
  const runtime = new Runtime(root, "owner", loadConfig(root, false, root), {
    session: "test",
    cwd: root,
    provider: "current",
    model: "current-model",
    thinking: "max",
  });
  const task = runtime.submit("agent", {
    name: "Agent",
    prompt: "Delegated prompt",
    explicitRequest: true,
  });
  const events = join(dirname(task.outputPath), "events.jsonl");
  vi.stubEnv("PIREX_TASK_ROOT", root);
  vi.stubEnv("PIREX_TASK_RUN_ID", task.runId);
  vi.stubEnv("PIREX_TASK_EVENTS", events);
  const on = vi.fn();
  const setModel = vi.fn(async () => true);
  const setThinkingLevel = vi.fn();
  const sendUserMessage = vi.fn();
  const pi = { on, setModel, setThinkingLevel, sendUserMessage } as unknown as ExtensionAPI;
  agentBridge(pi);
  const handler = (name: string) =>
    on.mock.calls.find(([event]) => event === name)![1] as (
      event: unknown,
      ctx: ExtensionContext,
    ) => Promise<void>;
  const ctx = {
    mode: "tui",
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    model: { provider: "saved", id: "saved-model" },
    modelRegistry: { find: vi.fn(() => ({ provider: "current", id: "current-model" })) },
  } as unknown as ExtensionContext;
  cleanups.push(() => {
    void handler("session_shutdown")({}, ctx);
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { runtime, task, events, handler, ctx, setModel, setThinkingLevel, sendUserMessage };
}

describe("child startup settings", () => {
  it("reports final settlement once without shutting down a Pi that may still be visible", async () => {
    const { events, handler, ctx } = bridge();
    await handler("session_start")({}, ctx);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Saved final result" }],
      stopReason: "stop",
    };
    await handler("agent_end")({ messages: [message] }, ctx);
    expect(readBounded(events).text).not.toContain('"type":"settled"');
    await handler("agent_settled")({}, ctx);
    expect(readBounded(events).text).toContain("Saved final result");
    expect(ctx.shutdown).not.toHaveBeenCalled();
    await handler("agent_settled")({}, ctx);
    expect(ctx.shutdown).not.toHaveBeenCalled();
    expect(readBounded(events).text.match(/"type":"settled"/g)).toHaveLength(1);
  });
  it("awaits restored model selection and applies thinking before admitting the delegated prompt", async () => {
    const { runtime, task, events, handler, ctx, setModel, setThinkingLevel, sendUserMessage } =
      bridge();
    runtime.store.exec("UPDATE runs SET state='running' WHERE id=?", task.runId);
    runtime.store.control(runtime.owner, task.taskId, "steer", "Queued steering");
    runtime.store.exec("UPDATE controls SET state='sending' WHERE run_id=?", task.runId);
    let release!: (value: boolean) => void;
    setModel.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const startup = handler("session_start")({}, ctx);
    await vi.advanceTimersByTimeAsync(500);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(setThinkingLevel).not.toHaveBeenCalled();
    release(true);
    await startup;
    expect(setThinkingLevel).toHaveBeenCalledWith("max");
    expect(readBounded(events).text).toContain('"type":"ready"');
    await vi.advanceTimersByTimeAsync(100);
    expect(sendUserMessage.mock.calls[0]).toEqual(["Delegated prompt"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(sendUserMessage).toHaveBeenNthCalledWith(2, "Queued steering", { deliverAs: "steer" });
  });
  it("reports a failed delegated run without sending a prompt using stale settings", async () => {
    const { events, handler, ctx, setModel, sendUserMessage } = bridge();
    setModel.mockResolvedValue(false);
    await handler("session_start")({}, ctx);
    await vi.advanceTimersByTimeAsync(500);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(readBounded(events).text).toContain('"type":"settled"');
    expect(readBounded(events).text).toContain("authentication unavailable");
  });
});
