import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  return {
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (_file: string, args: string[]) => ({
        stdout: JSON.stringify(rpc(args[6], JSON.parse(args[7]))),
        stderr: "",
      }),
    }),
  };
});
import { Store } from "../lib/store.ts";
import { loadConfig } from "../lib/config.ts";
import {
  cleanupTerminals,
  closePopup,
  hidePopup,
  popupCommand,
  openPopup,
  visibleTask,
} from "../lib/rex.ts";
import { Runtime } from "../lib/runtime.ts";
import { parseSpec, stringifyJson } from "../lib/validation.ts";

let store: Store;
let visible: string[];
beforeEach(() => {
  store = new Store(mkdtempSync(join(tmpdir(), "pirex-cleanup-")));
  visible = [];
  rpc.mockReset().mockImplementation((method: string) => {
    if (method === "session.view")
      return { windows: [{ layers: [{ blocks: visible.map((block_id) => ({ block_id })) }] }] };
    if (method === "session.list_blocks")
      return {
        blocks: store.all(
          "SELECT rex_source AS block_id FROM runs WHERE rex_source IS NOT NULL UNION SELECT rex_block FROM runs WHERE rex_block IS NOT NULL UNION SELECT rex_inspection FROM runs WHERE rex_inspection IS NOT NULL",
        ),
      };
    return {};
  });
});
afterEach(() => {
  store.close();
  rmSync(store.root, { recursive: true, force: true });
});
function task(owner = "old-session") {
  const row = store.submit(
    owner,
    "shell",
    "Test",
    {
      executionMode: "rex-native",
      cwd: store.root,
      config: loadConfig(store.root, false, store.root),
      context: "",
      launchContext: {},
    },
    "session:test",
  );
  store.finish(row.run_id, "succeeded", 0);
  store.exec("UPDATE runs SET rex_source=? WHERE id=?", `source:${row.run_id}`, row.run_id);
  return store.task(owner, row.id);
}
const closed = () =>
  rpc.mock.calls.filter(([method]) => method === "block.close").map(([, args]) => args.block_id);

