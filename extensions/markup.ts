/**
 * Reader prose: a small, closed subset of Markdown with KaTeX math, rendered to escaped HTML.
 *
 * Blocks: paragraphs, pipe tables, bullet and numbered lists, fenced code, and $$ display math.
 * Inline: `code`, **bold**, $math$ and \$ for a literal dollar sign.
 * There are no links, raw HTML, images or attributes, so prose cannot produce active markup.
 * KaTeX runs at render time with trust disabled; the page needs no script or network for math.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import katex from "katex";

export function esc(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// trust:false rejects \href, \url, \includegraphics and \html*; limits bound expansion cost.
const KATEX = { throwOnError: false, trust: false, strict: "ignore", output: "htmlAndMathml", maxSize: 20, maxExpand: 300 } as const;

export function math(tex: string, display: boolean): string {
	return katex.renderToString(tex, { ...KATEX, displayMode: display });
}

// Pandoc's rule: $ opens before a non-space, closes after a non-space, and not before a digit.
// So "$5 and $10" stays text while "$a^2$" is math.
function closingDollar(s: string, from: number): number {
	for (let j = from; j < s.length; j++) {
		if (s[j] === "\\") { j++; continue; }
		if (s[j] === "$") return /\s/.test(s[j - 1]) || /[0-9]/.test(s[j + 1] ?? "") ? -1 : j;
	}
	return -1;
}

export interface RefTarget { href?: string; label: string; title: string }
let refResolver: ((id: string) => RefTarget | undefined) | undefined;
/** Set while rendering one page; [[id]] in prose resolves through it. */
export function withReferences<T>(resolve: typeof refResolver, fn: () => T): T {
	const prev = refResolver;
	refResolver = resolve;
	try { return fn(); } finally { refResolver = prev; }
}

export function inline(s: string, strong = true): string {
	let out = "";
	let text = "";
	const flush = () => { out += esc(text); text = ""; };
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\\" && (s[i + 1] === "$" || s[i + 1] === "|")) { text += s[i + 1]; i++; continue; }
		if (c === "`") {
			const end = s.indexOf("`", i + 1);
			if (end > i + 1) { flush(); out += `<code>${esc(s.slice(i + 1, end))}</code>`; i = end; continue; }
		}
		if (c === "[" && s[i + 1] === "[") {
			const end = s.indexOf("]]", i + 2);
			const m = end > 0 ? /^([a-z][a-z0-9-]*)(?:\|([^\]]+))?$/.exec(s.slice(i + 2, end)) : null;
			const ref = m && refResolver?.(m[1]);
			if (m && ref) {
				flush();
				// Labels render without reference expansion, so a label citing itself cannot recurse.
				const saved = refResolver;
				refResolver = undefined;
				let label: string;
				try { label = inline(m[2] ?? ref.label, false); } finally { refResolver = saved; }
				out += ref.href ? `<a class="ref" href="${esc(ref.href)}" title="${esc(ref.title)}"${ref.href.startsWith("#") ? "" : ' rel="noreferrer"'}>${label}</a>` : `<span class="ref" title="${esc(ref.title)}">${label}</span>`;
				i = end + 1;
				continue;
			}
		}
		if (c === "$" && s[i + 1] === "$") {
			const end = s.indexOf("$$", i + 2);
			if (end > i + 2) { flush(); out += math(s.slice(i + 2, end), true); i = end + 1; continue; }
		}
		if (c === "$" && s[i + 1] && !/\s/.test(s[i + 1])) {
			const end = closingDollar(s, i + 1);
			if (end > i + 1) { flush(); out += math(s.slice(i + 1, end), false); i = end; continue; }
		}
		if (strong && c === "*" && s[i + 1] === "*") {
			const end = s.indexOf("**", i + 2);
			if (end > i + 2 && !/\s/.test(s[i + 2]) && !/\s/.test(s[end - 1])) { flush(); out += `<strong>${inline(s.slice(i + 2, end), false)}</strong>`; i = end + 1; continue; }
		}
		text += c;
	}
	flush();
	return out;
}

/**
 * End index (inclusive) of the inline token starting at i, using the same rules as inline():
 * a closed code span, $$...$$, $...$ under the Pandoc rule, or [[...]]. -1 when none starts here.
 */
export function tokenEnd(s: string, i: number): number {
	const c = s[i];
	if (c === "`") { const end = s.indexOf("`", i + 1); return end > i + 1 ? end : -1; }
	if (c === "[" && s[i + 1] === "[") { const end = s.indexOf("]]", i + 2); return end > i + 2 ? end + 1 : -1; }
	if (c === "$" && s[i + 1] === "$") { const end = s.indexOf("$$", i + 2); return end > i + 2 ? end + 1 : -1; }
	if (c === "$" && s[i - 1] !== "\\" && s[i + 1] && !/\s/.test(s[i + 1])) { const end = closingDollar(s, i + 1); return end > i + 1 ? end : -1; }
	return -1;
}

