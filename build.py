"""
build.py — Génère la page statique public/index.html à partir des sources.

USAGE
  python3 build.py

  Le fichier public/index.html est régénéré (dossier public/ créé si besoin).
  C'est ce dossier, et lui seul, qui est publié (GitHub Pages).
  Aucune dépendance externe : uniquement la bibliothèque standard Python (3.8+).

ORGANISATION
  src/      sources de la page (gabarit HTML, JavaScript, polices, images)
  data/     hypothèses du modèle et référentiel des communes
  public/   page générée — ne pas modifier à la main
  tests/    tests de non-régression

OÙ MODIFIER LE WORDING
  1. src/template.html
     → Texte statique de l'interface : titre, sous-titre, description de la page,
       intitulés des étapes, texte du footer.
  2. src/app.js
     → Texte généré dynamiquement (libellés des indicateurs, bloc mutualisation,
       libellés des champs de saisie). La liste CAS_CONFIG en tête de fichier
       définit le nom, la description et les libellés de saisie de chacun des
       6 cas d'usage.
  3. data/hypotheses_mon_territoire.csv / data/hypotheses.json
     → Les valeurs numériques du modèle. Éditez le CSV (Excel/LibreOffice) puis
       décommentez convert_csv_to_json() ci-dessous avant de relancer build.py.
  4. data/communes-france-2026.csv / data/communes.json
     → Le référentiel des communes, embarqué dans le HTML final. Pour un nouveau
       millésime : remplacez le CSV, décommentez convert_communes_csv_to_json(),
       relancez build.py.
  5. src/images/logo_fnccr.png, src/images/logo_banque_des_territoires.png
     → Remplacez ces fichiers pour changer les logos de l'en-tête (fond transparent recommandé ;
       le logo Banque des Territoires est affiché sur un cartouche blanc, avec ses couleurs d'origine).
       (logo_tactis.png n'est plus affiché ni intégré.)
       src/images/favicon.png est l'icône d'onglet (64 × 64, tirée du logo FNCCR).
  6. src/fonts/fonts.css et src/fonts/*.woff2
     → Polices Inter et Space Grotesk, intégrées en base64 (pas d'appel à Google Fonts).

Après toute modification, relancez simplement :  python3 build.py
"""

import base64
import json
import csv
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
SRC_DIR = HERE / "src"
DATA_DIR = HERE / "data"
PUBLIC_DIR = HERE / "public"

TEMPLATE_FILE = SRC_DIR / "template.html"
ENGINE_JS_FILE = SRC_DIR / "engine.js"
APP_JS_FILE = SRC_DIR / "app.js"
FONTS_CSS_FILE = SRC_DIR / "fonts" / "fonts.css"
LOGO_FNCCR_FILE = SRC_DIR / "images" / "logo_fnccr.png"
LOGO_BDT_FILE = SRC_DIR / "images" / "logo_banque_des_territoires.png"
FAVICON_FILE = SRC_DIR / "images" / "favicon.png"
HYPOTHESES_JSON_FILE = DATA_DIR / "hypotheses.json"
HYPOTHESES_CSV_FILE = DATA_DIR / "hypotheses_mon_territoire.csv"
COMMUNES_JSON_FILE = DATA_DIR / "communes.json"
COMMUNES_CSV_FILE = DATA_DIR / "communes-france-2026.csv"

OUTPUT_FILE = PUBLIC_DIR / "index.html"


