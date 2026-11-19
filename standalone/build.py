"""Assemble dist/comparateur.html (fichier unique, autonome) à partir de pdf.js, jsPDF et app.js.
Usage : python standalone/build.py <dossier pdfjs-dist/build> <jspdf.umd.min.js>"""
import sys
from pathlib import Path
here = Path(__file__).parent
pdfjs_build, jspdf = Path(sys.argv[1]), Path(sys.argv[2])
rd = lambda p: Path(p).read_text(encoding="utf-8")
html = rd(here / "template.html")
safe = lambda s: s.replace("</script", "<\\/script")
for key, txt in {"/*@PDFJS@*/": rd(pdfjs_build / "pdf.min.js"), "/*@JSPDF@*/": rd(jspdf),
                 "/*@WORKER@*/": rd(pdfjs_build / "pdf.worker.min.js"), "/*@APP@*/": rd(here / "app.js")}.items():
    html = html.replace(key, safe(txt))
out = here.parent / "dist" / "comparateur.html"
out.write_text(html, encoding="utf-8")
print(out, round(out.stat().st_size / 1e6, 2), "Mo")
