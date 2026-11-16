import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyAgentSettings } from "../runner/agent-bridge.ts";
import { agentArgs, agentCommand } from "../runner/agent.ts";
import type { TaskSpec } from "../lib/types.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function host() {
  const model = { provider: "selected-provider", id: "selected-model" };
  const find = vi.fn(() => model);
  const setModel = vi.fn(async () => true);
  const setThinkingLevel = vi.fn();
  const pi = { setModel, setThinkingLevel } as unknown as ExtensionAPI;
  const ctx = {
    model: { provider: "saved-provider", id: "saved-model" },
    modelRegistry: { find },
  } as unknown as ExtensionContext;
  return { model, find, setModel, setThinkingLevel, pi, ctx };
}

describe("native agent model restoration", () => {
  it("reapplies the exact admitted provider/model after restoring a saved session or alias defaults", async () => {
    const { pi, ctx, find, model, setModel, setThinkingLevel } = host();
    await applyAgentSettings(pi, ctx, {
      provider: model.provider,
      model: model.id,
      thinking: "max",
    });
    expect(find).toHaveBeenCalledWith(model.provider, model.id);
    expect(setModel).toHaveBeenCalledWith(model);
    expect(setThinkingLevel).toHaveBeenCalledWith("max");
    expect(setModel.mock.invocationCallOrder[0]).toBeLessThan(
      setThinkingLevel.mock.invocationCallOrder[0],
    );
  });
  it("preserves the selected model and explicitly applies off", async () => {
    const { pi, ctx, model, setModel, setThinkingLevel } = host();
    await applyAgentSettings(
      pi,
      { ...ctx, model: model as ExtensionContext["model"] },
      { ...model, model: model.id, thinking: "off" },
    );
    expect(setModel).not.toHaveBeenCalled();
    expect(setThinkingLevel).toHaveBeenCalledWith("off");
  });
  it("never substitutes a provider or fuzzy model when the exact pair is unavailable", async () => {
    const { pi, ctx, find, setModel } = host();
    find.mockReturnValue(undefined as never);
    await expect(
      applyAgentSettings(pi, ctx, { provider: "missing", model: "missing" }),
    ).rejects.toThrow("Agent model not found: missing/missing");
    expect(setModel).not.toHaveBeenCalled();
  });
  it("fails rather than using the saved model when authentication is unavailable", async () => {
    const { pi, ctx, model, setModel, setThinkingLevel } = host();
    setModel.mockResolvedValue(false);
    await expect(
      applyAgentSettings(pi, ctx, { provider: model.provider, model: model.id, thinking: "high" }),
    ).rejects.toThrow("authentication unavailable");
    expect(setThinkingLevel).not.toHaveBeenCalled();
  });
  it("rejects invalid thinking instead of treating it as off", async () => {
    const { pi, ctx, model, setThinkingLevel } = host();
    await expect(
      applyAgentSettings(pi, ctx, {
        provider: model.provider,
        model: model.id,
        thinking: "unsupported",
      }),
    ).rejects.toThrow("Invalid agent thinking");
    expect(setThinkingLevel).not.toHaveBeenCalled();
  });
});

describe("agent launch arguments", () => {
  const spec = {
    agent: {
      provider: "chosen-provider",
      model: "vendor/model-id",
      thinking: "max",
      tools: ["read", "grep"],
    },
  } as TaskSpec;
  it("uses identical explicit settings for native and detached runners", () => {
    const args = agentArgs(spec, "/saved session.jsonl", "/system prompt.md");
    expect(args).toEqual([
      "--session",
      "/saved session.jsonl",
      "-e",
      expect.stringContaining("agent-bridge.ts"),
      "--provider",
      "chosen-provider",
      "--model",
      "vendor/model-id",
      "--thinking",
      "max",
      "--append-system-prompt",
      "/system prompt.md",
      "--tools",
      "read,grep",
    ]);
  });
  it("does not invent off for legacy specs without thinking", () => {
    expect(
      agentArgs({ ...spec, agent: { provider: "p", model: "m" } }, "session", "system"),
    ).not.toContain("--thinking");
  });
  it("places admitted settings after alias defaults and keeps provider/model IDs quoted", () => {
    const home = mkdtempSync(join(tmpdir(), "pirex-settings-alias-"));
    try {
      writeFileSync(
        join(home, ".zshrc"),
        "alias pi='printf \"%s\\n\" --provider stale-provider --model stale-model --thinking low'\n",
      );
      const args = agentArgs(spec, "/saved session.jsonl", "/system prompt.md");
      const command = agentCommand({
        executable: "pi",
        bootstrap_shell: "/bin/zsh",
        bootstrap_args: ["-ic"],
      });
      const output = execFileSync("/bin/zsh", ["-f", "-ic", command, "test", ...args], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      });
      expect(output.split("\n")).toEqual([
        "--provider",
        "stale-provider",
        "--model",
        "stale-model",
        "--thinking",
        "low",
        ...args,
        "",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
