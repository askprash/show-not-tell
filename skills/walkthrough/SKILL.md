---
name: walkthrough
description: Explain a code change or show the work behind it in a readable, source-linked HTML page. Use for walkthrough, show your work, explain this code, or walk me through a commit. Verification mode runs relevant checks; explanation mode teaches code and reasoning. Both retain exact recorded sources and identify Git commits.
---

# Walk through the work for a reader who was not there

The reader should understand what changed, how it works, what you checked, and what remains uncertain without reading a shell command. The command log supports the explanation; it is not the explanation.

## Choose the mode

- **Verification** is the default. `/walkthrough --mode=verification <scope>` demonstrates behavior with relevant examples and checks.
- **Explanation** uses `/walkthrough --mode=explanation <scope>`. Teach the code, algorithm, architecture, or scientific reasoning. Record the source you inspect. Do not treat code inspection as a passing runtime check.

Follow the reader's question. Neither mode requires a fixed section count, a plot, a diagram, or a parent-version test.

## Stay within scope

Cover the named commit, range, or code question. Record the scope and relevant diff early. Resolve exact commits rather than describing a moving `HEAD` as a permanent identity. Say whether uncommitted content is included.

Report only. Do not fix, refactor, commit, install dependencies, or change project files. Commands can write into `.walkthrough/figs/` or the project's own ignored output directory. Use an explicit output option when a program would otherwise overwrite committed data.

During the walkthrough, use only:

- `walkthrough_record({command, why, timeout_s?, at_ref?, overlay?, produces?})` for commands, including reading code. `why` is a short, plain-language action such as “Run the cruise-thrust sweep and generate two plots.” It appears as the record heading, so do not put a hash or a shell command in place of the action.
- `walkthrough_write({...})` to create the page from recorded sources. It accepts the report fields in one call or several calls. No need to fill a seven-part form.

The default budget is 20 commands and 5 minutes, with 60 seconds per command (120 maximum). Spend it on the reader's question. Do not rerun a test just to filter its output. Keep failure names and totals in the recorded output. The tool retains the beginning and end of long streams and marks truncation.

## Build an explanation, not a transcript

1. Inspect the scope and core code. Read only what is needed to understand the change.
2. Explain the bottom line in a short paragraph. Give unfamiliar terms a short definition when needed.
3. Choose a few sections with descriptive headings. Follow the code's data flow, the scientific argument, or the result the reader cares about. Tie each observation to its recorded source.
4. In verification mode, run checks that address the claim. A parent-version run with an overlaid new test is useful when showing a regression fix. Do not require it for coverage of behavior that was already correct. An environment failure is blocked verification, not evidence that the old code is wrong.
5. State material limits next to the result or under Limits. Separate measurements made here from values read from committed files. State what a test asserts, not just that it passed.

## Format prose for reading

Prose fields (summary, section text, evidence summaries, captions, checks, limits) accept a small Markdown subset. Use it, because the reader sees rendered output, not source:

- **Math in LaTeX**, rendered by KaTeX: `$M_8 = 1$` inline, and `$$ ... $$` on its own lines for a display equation. Write symbols with subscripts and Greek letters in LaTeX (`$P_0$`, `$\pi^*$`, `$\sqrt{a^2+b^2}$`), not Unicode look-alikes such as "P₀" or "√". Escape a literal dollar sign as `\$`.
- **Pipe tables** for comparisons such as before/after counts, stage-by-stage behavior, or parameter choices. Separator row `|---|---|`; end a column with `:` to right-align numbers.
- Bullet or numbered lists for parallel items, `` `code` `` for identifiers, `**bold**` for the one thing a reader must not miss.

No links, images or raw HTML in prose. Cite records through evidence instead.

Write full sentences for explanations. Short fragments are fine for labels and table cells. Prefer precise verbs to confidence slogans. Remove repeated detail rather than compressing an explanation into unexplained jargon. Do not add generic homework, a citation-count score, or a global confidence badge.

## Use visuals when they explain something

A plot can explain numerical behavior. A flowchart can explain an algorithm, code path, dependency, or chain of reasoning. Use neither as decoration. A compact table may be better than another plot. Do not add a file-churn chart just because a diffstat is available.

For diagrams, use the svg-figs skill if it is available. Run its environment check, generate the SVG with its library, run the lint, and inspect the PNG. Otherwise use an available diagram generator; do not invent measurements. Keep a script beside its diagram under `.walkthrough/figs/` so it can be reproduced. The npm package does not depend on a machine-local skill installation.

Record the command that writes each SVG or PNG and pass the path in `produces`. Only figures captured by a record can be embedded. Existing, recorded source data may be used for an explanatory visual, but label it as stored data; do not present it as a fresh experiment. In verification mode, favor a figure from the demonstrated run.

Give plots meaningful quantity names and units. A caption says what the reader should notice, then the relevant conditions. Put lengthy setup details in an adjacent section rather than repeating them in every caption. Keep commands and hashes out of captions.

Diagrams can have clickable regions. In the visual's `links`, supply a label, `target` of `section:<id>` or `record:<id>`, and `x`, `y`, `width`, `height` as percentages of the entire image bounds. Section targets are `overview` or authored section IDs, not generated sections such as `checks` or `scope`. The tool validates targets and geometry. Links are HTML overlays on a non-active image, so the SVG cannot inject page code. Link the diagram to the sections that explain its nodes; the renderer also supplies text links for keyboard access.

## Write the page

Read `../../docs/report-format.md` relative to this skill directory when you need field details. The write payload is:

- `title`: a descriptive title, not a hash range.
- `mode`: `verification` or `explanation`.
- `scope`: `{label, head, base?, include_working_tree?, record_id?}`. Use a short human label. `head` and optional `base` are Git refs the tool resolves. Omit `base` for a single commit.
- `summary`: a brief bottom line.
- `sections`: ordered `{id, title, text, evidence?}` entries. Use lowercase hyphenated IDs. An evidence entry is `{record_id, summary, quote?}`. A quote must appear in that record's output.
- `checks`: optional `{label, status, summary, record_ids?}` entries. Status is `passed`, `failed`, `blocked`, `not-run`, or `inspected`. Every status except `not-run`, including `blocked`, requires at least one executed or inspected record. Cite refused commands in limits or diagram navigation, not as check or article evidence.
- `limits`: optional `{text, record_id?}` entries. State important uncertainty once, without repeating it across several categories.
- `changes`: optional `{path, note, lines?, record_id?}` entries. Use one actual repository-relative path per entry, not a glob or a list packed into a string. Include changed tests and tolerances when material to the result.
- `visuals`: optional `{record_id, file?, kind, caption, alt?, section_id?, links?}` entries. `kind` is `plot` or `diagram`. Placement defaults to `overview`; otherwise name a section ID. The renderer respects the requested placement.

Empty optional arrays are fine. The reader can expand the changed files, scope commits, and complete exact command log. Do not repeat commands in article prose. Never invent output, numbers, units, source lines, or facts. Keep observations separate from explanations of their cause.

Finish with the page path and the principal result or limitation. Do not narrate the tool protocol back to the reader.
