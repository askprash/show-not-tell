# Walkthrough

npm package: `show-not-tell`. In Pi, run it as `/walkthrough`.

Explain a code change in a readable HTML page that links to its commits and to the commands behind each claim. The page leads with the explanation; the exact commands and output are one click away.

## Install

```sh
pi install npm:show-not-tell      # after publication
pi install /path/to/pi-walkthrough
pi -e /path/to/pi-walkthrough     # one session, no install
```

A local checkout needs `npm install` first, for KaTeX.

## Run

In a repository, start Pi and ask:

```text
/walkthrough --mode=verification the last commit
/walkthrough --mode=explanation how the solver builds and evaluates a residual
```

- **Verification** (the default) runs relevant examples and checks. It separates what it observed from numbers read out of committed files.
- **Explanation** teaches the code, algorithm or reasoning. Reading code is recorded as inspection, not as a passing test.

Both modes stay on the named change or question, name the commits they cover, and say whether uncommitted changes are included.

## The page

- A title, scope links and a short bottom line, then sections that follow the subject.
- Equations in KaTeX, comparisons in tables, and diagrams drawn with the bundled figkit library.
- Decisions and commits cited by what they say, linked to the file or commit; their numbers appear only in tooltips and the References list.
- Failed checks and limits stay in the reading path.
- A contents list on pages with three or more sections.
- An expandable command log with Expand all, Collapse all and Copy buttons.
- Diffs shaded per line: additions blue, deletions vermilion. Both stay clear with red-green color blindness, and the `+` and `-` markers carry the meaning without color.

The page is written to `.walkthrough/<title>.html` and works offline. The evidence log is `.walkthrough/evidence.jsonl`, and captured images are in `.walkthrough/figs/`. With a GitHub or GitLab remote, links point to immutable commits.

## Diagrams

figkit is adapted from the svg-figs skill. It needs uv, XeLaTeX with dvisvgm, rsvg-convert, and the STIX Two Text, IBM Plex Mono and New Computer Modern Math fonts. Run `figkit/scripts/check-env.sh` to see what is missing. Without them, walkthroughs still render and use tables in place of diagrams.

Each figkit diagram is linted, previewed for the agent, and embedded as an image with its text converted to outlines. Diagrams can link regions to sections and records. See [the report format](docs/report-format.md) for the payload.

## Recording and safety

During a walkthrough the only tools are `walkthrough_record`, which runs a command and stores its output, and `walkthrough_write`, which checks evidence references, quotes and figure hashes before rendering. Recorded commands and output are never rewritten.

| Limit | Default | Override |
|---|---|---|
| Commands | 20 | `WALKTHROUGH_MAX_RECORDS` |
| Total time | 5 min | `WALKTHROUGH_BUDGET_S` |
| Per command | 60 s, up to 120 s | `timeout_s` |

Walkthroughs are report-only. The runner refuses destructive Git and deletion commands, protects its own files, and reports working-tree changes from before-and-after snapshots. **It is not a sandbox**: commands can still write files, and ignored files are not checked. Use an OS sandbox when you need isolation.

`at_ref` runs a command in a temporary Git worktree, optionally with test files copied in, to show that a new test fails on the old code. The worktree borrows `.venv`, `venv` and `node_modules`; other untracked environment files may be missing.

## Under nono

Grant read access to the package and Git's configuration, and write access to the caches that figures use:

```sh
nono run --profile mit-parley --allow-cwd --workdir "$PWD" \
  --read /path/to/pi-walkthrough --read-file ~/.gitconfig \
  --allow ~/.cache/uv --allow ~/.cache/agent-walkthrough --allow ~/.matplotlib \
  -- pi -e /path/to/pi-walkthrough
```

A Python installation outside the repository may need another read grant.

## Development

Requires Node 22.18 or later. Tests load the host Pi packages from the global install; set `PI_ROOT` if it is elsewhere.

```sh
npm test
npm pack --dry-run
```

npm publishes only the paths in the `files` allowlist: `extensions/`, `skills/`, `docs/`, `figkit/`, the README and the license.
