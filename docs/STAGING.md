# DelaiPay — Staging (architecture cible et procédure)

> Statut : **préparé et répété localement** (Incrément 3B). Aucun accès au VPS, aucune modification DNS, aucune mise en ligne.
> Artefacts : `deploy/` · répétition locale : `deploy/test/local-test.sh` · plan de test du fondateur : `docs/STAGING_TEST_PLAN.md`.

## 0. FOUNDER INPUTS — ce dont j'ai besoin de vous avant l'installation
1. **VPS** : distribution et version (`cat /etc/os-release`), CPU / RAM / disque libre (`nproc; free -h; df -h /`), méthode d'accès
   (utilisateur SSH, clé, port, `sudo` disponible), version de Node.js déjà installée (`node -v`, ou aucune).
2. **Production sur le même VPS ?** Si oui : comment elle tourne (systemd, PM2, Docker ?), son port local, l'emplacement de sa configuration
   nginx (`ls /etc/nginx/sites-enabled/`), et si nginx est déjà installé — pour garantir que le staging ne partage ni port, ni fichier, ni utilisateur.
3. **DNS de delaipay.com** : fournisseur (Cloudflare, OVH, Gandi, Route 53, registrar local…) et s'il offre une **API** utilisable par certbot
   pour DNS-01 (sinon : acceptez-vous de déléguer `staging.delaipay.com` à un fournisseur qui en a une, ex. Cloudflare gratuit ?). Il faudra un
   jeton d'API **limité à la zone** (édition DNS uniquement), créé par vous.
4. **E-mail pour Let's Encrypt** (alertes d'expiration du certificat).
5. **Sauvegardes hors site** : destination (Backblaze B2, Scaleway, OVH Object Storage, Wasabi, NAS, second serveur…) et identifiants
   **en écriture seule** créés par vous ; et la **clé publique age** (`age1…`) issue de `age-keygen` sur VOTRE poste (la clé privée ne me
   parvient jamais et ne va jamais sur le serveur).
6. **Accès git du serveur** : URL du dépôt et une **clé de déploiement en lecture seule** (GitHub / GitLab : « Deploy key », sans écriture),
   et le commit / tag à déployer en premier.
7. **Préférences** : authentification basique nginx devant le staging (recommandé : oui) ; restreindre la console à certaines IP (optionnel) ;
   compte de surveillance externe (UptimeRobot / Better Stack) sous quelle adresse e-mail.
8. **Qui exécute** : vous (pas à pas de CODE_HANDOFF.md), ou un accès **limité** pour Code : utilisateur `delaipay-staging` uniquement
   (clé SSH dédiée, `sudo` restreint à `systemctl restart|status delaipay-staging`, `nginx -t`, `systemctl reload nginx`), jamais l'accès aux
   fichiers ni au service de la production.

