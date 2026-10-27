# pi-walkthrough

Walk through a code change in a readable HTML page, with links to its commits and the work behind it. Start with an explanation or a result. Open the exact commands and output when you want to inspect the evidence.

## Install locally

```sh
pi install /path/to/pi-walkthrough
```

Or try the package for one session without installing it:

```sh
pi -e /path/to/pi-walkthrough
```

The package is prepared for npm distribution but has not been published. The intended npm install command is `pi install npm:pi-walkthrough` after publication. A local checkout needs `npm install` first, for KaTeX.

## Choose a walkthrough

In a repository, start Pi and ask:

```text
/walkthrough --mode=verification the last commit
/walkthrough --mode=explanation how the solver builds and evaluates a residual
```

**Verification** demonstrates behavior with relevant examples and checks. It separates observations made during the walkthrough from measurements read from existing benchmark files.

**Explanation** teaches the code, algorithm, architecture, or scientific reasoning. It records the inspected source without implying that code inspection is a passing test. Both modes identify the commits they cover and say whether uncommitted changes are included.

Omit `--mode` to use verification. A walkthrough stays focused on the named change or question, not the entire repository.

## Read the page

The page starts with a descriptive title, scope links, and a short bottom line. Its sections follow the subject rather than a fixed audit form. Equations render with KaTeX, and comparisons render as tables. Diagrams are drawn with the bundled figkit library, linted, and embedded with their text converted to outlines. Plots can be embedded from recorded commands. Important failed checks and limits remain visible.

Pages with three or more sections start with a contents list; on wide screens it stays beside the article. Changed files, commit details, and exact commands are expandable, and the command log has Expand all and Collapse all buttons. Each exact command has a Copy button. Recorded diffs are shaded line by line: additions in blue, deletions in vermilion, and hunk headers in purple. These colors stay distinct with red-green color blindness, and the `+` and `-` markers keep the meaning without color. Each command record starts with a short action description. Long commands keep their line breaks inside the record rather than appearing in the article, captions, or collapsed headings. Readable output views retain the recorded text for inspection.

Output is written to `.walkthrough/<title>.html`, with the evidence log in `.walkthrough/evidence.jsonl` and captured images in `.walkthrough/figs/`. The HTML is self-contained and works offline. A supported GitHub or GitLab remote adds immutable commit, comparison, and source links; local evidence remains accessible when no remote is available.

## Plots and linked diagrams

A visual is optional. Use a plot for numerical behavior, a flowchart for structure or reasoning, and a table when that is easier to read. There is no required plot count or automatic file-churn chart.

Diagrams use the bundled `figkit/` library, adapted from the svg-figs skill. It needs uv, XeLaTeX with dvisvgm, rsvg-convert, and the STIX Two Text, IBM Plex Mono and New Computer Modern Math fonts; run `figkit/scripts/check-env.sh` to see what is missing. Without these tools, walkthroughs still render, using tables in place of diagrams. Every image, including figkit SVG, is embedded as a non-active image. Validated HTML link regions connect diagram nodes to article sections and evidence records, with a text-link alternative for keyboard access.

See [the report format](docs/report-format.md) for the write payload and diagram link coordinates.

## Recording and safety

During a walkthrough, the active tools are `walkthrough_record` and `walkthrough_write`. The first records commands, output, exit status, and captured images. The second checks evidence references, quoted output, and figure hashes before rendering the page. The exact command and stored output are not rewritten for presentation.

The default budget is 20 commands and 5 minutes. Individual commands have a 60-second timeout, configurable up to 120 seconds. Override the overall limits with `WALKTHROUGH_MAX_RECORDS` and `WALKTHROUGH_BUDGET_S`.

Walkthroughs are report-only. The command runner refuses selected destructive Git and deletion commands and protects its own log and page files. It takes working-tree snapshots before and after the walkthrough and reports observed changes. This is **not an operating-system sandbox**: shell commands can still write files, and ignored files are not checked apart from new top-level directories. Run only trusted commands; use an OS sandbox when stronger isolation is needed.

The `at_ref` option runs a command in a temporary detached Git worktree, optionally with selected test files copied in. It can help establish a regression test, but is not required for every change. The worktree borrows `.venv`, `venv`, and `node_modules` when available; other untracked environment files may be missing. An environment failure is reported as blocked verification.

## Under nono

Grant read access to the package and the configuration files Git needs, plus write access to the caches used by plotting tools. For example:

```sh
nono run --profile mit-parley --allow-cwd --workdir "$PWD" \
  --read /path/to/pi-walkthrough --read-file ~/.gitconfig \
  --allow ~/.cache/uv --allow ~/.matplotlib \
  -- pi -e /path/to/pi-walkthrough
```

The nono profile and programs must already exist on the machine. Without access to the package, Pi cannot load it. A Python installation outside the repository may need an additional read grant.

## Development

Node 22.18 or later is required. Tests resolve the host-provided Pi packages from the global installation; set `PI_ROOT` if that installation is elsewhere.

```sh
npm test
npm pack --dry-run
```

Private `.backlog/` tracking, local `.pi/` state, generated reports, and tarballs are ignored. The npm package uses an explicit file allowlist; private tracking is not part of the published package.
