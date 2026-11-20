// Moteur de calcul (nouveau projet) — variante avec saisie manuelle des parcs d'objets
// connectés par cas d'usage, en plus (ou en lieu et place) de la dérivation automatique
// depuis la population/les ménages. Mêmes hypothèses source que "Mon territoire local".
//
// Horizon : 2026 est l'année de référence (données saisies par l'utilisateur ou dérivées
// du modèle), 2036 l'année cible à 10 ans. La trajectoire produite couvre 2027-2036.

const START_YEAR = 2027;
const END_YEAR = 2036;
const BASE_YEAR = 2026;
const ANNEE_BASE_EXCEL = 2025; // colonne G de l'Excel (« 2025 et précédemment ») : origine de la montée en charge des économies d'eau de l'arrosage
const YEARS = [];
for (let y = START_YEAR; y <= END_YEAR; y++) YEARS.push(y);

function _normalizeStrateText(s) {
  return (s || "").toString().trim().toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

// Résout la strate d'une commune de façon robuste, en trois passes de plus en plus
// tolérantes — le fichier communes existe dans plusieurs variantes selon la source
// (export Observatoire, réexport Excel, etc.) et le libellé de la colonne Strate change :
//   1) mot-clé exact ("rurale", "Métropole"...), avec normalisation accent/casse
//   2) mot-clé partiel ou motif de seuil dans le texte ("< 2000 hbts", "rural", "urbain"...)
//   3) repli sur la population + le rattachement EPCI (toujours disponibles, cf. chargement
//      du fichier) selon les mêmes seuils que ceux observés dans le référentiel national
function resolveStrate(commune) {
  const brut = (commune.Strate || "").toString().trim();
  const norm = _normalizeStrateText(brut);

  // Passe 1 — mot-clé exact
  const exact = {
    "métropole": "Métropole", "metropole": "Métropole",
    "urbaine": ">30k hab",
    "intermédiaire": "2-30k hab", "intermediaire": "2-30k hab",
    "rurale": "<2k hab",
  }[norm];
  if (exact) return exact;

  // Passe 2 — motif dans un texte plus libre : "< 2000 hbts", "2000-30000 habitants",
  // "urbain", "zone rurale", etc.
  if (norm.includes("metropole")) return "Métropole";
  if (norm.includes("rural")) return "<2k hab";
  if (norm.includes("urbain") && !norm.includes("periurbain") && !norm.includes("périurbain")) return ">30k hab";
  if (norm.includes("intermediaire")) return "2-30k hab";

  const nombres = (norm.match(/\d+/g) || []).map(Number);
  if (nombres.length) {
    if (norm.includes("<") || norm.includes("moins")) {
      if (nombres[0] <= 2500) return "<2k hab";
    }
    if (norm.includes(">") || norm.includes("plus")) {
      if (nombres[0] >= 25000) return ">30k hab";
    }
    if (nombres.length >= 2) {
      // motif "2000 - 30000" ou "entre 2000 et 30000"
      const [a, b] = nombres;
      if (a <= 2500 && b >= 25000) return "2-30k hab";
    }
  }

  // Passe 3 — repli sur population + EPCI, avec les mêmes seuils que ceux du
  // référentiel national (cf. atelier FNCCR : Métropole = statut institutionnel,
  // pas un seuil de population).
  const population = Number(commune.population);
  if (Number.isFinite(population)) {
    const epciNorm = _normalizeStrateText(commune.epci_nom || "");
    if (epciNorm.includes("metropole")) return "Métropole";
    if (population < 2000) return "<2k hab";
    if (population < 30000) return "2-30k hab";
    return ">30k hab";
  }

  throw new Error(
    `Strate inconnue pour la commune « ${commune.nom_standard || "?"} » : ` +
    `valeur lue « ${brut || "(vide)"} », et impossible de la déduire de la population ` +
    `(colonne "population" absente ou invalide pour cette commune). Vérifiez le fichier communes.`
  );
}

// Assiette "ménages" pour les cas d'usage qui en dépendent (Eau, Bacs individuels) :
// on privilégie le nombre de points de livraison (compteurs eau/énergie, source GRD/INSEE)
// quand il est disponible — plus précis que le nombre de ménages recensés, car il capture
// aussi les locaux professionnels et les résidences secondaires raccordés au réseau.
// Repli sur le nombre de ménages si la donnée est absente ou invalide (ex. Mayotte : le
// nombre de ménages n'est pas disponible, mais le nombre de points de livraison si).
function getBaseMenages(commune) {
  const pdl = Number(commune.nombre_points_livraison);
  if (Number.isFinite(pdl) && pdl > 0) return pdl;
  return Number(commune.nombre_menages);
}

const DENSITE_PL_STRATE = {
  "Métropole": "Métropole",
  ">30k hab": "Urbain/périurbain (≈>30k et 2-30k)",
  "2-30k hab": "Urbain/périurbain (≈>30k et 2-30k)",
  "<2k hab": "Rural (≈<2k)",
};

// Barème de mutualisation (remplace l'ancien taux fixe à 5 postes) : les abattements
// varient selon le nombre de cas d'usage combinés ET selon la présence ou non du cas
// d'usage Eau (le réseau/plateforme dédiés à la télérelève mutualisent différemment
// des autres verticales). Clé = nombre d'AUTRES cas d'usage combinés avec Eau (1 à 5)
// pour la table "avec Eau", ou nombre total de cas d'usage combinés (2 à 5) pour la
// table "sans Eau".
const ABATTEMENTS_AVEC_EAU = {
  1: { opex_transmission: 0.40, opex_serveurs: 0.30, opex_logiciels: 0.20, opex_exploitation_maintenance: 0.15, opex_conduite_changement: 0.10 },
  2: { opex_transmission: 0.45, opex_serveurs: 0.35, opex_logiciels: 0.25, opex_exploitation_maintenance: 0.20, opex_conduite_changement: 0.10 },
  3: { opex_transmission: 0.50, opex_serveurs: 0.40, opex_logiciels: 0.30, opex_exploitation_maintenance: 0.25, opex_conduite_changement: 0.10 },
  4: { opex_transmission: 0.55, opex_serveurs: 0.45, opex_logiciels: 0.35, opex_exploitation_maintenance: 0.30, opex_conduite_changement: 0.10 },
  5: { opex_transmission: 0.60, opex_serveurs: 0.50, opex_logiciels: 0.40, opex_exploitation_maintenance: 0.35, opex_conduite_changement: 0.10 },
};
const ABATTEMENTS_SANS_EAU = {
  2: { opex_transmission: 0.25, opex_serveurs: 0.20, opex_logiciels: 0.10, opex_exploitation_maintenance: 0.05, opex_conduite_changement: 0.10 },
  3: { opex_transmission: 0.30, opex_serveurs: 0.25, opex_logiciels: 0.15, opex_exploitation_maintenance: 0.10, opex_conduite_changement: 0.10 },
  4: { opex_transmission: 0.35, opex_serveurs: 0.30, opex_logiciels: 0.20, opex_exploitation_maintenance: 0.15, opex_conduite_changement: 0.10 },
  5: { opex_transmission: 0.40, opex_serveurs: 0.35, opex_logiciels: 0.25, opex_exploitation_maintenance: 0.20, opex_conduite_changement: 0.10 },
};

// Sélectionne le barème d'abattements applicable à une combinaison de résultats.
function getAbattementsMutualisation(resultats) {
  const hasEau = resultats.some((r) => r.cas_usage === CAS_EAU);
  const total = resultats.length;
  if (hasEau) {
    const autres = total - 1; // 1 à 5
    return ABATTEMENTS_AVEC_EAU[Math.min(autres, 5)];
  }
  return ABATTEMENTS_SANS_EAU[Math.min(Math.max(total, 2), 5)];
}

const CAS_EAU = "Eau - télérelève des compteurs";
const CAS_EP = "Éclairage public - armoires connectées";
const CAS_ENERGIE = "Énergie des bâtiments";
const CAS_PAV = "Déchets - points d'apport volontaire";
const CAS_BACS = "Déchets - bacs individuels";
const CAS_ARROSAGE = "Arrosage connecté";

function getHyp(hypotheses, cas_usage, hypothese, strate) {
  const rows = hypotheses.filter(
    (r) => r.cas_usage === cas_usage && r.hypothese === hypothese && (strate === undefined || r.strate === strate)
  );
  if (rows.length !== 1) {
    throw new Error(`Hypothèse introuvable ou ambiguë : ${cas_usage} / ${hypothese} / ${strate} (${rows.length} résultats)`);
  }
  return Number(rows[0].valeur);
}

// ---------- Eau : paramètres, trajectoire, et mode saisie manuelle ----------

function getParametresEau(hypotheses, strate) {
  return {
    croissanceParc: getHyp(hypotheses, CAS_EAU, "Croissance du parc de compteurs", "Toutes strates"),
    tauxConnexionBase: getHyp(hypotheses, CAS_EAU, "Taux de compteurs télérelevés (base 2025)", "Toutes strates"),
    croissanceConnexion: getHyp(hypotheses, CAS_EAU, "Croissance du parc télérelevé", "Toutes strates"),
    volumeParAbonne: getHyp(hypotheses, CAS_EAU, "Volume consommé par abonné", "Toutes strates"),
    tauxEcoEau: getHyp(hypotheses, CAS_EAU, "Économie d'eau générée par la télérelève", "Toutes strates"),
    valorisationEau: getHyp(hypotheses, CAS_EAU, "Valorisation de l'eau économisée", "Toutes strates"),
    ecoReleve: getHyp(hypotheses, CAS_EAU, "Économie de relève (technicien index)", strate),
    ecoDeplacement: getHyp(hypotheses, CAS_EAU, "Économie déplacement (carburant technicien index)", strate),
    capexUnitaire: getHyp(hypotheses, CAS_EAU, "CAPEX fourni-posé compteur communicant (part numérique 50%)", strate),
    opexTransmission: getHyp(hypotheses, CAS_EAU, "Transmission réseau (LoRa/NB-IoT)", strate),
    opexServeurs: getHyp(hypotheses, CAS_EAU, "Serveurs et hébergement", "Toutes strates"),
    opexLogiciels: getHyp(hypotheses, CAS_EAU, "Logiciel SAAS exploitation données", strate),
    tauxEM: getHyp(hypotheses, CAS_EAU, "Exploitation-maintenance (% du CAPEX cumulé installé)", strate),
    coutConduite: getHyp(hypotheses, CAS_EAU, "Conduite du changement / data science (1 ETP 70 000€ / 100 000 compteurs)", strate),
    fabricationEnergie: getHyp(hypotheses, CAS_EAU, "Énergie grise de fabrication", "Toutes strates"),
    fabricationCO2: getHyp(hypotheses, CAS_EAU, "CO2 de fabrication", "Toutes strates"),
    installKm: getHyp(hypotheses, CAS_EAU, "Déplacement d'installation", "Toutes strates"),
    usageEnergieAn: getHyp(hypotheses, CAS_EAU, "Consommation capteur + transmission + plateforme", "Toutes strates"),
    mixElec: getHyp(hypotheses, CAS_EAU, "Mix électrique français", "Toutes strates"),
    emissionVehicule: getHyp(hypotheses, CAS_EAU, "Émission véhicule utilitaire léger", "Toutes strates"),
    kmReleveEvites: getHyp(hypotheses, CAS_EAU, "Kilomètres de relève évités par compteur connecté", "Toutes strates"),
    energieRecyclage: getHyp(hypotheses, CAS_EAU, "Énergie de recyclage des compteurs en fin de vie", "Toutes strates"),
    co2Recyclage: getHyp(hypotheses, CAS_EAU, "CO2 de recyclage des compteurs en fin de vie", "Toutes strates"),
    partMaintenanceCorrective: getHyp(hypotheses, CAS_EAU, "Part de maintenance corrective rapportée aux km de relève évités", "Toutes strates"),
    co2EviteTraitementEau: getHyp(hypotheses, CAS_EAU, "CO2 évité par traitement d'eau non consommée", "Toutes strates"),
  };
}

// Trajectoire de taux de connexion "par défaut" (modèle national) : croissance
// composée depuis le taux de base, plafonnée à 100 %.
function tauxCompoundingFn(tauxBase, croissance) {
  return (year) => Math.min(tauxBase * Math.pow(1 + croissance, year - BASE_YEAR), 1.0);
}
// Trajectoire de taux de connexion "saisie manuelle" : interpolation linéaire entre le
// taux de l'année de référence (2026, dérivé ou fourni) et la cible fournie par
// l'utilisateur pour 2036 — plus simple et plus robuste qu'une extrapolation composée
// depuis une cible ponctuelle (fonctionne même quand le taux 2026 vaut 0).
function tauxLinearFn(taux2026, pctCible) {
  const nTotal = END_YEAR - BASE_YEAR; // 10
  return (year) => {
    const n = year - BASE_YEAR;
    return Math.max(0, Math.min(1, taux2026 + (pctCible - taux2026) * (n / nTotal)));
  };
}

// Valide la cohérence des deux valeurs saisies pour un cas d'usage : le nombre d'objets
// connectés ne peut pas dépasser le nombre total d'objets.
function validerCoherenceObjets(overrides, labelCasUsage, objetLabel) {
  if (overrides && overrides.nombreObjets != null && overrides.nombreObjetsConnectes != null
      && overrides.nombreObjetsConnectes > overrides.nombreObjets) {
    const de = /^[aeiouhAEIOUH]/.test(objetLabel) ? "d'" : "de ";
    throw new Error(
      `${labelCasUsage} : le nombre ${de}${objetLabel} connecté(e)s (${overrides.nombreObjetsConnectes}) ` +
      `ne peut pas dépasser le nombre total ${de}${objetLabel} (${overrides.nombreObjets}).`
    );
  }
}

// Calcule la trajectoire complète Eau à partir d'un parc "année de référence" (2026)
// et d'une fonction de taux de connexion — commun aux modes automatique et manuel.
function calculEauDepuisParc(params, parc2026, tauxFn) {
  const rows = [];
  let stockPrec = parc2026 * tauxFn(BASE_YEAR);
  const stockRef = stockPrec; // parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

  for (const year of YEARS) {
    const n = year - BASE_YEAR;
    const parcTotal = parc2026 * Math.pow(1 + params.croissanceParc, n);
    const tauxConnexion = tauxFn(year);
    const stock = parcTotal * tauxConnexion;
    const nouveaux = Math.max(stock - stockPrec, 0);
    const stockAdd = Math.max(stock - stockRef, 0); // parc connecté AJOUTÉ depuis l'année de référence

    const capex = nouveaux * params.capexUnitaire;
    const opexTrans = stockAdd * params.opexTransmission;
    const opexServ = stock * params.opexServeurs;
    const opexLog = stockAdd * params.opexLogiciels;
    const em = stockAdd * params.capexUnitaire * params.tauxEM;
    const conduite = nouveaux * params.coutConduite;
    const depenses = capex + opexTrans + opexServ + opexLog + em + conduite;

    const ecoEauM3 = stockAdd * params.volumeParAbonne * params.tauxEcoEau;
    const beneficeEau = ecoEauM3 * params.valorisationEau;
    const beneficeReleve = stockAdd * params.ecoReleve;
    const beneficeDeplacement = stockAdd * params.ecoDeplacement;
    const externalites = beneficeEau + beneficeReleve + beneficeDeplacement;

    // Émissions : fabrication + usage + pose + recyclage (l.177) + maintenance corrective (l.176 : 20 % des km de relève évités)
    const impactEnergie = nouveaux * (params.fabricationEnergie + params.energieRecyclage) + stockAdd * params.usageEnergieAn;
    const impactCO2 = nouveaux * (params.fabricationCO2 + params.co2Recyclage) + (stockAdd * params.usageEnergieAn) * params.mixElec
      + nouveaux * params.installKm * params.emissionVehicule
      + stockAdd * params.kmReleveEvites * params.emissionVehicule * params.partMaintenanceCorrective;
    const beneficeEnergiePhysique = 0;
    // CO2 évité : traitement de l'eau non consommée (Excel l.171) + déplacements de relève évités (l.175)
    const beneficeCO2Physique = ecoEauM3 * params.co2EviteTraitementEau + stockAdd * params.kmReleveEvites * params.emissionVehicule;

    rows.push({
      annee: year,
      parc_total: parcTotal,
      stock_connecte: stock,
      nouveaux: nouveaux,
      volume_eau_total_m3: parcTotal * params.volumeParAbonne,
      volume_eau_connecte_m3: stock * params.volumeParAbonne,
      volume_eau_economise_m3: ecoEauM3,
      capex, opex_transmission: opexTrans, opex_serveurs: opexServ, opex_logiciels: opexLog,
      opex_exploitation_maintenance: em, opex_conduite_changement: conduite,
      depenses_totales: depenses,
      benefice_eau: beneficeEau, benefice_releve: beneficeReleve, benefice_deplacement: beneficeDeplacement,
      externalites_totales: externalites,
      solde_annuel: externalites - depenses,
      impact_energie_kwh: impactEnergie,
      impact_co2_kg: impactCO2,
      benefice_energie_kwh: beneficeEnergiePhysique,
      benefice_co2_kg: beneficeCO2Physique,
      bilan_net_energie_kwh: beneficeEnergiePhysique - impactEnergie,
      bilan_net_co2_kg: beneficeCO2Physique - impactCO2,
      bilan_net_eau_m3: ecoEauM3,
    });
    stockPrec = stock;
  }

  return { cas_usage: CAS_EAU, trajectoire: rows };
}

function calculEau(hypotheses, commune) {
  const strate = resolveStrate(commune);
  const menages = getBaseMenages(commune);
  const params = getParametresEau(hypotheses, strate);
  const res = calculEauDepuisParc(params, menages, tauxCompoundingFn(params.tauxConnexionBase, params.croissanceConnexion));
  res.strate = strate;
  res.unite = "compteur(s) d'eau";
  return res;
}

// Mode "saisie manuelle" : mutualise (moyenne pondérée par l'assiette de référence de
// chaque commune) les paramètres par strate des communes du territoire, calcule un
// parc/taux de connexion 2026 à partir des valeurs saisies par l'utilisateur (ou du
// taux par défaut du modèle si seul le parc est saisi), puis projette linéairement
// jusqu'à la cible 2036 fournie.
function calculEauOverride(hypotheses, communes, overrides) {
  if (overrides.pct2036 == null) {
    throw new Error("Eau : le % de compteurs connectés attendu en 2036 doit être renseigné dès que le nombre de compteurs est saisi.");
  }
  validerCoherenceObjets(overrides, "Eau", "compteurs");
  const perCommune = communes.map((c) => ({
    params: getParametresEau(hypotheses, resolveStrate(c)),
    poids: getBaseMenages(c),
  }));
  const poidsTotal = perCommune.reduce((a, x) => a + x.poids, 0) || 1;
  const blended = {};
  for (const k of Object.keys(perCommune[0].params)) {
    blended[k] = perCommune.reduce((a, x) => a + x.params[k] * x.poids, 0) / poidsTotal;
  }

  const parc2026 = overrides.nombreObjets != null ? overrides.nombreObjets : poidsTotal;
  const taux2026 = overrides.nombreObjetsConnectes != null
    ? (parc2026 > 0 ? overrides.nombreObjetsConnectes / parc2026 : 0)
    : blended.tauxConnexionBase;

  const res = calculEauDepuisParc(blended, parc2026, tauxLinearFn(taux2026, overrides.pct2036));
  res.strate = communes.length === 1 ? resolveStrate(communes[0]) : `Multi-strates (moyenne pondérée sur ${communes.length} communes)`;
  res.unite = "compteur(s) d'eau";
  return res;
}

// Mode "cible 2036 seule" : ni le nombre de compteurs ni le nombre de connectés ne sont
// saisis, mais l'utilisateur a fixé une cible 2036 — le parc reste dérivé de la
// population (commune par commune, comme le mode automatique), mais le taux de connexion
// suit une trajectoire linéaire depuis le taux 2026 du modèle jusqu'à la cible saisie,
// au lieu de la courbe de croissance composée par défaut.
function calculEauCibleSeule(hypotheses, communes, pct2036) {
  const resultats = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresEau(hypotheses, strate);
    const menages = getBaseMenages(c);
    return calculEauDepuisParc(params, menages, tauxLinearFn(params.tauxConnexionBase, pct2036));
  });
  return sommerTrajectoires(resultats, CAS_EAU);
}

