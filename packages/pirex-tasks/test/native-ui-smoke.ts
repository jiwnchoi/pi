// Real Pi-Bolt interactive TUI in a real PTY; the explicit fixture intercepts all model prompts.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { decodeJson, stringifyJson } from "../lib/validation.ts";
import { Runtime } from "../lib/runtime.ts";
import { agentCommand } from "../runner/agent.ts";
import { loadConfig } from "../lib/config.ts";
import { terminal } from "../lib/store.ts";
import { openPopup, hidePopup, closePopup, api } from "../lib/rex.ts";

const root = mkdtempSync(join(tmpdir(), "pirex-native-ui-"));
const settings = decodeJson(
  readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"),
  Type.Object({ defaultProvider: Type.String(), defaultModel: Type.String() }),
);
const config = loadConfig(root, false, root);
config.execution.node = process.execPath;
const nativeUIFixture = fileURLToPath(new URL("./native-ui-fixture.ts", import.meta.url));
const wrapper = join(root, "pi-native-probe");
writeFileSync(
  wrapper,
  `#!/bin/zsh -fi\nset -- "$@" -e ${stringifyJson(nativeUIFixture)}\n${agentCommand(config.agent_runtime)}\n`,
  { mode: 0o700 },
);
config.agent_runtime.executable = wrapper;
const rt = new Runtime(root, "native-ui-probe", config, {
  session: process.env.REX_SESSION,
  anchor: process.env.REX_BLOCK,
  cwd: root,
  provider: settings.defaultProvider,
  model: settings.defaultModel,
  thinking: "off",
});
try {
  const receipt = rt.submit("agent", {
    name: "Native Pi TUI probe",
    prompt: "Intercept this locally; do not call a model.",
    explicitRequest: true,
    timeoutSeconds: 20,
  });
  await rt.drain();
  const deadline = Date.now() + 25000;
  for (;;) {
    const row = rt.store.task(rt.owner, receipt.taskId);
    if (terminal.has(row.state)) {
      assert.equal(row.state, "succeeded", readFileSync(row.log_path, "utf8"));
      assert.match(rt.result(receipt.taskId).output?.text || "", /native TUI ready/);
      break;
    }
    if (Date.now() > deadline) throw new Error("Native Pi TUI startup timed out");
    await delay(150);
  }
  const row = rt.store.task(rt.owner, receipt.taskId);
  for (
    let i = 0;
    i < 40 && !readFileSync(row.log_path, "utf8").includes("SCROLL_PROBE_LINE_160");
    i++
  )
    await delay(100);
  const log = readFileSync(row.log_path, "utf8");
  assert.match(log, /SCROLL_PROBE_LINE_160/, "The actual Pi TUI must render the long transcript");
  assert.doesNotMatch(
    log,
    /GHOSTSNP/,
    "Binary native initialization must never be treated as ANSI logs",
  );
  assert.doesNotMatch(log, /gitstatus failed|can.t change option: monitor|Last login/);
  assert.equal(
    (
      await api<{ blocks: { block_id: string }[] }>(row.rex_session, "session.list_blocks")
    ).blocks.some((block) => block.block_id === row.rex_source),
    true,
    "Native TUI must remain available after delegated completion",
  );
  await openPopup(row, config.popup.bounds, rt.store);
  const screen = async (block: string) =>
    (
      await api<{ content: string }>(row.rex_session, "block.method", {
        block_id: block,
        method: "format",
        args: { format: "text" },
      })
    ).content;
  const waitScreen = async (block: string, text: string) => {
    for (let i = 0; i < 60; i++) {
      const value = await screen(block);
      if (value.includes(text)) return value;
      await delay(100);
    }
    throw new Error(`Screen missing ${text}`);
  };
  await waitScreen(row.rex_block!, "SCROLL_PROBE_LINE_160");
  const modes = await api<{ screen: string; modes: { number: number; set: boolean }[] }>(
    row.rex_session,
    "block.method",
    { block_id: row.rex_block, method: "modes", args: {} },
  );
  assert.equal(modes.screen, "alternate");
  assert.ok(modes.modes.some((mode) => mode.number === 1006 && mode.set));
  await api(row.rex_session, "block.method", {
    block_id: row.rex_block,
    method: "write",
    args: { data: "\x1b[<64;20;10M".repeat(12) },
  });
  let scrolled = "";
  for (let i = 0; i < 60; i++) {
    scrolled = await screen(row.rex_source!);
    if (scrolled.includes("SCROLL_PROBE_LINE_") && !scrolled.includes("SCROLL_PROBE_LINE_160"))
      break;
    await delay(100);
  }
  assert.ok(
    !scrolled.includes("SCROLL_PROBE_LINE_160"),
    "Real Pi fullscreen transcript must scroll up",
  );
  const marker = scrolled.match(/SCROLL_PROBE_LINE_\d+/)?.[0];
  assert.ok(marker);
  await waitScreen(row.rex_block!, marker);
  await api(row.rex_session, "block.close", { block_id: row.rex_block });
  await openPopup(row, config.popup.bounds, rt.store);
  await waitScreen(row.rex_block!, marker);
  await api(row.rex_session, "block.method", {
    block_id: row.rex_block,
    method: "write",
    args: { data: "\x1b[<65;20;10M".repeat(12) },
  });
  await waitScreen(row.rex_source!, "SCROLL_PROBE_LINE_160");
  await waitScreen(row.rex_block!, "SCROLL_PROBE_LINE_160");
  console.log(
    "PASS real Pi fullscreen wheel scrolling, X close/reopen, native modes and scroll-position retention",
  );
  await hidePopup(row);
  await delay(500);
  await api(row.rex_session, "block.method", {
    block_id: row.rex_block,
    method: "write",
    args: { data: "human-followup-after-completion\r" },
  });
  const inputPath = join(root, "runs", row.run_id, "native-events.jsonl.inputs");
  for (
    let i = 0;
    i < 40 && !readFileSync(inputPath, "utf8").includes("human-followup-after-completion");
    i++
  )
    await delay(100);
  assert.match(
    readFileSync(inputPath, "utf8"),
    /human-followup-after-completion/,
    "Completed Pi must accept human conversation",
  );
  await closePopup(row, rt.store);
  assert.equal(
    (
      await api<{ blocks: { block_id: string }[] }>(row.rex_session, "session.list_blocks")
    ).blocks.some((block) => block.block_id === row.rex_source),
    false,
  );
  console.log(
    "PASS real Pi alias, native interactive TUI, quiet bootstrap, completed UI reconnect and disposal (all prompts intercepted; no model calls)",
  );
} finally {
  for (const row of rt.store.all("SELECT * FROM runs")) {
    if (!terminal.has(row.state)) {
      try {
        rt.store.control(rt.owner, row.task_id, "stop");
      } catch {}
    }
    if (row.rex_source)
      await api(row.rex_session, "block.close", { block_id: row.rex_source }).catch(() => {});
    if (row.rex_block)
      await api(row.rex_session, "block.close", { block_id: row.rex_block }).catch(() => {});
  }
  rt.close();
  rmSync(root, { recursive: true, force: true });
}
