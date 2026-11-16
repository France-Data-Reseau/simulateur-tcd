// ---------- état ----------
let COMMUNES = [];
let EPCIS = [];           // index agrégé, construit après chargement
let DEPARTEMENTS = [];    // idem, par département
let SELECTED = null;      // { type: 'commune'|'epci'|'departement', label, communes: [...], ... }

function normalize(s) {
  return (s || "").toString().trim().toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function fmtEUR(n) {
  const sign = n < 0 ? "−" : "";
  return sign + Math.abs(Math.round(n)).toLocaleString("fr-FR") + " €";
}
function fmtInt(n) {
  return Math.round(n).toLocaleString("fr-FR");
}
function fmtMenages(menages, pointsLivraison) {
  if (Number.isFinite(menages)) return fmtInt(menages) + " ménages";
  if (Number.isFinite(pointsLivraison)) return "ménages n/d (" + fmtInt(pointsLivraison) + " points de livraison)";
  return "ménages n/d";
}
function fmtPct(n) {
  return (n * 100).toFixed(1).replace(".", ",") + " %";
}

// ---------- initialisation : données communes embarquées ----------
const step2 = document.getElementById("step2");
const step3 = document.getElementById("step3");
const step4 = document.getElementById("step4");

function unlock(step) { step.removeAttribute("data-locked"); }

function buildEpciIndex() {
  const map = new Map();
  COMMUNES.forEach((c) => {
    if (!c.epci_code || !c.epci_nom) return;
    if (!map.has(c.epci_code)) {
      map.set(c.epci_code, { code: c.epci_code, nom: c.epci_nom, communes: [] });
    }
    map.get(c.epci_code).communes.push(c);
  });
  EPCIS = Array.from(map.values());
  EPCIS.forEach((e) => {
    e._norm = normalize(e.nom);
    e.population = e.communes.reduce((a, c) => a + Number(c.population || 0), 0);
    e.menages = e.communes.reduce((a, c) => a + Number(c.nombre_menages || 0), 0);
  });
}

function buildDepartementIndex() {
  const map = new Map();
  COMMUNES.forEach((c) => {
    if (!c.dep_code || !c.dep_nom) return;
    if (!map.has(c.dep_code)) {
      map.set(c.dep_code, { code: c.dep_code, nom: c.dep_nom, communes: [] });
    }
    map.get(c.dep_code).communes.push(c);
  });
  DEPARTEMENTS = Array.from(map.values());
  DEPARTEMENTS.forEach((d) => {
    // on indexe "Loire" et "42 Loire" pour que la recherche par numéro fonctionne aussi
    d._norm = normalize(d.nom) + " " + normalize(d.code);
    d.population = d.communes.reduce((a, c) => a + Number(c.population || 0), 0);
    d.menages = d.communes.reduce((a, c) => a + Number(c.nombre_menages || 0), 0);
  });
}

// Le référentiel communes est désormais embarqué directement dans le fichier HTML
// (COMMUNES_RAW, défini juste avant ce script) — plus besoin de charger un fichier.
// Le modèle ne couvre pas l'outre-mer par construction (hypothèses calibrées sur la
// métropole, cf. atelier FNCCR) ; on exclut une commune seulement si population OU
// (ménages ET points de livraison) sont indisponibles — une commune avec seulement le
// nombre de points de livraison renseigné (ex. Mayotte) reste utilisable pour les cas
// d'usage qui s'appuient sur cette assiette (cf. getBaseMenages dans engine.js).
COMMUNES = COMMUNES_RAW
  .map(([code_insee, nom_standard, dep_code, dep_nom, epci_code, epci_nom,
         population, nombre_menages, Strate, nombre_points_livraison, vigilance]) => ({
    code_insee, nom_standard, dep_code, dep_nom, epci_code, epci_nom,
    population, nombre_menages, Strate, nombre_points_livraison, vigilance,
  }))
  .filter(c =>
    c.nom_standard && Number.isFinite(c.population) &&
    (Number.isFinite(c.nombre_menages) || Number.isFinite(c.nombre_points_livraison))
  );
COMMUNES.forEach(c => { c._norm = normalize(c.nom_standard); });
// Contexte national du cas d'usage « Surveillance inondation » : population de TOUTES les communes du
// référentiel (dénominateur des parts de population), par niveau de vigilance — avant tout filtrage.
const NATIONAL = contexteNationalDepuisCommunes(COMMUNES_RAW.map((r) => ({ population: r[6], vigilance: r[10] })));
buildEpciIndex();
buildDepartementIndex();
unlock(step2);

// ---------- étape 1 : recherche territoire ----------
const searchInput = document.getElementById("searchInput");
const resultsList = document.getElementById("resultsList");
const communeChip = document.getElementById("communeChip");
const chipName = document.getElementById("chipName");
const chipMeta = document.getElementById("chipMeta");
const chipClear = document.getElementById("chipClear");

searchInput.addEventListener("input", () => {
  const q = normalize(searchInput.value);
  if (q.length < 2) { resultsList.classList.remove("show"); return; }

  const depMatches = DEPARTEMENTS.filter(d => d._norm.includes(q)).slice(0, 3);
  const epciMatches = EPCIS.filter(e => e._norm.includes(q)).slice(0, 4);
  const communeMatches = COMMUNES.filter(c => c._norm.includes(q)).slice(0, 6);

  if (!depMatches.length && !epciMatches.length && !communeMatches.length) {
    resultsList.innerHTML = '<div class="result-item"><span class="meta">Aucun résultat</span></div>';
  } else {
    let html = "";
    html += depMatches.map(d =>
      `<div class="result-item" data-type="departement" data-code="${d.code}">
         <span class="name">${d.nom} <span class="type-pill dep">Département ${d.code}</span></span>
         <span class="meta">${d.communes.length} communes · ${fmtInt(d.population)} hab.</span>
       </div>`
    ).join("");
    html += epciMatches.map(e =>
      `<div class="result-item" data-type="epci" data-code="${e.code}">
         <span class="name">${e.nom} <span class="type-pill epci">Intercommunalité</span></span>
         <span class="meta">${e.communes.length} communes · ${fmtInt(e.population)} hab.</span>
       </div>`
    ).join("");
    html += communeMatches.map(c =>
      `<div class="result-item" data-type="commune" data-code="${c.code_insee}">
         <span class="name">${c.nom_standard} <span class="type-pill commune">Commune</span></span>
         <span class="meta">${c.dep_nom || ""} · ${fmtInt(Number(c.population))} hab.</span>
       </div>`
    ).join("");
    resultsList.innerHTML = html;
  }
  resultsList.classList.add("show");
});

resultsList.addEventListener("click", (e) => {
  const item = e.target.closest(".result-item");
  if (!item || !item.dataset.code) return;
  const type = item.dataset.type;

  if (type === "departement") {
    const dep = DEPARTEMENTS.find(d => d.code === item.dataset.code);
    selectTerritory({
      type: "departement",
      label: dep.nom,
      typeLabel: `Département ${dep.code}`,
      allCommunes: dep.communes,
      excludedCodes: new Set(),
      excludedEpciCodes: new Set(),
    });
  } else if (type === "epci") {
    const epci = EPCIS.find(e => e.code === item.dataset.code);
    selectTerritory({
      type: "epci",
      label: epci.nom,
      typeLabel: "Intercommunalité",
      allCommunes: epci.communes,
      excludedCodes: new Set(),
    });
  } else {
    const commune = COMMUNES.find(c => c.code_insee === item.dataset.code);
    selectTerritory({
      type: "commune",
      label: commune.nom_standard,
      typeLabel: commune.dep_nom || "",
      communes: [commune],
      population: Number(commune.population),
      menages: Number(commune.nombre_menages),
      pointsLivraison: Number(commune.nombre_points_livraison),
      depNom: commune.dep_nom,
    });
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) resultsList.classList.remove("show");
});

function strateBreakdown(communes) {
  const counts = {};
  communes.forEach(c => { counts[c.Strate] = (counts[c.Strate] || 0) + 1; });
  return Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ");
}

function computeTerritoryTotals(communes) {
  return {
    population: communes.reduce((a, c) => a + Number(c.population || 0), 0),
    menages: communes.reduce((a, c) => a + Number(c.nombre_menages || 0), 0),
  };
}

// Applique les exclusions (communes et, pour un département, EPCI entiers) à la liste
// complète des communes du territoire, et recalcule population/ménages en conséquence.
function applyExclusions(sel) {
  if (!sel.allCommunes) return; // sélection "commune" simple : rien à exclure
  sel.communes = sel.allCommunes.filter(c =>
    !sel.excludedCodes.has(c.code_insee) &&
    !(sel.excludedEpciCodes && sel.excludedEpciCodes.has(c.epci_code))
  );
  const totals = computeTerritoryTotals(sel.communes);
  sel.population = totals.population;
  sel.menages = totals.menages;
}

function selectTerritory(sel) {
  SELECTED = sel;
  searchInput.value = "";
  resultsList.classList.remove("show");

  if (sel.type === "commune") {
    sel.population = Number(sel.communes[0].population);
    sel.menages = Number(sel.communes[0].nombre_menages);
    sel.pointsLivraison = Number(sel.communes[0].nombre_points_livraison);
  } else {
    applyExclusions(sel);
  }

  renderTerritoryChip();
  renderAdjustPanel();
  communeChip.classList.add("show");
  unlock(step3);
  unlock(step4);
  document.getElementById("results").classList.remove("show");
}

function renderTerritoryChip() {
  const sel = SELECTED;
  const nExcl = sel.type === "commune" ? 0
    : (sel.allCommunes.length - sel.communes.length);
  const suffix = sel.type === "commune" ? "" :
    ` (${sel.typeLabel}, ${sel.communes.length} commune${sel.communes.length > 1 ? "s" : ""}${nExcl ? ` sur ${sel.allCommunes.length}` : ""})`;
  chipName.textContent = sel.label + suffix;
  if (sel.type === "commune") {
    chipMeta.textContent = `${sel.depNom || ""} · ${fmtInt(sel.population)} hab. · ${fmtMenages(sel.menages, sel.pointsLivraison)} · strate : ${sel.communes[0].Strate}`;
  } else {
    chipMeta.textContent = `${fmtInt(sel.population)} hab. · ${fmtMenages(sel.menages)} · ${strateBreakdown(sel.communes)}`;
  }
}

chipClear.addEventListener("click", () => {
  SELECTED = null;
  communeChip.classList.remove("show");
  document.getElementById("adjustWrap").innerHTML = "";
  step3.setAttribute("data-locked", "true");
  step4.setAttribute("data-locked", "true");
  document.getElementById("results").classList.remove("show");
});

// ---------- panneau d'ajustement (exclure des communes / EPCI) ----------
const adjustWrap = document.getElementById("adjustWrap");

function renderAdjustPanel() {
  const sel = SELECTED;
  if (sel.type === "commune") { adjustWrap.innerHTML = ""; return; }

  const epciList = sel.type === "departement" ? epciListOfDepartement(sel) : null;
  // Intercommunalité : liste à cocher de ses communes (toutes cochées) ; une commune décochée est exclue du calcul
  const communeList = sel.type === "epci" ? communesListOfEpci(sel) : null;

  adjustWrap.innerHTML = `
    <button class="adjust-link" id="adjustToggle" type="button">Ajuster la sélection (exclure des communes${sel.type === "departement" ? " ou intercommunalités" : ""})</button>
    <div class="adjust-panel" id="adjustPanel">
      ${epciList ? `
      <h4>Exclure une intercommunalité entière</h4>
      <div class="sub">Décochez une intercommunalité pour retirer toutes ses communes du calcul.</div>
      <div class="epci-toggle-list" id="epciToggleList">
        ${epciList.map(e => `
          <div class="epci-toggle-row">
            <input type="checkbox" id="epciTgl-${e.code}" ${sel.excludedEpciCodes.has(e.code) ? "" : "checked"}>
            <label for="epciTgl-${e.code}">${e.nom}</label>
            <span class="n">${e.count} commune${e.count > 1 ? "s" : ""}</span>
          </div>`).join("")}
      </div>` : ""}
      ${communeList ? `
      <h4>Exclure des communes</h4>
      <div class="sub">Décochez une commune pour la retirer du calcul.</div>
      <div class="epci-toggle-list commune-toggle-list" id="communeToggleList">
        ${communeList.map(c => `
          <div class="epci-toggle-row">
            <input type="checkbox" id="communeTgl-${c.code_insee}" ${sel.excludedCodes.has(c.code_insee) ? "" : "checked"}>
            <label for="communeTgl-${c.code_insee}">${c.nom_standard}</label>
            <span class="n">${fmtInt(Number(c.population))} hab.</span>
          </div>`).join("")}
      </div>` : `
      <h4>Exclure une commune</h4>
      <div class="sub">Recherchez une commune à retirer individuellement du calcul.</div>
      <div class="exclude-search-wrap">
        <input type="text" class="exclude-search" id="excludeSearch" placeholder="Ex. Auxerre…" autocomplete="off">
        <div class="exclude-results" id="excludeResults"></div>
      </div>
      <div class="excluded-chips" id="excludedChips"></div>`}
    </div>`;

  document.getElementById("adjustToggle").addEventListener("click", () => {
    document.getElementById("adjustPanel").classList.toggle("show");
  });

  if (epciList) {
    epciList.forEach(e => {
      document.getElementById(`epciTgl-${e.code}`).addEventListener("change", (ev) => {
        if (ev.target.checked) sel.excludedEpciCodes.delete(e.code);
        else sel.excludedEpciCodes.add(e.code);
        onExclusionChange();
      });
    });
  }

  if (communeList) {
    communeList.forEach(c => {
      document.getElementById(`communeTgl-${c.code_insee}`).addEventListener("change", (ev) => {
        if (ev.target.checked) {
          sel.excludedCodes.delete(c.code_insee);
        } else {
          // au moins une commune doit rester dans le calcul
          if (sel.allCommunes.length - sel.excludedCodes.size <= 1) {
            ev.target.checked = true;
            alert("Au moins une commune doit rester sélectionnée dans le calcul.");
            return;
          }
          sel.excludedCodes.add(c.code_insee);
        }
        onExclusionChange();
      });
    });
  } else {
    const excludeSearch = document.getElementById("excludeSearch");
    const excludeResults = document.getElementById("excludeResults");
    excludeSearch.addEventListener("input", () => {
      const q = normalize(excludeSearch.value);
      if (q.length < 2) { excludeResults.classList.remove("show"); return; }
      const matches = sel.allCommunes
        .filter(c => c._norm.includes(q) && !sel.excludedCodes.has(c.code_insee))
        .slice(0, 8);
      excludeResults.innerHTML = matches.length
        ? matches.map(c => `<div class="item" data-code="${c.code_insee}">${c.nom_standard} <span style="color:var(--muted)">· ${fmtInt(Number(c.population))} hab.</span></div>`).join("")
        : `<div class="item" style="color:var(--muted)">Aucun résultat</div>`;
      excludeResults.classList.add("show");
    });
    excludeResults.addEventListener("click", (e) => {
      const item = e.target.closest(".item");
      if (!item || !item.dataset.code) return;
      sel.excludedCodes.add(item.dataset.code);
      excludeSearch.value = "";
      excludeResults.classList.remove("show");
      onExclusionChange();
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".exclude-search-wrap")) excludeResults.classList.remove("show");
    });
  }

  renderExcludedChips();
}

