import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Store, terminal } from "../lib/store.ts";
import { parseSpec } from "../lib/validation.ts";
import { agentArgs, agentCommand } from "./agent.ts";
import { errorMessage, type RunRecord } from "../lib/types.ts";
import { showLogs } from "./logs.ts";

const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error("Usage: resume.ts ROOT RUN");
const store = new Store(root);
let spec;
let sessionPath: string | undefined;
let systemPath: string;
try {
  const row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
  const task = store.required<{ kind: string; current_run: string }>(
    "SELECT kind,current_run FROM tasks WHERE id=?",
    row.task_id,
  );
  if (task.kind !== "agent" || !terminal.has(row.state) || task.current_run !== runId)
    throw new Error("Only the current completed agent session can be opened");
  sessionPath = store.get<{ path: string }>(
    "SELECT path FROM agent_sessions WHERE task_id=?",
    row.task_id,
  )?.path;
  spec = parseSpec(row);
  systemPath = join(dirname(row.log_path), "system-prompt.md");
  writeFileSync(systemPath, spec.systemPrompt || "", { mode: 0o600 });
} finally {
  store.close();
}
if (!sessionPath || !existsSync(sessionPath)) {
  await showLogs(root, runId);
} else {
  const runtime = spec.config.agent_runtime;
  const env = { ...process.env };
  for (const key of [
    "PIREX_TASK_ROOT",
    "PIREX_TASK_RUN_ID",
    "PIREX_TASK_EVENTS",
    "PIREX_TASK_ANCHOR",
  ])
    delete env[key];
  let closing = false;
  const outcome = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    const child = spawn(
      runtime.bootstrap_shell,
      [
        ...(basename(runtime.bootstrap_shell) === "zsh" ? ["-f"] : []),
        ...runtime.bootstrap_args,
        agentCommand(runtime),
        "pirex-resume",
        ...agentArgs(spec, sessionPath!, systemPath, false),
      ],
      { cwd: spec.cwd, env, stdio: "inherit" },
    );
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      closing = true;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.off(signal, stop);
    };
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, stop);
    child.once("error", (error) => {
      cleanup();
      resolve({ code: null, error: errorMessage(error) });
    });
    child.once("close", (code, signal) => {
      cleanup();
      resolve({ code, error: signal || undefined });
    });
  }).catch((error: unknown) => ({ code: null, error: errorMessage(error) }));
  if (!closing && outcome.code !== 0) {
    await showLogs(
      root,
      runId,
      `Unable to reopen Pi (${outcome.error || "exit " + outcome.code}). Showing saved logs; press q to close.`,
    );
  } else {
    process.exitCode = closing ? 0 : (outcome.code ?? 1);
  }
}
