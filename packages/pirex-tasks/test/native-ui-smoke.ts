import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
const fixture = fileURLToPath(new URL("./native-ui-fixture.ts", import.meta.url));
const wrapper = join(root, "pi-native-probe");
const inspectionEvents = join(root, "inspection-events");
writeFileSync(
  wrapper,
  `#!/bin/zsh -fi\nexport PIREX_TEST_EVENTS=${stringifyJson(inspectionEvents)}\nset -- "$@" -e ${stringifyJson(fixture)}\n${agentCommand(config.agent_runtime)}\n`,
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
async function blocks() {
  return (
    await api<{ blocks: { block_id: string }[] }>(process.env.REX_SESSION!, "session.list_blocks")
  ).blocks;
}
async function gone(block: string | null | undefined) {
  if (!block) return;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await blocks()).some((item) => item.block_id === block)) return;
    await delay(100);
  }
  assert.fail(`PTY block still exists: ${block}`);
}
async function screen(block: string, marker: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await api<{ content: string }>(process.env.REX_SESSION!, "block.method", {
      block_id: block,
      method: "format",
      args: { format: "text" },
    });
    if (value.content.includes(marker)) return;
    await delay(100);
  }
  assert.fail(`Restored Pi screen missing ${marker}`);
}
try {
  const receipt = rt.submit("agent", {
    name: "Native Pi TUI probe",
    prompt: "Intercept this locally; do not call a model.",
    explicitRequest: true,
    timeoutSeconds: 30,
  });
  await rt.drain();
  const deadline = Date.now() + 35000;
  for (;;) {
    const row = rt.store.task(rt.owner, receipt.taskId);
    if (terminal.has(row.state)) {
      assert.equal(row.state, "succeeded", readFileSync(row.log_path, "utf8"));
      break;
    }
    if (Date.now() > deadline) throw new Error("Native Pi startup timed out");
    await delay(150);
  }
  const row = rt.store.task(rt.owner, receipt.taskId);
  await gone(row.rex_source);
  const original = rt.result(row.id);
  assert.match(original.output?.text || "", /native TUI ready/);
  assert.ok(existsSync(original.agentSession!));
  assert.doesNotMatch(
    readFileSync(row.log_path, "utf8"),
    /GHOSTSNP|gitstatus failed|can.t change option: monitor|Last login/,
  );
  console.log("PASS actual native Pi completion saves its session and releases the execution PTY");

  await Promise.all([
    openPopup(row, config.popup.bounds, rt.store),
    openPopup(row, config.popup.bounds, rt.store),
  ]);
  assert.ok(row.rex_inspection);
  await screen(row.rex_inspection!, "SCROLL_PROBE_LINE_160");
  assert.equal(
    existsSync(inspectionEvents + ".inputs"),
    false,
    "Reopening must not submit any prompt",
  );
  await api(row.rex_session, "block.method", {
    block_id: row.rex_inspection,
    method: "write",
    args: { data: "human-followup-after-completion\r" },
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (
      existsSync(inspectionEvents + ".inputs") &&
      readFileSync(inspectionEvents + ".inputs", "utf8").includes("human-followup-after-completion")
    )
      break;
    await delay(100);
  }
  assert.match(
    readFileSync(inspectionEvents + ".inputs", "utf8"),
    /human-followup-after-completion/,
  );
  await rt.drain();
  assert.ok((await blocks()).some((block) => block.block_id === row.rex_inspection));
  assert.equal(rt.result(row.id).output?.text, original.output?.text);
  const firstInspection = row.rex_inspection;
  await hidePopup(row);
  await gone(firstInspection);
  await openPopup(row, config.popup.bounds, rt.store);
  assert.notEqual(row.rex_inspection, firstInspection);
  await screen(row.rex_inspection!, "SCROLL_PROBE_LINE_160");
  await closePopup(rt.store.task(rt.owner, row.id), rt.store);
  await gone(row.rex_inspection);
  assert.equal(rt.result(row.id).state, "succeeded");
  console.log(
    "PASS actual saved Pi session resume, no prompt replay, human conversation, hide/reopen and PTY disposal (no model calls)",
  );

  const watched = rt.submit("agent", {
    name: "Watched native Pi completion",
    prompt: "Intercept the watched turn locally.",
    explicitRequest: true,
    timeoutSeconds: 30,
  });
  await rt.drain();
  const watchedRow = rt.store.task(rt.owner, watched.taskId);
  await openPopup(watchedRow, config.popup.bounds, rt.store);
  const originalSource = watchedRow.rex_source;
  const originalViewer = watchedRow.rex_block;
  const watchedDeadline = Date.now() + 35000;
  while (!terminal.has(rt.store.task(rt.owner, watched.taskId).state)) {
    if (Date.now() > watchedDeadline) throw new Error("Watched Pi did not finish");
    await delay(100);
  }
  assert.equal(rt.result(watched.taskId).state, "succeeded");
  await screen(originalViewer!, "SCROLL_PROBE_LINE_160");
  await rt.drain();
  const retained = rt.store.task(rt.owner, watched.taskId);
  await openPopup(retained, config.popup.bounds, rt.store);
  assert.equal(retained.rex_source, originalSource);
  assert.equal(retained.rex_block, originalViewer);
  assert.equal(retained.rex_inspection, null);
  const originalOutput = rt.result(watched.taskId).output?.text;
  await api(retained.rex_session, "block.method", {
    block_id: originalViewer,
    method: "write",
    args: { data: "human-in-original-pi-after-completion\r" },
  });
  const watchedInputs = join(root, "runs", watched.runId, "native-events.jsonl.inputs");
  for (
    let attempt = 0;
    attempt < 60 &&
    !readFileSync(watchedInputs, "utf8").includes("human-in-original-pi-after-completion");
    attempt++
  )
    await delay(100);
  assert.match(readFileSync(watchedInputs, "utf8"), /human-in-original-pi-after-completion/);
  assert.equal(rt.result(watched.taskId).output?.text, originalOutput);
  assert.equal(
    rt.store.all("SELECT * FROM notification_outbox WHERE run_id=?", watched.runId).length,
    1,
  );
  await hidePopup(retained);
  await gone(originalViewer);
  await gone(originalSource);
  console.log(
    "PASS watched completion keeps the original native Pi and PTYs alive until the popup closes",
  );
} finally {
  for (const row of rt.store.all("SELECT * FROM runs"))
    for (const block of [row.rex_source, row.rex_block, row.rex_inspection])
      if (block) await api(row.rex_session, "block.close", { block_id: block }).catch(() => {});
  rt.close();
  rmSync(root, { recursive: true, force: true });
}
