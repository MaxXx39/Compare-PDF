"""Rendu des résultats : calques SVG, images de fond, export PDF / CSV."""
from __future__ import annotations
import csv, io
import numpy as np
import pymupdf

RED, GREEN, BLUE = "#e5192b", "#16a34a", "#2563eb"
LABEL = {"modified": "Texte modifié", "added": "Texte ajouté", "removed": "Texte supprimé"}


def segs_svg(segs: np.ndarray, w: float, h: float, color: str, width: float = 3.0) -> str:
    d = "".join(f"M{a:.2f} {b:.2f}L{c:.2f} {e:.2f}" for a, b, c, e in segs)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.2f}" height="{h:.2f}">'
            f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round"/></svg>')


def text_svg(texts: list, w: float, h: float, which: str) -> str:
    """Rectangles de surlignage des textes : which='a' (anciens, rouge) ou 'b' (nouveaux, vert)."""
    out = []
    for t in texts:
        box, col = (t["box_a"], RED) if which == "a" else (t["box_b"], GREEN)
        if not box or (which == "a" and t["kind"] == "added") or (which == "b" and t["kind"] == "removed"):
            continue
        x0, y0, x1, y1 = box
        out.append(f'<rect x="{x0-2:.1f}" y="{y0-2:.1f}" width="{x1-x0+4:.1f}" height="{y1-y0+4:.1f}" '
                   f'fill="{col}" fill-opacity="0.18" stroke="{col}" stroke-width="1.5"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" width="{w:.2f}" height="{h:.2f}">'
            + "".join(out) + "</svg>")


def render_png(page: pymupdf.Page, max_px: int = 8000) -> bytes:
    k = min(2.0, max_px / max(page.rect.width, page.rect.height))
    return page.get_pixmap(matrix=pymupdf.Matrix(k, k), alpha=False).tobytes("png")


def rows(result: dict) -> list[list]:
    """Liste à plat des différences (pour CSV et PDF)."""
    out = []
    for pg in result["pages"]:
        for z in pg["zones"]:
            out.append([pg["page"], z["id"], z["removed"], z["added"],
                        z["text_mod"] + z["text_add"] + z["text_rem"],
                        round(z["bbox"][0], 1), round(z["bbox"][1], 1), round(z["bbox"][2], 1), round(z["bbox"][3], 1)])
    return out


def to_csv(result: dict) -> str:
    buf = io.StringIO()
    wr = csv.writer(buf, delimiter=";")
    wr.writerow(["Page", "Zone", "Traits supprimés", "Traits ajoutés", "Textes modifiés", "x0 (pt)", "y0 (pt)", "x1 (pt)", "y1 (pt)"])
    wr.writerows(rows(result))
    wr.writerow([])
    wr.writerow(["Page", "Type", "Ancien texte", "Nouveau texte"])
    for pg in result["pages"]:
        for t in pg["texts"]:
            wr.writerow([pg["page"], LABEL[t["kind"]], t["old"], t["new"]])
    return buf.getvalue()


def to_pdf(result: dict, docA: pymupdf.Document, docB: pymupdf.Document, diffs: dict) -> bytes:
    """PDF : une page de synthèse + une page de plan (A estompé + écarts vectoriels) par page comparée."""
    out = pymupdf.open()
    # --- synthèse
    pg = out.new_page(width=595, height=842)
    y = 50
    pg.insert_text((40, y), "Comparaison de plans", fontsize=18, fontname="hebo"); y += 22
    pg.insert_text((40, y), f"A (ancien) : {result['name_a']}", fontsize=9); y += 12
    pg.insert_text((40, y), f"B (nouveau) : {result['name_b']}", fontsize=9); y += 12
    p = result["params"]
    pg.insert_text((40, y), f"Tolérance : {p['tol_mm']} mm — regroupement : {p['cluster_mm']} mm — recalage auto : {'oui' if p['align'] else 'non'}", fontsize=9); y += 22
    pg.insert_text((40, y), "En rouge : présent dans A, absent de B.   En vert : ajouté dans B.", fontsize=9); y += 24

    def line(txt, bold=False):
        nonlocal pg, y
        if y > 800:
            pg = out.new_page(width=595, height=842); y = 50
        pg.insert_text((40, y), txt[:110], fontsize=8.5, fontname="hebo" if bold else "helv"); y += 12
    for r in result["pages"]:
        line(f"Page {r['page']} — {len(r['zones'])} zone(s), {r['n_removed']} traits supprimés, {r['n_added']} traits ajoutés, {len(r['texts'])} texte(s)", True)
        for z in r["zones"]:
            line(f"   Zone {z['id']} : -{z['removed']} traits / +{z['added']} traits / {z['text_mod']+z['text_add']+z['text_rem']} textes   @ ({z['bbox'][0]:.0f}, {z['bbox'][1]:.0f}) pt")
        for t in r["texts"]:
            if t["kind"] == "modified":
                line(f"   Texte : « {t['old']} » -> « {t['new']} »")
            elif t["kind"] == "added":
                line(f"   Texte ajouté : « {t['new']} »")
            else:
                line(f"   Texte supprimé : « {t['old']} »")
        y += 6
    # --- pages de plan
    for r in result["pages"]:
        i = r["page"] - 1
        d = diffs[i]
        pa = docA[i]
        w, h = d.width, d.height
        np_ = out.new_page(width=w, height=h)
        pix = pa.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), alpha=False)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
        light = (255 - (255 - arr) * 0.25).astype(np.uint8)
        light_pix = pymupdf.Pixmap(pymupdf.csRGB, pix.w, pix.h, light.tobytes(), False)
        np_.insert_image(pymupdf.Rect(0, 0, w, h), pixmap=light_pix)
        sh = np_.new_shape()
        for s in d.removed:
            sh.draw_line((s[0], s[1]), (s[2], s[3]))
        sh.finish(color=(0.9, 0.1, 0.17), width=2.5, lineCap=1)
        for s in d.added:
            sh.draw_line((s[0] - d.shift[0], s[1] - d.shift[1]), (s[2] - d.shift[0], s[3] - d.shift[1]))
        sh.finish(color=(0.09, 0.64, 0.29), width=2.5, lineCap=1)
        sh.commit()
        for t in d.texts:
            box = t["box_a"] if t["kind"] != "added" else t["box_b"]
            col = (0.9, 0.1, 0.17) if t["kind"] != "added" else (0.09, 0.64, 0.29)
            if box:
                np_.draw_rect(pymupdf.Rect(*box) + (-2, -2, 2, 2), color=col, fill=col, fill_opacity=0.2, width=1)
        for z in r["zones"]:
            x0, y0, x1, y1 = z["bbox"]
            rc = pymupdf.Rect(x0 - 8, y0 - 8, x1 + 8, y1 + 8)
            np_.draw_rect(rc, color=(0.15, 0.39, 0.92), width=1.5, dashes="[6 4] 0")
            np_.insert_text((rc.x0, max(rc.y0 - 3, 12)), str(z["id"]), fontsize=14, fontname="hebo", color=(0.15, 0.39, 0.92))
    return out.tobytes(deflate=True)