## 1. Hôtes
| Rôle | Hôte |
|---|---|
| Console plateforme | `admin.staging.delaipay.com` |
| Espaces de travail | `<slug>.staging.delaipay.com` (ex. `hlz-demo`, `premium`, `client2`) |
| DNS | un enregistrement joker `*.staging.delaipay.com` (A/AAAA vers l'IP du VPS) — couvre aussi `admin.staging` |

L'application choisit elle-même console / espace d'après l'hôte (`TENANT_BASE_DOMAINS=staging.delaipay.com` → console = `admin.staging.delaipay.com`).
Le slug `admin` est réservé : aucun espace ne peut le prendre.

## 2. Séparation complète d'avec la production
La production actuelle (`delaipay.hlzconsulting.ma`) n'est **ni lue, ni modifiée, ni redémarrée**. Seul nginx est partagé, avec un fichier de site distinct.

| Élément | Staging | Production (inchangée) |
|---|---|---|
| Utilisateur système | `delaipay-staging` (sans shell interactif, sans sudo sauf `systemctl restart delaipay-staging`) | existant |
| Code (versions) | `/srv/delaipay-staging/releases/<date>-<sha>/`, lien `current` | existant |
| Données (base, téléversements, exports) | `/var/lib/delaipay-staging/{data,uploads}` | existant |
| Secrets / environnement | `/etc/delaipay-staging/staging.env` (root:delaipay-staging 0640) | existant |
| Port local | `127.0.0.1:4200` (jamais public) | existant |
| Processus | `delaipay-staging.service` (systemd) | existant |
| Journaux | `/var/log/delaipay-staging/` + `nginx/delaipay-staging.*.log` | existant |
| Sauvegardes | `/var/backups/delaipay-staging/` + copie hors site | existant |
| nginx | `/etc/nginx/sites-available/delaipay-staging.conf` (server_name `*.staging.delaipay.com`) | ses propres fichiers |

**Données du staging : fictives uniquement** (`npm run staging:seed`), jamais une copie d'une base réelle.

## 3. Chaîne de requête
```
Internet ──443──▶ nginx (TLS joker, HSTS, limites, X-Forwarded-For remplacé, X-Request-Id)
                     └──▶ 127.0.0.1:4200  node src/server.js (HOST=127.0.0.1, TRUST_PROXY=loopback, NODE_ENV=production)
                                             └──▶ SQLite /var/lib/delaipay-staging/data/delaipay.db
```
- `TRUST_PROXY=loopback` : seul nginx local est cru pour `X-Forwarded-For` ; nginx **remplace** cet en-tête par l'IP réelle
  (`proxy_set_header X-Forwarded-For $remote_addr`) : un en-tête forgé par le client n'atteint jamais l'application (répété localement).
- L'application n'écoute que sur `127.0.0.1` (`HOST`) ; le port 4200 n'est jamais ouvert dans le pare-feu.

## 4. TLS : certificat joker par DNS-01
- Un **certificat joker** (`*.staging.delaipay.com`) est nécessaire : chaque nouvel espace crée un nouveau sous-domaine, qu'on ne peut pas
  ajouter au certificat à la main.
- **Let's Encrypt n'émet un joker QUE par le défi DNS-01** : le défi HTTP-01 prouve le contrôle d'UN nom en servant un fichier sur ce nom
  précis, ce qui est impossible pour « tous les sous-domaines » ; DNS-01 prouve le contrôle de la ZONE (enregistrement TXT
  `_acme-challenge.staging.delaipay.com`).
- Outil : `certbot` + greffon DNS de votre fournisseur (ex. `python3-certbot-dns-cloudflare`, `-ovh`, `-route53`…) avec un jeton d'API
  **limité à la zone** et à l'édition DNS, stocké en `/etc/letsencrypt/<fournisseur>.ini` (root, 0600).
  ```
  sudo certbot certonly --dns-<fournisseur> --dns-<fournisseur>-credentials /etc/letsencrypt/<fournisseur>.ini \
       -d 'staging.delaipay.com' -d '*.staging.delaipay.com' --email <EMAIL> --agree-tos --no-eff-email
  ```
- **Renouvellement automatique** : le timer `certbot.timer` (installé avec certbot) renouvelle 30 jours avant l'échéance ; ajouter un
  crochet de rechargement : `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh` → `systemctl reload nginx`. Test : `certbot renew --dry-run`.
- Sans API DNS chez le fournisseur : soit déléguer `staging.delaipay.com` (enregistrements NS) vers un fournisseur qui en a une
  (Cloudflare gratuit, deSEC…), soit `acme-dns` ; le renouvellement manuel (TXT à la main tous les 90 jours) est à éviter.

## 5. En-têtes, limites, redirections (deploy/nginx/)
- HTTP → HTTPS (301) sur tous les hôtes du staging ; **HSTS** `max-age=31536000; includeSubDomains` (HTTPS uniquement).
- TLS 1.2 / 1.3 ; `server_tokens off` ; `X-Robots-Tag: noindex` (le staging ne doit pas être indexé).
- L'application pose déjà sa CSP stricte, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, COOP.
- Taille des requêtes : **26 Mo** (imports de classeurs et justificatifs limités à 25 Mo par l'application ; logos 1 Mo) ; au-delà : 413.
- Limitation de débit nginx en plus de celle de l'application : connexions (10/min/IP, rafale 10), API (20/s/IP, rafale 60).
- **Authentification basique facultative** devant tout le staging (`snippets/delaipay-staging-basic-auth.conf`) : activer en décommentant
  l'`include` puis `nginx -t && systemctl reload nginx` ; désactiver en le recommentant. `/healthz` reste ouvert pour la surveillance.

## 6. Pare-feu
- Publics : **80/tcp** (redirection + éventuels défis HTTP-01 d'autres sites) et **443/tcp**.
- SSH : tel qu'il est déjà configuré (port, clés) — rien à changer.
- **Jamais** public : 4200 (staging), le port de la production, SQLite (fichier local).
- Exemple (ufw) : `ufw allow 80/tcp && ufw allow 443/tcp` — vérifier `ufw status` avant/après ; ne pas toucher aux règles SSH existantes.

## 7. Installation (une fois) — voir le pas à pas exact dans CODE_HANDOFF.md
1. `adduser --system --group --home /srv/delaipay-staging --shell /usr/sbin/nologin delaipay-staging` ;
   répertoires `/srv/delaipay-staging`, `/var/lib/delaipay-staging/{data,uploads}`, `/var/log/delaipay-staging`, `/var/backups/delaipay-staging`
   (propriétaire `delaipay-staging`, 0750) et `/etc/delaipay-staging` (root:delaipay-staging 0750).
2. Node.js ≥ 22.5 (24 LTS recommandé), `git`, `sqlite3`, `age` (ou `gnupg`), `certbot` + greffon DNS.
3. `staging.env` depuis `deploy/staging.env.example` ; secrets générés sur le serveur ; destinataire age = **clé publique** du fondateur.
4. Unités systemd (`deploy/systemd/*`) → `/etc/systemd/system/`, `systemctl daemon-reload`, `enable delaipay-staging delaipay-staging-backup.timer`.
5. Règle sudo limitée : `delaipay-staging ALL=(root) NOPASSWD: /usr/bin/systemctl restart delaipay-staging` (fichier `/etc/sudoers.d/delaipay-staging`).
6. nginx : snippets → `/etc/nginx/snippets/`, site → `sites-available` + lien `sites-enabled`, `nginx -t`, `systemctl reload nginx`.
7. logrotate : `deploy/logrotate/delaipay-staging` → `/etc/logrotate.d/`.
8. Premier déploiement : `REPO_URL=… /srv/delaipay-staging/deploy.sh <commit>` (voir §8).
9. Données : `npm run staging:seed` (fictif, mots de passe affichés une fois) ; **premier administrateur plateforme** :
   `npm run platform:admin:create -- --email … --nom "…"` sur le serveur ; enrôlement 2FA sur le téléphone du fondateur.

## 8. Déploiement et retour arrière (deploy/deploy.sh)
Verrou → miroir git en lecture seule → version `releases/<date>-<sha>` (`git archive`, fichier `REVISION`) → `npm ci --omit=dev` →
**suite de tests complète dans un environnement vierge** (jamais la base ni les secrets du staging) → **sauvegarde de la base avant
migration** (API de sauvegarde en ligne de SQLite, `pre-deploy/`) → migrations additives (`src/ops/migrate-schema.js`, `src/migrate.js`) →
bascule du lien `current` → redémarrage → **contrôle de santé** (HTTP 200 **et** commit attendu dans `/healthz`) →
en cas d'échec : **retour automatique** à la version précédente, redémarrage, nouveau contrôle ; la version fautive est conservée en `.echec`.
Convention : les migrations n'ajoutent que des tables / colonnes ; revenir en arrière ne nécessite pas de restaurer la base
(la sauvegarde de pré-déploiement reste disponible si une migration devait être annulée).
Répété localement : commit sain → en service ; commit volontairement cassé → échec détecté, retour arrière, version saine de nouveau en service.

## 9. Sauvegardes (avant toute donnée réelle)
- `npm run backup` (timer quotidien 02:30) : copie à chaud par l'**API de sauvegarde en ligne** de SQLite (jamais une copie de fichier
  d'une base ouverte), contrôle d'intégrité, archive base + téléversements + manifeste, **chiffrement obligatoire** vers une **clé publique**.
- **Clés** : le fondateur génère la paire `age-keygen -o delaipay-backup.key` sur SON poste ; seule la clé publique (`age1…`) va dans
  `staging.env`. La clé privée ne va **jamais** sur le serveur ni à côté des sauvegardes : gestionnaire de mots de passe + copie papier
  / clé USB dans un coffre. Sans elle, les sauvegardes sont irrécupérables (c'est voulu en cas de vol).
- Rotation : 7 quotidiennes, 4 hebdomadaires, 12 mensuelles (variables `BACKUP_KEEP_*`).
- **Hors site** (`BACKUP_OFFSITE_CMD`, exécutée après chaque sauvegarde) — options : stockage objet compatible S3 (Backblaze B2,
  Scaleway, OVH, Wasabi) via `rclone` avec une clé **en écriture seule** et verrouillage d'objets si possible ; `rsync` vers un NAS / un
  second serveur ; au minimum un autre fournisseur que celui du VPS.
- **Restauration** (exercice mensuel recommandé) : copier une archive sur le poste du fondateur (ou un serveur de test) →
  `npm run restore -- --from <archive> --to <répertoire neuf> --identity <clé privée age>` → `npm run verify:baseline -- --slug hlz-demo
  --expect "36,16,350964.42,7025.33,a7d1acaac0688170ef95fce6b7bb2082"`. Mise en service d'une base restaurée : arrêter le service,
  déplacer l'ancienne base, copier la restaurée, `chown`, redémarrer, vérifier `/healthz` — toujours une décision manuelle.
- **Console** : dernière sauvegarde réussie (heure, taille) au tableau de bord, **rouge au-delà de 26 h**, alerte sur toutes les pages en
  cas d'échec ; espace disque (alerte sous 10 % ou 2 Go).

## 10. Surveillance
- `GET https://admin.staging.delaipay.com/healthz` (et tout hôte d'espace) : `{"ok":true,"version","commit","uptimeSec","db":"ok"}`,
  503 si la base ne répond pas ; ni secret ni donnée d'espace ; ouvert même avec l'authentification basique.
- Surveillance externe gratuite : **UptimeRobot** (plan gratuit, contrôle HTTP(S) toutes les 5 min, mot-clé `"ok":true`, alertes e-mail /
  application) ou Better Stack (plan gratuit). Ajouter aussi le contrôle d'expiration du certificat.
- Erreurs serveur : comptées au tableau de bord de la console ; journalisées avec l'identifiant de requête (`X-Request-Id`, transmis
  par nginx), méthode et chemin — jamais le corps, les cookies, les jetons ni les mots de passe. L'utilisateur voit la même référence.

## 11. Remise à zéro du staging
Arrêter le service, supprimer `/var/lib/delaipay-staging/data/*` (base de staging uniquement !), redémarrer, `npm run staging:seed`,
recréer l'administrateur plateforme. Jamais sur la production.
