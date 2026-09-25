# Prompts de design — DelaiPay

> Prompts prêts à coller dans **Claude** (mode artefact / frontend) pour générer une maquette
> premium de la plateforme DelaiPay. Contient : ① le prompt **complet**, ② une variante **courte**
> (itérations rapides), ③ une variante **mono-écran** (tableau de bord exécutif), ④ conseils d'itération
> et ⑤ le jeu de **données de démonstration ORYX AUTO (fictives)** à réutiliser.
>
> Fonctionne aussi avec v0 / Lovable (retirer la mention « artefact »). Pour une sortie React/Tailwind,
> ajouter en tête : « Utilise React + Tailwind dans un seul fichier ».

---

## ① Prompt COMPLET (maquette multi-écrans)

```text
RÔLE
Tu es un designer produit senior (SaaS B2B fintech) et développeur front-end. 
Génère un PROTOTYPE HTML interactif, haut de gamme, "fini et élégant", d'une plateforme 
web nommée DelaiPay. Rendu dans un artefact autonome (voir CONTRAINTES).

CONTEXTE PRODUIT
DelaiPay est un SaaS multi-tenant destiné aux CABINETS D'EXPERTISE COMPTABLE marocains. 
Il automatise le suivi des DÉLAIS DE PAIEMENT (loi marocaine 69-21) : import des achats, 
calcul des retards et pénalités, déclaration trimestrielle à la DGI et visa du commissaire 
aux comptes. Utilisatrice principale : experte-comptable exigeante, non technique. 
Ton visuel : confiance, rigueur, calme, sérieux "cabinet premium" — jamais gadget.

DIRECTION ARTISTIQUE (à respecter strictement)
- Style : fintech éditorial, sobre et raffiné. Beaucoup d'espace blanc, hiérarchie 
  typographique forte, données financières ultra-lisibles. Zéro effet "template Bootstrap".
- Palette (utilise ces valeurs) :
  • Primaire (petrol/teal profond) : #0E4D64 ; variante foncée #0A3A4D
  • Accent (laiton/or, à DOSER, ~5% de la surface) : #B4884D
  • Encre : #1E2A32 ; texte secondaire : #5A6B78 ; lignes : #D7E1E8
  • Fonds doux : #F3F7F9 et #E8F0F3 ; blanc pur pour les cartes
  • Sémantique / segmentation du risque (langage visuel central) :
    Vert #2E9E5B (normal) · Jaune #E4B62C (approche) · Orange #E08A2B (attention) · 
    Rouge #D2452F (retard) · Rouge foncé #8E1F13 (pénalités importantes)
- Typographie : sans-serif moderne et net (stack système : -apple-system, "Segoe UI", 
  Inter, Arial). Titres en 700/800. IMPORTANT : chiffres financiers en 
  font-variant-numeric: tabular-nums, alignés à droite, séparateurs de milliers FR 
  (espace) et virgule décimale (ex. 350 964,45 DH).
- Composants : barre latérale sombre (dégradé petrol) avec sections et item actif souligné 
  d'un liseré or ; barre supérieure claire (fil d'Ariane + recherche globale + sélecteur de 
  cabinet + cloche de notifications + avatar) ; cartes KPI ; tableaux de données avec 
  en-tête collant, lignes zébrées, pastilles de statut, badges ; filtres en "pills" ; 
  panneaux latéraux (drawers) pour le détail ; onglets ; toasts ; états vides soignés.
- Détails de finition : grille 8px, rayons 8–10px, ombres TRÈS subtiles, bordures 1px 
  #D7E1E8, états hover/focus visibles, focus-ring accessible, contraste AA. 
  Icônes : jeu cohérent, style "outline", épaisseur de trait constante (SVG inline).
- Micro-interactions discrètes (survol de ligne, transition de drawer). Rien de tape-à-l'œil.

CONTRAINTES TECHNIQUES
- UN SEUL fichier HTML autonome : CSS et JS INLINE, AUCUNE dépendance externe (pas de CDN, 
  pas de police distante, pas d'image distante). Icônes en SVG inline. Compatible artefact.
- Responsive (desktop d'abord, dégrade proprement) ; tableaux larges scrollables dans leur 
  conteneur (la page ne scrolle jamais horizontalement).
- Mode clair ET sombre (respecte prefers-color-scheme, style les deux).
- Prêt pour le FR et l'AR : structure compatible RTL (dir="rtl" ne doit pas casser la mise 
  en page). Interface en français.
- Navigation CLIQUABLE entre les écrans via la barre latérale (afficher/masquer les vues).
- Accessibilité : sémantique HTML, aria sur les contrôles, navigation clavier.

ÉCRANS À PRODUIRE (prototype cliquable, mêmes chrome/latérale partout)
1. Tableau de bord EXÉCUTIF : cartes KPI (clients, factures du trimestre, en retard, 
   montant TTC concerné, amende potentielle, conventions manquantes) ; graphe d'évolution 
   mensuelle ; heatmap risque (entreprise × mois) ; "Top entreprises à risque" ; 
   "Échéances de déclaration à venir". Data-viz en SVG inline, palette ci-dessus, lisible 
   en clair/sombre.
2. Portefeuille CLIENTS : tableau (raison sociale, ICE, ville, CA, assujettie O/N, régime 
   A/T, expert responsable, factures en retard, statut de risque en pastille).
3. FEUILLE DE CALCUL DES DÉLAIS (écran clé) : tableau avec colonnes N° facture, 
   fournisseur (ICE), nature, TTC, date facture, date paiement, DÉLAI (jours écoulés), 
   CONVENTION (badge 60 j / 120 j), RETARD (rouge si positif, vert si ≤ 0), "à déclarer" 
   (pastille), Amende. Barre de filtres (RETARD>0 / Tous / Convention absente). Ligne de 
   total. Bandeau KPI en tête.
4. DÉCLARATION DGI : reproduction élégante du formulaire officiel — en-tête (année, période, 
   CA HT, activité), identité déclarant (IF/ICE/RC/adresse), état des factures non payées 
   (IF fournisseur, raison sociale, TTC, non payées, payé hors délai, amende par ligne), 
   récapitulatif, "MONTANT À VERSER" mis en avant, case de visa (commissaire aux comptes / 
   expert-comptable), date d'édition. Actions : Exporter PDF · Générer XML EDI · Envoyer en 
   visa. Badge "Brouillon".
5. GÉNÉRATEUR DE VISA : deux colonnes — formulaire (type CAC/EC auto, période, montant visé 
   auto, type de conclusion, référence article/directive, signataire, lieu/date) + APERÇU en 
   direct du texte du visa.
6. CONVENTIONS + OCR : liste des conventions (fournisseur, délai, statut : Trouvée / Absente 
   / Expirée / Bientôt expirée) + panneau de capture montrant un scan à gauche et les champs 
   extraits par OCR à droite (parties, IF/RC/ICE, délai 120 j, dates) avec score de confiance.
7. CENTRE D'ALERTES & ANOMALIES : liste typée (retard, échéance de déclaration, convention 
   manquante, anomalie de saisie), sévérité, date, action.

DONNÉES RÉELLES À UTILISER (réalisme — ne pas inventer de "lorem")
- Cabinet : HLZ Consulting. Utilisatrice/CAC : Leïla Amrani, persona fictive (avatar "LA").
- Client affiché : STE ORYX AUTO SARL — IF 99000017 — ICE 009990000000017 — RC 9901 — 
  15 BD DES CEDRES, Casablanca — CA HT 60 457 607,22 DH — régime trimestriel + 
  visa commissaire aux comptes. Période : Trimestre 1 2026.
- Totaux : montant TTC concerné 350 964,45 DH ; amende du trimestre 7 026,00 DH ; 
  montant à verser 7 026,00 DH.
- Lignes de factures (fournisseur ; TTC ; date facture ; date paiement ; convention ; 
  retard(j) ; amende) :
  • KORAL ENGINS SA (IF 99100011) ; 245 595,80 ; 27/11/25 ; 30/03/26 ; 120 j ; +3 ; 5 525,91
  • BETA EXPRESS SARL (IF 99100002) ; 3 050,00 ; 31/05/25 ; 15/01/26 ; 120 j ; +109 ; 25,93
  • HORIZON PNEUMATIQUES (IF 99100008) ; 6 600,00 ; 30/06/25 ; 17/02/26 ; 120 j ; +112 ; 112,20
  • JASMIN LUBRIFIANTS SA (IF 99100010) ; 37 140,00 ; 31/10/25 ; 20/01/26 ; 60 j ; +21 ; 315,69
  • GRENAT DISTRIBUTION (IF 99100007) ; 3 440,00 ; 24/10/25 ; 09/01/26 ; 60 j ; +17 ; 29,24
  • ETOILE CARROSSERIE (IF 99100005) ; 6 600,00 ; 02/05/25 ; 13/01/26 ; 120 j ; +136 ; 56,10
  • ALPHA PIECES AUTO (IF 99100001) ; 1 500,90 ; 24/11/25 ; 13/03/26 ; 120 j ; −11 ; — (dans les délais)
  • FALAISE MATERIAUX (IF 99100006) ; 43 889,20 ; 31/10/25 ; 12/01/26 ; 120 j ; −47 ; — (dans les délais)
- Visa : "Sans observation" ; article 2.78 ; Directive OEC du 06/10/2024 ; 
  Marrakech, le 30/04/2026 ; signataire Leïla Amrani (persona fictive).

BARRE DE QUALITÉ ("bien fini")
- Alignement parfait, rythme d'espacement régulier, tout le contenu est réaliste et cohérent.
- Les chiffres financiers sont en chiffres tabulaires alignés à droite.
- La segmentation couleur (Vert→Rouge foncé) est un vrai langage visuel, cohérent partout.
- Chaque écran a un titre, un sous-titre contextuel, des états hover et un état vide pensé.
- Le résultat doit ressembler à un vrai produit SaaS premium livrable à un client, PAS à une 
  démo générique.

À ÉVITER
- Aucun placeholder "lorem ipsum" ; aucune couleur criarde ; pas de dégradés arc-en-ciel ; 
  pas d'emojis dans l'UI de production (icônes SVG à la place) ; pas de dépendance externe.

LIVRABLE
Fournis le fichier HTML complet, prêt à ouvrir. Commence par un bref paragraphe décrivant 
les partis pris de design, puis le code. Rends l'écran "Feuille de calcul des délais" 
affiché par défaut.
```

