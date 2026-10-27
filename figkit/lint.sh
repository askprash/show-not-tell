#!/usr/bin/env bash
# Lint SVG files against figkit tokens: figkit/lint.sh a.svg [b.svg ...]. Exit 1 on any finding.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$here/run.sh" -m svgfig.lint "$@"
