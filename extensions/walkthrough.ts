/**
	* walkthrough: an evidence-carrying HTML walkthrough of the latest feature.
	*
	* Two tools share one evidence log:
	*   walkthrough_record  runs a shell command and records the command and its real output.
	*   walkthrough_write   renders the reader-facing article; every evidence item must
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
import { Type, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderPage } from "./report.ts";
import { bareIdentifiers, density, referenceIds, shortField } from "./prose-lint.ts";
import type { EvidenceRecord, FigureFile, ResolvedReference, WritePayload, PageMeta, PageExtras, ScopeRequest, ResolvedScope, WalkthroughMode } from "./report-types.ts";
export type * from "./report-types.ts";

const OUT_DIR = ".walkthrough";
const FIG_DIR = `${OUT_DIR}/figs`;
const STREAM_KEEP = 8 * 1024;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 120;
const KILL_GRACE_MS = 2000;
const MAX_FIG_BYTES = 5 * 1024 * 1024;
const MAX_FIGS_PER_RECORD = 4;
export const ALLOWED_TOOLS = ["walkthrough_record", "walkthrough_write"];
const LIMITS_ENTRY = "walkthrough-limits";
const WRITE_KEYS = ["title", "mode", "scope", "summary", "sections"];
const OPTIONAL_ARRAYS = ["checks", "limits", "changes", "visuals", "references"];

const HERE = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = resolve(HERE, "..", "skills", "walkthrough", "SKILL.md");
export const FIGKIT_DIR = resolve(HERE, "..", "figkit");

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

function slugify(title: string): string {
	const s = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60)
		.replace(/-+$/, "");
	return s || "walkthrough";
}

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

function sha256(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
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
			env: { ...process.env, WALKTHROUGH: "1", WALKTHROUGH_FIGKIT: FIGKIT_DIR },
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
	const sha = resolveCommit(cwd, ref);
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

function hashed(projectCwd: string, path: string): FigureFile {
	const buf = readFileSync(path);
	return { path: relative(projectCwd, path), sha256: sha256(buf), bytes: buf.length };
}

/** Remaining milliseconds of the walkthrough budget; figure processing never runs past it. */
type Deadline = () => number;

// Bounded by the remaining budget; dest is an absolute path the tool created, never agent text.
function bounded(cmd: string, args: string[], deadline: Deadline, cap: number, extra: object = {}) {
	const ms = Math.min(cap, deadline());
	if (ms < 1000) return { status: null, stdout: "", stderr: "", error: new Error("walkthrough time budget used up") } as ReturnType<typeof spawnSync>;
	return spawnSync(cmd, args, { encoding: "utf8", timeout: ms, killSignal: "SIGKILL", ...extra });
}

// A figkit SVG is linted with the bundled checker, and its text is converted to outlines so the
// page shows the measured layout even where its fonts are not installed. Both run on the copy.
function prepareSvg(dest: string, projectCwd: string, figure: FigureFile, deadline: Deadline): FigureFile {
	const text = readFileSync(dest, "utf8");
	if (!/<svg\b[^>]*\bdata-svgfig=/.test(text)) return figure;
	const lint = bounded(join(FIGKIT_DIR, "lint.sh"), [dest], deadline, 60_000);
	const lines = `${lint.stdout ?? ""}`.split("\n").filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());
	figure.lint = lint.status === 0 || lines.length ? lines : [`lint could not run: ${(`${lint.stderr ?? ""}` || lint.error?.message || "unknown error").trim().split("\n").at(-1)}`];
	const outlined = dest.replace(/\.svg$/i, ".outlined.svg");
	const conv = bounded("rsvg-convert", ["-f", "svg", "-o", outlined, "--", dest], deadline, 30_000);
	if (conv.status === 0 && existsSync(outlined)) figure.outlined = hashed(projectCwd, outlined);
	else figure.outline_failed = (`${conv.stderr ?? ""}` || conv.error?.message || "rsvg-convert failed").trim().split("\n").at(-1);
	return figure;
}

// A PNG the agent can look at in the tool result: the figure itself, or a raster of an SVG.
function previewPng(projectCwd: string, figure: FigureFile, deadline: Deadline): Buffer | undefined {
	const abs = join(projectCwd, figure.path);
	if (abs.toLowerCase().endsWith(".png")) return statSync(abs).size <= MAX_FIG_BYTES ? readFileSync(abs) : undefined;
	const r = bounded("rsvg-convert", ["-z", "1.25", "--", abs], deadline, 30_000, { encoding: "buffer", maxBuffer: MAX_FIG_BYTES });
	return r.status === 0 && r.stdout?.length ? (r.stdout as Buffer) : undefined;
}

// Copy a file the command was expected to write into .walkthrough/figs/<id>-<name>, with its hash.
function captureFigure(id: string, produces: string, runCwd: string, projectCwd: string, startedMs: number, deadline: Deadline): { figure?: FigureFile; missing?: string } {
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
	const figure: FigureFile = { path: relative(projectCwd, dest), sha256: sha256(buf), bytes: buf.length };
	return { figure: ext === ".svg" ? prepareSvg(dest, projectCwd, figure, deadline) : figure };
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

// Parse only structural JSON inputs, never prose (including quotes and recorded text).
export function prepareWriteArgs(args: unknown): unknown {
	const decode = (value: unknown): unknown => {
		if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
			try { return decode(JSON.parse(value)); } catch { return value; }
		}
		if (Array.isArray(value)) return value.map(decode);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
			[k, ["text", "title", "summary", "quote", "caption", "alt", "label", "note", "path", "head", "base", "file", "target", "lines", "id", "record_id", "section_id", "mode", "kind", "status", "commit", "identifier"].includes(k) ? v : decode(v)]));
		return value;
	};
	return decode(args);
}

const RESERVED_IDS = new Set(["overview", "checks", "limits", "changes", "references", "scope", "log", "technical"]);
const ID = /^[a-z][a-z0-9-]*$/;

