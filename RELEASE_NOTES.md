# DelaiPay — Release Candidate 1 (RC1)

**Application de suivi des délais de paiement (loi 69-21) pour cabinets d'expertise comptable.**
Version candidate à la validation métier (Mme Zahra) et au déploiement de production.

---

## 🆕 Nouveau (revue des doublons)

- **DelaiPay conserve les factures ressemblant à des doublons. Elles sont signalées pour vérification afin de ne pas supprimer par erreur des paiements partiels, factures scindées ou échéances multiples.**
- **Un utilisateur peut confirmer l'alerte ou la marquer comme faux positif. Cette revue ne supprime ni ne fusionne aucune facture.**
- Dans la feuille de délais : badge **« Doublon ? »** (à vérifier), puis, après revue, **« Doublon confirmé »** ou disparition de l'alerte (faux positif). Les actions **Confirmer le doublon** / **Marquer comme faux positif** se trouvent dans le détail de la facture (avec demande de confirmation).
- Les trois modes d'import (assistant, import direct, relevé XML) signalent les doublons de façon identique, avec une anomalie interne de gravité basse.
- **Les doublons supprimés par d'anciennes versions ne peuvent être récupérés qu'en réimportant la source originale.**

## 🆕 Nouveau (opérateurs de réseau)

- **Délai spécifique de 30 jours** pour les opérateurs de télécom, eau, électricité et régies / SRM, et **exclusion des tableaux déclaratifs** (déclaration, exports, visa) avec **résumé des exclusions** — factures conservées et visibles en suivi interne.
- **Classification confirmée** : alias (Maroc Telecom/IAM, Orange/Médi Telecom, inwi/Wana, SRM…), ICE/IF/RC prioritaires ; un match par nom seul est *proposé* et doit être confirmé (pas d'exclusion automatique sur nom ambigu).
- API de classification (confirmer, audité) + rapport de simulation d'impact (lecture seule). Badges « Réseau — 30 j » / « Hors tableau déclaratif » dans la feuille de délais.

## 🆕 Nouveau (délai constaté à la clôture)

- **Délai constaté arrêté au dernier jour du trimestre** : une facture **impayée** (ou **payée après la clôture**) est désormais calculée jusqu'au dernier jour du trimestre déclaré, et non plus jusqu'à la date du jour ni jusqu'à un paiement postérieur. Exemple : facture du **15/04** non payée au **30/06** → **76 jours** en T2 ; si payée le **10/07**, le calcul T2 **reste arrêté au 30/06**.
- Fonction centrale unique côté backend (`getDateArreteFacture`) utilisée partout (feuille de délais, dashboard, déclaration, exports) — le frontend ne recalcule pas.
- Feuille de délais enrichie : colonnes **Arrêté au** / **Délai constaté**, état (payée / impayée à la clôture / payée après clôture) et infobulle. Indicateurs *délai constaté*, *délai autorisé* et *jours de retard* clairement distincts.
- **Montants d'amende inchangés** pour les trimestres clôturés (CADOZAT = 7 025,33 DH).

## 🆕 Nouveau (cycle « conventions »)

- **Import Excel des conventions fournisseurs** : dans le menu Conventions, un bouton **Télécharger le modèle** (classeur à 2 feuilles, Instructions + Conventions) et un bouton **Importer une liste Excel**. L'import crée fournisseurs et conventions en une passe, **sans exiger le PDF** ; le document signé s'ajoute plus tard (statut **« Document manquant »** → **Ajouter le PDF**).
- **Règles métier robustes** : fournisseur identifié par **ICE → IF → RC → nom** ; délai d'une fourchette = **plus grand** (« 60 A 120 J » = 120) ; délai **> 180 j** à vérifier ; délai invalide rejeté ; **Convention = NON** → aucune convention (délai légal 60 j).
- **Dédoublonnage & conflits sans écrasement** : convention identique = doublon ; délai/dates différents = **conflit à vérifier** ; le PDF déjà rattaché n'est jamais remplacé sans confirmation.
- **Rapport d'import lisible** (à l'écran + **export CSV**) : conventions créées, fournisseurs créés/existants, doublons, conflits, sans convention, à vérifier, rejetées, ignorées, avec le motif ligne par ligne.
- **Import transactionnel** : tout ou rien (aucune convention partielle en cas d'erreur) ; chaque import est tracé (lot + empreinte SHA-256) et chaque convention reliée à son lot.

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
