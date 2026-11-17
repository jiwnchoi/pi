import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage, type RunRecord, type TaskRecord } from "./types.ts";
import { terminal, type Store } from "./store.ts";
import { disposeController } from "./channel.ts";
import { parseSpec, decodeJson, stringifyJson } from "./validation.ts";
const exec = promisify(execFile);
const attachPath = fileURLToPath(new URL("../runner/attach.ts", import.meta.url));
const resumePath = fileURLToPath(new URL("../runner/resume.ts", import.meta.url));
const logsPath = fileURLToPath(new URL("../runner/logs.ts", import.meta.url));
export function popupCommand(row: TaskRecord, root: string): string[] {
  const spec = parseSpec(row);
  return [
    spec.config.execution.node,
    terminal.has(row.state) ? (row.kind === "agent" ? resumePath : logsPath) : attachPath,
    root,
    row.run_id,
  ];
}
export async function rex<T = unknown>(args: string[]): Promise<T> {
  const { stdout } = await exec("rex", ["--timeout", "5s", ...args], {
    timeout: 8000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return (stdout.trim() ? decodeJson(stdout) : null) as T;
}
export const api = <T = unknown>(
  session: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> => rex<T>(["api", "call", "-s", session, method, stringifyJson(args)]);
interface BlockListing {
  blocks: { block_id: string; label?: string }[];
}
const sessionViewSchema = Type.Object({
  windows: Type.Optional(
    Type.Union([
      Type.Null(),
      Type.Array(
        Type.Object({
          layers: Type.Optional(
            Type.Union([
              Type.Null(),
              Type.Array(
                Type.Object({
                  state: Type.Optional(Type.String()),
                  blocks: Type.Optional(
                    Type.Union([
                      Type.Null(),
                      Type.Array(
                        Type.Object({
                          block_id: Type.Union([Type.String(), Type.Null()]),
                          label: Type.Optional(Type.String()),
                        }),
                      ),
                    ]),
                  ),
                }),
              ),
            ]),
          ),
        }),
      ),
    ]),
  ),
});
export function visibleTask(
  view: unknown,
  runId: string,
  source?: string | null,
  viewer?: string | null,
): boolean {
  Value.Assert(sessionViewSchema, view);
  return (view.windows || []).some((window) =>
    (window.layers || []).some(
      (layer) =>
        layer.state !== "minimized" &&
        (layer.blocks || []).some(
          (block) =>
            !!block.block_id &&
            (block.block_id === source ||
              block.block_id === viewer ||
              block.label === `task:${runId}`),
        ),
    ),
  );
}
const pending = new Map<string, Promise<void>>();
const opening = new Map<string, Promise<void>>();
/** Recreate only the disposable viewer, never the task or PTY. */
export async function ensurePopup(row: TaskRecord, store: Store): Promise<void> {
  if (terminal.has(row.state)) throw new Error("Only running tasks need a viewer");
  const key = store.root + ":" + row.run_id;
  const existing = pending.get(key);
  if (existing) {
    await existing;
    row.rex_block = store.task(row.owner, row.id).rex_block;
    return;
  }
  const create = (async () => {
    const listing = await api<BlockListing>(row.rex_session, "session.list_blocks");
    const known =
      listing.blocks.find((block) => block.block_id === row.rex_block) ||
      listing.blocks.find((block) => block.label === `task:${row.run_id}`);
    if (known) row.rex_block = known.block_id;
    else {
      const spec = parseSpec(row);
      const result = await api<{ block_id: string | null }>(row.rex_session, "session.new_block", {
        flavor: "com.superlogical.terminal.shell",
        label: `task:${row.run_id}`,
        options: {
          shell: "none",
          login: false,
          cwd: spec.cwd,
          command: popupCommand(row, store.root),
          exit: { on_completion: true, quick_exit_threshold_ms: 0 },
        },
      });
      if (!result.block_id) throw new Error("Rex did not return a viewer block ID");
      row.rex_block = result.block_id;
    }
    store.exec("UPDATE runs SET rex_block=? WHERE id=?", row.rex_block, row.run_id);
  })();
  pending.set(key, create);
  try {
    await create;
  } finally {
    pending.delete(key);
  }
}
export async function openPopup(
  row: TaskRecord,
  bounds: [number, number, number, number],
  store: Store,
  anchor = parseSpec(row).anchor,
): Promise<void> {
  const key = store.root + ":" + row.run_id;
  const active = opening.get(key);
  if (active) {
    await active;
    const latest = store.task(row.owner, row.id);
    row.rex_block = terminal.has(latest.state)
      ? latest.rex_inspection || latest.rex_block
      : latest.rex_block;
    row.rex_inspection = latest.rex_inspection;
    return;
  }
  const request = (async () => {
    const latest = store.task(row.owner, row.id);
    if (latest.run_id !== row.run_id) throw new Error("Task has a newer run; reopen it");
    Object.assign(row, latest);
    if (terminal.has(row.state)) {
      if (
        row.rex_source &&
        row.rex_block &&
        visibleTask(
          await api(row.rex_session, "session.view"),
          row.run_id,
          row.rex_source,
          row.rex_block,
        )
      ) {
        await api(row.rex_session, "session.focus_block", { block_id: row.rex_block });
        return;
      }
      const disposing = pending.get(key);
      if (disposing) await disposing;
      await closePopup(row, store, false);
      row.rex_block = row.rex_inspection || null;
    }
    await placePopup(row, bounds, store, anchor);
  })();
  opening.set(key, request);
  try {
    await request;
  } finally {
    opening.delete(key);
  }
}
async function placePopup(
  row: TaskRecord,
  bounds: [number, number, number, number],
  store: Store,
  anchor: string | undefined,
): Promise<void> {
  if (!anchor) throw new Error("No parent Rex block; launch Pi inside Rex to use popups");
  const spec = parseSpec(row);
  if (!["detached", "rex-native"].includes(spec.executionMode || "") && !terminal.has(row.state))
    throw new Error(
      "This task uses the legacy terminal-owned runner. Start a new task after /reload to use reconnectable popups.",
    );
  const inFlight = pending.get(store.root + ":" + row.run_id);
  if (inFlight) await inFlight;
  const view = await api<{
    windows: {
      window_id: string;
      layers: { kind: string; blocks?: { block_id: string; label?: string }[] }[];
    }[];
  }>(row.rex_session, "session.view");
  const window = view.windows.find((window) =>
    window.layers.some((layer) => layer.blocks?.some((block) => block.block_id === anchor)),
  );
  if (!window) throw new Error("The parent Rex window no longer exists");
  const inspection = terminal.has(row.state);
  const column = inspection ? "rex_inspection" : "rex_block";
  const label = `${inspection ? "task-resume" : "task"}:${row.run_id}`;
  const placed = window.layers
    .filter((layer) => layer.kind !== "tiled")
    .flatMap((layer) => layer.blocks || [])
    .find((block) => block.block_id === row.rex_block || block.label === label);
  if (placed) {
    row.rex_block = placed.block_id;
    store.exec(`UPDATE runs SET ${column}=? WHERE id=?`, row.rex_block, row.run_id);
    if (inspection) row.rex_inspection = row.rex_block;
    await api(row.rex_session, "session.focus_block", { block_id: row.rex_block });
    return;
  }
  const listing = await api<BlockListing>(row.rex_session, "session.list_blocks");
  const previous = listing.blocks.filter(
    (block) => block.block_id === row.rex_block || block.label === label,
  );
  // Create the viewer directly in a floating layer: the parent's tiled layout never changes.
  const result = await api<{ block_ids: (string | null)[] | null }>(
    row.rex_session,
    "session.new_layer",
    {
      window_id: window.window_id,
      bounds,
      focus: true,
      layout: {
        block: {
          flavor: "com.superlogical.terminal.shell",
          label,
          options: {
            shell: "none",
            login: false,
            cwd: spec.cwd,
            command: popupCommand(row, store.root),
            exit: { on_completion: true, quick_exit_threshold_ms: 0 },
          },
        },
      },
    },
  );
  const block = result.block_ids?.[0];
  if (!block) throw new Error("Rex did not return a popup block ID");
  row.rex_block = block;
  store.exec(`UPDATE runs SET ${column}=? WHERE id=?`, block, row.run_id);
  if (inspection) row.rex_inspection = block;
  for (const old of previous)
    if (old.block_id !== block)
      await api(row.rex_session, "block.close", { block_id: old.block_id }).catch(() => {});
}
export async function hidePopup(row: TaskRecord): Promise<void> {
  if (terminal.has(row.state) && row.rex_inspection) row.rex_block = row.rex_inspection;
  if (!row.rex_block) return;
  const listing = await api<BlockListing>(row.rex_session, "session.list_blocks");
  if (!listing.blocks.some((block) => block.block_id === row.rex_block)) return;
  const spec = parseSpec(row);
  await api(
    row.rex_session,
    terminal.has(row.state) ||
      spec.executionMode === "detached" ||
      spec.executionMode === "rex-native"
      ? "block.close"
      : "session.detach_block",
    { block_id: row.rex_block },
  );
  const anchor = spec.anchor;
  if (anchor)
    await api(row.rex_session, "session.focus_block", { block_id: anchor }).catch(() => {});
}

const cleaning = new Map<string, Promise<void>>();
export async function cleanupTerminals(store: Store): Promise<void> {
  const active = cleaning.get(store.root);
  if (active) return active;
  const request = (async () => {
    const rows = store.all<TaskRecord>(
      `SELECT r.*,t.owner,t.name,t.kind,t.current_run,r.task_id AS id,r.id AS run_id
       FROM runs r JOIN tasks t ON t.id=r.task_id
       WHERE r.state IN ('succeeded','failed','stopped','timed_out')
       AND (r.rex_source IS NOT NULL OR r.rex_block IS NOT NULL)
       ORDER BY r.ended`,
    );
    const views = new Map<string, unknown>();
    let attempted = 0;
    for (const row of rows) {
      const key = store.root + ":" + row.run_id;
      if (opening.has(key) || pending.has(key)) continue;
      try {
        if (!views.has(row.rex_session))
          views.set(row.rex_session, await api(row.rex_session, "session.view").catch(() => null));
        const view = views.get(row.rex_session);
        if (!view || visibleTask(view, row.run_id, row.rex_source, row.rex_block)) continue;
      } catch {
        continue;
      }
      const closing = closePopup(row, store, false);
      pending.set(key, closing);
      try {
        await closing;
        store.event(row.run_id, "terminal_disposed", { reason: "completed" });
      } catch (error) {
        store.event(row.run_id, "terminal_cleanup_failed", { error: errorMessage(error) });
      } finally {
        pending.delete(key);
      }
      if (++attempted >= 16) break;
    }
  })();
  cleaning.set(store.root, request);
  try {
    await request;
  } finally {
    cleaning.delete(store.root);
  }
}
export async function closePopup(
  row: TaskRecord,
  store: Store,
  includeInspection = true,
): Promise<void> {
  const request = opening.get(store.root + ":" + row.run_id);
  if (includeInspection && request) await request.catch(() => {});
  const live = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", row.run_id);
  if (!live.rex_source) await disposeController(store.root, row.run_id);
  const listing = await api<BlockListing>(row.rex_session, "session.list_blocks");
  const blocks = new Set([
    live.rex_block,
    includeInspection ? live.rex_inspection : null,
    live.rex_source,
  ]);
  for (const block of blocks)
    if (block && listing.blocks.some((item) => item.block_id === block))
      await api(row.rex_session, "block.close", { block_id: block });
  store.exec(
    `UPDATE runs SET rex_block=NULL,rex_source=NULL${includeInspection ? ",rex_inspection=NULL" : ""} WHERE id=?`,
    row.run_id,
  );
}
