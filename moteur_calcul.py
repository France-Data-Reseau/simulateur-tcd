"""
Moteur de calcul "Mon territoire local" — cas d'usage Eau (télérelève) et Éclairage public.

Entrées :
  - hypotheses_mon_territoire.csv  : hypothèses unitaires par strate, pour 6 cas d'usage
    (issues du modèle
    national 3e_OTCD_extrapolation_V0_8.xlsx, onglets PILOTAGE / Eau / EP)
  - communes-france-2026.csv             : référentiel communes (population, ménages, strate)

Sortie : trajectoire 2026-2035 (dépenses, externalités, solde) pour une commune donnée,
cas d'usage Eau et/ou Éclairage public.

AVERTISSEMENT — simplifications assumées par rapport au modèle national V0.8 :
  1. Le modèle national distingue "compteurs télérelevés" et, parmi eux, la part "en réseau
     LoRa/NB-IoT" (vs radio-relève). Ce moteur simplifie en un seul flux "compteurs connectés
     / télérelevés" : toutes les économies et coûts de connectivité s'appliquent au même stock.
  2. Le volume d'eau consommé par abonné est maintenu constant à 120 m³/an (le modèle national
     applique une légère décroissance liée au Plan Eau, non reprise ici par souci de
     simplicité — hypothèse absente du panneau PILOTAGE).
  3. La densité de points lumineux par habitant (Éclairage public) n'est documentée dans le
     modèle national que par grande catégorie (métropole / urbain-périurbain / rural), pas
     séparément pour les 4 strates. Ce moteur applique : Métropole = 1 PL/15 hab,
     urbaine et intermédiaire = 1 PL/6 hab, rurale = 1 PL/4 hab. À faire valider/affiner.
  4. La mutualisation inter-cas d'usage (abattements réseau/serveurs/logiciels/E&M/conduite du
     changement du panneau PILOTAGE) n'est PAS appliquée ici : les deux cas d'usage sont
     calculés en silo, comme le préconise la première version du simulateur.

Auteur : moteur généré pour l'atelier FNCCR "Mon territoire local"
"""

from __future__ import annotations
import unicodedata
import argparse
import json
import re
import sys
from dataclasses import dataclass, field

import pandas as pd

# ------------------------------------------------------------------------------------
# Constantes générales
# ------------------------------------------------------------------------------------

START_YEAR = 2027
END_YEAR = 2036          # 10 ans, 2026 = année de référence saisie/dérivée
BASE_YEAR = 2026
ANNEE_BASE_EXCEL = 2025  # colonne G de l'Excel (« 2025 et précédemment ») : origine de la montée en charge des économies d'eau de l'arrosage
YEARS = list(range(START_YEAR, END_YEAR + 1))

# Correspondance entre la colonne "Strate" du fichier communes et les libellés du
# fichier hypothèses (issus du modèle national). Clés en minuscule/sans accent : la
# résolution passe par _normalize() pour tolérer casse, espaces et pertes d'accent
# (ex. fichier réexporté depuis Excel en Windows-1252, qui corrompt "intermédiaire").
STRATE_MAP = {
    "metropole": "Métropole",
    "urbaine": ">30k hab",
    "intermediaire": "2-30k hab",
    "rurale": "<2k hab",
}


def resolve_strate(commune: pd.Series) -> str:
    """Résout la strate d'une commune en trois passes de plus en plus tolérantes —
    le fichier communes existe dans plusieurs variantes selon la source, et le
    libellé de la colonne Strate change (ex. "< 2000 hbts" au lieu de "rurale") :
      1) mot-clé exact, normalisé (accent/casse)
      2) motif dans un texte plus libre (mot-clé partiel ou seuil numérique)
      3) repli sur la population + le rattachement EPCI, toujours disponibles,
         selon les mêmes seuils que ceux observés dans le référentiel national
    """
    brut = str(commune.get("Strate", "") or "").strip()
    norm = _normalize(brut)

    exact = STRATE_MAP.get(norm)
    if exact:
        return exact

    if "metropole" in norm:
        return "Métropole"
    if "rural" in norm:
        return "<2k hab"
    if "urbain" in norm and "periurbain" not in norm:
        return ">30k hab"
    if "intermediaire" in norm:
        return "2-30k hab"

    nombres = [int(n) for n in re.findall(r"\d+", norm)]
    if nombres:
        if ("<" in norm or "moins" in norm) and nombres[0] <= 2500:
            return "<2k hab"
        if (">" in norm or "plus" in norm) and nombres[0] >= 25000:
            return ">30k hab"
        if len(nombres) >= 2 and nombres[0] <= 2500 and nombres[1] >= 25000:
            return "2-30k hab"

    population = commune.get("population")
    try:
        population = float(population)
        valide = not pd.isna(population)
    except (TypeError, ValueError):
        valide = False
    if valide:
        epci_norm = _normalize(str(commune.get("epci_nom", "") or ""))
        if "metropole" in epci_norm:
            return "Métropole"
        if population < 2000:
            return "<2k hab"
        if population < 30000:
            return "2-30k hab"
        return ">30k hab"

    raise ValueError(
        f"Strate inconnue pour la commune « {commune.get('nom_standard', '?')} » : "
        f"valeur lue « {brut or '(vide)'} », et impossible de la déduire de la population "
        f"(colonne \"population\" absente ou invalide pour cette commune). Vérifiez le fichier communes."
    )


def get_base_menages(commune: pd.Series) -> float:
    """Assiette "ménages" pour les cas d'usage qui en dépendent (Eau, Bacs individuels) :
    on privilégie le nombre de points de livraison (compteurs eau/énergie, source GRD/INSEE)
    quand il est disponible — plus précis que le nombre de ménages recensés, car il capture
    aussi les locaux professionnels et les résidences secondaires raccordés au réseau.
    Repli sur le nombre de ménages si la donnée est absente ou invalide (ex. Mayotte : le
    nombre de ménages n'est pas disponible, mais le nombre de points de livraison si)."""
    pdl = commune.get("nombre_points_livraison")
    try:
        pdl = float(pdl)
        if not pd.isna(pdl) and pdl > 0:
            return pdl
    except (TypeError, ValueError):
        pass
    return float(commune["nombre_menages"])

# Mapping pour la densité de points lumineux par habitant (cf. avertissement n°3 ci-dessus)
DENSITE_PL_STRATE = {
    "Métropole": "Métropole",
    ">30k hab": "Urbain/périurbain (≈>30k et 2-30k)",
    "2-30k hab": "Urbain/périurbain (≈>30k et 2-30k)",
    "<2k hab": "Rural (≈<2k)",
}


def _normalize(s: str) -> str:
    """Normalise un texte pour la recherche (minuscule, sans accents)."""
    s = str(s).strip().lower()
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return s


# ------------------------------------------------------------------------------------
# Chargement des données
# ------------------------------------------------------------------------------------

class Referentiel:
    """Charge et expose les deux fichiers sources (hypothèses + communes)."""

    def __init__(self, hypotheses_path: str, communes_path: str):
        self.hyp = pd.read_csv(hypotheses_path, sep=";", encoding="utf-8-sig")
        self.hyp["valeur"] = pd.to_numeric(self.hyp["valeur"], errors="coerce")

        self.communes = pd.read_csv(communes_path, encoding="utf-8-sig")
        # Contexte national du cas d'usage « Surveillance inondation » : population de TOUTES les communes du
        # fichier (dénominateur des parts de population), par niveau de vigilance — avant tout filtrage.
        self.contexte_national = (contexte_national_depuis_communes(self.communes)
                                  if "vigilance" in self.communes.columns else None)
        # Le modèle national ne couvre pas l'outre-mer par construction (hypothèses calibrées
        # sur la métropole, cf. atelier FNCCR, slide 5). Certaines communes (notamment
        # ultramarines) ont un nombre de ménages non disponible ("N/A - résultat non
        # disponible") — on les exclut seulement si population OU (ménages ET points de
        # livraison) sont indisponibles : une commune avec uniquement le nombre de points de
        # livraison renseigné (ex. Mayotte) reste utilisable pour les cas d'usage qui
        # s'appuient sur cette assiette (cf. get_base_menages).
        self.communes["nombre_menages"] = pd.to_numeric(self.communes["nombre_menages"], errors="coerce")
        self.communes["population"] = pd.to_numeric(self.communes["population"], errors="coerce")
        if "nombre_points_livraison" in self.communes.columns:
            self.communes["nombre_points_livraison"] = pd.to_numeric(
                self.communes["nombre_points_livraison"], errors="coerce"
            )
        else:
            self.communes["nombre_points_livraison"] = float("nan")
        avant = len(self.communes)
        assiette_disponible = self.communes["nombre_menages"].notna() | self.communes["nombre_points_livraison"].notna()
        self.communes = self.communes[
            self.communes["population"].notna() & self.communes["Strate"].notna() & assiette_disponible
        ].copy()
        exclues = avant - len(self.communes)
        if exclues:
            print(f"[Référentiel] {exclues} commune(s) exclues (données manquantes, essentiellement outre-mer, "
                  f"hors périmètre du modèle national).", file=sys.stderr)
        self.communes["_nom_norm"] = self.communes["nom_standard"].apply(_normalize)

    # -- Communes ----------------------------------------------------------------
    def find_commune(self, nom: str) -> pd.Series:
        """Recherche une commune par nom (recherche exacte puis partielle)."""
        norm = _normalize(nom)
        exact = self.communes[self.communes["_nom_norm"] == norm]
        if len(exact) == 1:
            return exact.iloc[0]
        if len(exact) > 1:
            raise ValueError(
                f"Plusieurs communes correspondent exactement à « {nom} » — "
                f"précisez avec le code postal ou le département :\n"
                f"{exact[['nom_standard', 'dep_nom', 'code_postal', 'population']].to_string(index=False)}"
            )
        partial = self.communes[self.communes["_nom_norm"].str.contains(norm, na=False)]
        if len(partial) == 0:
            raise ValueError(f"Aucune commune trouvée pour « {nom} ».")
        if len(partial) > 1:
            raise ValueError(
                f"Plusieurs communes correspondent à « {nom} » — précisez :\n"
                f"{partial[['nom_standard', 'dep_nom', 'code_postal', 'population']].head(15).to_string(index=False)}"
            )
        return partial.iloc[0]

    # -- Hypothèses ----------------------------------------------------------------
    def get(self, cas_usage: str, hypothese: str, strate: str | None = None) -> float:
        """Récupère une valeur unitaire dans le fichier hypothèses."""
        df = self.hyp[(self.hyp["cas_usage"] == cas_usage) & (self.hyp["hypothese"] == hypothese)]
        if strate is not None:
            df = df[df["strate"] == strate]
        if len(df) == 0:
            raise KeyError(f"Hypothèse introuvable : cas_usage={cas_usage!r}, hypothese={hypothese!r}, strate={strate!r}")
        if len(df) > 1:
            raise KeyError(f"Hypothèse ambiguë (plusieurs lignes) : {hypothese!r} / {strate!r}")
        return float(df.iloc[0]["valeur"])


CAS_EAU = "Eau - télérelève des compteurs"
CAS_EP = "Éclairage public - armoires connectées"
CAS_ENERGIE = "Énergie des bâtiments"
CAS_PAV = "Déchets - points d'apport volontaire"
CAS_BACS = "Déchets - bacs individuels"
CAS_ARROSAGE = "Arrosage connecté"

# Barème de mutualisation : les abattements varient selon le nombre de cas d'usage
# combinés ET selon la présence ou non du cas d'usage Eau (le réseau/plateforme dédiés
# à la télérelève mutualisent différemment des autres verticales). Clé = nombre d'AUTRES
# cas d'usage combinés avec Eau (1 à 5) pour le barème "avec Eau", ou nombre total de
# cas d'usage combinés (2 à 5) pour le barème "sans Eau".
ABATTEMENTS_AVEC_EAU = {
    1: {"opex_transmission": 0.40, "opex_serveurs": 0.30, "opex_logiciels": 0.20, "opex_exploitation_maintenance": 0.15, "opex_conduite_changement": 0.10},
    2: {"opex_transmission": 0.45, "opex_serveurs": 0.35, "opex_logiciels": 0.25, "opex_exploitation_maintenance": 0.20, "opex_conduite_changement": 0.10},
    3: {"opex_transmission": 0.50, "opex_serveurs": 0.40, "opex_logiciels": 0.30, "opex_exploitation_maintenance": 0.25, "opex_conduite_changement": 0.10},
    4: {"opex_transmission": 0.55, "opex_serveurs": 0.45, "opex_logiciels": 0.35, "opex_exploitation_maintenance": 0.30, "opex_conduite_changement": 0.10},
    5: {"opex_transmission": 0.60, "opex_serveurs": 0.50, "opex_logiciels": 0.40, "opex_exploitation_maintenance": 0.35, "opex_conduite_changement": 0.10},
}
ABATTEMENTS_SANS_EAU = {
    2: {"opex_transmission": 0.25, "opex_serveurs": 0.20, "opex_logiciels": 0.10, "opex_exploitation_maintenance": 0.05, "opex_conduite_changement": 0.10},
    3: {"opex_transmission": 0.30, "opex_serveurs": 0.25, "opex_logiciels": 0.15, "opex_exploitation_maintenance": 0.10, "opex_conduite_changement": 0.10},
    4: {"opex_transmission": 0.35, "opex_serveurs": 0.30, "opex_logiciels": 0.20, "opex_exploitation_maintenance": 0.15, "opex_conduite_changement": 0.10},
    5: {"opex_transmission": 0.40, "opex_serveurs": 0.35, "opex_logiciels": 0.25, "opex_exploitation_maintenance": 0.20, "opex_conduite_changement": 0.10},
}


def get_abattements_mutualisation(resultats: list["ResultatCasUsage"]) -> dict:
    """Sélectionne le barème d'abattements applicable à une combinaison de résultats."""
    has_eau = any(r.cas_usage == CAS_EAU for r in resultats)
    total = len(resultats)
    if has_eau:
        autres = min(total - 1, 5)
        return ABATTEMENTS_AVEC_EAU[autres]
    return ABATTEMENTS_SANS_EAU[min(max(total, 2), 5)]


# ------------------------------------------------------------------------------------
# Résultat structuré
# ------------------------------------------------------------------------------------

@dataclass
class ResultatCasUsage:
    cas_usage: str
    commune: str
    strate: str
    trajectoire: pd.DataFrame          # une ligne par année : dépenses, externalités, solde, détail
    total_depenses: float = field(init=False)
    total_externalites: float = field(init=False)
    solde: float = field(init=False)

    def __post_init__(self):
        self.total_depenses = self.trajectoire["depenses_totales"].sum()
        self.total_externalites = self.trajectoire["externalites_totales"].sum()
        self.solde = self.total_externalites - self.total_depenses


# ------------------------------------------------------------------------------------
# Calcul — Eau : télérelève des compteurs
# ------------------------------------------------------------------------------------

def taux_compounding_fn(taux_base: float, croissance: float):
    """Trajectoire de taux de connexion "par défaut" : croissance composée depuis le
    taux de base, plafonnée à 100 %."""
    def fn(year):
        return min(taux_base * (1 + croissance) ** (year - BASE_YEAR), 1.0)
    return fn


def taux_linear_fn(taux_2026: float, pct_cible: float):
    """Trajectoire de taux de connexion "saisie manuelle" : interpolation linéaire entre
    le taux de l'année de référence (2026, dérivé ou fourni) et la cible utilisateur
    pour 2036 — robuste même quand le taux 2026 vaut 0."""
    n_total = END_YEAR - BASE_YEAR  # 10

    def fn(year):
        n = year - BASE_YEAR
        return max(0.0, min(1.0, taux_2026 + (pct_cible - taux_2026) * (n / n_total)))
    return fn


