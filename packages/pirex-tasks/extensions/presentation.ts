import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type TuiMouseEvent,
  type TuiMouseEventResult,
  wrapTextWithAnsi,
  Container,
  SelectList,
  Text,
  truncateToWidth,
  visibleWidth,
  matchesKey,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { sanitize } from "../lib/runtime.ts";
import type { TaskRecord, TaskState } from "../lib/types.ts";

export const oneLine = (text: string): string => sanitize(text).replace(/\s+/g, " ").trim();
const labels: Record<string, string> = {
  succeeded: "done",
  timed_out: "timed out",
  stop_requested: "stopping",
  starting: "starting",
};
export const stateLabel = (state: string): string => labels[state] || state;
export function dockText(
  counts: { state: TaskState; n: number }[],
  paint: (state: string, text: string) => string = (_state, text) => text,
): string {
  const groups = new Map<string, number>();
  for (const { state, n } of counts) {
    const key = ["starting", "running", "stop_requested"].includes(state)
      ? "running"
      : state === "timed_out"
        ? "failed"
        : stateLabel(state);
    groups.set(key, (groups.get(key) || 0) + n);
  }
  return [
    paint("label", "tasks"),
    ...["running", "queued", "failed", "stopped", "unknown", "done"]
      .filter((key) => groups.has(key))
      .map((key) => paint(key, `${groups.get(key)} ${key}`)),
    paint("label", "Shift↓"),
  ].join(paint("label", " · "));
}
export function stateColor(state: string) {
  return ["failed", "timed_out"].includes(state)
    ? "error"
    : ["done", "succeeded"].includes(state)
      ? "success"
      : state === "running"
        ? "accent"
        : ["queued", "unknown"].includes(state)
          ? "warning"
          : "dim";
}
export function coloredDock(
  counts: { state: TaskState; n: number }[],
  theme: Pick<Theme, "fg">,
): Text {
  return Object.assign(new Text("", 0, 0), {
    render: (width: number) => [
      truncateToWidth(
        dockText(counts, (state, text) => theme.fg(stateColor(state), text)),
        width,
      ),
    ],
  });
}
export function resultSummary(data: Record<string, unknown>): string {
  if (Array.isArray(data.tasks)) return `${data.tasks.length} tasks`;
  if (typeof data.text === "string")
    return `Logs · ${typeof data.bytes === "number" ? data.bytes : 0} B${data.truncated ? " · truncated" : ""}`;
  const state =
    typeof data.state === "string"
      ? stateLabel(data.state)
      : data.ready === false
        ? "running"
        : "done";
  const name = typeof data.name === "string" ? oneLine(data.name) : "";
  const exit = typeof data.exitCode === "number" ? ` · exit ${data.exitCode}` : "";
  return `${state}${name ? " · " + name : ""}${exit}`;
}
export function modelResult(data: Record<string, unknown>): string {
  const id = typeof data.taskId === "string" ? ` · ${data.taskId}` : "";
  if (typeof data.text === "string") return `${resultSummary(data)}${id}\n${data.text}`;
  if (
    data.output &&
    typeof data.output === "object" &&
    "text" in data.output &&
    typeof data.output.text === "string"
  )
    return `${resultSummary(data)}${id}\n${data.output.text}`;
  if (Array.isArray(data.tasks))
    return (
      data.tasks
        .map((item) =>
          Value.Check(summarySchema, item)
            ? `${stateLabel(item.state)} · ${oneLine(item.name || "")} · ${item.taskId}`
            : "",
        )
        .filter(Boolean)
        .join("\n") || "No tasks"
    );
  return resultSummary(data) + id + (typeof data.error === "string" ? `\n${data.error}` : "");
}
const summarySchema = Type.Object({
  taskId: Type.String(),
  state: Type.String(),
  name: Type.Optional(Type.String()),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const notificationSchema = Type.Object({ summaries: Type.Array(summarySchema) });
export function notificationTaskIds(details: unknown): string[] {
  const schema = Type.Object({ summaries: Type.Array(Type.Object({ taskId: Type.String() })) });
  return Value.Check(schema, details) ? details.summaries.map((item) => item.taskId) : [];
}
export function notificationMessage(items: { taskId: string; state: string }[]): string {
  return items
    .map((item) => `Task ${item.taskId} ${item.state}. Use task_result if you need its result.`)
    .join("\n");
}
export function notificationColor(details: unknown): ReturnType<typeof stateColor> {
  if (!Value.Check(notificationSchema, details)) return "dim";
  if (details.summaries.some((item) => ["failed", "timed_out"].includes(item.state)))
    return "error";
  if (details.summaries.every((item) => item.state === "succeeded")) return "success";
  return "warning";
}
export function styledNotification(details: unknown, theme: Pick<Theme, "fg">): string {
  const text = notificationText(details);
  const [status, ...rest] = text.split(" · ");
  return (
    theme.fg(notificationColor(details), status) +
    (rest.length ? theme.fg("muted", " · " + rest.join(" · ")) : "")
  );
}
export function notificationText(details: unknown): string {
  if (!Value.Check(notificationSchema, details)) return "Task completed";
  if (details.summaries.length === 1) {
    const item = details.summaries[0];
    return `${stateLabel(item.state)} · ${oneLine(item.name || "Task")}`;
  }
  return `${details.summaries.length} tasks completed`;
}
export function taskPicker(
  rows: TaskRecord[],
  theme: Pick<Theme, "fg">,
  done: (id: string | undefined) => void,
  visibleRows = 16,
  action: (type: "kill" | "clear", id: string) => void = () => {},
): Container & { handleInput(data: string): void } {
  const box = new Container();
  const groups = ["running", "queued", "failed", "done"] as const;
  const groupFor = (state: TaskState): (typeof groups)[number] => {
    if (["starting", "running", "stop_requested"].includes(state)) return "running";
    if (state === "queued") return "queued";
    if (["failed", "timed_out", "unknown"].includes(state)) return "failed";
    return "done";
  };
  const changedAt = (row: TaskRecord) =>
    row.state_changed ?? row.ended ?? row.started ?? row.created;
  const sorted = groups.flatMap((group) =>
    rows
      .filter((row) => groupFor(row.state) === group)
      .sort((left, right) => changedAt(right) - changedAt(left)),
  );
  const list = new SelectList(
    sorted.map((row) => ({
      value: row.id,
      label: oneLine(row.name),
    })),
    Math.max(1, sorted.length),
    {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("dim", text),
    },
  );
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(undefined);
  let hitRows: (string | undefined)[] = [];
  let pressedId: string | undefined;
  return Object.assign(box, {
    render(width: number): string[] {
      const innerWidth = Math.max(0, width - 2);
      const border = (text: string) => theme.fg("border", text);
      const frame = (text: string) => {
        const content = truncateToWidth(text, innerWidth, "");
        return truncateToWidth(
          border("│") +
            content +
            " ".repeat(Math.max(0, innerWidth - visibleWidth(content))) +
            border("│"),
          width,
          "",
        );
      };
      const divider = (group: string) => {
        const label = `─ ${group} `;
        return theme.fg(
          stateColor(group),
          label + "─".repeat(Math.max(0, innerWidth - label.length)),
        );
      };
      const selectedId = list.getSelectedItem()?.value;
      const entries: { text: string; group: string; id?: string }[] = [];
      sorted.forEach((row, index) => {
        const group = groupFor(row.state);
        if (index === 0 || group !== groupFor(sorted[index - 1].state))
          entries.push({ text: divider(group), group });
        const lines = wrapTextWithAnsi(oneLine(row.name), Math.max(1, innerWidth - 2));
        lines.forEach((line, lineIndex) => {
          const text = `${row.id === selectedId && lineIndex === 0 ? "→ " : "  "}${line}`;
          entries.push({
            text: row.id === selectedId ? theme.fg("accent", text) : text,
            group,
            id: row.id,
          });
        });
      });
      const limit = Math.max(3, visibleRows);
      const scrolling = entries.length > limit;
      const capacity = scrolling ? limit - 1 : limit;
      const selectedIndex = entries.findIndex((entry) => entry.id === selectedId);
      const start = Math.max(
        0,
        Math.min(selectedIndex - Math.floor((capacity - 1) / 2), entries.length - capacity),
      );
      const window = entries.slice(start, start + capacity);
      if (window[0]?.id) {
        window.unshift({ text: divider(window[0].group), group: window[0].group });
        window.pop();
      }
      hitRows = window.map((entry) => entry.id);
      const body = window.map((entry) => entry.text);
      if (!sorted.length) body.push(theme.fg("dim", "  No tasks"));
      if (scrolling)
        body.push(
          theme.fg(
            "dim",
            `  (${sorted.findIndex((row) => row.id === selectedId) + 1}/${sorted.length})`,
          ),
        );
      body.push(...Array<string>(Math.max(0, limit - body.length)).fill(""));
      return [
        truncateToWidth(border("╭" + "─".repeat(innerWidth) + "╮"), width, ""),
        frame(theme.fg("accent", ` Tasks · ${rows.length}`)),
        ...body.map(frame),
        frame(theme.fg("dim", " ↑↓ select · Click/Enter open · k kill · c clear · Esc close")),
        truncateToWidth(border("╰" + "─".repeat(innerWidth) + "╯"), width, ""),
      ];
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type === "wheel") {
        pressedId = undefined;
        return list.handleMouse(event);
      }
      if (event.button !== "left" || (event.type !== "press" && event.type !== "click"))
        return undefined;
      if (event.x <= 0 || event.x >= event.width - 1) return undefined;
      const id = hitRows[event.y - 2];
      if (event.type === "press") {
        pressedId = id;
        return id ? { handled: true, focus: true, render: false } : undefined;
      }
      const target = pressedId ?? id;
      pressedId = undefined;
      if (!target) return undefined;
      done(target);
      return { handled: true };
    },
    handleInput(data: string) {
      pressedId = undefined;
      const selected = list.getSelectedItem();
      if (selected && (matchesKey(data, "k") || matchesKey(data, "c"))) {
        action(matchesKey(data, "k") ? "kill" : "clear", selected.value);
        return;
      }
      list.handleInput(data);
    },
  });
}
export function compactText(text: string, theme: Pick<Theme, "fg">): Text {
  const result = new Text("", 0, 0);
  return Object.assign(result, {
    render: (width: number) => [truncateToWidth(theme.fg("dim", oneLine(text)), width)],
  });
}