---

## ② Variante COURTE (itérations rapides)

```text
Crée un prototype HTML autonome (CSS/JS inline, sans dépendance externe, compatible artefact), 
d'un SaaS premium pour cabinets comptables marocains nommé DelaiPay (suivi des délais de 
paiement, loi 69-21). Style fintech éditorial, sobre et élégant : palette petrol #0E4D64 + 
accent or #B4884D + neutres, chiffres financiers en tabular-nums alignés à droite, 
segmentation risque Vert→Rouge foncé (#2E9E5B/#E4B62C/#E08A2B/#D2452F/#8E1F13). 
Barre latérale sombre + top bar (recherche, sélecteur de cabinet, avatar "ZH"). 
Mode clair + sombre. Écran affiché : "Feuille de calcul des délais" (tableau : facture, 
fournisseur+ICE, TTC, dates, DÉLAI, CONVENTION 60/120, RETARD coloré, amende ; KPIs en tête ; 
ligne de total). Données de démonstration : STE ORYX AUTO SARL, T1 2026, TTC concerné 350 964,45 DH, 
amende 7 026,00 DH ; fournisseurs KORAL ENGINS/BETA EXPRESS/HORIZON PNEUMATIQUES/JASMIN LUBRIFIANTS/GRENAT DISTRIBUTION. 
Zéro lorem ipsum, rendu "prêt client".
```

