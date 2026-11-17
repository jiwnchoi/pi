import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../lib/store.ts";
import { defaultConfig, loadConfig } from "../lib/config.ts";
import { Runtime, readBounded, sanitize } from "../lib/runtime.ts";
import type { AgentSettings, Config, TaskInput, TaskSpec } from "../lib/types.ts";
import { parseSpec, stringifyJson } from "../lib/validation.ts";
const roots: string[] = [];
const stores: Store[] = [];
const runtimes: Runtime[] = [];
function root(): string {
  const r = mkdtempSync(join(tmpdir(), "pirex-test-"));
  roots.push(r);
  return r;
}
function makeStore(): Store {
  const store = new Store(root());
  stores.push(store);
  return store;
}
function makeRuntime(config?: Config): Runtime {
  const r = root();
  const runtime = new Runtime(r, "owner", config || loadConfig(r, false, r), {
    cwd: r,
    session: "session:test",
    anchor: "block:parent",
    provider: "test",
    model: "test",
    thinking: "high",
  });
  runtimes.push(runtime);
  return runtime;
}
function spec(rootPath: string): TaskSpec {
  return {
    cwd: rootPath,
    config: loadConfig(rootPath, false, rootPath),
    context: "",
    launchContext: {},
  };
}
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.close();
  for (const store of stores.splice(0)) store.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
