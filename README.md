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

During a walkthrough the only tools are `walkthrough_record`, which runs a command and stores its output, and `walkthrough_write`, which checks evidence references, quotes and figure hashes before rendering. Recorded commands and output are never rewritten. Once the page is written, the session gets its previous tools back.

| Limit | Default | Per run | Per session |
|---|---|---|---|
| Commands | 20 | `--records=40` | `/walkthrough-limits records=40` |
| Total time | 5 min | `--time=15m` | `/walkthrough-limits time=15m` |
| Per command | 60 s, up to 120 s | set by the agent | |

Plain phrases work too: `/walkthrough the last commit, use up to 40 commands and take 15 minutes`. Without the slash command, ask in plain language ("walk me through the last commit, take 15 minutes") and the agent calls `walkthrough_start` with those limits; "from now on" sets them for the session. Per-run options override the session default, which overrides `WALKTHROUGH_MAX_RECORDS` and `WALKTHROUGH_BUDGET_S`. `/walkthrough-limits` with no arguments shows the current budget, and `reset` returns to the defaults. A walkthrough cannot change its own budget, and the page records the budget it ran under.

Walkthroughs are report-only. The runner refuses destructive Git and deletion commands, protects its own files, and reports working-tree changes from before-and-after snapshots. **It is not a sandbox**: commands can still write files, and ignored files are not checked. Use an OS sandbox when you need isolation.

`at_ref` runs a command in a temporary Git worktree, optionally with test files copied in, to show that a new test fails on the old code. The worktree borrows `.venv`, `venv` and `node_modules`; other untracked environment files may be missing.

## Under nono

Your Pi profile for [nono](https://nono.sh) must grant the project folder and `~/.pi/agent`, where `pi install npm:show-not-tell` puts the package. A walkthrough also needs:

| Grant | Why |
|---|---|
| `--read-file ~/.gitconfig` | Git reads it on every command |
| `--read <main repo>/.git` | only when the project is a Git worktree; its `.git` file points there |
| `--read /path/to/pi-walkthrough` | only for `pi -e` from a local checkout |
| `--allow ~/.matplotlib` | only for matplotlib plots |

figkit diagrams also need uv's Python, the TeX installation, the fonts, and write access to their caches:

```sh
nono run --profile <your-pi-profile> --allow-cwd --workdir "$PWD" \
  --read-file ~/.gitconfig \
  --read ~/.local/share/uv --allow ~/.cache/uv \
  --read /Library/TeX --read /usr/local/texlive --allow ~/Library/texlive \
  --read ~/Library/Fonts --allow ~/.cache/fontconfig \
  --allow ~/.cache/agent-walkthrough \
  -- pi
```

The TeX paths are for MacTeX on macOS; on Linux, grant your TeX Live directory and `~/.texlive*`. Without the figkit grants, `figkit/scripts/check-env.sh` fails inside the sandbox and walkthroughs use tables in place of diagrams. `nono run --dry-run` lists the resulting grants without running anything.

## Development

Requires Node 22.18 or later. Tests load the host Pi packages from the global install; set `PI_ROOT` if it is elsewhere.

```sh
npm test
npm pack --dry-run
```

npm publishes only the paths in the `files` allowlist: `extensions/`, `skills/`, `docs/`, `figkit/`, the README and the license.