---

## ③ Variante MONO-ÉCRAN — Tableau de bord exécutif

```text
Crée un tableau de bord EXÉCUTIF en HTML autonome (CSS/JS et icônes SVG inline, aucune 
dépendance externe, compatible artefact) pour DelaiPay, SaaS de suivi des délais de paiement 
(loi 69-21) destiné aux cabinets comptables marocains. Public : experte-comptable.

Style : fintech premium, sobre, beaucoup de blanc. Palette petrol #0E4D64, foncé #0A3A4D, 
accent or #B4884D (dosé), encre #1E2A32, secondaire #5A6B78, lignes #D7E1E8, fonds #F3F7F9. 
Segmentation risque : Vert #2E9E5B, Jaune #E4B62C, Orange #E08A2B, Rouge #D2452F, 
Rouge foncé #8E1F13. Chiffres en tabular-nums, format FR (350 964,45 DH). Mode clair + sombre.

Layout : barre latérale sombre (Tableau de bord actif, Clients, Factures, Conventions, 
Délais & calcul, Déclarations DGI, Visa, GED, Alertes) + top bar (fil d'Ariane "Cabinet HLZ ▸ 
Portefeuille", recherche, sélecteur de cabinet, cloche, avatar "ZH").

Contenu :
- Rangée de cartes KPI : Clients 128 ; Factures du trimestre 3 412 ; En retard 214 ; 
  Montant TTC concerné 4 380 000 DH ; Amende potentielle 96 500 DH ; Conventions manquantes 37.
- Graphe d'évolution mensuelle (SVG) des montants en retard sur 12 mois.
- Heatmap risque (entreprises × mois) avec l'échelle de couleurs de segmentation.
- Liste "Top 5 entreprises à risque" (dont STE ORYX AUTO SARL — 350 964,45 DH concernés, 
  amende 7 026,00 DH, échéance 30/04/2026) avec pastille de risque.
- Bloc "Échéances de déclaration à venir" (30/04, 31/07, 31/10, 31/01) avec compte à rebours.

Qualité : alignements nets, ombres subtiles, hover sur les lignes, état vide pensé, contraste 
AA, aucun lorem ipsum. Rendu "prêt à présenter au client".
```

