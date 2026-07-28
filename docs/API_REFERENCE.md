# DelaiPay — Référence de l'API (Release 1.0)

Version applicative : `e25ef50ee4` — commit `17ca7ac`.

Ce document décrit **exhaustivement** les routes HTTP réellement exposées par le serveur DelaiPay,
telles qu'implémentées dans `app/src/api.js`, `app/src/auth.js`, `app/src/security.js` et
`app/src/server.js`. Aucune route n'est inventée : chaque entrée correspond à un handler existant.

---

## 1. Conventions générales

### 1.1 Stack et montage

- **Serveur** : Express 4 (`app/src/server.js`).
- **Persistance** : `node:sqlite` (`DatabaseSync`, SQLite intégré à Node ≥ 22.5), sans ORM.
- **Authentification** : JWT signé (`jsonwebtoken`) transporté dans un **cookie httpOnly** `dp_token`
  (mot de passe haché via `bcryptjs`).
- **Uploads** : `multer` (dossier `app/uploads`, limite **25 Mo** par fichier).
- **Génération de fichiers** : `xlsx` (SheetJS), `pdfkit` (PDF de visa), `docx` (Word de visa).
- Le routeur de `api.js` est monté sous le préfixe **`/api`** (`app.use('/api', api)` dans `server.js`).
  **Tous les chemins ci-dessous sont donc préfixés par `/api`** sauf mention contraire.
- Le corps JSON est limité à **2 Mo** (`express.json({ limit: '2mb' })`).

### 1.2 Authentification et autorisation

- Les 3 routes `POST /api/auth/login`, `POST /api/auth/logout` et `GET /api/me` sont déclarées
  **avant** le middleware global. `login` et `logout` sont **publiques** ; `me` exige l'auth.
