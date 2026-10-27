/**
 * Reader checks on authored prose. Each finding names its location and tells the author what to
 * write instead; walkthrough_write rejects a payload with findings.
 *
 * - Bare identifiers: ticket and decision numbers (ADR-0028, PC-32, ADR008, #123) and commit hashes
 *   mean nothing to a reader who was not there. Cite a declared reference, [[id]], whose label
 *   states the decision or the change.
 * - Density: long paragraphs, long list items and inline "(1) ... (2) ..." enumerations become
 *   walls of text. Split them into bullets or short paragraphs.
 *
 * Code (fenced and inline), math and [[references]] are not checked; verbatim evidence quotes are never
 * passed in. Blocks and inline tokens come from markup.ts, so the lint sees what the renderer draws.
 */

import { blocks, cells, tokenEnd } from "./markup.ts";

export const LIMITS = { paragraph: 60, item: 40, cell: 25, short: 40 } as const;

// Prefixes of standards and product names that are not references to project records.
const ALLOWED_PREFIXES = new Set(["SHA", "UTF", "ISO", "IEC", "IEEE", "ES", "MIL", "STD", "ARP", "AS", "EN", "DO", "NACA", "NASA", "GPT", "USB", "HTTP", "TLS", "DDR", "ARM", "CO", "NO", "SO"]);

const ID_PATTERNS: RegExp[] = [
	/\b([A-Z][A-Z]+)-\d+\b/g, // ADR-0028, PC-32, JIRA-123
	/\b([A-Z][A-Z]+)0\d+\b/g, // ADR008, ADR0028
	/\b([A-Z][A-Z]+) 0\d+\b/g, // ADR 0028
	/(?:^|[\s(])(#\d{1,6})\b/g, // #123
];
const HASH = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/g;

/** Text with code, math and [[refs]] blanked out, using the renderer's own token rules. */
function visible(text: string): string {
	return blocks(text).map((b) => {
		if (b.kind === "code" || b.kind === "math") return "";
		const lines = b.kind === "list" ? b.items : b.kind === "table" ? b.lines.flatMap((l) => cells(l)) : b.lines;
		return lines.map(stripInline).join("\n");
	}).join("\n\n");
}

function stripInline(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && (s[i + 1] === "$" || s[i + 1] === "|")) { out += s[i + 1]; i++; continue; }
		const end = tokenEnd(s, i);
		if (end > i) { out += " "; i = end; continue; }
		out += s[i];
	}
	return out;
}

export function bareIdentifiers(text: string): string[] {
	const t = visible(text);
	const found = new Set<string>();
	for (const re of ID_PATTERNS) {
		for (const m of t.matchAll(re)) {
			const token = m[0].trim().replace(/^\(/, "");
			if (m[1] && !m[1].startsWith("#") && ALLOWED_PREFIXES.has(m[1])) continue;
			found.add(token);
		}
	}
	for (const m of t.matchAll(HASH)) found.add(m[0]);
	return [...found];
}

const words = (s: string) => (s.match(/\S+/g) ?? []).length;

/** Density findings for block prose (summary, section text). Uses the renderer's block split. */
export function density(text: string): string[] {
	const out: string[] = [];
	let para = 0;
	for (const b of blocks(text)) {
		if (b.kind === "para") {
			para++;
			const p = stripInline(b.lines.join(" "));
			if (words(p) > LIMITS.paragraph) out.push(`paragraph ${para} has ${words(p)} words (max ${LIMITS.paragraph}), starting "${p.slice(0, 50)}…". Split it into bullets, one point each, or into shorter paragraphs`);
			if (/\(1\)[\s\S]*\(2\)/.test(p) || /(^|\s)1\)\s[\s\S]*\s2\)\s/.test(p)) out.push(`paragraph ${para} enumerates "(1) … (2) …" inline. Use a numbered list, one item per line`);
		} else if (b.kind === "list") {
			for (const item of b.items) {
				const t = stripInline(item);
				if (words(t) > LIMITS.item) out.push(`a list item has ${words(t)} words (max ${LIMITS.item}), starting "${t.slice(0, 50)}…". Shorten it or split it into sub-bullets`);
			}
		} else if (b.kind === "table") {
			const width = cells(b.lines[0]).length;
			b.lines.slice(2).forEach((l, r) => {
				const row = cells(l);
				if (row.length !== width) out.push(`table row ${r + 1} has ${row.length} cells but the header has ${width}. Escape a literal pipe as \\|`);
				for (const cell of row) {
					const t = stripInline(cell);
					if (words(t) > LIMITS.cell) out.push(`a table cell has ${words(t)} words (max ${LIMITS.cell}): "${t.slice(0, 50)}…". Move the detail into a bullet below the table`);
				}
			});
		}
	}
	return out;
}

/** Short fields (captions, evidence summaries, check summaries, limits). */
export function shortField(text: string, max: number = LIMITS.short): string[] {
	const n = words(visible(text));
	return n > max ? [`${n} words (max ${max}). Keep one point; put detail in the section text`] : [];
}

/** Citation ids that the renderer will resolve: [[id]] outside code and math. */
export function referenceIds(text: string): string[] {
	const ids: string[] = [];
	for (const b of blocks(text)) {
		if (b.kind === "code" || b.kind === "math") continue;
		const lines = b.kind === "list" ? b.items : b.kind === "table" ? b.lines.flatMap((l) => cells(l)) : b.lines;
		for (const s of lines) {
			for (let i = 0; i < s.length; i++) {
				const end = tokenEnd(s, i);
				if (end <= i) continue;
				const m = s[i] === "[" ? /^\[\[([a-z][a-z0-9-]*)(?:\|[^\]]*)?\]\]$/.exec(s.slice(i, end + 1)) : null;
				if (m) ids.push(m[1]);
				i = end;
			}
		}
	}
	return ids;
}
