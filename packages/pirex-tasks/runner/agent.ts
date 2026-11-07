import { openSync, closeSync, readSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { decodeJson } from "../lib/validation.ts";
import { startPty, type TerminalHandle } from "./terminal.ts";
import type { Store } from "../lib/store.ts";
import type { RunRecord, TaskSpec, TaskState } from "../lib/types.ts";
export interface AgentHandle extends TerminalHandle {
  steer(message: string, id: string): void;
  isAlive(): boolean;
}
interface AgentOptions {
  store: Store;
  row: RunRecord;
  spec: TaskSpec;
  output(text: string): void;
  completed(state: TaskState, code: number, error?: string, resultPath?: string): void;
  closed(): void;
}
const eventSchema = Type.Union([
  Type.Object({ type: Type.Literal("ready"), mode: Type.String() }),
  Type.Object({
    type: Type.Literal("settled"),
    text: Type.String(),
    error: Type.Optional(Type.String()),
  }),
]);
export function agentCommand(runtime: TaskSpec["config"]["agent_runtime"]): string {
  if (basename(runtime.bootstrap_shell) !== "zsh") return `exec ${runtime.executable} "$@"`;
  return `source ~/.zshrc >/dev/null 2>&1
pirex_executable=${runtime.executable}
if (( \${+aliases[$pirex_executable]} )); then
  eval 'exec '"\${aliases[$pirex_executable]}"' "$@"'
else
  exec "$pirex_executable" "$@"
fi`;
}
export function startAgent({
  store,
  row,
  spec,
  output,
  completed,
  closed,
}: AgentOptions): AgentHandle {
  const session = store.required<{ path: string }>(
    "SELECT path FROM agent_sessions WHERE task_id=?",
    row.task_id,
  );
  const agent = spec.agent;
  if (!agent?.provider || !agent.model) throw new Error("Agent model settings missing");
  const systemPath = join(dirname(row.log_path), "system-prompt.md");
  const eventsPath = join(dirname(row.log_path), "native-events.jsonl");
  const resultPath = join(dirname(row.log_path), "result.txt");
  const bridgePath = fileURLToPath(new URL("./agent-bridge.ts", import.meta.url));
  writeFileSync(systemPath, spec.systemPrompt || "", { mode: 0o600 });
  const args = [
    "--session",
    session.path,
    "-e",
    bridgePath,
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
  const zsh = basename(runtime.bootstrap_shell) === "zsh";
  // -f suppresses automatic RC loading; source once, quietly, then expand pi's alias at eval time.
  // The executable is config-validated and every variable argument remains positional and quoted.
  const command = agentCommand(runtime);
  let alive = true,
    settled = false,
    offset = 0,
    buffer = "";
  const decoder = new StringDecoder("utf8");
  const drainEvents = (): void => {
    let fd: number;
    try {
      fd = openSync(eventsPath, "r");
    } catch {
      return;
    }
    try {
      const bytes = Buffer.alloc(65536);
      let n: number;
      while ((n = readSync(fd, bytes, 0, bytes.length, offset)) > 0) {
        offset += n;
        buffer += decoder.write(bytes.subarray(0, n));
        if (buffer.length > 16 * 1024 * 1024) throw new Error("Native agent event exceeded 16 MiB");
        let at: number;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 1);
          const event = decodeJson(line, eventSchema);
          if (event.type === "ready" && event.mode !== "tui")
            throw new Error("Child Pi did not start in native TUI mode");
          if (event.type === "settled" && !settled) {
            settled = true;
            clearInterval(timer);
            writeFileSync(resultPath, event.text, { mode: 0o600 });
            completed(
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
  };
  const terminal = startPty({
    file: runtime.bootstrap_shell,
    args: [...(zsh ? ["-f"] : []), ...runtime.bootstrap_args, command, "pirex-agent", ...args],
    cwd: spec.cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      REX_BLOCK: spec.anchor || "",
      REX_SESSION: row.rex_session,
      PIREX_TASK_ROOT: store.root,
      PIREX_TASK_RUN_ID: row.id,
      PIREX_TASK_EVENTS: eventsPath,
    },
    output,
    redrawOnResize: true,
    completed(code, signal) {
      alive = false;
      clearInterval(timer);
      try {
        drainEvents();
      } catch (error) {
        if (!settled) {
          settled = true;
          completed("failed", 1, String(error));
        }
      }
      if (!settled) {
        settled = true;
        completed(
          "failed",
          code || 1,
          `Agent exited before completing its delegated turn (${code || signal || "exit"})`,
        );
      }
      closed();
    },
  });
  const timer = setInterval(() => {
    try {
      drainEvents();
    } catch (error) {
      if (!settled) {
        settled = true;
        completed("failed", 1, String(error));
      }
      terminal.stop();
    }
  }, 100);
  return {
    ...terminal,
    isAlive: () => alive,
    steer() {
      if (settled)
        throw new Error(
          "Agent is already complete",
        ); /* The native bridge consumes sending controls from SQLite. */
    },
    dispose() {
      clearInterval(timer);
      terminal.dispose();
    },
  };
}
