import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { taskLogView } from "../extensions/log-view.ts";

it("shows sanitized, wrapped task output without creating a terminal", () => {
  const done = vi.fn();
  const view = taskLogView(
    "done · 한글 task",
    "\x1b]52;c;secret\x07line one\n" + "긴 출력 ".repeat(30),
    "Esc close",
    5,
    { fg: (_color, text) => text },
    done,
  );
  const lines = view.render(25);
  expect(lines.join("\n")).toContain("line one");
  expect(lines.join("\n")).not.toContain("secret");
  expect(lines.every((line) => visibleWidth(line) <= 25)).toBe(true);
  view.handleInput("\x1b");
  expect(done).toHaveBeenCalledOnce();
});
