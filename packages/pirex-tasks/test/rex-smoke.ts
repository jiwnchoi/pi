// Run manually in bg_run: node packages/pirex-tasks/test/rex-smoke.ts
// Creates only its own detached Rex blocks, and cleans them up afterwards.
import assert from "node:assert/strict";
import { stringifyJson } from "../lib/validation.ts";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../lib/runtime.ts";

import { loadConfig } from "../lib/config.ts";
import { api, openPopup, hidePopup } from "../lib/rex.ts";
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
const wait = async (id: string, target: "block" | "terminal" = "terminal"): Promise<TaskRecord> => {
  const deadline = Date.now() + 30000;
  for (;;) {
    await rt.drain();
    const row = rt.store.task(rt.owner, id);
    if (target === "block" ? row.rex_block && row.state === "running" : terminal.has(row.state))
      return row;
    if (target === "block" && terminal.has(row.state))
      throw new Error(
        `Task failed before PTY ready: ${row.state}; ${row.error}\n${rt.result(id).output?.text}\n${readFileSync(row.log_path, "utf8")}`,
      );
    if (Date.now() > deadline) throw new Error(`Timeout: ${stringifyJson(row)}`);
    await delay(150);
  }
};
const tiledLayout = async () => {
  const view = await api<{
    windows: { window_id: string; layers: { kind: string; layout?: unknown }[] }[];
  }>(process.env.REX_SESSION!, "session.view");
  return view.windows.map((window) => ({
    window_id: window.window_id,
    layers: window.layers.filter((layer) => layer.kind === "tiled"),
  }));
};
const parentSize = async () => {
  const size = await api<{ columns: number; rows: number }>(
    process.env.REX_SESSION!,
    "block.method",
    { block_id: process.env.REX_BLOCK, method: "size", args: {} },
  );
  return [size.columns, size.rows];
};
try {
  const originalLayout = await tiledLayout(),
    originalSize = await parentSize();
  const interactive = rt.submit("shell", {
    name: "PTY input smoke",
    command:
      'printf "start\\n" >> starts.txt; printf "INPUT_READY\\n"; read answer; printf "ANSWER=%s\\n" "$answer"',
  });
  const running = await wait(interactive.taskId, "block");
  assert.equal(running.state, "running");
  if (process.env.PIREX_TEST_POPUP === "1") {
    await Promise.all([
      openPopup(running, config.popup.bounds, rt.store),
      openPopup(running, config.popup.bounds, rt.store),
    ]); // concurrent opens create one floating layer
    assert.deepEqual(await tiledLayout(), originalLayout, "Opening must not modify tiled layouts");
    assert.deepEqual(await parentSize(), originalSize, "Opening must not resize the parent PTY");
    await hidePopup(running);
    assert.equal(rt.store.task(rt.owner, interactive.taskId).state, "running");
  }
  const closedBlock = running.rex_block;
  await api(running.rex_session, "block.close", { block_id: closedBlock }); // Rex native X
  assert.equal(rt.store.task(rt.owner, interactive.taskId).state, "running");
  await openPopup(running, config.popup.bounds, rt.store);
  assert.notEqual(running.rex_block, closedBlock);
  await hidePopup(running);
  await api(running.rex_session, "block.method", {
    block_id: running.rex_block,
    method: "write",
    args: { data: "hello-from-rex\n" },
  });
  assert.equal((await wait(interactive.taskId)).state, "succeeded");
  assert.match(rt.result(interactive.taskId).output?.text || "", /ANSWER=hello-from-rex/);
  assert.equal(readFileSync(join(root, "starts.txt"), "utf8"), "start\n");
  assert.equal(
    rt.store.all("SELECT * FROM events WHERE run_id=? AND type='running'", interactive.runId)
      .length,
    1,
  );
  console.log("PASS native X close/reopen preserves the same PTY and executes the command once");
  await api(running.rex_session, "block.close", { block_id: running.rex_block });
  const completed = rt.store.task(rt.owner, interactive.taskId);
  await openPopup(completed, config.popup.bounds, rt.store);
  await hidePopup(completed);
  assert.deepEqual(await tiledLayout(), originalLayout);
  assert.deepEqual(await parentSize(), originalSize);
  console.log("PASS direct floating popup creation preserves parent layout and terminal size");
  await delay(500);
  await api(completed.rex_session, "block.method", {
    block_id: completed.rex_block,
    method: "write",
    args: { data: "printf manual-followup > manual.txt\n" },
  });
  for (let i = 0; i < 40 && !existsSync(join(root, "manual.txt")); i++) await delay(100);
  assert.equal(readFileSync(join(root, "manual.txt"), "utf8"), "manual-followup");
  assert.equal(rt.store.task(rt.owner, interactive.taskId).state, "succeeded");
  assert.doesNotMatch(rt.result(interactive.taskId).output?.text || "", /manual-followup/);
  console.log(
    "PASS completed task native shell accepts user commands without changing original results",
  );
  const failed = rt.submit("shell", { name: "Nonzero smoke", command: "exit 7" });
  assert.equal((await wait(failed.taskId)).exit_code, 7);
  console.log("PASS nonzero exit");
  const timeout = rt.submit("shell", {
    name: "Timeout smoke",
    command: "sleep 20",
    timeoutSeconds: 0.6,
  });
  assert.equal((await wait(timeout.taskId)).state, "timed_out");
  console.log("PASS timeout");
  const stopped = rt.submit("shell", { name: "Stop smoke", command: "sleep 20" });
  const stoppedRunning = await wait(stopped.taskId, "block");
  await api(stoppedRunning.rex_session, "block.close", { block_id: stoppedRunning.rex_block });
  rt.store.control(rt.owner, stopped.taskId, "stop");
  assert.equal((await wait(stopped.taskId)).state, "stopped");
  console.log("PASS asynchronous stop");
  const code = rt.submit("code", {
    name: "Workflow smoke",
    code: 'const a = await tasks.shell({name:"Child A", command:"printf child-a"}); const b = await tools.task_run({name:"Child B", command:"printf child-b"}); text("submitted"); return {a:a.taskId,b:b.taskId};',
  });
  const workflow = await wait(code.taskId);
  assert.equal(workflow.state, "succeeded", stringifyJson(rt.result(code.taskId)));
  assert.match(rt.result(code.taskId).output?.text || "", /child-a/);
  console.log("PASS codemode workflow and child aggregation");
  const agent = rt.submit("agent", {
    name: "RPC fixture smoke",
    explicitRequest: true,
    prompt: "fixture only",
  });
  const agentRunning = await wait(agent.taskId, "block");
  await api(agentRunning.rex_session, "block.close", { block_id: agentRunning.rex_block });
  await openPopup(agentRunning, config.popup.bounds, rt.store);
  await hidePopup(agentRunning);
  rt.store.control(rt.owner, agent.taskId, "steer", "steer fixture");
  await api(agentRunning.rex_session, "block.method", {
    block_id: agentRunning.rex_block,
    method: "write",
    args: { data: "human popup message\n" },
  });
  assert.equal(
    (await wait(agent.taskId)).state,
    "succeeded",
    stringifyJson(rt.result(agent.taskId)),
  );
  const result = rt.result(agent.taskId);
  assert.match(result.output?.text || "", /fixture result 한글/);
  assert.match(readFileSync(result.agentSession!, "utf8"), /steer fixture/);
  assert.match(readFileSync(result.agentSession!, "utf8"), /human popup message/);
  const resumed = rt.submit("agent", {
    name: "Resume fixture",
    resume: agent.taskId,
    explicitRequest: true,
    prompt: "resume fixture",
  });
  assert.equal(resumed.taskId, agent.taskId);
  assert.notEqual(resumed.runId, agent.runId);
  assert.equal((await wait(resumed.taskId)).state, "succeeded");
  assert.equal(rt.result(resumed.taskId).agentSession, result.agentSession);
  assert.equal(
    (
      await api<{ blocks: { block_id: string }[] }>(agentRunning.rex_session, "session.list_blocks")
    ).blocks.some((block) => block.block_id === agentRunning.rex_source),
    false,
    "Resume must dispose the previous native UI before reusing its session",
  );
  assert.equal(
    (
      await api<{ blocks: { block_id: string }[] }>(agentRunning.rex_session, "session.list_blocks")
    ).blocks.some((block) => block.block_id === rt.store.task(rt.owner, resumed.taskId).rex_source),
    true,
    "Completed native UI remains inspectable",
  );
  await openPopup(rt.store.task(rt.owner, resumed.taskId), config.popup.bounds, rt.store);
  await hidePopup(rt.store.task(rt.owner, resumed.taskId));
  console.log(
    "PASS native PTY agent fixture, steering, human input, inspectable completion and resume (no model calls)",
  );
  const fresh = new Runtime(root, rt.owner, config, rt.context);
  assert.equal(fresh.result(interactive.taskId).state, "succeeded");
  fresh.close();
  console.log("PASS reopen SQLite; all Rex smoke tests passed");
} finally {
  for (const row of rt.store.all("SELECT * FROM runs")) {
    if (row.rex_source)
      await api(row.rex_session, "block.close", { block_id: row.rex_source }).catch(() => {});
    else {
      try {
        rt.store.control(rt.owner, row.task_id, "stop");
      } catch {}
    }
    if (row.rex_block)
      await api(row.rex_session, "block.close", { block_id: row.rex_block }).catch(() => {});
  }
  rt.close();
  rmSync(root, { recursive: true, force: true });
}
