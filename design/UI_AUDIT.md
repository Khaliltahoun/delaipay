# DelaiPay — audit de l'interface (avant Incrément 2)

Base : `feature/saas-productization @ 0c4de87`, base de démonstration neuve (données fictives), `*.localhost:4100`.
Captures : `design/screenshots/before/<écran>-<largeur>-<thème>.jpg` — 22 écrans × 1440 / 768 / 390 px × clair / sombre
(136 fichiers). Écrans : connexion, invitation, vue d'ensemble (avec données, vide), clients, synthèse du dossier,
délais de paiement, imports, conventions, sélecteur de périodes, déclaration DGI, visa, exports, alertes, factures en
retard, anomalies, journal d'audit, paramètres (espace, utilisateurs, taux), onboarding, menu mobile, espace « Premium ».

Mesures sur le code : **197** attributs `style=` en ligne dans `app.js` ; **202** tailles de police littérales
(20 valeurs différentes, de 9,5 à 34 px) alors que l'échelle de jetons en compte 9 ; **43** réponses « Introuvable »
brutes côté API ; 4 couleurs codées en dur dans `app.js`. Les couleurs CSS passent toutes par les jetons.

## 1. Constats bloquants pour une impression « premium »

| # | Constat | Où | Preuve |
|---|---|---|---|
| A1 | **Les tableaux comptables débordent même à 1440 px** : la feuille des délais défile horizontalement dans un cadre à hauteur fixe ; les colonnes Retard, Amende et Actions sont hors écran à l'ouverture. | Délais, Déclaration, Retards | `delais-1440-light` |
| A2 | **Mobile : la feuille des délais n'affiche que N° + Fournisseur** — aucun montant, aucun retard ; la page elle-même déborde (403 px pour 390). Idem Clients (colonne Ville coupée), onglets Paramètres coupés. (MOB-1) | Délais, Clients, Paramètres | `delais-390-light`, `clients-390-light`, `settings-390-dark` |
| A3 | **Le chiffre-clé est l'amende, pas le TTC** : le montant TTC concerné (350 964,42 DH), base de la déclaration, est noyé dans une phrase. | Vue d'ensemble, Synthèse | `dash-1440-light`, `client-1440-light` |
| A4 | **Navigation par type technique, pas par métier** : « Cabinet / Dossier / Contrôle » mélange pilotage, saisie et administration ; Fournisseurs et Réseau n'ont pas de page. | Barre latérale | toutes |
| A5 | **Bouton principal incohérent en sombre** : pétrole en clair, cyan pâle en sombre (autre produit). | Toutes les vues sombres | `dash-1440-dark` |
| A6 | **Actions destructives au premier plan** : « Supprimer » rouge répété sur chaque ligne de conventions et en en-tête de la fiche client, au même poids visuel que « Modifier ». (P3-5) | Conventions, Synthèse | `conv-1440-light` |

## 2. Incohérences

**Espacement** — marges de page 32 px en bureau mais 12 px en mobile sans palier tablette ; cartes de la vue d'ensemble
à 16 px de gouttière contre 24 px ailleurs ; en-têtes de carte à hauteur variable (titre seul / titre + sous-titre / + pastille).

**Typographie** — 20 tailles en usage ; les titres de page (22 px) coexistent avec des titres de carte à 15, 14 et 13,5 px ;
les sur-titres en capitales sont utilisés pour trois rôles (fil d'Ariane de page, libellés de KPI, en-têtes de tableau).

**Couleur** — `--late` sert à la fois au nombre « En retard », à l'amende et aux boutons « Supprimer » : le rouge ne porte
plus un seul sens. La couleur de l'espace (`--tenant`) n'est pas contrôlée : une couleur très claire rend le monogramme
illisible (texte blanc).

**Boutons** — cinq variantes visibles sur un même écran (primaire, fantôme, discret, lien, danger-contour) ; trois hauteurs (36 / 28 / 22 px) dont 22 px, trop petit pour une cible tactile ;
certains boutons d'action de ligne sont des liens soulignés, d'autres des boutons.

**Tableaux** — trois modèles de tableau coexistent (feuille dense des délais, tableau de la déclaration à la manière d'un
formulaire, listes en cartes des anomalies) ; en-têtes collants seulement dans le premier ; totaux présents en pied pour
les délais et la déclaration, absents ailleurs ; montants parfois alignés à droite sans chiffres tabulaires dans les cartes.

**États vides / erreurs** — « Impossible d'afficher cette page — Introuvable » (NEW-1) ; « Aucun dossier client — Créez un premier
client » alors que l'espace en a (EMPTY-1) ; détails d'audit en JSON brut (`{"email":"admin@hlz.demo"}`, P3-9) ; statut technique
« rejetee » (P3-8) ; messages empilés à la connexion (P3-6).

**Identité** — le symbole actuel (anneau + quart) se lit comme un indicateur de chargement et devient un beignet à 16 px ; sur
mobile, le mot-symbole de la page de connexion disparaît sur fond sombre (P3-17) ; « Propulsé par DelaiPay » n'apparaît que si
aucune raison sociale n'est renseignée.

**Détails** — pastille « échue depuis 148 j » décalée sous le sous-titre ; bannière « Terminez la configuration · 57 % » pour un
espace déjà en production (P3-1) ; adresse technique `hlz.delaipay.com` et identifiants internes visibles dans Paramètres ;
barre latérale qui s'arrête à la hauteur de la fenêtre dans les pages longues (fond clair visible dessous).

## 3. Constats Cowork repris (hors correctifs de sécurité)
- **P2** : MOB-1 (A2), EMPTY-1, PER-1 (période conservée par navigateur seulement), DATA-1 (compteurs Alertes 35 / Anomalies 38).
- **P3** : NEW-1 (dossier supprimé → « Introuvable »), NEW-2 (« depuis ce poste »), NEW-3 (« Compte désactivé » sur cookie périmé),
  NEW-4 (reprise d'onboarding), NEW-5 (échecs de connexion non audités) ; P3-1 à P3-18 (voir rapport archivé) — traitement et
  reports listés dans `collaboration/DECISIONS.md`.

## 4. Ce qui fonctionne et doit être conservé
Chiffres tabulaires et virgule française partout ; palette sémantique « un sens par couleur » ; bandeau de contexte
(client · période · statut) ; dialogues de confirmation internes (plus de `confirm()` natif) ; squelettes de chargement ;
formulaire de déclaration fidèle au document officiel.
