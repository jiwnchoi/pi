# pirex-tasks

A TypeScript Pi extension for **asynchronous tasks in real, interactive Rex terminals**.
Shell commands, Pi subagents and JavaScript workflows share a SQLite task registry.
Native codemode calls receive structured objects rather than JSON strings.

## Requirements

- Pi / Pi-Bolt with custom tools, structured tool output and fullscreen mouse support.
- A running local Rex server and `rex` CLI. Start the parent Pi inside Rex so
  `REX_SESSION` and `REX_BLOCK` identify the parent session and terminal.
- Node **22.18+** on the Rex server's PATH (runners execute TypeScript with Node's
  native type stripping). The Pi extension itself also supports the Bun host.
- Rex control API revision 8 and `rex.data.terminal.v1` over the local Unix socket. `ws` handles the control/data transport. New tasks use Rex-owned PTYs, with no tmux or additional PTY proxy. `node-pty` is retained only for tasks admitted by previous versions.
- For agents, a configured `pi` executable or shell alias and usable Pi credentials.

No Python helper, pre-registered agent or background LLM is installed.

## Install

From the repository root:

```sh
pnpm install
pi install ./packages/pirex-tasks
```

If `pi` is your alias for `pi-bolt`, source your shell config first. Use `/reload`
inside Pi after installing. The plugin defaults to **`pi`**, not `pi-bolt`, when
starting agent children. The default agent bootstrap is zsh interactive mode plus
`source ~/.zshrc`, so an alias defined there works; shell aliases are not passed to
`spawn()` as if they were executable files.

The initial config is written at `~/.pi/agent/pirex-tasks/config.toml` with **no
agent profiles**. `PI_CODING_AGENT_DIR` changes the parent directory;
`PIREX_TASKS_HOME` explicitly overrides the task storage directory.

## Tools

| Tool          | Behavior                                                                  |
| ------------- | ------------------------------------------------------------------------- |
| `task_run`    | Admit a shell command and return a task/run ID immediately                |
| `task_code`   | Admit a JavaScript workflow executed in a Rex runner                      |
| `task_agent`  | Start/resume a separate Pi agent, only on explicit user instruction       |
| `task_steer`  | Queue a message for a running agent; receipt is not delivery confirmation |
| `task_status` | Current snapshot, never waits for completion                              |
| `task_result` | Bounded completed result, or `ready: false` immediately                   |
| `task_logs`   | Bounded output, default 16 KiB, maximum 50 KiB                            |
| `task_stop`   | Request termination; does not wait for it                                 |
| `task_open`   | Open the actual task terminal as a floating Rex popup                     |
| `task_hide`   | Detach the popup without stopping its task                                |
| `task_close`  | Dispose a completed task's terminal; durable results remain               |

All execution calls are asynchronous. They acknowledge **durable admission**, not
successful execution. Queued tasks start as capacity becomes available. There is
no foreground/wait option in a tool API. Opening a terminal does not hold a tool
call open until the popup closes.

Shell example in native codemode:

```js
return await Promise.allSettled([
  tools.task_run({ name: "Tests", command: "pnpm test" }),
  tools.task_run({ name: "Build", command: "pnpm build" }),
]);
```

The prompts tell the model to use `task_run`/`task_code` for commands **expected
to take 10 seconds or more**, then do independent work or yield. This is a routing
instruction, not live migration of an already running built-in bash command.
Do not repeatedly poll for completion. A colored completion/failure alert appears in the original parent session. The agent receives only the task ID and terminal state, never the result or logs, and is woken by default (`notifications.wake_parent`). Use `task_status`, `task_result`, or `task_logs` to inspect results.

## Interactive popups

Click a task in the above-editor dock in fullscreen Pi, or use:

```text
/rex-tasks
/rex-tasks open <task-id>
/rex-tasks hide <task-id>
/rex-tasks stop <task-id>
/rex-tasks close <task-id>
```

The dock is one compact line of status counts and `Shift↓`, with no task commands or paths. **Shift+Down** opens a centered TUI picker; use Up/Down and Enter to open a task in Rex, `k` to request stop for the selected task, `c` to clear a selected completed task, or Escape to cancel. `/task-kill` requests stop for all active tasks belonging to the current session. `/task-clear` removes all completed tasks from that session's list, without deleting task records, logs, or retained consoles; it never clears running work. Tool calls and receipts share one row, such as `queued · Build`. Clicking a task row opens its actual interactive Rex terminal popup. Completion messages stay compact.