def valider_coherence_objets(overrides: dict | None, label_cas_usage: str, objet_label: str):
    """Le nombre d'objets connectés ne peut pas dépasser le nombre total d'objets."""
    if (overrides and overrides.get("nombre_objets") is not None
            and overrides.get("nombre_objets_connectes") is not None
            and overrides["nombre_objets_connectes"] > overrides["nombre_objets"]):
        de = "d'" if objet_label[:1].lower() in "aeiouh" else "de "
        raise ValueError(
            f"{label_cas_usage} : le nombre {de}{objet_label} connecté(e)s "
            f"({overrides['nombre_objets_connectes']}) ne peut pas dépasser le nombre total "
            f"{de}{objet_label} ({overrides['nombre_objets']})."
        )


def get_parametres_eau(ref: Referentiel, strate: str) -> dict:
    return dict(
        croissance_parc=ref.get(CAS_EAU, "Croissance du parc de compteurs", "Toutes strates"),
        taux_connexion_base=ref.get(CAS_EAU, "Taux de compteurs télérelevés (base 2025)", "Toutes strates"),
        croissance_connexion=ref.get(CAS_EAU, "Croissance du parc télérelevé", "Toutes strates"),
        volume_par_abonne=ref.get(CAS_EAU, "Volume consommé par abonné", "Toutes strates"),
        taux_eco_eau=ref.get(CAS_EAU, "Économie d'eau générée par la télérelève", "Toutes strates"),
        valorisation_eau=ref.get(CAS_EAU, "Valorisation de l'eau économisée", "Toutes strates"),
        eco_releve=ref.get(CAS_EAU, "Économie de relève (technicien index)", strate),
        eco_deplacement=ref.get(CAS_EAU, "Économie déplacement (carburant technicien index)", strate),
        capex_unitaire=ref.get(CAS_EAU, "CAPEX fourni-posé compteur communicant (part numérique 50%)", strate),
        opex_transmission=ref.get(CAS_EAU, "Transmission réseau (LoRa/NB-IoT)", strate),
        opex_serveurs=ref.get(CAS_EAU, "Serveurs et hébergement", "Toutes strates"),
        opex_logiciels=ref.get(CAS_EAU, "Logiciel SAAS exploitation données", strate),
        taux_em=ref.get(CAS_EAU, "Exploitation-maintenance (% du CAPEX cumulé installé)", strate),
        cout_conduite_changement=ref.get(
            CAS_EAU, "Conduite du changement / data science (1 ETP 70 000€ / 100 000 compteurs)", strate),
        fabrication_energie=ref.get(CAS_EAU, "Énergie grise de fabrication", "Toutes strates"),
        fabrication_co2=ref.get(CAS_EAU, "CO2 de fabrication", "Toutes strates"),
        install_km=ref.get(CAS_EAU, "Déplacement d'installation", "Toutes strates"),
        usage_energie_an=ref.get(CAS_EAU, "Consommation capteur + transmission + plateforme", "Toutes strates"),
        mix_elec=ref.get(CAS_EAU, "Mix électrique français", "Toutes strates"),
        emission_vehicule=ref.get(CAS_EAU, "Émission véhicule utilitaire léger", "Toutes strates"),
        km_releve_evites=ref.get(CAS_EAU, "Kilomètres de relève évités par compteur connecté", "Toutes strates"),
        energie_recyclage=ref.get(CAS_EAU, "Énergie de recyclage des compteurs en fin de vie", "Toutes strates"),
        co2_recyclage=ref.get(CAS_EAU, "CO2 de recyclage des compteurs en fin de vie", "Toutes strates"),
        part_maintenance_corrective=ref.get(CAS_EAU, "Part de maintenance corrective rapportée aux km de relève évités", "Toutes strates"),
        co2_evite_traitement_eau=ref.get(CAS_EAU, "CO2 évité par traitement d'eau non consommée", "Toutes strates"),
    )


def calcul_eau_depuis_parc(params: dict, parc_2026: float, taux_fn) -> pd.DataFrame:
    rows = []
    stock_connecte_prec = parc_2026 * taux_fn(BASE_YEAR)
    stock_ref = stock_connecte_prec  # parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

    for year in YEARS:
        n = year - BASE_YEAR
        parc_total = parc_2026 * (1 + params["croissance_parc"]) ** n
        taux_connexion = taux_fn(year)
        stock_connecte = parc_total * taux_connexion
        nouveaux = max(stock_connecte - stock_connecte_prec, 0.0)
        stock_add = max(stock_connecte - stock_ref, 0.0)  # parc connecté AJOUTÉ depuis l'année de référence

        capex = nouveaux * params["capex_unitaire"]
        opex_trans = stock_add * params["opex_transmission"]
        opex_serv = stock_connecte * params["opex_serveurs"]
        opex_log = stock_add * params["opex_logiciels"]
        em = stock_add * params["capex_unitaire"] * params["taux_em"]
        conduite = nouveaux * params["cout_conduite_changement"]
        depenses = capex + opex_trans + opex_serv + opex_log + em + conduite

        eco_eau_m3 = stock_add * params["volume_par_abonne"] * params["taux_eco_eau"]
        benefice_eau = eco_eau_m3 * params["valorisation_eau"]
        benefice_releve = stock_add * params["eco_releve"]
        benefice_deplacement = stock_add * params["eco_deplacement"]
        externalites = benefice_eau + benefice_releve + benefice_deplacement

        # Émissions : fabrication + usage + pose + recyclage (l.177) + maintenance corrective (l.176 : 20 % des km de relève évités)
        impact_energie = nouveaux * (params["fabrication_energie"] + params["energie_recyclage"]) + stock_add * params["usage_energie_an"]
        impact_co2 = (nouveaux * (params["fabrication_co2"] + params["co2_recyclage"]) + (stock_add * params["usage_energie_an"]) * params["mix_elec"]
                      + nouveaux * params["install_km"] * params["emission_vehicule"]
                      + stock_add * params["km_releve_evites"] * params["emission_vehicule"] * params["part_maintenance_corrective"])
        # CO2 évité : traitement de l'eau non consommée (Excel l.171) + déplacements de relève évités (l.175)
        benefice_co2_physique = eco_eau_m3 * params["co2_evite_traitement_eau"] + stock_add * params["km_releve_evites"] * params["emission_vehicule"]

        rows.append(dict(
            annee=year,
            parc_total_compteurs=parc_total,
            stock_compteurs_connectes=stock_connecte,
            nouveaux_compteurs_connectes=nouveaux,
            volume_eau_total_m3=parc_total * params["volume_par_abonne"],
            volume_eau_connecte_m3=stock_connecte * params["volume_par_abonne"],
            volume_eau_economise_m3=eco_eau_m3,
            capex=capex,
            opex_transmission=opex_trans,
            opex_serveurs=opex_serv,
            opex_logiciels=opex_log,
            opex_exploitation_maintenance=em,
            opex_conduite_changement=conduite,
            depenses_totales=depenses,
            benefice_economie_eau=benefice_eau,
            benefice_economie_releve=benefice_releve,
            benefice_economie_deplacement=benefice_deplacement,
            externalites_totales=externalites,
            solde_annuel=externalites - depenses,
            impact_energie_kwh=impact_energie,
            impact_co2_kg=impact_co2,
            benefice_energie_kwh=0.0,
            benefice_co2_kg=benefice_co2_physique,
            bilan_net_energie_kwh=0.0 - impact_energie,
            bilan_net_co2_kg=benefice_co2_physique - impact_co2,
            bilan_net_eau_m3=eco_eau_m3,
        ))
        stock_connecte_prec = stock_connecte

    return pd.DataFrame(rows)


def calcul_eau(ref: Referentiel, commune: pd.Series) -> ResultatCasUsage:
    strate = resolve_strate(commune)
    params = get_parametres_eau(ref, strate)
    menages = get_base_menages(commune)
    traj = calcul_eau_depuis_parc(params, menages, taux_compounding_fn(params["taux_connexion_base"], params["croissance_connexion"]))
    return ResultatCasUsage(CAS_EAU, commune["nom_standard"], strate, traj)


def calcul_eau_override(ref: Referentiel, communes: list, overrides: dict) -> ResultatCasUsage:
    if overrides.get("pct_2036") is None:
        raise ValueError("Eau : le % de compteurs connectés attendu en 2036 doit être renseigné dès que le nombre de compteurs est saisi.")
    valider_coherence_objets(overrides, "Eau", "compteurs")
    per_commune = [(get_parametres_eau(ref, resolve_strate(c)), get_base_menages(c)) for c in communes]
    poids_total = sum(poids for _, poids in per_commune) or 1.0
    blended = {}
    for k in per_commune[0][0]:
        blended[k] = sum(p[k] * poids for p, poids in per_commune) / poids_total

    parc_2026 = overrides.get("nombre_objets") if overrides.get("nombre_objets") is not None else poids_total
    if overrides.get("nombre_objets_connectes") is not None:
        taux_2026 = (overrides["nombre_objets_connectes"] / parc_2026) if parc_2026 > 0 else 0.0
    else:
        taux_2026 = blended["taux_connexion_base"]

    traj = calcul_eau_depuis_parc(blended, parc_2026, taux_linear_fn(taux_2026, overrides["pct_2036"]))
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resolve_strate(communes[0]) if len(communes) == 1 else f"Multi-strates (moyenne pondérée sur {len(communes)} communes)"
    return ResultatCasUsage(CAS_EAU, label, strate, traj)


def calcul_eau_cible_seule(ref: Referentiel, communes: list, pct_2036: float) -> ResultatCasUsage:
    """Ni le nombre de compteurs ni le nombre de connectés ne sont saisis, mais une cible
    2036 l'est : le parc reste dérivé de la population (commune par commune, comme le mode
    automatique), mais le taux de connexion suit une trajectoire linéaire depuis le taux
    2026 du modèle jusqu'à la cible saisie, au lieu de la croissance composée par défaut."""
    resultats = []
    for c in communes:
        strate = resolve_strate(c)
        params = get_parametres_eau(ref, strate)
        menages = get_base_menages(c)
        traj = calcul_eau_depuis_parc(params, menages, taux_linear_fn(params["taux_connexion_base"], pct_2036))
        resultats.append(ResultatCasUsage(CAS_EAU, c["nom_standard"], strate, traj))
    traj_totale = sum(r.trajectoire.set_index("annee") for r in resultats).reset_index()
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resultats[0].strate if len(communes) == 1 else "Multi-strates"
    return ResultatCasUsage(CAS_EAU, label, strate, traj_totale)


def calcul_eau_avec_options(ref: Referentiel, communes: list, overrides: dict | None) -> ResultatCasUsage:
    ov = overrides or {}
    if ov.get("pct_2036") is None:
        raise ValueError("Eau : le % de compteurs connectés attendu en 2036 est obligatoire pour ce cas d'usage.")
    objets_vides = ov.get("nombre_objets") is None and ov.get("nombre_objets_connectes") is None
    if objets_vides:
        return calcul_eau_cible_seule(ref, communes, ov["pct_2036"])
    return calcul_eau_override(ref, communes, ov)


# ------------------------------------------------------------------------------------
# Calcul — Éclairage public : armoires connectées
# ------------------------------------------------------------------------------------

def get_parametres_ep(ref: Referentiel, strate: str) -> dict:
    strate_densite = DENSITE_PL_STRATE[strate]
    conso_nationale_mwh = ref.get(CAS_EP, "Consommation nationale d'éclairage public (référence, pour info)", "Toutes strates")
    parc_national_pl = ref.get(CAS_EP, "Parc national de points lumineux (référence 2025)", "Toutes strates")
    return dict(
        croissance_pl=ref.get(CAS_EP, "Croissance du parc de points lumineux", "Toutes strates"),
        densite_hab_par_pl=ref.get(CAS_EP, "Densité de points lumineux par habitant (repère entretiens Nantes Métropole / USEDA)", strate_densite),
        ratio_pl_par_armoire=ref.get(CAS_EP, "Ratio points lumineux par armoire de commande", strate),
        taux_connexion_base=ref.get(CAS_EP, "Taux d'armoires connectées (base 2025)", strate),
        croissance_connexion=ref.get(CAS_EP, "Croissance annuelle du taux d'armoires connectées", strate),
        conso_par_pl_mwh=conso_nationale_mwh / parc_national_pl,
        prix_elec=ref.get(CAS_EP, "Prix de l'électricité", "Toutes strates"),
        taux_eco_numerique=ref.get(CAS_EP, "Économie d'énergie attribuable au numérique (hors effet LED)", "Toutes strates"),
        eco_deplacement_technicien=ref.get(CAS_EP, "Économie déplacement technicien armoire", strate),
        eco_deplacement_carburant=ref.get(CAS_EP, "Économie déplacement (carburant technicien armoire)", strate),
        capex_unitaire=ref.get(CAS_EP, "CAPEX fourni-posé armoire communicante", strate),
        opex_transmission=ref.get(CAS_EP, "Transmission réseau (mix LoRa/cellulaire)", "Toutes strates"),
        opex_serveurs=ref.get(CAS_EP, "Serveurs et hébergement", "Toutes strates"),
        opex_logiciels=ref.get(CAS_EP, "Logiciel SAAS / hypervision", strate),
        taux_em=ref.get(CAS_EP, "Exploitation-maintenance (% du CAPEX cumulé installé)", strate),
        cout_conduite_changement=ref.get(CAS_EP, "Conduite du changement (1 ETP 50 000€ / 10 000 armoires, one shot)", strate),
        fabrication_energie=ref.get(CAS_EP, "Énergie grise de fabrication", "Toutes strates"),
        fabrication_co2=ref.get(CAS_EP, "CO2 de fabrication", "Toutes strates"),
        install_km=ref.get(CAS_EP, "Déplacement d'installation", "Toutes strates"),
        usage_energie_an=ref.get(CAS_EP, "Consommation armoire + plateforme", "Toutes strates"),
        mix_elec=ref.get(CAS_EP, "Mix électrique français", "Toutes strates"),
        emission_vehicule=ref.get(CAS_EP, "Émission véhicule utilitaire léger", "Toutes strates"),
        km_maintenance_evites=ref.get(CAS_EP, "Kilomètres de maintenance évités par armoire connectée", "Toutes strates"),
        energie_recyclage=ref.get(CAS_EP, "Énergie de recyclage des armoires en fin de vie", "Toutes strates"),
        co2_recyclage=ref.get(CAS_EP, "CO2 de recyclage des armoires en fin de vie", "Toutes strates"),
    )


