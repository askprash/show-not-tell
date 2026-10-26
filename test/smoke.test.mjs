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
const piAi = join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
registerHooks({
	resolve(spec, ctx, next) {
		if (spec === "@earendil-works/pi-ai") return { url: pathToFileURL(piAi).href, shortCircuit: true };
		return next(spec, ctx);
	},
});

const { default: walkthrough, prepareWriteArgs, parseDiffStat, writesWalkthroughDir, ALLOWED_TOOLS } = await import("../extensions/walkthrough.ts");

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

const HEADINGS = ["1. Claim", "2. Map", "3. Evidence", "4. Checks changed", "5. Could it be wrong?", "6. Not verified", "7. What the result depends on"];

const payload = (id, quote) => ({
	title: "Walkthrough: smoke test",
	scope: "fake scope",
	claim: { text: "Prints hi.", confidence: "high: it ran" },
	map: [{ path: "a.py", lines: "1-2", note: "nothing" }],
	evidence: [{ claim: "echo works", record_id: id, what_to_look_for: "hi", ...(quote ? { quote } : {}) }],
	checks_changed: [],
	could_be_wrong: [{ alternative: "echo is aliased", test_that_would_show_it: "type echo" }],
	not_verified: ["Windows"],
	depends_on: [{ item: "r1 output", how_to_spot_check: "Run echo hi", record_id: "r1" }],
	figures: [],
});

test("stringified arguments are parsed before validation", () => {
	assert.deepEqual(prepareWriteArgs({ checks_changed: "none" }).checks_changed, []);
	assert.deepEqual(prepareWriteArgs({ checks_changed: '[{"what":"a","how":"b"}]' }).checks_changed, [{ what: "a", how: "b" }]);
	assert.deepEqual(prepareWriteArgs({ map: [] }).map, []);
	assert.deepEqual(prepareWriteArgs({ hinge_points: [] }).depends_on, []);
	assert.deepEqual(prepareWriteArgs({ map: ['{"path":"a","lines":"1","note":"n"}'] }).map, [{ path: "a", lines: "1", note: "n" }]);
	assert.deepEqual(prepareWriteArgs({ claim: '{"text":"t","confidence":"high"}' }).claim, { text: "t", confidence: "high" });
	assert.deepEqual(prepareWriteArgs({ claim: "t", confidence: "low" }).claim, { text: "t", confidence: "low" });
	assert.deepEqual(prepareWriteArgs({ claim: "\n<parameter name=\"text\">t", confidence: "high" }).claim, { text: "t", confidence: "high" });

});

