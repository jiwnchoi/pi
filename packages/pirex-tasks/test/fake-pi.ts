// Native terminal fixture, never an LLM/provider. Mirrors only the trusted bridge's event contract.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Store } from "../lib/store.ts";
import { parseSpec, stringifyJson } from "../lib/validation.ts";
import type { ControlRecord } from "../lib/types.ts";
assert.equal(process.stdin.isTTY, true, "Agent stdin must be a real PTY");
assert.equal(process.stdout.isTTY, true, "Agent stdout must be a real PTY");
assert.equal(process.argv.includes("rpc"), false, "Agent must not use RPC mode");
const root = process.env.PIREX_TASK_ROOT!,
  run = process.env.PIREX_TASK_RUN_ID!,
  events = process.env.PIREX_TASK_EVENTS!;
const store = new Store(root),
  spec = parseSpec(store.required("SELECT * FROM runs WHERE id=?", run));
const path = process.argv[process.argv.indexOf("--session") + 1];
const record = (message: string) =>
  appendFileSync(path, stringifyJson({ type: "prompt", message }) + "\n");
record(spec.prompt || "");
process.stdout.write("\x1b[2J\x1b[HNative Pi TUI fixture\r\n");
appendFileSync(events, stringifyJson({ type: "ready", mode: "tui" }) + "\n");
const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
input.on("line", (message) => record(message));
const timer = setInterval(() => {
  for (const control of store.all<ControlRecord>(
    "SELECT * FROM controls WHERE run_id=? AND state='sending' AND type='steer'",
    run,
  )) {
    record(control.message || "");
    store.exec("UPDATE controls SET state='delivered' WHERE id=?", control.id);
  }
}, 100);
setTimeout(() => {
  appendFileSync(events, stringifyJson({ type: "settled", text: "fixture result 한글" }) + "\n");
}, 2500);
process.on("SIGTERM", () => {
  clearInterval(timer);
  input.close();
  store.close();
  process.exit(0);
});