def calcul_ep_depuis_parc(params: dict, parc_armoires_2026: float, taux_fn) -> pd.DataFrame:
    rows = []
    stock_connecte_prec = parc_armoires_2026 * taux_fn(BASE_YEAR)
    stock_ref = stock_connecte_prec  # parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

    for year in YEARS:
        n = year - BASE_YEAR
        parc_armoires = parc_armoires_2026 * (1 + params["croissance_pl"]) ** n
        parc_pl = parc_armoires * params["ratio_pl_par_armoire"]
        taux_connexion = taux_fn(year)
        stock_connecte = parc_armoires * taux_connexion
        nouveaux = max(stock_connecte - stock_connecte_prec, 0.0)
        stock_add = max(stock_connecte - stock_ref, 0.0)  # parc connecté AJOUTÉ depuis l'année de référence

        capex = nouveaux * params["capex_unitaire"]
        opex_trans = stock_add * params["opex_transmission"]
        opex_serv = stock_connecte * params["opex_serveurs"]
        opex_log = stock_add * params["opex_logiciels"]
        em = stock_add * params["capex_unitaire"] * params["taux_em"]
        conduite = nouveaux * params["cout_conduite_changement"]
        depenses = capex + opex_trans + opex_serv + opex_log + em + conduite

        conso_geree_mwh = stock_connecte * params["ratio_pl_par_armoire"] * params["conso_par_pl_mwh"]  # indicateur marché (parc connecté total)
        conso_geree_add_mwh = stock_add * params["ratio_pl_par_armoire"] * params["conso_par_pl_mwh"]  # base des bénéfices (parc ajouté)
        benefice_energie = conso_geree_add_mwh * params["taux_eco_numerique"] * params["prix_elec"]
        benefice_deplacement = stock_add * (params["eco_deplacement_technicien"] + params["eco_deplacement_carburant"])
        externalites = benefice_energie + benefice_deplacement

        energie_economisee_kwh = conso_geree_add_mwh * params["taux_eco_numerique"] * 1000
        # Émissions : fabrication + usage + pose + recyclage en fin de vie (Excel l.176)
        impact_energie = nouveaux * (params["fabrication_energie"] + params["energie_recyclage"]) + stock_add * params["usage_energie_an"]
        impact_co2 = (nouveaux * (params["fabrication_co2"] + params["co2_recyclage"]) + (stock_add * params["usage_energie_an"]) * params["mix_elec"]
                      + nouveaux * params["install_km"] * params["emission_vehicule"])
        # CO2 évité : énergie économisée (Excel l.171) + déplacements de maintenance évités (l.175)
        benefice_co2_physique = energie_economisee_kwh * params["mix_elec"] + stock_add * params["km_maintenance_evites"] * params["emission_vehicule"]

        rows.append(dict(
            annee=year,
            parc_points_lumineux=parc_pl,
            parc_total_armoires=parc_armoires,
            stock_armoires_connectees=stock_connecte,
            nouvelles_armoires_connectees=nouveaux,
            conso_totale_mwh=parc_pl * params["conso_par_pl_mwh"],
            conso_geree_mwh=conso_geree_mwh,
            energie_economisee_mwh=conso_geree_add_mwh * params["taux_eco_numerique"],
            capex=capex,
            opex_transmission=opex_trans,
            opex_serveurs=opex_serv,
            opex_logiciels=opex_log,
            opex_exploitation_maintenance=em,
            opex_conduite_changement=conduite,
            depenses_totales=depenses,
            benefice_economie_energie=benefice_energie,
            benefice_economie_deplacement=benefice_deplacement,
            externalites_totales=externalites,
            solde_annuel=externalites - depenses,
            impact_energie_kwh=impact_energie,
            impact_co2_kg=impact_co2,
            benefice_energie_kwh=energie_economisee_kwh,
            benefice_co2_kg=benefice_co2_physique,
            bilan_net_energie_kwh=energie_economisee_kwh - impact_energie,
            bilan_net_co2_kg=benefice_co2_physique - impact_co2,
        ))
        stock_connecte_prec = stock_connecte

    return pd.DataFrame(rows)


def calcul_ep(ref: Referentiel, commune: pd.Series) -> ResultatCasUsage:
    strate = resolve_strate(commune)
    params = get_parametres_ep(ref, strate)
    population = float(commune["population"])
    parc_armoires_2026 = (population / params["densite_hab_par_pl"]) / params["ratio_pl_par_armoire"]
    traj = calcul_ep_depuis_parc(params, parc_armoires_2026, taux_compounding_fn(params["taux_connexion_base"], params["croissance_connexion"]))
    return ResultatCasUsage(CAS_EP, commune["nom_standard"], strate, traj)


def calcul_ep_override(ref: Referentiel, communes: list, overrides: dict) -> ResultatCasUsage:
    if overrides.get("pct_2036") is None:
        raise ValueError("Éclairage public : le % d'armoires connectées attendu en 2036 doit être renseigné dès que le nombre d'armoires est saisi.")
    valider_coherence_objets(overrides, "Éclairage public", "armoires")
    per_commune = []
    for c in communes:
        params = get_parametres_ep(ref, resolve_strate(c))
        poids = (float(c["population"]) / params["densite_hab_par_pl"]) / params["ratio_pl_par_armoire"]
        per_commune.append((params, poids))
    poids_total = sum(poids for _, poids in per_commune) or 1.0
    blended = {k: sum(p[k] * poids for p, poids in per_commune) / poids_total for k in per_commune[0][0]}

    parc_2026 = overrides.get("nombre_objets") if overrides.get("nombre_objets") is not None else poids_total
    if overrides.get("nombre_objets_connectes") is not None:
        taux_2026 = (overrides["nombre_objets_connectes"] / parc_2026) if parc_2026 > 0 else 0.0
    else:
        taux_2026 = blended["taux_connexion_base"]

    traj = calcul_ep_depuis_parc(blended, parc_2026, taux_linear_fn(taux_2026, overrides["pct_2036"]))
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resolve_strate(communes[0]) if len(communes) == 1 else f"Multi-strates (moyenne pondérée sur {len(communes)} communes)"
    return ResultatCasUsage(CAS_EP, label, strate, traj)


def calcul_ep_cible_seule(ref: Referentiel, communes: list, pct_2036: float) -> ResultatCasUsage:
    resultats = []
    for c in communes:
        strate = resolve_strate(c)
        params = get_parametres_ep(ref, strate)
        parc_2026 = (float(c["population"]) / params["densite_hab_par_pl"]) / params["ratio_pl_par_armoire"]
        traj = calcul_ep_depuis_parc(params, parc_2026, taux_linear_fn(params["taux_connexion_base"], pct_2036))
        resultats.append(ResultatCasUsage(CAS_EP, c["nom_standard"], strate, traj))
    traj_totale = sum(r.trajectoire.set_index("annee") for r in resultats).reset_index()
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resultats[0].strate if len(communes) == 1 else "Multi-strates"
    return ResultatCasUsage(CAS_EP, label, strate, traj_totale)


def calcul_ep_avec_options(ref: Referentiel, communes: list, overrides: dict | None) -> ResultatCasUsage:
    ov = overrides or {}
    if ov.get("pct_2036") is None:
        raise ValueError("Éclairage public : le % d'armoires connectées attendu en 2036 est obligatoire pour ce cas d'usage.")
    objets_vides = ov.get("nombre_objets") is None and ov.get("nombre_objets_connectes") is None
    if objets_vides:
        return calcul_ep_cible_seule(ref, communes, ov["pct_2036"])
    return calcul_ep_override(ref, communes, ov)




# ------------------------------------------------------------------------------------
# Calcul — Énergie des bâtiments (IoT petits bâtiments / GTB grands bâtiments)
# ------------------------------------------------------------------------------------

def get_parametres_energie_petit(ref: Referentiel, strate: str) -> dict:
    return dict(
        croissance_parc=ref.get(CAS_ENERGIE, "Croissance du parc de bâtiments (surface)", "Toutes strates"),
        nb_base=ref.get(CAS_ENERGIE, "Nombre moyen de bâtiments publics < 500 m² par commune", strate),
        surface=ref.get(CAS_ENERGIE, "Surface moyenne d'un petit bâtiment (<500m²)", "Toutes strates"),
        taux_connexion_base=ref.get(CAS_ENERGIE, "Taux de pénétration IoT (petits bâtiments, base 2025)", strate),
        croissance_connexion=ref.get(CAS_ENERGIE, "Croissance annuelle du taux de pénétration IoT (petits)", "Toutes strates"),
        prix=ref.get(CAS_ENERGIE, "Dépense énergétique des petits bâtiments", "Toutes strates"),
        croissance_prix=ref.get(CAS_ENERGIE, "Croissance annuelle du prix de l'énergie", "Toutes strates"),
        eco_conso=ref.get(CAS_ENERGIE, "Économie via monitoring IoT (petits bâtiments)", "Toutes strates"),
        eco_deplacement=ref.get(CAS_ENERGIE, "Économie déplacement technicien (petit bâtiment)", "Toutes strates"),
        capex_unitaire=ref.get(CAS_ENERGIE, "CAPEX fourni-posé (petit bâtiment, 5 équipements)", "Toutes strates"),
        opex_transmission=ref.get(CAS_ENERGIE, "Transmission réseau (petit et grand bâtiment)", "Toutes strates"),
        opex_serveurs=ref.get(CAS_ENERGIE, "Serveurs et hébergement (petit bâtiment)", "Toutes strates"),
        opex_logiciels=ref.get(CAS_ENERGIE, "Plateforme EMS (petit bâtiment)", "Toutes strates"),
        em_flat=ref.get(CAS_ENERGIE, "Exploitation-maintenance (petit bâtiment, flat)", "Toutes strates"),
        taux_em_capex=0.0,
        cout_conduite=ref.get(CAS_ENERGIE, "Conduite du changement (1 ETP 70 000€ / 100 bâtiments)", "Toutes strates"),
        fabrication_co2=ref.get(CAS_ENERGIE, "CO2 de fabrication (petit bâtiment)", "Toutes strates"),
        install_km=ref.get(CAS_ENERGIE, "Déplacement d'installation", "Toutes strates"),
        usage_energie_an=ref.get(CAS_ENERGIE, "Consommation équipements (petit bâtiment)", "Toutes strates"),
        mix_elec=ref.get(CAS_ENERGIE, "Mix électrique français (consommation équipements)", "Toutes strates"),
        facteur_usages_pilotes=ref.get(CAS_ENERGIE, "Facteur d'émission usages pilotés (énergie économisée)", "Toutes strates"),
        emission_vehicule=ref.get(CAS_ENERGIE, "Émission véhicule utilitaire léger", "Toutes strates"),
        intensite_energetique=ref.get(CAS_ENERGIE, "Intensité énergétique moyenne des bâtiments publics", "Toutes strates"),
        km_maintenance_evites=ref.get(CAS_ENERGIE, "Kilomètres de maintenance évités par bâtiment connecté", "Toutes strates"),
        energie_recyclage=ref.get(CAS_ENERGIE, "Énergie de recyclage (petit bâtiment)", "Toutes strates"),
        serveurs_energie=ref.get(CAS_ENERGIE, "Consommation des serveurs (hébergement SaaS)", "Toutes strates"),
    )


def get_parametres_energie_grand(ref: Referentiel, strate: str) -> dict:
    return dict(
        croissance_parc=ref.get(CAS_ENERGIE, "Croissance du parc de bâtiments (surface)", "Toutes strates"),
        nb_base=ref.get(CAS_ENERGIE, "Nombre moyen de bâtiments publics > 500 m² par commune", strate),
        surface=ref.get(CAS_ENERGIE, "Surface moyenne d'un grand bâtiment (>500m²)", "Toutes strates"),
        taux_connexion_base=ref.get(CAS_ENERGIE, "Taux de pénétration GTB (grands bâtiments, base 2025)", strate),
        croissance_connexion=ref.get(CAS_ENERGIE, "Croissance annuelle du taux de pénétration GTB (grands)", "Toutes strates"),
        prix=ref.get(CAS_ENERGIE, "Dépense énergétique des grands bâtiments", "Toutes strates"),
        croissance_prix=ref.get(CAS_ENERGIE, "Croissance annuelle du prix de l'énergie", "Toutes strates"),
        eco_conso=ref.get(CAS_ENERGIE, "Économie via GTB exploitée (grands bâtiments)", "Toutes strates"),
        eco_deplacement=ref.get(CAS_ENERGIE, "Économie déplacement technicien (grand bâtiment)", "Toutes strates"),
        capex_unitaire=ref.get(CAS_ENERGIE, "CAPEX fourni-posé (grand bâtiment, GTB)", "Toutes strates"),
        opex_transmission=ref.get(CAS_ENERGIE, "Transmission réseau (petit et grand bâtiment)", "Toutes strates"),
        opex_serveurs=ref.get(CAS_ENERGIE, "Serveurs et hébergement (grand bâtiment)", "Toutes strates"),
        opex_logiciels=ref.get(CAS_ENERGIE, "Plateforme EMS (grand bâtiment)", "Toutes strates"),
        em_flat=0.0,
        taux_em_capex=ref.get(CAS_ENERGIE, "Exploitation-maintenance (grand bâtiment, % du CAPEX cumulé)", strate),
        cout_conduite=ref.get(CAS_ENERGIE, "Conduite du changement (1 ETP 70 000€ / 100 bâtiments)", "Toutes strates"),
        fabrication_co2=ref.get(CAS_ENERGIE, "CO2 de fabrication (grand bâtiment)", "Toutes strates"),
        install_km=ref.get(CAS_ENERGIE, "Déplacement d'installation", "Toutes strates"),
        usage_energie_an=ref.get(CAS_ENERGIE, "Consommation équipements (grand bâtiment)", "Toutes strates"),
        mix_elec=ref.get(CAS_ENERGIE, "Mix électrique français (consommation équipements)", "Toutes strates"),
        facteur_usages_pilotes=ref.get(CAS_ENERGIE, "Facteur d'émission usages pilotés (énergie économisée)", "Toutes strates"),
        emission_vehicule=ref.get(CAS_ENERGIE, "Émission véhicule utilitaire léger", "Toutes strates"),
        intensite_energetique=ref.get(CAS_ENERGIE, "Intensité énergétique moyenne des bâtiments publics", "Toutes strates"),
        km_maintenance_evites=ref.get(CAS_ENERGIE, "Kilomètres de maintenance évités par bâtiment connecté", "Toutes strates"),
        energie_recyclage=ref.get(CAS_ENERGIE, "Énergie de recyclage (grand bâtiment)", "Toutes strates"),
        serveurs_energie=ref.get(CAS_ENERGIE, "Consommation des serveurs (hébergement SaaS)", "Toutes strates"),
    )


def calcul_energie_sous_type_depuis_parc(params: dict, parc_2026: float, taux_fn) -> list:
    """Renvoie une liste de dicts (une ligne par année), même schéma pour petit et grand."""
    rows = []
    stock_prec = parc_2026 * taux_fn(BASE_YEAR)
    stock_ref = stock_prec  # parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

    for year in YEARS:
        n = year - BASE_YEAR
        parc = parc_2026 * (1 + params["croissance_parc"]) ** n
        taux = taux_fn(year)
        stock = parc * taux
        nouveaux = max(stock - stock_prec, 0.0)
        stock_add = max(stock - stock_ref, 0.0)  # parc connecté AJOUTÉ depuis l'année de référence

        prix_an = params["prix"] * (1 + params["croissance_prix"]) ** n
        depense_totale = parc * params["surface"] * prix_an

        capex = nouveaux * params["capex_unitaire"]
        opex_trans = stock_add * params["opex_transmission"]
        opex_serv = stock * params["opex_serveurs"]
        opex_log = stock_add * params["opex_logiciels"]
        em = stock_add * params["em_flat"] + stock_add * params["capex_unitaire"] * params["taux_em_capex"]
        conduite = nouveaux * params["cout_conduite"]
        depenses = capex + opex_trans + opex_serv + opex_log + em + conduite

        benefice_energie = stock_add * params["surface"] * prix_an * params["eco_conso"]
        benefice_deplacement = stock_add * params["eco_deplacement"]
        externalites = benefice_energie + benefice_deplacement

        kwh_economise = stock_add * params["surface"] * params["intensite_energetique"] * params["eco_conso"]
        # Énergie : équipements (l.206) + serveurs SaaS (l.207) + recyclage (l.211) ; le CO2 en découle via le mix (impact_energie × mix)
        impact_energie = stock_add * (params["usage_energie_an"] + params["serveurs_energie"]) + nouveaux * params["energie_recyclage"]
        impact_co2 = (nouveaux * params["fabrication_co2"] + impact_energie * params["mix_elec"]
                      + nouveaux * params["install_km"] * params["emission_vehicule"])
        # CO2 évité : énergie économisée (Excel l.208) + déplacements de maintenance évités (l.210)
        benefice_co2_physique = kwh_economise * params["facteur_usages_pilotes"] + stock_add * params["km_maintenance_evites"] * params["emission_vehicule"]

        rows.append(dict(
            annee=year, parc=parc, stock_connecte=stock, nouveaux=nouveaux,
            depense_energie_totale=depense_totale,
            capex=capex, opex_transmission=opex_trans, opex_serveurs=opex_serv, opex_logiciels=opex_log,
            opex_exploitation_maintenance=em, opex_conduite_changement=conduite, depenses_totales=depenses,
            benefice_energie=benefice_energie, benefice_deplacement=benefice_deplacement,
            externalites_totales=externalites,
            impact_energie_kwh=impact_energie, impact_co2_kg=impact_co2,
            benefice_energie_kwh=kwh_economise, benefice_co2_kg=benefice_co2_physique,
        ))
        stock_prec = stock

    return rows