function communesListOfEpci(sel) {
  return sel.allCommunes.slice().sort((a, b) => a.nom_standard.localeCompare(b.nom_standard, "fr"));
}

function epciListOfDepartement(sel) {
  const map = new Map();
  sel.allCommunes.forEach(c => {
    if (!c.epci_code) return;
    if (!map.has(c.epci_code)) map.set(c.epci_code, { code: c.epci_code, nom: c.epci_nom, count: 0 });
    map.get(c.epci_code).count++;
  });
  return Array.from(map.values()).sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
}

function renderExcludedChips() {
  const sel = SELECTED;
  const chips = document.getElementById("excludedChips");
  if (!chips) return;
  const communeChips = sel.allCommunes
    .filter(c => sel.excludedCodes.has(c.code_insee))
    .map(c => `<span class="excluded-chip">${c.nom_standard}<button data-kind="commune" data-code="${c.code_insee}" type="button">×</button></span>`);
  const epciChips = sel.excludedEpciCodes
    ? Array.from(sel.excludedEpciCodes).map(code => {
        const c = sel.allCommunes.find(c => c.epci_code === code);
        return `<span class="excluded-chip">${c ? c.epci_nom : code}<button data-kind="epci" data-code="${code}" type="button">×</button></span>`;
      })
    : [];
  chips.innerHTML = communeChips.concat(epciChips).join("");
  chips.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "commune") sel.excludedCodes.delete(btn.dataset.code);
      else sel.excludedEpciCodes.delete(btn.dataset.code);
      onExclusionChange();
    });
  });
}

