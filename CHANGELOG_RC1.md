# CHANGELOG — RC1

## [RC1] — Release Candidate

### Ajouté
- Sélecteur global **année + trimestre** (bandeau) + badge de statut + bannière de contexte.
- **Calendrier déclaratif** centralisé (`periode.js`) : bornes, mois de traitement (T4→janvier N+1), échéance SIMPL, jours restants ; bloc dédié au tableau de bord.
- **Assistant d'import 6 étapes** : analyse → mapping (auto + confiance) → prévisualisation → confirmation → résultat → annulation ; rapport de rejets CSV ; modèles de mapping.
- Cycle de vie des **périodes déclaratives** + **clôture / réouverture** (admin, motif, audit, lecture seule HTTP 423).
- **Incidence reportée** des impayés sur les trimestres suivants sans déplacer le fichier source.
- Tables `periode_declaration`, `import_lot`, `import_ligne`, `modele_mapping` + migration idempotente (`npm run migrate`).
- Suite de **tests automatisés** (`npm test`, 9 tests) + guide utilisateur.

### Sécurité (durcissement)
- CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS (prod).
- Rate-limiting connexion (10/15 min) et opérations lourdes (20/min).
- Validation période + cabinet côté serveur ; anti path-traversal ; empreinte SHA-256 ; aucune stack trace exposée ; actions sensibles auditées.
- Cache-busting des assets versionnés ; `/healthz` versionné.

### Corrigé
- Détection n° facture / colonnes, inversion dates facture-paiement, montants & dates aberrants, import multi-feuilles, support XML SIMPL, performances tableau de bord (index).

### Préservé (non-régression)
- Moteur légal inchangé — **CADOZAT T1 2026 = 7 025,33 DH** (test automatisé). Aucune donnée client supprimée ; migrations avec sauvegarde préalable.

### Limitations / V2
Voir **RELEASE_NOTES.md** (incidence au dashboard cabinet, pagination/recherche généralisées, OCR, alertes, portail client, signature électronique).