def combiner_energie_batiments(rows_petit: list, rows_grand: list) -> pd.DataFrame:
    lignes = []
    for p, g in zip(rows_petit, rows_grand):
        depenses = p["depenses_totales"] + g["depenses_totales"]
        externalites = p["externalites_totales"] + g["externalites_totales"]
        lignes.append(dict(
            annee=p["annee"],
            parc_petits_batiments=p["parc"],
            parc_grands_batiments=g["parc"],
            stock_petits_connectes=p["stock_connecte"],
            stock_grands_connectes=g["stock_connecte"],
            nouveaux_batiments_connectes=p["nouveaux"] + g["nouveaux"],
            depense_energie_totale=p["depense_energie_totale"] + g["depense_energie_totale"],
            capex=p["capex"] + g["capex"],
            opex_transmission=p["opex_transmission"] + g["opex_transmission"],
            opex_serveurs=p["opex_serveurs"] + g["opex_serveurs"],
            opex_logiciels=p["opex_logiciels"] + g["opex_logiciels"],
            opex_exploitation_maintenance=p["opex_exploitation_maintenance"] + g["opex_exploitation_maintenance"],
            opex_conduite_changement=p["opex_conduite_changement"] + g["opex_conduite_changement"],
            depenses_totales=depenses,
            benefice_energie=p["benefice_energie"] + g["benefice_energie"],
            benefice_deplacement=p["benefice_deplacement"] + g["benefice_deplacement"],
            externalites_totales=externalites,
            solde_annuel=externalites - depenses,
            impact_energie_kwh=p["impact_energie_kwh"] + g["impact_energie_kwh"],
            impact_co2_kg=p["impact_co2_kg"] + g["impact_co2_kg"],
            benefice_energie_kwh=p["benefice_energie_kwh"] + g["benefice_energie_kwh"],
            benefice_co2_kg=p["benefice_co2_kg"] + g["benefice_co2_kg"],
            bilan_net_energie_kwh=(p["benefice_energie_kwh"] + g["benefice_energie_kwh"]) - (p["impact_energie_kwh"] + g["impact_energie_kwh"]),
            bilan_net_co2_kg=(p["benefice_co2_kg"] + g["benefice_co2_kg"]) - (p["impact_co2_kg"] + g["impact_co2_kg"]),
        ))
    return pd.DataFrame(lignes)


def calcul_energie_batiments(ref: Referentiel, commune: pd.Series) -> ResultatCasUsage:
    strate = resolve_strate(commune)
    params_petit = get_parametres_energie_petit(ref, strate)
    params_grand = get_parametres_energie_grand(ref, strate)
    rows_petit = calcul_energie_sous_type_depuis_parc(params_petit, params_petit["nb_base"],
        taux_compounding_fn(params_petit["taux_connexion_base"], params_petit["croissance_connexion"]))
    rows_grand = calcul_energie_sous_type_depuis_parc(params_grand, params_grand["nb_base"],
        taux_compounding_fn(params_grand["taux_connexion_base"], params_grand["croissance_connexion"]))
    traj = combiner_energie_batiments(rows_petit, rows_grand)
    return ResultatCasUsage(CAS_ENERGIE, commune["nom_standard"], strate, traj)


def calcul_energie_sous_type(ref: Referentiel, communes: list, get_params, overrides: dict | None, sous_type_label: str) -> list:
    """Calcule un sous-type (petit ou grand), en mode "cible 2036 seule" (parc auto,
    taux linéaire vers la cible) ou saisie manuelle complète (paramètres pondérés +
    trajectoire ancrée sur la saisie). Le % cible 2036 est obligatoire dans tous les cas."""
    ov = overrides or {}
    if ov.get("pct_2036") is None:
        raise ValueError(f"Énergie des bâtiments — {sous_type_label} : le % de bâtiments connectés attendu en 2036 est obligatoire pour ce cas d'usage.")
    objets_vides = ov.get("nombre_objets") is None and ov.get("nombre_objets_connectes") is None

    if objets_vides:
        # Cible 2036 seule : parc reste dérivé par commune (auto), taux linéaire partagé.
        toutes_rows = []
        for c in communes:
            params = get_params(ref, resolve_strate(c))
            toutes_rows.append(calcul_energie_sous_type_depuis_parc(
                params, params["nb_base"], taux_linear_fn(params["taux_connexion_base"], ov["pct_2036"])
            ))
        cles = [k for k in toutes_rows[0][0] if k != "annee"]
        return [
            dict(annee=YEARS[i], **{k: sum(rows[i][k] for rows in toutes_rows) for k in cles})
            for i in range(len(YEARS))
        ]

    if (ov.get("nombre_objets") is not None and ov.get("nombre_objets_connectes") is not None
            and ov["nombre_objets_connectes"] > ov["nombre_objets"]):
        raise ValueError(
            f"Énergie des bâtiments — {sous_type_label} : le nombre de bâtiments connectés ({ov['nombre_objets_connectes']}) "
            f"ne peut pas dépasser le nombre total de bâtiments ({ov['nombre_objets']})."
        )
    per_commune = [(get_params(ref, resolve_strate(c)), get_params(ref, resolve_strate(c))["nb_base"]) for c in communes]
    poids_total = sum(poids for _, poids in per_commune) or 1.0
    blended = {k: sum((p[k] or 0) * poids for p, poids in per_commune) / poids_total for k in per_commune[0][0]}

    parc_2026 = ov.get("nombre_objets") if ov.get("nombre_objets") is not None else poids_total
    if ov.get("nombre_objets_connectes") is not None:
        taux_2026 = (ov["nombre_objets_connectes"] / parc_2026) if parc_2026 > 0 else 0.0
    else:
        taux_2026 = blended["taux_connexion_base"]
    return calcul_energie_sous_type_depuis_parc(blended, parc_2026, taux_linear_fn(taux_2026, ov["pct_2036"]))


def calcul_energie_batiments_avec_options(ref: Referentiel, communes: list, overrides: dict | None) -> ResultatCasUsage:
    """overrides = {"petit": {...}, "grand": {...}} — chaque sous-type est calculé
    indépendamment (cible 2036 seule, ou saisie manuelle complète) ; le % cible 2036
    est obligatoire pour chacun des deux."""
    ov = overrides or {}
    rows_petit = calcul_energie_sous_type(ref, communes, get_parametres_energie_petit, ov.get("petit"), "bâtiments < 500 m²")
    rows_grand = calcul_energie_sous_type(ref, communes, get_parametres_energie_grand, ov.get("grand"), "bâtiments > 500 m²")
    traj = combiner_energie_batiments(rows_petit, rows_grand)

    petit_override = ov.get("petit") and (ov["petit"].get("nombre_objets") is not None or ov["petit"].get("nombre_objets_connectes") is not None)
    grand_override = ov.get("grand") and (ov["grand"].get("nombre_objets") is not None or ov["grand"].get("nombre_objets_connectes") is not None)
    if len(communes) == 1 and not petit_override and not grand_override:
        label = communes[0]["nom_standard"]
        strate = resolve_strate(communes[0])
    else:
        label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
        strate = f"Multi-strates (moyenne pondérée sur {len(communes)} commune{'s' if len(communes) > 1 else ''})"
    return ResultatCasUsage(CAS_ENERGIE, label, strate, traj)


# ------------------------------------------------------------------------------------
# Calcul — Déchets : points d'apport volontaire (PAV)
# ------------------------------------------------------------------------------------

def get_parametres_pav(ref: Referentiel, strate: str) -> dict:
    return dict(
        part_cs=ref.get(CAS_PAV, "Part de la population desservie en PAV — collecte séparée", "Toutes strates"),
        part_verre=ref.get(CAS_PAV, "Part de la population desservie en PAV — verre", "Toutes strates"),
        part_omr=ref.get(CAS_PAV, "Part de la population desservie en PAV — OMR", "Toutes strates"),
        hab_pav_cs=ref.get(CAS_PAV, "Habitants desservis par PAV — collecte séparée", "Toutes strates"),
        hab_pav_verre=ref.get(CAS_PAV, "Habitants desservis par PAV — verre", "Toutes strates"),
        hab_pav_omr=ref.get(CAS_PAV, "Habitants desservis par PAV — OMR", "Toutes strates"),
        croissance_parc=ref.get(CAS_PAV, "Croissance du parc de PAV", "Toutes strates"),
        taux_connexion_base=ref.get(CAS_PAV, "Taux de PAV connectés (base 2025)", strate),
        croissance_connexion=ref.get(CAS_PAV, "Croissance annuelle du taux de PAV connectés", "Toutes strates"),
        eco_eboueur=ref.get(CAS_PAV, "Économie déplacement éboueur (levées évitées)", strate),
        eco_tournee=ref.get(CAS_PAV, "Économie déplacement tournée (relevage optimisé)", strate),
        capex_unitaire=ref.get(CAS_PAV, "CAPEX sonde fournie-posée", strate),
        opex_transmission=ref.get(CAS_PAV, "Transmission réseau", strate),
        opex_serveurs=ref.get(CAS_PAV, "Serveurs et hébergement", "Toutes strates"),
        opex_logiciels=ref.get(CAS_PAV, "Logiciel SAAS exploitation données", strate),
        taux_em=ref.get(CAS_PAV, "Exploitation-maintenance (% du CAPEX cumulé)", strate),
        cout_conduite=ref.get(CAS_PAV, "Conduite du changement (1 ETP 50 000€ / 10 000 sondes)", strate),
        fabrication_energie=ref.get(CAS_PAV, "Énergie grise de fabrication", "Toutes strates"),
        fabrication_co2=ref.get(CAS_PAV, "CO2 de fabrication", "Toutes strates"),
        install_km=ref.get(CAS_PAV, "Déplacement d'installation", "Toutes strates"),
        usage_energie_an=ref.get(CAS_PAV, "Consommation sonde + plateforme", "Toutes strates"),
        mix_elec=ref.get(CAS_PAV, "Mix électrique français", "Toutes strates"),
        emission_vehicule=ref.get(CAS_PAV, "Émission véhicule utilitaire léger", "Toutes strates"),
        prix_gazole=ref.get(CAS_PAV, "Prix du gazole (conversion économie de carburant → litres)", "Toutes strates"),
        facteur_gazole=ref.get(CAS_PAV, "Facteur d'émission du gazole, amont inclus (Base Carbone)", "Toutes strates"),
        km_maintenance_evites=ref.get(CAS_PAV, "Kilomètres de maintenance évités par sonde connectée", "Toutes strates"),
        energie_recyclage=ref.get(CAS_PAV, "Énergie de recyclage des sondes en fin de vie", "Toutes strates"),
        co2_recyclage=ref.get(CAS_PAV, "CO2 de recyclage des sondes en fin de vie", "Toutes strates"),
    )


def parc_base_pav(params: dict, population: float) -> float:
    return population * (params["part_cs"] / params["hab_pav_cs"] + params["part_verre"] / params["hab_pav_verre"]
                          + params["part_omr"] / params["hab_pav_omr"])


def calcul_dechets_pav_depuis_parc(params: dict, parc_2026: float, taux_fn) -> pd.DataFrame:
    rows = []
    stock_connecte_prec = parc_2026 * taux_fn(BASE_YEAR)
    stock_ref = stock_connecte_prec  # parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

    for year in YEARS:
        n = year - BASE_YEAR
        parc_total = parc_2026 * (1 + params["croissance_parc"]) ** n
        taux_connexion = taux_fn(year)
        stock_connecte = parc_total * taux_connexion
        nouveaux = max(stock_connecte - stock_connecte_prec, 0.0)
        stock_add = max(stock_connecte - stock_ref, 0.0)  # parc connecté AJOUTÉ depuis l'année de référence

        capex = nouveaux * params["capex_unitaire"]
        opex_trans = stock_add * params["opex_transmission"]
        opex_serv = stock_connecte * params["opex_serveurs"]
        opex_log = stock_add * params["opex_logiciels"]
        em = stock_add * params["capex_unitaire"] * params["taux_em"]
        conduite = nouveaux * params["cout_conduite"]
        depenses = capex + opex_trans + opex_serv + opex_log + em + conduite

        benefice_deplacement = stock_add * (params["eco_eboueur"] + params["eco_tournee"])
        # CO2 évité (Excel V1.2, ligne 183) : économie de carburant des tournées ÷ prix du gazole × facteur d'émission
        benefice_co2_physique = (stock_add * params["eco_tournee"] / params["prix_gazole"] * params["facteur_gazole"]   # l.183 : tournées évitées
                                 + stock_add * params["km_maintenance_evites"] * params["emission_vehicule"])             # l.184 : maintenance évitée
        externalites = benefice_deplacement

        # Émissions : fabrication + usage + pose + recyclage en fin de vie (Excel l.185)
        impact_energie = nouveaux * (params["fabrication_energie"] + params["energie_recyclage"]) + stock_add * params["usage_energie_an"]
        impact_co2 = (nouveaux * (params["fabrication_co2"] + params["co2_recyclage"]) + (stock_add * params["usage_energie_an"]) * params["mix_elec"]
                      + nouveaux * params["install_km"] * params["emission_vehicule"])

        rows.append(dict(
            annee=year,
            parc_total_pav=parc_total,
            stock_pav_connectes=stock_connecte,
            nouveaux_pav_connectes=nouveaux,
            capex=capex,
            opex_transmission=opex_trans,
            opex_serveurs=opex_serv,
            opex_logiciels=opex_log,
            opex_exploitation_maintenance=em,
            opex_conduite_changement=conduite,
            depenses_totales=depenses,
            benefice_deplacement=benefice_deplacement,
            externalites_totales=externalites,
            solde_annuel=externalites - depenses,
            impact_energie_kwh=impact_energie,
            impact_co2_kg=impact_co2,
            benefice_energie_kwh=0.0,
            benefice_co2_kg=benefice_co2_physique,
            bilan_net_energie_kwh=-impact_energie,
            bilan_net_co2_kg=benefice_co2_physique - impact_co2,
        ))
        stock_connecte_prec = stock_connecte

    return pd.DataFrame(rows)


def calcul_dechets_pav(ref: Referentiel, commune: pd.Series) -> ResultatCasUsage:
    strate = resolve_strate(commune)
    params = get_parametres_pav(ref, strate)
    parc_2026 = parc_base_pav(params, float(commune["population"]))
    traj = calcul_dechets_pav_depuis_parc(params, parc_2026, taux_compounding_fn(params["taux_connexion_base"], params["croissance_connexion"]))
    return ResultatCasUsage(CAS_PAV, commune["nom_standard"], strate, traj)


