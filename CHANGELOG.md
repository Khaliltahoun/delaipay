# Changelog — DelaiPay

Toutes les évolutions notables de DelaiPay sont consignées dans ce fichier.

Le format s'appuie sur [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et le projet suit le [versionnage sémantique](https://semver.org/lang/fr/).

DelaiPay est un SaaS multi-tenant de suivi des délais de paiement au titre de la
**loi marocaine 69-21**, destiné aux cabinets d'expertise comptable.

---

## [1.0.0] — 2026-07-28

Première version stable de production. Elle consolide six lots de correctifs
d'intégrité métier (LOTs 1 à 6), chacun développé, testé puis validé
indépendamment par la revue Claude Cowork (tests réels sur navigateur).

- **Version applicative** (`/healthz`) : `e25ef50ee4`
- **Commit** : `17ca7ac`
- **Tag** : `v1.0.0`
- **Suite de tests** : 160/160 au vert
- **Non-régression de référence** : ORYX AUTO T1 2026 = **7 025,33 DH / 36 factures** (inchangé sur les 6 lots)

### LOT 1 — Sécurisation de l'auto-mapping des imports (P0)

*Commit `75c22ee`. Corrige une corruption silencieuse des données à l'import (reproduite sur un relevé EDI de déduction TVA réel).*

#### Objectif
Empêcher qu'un mauvais mapping automatique des colonnes Excel/EDI n'écrive des
données incohérentes sans que rien ne le signale (montants pris pour des noms,
numéros de ligne pris pour des montants).

#### Ajouté
- Reconnaissance **déterministe** des en-têtes EDI standard (SIMPL/DGI) par titre
  (`M_TTC`, `LIB_FRSS`, `ICE_FRS`, `FACT_NUM`) : `Fournisseur → LIB_FRSS` et
  `TTC → M_TTC` mappés à 92 % de confiance, sans passer par l'inférence de contenu fragile.
- **Détection des colonnes séquentielles** (1, 2, 3… `ORDRE`) : jamais retenues comme Montant TTC.
- **`profileColumn(values)`** : profil réel d'une colonne (taux numérique/texte/date,
  valeurs distinctes, longueur, séquentialité, montant, identifiant, min/max, exemples).
- **`validateImportMapping({mapping, columnProfiles, requiredFields})`** : validation à
  erreurs bloquantes (Fournisseur sur colonne numérique, TTC sur séquence/`ORDRE`, type
  incompatible, colonne partagée par des champs incompatibles, champ obligatoire absent),
  avertissements et score de confiance global.
- **`isValidSupplierDisplayName(name)`** : une raison sociale purement numérique ou au
  format d'un montant (« 7596 », « 28 200,00 ») est refusée ; un vrai nom comportant des
  chiffres (« SOCIETE 3D », « MAROC 24 ») est accepté.

#### Corrigé
- **Blocage dur** de l'import : `confirmImport` refuse tout mapping incohérent (aucune écriture).
  L'assistant désactive « Confirmer » avec un message explicite tant que les erreurs
  bloquantes subsistent ; la prévisualisation expose la validation et la somme brute de la
  colonne TTC mappée.

#### Impacts métier
- Fin des imports silencieusement corrompus : plus de fournisseur nommé « 7596 » ni de
  montants issus de numéros de ligne. La qualité des amendes calculées est protégée à la source.

### LOT 2 — Opérateurs réseau (P1)

*Commit `257e374`. Version `d039059eb0`.*

#### Objectif
Rendre exploitable dans l'interface le traitement particulier des opérateurs réseau
(télécoms, eau, électricité) : délai spécifique et exclusion des tableaux déclaratifs.

#### Ajouté
- La feuille de délais (`/delais`) expose `reseau_statut`, `reseau_categorie` et
  `reseau_ambigu`, et affiche un bouton **« Réseau ? — confirmer »**.
- **Confirmation en 1 clic** : applique un **délai de 30 jours**, exclut le fournisseur des
  tableaux déclaratifs, recalcule les périodes non clôturées et présente un résumé.
- **Règle configurable** : `DELAI_RESEAU=30` (jours).

#### Corrigé
- La rupture était purement **UI** : le moteur `reseau.js`, les endpoints
  (`PATCH …/classification`, `GET …/reseau/simulation`), `resolveDelaiAutorise`,
  `estHorsTableauDeclaratif` et l'exclusion dans `buildDeclaration` existaient déjà mais les
  classifications réseau n'étaient jamais surfacées ni confirmables. Aucun second moteur créé.
