import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TaskRecord, TaskState } from "../lib/types.ts";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
  dockText,
  stateColor,
  resultSummary,
  modelResult,
  notificationText,
  notificationColor,
  notificationMessage,
  notificationTaskIds,
  taskPicker,
} from "../extensions/presentation.ts";
const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
describe("compact task UI", () => {
  it("uses semantic colors for task states", () => {
    expect(stateColor("failed")).toBe("error");
    expect(stateColor("done")).toBe("success");
    expect(stateColor("running")).toBe("accent");
    expect(stateColor("queued")).toBe("warning");
    expect(
      dockText([{ state: "failed", n: 1 }], (state, text) => `[${stateColor(state)}:${text}]`),
    ).toContain("[error:1 failed]");
  });
  it("alerts the model with only task ID and status and colors failed alerts", () => {
    const detail = {
      taskId: "task_123",
      state: "failed",
      error: "secret error",
      outputPath: "/private/path",
      text: "secret output",
    };
    expect(notificationMessage([detail])).toBe(
      "Task task_123 failed. Use task_result if you need its result.",
    );
    expect(notificationTaskIds({ summaries: [detail] })).toEqual(["task_123"]);
    expect(notificationTaskIds({ summaries: [detail, { ...detail, taskId: "task_456" }] })).toEqual(
      ["task_123", "task_456"],
    );
    expect(notificationTaskIds({})).toEqual([]);
    expect(notificationColor({ summaries: [detail] })).toBe("error");
    expect(notificationColor({ summaries: [{ ...detail, state: "succeeded" }] })).toBe("success");
  });
  it("shows counts and Shift-down, never commands or management commands", () => {
    expect(
      dockText([
        { state: "running", n: 2 },
        { state: "starting", n: 1 },
        { state: "failed", n: 1 },
        { state: "succeeded", n: 4 },
      ]),
    ).toBe("tasks · 3 running · 1 failed · 4 done · Shift↓");
  });
  it("keeps receipt and notification display free of JSON, IDs and paths", () => {
    const summary = {
      name: "Build",
      state: "succeeded",
      taskId: "task_secret",
      exitCode: 0,
      outputPath: "/long/private/path",
    };
    expect(resultSummary(summary)).toBe("done · Build · exit 0");
    expect(notificationText({ summaries: [summary] })).toBe("done · Build");
    expect(modelResult(summary)).toContain("task_secret");
  });
  it("preserves requested log content for the model and expanded view", () => {
    const result = {
      taskId: "task_a",
      text: "actual log",
      bytes: 10,
      path: "/internal/path",
      truncated: false,
    };
    expect(resultSummary(result)).toBe("Logs · 10 B");
    expect(modelResult(result)).toContain("actual log");
    expect(modelResult(result)).not.toContain("/internal/path");
  });
  const task = (name: string, state: TaskState = "running"): TaskRecord => ({
    id: name,
    owner: "test",
    name,
    kind: "shell",
    current_run: "run",
    run_id: "run",
    state,
    spec: "{}",
    rex_session: "s",
    rex_block: null,
    rex_source: null,
    created: 0,
    started: 0,
    ended: null,
    heartbeat: 0,
    exit_code: null,
    error: null,
    result_path: null,
    log_path: "",
    parent_run: null,
  });
  it("groups tasks in priority order with non-selectable dividers", () => {
    const rows = [
      task("Complete", "succeeded"),
      task("Error", "failed"),
      task("Waiting", "queued"),
      task("Active"),
      task("Starting", "starting"),
      task("Stopping", "stop_requested"),
      task("Timeout", "timed_out"),
      task("Unknown", "unknown"),
      task("Stopped", "stopped"),
    ];
    const selected: (string | undefined)[] = [];
    const actions: string[] = [];
    const picker = taskPicker(
      rows,
      theme,
      (id) => selected.push(id),
      20,
      (type, id) => actions.push(`${type}:${id}`),
    );
    const rendered = picker.render(80).join("\n");
    const headings = [...rendered.matchAll(/─ (running|queued|failed|done) /g)].map(
      (match) => match[1],
    );
    expect(headings).toEqual(["running", "queued", "failed", "done"]);
    const order = [
      "Active",
      "Starting",
      "Stopping",
      "Waiting",
      "Error",
      "Timeout",
      "Unknown",
      "Complete",
      "Stopped",
    ];
    order.forEach(() => {
      picker.handleInput("\r");
      picker.handleInput("k");
      picker.handleInput("c");
      picker.handleInput("\x1b[B");
    });
    expect(selected).toEqual(order);
    expect(actions).toEqual(order.flatMap((name) => [`kill:${name}`, `clear:${name}`]));
    expect(rows[0].name).toBe("Complete");
  });
  it("sorts each group by the last state change, not creation or heartbeat", () => {
    const rows = [
      { ...task("Older completion", "succeeded"), state_changed: 10, created: 500, heartbeat: 999 },
      { ...task("New completion", "succeeded"), state_changed: 90, created: 1 },
      { ...task("Older running"), state_changed: 20, heartbeat: 999 },
      { ...task("New running"), state_changed: 50, heartbeat: 1 },
      { ...task("Older queued", "queued"), started: null, created: 30 },
      { ...task("New queued", "queued"), started: null, created: 40 },
      { ...task("Older failure", "failed"), ended: 60 },
      { ...task("New failure", "failed"), ended: 70 },
    ];
    const selected: (string | undefined)[] = [];
    const picker = taskPicker(rows, theme, (id) => selected.push(id));
    rows.forEach(() => {
      picker.handleInput("\r");
      picker.handleInput("\x1b[B");
    });
    expect(selected).toEqual([
      "New running",
      "Older running",
      "New queued",
      "Older queued",
      "New failure",
      "Older failure",
      "New completion",
      "Older completion",
    ]);
    expect(rows[0].name).toBe("Older completion");
  });
  it("keeps the selected task visible while scrolling across groups", () => {
    const picker = taskPicker(
      [
        task("Active"),
        task("Waiting", "queued"),
        task("Error", "failed"),
        task("Complete", "succeeded"),
      ],
      theme,
      () => {},
      3,
    );
    for (const name of ["Active", "Waiting", "Error", "Complete"]) {
      const lines = picker.render(60);
      expect(lines.join("\n")).toContain(`→ ${name}`);
      expect(lines).toHaveLength(7);
      picker.handleInput("\x1b[B");
    }
    picker.handleInput("\x1b[A");
    expect(picker.render(60).join("\n")).toContain("→ Complete");
  });
  it("frames the popup within terminal columns, including narrow and empty views", () => {
    const picker = taskPicker([task("한글 작업 🚀 ".repeat(20))], theme, () => {});
    for (const width of [0, 1, 2, 10, 60]) {
      const lines = picker.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 2) {
        expect(lines[0]).toMatch(/^╭.*╮$/);
        expect(lines.at(-1)).toMatch(/^╰.*╯$/);
        expect(
          lines
            .slice(1, -1)
            .every(
              (line) => line.startsWith("│") && line.endsWith("│") && visibleWidth(line) === width,
            ),
        ).toBe(true);
      }
    }
    let closed = false;
    const empty = taskPicker([], theme, () => {
      closed = true;
    });
    expect(empty.render(60).join("\n")).toContain("No tasks");
    empty.handleInput("\x1b");
    expect(closed).toBe(true);
  });
  it("uses the full width for names without a duplicate status column", () => {
    const name = "Sidekick 불필요한 작업 이력 문제를 확인하고 마지막 내용까지 표시";
    const picker = taskPicker([task(name)], theme, () => {});
    const lines = picker.render(120);
    expect(lines[3]).toContain(name);
    expect(lines[3]).not.toContain("running");
    expect(lines.join("\n").match(/running/g)).toHaveLength(1);
  });
  it("wraps long names without dropping their text", () => {
    const name = "abcdefghij ".repeat(5).trim();
    const picker = taskPicker([task(name)], theme, () => {}, 20);
    const lines = picker.render(24);
    const text = lines
      .slice(3, 8)
      .map((line) => line.slice(1, -1).replace(/^→ /, "").trim())
      .join("");
    expect(text).toBe(name.replaceAll(" ", ""));
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
  const mouse = (overrides: Partial<TuiMouseEvent>): TuiMouseEvent => ({
    type: "click",
    button: "left",
    x: 10,
    y: 3,
    screenX: 10,
    screenY: 3,
    width: 60,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  });
  it("opens clicked task rows and ignores dividers, borders and the footer", () => {
    const selected: (string | undefined)[] = [];
    const picker = taskPicker([task("Active"), task("Complete", "succeeded")], theme, (id) =>
      selected.push(id),
    );
    const lines = picker.render(60);
    for (const y of [0, 1, 2, 4, lines.length - 2, lines.length - 1])
      picker.handleMouse(mouse({ y }));
    picker.handleMouse(mouse({ x: 0, y: 3 }));
    expect(selected).toEqual([]);
    picker.handleMouse(mouse({ type: "press", y: 5 }));
    picker.render(60);
    picker.handleMouse(mouse({ y: 5 }));
    expect(selected).toEqual(["Complete"]);
    picker.handleMouse(mouse({ y: 3 }));
    expect(selected).toEqual(["Complete", "Active"]);
  });
  it("opens wrapped continuation lines and maps clicks after scrolling", () => {
    const name = "abcdefghij ".repeat(5).trim();
    let selected: string | undefined;
    const picker = taskPicker(
      [task(name)],
      theme,
      (id) => {
        selected = id;
      },
      10,
    );
    picker.render(24);
    picker.handleMouse(mouse({ width: 24, y: 4 }));
    expect(selected).toBe(name);
    const scrolled = taskPicker(
      [task("Active"), task("Waiting", "queued"), task("Complete", "succeeded")],
      theme,
      (id) => {
        selected = id;
      },
      3,
    );
    scrolled.render(60);
    scrolled.handleMouse(mouse({ type: "wheel", button: "none", wheelDelta: 1 }));
    const lines = scrolled.render(60);
    const y = lines.findIndex((line) => line.includes("→ Waiting"));
    expect(y).toBeGreaterThan(1);
    scrolled.handleMouse(mouse({ y }));
    expect(selected).toBe("Waiting");
  });
  it("uses arrow keys and Enter to select, and Escape to cancel", () => {
    const rows = [task("First"), task("Second")];
    let selected: string | undefined;
    const picker = taskPicker(rows, theme, (id) => {
      selected = id;
    });
    picker.handleInput("\x1b[B");
    picker.handleInput("\r");
    expect(selected).toBe("Second");
    picker.handleInput("\x1b");
    expect(selected).toBeUndefined();
    expect(picker.render(60).every((line) => visibleWidth(line) <= 60)).toBe(true);
  });
});
