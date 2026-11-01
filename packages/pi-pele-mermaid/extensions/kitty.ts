/**
 * Kitty graphics protocol encoding.
 *
 * Two placement strategies, both driven by the same raster:
 *
 * **Unicode placeholders (preferred).** The image is uploaded once with `U=1` and then drawn by
 * printing ordinary text: one placeholder per cell, followed by combining diacritics that encode
 * the row and column. Because the drawing lives in the text itself, it scrolls with the
 * transcript, survives partial redraws, and is re-emitted automatically whenever the TUI redraws
 * those rows. A plain APC placement cannot do that: Kitty keeps it in a separate layer, and Pi
 * deletes every image it no longer sees in the viewport.
 *
 * **Direct placement (fallback).** For terminals that implement the protocol but not
 * placeholders, the image is anchored to the cell the APC sequence lands on with `C=1` so the
 * cursor stays put. The caller reserves `rows` rows for it.
 *
 * See https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
 */

import { registerKittyImageMetadata } from "@earendil-works/pi-tui/dist/terminal-image.js";

const CHUNK_SIZE = 4096;
/** Kitty caps placeholder grids at 297 rows and columns. */
const MAX_PLACEHOLDER_DIMENSION = 297;
const PLACEHOLDER = String.fromCodePoint(0x10_ee_ee);

/**
 * Combining marks Kitty reserves for placeholder coordinates, in its canonical order
 * (Unicode combining class 230). Index `n` addresses row or column `n`.
 */
const DIACRITICS = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351,
	0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d,
	0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599,
	0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
	0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6,
	0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
	0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747,
	0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819,
	0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a,
	0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd,
	0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f,
	0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
	0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7,
	0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5,
	0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0,
	0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea,
	0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8,
	0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
	0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef,
	0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23,
	0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac,
	0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
].map((codePoint) => String.fromCodePoint(codePoint));

export interface ImageBlock {
	/** Rows of text this block occupies. */
	lines: string[];
	columns: number;
	rows: number;
	/** True when the block is drawn with Unicode placeholders rather than an anchored APC. */
	placeholders: boolean;
}

/**
 * Terminals known to implement Unicode placeholders. Kitty, Ghostty and WezTerm do; iTerm2 and
 * Warp speak the protocol without them, so they fall back to anchored placements.
 */
export function supportsPlaceholders(env: NodeJS.ProcessEnv = process.env): boolean {
	const program = env.TERM_PROGRAM?.toLowerCase() ?? "";
	const term = env.TERM?.toLowerCase() ?? "";
	// Inner terminals inherit outer-terminal hints, but may not implement placeholders.
	if (env.TMUX || /^(?:tmux|screen)/.test(term)) return false;
	if (["herdr", "rex", "warpterminal", "iterm.app"].includes(program)) return false;
	return Boolean(
		env.KITTY_WINDOW_ID ||
			program === "kitty" ||
			program === "ghostty" ||
			term.includes("kitty") ||
			term.includes("ghostty") ||
			env.GHOSTTY_RESOURCES_DIR ||
			env.WEZTERM_PANE ||
			program === "wezterm",
	);
}

/**
 * Herdr expands compressed uploads before forwarding them. Its inline graphics transaction
 * allows 30 MiB including base64/command overhead; native snapshots cap decoded data at 16 MiB.
 * Bound decoded RGBA, not the tiny zlib payload, so wide/retina images survive both paths.
 */
export function kittyRasterByteLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
	return env.TERM_PROGRAM?.toLowerCase() === "herdr" ? 16 * 1024 * 1024 : undefined;
}

function rgb(id: number): string {
	return `${(id >> 16) & 0xff};${(id >> 8) & 0xff};${id & 0xff}`;
}

export interface KittyPayload {
	format: "rgba-zlib" | "png";
	widthPx: number;
	heightPx: number;
}

