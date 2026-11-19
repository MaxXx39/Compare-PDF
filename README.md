# Compare-PDF

Outil local de comparaison de plans PDF vectoriels (exports AutoCAD).

## Lancer
```bash
pip install -r requirements.txt
python run.py          # puis ouvrir http://127.0.0.1:8000
```

## Fonctionnement
- `core/extract.py` : extrait traits/courbes/rectangles (aplatis en segments) et lignes de texte via PyMuPDF.
- `core/diff.py` : compare A et B avec une tolérance en mm (échantillonnage + KD-tree), recalage
  optionnel par translation, regroupe les écarts en zones, compare les textes ligne par ligne.
- `core/report.py` : calques SVG, export PDF (A estompé + écarts vectoriels) et CSV.
- `app/` : API FastAPI + interface (superposition, côte à côte, curseur, liste de zones cliquable).

Convention : A = ancienne version (rouge = supprimé), B = nouvelle (vert = ajouté).
Exemples dans `samples/`. Multi-page : les pages sont comparées 1↔1.

## Déploiement web
Un `Dockerfile` et un `render.yaml` sont fournis. Sur render.com : *New → Blueprint*, choisir ce dépôt,
puis définir `APP_PASSWORD` (mot de passe d'accès ; le nom d'utilisateur est libre). Sans cette variable, l'accès est public.
Prévoir ≥ 1 Go de RAM pour de grands plans.

## Version « fichier unique » (sans installation)
`dist/comparateur.html` : à télécharger puis double-cliquer, s'ouvre dans Chrome. Tout est calculé dans le navigateur
(pdf.js + jsPDF embarqués, aucun envoi de fichier). Régénérer avec `standalone/build.py` (voir l'en-tête du script).
