import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { Store, terminal } from "../lib/store.ts";
import { replay, socketPath } from "../lib/channel.ts";
import { parseSpec, stringifyJson } from "../lib/validation.ts";
import { api } from "../lib/rex.ts";
import type { RunRecord } from "../lib/types.ts";

// Disposable Rex terminal: no ownership of the task, child process, or PTY.
const [root, runId] = process.argv.slice(2);
if (!root || !runId) throw new Error("Usage: node attach.ts ROOT RUN_ID");
const store = new Store(root);
let row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
const spec = parseSpec(row);
if (spec.executionMode === "rex-native") {
  store.close();
  const { nativeViewer } = await import("./native-viewer.ts");
  await nativeViewer(root, runId);
} else {
  const persistentConsole = !!spec.agent || !!spec.persistentShell;
  let socket: Socket | undefined,
    connecting = false,
    displayed = false,
    ended = false;
  let nativeUnavailable = false;
  const decoder = new StringDecoder("utf8");
  let pendingInput = "";
  const send = (frame: Record<string, unknown>): void => {
    if (socket && !socket.destroyed && !connecting) socket.write(stringifyJson(frame) + "\n");
  };
  const hide = async (): Promise<void> => {
    const block = process.env.REX_BLOCK;
    if (block) await api(row.rex_session, "session.detach_block", { block_id: block });
    if (spec.anchor)
      await api(row.rex_session, "session.focus_block", { block_id: spec.anchor }).catch(() => {});
  };
  const resize = (): void =>
    send({
      type: "resize",
      columns: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
  const connect = (): void => {
    if (socket || connecting || (ended && (!persistentConsole || nativeUnavailable))) return;
    connecting = true;
    const client = createConnection(socketPath(root, runId));
    socket = client;
    client.on("connect", () => {
      connecting = false;
      displayed = true;
      process.stdout.write("\x1bc");
      send({ type: "attach" });
      resize();
      if (pendingInput) {
        send({ type: "input", data: pendingInput });
        pendingInput = "";
      }
    });
    client.on("data", (data) => process.stdout.write(data));
    client.on("error", () => {
      if (ended) nativeUnavailable = true;
    });
    client.on("close", () => {
      if (socket === client) {
        socket = undefined;
        connecting = false;
        if (ended) nativeUnavailable = true;
      }
    });
  };
  const tick = (): void => {
    row = store.required<RunRecord>("SELECT * FROM runs WHERE id=?", runId);
    if (terminal.has(row.state)) {
      ended = true;
      if (persistentConsole && !nativeUnavailable) connect();
      else if (!displayed) {
        process.stdout.write(replay(row.log_path));
        displayed = true;
      }
    } else connect();
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (bytes: Buffer) => {
    const text = decoder.write(bytes);
    if (text.includes("\x1d"))
      void hide().catch((error) => process.stdout.write(`\r\n[Cannot hide: ${String(error)}]\r\n`));
    const data = text.replaceAll("\x1d", "");
    if (data && (!ended || (persistentConsole && !nativeUnavailable))) {
      if (!socket || connecting) pendingInput = (pendingInput + data).slice(-65536);
      else send({ type: "input", data });
    }
  });
  process.stdout.on("resize", resize);
  const timer = setInterval(tick, 500);
  const dispose = (): void => {
    clearInterval(timer);
    socket?.destroy();
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      /* Rex may have revoked the viewer TTY already. */
    }
    store.close();
  };
  process.stdin.on("end", () => {
    dispose();
    process.exit(0);
  });
  for (const signal of ["SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      dispose();
      process.exit(0);
    });
  tick();
}
