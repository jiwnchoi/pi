import {
  existsSync,
  statSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  accessSync,
  constants,
} from "node:fs";
import { join, delimiter, isAbsolute, dirname } from "node:path";
import { spawn } from "node:child_process";
import { probeController, disposeController } from "./channel.ts";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Store, terminal } from "./store.ts";
import { api, ensurePopup } from "./rex.ts";
import { validateCwd } from "./config.ts";
import type {
  TaskRecord,
  TaskReceipt,
  Config,
  LaunchContext,
  TaskKind,
  TaskInput,
  TaskSpec,
  AgentSettings,
  BoundedOutput,
  TaskResult,
} from "./types.ts";
import { errorMessage } from "./types.ts";
import { parseSpec } from "./validation.ts";
export const runnerPath = fileURLToPath(new URL("../runner/main.ts", import.meta.url));
export function resolveExecutable(name: string): string {
  const paths = isAbsolute(name)
    ? [name]
    : (process.env.PATH || "").split(delimiter).map((dir) => join(dir, name));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Executable not found: ${name}`);
}
export const sanitize = (value: unknown): string =>
  Array.from(stripVTControlCharacters(String(value)))
    .filter((char) => {
      const code = char.codePointAt(0)!;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join("");
export function receipt(row: TaskRecord): TaskReceipt {
  return {
    taskId: row.id,
    runId: row.run_id,
    kind: row.kind,
    name: row.name,
    state: row.state,
    rexBlockId: row.rex_block,
    outputPath: row.log_path,
  };
}
export function readBounded(path: string, maxBytes = 16384, tail = true): BoundedOutput {
  maxBytes = Math.min(51200, Math.max(1, Math.floor(maxBytes)));
  if (!Number.isFinite(maxBytes)) throw new Error("Invalid maxBytes");
  if (!existsSync(path)) return { text: "", bytes: 0, truncated: false, path };
  const size = statSync(path).size;
  const count = Math.min(size, maxBytes);
  const buf = Buffer.alloc(count);
  const fd = openSync(path, "r");
  let n;
  try {
    n = readSync(fd, buf, 0, count, tail ? size - count : 0);
  } finally {
    closeSync(fd);
  }
  return {
    text: sanitize(buf.subarray(0, n).toString("utf8")),
    bytes: size,
    truncated: size > count,
    path,
  };
}
export class Runtime {
  store: Store;
  owner: string;
  config: Config;
  context: LaunchContext;
  launching: boolean;
  closed: boolean;
  constructor(root: string, owner: string, config: Config, context: LaunchContext = {}) {
    this.store = new Store(root);
    this.owner = owner;
    this.config = config;
    this.context = context;
    this.launching = false;
    this.closed = false;
  }
  submit(kind: TaskKind, input: TaskInput, parentRun?: string): TaskReceipt {
    if (!["shell", "code", "agent"].includes(kind)) throw new Error("Invalid task kind");
    if (!this.context.session)
      throw new Error(
        "Rex session missing. Start Pi inside Rex (REX_SESSION), or configure its environment.",
      );
    if (kind === "shell" && !input.command?.trim()) throw new Error("command is required");
    if (kind === "code" && !input.code?.trim()) throw new Error("code is required");
    if (
      input.timeoutSeconds !== undefined &&
      (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0)
    )
      throw new Error("timeoutSeconds must be positive");
    let cwd = validateCwd(input.cwd, this.context.cwd || process.cwd());
    let runConfig = this.config;
    let inheritedContext = this.context.snapshot || "";
    if (!statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    let settings: AgentSettings | undefined;
    let systemPrompt: string | undefined;
    let resume: string | undefined;
    let resumeRunId: string | undefined;
    if (kind === "agent") {
      if (input.explicitRequest !== true)
        throw new Error(
          "task_agent requires explicitRequest:true, only when the user explicitly requested delegation",
        );
      if (!input.prompt?.trim()) throw new Error("prompt is required");
      resume = input.resume;
      if (resume) {
        const old = this.store.task(this.owner, resume);
        const oldSpec = parseSpec(old);
        resumeRunId = old.run_id;
        settings = oldSpec.agent;
        systemPrompt = oldSpec.systemPrompt;
        cwd = oldSpec.cwd;
        runConfig = oldSpec.config;
        inheritedContext = oldSpec.context;
      } else {
        const profile = input.profile ? this.config.agents.profiles?.[input.profile] : {};
        if (!profile) throw new Error(`Unknown user-defined agent profile: ${input.profile}`);
        settings = {
          provider: this.context.provider,
          model: this.context.model,
          thinking: this.context.thinking,
          ...profile,
        };
        for (const key of ["provider", "model", "thinking"] as const)
          if (input[key] !== undefined) settings[key] = input[key];
        if (input.tools !== undefined) settings.tools = input.tools;
        systemPrompt = settings.system_prompt_file
          ? readFileSync(settings.system_prompt_file, "utf8")
          : "";
        settings.inherit_context = input.inheritContext ?? settings.inherit_context ?? false;
      }
      if (!settings?.provider || !settings.model)
        throw new Error("Agent needs a provider and model (explicitly or inherited from parent)");
    }
    const spec: TaskSpec = {
      executionMode: "rex-native",
      persistentShell: kind === "shell" && !parentRun,
      resumeRunId,
      cwd,
      command: input.command,
      code: input.code,
      prompt: input.prompt,
      timeoutSeconds: input.timeoutSeconds,
      parentRun,
      anchor: this.context.anchor,
      config: {
        ...runConfig,
        execution: {
          ...runConfig.execution,
          node: resolveExecutable(runConfig.execution.node),
          shell: resolveExecutable(runConfig.execution.shell),
        },
      },
      agent: settings,
      systemPrompt,
      context: settings?.inherit_context ? inheritedContext : "",
      launchContext: { ...this.context, snapshot: undefined },
    };
    const row = this.store.submit(this.owner, kind, input.name, spec, this.context.session, resume);

    // Admission is durable. A cancelled caller after this point does not own the task.
    return receipt(row);
  }
  async drain() {
    if (this.launching || this.closed) return;
    this.launching = true;
    try {
      const rows = this.store.all(
        `SELECT r.* FROM runs r JOIN tasks t ON r.task_id=t.id WHERE t.owner=? AND r.state='queued' ORDER BY r.created`,
        this.owner,
      );
      for (const row of rows) {
        const spec = parseSpec(row);
        if (!this.store.claim(row.id, spec.config.execution.max_concurrent)) continue;
        if (spec.executionMode === "rex-native") {
          try {
            if (spec.resumeRunId) {
              const previous = this.store.required(
                "SELECT * FROM runs WHERE id=?",
                spec.resumeRunId,
              );
              if (previous.rex_source)
                await api(previous.rex_session, "block.close", { block_id: previous.rex_source });
              else await disposeController(this.store.root, spec.resumeRunId);
            }
            const result = await api<{ block_id: string | null }>(
              row.rex_session,
              "session.new_block",
              {
                flavor: "com.superlogical.terminal.shell",
                label: `task-source:${row.id}`,
                options: {
                  shell: "none",
                  login: false,
                  cwd: spec.cwd,
                  command: [
                    spec.config.execution.node,
                    fileURLToPath(new URL("../runner/native-source.ts", import.meta.url)),
                    this.store.root,
                    row.id,
                  ],
                  exit: { on_completion: false },
                },
              },
            );
            if (!result.block_id) throw new Error("Rex returned no native execution block");
            this.store.exec("UPDATE runs SET rex_source=? WHERE id=?", result.block_id, row.id);
            await ensurePopup(this.store.task(this.owner, row.task_id), this.store).catch((error) =>
              this.store.event(row.id, "viewer_unavailable", { error: errorMessage(error) }),
            );
          } catch (error) {
            this.store.exec(
              "UPDATE runs SET state='unknown',error=? WHERE id=? AND state='starting'",
              `Native launch uncertain: ${errorMessage(error)}`,
              row.id,
            );
            this.store.event(row.id, "launch_uncertain", { error: errorMessage(error) });
          }
          continue;
        }
        let descriptor: number | undefined;
        try {
          if (spec.resumeRunId) await disposeController(this.store.root, spec.resumeRunId);
          descriptor = openSync(join(dirname(row.log_path), "controller.log"), "a", 0o600);
          const child = spawn(spec.config.execution.node, [runnerPath, this.store.root, row.id], {
            cwd: spec.cwd,
            detached: true,
            stdio: ["ignore", descriptor, descriptor],
            env: { ...process.env, REX_SESSION: row.rex_session, REX_BLOCK: "" },
          });
          const recordExit = (reason: string): void => {
            if (!existsSync(join(this.store.root, "tasks.sqlite"))) return;
            const recovery = new Store(this.store.root);
            try {
              recovery.finish(row.id, "failed", null, reason);
            } finally {
              recovery.close();
            }
          };
          child.on("error", (error) =>
            recordExit(`Controller launch failed: ${errorMessage(error)}`),
          );
          child.on("exit", (code, signal) =>
            recordExit(`Controller exited without terminal state (${code ?? signal})`),
          );
          child.unref();
        } catch (error) {
          this.store.finish(row.id, "failed", null, errorMessage(error));
          continue;
        } finally {
          if (descriptor !== undefined) closeSync(descriptor);
        }
        try {
          await ensurePopup(this.store.task(this.owner, row.task_id), this.store);
        } catch (error) {
          this.store.event(row.id, "viewer_unavailable", { error: errorMessage(error) });
        }
      }
    } finally {
      this.launching = false;
    }
  }
  result(id: string, maxBytes?: number): TaskResult {
    const row = this.store.task(this.owner, id);
    if (!terminal.has(row.state)) return { ...receipt(row), ready: false };
    return {
      ...receipt(row),
      ready: true,
      exitCode: row.exit_code,
      error: row.error,
      output: readBounded(row.result_path || row.log_path, maxBytes),
      agentSession: this.store.get<{ path: string }>(
        "SELECT path FROM agent_sessions WHERE task_id=?",
        id,
      )?.path,
    };
  }
  async reconcile() {
    const rows = this.store.all(
      `SELECT r.* FROM runs r JOIN tasks t ON t.id=r.task_id WHERE t.owner=? AND r.state IN ('starting','running','stop_requested','unknown')`,
      this.owner,
    );
    if (!rows.length) return;
    const blocks = new Map<string, unknown>();
    for (const row of rows) {
      const spec = parseSpec(row);
      if (spec.executionMode === "rex-native") {
        if ((row.heartbeat || row.created) >= Date.now() - 15000) continue;
        try {
          const listing = await api<{ blocks: { block_id: string; label?: string }[] }>(
            row.rex_session,
            "session.list_blocks",
          );
          const source = listing.blocks.find(
            (block) => block.block_id === row.rex_source || block.label === `task-source:${row.id}`,
          );
          if (!source) {
            this.store.finish(
              row.id,
              row.state === "stop_requested" ? "stopped" : "failed",
              null,
              "Native Rex source block missing; execution was not restarted",
            );
            continue;
          }
          this.store.exec("UPDATE runs SET rex_source=? WHERE id=?", source.block_id, row.id);
          const state = await api<{ last_exit?: { exit_code: number } }>(
            row.rex_session,
            "block.method",
            { block_id: source.block_id, method: "process", args: {} },
          );
          if (state.last_exit)
            this.store.finish(
              row.id,
              row.state === "stop_requested" ? "stopped" : "failed",
              state.last_exit.exit_code,
              "Native task source exited without completion",
            );
        } catch {
          /* An unavailable server is not proof that execution exited. */
        }
        continue;
      }
      if (spec.executionMode === "detached") {
        if ((row.heartbeat || row.created) >= Date.now() - 15000) continue;
        if (!(await probeController(this.store.root, row.id)))
          this.store.finish(
            row.id,
            "failed",
            null,
            "Detached controller unavailable; task was not restarted",
          );
        continue;
      }
      try {
        if (!blocks.has(row.rex_session))
          blocks.set(row.rex_session, await api(row.rex_session, "session.list_blocks"));
        const listing = blocks.get(row.rex_session);
        // Rex labels are unique run tokens, allowing recovery after a timed-out creation response.
        const walk = (x: unknown): string | null => {
          if (!x || typeof x !== "object") return null;
          const value = x as Record<string, unknown>;
          if (value.label === `task:${row.id}`) {
            const id = value.block_id || value.id;
            return typeof id === "string" ? id : null;
          }
          for (const v of Object.values(value)) {
            const hit = walk(v);
            if (hit) return hit;
          }
          return null;
        };
        const located = walk(listing);
        const block = located;
        if (!block) {
          this.store.finish(row.id, "failed", null, "Rex block missing; task was not restarted");
          continue;
        }
        this.store.exec("UPDATE runs SET rex_block=? WHERE id=?", block, row.id);
        const state = await api<{ last_exit?: { exit_code: number } }>(
          row.rex_session,
          "block.method",
          { block_id: block, method: "process", args: {} },
        );
        if (state?.last_exit)
          this.store.finish(
            row.id,
            "failed",
            state.last_exit.exit_code,
            "Runner exited without a terminal record",
          );
      } catch {
        /* Disconnection is not proof of task failure. Retry on a later background tick. */
      }
    }
  }
  close() {
    this.closed = true;
    this.store.close();
  }
}
