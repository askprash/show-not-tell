"""Measure text with HarfBuzz using the installed font files (no width guesses)."""
from __future__ import annotations

import functools
import subprocess

import uharfbuzz as hb

WEIGHTS = {"regular": 400, "medium": 500, "semibold": 600, "bold": 700}


@functools.lru_cache(maxsize=None)
def font_file(family: str, weight: str = "regular", italic: bool = False) -> str:
    pat = f"{family}:weight={ {'regular':80,'medium':100,'semibold':180,'bold':200}[weight] }"
    if italic:
        pat += ":slant=100"
    out = subprocess.run(["fc-match", "-f", "%{file}\n%{family}", pat],
                         capture_output=True, text=True, check=True).stdout.split("\n")
    if family.lower() not in out[1].lower():
        raise RuntimeError(f"font not installed: {family} (fc-match gave {out[1]})")
    return out[0]


@functools.lru_cache(maxsize=None)
def _hb_font(path: str, wght: int):
    face = hb.Face(open(path, "rb").read())
    font = hb.Font(face)
    try:
        font.set_variations({"wght": wght})
    except Exception:
        pass
    return font, face.upem


def width(s: str, family: str, size: float, weight: str = "regular", italic: bool = False) -> float:
    font, upem = _hb_font(font_file(family, weight, italic), WEIGHTS[weight])
    buf = hb.Buffer()
    buf.add_str(s)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})
    return sum(p.x_advance for p in buf.glyph_positions) * size / upem


def ink(s: str, family: str, size: float, weight: str = "regular", italic: bool = False):
    """Ink box of a shaped run: (x0, x1, ascent, descent) relative to the pen start
    on the baseline. ascent > 0 above the baseline, descent > 0 below it."""
    font, upem = _hb_font(font_file(family, weight, italic), WEIGHTS[weight])
    buf = hb.Buffer()
    buf.add_str(s)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": True})
    pen, x0, x1, top, bot = 0, None, None, 0, 0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        e = font.get_glyph_extents(info.codepoint)
        if e and e.width:
            gx0 = pen + pos.x_offset + e.x_bearing
            gx1 = gx0 + e.width
            x0 = gx0 if x0 is None else min(x0, gx0)
            x1 = gx1 if x1 is None else max(x1, gx1)
            top = max(top, pos.y_offset + e.y_bearing)
            bot = min(bot, pos.y_offset + e.y_bearing + e.height)
        pen += pos.x_advance
    k = size / upem
    if x0 is None:
        return (0.0, 0.0, 0.0, 0.0)
    return (x0 * k, x1 * k, top * k, -bot * k)