- À partir de la ligne `router.use(auth.requireAuth)`, **toutes les routes suivantes exigent une
  session valide**. Sans cookie valide → **401** `{ "error": "Non authentifié" }` (ou
  `{ "error": "Session invalide" }` si l'utilisateur est inactif/supprimé).
- `requireAuth` attache `req.user` (id, cabinet_id, nom, email, role, initiales, titre, actif) et
  `req.cabinetId`. **Toutes les requêtes sont cloisonnées par `cabinet_id`** (isolation multi-tenant).
- **Rôle admin** requis explicitement pour : clôture/réouverture de période, `POST /api/taux`.
  Sinon → **403**.

### 1.3 Codes d'erreur employés

| Code | Signification dans DelaiPay |
|------|------------------------------|
| **400** | Paramètre manquant/invalide, période absente ou invalide, format de fichier refusé, délai conventionnel non conforme, erreur d'import (message métier). |
| **401** | Non authentifié / session invalide (middleware `requireAuth`). |
| **403** | Action réservée à un administrateur (`req.user.role !== 'admin'`). |
| **404** | Ressource introuvable ou n'appartenant pas au cabinet (client, fournisseur, convention, import, document, facture). |
| **409** | Conflit : réouverture d'une période non clôturée ; remplacement d'un document de convention déjà présent sans confirmation. |
| **423** | Période **clôturée/déclarée** (lecture seule) — écriture refusée (`assertWritable`). |
| **429** | Débit dépassé (limiteurs : login 10/15 min ; routes lourdes 20/min). |
| **500** | Échec transactionnel (ex. annulation d'import) ; le filet global renvoie `{ "error": "Erreur serveur" }` sans trace. |

### 1.4 Contexte de période

De nombreuses routes acceptent une **période active** via query `?annee=YYYY&trimestre=T` (ou en
paramètres d'URL pour certaines). Les routes d'écriture de données factures vérifient que la période
n'est pas verrouillée (`assertWritable` → 423). Les périodes clôturées/déclarées sont **immuables**
(aucun recalcul ne les réécrit).

### 1.5 Limiteurs de débit (`security.js`)

- `loginLimiter` : **10** requêtes / **15 min** / IP sur `POST /api/auth/login` → 429.
- `heavyLimiter` : **20** requêtes / **min** / IP sur les imports lourds (`/import`,
  `/conventions/import`) → 429.
- En-têtes renvoyés : `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, et `Retry-After`
  quand la limite est atteinte.

### 1.6 Route hors `/api`

- **`GET /healthz`** (dans `server.js`, non préfixée) → `200 { "ok": true, "version": "e25ef50ee4", "ts": <epoch_ms> }`. Publique.
- Pages : `GET /login`, `GET /` et `GET /app` servent le HTML (garde de session, redirection `/login`).

---

## 2. Authentification

### POST /api/auth/login
Publique. Limitée (`loginLimiter`).
- **Body** : `{ "email": string, "password": string }`
- **200** : `{ "ok": true, "user": { id, nom, email, role, initiales, titre } }` + pose le cookie `dp_token` (httpOnly, SameSite=Lax, 12 h, Secure en prod).
- **400** : email/mot de passe manquant.
- **401** : `{ "error": "Identifiants incorrects." }` (comparaison à temps constant, hash factice si l'e-mail n'existe pas → pas d'énumération de comptes).
- **429** : trop de tentatives.
- **Exemple** : `curl -c cookies.txt -X POST /api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@cabinet.ma","password":"secret"}'`

### POST /api/auth/logout
Publique. Efface le cookie.
- **200** : `{ "ok": true }`

### GET /api/me
Authentifié.
- **200** : `{ "user": {...}, "cabinet": { id, nom, slug, plan } }`
- **401** : non authentifié.

---

## 3. Tableau de bord

### GET /api/dashboard
- **Query** (optionnel) : `annee`, `trimestre`. Sans période → celle qui contient le plus de factures.
- **200** : objet agrégé du cabinet :
  ```json
  {
    "periode": { "annee": 2025, "trimestre": 4 },
    "calendrier": { "label", "date_debut", "date_fin", "mois_traitement", "annee_traitement", "echeance", "joursAvantEcheance" },
    "kpis": { "clients", "assujettis", "fournisseurs", "facturesTrim", "enRetard", "montantConcerne",
              "amendePotentielle", "montantAVerser", "conventionsManquantes", "convValides",
              "tauxConformite", "dso", "retardMoyen", "anomalies" },
    "segmentation": { "ok", "app", "orange", "red", "dred" },
    "topFournisseurs": [ { "name", "ice", "amende", "nb" } ],
    "evolution": [ { "ym": "2025-10", "v": 1234.5 } ],
    "topRisk": [ { "name", "city", "amt", "amende" } ],
    "heatmapMonths": ["Mai", ...],
    "heatmap": [ { "name", "cells": [ { "label", "amende", "ttc" } ] } ],
    "deadlines": [ { "day", "mon", "label", "sub", "cd", "days" } ]
  }
  ```

---

## 4. Clients (entreprises)

> `:id` = identifiant d'entreprise ; toute route vérifie l'appartenance au cabinet → **404** sinon.

### GET /api/clients
Liste du portefeuille.
- **Query** (optionnel) : `annee`, `trimestre` (filtre « retards » et « amende » sur la période ; sinon cumul toutes périodes).
- **200** : `[{ id, name, ice, if, rc, ville, ca, secteur, expert, assujettie, regime, visa, retards, amende, risk } ]`

### POST /api/clients
- **Body** : `raison_sociale` (**requis**), `ice`, `if_fiscal`, `rc`, `forme_juridique`, `secteur`, `ville`, `adresse`, `ca_ht`, `exercice_ref`, `email`, `telephone`, `expert_responsable`.
- **200** : `{ "ok": true, "id": "ent_..." }`
- **400** : raison sociale manquante.

### GET /api/clients/:id
- **200** : ligne entreprise + `assujettie`, `regime`, `type_visa`.
- **404** : introuvable.

### PUT /api/clients/:id
- **Body** : mêmes champs que la création (fusion avec l'existant).
- **200** : `{ "ok": true }` ; **404** : introuvable.

### DELETE /api/clients/:id
Suppression en cascade (déclarations, lignes, visas, factures, conventions, fournisseurs, anomalies, documents).
- **200** : `{ "ok": true }` ; **404** : introuvable.

### GET /api/clients/:id/summary
Synthèse d'une période (déclenche un recalcul si la période n'est pas verrouillée).
- **Query** : `annee`, `trimestre` (sinon période la plus fournie).
- **200** : `{ entreprise, periode, periods, kpis: { fournisseurs, conventions, convManq, factures, aDeclarer, ttcRetard, amende } }`
- **404** : introuvable.

### GET /api/clients/:id/periods
Liste enrichie des périodes (disponibles + navigation).
- **200** : `{ periods, latest, travail, plusFournie, disponibles }` où chaque période porte `annee, trimestre, label, nbFactures, statut, statutLabel, verrouillee, mois_traitement, annee_traitement`.

### GET /api/clients/:id/periods/:annee/:trimestre/summary
Détail d'une période précise (crée paresseusement la ligne `periode_declaration` si absente).
- **200** : `{ periode: { annee, trimestre, ...calendrier, statut, statutLabel, verrouillee, date_cloture, joursAvantEcheance }, kpis: { documents, lots, factures, aDeclarer, ttcRetard, amende, anomalies } }`
- **400** : période invalide ; **404** : client introuvable.

### POST /api/clients/:id/periods/:annee/:trimestre/close
**Admin uniquement.** Fige puis verrouille la période (statut `cloturee`, ou `declaree` si `body.statut === 'declaree'`).
- **Body** (optionnel) : `{ "statut": "declaree" }`
- **200** : `{ "ok": true, "statut": "cloturee" }`
- **403** : non admin ; **400** : période invalide ; **404** : introuvable.

### POST /api/clients/:id/periods/:annee/:trimestre/reopen
**Admin uniquement.** Réouverture exceptionnelle d'une période verrouillée (**motif obligatoire**, audité).
- **Body** : `{ "motif": string }` (**requis**)
- **200** : `{ "ok": true, "statut": "rouverte" }`
- **403** : non admin ; **400** : motif manquant / période invalide ; **409** : période non clôturée (rien à rouvrir) ; **404** : introuvable.

### GET /api/clients/:id/fournisseurs
- **200** : `[ fournisseur..., has_conv ]` (compteur de conventions valides).

### POST /api/clients/:id/fournisseurs
- **Body** : `raison_sociale`, `ice`, `if_fiscal`, `rc`, `adresse`, `secteur`, `email`, `delai_applicable` (défaut 60).
- **200** : `{ "ok": true, "id": "four_..." }` ; **404** : client introuvable.

---

## 5. Conventions

### GET /api/clients/:id/conventions
- **200** : `[{ id, fournisseur, four_ice, four_if, fournisseur_id, objet, delai, date_debut, date_fin, statut, conforme, fichier, fichier_nom }]` (statut calculé : `Trouvée` / `Bientôt expirée` / `Expirée`).

### POST /api/clients/:id/conventions
Création d'une convention (avec pièce jointe optionnelle). `multipart/form-data`, champ fichier `file`.
- **Champs** : `delai` (**obligatoire, entier strict 1..120** — aucune extraction OCR ; refus sinon), `objet`, `date_signature`, `date_debut`, `date_fin`, `fournisseur_id` **ou** (`four_ice`/`four_if`/`fournisseur` pour upsert).
- **Document** (optionnel) : **PDF, JPEG ou PNG** uniquement, validé par les octets d'en-tête ; **archivé tel quel, jamais analysé**.
- Recalcule les périodes non clôturées du fournisseur.
- **200** : `{ "ok": true, "id": "conv_..." }`
- **400** : délai absent/hors plage, format de document refusé, fournisseur invalide (n'appartient pas au client) ; **404** : client introuvable.

### GET /api/conventions/:id/file
Télécharge la pièce jointe de la convention (cloisonné cabinet).
- **200** : flux du fichier ; **404** : `Fichier introuvable`.

### POST /api/clients/:id/conventions/import
Import Excel d'une **liste** de conventions (sans PDF — document différé). Limité (`heavyLimiter`). `multipart/form-data`, champ `file`.
- **Fichier** : `.xlsx`/`.xls`/`.xlsm` (validé serveur).
- Recalcule les périodes non clôturées des fournisseurs affectés.
- **200** : `{ ok, recompute, batchId, conventionsCreated, conflicts, rejected, affectedFournisseurs, ... }`
- **400** : aucun fichier / format non pris en charge / erreur d'import ; **404** : client introuvable ; **429** : débit dépassé.

### POST /api/clients/:id/conventions/preview
Prévisualisation de l'import de conventions (mapping libre, **aucune écriture** — `dryRun`). Réutilise le token d'analyse.
- **Body** : `{ token, sourceName, mapping, sheetName, headerRow }`
- **200** : rapport de simulation ; **400** : token expiré / erreur ; **404** : client introuvable.

### POST /api/clients/:id/conventions/confirm
Confirmation de l'import de conventions (**écrit en transaction**, recalcule les périodes ouvertes).
- **Body** : `{ token, sourceName, mapping, sheetName, headerRow }`
- **200** : `{ ok, recompute, batchId, conventionsCreated, ... }` ; **400** : token expiré / erreur ; **404** : client introuvable.

### POST /api/clients/:id/conventions/:convId/file
Ajout ou remplacement **explicite** du document (PDF/JPEG/PNG). `multipart/form-data`, champ `file`.
- **Query/Body** : `replace=1` pour confirmer un remplacement.
- **200** : `{ "ok": true, "replaced": bool }`
- **400** : aucun fichier / format refusé ; **409** : document déjà présent sans confirmation (`{ error, hasFile: true }`) ; **404** : client/convention introuvable.

### GET /api/conventions/template.xlsx
Télécharge le modèle Excel (2 feuilles : Instructions + Conventions).
- **200** : classeur `.xlsx`.

### DELETE /api/clients/:id/conventions/:convId
Supprime la convention (et son fichier) ; réinitialise le délai fournisseur à 60 si plus aucune convention valide ; recalcule les périodes non clôturées.
- **200** : `{ "ok": true }` ; **404** : client/convention introuvable.

---

## 6. Règle « opérateur de réseau »

### PATCH /api/clients/:id/fournisseurs/:fid/classification
Classe/confirme un fournisseur (règle de paiement applicable). Recalcule les périodes non clôturées. Audité.
- **Body** : `{ operateur_reseau: bool, statut: "propose"|"confirme"|"a_verifier", categorie_fournisseur, hors_tableau_declaratif: bool }`
- **200** : `{ "ok": true, "recompute": <n> }`
- **404** : client ou fournisseur introuvable.

### GET /api/clients/:id/reseau/simulation
Rapport de **simulation** (lecture seule) des candidats « opérateur de réseau » et de leur impact. Ne modifie rien.
- **200** : `{ candidats: [ { fournisseur_id, fournisseur, ice, if_fiscal, rc, alias, categorie, ambigu, confidence, nbFactures, ttc, amende, periodes, delaiActuel, delaiPropose, statutActuel } ], total }`
- **404** : client introuvable.

---

## 7. Feuille de délais

### GET /api/clients/:id/delais
Feuille de calcul des délais d'une période (factures + incidences reportées + totaux).
- **Query** : `annee`, `trimestre` (sinon période la plus fournie).
- **200** : `{ periode, rows: [ { id, numero, four, four_id, four_if, four_ice, nature, ttc, mht, tva, date_facture, date_paiement, delai_ecoule, delai_applicable, date_limite, arrete_au, etat_paiement, operateur_reseau, categorie, hors_tableau, source_regle, reseau_statut, reseau_categorie, reseau_ambigu, retard, n_mois, a_declarer, has_conv, taux_bam, taux_total, amende, risk, doublon_potentiel, statut_doublon, incidence, periode_origine? } ], totals }`
- **404** : client introuvable.

### GET /api/clients/:id/delais/export.xlsx
Export Excel formaté de la feuille de délais.
- **Query** : `annee`, `trimestre`, `filter` = `all` | `retard` | `conv` (défaut `all`).
- **200** : classeur `.xlsx` (titre, en-têtes, totaux, formats de nombre). Audité.
- **404** : `Introuvable`.

### POST /api/clients/:id/recompute
Recalcule la période active (refusé si verrouillée). Audité.
- **Query** : `annee`, `trimestre` (sinon période la plus fournie).
- **200** : `{ "ok": true }` ; **423** : période clôturée ; **404** : client introuvable.

---

## 8. Revue des doublons (non destructive)

### PATCH /api/clients/:id/factures/:factureId/doublon
Tranche une détection de doublon potentiel (aucune suppression/fusion — seule change l'étiquette).
- **Body** : `{ "statut": "confirme" | "faux_positif" | "potentiel" }`
- **200** : `{ ok, id, statut_doublon, doublon_potentiel, date_revue_doublon, utilisateur_revue_doublon, anomalie_doublon_active }`
- **400** : statut invalide ; **423** : période verrouillée ; **404** : client/facture introuvable.

---

## 9. Facture manuelle

### POST /api/clients/:id/factures
Saisie manuelle d'une facture (délai autorisé résolu centralement ; calcul immédiat).
- **Body** : `numero`, `designation`, `mht`, `tva`, `ttc`, `taux_tva`, `date_facture`, `date_paiement`, `fournisseur_id` **ou** (`four_ice`/`four_if`/`fournisseur`), `annee`, `trimestre`.
- **200** : `{ "ok": true, "id": "fac_...", "calc": {...} }`
- **400** : fournisseur invalide ; **423** : période verrouillée ; **404** : client introuvable.

---

## 10. Import de factures

### POST /api/clients/:id/import
Import direct de **1 à 30** classeurs (`multipart/form-data`, champ `files`). Limité (`heavyLimiter`).
- **Query** (**obligatoire**) : `annee`, `trimestre` (contexte validé serveur).
- Crée un `import_lot` + `document` par fichier ; renseigne la traçabilité période/origine.
- **200** : `{ ok, files: [ { file, ok, format, imported, duplicates, fournisseursCreated, anomalies, totals, importId } ], agg, periode }`
- **400** : aucun fichier / période absente ou invalide ; **423** : période verrouillée ; **404** : client introuvable ; **429** : débit dépassé.

### POST /api/clients/:id/import/analyze
Assistant, étape 2 — analyse d'un fichier (stocke un temporaire, renvoie un **token**). Champ `file`.
- **Body** : `kind` = `factures` (défaut) | `conventions`.
- **200** : `{ ...analyse, token, sourceName, taille }` ; **400** : aucun fichier / erreur ; **404** : client introuvable.

### POST /api/clients/:id/import/preview
Assistant, étape 4 — prévisualisation (**aucune écriture**).
- **Query/Body** : `annee`+`trimestre` (**obligatoire**), `token`, `sheetName`, `headerRow`, `mapping`, `requireNumero`.
- **200** : rapport de prévisualisation ; **400** : période/token invalide ; **404** : client introuvable.

### POST /api/clients/:id/import/confirm
Assistant, étape 5 — confirmation (**écrit en transaction**), crée le document rattaché à la période.
- **Query/Body** : `annee`+`trimestre` (**obligatoire**), `token`, `sheetName`, `headerRow`, `mapping`, `requireNumero`, `sourceName`.
- **200** : `{ ok, importId, imported, ... }` ; **400** : période/token invalide ; **423** : période verrouillée ; **404** : client introuvable.

### GET /api/imports/:importId/rejections
Rapport des lignes ignorées / rejetées / doublons d'un import (cloisonné cabinet).
- **200** : `{ importId, source, lignes: [ { numero_ligne, feuille, statut, motif, champ, brut } ] }` ; **404** : import introuvable.

### GET /api/imports/:importId/rejections.csv
Même contenu en CSV (BOM UTF-8).
- **200** : `text/csv` ; **404** : `Introuvable`.

### GET /api/imports/:importId
Détail d'un lot d'import (cloisonné cabinet).
- **200** : `{ ...import_lot, factures_actuelles }` ; **404** : import introuvable.

### GET /api/clients/:id/import/:importId/impact
Aperçu des conséquences d'une annulation.
- **200** : `{ importId, annee, trimestre, factures, total_ttc, declarations_affectees, periode_statut, verrouillee }` ; **404** : client/import introuvable.

### POST /api/clients/:id/import/:importId/cancel
Annulation atomique d'un import (retire ses factures + anomalies + lignes ; marque lot/document `annule`). Réversible côté données non liées.
- **200** : `{ "ok": true, "facturesSupprimees": <n> }`
- **423** : période verrouillée ; **404** : client/import introuvable ; **500** : échec transactionnel (rollback).

---

## 11. Modèles de mapping

### GET /api/mapping-templates
- **Query** (optionnel) : `type` (filtre `type_fichier`).
- **200** : `[ { ...modele, mapping, transformations } ]`

### POST /api/mapping-templates
- **Body** : `nom` (**requis**), `type_fichier`, `signature_colonnes`, `feuille`, `ligne_entete`, `mapping`, `transformations`.
- **200** : `{ "ok": true, "id": "map_..." }` ; **400** : nom manquant.

### PUT /api/mapping-templates/:id
- **Body** : mêmes champs (fusion). **200** : `{ "ok": true }` ; **404** : introuvable.

### DELETE /api/mapping-templates/:id
- **200** : `{ "ok": true }` ; **404** : introuvable.

---

## 12. Documents

### GET /api/clients/:id/documents
Liste des documents d'import.
- **Query** (optionnel) : `annee`, `trimestre` (isolation par période si fournis).
- **200** : `[ { id, type, nom, taille, mime, import_id, import_lot_id, nb_factures, annee, trimestre, created_at } ]` ; **404** : client introuvable.

### GET /api/clients/:id/documents/:docId/download
- **200** : flux du fichier ; **404** : `Introuvable` / `Fichier introuvable`.

### DELETE /api/clients/:id/documents/:docId
Supprime le document (et les factures de son import). Refusé si période verrouillée.
- **200** : `{ "ok": true, "facturesSupprimees": <n> }` ; **423** : période verrouillée ; **404** : client/document introuvable.

---

## 13. Déclaration

### GET /api/clients/:id/declaration
Construit/rafraîchit la déclaration d'une période (exclut les opérateurs de réseau confirmés, tracé).
- **Query** : `annee`, `trimestre` (sinon période la plus fournie).
- **200** : `{ entreprise, declaration, lignes: [ { facture_id, if, nom, ttc, non_paye, hors_delai, retard, amende } ], exclusions: { nbFactures, ttc, amende, nbFournisseurs, motif } }`
- **404** : client introuvable.

### GET /api/clients/:id/declaration/export.csv
Export CSV de la déclaration (BOM UTF-8, cellules protégées contre l'injection de formule).
- **Query** : `annee`, `trimestre`. **200** : `text/csv` ; **404** : `Introuvable`.

### GET /api/clients/:id/declaration/export.xml
Export XML/EDI de la déclaration.
- **Query** : `annee`, `trimestre`. **200** : `application/xml` (`<DeclarationDelaisPaiement>`) ; **404** : `Introuvable`.

---

## 14. Visa (attestation)

### GET /api/clients/:id/visa
Données du visa (type `CAC`/`EC` selon CA).
- **Query** (optionnel) : `annee`, `trimestre`, `conclusion`, `signataire`.
- **200** : `{ type, typeLabel, periode, montant_vise, montant_amende, conclusion, signataire, reference, lieu, date, debut, fin, blocks }`
- **404** : client introuvable.

### GET /api/clients/:id/visa/export.docx
Génère le visa au format Word (`docx`). Audité.
- **200** : fichier `.docx` ; **404** : `Introuvable`.

### GET /api/clients/:id/visa/export.pdf
Génère le visa au format PDF (`pdfkit`, flux). Audité.
- **200** : `application/pdf` ; **404** : `Introuvable`.

---

## 15. Alertes et anomalies

### GET /api/alerts
Alertes du cabinet (conventions manquantes, anomalies ouvertes, échéances).
- **200** : `{ count, alerts: [ { type, severite, icon, titre, message, date } ] }`

### GET /api/anomalies
Liste des anomalies du cabinet (ouvertes en tête, max 300).
- **200** : `[ { ...anomalie, ent, ent_id } ]`

### POST /api/anomalies/:id/resolve
Marque une anomalie comme résolue (cloisonné cabinet).
- **200** : `{ "ok": true }`

---

## 16. Taux BAM

### GET /api/taux
Taux applicables (globaux `cabinet_id IS NULL` + spécifiques au cabinet).
- **200** : `[ { id, cabinet_id, taux, date_debut, date_fin, reference, created_at } ]`

### POST /api/taux
**Admin uniquement.** Ajoute un taux.
- **Body** : `taux` (**requis**), `date_debut` (**requis**), `date_fin`, `reference`.
- **200** : `{ "ok": true, "id": "tx_..." }` ; **403** : non admin ; **400** : taux/date manquant.

---

## 17. Journal d'audit

### GET /api/audit
Les 100 derniers événements du cabinet (jointure utilisateur).
- **200** : `[ { id, cabinet_id, user_id, user_nom, action, entite, details, ip, created_at } ]`

---

## 18. Vues portefeuille (cabinet-wide)

### GET /api/portfolio/retards
- **200** : factures en retard du cabinet (`a_declarer=1`), triées par amende décroissante.

### GET /api/portfolio/conventions-manquantes
- **200** : fournisseurs à délai ≥ 120 j sans convention valide mais avec factures en retard.

### GET /api/portfolio/conventions
- **200** : conventions valides du cabinet `[ { id, ent, ent_id, four, four_ice, delai, date_fin, statut, fichier } ]`.

---

## 19. Récapitulatif

- **63 routes** exposées sous `/api` (auth incluse).
- **1 route de santé** hors `/api` : `GET /healthz`.
- Toutes les routes de données (hors login/logout) sont **authentifiées** et **cloisonnées par cabinet** ;
  5 actions sont **réservées à l'administrateur** (clôture, réouverture, `POST /taux`).
</content>
</invoke>