// Point d'entrée unique : bascule entre le calcul par défaut (dérivé de la
// population/des ménages, sommé commune par commune), le mode "cible 2036 seule", et le
// mode saisie manuelle complète, selon ce que l'utilisateur a renseigné.
function calculEauAvecOptions(hypotheses, communes, overrides) {
  const ov = overrides || {};
  if (ov.pct2036 == null) {
    throw new Error("Eau : le % de compteurs connectés attendu en 2036 est obligatoire pour ce cas d'usage.");
  }
  const objetsVides = ov.nombreObjets == null && ov.nombreObjetsConnectes == null;
  if (objetsVides) {
    return calculEauCibleSeule(hypotheses, communes, ov.pct2036);
  }
  return calculEauOverride(hypotheses, communes, ov);
}

function getParametresEP(hypotheses, strate) {
  const strateDensite = DENSITE_PL_STRATE[strate];
  const consoNationaleMWh = getHyp(hypotheses, CAS_EP, "Consommation nationale d'éclairage public (référence, pour info)", "Toutes strates");
  const parcNationalPL = getHyp(hypotheses, CAS_EP, "Parc national de points lumineux (référence 2025)", "Toutes strates");
  return {
    croissancePL: getHyp(hypotheses, CAS_EP, "Croissance du parc de points lumineux", "Toutes strates"),
    densiteHabParPL: getHyp(hypotheses, CAS_EP, "Densité de points lumineux par habitant (repère entretiens Nantes Métropole / USEDA)", strateDensite),
    ratioPLparArmoire: getHyp(hypotheses, CAS_EP, "Ratio points lumineux par armoire de commande", strate),
    tauxConnexionBase: getHyp(hypotheses, CAS_EP, "Taux d'armoires connectées (base 2025)", strate),
    croissanceConnexion: getHyp(hypotheses, CAS_EP, "Croissance annuelle du taux d'armoires connectées", strate),
    consoParPLMWh: consoNationaleMWh / parcNationalPL,
    prixElec: getHyp(hypotheses, CAS_EP, "Prix de l'électricité", "Toutes strates"),
    tauxEcoNumerique: getHyp(hypotheses, CAS_EP, "Économie d'énergie attribuable au numérique (hors effet LED)", "Toutes strates"),
    ecoDeplacementTech: getHyp(hypotheses, CAS_EP, "Économie déplacement technicien armoire", strate),
    ecoDeplacementCarb: getHyp(hypotheses, CAS_EP, "Économie déplacement (carburant technicien armoire)", strate),
    capexUnitaire: getHyp(hypotheses, CAS_EP, "CAPEX fourni-posé armoire communicante", strate),
    opexTransmission: getHyp(hypotheses, CAS_EP, "Transmission réseau (mix LoRa/cellulaire)", "Toutes strates"),
    opexServeurs: getHyp(hypotheses, CAS_EP, "Serveurs et hébergement", "Toutes strates"),
    opexLogiciels: getHyp(hypotheses, CAS_EP, "Logiciel SAAS / hypervision", strate),
    tauxEM: getHyp(hypotheses, CAS_EP, "Exploitation-maintenance (% du CAPEX cumulé installé)", strate),
    coutConduite: getHyp(hypotheses, CAS_EP, "Conduite du changement (1 ETP 50 000€ / 10 000 armoires, one shot)", strate),
    fabricationEnergie: getHyp(hypotheses, CAS_EP, "Énergie grise de fabrication", "Toutes strates"),
    fabricationCO2: getHyp(hypotheses, CAS_EP, "CO2 de fabrication", "Toutes strates"),
    installKm: getHyp(hypotheses, CAS_EP, "Déplacement d'installation", "Toutes strates"),
    usageEnergieAn: getHyp(hypotheses, CAS_EP, "Consommation armoire + plateforme", "Toutes strates"),
    mixElec: getHyp(hypotheses, CAS_EP, "Mix électrique français", "Toutes strates"),
    emissionVehicule: getHyp(hypotheses, CAS_EP, "Émission véhicule utilitaire léger", "Toutes strates"),
    kmMaintenanceEvites: getHyp(hypotheses, CAS_EP, "Kilomètres de maintenance évités par armoire connectée", "Toutes strates"),
    energieRecyclage: getHyp(hypotheses, CAS_EP, "Énergie de recyclage des armoires en fin de vie", "Toutes strates"),
    co2Recyclage: getHyp(hypotheses, CAS_EP, "CO2 de recyclage des armoires en fin de vie", "Toutes strates"),
  };
}

