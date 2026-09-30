# DelaiPay PRODUCTION — commandes à copier-coller

Même modèle que le staging (répété : `deploy/test/production-test.sh`, 45/45). Données **réelles** des clients.
Instance : utilisateur `delaipay`, `/srv/delaipay`, `/etc/delaipay`, `127.0.0.1:4300`, `https://admin.delaipay.com`, `https://<slug>.delaipay.com`.
Ne touche pas : conteneur `:3200` (delaipay.hlzconsulting.ma), staging, autres sites, fichiers nginx existants, agents.
**Code n'a aucun accès SSH à la production** : vous lancez tout, y compris les déploiements.
Règles : **un bloc à la fois**, après l'invite `khalil@vmi3168999` ; `read -rs …` toujours **seul**, puis la valeur, puis Entrée ;
tout `apt-get` via `sudo env NEEDRESTART_SUSPEND=1`.

## Valeurs à fournir

| Valeur | Où la trouver |
|---|---|
| `<CLOUDFLARE_ZONE_ID>` | Cloudflare › delaipay.com › Overview (déjà utilisé pour le staging) |
| `<CLOUDFLARE_API_TOKEN>` | votre gestionnaire de mots de passe (tapé à l'invite, jamais dans une commande) |
| `<LETSENCRYPT_EMAIL>` | votre e-mail |
| `<AGE_PROD_PUBLIC_KEY>` | `age1…` affiché à l'étape 1 (clé PROPRE à la production) |
| `<B2_BUCKET>` | nom du compartiment B2 créé à l'étape 2 |
| `<B2_KEY_ID>` / `<B2_APP_KEY>` | clé d'application B2 de l'étape 2 (tapées à l'invite) |
| `<ADMIN_EMAIL>` / `<ADMIN_NAME>` | votre compte d'administrateur plateforme de PRODUCTION |

---

## 1. Étiquette, clé de sauvegarde, fichiers

**[LAPTOP]**
```bash
cd ~/repos/delaipay
git status --short                                   # doit être vide
git push origin feature/saas-productization
git tag -a prod-1 -m "prod-1" && git push origin prod-1
git rev-parse --short prod-1
age-keygen -o ~/delaipay-prod-backup.key             # « Public key: age1… » = <AGE_PROD_PUBLIC_KEY> ; fichier → gestionnaire de mots de passe + copie hors ligne
git archive prod-1 deploy | ssh khalil@194.163.181.137 'rm -rf ~/dp-prod && mkdir -p ~/dp-prod && tar -x --strip-components=1 -C ~/dp-prod'
```

## 2. Backblaze B2 (navigateur)
1. https://secure.backblaze.com/b2_buckets.htm › **Create a Bucket** : nom `delaipay-prod-backups-<suffixe>` (= `<B2_BUCKET>`), **Private**,
   **Default Encryption : Enable**, **Object Lock : Enable** › Create. Puis sur le compartiment : **Object Lock** › Default retention
   **Governance**, **30 days**.
2. https://secure.backblaze.com/app_keys.htm › **Add a New Application Key** : nom `delaipay-prod-backup`, **Allow access to Bucket(s) :
   `<B2_BUCKET>`**, **Type of Access : Write Only**, reste vide › Create. Copier **keyID** et **applicationKey** (affichée une seule fois)
   dans le gestionnaire de mots de passe.

## 3. DNS (Cloudflare, sans proxy)

**[LAPTOP]**
```bash
dig +short delaipay.com; dig +short www.delaipay.com; dig +short admin.delaipay.com     # noter : les enregistrements existants restent prioritaires
read -rs CF_TOKEN
```
```bash
Z=<CLOUDFLARE_ZONE_ID>
cf() { curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$Z/dns_records" -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"type\":\"$1\",\"name\":\"$2\",\"content\":\"$3\",\"ttl\":300,\"proxied\":false}" | grep -o '"success":[a-z]*'; }
cf A    '*.delaipay.com' 194.163.181.137
cf AAAA '*.delaipay.com' 2a02:c207:2316:8999::1          # 2 × "success":true
unset CF_TOKEN
sleep 20; dig +short A admin.delaipay.com @1.1.1.1; dig +short A test-client.delaipay.com @1.1.1.1; dig +short A admin.staging.delaipay.com @1.1.1.1   # 3 × 194.163.181.137
```

## 4. Contrôles préalables (lecture seule)

**[VPS as khalil with sudo]**
```bash
cd /tmp
getent passwd delaipay; ls -d /srv/delaipay /etc/delaipay 2>&1; ss -ltn '( sport = :4300 )' | tail -n +2                 # rien ne doit exister
sudo nginx -T 2>/dev/null | grep -nE 'server_name[^;]*[ .]delaipay\.com|zone=dp_prd_' | grep -v staging || echo 'aucun conflit nginx'
sudo ls /etc/letsencrypt/live/ | grep -x delaipay.com || echo 'aucun certificat delaipay.com'
curl -s -o /dev/null -w 'production :3200 → %{http_code}\n' http://127.0.0.1:3200/
```

## 5. Utilisateur et arborescence

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo useradd --system --user-group --home-dir /srv/delaipay --no-create-home --shell /bin/bash delaipay && sudo passwd -l delaipay
sudo install -d -o delaipay -g delaipay -m 0700 /srv/delaipay
for d in releases shared shared/data shared/uploads backups pre-deploy .ssh .gnupg; do sudo install -d -o delaipay -g delaipay -m 0700 "/srv/delaipay/$d"; done
sudo install -o delaipay -g delaipay -m 0700 ~/dp-prod/deploy.sh /srv/delaipay/deploy.sh
sudo install -o delaipay -g delaipay -m 0600 ~/dp-prod/production/deploy.conf.example /srv/delaipay/deploy.conf
id delaipay; sudo grep -v '^#' /srv/delaipay/deploy.conf; ls /srv/delaipay        # un seul groupe ; SERVICE=delaipay.service ; Permission denied
```

## 6. Secrets (générés sur le serveur) et identifiants B2

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo install -d -o root -g root -m 0700 /etc/delaipay
sudo install -o root -g root -m 0600 ~/dp-prod/production/production.env.example /etc/delaipay/production.env
sudo bash -c 'sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 48)|; s|^PLATFORM_SECRET_KEY=.*|PLATFORM_SECRET_KEY=$(openssl rand -hex 32)|" /etc/delaipay/production.env'
sudo sed -i 's|^BACKUP_AGE_RECIPIENT=.*|BACKUP_AGE_RECIPIENT=<AGE_PROD_PUBLIC_KEY>|; s|b2offsite:BUCKET/|b2offsite:<B2_BUCKET>/|g' /etc/delaipay/production.env
sudo grep -E '^(DELAIPAY_ENV|PORT|HOST|TENANT_BASE_DOMAINS|TRUST_PROXY|COOKIE_SECURE|DB_PATH|BACKUP_AGE_RECIPIENT|BACKUP_OFFSITE_CMD)=' /etc/delaipay/production.env
sudo grep -cE '^(JWT_SECRET=.{96}|PLATFORM_SECRET_KEY=.{64})$' /etc/delaipay/production.env        # → 2
read -rs B2_ID
```
```bash
read -rs B2_KEY
```
```bash
echo "longueurs : ${#B2_ID} / ${#B2_KEY}"                                                       # ~25 / ~31 (0 = recommencer le read)
sudo install -o root -g root -m 0600 /dev/null /etc/delaipay/backup.env
printf 'RCLONE_CONFIG_B2OFFSITE_TYPE=b2\nRCLONE_CONFIG_B2OFFSITE_ACCOUNT=%s\nRCLONE_CONFIG_B2OFFSITE_KEY=%s\nRCLONE_CONFIG=/dev/null\nRCLONE_CACHE_DIR=/tmp/rclone-cache\n' "$B2_ID" "$B2_KEY" | sudo tee /etc/delaipay/backup.env >/dev/null; unset B2_ID B2_KEY
sudo grep -cE '^RCLONE_CONFIG_B2OFFSITE_(ACCOUNT|KEY)=.' /etc/delaipay/backup.env; sudo sh -c 'stat -c "%U:%G %a %n" /etc/delaipay/*.env'   # 2 ; root:root 600 × 2
sudo -u delaipay cat /etc/delaipay/production.env                                               # Permission denied
```
**À NE PAS me coller** — copier les secrets de production dans le gestionnaire de mots de passe, puis `clear` :
```bash
sudo grep -E '^(JWT_SECRET|PLATFORM_SECRET_KEY)=' /etc/delaipay/production.env
```

## 7. Service durci, sudoers, lanceur, rclone

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo env NEEDRESTART_SUSPEND=1 apt-get install -y rclone
sudo install -o root -g root -m 0644 ~/dp-prod/production/delaipay.service ~/dp-prod/production/delaipay-backup.service ~/dp-prod/production/delaipay-backup.timer /etc/systemd/system/
sudo install -o root -g root -m 0644 ~/dp-prod/production/logrotate-delaipay /etc/logrotate.d/delaipay
sudo visudo -cf ~/dp-prod/production/sudoers-delaipay && sudo install -o root -g root -m 0440 ~/dp-prod/production/sudoers-delaipay /etc/sudoers.d/delaipay
sudo visudo -c | grep -v 'parsed OK' || echo 'sudoers : tout est valide'
sudo install -o root -g root -m 0755 ~/dp-prod/production/delaipay-run /usr/local/sbin/delaipay-run
sudo systemctl daemon-reload && sudo systemctl enable delaipay.service delaipay-backup.timer
sudo -u delaipay sudo -n -l | tail -1                                                           # (root) NOPASSWD: /usr/bin/systemctl restart delaipay.service
```

## 8. Clé de déploiement git (lecture seule, propre à la production)

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo -u delaipay -H ssh-keygen -t ed25519 -N '' -C delaipay-prod-deploy -f /srv/delaipay/.ssh/deploy_key
printf 'Host github.com\n  IdentityFile ~/.ssh/deploy_key\n  IdentitiesOnly yes\n' | sudo -u delaipay -H tee /srv/delaipay/.ssh/config >/dev/null
sudo cat /srv/delaipay/.ssh/deploy_key.pub
```
**[LAPTOP]** — https://github.com/Khaliltahoun/delaipay/settings/keys/new : Title `delaipay-prod (read-only)`, la ligne `ssh-ed25519 …`, **sans** « Allow write access ».

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo -u delaipay -H ssh -o StrictHostKeyChecking=accept-new -T git@github.com                  # successfully authenticated
sudo -u delaipay -H git clone --bare --depth 1 --single-branch --branch feature/saas-productization git@github.com:Khaliltahoun/delaipay.git /srv/delaipay/repo.git
sudo -u delaipay -H git --git-dir=/srv/delaipay/repo.git fetch --depth 1 --tags origin '+refs/heads/feature/saas-productization:refs/heads/feature/saas-productization'
sudo -u delaipay -H git --git-dir=/srv/delaipay/repo.git rev-parse --short 'prod-1^{commit}'      # = commit de l'étape 1
```

## 9. Certificat joker *.delaipay.com (même jeton Cloudflare, déjà sur le serveur)

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo certbot certonly -n --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare-delaipay-staging.ini --dns-cloudflare-propagation-seconds 30 \
  --cert-name delaipay.com -d delaipay.com -d '*.delaipay.com' \
  --email <LETSENCRYPT_EMAIL> --agree-tos --no-eff-email --deploy-hook 'systemctl reload nginx'
sudo certbot renew --cert-name delaipay.com --dry-run
```

## 10. nginx (fichier séparé ; staging et autres sites intacts)

**[VPS as khalil with sudo]**
```bash
cd /tmp
ls /etc/nginx/sites-available/delaipay.conf /etc/nginx/sites-enabled/delaipay.conf 2>&1 | grep -v 'No such file'      # doit être vide
sudo cp --update=none ~/dp-prod/production/delaipay.conf /etc/nginx/sites-available/delaipay.conf
sudo ln -s ../sites-available/delaipay.conf /etc/nginx/sites-enabled/delaipay.conf
sudo nginx -t 2>&1 | grep -E 'delaipay\.conf|syntax|successful'
sudo nginx -t && sudo systemctl reload nginx && echo 'nginx rechargé'
curl -s -o /dev/null -w 'prod (avant déploiement) → %{http_code}\n' https://admin.delaipay.com/                     # 502 attendu
curl -s https://admin.staging.delaipay.com/healthz; echo                                                           # staging toujours servi
```

## 11. Premier déploiement de prod-1

**[VPS as khalil with sudo]**
```bash
cd /tmp && sudo -u delaipay -H /srv/delaipay/deploy.sh prod-1          # « Tests : ℹ pass 320 ℹ fail 0 » puis « Santé OK — version … en service. »
curl -s http://127.0.0.1:4300/healthz; echo
```

## 12. Administrateur plateforme, sauvegarde, copie hors site

**[VPS as khalil with sudo]** — **à NE PAS me coller** (mot de passe affiché une fois → gestionnaire, puis `clear`) :
```bash
cd /tmp && sudo delaipay-run env DP_PLATFORM_CLI_MODE=create node src/platform/cli.js --email <ADMIN_EMAIL> --nom "<ADMIN_NAME>"
```
**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo delaipay-run node src/platform/cli.js list                                                 # UNIQUEMENT votre compte (aucun compte de démonstration)
sudo delaipay-run node src/ops/staging-seed.js 2>&1 | tail -1                                   # « Refusé : DELAIPAY_ENV=staging requis » (voulu)
sudo systemctl start delaipay-backup.service; journalctl -u delaipay-backup -n 3 --no-pager -o cat   # « Sauvegarde réussie … hors site : ok. »
sudo systemctl start delaipay-backup.timer && systemctl list-timers delaipay-backup.timer --no-pager | head -2
```
Si la copie hors site échoue (`ÉCHEC … rclone`) : recréer la clé B2 avec **Type of Access : Read and Write** et refaire les
trois blocs `read -rs B2_ID` / `read -rs B2_KEY` / `printf …` de l'étape 6, puis relancer la sauvegarde.

## 13. auditd

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo install -o root -g root -m 0640 ~/dp-prod/production/audit-50-delaipay.rules /etc/audit/rules.d/50-delaipay.rules
sudo augenrules --check; sudo augenrules --load >/dev/null
sudo auditctl -l | grep -c delaipay_prod                                                        # → 12
ls /srv/delaipay; sleep 1; sudo ausearch -k delaipay_prod_access -i --start recent | grep -c 'uid=khalil'   # Permission denied ; ≥ 1
```

## 14. Vérification finale

**[VPS as khalil with sudo]**
```bash
cd /tmp
sudo systemd-analyze security delaipay.service | tail -1; sudo systemd-analyze security delaipay-backup.service | tail -1   # 0.9 SAFE · 1.1 OK
P=$(systemctl show -p MainPID --value delaipay); sudo grep -E '^(NoNewPrivs|CapEff|Seccomp):' /proc/$P/status
sudo ss -ltnp '( sport = :4300 )' | tail -n +2                                                  # 127.0.0.1:4300 seulement
for u in khalil openclaw delaipay-staging; do echo "== $u"; sudo -u $u ls /srv/delaipay; sudo -u $u cat /etc/delaipay/production.env /etc/delaipay/backup.env; done   # tout refusé
sudo -u delaipay cat /etc/delaipay/backup.env                                                   # refusé
curl -s -o /dev/null -w 'ancienne production :3200 → %{http_code}\n' http://127.0.0.1:3200/; curl -s https://admin.staging.delaipay.com/healthz; echo
```
**[LAPTOP]**
```bash
curl -s https://admin.delaipay.com/healthz; echo
curl -sI http://admin.delaipay.com/ | head -1; curl -sI https://admin.delaipay.com/ | grep -i strict-transport
open https://admin.delaipay.com/                     # connexion + enrôlement 2FA ; codes de secours → gestionnaire de mots de passe
```

## 15. Test de restauration (obligatoire avant les données réelles)
1. https://secure.backblaze.com/b2_browse_files2.htm › `<B2_BUCKET>` › télécharger `delaipay-….tar.gz.age` **et** son `.sha256` dans `~/Downloads`.

**[LAPTOP]**
```bash
cd ~/repos/delaipay/app && F=$(ls -t ~/Downloads/delaipay-*.tar.gz.age | head -1); echo "$F"
node src/ops/restore.js --from "$F" --to ~/delaipay-restore-test-$(date +%Y%m%d%H%M) --identity ~/delaipay-prod-backup.key     # « Restauration réussie »
```

## 16. Premier client
Console `https://admin.delaipay.com` › **Espaces** › créer l'espace (slug = sous-domaine, ex. `cabinet-alami` → `https://cabinet-alami.delaipay.com`,
nom, e-mail de l'administrateur du cabinet, formule, limites) › **copier le lien d'invitation** affiché › l'envoyer au client.
Le client ouvre le lien, choisit son mot de passe, puis invite ses collaborateurs depuis son espace.
Slugs refusés : `admin`, `www`, `api`, `app`, `staging`, `prod`, `test`, `demo`, `mail`… (infrastructure).

## 17. Retour arrière

**[VPS as khalil with sudo]**
```bash
cd /tmp
# déploiement : deploy.sh revient seul à la version précédente en cas d'échec ; sinon :  sudo -u delaipay -H /srv/delaipay/deploy.sh <ETIQUETTE_PRECEDENTE>
# nginx (uniquement le fichier de production)
sudo rm -f /etc/nginx/sites-enabled/delaipay.conf /etc/nginx/sites-available/delaipay.conf && sudo nginx -t && sudo systemctl reload nginx
# certificat
sudo certbot delete -n --cert-name delaipay.com
# service, sudoers, lanceur, audit
sudo systemctl disable --now delaipay.service delaipay-backup.timer
sudo rm -f /etc/systemd/system/delaipay.service /etc/systemd/system/delaipay-backup.service /etc/systemd/system/delaipay-backup.timer /etc/sudoers.d/delaipay /usr/local/sbin/delaipay-run /etc/logrotate.d/delaipay /etc/audit/rules.d/50-delaipay.rules
sudo systemctl daemon-reload && sudo visudo -c >/dev/null && sudo augenrules --load >/dev/null
# secrets, données, utilisateur — UNIQUEMENT si aucune donnée client n'y a été saisie
sudo rm -r /etc/delaipay /srv/delaipay && sudo userdel delaipay
```
**[LAPTOP]** — DNS : supprimer les 2 enregistrements `*.delaipay.com` dans Cloudflare ; GitHub : supprimer la clé `delaipay-prod (read-only)`.
