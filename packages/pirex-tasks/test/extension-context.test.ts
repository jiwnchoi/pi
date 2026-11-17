import { afterEach, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pirexTasks from "../extensions/index.ts";
import { Runtime } from "../lib/runtime.ts";
import { parseSpec } from "../lib/validation.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("refreshes model, provider and thinking from every invoking tool context, including resume and workflows", async () => {
  const root = mkdtempSync(join(tmpdir(), "pirex-extension-context-"));
  vi.stubEnv("PIREX_TASKS_HOME", root);
  vi.stubEnv("REX_SESSION", "session:test");
  vi.spyOn(Runtime.prototype, "drain").mockResolvedValue();
  vi.spyOn(Runtime.prototype, "reconcile").mockResolvedValue();
  const submit = vi.spyOn(Runtime.prototype, "submit");
  const on = vi.fn();
  const registerTool = vi.fn();
  const pi = {
    on,
    registerTool,
    registerEntryRenderer: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: root,
    mode: "print",
    model: { provider: "original", id: "original-model" },
    thinkingLevel: "high",
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "owner",
      getEntries: () => [],
      buildContextEntries: vi.fn(() => []),
    },
    ui: { notify: vi.fn() },
  } as unknown as ExtensionToolContext;
  pirexTasks(pi);
  const handler = (name: string) =>
    on.mock.calls.find(([event]) => event === name)![1] as (
      event: unknown,
      ctx: ExtensionContext,
    ) => void | Promise<void>;
  cleanup = async () => {
    await handler("session_shutdown")({}, ctx);
    rmSync(root, { recursive: true, force: true });
  };
  await handler("session_start")({}, ctx);
  const agent = registerTool.mock.calls.find(([tool]) => tool.name === "task_agent")![0];
  expect(agent.parameters.properties.inheritContext.default).toBe(false);
  const request = { name: "Agent", prompt: "test", explicitRequest: true };
  const first = await agent.execute("call", request, undefined, undefined, ctx);
  const rt = submit.mock.instances[0];
  if (!(rt instanceof Runtime)) throw new Error("Missing session runtime");
  const firstSpec = parseSpec(rt.store.task(rt.owner, first.details.taskId));
  expect(firstSpec.agent).toMatchObject({
    provider: "original",
    model: "original-model",
    thinking: "high",
  });
  rt.store.finish(first.details.runId, "succeeded", 0);
  const current = {
    ...ctx,
    model: { ...ctx.model, provider: "current", id: "current-model" },
    thinkingLevel: "max",
  } as ExtensionToolContext;
  const resumed = await agent.execute(
    "resume",
    { ...request, resume: first.details.taskId },
    undefined,
    undefined,
    current,
  );
  expect(parseSpec(rt.store.task(rt.owner, resumed.details.taskId)).agent).toMatchObject({
    provider: "current",
    model: "current-model",
    thinking: "max",
  });
  rt.config.agents.profiles = { selected: { inherit_context: true } };
  const isolated = await agent.execute(
    "isolated",
    { ...request, profile: "selected", inheritContext: false },
    undefined,
    undefined,
    current,
  );
  expect(ctx.sessionManager.buildContextEntries).not.toHaveBeenCalled();
  expect(parseSpec(rt.store.task(rt.owner, isolated.details.taskId)).context).toBe("");
  const code = registerTool.mock.calls.find(([tool]) => tool.name === "task_code")![0];
  const workflow = await code.execute(
    "workflow",
    { name: "Workflow", code: "return 1" },
    undefined,
    undefined,
    current,
  );
  expect(parseSpec(rt.store.task(rt.owner, workflow.details.taskId)).launchContext).toMatchObject({
    provider: "current",
    model: "current-model",
    thinking: "max",
  });
  rt.store.finish(workflow.details.runId, "succeeded", 0);
  const custom = vi.fn(() => new Promise(() => {}));
  const interactive = {
    ...ctx,
    mode: "tui",
    ui: { ...ctx.ui, custom },
  } as unknown as ExtensionToolContext;
  const open = registerTool.mock.calls.find(([tool]) => tool.name === "task_open")![0];
  const opened = await open.execute(
    "open",
    { taskId: workflow.details.taskId },
    undefined,
    undefined,
    interactive,
  );
  expect(opened.details.state).toBe("opened");
  expect(custom).toHaveBeenCalledOnce();
  expect(rt.store.task(rt.owner, workflow.details.taskId).rex_block).toBeNull();
});
