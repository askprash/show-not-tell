# pi-walkthrough

Writes an HTML walkthrough of your latest feature in under five minutes. Every command and output on the page was run and recorded by a tool, not typed by the model.

## Install

```sh
pi install npm:pi-walkthrough        # after it is published (not yet)
pi install /path/to/walkthrough      # from a local copy
pi -e /path/to/walkthrough/extensions/walkthrough.ts --skill /path/to/walkthrough/skills/walkthrough   # one run, nothing installed
```

## Use

Start `pi` in your repository and type `/walkthrough <feature>`, for example `/walkthrough the last commit`. In print mode, run `pi -p "/walkthrough the last commit"`.

The page lands in `.walkthrough/<title>.html`, with the evidence log in `.walkthrough/evidence.jsonl` and figures in `.walkthrough/figs/`. The folder has its own `.gitignore`, so it stays out of `git status`.

## What it produces

Seven sections in a fixed order (Claim, Map, Evidence, Checks changed, Could it be wrong?, Not verified, What the result depends on). A plot from a recorded run sits under the Claim. The Map has a bar chart of lines added and deleted per file, drawn by the tool from the recorded diffstat. The evidence log lists every command the agent ran, marked with where the page cites it.

## What it allows and refuses

Once `/walkthrough` starts, the session has two tools, `walkthrough_record` and `walkthrough_write`. An allowlist leaves nothing to forget, and with no `bash`, `write` or `edit` the model has no path to the page or the log. The cost is that reading code spends records, so the budget is 20 commands, 60 s each, 5 minutes in total.

`walkthrough_record` runs `bash -c`, so a command can still write files. It refuses commits, pushes, resets, checkouts, stashes and `rm -r`/`rm -f`, and anything that writes under `.walkthrough/` outside `figs/`. Every other change is recorded and reported. The tool takes `git status` before the first command and again when the page is written, and the page header says either "Working tree unchanged during the walkthrough" or lists the files that changed. Files git ignores are not checked, except for new top-level directories.

Settings are `WALKTHROUGH_MAX_RECORDS` (default 20) and `WALKTHROUGH_BUDGET_S` (default 300).

## Under nono

```sh
nono run --profile mit-parley --allow-cwd --workdir "$PWD" --read /path/to/walkthrough --read-file ~/.gitconfig --allow ~/.cache/uv --allow ~/.matplotlib -- pi -e /path/to/walkthrough/extensions/walkthrough.ts --skill /path/to/walkthrough/skills/walkthrough
```

Without `--read`, pi does not load the package and gives no warning. Without `~/.gitconfig`, every `git` command fails. Without `--allow ~/.cache/uv` (read and write, since uv locks its cache), `uv run --with matplotlib` fails and the plots fall back to plain SVG. Without `--allow ~/.matplotlib`, matplotlib rebuilds its font cache on every run, which took 20 to 32 s in testing. Create the folder first with `mkdir -p ~/.matplotlib`, since nono skips paths that do not exist. A repository without a `.venv` also needs `--read ~/.local/share/uv`, or uv cannot find Python and the plots fall back to plain SVG. Add `--read-file` for any program outside the repository that your tests call.

## If a run stalls

In testing, 2 of 16 runs stalled on a model request, which can push a run past 5 minutes. As an optional guard, put this line in `.pi/settings.json` in the repository, so pi gives up on a silent request after 60 s and retries it:

```json
{ "httpIdleTimeoutMs": 60000 }
```

In a 5-minute window, if there is no page after about 4 minutes, switch to the demo page. Do not restart, since a fresh run needs 2.5 to 3.5 minutes.

Use interactive `pi`. Print mode (`pi -p`) shows nothing for about 3 minutes, until the page is written.

Smoke test with `npm test` (Node 22.18 or later).
