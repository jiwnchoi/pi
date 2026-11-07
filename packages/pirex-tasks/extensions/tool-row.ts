import {
  truncateToWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stateColor } from "./presentation.ts";
export interface TaskRowState {
  hasResult?: boolean;
}
interface RowContext {
  state: TaskRowState;
}
/** One visible slot; clicking opens the task's actual Rex terminal. */
export function taskRow(
  slot: "call" | "result",
  summary: string,
  theme: Pick<Theme, "fg">,
  ctx: RowContext,
  open: () => void,
): Component {
  const state = ctx.state;
  if (slot === "result") state.hasResult = true;
  const visible = () => (slot === "result" ? !!state.hasResult : !state.hasResult);
  return {
    render(width: number): string[] {
      if (!visible()) return [];
      const [status, ...rest] = summary.split(" · ");
      return [
        truncateToWidth(
          "  " +
            theme.fg(stateColor(status), status) +
            (rest.length ? theme.fg("muted", " · " + rest.join(" · ")) : ""),
          width,
        ),
      ];
    },
    invalidate() {},
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (!visible() || event.type !== "click" || event.button !== "left") return;
      open();
      return { handled: true };
    },
  };
}
