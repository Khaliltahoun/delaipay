# DelaiPay — Notes de version 1.0.0

**Date de publication : 28 juillet 2026**

DelaiPay 1.0.0 est la première version stable de production. Elle marque
l'aboutissement de six chantiers d'amélioration (LOTs 1 à 6), tous développés,
testés et validés indépendamment sur navigateur. DelaiPay vous aide à suivre les
**délais de paiement au titre de la loi 69-21**, à calculer automatiquement les
retards et les amendes, et à produire vos déclarations à la DGI en toute confiance.

---

## En bref

- **Vos données d'import sont désormais protégées à la source** : plus de colonnes mal
  interprétées ni de fournisseurs « fantômes ».
- **Les opérateurs réseau se traitent en un clic** (délai adapté + exclusion déclarative).
- **Les conventions fournisseurs sont fiables et honnêtes** : plus de délai prérempli à votre insu.
- **Une seule règle de délai s'applique partout** : le montant de l'amende est cohérent quel que soit le point de saisie.
- **Chaque écran respecte la période sélectionnée** (année / trimestre).
- **Les périodes clôturées sont verrouillées** : vos montants déclarés ne peuvent plus dériver.

---

## Nouveautés et bénéfices

### 1. Des imports fiables, sans corruption silencieuse
L'assistant d'import reconnaît désormais automatiquement les en-têtes des journaux
EDI/SIMPL (fournisseur, montant TTC, ICE, n° de facture) et **refuse tout mapping
incohérent** avant la moindre écriture. Un nom de fournisseur qui serait en réalité un
montant, ou un numéro de ligne pris pour un montant, est bloqué avec un message clair.

**Bénéfice** : vos amendes reposent sur des données propres. Fini les surprises du type
« fournisseur 7596 » ou montants aberrants issus d'une colonne mal alignée.

### 2. Opérateurs réseau en un clic
Pour les factures d'opérateurs réseau (télécoms, eau, électricité), un bouton
**« Réseau ? — confirmer »** applique le délai spécifique de 30 jours, exclut le
fournisseur des tableaux déclaratifs et recalcule automatiquement les périodes ouvertes.
Les fournisseurs qui n'en sont pas (par exemple un distributeur de carburant) ne sont jamais
signalés à tort.

**Bénéfice** : un traitement conforme et traçable, sans manipulation fastidieuse.

### 3. Conventions et documents : clair et honnête
La rubrique « Conventions & documents » archive vos pièces justificatives (PDF, JPEG, PNG)
et vous laisse **saisir explicitement le délai conventionnel** (un entier de 1 à 120 jours,
obligatoire). Aucune extraction automatique n'est promise ni effectuée : ce que vous voyez
est exactement ce qui est enregistré.

**Bénéfice** : plus de délai de 120 jours préinscrit à votre insu ; chaque convention porte
un délai que vous avez saisi et validé.

### 4. Une règle de délai unique, partout
Que le délai provienne d'une convention, d'une règle réseau ou du délai légal par défaut
(60 jours), c'est **la même règle qui s'applique** sur tous les écrans et à tous les points
de saisie (import, saisie manuelle, réparation). En cas de conventions multiples, la plus
récente l'emporte, et le réseau reste prioritaire.

**Bénéfice** : le montant de l'amende est cohérent quel que soit le chemin par lequel la
donnée est entrée.

### 5. Chaque écran respecte la période choisie
Le sélecteur année / trimestre pilote désormais **toutes** les vues : tableau de bord,
portefeuille clients, fiche client et feuille de délais. Fini la « fiche bloquée sur la
dernière période ».

**Bénéfice** : vous voyez exactement le trimestre que vous consultez, sans ambiguïté.

### 6. Périodes clôturées : vos chiffres sont figés
Une fois une période **clôturée**, ses montants, pénalités, déclarations et factures
deviennent immuables : un ajout de convention ou de facture après coup **ne modifie plus**
les chiffres déclarés. Pour toute régularisation, un administrateur peut **rouvrir** la
période — l'action exige un **motif obligatoire** et reste entièrement tracée.

**Bénéfice** : vos déclarations DGI sont stables et défendables. Toute correction laisse une
piste d'audit (qui, quand, pourquoi, valeurs avant/après).

---

## Sécurité et confidentialité

- **Authentification par jeton JWT.**
- **Isolation multi-tenant stricte** : chaque cabinet ne voit que ses propres données ;
  toute tentative d'accès hors périmètre renvoie une page « introuvable ».
- **Immuabilité des périodes clôturées** : les montants déclarés ne peuvent plus être
  modifiés sans réouverture admin motivée et tracée.
- **Journal d'audit** des actions sensibles (clôture, réouverture avec motif, création /
  suppression de convention, classification réseau…), avec valeurs avant/après.
- En-têtes de sécurité durcis (CSP, HSTS en production, anti-clickjacking), limitation du
  nombre de tentatives de connexion, protection contre le path-traversal, aucune information
  technique exposée en cas d'erreur.

---

## Stabilité et qualité

- **160 tests automatisés au vert** couvrant les six lots.
- **Validation indépendante par la revue Claude Cowork** : chaque lot a été testé en
  conditions réelles sur navigateur (aucune anomalie bloquante — aucun P0/P1/P2).
- **Non-régression de référence** : le dossier ORYX AUTO (T1 2026) reste à **7 025,33 DH /
  36 factures** sur l'ensemble des six lots, preuve que le moteur de calcul légal n'a pas dérivé.

---

## Compatibilité

- **Aucune migration de schéma** n'est introduite par les LOTs 1 à 6 : aucune action de base
  de données n'est requise pour passer à la 1.0.0.
- Vos **données existantes sont préservées** ; les corrections d'import ne réparent pas
  rétroactivement d'anciens dossiers importés avant ces correctifs (voir « Points d'attention »).
- Fichiers pris en charge à l'import : journaux Excel (SIMPL/EDI/DGI) et relevés XML SIMPL ;
  pièces de convention en PDF, JPEG et PNG.

---

## Points d'attention

- Les dossiers importés **avant** ces correctifs peuvent contenir des données héritées
  imparfaites : un ré-import ou un nettoyage ponctuel peut être opportun.
- La règle réseau (30 jours + exclusion déclarative) et la gestion des conventions expirées
  restent **à confirmer sur le plan juridique** avant tout usage en production critique.
- Deux points d'affichage mineurs subsistent, sans aucun impact sur les montants déclarés
  (voir `docs/KNOWN_ISSUES.md`).

---

## Déploiement

- **Environnement de production** : VPS **delaipay.hlzconsulting.ma**
- **Version applicative** (`/healthz`) : `e25ef50ee4`
- **Commit** : `17ca7ac` — **Tag** : `v1.0.0`
- **Stack** : Node.js (≥ 24) + Express + `node:sqlite` (zéro dépendance native), JWT, SheetJS,
  docx, pdfkit.

Pour toute question ou régularisation, contactez votre administrateur de cabinet.