// À partir d'un parc d'armoires "année de référence" (2026) — le nombre de points
// lumineux est ré-estimé à partir du ratio PL/armoire pour garder des indicateurs marché
// cohérents, mais ne conditionne plus le calcul (contrairement au mode population).
function calculEPDepuisParc(params, parcArmoires2026, tauxFn) {
  const rows = [];
  let stockPrec = parcArmoires2026 * tauxFn(BASE_YEAR);
  const stockRef = stockPrec; // parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

  for (const year of YEARS) {
    const n = year - BASE_YEAR;
    const parcArmoires = parcArmoires2026 * Math.pow(1 + params.croissancePL, n);
    const parcPL = parcArmoires * params.ratioPLparArmoire;
    const tauxConnexion = tauxFn(year);
    const stock = parcArmoires * tauxConnexion;
    const nouveaux = Math.max(stock - stockPrec, 0);
    const stockAdd = Math.max(stock - stockRef, 0); // parc connecté AJOUTÉ depuis l'année de référence

    const capex = nouveaux * params.capexUnitaire;
    const opexTrans = stockAdd * params.opexTransmission;
    const opexServ = stock * params.opexServeurs;
    const opexLog = stockAdd * params.opexLogiciels;
    const em = stockAdd * params.capexUnitaire * params.tauxEM;
    const conduite = nouveaux * params.coutConduite;
    const depenses = capex + opexTrans + opexServ + opexLog + em + conduite;

    const consoGereeMWh = stock * params.ratioPLparArmoire * params.consoParPLMWh; // indicateur marché (parc connecté total)
    const consoGereeAddMWh = stockAdd * params.ratioPLparArmoire * params.consoParPLMWh; // base des bénéfices (parc ajouté)
    const beneficeEnergie = consoGereeAddMWh * params.tauxEcoNumerique * params.prixElec;
    const beneficeDeplacement = stockAdd * (params.ecoDeplacementTech + params.ecoDeplacementCarb);
    const externalites = beneficeEnergie + beneficeDeplacement;

    const energieEconomiseeKwh = consoGereeAddMWh * params.tauxEcoNumerique * 1000;
    // Émissions : fabrication + usage + pose + recyclage en fin de vie (Excel l.176)
    const impactEnergie = nouveaux * (params.fabricationEnergie + params.energieRecyclage) + stockAdd * params.usageEnergieAn;
    const impactCO2 = nouveaux * (params.fabricationCO2 + params.co2Recyclage) + (stockAdd * params.usageEnergieAn) * params.mixElec
      + nouveaux * params.installKm * params.emissionVehicule;
    // CO2 évité : énergie économisée (Excel l.171) + déplacements de maintenance évités (l.175)
    const beneficeCO2Physique = energieEconomiseeKwh * params.mixElec + stockAdd * params.kmMaintenanceEvites * params.emissionVehicule;

    rows.push({
      annee: year,
      parc_points_lumineux: parcPL,
      parc_total: parcArmoires,
      stock_connecte: stock,
      nouveaux: nouveaux,
      conso_totale_mwh: parcPL * params.consoParPLMWh,
      conso_geree_mwh: consoGereeMWh,
      energie_economisee_mwh: consoGereeAddMWh * params.tauxEcoNumerique,
      capex, opex_transmission: opexTrans, opex_serveurs: opexServ, opex_logiciels: opexLog,
      opex_exploitation_maintenance: em, opex_conduite_changement: conduite,
      depenses_totales: depenses,
      benefice_energie: beneficeEnergie, benefice_deplacement: beneficeDeplacement,
      externalites_totales: externalites,
      solde_annuel: externalites - depenses,
      impact_energie_kwh: impactEnergie,
      impact_co2_kg: impactCO2,
      benefice_energie_kwh: energieEconomiseeKwh,
      benefice_co2_kg: beneficeCO2Physique,
      bilan_net_energie_kwh: energieEconomiseeKwh - impactEnergie,
      bilan_net_co2_kg: beneficeCO2Physique - impactCO2,
    });
    stockPrec = stock;
  }

  return { cas_usage: CAS_EP, trajectoire: rows };
}

function calculEP(hypotheses, commune) {
  const strate = resolveStrate(commune);
  const params = getParametresEP(hypotheses, strate);
  const population = Number(commune.population);
  const parcArmoires2026 = (population / params.densiteHabParPL) / params.ratioPLparArmoire;
  const res = calculEPDepuisParc(params, parcArmoires2026, tauxCompoundingFn(params.tauxConnexionBase, params.croissanceConnexion));
  res.strate = strate;
  res.unite = "armoire(s) connectée(s)";
  return res;
}

function calculEPOverride(hypotheses, communes, overrides) {
  if (overrides.pct2036 == null) {
    throw new Error("Éclairage public : le % d'armoires connectées attendu en 2036 doit être renseigné dès que le nombre d'armoires est saisi.");
  }
  validerCoherenceObjets(overrides, "Éclairage public", "armoires");
  const perCommune = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresEP(hypotheses, strate);
    const poids = (Number(c.population) / params.densiteHabParPL) / params.ratioPLparArmoire; // parc défaut = poids
    return { params, poids };
  });
  const poidsTotal = perCommune.reduce((a, x) => a + x.poids, 0) || 1;
  const blended = {};
  for (const k of Object.keys(perCommune[0].params)) {
    blended[k] = perCommune.reduce((a, x) => a + x.params[k] * x.poids, 0) / poidsTotal;
  }

  const parc2026 = overrides.nombreObjets != null ? overrides.nombreObjets : poidsTotal;
  const taux2026 = overrides.nombreObjetsConnectes != null
    ? (parc2026 > 0 ? overrides.nombreObjetsConnectes / parc2026 : 0)
    : blended.tauxConnexionBase;

  const res = calculEPDepuisParc(blended, parc2026, tauxLinearFn(taux2026, overrides.pct2036));
  res.strate = communes.length === 1 ? resolveStrate(communes[0]) : `Multi-strates (moyenne pondérée sur ${communes.length} communes)`;
  res.unite = "armoire(s) connectée(s)";
  return res;
}

function calculEPCibleSeule(hypotheses, communes, pct2036) {
  const resultats = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresEP(hypotheses, strate);
    const parc2026 = (Number(c.population) / params.densiteHabParPL) / params.ratioPLparArmoire;
    return calculEPDepuisParc(params, parc2026, tauxLinearFn(params.tauxConnexionBase, pct2036));
  });
  return sommerTrajectoires(resultats, CAS_EP);
}

function calculEPAvecOptions(hypotheses, communes, overrides) {
  const ov = overrides || {};
  if (ov.pct2036 == null) {
    throw new Error("Éclairage public : le % d'armoires connectées attendu en 2036 est obligatoire pour ce cas d'usage.");
  }
  const objetsVides = ov.nombreObjets == null && ov.nombreObjetsConnectes == null;
  if (objetsVides) {
    return calculEPCibleSeule(hypotheses, communes, ov.pct2036);
  }
  return calculEPOverride(hypotheses, communes, ov);
}

// ---------- Énergie des bâtiments ----------
// Deux catégories de bâtiments publics (petits <500m², grands >500m²), chacune avec son
// propre parc (nombre moyen de bâtiments par commune, pas de ratio par habitant), son
// taux de connexion (IoT pour les petits, GTB pour les grands) et ses coûts propres.
// Simplification assumée : l'exploitation-maintenance des petits bâtiments est un flat
// (ETP mutualisé), celle des grands suit le même modèle %CAPEX que les autres cas d'usage.
// ---------- Énergie des bâtiments : petits (<500m²) ----------
// Les formules du modèle national sont entièrement séparables entre petits et grands
// bâtiments (aucun terme croisé) : on peut donc traiter chaque sous-type avec exactement
// le même schéma que les autres cas d'usage (paramètres / trajectoire / option de saisie),
// puis sommer les deux trajectoires pour obtenir le résultat combiné.
function getParametresEnergiePetit(hypotheses, strate) {
  return {
    croissanceParc: getHyp(hypotheses, CAS_ENERGIE, "Croissance du parc de bâtiments (surface)", "Toutes strates"),
    nbBase: getHyp(hypotheses, CAS_ENERGIE, "Nombre moyen de bâtiments publics < 500 m² par commune", strate),
    surface: getHyp(hypotheses, CAS_ENERGIE, "Surface moyenne d'un petit bâtiment (<500m²)", "Toutes strates"),
    tauxConnexionBase: getHyp(hypotheses, CAS_ENERGIE, "Taux de pénétration IoT (petits bâtiments, base 2025)", strate),
    croissanceConnexion: getHyp(hypotheses, CAS_ENERGIE, "Croissance annuelle du taux de pénétration IoT (petits)", "Toutes strates"),
    prix: getHyp(hypotheses, CAS_ENERGIE, "Dépense énergétique des petits bâtiments", "Toutes strates"),
    croissancePrix: getHyp(hypotheses, CAS_ENERGIE, "Croissance annuelle du prix de l'énergie", "Toutes strates"),
    ecoConso: getHyp(hypotheses, CAS_ENERGIE, "Économie via monitoring IoT (petits bâtiments)", "Toutes strates"),
    ecoDeplacement: getHyp(hypotheses, CAS_ENERGIE, "Économie déplacement technicien (petit bâtiment)", "Toutes strates"),
    capexUnitaire: getHyp(hypotheses, CAS_ENERGIE, "CAPEX fourni-posé (petit bâtiment, 5 équipements)", "Toutes strates"),
    opexTransmission: getHyp(hypotheses, CAS_ENERGIE, "Transmission réseau (petit et grand bâtiment)", "Toutes strates"),
    opexServeurs: getHyp(hypotheses, CAS_ENERGIE, "Serveurs et hébergement (petit bâtiment)", "Toutes strates"),
    opexLogiciels: getHyp(hypotheses, CAS_ENERGIE, "Plateforme EMS (petit bâtiment)", "Toutes strates"),
    emFlat: getHyp(hypotheses, CAS_ENERGIE, "Exploitation-maintenance (petit bâtiment, flat)", "Toutes strates"),
    coutConduite: getHyp(hypotheses, CAS_ENERGIE, "Conduite du changement (1 ETP 70 000€ / 100 bâtiments)", "Toutes strates"),
    fabricationCO2: getHyp(hypotheses, CAS_ENERGIE, "CO2 de fabrication (petit bâtiment)", "Toutes strates"),
    installKm: getHyp(hypotheses, CAS_ENERGIE, "Déplacement d'installation", "Toutes strates"),
    usageEnergieAn: getHyp(hypotheses, CAS_ENERGIE, "Consommation équipements (petit bâtiment)", "Toutes strates"),
    mixElec: getHyp(hypotheses, CAS_ENERGIE, "Mix électrique français (consommation équipements)", "Toutes strates"),
    facteurUsagesPilotes: getHyp(hypotheses, CAS_ENERGIE, "Facteur d'émission usages pilotés (énergie économisée)", "Toutes strates"),
    emissionVehicule: getHyp(hypotheses, CAS_ENERGIE, "Émission véhicule utilitaire léger", "Toutes strates"),
    intensiteEnergetique: getHyp(hypotheses, CAS_ENERGIE, "Intensité énergétique moyenne des bâtiments publics", "Toutes strates"),
    kmMaintenanceEvites: getHyp(hypotheses, CAS_ENERGIE, "Kilomètres de maintenance évités par bâtiment connecté", "Toutes strates"),
    energieRecyclage: getHyp(hypotheses, CAS_ENERGIE, "Énergie de recyclage (petit bâtiment)", "Toutes strates"),
    serveursEnergie: getHyp(hypotheses, CAS_ENERGIE, "Consommation des serveurs (hébergement SaaS)", "Toutes strates"),
  };
}

