import { spawn, type ChildProcess } from "node:child_process";
import { Worker } from "node:worker_threads";
import { appendFileSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Store, terminal } from "../lib/store.ts";
import { RexControl } from "../lib/rex-socket.ts";
import { parseSpec, decodeJson, stringifyJson } from "../lib/validation.ts";
import {
  errorMessage,
  type ControlRecord,
  type RunRecord,
  type TaskKind,
  type TaskState,
} from "../lib/types.ts";
import { agentCommand } from "./agent.ts";
const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error("Usage: native-source.ts ROOT RUN");
process.umask(0o077);
const store = new Store(root),
  row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
const task = store.required<{ owner: string; kind: TaskKind }>(
  "SELECT owner,kind FROM tasks WHERE id=?",
  row.task_id,
);
const spec = parseSpec(row),
  source = process.env.REX_BLOCK;
if (!source) throw new Error("Native task must run inside a Rex block");
const admitted = store.tx(() => {
  const live = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
  if (live.started || terminal.has(live.state)) return false;
  store.exec(
    "UPDATE runs SET rex_source=?,state=CASE WHEN state='stop_requested' THEN state ELSE 'running' END,started=?,heartbeat=? WHERE id=?",
    source,
    Date.now(),
    Date.now(),
    runId,
  );
  store.event(runId, "running", { pid: process.pid, source });
  return true;
});
if (!admitted) process.exit(0);
let control: RexControl | undefined,
  stream: Awaited<ReturnType<RexControl["terminal"]>> | undefined;
let child: ChildProcess | undefined,
  worker: Worker | undefined,
  tick: ReturnType<typeof setInterval> | undefined,
  killTimer: ReturnType<typeof setTimeout> | undefined;
let finished = false,
  shuttingDown = false,
  stopCause: "stopped" | "timed_out" | undefined;
const resultPath = join(dirname(row.log_path), "result.txt");
const eventsPath = join(dirname(row.log_path), "native-events.jsonl");
let eventOffset = 0,
  eventBuffer = "";
const decoder = new StringDecoder("utf8");
const eventSchema = Type.Union([
  Type.Object({ type: Type.Literal("ready"), mode: Type.String() }),
  Type.Object({
    type: Type.Literal("settled"),
    text: Type.String(),
    error: Type.Optional(Type.String()),
  }),
]);
function output(text: string): void {
  process.stdout.write(text);
}
function cleanup(): void {
  if (tick) clearInterval(tick);
  if (killTimer) clearTimeout(killTimer);
  stream?.close();
  control?.close();
}
async function snapshot(): Promise<string> {
  if (!control) return "";
  const value = await control.request("block.method", {
    session_id: row.rex_session,
    block_id: source,
    method: "format",
    args: { format: "text", trim: true },
  });
  Value.Assert(Type.Object({ content: Type.String() }), value);
  return value.content;
}
function finish(state: TaskState, code: number | null, error?: string, path?: string): void {
  if (finished) return;
  finished = true;
  if (tick) clearInterval(tick);
  store.finish(runId, stopCause || state, code, error, path);
  if (stopCause || (!spec.persistentShell && task.kind !== "agent")) cleanup();
}
function stop(cause: "stopped" | "timed_out"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!finished) stopCause = cause;
  const descendants = store.all<{ task_id: string; state: TaskState }>(
    `WITH RECURSIVE children(id) AS (SELECT id FROM runs WHERE parent_run=? UNION ALL SELECT r.id FROM runs r JOIN children c ON r.parent_run=c.id) SELECT r.task_id,r.state FROM runs r JOIN children c ON c.id=r.id`,
    runId,
  );
  for (const item of descendants)
    if (!terminal.has(item.state))
      try {
        store.control(task.owner, item.task_id, "stop");
      } catch {}
  if (worker) {
    void worker.terminate().finally(() => {
      finish(cause, null);
      cleanup();
    });
    return;
  }
  const target = child;
  if (!target?.pid) {
    finish(cause, null);
    cleanup();
    return;
  }
  try {
    process.kill(-target.pid, "SIGTERM");
  } catch {
    target.kill("SIGTERM");
  }
  killTimer = setTimeout(() => {
    try {
      process.kill(-target.pid!, "SIGKILL");
    } catch {
      target.kill("SIGKILL");
    }
  }, 3000);
  killTimer.unref();
}
function launch(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  onExit?: (code: number, signal: NodeJS.Signals | null) => void,
): void {
  child = spawn(file, args, { cwd: spec.cwd, stdio: "inherit", env });
  child.once("error", (error) => {
    finish("failed", null, errorMessage(error));
    cleanup();
  });
  child.once("exit", (code, signal) => {
    if (killTimer) clearTimeout(killTimer);
    child = undefined;
    if (shuttingDown) {
      if (!finished) finish(stopCause || "stopped", code, signal || undefined);
      cleanup();
    } else onExit?.(code ?? 1, signal);
  });
}
function readEvents(): void {
  let fd: number;
  try {
    fd = openSync(eventsPath, "r");
  } catch {
    return;
  }
  try {
    const bytes = Buffer.alloc(65536);
    let n: number;
    while ((n = readSync(fd, bytes, 0, bytes.length, eventOffset)) > 0) {
      eventOffset += n;
      eventBuffer += decoder.write(bytes.subarray(0, n));
      if (eventBuffer.length > 16 * 1024 * 1024) throw new Error("Agent event exceeded 16 MiB");
      let at: number;
      while ((at = eventBuffer.indexOf("\n")) >= 0) {
        const line = eventBuffer.slice(0, at);
        eventBuffer = eventBuffer.slice(at + 1);
        const event = decodeJson(line, eventSchema);
        if (event.type === "ready" && event.mode !== "tui")
          throw new Error("Expected native Pi TUI");
        if (event.type === "settled" && !finished) {
          writeFileSync(resultPath, event.text, { mode: 0o600 });
          finish(
            event.error ? "failed" : "succeeded",
            event.error ? 1 : 0,
            event.error,
            resultPath,
          );
        }
      }
    }
  } finally {
    closeSync(fd);
  }
}
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const)
  process.on(signal, () => stop("stopped"));
