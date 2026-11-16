"""Tests du cas d'usage « Surveillance inondation » : réconciliation avec l'Excel V1.2 (version 4) et parité Python / JS.
Usage : python3 test_inondation.py [chemin_excel.xlsx]   (nécessite openpyxl et node ; l'Excel est facultatif : sans lui, seule la parité est testée)"""
import json, subprocess, sys, os
import pandas as pd
import moteur_calcul as m
from moteur_calcul import Referentiel, run, CAS_INONDATION

EXCEL = sys.argv[1] if len(sys.argv) > 1 else "/mnt/user-data/uploads/3e_OTCD_extrapolation_V1_2__4_.xlsx"
ref = Referentiel("hypotheses_mon_territoire.csv", "communes-france-2026.csv")
p = m.get_parametres_inondation(ref)
ok_global = True
def check(nom, cond, detail=""):
    global ok_global
    ok_global &= bool(cond)
    print(f"  [{'OK' if cond else 'ÉCHEC'}] {nom}" + (f" — {detail}" if detail else ""))
def rel(a, b): return abs(a - b) / max(abs(b), 1e-12)

# ------------------------------------------------------------------ 1) réconciliation avec l'Excel
if os.path.exists(EXCEL):
    import openpyxl
    ws = openpyxl.load_workbook(EXCEL, data_only=True)["Prévention Inondation"]
    X = lambda c: float(ws[c].value or 0)
    COLS = "HIJKLMNOPQR"                                    # 2026 … 2036
    print("1) Réconciliation avec l'Excel (onglet Prévention Inondation)")
    # a) dommages nationaux par niveau de vigilance et par année (lignes 3 à 5, avec croissance de 2,5 %/an)
    err = max(rel(m.dommages_nationaux_niveau(p, n, 2026 + i), X(f"{c}{ligne}"))
              for i, c in enumerate(COLS) for n, ligne in ((3, 3), (2, 4), (1, 5)))
    check("dommages nationaux par niveau, 2026-2036 (lignes 3-5)", err < 1e-12, f"écart relatif max {err:.1e}")
    # b) coût d'UN territoire équipé = ligne Excel de l'année 2026 ÷ nombre de territoires nouvellement équipés
    n_new = (X("H6") - X("G6"))
    tr = m.calcul_inondation_avec_options(ref, [pd.Series({"nom_standard": "T", "population": 1000.0, "vigilance": 3})], {"annee_deploiement": 2027}).trajectoire.iloc[0]
    for libelle, cle, cellule in (("CAPEX stations", "capex", "H22"), ("OPEX transmission", "opex_transmission", "H26"), ("OPEX serveurs", "opex_serveurs", "H30"),
                                  ("OPEX logiciels", "opex_logiciels", "H34"), ("OPEX exploitation-maintenance", "opex_exploitation_maintenance", "H38"),
                                  ("conduite du changement", "opex_conduite_changement", "H42")):
        check(f"{libelle} par territoire (Excel {cellule} ÷ {n_new:.2f} territoires)", rel(tr[cle], X(cellule) / n_new) < 1e-12, f"{tr[cle]:,.0f} €".replace(",", " "))
    # c) coûts récurrents des années suivantes : par territoire équipé (stock), tous les ans
    err = 0.0
    for c in "IJKLMNOPQR":
        stock = X(f"{c}6") - X("G6")
        for cle_xl, cle in ((26, "opex_transmission"), (30, "opex_serveurs"), (34, "opex_logiciels")):
            err = max(err, rel(X(f"{c}{cle_xl}") / stock, tr[cle]))
        err = max(err, rel(X(f"{c}38") / stock, tr["opex_exploitation_maintenance"]))        # 12 % du CAPEX cumulé + 40 k€ : 94 k€ par territoire et par an
    check("coûts récurrents par territoire équipé, 2027-2036", err < 1e-12, f"écart relatif max {err:.1e}")
    # d) dommages évités : Excel H14 = H3 × 50 % × 10 % × (territoires équipés ÷ total) ; à fraction de population égale, mon calcul doit coïncider
    err = 0.0
    for i, c in enumerate("IJKLMNOPQR"):
        phi = (X(f"{c}7") - X("G7")) / X("C7")                                   # fraction du groupe 3 déjà équipée
        nat = dict(population_nationale=1e9, population_par_vigilance={1: 1e8, 2: 1e8, 3: 1e8})
        com = [pd.Series({"nom_standard": "T", "population": phi * 1e8, "vigilance": 3})]
        ov = {"annee_deploiement": 2027, "national": nat}
        ref_mode = ref.hyp.copy(); ref_mode.loc[(ref_mode.cas_usage == CAS_INONDATION) & ref_mode.hypothese.str.startswith("Base de répartition"), "valeur"] = 1
        ref2 = Referentiel.__new__(Referentiel); ref2.__dict__.update(ref.__dict__); ref2.hyp = ref_mode        # base « population du groupe »
        r = m.calcul_inondation_avec_options(ref2, com, ov).trajectoire.iloc[i]
        err = max(err, rel(r["dommages_evites"], X(f"{c}14")))
    check("dommages évités du groupe fort, 2027-2036 (ligne 14)", err < 1e-12, f"écart relatif max {err:.1e}")
    # e) bilans environnementaux de l'année 2026 : ÷ territoires équipés
    ti = m.calcul_inondation_avec_options(ref, [pd.Series({"nom_standard": "T", "population": 1000.0, "vigilance": 3})], {"annee_deploiement": 2027}).trajectoire.iloc[0]
    check("bilan net CO2 par territoire (Excel H110, tCO2e)", rel(ti["impact_co2_kg"] / 1000, X("H110") / n_new) < 1e-12, f"{ti['impact_co2_kg']:.1f} kgCO2e")
    check("bilan net énergie par territoire (Excel H111, kWh)", rel(ti["impact_energie_kwh"], X("H111") / n_new) < 1e-12, f"{ti['impact_energie_kwh']:.1f} kWh")
