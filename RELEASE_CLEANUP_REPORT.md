# DelaiPay — Rapport de nettoyage de release (v1.0.0)

**Date : 28 juillet 2026 — RAPPORT UNIQUEMENT, AUCUNE SUPPRESSION EFFECTUÉE.**

Ce document analyse les fichiers de la **racine** du dépôt et les répertoires de travail,
et signale les candidats à la suppression ou à l'archivage en vue de la release 1.0.0.
Il n'exécute **aucune** suppression : chaque décision reste à valider manuellement.

Niveaux de risque : **faible** (suppression sans effet fonctionnel) — **moyen** (contenu
historique/référence possiblement utile).

---

## A. Fichiers versionnés (tracked) — candidats au nettoyage

Ces fichiers sont **dans le dépôt Git** ; leur suppression modifie le dépôt.

| Chemin | Pourquoi candidat | Risque | Recommandation |
|--------|-------------------|--------|----------------|
| `CHANGELOG_RC1.md` | Changelog de la Release Candidate 1, **remplacé** par le `CHANGELOG.md` v1.0.0 (section « Historique antérieur » incluse). Doublon obsolète. | faible | Supprimer (ou archiver) après publication de la 1.0.0. |
| `RELEASE_NOTES.md` | Notes de version **RC1**, remplacées par `RELEASE_NOTES_v1.0.0.md`. Le nom générique prête à confusion avec les nouvelles notes. | faible | Supprimer, ou renommer en `RELEASE_NOTES_RC1.md` et archiver. |
| `RECAP_DELAIPAY.md` | Récapitulatif interne (27 Ko) de suivi projet — document de travail, non destiné aux utilisateurs finaux. | moyen | Déplacer hors racine (ex. `collaboration/` ignoré) ou supprimer si l'info est reprise dans le CHANGELOG. |
| `SCRIPT_DEMO_ZAHRA.md` | Script de démonstration nominatif (RC1) — contenu ponctuel, non pérenne. | faible | Archiver hors dépôt ou supprimer. |
| `GUIDE_UTILISATEUR_PERIODES.md` | Guide utilisateur des périodes — **potentiellement encore utile**. À conserver si à jour, sinon à intégrer à une doc utilisateur unifiée. | moyen | Conserver et vérifier l'actualité vs LOT 5/6, ou regrouper dans `docs/`. |

## B. Fichier local non suivi (untracked, non ignoré)

| Chemin | Pourquoi candidat | Risque | Recommandation |
|--------|-------------------|--------|----------------|
| `HANDOFF.md` | Document de passation apparaissant en **untracked** (`?? HANDOFF.md`), non versionné et **non couvert** par `.gitignore`. Coordination interne, sans valeur pour la release. | faible | Supprimer localement, ou l'ajouter à `.gitignore` s'il doit rester en local, ou le déplacer dans `collaboration/` (déjà ignoré). |

## C. Répertoires et fichiers déjà ignorés (hors dépôt)

Ces éléments sont **exclus du dépôt** par `.gitignore` : ils ne polluent pas les livrables
versionnés. Ils restent présents sur le poste local et peuvent être nettoyés pour alléger le
répertoire de travail, **sans effet sur Git**.

| Chemin | Statut `.gitignore` | Pourquoi candidat (local) | Risque | Recommandation |
|--------|---------------------|---------------------------|--------|----------------|
| `.playwright-mcp/` | ignoré (`.playwright-mcp/`) | ~207 entrées de traces/artefacts de tests navigateur MCP — purement transitoire. | faible | Purger localement (régénéré à la demande). |
| `.DS_Store` | ignoré (`.DS_Store`) | Métadonnée Finder macOS, aucun intérêt. | faible | Supprimer localement. |
| `back.jpg` | ignoré (`back.jpg`) | Image d'arrière-plan locale non versionnée. | faible | Conserver si utilisée en local ; sinon supprimer. |
| `DelaiPay_Cahier_des_charges.pdf`, `DelaiPay_Maquettes_Ecrans.pdf`, `DelaiPay_Synthese_Validation.pdf` | ignoré (`*.pdf`) | PDF de cahier des charges / maquettes — documents de conception, lourds (jusqu'à ~3,6 Mo). | moyen | Archiver hors du répertoire projet ; ne pas supprimer sans copie de référence. |
| `CAHIER_DES_CHARGES_DelaiPay.md` | ignoré (nommément) | Cahier des charges (~192 Ko) — référence de conception. | moyen | Conserver comme archive de référence, hors livrable. |
| `docs/` | ignoré (`docs/`) | Contient des **données clients réelles** (CADOZAT : xlsx, pdf, docx) + `PROMPT_design_*`. **Attention** : le fichier `docs/KNOWN_ISSUES.md` demandé pour cette release y est déposé et sera donc **hors dépôt** — à déplacer hors de `docs/` (ou à désignorer explicitement) s'il doit être versionné. | moyen | Ne pas versionner les données clients ; statuer sur l'emplacement de `KNOWN_ISSUES.md`. |
| `DELAI DE PAIEMENT/` | ignoré (`DELAI DE PAIEMENT/`) | Dossier de données/documents clients. | moyen | Conserver hors dépôt ; ne pas supprimer sans accord. |
| `collaboration/` | ignoré (`collaboration/`) | Coordination Claude Code ↔ Cowork (rapports, handoffs, décisions). Références internes. | faible | Conserver (historique de validation utile), hors dépôt. |
| `.claude/` | ignoré (`.claude/`) | Configuration locale de l'agent. | faible | Conserver en local. |
| `app/data/`, `app/uploads/` | ignoré | Données d'exécution et fichiers importés. | moyen | Ne jamais versionner ; sauvegardes gérées séparément (`app/data/backups/`). |
| `*.log`, `*.tmp` | ignoré | Journaux et fichiers temporaires. | faible | Purge locale libre. |

---

## D. Point d'attention important — `docs/` est ignoré

Le répertoire `docs/` est **entièrement exclu** du dépôt (`.gitignore`). Le fichier
`docs/KNOWN_ISSUES.md` produit pour la release 1.0.0 y réside : il **ne sera donc pas
versionné** en l'état. Deux options :

1. **Le déplacer** à la racine ou dans un sous-dossier non ignoré (ex. `documentation/`) s'il
   doit accompagner le code dans le dépôt.
2. **L'exclure explicitement** de l'ignore (`!docs/KNOWN_ISSUES.md`) tout en gardant les
   données clients ignorées.

Les autres livrables de release (`CHANGELOG.md`, `RELEASE_NOTES_v1.0.0.md`, `ROADMAP.md`,
`RELEASE_CLEANUP_REPORT.md`) sont à la racine et **seront versionnés** normalement.

---

## E. Synthèse des recommandations

- **À supprimer / archiver après publication (risque faible)** : `CHANGELOG_RC1.md`,
  `RELEASE_NOTES.md` (RC1), `SCRIPT_DEMO_ZAHRA.md`, `HANDOFF.md`.
- **À déplacer / statuer (risque moyen)** : `RECAP_DELAIPAY.md`, `GUIDE_UTILISATEUR_PERIODES.md`,
  et l'emplacement de `docs/KNOWN_ISSUES.md`.
- **Purge locale sans effet Git (risque faible)** : `.playwright-mcp/`, `.DS_Store`, logs/temp.
- **À conserver hors dépôt (archives / données clients)** : PDF de conception, cahier des
  charges, `DELAI DE PAIEMENT/`, `docs/` (données clients), `collaboration/`.

*Aucune action de suppression n'a été réalisée. Ce rapport est purement informatif.*
