const fs = require('fs');
const { JSDOM } = require('jsdom');
let html = fs.readFileSync('mon_territoire_donnees.html', 'utf-8');
html = html.replace(/<link[^>]*fonts\.(googleapis|gstatic)[^>]*>/g, '');
const hypFile = JSON.parse(fs.readFileSync('hypotheses.json', 'utf-8'));

const testScript = `
<script>
window.__TEST__ = (function(){
  try {
    const out = {};
    // Aucun cas d'usage coché au chargement : le bouton « Calculer » est désactivé tant qu'on n'en a pas coché un
    const cases = [...document.querySelectorAll('#casGrid input[type=checkbox]')];
    out.defautsDecoches = cases.length === 7 && cases.every(c => !c.checked) && document.getElementById('computeBtn').disabled === true
      && document.querySelectorAll('#casGrid .cas-card.checked').length === 0;
    const texteVisible = () => { const c = document.body.cloneNode(true); c.querySelectorAll('script,style').forEach(e => e.remove()); return c.textContent; };
    const enTete = document.querySelector('header.top .head-text');
    out.sansBandeau = !!enTete && enTete.firstElementChild.tagName === 'H1' && !document.querySelector('.eyebrow-line')
      && !enTete.textContent.includes('Simulateur territorial') && !document.querySelector('header.top').textContent.includes('FNCCR × Tactis');
    out.titre = document.querySelector('h1.title').textContent === 'Mon Territoire Connecté et Durable' && document.title.startsWith('Mon Territoire Connecté et Durable')
      && !texteVisible().includes('Mon territoire, mes données') && !document.title.includes('mes données');
    const get = (cas, h, s) => HYPOTHESES.find(r => r.cas_usage.startsWith(cas) && r.hypothese.startsWith(h) && r.strate === s);

    // --- Hypothèses V1.2 embarquées dans le HTML ---
    out.nbHyp = HYPOTHESES.length;
    out.v12 = {
      eauEco: get("Eau", "Économie d'eau générée", "Toutes strates").valeur,
      eauBase: get("Eau", "Taux de compteurs télérelevés", "Toutes strates").valeur,
      epCapexMetro: get("Éclairage", "CAPEX fourni-posé armoire", "Métropole").valeur,
      pavCapexRural: get("Déchets - points", "CAPEX sonde", "<2k hab").valeur,
      bacsConduite: get("Déchets - bacs", "Conduite du changement", "Toutes strates").valeur,
      bacsRefonte: get("Déchets - bacs", "Part des collectivités refondant", "Toutes strates").valeur,
      arrCapexVanne: get("Arrosage", "CAPEX vanne", "Métropole").valeur,
      arrJardinier: get("Arrosage", "Économie déplacement jardinier", "2-30k hab").valeur,
    };

    // --- Bacs : le facteur 50 % est bien appliqué au gain km ---
    const roanne = COMMUNES.find(c => c.nom_standard === "Roanne");
    const rB = calculDechetsBacsAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.6});
    const p = getParametresBacs(HYPOTHESES, resolveStrate(roanne));
    const row = rB.trajectoire[4];
    const stock0B = rB.trajectoire[0].stock_connecte - rB.trajectoire[0].nouveaux;
    out.bacsKmFactor = Math.abs(row.benefice_deplacement - Math.max(row.stock_connecte - stock0B, 0) * p.ecoDeplacement * 0.5) < 1e-6;

    // --- Additionnalité : coûts récurrents et bénéfices = parc connecté AJOUTÉ depuis 2026 ---
    const pe = getParametresEau(HYPOTHESES, resolveStrate(roanne));
    const rA = calculEauAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.6});
    const stock0 = rA.trajectoire[0].stock_connecte - rA.trajectoire[0].nouveaux;   // parc connecté de référence
    out.addTrans = rA.trajectoire.every(x => Math.abs(x.opex_transmission - Math.max(x.stock_connecte - stock0, 0) * pe.opexTransmission) < 1e-6);
    out.addBenef = rA.trajectoire.every(x => Math.abs(x.benefice_releve - Math.max(x.stock_connecte - stock0, 0) * pe.ecoReleve) < 1e-6);
    // CAPEX et conduite du changement restent sur l'incrément annuel
    out.capexIncrement = rA.trajectoire.every(x => Math.abs(x.capex - x.nouveaux * pe.capexUnitaire) < 1e-6);
    // Cible sous le taux actuel : aucun parc ajouté => ni coûts récurrents ni bénéfices
    const rLow = calculEauAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.10});
    out.noAddNoFlows = rLow.trajectoire.every(x => x.opex_transmission === 0 && x.opex_logiciels === 0 && x.externalites_totales === 0);
    // Les indicateurs marché restent sur le parc connecté TOTAL
    out.indicatorsTotal = rA.trajectoire.every(x => x.stock_connecte > stock0 * 0.99);

    // --- CO2 évité : TOUTES les lignes « Bénéfice » de l'inventaire Excel V1.2 (6 cas d'usage) ---
    const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
    const addOf = (t) => { const s0 = t[0].stock_connecte - t[0].nouveaux; return (x) => Math.max(x.stock_connecte - s0, 0); };
    const E_ = getParametresEau(HYPOTHESES, resolveStrate(roanne)), tE = calculEauAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.6}).trajectoire;
    out.co2Eau = tE.every(x => near(x.benefice_co2_kg, x.volume_eau_economise_m3 * E_.co2EviteTraitementEau + addOf(tE)(x) * 0.5 * 0.2));          // l.171 + l.175
    const P_ = getParametresEP(HYPOTHESES, resolveStrate(roanne)), tP = calculEPAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.6}).trajectoire;
    out.co2EP = tP.every(x => near(x.benefice_co2_kg, x.benefice_energie_kwh * 0.079 + addOf(tP)(x) * 16 * 0.2));                                   // l.171 + l.175
    const penP = getParametresEnergiePetit(HYPOTHESES, resolveStrate(roanne)), penG = getParametresEnergieGrand(HYPOTHESES, resolveStrate(roanne));
    const tN = calculEnergieBatimentsAvecOptions(HYPOTHESES, [roanne], {petit:{pct2036:0.6}, grand:{pct2036:0.6}}).trajectoire;
    const p0 = penP.nbBase * penP.tauxConnexionBase, g0 = penG.nbBase * penG.tauxConnexionBase;
    out.co2Energie = tN.every(x => near(x.benefice_co2_kg, x.benefice_energie_kwh * 0.2 + (Math.max(x.stock_petits_connectes - p0, 0) + Math.max(x.stock_grands_connectes - g0, 0)) * 40 * 0.2)); // l.208 + l.210
    const pp = getParametresPAV(HYPOTHESES, resolveStrate(roanne)), tp = calculDechetsPAVAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.6}).trajectoire;
    out.co2PAV = tp.every(x => near(x.benefice_co2_kg, addOf(tp)(x) * (pp.ecoTournee * 1.55 + 20 * 0.2)) && near(x.bilan_net_co2_kg, x.benefice_co2_kg - x.impact_co2_kg)); // l.183 + l.184
    out.co2Bacs = rB.trajectoire.every(x => near(x.benefice_co2_kg, x.benefice_deplacement * 1.55 + addOf(rB.trajectoire)(x) / 2 * 2.15 * 0.25 * 0.35 * 0.4 * 1000)
                                         && near(x.bilan_net_co2_kg, x.benefice_co2_kg - x.impact_co2_kg));                                          // l.188 + l.187
    const A_ = getParametresArrosage(HYPOTHESES, resolveStrate(roanne)), tA = calculArrosageAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.6}).trajectoire;
    out.co2Arrosage = tA.every(x => near(x.benefice_co2_kg, x.volume_eau_economise_m3 * (0.5 * 0.079 + 0.06) + addOf(tA)(x) * A_.ecoJardinier / 300 * 20 * 0.2)); // l.187 + l.190
    out.co2Pos = tp[9].benefice_co2_kg > 0 && rB.trajectoire[9].benefice_co2_kg > 0 && tA[9].benefice_co2_kg > 0;

    // --- Émissions (énergie + CO2) : fabrication + pose + usage + recyclage + lignes ajoutées de l'inventaire Excel V1.2 ---
    const MIX = 0.079, EV = 0.2, USE_EP = 0.04 + 500 / 1500;
    out.emEau = tE.every(x => { const a = addOf(tE)(x);
      return near(x.impact_energie_kwh, x.nouveaux * (2.5 + 1.5) + a * 0.313)
          && near(x.impact_co2_kg, x.nouveaux * (8 + 0.75) + a * 0.313 * MIX + x.nouveaux * 0.5 * EV + a * 0.5 * EV * 0.2); });          // l.168-169, 172-174, 176, 177
    out.emEP = tP.every(x => { const a = addOf(tP)(x);
      return near(x.impact_energie_kwh, x.nouveaux * (22.5 + 4) + a * USE_EP)
          && near(x.impact_co2_kg, x.nouveaux * (11 + 5) + a * USE_EP * MIX + x.nouveaux * 4 * EV); });                                   // l.167-170, 176
    const sPet = tN.map(x => x.stock_petits_connectes), sGra = tN.map(x => x.stock_grands_connectes);
    out.emEnergie = tN.every((x, i) => { const nP = Math.max(sPet[i] - (i ? sPet[i-1] : p0), 0), nG = Math.max(sGra[i] - (i ? sGra[i-1] : g0), 0);
      const aP = Math.max(sPet[i] - p0, 0), aG = Math.max(sGra[i] - g0, 0);
      const e = aP * 372 + aG * 827 + (aP + aG) * 50 + nP * 255 + nG * 500;                                                               // l.206, 207 (serveurs), 211
      return near(x.impact_energie_kwh, e) && near(x.impact_co2_kg, nP * 680 + nG * 1360 + e * MIX + (nP + nG) * 10 * EV); });         // l.204, 205
    out.emPAV = tp.every(x => { const a = addOf(tp)(x);
      return near(x.impact_energie_kwh, x.nouveaux * (40 + 8) + a * 0.1)
          && near(x.impact_co2_kg, x.nouveaux * (6.5 + 1.5) + a * 0.1 * MIX + x.nouveaux * 50 * EV); });                                  // l.179-182, 185
    out.emBacs = rB.trajectoire.every(x => { const a = addOf(rB.trajectoire)(x);
      return near(x.impact_energie_kwh, x.nouveaux * (0.1 + 0.05) + a * 0.05)
          && near(x.impact_co2_kg, x.nouveaux * (0.025 + 0.01 + 0.5 * EV) + a * 0.05 * MIX); });                                          // l.183, 184 (pose), 186 (serveurs), 189
    const popR = Number(roanne.population), s0 = (popR * A_.m2ParHab * A_.partArrosee / 10000) * A_.sondesParHa;
    const sond = tA.map((x, i) => s0 * Math.pow(1 + A_.croissanceSurfaces, i + 1));
    out.emArrosage = tA.every((x, i) => { const a = addOf(tA)(x);
      const nObj = x.nouveaux + Math.max(sond[i] - (i ? sond[i-1] : s0), 0), aObj = a + Math.max(sond[i] - s0, 0);                         // vannes + sondes d'humidité
      return near(x.impact_energie_kwh, nObj * (15 + 3) + aObj * 0.1)
          && near(x.impact_co2_kg, nObj * (5 + 1) + aObj * 0.1 * MIX + nObj * 2 * EV); });                                                // l.182-185, 191
    // --- Arrosage : montée en charge de l'économie d'eau 1-(1-d)^(année-2024) (Excel l.39-42) ---
    out.rampeArrosage = tA.every(x => near(x.volume_eau_economise_m3, x.volume_eau_total_m3 * addOf(tA)(x) / x.parc_total * (1 - Math.pow(1 - A_.ecoEauNumerique, x.annee - 2024)))) && tA[9].volume_eau_economise_m3 > 3 * tA[0].volume_eau_economise_m3;

    // ===== Surveillance inondation : moteur =====
    const NAT = contexteNationalDepuisCommunes(COMMUNES_RAW.map(r => ({ population: r[6], vigilance: r[10] })));
    out.natOk = NAT.populationNationale === 68348939 && NAT.populationParVigilance[3] === 42821280
             && NAT.populationParVigilance[2] === 10611716 && NAT.populationParVigilance[1] === 14915943;
    const roanneV = COMMUNES.find(c => c.code_insee === "42187");
    out.roanneVigilance3 = roanneV.vigilance === 3;
    const ti = calculInondationAvecOptions(HYPOTHESES, [roanneV], { anneeDeploiement: 2030, national: NAT }).trajectoire;
    const dm = (y) => Number(roanneV.population) / NAT.populationNationale * 1e9 * 0.627 * Math.pow(1.025, y - 2025);
    out.inondDommages = ti.every(x => near(x.dommages_territoire, dm(x.annee)));                                          // part de pop. nationale × dommages du niveau × (1+2,5 %)^(année−2025)
    out.inondGains = ti.every(x => near(x.dommages_evites, x.annee >= 2030 ? dm(x.annee) * 0.5 * 0.1 : 0));               // × 50 % adressable × 10 % d'évitement net (= 5 %), dès 2030
    out.inondCouts = ti.every(x => {
      const rec = x.annee >= 2030 ? 40 * 400 + 2000 + 60000 + (0.12 * 450000 + 40000) : 0;                                 // transmission + serveurs + logiciels + E&M
      const one = x.annee === 2030 ? 450000 + 50000 : 0;                                                                   // CAPEX + conduite du changement
      return near(x.depenses_totales, rec + one) && near(x.capex, x.annee === 2030 ? 450000 : 0); });
    out.inondTotalCout = near(ti.reduce((a, x) => a + x.depenses_totales, 0), 500000 + 7 * 172000);
    out.inondEnv = ti.every(x => near(x.impact_co2_kg, (x.annee === 2030 ? 420 + 1000 + 50 : 0) + (x.annee >= 2030 ? 625 * 0.079 : 0))
      && near(x.impact_energie_kwh, (x.annee === 2030 ? 900 : 0) + (x.annee >= 2030 ? 625 : 0))
      && x.benefice_co2_kg === 0 && x.benefice_energie_kwh === 0 && near(x.bilan_net_co2_kg, -x.impact_co2_kg) && near(x.bilan_net_energie_kwh, -x.impact_energie_kwh));
    const i26 = calculInondationAvecOptions(HYPOTHESES, [roanneV], { anneeDeploiement: 2026, national: NAT });
    const i27 = calculInondationAvecOptions(HYPOTHESES, [roanneV], { anneeDeploiement: 2027, national: NAT });
    out.inond2026 = i26.anneeEffective === 2027 && i26.anneeDeploiement === 2026 && JSON.stringify(i26.trajectoire) === JSON.stringify(i27.trajectoire);
    const i36 = calculInondationAvecOptions(HYPOTHESES, [roanneV], { anneeDeploiement: 2036, national: NAT }).trajectoire;
    out.inond2036 = i36.slice(0, 9).every(x => x.depenses_totales === 0 && x.dommages_evites === 0) && near(i36[9].depenses_totales, 672000);
    const erreurDate = (v) => { try { calculInondationAvecOptions(HYPOTHESES, [roanneV], { anneeDeploiement: v, national: NAT }); return false; } catch (e) { return /obligatoire/.test(e.message); } };
    out.inondValidation = [null, undefined, "", 2025, 2037, 2030.5, "abc"].every(erreurDate);
    // territoire mixte : la population par niveau de vigilance est bien la somme de ses communes
    const dep89 = DEPARTEMENTS.find(d => d.code === "89");
    const r89 = calculInondationAvecOptions(HYPOTHESES, dep89.communes, { anneeDeploiement: 2030, national: NAT });
    const sumPop = (n) => dep89.communes.filter(c => c.vigilance === n).reduce((a, c) => a + Number(c.population), 0);
    out.inondMixte = [1, 2, 3].every(n => r89.trajectoire[0]['pop_vigilance_' + n] === sumPop(n)) && sumPop(1) + sumPop(2) + sumPop(3) === dep89.population;
    // base de répartition : 0 = spécification (population nationale) ; 1 = population du groupe (conserve le total national de 1 Md€)
    const franceAll = COMMUNES_RAW.map(r => ({ population: r[6], vigilance: r[10] }));
    const hyp1 = HYPOTHESES.map(r => (r.cas_usage === "Surveillance inondation" && r.hypothese.startsWith("Base de répartition")) ? { ...r, valeur: 1 } : r);
    const f1 = calculInondationAvecOptions(hyp1, franceAll, { anneeDeploiement: 2030, national: NAT }).trajectoire[0];
    out.inondConservation = near(f1.dommages_territoire, 1e9 * Math.pow(1.025, 2));
    const f0 = calculInondationAvecOptions(HYPOTHESES, franceAll, { anneeDeploiement: 2030, national: NAT }).trajectoire[0];
    const attendu0 = 1e9 * Math.pow(1.025, 2) * ([3, 2, 1].reduce((a, n) => a + { 3: 0.627, 2: 0.155, 1: 0.218 }[n] * NAT.populationParVigilance[n] / NAT.populationNationale, 0));
    out.inondSpec = near(f0.dommages_territoire, attendu0) && f0.dommages_territoire < f1.dommages_territoire;

    // --- Parcours complet : 6 cas, %2036 partout ---
    selectTerritory({ type:"commune", label:roanne.nom_standard, typeLabel:roanne.dep_nom, communes:[roanne], depNom:roanne.dep_nom });
    ['eau','ep','energie','pav','bacs','arrosage'].forEach(id => document.getElementById('cas-'+id).checked = true);
    syncCardState();
    ['input-eau-pct36','input-ep-pct36','input-energie-petit-pct36','input-energie-grand-pct36','input-pav-pct36','input-bacs-pct36','input-arrosage-pct36']
      .forEach(id => document.getElementById(id).value = '60');
    let alertMsg = ''; window.alert = (m) => { alertMsg = m; };
    document.getElementById('computeBtn').click();
    const r = document.getElementById('results').innerHTML;
    out.sixCasOk = r.length > 500 && alertMsg === '';
    out.mutualisation = r.includes('Silo vs mutualisé');
    out.envBlocks = (r.match(/Bilan environnemental net/g) || []).length === 6;
    out.years = r.includes('2027') && r.includes('2036');
    out.chartLabels = document.querySelectorAll('.chart-area svg text').length === 180;
    out.icons = document.querySelectorAll('.cas-card-icon').length === 7 && document.querySelectorAll('.cas-block-icon').length === 12;
    const COULEURS = { eau: '#29ABA3', ep: '#DE9111', energie: '#248ED5', pav: '#556879', bacs: '#556879', arrosage: '#29ABA3', inondation: '#EB7360' };
    out.couleursConfig = CAS_CONFIG.length === 7 && CAS_CONFIG.every(c => c.colorDark === COULEURS[c.id] && /^#[0-9A-F]{6}$/.test(c.colorLight));
    out.couleursGraphiques = ['eau', 'ep', 'energie', 'pav', 'bacs', 'arrosage'].every(id => document.querySelector('#results .cas-block.' + id + ' .chart-area svg rect[fill="' + COULEURS[id] + '"]') !== null);
    out.logos = !!document.querySelector('img.fnccr') && !document.querySelector('img.logo-mark') && !document.querySelector('header.top img[alt="Tactis"]');
    const logosEl = document.querySelector('header.top .logos'), bdt = document.querySelector('header.top .logo-chip img.bdt');
    out.logoBdt = !!logosEl && logosEl.children.length === 2 && logosEl.children[0].tagName === 'IMG' && logosEl.children[0].classList.contains('fnccr')
      && logosEl.children[1].classList.contains('logo-chip') && !!bdt && bdt.src.startsWith('data:image/png;base64,') && bdt.src.length > 20000
      && /Banque des Territoires/.test(bdt.alt) && document.querySelectorAll('header.top img').length === 2;      // FNCCR + Banque des Territoires, plus de logo Tactis

    // --- %2036 obligatoire + cohérence objets/connectés ---
    document.getElementById('input-eau-pct36').value = '';
    alertMsg = ''; document.getElementById('computeBtn').click();
    out.pctMandatory = alertMsg.includes('obligatoire');
    document.getElementById('input-eau-pct36').value = '60';
    document.getElementById('input-eau-objets').value = '100'; document.getElementById('input-eau-connectes').value = '200';
    alertMsg = ''; document.getElementById('computeBtn').click();
    out.connectedGtTotal = alertMsg.includes('dépasser');
    document.getElementById('input-eau-objets').value = ''; document.getElementById('input-eau-connectes').value = '';

    // --- Points de livraison utilisés à la place des ménages (Eau) ---
    const rE = calculEauAvecOptions(HYPOTHESES, [roanne], {pct2036: 0.6});
    out.pdl = Math.abs(rE.trajectoire[0].parc_total - roanne.nombre_points_livraison * 1.009) < 5;

    // --- Département + exclusion Auxerre ---
    const dep = DEPARTEMENTS.find(d => d.code === "89");
    const auxerre = dep.communes.find(c => c.nom_standard === "Auxerre");
    selectTerritory({ type:"departement", label:dep.nom, typeLabel:"Département 89", allCommunes: dep.communes, excludedCodes:new Set(), excludedEpciCodes:new Set() });
    const pop0 = SELECTED.population; SELECTED.excludedCodes.add(auxerre.code_insee); onExclusionChange();
    out.exclusion = SELECTED.communes.length === dep.communes.length - 1 && SELECTED.population < pop0;
    document.getElementById('cas-ep').checked = false; document.getElementById('cas-energie').checked = false;
    document.getElementById('cas-pav').checked = false; document.getElementById('cas-bacs').checked = false; document.getElementById('cas-arrosage').checked = false;
    syncCardState();
    document.getElementById('input-eau-pct36').value = '70';
    alertMsg = ''; document.getElementById('computeBtn').click();
    out.deptCalc = document.getElementById('results').innerHTML.length > 500 && alertMsg === '';

    // --- EPCI ---
    const epci = EPCIS.find(e => e.communes.length >= 3);
    selectTerritory({ type:"epci", label:epci.nom, typeLabel:"EPCI", allCommunes:epci.communes, excludedCodes:new Set() });
    alertMsg = ''; document.getElementById('computeBtn').click();
    out.epciCalc = document.getElementById('results').innerHTML.length > 500 && alertMsg === '';

    // ===== Surveillance inondation : interface =====
    out.inondCard = !!document.getElementById('cas-inondation') && document.querySelectorAll('.cas-card').length === 7;
    selectTerritory({ type:"commune", label:roanneV.nom_standard, typeLabel:roanneV.dep_nom, communes:[roanneV], depNom:roanneV.dep_nom });
    ['eau','ep','energie','pav','bacs','arrosage'].forEach(id => document.getElementById('cas-'+id).checked = false);
    document.getElementById('cas-inondation').checked = true; syncCardState();
    const selAnnee = document.getElementById('input-inondation-annee');
    out.inondPanel = !!selAnnee && selAnnee.options.length === 12 && selAnnee.options[1].value === '2026' && selAnnee.options[11].value === '2036';
    alertMsg = ''; document.getElementById('computeBtn').click();
    out.inondMandatory = /obligatoire/.test(alertMsg);
    selAnnee.value = '2030'; alertMsg = ''; document.getElementById('computeBtn').click();
    const rr = document.getElementById('results').innerHTML;
    out.inondNote5 = rr.includes("éviter 5,0 % des dommages chaque année dès sa mise en service (50,0 % de dommages adressables par une surveillance locale × 10,0 % d'évitement net)");
    out.inondLibelle = rr.includes("Coût de mise en place (1 système à l'échelle départementale)");
    out.couleurInondation = document.querySelector('#results .cas-block.inondation .chart-area svg rect[fill="#EB7360"]') !== null;
    const libellesMetriques = [...document.querySelectorAll('#results .cas-block.inondation .metrics-row.four .metric .label')].map(l => l.textContent);
    out.inondOrdre = libellesMetriques.length === 4 && libellesMetriques[0].startsWith("Coût de mise en place (1 système à l'échelle départementale)")
      && libellesMetriques[1].startsWith('Dommages potentiels du territoire') && libellesMetriques[2].startsWith('Dommages évités') && libellesMetriques[3] === 'Bilan net économique';
    out.inondRender = alertMsg === '' && ['Bilan net économique', 'Dommages potentiels du territoire', 'Dommages évités par la surveillance', 'Coût de mise en place',
      'Vigilance 3', 'Total du territoire', 'Bilan environnemental net'].every(k => rr.includes(k)) && !rr.includes('Silo vs mutualisé')
      && document.querySelectorAll('#results .cas-block.inondation .chart-area svg text').length === 30 && document.querySelectorAll('#results .metrics-row.four .metric').length === 4;
    // la date saisie survit au cochage d'une autre carte
    document.getElementById('cas-eau').checked = true; syncCardState();
    out.inondSaisieConservee = document.getElementById('input-inondation-annee').value === '2030';
    document.getElementById('input-eau-pct36').value = '60'; alertMsg = ''; document.getElementById('computeBtn').click();
    out.inondSansMut = alertMsg === '' && !document.getElementById('results').innerHTML.includes('Silo vs mutualisé');         // un seul cas IoT : pas de mutualisation
    document.getElementById('cas-ep').checked = true; syncCardState();
    document.getElementById('input-eau-pct36').value = '60'; document.getElementById('input-ep-pct36').value = '60';
    alertMsg = ''; document.getElementById('computeBtn').click();
    const r3 = document.getElementById('results').innerHTML; const mutTexte = r3.slice(r3.indexOf('Silo vs mutualisé'));
    out.inondHorsMut = alertMsg === '' && r3.includes('Silo vs mutualisé') && /entre 2 cas d'usage activés/.test(mutTexte) && !mutTexte.includes('Surveillance inondation');

    // ===== Sens de lecture des bilans net énergie et CO2 (+ rouge = consommation / émissions nettes ; − vert = économies nettes) =====
    const sp = (x) => x.replace(/[\u00a0\u202f ]/g, '');
    out.sensFormat = sp(fmtKWh(2500)) === '+2500kWh' && sp(fmtKWh(-2500)) === '−2500kWh' && sp(fmtKWh(-0)) === '0kWh' && sp(fmtKWh(0.3)) === '0kWh'
                  && sp(fmtTCO2(1.84)) === '+1,8tCO2e' && sp(fmtTCO2(-103.44)) === '−103,4tCO2e' && sp(fmtTCO2(-0.04)) === '0tCO2e';
    const envVals = (sel) => [...document.querySelectorAll(sel + ' .env-metrics .metric .value')].slice(0, 2).map(e => ({ txt: sp(e.textContent), pos: e.classList.contains('pos'), neg: e.classList.contains('neg') }));
    // inondation : on consomme sans rien économiser -> signe + et rouge (avant : signe − et rouge)
    selectTerritory({ type:"commune", label:roanneV.nom_standard, typeLabel:roanneV.dep_nom, communes:[roanneV], depNom:roanneV.dep_nom });
    ['eau','ep','energie','pav','bacs','arrosage'].forEach(id => document.getElementById('cas-'+id).checked = false);
    document.getElementById('cas-inondation').checked = true; syncCardState();
    document.getElementById('input-inondation-annee').value = '2030'; alertMsg = ''; document.getElementById('computeBtn').click();
    const ev = envVals('#results .cas-block.inondation');
    out.sensFlood = alertMsg === '' && ev.length === 2 && ev.every(v => v.txt.startsWith('+') && v.neg && !v.pos) && /tCO2e$/.test(ev[1].txt) && /kWh$/.test(ev[0].txt);
    // énergie des bâtiments : on économise plus qu'on ne consomme -> signe − et vert (avant : signe + et vert)
    document.getElementById('cas-inondation').checked = false; document.getElementById('cas-energie').checked = true; syncCardState();
    document.getElementById('input-energie-petit-pct36').value = '60'; document.getElementById('input-energie-grand-pct36').value = '60';
    alertMsg = ''; document.getElementById('computeBtn').click();
    const ee = envVals('#results .cas-block.energie');
    const trE = calculEnergieBatimentsAvecOptions(HYPOTHESES, [roanneV], { petit: { pct2036: 0.6 }, grand: { pct2036: 0.6 } }).trajectoire;
    const netE = trE.reduce((a, x) => a + x.bilan_net_energie_kwh, 0), netC = trE.reduce((a, x) => a + x.bilan_net_co2_kg, 0) / 1000;
    out.sensEconomies = alertMsg === '' && netE > 0 && netC > 0 && ee.every(v => v.txt.startsWith('−') && v.pos && !v.neg)
                      && sp(ee[0].txt) === sp(fmtKWh(-netE)) && sp(ee[1].txt) === sp(fmtTCO2(-netC));      // la valeur affichée est l'opposée du bilan (bénéfices − émissions)
    out.sensLegende = document.querySelectorAll('#results .env-legend').length === 1 && document.getElementById('results').innerHTML.includes('signe + (en rouge)') && document.getElementById('results').innerHTML.includes('signe − (en vert)');
    // bilan net économique : inchangé (positif = vert, négatif = rouge)
    const soldeEl = document.querySelector('#results .cas-block.energie .metrics-row .metric:nth-child(3) .value');
    const soldeAttendu = trE.reduce((a, x) => a + x.externalites_totales - x.depenses_totales, 0);
    out.sensEconomique = !!soldeEl && sp(soldeEl.textContent) === sp(fmtEUR(soldeAttendu)) && soldeEl.classList.contains(soldeAttendu >= 0 ? 'pos' : 'neg');

    // ===== Vocabulaire : « EPCI » remplacé par « intercommunalité » dans tout le texte affiché =====
    searchInput.value = 'pays basque'; searchInput.dispatchEvent(new window.Event('input'));
    const liste = document.getElementById('resultsList').textContent;
    out.vocabRecherche = liste.includes('Intercommunalité') && !liste.includes('EPCI');
    selectTerritory({ type:"departement", label:dep89.nom, typeLabel:"Département 89", allCommunes: dep89.communes, excludedCodes:new Set(), excludedEpciCodes:new Set() });
    const tv = texteVisible();
    out.vocabInterco = !/EPCI/.test(tv) && tv.includes('Exclure une intercommunalité entière') && tv.includes('exclure des communes ou intercommunalités')
      && tv.includes('Décochez une intercommunalité pour retirer') && tv.includes('Recherchez une commune, une intercommunalité ou un département');

    // ===== Silo vs mutualisé : détail des sommes par cas d'usage =====
    const resEau = calculEauAvecOptions(HYPOTHESES, [roanneV], { pct2036: 0.6 }), resEp = calculEPAvecOptions(HYPOTHESES, [roanneV], { pct2036: 0.6 });
    const resPav = calculDechetsPAVAvecOptions(HYPOTHESES, [roanneV], { pct2036: 0.6 });
    const mut3 = calculMutualisation([resEau, resEp, resPav], 1.0), mut2 = calculMutualisation([resEau, resEp], 1.0);
    const sumPc = (m, k) => m.parCas.reduce((a, c) => a + c[k], 0);
    out.mutSommes = [mut3, mut2].every(m => ['depensesSilo', 'depensesMutualise', 'economie', 'externalites', 'soldeSilo', 'soldeMutualise']
      .every(k => near(sumPc(m, k), { economie: m.economieTotale }[k] !== undefined ? m.economieTotale : m[k])));            // la somme des cas d'usage redonne exactement les totaux
    out.mutCoherence = mut3.parCas.length === 3 && mut3.parCas.every(c => near(c.depensesMutualise, c.depensesSilo - c.economie) && c.economie > 0
      && c.depensesMutualise < c.depensesSilo && near(c.soldeSilo, c.externalites - c.depensesSilo) && near(c.soldeMutualise, c.externalites - c.depensesMutualise));
    selectTerritory({ type:"commune", label:roanneV.nom_standard, typeLabel:roanneV.dep_nom, communes:[roanneV], depNom:roanneV.dep_nom });
    ['eau','ep','energie','pav','bacs','arrosage','inondation'].forEach(id => document.getElementById('cas-'+id).checked = ['eau','ep','pav'].includes(id));
    syncCardState();
    ['eau','ep','pav'].forEach(id => { document.getElementById('input-'+id+'-pct36').value = '60'; });
    alertMsg = ''; document.getElementById('computeBtn').click();
    const lignes = [...document.querySelectorAll('#results .mut-table tbody tr')];
    const nom = (id) => CAS_CONFIG.find(c => c.id === id).name;
    const cel = (i, k) => sp(lignes[i].cells[k].textContent);
    const entetesTable = [...document.querySelectorAll('#results .mut-table thead th')].map(th => th.textContent.trim());
    out.mutTable = alertMsg === '' && lignes.length === 4 && lignes[3].classList.contains('total') && lignes.every(l => l.cells.length === 4)
      && entetesTable.join('|') === ["Cas d'usage", 'Dépenses en silo', 'Dépenses mutualisées', 'Économie de mutualisation'].join('|')
      && [0, 1, 2].every(i => lignes[i].cells[0].textContent === [nom('eau'), nom('ep'), nom('pav')][i])
      && [0, 1, 2].every(i => cel(i, 1) === sp(fmtEUR(mut3.parCas[i].depensesSilo)) && cel(i, 2) === sp(fmtEUR(mut3.parCas[i].depensesMutualise)) && cel(i, 3) === sp(fmtEUR(mut3.parCas[i].economie)))
      && cel(3, 1) === sp(fmtEUR(mut3.depensesSilo)) && cel(3, 2) === sp(fmtEUR(mut3.depensesMutualise)) && cel(3, 3) === sp(fmtEUR(mut3.economieTotale));
    const tableTexte = document.querySelector('#results .mut-table').textContent;
    out.mutSansBeneficesNiSolde = !/Bénéfices|Solde/.test(tableTexte);                                                          // plus de colonnes bénéfices ni solde dans le détail
    out.mutEcoMiseEnAvant = lignes.every(l => l.cells[3].classList.contains('eco')) && document.querySelector('#results .mut-table thead th.eco') !== null;
    const entetes = [...document.querySelectorAll('#results .mut-col .depenses')].map(e => sp(e.textContent));
    out.mutEntete = entetes.length === 2 && entetes[0] === cel(3, 1) && entetes[1] === cel(3, 2);                              // le total du tableau = les gros chiffres de la comparaison
    const bandeau = document.querySelector('#results .mut-callout .txt').textContent.trim();
    out.mutPhrase = !bandeau.toLowerCase().includes('argument de mutualisation') && !bandeau.includes('—') && bandeau.endsWith("plutôt qu'en les déployant séparément.");
    out.mutEcoTotal = sp(document.querySelector('#results .mut-callout .big').textContent) === cel(3, 3);                      // économie totale du tableau = bandeau « économisés »

    // ===== Ajuster la sélection : intercommunalité -> liste à cocher de ses communes =====
    const epciT = EPCIS.find(e => e.communes.length >= 8 && e.communes.length <= 20);
    selectTerritory({ type:"epci", label:epciT.nom, typeLabel:"Intercommunalité", allCommunes: epciT.communes, excludedCodes:new Set() });
    const listeC = document.getElementById('communeToggleList'), panneauTxt = document.getElementById('adjustPanel').textContent;
    out.adjListe = !!listeC && listeC.querySelectorAll('input[type=checkbox]').length === epciT.communes.length && [...listeC.querySelectorAll('input')].every(i => i.checked)
      && !document.getElementById('excludeSearch') && !document.getElementById('excludedChips')
      && panneauTxt.includes('Exclure des communes') && panneauTxt.includes('Décochez une commune pour la retirer du calcul') && !panneauTxt.includes('Exclure une commune')
      && document.getElementById('adjustToggle').textContent.includes('exclure des communes') && !document.getElementById('adjustToggle').textContent.includes('intercommunalités');
    const nomsListe = [...listeC.querySelectorAll('label')].map(l => l.textContent);
    out.adjTri = nomsListe.join('|') === nomsListe.slice().sort((a, b) => a.localeCompare(b, 'fr')).join('|') && nomsListe.length === epciT.communes.length;
    const c0 = epciT.communes[0], popAvant = SELECTED.population, cbx = document.getElementById('communeTgl-' + c0.code_insee);
    cbx.checked = false; cbx.dispatchEvent(new window.Event('change'));
    out.adjExclusion = SELECTED.communes.length === epciT.communes.length - 1 && !SELECTED.communes.some(c => c.code_insee === c0.code_insee) && SELECTED.excludedCodes.has(c0.code_insee)
      && SELECTED.population === popAvant - Number(c0.population) && document.getElementById('chipName').textContent.includes('sur ' + epciT.communes.length)
      && !document.getElementById('results').classList.contains('show');
    // le calcul porte bien sur les communes restantes
    ['eau','ep','energie','pav','bacs','arrosage','inondation'].forEach(id => document.getElementById('cas-'+id).checked = id === 'eau'); syncCardState();
    document.getElementById('input-eau-pct36').value = '60'; alertMsg = ''; document.getElementById('computeBtn').click();
    const dEau = calculEauAvecOptions(HYPOTHESES, SELECTED.communes, { pct2036: 0.6 }).trajectoire.reduce((a, x) => a + x.depenses_totales, 0);
    const dEauTout = calculEauAvecOptions(HYPOTHESES, epciT.communes, { pct2036: 0.6 }).trajectoire.reduce((a, x) => a + x.depenses_totales, 0);
    out.adjCalcul = alertMsg === '' && document.getElementById('results').innerHTML.includes(fmtInt(SELECTED.population)) && dEau < dEauTout
      && sp(document.querySelector('#results .cas-block.eau .metrics-row .metric .value').textContent) === sp(fmtEUR(dEau));
    // on peut recocher
    cbx.checked = true; cbx.dispatchEvent(new window.Event('change'));
    out.adjRecochage = SELECTED.communes.length === epciT.communes.length && SELECTED.population === popAvant && SELECTED.excludedCodes.size === 0;
    // garde-fou : la dernière commune ne peut pas être exclue
    alertMsg = '';
    epciT.communes.slice(0, -1).forEach(c => { const e = document.getElementById('communeTgl-' + c.code_insee); e.checked = false; e.dispatchEvent(new window.Event('change')); });
    const derniere = document.getElementById('communeTgl-' + epciT.communes[epciT.communes.length - 1].code_insee); derniere.checked = false; derniere.dispatchEvent(new window.Event('change'));
    out.adjGardeFou = SELECTED.communes.length === 1 && derniere.checked === true && /Au moins une commune/.test(alertMsg);
    // département : inchangé (liste des intercommunalités + recherche de commune, pas de liste de communes)
    selectTerritory({ type:"departement", label:dep89.nom, typeLabel:"Département 89", allCommunes: dep89.communes, excludedCodes:new Set(), excludedEpciCodes:new Set() });
    out.adjDepartement = !!document.getElementById('epciToggleList') && !!document.getElementById('excludeSearch') && !document.getElementById('communeToggleList')
      && document.getElementById('adjustPanel').textContent.includes('Exclure une intercommunalité entière') && document.getElementById('adjustToggle').textContent.includes('ou intercommunalités');

    out.ok = true; return out;
  } catch(e) { return {ok:false, error:e.message, stack:e.stack}; }
})();
</script>`;
html = html.replace('</body>', testScript + '</body>');
const dom = new JSDOM(html, {runScripts:'dangerously', resources:'usable', url:'http://localhost/'});
dom.window.addEventListener('load', () => {
  const t = dom.window.__TEST__;
  console.log(JSON.stringify(t, null, 1));
  const v = t.v12 || {};
  const exp = { eauEco:0.05, eauBase:0.28, epCapexMetro:650, pavCapexRural:260, bacsConduite:20, bacsRefonte:0.5, arrCapexVanne:500, arrJardinier:36 };
  const v12ok = Object.keys(exp).every(k => Math.abs(v[k] - exp[k]) < 1e-12);
  const pass = t.ok && t.nbHyp === hypFile.length && t.nbHyp === 363 && v12ok && t.bacsKmFactor && t.co2Eau && t.co2EP && t.co2Energie && t.co2PAV && t.co2Bacs && t.co2Arrosage && t.co2Pos && t.emEau && t.emEP && t.emEnergie && t.emPAV && t.emBacs && t.emArrosage && t.rampeArrosage && t.addTrans && t.addBenef && t.capexIncrement && t.noAddNoFlows && t.indicatorsTotal && t.sixCasOk && t.mutualisation && t.envBlocks
    && t.years && t.chartLabels && t.icons && t.logos && t.logoBdt && t.pctMandatory && t.connectedGtTotal && t.pdl && t.exclusion && t.deptCalc && t.epciCalc
    && t.natOk && t.roanneVigilance3 && t.inondDommages && t.inondGains && t.inondCouts && t.inondTotalCout && t.inondEnv && t.inond2026 && t.inond2036
    && t.inondValidation && t.inondMixte && t.inondConservation && t.inondSpec && t.inondCard && t.inondPanel && t.inondMandatory && t.inondRender
    && t.inondSaisieConservee && t.inondSansMut && t.inondHorsMut && t.inondNote5 && t.inondLibelle && t.sensFormat && t.sensFlood && t.sensEconomies && t.sensLegende && t.sensEconomique
    && t.defautsDecoches && t.titre && t.sansBandeau && t.vocabRecherche && t.vocabInterco && t.mutSommes && t.mutCoherence && t.mutTable && t.mutEntete && t.mutSansBeneficesNiSolde && t.mutEcoMiseEnAvant && t.mutEcoTotal && t.mutPhrase && t.couleursConfig && t.couleursGraphiques && t.couleurInondation
    && t.inondOrdre && t.adjListe && t.adjTri && t.adjExclusion && t.adjCalcul && t.adjRecochage && t.adjGardeFou && t.adjDepartement;
  console.log(pass ? "\n>>> TOUS LES TESTS PASSENT" : "\n>>> ÉCHEC");
  process.exit(pass ? 0 : 1);
});
setTimeout(()=>{console.error('TIMEOUT');process.exit(1);}, 30000);
