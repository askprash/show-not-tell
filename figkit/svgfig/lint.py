"""Check an SVG against tokens.json. Run: python -m svgfig.lint FILE.svg [...]

Checks:
  color     every fill/stroke is a palette color (or none)
  font      every font-family is in the font profile and installed
  size      no text smaller than the target minimum
  bounds    no ink outside the canvas
  padding   text inside a box keeps the box padding from every edge
  overlap   no two text runs overlap
  contrast  text against the box (or background) under it is at least 4.5:1
  words     figure text: banned words and labels that are too long (see words.txt)

The file must not transform <text> elements. Math groups carry data-ink.
"""
from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from . import measure
from .fig import TOKENS, ROOT

NS = "{http://www.w3.org/2000/svg}"
TOL = 1.0  # px or bp: advance width vs ink, and rounding


def _hex(c):
    c = c.strip().lower()
    if re.fullmatch(r"#[0-9a-f]{3}", c):
        c = "#" + "".join(ch * 2 for ch in c[1:])
    return c


def _lum(h):
    def lin(v):
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(int(h[i:i + 2], 16) / 255) for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted([_lum(a), _lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def _palette_colors(p):
    out = {p[k] for k in ("bg", "panel", "ink", "ink2", "muted", "rule", "emph", "line")}
    for c in p["cat"]:
        out |= set(c.values())
    return {_hex(c) for c in out} | {"#ffffff"}


def _words():
    banned, phrases = set(), []
    for ln in (ROOT / "words.txt").read_text().splitlines():
        ln = ln.split("#")[0].strip().lower()
        if not ln:
            continue
        (phrases.append(ln) if " " in ln else banned.add(ln))
    return banned, phrases


def lint_file(path) -> list[str]:
    path = Path(path)
    root = ET.parse(path).getroot()
    meta = json.loads(root.get("data-svgfig", "{}"))
    target = meta.get("target", "deck")
    t = TOKENS["targets"][target]
    pal_name = meta.get("palette", TOKENS["palettes"]["default"]["light"])
    p = TOKENS["palettes"]["profiles"][pal_name]
    fonts = TOKENS["fonts"]["profiles"][meta.get("fonts", TOKENS["fonts"]["default"])]
    vb = [float(v) for v in root.get("viewBox", "0 0 0 0").split()]
    W, H = vb[2], vb[3]
    pad = t["space"]["pad"]
    allowed = _palette_colors(p)
    families = {fonts[k] for k in ("heading", "label", "mono")}
    out = []

    rects, texts, plain = [], [], []
    parent = {c: e for e in root.iter() for c in e}

    def in_defs(e):
        while e in parent:
            e = parent[e]
            if e.tag == NS + "defs":
                return True
        return False

    def in_math(e):
        while e in parent:
            e = parent[e]
            if e.get("data-latex") is not None:
                return True
        return False

    for e in root.iter():
        tag = e.tag.replace(NS, "")
        # color
        for attr in ("fill", "stroke"):
            v = e.get(attr)
            if v and not in_defs(e) and v not in ("none", "currentColor") and not v.startswith("url("):
                if _hex(v) not in allowed:
                    out.append(f"color: {tag} {attr}={v} is not in palette {pal_name}")
        if tag == "rect" and not in_defs(e):
            x, y = float(e.get("x", 0)), float(e.get("y", 0))
            w, h = float(e.get("width", 0)), float(e.get("height", 0))
            sw = float(e.get("stroke-width", 0)) if e.get("stroke", "none") != "none" else 0
            if w > 0 and h > 0:
                rects.append(dict(box=(x + sw / 2, y + sw / 2, x + w - sw / 2, y + h - sw / 2),
                                  fill=_hex(e.get("fill", "#000000")),
                                  bordered=sw > 0, full=(w >= W and h >= H)))
        if tag == "text" and not in_defs(e):
            if e.get("transform"):
                out.append(f"text: cannot check transformed text '{''.join(e.itertext())[:30]}'")
                continue
            s = "".join(e.itertext())
            fam = e.get("font-family", "").split(",")[0].strip().strip("'\"")
            size = float(e.get("font-size", 0))
            wt = {"normal": "regular", "500": "medium", "600": "semibold", "bold": "bold", "700": "bold"}.get(
                e.get("font-weight", "normal"), "regular")
            if fam not in families:
                out.append(f"font: '{fam}' is not in the font profile ('{s[:30]}')")
                plain.append(s)
                continue
            try:
                x0, x1, asc, desc = measure.ink(s, fam, size, wt)
                adv = measure.width(s, fam, size, wt)
            except RuntimeError as err:
                out.append(f"font: {err}")
                plain.append(s)
                continue
            x, y = float(e.get("x", 0)), float(e.get("y", 0))
            x -= {"start": 0, "middle": adv / 2, "end": adv}[e.get("text-anchor", "start")]
            texts.append(dict(s=s, size=size, fill=_hex(e.get("fill", "#000000")),
                              box=(x + x0, y - asc, x + x1, y + desc)))
        if tag == "g" and e.get("data-ink") and not in_defs(e):
            x0, y0, x1, y1 = (float(v) for v in e.get("data-ink").split())
            m = re.search(r"scale\(([\d.]+)\)", e.get("transform", ""))
            texts.append(dict(s="$" + e.get("data-latex") + "$", size=10 * float(m.group(1)) if m else 0,
                              fill=_hex(e.get("fill", "#000000")), box=(x0, y0, x1, y1)))
        if tag in ("path", "use") and in_math(e):
            continue

    for tx in texts:
        x0, y0, x1, y1 = tx["box"]
        label = tx["s"].strip()[:40]
        # size: math scripts are smaller by design, so check math at the run size only
        if tx["size"] and tx["size"] < t["min_font"] - 1e-6:
            out.append(f"size: '{label}' is {tx['size']:g} {t['unit']}, min {t['min_font']}")
        if x0 < -TOL or y0 < -TOL or x1 > W + TOL or y1 > H + TOL:
            out.append(f"bounds: '{label}' is outside the canvas")
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        under = [r for r in rects if r["box"][0] <= cx <= r["box"][2] and r["box"][1] <= cy <= r["box"][3]]
        for r in under:
            if not r["bordered"] or r["full"]:
                continue
            bx0, by0, bx1, by1 = r["box"]
            gaps = dict(left=x0 - bx0, right=bx1 - x1, top=y0 - by0, bottom=by1 - y1)
            side, g = min(gaps.items(), key=lambda kv: kv[1])
            if g < pad - TOL:
                what = "crosses" if g < 0 else f"is {g:.1f} from"
                out.append(f"padding: '{label}' {what} the {side} edge of its box (min {pad})")
        bg = under[-1]["fill"] if under else _hex(p["bg"])
        if tx["fill"].startswith("#") and len(tx["fill"]) == 7 and len(bg) == 7:
            c = contrast(tx["fill"], bg)
            if c < 4.5:
                out.append(f"contrast: '{label}' is {c:.2f}:1 on {bg}, min 4.5")

    for i, a in enumerate(texts):
        for b in texts[i + 1:]:
            ax0, ay0, ax1, ay1 = a["box"]
            bx0, by0, bx1, by1 = b["box"]
            ox, oy = min(ax1, bx1) - max(ax0, bx0), min(ay1, by1) - max(ay0, by0)
            if ox > TOL and oy > TOL:
                out.append(f"overlap: '{a['s'].strip()[:30]}' and '{b['s'].strip()[:30]}'")

    out += check_words([tx["s"] for tx in texts if not tx["s"].startswith("$")] + plain)
    return out


def check_words(strings: list[str]) -> list[str]:
    """Plain-language check for figure text. Labels are fragments, so only word
    choice and length are checked."""
    banned, phrases = _words()
    out = []
    # Join runs that were split around inline math, line by line, is not possible here;
    # check each run on its own.
    for s in strings:
        low = s.lower()
        for w in re.findall(r"[a-z][a-z'-]*", low):
            if w in banned:
                out.append(f"words: '{w}' in '{s.strip()[:40]}'")
        for ph in phrases:
            if re.search(r"\b" + re.escape(ph) + r"\b", low):
                out.append(f"words: '{ph}' in '{s.strip()[:40]}'")
        n = len(re.findall(r"\S+", s))
        if n > 20:
            out.append(f"words: {n} words in one line, max 20: '{s.strip()[:40]}'")
        if "!" in s:
            out.append(f"words: no exclamation marks: '{s.strip()[:40]}'")
    return out


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    bad = 0
    for f in argv:
        res = lint_file(f)
        print(f"{f}: {len(res)} findings")
        for r in res:
            print("  " + r)
        bad += bool(res)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
