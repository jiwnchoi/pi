import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { taskRow, type TaskRowState } from "../extensions/tool-row.ts";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
const click: TuiMouseEvent = {
  type: "click",
  button: "left",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 80,
  height: 1,
  shift: false,
  alt: false,
  ctrl: false,
};
const theme: Pick<Theme, "fg"> = { fg: (_color, text) => text };
describe("task tool rows", () => {
  it("renders one row and opens the Rex task on click", () => {
    const state: TaskRowState = {};
    const context = { state };
    let clicked = 0;
    const call = taskRow("call", "starting · Wait", theme, context, () => {
      clicked++;
    });
    expect(call.render(80)).toHaveLength(1);
    const result = taskRow("result", "queued · Wait", theme, context, () => {
      clicked++;
    });
    expect(call.render(80)).toEqual([]);
    expect(result.render(80)).toEqual(["  queued · Wait"]);
    result.handleMouse?.(click);
    expect(clicked).toBe(1);
    expect(result.render(80)).toHaveLength(1);
  });
});