// Remote URLs come only from the local origin configuration; no network lookup is needed.
export function repositoryUrl(remote: string | undefined): string | undefined {
	if (!remote || /[\s\\]/.test(remote)) return undefined;
	// URL parsing normalizes dot segments; reject those before normalization can hide them.
	const rawPath = remote.replace(/^[a-z]+:\/\/[^/]+/i, "").split(/[?#]/)[0];
	if (rawPath.split("/").some((p) => p === "." || p === ".." || p.includes("%"))) return undefined;
	let url: URL;
	try {
		const scp = remote.match(/^(?:[^@/:]+@)?(github\.com|gitlab\.com):(.+)$/);
		url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : remote);
	} catch { return undefined; }
	if (!["https:", "http:", "ssh:"].includes(url.protocol) || url.port || !["github.com", "gitlab.com"].includes(url.hostname)) return undefined;
	const path = url.pathname.replace(/\.git$/, "");
	const parts = path.split("/").slice(1);
	if (parts.length < 2 || (url.hostname === "github.com" && parts.length !== 2) ||
		parts.some((p) => !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(p) || p === "." || p === ".." || p === "-")) return undefined;
	return `https://${url.hostname}${path}`;
}

function resolveCommit(cwd: string, ref: string): string | undefined {
	if (!ref || ref.startsWith("-")) return undefined;
	return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

export function resolveScope(cwd: string, request: ScopeRequest): { scope: ResolvedScope; remote?: string } {
	const scope: ResolvedScope = { label: request.label, include_working_tree: request.include_working_tree ?? false, commits: [] };
	const warnings: string[] = [];
	if (!git(cwd, ["rev-parse", "--show-toplevel"])) {
		scope.warning = "Scope could not be resolved: not a Git repository. Committed content is unavailable.";
		return { scope };
	}
	const remote = repositoryUrl(git(cwd, ["config", "--get", "remote.origin.url"]));
	const commitPath = remote?.includes("gitlab.com/") ? "/-/commit/" : "/commit/";
	scope.head_sha = resolveCommit(cwd, request.head);
	if (!scope.head_sha) warnings.push("Scope head could not be resolved to a local commit.");
	if (request.base !== undefined) {
		scope.base_sha = resolveCommit(cwd, request.base);
		if (!scope.base_sha) warnings.push("Scope base could not be resolved to a local commit; comparison is unavailable.");
	}
	if (scope.head_sha && remote) scope.head_url = `${remote}${commitPath}${scope.head_sha}`;
	if (scope.head_sha && scope.base_sha && remote) scope.compare_url = `${remote}${remote.includes("gitlab.com/") ? "/-/compare/" : "/compare/"}${scope.base_sha}...${scope.head_sha}`;
	const shas = scope.head_sha ? (scope.base_sha ? git(cwd, ["rev-list", "--reverse", `${scope.base_sha}..${scope.head_sha}`])?.split("\n").filter(Boolean) ?? [] : [scope.head_sha]) : [];
	for (const sha of shas) scope.commits.push({ sha, subject: git(cwd, ["show", "-s", "--format=%s", sha]) || "Commit", ...(remote ? { url: `${remote}${commitPath}${sha}` } : {}) });
	if (scope.include_working_tree) warnings.push("Working-tree content is included explicitly; commit and file links refer only to committed content at the resolved head.");
	else warnings.push("Scope covers committed content only; uncommitted working-tree content is not included.");
	scope.warning = warnings.join(" ");
	return { scope, remote };
}

function repositoryPath(path: string): boolean {
	return !!path && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !/[\\*?\[\]{},\n\r\0]/.test(path) &&
		path.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

// ---------- budget limits ----------

export interface Limits { records?: number; time_s?: number }
export const LIMIT_RANGE = { records: [1, 200], time_s: [30, 7200] } as const;
export const DEFAULT_LIMITS = { records: 20, time_s: 300 } as const;

/** "15m", "15 min", "900s", "900", "1h", "1h30m", "1.5 hours" -> seconds. */
export function parseDuration(text: string): number | undefined {
	const t = text.trim().toLowerCase().replace(/\s+/g, "");
	if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t));
	// Longest unit names first, so "minutes" is not read as "m" followed by junk.
	const re = /(\d+(?:\.\d+)?)(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)/g;
	let total = 0, used = "", m: RegExpExecArray | null;
	while ((m = re.exec(t))) {
		const unit = m[2][0];
		total += Number(m[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
		used += m[0];
	}
	return used && used === t ? Math.round(total) : undefined;
}

export function formatDuration(s: number): string {
	if (s % 3600 === 0) return `${s / 3600} h`;
	if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
	return `${s} s`;
}

/** Problems with requested limits; an empty list means they are in range. */
export function checkLimits(l: Limits): string[] {
	const out: string[] = [];
	const [r0, r1] = LIMIT_RANGE.records, [t0, t1] = LIMIT_RANGE.time_s;
	if (l.records !== undefined && (!Number.isInteger(l.records) || l.records < r0 || l.records > r1)) out.push(`records must be a whole number from ${r0} to ${r1}`);
	if (l.time_s !== undefined && (!Number.isFinite(l.time_s) || l.time_s < t0 || l.time_s > t1)) out.push(`time must be from ${formatDuration(t0)} to ${formatDuration(t1 )}`);
	return out;
}

// Budget phrases only: a lead word, a number and a unit. Bare mentions such as "the 5 minute
// timeout change" or "the last 3 commits" have no lead word and stay in the scope.
const NL_LEAD = String.raw`(?:use|using|take|taking|spend|spending|allow|allowing|with|budget(?:\s+of)?|limit(?:\s+of)?|up\s+to|at\s+most|max(?:imum)?(?:\s+of)?|in|within|for)`;
const NL_RECORDS = new RegExp(String.raw`(^|[\s,;(])(?:and\s+)?${NL_LEAD}\s+(?:an?\s+|up\s+to\s+|at\s+most\s+)*(\d+)[\s-]*(?:commands?|records?|steps?|calls?)\b(?:\s+(?:budget|limit|max(?:imum)?))?`, "gi");
const NL_TIME = new RegExp(String.raw`(^|[\s,;(])(?:and\s+)?${NL_LEAD}\s+(?:an?\s+|up\s+to\s+|at\s+most\s+)*((?:\d+(?:\.\d+)?[\s-]*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?=\d|\b)\s*)+)(?:(?:time\s+)?(?:budget|limit|max(?:imum)?)\b)?`, "gi");

/**
 * Pull limits out of /walkthrough arguments: flags (--records=40, --time=15m) and plain phrases
 * ("use up to 40 commands", "in 15 minutes", "with a 10 minute budget"). Returns the rest as scope.
 */
export function extractLimits(args: string): { limits: Limits; rest: string; errors: string[]; matched: string[] } {
	const limits: Limits = {};
	const errors: string[] = [];
	const matched: string[] = [];
	let rest = args.replace(/(^|\s)--(records|time)(?:=(\S+)|\s+(\S+))(?=\s|$)/g, (all, space, key, eq, sep) => {
		const value = eq ?? sep;
		if (key === "records") { if (/^\d+$/.test(value)) limits.records = Number(value); else errors.push(`--records needs a whole number, not "${value}"`); }
		else { const d = parseDuration(value); if (d !== undefined) limits.time_s = d; else errors.push(`--time needs a duration such as 15m or 900s, not "${value}"`); }
		matched.push(all.trim());
		return space;
	});
	if (/(^|\s)--(records|time)(?:=|\s|$)/.test(rest)) errors.push("--records and --time need a value");
	rest = rest.replace(NL_RECORDS, (all, lead, n) => {
		if (limits.records !== undefined) return all;
		limits.records = Number(n); matched.push(all.trim()); return lead;
	});
	rest = rest.replace(NL_TIME, (all, lead, amount) => {
		const d = parseDuration(amount.replace(/-/g, ""));
		if (limits.time_s !== undefined || d === undefined) return all;
		limits.time_s = d; matched.push(all.trim()); return lead;
	});
	rest = rest.replace(/\s+([,;])/g, "$1").replace(/[,;]\s*(?=[,;]|$)/g, "").replace(/[,;]?\s*\band\s*$/i, "").replace(/\s{2,}/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "");
	errors.push(...checkLimits(limits));
	return { limits, rest, errors, matched };
}

export function parseCommandArgs(args: string): { mode: WalkthroughMode; scope: string } | undefined {
	let mode: WalkthroughMode = "verification";
	let invalid = false;
	// Consume mode tokens without re-tokenizing the reader's scope or removing punctuation.
	const scope = args.replace(/(^|\s)--mode(?:=([^\s]+)|\s+([^\s]+))(?=\s|$)/g, (_all, space, equals, separate) => {
		const value = equals ?? separate;
		if (value !== "verification" && value !== "explanation") invalid = true;
		else mode = value;
		return space;
	}).trim();
	if (invalid || /(^|\s)--mode(?:=|\s|$)/.test(scope)) return undefined;
	return { mode, scope: scope || "the last commit" };
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

const Evidence = Type.Object({ record_id: Type.String(), summary: Type.String(), quote: Ref("Verbatim output excerpt.") });
const WriteFields = Type.Object({
	title: Type.String(),
	mode: StringEnum(["verification", "explanation"]),
	scope: Type.Object({ label: Type.String(), head: Type.String(), base: Ref("Optional local comparison ref; omitted means a single commit."), include_working_tree: Type.Optional(Type.Boolean()), record_id: Ref("Recorded scope evidence.") }),
	summary: Type.String(),
	sections: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), text: Type.String(), evidence: Type.Optional(Type.Array(Evidence)) })),
	checks: Type.Array(Type.Object({ label: Type.String(), status: StringEnum(["passed", "failed", "blocked", "not-run", "inspected"]), summary: Type.String(), record_ids: Type.Optional(Type.Array(Type.String())) })),
	limits: Type.Array(Type.Object({ text: Type.String(), record_id: Ref("Record explaining this limit.") })),
	changes: Type.Array(Type.Object({ path: Type.String(), note: Type.String(), lines: Ref("Committed line or range, e.g. 10-20."), record_id: Ref("Record showing this change.") })),
	references: Type.Array(Type.Object({
		id: Type.String({ description: "Lowercase hyphenated id; cite it in prose as [[id]] or [[id|other words]]." }),
		label: Type.String({ description: "What the reader sees: the decision or change in words, e.g. \"the decision to choose the nozzle regime inside Newton\". Not a number." }),
		path: Ref("Repository-relative file, e.g. docs/adr/0028-nozzle-regime-inside-newton.md."),
		commit: Ref("Commit ref for a change, resolved to its hash."),
		identifier: Ref("Short identifier kept in technical details, e.g. ADR-0028."),
		record_id: Ref("Record in which you read this source."),
	}), { description: "Documents, decision records and commits cited in prose. Never write their numbers or hashes in prose." }),
	visuals: Type.Array(Type.Object({ record_id: Type.String(), file: Ref("Captured image name."), kind: StringEnum(["plot", "diagram"]), caption: Type.String(), alt: Ref("Accessible image description."), section_id: Ref("Section id; default overview."), links: Type.Optional(Type.Array(Type.Object({ label: Type.String(), target: Type.String(), x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number() }))) })),
});