function onExclusionChange() {
  applyExclusions(SELECTED);
  renderTerritoryChip();
  // Repeindre uniquement les cases EPCI + puces exclues (pas tout le panneau, pour
  // ne pas perdre le focus de la recherche ni refermer le panneau).
  if (SELECTED.type === "departement") {
    epciListOfDepartement(SELECTED).forEach(e => {
      const el = document.getElementById(`epciTgl-${e.code}`);
      if (el) el.checked = !SELECTED.excludedEpciCodes.has(e.code);
    });
  } else if (SELECTED.type === "epci") {
    SELECTED.allCommunes.forEach(c => {
      const el = document.getElementById(`communeTgl-${c.code_insee}`);
      if (el) el.checked = !SELECTED.excludedCodes.has(c.code_insee);
    });
  }
  renderExcludedChips();
  document.getElementById("results").classList.remove("show");
}

// ---------- étape 3 : cas d'usage ----------
// Un seul point de configuration pour les 6 cas d'usage : ajouter une ligne ici suffit
// à faire apparaître la case à cocher, le bloc résultat et le tableau d'indicateurs.
// Pictogrammes par cas d'usage (extraits du gabarit fourni par la FNCCR, recolorés
// dans la teinte de chaque cas d'usage — cf. CAS_CONFIG.colorDark).
const CAS_ICONS = {
  eau: "data:image/png;base64,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",
  ep: "data:image/png;base64,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",
  energie: "data:image/png;base64,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",
  pav: "data:image/png;base64,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",
  bacs: "data:image/png;base64,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",
  arrosage: "data:image/png;base64,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",
  inondation: "data:image/png;base64,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",
};

