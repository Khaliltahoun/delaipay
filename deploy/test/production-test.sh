#!/usr/bin/env bash
# =====================================================================================================
# Répétition LOCALE de la PRODUCTION (deploy/production/, docs/DEPLOY_PROD.md) — aucun accès au VPS.
# Conteneur Debian trixie + systemd (PID 1) : utilisateur delaipay, /srv/delaipay 0700, secrets root 0600,
# unités durcies, sudoers unique, VRAI deploy.sh (miroir git superficiel, 320 tests, santé), seed fictif REFUSÉ,
# admin plateforme par delaipay-run, sauvegarde age + copie hors site rclone (distant « local » à la place de B2),
# refus pour khalil / openclaw, sonde avec le bac à sable exact du service.
# Usage : deploy/test/production-test.sh      (Docker ; réseau pour Debian, Node.js, npm)
# =====================================================================================================
set -Eeuo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-${TMPDIR:-/tmp}/dp-production}"
IMG=delaipay-production-test:trixie
NAME=dp-production
rm -rf "$WORK"; mkdir -p "$WORK/ctx"
cat > "$WORK/ctx/Dockerfile" <<'EOF'
FROM debian:trixie-slim
# Image de TEST jetable : dépôt de sécurité ignoré si l'horloge locale retarde (signature « pas encore valide »).
RUN F=/etc/apt/sources.list.d/debian.sources; awk -v RS= -v ORS='\n\n' '!/debian-security/' $F > $F.new && mv $F.new $F; apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      systemd systemd-sysv dbus sudo gnupg curl ca-certificates xz-utils procps iproute2 openssh-server git age rclone >/dev/null && rm -rf /var/lib/apt/lists/*
RUN set -e; A="$(dpkg --print-architecture)"; [ "$A" = amd64 ] && A=x64; \
    F="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk -v a="linux-$A.tar.xz" '$2 ~ a {print $2}')"; \
    mkdir -p /opt/node-24; curl -fsSL "https://nodejs.org/dist/latest-v24.x/$F" | tar -xJ -C /opt/node-24 --strip-components=1 --no-same-owner
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
EOF
docker build -q -t "$IMG" "$WORK/ctx" >/dev/null
( cd "$REPO" && git ls-files -co --exclude-standard app deploy | tar -cf "$WORK/src.tar" -T - )
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec "$IMG" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do docker exec "$NAME" systemctl is-system-running 2>/dev/null | grep -Eq 'running|degraded' && break; sleep 1; done
docker cp "$WORK/src.tar" "$NAME:/root/src.tar"

docker exec -i "$NAME" bash -s <<'INSIDE'
set -Euo pipefail
FAILS=0
ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
ko() { printf '  \033[31m✘\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
denied() { if "${@:2}" >/dev/null 2>&1; then ko "$1 — AUTORISÉ"; else ok "$1 — refusé"; fi; }
D=/srv/delaipay; P=/root/src/deploy/production
mkdir -p /root/src && tar -xf /root/src.tar -C /root/src

step "P1. Utilisateur delaipay + /srv/delaipay (0700)"
useradd --system --user-group --home-dir $D --no-create-home --shell /bin/bash delaipay && passwd -l delaipay >/dev/null
id delaipay | grep -Eq 'groups=[0-9]+\(delaipay\)$' && ok "aucun groupe supplémentaire" || ko "groupes : $(id delaipay)"
install -d -o delaipay -g delaipay -m 0700 $D
for d in releases shared shared/data shared/uploads backups pre-deploy .ssh .gnupg; do install -d -o delaipay -g delaipay -m 0700 "$D/$d"; done
install -o delaipay -g delaipay -m 0700 /root/src/deploy/deploy.sh $D/deploy.sh

step "P2. Dépôt git de test (joue GitHub) + deploy.conf"
install -d -m 0755 /srv/git && git init -q --bare /srv/git/delaipay.git
( export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t; cd /root/src && git init -q -b feature/saas-productization && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm prod && git tag -a prod-1 -m prod-1 && git push -q /srv/git/delaipay.git feature/saas-productization prod-1 )
chown -R delaipay:delaipay /srv/git   # le dépôt de test appartient au lecteur (git refuse un dépôt d'un autre propriétaire)
sed -e 's|^REPO_URL=.*|REPO_URL=file:///srv/git/delaipay.git|' $P/deploy.conf.example > $D/deploy.conf; chown delaipay: $D/deploy.conf; chmod 600 $D/deploy.conf
ok "deploy.conf : $(grep -E '^(SERVICE|HEALTH_URL|GIT_BRANCH)=' $D/deploy.conf | tr '\n' ' ')"

step "P3. Secrets production.env + backup.env (root:root 0600)"
install -d -o root -g root -m 0700 /etc/delaipay
age-keygen -o /root/age.key 2>/dev/null; AGE_PUB="$(age-keygen -y /root/age.key)"
sed -e "s|^JWT_SECRET=.*|JWT_SECRET=$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')|" \
    -e "s|^PLATFORM_SECRET_KEY=.*|PLATFORM_SECRET_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')|" \
    -e "s|^BACKUP_AGE_RECIPIENT=.*|BACKUP_AGE_RECIPIENT=$AGE_PUB|" \
    -e "s|b2offsite:BUCKET/|b2offsite:$D/backups/hors-site/|g" \
    $P/production.env.example > /etc/delaipay/production.env
grep -vE '^RCLONE_CONFIG_B2OFFSITE_(ACCOUNT|KEY)=' $P/backup.env.example | sed 's|^RCLONE_CONFIG_B2OFFSITE_TYPE=b2|RCLONE_CONFIG_B2OFFSITE_TYPE=local|' > /etc/delaipay/backup.env
chmod 600 /etc/delaipay/*.env
grep -q '^DELAIPAY_ENV=production$' /etc/delaipay/production.env && grep -q '^PORT=4300$' /etc/delaipay/production.env && grep -q '^TENANT_BASE_DOMAINS=delaipay.com$' /etc/delaipay/production.env \
  && ok "production.env : DELAIPAY_ENV=production, PORT=4300, TENANT_BASE_DOMAINS=delaipay.com" || ko "production.env"

step "P4. Unités, sudoers, lanceur, sshd"
install -m 0644 $P/delaipay.service $P/delaipay-backup.service $P/delaipay-backup.timer /etc/systemd/system/
install -o root -g root -m 0440 $P/sudoers-delaipay /etc/sudoers.d/delaipay; visudo -cf /etc/sudoers.d/delaipay >/dev/null && ok "visudo" || ko "visudo"
install -o root -g root -m 0755 $P/delaipay-run /usr/local/sbin/delaipay-run
install -m 0644 $P/sshd-50-delaipay.conf /etc/ssh/sshd_config.d/50-delaipay.conf; sshd -t && ok "sshd -t" || ko "sshd -t"
T="$(sshd -T -C user=delaipay,host=x,addr=203.0.113.9 2>/dev/null)"; grep -qx 'allowtcpforwarding no' <<<"$T" && ok "sshd : delaipay sans tunnel" || ko "sshd delaipay"
systemctl daemon-reload && systemctl enable delaipay.service delaipay-backup.timer >/dev/null 2>&1
S="$(sudo -u delaipay sudo -n -l 2>/dev/null | grep NOPASSWD)"; grep -q 'systemctl restart delaipay.service$' <<<"$S" && ok "sudoers : $S" || ko "sudoers : $S"

step "P5. VRAI deploy.sh (miroir superficiel, npm ci, 320 tests, migrations, redémarrage sudo, santé)"
OUT="$(cd /tmp && sudo -u delaipay -H $D/deploy.sh prod-1 2>&1)"; RC=$?
grep -E 'Tests :|Santé OK|ÉCHEC' <<<"$OUT" | sed 's/^/     /'
[ $RC = 0 ] && grep -q 'Santé OK' <<<"$OUT" && ok "déploiement réussi" || { ko "déploiement (code $RC)"; tail -15 <<<"$OUT"; }
[ "$(git --git-dir=$D/repo.git branch | tr -d ' *')" = feature/saas-productization ] && ok "miroir : une seule branche" || ko "miroir"
H="$(curl -fsS http://127.0.0.1:4300/healthz 2>/dev/null || true)"; grep -q '"db":"ok"' <<<"$H" && ok "/healthz : $H" || ko "santé : $H"
ss -ltn | grep -q '127.0.0.1:4300' && ok "écoute 127.0.0.1:4300" || ko "écoute"
PID="$(systemctl show -p MainPID --value delaipay)"
grep -Eq '^NoNewPrivs:\s+1' /proc/$PID/status && grep -Eq '^CapEff:\s+0+$' /proc/$PID/status && grep -Eq '^Seccomp:\s+2' /proc/$PID/status && ok "NoNewPrivs 1 · aucune capacité · seccomp" || ko "durcissement du processus"

step "P6. Production : seed fictif REFUSÉ ; premier administrateur plateforme par delaipay-run"
SEED="$(delaipay-run node src/ops/staging-seed.js 2>&1 || true)"
grep -q 'DELAIPAY_ENV=staging requis' <<<"$SEED" && ok "seed fictif refusé en production" || ko "seed : $(tail -2 <<<"$SEED")"
ADM="$(delaipay-run env DP_PLATFORM_CLI_MODE=create PLATFORM_ADMIN_PASSWORD='Test-Production-Admin-1' node src/platform/cli.js --email ops@delaipay.test --nom 'Ops Test' 2>&1 || true)"
grep -q 'Administrateur plateforme créé : ops@delaipay.test' <<<"$ADM" && ok "admin plateforme créé (2FA exigée à la première connexion)" || ko "admin : $(tail -3 <<<"$ADM")"
L="$(delaipay-run node src/platform/cli.js list 2>&1 || true)"; grep -q 'ops@delaipay.test' <<<"$L" && ok "cli list : $(grep ops@ <<<"$L" | tr -s ' ')" || ko "cli list"
[ ! -e $D/shared/data/.secret ] && [ ! -e $D/shared/data/.platform-key ] && ok "aucun secret écrit sur disque" || ko "secret sur disque"

step "P7. Sauvegarde age + copie hors site rclone (même bac à sable ; identifiants dans backup.env seul)"
systemctl start delaipay-backup.service || true
J="$(journalctl -u delaipay-backup --no-pager -o cat | tail -3)"
F="$(ls $D/backups/delaipay-*.tar.gz.age 2>/dev/null | head -1)"
[ -n "$F" ] && ok "sauvegarde : $(basename "$F")" || { ko "sauvegarde absente"; echo "$J"; }
[ -n "$F" ] && [ -f "$D/backups/hors-site/$(basename "$F")" ] && [ -f "$D/backups/hors-site/$(basename "$F").sha256" ] && ok "copie hors site (rclone) : archive + .sha256" || { ko "copie hors site"; echo "$J"; }
LST="$( [ -n "$F" ] && age -d -i /root/age.key "$F" 2>/dev/null | tar -tz 2>/dev/null)"; grep -q 'delaipay.db' <<<"$LST" && ok "déchiffrable par la clé privée hors ligne" || ko "déchiffrement"
grep -q 'hors site : ok\|hors site : oui\|hors site' <<<"$J" && ok "journal : $(grep -o 'hors site[^.]*' <<<"$J" | head -1)" || true
denied "l'application ne voit pas backup.env (clé B2)" bash -c "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value delaipay)/environ | grep -q RCLONE_CONFIG"

step "P8. Autres comptes"
useradd -m khalil; useradd -m openclaw
for u in khalil openclaw delaipay; do
  [ $u != delaipay ] && denied "$u : lister /srv/delaipay" sudo -u $u ls $D
  [ $u != delaipay ] && denied "$u : lire la base" sudo -u $u cat $D/shared/data/delaipay.db
  denied "$u : lire production.env" sudo -u $u cat /etc/delaipay/production.env
  denied "$u : lire backup.env (clé B2)" sudo -u $u cat /etc/delaipay/backup.env
done
denied "delaipay : sudo delaipay-run" sudo -u delaipay sudo -n /usr/local/sbin/delaipay-run true
denied "delaipay : sudo systemctl stop delaipay.service" sudo -u delaipay sudo -n /usr/bin/systemctl stop delaipay.service

step "P9. Sonde avec le bac à sable exact de delaipay.service"
sed -e 's|^Type=simple|Type=oneshot|' -e 's|^ExecStart=.*|ExecStart=/bin/bash /srv/delaipay/shared/probe.sh|' -e '/^Restart=/d' -e '/^\[Install\]/,$d' \
  /etc/systemd/system/delaipay.service > /etc/systemd/system/dp-probe.service
cat > $D/shared/probe.sh <<'EOF'
t() { if eval "$2" >/dev/null 2>&1; then echo "OUVERT  $1"; else echo "fermé   $1"; fi; }
t "/home visible" "ls /home/khalil"; t "écrire dans current/" "touch /srv/delaipay/current/app/x"; t "écrire dans /etc" "touch /etc/x"
t "lire .ssh" "ls /srv/delaipay/.ssh"; t "lire backups/" "ls /srv/delaipay/backups"; t "lire production.env" "cat /etc/delaipay/production.env"
t "lire backup.env" "cat /etc/delaipay/backup.env"; t "réseau sortant" "timeout 3 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443'"; t "PID 1" "cat /proc/1/cmdline"
t "écrire dans shared/data" "touch /srv/delaipay/shared/data/.p && rm /srv/delaipay/shared/data/.p"
EOF
chown delaipay: $D/shared/probe.sh; systemctl daemon-reload; systemctl start dp-probe.service
while IFS= read -r l; do case "$l" in *"shared/data"*) [[ "$l" == OUVERT* ]] && ok "service : $l (seul inscriptible)" || ko "$l";; OUVERT*) ko "service : $l";; *) ok "service : $l";; esac
done <<<"$(journalctl -u dp-probe --no-pager -o cat | grep -E '^(OUVERT|fermé)' || echo 'OUVERT  (sonde sans sortie)')"
rm -f /etc/systemd/system/dp-probe.service $D/shared/probe.sh; systemctl daemon-reload

step "P10. systemd-analyze security"
for u in delaipay.service delaipay-backup.service; do ok "$u : $(systemd-analyze security $u 2>/dev/null | grep 'Overall exposure' | sed 's/.*: //')"; done

printf '\n%s\n' "$([ "$FAILS" = 0 ] && echo 'RÉPÉTITION PRODUCTION : AUCUN ÉCHEC' || echo "RÉPÉTITION PRODUCTION : $FAILS ÉCHEC(S)")"
exit "$FAILS"
INSIDE
