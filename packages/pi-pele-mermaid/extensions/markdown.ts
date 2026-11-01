/** Two-stage, lossless Mermaid placement in Pi's Markdown renderer. */
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";

// One visible cell plus combining marks: unlike a long ASCII token this cannot wrap at
// narrow transcript widths. The marks encode a monotonically increasing placement ID.
const MARKER_PATTERN = /\uE000[\u0300-\u030F]+/u;

export interface Placement {
  columns: number;
  rows: number;
  encode: (left: number) => string[];
  availableColumns: number;
  indentColumns: number;
}
export type PlacementInput = Pick<Placement, "columns" | "rows" | "encode">;
export interface SourceTransformInput {
  markdown: string;
  availableWidth: number;
  place: (source: string, contentColumns: number) => PlacementInput | undefined;
}

type RenderFn = (this: Markdown, width: number) => string[];
interface PlacementState {
  counter: number;
  placements: Map<string, WeakRef<Placement>>;
  markers: WeakMap<PlacementInput, Map<string, string>>;
  owners: WeakMap<Markdown, Set<Placement>>;
  outputs: WeakMap<string[], string[]>;
  wrappers: WeakSet<RenderFn>;
  active?: Markdown;
  cleanup: FinalizationRegistry<string>;
}
// Prototype patches outlive extension reloads. Share state so a reload neither stacks wrappers
// nor disconnects markers still held in Markdown's own line cache.
const STATE = Symbol.for("pi-pele-mermaid.placements.v2");
const prototype = Markdown.prototype as unknown as Record<symbol, PlacementState>;
const state: PlacementState = (prototype[STATE] ??= {
  counter: 0,
  placements: new Map(),
  markers: new WeakMap(),
  owners: new WeakMap(),
  outputs: new WeakMap(),
  wrappers: new WeakSet(),
  cleanup: new FinalizationRegistry((marker) => state.placements.delete(marker)),
});

function registerPlacement(
  input: PlacementInput,
  availableColumns: number,
  indentColumns: number,
): string {
  let variants = state.markers.get(input);
  if (!variants) state.markers.set(input, (variants = new Map()));
  const key = `${availableColumns}|${indentColumns}`;
  const existing = variants.get(key);
  const live = existing ? state.placements.get(existing)?.deref() : undefined;
  if (existing && live) {
    if (state.active) state.owners.get(state.active)?.add(live);
    return existing;
  }
  const marker = `\uE000${(++state.counter)
    .toString(16)
    .split("")
    .map((digit) => String.fromCodePoint(0x0300 + Number.parseInt(digit, 16)))
    .join("")}`;
  const placement: Placement = { ...input, availableColumns, indentColumns };
  state.placements.set(marker, new WeakRef(placement));
  state.cleanup.register(placement, marker);
  variants.set(key, marker);
  if (state.active) state.owners.get(state.active)?.add(placement);
  return marker;
}

/** Only call when the transcript is being discarded, not on config reload. */
export function clearPlacements(): void {
  state.placements.clear();
  state.markers = new WeakMap();
  state.owners = new WeakMap();
  state.outputs = new WeakMap();
  // Do not reset IDs: an old finalizer must never delete a newly assigned marker.
}

/** Closed fences only; ignore Mermaid-looking text inside another code fence. */
export function replaceFences(input: SourceTransformInput): string {
  if (!/[`~]{3}/.test(input.markdown)) return input.markdown;
  const lines = input.markdown.split("\n");
  const width = Math.max(1, Math.floor(input.availableWidth));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})([^\r]*)\r?$/.exec(lines[i]!);
    if (!opening) {
      out.push(lines[i]!);
      continue;
    }
    const [, prefix = "", delimiter = "", info = ""] = opening;
    const closing = new RegExp(
      `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${delimiter[0]}{${delimiter.length},}[ \\t]*\\r?$`,
    );
    let end = i + 1;
    while (end < lines.length && !closing.test(lines[end]!)) end++;
    if (end === lines.length) {
      out.push(...lines.slice(i));
      break;
    }
    const mermaid = /^mermaid(?:\s|$)/i.test(info.trim());
    const indentColumns = visibleWidth(prefix.replace(/\t/g, "   "));
    const contentColumns = width - indentColumns;
    const source = lines
      .slice(i + 1, end)
      .map((line) =>
        (line.startsWith(prefix) ? line.slice(prefix.length) : line).replace(/\r$/, ""),
      )
      .join("\n");
    const placement =
      mermaid && contentColumns >= 8 ? input.place(source, contentColumns) : undefined;
    if (placement) {
      out.push("", `${prefix}${registerPlacement(placement, contentColumns, indentColumns)}`, "");
    } else {
      out.push(...lines.slice(i, end + 1));
    }
    i = end;
  }
  return out.join("\n");
}

export function applyPlacements(lines: string[]): string[] {
  const cached = state.outputs.get(lines);
  if (cached) return cached;
  const out: string[] = [];
  for (const line of lines) {
    const marker = MARKER_PATTERN.exec(line)?.[0];
    const placement = marker ? state.placements.get(marker)?.deref() : undefined;
    if (!placement) {
      out.push(line);
      continue;
    }
    // Retain placements while this Markdown instance can return its cached marker rows.
    if (state.active) state.owners.get(state.active)?.add(placement);
    const at = line.indexOf(marker!);
    const before = line.slice(0, at);
    const left =
      Math.max(visibleWidth(before), placement.indentColumns) +
      Math.max(0, Math.floor((placement.availableColumns - placement.columns) / 2));
    out.push(...placement.encode(left));
  }
  state.outputs.set(lines, out);
  return out;
}

export function installPlacementPass(): void {
  const current = Markdown.prototype.render as RenderFn;
  if (state.wrappers.has(current)) return;
  const wrapper: RenderFn = function (width) {
    const previous = state.active;
    state.active = this;
    if (!state.owners.has(this)) state.owners.set(this, new Set());
    try {
      return applyPlacements(current.call(this, width));
    } finally {
      state.active = previous;
    }
  };
  state.wrappers.add(wrapper);
  Markdown.prototype.render = wrapper;
}

export function rearmPlacementPass(): void {
  installPlacementPass();
}