A shell task uses a real PTY, not a replayed log. Input, arrow keys, CLI selections,
password prompts, Ctrl+C and terminal resize reach the actual program. Output is
logged; raw keystrokes are not. As with any terminal, echoed input can appear in
output; do not print secrets in commands or expect logs to redact application output.

**Ctrl+] hides the popup and restores parent focus**, without stopping the program. **Rex's X is also safe:** it closes only the disposable viewer, not the task. Opening the task again creates another viewer attached to the same live PTY or agent. Commands are never re-executed to recreate a popup.
Popups are created directly with `session.new_layer`: opening one never splits or resizes the parent terminal, and preserves its tiled layout and zoom. The dock uses semantic status colors; the task picker uses 90% of terminal width and an expanded, screen-relative height.

Top-level shell tasks execute the admitted command once, record its exit status and output snapshot, then leave a real interactive zsh/bash in the same PTY. Users can continue entering commands; these do not overwrite the original task result or send extra completion notifications. Workflow-child shells exit normally. Agent controllers retain the real native Pi TUI with unrestricted human conversation after the delegated turn. `task_close` explicitly terminates the retained console (including any user-started activity) and its viewer; resuming an agent does the same before reusing the saved session. Completed output can also be reopened from bounded raw log replay. No automatic cleanup deletes running work. Development servers remain running until stopped;
readiness is not the same as task completion.

## User-defined agents

Only invoke `task_agent` when the user **explicitly requests delegation**.
An agent profile, a difficult task or the prospect of faster execution does not
constitute permission. `explicitRequest: true` is a required caller assertion,
not a semantic authorization detector or a security sandbox. The prompt policy
also forbids bypassing this restriction through arbitrary shell/workflow code.

Example global config addition (not created automatically):

```toml
[agents.profiles.reviewer]
description = "Read-only reviewer"
system_prompt_file = "./prompts/reviewer.md"
tools = ["read", "grep", "find", "ls"]
inherit_context = false
```

```js
// Only after an explicit user request to delegate:
return await tools.task_agent({
  name: "Review changes",
  profile: "reviewer",
  prompt: "Review the authentication changes; do not edit files.",
  explicitRequest: true,
});
```

Profiles are optional: direct provider/model/tools settings are supported.
Provider, model and thinking otherwise inherit from the parent at submission time.
The child's own saved session is used for resume. A new run records each attempt;
old results are not overwritten. `inheritContext` is opt-in and passes a bounded
snapshot as reference data. This is not an exact fork of the parent's full session.

The terminal contains the **actual native Pi TUI running in a real PTY**. Input and terminal resize go directly to Pi. The internal extension reports lifecycle and steering acknowledgements through private files/SQLite. The child's configured extensions, MCP servers, skills and prompt templates load normally. Its delegated turn reports completion once; subsequent user-entered turns stay in the same saved Pi session without overwriting the original task result. The `agents.allow_nested` setting is retained for configuration compatibility and is not enforced. Tool allowlists are capability conveniences, not OS sandboxes.

The default agent bootstrap reads `.zshrc`. For an actual `pi` binary without an
alias, a simpler bootstrap can be configured:

```toml
[agent_runtime]
executable = "/absolute/path/to/pi"
bootstrap_shell = "/bin/sh"
bootstrap_args = ["-c"]
```

Native Pi dialogs are shown in the actual TUI. The runner never invents permission/auth answers. Configure credentials before launching agents.
No API keys are copied into SQLite.

## Background JavaScript / codemode

`task_code` admits the entire script asynchronously. Inside the Rex runner:

```js
const tests = await tasks.shell({ name: "Tests", command: "pnpm test" });
const build = await tasks.shell({ name: "Build", command: "pnpm build" });
text({ tests, build });
const results = await Promise.all([tasks.wait(tests.taskId), tasks.wait(build.taskId)]);
return results.map((result) => ({ taskId: result.taskId, state: result.state }));
```

Available bindings:

- `tasks.shell(input)`, `tasks.agent(input)`: submit children.
- `tasks.wait(taskId)`: await one of this workflow's own children in the background.
- `tasks.result(taskId)`, `tasks.status(taskId)`: immediate snapshots.
- `tools.task_run`, `tools.task_agent`, `tools.task_result`, `tools.task_status`: aliases.
- `text(value)`, `console.log(...)`: bounded workflow output.

