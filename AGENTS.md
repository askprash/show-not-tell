# pi-walkthrough contributor rules

This package produces readable, source-linked walkthroughs for people who were not present during the work.

- Keep the explanation separate from the exact command log. Never modify recorded commands or output to make a claim look stronger.
- Verification mode reports observed checks. Explanation mode teaches code and reasoning without implying that inspection is a passing test.
- Resolve scope to immutable Git commits. Use descriptive labels for links; keep hashes in technical details.
- Keep important failures and unverified claims visible. Do not require a fixed number of sections, plots, tests, or diagrams.
- Preserve the recording tools' evidence-reference, quote, figure-integrity, budget, timeout, worktree-cleanup, and working-tree checks.
- Reports must work offline. Never inline untrusted active SVG or allow executable URLs in report links.
- Use the svg-figs skill when authoring diagram assets. Do not make that local skill a required runtime dependency of the npm package.
- Keep local paths, credentials, generated reports, and private task data out of Git and the npm tarball.
- If `.backlog/` exists and the `backlog` CLI is installed, read `backlog instructions overview`. Modify task records only through that CLI.

Verification:

```sh
npm test
npm pack --dry-run
```

Inspect generated HTML in a browser at desktop and narrow widths when changing the renderer. Use a fresh reader to check that the bottom line, checked results, and limits make sense without session context.
