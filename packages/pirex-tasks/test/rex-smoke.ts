import assert from "node:assert/strict";
import { stringifyJson } from "../lib/validation.ts";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../lib/runtime.ts";
import { loadConfig } from "../lib/config.ts";
import { api, openPopup, hidePopup, ensurePopup } from "../lib/rex.ts";
import { terminal } from "../lib/store.ts";
import type { TaskRecord } from "../lib/types.ts";

const root = mkdtempSync(join(tmpdir(), "pirex-rex-smoke-"));
const config = loadConfig(root, false, root);
config.execution.node = process.execPath;
config.execution.shell = "/bin/zsh";
const fake = join(root, "fake-pi");
writeFileSync(
  fake,
  `#!/bin/sh\nexec ${stringifyJson(process.execPath)} ${stringifyJson(fileURLToPath(new URL("./fake-pi.ts", import.meta.url)))} "$@"\n`,
  { mode: 0o700 },
);
config.agent_runtime = { executable: fake, bootstrap_shell: "/bin/sh", bootstrap_args: ["-c"] };
const rt = new Runtime(root, "smoke-owner", config, {
  session: process.env.REX_SESSION,
  anchor: process.env.REX_BLOCK,
  cwd: root,
  provider: "fixture",
  model: "fixture",
  thinking: "off",
});
async function wait(id: string, target: "block" | "terminal" = "terminal"): Promise<TaskRecord> {
  await rt.drain();
  const deadline = Date.now() + 30000;
  for (;;) {
    const row = rt.store.task(rt.owner, id);
    if (target === "block" ? row.rex_source && row.state === "running" : terminal.has(row.state))
      return row;
    if (target === "block" && terminal.has(row.state))
      throw new Error(`Task failed before PTY ready: ${row.error}`);
    if (Date.now() > deadline) throw new Error(`Timeout: ${stringifyJson(row)}`);
    await delay(100);
  }
}
async function blocks() {
  return (
    await api<{ blocks: { block_id: string; label?: string }[] }>(
      process.env.REX_SESSION!,
      "session.list_blocks",
    )
  ).blocks;
}
async function gone(...ids: (string | null | undefined)[]) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await blocks()).some((block) => ids.includes(block.block_id))) return;
    await delay(100);
  }
  assert.fail(`Completed blocks still exist: ${ids.join(",")}`);
}
async function screen(block: string, marker: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await api<{ content: string }>(process.env.REX_SESSION!, "block.method", {
      block_id: block,
      method: "format",
      args: { format: "text" },
    });
    if (value.content.includes(marker)) return;
    await delay(100);
  }
  assert.fail(`Missing terminal marker: ${marker}`);
}
try {
  const interactive = rt.submit("shell", {
    name: "PTY input smoke",
    command: 'printf "start\\n" >> starts.txt; read answer; printf "ANSWER=%s\\n" "$answer"',
  });
  const running = await wait(interactive.taskId, "block");
  assert.equal(running.rex_block, null, "Admission must not allocate a viewer");
  await ensurePopup(running, rt.store);
  const firstViewer = running.rex_block;
  await hidePopup(running);
  await gone(firstViewer);
  assert.equal(rt.store.task(rt.owner, interactive.taskId).state, "running");
  await Promise.all([
    openPopup(running, config.popup.bounds, rt.store),
    openPopup(running, config.popup.bounds, rt.store),
  ]);
  const viewer = running.rex_block;
  await api(running.rex_session, "block.method", {
    block_id: viewer,
    method: "write",
    args: { data: "hello-from-rex\n" },
  });
  assert.equal((await wait(interactive.taskId)).state, "succeeded");
  await gone(running.rex_source, viewer);
  assert.match(rt.result(interactive.taskId).output?.text || "", /ANSWER=hello-from-rex/);
  assert.equal(readFileSync(join(root, "starts.txt"), "utf8"), "start\n");
  const completedLog = rt.store.task(rt.owner, interactive.taskId);
  await openPopup(completedLog, config.popup.bounds, rt.store);
  assert.ok(completedLog.rex_inspection);
  await screen(completedLog.rex_inspection!, "ANSWER=hello-from-rex");
  await rt.drain();
  assert.ok((await blocks()).some((block) => block.block_id === completedLog.rex_inspection));
  await api(completedLog.rex_session, "block.method", {
    block_id: completedLog.rex_inspection,
    method: "write",
    args: { data: "q" },
  });
  await gone(completedLog.rex_inspection);
  assert.equal(readFileSync(join(root, "starts.txt"), "utf8"), "start\n");
  assert.equal(rt.result(interactive.taskId).state, "succeeded");
  console.log(
    "PASS live input, completed logs in a new Rex popup, pager exit, exactly-once execution and PTY release",
  );

  const failed = rt.submit("shell", { name: "Nonzero smoke", command: "exit 7" });
  assert.equal((await wait(failed.taskId)).exit_code, 7);
  const timeout = rt.submit("shell", {
    name: "Timeout smoke",
    command: "sleep 20",
    timeoutSeconds: 0.6,
  });
  assert.equal((await wait(timeout.taskId)).state, "timed_out");
  const stopped = rt.submit("shell", { name: "Stop smoke", command: "sleep 20" });
  await wait(stopped.taskId, "block");
  rt.store.control(rt.owner, stopped.taskId, "stop");
  assert.equal((await wait(stopped.taskId)).state, "stopped");
  const code = rt.submit("code", {
    name: "Workflow smoke",
    code: 'const child = await tasks.shell({name:"Child", command:"printf child-output"}); return await tasks.wait(child.taskId);',
  });
  assert.equal((await wait(code.taskId)).state, "succeeded");
  assert.match(rt.result(code.taskId).output?.text || "", /child-output/);
  console.log("PASS nonzero exit, timeout, stop, workflow and child results");

  const agentRuntime = rt.config.agent_runtime;
  rt.config.agent_runtime = {
    executable: "/usr/bin/false",
    bootstrap_shell: "/bin/sh",
    bootstrap_args: ["-c"],
  };
  const noSession = rt.submit("agent", {
    name: "Agent startup failure",
    explicitRequest: true,
    prompt: "fixture only",
  });
  rt.config.agent_runtime = agentRuntime;
  assert.equal((await wait(noSession.taskId)).state, "failed");
  const noSessionLog = rt.store.task(rt.owner, noSession.taskId);
  await openPopup(noSessionLog, config.popup.bounds, rt.store);
  await screen(noSessionLog.rex_inspection!, "Agent exited before completion");
  await hidePopup(noSessionLog);
  await gone(noSessionLog.rex_inspection);
  assert.equal(rt.result(noSession.taskId).state, "failed");
  console.log("PASS agents without saved sessions fall back to a disposable Rex log popup");

  const agent = rt.submit("agent", {
    name: "Agent fixture",
    explicitRequest: true,
    prompt: "fixture only",
  });
  const agentRunning = await wait(agent.taskId, "block");
  await openPopup(agentRunning, config.popup.bounds, rt.store);
  rt.store.control(rt.owner, agent.taskId, "steer", "steer fixture");
  await api(agentRunning.rex_session, "block.method", {
    block_id: agentRunning.rex_block,
    method: "write",
    args: { data: "human popup message\n" },
  });
  assert.equal((await wait(agent.taskId)).state, "succeeded");
  await gone(agentRunning.rex_source, agentRunning.rex_block);
  const result = rt.result(agent.taskId);
  assert.match(result.output?.text || "", /fixture result 한글/);
  assert.match(readFileSync(result.agentSession!, "utf8"), /steer fixture/);
  const before = readFileSync(result.agentSession!, "utf8");
  const completed = rt.store.task(rt.owner, agent.taskId);
  await Promise.all([
    openPopup(completed, config.popup.bounds, rt.store),
    openPopup(completed, config.popup.bounds, rt.store),
  ]);
  assert.ok(completed.rex_inspection);
  await screen(completed.rex_inspection!, "RESUMED_SAVED_PI_SESSION");
  assert.equal(
    readFileSync(result.agentSession!, "utf8"),
    before,
    "Inspection must not replay the delegated prompt",
  );
  await api(completed.rex_session, "block.method", {
    block_id: completed.rex_inspection,
    method: "write",
    args: { data: "human followup after completion\n" },
  });
  for (
    let attempt = 0;
    attempt < 40 &&
    !readFileSync(result.agentSession!, "utf8").includes("human followup after completion");
    attempt++
  )
    await delay(100);
  assert.match(readFileSync(result.agentSession!, "utf8"), /human followup after completion/);
  await rt.drain();
  assert.ok(
    (await blocks()).some((block) => block.block_id === completed.rex_inspection),
    "Completed-run cleanup must preserve explicit inspection",
  );
  assert.equal(rt.result(agent.taskId).output?.text, result.output?.text);
  assert.equal(
    rt.store.all("SELECT * FROM notification_outbox WHERE run_id=?", agent.runId).length,
    1,
  );
  await hidePopup(completed);
  await gone(completed.rex_inspection);
  console.log(
    "PASS saved Pi session opens on demand, no prompt replay, immutable original result and inspection disposal",
  );

  await openPopup(rt.store.task(rt.owner, agent.taskId), config.popup.bounds, rt.store);
  const inspection = rt.store.task(rt.owner, agent.taskId).rex_inspection;
  const resumed = rt.submit("agent", {
    name: "Resume fixture",
    resume: agent.taskId,
    explicitRequest: true,
    prompt: "resume fixture",
  });
  assert.equal((await wait(resumed.taskId)).state, "succeeded");
  assert.equal(rt.result(resumed.taskId).agentSession, result.agentSession);
  await gone(inspection, rt.store.task(rt.owner, resumed.taskId).rex_source);
  await rt.drain();
  for (const row of rt.store.all("SELECT * FROM runs")) await gone(row.rex_source, row.rex_block);
  assert.ok(existsSync(result.agentSession!));
  console.log(
    "PASS delegated resume closes inspection first; completed tasks retain no source/viewer PTYs",
  );
} finally {
  for (const row of rt.store.all("SELECT * FROM runs"))
    for (const block of [row.rex_source, row.rex_block, row.rex_inspection])
      if (block) await api(row.rex_session, "block.close", { block_id: block }).catch(() => {});
  rt.close();
  rmSync(root, { recursive: true, force: true });
}
