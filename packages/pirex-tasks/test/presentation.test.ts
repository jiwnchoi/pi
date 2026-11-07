import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TaskRecord } from "../lib/types.ts";
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
  it("uses arrow keys and Enter to select, and Escape to cancel", () => {
    // The picker only uses these three fields of a task record.
    const rows: TaskRecord[] = ["First", "Second"].map((name, index) => ({
      id: `task_${index}`,
      owner: "test",
      name,
      kind: "shell",
      current_run: `run_${index}`,
      run_id: `run_${index}`,
      state: "running",
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
    }));
    let selected: string | undefined;
    const picker = taskPicker(rows, theme, (id) => {
      selected = id;
    });
    picker.handleInput("\x1b[B");
    picker.handleInput("\r");
    expect(selected).toBe("task_1");
    picker.handleInput("\x1b");
    expect(selected).toBeUndefined();
    expect(picker.render(60).every((line) => line.length <= 60)).toBe(true);
  });
});
