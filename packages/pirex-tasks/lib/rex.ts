import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { TaskRecord } from "./types.ts";
import { terminal, type Store } from "./store.ts";
import { disposeController } from "./channel.ts";
import { parseSpec, decodeJson, stringifyJson } from "./validation.ts";
const exec = promisify(execFile);
const attachPath = fileURLToPath(new URL("../runner/attach.ts", import.meta.url));
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
const pending = new Map<string, Promise<void>>();
const opening = new Map<string, Promise<void>>();
/** Recreate only the disposable viewer, never the task or PTY. */
export async function ensurePopup(row: TaskRecord, store: Store): Promise<void> {
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
          command: [spec.config.execution.node, attachPath, store.root, row.run_id],
          exit: { on_completion: false },
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
    row.rex_block = store.task(row.owner, row.id).rex_block;
    return;
  }
  const request = placePopup(row, bounds, store, anchor);
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
  const label = `task:${row.run_id}`;
  const placed = window.layers
    .filter((layer) => layer.kind !== "tiled")
    .flatMap((layer) => layer.blocks || [])
    .find((block) => block.block_id === row.rex_block || block.label === label);
  if (placed) {
    row.rex_block = placed.block_id;
    store.exec("UPDATE runs SET rex_block=? WHERE id=?", row.rex_block, row.run_id);
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
            command: [spec.config.execution.node, attachPath, store.root, row.run_id],
            exit: { on_completion: false },
          },
        },
      },
    },
  );
  const block = result.block_ids?.[0];
  if (!block) throw new Error("Rex did not return a popup block ID");
  row.rex_block = block;
  store.exec("UPDATE runs SET rex_block=? WHERE id=?", block, row.run_id);
  for (const old of previous)
    if (old.block_id !== block)
      await api(row.rex_session, "block.close", { block_id: old.block_id }).catch(() => {});
}
export async function hidePopup(row: TaskRecord): Promise<void> {
  if (!row.rex_block) return;
  const listing = await api<BlockListing>(row.rex_session, "session.list_blocks");
  if (!listing.blocks.some((block) => block.block_id === row.rex_block)) return;
  await api(row.rex_session, "session.detach_block", { block_id: row.rex_block });
  const anchor = parseSpec(row).anchor;
  if (anchor)
    await api(row.rex_session, "session.focus_block", { block_id: anchor }).catch(() => {});
}
export async function closePopup(row: TaskRecord, store: Store): Promise<void> {
  if (row.rex_source) {
    const sources = await api<BlockListing>(row.rex_session, "session.list_blocks");
    if (sources.blocks.some((block) => block.block_id === row.rex_source))
      await api(row.rex_session, "block.close", { block_id: row.rex_source });
  } else await disposeController(store.root, row.run_id);
  const listing = await api<BlockListing>(row.rex_session, "session.list_blocks");
  if (row.rex_block && listing.blocks.some((block) => block.block_id === row.rex_block))
    await api(row.rex_session, "block.close", { block_id: row.rex_block });
  store.exec("UPDATE runs SET rex_block=NULL,rex_source=NULL WHERE id=?", row.run_id);
}