function calculEnergieSousTypeDepuisParc(params, parc2026, tauxFn) {
  const rows = [];
  let stockPrec = parc2026 * tauxFn(BASE_YEAR);
  const stockRef = stockPrec; // parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

  for (const year of YEARS) {
    const n = year - BASE_YEAR;
    const parc = parc2026 * Math.pow(1 + params.croissanceParc, n);
    const taux = tauxFn(year);
    const stock = parc * taux;
    const nouveaux = Math.max(stock - stockPrec, 0);
    const stockAdd = Math.max(stock - stockRef, 0); // parc connecté AJOUTÉ depuis l'année de référence

    const prixAn = params.prix * Math.pow(1 + params.croissancePrix, n);
    const depenseTotale = parc * params.surface * prixAn;

    const capex = nouveaux * params.capexUnitaire;
    const opexTrans = stockAdd * params.opexTransmission;
    const opexServ = stock * params.opexServeurs;
    const opexLog = stockAdd * params.opexLogiciels;
    // E&M : formule "flat" (petits) ou "%CAPEX" (grands) selon le sous-type — le paramètre
    // emFlat vaut 0 pour les grands, tauxEmCapex vaut 0 pour les petits (cf. constructeurs).
    const em = stockAdd * (params.emFlat || 0) + stockAdd * params.capexUnitaire * (params.tauxEmCapex || 0);
    const conduite = nouveaux * params.coutConduite;
    const depenses = capex + opexTrans + opexServ + opexLog + em + conduite;

    const beneficeEnergie = stockAdd * params.surface * prixAn * params.ecoConso;
    const beneficeDeplacement = stockAdd * params.ecoDeplacement;
    const externalites = beneficeEnergie + beneficeDeplacement;

    const kwhEconomise = stockAdd * params.surface * params.intensiteEnergetique * params.ecoConso;
    // Énergie : équipements (l.206) + serveurs SaaS (l.207) + recyclage (l.211) ; le CO2 en découle via le mix (impactEnergie × mix)
    const impactEnergie = stockAdd * (params.usageEnergieAn + params.serveursEnergie) + nouveaux * params.energieRecyclage;
    const impactCO2 = nouveaux * params.fabricationCO2 + impactEnergie * params.mixElec
      + nouveaux * params.installKm * params.emissionVehicule;
    // CO2 évité : énergie économisée (Excel l.208) + déplacements de maintenance évités (l.210)
    const beneficeCO2Physique = kwhEconomise * params.facteurUsagesPilotes + stockAdd * params.kmMaintenanceEvites * params.emissionVehicule;

    rows.push({
      annee: year,
      parc, stock_connecte: stock, nouveaux,
      depense_energie_totale: depenseTotale,
      capex, opex_transmission: opexTrans, opex_serveurs: opexServ, opex_logiciels: opexLog,
      opex_exploitation_maintenance: em, opex_conduite_changement: conduite,
      depenses_totales: depenses,
      benefice_energie: beneficeEnergie, benefice_deplacement: beneficeDeplacement,
      externalites_totales: externalites,
      impact_energie_kwh: impactEnergie, impact_co2_kg: impactCO2,
      benefice_energie_kwh: kwhEconomise, benefice_co2_kg: beneficeCO2Physique,
    });
    stockPrec = stock;
  }
  return rows;
}

function getParametresEnergieGrand(hypotheses, strate) {
  return {
    croissanceParc: getHyp(hypotheses, CAS_ENERGIE, "Croissance du parc de bâtiments (surface)", "Toutes strates"),
    nbBase: getHyp(hypotheses, CAS_ENERGIE, "Nombre moyen de bâtiments publics > 500 m² par commune", strate),
    surface: getHyp(hypotheses, CAS_ENERGIE, "Surface moyenne d'un grand bâtiment (>500m²)", "Toutes strates"),
    tauxConnexionBase: getHyp(hypotheses, CAS_ENERGIE, "Taux de pénétration GTB (grands bâtiments, base 2025)", strate),
    croissanceConnexion: getHyp(hypotheses, CAS_ENERGIE, "Croissance annuelle du taux de pénétration GTB (grands)", "Toutes strates"),
    prix: getHyp(hypotheses, CAS_ENERGIE, "Dépense énergétique des grands bâtiments", "Toutes strates"),
    croissancePrix: getHyp(hypotheses, CAS_ENERGIE, "Croissance annuelle du prix de l'énergie", "Toutes strates"),
    ecoConso: getHyp(hypotheses, CAS_ENERGIE, "Économie via GTB exploitée (grands bâtiments)", "Toutes strates"),
    ecoDeplacement: getHyp(hypotheses, CAS_ENERGIE, "Économie déplacement technicien (grand bâtiment)", "Toutes strates"),
    capexUnitaire: getHyp(hypotheses, CAS_ENERGIE, "CAPEX fourni-posé (grand bâtiment, GTB)", "Toutes strates"),
    opexTransmission: getHyp(hypotheses, CAS_ENERGIE, "Transmission réseau (petit et grand bâtiment)", "Toutes strates"),
    opexServeurs: getHyp(hypotheses, CAS_ENERGIE, "Serveurs et hébergement (grand bâtiment)", "Toutes strates"),
    opexLogiciels: getHyp(hypotheses, CAS_ENERGIE, "Plateforme EMS (grand bâtiment)", "Toutes strates"),
    tauxEmCapex: getHyp(hypotheses, CAS_ENERGIE, "Exploitation-maintenance (grand bâtiment, % du CAPEX cumulé)", strate),
    coutConduite: getHyp(hypotheses, CAS_ENERGIE, "Conduite du changement (1 ETP 70 000€ / 100 bâtiments)", "Toutes strates"),
    fabricationCO2: getHyp(hypotheses, CAS_ENERGIE, "CO2 de fabrication (grand bâtiment)", "Toutes strates"),
    installKm: getHyp(hypotheses, CAS_ENERGIE, "Déplacement d'installation", "Toutes strates"),
    usageEnergieAn: getHyp(hypotheses, CAS_ENERGIE, "Consommation équipements (grand bâtiment)", "Toutes strates"),
    mixElec: getHyp(hypotheses, CAS_ENERGIE, "Mix électrique français (consommation équipements)", "Toutes strates"),
    facteurUsagesPilotes: getHyp(hypotheses, CAS_ENERGIE, "Facteur d'émission usages pilotés (énergie économisée)", "Toutes strates"),
    emissionVehicule: getHyp(hypotheses, CAS_ENERGIE, "Émission véhicule utilitaire léger", "Toutes strates"),
    intensiteEnergetique: getHyp(hypotheses, CAS_ENERGIE, "Intensité énergétique moyenne des bâtiments publics", "Toutes strates"),
    kmMaintenanceEvites: getHyp(hypotheses, CAS_ENERGIE, "Kilomètres de maintenance évités par bâtiment connecté", "Toutes strates"),
    energieRecyclage: getHyp(hypotheses, CAS_ENERGIE, "Énergie de recyclage (grand bâtiment)", "Toutes strates"),
    serveursEnergie: getHyp(hypotheses, CAS_ENERGIE, "Consommation des serveurs (hébergement SaaS)", "Toutes strates"),
  };
}

// Calcule un sous-type (petit ou grand) pour un territoire, en mode auto (sommé par
// commune), mode "cible 2036 seule" (parc auto, taux linéaire vers la cible), ou saisie
// manuelle complète (paramètres pondérés + trajectoire ancrée sur la saisie).
function calculEnergieSousType(hypotheses, communes, getParams, overrides, sousTypeLabel) {
  const ov = overrides || {};
  if (ov.pct2036 == null) {
    throw new Error(`Énergie des bâtiments — ${sousTypeLabel} : le % de bâtiments connectés attendu en 2036 est obligatoire pour ce cas d'usage.`);
  }
  const objetsVides = ov.nombreObjets == null && ov.nombreObjetsConnectes == null;

  if (objetsVides) {
    // Cible 2036 seule : parc reste dérivé par commune (auto), taux linéaire partagé.
    const rows = communes.map((c) => {
      const params = getParams(hypotheses, resolveStrate(c));
      return calculEnergieSousTypeDepuisParc(params, params.nbBase, tauxLinearFn(params.tauxConnexionBase, ov.pct2036));
    });
    return YEARS.map((year, i) => {
      const merged = { annee: year };
      for (const k of Object.keys(rows[0][0])) {
        if (k === "annee") continue;
        merged[k] = rows.reduce((a, r) => a + r[i][k], 0);
      }
      return merged;
    });
  }

  if (ov.nombreObjets != null && ov.nombreObjetsConnectes != null && ov.nombreObjetsConnectes > ov.nombreObjets) {
    throw new Error(
      `Énergie des bâtiments — ${sousTypeLabel} : le nombre de bâtiments connectés (${ov.nombreObjetsConnectes}) ` +
      `ne peut pas dépasser le nombre total de bâtiments (${ov.nombreObjets}).`
    );
  }
  const perCommune = communes.map((c) => {
    const params = getParams(hypotheses, resolveStrate(c));
    return { params, poids: params.nbBase };
  });
  const poidsTotal = perCommune.reduce((a, x) => a + x.poids, 0) || 1;
  const blended = {};
  for (const k of Object.keys(perCommune[0].params)) {
    blended[k] = perCommune.reduce((a, x) => a + (x.params[k] || 0) * x.poids, 0) / poidsTotal;
  }
  const parc2026 = ov.nombreObjets != null ? ov.nombreObjets : poidsTotal;
  const taux2026 = ov.nombreObjetsConnectes != null
    ? (parc2026 > 0 ? ov.nombreObjetsConnectes / parc2026 : 0)
    : blended.tauxConnexionBase;
  return calculEnergieSousTypeDepuisParc(blended, parc2026, tauxLinearFn(taux2026, ov.pct2036));
}

function calculEnergieBatiments(hypotheses, commune) {
  const strate = resolveStrate(commune);
  const paramsPetit = getParametresEnergiePetit(hypotheses, strate);
  const paramsGrand = getParametresEnergieGrand(hypotheses, strate);
  const rowsPetit = calculEnergieSousTypeDepuisParc(paramsPetit, paramsPetit.nbBase, tauxCompoundingFn(paramsPetit.tauxConnexionBase, paramsPetit.croissanceConnexion));
  const rowsGrand = calculEnergieSousTypeDepuisParc(paramsGrand, paramsGrand.nbBase, tauxCompoundingFn(paramsGrand.tauxConnexionBase, paramsGrand.croissanceConnexion));
  const res = combinerEnergieBatiments(rowsPetit, rowsGrand);
  res.strate = strate;
  res.unite = "bâtiment(s) connecté(s)";
  return res;
}

function combinerEnergieBatiments(rowsPetit, rowsGrand) {
  const trajectoire = YEARS.map((year, i) => {
    const p = rowsPetit[i], g = rowsGrand[i];
    const depenses = p.depenses_totales + g.depenses_totales;
    const externalites = p.externalites_totales + g.externalites_totales;
    return {
      annee: year,
      parc_petits_batiments: p.parc,
      parc_grands_batiments: g.parc,
      parc_total: p.parc + g.parc,
      stock_petits_connectes: p.stock_connecte,
      stock_grands_connectes: g.stock_connecte,
      stock_connecte: p.stock_connecte + g.stock_connecte,
      nouveaux: p.nouveaux + g.nouveaux,
      depense_energie_totale: p.depense_energie_totale + g.depense_energie_totale,
      capex: p.capex + g.capex,
      opex_transmission: p.opex_transmission + g.opex_transmission,
      opex_serveurs: p.opex_serveurs + g.opex_serveurs,
      opex_logiciels: p.opex_logiciels + g.opex_logiciels,
      opex_exploitation_maintenance: p.opex_exploitation_maintenance + g.opex_exploitation_maintenance,
      opex_conduite_changement: p.opex_conduite_changement + g.opex_conduite_changement,
      depenses_totales: depenses,
      benefice_energie: p.benefice_energie + g.benefice_energie,
      benefice_deplacement: p.benefice_deplacement + g.benefice_deplacement,
      externalites_totales: externalites,
      solde_annuel: externalites - depenses,
      impact_energie_kwh: p.impact_energie_kwh + g.impact_energie_kwh,
      impact_co2_kg: p.impact_co2_kg + g.impact_co2_kg,
      benefice_energie_kwh: p.benefice_energie_kwh + g.benefice_energie_kwh,
      benefice_co2_kg: p.benefice_co2_kg + g.benefice_co2_kg,
      bilan_net_energie_kwh: (p.benefice_energie_kwh + g.benefice_energie_kwh) - (p.impact_energie_kwh + g.impact_energie_kwh),
      bilan_net_co2_kg: (p.benefice_co2_kg + g.benefice_co2_kg) - (p.impact_co2_kg + g.impact_co2_kg),
    };
  });
  return { cas_usage: CAS_ENERGIE, trajectoire };
}

// overrides = { petit: {nombreObjets, nombreObjetsConnectes, pct2036}, grand: {...} } —
// chaque sous-type peut indépendamment être en mode automatique ou saisie manuelle.
function calculEnergieBatimentsAvecOptions(hypotheses, communes, overrides) {
  const ov = overrides || {};
  const rowsPetit = calculEnergieSousType(hypotheses, communes, getParametresEnergiePetit, ov.petit, "bâtiments < 500 m²");
  const rowsGrand = calculEnergieSousType(hypotheses, communes, getParametresEnergieGrand, ov.grand, "bâtiments > 500 m²");
  const res = combinerEnergieBatiments(rowsPetit, rowsGrand);
  const soleSelected = communes.length === 1;
  const petitOverride = ov.petit && (ov.petit.nombreObjets != null || ov.petit.nombreObjetsConnectes != null);
  const grandOverride = ov.grand && (ov.grand.nombreObjets != null || ov.grand.nombreObjetsConnectes != null);
  res.strate = soleSelected && !petitOverride && !grandOverride
    ? resolveStrate(communes[0])
    : `Multi-strates (moyenne pondérée sur ${communes.length} commune${communes.length > 1 ? "s" : ""})`;
  res.unite = "bâtiment(s) connecté(s)";
  return res;
}