function transmit(base64: string, imageId: number, columns: number, rows: number, virtual: boolean, payload?: KittyPayload): string {
	const params = ["a=T", "q=2", `i=${imageId}`, `c=${columns}`, `r=${rows}`];
	if (payload?.format === "rgba-zlib") {
		params.push("f=32", "o=z", `s=${payload.widthPx}`, `v=${payload.heightPx}`);
	} else {
		params.push("f=100");
	}
	if (virtual) {
		params.push("U=1", `p=${imageId}`);
	} else {
		// Keep the cursor where it is; the caller reserves rows and positions the drawing.
		// Below text and non-default cell backgrounds: editor/overlay text must win over
		// the separate graphics layer. Reserved image rows use the default background.
		params.push("C=1", "z=-2147483648");
	}
	if (base64.length <= CHUNK_SIZE) {
		return `\x1b_G${params.join(",")};${base64}\x1b\\`;
	}
	const chunks: string[] = [];
	for (let offset = 0; offset < base64.length; offset += CHUNK_SIZE) {
		const chunk = base64.slice(offset, offset + CHUNK_SIZE);
		if (offset === 0) {
			chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
		} else {
			const last = offset + CHUNK_SIZE >= base64.length;
			chunks.push(`\x1b_Gm=${last ? 0 : 1},q=2;${chunk}\x1b\\`);
		}
	}
	return chunks.join("");
}

/**
 * Builds the placeholder rows. Each cell is the placeholder character plus a row diacritic and a
 * column diacritic, colored so Kitty can match the cell to the placement.
 */
function placeholderLines(imageId: number, columns: number, rows: number, left: number): string[] {
	const foreground = `\x1b[38;2;${rgb(imageId)}m`;
	// The underline color is optional: with one virtual placement per image Kitty can choose
	// it by image ID alone. Pi's ANSI tracker does not understand SGR 58 and interprets its
	// RGB channels as independent SGR commands (e.g. channel 101 becomes bright-red background)
	// when clipping/compositing scrollbars and overlays. Do not emit SGR 58 here.
	const reset = "\x1b[0m";
	const indent = " ".repeat(left);
	const lines: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const rowMark = DIACRITICS[row] ?? "";
		let cells = `${reset}${indent}${foreground}`;
		for (let column = 0; column < columns; column += 1) {
			cells += `${PLACEHOLDER}${rowMark}${DIACRITICS[column] ?? ""}`;
		}
		lines.push(`${cells}${reset}`);
	}
	return lines;
}

export function encodeKittyBlock(
	base64: string,
	columns: number,
	rows: number,
	imageId: number,
	left: number,
	payload?: KittyPayload,
): ImageBlock {
	if (supportsPlaceholders() && columns <= MAX_PLACEHOLDER_DIMENSION && rows <= MAX_PLACEHOLDER_DIMENSION) {
		return {
			lines: [transmit(base64, imageId, columns, rows, true, payload), ...placeholderLines(imageId, columns, rows, left)],
			columns,
			rows,
			placeholders: true,
		};
	}
	// Pi's layout uses this metadata to crop anchored images at scroll viewport edges
	// and reconstruct the visible tail when the anchor has scrolled off the top. r= alone
	// is not enough. Virtual placements must stay unregistered: their text grid clips itself.
	if (payload) {
		registerKittyImageMetadata({ imageId, columns, rows, widthPx: payload.widthPx, heightPx: payload.heightPx });
	}
	// Anchored placement: one APC line, then the rows the TUI must keep clear for it.
	const sequence = transmit(base64, imageId, columns, rows, false, payload);
	const prefix = " ".repeat(left);
	return {
		lines: [`${prefix}${sequence}`, ...Array.from({ length: Math.max(0, rows - 1) }, () => "")],
		columns,
		rows,
		placeholders: false,
	};
}

/** iTerm2 inline image. The caller reserves rows because iTerm2 has no row control. */
export function encodeITerm2Block(base64: string, columns: number, rows: number, left: number): ImageBlock {
	const size = Buffer.byteLength(base64, "base64");
	const sequence = `\x1b]1337;File=inline=1;size=${size};width=${columns};height=auto:${base64}\x07`;
	const prefix = " ".repeat(left);
	const offset = Math.max(0, rows - 1);
	const moveUp = offset > 0 ? `\x1b[${offset}A` : "";
	return {
		lines: [
			...Array.from({ length: offset }, () => ""),
			`${prefix}${moveUp}${sequence}`,
		],
		columns,
		rows,
		placeholders: false,
	};
}