def calcul_dechets_pav_override(ref: Referentiel, communes: list, overrides: dict) -> ResultatCasUsage:
    if overrides.get("pct_2036") is None:
        raise ValueError("Déchets PAV : le % de PAV connectés attendu en 2036 doit être renseigné dès que le nombre de PAV est saisi.")
    valider_coherence_objets(overrides, "Déchets PAV", "PAV")
    per_commune = []
    for c in communes:
        params = get_parametres_pav(ref, resolve_strate(c))
        per_commune.append((params, parc_base_pav(params, float(c["population"]))))
    poids_total = sum(poids for _, poids in per_commune) or 1.0
    blended = {k: sum(p[k] * poids for p, poids in per_commune) / poids_total for k in per_commune[0][0]}

    parc_2026 = overrides.get("nombre_objets") if overrides.get("nombre_objets") is not None else poids_total
    if overrides.get("nombre_objets_connectes") is not None:
        taux_2026 = (overrides["nombre_objets_connectes"] / parc_2026) if parc_2026 > 0 else 0.0
    else:
        taux_2026 = blended["taux_connexion_base"]

    traj = calcul_dechets_pav_depuis_parc(blended, parc_2026, taux_linear_fn(taux_2026, overrides["pct_2036"]))
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resolve_strate(communes[0]) if len(communes) == 1 else f"Multi-strates (moyenne pondérée sur {len(communes)} communes)"
    return ResultatCasUsage(CAS_PAV, label, strate, traj)


def calcul_dechets_pav_cible_seule(ref: Referentiel, communes: list, pct_2036: float) -> ResultatCasUsage:
    resultats = []
    for c in communes:
        strate = resolve_strate(c)
        params = get_parametres_pav(ref, strate)
        parc_2026 = parc_base_pav(params, float(c["population"]))
        traj = calcul_dechets_pav_depuis_parc(params, parc_2026, taux_linear_fn(params["taux_connexion_base"], pct_2036))
        resultats.append(ResultatCasUsage(CAS_PAV, c["nom_standard"], strate, traj))
    traj_totale = sum(r.trajectoire.set_index("annee") for r in resultats).reset_index()
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resultats[0].strate if len(communes) == 1 else "Multi-strates"
    return ResultatCasUsage(CAS_PAV, label, strate, traj_totale)


def calcul_dechets_pav_avec_options(ref: Referentiel, communes: list, overrides: dict | None) -> ResultatCasUsage:
    ov = overrides or {}
    if ov.get("pct_2036") is None:
        raise ValueError("Déchets PAV : le % de PAV connectés attendu en 2036 est obligatoire pour ce cas d'usage.")
    objets_vides = ov.get("nombre_objets") is None and ov.get("nombre_objets_connectes") is None
    if objets_vides:
        return calcul_dechets_pav_cible_seule(ref, communes, ov["pct_2036"])
    return calcul_dechets_pav_override(ref, communes, ov)


# ------------------------------------------------------------------------------------
# Calcul — Déchets : bacs individuels (puce RFID / tarification incitative)
# ------------------------------------------------------------------------------------

def get_parametres_bacs(ref: Referentiel, strate: str) -> dict:
    return dict(
        part_collectif=ref.get(CAS_BACS, "Part des ménages en habitat collectif", strate),
        menages_par_bac_collectif=ref.get(CAS_BACS, "Mutualisation des bacs en habitat collectif", "Toutes strates"),
        nb_flux=ref.get(CAS_BACS, "Nombre de flux de déchets équipés de bacs", "Toutes strates"),
        croissance_parc=ref.get(CAS_BACS, "Croissance du parc de ménages", "Toutes strates"),
        taux_connexion_base=ref.get(CAS_BACS, "Taux de bacs connectés / pucés (base 2025)", strate),
        croissance_connexion=ref.get(CAS_BACS, "Croissance annuelle du taux de bacs connectés", "Toutes strates"),
        eco_ti=ref.get(CAS_BACS, "Économie nette de la tarification incitative (TI)", strate),
        eco_deplacement=ref.get(CAS_BACS, "Économie déplacement (km évités, harmonisé avec PAV)", strate),
        # V1.2 : le gain kilométrique n'existe que si le schéma de collecte est refondu (≈50 % des collectivités).
        part_refonte_schema=ref.get(CAS_BACS, "Part des collectivités refondant leur schéma de collecte (gain km conditionné)", "Toutes strates"),
        capex_unitaire=ref.get(CAS_BACS, "CAPEX puce d'identification (RFID)", "Toutes strates"),
        opex_transmission=ref.get(CAS_BACS, "Transmission (RFID, sans coût réseau)", "Toutes strates"),
        opex_serveurs=ref.get(CAS_BACS, "Serveurs et hébergement", "Toutes strates"),
        opex_logiciels=ref.get(CAS_BACS, "Logiciel SAAS exploitation données", "Toutes strates"),
        taux_em=ref.get(CAS_BACS, "Exploitation-maintenance (% du CAPEX cumulé)", strate),
        cout_conduite=ref.get(CAS_BACS, "Conduite du changement (1 ETP 50 000€ / 10 000 bacs)", "Toutes strates"),
        fabrication_energie=ref.get(CAS_BACS, "Énergie grise de fabrication", "Toutes strates"),
        fabrication_co2=ref.get(CAS_BACS, "CO2 de fabrication", "Toutes strates"),
        prix_gazole=ref.get(CAS_BACS, "Prix du gazole (conversion économie de carburant → litres)", "Toutes strates"),
        facteur_gazole=ref.get(CAS_BACS, "Facteur d'émission du gazole, amont inclus (Base Carbone)", "Toutes strates"),
        bacs_par_menage=ref.get(CAS_BACS, "Nombre de bacs pucés par ménage (conversion bacs → ménages)", "Toutes strates"),
        habitants_par_menage=ref.get(CAS_BACS, "Habitants par ménage", "Toutes strates"),
        omr_par_habitant=ref.get(CAS_BACS, "Production d'OMR par habitant", "Toutes strates"),
        reduction_omr_ti=ref.get(CAS_BACS, "Réduction des tonnages d'OMR par la tarification incitative", "Toutes strates"),
        co2_evite_par_tonne_omr=ref.get(CAS_BACS, "CO2 évité par tonne d'OMR détournée (Base Carbone)", "Toutes strates"),
        km_pose=ref.get(CAS_BACS, "Déplacement de pose des puces", "Toutes strates"),
        serveurs_energie=ref.get(CAS_BACS, "Consommation des serveurs (gestion TI)", "Toutes strates"),
        energie_recyclage=ref.get(CAS_BACS, "Énergie de recyclage des puces en fin de vie", "Toutes strates"),
        co2_recyclage=ref.get(CAS_BACS, "CO2 de recyclage des puces en fin de vie", "Toutes strates"),
        mix_elec=ref.get(CAS_BACS, "Mix électrique français", "Toutes strates"),
        emission_vehicule=ref.get(CAS_BACS, "Émission véhicule utilitaire léger", "Toutes strates"),
    )


def parc_base_bacs(params: dict, menages: float) -> float:
    part_individuel = 1 - params["part_collectif"]
    bacs_par_menage = (params["part_collectif"] / params["menages_par_bac_collectif"] + part_individuel * 1) * params["nb_flux"]
    return menages * bacs_par_menage


def calcul_dechets_bacs_depuis_parc(params: dict, parc_2026: float, taux_fn) -> pd.DataFrame:
    rows = []
    stock_connecte_prec = parc_2026 * taux_fn(BASE_YEAR)
    stock_ref = stock_connecte_prec  # parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

    for year in YEARS:
        n = year - BASE_YEAR
        parc_total = parc_2026 * (1 + params["croissance_parc"]) ** n
        taux_connexion = taux_fn(year)
        stock_connecte = parc_total * taux_connexion
        nouveaux = max(stock_connecte - stock_connecte_prec, 0.0)
        stock_add = max(stock_connecte - stock_ref, 0.0)  # parc connecté AJOUTÉ depuis l'année de référence

        capex = nouveaux * params["capex_unitaire"]
        opex_trans = stock_add * params["opex_transmission"]
        opex_serv = stock_connecte * params["opex_serveurs"]
        opex_log = stock_add * params["opex_logiciels"]
        em = stock_add * params["capex_unitaire"] * params["taux_em"]
        conduite = nouveaux * params["cout_conduite"]
        depenses = capex + opex_trans + opex_serv + opex_log + em + conduite

        benefice_ti = stock_add * params["eco_ti"]
        benefice_deplacement = stock_add * params["eco_deplacement"] * params["part_refonte_schema"]
        # CO2 évité (Excel V1.2, ligne 188) : économie de carburant (km de collecte évités) ÷ prix du gazole × facteur d'émission
        benefice_co2_physique = (benefice_deplacement / params["prix_gazole"] * params["facteur_gazole"]   # l.188 : km de collecte évités
                                 + (stock_add / params["bacs_par_menage"]) * params["habitants_par_menage"] * params["omr_par_habitant"]
                                 * params["reduction_omr_ti"] * params["co2_evite_par_tonne_omr"] * 1000)  # l.187 : tonnages d'OMR évités (tCO2e → kg)
        externalites = benefice_ti + benefice_deplacement

        # Émissions : fabrication (l.183) + pose des puces (l.184) + serveurs de gestion TI (l.186) + recyclage (l.189)
        impact_energie = nouveaux * (params["fabrication_energie"] + params["energie_recyclage"]) + stock_add * params["serveurs_energie"]
        impact_co2 = (nouveaux * (params["fabrication_co2"] + params["co2_recyclage"] + params["km_pose"] * params["emission_vehicule"])
                      + stock_add * params["serveurs_energie"] * params["mix_elec"])

        rows.append(dict(
            annee=year,
            parc_total_bacs=parc_total,
            stock_bacs_connectes=stock_connecte,
            nouveaux_bacs_connectes=nouveaux,
            capex=capex,
            opex_transmission=opex_trans,
            opex_serveurs=opex_serv,
            opex_logiciels=opex_log,
            opex_exploitation_maintenance=em,
            opex_conduite_changement=conduite,
            depenses_totales=depenses,
            benefice_ti=benefice_ti,
            impact_energie_kwh=impact_energie,
            impact_co2_kg=impact_co2,
            benefice_energie_kwh=0.0,
            benefice_co2_kg=benefice_co2_physique,
            bilan_net_energie_kwh=-impact_energie,
            bilan_net_co2_kg=benefice_co2_physique - impact_co2,
            benefice_deplacement=benefice_deplacement,
            externalites_totales=externalites,
            solde_annuel=externalites - depenses,
        ))
        stock_connecte_prec = stock_connecte

    return pd.DataFrame(rows)


def calcul_dechets_bacs(ref: Referentiel, commune: pd.Series) -> ResultatCasUsage:
    strate = resolve_strate(commune)
    params = get_parametres_bacs(ref, strate)
    parc_2026 = parc_base_bacs(params, get_base_menages(commune))
    traj = calcul_dechets_bacs_depuis_parc(params, parc_2026, taux_compounding_fn(params["taux_connexion_base"], params["croissance_connexion"]))
    return ResultatCasUsage(CAS_BACS, commune["nom_standard"], strate, traj)


def calcul_dechets_bacs_override(ref: Referentiel, communes: list, overrides: dict) -> ResultatCasUsage:
    if overrides.get("pct_2036") is None:
        raise ValueError("Déchets bacs individuels : le % de bacs connectés attendu en 2036 doit être renseigné dès que le nombre de bacs est saisi.")
    valider_coherence_objets(overrides, "Déchets bacs individuels", "bacs")
    per_commune = []
    for c in communes:
        params = get_parametres_bacs(ref, resolve_strate(c))
        per_commune.append((params, parc_base_bacs(params, get_base_menages(c))))
    poids_total = sum(poids for _, poids in per_commune) or 1.0
    blended = {k: sum(p[k] * poids for p, poids in per_commune) / poids_total for k in per_commune[0][0]}

    parc_2026 = overrides.get("nombre_objets") if overrides.get("nombre_objets") is not None else poids_total
    if overrides.get("nombre_objets_connectes") is not None:
        taux_2026 = (overrides["nombre_objets_connectes"] / parc_2026) if parc_2026 > 0 else 0.0
    else:
        taux_2026 = blended["taux_connexion_base"]

    traj = calcul_dechets_bacs_depuis_parc(blended, parc_2026, taux_linear_fn(taux_2026, overrides["pct_2036"]))
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resolve_strate(communes[0]) if len(communes) == 1 else f"Multi-strates (moyenne pondérée sur {len(communes)} communes)"
    return ResultatCasUsage(CAS_BACS, label, strate, traj)


def calcul_dechets_bacs_cible_seule(ref: Referentiel, communes: list, pct_2036: float) -> ResultatCasUsage:
    resultats = []
    for c in communes:
        strate = resolve_strate(c)
        params = get_parametres_bacs(ref, strate)
        parc_2026 = parc_base_bacs(params, get_base_menages(c))
        traj = calcul_dechets_bacs_depuis_parc(params, parc_2026, taux_linear_fn(params["taux_connexion_base"], pct_2036))
        resultats.append(ResultatCasUsage(CAS_BACS, c["nom_standard"], strate, traj))
    traj_totale = sum(r.trajectoire.set_index("annee") for r in resultats).reset_index()
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resultats[0].strate if len(communes) == 1 else "Multi-strates"
    return ResultatCasUsage(CAS_BACS, label, strate, traj_totale)


def calcul_dechets_bacs_avec_options(ref: Referentiel, communes: list, overrides: dict | None) -> ResultatCasUsage:
    ov = overrides or {}
    if ov.get("pct_2036") is None:
        raise ValueError("Déchets bacs individuels : le % de bacs connectés attendu en 2036 est obligatoire pour ce cas d'usage.")
    objets_vides = ov.get("nombre_objets") is None and ov.get("nombre_objets_connectes") is None
    if objets_vides:
        return calcul_dechets_bacs_cible_seule(ref, communes, ov["pct_2036"])
    return calcul_dechets_bacs_override(ref, communes, ov)


# ------------------------------------------------------------------------------------
# Calcul — Arrosage connecté
# ------------------------------------------------------------------------------------

