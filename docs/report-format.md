# Walkthrough report format

The report teaches a reader who was not present during the work. The exact command log is supporting evidence, not the article.

## Modes

`/walkthrough --mode=verification <scope>` checks what the change does. This is the default. Run relevant examples and tests when practical. Distinguish observations made in this walkthrough from measurements read from committed files. A parent-version test is useful for a regression fix, not a universal requirement for new coverage.

`/walkthrough --mode=explanation <scope>` explains code, algorithms, scientific reasoning, or architecture. Inspect source through recorded commands. Do not imply that reading code establishes runtime correctness. Tests and plots are optional when they answer the reader's question.

Both modes are report-only. Both resolve Git scope and retain recorded sources. Neither requires a fixed number of sections or visuals.

## Data

`extensions/report-types.ts` is the shared TypeScript contract. The write tool accepts the fields of `WritePayload`, either together or across calls. `title`, `mode`, `scope`, `summary`, and `sections` define the article. Empty `checks`, `limits`, `changes`, and `visuals` arrays are valid; the tool supplies those defaults. The old seven-section payload is replaced, not maintained as a second report format.

- `scope` supplies a descriptive label and Git head, optionally a comparison base. The tool resolves immutable commits from the repository. With no base, the scope is that single commit. An unavailable Git ref is reported, not guessed. `include_working_tree` explicitly declares whether uncommitted content is included.
- `sections` are ordered prose blocks with reader-chosen headings (see Prose markup). IDs use lowercase letters, digits, and hyphens, begin with a letter, and cannot collide with reserved IDs `overview`, `checks`, `limits`, `changes`, `scope`, `log`, `technical`, or record IDs. Evidence items carry a record ID, a short observation, and optionally a verbatim output excerpt. The renderer must not repeat the full command here.
- `checks` distinguish passed, failed, blocked, not-run, and inspected. Every status except `not-run`, including `blocked`, requires at least one executed or inspected record. Refused commands can be cited in limits and diagram navigation, not as check or article evidence. Exit zero alone is not a passing scientific or test result.
- `limits` state material uncertainty once. Failed runs and report-only refusals are automatically included when not already represented. Important limits are not hidden in the appendix.
- `changes` contain one actual repository-relative path per entry. They are not glob patterns or comma-separated groups. File links, when available, use the resolved head commit.
- `visuals` name image files captured by a record. The tool checks the captured file's hash before embedding it. `section_id` defaults to `overview`; otherwise it must name an authored section. The first visual is not silently moved to another section. A plot explains a numerical result; a diagram explains structure or reasoning. Captions explain what the image means, not how its command was launched.


## References and readability

`references` declare decision records, documents, tickets and commits that prose cites as `[[id]]` or `[[id|words]]`. A `path` resolves to the file at the scope head; a `commit` resolves to its hash. With a supported remote, the citation links to that immutable URL; otherwise it links to the References appendix. The reader sees the `label`, which states the decision or change. The `identifier` (such as ADR-0028) and the hash appear only in the link title and the appendix. An unresolvable reference is listed as a limit.

The write tool rejects prose that a reader without session context cannot follow:

- bare identifiers in prose: ticket and decision numbers (`ADR-0028`, `PC-32`, `ADR008`, `#123`) and commit hashes. Code spans, math, `[[references]]` and verbatim evidence quotes are not checked. Standard names such as UTF-8, ISO-9001 and SHA-256 are allowed;
- reference labels that are only a number;
- paragraphs over 60 words, list items over 40, table cells over 25, and inline "(1) … (2) …" enumerations;
- captions, evidence summaries, check summaries, limits and change notes over 40 words, and titles or labels over 14.

Each finding names the field and what to write instead.

## Prose markup

Authored prose fields (summary, section text and titles, evidence summaries, captions, check and limit text, change notes) use a closed Markdown subset: paragraphs, pipe tables with optional column alignment, bullet and numbered lists, fenced code, `` `code` ``, `**bold**`, `$...$` inline math and `$$...$$` display math. `\$` is a literal dollar sign, and `$5 and $10` stays text (a closing `$` before a digit or after a space does not close math). Prose without markup renders as escaped paragraphs.

