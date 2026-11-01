/**
 * Artifacts for Pi
 *
 * Exposes the full Claude Code `Artifact` tool surface to a Pi session by
 * driving a headless Claude Code run (`claude -p`) and forwarding one call.
 *
 * Requirements:
 * - Claude Code installed and signed in to claude.ai (`claude` then `/login`)
 * - A plan that includes artifacts (Pro, Max, Team, Enterprise)
 *
 * Usage:
 *   /artifact report.html      publish a file
 *   /artifact ./site           publish a folder that contains index.html
 *   /artifact                  prompt for a path
 *
 * The model calls the `artifact` tool with an `action`:
 *   publish (default), read, list, list_files, read_file, list_assets,
 *   read_asset, list_types, describe_type, quickstart, comments, reply,
 *   resolve, verify, version, pin, unpin, share, upload_asset, delete,
 *   delete_asset, watch, unwatch, status
 *
 * Anything not covered by a named parameter goes through `args`, which is
 * forwarded to the Artifact tool verbatim.
 *
 * The headless session runs on Haiku by default; set CLAUDE_ARTIFACT_MODEL to
 * use a different model (for example `sonnet` or `claude-opus-4-6`).
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[0-9a-fA-F-]{8,}/i;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const ARTIFACT_MODEL = process.env.CLAUDE_ARTIFACT_MODEL?.trim() || "haiku";

interface RunOptions {
	args: Record<string, unknown>;
	output: "url" | "text";
	instructions?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	cwd: string;
}

interface RunResult {
	text: string;
	url?: string;
	toolCalls: number;
}

interface TargetInfo {
	kind: "file" | "folder";
	files: string[];
}

function describeTarget(target: string): TargetInfo {
	if (statSync(target).isFile()) return { kind: "file", files: [target] };
	const files: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 3 || files.length >= 200) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else files.push(full);
		}
	};
	walk(target, 0);
	return { kind: "folder", files };
}

function validateTarget(target: string): { target: string; info: TargetInfo } {
	if (!existsSync(target)) throw new Error(`No such file or folder: ${target}`);
	const info = describeTarget(target);
	if (info.kind === "folder" && !info.files.some((file) => /(^|\/)index\.html?$/i.test(file))) {
		throw new Error(`Folder ${target} has no index.html to publish as the site root`);
	}
	return { target, info };
}

function buildPrompt(options: RunOptions): string {
	const lines = [
		"Call the Artifact tool with exactly these parameters:",
		JSON.stringify(options.args, null, 2),
		"",
	];
	if (options.instructions) {
		lines.push(`Extra guidance for this call: ${options.instructions.trim()}`, "");
	}
	if (options.args.action === "publish" && typeof options.args.url === "string") {
		lines.push(
			`This is an update of ${options.args.url}, and each run starts with a fresh session. Read that artifact first with action "read", merge the local file onto that version, and only then publish to the same url. If the publish is refused because the live version was not viewed, the refusal hands it back: merge onto it and publish again.`,
			"",
		);
	}
	lines.push(
		"Rules:",
		"- Pass the parameters exactly as given. Do not add, rename, or drop any.",
		options.output === "url"
			? "- Say nothing and print nothing else. Make the call, then hand back only the link: your entire answer is the artifact URL alone, on one line."
			: "- Say nothing else. Your entire answer is the tool result's payload, verbatim, with no commentary and no code fences.",
	);
	return lines.join("\n");
}

function flattenContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (typeof block === "string" ? block : typeof block?.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function runClaude(options: RunOptions): Promise<RunResult> {
	const prompt = buildPrompt(options);
	return new Promise((resolvePromise, reject) => {
		const child = execFile(
			"claude",
			[
				"-p",
				prompt,
				"--model",
				ARTIFACT_MODEL,
				"--allowedTools",
				"Artifact,Read,Skill",
				"--permission-mode",
				"acceptEdits",
				"--output-format",
				"stream-json",
				"--verbose",
			],
			{
				cwd: options.cwd,
				maxBuffer: 64 * 1024 * 1024,
				timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				env: { ...process.env, CLAUDE_CODE_ARTIFACT: "1", CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0" },
			},
			(error, stdout, stderr) => {
				const events = stdout
					.split("\n")
					.filter((line) => line.trim())
					.flatMap((line) => {
						try {
							return [JSON.parse(line)];
						} catch {
							return [];
						}
					});

				let toolCalls = 0;
				let resultText = "";
				let lastToolResult = "";
				let lastToolError: string | null = null;
				const artifactUseIds = new Set<string>();
				const texts: string[] = [];

				for (const event of events) {
					if (event.type === "assistant") {
						for (const block of event.message?.content ?? []) {
							if (block.type === "tool_use" && /^Artifact$/i.test(block.name)) {
								toolCalls += 1;
								if (typeof block.id === "string") artifactUseIds.add(block.id);
							}
							if (block.type === "text" && block.text) texts.push(block.text);
						}
					}
					if (event.type === "user") {
						for (const block of event.message?.content ?? []) {
							if (block.type !== "tool_result" || !artifactUseIds.has(block.tool_use_id)) continue;
							const body = flattenContent(block.content);
							if (block.is_error) {
								lastToolError = body;
							} else {
								lastToolError = null;
								lastToolResult = body;
							}
						}
					}
					if (event.type === "result" && typeof event.result === "string" && event.result.trim()) {
						resultText = event.result;
					}
				}

				const answer = (resultText || texts.join("\n")).trim();

				if (lastToolError !== null) {
					const loginHint = /need a claude\.ai login/i.test(lastToolError + stderr)
						? "\nRun `claude`, then `/login`, and retry."
						: "";
					reject(new Error(`Artifact call failed: ${lastToolError.trim()}${loginHint}`));
					return;
				}

				const url = answer.match(ARTIFACT_URL)?.[0] ?? lastToolResult.match(ARTIFACT_URL)?.[0];
				if (options.output === "url") {
					if (!url) {
						const detail = error?.message ?? "the result carried no artifact URL";
						const loginHint = /need a claude\.ai login/i.test(answer + stderr)
							? "\nRun `claude`, then `/login`, and retry."
							: "";
						const tail = answer ? `\n${answer.slice(-800)}` : "";
						reject(new Error(`Claude Code did not return an artifact URL: ${detail}${loginHint}${tail}`));
						return;
					}
					resolvePromise({ text: url, url, toolCalls });
					return;
				}

				resolvePromise({ text: lastToolResult.trim() || answer || "(the Artifact call returned nothing)", url, toolCalls });
			},
		);
		options.signal?.addEventListener("abort", () => child.kill(), { once: true });
	});
}

function sessionContext(ctx: ExtensionContext): string {
	return ctx.cwd ?? process.cwd();
}

const ACTION_NAMES = [
	"publish",
	"read",
	"list",
	"list_files",
	"read_file",
	"list_assets",
	"read_asset",
	"list_types",
	"describe_type",
	"quickstart",
	"comments",
	"reply",
	"resolve",
	"verify",
	"version",
	"pin",
	"unpin",
	"share",
	"upload_asset",
	"delete",
	"delete_asset",
	"status",
	"unwatch",
].join(", ");

const URL_ACTIONS = new Set(["publish"]);

const ACTION_FIELDS = [
	"url",
	"version",
	"prompt",
	"page",
	"limit",
	"scope",
	"type_url",
	"type_query",
	"asset_ids",
	"from_url",
	"out_dir",
	"asset_id",
	"thread",
	"reply",
	"resolve",
	"mode",
	"access",
	"people",
	"intent",
	"description",
	"icon",
];

const LOCAL_PATH_ACTIONS = new Set(["publish", "upload_asset"]);

function actionArgs(params: Record<string, unknown>): Record<string, unknown> {
	const args: Record<string, unknown> = {};
	for (const field of ACTION_FIELDS) {
		const value = params[field];
		if (value !== undefined) args[field] = value;
	}
	const extra = params.args;
	if (extra && typeof extra === "object" && !Array.isArray(extra)) Object.assign(args, extra as Record<string, unknown>);
	return args;
}

export default function artifactExtension(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "artifact",
			label: "Artifact",
			description:
				"Use the claude.ai Artifact tool: publish or update a page, read one, list the account's artifacts, browse an artifact's files, assets and versions, read or answer comments, read runtime diagnostics, and manage pins and sharing. Set `action` to pick one (publish when omitted); pass any other Artifact parameter through `args`.",
			parameters: Type.Object({
				action: Type.Optional(
					Type.String({
						description: `Artifact action, default publish. One of: ${ACTION_NAMES}.`,
					}),
				),
				path: Type.Optional(Type.String({ description: "publish/upload_asset: local file or folder, relative or absolute" })),
				url: Type.Optional(Type.String({ description: "Target artifact URL; with publish it updates that artifact in place" })),
				title: Type.Optional(Type.String({ description: "publish: artifact title; with no path it renames the artifact" })),
				instructions: Type.Optional(Type.String({ description: "Extra guidance for how the page should be presented" })),
				prompt: Type.Optional(Type.String({ description: "read: what you need from the artifact" })),
				version: Type.Optional(Type.String({ description: "read/version: a version id from the artifact's history" })),
				page: Type.Optional(Type.String({ description: "read: a published page path to read" })),
				limit: Type.Optional(Type.Number({ description: "list/comments: how many rows to return" })),
				scope: Type.Optional(Type.String({ description: 'list: "mine" (default), "shared", "all", "types" or "assets"' })),
				type_url: Type.Optional(Type.String({ description: "describe_type: the Artifact type URL" })),
				type_query: Type.Optional(Type.String({ description: "list_types: narrow the listing" })),
				asset_id: Type.Optional(Type.String({ description: "read_asset/delete_asset: 32-hex asset id" })),
				asset_ids: Type.Optional(Type.Array(Type.String(), { description: "publish: asset ids to copy from from_url" })),
				from_url: Type.Optional(Type.String({ description: "publish: artifact URL holding the assets being reused" })),
				out_dir: Type.Optional(Type.String({ description: "read_file/read_asset: where to save the fetched content" })),
				thread: Type.Optional(Type.String({ description: "comments/reply/resolve: comment thread id" })),
				reply: Type.Optional(Type.String({ description: "reply: the reply text" })),
				resolve: Type.Optional(Type.String({ description: "resolve: the thread id to mark resolved" })),
				args: Type.Optional(
					Type.Record(Type.String(), Type.Unknown(), {
						description: "Any further Artifact parameters, forwarded verbatim and merged last",
					}),
				),
				timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout in seconds, default 900" })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const cwd = sessionContext(ctx);
				const action = (params.action ?? "publish").trim() || "publish";
				const args = actionArgs(params as unknown as Record<string, unknown>);
				args.action = action;
				if (params.title && action === "publish") args.title = params.title;
				if (params.path) {
					if (LOCAL_PATH_ACTIONS.has(action)) {
						const filePath = resolve(cwd, params.path);
						if (action === "publish") validateTarget(filePath);
						args.file_path = filePath;
					} else {
						args.path = params.path;
					}
				}

				const result = await runClaude({
					args,
					output: URL_ACTIONS.has(action) ? "url" : "text",
					instructions: params.instructions,
					timeoutMs: params.timeoutSeconds ? params.timeoutSeconds * 1000 : undefined,
					signal,
					cwd,
				});

				return {
					content: [{ type: "text", text: result.text }],
					details: {
						action,
						url: URL_ACTIONS.has(action) ? result.url : (args.url as string | undefined),
						toolCalls: result.toolCalls,
					},
				};
			},
		}),
	);

	pi.registerCommand("artifact", {
		description: "Publish a file or folder as an artifact",
		handler: async (args, ctx) => {
			const cwd = sessionContext(ctx);
			let path = args.trim();
			if (!path) {
				const choice = await ctx.ui.input("Artifact to publish", "path/to/report.html or ./site");
				if (!choice) return;
				path = choice.trim();
			}

			let target: string;
			let info: TargetInfo;
			try {
				({ target, info } = validateTarget(resolve(cwd, path)));
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const label = info.kind === "folder" ? `Folder (${info.files.length} files)` : `File (${basename(target)})`;
			const confirmed = await ctx.ui.confirm(
				"Publish to claude.ai artifact?",
				`${label}: ${target}\n\nNew pages are private to you and can contain session content.`,
			);
			if (!confirmed) return;

			ctx.ui.setStatus("artifact", "Publishing artifact...");
			try {
				const result = await runClaude({
					args: { action: "publish", file_path: target },
					output: "url",
					signal: ctx.signal,
					cwd,
				});
				ctx.ui.notify(result.url ?? result.text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				ctx.ui.setStatus("artifact", undefined);
			}
		},
	});
}
