"""Comparaison de deux pages : segments vectoriels + textes."""
from __future__ import annotations
from dataclasses import dataclass, field
import difflib
import numpy as np
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from .extract import PageData, MM


@dataclass
class Params:
    tol_mm: float = 2.0        # tolérance (mm sur papier)
    cluster_mm: float = 15.0   # distance de regroupement des écarts en zones
    align: bool = False        # recalage automatique par translation
    compare_text: bool = True
    min_zone_items: int = 1


@dataclass
class PageDiff:
    width: float
    height: float
    shift: tuple = (0.0, 0.0)          # translation appliquée à A pour recaler sur B
    removed: np.ndarray = None         # segments de A absents de B  (coords A)
    added: np.ndarray = None           # segments de B absents de A  (coords B)
    texts: list = field(default_factory=list)   # dicts
    zones: list = field(default_factory=list)   # dicts
    n_segs_a: int = 0
    n_segs_b: int = 0


def _sample(segs: np.ndarray, step: float):
    """Points échantillonnés le long des segments -> (points, index du segment)."""
    if len(segs) == 0:
        return np.zeros((0, 2)), np.zeros(0, dtype=int)
    d = segs[:, 2:] - segs[:, :2]
    ln = np.hypot(d[:, 0], d[:, 1])
    n = np.maximum(1, np.ceil(ln / step).astype(int))
    idx = np.repeat(np.arange(len(segs)), n)
    start = np.cumsum(n) - n
    k = np.arange(len(idx)) - np.repeat(start, n)
    t = ((k + 0.5) / n[idx])[:, None]
    pts = segs[idx, :2] + d[idx] * t
    return pts, idx


def _unmatched(a: np.ndarray, b_tree: cKDTree, step: float, tol: float) -> np.ndarray:
    """Masque des segments de `a` pas couverts (à `tol` près) par l'arbre de points de b."""
    pts, idx = _sample(a, step)
    if len(pts) == 0:
        return np.zeros(len(a), dtype=bool)
    if b_tree.n == 0:
        return np.ones(len(a), dtype=bool)
    dist, _ = b_tree.query(pts, distance_upper_bound=tol + step * 0.5)
    bad = ~(dist <= tol + step * 0.5)
    cnt = np.bincount(idx, minlength=len(a))
    badc = np.bincount(idx, weights=bad, minlength=len(a))
    return badc / np.maximum(cnt, 1) >= 0.5


def _estimate_shift(a_pts, b_pts, limit):
    """Translation A->B par ICP simplifié (médiane des écarts au plus proche voisin)."""
    rng = np.random.default_rng(0)
    sub = a_pts[rng.choice(len(a_pts), min(len(a_pts), 30000), replace=False)]
    tree = cKDTree(b_pts)
    s = np.zeros(2)
    for _ in range(8):
        d, i = tree.query(sub + s, distance_upper_bound=limit)
        ok = np.isfinite(d)
        if ok.sum() < 50:
            break
        delta = np.median(b_pts[i[ok]] - (sub[ok] + s), axis=0)
        s += delta
        if np.hypot(*delta) < 0.05:
            break
    return s


def _group(mid: np.ndarray, radius: float):
    if len(mid) == 0:
        return 0, np.zeros(0, dtype=int)
    pairs = cKDTree(mid).query_pairs(radius, output_type="ndarray")
    n = len(mid)
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n)) if len(pairs) else coo_matrix((n, n))
    return connected_components(g, directed=False)


