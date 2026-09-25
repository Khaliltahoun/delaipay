# DelaiPay — Règles métier (loi 69-21)

> Documentation **précise** des règles métier telles qu'implémentées dans le code (Release **1.0**, version `e25ef50ee4`, commit `17ca7ac`).
> Chaque règle indique son **fichier / fonction** de référence. Aucune règle n'est inventée : ce document reflète le comportement réel.
>
> Contexte : suivi des délais de paiement — loi marocaine **69-21**. Cabinet pilote **HLZ Consulting**, validatrice **la commissaire aux comptes du cabinet pilote**, client démo **STE ORYX AUTO SARL**.
>
> Lots livrés et validés : **LOT 1** import sécurisé · **LOT 2** réseau · **LOT 3** conventions/documents (Stratégie B, sans OCR) · **LOT 4** intégrité conventions (règle de délai unique) · **LOT 5** cohérence des périodes · **LOT 6** clôture/réouverture.

---

## 1. Import

### 1.1 Mapping sécurisé — refus de tout mapping incohérent (LOT 1)
`validateImportMapping()` — `src/importer.js`

La validation métier s'exécute **avant** prévisualisation/confirmation et **bloque** l'import en cas d'incohérence. Elle profile statistiquement chaque colonne (`profileColumn`, échantillon ≤ 200 valeurs : taux numérique/texte/date, `looksAmount`, `looksId`, `isSequential`…) et applique des règles :

- **Champ obligatoire absent** (`requis_absent`) : les champs requis par défaut sont `four_nom`, `date_facture`, `ttc`.
- **Colonne partagée par des champs incompatibles** (`conflit_colonne`) : ex. `four_nom`↔`ttc`, `four_ice`↔`ttc`, `date_facture`↔`date_paiement`, `ttc`↔`numero` (liste `INCOMPAT`).
- **Colonne vide** (`colonne_vide`) : champ obligatoire pointant une colonne sans donnée exploitable.
- **TTC = séquence / colonne d'ordre** (`ttc_sequence`) : refus si la colonne TTC ressemble à une suite `1,2,3…` ou porte un en-tête `ordre|index|ligne|rang|seq…` (`ORDER_HEADER_RE`). Empêche la corruption « colonne ORDRE prise pour un montant ».
- **TTC non numérique** (`ttc_non_numerique`) : refus si taux numérique < 60 %.
- **Fournisseur numérique** (`four_numerique`) : refus si la colonne Fournisseur est ≥ 60 % numérique (et non identifiant), avertissement si peu textuelle.

Résultat : `{ ok, errors, warnings, fields, confidence }` — `confidence = 0` si erreurs, `0.7` si avertissements, `0.95` sinon.

### 1.2 Détection des colonnes — titre puis contenu, avec alias EDI
`CONCEPTS`, `conceptOf`, `detectHeader`, `analyzeColumn`, `inferByContent` — `src/importer.js`

- Détection par **titre** d'abord : chaque concept a des correspondances `short` (**exactes**, pour les libellés courts ambigus) et `sub` (**sous-chaîne**, pour les libellés longs). Les alias couvrent les formats **EDI / SIMPL** et de nombreuses variantes (`datepaiement`, `datereglement`, `icefrs`, `iffrss`, `raisonsociale`, `libfrs`…).
- Les colonnes non identifiées par titre sont **inférées par le contenu** (`analyzeColumn` classe : `sequence`, `date`, `ice`, `if`, `amount`, `numero`, `text`) : dates triées facture→paiement, plus gros montant = TTC, etc.
- Garde-fous anti-corruption : une colonne **séquentielle** (entiers consécutifs) n'est jamais un montant ; un nombre n'est une date que s'il est **entier** dans la plage série Excel ; montants ≥ 5×10⁸ rejetés (n° de compte / concaténation).

### 1.3 Nom de fournisseur — anti-numérique
`isValidSupplierDisplayName(name)` — `src/importer.js`

Une raison sociale doit contenir **au moins une lettre** et ne pas être purement numérique / au format d'un montant. Refuse `7596`, `55771.91`, `« 28 200,00 »` ; accepte les vrais noms comportant des chiffres (`SOCIETE 3D`, `CABINET 2000`, `MAROC 24`).

### 1.4 Feuilles et lignes écartées
`SHEET_SKIP`, `IGNORE_WORDS`, `classifyIgnorable`, `isFormulaTotal` — `src/importer.js`

- Feuilles **ignorées** : grand-livre, journal, balance, brouillard, lettrage (`SHEET_SKIP`) — leurs numéros de compte seraient pris pour des montants.
- Lignes **ignorées** : totaux/sous-totaux/report/cumul/solde (`IGNORE_WORDS`), formules `=SUM/SOUS-TOTAL` (`isFormulaTotal`), répétitions de l'en-tête. Plusieurs cellules de la ligne sont examinées, pas seulement la première.

