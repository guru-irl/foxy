"""Render the Foxy logo (extension/icons/foxy.svg) to docs/amo/icon.png for the AMO listing.

AMO shows its own icon upload, not the manifest icons, and does not take SVG.
The logo is one rounded rectangle with a diagonal linear gradient, so this
renders it exactly without an SVG library. Run after changing the logo:

    python3 scripts/amo_icon.py
"""
from pathlib import Path
import re
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent
SVG = ROOT / 'extension/icons/foxy.svg'
OUT = ROOT / 'docs/amo/icon.png'
SIZE = 128
SAMPLES = 4


def logo():
    svg = SVG.read_text()
    rect = re.search(r'<rect\s+x="([\d.]+)"\s+y="([\d.]+)"\s+width="([\d.]+)"\s+height="([\d.]+)"\s+rx="([\d.]+)"', svg)
    view = float(re.search(r'viewBox="0 0 ([\d.]+) [\d.]+"', svg).group(1))
    # The gradient runs from the bottom left (x1=0%, y1=100%) to the top right.
    if 'x1="0%" y1="100%" x2="100%" y2="0%"' not in svg:
        raise SystemExit('amo_icon.py expects the bottom-left to top-right gradient in foxy.svg.')
    stops = [(float(offset) / 100, tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4)))
             for offset, colour in re.findall(r'offset="([\d.]+)%" stop-color="#([0-9A-Fa-f]{6})"', svg)]
    return tuple(map(float, rect.groups())), view, stops


def colour_at(t, stops):
    t = min(1.0, max(0.0, t))
    for (a, ca), (b, cb) in zip(stops, stops[1:]):
        if t <= b:
            f = 0 if b == a else (t - a) / (b - a)
            return tuple(round(x + (y - x) * f) for x, y in zip(ca, cb))
    return stops[-1][1]


def render():
    (x0, y0, w, h, rx), view, stops = logo()
    x1, y1, scale = x0 + w, y0 + h, view / SIZE
    rows = bytearray()
    for py in range(SIZE):
        rows.append(0)
        for px in range(SIZE):
            inside = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px + (sx + 0.5) / SAMPLES) * scale
                    y = (py + (sy + 0.5) / SAMPLES) * scale
                    dx = max(x0 + rx - x, 0, x - (x1 - rx))
                    dy = max(y0 + rx - y, 0, y - (y1 - rx))
                    inside += x0 <= x <= x1 and y0 <= y <= y1 and dx * dx + dy * dy <= rx * rx
            cx, cy = (px + 0.5) * scale, (py + 0.5) * scale
            # objectBoundingBox units on a square box: t is the diagonal projection.
            t = ((cx - x0) / w + (y1 - cy) / h) / 2
            alpha = round(255 * inside / SAMPLES ** 2)
            rows.extend(colour_at(t, stops) + (alpha,) if alpha else (0, 0, 0, 0))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    OUT.write_bytes(render())
    print(f'Wrote {OUT.relative_to(ROOT)}')
