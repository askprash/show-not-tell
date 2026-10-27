// Smoke test for extensions/walkthrough.ts with a fake `pi` object.
// Run: node --test test/smoke.test.mjs   (Node >= 22.18 for TypeScript type stripping)
// pi supplies @earendil-works/pi-ai at runtime; here it is resolved from the global pi install.
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const piRoot = process.env.PI_ROOT ?? join(execSync("npm root -g", { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
const reportUrl = new URL("../extensions/report.ts", import.meta.url).href;
const reportWrapper = `import { renderPage as render } from ${JSON.stringify(reportUrl)}; export function renderPage(...args) { globalThis.__walkthroughRender = args; return render(...args); }`;
const piAi = join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
registerHooks({
	resolve(spec, ctx, next) {
		if (spec === "./report.ts" && ctx.parentURL?.endsWith("/walkthrough.ts")) return { url: `data:text/javascript,${encodeURIComponent(reportWrapper)}`, shortCircuit: true };
		if (spec === "@earendil-works/pi-ai") return { url: pathToFileURL(piAi).href, shortCircuit: true };
		return next(spec, ctx);
	},
});

const { default: walkthrough, prepareWriteArgs, parseCommandArgs, repositoryUrl, resolveScope, writesWalkthroughDir, ALLOWED_TOOLS, FIGKIT_DIR } = await import("../extensions/walkthrough.ts");

const tools = new Map();
const handlers = new Map();
const commands = new Map();
const activeToolCalls = [];
const sent = [];
const pi = {
	registerTool: (t) => tools.set(t.name, t),
	registerCommand: (name, c) => commands.set(name, c),
	on: (ev, fn) => handlers.set(ev, fn),
	sendUserMessage: (m) => sent.push(m),
	setActiveTools: (names) => activeToolCalls.push(names),
};
walkthrough(pi);

let cwd;
const ctx = () => ({ cwd, model: { provider: "fake", id: "model-1" } });
const record = (args) => tools.get("walkthrough_record").execute("t", args, undefined, undefined, ctx());
const write = (args) => tools.get("walkthrough_write").execute("t", args, undefined, undefined, ctx());

before(() => {
	cwd = mkdtempSync(join(tmpdir(), "wt-smoke-"));
	process.env.WALKTHROUGH_MAX_RECORDS = "3";
	handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx());
});
after(() => rmSync(cwd, { recursive: true, force: true }));

test("records, timeouts, refusals and the cap", async () => {
	const r1 = await record({ command: "echo hi && echo $WALKTHROUGH", why: "basic" });
	assert.equal(r1.details.id, "r1");
	assert.equal(r1.details.exit, 0);
	assert.equal(r1.details.stdout, "hi\n1\n");

	const r2 = await record({ command: "sleep 5", why: "timeout", timeout_s: 1 });
	assert.equal(r2.details.exit, null);
	assert.equal(r2.details.timed_out, true);
	assert.ok(r2.details.ms < 4000);

	const r3 = await record({ command: "git push origin main", why: "should refuse" });
	assert.equal(r3.details.refused, "report-only");

	const r4 = await record({ command: "echo third", why: "last allowed" });
	assert.equal(r4.details.exit, 0);
	const r5 = await record({ command: "echo over", why: "over the cap" });
	assert.equal(r5.details.refused, "budget");

	const lines = readFileSync(join(cwd, ".walkthrough", "evidence.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 6);
	assert.equal(JSON.parse(lines[0]).id, "r0");
	assert.equal(JSON.parse(lines[0]).snapshot, "before");
});

test("a walkthrough restricts the session to the two walkthrough tools", async () => {
	assert.deepEqual(ALLOWED_TOOLS, ["walkthrough_record", "walkthrough_write"]);
	assert.ok(activeToolCalls.length >= 1, "setActiveTools was not called");
	assert.deepEqual(activeToolCalls.at(-1), ALLOWED_TOOLS);
	assert.equal(handlers.has("tool_call"), false, "no denylist hook");
	assert.equal(writesWalkthroughDir("echo x > .walkthrough/a.html"), true);
	assert.equal(writesWalkthroughDir("python plot.py > .walkthrough/figs/cl.svg"), false);
	assert.equal(writesWalkthroughDir("cp x .walkthrough/figs/../evidence.jsonl"), true);
});

const payload = (id, quote) => ({
	title: "Walkthrough: smoke test", mode: "verification", scope: { label: "Smoke commit", head: "HEAD" },
	summary: "Prints hi.", sections: [{ id: "behavior", title: "Behavior", text: "Echo output", evidence: [{ record_id: id, summary: "Echo works", ...(quote ? { quote } : {}) }] }],
});
const rendered = () => { const [payload, log, meta, extras] = globalThis.__walkthroughRender; return { payload, log, meta, extras }; };

test("stringified structural arguments are parsed before validation", () => {
	assert.deepEqual(prepareWriteArgs({ sections: JSON.stringify([{ id: "behavior", title: "Title", text: "[prose]", evidence: JSON.stringify([{ record_id: "r1", summary: "ok" }]) }]) }).sections[0], { id: "behavior", title: "Title", text: "[prose]", evidence: [{ record_id: "r1", summary: "ok" }] });
	assert.deepEqual(prepareWriteArgs({ checks: "[]", scope: '{"label":"Commit","head":"HEAD"}' }), { checks: [], scope: { label: "Commit", head: "HEAD" } });
});

test("write accumulates the new article, rejects ids and drops non-verbatim quotes", async () => {
	const { title, scope, ...rest } = payload("r1");
	const part = await write({ title, scope });
	assert.deepEqual(part.details.missing, ["mode", "summary", "sections"]);
	assert.ok((await write(rest)).details.path);
	await assert.rejects(write(payload("r9")), /unknown record_id "r9"/);
	await assert.rejects(write(payload("r3")), /unknown record_id "r3"/);
	const dropped = await write(payload("r1", "hi  "));
	assert.match(dropped.content[0].text, /Dropped quotes/);
	assert.equal(rendered().payload.sections[0].evidence[0].quote, undefined);
	assert.equal(rendered().log.find((r) => r.id === "r1").stdout, "hi\n1\n");
	const res = await write(payload("r1", "hi"));
	assert.ok(existsSync(res.details.path));
	const html = readFileSync(res.details.path, "utf8");
	assert.match(html, /<section id="behavior"><h2>Behavior<\/h2>/);
	assert.match(html, /<details class="record" id="r1"><summary>basic /);
	assert.equal(html.split("echo hi &amp;&amp; echo $WALKTHROUGH").length - 1, 1, "real renderer retains the exact command once");
	assert.match(html, /<section id="limits"><h2>Material limits<\/h2>/);
	const result = rendered();
	for (const key of ["checks", "limits", "changes", "visuals"]) assert.deepEqual(result.payload[key], []);
	assert.ok(result.extras.autoLimits.some((l) => /timed out/.test(l.text)));
	assert.ok(result.extras.autoLimits.some((l) => /budget exhausted/.test(l.text)));
	assert.ok(result.extras.autoLimits.some((l) => /mutation refused/.test(l.text)));
	assert.equal(result.meta.model, "fake/model-1");
	assert.match(result.extras.scope.warning, /not a Git repository/);
});

test("direct execute validates malformed nested shapes and references", async () => {
	for (const patch of [{ scope: null }, { sections: [null] }, { checks: "none" }, { visuals: ["x"] }, { mode: "unknown" }, { checks: [{ label: "x", summary: "x", status: "unknown" }] }, { changes: [{ path: 1, note: "x" }] }, { sections: [{ id: "a", title: "a", text: "a", evidence: [null] }] }])
		await assert.rejects(write({ ...payload("r1"), ...patch }), /expected|invalid/);
	for (const id of ["overview", "r1", "r999", "Bad", "x_y"]) await assert.rejects(write({ ...payload("r1"), sections: [{ id, title: "t", text: "t" }] }), /invalid or colliding/);
	await assert.rejects(write({ ...payload("r1"), sections: [{ id: "same", title: "t", text: "t" }, { id: "same", title: "t", text: "t" }] }), /colliding/);
	for (const patch of [{ scope: { label: "x", head: "HEAD", record_id: "r99" } }, { limits: [{ text: "x", record_id: "r99" }] }, { checks: [{ label: "x", status: "passed", summary: "x" }] }, { checks: [{ label: "x", status: "inspected", summary: "x", record_ids: ["r99"] }] }]) {
		handlers.get("session_start")({}, ctx());
		await assert.rejects(write({ ...payload("r1"), ...patch }), /unknown record_id|requires at least one record/);
	}
});

test("at_ref runs a new test against the parent commit in a temporary worktree", async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-repo-"));
	const g = (args) => execSync(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, { cwd: repo, stdio: "pipe" });
	g("init -q");
	writeFileSync(join(repo, "f.sh"), "echo old\n");
	g("add f.sh");
	g("commit -qm one");
	writeFileSync(join(repo, "f.sh"), "echo new\n");
	writeFileSync(join(repo, "test.sh"), 'test "$(sh f.sh)" = new\n');
	g("add f.sh test.sh");
	g("commit -qm two");
	const saved = cwd;
	cwd = repo;
	process.env.WALKTHROUGH_MAX_RECORDS = "10";
	handlers.get("session_start")?.({ type: "session_start", reason: "new" }, ctx());
	try {
		const green = await record({ command: "sh test.sh", why: "green" });
		assert.equal(green.details.exit, 0);
		const red = await record({ command: "sh test.sh", why: "red", at_ref: "HEAD~1", overlay: ["test.sh"] });
		assert.equal(red.details.exit, 1);
		assert.equal(red.details.ref_sha.length, 40);
		const abs = await record({ command: `cd ${realpathSync(repo)} && sh test.sh`, why: "red with an absolute path", at_ref: "HEAD~1", overlay: ["test.sh"] });
		assert.equal(abs.details.exit, 1, "absolute project paths must run in the worktree");
		assert.equal(abs.details.mapped_paths, true);
		const badOverlay = await record({ command: "sh test.sh", why: "overlay that does not exist", at_ref: "HEAD~1", overlay: ["nope.sh"] });
		assert.equal(badOverlay.details.exit, null);
		const piped = await record({ command: "false | cat", why: "pipefail" });
		assert.equal(piped.details.exit, 1);
		assert.equal(execSync("git worktree list", { cwd: repo, encoding: "utf8" }).trim().split("\n").length, 1);
		assert.equal(execSync("git status --porcelain", { cwd: repo, encoding: "utf8" }), "");
	} finally {
		cwd = saved;
		rmSync(repo, { recursive: true, force: true });
	}
});

test("visual preparation validates capture hashes, section placement, links and geometry", async () => {
	const saved = cwd;
	cwd = mkdtempSync(join(tmpdir(), "wt-fig-"));
	handlers.get("session_start")({}, ctx());
	process.env.WALKTHROUGH_MAX_RECORDS = "20";
	try {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
		const r = await record({ command: `mkdir -p .walkthrough/figs && printf '%s' '${svg}' > .walkthrough/figs/plot.svg`, why: "diagram", produces: ".walkthrough/figs/plot.svg" });
		assert.equal(r.details.figures[0].sha256.length, 64);
		const two = await record({ command: `printf '%s' '${svg}' > .walkthrough/figs/a.svg && printf '%s' '${svg}' > .walkthrough/figs/b.svg`, why: "two plots", produces: ".walkthrough/figs/a.svg, .walkthrough/figs/b.svg" });
		assert.equal(two.details.figures.length, 2);
		const missing = await record({ command: "true", why: "no file", produces: "missing.png" });
		assert.match(missing.details.produces_missing, /was not written/);
		const stale = await record({ command: "touch -t 200001010000 .walkthrough/figs/plot.svg", why: "old image", produces: ".walkthrough/figs/plot.svg" });
		assert.match(stale.details.produces_missing, /before this command/);
		const visual = { record_id: "r1", kind: "diagram", caption: "A square", section_id: "behavior", links: [{ label: "Read", target: "section:behavior", x: 1, y: 2, width: 30, height: 40 }] };
		for (const patch of [{ record_id: "r3" }, { file: "other.png" }, { section_id: "missing" }, { links: [{ ...visual.links[0], target: "javascript:alert(1)" }] }, { links: [{ ...visual.links[0], target: "record:r999" }] }, { links: [{ ...visual.links[0], width: 101 }] }, { links: [{ ...visual.links[0], x: -1 }] }, { links: [{ ...visual.links[0], height: 0 }] }, { links: [{ ...visual.links[0], y: NaN }] }])
			await assert.rejects(write({ ...payload("r1"), visuals: [{ ...visual, ...patch }] }), /did not produce|unknown|geometry|expected number/);
		for (const id of ["checks", "limits", "changes", "scope", "log", "technical"]) {
			await assert.rejects(write({ ...payload("r1"), visuals: [{ ...visual, section_id: id }] }), /unknown section_id/);
			await assert.rejects(write({ ...payload("r1"), visuals: [{ ...visual, links: [{ ...visual.links[0], target: `section:${id}` }] }] }), /unknown link target/);
		}
		const page = await write({ ...payload("r1"), visuals: [visual, { record_id: "r2", file: "b.svg", kind: "plot", caption: "Second" }] });
		const html = readFileSync(page.details.path, "utf8");
		assert.match(html, /<img src="data:image\/svg\+xml;base64,/);
		assert.match(html, /href="#behavior" aria-label="Read" style="left:1%;top:2%;width:30%;height:40%"/);
		assert.match(html, /aria-label="Diagram destinations"/);
		assert.equal(rendered().extras.visuals[0].section_id, "behavior", "first visual stays in its chosen section");
		assert.equal(rendered().extras.visuals[1].section_id, "overview");
		assert.match(rendered().extras.visuals[0].src, /^data:image\/svg\+xml;base64,/);
		assert.ok(rendered().extras.autoLimits.some((l) => /Expected image unavailable/.test(l.text)));
		await record({ command: "git push origin main", why: "Refused mutation" });
		const refusalLink = { ...visual, links: [{ ...visual.links[0], target: "record:r6" }] };
		// The preceding successful write added r5 (after snapshot); refusal is r6.
		await write({ ...payload("r1"), visuals: [refusalLink] });
		assert.ok(rendered().extras.autoLimits.some((l) => l.record_id === "r6"), "navigation alone does not cover refusal");
		await write({ ...payload("r1"), visuals: [refusalLink], limits: [{ text: "Push was refused; no remote changes were made.", record_id: "r6" }] });
		assert.ok(!rendered().extras.autoLimits.some((l) => l.record_id === "r6"), "explicit refusal limit is not repeated");
		for (const patch of [{ sections: payload("r6").sections }, { checks: [{ label: "Push", summary: "Refused", status: "blocked", record_ids: ["r6"] }] }, { visuals: [{ ...visual, record_id: "r6" }] }])
			await assert.rejects(write({ ...payload("r1"), ...patch }), /unknown record_id "r6"/);
		writeFileSync(join(cwd, r.details.figures[0].path), "tampered");
		await assert.rejects(write({ ...payload("r1"), visuals: [visual] }), /changed after it was recorded/);
	} finally { rmSync(cwd, { recursive: true, force: true }); cwd = saved; }
});

const figkitReady = execSync(`"${FIGKIT_DIR}/scripts/check-env.sh" >/dev/null 2>&1 && echo ok || true`, { encoding: "utf8" }).trim() === "ok";
test("figkit diagrams are linted, outlined, previewed, and rejected with findings", { skip: !figkitReady && "figkit tools or fonts not installed" }, async () => {
	const saved = cwd;
	cwd = mkdtempSync(join(tmpdir(), "wt-figkit-"));
	handlers.get("session_start")({}, ctx());
	process.env.WALKTHROUGH_MAX_RECORDS = "20";
	try {
		const script = (label) => `from svgfig import Figure\nf = Figure()\na = f.node(14, 14, ["Direct solve", "$M_8 = 1$"], cat=0)\nb = f.node(a.x1 + 60, 14, ["${label}"], cat=1)\nf.arrow(a.r, b.l)\nf.save(".walkthrough/figs/ladder.svg", png=False)\n`;
		writeFileSync(join(cwd, "good.py"), script("Retry"));
		const good = await record({ command: `mkdir -p .walkthrough/figs && "$WALKTHROUGH_FIGKIT/run.sh" good.py`, why: "Draw the fallback ladder", produces: ".walkthrough/figs/ladder.svg", timeout_s: 120 });
		const fig = good.details.figures[0];
		assert.deepEqual(fig.lint, []);
		assert.ok(fig.outlined && existsSync(join(cwd, fig.outlined.path)));
		assert.doesNotMatch(readFileSync(join(cwd, fig.outlined.path), "utf8"), /<text/);
		assert.equal(good.content[1]?.type, "image");
		assert.match(good.content[0].text, /figkit lint: 0 findings/);
		writeFileSync(join(cwd, "bad.py"), script("We leverage a seamless retry"));
		const bad = await record({ command: `"$WALKTHROUGH_FIGKIT/run.sh" bad.py`, why: "Draw a figure with banned words", produces: ".walkthrough/figs/ladder.svg", timeout_s: 120 });
		assert.ok(bad.details.figures[0].lint.some((l) => /words: 'leverage'/.test(l)));
		const visual = (record_id) => ({ record_id, kind: "diagram", caption: "Fallbacks.", section_id: "behavior" });
		await assert.rejects(write({ ...payload("r1"), visuals: [visual("r2")] }), /lint findings/);
		const page = await write({ ...payload("r1"), visuals: [visual("r1")] });
		const src = rendered().extras.visuals[0].src;
		assert.equal(Buffer.from(src.split(",")[1], "base64").toString(), readFileSync(join(cwd, fig.outlined.path), "utf8"));
		assert.match(readFileSync(page.details.path, "utf8"), /figkit lint: 0 findings/);
		// The outlined copy is held to the same integrity check as the original.
		const outlinedPath = join(cwd, fig.outlined.path);
		const saved = readFileSync(outlinedPath);
		writeFileSync(outlinedPath, "<svg/>");
		await assert.rejects(write({ ...payload("r1"), visuals: [visual("r1")] }), /outlined copy .* changed/);
		rmSync(outlinedPath);
		await assert.rejects(write({ ...payload("r1"), visuals: [visual("r1")] }), /outlined copy .* unavailable/);
		writeFileSync(outlinedPath, saved);
		// At most four figures per record; the rest are reported, not processed.
		const many = await record({ command: "true", why: "Too many figures", produces: "a.svg, b.svg, c.svg, d.svg, e.svg, f.svg" });
		assert.match(many.details.produces_missing, /e\.svg skipped: at most 4 figures per record.*f\.svg skipped/);
	} finally { rmSync(cwd, { recursive: true, force: true }); cwd = saved; }
});

test("/walkthrough restricts the tools before it sends the skill", async () => {
	handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx());
	const before = activeToolCalls.length;
	await commands.get("walkthrough").handler("the last commit", { hasUI: true });
	assert.equal(activeToolCalls.length, before + 1);
	assert.deepEqual(activeToolCalls.at(-1), ALLOWED_TOOLS);
	assert.match(sent.at(-1), /<skill name="walkthrough"/);
	assert.match(sent.at(-1), /Write a walkthrough of: the last commit/);
});

test("snapshots before and after report files changed during the walkthrough", async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-snap-"));
	const g = (args) => execSync(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, { cwd: repo, stdio: "pipe" });
	g("init -q");
	writeFileSync(join(repo, "a.py"), "x = 1\n");
	writeFileSync(join(repo, "dirty.py"), "y = 1\n");
	g("add a.py dirty.py");
	g("commit -qm one");
	writeFileSync(join(repo, "dirty.py"), "y = 2\n"); // dirty before the walkthrough starts
	const saved = cwd;
	cwd = repo;
	handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx());
	try {
		const r1 = await record({ command: "echo x > tmp.txt && echo y >> dirty.py && mkdir emptydir", why: "writes a file" });
		assert.equal(r1.details.id, "r1");
		const res = await write(payload("r1"));
		assert.equal(rendered().extras.tree.checked, true);
		assert.deepEqual(rendered().extras.tree.changed, ["dirty.py", "emptydir/", "tmp.txt"]);
		const html = readFileSync(res.details.path, "utf8");
		const warning = "Files changed during the walkthrough: dirty.py, emptydir/, tmp.txt.";
		assert.ok(html.includes(warning));
		const prefix = html.slice(0, html.indexOf(warning));
		assert.equal((prefix.match(/<details\b/g) ?? []).length, (prefix.match(/<\/details>/g) ?? []).length, "mutation warning is outside details");
		const limits = html.match(/<section id="limits">([\s\S]*?)<\/section>/)[1];
		assert.match(limits, /href="#r0">Before snapshot/);
		assert.match(limits, /href="#r2">After snapshot/);
		assert.equal(rendered().log[0].snapshot, "before");
		assert.equal(rendered().log.at(-1).snapshot, "after");
		const again = await write(payload("r1"));
		const log = readFileSync(join(repo, ".walkthrough", "evidence.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(log.map((r) => r.id), ["r0", "r1", "r2"], "a second write replaces the after snapshot");
		assert.ok(again.details.path);
	} finally {
		cwd = saved;
		rmSync(repo, { recursive: true, force: true });
	}
	const clean = mkdtempSync(join(tmpdir(), "wt-clean-"));
	execSync("git init -q", { cwd: clean });
	cwd = clean;
	handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx());
	try {
		await record({ command: "mkdir -p .walkthrough/figs && echo ok > .walkthrough/figs/n.txt", why: "writes only under figs" });
		const res = await write(payload("r1"));
		assert.deepEqual(rendered().extras.tree.changed, []);
	} finally {
		cwd = saved;
		rmSync(clean, { recursive: true, force: true });
	}
});



test("mode parsing preserves scope punctuation, invalid modes do not activate, commands reset drafts and budgets", async () => {
	const scope = 'HEAD~2..HEAD -- path/a.ts:12, "why?"';
	assert.deepEqual(parseCommandArgs(`--mode=explanation ${scope}`), { mode: "explanation", scope });
	assert.deepEqual(parseCommandArgs(`--mode explanation ${scope}`), { mode: "explanation", scope });
	assert.deepEqual(parseCommandArgs(scope), { mode: "verification", scope });
	for (const arg of ["--mode=wrong HEAD", "--mode bad HEAD", "--mode", "--mode="]) assert.equal(parseCommandArgs(arg), undefined);
	handlers.get("session_start")({}, ctx());
	const count = activeToolCalls.length;
	const messages = sent.length;
	assert.equal(activeToolCalls.length, count, "ordinary session start preserves tools");
	assert.equal(handlers.has("input"), false, "invalid commands cannot activate through an eager input hook");
	await commands.get("walkthrough").handler("--mode=wrong HEAD", { hasUI: true });
	assert.equal(activeToolCalls.length, count);
	assert.equal(sent.length, messages);
	process.env.WALKTHROUGH_MAX_RECORDS = "1";
	await commands.get("walkthrough").handler(`--mode=explanation ${scope}`, { hasUI: true });
	assert.match(sent.at(-1), /Mode: explanation/);
	assert.ok(sent.at(-1).includes(scope));
	assert.equal((await record({ command: "echo fresh", why: "fresh" })).details.id, "r1");
	assert.equal((await record({ command: "echo capped", why: "capped" })).details.refused, "budget");
	await write({ title: "Old draft" });
	await commands.get("walkthrough").handler("--mode=verification HEAD", { hasUI: true });
	assert.match(sent.at(-1), /Mode: verification/);
	assert.equal((await record({ command: "echo reset", why: "reset" })).details.id, "r1");
	const part = await write({ summary: "New" });
	assert.ok(part.details.missing.includes("title"), "draft reset");
	const log = readFileSync(join(cwd, ".walkthrough/evidence.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
	assert.deepEqual(log.map((r) => r.id), ["r0", "r1"]);
	assert.equal(log[1].stdout, "reset\n");
	process.env.WALKTHROUGH_MAX_RECORDS = "20";
});

test("scope resolution uses immutable local commits and canonical credential-free GitHub/GitLab URLs", async () => {
	for (const [remote, expected] of [
		["git@github.com:owner/repo.git", "https://github.com/owner/repo"],
		["https://user:secret@github.com/owner/repo.git?token=private#secret", "https://github.com/owner/repo"],
		["ssh://git@gitlab.com/group/sub/repo.git", "https://gitlab.com/group/sub/repo"],
		["https://gitlab.com/group/repo", "https://gitlab.com/group/repo"],
	]) assert.equal(repositoryUrl(remote), expected);
	for (const remote of ["file:///tmp/repo", "javascript:alert(1)", "https://example.com/a/b", "https://github.com/a/b/tree/main", "https://github.com/a/b%2fc", "https://github.com/a/b/", "https://github.com/a/x/../b", "https://github.com/a/%2e%2e/b", "https://gitlab.com/a/-/blob/main", "https://github.com:999/a/b", "git://github.com/a/b"]) assert.equal(repositoryUrl(remote), undefined, remote);
	const saved = cwd;
	cwd = mkdtempSync(join(tmpdir(), "wt-scope-"));
	const g = (args) => execSync(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, { cwd, encoding: "utf8" }).trim();
	try {
		g("init -q"); writeFileSync(join(cwd, "a file.ts"), "one\ntwo\n"); g("add ."); g("commit -qm 'First subject'");
		writeFileSync(join(cwd, "a file.ts"), "one\nthree\n"); g("commit -qam 'Second subject'");
		g("remote add origin 'https://user:private@github.com/owner/repo.git?token=secret#private'");
		const head = g("rev-parse HEAD"); const base = g("rev-parse HEAD~1");
		const single = resolveScope(cwd, { label: "Single commit", head: "HEAD" }).scope;
		assert.equal(single.head_sha, head); assert.equal(single.base_sha, undefined);
		assert.deepEqual(single.commits.map((c) => c.subject), ["Second subject"]);
		assert.match(single.warning, /committed content only/);
		assert.equal(single.head_url, `https://github.com/owner/repo/commit/${head}`);
		const range = resolveScope(cwd, { label: "Range", head: "HEAD", base: "HEAD~1", include_working_tree: true }).scope;
		assert.equal(range.base_sha, base);
		assert.equal(range.compare_url, `https://github.com/owner/repo/compare/${base}...${head}`);
		assert.match(range.warning, /Working-tree content is included explicitly/);
		for (const ref of ["missing-ref", "--all", "--output=/tmp/unsafe"]) assert.match(resolveScope(cwd, { label: "Bad", head: ref }).scope.warning, /head could not be resolved/);
		assert.match(resolveScope(cwd, { label: "Bad base", head: "HEAD", base: "missing-ref" }).scope.warning, /base could not be resolved/);
		handlers.get("session_start")({}, ctx());
		await record({ command: "echo inspected", why: "inspection" });
		await write({ ...payload("r1"), changes: [{ path: "a file.ts", lines: "1-2", note: "Changed line" }] });
		assert.equal(rendered().extras.fileUrls["a file.ts"], `https://github.com/owner/repo/blob/${head}/a%20file.ts#L1-L2`);
		assert.doesNotMatch(JSON.stringify(rendered().extras), /private|secret|user:/);
		for (const path of ["../a", "/tmp/a", "a/*.ts", "a,b", "{a,b}", "a/../b", "C:\\a"]) await assert.rejects(write({ ...payload("r1"), changes: [{ path, note: "Invalid" }] }), /repository-relative path/);
		await write({ ...payload("r1"), changes: [{ path: "missing.ts", note: "Missing" }] });
		assert.match(rendered().extras.autoLimits[0].text, /unavailable as a committed file/);
		g("remote set-url origin git@gitlab.com:group/sub/repo.git");
		const lab = resolveScope(cwd, { label: "GitLab", head: "HEAD", base: "HEAD~1" }).scope;
		assert.equal(lab.compare_url, `https://gitlab.com/group/sub/repo/-/compare/${base}...${head}`);
		await write({ ...payload("r1"), changes: [{ path: "a file.ts", lines: "1-2", note: "Changed" }] });
		assert.equal(rendered().extras.fileUrls["a file.ts"], `https://gitlab.com/group/sub/repo/-/blob/${head}/a%20file.ts#L1-2`);
		g("remote set-url origin https://unsupported.test/group/repo");
		assert.equal(resolveScope(cwd, { label: "Local", head: "HEAD" }).scope.head_url, undefined);
		await write({ ...payload("r1"), changes: [], checks: [{ label: "Source", status: "inspected", summary: "Read source", record_ids: ["r1"] }] });
		assert.equal(rendered().extras.autoLimits.length, 0, "exit-zero inspection is not automatically a passed check");
		assert.equal(rendered().payload.checks[0].status, "inspected");
	} finally { rmSync(cwd, { recursive: true, force: true }); cwd = saved; }
});


test("elapsed budgets, process-group timeout cleanup and at_ref option rejection remain enforced", async () => {
	const saved = cwd;
	cwd = mkdtempSync(join(tmpdir(), "wt-budget-"));
	handlers.get("session_start")({}, ctx());
	process.env.WALKTHROUGH_BUDGET_S = "1";
	try {
		assert.equal((await record({ command: "echo should-not-run", why: "budget" })).details.refused, "budget");
		delete process.env.WALKTHROUGH_BUDGET_S;
		handlers.get("session_start")({}, ctx());
		const timed = await record({ command: "(sleep 4; echo leaked > child-marker) & wait", why: "group cleanup", timeout_s: 1 });
		assert.equal(timed.details.timed_out, true);
		await new Promise((r) => setTimeout(r, 3500));
		assert.equal(existsSync(join(cwd, "child-marker")), false);
		execSync("git init -q", { cwd });
		const bad = await record({ command: "echo should-not-run", why: "unsafe ref", at_ref: "--all" });
		assert.equal(bad.details.exit, null);
		assert.match(bad.details.stderr, /not a commit/);
		const nonzero = await record({ command: "exit 7", why: "Failure" });
		await write({ ...payload(nonzero.details.id), checks: [], limits: [], visuals: [] });
		assert.ok(rendered().extras.autoLimits.some((l) => /status 7/.test(l.text)));
		await write({ ...payload(nonzero.details.id), checks: [{ label: "Failure", status: "failed", summary: "Exited 7", record_ids: [nonzero.details.id] }], limits: [], visuals: [] });
		assert.ok(!rendered().extras.autoLimits.some((l) => l.record_id === nonzero.details.id));
	} finally {
		delete process.env.WALKTHROUGH_BUDGET_S;
		rmSync(cwd, { recursive: true, force: true }); cwd = saved;
	}
});
