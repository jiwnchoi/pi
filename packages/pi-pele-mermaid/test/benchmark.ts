import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { setCapabilities, setCellDimensions } from "@earendil-works/pi-tui";
import peleMermaid from "../extensions/pele-mermaid.ts";
import { detect, rasterize } from "../extensions/render.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const directory = mkdtempSync(join(tmpdir(), "pele-benchmark-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
try {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  let transform!: (text: string, context: any) => string;
  peleMermaid({
    on() {},
    registerCommand() {},
    registerMarkdownTransformer(fn: typeof transform) {
      transform = fn;
    },
  } as unknown as ExtensionAPI);
  const source =
    'flowchart TD\nA["请求接收"] --> B["缓存检查"]\nB --> C["图像渲染"]\nC --> D["画面显示"]';
  const markdown = `\`\`\`mermaid\n${source}\n\`\`\``;
  const context = { messageType: "assistant", isStreaming: true, availableWidth: 80 };
  const run = (name: string, count: number, fn: () => unknown) => {
    const start = performance.now();
    for (let i = 0; i < count; i++) fn();
    console.log(JSON.stringify({ name, count, totalMs: +(performance.now() - start).toFixed(2) }));
  };
  run("first render (raw+zlib, selected fonts, snapshot)", 1, () => transform(markdown, context));
  run("previous detect-on-cache-hit work alone", 100, () => detect(source));
  run("optimized complete cached transformer", 100, () => transform(markdown, context));
  run("no-diagram fast path", 10000, () => transform("普通响应文本", context));
  const fontDir = join(homedir(), "Library", "Fonts");
  let allFonts: string[] = [];
  try {
    allFonts = readdirSync(fontDir)
      .filter((name) => /pretendard|d2coding/i.test(name))
      .map((name) => join(fontDir, name));
  } catch {}
  const selectedFonts = allFonts.filter((path) => /regular|(?:^|[-_])bold\b|\.ttc$/i.test(path));
  const options = {
    appearance: "dark" as const,
    maxColumns: 80,
    fillWidth: 1,
    scale: 2,
    padding: 10,
    fontFamily: "Pretendard",
    fontFamilyMono: "D2Coding",
    fontFiles: selectedFonts,
    loadSystemFonts: false,
    maxRows: 40,
  };
  for (const format of ["png", "rgba-zlib"] as const) {
    let bytes = 0;
    run(`raster ${format} selected fonts (${selectedFonts.length})`, 3, () => {
      const result = rasterize(source, { ...options, format });
      if (result) bytes = Buffer.byteLength(result.base64, "base64");
    });
    console.log(JSON.stringify({ format, bytes }));
  }
  run(`raw+zlib all font weights (${allFonts.length})`, 3, () =>
    rasterize(source, { ...options, fontFiles: allFonts, format: "rgba-zlib" }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
}
