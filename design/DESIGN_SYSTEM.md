# DelaiPay — Design system v3 « Échéance »

> Statut : **adopté pour l'Incrément 2** (remplace `collaboration/SAAS_DESIGN_SYSTEM.md`, v2 « Ledger », dont il conserve les
> jetons valides). Source d'implémentation unique : `app/public/css/app.css` (jetons) + `app/src/brand-color.js`
> (couleur d'espace accessible). Recherche : `design/UI_AUDIT.md`, `design/PATTERN_RESEARCH.md`, `design/brand/exploration/`.

**Premium = clarté + cohérence + précision + retenue.** Aucun effet n'est ajouté pour « faire premium ».

## 0. Ordre de priorité visuelle (arbitre de tout conflit)
1. **Données comptables** (montants, factures, retards) — 2. **statut de la période** (en préparation, clôturée, rouverte) —
3. **actions requises** — 4. **montants de synthèse** — 5. **avertissements / erreurs** — 6. **navigation** — 7. **décoration**
(quasi nulle). Un élément de rang inférieur ne peut jamais être plus contrasté, plus grand ou plus coloré qu'un élément de rang supérieur
sur le même écran.

## 1. Marque — direction « Échéance »
- **Symbole** : un **D plein** et un **carré laiton détaché** en haut à droite — le repère de clôture du trimestre, à la manière d'un index
  de cadran. Le temps est suggéré par la position du repère, jamais par des aiguilles.
- **Logotype** : « DelaiPay » en Inter semi-gras, une seule couleur (encre ou ivoire). Le laiton n'existe que dans le carré.
- **16×16** : dessin dédié (D plein 11 px + carré 3 px, contre-forme élargie) — jamais une réduction du symbole.
- **Monochrome** : le carré prend la couleur du D ; aucune information n'est portée par la seule couleur.
- Zone de protection = largeur du carré ; taille minimale du logotype 72 px de large, du symbole 14 px.
- Directions écartées et raisons : `design/brand/exploration/README.md` (Registre : se lit P/E/F ; Trimestre : évoque Microsoft ;
  Visa : la coche dit « conforme » sur un outil de retards ; logo actuel : se lit comme un indicateur de chargement).

## 2. Typographie
Inter (auto-hébergée, OFL). Chiffres **tabulaires et alignés** (`font-variant-numeric: tabular-nums lining-nums`) sur tout montant,
date, nombre ; virgule décimale et espace fine insécable pour les milliers (`350 964,42`), unité « DH » en `--muted` plus petite.

| Jeton | Taille / interligne | Usage |
|---|---|---|
| `--fs-2xs` | 10.5 / 14 | mentions légales, index de graphique |
| `--fs-xs` | 11.5 / 16 | en-têtes de tableau (capitales espacées), sur-titres |
| `--fs-sm` | 12.5 / 18 | texte secondaire, aides de champ, pastilles |
| `--fs-md` | 13.5 / 20 | **corps** et cellules de tableau |
| `--fs-lg` | 15 / 22 | titres de carte |
| `--fs-xl` | 18 / 24 | titres de section |
| `--fs-2xl` | 22 / 28 | titre de page |
| `--fs-3xl` | 28 / 32 | chiffres de KPI subordonnés |
| `--fs-display` | 40 / 44 (32 en mobile) | **le** chiffre-clé (un seul par écran) |

Graisses : 430 texte · 520 moyen · 600 titres et montants · 680 exceptionnel. Aucune taille hors échelle dans le CSS ou le JS.

## 3. Couleur
### Neutres (clair / sombre)
`--bg #F4F6F7 / #0A1519` · `--surface #FFF / #0F1E24` · `--surface-2` · `--surface-3` · `--ink #0F2530 / #E5EDF0` ·
`--ink-2` · `--muted #5E6F77 / #8FA3AB` · `--faint #60707A / #7F949C` (**relevé** : l'ancien `--faint` n'atteignait que 2,9:1) ·
`--line` · `--line-strong` · `--focus`.
### Marque
Pétrole `--brand #0E3544` · laiton `--accent #B08A4E` (**jamais du texte** : 3,2:1 ; texte laiton = `--accent-ink #8A6733`, 5,2:1) ·
ivoire `#F6F2EA`. Laiton ≤ 5 % de la surface (carré du symbole, indicateur de l'élément actif, filet du chiffre-clé).
**Bouton principal** : `--btn-primary-bg #0E3544 / #2A6B84`, texte blanc (13,0:1 / 5,9:1) — même famille pétrole dans les deux thèmes
(corrige le cyan pâle du thème sombre).

### Sémantique métier — un sens par couleur, toujours doublée d'un libellé ou d'une icône
| Statut | Jeton | Clair | Sombre | Icône | Exemples |
|---|---|---|---|---|---|
| **Dans les délais** | `--st-ontime` (= `--ok`) | `#2A7A55` | `#5CC08F` | coche | facture réglée à temps, convention appliquée |
| **Approche** | `--watch` | `#90670C` | `#E2BE5A` | sablier | échéance < 15 j |
| **À vérifier** | `--warn` | `#A65616` | `#E89A5B` | triangle | anomalie, doublon ?, conflit |
| **En retard / à déclarer** | `--st-late` (= `--late`) | `#BD3626` | `#EE7A69` | horloge barrée | retard, facture à déclarer |
| **Pénalité** | `--st-penalty` (= `--severe`) | `#861E13` | `#F09A8C` | pièce | amende, pénalités importantes |
| **Période clôturée** | `--st-closed` (= `--locked`) | `#56656C` | `#A2B1B7` | cadenas | clôturée, lecture seule |
| **Période rouverte** | `--st-reopened` (= `--warn`) | `#A65616` | `#E89A5B` | cadenas ouvert | réouverture motivée (jamais sans l'icône) |
| **Règle spéciale** | `--info` | `#2D5B86` | `#83AEDB` | antenne | opérateur de réseau (30 j) |
| **Destruction** | `--danger` (= `--late`) | — | — | corbeille | **seulement** dans les dialogues et menus, jamais au repos en ligne |

Chaque jeton a sa variante `-soft` (fond) et `-line` (bordure). Texte de statut sur fond `-soft` et tout texte sur `--bg` / `--surface` / `--surface-3` ≥ 4,5:1 dans les deux thèmes (vérifié par `test/design.test.js`).

## 4. Espacement, rayons, ombres
Grille 4 px (`--sp-1` 4 → `--sp-12` 48). Marges de page : 32 px (≥ 1100), 24 px (≥ 720), 16 px (mobile). Gouttière de grille : 16 px partout.
Rayons : 4 (pastille interne) · 6 (champ, bouton) · 8 (carte) · 12 (dialogue) — aucun au-delà. Ombres : `xs` (liseré) au repos,
`md` pour menus et survols, `lg` réservée aux dialogues et tiroirs. Pas de verre, pas de dégradé décoratif.

## 5. Composants
- **Boutons** : 3 rôles — *primaire* (1 par zone), *secondaire* (contour), *discret* (texte) ; plus *danger* (uniquement dans un dialogue).
  Hauteurs 36 (défaut) / 30 (compact, tableaux) ; en mobile, cible tactile 44 px minimum. Icône 16 px à gauche. Libellés = verbes
  (« Importer », « Clôturer la période »).
- **Champs** : libellé au-dessus, aide dessous, erreur en `--late` avec icône et **phrase qui dit quoi faire** ; `aria-invalid`.
  Sélecteurs natifs stylés ; dates au format `jj/mm/aaaa`.
- **Tableaux (bureau)** : lignes 40 px, cellules `--fs-md`, montants alignés à droite en chiffres tabulaires ; **en-tête collant**,
  **1re colonne collante** (identifiant), **colonne d'actions collante à droite** (une action visible + menu « ⋯ »), **ligne de totaux
  collante en pied** ; défilement horizontal uniquement dans le cadre du tableau, jamais de la page ; colonnes à priorité (`data-prio`
  1 à 3) masquées dans l'ordre inverse quand la largeur manque, restituées dans le tiroir de détail.
- **Tableaux (mobile < 720 px)** : **lignes-cartes** — ligne 1 : libellé principal + montant TTC ; ligne 2 : n° et dates ; ligne 3 :
  pastilles de statut (retard, amende) ; toucher = tiroir de détail. Résumé (nombre, total) en tête. Aucune barre de défilement
  horizontal de page.
- **Cartes** : en-tête 52 px (titre `--fs-lg` + sous-titre facultatif), corps 16/20 px, pied facultatif.
- **Pastilles / badges** : 20 px, `--fs-sm`, fond `-soft`, texte du statut, icône 12 px. Un statut par pastille.
- **Encarts** : pleine largeur, icône + titre + phrase d'action ; info / avertissement / blocage / succès / verrou.
- **Dialogues** : titre = la question ; corps = conséquences chiffrées ; bouton de refus à gauche, action à droite. Destruction en
  cascade : liste de ce qui disparaît + **saisie du nom** pour activer le bouton.
- **Toasts** : 1 visible à la fois (les précédents sont remplacés), 5 s, jamais pour une erreur bloquante.
- **États vides** : icône, une phrase, **un** bouton selon le rôle (rien pour la lecture seule). États d'erreur : ce qui s'est passé,
  « vos données n'ont pas été modifiées » quand c'est vrai, que faire, bouton « Réessayer » ou lien utile.
- **Chargement** : squelettes, jamais de spinner plein écran.

## 6. Navigation
Barre latérale 248 px, groupes **métier** non repliables :
- **Pilotage** — Vue d'ensemble · Alertes · Factures en retard · Anomalies
- **Clients & factures** — Clients · Synthèse du dossier · Délais de paiement · Imports · Conventions · Fournisseurs · Réseau
- **Déclarations** — Déclaration DGI · Visa · Exports
- **Paramètres** — Paramètres · Journal d'audit

En tête : carte d'espace (logo client ou monogramme, nom, « Propulsé par DelaiPay »). En pied : utilisateur, **rôle effectif**.
Barre supérieure : fil d'Ariane, dossier actif, période active (avec statut), recherche, alertes, menu utilisateur. En mobile : tiroir de
navigation plein-hauteur avec les mêmes groupes, barre supérieure réduite (menu, dossier, période, avatar).

## 7. Marque de l'espace client
- Le **logo du cabinet** (ou son monogramme) occupe la place d'identité ; DelaiPay se réduit au symbole + « Propulsé par DelaiPay ».
- La **couleur de l'espace** n'accentue que l'identité (monogramme, filet de l'élément actif) — jamais un statut, un bouton ou un montant.
- Contraste garanti par calcul (`brand-color.js`) : à partir de la couleur saisie, on dérive `--tenant` (fond du monogramme, assombri
  jusqu'à 4,5:1 avec son texte), `--tenant-ink` (blanc ou encre selon le meilleur contraste), `--tenant-line` (indicateur actif, ≥ 3:1
  sur la barre latérale) et leurs équivalents sombres. Une couleur trop claire (ex. `#F5F0C8`) ou trop saturée est corrigée, jamais refusée.
- En thème sombre, un logo client est posé sur une plaque ivoire pour rester lisible.

## 8. Thème sombre
Mêmes jetons redéfinis sous `:root[data-theme="dark"]` ; préférence système au premier chargement, choix mémorisé ensuite (menu
utilisateur). Fonds pétrole-noir non purs, textes jamais blancs purs, couleurs sémantiques éclaircies (table §3), ombres remplacées
par des liserés. Les documents officiels (déclaration, visa) restent sur fond papier clair.

## 9. Avant / après — 5 écrans clés
| Écran | Avant | Après |
|---|---|---|
| **Vue d'ensemble** | Chiffre-clé = amende ; TTC dans une phrase ; bannière d'onboarding au-dessus des données ; 4 KPI de même poids. | Chiffre-clé = **TTC concerné** du trimestre ; ligne subordonnée : amende à verser, factures en retard, conformité, anomalies ; « Actions requises » juste dessous ; bannière d'onboarding seulement si l'espace n'a pas de données. |
| **Délais de paiement** | Tableau à défilement interne, colonnes Retard / Amende hors écran à 1440 px ; mobile = 2 colonnes sans montant. | En-tête KPI (TTC concerné en tête) ; tableau pleine hauteur, colonnes prioritaires, 1re colonne et actions collantes, totaux en pied ; mobile = lignes-cartes avec montant, retard, amende. |
| **Déclaration DGI** | Formulaire fidèle mais tableau non adapté au mobile ; actions d'export au même poids que « Générer le visa ». | Document inchangé (conformité) ; bandeau d'état de période au-dessus ; exports groupés en secondaire, « Générer le visa » seule action primaire ; lignes-cartes en mobile. |
| **Clients** | Tableau tronqué en mobile ; filtres-pastilles sans compteur. | Filtres avec compteurs ; mobile = lignes-cartes (raison sociale, TTC concerné, statut) ; suppression retirée de la ligne (menu + confirmation nominative). |
| **Connexion / onboarding** | Symbole peu lisible en mobile ; reprise d'onboarding sur la dernière étape vue. | Nouveau logo, identité de l'espace nette ; messages d'erreur uniques et clairs ; reprise sur la prochaine étape incomplète. |
