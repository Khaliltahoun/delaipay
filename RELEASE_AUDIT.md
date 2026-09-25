# RELEASE AUDIT — DelaiPay v1.0.0

_Audit final de préparation de la Release 1.0 — 2026-07-28. Aucune règle métier, route, calcul, migration, modèle ou service n'a été modifié : cette phase est **exclusivement documentaire**._

## 1. Identité de version
| Élément | Valeur |
|---|---|
| Version applicative (`package.json`) | `1.0.0` |
| Version `/healthz` (hash assets frontend) | `e25ef50ee4` |
| Commit HEAD (`main`) | `17ca7ac` |
| Tag existant | `v1.0.0` (préservé, non écrasé) |
| Tag de cette release documentaire | `v1.0.0-release` |
| Dernier déploiement | VPS `delaipay.hlzconsulting.ma` (Nginx reverse-proxy HTTPS), version servie `e25ef50ee4` |

## 2. Architecture (résumé)
- **Backend** : Node.js ≥ 22.5, Express, **`node:sqlite`** (SQLite intégré, aucun ORM), JWT en cookie httpOnly (`bcryptjs`), upload `multer`, Excel `SheetJS (xlsx)`, Word `docx`, PDF `pdfkit`, XML `xml-js`. **Aucune étape de build.**
- **Frontend** : SPA en JavaScript vanilla (routage par hash, `state` global, période active `state.period` propagée via `perQuery()`), assets versionnés `?v=<hash>`.
- **Modules `app/src`** (14) : `server, api, auth, security, db, calc, reseau, periode, importer, visa, seed, migrate, repair, util`.
- Détail : `docs/ARCHITECTURE.md`, `docs/BUSINESS_RULES.md`, `docs/API_REFERENCE.md`, `docs/DATABASE.md`.

## 3. Métriques du dépôt
| Métrique | Valeur |
|---|---|
| Fichiers suivis Git (avant docs) | 35 |
| Modules backend `app/src/*.js` | 14 fichiers · **4 082 lignes** |
| Frontend `app/public` (js/css/html) | **2 057 lignes** |
| Tests `app/test/delaipay.test.js` | **1 801 lignes · 160 tests** |
| Routes API documentées | **63** (+ `GET /healthz`) |
| Tables base de données | **17** |
| Dépendances de production | **9** |
| Diagrammes Mermaid | 3 (ARCHITECTURE) + 1 erDiagram (DATABASE) |
| Règles métier documentées | 26 |

## 4. Couverture / stratégie de tests
- Framework : **`node:test`** (natif), lancement `npm test`. **160 tests**, 0 échec, 0 skip (avec la fixture présente).
- Pas d'outil de couverture instrumentée (`c8`/`nyc`) configuré → **couverture non chiffrée** ; la couverture fonctionnelle est assurée par lot (LOT 1→6) + non-régression.
- **Non-régression de référence** : jeu de démonstration fictif ORYX AUTO → **7 025,33 DH / 36 factures** (fixture versionnée, aucun `skip`).
- Base de test **isolée par process** (`DB_PATH` dans `os.tmpdir()`).
- Détail : `docs/TESTING.md`.

## 5. Historique LOT 1 → LOT 6 (tous validés Cowork, déployés)
| LOT | Commit | Objet | Statut |
|---|---|---|---|
| 1 | `75c22ee` | Import sécurisé (auto-mapping, validation bloquante) | VALIDÉ |
| 2 | `257e374` | Opérateurs de réseau (30 j + exclusion déclarative) | VALIDÉ |
| 3 | `21e2c54` | Conventions & documents (Stratégie B, sans OCR) | VALIDÉ |
| 4 | `513e0ab` | Intégrité métier des conventions (règle de délai unique) | VALIDÉ |
| 5 | `011031e` | Cohérence des périodes (période active unique) | VALIDÉ (réserve P3) |
| 6 | `17ca7ac` | Clôture / réouverture (immuabilité, réouverture tracée) | VALIDÉ (réserve P3) |

