# Walkthrough report format

The report teaches a reader who was not present during the work. The exact command log is supporting evidence, not the article.

## Modes

`/walkthrough --mode=verification <scope>` checks what the change does. This is the default. Run relevant examples and tests when practical. Distinguish observations made in this walkthrough from measurements read from committed files. A parent-version test is useful for a regression fix, not a universal requirement for new coverage.

`/walkthrough --mode=explanation <scope>` explains code, algorithms, scientific reasoning, or architecture. Inspect source through recorded commands. Do not imply that reading code establishes runtime correctness. Tests and plots are optional when they answer the reader's question.

Both modes are report-only. Both resolve Git scope and retain recorded sources. Neither requires a fixed number of sections or visuals.

## Data

`extensions/report-types.ts` is the shared TypeScript contract. The write tool accepts the fields of `WritePayload`, either together or across calls. `title`, `mode`, `scope`, `summary`, and `sections` define the article. Empty `checks`, `limits`, `changes`, and `visuals` arrays are valid; the tool supplies those defaults. The old seven-section payload is replaced, not maintained as a second report format.

- `scope` supplies a descriptive label and Git head, optionally a comparison base. The tool resolves immutable commits from the repository. With no base, the scope is that single commit. An unavailable Git ref is reported, not guessed. `include_working_tree` explicitly declares whether uncommitted content is included.
- `sections` are ordered, plain-text paragraphs with reader-chosen headings. IDs use lowercase letters, digits, and hyphens, begin with a letter, and cannot collide with reserved IDs `overview`, `checks`, `limits`, `changes`, `scope`, `log`, `technical`, or record IDs. Evidence items carry a record ID, a short observation, and optionally a verbatim output excerpt. The renderer must not repeat the full command here.
- `checks` distinguish passed, failed, blocked, not-run, and inspected. Executed or inspected checks cite records. Exit zero alone is not a passing scientific or test result.
- `limits` state material uncertainty once. Failed runs and report-only refusals are automatically included when not already represented. Important limits are not hidden in the appendix.
- `changes` contain one actual repository-relative path per entry. They are not glob patterns or comma-separated groups. File links, when available, use the resolved head commit.
- `visuals` name image files captured by a record. The tool checks the captured file's hash before embedding it. `section_id` defaults to `overview`. The first visual is not silently moved to another section. A plot explains a numerical result; a diagram explains structure or reasoning. Captions explain what the image means, not how its command was launched.

## Linked diagrams

An author can create a diagram with the svg-figs skill when that skill is available, run its lint, and inspect its PNG. The package does not require that machine-local library at runtime. Other diagram generators may also supply recorded SVG or PNG assets.

SVG assets are embedded as images, not active inline SVG. This prevents a diagram from injecting executable markup into the page. Optional `links` overlay accessible HTML anchors on the image. Coordinates are percentages of its full image bounds, including margins. Each link has a short label and a `target` of `section:<section-id>` or `record:<record-id>`. The renderer also supplies a text link list. Links scale with the image and remain usable by keyboard. The tool rejects unknown targets, non-finite coordinates, non-positive sizes, or regions extending beyond the image. No model-supplied executable or external URLs are accepted as diagram targets.

## Presentation and integrity

The initial reading path is a descriptive title and scope link, a short bottom line, relevant sections and visuals, checks, and material limits. Changed files, scope commit details, exact commands, and routine run metadata are available on demand. Each record heading uses its existing `why` action description, not its command.

Exact commands appear once, inside the expandable record body, in multiline code blocks. Output can have a readable JSON or CSV view, but the stored text remains available and unmodified. A prepared output view is not a new observation. Truncated output is labelled. Commands are never rewritten by splitting shell syntax heuristically.

HTML must escape prose, code, output, link labels, and attributes. Only validated local anchors and canonical repository URLs produced by the tool are links. Reports are self-contained and work without a network connection. Repository links are optional; local evidence remains available when no supported remote exists.

The renderer does not automatically add a diffstat chart, global confidence badge, citation-count score, generic alternative explanations, or reader homework. Verification integrity comes from records and precise limits, not a fixed checklist.
