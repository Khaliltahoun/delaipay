# Changelog — DelaiPay

## Correctif — délai conventionnel robuste aux formats Excel réels (juillet 2026)

### Corrigé
- **Régression `parseConvDelaiStrict` trop strict** : les cellules réelles comme « 90JOURS », « 120JOURS », « 90 jours », « 90 J », « 30J », « 90.0 » étaient **rejetées à tort** (« le délai conventionnel doit être un entier compris entre 1 et 120 jours. »). Le parseur **extrait** désormais le nombre (unité J/JOUR/JOURS, casse, espaces multiples, tabulations ignorés) puis applique la **règle métier inchangée** : entier **1..120**, enregistré **exactement** (90JOURS → 90, 120JOURS → 120). Refus conservés pour : aucun nombre (« abc »), plusieurs nombres différents (« 90/120 », « 90 et 120 »), décimal non entier (« 90.5 »), 0, négatif, > 120 (« 121JOURS »). S'applique au flux mappé (assistant), à la prévisualisation et à la confirmation ; l'import auto legacy (`parseDelai`) était déjà tolérant. Suite de tests **108/108**.

## Import des conventions unifié (mapping libre) + matching & délais robustes (juillet 2026)

### Ajouté
- **Import des conventions via l'assistant** (mapping libre des colonnes) — **réutilise exactement le composant de mapping de l'import TVA** : analyse → feuille & mapping (auto + confiance, corrigeable) → prévisualisation (aucune écriture) → confirmation. Champs mappables : Nom fournisseur, ICE, IF, RC, Convention (OUI/NON), Délai conventionnel, Date début/fin, Référence, Commentaire. Endpoints `POST /clients/:id/conventions/preview` (dry-run) et `/confirm` ; `POST /clients/:id/import/analyze` accepte `kind=conventions`. L'import auto historique (sans mapping) reste disponible (rétro-compatibilité).
- **`util.normalizeSupplierName`** — fonction **centralisée et unique** de rapprochement des noms (comparaison uniquement) : ignore casse, accents, espaces (début/fin/multiples), tabulations, tirets, underscores, ponctuation ; neutralise les formes juridiques. Priorité d'identification **ICE → IF → RC → nom normalisé**. Le **nom affiché n'est JAMAIS modifié** (jamais écrasé ; rempli seulement s'il était vide). Utilisée par l'import des conventions ET des factures.
- **Délai conventionnel variable et strict (1..120)** dans le flux mappé : n'importe quel entier de 1 à 120 est enregistré **exactement** (aucun arrondi, aucune conversion, aucune normalisation — 79 reste 79, 103 reste 103). Toute valeur invalide (vide, 0, négative, décimale, texte, > 120) est **rejetée** avec un message explicite : *« le délai conventionnel doit être un entier compris entre 1 et 120 jours. »* — jamais corrigée automatiquement.
- **Recalcul automatique des factures** après import/suppression d'une convention : **toutes les périodes NON clôturées** des fournisseurs concernés sont recalculées (le délai autorisé de la feuille de délais reflète immédiatement le nouveau délai) ; les **périodes clôturées ne sont jamais modifiées**.

### Corrigé
- **Vrai numéro de ligne Excel** dans tous les messages d'erreur d'import (TVA, conventions, factures, assistant) : la lecture des feuilles préserve désormais la position réelle (`blankrows` + origine de plage) — le numéro affiché correspond à la ligne du fichier Excel (ex. « Ligne 15 »), jamais recalculé à partir des lignes ignorées/vides/en-têtes/du mapping.
- La colonne `resolue_le` des anomalies est présente (déjà corrigée précédemment).

### Préservé
- **CADOZAT = 36 factures / 7 025,33 DH** inchangé. Import auto legacy des conventions inchangé (« 60 à 120 » → 120). Suite de tests **106/106**.

## Export Excel de la feuille de délais, par filtre (juillet 2026)

### Ajouté
- **Bouton « Excel » par filtre** dans la feuille de calcul des délais (**Toutes**, **Retard > 0**, **Convention absente**) : chaque filtre exporte exactement ses factures dans un **classeur `.xlsx` formaté** (titre, sous-titre période/filtre/date, en-têtes clairs, largeurs de colonnes, montants au format `#,##0.00`, **ligne TOTAL** TTC + amende).
- **Endpoint `GET /clients/:id/delais/export.xlsx?annee=&trimestre=&filter=all|retard|conv`** : authentifié, isolé par tenant (404 hors périmètre), filtre inconnu → « toutes », audité. Colonnes exportées : N° facture, fournisseur (IF/ICE), nature, TTC, dates facture/paiement/arrêté, délai constaté/autorisé, retard, à déclarer, amende, revue doublon, risque, incidence reportée.
- Le calcul de la feuille est factorisé (`delaisData`) et **partagé** entre l'API JSON et l'export → même source de vérité (aucun double comptage).
- Frontend : téléchargement via `blob` (état de chargement sur le bouton, toast de succès/erreur), nom de fichier `delais_<client>_T<t>_<annee>_<filtre>.xlsx`.

### Préservé
- **CADOZAT** : l'export « Retard » = 16 factures, **TOTAL amende 7 025,33 DH** (inchangé). Suite de tests **92/92**.

## Revue non destructive des doublons potentiels (juillet 2026)

> **DelaiPay conserve les factures ressemblant à des doublons. Elles sont signalées pour vérification afin de ne pas supprimer par erreur des paiements partiels, factures scindées ou échéances multiples.**
>
> **Un utilisateur peut confirmer l'alerte ou la marquer comme faux positif. Cette revue ne supprime ni ne fusionne aucune facture.**
>
> **Les doublons supprimés par d'anciennes versions ne peuvent être récupérés qu'en réimportant la source originale.**

### Ajouté
- **Fonction centrale unique `importer.markPotentialDuplicate`** : les **trois** chemins d'import (import direct `importExcel`, relevé XML `importReleveXml`, assistant `confirmImport`) marquent désormais un doublon de façon **strictement identique** — drapeau `doublon_potentiel`, `motif_doublon`, `statut_doublon='potentiel'` et **anomalie interne de gravité basse** (idempotente : jamais recréée deux fois sur réexécution/recalcul).
- **Statut de revue non destructif** sur la facture (migration SQLite idempotente) : `statut_doublon` (`aucun` | `potentiel` | `confirme` | `faux_positif`), `date_revue_doublon`, `utilisateur_revue_doublon`. Le drapeau `doublon_potentiel` est conservé comme **trace historique de détection**.
- **Endpoint `PATCH /clients/:id/factures/:factureId/doublon`** (`{ "statut": "confirme" | "faux_positif" | "potentiel" }`) : authentifié, isolé par tenant/client, statut validé (400), facture inexistante (404). Écrit `statut_doublon` + traçabilité, journalise une **entrée d'audit avant/après**, et met l'anomalie associée en cohérence :
  - `potentiel` → anomalie **ouverte** ;
  - `confirme` → anomalie **résolue** (motif `doublon_confirme`), historique conservé ;
  - `faux_positif` → anomalie **résolue** (motif `faux_positif`), **alerte principale désactivée** (non reproposée automatiquement pour la même détection).
- **API** : `GET /clients/:id/delais` et le détail de facture exposent `doublon_potentiel`, `motif_doublon`, `statut_doublon`, `date_revue_doublon`, `utilisateur_revue_doublon` et `anomalie_doublon_active`. **Compatibilité conservée** : une interface ne lisant que `doublon_potentiel` continue de fonctionner.
- **Interface** (feuille de délais) : badge **« Doublon ? »** (potentiel, avertissement léger + infobulle du motif), badge **« Doublon confirmé »** (confirme), **aucune alerte principale** en faux positif (indication discrète « Alerte vérifiée — faux positif » dans le détail). Actions **Confirmer le doublon** / **Marquer comme faux positif** dans le tiroir de détail, avec confirmation avant mise à jour, toast de succès/erreur et rafraîchissement de la ligne.

### Préservé / sécurité
- **Aucune facture n'est jamais supprimée ni fusionnée** ; la facture reste incluse dans le suivi et les calculs quel que soit le statut de revue. Aucune période clôturée modifiée, aucune formule légale touchée.
- Migration **idempotente** (rejouable sans erreur) ; les factures héritées `doublon_potentiel=1` passent à `statut_doublon='potentiel'` sans rouvrir une revue déjà tranchée.
- Correction connexe : la colonne `resolue_le` (utilisée par la résolution d'anomalies) est désormais présente en base.
- **CADOZAT = 36 factures / 7 025,33 DH** inchangé (les 2 doublons gardés ont une amende nulle). Suite de tests **88/88** (60 initiaux + 28 nouveaux couvrant harmonisation, migration, endpoint, API et non-régression).

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
