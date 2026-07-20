# DelaiPay — Récapitulatif complet de l'application

> SaaS **multi-tenant** de suivi des **délais de paiement (loi marocaine 69-21)** pour cabinets d'expertise comptable.
> Import des journaux d'achats → calcul automatique des retards et amendes → déclaration DGI → visa du commissaire aux comptes / expert-comptable → tableaux de bord, alertes et audit.
>
> Cabinet pilote : **HLZ Consulting**. Document de référence produit — dernière mise à jour : juillet 2026.

---

## 1. Vision & objectif

Remplacer le travail Excel manuel des cabinets comptables pour la conformité à la **loi 69-21** (délais de paiement) :

- Centraliser les achats de tous les clients du cabinet.
- Calculer automatiquement **retards** et **amendes** selon la règle légale (modèle trimestriel apporté, mois calendaire).
- Produire la **déclaration DGI** (formulaire officiel + fichiers d'export EDI).
- Générer le **visa** du commissaire aux comptes (CAC) ou de l'expert-comptable (EC).
- Piloter le portefeuille (tableaux de bord, exposition au risque, échéances, alertes).

Public cible : **experts-comptables / commissaires aux comptes** (utilisateurs non techniques) → livrables clairs et professionnels.

---

## 2. Contexte métier & références légales

| Élément | Règle |
|---|---|
| **Assujettissement** | Chiffre d'affaires HT **> 2 000 000 DH** |
| **Régime** | **Trimestriel pour tous à partir de 2026** (avant : trimestriel si CA > 50 MMAD, sinon annuel) |
| **Seuil de visa** | CA **≥ 50 000 000 DH → Commissaire aux comptes (CAC)** ; sinon **Expert-comptable / comptable agréé (EC)** |
| **Délai légal de paiement** | **60 j** sans convention · **120 j** avec convention · **180 j** sectoriel · point de départ = **date de facture** |
| **Formulaire de déclaration DGI** | Articles **78-3 & 78-4** (loi 15-95) |
| **Visa** | Article **2.78** · **Directive OEC du 06/10/2024** |
| **Dépôt** | Portail **SIMPL** de la DGI (DelaiPay génère le **fichier XML EDI** conforme) |

---

## 3. Moteur de calcul de l'amende (règle réelle, confirmée par la validatrice métier)

Implémenté dans `app/src/calc.js`.

- **Amende trimestrielle « apportée »**, avec **découpage par MOIS CALENDAIRE**.
- **Date limite** = date de facture + délai applicable (60 / 120 j, plafond légal 120).
- **Date d'arrêté** (`calc.getDateArreteFacture`, source unique) : paiement si payée au plus tard le dernier jour du trimestre, sinon **dernier jour du trimestre** (impayée ou payée après la clôture). T1→31/03, T2→30/06, T3→30/09, T4→31/12 (année N, même si T4 traité en janvier N+1). La date du jour n'arrête jamais un trimestre.
- **Délai constaté** = date d'arrêté − date de facture (jours calendaires). **Retard** = délai constaté − délai autorisé (jamais négatif). Ces trois valeurs restent distinctes.
- **Retard facturé** = mois de retard tombant dans le trimestre déclaré, entre la date limite et la date d'arrêté.
- **Opérateurs de réseau** (télécom / eau / électricité / régies-SRM, module `reseau.js`) : délai autorisé **30 j** (via `resolveDelaiAutorise`, prioritaire) et **exclusion des tableaux déclaratifs** (dans `buildDeclaration`, avec résumé des exclusions ; factures conservées et visibles en interne). Classification par alias + ICE/IF/RC prioritaires ; match par nom seul = *proposé*, à confirmer. Endpoints : `PATCH …/fournisseurs/:fid/classification`, `GET …/reseau/simulation`.
- Le **tout premier mois de retard** (sur la vie de la facture) est taxé au **taux directeur Bank Al-Maghrib** en vigueur ce mois (2,25 % en 2026) ; **chaque mois calendaire suivant** = **0,85 %**.
- On ne facture que les **mois de retard tombant DANS le trimestre déclaré**.
- **Base** = montant TTC réglé hors délai + montant non réglé.
- Le **taux BAM est historisé** (table `taux_bam`) et appliqué par date.

**Validation au centime** — client réel CADOZAT, T1 2026 :
- TTC concerné **350 964,45 DH** → amende **7 026 DH** (le moteur reproduit **350 964,42 / 7 025,33** aux arrondis source près).
- Exemples de lignes : TRACTAFRIC 245 595,80 → 5 525,91 (2,25 %) ; PNEUMATIQUE 6 600 → 112,20 (1,70 %) ; BG EXPRESS 3 050 → 25,93 (0,85 %).

Barème de risque par facture (couleur) : `ok` / `app` (approche) / `orange` (attention) / `red` (retard) / `dred` (pénalités lourdes : amende ≥ 1 000 DH ou retard ≥ 90 j).

---

## 4. Stack technique & architecture

**Aucun build, aucune dépendance native.**

- **Node.js ≥ 22** + **Express**
- Base de données : module intégré **`node:sqlite`** (fichier `app/data/delaipay.db`, mode WAL)
- Authentification : **JWT** en cookie httpOnly (`jsonwebtoken` + `bcryptjs`)
- Upload : **multer** · Excel : **SheetJS (`xlsx`)** · XML : **`xml-js`** · Word : **`docx`** · PDF : **`pdfkit`**
- **Frontend** : SPA en **JavaScript vanilla** (pas de framework, pas de build) — design premium, **mode clair/sombre**, responsive
- Conteneurisation : **Dockerfile** (base `node:24-alpine`)

### Arborescence
```
app/
├── src/
│   ├── server.js     # bootstrap Express + garde de pages + seed + /healthz
│   ├── api.js        # toutes les routes REST + logique métier (assujettissement, régime, visa, déclaration)
│   ├── calc.js       # moteur 69-21 (trimestriel apporté, mois calendaire, taux BAM)
│   ├── importer.js   # parsing Excel/CSV + XML, détection colonnes (titre + contenu), multi-feuilles, garde-fous
│   ├── visa.js       # génération du visa Word (.docx) et PDF (1 page A4)
│   ├── db.js         # schéma node:sqlite + provider taux BAM + journal d'audit + index
│   ├── auth.js       # JWT cookie httpOnly, bcrypt, middlewares requireAuth / pageGuard
│   ├── seed.js       # amorçage cabinet + utilisateur + client de démonstration + taux BAM
│   └── util.js       # formatage FR, normalisation ICE, génération d'identifiants
├── public/
│   ├── login.html · app.html
│   ├── css/app.css
│   └── js/app.js · js/login.js
├── data/             # base SQLite (généré, gitignored) + backups/
├── uploads/          # fichiers téléversés : conventions, imports (gitignored)
└── Dockerfile
```

---

## 5. Modèle de données (SQLite, cloisonné par `cabinet_id`)

| Table | Rôle |
|---|---|
| `cabinet` | Le cabinet comptable (tenant) |
| `utilisateur` | Comptes (rôle, initiales, titre) — unicité `(cabinet_id, email)` |
| `entreprise` | Clients du cabinet (ICE, IF, RC, forme juridique, secteur, ville, adresse, CA HT, exercice, expert responsable…) |
| `fournisseur` | Fournisseurs par client (ICE, IF, RC, `delai_applicable`) |
| `convention` | Conventions de délai par fournisseur (délai convenu, dates, statut, conformité, fichier) |
| `facture` | Achats + **champs calculés dénormalisés** (délai écoulé, date limite, retard, n° de mois, à déclarer, taux BAM, taux total, base amende, montant amende, couleur risque, période) |
| `taux_bam` | Historique du taux directeur BAM (par date, global ou par cabinet) |
| `declaration` | Déclaration trimestrielle DGI (CA, montants, amende, montant à verser, statut, type de visa) |
| `ligne_declaration` | Lignes détaillées de la déclaration |
| `visa` | Visa émis (type, montant visé, conclusion, signataire, texte) |
| `anomalie` | Contrôles qualité (type, gravité, détails, statut ouvert/résolu) |
| `document` | Fichiers importés / téléversés (type, nom, chemin, `import_id`, `nb_factures`) |
| `audit_log` | Journal des actions sensibles (utilisateur, action, entité, détails, IP) |

Index de performance : `entreprise(cabinet_id)`, `fournisseur(entreprise_id)`, `facture(entreprise_id)`, `facture(entreprise_id, annee, trimestre)`, `facture(cabinet_id, annee, trimestre)`, `facture(fournisseur_id)`, `convention(fournisseur_id)`, `audit_log(cabinet_id, created_at)`.

---

## 6. Fonctionnalités — module par module

### 6.1 Authentification & multi-tenant
- Connexion sécurisée (page dédiée), **JWT en cookie httpOnly**, mots de passe **bcrypt**.
- Session 12 h ; cookie `Secure` en production ; `SameSite=lax`.
- **Garde de page** (redirige vers `/login`) et **garde d'API** (401 si non authentifié).
- **Cloisonnement multi-tenant** : chaque requête est filtrée par `cabinet_id` (issu du JWT).
- Compte initial configurable via `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

### 6.2 Tableau de bord exécutif (`#dash`)
Vue consolidée du portefeuille, par période (trimestre) :
- **KPIs portefeuille** : clients suivis, nb assujettis (> 2 MDH), fournisseurs référencés, factures du trimestre, **taux de conformité** (% payées dans les délais).
- **Exposition & risque** (cartes cliquables) : factures en retard, montant TTC concerné, **montant à verser au Trésor**, conventions manquantes.
- KPIs complémentaires : **DSO** (délai moyen de paiement), retard moyen, conventions valides, anomalies ouvertes.
- **Répartition des factures par risque** (barre segmentée : normal / approche / attention / retard / pénalités).
- **Échéances déclaratives** (prochains dépôts SIMPL T1–T4 avec compte à rebours).
- **Évolution des amendes** (graphe par mois de paiement).
- **Heatmap du risque** (top 5 entreprises × 6 derniers mois).
- **Top entreprises à risque** et **Top fournisseurs à risque**.
- Période par défaut = celle qui contient **le plus de factures** (évite les périodes quasi vides).

### 6.3 Portefeuille clients (`#clients`)
- Liste des clients avec **recherche** et **filtres par risque**.
- Par client : ICE, IF, RC, ville, CA, secteur, expert responsable, **assujettissement** et **régime** auto (selon CA), **type de visa** (CAC/EC), nb retards, amende.
- **CRUD complet** : créer, consulter, **modifier**, **supprimer** (avec cascade : factures, conventions, fournisseurs, anomalies, documents, déclarations).

### 6.4 Fiche client / hub (`#client`)
- **En-tête** avec identité + badges (assujettie, régime, type visa).
- **KPIs** du client : fournisseurs, conventions, conventions manquantes, factures, à déclarer, TTC en retard, amende.
- **Cartes-modules** cliquables vers : import, feuille de délais, conventions, déclaration, visa.
- Sélecteur de période (trimestres disponibles).

### 6.5 Sélecteur & recherche globale (bandeau)
- **Switcher client global recherchable** (liste tous les clients + nb « en retard »).
- **Recherche globale** (client, ICE…).
- Mémorisation du client courant (localStorage) ; navigation SPA préservée (bouton retour du navigateur géré via `pushState`/`popstate`).

### 6.6 Import de fichiers (`#import`)
- **Upload multi-fichiers** (glisser-déposer), jusqu'à 30 fichiers.
- Formats **Excel (.xlsx/.xls)**, **CSV**, et **XML** (relevé de déductions SIMPL).
- **Détection automatique des colonnes** par **titre** ET par **contenu** :
  - Choix de la meilleure feuille + ligne d'en-tête (dans les 25 premières lignes).
  - Lecture des fichiers **sans en-tête** (inférence par le contenu).
  - Dates classées facture / paiement par **chronologie** ; ICE (15 chiffres), IF, montants TTC/HT/TVA, taux TVA, n° de facture, noms, mode de règlement, désignation.
- **Import multi-feuilles** (toutes les feuilles de type « factures », pas seulement la meilleure).
- **Feuilles grand-livre / journal / balance ignorées.**
- **Contrôles d'anomalies** : date manquante, dates incohérentes (paiement avant facture), date future, incohérence TTC ≠ HT+TVA, doublons, **convention absente** (délai > 60 j sans convention).
- **Garde-fous qualité** : rejet des lignes d'en-tête parasites, des **dates aberrantes** (hors 2000–2035) et des **montants aberrants** (≥ 500 M DH ; les n° de compte longs ne sont plus pris pour des montants).
- **Doublons potentiels CONSERVÉS** (même fournisseur + n° + TTC + date facture) : la facture n'est **plus supprimée** (elle peut représenter un paiement partiel, une facture scindée ou une échéance distincte) mais **gardée et signalée** pour revue, via la fonction centrale `markPotentialDuplicate` (identique pour les trois imports : `importExcel`, `importReleveXml`, `confirmImport`) — drapeau `doublon_potentiel`, `statut_doublon='potentiel'`, anomalie de gravité basse.
- **Section « Fichiers importés »** par client : liste, **téléchargement**, **suppression** (retire aussi les factures liées).

**Formats réels pris en charge :**
1. **Modèle EDI officiel DGI** (« Déclaration délais paiement ») — n° facture, dates, montant de la facture.
2. **Tableau de déductions TVA** — montant TTC/HT/TVA, ICE, « Facture N° », dates.
3. **Tableaux « délai de paiement » personnalisés** (colonnes libres, en-tête `N°`, montants, dates, délai retenu).
4. **Relevé de déductions SIMPL au format XML** (`<DeclarationReleveDeduction>`) — parsing dédié via `xml-js`.
5. **Listes de conventions** (fournisseur + échéance/délai convenu).

### 6.7 Feuille de calcul des délais (`#delais`)
- Tableau par facture : **N° facture**, fournisseur (IF/ICE), nature, TTC, date facture, date paiement, **arrêté au**, **délai constaté**, **délai autorisé**, **retard (jours)**, à déclarer, **amende**, risque. État lisible (payée / impayée à la clôture / payée après la clôture) + infobulle. Délai constaté et date d'arrêté calculés côté backend (`getDateArreteFacture`) — le frontend n'a aucune formule propre.
- Badge **conv. / sans conv.** (quand délai écoulé > 60 j).
- **Action express « + Convention présente »** : sur une ligne dont le fournisseur n'a pas de convention (délai écoulé > 60 j), un clic ouvre une mini-fenêtre (délai proposé 120 j, éditable, plafond 180 j) et **crée la convention** pour ce fournisseur (PDF différé → « Document manquant »). Recalcul immédiat : toutes les lignes du fournisseur passent en « conv. ». Réutilise `POST /clients/:id/conventions` avec `fournisseur_id` (appartenance vérifiée, anti-IDOR). `four_id` exposé dans `GET /clients/:id/delais`.
- **KPIs** : factures analysées, montant TTC concerné, retard moyen, amende du trimestre.
- **Filtres** : toutes / en retard (retard > 0) / convention absente.
- **Revue des doublons (non destructive)** : badge **« Doublon ? »** (potentiel) → dans le détail, **Confirmer le doublon** (badge « Doublon confirmé ») ou **Marquer comme faux positif** (alerte principale masquée, indication discrète « Alerte vérifiée — faux positif »). Endpoint `PATCH /clients/:id/factures/:factureId/doublon` (audité avant/après). **Aucune facture n'est supprimée ni fusionnée** ; elle reste incluse dans les calculs. `statut_doublon` (`aucun`/`potentiel`/`confirme`/`faux_positif`), `date_revue_doublon`, `utilisateur_revue_doublon` exposés par l'API.
- **Détail du calcul** par facture (panneau latéral).
- Bouton **Recalculer** la période + accès direct à « Préparer la déclaration ».

### 6.8 Conventions & OCR (`#conv`)
- **Registre des conventions** par client : fournisseur, objet, délai convenu, dates début/fin, **statut** (Trouvée / Bientôt expirée / Expirée), conformité.
- **Upload** de la convention (PDF / scan) + **téléchargement**.
- **Ajout** (upsert du fournisseur si nécessaire) et **suppression** (repli au délai 60 j + recalcul).
- Contrôle métier : **délai > 60 j → convention requise** (sinon anomalie `convention_absente`).
- **Import Excel d'une liste de conventions** (`POST /clients/:id/conventions/import`) — crée fournisseurs + conventions **sans le PDF** (document différé) :
  - **Modèle** téléchargeable à 2 feuilles (Instructions + Conventions, 10 colonnes, exemples fictifs) : `GET /conventions/template.xlsx`.
  - **Identification** fournisseur : ICE → IF → RC → nom normalisé (accents/casse/ponctuation/formes juridiques).
  - **Délais** : plage → plus grand (« 60 A 120 J » → 120) ; **> 180 j** → à vérifier ; nul/illisible → rejeté ; **NON** → aucune convention (60 j légal) ; vide/ambigu → à vérifier.
  - **Dédoublonnage** : identique → doublon ; délai/dates différents → conflit (aucun écrasement, PDF préservé).
  - **Transaction unique** (`BEGIN/COMMIT/ROLLBACK`) ; **lot d'import** tracé (`import_lot.source_type='conventions_xlsx'`, SHA-256) + `convention.import_lot_id`.
  - **Rapport** (écran + CSV) : analysées / créées / fournisseurs créés-existants / doublons / conflits / sans convention / à vérifier / rejetées / ignorées, avec motif par ligne.
- **Pièce PDF différée** (`POST /clients/:id/conventions/:convId/file`) : statut **« Document manquant »**, boutons **Ajouter / Voir / Remplacer** (PDF uniquement, signature `%PDF-`, remplacement confirmé, audit ajout/remplacement).

### 6.9 Déclaration DGI (`#decl`)
- **Formulaire officiel** (articles 78-3 & 78-4) pré-rempli : identité déclarant, période, état des factures.
- **Récapitulatif** : total TTC, non payé, payé hors délai, amende totale, **montant à verser**, type de visa.
- **Exports** : **CSV** (tableur) et **XML EDI** conforme (dépôt SIMPL).
- Accès direct à « Générer le visa ».

### 6.10 Générateur de visa (`#visa`)
- Texte du visa **CAC ou EC** (selon CA) pré-rempli et conforme au modèle officiel (article 2.78, Directive OEC 06/10/2024).
- **Conclusion** et **signataire** paramétrables.
- Aperçu à l'écran + **export Word (.docx)** et **PDF sur 1 page A4**.

### 6.11 Pages portefeuille (cabinet-wide)
- **Factures en retard** (`#retards`) — toutes entreprises.
- **Conventions manquantes** (`#convmiss`) — fournisseurs à délai ≥ 120 sans convention, avec factures en retard.
- **Conventions du portefeuille** (`#cabconv`) — vue transversale de toutes les conventions.
- **Anomalies** (`#anomalies`) — liste filtrable + **résolution** d'une anomalie.

### 6.12 Centre d'alertes (`#alerts`)
- Conventions manquantes, anomalies de données, échéances déclaratives à venir.

### 6.13 Taux & paramètres (`#taux`)
- **Historique administrable du taux directeur BAM** (ajout d'un taux avec date de début/fin, référence), appliqué par date au calcul.

### 6.14 Journal d'audit (`#audit`)
- Traçabilité des actions sensibles : connexion, création/modification/suppression, import, exports (visa/déclaration)… avec utilisateur, entité, détails et IP.

### 6.15 Saisie manuelle
- Ajout d'un **fournisseur** manuel et d'une **facture** manuelle (calcul immédiat du retard/amende).

---

## 7. Référence API (REST, préfixe `/api`)

**Auth & session**
- `POST /auth/login` · `POST /auth/logout` · `GET /me`

**Tableau de bord**
- `GET /dashboard`

**Clients**
- `GET /clients` · `POST /clients` · `GET /clients/:id` · `PUT /clients/:id` · `DELETE /clients/:id`
- `GET /clients/:id/summary` · `GET /clients/:id/periods`

**Fournisseurs**
- `GET /clients/:id/fournisseurs` · `POST /clients/:id/fournisseurs`

**Conventions**
- `GET /clients/:id/conventions` · `POST /clients/:id/conventions` (upload) · `DELETE /clients/:id/conventions/:convId`
- `GET /conventions/:id/file`
- `POST /clients/:id/conventions/import` (liste Excel → conventions, PDF différé) · `POST /clients/:id/conventions/:convId/file` (PDF, remplacement confirmé) · `GET /conventions/template.xlsx` (modèle 2 feuilles)

**Délais / factures**
- `GET /clients/:id/delais` · `POST /clients/:id/recompute` · `POST /clients/:id/factures` (saisie manuelle)
- `PATCH /clients/:id/factures/:factureId/doublon` (revue de doublon : `confirme` / `faux_positif` / `potentiel` — non destructif, audité)

**Import & documents**
- `POST /clients/:id/import` (multi-fichiers) · `GET /clients/:id/documents` · `GET /clients/:id/documents/:docId/download` · `DELETE /clients/:id/documents/:docId`

**Déclaration**
- `GET /clients/:id/declaration` · `GET /clients/:id/declaration/export.csv` · `GET /clients/:id/declaration/export.xml`

**Visa**
- `GET /clients/:id/visa` · `GET /clients/:id/visa/export.docx` · `GET /clients/:id/visa/export.pdf`

**Portefeuille (cabinet-wide)**
- `GET /portfolio/retards` · `GET /portfolio/conventions-manquantes` · `GET /portfolio/conventions`

**Alertes / anomalies / taux / audit**
- `GET /alerts` · `GET /anomalies` · `POST /anomalies/:id/resolve` · `GET /taux` · `POST /taux` · `GET /audit`

**Divers** : `GET /healthz` (santé) · pages `/login`, `/`, `/app`.

---

## 8. Sécurité & confidentialité

- Mots de passe **hachés bcrypt** ; cookie **httpOnly / SameSite / Secure** (en prod) ; JWT signé (secret via `JWT_SECRET` ou fichier local).
- **Cloisonnement multi-tenant** systématique par `cabinet_id`.
- **Uploads hors web-root** ; **journal d'audit** des actions sensibles.
- **Fichiers clients EXCLUS du dépôt Git** (`.gitignore`) : `docs/`, `DELAI DE PAIEMENT/`, `*.xlsx/*.docx/*.pdf`, base de données, `uploads/`, captures d'écran. Aucun fichier client n'est versionné.

---

## 9. Déploiement

### Local
```bash
cd app
npm install
npm start            # http://localhost:3000  (ou PORT=3939 npm start)
```
Au premier démarrage, la base est créée et pré-alimentée (cabinet HLZ + client de démonstration + taux BAM). Identifiants configurables via `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

### Production (Docker)
- Image `node:24-alpine`, `npm install --omit=dev`, `node src/server.js`, port interne `3000`.
- Variables : `NODE_ENV=production`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PORT`.
- **Volumes persistants** : `data/` (base) et `uploads/` (justificatifs) montés depuis l'hôte.
- Derrière un reverse-proxy HTTPS (Nginx). Déployé sur VPS : `delaipay.hlzconsulting.ma`.
- Sauvegarder régulièrement `data/` et `uploads/`.

---

## 10. Données actuelles (portefeuille chargé)

- **92 clients**, **~23 400 factures**, **724 conventions**, ~4 950 fournisseurs importés depuis les fichiers réels des clients du cabinet.
- Client de référence **CADOZAT** validé au centime (T1 2026 : amende **7 025,33 DH**).
- Sauvegardes horodatées conservées dans `app/data/backups/`.

---

## 11. Correctifs récents du moteur d'import (session juillet 2026)

1. Reconnaissance des en-têtes **`N°` / `Facture N°`** (n° de facture).
2. Correspondance de colonnes fiabilisée (fin de l'inversion **date facture / date paiement**).
3. **Import multi-feuilles** + exclusion des feuilles grand-livre.
4. Détection du **montant du modèle EDI** officiel.
5. **Garde-fous** montants (n° de compte ≠ montant) et **dates** (années aberrantes rejetées).
6. Rejet des lignes d'en-tête parasites importées comme factures.
7. **Nouveau parseur XML** des relevés de déductions SIMPL.
8. Tableau de bord accéléré (index SQL) : ~8 s → ~0,04 s ; période par défaut = la plus fournie.

---

## 12. Backlog / évolutions possibles (V2/V3)

- OCR automatique des conventions et factures scannées.
- Alertes WhatsApp / e-mail.
- Portail client (dépôt de pièces en libre-service).
- Signature électronique du visa.
- Réconciliation assistée par client (rattachement conventions + choix de période) pour fiabiliser l'amende après import brut.
- Traitement des fichiers hétérogènes restants (formats non standard, déclarations à blanc).

---

---

## 13. Périodes trimestrielles & assistant d'import (juillet 2026)

Voir le détail dans **CHANGELOG.md** et le **GUIDE_UTILISATEUR_PERIODES.md**.

- **Contexte global** = cabinet + entreprise + **année + trimestre**. Sélecteur dans le bandeau, badge de statut, bannière de contexte, persisté et validé serveur.
- **Calendrier déclaratif** centralisé (`app/src/periode.js`) : mois de traitement (T4 → janvier N+1), échéance SIMPL, jours restants, bloc sur le tableau de bord.
- **Isolation stricte par trimestre** : fichiers, factures, documents et anomalies rattachés à `(cabinet, entreprise, année, trimestre, lot)` + empreinte SHA-256.
- **Cycle de vie & clôture** des périodes (`periode_declaration`) : lecture seule après clôture/déclaration (HTTP 423), réouverture admin avec motif + audit.
- **Assistant d'import 6 étapes** : analyse → feuille & **mapping** (auto + confiance, corrigeable) → **prévisualisation** (valides/ignorées/rejetées/doublons, sans écriture) → **confirmation transactionnelle** → **annulation** + rapport de rejets CSV. **Modèles de mapping** réutilisables.
- **Incidence reportée** : facture impayée → amende calculée pour chaque trimestre concerné, sans déplacer le fichier source (traçabilité vers la période d'origine).
- **Nouvelles tables** : `periode_declaration`, `import_lot`, `import_ligne`, `modele_mapping`. Migration idempotente : `npm run migrate` (sauvegarde préalable recommandée).
- **Tests automatisés** : `npm test` — **88/88** (calendrier, non-régression CADOZAT 7 025,33, classification d'import, revue non destructive des doublons, endpoint de revue, lignes total).
- **Revue des doublons potentiels** : les doublons sont conservés et signalés (jamais supprimés), avec un statut de revue (`potentiel`/`confirme`/`faux_positif`) modifiable via `PATCH …/doublon` (audité). *Les doublons supprimés par d'anciennes versions ne peuvent être récupérés qu'en réimportant la source originale.*
- **Nouvelles routes** : `/clients/:id/periods[...]` (summary/close/reopen), `/clients/:id/import/analyze|preview|confirm`, `/clients/:id/import/:id/impact|cancel`, `/imports/:id/rejections[.csv]`, `/mapping-templates`.

*Document généré pour le pilotage produit de DelaiPay. Ne contient aucune donnée client confidentielle.*
