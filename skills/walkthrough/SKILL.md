---
name: walkthrough
description: Write an evidence-carrying HTML walkthrough of the latest feature in a repository (the last commit or a named diff) in under five minutes. Every command the agent runs goes through the walkthrough_record tool, which records the command and its real output, and walkthrough_write renders the page in seven fixed sections (claim, map, evidence, checks changed, could it be wrong, not verified, what the result depends on) with figures from recorded runs. Trigger on "walkthrough", "/walkthrough", "show your work", or "walk me through the last commit / this feature". Report-only. It does not fix or change code.
---

# Walkthrough of the latest feature, with recorded evidence

A reader who was not here should see what ran, what changed, and where to check, within a few minutes.

## Scope

- Cover the latest feature only. That means the last commit, or the commit or diff the user names, and never the whole repository.
- Report only. Do not fix, refactor, commit, stash, check out or delete anything. The tool compares `git status` before and after, and the page lists any file that changed.
- Do not run commands that write into the repository, such as site builds into `dist/`, formatters, code generators or installs. Runs that write into the project's own ignored output folder (for example `runs/`) or into `.walkthrough/figs/` are fine.

## Tools

During a walkthrough you have two tools and nothing else.

- `walkthrough_record({command, why, timeout_s?, at_ref?, overlay?, produces?})` runs one bash command in the project and records it as `r1`, `r2`, .... Use it for everything, including reading code (`git show`, `sed -n`, `grep -n`). The log on the page lists every record, so a reader sees all you did.
- `walkthrough_write({...})` renders the page to `.walkthrough/<slug>.html`. It rejects unknown record ids, quotes that are not in the cited record, and figures whose record produced no file.

## Budget

- 20 recorded commands, 60 s each by default (`timeout_s` up to 120), 5 minutes in total from the first record. The tool refuses calls past the budget and lists them under "Not verified".
- Reading costs records too. Combine reads into one command (`git show --stat X && sed -n 10,40p a.py && grep -n cp b.py`).
- Run each test command once. Shape it so one output shows the totals and the names of any failing tests (the tool keeps the first and last 4 KB of each stream). Do not re-run a command only to filter its output.

## Command plan (in this order)

1. The scope, recorded with `git show --stat --numstat --format='%h %s%n%b' <sha>` (or `git diff --stat --numstat <range>`). The page draws its Map figure from this output.
2. The core change. Use `git show <sha> -- <files>` for the files the claim rests on, plus `sed -n` or `grep -n` for context, in as few records as you can. Hunk headers (`@@ -a,b +c,d @@`) give the Map's line numbers.
3. **Example run with a plot (required when the feature produces numbers).** Run the feature once on a small real input and plot its numeric output in the same command. See "Figures". This plot is the first thing the reader sees.
4. Find the tests that touch the changed files (`grep -rln <name> <test dirs>`), then run only those tests. Check which environment variables they read (`env | grep -i <name>`). A test of the real program is often skipped unless one is set. Never search the whole filesystem (`find /`), since that uses up the time budget.
5. **Red/green (required when the commit added or changed a test).** Run the same test command with `at_ref: "<sha>~1"` and `overlay: ["<new or changed test file>"]`, so the new test runs against the old code. A failure there, with a pass at the commit, shows the test checks the change. If the parent cannot run the test for an unrelated reason (missing environment, import error), say so under "Not verified" and do not call it red.
6. If budget is left, run the check from "Could it be wrong?", or record the diff of a second file the claim depends on.

If the named commit is not HEAD, run its checks with `at_ref: "<sha>"`. Otherwise say under "Not verified" that they ran on HEAD.

Commands start in the project directory, so use relative paths. The `at_ref` worktree is a fresh checkout. The tool links the main checkout's `.venv`, `venv` and `node_modules` into it. Other untracked files (built binaries, data, `.env`) are missing.

## Figures

Make two figures when the tool produces numbers, both from one recorded run.