---

## ④ Conseils d'itération (à enchaîner après la 1ʳᵉ génération)

- « Passe l'ensemble en **mode sombre** et montre le rendu. »
- « Rends les **cartes KPI** plus grandes et plus aérées ; ajoute une micro-tendance (sparkline) dans chacune. »
- « Ajoute l'écran **Import TVA achats** (assistant de mapping de colonnes + file d'anomalies). »
- « Ajoute un **panneau latéral (drawer)** de détail de facture avec le calcul de l'amende expliqué. »
- « Décline en **React + Tailwind** dans un seul fichier. »
- « Ajoute la **version arabe (RTL)** de la barre latérale et du tableau de bord. »

## ⑤ Rappel — données réelles réutilisables

| Élément | Valeur |
|---|---|
| Cabinet / signataire | HLZ Consulting — Leïla Amrani (persona fictive) (CAC) |
| Client | STE ORYX AUTO SARL · IF 99000017 · ICE 009990000000017 · RC 9901 · Casablanca |
| CA HT | 60 457 607,22 DH → régime trimestriel + visa CAC |
| Période | Trimestre 1 2026 |
| Montant TTC concerné | 350 964,45 DH |
| Amende du trimestre / à verser | 7 026,00 DH |
| Taux directeur BAM (2026) | 2,25 % (1ᵉʳ mois de retard) puis 0,85 %/mois |
| Références | Déclaration : art. 78-3 & 78-4 (loi 15-95) · Visa : art. 2.78 · Directive OEC 06/10/2024 |
| Délais | 60 j (sans convention) / 120 j (avec convention) / 180 j (sectoriel) |

> Fournisseurs types : KORAL ENGINS SA, BETA EXPRESS, HORIZON PNEUMATIQUES, 
> JASMIN LUBRIFIANTS SA, GRENAT DISTRIBUTION, ETOILE CARROSSERIE, ALPHA PIECES AUTO, FALAISE MATERIAUX.
