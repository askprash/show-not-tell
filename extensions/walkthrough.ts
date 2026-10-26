/**
 * walkthrough: an evidence-carrying HTML walkthrough of the latest feature.
 *
 * Two tools share one evidence log:
 *   walkthrough_record  runs a shell command and records the command and its real output.
 *   walkthrough_write   renders the page from the seven sections; every evidence item must
 *                       cite a record id, and any quoted output must appear in that record.
 * Once a walkthrough starts, the session's active tools are exactly these two. The model cannot
 * read, write or run anything except through walkthrough_record, so the log is a complete record
 * of what it did, and it has no path to the page or the log files.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OUT_DIR = ".walkthrough";
const FIG_DIR = `${OUT_DIR}/figs`;
const STREAM_KEEP = 8 * 1024;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 120;
const KILL_GRACE_MS = 2000;
const MAX_FIG_BYTES = 5 * 1024 * 1024;
export const ALLOWED_TOOLS = ["walkthrough_record", "walkthrough_write"];
const WRITE_KEYS = ["title", "scope", "claim", "map", "evidence", "checks_changed", "could_be_wrong", "not_verified", "depends_on", "figures"];

const HERE = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = resolve(HERE, "..", "skills", "walkthrough", "SKILL.md");

export const SECTIONS = ["Claim", "Map", "Evidence", "Checks changed", "Could it be wrong?", "Not verified", "What the result depends on"];

export interface FigureFile {
	path: string; // relative to the project, under .walkthrough/figs/
	sha256: string;
	bytes: number;
}

export interface EvidenceRecord {
	id: string;
	command: string;
	why: string;
	cwd: string;
	started_at: string;
	exit?: number | null;
	stdout?: string;
	stderr?: string;
	ms?: number;
	timed_out?: boolean;
	truncated?: { stdout?: number; stderr?: number };
	at_ref?: string;
	ref_sha?: string;
	overlay?: string[];
	mapped_paths?: boolean;
	produces?: string;
	figures?: FigureFile[];
	produces_missing?: string;
	snapshot?: "before" | "after";
	tree?: Record<string, string>; // path -> sha256 (or "missing") of every file git status lists
	refused?: "budget" | "report-only";
	refused_reason?: string;
}

// ---------- command classification ----------

const MUTATING = [
	/\bgit\s+(commit|push|reset|checkout|stash|switch|restore|rebase|merge|cherry-pick|revert|clean|add|rm|mv|am|tag|pull|fetch)\b/,
	/\bgit\s+branch\s+-[dDmM]/,
	/\brm\s+-[a-zA-Z]*[rRf]/,
];

export function mutationReason(command: string): string | undefined {
	for (const re of MUTATING) {
		const m = command.match(re);
		if (m) return `"${m[0]}" changes the repository or deletes files`;
	}
	return undefined;
}

const READ_ONLY_LOOK = /^\s*(cat|ls|head|tail|wc|grep|stat|file|jq)\b[^>|;&`$]*$/;

// Commands may write plots into .walkthrough/figs/; anything else under .walkthrough/ is the tools' own.
export function writesWalkthroughDir(command: string): boolean {
	if (command.includes(`${FIG_DIR}/..`)) return true;
	const rest = command.split(`${FIG_DIR}/`).join("").split(FIG_DIR).join("");
	return rest.includes(OUT_DIR) && !READ_ONLY_LOOK.test(command);
}

// ---------- small helpers ----------

function truncate(text: string): { text: string; cut: number } {
	const bytes = Buffer.byteLength(text);
	if (bytes <= STREAM_KEEP) return { text, cut: 0 };
	const buf = Buffer.from(text);
	const half = STREAM_KEEP / 2;
	const head = buf.subarray(0, half).toString();
	const tail = buf.subarray(buf.length - half).toString();
	const cut = bytes - 2 * half;
	return { text: `${head}\n[... ${cut} bytes cut by walkthrough_record ...]\n${tail}`, cut };
}

function ensureGitignore(dir: string) {
	const gi = join(dir, ".gitignore");
	if (!existsSync(gi)) writeFileSync(gi, "*\n");
}

function gitRun(cwd: string, args: string[]) {
	let r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
	// Sandboxes that deny ~/.gitconfig make every git call fail; these calls do not need it.
	if (r.status !== 0 && /\.gitconfig/.test(r.stderr ?? "")) {
		r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
	}
	return r;
}

function git(cwd: string, args: string[]): string | undefined {
	const r = gitRun(cwd, args);
	return r.status === 0 ? r.stdout.trim() : undefined;
}

function esc(s: unknown): string {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function slugify(title: string): string {
	const s = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return s || "walkthrough";
}

function normalize(s: string): string {
	return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

export function sectionIndex(name: string | undefined): number | undefined {
	if (name === undefined || name.trim() === "") return 3;
	const n = name.trim().toLowerCase().replace(/^\d+\.\s*/, "").replace(/\?$/, "");
	if (/^[1-7]$/.test(n)) return Number(n);
	const i = SECTIONS.findIndex((s) => s.toLowerCase().replace(/\?$/, "") === n);
	return i >= 0 ? i + 1 : undefined;
}

// ---------- running one command ----------

interface RunResult {
	exit: number | null;
	stdout: string;
	stderr: string;
	ms: number;
	timed_out: boolean;
}

function runShell(command: string, cwd: string, timeoutS: number, signal?: AbortSignal): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		const t0 = Date.now();
		// detached: the child leads its own process group, so a timeout can kill grandchildren too.
		// pipefail: `pytest | tail` must not report exit 0 when pytest failed.
		const child = spawn("bash", ["-o", "pipefail", "-c", command], {
			cwd,
			env: { ...process.env, WALKTHROUGH: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let done = false;
		const cap = 4 * 1024 * 1024; // keep memory bounded; truncation happens afterwards
		child.stdout.on("data", (d) => {
			if (stdout.length < cap) stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			if (stderr.length < cap) stderr += d.toString();
		});
		const killGroup = (sig: NodeJS.Signals) => {
			try {
				if (child.pid) process.kill(-child.pid, sig);
			} catch {
				/* already gone */
			}
		};
		const finish = (exit: number | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			clearTimeout(hardStop);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ exit: timedOut ? null : exit, stdout, stderr, ms: Date.now() - t0, timed_out: timedOut });
		};
		const stop = () => {
			killGroup("SIGTERM");
			setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS).unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeoutS * 1000);
		// If a grandchild keeps the pipes open after the kill, stop waiting anyway.
		const hardStop = setTimeout(() => finish(null), timeoutS * 1000 + KILL_GRACE_MS + 3000);
		const onAbort = () => {
			stderr += "\n[aborted by the user]";
			stop();
		};
		signal?.addEventListener("abort", onAbort);
		child.on("error", (err) => {
			stderr += `\n[spawn error: ${err.message}]`;
			finish(127);
		});
		child.on("close", (code) => finish(code));
	});
}

