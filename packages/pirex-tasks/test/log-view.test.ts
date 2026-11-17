import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { savedLog } from "../lib/runtime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function file(content: string) {
  const root = mkdtempSync(join(tmpdir(), "pirex-saved-log-"));
  roots.push(root);
  const path = join(root, "output.txt");
  writeFileSync(path, content);
  return path;
}
it("shows sanitized saved results with pager controls, not executable task commands", () => {
  const log_path = file("raw fallback");
  const result_path = file("\x1b]52;c;secret\x07saved result 한글");
  const text = savedLog({ name: "Task", state: "succeeded", log_path, result_path });
  expect(text).toContain("saved result 한글");
  expect(text).toContain("q to close");
  expect(text).not.toContain("secret");
  expect(text).not.toContain("raw fallback");
});
it("bounds large log output and identifies the full output file", () => {
  const log_path = file("discarded beginning" + "x".repeat(60000) + "\nlast line");
  const text = savedLog({ name: "Task", state: "failed", log_path, result_path: null });
  expect(text).not.toContain("discarded beginning");
  expect(text).toContain("last line");
  expect(text).toContain("last 50 KiB");
  expect(text).toContain(log_path);
});