// Split a table row on pipes outside inline tokens and \| escapes.
export function cells(line: string): string[] {
	let body = line.trim();
	if (body.startsWith("|")) body = body.slice(1);
	if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
	const out: string[] = [];
	let cell = "";
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === "\\" && body[i + 1] === "|") { cell += "\\|"; i++; continue; }
		const end = tokenEnd(body, i);
		if (end > i) { cell += body.slice(i, end + 1); i = end; continue; }
		if (c === "|") { out.push(cell.trim()); cell = ""; continue; }
		cell += c;
	}
	out.push(cell.trim());
	return out;
}

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const ITEM = /^\s{0,3}([-*]|\d{1,3}[.)])\s+(.*)$/;

function table(lines: string[]): string {
	const head = cells(lines[0]);
	const align = cells(lines[1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
	const td = (tag: string, c: string, i: number) => `<${tag}${tag === "th" ? ' scope="col"' : ""}${align[i] ? ` style="text-align:${align[i]}"` : ""}>${inline(c)}</${tag}>`;
	const rows = lines.slice(2).map((l) => {
		const row = cells(l);
		while (row.length < head.length) row.push("");
		// Extra cells are kept, not dropped; the write lint reports the mismatch.
		return `<tr>${row.map((c, i) => td("td", c, i)).join("")}</tr>`;
	});
	return `<div class="table-scroll prose-table" tabindex="0" role="region" aria-label="Table"><table><thead><tr>${head.map((c, i) => td("th", c, i)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

export type Block =
	| { kind: "para"; lines: string[] }
	| { kind: "code"; text: string }
	| { kind: "math"; tex: string }
	| { kind: "table"; lines: string[] }
	| { kind: "list"; ordered: boolean; start: number; items: string[] };

/** Split prose into blocks. The renderer and the readability lint both use this, so they agree. */
export function blocks(text: string): Block[] {
	const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
	const out: Block[] = [];
	let para: string[] = [];
	const endPara = () => { if (para.length) out.push({ kind: "para", lines: para.map((l) => l.trim()) }); para = []; };
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) { endPara(); continue; }
		const fence = /^\s*(```|~~~)/.exec(line);
		if (fence) {
			endPara();
			const body: string[] = [];
			for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
			out.push({ kind: "code", text: body.join("\n") });
			continue;
		}
		if (line.trim().startsWith("$$")) {
			const first = line.trim().slice(2);
			const body: string[] = [];
			if (first.endsWith("$$") && first.length > 2) body.push(first.slice(0, -2));
			else {
				if (first) body.push(first);
				for (i++; i < lines.length; i++) {
					const t = lines[i].trim();
					if (t.endsWith("$$")) { body.push(t.slice(0, -2)); break; }
					body.push(lines[i]);
				}
			}
			endPara();
			out.push({ kind: "math", tex: body.join("\n") });
			continue;
		}
		if (line.includes("|") && SEPARATOR.test(lines[i + 1] ?? "") && cells(line).length === cells(lines[i + 1]).length) {
			endPara();
			const block = [line, lines[++i]];
			while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) block.push(lines[++i]);
			out.push({ kind: "table", lines: block });
			continue;
		}
		const item = ITEM.exec(line);
		if (item && !para.length) {
			const ordered = /\d/.test(item[1]);
			const items: string[] = [];
			let current = item[2];
			for (i++; i < lines.length; i++) {
				const next = ITEM.exec(lines[i]);
				if (next && /\d/.test(next[1]) === ordered) { items.push(current); current = next[2]; }
				else if (lines[i].trim() && /^\s+/.test(lines[i])) current += ` ${lines[i].trim()}`;
				else break;
			}
			items.push(current);
			i--;
			out.push({ kind: "list", ordered, start: ordered ? Number.parseInt(item[1], 10) : 1, items });
			continue;
		}
		para.push(line);
	}
	endPara();
	return out;
}

/** Render authored prose to HTML blocks. Plain text without markup renders as escaped paragraphs. */
export function prose(text: string): string {
	return blocks(text).map((b) => {
		switch (b.kind) {
			case "para": return `<p>${b.lines.map((l) => inline(l)).join("\n")}</p>`;
			case "code": return `<pre><code>${esc(b.text)}</code></pre>`;
			case "math": return `<div class="math-display">${math(b.tex, true)}</div>`;
			case "table": return table(b.lines);
			case "list": return `<${b.ordered ? "ol" : "ul"}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ""}>${b.items.map((t) => `<li>${inline(t)}</li>`).join("")}</${b.ordered ? "ol" : "ul"}>`;
		}
	}).join("");
}

const HERE = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
let katexCssCache: string | undefined;

/** KaTeX's stylesheet with its WOFF2 fonts inlined, so math renders offline. Include only when math is present. */
export function katexCss(): string {
	if (katexCssCache) return katexCssCache;
	const cssPath = createRequire(join(HERE, "markup.ts")).resolve("katex/dist/katex.min.css");
	const fonts = join(dirname(cssPath), "fonts");
	katexCssCache = readFileSync(cssPath, "utf8").replace(/src:url\(fonts\/([A-Za-z0-9_-]+)\.woff2\) format\("woff2"\)[^;}]*/g, (_all, name: string) =>
		`src:url(data:font/woff2;base64,${readFileSync(join(fonts, `${name}.woff2`)).toString("base64")}) format("woff2")`);
	return katexCssCache;
}
