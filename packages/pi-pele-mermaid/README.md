# @jiwnchoi/pi-pele-mermaid

Renders Mermaid diagrams in the Pi transcript as crisp terminal graphics, using
[Pele](https://github.com/obsidianmd/pele) for layout and SVG output.

## Why

Pi's built-in Mermaid support draws Unicode box art. That is readable but loses layout fidelity,
and it cannot express charts such as pie, git graph, or quadrant. This extension rasterizes the
real Pele SVG and places it with the Kitty graphics protocol, so a diagram looks the same as it
does in a browser.

## Behavior

- **Background follows the terminal.** The diagram is painted with the terminal's own background
  color, and node surfaces are mixed from it, so shapes never look like holes punched in the
  transcript. Only light and dark appearances are supported.
- **Sharp.** Layout is computed once at Pele's base font size, then the finished vector is
  re-rasterized at `scale`×. Display magnification is applied only once. Oversized rasters reduce
  resolution automatically rather than failing a pixel-limit check. Herdr additionally caps decoded
  RGBA at 16 MiB, preserving the display cell box while reducing raster resolution. Its forwarding
  budget applies after decompression, so a small zlib upload alone is not enough.
- **Fast transport.** Kitty receives raw RGBA compressed with zlib at level 1 (`f=32,o=z`),
  including explicit pixel dimensions. iTerm2 uses PNG because it does not support raw RGBA.
- **Click to open.** Placeholder image cells link to a local SVG original saved in light mode
  on an opaque white background, independently of the terminal display theme.
  Fullscreen Pi opens it with the platform handler (`open` on macOS); regular terminals use their
  hyperlink gesture, usually Cmd-click. Anchored-image terminals show an `열기` link below the
  image, keeping the reserved image rows genuinely blank.
- **Lossless.** The model context and the session file keep the original ` ```mermaid `
  block. Only the rendered rows are replaced.
- **Cached.** Streaming deltas reuse raster and encoded lines without re-parsing Pele. Markers
  are stable, one cell wide, and retained only by live Markdown instances and the render cache.
  Default font discovery loads selected regular/bold/collection faces, not every unused weight.
- **Proportional.** The canvas is built from the exact `c=`/`r=` cell box Kitty is told to fill,
  so text is never squashed to meet a rounded size.
- **Responsive.** Diagrams use at most 80% of the row by default (`fillWidth: 0.8`), centered
  with roughly 10% margins on each side. Narrow ones are magnified, wide ones scaled down,
  and tall ones shrink to the row budget.
- **Scrolls with the transcript.** On Kitty, Ghostty, and WezTerm the drawing is emitted as
  Unicode placeholders, so it is ordinary text that survives scrolling and partial redraws.

## Requirements

A terminal that supports the Kitty graphics protocol (Kitty, Ghostty, WezTerm, Warp, Herdr) or
iTerm2 inline images. Pi detects this itself; with no image protocol available the original code
block is shown.

## Installation

Registered in `~/.pi/agent/settings.json`:

```json
"packages": ["./packages/@jiwnchoi/pi-pele-mermaid"]
```

On first load the extension sets `markdown.mermaid` to `"off"` in `~/.pi/agent/settings.json`,
because Pi's built-in Mermaid transformer runs _before_ extension transformers and would otherwise
consume the fences. A notification reports the change; restore the setting to undo it.

## Configuration

`~/.pi/agent/pele-mermaid.json` (created with defaults on first run):

| Key           | Default        | Meaning                                                                                                                                                                                                 |
| ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`     | `true`         | Master switch.                                                                                                                                                                                          |
| `mode`        | `"auto"`       | `"auto"` follows the Pi theme appearance; `"dark"` / `"light"` force it.                                                                                                                                |
| `scale`       | `2`            | Rasterization multiplier, 1–4. Higher is sharper and larger on the wire.                                                                                                                                |
| `font`        | `"Pretendard"` | Label font. Must be installed locally.                                                                                                                                                                  |
| `fontMono`    | `"D2Coding"`   | Font for monospace labels (class members, ER attributes).                                                                                                                                               |
| `fontDirs`    | `[]`           | Extra font directories. Empty scans known system directories.                                                                                                                                           |
| `streaming`   | `true`         | Draw while the message is still streaming.                                                                                                                                                              |
| `guidance`    | `true`         | Append Mermaid-only instructions to the system prompt.                                                                                                                                                  |
| `padding`     | `10`           | Horizontal padding, in base-size pixels.                                                                                                                                                                |
| `maxColumns`  | `0`            | Maximum columns. `0` uses all available width.                                                                                                                                                          |
| `fillWidth`   | `0.8`          | Maximum display width as a fraction of available width. `0.8` leaves roughly 10% on each side; `1` fills the row. Tall or very small diagrams may leave larger margins.                                 |
| `maxRows`     | `40`           | Terminal row cap. `0` disables this limit. Anchored placements are additionally limited to 60% of terminal height.                                                                                      |
| `maxHeightPx` | `4096`         | Raster pixel-height cap, 256–8192. If exceeded, reduce raster resolution while retaining the terminal cell box and aspect ratio. The raster also stays within 8192 pixels wide and 16 megapixels total. |

`PELE_MERMAID_BACKGROUND` overrides the detected terminal background (for example `#1e1e2e`).

## Commands

- `/pele-mermaid` — show the active appearance, background, scale, protocol, and config path.
- `/pele-mermaid-reload` — re-read the config and clear render caches. Existing transcript
  placements remain intact; use Pi's `/reload` after changing extension source code.

Click snapshots persist under `<agent-dir>/cache/pele-mermaid/` as content-addressed SVG files.
New snapshots always use the light palette and a white background; terminal graphics keep following
the configured appearance/theme. The same layout is reused without a second Pele render. Previously
saved files are not rewritten; reload Pi to generate new light-mode links.
They contain diagram labels, use private file permissions, and are never uploaded externally.
Remove that directory manually to reclaim disk space; old click links will then stop working.
The terminal path does not encode a PNG for Kitty, including when snapshots are enabled.

## Tests

Run `npm test` with Node 24 (or Node 22 with TypeScript stripping support). Tests cover narrow
widths, cached redraws, reload composition, streaming and nested fences, cell-size changes,
zlib payload reconstruction, tall/retina bounds, chart normalization, Herdr decoded-byte limits across resize widths, anchored viewport clipping,
scrolling past image anchors, and click snapshot links.

## How images reach the transcript

`registerMarkdownTransformer()` runs while the source string is still being assembled, which is too
early: Markdown measures that string as text, and an embedded APC escape would be wrapped or
mangled. So the extension works in two stages.

1. The transformer swaps each closed fence for a stable, single-cell marker paragraph. It
   supports backtick/tilde fences and leaves examples inside other code blocks untouched.
2. A wrapper around `Markdown.prototype.render` replaces the marker row with image rows, caches
   the resulting lines, and retains placements for as long as the Markdown instance is live.
   The wrapper/state is shared across extension reloads so patches cannot stack indefinitely.

Anchored placements reserve genuinely blank rows and register their pixel/cell dimensions with
Pi's image metadata registry. The fullscreen layout then crops images to the transcript viewport
and reconstructs their visible tail when the anchor scrolls off the top, rather than drawing over
the editor/footer. The placement uses a negative Kitty z-index below text and non-default cell
backgrounds so floating buttons and overlays remain readable. Unicode placeholder grids are not
registered as anchored images: their text cells already clip with the transcript.

A diagram is never silently dropped: when Pele cannot parse the source, or the drawing cannot
fit at a legible scale, a warning names the reason once.

Unicode placeholders avoid the problem entirely. The image is transmitted with `U=1` and then
drawn by printing one placeholder character per cell, with combining diacritics encoding the row
and column. The foreground color identifies the image; optional underline-color IDs are deliberately
omitted because Pi's ANSI tracker can misread their RGB channels as background commands during
scrollbar/overlay composition. Each image row starts and ends with a full SGR reset. Because the drawing _is_ text, it scrolls with the transcript and is re-emitted on
every redraw — an anchored placement would be deleted as soon as it left the viewport. Terminals
that implement the protocol without placeholders (iTerm2, Warp) fall back to anchored rows.

## Why the theme code exists

resvg does not resolve CSS custom properties, so rasterizing a Pele SVG directly produces a fully
transparent image. `extensions/theme.ts` folds every `var(--_s)` alias, every
`var(--pele-surface, …)` token, and every `color-mix(…)` expression into a concrete color before
the SVG reaches resvg. Unknown tokens collapse to their documented fallback, so a color Pele adds
in a future release degrades to the fallback instead of dropping the element.
