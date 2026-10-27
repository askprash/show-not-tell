#!/usr/bin/env bash
# Report missing tools and fonts for the default font profile. Exit 1 if anything is missing.
ok=0
for t in xelatex dvisvgm rsvg-convert fc-match uv; do
  command -v "$t" >/dev/null || { echo "missing tool: $t"; ok=1; }
done
for f in "STIX Two Text" "IBM Plex Mono"; do
  fc-match -f '%{family}' "$f" | grep -qi "${f%% *}" || { echo "missing font: $f (brew install --cask font-stix font-ibm-plex-mono)"; ok=1; }
done
kpsewhich NewCMMath-Book.otf >/dev/null || { echo "missing TeX font: NewCMMath-Book.otf (tlmgr install newcomputermodern)"; ok=1; }
[ $ok = 0 ] && echo "figkit: environment ok"
exit $ok
