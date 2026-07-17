# Changelog — DelaiPay

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
