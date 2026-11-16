"""Tests des éléments d'interface : palette des cas d'usage (variables CSS, couleurs de graphiques, pictogrammes) et textes.
Usage : python3 test_interface.py   (nécessite Pillow)"""
import base64, io, re, sys
from PIL import Image

PALETTE = {"eau": "#29ABA3", "ep": "#DE9111", "energie": "#248ED5", "pav": "#556879", "bacs": "#556879", "arrosage": "#29ABA3", "inondation": "#EB7360"}
template = open("template.html", encoding="utf-8").read(); app = open("app.js", encoding="utf-8").read()
ok_global = True
def check(nom, cond, detail=""):
    global ok_global; ok_global &= bool(cond); print(f"  [{'OK' if cond else 'ÉCHEC'}] {nom}" + (f" — {detail}" if detail else ""))
def rgb(h): return tuple(int(h[i:i+2], 16) for i in (1, 3, 5))
def lum(c):
    f = lambda v: v / 255 / 12.92 if v / 255 <= 0.03928 else ((v / 255 + 0.055) / 1.055) ** 2.4
    r, g, b = (f(v) for v in c); return 0.2126 * r + 0.7152 * g + 0.0722 * b
def contraste(a, b):
    la, lb = sorted((lum(rgb(a)), lum(rgb(b))), reverse=True); return (la + 0.05) / (lb + 0.05)

print("1) Variables CSS des cartes de cas d'usage")
for cas, h in PALETTE.items():
    v600 = re.search(rf"--cas-{cas}-600:(#[0-9A-Fa-f]{{6}});", template).group(1).upper()
    v700 = re.search(rf"--cas-{cas}-700:(#[0-9A-Fa-f]{{6}});", template).group(1).upper()
    v100 = re.search(rf"--cas-{cas}-100:(#[0-9A-Fa-f]{{6}});", template).group(1).upper()
    check(f"{cas} : couleur imposée {h} en bordure (600)", v600 == h)
    check(f"{cas} : texte des pastilles lisible (contraste ≥ 4,5:1)", contraste(v700, v100) >= 4.5, f"{contraste(v700, v100):.2f}:1")
for vieux in ("energie", "pav", "bacs", "arrosage", "inondation"):
    check(f"plus de référence à l'ancienne variable --{vieux}-*", f"var(--{vieux}-" not in template and f"--{vieux}-600:" not in template)
check("la couleur d'interface générale (--eau-*, FNCCR) est inchangée", "--eau-600:#004C92;" in template and "input.search:focus{outline:none;border-color:var(--eau-600)" in template)

print("2) Couleurs des graphiques (CAS_CONFIG)")
for cas, h in PALETTE.items():
    fn = {"eau": "calculEauAvecOptions", "ep": "calculEPAvecOptions", "energie": "calculEnergieBatimentsAvecOptions", "pav": "calculDechetsPAVAvecOptions",
          "bacs": "calculDechetsBacsAvecOptions", "arrosage": "calculArrosageAvecOptions", "inondation": "calculInondationAvecOptions"}[cas]
    m = re.search(rf'calc: {fn}, colorDark: "(#[0-9A-Fa-f]{{6}})"', app)
    check(f"{cas} : barres de dépenses {h}", m and m.group(1).upper() == h)

print("3) Pictogrammes : même tracé, couleur du cas d'usage")
for cas, h in PALETTE.items():
    data = re.search(rf'^  {cas}: "data:image/png;base64,([^"]*)",$', app, flags=re.M).group(1)
    im = Image.open(io.BytesIO(base64.b64decode(data))).convert("RGBA"); px = [p for p in im.getdata() if p[3] > 0]
    couleurs = {p[:3] for p in px}
    check(f"{cas} : pictogramme entièrement en {h}", couleurs == {rgb(h)} and len(px) > 0.02 * im.width * im.height, f"{len(px)} pixels opaques, {len(couleurs)} couleur(s)")

print("4) Textes")
check("bandeau « économisés » sans « argument de mutualisation »", "argument de mutualisation" not in app.lower())
check("sortie Python alignée (« Économie de mutualisation »)", "Argument de mutualisation" not in open("moteur_calcul.py", encoding="utf-8").read())
print("\n>>> TOUS LES TESTS PASSENT" if ok_global else "\n>>> ÉCHEC")
sys.exit(0 if ok_global else 1)
