# Changelog — DelaiPay

## Doublons conservés (paiements partiels / factures scindées) (juillet 2026)

### Modifié
- Les factures détectées comme **doublons** (même n°, date, montant TTC) ne sont **plus supprimées** à l'import : elles peuvent représenter un **paiement partiel** ou une **facture scindée**. Elles sont désormais **conservées dans les tableaux de factures** et **signalées** (`doublon_potentiel`, motif) pour revue par l'expert-comptable — badge « doublon ? » dans la feuille de délais, anomalie de gravité basse, colonne exposée par l'API.
- S'applique aux 3 chemins d'import (assistant/`confirmImport`, import direct/`importExcel`, relevé XML). Les splits à **montants distincts** étaient déjà conservés (le TTC fait partie de la clé) ; ce changement concerne les répétitions au **montant identique** (différant par la date de paiement).
- **Impact CADOZAT** : l'import passe de 34 à **36 factures** (2 lignes : mêmes factures à dates de paiement différentes, désormais gardées). **L'amende reste 7 025,33 DH** (ces factures sont réglées dans les délais → 0 amende), donc le moteur légal est inchangé. Attendu de test mis à jour et documenté. Suite 60/60.

## Règle spéciale « opérateurs de réseau » — délai 30 j + exclusion déclarative (juillet 2026)

