import assert from "node:assert/strict";
import { test, afterEach, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import {
  Markdown,
  ScrollView,
  VStack,
  compositeTuiLine,
  sliceByColumn,
  getCellDimensions,
  setCellDimensions,
  setCapabilities,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import {
  getKittyImageMetadata,
  getKittyImagePlacement,
} from "@earendil-works/pi-tui/dist/terminal-image.js";
import { getActiveBackgroundAnsi } from "@earendil-works/pi-tui/dist/utils.js";
import {
  replaceFences,
  applyPlacements,
  clearPlacements,
  installPlacementPass,
  rearmPlacementPass,
} from "../extensions/markdown.ts";
import {
  encodeKittyBlock,
  encodeITerm2Block,
  kittyRasterByteLimit,
  supportsPlaceholders,
} from "../extensions/kitty.ts";
import { rasterize } from "../extensions/render.ts";
import { saveSnapshot, linkImageLines } from "../extensions/snapshot.ts";
import peleMermaid from "../extensions/pele-mermaid.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testDir = mkdtempSync(join(tmpdir(), "pele-mermaid-test-"));
process.env.PI_CODING_AGENT_DIR = testDir;
afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});
const originalCells = { ...getCellDimensions() };
afterEach(() => {
  setCellDimensions(originalCells);
  clearPlacements();
});
const theme = Object.fromEntries(
  [
    "heading",
    "link",
    "linkUrl",
    "code",
    "codeBlock",
    "codeBlockBorder",
    "quote",
    "quoteBorder",
    "hr",
    "listBullet",
    "bold",
    "italic",
    "strikethrough",
    "underline",
  ].map((key) => [key, (s: string) => s]),
) as any;
const source = 'flowchart TD\nA["시작"] --> B["완료"]';
const fence = `\`\`\`mermaid\n${source}\n\`\`\``;
const placement = {
  columns: 8,
  rows: 2,
  encode: (left: number) => [" ".repeat(left) + "IMAGE", ""],
};
const options = {
  appearance: "dark" as const,
  maxColumns: 80,
  fillWidth: 1,
  scale: 2,
  padding: 10,
  fontFamily: "sans-serif",
  fontFiles: [],
  loadSystemFonts: false,
  maxRows: 40,
};

function component(text = fence, widthPlacement = placement) {
  return new Markdown(text, 1, 0, theme, undefined, {
    transform: (markdown, availableWidth) =>
      replaceFences({ markdown, availableWidth, place: () => widthPlacement }),
  });
}

test("install/rearm is idempotent and works after module reload", async () => {
  installPlacementPass();
  const renderer = Markdown.prototype.render;
  installPlacementPass();
  rearmPlacementPass();
  assert.equal(Markdown.prototype.render, renderer);
  // Node supports query strings in ESM imports, but TypeScript cannot resolve them.
  // @ts-expect-error Reload the module under a distinct URL for this test.
  const reloaded = await import("../extensions/markdown.ts?reload-test");
  reloaded.installPlacementPass();
  assert.equal(Markdown.prototype.render, renderer);
});

test("markers cannot wrap even at 8 content columns", () => {
  installPlacementPass();
  const lines = component().render(10);
  assert(lines.some((line) => line.includes("IMAGE")));
  assert(!lines.some((line) => line.includes("\uE000")));
  assert(lines.every((line) => visibleWidth(line) <= 10));
});

test("streaming updates reuse markers and encoded Markdown rows", () => {
  const a = replaceFences({ markdown: fence, availableWidth: 80, place: () => placement });
  const b = replaceFences({
    markdown: fence + "\nmore text",
    availableWidth: 80,
    place: () => placement,
  });
  assert.equal(a.trim(), b.split("more text")[0]!.trim());
  let encodes = 0;
  const md = component(fence, {
    ...placement,
    encode: () => {
      encodes++;
      return ["IMAGE", ""];
    },
  });
  assert.deepEqual(md.render(80), md.render(80));
  assert.equal(encodes, 1);
});

test("wrapper remains composed with another extension", () => {
  installPlacementPass();
  const own = Markdown.prototype.render;
  const other = function (this: Markdown, width: number) {
    return own.call(this, width);
  };
  Markdown.prototype.render = other;
  rearmPlacementPass();
  assert(
    component()
      .render(80)
      .some((line) => line.includes("IMAGE")),
  );
});

test("open streaming fences remain untouched", () => {
  const markdown = `\`\`\`mermaid\n${source}`;
  assert.equal(replaceFences({ markdown, availableWidth: 80, place: () => placement }), markdown);
});

