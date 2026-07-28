# DelaiPay — Feuille de route (Roadmap)

**Référence : version 1.0.0 (28 juillet 2026)**

Ce document esquisse les évolutions envisagées après la 1.0.0. Il s'agit d'une
**proposition d'orientation**, non d'un engagement de livraison : rien n'est développé ici,
les périmètres et priorités restent à arbitrer avec le cabinet.

Principes directeurs conservés : **zéro dépendance native** (`node:sqlite`), **honnêteté
fonctionnelle** (aucune promesse non tenue), **non-régression du moteur légal** (référence
CADOZAT), **immuabilité des périodes clôturées**.

---

## Version 1.1 — Finition et robustesse

*Objectif : solder les réserves connues de la 1.0.0 et polir l'expérience, sans nouvelle
fonctionnalité majeure.*

- **LOT 7 — Traitement des réserves P3**
  - Persistance stricte de la période sélectionnée au rafraîchissement (P3-1, LOT 5).
  - Figer le rendu de la feuille de délais (snapshot) sur période clôturée pour supprimer
    l'incohérence d'affichage transitoire (P3-2, LOT 6).
- **LOT 8 — Retours utilisateur et UX**
  - Message explicite en cas de session expirée (fin du 401 silencieux à la suppression de convention).
  - Modales in-app en remplacement des dialogues natifs (`confirm()`, sélecteur de fichier).
  - Distinction « Délai obligatoire » (vide) vs « Délai invalide » (hors plage) dans les toasts.
- **LOT 9 — Hygiène des données héritées**
  - Assistant de détection et de ré-import/nettoyage des dossiers corrompus pré-LOT 1
    (fournisseurs numériques, TTC aberrants, retards impossibles).

## Version 1.2 — Conformité et productivité

*Objectif : consolider la valeur métier pour le cabinet et sécuriser les règles juridiques.*

- **LOT 10 — Validation juridique outillée**
  - Paramétrage assumé de la règle réseau (`DELAI_RESEAU`) et de l'exclusion déclarative,
    avec traçabilité de la base légale retenue.
  - Politique de conventions expirées configurable (maintien du délai vs retour aux 60 j légaux).
- **LOT 11 — Notifications d'échéances**
  - Alertes (in-app / e-mail) sur les échéances déclaratives SIMPL et les retards significatifs.
- **LOT 12 — Exports comptables enrichis**
  - Exports normalisés (Excel/CSV/PDF) alignés sur les tableaux DGI et exploitables en
    liasse ; export du journal d'audit d'une période.
- **LOT 13 — Tableau de bord cabinet**
  - Vue consolidée multi-clients (portefeuille) : exposition au risque, amendes agrégées,
    échéances à venir, taux de conventions renseignées.

## Version 2.0 — Ouverture et échelle

*Objectif : franchir un palier d'usage (multi-utilisateurs, intégrations, extraction réelle).*

- **LOT 14 — Multi-utilisateurs et rôles fins**
  - Gestion de plusieurs comptes par cabinet, rôles granulaires (admin / gestionnaire /
    lecture seule), permissions par client et par action.
- **LOT 15 — OCR réel optionnel**
  - Extraction automatique du délai depuis les conventions scannées, **strictement opt-in**,
    présentée comme une **proposition à valider** (jamais appliquée en silence), dans le respect
    de la Stratégie B : aucune dépendance imposée ni promesse non tenue.
- **LOT 16 — API publique**
  - API authentifiée (import, consultation des délais, déclarations) pour l'intégration avec
    les outils comptables tiers ; documentation et jetons par cabinet.
- **LOT 17 — Portail / signature**
  - Espace client léger et flux de visa/signature électronique des déclarations.

---

*Cette feuille de route sera révisée à chaque jalon en fonction des retours des cabinets et
des évolutions réglementaires (loi 69-21).*
