"""Geometry helpers: 4-corner (keystone) warp and output layout.

Coordinates are fractions of an output: x 0..1 left->right, y 0..1 top->bottom.
The "image square" is the video frame, also 0..1 with y downwards.
"""
from __future__ import annotations

import math

Corner = list  # [x, y]


def default_corners(out_w: int, out_h: int, video_aspect: float, fit: str, zoom: float) -> list[Corner]:
    """Where the video frame lands on an output with no saved alignment (preview.fit / zoom)."""
    out_aspect = out_w / out_h if out_h else 1.0
    a = video_aspect or 1.0
    if fit == "stretch":
        w = h = 1.0
    else:
        contain_w = (a / out_aspect) < 1.0          # video narrower than the output
        if contain_w == (fit == "contain"):
            w, h = a / out_aspect, 1.0             # full height
        else:
            w, h = 1.0, out_aspect / a             # full width
    z = zoom or 1.0
    w, h = w * z, h * z
    x0, y0 = (1 - w) / 2, (1 - h) / 2
    return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]


def square_to_quad(c: list[Corner]) -> list[list[float]]:
    """3x3 projective map (row-major) taking the unit square's corners to c[0..3]
    (order: (0,0) (1,0) (1,1) (0,1)). Heckbert's closed form."""
    (x0, y0), (x1, y1), (x2, y2), (x3, y3) = c
    dx1, dx2, dx3 = x1 - x2, x3 - x2, x0 - x1 + x2 - x3
    dy1, dy2, dy3 = y1 - y2, y3 - y2, y0 - y1 + y2 - y3
    if abs(dx3) < 1e-12 and abs(dy3) < 1e-12:
        g = h = 0.0
    else:
        den = dx1 * dy2 - dx2 * dy1
        if abs(den) < 1e-12:
            raise ValueError("corners are in a line")
        g = (dx3 * dy2 - dx2 * dy3) / den
        h = (dx1 * dy3 - dx3 * dy1) / den
    a, b, cc = x1 - x0 + g * x1, x3 - x0 + h * x3, x0
    d, e, f = y1 - y0 + g * y1, y3 - y0 + h * y3, y0
    return [[a, b, cc], [d, e, f], [g, h, 1.0]]


def invert3(m: list[list[float]]) -> list[list[float]]:
    (a, b, c), (d, e, f), (g, h, i) = m
    A, B, C = e * i - f * h, -(d * i - f * g), d * h - e * g
    det = a * A + b * B + c * C
    if abs(det) < 1e-15:
        raise ValueError("corners do not form a usable shape")
    D, E, F = -(b * i - c * h), a * i - c * g, -(a * h - b * g)
    G, H, I = b * f - c * e, -(a * f - c * d), a * e - b * d
    return [[A / det, D / det, G / det], [B / det, E / det, H / det], [C / det, F / det, I / det]]


def output_to_image_uniform(corners: list[Corner]) -> tuple[float, ...]:
    """Inverse map (output -> image square) packed column-major for a GLSL mat3."""
    m = invert3(square_to_quad(corners))
    return tuple(m[r][col] for col in range(3) for r in range(3))


def is_valid(corners: list[Corner]) -> bool:
    """Convex and not folded over (all turns the same way)."""
    try:
        invert3(square_to_quad(corners))
    except ValueError:
        return False
    signs = []
    for i in range(4):
        (ax, ay), (bx, by), (cx, cy) = corners[i], corners[(i + 1) % 4], corners[(i + 2) % 4]
        signs.append((bx - ax) * (cy - by) - (by - ay) * (cx - bx))
    return all(s > 0 for s in signs) or all(s < 0 for s in signs)


def tile_rects(n: int, width: int, height: int, gap: int = 6) -> list[tuple[int, int, int, int]]:
    """Window-mode preview: n outputs laid out as a grid (x, y, w, h, top-left origin)."""
    cols = max(1, math.ceil(math.sqrt(n * width / max(height, 1) / 1.6)))
    cols = min(cols, n)
    rows = math.ceil(n / cols)
    tw = (width - gap * (cols + 1)) // cols
    th = (height - gap * (rows + 1)) // rows
    # keep a 16:10 look for each tile
    if tw / th > 1.6:
        tw = int(th * 1.6)
    else:
        th = int(tw / 1.6)
    out = []
    for i in range(n):
        r, c = divmod(i, cols)
        out.append((gap + c * (tw + gap), gap + r * (th + gap), tw, th))
    return out
