# DelaiPay — jeu de marque « quart d'échéance »

Symbole d'origine (anneau ¾ + quart laiton), **conservé par décision du fondateur** (2026-09-25) ; la direction « Échéance » explorée est
écartée (voir `exploration/`). SVG vectoriels (grille 64 ; favicon 16 dessiné sur grille 16), rasters dérivés de ces SVG.
Emplacement : `app/public/assets/brand/`. Exploration et justification : `exploration/README.md`.

| Fichier | Usage |
|---|---|
| `delaipay-logo.svg` / `-light-bg.svg` | Logo horizontal maître (symbole + logotype encre) — fond clair |
| `delaipay-logo-dark-bg.svg` | Logo horizontal ivoire — fond pétrole / thème sombre |
| `delaipay-logo-mono.svg` | Logo monochrome `currentColor` (impression N&B, filigrane) |
| `delaipay-symbol-light-bg.svg` / `-dark-bg.svg` / `-mono.svg` | Symbole seul (anneau + quart laiton) |
| `delaipay-mark.svg` | Tuile d'application (symbole ivoire sur pétrole) |
| `delaipay-maskable.svg` | Tuile pleine sans arrondi (zone sûre 80 %) — icônes « maskable » / Apple |
| `favicon-16.svg` → `favicon-16.png` | **16×16 dédié** (anneau épaissi, quart agrandi) |
| `favicon.svg` → `favicon-32.png` | 32×32 |
| `favicon.ico` | ICO contenant le 16 dédié + le 32 (servi aussi sur `/favicon.ico`) |
| `apple-touch-icon.png` | 180×180 |
| `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Manifeste `/manifest.webmanifest` |

Règles : le laiton n'apparaît que dans le quart (jamais du texte) ; logotype d'une seule couleur ;
zone de protection = largeur du carré ; symbole ≥ 14 px, logotype ≥ 72 px de large. Le favicon SVG n'est pas déclaré
aux navigateurs : ils le réduiraient au lieu d'utiliser le 16 px dédié.

Dans l'application, l'identité **du cabinet** mène (carte d'espace en tête de barre latérale) ; DelaiPay apparaît en
« Propulsé par DelaiPay » (symbole 14 px) en pied de barre latérale, sur la page de connexion et dans l'aperçu des paramètres.
Les PNG / ICO sont régénérés par rendu navigateur des SVG (Playwright, outil de développement hors dépendances de l'app).