else:
    print("1) Réconciliation Excel ignorée (fichier introuvable) :", EXCEL)

# ------------------------------------------------------------------ 1 bis) spécification : 50 % des dommages évités chaque année dès le déploiement
print("1 bis) Dommages évités : 50 % de dommages adressables × 10 % d'évitement net = 5 % (règle de l'Excel)")
check("hypothèses par défaut : 50 % adressable, 10 % d'évitement net", p["part_adressable"] == 0.5 and p["taux_evitement"] == 0.1)
_t = m.calcul_inondation_avec_options(ref, [pd.Series({"nom_standard": "T", "population": 100000.0, "vigilance": 3})], {"annee_deploiement": 2030}).trajectoire
check("dommages évités = 5 % des dommages dès 2030, 0 avant", all(rel(r.dommages_evites, 0.05 * r.dommages_territoire) < 1e-12 if r.annee >= 2030 else r.dommages_evites == 0 for r in _t.itertuples()))

# ------------------------------------------------------------------ 2) parité Python / JS
print("2) Parité Python / JS (territoires et dates de déploiement variés)")
js = r"""
const e = require('./engine.js'); const fs = require('fs');
const hyp = JSON.parse(fs.readFileSync('hypotheses.json','utf-8')); const raw = JSON.parse(fs.readFileSync('communes.json','utf-8'));
const toC = r => ({code_insee:r[0], nom_standard:r[1], dep_code:r[2], epci_code:r[4], population:r[6], vigilance:r[10]});
const all = raw.map(toC); const nat = e.contexteNationalDepuisCommunes(all);
const cas = JSON.parse(process.argv[1]); const out = {};
for (const c of cas) {
  const sel = c.type === 'commune' ? all.filter(x => x.code_insee === c.code) : c.type === 'dep' ? all.filter(x => x.dep_code === c.code) : all.filter(x => x.epci_code === c.code);
  const r = e.calculInondationAvecOptions(hyp, sel, {anneeDeploiement: c.annee, national: nat});
  const S = k => r.trajectoire.reduce((a, x) => a + x[k], 0);
  out[c.cle] = {dommages: S('dommages_territoire'), evites: S('externalites_totales'), depenses: S('depenses_totales'), co2: S('bilan_net_co2_kg'), energie: S('bilan_net_energie_kwh'), n: sel.length};
}
console.log(JSON.stringify(out));
"""
cas = [dict(cle="roanne-2030", type="commune", code="42187", annee=2030), dict(cle="yonne-2026", type="dep", code="89", annee=2026),
       dict(cle="rhone-2036", type="dep", code="69", annee=2036), dict(cle="paris-2028", type="commune", code="75056", annee=2028),
       dict(cle="rural-2031", type="commune", code="15081", annee=2031), dict(cle="epci-pays-basque-2029", type="epci", code="200067106", annee=2029)]
