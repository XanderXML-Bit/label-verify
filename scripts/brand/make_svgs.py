"""Generate Label Verify brand SVGs (mark + outlined wordmark) in the Studio palette.

Text is converted to outlines with fontTools so the wordmark renders identically
with no font dependency.
"""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

OUT = sys.argv[1]

NAVY_950 = "#070c1a"
NAVY_800 = "#1c2640"
BLUE = "#6ba8ff"
BLUE_500 = "#4e8ffa"
TEAL = "#7bd2c2"
INK_LIGHT = "#dce3ef"

# Mark: label/document on a navy tile with a teal check. The tile is filled, so
# the mark reads on dark and light backgrounds alike.
MARK_INNER = f"""
  <rect width="64" height="64" rx="14" fill="{NAVY_950}"/>
  <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="13.25" fill="none" stroke="{NAVY_800}" stroke-width="1.5"/>
  <path d="M19 13h19l9 9v27a3 3 0 0 1-3 3H19a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3Z" fill="{NAVY_800}" stroke="{BLUE}" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M38 13v7a2 2 0 0 0 2 2h7" fill="none" stroke="{BLUE}" stroke-width="2.6" stroke-linejoin="round"/>
  <path d="M22.5 27.5h17M22.5 33.5h17M22.5 39.5h9" stroke="{INK_LIGHT}" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="44" cy="45" r="10" fill="{TEAL}" stroke="{NAVY_950}" stroke-width="2.5"/>
  <path d="m39.5 45.2 3.1 3.1 6.1-6.3" fill="none" stroke="{NAVY_950}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
"""


def mark_svg(size=64):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="{size}" height="{size}" '
        f'role="img" aria-label="Label Verify">\n  <title>Label Verify</title>{MARK_INNER}</svg>\n'
    )


def text_paths(font_path, weight, text, size, x0, baseline):
    font = TTFont(font_path)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight})
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    scale = size / upm
    hmtx = font["hmtx"]
    x = x0
    paths = []
    for ch in text:
        gname = cmap[ord(ch)]
        pen = SVGPathPen(gs)
        tpen = TransformPen(pen, (scale, 0, 0, -scale, x, baseline))
        gs[gname].draw(tpen)
        d = pen.getCommands()
        if d:
            paths.append(d)
        x += hmtx[gname][0] * scale
    return " ".join(paths), x


def wordmark_svg(sora):
    # Mark at 0..64, word after a 16 px gap. "Label" in a mid navy that holds
    # >= 3:1 on white and on navy-950 (large text); "Verify" in Studio blue-500.
    d1, x = text_paths(sora, 600, "Label", 34, 80, 44)
    d2, x2 = text_paths(sora, 600, "Verify", 34, x + 10, 44)
    width = int(x2 + 4)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 64" width="{width}" height="64" '
        f'role="img" aria-label="Label Verify">\n  <title>Label Verify</title>\n'
        f'  <g>{MARK_INNER}</g>\n'
        f'  <path fill="#8292b0" d="{d1}"/>\n'
        f'  <path fill="{BLUE_500}" d="{d2}"/>\n</svg>\n'
    )


if __name__ == "__main__":
    import os

    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, "mark.svg"), "w").write(mark_svg())
    open(os.path.join(OUT, "wordmark.svg"), "w").write(wordmark_svg(sys.argv[2]))
    print("ok")