test("supports tilde/long fences and CRLF", () => {
  for (const [open, close] of [
    ["~~~mermaid", "~~~"],
    ["````mermaid", "`````"],
    ["```MERMAID", "```"],
  ]) {
    const markdown = `${open}\r\n${source.replace(/\n/g, "\r\n")}\r\n${close}`;
    let seen = "";
    const result = replaceFences({
      markdown,
      availableWidth: 80,
      place: (value) => {
        seen = value;
        return placement;
      },
    });
    assert(result.includes("\uE000"));
    assert.equal(seen, source);
  }
});

test("does not transform examples inside non-Mermaid code fences", () => {
  const markdown = `\`\`\`\`markdown\n${fence}\n\`\`\`\``;
  assert.equal(
    replaceFences({
      markdown,
      availableWidth: 80,
      place: () => {
        throw Error("must not render");
      },
    }),
    markdown,
  );
});

test("indentation reduces diagram width and is preserved", () => {
  let measured = 0;
  const markdown = fence
    .split("\n")
    .map((line) => "  " + line)
    .join("\n");
  const transformed = replaceFences({
    markdown,
    availableWidth: 20,
    place: (_, width) => {
      measured = width;
      return placement;
    },
  });
  assert.equal(measured, 18);
  const marker = transformed.trim();
  assert(applyPlacements(["  " + marker])[0]!.startsWith("       IMAGE"));
});

test("too narrow and failed render preserve exact source", () => {
  assert.equal(
    replaceFences({ markdown: fence, availableWidth: 7, place: () => placement }),
    fence,
  );
  assert.equal(
    replaceFences({ markdown: fence, availableWidth: 80, place: () => undefined }),
    fence,
  );
});

