"""Build SVG figures from tokens.json: measured text, LaTeX math, boxes, arrows.

    from svgfig import Figure
    f = Figure()                            # "web" (report column); or "deck", "paper"
    a = f.node(80, 240, ["Skill", "reads $\\mathrm{SKILL.md}$"], cat=0)
    b = f.node(a.x1 + 120, 240, ["Tool", "returns $C_L$"], cat=1)
    f.arrow(a.r, b.l)
    f.save("flow.svg")                       # writes flow.svg and flow.png, prints lint findings

Coordinates are in the target unit (px for deck, bp for paper). y is a baseline
for text and math, and a top edge for boxes.
"""
from __future__ import annotations

import html
import json
import math as _m
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import measure, texmath

ROOT = Path(__file__).resolve().parent.parent
TOKENS = json.loads((ROOT / "tokens.json").read_text())
CSS_WEIGHT = {"regular": "normal", "medium": "500", "semibold": "600", "bold": "bold"}


@dataclass
class Node:
    x: float
    y: float
    w: float
    h: float

    @property
    def x1(self):
        return self.x + self.w

    @property
    def y1(self):
        return self.y + self.h

    @property
    def cx(self):
        return self.x + self.w / 2

    @property
    def cy(self):
        return self.y + self.h / 2

    # Edge midpoints, for arrows. Use at() for other points on an edge.
    @property
    def l(self):
        return (self.x, self.cy)

    @property
    def r(self):
        return (self.x1, self.cy)

    @property
    def t(self):
        return (self.cx, self.y)

    @property
    def b(self):
        return (self.cx, self.y1)

    def at(self, side: str, f: float = 0.5):
        """Point on an edge. f runs 0..1 from left to right, or top to bottom."""
        return {"l": (self.x, self.y + f * self.h), "r": (self.x1, self.y + f * self.h),
                "t": (self.x + f * self.w, self.y), "b": (self.x + f * self.w, self.y1)}[side]


