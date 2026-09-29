# DelaiPay staging — déploiement, commandes à copier-coller

Référence (explications, vérifications détaillées) : `docs/VPS_ISOLATION.md`, `docs/STAGING.md`.
Ne touche pas : conteneur `:3200`, autres sites, fichiers nginx existants, Postfix, agents. Moitié B (agents) : non incluse.

## Valeurs à fournir

| Valeur | Ce que c'est |
|---|---|
| `<CLOUDFLARE_ZONE_ID>` | Cloudflare › delaipay.com › Overview › Zone ID |
| `<CLOUDFLARE_API_TOKEN>` | jeton Cloudflare « Edit zone DNS », limité à la zone delaipay.com (tapé à l'invite, jamais dans une commande) |
| `<LETSENCRYPT_EMAIL>` | e-mail des alertes d'expiration du certificat |
| `<AGE_PUBLIC_KEY>` | `age1…` affichée à l'étape 5 (la clé privée reste sur votre poste) |
| `<ADMIN_EMAIL>` | votre e-mail d'administrateur plateforme |
| `<ADMIN_NAME>` | votre nom, ex. `Prénom Nom` |
| `<AGENT_USERS>` | comptes des agents, séparés par des espaces (`ps -eo user= \| sort -u`) |

Valeurs fixes : VPS `194.163.181.137` / `2a02:c207:2316:8999::1`, compte `khalil`, port `4200`, `/srv/delaipay-staging`,
`/etc/delaipay-staging`, `/opt/node-24`, dépôt `git@github.com:Khaliltahoun/delaipay.git`, étiquette `staging-1`.

---

## 1. Publier le commit et l'étiquette

**[LAPTOP]**
```bash
cd ~/repos/delaipay
git status --short                                   # doit être vide
git push -u origin feature/saas-productization
git tag -a staging-1 -m "staging-1"
git push origin staging-1
git rev-parse --short staging-1                      # noter ce commit (vérifié à l'étape 8)
```

## 2. DNS (Cloudflare, sans proxy)

**[LAPTOP]**
```bash
read -rs CF_TOKEN                                    # coller <CLOUDFLARE_API_TOKEN>, Entrée
Z=<CLOUDFLARE_ZONE_ID>
cf() { curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$Z/dns_records" -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"type\":\"$1\",\"name\":\"$2\",\"content\":\"$3\",\"ttl\":300,\"proxied\":false}" | grep -o '"success":[a-z]*'; }
cf A    'staging.delaipay.com'   194.163.181.137
cf A    '*.staging.delaipay.com' 194.163.181.137
cf AAAA 'staging.delaipay.com'   2a02:c207:2316:8999::1
cf AAAA '*.staging.delaipay.com' 2a02:c207:2316:8999::1  # 4 × "success":true
unset CF_TOKEN
dig +short A admin.staging.delaipay.com; dig +short AAAA hlz-demo.staging.delaipay.com     # 194.163.181.137 · 2a02:c207:2316:8999::1
```

## 3. Moitié A — isolement (VPS_ISOLATION A0–A4, A6)

**[LAPTOP]** — fichiers de déploiement de `staging-1` et clé SSH de Code
```bash
cd ~/repos/delaipay
git archive staging-1 deploy | ssh khalil@194.163.181.137 'mkdir -p ~/dp-deploy && tar -x --strip-components=1 -C ~/dp-deploy'
ssh-keygen -t ed25519 -N '' -C code@delaipay-staging -f ~/.ssh/delaipay_staging_code
scp ~/.ssh/delaipay_staging_code.pub khalil@194.163.181.137:~/code.pub
```

**[VPS as khalil with sudo]** — A0 préalables (gardez cette session ouverte jusqu'à la fin)
```bash
ssh khalil@194.163.181.137
cd /tmp && sudo -v
sudo tar -czf /root/avant-isolement-$(date +%F).tgz /etc/ssh /etc/sudoers /etc/sudoers.d /etc/systemd/system /etc/audit /etc/nginx 2>/dev/null
getent passwd delaipay-staging; ss -ltn '( sport = :4200 )' | tail -n +2; ls -d /srv/delaipay-staging /etc/delaipay-staging /opt/node-24 2>&1   # rien ne doit exister
```

**[VPS as khalil with sudo]** — A1 utilisateur
```bash
sudo useradd --system --user-group --home-dir /srv/delaipay-staging --no-create-home --shell /bin/bash delaipay-staging
sudo passwd -l delaipay-staging
sudo sshd -T | grep -qi '^usepam yes' || sudo usermod -p '*' delaipay-staging   # sshd sans PAM : autoriser la clé
id delaipay-staging                                  # un seul groupe : delaipay-staging
```

**[VPS as khalil with sudo]** — A2 arborescence
```bash
sudo install -d -o delaipay-staging -g delaipay-staging -m 0700 /srv/delaipay-staging
for d in releases shared shared/data shared/uploads backups pre-deploy .ssh .gnupg; do sudo install -d -o delaipay-staging -g delaipay-staging -m 0700 "/srv/delaipay-staging/$d"; done
sudo install -o delaipay-staging -g delaipay-staging -m 0700 ~/dp-deploy/deploy.sh /srv/delaipay-staging/deploy.sh
sudo install -o delaipay-staging -g delaipay-staging -m 0600 ~/dp-deploy/deploy.conf.example /srv/delaipay-staging/deploy.conf
sudo sed -i 's|^REPO_URL=.*|REPO_URL=git@github.com:Khaliltahoun/delaipay.git|' /srv/delaipay-staging/deploy.conf
sudo cat /srv/delaipay-staging/deploy.conf | grep -v '^#'
ls /srv/delaipay-staging                             # → Permission denied
```

**[VPS as khalil with sudo]** — A3 Node.js propre + paquets
```bash
cd /tmp && A=$(dpkg --print-architecture | sed 's/amd64/x64/')
F=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk -v a="linux-$A.tar.xz" '$2 ~ a"$" {print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$F"
curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep " $F\$" | sha256sum -c -     # → OK
sudo install -d -o root -g root -m 0755 /opt/node-24
sudo tar -xJf "$F" -C /opt/node-24 --strip-components=1 --no-same-owner && rm -f "$F"
/opt/node-24/bin/node -v
sudo apt-get update && sudo apt-get install -y git age gnupg auditd
```

**[VPS as khalil with sudo]** — A4 SSH (clé seule, aucun tunnel)
```bash
sudo sshd -T | grep -Ei '^(allowusers|allowgroups) '   # si une ligne s'affiche : ajouter delaipay-staging dans /etc/ssh/sshd_config
sudo install -o root -g root -m 0644 ~/dp-deploy/vps/sshd-50-delaipay-staging.conf /etc/ssh/sshd_config.d/50-delaipay-staging.conf
printf 'restrict,pty %s\n' "$(cat ~/code.pub)" | sudo tee /srv/delaipay-staging/.ssh/authorized_keys >/dev/null
sudo chown delaipay-staging:delaipay-staging /srv/delaipay-staging/.ssh/authorized_keys && sudo chmod 0600 /srv/delaipay-staging/.ssh/authorized_keys
sudo sshd -t && { systemctl is-active --quiet ssh && sudo systemctl reload ssh || echo 'ssh activé par socket : rien à recharger'; }
sudo sshd -T -C user=delaipay-staging,host=x,addr=203.0.113.9 | grep -E '^(passwordauthentication|authenticationmethods|allowtcpforwarding|permittunnel) '
```

**[LAPTOP]** — test de la connexion de Code
```bash
ssh -i ~/.ssh/delaipay_staging_code delaipay-staging@194.163.181.137 'id'
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password delaipay-staging@194.163.181.137   # → Permission denied (publickey)
```

**[VPS as khalil with sudo]** — A6 service durci, sudoers, lanceur
```bash
cd /tmp
sudo install -o root -g root -m 0644 ~/dp-deploy/systemd/delaipay-staging.service ~/dp-deploy/systemd/delaipay-staging-backup.service ~/dp-deploy/systemd/delaipay-staging-backup.timer /etc/systemd/system/
sudo install -o root -g root -m 0644 ~/dp-deploy/logrotate/delaipay-staging /etc/logrotate.d/delaipay-staging
sudo visudo -cf ~/dp-deploy/vps/sudoers-delaipay-staging && sudo install -o root -g root -m 0440 ~/dp-deploy/vps/sudoers-delaipay-staging /etc/sudoers.d/delaipay-staging
sudo visudo -c
sudo install -o root -g root -m 0755 ~/dp-deploy/vps/delaipay-staging-run /usr/local/sbin/delaipay-staging-run
sudo systemctl daemon-reload
sudo systemctl enable delaipay-staging.service delaipay-staging-backup.timer
sudo -u delaipay-staging sudo -n -l | tail -2        # → une seule ligne : systemctl restart delaipay-staging.service
```

## 4. Clé de déploiement git (lecture seule) et clone superficiel

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo -u delaipay-staging -H ssh-keygen -t ed25519 -N '' -C delaipay-staging-deploy -f /srv/delaipay-staging/.ssh/deploy_key
printf 'Host github.com\n  IdentityFile ~/.ssh/deploy_key\n  IdentitiesOnly yes\n' | sudo -u delaipay-staging -H tee /srv/delaipay-staging/.ssh/config >/dev/null
sudo cat /srv/delaipay-staging/.ssh/deploy_key.pub
```

**[LAPTOP]** — ajouter la clé sur GitHub (ne PAS cocher « Allow write access »)
```bash
open https://github.com/Khaliltahoun/delaipay/settings/keys/new      # Title : delaipay-staging (read-only) · Key : la ligne ssh-ed25519 ci-dessus
```

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo -u delaipay-staging -H ssh -o StrictHostKeyChecking=accept-new -T git@github.com     # « successfully authenticated »
sudo -u delaipay-staging -H git clone --bare --depth 1 --single-branch --branch feature/saas-productization git@github.com:Khaliltahoun/delaipay.git /srv/delaipay-staging/repo.git
sudo -u delaipay-staging -H git --git-dir=/srv/delaipay-staging/repo.git fetch --depth 1 --tags origin '+refs/heads/feature/saas-productization:refs/heads/feature/saas-productization'
sudo -u delaipay-staging -H git --git-dir=/srv/delaipay-staging/repo.git rev-parse --short 'staging-1^{commit}'   # = commit de l'étape 1
```

## 5. staging.env (secrets générés sur le serveur)

**[LAPTOP]** — paire de clés des sauvegardes (la clé privée ne quitte jamais votre poste)
```bash
brew install age
age-keygen -o ~/delaipay-staging-backup.key          # affiche « Public key: age1… » = <AGE_PUBLIC_KEY> ; ranger le fichier dans le gestionnaire de mots de passe
```

**[VPS as khalil with sudo]** — A5
```bash
sudo install -d -o root -g root -m 0700 /etc/delaipay-staging
sudo install -o root -g root -m 0600 ~/dp-deploy/staging.env.example /etc/delaipay-staging/staging.env
sudo bash -c 'sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 48)|; s|^PLATFORM_SECRET_KEY=.*|PLATFORM_SECRET_KEY=$(openssl rand -hex 32)|" /etc/delaipay-staging/staging.env'
sudo sed -i 's|^BACKUP_AGE_RECIPIENT=.*|BACKUP_AGE_RECIPIENT=<AGE_PUBLIC_KEY>|' /etc/delaipay-staging/staging.env
sudo grep -E '^(JWT_SECRET|PLATFORM_SECRET_KEY)=' /etc/delaipay-staging/staging.env     # → copier dans le gestionnaire de mots de passe
sudo grep -E '^(PORT|HOST|TENANT_BASE_DOMAINS|DB_PATH|BACKUP_AGE_RECIPIENT)=' /etc/delaipay-staging/staging.env
stat -c '%U:%G %a %n' /etc/delaipay-staging /etc/delaipay-staging/staging.env            # root:root 700 · root:root 600
sudo -u delaipay-staging cat /etc/delaipay-staging/staging.env                           # → Permission denied
```

## 6. Certificat joker (DNS-01 Cloudflare)

**[VPS as khalil with sudo]**
```bash
cd /tmp
if snap list certbot >/dev/null 2>&1; then sudo snap set certbot trust-plugin-with-root=ok && sudo snap install certbot-dns-cloudflare; else sudo apt-get install -y certbot python3-certbot-dns-cloudflare; fi
read -rs CF_TOKEN                                    # coller <CLOUDFLARE_API_TOKEN>, Entrée
sudo install -o root -g root -m 0600 /dev/null /etc/letsencrypt/cloudflare-delaipay-staging.ini
printf 'dns_cloudflare_api_token = %s\n' "$CF_TOKEN" | sudo tee /etc/letsencrypt/cloudflare-delaipay-staging.ini >/dev/null; unset CF_TOKEN
sudo certbot certonly -n --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare-delaipay-staging.ini --dns-cloudflare-propagation-seconds 30 \
  --cert-name staging.delaipay.com -d staging.delaipay.com -d '*.staging.delaipay.com' \
  --email <LETSENCRYPT_EMAIL> --agree-tos --no-eff-email --deploy-hook 'systemctl reload nginx'
sudo certbot renew --cert-name staging.delaipay.com --dry-run
```

## 7. nginx

**[VPS as khalil with sudo]**
```bash
cd /tmp
ls /etc/nginx/snippets/delaipay-*.conf /etc/nginx/sites-available/delaipay-staging.conf /etc/nginx/sites-enabled/delaipay-staging.conf 2>&1 | grep -v 'No such file'   # doit être vide
grep -q 'sites-enabled' /etc/nginx/nginx.conf && echo 'sites-enabled : OK'
sudo cp --update=none ~/dp-deploy/nginx/snippets/delaipay-*.conf /etc/nginx/snippets/
sudo cp --update=none ~/dp-deploy/nginx/delaipay-staging.conf /etc/nginx/sites-available/delaipay-staging.conf
V=$(nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'); dpkg --compare-versions "$V" lt 1.25.1 && sudo sed -i '/^    http2 on;$/d' /etc/nginx/sites-available/delaipay-staging.conf   # nginx < 1.25.1 : pas de http2 (option partagée par tous les sites du port 443)
sudo ln -s ../sites-available/delaipay-staging.conf /etc/nginx/sites-enabled/delaipay-staging.conf
sudo nginx -t && sudo systemctl reload nginx
```

## 8. Premier déploiement de staging-1

**[VPS as delaipay-staging]** — depuis votre poste, avec la clé de Code
```bash
ssh -i ~/.ssh/delaipay_staging_code delaipay-staging@194.163.181.137 '/srv/delaipay-staging/deploy.sh staging-1'   # tests, sauvegarde, migrations, santé ; « Santé OK — version <commit> en service. »
```

## 9. Données fictives, administrateur plateforme, référence

**[VPS as khalil with sudo]** — les mots de passe s'affichent UNE fois → gestionnaire de mots de passe
```bash
cd /tmp
sudo delaipay-staging-run node src/ops/staging-seed.js
sudo delaipay-staging-run env DP_PLATFORM_CLI_MODE=create node src/platform/cli.js --email <ADMIN_EMAIL> --nom "<ADMIN_NAME>"
sudo delaipay-staging-run node src/ops/verify-baseline.js --slug hlz-demo --expect "36,16,350964.42,7025.33,a7d1acaac0688170ef95fce6b7bb2082"
sudo systemctl start delaipay-staging-backup.service && journalctl -u delaipay-staging-backup -n 5 --no-pager   # « Sauvegarde réussie »
```

## 10. auditd (A9)

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo install -o root -g root -m 0640 ~/dp-deploy/vps/audit-50-delaipay-staging.rules /etc/audit/rules.d/50-delaipay-staging.rules
sudo augenrules --check && sudo augenrules --load
sudo auditctl -l | grep -c delaipay                  # → 13
ls /srv/delaipay-staging; sleep 1                     # refusé (volontaire)
sudo ausearch -k delaipay_access -i --start recent | grep -E 'uid=khalil|success=no' | tail -3
```

## 11. Vérification finale (A7, A10)

**[VPS as khalil with sudo]**
```bash
cd /tmp
curl -s http://127.0.0.1:4200/healthz; echo                                        # "ok":true … "commit":"<commit de l'étape 1>" … "db":"ok"
sudo ss -ltnp '( sport = :4200 )' | tail -n +2                                     # 127.0.0.1:4200 seulement
sudo systemd-analyze security delaipay-staging.service | tail -1                   # 0.9 SAFE
sudo systemd-analyze security delaipay-staging-backup.service | tail -1            # 1.1 OK
P=$(systemctl show -p MainPID --value delaipay-staging); sudo grep -E '^(NoNewPrivs|CapEff|CapBnd|Seccomp):' /proc/$P/status   # 1 · 0… · 0… · 2
ls /srv/delaipay-staging; cat /srv/delaipay-staging/shared/data/delaipay.db; cat /etc/delaipay-staging/staging.env   # 3 × Permission denied
for u in <AGENT_USERS>; do sudo -u "$u" ls /srv/delaipay-staging; sudo -u "$u" cat /etc/delaipay-staging/staging.env; done   # tout refusé
sudo -u delaipay-staging cat /etc/delaipay-staging/staging.env                     # Permission denied
```

**[LAPTOP]**
```bash
curl -s https://admin.staging.delaipay.com/healthz; echo
curl -s https://hlz-demo.staging.delaipay.com/healthz; echo
curl -s -6 https://hlz-demo.staging.delaipay.com/healthz; echo                    # seulement si votre réseau a IPv6
curl -sI http://admin.staging.delaipay.com/ | head -3                              # 301 → https
curl -sI https://admin.staging.delaipay.com/ | grep -i strict-transport-security
open https://admin.staging.delaipay.com/                                           # connexion <ADMIN_EMAIL> + enrôlement 2FA
open https://hlz-demo.staging.delaipay.com/                                        # compte affiché par le seed (étape 9)
```

## 12. Retour arrière (en cas d'échec d'une étape — de la dernière réussie vers la première)

**[VPS as khalil with sudo]**
```bash
cd /tmp
# 10 — auditd
sudo rm -f /etc/audit/rules.d/50-delaipay-staging.rules && sudo augenrules --load
# 9 — base fictive (repartir de zéro)
sudo systemctl stop delaipay-staging && sudo rm -f /srv/delaipay-staging/shared/data/delaipay.db* && sudo systemctl start delaipay-staging
# 8 — déploiement : deploy.sh revient seul à la version précédente ; sinon redéployer une étiquette connue
ssh -i ~/.ssh/delaipay_staging_code delaipay-staging@194.163.181.137 '/srv/delaipay-staging/deploy.sh <ETIQUETTE_PRECEDENTE>'   # [LAPTOP]
# 7 — nginx (uniquement les fichiers du staging)
sudo rm -f /etc/nginx/sites-enabled/delaipay-staging.conf /etc/nginx/sites-available/delaipay-staging.conf /etc/nginx/snippets/delaipay-tls.conf /etc/nginx/snippets/delaipay-headers.conf /etc/nginx/snippets/delaipay-proxy.conf /etc/nginx/snippets/delaipay-staging-basic-auth.conf
sudo nginx -t && sudo systemctl reload nginx
# 6 — certificat
sudo certbot delete -n --cert-name staging.delaipay.com && sudo rm -f /etc/letsencrypt/cloudflare-delaipay-staging.ini
# 5 — secrets
sudo systemctl stop delaipay-staging && sudo rm -r /etc/delaipay-staging
# 4 — clé de déploiement : la supprimer sur https://github.com/Khaliltahoun/delaipay/settings/keys ; puis
sudo rm -rf /srv/delaipay-staging/repo.git /srv/delaipay-staging/.ssh/deploy_key /srv/delaipay-staging/.ssh/deploy_key.pub /srv/delaipay-staging/.ssh/config
# A6 — service, sudoers, lanceur
sudo systemctl disable --now delaipay-staging.service delaipay-staging-backup.timer
sudo rm -f /etc/systemd/system/delaipay-staging.service /etc/systemd/system/delaipay-staging-backup.service /etc/systemd/system/delaipay-staging-backup.timer /etc/sudoers.d/delaipay-staging /usr/local/sbin/delaipay-staging-run /etc/logrotate.d/delaipay-staging
sudo systemctl daemon-reload && sudo visudo -c
# A4 — SSH
sudo rm -f /etc/ssh/sshd_config.d/50-delaipay-staging.conf && sudo sshd -t && { systemctl is-active --quiet ssh && sudo systemctl reload ssh || true; }
# A3 — Node.js propre
sudo rm -r /opt/node-24
# A2, A1 — arborescence et utilisateur
sudo rm -r /srv/delaipay-staging && sudo userdel delaipay-staging
```

**[LAPTOP]**
```bash
# 2 — DNS : supprimer les 4 enregistrements *staging* dans Cloudflare › DNS
# 1 — étiquette (facultatif)
git push --delete origin staging-1 && git tag -d staging-1
```
