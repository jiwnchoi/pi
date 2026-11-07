import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { Store, terminal } from "../lib/store.ts";
import { parseSpec, stringifyJson } from "../lib/validation.ts";
import { ConsoleHub, socketPath } from "../lib/channel.ts";
import {
  errorMessage,
  type ControlRecord,
  type RunRecord,
  type TaskKind,
  type TaskState,
} from "../lib/types.ts";
import { startAgent, type AgentHandle } from "./agent.ts";
import { startTerminal, type TerminalHandle } from "./terminal.ts";
import { startPersistentShell } from "./shell.ts";

const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error("Usage: node main.ts ROOT RUN_ID");
process.umask(0o077);
const store = new Store(root);
const row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
const task = store.required<{ owner: string; kind: TaskKind; name: string }>(
  "SELECT owner,kind,name FROM tasks WHERE id=?",
  row.task_id,
);
const spec = parseSpec(row);
const hub = new ConsoleHub(socketPath(root, runId), row.log_path);
const admission = store.tx(() => {
  const live = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
  if (!["starting", "unknown", "stop_requested"].includes(live.state) || live.started) return false;
  store.exec(
    "UPDATE runs SET state=CASE WHEN state='stop_requested' THEN state ELSE 'running' END,started=?,heartbeat=? WHERE id=?",
    Date.now(),
    Date.now(),
    runId,
  );
  store.event(runId, "running", { pid: process.pid });
  return true;
});
if (!admission) process.exit(0);
try {
  await hub.listen();
} catch (error) {
  store.finish(runId, "failed", null, errorMessage(error));
  store.close();
  throw error;
}
process.once("beforeExit", () => store.close());
let finished = false;
let stopCause: "stopped" | "timed_out" | undefined;
let shell: TerminalHandle | undefined;
let agent: AgentHandle | undefined;
let worker: Worker | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let latestSize: [number, number] = [80, 24];
const output = (text: string): void => {
  appendFileSync(row.log_path, text, { mode: 0o600 });
  hub.output(text);
};
const finish = (
  state: TaskState,
  code?: number | null,
  error?: string,
  resultPath?: string,
): void => {
  if (finished) return;
  finished = true;
  if (heartbeat) clearInterval(heartbeat);
  store.finish(runId, stopCause || state, code, error, resultPath);
  if ((agent?.isAlive() || (spec.persistentShell && shell?.isAlive())) && !stopCause) return; // Retain the real Pi TUI for inspection until explicit close/resume.
  agent?.dispose();
  shell?.dispose();

  hub.close();
  if (worker) void worker.terminate();
  if (agent) {
    const handle = agent;
    const timer = setTimeout(() => handle.stop(), 1000);
    timer.unref();
  }
};
const stop = (cause: "stopped" | "timed_out"): void => {
  if (finished || stopCause) return;
  stopCause = cause;
  const cascade = (): void => {
    const descendants = store.all<{ task_id: string; state: TaskState }>(
      `WITH RECURSIVE children(id) AS (
      SELECT id FROM runs WHERE parent_run=? UNION ALL SELECT r.id FROM runs r JOIN children c ON r.parent_run=c.id
    ) SELECT r.task_id,r.state FROM runs r JOIN children c ON c.id=r.id`,
      runId,
    );
    for (const child of descendants)
      if (!terminal.has(child.state)) {
        try {
          store.control(task.owner, child.task_id, "stop");
        } catch {
          /* Concurrent completion is harmless. */
        }
      }
  };
  agent?.stop();
  shell?.stop();
  if (worker) {
    void worker.terminate().finally(() => {
      cascade();
      finish(cause, null, cause === "timed_out" ? "Task timeout exceeded" : "Stopped by request");
    });
  } else if (!agent && !shell) finish(cause, null, "Stopped before process startup");
};
process.on("SIGTERM", () => {
  if (finished && (agent?.isAlive() || shell?.isAlive())) {
    agent?.stop();
    shell?.stop();
    return;
  }
  if (finished) process.exit(0);
  stop("stopped");
});
process.on("SIGHUP", () => {
  if (finished && (agent?.isAlive() || shell?.isAlive())) {
    agent?.stop();
    shell?.stop();
    return;
  }
  if (finished) process.exit(0);
  stop("stopped");
});
process.on("SIGINT", () => stop("stopped"));
const started = Date.now();
heartbeat = setInterval(() => {
  try {
    store.exec("UPDATE runs SET heartbeat=? WHERE id=?", Date.now(), runId);
    const controls = store.all<ControlRecord>(
      "SELECT * FROM controls WHERE run_id=? AND state='pending' ORDER BY created",
      runId,
    );
    for (const control of controls) {
      if (control.type === "stop") {
        store.exec("UPDATE controls SET state='delivered' WHERE id=?", control.id);
        stop("stopped");
      } else {
        try {
          if (!agent || finished) throw new Error("Agent not available");
          store.exec("UPDATE controls SET state='sending' WHERE id=?", control.id);
          agent.steer(control.message || "", control.id);
        } catch (e) {
          store.exec(
            "UPDATE controls SET state='failed',error=? WHERE id=?",
            errorMessage(e),
            control.id,
          );
        }
      }
    }
    if (spec.timeoutSeconds && Date.now() - started >= spec.timeoutSeconds * 1000)
      stop("timed_out");
  } catch (e) {
    output(`\n[Task controller error: ${errorMessage(e)}]\n`);
    stop("stopped");
  }
}, 250);