interface Worktree {
	dir: string;
	cwd: string;
	sha: string;
	top: string;
	cleanup: () => void;
}

// A command that names the project by absolute path would run in the main checkout, not the
// worktree, and a red run would silently test the new code. Map those paths into the worktree.
export function mapToWorktree(command: string, tops: string[], dir: string): string {
	const alts = [...new Set(tops)].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	if (!alts.length) return command;
	// One pass, so a path already pointed at the worktree is not matched again.
	return command.replace(new RegExp(`(${alts.join("|")})(?=/|\\b|$)`, "g"), dir);
}

function makeWorktree(cwd: string, ref: string, overlay: string[]): Worktree {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top) throw new Error("at_ref needs a git repository");
	const sha = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
	if (!sha) throw new Error(`at_ref: "${ref}" is not a commit in this repository`);
	// Inside .walkthrough/ rather than the system temp dir: sandboxes such as nono often make
	// $TMPDIR read-only, while the project folder is writable. .walkthrough/.gitignore hides it.
	mkdirSync(join(top, OUT_DIR), { recursive: true });
	ensureGitignore(join(top, OUT_DIR));
	const dir = mkdtempSync(join(top, OUT_DIR, "worktree-"));
	const cleanup = () => {
		gitRun(top, ["worktree", "remove", "--force", dir]);
		rmSync(dir, { recursive: true, force: true });
		gitRun(top, ["worktree", "prune"]);
	};
	const add = gitRun(top, ["worktree", "add", "--detach", "--quiet", dir, sha]);
	if (add.status !== 0) {
		cleanup();
		throw new Error(`at_ref: git worktree add failed: ${add.stderr.trim()}`);
	}
	// realpath: on macOS /var is a symlink to /private/var, and git reports the resolved path.
	const realCwd = realpathSync(cwd);
	const sub = relative(top, realCwd);
	// A bad overlay path must not leave the worktree behind.
	try {
		// Untracked environments do not come with a worktree; borrow the main checkout's.
		for (const env of [".venv", "venv", "node_modules"]) {
			const src = join(top, env);
			const dst = join(dir, env);
			if (existsSync(src) && !existsSync(dst)) symlinkSync(src, dst);
		}
		for (const p of overlay) {
			const fromAbs = resolve(realCwd, p);
			const rel = relative(top, fromAbs);
			if (rel.startsWith("..")) throw new Error(`overlay path ${p} is outside the repository`);
			if (!existsSync(fromAbs)) throw new Error(`overlay path ${p} does not exist in the working tree`);
			mkdirSync(dirname(join(dir, rel)), { recursive: true });
			cpSync(fromAbs, join(dir, rel), { recursive: true });
		}
	} catch (err) {
		cleanup();
		throw err;
	}
	return { dir, cwd: join(dir, sub), sha, top, cleanup };
}

// Copy a file the command was expected to write into .walkthrough/figs/<id>-<name>, with its hash.
function captureFigure(id: string, produces: string, runCwd: string, projectCwd: string, startedMs: number): { figure?: FigureFile; missing?: string } {
	const src = resolve(runCwd, produces);
	if (!existsSync(src)) return { missing: `${produces} was not written` };
	const ext = extname(src).toLowerCase();
	if (ext !== ".png" && ext !== ".svg") return { missing: `${produces} exists but is not a .png or .svg` };
	const st = statSync(src);
	if (st.mtimeMs < startedMs - 1000) return { missing: `${produces} exists but was last written before this command started` };
	if (st.size > MAX_FIG_BYTES) return { missing: `${produces} is ${st.size} bytes, over the ${MAX_FIG_BYTES}-byte limit` };
	const buf = readFileSync(src);
	const destDir = join(projectCwd, FIG_DIR);
	mkdirSync(destDir, { recursive: true });
	ensureGitignore(join(projectCwd, OUT_DIR));
	const dest = join(destDir, `${id}-${basename(src)}`);
	writeFileSync(dest, buf);
	return { figure: { path: relative(projectCwd, dest), sha256: sha256(buf), bytes: buf.length } };
}

// ---------- working-tree snapshots ----------

const SNAPSHOT_CMD = `git status --porcelain --untracked-files=all -- . ':(exclude)${OUT_DIR}'`;

// Lists every changed or untracked file with a content hash, so a file that was already dirty
// and is changed again during the walkthrough is still caught. Ignored files are not covered,
// apart from new top-level directories.
export function takeSnapshot(cwd: string): { ok: boolean; text: string; tree: Record<string, string>; ms: number } {
	const t0 = Date.now();
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top) return { ok: false, text: "not a git repository", tree: {}, ms: Date.now() - t0 };
	const r = gitRun(cwd, ["status", "--porcelain", "--untracked-files=all", "--", ".", `:(exclude)${OUT_DIR}`]);
	if (r.status !== 0) return { ok: false, text: r.stderr || "git status failed", tree: {}, ms: Date.now() - t0 };
	const tree: Record<string, string> = {};
	for (const line of r.stdout.split("\n")) {
		if (line.length < 4) continue;
		let path = line.slice(3);
		if (path.includes(" -> ")) path = path.split(" -> ")[1];
		path = path.replace(/^"|"$/g, "");
		const abs = join(top, path);
		try {
			tree[path] = existsSync(abs) && statSync(abs).isFile() ? sha256(readFileSync(abs)) : "missing";
		} catch {
			tree[path] = "unreadable";
		}
	}
	// git status does not list empty directories, so also note the top-level directories.
	for (const name of readdirSync(top)) {
		if (name === ".git" || name === OUT_DIR) continue;
		try {
			if (statSync(join(top, name)).isDirectory()) tree[`${name}/`] = "directory";
		} catch {
			/* vanished */
		}
	}
	return { ok: true, text: r.stdout, tree, ms: Date.now() - t0 };
}

export function treeChanges(before: Record<string, string>, after: Record<string, string>): string[] {
	const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...paths].filter((p) => before[p] !== after[p]).sort();
}

// ---------- the diffstat figure ----------

export interface StatRow {
	path: string;
	add: number;
	del: number;
	approx: boolean;
}

