/**
 * System prompt guidance.
 *
 * The extension only pays off if the model actually emits Mermaid blocks. Without an explicit
 * instruction, models default to ASCII box art and `-->` arrows, which this renderer cannot
 * draw. The guidance is appended through `before_agent_start`, so it lands in the same system
 * prompt turn after turn without being baked into the user's own AGENTS.md.
 */

export const DIAGRAM_GUIDELINE =
  "Never draw diagrams as ASCII art, Unicode box drawings, or text arrows such as `-->`, `──▶`, or `|`/`+` grids. When a diagram, flow, architecture, sequence, state machine, entity relationship, timeline, or chart helps explain something, always put it inside a fenced ```mermaid code block and let the renderer draw it.";

export const DIAGRAM_SECTION = [
  "Diagrams are rendered from Mermaid source, so the source is the only thing you need to write.",
  "",
  "- Emit every diagram, without exception, as a fenced ```mermaid block. Never hand-draw a diagram with ASCII art, box-drawing characters, or text arrows (`-->`, `->`, `──▶`, `==>`, `+---+`).",
  "- Choose the diagram type that matches the idea: `flowchart` for process and architecture, `sequenceDiagram` for message order, `stateDiagram-v2` for lifecycles, `classDiagram` or `erDiagram` for structure, `gantt` or `timeline` for schedules, `pie` or `xychart-beta` for numbers.",
  "- Prefer horizontal, landscape diagrams over tall, vertical ones. Use `flowchart LR` rather than `flowchart TD` or `TB` when the meaning allows; for other diagram types, use a supported left-to-right layout when available. Split long vertical chains into several compact diagrams instead of creating a very tall chart. Keep horizontal layouts within the available width so labels remain readable.",
  "- Keep nodes and labels short. The diagram is rasterized at terminal size, so wide graphs shrink their own text.",
  "- Prefer one focused diagram over one crowded diagram. Split a large system into several Mermaid blocks with a sentence of prose between them.",
  "- A plain bulleted list is still better than a diagram when the content is not relational. Do not force a diagram onto simple prose.",
  '- Quote node labels that contain spaces, punctuation, parentheses, or non-ASCII text: `A["요청 처리"]`, `x-axis ["1월", "2월"]`. Unquoted labels are the most common parse failure.',
  "- Keep each diagram inside the row budget. A very tall flowchart is better split into two linked diagrams than drawn as one 100-row column.",
].join("\n");
