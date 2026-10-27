#!/usr/bin/env bash
# Run a figure script with figkit importable: figkit/run.sh .walkthrough/figs/ladder.py
# Uses uv's cache for uharfbuzz, so nothing is written inside the installed package.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$here${PYTHONPATH:+:$PYTHONPATH}" exec uv run --quiet --no-project --python '>=3.11' --with 'uharfbuzz>=0.40' python "$@"
