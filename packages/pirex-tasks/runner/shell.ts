import { readFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { startPty, type TerminalHandle } from "./terminal.ts";
import type { TaskSpec } from "../lib/types.ts";
/** The admitted command runs once; then the same PTY becomes a normal user shell. */
export function startPersistentShell({
  spec,
  logPath,
  output,
  completed,
  closed,
}: {
  spec: TaskSpec;
  logPath: string;
  output(text: string): void;
  completed(code: number, resultPath?: string): void;
  closed(): void;
}): TerminalHandle {
  const status = join(dirname(logPath), "command-exit");
  const snapshot = join(dirname(logPath), "command-output.log");
  let settled = false;
  const check = () => {
    if (settled) return;
    let text: string;
    try {
      text = readFileSync(status, "utf8");
    } catch {
      return;
    }
    const code = Number(text.trim());
    Value.Assert(Type.Integer({ minimum: 0, maximum: 255 }), code);
    settled = true;
    clearInterval(timer);
    copyFileSync(logPath, snapshot);
    completed(code, snapshot);
  };
  const script =
    'status_file=$1; user_shell=$2; shift 2\n"$@"\ncode=$?\nprintf "%s\\n" "$code" > "$status_file"\nexec "$user_shell" -li';
  const pty = startPty({
    file: "/bin/sh",
    args: [
      "-c",
      script,
      "pirex-shell",
      status,
      spec.config.execution.shell,
      spec.config.execution.shell,
      "-l",
      ...spec.config.execution.shell_args,
      spec.command || "",
    ],
    cwd: spec.cwd,
    output,
    completed(code) {
      check();
      if (!settled) {
        settled = true;
        completed(code);
      }
      clearInterval(timer);
      closed();
    },
  });
  const timer = setInterval(check, 100);
  return {
    ...pty,
    dispose() {
      clearInterval(timer);
      pty.dispose();
    },
  };
}
