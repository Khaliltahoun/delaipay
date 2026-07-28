# DelaiPay — Guide de déploiement (Release 1.0)

Ce document décrit l'installation, la configuration, la sauvegarde et la mise à jour de
**DelaiPay** — SaaS multi-tenant de suivi des délais de paiement (loi marocaine 69-21).

- **Version en production (`/healthz`)** : `e25ef50ee4`
- **Commit de référence** : `17ca7ac`
- **Runtime** : Node.js **≥ 22.5** (module intégré `node:sqlite` — aucune base externe, aucune
  dépendance native, **aucune étape de build**).

---

## 1. Prérequis

- **Node.js ≥ 22.5** (le projet utilise `node:sqlite`, intégré à Node à partir de cette version).
  L'image Docker officielle du projet utilise `node:24-alpine`.
- Aucun serveur de base de données externe : la persistance est un simple fichier SQLite.
- Aucun outil de build front-end : le frontend est une SPA en JavaScript vanilla servie telle quelle.

---

## 2. Installation locale

```bash
cd app
npm install
npm start
```

- Le serveur écoute par défaut sur le **port 3000** → http://localhost:3000
- Le port est surchargeable via la variable `PORT` :

  ```bash
  PORT=3939 npm start
  ```

### Scripts npm disponibles

| Script | Commande | Rôle |
|---|---|---|
| `npm start` | `node src/server.js` | Démarre le serveur applicatif (production/local). |
| `npm run dev` | `node --watch src/server.js` | Démarrage en mode watch (rechargement au changement). |
| `npm test` | `node --test test/*.test.js` | Lance la suite de tests (voir `docs/TESTING.md`). |
| `npm run migrate` | `node src/migrate.js` | Migration idempotente vers le modèle « périodes + lots d'import ». |
| `npm run repair-delais` | `node src/repair.js` | Répare les délais applicables corrompus et recalcule retards/amendes. |
| `npm run seed` | `node src/seed.js` | Amorçage manuel des données initiales (voir § Amorçage). |

> **Dépendances applicatives** : `bcryptjs`, `cookie-parser`, `docx`, `express`, `jsonwebtoken`,
> `multer`, `pdfkit`, `xlsx` (SheetJS), `xml-js`.

---

## 3. Amorçage (compte administrateur au premier démarrage)

Au **premier démarrage sur une base vide**, le seed (`src/seed.js`) crée automatiquement :

- le cabinet **HLZ Consulting** ;
- un **compte administrateur** initial — email et mot de passe configurables via
  `ADMIN_EMAIL` / `ADMIN_PASSWORD` (valeurs par défaut : `zahra@hlz.ma` / `DelaiPay2026!`) ;
- l'historique des taux directeurs BAM ;
- le client de démonstration **CADOZAT**, avec import du fichier réel `docs/DELAI.xlsx` (s'il est
  présent) et 4 conventions fournisseurs.

Le seed **ne s'exécute que si la base est vide** (aucun cabinet existant) — relancer le serveur sur
une base déjà peuplée ne réamorce rien.

> **Garde-fou production** : lorsque `NODE_ENV=production`, la variable `ADMIN_PASSWORD` est
> **obligatoire** pour créer le compte initial (le mot de passe par défaut est refusé).

---

## 4. Variables d'environnement

À définir dans un fichier `.env` (voir `app/.env.example`) ou via la plateforme d'exécution.

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port d'écoute HTTP. | `3000` |
| `NODE_ENV` | Environnement d'exécution. En `production`, le cookie de session passe en `Secure` et `ADMIN_PASSWORD` devient obligatoire. | — |
| `JWT_SECRET` | Secret de signature des JWT. **À générer** (`openssl rand -hex 48`). Si non fourni, un secret local est créé automatiquement. | (auto-généré) |
| `ADMIN_EMAIL` | Email du compte administrateur créé au premier démarrage. | `zahra@hlz.ma` |
| `ADMIN_PASSWORD` | Mot de passe du compte administrateur initial. **Obligatoire en production.** | `DelaiPay2026!` (hors production) |
| `DB_PATH` | Chemin du fichier de base SQLite. | `app/data/delaipay.db` |

> **Note sur `DELAI_RESEAU`** : cette variable n'est pas référencée dans le code ni dans
> `.env.example` de la Release 1.0. La règle spéciale « opérateur de réseau » (délai 30 j, exclusion
> déclarative) est gérée en base et par le module `src/reseau.js`, sans variable d'environnement
> dédiée. Aucune variable `DELAI_RESEAU` n'est donc à définir.