describe("completed task PTY release", () => {
  it("immediately closes completed sources and viewers across owners without deleting results", async () => {
    const row = task();
    store.exec("UPDATE runs SET rex_block='viewer' WHERE id=?", row.run_id);
    await cleanupTerminals(store);
    expect(closed()).toEqual(["viewer", row.rex_source]);
    expect(store.task(row.owner, row.id)).toMatchObject({
      state: "succeeded",
      rex_source: null,
      rex_block: null,
    });
    expect(store.all("SELECT * FROM runs")).toHaveLength(1);
  });
  it("preserves visible completed source/viewer PTYs, then reclaims them after the viewer closes", async () => {
    const row = task();
    store.exec("UPDATE runs SET rex_block=\u0027viewer\u0027 WHERE id=?", row.run_id);
    visible.push("viewer");
    await cleanupTerminals(store);
    expect(closed()).toEqual([]);
    expect(store.task(row.owner, row.id).rex_source).toBe(row.rex_source);
    visible = [];
    await cleanupTerminals(store);
    expect(closed()).toEqual(["viewer", row.rex_source]);
  });
  it("does not kill completed work when Rex visibility cannot be determined", async () => {
    task();
    rpc.mockImplementation(() => {
      throw new Error("offline");
    });
    await cleanupTerminals(store);
    expect(closed()).toEqual([]);
  });
  it("does not let visible completed tasks starve cleanup of hidden tasks", async () => {
    for (let index = 0; index < 18; index++) {
      const row = task();
      visible.push(row.rex_source!);
    }
    const hidden = task();
    await cleanupTerminals(store);
    expect(closed()).toEqual([hidden.rex_source]);
  });
  it("recognizes visible labels during block-ID persistence races and ignores minimized layers", () => {
    const row = task();
    const view = {
      windows: [
        { layers: [{ blocks: [{ block_id: "new-viewer", label: `task:${row.run_id}` }] }] },
      ],
    };
    expect(visibleTask(view, row.run_id)).toBe(true);
    expect(
      visibleTask(
        { windows: [{ layers: [{ ...view.windows[0].layers[0], state: "minimized" }] }] },
        row.run_id,
      ),
    ).toBe(false);
  });
  it("does not touch running or uncertain tasks", async () => {
    for (const state of ["running", "queued", "starting", "stop_requested", "unknown"]) {
      const row = task();
      store.exec("UPDATE runs SET state=? WHERE id=?", state, row.run_id);
    }
    await cleanupTerminals(store);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("releases failed, stopped and timed-out runs as well as successful ones", async () => {
    for (const state of ["failed", "stopped", "timed_out"]) {
      const row = task();
      store.exec("UPDATE runs SET state=? WHERE id=?", state, row.run_id);
    }
    await cleanupTerminals(store);
    expect(closed()).toHaveLength(3);
  });
  it("preserves a separately opened Pi inspection session during completed-run cleanup", async () => {
    const row = task();
    store.exec("UPDATE runs SET rex_inspection='inspection' WHERE id=?", row.run_id);
    await cleanupTerminals(store);
    expect(closed()).toEqual([row.rex_source]);
    expect(store.task(row.owner, row.id).rex_inspection).toBe("inspection");
    await cleanupTerminals(store);
    expect(closed()).toHaveLength(1);
    await closePopup(store.task(row.owner, row.id), store);
    expect(closed()).toEqual([row.rex_source, "inspection"]);
    expect(store.task(row.owner, row.id).rex_inspection).toBeNull();
  });
  it("retries failed closes without clearing resource references", async () => {
    const row = task();
    const implementation = rpc.getMockImplementation()!;
    rpc.mockImplementation((method, args) => {
      if (method === "block.close") throw new Error("offline");
      return implementation(method, args);
    });
    await cleanupTerminals(store);
    expect(store.task(row.owner, row.id).rex_source).toBe(row.rex_source);
    rpc.mockImplementation(implementation);
    await cleanupTerminals(store);
    expect(store.task(row.owner, row.id).rex_source).toBeNull();
  });
  it("bounds each cleanup pass and clears references to already closed blocks", async () => {
    for (let index = 0; index < 18; index++) task();
    rpc.mockImplementation(() => ({ blocks: [] }));
    await cleanupTerminals(store);
    expect(store.all("SELECT * FROM runs WHERE rex_source IS NOT NULL")).toHaveLength(2);
    await cleanupTerminals(store);
    expect(store.all("SELECT * FROM runs WHERE rex_source IS NOT NULL")).toHaveLength(0);
    expect(closed()).toEqual([]);
  });
  it("opens completed logs in a disposable pager and agents in saved sessions, never rerunning shells", () => {
    const row = task();
    expect(popupCommand(row, store.root)[1]).toMatch(/logs\.ts$/);
    expect(popupCommand({ ...row, kind: "agent" }, store.root)[1]).toMatch(/resume\.ts$/);
    for (const state of ["failed", "stopped", "timed_out"] as const)
      expect(popupCommand({ ...row, kind: "agent", state }, store.root)[1]).toMatch(/resume\.ts$/);
    expect(popupCommand({ ...row, state: "running" }, store.root)[1]).toMatch(/attach\.ts$/);
  });
  it("accepts old stored specs without cleanup settings", () => {
    const row = task();
    expect(parseSpec(row).config.cleanup).toBeUndefined();
  });
  it("does not eagerly allocate a viewer or retain a shell when draining new tasks", async () => {
    const runtime = new Runtime(store.root, "owner", loadConfig(store.root, false, store.root), {
      cwd: store.root,
      session: "session:test",
    });
    rpc.mockImplementation((method: string) =>
      method === "session.new_block" ? { block_id: "source" } : {},
    );
    try {
      const row = runtime.submit("shell", { name: "Test", command: "true" });
      expect(parseSpec(runtime.store.task(runtime.owner, row.taskId)).persistentShell).toBe(false);
      await runtime.drain();
      const creates = rpc.mock.calls.filter(([method]) => method === "session.new_block");
      expect(creates).toHaveLength(1);
      expect(creates[0][1].options.exit).toEqual({
        on_completion: true,
        quick_exit_threshold_ms: 0,
      });
    } finally {
      runtime.close();
    }
  });
  it("keeps legacy running task terminals alive when hidden", async () => {
    const row = task();
    const spec = parseSpec(row);
    delete spec.executionMode;
    row.spec = stringifyJson(spec);
    row.state = "running";
    row.rex_block = "legacy";
    rpc.mockImplementation(() => ({ blocks: [{ block_id: "legacy" }] }));
    await hidePopup(row);
    expect(closed()).toEqual([]);
    expect(rpc).toHaveBeenCalledWith("session.detach_block", { block_id: "legacy" });
  });
  it("closes completed inspections even for legacy task specs when hidden", async () => {
    const row = task();
    const spec = parseSpec(row);
    delete spec.executionMode;
    row.spec = stringifyJson(spec);
    row.rex_inspection = "inspection";
    rpc.mockImplementation(() => ({ blocks: [{ block_id: "inspection" }] }));
    await hidePopup(row);
    expect(closed()).toEqual(["inspection"]);
  });
  it("rejects an old run before creating a terminal", async () => {
    const row = task();
    await expect(
      openPopup({ ...row, run_id: "old" }, [0, 0, 1, 1], store, "anchor"),
    ).rejects.toThrow("newer run");
    expect(rpc).not.toHaveBeenCalled();
  });
});