def get_parametres_arrosage(ref: Referentiel, strate: str) -> dict:
    return dict(
        m2_par_hab=ref.get(CAS_ARROSAGE, "Surface d'espaces verts par habitant", strate),
        part_arrosee=ref.get(CAS_ARROSAGE, "Part des espaces verts arrosés", strate),
        vannes_par_ha=ref.get(CAS_ARROSAGE, "Nombre de vannes d'arrosage par hectare arrosé", strate),
        volume_par_m2=ref.get(CAS_ARROSAGE, "Volume d'eau d'arrosage par m² d'espace vert arrosé", strate),
        croissance_parc=ref.get(CAS_ARROSAGE, "Croissance du nombre de vannes par hectare", strate),
        taux_connexion_base=ref.get(CAS_ARROSAGE, "Taux de vannes connectées (base 2025)", strate),
        croissance_connexion=ref.get(CAS_ARROSAGE, "Croissance annuelle du taux de vannes connectées", strate),
        eco_eau_numerique=ref.get(CAS_ARROSAGE, "Économie d'eau attribuable au numérique", "Toutes strates"),
        valorisation_eau=ref.get(CAS_ARROSAGE, "Valorisation de l'eau économisée", "Toutes strates"),
        eco_jardinier=ref.get(CAS_ARROSAGE, "Économie déplacement jardinier (temps technicien)", strate),
        eco_carburant=ref.get(CAS_ARROSAGE, "Économie déplacement (carburant)", strate),
        capex_unitaire=ref.get(CAS_ARROSAGE, "CAPEX vanne connectée fournie-posée", strate),
        opex_transmission=ref.get(CAS_ARROSAGE, "Transmission réseau", strate),
        opex_serveurs=ref.get(CAS_ARROSAGE, "Serveurs et hébergement", "Toutes strates"),
        opex_logiciels=ref.get(CAS_ARROSAGE, "Logiciel SAAS exploitation données", strate),
        taux_em=ref.get(CAS_ARROSAGE, "Exploitation-maintenance (% du CAPEX cumulé)", strate),
        cout_conduite=ref.get(CAS_ARROSAGE, "Conduite du changement (1 ETP 50 000€ / 10 000 vannes)", strate),
        fabrication_energie=ref.get(CAS_ARROSAGE, "Énergie grise de fabrication", "Toutes strates"),
        fabrication_co2=ref.get(CAS_ARROSAGE, "CO2 de fabrication", "Toutes strates"),
        install_km=ref.get(CAS_ARROSAGE, "Déplacement d'installation", "Toutes strates"),
        usage_energie_an=ref.get(CAS_ARROSAGE, "Consommation vanne + plateforme", "Toutes strates"),
        mix_elec=ref.get(CAS_ARROSAGE, "Mix électrique français", "Toutes strates"),
        emission_vehicule=ref.get(CAS_ARROSAGE, "Émission véhicule utilitaire léger", "Toutes strates"),
        energie_pompage_evitee=ref.get(CAS_ARROSAGE, "Énergie de pompage/traitement évitée par eau non prélevée", "Toutes strates"),
        co2_evite_traitement_eau=ref.get(CAS_ARROSAGE, "CO2 évité par traitement d'eau non prélevée", "Toutes strates"),
        cout_journee_jardinier=ref.get(CAS_ARROSAGE, "Coût d'une journée de jardinier", "Toutes strates"),
        km_journee_jardinier=ref.get(CAS_ARROSAGE, "Distance parcourue par journée de jardinier évitée", "Toutes strates"),
        sondes_par_ha=ref.get(CAS_ARROSAGE, "Densité de sondes d'humidité par hectare arrosé", strate),
        croissance_surfaces=ref.get(CAS_ARROSAGE, "Croissance annuelle des surfaces arrosées", strate),
        energie_recyclage=ref.get(CAS_ARROSAGE, "Énergie de recyclage des vannes et sondes en fin de vie", "Toutes strates"),
        co2_recyclage=ref.get(CAS_ARROSAGE, "CO2 de recyclage des vannes et sondes en fin de vie", "Toutes strates"),
    )


def surface_et_volume_arrosage(params: dict, population: float) -> tuple[float, float]:
    """Grandeurs EXTENSIVES (dérivées de la population) : à sommer entre communes,
    pas à moyenner comme les autres paramètres (coûts, taux)."""
    surface_arrosee_m2 = population * params["m2_par_hab"] * params["part_arrosee"]
    return surface_arrosee_m2, surface_arrosee_m2 * params["volume_par_m2"]


def parc_vannes_base_arrosage(params: dict, population: float) -> float:
    surface_arrosee_m2, _ = surface_et_volume_arrosage(params, population)
    return (surface_arrosee_m2 / 10000) * params["vannes_par_ha"]


def calcul_arrosage_depuis_parc(params: dict, parc_2026: float, taux_fn, surface_arrosee_m2: float, volume_total_m3: float) -> pd.DataFrame:
    rows = []
    stock_connecte_prec = parc_2026 * taux_fn(BASE_YEAR)
    # Sondes d'humidité (Excel l.32-36) : comptées comme objets connectés dans l'inventaire environnemental ; leur parc suit la surface arrosée
    sondes_0 = (surface_arrosee_m2 / 10000) * params["sondes_par_ha"]
    sondes_prec = sondes_0
    stock_ref = stock_connecte_prec  # parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

    for year in YEARS:
        n = year - BASE_YEAR
        parc_vannes = parc_2026 * (1 + params["croissance_parc"]) ** n
        taux_connexion = taux_fn(year)
        stock_connecte = parc_vannes * taux_connexion
        nouveaux = max(stock_connecte - stock_connecte_prec, 0.0)
        stock_add = max(stock_connecte - stock_ref, 0.0)  # parc connecté AJOUTÉ depuis l'année de référence
        sondes = sondes_0 * (1 + params["croissance_surfaces"]) ** n
        nouveaux_obj = nouveaux + max(sondes - sondes_prec, 0.0)   # vannes + sondes nouvelles
        stock_add_obj = stock_add + max(sondes - sondes_0, 0.0)    # vannes + sondes ajoutées depuis la référence

        capex = nouveaux * params["capex_unitaire"]
        opex_trans = stock_add * params["opex_transmission"]
        opex_serv = stock_connecte * params["opex_serveurs"]
        opex_log = stock_add * params["opex_logiciels"]
        em = stock_add * params["capex_unitaire"] * params["taux_em"]
        conduite = nouveaux * params["cout_conduite"]
        depenses = capex + opex_trans + opex_serv + opex_log + em + conduite

        volume_gere = volume_total_m3 * taux_connexion  # indicateur marché (volume sous vannes connectées, total)
        volume_gere_add = volume_total_m3 * stock_add / parc_vannes if parc_vannes > 0 else 0.0  # base des bénéfices (parc ajouté)
        # Économie d'eau : montée en charge 1 − (1 − d)^(année − 2024) (Excel l.39-42, exposant COLUMNS($G:col)) — 40 % à terme
        montee = 1 - (1 - params["eco_eau_numerique"]) ** (year - ANNEE_BASE_EXCEL + 1)
        benefice_eau = volume_gere_add * montee * params["valorisation_eau"]
        benefice_deplacement = stock_add * (params["eco_jardinier"] + params["eco_carburant"])
        externalites = benefice_eau + benefice_deplacement

        volume_economise_m3 = volume_gere_add * montee
        # Émissions sur vannes + sondes : fabrication (l.182) + pose (l.183) + usage (l.184-185) + recyclage (l.191)
        impact_energie = nouveaux_obj * (params["fabrication_energie"] + params["energie_recyclage"]) + stock_add_obj * params["usage_energie_an"]
        impact_co2 = (nouveaux_obj * (params["fabrication_co2"] + params["co2_recyclage"]) + (stock_add_obj * params["usage_energie_an"]) * params["mix_elec"]
                      + nouveaux_obj * params["install_km"] * params["emission_vehicule"])
        benefice_energie_physique = volume_economise_m3 * params["energie_pompage_evitee"]
        # CO2 évité : pompage + traitement de l'eau non prélevée (Excel l.187) + déplacements de jardiniers évités (l.190)
        benefice_co2_physique = (volume_economise_m3 * (params["energie_pompage_evitee"] * params["mix_elec"] + params["co2_evite_traitement_eau"])
                                 + stock_add * params["eco_jardinier"] / params["cout_journee_jardinier"] * params["km_journee_jardinier"] * params["emission_vehicule"])

        rows.append(dict(
            annee=year,
            surface_arrosee_m2=surface_arrosee_m2,
            volume_eau_total_m3=volume_total_m3,
            volume_eau_gere_m3=volume_gere,
            volume_eau_economise_m3=volume_economise_m3,
            parc_total_vannes=parc_vannes,
            stock_vannes_connectees=stock_connecte,
            nouvelles_vannes_connectees=nouveaux,
            capex=capex,
            opex_transmission=opex_trans,
            opex_serveurs=opex_serv,
            opex_logiciels=opex_log,
            opex_exploitation_maintenance=em,
            opex_conduite_changement=conduite,
            depenses_totales=depenses,
            benefice_eau=benefice_eau,
            impact_energie_kwh=impact_energie,
            impact_co2_kg=impact_co2,
            benefice_energie_kwh=benefice_energie_physique,
            benefice_co2_kg=benefice_co2_physique,
            bilan_net_energie_kwh=benefice_energie_physique - impact_energie,
            bilan_net_co2_kg=benefice_co2_physique - impact_co2,
            bilan_net_eau_m3=volume_economise_m3,
            benefice_deplacement=benefice_deplacement,
            externalites_totales=externalites,
            solde_annuel=externalites - depenses,
        ))
        stock_connecte_prec = stock_connecte
        sondes_prec = sondes

    return pd.DataFrame(rows)


def calcul_arrosage(ref: Referentiel, commune: pd.Series) -> ResultatCasUsage:
    strate = resolve_strate(commune)
    params = get_parametres_arrosage(ref, strate)
    population = float(commune["population"])
    surface_arrosee_m2, volume_total_m3 = surface_et_volume_arrosage(params, population)
    parc_2026 = (surface_arrosee_m2 / 10000) * params["vannes_par_ha"]
    traj = calcul_arrosage_depuis_parc(
        params, parc_2026, taux_compounding_fn(params["taux_connexion_base"], params["croissance_connexion"]),
        surface_arrosee_m2, volume_total_m3,
    )
    return ResultatCasUsage(CAS_ARROSAGE, commune["nom_standard"], strate, traj)


def calcul_arrosage_override(ref: Referentiel, communes: list, overrides: dict) -> ResultatCasUsage:
    if overrides.get("pct_2036") is None:
        raise ValueError("Arrosage connecté : le % de vannes connectées attendu en 2036 doit être renseigné dès que le nombre de vannes est saisi.")
    valider_coherence_objets(overrides, "Arrosage connecté", "vannes")
    cles_extensives = {"m2_par_hab", "part_arrosee", "volume_par_m2"}
    per_commune = []
    surface_totale = 0.0
    volume_total = 0.0
    for c in communes:
        params = get_parametres_arrosage(ref, resolve_strate(c))
        population = float(c["population"])
        surface, volume = surface_et_volume_arrosage(params, population)
        surface_totale += surface
        volume_total += volume
        per_commune.append((params, parc_vannes_base_arrosage(params, population)))
    poids_total = sum(poids for _, poids in per_commune) or 1.0
    blended = {
        k: sum(p[k] * poids for p, poids in per_commune) / poids_total
        for k in per_commune[0][0] if k not in cles_extensives
    }

    parc_2026 = overrides.get("nombre_objets") if overrides.get("nombre_objets") is not None else poids_total
    if overrides.get("nombre_objets_connectes") is not None:
        taux_2026 = (overrides["nombre_objets_connectes"] / parc_2026) if parc_2026 > 0 else 0.0
    else:
        taux_2026 = blended["taux_connexion_base"]

    traj = calcul_arrosage_depuis_parc(blended, parc_2026, taux_linear_fn(taux_2026, overrides["pct_2036"]), surface_totale, volume_total)
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resolve_strate(communes[0]) if len(communes) == 1 else f"Multi-strates (moyenne pondérée sur {len(communes)} communes)"
    return ResultatCasUsage(CAS_ARROSAGE, label, strate, traj)


def calcul_arrosage_cible_seule(ref: Referentiel, communes: list, pct_2036: float) -> ResultatCasUsage:
    resultats = []
    for c in communes:
        strate = resolve_strate(c)
        params = get_parametres_arrosage(ref, strate)
        population = float(c["population"])
        surface, volume = surface_et_volume_arrosage(params, population)
        parc_2026 = parc_vannes_base_arrosage(params, population)
        traj = calcul_arrosage_depuis_parc(params, parc_2026, taux_linear_fn(params["taux_connexion_base"], pct_2036), surface, volume)
        resultats.append(ResultatCasUsage(CAS_ARROSAGE, c["nom_standard"], strate, traj))
    traj_totale = sum(r.trajectoire.set_index("annee") for r in resultats).reset_index()
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = resultats[0].strate if len(communes) == 1 else "Multi-strates"
    return ResultatCasUsage(CAS_ARROSAGE, label, strate, traj_totale)


def calcul_arrosage_avec_options(ref: Referentiel, communes: list, overrides: dict | None) -> ResultatCasUsage:
    ov = overrides or {}
    if ov.get("pct_2036") is None:
        raise ValueError("Arrosage connecté : le % de vannes connectées attendu en 2036 est obligatoire pour ce cas d'usage.")
    objets_vides = ov.get("nombre_objets") is None and ov.get("nombre_objets_connectes") is None
    if objets_vides:
        return calcul_arrosage_cible_seule(ref, communes, ov["pct_2036"])
    return calcul_arrosage_override(ref, communes, ov)


# ------------------------------------------------------------------------------------
# Calcul — Surveillance inondation (Excel V1.2, onglet « Prévention Inondation »)
# ------------------------------------------------------------------------------------
# Logique propre à ce cas d'usage : pas de parc d'objets connectés saisi par l'utilisateur, mais un
# système de surveillance (« territoire GEMAPI équivalent » : ≈ 40 points de mesure, plateforme de
# prévision et d'alerte) déployé UNE fois sur le territoire choisi, à une date indiquée par l'utilisateur.
#   1) dommages annuels du territoire selon son profil de vigilance (1, 2 ou 3) :
#      Σ_niveau (population du territoire au niveau ÷ population de référence) × dommages nationaux du niveau
#      avec dommages nationaux du niveau = 1 Md€ (2025) × part du niveau × (1 + 2,5 %)^(année − 2025) ;
#   2) dommages évités = dommages du territoire × part adressable par une surveillance locale (50 %) × taux d'évitement
#      net (10 %), soit 5 % des dommages comme dans l'Excel, dès l'année de déploiement ;
#   3) coût d'UN système (CAPEX, transmission, serveurs, logiciels, E&M, conduite du changement) ;
#   4) bilan net économique et bilan net environnemental (fabrication, pose, usage, fin de vie).
# Les flux courent de l'année de déploiement à 2036 (comme l'Excel : CAPEX et conduite du changement l'année
# du déploiement, coûts récurrents et gains dès cette année). Un déploiement en 2026, antérieur à l'horizon
# d'analyse (2027-2036), est rattaché à la première année de l'horizon.

CAS_INONDATION = "Surveillance inondation"
ANNEE_DEPLOIEMENT_MIN = 2026
ANNEE_DEPLOIEMENT_MAX = 2036
NIVEAUX_VIGILANCE = (3, 2, 1)


def get_parametres_inondation(ref: Referentiel) -> dict:
    g = lambda hyp, strate="Toutes strates": ref.get(CAS_INONDATION, hyp, strate)
    return dict(
        dommages_2025=g("Dommages annuels moyens d'inondation en France (2025)"),
        croissance_dommages=g("Croissance annuelle des dommages"),
        part_groupe={n: g("Part des dommages annuels du groupe de vigilance", f"Vigilance {n}") for n in NIVEAUX_VIGILANCE},
        base_repartition=g("Base de répartition des dommages sur le territoire"),
        part_adressable=g("Part des dommages adressable par une surveillance locale"),
        taux_evitement=g("Taux d'évitement net des dommages (alerte locale)"),
        economie_veille=g("Économie de veille et d'astreinte"),
        capex=g("CAPEX stations de mesure"),
        nb_points_mesure=g("Nombre de points de mesure par territoire"),
        transmission_par_point=g("OPEX transmission par point de mesure"),
        serveurs=g("OPEX serveurs et hébergement"),
        logiciels=g("OPEX logiciels — service de prévision et d'alerte"),
        taux_em=g("Exploitation et maintenance (% du CAPEX cumulé)"),
        em_forfait=g("Exploitation et maintenance — forfait annuel (hydrométrie, jaugeages)"),
        conduite_changement=g("Évolution et conduite du changement (one-shot)"),
        fabrication_co2=g("CO2 de fabrication (stations, pluviomètres, électronique)"),
        fabrication_energie=g("Énergie grise de fabrication"),
        install_co2=g("CO2 d'installation (supports, génie civil léger, déplacements)"),
        usage_energie_an=g("Consommation d'usage (télétransmission et plateforme)"),
        mix_elec=g("Mix électrique français"),
        fin_vie_co2=g("CO2 de fin de vie (recyclage des dispositifs)"),
    )


