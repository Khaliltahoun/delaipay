# DelaiPay — Release Candidate 1 (RC1)

**Application de suivi des délais de paiement (loi 69-21) pour cabinets d'expertise comptable.**
Version candidate à la validation métier (Mme Zahra) et au déploiement de production.

---

## ✨ Nouvelles fonctionnalités (cycle « périodes & import »)

- **Contexte de travail global** : cabinet + entreprise + **année + trimestre**, sélectionnable dans le bandeau, mémorisé et validé côté serveur. Bannière de contexte permanente + badge de statut de la période.
- **Calendrier déclaratif** : chaque trimestre est traité le mois suivant sa clôture (T1→avril, T2→juillet, T3→octobre, **T4→janvier N+1**), avec échéance de dépôt SIMPL et jours restants sur le tableau de bord.
- **Isolation stricte par trimestre** : chaque fichier, facture, document et anomalie est rattaché à `(cabinet, entreprise, année, trimestre, lot d'import)`. Un fichier d'un trimestre n'apparaît jamais dans un autre.
- **Cycle de vie & clôture des périodes** : à venir → ouverte → en préparation → à contrôler → prête → validée → déclarée → clôturée. Une période clôturée passe en **lecture seule** ; réouverture réservée à l'administrateur avec **motif obligatoire** et journalisation.
- **Assistant d'import guidé (6 étapes)** : dépôt du fichier → analyse → **mapping des colonnes** (proposé automatiquement avec niveau de confiance, corrigeable) → **prévisualisation** (valides / ignorées / rejetées / doublons, sans écriture) → **confirmation** → résultat. **Rien n'est enregistré avant validation.**
- **Rapport des lignes non importées** (motif + champ + données) exportable en CSV, **annulation d'un import** (transactionnelle) et **modèles de mapping** réutilisables.
- **Incidence reportée** : une facture impayée continue de produire son amende sur les trimestres suivants, **sans déplacer le fichier source** (traçabilité vers la période d'origine).

## 🔒 Sécurité (durcissement)
- En-têtes HTTP : Content-Security-Policy, X-Frame-Options (DENY), X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS (production).
- **Limitation de débit** : connexion (10 tentatives / 15 min) et opérations lourdes (20 / min).
- Validation période + cabinet **côté serveur** sur toutes les routes ; cloisonnement multi-tenant systématique ; anti path-traversal sur les fichiers d'import ; empreinte SHA-256 par lot.
- Mots de passe **bcrypt**, JWT en cookie httpOnly/SameSite/Secure, aucune stack trace exposée, actions sensibles **auditées**.

## 🐛 Corrections majeures (rappel du cycle précédent)
- Détection fiable du **n° de facture** (`N°`, `Facture N°`) et des colonnes (titre + contenu).
- Fin de l'**inversion date facture / date paiement**, rejet des dates aberrantes et des montants aberrants (n° de compte pris pour montant).
- Import **multi-feuilles**, exclusion des feuilles « grand-livre », support du **relevé XML SIMPL**.
- Tableau de bord accéléré (index SQL) et **cache-busting** des assets (versionnés).

## ⚠️ Limitations connues (RC1)
1. Le **tableau de bord cabinet-wide** agrège les montants stockés ; le détail de l'**incidence reportée** est disponible dans la feuille de délais par client/période.
2. Les tableaux offrent tri par colonne serveur et exports (CSV/XML/PDF selon les écrans) ; **pagination avancée / recherche plein-texte** dans tous les tableaux : prévu V2.
3. Un déploiement neuf nécessite `docs/DELAI.xlsx` pour reproduire le client de démonstration (sinon fallback).

## 🗺️ Roadmap V2
- Agrégation de l'incidence reportée au tableau de bord cabinet.
- Pagination + recherche + tri client sur tous les tableaux, export PDF systématique.
- OCR des conventions/factures, alertes e-mail/WhatsApp, portail client, signature électronique du visa.
- Comparaison inter-trimestres (variation %, tendances) sur le tableau de bord.
- Rôles fins (collaborateur/réviseur/associé) et piste d'audit exportable.

---

*RC1 — code sur `main` (voir CHANGELOG_RC1.md). Non-régression du moteur légal garantie (CADOZAT T1 2026 = 7 025,33 DH, test automatisé).*