def compare_pages(A: PageData, B: PageData, p: Params) -> PageDiff:
    tol = p.tol_mm * MM
    step = max(min(tol / 2, 3.0), 0.5)
    res = PageDiff(B.width, B.height, n_segs_a=len(A.segs), n_segs_b=len(B.segs))

    pa, _ = _sample(A.segs, step)
    pb, _ = _sample(B.segs, step)
    shift = np.zeros(2)
    if p.align and len(pa) > 100 and len(pb) > 100:
        shift = _estimate_shift(pa, pb, max(tol * 10, 60))
    res.shift = (float(shift[0]), float(shift[1]))

    a_sh = A.segs + np.tile(shift, 2)
    tree_a = cKDTree(pa + shift) if len(pa) else cKDTree(np.zeros((0, 2)))
    tree_b = cKDTree(pb) if len(pb) else cKDTree(np.zeros((0, 2)))
    rem = _unmatched(a_sh, tree_b, step, tol)
    add = _unmatched(B.segs, tree_a, step, tol)
    res.removed = A.segs[rem]
    res.added = B.segs[add]

    # ---- textes (par ligne) -------------------------------------------
    texts = []
    if p.compare_text:
        tt = max(tol, 3.0)
        la = [(np.array(w[:4]) + np.tile(shift, 2), w[4]) for w in A.words]
        lb = [(np.array(w[:4]), w[4]) for w in B.words]

        def gap(r, s):   # distance entre deux rectangles (0 si recouvrement)
            dx = max(r[0] - s[2], s[0] - r[2], 0)
            dy = max(r[1] - s[3], s[1] - r[3], 0)
            return float(np.hypot(dx, dy))
        by_text = {}
        for j, (bx, t) in enumerate(lb):
            by_text.setdefault(t, []).append(j)
        used_b, un_a = set(), []
        for i, (bx, t) in enumerate(la):
            hit = next((j for j in by_text.get(t, []) if j not in used_b
                        and np.abs(lb[j][0] - bx).max() <= tt), None)
            if hit is None:
                un_a.append(i)
            else:
                used_b.add(hit)
        un_b = [j for j in range(len(lb)) if j not in used_b]
        def iou(r, s):
            w = min(r[2], s[2]) - max(r[0], s[0]); h = min(r[3], s[3]) - max(r[1], s[1])
            if w <= 0 or h <= 0:
                return 0.0
            inter = w * h
            return inter / ((r[2]-r[0])*(r[3]-r[1]) + (s[2]-s[0])*(s[3]-s[1]) - inter)
        cand = []
        if len(un_a) * len(un_b) < 4_000_000:
            for i in un_a:
                for j in un_b:
                    g = gap(la[i][0], lb[j][0])
                    if g > tt:
                        continue
                    sim = difflib.SequenceMatcher(None, la[i][1], lb[j][1]).ratio()
                    ov = iou(la[i][0], lb[j][0])
                    if sim >= 0.4 or ov >= 0.3:
                        cand.append((g + (1 - sim) * tt - ov * tt, i, j))
            cand.sort()
        pa_, pb_ = set(), set()
        for g, i, j in cand:
            if i in pa_ or j in pb_:
                continue
            pa_.add(i); pb_.add(j)
            texts.append(dict(kind="modified", old=la[i][1], new=lb[j][1],
                              box_a=[float(v) for v in A.words[i][:4]], box_b=[float(v) for v in lb[j][0]]))
        for i in un_a:
            if i not in pa_:
                texts.append(dict(kind="removed", old=la[i][1], new="", box_a=[float(v) for v in A.words[i][:4]], box_b=None))
        for j in un_b:
            if j not in pb_:
                texts.append(dict(kind="added", old="", new=lb[j][1], box_a=None, box_b=[float(v) for v in lb[j][0]]))
    res.texts = texts

    # ---- zones : regroupement spatial (repère de B) ---------------------
    items = []   # (cx, cy, kind, bbox)
    for s in res.removed:
        s2 = s + np.tile(shift, 2)
        items.append((*(s2[:2] + s2[2:]) / 2, "removed", s2))
    for s in res.added:
        items.append((*(s[:2] + s[2:]) / 2, "added", s))
    for t in texts:
        bx = np.array(t["box_b"] if t["box_b"] else (np.array(t["box_a"]) + np.tile(shift, 2)))
        k = {"modified": "text_mod", "added": "text_add", "removed": "text_rem"}[t["kind"]]
        items.append((*((bx[:2] + bx[2:]) / 2), k, bx))
    if items:
        mid = np.array([[i[0], i[1]] for i in items])
        n, lab = _group(mid, p.cluster_mm * MM)
        for z in range(n):
            mem = [items[i] for i in np.nonzero(lab == z)[0]]
            allb = np.array([m[3] for m in mem])
            x0, y0 = allb[:, [0, 2]].min(), allb[:, [1, 3]].min()
            x1, y1 = allb[:, [0, 2]].max(), allb[:, [1, 3]].max()
            kinds = [m[2] for m in mem]
            res.zones.append(dict(
                bbox=[float(x0), float(y0), float(x1), float(y1)],
                removed=kinds.count("removed"), added=kinds.count("added"),
                text_mod=kinds.count("text_mod"), text_add=kinds.count("text_add"),
                text_rem=kinds.count("text_rem")))
        res.zones.sort(key=lambda z: (round(z["bbox"][0] / 200), z["bbox"][1]))
        for i, z in enumerate(res.zones, 1):
            z["id"] = i
    return res
