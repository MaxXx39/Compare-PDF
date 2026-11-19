"""Extraction des primitives vectorielles et des textes d'une page PDF."""
from __future__ import annotations
from dataclasses import dataclass
import numpy as np
import pymupdf

MM = 72.0 / 25.4          # points par mm (1 pt = 0,3528 mm)
CURVE_STEPS = 8           # nombre de segments pour aplatir une courbe de Bézier
MAX_CHUNK = 50.0          # longueur max d'un tronçon (pt) pour localiser finement les écarts


@dataclass
class PageData:
    width: float
    height: float
    segs: np.ndarray      # (N,4) x0,y0,x1,y1 en points
    words: list           # lignes de texte [(x0,y0,x1,y1,texte)]


def _bezier(p0, p1, p2, p3, n=CURVE_STEPS):
    t = np.linspace(0, 1, n + 1)[:, None]
    pts = ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3
    return pts


def _chunk(segs: np.ndarray) -> np.ndarray:
    """Découpe les segments longs en tronçons <= MAX_CHUNK."""
    if len(segs) == 0:
        return segs
    d = segs[:, 2:] - segs[:, :2]
    ln = np.hypot(d[:, 0], d[:, 1])
    n = np.maximum(1, np.ceil(ln / MAX_CHUNK).astype(int))
    if n.max() == 1:
        return segs
    idx = np.repeat(np.arange(len(segs)), n)
    start = np.cumsum(n) - n
    k = np.arange(len(idx)) - np.repeat(start, n)
    nn = n[idx][:, None]
    t0 = (k[:, None] / nn)
    t1 = ((k[:, None] + 1) / nn)
    s = segs[idx]
    a, b = s[:, :2], s[:, 2:]
    return np.hstack([a + (b - a) * t0, a + (b - a) * t1])


def extract_page(page: pymupdf.Page) -> PageData:
    out = []
    for dr in page.get_drawings():
        for it in dr["items"]:
            k = it[0]
            if k == "l":
                out.append((it[1].x, it[1].y, it[2].x, it[2].y))
            elif k == "re":
                r = it[1]
                out += [(r.x0, r.y0, r.x1, r.y0), (r.x1, r.y0, r.x1, r.y1),
                        (r.x1, r.y1, r.x0, r.y1), (r.x0, r.y1, r.x0, r.y0)]
            elif k == "qu":
                q = it[1]
                P = [q.ul, q.ur, q.lr, q.ll]
                out += [(P[i].x, P[i].y, P[(i + 1) % 4].x, P[(i + 1) % 4].y) for i in range(4)]
            elif k == "c":
                pts = _bezier(*[np.array([p.x, p.y]) for p in it[1:5]])
                out += [(*pts[i], *pts[i + 1]) for i in range(len(pts) - 1)]
    segs = np.array(out, dtype=np.float64).reshape(-1, 4)
    # supprime les segments dégénérés (longueur nulle)
    if len(segs):
        keep = np.hypot(segs[:, 2] - segs[:, 0], segs[:, 3] - segs[:, 1]) > 1e-6
        segs = segs[keep]
    lines: dict = {}
    for w in page.get_text("words"):
        if not w[4].strip():
            continue
        lines.setdefault((w[5], w[6]), []).append(w)
    words = []
    for ws in lines.values():
        ws.sort(key=lambda w: w[7])
        words.append((min(w[0] for w in ws), min(w[1] for w in ws), max(w[2] for w in ws),
                      max(w[3] for w in ws), " ".join(w[4] for w in ws)))
    return PageData(page.rect.width, page.rect.height, _chunk(segs), words)