def profil_vigilance(communes) -> dict:
    """Population par niveau de vigilance d'un ensemble de communes (liste de Series ou DataFrame)."""
    df = communes if isinstance(communes, pd.DataFrame) else pd.DataFrame(list(communes))
    pop = pd.to_numeric(df["population"], errors="coerce").fillna(0.0)
    niv = pd.to_numeric(df["vigilance"], errors="coerce")
    par_niveau = {n: float(pop[niv == n].sum()) for n in (1, 2, 3)}
    sans = ~niv.isin([1, 2, 3])
    return dict(pop=par_niveau, population_totale=sum(par_niveau.values()),
                population_sans_vigilance=float(pop[sans].sum()), nb_sans_vigilance=int(sans.sum()))


def contexte_national_depuis_communes(communes) -> dict:
    """Dénominateurs nationaux : population de toutes les communes et par niveau de vigilance."""
    pr = profil_vigilance(communes)
    return dict(population_nationale=pr["population_totale"] + pr["population_sans_vigilance"],
                population_par_vigilance=pr["pop"])


def dommages_nationaux_niveau(p: dict, niveau: int, annee: int) -> float:
    """Dommages nationaux d'un niveau de vigilance pour une année (Excel lignes 2 à 5)."""
    return p["dommages_2025"] * (1 + p["croissance_dommages"]) ** (annee - ANNEE_BASE_EXCEL) * p["part_groupe"][niveau]


def calcul_inondation_avec_options(ref: Referentiel, communes: list, overrides: dict | None) -> ResultatCasUsage:
    ov = overrides or {}
    annee = ov.get("annee_deploiement")
    ok = isinstance(annee, (int, float)) and not isinstance(annee, bool) and float(annee).is_integer() \
        and ANNEE_DEPLOIEMENT_MIN <= annee <= ANNEE_DEPLOIEMENT_MAX
    if not ok:
        raise ValueError(f"Surveillance inondation : la date de déploiement du système de surveillance est obligatoire "
                         f"(année comprise entre {ANNEE_DEPLOIEMENT_MIN} et {ANNEE_DEPLOIEMENT_MAX}).")
    annee = int(annee)
    nat = ov.get("national") or ref.contexte_national
    if not nat or not nat["population_nationale"] > 0:
        raise ValueError("Surveillance inondation : colonne « vigilance » absente du fichier des communes "
                         "(population nationale par niveau de vigilance non disponible).")
    p = get_parametres_inondation(ref)
    profil = profil_vigilance(communes)
    if profil["nb_sans_vigilance"] > 0:
        raise ValueError(f"Surveillance inondation : niveau de vigilance manquant pour {profil['nb_sans_vigilance']} commune(s) du territoire.")
    annee_effective = max(annee, START_YEAR)
    denominateur = lambda n: nat["population_par_vigilance"][n] if p["base_repartition"] == 1 else nat["population_nationale"]

    capex_cumule = 0.0
    rows = []
    for year in YEARS:
        deploye = 1 if year >= annee_effective else 0
        nouveau = 1 if year == annee_effective else 0
        # 1) dommages potentiels du territoire, par niveau de vigilance
        dommages_niveau = {n: profil["pop"][n] / denominateur(n) * dommages_nationaux_niveau(p, n, year) for n in NIVEAUX_VIGILANCE}
        dommages = sum(dommages_niveau.values())
        # 2) dommages évités (+ veille et astreinte évitées)
        dommages_evites = deploye * dommages * p["part_adressable"] * p["taux_evitement"]
        economie_veille = deploye * p["economie_veille"]
        # 3) coût d'un système
        capex = nouveau * p["capex"]
        capex_cumule += capex
        opex_transmission = deploye * p["nb_points_mesure"] * p["transmission_par_point"]
        opex_serveurs = deploye * p["serveurs"]
        opex_logiciels = deploye * p["logiciels"]
        em = deploye * (p["taux_em"] * capex_cumule + p["em_forfait"])
        conduite = nouveau * p["conduite_changement"]
        depenses = capex + opex_transmission + opex_serveurs + opex_logiciels + em + conduite
        # 4) bilan environnemental (aucun bénéfice carbone ou énergie : uniquement des émissions)
        impact_energie = nouveau * p["fabrication_energie"] + deploye * p["usage_energie_an"]
        impact_co2 = nouveau * (p["fabrication_co2"] + p["install_co2"] + p["fin_vie_co2"]) + deploye * p["usage_energie_an"] * p["mix_elec"]
        rows.append(dict(
            annee=year, deploye=deploye, dommages_territoire=dommages,
            dommages_vigilance_3=dommages_niveau[3], dommages_vigilance_2=dommages_niveau[2], dommages_vigilance_1=dommages_niveau[1],
            pop_vigilance_3=profil["pop"][3], pop_vigilance_2=profil["pop"][2], pop_vigilance_1=profil["pop"][1],
            dommages_evites=dommages_evites, economie_veille=economie_veille,
            capex=capex, opex_transmission=opex_transmission, opex_serveurs=opex_serveurs, opex_logiciels=opex_logiciels,
            opex_exploitation_maintenance=em, opex_conduite_changement=conduite,
            depenses_totales=depenses, externalites_totales=dommages_evites + economie_veille,
            benefice_energie_kwh=0.0, impact_energie_kwh=impact_energie, bilan_net_energie_kwh=-impact_energie,
            benefice_co2_kg=0.0, impact_co2_kg=impact_co2, bilan_net_co2_kg=-impact_co2,
        ))
    label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
    strate = f"Vigilance : {', '.join(f'{int(profil['pop'][n]):,} hab. niveau {n}' for n in NIVEAUX_VIGILANCE if profil['pop'][n] > 0)}".replace(",", " ")
    return ResultatCasUsage(CAS_INONDATION, label, strate, pd.DataFrame(rows))


# ------------------------------------------------------------------------------------
# Mutualisation inter-cas d'usage (panneau PILOTAGE)
# ------------------------------------------------------------------------------------

@dataclass
class ResultatMutualisation:
    trajectoire: pd.DataFrame                 # une ligne par année : économie de mutualisation
    economie_totale: float = field(init=False)
    depenses_silo: float = field(init=False)
    depenses_mutualise: float = field(init=False)
    solde_silo: float = field(init=False)
    solde_mutualise: float = field(init=False)
    # détail par cas d'usage, dans l'ordre des résultats : dépenses silo / mutualisées, économie, bénéfices, soldes
    par_cas: list = field(default_factory=list)

    def __post_init__(self):
        self.economie_totale = self.trajectoire["economie_mutualisation"].sum()


def calcul_mutualisation(
    resultats: list[ResultatCasUsage], curseur_m: float = 1.0
) -> ResultatMutualisation:
    """
    Calcule l'économie de mutualisation quand plusieurs cas d'usage (2 à 6) sont activés
    ensemble, en appliquant les abattements du panneau PILOTAGE aux postes mutualisables
    (réseau, serveurs, logiciels, exploitation-maintenance, conduite du changement).
    L'abattement de chaque poste s'applique à la somme de ce poste sur TOUS les cas
    d'usage activés — la mécanique se généralise naturellement au-delà d'une paire.

    curseur_m : part du programme déployée en coordination (0 = silo, 1 = programme
    entièrement coordonné). Par défaut 1.0 quand plusieurs cas d'usage sont activés
    ensemble, cf. logique du panneau PILOTAGE (ligne 91).
    """
    abattements = get_abattements_mutualisation(resultats)
    trajectoires = [r.trajectoire.set_index("annee") for r in resultats]

    rows = []
    for year in YEARS:
        economie_annuelle = 0.0
        detail = {}
        for poste, abattement in abattements.items():
            cout_poste = sum(t.loc[year, poste] for t in trajectoires)
            eco_poste = curseur_m * abattement * cout_poste
            detail[f"economie_{poste}"] = eco_poste
            economie_annuelle += eco_poste
        rows.append(dict(annee=year, economie_mutualisation=economie_annuelle, **detail))

    traj = pd.DataFrame(rows)
    res = ResultatMutualisation(traj)
    res.depenses_silo = sum(r.total_depenses for r in resultats)
    res.depenses_mutualise = res.depenses_silo - res.economie_totale
    externalites = sum(r.total_externalites for r in resultats)
    res.solde_silo = externalites - res.depenses_silo
    res.solde_mutualise = externalites - res.depenses_mutualise
    # Détail par cas d'usage : abattements = taux par poste, donc part exacte de chaque cas (la somme redonne les totaux)
    for r in resultats:
        economie = sum(curseur_m * abattement * r.trajectoire[poste].sum() for poste, abattement in abattements.items())
        depenses, ext = r.total_depenses, r.total_externalites
        res.par_cas.append(dict(cas_usage=r.cas_usage, depenses_silo=depenses, depenses_mutualise=depenses - economie, economie=economie,
                                externalites=ext, solde_silo=ext - depenses, solde_mutualise=ext - (depenses - economie)))
    return res


# ------------------------------------------------------------------------------------
# Agrégation multi-communes (EPCI / département)
# ------------------------------------------------------------------------------------

def _territoire(calcul_fn, cas_usage_label):
    """Fabrique un wrapper 'territoire' (somme sur plusieurs communes) pour une
    fonction de calcul par commune — évite de dupliquer la même mécanique 6 fois."""
    def wrapper(ref: Referentiel, communes: list[pd.Series]) -> ResultatCasUsage:
        resultats = [calcul_fn(ref, c) for c in communes]
        traj = sum(r.trajectoire.set_index("annee") for r in resultats).reset_index()
        label = communes[0]["nom_standard"] if len(communes) == 1 else f"{len(communes)} communes"
        strate = resultats[0].strate if len(communes) == 1 else "Multi-strates"
        return ResultatCasUsage(cas_usage_label, label, strate, traj)
    return wrapper


calcul_eau_territoire = _territoire(calcul_eau, CAS_EAU)
calcul_ep_territoire = _territoire(calcul_ep, CAS_EP)
calcul_energie_batiments_territoire = _territoire(calcul_energie_batiments, CAS_ENERGIE)
calcul_dechets_pav_territoire = _territoire(calcul_dechets_pav, CAS_PAV)
calcul_dechets_bacs_territoire = _territoire(calcul_dechets_bacs, CAS_BACS)
calcul_arrosage_territoire = _territoire(calcul_arrosage, CAS_ARROSAGE)

# Registre des 6 cas d'usage — même principe que le registre JS de l'interface HTML.
# Pointe vers les fonctions "avec_options" (auto si rien saisi, saisie manuelle sinon).
CAS_USAGE_REGISTRY = {
    "eau": (CAS_EAU, calcul_eau_avec_options),
    "ep": (CAS_EP, calcul_ep_avec_options),
    "energie": (CAS_ENERGIE, calcul_energie_batiments_avec_options),
    "pav": (CAS_PAV, calcul_dechets_pav_avec_options),
    "bacs": (CAS_BACS, calcul_dechets_bacs_avec_options),
    "arrosage": (CAS_ARROSAGE, calcul_arrosage_avec_options),
    "inondation": (CAS_INONDATION, calcul_inondation_avec_options),   # système unique par territoire : hors mutualisation IoT
}


def communes_epci(ref: Referentiel, nom_epci: str) -> pd.DataFrame:
    """Recherche un EPCI par nom et renvoie toutes ses communes membres."""
    norm = _normalize(nom_epci)
    matches = ref.communes[ref.communes["epci_nom"].apply(_normalize).str.contains(norm, na=False)]
    if len(matches) == 0:
        raise ValueError(f"Aucun EPCI trouvé pour « {nom_epci} ».")
    epci_noms = matches["epci_nom"].unique()
    if len(epci_noms) > 1:
        raise ValueError(f"Plusieurs EPCI correspondent à « {nom_epci} » : {list(epci_noms)}")
    return ref.communes[ref.communes["epci_nom"] == epci_noms[0]]


def communes_departement(ref: Referentiel, nom_dep: str) -> pd.DataFrame:
    """Recherche un département par nom ou par code (ex. « Loire » ou « 42 »)."""
    norm = _normalize(nom_dep)
    par_code = ref.communes[ref.communes["dep_code"].astype(str).apply(_normalize) == norm]
    if len(par_code):
        return par_code
    matches = ref.communes[ref.communes["dep_nom"].apply(_normalize).str.contains(norm, na=False)]
    if len(matches) == 0:
        raise ValueError(f"Aucun département trouvé pour « {nom_dep} ».")
    dep_noms = matches["dep_nom"].unique()
    if len(dep_noms) > 1:
        raise ValueError(f"Plusieurs départements correspondent à « {nom_dep} » : {list(dep_noms)}")
    return ref.communes[ref.communes["dep_nom"] == dep_noms[0]]


# ------------------------------------------------------------------------------------
# Point d'entrée
# ------------------------------------------------------------------------------------

def run(ref: Referentiel, nom_territoire: str, cas_usages: list[str],
        echelle: str = "commune", exclure_communes: list[str] | None = None,
        exclure_epci: list[str] | None = None, donnees: dict | None = None):
    """echelle : 'commune', 'epci' ou 'departement'.
    exclure_communes : noms de communes à retirer du périmètre (EPCI/département).
    exclure_epci : noms d'EPCI à retirer entièrement (département uniquement).
    donnees : overrides par cas d'usage, ex. {"eau": {"nombre_objets": 45000,
    "nombre_objets_connectes": 10000, "pct_2036": 0.8}, "energie": {"petit": {...}, "grand": {...}}}.
    """
    if echelle in ("epci", "departement"):
        if echelle == "epci":
            communes_df = communes_epci(ref, nom_territoire)
            territoire_label = communes_df.iloc[0]["epci_nom"]
            type_label = "EPCI"
        else:
            communes_df = communes_departement(ref, nom_territoire)
            territoire_label = communes_df.iloc[0]["dep_nom"]
            type_label = f"Département {communes_df.iloc[0]['dep_code']}"

        avant = len(communes_df)
        if exclure_epci:
            epci_norm = {_normalize(n) for n in exclure_epci}
            communes_df = communes_df[~communes_df["epci_nom"].apply(_normalize).isin(epci_norm)]
        if exclure_communes:
            noms_norm = {_normalize(n) for n in exclure_communes}
            communes_df = communes_df[~communes_df["nom_standard"].apply(_normalize).isin(noms_norm)]
        exclues = avant - len(communes_df)
        if exclues:
            type_label += f" — {exclues} commune(s) exclue(s) sur {avant}"

        communes = [row for _, row in communes_df.iterrows()]
        if not communes:
            raise ValueError("Toutes les communes du territoire ont été exclues — aucune commune restante à calculer.")
        pseudo_commune = pd.Series({
            "nom_standard": territoire_label,
            "dep_nom": f"{type_label} — {len(communes)} communes",
            "population": communes_df["population"].sum(),
            "nombre_menages": communes_df["nombre_menages"].sum(),
            "Strate": "Multi-strates (" + ", ".join(
                f"{n} {s}" for s, n in communes_df["Strate"].value_counts().items()
            ) + ")",
        })
    else:
        commune = ref.find_commune(nom_territoire)
        communes = [commune]
        pseudo_commune = commune

    resultats = {}
    for cle in cas_usages:
        if cle not in CAS_USAGE_REGISTRY:
            raise ValueError(f"Cas d'usage inconnu : « {cle} ». Choix possibles : {list(CAS_USAGE_REGISTRY)}")
        _, calcul_fn = CAS_USAGE_REGISTRY[cle]
        overrides = (donnees or {}).get(cle)
        resultats[cle] = calcul_fn(ref, communes, overrides)
    return resultats, pseudo_commune