### 1.5 Deux formats d'entrée
`importWorkbook`, `importExcel`, `importReleveXml` — `src/importer.js`

- **Relevé de déductions TVA (SIMPL)** au format XML `<DeclarationReleveDeduction>` : parseur dédié, 1 balise `<rd>` = 1 facture.
- **Excel** : toutes les feuilles ressemblant à un tableau de factures sont traitées (pas seulement la « meilleure »). Un fichier contenant une colonne « délai convenu » est de format `DELAI`, sinon `TVA`. Le vrai numéro de ligne Excel est préservé (`readSheetGrid` / `excelRow`).

---

## 2. Conventions

### 2.1 Délai conventionnel — entier strict 1..120, obligatoire (LOT 3 & 4)
`parseDelaiConventionExplicite`, `POST /clients/:id/conventions` — `src/api.js`

Le délai conventionnel doit être **saisi explicitement** : entier strict correspondant à `^\d{1,3}$`, compris entre **1 et 120**. Toute valeur absente, non entière ou hors plage est **refusée** (`400`) **avant toute écriture**. Il n'existe **aucune valeur par défaut silencieuse** (jamais de « 120 » présenté comme un résultat d'analyse).

### 2.2 Stratégie B — document archivé, sans OCR (LOT 3)
`conventionDocKind`, `POST /clients/:id/conventions` — `src/api.js`

Un document de convention est **facultatif** ; s'il est fourni, seuls **PDF, JPEG, PNG** sont acceptés, validés par les **octets d'en-tête du fichier** (`%PDF-`, `FF D8 FF`, `\x89PNG`) et non par l'extension ou le type déclaré par le client. Le document est **archivé tel quel** : **aucune analyse ni OCR** n'est effectuée. Un délai n'est donc **jamais** extrait automatiquement du document (honnêteté OCR — Stratégie B).

### 2.3 Convention active — la plus récente valide (règle de sélection UNIQUE, LOT 4)
`activeConventionFor(entrepriseId, fournisseurId)` — `src/db.js`

Règle **unique** partagée par tous les résolveurs de délai (recalcul, feuille de délais, import, saisie manuelle) : la convention active est la plus récente au statut `'valide'`, triée `ORDER BY created_at DESC, rowid DESC LIMIT 1`. Le **`rowid`** sert de départage déterministe (`created_at` n'a qu'une précision à la seconde). La résolution du délai à partir de `(fournisseur, convention)` reste faite par `reseau.resolveDelaiAutorise` — **un seul point de vérité**.

---

## 3. Réseau (opérateurs de réseau — 30 jours) — LOT 2

### 3.1 Identification — ICE > IF > RC > nom
`upsertFournisseur`, `classifyReseau` — `src/importer.js`, `src/reseau.js`

Le rapprochement d'un fournisseur privilégie les **identifiants fiables** : ICE, puis IF, puis RC, et **en dernier** le nom normalisé. Une classification « opérateur de réseau » fondée **uniquement sur le nom** est **proposée** (`statut_classification='propose'`, `classification_source='auto_nom'`), jamais confirmée automatiquement. Si un fournisseur partage l'**ICE** d'un opérateur **déjà confirmé**, la classification confirmée est reprise (`auto_ice`) — l'identifiant prime sur le nom.

### 3.2 Délai spécifique de 30 jours — seulement si CONFIRMÉ
`resolveDelaiAutorise`, `DELAI_RESEAU` — `src/reseau.js`