// ---------- Déchets - points d'apport volontaire (PAV) ----------
function getParametresPAV(hypotheses, strate) {
  return {
    partCS: getHyp(hypotheses, CAS_PAV, "Part de la population desservie en PAV — collecte séparée", "Toutes strates"),
    partVerre: getHyp(hypotheses, CAS_PAV, "Part de la population desservie en PAV — verre", "Toutes strates"),
    partOMR: getHyp(hypotheses, CAS_PAV, "Part de la population desservie en PAV — OMR", "Toutes strates"),
    habParPavCS: getHyp(hypotheses, CAS_PAV, "Habitants desservis par PAV — collecte séparée", "Toutes strates"),
    habParPavVerre: getHyp(hypotheses, CAS_PAV, "Habitants desservis par PAV — verre", "Toutes strates"),
    habParPavOMR: getHyp(hypotheses, CAS_PAV, "Habitants desservis par PAV — OMR", "Toutes strates"),
    croissanceParc: getHyp(hypotheses, CAS_PAV, "Croissance du parc de PAV", "Toutes strates"),
    tauxConnexionBase: getHyp(hypotheses, CAS_PAV, "Taux de PAV connectés (base 2025)", strate),
    croissanceConnexion: getHyp(hypotheses, CAS_PAV, "Croissance annuelle du taux de PAV connectés", "Toutes strates"),
    ecoEboueur: getHyp(hypotheses, CAS_PAV, "Économie déplacement éboueur (levées évitées)", strate),
    ecoTournee: getHyp(hypotheses, CAS_PAV, "Économie déplacement tournée (relevage optimisé)", strate),
    capexUnitaire: getHyp(hypotheses, CAS_PAV, "CAPEX sonde fournie-posée", strate),
    opexTransmission: getHyp(hypotheses, CAS_PAV, "Transmission réseau", strate),
    opexServeurs: getHyp(hypotheses, CAS_PAV, "Serveurs et hébergement", "Toutes strates"),
    opexLogiciels: getHyp(hypotheses, CAS_PAV, "Logiciel SAAS exploitation données", strate),
    tauxEM: getHyp(hypotheses, CAS_PAV, "Exploitation-maintenance (% du CAPEX cumulé)", strate),
    coutConduite: getHyp(hypotheses, CAS_PAV, "Conduite du changement (1 ETP 50 000€ / 10 000 sondes)", strate),
    fabricationEnergie: getHyp(hypotheses, CAS_PAV, "Énergie grise de fabrication", "Toutes strates"),
    fabricationCO2: getHyp(hypotheses, CAS_PAV, "CO2 de fabrication", "Toutes strates"),
    installKm: getHyp(hypotheses, CAS_PAV, "Déplacement d'installation", "Toutes strates"),
    usageEnergieAn: getHyp(hypotheses, CAS_PAV, "Consommation sonde + plateforme", "Toutes strates"),
    mixElec: getHyp(hypotheses, CAS_PAV, "Mix électrique français", "Toutes strates"),
    emissionVehicule: getHyp(hypotheses, CAS_PAV, "Émission véhicule utilitaire léger", "Toutes strates"),
    prixGazole: getHyp(hypotheses, CAS_PAV, "Prix du gazole (conversion économie de carburant → litres)", "Toutes strates"),
    facteurGazole: getHyp(hypotheses, CAS_PAV, "Facteur d'émission du gazole, amont inclus (Base Carbone)", "Toutes strates"),
    kmMaintenanceEvites: getHyp(hypotheses, CAS_PAV, "Kilomètres de maintenance évités par sonde connectée", "Toutes strates"),
    energieRecyclage: getHyp(hypotheses, CAS_PAV, "Énergie de recyclage des sondes en fin de vie", "Toutes strates"),
    co2Recyclage: getHyp(hypotheses, CAS_PAV, "CO2 de recyclage des sondes en fin de vie", "Toutes strates"),
  };
}
function parcBasePAV(params, population) {
  return population * (params.partCS / params.habParPavCS + params.partVerre / params.habParPavVerre + params.partOMR / params.habParPavOMR);
}

function calculDechetsPAVDepuisParc(params, parc2026, tauxFn) {
  const rows = [];
  let stockPrec = parc2026 * tauxFn(BASE_YEAR);
  const stockRef = stockPrec; // parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

  for (const year of YEARS) {
    const n = year - BASE_YEAR;
    const parcTotal = parc2026 * Math.pow(1 + params.croissanceParc, n);
    const tauxConnexion = tauxFn(year);
    const stock = parcTotal * tauxConnexion;
    const nouveaux = Math.max(stock - stockPrec, 0);
    const stockAdd = Math.max(stock - stockRef, 0); // parc connecté AJOUTÉ depuis l'année de référence

    const capex = nouveaux * params.capexUnitaire;
    const opexTrans = stockAdd * params.opexTransmission;
    const opexServ = stock * params.opexServeurs;
    const opexLog = stockAdd * params.opexLogiciels;
    const em = stockAdd * params.capexUnitaire * params.tauxEM;
    const conduite = nouveaux * params.coutConduite;
    const depenses = capex + opexTrans + opexServ + opexLog + em + conduite;

    const beneficeDeplacement = stockAdd * (params.ecoEboueur + params.ecoTournee);
    // CO2 évité (Excel V1.2, ligne 183) : économie de carburant des tournées ÷ prix du gazole × facteur d'émission
    const beneficeCO2Physique = stockAdd * params.ecoTournee / params.prixGazole * params.facteurGazole   // l.183 : tournées évitées
      + stockAdd * params.kmMaintenanceEvites * params.emissionVehicule;                                   // l.184 : maintenance évitée
    const externalites = beneficeDeplacement;

    // Émissions : fabrication + usage + pose + recyclage en fin de vie (Excel l.185)
    const impactEnergie = nouveaux * (params.fabricationEnergie + params.energieRecyclage) + stockAdd * params.usageEnergieAn;
    const impactCO2 = nouveaux * (params.fabricationCO2 + params.co2Recyclage) + (stockAdd * params.usageEnergieAn) * params.mixElec
      + nouveaux * params.installKm * params.emissionVehicule;

    rows.push({
      annee: year,
      parc_total: parcTotal,
      stock_connecte: stock,
      nouveaux,
      capex, opex_transmission: opexTrans, opex_serveurs: opexServ, opex_logiciels: opexLog,
      opex_exploitation_maintenance: em, opex_conduite_changement: conduite,
      depenses_totales: depenses,
      benefice_deplacement: beneficeDeplacement,
      externalites_totales: externalites,
      solde_annuel: externalites - depenses,
      impact_energie_kwh: impactEnergie,
      impact_co2_kg: impactCO2,
      benefice_energie_kwh: 0,
      benefice_co2_kg: beneficeCO2Physique,
      bilan_net_energie_kwh: -impactEnergie,
      bilan_net_co2_kg: beneficeCO2Physique - impactCO2,
    });
    stockPrec = stock;
  }

  return { cas_usage: CAS_PAV, trajectoire: rows };
}

function calculDechetsPAV(hypotheses, commune) {
  const strate = resolveStrate(commune);
  const params = getParametresPAV(hypotheses, strate);
  const parc2026 = parcBasePAV(params, Number(commune.population));
  const res = calculDechetsPAVDepuisParc(params, parc2026, tauxCompoundingFn(params.tauxConnexionBase, params.croissanceConnexion));
  res.strate = strate;
  res.unite = "point(s) d'apport volontaire connecté(s)";
  return res;
}

function calculDechetsPAVOverride(hypotheses, communes, overrides) {
  if (overrides.pct2036 == null) {
    throw new Error("Déchets PAV : le % de PAV connectés attendu en 2036 doit être renseigné dès que le nombre de PAV est saisi.");
  }
  validerCoherenceObjets(overrides, "Déchets PAV", "PAV");
  const perCommune = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresPAV(hypotheses, strate);
    return { params, poids: parcBasePAV(params, Number(c.population)) };
  });
  const poidsTotal = perCommune.reduce((a, x) => a + x.poids, 0) || 1;
  const blended = {};
  for (const k of Object.keys(perCommune[0].params)) {
    blended[k] = perCommune.reduce((a, x) => a + x.params[k] * x.poids, 0) / poidsTotal;
  }

  const parc2026 = overrides.nombreObjets != null ? overrides.nombreObjets : poidsTotal;
  const taux2026 = overrides.nombreObjetsConnectes != null
    ? (parc2026 > 0 ? overrides.nombreObjetsConnectes / parc2026 : 0)
    : blended.tauxConnexionBase;

  const res = calculDechetsPAVDepuisParc(blended, parc2026, tauxLinearFn(taux2026, overrides.pct2036));
  res.strate = communes.length === 1 ? resolveStrate(communes[0]) : `Multi-strates (moyenne pondérée sur ${communes.length} communes)`;
  res.unite = "point(s) d'apport volontaire connecté(s)";
  return res;
}

function calculDechetsPAVCibleSeule(hypotheses, communes, pct2036) {
  const resultats = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresPAV(hypotheses, strate);
    const parc2026 = parcBasePAV(params, Number(c.population));
    return calculDechetsPAVDepuisParc(params, parc2026, tauxLinearFn(params.tauxConnexionBase, pct2036));
  });
  return sommerTrajectoires(resultats, CAS_PAV);
}

function calculDechetsPAVAvecOptions(hypotheses, communes, overrides) {
  const ov = overrides || {};
  if (ov.pct2036 == null) {
    throw new Error("Déchets PAV : le % de PAV connectés attendu en 2036 est obligatoire pour ce cas d'usage.");
  }
  const objetsVides = ov.nombreObjets == null && ov.nombreObjetsConnectes == null;
  if (objetsVides) {
    return calculDechetsPAVCibleSeule(hypotheses, communes, ov.pct2036);
  }
  return calculDechetsPAVOverride(hypotheses, communes, ov);
}

// ---------- Déchets - bacs individuels (puce RFID / tarification incitative) ----------
function getParametresBacs(hypotheses, strate) {
  return {
    partCollectif: getHyp(hypotheses, CAS_BACS, "Part des ménages en habitat collectif", strate),
    menagesParBacCollectif: getHyp(hypotheses, CAS_BACS, "Mutualisation des bacs en habitat collectif", "Toutes strates"),
    nbFlux: getHyp(hypotheses, CAS_BACS, "Nombre de flux de déchets équipés de bacs", "Toutes strates"),
    croissanceParc: getHyp(hypotheses, CAS_BACS, "Croissance du parc de ménages", "Toutes strates"),
    tauxConnexionBase: getHyp(hypotheses, CAS_BACS, "Taux de bacs connectés / pucés (base 2025)", strate),
    croissanceConnexion: getHyp(hypotheses, CAS_BACS, "Croissance annuelle du taux de bacs connectés", "Toutes strates"),
    ecoTI: getHyp(hypotheses, CAS_BACS, "Économie nette de la tarification incitative (TI)", strate),
    ecoDeplacement: getHyp(hypotheses, CAS_BACS, "Économie déplacement (km évités, harmonisé avec PAV)", strate),
    // V1.2 : le gain kilométrique n'existe que si le schéma de collecte est refondu (≈50 % des collectivités).
    partRefonteSchema: getHyp(hypotheses, CAS_BACS, "Part des collectivités refondant leur schéma de collecte (gain km conditionné)", "Toutes strates"),
    capexUnitaire: getHyp(hypotheses, CAS_BACS, "CAPEX puce d'identification (RFID)", "Toutes strates"),
    opexTransmission: getHyp(hypotheses, CAS_BACS, "Transmission (RFID, sans coût réseau)", "Toutes strates"),
    opexServeurs: getHyp(hypotheses, CAS_BACS, "Serveurs et hébergement", "Toutes strates"),
    opexLogiciels: getHyp(hypotheses, CAS_BACS, "Logiciel SAAS exploitation données", "Toutes strates"),
    tauxEM: getHyp(hypotheses, CAS_BACS, "Exploitation-maintenance (% du CAPEX cumulé)", strate),
    coutConduite: getHyp(hypotheses, CAS_BACS, "Conduite du changement (1 ETP 50 000€ / 10 000 bacs)", "Toutes strates"),
    fabricationEnergie: getHyp(hypotheses, CAS_BACS, "Énergie grise de fabrication", "Toutes strates"),
    fabricationCO2: getHyp(hypotheses, CAS_BACS, "CO2 de fabrication", "Toutes strates"),
    prixGazole: getHyp(hypotheses, CAS_BACS, "Prix du gazole (conversion économie de carburant → litres)", "Toutes strates"),
    facteurGazole: getHyp(hypotheses, CAS_BACS, "Facteur d'émission du gazole, amont inclus (Base Carbone)", "Toutes strates"),
    bacsParMenage: getHyp(hypotheses, CAS_BACS, "Nombre de bacs pucés par ménage (conversion bacs → ménages)", "Toutes strates"),
    habitantsParMenage: getHyp(hypotheses, CAS_BACS, "Habitants par ménage", "Toutes strates"),
    omrParHabitant: getHyp(hypotheses, CAS_BACS, "Production d'OMR par habitant", "Toutes strates"),
    reductionOmrTI: getHyp(hypotheses, CAS_BACS, "Réduction des tonnages d'OMR par la tarification incitative", "Toutes strates"),
    co2EviteParTonneOmr: getHyp(hypotheses, CAS_BACS, "CO2 évité par tonne d'OMR détournée (Base Carbone)", "Toutes strates"),
    kmPose: getHyp(hypotheses, CAS_BACS, "Déplacement de pose des puces", "Toutes strates"),
    serveursEnergie: getHyp(hypotheses, CAS_BACS, "Consommation des serveurs (gestion TI)", "Toutes strates"),
    energieRecyclage: getHyp(hypotheses, CAS_BACS, "Énergie de recyclage des puces en fin de vie", "Toutes strates"),
    co2Recyclage: getHyp(hypotheses, CAS_BACS, "CO2 de recyclage des puces en fin de vie", "Toutes strates"),
    mixElec: getHyp(hypotheses, CAS_BACS, "Mix électrique français", "Toutes strates"),
    emissionVehicule: getHyp(hypotheses, CAS_BACS, "Émission véhicule utilitaire léger", "Toutes strates"),
  };
}
function parcBaseBacs(params, menages) {
  const partIndividuel = 1 - params.partCollectif;
  const bacsParMenage = (params.partCollectif / params.menagesParBacCollectif + partIndividuel * 1) * params.nbFlux;
  return menages * bacsParMenage;
}