test("Kitty uses zlib RGBA metadata and reconstructible chunk payloads", () => {
  const base64 = "abcd".repeat(3000);
  const block = encodeKittyBlock(base64, 12, 5, 123, 0, {
    format: "rgba-zlib",
    widthPx: 216,
    heightPx: 180,
  });
  const sequence = block.lines[0]!;
  assert(sequence.includes("f=32,o=z,s=216,v=180"));
  assert(!sequence.includes("f=100"));
  const commands = [...sequence.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  assert.equal(commands.map((match) => match[2]).join(""), base64);
  assert(commands[0]![1]!.includes("m=1"));
  assert(commands.at(-1)![1]!.includes("m=0"));
  assert(commands.every((match) => match[2]!.length <= 4096));
});

test("anchored images clip above the editor and survive scrolling past their anchor", () => {
  const oldProgram = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = "herdr";
  try {
    const image = encodeKittyBlock("AAAA", 8, 10, 0x654321, 3, {
      format: "rgba-zlib",
      widthPx: 160,
      heightPx: 200,
    });
    assert.equal(image.placeholders, false);
    assert(image.lines[0]!.includes("z=-2147483648"));
    assert(image.lines.slice(1).every((line) => line === ""));
    assert.deepEqual(getKittyImageMetadata(image.lines[0]!), {
      imageId: 0x654321,
      columns: 8,
      rows: 10,
      widthPx: 160,
      heightPx: 200,
    });
    const linked = linkImageLines(image.lines, "file:///tmp/diagram.svg", 3, false);
    const transcript = {
      render: () => ["before", ...linked, ...Array(20).fill("after")],
      invalidate() {},
    };
    const scroll = new ScrollView(transcript);
    const editor = { render: () => ["INPUT", "STATUS"], invalidate() {} };
    const root = new VStack([
      { component: scroll, grow: 1, basis: 0 },
      { component: editor, basis: 2, shrink: 0 },
    ]);
    const first = renderLayoutFrame(root, 30, 8, () => {});
    assert.deepEqual(first.lines.slice(6), ["INPUT", "STATUS"]);
    const bottom = first.lines[1]!;
    assert(bottom.includes("y=0,h=100,r=5"));
    assert(bottom.includes("z=-2147483648"));
    const placement = getKittyImagePlacement(bottom);
    assert(placement);
    assert.equal(placement.rows, 5);
    assert(placement.replacementLine.includes("y=0,h=100,r=5"));
    scroll.scrollTo(4);
    const scrolled = renderLayoutFrame(root, 30, 8, () => {});
    assert(scrolled.lines[0]!.includes("y=60,h=120,r=6"));
    assert.deepEqual(scrolled.lines.slice(6), ["INPUT", "STATUS"]);
    assert(getKittyImagePlacement(scrolled.lines[0]!)?.replacementLine.includes("y=60,h=120,r=6"));
  } finally {
    if (oldProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = oldProgram;
  }
});

test("virtual placeholder grids do not register anchored cropping metadata", () => {
  const oldProgram = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = "ghostty";
  try {
    const image = encodeKittyBlock("AAAA", 8, 10, 0x654322, 0, {
      format: "rgba-zlib",
      widthPx: 160,
      heightPx: 200,
    });
    assert(image.placeholders);
    assert.equal(getKittyImageMetadata(image.lines[0]!), undefined);
    assert(!image.lines[0]!.includes("z=-2147483648"));
  } finally {
    if (oldProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = oldProgram;
  }
});

test("scrollbar/overlay slicing cannot reinterpret image IDs as red backgrounds", () => {
  const oldProgram = process.env.TERM_PROGRAM;
  process.env.TERM_PROGRAM = "ghostty";
  try {
    // A green channel of 101 was being mistaken for SGR 101 (bright-red background).
    const legacy = "\x1b[38;2;181;101;112m\x1b[58;2;181;101;112m";
    assert.equal(getActiveBackgroundAnsi(legacy), "\x1b[101m");
    const image = encodeKittyBlock("AAAA", 24, 3, 0xb56570, 0);
    assert.equal(image.placeholders, true);
    for (const row of image.lines.slice(1)) {
      assert(!row.includes("\x1b[58;"));
      assert(row.startsWith("\x1b[0m"));
      assert(row.endsWith("\x1b[0m"));
      for (const column of [0, 1, 12, 23]) {
        const clipped = sliceByColumn(row, column, 1, true);
        assert.equal(getActiveBackgroundAnsi(clipped), "");
        assert(!clipped.includes("\x1b[101m"));
      }
      const overlay = compositeTuiLine(row, "\x1b[48;2;37;38;42m최신 메시지\x1b[0m", 5, 12, 24);
      assert(!overlay.includes("\x1b[101m"));
    }
  } finally {
    if (oldProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = oldProgram;
  }
});

test("inner terminals do not inherit outer placeholder support", () => {
  for (const TERM_PROGRAM of ["herdr", "rex", "warpterminal", "iterm.app"]) {
    assert.equal(
      supportsPlaceholders({ TERM_PROGRAM, KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" }),
      false,
    );
  }
  assert.equal(supportsPlaceholders({ TERM_PROGRAM: "ghostty" }), true);
  assert.equal(supportsPlaceholders({ TERM_PROGRAM: "kitty", TMUX: "/tmp/tmux" }), false);
});

test("raster magnification is applied once and raw RGBA round-trips", () => {
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  const raster = rasterize(source, { ...options, maxRows: 80, format: "rgba-zlib" });
  assert(raster);
  assert.equal(raster.widthPx, raster.columns * 9 * options.scale);
  assert.equal(raster.heightPx, raster.rows * 18 * options.scale);
  const pixels = inflateSync(Buffer.from(raster.base64, "base64"));
  assert.equal(pixels.length, raster.widthPx * raster.heightPx * 4);
  assert(pixels.some((byte, index) => index % 4 === 3 && byte > 0));
});

test("retina/tall diagrams lower resolution instead of failing pixel limits", () => {
  setCellDimensions({ widthPx: 30, heightPx: 60 });
  const tall =
    "flowchart TD\n" + Array.from({ length: 20 }, (_, i) => `N${i} --> N${i + 1}`).join("\n");
  const raster = rasterize(tall, {
    ...options,
    maxColumns: 200,
    maxRows: 80,
    scale: 4,
    maxHeightPx: 2048,
    format: "rgba-zlib",
  });
  assert(raster);
  assert(raster.heightPx <= 2048);
  assert(raster.widthPx <= 8192);
  assert(raster.widthPx * raster.heightPx <= 16_000_000);
  assert(raster.rows <= 80);
  assert.equal(
    inflateSync(Buffer.from(raster.base64, "base64")).length,
    raster.widthPx * raster.heightPx * 4,
  );
});

test("Herdr caps decoded RGBA without changing the displayed cell box", () => {
  const limit = 16 * 1024 * 1024;
  assert.equal(kittyRasterByteLimit({ TERM_PROGRAM: "HeRdR" }), limit);
  for (const TERM_PROGRAM of ["kitty", "ghostty", "wezterm", "warpterminal", "rex", "iterm.app"]) {
    assert.equal(kittyRasterByteLimit({ TERM_PROGRAM }), undefined);
  }
  setCellDimensions({ widthPx: 14, heightPx: 28 });
  const chart =
    'xychart-beta\nx-axis ["1월", "2월", "3월", "4월", "5월", "6월"]\ny-axis 0 --> 100\nbar [22,31,45,58,71,88]\nline [22,31,45,58,71,88]';
  for (const maxColumns of [80, 102, 210]) {
    const input = {
      ...options,
      maxColumns,
      fillWidth: 0.8,
      scale: 3,
      maxRows: 27,
      format: "rgba-zlib" as const,
    };
    const original = rasterize(chart, input);
    const bounded = rasterize(chart, { ...input, maxRasterBytes: limit });
    assert(original);
    assert(bounded);
    assert(original.widthPx * original.heightPx * 4 > limit);
    assert.equal(bounded.columns, original.columns);
    assert.equal(bounded.rows, original.rows);
    assert.equal(bounded.svg, original.svg);
    const decodedBytes = bounded.widthPx * bounded.heightPx * 4;
    assert(decodedBytes <= limit);
    assert.equal(inflateSync(Buffer.from(bounded.base64, "base64")).length, decodedBytes);
    const forwardedBytes =
      Math.ceil(decodedBytes / 3) * 4 + Math.ceil(decodedBytes / 3072) * 16 + 1024;
    assert(forwardedBytes < 30 * 1024 * 1024);
  }
});

test("80% width cap applies to wide charts as well as narrow diagrams", () => {
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  const chart =
    'xychart-beta\nx-axis ["1월", "2월", "3월", "4월", "5월", "6월"]\ny-axis 0 --> 300\nbar [120, 180, 210, 240, 260, 300]\nline [40, 65, 80, 95, 110, 130]';
  for (const source of [chart, 'flowchart LR\nA["요청"] --> B["처리"] --> C["응답"]']) {
    const raster = rasterize(source, { ...options, maxColumns: 100, fillWidth: 0.8, maxRows: 0 });
    assert(raster);
    assert(raster.columns <= 80, `expected at most 80 columns, got ${raster.columns}`);
    const left = Math.floor((100 - raster.columns) / 2);
    assert(left >= 10);
    assert(100 - left - raster.columns >= 10);
  }
});

test("row and column limits both hold for wide/tall graphs", () => {
  const diagram =
    "flowchart LR\n" + Array.from({ length: 15 }, (_, i) => `N${i} --> N${i + 1}`).join("\n");
  const raster = rasterize(diagram, { ...options, maxColumns: 40, maxRows: 12 });
  if (raster) {
    assert(raster.columns <= 40);
    assert(raster.rows <= 12);
  }
});

test("normalizes Korean xychart labels before Pele parsing", () => {
  const raster = rasterize(
    'xychart-beta\nx-axis [1월, 2월]\ny-axis 0 --> 10\nline "판매" [3, 7]',
    options,
  );
  assert(raster);
});

test("iTerm2 still receives PNG", () => {
  const raster = rasterize(source, { ...options, format: "png" });
  assert(raster);
  assert.equal(Buffer.from(raster.base64, "base64").subarray(1, 4).toString(), "PNG");
  assert(
    encodeITerm2Block(raster.base64, raster.columns, raster.rows, 0).lines.some((line) =>
      line.includes("1337;File="),
    ),
  );
});

test("saved SVGs stay opaque light mode while terminal rasters follow their appearance", () => {
  for (const diagram of [
    source,
    'xychart-beta\nx-axis ["1월", "2월"]\ny-axis 0 --> 10\nline [3,7]',
  ]) {
    const dark = rasterize(diagram, { ...options, appearance: "dark", background: "#181825" });
    const light = rasterize(diagram, { ...options, appearance: "light", background: "#fff1e6" });
    assert(dark);
    assert(light);
    assert.notEqual(dark.svg, light.svg);
    assert.notEqual(dark.base64, light.base64);
    assert.equal(dark.snapshotSvg, light.snapshotSvg);
    assert(dark.snapshotSvg.includes('fill="#24292f"'));
    assert(dark.snapshotSvg.includes('<rect width="100%" height="100%" fill="#ffffff"/>'));
    const image = new Resvg(dark.snapshotSvg, { font: { loadSystemFonts: false } }).render();
    assert.deepEqual([...image.pixels.subarray(0, 4)], [255, 255, 255, 255]);
    const url = saveSnapshot(dark.snapshotSvg);
    assert(url);
    assert.equal(saveSnapshot(light.snapshotSvg), url);
    assert.equal(readFileSync(fileURLToPath(url), "utf8"), dark.snapshotSvg);
  }
});

test("click snapshots are stable file URLs and preserve anchored blank rows", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>한글</text></svg>';
  const url = saveSnapshot(svg);
  assert(url);
  assert.equal(saveSnapshot(svg), url);
  assert.equal(readFileSync(fileURLToPath(url), "utf8"), svg);
  const linked = linkImageLines(["IMAGE", "", ""], url, 0, false);
  assert.equal(linked[1], "");
  assert.equal(linked[2], "");
  assert.equal(linked.length, 4);
  assert.equal(linked[3], `\x1b]8;;${url}\x1b\\Open SVG\x1b]8;;\x1b\\`);
  const virtual = linkImageLines(["IMAGE", "PLACEHOLDERS"], url, 0, true);
  assert(virtual.every((line) => line.includes(url)));
});

test("Herdr extension applies the decoded byte cap and separates terminal render caches", () => {
  const oldProgram = process.env.TERM_PROGRAM;
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 30, heightPx: 60 });
  let transform: Function;
  peleMermaid({
    on() {},
    registerCommand() {},
    registerMarkdownTransformer: (handler: Function) => {
      transform = handler;
    },
  } as unknown as ExtensionAPI);
  const chartFence =
    '```mermaid\nxychart-beta\nx-axis ["1월", "2월", "3월", "4월", "5월", "6월"]\ny-axis 0 --> 100\nline [22,31,45,58,71,88]\n```';
  const md = new Markdown(chartFence, 1, 0, theme, undefined, {
    transform: (text, availableWidth) =>
      transform(text, { availableWidth, messageType: "assistant", isStreaming: false }),
  });
  const dimensions = (lines: string[]) => {
    const control = lines.find((line) => line.includes("\x1b_G"))!;
    assert(control);
    return {
      bytes: Number(/\bs=(\d+)/.exec(control)?.[1]) * Number(/\bv=(\d+)/.exec(control)?.[1]) * 4,
      columns: Number(/\bc=(\d+)/.exec(control)?.[1]),
      rows: Number(/\br=(\d+)/.exec(control)?.[1]),
    };
  };
  try {
    process.env.TERM_PROGRAM = "herdr";
    const herdr = dimensions(md.render(210));
    assert(herdr.bytes > 0 && herdr.bytes <= 16 * 1024 * 1024);
    process.env.TERM_PROGRAM = "rex";
    md.invalidate();
    const rex = dimensions(md.render(210));
    assert(rex.bytes > 16 * 1024 * 1024);
    assert.equal(rex.columns, herdr.columns);
    assert.equal(rex.rows, herdr.rows);
  } finally {
    if (oldProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = oldProgram;
  }
});

test("extension reload command preserves cached transcript diagrams; cell changes invalidate raster cache", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  const hooks = new Map<string, Function>();
  const commands = new Map<string, any>();
  let transform: Function;
  peleMermaid({
    on: (name: string, handler: Function) => hooks.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMarkdownTransformer: (handler: Function) => {
      transform = handler;
    },
  } as unknown as ExtensionAPI);
  const md = new Markdown(fence, 1, 0, theme, undefined, {
    transform: (text, availableWidth) =>
      transform(text, { availableWidth, messageType: "assistant", isStreaming: false }),
  });
  const first = md.render(60);
  assert(first.some((line) => line.includes("f=32,o=z")));
  const snapshotUrl = /\x1b\]8;;(file:[^\x1b]+)\x1b\\/.exec(first.join("\n"))?.[1];
  assert(snapshotUrl);
  const savedSvg = readFileSync(fileURLToPath(snapshotUrl), "utf8");
  assert(savedSvg.includes('<rect width="100%" height="100%" fill="#ffffff"/>'));
  assert(savedSvg.includes('fill="#24292f"'));
  await commands.get("pele-mermaid-reload").handler("", { ui: { notify() {} } });
  assert.deepEqual(md.render(60), first);
  md.invalidate();
  const before = md.render(60).find((line) => line.includes("\x1b_G"));
  assert(before);
  setCellDimensions({ widthPx: 15, heightPx: 30 });
  md.invalidate();
  const after = md.render(60).find((line) => line.includes("\x1b_G"));
  assert(after);
  assert.notEqual(before, after);
});
