# figkit

Diagrams for walkthrough reports. figkit is adapted from the svg-figs skill. It keeps that skill's measured text, LaTeX math, palette and lint, and adds a target sized to the report column.

Run a script with `"$WALKTHROUGH_FIGKIT/run.sh" script.py`. Check tools and fonts with `"$WALKTHROUGH_FIGKIT/scripts/check-env.sh"`. Lint any SVG with `"$WALKTHROUGH_FIGKIT/lint.sh" file.svg`.

## Canvas

`Figure()` is the `web` target: 800 px wide, sized for the report column. The height grows to fit what you draw, plus a 14 px margin. Coordinates are px, with the origin at the top left. For text and math, `y` is the baseline. For boxes, `y` is the top edge.

The `web` styles are `heading` 17, `label` 15.5, `small` 14, `code` 13.5 and `caption` 13.5. The minimum text size is 13 px. Box padding is 11 px.

## API

| Call | Result |
|---|---|
| `f.node(x, y, rows, cat, w=, h=, align=)` | A box sized to fit its rows. Row 0 is a heading in the color of `cat`, and the other rows are labels. A row can be `(text, style, color)`. `w` and `h` are minimums. `align="middle"` centers the text. Returns a `Node`. |
| `f.size(rows, cat, w=, h=)` | `(w, h)` of that node, without drawing it. Use it to plan a layout. |
| `f.width(s, style)` | Measured width of a string. `$...$` inside it is measured as math. |
| `f.text(x, y, s, style, color, anchor)` | One line of text, with optional `$math$`. |
| `f.lines(x, y, rows, style, color)` | Several lines. |
| `f.math(x, y, latex, style, color, anchor)` | A display equation. Give it without `$`. |
| `f.box(x, y, w, h, cat)` | A tinted box. With `cat=None` it is a neutral panel. |
| `f.arrow(a, b, color)` | A straight arrow. Use node edge points: `a.r` to `b.l`, or `a.b` to `b.t`. |
| `f.connector(points, color)` | An arrow with right-angle turns and rounded corners. Use it to route around boxes. |
| `f.tag(x, y, s)` | A short label centered on a connector, such as "yes" or "diverged", with a background patch. |
| `f.line(a, b, color, dash=)` | A rule or guide line. |
| `f.save(path)` | Writes the SVG and a PNG preview, then prints the lint findings. |

A `Node` has edge midpoints `.l .r .t .b`, other edge points `.at(side, f)`, and `.x .y .x1 .y1 .cx .cy .w .h`.

Colors are `ink`, `ink2`, `muted`, `emph`, `line`, `rule`, and `cat0` to `cat3`, with `.fill` or `.stroke` for those roles. The cat colors are blue, orange, green and purple. Use `emph` (vermilion) for one warning or result only.

## Example

```python
from svgfig import Figure

f = Figure()
stages = [(["Direct solve", "Newton from the given start"], 0),
          (["Choked-face retry", "throats start at $M_8 = 1$"], 1),
          (["Continuation", "ramp the operating condition"], 3)]
bw = max(f.size(r, c)[0] for r, c in stages)      # one column, one width
x, y, nodes = 250 - bw / 2, 14, []
for rows, cat in stages:
    n = f.node(x, y, rows, cat=cat, w=bw, align="middle")
    nodes.append(n)
    y = n.y1 + 54
fail = f.node(x, y, ["Return the direct failure"], w=bw, align="middle")
ok = f.node(520, nodes[1].y, ["Converged and admissible", "residual small, all columns in bounds"],
            cat=2, align="middle")
for a, b in zip(nodes, nodes[1:] + [fail]):
    f.arrow(a.b, b.t)
    f.tag(a.cx, (a.y1 + b.y) / 2, "failed or out of bounds")
for n in nodes:
    f.connector([n.r, (ok.x - 40, n.cy), (ok.x - 40, ok.cy), ok.l], color="cat2")
f.save(".walkthrough/figs/ladder.svg")
```

## Rules

- Lay out by hand. Measure first, give boxes in a column one width, align centers, and keep arrows from crossing.
- Give each category color one meaning in a figure.
- Labels are a few common words, at most 20 words per line. Write math as LaTeX (`$P_0$`, `$\pi^*$`), not Unicode look-alikes.
- Show identifiers and file names in the `code` style with the color `muted`.
- The words in `words.txt` are rejected by the lint.
- Use `f.raw()` only for a shape the API does not cover. Use palette colors in it.

## Lint

The lint checks palette colors, fonts, minimum size, canvas bounds, box padding, text overlap, 4.5:1 contrast and wording. It cannot see crossing arrows, poor alignment or wasted space, so look at the PNG preview that the walkthrough tool returns.

The other targets, `deck` (1920×1080) and `paper` (252 or 516 bp), are kept from svg-figs for slides and papers.