// Parses `git diff/show --stat` or `--numstat` output. Returns undefined when nothing parses.
export function parseDiffStat(text: string): StatRow[] | undefined {
	const num: StatRow[] = [];
	const stat: StatRow[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const n = line.match(/^(\d+)\t(\d+)\t(.+)$/);
		if (n) {
			num.push({ path: n[3], add: Number(n[1]), del: Number(n[2]), approx: false });
			continue;
		}
		if (/\|\s+Bin\b/.test(line)) continue;
		const s = line.match(/^\s*(\S.*?)\s+\|\s+(\d+)\s*([+-]*)\s*$/);
		if (!s) continue;
		const total = Number(s[2]);
		const plus = (s[3].match(/\+/g) ?? []).length;
		const minus = (s[3].match(/-/g) ?? []).length;
		if (plus + minus === total) stat.push({ path: s[1], add: plus, del: minus, approx: false });
		else if (plus + minus > 0) {
			const add = Math.round((total * plus) / (plus + minus));
			stat.push({ path: s[1], add, del: total - add, approx: true });
		} else stat.push({ path: s[1], add: 0, del: 0, approx: false });
	}
	const rows = num.length ? num : stat;
	return rows.length ? rows : undefined;
}

export function diffStatSvg(rows: StatRow[]): string {
	const shown = rows.length > 25 ? [...rows].sort((a, b) => b.add + b.del - (a.add + a.del)).slice(0, 25) : rows;
	const rowH = 20;
	const top = 6;
	const labelW = 330;
	const barW = 300;
	const width = 728;
	const height = top + shown.length * rowH + (rows.length > shown.length ? rowH : 0) + 4;
	const max = Math.max(1, ...shown.map((r) => r.add + r.del));
	const scale = barW / max;
	const short = (p: string) => (p.length > 46 ? `…${p.slice(p.length - 45)}` : p);
	const parts = shown.map((r, i) => {
		const y = top + i * rowH;
		const a = r.add * scale;
		const d = r.del * scale;
		const x0 = labelW;
		return (
			`<text x="0" y="${y + 13}" style="fill:var(--fg);font:11px ui-monospace,Menlo,monospace">${esc(short(r.path))}</text>` +
			(a > 0 ? `<rect x="${x0}" y="${y + 3}" width="${Math.max(1, a).toFixed(1)}" height="12" style="fill:var(--green)"/>` : "") +
			(d > 0 ? `<rect x="${(x0 + a).toFixed(1)}" y="${y + 3}" width="${Math.max(1, d).toFixed(1)}" height="12" style="fill:var(--red)"/>` : "") +
			`<text x="${(x0 + a + d + 6).toFixed(1)}" y="${y + 13}" style="fill:var(--mute);font:11px ui-monospace,Menlo,monospace">+${r.add} −${r.del}${r.approx ? "*" : ""}</text>`
		);
	});
	if (rows.length > shown.length) {
		parts.push(`<text x="0" y="${top + shown.length * rowH + 13}" style="fill:var(--mute);font:11px ui-monospace,Menlo,monospace">and ${rows.length - shown.length} more files</text>`);
	}
	return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Lines added and deleted per file">${parts.join("")}</svg>`;
}

// ---------- the page ----------

export interface FigureRef {
	record_id: string;
	caption: string;
	section?: string;
	file?: string;
}

export interface WritePayload {
	title: string;
	scope: string;
	claim: { text: string; confidence: string };
	map: { path: string; lines: string; note: string; record_id?: string }[];
	evidence: { claim: string; record_id: string; what_to_look_for: string; quote?: string }[];
	checks_changed: { what: string; how: string; record_id?: string }[];
	could_be_wrong: { alternative: string; test_that_would_show_it: string; record_id?: string }[];
	not_verified: string[];
	depends_on: { item: string; how_to_spot_check: string; record_id?: string }[];
	figures: FigureRef[];
}

interface PageMeta {
	repo: string;
	branch: string;
	sha: string;
	dirty: boolean | undefined;
	date: string;
	model?: string;
	cwd: string;
}

interface PageExtras {
	treeLine?: string;
	claimFigure?: string;
	sectionFigures: Map<number, string[]>;
	mapFigure?: string;
	citedIn: Map<string, Set<string>>;
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1b;--mute:#6b6a65;--rule:#d9d6cc;--code:#f1efe8;--ochre:#a8741a;--slate:#4a5a6a;--red:#9b1c1c;--green:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e6e4dc;--mute:#9a988f;--rule:#34363b;--code:#202227;--ochre:#d9a441;--slate:#9fb2c4;--red:#e07a7a;--green:#7fbf8a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 64px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px}
h2{font-size:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--slate);border-top:1px solid var(--rule);padding-top:18px;margin:30px 0 10px}
.meta{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mute)}
.meta b{color:var(--fg);font-weight:600}
.scope{margin:10px 0 0;color:var(--mute)}
.note{font-size:13px;color:var(--mute);margin-top:10px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
code{background:var(--code);padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}
pre{background:var(--code);padding:10px 12px;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin:6px 0}
ul,ol{padding-left:22px}
li{margin:6px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--rule);padding:6px 8px 6px 0}
th{font-weight:600;color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
figure{margin:16px 0}
figure img{display:block;max-width:100%;height:auto;background:#fff;border:1px solid var(--rule);border-radius:4px}
figcaption{font-size:14px;color:var(--mute);margin-top:6px}
.badge{display:inline-block;font:12px ui-monospace,Menlo,monospace;padding:1px 6px;border:1px solid currentColor;border-radius:3px;margin-right:6px}
.high{color:var(--green)}.medium{color:var(--ochre)}.low{color:var(--red)}
.rid{font:12px ui-monospace,Menlo,monospace;color:var(--ochre);text-decoration:none}
.ev{border-left:2px solid var(--rule);padding:2px 0 2px 12px;margin:14px 0}
.look{color:var(--mute);font-size:14px}
.bad{color:var(--red)}.ok{color:var(--green)}
details{border-top:1px solid var(--rule);padding:8px 0}
details:target{background:var(--code)}
summary{cursor:pointer;font:13px/1.5 ui-monospace,Menlo,monospace}
summary .why{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--mute)}
.cited{font:12px ui-monospace,Menlo,monospace;color:var(--slate)}
.uncited{font:12px ui-monospace,Menlo,monospace;color:var(--mute)}
.check{list-style:none;padding-left:0}
.check li{padding-left:26px;text-indent:-26px}
.check input{width:16px;height:16px;margin:0 8px 0 0;vertical-align:-2px}
`;

function lowerFirst(s: string): string {
	const t = s.trim();
	return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

function secs(ms = 0): string {
	return ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(1)} s`;
}