The workflow joins submitted children before completing. Partial child failures
are preserved and make the workflow fail. Script failure requests child stops;
workflow cancellation/timeout propagates stop requests to descendants. Child
completions are aggregated rather than separately waking the parent. Workflow
coordinators do not consume shell/agent concurrency slots, avoiding join deadlocks.

This is an independent background workflow API, **not the native QuickJS
codemode VM** and not a replacement for every host tool. The Node VM is **not a
security boundary**. Run only trusted scripts. A worker boundary allows stopping
CPU-bound scripts; use `timeoutSeconds` for a total execution deadline. Synchronous
script startup is limited to one second. Unawaited asynchronous script operations
are unsupported: await submitted operations before returning.

## Storage, ownership and recovery

SQLite is the source of truth for metadata:

- tasks, immutable run attempts and state transitions;
- agent session paths and launch settings;
- asynchronous stop/steer request status;
- durable completion outbox and delivery leases.

WAL, foreign keys, short immediate transactions and a busy timeout support
multiple parent Pi processes and runners. Logs, raw agent events and large results
are files under `runs/<run-id>/`. Storage is private to the current OS user.

Each new task runs inside a detached Rex-native source block. Its shell, Pi TUI, or workflow runs directly on that block's native terminal. A separate disposable floating viewer connects through the Rex Unix socket: `data.connect` streams the native screen/output, while control requests forward input and terminal resize. Initial VT state includes alternate screen, keyboard/mouse modes, cursor and scroll regions. Closing X kills only the viewer, never the source block; opening it again reconnects to the same execution without raw-log replay. Parent Esc, session switch, `/reload` and Pi exit do not kill admitted tasks. Source heartbeats and native block process state reconcile execution independently of viewer existence. Existing tasks keep their older runtime until completion; no in-place task restart occurs. A transport error is not proof of execution failure; an
uncertain launch is not automatically retried. Missing blocks are reported as
failure, never silently rerun.

Notifications are scoped to the **original Pi session ID**, not whichever session
is currently visible. They are batched, leased and deduplicated against persisted
Pi messages. Delivery uses an outbox/replay model, not an impossible cross-database
exactly-once transaction. Returning to the original session replays undelivered
completion notices. Forked sessions do not automatically own the original tasks.

Only a local Rex server is supported in this version: SQLite and artifact paths
are local. Do not point the adapter at a remote server with unrelated storage.
Daemonizing programs outside the task's process group are not tracked.

## Configuration

`/rex-tasks config` edits the global TOML; `/rex-tasks reload-config` reloads it.
Trusted project `.pi/pirex-tasks.toml` overlays global settings. Untrusted project
config is ignored. Paths in profiles resolve relative to the declaring TOML file.
Typos and invalid values fail with an error instead of silently changing behavior.
Existing tasks retain their configuration snapshot.

## Development / verification

```sh
pnpm --filter @jiwnchoi/pirex-tasks typecheck
pnpm --filter @jiwnchoi/pirex-tasks lint
pnpm --filter @jiwnchoi/pirex-tasks format
pnpm --filter @jiwnchoi/pirex-tasks format:check
pnpm --filter @jiwnchoi/pirex-tasks test
```

`tsrs`, `oxlint`, `oxfmt` and Vitest are dev dependencies. TypeBox provides tool, configuration, stored-spec and JSON-result schemas and runtime validation. Native JSON text parsing and serialization are confined to the storage/RPC boundary in `lib/validation.ts`; there is no handwritten recursive converter or additional validation library.

Optional Rex integration smoke (run as a background command):

```sh
node packages/pirex-tasks/test/rex-smoke.ts
PIREX_TEST_POPUP=1 node packages/pirex-tasks/test/rex-smoke.ts
```

The smoke creates and cleans up only its own Rex blocks. Its agent fixture asserts real TTY stdin/stdout and absence of RPC mode, and tests keyboard input, steering, native-console retention and resume without LLM calls. `node test/native-ui-smoke.ts` additionally launches the actual Pi alias in native TUI mode; a test-only input interceptor prevents all model calls while verifying UI rendering, quiet startup and popup reconnection.
