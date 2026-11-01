/**
 * Configuration loading.
 *
 * Values are read from `~/.pi/agent/pele-mermaid.json` rather than Pi's settings.json, because
 * Pi validates settings against a strict schema and would reject unknown keys.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clamp } from "./theme.ts";

export interface PeleConfig {
	enabled: boolean;
	/** "auto" follows the Pi theme's light/dark appearance. */
	mode: "auto" | "dark" | "light";
	/** Rasterization multiplier. Higher is sharper and produces larger PNGs. */
	scale: number;
	font: string;
	/** Font for monospace labels such as class members. */
	fontMono?: string;
	/** Extra font directories. When empty, known system directories are scanned. */
	fontDirs: string[];
	/** Whether to draw while a message is still streaming. */
	streaming: boolean;
	/** Whether to add Mermaid-only instructions to the system prompt. */
	guidance: boolean;
	/** Horizontal padding in base-size pixels. */
	padding: number;
	/** Maximum columns the image may span. 0 uses all available width. */
	maxColumns: number;
	/**
	 * Maximum display width as a fraction of the available width (0..1). `0.8` leaves
	 * roughly 10% margins on each side. Narrow diagrams are magnified toward this target;
	 * wide ones are scaled down to it.
	 */
	fillWidth: number;
	/** Maximum rows. A taller diagram keeps its source code block instead. */
	maxRows: number;
	/** Raster pixel height cap; oversized rasters reduce sharpness instead of failing. */
	maxHeightPx: number;
}

export const DEFAULTS: PeleConfig = {
	enabled: true,
	mode: "auto",
	scale: 2,
	font: "Pretendard",
	fontMono: "D2Coding",
	fontDirs: [],
	streaming: true,
	guidance: true,
	padding: 10,
	maxColumns: 0,
	fillWidth: 0.8,
	maxRows: 40,
	maxHeightPx: 4096,
};

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? "", ".pi", "agent");
}

export function configPath(): string {
	return join(agentDir(), "pele-mermaid.json");
}

let cached: { stamp: number; config: PeleConfig } | undefined;

export function loadConfig(): PeleConfig {
	const path = configPath();
	let stamp: number;
	try {
		stamp = statSync(path).mtimeMs;
	} catch {
		cached = undefined;
		return DEFAULTS;
	}
	if (cached && cached.stamp === stamp) return cached.config;

	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return DEFAULTS;
	}

	const num = (value: unknown, fallback: number, min: number, max: number) =>
		typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback;
	const str = (value: unknown, fallback: string) =>
		typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
	const optStr = (value: unknown, fallback: string | undefined) =>
		typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
	const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

	const mode = raw.mode;
	const config: PeleConfig = {
		enabled: bool(raw.enabled, DEFAULTS.enabled),
		mode: mode === "dark" || mode === "light" || mode === "auto" ? mode : DEFAULTS.mode,
		// Beyond 4x the PNG grows into multiple megabytes and transfer latency dominates.
		scale: num(raw.scale, DEFAULTS.scale, 1, 4),
		font: str(raw.font, DEFAULTS.font),
		fontMono: optStr(raw.fontMono, DEFAULTS.fontMono),
		fontDirs: Array.isArray(raw.fontDirs)
			? raw.fontDirs.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
			: DEFAULTS.fontDirs,
		streaming: bool(raw.streaming, DEFAULTS.streaming),
		guidance: bool(raw.guidance, DEFAULTS.guidance),
		padding: num(raw.padding, DEFAULTS.padding, 0, 64),
		maxColumns: num(raw.maxColumns, DEFAULTS.maxColumns, 0, 400),
		fillWidth:
			typeof raw.fillWidth === "number" && Number.isFinite(raw.fillWidth)
				? clamp(raw.fillWidth, 0.1, 1)
				: typeof raw.minWidth === "number" && Number.isFinite(raw.minWidth)
					? clamp(raw.minWidth, 0.1, 1)
					: DEFAULTS.fillWidth,
		maxRows: num(raw.maxRows, DEFAULTS.maxRows, 0, 400),
		maxHeightPx: num(raw.maxHeightPx, DEFAULTS.maxHeightPx, 256, 8192),
	};
	cached = { stamp, config };
	return config;
}

/** Writes a default config file when none exists yet. Returns whether it wrote one. */
export function ensureConfigFile(write: (path: string, content: string) => void): boolean {
	const path = configPath();
	try {
		statSync(path);
		return false;
	} catch {
		// Missing: fall through and create it.
	}
	write(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`);
	return true;
}
