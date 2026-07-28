# DelaiPay — Réserves connues (Known Issues)

**Version 1.0.0 — état au 28 juillet 2026**

Ce document recense les réserves connues et **non corrigées** de la version 1.0.0.
Toutes sont **non bloquantes** et **sans impact sur l'intégrité des données ni sur les
montants déclarés à la DGI**. Elles ont été identifiées lors de la validation
indépendante (Claude Cowork) des LOTs 1 à 6.

Légende des niveaux :
- **P3** : anomalie mineure (affichage / confort / automatisation), sans impact fonctionnel.
- **À valider** : point de règle métier ou juridique à trancher avant usage critique (ce n'est pas un défaut).

---

## P3-1 — Persistance de période au rafraîchissement (LOT 5)

- **Description** : au rechargement de la page (F5), lorsqu'une période sélectionnée est
  **vide** ou **hors des « périodes disponibles »** du client courant, elle n'est pas
  restaurée depuis `localStorage('dp-period')`. La fonction `loadPeriods` **replie** alors
  sur la période de travail du client.
- **Impact** : **aucun sur l'intégrité**. La vue rechargée reste cohérente et clairement
  libellée ; il n'y a jamais de mélange de périodes ni de chiffres erronés — seule la période
  affichée après rechargement peut différer de celle sélectionnée avant.
- **Contournement** : re-sélectionner la période souhaitée via le sélecteur année / trimestre
  après le rechargement.
- **Statut** : **ouvert**. Piste de résolution : persistance stricte de `dp-period` au
  chargement, ou alignement du libellé du comportement attendu.

---

## P3-2 — Affichage transitoire de la feuille sur période clôturée (LOT 6)

- **Description** : sur une période **clôturée**, la feuille de calcul (`/delais`) recalcule
  **en direct** deux éléments d'**affichage** — la colonne « Délai autorisé » et le KPI
  « Retard moyen » — alors que l'**amende**, le **nombre de factures en retard** et la
  **déclaration** restent, eux, **figés**. Si une convention est créée après clôture, le
  tableau peut donc afficher un fournisseur « dans les délais » tandis que l'amende figée le
  compte encore comme en retard.
- **Impact** : **aucun sur les montants déclarés à la DGI**. Il s'agit d'une incohérence
  d'affichage transitoire ; les valeurs contraignantes (amende, déclaration) demeurent
  correctement gelées par la clôture.
- **Contournement** : se référer à l'amende et à la déclaration figées (valeurs de vérité) ;
  ignorer l'affichage « délai autorisé » / « retard moyen » de la feuille tant que la période
  est clôturée. Une réouverture admin suivie d'un recalcul réaligne l'ensemble.
- **Statut** : **ouvert**. Piste de résolution : figer aussi le rendu de la feuille (snapshot)
  ou neutraliser l'effet des conventions sur une période verrouillée.

---

## À valider — Validité des conventions par statut (LOT 4)

- **Description** : une convention dont la `date_fin` est passée reste **appliquée** ; la
  validité est fondée sur le **statut** de la convention, la `date_fin` servant uniquement
  d'alerte / de badge « Expirée » (elle n'est pas contraignante).
- **Impact** : peut influer sur le calcul de l'amende (le délai conventionnel continue de
  s'appliquer au-delà de la date de fin). Ce n'est pas un défaut technique mais une **règle
  métier à confirmer juridiquement**.
- **Contournement** : mettre à jour ou remplacer manuellement la convention lorsqu'elle
  n'est plus applicable.
- **Statut** : **ouvert — à valider juridiquement** (décider si l'expiration doit ramener au
  délai légal de 60 jours).

---

## À valider — DELETE convention : 401 silencieux sur session expirée (LOT 4)

- **Description** : la suppression d'une convention avec une **session expirée** échoue de
  façon **silencieuse** (HTTP 401, aucun message). L'opération fonctionne normalement après
  reconnexion.
- **Impact** : **aucun sur l'intégrité** (rien n'est supprimé). Défaut de retour utilisateur uniquement.
- **Contournement** : recharger la page / se reconnecter, puis relancer la suppression.
- **Statut** : **ouvert**. Piste : afficher un message explicite « session expirée, reconnectez-vous ».

---

## À valider — Dialogues natifs pour les conventions (LOT 4)

- **Description** : la suppression de convention utilise un `confirm()` natif et l'ajout /
  remplacement de document un sélecteur de fichier natif.
- **Impact** : **aucun sur l'intégrité**. Gêne d'UX et d'automatisation des tests uniquement.
- **Contournement** : aucun requis.
- **Statut** : **ouvert**. Piste : modales in-app.

---

## À valider — Règle réseau 30 j + exclusion déclarative (LOT 2)

- **Description** : les opérateurs réseau se voient appliquer un délai de **30 jours** et une
  **exclusion des tableaux déclaratifs**. Cette règle est configurable (`DELAI_RESEAU=30`).
- **Impact** : influe sur le délai autorisé et le périmètre déclaratif des fournisseurs réseau.
  **Base légale 69-21 à confirmer** avant usage en production.
- **Contournement** : ajuster `DELAI_RESEAU` ou ne pas confirmer la classification réseau tant
  que la règle n'est pas juridiquement validée.
- **Statut** : **ouvert — à valider juridiquement**.

---

## À valider — Données héritées pré-LOT 1 (LOT 2)

- **Description** : des dossiers importés **avant** le correctif LOT 1 peuvent contenir des
  données corrompues (fournisseurs « 7596 » / « 5400 », TTC égal à un numéro d'ordre, retards
  aberrants de type +807 j). Le correctif LOT 1 empêche **de nouvelles** corruptions mais ne
  **nettoie pas** l'existant.
- **Impact** : localisé aux dossiers anciens concernés ; les nouveaux imports sont protégés.
- **Contournement** : ré-importer ou nettoyer les dossiers concernés.
- **Statut** : **ouvert** (opération de données, hors périmètre du code 1.0.0).

---

*Aucune de ces réserves n'est corrigée dans la version 1.0.0. La priorisation de leur
traitement figure dans `ROADMAP.md`.*