// Runtime checks are also used with direct/fake execute calls that bypass Pi's validation.
function validateShape(value: unknown, schema: any, path = "payload"): void {
	if (schema.anyOf) {
		if (!schema.anyOf.some((s: any) => { try { validateShape(value, s, path); return true; } catch { return false; } })) throw new Error(`${path}: invalid value`);
		return;
	}
	if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid value`);
	if (schema.const !== undefined && value !== schema.const) throw new Error(`${path}: invalid value`);
	if (schema.type === "object") {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected object`);
		for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${path}.${key}: required`);
		for (const [key, v] of Object.entries(value)) {
			if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path}.${key}: unknown field`);
			validateShape(v, schema.properties[key], `${path}.${key}`);
		}
	} else if (schema.type === "array") {
		if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
		value.forEach((v, i) => validateShape(v, schema.items, `${path}[${i}]`));
	} else if (schema.type === "integer") {
		if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${path}: expected integer`);
	} else if (schema.type && (typeof value !== schema.type || (schema.type === "number" && !Number.isFinite(value)))) throw new Error(`${path}: expected ${schema.type}`);
	if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) throw new Error(`${path}: out of range`);
}

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

	// Limits for the current walkthrough, fixed when it starts: per-run options, then the session
	// default, then environment variables, then built-in defaults. The walkthrough cannot change them.
	let sessionLimits: Limits = {};
	let runLimits: Limits = {};
	let limitSource = "";
	const resolved = () => ({
		records: runLimits.records ?? sessionLimits.records ?? envInt("WALKTHROUGH_MAX_RECORDS", DEFAULT_LIMITS.records),
		time_s: runLimits.time_s ?? sessionLimits.time_s ?? envInt("WALKTHROUGH_BUDGET_S", DEFAULT_LIMITS.time_s),
	});
	const sourceOf = (key: keyof Limits) => runLimits[key] !== undefined ? "this run" : sessionLimits[key] !== undefined ? "session default" : process.env[key === "records" ? "WALKTHROUGH_MAX_RECORDS" : "WALKTHROUGH_BUDGET_S"] ? "environment" : "built-in default";
	const describeLimits = () => { const r = resolved(); return `${r.records} commands (${sourceOf("records")}), ${formatDuration(r.time_s)} total (${sourceOf("time_s")})`; };
	// The session budget, as the next walkthrough without per-run options would use it.
	const describeSession = () => { const run = runLimits; runLimits = {}; try { return describeLimits(); } finally { runLimits = run; } };
	const maxRecords = () => resolved().records;
	const budgetMs = () => resolved().time_s * 1000;

	// Restricting at session start would also strip the tools from every ordinary session once the
	// package is installed, so the allowlist applies from the moment a walkthrough starts.
	let savedTools: string[] | undefined;
	const restrict = () => {
		if (restricted) return;
		restricted = true;
		try { savedTools = pi.getActiveTools?.(); } catch { savedTools = undefined; }
		pi.setActiveTools(ALLOWED_TOOLS);
	};
	// Give the session back the tools it had before the walkthrough. Called once the page is
	// written and the agent has settled, or when a new session or walkthrough begins.
	let finished = false;
	const unrestrict = () => {
		if (!restricted) return;
		restricted = false;
		finished = false;
		if (savedTools?.length) pi.setActiveTools(savedTools);
		savedTools = undefined;
	};

	const reset = () => {
		unrestrict();
		log = [];
		firstStart = 0;
		fileStarted = false;
		restricted = false;
		draft = {};
		nextNum = 1;
		runLimits = {};
		limitSource = "";
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

	// The session default is stored in the session file, so it survives resume and reload.
	pi.on("session_start", (_event, ctx) => {
		reset();
		savedTools = undefined;
		sessionLimits = {};
		try {
			for (const e of ctx?.sessionManager?.getEntries?.() ?? []) {
				if (e.type === "custom" && (e as { customType?: string }).customType === LIMITS_ENTRY) sessionLimits = { ...((e as { data?: Limits }).data ?? {}) };
			}
		} catch { /* a session without entries keeps the defaults */ }
	});

	// After the page is written and the agent has stopped, return the session's tools. An aborted
	// walkthrough keeps its restriction, since the user may continue it; /walkthrough or a new
	// session restores them.
	pi.on("agent_settled", () => { if (finished) unrestrict(); });

	const saveSessionLimits = (next: Limits) => {
		sessionLimits = next;
		pi.appendEntry(LIMITS_ENTRY, next);
	};

	// The prompt that starts a walkthrough, shared by /walkthrough and walkthrough_start.
	const startWalkthrough = (scope: string, mode: WalkthroughMode, limits: Limits): string => {
		reset();
		runLimits = limits;
		limitSource = describeLimits();
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
		const r = resolved();
		return `${text}\n\nMode: ${mode}. ${mode === "verification" ? "Report observed checks; exit zero alone is not a scientific or test pass." : "Explain code and reasoning from recorded source inspection; inspection is not runtime verification. Tests and visuals are optional."} Budget for this walkthrough: ${r.records} commands and ${formatDuration(r.time_s)} in total, ${MAX_TIMEOUT_S} s at most per command. Reserve part of it for diagrams before you start: about 2 commands and 1 minute for each relevant diagram. Diagrams are a priority; cut a lower-value command before a diagram. Both modes are report-only and use only walkthrough_record and walkthrough_write. Use the current structured report contract: title, mode, scope {label, head, base?, include_working_tree?}, summary, sections [{id, title, text, evidence?: [{record_id, summary, quote?}]}], with optional checks, limits, changes and visuals arrays. Do not use the obsolete seven-section payload.`;
	};


	pi.registerTool({
		name: "walkthrough_record",
		label: "Walkthrough record",
		description:
			"Run one shell command for the walkthrough and record the command and its real output in the evidence log. " +
			"During a walkthrough this is the only way to run anything, including reading files (git show, sed -n, grep). " +
			"The walkthrough prompt states its budget of commands and total time; each command defaults to 60 s. Calls past the budget are refused and listed under limits. " +
			`Set produces to the .png/.svg file(s) the command writes under ${FIG_DIR}/ to use them as figures; the result includes a PNG preview. ` +
			"Commands see $WALKTHROUGH_FIGKIT, the bundled diagram library: run a figure script with \"$WALKTHROUGH_FIGKIT/run.sh\" script.py.",
		promptSnippet: "walkthrough_record: run a command and record its output as walkthrough evidence",
		parameters: RecordParams,
		executionMode: "sequential",
		async execute(_id, params, signal, _onUpdate, ctx) {
			validateShape(params, RecordParams, "record");
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
				const deadline: Deadline = () => budgetMs() - (Date.now() - firstStart);
				const wanted = (params.produces ?? "").split(",").map((x) => x.trim()).filter(Boolean);
				for (const extra of wanted.slice(MAX_FIGS_PER_RECORD)) missingFigs.push(`${extra} skipped: at most ${MAX_FIGS_PER_RECORD} figures per record`);
				for (const one of wanted.slice(0, MAX_FIGS_PER_RECORD)) {
					const c = captureFigure(id, one, runCwd, cwd, startedMs, deadline);
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
			const status = res.timed_out ? `timed out after ${timeoutS} s` : `exit ${res.exit}`;
			const figLine =
				figs.map((f) => `figure: ${f.path} (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 16)}…); cite it in walkthrough_write visuals as record_id ${id}, file ${basename(f.path)}\n` +
					(f.lint ? (f.lint.length ? `figkit lint: ${f.lint.length} findings. Fix them and record the figure again; a diagram with findings is rejected.\n${f.lint.map((l) => `  ${l}`).join("\n")}\n` : "figkit lint: 0 findings\n") : "") +
					(f.outline_failed ? `text outlining failed (${f.outline_failed}); this diagram cannot be embedded until it succeeds\n` : "") +
					"Look at the preview below for crossing arrows, poor alignment and unused space; the lint cannot see layout.\n").join("") +
				missingFigs.map((m) => `figure not captured, because ${m}\n`).join("");
			const text =
				`${id} · ${status} · ${(res.ms / 1000).toFixed(1)} s${clampNote}${wt ? ` · at ${params.at_ref} (${wt.sha.slice(0, 7)})` : ""}\n` +
				figLine +
				"budget left: BUDGET\n" +
				`--- stdout ---\n${out.text || "(empty)"}\n--- stderr ---\n${err.text || "(empty)"}`;
			const previews = figs.flatMap((f) => {
				try {
					const png = previewPng(cwd, f, () => budgetMs() - (Date.now() - firstStart));
					return png ? [{ type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] : [];
				} catch { return []; }
			});
			const timeLeft = Math.max(0, Math.floor((budgetMs() - (Date.now() - firstStart)) / 1000));
			const anyFigure = log.some((r) => r.figures?.length);
			const nudge = !anyFigure && (left <= 4 || timeLeft <= 90) ? "\nNo diagram has been drawn yet. If a diagram would help the reader, draw it now with the remaining budget: diagrams take priority over further checks.\n" : "";
			return { content: [{ type: "text" as const, text: text.replace("budget left: BUDGET", `budget left: ${left} records, ${timeLeft} s${nudge}`) }, ...previews], details: rec };
		},
	});

	pi.registerTool({
		name: "walkthrough_write",
		label: "Walkthrough write",
		description:
			"Render a source-linked article from title, mode, structured scope, summary and sections. Fields accumulate across calls. " +
			"Checks, limits, changes and visuals default to empty arrays. Evidence quotes must occur verbatim in cited output. " +
			"Visuals must cite captured images. " +
			"Prose fields accept pipe tables, lists, `code`, **bold**, KaTeX math ($...$ inline, $$...$$ display) and [[reference-id]] links. " +
			"Readability is checked: no bare ticket, ADR or commit numbers in prose (declare them in references with a label that states the decision), " +
			"paragraphs of at most 60 words, list items of at most 40, and short captions and summaries. " +
			"Material failures and refusals remain visible as limits.",
		promptSnippet: "walkthrough_write: render the walkthrough page from recorded evidence",
		parameters: WriteParams,
		prepareArguments: (args) => prepareWriteArgs(args) as never,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const prepared = prepareWriteArgs(params);
			validateShape(prepared, WriteParams);
			restrict();
			const cwd = ctx.cwd;
			for (const [k, v] of Object.entries(prepared as Record<string, unknown>)) if (v !== undefined) draft[k] = v;
			const missing = WRITE_KEYS.filter((k) => !(k in draft));
			if (missing.length) return { content: [{ type: "text" as const, text: `Saved ${Object.keys(draft).join(", ")}. Still needed before the page can be written: ${missing.join(", ")}. Send them in the next walkthrough_write call.` }], details: { saved: Object.keys(draft), missing } };
			const data = structuredClone(draft);
			for (const key of OPTIONAL_ARRAYS) if (data[key] === undefined) data[key] = [];
			validateShape(data, WriteFields);
			const p = data as unknown as WritePayload;
			const problems: string[] = [];
			const dropped: string[] = [];
			const allRecords = new Map(log.map((r) => [r.id, r]));
			const valid = new Map(log.filter((r) => !r.refused).map((r) => [r.id, r]));
			const ids = new Set<string>();
			for (const section of p.sections) {
				if (!ID.test(section.id) || RESERVED_IDS.has(section.id) || section.id.startsWith("ref-") || log.some((r) => r.id === section.id) || /^r[0-9]+$/.test(section.id) || ids.has(section.id)) problems.push(`sections: invalid or colliding id "${section.id}"`);
				ids.add(section.id);
			}
			const sectionIds = new Set(["overview", ...ids]);
			const check = (where: string, id: string | undefined, records = valid) => {
				if (id !== undefined && (!ID.test(id) || !records.has(id))) problems.push(`${where}: unknown record_id "${id}"`);
			};
			check("scope", p.scope.record_id);
			p.sections.forEach((section, i) => section.evidence?.forEach((e, j) => {
				const where = `sections[${i}].evidence[${j}]`;
				check(where, e.record_id);
				const r = valid.get(e.record_id);
				if (r && e.quote !== undefined && !(r.stdout ?? "").includes(e.quote) && !(r.stderr ?? "").includes(e.quote)) {
					dropped.push(`${where} (${e.record_id})`);
					delete e.quote;
				}
			}));
			p.checks.forEach((c, i) => {
				if (c.status !== "not-run" && !c.record_ids?.length) problems.push(`checks[${i}]: ${c.status} requires at least one record`);
				c.record_ids?.forEach((id) => check(`checks[${i}]`, id));
			});
			p.limits.forEach((l, i) => check(`limits[${i}]`, l.record_id, allRecords));
			p.changes.forEach((c, i) => {
				check(`changes[${i}]`, c.record_id);
				if (!repositoryPath(c.path)) problems.push(`changes[${i}]: expected one repository-relative path, not an absolute, traversal or grouped/glob path`);
				if (c.lines !== undefined && !/^[1-9][0-9]*(?:-[1-9][0-9]*)?$/.test(c.lines)) problems.push(`changes[${i}]: lines must be a line or range`);
				if (c.lines?.includes("-") && Number(c.lines.split("-")[0]) > Number(c.lines.split("-")[1])) problems.push(`changes[${i}]: reversed line range`);
			});
			const visuals: PageExtras["visuals"] = [];
			p.visuals.forEach((v, i) => {
				check(`visuals[${i}]`, v.record_id);
				v.section_id ??= "overview";
				if (!sectionIds.has(v.section_id)) problems.push(`visuals[${i}]: unknown section_id "${v.section_id}"`);
				for (const link of v.links ?? []) {
					const section = link.target.startsWith("section:") && sectionIds.has(link.target.slice(8));
					const record = link.target.startsWith("record:") && allRecords.has(link.target.slice(7));
					if (!section && !record) problems.push(`visuals[${i}]: unknown link target "${link.target}"`);
					if (![link.x, link.y, link.width, link.height].every(Number.isFinite) || link.x < 0 || link.y < 0 || link.width <= 0 || link.height <= 0 || link.x + link.width > 100 || link.y + link.height > 100) problems.push(`visuals[${i}]: link geometry must be finite, positive and within image bounds`);
				}
				const r = valid.get(v.record_id);
				if (!r) return;
				const chosen = v.file ? r.figures?.find((f) => f.path === v.file || basename(f.path) === v.file || basename(f.path) === `${r.id}-${v.file}`) : r.figures?.[0];
				if (!chosen) { problems.push(`visuals[${i}]: ${v.record_id} did not produce ${v.file ? `a figure named ${v.file}` : "a figure"}`); return; }
				const abs = join(cwd, chosen.path);
				let buf: Buffer | undefined;
				try {
					if (statSync(abs).size <= MAX_FIG_BYTES) buf = readFileSync(abs);
				} catch { /* unavailable images fail integrity validation below */ }
				if (!buf || buf.length !== chosen.bytes || sha256(buf) !== chosen.sha256) { problems.push(`visuals[${i}]: the copy of ${v.record_id}'s figure changed after it was recorded or is unavailable`); return; }
				if (v.kind === "diagram" && chosen.lint?.length) { problems.push(`visuals[${i}]: ${basename(chosen.path)} has ${chosen.lint.length} figkit lint findings; fix the figure and record it again`); return; }
				if (chosen.lint && !chosen.outlined) { problems.push(`visuals[${i}]: ${basename(chosen.path)} could not be converted to outlines${chosen.outline_failed ? ` (${chosen.outline_failed})` : ""}; record it again`); return; }
				// figkit diagrams embed only the outlined copy, after the same integrity check as the original.
				if (chosen.outlined) {
					let out: Buffer | undefined;
					try { out = readFileSync(join(cwd, chosen.outlined.path)); } catch { /* reported below */ }
					if (!out || out.length !== chosen.outlined.bytes || sha256(out) !== chosen.outlined.sha256) { problems.push(`visuals[${i}]: the outlined copy of ${v.record_id}'s figure changed after it was recorded or is unavailable`); return; }
					buf = out;
				}
				visuals.push({ ...v, src: `data:${chosen.path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${buf.toString("base64")}` });
			});
			// References: declared once, cited by [[id]], resolved to files and commits at the scope head.
			const refIds = new Set<string>();
			p.references.forEach((r, i) => {
				if (!ID.test(r.id) || refIds.has(r.id)) problems.push(`references[${i}]: invalid or duplicate id "${r.id}"`);
				refIds.add(r.id);
				check(`references[${i}]`, r.record_id);
				if (r.path !== undefined && !repositoryPath(r.path)) problems.push(`references[${i}]: path must be one repository-relative file`);
				if (!r.path && !r.commit) problems.push(`references[${i}]: give a path or a commit`);
				if (/\[\[|\]\]/.test(r.label)) problems.push(`references[${i}]: label "${r.label}" cannot contain [[ or ]]; write the decision in words`);
				if (bareIdentifiers(r.label).length || /^\W*[A-Z]{2,}[-\s]?\d+\W*$/.test(r.label.trim())) problems.push(`references[${i}]: label "${r.label}" must state the decision or change in words, not its number`);
			});
			const style: string[] = [];
			const prosed: [string, string, "block" | "short" | "title"][] = [
				["scope.label", p.scope.label, "title"],
				["title", p.title, "title"],
				["summary", p.summary, "block"],
				...p.sections.flatMap((s, i) => [[`sections[${i}] "${s.id}" title`, s.title, "title"], [`sections[${i}] "${s.id}" text`, s.text, "block"],
					...(s.evidence ?? []).map((e, j) => [`sections[${i}].evidence[${j}].summary`, e.summary, "short"])] as [string, string, "block" | "short" | "title"][]),
				...p.checks.flatMap((c, i) => [[`checks[${i}].label`, c.label, "title"], [`checks[${i}].summary`, c.summary, "short"]] as [string, string, "block" | "short" | "title"][]),
				...p.limits.map((l, i) => [`limits[${i}]`, l.text, "short"] as [string, string, "block" | "short" | "title"]),
				...p.changes.map((c, i) => [`changes[${i}].note`, c.note, "short"] as [string, string, "block" | "short" | "title"]),
				...p.visuals.flatMap((v, i) => [[`visuals[${i}].caption`, v.caption, "short"], ...(v.alt ? [[`visuals[${i}].alt`, v.alt, "title"]] : [])] as [string, string, "block" | "short" | "title"][]),
			];
			for (const [where, text, kind] of prosed) {
				for (const id of referenceIds(text)) if (!refIds.has(id)) problems.push(`${where}: [[${id}]] is not a declared reference`);
				const ids = bareIdentifiers(text);
				if (ids.length) style.push(`${where}: bare identifier${ids.length > 1 ? "s" : ""} ${ids.map((x) => `"${x}"`).join(", ")}. A reader does not know what these mean. Declare each source in references with a label that states the decision or change, and cite it as [[id]]`);
				if (kind === "block") style.push(...density(text).map((d) => `${where}: ${d}`));
				if (kind === "short") style.push(...shortField(text).map((d) => `${where}: ${d}`));
				if (kind === "title" && (text.match(/\S+/g) ?? []).length > 14) style.push(`${where}: a title or label over 14 words; shorten it`);
			}
			if (style.length) problems.push(...style.map((x) => `readability: ${x}`));
			if (problems.length) throw new Error(`walkthrough_write rejected:\n- ${problems.join("\n- ")}\nValid record ids: ${[...valid.keys()].join(", ") || "(none recorded)"}.`);

			// A repeated write replaces the after snapshot rather than accumulating synthetic records.
			let tree: PageExtras["tree"];
			const before = log.find((r) => r.snapshot === "before");
			if (before) {
				const afterId = log.at(-1)?.snapshot === "after" ? log.pop()!.id : `r${nextNum++}`;
				const after = snapshotRecord(cwd, afterId, "after");
				log.push(after);
				writeLogFile(cwd);
				tree = { checked: before.exit === 0 && after.exit === 0, changed: treeChanges(before.tree ?? {}, after.tree ?? {}), before_id: before.id, after_id: after.id };
			}
			const { scope, remote } = resolveScope(cwd, p.scope);
			const fileUrls: Record<string, string> = Object.create(null);
			const autoLimits: PageExtras["autoLimits"] = [];
			for (const c of p.changes) {
				if (!scope.head_sha) continue;
				const exists = gitRun(cwd, ["cat-file", "-t", `${scope.head_sha}:${c.path}`]);
				if (exists.status !== 0 || exists.stdout.trim() !== "blob") {
					autoLimits.push({ text: `Changed path ${c.path} is unavailable as a committed file at the resolved head.`, record_id: c.record_id });
					continue;
				}
				if (remote) fileUrls[c.path] = `${remote}${remote.includes("gitlab.com/") ? "/-/blob/" : "/blob/"}${scope.head_sha}/${c.path.split("/").map(encodeURIComponent).join("/")}${c.lines ? `#L${c.lines.replace("-", remote.includes("gitlab.com/") ? "-" : "-L")}` : ""}`;
			}
			const references: ResolvedReference[] = p.references.map((r) => {
				const out: ResolvedReference = { ...r };
				const blob = remote?.includes("gitlab.com/") ? "/-/blob/" : "/blob/";
				if (r.commit) {
					const sha = resolveCommit(cwd, r.commit);
					if (!sha) out.missing = `Commit ${r.commit} could not be resolved.`;
					else { out.sha = sha; if (remote) out.url = `${remote}${remote.includes("gitlab.com/") ? "/-/commit/" : "/commit/"}${sha}`; }
				} else if (r.path && scope.head_sha) {
					const exists = gitRun(cwd, ["cat-file", "-t", `${scope.head_sha}:${r.path}`]);
					if (exists.status !== 0 || exists.stdout.trim() !== "blob") out.missing = `${r.path} is not a committed file at the scope head.`;
					else { out.sha = scope.head_sha; if (remote) out.url = `${remote}${blob}${scope.head_sha}/${r.path.split("/").map(encodeURIComponent).join("/")}`; }
				}
				return out;
			});
			for (const r of references) if (r.missing) autoLimits.push({ text: `Reference "${r.label}": ${r.missing}`, record_id: r.record_id });
			const covered = new Set([...p.limits.map((l) => l.record_id), ...p.checks.filter((c) => ["failed", "blocked", "not-run"].includes(c.status)).flatMap((c) => c.record_ids ?? [])]);
			for (const r of log) {
				if (covered.has(r.id)) continue;
				const reasons: string[] = [];
				if (r.refused) reasons.push(r.refused === "budget" ? "Not run: recording budget exhausted." : "Not run: report-only mutation refused.");
				else if (r.timed_out) reasons.push("Command timed out.");
				else if (!r.snapshot && r.exit !== 0) reasons.push(r.exit == null ? "Command could not run." : `Command exited with status ${r.exit}.`);
				if (r.produces_missing) reasons.push(`Expected image unavailable: ${r.produces_missing}.`);
				const unoutlined = (r.figures ?? []).filter((f) => f.outline_failed);
				if (unoutlined.length) reasons.push(`Diagram could not be converted to outlines and was not embedded: ${unoutlined.map((f) => `${basename(f.path)} (${f.outline_failed})`).join("; ")}.`);
				if (reasons.length) autoLimits.push({ text: `${r.why}: ${reasons.join(" ")}`, record_id: r.id });
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
				limits: limitSource || describeLimits(),
				cwd,
			};
			const html = renderPage(p, log, meta, { scope, visuals, autoLimits, tree, fileUrls, references });
			const dir = join(cwd, OUT_DIR);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${slugify(p.title)}.html`);
			writeFileSync(file, html);
			finished = true;
			return {
				content: [
					{
						type: "text" as const,
						text: `Wrote ${file}.${dropped.length ? ` Dropped quotes not found in their records: ${dropped.join(", ")}.` : ""}`,
					},
				],
				details: { path: file },
			};
		},
	});

	pi.registerCommand("walkthrough-limits", {
		description: "Show or set this session's walkthrough budget: /walkthrough-limits [records=40] [time=15m] | reset",
		handler: async (args, ctx) => {
			const a = args.trim();
			if (a === "reset") {
				saveSessionLimits({});
				ctx.ui?.notify(`Session walkthrough budget reset: ${describeSession()}.`, "info");
				return;
			}
			if (a) {
				const next: Limits = { ...sessionLimits };
				const errors: string[] = [];
				for (const part of a.split(/[\s,]+/).filter(Boolean)) {
					const m = /^(records|commands|time)=(.+)$/.exec(part);
					if (!m) { errors.push(`"${part}" is not records=N or time=DURATION`); continue; }
					if (m[1] === "time") { const d = parseDuration(m[2]); if (d === undefined) errors.push(`"${m[2]}" is not a duration`); else next.time_s = d; }
					else if (/^\d+$/.test(m[2])) next.records = Number(m[2]);
					else errors.push(`"${m[2]}" is not a whole number`);
				}
				errors.push(...checkLimits(next));
				if (errors.length) { ctx.ui?.notify(`Not changed: ${errors.join("; ")}.`, "error"); return; }
				saveSessionLimits(next);
			}
			ctx.ui?.notify(`Walkthrough budget for this session: ${describeSession()}.`, "info");
		},
	});

	// Natural-language entry points for the ordinary session agent. Both are inactive during a
	// walkthrough (the active set is then exactly ALLOWED_TOOLS), so a walkthrough cannot raise its own budget.
	const LimitFields = {
		records: Type.Optional(Type.Integer({ minimum: LIMIT_RANGE.records[0], maximum: LIMIT_RANGE.records[1], description: "Maximum recorded commands, only if the user stated one." })),
		time_s: Type.Optional(Type.Integer({ minimum: LIMIT_RANGE.time_s[0], maximum: LIMIT_RANGE.time_s[1], description: "Total time budget in seconds, only if the user stated one (15 minutes = 900)." })),
	};
	const StartParams = Type.Object({
		scope: Type.String({ description: "What to walk through, in the user's words: a commit, range, or code question." }),
		mode: Type.Optional(StringEnum(["verification", "explanation"], { description: "verification runs checks (default); explanation teaches the code." })),
		...LimitFields,
		save_for_session: Type.Optional(Type.Boolean({ description: "True when the user asked for these limits for the rest of the session." })),
	});
	pi.registerTool({
		name: "walkthrough_start",
		label: "Start walkthrough",
		description: "Start a walkthrough when the user asks for one in plain language, for example \"walk me through the last commit, take 15 minutes and up to 40 commands\". " +
			"Pass the scope in the user's words and only the limits the user stated; do not invent limits. The result contains the walkthrough instructions; follow them.",
		promptSnippet: "walkthrough_start: start a report-only walkthrough of a commit or code question",
		parameters: StartParams,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			validateShape(params, StartParams, "walkthrough_start");
			if (restricted) throw new Error("A walkthrough is already running; its budget cannot be changed.");
			const limits: Limits = { ...(params.records !== undefined ? { records: params.records } : {}), ...(params.time_s !== undefined ? { time_s: params.time_s } : {}) };
			const errors = checkLimits(limits);
			if (errors.length) throw new Error(`walkthrough_start rejected: ${errors.join("; ")}`);
			if (params.save_for_session) saveSessionLimits({ ...sessionLimits, ...limits });
			const prompt = startWalkthrough(params.scope, params.mode ?? "verification", params.save_for_session ? {} : limits);
			ctx?.ui?.notify?.(`Walkthrough budget: ${limitSource}.`, "info");
			return { content: [{ type: "text" as const, text: prompt }], details: { limits: resolved(), source: limitSource } };
		},
	});

	const LimitsParams = Type.Object({ ...LimitFields, reset: Type.Optional(Type.Boolean({ description: "Return to the defaults." })) });
	pi.registerTool({
		name: "walkthrough_limits",
		label: "Walkthrough limits",
		description: "Show or set the walkthrough budget for the rest of this session when the user asks, for example \"give walkthroughs 30 minutes from now on\". " +
			"Call with no arguments to report the current budget. Pass only what the user stated.",
		promptSnippet: "walkthrough_limits: show or set this session's walkthrough budget",
		parameters: LimitsParams,
		executionMode: "sequential",
		async execute(_id, params) {
			validateShape(params, LimitsParams, "walkthrough_limits");
			if (restricted) throw new Error("A walkthrough is running; its budget cannot be changed.");
			if (params.reset) saveSessionLimits({});
			else if (params.records !== undefined || params.time_s !== undefined) {
				const next: Limits = { ...sessionLimits, ...(params.records !== undefined ? { records: params.records } : {}), ...(params.time_s !== undefined ? { time_s: params.time_s } : {}) };
				const errors = checkLimits(next);
				if (errors.length) throw new Error(`walkthrough_limits rejected: ${errors.join("; ")}`);
				saveSessionLimits(next);
			}
			return { content: [{ type: "text" as const, text: `Walkthrough budget for this session: ${describeSession()}.` }], details: { session: sessionLimits } };
		},
	});

	pi.registerCommand("walkthrough", {
		description: "Write a report-only article: /walkthrough [--mode=verification|explanation] [--records=N] [--time=15m] <scope>",
		handler: async (args, ctx) => {
			const extracted = extractLimits(args);
			if (extracted.errors.length) {
				ctx.ui?.notify(`Walkthrough not started: ${extracted.errors.join("; ")}.`, "error");
				return;
			}
			const parsed = parseCommandArgs(extracted.rest);
			if (!parsed) {
				ctx.ui?.notify("Invalid walkthrough mode. Use verification or explanation.", "error");
				return;
			}
			const prompt = startWalkthrough(parsed.scope, parsed.mode, extracted.limits);
			if (extracted.matched.length) ctx.ui?.notify(`Walkthrough budget: ${limitSource}. Read from: ${extracted.matched.map((m) => `"${m}"`).join(", ")}.`, "info");
			pi.sendUserMessage(prompt);
			// Print and JSON modes exit when the command returns; keep it alive until the turn ends.
			if (!ctx.hasUI) {
				for (let i = 0; i < 100 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 50));
				await ctx.waitForIdle();
			}
		},
	});
}