### Ajouté
- **Catégorie « opérateur de réseau »** (télécom, eau, électricité, régies / SRM) : **délai autorisé = 30 jours**, prioritaire sur le standard 60 j, la convention et les valeurs d'import (fonction centrale unique `reseau.resolveDelaiAutorise`, backend = vérité).
- **Exclusion des tableaux DÉCLARATIFS** (déclaration DGI, `ligne_declaration`, export CSV/XML, visa) via l'unique `buildDeclaration`, avec **résumé des exclusions** (nombre, TTC, fournisseurs) — les factures ne sont **jamais supprimées** et restent visibles dans le **suivi interne** (feuille de délais, dashboard, fournisseurs, anomalies).
- **Classification robuste et confirmée** : reconnaissance par **alias normalisés** (Maroc Telecom/IAM/Itissalat, Orange/Médi Telecom, inwi/Wana, SRM/régies…), **ICE/IF/RC prioritaires** sur le nom. Un match par **nom seul** est *proposé* et **doit être confirmé** (jamais de classement définitif ni d'exclusion automatique sur un nom ambigu).
- Fournisseur enrichi : `categorie_fournisseur`, `operateur_reseau`, `delai_special`, `hors_tableau_declaratif`, `statut_classification` (propose/confirme/à vérifier), `classification_source`, `date_validation`, `utilisateur_validation` (migration idempotente).
- **API** : `PATCH /clients/:id/fournisseurs/:fid/classification` (confirmer/modifier, audité, recalcul des périodes **non clôturées** uniquement) ; `GET /clients/:id/reseau/simulation` (rapport d'impact **lecture seule** — candidats, factures, périodes, délai actuel→30, confiance).
- **Feuille de délais** : badge « Réseau — 30 j » + « Hors tableau déclaratif » + infobulle ; délai autorisé résolu par le backend.

### Préservé / sécurité
- Aucune donnée historique modifiée automatiquement : reclassification et recalcul **uniquement après confirmation explicite**, jamais sur une période clôturée. Trois indicateurs distincts (constaté / autorisé / retard). **CADOZAT = 7 025,33 DH** inchangé — suite 60/60.

## Délai constaté arrêté au dernier jour du trimestre (juillet 2026)

### Ajouté / corrigé
- **Règle métier « date d'arrêté »** (fonction centrale `calc.getDateArreteFacture`, source unique côté backend) : le délai constaté d'une facture est calculé jusqu'à une **date d'arrêté** :
  - payée au plus tard le dernier jour du trimestre → arrêté = **date de paiement** ;
  - impayée à la clôture **ou payée après la clôture** → arrêté = **dernier jour du trimestre** (T1→31/03, T2→30/06, T3→30/09, T4→31/12 de l'année N, même si T4 est traité en janvier N+1).
- **Correction** : auparavant, une facture impayée utilisait la **date du jour** (délai qui augmentait chaque jour) et une facture payée après la clôture utilisait sa **date de paiement postérieure**. Désormais l'arrêté est stable au dernier jour du trimestre déclaré. **La date du jour n'arrête plus jamais un trimestre.**
- **Trois indicateurs distincts** garantis : *délai constaté* (arrêté − facture), *délai autorisé* (60/convention ≤ 120), *jours de retard* (= constaté − autorisé, jamais négatif).
- **Feuille de délais** : nouvelles colonnes « Arrêté au » et « Délai constaté », état lisible (Payée / Impayée à la clôture / Payée après la clôture) + infobulle explicative. La valeur provient exclusivement du backend (le frontend ne recalcule pas).
- **Cas limites** : facture datée après la fin du trimestre ou paiement antérieur à la facture → signalés (aucun délai négatif produit). Calcul en **jours calendaires** (sans dérive de fuseau horaire), correct en année bissextile.
- **Incidence reportée préservée** : la facture source reste dans son trimestre d'origine (ni déplacée ni dupliquée) ; le délai constaté est recalculé à la clôture de chaque trimestre ultérieur.

### Préservé
- **Montants d'amende / à déclarer INCHANGÉS** pour tout trimestre clôturé (l'amende ne somme que les mois du trimestre déclaré) — **CADOZAT T1 2026 = 7 025,33 DH** (test de non-régression, 54/54).

## Import Excel des conventions fournisseurs & pièces PDF différées (juillet 2026)

### Ajouté
- **Import d'une liste de conventions depuis Excel** (menu Conventions) : crée fournisseurs et conventions en une fois, **sans exiger le PDF**. Le document signé s'ajoute ensuite, ligne par ligne.
- **Modèle Excel à deux feuilles** (`GET /conventions/template.xlsx`) : onglet *Instructions* (mode d'emploi) + onglet *Conventions* (10 colonnes, 3 exemples **fictifs** dont un « NON », largeurs de colonnes). Aucune donnée réelle.
- **Règles métier de l'import** : identification fournisseur **ICE → IF → RC → nom normalisé** ; délai d'une plage → **plus grand** (« 60 A 120 J » = 120) ; délai **> 180 j** classé « à vérifier » (jamais accepté d'office) ; délai nul/illisible **rejeté** ; **Convention = NON** → aucune convention, fournisseur au délai légal 60 j ; Convention vide/ambiguë → « à vérifier ».
- **Dédoublonnage & conflits** : convention identique = **doublon** (aucune recréation) ; délai/dates différents = **conflit à vérifier** (jamais d'écrasement automatique, PDF existant préservé).
- **Rapport d'import** (API + interface) : lignes analysées, conventions créées, fournisseurs créés/existants, doublons, conflits, sans convention, à vérifier, rejetées, ignorées — avec, pour chaque ligne à corriger : n° de ligne Excel, fournisseur, motif, délai reçu, convention reçue, et **export CSV**.
- **Pièces PDF différées** : statut **« Document manquant »**, boutons **Ajouter le PDF** / **Voir le PDF** / **Remplacer** (avec confirmation), loaders et boutons désactivés pendant l'envoi.
- **Action express « + Convention présente »** dans la feuille de calcul des délais : sur une facture dont le fournisseur n'a pas de convention (délai écoulé > 60 j), un clic crée la convention pour ce fournisseur (délai proposé 120 j, éditable, plafond 180 j ; PDF différé). Recalcul immédiat des retards. `four_id` (id fournisseur) exposé par `GET /clients/:id/delais` ; création via `POST /clients/:id/conventions` avec appartenance vérifiée (anti-IDOR).
- **Traçabilité** : chaque import de conventions crée un **lot** (`import_lot`, `source_type = conventions_xlsx`, empreinte SHA-256, utilisateur) ; chaque convention créée est reliée à son lot (`convention.import_lot_id`). Migrations **idempotentes** (colonnes additives `import_lot_id`, `reference`, `commentaire`, `source_import`).
- **Transaction unique** : tout l'import est encapsulé (`BEGIN`/`COMMIT`/`ROLLBACK`) — une erreur en cours annule tout, aucun fournisseur ni convention partielle conservé.

### Sécurité
- `POST /clients/:id/conventions/import` : authentifié, **cabinet + client vérifiés serveur**, **Excel uniquement**, limite de taille, **MulterError → HTTP 400** (jamais 500), nom serveur généré, nettoyage des fichiers temporaires.
- `POST /clients/:id/conventions/:convId/file` : authentifié, appartenance convention→client→cabinet vérifiée, **PDF uniquement** (extension + signature `%PDF-`), **aucun écrasement silencieux** (remplacement explicite → 409 sinon), audit *ajout* vs *remplacement*, aucun chemin interne exposé.

### Préservé
- **Moteur de calcul légal inchangé** — CADOZAT T1 2026 reste à **7 025,33 DH** (test de non-régression automatisé, toujours vert).
- **Convention = NON ne crée aucune convention active** — comportement confirmé et couvert par test.

## Périodes trimestrielles & assistant d'import (juillet 2026)

### Ajouté
- **Sélecteur global de période** (année + trimestre) dans le bandeau, avec badge de statut, navigation ← →, raccourcis « trimestre en cours de traitement » / « période la plus fournie », et liste des périodes disponibles par client. Persisté (localStorage) et **validé côté serveur**.
- **Bannière de contexte** permanente : « Client X — Période de travail : T2 2026 » + statut + indicateur lecture seule.
- **Calendrier déclaratif** (module `periode.js`, source unique) : bornes du trimestre, **mois de traitement** (T1→avril, T2→juillet, T3→octobre, **T4→janvier N+1**), échéance de dépôt SIMPL, jours restants. Bloc dédié sur le tableau de bord.
- **Cycle de vie des périodes** (`periode_declaration`) : à venir / ouverte / en préparation / à contrôler / prête / validée / déclarée / clôturée / rouverte.
- **Clôture / réouverture** de période (réservé admin, motif obligatoire, **audit**). Période clôturée = **lecture seule** (imports, suppressions, recalcul, saisie bloqués → HTTP 423).
- **Assistant d'import en 6 étapes** : fichier → feuille & **mapping colonnes** (auto + confiance + aperçu, corrigeable) → **prévisualisation** (valides / ignorées / rejetées / doublons, sans écriture) → **confirmation transactionnelle** → résultat → **annulation**.
- **Rapport des lignes** ignorées/rejetées (motif + champ + données) + export **CSV**.
- **Modèles de mapping** réutilisables par cabinet (`/mapping-templates`).
- **Isolation stricte par trimestre** : chaque fichier et facture rattachés à `(cabinet, entreprise, année, trimestre, lot d'import)` + **empreinte SHA-256**. Un fichier T1 n'apparaît jamais en T2.
- **Incidence reportée** : une facture impayée d'un trimestre antérieur génère l'amende des mois tombant dans le trimestre déclaré, **sans déplacer le fichier source** (traçabilité vers la période d'origine).
- **Tables** : `periode_declaration`, `import_lot`, `import_ligne`, `modele_mapping` + colonnes de traçabilité + index. Migration idempotente (`npm run migrate`).
- **Détection des lignes** total / sous-total / report / cumul / solde / vides / formules Excel / en-têtes répétés (insensible casse/accents, plusieurs cellules).
- **Suite de tests automatisés** (`npm test`) : calendrier, non-régression CADOZAT, classification d'import, doublons, isolation.

### Sécurité
- Toutes les routes période/document/facture **exigent et valident** année + trimestre côté serveur (jamais de confiance au frontend).
- Clôture/réouverture, imports, annulations, recalculs, modifications de taux **journalisés** (audit).
- Modification des taux BAM réservée à l'admin. Anti path-traversal sur les fichiers temporaires d'import.

### Préservé
- **Moteur de calcul légal inchangé** — CADOZAT T1 2026 reste à **7 025,33 DH** (test de non-régression automatisé).
- Aucune donnée existante supprimée (migration avec sauvegarde préalable + contrôle des effectifs avant/après).
