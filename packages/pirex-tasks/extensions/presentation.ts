import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, truncateToWidth, matchesKey } from "@earendil-works/pi-tui";
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
  box.addChild(new Text(theme.fg("accent", `Tasks · ${rows.length}`), 1, 0));
  const list = new SelectList(
    rows.map((row) => ({
      value: row.id,
      label: oneLine(row.name),
      description: stateLabel(row.state),
    })),
    visibleRows,
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
  box.addChild(list);
  box.addChild(
    new Text(theme.fg("dim", "↑↓ select · Enter open · k kill · c clear · Esc close"), 1, 0),
  );
  return Object.assign(box, {
    handleInput(data: string) {
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