function calculDechetsBacsDepuisParc(params, parc2026, tauxFn) {
  const rows = [];
  let stockPrec = parc2026 * tauxFn(BASE_YEAR);
  const stockRef = stockPrec; // parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

  for (const year of YEARS) {
    const n = year - BASE_YEAR;
    const parcTotal = parc2026 * Math.pow(1 + params.croissanceParc, n);
    const tauxConnexion = tauxFn(year);
    const stock = parcTotal * tauxConnexion;
    const nouveaux = Math.max(stock - stockPrec, 0);
    const stockAdd = Math.max(stock - stockRef, 0); // parc connecté AJOUTÉ depuis l'année de référence

    const capex = nouveaux * params.capexUnitaire;
    const opexTrans = stockAdd * params.opexTransmission;
    const opexServ = stock * params.opexServeurs;
    const opexLog = stockAdd * params.opexLogiciels;
    const em = stockAdd * params.capexUnitaire * params.tauxEM;
    const conduite = nouveaux * params.coutConduite;
    const depenses = capex + opexTrans + opexServ + opexLog + em + conduite;

    const beneficeTI = stockAdd * params.ecoTI;
    const beneficeDeplacement = stockAdd * params.ecoDeplacement * params.partRefonteSchema;
    // CO2 évité (Excel V1.2, ligne 188) : économie de carburant (km de collecte évités) ÷ prix du gazole × facteur d'émission
    const beneficeCO2Physique = beneficeDeplacement / params.prixGazole * params.facteurGazole   // l.188 : km de collecte évités
      + (stockAdd / params.bacsParMenage) * params.habitantsParMenage * params.omrParHabitant
        * params.reductionOmrTI * params.co2EviteParTonneOmr * 1000;                           // l.187 : tonnages d'OMR évités (tCO2e → kg)
    const externalites = beneficeTI + beneficeDeplacement;

    // Émissions : fabrication (l.183) + pose des puces (l.184) + serveurs de gestion TI (l.186) + recyclage (l.189)
    const impactEnergie = nouveaux * (params.fabricationEnergie + params.energieRecyclage) + stockAdd * params.serveursEnergie;
    const impactCO2 = nouveaux * (params.fabricationCO2 + params.co2Recyclage + params.kmPose * params.emissionVehicule)
      + stockAdd * params.serveursEnergie * params.mixElec;

    rows.push({
      annee: year,
      parc_total: parcTotal,
      stock_connecte: stock,
      nouveaux,
      capex, opex_transmission: opexTrans, opex_serveurs: opexServ, opex_logiciels: opexLog,
      opex_exploitation_maintenance: em, opex_conduite_changement: conduite,
      depenses_totales: depenses,
      benefice_ti: beneficeTI,
      benefice_deplacement: beneficeDeplacement,
      externalites_totales: externalites,
      solde_annuel: externalites - depenses,
      impact_energie_kwh: impactEnergie,
      impact_co2_kg: impactCO2,
      benefice_energie_kwh: 0,
      benefice_co2_kg: beneficeCO2Physique,
      bilan_net_energie_kwh: -impactEnergie,
      bilan_net_co2_kg: beneficeCO2Physique - impactCO2,
    });
    stockPrec = stock;
  }

  return { cas_usage: CAS_BACS, trajectoire: rows };
}

function calculDechetsBacs(hypotheses, commune) {
  const strate = resolveStrate(commune);
  const params = getParametresBacs(hypotheses, strate);
  const parc2026 = parcBaseBacs(params, getBaseMenages(commune));
  const res = calculDechetsBacsDepuisParc(params, parc2026, tauxCompoundingFn(params.tauxConnexionBase, params.croissanceConnexion));
  res.strate = strate;
  res.unite = "bac(s) connecté(s)";
  return res;
}

function calculDechetsBacsOverride(hypotheses, communes, overrides) {
  if (overrides.pct2036 == null) {
    throw new Error("Déchets bacs individuels : le % de bacs connectés attendu en 2036 doit être renseigné dès que le nombre de bacs est saisi.");
  }
  validerCoherenceObjets(overrides, "Déchets bacs individuels", "bacs");
  const perCommune = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresBacs(hypotheses, strate);
    return { params, poids: parcBaseBacs(params, getBaseMenages(c)) };
  });
  const poidsTotal = perCommune.reduce((a, x) => a + x.poids, 0) || 1;
  const blended = {};
  for (const k of Object.keys(perCommune[0].params)) {
    blended[k] = perCommune.reduce((a, x) => a + x.params[k] * x.poids, 0) / poidsTotal;
  }

  const parc2026 = overrides.nombreObjets != null ? overrides.nombreObjets : poidsTotal;
  const taux2026 = overrides.nombreObjetsConnectes != null
    ? (parc2026 > 0 ? overrides.nombreObjetsConnectes / parc2026 : 0)
    : blended.tauxConnexionBase;

  const res = calculDechetsBacsDepuisParc(blended, parc2026, tauxLinearFn(taux2026, overrides.pct2036));
  res.strate = communes.length === 1 ? resolveStrate(communes[0]) : `Multi-strates (moyenne pondérée sur ${communes.length} communes)`;
  res.unite = "bac(s) connecté(s)";
  return res;
}

function calculDechetsBacsCibleSeule(hypotheses, communes, pct2036) {
  const resultats = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresBacs(hypotheses, strate);
    const parc2026 = parcBaseBacs(params, getBaseMenages(c));
    return calculDechetsBacsDepuisParc(params, parc2026, tauxLinearFn(params.tauxConnexionBase, pct2036));
  });
  return sommerTrajectoires(resultats, CAS_BACS);
}

function calculDechetsBacsAvecOptions(hypotheses, communes, overrides) {
  const ov = overrides || {};
  if (ov.pct2036 == null) {
    throw new Error("Déchets bacs individuels : le % de bacs connectés attendu en 2036 est obligatoire pour ce cas d'usage.");
  }
  const objetsVides = ov.nombreObjets == null && ov.nombreObjetsConnectes == null;
  if (objetsVides) {
    return calculDechetsBacsCibleSeule(hypotheses, communes, ov.pct2036);
  }
  return calculDechetsBacsOverride(hypotheses, communes, ov);
}

// ---------- Arrosage connecté ----------
// Assiette : surface d'espaces verts arrosés (population × m²/hab × part arrosée),
// convertie en vannes via une densité vannes/hectare. Le volume d'eau géré est
// proratisé au taux de connexion des vannes (stock connecté / parc total = part
// du volume pilotée numériquement).
function getParametresArrosage(hypotheses, strate) {
  return {
    m2ParHab: getHyp(hypotheses, CAS_ARROSAGE, "Surface d'espaces verts par habitant", strate),
    partArrosee: getHyp(hypotheses, CAS_ARROSAGE, "Part des espaces verts arrosés", strate),
    vannesParHa: getHyp(hypotheses, CAS_ARROSAGE, "Nombre de vannes d'arrosage par hectare arrosé", strate),
    volumeParM2: getHyp(hypotheses, CAS_ARROSAGE, "Volume d'eau d'arrosage par m² d'espace vert arrosé", strate),
    croissanceParc: getHyp(hypotheses, CAS_ARROSAGE, "Croissance du nombre de vannes par hectare", strate),
    tauxConnexionBase: getHyp(hypotheses, CAS_ARROSAGE, "Taux de vannes connectées (base 2025)", strate),
    croissanceConnexion: getHyp(hypotheses, CAS_ARROSAGE, "Croissance annuelle du taux de vannes connectées", strate),
    ecoEauNumerique: getHyp(hypotheses, CAS_ARROSAGE, "Économie d'eau attribuable au numérique", "Toutes strates"),
    valorisationEau: getHyp(hypotheses, CAS_ARROSAGE, "Valorisation de l'eau économisée", "Toutes strates"),
    ecoJardinier: getHyp(hypotheses, CAS_ARROSAGE, "Économie déplacement jardinier (temps technicien)", strate),
    ecoCarburant: getHyp(hypotheses, CAS_ARROSAGE, "Économie déplacement (carburant)", strate),
    capexUnitaire: getHyp(hypotheses, CAS_ARROSAGE, "CAPEX vanne connectée fournie-posée", strate),
    opexTransmission: getHyp(hypotheses, CAS_ARROSAGE, "Transmission réseau", strate),
    opexServeurs: getHyp(hypotheses, CAS_ARROSAGE, "Serveurs et hébergement", "Toutes strates"),
    opexLogiciels: getHyp(hypotheses, CAS_ARROSAGE, "Logiciel SAAS exploitation données", strate),
    tauxEM: getHyp(hypotheses, CAS_ARROSAGE, "Exploitation-maintenance (% du CAPEX cumulé)", strate),
    coutConduite: getHyp(hypotheses, CAS_ARROSAGE, "Conduite du changement (1 ETP 50 000€ / 10 000 vannes)", strate),
    fabricationEnergie: getHyp(hypotheses, CAS_ARROSAGE, "Énergie grise de fabrication", "Toutes strates"),
    fabricationCO2: getHyp(hypotheses, CAS_ARROSAGE, "CO2 de fabrication", "Toutes strates"),
    installKm: getHyp(hypotheses, CAS_ARROSAGE, "Déplacement d'installation", "Toutes strates"),
    usageEnergieAn: getHyp(hypotheses, CAS_ARROSAGE, "Consommation vanne + plateforme", "Toutes strates"),
    mixElec: getHyp(hypotheses, CAS_ARROSAGE, "Mix électrique français", "Toutes strates"),
    emissionVehicule: getHyp(hypotheses, CAS_ARROSAGE, "Émission véhicule utilitaire léger", "Toutes strates"),
    energiePompageEvitee: getHyp(hypotheses, CAS_ARROSAGE, "Énergie de pompage/traitement évitée par eau non prélevée", "Toutes strates"),
    co2EviteTraitementEau: getHyp(hypotheses, CAS_ARROSAGE, "CO2 évité par traitement d'eau non prélevée", "Toutes strates"),
    coutJourneeJardinier: getHyp(hypotheses, CAS_ARROSAGE, "Coût d'une journée de jardinier", "Toutes strates"),
    kmJourneeJardinier: getHyp(hypotheses, CAS_ARROSAGE, "Distance parcourue par journée de jardinier évitée", "Toutes strates"),
    sondesParHa: getHyp(hypotheses, CAS_ARROSAGE, "Densité de sondes d'humidité par hectare arrosé", strate),
    croissanceSurfaces: getHyp(hypotheses, CAS_ARROSAGE, "Croissance annuelle des surfaces arrosées", strate),
    energieRecyclage: getHyp(hypotheses, CAS_ARROSAGE, "Énergie de recyclage des vannes et sondes en fin de vie", "Toutes strates"),
    co2Recyclage: getHyp(hypotheses, CAS_ARROSAGE, "CO2 de recyclage des vannes et sondes en fin de vie", "Toutes strates"),
  };
}
// Surface et volume d'arrosage : des grandeurs EXTENSIVES (dérivées de la population),
// à sommer entre communes — pas à moyenner comme les autres paramètres (coûts, taux).
function surfaceEtVolumeArrosage(params, population) {
  const surfaceArroseeM2 = population * params.m2ParHab * params.partArrosee;
  return { surfaceArroseeM2, volumeTotalM3: surfaceArroseeM2 * params.volumeParM2 };
}
function parcVannesBaseArrosage(params, population) {
  const { surfaceArroseeM2 } = surfaceEtVolumeArrosage(params, population);
  return (surfaceArroseeM2 / 10000) * params.vannesParHa;
}