function rid(id?: string): string {
	return id ? ` <a class="rid" href="#${esc(id)}">[${esc(id)}]</a>` : "";
}

function recordStatus(r: EvidenceRecord): string {
	if (r.refused) return `<span class="bad">refused (${esc(r.refused)})</span>`;
	if (r.timed_out) return `<span class="bad">timed out after ${((r.ms ?? 0) / 1000).toFixed(1)} s</span>`;
	const cls = r.exit === 0 ? "ok" : "bad";
	return `<span class="${cls}">exit ${esc(r.exit)}</span> · ${secs(r.ms)}`;
}

export function renderPage(p: WritePayload, log: EvidenceRecord[], meta: PageMeta, autoNotVerified: string[], extras: PageExtras): string {
	const byId = new Map(log.map((r) => [r.id, r]));
	const ran = log.filter((r) => !r.refused && !r.snapshot);
	const totalS = ran.reduce((a, r) => a + (r.ms ?? 0), 0) / 1000;
	const conf = (p.claim.confidence.trim().match(/^(high|medium|low)\b/i)?.[1] ?? "").toLowerCase();
	const confRest = conf ? p.claim.confidence.trim().slice(conf.length).replace(/^[\s:,.-]+/, "") : p.claim.confidence;
	const dirty = meta.dirty === undefined ? "not a git repo" : meta.dirty ? "uncommitted changes" : "clean";

	const sec = (n: number, body: string) =>
		`<section id="s${n}"><h2>${n}. ${SECTIONS[n - 1]}</h2>\n${(extras.sectionFigures.get(n) ?? []).join("\n")}${body}\n</section>`;

	const mapRows = p.map.length
		? `<table><tr><th>File</th><th>Lines</th><th>What changed</th></tr>${p.map
				.map((m) => {
					const missing = existsSync(resolve(meta.cwd, m.path)) ? "" : ` <span class="bad">(not found in the working tree)</span>`;
					return `<tr><td><code>${esc(m.path)}</code>${missing}</td><td>${esc(m.lines)}</td><td>${esc(m.note)}${rid(m.record_id)}</td></tr>`;
				})
				.join("")}</table>`
		: `<p>No files listed.</p>`;

	const evidence = p.evidence.length
		? p.evidence
				.map((e) => {
					const r = byId.get(e.record_id)!;
					const quote = e.quote ? `<pre>${esc(e.quote)}</pre>` : "";
					return `<div class="ev"><p><b>${esc(e.claim)}</b>${rid(e.record_id)}</p><p><code>${esc(r.command)}</code> → ${recordStatus(r)}</p>${quote}<p class="look">Look for ${esc(lowerFirst(e.what_to_look_for))}</p></div>`;
				})
				.join("\n")
		: `<p class="bad">No recorded evidence. Nothing on this page was confirmed by running a command.</p>`;

	const checks =
		p.checks_changed.length === 0
			? `<p>None. No test, tolerance or check was added, changed, skipped or deleted in this scope.</p>`
			: `<ul>${p.checks_changed.map((c) => `<li><b>${esc(c.what)}</b><br>${esc(c.how)}${rid(c.record_id)}</li>`).join("")}</ul>`;

	const wrong = p.could_be_wrong.length
		? `<ul>${p.could_be_wrong
				.map(
					(w) =>
						`<li><b>${esc(w.alternative)}</b><br>The run that would show it is ${esc(lowerFirst(w.test_that_would_show_it))}${
							w.record_id ? ` Cited record${rid(w.record_id)}` : ` <i>(not run)</i>`
						}</li>`,
				)
				.join("")}</ul>`
		: `<p>No alternative explanations listed.</p>`;

	const nv = [...p.not_verified.map(esc), ...autoNotVerified];
	const notVerified = nv.length ? `<ul>${nv.map((x) => `<li>${x}</li>`).join("")}</ul>` : `<p>Nothing listed.</p>`;

	const dependsOn = p.depends_on.length
		? `<ol>${p.depends_on.map((h) => `<li><b>${esc(h.item)}</b>${rid(h.record_id)}<br>To check it, ${esc(lowerFirst(h.how_to_spot_check))}</li>`).join("")}</ol>`
		: `<p>Nothing listed.</p>`;

	const nCited = log.filter((r) => extras.citedIn.has(r.id)).length;
	const logHtml = log
		.map((r) => {
			const where = r.at_ref
				? ` · at ${esc(r.at_ref)} (${esc(r.ref_sha?.slice(0, 7))}) in a temporary worktree${
						r.overlay?.length ? `, with ${r.overlay.map((o) => `<code>${esc(o)}</code>`).join(", ")} copied from the working tree` : ""
					}${r.mapped_paths ? ". Absolute paths to the project in the command were pointed at the worktree" : ""}`
				: "";
			const cut = (n?: number) => (n ? ` <span class="bad">(${n} bytes cut from the middle)</span>` : "");
			const fig =
				(r.figures ?? []).map((f) => `<p class="meta">produced <code>${esc(f.path)}</code> · ${f.bytes} bytes · sha256 ${esc(f.sha256.slice(0, 16))}…</p>`).join("") +
				(r.produces_missing ? `<p class="meta bad">expected figure not captured, because ${esc(r.produces_missing)}</p>` : "");
			const body = r.refused
				? `<p class="bad">Not run: ${esc(r.refused_reason)}</p>`
				: `<p class="meta">cwd ${esc(r.cwd)}${where} · started ${esc(r.started_at)}</p>${fig}` +
					`<p class="meta">stdout${cut(r.truncated?.stdout)}</p><pre>${esc(r.stdout) || "(empty)"}</pre>` +
					`<p class="meta">stderr${cut(r.truncated?.stderr)}</p><pre>${esc(r.stderr) || "(empty)"}</pre>`;
			const cites = extras.citedIn.get(r.id);
			const citeTag = cites ? `<span class="cited">cited in: ${esc([...cites].join(", "))}</span>` : `<span class="uncited">not cited</span>`;
			return `<details id="${esc(r.id)}"><summary><b>${esc(r.id)}</b> <code>${esc(r.command)}</code> · ${recordStatus(r)} · ${citeTag}<br><span class="why">${esc(r.why)}</span></summary>${body}</details>`;
		})
		.join("\n");

	const firstRan = ran[0];
	const standing = [
		firstRan
			? `Re-run one recorded command, for example <code>${esc(firstRan.command)}</code> <a class="rid" href="#${esc(firstRan.id)}">[${esc(firstRan.id)}]</a>, and compare with its output in the log.`
			: `Re-run one recorded command and compare with its output in the log. (No command was recorded.)`,
		`Open one mapped file at the cited lines and check the note matches the code.`,
		`Run <code>git diff --stat</code> for the same scope and confirm that “Checks changed” lists every test or check file it touches.`,
	];
	const spot = [...p.depends_on.map((h) => `${esc(h.how_to_spot_check)} <span class="look">(${esc(h.item)})</span>`), ...standing];

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(p.title)}</h1>
<div class="meta"><b>${esc(meta.repo)}</b> · ${esc(meta.branch)} @ ${esc(meta.sha)} · ${dirty} · ${esc(meta.date)}${meta.model ? ` · model ${esc(meta.model)}` : ""} · ${ran.length} recorded command${ran.length === 1 ? "" : "s"}, ${totalS.toFixed(1)} s</div>
${extras.treeLine ? `<p class="meta">${extras.treeLine}</p>` : ""}
<p class="scope">Scope is ${esc(lowerFirst(p.scope))}</p>
<p class="note">The agent wrote the text. It could run commands only through the walkthrough_record tool, so the evidence log below lists everything it ran. Figures and quoted output were checked against the records that produced them.</p>
${sec(1, `<p>${conf ? `<span class="badge ${conf}">${conf}</span>` : ""}${esc(p.claim.text)}</p>${confRest ? `<p class="look">Confidence ${conf || "stated"} because ${esc(lowerFirst(confRest.replace(/^because\s+/i, "")))}</p>` : ""}${extras.claimFigure ?? ""}`)}
${sec(2, `${extras.mapFigure ?? ""}${mapRows}`)}
${sec(3, evidence)}
${sec(4, checks)}
${sec(5, wrong)}
${sec(6, notVerified)}
${sec(7, dependsOn)}
<section id="log"><h2>Evidence log</h2>
<p class="look">Every command the agent ran, in order. ${nCited} of ${log.length} are cited on this page.</p>
${logHtml || "<p>No commands were recorded.</p>"}
</section>
<section id="spot"><h2>Reader's spot-check list</h2>
<ul class="check">${spot.map((s) => `<li><label><input type="checkbox"> ${s}</label></li>`).join("")}</ul>
</section>
</main></body></html>
`;
}

// Models sometimes send nested arrays or objects as JSON strings; parse those before validation.
export function prepareWriteArgs(args: unknown): unknown {
	if (!args || typeof args !== "object") return args;
	const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
	// Some providers pass a nested field as a string that still carries the model's
	// `<parameter name="text">` wrapper; strip it so the page does not show it.
	const unwrap = (s: string) => s.replace(/^\s*<parameter name="[^"]*">/, "").replace(/<\/parameter>\s*$/, "").trim();
	if (typeof out.claim === "string" && !out.claim.trim().startsWith("{")) {
		out.claim = { text: unwrap(out.claim), confidence: typeof out.confidence === "string" ? unwrap(out.confidence) : "not stated" };
		delete out.confidence;
	}
	if (out.depends_on === undefined && out.hinge_points !== undefined) {
		out.depends_on = out.hinge_points;
		delete out.hinge_points;
	}
	for (const key of ["claim", "map", "evidence", "checks_changed", "could_be_wrong", "not_verified", "depends_on", "figures"]) {
		const v = out[key];
		if (typeof v !== "string") continue;
		if (key === "checks_changed" && v.trim().toLowerCase() === "none") {
			out[key] = [];
			continue;
		}
		try {
			out[key] = JSON.parse(v);
		} catch {
			/* leave it; validation reports the problem */
		}
	}
	for (const [key, v] of Object.entries(out)) {
		if (!Array.isArray(v) || key === "not_verified") continue;
		out[key] = v.map((el) => {
			if (typeof el !== "string" || !el.trim().startsWith("{")) return el;
			try {
				return JSON.parse(el);
			} catch {
				return el;
			}
		});
	}
	return out;
}

// ---------- the extension ----------

const Ref = (desc: string) => Type.Optional(Type.String({ description: desc }));

const RecordParams = Type.Object({
	command: Type.String({ description: "Shell command (bash). Runs in the project directory." }),
	why: Type.String({ description: "One line: what this command shows or which claim it checks." }),
	timeout_s: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_TIMEOUT_S, description: `Timeout in seconds, default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}.` })),
	at_ref: Type.Optional(
		Type.String({
			description:
				"Run the command in a temporary detached git worktree of this ref (e.g. HEAD~1), removed afterwards. Use for red/green: does the new test fail without the change?",
		}),
	),
	overlay: Type.Optional(
		Type.Array(Type.String(), {
			description: "With at_ref: paths copied from the current working tree into the worktree first (e.g. the new test file), so the new test runs against the old code.",
		}),
	),
	produces: Type.Optional(
		Type.String({
			description: `The .png or .svg file(s) this command writes, comma-separated (e.g. ${FIG_DIR}/cl-alpha.png, ${FIG_DIR}/cp.png). Each is copied into the log with its sha256 so walkthrough_write can embed it as a figure.`,
		}),
	),
});

const WriteFields = Type.Object({
	title: Type.String({ description: "Page title, e.g. 'Walkthrough: xfoil_polar Cp files (24d25af)'." }),
	scope: Type.String({ description: "What was walked through: commit sha and subject, or the named diff." }),
	claim: Type.Object({
		text: Type.String({ description: "What the feature does, in two sentences." }),
		confidence: Type.String({ description: "Start with high, medium or low, then a short reason." }),
	}),
	map: Type.Array(
		Type.Object({
			path: Type.String(),
			lines: Type.String({ description: "Line range(s) touched, e.g. '120-148'." }),
			note: Type.String({ description: "What changed there, one line." }),
			record_id: Ref("Record that showed these lines (git diff or sed -n)."),
		}),
	),
	evidence: Type.Array(
		Type.Object({
			claim: Type.String(),
			record_id: Type.String({ description: "Id of the walkthrough_record result that supports the claim." }),
			what_to_look_for: Type.String({ description: "The line or number in that output that supports the claim." }),
			quote: Type.Optional(Type.String({ description: "Optional: a few lines copied exactly from that record's output. Rejected if not found in the record." })),
		}),
	),
	// A plain array, not array | "none": some providers send a union-typed argument as a JSON string.
	checks_changed: Type.Array(
		Type.Object({
			what: Type.String({ description: "The test, tolerance or check." }),
			how: Type.String({ description: "added | changed | skipped | deleted, and how." }),
			record_id: Ref("Record that shows it."),
		}),
		{ description: "Every test, tolerance or check added, changed, skipped or deleted. An empty array means none." },
	),
	could_be_wrong: Type.Array(
		Type.Object({
			alternative: Type.String({ description: "Another explanation for the result." }),
			test_that_would_show_it: Type.String({ description: "The run that would show the claim wrong." }),
			record_id: Ref("Record id only if that record is this run."),
		}),
	),
	not_verified: Type.Array(Type.String(), { description: "What was not run or could not be checked. Refused and timed-out records are added automatically." }),
	depends_on: Type.Array(
		Type.Object({
			item: Type.String({ description: "One of the one or two items the conclusion depends on." }),
			how_to_spot_check: Type.String({ description: "What the reader should run or open to check it." }),
			record_id: Ref("Record id, if any."),
		}),
	),
	figures: Type.Array(
		Type.Object({
			record_id: Type.String({ description: "Record whose `produces` file is the figure." }),
			caption: Type.String({ description: "What the figure shows, with inputs and units. Standalone." }),
			section: Type.Optional(Type.String({ description: `One of ${SECTIONS.join(", ")}. Default Evidence. The first figure is shown under the Claim.` })),
			file: Type.Optional(Type.String({ description: "File name, when the record produced more than one figure." })),
		}),
		{ description: "Plots made by recorded commands (walkthrough_record with produces). Pass [] only when the feature produces no numbers to plot." },
	),
});

// Every section is optional per call; the tool renders once all of them have arrived.
const WriteParams = Type.Partial(WriteFields);

export default function walkthrough(pi: ExtensionAPI) {
	let log: EvidenceRecord[] = [];
	let firstStart = 0;
	let fileStarted = false;
	let restricted = false;
	// Sections arrive over one or more calls; large payloads are easier for models to send in parts.
	let draft: Record<string, unknown> = {};
	let nextNum = 1;

	const maxRecords = () => envInt("WALKTHROUGH_MAX_RECORDS", 20);
	const budgetMs = () => envInt("WALKTHROUGH_BUDGET_S", 300) * 1000;

	// Restricting at session start would also strip the tools from every ordinary session once the
	// package is installed, so the allowlist applies from the moment a walkthrough starts.
	const restrict = () => {
		if (restricted) return;
		restricted = true;
		pi.setActiveTools(ALLOWED_TOOLS);
	};

	const reset = () => {
		log = [];
		firstStart = 0;
		fileStarted = false;
		restricted = false;
		draft = {};
		nextNum = 1;
	};

	const writeLogFile = (cwd: string) => {
		const dir = join(cwd, OUT_DIR);
		mkdirSync(dir, { recursive: true });
		ensureGitignore(dir);
		writeFileSync(join(dir, "evidence.jsonl"), log.map((r) => `${JSON.stringify(r)}\n`).join(""));
		fileStarted = true;
	};

	const snapshotRecord = (cwd: string, id: string, which: "before" | "after"): EvidenceRecord => {
		const snap = takeSnapshot(cwd);
		return {
			id,
			command: SNAPSHOT_CMD,
			why: which === "before" ? "Working tree before the walkthrough (taken by the tool, not the agent)" : "Working tree when walkthrough_write was called (taken by the tool, not the agent)",
			cwd,
			started_at: new Date().toISOString(),
			exit: snap.ok ? 0 : 1,
			stdout: snap.ok ? snap.text || "(clean)" : "",
			stderr: snap.ok ? "" : snap.text,
			ms: snap.ms,
			snapshot: which,
			tree: snap.tree,
		};
	};

	const appendRecord = (cwd: string, rec: EvidenceRecord) => {
		log.push(rec);
		const dir = join(cwd, OUT_DIR);
		mkdirSync(dir, { recursive: true });
		ensureGitignore(dir);
		const file = join(dir, "evidence.jsonl");
		if (!fileStarted) {
			writeFileSync(file, "");
			fileStarted = true;
		}
		appendFileSync(file, `${JSON.stringify(rec)}\n`);
	};

	pi.on("session_start", () => reset());

	pi.on("input", (event) => {
		if (/^\/(skill:)?walkthrough\b/.test(event.text.trim())) restrict();
		return { action: "continue" };
	});

	pi.registerTool({
		name: "walkthrough_record",
		label: "Walkthrough record",
		description:
			"Run one shell command for the walkthrough and record the command and its real output in the evidence log. " +
			"During a walkthrough this is the only way to run anything, including reading files (git show, sed -n, grep). " +
			`Budget: ${maxRecords()} commands, 60 s each by default, 5 minutes in total; calls past the budget are refused and listed under Not verified. ` +
			`Set produces to the .png/.svg file(s) the command writes under ${FIG_DIR}/ to use them as figures.`,
		promptSnippet: "walkthrough_record: run a command and record its output as walkthrough evidence",
		parameters: RecordParams,
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			restrict();
			const cwd = ctx.cwd;
			if (!log.some((r) => r.snapshot === "before")) appendRecord(cwd, snapshotRecord(cwd, "r0", "before"));
			const id = `r${nextNum++}`;
			const startedMs = Date.now();
			const started_at = new Date(startedMs).toISOString();
			const base = { id, command: params.command, why: params.why, cwd, started_at, ...(params.produces ? { produces: params.produces } : {}) };
			const refuse = (kind: "budget" | "report-only", reason: string) => {
				appendRecord(cwd, { ...base, refused: kind, refused_reason: reason });
				return { content: [{ type: "text" as const, text: `${id}: not run. ${reason}` }], details: { id, refused: kind } };
			};

			const m = mutationReason(params.command);
			if (m) return refuse("report-only", `walkthrough is report-only and ${m}.`);
			if (writesWalkthroughDir(params.command)) return refuse("report-only", `commands may write only under ${FIG_DIR}/; the rest of ${OUT_DIR}/ belongs to the walkthrough tools.`);

			const ran = log.filter((r) => !r.refused && !r.snapshot).length;
			if (ran >= maxRecords()) return refuse("budget", `record cap of ${maxRecords()} commands reached.`);
			const elapsed = firstStart ? Date.now() - firstStart : 0;
			const remainingS = Math.floor((budgetMs() - elapsed) / 1000);
			if (remainingS < 2) return refuse("budget", `total time budget of ${budgetMs() / 1000} s used up.`);
			if (!firstStart) firstStart = Date.now();

			let timeoutS = Math.min(params.timeout_s ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S);
			let clampNote = "";
			if (timeoutS > remainingS) {
				timeoutS = remainingS;
				clampNote = ` (timeout cut to ${remainingS} s, the time left in the budget)`;
			}

			let wt: Worktree | undefined;
			let runCwd = cwd;
			if (params.at_ref) {
				try {
					wt = makeWorktree(cwd, params.at_ref, params.overlay ?? []);
					runCwd = wt.cwd;
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const rec: EvidenceRecord = { ...base, at_ref: params.at_ref, overlay: params.overlay, exit: null, stdout: "", stderr: msg, ms: 0 };
					appendRecord(cwd, rec);
					return { content: [{ type: "text" as const, text: `${id}: could not set up at_ref: ${msg}` }], details: rec };
				}
			}
			let res: RunResult;
			const figs: FigureFile[] = [];
			const missingFigs: string[] = [];
			let mapped = false;
			try {
				let toRun = params.command;
				if (wt) {
					toRun = mapToWorktree(params.command, [wt.top, realpathSync(wt.top), cwd, realpathSync(cwd)].filter((t) => t.length > 1), wt.dir);
					mapped = toRun !== params.command;
				}
				res = await runShell(toRun, runCwd, timeoutS, signal);
				for (const one of (params.produces ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
					const c = captureFigure(id, one, runCwd, cwd, startedMs);
					if (c.figure) figs.push(c.figure);
					if (c.missing) missingFigs.push(c.missing);
				}
			} finally {
				wt?.cleanup();
			}
			const out = truncate(res.stdout);
			const err = truncate(res.stderr);
			const rec: EvidenceRecord = {
				...base,
				exit: res.exit,
				stdout: out.text,
				stderr: err.text,
				ms: res.ms,
				...(res.timed_out ? { timed_out: true } : {}),
				...(out.cut || err.cut ? { truncated: { ...(out.cut ? { stdout: out.cut } : {}), ...(err.cut ? { stderr: err.cut } : {}) } } : {}),
				...(wt ? { at_ref: params.at_ref, ref_sha: wt.sha, overlay: params.overlay } : {}),
				...(mapped ? { mapped_paths: true } : {}),
				...(figs.length ? { figures: figs } : {}),
				...(missingFigs.length ? { produces_missing: missingFigs.join("; ") } : {}),
			};
			appendRecord(cwd, rec);
			const left = maxRecords() - (ran + 1);
			const timeLeft = Math.max(0, Math.floor((budgetMs() - (Date.now() - firstStart)) / 1000));
			const status = res.timed_out ? `timed out after ${timeoutS} s` : `exit ${res.exit}`;
			const figLine =
				figs.map((f) => `figure: ${f.path} (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 16)}…); cite it in walkthrough_write figures as record_id ${id}, file ${basename(f.path)}\n`).join("") +
				missingFigs.map((m) => `figure not captured, because ${m}\n`).join("");
			const text =
				`${id} · ${status} · ${(res.ms / 1000).toFixed(1)} s${clampNote}${wt ? ` · at ${params.at_ref} (${wt.sha.slice(0, 7)})` : ""}\n` +
				figLine +
				`budget left: ${left} records, ${timeLeft} s\n` +
				`--- stdout ---\n${out.text || "(empty)"}\n--- stderr ---\n${err.text || "(empty)"}`;
			return { content: [{ type: "text" as const, text }], details: rec };
		},
	});

	pi.registerTool({
		name: "walkthrough_write",
		label: "Walkthrough write",
		description:
			"Render the walkthrough page from the seven sections to .walkthrough/<slug>.html and return its path. " +
			"Send all sections in one call, or split them over several calls; sections are kept until every one has arrived. " +
			"Every record_id must name a walkthrough_record result; an evidence quote must appear verbatim in that record's output; " +
			"a figure must name a record that produced a .png/.svg. Refused and timed-out records are added to Not verified automatically.",
		promptSnippet: "walkthrough_write: render the walkthrough page from recorded evidence",
		parameters: WriteParams,
		prepareArguments: (args) => prepareWriteArgs(args) as never,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			restrict();
			const cwd = ctx.cwd;
			for (const [k, v] of Object.entries(params as Record<string, unknown>)) if (v !== undefined) draft[k] = v;
			const missing = WRITE_KEYS.filter((k) => !(k in draft));
			if (missing.length) {
				return {
					content: [{ type: "text" as const, text: `Saved ${Object.keys(draft).join(", ")}. Still needed before the page can be written: ${missing.join(", ")}. Send them in the next walkthrough_write call.` }],
					details: { saved: Object.keys(draft), missing },
				};
			}
			const p = structuredClone(draft) as unknown as WritePayload;
			// Second snapshot. A repeated write replaces the previous one instead of adding another.
			let treeLine: string | undefined;
			const before = log.find((r) => r.snapshot === "before");
			if (before) {
				let afterId = `r${nextNum}`;
				if (log.at(-1)?.snapshot === "after") afterId = log.pop()!.id;
				else nextNum++;
				const after = snapshotRecord(cwd, afterId, "after");
				log.push(after);
				writeLogFile(cwd);
				const links = `${rid(before.id)}${rid(after.id)}`;
				if (before.exit !== 0 || after.exit !== 0) treeLine = `Changes to the working tree were not checked (git status failed).${links}`;
				else {
					const changed = treeChanges(before.tree ?? {}, after.tree ?? {});
					treeLine = changed.length
						? `<span class="bad">Files changed during the walkthrough</span> ${changed.map((c) => `<code>${esc(c)}</code>`).join(", ")}.${links} Files git ignores are not checked, except for new top-level directories.`
						: `Working tree unchanged during the walkthrough.${links} Files git ignores are not checked, except for new top-level directories.`;
				}
			}
			const ran = log.filter((r) => !r.refused);
			const valid = new Set(ran.map((r) => r.id));
			const validList = ran.map((r) => r.id).join(", ") || "(none recorded)";
			const withFigs = ran.filter((r) => r.figures?.length).map((r) => `${r.id} (${r.figures!.map((f) => basename(f.path)).join(", ")})`);
			const problems: string[] = [];
			const dropped: string[] = [];
			const citedIn = new Map<string, Set<string>>();
			const cite = (section: string, id?: string) => {
				if (!id || !valid.has(id)) return;
				if (!citedIn.has(id)) citedIn.set(id, new Set());
				citedIn.get(id)!.add(section);
			};
			const check = (where: string, section: string, id?: string) => {
				if (id === undefined || id === "") return;
				if (!valid.has(id)) problems.push(`${where}: unknown record_id "${id}"`);
				cite(section, id);
			};
			p.map.forEach((m, i) => check(`map[${i}]`, "Map", m.record_id));
			p.evidence.forEach((e, i) => {
				if (!e.record_id) problems.push(`evidence[${i}]: record_id is required`);
				check(`evidence[${i}]`, "Evidence", e.record_id);
				const r = ran.find((x) => x.id === e.record_id);
				// A quote that is not in the record is dropped, so the page never shows unrecorded text.
				if (r && e.quote && !normalize(`${r.stdout}\n${r.stderr}`).includes(normalize(e.quote))) {
					dropped.push(`evidence[${i}] (${e.record_id})`);
					delete e.quote;
				}
			});
			p.checks_changed.forEach((c, i) => check(`checks_changed[${i}]`, "Checks changed", c.record_id));
			p.could_be_wrong.forEach((w, i) => check(`could_be_wrong[${i}]`, "Could it be wrong?", w.record_id));
			p.depends_on.forEach((h, i) => check(`depends_on[${i}]`, "What the result depends on", h.record_id));

			const sectionFigures = new Map<number, string[]>();
			let claimFigure: string | undefined;
			(p.figures ?? []).forEach((f, i) => {
				const r = ran.find((x) => x.id === f.record_id);
				const sIdx = sectionIndex(f.section);
				if (!r) return problems.push(`figures[${i}]: unknown record_id "${f.record_id}"`);
				const chosen = f.file ? r.figures?.find((x) => basename(x.path) === f.file || basename(x.path) === `${r.id}-${f.file}`) : r.figures?.[0];
				if (!chosen) {
					return problems.push(
						`figures[${i}]: ${f.record_id} did not produce ${f.file ? `a figure named ${f.file}` : "a figure"}${r.produces_missing ? ` (${r.produces_missing})` : ""}; records with figures: ${withFigs.join(", ") || "none"}`,
					);
				}
				if (sIdx === undefined) return problems.push(`figures[${i}]: unknown section "${f.section}"; use one of ${SECTIONS.join(", ")}`);
				const abs = join(cwd, chosen.path);
				const buf = existsSync(abs) ? readFileSync(abs) : undefined;
				if (!buf || sha256(buf) !== chosen.sha256) return problems.push(`figures[${i}]: the copy of ${f.record_id}'s figure changed after it was recorded`);
				const mime = chosen.path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
				const html = `<figure><img src="data:${mime};base64,${buf.toString("base64")}" alt="${esc(f.caption)}"><figcaption>${esc(f.caption)} Produced by${rid(r.id)} <code>${esc(r.command.length > 90 ? `${r.command.slice(0, 90)}…` : r.command)}</code></figcaption></figure>`;
				const placed = claimFigure === undefined ? 1 : sIdx;
				if (placed === 1 && claimFigure === undefined) claimFigure = html;
				else sectionFigures.set(placed, [...(sectionFigures.get(placed) ?? []), html]);
				cite(placed === 1 ? "Claim (figure)" : `${SECTIONS[placed - 1]} (figure)`, r.id);
			});
			if (problems.length) {
				throw new Error(`walkthrough_write rejected:\n- ${problems.join("\n- ")}\nValid record ids: ${validList}. The other sections are saved; resend only the sections named here.`);
			}

			// The Map figure is drawn from the first recorded diffstat; no model input is involved.
			let mapFigure: string | undefined;
			for (const r of ran) {
				if (!/--(num)?stat\b/.test(r.command) || r.exit !== 0) continue;
				try {
					const rows = parseDiffStat(r.stdout ?? "");
					if (!rows) continue;
					const approx = rows.some((x) => x.approx);
					mapFigure = `<figure>${diffStatSvg(rows)}<figcaption>Lines added (green) and deleted (red) per file, drawn by the walkthrough tool from the diffstat in${rid(r.id)}.${
						approx ? " * Split in proportion to git's scaled +/- graph." : ""
					}</figcaption></figure>`;
					cite("Map (figure)", r.id);
					break;
				} catch {
					/* omit the figure */
				}
			}

			const auto: string[] = [];
			for (const r of log) {
				const link = `<a class="rid" href="#${esc(r.id)}">[${esc(r.id)}]</a>`;
				if (r.refused === "budget") auto.push(`Not run because the budget ran out. <code>${esc(r.command)}</code> was meant to check ${esc(lowerFirst(r.why))} ${link}`);
				else if (r.refused) auto.push(`Refused as a change to the repository. <code>${esc(r.command)}</code> ${link}`);
				else if (r.timed_out) auto.push(`Timed out after ${((r.ms ?? 0) / 1000).toFixed(0)} s. <code>${esc(r.command)}</code> was meant to check ${esc(lowerFirst(r.why))} ${link}`);
				if (r.produces_missing) auto.push(`Expected figure not captured, because ${esc(r.produces_missing)} ${link}`);
			}

			const top = git(cwd, ["rev-parse", "--show-toplevel"]);
			const porcelain = top ? git(cwd, ["status", "--porcelain", "--", ".", `:(exclude)${OUT_DIR}`]) : undefined;
			const meta: PageMeta = {
				repo: basename(top ?? cwd),
				branch: (top && git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || "-",
				sha: (top && git(cwd, ["rev-parse", "--short", "HEAD"])) || "-",
				dirty: top ? (porcelain ?? "") !== "" : undefined,
				date: new Date().toISOString().slice(0, 16).replace("T", " "),
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				cwd,
			};
			for (const r of log) if (r.snapshot) cite("Header", r.id);
			const html = renderPage(p, log, meta, auto, { treeLine, claimFigure, sectionFigures, mapFigure, citedIn });
			const dir = join(cwd, OUT_DIR);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${slugify(p.title)}.html`);
			writeFileSync(file, html);
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${file} (${citedIn.size} of ${log.length} records cited${mapFigure ? "; Map figure drawn" : ""}).${
							dropped.length ? ` Dropped quotes not found in their records: ${dropped.join(", ")}.` : ""
						}`,
					},
				],
				details: { path: file },
			};
		},
	});

	pi.registerCommand("walkthrough", {
		description: "Write an evidence-carrying walkthrough of the latest feature: /walkthrough <scope>",
		handler: async (args, ctx) => {
			const scope = args.trim() || "the last commit";
			restrict();
			let body = "";
			try {
				body = readFileSync(SKILL_FILE, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
			} catch {
				/* fall back to naming the skill */
			}
			const text = body
				? `<skill name="walkthrough" location="${SKILL_FILE}">\n${body}\n</skill>\n\nWrite a walkthrough of: ${scope}`
				: `Use the walkthrough skill to write a walkthrough of: ${scope}`;
			pi.sendUserMessage(text);
			// Print and JSON modes exit when the command returns; keep it alive until the turn ends.
			if (!ctx.hasUI) {
				for (let i = 0; i < 100 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 50));
				await ctx.waitForIdle();
			}
		},
	});
}
