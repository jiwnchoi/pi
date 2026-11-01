/**
 * Instant Steer
 *
 * Codex-style instant steering for Pi (this is Codex's `instant_interrupt`
 * feature).
 *
 * While Pi is working, a message you submit is queued as steering input and is
 * delivered only after the current tool batch finishes. Codex instead lets its
 * interrupt key stop the turn and send that queued steering input right away.
 *
 * Pi's interrupt path (Escape) empties the queue, writes it back into the editor
 * and aborts, so the correction has to be submitted by hand. This extension
 * changes that to Codex's behavior without replacing the editor:
 *
 * - When a run settles because it was interrupted and steering input was still
 *   queued, that steering text is taken out of the restored editor draft and is
 *   resubmitted immediately as a fresh turn.
 * - Queued follow-up messages and your own draft stay in the editor, matching
 *   Codex, which keeps follow-ups queued for after the turn.
 * - Interrupting with nothing queued, or interrupting while idle, is unchanged.
 *
 * Toggle with /instant_steer on|off|status.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "instant_steer";

let enabled = true;
/** Steering texts Pi has queued and not yet delivered, oldest first. */
let pendingSteers: string[] = [];
let lastCtx: ExtensionContext | undefined;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text";
		})
		.map((part) => part.text)
		.join("");
}

function editorText(ctx: ExtensionContext): string {
	try {
		return ctx.ui.getEditorText();
	} catch {
		return "";
	}
}

function refreshStatus(ctx = lastCtx): void {
	if (!ctx || ctx.mode !== "tui") return;
	const show = enabled && pendingSteers.length > 0;
	ctx.ui.setStatus(STATUS_KEY, show ? "esc → send steer now" : undefined);
}

/**
 * Pi writes the restored queue into the editor as
 * `steer1\n\nsteer2\n\nfollowUp\n\n<draft>`. Strip the leading steers this
 * extension saw queued; everything after them already belongs in the editor.
 */
function takeBackSteers(restored: string, queued: readonly string[]): { steers: string[]; rest: string } {
	const steers: string[] = [];
	let rest = restored;
	for (const text of queued) {
		if (!rest.startsWith(text)) break;
		steers.push(text);
		rest = rest.slice(text.length).replace(/^\s+/, "");
	}
	return { steers, rest };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
		pendingSteers = [];
		refreshStatus(ctx);
	});

	// Mirror Pi's own queue bookkeeping: a steering submit is queued here and is
	// removed once its user message starts.
	pi.on("input", (event, ctx) => {
		lastCtx = ctx;
		if (ctx.mode === "tui" && event.source !== "extension" && event.streamingBehavior === "steer") {
			pendingSteers.push(event.text);
			refreshStatus(ctx);
		}
		return { action: "continue" };
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "user" || pendingSteers.length === 0) return;
		const index = pendingSteers.indexOf(textOf(event.message.content));
		if (index !== -1) {
			pendingSteers.splice(index, 1);
			refreshStatus();
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		lastCtx = ctx;
		refreshStatus(ctx);
	});

	pi.on("agent_settled", (event, ctx) => {
		lastCtx = ctx;
		const queued = pendingSteers;
		pendingSteers = [];
		refreshStatus(ctx);

		if (!event.aborted || !enabled || queued.length === 0) return;
		if (ctx.mode !== "tui") return;

		const { steers, rest } = takeBackSteers(editorText(ctx), queued);
		if (steers.length === 0) return;

		ctx.ui.setEditorText(rest);
		try {
			pi.sendUserMessage(steers.join("\n\n"));
		} catch (error) {
			ctx.ui.setEditorText([...steers, rest].filter(Boolean).join("\n\n"));
			ctx.ui.notify(
				`instant_steer: could not resubmit (${error instanceof Error ? error.message : String(error)})`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", () => {
		pendingSteers = [];
		lastCtx = undefined;
	});

	pi.registerCommand("instant_steer", {
		description: "Toggle Codex-style instant steering (interrupt sends queued steers immediately)",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" || action === "off") {
				enabled = action === "on";
				ctx.ui.notify(`instant_steer ${enabled ? "enabled" : "disabled"}`, "info");
				refreshStatus(ctx);
				return;
			}
			ctx.ui.notify(
				`instant_steer is ${enabled ? "enabled" : "disabled"}. Usage: /instant_steer on|off|status`,
				"info",
			);
		},
	});
}