POSTES_DEPENSES = [
    ("capex", "Objets connectés (CAPEX)"),
    ("opex_transmission", "Transmission"),
    ("opex_serveurs", "Serveurs & hosting"),
    ("opex_logiciels", "Logiciels"),
    ("opex_exploitation_maintenance", "Exploitation & maintenance"),
    ("opex_conduite_changement", "Conduite du changement"),
]


def afficher_repartition_depenses(res: ResultatCasUsage):
    """Affiche la répartition des dépenses cumulées (10 ans) par poste."""
    total = res.total_depenses or 1
    print(f"\n  Répartition des dépenses cumulées (10 ans)")
    print(f"  {'-' * 74}")
    for col, label in POSTES_DEPENSES:
        montant = res.trajectoire[col].sum()
        pct = montant / total * 100
        print(f"  {label:<38}{montant:>20,.0f} €{pct:>13,.1f}%")


def afficher_bilan_environnemental(res: ResultatCasUsage):
    """Affiche le bilan environnemental net (10 ans) : énergie, CO2, et eau si disponible."""
    t = res.trajectoire
    # Lecture : + = plus d'énergie consommée / de CO2 émis que d'économies générées ; − = économies nettes.
    # Seul l'AFFICHAGE est inversé : les colonnes bilan_net_* (bénéfices − émissions) ne changent pas.
    aff_energie = -t["bilan_net_energie_kwh"].sum()
    aff_co2_t = -t["bilan_net_co2_kg"].sum() / 1000
    signe_e = "+" if round(aff_energie) > 0 else ("-" if round(aff_energie) < 0 else " ")
    signe_c = "+" if round(aff_co2_t, 1) > 0 else ("-" if round(aff_co2_t, 1) < 0 else " ")
    print(f"\n  Bilan environnemental net (10 ans) — fabrication et usage des objets déduits des économies")
    print(f"  (lecture : + = consommation / émissions nettes ; - = économies nettes)")
    print(f"  {'-' * 74}")
    print(f"  Bilan net énergie                  {signe_e}{abs(aff_energie):>15,.0f} kWh")
    print(f"  Bilan net CO2                       {signe_c}{abs(aff_co2_t):>15,.1f} tCO2e")
    if "bilan_net_eau_m3" in t.columns:
        net_eau = t["bilan_net_eau_m3"].sum()
        print(f"  Bilan net eau                        {net_eau:>15,.0f} m³")


def afficher_indicateurs_marche(res: ResultatCasUsage):
    """Affiche les indicateurs marché clés 2026 → 2035 pour un cas d'usage."""
    t = res.trajectoire
    premiere, derniere = t.iloc[0], t.iloc[-1]

    if res.cas_usage == CAS_EAU:
        lignes = [
            ("Compteurs d'eau (parc total)", "parc_total_compteurs", False),
            ("Compteurs connectés (télérelève)", "stock_compteurs_connectes", False),
            ("Volume d'eau géré (m³/an)", "volume_eau_total_m3", False),
            ("Volume sous télérelève (m³/an)", "volume_eau_connecte_m3", False),
            ("Volume d'eau économisé (m³/an)", "volume_eau_economise_m3", False),
        ]
        taux = ("Taux de compteurs connectés",
                premiere["stock_compteurs_connectes"] / premiere["parc_total_compteurs"],
                derniere["stock_compteurs_connectes"] / derniere["parc_total_compteurs"])
    elif res.cas_usage == CAS_EP:
        lignes = [
            ("Points lumineux (parc total)", "parc_points_lumineux", False),
            ("Armoires de commande (parc total)", "parc_total_armoires", False),
            ("Armoires connectées", "stock_armoires_connectees", False),
            ("Consommation éclairage public (MWh/an)", "conso_totale_mwh", False),
            ("Énergie économisée (MWh/an)", "energie_economisee_mwh", False),
        ]
        taux = ("Taux d'armoires connectées",
                premiere["stock_armoires_connectees"] / premiere["parc_total_armoires"],
                derniere["stock_armoires_connectees"] / derniere["parc_total_armoires"])
    elif res.cas_usage == CAS_ENERGIE:
        lignes = [
            ("Petits bâtiments <500m² (parc)", "parc_petits_batiments", False),
            ("Petits bâtiments connectés (IoT)", "stock_petits_connectes", False),
            ("Grands bâtiments >500m² (parc)", "parc_grands_batiments", False),
            ("Grands bâtiments connectés (GTB)", "stock_grands_connectes", False),
            ("Dépense énergétique totale (€/an)", "depense_energie_totale", False),
        ]
        taux = ("Taux de connexion IoT (petits bâtiments)",
                premiere["stock_petits_connectes"] / premiere["parc_petits_batiments"],
                derniere["stock_petits_connectes"] / derniere["parc_petits_batiments"])
    elif res.cas_usage == CAS_PAV:
        lignes = [
            ("Points d'apport volontaire (parc total)", "parc_total_pav", False),
            ("PAV connectés (sondes de remplissage)", "stock_pav_connectes", False),
        ]
        taux = ("Taux de PAV connectés",
                premiere["stock_pav_connectes"] / premiere["parc_total_pav"],
                derniere["stock_pav_connectes"] / derniere["parc_total_pav"])
    elif res.cas_usage == CAS_BACS:
        lignes = [
            ("Bacs individuels (parc total)", "parc_total_bacs", False),
            ("Bacs connectés (puce RFID)", "stock_bacs_connectes", False),
        ]
        taux = ("Taux de bacs connectés",
                premiere["stock_bacs_connectes"] / premiere["parc_total_bacs"],
                derniere["stock_bacs_connectes"] / derniere["parc_total_bacs"])
    else:  # CAS_ARROSAGE
        lignes = [
            ("Surface d'espaces verts arrosés (m²)", "surface_arrosee_m2", False),
            ("Vannes d'arrosage (parc total)", "parc_total_vannes", False),
            ("Vannes connectées", "stock_vannes_connectees", False),
            ("Volume d'eau géré numériquement (m³/an)", "volume_eau_gere_m3", False),
        ]
        taux = ("Taux de vannes connectées",
                premiere["stock_vannes_connectees"] / premiere["parc_total_vannes"],
                derniere["stock_vannes_connectees"] / derniere["parc_total_vannes"])

    print(f"\n  Indicateurs marché{'':<22}{'2026':>16}{'2035':>16}{'Évolution':>14}")
    print(f"  {'-' * 74}")
    for label, col, _ in lignes:
        a, b = premiere[col], derniere[col]
        evol = 0 if a == 0 else (b - a) / a * 100
        print(f"  {label:<38}{a:>16,.0f}{b:>16,.0f}{evol:>13,.1f}%")
    label, a, b = taux
    pts = (b - a) * 100
    print(f"  {label:<38}{a * 100:>15,.1f}%{b * 100:>15,.1f}%{pts:>10,.1f} pts")


def afficher_inondation(res: ResultatCasUsage):
    """Affiche le résultat du cas d'usage « Surveillance inondation » (dommages, gains, coût d'un système, bilans)."""
    t = res.trajectoire
    dommages, evites = t["dommages_territoire"].sum(), t["dommages_evites"].sum()
    couts = res.total_depenses
    net_eco = res.total_externalites - couts
    deploiement = int(t.loc[t["deploye"] == 1, "annee"].min())
    print(f"  Profil du territoire : {res.strate}")
    print(f"  Système de surveillance déployé en {deploiement} (flux dès cette année)")
    print(f"  Dommages potentiels du territoire {t['annee'].min()}-{t['annee'].max()}    : {dommages:>15,.0f} €")
    print(f"  Dommages évités grâce à la surveillance    : {evites:>15,.0f} €")
    print(f"  Coût de mise en place (1 système à l'échelle départementale, 10 ans) : {couts:>13,.0f} €")
    signe = "+" if net_eco >= 0 else ""
    print(f"  Bilan net économique                       : {signe}{net_eco:>14,.0f} €")
    afficher_repartition_depenses(res)
    afficher_bilan_environnemental(res)
    print(f"\n  Dommages par niveau de vigilance (population du territoire, dommages annuels)")
    print(f"  {'-' * 74}")
    premiere, derniere = t.iloc[0], t.iloc[-1]
    for n in NIVEAUX_VIGILANCE:
        print(f"  Vigilance {n} : {premiere[f'pop_vigilance_{n}']:>12,.0f} hab.{premiere[f'dommages_vigilance_{n}']:>16,.0f} €{derniere[f'dommages_vigilance_{n}']:>16,.0f} €")


def afficher_synthese(commune: pd.Series, resultats: dict[str, ResultatCasUsage]):
    print(f"\n{'=' * 78}")
    print(f"TERRITOIRE : {commune['nom_standard']} ({commune['dep_nom']})")
    menages_val = commune.get("nombre_menages")
    if pd.isna(menages_val):
        pdl_val = commune.get("nombre_points_livraison")
        menages_str = f"n/d (points de livraison : {int(pdl_val):,})" if pd.notna(pdl_val) else "n/d"
    else:
        menages_str = f"{int(menages_val):,}"
    print(f"  Population : {int(commune['population']):,} hab. | Ménages : {menages_str} "
          f"| Strate : {commune['Strate']}")
    print(f"  Horizon : {START_YEAR}-{END_YEAR} (10 ans)")
    print(f"{'=' * 78}")

    total_dep_global = 0.0
    total_ext_global = 0.0

    for res in resultats.values():
        print(f"\n--- {res.cas_usage} ---")
        if res.cas_usage == CAS_INONDATION:
            afficher_inondation(res)      # système unique par territoire : exclu des totaux consolidés et de la mutualisation IoT
            continue
        print(f"  Total dépenses (CAPEX+OPEX) 10 ans      : {res.total_depenses:>15,.0f} €")
        print(f"  Total externalités/bénéfices 10 ans     : {res.total_externalites:>15,.0f} €")
        signe = "+" if res.solde >= 0 else ""
        print(f"  Solde (bénéfices - dépenses)             : {signe}{res.solde:>14,.0f} €")
        afficher_repartition_depenses(res)
        afficher_bilan_environnemental(res)
        afficher_indicateurs_marche(res)
        total_dep_global += res.total_depenses
        total_ext_global += res.total_externalites

    iot = [r for r in resultats.values() if r.cas_usage != CAS_INONDATION]
    if len(iot) > 1:
        print(f"\n--- TOTAL CONSOLIDÉ — SILO (chaque cas d'usage pour lui-même) ---")
        print(f"  Total dépenses 10 ans                   : {total_dep_global:>15,.0f} €")
        print(f"  Total externalités 10 ans                : {total_ext_global:>15,.0f} €")
        solde_global = total_ext_global - total_dep_global
        signe = "+" if solde_global >= 0 else ""
        print(f"  Solde global (silo)                      : {signe}{solde_global:>14,.0f} €")

        mut = calcul_mutualisation(iot)
        print(f"\n--- TOTAL CONSOLIDÉ — MUTUALISÉ (réseau, serveurs, logiciels, "
              f"E&M, conduite du changement partagés) ---")
        print(f"  Économie de mutualisation 10 ans         : {mut.economie_totale:>15,.0f} €")
        print(f"  Total dépenses 10 ans (mutualisé)        : {mut.depenses_mutualise:>15,.0f} €")
        signe = "+" if mut.solde_mutualise >= 0 else ""
        print(f"  Solde global (mutualisé)                 : {signe}{mut.solde_mutualise:>14,.0f} €")
        # Détail des dépenses par cas d'usage : sommes sur 10 ans, en silo puis mutualisées, avec l'économie de chaque cas
        # (la somme des lignes redonne les totaux ci-dessus)
        print(f"\n  Dépenses par cas d'usage (10 ans, en €)")
        print(f"  {'Cas d' + chr(39) + 'usage':<40}{'Dépenses silo':>16}{'Dépenses mutualisées':>23}{'Économie':>14}")
        for pc in mut.par_cas:
            print(f"  {pc['cas_usage'][:39]:<40}{pc['depenses_silo']:>16,.0f}{pc['depenses_mutualise']:>23,.0f}{pc['economie']:>14,.0f}")
        print(f"  {'TOTAL':<40}{mut.depenses_silo:>16,.0f}{mut.depenses_mutualise:>23,.0f}{mut.economie_totale:>14,.0f}")
        print(f"\n  >>> Économie de mutualisation : {mut.economie_totale:,.0f} € "
              f"économisés sur 10 ans en coordonnant les {len(iot)} cas d'usage activés. <<<")
    print()


def main():
    parser = argparse.ArgumentParser(description="Moteur de calcul 'Mon territoire local' — Eau / Éclairage public")
    parser.add_argument("territoire", help="Nom de la commune, de l'EPCI ou du département")
    parser.add_argument("--echelle", choices=["commune", "epci", "departement"], default="commune",
                        help="Échelle du territoire (défaut : commune). EPCI et département cumulent leurs communes.")
    parser.add_argument("--cas", nargs="+", choices=list(CAS_USAGE_REGISTRY), default=["eau", "ep"],
                         help="Cas d'usage à simuler (défaut : eau + ep). Choix : "
                              + ", ".join(CAS_USAGE_REGISTRY))
    parser.add_argument("--hypotheses", default="hypotheses_mon_territoire.csv")
    parser.add_argument("--communes", default="communes-france-2026.csv")
    parser.add_argument("--exclure-commune", nargs="+", default=None, metavar="NOM",
                         help="Nom(s) de commune(s) à exclure du périmètre EPCI/département (ex. --exclure-commune Auxerre)")
    parser.add_argument("--exclure-epci", nargs="+", default=None, metavar="NOM",
                         help="Nom(s) d'EPCI à exclure entièrement du périmètre département")
    parser.add_argument("--donnees", default=None, metavar="FICHIER.json",
                         help="Fichier JSON de saisie manuelle par cas d'usage, ex. : "
                              '{"eau": {"nombre_objets": 45000, "nombre_objets_connectes": 10000, "pct_2036": 0.8}, '
                              '"energie": {"petit": {"nombre_objets": 30, "pct_2036": 0.9}, "grand": null}}. '
                              "Cas d'usage omis ou valeur null → calcul automatique (population/ménages).")
    parser.add_argument("--annee-deploiement-inondation", type=int, default=None, metavar="ANNEE",
                         help="Année de déploiement du système de surveillance des inondations (2026-2036), obligatoire "
                              "pour le cas d'usage « inondation » (équivaut à {\"inondation\": {\"annee_deploiement\": ANNEE}} dans --donnees).")
    parser.add_argument("--export-csv", default=None, help="Chemin d'export CSV du détail annuel (optionnel)")
    args = parser.parse_args()

    donnees = None
    if args.donnees:
        with open(args.donnees, encoding="utf-8") as f:
            donnees = json.load(f)

    if args.annee_deploiement_inondation is not None:
        donnees = donnees or {}
        donnees.setdefault("inondation", {})["annee_deploiement"] = args.annee_deploiement_inondation

    ref = Referentiel(args.hypotheses, args.communes)
    try:
        resultats, commune = run(ref, args.territoire, args.cas, echelle=args.echelle,
                                  exclure_communes=args.exclure_commune, exclure_epci=args.exclure_epci,
                                  donnees=donnees)
    except ValueError as e:
        print(f"Erreur : {e}", file=sys.stderr)
        sys.exit(1)

    afficher_synthese(commune, resultats)

    if args.export_csv:
        frames = []
        for key, res in resultats.items():
            df = res.trajectoire.copy()
            df.insert(0, "cas_usage", res.cas_usage)
            df.insert(0, "commune", commune["nom_standard"])
            frames.append(df)
        pd.concat(frames, ignore_index=True).to_csv(args.export_csv, index=False, sep=";", encoding="utf-8-sig")
        print(f"Détail annuel exporté : {args.export_csv}")


if __name__ == "__main__":
    main()