describe("SQLite task registry", () => {
  it("persists receipts and isolates owners", () => {
    const store = makeStore(),
      settings = spec(store.root);
    const task = store.submit("a", "shell", "Test", settings, "session:test");
    expect(task.state).toBe("queued");
    expect(store.task("a", task.id).run_id).toBe(task.run_id);
    expect(() => store.task("b", task.id)).toThrow("Unknown task");
    const reopened = new Store(store.root);
    expect(reopened.task("a", task.id).id).toBe(task.id);
    reopened.close();
  });
  it("reads state-change times from the current run without counting unrelated activity", () => {
    const store = makeStore();
    const task = store.submit("a", "shell", "Test", spec(store.root), "s");
    store.exec("UPDATE events SET created=10 WHERE run_id=?", task.run_id);
    expect(store.task("a", task.id).state_changed).toBe(10);
    for (const [index, state] of [
      "starting",
      "running",
      "stop_requested",
      "unknown",
      "failed",
      "succeeded",
    ].entries()) {
      store.exec("UPDATE runs SET state=?,heartbeat=99999 WHERE id=?", state, task.run_id);
      const type = state === "unknown" ? "launch_uncertain" : state;
      store.event(task.run_id, type);
      store.exec(
        "UPDATE events SET created=? WHERE run_id=? AND type=?",
        20 + index,
        task.run_id,
        type,
      );
      store.event(task.run_id, "steer_requested");
      expect(store.task("a", task.id).state_changed).toBe(20 + index);
      expect(store.list("a")[0].state_changed).toBe(20 + index);
    }
  });
  it("clears only terminal tasks from the list without deleting durable records", () => {
    const store = makeStore(),
      a = store.submit("a", "shell", "Done", spec(store.root), "s"),
      b = store.submit("a", "shell", "Running", spec(store.root), "s");
    store.finish(a.run_id, "succeeded", 0);
    expect(() => store.clear("a", b.id)).toThrow("Only completed");
    expect(store.clear("a")).toBe(1);
    expect(store.list("a").map((row) => row.id)).toEqual([b.id]);
    expect(store.task("a", a.id).state).toBe("succeeded");
    expect(store.clear("other")).toBe(0);
  });
  it("claims each run once and applies cross-connection concurrency", () => {
    const store = makeStore(),
      other = new Store(store.root),
      settings = spec(store.root);
    const a = store.submit("a", "shell", "A", settings, "s"),
      b = store.submit("a", "shell", "B", settings, "s");
    expect(store.claim(a.run_id, 1)).toBe(true);
    expect(other.claim(a.run_id, 1)).toBe(false);
    expect(other.claim(b.run_id, 1)).toBe(false);
    store.finish(a.run_id, "succeeded", 0);
    expect(other.claim(b.run_id, 1)).toBe(true);
    other.close();
  });
  it("records terminal state and outbox atomically, once only", () => {
    const store = makeStore(),
      task = store.submit("a", "shell", "A", spec(store.root), "s");
    expect(store.finish(task.run_id, "succeeded", 0)).toBe(true);
    expect(store.finish(task.run_id, "failed", 1)).toBe(false);
    expect(store.all("SELECT * FROM notification_outbox")).toHaveLength(1);
    expect(store.task("a", task.id).state).toBe("succeeded");
  });
  it("stops queued tasks transactionally and refuses steer/stop after completion", () => {
    const store = makeStore(),
      task = store.submit("a", "shell", "A", spec(store.root), "s");
    store.control("a", task.id, "stop");
    expect(store.task("a", task.id).state).toBe("stopped");
    expect(() => store.control("a", task.id, "stop")).toThrow("already finished");
    expect(store.all("SELECT * FROM notification_outbox")).toHaveLength(1);
  });
  it("does not notify the parent separately for workflow children", () => {
    const store = makeStore();
    const task = store.submit(
      "a",
      "shell",
      "Child",
      { ...spec(store.root), parentRun: "workflow" },
      "s",
    );
    store.finish(task.run_id, "failed", 2);
    expect(store.all("SELECT * FROM notification_outbox")).toHaveLength(0);
  });
  it("resumes a terminal agent using a new run without overwriting history", () => {
    const store = makeStore(),
      settings = spec(store.root);
    const first = store.submit("a", "agent", "Agent", settings, "s");
    expect(() => store.submit("a", "agent", "Again", settings, "s", first.id)).toThrow("terminal");
    store.finish(first.run_id, "failed", 1);
    const next = store.submit("a", "agent", "Again", settings, "s", first.id);
    expect(next.id).toBe(first.id);
    expect(next.run_id).not.toBe(first.run_id);
    expect(store.all("SELECT * FROM runs")).toHaveLength(2);
  });
});
describe("config validation and trust", () => {
  it("starts without pre-registered agents", () => {
    const r = root();
    expect(loadConfig(r, false, r).agents.profiles).toBeUndefined();
  });
  it("rejects typos, wrong types and disabling delegation policy", () => {
    const r = root();
    for (const content of [
      defaultConfig.replace("max_concurrent = 4", 'max_concurrent = "4"'),
      defaultConfig.replace("max_concurrent", "max_concurent"),
      defaultConfig.replace("require_explicit_request = true", "require_explicit_request = false"),
    ]) {
      writeFileSync(join(r, "config.toml"), content);
      expect(() => loadConfig(r, false, r)).toThrow();
    }
  });
  it("ignores untrusted project config and resolves profile paths relative to config", () => {
    const r = root(),
      global = root();
    mkdirSync(join(r, ".pi"));
    writeFileSync(
      join(r, ".pi", "pirex-tasks.toml"),
      '[execution]\nmax_concurrent = 2\n[agents.profiles.mine]\nsystem_prompt_file = "./prompt.md"\n',
    );
    expect(loadConfig(r, false, global).execution.max_concurrent).toBe(4);
    const config = loadConfig(r, true, global);
    expect(config.execution.max_concurrent).toBe(2);
    expect(config.agents.profiles?.mine.system_prompt_file).toBe(join(r, ".pi", "prompt.md"));
  });
});
describe("runtime admission and bounded output", () => {
  it("returns queued immediately and never blocks result retrieval", () => {
    const rt = makeRuntime();
    const receipt = rt.submit("shell", { name: "Test", command: "long-command" });
    expect(receipt.state).toBe("queued");
    expect(rt.result(receipt.taskId).ready).toBe(false);
  });
  it("requires explicit agent authorization and rejects implicit profiles", () => {
    const rt = makeRuntime();
    expect(() => rt.submit("agent", { name: "Agent", prompt: "test" })).toThrow("explicitRequest");
    expect(() =>
      rt.submit("agent", {
        name: "Agent",
        prompt: "test",
        explicitRequest: true,
        profile: "Explore",
      }),
    ).toThrow("Unknown user-defined");
    const agent = rt.submit("agent", { name: "Agent", prompt: "test", explicitRequest: true });
    const settings = parseSpec(rt.store.task(rt.owner, agent.taskId));
    expect(settings.agent?.model).toBe("test");
    expect(settings.agent?.thinking).toBe("high");
    expect(settings.context).toBe("");
  });
  for (const resume of [false, true]) {
    describe(resume ? "resumed agent settings" : "new agent settings", () => {
      const cases: {
        name: string;
        profile?: AgentSettings;
        input?: Partial<TaskInput>;
        expected: AgentSettings;
      }[] = [
        {
          name: "inherits the current parent",
          expected: { provider: "current", model: "current-model", thinking: "max" },
        },
        {
          name: "honors explicit overrides",
          input: { provider: "explicit", model: "explicit-model", thinking: "off" },
          expected: { provider: "explicit", model: "explicit-model", thinking: "off" },
        },
        {
          name: "honors profile overrides",
          profile: { provider: "profile", model: "profile-model", thinking: "low" },
          expected: { provider: "profile", model: "profile-model", thinking: "low" },
        },
        {
          name: "keeps unspecified profile fields current",
          profile: { thinking: "medium" },
          expected: { provider: "current", model: "current-model", thinking: "medium" },
        },
        {
          name: "prefers explicit fields over profile fields",
          profile: { provider: "profile", model: "profile-model", thinking: "low" },
          input: { model: "explicit-model", thinking: "xhigh" },
          expected: { provider: "profile", model: "explicit-model", thinking: "xhigh" },
        },
        {
          name: "keeps a bare model override on the current provider",
          input: { model: "other-model" },
          expected: { provider: "current", model: "other-model", thinking: "max" },
        },
        {
          name: "uses an explicit provider without inventing a model",
          input: { provider: "other" },
          expected: { provider: "other", model: "current-model", thinking: "max" },
        },
      ];
      it.each(cases)("$name", ({ profile, input, expected }) => {
        const rt = makeRuntime();
        const request = { name: "Agent", prompt: "test", explicitRequest: true };
        const original = resume ? rt.submit("agent", request) : undefined;
        if (original) rt.store.finish(original.runId, "succeeded", 0);
        rt.context = {
          ...rt.context,
          provider: "current",
          model: "current-model",
          thinking: "max",
        };
        if (profile) rt.config.agents.profiles = { selected: profile };
        const task = rt.submit("agent", {
          ...request,
          resume: original?.taskId,
          profile: profile ? "selected" : undefined,
          ...input,
        });
        expect(parseSpec(rt.store.task(rt.owner, task.taskId)).agent).toMatchObject(expected);
        if (original) {
          expect(task.taskId).toBe(original.taskId);
          expect(task.runId).not.toBe(original.runId);
          expect(
            parseSpec(rt.store.required("SELECT * FROM runs WHERE id=?", original.runId)).agent,
          ).toMatchObject({ provider: "test", model: "test", thinking: "high" });
        }
      });
    });
  }
  it("preserves resumed session state but not old profile model defaults or parent references", () => {
    const rt = makeRuntime();
    const promptPath = join(rt.store.root, "prompt.md");
    writeFileSync(promptPath, "Saved system prompt");
    rt.context.snapshot = "Saved parent reference";
    rt.config.agents.profiles = {
      original: {
        provider: "profile",
        model: "profile-model",
        thinking: "low",
        tools: ["read"],
        system_prompt_file: promptPath,
        inherit_context: true,
      },
    };
    const first = rt.submit("agent", {
      name: "Agent",
      prompt: "first",
      explicitRequest: true,
      profile: "original",
    });
    const session = rt.store.required<{ path: string }>(
      "SELECT path FROM agent_sessions WHERE task_id=?",
      first.taskId,
    );
    writeFileSync(session.path, "Saved conversation and tool context");
    expect(parseSpec(rt.store.task(rt.owner, first.taskId)).context).toBe("Saved parent reference");
    rt.store.finish(first.runId, "succeeded", 0);
    rmSync(promptPath);
    rt.context = {
      ...rt.context,
      provider: "current",
      model: "current-model",
      thinking: "max",
      snapshot: "Not requested",
    };
    const next = rt.submit("agent", {
      name: "Again",
      prompt: "next",
      explicitRequest: true,
      resume: first.taskId,
    });
    expect(parseSpec(rt.store.task(rt.owner, next.taskId))).toMatchObject({
      resumeRunId: first.runId,
      cwd: rt.store.root,
      systemPrompt: "Saved system prompt",
      context: "",
      agent: {
        provider: "current",
        model: "current-model",
        thinking: "max",
        tools: ["read"],
        inherit_context: false,
      },
    });
    expect(
      rt.store.required("SELECT path FROM agent_sessions WHERE task_id=?", first.taskId),
    ).toEqual(session);
    expect(readBounded(session.path).text).toBe("Saved conversation and tool context");
  });
  it("applies new profiles, tools and reference settings on resume", () => {
    const rt = makeRuntime();
    const first = rt.submit("agent", { name: "Agent", prompt: "first", explicitRequest: true });
    rt.store.finish(first.runId, "succeeded", 0);
    const promptPath = join(rt.store.root, "prompt.md");
    writeFileSync(promptPath, "New profile prompt");
    rt.config.agents.profiles = {
      next: { system_prompt_file: promptPath, tools: ["read"], inherit_context: true },
    };
    rt.context.snapshot = "Current reference";
    expect(() =>
      rt.submit("agent", {
        name: "Again",
        prompt: "next",
        explicitRequest: true,
        resume: first.taskId,
        profile: "missing",
      }),
    ).toThrow("Unknown user-defined");
    const next = rt.submit("agent", {
      name: "Again",
      prompt: "next",
      explicitRequest: true,
      resume: first.taskId,
      profile: "next",
      tools: ["read", "grep"],
    });
    expect(parseSpec(rt.store.task(rt.owner, next.taskId))).toMatchObject({
      systemPrompt: "New profile prompt",
      context: "Current reference",
      agent: { tools: ["read", "grep"] },
    });
  });
  it.each([false, true])("defaults parent inheritance to false with legacy resume=%s", (resume) => {
    const rt = makeRuntime();
    rt.context.snapshot = "Private parent conversation";
    const request = { name: "Agent", prompt: "Self-contained task", explicitRequest: true };
    const first = resume ? rt.submit("agent", { ...request, inheritContext: true }) : undefined;
    if (first) {
      rt.store.finish(first.runId, "succeeded", 0);
      rt.context.snapshot = "Updated private parent conversation";
    }
    const task = rt.submit("agent", { ...request, resume: first?.taskId });
    const settings = parseSpec(rt.store.task(rt.owner, task.taskId));
    expect(settings.agent?.inherit_context).toBe(false);
    expect(settings.context).toBe("");
    expect(stringifyJson(settings)).not.toContain("Private parent conversation");
    expect(settings.launchContext.snapshot).toBeUndefined();
  });
  it("lets explicit false override a profile enabling parent inheritance", () => {
    const rt = makeRuntime();
    rt.context.snapshot = "Private parent conversation";
    rt.config.agents.profiles = { selected: { inherit_context: true } };
    const task = rt.submit("agent", {
      name: "Agent",
      prompt: "Self-contained task",
      explicitRequest: true,
      profile: "selected",
      inheritContext: false,
    });
    const settings = parseSpec(rt.store.task(rt.owner, task.taskId));
    expect(settings.agent?.inherit_context).toBe(false);
    expect(settings.context).toBe("");
  });
  it("does not fall back to stale provider/model settings on resume", () => {
    const rt = makeRuntime();
    const first = rt.submit("agent", { name: "Agent", prompt: "test", explicitRequest: true });
    rt.store.finish(first.runId, "succeeded", 0);
    rt.context.provider = undefined;
    expect(() =>
      rt.submit("agent", {
        name: "Again",
        prompt: "test",
        explicitRequest: true,
        resume: first.taskId,
      }),
    ).toThrow("provider and model");
  });
  it("admits explicitly requested agents in child sessions and refuses execution outside Rex", () => {
    const rt = makeRuntime();
    rt.context.child = true;
    expect(rt.submit("agent", { name: "Agent", prompt: "test", explicitRequest: true }).state).toBe(
      "queued",
    );
    rt.context.session = undefined;
    expect(() => rt.submit("shell", { name: "Test", command: "true" })).toThrow(
      "Rex session missing",
    );
  });
  it("bounds file reads and removes terminal control sequences", () => {
    const r = root(),
      path = join(r, "large.log");
    writeFileSync(path, "A".repeat(100000) + "\x1b[31mEND\x1b[0m");
    const out = readBounded(path, 50);
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith("END")).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(50);
    expect(sanitize("\x1b]0;bad\x07hello")).toBe("hello");
  });
  it("returns failure metadata for terminal task results", () => {
    const rt = makeRuntime(),
      task = rt.submit("shell", { name: "Bad", command: "false" });
    rt.store.finish(task.runId, "failed", 2, "bad exit");
    expect(rt.result(task.taskId)).toMatchObject({ ready: true, state: "failed", exitCode: 2 });
  });
});
