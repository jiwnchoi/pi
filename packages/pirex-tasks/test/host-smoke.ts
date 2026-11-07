// Load the real extension inside Pi-Bolt via the user's `pi` alias, without an LLM call.
import assert from "node:assert/strict";
import { decodeJson, stringifyJson } from "../lib/validation.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = mkdtempSync(join(tmpdir(), "pirex-host-smoke-"));
const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const child = spawn(
  "/bin/zsh",
  [
    "-ic",
    'source ~/.zshrc >/dev/null 2>&1; pi "$@"',
    "pirex-host-smoke",
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-session",
    "-e",
    extension,
  ],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PIREX_TASKS_HOME: root },
  },
);
let buffer = "",
  stderr = "",
  checked = false;
const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
try {
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      let record: { id?: string; type: string; success?: boolean; data?: unknown; error?: string };
      try {
        record = decodeJson(line) as typeof record;
      } catch {
        continue;
      }
      if (record.type === "response" && record.id === "commands") {
        if (!record.success || !stringifyJson(record.data).includes("rex-tasks")) {
          stderr += `\nMissing rex-tasks command: ${line}`;
        } else checked = true;
        child.stdin.end();
      }
    }
  });
  child.stdin.write(stringifyJson({ id: "commands", type: "get_commands" }) + "\n");
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  assert.equal(checked, true, stderr);
  assert.equal(code, 0, stderr);
  console.log(
    "PASS real Pi alias, extension load, Bun SQLite adapter, command registration, clean shutdown (no LLM calls)",
  );
} finally {
  clearTimeout(timer);
  rmSync(root, { recursive: true, force: true });
}
