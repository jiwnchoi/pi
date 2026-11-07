import { Type } from "typebox";
import { decodeJson } from "./validation.ts";
/** Discard the binary Ghostty initialization; expose VT metadata/live output only. */
export class TerminalStream {
  private initial: Buffer | undefined = Buffer.alloc(0);
  private marker: Buffer;
  constructor(nonce: bigint) {
    this.marker = Buffer.from(`\x1b_rex1;${nonce};`);
  }
  push(bytes: Buffer): Buffer | undefined {
    if (!this.initial) return bytes;
    this.initial = Buffer.concat([this.initial, bytes]);
    if (this.initial.length > 16 * 1024 * 1024)
      throw new Error("Rex native snapshot exceeded 16 MiB");
    const start = this.initial.indexOf(this.marker);
    if (start < 0) return;
    const end = this.initial.indexOf(Buffer.from("\x1b\\"), start + this.marker.length);
    if (end < 0) return;
    decodeJson(
      this.initial.subarray(start + this.marker.length, end).toString(),
      Type.Object({ type: Type.Literal("resize") }),
    );
    const tail = this.initial.subarray(start);
    this.initial = undefined;
    return tail;
  }
}
