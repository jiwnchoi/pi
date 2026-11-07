import { workerData, parentPort } from "node:worker_threads";
import { createContext, Script } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../lib/runtime.ts";
import { stringifyJson } from "../lib/validation.ts";
import { terminal } from "../lib/store.ts";
import { errorMessage, type TaskInput, type TaskReceipt, type TaskSpec } from "../lib/types.ts";

const { root, runId, owner, spec } = workerData as {
  root: string;
  runId: string;
  owner: string;
  spec: TaskSpec;
};
const runtime = new Runtime(root, owner, spec.config, {
  ...spec.launchContext,
  cwd: spec.cwd,
  anchor: spec.anchor,
});
const children: TaskReceipt[] = [];
const port = parentPort;
const print = (value: unknown): void => {
  const text = typeof value === "string" ? value : stringifyJson(value);
  if (text.length > 51200)
    throw new Error(
      "Workflow output item exceeds 50 KiB; write large output from a shell task instead",
    );
  port?.postMessage({ type: "output", text: text + "\n" });
};
let outputCount = 0;
const text = (value: unknown): void => {
  if (++outputCount > 10000) throw new Error("Too many workflow output calls");
  print(value);
};
const launch = async (kind: "shell" | "agent", input: TaskInput): Promise<TaskReceipt> => {
  const row = runtime.submit(kind, input, runId);
  children.push(row);
  await runtime.drain();
  return row;
};
const wait = async (taskId: string) => {
  if (!children.some((child) => child.taskId === taskId))
    throw new Error("Workflow may wait only for its own children");
  for (;;) {
    const row = runtime.store.task(owner, taskId);
    if (terminal.has(row.state)) return runtime.result(taskId);
    await runtime.drain();
    await runtime.reconcile();
    await delay(300);
  }
};
const tasks = Object.freeze({
  shell: (input: TaskInput) => launch("shell", input),
  agent: (input: TaskInput) => launch("agent", input),
  wait,
  result: (taskId: string) => runtime.result(taskId),
  status: (taskId: string) => runtime.store.task(owner, taskId),
});
// Convenience bindings resemble native codemode without exposing unrelated host tools.
const tools = Object.freeze({
  task_run: tasks.shell,
  task_agent: tasks.agent,
  task_result: tasks.result,
  task_status: tasks.status,
});
try {
  // vm is an API boundary, NOT a security sandbox. Only run trusted model/user code.
  // A separate Worker lets the parent enforce a deadline even for an infinite JS loop.
  const context = createContext({
    tasks,
    tools,
    text,
    console: { log: (...values: unknown[]) => text(values) },
  });
  const script = new Script(`(async () => {\n${spec.code || ""}\n})()`, {
    filename: "task_code.js",
  });
  const result: unknown = await script.runInContext(context, { timeout: 1000 });
  const completed = await Promise.all(children.map((child) => wait(child.taskId)));
  const failed = completed.filter((child) => child.state !== "succeeded");
  port?.postMessage({
    type: "result",
    result: { value: result ?? null, children: completed },
    error: failed.length ? `${failed.length} child task(s) failed` : undefined,
  });
} catch (e) {
  // Stop admitted children on script failure; never silently leave orphaned work.
  for (const child of children) {
    try {
      if (!terminal.has(runtime.store.task(owner, child.taskId).state))
        runtime.store.control(owner, child.taskId, "stop");
    } catch {
      /* Preserve the original workflow error. */
    }
  }
  port?.postMessage({
    type: "result",
    result: { children, error: errorMessage(e) },
    error: errorMessage(e),
  });
} finally {
  runtime.close();
}