// volumeTotalM3/surfaceArroseeM2 sont fournis à part (grandeurs extensives sommées sur le
// territoire, indépendantes du parc de vannes lui-même — voir remarque ci-dessus).
function calculArrosageDepuisParc(params, parc2026, tauxFn, surfaceArroseeM2, volumeTotalM3) {
  const rows = [];
  let stockPrec = parc2026 * tauxFn(BASE_YEAR);
  // Sondes d'humidité (Excel l.32-36) : comptées comme objets connectés dans l'inventaire environnemental ; leur parc suit la surface arrosée
  const sondes0 = (surfaceArroseeM2 / 10000) * params.sondesParHa;
  let sondesPrec = sondes0;
  const stockRef = stockPrec; // parc connecté à l'année de référence : seul le parc AJOUTÉ depuis génère coûts récurrents et bénéfices (additionnalité, Excel V1.2)

  for (const year of YEARS) {
    const n = year - BASE_YEAR;
    const parcVannes = parc2026 * Math.pow(1 + params.croissanceParc, n);
    const tauxConnexion = tauxFn(year);
    const stock = parcVannes * tauxConnexion;
    const nouveaux = Math.max(stock - stockPrec, 0);
    const stockAdd = Math.max(stock - stockRef, 0); // parc connecté AJOUTÉ depuis l'année de référence
    const sondes = sondes0 * Math.pow(1 + params.croissanceSurfaces, n);
    const nouveauxObj = nouveaux + Math.max(sondes - sondesPrec, 0);   // vannes + sondes nouvelles
    const stockAddObj = stockAdd + Math.max(sondes - sondes0, 0);      // vannes + sondes ajoutées depuis la référence

    const capex = nouveaux * params.capexUnitaire;
    const opexTrans = stockAdd * params.opexTransmission;
    const opexServ = stock * params.opexServeurs;
    const opexLog = stockAdd * params.opexLogiciels;
    const em = stockAdd * params.capexUnitaire * params.tauxEM;
    const conduite = nouveaux * params.coutConduite;
    const depenses = capex + opexTrans + opexServ + opexLog + em + conduite;

    const volumeGere = volumeTotalM3 * tauxConnexion; // indicateur marché (volume sous vannes connectées, total)
    const volumeGereAdd = parcVannes > 0 ? volumeTotalM3 * stockAdd / parcVannes : 0; // base des bénéfices (parc ajouté)
    // Économie d'eau : montée en charge 1 − (1 − d)^(année − 2024) (Excel l.39-42, exposant COLUMNS($G:col)) — 40 % à terme
    const montee = 1 - Math.pow(1 - params.ecoEauNumerique, year - ANNEE_BASE_EXCEL + 1);
    const beneficeEau = volumeGereAdd * montee * params.valorisationEau;
    const beneficeDeplacement = stockAdd * (params.ecoJardinier + params.ecoCarburant);
    const externalites = beneficeEau + beneficeDeplacement;

    const volumeEconomiseM3 = volumeGereAdd * montee;
    // Émissions sur vannes + sondes : fabrication (l.182) + pose (l.183) + usage (l.184-185) + recyclage (l.191)
    const impactEnergie = nouveauxObj * (params.fabricationEnergie + params.energieRecyclage) + stockAddObj * params.usageEnergieAn;
    const impactCO2 = nouveauxObj * (params.fabricationCO2 + params.co2Recyclage) + (stockAddObj * params.usageEnergieAn) * params.mixElec
      + nouveauxObj * params.installKm * params.emissionVehicule;
    const beneficeEnergiePhysique = volumeEconomiseM3 * params.energiePompageEvitee;
    // CO2 évité : pompage + traitement de l'eau non prélevée (Excel l.187 : énergie × mix + 0,06 kg/m³) + déplacements de jardiniers évités (l.190)
    const beneficeCO2Physique = volumeEconomiseM3 * (params.energiePompageEvitee * params.mixElec + params.co2EviteTraitementEau)
      + stockAdd * params.ecoJardinier / params.coutJourneeJardinier * params.kmJourneeJardinier * params.emissionVehicule;

    rows.push({
      annee: year,
      surface_arrosee_m2: surfaceArroseeM2,
      volume_eau_total_m3: volumeTotalM3,
      volume_eau_gere_m3: volumeGere,
      volume_eau_economise_m3: volumeEconomiseM3,
      parc_total: parcVannes,
      stock_connecte: stock,
      nouveaux,
      capex, opex_transmission: opexTrans, opex_serveurs: opexServ, opex_logiciels: opexLog,
      opex_exploitation_maintenance: em, opex_conduite_changement: conduite,
      depenses_totales: depenses,
      benefice_eau: beneficeEau,
      benefice_deplacement: beneficeDeplacement,
      externalites_totales: externalites,
      solde_annuel: externalites - depenses,
      impact_energie_kwh: impactEnergie,
      impact_co2_kg: impactCO2,
      benefice_energie_kwh: beneficeEnergiePhysique,
      benefice_co2_kg: beneficeCO2Physique,
      bilan_net_energie_kwh: beneficeEnergiePhysique - impactEnergie,
      bilan_net_co2_kg: beneficeCO2Physique - impactCO2,
      bilan_net_eau_m3: volumeEconomiseM3,
    });
    stockPrec = stock;
    sondesPrec = sondes;
  }

  return { cas_usage: CAS_ARROSAGE, trajectoire: rows };
}

function calculArrosage(hypotheses, commune) {
  const strate = resolveStrate(commune);
  const params = getParametresArrosage(hypotheses, strate);
  const population = Number(commune.population);
  const { surfaceArroseeM2, volumeTotalM3 } = surfaceEtVolumeArrosage(params, population);
  const parc2026 = parcVannesBaseArrosage(params, population);
  const res = calculArrosageDepuisParc(
    params, parc2026, tauxCompoundingFn(params.tauxConnexionBase, params.croissanceConnexion),
    surfaceArroseeM2, volumeTotalM3
  );
  res.strate = strate;
  res.unite = "vanne(s) connectée(s)";
  return res;
}

function calculArrosageOverride(hypotheses, communes, overrides) {
  if (overrides.pct2036 == null) {
    throw new Error("Arrosage connecté : le % de vannes connectées attendu en 2036 doit être renseigné dès que le nombre de vannes est saisi.");
  }
  validerCoherenceObjets(overrides, "Arrosage connecté", "vannes");
  const perCommune = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresArrosage(hypotheses, strate);
    const population = Number(c.population);
    return { params, poids: parcVannesBaseArrosage(params, population), ...surfaceEtVolumeArrosage(params, population) };
  });
  const poidsTotal = perCommune.reduce((a, x) => a + x.poids, 0) || 1;
  const blended = {};
  const clesExtensives = new Set(["m2ParHab", "partArrosee", "volumeParM2"]); // exclues du blend pondéré
  for (const k of Object.keys(perCommune[0].params)) {
    if (clesExtensives.has(k)) continue;
    blended[k] = perCommune.reduce((a, x) => a + x.params[k] * x.poids, 0) / poidsTotal;
  }
  // Surface et volume : sommés (grandeurs extensives), pas moyennés.
  const surfaceArroseeM2 = perCommune.reduce((a, x) => a + x.surfaceArroseeM2, 0);
  const volumeTotalM3 = perCommune.reduce((a, x) => a + x.volumeTotalM3, 0);

  const parc2026 = overrides.nombreObjets != null ? overrides.nombreObjets : poidsTotal;
  const taux2026 = overrides.nombreObjetsConnectes != null
    ? (parc2026 > 0 ? overrides.nombreObjetsConnectes / parc2026 : 0)
    : blended.tauxConnexionBase;

  const res = calculArrosageDepuisParc(
    blended, parc2026, tauxLinearFn(taux2026, overrides.pct2036), surfaceArroseeM2, volumeTotalM3
  );
  res.strate = communes.length === 1 ? resolveStrate(communes[0]) : `Multi-strates (moyenne pondérée sur ${communes.length} communes)`;
  res.unite = "vanne(s) connectée(s)";
  return res;
}

function calculArrosageCibleSeule(hypotheses, communes, pct2036) {
  const resultats = communes.map((c) => {
    const strate = resolveStrate(c);
    const params = getParametresArrosage(hypotheses, strate);
    const population = Number(c.population);
    const { surfaceArroseeM2, volumeTotalM3 } = surfaceEtVolumeArrosage(params, population);
    const parc2026 = parcVannesBaseArrosage(params, population);
    return calculArrosageDepuisParc(params, parc2026, tauxLinearFn(params.tauxConnexionBase, pct2036), surfaceArroseeM2, volumeTotalM3);
  });
  return sommerTrajectoires(resultats, CAS_ARROSAGE);
}

function calculArrosageAvecOptions(hypotheses, communes, overrides) {
  const ov = overrides || {};
  if (ov.pct2036 == null) {
    throw new Error("Arrosage connecté : le % de vannes connectées attendu en 2036 est obligatoire pour ce cas d'usage.");
  }
  const objetsVides = ov.nombreObjets == null && ov.nombreObjetsConnectes == null;
  if (objetsVides) {
    return calculArrosageCibleSeule(hypotheses, communes, ov.pct2036);
  }
  return calculArrosageOverride(hypotheses, communes, ov);
}

function sommeColonne(trajectoire, colonne) {
  return trajectoire.reduce((acc, r) => acc + r[colonne], 0);
}

// ---------- Agrégation multi-communes (EPCI) ----------
// Chaque commune conserve sa propre strate et donc ses propres hypothèses unitaires ;
// on calcule commune par commune puis on somme les trajectoires, année par année.
// C'est plus fidèle qu'une strate "moyenne" arbitraire pour un EPCI qui mélange
// rural/intermédiaire/urbain (cas fréquent, cf. CA Roannais Agglomération : 3 strates).
function sommerTrajectoires(resultats, casUsage) {
  const n = YEARS.length;
  const cles = Object.keys(resultats[0].trajectoire[0]).filter((k) => k !== "annee");
  const traj = [];
  for (let i = 0; i < n; i++) {
    const row = { annee: YEARS[i] };
    cles.forEach((k) => {
      row[k] = resultats.reduce((acc, r) => acc + (r.trajectoire[i][k] || 0), 0);
    });
    traj.push(row);
  }
  return { cas_usage: casUsage, trajectoire: traj };
}

function calculEauTerritoire(hypotheses, communes) {
  return sommerTrajectoires(communes.map((c) => calculEau(hypotheses, c)), CAS_EAU);
}
function calculEPTerritoire(hypotheses, communes) {
  return sommerTrajectoires(communes.map((c) => calculEP(hypotheses, c)), CAS_EP);
}
function calculEnergieBatimentsTerritoire(hypotheses, communes) {
  return sommerTrajectoires(communes.map((c) => calculEnergieBatiments(hypotheses, c)), CAS_ENERGIE);
}
function calculDechetsPAVTerritoire(hypotheses, communes) {
  return sommerTrajectoires(communes.map((c) => calculDechetsPAV(hypotheses, c)), CAS_PAV);
}
function calculDechetsBacsTerritoire(hypotheses, communes) {
  return sommerTrajectoires(communes.map((c) => calculDechetsBacs(hypotheses, c)), CAS_BACS);
}
function calculArrosageTerritoire(hypotheses, communes) {
  return sommerTrajectoires(communes.map((c) => calculArrosage(hypotheses, c)), CAS_ARROSAGE);
}

// Registre des 6 cas d'usage disponibles — point d'entrée unique pour l'UI (évite de
// coder en dur "eau"/"ep" partout : ajouter un cas d'usage se fait ici uniquement).
const CAS_USAGE_REGISTRY = [
  { id: "eau", label: CAS_EAU, calcTerritoire: calculEauTerritoire },
  { id: "ep", label: CAS_EP, calcTerritoire: calculEPTerritoire },
  { id: "energie", label: CAS_ENERGIE, calcTerritoire: calculEnergieBatimentsTerritoire },
  { id: "pav", label: CAS_PAV, calcTerritoire: calculDechetsPAVTerritoire },
  { id: "bacs", label: CAS_BACS, calcTerritoire: calculDechetsBacsTerritoire },
  { id: "arrosage", label: CAS_ARROSAGE, calcTerritoire: calculArrosageTerritoire },
];