- **Aucun faux positif** : les distributeurs de carburant restent `reseau_statut='aucun'` (non réseau).
  Priorité d'identification inchangée : ICE > IF > RC > alias confirmés > nom > mots-clés.

#### Impacts métier
- Les factures d'opérateurs réseau sont traitées avec le bon délai et exclues à bon escient
  des déclarations, en un clic et de façon traçable.

### LOT 3 — Conventions et documents — Stratégie B (honnêteté OCR)

*Commit `21e2c54`. Version `487ee3f4bd`.*

#### Objectif
Aligner l'interface sur la réalité technique : **aucun OCR n'a jamais existé** dans le
produit. Supprimer toute promesse d'extraction automatique et fiabiliser la saisie du délai.

#### Corrigé / Modifié
- **Retrait de toute promesse OCR/IA** : renommage « Conventions & OCR » → **« Conventions & documents »** ;
  message honnête « **les documents sont archivés : aucune extraction automatique n'est effectuée** ».
  (Audit : aucune dépendance OCR, aucune route d'extraction, aucun worker — le texte « module IA V2 »
  était un placeholder jamais implémenté depuis le commit initial.)
- **Suppression du délai « 120 » prérempli** ; le **délai devient obligatoire, explicite, entier 1..120**.
  Une valeur invalide est refusée côté serveur, **sans créer de convention orpheline**.
- **Upload sécurisé** : fichiers PDF/JPEG/PNG validés par les **octets d'en-tête** (magic bytes),
  pas seulement par l'extension.

#### Impacts métier
- Plus de délai fantôme de 120 jours introduit à l'insu de l'utilisateur : chaque convention
  porte un délai saisi et assumé. Les documents restent archivés comme pièces justificatives.

### LOT 4 — Intégrité métier des conventions

*Commit `513e0ab`. Version `487ee3f4bd` (backend uniquement).*

#### Objectif
Garantir qu'**une seule et même règle de délai** s'applique partout où le délai autorisé est
déterminé, sans site de contournement.

#### Corrigé
- Règle unique : `db.activeConventionFor` (convention la plus récente `valide`, tie-break
  déterministe `created_at DESC, rowid DESC`) → `reseau.resolveDelaiAutorise` (réseau 30 j →
  convention → 60 j par défaut) → `calc.computeFacture`.
- **Sites de contournement supprimés** : la **saisie manuelle de facture** (`POST /factures`)
  et **`repair.js`** ignoraient la règle réseau (60 j au lieu de 30 j, opérateurs réseau
  révertés) ; ils passent désormais tous par la fonction centrale.
- **Audit enrichi** (avant/après) sur la création et la suppression de convention.

#### Conflits résolus (règles explicites)
- Deux conventions concurrentes → la **plus récente** l'emporte (sélection déterministe et stable).
- Le **réseau est prioritaire** sur la convention.
- Validité **par statut** : `date_fin` sert d'alerte/badge, elle n'est pas contraignante
  (voir Known Issues — à valider juridiquement).

#### Impacts métier
- Un même fournisseur ne peut plus obtenir un délai différent selon le point d'entrée (import,
  saisie manuelle, réparation). Le montant de l'amende est cohérent quelle que soit l'origine de la donnée.

### LOT 5 — Cohérence des périodes

*Commit `011031e`. Version `7c95ba3f96`.*

#### Objectif
Faire de la **période active** la seule période utilisée partout, pilotée par le sélecteur
année/trimestre.

#### Corrigé
- La période active `state.period` (persistée dans `localStorage('dp-period')`, propagée via
  `perQuery()`) est la **seule** référence ; chaque `setPeriod` déclenche un re-render + refetch
  (plus de cache périmé).
- **Fiche client** : `GET /clients/:id/summary` n'est plus figé sur la dernière période ;
  suppression du forçage `state.period = s.periode` qui « bloquait » la fiche sur T3/dernière période.
- **Portefeuille** : `GET /clients` respecte `annee/trimestre` au lieu de cumuler toutes les périodes.
- `goClient` devient asynchrone et recharge les périodes (`await loadPeriods`), cohérent avec `setClient`.

#### Impacts métier
- La fiche client, le portefeuille et toutes les vues scopées reflètent exactement la période
  sélectionnée. Fin de la « fiche bloquée sur la dernière période ».