## 6. Réserves connues (P3 — aucune correction dans cette phase)
1. **LOT 5 (P3)** — au rafraîchissement, une période sélectionnée **vide / hors périodes disponibles** n'est pas restaurée (repli sur la période de travail). Sans impact d'intégrité.
2. **LOT 6 (P3)** — la **feuille de calcul** recalcule en direct l'affichage (« délai autorisé », KPI « retard moyen ») sur une période clôturée, alors que l'amende et la déclaration restent figées. Incohérence d'affichage transitoire, **sans impact** sur les montants déclarés.
3. **À valider juridiquement** (hors P3 pur) : règle réseau **30 j + exclusion** (LOT 2) ; validité **par statut** d'une convention expirée (`date_fin` non contraignante, LOT 4).
4. **P3 UX** : `DELETE` convention → 401 silencieux sur session expirée ; dialogues natifs `confirm()` / sélecteur de fichier.

Détail : `docs/KNOWN_ISSUES.md`.

## 7. Dette technique
- **Clés étrangères logiques** (colonnes `TEXT` sans `REFERENCES`) : intégrité portée par le code applicatif.
- **Migrations sans table de versions** : idempotence par `IF NOT EXISTS` + `ALTER … ADD COLUMN` sous `try/catch`. Suffisant à ce stade, à formaliser si le schéma se complexifie.
- **Pas de couverture chiffrée** ni de CI automatisée documentée.
- **Frontend monolithique** (`app/public/js/app.js`, un seul fichier) — lisible mais volumineux.
- Fichiers de release historiques redondants à la racine (voir `RELEASE_CLEANUP_REPORT.md`).

## 8. Forces
- Cœur métier **stable, testé (160), validé par campagnes Cowork** et déployé.
- **Immuabilité** des périodes clôturées garantie côté serveur (point de passage unique `recomputePeriod`).
- **Règle de délai unique** (`activeConventionFor` → `resolveDelaiAutorise`) appliquée partout.
- **Zéro dépendance native, zéro build** → déploiement simple et reproductible.
- **Audit** systématique (avant/après) des actions sensibles.

## 9. Faiblesses
- Couverture non instrumentée ; pas de pipeline CI.
- Réserves P3 d'affichage encore ouvertes (non bloquantes).
- Deux règles métier restent à **valider juridiquement**.
- Absence de rôles fins (admin vs collaborateur seulement).

## 10. Stratégie de branches (Phase 14 — proposition, non appliquée)
État actuel : **une seule branche `main`** (+ `origin/main`), historique linéaire par LOT.

Proposition pour l'après-1.0 :
```
main                 # production, taguée (v1.0.0, v1.0.x)
release/v1.0         # stabilisation/correctifs de la 1.0 (branche de maintenance)
develop              # intégration des LOTs 7+
feature/<lot>        # un LOT = une branche, fusionnée dans develop via PR
hotfix/<sujet>       # correctif urgent depuis main, rétro-fusionné
```
Règle : `main` toujours déployable ; tag à chaque release ; pas de commit direct sur `main` hors hotfix. **Aucune branche n'a été créée ni modifiée dans cette phase.**

## 11. Recommandations (avant LOT 7)
1. Trancher les 2 validations juridiques (réseau 30 j ; expiration des conventions).
2. Traiter les 2 réserves P3 d'affichage dans une **v1.0.1** de maintenance.
3. Ajouter une **CI** (`npm test`) + couverture (`c8`) et un contrôle de non-régression ORYX AUTO automatisé.
4. Nettoyer la racine selon `RELEASE_CLEANUP_REPORT.md` (rapport uniquement, rien supprimé ici).
5. Mettre en place `develop` + `feature/*` avant d'ouvrir le LOT 7.

## 12. Conformité de la phase Release (Phase 16)
✔ Aucun fichier `app/src/**`, `app/public/**`, `app/test/**` modifié.
✔ Aucune route, aucun calcul, aucune migration, aucun modèle, aucun service, aucun contrôleur ou composant métier touché.
✔ Seuls ajouts : **documentation** (`docs/*.md`, `*.md` racine), **rapports**, **tag Git**, et l'ajustement `.gitignore` **strictement nécessaire** pour versionner la documentation (les fichiers clients de `docs/` restent ignorés).