res = json.loads(subprocess.run(["node", "-e", js, json.dumps(cas)], capture_output=True, text=True, check=True).stdout)
C = ref.communes
for c in cas:
    if c["type"] == "commune": sel = C[C.code_insee.astype(str).str.zfill(5) == c["code"]]
    elif c["type"] == "dep": sel = C[C.dep_code.astype(str) == c["code"]]
    else: sel = C[C.epci_code.astype(str) == c["code"]]
    r = m.calcul_inondation_avec_options(ref, [row for _, row in sel.iterrows()], {"annee_deploiement": c["annee"]})
    t = r.trajectoire; j = res[c["cle"]]
    py = dict(dommages=t.dommages_territoire.sum(), evites=r.total_externalites, depenses=r.total_depenses, co2=t.bilan_net_co2_kg.sum(), energie=t.bilan_net_energie_kwh.sum())
    err = max(rel(py[k], j[k]) for k in py)
    check(f"{c['cle']} ({len(sel)} communes ; JS : {j['n']})", err < 1e-9 and len(sel) == j["n"], f"écart relatif max {err:.1e}")

# ------------------------------------------------------------------ 2 bis) sens de lecture des bilans énergie et CO2 (affichage)
print("2 bis) Sens de lecture des bilans net énergie et CO2 dans la sortie texte")
import io, contextlib
def affichage(res):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf): m.afficher_bilan_environnemental(res)
    return buf.getvalue()
sortie = affichage(m.calcul_inondation_avec_options(ref, [pd.Series({"nom_standard": "T", "population": 1000.0, "vigilance": 3})], {"annee_deploiement": 2030}))
check("inondation (consommation sans économie) : signe +", "Bilan net énergie                  +" in sortie and "Bilan net CO2                       +" in sortie)
roanne = ref.find_commune("Roanne")
res_en = m.calcul_energie_batiments_avec_options(ref, [roanne], {"petit": {"pct_2036": 0.6}, "grand": {"pct_2036": 0.6}})
check("énergie des bâtiments (économies nettes) : signe -", res_en.trajectoire["bilan_net_energie_kwh"].sum() > 0 and "Bilan net énergie                  -" in affichage(res_en))
check("colonnes de données inchangées (bénéfices − émissions)", (res_en.trajectoire["bilan_net_co2_kg"] == res_en.trajectoire["benefice_co2_kg"] - res_en.trajectoire["impact_co2_kg"]).all())

# ------------------------------------------------------------------ 3) validation de la date
print("3) Validation de la date de déploiement")
com = [pd.Series({"nom_standard": "T", "population": 1000.0, "vigilance": 2})]
for v in (None, 2025, 2037, 2030.5, "abc", True):
    try: m.calcul_inondation_avec_options(ref, com, {"annee_deploiement": v}); check(f"date {v!r} refusée", False)
    except ValueError as e: check(f"date {v!r} refusée", "obligatoire" in str(e))