- **Figure 1, the tool's main output.** Plot what the tool is for across its main input, even when the commit changes something else. For an aerofoil polar tool that is lift coefficient against angle of attack from one viscous run (for example NACA 2412, Re = 1e6, alpha from -4 to 12 deg). Pass it first in `figures`, so it appears under the Claim.
- **Figure 2, the commit's own output.** If the commit adds an output (such as per-angle Cp files), plot it from the same run and put it in Evidence.
- Use the tool's command-line entry point, not its internal functions. Read the script's usage line first (`sed -n 1,20p <script>`), write the input file with a heredoc under `.walkthrough/figs/`, run the script, and plot from its result file, all in one record. Set `produces` to the plot path. When one command writes both plots, list both in `produces`, separated by a comma, and name each with `file` in `figures`. Never copy or re-touch a plot to record it again.
- Plot numbers from a run you record in this walkthrough. Do not plot a fixture or any other file committed to the repository, since that shows stored data and not the tool running.
- Plot with matplotlib. Before the plot, check for it with one recorded command (`uv run --offline --no-project --with matplotlib python -c "import matplotlib"`, or the project's `.venv/bin/python -c "import matplotlib"`), then plot with whichever worked.
- Every plot has axis labels with quantities and units, ticks on both axes, a light grid, a title naming the case (for example "NACA 2412, Re = 1e6, viscous"), and a marker on each computed point. Save PNG at dpi 120 or more.
- Fall back to a plain-Python SVG only when both matplotlib checks fail, and say so under "Not verified". The SVG still needs axis labels with units, at least five ticks per axis, and a marker per point.
- Write captions that stand alone, with the inputs and the record id.
- Pass `figures: []` only when the tool produces no numbers. Say why under "Not verified".

## The seven sections (fixed order; walkthrough_write renders them)

1. **Claim.** What the feature does, in two sentences, and how sure you are. Start `confidence` with high, medium or low, then the reason.
2. **Map.** Files and line ranges touched, each with a one-line note and the record that showed the lines. The tool adds a bar chart of lines added and deleted per file.
3. **Evidence.** Each claim paired with a record id and what to look for in its output. Add a short exact `quote` for the key line. Red/green goes here.
4. **Checks changed.** Every test, tolerance or check added, changed, skipped or deleted in the scope, read from the diff. Pass an empty array when there are none.
5. **Could it be wrong?** Other explanations for the result, and the run that would show the claim wrong. Give a `record_id` only if that record is the run you describe.
6. **Not verified.** What you did not run or could not check. Name parts without a test, environments not tried, and inputs outside what was run.
7. **What the result depends on** (`depends_on`). The one or two items the conclusion rests on, and exactly what the reader should run or open to check each.

## Grounding rules

- Every snippet, number and output on the page comes from a record. Cite its id. Never type an output, a line count or a test count from memory.
- Copy each `quote` exactly from the record's output, and keep it to a few lines. The tool drops a quote it cannot find.
- Take Map line numbers from hunk headers or `sed -n` output in a cited record. A diffstat has no line numbers. If no record shows the lines, write "see diff in rN".
- A passing test is evidence only for what it asserts. Say what the test checks.
- A tolerance or threshold is bookkeeping. Report both values with units and the difference.
- If the tree has uncommitted changes, say whether the walkthrough covers them.
- Keep what ran apart from what you infer. Inference belongs in the Claim's confidence reason or under "Not verified".

## Writing rules

- Plain, direct sentences. Short bullets. One idea per line. No metaphors.
- Do not join two statements with a colon. Write two sentences.
- Avoid the pattern "X is this, but Y is not". State each fact in its own sentence.
- Use the correct technical term and define it in a few words on first use, for a competent reader from another field.
- Every number has units and a record id.
- Banned words: honest, honestly, clearly, obviously, definitive, decisive, conclusive, basically, truly, genuinely, essentially, literally, certainly, of course, indeed, notably, robust, powerful, seamless, leverage, utilize, facilitate, comprehensive, thorough, crucial, vital, key (as in "key insight"), highlight, showcase, significantly, substantially, meticulous, rigorous, nuanced, pivotal, delve, unlock, gate, tier, hinge, smoking gun, north star, long pole, fan out, sanity check, happy path, under the hood, out of the box.
- No filler or hedges ("it is worth noting", "in order to", "potentially", "arguably", "perhaps", "it seems").
- No references to this conversation ("as requested", "as mentioned above").

## Finish

1. Call `walkthrough_write` with all seven sections and the figures. A large payload can go in two calls (for example title, scope, claim, map and evidence first, then the rest). If it rejects a section, resend only that section.
2. Reply in two lines. Give the page path on the first, and on the second the one or two things the result depends on.
