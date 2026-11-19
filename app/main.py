"""Application web locale de comparaison de plans PDF.  Lancer : python run.py"""
from __future__ import annotations
import json, shutil, uuid
from pathlib import Path
from dataclasses import asdict

import pymupdf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from core.extract import extract_page
from core.diff import Params, compare_pages
from core import report

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work"
WORK.mkdir(exist_ok=True)
MAX_SESSIONS = 20

app = FastAPI(title="Compare-PDF")
_cache: dict[str, dict] = {}     # id -> {"diffs": {...}, "result": {...}}


def _prune():
    dirs = sorted(WORK.iterdir(), key=lambda p: p.stat().st_mtime)
    for d in dirs[:-MAX_SESSIONS]:
        shutil.rmtree(d, ignore_errors=True)
        _cache.pop(d.name, None)


@app.post("/api/compare")
def compare(a: UploadFile = File(...), b: UploadFile = File(...),
            tol_mm: float = Form(2.0), cluster_mm: float = Form(15.0),
            align: bool = Form(False), compare_text: bool = Form(True)):
    _prune()
    sid = uuid.uuid4().hex[:12]
    d = WORK / sid
    d.mkdir()
    (d / "a.pdf").write_bytes(a.file.read())
    (d / "b.pdf").write_bytes(b.file.read())
    try:
        docA, docB = pymupdf.open(d / "a.pdf"), pymupdf.open(d / "b.pdf")
    except Exception as e:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, f"PDF illisible : {e}")
    p = Params(tol_mm=tol_mm, cluster_mm=cluster_mm, align=align, compare_text=compare_text)
    diffs, pages = {}, []
    for i in range(min(len(docA), len(docB))):
        A, B = extract_page(docA[i]), extract_page(docB[i])
        r = compare_pages(A, B, p)
        diffs[i] = r
        (d / f"p{i}_removed.svg").write_text(report.segs_svg(r.removed, A.width, A.height, report.RED))
        (d / f"p{i}_added.svg").write_text(report.segs_svg(r.added, B.width, B.height, report.GREEN))
        (d / f"p{i}_text_a.svg").write_text(report.text_svg(r.texts, A.width, A.height, "a"))
        (d / f"p{i}_text_b.svg").write_text(report.text_svg(r.texts, B.width, B.height, "b"))
        (d / f"p{i}_a.png").write_bytes(report.render_png(docA[i]))
        (d / f"p{i}_b.png").write_bytes(report.render_png(docB[i]))
        pages.append(dict(page=i + 1, width=B.width, height=B.height, shift=list(r.shift),
                          n_removed=len(r.removed), n_added=len(r.added), segs_a=r.n_segs_a, segs_b=r.n_segs_b,
                          zones=r.zones, texts=r.texts, identical=not (len(r.removed) or len(r.added) or r.texts)))
    result = dict(id=sid, name_a=a.filename, name_b=b.filename, params=asdict(p), pages=pages,
                  pages_a=len(docA), pages_b=len(docB))
    (d / "result.json").write_text(json.dumps(result))
    _cache[sid] = dict(diffs=diffs, result=result)
    return result


def _dir(sid: str) -> Path:
    d = WORK / sid
    if not d.is_dir() or not sid.isalnum():
        raise HTTPException(404, "Résultat introuvable")
    return d


@app.get("/api/result/{sid}/p/{n}/{name}")
def layer(sid: str, n: int, name: str):
    f = _dir(sid) / f"p{n}_{name}"
    if name not in {"a.png", "b.png", "removed.svg", "added.svg", "text_a.svg", "text_b.svg"} or not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/png" if name.endswith("png") else "image/svg+xml")


@app.get("/api/result/{sid}/export.csv")
def export_csv(sid: str):
    res = json.loads((_dir(sid) / "result.json").read_text())
    return Response("﻿" + report.to_csv(res), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="differences.csv"'})


@app.get("/api/result/{sid}/export.pdf")
def export_pdf(sid: str):
    d = _dir(sid)
    c = _cache.get(sid)
    if not c:
        raise HTTPException(410, "Session expirée, relancez la comparaison")
    pdf = report.to_pdf(c["result"], pymupdf.open(d / "a.pdf"), pymupdf.open(d / "b.pdf"), c["diffs"])
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="comparaison.pdf"'})


app.mount("/", StaticFiles(directory=ROOT / "app" / "static", html=True), name="static")