test("write rejects bad ids and bad quotes, then renders the page", async () => {
	const { title, scope, claim, ...rest } = payload("r1");
	const part = await write({ title, scope, claim });
	assert.match(part.content[0].text, /Still needed before the page can be written: map, evidence/);
	assert.ok((await write(rest)).details.path, "the second half completes the page");
	await assert.rejects(write(payload("r9")), (e) => /unknown record_id "r9"/.test(e.message) && /Valid record ids: r0, r1, r2, r4, r6/.test(e.message));
	await assert.rejects(write(payload("r3")), /unknown record_id "r3"/); // refused records cannot be cited
	const droppedRes = await write(payload("r1", "bye"));
	assert.match(droppedRes.content[0].text, /Dropped quotes not found in their records: evidence\[0\] \(r1\)/);
	assert.doesNotMatch(readFileSync(droppedRes.details.path, "utf8"), /<pre>bye<\/pre>/);

	const res = await write(payload("r1", "hi"));
	const file = res.details.path;
	assert.ok(file.endsWith(join(".walkthrough", "walkthrough-smoke-test.html")) && existsSync(file));
	const html = readFileSync(file, "utf8");
	for (const h of HEADINGS) {
		assert.ok(html.includes(`<h2>${h}</h2>`), `missing heading ${h}`);
	}
	const order = HEADINGS.map((h) => html.indexOf(`<h2>${h}</h2>`));
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	assert.match(html, /Not run because the budget ran out/);
	assert.match(html, /Timed out after/);
	assert.match(html, /Reader's spot-check list/);
	assert.match(html, /model fake\/model-1/);
	assert.doesNotMatch(html, /<script/i);
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

test("diffstat parsing handles --stat, --numstat and junk", () => {
	const stat = parseDiffStat(" a/b.ts | 8 ++++++++\n c.py   | 44 +++++++++++++++++++++++++++++++++++++++++++--\n img.png | Bin 0 -> 12 bytes\n 3 files changed\n");
	assert.deepEqual(stat[0], { path: "a/b.ts", add: 8, del: 0, approx: false });
	assert.equal(stat[1].add + stat[1].del, 44);
	assert.equal(stat.length, 2);
	assert.deepEqual(parseDiffStat("10\t2\tx.py\n"), [{ path: "x.py", add: 10, del: 2, approx: false }]);
	assert.equal(parseDiffStat("no stat here"), undefined);
});

test("figures: produces, embedding, the Map figure, and bad figure refs", async () => {
	const repo = mkdtempSync(join(tmpdir(), "wt-fig-"));
	const g = (args) => execSync(`git -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${args}`, { cwd: repo, stdio: "pipe" });
	g("init -q");
	writeFileSync(join(repo, "a.py"), "x = 1\ny = 2\n");
	g("add a.py");
	g("commit -qm one");
	writeFileSync(join(repo, "a.py"), "x = 1\ny = 3\nz = 4\n");
	g("commit -qam two");
	const saved = cwd;
	cwd = repo;
	handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx());
	try {
		const r1 = await record({ command: "git show --stat --format=%h HEAD", why: "scope" });
		assert.equal(r1.details.exit, 0);
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
		const r2 = await record({ command: `mkdir -p .walkthrough/figs && printf '%s' '${svg}' > .walkthrough/figs/plot.svg`, why: "plot", produces: ".walkthrough/figs/plot.svg" });
		assert.equal(r2.details.exit, 0);
		assert.equal(r2.details.figures[0].path, join(".walkthrough", "figs", "r2-plot.svg"));
		assert.equal(r2.details.figures[0].sha256.length, 64);
		assert.match(r2.content[0].text, /figure: .*r2-plot\.svg/);
		const two = await record({ command: `printf '%s' '${svg}' > .walkthrough/figs/a.svg && printf '%s' '${svg}' > .walkthrough/figs/b.svg`, why: "two plots", produces: ".walkthrough/figs/a.svg, .walkthrough/figs/b.svg" });
		assert.deepEqual(two.details.figures.map((f) => f.path.split("/").pop()), ["r3-a.svg", "r3-b.svg"]);
		const r3 = await record({ command: "true", why: "no file", produces: "missing.png" });
		assert.match(r3.details.produces_missing, /was not written/);

		const base = { ...payload("r1"), map: [{ path: "a.py", lines: "2-3", note: "changed y, added z", record_id: "r1" }] };
		await assert.rejects(write({ ...base, figures: [{ record_id: "r4", caption: "nothing" }] }), /r4 did not produce a figure.*records with figures: r2 \(r2-plot\.svg\), r3 \(r3-a\.svg, r3-b\.svg\)/);
		await assert.rejects(write({ ...base, figures: [{ record_id: "r2", caption: "x", file: "other.png" }] }), /did not produce a figure named other\.png/);
		await assert.rejects(write({ ...base, figures: [{ record_id: "r2", caption: "x", section: "Appendix" }] }), /unknown section/);

		const res = await write({ ...base, figures: [{ record_id: "r2", caption: "A square, 10 px." }, { record_id: "r3", caption: "Second file.", file: "b.svg", section: "Evidence" }] });
		const html = readFileSync(res.details.path, "utf8");
		const claimAt = html.indexOf("<h2>1. Claim</h2>");
		const figAt = html.indexOf("data:image/svg+xml;base64,");
		assert.ok(figAt > claimAt && figAt < html.indexOf("<h2>2. Map</h2>"), "first figure sits under the Claim");
		assert.match(html, /A square, 10 px\. Produced by <a class="rid" href="#r2">/);
		const mapSec = html.slice(html.indexOf("<h2>2. Map</h2>"), html.indexOf("<h2>3. Evidence</h2>"));
		assert.match(mapSec, /<svg viewBox/);
		assert.match(mapSec, /\+2 −1/);
		assert.match(html, /cited in: Map, Evidence, What the result depends on, Map \(figure\)/);
		assert.match(html, /<b>r4<\/b>.*not cited/);
		assert.match(html, /Second file\. Produced by <a class="rid" href="#r3">/);
		assert.match(html, /Expected figure not captured/);
		assert.doesNotMatch(html, /<script/i);
	} finally {
		cwd = saved;
		rmSync(repo, { recursive: true, force: true });
	}
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
		const res = await write({ ...payload("r1"), map: [] });
		const html = readFileSync(res.details.path, "utf8");
		assert.match(html, /Files changed during the walkthrough<\/span> <code>dirty\.py<\/code>, <code>emptydir\/<\/code>, <code>tmp\.txt<\/code>\./);
		assert.match(html, /<details id="r0">/);
		assert.match(html, /<details id="r2">.*Working tree when walkthrough_write was called/);
		const again = await write({ ...payload("r1"), map: [] });
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
		const res = await write({ ...payload("r1"), map: [] });
		assert.match(readFileSync(res.details.path, "utf8"), /Working tree unchanged during the walkthrough\./);
	} finally {
		cwd = saved;
		rmSync(clean, { recursive: true, force: true });
	}
});