hub.input = (data) => {
  if (!finished || spec.persistentShell) shell?.input(data);
  agent?.input(data);
};
hub.resize = (columns, rows) => {
  latestSize = [columns, rows];
  shell?.resize(columns, rows);
  agent?.resize(columns, rows);
};
hub.dispose = () => {
  if (finished) {
    if (agent?.isAlive()) agent.stop();
    else if (shell?.isAlive()) shell.stop();
    else hub.close();
  }
};
try {
  const current = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
  if (current.state === "stop_requested") stop("stopped");
  else if (task.kind === "shell" && spec.persistentShell) {
    shell = startPersistentShell({
      spec,
      logPath: row.log_path,
      output,
      completed: (code, path) =>
        finish(
          code === 0 ? "succeeded" : code === 130 ? "stopped" : "failed",
          code,
          undefined,
          path,
        ),
      closed: () => {
        shell?.dispose();
        hub.close();
      },
    });
    shell.resize(...latestSize);
  } else if (task.kind === "shell") {
    shell = startTerminal({
      spec,
      output,
      completed: (code, signal) =>
        finish(
          code === 0 ? "succeeded" : code === 130 || signal === 2 ? "stopped" : "failed",
          code,
          signal ? `Signal ${signal}` : undefined,
        ),
    });
  } else if (task.kind === "agent") {
    agent = startAgent({
      store,
      row,
      spec,
      output,
      completed: finish,
      closed: () => {
        agent?.dispose();
        hub.close();
      },
    });
    agent.resize(...latestSize);
  } else {
    worker = new Worker(new URL("./code.ts", import.meta.url), {
      workerData: { root, runId, owner: task.owner, spec },
    });
    worker.on(
      "message",
      (message: { type: string; text?: string; result?: unknown; error?: string }) => {
        if (message.type === "output") output(message.text || "");
        else if (message.type === "result") {
          const path = join(dirname(row.log_path), "result.json");
          writeFileSync(path, stringifyJson(message.result, 2), { mode: 0o600 });
          finish(
            message.error ? "failed" : "succeeded",
            message.error ? 1 : 0,
            message.error,
            path,
          );
        }
      },
    );
    worker.on("error", (e) => finish("failed", null, errorMessage(e)));
    worker.on("exit", (code) => {
      if (!finished) finish("failed", code, "Workflow worker exited without result");
    });
  }
} catch (e) {
  finish("failed", null, errorMessage(e));
}
