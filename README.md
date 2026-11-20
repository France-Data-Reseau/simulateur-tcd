# Mon Territoire Connecté et Durable (ex « Mon territoire, mes données ») — sources éditables

Variante du simulateur territorial permettant à l'utilisateur de saisir ses
propres données de parc (nombre d'objets, nombre d'objets connectés, cible de
connexion à 10 ans) pour chacun des 6 cas d'usage, plutôt que de dépendre
uniquement de l'estimation automatique dérivée de la population.

## Organisation du dépôt

| Dossier / fichier | Contenu |
|---|---|
| `src/` | Sources de la page : `template.html` (gabarit HTML et CSS), `app.js` (interface), `engine.js` (moteur de calcul), `fonts/` (polices), `images/` (logos, icône d'onglet) |
| `data/` | Hypothèses du modèle (`hypotheses_mon_territoire.csv` → `hypotheses.json`) et référentiel des communes (`communes-france-2026.csv` → `communes.json`) |
| `public/` | **Page générée** (`index.html`) : c'est le seul dossier à publier. Ne pas la modifier à la main, elle est écrasée à chaque `build.py` |
| `tests/` | Tests de non-régression (moteur, interface, surveillance inondation) |
| `.github/workflows/pages.yml` | Construction, tests et déploiement sur GitHub Pages |
| `build.py` | Assemble `src/` et `data/` en une page unique `public/index.html` |
| `moteur_calcul.py` | Copie jumelle du moteur en Python, utilisable en ligne de commande |
| `requirements.txt` / `package.json` | Dépendances Python et Node.js, nécessaires seulement pour le moteur en ligne de commande et les tests |

## Régénérer la page

```bash
python3 build.py      # ou : npm run build
```

Produit `public/index.html` (anciennement `mon_territoire_donnees.html` à la racine) — fichier autonome (~4,8 Mo :
communes, logos et polices embarqués, aucune ressource externe, fonctionne hors ligne). `build.py` n'utilise que la
bibliothèque standard de Python (3.8+) : aucune installation n'est nécessaire pour régénérer la page.

## Publication

Le workflow [GitHub Actions](.github/workflows/pages.yml) régénère `public/index.html`, exécute les tests et
publie uniquement le contenu de `public/` sur GitHub Pages. Il ne publie que si les tests réussissent :

- chaque pull request vers `main` est construite et testée, sans déploiement ;
- chaque push sur `main` déclenche la construction, les tests et la publication ;
- un lancement manuel est possible depuis l'onglet **Actions**. Il ne publie que si la branche `main` est
  sélectionnée ; sur une autre branche, il exécute uniquement la construction et les tests.

Pour activer la publication, un administrateur du dépôt doit :

1. Intégrer le workflow à la branche `main`.
2. Dans **Settings > Pages > Build and deployment**, choisir **GitHub Actions** comme source.
3. Si la première exécution a eu lieu avant l'activation de Pages, relancer le workflow depuis **Actions**,
   en sélectionnant `main`.

L'adresse du site apparaît dans **Settings > Pages** et dans le résultat du déploiement. Sans domaine personnalisé,
elle devrait être `https://france-data-reseau.github.io/simulateur-tcd/`.

## Logique de saisie (par cas d'usage, par territoire)

**Le % de connexion cible à 2036 est obligatoire pour chaque cas d'usage activé.**
Sans lui, aucun calcul n'est possible pour ce cas d'usage (message d'erreur
explicite). Pour Énergie des bâtiments, les deux sous-types (< 500 m² et
> 500 m²) exigent chacun leur propre % cible.

| Ce que l'utilisateur renseigne | Comportement |
|---|---|
| % cible 2036 seul | Le parc reste dérivé de la population (comme l'ancien mode automatique), mais le taux de connexion suit une trajectoire **linéaire** depuis le taux 2026 du modèle national jusqu'à la cible saisie, au lieu de la courbe de croissance composée par défaut |
| Nombre d'objets 2026 seul + % cible 2036 | Ce nombre devient le parc de référence 2026 ; le taux de connexion 2026 est repris du modèle (par strate) ; interpolation linéaire jusqu'à la cible |
| Nombre d'objets 2026 + objets connectés 2026 + % cible 2036 | Les deux premiers ancrent l'année de référence ; même interpolation linéaire ensuite |

**Validation** : le nombre d'objets connectés ne peut jamais dépasser le
nombre total d'objets — le calcul est bloqué avec un message d'erreur clair
si c'est le cas.

**Attention** : aucun cas d'usage n'est coché par défaut dans l'interface (le bouton
« Calculer » reste désactivé tant qu'aucun n'est coché). Pour chaque cas d'usage coché,
le % cible 2036 est obligatoire : s'il n'est pas renseigné, il bloque le calcul.

**Échelle EPCI/département** : quand la saisie s'applique à un territoire de
plusieurs communes, les paramètres du modèle (coûts, taux) sont **moyennés,
pondérés par le parc par défaut de chaque commune** — c'est l'approximation
retenue pour respecter au mieux la logique "hypothèses selon le type de
commune" à une échelle agrégée. Pour l'Énergie des bâtiments, les deux
sous-types (< 500 m² et > 500 m²) sont saisis et calculés indépendamment.

## Version des hypothèses : modèle Excel V1.2

Les hypothèses (`data/hypotheses_mon_territoire.csv` → `data/hypotheses.json`) reprennent le
modèle national **3e_OTCD_extrapolation_V1_2** (mise à jour depuis V0_8). Chaque valeur
modifiée porte dans la colonne `note_source` la mention « MàJ V1.2 (avant : X) » avec la
justification issue de l'Excel — `grep "MàJ V1.2" data/hypotheses_mon_territoire.csv` liste
les 39 valeurs changées.

| Cas d'usage | Hypothèses mises à jour |
|---|---|
| Eau | économie d'eau 3,5 → 5 %/an ; taux de base 25 → 28 % (voir ci-dessous) ; transmission 2-30k 4,5 € et <2k 5 € ; logiciel 2-30k 2,5 € et <2k 4 € ; poids des strates et part réseau (informatifs) |
| Éclairage public | économie numérique 1,5 → 1 %/an ; CAPEX armoire 650 / 700 / 750 / 750 € (au lieu de 700 / 750 / 850 / 1 100) |
| Énergie des bâtiments | économie monitoring IoT (petits bâtiments) 8 → 10 % |
| PAV | CAPEX sonde 150 / 180 / 220 / 260 € ; logiciel 25 / 30 / 35 / 40 €/an ; E&M 12 / 14 / 15 / 16 % |
| Bacs individuels | conduite du changement 15 → 20 €/bac ; **nouvelle hypothèse** : part des collectivités refondant leur schéma de collecte = 50 % (le gain kilométrique est multiplié par ce facteur) |
| Arrosage | économie d'eau 35 → 40 % à terme (≈4,2 %/an) ; économie jardinier 20 / 30 / 36 / 48 €/vanne/an ; CAPEX vanne 500 / 550 / 600 / 650 € |

### CO₂ évité — toutes les lignes « Bénéfice » de l'inventaire environnemental de l'Excel V1.2

Calculé sur le parc connecté ajouté ; réconcilié avec les valeurs de l'Excel (mêmes effectifs en entrée → mêmes tCO₂e).
Les constantes sont des lignes du CSV (catégorie « Empreinte environnementale »).

| Cas d'usage | Ligne Excel | CO₂ évité |
|---|---|---|
| Eau | l.171 | eau économisée × 0,06 kgCO₂e/m³ (traitement) |
| Eau | l.175 | relève à distance : 0,5 km/compteur/an × 0,2 kgCO₂e/km |
| Éclairage public | l.171 | énergie économisée × 0,079 kgCO₂e/kWh |
| Éclairage public | l.175 | maintenance évitée : 16 km/armoire/an (4 × 4 km) × 0,2 kgCO₂e/km |
| Énergie des bâtiments | l.208 | énergie économisée × 0,2 kgCO₂e/kWh |
| Énergie des bâtiments | l.210 | maintenance évitée : 40 km/bâtiment/an (4 × 10 km) × 0,2 kgCO₂e/km |
| PAV | l.183 | carburant des tournées évité ÷ 2 €/l × 3,1 kgCO₂e/l |
| PAV | l.184 | maintenance évitée : 20 km/sonde/an (2 × 10 km) × 0,2 kgCO₂e/km |
| Bacs individuels | l.188 | carburant des km de collecte évités (× 50 % de collectivités refondant leur schéma) ÷ 2 €/l × 3,1 kgCO₂e/l |
| Bacs individuels | l.187 | tonnages d'OMR évités : bacs ÷ 2 × 2,15 hab/ménage × 0,25 t/hab/an × 35 % × 0,40 tCO₂e/t |
| Arrosage | l.187 | eau non prélevée × (0,5 kWh/m³ × 0,079 + 0,06 kgCO₂e/m³) — pompage **et** traitement |
| Arrosage | l.190 | jardiniers évités : économie (€) ÷ 300 €/jour × 20 km/jour × 0,2 kgCO₂e/km |

Corrections apportées lors de cet audit : l'énergie de pompage × mix (Arrosage l.187) n'était pas comptée (≈ 40 % du
CO₂ évité du cas d'usage), et les déplacements de relève / maintenance / jardiniers évités étaient absents.

### Émissions de CO₂ et d'énergie : toutes les lignes de l'inventaire Excel V1.2 sont intégrées

Pour chaque cas d'usage, les émissions suivent les cinq étapes de l'inventaire de l'Excel :

| Étape | Eau | Éclairage public | Énergie bât. | PAV | Bacs | Arrosage |
|---|---|---|---|---|---|---|
| Fabrication | l.168 | l.167 | l.204 | l.179 | l.183 | l.182 (vannes **et sondes**) |
| Pose | l.169 | l.168 | l.205 | l.180 | l.184 | l.183 (vannes et sondes) |
| Usage (équipements + serveurs) | l.172-174 | l.169-170 | l.206 + **l.207 (serveurs)** | l.181-182 | **l.186 (serveurs)** | l.184-185 (vannes et sondes) |
| Maintenance corrective | **l.176** (20 % des km de relève évités) | — | — | — | — | — |
| Recyclage en fin de vie | **l.177** | **l.176** | **l.211** | **l.185** | **l.189** | **l.191** (vannes et sondes) |

En gras : lignes ajoutées lors de cette version. Les constantes sont des lignes du CSV (catégorie « Empreinte environnementale »).
**Sondes d'humidité (Arrosage)** : comptées comme objets connectés dans l'inventaire environnemental (comme l'Excel), leur parc
suit la surface arrosée (densité 1 / 1 / 0,7 / 0,5 sonde/ha × croissance des surfaces 1 / 1 / 3 / 5 %/an). Leurs **coûts** (CAPEX, logiciel)
ne sont en revanche pas modélisés : le modèle économique de l'Arrosage reste centré sur les vannes.

**Réconciliation avec l'Excel** (mêmes effectifs d'objets en entrée, année 2026) :

- émissions d'énergie (kWh) et de CO₂ (kgCO₂e) des six cas d'usage : identiques à l'Excel (écart < 10⁻¹⁴) ;
- bilan net PAV et Bacs (bénéfices + émissions) : identique à l'Excel ;
- Eau : écart de 0,1 % sur le bilan net CO₂ ; Énergie des bâtiments : 3,7 % ; Éclairage public : environ 4,5 % sur le CO₂ évité
  (le modèle utilise une consommation moyenne par point lumineux, l'Excel la répartit par strate).

**Convention de signe (affichage)** : alignée sur l'Excel, dont le « BILAN NET » compte les émissions en positif. Dans l'interface (et dans la sortie texte du moteur Python),
les bilans net **énergie et CO₂** s'affichent avec un signe **+ en rouge** quand on consomme ou émet plus qu'on n'économise, et **− en vert** pour des économies nettes ; une ligne de lecture
le rappelle sous le titre du bloc. Seul l'**affichage** est inversé : les colonnes de données `bilan_net_energie_kwh` et `bilan_net_co2_kg` (trajectoires, export CSV) restent « bénéfices − émissions »
(positif = favorable). Le bilan net économique est inchangé (bénéfices − dépenses ; positif en vert, négatif en rouge).

**Arrosage — montée en charge de l'économie d'eau** (corrigé) : l'Excel applique `1 − (1 − d)^(année − 2024)` à l'économie d'eau
(≈ 8 % en 2026, 40 % à terme) ; le moteur appliquait jusqu'ici le taux annuel `d` (4,2 %) de façon constante, ce qui sous-estimait
l'eau économisée (× 2 en 2026, jusqu'à × 10 en 2036) et les bénéfices € / kWh / CO₂ associés. Reconstitué à l'identique (574 516 m³ en 2027).

## Méthode : coûts et bénéfices sur le parc connecté AJOUTÉ

Conformément à l'Excel V1.2, seul le parc connecté **ajouté depuis l'année de référence** (2026)
génère des coûts récurrents et des bénéfices. Soit `stockAdd = max(stock connecté de l'année − stock
connecté de référence, 0)` :

| Calculé sur `stockAdd` (parc ajouté) | Reste sur l'incrément annuel | Reste sur le parc connecté total |
|---|---|---|
| transmission, logiciels, exploitation-maintenance, tous les bénéfices (€, kWh, m³, CO₂), consommation des équipements | CAPEX, conduite du changement, fabrication des équipements | hébergement/serveurs (plateforme partagée, comme dans l'Excel V1.2), indicateurs marché (parc, parc connecté, volumes) |

Conséquence : si la cible 2036 est inférieure au taux de départ, aucun parc n'est ajouté → ni coûts
récurrents, ni bénéfices. Les résultats sont nettement plus prudents que dans les versions
précédentes (−20 à −60 % selon les postes). Le bandeau des résultats le rappelle.

Décisions retenues pour la version V1.2 :

- **Taux de base Eau : 28 %** (valeur codée en dur dans l'onglet Eau de l'Excel, G7 ; PILOTAGE affiche
  encore 25 % mais n'est plus relié à ce calcul).
- **Mutualisation : grille de référence par nombre de cas d'usage conservée** (l'Excel V1.2 fixe
  l'abattement réseau à 30 % de manière uniforme ; non repris).
- **Additionnalité appliquée de façon uniforme** : l'Excel V1.2 n'est pas homogène sur tous les onglets
  (par ex. transmission PAV et Bacs sur l'incrément annuel seulement) ; la règle ci-dessus est
  appliquée à l'identique aux six cas d'usage plutôt que de recopier ces écarts.

## Horizon temporel

2026 = année de référence (données saisies ou dérivées). La trajectoire
produite couvre **2027-2036** (10 ans), à la différence du précédent outil
"Mon territoire local" qui couvrait 2026-2035.

## Où modifier le texte

| Fichier | Contient |
|---|---|
| `src/template.html` | Texte statique : titre, sous-titre, description de la page (balise `<meta name="description">`, affichée par les moteurs de recherche), intitulés des étapes, footer |
| `src/app.js` | Texte dynamique : libellés des indicateurs marché, texte de mutualisation. `CAS_CONFIG` en tête de fichier définit le nom, la description, les libellés de saisie **et le pictogramme** de chaque cas d'usage |
| `data/hypotheses_mon_territoire.csv` | Les valeurs numériques du modèle — éditable dans Excel |
| `data/communes-france-2026.csv` | Le référentiel des communes |
| `src/images/logo_fnccr.png` / `src/images/logo_banque_des_territoires.png` | Les deux logos affichés en en-tête. Le logo Banque des Territoires (rouge et brun, fond transparent) est posé sur un cartouche blanc, à côté du logo FNCCR, pour conserver ses couleurs d'origine sur le bandeau bleu. Pour les remplacer : même nom de fichier, puis `python3 build.py`. `logo_tactis.png` n'est plus affiché ni intégré (fichier conservé, inutilisé) ; les mentions textuelles « FNCCR × Tactis » de la note de bas de page et du pied du PDF subsistent (la phrase d'accroche du bandeau d'en-tête, qui en contenait une, a été retirée) |
| `src/images/favicon.png` | L'icône d'onglet du navigateur (PNG 64 × 64 tiré du logo FNCCR), embarquée dans la page |
| `src/fonts/` | Les polices (voir « Polices » ci-dessous) |

## Couleurs et pictogrammes par cas d'usage

Palette FNCCR, une couleur par cas d'usage : Télérelève de l'eau et Pilotage de l'arrosage `#29ABA3`, Éclairage public `#DE9111`, Énergie des bâtiments `#248ED5`,
Points d'apport volontaire et Bacs individuels `#556879`, Surveillance inondation `#EB7360`. Elle est appliquée à quatre endroits :
les variables CSS `--cas-<cas>-600` (bordure de la carte cochée), `-700` (texte de la pastille, assombri pour garder un contraste d'au moins 4,5:1) et `-100` (fond clair) dans `src/template.html` ;
`CAS_CONFIG[i].colorDark` (barres de dépenses des graphiques) et `colorLight` (barres de bénéfices, teinte éclaircie) dans `src/app.js` ; et les pictogrammes. Les variables `--eau-*` et
`--lum-*`, elles, restent réservées à l'interface générale (focus des champs, liens, bouton PDF) et ne suivent pas la palette. `python3 tests/test_interface.py` contrôle cette cohérence.

Chaque cas d'usage a son pictogramme (gouttes d'eau, lampadaire, immeubles,
bacs de tri, poubelle, arrosoir, station de mesure et maison inondée), extrait du gabarit FNCCR fourni (sauf l'inondation, dessinée dans le même style) puis
recoloré en une seule couleur, celle du cas d'usage (`CAS_CONFIG[i].colorDark`).
Ils apparaissent sur les cartes de sélection, l'en-tête de chaque bloc de
résultats et l'en-tête de chaque panneau de saisie manuelle.

Les images sont encodées en base64 directement dans la constante `CAS_ICONS`
en tête de `src/app.js` (pas de fichier séparé à gérer). Pour changer un
pictogramme : remplacez l'image source, recolorez-la si besoin dans la teinte
du cas d'usage concerné, ré-encodez-la (`base64 -w0 fichier.png`), et
remplacez la valeur correspondante dans `CAS_ICONS`.

## Polices : hébergées localement, sans Google Fonts

L'interface utilise les polices **Inter** (texte) et **Space Grotesk** (titres et chiffres). Elles sont livrées avec le
dépôt (`src/fonts/`) et intégrées en base64 dans la page par `build.py`, au lieu d'être chargées depuis Google Fonts
comme auparavant. Pourquoi :

- **Protection des données personnelles (RGPD)** : charger une police depuis `fonts.googleapis.com` transmet à Google
  l'adresse IP de chaque visiteur, sans son consentement. Ce transfert a été jugé contraire au RGPD (tribunal régional de
  Munich, 20 janvier 2022). Pour un outil public, mieux vaut ne transmettre aucune donnée de visite à un tiers.
- **Fonctionnement hors ligne** : la page reste un fichier unique et autonome, qui s'affiche à l'identique une fois
  téléchargée, sur un poste sans Internet ou derrière un pare-feu qui bloque les services Google.
- **Performance et stabilité** : aucune connexion à des domaines tiers au chargement (ni requête DNS ni négociation TLS
  supplémentaires ; les navigateurs ne partagent de toute façon plus leur cache de polices entre sites), et aucune
  dépendance à la disponibilité ou aux évolutions d'un service externe.

Détails techniques :

- Les fichiers sont les **polices variables** servies par Google Fonts (toutes les graisses dans un seul fichier),
  limitées au **sous-ensemble « latin »** (≈ 70 Ko au total), qui couvre tout le français (accents, œ, « », €, tirets…).
  Les rares caractères hors de ce sous-ensemble (« ᵉ » de « 3ᵉ édition », « → », « ₂ » de CO₂) s'affichent avec la police
  du système, comme c'était déjà le cas pour « → » et « ₂ ».
- Les déclarations `@font-face` sont dans `src/fonts/fonts.css` ; `build.py` y remplace chaque fichier `.woff2` par son contenu en base64.
- Licence des polices : SIL Open Font License 1.1 (`src/fonts/OFL-Inter.txt`, `src/fonts/OFL-SpaceGrotesk.txt`), qui en autorise la redistribution.
- `python3 tests/test_interface.py` vérifie que la page publiée ne charge aucune ressource externe.

Pour mettre à jour une police : remplacez le fichier `.woff2` (même nom) dans `src/fonts/`, puis relancez `python3 build.py`.

## Graphique annuel (dépenses vs bénéfices)

Le graphique par cas d'usage (`renderYearChart` dans `src/app.js`) affiche une
étiquette de valeur par barre et par année — au format compact (« 296k€ »,
« 1,2M€ ») pour rester lisible sur 10 barres. La fonction `fmtCompact()`
juste au-dessus gère ce formatage si vous voulez changer le seuil M€/k€ ou
le nombre de décimales.

## Variables « risque inondation » et « vigilance » du référentiel des communes

Trois colonnes ont été ajoutées à la fin de `data/communes-france-2026.csv` :

- **`risque inondation`** : **1** si la commune appartient à un EPCI dont **au moins une commune** est (au moins en partie) dans une zone à très haut
  risque d'inondation (territoires à risque important d'inondation, TRI), **0** sinon. **8 765 communes sur 34 868 (25,1 %) valent 1**
  (62,7 % de la population). Les 4 communes « sans EPCI » (code `ZZZZZZZZZ` : Bréhat, Sein, Ouessant, Yeu) gardent leur propre valeur.
- **`risque inondation commune`** : l'indicateur au niveau de la seule commune (**2 602 communes**, 7,5 %), conservé pour mémoire.
- **`vigilance`** : niveau **1, 2 ou 3** pour toutes les communes (jamais vide), selon trois règles qui s'appliquent à la commune **et** à son EPCI ;
  quand plusieurs règles concernent la même commune (via son EPCI), le niveau le plus élevé l'emporte (3 > 2 > 1) :
  1. une commune fait partie d'un TRI → elle et toutes les communes de son EPCI : **vigilance 3** (8 765 communes, 42,8 millions d'habitants, 62,7 %) ;
  2. une commune fait partie d'un département « cœur » mais pas d'un TRI → elle et toutes les communes de son EPCI : **vigilance 2**
     (9 338 communes, 10,6 millions d'habitants, 15,5 % ; dont 357 communes hors département cœur, rattachées par leur EPCI) ;
  3. ni TRI ni département « cœur » → **vigilance 1** (16 765 communes, 14,9 millions d'habitants, 21,8 %).

  Les 4 communes « sans EPCI » (code `ZZZZZZZZZ`) sont traitées isolément. « Fait partie d'un TRI » s'entend au niveau de la commune (`risque inondation commune` = 1).
  Départements « cœur » (44) : Arc méditerranéen (06, 11, 13, 2A, 2B, 30, 34, 66, 83), bassin de la Seine (10, 21, 27, 75, 76, 77, 78, 91, 92, 93, 94, 95),
  bassin de la Loire (03, 07, 18, 37, 41, 42, 43, 44, 45, 49, 58, 71), bassin du Rhône (01, 07, 13, 26, 30, 38, 42, 69, 73, 74, 84), bassin de la Garonne (31, 33, 47, 82).
  Détail par département : `risque_inondation/vigilance_par_departement.csv` (non inclus dans ce dépôt, voir ci-dessous).

La colonne `vigilance` est embarquée dans la page et utilisée par le cas d'usage « Surveillance inondation » (voir plus bas) ;
les deux colonnes `risque inondation` ne sont pas utilisées par l'outil. Le dossier `risque_inondation/`, qui a servi à calculer
ces colonnes, **n'est pas inclus dans ce dépôt**. Il contient le script de calcul
(reproductible, chemins configurables en tête de fichier, relançable sur un CSV déjà complété), `risque_inondation_controle.csv` (les 5 359 communes
qui touchent une zone, avec la part de leur surface concernée et la décision) et `risque_inondation_epci.csv` (les 328 EPCI concernés : nombre de communes,
dont en zone, ajoutées par l'élargissement, population).

**Source** : GeoPackage `Floods_Spatial_RiskZone` (125 polygones TRI, directive Inondations) ; le fichier de points `HazardArea` (101 points) est
entièrement situé dans des communes déjà retenues par les polygones et n'ajoute donc aucune commune.

**Méthode (niveau commune)** : intersection des contours des communes (fonds de carte 2018, complété par l'historique officiel des fusions pour
obtenir les communes 2026) avec les polygones. Une commune est retenue si le recouvrement a une épaisseur d'au moins 200 m **ou** couvre au moins 50 %
de la commune. Cela écarte environ 2 750 communes voisines de zones mais non concernées, dont le contour ne diffère de la zone que de quelques mètres
(décalage entre fonds de carte) ; le résultat est stable (2 602 / 2 591 / 2 588 / 2 587 communes pour des seuils de 200 / 400 / 600 / 1 000 m d'épaisseur).
Les communes nouvelles dont seule une ancienne commune est en zone sont bien à 1 (« au moins en partie »).
**Élargissement à l'EPCI** : regroupement par `epci_code` ; l'effet est important (328 des 1 255 EPCI sont concernés, 6 163 communes ajoutées,
12,4 millions d'habitants) : par exemple la CA du Pays Basque passe de 12 à 158 communes, la CC de la Haute Saintonge de 2 à 129.

**Limites connues**
- **Sannerville (14666)** : aucun contour dans le fonds de carte 2018 ; valeur communale 0 par défaut (communes voisines à 1,4–1,8 km de la zone la plus proche).
  Sa valeur « EPCI » reste correcte dès qu'une autre commune de son EPCI est en zone.
- **Codes erronés dans le CSV** : 15171 (« Neussargues en Pinatelle », 946 hab.) et 85212 (« Essarts en Bocage », 8 210 hab.) portent les codes officiels
  de Sainte-Anastasie et de Sainte-Florence ; les codes officiels de ces communes sont 15141 et 85084. Le calcul les rattache par leur nom ; le CSV n'a pas été corrigé.
- Les contours datent de 2018 : une modification de limite postérieure à cette date n'est pas prise en compte.

## Cas d'usage « Surveillance inondation » (7ᵉ carte)

Hypothèses et formules : onglet **Prévention Inondation** de l'Excel V1.2 (version 4) ; lignes du CSV `Surveillance inondation` (la colonne `note_source`
donne la cellule d'origine de chacune). Contrairement aux six autres cas d'usage, il n'y a **aucun parc d'objets à saisir** : l'utilisateur choisit le territoire
(commun à tous les cas d'usage) et indique la **date de déploiement** d'un système de surveillance (2026 à 2036, obligatoire).

**Ce que calcule le modèle** (trajectoire 2027-2036, dans `src/engine.js` / `moteur_calcul.py` : `calculInondationAvecOptions` / `calcul_inondation_avec_options`) :

1. **Dommages du territoire** selon son profil de vigilance (colonne `vigilance` des communes, embarquée dans le HTML) :
   `Σ_niveau (population du territoire au niveau ÷ population nationale) × dommages nationaux du niveau`, avec dommages nationaux du niveau =
   1 Md€ (2025) × part du niveau (62,7 % / 15,5 % / 21,8 % pour les vigilances 3 / 2 / 1) × 1,025^(année − 2025).
2. **Dommages évités** = dommages du territoire × 50 % (part des dommages adressable par une surveillance locale) × 10 % (taux d'évitement net), soit **5 %** des dommages,
   chaque année à partir de l'année de déploiement (+ économie de veille et d'astreinte, nulle dans l'Excel) : règle de l'Excel, via deux hypothèses distinctes du CSV.
   Avec cette règle, un territoire doit compter environ 411 000 habitants en vigilance 3 pour que le bilan net sur 10 ans soit positif (≈ 323 000 pour couvrir les seuls coûts récurrents).
3. **Coût d'un système à l'échelle départementale** (« pour 1 seul territoire », somme des lignes de coût de l'Excel) : CAPEX 450 000 € et conduite du changement 50 000 € l'année du déploiement ;
   chaque année dès le déploiement : transmission 16 000 € (40 points × 400 €), serveurs 2 000 €, logiciels 60 000 €, exploitation-maintenance 94 000 € (12 % du CAPEX cumulé + 40 000 €).
4. **Bilan net économique** = dommages évités − coûts. **Bilan net environnemental** = émissions seules (aucun bénéfice carbone dans l'Excel) : fabrication 420 kgCO₂e + 900 kWh,
   pose 1 000 kgCO₂e, fin de vie 50 kgCO₂e l'année du déploiement ; usage 625 kWh/an (× 0,079 kgCO₂e/kWh) chaque année.

**Conventions** : un déploiement en **2026** est antérieur à l'horizon d'analyse et est comptabilisé dès **2027** (identique à 2027) ; la surveillance inondation est **hors mutualisation**
du réseau IoT (système unique par territoire) et n'entre pas dans le bloc « Silo vs mutualisé » ; le bilan CO₂ et énergie s'affiche en « + » rouge (consommation et émissions, sans économie compensatoire).
La population nationale (68 348 939 hab.) et sa répartition par vigilance sont calculées sur **toutes** les communes du référentiel.

**Attention — base de répartition des dommages** (hypothèse `Base de répartition des dommages sur le territoire`) : la valeur **0** applique la règle telle que spécifiée
(part de la population **nationale** × dommages totaux du niveau). Elle donne des dommages par habitant de ≈ 9,6 € (vigilance 3), 2,4 € (vigilance 2) et 3,4 € (vigilance 1) en 2027, soit un niveau 2 moins
dommageable que le niveau 1, et ne restitue que ≈ 465 M€ sur la France entière (au lieu de 1 Md€). La valeur **1** divise par la population **du niveau** : le total national est conservé,
mais le dommage par habitant devient pratiquement identique (≈ 15,4 €) pour les trois niveaux car, dans l'Excel, les parts de dommages (62,7 / 15,5 / 21,8 %) sont égales aux parts de population.

Tests : `node tests/test_regression_v12.js` (moteur et interface) et `python3 tests/test_inondation.py [excel.xlsx]` (parité Python/JS, validation de la date et,
si le chemin de l'Excel est passé en argument, réconciliation avec l'Excel).
Les valeurs saisies dans l'étape 3 sont désormais conservées quand on coche ou décoche une carte.

## Interface : titre, vocabulaire, détail « Silo vs mutualisé »

- **Titre** : « Mon Territoire Connecté et Durable » (titre de la page et en-tête, dans `src/template.html`). La page générée s'appelle désormais `public/index.html`
  (anciennement `mon_territoire_donnees.html`), pour être servie à la racine du site publié.
- **Vocabulaire** : « EPCI » est remplacé par « intercommunalité » dans tous les textes affichés (recherche, bandeau du territoire, panneau d'exclusion, aide de l'étape 1).
  Les colonnes `epci_code` / `epci_nom` des CSV, les identifiants du code et la sortie texte du moteur Python ne changent pas.
- **Bloc « Silo vs mutualisé »** : sous les deux montants, un tableau donne, **pour chaque cas d'usage**, les dépenses sur 10 ans en silo et en mutualisé, et **l'économie de mutualisation**
  (colonne mise en avant en vert), avec une ligne de total égale aux montants affichés au-dessus et au bandeau « économisés ». Il ne contient plus de colonnes bénéfices ni solde (les deux montants
  du haut gardent, eux, leur ligne « Solde »). Les abattements du panneau PILOTAGE étant des taux appliqués poste par poste, la part de chaque cas d'usage est exacte
  (`calculMutualisation(...).parCas` en JS, `ResultatMutualisation.par_cas` en Python — ces données incluent aussi bénéfices et soldes par cas) et la somme des cas redonne les totaux.
  La surveillance inondation n'y figure pas (hors mutualisation).
- **Ajuster la sélection** : pour un **département**, liste à cocher des intercommunalités (décocher une intercommunalité retire toutes ses communes) et recherche de commune à exclure ;
  pour une **intercommunalité**, liste défilante de **ses communes**, toutes cochées, classées par ordre alphabétique avec leur population : décocher une commune la retire du calcul
  (au moins une commune doit rester sélectionnée). Le bandeau du territoire indique « N communes sur M ».
- **Surveillance inondation** : les quatre indicateurs s'affichent dans l'ordre coût de mise en place d'un système, dommages potentiels, dommages évités, bilan net économique.

## Fichiers non éditables (ou à modifier avec précaution)

- `src/engine.js` : le moteur de calcul (formules, hypothèses, logique de saisie
  manuelle) pour les 6 cas d'usage. Une copie jumelle existe en Python
  (`moteur_calcul.py`) — toute modification d'une formule doit être répercutée
  dans les deux fichiers pour rester cohérent. Architecture : pour chaque cas
  d'usage, `getParametresXxx()` (hypothèses par strate), `calculXxxDepuisParc()`
  (trajectoire générique, commune aux deux modes), `calculXxx()` (mode auto),
  `calculXxxOverride()` (mode saisie), `calculXxxAvecOptions()` (aiguillage).
- `data/hypotheses.json` / `data/communes.json` : générés automatiquement, ne pas éditer à la main.
- `public/index.html` : généré par `build.py`, ne pas éditer à la main.

## Moteur Python en ligne de commande

Nécessite `pandas` (`python3 -m pip install -r requirements.txt`). Le % cible 2036 étant obligatoire pour chaque cas
d'usage (voir « Logique de saisie »), il se renseigne dans un fichier JSON passé avec `--donnees` :

```bash
python3 moteur_calcul.py "Roanne" --cas eau energie --donnees donnees.json
```

où `donnees.json` ressemble à :
```json
{
  "eau": {"nombre_objets": 45000, "nombre_objets_connectes": 10000, "pct_2036": 0.85},
  "energie": {"petit": {"nombre_objets": 30, "pct_2036": 0.9}, "grand": {"pct_2036": 0.8}}
}
```
Chaque cas d'usage demandé avec `--cas` doit y figurer avec son `pct_2036` (pour l'Énergie des bâtiments : les deux
sous-types `petit` et `grand`), sinon le calcul s'arrête avec un message d'erreur. `nombre_objets` et
`nombre_objets_connectes` sont facultatifs : sans eux, le parc est dérivé de la population.

Les fichiers d'entrée sont lus par défaut dans `data/` (options `--hypotheses` et `--communes` pour en utiliser d'autres).
Les options `--echelle`, `--exclure-commune`, `--exclure-epci` et `--export-csv`
fonctionnent comme dans l'outil précédent (voir leur `--help`).

## Vérifier que rien n'est cassé après une modification

Installez une fois les dépendances des tests (Node.js en version LTS récente, 22 ou 24, et Python 3) :

```bash
npm install                                  # jsdom
python3 -m pip install -r requirements.txt   # pandas, Pillow, openpyxl
```

Puis lancez `npm test` : la commande régénère `public/index.html` puis exécute les trois suites (chacune peut aussi
être lancée seule, depuis la racine du dépôt) :

- `node tests/test_regression_v12.js` : hypothèses V1.2, 6 cas d'usage, %2036 obligatoire, exclusions, pictogrammes, graphiques… (sur la page générée) ;
- `python3 tests/test_interface.py` : palette, contraste, pictogrammes, page publiée sans ressource externe ;
- `python3 tests/test_inondation.py [excel.xlsx]` : surveillance inondation, mutualisation par cas d'usage.

Ouvrez ensuite `public/index.html` dans un navigateur — les communes sont
déjà chargées. Choisissez une commune test, cochez un cas d'usage et renseignez
seulement le % cible 2036 pour lancer un calcul, puis testez avec un nombre
d'objets saisi pour vérifier l'interpolation vers 2036.

## Licence

Le code est distribué sous licence MIT (voir [LICENSE](LICENSE)), © 2026 FNCCR. Les polices Inter et Space Grotesk
(`src/fonts/`) restent sous leur propre licence, la SIL Open Font License 1.1.