def convert_csv_to_json():
    """Reconvertit hypotheses_mon_territoire.csv → hypotheses.json."""
    if not HYPOTHESES_CSV_FILE.exists():
        print(f"[convert_csv_to_json] {HYPOTHESES_CSV_FILE.name} introuvable — étape ignorée.")
        return
    with open(HYPOTHESES_CSV_FILE, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f, delimiter=";")
        rows = []
        for row in reader:
            try:
                row["valeur"] = float(row["valeur"])
            except (KeyError, ValueError):
                pass
            rows.append(row)
    with open(HYPOTHESES_JSON_FILE, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    print(f"[convert_csv_to_json] {HYPOTHESES_JSON_FILE.name} régénéré ({len(rows)} lignes).")


def convert_communes_csv_to_json():
    """Reconvertit communes-france-2026.csv → communes.json (tableau positionnel)."""
    if not COMMUNES_CSV_FILE.exists():
        print(f"[convert_communes_csv_to_json] {COMMUNES_CSV_FILE.name} introuvable — étape ignorée.")
        return
    cols = ["code_insee", "nom_standard", "dep_code", "dep_nom", "epci_code", "epci_nom",
            "population", "nombre_menages", "Strate", "nombre_points_livraison", "vigilance"]
    with open(COMMUNES_CSV_FILE, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = []
        for row in reader:
            record = []
            for col in cols:
                val = row.get(col, "")
                if col in ("population", "nombre_menages", "nombre_points_livraison", "vigilance"):
                    try:
                        val = float(val)
                        if val.is_integer():
                            val = int(val)
                    except (TypeError, ValueError):
                        val = None
                record.append(val)
            rows.append(record)
    with open(COMMUNES_JSON_FILE, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[convert_communes_csv_to_json] {COMMUNES_JSON_FILE.name} régénéré ({len(rows):,} communes).")


def b64_of(path: Path) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def inline_fonts_css() -> str:
    """Lit src/fonts/fonts.css et remplace chaque police .woff2 référencée par une URI data: base64."""
    css = FONTS_CSS_FILE.read_text(encoding="utf-8")

    def to_data_uri(match):
        font_file = FONTS_CSS_FILE.parent / match.group(1)
        if not font_file.exists():
            print(f"Police introuvable : {font_file.relative_to(HERE)}", file=sys.stderr)
            sys.exit(1)
        return f"url(data:font/woff2;base64,{b64_of(font_file)})"

    return re.sub(r"url\(([^)]+\.woff2)\)", to_data_uri, css)


def build():
    missing = [p for p in [TEMPLATE_FILE, ENGINE_JS_FILE, APP_JS_FILE, FONTS_CSS_FILE, HYPOTHESES_JSON_FILE,
                            COMMUNES_JSON_FILE, LOGO_FNCCR_FILE, LOGO_BDT_FILE, FAVICON_FILE] if not p.exists()]
    if missing:
        print("Fichier(s) source manquant(s) :", file=sys.stderr)
        for p in missing:
            print(f"  - {p.relative_to(HERE)}", file=sys.stderr)
        sys.exit(1)

    template = TEMPLATE_FILE.read_text(encoding="utf-8")

    # engine.js exporte ses fonctions via module.exports en fin de fichier pour les tests
    # Node — ce bloc n'a pas de sens dans un <script> de navigateur, on le retire.
    engine_js = ENGINE_JS_FILE.read_text(encoding="utf-8")
    engine_js = engine_js.split("if (typeof module")[0].rstrip()

    hypotheses_json = HYPOTHESES_JSON_FILE.read_text(encoding="utf-8")
    communes_json = COMMUNES_JSON_FILE.read_text(encoding="utf-8")
    app_js = APP_JS_FILE.read_text(encoding="utf-8")
    logo_fnccr_b64 = b64_of(LOGO_FNCCR_FILE)
    logo_bdt_b64 = b64_of(LOGO_BDT_FILE)

    # Les marqueurs propres au gabarit (polices, icône) sont remplacés avant d'y injecter le code et les données.
    output = (
        template
        .replace("__FONTS_CSS__", inline_fonts_css())
        .replace("__FAVICON_B64__", b64_of(FAVICON_FILE))
        .replace("__ENGINE_JS__", engine_js)
        .replace("__HYPOTHESES_JSON__", hypotheses_json)
        .replace("__APP_JS__", app_js)
        .replace("__FNCCR_LOGO_B64__", logo_fnccr_b64)
        .replace("__BDT_LOGO_B64__", logo_bdt_b64)
        .replace("__COMMUNES_JSON__", communes_json)
    )

    PUBLIC_DIR.mkdir(exist_ok=True)
    OUTPUT_FILE.write_text(output, encoding="utf-8")
    print(f"✓ {OUTPUT_FILE.relative_to(HERE)} généré ({len(output):,} caractères, {len(output)/1e6:.1f} Mo).")


if __name__ == "__main__":
    # Décommentez les lignes suivantes si vous avez édité le CSV des hypothèses
    # et/ou le référentiel communes plutôt que les JSON directement :
    # convert_csv_to_json()
    # convert_communes_csv_to_json()

    build()
