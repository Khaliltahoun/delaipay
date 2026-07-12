# DelaiPay — SaaS de suivi des délais de paiement (loi 69-21)

Plateforme web **multi-tenant** pour cabinets d'expertise comptable marocains : import des journaux
d'achats, **calcul automatique des retards et amendes** (loi 69-21, modèle trimestriel apporté, mois
calendaire), **déclaration DGI**, **visa** du commissaire aux comptes / expert-comptable, alertes et
journal d'audit.

Construite à partir des documents métier réels du cabinet HLZ (client **CADOZAT**). Le moteur de calcul
reproduit **au centime** la déclaration officielle T1 2026 (TTC concerné **350 964,42 DH**, amende
**7 025,33 DH**).

![Tableau de bord](screenshots/dash.png)

---

## 1. Prérequis
- **Node.js ≥ 24** (utilise le module intégré `node:sqlite` — aucune base externe, aucune dépendance native).

## 2. Démarrage (local)
```bash
cd app
npm install
npm start           # http://localhost:3000  (ou PORT=3939 npm start)
```
Au **premier démarrage**, la base est créée et pré-alimentée :
- Cabinet **HLZ Consulting**, utilisateur **zahra@hlz.ma** / **DelaiPay2026!**
- Client **CADOZAT** + import du fichier réel `../docs/DELAI.xlsx` (si présent) + 4 conventions.

> Identifiants et compte initial configurables via `ADMIN_EMAIL` / `ADMIN_PASSWORD` (voir `.env.example`).

## 3. Fonctionnalités
| Module | Description |
|---|---|
| **Authentification** | Login sécurisé (JWT en cookie httpOnly, mots de passe bcrypt), garde de page. |
| **Multi-tenant** | Données cloisonnées par cabinet ; sélecteur de client. |
| **Portefeuille clients** | Fiches entreprises, assujettissement & régime auto (CA), risque. |
| **Import de fichiers** | Upload **Excel/CSV** (glisser-déposer) — formats **TVA achats** et **DELAI** auto-détectés ; contrôles d'anomalies. |
| **Feuille de calcul des délais** | DELAI / CONVENTION (60·120) / RETARD par facture, KPIs, filtres, détail du calcul. |
| **Moteur 69-21** | Amende trimestrielle apportée : 1ᵉʳ mois de retard au taux directeur BAM, mois suivants 0,85 %, **mois calendaire** (confirmé), seuls les mois du trimestre déclaré. |
| **Conventions & OCR** | Registre, upload PDF/scan, statut (Trouvée/Expirée…), délai 120 j appliqué automatiquement. |
| **Déclaration DGI** | Formulaire officiel (art. 78-3 & 78-4), état des factures, récap, **montant à verser**, exports **CSV** & **XML EDI**. |
| **Générateur de visa** | Texte CAC/EC pré-rempli (art. 2.78, Directive OEC 06/10/2024), aperçu, impression PDF. |
| **Centre d'alertes** | Conventions manquantes, anomalies de données, échéances déclaratives. |
| **Taux BAM** | Historique administrable, appliqué par date. |
| **Journal d'audit** | Traçabilité des actions sensibles. |
| **UI** | Design premium, **mode clair/sombre**, responsive. |

![Feuille de calcul des délais](screenshots/delais.png)
![Déclaration DGI](screenshots/decl.png)

## 4. Architecture
```
app/
├── src/
│   ├── server.js      # bootstrap Express + garde de pages + seed
│   ├── api.js         # API REST (auth, clients, import, délais, déclaration, visa, alertes…)
│   ├── calc.js        # moteur de calcul 69-21 (modèle trimestriel apporté, mois calendaire)
│   ├── importer.js    # parsing Excel/CSV (formats TVA & DELAI) + anomalies
│   ├── db.js          # schéma node:sqlite + provider taux BAM + audit
│   ├── auth.js        # JWT cookie httpOnly + bcrypt + middlewares
│   ├── seed.js        # cabinet/utilisateur/CADOZAT + import docs réels
│   └── util.js        # formatage FR, ICE, ids
├── public/            # login.html, app.html, css/app.css, js/app.js
├── data/              # base SQLite (généré, gitignored)
├── uploads/           # fichiers téléversés (gitignored)
└── Dockerfile
```
Stack : **Node.js + Express + node:sqlite**, JWT, bcrypt, multer, SheetJS (xlsx). Frontend SPA en
JavaScript vanilla, sans build.

## 5. Déploiement production
1. Définir les variables d'environnement (`.env` ou plateforme) :
   ```
   NODE_ENV=production
   JWT_SECRET=<openssl rand -hex 48>
   ADMIN_EMAIL=... ADMIN_PASSWORD=...
   PORT=3000
   ```
2. **Docker** :
   ```bash
   docker build -t delaipay .
   docker run -d -p 3000:3000 -v $(pwd)/data:/app/data -v $(pwd)/uploads:/app/uploads \
     -e JWT_SECRET=xxxxx delaipay
   ```
3. Placer derrière un reverse-proxy HTTPS (Nginx/Caddy) — le cookie passe en `Secure` quand `NODE_ENV=production`.
4. Sauvegarder régulièrement `data/` (base) et `uploads/` (justificatifs).

## 6. Points de conformité / notes
- **Calcul de l'amende** validé sur données réelles (§ Partie II du cahier des charges).
- Multi-tenant : chaque requête est cloisonnée par cabinet (JWT → `cabinet_id`).
- Sécurité : mots de passe hachés, cookie httpOnly/SameSite, journal d'audit, uploads hors web-root.
- Le dépôt final s'effectue sur le portail **SIMPL** de la DGI ; DelaiPay génère le **fichier XML EDI** conforme.

## 7. API (extrait)
`POST /api/auth/login` · `GET /api/me` · `GET /api/dashboard` · `GET/POST /api/clients` ·
`POST /api/clients/:id/import` · `GET /api/clients/:id/delais` · `GET /api/clients/:id/declaration` ·
`GET /api/clients/:id/declaration/export.(csv|xml)` · `GET /api/clients/:id/visa` ·
`POST /api/clients/:id/conventions` · `GET /api/alerts` · `GET/POST /api/taux` · `GET /api/audit`.
