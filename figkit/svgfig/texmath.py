"""Typeset LaTeX math with XeLaTeX + unicode-math and convert it to SVG paths.

Each snippet becomes one <g> of glyph outlines. The group keeps the LaTeX
source in data-latex. Placement uses the TeX box (width, height, depth), so the
math baseline sits on the text baseline exactly as TeX would set it.

TeX size is 10bp. Scale by size/10 to match an SVG font-size of `size`.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "agent-walkthrough" / "texmath"
PT_TO_BP = 72.0 / 72.27


@dataclass
class Snippet:
    latex: str
    width: float   # bp at 10bp size
    height: float  # above baseline
    depth: float   # below baseline
    body: str      # SVG markup, origin at the left end of the baseline
    defs: str      # glyph definitions, ids unique to this snippet


def _preamble(math_font: str, text_font: str | None) -> str:
    text = ""
    if text_font:
        # Resolve the family to a file so XeTeX loads the same file the SVG text uses.
        from . import measure
        p = Path(measure.font_file(text_font))
        if "[" in p.name:
            text = f"\\setmainfont{{{text_font}}}\n"
        else:
            text = f"\\setmainfont{{{p.name}}}[Path={p.parent}/]\n"
    return (
        "\\documentclass{article}\n"
        "\\usepackage{fontspec}\n\\usepackage{unicode-math}\n"
        f"{text}\\setmathfont{{{math_font}}}\n"
        "\\hoffset=-1in \\voffset=-1in \\topskip=0pt \\parindent=0pt\n"
        "\\newcommand\\snip[1]{\\setbox0\\hbox{\\fontsize{10bp}{12bp}\\selectfont #1}"
        "\\typeout{SNIP:\\the\\wd0,\\the\\ht0,\\the\\dp0}"
        "\\pdfpagewidth=\\wd0 \\pdfpageheight=\\dimexpr\\ht0+\\dp0\\relax"
        "\\shipout\\vbox{\\box0}}\n"
        "\\begin{document}\n"
    )


def _key(latex: str, display: bool, math_font: str, text_font: str | None) -> str:
    raw = json.dumps([latex, display, math_font, text_font])
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _parse_svg(svg: str, prefix: str) -> tuple[str, str]:
    svg = re.sub(r"<\?xml[^>]*\?>|<!--.*?-->", "", svg, flags=re.S)
    svg = svg.replace("id='", f"id='{prefix}").replace("href='#", f"href='#{prefix}")
    defs = re.search(r"<defs>(.*?)</defs>", svg, re.S)
    page = re.search(r"<g id='[^']*page\d+'>(.*)</g>\s*</svg>", svg, re.S)
    if not page:
        raise RuntimeError("dvisvgm output has no page group")
    return (defs.group(1).strip() if defs else ""), page.group(1).strip()


def typeset(snippets: list[tuple[str, bool]], math_font: str,
            text_font: str | None = None) -> list[Snippet]:
    """snippets: (latex_without_dollars, display). Returns Snippets in order."""
    CACHE.mkdir(parents=True, exist_ok=True)
    keys = [_key(s, d, math_font, text_font) for s, d in snippets]
    todo = [(k, s, d) for k, (s, d) in zip(keys, snippets) if not (CACHE / f"{k}.json").exists()]
    if todo:
        _run(todo, math_font, text_font)
    out = []
    for k in keys:
        d = json.loads((CACHE / f"{k}.json").read_text())
        out.append(Snippet(**d))
    return out


def _run(todo, math_font, text_font):
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        body = "".join(
            f"\\snip{{$\\displaystyle {s}$}}\n" if d else f"\\snip{{${s}$}}\n" for _, s, d in todo)
        (tmp / "m.tex").write_text(_preamble(math_font, text_font) + body + "\\end{document}\n")
        r = subprocess.run(["xelatex", "-no-pdf", "-halt-on-error", "-interaction=nonstopmode", "m.tex"],
                           cwd=tmp, capture_output=True, text=True)
        log = (tmp / "m.log").read_text(errors="replace") if (tmp / "m.log").exists() else r.stdout
        if r.returncode != 0:
            err = re.findall(r"^! .*(?:\n.*){0,3}", log, re.M)
            raise RuntimeError("xelatex failed:\n" + "\n".join(err[:3]))
        metrics = re.findall(r"SNIP:([\d.]+)pt,([\d.]+)pt,([\d.]+)pt", log)
        subprocess.run(["dvisvgm", "--no-fonts", "--bbox=papersize", "--precision=4", "--optimize",
                        "-p1-", "-o", "p-%p.svg", "m.xdv"], cwd=tmp, check=True, capture_output=True)
        pages = sorted(tmp.glob("p-*.svg"), key=lambda p: int(re.search(r"(\d+)", p.stem).group(1)))
        if len(pages) != len(todo) or len(metrics) != len(todo):
            raise RuntimeError("page count mismatch between xelatex and dvisvgm")
        for (k, s, _), page, (w, h, d) in zip(todo, pages, metrics):
            defs, body = _parse_svg(page.read_text(), f"m{k}-")
            w, h, d = (float(v) * PT_TO_BP for v in (w, h, d))
            # dvisvgm puts the page origin at (-72, -72); move the baseline to y=0.
            body = f"<g transform='translate(72 {72 - h:.4f})'>{body}</g>"
            snip = dict(latex=s, width=w, height=h, depth=d, body=body, defs=defs)
            (CACHE / f"{k}.json").write_text(json.dumps(snip))


def place(snip: Snippet, x: float, y: float, size: float, fill: str) -> str:
    """Return a <g> that puts the snippet's baseline origin at (x, y)."""
    s = size / 10.0
    return (f"<g data-latex=\"{html.escape(snip.latex)}\" fill=\"{fill}\" "
            f"transform=\"translate({x:.2f} {y:.2f}) scale({s:.4f})\">{snip.body}</g>")