const CAS_CONFIG = [
  {
    id: "eau", cardClass: "eau", tag: "EAU", name: "Télérelève des compteurs", icon: CAS_ICONS.eau,
    desc: "Compteurs communicants, économies d'eau et de relève.",
    calc: calculEauAvecOptions, colorDark: "#29ABA3", colorLight: "#AEDFDC",
    title: "Eau — télérelève des compteurs",
    inputType: "simple", objetLabel: "compteurs d'eau",
  },
  {
    id: "ep", cardClass: "lum", tag: "ÉCLAIRAGE", name: "Armoires connectées", icon: CAS_ICONS.ep,
    desc: "Pilotage à distance, économies d'énergie et de déplacement.",
    calc: calculEPAvecOptions, colorDark: "#DE9111", colorLight: "#F2D5A5",
    title: "Éclairage public — armoires connectées",
    inputType: "simple", objetLabel: "armoires",
  },
  {
    id: "energie", cardClass: "energie", tag: "ÉNERGIE", name: "Énergie des bâtiments", icon: CAS_ICONS.energie,
    desc: "IoT et GTB des bâtiments publics, économies d'énergie.",
    calc: calculEnergieBatimentsAvecOptions, colorDark: "#248ED5", colorLight: "#ACD4EF",
    title: "Énergie des bâtiments (IoT & GTB)",
    inputType: "double",
    sousTypes: [
      { key: "petit", label: "Bâtiments < 500 m²", objetLabel: "bâtiments < 500 m²" },
      { key: "grand", label: "Bâtiments > 500 m²", objetLabel: "bâtiments > 500 m²" },
    ],
  },
  {
    id: "pav", cardClass: "pav", tag: "DÉCHETS", name: "Points d'apport volontaire", icon: CAS_ICONS.pav,
    desc: "Sondes de remplissage, tournées de collecte optimisées.",
    calc: calculDechetsPAVAvecOptions, colorDark: "#556879", colorLight: "#BEC6CC",
    title: "Déchets — points d'apport volontaire",
    inputType: "simple", objetLabel: "PAV",
  },
  {
    id: "bacs", cardClass: "bacs", tag: "DÉCHETS", name: "Bacs individuels", icon: CAS_ICONS.bacs,
    desc: "Puce RFID, tarification incitative.",
    calc: calculDechetsBacsAvecOptions, colorDark: "#556879", colorLight: "#BEC6CC",
    title: "Déchets — bacs individuels",
    inputType: "simple", objetLabel: "bacs individuels",
  },
  {
    id: "arrosage", cardClass: "arrosage", tag: "ARROSAGE", name: "Pilotage de l'arrosage", icon: CAS_ICONS.arrosage,
    desc: "Vannes connectées, sondes d'humidité, économies d'eau.",
    calc: calculArrosageAvecOptions, colorDark: "#29ABA3", colorLight: "#AEDFDC",
    title: "Pilotage de l'arrosage",
    inputType: "simple", objetLabel: "vannes d'arrosage",
  },
  {
    id: "inondation", cardClass: "inondation", tag: "INONDATION", name: "Surveillance inondation", icon: CAS_ICONS.inondation,
    desc: "Stations de mesure et alerte locale : dommages évités.",
    calc: calculInondationAvecOptions, colorDark: "#EB7360", colorLight: "#F7CAC3",
    title: "Surveillance inondation",
    inputType: "deploiement",
  },
];

const casGrid = document.getElementById("casGrid");
casGrid.innerHTML = CAS_CONFIG.map((c, i) => `
  <label class="cas-card ${c.cardClass}" id="casCard-${c.id}">
    <input type="checkbox" id="cas-${c.id}">
    <img class="cas-card-icon" src="${c.icon}" alt="">
    <span class="tag">${c.tag}</span>
    <div class="name">${c.name}</div>
    <div class="desc">${c.desc}</div>
  </label>`
).join("");

const computeBtn = document.getElementById("computeBtn");

function syncCardState() {
  let anyChecked = false;
  CAS_CONFIG.forEach((c) => {
    const checked = document.getElementById(`cas-${c.id}`).checked;
    document.getElementById(`casCard-${c.id}`).classList.toggle("checked", checked);
    anyChecked = anyChecked || checked;
  });
  computeBtn.disabled = !anyChecked;
  renderInputPanels();
}
CAS_CONFIG.forEach((c) => {
  document.getElementById(`cas-${c.id}`).addEventListener("change", syncCardState);
});
syncCardState();

// ---------- panneaux de saisie manuelle (facultatifs) par cas d'usage ----------
function champSimple(prefix, objetLabel) {
  return `
    <div class="input-fields">
      <div class="input-field">
        <label for="${prefix}-objets">Nombre de ${objetLabel} en 2026</label>
        <input type="number" min="0" step="1" id="${prefix}-objets" placeholder="Estimation">
      </div>
      <div class="input-field">
        <label for="${prefix}-connectes">Dont connectés en 2026</label>
        <input type="number" min="0" step="1" id="${prefix}-connectes" placeholder="Estimation">
      </div>
      <div class="input-field pct">
        <label for="${prefix}-pct36">% connectés visé en 2036 <span class="req">*</span></label>
        <input type="number" min="0" max="100" step="1" id="${prefix}-pct36" placeholder="Ex. 80">
      </div>
    </div>`;
}

