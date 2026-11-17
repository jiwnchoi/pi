import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, terminal } from "../lib/store.ts";
import { savedLog } from "../lib/runtime.ts";
import type { RunRecord } from "../lib/types.ts";

export async function showLogs(root: string, runId: string): Promise<void> {
  const store = new Store(root);
  let path: string;
  try {
    const row = store.required<RunRecord & { name: string }>(
      "SELECT r.*,t.name FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=?",
      runId,
    );
    if (!terminal.has(row.state)) throw new Error("Only completed tasks have saved log views");
    path = join(dirname(row.log_path), "inspection.txt");
    writeFileSync(path, savedLog(row), { mode: 0o600 });
  } finally {
    store.close();
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/less", ["--", path], {
      stdio: "inherit",
      env: {
        ...process.env,
        LESS: "",
        LESSOPEN: "",
        LESSCLOSE: "",
        LESSSECURE: "1",
        LESSHISTFILE: "-",
      },
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
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
      reject(error);
    });
    child.once("exit", (code) => {
      cleanup();
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, runId] = process.argv.slice(2);
  if (!root || !runId) throw new Error("Usage: logs.ts ROOT RUN");
  await showLogs(root, runId);
}
