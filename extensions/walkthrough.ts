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
import type { EvidenceRecord, FigureFile, WritePayload, PageMeta, PageExtras, ScopeRequest, ResolvedScope, WalkthroughMode } from "./report-types.ts";
export type * from "./report-types.ts";

const OUT_DIR = ".walkthrough";
const FIG_DIR = `${OUT_DIR}/figs`;
const STREAM_KEEP = 8 * 1024;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 120;
const KILL_GRACE_MS = 2000;
const MAX_FIG_BYTES = 5 * 1024 * 1024;
export const ALLOWED_TOOLS = ["walkthrough_record", "walkthrough_write"];
const WRITE_KEYS = ["title", "mode", "scope", "summary", "sections"];
const OPTIONAL_ARRAYS = ["checks", "limits", "changes", "visuals"];

const HERE = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const SKILL_FILE = resolve(HERE, "..", "skills", "walkthrough", "SKILL.md");

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

// Parse only structural JSON inputs, never prose (including quotes and recorded text).
export function prepareWriteArgs(args: unknown): unknown {
	const decode = (value: unknown): unknown => {
		if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
			try { return decode(JSON.parse(value)); } catch { return value; }
		}
		if (Array.isArray(value)) return value.map(decode);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) =>
			[k, ["text", "title", "summary", "quote", "caption", "alt", "label", "note", "path", "head", "base", "file", "target", "lines", "id", "record_id", "section_id", "mode", "kind", "status"].includes(k) ? v : decode(v)]));
		return value;
	};
	return decode(args);
}

const RESERVED_IDS = new Set(["overview", "checks", "limits", "changes", "scope", "log", "technical"]);
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
				figs.map((f) => `figure: ${f.path} (${f.bytes} bytes, sha256 ${f.sha256.slice(0, 16)}…); cite it in walkthrough_write visuals as record_id ${id}, file ${basename(f.path)}\n`).join("") +
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
			"Render a source-linked article from title, mode, structured scope, summary and sections. Fields accumulate across calls. " +
			"Checks, limits, changes and visuals default to empty arrays. Evidence quotes must occur verbatim in cited output. " +
			"Visuals must cite captured images; material failures and refusals remain visible as limits.",
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
				if (!ID.test(section.id) || RESERVED_IDS.has(section.id) || log.some((r) => r.id === section.id) || /^r[0-9]+$/.test(section.id) || ids.has(section.id)) problems.push(`sections: invalid or colliding id "${section.id}"`);
				ids.add(section.id);
			}
			const sectionIds = new Set(["overview", "checks", "limits", "changes", "scope", ...ids]);
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
				visuals.push({ ...v, src: `data:${chosen.path.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png"};base64,${buf.toString("base64")}` });
			});
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
			const covered = new Set([...p.limits.map((l) => l.record_id), ...p.checks.filter((c) => ["failed", "blocked", "not-run"].includes(c.status)).flatMap((c) => c.record_ids ?? [])]);
			for (const r of log) {
				if (covered.has(r.id)) continue;
				const reasons: string[] = [];
				if (r.refused) reasons.push(r.refused === "budget" ? "Not run: recording budget exhausted." : "Not run: report-only mutation refused.");
				else if (r.timed_out) reasons.push("Command timed out.");
				else if (!r.snapshot && r.exit !== 0) reasons.push(r.exit == null ? "Command could not run." : `Command exited with status ${r.exit}.`);
				if (r.produces_missing) reasons.push(`Expected image unavailable: ${r.produces_missing}.`);
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
				cwd,
			};
			const html = renderPage(p, log, meta, { scope, visuals, autoLimits, tree, fileUrls });
			const dir = join(cwd, OUT_DIR);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `${slugify(p.title)}.html`);
			writeFileSync(file, html);
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

	pi.registerCommand("walkthrough", {
		description: "Write a report-only article: /walkthrough [--mode=verification|explanation] <scope>",
		handler: async (args, ctx) => {
			const parsed = parseCommandArgs(args);
			if (!parsed) {
				ctx.ui?.notify("Invalid walkthrough mode. Use verification or explanation.", "error");
				return;
			}
			reset();
			const { scope, mode } = parsed;
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
			pi.sendUserMessage(`${text}\n\nMode: ${mode}. ${mode === "verification" ? "Report observed checks; exit zero alone is not a scientific or test pass." : "Explain code and reasoning from recorded source inspection; inspection is not runtime verification. Tests and visuals are optional."} Both modes are report-only and use only walkthrough_record and walkthrough_write. Use the current structured report contract: title, mode, scope {label, head, base?, include_working_tree?}, summary, sections [{id, title, text, evidence?: [{record_id, summary, quote?}]}], with optional checks, limits, changes and visuals arrays. Do not use the obsolete seven-section payload.`);
			// Print and JSON modes exit when the command returns; keep it alive until the turn ends.
			if (!ctx.hasUI) {
				for (let i = 0; i < 100 && ctx.isIdle(); i++) await new Promise((r) => setTimeout(r, 50));
				await ctx.waitForIdle();
			}
		},
	});
}
