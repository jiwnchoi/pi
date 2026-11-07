import { Type } from "typebox";
import { Value } from "typebox/value";
import { StringDecoder } from "node:string_decoder";
import type WebSocket from "ws";
import { RexControl } from "../lib/rex-socket.ts";
import { Store, terminal } from "../lib/store.ts";
import { readBounded } from "../lib/runtime.ts";
import { parseSpec } from "../lib/validation.ts";
import { api } from "../lib/rex.ts";
import type { RunRecord } from "../lib/types.ts";

/** A disposable native Rex client. Closing it never closes or signals its source block. */
export async function nativeViewer(root: string, run: string): Promise<void> {
  const store = new Store(root);
  let row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", run);
  const spec = parseSpec(row);
  const decoder = new StringDecoder("utf8");
  let control: RexControl | undefined,
    stream: WebSocket | undefined,
    disposed = false,
    ready = false,
    initial = true,
    initialBytes = Buffer.alloc(0),
    queued: Buffer[] = [],
    queuedBytes = 0,
    restoring = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let pendingInput = "";
  const currentSource = (): string => {
    row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", run);
    if (!row.rex_source) throw new Error("Native task has no source block yet");
    return row.rex_source;
  };
  const resize = async (): Promise<void> => {
    if (!control || !ready) return;
    await control.request("block.method", {
      session_id: row.rex_session,
      block_id: currentSource(),
      method: "resize",
      args: { columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 },
    });
  };
  const write = (bytes: Buffer | string): void => {
    if (!process.stdout.write(bytes)) stream?.pause();
  };
  const teardown = (): void => {
    ready = false;
    stream?.terminate();
    stream = undefined;
    control?.close();
    control = undefined;
  };
  const retry = (): void => {
    if (disposed || reconnect) return;
    teardown();
    reconnect = setTimeout(() => {
      reconnect = undefined;
      void connect();
    }, 500);
  };
  const restore = async (): Promise<void> => {
    if (!control || restoring) return;
    restoring = true;
    stream?.pause();
    try {
      const snapshot = await control.request("block.method", {
        session_id: row.rex_session,
        block_id: currentSource(),
        method: "format",
        args: {
          format: "vt",
          extra_cursor: true,
          extra_modes: true,
          extra_keyboard: true,
          extra_kitty_keyboard: true,
          extra_scrolling_region: true,
          extra_style: true,
          extra_charsets: true,
          extra_tabstops: true,
          extra_protection: true,
          extra_palette: true,
          max_bytes: 983040,
        },
      });
      Value.Assert(
        Type.Object({ content: Type.String(), id: Type.Optional(Type.Number()) }),
        snapshot,
      );
      let content = snapshot.content;
      if (snapshot.id !== undefined) {
        let offset = Buffer.byteLength(content);
        for (;;) {
          const part = await control.request("block.method", {
            session_id: row.rex_session,
            block_id: currentSource(),
            method: "blob_read",
            args: { id: snapshot.id, offset, max_bytes: 983040 },
          });
          Value.Assert(Type.Object({ data: Type.String(), eof: Type.Boolean() }), part);
          content += part.data;
          offset += Buffer.byteLength(part.data);
          if (part.eof) break;
          if (offset > 16 * 1024 * 1024) throw new Error("Native snapshot exceeded 16 MiB");
        }
      }
      // Snapshot output is a unit: never splice partial snapshot frames into live ANSI bytes.
      write("\x1bc" + content);
      initial = false;
      initialBytes = Buffer.alloc(0);
      queued = [];
      queuedBytes = 0;
      stream?.resume();
      ready = true;
      if (pendingInput) {
        const data = pendingInput;
        pendingInput = "";
        await control.request("block.method", {
          session_id: row.rex_session,
          block_id: currentSource(),
          method: "write",
          args: { data },
        });
      }
      // Ask the actual program to redraw at the final geometry. This closes the small
      // cross-connection snapshot/live-output race for fullscreen applications.
      const columns = process.stdout.columns || 80,
        rows = process.stdout.rows || 24;
      if (rows > 1) {
        await control.request("block.method", {
          session_id: row.rex_session,
          block_id: currentSource(),
          method: "resize",
          args: { columns, rows: rows - 1 },
        });
        await resize();
      }
    } catch {
      retry();
    } finally {
      restoring = false;
    }
  };
  async function connect(): Promise<void> {
    if (disposed) return;
    row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", run);
    if (!row.rex_source && terminal.has(row.state)) {
      write("\x1bc" + readBounded(row.result_path || row.log_path, 51200).text);
      return;
    }
    initial = true;
    initialBytes = Buffer.alloc(0);
    queued = [];
    queuedBytes = 0;
    restoring = false;
    try {
      const source = currentSource();
      control = await RexControl.open();
      control.on("disconnect", retry);
      await control.request("session.attach", { session_id: row.rex_session });
      await control.request("session.own_block", {
        session_id: row.rex_session,
        block_ids: [source],
        mode: "take",
      });
      ready = true;
      await resize();
      ready = false;
      stream = await control.terminal(row.rex_session, source, (bytes) => {
        if (disposed) return;
        if (initial) {
          // The stream's first resize APC follows its complete native Ghostty snapshot.
          initialBytes = Buffer.concat([initialBytes, bytes]);
          if (initialBytes.length > 16 * 1024 * 1024) {
            retry();
            return;
          }
          if (initialBytes.includes(Buffer.from('"type":"resize"'))) void restore();
        } else if (restoring) {
          queued.push(bytes);
          queuedBytes += bytes.length;
          if (queuedBytes > 4 * 1024 * 1024) retry();
        } else write(bytes);
      });
      stream.on("close", retry);
      stream.on("error", retry);
      if (initialBytes.includes(Buffer.from('"type":"resize"'))) void restore();
    } catch {
      retry();
    }
  }
  const onInput = (bytes: Buffer): void => {
    const text = decoder.write(bytes);
    if (text.includes("\x1d"))
      void (async () => {
        if (process.env.REX_BLOCK)
          await api(row.rex_session, "session.detach_block", { block_id: process.env.REX_BLOCK });
        if (spec.anchor)
          await api(row.rex_session, "session.focus_block", { block_id: spec.anchor });
      })().catch(() => {});
    const input = text.replaceAll("\x1d", "");
    if (input && !ready) pendingInput = (pendingInput + input).slice(-65536);
    if (input && ready && control)
      void control
        .request("block.method", {
          session_id: row.rex_session,
          block_id: currentSource(),
          method: "write",
          args: { data: input },
        })
        .catch(retry);
  };
  const onResize = (): void => {
    void resize().catch(retry);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (reconnect) clearTimeout(reconnect);
    teardown();
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {}
    store.close();
    process.exit(0);
  };
  process.stdout.on("drain", () => {
    if (!restoring) stream?.resume();
  });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onInput);
  process.stdout.on("resize", onResize);
  for (const signal of ["SIGHUP", "SIGTERM"] as const) process.on(signal, dispose);
  process.stdin.on("end", dispose);
  await connect();
}
