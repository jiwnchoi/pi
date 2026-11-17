import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Store, terminal } from "../lib/store.ts";
import { parseSpec } from "../lib/validation.ts";
import { agentArgs, agentCommand } from "./agent.ts";
import type { RunRecord } from "../lib/types.ts";

const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error("Usage: resume.ts ROOT RUN");
const store = new Store(root);
let spec;
let sessionPath: string;
let systemPath: string;
try {
  const row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
  const task = store.required<{ kind: string; current_run: string }>(
    "SELECT kind,current_run FROM tasks WHERE id=?",
    row.task_id,
  );
  if (task.kind !== "agent" || !terminal.has(row.state) || task.current_run !== runId)
    throw new Error("Only the current completed agent session can be opened");
  sessionPath = store.required<{ path: string }>(
    "SELECT path FROM agent_sessions WHERE task_id=?",
    row.task_id,
  ).path;
  if (!existsSync(sessionPath))
    throw new Error("No saved Pi session; inspect the task logs instead");
  spec = parseSpec(row);
  systemPath = join(dirname(row.log_path), "system-prompt.md");
  writeFileSync(systemPath, spec.systemPrompt || "", { mode: 0o600 });
} finally {
  store.close();
}
const runtime = spec.config.agent_runtime;
const env = { ...process.env };
for (const key of [
  "PIREX_TASK_ROOT",
  "PIREX_TASK_RUN_ID",
  "PIREX_TASK_EVENTS",
  "PIREX_TASK_ANCHOR",
])
  delete env[key];
const child = spawn(
  runtime.bootstrap_shell,
  [
    ...(basename(runtime.bootstrap_shell) === "zsh" ? ["-f"] : []),
    ...runtime.bootstrap_args,
    agentCommand(runtime),
    "pirex-resume",
    ...agentArgs(spec, sessionPath, systemPath, false),
  ],
  { cwd: spec.cwd, env, stdio: "inherit" },
);
let killTimer: ReturnType<typeof setTimeout> | undefined;
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
  process.on(signal, () => {
    child.kill(signal);
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3000);
    killTimer.unref();
  });
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  if (killTimer) clearTimeout(killTimer);
  process.exitCode = code ?? 1;
});
