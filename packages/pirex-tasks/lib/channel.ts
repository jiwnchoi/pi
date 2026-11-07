import { createServer, createConnection, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { mkdirSync, lstatSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { decodeJson, stringifyJson } from "./validation.ts";

const frameSchema = Type.Union([
  Type.Object({ type: Type.Literal("attach") }),
  Type.Object({ type: Type.Literal("ping") }),
  Type.Object({ type: Type.Literal("dispose") }),
  Type.Object({ type: Type.Literal("input"), data: Type.String({ maxLength: 65536 }) }),
  Type.Object({
    type: Type.Literal("resize"),
    columns: Type.Integer({ minimum: 1, maximum: 65535 }),
    rows: Type.Integer({ minimum: 1, maximum: 65535 }),
  }),
]);
export function socketPath(root: string, run: string): string {
  const uid = process.getuid?.() ?? 0;
  const dir = join("/tmp", `pirex-tasks-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
    throw new Error("Unsafe task socket directory");
  return join(
    dir,
    createHash("sha256")
      .update(root + "\0" + run)
      .digest("hex")
      .slice(0, 32) + ".sock",
  );
}
/** Bounded raw terminal replay, not model-facing sanitized output. */
export function replay(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const size = fstatSync(fd).size,
      count = Math.min(size, 512 * 1024);
    const bytes = Buffer.alloc(count);
    const n = readSync(fd, bytes, 0, count, size - count);
    const start = size > count ? bytes.indexOf(10) + 1 : 0;
    return bytes.subarray(start, n);
  } finally {
    closeSync(fd);
  }
}
export class ConsoleHub {
  private sockets = new Set<Socket>();
  private closing = false;
  private viewers = new Set<Socket>();
  private server = createServer((socket) => {
    this.sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.viewers.delete(socket);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 256 * 1024) {
        socket.destroy();
        return;
      }
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const frame = decodeJson(line, frameSchema);
          if (frame.type === "ping") {
            socket.end("pong\n");
            return;
          }
          if (frame.type === "dispose") {
            this.dispose();
            return;
          }
          if (frame.type === "attach" && !this.viewers.has(socket)) {
            socket.write(replay(this.logPath));
            this.viewers.add(socket);
          } else if (this.viewers.has(socket)) {
            if (frame.type === "input") this.input(frame.data);
            if (frame.type === "resize") this.resize(frame.columns, frame.rows);
          }
        } catch {
          socket.destroy();
          return;
        }
      }
    });
  });
  dispose: () => void = () => {};
  input: (data: string) => void = () => {};
  resize: (columns: number, rows: number) => void = () => {};
  private path: string;
  private logPath: string;
  constructor(path: string, logPath: string) {
    this.path = path;
    this.logPath = logPath;
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }
  output(text: string): void {
    for (const socket of this.viewers) {
      if (socket.writableLength > 1024 * 1024) socket.destroy();
      else socket.write(text);
    }
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    for (const socket of this.sockets) {
      socket.end();
      socket.setTimeout(1000, () => socket.destroy());
    }
    this.server.close();
  }
}
/** Dispose an idle native console; absence is already disposed. Wait for actual child exit. */
export function disposeController(root: string, run: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(root, run));
    let connected = false,
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(5000, () => finish(new Error("Native agent console did not close")));
    socket.on("connect", () => {
      connected = true;
      socket.write(stringifyJson({ type: "dispose" }) + "\n");
    });
    socket.on("data", () => {});
    socket.on("error", (error) => {
      if (
        !connected &&
        ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code || "")
      )
        finish();
      else finish(error);
    });
    socket.on("close", () => finish());
  });
}
export function probeController(root: string, run: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath(root, run));
    let text = "",
      done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.on("connect", () => socket.write(stringifyJson({ type: "ping" }) + "\n"));
    socket.on("data", (bytes) => {
      text += bytes.toString();
      if (text.includes("\n")) finish(text === "pong\n");
    });
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}