function renderInputPanels() {
  const wrap = document.getElementById("inputsWrap");
  // Conserve les valeurs déjà saisies : cocher / décocher une carte ne doit pas effacer les autres champs.
  const valeursSaisies = {};
  wrap.querySelectorAll("input, select").forEach((el) => { if (el.id) valeursSaisies[el.id] = el.value; });
  const actifs = CAS_CONFIG.filter((c) => document.getElementById(`cas-${c.id}`).checked);
  if (actifs.length === 0) {
    wrap.innerHTML = `<p style="color:var(--muted);font-size:13px;">Activez au moins un cas d'usage à l'étape précédente pour voir apparaître ses champs de saisie.</p>`;
    return;
  }
  wrap.innerHTML = actifs.map((c) => {
    if (c.inputType === "deploiement") {
      const annees = [];
      for (let y = ANNEE_DEPLOIEMENT_MIN; y <= ANNEE_DEPLOIEMENT_MAX; y++) annees.push(y);
      return `
      <div class="input-panel ${c.cardClass}">
        <div class="input-panel-head"><img class="cas-block-icon" src="${c.icon}" alt=""><h4>${c.title}</h4></div>
        <div class="input-fields single">
          <div class="input-field">
            <label for="input-${c.id}-annee">Date de déploiement du système de surveillance <span class="req">*</span></label>
            <select id="input-${c.id}-annee">
              <option value="">Choisir une année…</option>
              ${annees.map((y) => `<option value="${y}">${y}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="input-hint">Année de mise en service d'un système de surveillance des inondations sur le territoire choisi (de ${ANNEE_DEPLOIEMENT_MIN} à ${ANNEE_DEPLOIEMENT_MAX}).
          Aucun parc d'objets à saisir : les dommages sont estimés d'après le profil de vigilance (1, 2 ou 3) des communes du territoire.
          Un déploiement en 2026 est comptabilisé dès 2027, première année de l'horizon d'analyse.</div>
      </div>`;
    }
    if (c.inputType === "double") {
      return `
      <div class="input-panel ${c.cardClass}">
        <div class="input-panel-head"><img class="cas-block-icon" src="${c.icon}" alt=""><h4>${c.title}</h4></div>
        ${c.sousTypes.map((st) => `
          <div class="input-subgroup">
            <div class="subtitle">${st.label}</div>
            ${champSimple(`input-${c.id}-${st.key}`, st.objetLabel)}
          </div>`).join("")}
      </div>`;
    }
    return `
      <div class="input-panel ${c.cardClass}">
        <div class="input-panel-head"><img class="cas-block-icon" src="${c.icon}" alt=""><h4>${c.title}</h4></div>
        ${champSimple(`input-${c.id}`, c.objetLabel)}
      </div>`;
  }).join("");
  Object.keys(valeursSaisies).forEach((id) => {
    const el = document.getElementById(id);
    if (el && valeursSaisies[id] !== "") el.value = valeursSaisies[id];
  });
}

function lireNombre(id) {
  const el = document.getElementById(id);
  if (!el || el.value === "") return null;
  const v = Number(el.value);
  return Number.isFinite(v) ? v : null;
}

// Lit les 3 champs d'un bloc de saisie simple et renvoie l'objet overrides attendu par
// le moteur (nombreObjets, nombreObjetsConnectes, pct2036). Toujours un objet (jamais
// null) : c'est au moteur (calculXxxAvecOptions) de décider si le %2036 manquant doit
// bloquer le calcul — il est désormais obligatoire dans tous les cas.
function lireOverridesSimple(prefix) {
  const nombreObjets = lireNombre(`${prefix}-objets`);
  const nombreObjetsConnectes = lireNombre(`${prefix}-connectes`);
  const pct = lireNombre(`${prefix}-pct36`);
  return { nombreObjets, nombreObjetsConnectes, pct2036: pct != null ? pct / 100 : null };
}

// ---------- SVG bar chart : dépenses (bas) vs bénéfices (haut) par année ----------
// Format compact pour les étiquettes du graphique (espace restreint) : 1,2M€ / 45k€ / 800€.
function fmtCompact(n) {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 1e6) return sign + (abs / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + "M€";
  if (abs >= 1e3) return sign + Math.round(abs / 1e3) + "k€";
  return sign + Math.round(abs) + "€";
}

function renderYearChart(trajectoire, colorDark, colorLight) {
  const W = 900, H = 212, padL = 40, padR = 10, padT = 18, padB = 36;
  const innerW = W - padL - padR;
  const n = trajectoire.length;
  const barW = innerW / n * 0.6;
  const gap = innerW / n;

  const maxVal = Math.max(
    ...trajectoire.map(r => Math.max(r.depenses_totales, r.externalites_totales))
  ) * 1.1 || 1;
  const zeroY = padT + (H - padT - padB) / 2;
  const halfH = (H - padT - padB) / 2;

  let bars = "";
  trajectoire.forEach((r, i) => {
    const x = padL + i * gap + (gap - barW) / 2;
    const cx = x + barW / 2;
    const hDep = (r.depenses_totales / maxVal) * halfH;
    const hBen = (r.externalites_totales / maxVal) * halfH;
    bars += `<rect x="${x}" y="${zeroY}" width="${barW}" height="${hDep}" fill="${colorDark}" rx="1.5"/>`;
    bars += `<rect x="${x}" y="${zeroY - hBen}" width="${barW}" height="${hBen}" fill="${colorLight}" rx="1.5"/>`;
    // Valeur au-dessus de la barre des bénéfices, valeur sous la barre des dépenses —
    // un chiffre par année et par série, demandé explicitement plutôt qu'un survol.
    bars += `<text x="${cx}" y="${zeroY - hBen - 4}" font-size="8.5" fill="${colorDark}" text-anchor="middle" font-family="Inter" font-weight="600">${fmtCompact(r.externalites_totales)}</text>`;
    bars += `<text x="${cx}" y="${zeroY + hDep + 11}" font-size="8.5" fill="${colorDark}" text-anchor="middle" font-family="Inter" font-weight="600">${fmtCompact(r.depenses_totales)}</text>`;
    bars += `<text x="${cx}" y="${H - 6}" font-size="9.5" fill="#5B6157" text-anchor="middle" font-family="Inter">${r.annee}</text>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#DADFD3" stroke-width="1"/>
    ${bars}
  </svg>`;
}

// ---------- tableau des indicateurs marché clés (première année → dernière année) ----------
function renderMarketTable(trajectoire, kind) {
  const first = trajectoire[0];
  const last = trajectoire[trajectoire.length - 1];

  const taux = (a, b) => ({ a, b, fmt: fmtPct, isRate: true });

  let lignes;
  if (kind === "eau") {
    lignes = [
      { label: "Compteurs d'eau (parc total)", a: first.parc_total, b: last.parc_total, fmt: fmtInt },
      { label: "Compteurs connectés (télérelève)", a: first.stock_connecte, b: last.stock_connecte, fmt: fmtInt },
      { label: "Taux de compteurs connectés", ...taux(first.stock_connecte / first.parc_total, last.stock_connecte / last.parc_total) },
      { label: "Volume d'eau géré (m³/an)", a: first.volume_eau_total_m3, b: last.volume_eau_total_m3, fmt: fmtInt },
      { label: "Volume sous télérelève (m³/an)", a: first.volume_eau_connecte_m3, b: last.volume_eau_connecte_m3, fmt: fmtInt },
      { label: "Volume d'eau économisé (m³/an)", a: first.volume_eau_economise_m3, b: last.volume_eau_economise_m3, fmt: fmtInt },
    ];
  } else if (kind === "ep") {
    lignes = [
      { label: "Points lumineux (parc total)", a: first.parc_points_lumineux, b: last.parc_points_lumineux, fmt: fmtInt },
      { label: "Armoires de commande (parc total)", a: first.parc_total, b: last.parc_total, fmt: fmtInt },
      { label: "Armoires connectées", a: first.stock_connecte, b: last.stock_connecte, fmt: fmtInt },
      { label: "Taux d'armoires connectées", ...taux(first.stock_connecte / first.parc_total, last.stock_connecte / last.parc_total) },
      { label: "Consommation éclairage public (MWh/an)", a: first.conso_totale_mwh, b: last.conso_totale_mwh, fmt: fmtInt },
      { label: "Énergie économisée (MWh/an)", a: first.energie_economisee_mwh, b: last.energie_economisee_mwh, fmt: fmtInt },
    ];
  } else if (kind === "energie") {
    lignes = [
      { label: "Petits bâtiments <500m² (parc)", a: first.parc_petits_batiments, b: last.parc_petits_batiments, fmt: fmtInt },
      { label: "Petits bâtiments connectés (IoT)", a: first.stock_petits_connectes, b: last.stock_petits_connectes, fmt: fmtInt },
      { label: "Taux de connexion IoT (petits)", ...taux(first.stock_petits_connectes / first.parc_petits_batiments, last.stock_petits_connectes / last.parc_petits_batiments) },
      { label: "Grands bâtiments >500m² (parc)", a: first.parc_grands_batiments, b: last.parc_grands_batiments, fmt: fmtInt },
      { label: "Grands bâtiments connectés (GTB)", a: first.stock_grands_connectes, b: last.stock_grands_connectes, fmt: fmtInt },
      { label: "Taux de connexion GTB (grands)", ...taux(first.stock_grands_connectes / first.parc_grands_batiments, last.stock_grands_connectes / last.parc_grands_batiments) },
      { label: "Dépense énergétique totale (€/an)", a: first.depense_energie_totale, b: last.depense_energie_totale, fmt: fmtEUR },
    ];
  } else if (kind === "pav") {
    lignes = [
      { label: "Points d'apport volontaire (parc total)", a: first.parc_total, b: last.parc_total, fmt: fmtInt },
      { label: "PAV connectés (sondes de remplissage)", a: first.stock_connecte, b: last.stock_connecte, fmt: fmtInt },
      { label: "Taux de PAV connectés", ...taux(first.stock_connecte / first.parc_total, last.stock_connecte / last.parc_total) },
    ];
  } else if (kind === "bacs") {
    lignes = [
      { label: "Bacs individuels (parc total)", a: first.parc_total, b: last.parc_total, fmt: fmtInt },
      { label: "Bacs connectés (puce RFID)", a: first.stock_connecte, b: last.stock_connecte, fmt: fmtInt },
      { label: "Taux de bacs connectés", ...taux(first.stock_connecte / first.parc_total, last.stock_connecte / last.parc_total) },
    ];
  } else if (kind === "arrosage") {
    lignes = [
      { label: "Surface d'espaces verts arrosés (m²)", a: first.surface_arrosee_m2, b: last.surface_arrosee_m2, fmt: fmtInt },
      { label: "Vannes d'arrosage (parc total)", a: first.parc_total, b: last.parc_total, fmt: fmtInt },
      { label: "Vannes connectées", a: first.stock_connecte, b: last.stock_connecte, fmt: fmtInt },
      { label: "Taux de vannes connectées", ...taux(first.stock_connecte / first.parc_total, last.stock_connecte / last.parc_total) },
      { label: "Volume d'eau géré numériquement (m³/an)", a: first.volume_eau_gere_m3, b: last.volume_eau_gere_m3, fmt: fmtInt },
    ];
  } else {
    lignes = [];
  }

  const rows = lignes.map(l => {
    let evol, evolClass;
    if (l.isRate) {
      // pour un taux, l'écart en points de pourcentage est plus lisible qu'un %
      const pts = (l.b - l.a) * 100;
      evol = (pts >= 0 ? "+" : "−") + Math.abs(pts).toFixed(1).replace(".", ",") + " pts";
      evolClass = pts >= 0 ? "up" : "down";
    } else {
      const pct = l.a === 0 ? 0 : ((l.b - l.a) / l.a) * 100;
      evol = (pct >= 0 ? "+" : "−") + Math.abs(pct).toFixed(1).replace(".", ",") + " %";
      evolClass = pct >= 0 ? "up" : "down";
    }
    return `<tr>
      <td class="lbl">${l.label}</td>
      <td class="val">${l.fmt(l.a)}</td>
      <td class="val">${l.fmt(l.b)}</td>
      <td class="evol ${evolClass}">${evol}</td>
    </tr>`;
  }).join("");

  return `
  <div class="market-table-wrap">
    <table class="market-table">
      <thead><tr><th>Indicateur marché</th><th>${first.annee}</th><th>${last.annee}</th><th>Évolution</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ---------- répartition des dépenses cumulées (10 ans) par poste ----------
// Même schéma de postes pour les 6 cas d'usage (capex, transmission, serveurs,
// logiciels, exploitation-maintenance, conduite du changement) — fonction générique.
const POSTES_DEPENSES = [
  { key: "capex", label: "Objets connectés (CAPEX)", color: "#00366B" },
  { key: "opex_transmission", label: "Transmission", color: "#004C92" },
  { key: "opex_serveurs", label: "Serveurs & hosting", color: "#6E85B8" },
  { key: "opex_logiciels", label: "Logiciels", color: "#A8B2D5" },
  { key: "opex_exploitation_maintenance", label: "Exploitation & maintenance", color: "#C08A1E" },
  { key: "opex_conduite_changement", label: "Conduite du changement", color: "#7C5CBF" },
];

function renderDepensesBreakdown(trajectoire) {
  const totals = POSTES_DEPENSES.map((p) => ({
    ...p,
    total: trajectoire.reduce((a, r) => a + (r[p.key] || 0), 0),
  }));
  const totalGeneral = totals.reduce((a, p) => a + p.total, 0) || 1;

  const bar = totals.map((p) =>
    `<div style="flex:${Math.max(p.total, 0)} 0 0;background:${p.color}" title="${p.label} — ${fmtEUR(p.total)}"></div>`
  ).join("");

  const legend = totals.map((p) => {
    const pct = (p.total / totalGeneral) * 100;
    return `<div class="depenses-legend-item">
      <i style="background:${p.color}"></i>
      <span class="lbl">${p.label}</span>
      <span class="val">${fmtEUR(p.total)}</span>
      <span class="pct">${pct.toFixed(0)}%</span>
    </div>`;
  }).join("");

  return `
  <div class="depenses-breakdown">
    <div class="label" style="margin-bottom:8px;">Répartition des dépenses cumulées (10 ans)</div>
    <div class="depenses-bar">${bar}</div>
    <div class="depenses-legend">${legend}</div>
  </div>`;
}

// Lecture des bilans énergie et CO2 : un signe + (rouge) = plus d'énergie consommée / de CO2 émis que d'économies générées ;
// un signe − (vert) = économies nettes. Seul l'AFFICHAGE est inversé : les données (bilan_net_* = bénéfices − émissions) ne changent pas.
function fmtKWh(n) {
  const r = Math.round(n);
  const sign = r > 0 ? "+" : r < 0 ? "−" : "";
  return sign + Math.abs(r).toLocaleString("fr-FR") + " kWh";
}
function fmtTCO2(n) {
  const r = Math.round(n * 10) / 10;
  const sign = r > 0 ? "+" : r < 0 ? "−" : "";
  return sign + Math.abs(r).toLocaleString("fr-FR", { maximumFractionDigits: 1 }) + " tCO2e";
}
function fmtM3(n) {
  return Math.round(n).toLocaleString("fr-FR") + " m³";
}

// ---------- bilan environnemental net (10 ans) ----------
function renderBilanEnvironnemental(trajectoire) {
  const netEnergie = trajectoire.reduce((a, r) => a + (r.bilan_net_energie_kwh || 0), 0);
  const netCO2kg = trajectoire.reduce((a, r) => a + (r.bilan_net_co2_kg || 0), 0);
  const netCO2t = netCO2kg / 1000;
  const hasEau = trajectoire[0].bilan_net_eau_m3 !== undefined;
  const netEau = hasEau ? trajectoire.reduce((a, r) => a + (r.bilan_net_eau_m3 || 0), 0) : null;

  const classeEnergie = netEnergie >= 0 ? "pos" : "neg";
  const classeCO2 = netCO2t >= 0 ? "pos" : "neg";

  let cols = `
    <div class="metric">
      <div class="label">Bilan net énergie (10 ans)</div>
      <div class="value ${classeEnergie}">${fmtKWh(-netEnergie)}</div>
    </div>
    <div class="metric">
      <div class="label">Bilan net CO2 (10 ans)</div>
      <div class="value ${classeCO2}">${fmtTCO2(-netCO2t)}</div>
    </div>`;
  if (hasEau) {
    cols += `
    <div class="metric">
      <div class="label">Bilan net eau (10 ans)</div>
      <div class="value pos">${fmtM3(netEau)}</div>
    </div>`;
  }

  return `
  <div class="env-row">
    <div class="env-title">Bilan environnemental net — fabrication et usage des objets connectés déduits des économies générées</div>
    <div class="env-legend">Lecture : un signe + (en rouge) indique plus d'énergie consommée ou de CO₂ émis que d'économies générées ; un signe − (en vert), des économies nettes.</div>
    <div class="metrics-row env-metrics">${cols}</div>
  </div>`;
}

// ---------- rendu d'un bloc cas d'usage ----------
function renderCasBlock(resultat, config) {
  const kind = config.id;
  const total_dep = resultat.trajectoire.reduce((a, r) => a + r.depenses_totales, 0);
  const total_ext = resultat.trajectoire.reduce((a, r) => a + r.externalites_totales, 0);
  const solde = total_ext - total_dep;
  const soldeClass = solde >= 0 ? "pos" : "neg";
  const colorDark = config.colorDark;
  const colorLight = config.colorLight;
  const title = config.title;

  return `
  <div class="cas-block ${kind}">
    <div class="cas-block-head"><img class="cas-block-icon" src="${config.icon}" alt=""><h3>${title}</h3></div>
    ${(kind === "eau" || kind === "bacs") ? `<div class="assiette-note">Assiette : nombre de points de livraison (compteurs eau/énergie) quand disponible, sinon nombre de ménages.</div>` : ""}
    <div class="metrics-row">
      <div class="metric"><div class="label">Dépenses cumulées (10 ans)</div><div class="value">${fmtEUR(total_dep)}</div></div>
      <div class="metric"><div class="label">Externalités / bénéfices (10 ans)</div><div class="value">${fmtEUR(total_ext)}</div></div>
      <div class="metric"><div class="label">Solde net (10 ans)</div><div class="value ${soldeClass}">${fmtEUR(solde)}</div></div>
    </div>
    ${renderBilanEnvironnemental(resultat.trajectoire)}
    <div class="depenses-breakdown-wrap">${renderDepensesBreakdown(resultat.trajectoire)}</div>
    ${renderMarketTable(resultat.trajectoire, kind)}
    <div class="chart-area">
      <div class="chart-legend">
        <span><i style="background:${colorLight}"></i>Bénéfices annuels</span>
        <span><i style="background:${colorDark}"></i>Dépenses annuelles</span>
      </div>
      ${renderYearChart(resultat.trajectoire, colorDark, colorLight)}
    </div>
  </div>`;
}

// ---------- rendu du bloc « Surveillance inondation » ----------
const LIBELLES_VIGILANCE = {
  3: "Vigilance 3 — fortement exposé",
  2: "Vigilance 2 — moyennement exposé",
  1: "Vigilance 1 — faiblement exposé",
};

function renderInondationBlock(resultat, config) {
  const t = resultat.trajectoire;
  const somme = (cle) => t.reduce((a, r) => a + (r[cle] || 0), 0);
  const premiere = t[0];
  const derniere = t[t.length - 1];
  const dommages = somme("dommages_territoire");
  const evites = somme("externalites_totales");
  const couts = somme("depenses_totales");
  const net = evites - couts;
  const netClass = net >= 0 ? "pos" : "neg";
  const { anneeDeploiement, anneeEffective, partEvitee, partAdressable, tauxEvitement } = resultat;
  const noteDate = anneeDeploiement === anneeEffective
    ? `Système de surveillance déployé en ${anneeDeploiement}.`
    : `Déploiement indiqué en ${anneeDeploiement}, comptabilisé dès ${anneeEffective} (première année de l'horizon d'analyse).`;
  const horizon = `${premiere.annee}–${derniere.annee}`;

  const lignes = [3, 2, 1].map((n) => {
    const pop = premiere[`pop_vigilance_${n}`];
    const ok = pop > 0;
    return `<tr>
      <td class="lbl">${LIBELLES_VIGILANCE[n]}</td>
      <td class="val">${ok ? fmtInt(pop) + " hab." : "—"}</td>
      <td class="val">${ok ? fmtEUR(premiere[`dommages_vigilance_${n}`]) : "—"}</td>
      <td class="val">${ok ? fmtEUR(derniere[`dommages_vigilance_${n}`]) : "—"}</td>
      <td class="val">${ok ? fmtEUR(somme(`dommages_vigilance_${n}`)) : "—"}</td>
    </tr>`;
  }).join("");
  const popTotale = premiere.pop_vigilance_1 + premiere.pop_vigilance_2 + premiere.pop_vigilance_3;
  const ligneTotale = `<tr class="total">
      <td class="lbl">Total du territoire</td>
      <td class="val">${fmtInt(popTotale)} hab.</td>
      <td class="val">${fmtEUR(premiere.dommages_territoire)}</td>
      <td class="val">${fmtEUR(derniere.dommages_territoire)}</td>
      <td class="val">${fmtEUR(dommages)}</td>
    </tr>`;

  return `
  <div class="cas-block ${config.id}">
    <div class="cas-block-head"><img class="cas-block-icon" src="${config.icon}" alt=""><h3>${config.title}</h3></div>
    <div class="metrics-row four">
      <div class="metric"><div class="label">Coût de mise en place (1 système à l'échelle départementale)</div><div class="value">${fmtEUR(couts)}</div></div>
      <div class="metric"><div class="label">Dommages potentiels du territoire (${horizon})</div><div class="value">${fmtEUR(dommages)}</div></div>
      <div class="metric"><div class="label">Dommages évités par la surveillance</div><div class="value">${fmtEUR(evites)}</div></div>
      <div class="metric"><div class="label">Bilan net économique</div><div class="value ${netClass}">${fmtEUR(net)}</div></div>
    </div>
    ${renderBilanEnvironnemental(t)}
    <div class="note-block">${noteDate} Le système permet d'éviter ${fmtPct(partEvitee)} des dommages chaque année dès sa mise en service (${fmtPct(partAdressable)} de dommages adressables par une surveillance locale × ${fmtPct(tauxEvitement)} d'évitement net). Dommages estimés d'après le profil de vigilance (1, 2 ou 3)
      du territoire et les dommages nationaux de chaque niveau (1 Md€ en 2025, +2,5 %/an) ; coût d'un seul système de surveillance (stations de mesure, transmission, plateforme de prévision et d'alerte).</div>
    <div class="market-table-wrap">
      <table class="market-table">
        <thead><tr><th>Profil de risque du territoire</th><th>Population</th><th>Dommages ${premiere.annee}</th><th>Dommages ${derniere.annee}</th><th>Cumul ${horizon}</th></tr></thead>
        <tbody>${lignes}${ligneTotale}</tbody>
      </table>
    </div>
    <div class="depenses-breakdown-wrap">${renderDepensesBreakdown(t)}</div>
    <div class="chart-area">
      <div class="chart-legend">
        <span><i style="background:${config.colorLight}"></i>Dommages évités annuels</span>
        <span><i style="background:${config.colorDark}"></i>Dépenses annuelles</span>
      </div>
      ${renderYearChart(t, config.colorDark, config.colorLight)}
    </div>
  </div>`;
}

// ---------- rendu mutualisation ----------
function renderMutualisation(resultats, configs) {
  const mut = calculMutualisation(resultats, 1.0);
  const soldeClassSilo = mut.soldeSilo >= 0 ? "pos" : "neg";
  const soldeClassMut = mut.soldeMutualise >= 0 ? "pos" : "neg";
  const noms = configs.map((c) => c.name).join(", ");
  const lignesDetail = mut.parCas.map((pc, i) => `
        <tr>
          <td class="lbl">${configs[i].name}</td>
          <td class="val">${fmtEUR(pc.depensesSilo)}</td>
          <td class="val">${fmtEUR(pc.depensesMutualise)}</td>
          <td class="val eco">${fmtEUR(pc.economie)}</td>
        </tr>`).join("");
  const ligneTotale = `
        <tr class="total">
          <td class="lbl">Total</td>
          <td class="val">${fmtEUR(mut.depensesSilo)}</td>
          <td class="val">${fmtEUR(mut.depensesMutualise)}</td>
          <td class="val eco">${fmtEUR(mut.economieTotale)}</td>
        </tr>`;

  return `
  <div class="mut-block">
    <div class="mut-head">
      <h3>Silo vs mutualisé</h3>
      <p>Même programme, calculé deux fois : chaque cas d'usage pour lui-même, puis en mutualisant réseau, serveurs, logiciels, exploitation-maintenance et conduite du changement entre ${configs.length} cas d'usage activés (${noms}).</p>
    </div>
    <div class="mut-compare">
      <div class="mut-col">
        <div class="kicker">SILO — chaque service pour lui-même</div>
        <div class="depenses">${fmtEUR(mut.depensesSilo)}</div>
        <div class="solde">Solde : <strong class="${soldeClassSilo}">${fmtEUR(mut.soldeSilo)}</strong></div>
      </div>
      <div class="mut-arrow">→</div>
      <div class="mut-col mutualise">
        <div class="kicker">MUTUALISÉ — réseau &amp; plateformes partagés</div>
        <div class="depenses">${fmtEUR(mut.depensesMutualise)}</div>
        <div class="solde">Solde : <strong class="${soldeClassMut}">${fmtEUR(mut.soldeMutualise)}</strong></div>
      </div>
    </div>
    <div class="mut-detail-title">Dépenses par cas d'usage — sommes sur 10 ans</div>
    <div class="market-table-wrap mut-detail">
      <table class="market-table mut-table">
        <thead>
          <tr><th>Cas d'usage</th><th>Dépenses en silo</th><th>Dépenses mutualisées</th><th class="eco">Économie de mutualisation</th></tr>
        </thead>
        <tbody>${lignesDetail}${ligneTotale}</tbody>
      </table>
    </div>
    <div class="mut-callout">
      <span class="big">${fmtEUR(mut.economieTotale)}</span>
      <span class="txt">économisés sur 10 ans en coordonnant les ${configs.length} cas d'usage activés plutôt qu'en les déployant séparément.</span>
    </div>
  </div>`;
}

// ---------- calcul + rendu global ----------
computeBtn.addEventListener("click", () => {
  if (!SELECTED) return;
  const communes = SELECTED.communes;

  const configsActifs = CAS_CONFIG.filter((c) => document.getElementById(`cas-${c.id}`).checked);

  let resultats;
  try {
    resultats = configsActifs.map((c) => {
      if (c.inputType === "deploiement") {
        return c.calc(HYPOTHESES, communes, { anneeDeploiement: lireNombre(`input-${c.id}-annee`), national: NATIONAL });
      }
      if (c.inputType === "double") {
        const overrides = {};
        c.sousTypes.forEach((st) => {
          overrides[st.key] = lireOverridesSimple(`input-${c.id}-${st.key}`);
        });
        return c.calc(HYPOTHESES, communes, overrides);
      }
      const overrides = lireOverridesSimple(`input-${c.id}`);
      return c.calc(HYPOTHESES, communes, overrides);
    });
  } catch (err) {
    alert("Erreur de calcul : " + err.message);
    return;
  }

  const strateLabel = SELECTED.type === "commune"
    ? `Strate : ${communes[0].Strate}`
    : `${communes.length} communes · ${strateBreakdown(communes)}`;

  const todayStr = new Date().toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });

  let html = `
  <div class="territory-banner">
    <div>
      <h2>${SELECTED.label}</h2>
      <div class="sub">${SELECTED.typeLabel || ""} · ${fmtInt(SELECTED.population)} habitants · ${fmtMenages(SELECTED.menages, SELECTED.pointsLivraison)} · horizon 2027-2036 · coûts récurrents et bénéfices calculés sur le parc connecté ajouté depuis 2026</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="strate-badge">${strateLabel}</span>
      <button class="pdf-btn" id="pdfBtn" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>
        Exporter en PDF
      </button>
    </div>
  </div>`;

  configsActifs.forEach((c, i) => {
    html += c.id === "inondation" ? renderInondationBlock(resultats[i], c) : renderCasBlock(resultats[i], c);
  });
  // La surveillance inondation est un système unique par territoire (stations, plateforme de prévision) :
  // elle n'entre pas dans la mutualisation du réseau IoT entre cas d'usage.
  const iotConfigs = configsActifs.filter((c) => c.id !== "inondation");
  const iotResultats = resultats.filter((_, i) => configsActifs[i].id !== "inondation");
  if (iotResultats.length > 1) html += renderMutualisation(iotResultats, iotConfigs);

  html += `<div class="print-footer">
    Document généré le ${todayStr} — Observatoire des Territoires Connectés et Durables, FNCCR × Tactis.
    Simulation indicative à partir du modèle national extrapolé au territoire sélectionné —
    ne remplace pas une étude de faisabilité locale.
  </div>`;

  const results = document.getElementById("results");
  results.innerHTML = html;
  results.classList.add("show");
  if (typeof results.scrollIntoView === "function") {
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const pdfBtn = document.getElementById("pdfBtn");
  if (pdfBtn) {
    pdfBtn.addEventListener("click", () => {
      const previousTitle = document.title;
      // Le titre du document sert de nom de fichier suggéré par le navigateur
      // dans la boîte de dialogue "Enregistrer au format PDF".
      document.title = `Mon territoire local — ${SELECTED.label}`;
      window.print();
      document.title = previousTitle;
    });
  }
});