### LOT 6 — Clôture et réouverture des périodes

*Commit `17ca7ac`. Version `e25ef50ee4`.*

#### Objectif
Une période clôturée devient **immuable** (montants, pénalités, déclarations, factures figés) ;
la réouverture est explicite, réservée à l'administrateur, motivée et tracée.

#### Corrigé
- **`recomputePeriod` = NO-OP** si la période est verrouillée : correctif décisif garantissant
  l'immuabilité (auparavant, `/summary` et `buildDeclaration` pouvaient réécrire une période
  clôturée si une convention/réseau était modifié après coup).
- **`/close`** recalcule puis fige la période, avec audit avant/après.
- **`/reopen`** refuse **409** une période non clôturée, exige un **motif obligatoire**, trace
  avant/après + motif, et se limite à une seule période.
- **`PATCH …/doublon`** protégé par `assertWritable` → **423** sur période verrouillée.
- **UI** : panneau de période (statut clair, bandeau lecture seule 🔒, boutons Clôturer / Rouvrir
  réservés à l'admin, motif obligatoire à la réouverture).
- Aucune route ajoutée/supprimée, aucun changement de schéma.

#### Impacts métier
- Les montants déclarés à la DGI sont figés à la clôture et ne peuvent plus dériver. Toute
  régularisation passe par une réouverture admin motivée et traçable (piste d'audit complète).
- Validation de bout en bout : clôture d'un dossier pilote T2 (amende figée 52 102,32 DH malgré une
  convention 120 j créée après clôture) → réouverture motivée → dégel (52 102,32 → 37 188,15 DH).

### Sécurité (rappel, socle stable depuis RC1)
- Authentification **JWT**, isolation **multi-tenant** stricte (404 hors périmètre).
- En-têtes durcis (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
  Permissions-Policy, HSTS en production).
- Rate-limiting (connexion 10/15 min ; opérations lourdes 20/min).
- Actions sensibles auditées ; aucune stack trace exposée ; anti path-traversal ; `/healthz` versionné.

---

## Known Issues (réserves connues au 2026-07-28)

Ces points sont **non bloquants**, **sans impact sur l'intégrité des données ni sur les
montants déclarés à la DGI**, et documentés en détail dans `docs/KNOWN_ISSUES.md`. Aucun n'est
corrigé dans la version 1.0.0.

- **P3 — LOT 5 — Persistance de période au rafraîchissement.** Au rechargement (F5), une période
  sélectionnée vide ou hors « périodes disponibles » du client courant n'est pas restaurée depuis
  `localStorage('dp-period')` : `loadPeriods` replie sur la période de travail. Aucun mélange de
  périodes, vue rechargée cohérente et clairement libellée.
- **P3 — LOT 6 — Affichage transitoire de la feuille sur période clôturée.** La feuille de calcul
  (`/delais`) recalcule en direct l'affichage « délai autorisé » et le KPI « retard moyen » sur une
  période clôturée, alors que l'amende, le nombre d'« en retard » et la déclaration restent figés.
  Incohérence d'affichage transitoire uniquement, sans effet sur les montants déclarés.

### Réserves à trancher (juridique / UX, hors P3 pur)
- **LOT 4 — Validité des conventions par statut** : une convention à `date_fin` passée reste
  appliquée (badge « Expirée » informatif). Point de **droit à valider** (impact sur l'amende :
  décider si l'expiration doit revenir au délai légal de 60 j).
- **LOT 4 — `DELETE` convention → 401 silencieux** sur session expirée (aucun message ; OK après reload) ;
  `confirm()` et sélecteur de fichier **natifs** (UX/automatisation).
- **LOT 2 — Règle réseau 30 j + exclusion déclarative** : base légale 69-21 à **valider juridiquement**
  avant production. Des données héritées **pré-LOT 1** (corrompues) peuvent subsister dans d'anciennes bases
  (le correctif LOT 1 empêche de nouvelles corruptions mais ne nettoie pas l'existant → prévoir un ré-import/nettoyage).

---

## Historique antérieur (pré-1.0.0)

- **RC1** — Release Candidate : sélecteur global année/trimestre, calendrier déclaratif centralisé
  (`periode.js`), assistant d'import en 6 étapes, cycle de vie des périodes déclaratives
  (clôture/réouverture, lecture seule HTTP 423), incidence reportée des impayés, durcissement
  sécurité, `/healthz` versionné, première suite de tests automatisés. (Voir l'historique Git.)