// Mutualisation généralisée à N cas d'usage (2 à 6) : l'abattement de chaque poste
// mutualisable s'applique à la somme de ce poste sur TOUS les cas d'usage activés —
// la mécanique du panneau PILOTAGE se généralise naturellement au-delà d'une paire.
function calculMutualisation(resultats, curseurM = 1.0) {
  const abattements = getAbattementsMutualisation(resultats);
  const rows = [];
  for (let i = 0; i < YEARS.length; i++) {
    let economieAnnuelle = 0;
    const detail = {};
    for (const [poste, abattement] of Object.entries(abattements)) {
      const coutPoste = resultats.reduce((acc, r) => acc + (r.trajectoire[i][poste] || 0), 0);
      const eco = curseurM * abattement * coutPoste;
      detail[poste] = eco;
      economieAnnuelle += eco;
    }
    rows.push({ annee: YEARS[i], economie_mutualisation: economieAnnuelle, detail });
  }
  const economieTotale = sommeColonne(rows, "economie_mutualisation");
  const depensesSilo = resultats.reduce((acc, r) => acc + sommeColonne(r.trajectoire, "depenses_totales"), 0);
  const externalites = resultats.reduce((acc, r) => acc + sommeColonne(r.trajectoire, "externalites_totales"), 0);
  const depensesMutualise = depensesSilo - economieTotale;
  // Détail par cas d'usage : les abattements sont des taux appliqués poste par poste, la part de chaque cas d'usage est donc
  // exacte (sa propre dépense de chaque poste × l'abattement du poste) et la somme des cas redonne les totaux ci-dessus.
  const parCas = resultats.map((r) => {
    const depenses = sommeColonne(r.trajectoire, "depenses_totales");
    const externalitesCas = sommeColonne(r.trajectoire, "externalites_totales");
    let economie = 0;
    for (const [poste, abattement] of Object.entries(abattements)) {
      economie += curseurM * abattement * r.trajectoire.reduce((acc, row) => acc + (row[poste] || 0), 0);
    }
    return {
      depensesSilo: depenses,
      depensesMutualise: depenses - economie,
      economie,
      externalites: externalitesCas,
      soldeSilo: externalitesCas - depenses,
      soldeMutualise: externalitesCas - (depenses - economie),
    };
  });
  return {
    trajectoire: rows,
    parCas,
    economieTotale,
    depensesSilo,
    depensesMutualise,
    externalites,
    soldeSilo: externalites - depensesSilo,
    soldeMutualise: externalites - depensesMutualise,
  };
}

// ---------------------------------------------------------------------------
// Surveillance inondation (Excel V1.2, onglet « Prévention Inondation »)
// ---------------------------------------------------------------------------
// Logique propre à ce cas d'usage : pas de parc d'objets connectés saisi par l'utilisateur,
// mais un système de surveillance (« territoire GEMAPI équivalent » : ≈ 40 points de mesure,
// plateforme de prévision et d'alerte) déployé UNE fois sur le territoire choisi, à une date
// indiquée par l'utilisateur.
//   1) dommages annuels du territoire selon son profil de vigilance (1, 2 ou 3) :
//      Σ_niveau  (population du territoire au niveau ÷ population de référence) × dommages nationaux du niveau
//      avec dommages nationaux du niveau = 1 Md€ (2025) × part du niveau × (1 + 2,5 %)^(année − 2025) ;
//   2) dommages évités = dommages du territoire × part adressable par une surveillance locale (50 %) × taux d'évitement
//      net (10 %), soit 5 % des dommages comme dans l'Excel, à partir de l'année de déploiement ;
//   3) coût d'UN système (CAPEX, transmission, serveurs, logiciels, E&M, conduite du changement) ;
//   4) bilan net économique et bilan net environnemental (fabrication, pose, usage, fin de vie).
// Les flux courent de l'année de déploiement à 2036 (comme l'Excel : CAPEX et conduite du changement
// l'année du déploiement, coûts récurrents et gains dès cette année). Un déploiement en 2026, antérieur
// à l'horizon d'analyse (2027-2036), est rattaché à la première année de l'horizon.
const CAS_INONDATION = "Surveillance inondation";
const ANNEE_DEPLOIEMENT_MIN = 2026;
const ANNEE_DEPLOIEMENT_MAX = 2036;
const NIVEAUX_VIGILANCE = [3, 2, 1];

function getParametresInondation(hypotheses) {
  const g = (hyp, strate) => getHyp(hypotheses, CAS_INONDATION, hyp, strate === undefined ? "Toutes strates" : strate);
  const partGroupe = {};
  NIVEAUX_VIGILANCE.forEach((n) => { partGroupe[n] = g("Part des dommages annuels du groupe de vigilance", `Vigilance ${n}`); });
  return {
    dommages2025: g("Dommages annuels moyens d'inondation en France (2025)"),
    croissanceDommages: g("Croissance annuelle des dommages"),
    partGroupe,
    baseRepartition: g("Base de répartition des dommages sur le territoire"),
    partAdressable: g("Part des dommages adressable par une surveillance locale"),
    tauxEvitement: g("Taux d'évitement net des dommages (alerte locale)"),
    economieVeille: g("Économie de veille et d'astreinte"),
    capex: g("CAPEX stations de mesure"),
    nbPointsMesure: g("Nombre de points de mesure par territoire"),
    transmissionParPoint: g("OPEX transmission par point de mesure"),
    serveurs: g("OPEX serveurs et hébergement"),
    logiciels: g("OPEX logiciels — service de prévision et d'alerte"),
    tauxEM: g("Exploitation et maintenance (% du CAPEX cumulé)"),
    emForfait: g("Exploitation et maintenance — forfait annuel (hydrométrie, jaugeages)"),
    conduiteChangement: g("Évolution et conduite du changement (one-shot)"),
    fabricationCO2: g("CO2 de fabrication (stations, pluviomètres, électronique)"),
    fabricationEnergie: g("Énergie grise de fabrication"),
    installCO2: g("CO2 d'installation (supports, génie civil léger, déplacements)"),
    usageEnergieAn: g("Consommation d'usage (télétransmission et plateforme)"),
    mixElec: g("Mix électrique français"),
    finVieCO2: g("CO2 de fin de vie (recyclage des dispositifs)"),
  };
}

// Population par niveau de vigilance d'un ensemble de communes (territoire ou France entière).
function profilVigilance(communes) {
  const pop = { 1: 0, 2: 0, 3: 0 };
  let sansVigilance = 0, nbSansVigilance = 0;
  communes.forEach((c) => {
    const n = Number(c.vigilance);
    const p = Number(c.population) || 0;
    if (pop[n] === undefined) { sansVigilance += p; nbSansVigilance++; return; }
    pop[n] += p;
  });
  return { pop, populationTotale: pop[1] + pop[2] + pop[3], populationSansVigilance: sansVigilance, nbSansVigilance };
}

// Contexte national (dénominateurs) à partir de TOUTES les communes du référentiel.
function contexteNationalDepuisCommunes(communes) {
  const pr = profilVigilance(communes);
  return { populationNationale: pr.populationTotale + pr.populationSansVigilance, populationParVigilance: pr.pop };
}

// Dommages nationaux d'un niveau de vigilance pour une année (Excel lignes 2 à 5).
function dommagesNationauxNiveau(p, niveau, annee) {
  return p.dommages2025 * Math.pow(1 + p.croissanceDommages, annee - ANNEE_BASE_EXCEL) * p.partGroupe[niveau];
}

function calculInondationAvecOptions(hypotheses, communes, overrides) {
  const ov = overrides || {};
  const annee = Number(ov.anneeDeploiement);
  if (ov.anneeDeploiement == null || ov.anneeDeploiement === "" || !Number.isInteger(annee) ||
      annee < ANNEE_DEPLOIEMENT_MIN || annee > ANNEE_DEPLOIEMENT_MAX) {
    throw new Error(`Surveillance inondation : la date de déploiement du système de surveillance est obligatoire (année comprise entre ${ANNEE_DEPLOIEMENT_MIN} et ${ANNEE_DEPLOIEMENT_MAX}).`);
  }
  const nat = ov.national;
  if (!nat || !(nat.populationNationale > 0)) {
    throw new Error("Surveillance inondation : la population nationale par niveau de vigilance n'est pas disponible.");
  }
  const p = getParametresInondation(hypotheses);
  const profil = profilVigilance(communes);
  if (profil.nbSansVigilance > 0) {
    throw new Error(`Surveillance inondation : niveau de vigilance manquant pour ${profil.nbSansVigilance} commune(s) du territoire.`);
  }
  const anneeEffective = Math.max(annee, START_YEAR);
  const denominateur = (n) => (p.baseRepartition === 1 ? nat.populationParVigilance[n] : nat.populationNationale);

  let capexCumule = 0;
  const trajectoire = YEARS.map((year) => {
    const deploye = year >= anneeEffective ? 1 : 0;
    const nouveau = year === anneeEffective ? 1 : 0;

    // 1) dommages potentiels du territoire, par niveau de vigilance
    const dommagesNiveau = {};
    let dommages = 0;
    NIVEAUX_VIGILANCE.forEach((n) => {
      const d = (profil.pop[n] / denominateur(n)) * dommagesNationauxNiveau(p, n, year);
      dommagesNiveau[n] = d; dommages += d;
    });
    // 2) dommages évités (+ veille et astreinte évitées)
    const dommagesEvites = deploye * dommages * p.partAdressable * p.tauxEvitement;
    const economieVeille = deploye * p.economieVeille;
    // 3) coût d'un système
    const capex = nouveau * p.capex;
    capexCumule += capex;
    const opexTransmission = deploye * p.nbPointsMesure * p.transmissionParPoint;
    const opexServeurs = deploye * p.serveurs;
    const opexLogiciels = deploye * p.logiciels;
    const em = deploye * (p.tauxEM * capexCumule + p.emForfait);
    const conduite = nouveau * p.conduiteChangement;
    const depenses = capex + opexTransmission + opexServeurs + opexLogiciels + em + conduite;
    // 4) bilan environnemental (aucun bénéfice carbone ou énergie : uniquement des émissions)
    const impactEnergie = nouveau * p.fabricationEnergie + deploye * p.usageEnergieAn;
    const impactCO2 = nouveau * (p.fabricationCO2 + p.installCO2 + p.finVieCO2) + deploye * p.usageEnergieAn * p.mixElec;

    return {
      annee: year,
      deploye,
      dommages_territoire: dommages,
      dommages_vigilance_3: dommagesNiveau[3], dommages_vigilance_2: dommagesNiveau[2], dommages_vigilance_1: dommagesNiveau[1],
      pop_vigilance_3: profil.pop[3], pop_vigilance_2: profil.pop[2], pop_vigilance_1: profil.pop[1],
      dommages_evites: dommagesEvites,
      economie_veille: economieVeille,
      capex,
      opex_transmission: opexTransmission,
      opex_serveurs: opexServeurs,
      opex_logiciels: opexLogiciels,
      opex_exploitation_maintenance: em,
      opex_conduite_changement: conduite,
      depenses_totales: depenses,
      externalites_totales: dommagesEvites + economieVeille,
      benefice_energie_kwh: 0,
      impact_energie_kwh: impactEnergie,
      bilan_net_energie_kwh: -impactEnergie,
      benefice_co2_kg: 0,
      impact_co2_kg: impactCO2,
      bilan_net_co2_kg: -impactCO2,
    };
  });
  return { trajectoire, anneeDeploiement: annee, anneeEffective, profil,
           partAdressable: p.partAdressable, tauxEvitement: p.tauxEvitement, partEvitee: p.partAdressable * p.tauxEvitement };
}

if (typeof module !== "undefined") {
  module.exports = {
    calculEau, calculEP, calculEnergieBatiments, calculDechetsPAV, calculDechetsBacs, calculArrosage,
    calculEauTerritoire, calculEPTerritoire, calculEnergieBatimentsTerritoire,
    calculDechetsPAVTerritoire, calculDechetsBacsTerritoire, calculArrosageTerritoire,
    calculMutualisation, getAbattementsMutualisation, sommeColonne, resolveStrate, CAS_USAGE_REGISTRY, YEARS,
    getParametresEau, calculEauDepuisParc, tauxCompoundingFn, tauxLinearFn, getBaseMenages,
    calculEauOverride, calculEauAvecOptions,
    getParametresEP, calculEPDepuisParc, calculEPOverride, calculEPAvecOptions,
    calculDechetsPAVOverride, calculDechetsPAVAvecOptions,
    calculDechetsBacsOverride, calculDechetsBacsAvecOptions,
    calculArrosageOverride, calculArrosageAvecOptions,
    calculEnergieBatimentsAvecOptions,
    getParametresInondation, profilVigilance, contexteNationalDepuisCommunes, dommagesNationauxNiveau,
    calculInondationAvecOptions, CAS_INONDATION,
  };
}