> **`APP_VERSION`** (optionnelle) : si définie, elle remplace la version de build calculée
> automatiquement (voir § Healthcheck).

Exemple minimal de `.env` pour la production :

```
NODE_ENV=production
JWT_SECRET=<openssl rand -hex 48>
ADMIN_EMAIL=zahra@hlz.ma
ADMIN_PASSWORD=<mot de passe fort>
PORT=3000
```

---

## 5. Déploiement Docker

Contenu réel du `Dockerfile` (`app/Dockerfile`) :

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
RUN mkdir -p data uploads
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
```

Build et exécution :

```bash
cd app
docker build -t delaipay .
docker run -d -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/uploads:/app/uploads \
  -e NODE_ENV=production \
  -e JWT_SECRET=xxxxx \
  -e ADMIN_PASSWORD=xxxxx \
  delaipay
```

- Image de base **`node:24-alpine`**, dépendances installées avec `npm install --omit=dev`.
- Le conteneur crée `data/` et `uploads/` et démarre `node src/server.js` sur le port interne **3000**.
- **Volumes persistants indispensables** : `data/` (base SQLite) et `uploads/` (justificatifs).
  Sans montage de volume, les données sont perdues à la recréation du conteneur.

---

## 6. VPS et reverse-proxy HTTPS

- DelaiPay est déployé sur le VPS **`delaipay.hlzconsulting.ma`**.
- L'application tourne derrière un **reverse-proxy HTTPS Nginx**.
- Le cookie de session passe automatiquement en `Secure` dès que `NODE_ENV=production` — le TLS doit
  donc être terminé au niveau du reverse-proxy.

---

## 7. Sauvegarde et restauration

La persistance est un **fichier SQLite** (par défaut `app/data/delaipay.db`, plus les fichiers WAL
`-wal` / `-shm` associés) accompagné du dossier `app/uploads/` (justificatifs téléversés).

- **Sauvegardes horodatées** conservées dans **`app/data/backups/`**.
- **Sauvegarder régulièrement** l'ensemble `app/data/` (base + sauvegardes) **et** `app/uploads/`.

**Restauration** :

1. Arrêter le serveur (ou le conteneur).
2. Remplacer `app/data/delaipay.db` par la sauvegarde à restaurer (et remplacer `app/uploads/` par le
   contenu correspondant).
3. Redémarrer le serveur.

> En mode Docker, agir directement sur les volumes hôtes montés sur `/app/data` et `/app/uploads`.

---

## 8. Mise à jour (upgrade)

```bash
git pull
cd app
npm install          # au cas où les dépendances ont changé
# redémarrer le serveur (ou reconstruire l'image Docker)
```

- Aucune étape de build : le frontend est servi tel quel.
- **Cache des assets** : la version de build (empreinte SHA1 des assets front-end) est injectée en
  `?v=<hash>` dans les liens CSS/JS. Après chaque déploiement, ce hash change dès que le contenu des
  assets change, ce qui invalide automatiquement le cache navigateur (cache-busting fiable). Les
  assets versionnés sont servis en `immutable` (cache 1 an) ; les pages HTML sont en `no-store`.
- Si un changement de schéma est concerné, exécuter `npm run migrate` (idempotent, sûr à relancer)
  et, le cas échéant, `npm run repair-delais`.

---

## 9. Rollback

1. Revenir au commit stable précédent :

   ```bash
   git revert <commit>      # ou git checkout <commit_stable>
   ```

2. Réinstaller les dépendances si nécessaire (`npm install`) et **redémarrer** le serveur (ou
   reconstruire/relancer l'image Docker).
3. Si la base a été modifiée, **restaurer la sauvegarde** correspondante depuis `app/data/backups/`
   (voir § Sauvegarde et restauration).

---

## 10. Healthcheck

- **Endpoint** : `GET /healthz`
- **Réponse** : `{ "ok": true, "version": "<hash>", "ts": <timestamp_ms> }`
- **`version`** est l'empreinte **SHA1** du contenu des assets front-end (`js/app.js`, `js/login.js`,
  `css/app.css`), tronquée aux **10 premiers caractères hexadécimaux**. Elle peut être forcée via la
  variable `APP_VERSION`.
- Version attendue pour la Release 1.0 : **`e25ef50ee4`** (commit `17ca7ac`).

Exemple :

```bash
curl -s https://delaipay.hlzconsulting.ma/healthz
# {"ok":true,"version":"e25ef50ee4","ts":1753...}
```