process.once("beforeExit", () => {
  cleanup();
  store.close();
});
try {
  writeFileSync(row.log_path, "", { mode: 0o600 });
  control = await RexControl.open();
  await control.request("session.attach", { session_id: row.rex_session });
  stream = await control.terminal(row.rex_session, source, (bytes) =>
    appendFileSync(row.log_path, bytes, { mode: 0o600 }),
  );
  control.on("disconnect", () => {
    if (!shuttingDown && !finished) store.event(runId, "terminal_log_disconnected");
  });
  if (store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId).state === "stop_requested")
    stop("stopped");
  else if (task.kind === "shell") {
    launch(
      spec.config.execution.shell,
      ["-l", ...spec.config.execution.shell_args, spec.command || ""],
      process.env,
      (code, signal) => {
        void snapshot()
          .then((text) => {
            writeFileSync(resultPath, text, { mode: 0o600 });
            finish(
              code === 0 ? "succeeded" : code === 130 ? "stopped" : "failed",
              code,
              signal || undefined,
              resultPath,
            );
            if (spec.persistentShell && !shuttingDown)
              launch(spec.config.execution.shell, ["-li"], process.env, () => cleanup());
            else cleanup();
          })
          .catch((error) => {
            store.event(runId, "terminal_snapshot_failed", { error: errorMessage(error) });
            finish(
              code === 0 ? "succeeded" : code === 130 ? "stopped" : "failed",
              code,
              signal || undefined,
              row.log_path,
            );
            if (spec.persistentShell && !shuttingDown)
              launch(spec.config.execution.shell, ["-li"], process.env, () => cleanup());
            else cleanup();
          });
      },
    );
  } else if (task.kind === "agent") {
    const agent = spec.agent;
    if (!agent?.provider || !agent.model) throw new Error("Agent model missing");
    const session = store.required<{ path: string }>(
      "SELECT path FROM agent_sessions WHERE task_id=?",
      row.task_id,
    );
    const systemPath = join(dirname(row.log_path), "system-prompt.md");
    writeFileSync(systemPath, spec.systemPrompt || "", { mode: 0o600 });
    const args = [
      "--session",
      session.path,
      "-e",
      fileURLToPath(new URL("./agent-bridge.ts", import.meta.url)),
      "--provider",
      agent.provider,
      "--model",
      agent.model,
      "--thinking",
      agent.thinking || "off",
      "--append-system-prompt",
      systemPath,
    ];
    if (agent.tools) args.push("--tools", agent.tools.join(","));
    const runtime = spec.config.agent_runtime;
    launch(
      runtime.bootstrap_shell,
      [
        ...(basename(runtime.bootstrap_shell) === "zsh" ? ["-f"] : []),
        ...runtime.bootstrap_args,
        agentCommand(runtime),
        "pirex-agent",
        ...args,
      ],
      {
        ...process.env,
        PIREX_TASK_ANCHOR: spec.anchor,
        PIREX_TASK_ROOT: root,
        PIREX_TASK_RUN_ID: runId,
        PIREX_TASK_EVENTS: eventsPath,
      },
      (code) => {
        readEvents();
        if (!finished) finish("failed", code || 1, "Agent exited before completion");
        cleanup();
      },
    );
  } else {
    worker = new Worker(new URL("./code.ts", import.meta.url), {
      workerData: { root, runId, owner: task.owner, spec },
    });
    worker.on(
      "message",
      (message: { type: string; text?: string; result?: unknown; error?: string }) => {
        if (message.type === "output") output(message.text || "");
        if (message.type === "result") {
          writeFileSync(resultPath, stringifyJson(message.result, 2), { mode: 0o600 });
          finish(
            message.error ? "failed" : "succeeded",
            message.error ? 1 : 0,
            message.error,
            resultPath,
          );
          void worker?.terminate();
        }
      },
    );
    worker.on("error", (error) => finish("failed", null, errorMessage(error)));
    worker.on("exit", (code) => {
      if (!finished) finish("failed", code, "Workflow exited without result");
      cleanup();
    });
  }
  if (!finished && !shuttingDown) {
    const started = Date.now();
    tick = setInterval(() => {
      try {
        store.exec("UPDATE runs SET heartbeat=? WHERE id=?", Date.now(), runId);
        for (const item of store.all<ControlRecord>(
          "SELECT * FROM controls WHERE run_id=? AND state='pending' ORDER BY created",
          runId,
        )) {
          if (item.type === "stop") {
            store.exec("UPDATE controls SET state='delivered' WHERE id=?", item.id);
            stop("stopped");
          } else if (task.kind === "agent")
            store.exec("UPDATE controls SET state='sending' WHERE id=?", item.id);
          else
            store.exec(
              "UPDATE controls SET state='failed',error='Agent unavailable' WHERE id=?",
              item.id,
            );
        }
        if (task.kind === "agent") readEvents();
        if (!finished && spec.timeoutSeconds && Date.now() - started >= spec.timeoutSeconds * 1000)
          stop("timed_out");
      } catch (error) {
        if (!finished) finish("failed", null, errorMessage(error));
        stop("stopped");
      }
    }, 200);
  }
} catch (error) {
  finish("failed", null, errorMessage(error));
  cleanup();
}
