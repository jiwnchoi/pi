import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { Type, type Static } from "typebox";
import { TerminalStream } from "./terminal-stream.ts";
import { decodeJson, stringifyJson } from "./validation.ts";
const exec = promisify(execFile);
const envelope = Type.Object({
  type: Type.String(),
  id: Type.Optional(Type.String()),
  protocol: Type.Optional(Type.String()),
  payload: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.Union([Type.Null(), Type.Object({ message: Type.String() })])),
});
const identity = Type.Object({ endpoint: Type.String() });
const ticketSchema = Type.Object({ ticket: Type.String() });
let endpointPromise: Promise<string> | undefined;
export async function rexSocketPath(): Promise<string> {
  endpointPromise ??= exec("rex", ["--timeout", "5s", "whoami", "--json"], {
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  })
    .then(({ stdout }) => {
      const endpoint = new URL(decodeJson(stdout, identity).endpoint);
      if (endpoint.protocol !== "unix:")
        throw new Error("Native Rex tasks require a local Unix socket");
      return decodeURIComponent(endpoint.pathname);
    })
    .catch((error) => {
      endpointPromise = undefined;
      throw error;
    });
  return endpointPromise;
}
export class RexControl extends EventEmitter {
  private ws: WebSocket;
  private sequence = 0;
  private pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(path: string) {
    super();
    this.ws = this.connect("/api/control", "rex.control.v1", path);
  }
  private connect(path: string, protocol: string, socket: string): WebSocket {
    return new WebSocket("ws://localhost" + path, protocol, {
      createConnection: () => createConnection(socket),
      perMessageDeflate: false,
      maxPayload: 16 * 1024 * 1024,
    });
  }
  static async open(): Promise<RexControl> {
    const control = new RexControl(await rexSocketPath());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        control.close();
        reject(new Error("Rex control handshake timeout"));
      }, 8000);
      control.ws.on("error", reject);
      control.ws.on("open", () =>
        control.ws.send(
          stringifyJson({
            type: "hello",
            api_revision: 8,
            api_min_revision: 8,
            client: { kind: "other", name: "pirex-tasks", version: "0.1.0" },
          }),
        ),
      );
      control.ws.on("message", (bytes) => {
        try {
          const message = decodeJson(bytes.toString(), envelope);
          if (message.type === "welcome") {
            if (message.protocol !== "rex.control.v1")
              throw new Error("Unexpected Rex control protocol");
            clearTimeout(timer);
            resolve();
          } else if (message.type === "response" && message.id) {
            const call = control.pending.get(message.id);
            if (!call) return;
            control.pending.delete(message.id);
            clearTimeout(call.timer);
            if (message.error) call.reject(new Error(message.error.message));
            else call.resolve(message.payload);
          }
        } catch (error) {
          reject(error);
          control.close();
        }
      });
      control.ws.on("close", () => {
        clearTimeout(timer);
        const error = new Error("Rex control connection closed");
        for (const call of control.pending.values()) {
          clearTimeout(call.timer);
          call.reject(error);
        }
        control.pending.clear();
        control.emit("disconnect");
        reject(error);
      });
    });
    return control;
  }
  request(method: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Rex control is disconnected"));
        return;
      }
      const id = String(++this.sequence);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Rex ${method} timeout`));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(stringifyJson({ type: "request", id, method, payload }));
    });
  }
  async terminal(
    session: string,
    block: string,
    consume: (bytes: Buffer) => void,
  ): Promise<WebSocket> {
    const ticket = await this.request("data.connect", {
      session_id: session,
      block_id: block,
      data_ref_id: "terminal",
      subprotocol: "rex.data.terminal.v1",
    });
    // Decode through the same schema boundary used by disk/RPC data.
    const valid = decodeJson(stringifyJson(ticket), ticketSchema);
    const ws = this.connect("/api/data", "rex.data.terminal.v1", await rexSocketPath());
    await new Promise<void>((resolve, reject) => {
      let first = true;
      let parser: TerminalStream;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Rex terminal handshake timeout"));
      }, 8000);
      ws.on("open", () =>
        ws.send(Buffer.concat([Buffer.from([1]), Buffer.from(valid.ticket, "base64url")])),
      );
      ws.on("error", reject);
      ws.on("close", () => {
        clearTimeout(timer);
        reject(new Error("Rex terminal stream closed"));
      });
      ws.on("message", (raw) => {
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (first) {
          first = false;
          clearTimeout(timer);
          if (bytes.length !== 32 || bytes[0] !== 0x81) {
            ws.terminate();
            reject(new Error("Rex rejected terminal stream"));
            return;
          }
          parser = new TerminalStream(bytes.readBigUInt64LE(24));
          resolve();
          return;
        }
        try {
          const output = parser.push(bytes);
          if (output) consume(output);
        } catch {
          ws.terminate();
        }
      });
    });
    return ws;
  }
  close(): void {
    this.ws.close();
  }
}
export const sourceStateSchema = Type.Object({
  screen: Type.String(),
  modes: Type.Array(
    Type.Object({
      number: Type.Number(),
      set: Type.Boolean(),
      ansi: Type.Optional(Type.Boolean()),
    }),
  ),
});
export type SourceModes = Static<typeof sourceStateSchema>;
