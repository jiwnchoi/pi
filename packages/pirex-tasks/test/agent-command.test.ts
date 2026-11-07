import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand } from "../runner/agent.ts";
describe("native agent shell bootstrap", () => {
  it("expands a zsh alias after exec without evaluating prompt arguments", () => {
    const home = mkdtempSync(join(tmpdir(), "pirex-alias-"));
    try {
      writeFileSync(
        join(home, ".zshrc"),
        "alias pi='printf \"%s\\n\"'\nprintf 'startup noise\\n'\n",
      );
      const command = agentCommand({
        executable: "pi",
        bootstrap_shell: "/bin/zsh",
        bootstrap_args: ["-ic"],
      });
      const output = execFileSync(
        "/bin/zsh",
        ["-f", "-ic", command, "test", "hello world", "$(touch should-not-exist)"],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(output).toBe("hello world\n$(touch should-not-exist)\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("uses direct exec for non-zsh bootstrap", () => {
    expect(
      agentCommand({
        executable: "/usr/bin/pi",
        bootstrap_shell: "/bin/sh",
        bootstrap_args: ["-c"],
      }),
    ).toBe('exec /usr/bin/pi "$@"');
  });
});
