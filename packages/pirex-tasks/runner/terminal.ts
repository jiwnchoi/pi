import { spawn } from "node-pty";
import { preparePtyHelper } from "./pty-helper.ts";
import type { TaskSpec } from "../lib/types.ts";
export interface TerminalHandle {
  isAlive(): boolean;
  input(data: string): void;
  resize(columns: number, rows: number): void;
  stop(): void;
  dispose(): void;
}
interface PtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  redrawOnResize?: boolean;
  output(text: string): void;
  completed(code: number, signal?: number): void;
}
export function startPty({
  file,
  args,
  cwd,
  env,
  redrawOnResize,
  output,
  completed,
}: PtyOptions): TerminalHandle {
  preparePtyHelper();
  const terminal = spawn(file, args, {
    name: process.env.TERM || "xterm-256color",
    cwd,
    cols: 80,
    rows: 24,
    env:
      env ||
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
  });
  let exited = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  terminal.onData(output);
  terminal.onExit((event) => {
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    completed(event.exitCode, event.signal);
  });
  return {
    isAlive: () => !exited,
    input(data) {
      if (!exited) terminal.write(data);
    },
    resize(columns, rows) {
      if (!exited) {
        terminal.resize(columns, rows);
        if (redrawOnResize)
          try {
            process.kill(terminal.pid, "SIGWINCH");
          } catch {}
      }
    },
    stop() {
      if (exited) return;
      try {
        process.kill(-terminal.pid, "SIGTERM");
      } catch {
        terminal.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        if (exited) return;
        try {
          process.kill(-terminal.pid, "SIGKILL");
        } catch {
          terminal.kill("SIGKILL");
        }
      }, 3000);
      killTimer.unref();
    },
    dispose() {
      if (killTimer) clearTimeout(killTimer);
    },
  };
}
/** The detached controller owns the PTY; Rex viewers only forward input and resize. */
export function startTerminal({
  spec,
  output,
  completed,
}: {
  spec: TaskSpec;
  output(text: string): void;
  completed(code: number, signal?: number): void;
}): TerminalHandle {
  return startPty({
    file: spec.config.execution.shell,
    args: [...spec.config.execution.shell_args, spec.command || ""],
    cwd: spec.cwd,
    output,
    completed,
  });
}