class Figure:
    def __init__(self, target: str = "web", mode: str = "light", palette: str = "default",
                 fonts: str | None = None, width: float | None = None, height: float | None = None):
        t = TOKENS["targets"][target]
        self.target, self.mode, self.t = target, mode, t
        self.palette_name = TOKENS["palettes"][palette][mode]
        self.p = TOKENS["palettes"]["profiles"][self.palette_name]
        self.fonts_name = fonts or TOKENS["fonts"]["default"]
        self.fonts = TOKENS["fonts"]["profiles"][self.fonts_name]
        self.w = width or t["width"]
        # Height 0 (the web default) fits the canvas to the content plus the target margin.
        self.fixed_h = height if height is not None else t["height"]
        self.h = self.fixed_h
        self.ymax = 0.0
        self.els: list[str] = []
        self.defs: dict[str, str] = {}

    # -- tokens -----------------------------------------------------------
    def color(self, role: str) -> str:
        """ink, ink2, muted, rule, bg, panel, emph, line, catN (= catN.text), catN.fill, catN.stroke,
        or a literal #hex."""
        if role.startswith("#"):
            return role
        m = re.fullmatch(r"cat(\d)(?:\.(fill|stroke|text))?", role)
        if m:
            return self.p["cat"][int(m.group(1))][m.group(2) or "text"]
        return self.p[role]

    def style(self, name: str) -> dict:
        return self.t["styles"][name]

    def _family(self, s):
        return self.fonts[s["font"]]

    # -- math -------------------------------------------------------------
    def _snips(self, items):
        return texmath.typeset(items, self.fonts["math"], self.fonts.get("mathtext"))

    def math(self, x: float, y: float, latex: str, style: str = "label", color: str = "ink",
             anchor: str = "start", display: bool = True, size: float | None = None) -> float:
        """LaTeX math (no $ signs) with its baseline at y. Returns the width."""
        size = size or self.style(style)["size"]
        sn = self._snips([(latex, display)])[0]
        k = size / 10.0
        w = sn.width * k
        x -= {"start": 0, "middle": w / 2, "end": w}[anchor]
        self.defs["m:" + sn.latex + str(display)] = sn.defs
        ink = f"{x:.2f} {y - sn.height * k:.2f} {x + w:.2f} {y + sn.depth * k:.2f}"
        self._grow(y + sn.depth * k)
        self.els.append(f'<g data-latex="{html.escape(sn.latex)}" data-ink="{ink}" fill="{self.color(color)}" '
                        f'transform="translate({x:.2f} {y:.2f}) scale({k:.4f})">{sn.body}</g>')
        return w

    # -- text -------------------------------------------------------------
    @staticmethod
    def _parts(s):
        return [p for p in re.split(r"(\$[^$]+\$)", s) if p]

    def width(self, s: str, style: str = "label") -> float:
        st = self.style(style)
        parts = self._parts(s)
        maths = [(p[1:-1], False) for p in parts if p.startswith("$")]
        it = iter(self._snips(maths)) if maths else iter(())
        w = 0.0
        for p in parts:
            w += (next(it).width * st["size"] / 10 if p.startswith("$")
                  else measure.width(p, self._family(st), st["size"], st["weight"]))
        return w

    def text(self, x: float, y: float, s: str, style: str = "label", color: str = "ink2",
             anchor: str = "start") -> float:
        """One line with optional inline $math$, baseline at y. Returns the width."""
        st = self.style(style)
        fam, size, wt = self._family(st), st["size"], st["weight"]
        w = self.width(s, style)
        cx = x - {"start": 0, "middle": w / 2, "end": w}[anchor]
        fill = self.color(color)
        self._grow(y + self._desc(style))
        for p in self._parts(s):
            if p.startswith("$"):
                cx += self.math(cx, y, p[1:-1], style, color, display=False)
                continue
            self.els.append(f'<text x="{cx:.2f}" y="{y:.2f}" font-family="{fam}" font-size="{size}" '
                            f'font-weight="{CSS_WEIGHT[wt]}" fill="{fill}" xml:space="preserve">'
                            f'{html.escape(p)}</text>')
            cx += measure.width(p, fam, size, wt)
        return w

    def lines(self, x: float, y: float, rows: list, style: str = "label", color: str = "ink2",
              anchor: str = "start") -> float:
        """Several lines. rows: str or (str, style, color). Returns the last baseline."""
        rows = [(r, style, color) if isinstance(r, str) else r for r in rows]
        for i, (s, st, c) in enumerate(rows):
            if i:
                y += self.style(st)["size"] * self.t["space"]["line_gap"]
            if s:
                self.text(x, y, s, st, c, anchor)
        return y

    # -- boxes ------------------------------------------------------------
    def box(self, x: float, y: float, w: float, h: float, cat: int | None = None,
            fill: str | None = None, stroke: str | None = None) -> Node:
        """Tinted box for category cat, or a neutral panel when cat is None."""
        ln = self.t["line"]
        f = fill or (self.color(f"cat{cat}.fill") if cat is not None else self.p["panel"])
        s = stroke or (self.color(f"cat{cat}.stroke") if cat is not None else self.p["rule"])
        self._grow(y + h)
        self.els.append(f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" '
                        f'rx="{ln["box_radius"]}" fill="{self.color(f)}" stroke="{self.color(s)}" '
                        f'stroke-width="{ln["border"]}"/>')
        return Node(x, y, w, h)

    def _rows(self, rows, cat):
        hc = f"cat{cat}" if cat is not None else "ink"
        return [(r, "heading" if i == 0 else "label", hc if i == 0 else "ink2") if isinstance(r, str) else r
                for i, r in enumerate(rows)]

    def size(self, rows: list, cat: int | None = None, w: float | None = None,
             h: float | None = None) -> tuple[float, float]:
        """(width, height) that node() would draw for these rows, without drawing it.
        Use it to plan a layout or to give several nodes one size."""
        pad = self.t["space"]["pad"]
        rows = self._rows(rows, cat)
        tw = max(self.width(s, st) for s, st, _ in rows)
        top = self._row_ink(rows[0][0], rows[0][1])[0]
        gaps = [self.style(st)["size"] * self.t["space"]["line_gap"] for _, st, _ in rows[1:]]
        bot = self._row_ink(rows[-1][0], rows[-1][1])[1]
        return (max(w or 0, tw + 2 * pad), max(h or 0, pad + top + sum(gaps) + bot + pad))

    def node(self, x: float, y: float, rows: list, cat: int | None = None, w: float | None = None,
             h: float | None = None, align: str = "start") -> Node:
        """A box sized to its text. The first row is a heading in the category color; the
        other rows are labels in ink2. Pass (str, style, color) to override a row.
        w and h are minimums. align: start or middle."""
        pad = self.t["space"]["pad"]
        rows = self._rows(rows, cat)
        bw, bh = self.size(rows, cat, w, h)
        top = self._row_ink(rows[0][0], rows[0][1])[0]
        bot = self._row_ink(rows[-1][0], rows[-1][1])[1]
        gaps = [self.style(st)["size"] * self.t["space"]["line_gap"] for _, st, _ in rows[1:]]
        n = self.box(x, y, bw, bh, cat)
        y0 = y + (bh - (top + sum(gaps) + bot)) / 2 + top
        tx = x + pad if align == "start" else x + bw / 2
        self.lines(tx, y0, rows, anchor=align)
        return n

    def _cap(self, style):
        st = self.style(style)
        return measure.ink("H", self._family(st), st["size"], st["weight"])[2]

    def _row_ink(self, s, style):
        """(ascent, descent) of a row: font ascenders and descenders, or taller inline math."""
        a, d = self._asc(style), self._desc(style)
        maths = [(p[1:-1], False) for p in self._parts(s) if p.startswith("$")]
        if maths:
            k = self.style(style)["size"] / 10
            for sn in self._snips(maths):
                a, d = max(a, sn.height * k), max(d, sn.depth * k)
        return a, d

    def _asc(self, style):
        # Ascenders (d, l, k) rise above the cap height; boxes must clear them.
        st = self.style(style)
        return measure.ink("Hdlbk", self._family(st), st["size"], st["weight"])[2]

    def _desc(self, style):
        st = self.style(style)
        return measure.ink("gp", self._family(st), st["size"], st["weight"])[3]

    # -- lines and arrows -------------------------------------------------
    def line(self, a, b, color: str = "rule", width: float | None = None, dash: str | None = None):
        sw = width or self.t["line"]["rule"]
        self._grow(max(a[1], b[1]))
        ds = f' stroke-dasharray="{dash}"' if dash else ""
        self.els.append(f'<line x1="{a[0]:.2f}" y1="{a[1]:.2f}" x2="{b[0]:.2f}" y2="{b[1]:.2f}" '
                        f'stroke="{self.color(color)}" stroke-width="{sw}"{ds}/>')

    def _head(self, tip, angle, color):
        ln = self.t["line"]
        L, hw = ln["head_length"], ln["head_half_width"]
        ca, sa = _m.cos(angle), _m.sin(angle)
        pts = [(tip[0] + u * ca * L - v * sa * L, tip[1] + u * sa * L + v * ca * L)
               for u, v in ((0, 0), (-1, hw), (-1, -hw))]
        self.els.append(f'<path d="M{" L".join(f"{x:.2f},{y:.2f}" for x, y in pts)} Z" fill="{color}"/>')
        # The shaft stops inside the head, so no line shows past the tip.
        return (tip[0] - ca * 0.6 * L, tip[1] - sa * 0.6 * L)

    def connector(self, pts, color: str = "ink2", both: bool = False, dash: str | None = None,
                  gap: float | None = None, width: float | None = None, radius: float | None = None):
        """Polyline through pts with rounded corners and a triangle head on the last point.
        Use orthogonal points for routed connectors. gap moves both ends off the boxes."""
        ln = self.t["line"]
        col, sw = self.color(color), width or ln["arrow"]
        rad = ln["connector_radius"] if radius is None else radius
        g = self.t["space"]["pad"] * 0.25 if gap is None else gap
        pts = [tuple(map(float, p)) for p in pts]
        # Drop repeated and collinear points: a zero-length leg has no corner to round.
        pts = [p for i, p in enumerate(pts) if i == 0 or _m.dist(p, pts[i - 1]) > 1e-6]
        pts = [p for i, p in enumerate(pts) if i in (0, len(pts) - 1) or
               abs((p[0] - pts[i - 1][0]) * (pts[i + 1][1] - p[1]) - (p[1] - pts[i - 1][1]) * (pts[i + 1][0] - p[0])) > 1e-6]
        if len(pts) < 2:
            raise ValueError("connector needs two distinct points")
        self._grow(max(p[1] for p in pts))
        pts[0] = _toward(pts[0], pts[1], g)
        pts[-1] = _toward(pts[-1], pts[-2], g)
        start = len(self.els)
        pts[-1] = self._head(pts[-1], _ang(pts[-2], pts[-1]), col)
        if both:
            pts[0] = self._head(pts[0], _ang(pts[1], pts[0]), col)
        d = f"M{pts[0][0]:.2f},{pts[0][1]:.2f}"
        for p0, p1, p2 in zip(pts, pts[1:], pts[2:]):
            l1, l2 = _m.dist(p0, p1), _m.dist(p1, p2)
            r = min(rad, l1 / 2, l2 / 2)
            a = (p1[0] + (p0[0] - p1[0]) * r / l1, p1[1] + (p0[1] - p1[1]) * r / l1)
            b = (p1[0] + (p2[0] - p1[0]) * r / l2, p1[1] + (p2[1] - p1[1]) * r / l2)
            sweep = 1 if (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0]) > 0 else 0
            d += f" L{a[0]:.2f},{a[1]:.2f} A{r:.2f},{r:.2f} 0 0 {sweep} {b[0]:.2f},{b[1]:.2f}"
        d += f" L{pts[-1][0]:.2f},{pts[-1][1]:.2f}"
        ds = f' stroke-dasharray="{dash}"' if dash else ""
        self.els.insert(start, f'<path d="{d}" fill="none" stroke="{col}" stroke-width="{sw}" '
                               f'stroke-linejoin="round"{ds}/>')

    def arrow(self, a, b, color: str = "ink2", **kw):
        self.connector([a, b], color, **kw)

    def tag(self, x: float, y: float, s: str, style: str = "small", color: str = "muted",
            anchor: str = "middle") -> float:
        """A short label on a connector, such as "yes" or "diverged", centred on (x, y)
        over a background patch so the line does not run through it. Returns the width."""
        st = self.style(style)
        w = self.width(s, style)
        cap, desc = self._cap(style), self._desc(style)
        x0 = x - {"start": 0, "middle": w / 2, "end": w}[anchor]
        g = st["size"] * 0.3
        self.els.append(f'<rect x="{x0 - g:.2f}" y="{y - cap / 2 - desc - g:.2f}" width="{w + 2 * g:.2f}" '
                        f'height="{cap + 2 * desc + 2 * g:.2f}" fill="{self.p["bg"]}"/>')
        self.text(x0, y + cap / 2, s, style, color)
        return w

    def raw(self, svg: str):
        """Escape hatch for shapes the API does not cover. Lint still checks colors."""
        self.els.append(svg)

    def _grow(self, y: float):
        self.ymax = max(self.ymax, y)

    # -- output -----------------------------------------------------------
    def svg(self) -> str:
        # Recompute on every render, so drawing after an earlier save still fits.
        self.h = self.fixed_h or _m.ceil(self.ymax + self.t["space"]["margin"])
        meta = json.dumps(dict(target=self.target, mode=self.mode, palette=self.palette_name,
                               fonts=self.fonts_name))
        unit = self.t["unit"]
        size = (f'width="{self.w}{"pt" if unit == "bp" else ""}" height="{self.h}{"pt" if unit == "bp" else ""}"')
        return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
                f"{size} viewBox=\"0 0 {self.w} {self.h}\" data-svgfig='{meta}'>\n"
                f'<defs>{"".join(self.defs.values())}</defs>\n'
                f'<rect width="{self.w}" height="{self.h}" fill="{self.p["bg"]}"/>\n'
                + "\n".join(self.els) + "\n</svg>\n")

    def save(self, path: str, png: bool = True, lint: bool = True) -> list[str]:
        """Write the SVG, a PNG preview next to it, and print lint findings."""
        path = Path(path)
        path.write_text(self.svg())
        if png:
            # deck: 1:1 pixels. paper: 4x, so small text is easy to inspect.
            zoom = {"deck": "1", "web": "1.5"}.get(self.target, "4")
            subprocess.run(["rsvg-convert", "-z", zoom, str(path), "-o", str(path.with_suffix(".png"))],
                           check=True)
        if not lint:
            return []
        from .lint import lint_file
        findings = lint_file(path)
        print(f"{path}: {len(findings)} findings")
        for x in findings:
            print("  " + x)
        return findings


def _ang(a, b):
    return _m.atan2(b[1] - a[1], b[0] - a[0])


def _toward(a, b, d):
    L = _m.dist(a, b)
    return a if L == 0 else (a[0] + (b[0] - a[0]) * d / L, a[1] + (b[1] - a[1]) * d / L)
