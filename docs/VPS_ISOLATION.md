# DelaiPay — isolement sur le VPS partagé (Incrément 3B.2)

> **Objectif** : DelaiPay (staging d'abord) tourne sous **son propre utilisateur** sur le VPS partagé, et **ni le compte `khalil`, ni
> les agents** (openclaw, n8n, watchdogs…) ne peuvent lire ou modifier ses fichiers, sa base, ses sauvegardes ou ses secrets.
>
> **Statut** : runbook **préparé et répété localement** (conteneur Debian trixie avec systemd, `deploy/test/isolation-test.sh`,
> **62/62 contrôles**, trace : `deploy/test/isolation-last-run.txt`). **Rien n'a été exécuté sur le VPS.** Code n'utilise jamais le
> compte `khalil` : chaque commande privilégiée ci-dessous est pour **vous** ; vous me collez la sortie.
> Jamais touchés : le conteneur de production (`:3200`), les autres sites, Postfix, le code des agents.

## Sommaire
0. [La contrainte : l'équivalence root](#0-la-contrainte--léquivalence-root)
1. [Diagnostic en lecture seule](#1-diagnostic-en-lecture-seule--à-faire-en-premier) ← **à faire maintenant, puis STOP**
2. [Moitié A — enfermer DelaiPay](#2-moitié-a--enfermer-delaipay) (A0 → A10)
3. [Moitié B — retirer l'équivalence root des comptes des agents](#3-moitié-b--retirer-léquivalence-root-des-comptes-des-agents) (après validation du diagnostic)
4. [Plus tard](#4-plus-tard)
5. [Risques résiduels](#5-risques-résiduels-assumés)
6. [Annexe : ce que la répétition locale prouve](#6-annexe--ce-que-la-répétition-locale-prouve)

---

## 0. La contrainte : l'équivalence root
Les permissions Unix (`0700`) protègent un compte **contre les autres comptes ordinaires**, jamais contre root. Or est **équivalent
root** (peut tout lire, y compris DelaiPay) tout compte qui :

| Situation | Pourquoi c'est root |
|---|---|
| `sudo` sans mot de passe (`NOPASSWD: ALL`) | `sudo cat /srv/delaipay-staging/…` |
| `sudo` **avec** mot de passe, si un agent tourne sous ce compte | l'agent peut piéger `~/.bashrc` (alias `sudo`) et capturer le mot de passe |
| `sudo` limité à une commande « évadable » (`docker`, `bash`, `node`, `npm`, `python`, `tee`, `cp`, `chown`, `vim`, `less`, `systemctl edit`, `*` joker…) | la commande ouvre un shell root ou écrit n'importe où |
| membre du groupe **`docker`** (ou accès à `/var/run/docker.sock`) | `docker run -v /:/h alpine cat /h/srv/…` |
| membre de `lxd`, `disk`, `libvirt` | mêmes effets (montage du disque, conteneurs privilégiés) |
| conteneur `--privileged`, `network=host` + capacités, ou monté sur `/`, `/srv`, `/etc`, `/home`, avec root dedans | root du conteneur = root de l'hôte sur les montages |
| **écriture** dans un fichier exécuté par root (script d'une tâche cron root, unité systemd, `/etc/…`) | root exécutera ce que le compte y écrit |

D'où les **deux moitiés, toutes deux nécessaires** : **A.** enfermer DelaiPay (utilisateur dédié + service durci) ; **B.** retirer
l'équivalence root des comptes qu'utilisent les agents. A sans B ne protège que contre les comptes déjà non privilégiés.

---

## 1. Diagnostic en lecture seule — à faire en premier
**But** : savoir sous quel utilisateur tourne chaque service, ce dont chaque agent a réellement besoin (sudo ? docker ? quels
répertoires ?), qui a `NOPASSWD`, ce que montent les conteneurs, et si les répertoires personnels sont lisibles.

**Ne modifie rien** : lecture seule, aucun service démarré ou arrêté, aucun démon PM2 lancé, aucune règle ajoutée. Les valeurs qui
ressemblent à des secrets sont masquées ; des variables d'environnement, seuls les **noms** apparaissent (testé : clés d'API, jetons
Telegram, mots de passe dans les URL et dans les arguments ne sortent pas).

Depuis votre poste :
```bash
scp deploy/vps/diagnose.sh khalil@<VPS>:~/diagnose.sh
ssh khalil@<VPS>
sudo bash ~/diagnose.sh 2>&1 | tee ~/vps-diagnosis.txt      # 1 à 2 minutes
less ~/vps-diagnosis.txt                                     # RELISEZ avant de me le coller
```
Ce que couvre le rapport (sections numérotées dans la sortie) :

| § | Contenu | Ce que j'en tire |
|---|---|---|
| 0 | OS, noyau, systemd, Node, Docker, auditd, configuration **sshd** effective | `AllowUsers`/`AllowGroups` à compléter pour `delaipay-staging` ? Node du système à ne pas toucher |
| 1 | comptes, groupes `sudo docker adm lxd disk…`, **sudoers** (lignes actives), `sudo -l` par compte, **usage réel de sudo sur 30 jours** | qui est root-équivalent, qui utilise vraiment sudo et pour quoi |
| 2 | chaque unité (agents connus + unités « maison ») : `User`, groupes, `ExecStart`, répertoire, durcissement, noms des variables, score `systemd-analyze security` ; unités `--user` ; *linger* | sous quel compte tourne chaque agent |
| 3 | processus par utilisateur, ports en écoute | agents lancés hors systemd |
| 4 | PM2 (seulement là où il tourne déjà) : applications, utilisateur, répertoire, noms des variables | applications PM2 sous `khalil` |
| 5 | cron système et crontab de chaque compte | tâches root exécutant des fichiers modifiables par un autre compte |
| 6 | chaque conteneur : utilisateur, `privileged`, réseau, PID, capacités, ports, **montages** ; alerte `docker.sock` / montage racine | conteneurs root-équivalents |
| 7 | droits de `/home/*`, `/root`, `/srv/*`, `/opt/*` ; ACL ; fichiers sensibles lisibles par tous | fuites existantes |
| 8 | par agent : appels `sudo`/`docker`/exécution de commandes **dans son code** (nombre par fichier, lecture seule) ; chemins de l'hôte cités ; refus récents dans son journal | ce qui cassera sans sudo / docker |
| 9 | production `:3200` : processus / conteneur (lecture seule) | à laisser intact ; migration future |

**STOP après le diagnostic.** Je vous rends les constats (qui est root-équivalent, pourquoi, ce que chaque agent utilise) **avant**
toute proposition de changement sur les agents. La moitié A peut suivre dès que j'ai confirmé qu'aucun point du diagnostic ne
l'affecte (port 4200 libre, `AllowUsers`, Node).

---

## 2. Moitié A — enfermer DelaiPay
Chaque étape : **commande → ce qu'elle fait → vérification → retour arrière.** Dans l'ordre. Rien ne touche la production.

### Disposition finale
```
/srv/delaipay-staging/            delaipay-staging:delaipay-staging 0700   ← personne d'autre n'y entre (pas sous /home)
├── releases/<date>-<sha>/        code déployé (lecture seule pour le service)
├── current -> releases/…         version en service
├── shared/data/                  base SQLite (+ WAL), état des sauvegardes   ← SEUL répertoire inscriptible par le service
├── shared/uploads/               justificatifs, logos
├── backups/                      archives chiffrées (zone d'attente avant la copie hors site)
├── pre-deploy/                   copie de la base avant chaque migration
├── repo.git/                     miroir git (lecture seule, clé de déploiement)
├── .ssh/                         authorized_keys (Code), deploy_key (git)   ← invisible pour le service
├── .gnupg/ (si gpg)              clé PUBLIQUE de sauvegarde uniquement
├── deploy.sh, deploy.conf        déploiement (aucun secret)
/etc/delaipay-staging/            root:root 0700
└── staging.env                   root:root 0600  ← SECRETS, lus par systemd (PID 1) seul, au démarrage
/opt/node-24/                     root:root 0755  ← Node.js propre à DelaiPay (le Node du système n'est pas touché)
/usr/local/sbin/delaipay-staging-run   root 0755   ← commandes d'administration (seed, admin plateforme…)
```

### A0. Préalables (5 min)
```bash
scp -r deploy khalil@<VPS>:~/dp-deploy          # depuis votre poste : les fichiers à installer (aucun secret)
ssh khalil@<VPS>                                 # SESSION 1 — gardez-la ouverte jusqu'à la fin de A
sudo -v
sudo tar -czf /root/avant-isolement-$(date +%F).tgz /etc/ssh /etc/sudoers /etc/sudoers.d /etc/systemd/system /etc/audit 2>/dev/null
getent passwd delaipay-staging; ss -ltn '( sport = :4200 )'; ls -d /srv/delaipay-staging /etc/delaipay-staging /opt/node-24 2>&1
```
**Vérification** : les quatre dernières commandes ne renvoient rien d'existant (utilisateur absent, port libre, répertoires absents).
Sinon : STOP, envoyez-moi la sortie. **Retour arrière** : aucun (rien n'est modifié).

### A1. Utilisateur système `delaipay-staging`
```bash
sudo useradd --system --user-group --home-dir /srv/delaipay-staging --no-create-home --shell /bin/bash delaipay-staging
sudo passwd -l delaipay-staging
```
- Compte **système** (UID < 1000), **aucun mot de passe utilisable** (verrouillé), **aucun groupe supplémentaire** (ni `sudo` ni `docker`).
- Shell `bash` uniquement parce que le déploiement se fait en SSH (clé seulement, A4). Répertoire personnel **hors de `/home`**.

**Vérification**
```bash
id delaipay-staging                       # uid=…(delaipay-staging) gid=…(delaipay-staging) groups=…(delaipay-staging)   ← rien d'autre
sudo passwd -S delaipay-staging           # delaipay-staging L …   (L = verrouillé)
```
**Retour arrière** : `sudo userdel delaipay-staging` (après le retour arrière de A2).

### A2. Arborescence `/srv/delaipay-staging` (0700)
```bash
sudo install -d -o delaipay-staging -g delaipay-staging -m 0700 /srv/delaipay-staging
for d in releases shared shared/data shared/uploads backups pre-deploy .ssh .gnupg; do
  sudo install -d -o delaipay-staging -g delaipay-staging -m 0700 "/srv/delaipay-staging/$d"; done
sudo install -o delaipay-staging -g delaipay-staging -m 0700 ~/dp-deploy/deploy.sh /srv/delaipay-staging/deploy.sh
sudo install -o delaipay-staging -g delaipay-staging -m 0600 ~/dp-deploy/deploy.conf.example /srv/delaipay-staging/deploy.conf
sudo sed -i 's|^REPO_URL=.*|REPO_URL=git@github.com:<OWNER>/delaipay.git|' /srv/delaipay-staging/deploy.conf
```
`deploy.conf` ne contient **aucun secret** (dépôt, chemin de la base, URL de santé, `NODE_DIR`).

**Vérification**
```bash
sudo ls -la /srv/delaipay-staging          # tout en delaipay-staging, drwx------
ls /srv/delaipay-staging                   # (en tant que khalil, SANS sudo) → Permission denied
```
**Retour arrière** : `sudo rm -r /srv/delaipay-staging` (vérifier d'abord avec `sudo ls` qu'il ne contient que le staging).

### A3. Node.js propre à DelaiPay (`/opt/node-24`) et paquets
Le Node du système (s'il existe, utilisé peut-être par des agents ou PM2) **n'est pas modifié** : DelaiPay a le sien, en lecture seule.
```bash
cd /tmp && A=$(dpkg --print-architecture | sed 's/amd64/x64/')
F=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk -v a="linux-$A.tar.xz" '$2 ~ a"$" {print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$F"
curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep " $F\$" | sha256sum -c -     # doit afficher : OK
sudo install -d -o root -g root -m 0755 /opt/node-24
sudo tar -xJf "$F" -C /opt/node-24 --strip-components=1 --no-same-owner && rm -f "$F"
sudo apt-get install -y git age gnupg auditd    # git (miroir), age (sauvegardes), gnupg (suite de tests du déploiement), auditd (A9)
```
**Vérification** : `/opt/node-24/bin/node -v` → `v24.…` ; `stat -c '%U %a' /opt/node-24/bin/node` → `root 755` ;
`node -v` (celui du système) → **inchangé** par rapport au diagnostic.
**Retour arrière** : `sudo rm -r /opt/node-24` ; `sudo apt-get remove age auditd` si vous ne les gardez pas.

### A4. SSH : clé seulement, aucun tunnel ; clé de déploiement git
**Clé de Code** — sur votre poste (pas dans le dépôt) : `ssh-keygen -t ed25519 -C code@delaipay-staging -f ~/.ssh/delaipay_staging_code`
puis copiez **la clé publique** (`.pub`) sur le VPS (`~/code.pub`).
```bash
sudo sshd -T | grep -Ei '^(allowusers|allowgroups) '     # si une ligne existe : y ajouter delaipay-staging (fichier principal)
sudo install -o root -g root -m 0644 ~/dp-deploy/vps/sshd-50-delaipay-staging.conf /etc/ssh/sshd_config.d/50-delaipay-staging.conf
printf 'restrict,pty %s\n' "$(cat ~/code.pub)" | sudo tee /srv/delaipay-staging/.ssh/authorized_keys >/dev/null
sudo chown delaipay-staging:delaipay-staging /srv/delaipay-staging/.ssh/authorized_keys && sudo chmod 0600 /srv/delaipay-staging/.ssh/authorized_keys
sudo sshd -t && sudo systemctl reload ssh      # reload : les sessions ouvertes restent ouvertes
```
- Le fichier sshd (bloc `Match User delaipay-staging`) : clé publique **seule**, pas de mot de passe, **aucun transfert de port ni
  d'agent, ni X11, ni tunnel** — le compte ne peut pas servir de rebond vers `127.0.0.1:3200` (production) ou d'autres services locaux.
- `restrict,pty` dans `authorized_keys` : mêmes interdictions côté clé (défense en profondeur). Optionnel : `from="<votre IP>"`.

**Clé de déploiement git (lecture seule)**
```bash
sudo -u delaipay-staging -H ssh-keygen -t ed25519 -N '' -C delaipay-staging-deploy -f /srv/delaipay-staging/.ssh/deploy_key
printf 'Host github.com\n  IdentityFile ~/.ssh/deploy_key\n  IdentitiesOnly yes\n' | sudo -u delaipay-staging -H tee /srv/delaipay-staging/.ssh/config >/dev/null
sudo cat /srv/delaipay-staging/.ssh/deploy_key.pub        # → GitHub : Settings › Deploy keys › Add (SANS « Allow write access »)
sudo -u delaipay-staging -H ssh -o StrictHostKeyChecking=accept-new -T git@github.com    # « successfully authenticated … »
```
**Vérification**
```bash
sudo sshd -T -C user=delaipay-staging,host=x,addr=203.0.113.9 | grep -E '^(passwordauthentication|authenticationmethods|allowtcpforwarding|allowagentforwarding|permittunnel) '
#  → passwordauthentication no · authenticationmethods publickey · allowtcpforwarding no · allowagentforwarding no · permittunnel no
sudo sshd -T -C user=khalil,host=x,addr=203.0.113.9 | grep -E '^(allowtcpforwarding) '    # → inchangé pour vous
# depuis votre poste :
ssh -i ~/.ssh/delaipay_staging_code delaipay-staging@<VPS> 'id; sudo -n -l'   # connexion OK ; sudo : seule la règle de A6 (après A6)
ssh -o PubkeyAuthentication=no delaipay-staging@<VPS>                        # → Permission denied (publickey)
ssh -i ~/.ssh/delaipay_staging_code -N -L 9999:127.0.0.1:3200 delaipay-staging@<VPS>   # → « administratively prohibited » dès l'usage
```
**Retour arrière** : `sudo rm /etc/ssh/sshd_config.d/50-delaipay-staging.conf && sudo sshd -t && sudo systemctl reload ssh` ;
retirer la clé de déploiement sur GitHub.

### A5. Secrets : `/etc/delaipay-staging/staging.env` (root:root 0600)
```bash
sudo install -d -o root -g root -m 0700 /etc/delaipay-staging
sudo install -o root -g root -m 0600 ~/dp-deploy/staging.env.example /etc/delaipay-staging/staging.env
# Secrets générés PAR root, SUR le serveur : les apostrophes empêchent qu'ils apparaissent dans la ligne de commande journalisée par sudo.
sudo bash -c 'sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 48)|; s|^PLATFORM_SECRET_KEY=.*|PLATFORM_SECRET_KEY=$(openssl rand -hex 32)|" /etc/delaipay-staging/staging.env'
sudoedit /etc/delaipay-staging/staging.env      # BACKUP_AGE_RECIPIENT=age1… (VOTRE clé publique), BACKUP_OFFSITE_CMD=…
sudo grep -E '^(JWT_SECRET|PLATFORM_SECRET_KEY)=' /etc/delaipay-staging/staging.env   # → à copier dans votre gestionnaire de mots de passe
```
- Seul **systemd (PID 1)** lit ce fichier, au démarrage, avant de passer à l'utilisateur `delaipay-staging`. Le compte de déploiement
  (donc la clé SSH de Code) **ne le lit pas** : le déploiement et les migrations tournent sans secret (testé).
- Les commandes qui ont besoin des secrets (seed, admin plateforme…) passent par `delaipay-staging-run` (A6), lancé par vous avec sudo.

**Vérification**
```bash
stat -c '%U:%G %a %n' /etc/delaipay-staging /etc/delaipay-staging/staging.env    # root:root 700 · root:root 600
sudo -u delaipay-staging cat /etc/delaipay-staging/staging.env                   # → Permission denied
```
**Retour arrière** : `sudo rm -r /etc/delaipay-staging` (après avoir arrêté le service).

### A6. Service durci, règle sudoers unique, lanceur d'administration
```bash
sudo install -o root -g root -m 0644 ~/dp-deploy/systemd/delaipay-staging.service ~/dp-deploy/systemd/delaipay-staging-backup.service \
     ~/dp-deploy/systemd/delaipay-staging-backup.timer /etc/systemd/system/
sudo install -o root -g root -m 0644 ~/dp-deploy/logrotate/delaipay-staging /etc/logrotate.d/delaipay-staging
sudo visudo -cf ~/dp-deploy/vps/sudoers-delaipay-staging && \
  sudo install -o root -g root -m 0440 ~/dp-deploy/vps/sudoers-delaipay-staging /etc/sudoers.d/delaipay-staging   # vérifié AVANT d'être installé
sudo visudo -c
sudo install -o root -g root -m 0755 ~/dp-deploy/vps/delaipay-staging-run /usr/local/sbin/delaipay-staging-run
sudo systemctl daemon-reload
sudo systemctl enable delaipay-staging.service delaipay-staging-backup.timer     # démarrage au premier déploiement (A7)
```
**Le service** (`deploy/systemd/delaipay-staging.service`) :

| Directive | Effet |
|---|---|
| `User=/Group=delaipay-staging`, `UMask=0077` | tourne sous son compte ; tout fichier créé n'est lisible que par lui |
| `EnvironmentFile=/etc/delaipay-staging/staging.env` | secrets injectés par systemd ; le fichier reste root:root 0600 |
| `ProtectSystem=strict`, `ReadWritePaths=/srv/delaipay-staging/shared`, `ReadOnlyPaths=/srv/delaipay-staging` | tout le système en lecture seule ; **seul `shared/`** (base, téléversements) inscriptible ; le code déployé en lecture seule |
| `InaccessiblePaths=.ssh repo.git pre-deploy backups` | le service ne voit ni la clé de déploiement, ni le miroir, ni les sauvegardes |
| `ProtectHome=yes` | `/home`, `/root`, `/run/user` invisibles (les fichiers de `khalil` et des agents) |
| `PrivateTmp`, `PrivateDevices`, `DevicePolicy=closed` | `/tmp` privé, aucun périphérique |
| `ProtectProc=invisible`, `ProcSubset=pid` | ne voit pas les processus des autres comptes |
| `NoNewPrivileges`, `CapabilityBoundingSet=` (vide), `RestrictSUIDSGID`, `PrivateUsers` | aucune capacité, aucune élévation possible (ni sudo, ni setuid) |
| `ProtectKernelTunables/Modules/Logs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname` | noyau, modules, journaux noyau, cgroups, horloge : intouchables |
| `RestrictNamespaces`, `RestrictRealtime`, `LockPersonality`, `RemoveIPC`, `KeyringMode=private` | pas d'espaces de noms, pas de temps réel, pas d'IPC résiduel |
| `SystemCallFilter=@system-service` puis `~@privileged @resources @mount @debug …`, `SystemCallArchitectures=native` | seuls les appels système d'un service ordinaire |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `IPAddressDeny=any` + `IPAddressAllow=localhost`, `HOST=127.0.0.1` | écoute sur 127.0.0.1 uniquement ; **aucune** connexion sortante hors de la machine |
| `MemoryMax=768M`, `MemoryHigh=640M`, `CPUQuota=150%`, `TasksMax=200` | ne peut pas affamer les autres services du VPS |
| `MemoryDenyWriteExecute=no` | **seule exception** : le JIT de V8 (Node.js) en a besoin |

La sauvegarde (`delaipay-staging-backup.service`) a le même enfermement, avec en plus l'écriture dans `backups/` (et `.gnupg`
si gpg) et la **sortie réseau autorisée** (copie hors site).

**Pourquoi une règle sudoers plutôt que `systemctl --user`** (choix retenu : sudoers) :
- avec `systemctl --user`, l'unité vivrait dans `~/.config/systemd/user/`, **modifiable par le compte de déploiement** : la clé SSH
  de déploiement pourrait retirer tout le durcissement ; le fichier d'environnement devrait être **lisible par ce compte** (donc les
  secrets lisibles par quiconque détient la clé de déploiement) ; le gestionnaire utilisateur ne sait pas appliquer une partie du
  durcissement (`PrivateDevices`, `ProtectKernel*`, `IPAddressDeny`, `MemoryMax`… exigent des privilèges ou une délégation de cgroups) ;
  il faudrait activer le *linger* ;
- avec l'unité **système** appartenant à root, le compte de déploiement ne peut **ni** affaiblir le bac à sable, **ni** lire les secrets.
  Le prix : une seule ligne sudoers — `delaipay-staging ALL=(root) NOPASSWD: /usr/bin/systemctl restart delaipay-staging.service` —
  **commande exacte, sans joker ni argument libre** ; `restart` n'ouvre ni éditeur ni pager ; `env_reset` et `!setenv` empêchent
  d'injecter `SYSTEMD_EDITOR` / `SYSTEMD_PAGER`. `stop`, `edit`, une autre unité ou toute autre commande : **refusés** (testé).

**Lanceur d'administration** `delaipay-staging-run` (root seulement) : exécute UNE commande de l'application sous `delaipay-staging`,
avec les secrets du service et le même enfermement (`systemd-run`). Ni le compte de déploiement ni un autre compte ne peut l'utiliser.

**Vérification**
```bash
sudo systemd-analyze verify /etc/systemd/system/delaipay-staging.service   # avant A7 : seul avertissement attendu = WorkingDirectory absent
sudo -u delaipay-staging sudo -n -l          # → (root) NOPASSWD: /usr/bin/systemctl restart delaipay-staging.service   — et RIEN d'autre
sudo -u delaipay-staging sudo -n /usr/bin/systemctl stop delaipay-staging.service    # → refusé (« a password is required »)
```
**Retour arrière** : `sudo systemctl disable --now delaipay-staging.service delaipay-staging-backup.timer` puis
`sudo rm /etc/systemd/system/delaipay-staging*.{service,timer} /etc/sudoers.d/delaipay-staging /usr/local/sbin/delaipay-staging-run /etc/logrotate.d/delaipay-staging`
puis `sudo systemctl daemon-reload && sudo visudo -c`.

### A7. Premier déploiement, données fictives, premier administrateur
Par Code (SSH `delaipay-staging`, clé de A4) ou par vous :
```bash
ssh -i ~/.ssh/delaipay_staging_code delaipay-staging@<VPS> '/srv/delaipay-staging/deploy.sh <commit-ou-tag>'
#   ou, sur le VPS : sudo -u delaipay-staging -H /srv/delaipay-staging/deploy.sh <commit-ou-tag>
```
Le script (sans aucun secret) : miroir git → version → `npm ci` → **suite de tests complète** → sauvegarde de la base → migrations →
bascule → `sudo -n systemctl restart delaipay-staging.service` → santé (commit attendu) → retour arrière automatique en cas d'échec.

Puis, **par vous** (les mots de passe générés s'affichent une fois → gestionnaire de mots de passe) :
```bash
sudo delaipay-staging-run node src/ops/staging-seed.js
sudo delaipay-staging-run env DP_PLATFORM_CLI_MODE=create node src/platform/cli.js --email <vous@delaipay.com> --nom "<Prénom Nom>"
sudo delaipay-staging-run node src/ops/verify-baseline.js --slug hlz-demo --expect "36,16,350964.42,7025.33,a7d1acaac0688170ef95fce6b7bb2082"
sudo systemctl start delaipay-staging-backup.service && journalctl -u delaipay-staging-backup -n 5 --no-pager
```
**Vérification**
```bash
curl -s http://127.0.0.1:4200/healthz                               # {"ok":true,…,"commit":"<sha>","db":"ok"}
sudo ss -ltnp '( sport = :4200 )'                                   # 127.0.0.1:4200 uniquement
sudo systemd-analyze security delaipay-staging.service | tail -1    # attendu : 0.9 SAFE   (répété localement)
sudo systemd-analyze security delaipay-staging-backup.service | tail -1   # attendu : 1.1 OK
P=$(systemctl show -p MainPID --value delaipay-staging); sudo grep -E '^(NoNewPrivs|CapEff|CapBnd|Seccomp):' /proc/$P/status
#   NoNewPrivs 1 · CapEff 0000000000000000 · CapBnd 0000000000000000 · Seccomp 2
```
Envoyez-moi ces sorties. Puis nginx / TLS / pare-feu : `docs/STAGING.md` §4–§6 (nginx ne lit **aucun** fichier de DelaiPay :
il relaie vers `127.0.0.1:4200`).

**Retour arrière** : `sudo systemctl stop delaipay-staging` ; le staging ne contient que des données fictives.

### A8. (Facultatif, recommandé) Seuls nginx et DelaiPay peuvent joindre le port 4200
Tout compte local peut ouvrir une connexion vers `127.0.0.1:4200` (l'application exige quand même une authentification). Pour que
**ni `khalil` ni les agents** ne puissent même l'atteindre (nftables, filtrage par propriétaire du socket) :
```bash
sudo nft list ruleset | head -50          # d'abord : voir s'il existe déjà un pare-feu (ufw, docker…) — me l'envoyer avant d'appliquer
sudo nft add table inet delaipay
sudo nft 'add chain inet delaipay out { type filter hook output priority 0; policy accept; }'
sudo nft add rule inet delaipay out oifname lo tcp dport 4200 meta skuid != '{ www-data, delaipay-staging, root }' reject
```
**Vérification** : `curl -s http://127.0.0.1:4200/healthz` en tant que `khalil` → *Connection refused* ; `sudo -u www-data curl -s …` → OK.
**Retour arrière** : `sudo nft delete table inet delaipay`. (Non persistant tant qu'il n'est pas ajouté à `/etc/nftables.conf` — à
décider après le diagnostic, car ufw et Docker gèrent aussi des règles. Non répété localement.)

### A9. auditd : qui touche aux fichiers de DelaiPay (root compris)
```bash
sudo install -o root -g root -m 0640 ~/dp-deploy/vps/audit-50-delaipay-staging.rules /etc/audit/rules.d/50-delaipay-staging.rules
sudo augenrules --check && sudo augenrules --load
sudo auditctl -l | grep delaipay
```
Les règles (`deploy/vps/audit-50-delaipay-staging.rules`) :
- **`delaipay_access`** : tout accès (lecture, écriture, attributs) à `/srv/delaipay-staging` par **un autre compte que
  `delaipay-staging` — root compris** (réussi ou refusé) ;
- **`delaipay_impersonation`** : accès sous l'identité `delaipay-staging` **depuis la session d'un autre compte** (`sudo -u`, `su`) —
  l'identifiant de connexion (*auid*) garde le compte d'origine ;
- **`delaipay_secrets`** : tout accès à `/etc/delaipay-staging` ;
- **`delaipay_config`** : modification des unités, de la règle sudoers, du fichier sshd, du lanceur, de `/opt/node-24/bin`.

**Lire les journaux**
```bash
sudo ausearch -k delaipay_access -i --start today                  # tout accès d'un autre compte aujourd'hui
sudo ausearch -k delaipay_access -i --success yes --start this-week # les accès RÉUSSIS (les seuls vraiment inquiétants)
sudo ausearch -k delaipay_impersonation -i --start this-week        # qui a agi « en tant que » delaipay-staging
sudo ausearch -k delaipay_secrets -i --start this-week
sudo ausearch -k delaipay_config -i --start this-month
sudo ausearch -k delaipay_access --raw --start this-month | sudo aureport -f -i --summary    # fichiers les plus touchés
sudo ausearch -k delaipay_access --raw --start this-month | sudo aureport -u -i --summary    # par compte
```
Dans chaque événement : `auid=` (qui s'est connecté), `uid=` (sous quel compte), `exe=`/`comm=` (quel programme), `name=` (quel
fichier), `success=`. **Bruit attendu** (normal) : `delaipay_secrets` par `exe=/usr/lib/systemd/systemd` à chaque démarrage du
service et de la sauvegarde ; vos propres `sudo` (ex. `sudo ls /srv/delaipay-staging`, `sudoedit staging.env`) ; `logrotate` (root)
chaque semaine sur `deploy.log`. Le service, la sauvegarde et `delaipay-staging-run` (lancés par systemd) et les connexions SSH de
déploiement ne produisent **pas** d'entrée `delaipay_access` ; votre usage de `delaipay-staging-run` est visible dans
`journalctl _COMM=sudo`.

**Vérification** : en tant que `khalil` (sans sudo), `ls /srv/delaipay-staging` (refusé) puis
`sudo ausearch -k delaipay_access -i --start recent | tail -5` → une entrée `uid=khalil … success=no`.
**Limite** : root peut arrêter auditd ou effacer `/var/log/audit`. Pour rendre les règles immuables jusqu'au redémarrage, ajouter
`-e 2` en fin de fichier **après une semaine sans surprise** (sinon le retour arrière exige un redémarrage) ; pour un journal
infalsifiable, l'envoyer hors du VPS (à décider plus tard). Les règles n'ont **pas** été répétées localement (le noyau de la machine
Docker locale est partagé ; je ne l'ai pas modifié) : la vérification ci-dessus est le test.
**Retour arrière** : `sudo rm /etc/audit/rules.d/50-delaipay-staging.rules && sudo augenrules --load` (si `-e 2` : après redémarrage).

### A10. Vérification finale de la moitié A
```bash
# En tant que khalil, SANS sudo — tout doit être refusé :
ls /srv/delaipay-staging; cat /srv/delaipay-staging/shared/data/delaipay.db; cat /etc/delaipay-staging/staging.env
# En tant que CHAQUE compte d'agent relevé par le diagnostic (ex. openclaw) — tout doit être refusé :
for u in <compte-agent-1> <compte-agent-2>; do sudo -u "$u" ls /srv/delaipay-staging; sudo -u "$u" cat /etc/delaipay-staging/staging.env; done
# Le compte de déploiement ne lit pas les secrets et n'a qu'une commande sudo :
sudo -u delaipay-staging cat /etc/delaipay-staging/staging.env; sudo -u delaipay-staging sudo -n -l
```
**Important** : tant que `khalil` (ou un compte d'agent) garde `sudo NOPASSWD` ou le groupe `docker`, ces refus ne protègent **que**
contre un accès direct : `sudo cat …` ou un conteneur monté sur `/srv` lit tout. C'est l'objet de la moitié B.

**Retour arrière complet de A** (ordre inverse) : A9 → A8 → A6 (arrêt, retrait des unités, sudoers, lanceur) → A5 → A4 → A2 → A1 → A3.

---

## 3. Moitié B — retirer l'équivalence root des comptes des agents
> **Conditionnelle au diagnostic.** Ci-dessous : la méthode et les modèles. Les commandes précises (quels agents, quels répertoires,
> quelles exceptions) viendront **après** que vous aurez validé mes constats. Rien ici ne modifie le code des agents.

### B0. Ordre imposé
1. **B1 d'abord** : plus aucun agent ne tourne sous `khalil`. Sinon retirer sudo/docker à `khalil` casse les agents, et un agent qui
   tourne sous `khalil` reste capable de capturer son mot de passe sudo.
2. **B2 ensuite** : `khalil` perd `NOPASSWD` et le groupe `docker`.
3. **B3** : conteneurs (montages, `docker.sock`, `privileged`).

### B1. Un utilisateur non privilégié par agent (ou groupe d'agents)
Modèle, pour un agent `openclaw-agent.service` qui tourne aujourd'hui sous `khalil` :
```bash
sudo useradd --system --user-group --home-dir /var/lib/agent-openclaw --create-home --shell /usr/sbin/nologin agent-openclaw
# Ses données / son état (répertoires relevés au § 8 du diagnostic) lui appartiennent ; son CODE n'est pas modifié :
sudo chown -R agent-openclaw:agent-openclaw <répertoire-d-état>
# Si son code est sous /home/khalil (0700) : accès en lecture au SEUL répertoire du code, par ACL (rien d'autre de /home/khalil) :
sudo setfacl -m u:agent-openclaw:x /home/khalil && sudo setfacl -R -m u:agent-openclaw:rX,d:u:agent-openclaw:rX <répertoire-du-code>
sudo systemctl edit openclaw-agent.service       # surcharge (drop-in), l'unité d'origine n'est pas modifiée :
#   [Service]
#   User=agent-openclaw
#   Group=agent-openclaw
#   NoNewPrivileges=yes
#   ProtectSystem=full
#   PrivateTmp=yes
#   InaccessiblePaths=-/srv/delaipay-staging -/etc/delaipay-staging     # défense en profondeur
sudo systemctl restart openclaw-agent.service && journalctl -u openclaw-agent -n 50 --no-pager
```
- **Retour arrière** : `sudo systemctl revert openclaw-agent.service && sudo systemctl restart openclaw-agent.service`
  (supprime la surcharge ; l'agent retourne sous `khalil`), `sudo setfacl -x u:agent-openclaw …`.
- **PM2 sous `khalil`** : une unité systemd par application sous son propre compte (préféré), ou un PM2 distinct par compte
  (`pm2 startup systemd -u agent-x --hp /var/lib/agent-x`). **Cron sous `khalil`** : déplacer chaque ligne dans la crontab du compte
  de l'agent (`sudo crontab -u agent-x -e`).
- **n8n** : même traitement ; le nœud *Execute Command* exécute des commandes shell sous le compte de n8n — le désactiver s'il n'est
  pas utilisé (`NODES_EXCLUDE=["n8n-nodes-base.executeCommand"]`), et jamais de `docker.sock` monté.

**Ce qui casse sans sudo / docker** (à confirmer agent par agent avec le § 8 du diagnostic) :

| L'agent fait… | Sans le privilège | Solution qui ne le rend PAS root-équivalent |
|---|---|---|
| `sudo systemctl restart <son-service>` | refusé | règle sudoers exacte pour CETTE commande (comme `delaipay-staging`) |
| `sudo <commande évadable>` (`docker`, `bash`, `npm`, `tee`, `cp`, joker…) | refusé | aucune : **reste root-équivalent** |
| `docker ps` / `logs` (lecture) | *permission denied* sur le socket | mandataire du socket en lecture seule (ex. docker-socket-proxy, `CONTAINERS=1`, `POST=0`) — réduit fortement le risque |
| `docker run` / `exec` / `compose up` | refusé | Docker *rootless* sous le compte de l'agent (démon séparé, ne voit pas les conteneurs de l'hôte) — sinon **reste root-équivalent** |
| lit / écrit dans `/home/khalil/...` | `EACCES` | ACL ciblée sur le seul répertoire utile, ou déplacement de ses données |
| écoute sur un port < 1024 | refusé | `AmbientCapabilities=CAP_NET_BIND_SERVICE` dans l'unité, ou port > 1024 derrière nginx |

**Règle** : là où un agent a **réellement** besoin de docker (écriture) ou de sudo non restreint, il **reste root-équivalent** et
**DelaiPay ne peut pas être isolé de lui** sur ce VPS. Options, dans l'ordre : réduire son besoin (tableau ci-dessus) ; le déplacer sur
une autre machine ; ou appliquer le déclencheur « VPS dédié » pour DelaiPay (DECISIONS.md).

### B2. `khalil` : retirer `NOPASSWD` et le groupe `docker` sans se verrouiller dehors
Prérequis : B1 terminé (aucun agent sous `khalil`) ; **accès console de l'hébergeur** (KVM / VNC / mode secours) vérifié.
```bash
# 0. khalil a-t-il un mot de passe ? (sinon, retirer NOPASSWD = plus aucun sudo possible)
sudo passwd -S khalil            # « P » = oui. Si « L » ou « NP » : sudo passwd khalil  → gestionnaire de mots de passe
# 1. SESSION A : shell root de secours, gardé ouvert jusqu'au bout
sudo -i
# 2. (session A) copie de secours
mkdir -p /root/sudoers-avant-B2 && cp -a /etc/sudoers /etc/sudoers.d /root/sudoers-avant-B2/
# 3. (session A) retirer NOPASSWD : éditer le fichier relevé au § 1 du diagnostic, TOUJOURS avec visudo
visudo -f /etc/sudoers.d/<fichier>      # « khalil ALL=(ALL) NOPASSWD: ALL »  →  supprimer la ligne (le groupe sudo exige le mot de passe)
                                        #  ou la remplacer par « khalil ALL=(ALL:ALL) ALL »
printf 'Defaults timestamp_type=tty\nDefaults timestamp_timeout=5\nDefaults use_pty\n' > /tmp/10-durcissement \
  && visudo -cf /tmp/10-durcissement && install -m 0440 /tmp/10-durcissement /etc/sudoers.d/10-durcissement
visudo -c
```
`timestamp_type=tty` : le « sudo récent » ne vaut que pour le terminal où vous l'avez tapé (un processus sans terminal, ou d'une autre
session, ne peut pas en profiter) ; `timestamp_timeout=5` minutes ; `use_pty` : protège contre l'injection de frappes.
```bash
# 4. NOUVELLE session C (ne fermez pas A) — tester AVANT de continuer :
ssh khalil@<VPS>
sudo -k; sudo -n true            # → « a password is required »   (NOPASSWD retiré)
sudo true                        # → demande le mot de passe, puis réussit   ← SI ÉCHEC : revenir en session A et restaurer (ci-dessous)
# 5. (session A) retirer le groupe docker
gpasswd -d khalil docker
ps -o pid,user,supgrp,args -u khalil | grep -w docker     # processus de khalil qui ont ENCORE le groupe (jusqu'à leur redémarrage)
# 6. NOUVELLE session D :
id                               # plus de « docker »
docker ps                        # → permission denied … docker.sock
sudo docker ps                   # → demande le mot de passe, fonctionne
# 7. seulement maintenant : fermer la session A
```
**Retour arrière** (depuis la session A, ou la console de l'hébergeur) :
`cp -a /root/sudoers-avant-B2/sudoers.d/. /etc/sudoers.d/ && rm -f /etc/sudoers.d/10-durcissement && visudo -c && usermod -aG docker khalil`.
**Ce qui reste** : `khalil` garde sudo **avec mot de passe** — c'est votre compte d'administration ; il est root-équivalent si le
compte lui-même est compromis. C'est acceptable **seulement** si aucun agent ne tourne sous `khalil` (B1) et si la connexion SSH de
`khalil` se fait par clé.

### B3. Conteneurs
Le § 6 du diagnostic signale, pour chaque conteneur : `privileged`, `network=host`, `pid=host`, capacités ajoutées, `docker.sock` monté,
montages larges (`/`, `/srv`, `/home`, `/etc`, `/var`, `/opt`), utilisateur root. Pour chacun :

| Constat | Risque pour DelaiPay | Remplacement proposé |
|---|---|---|
| `docker.sock` monté | **root-équivalent** : peut lancer un conteneur monté sur `/srv` | retirer ; si lecture nécessaire : mandataire en lecture seule |
| `privileged: true` | root-équivalent | retirer ; n'ajouter que la capacité réellement nécessaire |
| montage de `/`, `/srv`, `/home`, `/etc`… avec root dans le conteneur | lit `/srv/delaipay-staging` (root ignore 0700) | monter le **seul** sous-répertoire utile, `:ro` si possible |
| `network: host` | joint `127.0.0.1:4200` (et la production) | réseau bridge + ports publiés sur `127.0.0.1` |
| utilisateur root dans le conteneur | aggrave tout montage | `user: "<uid>:<gid>"`, `read_only: true`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]` |

Le **conteneur de production (`:3200`)** : relevé en lecture seule, **non modifié**. Sa migration vers le même modèle est notée pour
plus tard.

---

## 4. Plus tard
Notées dans `collaboration/DECISIONS.md` : la production SaaS utilisera un utilisateur distinct **`delaipay`** avec exactement le même
modèle (`/srv/delaipay`, `/etc/delaipay`, unité durcie, auditd) ; le conteneur de production actuel (`:3200`) devra migrer vers ce
modèle ; **déclencheur du VPS dédié** : plus de 5 clients, **ou** un agent qui doit garder un accès root-équivalent.

## 5. Risques résiduels assumés
- **root** (et donc tout compte root-équivalent restant, l'hébergeur, l'hyperviseur) peut toujours tout lire. L'isolement le rend
  **visible** (auditd), pas impossible. Seul un VPS dédié supprime le partage.
- **Noyau partagé** : une faille noyau exploitée par un agent contourne tout. Tenir le VPS à jour (`unattended-upgrades`).
- **Réseau local** : sans A8, tout compte local peut ouvrir une connexion vers `127.0.0.1:4200` (l'application demande quand même
  une authentification, la console exige la 2FA).
- **Le compte de déploiement** (donc la clé SSH de Code) lit la base du staging — données **fictives** uniquement. Il ne lit ni les
  secrets, ni `/home`, et ne peut rien faire d'autre avec sudo que redémarrer le service.

## 6. Annexe : ce que la répétition locale prouve
`deploy/test/isolation-test.sh` (Docker ; un conteneur Debian trixie avec systemd comme PID 1 joue le VPS) applique A1–A7 avec les
fichiers de `deploy/` et vérifie **62 points**, dont :
- utilisateur sans groupe supplémentaire, mot de passe verrouillé ; `/srv/delaipay-staging` 0700 ; `staging.env` root:root 0600 ;
- sshd : pour `delaipay-staging` clé seule, aucun transfert ni tunnel ; configuration des autres comptes inchangée ;
- Node.js du système non installé / non modifié (DelaiPay utilise `/opt/node-24`) ;
- service démarré sous le bac à sable, `/healthz` OK, base créée dans `shared/data` (0600) ; `NoNewPrivs=1`, aucune capacité, seccomp
  actif ; écoute sur `127.0.0.1:4200` seulement ;
- sudoers : `restart` autorisé ; `stop`, `edit`, autre unité, `cat /etc/shadow` refusés ; le compte de déploiement ne lit pas
  `staging.env` et ne peut pas modifier l'unité ;
- sauvegarde chiffrée (0600) sous le même bac à sable, déchiffrable par la clé privée hors ligne ;
- `delaipay-staging-run` : seed fictif et **référence 36 · 16 · 350 964,42 · 7 025,33 · md5 a7d1acaa…** vérifiés sous l'utilisateur
  du service ; aucun secret écrit sur disque ; inutilisable par le compte de déploiement ;
- `khalil` (sans sudo) et un compte d'agent : lister `/srv/delaipay-staging`, lire la base, une sauvegarde, `staging.env`, écrire dans
  le code, redémarrer le service → **tout refusé** ; `delaipay-staging` ne lit pas `/home/khalil` ;
- sonde avec le **bac à sable exact** du service : `/home` invisible, code en lecture seule, `/etc` non inscriptible, `.ssh`,
  `repo.git`, `backups/` et `staging.env` inaccessibles, **aucune sortie réseau**, PID 1 invisible ; seul `shared/data` inscriptible ;
- `systemd-analyze security` : **delaipay-staging.service 0.9 SAFE**, **delaipay-staging-backup.service 1.1 OK**.

Non répété localement : auditd (A9), nftables (A8), la moitié B (dépend du diagnostic).
