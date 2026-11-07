import { describe, it, expect } from "vitest";
import { TerminalStream } from "../lib/terminal-stream.ts";
describe("Rex native binary snapshot boundary", () => {
  it("does not print binary Ghostty state and tolerates byte-fragmented APC framing", () => {
    const parser = new TerminalStream(123n),
      marker = '\x1b_rex1;123;{"type":"resize","cols":80,"rows":24}\x1b\\';
    const bytes = Buffer.concat([
      Buffer.from("GHOSTSNP\x00\xff"),
      Buffer.from(marker + "live terminal"),
    ]);
    const output: Buffer[] = [];
    for (const byte of bytes) {
      const piece = parser.push(Buffer.from([byte]));
      if (piece) output.push(piece);
    }
    expect(Buffer.concat(output).toString()).toBe(marker + "live terminal");
    expect(parser.push(Buffer.from("next"))?.toString()).toBe("next");
  });
  it("does not trust a resize marker with a different channel nonce", () => {
    const parser = new TerminalStream(123n);
    expect(
      parser.push(Buffer.from('GHOSTSNP\x1b_rex1;456;{"type":"resize"}\x1b\\')),
    ).toBeUndefined();
    expect(
      parser.push(Buffer.from('\x1b_rex1;123;{"type":"resize"}\x1b\\output'))?.toString(),
    ).toContain("output");
  });
});