# ------------------------------------------------------------------ 4) silo vs mutualisé : détail par cas d'usage
print("4) Silo vs mutualisé : détail par cas d'usage (somme des cas = totaux ; parité Python / JS)")
js_mut = r"""
const e = require('./engine.js'); const fs = require('fs');
const hyp = JSON.parse(fs.readFileSync('hypotheses.json','utf-8')); const raw = JSON.parse(fs.readFileSync('communes.json','utf-8'));
const toC = r => ({code_insee:r[0], nom_standard:r[1], dep_code:r[2], dep_nom:r[3], epci_code:r[4], epci_nom:r[5], population:r[6], nombre_menages:r[7], Strate:r[8], nombre_points_livraison:r[9], vigilance:r[10]});
const out = {};
for (const code of JSON.parse(process.argv[1])) {
  const c = toC(raw.find(r => r[0] === code)); const o = {pct2036: 0.6};
  const res = [e.calculEauAvecOptions(hyp, [c], o), e.calculEPAvecOptions(hyp, [c], o), e.calculDechetsPAVAvecOptions(hyp, [c], o), e.calculDechetsBacsAvecOptions(hyp, [c], o)];
  const m = e.calculMutualisation(res, 1.0);
  out[code] = { parCas: m.parCas, totaux: {depensesSilo: m.depensesSilo, depensesMutualise: m.depensesMutualise, economieTotale: m.economieTotale, externalites: m.externalites} };
}
console.log(JSON.stringify(out));
"""
codes = ["42187", "15081"]                                   # une grande commune (Roanne) et une petite commune rurale
jm = json.loads(subprocess.run(["node", "-e", js_mut, json.dumps(codes)], capture_output=True, text=True, check=True).stdout)
cas_py = [m.calcul_eau_avec_options, m.calcul_ep_avec_options, m.calcul_dechets_pav_avec_options, m.calcul_dechets_bacs_avec_options]
for code in codes:
    commune = ref.communes[ref.communes.code_insee.astype(str).str.zfill(5) == code].iloc[0]
    res = [f(ref, [commune], {"pct_2036": 0.6}) for f in cas_py]
    mut = m.calcul_mutualisation(res)
    j = jm[code]; pc = mut.par_cas
    cles = (("depensesSilo", "depenses_silo"), ("depensesMutualise", "depenses_mutualise"), ("economie", "economie"), ("externalites", "externalites"),
            ("soldeSilo", "solde_silo"), ("soldeMutualise", "solde_mutualise"))
    err_parite = max(rel(pc[i][kp], j["parCas"][i][kj]) for i in range(4) for kj, kp in cles)
    check(f"{commune['nom_standard']} : détail par cas identique en Python et en JS", len(pc) == 4 and err_parite < 1e-9, f"écart relatif max {err_parite:.1e}")
    check(f"{commune['nom_standard']} : la somme des cas redonne les totaux (silo, mutualisé, économie, bénéfices)",
          rel(sum(c["depenses_silo"] for c in pc), mut.depenses_silo) < 1e-12 and rel(sum(c["depenses_mutualise"] for c in pc), mut.depenses_mutualise) < 1e-12
          and rel(sum(c["economie"] for c in pc), mut.economie_totale) < 1e-12 and rel(sum(c["solde_mutualise"] for c in pc), mut.solde_mutualise) < 1e-9)
    check(f"{commune['nom_standard']} : mutualisé = silo − économie, pour chaque cas",
          all(abs(c["depenses_mutualise"] - (c["depenses_silo"] - c["economie"])) < 1e-6 and c["economie"] > 0 for c in pc))
    check(f"{commune['nom_standard']} : ordre des cas = ordre des résultats", [c["cas_usage"] for c in pc] == [r.cas_usage for r in res])

print("\n>>> TOUS LES TESTS PASSENT" if ok_global else "\n>>> ÉCHEC")
sys.exit(0 if ok_global else 1)
