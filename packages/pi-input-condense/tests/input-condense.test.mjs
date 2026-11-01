import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const pi = execFileSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
let root = dirname(realpathSync(pi));
while (!existsSync(join(root, "package.json"))) {
  const parent = dirname(root);
  if (parent === root) throw new Error("Cannot locate the installed Pi package");
  root = parent;
}
const require = createRequire(join(root, "package.json"));
const agentEntry = join(root, "dist/index.js");
const tuiEntry = require.resolve("@earendil-works/pi-tui");
const { createJiti } = await import(pathToFileURL(require.resolve("jiti")));
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": agentEntry,
    "@earendil-works/pi-tui": tuiEntry,
  },
});
const { UserMessageComponent } = await import(pathToFileURL(agentEntry));
const { Container } = await import(pathToFileURL(tuiEntry));
const { initTheme } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")));
initTheme("dark");
const { default: extension } = await jiti.import(new URL("../extensions/input-condense.ts", import.meta.url).pathname);
const previousDir = process.env.PI_CODING_AGENT_DIR;
const dir = mkdtempSync(join(tmpdir(), "input-condense-test-"));
process.env.PI_CODING_AGENT_DIR = dir;
after(() => {
  if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});
const hooks = {};
extension({ on: (event, handler) => { hooks[event] = handler; } });
await hooks.session_start({}, { ui: { theme: { fg: (_color, text) => text } } });
const source = Array.from({ length: 30 }, (_, i) => `메시지 ${i}`).join("\n\n");
function mouse(overrides = {}) {
  return {
    type: "click", button: "left", x: 2, y: 1, screenX: 2, screenY: 1,
    width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1,
    ...overrides,
  };
}

test("click expands and collapses through the real container dispatcher", () => {
  const row = new UserMessageComponent(source);
  const container = new Container();
  container.addChild(row);
  const collapsed = container.render(80).length;
  assert.equal(collapsed, 4);
  assert.equal(container.handleMouse(mouse())?.handled, true);
  const expanded = container.render(80).length;
  assert.ok(expanded > collapsed);
  assert.equal(container.handleMouse(mouse({ height: expanded }))?.handled, true);
  assert.equal(container.render(80).length, collapsed);
  assert.equal(row.text, source);
});

test("Ctrl+O state and per-message click state compose", () => {
  const row = new UserMessageComponent(source);
  const other = new UserMessageComponent(source);
  row.setExpanded(true);
  assert.ok(row.render(80).length > 4);
  row.handleMouse(mouse());
  assert.equal(row.render(80).length, 4);
  row.handleMouse(mouse());
  assert.ok(row.render(80).length > 4);
  assert.equal(other.render(80).length, 4);
  row.setExpanded(false);
  assert.equal(row.render(80).length, 4);
});

test("short messages and non-primary interactions are not consumed", () => {
  const short = new UserMessageComponent("짧은 메시지");
  short.render(80);
  assert.equal(short.handleMouse(mouse()), undefined);
  const row = new UserMessageComponent(source);
  row.render(80);
  for (const change of [
    { type: "press" }, { type: "release" }, { type: "drag" },
    { type: "wheel", wheelDelta: 1 }, { button: "right" },
    { shift: true }, { ctrl: true }, { alt: true }, { clickCount: 2 },
  ]) {
    assert.equal(row.handleMouse(mouse(change)), undefined);
    assert.equal(row.render(80).length, 4);
  }
});

test("disabled folding leaves clicks and the full message untouched", () => {
  writeFileSync(join(dir, "input-condense.json"), JSON.stringify({ enabled: false }));
  const row = new UserMessageComponent(source);
  assert.ok(row.render(80).length > 4);
  assert.equal(row.handleMouse(mouse()), undefined);
});