Le délai de **30 jours** (prioritaire sur convention / 60 j / valeur d'import) ne s'applique que si `fournisseur.operateur_reseau` **et** `statut_classification === 'confirme'`. Motif : `« Opérateur de réseau — délai spécifique de 30 jours »`.

### 3.3 Exclusion des tableaux déclaratifs
`estHorsTableauDeclaratif` — `src/reseau.js`

Une facture est **exclue** du tableau déclaratif si le fournisseur est opérateur réseau **confirmé** ET porte le drapeau `hors_tableau_declaratif`. Les factures restent conservées en suivi interne, mais ne figurent pas dans la déclaration.

### 3.4 Faux positifs évités
`classifyReseau`, `GROUPES`, `GENERIQUES`, `norm` — `src/reseau.js`

Les alias (Maroc Telecom/IAM, Orange/Meditel, inwi/Wana, SRM, régies/ONEE/LYDEC/Amendis/Redal…) sont comparés comme **segments de mots entiers** (après normalisation sans accents/ponctuation) pour éviter les correspondances partielles. Les alias **génériques/courts** (`orange`, `wana`, `srm`, `iam`) sont marqués **ambigus** (`confidence: 0.5`) : ils déclenchent une classification « à vérifier », jamais un classement définitif sur le seul nom.

---

## 4. Délais

### 4.1 Délai légal, plafond et assainissement
`DELAI_LEGAL_DEFAUT = 60`, `DELAI_MAX = 120`, `saneDelai()` — `src/calc.js`

- Délai **légal par défaut** : **60 jours**. Plafond **légal** : **120 jours** (délai conventionnel maximal).
- `saneDelai(v, fallback=60)` ramène **toute** valeur à un entier réel dans `[1, 120]` : arrondi ; valeur nulle/négative/illisible → **60** ; > 120 → **120**. C'est le **point de passage unique** protégeant le moteur contre les données corrompues (ex. « 60 120 » concaténé → 60120 → 120).

### 4.2 Priorité de résolution du délai autorisé
`resolveDelaiAutorise` — `src/reseau.js`

Ordre **strict** : **(1)** opérateur réseau **confirmé** → 30 j ; **(2)** convention active (`saneDelai(delai_convenu)`) ; **(3)** délai fournisseur (`delai_applicable`) ou **60 j** par défaut. Chaque résultat porte sa `sourceRegle` (`operateur_reseau` / `convention` / `standard`).

---

## 5. Pénalités / amendes

### 5.1 Date d'arrêté — règle métier centrale
`getDateArreteFacture()` — `src/calc.js`

Pour un trimestre déclaré, le délai est constaté à la **date d'arrêté** :
- payée au plus tard le **dernier jour du trimestre** → arrêté = **date de paiement** (`etat='paye'`) ;
- impayée à la clôture **ou** payée **après** la clôture → arrêté = **dernier jour du trimestre** (`impaye_cloture` / `paye_apres_cloture`).
- Incohérences signalées sans jamais produire de délai négatif : facture postérieure au trimestre (`facture_hors_periode`), paiement antérieur à la facture (`paiement_anterieur`) → `delaiConstate = null`.

**La date du jour n'arrête jamais un trimestre.** Le dernier jour du trimestre provient de `periode.periodInfo` (source unique).

### 5.2 Calcul du retard et de l'amende
`computeFacture()`, `retardMonths()`, `TAUX_MOIS_SUPP = 0.0085` — `src/calc.js`

- Date limite = `date_facture + délai_autorisé` (délai passé par `saneDelai`).
- **Retard (jours)** = `max(0, date_arrêté − date_limite)` — **jamais négatif**.
- **Découpage par mois calendaire** (confirmé par la commissaire aux comptes) : tout mois calendaire touché par le retard compte pour **un mois entier** (`retardMonths` : de `date_limite + 1` jour jusqu'à la date d'arrêté).
- **Amende trimestrielle** = `TTC × Σ taux(mois de retard tombant DANS le trimestre déclaré)` :
  - **tout premier mois de retard** (sur la vie de la facture) = **taux directeur Bank Al-Maghrib** (`tauxAt`, défaut 0,0225) ;
  - chaque mois (ou fraction) suivant = **0,85 %** (`TAUX_MOIS_SUPP`).
  - Seuls les mois de retard **tombant dans le trimestre déclaré** sont facturés (`quarterMonths`).

Résultats de référence reproduits au centime (T1 2026 ORYX AUTO) : KORAL ENGINS 245 595,80 → 5 525,91 (2,25 %) ; HORIZON PNEUMATIQUES 6 600 → 112,20 (1,70 %) ; BETA EXPRESS 3 050 → 25,93 (0,85 %).

### 5.3 Couleur de risque
`riskColor()` — `src/calc.js`

`dred` (amende ≥ 1000 DH ou retard ≥ 90 j), `red` (retard > 0), `orange` (impayée, échéance ≤ 5 j), `app` (échéance 6–15 j), sinon `ok`.

---

## 6. Déclaration

### 6.1 Exclusion des opérateurs réseau + agrégat
`estHorsTableauDeclaratif` (appliqué à la génération) — `src/reseau.js`, `src/api.js`

À la génération, les factures des opérateurs de réseau **confirmés** sont séparées (`exclues`) du tableau déclaratif ; le reste alimente la déclaration et son résumé (montant TTC concerné, montant des amendes, nombre de lignes). Anomalie `convention_absente` (gravité moyenne) créée à l'import lorsqu'un délai constaté > 60 j n'est **pas** couvert par une convention valide.

---

## 7. Périodes — LOT 5

### 7.1 Mois calendaire et calendrier déclaratif
`periodInfo`, `workingPeriod`, `defaultStatut`, `joursAvantEcheance` — `src/periode.js`

- **Source unique de vérité** des bornes trimestrielles (aucune date en dur ailleurs). Un trimestre est traité **le mois suivant** sa clôture : T1→avril, T2→juillet, T3→octobre, **T4→janvier N+1** (passage d'année géré explicitement).
- Statuts du cycle de vie (`STATUTS`) : `a_venir`, `ouverte`, `en_preparation`, `a_controler`, `prete`, `validee`, `declaree`, `cloturee`, `rouverte` (libellés dans `STATUT_LABELS`).

### 7.2 Période active unique
`state.period` / `perQuery` (frontend), `latestPeriod` / `recomputePeriod` (backend)

La période active pilote **toutes** les vues (cohérence LOT 5) : une seule période de référence est utilisée partout côté client (`perQuery`) et côté serveur.

---

## 8. Clôture — immuabilité (LOT 6)

### 8.1 Statuts verrouillés
`STATUTS_VERROUILLES = { declaree, cloturee }`, `isLocked()` — `src/periode.js`

Une période aux statuts `declaree` ou `cloturee` est en **lecture seule**.

### 8.2 Recalcul neutralisé et écritures refusées
`recomputePeriod`, garde `423` — `src/api.js`

- `recomputePeriod(...)` devient un **no-op** si la période est verrouillée (`if (pr && periode.isLocked(pr.statut)) return;`) : les valeurs calculées ne bougent plus après clôture.
- Toute tentative d'**écriture** sur une période verrouillée renvoie **`423 Locked`** (`Période … clôturée … Données en lecture seule.`).
- La clôture est **réservée à l'`admin`** (`403` sinon) et recalcule une dernière fois **avant** de verrouiller.

---

## 9. Réouverture — LOT 6

`POST` réouverture — `src/api.js`

- **Réservée à l'`admin`** (`403` sinon).
- **Motif obligatoire** et **période limitée** : seule **une** période, et seulement si elle est **verrouillée**. Une période non clôturée renvoie **`409`** (`… non clôturée … rien à rouvrir.`).
- Effet : `statut='rouverte'`, `date_reouverture`, `motif_reouverture`, `cloturee_par` renseignés.
- **Tracée** dans l'audit : action `reouverture_periode` avec `{ avant, apres:'rouverte', motif }`.

---

## 10. Audit — avant/après

`audit(cabinetId, userId, action, entite, details, ip)` — `src/db.js`

Les opérations sensibles (création de convention, clôture, réouverture, résolution d'anomalie, mise à jour du taux BAM…) écrivent dans `audit_log`. `details` porte l'**état avant/après** quand pertinent. L'audit est **non bloquant** (une défaillance de journalisation ne casse jamais le flux).

---

## 11. Doublons — revue non destructive

`markPotentialDuplicate`, colonnes `statut_doublon` / `doublon_potentiel` / `motif_doublon` — `src/importer.js`, `src/db.js`

- Une facture identique déjà présente (même entreprise, fournisseur, numéro, TTC, date de facture) est **toujours conservée** — **jamais supprimée ni fusionnée** — car elle peut correspondre à un **paiement partiel, une facture scindée ou une échéance distincte**.
- Marquage central et **idempotent** : `doublon_potentiel=1`, `motif_doublon`, `statut_doublon='potentiel'`, plus **une seule** anomalie ouverte de type `doublon_potentiel` (gravité **basse**).
- **Revue non destructive** : `statut_doublon ∈ { aucun, potentiel, confirme, faux_positif }`. Une revue déjà tranchée (`confirme` / `faux_positif`) n'est **jamais rétrogradée** par une réexécution/recalcul (un faux positif n'est pas rouvert). Traçabilité : `date_revue_doublon`, `utilisateur_revue_doublon`.
- Les **trois** chemins d'import (`importExcel`, `importReleveXml`, `confirmImport`) passent **obligatoirement** par `markPotentialDuplicate` (comportement strictement identique).

---

## 12. Synthèse des priorités

| Priorité | Condition | Délai autorisé | Source | Effet déclaratif |
|----------|-----------|----------------|--------|------------------|
| 1 | Opérateur de réseau **confirmé** | **30 j** | `operateur_reseau` | Exclu du tableau déclaratif (si `hors_tableau_declaratif`) |
| 2 | Convention active la plus récente valide | `saneDelai(delai_convenu)` (1..120) | `convention` | Inclus |
| 3 | Standard (aucun des cas ci-dessus) | `delai_applicable` ou **60 j** | `standard` | Inclus |

Référence : `resolveDelaiAutorise` (`src/reseau.js`), `activeConventionFor` (`src/db.js`), `saneDelai` (`src/calc.js`).