Apart from declared references, which link only to tool-resolved repository URLs or local anchors, there are no links, images, raw HTML or attributes. Everything else is escaped. Math is rendered to HTML and MathML by KaTeX at write time with `trust: false`, so `\href`, `\url`, `\includegraphics` and `\html*` commands produce no active output. Invalid LaTeX is shown in an error color and does not stop the write. When a page contains math, the KaTeX stylesheet and its WOFF2 fonts are inlined as data URLs, so the page stays offline. Pages without math do not include them.

Runtime-generated text (automatic limits, paths, metadata, recorded output) is never parsed as markup.

## Diagrams

The package bundles `figkit/`, a Python figure library adapted from the svg-figs skill. It has design tokens for the report column, text measured with HarfBuzz, LaTeX math typeset by XeLaTeX into glyph outlines, and a lint. Recorded commands receive its path in `WALKTHROUGH_FIGKIT`. `figkit/run.sh` runs a script through `uv` with `uharfbuzz`. The runtime needs uv, XeLaTeX with dvisvgm, rsvg-convert, and the STIX Two Text, IBM Plex Mono and New Computer Modern Math fonts; `figkit/scripts/check-env.sh` reports what is missing.

When a recorded SVG carries figkit's `data-svgfig` marker, the record tool:

1. runs the lint for palette, fonts, minimum size, canvas bounds, box padding, text overlap, contrast and wording, and stores the findings with the figure;
2. converts the text to outlines with `rsvg-convert -f svg`, hashes that copy, and stores it beside the figure, so the page shows the measured layout without the fonts installed;
3. returns a PNG preview as an image in the tool result, so the author can inspect the layout the lint cannot see.

The write tool rejects a `diagram` visual whose figure has lint findings. It embeds the outlined copy after checking both hashes. Plots and other SVG or PNG files are embedded unchanged. Other generators may supply diagrams, but they are not linted.

SVG assets are embedded as images, not active inline SVG. This prevents a diagram from injecting executable markup into the page. Optional `links` overlay accessible HTML anchors on the image. Coordinates are percentages of its full image bounds, including margins. Each link has a short label and a `target` of `section:<section-id>` or `record:<record-id>`. Section targets are `overview` or authored section IDs, not generated sections such as `checks` or `scope`. The renderer also supplies a text link list. Links scale with the image and remain usable by keyboard. The tool rejects unknown targets, non-finite coordinates, non-positive sizes, or regions extending beyond the image. No model-supplied executable or external URLs are accepted as diagram targets.

## Presentation and integrity

The initial reading path is a descriptive title and scope link, a short bottom line, relevant sections and visuals, checks, and material limits. Changed files, scope commit details, exact commands, and routine run metadata are available on demand. Each record heading uses its existing `why` action description, not its command.

Exact commands appear once, inside the expandable record body, in multiline code blocks. Output can have a readable JSON or CSV view, but the stored text remains available and unmodified. Output and evidence quotes that are diffs, whether unified diffs, `grep -n` over a diff, or grep-filtered `+`/`-` lines, are shaded per line: additions blue, deletions vermilion, hunk headers purple, file headers bold. Shading adds tags only; the text content is byte-for-byte the record. A count of added and removed lines precedes the block. Markdown bullet lists and diffstats are not treated as diffs. A prepared output view is not a new observation. Truncated output is labelled. Commands are never rewritten by splitting shell syntax heuristically.

HTML must escape prose, code, output, link labels, and attributes. Only validated local anchors and canonical repository URLs produced by the tool are links. Reports are self-contained and work without a network connection. Repository links are optional; local evidence remains available when no supported remote exists.

The renderer does not automatically add a diffstat chart, global confidence badge, citation-count score, generic alternative explanations, or reader homework. Verification integrity comes from records and precise limits, not a fixed checklist.
